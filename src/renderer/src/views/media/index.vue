<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Check,
  Delete,
  Download,
  Files,
  Headset,
  Picture,
  Refresh,
  RefreshRight,
  VideoCamera
} from '@element-plus/icons-vue'
import { WORKFLOW_CATEGORY_META } from '@shared/constants'
import type {
  ComfyOutputFile,
  MediaBatch,
  MediaItem,
  MediaKind,
  PsdLayer,
  WorkflowCategory
} from '@shared/types'

/** 媒体库：工作流生成的图片 / 视频 / 音频都会汇总到这里 */
const items = ref<MediaItem[]>([])
const loading = ref(false)
const syncing = ref(false)
const activeType = ref<MediaTab>('all')
const previews = ref<Record<string, string>>({})
const previewErrors = ref<Record<string, boolean>>({})
const selectedIds = ref<string[]>([])
const removing = ref(false)

const selectedSet = computed(() => new Set(selectedIds.value))

type MediaTab = MediaKind | 'all' | 'batch'

const tabs: Array<{ value: MediaTab; label: string; icon: unknown }> = [
  { value: 'all', label: '全部', icon: Picture },
  { value: 'image', label: '图片', icon: Picture },
  { value: 'video', label: '视频', icon: VideoCamera },
  { value: 'audio', label: '音频', icon: Headset },
  { value: 'batch', label: '拆分结果', icon: Files }
]

const batches = ref<MediaBatch[]>([])
const batchCovers = ref<Record<string, string>>({})
const batchDialogVisible = ref(false)
const batchDialogItem = ref<MediaBatch | null>(null)
const psdFiles = ref<ComfyOutputFile[]>([])
const psdDir = ref('')
const psdHint = ref('')
const psdLoading = ref(false)
const psdError = ref('')
const psdLayers = ref<PsdLayer[]>([])
const hideEmptyLayers = ref(true)

const visiblePsdLayers = computed(() =>
  hideEmptyLayers.value ? psdLayers.value.filter((layer) => layer.coverage > 0.002) : psdLayers.value
)
const emptyLayerCount = computed(() => psdLayers.value.filter((layer) => layer.coverage <= 0.002).length)
const psdSource = ref<{ filename: string; subfolder: string } | null>(null)
const layerPreviewVisible = ref(false)
const layerPreviewLoading = ref(false)
const layerPreviewName = ref('')
const layerPreviewDataUrl = ref('')
const layerPreviewSize = ref({ width: 0, height: 0 })

const layerPreviewStyle = computed(() => {
  const { width, height } = layerPreviewSize.value
  if (!width || !height) return {}
  // 小图层（眼睛、鼻嘴等）先放大到至少 320px，再整体收进对话框
  const minW = 320
  const maxW = 620
  const maxH = 460
  let scale = Math.max(width, height) < minW ? Math.max(1, Math.round(minW / Math.max(width, height))) : 1
  let displayW = width * scale
  let displayH = height * scale
  const fit = Math.min(1, maxW / displayW, maxH / displayH)
  displayW = Math.round(displayW * fit)
  displayH = Math.round(displayH * fit)
  return {
    width: `${displayW}px`,
    height: `${displayH}px`,
    imageRendering: (scale > 1 ? 'pixelated' : 'auto') as 'pixelated' | 'auto'
  }
})

const counts = computed(() => {
  const map: Record<string, number> = { all: items.value.length, image: 0, video: 0, audio: 0, batch: batches.value.length }
  for (const item of items.value) map[item.type] = (map[item.type] ?? 0) + 1
  return map
})

const filtered = computed(() =>
  activeType.value === 'all' ? items.value : items.value.filter((item) => item.type === activeType.value)
)

function formatTime(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (num: number): string => String(num).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function categoryLabel(item: MediaItem): string {
  if (!item.category) return 'ComfyUI'
  return WORKFLOW_CATEGORY_META[item.category as WorkflowCategory]?.label ?? item.category
}

const TYPE_LABELS: Record<MediaKind, string> = { image: '图片', video: '视频', audio: '音频' }

async function loadPreview(item: MediaItem): Promise<void> {
  if (previews.value[item.id]) return
  try {
    const data = await window.api.comfy.output(item.filename, item.subfolder, item.storage || 'output')
    previews.value = { ...previews.value, [item.id]: data.dataUrl }
  } catch {
    previewErrors.value = { ...previewErrors.value, [item.id]: true }
  }
}

async function refresh(sync = false): Promise<void> {
  if (sync) syncing.value = true
  loading.value = true
  try {
    if (sync) {
      const result = await window.api.media.sync()
      if (result.error) ElMessage.warning(`同步失败：${result.error}`)
      else ElMessage.success(result.added > 0 ? `已从 ComfyUI 补录 ${result.added} 个结果` : '没有新的结果')
    }
    items.value = await window.api.media.list()
    for (const item of items.value.slice(0, 60)) void loadPreview(item)
    await refreshBatches()
  } catch (error) {
    ElMessage.error(`加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
    syncing.value = false
  }
}

function toggleSelect(item: MediaItem): void {
  selectedIds.value = selectedSet.value.has(item.id)
    ? selectedIds.value.filter((id) => id !== item.id)
    : [...selectedIds.value, item.id]
}

function isSelected(item: MediaItem): boolean {
  return selectedSet.value.has(item.id)
}

const allSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((item) => selectedSet.value.has(item.id))
)

function toggleSelectAll(): void {
  if (allSelected.value) {
    const visible = new Set(filtered.value.map((item) => item.id))
    selectedIds.value = selectedIds.value.filter((id) => !visible.has(id))
  } else {
    selectedIds.value = [...new Set([...selectedIds.value, ...filtered.value.map((item) => item.id)])]
  }
}

function clearSelection(): void {
  selectedIds.value = []
}

async function removeSelected(): Promise<void> {
  if (selectedIds.value.length === 0) return
  try {
    await ElMessageBox.confirm(
      `删除选中的 ${selectedIds.value.length} 条记录？ComfyUI 里的原文件不会被删除。`,
      '批量移除',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  removing.value = true
  try {
    // 传普通数组：Vue 的响应式代理不能过 IPC 的结构化克隆
    const result = await window.api.media.removeMany([...selectedIds.value])
    selectedIds.value = []
    await refresh()
    ElMessage.success(`已移除 ${result.removed} 条记录`)
  } catch (error) {
    ElMessage.error(`移除失败：${(error as Error).message}`)
  } finally {
    removing.value = false
  }
}

async function handleRemove(item: MediaItem): Promise<void> {
  try {
    await ElMessageBox.confirm('从媒体库移除这条记录？ComfyUI 里的文件不会被删除。', '移除记录', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await window.api.media.remove(item.id)
  if (result.ok) {
    selectedIds.value = selectedIds.value.filter((id) => id !== item.id)
    await refresh()
    ElMessage.success('已移除记录')
  }
}

/* ------------------------------ 角色拆分批次 ------------------------------ */

const LAYER_STORAGE = (layer: { storage?: string }): string => layer.storage || 'temp'

async function loadBatchCover(batch: MediaBatch): Promise<void> {
  if (!batch.cover || batchCovers.value[batch.id]) return
  try {
    const data = await window.api.comfy.output(
      batch.cover.filename,
      batch.cover.subfolder,
      batch.cover.storage || 'output'
    )
    batchCovers.value = { ...batchCovers.value, [batch.id]: data.dataUrl }
  } catch {
    /* 封面失败不影响列表 */
  }
}

async function refreshBatches(): Promise<void> {
  batches.value = await window.api.media.batches()
  for (const batch of batches.value.slice(0, 20)) void loadBatchCover(batch)
}

async function openBatch(batch: MediaBatch): Promise<void> {
  batchDialogItem.value = batch
  batchDialogVisible.value = true
  psdFiles.value = []
  psdHint.value = ''
  psdLayers.value = []
  psdError.value = ''
  psdSource.value = null
  psdLoading.value = false
  void loadPsdFiles(batch)
}

async function loadPsdFiles(batch: MediaBatch): Promise<void> {
  try {
    const created = new Date(batch.createdAt).getTime() / 1000
    const result = await window.api.comfy.outputFiles('psd', created - 300)
    psdDir.value = result.dir
    // 只保留这次拆分前后一段时间内的 PSD，避免把历史文件都列出来
    psdFiles.value = result.files.filter((item) => item.mtime >= created - 300 && item.mtime <= created + 900)
    if (!psdFiles.value.length) {
      psdHint.value = result.dir ? '没有发现本次拆分产出的 PSD' : result.reason || '没找到 ComfyUI 输出目录'
      return
    }
    // 主 PSD（不带 _depth 的那个）拿来做图层预览
    const main = psdFiles.value.find((file) => !/_depth\b/i.test(file.filename)) ?? psdFiles.value[0]
    if (main) void loadPsdLayers(main.filename, main.subfolder || '')
  } catch (error) {
    psdHint.value = `读取 PSD 失败：${(error as Error).message}`
  }
}

async function loadPsdLayers(filename: string, subfolder: string): Promise<void> {
  psdSource.value = { filename, subfolder }
  psdLoading.value = true
  psdError.value = ''
  try {
    const sheet = await window.api.comfy.psdLayers(filename, subfolder, 160)
    psdLayers.value = sheet.layers
    if (!sheet.layers.length) psdError.value = 'PSD 里没有图层'
  } catch (error) {
    psdError.value = `解析 PSD 失败：${(error as Error).message}`
  } finally {
    psdLoading.value = false
  }
}

async function openLayer(layer: PsdLayer): Promise<void> {
  const source = psdSource.value
  if (!source) return
  layerPreviewVisible.value = true
  layerPreviewLoading.value = true
  layerPreviewName.value = layer.name
  layerPreviewDataUrl.value = ''
  try {
    const image = await window.api.comfy.psdLayerImage(source.filename, source.subfolder, layer.index)
    layerPreviewDataUrl.value = image.dataUrl
    layerPreviewSize.value = { width: image.width, height: image.height }
  } catch (error) {
    ElMessage.error(`读取图层失败：${(error as Error).message}`)
    layerPreviewVisible.value = false
  } finally {
    layerPreviewLoading.value = false
  }
}

function downloadLayerImage(): void {
  if (!layerPreviewDataUrl.value) return
  const link = document.createElement('a')
  link.href = layerPreviewDataUrl.value
  link.download = `${layerPreviewName.value || 'layer'}.png`
  link.click()
}

async function downloadFile(filename: string, subfolder: string, storage: string): Promise<void> {
  try {
    const data = await window.api.comfy.output(filename, subfolder, storage)
    const link = document.createElement('a')
    link.href = data.dataUrl
    link.download = filename
    link.click()
  } catch (error) {
    ElMessage.error(`下载失败：${(error as Error).message}`)
  }
}

async function removeBatch(batch: MediaBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除这次拆分结果（${batch.layers.length} 层）？ComfyUI 里的原文件不会被删除。`, '删除拆分结果', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await window.api.media.removeBatch(batch.id)
  if (result.ok) {
    ElMessage.success('已删除')
    batchDialogVisible.value = false
    await refreshBatches()
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function download(item: MediaItem): void {
  const dataUrl = previews.value[item.id]
  if (!dataUrl) {
    ElMessage.warning('预览还没加载好，稍后再试')
    return
  }
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = item.filename
  link.click()
}

/* ------------------------------ 大图查看 ------------------------------ */

const viewerVisible = ref(false)
const viewerId = ref('')

const imageItems = computed(() => filtered.value.filter((item) => item.type === 'image'))
const viewerItem = computed(() => imageItems.value.find((item) => item.id === viewerId.value) ?? null)

async function openViewer(item: MediaItem): Promise<void> {
  if (item.type !== 'image') return
  await loadPreview(item)
  if (!previews.value[item.id]) {
    ElMessage.warning('图片还在加载，稍后再试')
    return
  }
  resetViewerTransform()
  viewerId.value = item.id
  viewerVisible.value = true
}

/* ------------------------------ 大图缩放 / 拖拽 ------------------------------ */

const viewerScale = ref(1)
const viewerOffset = ref({ x: 0, y: 0 })
const panning = ref(false)
const panStart = ref({ x: 0, y: 0, ox: 0, oy: 0 })
const viewerEl = ref<HTMLElement | null>(null)

const MIN_SCALE = 0.2
const MAX_SCALE = 8

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function setScale(next: number, anchorX?: number, anchorY?: number): void {
  const scale = clamp(next, MIN_SCALE, MAX_SCALE)
  const ratio = scale / viewerScale.value
  if (anchorX !== undefined && anchorY !== undefined) {
    // 以鼠标位置为锚点缩放：偏移按比例反向补偿
    viewerOffset.value = {
      x: viewerOffset.value.x * ratio + anchorX * (1 - ratio),
      y: viewerOffset.value.y * ratio + anchorY * (1 - ratio)
    }
  }
  viewerScale.value = scale
}

function onViewerWheel(event: WheelEvent): void {
  const el = viewerEl.value
  if (!el) return
  event.preventDefault()
  const rect = el.getBoundingClientRect()
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
  setScale(
    viewerScale.value * factor,
    event.clientX - rect.left - rect.width / 2,
    event.clientY - rect.top - rect.height / 2
  )
}

function onPanStart(event: PointerEvent): void {
  if (event.button !== 0) return
  const el = viewerEl.value
  panning.value = true
  panStart.value = { x: event.clientX, y: event.clientY, ox: viewerOffset.value.x, oy: viewerOffset.value.y }
  // 捕获指针：拖到窗口外也不会中断
  el?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function onPanMove(event: PointerEvent): void {
  if (!panning.value) return
  viewerOffset.value = {
    x: panStart.value.ox + (event.clientX - panStart.value.x),
    y: panStart.value.oy + (event.clientY - panStart.value.y)
  }
}

function onPanEnd(event?: PointerEvent): void {
  if (!panning.value) return
  panning.value = false
  const el = viewerEl.value
  if (event && el?.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
}

function resetViewerTransform(): void {
  viewerScale.value = 1
  viewerOffset.value = { x: 0, y: 0 }
  panning.value = false
}

async function stepViewer(delta: number): Promise<void> {
  const list = imageItems.value
  const index = list.findIndex((item) => item.id === viewerId.value)
  if (index < 0) return
  const next = list[(index + delta + list.length) % list.length]
  if (!next) return
  await loadPreview(next)
  resetViewerTransform()
  viewerId.value = next.id
}

function onViewerKey(event: KeyboardEvent): void {
  if (!viewerVisible.value) return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    void stepViewer(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    void stepViewer(1)
  }
}

onMounted(async () => {
  // 打开页面先静默同步一次 ComfyUI 历史，历史作品也能出现在媒体库
  try {
    await window.api.media.sync()
  } catch {
    /* 同步失败不阻塞页面 */
  }
  await refresh()
  window.addEventListener('keydown', onViewerKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onViewerKey)
})
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">媒体库</h1>
        <p class="page-desc">
          工作流生成的结果都汇总在这里：图片 / 视频 / 音频按类型筛选，可下载或移除记录（不删 ComfyUI 里的原文件）。
        </p>
      </div>
      <div class="page-actions">
        <el-button :icon="Refresh" :loading="loading && !syncing" @click="refresh()">刷新</el-button>
        <el-button type="primary" :icon="RefreshRight" :loading="syncing" @click="refresh(true)">
          同步 ComfyUI 历史
        </el-button>
      </div>
    </header>

    <section class="panel">
      <header class="panel__head">
        <div class="tabs">
          <button
            v-for="tab in tabs"
            :key="tab.value"
            type="button"
            class="tab"
            :class="{ 'is-active': activeType === tab.value }"
            @click="activeType = tab.value"
          >
            {{ tab.label }} {{ counts[tab.value] ?? 0 }}
          </button>
        </div>
        <div class="list-bar">
          <span class="text-muted">
            {{ activeType === 'batch' ? `${batches.length} 次拆分` : `${items.length} 个结果` }}
          </span>
          <template v-if="activeType !== 'batch' && filtered.length">
            <el-button size="small" @click="toggleSelectAll">
              {{ allSelected ? '取消全选' : '全选' }}
            </el-button>
            <el-button
              v-if="selectedIds.length"
              size="small"
              type="danger"
              plain
              :icon="Delete"
              :loading="removing"
              @click="removeSelected"
            >
              删除所选 {{ selectedIds.length }}
            </el-button>
            <el-button v-if="selectedIds.length" size="small" link @click="clearSelection">清空选择</el-button>
          </template>
        </div>
      </header>

      <div class="panel__body">
        <template v-if="activeType === 'batch'">
          <el-empty
            v-if="!batches.length"
            description="还没有拆分结果：去「执行流程」跑一次「角色拆分 · SeeThrough」，图层会自动归成一个批次"
          />
          <div v-else class="media-grid">
            <article
              v-for="batch in batches"
              :key="batch.id"
              class="media-card batch-card"
              @click="openBatch(batch)"
            >
              <div class="media-card__preview">
                <img
                  v-if="batchCovers[batch.id]"
                  :src="batchCovers[batch.id]"
                  :alt="batch.workflowName"
                  class="media-card__image"
                  loading="lazy"
                />
                <div v-else class="batch-card__empty">拆分结果</div>
                <span class="batch-card__badge">{{ batch.layers.length }} 层</span>
              </div>
              <div class="media-card__body">
                <strong class="media-card__name mono">{{ batch.workflowName || '角色拆分' }}</strong>
                <span class="media-card__time num">{{ formatTime(batch.createdAt) }}</span>
                <div class="media-card__actions" @click.stop>
                  <el-button link type="primary" size="small" @click="openBatch(batch)">查看图层</el-button>
                  <el-button link type="danger" size="small" :icon="Delete" @click="removeBatch(batch)">删除</el-button>
                </div>
              </div>
            </article>
          </div>
        </template>
        <template v-else>
          <el-empty v-if="!filtered.length" description="还没有生成结果，去「执行流程」页跑一个工作流吧" />
          <div v-else class="media-grid">
          <article
            v-for="item in filtered"
            :key="item.id"
            class="media-card"
            :class="{ 'is-selected': isSelected(item) }"
          >
            <div class="media-card__preview">
              <button
                type="button"
                class="media-card__check"
                :class="{ 'is-checked': isSelected(item) }"
                :title="isSelected(item) ? '取消选择' : '选择'"
                @click.stop="toggleSelect(item)"
              >
                <el-icon v-if="isSelected(item)"><Check /></el-icon>
              </button>
              <img
                v-if="item.type === 'image' && previews[item.id]"
                :src="previews[item.id]"
                :alt="item.filename"
                class="media-card__image"
                loading="lazy"
                title="点击查看大图"
                @load="() => loadPreview(item)"
                @click="openViewer(item)"
              />
              <video
                v-else-if="item.type === 'video'"
                :src="previews[item.id]"
                controls
                preload="metadata"
                @loadeddata="() => loadPreview(item)"
              />
              <audio v-else-if="item.type === 'audio'" :src="previews[item.id] || ''" controls />
              <div v-else class="media-card__placeholder">
                <el-icon><Picture /></el-icon>
                <span>{{ previewErrors[item.id] ? '预览加载失败' : '加载中…' }}</span>
              </div>
              <span class="media-card__type">{{ TYPE_LABELS[item.type] }}</span>
            </div>
            <div class="media-card__body">
              <span class="media-card__name mono" :title="item.filename">{{ item.filename }}</span>
              <div class="media-card__meta">
                <span>{{ formatTime(item.createdAt) }}</span>
                <span v-if="item.workflowName" class="media-card__wf" :title="item.workflowName">
                  {{ item.workflowName }}
                </span>
                <span v-else class="media-card__wf">{{ categoryLabel(item) }}</span>
              </div>
              <div class="media-card__actions">
                <el-button link type="primary" size="small" :icon="Download" @click="download(item)">下载</el-button>
                <el-button link type="danger" size="small" :icon="Delete" @click="handleRemove(item)">移除</el-button>
              </div>
            </div>
          </article>
          </div>
        </template>
      </div>
    </section>

    <!-- 拆分结果：图层 + PSD -->
    <el-dialog v-model="batchDialogVisible" title="拆分结果" width="860px" append-to-body>
      <template v-if="batchDialogItem">
        <div class="batch-head">
          <strong>{{ batchDialogItem.workflowName || '角色拆分' }}</strong>
          <span class="text-muted">
            {{ batchDialogItem.layers.length }} 个图层 · {{ formatTime(batchDialogItem.createdAt) }}
          </span>
        </div>
        <div class="psd-layers">
          <div class="psd-layers__head">
            <strong>PSD 图层</strong>
            <div class="psd-layers__meta">
              <span class="text-muted">
                {{ psdLoading ? '解析中…' : psdLayers.length ? `${visiblePsdLayers.length}/${psdLayers.length} 层 · 点击看大图` : psdError || '—' }}
              </span>
              <el-checkbox v-if="emptyLayerCount" v-model="hideEmptyLayers" size="small" label="隐藏空图层" />
            </div>
          </div>
          <div v-if="visiblePsdLayers.length" v-loading="psdLoading" class="layer-grid">
            <button
              v-for="layer in visiblePsdLayers"
              :key="layer.index"
              type="button"
              class="layer-tile"
              :title="`${layer.name}（${layer.width}×${layer.height}）`"
              @click="openLayer(layer)"
            >
              <span class="layer-tile__img">
                <img v-if="layer.thumb" :src="layer.thumb" :alt="layer.name" />
                <span v-else class="layer-tile__empty">空</span>
              </span>
              <span class="layer-tile__name">{{ layer.name }}</span>
            </button>
          </div>
          <div v-else-if="psdLoading" v-loading="psdLoading" class="layer-loading" />
          <div v-else class="layer-hint">这次拆分没有非空图层（可关闭「隐藏空图层」查看全部）</div>
        </div>
        <div class="psd-block">
          <div class="psd-block__head">
            <strong>PSD 文件</strong>
            <span class="text-muted">{{ psdFiles.length ? `${psdFiles.length} 个` : psdHint }}</span>
          </div>
          <div v-if="psdFiles.length" class="psd-list">
            <div v-for="file in psdFiles" :key="file.filename" class="psd-row">
              <span class="mono">{{ file.filename }}</span>
              <span class="text-muted num">{{ formatBytes(file.bytes) }}</span>
              <el-button
                link
                type="primary"
                size="small"
                @click="downloadFile(file.filename, file.subfolder || '', 'output')"
              >
                下载
              </el-button>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button @click="batchDialogVisible = false">关闭</el-button>
        <el-button v-if="batchDialogItem" type="danger" plain @click="removeBatch(batchDialogItem)">
          删除这次结果
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="layerPreviewVisible" :title="layerPreviewName" width="720px" append-to-body>
      <div v-loading="layerPreviewLoading" class="layer-preview">
        <img
          v-if="layerPreviewDataUrl"
          :src="layerPreviewDataUrl"
          :alt="layerPreviewName"
          :style="layerPreviewStyle"
        />
      </div>
      <template #footer>
        <el-button @click="layerPreviewVisible = false">关闭</el-button>
        <el-button type="primary" :icon="Download" :disabled="!layerPreviewDataUrl" @click="downloadLayerImage">
          下载 PNG
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="viewerVisible"
      :title="viewerItem?.filename"
      width="82%"
      top="4vh"
      append-to-body
      class="media-viewer"
      @closed="resetViewerTransform"
    >
      <div
        v-if="viewerItem && previews[viewerItem.id]"
        ref="viewerEl"
        class="viewer"
        :class="{ 'is-panning': panning }"
        @wheel.prevent="onViewerWheel"
        @pointerdown="onPanStart"
        @pointermove="onPanMove"
        @pointerup="onPanEnd"
        @pointercancel="onPanEnd"
        @lostpointercapture="onPanEnd"
        @dblclick="resetViewerTransform"
      >
        <img
          :src="previews[viewerItem.id]"
          :alt="viewerItem.filename"
          :style="{
            transform: `translate(${viewerOffset.x}px, ${viewerOffset.y}px) scale(${viewerScale})`
          }"
          draggable="false"
        />
      </div>
      <template #footer>
        <div class="viewer-footer">
          <div class="viewer-footer__zoom">
            <el-button size="small" @click="setScale(viewerScale / 1.25)">−</el-button>
            <span class="viewer-footer__scale num">{{ Math.round(viewerScale * 100) }}%</span>
            <el-button size="small" @click="setScale(viewerScale * 1.25)">＋</el-button>
            <el-button size="small" @click="resetViewerTransform">适应窗口</el-button>
            <span class="viewer-footer__hint">滚轮缩放 · 放大后拖动 · 双击复位</span>
          </div>
          <div class="viewer-footer__actions">
            <el-button :disabled="imageItems.length < 2" @click="stepViewer(-1)">上一张</el-button>
            <el-button :disabled="imageItems.length < 2" @click="stepViewer(1)">下一张</el-button>
            <el-button v-if="viewerItem" type="primary" :icon="Download" @click="download(viewerItem)">
              下载
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.batch-card {
  cursor: pointer;
}

.batch-card__empty {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  color: var(--text-tertiary);
  font-size: 12px;
  background: var(--bg-subtle);
}

.batch-card__badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(11, 18, 32, 0.62);
  color: #e2e8f0;
  font-size: 10.5px;
}

.batch-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
}

.psd-layers {
  margin-top: 2px;
}

.psd-layers__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
}

.psd-layers__meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.layer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
  max-height: 38vh;
  overflow-y: auto;
  padding: 2px;
}

.layer-tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--dur-fast) linear;
}

.layer-tile:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color));
}

.layer-tile__img {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background:
    repeating-conic-gradient(#1f2937 0% 25%, #0b1220 0% 50%) 50% / 14px 14px;
}

.layer-tile__img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.layer-tile__empty {
  font-size: 11px;
  color: var(--text-tertiary);
}

.layer-tile__name {
  padding: 0 6px 5px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.layer-loading {
  min-height: 120px;
}

.layer-preview {
  display: grid;
  place-items: center;
  min-height: 240px;
  max-height: 66vh;
  overflow: auto;
  background:
    repeating-conic-gradient(#1f2937 0% 25%, #0b1220 0% 50%) 50% / 18px 18px;
  border-radius: var(--radius-md);
}

.layer-preview img {
  max-width: 100%;
  max-height: 52vh;
  object-fit: contain;
}

.layer-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 40vh;
  overflow-y: auto;
}

.layer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  font-size: 12px;
}

.layer-row__index {
  min-width: 22px;
  color: var(--text-tertiary);
  font-size: 11px;
}

.layer-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.6;
}

.psd-block {
  margin-top: 14px;
  border-top: 1px solid var(--border-color);
  padding-top: 10px;
}

.psd-block__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 12px;
}

.psd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 150px;
  overflow-y: auto;
}

.psd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  font-size: 11.5px;
}

.list-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.media-card.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.media-card__check {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1.5px solid rgba(255, 255, 255, 0.75);
  border-radius: 50%;
  background: rgba(11, 18, 32, 0.45);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.9;
  transition: background var(--dur-fast) linear, border-color var(--dur-fast) linear;
}

.media-card__check:hover {
  border-color: #fff;
  background: rgba(11, 18, 32, 0.7);
}

.media-card__check.is-checked {
  border-color: var(--accent);
  background: var(--accent);
}

.page-actions {
  display: flex;
  gap: 8px;
}

.tabs {
  display: flex;
  gap: 6px;
}

.tab {
  padding: 5px 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--dur-fast) linear;
}

.tab:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border-color));
}

.tab.is-active {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}

.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.media-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.media-card__preview {
  position: relative;
  aspect-ratio: 1 / 1;
  background: var(--bg-subtle);
  display: grid;
  place-items: center;
  overflow: hidden;
}

.media-card__preview img,
.media-card__preview video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.media-card__preview audio {
  width: 90%;
}

.media-card__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-tertiary);
  font-size: 11px;
}

.media-card__image {
  cursor: zoom-in;
}

.media-card__image:hover {
  transform: scale(1.02);
  transition: transform 0.18s ease;
}

.viewer {
  position: relative;
  display: grid;
  place-items: center;
  height: 60vh;
  background: #0b1220;
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.viewer.is-panning {
  cursor: grabbing;
}

.viewer img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  transform-origin: center center;
  will-change: transform;
  transition: transform 0.06s linear;
}

.viewer.is-panning img {
  transition: none;
}

.viewer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.viewer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.viewer-footer__zoom {
  display: flex;
  align-items: center;
  gap: 6px;
}

.viewer-footer__scale {
  min-width: 48px;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.viewer-footer__hint {
  margin-left: 6px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.viewer-footer__actions {
  display: flex;
  gap: 8px;
}

.media-card__type {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(11, 18, 32, 0.62);
  color: #e2e8f0;
  font-size: 10.5px;
  backdrop-filter: blur(4px);
}

.media-card__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 10px;
}

.media-card__name {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.media-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  color: var(--text-tertiary);
  min-width: 0;
}

.media-card__wf {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-card__actions {
  display: flex;
  justify-content: space-between;
  padding-top: 2px;
}
</style>
