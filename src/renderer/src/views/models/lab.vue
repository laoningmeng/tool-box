<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Aim,
  Brush,
  Camera,
  Delete,
  Download,
  FolderOpened,
  FullScreen,
  Grid,
  Hide,
  RefreshLeft,
  RefreshRight,
  Search,
  Share,
  VideoPause,
  VideoPlay,
  View,
  Box
} from '@element-plus/icons-vue'
import type { ModelAsset, ModelPartGroup } from '@shared/types'
import { MODEL_SOURCE_META } from '@shared/constants'
import { useModelStore } from '@renderer/stores/models'
import { useAppStore } from '@renderer/stores/app'
import { formatBytes, formatDateTime } from '@renderer/utils/format'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import type { SemanticSummary, ViewerStructure } from '@renderer/components/model-viewer-types'
import { ACTION_LIBRARY } from '@renderer/rig/actions'
import type { ActionKind } from '@renderer/rig/types'

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

const display = reactive({
  autoRotate: true,
  showGrid: true,
  wireframe: false,
  showSkeleton: true,
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

const parts = computed(() => (structure.value?.parts ?? []).filter((item) => match(item.name)))
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
const gizmoMode = ref<'rotate' | 'translate' | 'off'>('rotate')
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

// 离开实验台时自动退出全屏/沉浸，避免侧栏被藏起来后没地方点回来
onBeforeUnmount(() => {
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

function selectBone(id: string): void {
  selectedId.value = id
  selectedKind.value = 'bone'
  viewer.value?.selectNode(id)
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
  if (!hasPlayable.value) return
  viewer.value?.seekClip(0)
  clipTime.value = 0
}

function handleSeek(value: number | number[]): void {
  const time = Array.isArray(value) ? value[0] : value
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

    <div class="lab">
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
              class="tree-row"
              :class="{
                'is-active': selectedId === part.id,
                'is-checked': selectedKeys.includes(part.key),
                'is-hidden': hiddenParts.has(part.id)
              }"
              :style="{ paddingLeft: `${8 + part.depth * 12}px` }"
              @click="onPartClick(part, index, $event)"
              @dblclick="viewer?.focusNode(part.id)"
            >
              <el-button
                class="tree-row__eye"
                link
                size="small"
                :icon="hiddenParts.has(part.id) ? Hide : View"
                @click.stop="togglePartVisible(part.id)"
              />
              <el-icon class="tree-row__icon"><Box /></el-icon>
              <span class="tree-row__name" :title="part.name">{{ part.name }}</span>
              <span class="tree-row__meta num">{{ part.triangles.toLocaleString('zh-CN') }}</span>
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
            @parsed="handleParsed"
            @semantics="handleSemantics"
            @tick="handleTick"
            @bone-transform="handleBoneTransform"
            @error="errorText = $event"
          />
          <div v-else v-loading="loading" class="lab__placeholder">
            <span v-if="!loading">{{ errorText || '加载中…' }}</span>
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

      <!-- 右：动作 + 信息 -->
      <aside class="lab__panel lab__inspector">
        <section class="block">
          <h3 class="block__title">动作 <span class="block__count">{{ clips.length }}</span></h3>
          <div v-if="clips.length" class="clip-list">
            <button
              v-for="clip in clips"
              :key="clip.index"
              type="button"
              class="clip"
              :class="{ 'is-active': !libraryKind && clipIndex === clip.index }"
              @click="playClip(clip.index)"
            >
              <el-icon class="clip__icon"><VideoPlay /></el-icon>
              <span class="clip__name" :title="clip.name">{{ clip.name }}</span>
              <span class="clip__time num">{{ clip.duration.toFixed(2) }}s</span>
            </button>
          </div>
          <p v-else class="block__empty">该模型没有内置动作</p>
        </section>

        <section class="block">
          <h3 class="block__title">
            动作库 <span class="block__count">{{ libraryDefs.length }}</span>
          </h3>
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
        </section>

        <section v-if="tab === 'parts' || groups.length > 0" class="block">
          <h3 class="block__title">
            分组 <span class="block__count">{{ groups.length }}</span>
            <el-button
              class="block__action"
              type="primary"
              size="small"
              :loading="savingGroup"
              :disabled="selectedKeys.length === 0"
              @click="handleSaveGroup"
            >
              保存为分组
            </el-button>
          </h3>
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
        </section>

        <section class="block">
          <h3 class="block__title">
            选中
            <el-button
              v-if="selectedId"
              type="primary"
              plain
              size="small"
              class="block__action"
              :icon="Aim"
              @click="focusSelected"
            >
              聚焦
            </el-button>
          </h3>
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
        </section>

        <section v-if="selectedBoneId" class="block">
          <h3 class="block__title">编辑骨骼</h3>
          <el-radio-group v-model="gizmoMode" size="small" class="edit-modes">
            <el-radio-button value="rotate">旋转</el-radio-button>
            <el-radio-button value="translate">移动</el-radio-button>
            <el-radio-button value="off">关闭</el-radio-button>
          </el-radio-group>

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
          <p class="block__hint">拖动手柄或直接改数值；编辑时会暂停当前动作</p>
        </section>

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
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  flex: none;
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
  width: 90px;
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
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: #0b1220;
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
  padding: 12px;
  gap: 16px;
  overflow-y: auto;
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
