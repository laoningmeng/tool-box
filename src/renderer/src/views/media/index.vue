<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Delete, Picture, Refresh, VideoCamera, Headset, RefreshRight } from '@element-plus/icons-vue'
import { WORKFLOW_CATEGORY_META } from '@shared/constants'
import type { MediaItem, MediaKind, WorkflowCategory } from '@shared/types'

/** 媒体库：工作流生成的图片 / 视频 / 音频都会汇总到这里 */
const items = ref<MediaItem[]>([])
const loading = ref(false)
const syncing = ref(false)
const activeType = ref<MediaKind | 'all'>('all')
const previews = ref<Record<string, string>>({})
const previewErrors = ref<Record<string, boolean>>({})

const tabs: Array<{ value: MediaKind | 'all'; label: string; icon: unknown }> = [
  { value: 'all', label: '全部', icon: Picture },
  { value: 'image', label: '图片', icon: Picture },
  { value: 'video', label: '视频', icon: VideoCamera },
  { value: 'audio', label: '音频', icon: Headset }
]

const counts = computed(() => {
  const map: Record<string, number> = { all: items.value.length, image: 0, video: 0, audio: 0 }
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
    const data = await window.api.comfy.output(item.filename, item.subfolder)
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
  } catch (error) {
    ElMessage.error(`加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
    syncing.value = false
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
    items.value = await window.api.media.list()
    ElMessage.success('已移除记录')
  }
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
        <span class="text-muted">{{ items.length }} 个结果</span>
      </header>

      <div class="panel__body">
        <el-empty v-if="!filtered.length" description="还没有生成结果，去「执行流程」页跑一个工作流吧" />
        <div v-else class="media-grid">
          <article v-for="item in filtered" :key="item.id" class="media-card">
            <div class="media-card__preview">
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
      </div>
    </section>

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
