<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Aim,
  ArrowLeft,
  ArrowRight,
  Box,
  Brush,
  Camera,
  Check,
  Delete,
  Download,
  EditPen,
  Expand,
  Fold,
  FolderOpened,
  FullScreen,
  Grid,
  Hide,
  Lock,
  RefreshLeft,
  RefreshRight,
  Search,
  Share,
  Unlock,
  VideoPause,
  VideoPlay,
  View
} from '@element-plus/icons-vue'
import type { ModelAsset, ModelPartGroup } from '@shared/types'
import { MODEL_SOURCE_META } from '@shared/constants'
import { useModelStore } from '@renderer/stores/models'
import { useAppStore } from '@renderer/stores/app'
import { formatBytes, formatDateTime } from '@renderer/utils/format'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import PanelSection from '@renderer/components/PanelSection.vue'
import type { ClipEditState, QuickPoseAction, SemanticSummary, ViewerStructure } from '@renderer/components/model-viewer-types'
import { ACTION_LIBRARY } from '@renderer/rig/actions'
import type { ActionKind } from '@renderer/rig/types'
import type { ModelAction } from '@shared/types'

/**
 * 实验台（游戏 3D 角色调整）。
 *
 * 布局左右夹中间：
 *   左：结构面板（部件 / 骨架 两个 Tab，同一个滚动区 + 搜索）
 *   中：视口 + 顶部显示工具条 + 底部时间轴
 *   右：动作列表 + 选中信息 + 显示设置
 * 角色调整时「结构」和「视口」要同时看，所以结构常驻左侧；「动作」需要连续拖动，
 * 时间轴贴视口底部，播放参数放右栏。
 */

type Tab = 'parts' | 'bones'

const route = useRoute()
const router = useRouter()
const store = useModelStore()
const appStore = useAppStore()

const model = ref<ModelAsset | null>(null)
const bytes = ref<Uint8Array | null>(null)
const loading = ref(false)
const errorText = ref('')
const viewer = ref<InstanceType<typeof ModelViewer> | null>(null)

const structure = ref<ViewerStructure | null>(null)
const semantics = ref<SemanticSummary | null>(null)
const stats = computed(() => structure.value?.stats ?? null)

/** 动作库：同一个 kind 在库里可能出现多次，按 kind 去重展示 */
const libraryDefs = computed(() => {
  const seen = new Set<string>()
  return ACTION_LIBRARY.filter((item) => {
    if (seen.has(item.kind)) return false
    seen.add(item.kind)
    return true
  })
})
const libraryKind = ref<ActionKind | ''>('')

/** 角色标签形如「左大腿 Thigh.L」，列表里只留中文部分 */
function shortRole(label: string): string {
  const match = /^[\u4e00-\u9fa5·]+/.exec(label)
  return match ? match[0] : label
}

const tab = ref<Tab>('parts')
const search = ref('')
const selectedId = ref('')
const selectedKind = ref<'part' | 'bone' | ''>('')

const clipIndex = ref(-1)
const playing = ref(false)
const clipTime = ref(0)
const clipDuration = ref(0)
const speed = ref(1)

/* ------------------------------ 动作精修状态 ------------------------------ */
const editState = ref<ClipEditState | null>(null)
const editing = computed(() => Boolean(editState.value?.editing))
const savingAction = ref(false)
const actions = computed(() => model.value?.actions ?? [])
const modelId = computed(() => String(route.params.id ?? ''))

function handleEditState(state: ClipEditState): void {
  editState.value = state
  if (state.editing) {
    playing.value = state.playing
    clipTime.value = state.time
    clipDuration.value = state.duration
  }
}

/* ------------------------------ 撤销 / 重做 ------------------------------ */
const historyState = ref({ undo: 0, redo: 0 })

function handleHistoryState(state: { undo: number; redo: number }): void {
  historyState.value = state
}

function undoEdit(): void {
  quickAction.value = ''
  const result = viewer.value?.undo()
  if (!result?.ok) {
    ElMessage.info('没有可撤销的操作')
    return
  }
  ElMessage.success(`已撤销：${result.label ?? ''}`)
}

function redoEdit(): void {
  quickAction.value = ''
  const result = viewer.value?.redo()
  if (!result?.ok) {
    ElMessage.info('没有可恢复的操作')
    return
  }
  ElMessage.success(`已恢复：${result.label ?? ''}`)
}

/* ------------------------------ 检查器分区折叠 ------------------------------ */
const SECTION_KEYS = ['inspect', 'bone-edit', 'quick-pose', 'clip-edit', 'clips', 'bound', 'library', 'groups']
const layoutVersion = ref(0)

/** 一键展开/收起所有分区：改 localStorage 后重建各分区让它们重新读初始值 */
function setAllSections(open: boolean): void {
  for (const key of SECTION_KEYS) {
    localStorage.setItem('lab:section:' + key, open ? '1' : '0')
  }
  layoutVersion.value += 1
}

/* ------------------------------ 检查器面板（停靠 / 浮动） ------------------------------ */
const inspectorTab = ref<'props' | 'actions' | 'groups'>('props')
const inspectorVisible = ref(true)
const inspectorFloating = ref(false)
const floatPos = reactive({ x: 0, y: 0 })
let panelDrag: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null

function toggleFloating(): void {
  if (!inspectorFloating.value) {
    const lab = document.querySelector('.lab') as HTMLElement | null
    const width = lab?.getBoundingClientRect().width ?? 900
    floatPos.x = Math.max(12, width - 320)
    floatPos.y = 12
  }
  inspectorFloating.value = !inspectorFloating.value
}

function startPanelDrag(event: PointerEvent): void {
  if (!inspectorFloating.value) return
  // 点在按钮/页签上时不启动拖动：
  // 一旦 setPointerCapture 到标题栏，click 会被捕获到标题栏，按钮就收不到点击事件
  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, .el-button, .inspector-head__actions, .inspector-tabs')) return
  panelDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: floatPos.x,
    originY: floatPos.y
  }
  // 捕获指针，拖出面板头部也能继续跟手
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}

function onPanelDrag(event: PointerEvent): void {
  if (!panelDrag || event.pointerId !== panelDrag.pointerId) return
  floatPos.x = Math.max(0, panelDrag.originX + (event.clientX - panelDrag.startX))
  floatPos.y = Math.max(0, panelDrag.originY + (event.clientY - panelDrag.startY))
}

function endPanelDrag(event: PointerEvent): void {
  if (!panelDrag) return
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
  panelDrag = null
}

function showShortcuts(): void {
  void ElMessageBox.alert(
    '<div style="line-height:2;font-size:12.5px">' +
      '<b>通用</b>　Ctrl+Z 撤销 · Ctrl+Y 恢复<br/>' +
      '<b>精修</b>　← → 逐帧 · K 记关键帧 · 空格 播放/暂停<br/>' +
      '<b>骨骼编辑</b>　视口里点骨骼节点即选中 · W 旋转 / E 移动 / R 缩放 · F 聚焦选中 · Esc 取消选中<br/>' +
      '<b>模式</b>　姿态=转骨骼看网格形变；绑定=网格冻结只挪骨骼，调完「应用为绑定姿态」<br/>' +
      '<b>视图</b>　「全屏」进入专注模式 ·「仅骨骼」冻结网格形变' +
      '</div>',
    '快捷键一览',
    { dangerouslyUseHTMLString: true, confirmButtonText: '知道了' }
  )
}

/** 菜单栏统一分发 */
function handleMenuCommand(command: string): void {
  switch (command) {
    case 'locate':
      void reveal()
      break
    case 'screenshot':
      saveScreenshot()
      break
    case 'back':
      void router.push('/models')
      break
    case 'undo':
      undoEdit()
      break
    case 'redo':
      redoEdit()
      break
    case 'deselect':
      deselectAll()
      break
    case 'reset-bone':
      resetSelectedBone()
      break
    case 'reset-pose':
      resetAllPose()
      break
    case 'save-action':
      void saveEdit()
      break
    case 'cancel-edit':
      void cancelEdit()
      break
    case 'fullscreen':
      void appStore.toggleFocusMode()
      break
    case 'freeze-mesh':
      toggleFreezeMesh()
      break
    case 'wireframe':
      display.wireframe = !display.wireframe
      break
    case 'grid':
      display.showGrid = !display.showGrid
      break
    case 'skeleton':
      display.showSkeleton = !display.showSkeleton
      break
    case 'autorotate':
      display.autoRotate = !display.autoRotate
      break
    case 'reset-view':
      viewer.value?.resetView()
      break
    case 'play':
      togglePlay()
      break
    case 'frame-prev':
      stepFrame(-1)
      break
    case 'frame-next':
      stepFrame(1)
      break
    case 'record-key':
      recordKey()
      break
    case 'record-all':
      recordAll()
      break
    case 'delete-key':
      removeKey()
      break
    case 'edit-clip':
      if (editing.value) {
        ElMessage.info('已经在精修模式里了')
      } else if (libraryKind.value) {
        startEditLibrary()
      } else if (clipIndex.value >= 0) {
        startEditNative(clipIndex.value)
      } else {
        ElMessage.warning('先选一段动作（自带片段 / 动作库 / 已绑定动作）')
      }
      break
    case 'panel-props':
      inspectorTab.value = 'props'
      inspectorVisible.value = true
      break
    case 'panel-actions':
      inspectorTab.value = 'actions'
      inspectorVisible.value = true
      break
    case 'panel-groups':
      inspectorTab.value = 'groups'
      inspectorVisible.value = true
      break
    case 'panel-toggle':
      inspectorVisible.value = !inspectorVisible.value
      break
    case 'float':
      toggleFloating()
      break
    case 'expand-all':
      setAllSections(true)
      break
    case 'collapse-all':
      setAllSections(false)
      break
    case 'shortcuts':
      showShortcuts()
      break
    case 'about':
      void ElMessageBox.alert(
        '穷哥们的工具箱 · 实验台\n本地优先：模型不上传、不联网，动作数据存在 .userdata/database.json',
        '关于',
        { confirmButtonText: '知道了' }
      )
      break
  }
}

/** 关键帧条上的百分比位置 */
function keyPercent(time: number): string {
  const duration = Math.max(editState.value?.duration ?? 1, 0.001)
  return Math.min(100, Math.max(0, (time / duration) * 100)) + '%'
}

/** 快捷姿态：每次点击转 12° */
const QUICK_POSES: Array<{ action: QuickPoseAction; label: string }> = [
  { action: 'legs-in', label: '双腿内收' },
  { action: 'legs-out', label: '双腿外展' },
  { action: 'legs-forward', label: '双腿前摆' },
  { action: 'legs-back', label: '双腿后摆' },
  { action: 'arms-in', label: '双臂内收' },
  { action: 'arms-out', label: '双臂外展' },
  { action: 'arms-forward', label: '双臂前摆' },
  { action: 'arms-back', label: '双臂后摆' },
  { action: 'head-down', label: '低头' },
  { action: 'head-up', label: '抬头' },
  { action: 'lean-forward', label: '身体前倾' },
  { action: 'lean-back', label: '身体后仰' }
]

const quickAction = ref<QuickPoseAction | ''>('')
const quickAmount = ref(12)

const quickActionLabel = computed(() => {
  if (!quickAction.value) return ''
  return QUICK_POSES.find((item) => item.action === quickAction.value)?.label ?? quickAction.value
})

/** 点快捷姿态按钮：选中该动作并默认 12°，下方出现滑杆 */
function applyQuickPose(action: QuickPoseAction): void {
  if (action === 'reset') {
    viewer.value?.endQuickPose()
    quickAction.value = ''
    const result = viewer.value?.beginQuickPose('reset')
    if (!result?.ok) ElMessage.warning(result?.message ?? '重置失败')
    return
  }
  quickAmount.value = 12
  const result = viewer.value?.setQuickPoseAmount(action, quickAmount.value)
  if (!result?.ok) {
    quickAction.value = ''
    ElMessage.warning(result?.message ?? '该动作不可用')
    return
  }
  quickAction.value = action
}

/** 拖滑杆：实时按角度重新施加 */
function handleQuickAmount(value: number | number[]): void {
  const amount = Array.isArray(value) ? value[0] : value
  quickAmount.value = amount
  if (!quickAction.value) return
  const result = viewer.value?.setQuickPoseAmount(quickAction.value, amount)
  if (!result?.ok) ElMessage.warning(result?.message ?? '调整失败')
}

function finishQuickPose(): void {
  viewer.value?.endQuickPose()
  quickAction.value = ''
}

/** 精修模式下当前帧 / 总帧 */
const editFrame = computed(() => {
  const fps = editState.value?.fps ?? 30
  return {
    current: Math.round((editState.value?.time ?? 0) * fps),
    total: Math.round((editState.value?.duration ?? 0) * fps),
    fps
  }
})

const display = reactive({
  autoRotate: true,
  showGrid: true,
  wireframe: false,
  showSkeleton: true,
  freezeMesh: false,
  background: '#0b1220',
  exposure: 1
})


const hiddenParts = reactive(new Set<string>())
const presetColors = ['#0b1220', '#141a24', '#1e293b', '#0f172a', '#f4f6fb', '#2b2140']

/* 选中高亮的外观：颜色 + 亮度，存 localStorage，下次打开还在 */
const HL_PRESETS = ['#ffb74d', '#4f46e5', '#10b981', '#ef4444', '#22d3ee', '#ffffff']

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const num = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(num) ? num : fallback
}

const highlight = reactive({
  color: localStorage.getItem('lab:highlight-color') || '#ffb74d',
  intensity: readNumber('lab:highlight-intensity', 0.45)
})

watch(
  () => [highlight.color, highlight.intensity] as const,
  ([color, intensity]) => {
    localStorage.setItem('lab:highlight-color', color)
    localStorage.setItem('lab:highlight-intensity', String(intensity))
  }
)

/** 多选：Ctrl/⌘ 点选、Shift 连选，用于保存成分组导出 */
const selectedKeys = ref<string[]>([])
let lastClickedIndex = -1
const savingGroup = ref(false)
const exportingGroupId = ref('')

const groups = computed(() => model.value?.groups ?? [])

const meta = computed(() => (model.value ? MODEL_SOURCE_META[model.value.source] : null))
const PART_TYPE_LABEL: Record<string, string> = {
  skinned: '蒙皮网格',
  mesh: '网格',
  lines: '线条',
  points: '点云'
}
const clips = computed(() => structure.value?.clips ?? [])
const hasPlayable = computed(() => clips.value.length > 0 || Boolean(libraryKind.value))

function match(name: string): boolean {
  const keyword = search.value.trim().toLowerCase()
  return !keyword || name.toLowerCase().includes(keyword)
}

/* -------------------------------- 部件备注 -------------------------------- */
const partNotes = computed(() => model.value?.partNotes ?? {})
const editingNoteKey = ref('')
const noteDraft = ref('')

/** 列表主标题：有备注就用备注，否则用部件类型 */
function partLabel(part: { type: string; key: string }): string {
  const note = partNotes.value[part.key]
  return note || PART_TYPE_LABEL[part.type] || part.type
}

function isNoteEditing(part: { key: string }): boolean {
  return editingNoteKey.value === part.key
}

function startEditNote(part: { key: string }): void {
  editingNoteKey.value = part.key
  noteDraft.value = partNotes.value[part.key] ?? ''
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.part-row__note-input input')
    input?.focus()
    input?.select()
  })
}

function cancelEditNote(): void {
  editingNoteKey.value = ''
  noteDraft.value = ''
}

async function savePartNote(part: { key: string }): Promise<void> {
  if (editingNoteKey.value !== part.key) return
  const text = noteDraft.value.trim()
  editingNoteKey.value = ''
  noteDraft.value = ''
  if ((partNotes.value[part.key] ?? '') === text) return
  try {
    const notes = await window.api.model.setPartNote(modelId.value, part.key, text)
    if (model.value) model.value = { ...model.value, partNotes: notes }
    if (text) ElMessage.success(`备注已保存：${text}`)
    else ElMessage.success('备注已清除')
  } catch (error) {
    ElMessage.error(`保存备注失败：${(error as Error).message}`)
  }
}

const parts = computed(() =>
  (structure.value?.parts ?? []).filter(
    (item) => match(item.name) || match(partNotes.value[item.key] ?? '')
  )
)
const bones = computed(() => (structure.value?.bones ?? []).filter((item) => match(item.name)))
const visibleCount = computed(() => (structure.value?.parts ?? []).filter((p) => !hiddenParts.has(p.id)).length)

const selectedPart = computed(() =>
  selectedKind.value === 'part'
    ? (structure.value?.parts.find((item) => item.id === selectedId.value) ?? null)
    : null
)
const selectedBone = computed(() =>
  selectedKind.value === 'bone'
    ? (structure.value?.bones.find((item) => item.id === selectedId.value) ?? null)
    : null
)

/* -------------------------- 骨骼编辑（gizmo + 数值） -------------------------- */
const gizmoMode = ref<'rotate' | 'translate' | 'scale' | 'off'>('rotate')
/** 编辑模式：姿态（转骨骼看形变）/ 绑定（挪骨骼定绑定，网格冻结不形变） */
const editMode = ref<'pose' | 'bind'>('pose')

function setEditMode(mode: 'pose' | 'bind'): void {
  editMode.value = mode
  if (mode === 'bind') {
    // 绑定：网格冻结，只看骨架，挪完再「应用为绑定姿态」
    display.freezeMesh = true
    gizmoMode.value = 'translate'
  } else {
    // 姿态：网格必须跟着骨骼变形
    display.freezeMesh = false
    if (gizmoMode.value === 'off') gizmoMode.value = 'rotate'
  }
}

/** 「仅骨骼」开关与编辑模式保持一致：开会切到绑定，关会切回姿态 */
function toggleFreezeMesh(): void {
  const next = !display.freezeMesh
  display.freezeMesh = next
  editMode.value = next ? 'bind' : 'pose'
  if (next) gizmoMode.value = 'translate'
  else if (gizmoMode.value === 'off') gizmoMode.value = 'rotate'
}

function applyBindPoseAction(): void {
  void ElMessageBox.confirm(
    '把当前骨骼位置设为新的绑定姿态？之后的姿势都会从这个新基准开始变形（可 Ctrl+Z 撤回）。',
    '应用为绑定姿态',
    { type: 'warning', confirmButtonText: '应用', cancelButtonText: '取消' }
  )
    .then(() => {
      const result = viewer.value?.applyBindPose()
      if (!result?.ok) {
        ElMessage.warning(result?.message ?? '应用失败')
        return
      }
      ElMessage.success('绑定姿态已更新')
    })
    .catch(() => undefined)
}

/** 视口里点中骨骼/部件 */
function handleViewportSelectBone(id: string): void {
  if (!structure.value?.bones.some((bone) => bone.id === id)) return
  tab.value = 'bones'
  selectBone(id)
}

function handleViewportSelectPart(id: string): void {
  if (!structure.value?.parts.some((part) => part.id === id)) return
  tab.value = 'parts'
  selectPart(id)
}
const boneTransform = ref<{
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
} | null>(null)

const selectedBoneId = computed(() => (selectedKind.value === 'bone' ? selectedId.value : ''))

function handleBoneTransform(payload: {
  id: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
}): void {
  if (payload.id !== selectedId.value) return
  boneTransform.value = { position: payload.position, rotation: payload.rotation }
}

const POSITION_AXES = ['x', 'y', 'z'] as const

/** 数值框只负责展示；用户改完（回车/失焦）才写回骨骼 */
function fmtVec(
  vec: { x: number; y: number; z: number } | undefined,
  axis: 'x' | 'y' | 'z',
  digits: number
): string {
  const value = vec ? vec[axis] : 0
  return (Number.isFinite(value) ? value : 0).toFixed(digits)
}

function commitOnEnter(event: KeyboardEvent): void {
  ;(event.target as HTMLInputElement | null)?.blur()
}

function onPositionChange(axis: 'x' | 'y' | 'z', value: string): void {
  const num = Number(value)
  if (!selectedBoneId.value || !Number.isFinite(num)) return
  viewer.value?.setBoneTransform(selectedBoneId.value, { position: { [axis]: num } })
}

function onRotationChange(axis: 'x' | 'y' | 'z', value: string): void {
  const num = Number(value)
  if (!selectedBoneId.value || !Number.isFinite(num)) return
  viewer.value?.setBoneTransform(selectedBoneId.value, { rotation: { [axis]: num } })
}

function resetSelectedBone(): void {
  if (!selectedBoneId.value) return
  viewer.value?.resetBone(selectedBoneId.value)
  ElMessage.success('该骨骼已复位')
}

function resetAllPose(): void {
  viewer.value?.resetPose()
  ElMessage.success('已复位全部骨骼')
}

onMounted(async () => {
  const id = String(route.params.id ?? '')
  loading.value = true
  try {
    const list = await window.api.model.list()
    model.value = list.find((item) => item.id === id) ?? null
    if (!model.value) {
      errorText.value = '模型不存在或已被移除'
      return
    }
    bytes.value = await store.readBytes(id)
  } catch (error) {
    errorText.value = (error as Error).message
  } finally {
    loading.value = false
  }
})

// 精修快捷键：← / → 逐帧，K 记帧，空格播放暂停
function onEditKey(event: KeyboardEvent): void {
  const tag = (event.target as HTMLElement | null)?.tagName ?? ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target as HTMLElement | null)?.isContentEditable) return

  // Esc 取消选中（有弹窗先交给弹窗）
  if (event.key === 'Escape') {
    const dialogOpen = Boolean(document.querySelector('.el-overlay, .el-message-box, .el-dialog'))
    if (!dialogOpen && (selectedId.value || selectedKeys.value.length > 0)) {
      event.preventDefault()
      deselectAll()
    }
    return
  }

  // Ctrl/⌘ + Z 撤销，Ctrl/⌘ + Y 或 Shift+Ctrl/⌘+Z 恢复
  const mod = event.ctrlKey || event.metaKey
  if (mod && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault()
    if (event.shiftKey) redoEdit()
    else undoEdit()
    return
  }
  if (mod && (event.key === 'y' || event.key === 'Y')) {
    event.preventDefault()
    redoEdit()
    return
  }

  // 工具快捷：W 旋转 / E 移动 / R 缩放 / F 聚焦
  if (!mod && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'w' || key === 'e' || key === 'r') {
      event.preventDefault()
      gizmoMode.value = key === 'w' ? 'rotate' : key === 'e' ? 'translate' : 'scale'
      return
    }
    if (key === 'f' && selectedId.value) {
      event.preventDefault()
      focusSelected()
      return
    }
  }

  if (!editing.value) return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    stepFrame(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    stepFrame(1)
  } else if (event.key === 'k' || event.key === 'K') {
    event.preventDefault()
    recordKey()
  } else if (event.key === ' ') {
    event.preventDefault()
    togglePlay()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onEditKey)
})

// 离开实验台时自动退出全屏/沉浸，避免侧栏被藏起来后没地方点回来
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEditKey)
  if (appStore.immersive || appStore.fullscreen) void appStore.exitFocusMode()
})

function handleParsed(next: ViewerStructure): void {
  structure.value = next
  errorText.value = ''
  // 有动作就默认加载第一个片段，方便直接拖动时间轴
  if (next.clips.length > 0) {
    clipIndex.value = 0
    playClip(0)
  }
}

function handleSemantics(summary: SemanticSummary): void {
  semantics.value = summary
}

/** 用内置动作库现场生成一段动作（模型自带 0 段动画时也能看） */
function playLibrary(kind: ActionKind): void {
  const result = viewer.value?.generateActionClip(kind)
  if (!result?.ok) {
    ElMessage.warning(result?.message ?? '生成动作失败')
    return
  }
  libraryKind.value = kind
  clipIndex.value = -1
  ElMessage.success(`已生成动作：${result.name ?? kind}`)
}

/* ------------------------------ 精修入口与操作 ------------------------------ */

function enterEdit(result: { ok: boolean; message?: string } | undefined, label: string): void {
  if (!result?.ok) {
    ElMessage.warning(result?.message ?? '无法精修这段动作')
    return
  }
  libraryKind.value = ''
  clipIndex.value = -1
  playing.value = false
  ElMessage.success(`进入精修：${label}`)
}

/** 精修模型自带动画 */
function startEditNative(index: number): void {
  const name = structure.value?.clips[index]?.name ?? `动作 ${index + 1}`
  enterEdit(viewer.value?.beginEdit({ clipIndex: index, origin: 'native', name }), name)
}

/** 精修当前从动作库生成的动作 */
function startEditLibrary(): void {
  if (!libraryKind.value) return
  const kind = libraryKind.value
  const label = libraryDefs.value.find((item) => item.kind === kind)?.label ?? kind
  enterEdit(viewer.value?.beginEdit({ kind, origin: 'library' }), label)
}

/** 精修已绑定到模型的动作 */
function startEditSaved(action: ModelAction): void {
  enterEdit(
    viewer.value?.beginEdit({
      name: action.name,
      origin: action.origin,
      sourceKind: action.sourceKind,
      tracks: action.tracks,
      duration: action.duration,
      loop: action.loop
    }),
    action.name
  )
}

async function saveEdit(): Promise<void> {
  const payload = viewer.value?.getEditResult()
  if (!payload) {
    ElMessage.warning('没有可保存的关键帧')
    return
  }
  savingAction.value = true
  try {
    const saved = await window.api.model.saveAction(modelId.value, payload)
    const list = await window.api.model.list()
    model.value = list.find((item) => item.id === modelId.value) ?? model.value
    viewer.value?.endEdit()
    ElMessage.success(`已绑定动作：${saved.name}（${saved.tracks.length} 根骨骼）`)
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    savingAction.value = false
  }
}

async function cancelEdit(): Promise<void> {
  try {
    await ElMessageBox.confirm('放弃本次精修？已记录的关键帧不会保存。', '放弃精修', {
      type: 'warning',
      confirmButtonText: '放弃',
      cancelButtonText: '继续编辑'
    })
  } catch {
    return
  }
  viewer.value?.endEdit()
  viewer.value?.resetPose()
}

function stepFrame(delta: number): void {
  viewer.value?.stepEditFrame(delta)
}

function recordKey(): void {
  const result = viewer.value?.recordKey()
  if (!result?.ok) ElMessage.warning(result?.message ?? '记录失败')
  else ElMessage.success('已记录关键帧')
}

function recordAll(): void {
  const result = viewer.value?.recordAllKeys()
  if (result?.ok) ElMessage.success(`已记录整帧（${result.count} 根骨骼）`)
  else ElMessage.warning('记录失败')
}

function removeKey(): void {
  const result = viewer.value?.deleteKey()
  if (!result?.ok) ElMessage.warning(result?.message ?? '删除失败')
}

function playSaved(action: ModelAction): void {
  const result = viewer.value?.playStoredAction(action)
  if (!result?.ok) {
    ElMessage.warning(result?.message ?? '播放失败')
    return
  }
  libraryKind.value = ''
  clipIndex.value = -1
  playing.value = true
  ElMessage.success(`播放：${action.name}`)
}

async function removeSaved(action: ModelAction): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除已绑定的动作「${action.name}」？`, '删除动作', {
      type: 'warning',
      confirmButtonText: '删除'
    })
  } catch {
    return
  }
  await window.api.model.removeAction(modelId.value, action.id)
  const list = await window.api.model.list()
  model.value = list.find((item) => item.id === modelId.value) ?? model.value
  ElMessage.success('已删除')
}

function handleTick(state: { time: number; duration: number; playing: boolean; index: number }): void {
  clipTime.value = state.time
  clipDuration.value = state.duration
  playing.value = state.playing
  if (state.index >= 0) clipIndex.value = state.index
}

function selectPart(id: string): void {
  selectedId.value = id
  selectedKind.value = 'part'
  viewer.value?.selectNode(id)
}

/** 单击选一个；Ctrl/⌘ 追加或取消；Shift 连选 */
function onPartClick(part: { id: string; key: string }, index: number, event: MouseEvent): void {
  const list = parts.value
  if (event.shiftKey && lastClickedIndex >= 0) {
    const start = Math.min(lastClickedIndex, index)
    const end = Math.max(lastClickedIndex, index)
    const range = list.slice(start, end + 1).map((item) => item.key)
    selectedKeys.value = [...new Set([...selectedKeys.value, ...range])]
  } else if (event.ctrlKey || event.metaKey) {
    selectedKeys.value = selectedKeys.value.includes(part.key)
      ? selectedKeys.value.filter((key) => key !== part.key)
      : [...selectedKeys.value, part.key]
  } else {
    selectedKeys.value = [part.key]
  }
  lastClickedIndex = index

  if (selectedKeys.value.length === 1) {
    selectPart(part.id)
  } else {
    selectedId.value = ''
    selectedKind.value = ''
    viewer.value?.highlightParts(selectedKeys.value)
  }
}

/** 点左侧圆形勾选：切换该部件是否进入「分组选择集」 */
function togglePartPick(
  part: { id: string; key: string },
  index: number,
  event: MouseEvent
): void {
  if (event.shiftKey && lastClickedIndex >= 0) {
    const start = Math.min(lastClickedIndex, index)
    const end = Math.max(lastClickedIndex, index)
    const range = parts.value.slice(start, end + 1).map((item) => item.key)
    selectedKeys.value = [...new Set([...selectedKeys.value, ...range])]
  } else {
    selectedKeys.value = selectedKeys.value.includes(part.key)
      ? selectedKeys.value.filter((key) => key !== part.key)
      : [...selectedKeys.value, part.key]
  }
  lastClickedIndex = index
  if (selectedKeys.value.length === 1) {
    const only = parts.value.find((item) => item.key === selectedKeys.value[0])
    if (only) selectPart(only.id)
  } else {
    selectedId.value = ''
    selectedKind.value = ''
    viewer.value?.highlightParts(selectedKeys.value)
  }
}

function selectBone(id: string): void {
  selectedId.value = id
  selectedKind.value = 'bone'
  viewer.value?.selectNode(id)
}

/** 取消选中（Esc / 编辑菜单）：清高亮、收起手柄、清空多选 */
function deselectAll(): void {
  if (!selectedId.value && selectedKeys.value.length === 0) return
  selectedId.value = ''
  selectedKind.value = ''
  selectedKeys.value = []
  boneTransform.value = null
  viewer.value?.clearSelection()
}

/** 双击或点「聚焦」才推镜头，单击只高亮，避免把整体视图拉飞 */
function focusSelected(): void {
  if (!selectedId.value) return
  viewer.value?.focusNode(selectedId.value)
}

function togglePartVisible(id: string): void {
  const hide = !hiddenParts.has(id)
  if (hide) hiddenParts.add(id)
  else hiddenParts.delete(id)
  viewer.value?.setPartVisible(id, !hide)
}

function showAllParts(): void {
  for (const part of structure.value?.parts ?? []) {
    hiddenParts.delete(part.id)
    viewer.value?.setPartVisible(part.id, true)
  }
  ElMessage.success('已显示全部部件')
}

/* -------------------------------- 部件分组 -------------------------------- */

async function reloadModel(): Promise<void> {
  if (!model.value) return
  const list = await window.api.model.list()
  model.value = list.find((item) => item.id === model.value?.id) ?? model.value
}

async function handleSaveGroup(): Promise<void> {
  if (!model.value || selectedKeys.value.length === 0) return
  let name = ''
  try {
    const result = await ElMessageBox.prompt(
      `将为选中的 ${selectedKeys.value.length} 个部件创建一个分组，导出时只包含这些部件。`,
      '保存部件分组',
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputValue: `分组 ${groups.value.length + 1}`,
        inputPattern: /\S+/,
        inputErrorMessage: '请输入分组名称'
      }
    )
    name = result.value
  } catch {
    return
  }
  savingGroup.value = true
  try {
    await window.api.model.saveGroup(model.value.id, name, [...selectedKeys.value])
    await reloadModel()
    ElMessage.success(`已保存分组「${name}」`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    savingGroup.value = false
  }
}

/** 应用分组：勾选这些部件、只显示它们，并高亮 */
function applyGroup(group: ModelPartGroup): void {
  selectedKeys.value = [...group.partKeys]
  selectedId.value = ''
  selectedKind.value = ''

  const all = structure.value?.parts ?? []
  const keep = new Set(group.partKeys)
  for (const part of all) {
    const visible = keep.has(part.key)
    if (visible) hiddenParts.delete(part.id)
    else hiddenParts.add(part.id)
    viewer.value?.setPartVisible(part.id, visible)
  }
  viewer.value?.highlightParts([...group.partKeys])
  ElMessage.success(`已应用「${group.name}」：只显示 ${group.partKeys.length} 个部件`)
}

async function exportGroup(group: ModelPartGroup): Promise<void> {
  if (!model.value || exportingGroupId.value) return
  exportingGroupId.value = group.id
  try {
    const bytes = await viewer.value?.exportParts(group.partKeys)
    if (!bytes) throw new Error('没有可导出的部件（可能部件已不在当前模型中）')
    const result = await window.api.model.exportGroup({
      modelId: model.value.id,
      name: group.name,
      bytes: new Uint8Array(bytes)
    })
    if (result.canceled) return
    if (!result.ok) {
      ElMessage.error(result.message || '导出失败')
      return
    }
    await reloadModel()
    await store.refresh()
    const kb = Math.round((result.bytes ?? 0) / 1024)
    ElMessage.success(`已导出「${group.name}」(${kb} KB)，并登记到模型库`)
  } catch (error) {
    ElMessage.error(`导出失败：${(error as Error).message}`)
  } finally {
    exportingGroupId.value = ''
  }
}

async function removeGroup(group: ModelPartGroup): Promise<void> {
  if (!model.value) return
  try {
    await ElMessageBox.confirm(`删除分组「${group.name}」？不会删除任何模型文件。`, '删除分组', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await window.api.model.removeGroup(model.value.id, group.id)
    await reloadModel()
    ElMessage.success('已删除分组')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

function playClip(index: number): void {
  if (!viewer.value) return
  libraryKind.value = ''
  clipIndex.value = index
  viewer.value.playClip(index)
  viewer.value.setClipSpeed(speed.value)
  playing.value = true
}

function togglePlay(): void {
  if (editing.value) {
    if (editState.value?.playing) {
      viewer.value?.pauseEdit()
      playing.value = false
    } else {
      viewer.value?.playEdit()
      playing.value = true
    }
    return
  }
  if (!hasPlayable.value) return
  if (clipIndex.value < 0 && !libraryKind.value) {
    playClip(0)
    return
  }
  if (playing.value) {
    viewer.value?.pauseClip()
    playing.value = false
  } else {
    viewer.value?.resumeClip()
    playing.value = true
  }
}

function restartClip(): void {
  if (editing.value) {
    viewer.value?.seekEdit(0)
    clipTime.value = 0
    return
  }
  if (!hasPlayable.value) return
  viewer.value?.seekClip(0)
  clipTime.value = 0
}

function handleSeek(value: number | number[]): void {
  const time = Array.isArray(value) ? value[0] : value
  if (editing.value) {
    viewer.value?.seekEdit(time)
    clipTime.value = time
    return
  }
  viewer.value?.seekClip(time)
  clipTime.value = time
}

function handleSpeed(value: number): void {
  speed.value = value
  viewer.value?.setClipSpeed(value)
}

function fmtTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

function resetView(): void {
  viewer.value?.resetView()
  ElMessage.success('视角已重置')
}

function saveScreenshot(): void {
  const data = viewer.value?.screenshot()
  if (!data) {
    ElMessage.warning('画布还没准备好')
    return
  }
  const link = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  link.download = `${model.value?.name || 'model'}-${stamp}.png`
  link.href = data
  link.click()
  ElMessage.success('截图已保存')
}

async function reveal(): Promise<void> {
  if (!model.value) return
  try {
    await store.reveal(model.value.id)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <div class="app-page lab-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">
          实验台
          <span class="chip">{{ model?.name || '加载中' }}</span>
        </h1>
      </div>
      <div class="head-actions">
        <el-button :icon="FolderOpened" :disabled="!model" @click="reveal">定位文件</el-button>
        <el-button @click="router.push('/models')">返回列表</el-button>
      </div>
    </header>

    <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" show-icon />

    <nav class="menubar">
      <el-dropdown trigger="click" @command="handleMenuCommand">
        <button class="menubar__item" type="button">文件</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="locate" :disabled="!model">定位文件</el-dropdown-item>
            <el-dropdown-item command="screenshot" :disabled="!model" divided>截图</el-dropdown-item>
            <el-dropdown-item command="back" divided>返回列表</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-dropdown trigger="click" @command="handleMenuCommand">
        <button class="menubar__item" type="button">编辑</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="undo" :disabled="historyState.undo === 0">
              撤销<span class="menu-hint">Ctrl+Z</span>
            </el-dropdown-item>
            <el-dropdown-item command="redo" :disabled="historyState.redo === 0">
              恢复<span class="menu-hint">Ctrl+Y</span>
            </el-dropdown-item>
            <el-dropdown-item command="deselect" :disabled="!selectedId && selectedKeys.length === 0">
              取消选中<span class="menu-hint">Esc</span>
            </el-dropdown-item>
            <el-dropdown-item command="reset-bone" :disabled="!selectedBoneId" divided>复位该骨骼</el-dropdown-item>
            <el-dropdown-item command="reset-pose" :disabled="!structure?.bones.length">复位全部姿态</el-dropdown-item>
            <el-dropdown-item command="save-action" :disabled="!editing" divided>保存并绑定动作</el-dropdown-item>
            <el-dropdown-item command="cancel-edit" :disabled="!editing">放弃精修</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-dropdown trigger="click" @command="handleMenuCommand">
        <button class="menubar__item" type="button">视图</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="fullscreen">
              {{ appStore.immersive ? '退出全屏' : '全屏（专注模式）' }}
            </el-dropdown-item>
            <el-dropdown-item command="reset-view">重置视角</el-dropdown-item>
            <el-dropdown-item command="freeze-mesh" divided>
              仅骨骼<span class="menu-hint">{{ display.freezeMesh ? '✓' : '' }}</span>
            </el-dropdown-item>
            <el-dropdown-item command="wireframe">
              线框<span class="menu-hint">{{ display.wireframe ? '✓' : '' }}</span>
            </el-dropdown-item>
            <el-dropdown-item command="grid">
              网格<span class="menu-hint">{{ display.showGrid ? '✓' : '' }}</span>
            </el-dropdown-item>
            <el-dropdown-item command="skeleton">
              骨架<span class="menu-hint">{{ display.showSkeleton ? '✓' : '' }}</span>
            </el-dropdown-item>
            <el-dropdown-item command="autorotate">
              自动旋转<span class="menu-hint">{{ display.autoRotate ? '✓' : '' }}</span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-dropdown trigger="click" @command="handleMenuCommand">
        <button class="menubar__item" type="button">动作</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="play" :disabled="!hasPlayable">
              {{ playing ? '暂停' : '播放' }}<span class="menu-hint">空格</span>
            </el-dropdown-item>
            <el-dropdown-item command="edit-clip" :disabled="editing">进入精修</el-dropdown-item>
            <el-dropdown-item command="record-key" :disabled="!editing" divided>
              记关键帧<span class="menu-hint">K</span>
            </el-dropdown-item>
            <el-dropdown-item command="record-all" :disabled="!editing">记整帧</el-dropdown-item>
            <el-dropdown-item command="delete-key" :disabled="!editing">删关键帧</el-dropdown-item>
            <el-dropdown-item command="frame-prev" :disabled="!editing" divided>
              上一帧<span class="menu-hint">←</span>
            </el-dropdown-item>
            <el-dropdown-item command="frame-next" :disabled="!editing">
              下一帧<span class="menu-hint">→</span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-dropdown trigger="click" @command="handleMenuCommand">
        <button class="menubar__item" type="button">窗口</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="panel-props">属性面板</el-dropdown-item>
            <el-dropdown-item command="panel-actions">动作面板</el-dropdown-item>
            <el-dropdown-item command="panel-groups">分组面板</el-dropdown-item>
            <el-dropdown-item command="panel-toggle" divided>
              {{ inspectorVisible ? '隐藏检查器' : '显示检查器' }}
            </el-dropdown-item>
            <el-dropdown-item command="float">
              {{ inspectorFloating ? '停靠检查器' : '浮动检查器' }}
            </el-dropdown-item>
            <el-dropdown-item command="expand-all" divided>展开全部分区</el-dropdown-item>
            <el-dropdown-item command="collapse-all">收起全部分区</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-dropdown trigger="click" @command="handleMenuCommand">
        <button class="menubar__item" type="button">帮助</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="shortcuts">快捷键一览</el-dropdown-item>
            <el-dropdown-item command="about">关于</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </nav>

    <div class="lab" :class="{ 'no-inspector': !inspectorVisible || inspectorFloating }">
      <!-- 左：结构 -->
      <aside class="lab__panel lab__structure">
        <div class="panel-tabs">
          <button
            type="button"
            class="panel-tab"
            :class="{ 'is-active': tab === 'parts' }"
            @click="tab = 'parts'"
          >
            部件 <span class="panel-tab__count">{{ structure?.parts.length ?? 0 }}</span>
          </button>
          <button
            type="button"
            class="panel-tab"
            :class="{ 'is-active': tab === 'bones' }"
            @click="tab = 'bones'"
          >
            骨架 <span class="panel-tab__count">{{ structure?.bones.length ?? 0 }}</span>
          </button>
        </div>

        <div class="panel-tools">
          <el-input v-model="search" placeholder="搜索节点" clearable size="small" :prefix-icon="Search" />
          <el-button v-if="tab === 'parts'" link type="primary" size="small" @click="showAllParts">
            全部显示
          </el-button>
        </div>

        <div class="tree">
          <template v-if="tab === 'parts'">
            <div
              v-for="(part, index) in parts"
              :key="part.id"
              class="part-row"
              :class="{
                'is-active': selectedId === part.id,
                'is-checked': selectedKeys.includes(part.key),
                'is-hidden': hiddenParts.has(part.id)
              }"
              :style="{ marginLeft: `${part.depth * 10}px` }"
              @click="onPartClick(part, index, $event)"
              @dblclick="viewer?.focusNode(part.id)"
            >
              <button
                class="part-row__check"
                type="button"
                :title="selectedKeys.includes(part.key) ? '取消选择（可多选后分组）' : '选择（可多选后分组）'"
                @click.stop="togglePartPick(part, index, $event)"
              >
                <el-icon v-if="selectedKeys.includes(part.key)"><Check /></el-icon>
              </button>

              <div
                class="part-row__body"
                :title="`${partLabel(part)} (${part.name})  ·  ${part.triangles.toLocaleString('zh-CN')} 面 · ${part.vertices.toLocaleString('zh-CN')} 顶点`"
              >
                <el-input
                  v-if="isNoteEditing(part)"
                  v-model="noteDraft"
                  size="small"
                  maxlength="24"
                  placeholder="给这个部件起个名字，如：左臂 / 枪械 / 头部"
                  class="part-row__note-input"
                  @click.stop
                  @keyup.enter.stop="savePartNote(part)"
                  @keyup.esc.stop="cancelEditNote"
                  @blur="savePartNote(part)"
                />
                <div v-else class="part-row__title" @dblclick.stop="startEditNote(part)">
                  <span class="part-row__type" :class="{ 'is-note': Boolean(partNotes[part.key]) }">
                    {{ partLabel(part) }}
                  </span>
                  <span class="part-row__name">({{ part.name }})</span>
                </div>
              </div>

              <button
                class="part-row__note"
                type="button"
                :title="partNotes[part.key] ? '修改备注' : '添加备注'"
                @click.stop="startEditNote(part)"
              >
                <el-icon><EditPen /></el-icon>
              </button>

              <button
                class="part-row__eye"
                type="button"
                :title="hiddenParts.has(part.id) ? '显示' : '隐藏'"
                @click.stop="togglePartVisible(part.id)"
              >
                <el-icon><component :is="hiddenParts.has(part.id) ? Hide : View" /></el-icon>
              </button>
            </div>
            <p v-if="parts.length === 0" class="tree-empty">
              {{ structure?.parts.length ? '没有匹配的部件' : '该模型没有可拆分的部件' }}
            </p>
          </template>

          <template v-else>
            <div
              v-for="bone in bones"
              :key="bone.id"
              class="tree-row"
              :class="{ 'is-active': selectedId === bone.id }"
              :style="{ paddingLeft: `${8 + bone.depth * 12}px` }"
              @click="selectBone(bone.id)"
              @dblclick="viewer?.focusNode(bone.id)"
            >
              <el-icon class="tree-row__icon"><Share /></el-icon>
              <span class="tree-row__name" :title="bone.name">{{ bone.name }}</span>
              <span v-if="semantics?.roles[bone.id]" class="tree-row__role">
                {{ shortRole(semantics.roles[bone.id]) }}
              </span>
              <span v-else-if="bone.childCount" class="tree-row__meta num">{{ bone.childCount }}</span>
            </div>
            <p v-if="bones.length === 0" class="tree-empty">
              {{ structure?.bones.length ? '没有匹配的骨骼' : '该模型没有骨骼（静态模型）' }}
            </p>
          </template>
        </div>

        <footer class="panel-foot">
          <span v-if="tab === 'parts'" class="panel-foot__text">
            显示 {{ visibleCount }} / {{ structure?.parts.length ?? 0 }}
          </span>
          <span v-else class="panel-foot__text">
            {{ structure?.bones.length ?? 0 }} 骨骼<template v-if="semantics?.available"> · 语义 {{ semantics.roleCount }}</template>
          </span>
          <span class="panel-foot__hint">单击高亮 · 双击聚焦</span>
        </footer>
      </aside>

      <!-- 中：视口 + 工具条 + 时间轴 -->
      <section class="lab__viewport">
        <div class="view-toolbar">
          <el-tooltip :content="appStore.immersive ? '退出全屏' : '全屏：整窗留给实验台'" placement="bottom">
            <el-button
              size="small"
              :icon="FullScreen"
              :type="appStore.immersive ? 'primary' : 'default'"
              @click="appStore.toggleFocusMode()"
            >
              {{ appStore.immersive ? '退出全屏' : '全屏' }}
            </el-button>
          </el-tooltip>
          <span class="view-toolbar__sep" />
          <el-tooltip content="重置视角" placement="bottom">
            <el-button size="small" :icon="RefreshLeft" @click="resetView" />
          </el-tooltip>
          <el-tooltip content="截图保存" placement="bottom">
            <el-button size="small" :icon="Camera" @click="saveScreenshot" />
          </el-tooltip>
          <span class="view-toolbar__sep" />
          <el-tooltip content="自动旋转" placement="bottom">
            <el-button
              size="small"
              :icon="RefreshRight"
              :type="display.autoRotate ? 'primary' : 'default'"
              @click="display.autoRotate = !display.autoRotate"
            />
          </el-tooltip>
          <el-tooltip content="接地网格" placement="bottom">
            <el-button
              size="small"
              :icon="Grid"
              :type="display.showGrid ? 'primary' : 'default'"
              @click="display.showGrid = !display.showGrid"
            />
          </el-tooltip>
          <el-tooltip content="线框模式" placement="bottom">
            <el-button
              size="small"
              :type="display.wireframe ? 'primary' : 'default'"
              @click="display.wireframe = !display.wireframe"
            >
              线框
            </el-button>
          </el-tooltip>
          <el-tooltip content="显示骨架" placement="bottom">
            <el-button
              size="small"
              :icon="Share"
              :type="display.showSkeleton ? 'primary' : 'default'"
              @click="display.showSkeleton = !display.showSkeleton"
            />
          </el-tooltip>
          <el-tooltip
            :content="display.freezeMesh ? '仅骨骼：模型形变已冻结，点此恢复' : '仅骨骼：冻结模型形变，只摆骨骼'"
            placement="bottom"
          >
            <el-button
              size="small"
              :icon="display.freezeMesh ? Lock : Unlock"
              :type="display.freezeMesh ? 'primary' : 'default'"
              @click="toggleFreezeMesh"
            >
              仅骨骼
            </el-button>
          </el-tooltip>
          <span class="view-toolbar__sep" />
          <el-popover placement="bottom" :width="252" trigger="click">
            <template #reference>
              <el-button size="small" :icon="Brush">高亮</el-button>
            </template>
            <div class="hl">
              <div class="hl__row">
                <span class="hl__label">选中颜色</span>
                <el-color-picker v-model="highlight.color" size="small" :predefine="HL_PRESETS" />
              </div>
              <div class="hl__row">
                <span class="hl__label">亮度</span>
                <el-slider
                  v-model="highlight.intensity"
                  :min="0.05"
                  :max="1.5"
                  :step="0.05"
                  size="small"
                  class="hl__slider"
                />
                <span class="hl__value num">{{ highlight.intensity.toFixed(2) }}</span>
              </div>
              <p class="hl__hint">只影响选中部件/骨骼的高亮，不改模型材质</p>
            </div>
          </el-popover>
          <span class="view-toolbar__sep" />
          <el-color-picker v-model="display.background" size="small" :predefine="presetColors" />
          <span class="view-toolbar__label">光照</span>
          <el-slider v-model="display.exposure" :min="0.3" :max="2.5" :step="0.1" size="small" class="view-toolbar__slider" />
        </div>

        <div class="lab__stage">
          <ModelViewer
            v-if="bytes"
            ref="viewer"
            :bytes="bytes"
            :format="model?.format"
            :auto-rotate="display.autoRotate"
            :wireframe="display.wireframe"
            :show-grid="display.showGrid"
            :show-skeleton="display.showSkeleton"
            :background="display.background"
            :exposure="display.exposure"
            :highlight-color="highlight.color"
            :highlight-intensity="highlight.intensity"
            :gizmo-mode="gizmoMode"
            :freeze-mesh="display.freezeMesh"
            @parsed="handleParsed"
            @semantics="handleSemantics"
            @tick="handleTick"
            @bone-transform="handleBoneTransform"
            @edit-state="handleEditState"
            @history-state="handleHistoryState"
            @select-bone="handleViewportSelectBone"
            @select-part="handleViewportSelectPart"
            @error="errorText = $event"
          />
          <div v-else v-loading="loading" class="lab__placeholder">
            <span v-if="!loading">{{ errorText || '加载中…' }}</span>
          </div>

          <div class="stage-tools">
            <div class="stage-tools__group">
              <span class="stage-tools__label">模式</span>
              <el-radio-group :model-value="editMode" size="small" @change="setEditMode">
                <el-radio-button value="pose">姿态</el-radio-button>
                <el-radio-button value="bind">绑定</el-radio-button>
              </el-radio-group>
            </div>
            <div class="stage-tools__group">
              <span class="stage-tools__label">工具</span>
              <el-radio-group v-model="gizmoMode" size="small">
                <el-radio-button value="rotate">旋转 W</el-radio-button>
                <el-radio-button value="translate">移动 E</el-radio-button>
                <el-radio-button value="scale">缩放 R</el-radio-button>
              </el-radio-group>
            </div>
            <div class="stage-tools__group">
              <el-tooltip content="聚焦选中 (F)" placement="top">
                <el-button size="small" :icon="Aim" :disabled="!selectedId" @click="focusSelected" />
              </el-tooltip>
              <el-tooltip content="聚焦全部（重置视角）" placement="top">
                <el-button size="small" :icon="FullScreen" @click="viewer?.resetView()" />
              </el-tooltip>
            </div>
            <div class="stage-tools__group">
              <el-tooltip content="撤销 (Ctrl+Z)" placement="top">
                <el-button size="small" :icon="RefreshLeft" :disabled="historyState.undo === 0" @click="undoEdit" />
              </el-tooltip>
              <el-tooltip content="恢复 (Ctrl+Y)" placement="top">
                <el-button size="small" :icon="RefreshRight" :disabled="historyState.redo === 0" @click="redoEdit" />
              </el-tooltip>
            </div>
            <div v-if="editMode === 'bind'" class="stage-tools__group">
              <el-button size="small" type="warning" plain @click="applyBindPoseAction">应用为绑定姿态</el-button>
            </div>
          </div>
        </div>

        <div class="transport" :class="{ 'is-disabled': !hasPlayable }">
          <el-button
            circle
            size="small"
            :icon="playing ? VideoPause : VideoPlay"
            :disabled="!hasPlayable"
            @click="togglePlay"
          />
          <el-button circle size="small" :icon="RefreshLeft" :disabled="!hasPlayable" @click="restartClip" />
          <el-slider
            :model-value="clipTime"
            :max="clipDuration || 1"
            :step="0.01"
            :show-tooltip="false"
            :disabled="!hasPlayable"
            class="transport__slider"
            @input="handleSeek"
          />
          <span class="transport__time num">{{ fmtTime(clipTime) }} / {{ fmtTime(clipDuration) }}</span>
          <el-select v-model="speed" size="small" class="transport__speed" :disabled="!hasPlayable" @change="handleSpeed">
            <el-option :value="0.25" label="0.25×" />
            <el-option :value="0.5" label="0.5×" />
            <el-option :value="1" label="1×" />
            <el-option :value="1.5" label="1.5×" />
            <el-option :value="2" label="2×" />
          </el-select>
        </div>
      </section>

      <!-- 右：检查器（属性 / 动作 / 分组 三页，可浮动） -->
      <aside
        v-show="inspectorVisible"
        class="lab__panel lab__inspector"
        :class="{ 'is-floating': inspectorFloating }"
        :style="inspectorFloating ? { left: floatPos.x + 'px', top: floatPos.y + 'px' } : undefined"
      >
        <div
          class="inspector-head"
          @pointerdown="startPanelDrag"
          @pointermove="onPanelDrag"
          @pointerup="endPanelDrag"
          @pointercancel="endPanelDrag"
          @dblclick="inspectorFloating = false"
        >
          <span class="inspector-head__title">检查器</span>
          <span class="inspector-head__actions">
            <el-tooltip content="展开全部分区" placement="bottom">
              <el-button size="small" :icon="Expand" @click="setAllSections(true)" />
            </el-tooltip>
            <el-tooltip content="收起全部分区" placement="bottom">
              <el-button size="small" :icon="Fold" @click="setAllSections(false)" />
            </el-tooltip>
            <el-tooltip :content="inspectorFloating ? '停靠到右侧' : '浮动为可拖动面板'" placement="bottom">
              <el-button size="small" @click="toggleFloating">
                {{ inspectorFloating ? '停靠' : '浮动' }}
              </el-button>
            </el-tooltip>
          </span>
        </div>

        <div class="inspector-tabs">
          <button
            type="button"
            class="inspector-tab"
            :class="{ 'is-active': inspectorTab === 'props' }"
            @click="inspectorTab = 'props'"
          >
            属性
          </button>
          <button
            type="button"
            class="inspector-tab"
            :class="{ 'is-active': inspectorTab === 'actions' }"
            @click="inspectorTab = 'actions'"
          >
            动作
          </button>
          <button
            type="button"
            class="inspector-tab"
            :class="{ 'is-active': inspectorTab === 'groups' }"
            @click="inspectorTab = 'groups'"
          >
            分组
          </button>
        </div>

        <div v-show="inspectorTab === 'props'" class="inspector-body">
        <PanelSection
          title="选中"
          storage-key="inspect"
          :default-open="true"
          :key="'inspect-' + layoutVersion"
        >
          <template #actions>
            <el-button
              v-if="selectedId"
              type="primary"
              plain
              size="small"
              :icon="Aim"
              @click="focusSelected"
            >
              聚焦
            </el-button>
          </template>
          <div v-if="selectedPart" class="info">
            <div class="info__row">
              <span>类型</span>
              <el-tag size="small" effect="light">{{ PART_TYPE_LABEL[selectedPart.type] ?? selectedPart.type }}</el-tag>
            </div>
            <div class="info__row">
              <span>名称</span>
              <span class="mono info__name" :title="selectedPart.name">{{ selectedPart.name }}</span>
            </div>
            <div class="info__row">
              <span>三角面</span>
              <span class="num">{{ selectedPart.triangles.toLocaleString('zh-CN') }}</span>
            </div>
            <div class="info__row">
              <span>顶点</span>
              <span class="num">{{ selectedPart.vertices.toLocaleString('zh-CN') }}</span>
            </div>
          </div>
          <div v-else-if="selectedBone" class="info">
            <div class="info__row">
              <span>类型</span>
              <el-tag size="small" effect="light" type="warning">骨骼</el-tag>
            </div>
            <div class="info__row">
              <span>名称</span>
              <span class="mono info__name" :title="selectedBone.name">{{ selectedBone.name }}</span>
            </div>
            <div v-if="semantics?.roles[selectedBone.id]" class="info__row">
              <span>角色</span>
              <el-tag size="small" effect="light" type="success">
                {{ shortRole(semantics.roles[selectedBone.id]) }}
              </el-tag>
            </div>
            <div class="info__row">
              <span>层级</span>
              <span class="num">第 {{ selectedBone.depth + 1 }} 层</span>
            </div>
            <div class="info__row">
              <span>子骨骼</span>
              <span class="num">{{ selectedBone.childCount }}</span>
            </div>
          </div>
          <div v-else class="info">
            <div class="info__row">
              <span>来源</span>
              <el-tag v-if="meta" size="small" effect="light" :type="meta.tone">{{ meta.label }}</el-tag>
            </div>
            <div class="info__row">
              <span>三角面</span>
              <span class="num">{{ stats ? stats.triangles.toLocaleString('zh-CN') : '—' }}</span>
            </div>
            <div class="info__row">
              <span>网格 / 骨骼</span>
              <span class="num">{{ stats?.meshes ?? '—' }} / {{ structure?.bones.length ?? 0 }}</span>
            </div>
            <div class="info__row">
              <span>尺寸</span>
              <span class="num">{{ stats?.size ?? '—' }}</span>
            </div>
            <div class="info__row">
              <span>格式 / 大小</span>
              <span class="mono">{{ model?.format?.toUpperCase() }} · {{ formatBytes(model?.size ?? 0) }}</span>
            </div>
            <div class="info__row">
              <span>更新时间</span>
              <span class="num text-muted">{{ formatDateTime(model?.updatedAt, true) }}</span>
            </div>
          </div>
        </PanelSection>

        <PanelSection
          v-if="selectedBoneId"
          title="编辑骨骼"
          storage-key="bone-edit"
          :default-open="true"
          :key="'bone-edit-' + layoutVersion"
        >
          <template #actions>
            <el-tooltip content="撤销 (Ctrl+Z)" placement="top">
              <el-button
                class="is-icon-only"
                size="small"
                :icon="RefreshLeft"
                :disabled="historyState.undo === 0"
                @click="undoEdit"
              />
            </el-tooltip>
            <el-tooltip content="恢复 (Ctrl+Y)" placement="top">
              <el-button
                class="is-icon-only"
                size="small"
                :icon="RefreshRight"
                :disabled="historyState.redo === 0"
                @click="redoEdit"
              />
            </el-tooltip>
          </template>
          <el-radio-group v-model="gizmoMode" size="small" class="edit-modes">
            <el-radio-button value="rotate">旋转</el-radio-button>
            <el-radio-button value="translate">移动</el-radio-button>
            <el-radio-button value="off">关闭</el-radio-button>
          </el-radio-group>

          <div class="edit-vec">
            <span class="edit-vec__label">位置</span>
            <el-input
              v-for="axis in POSITION_AXES"
              :key="'p-' + axis"
              :model-value="fmtVec(boneTransform?.position, axis, 3)"
              size="small"
              class="edit-vec__input"
              @change="(value: string) => onPositionChange(axis, value)"
              @keyup.enter="commitOnEnter"
            />
          </div>

          <div class="edit-vec">
            <span class="edit-vec__label">旋转°</span>
            <el-input
              v-for="axis in POSITION_AXES"
              :key="'r-' + axis"
              :model-value="fmtVec(boneTransform?.rotation, axis, 2)"
              size="small"
              class="edit-vec__input"
              @change="(value: string) => onRotationChange(axis, value)"
              @keyup.enter="commitOnEnter"
            />
          </div>

          <div class="edit-actions">
            <el-button size="small" @click="resetSelectedBone">复位该骨骼</el-button>
            <el-button size="small" @click="resetAllPose">复位全部姿态</el-button>
          </div>
          <el-button
            v-if="editMode === 'bind'"
            size="small"
            type="warning"
            plain
            class="edit-bind"
            @click="applyBindPoseAction"
          >
            应用为绑定姿态
          </el-button>
          <p class="block__hint">
            {{
              editMode === 'bind'
                ? '绑定模式：网格已冻结，挪骨骼只改绑定位置；「应用为绑定姿态」后从新基准变形'
                : '拖动手柄或直接改数值（W 旋转 / E 移动 / R 缩放）；编辑时会暂停当前动作'
            }}
          </p>
        </PanelSection>

        <PanelSection
          v-if="structure?.bones.length"
          title="快捷姿态"
          :count="QUICK_POSES.length + 1"
          storage-key="quick-pose"
          :default-open="true"
          :key="'quick-pose-' + layoutVersion"
        >
          <div class="quick-grid">
            <el-button
              v-for="item in QUICK_POSES"
              :key="item.action"
              size="small"
              :type="quickAction === item.action ? 'primary' : 'default'"
              @click="applyQuickPose(item.action)"
            >
              {{ item.label }}
            </el-button>
            <el-button size="small" type="primary" plain @click="applyQuickPose('reset')">
              重置姿态
            </el-button>
          </div>

          <div v-if="quickAction" class="quick-amount">
            <div class="quick-amount__head">
              <span class="quick-amount__label">{{ quickActionLabel }}</span>
              <span class="quick-amount__value num">{{ quickAmount }}°</span>
            </div>
            <el-slider
              :model-value="quickAmount"
              :min="0"
              :max="60"
              :step="1"
              :show-tooltip="false"
              size="small"
              @input="handleQuickAmount"
            />
            <el-button size="small" class="quick-amount__done" @click="finishQuickPose">完成</el-button>
          </div>

          <p class="block__hint">
            {{ quickAction ? '拖动滑杆调节程度，0° 等于没动；点「完成」收起滑杆' : '点一个动作按钮，下方出现滑杆调节程度；Ctrl+Z 可撤销' }}
          </p>
        </PanelSection>
        </div>

        <div v-show="inspectorTab === 'actions'" class="inspector-body">
        <PanelSection
          v-if="editing"
          tone="accent"
          title="精修"
          :count="editState?.name"
          storage-key="clip-edit"
          :default-open="true"
          :key="'clip-edit-' + layoutVersion"
        >
          <template #actions>
            <el-button type="primary" size="small" :loading="savingAction" @click="saveEdit">
              保存并绑定
            </el-button>
          </template>
          <div class="edit-timeline">
            <el-button-group size="small">
              <el-button :icon="RefreshLeft" @click="viewer?.seekEdit(0)" />
              <el-button :icon="ArrowLeft" @click="stepFrame(-1)" />
              <el-button :icon="editState?.playing ? VideoPause : VideoPlay" @click="togglePlay" />
              <el-button :icon="ArrowRight" @click="stepFrame(1)" />
            </el-button-group>
            <span class="edit-time num">{{ editFrame.current }} / {{ editFrame.total }} 帧</span>
          </div>

          <div class="key-strip">
            <span
              v-for="time in editState?.boneKeys ?? []"
              :key="time"
              class="key-mark"
              :class="{ 'is-current': Math.abs(time - (editState?.time ?? 0)) < 0.5 / editFrame.fps }"
              :style="{ left: keyPercent(time) }"
            />
            <span class="key-playhead" :style="{ left: keyPercent(editState?.time ?? 0) }" />
          </div>

          <div class="edit-buttons">
            <el-button size="small" type="primary" plain @click="recordKey">记关键帧 K</el-button>
            <el-button size="small" @click="recordAll">记整帧</el-button>
            <el-button size="small" @click="removeKey">删关键帧</el-button>
          </div>

          <p class="block__hint">
            共 {{ editState?.keyCount ?? 0 }} 个关键帧 · 选中骨骼 {{ editState?.boneKeys.length ?? 0 }} 个 ·
            ← / → 逐帧，K 记帧
          </p>
          <el-button size="small" class="edit-cancel" @click="cancelEdit">放弃精修</el-button>
        </PanelSection>

        <PanelSection
          title="动作"
          :count="clips.length"
          storage-key="clips"
          :default-open="true"
          :key="'clips-' + layoutVersion"
        >
          <div v-if="clips.length" class="clip-list">
            <div v-for="clip in clips" :key="clip.index" class="clip-row">
              <button
                type="button"
                class="clip"
                :class="{ 'is-active': !libraryKind && clipIndex === clip.index }"
                @click="playClip(clip.index)"
              >
                <el-icon class="clip__icon"><VideoPlay /></el-icon>
                <span class="clip__name" :title="clip.name">{{ clip.name }}</span>
                <span class="clip__time num">{{ clip.duration.toFixed(2) }}s</span>
              </button>
              <el-tooltip content="精修这段动作" placement="left">
                <el-button
                  class="clip-row__btn"
                  size="small"
                  type="primary"
                  plain
                  :icon="EditPen"
                  @click.stop="startEditNative(clip.index)"
                />
              </el-tooltip>
            </div>
          </div>
          <p v-else class="block__empty">该模型没有内置动作</p>
          <div v-if="libraryKind && !editing" class="edit-entry">
            <span class="edit-entry__label">
              当前：{{ libraryDefs.find((item) => item.kind === libraryKind)?.label ?? libraryKind }}
            </span>
            <el-button size="small" type="primary" plain :icon="EditPen" @click="startEditLibrary">
              精修这段
            </el-button>
          </div>
        </PanelSection>

        <PanelSection
          v-if="actions.length"
          title="已绑定动作"
          :count="actions.length"
          storage-key="bound"
          :default-open="true"
          :key="'bound-' + layoutVersion"
        >
          <div class="clip-list">
            <div v-for="action in actions" :key="action.id" class="clip-row">
              <button type="button" class="clip" @click="playSaved(action)">
                <el-icon class="clip__icon"><VideoPlay /></el-icon>
                <span class="clip__name" :title="action.name">{{ action.name }}</span>
                <span class="clip__time num">{{ action.duration.toFixed(2) }}s</span>
              </button>
              <el-tooltip content="精修" placement="left">
                <el-button
                  class="clip-row__btn"
                  size="small"
                  type="primary"
                  plain
                  :icon="EditPen"
                  @click.stop="startEditSaved(action)"
                />
              </el-tooltip>
              <el-tooltip content="删除" placement="left">
                <el-button
                  class="clip-row__btn"
                  size="small"
                  :icon="Delete"
                  @click.stop="removeSaved(action)"
                />
              </el-tooltip>
            </div>
          </div>
        </PanelSection>

        <PanelSection
          title="动作库"
          :count="libraryDefs.length"
          storage-key="library"
          :default-open="false"
          :key="'library-' + layoutVersion"
        >
          <p v-if="semantics && !semantics.available" class="block__hint">
            {{ semantics.warnings[0] || '该模型没有可用骨骼，动作库不可用' }}
          </p>
          <p v-else-if="!semantics" class="block__hint">正在识别骨骼语义…</p>
          <template v-else>
            <p class="block__hint">
              按骨骼语义现场生成，不需要模型自带动作
              <template v-if="semantics.missing.length">
                · 缺：{{ semantics.missing.slice(0, 4).map(shortRole).join('、') }}<template v-if="semantics.missing.length > 4">…</template>
              </template>
            </p>
            <div class="library-grid">
              <button
                v-for="def in libraryDefs"
                :key="def.kind"
                type="button"
                class="clip clip--lib"
                :class="{ 'is-active': libraryKind === def.kind }"
                :title="def.description"
                @click="playLibrary(def.kind)"
              >
                <span class="clip__name">{{ def.label }}</span>
                <span class="clip__time num">{{ def.defaultDuration }}s</span>
              </button>
            </div>
          </template>
        </PanelSection>
        </div>

        <div v-show="inspectorTab === 'groups'" class="inspector-body">
        <PanelSection
          v-if="tab === 'parts' || groups.length > 0"
          title="分组"
          :count="groups.length"
          storage-key="groups"
          :default-open="true"
          :key="'groups-' + layoutVersion"
        >
          <template #actions>
            <el-button
              type="primary"
              size="small"
              :loading="savingGroup"
              :disabled="selectedKeys.length === 0"
              @click="handleSaveGroup"
            >
              保存为分组
            </el-button>
          </template>
          <p class="block__hint">
            已选 {{ selectedKeys.length }} 个部件<template v-if="selectedKeys.length">（可导出为独立 glb）</template>
            · Ctrl / Shift 多选
          </p>
          <div v-if="groups.length" class="group-list">
            <div v-for="group in groups" :key="group.id" class="group">
              <div class="group__main">
                <span class="group__name" :title="group.name">{{ group.name }}</span>
                <span class="group__count num">{{ group.partKeys.length }} 件</span>
              </div>
              <div class="group__actions">
                <el-tooltip content="应用：只显示这些部件" placement="top">
                  <el-button link size="small" :icon="View" @click="applyGroup(group)" />
                </el-tooltip>
                <el-tooltip content="导出为 glb" placement="top">
                  <el-button
                    link
                    size="small"
                    :icon="Download"
                    :loading="exportingGroupId === group.id"
                    @click="exportGroup(group)"
                  />
                </el-tooltip>
                <el-tooltip content="删除分组" placement="top">
                  <el-button link size="small" type="danger" :icon="Delete" @click="removeGroup(group)" />
                </el-tooltip>
              </div>
            </div>
          </div>
          <p v-else class="block__empty">在左侧选中部件后可保存为分组</p>
        </PanelSection>
        </div>

        <p class="lab__path mono" :title="model?.path">{{ model?.path }}</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.lab-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 14px;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.lab {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr) 288px;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.lab__panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

/* ---------- 左：结构 ---------- */
.part-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color var(--dur-fast) linear, background var(--dur-fast) linear;
}

.part-row + .part-row {
  margin-top: 4px;
}

.part-row:hover {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border-color));
}

.part-row.is-checked {
  border-color: color-mix(in srgb, var(--warning, #f59e0b) 55%, transparent);
  background: color-mix(in srgb, var(--warning, #f59e0b) 8%, var(--bg-surface));
}

.part-row.is-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-surface));
}

.part-row.is-hidden {
  opacity: 0.55;
}

.part-row__check {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid var(--border-color);
  background: transparent;
  color: #fff;
  cursor: pointer;
  transition: border-color var(--dur-fast) linear, background var(--dur-fast) linear;
}

.part-row__check:hover {
  border-color: var(--warning, #f59e0b);
}

.part-row.is-checked .part-row__check {
  border-color: var(--warning, #f59e0b);
  background: var(--warning, #f59e0b);
}

.part-row__check :deep(.el-icon) {
  font-size: 11px;
}

.part-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.part-row__title {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary);
}

.part-row__type {
  flex: none;
  font-weight: 600;
}

.part-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-tertiary);
  font-size: 11px;
}


.part-row__note {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) linear, color var(--dur-fast) linear;
}

.part-row:hover .part-row__note,
.part-row.is-checked .part-row__note,
.part-row__note:focus-visible {
  opacity: 1;
}

.part-row__note:hover {
  color: var(--accent);
}

.part-row__note :deep(.el-icon) {
  font-size: 12px;
}

.part-row__title {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary);
}

.part-row__type.is-note {
  color: var(--accent);
}

.part-row__note-input {
  width: 100%;
}

.part-row__note-input :deep(.el-input__wrapper) {
  padding: 0 6px;
  height: 22px;
}

.part-row__note-input :deep(.el-input__inner) {
  font-size: 11.5px;
  height: 22px;
}

.part-row__eye {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 50%;
  border: 1.5px solid var(--border-color);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: border-color var(--dur-fast) linear, color var(--dur-fast) linear;
}

.part-row__eye:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.part-row.is-hidden .part-row__note {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) linear, color var(--dur-fast) linear;
}

.part-row:hover .part-row__note,
.part-row.is-checked .part-row__note,
.part-row__note:focus-visible {
  opacity: 1;
}

.part-row__note:hover {
  color: var(--accent);
}

.part-row__note :deep(.el-icon) {
  font-size: 12px;
}

.part-row__title {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary);
}

.part-row__type.is-note {
  color: var(--accent);
}

.part-row__note-input {
  width: 100%;
}

.part-row__note-input :deep(.el-input__wrapper) {
  padding: 0 6px;
  height: 22px;
}

.part-row__note-input :deep(.el-input__inner) {
  font-size: 11.5px;
  height: 22px;
}

.part-row__eye {
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
  color: var(--danger);
}

.part-row__eye :deep(.el-icon) {
  font-size: 12px;
}

.panel-tabs {
  display: flex;
  padding: 8px 8px 0;
  gap: 4px;
  border-bottom: 1px solid var(--border-color);
}

.panel-tab {
  flex: 1;
  padding: 7px 6px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
  transition: color var(--dur-fast) linear, border-color var(--dur-fast) linear;
}

.panel-tab.is-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.panel-tab__count {
  margin-left: 2px;
  font-size: 11px;
  opacity: 0.7;
}

.panel-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border-color);
}

.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 4px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 12px;
}

.tree-row:hover {
  background: var(--bg-hover);
}

.tree-row.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.tree-row.is-checked {
  background: var(--accent-softer);
}

.tree-row.is-checked.is-active {
  background: var(--accent-soft);
}

.tree-row.is-hidden {
  opacity: 0.45;
}

.tree-row__eye {
  padding: 0;
  width: 18px;
  min-width: 18px;
  height: 18px;
}

.tree-row__icon {
  font-size: 12px;
  flex: none;
  opacity: 0.75;
}

.tree-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-row__meta {
  font-size: 10.5px;
  color: var(--text-tertiary);
  flex: none;
}

.tree-row__role {
  font-size: 10px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-softer);
  color: var(--accent);
  flex: none;
  white-space: nowrap;
}

.library-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  max-height: 208px;
  overflow-y: auto;
  padding-right: 2px;
}

.clip--lib {
  padding: 6px 8px;
  background: var(--bg-subtle);
}

.clip--lib .clip__name {
  font-size: 11.5px;
}

/* 骨骼编辑面板 */
.edit-modes {
  display: flex;
  width: 100%;
}

.edit-modes :deep(.el-radio-button) {
  flex: 1;
}

.edit-modes :deep(.el-radio-button__inner) {
  width: 100%;
  padding: 4px 0;
  font-size: 11.5px;
}

.edit-vec {
  display: grid;
  grid-template-columns: 34px repeat(3, minmax(0, 1fr));
  gap: 4px;
  align-items: center;
}

.edit-vec__label {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.edit-vec__input {
  width: 100%;
}

.edit-vec__input :deep(.el-input__wrapper) {
  padding: 0 4px;
}

.edit-vec__input :deep(.el-input__inner) {
  font-size: 11px;
  text-align: right;
}

.quick-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.quick-grid :deep(.el-button) {
  margin-left: 0;
  padding: 0 4px;
  font-size: 11.5px;
}

.quick-amount {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.quick-amount__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
}

.quick-amount__label {
  color: var(--text-secondary);
  font-weight: 600;
}

.quick-amount__value {
  color: var(--accent);
  font-weight: 600;
}

.quick-amount :deep(.el-slider) {
  margin: 0 4px;
}

.quick-amount__done {
  align-self: flex-end;
  margin-top: 2px;
}

.block__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.block__actions :deep(.el-button) {
  height: 22px;
  width: 24px;
  padding: 0;
}

.edit-actions {
  display: flex;
  gap: 6px;
}

.edit-actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
}

.tree-empty {
  margin: 20px 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  line-height: 1.6;
}

.panel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.panel-foot__hint {
  opacity: 0.8;
  white-space: nowrap;
  flex: none;
}

.panel-foot__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 中：视口 ---------- */
.lab__viewport {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}

.view-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  row-gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  flex: none;
  min-width: 0;
}

.view-toolbar__sep {
  width: 1px;
  height: 16px;
  background: var(--border-color);
  margin: 0 2px;
}

.view-toolbar__label {
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.view-toolbar__slider {
  width: 80px;
}

.hl {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}

.hl__row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hl__label {
  font-size: 12px;
  color: var(--text-secondary);
  width: 58px;
  flex: none;
}

.hl__slider {
  flex: 1;
  margin: 0;
}

.hl__value {
  font-size: 11px;
  color: var(--text-tertiary);
  width: 30px;
  text-align: right;
}

.hl__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.lab__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: #0b1220;
}

/* 视口浮层工具条：模式 / 工具 / 聚焦 / 撤销 */
.stage-tools {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(11, 18, 32, 0.72);
  backdrop-filter: blur(8px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}

.stage-tools__group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
}

.stage-tools__group:last-child {
  padding-right: 0;
  border-right: none;
}

.stage-tools__label {
  font-size: 11px;
  color: #94a3b8;
}

.stage-tools :deep(.el-radio-button__inner) {
  padding: 4px 8px;
  font-size: 11.5px;
  color: #cbd5e1;
  background: transparent;
  border-color: rgba(255, 255, 255, 0.18);
  box-shadow: none !important;
}

.stage-tools :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: color-mix(in srgb, var(--accent) 82%, transparent);
  border-color: transparent;
  color: #fff;
}

.stage-tools :deep(.el-button) {
  height: 24px;
  padding: 0 8px;
  margin-left: 0;
  font-size: 11.5px;
  color: #cbd5e1;
  background: transparent;
  border-color: rgba(255, 255, 255, 0.18);
}

.stage-tools :deep(.el-button:hover) {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}

.stage-tools :deep(.el-button.is-disabled) {
  opacity: 0.4;
}

.edit-bind {
  width: 100%;
  margin-left: 0;
}

.lab__placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  color: rgba(226, 232, 240, 0.65);
  font-size: 13px;
  text-align: center;
  padding: 0 24px;
}

.transport {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  flex: none;
}

.transport.is-disabled {
  opacity: 0.75;
}

.transport__slider {
  flex: 1;
  margin: 0 4px;
}

.transport__time {
  font-size: 11.5px;
  color: var(--text-secondary);
  min-width: 104px;
  text-align: right;
}

.transport__speed {
  width: 84px;
}

/* ---------- 右：检查器 ---------- */
.lab__inspector {
  padding: 8px;
  gap: 6px;
  overflow: hidden;
}

/* 菜单栏 */
.menubar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 3px 6px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
}

.menubar__item {
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
  transition: background var(--dur-fast) linear, color var(--dur-fast) linear;
}

.menubar__item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.menu-hint {
  float: right;
  margin-left: 28px;
  color: var(--text-tertiary);
  font-size: 11px;
}

/* 检查器：头部 + 页签 + 面板体 */
.inspector-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 0 2px;
  user-select: none;
}

.lab__inspector.is-floating .inspector-head {
  cursor: move;
}

.inspector-head__title {
  flex: 1;
  font-size: 11px;
  color: var(--text-tertiary);
  letter-spacing: 0.06em;
}

.inspector-head__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.inspector-head__actions :deep(.el-button) {
  width: auto;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  margin-left: 0;
  font-size: 11.5px;
}

.inspector-tabs {
  display: flex;
  gap: 2px;
  flex: none;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}

.inspector-tab {
  flex: 1;
  padding: 4px 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--dur-fast) linear, color var(--dur-fast) linear;
}

.inspector-tab:hover {
  color: var(--text-secondary);
}

.inspector-tab.is-active {
  background: var(--bg-surface);
  color: var(--accent);
  font-weight: 600;
}

.inspector-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

/* 浮动模式：脱离网格独立悬浮，可拖动 */
.lab {
  position: relative;
}

.lab__inspector.is-floating {
  position: absolute;
  z-index: 30;
  width: 304px;
  max-height: calc(100% - 24px);
  box-shadow: var(--shadow-lg);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border-color));
  background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
  backdrop-filter: blur(8px);
}

.lab.no-inspector {
  grid-template-columns: 248px minmax(0, 1fr);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 6px;
}

.block__count {
  font-size: 11px;
  color: var(--text-tertiary);
  opacity: 0.8;
}

.block__action {
  margin-left: auto;
  height: 22px;
  padding: 0 8px;
  font-size: 11.5px;
  flex: none;
}

.block__action :deep(.el-icon) {
  font-size: 12px;
}

.block__empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.block__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  font-size: 12px;
  color: var(--text-secondary);
}

.group__main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.group__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.group__count {
  font-size: 10.5px;
  color: var(--text-tertiary);
  flex: none;
}

.group__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.clip-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.clip {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.clip:hover {
  background: var(--bg-hover);
}

.clip.is-active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}

.clip__icon {
  font-size: 12px;
  flex: none;
}

.clip__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip__time {
  font-size: 10.5px;
  color: var(--text-tertiary);
  flex: none;
}

/* 动作精修 */
.clip-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.clip-row .clip {
  flex: 1;
  min-width: 0;
}

.clip-row__btn {
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
}

.edit-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border-color);
}

.edit-entry__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.block--edit {
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  border-radius: var(--radius-md);
  padding: 10px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.edit-timeline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.edit-time {
  font-size: 11px;
  color: var(--text-secondary);
}

.key-strip {
  position: relative;
  height: 18px;
  margin: 8px 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-subtle);
  overflow: hidden;
}

.key-mark {
  position: absolute;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 1px;
  background: var(--accent);
  transform: rotate(45deg);
}

.key-mark.is-current {
  background: var(--warning, #f59e0b);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning, #f59e0b) 35%, transparent);
}

.key-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  margin-left: -0.75px;
  background: var(--text-primary);
  opacity: 0.65;
}

.edit-buttons {
  display: flex;
  gap: 6px;
}

.edit-buttons :deep(.el-button) {
  flex: 1;
  margin-left: 0;
  padding: 0 6px;
}

.edit-cancel {
  width: 100%;
  margin-top: 6px;
}

.info {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
}

.info__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-secondary);
}

.info__row > span:first-child {
  color: var(--text-tertiary);
}

.info__name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lab__path {
  margin: auto 0 0;
  font-size: 10.5px;
  color: var(--text-tertiary);
  word-break: break-all;
  line-height: 1.5;
}

@media (max-width: 1280px) {
  .lab {
    grid-template-columns: 208px minmax(0, 1fr) 248px;
  }
}
</style>
