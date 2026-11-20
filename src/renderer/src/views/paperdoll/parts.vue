<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, FolderAdd, Picture, Upload } from '@element-plus/icons-vue'
import type {
  ComfyOutputFile,
  DollPartInput,
  DollPartSource,
  MediaBatch,
  MediaItem,
  PaperDollPart,
  PsdLayer
} from '@shared/types'

/** 纸娃娃系统 · 部件库：媒体库图片 / 拆分结果 PSD 图层都能作为部件 */
const SLOTS = [
  { value: 'all', label: '全部' },
  { value: 'hair', label: '发型' },
  { value: 'head', label: '头饰' },
  { value: 'body', label: '身体' },
  { value: 'top', label: '上衣' },
  { value: 'bottom', label: '下装' },
  { value: 'shoes', label: '鞋子' },
  { value: 'accessory', label: '装饰' }
]

const SLOT_LABELS: Record<string, string> = Object.fromEntries(
  SLOTS.filter((slot) => slot.value !== 'all').map((slot) => [slot.value, slot.label])
)

const parts = ref<PaperDollPart[]>([])
const loading = ref(false)
const activeSlot = ref('all')

const dialogVisible = ref(false)
const pickerTab = ref<'media' | 'psd'>('psd')
const saving = ref(false)

const name = ref('')
const slot = ref('accessory')
const layer = ref(10)
const thumb = ref('')
const source = ref<DollPartSource | null>(null)

const mediaItems = ref<MediaItem[]>([])
const mediaPreviews = ref<Record<string, string>>({})
const mediaLoading = ref(false)
const selectedMediaId = ref('')

const batches = ref<MediaBatch[]>([])
const activeBatchId = ref('')
const psdFiles = ref<ComfyOutputFile[]>([])
const psdLayers = ref<PsdLayer[]>([])
const psdLoading = ref(false)
const psdHint = ref('')
const selectedLayerIndex = ref(-1)

const filtered = computed(() =>
  activeSlot.value === 'all' ? parts.value : parts.value.filter((part) => part.slot === activeSlot.value)
)

const psdLayersVisible = computed(() => psdLayers.value.filter((layer) => layer.coverage > 0.002))

function slotLabel(value: string): string {
  return SLOT_LABELS[value] ?? value
}

function autoSlot(layerName: string): string {
  const lower = layerName.toLowerCase()
  if (/hair/.test(lower)) return 'hair'
  if (/headwear|hat|cap|helmet/.test(lower)) return 'head'
  if (/topwear|shirt|jacket|coat/.test(lower)) return 'top'
  if (/bottomwear|pants|skirt/.test(lower)) return 'bottom'
  if (/footwear|shoe|boot/.test(lower)) return 'shoes'
  if (/(body|base|skin)$/.test(lower)) return 'body'
  return 'accessory'
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    parts.value = await window.api.doll.parts()
  } catch (error) {
    ElMessage.error(`加载部件失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

/* ------------------------------ 选择来源 ------------------------------ */

async function openDialog(tab: 'media' | 'psd' = 'psd'): Promise<void> {
  dialogVisible.value = true
  pickerTab.value = tab
  name.value = ''
  slot.value = 'accessory'
  layer.value = 10
  thumb.value = ''
  source.value = null
  selectedMediaId.value = ''
  selectedLayerIndex.value = -1
  psdFiles.value = []
  psdLayers.value = []
  psdHint.value = ''
  await Promise.all([loadMedia(), loadBatches()])
}

async function loadMedia(): Promise<void> {
  mediaLoading.value = true
  try {
    mediaItems.value = await window.api.media.list()
    for (const item of mediaItems.value.filter((item) => item.type === 'image').slice(0, 80)) {
      void loadMediaPreview(item)
    }
  } catch (error) {
    ElMessage.error(`读取媒体库失败：${(error as Error).message}`)
  } finally {
    mediaLoading.value = false
  }
}

async function loadMediaPreview(item: MediaItem): Promise<void> {
  if (mediaPreviews.value[item.id]) return
  try {
    const data = await window.api.comfy.output(item.filename, item.subfolder, item.storage || 'output')
    mediaPreviews.value = { ...mediaPreviews.value, [item.id]: data.dataUrl }
  } catch {
    /* 预览失败忽略 */
  }
}

async function loadBatches(): Promise<void> {
  try {
    batches.value = await window.api.media.batches()
    if (batches.value.length && !activeBatchId.value) {
      await selectBatch(batches.value[0].id)
    }
  } catch (error) {
    ElMessage.error(`读取拆分结果失败：${(error as Error).message}`)
  }
}

async function selectBatch(batchId: string): Promise<void> {
  activeBatchId.value = batchId
  psdLayers.value = []
  psdFiles.value = []
  psdHint.value = ''
  selectedLayerIndex.value = -1
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return
  psdLoading.value = true
  try {
    const created = new Date(batch.createdAt).getTime() / 1000
    const result = await window.api.comfy.outputFiles('psd', created - 300)
    psdFiles.value = result.files.filter(
      (file) => file.mtime >= created - 300 && file.mtime <= created + 900
    )
    const main = psdFiles.value.find((file) => !/_depth\b/i.test(file.filename)) ?? psdFiles.value[0]
    if (!main) {
      psdHint.value = '这次拆分没找到 PSD 文件'
      return
    }
    const sheet = await window.api.comfy.psdLayers(main.filename, main.subfolder || '', 160)
    psdLayers.value = sheet.layers
    if (!sheet.layers.length) psdHint.value = 'PSD 里没有图层'
  } catch (error) {
    psdHint.value = `解析 PSD 失败：${(error as Error).message}`
  } finally {
    psdLoading.value = false
  }
}

function pickMedia(item: MediaItem): void {
  selectedMediaId.value = item.id
  thumb.value = mediaPreviews.value[item.id] ?? ''
  name.value = item.filename.replace(/\.\w+$/, '')
  slot.value = 'accessory'
  source.value = {
    kind: 'media',
    filename: item.filename,
    subfolder: item.subfolder,
    storage: item.storage || 'output'
  }
}

async function pickLayer(layerItem: PsdLayer): Promise<void> {
  const batch = batches.value.find((item) => item.id === activeBatchId.value)
  const main = psdFiles.value.find((file) => !/_depth\b/i.test(file.filename)) ?? psdFiles.value[0]
  if (!batch || !main) return
  selectedLayerIndex.value = layerItem.index
  name.value = layerItem.name
  slot.value = autoSlot(layerItem.name)
  layer.value = Math.min(99, 10 + layerItem.index)
  thumb.value = layerItem.thumb ?? ''
  source.value = {
    kind: 'psd',
    batchId: batch.id,
    filename: main.filename,
    subfolder: main.subfolder || '',
    layerIndex: layerItem.index,
    layerName: layerItem.name
  }
}

async function save(): Promise<void> {
  if (!source.value) {
    ElMessage.warning('先选一个部件来源（媒体库图片或拆分图层）')
    return
  }
  const trimmed = name.value.trim()
  if (!trimmed) {
    ElMessage.warning('给部件起个名字')
    return
  }
  saving.value = true
  try {
    // IPC 只能结构化克隆普通对象：把响应式 source 拆成纯对象再传
    const src = source.value
    const plainSource: DollPartSource =
      src.kind === 'psd'
        ? {
            kind: 'psd',
            batchId: src.batchId,
            filename: src.filename,
            subfolder: src.subfolder,
            layerIndex: src.layerIndex,
            layerName: src.layerName
          }
        : {
            kind: 'media',
            filename: src.filename,
            subfolder: src.subfolder,
            storage: src.storage
          }
    const input: DollPartInput = {
      name: trimmed,
      slot: slot.value,
      layer: layer.value,
      source: plainSource,
      thumb: thumb.value
    }
    await window.api.doll.createPart(input)
    dialogVisible.value = false
    ElMessage.success(`已添加部件「${trimmed}」`)
    await refresh()
  } catch (error) {
    ElMessage.error(`添加失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function remove(part: PaperDollPart): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除部件「${part.name}」？不会动媒体库/PSD 原文件。`, '删除部件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await window.api.doll.removePart(part.id)
  if (result.ok) {
    ElMessage.success('已删除')
    await refresh()
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">部件库</h1>
        <p class="page-desc">
          纸娃娃的换装素材：每个部件属于一个槽位，按图层顺序叠加。可以从媒体库挑图片，也可以直接选「拆分结果」解析出来的 PSD 图层。
        </p>
      </div>
      <div class="page-actions">
        <el-button :icon="FolderAdd" @click="openDialog('media')">从媒体库选择</el-button>
        <el-button type="primary" :icon="Upload" @click="openDialog('psd')">导入部件</el-button>
      </div>
    </header>

    <section class="panel">
      <header class="panel__head">
        <div class="tabs">
          <button
            v-for="item in SLOTS"
            :key="item.value"
            type="button"
            class="tab"
            :class="{ 'is-active': activeSlot === item.value }"
            @click="activeSlot = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <span class="text-muted">{{ filtered.length }} 个部件</span>
      </header>
      <div class="panel__body">
        <el-empty
          v-if="!loading && !filtered.length"
          description="还没有部件：可以从媒体库挑图片，或直接选拆分结果里的 PSD 图层"
        >
          <el-button type="primary" plain :icon="Picture" @click="openDialog('psd')">添加第一个部件</el-button>
        </el-empty>
        <div v-else class="part-grid">
          <article v-for="part in filtered" :key="part.id" class="part-card">
            <div class="part-card__preview">
              <img v-if="part.thumb" :src="part.thumb" :alt="part.name" />
              <span v-else class="part-card__empty">无预览</span>
            </div>
            <div class="part-card__body">
              <strong class="part-card__name" :title="part.name">{{ part.name }}</strong>
              <span class="part-card__meta">
                {{ slotLabel(part.slot) }} · 图层 {{ part.layer }} ·
                {{ part.source.kind === 'psd' ? 'PSD 图层' : '媒体库' }}
              </span>
              <div class="part-card__actions">
                <el-button link type="danger" size="small" :icon="Delete" @click="remove(part)">删除</el-button>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>

    <el-dialog v-model="dialogVisible" title="添加部件" width="780px" append-to-body>
      <div class="picker-tabs">
        <button
          type="button"
          class="tab"
          :class="{ 'is-active': pickerTab === 'psd' }"
          @click="pickerTab = 'psd'"
        >
          拆分结果图层
        </button>
        <button
          type="button"
          class="tab"
          :class="{ 'is-active': pickerTab === 'media' }"
          @click="pickerTab = 'media'"
        >
          媒体库图片
        </button>
      </div>

      <div v-if="pickerTab === 'psd'" class="picker-body">
        <el-select v-model="activeBatchId" placeholder="选择一次拆分结果" class="batch-select" @change="selectBatch">
          <el-option
            v-for="batch in batches"
            :key="batch.id"
            :label="`${batch.workflowName || '角色拆分'} · ${batch.layers.length} 层 · ${new Date(batch.createdAt).toLocaleString()}`"
            :value="batch.id"
          />
        </el-select>
        <div v-loading="psdLoading" class="layer-picker">
          <el-empty v-if="!psdLoading && !psdLayersVisible.length" :description="psdHint || '还没有拆分结果'" :image-size="70" />
          <button
            v-for="item in psdLayersVisible"
            :key="item.index"
            type="button"
            class="layer-item"
            :class="{ 'is-selected': selectedLayerIndex === item.index }"
            :title="item.name"
            @click="pickLayer(item)"
          >
            <span class="layer-item__img">
              <img v-if="item.thumb" :src="item.thumb" :alt="item.name" />
              <span v-else class="layer-item__empty">空</span>
            </span>
            <span class="layer-item__name">{{ item.name }}</span>
          </button>
        </div>
      </div>

      <div v-else v-loading="mediaLoading" class="picker-body">
        <div class="layer-picker">
          <el-empty
            v-if="!mediaLoading && !mediaItems.filter((item) => item.type === 'image').length"
            description="媒体库里还没有图片"
            :image-size="70"
          />
          <button
            v-for="item in mediaItems.filter((entry) => entry.type === 'image')"
            :key="item.id"
            type="button"
            class="layer-item"
            :class="{ 'is-selected': selectedMediaId === item.id }"
            :title="item.filename"
            @click="pickMedia(item)"
          >
            <span class="layer-item__img">
              <img v-if="mediaPreviews[item.id]" :src="mediaPreviews[item.id]" :alt="item.filename" />
              <span v-else class="layer-item__empty">加载中…</span>
            </span>
            <span class="layer-item__name">{{ item.filename }}</span>
          </button>
        </div>
      </div>

      <div class="part-form">
        <el-form label-position="top">
          <div class="form-row">
            <el-form-item label="部件名">
              <el-input v-model="name" maxlength="40" placeholder="例如：wings / 帽子" />
            </el-form-item>
            <el-form-item label="槽位">
              <el-select v-model="slot">
                <el-option
                  v-for="item in SLOTS.filter((entry) => entry.value !== 'all')"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="图层顺序">
              <el-input-number v-model="layer" :min="0" :max="999" />
            </el-form-item>
          </div>
        </el-form>
      </div>

      <template #footer>
        <span class="dialog-hint">
          {{ source ? (source.kind === 'psd' ? '来源：拆分结果 PSD 图层' : '来源：媒体库图片') : '还没选择来源' }}
        </span>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">添加部件</el-button>
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
  flex-wrap: wrap;
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

.part-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.part-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-surface);
}

.part-card__preview {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background:
    repeating-conic-gradient(#1f2937 0% 25%, #0b1220 0% 50%) 50% / 16px 16px;
}

.part-card__preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.part-card__empty {
  font-size: 11px;
  color: var(--text-tertiary);
}

.part-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px 6px;
}

.part-card__name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-card__meta {
  font-size: 10.5px;
  color: var(--text-tertiary);
}

.part-card__actions {
  display: flex;
  justify-content: flex-end;
}

.picker-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.picker-body {
  min-height: 180px;
}

.batch-select {
  width: 100%;
  margin-bottom: 10px;
}

.layer-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
  max-height: 36vh;
  min-height: 140px;
  overflow-y: auto;
  padding: 2px;
}

.layer-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--dur-fast) linear, box-shadow var(--dur-fast) linear;
}

.layer-item:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color));
}

.layer-item.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.layer-item__img {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background:
    repeating-conic-gradient(#1f2937 0% 25%, #0b1220 0% 50%) 50% / 14px 14px;
}

.layer-item__img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.layer-item__empty {
  font-size: 11px;
  color: var(--text-tertiary);
}

.layer-item__name {
  padding: 0 6px 5px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.part-form {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
}

.form-row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.dialog-hint {
  margin-right: auto;
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
