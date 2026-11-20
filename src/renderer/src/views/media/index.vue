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
  viewerId.value = item.id
  viewerVisible.value = true
}

async function stepViewer(delta: number): Promise<void> {
  const list = imageItems.value
  const index = list.findIndex((item) => item.id === viewerId.value)
  if (index < 0) return
  const next = list[(index + delta + list.length) % list.length]
  if (!next) return
  await loadPreview(next)
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
      top="5vh"
      append-to-body
      class="media-viewer"
    >
      <div v-if="viewerItem && previews[viewerItem.id]" class="viewer">
        <img :src="previews[viewerItem.id]" :alt="viewerItem.filename" />
      </div>
      <template #footer>
        <div class="viewer-footer">
          <span class="viewer-footer__hint">← → 切换 · Esc 关闭</span>
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
  display: grid;
  place-items: center;
  max-height: 74vh;
  background: #0b1220;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.viewer img {
  max-width: 100%;
  max-height: 74vh;
  object-fit: contain;
  display: block;
}

.viewer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.viewer-footer__hint {
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
