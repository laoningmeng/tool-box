<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Aim,
  ArrowLeft,
  ArrowRight,
  Back,
  Check,
  Close,
  Delete,
  FullScreen,
  Lock,
  Refresh,
  RefreshLeft,
  RefreshRight,
  Search,
  Unlock,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import type { ClipEditState, SemanticSummary, ViewerStructure } from '@renderer/components/model-viewer-types'
import type { ActionKind } from '@renderer/rig/types'
import type { QuickPoseAction } from '@renderer/components/model-viewer-types'
import { useModelStore } from '@renderer/stores/models'
import { useAppStore } from '@renderer/stores/app'
import type { ModelAction, ModelAsset } from '@shared/types'

/**
 * 动作精修页：独立页面做逐帧调骨骼。
 * 从实验台带参数进来（native / library / action），用一个 ModelViewer 的 editSession 承载。
 */

const route = useRoute()
const router = useRouter()
const store = useModelStore()
const appStore = useAppStore()

const modelId = computed(() => String(route.params.id ?? ''))
const model = ref<ModelAsset | null>(null)
const bytes = ref<Uint8Array | ArrayBuffer | null>(null)
const loading = ref(true)
const errorText = ref('')
const viewer = ref<InstanceType<typeof ModelViewer> | null>(null)

const structure = ref<ViewerStructure | null>(null)
const semantics = ref<SemanticSummary | null>(null)
const editState = ref<ClipEditState | null>(null)
const historyState = ref({ undo: 0, redo: 0 })
const saving = ref(false)
const started = ref(false)

const selectedBoneIds = ref<string[]>([])
const frozenBoneIds = ref<string[]>([])
const boxSelectMode = ref(false)

function toggleBoxSelectMode(): void {
  boxSelectMode.value = !boxSelectMode.value
  viewer.value?.setBoxSelectMode(boxSelectMode.value)
}
const boneTransform = ref<{
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
} | null>(null)

const gizmoMode = ref<'rotate' | 'translate' | 'scale' | 'off'>('rotate')
const display = reactive({
  autoRotate: false,
  showGrid: true,
  showSkeleton: true,
  freezeMesh: false
})

const selectedBoneId = computed(() => (selectedBoneIds.value.length === 1 ? selectedBoneIds.value[0] : ''))
const multiSelected = computed(() => selectedBoneIds.value.length > 1)
const selectedBone = computed(
  () => structure.value?.bones.find((bone) => bone.id === selectedBoneId.value) ?? null
)
const selectedNames = computed(() =>
  selectedBoneIds.value
    .map((id) => structure.value?.bones.find((bone) => bone.id === id)?.name ?? '')
    .filter(Boolean)
)
const selectedRole = computed(() => {
  if (!selectedBoneId.value) return ''
  const label = semantics.value?.roles[selectedBoneId.value] ?? ''
  return label ? shortRole(label) : ''
})
const selectedFrozenCount = computed(
  () => selectedBoneIds.value.filter((id) => frozenBoneIds.value.includes(id)).length
)
const allSelectedFrozen = computed(
  () => selectedBoneIds.value.length > 0 && selectedFrozenCount.value === selectedBoneIds.value.length
)
const editing = computed(() => Boolean(editState.value?.editing))
const editName = computed(() => editState.value?.name ?? '精修')
const fps = computed(() => editState.value?.fps ?? 30)
const frame = computed(() => ({
  current: Math.round((editState.value?.time ?? 0) * fps.value),
  total: Math.max(1, Math.round((editState.value?.duration ?? 0) * fps.value))
}))
const playing = computed(() => Boolean(editState.value?.playing))
const boneKeys = computed(() => editState.value?.boneKeys ?? [])

function shortRole(label: string): string {
  const match = /^[\u4e00-\u9fa5·]+/.exec(label)
  return match ? match[0] : label
}

function handleParsed(next: ViewerStructure): void {
  structure.value = next
}

function handleSemantics(summary: SemanticSummary): void {
  semantics.value = summary
  // 语义识别在 parsed 之后才完成；动作库类型的精修依赖语义，所以等这里再开精修会话
  void beginFromRoute()
}

function handleEditState(state: ClipEditState): void {
  editState.value = state
}

function handleHistoryState(state: { undo: number; redo: number }): void {
  historyState.value = state
}

function handleBoneTransform(payload: {
  id: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
}): void {
  if (payload.id !== selectedBoneId.value) return
  boneTransform.value = { position: payload.position, rotation: payload.rotation }
}

function handleViewportBone(id: string): void {
  if (!structure.value?.bones.some((bone) => bone.id === id)) return
  selectBone(id)
}

function handleSelectBones(ids: string[]): void {
  selectedBoneIds.value = ids
  if (ids.length === 1) {
    viewer.value?.selectNode(ids[0])
    const transform = viewer.value?.getBoneTransform(ids[0])
    if (transform) boneTransform.value = transform
  } else {
    boneTransform.value = null
    viewer.value?.clearSelection()
  }
}

function handleFreezeState(state: { frozen: string[] }): void {
  frozenBoneIds.value = state.frozen
}

async function beginFromRoute(): Promise<void> {
  if (started.value || !viewer.value) return
  started.value = true
  const type = String(route.query.type ?? '')
  let result: { ok: boolean; message?: string } | undefined
  if (type === 'native') {
    const index = Number(route.query.index ?? 0)
    const clip = structure.value?.clips[index]
    result = viewer.value.beginEdit({ clipIndex: index, origin: 'native', name: clip?.name })
  } else if (type === 'library') {
    const kind = String(route.query.kind ?? '') as ActionKind
    if (kind) result = viewer.value.beginEdit({ kind, origin: 'library' })
  } else if (type === 'action') {
    const action = actions.value.find((item) => item.id === String(route.query.id ?? ''))
    if (action) {
      result = viewer.value.beginEdit({
        name: action.name,
        origin: action.origin,
        sourceKind: action.sourceKind,
        tracks: action.tracks,
        duration: action.duration,
        loop: action.loop
      })
    }
  }
  if (!result?.ok) {
    errorText.value = result?.message ?? '这段动作无法精修'
    ElMessage.warning(errorText.value)
  }
}

const actions = computed(() => model.value?.actions ?? [])

/* -------------------------------- 选中骨骼 -------------------------------- */

function selectBone(id: string): void {
  selectedBoneIds.value = [id]
  viewer.value?.setSelectedBones([id])
  viewer.value?.selectNode(id)
  const transform = viewer.value?.getBoneTransform(id)
  if (transform) boneTransform.value = transform
}

function deselect(): void {
  selectedBoneIds.value = []
  boneTransform.value = null
  viewer.value?.setSelectedBones([])
  viewer.value?.clearSelection()
}

/* ------------------------------ 快捷姿态 ------------------------------ */

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

const quickOpen = ref(true)
const quickAction = ref<QuickPoseAction | ''>('')
const quickAmount = ref(12)

const quickActionLabel = computed(() => {
  if (!quickAction.value) return ''
  return QUICK_POSES.find((item) => item.action === quickAction.value)?.label ?? quickAction.value
})

/** 点快捷姿态按钮：按 12° 施加，下方出现滑杆 */
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

/* ------------------------------ 冻结 / 重置姿态 ------------------------------ */

function toggleFreezeSelected(): void {
  const ids = selectedBoneIds.value
  if (ids.length === 0) return
  if (allSelectedFrozen.value) {
    viewer.value?.setBonesFrozen(ids, false)
    ElMessage.success(`已解冻 ${ids.length} 根骨骼`)
  } else {
    viewer.value?.setBonesFrozen(ids, true)
    ElMessage.success(`已冻结 ${ids.length} 根骨骼：播放动作时保持当前姿态`)
  }
}

function resetPose(): void {
  viewer.value?.endQuickPose()
  quickAction.value = ''
  viewer.value?.resetPose()
  ElMessage.success('已重置为绑定姿态')
}

/* -------------------------------- 逐帧操作 -------------------------------- */

function togglePlay(): void {
  if (!editing.value) return
  if (playing.value) viewer.value?.pauseEdit()
  else viewer.value?.playEdit()
}

function step(delta: number): void {
  if (!editing.value) return
  viewer.value?.stepEditFrame(delta)
}

function seek(time: number): void {
  if (!editing.value) return
  viewer.value?.seekEdit(time)
}

function recordKey(): void {
  if (!selectedBoneId.value) {
    ElMessage.warning('先在视口里选中一根骨骼')
    return
  }
  const result = viewer.value?.recordKey()
  if (result?.ok) ElMessage.success('已记录关键帧')
  else ElMessage.warning(result?.message ?? '记录失败')
}

function recordAll(): void {
  const result = viewer.value?.recordAllKeys()
  if (result?.ok) ElMessage.success(`已记录整帧（${result.count} 根骨骼）`)
  else ElMessage.warning('记录失败')
}

function removeKey(): void {
  const result = viewer.value?.deleteKey()
  if (result?.ok) ElMessage.success('已删除当前帧关键帧')
  else ElMessage.warning(result?.message ?? '删除失败')
}

function undoEdit(): void {
  const result = viewer.value?.undo()
  if (!result?.ok) ElMessage.info('没有可撤销的操作')
}

function redoEdit(): void {
  const result = viewer.value?.redo()
  if (!result?.ok) ElMessage.info('没有可恢复的操作')
}

/* -------------------------------- 数值编辑 -------------------------------- */

const POSITION_AXES = ['x', 'y', 'z'] as const

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
}

function resetAllPose(): void {
  viewer.value?.resetPose()
}

/* -------------------------------- 保存 / 退出 -------------------------------- */

async function save(): Promise<void> {
  const payload = viewer.value?.getEditResult()
  if (!payload) {
    ElMessage.warning('没有可保存的关键帧')
    return
  }
  saving.value = true
  try {
    const saved = await window.api.model.saveAction(modelId.value, payload)
    ElMessage.success(`已绑定动作：${saved.name}（${saved.tracks.length} 根骨骼）`)
    backToLab()
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function cancel(): Promise<void> {
  try {
    await ElMessageBox.confirm('放弃这次精修？未保存的关键帧会丢失。', '放弃精修', {
      type: 'warning',
      confirmButtonText: '放弃',
      cancelButtonText: '继续编辑'
    })
  } catch {
    return
  }
  backToLab()
}

function backToLab(): void {
  viewer.value?.endEdit()
  void router.push(`/models/lab/${modelId.value}`)
}

/* -------------------------------- 快捷键 -------------------------------- */

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const tag = target?.tagName ?? ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
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
  if (event.key === 'Escape') {
    deselect()
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    step(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    step(1)
  } else if (event.key === 'k' || event.key === 'K') {
    event.preventDefault()
    recordKey()
  } else if (event.key === ' ') {
    event.preventDefault()
    togglePlay()
  } else if (!mod && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'w' || key === 'e' || key === 'r') {
      gizmoMode.value = key === 'w' ? 'rotate' : key === 'e' ? 'translate' : 'scale'
    } else if (key === 'f' && selectedBoneId.value) {
      viewer.value?.focusNode(selectedBoneId.value)
    } else if (key === 'x') {
      toggleFreezeSelected()
    }
  }
}

/* -------------------------------- 生命周期 -------------------------------- */

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  loading.value = true
  try {
    const list = await window.api.model.list()
    model.value = list.find((item) => item.id === modelId.value) ?? null
    if (!model.value) {
      errorText.value = '模型不存在或已被移除'
      return
    }
    bytes.value = await store.readBytes(modelId.value)
  } catch (error) {
    errorText.value = (error as Error).message
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (appStore.immersive || appStore.fullscreen) void appStore.exitFocusMode()
})
</script>

<template>
  <div class="app-page edit-page">
    <header class="edit-head">
      <div class="edit-head__left">
        <el-button :icon="Back" size="small" @click="backToLab">返回实验台</el-button>
        <h1 class="page-title">
          动作精修
          <span class="chip">{{ editName }}</span>
        </h1>
      </div>
      <div class="edit-head__right">
        <el-tooltip content="撤销 (Ctrl+Z)" placement="bottom">
          <el-button size="small" :icon="RefreshLeft" :disabled="historyState.undo === 0" @click="undoEdit" />
        </el-tooltip>
        <el-tooltip content="恢复 (Ctrl+Y)" placement="bottom">
          <el-button size="small" :icon="RefreshRight" :disabled="historyState.redo === 0" @click="redoEdit" />
        </el-tooltip>
        <span class="edit-head__sep" />
        <el-button size="small" :icon="Refresh" @click="resetPose">重置姿态</el-button>
        <el-button size="small" @click="cancel">放弃</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="save">保存并绑定</el-button>
      </div>
    </header>

    <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" show-icon />

    <div class="edit-body">
      <!-- 中：视口 + 时间轴 -->
      <section class="edit-main">
        <div class="edit-stage">
          <ModelViewer
            v-if="bytes"
            ref="viewer"
            :bytes="bytes"
            :format="model?.format"
            :auto-rotate="display.autoRotate"
            :show-grid="display.showGrid"
            :show-skeleton="display.showSkeleton"
            :gizmo-mode="gizmoMode"
            :freeze-mesh="display.freezeMesh"
            @parsed="handleParsed"
            @semantics="handleSemantics"
            @edit-state="handleEditState"
            @history-state="handleHistoryState"
            @bone-transform="handleBoneTransform"
            @select-bone="handleViewportBone"
            @select-bones="handleSelectBones"
            @freeze-state="handleFreezeState"
            @error="errorText = $event"
          />
          <div v-else v-loading="loading" class="edit-stage__placeholder">
            <span v-if="!loading">{{ errorText || '加载中…' }}</span>
          </div>

          <div class="stage-tools">
            <div class="stage-tools__group">
              <el-tooltip content="重置视角" placement="top">
                <el-button size="small" :icon="FullScreen" @click="viewer?.resetView()" />
              </el-tooltip>
              <el-tooltip content="聚焦选中 (F)" placement="top">
                <el-button size="small" :icon="Aim" :disabled="!selectedBoneId" @click="selectedBoneId && viewer?.focusNode(selectedBoneId)" />
              </el-tooltip>
            </div>
            <div class="stage-tools__group">
              <el-tooltip content="冻结选中的骨骼：动作播放时它们保持不动" placement="top">
                <el-button
                  size="small"
                  :type="allSelectedFrozen ? 'primary' : 'default'"
                  :disabled="selectedBoneIds.length === 0"
                  @click="toggleFreezeSelected"
                >
                  {{ allSelectedFrozen ? '解冻' : '❄ 冻结' }}{{ selectedBoneIds.length ? ` ${selectedFrozenCount}/${selectedBoneIds.length}` : '' }}
                </el-button>
              </el-tooltip>
              <span v-if="frozenBoneIds.length" class="stage-tools__label">冷冻 {{ frozenBoneIds.length }}</span>
            </div>
            <div class="stage-tools__group">
              <el-tooltip content="框选模式：直接拖拽框选骨骼（也可按住 Shift 拖拽）" placement="top">
                <el-button
                  size="small"
                  :type="boxSelectMode ? 'primary' : 'default'"
                  @click="toggleBoxSelectMode"
                >
                  框选
                </el-button>
              </el-tooltip>
            </div>
            <div class="stage-tools__group">
              <span class="stage-tools__label">工具</span>
              <el-radio-group v-model="gizmoMode" size="small">
                <el-radio-button value="rotate">旋转 W</el-radio-button>
                <el-radio-button value="translate">移动 E</el-radio-button>
                <el-radio-button value="scale">缩放 R</el-radio-button>
                <el-radio-button value="off">关闭</el-radio-button>
              </el-radio-group>
            </div>
          </div>
        </div>

        <div class="timeline">
          <el-button circle size="small" :icon="playing ? VideoPause : VideoPlay" :disabled="!editing" @click="togglePlay" />
          <el-button circle size="small" :icon="RefreshLeft" :disabled="!editing" @click="seek(0)" />
          <el-tooltip content="上一帧 ←" placement="top">
            <el-button circle size="small" :icon="ArrowLeft" :disabled="!editing" @click="step(-1)" />
          </el-tooltip>
          <el-tooltip content="下一帧 →" placement="top">
            <el-button circle size="small" :icon="ArrowRight" :disabled="!editing" @click="step(1)" />
          </el-tooltip>

          <div class="timeline__track">
            <el-slider
              :model-value="editState?.time ?? 0"
              :max="editState?.duration || 1"
              :step="1 / fps"
              :show-tooltip="false"
              :disabled="!editing"
              @input="(value: number | number[]) => seek(Array.isArray(value) ? value[0] : value)"
            />
            <div class="timeline__keys">
              <span
                v-for="time in boneKeys"
                :key="time"
                class="timeline__key"
                :class="{ 'is-current': Math.abs(time - (editState?.time ?? 0)) < 0.5 / fps }"
                :style="{ left: `${Math.min(100, (time / Math.max(editState?.duration ?? 1, 0.001)) * 100)}%` }"
                :title="`${time.toFixed(2)}s`"
              />
            </div>
          </div>

          <span class="timeline__time num">
            {{ frame.current }} / {{ frame.total }} 帧 · {{ (editState?.time ?? 0).toFixed(2) }}s
          </span>
        </div>
      </section>

      <!-- 右：当前骨骼 + 关键帧 -->
      <aside class="edit-panel edit-inspector">
        <div class="edit-panel__head">
          <span>当前骨骼</span>
          <span v-if="selectedBone" class="edit-panel__sub">{{ selectedBone.name }}</span>
        </div>

        <template v-if="selectedBone">
          <div class="edit-info">
            <div class="edit-info__row">
              <span>名称</span>
              <span class="mono edit-info__value" :title="selectedBone.name">{{ selectedBone.name }}</span>
            </div>
            <div class="edit-info__row">
              <span>角色</span>
              <el-tag v-if="selectedRole" size="small" effect="light" type="success">{{ selectedRole }}</el-tag>
              <span v-else class="edit-info__value text-muted">未识别</span>
            </div>
            <div class="edit-info__row">
              <span>层级</span>
              <span class="num edit-info__value">第 {{ selectedBone.depth + 1 }} 层</span>
            </div>
            <div class="edit-info__row">
              <span>子骨骼</span>
              <span class="num edit-info__value">{{ selectedBone.childCount }}</span>
            </div>
          </div>
          <div class="edit-vec">
            <span class="edit-vec__label">位置</span>
            <el-input
              v-for="axis in POSITION_AXES"
              :key="`p-${axis}`"
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
              :key="`r-${axis}`"
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
        </template>
        <template v-else-if="multiSelected">
          <div class="edit-info">
            <div class="edit-info__row">
              <span>已选骨骼</span>
              <span class="num edit-info__value">{{ selectedBoneIds.length }} 根</span>
            </div>
            <div class="edit-info__row">
              <span>已冻结</span>
              <span class="num edit-info__value">{{ selectedFrozenCount }} 根</span>
            </div>
          </div>
          <div class="edit-bone-names">
            <span v-for="name in selectedNames" :key="name" class="edit-bone-name">{{ name }}</span>
          </div>
          <p class="edit-empty">Shift + 拖拽可继续框选；冻结按钮在视口左下角工具条里</p>
        </template>
        <p v-else class="edit-empty">在视口里点关节球选中骨骼，选中后这里显示属性和关键帧</p>

        <template v-if="!multiSelected">
          <div class="edit-panel__head">
            关键帧
            <span class="edit-panel__sub">{{ boneKeys.length }} 个</span>
          </div>
          <div class="edit-actions">
            <el-button size="small" type="primary" plain :disabled="!editing" @click="recordKey">记关键帧 K</el-button>
            <el-button size="small" :disabled="!editing" @click="recordAll">记整帧</el-button>
            <el-button size="small" :disabled="!editing" @click="removeKey">删关键帧</el-button>
          </div>
          <div class="edit-key-list">
            <button
              v-for="time in boneKeys"
              :key="time"
              type="button"
              class="edit-key"
              :class="{ 'is-current': Math.abs(time - (editState?.time ?? 0)) < 0.5 / fps }"
              @click="seek(time)"
            >
              {{ Math.round(time * fps) }} 帧
            </button>
            <p v-if="boneKeys.length === 0" class="edit-empty">这根骨骼还没有关键帧</p>
          </div>
        </template>

        <div class="edit-quick">
          <button type="button" class="edit-quick__head" @click="quickOpen = !quickOpen">
            <span class="edit-quick__caret">{{ quickOpen ? '▾' : '▸' }}</span>
            <span>快捷姿态</span>
            <span class="edit-panel__sub">{{ QUICK_POSES.length + 1 }}</span>
          </button>
          <template v-if="quickOpen">
            <div class="edit-quick__grid">
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
            <div v-if="quickAction" class="edit-quick__amount">
              <div class="edit-quick__amount-head">
                <span>{{ quickActionLabel }}</span>
                <span class="num">{{ quickAmount }}°</span>
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
              <el-button size="small" @click="finishQuickPose">完成</el-button>
            </div>
            <p class="edit-hint">
              {{ quickAction ? '拖滑杆调程度，点「完成」收起；再用「记整帧」把这一帧写成关键帧' : '点一个动作调整姿势；调整后点「记整帧」把这些骨骼写成当前帧关键帧' }}
            </p>
          </template>
        </div>

        <p class="edit-hint">
          共 {{ editState?.keyCount ?? 0 }} 个关键帧 · ←/→ 逐帧 · K 记帧 · 空格播放 · W/E/R 切工具
        </p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.edit-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 10px;
}

.edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
}

.edit-head__left,
.edit-head__right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.edit-head__sep {
  width: 1px;
  height: 18px;
  background: var(--border-color);
}

.edit-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.edit-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  overflow-x: hidden;
  overflow-y: auto;
}

.edit-panel__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
  flex: none;
}

.edit-panel__sub {
  margin-left: auto;
  font-weight: 400;
  color: var(--text-secondary);
  font-size: 11px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edit-key-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.edit-quick {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color);
  flex: none;
}

.edit-quick__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  text-align: left;
}

.edit-quick__head:hover {
  color: var(--text-secondary);
}

.edit-quick__caret {
  width: 10px;
  font-size: 10px;
}

.edit-quick__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.edit-quick__grid :deep(.el-button) {
  margin-left: 0;
  padding: 0 6px;
  font-size: 11.5px;
  height: 26px;
}

.edit-quick__amount {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}

.edit-quick__amount-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.edit-quick__amount :deep(.el-slider) {
  padding: 0 4px;
}

.edit-quick__amount :deep(.el-button) {
  align-self: flex-end;
  margin-left: 0;
}

.edit-bone-names {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
}

.edit-bone-name {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 10.5px;
  font-family: var(--font-mono, monospace);
}

.edit-info {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  flex: none;
}

.edit-info__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.edit-info__value {
  color: var(--text-primary);
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edit-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.edit-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  overflow: hidden;
  background: #0b1220;
}

.edit-stage__placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  color: #94a3b8;
  font-size: 12px;
}

.timeline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
}

.timeline__track {
  position: relative;
  flex: 1;
  min-width: 0;
  padding-bottom: 10px;
}

.timeline__track :deep(.el-slider) {
  margin: 0 8px;
}

.timeline__keys {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 8px;
}

.timeline__key {
  position: absolute;
  bottom: 0;
  width: 6px;
  height: 6px;
  margin-left: -3px;
  border-radius: 1px;
  background: var(--accent);
  transform: rotate(45deg);
}

.timeline__key.is-current {
  background: var(--warning, #f59e0b);
}

.timeline__time {
  flex: none;
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

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

.edit-vec {
  display: grid;
  grid-template-columns: 34px repeat(3, minmax(0, 1fr));
  gap: 4px;
  align-items: center;
  flex: none;
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

.edit-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.edit-actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
  padding: 0 4px;
}

.edit-key {
  padding: 3px 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.edit-key.is-current {
  border-color: var(--warning, #f59e0b);
  color: var(--warning, #f59e0b);
}

.edit-empty {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

.edit-hint {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-tertiary);
  line-height: 1.6;
  flex: none;
}
</style>
