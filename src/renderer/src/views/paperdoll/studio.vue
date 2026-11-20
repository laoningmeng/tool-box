<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Download, MagicStick, RefreshLeft, ZoomIn } from '@element-plus/icons-vue'
import type { DollCharacter, DollOutfit, PaperDollPart } from '@shared/types'

/** 纸娃娃系统 · 换装台：角色底图 + 按槽位叠加部件，实时预览并导出 */
const router = useRouter()

const SLOTS = [
  { key: 'hair', label: '发型' },
  { key: 'head', label: '头饰' },
  { key: 'body', label: '身体' },
  { key: 'top', label: '上衣' },
  { key: 'bottom', label: '下装' },
  { key: 'shoes', label: '鞋子' },
  { key: 'accessory', label: '装饰' }
]

const characters = ref<DollCharacter[]>([])
const parts = ref<PaperDollPart[]>([])
const outfits = ref<DollOutfit[]>([])
const activeCharacterId = ref('')
const selection = ref<Record<string, string>>({})
const baseIndex = ref(0)
const zoom = ref(100)
const loading = ref(false)
const exporting = ref(false)

/** dataURL 缓存：base:<characterId> / part:<partId> */
const images = ref<Record<string, string>>({})

const activeCharacter = computed(() => characters.value.find((item) => item.id === activeCharacterId.value) ?? null)

const baseImageUrl = computed(
  () => images.value[`base:${activeCharacterId.value}:${baseIndex.value}`] ?? ''
)

const layers = computed(() => {
  const list: Array<{ key: string; layer: number; url: string; name: string }> = []
  for (const slot of SLOTS) {
    const partId = selection.value[slot.key]
    if (!partId) continue
    const part = parts.value.find((item) => item.id === partId)
    const url = images.value[`part:${partId}`]
    if (!part || !url) continue
    list.push({ key: partId, layer: part.layer, url, name: part.name })
  }
  return list.sort((a, b) => a.layer - b.layer)
})

const stageStyle = computed(() => ({
  transform: `scale(${zoom.value / 100})`
}))

const partsBySlot = (slot: string): PaperDollPart[] =>
  parts.value.filter((item) => item.slot === slot).sort((a, b) => b.layer - a.layer)

function partLabel(slot: string): { name: string; thumb?: string } | null {
  const partId = selection.value[slot]
  if (!partId) return null
  const part = parts.value.find((item) => item.id === partId)
  if (!part) return null
  return { name: part.name, thumb: part.thumb }
}

async function loadBaseImage(character: DollCharacter, index = 0): Promise<void> {
  const key = `base:${character.id}:${index}`
  if (images.value[key]) return
  const image = character.images[index] ?? character.images[0]
  if (!image) return
  try {
    const data = await window.api.comfy.output(image.filename, image.subfolder, 'output')
    images.value = { ...images.value, [key]: data.dataUrl }
  } catch (error) {
    ElMessage.error(`底图加载失败：${(error as Error).message}`)
  }
}

async function loadPartImage(part: PaperDollPart): Promise<void> {
  const key = `part:${part.id}`
  if (images.value[key]) return
  try {
    let dataUrl = ''
    if (part.source.kind === 'psd') {
      const image = await window.api.comfy.psdLayerImage(
        part.source.filename,
        part.source.subfolder,
        part.source.layerIndex
      )
      dataUrl = image.dataUrl
    } else {
      const data = await window.api.comfy.output(
        part.source.filename,
        part.source.subfolder,
        part.source.storage || 'output'
      )
      dataUrl = data.dataUrl
    }
    images.value = { ...images.value, [key]: dataUrl }
  } catch (error) {
    ElMessage.error(`部件「${part.name}」加载失败：${(error as Error).message}`)
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const [characterList, partList, outfitList] = await Promise.all([
      window.api.doll.list(),
      window.api.doll.parts(),
      window.api.doll.outfits()
    ])
    characters.value = characterList
    parts.value = partList
    outfits.value = outfitList
    if (!activeCharacterId.value && characters.value.length) {
      activeCharacterId.value = characters.value[0].id
    }
  } catch (error) {
    ElMessage.error(`加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

watch(
  [activeCharacterId, characters],
  () => {
    baseIndex.value = 0
    const character = activeCharacter.value
    if (character) void loadBaseImage(character, 0)
  },
  { immediate: true }
)

watch(baseIndex, (index) => {
  const character = activeCharacter.value
  if (character) void loadBaseImage(character, index)
})

watch(selection, () => {
  for (const slot of SLOTS) {
    const partId = selection.value[slot.key]
    if (!partId) continue
    const part = parts.value.find((item) => item.id === partId)
    if (part) void loadPartImage(part)
  }
})

function selectSlot(slot: string, partId: string): void {
  const next = { ...selection.value }
  if (partId) next[slot] = partId
  else delete next[slot]
  selection.value = next
}

function clearAll(): void {
  selection.value = {}
  zoom.value = 100
}

function applyOutfit(outfit: DollOutfit): void {
  activeCharacterId.value = outfit.characterId
  selection.value = { ...outfit.parts }
  ElMessage.success(`已套用方案「${outfit.name}」`)
}

async function saveOutfit(): Promise<void> {
  if (!activeCharacter.value) {
    ElMessage.warning('先选择一个角色')
    return
  }
  if (!layers.value.length) {
    ElMessage.warning('至少给角色穿上一个部件')
    return
  }
  let name = ''
  try {
    const result = await ElMessageBox.prompt('给这套搭配起个名字', '保存换装方案', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: `${activeCharacter.value.name} 的搭配`,
      inputValidator: (value) => (value.trim() ? true : '名字不能为空')
    })
    name = result.value.trim()
  } catch {
    return
  }
  try {
    const outfit = await window.api.doll.saveOutfit({
      name,
      characterId: activeCharacterId.value,
      parts: { ...selection.value }
    })
    outfits.value = [outfit, ...outfits.value]
    ElMessage.success(`已保存方案「${name}」`)
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  }
}

async function removeOutfit(outfit: DollOutfit): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除方案「${outfit.name}」？`, '删除方案', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await window.api.doll.removeOutfit(outfit.id)
  if (result.ok) {
    outfits.value = outfits.value.filter((item) => item.id !== outfit.id)
    ElMessage.success('已删除')
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function exportImage(): Promise<void> {
  const baseUrl = baseImageUrl.value
  if (!baseUrl) {
    ElMessage.warning('角色底图还没加载好')
    return
  }
  exporting.value = true
  try {
    const base = await loadImage(baseUrl)
    const canvas = document.createElement('canvas')
    canvas.width = base.naturalWidth || 1024
    canvas.height = base.naturalHeight || 1024
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height)
    for (const layer of layers.value) {
      const image = await loadImage(layer.url)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    const link = document.createElement('a')
    link.href = canvas.toDataURL('image/png')
    link.download = `${activeCharacter.value?.name || 'paperdoll'}-${Date.now()}.png`
    link.click()
    ElMessage.success('已导出换装图')
  } catch (error) {
    ElMessage.error(`导出失败：${(error as Error).message}`)
  } finally {
    exporting.value = false
  }
}

function goCharacters(): void {
  void router.push('/paperdoll')
}

onMounted(() => void refresh())
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">换装台</h1>
        <p class="page-desc">选角色 → 按槽位挑部件 → 实时预览图层叠加，保存成套方案或导出 PNG。</p>
      </div>
      <div class="page-actions">
        <el-button :icon="Download" :loading="exporting" @click="exportImage">导出换装图</el-button>
        <el-button type="primary" :icon="MagicStick" @click="saveOutfit">保存方案</el-button>
      </div>
    </header>

    <div class="studio">
      <aside class="panel studio__side">
        <header class="panel__head">
          <h2 class="panel__title">角色</h2>
          <span class="text-muted">{{ characters.length }}</span>
        </header>
        <div class="panel__body side-body">
          <el-empty v-if="!characters.length" description="还没有角色" :image-size="70">
            <el-button size="small" type="primary" plain @click="goCharacters">去新建角色</el-button>
          </el-empty>
          <div v-else class="character-list">
            <button
              v-for="character in characters"
              :key="character.id"
              type="button"
              class="character-item"
              :class="{ 'is-active': activeCharacterId === character.id }"
              @click="activeCharacterId = character.id"
            >
              <span class="character-item__name">{{ character.name }}</span>
              <span class="character-item__meta">{{ character.images.length }} 张素材</span>
            </button>
          </div>

          <div v-if="activeCharacter && activeCharacter.images.length > 1" class="base-picker">
            <span class="base-picker__label">底图</span>
            <el-select v-model="baseIndex" size="small">
              <el-option
                v-for="(image, index) in activeCharacter.images"
                :key="image.mediaId || image.filename"
                :label="image.filename"
                :value="index"
              />
            </el-select>
          </div>

          <div class="outfit-block">
            <div class="outfit-block__head">
              <strong>已存方案</strong>
              <span class="text-muted">{{ outfits.length }}</span>
            </div>
            <p v-if="!outfits.length" class="outfit-empty">还没有保存过方案</p>
            <div v-else class="outfit-list">
              <div v-for="outfit in outfits" :key="outfit.id" class="outfit-row">
                <button type="button" class="outfit-row__main" @click="applyOutfit(outfit)">
                  <strong>{{ outfit.name }}</strong>
                  <span class="outfit-row__meta">
                    {{ characters.find((item) => item.id === outfit.characterId)?.name || '角色已删除' }} ·
                    {{ Object.keys(outfit.parts).length }} 个部件
                  </span>
                </button>
                <el-button link type="danger" size="small" :icon="Delete" @click="removeOutfit(outfit)" />
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section class="panel studio__stage">
        <header class="panel__head">
          <h2 class="panel__title">预览</h2>
          <div class="stage-tools">
            <el-button size="small" :icon="ZoomIn" @click="zoom = Math.min(200, zoom + 10)">
              {{ zoom }}%
            </el-button>
            <el-button size="small" :icon="RefreshLeft" @click="zoom = 100">复位</el-button>
            <el-button size="small" link @click="clearAll">清空搭配</el-button>
          </div>
        </header>
        <div class="panel__body studio__canvas" v-loading="loading">
          <div v-if="!activeCharacter" class="canvas-placeholder">
            <el-icon><MagicStick /></el-icon>
            <strong>换装预览区</strong>
            <span>先建一个角色，再给他穿部件</span>
          </div>
          <div v-else class="stage" :style="stageStyle">
            <img v-if="baseImageUrl" :src="baseImageUrl" class="stage__layer" :alt="activeCharacter.name" />
            <img
              v-for="layer in layers"
              :key="layer.key"
              :src="layer.url"
              class="stage__layer"
              :alt="layer.name"
              :style="{ zIndex: layer.layer + 10 }"
            />
            <p v-if="!layers.length" class="stage__hint">右侧选部件 → 会按图层顺序叠加到这里</p>
          </div>
          <div v-if="layers.length" class="stage__meta text-muted">
            {{ activeCharacter?.name }} · 已穿 {{ layers.length }} 个部件
          </div>
        </div>
      </section>

      <aside class="panel studio__side">
        <header class="panel__head">
          <h2 class="panel__title">部件槽位</h2>
          <span class="text-muted">{{ parts.length }} 个部件</span>
        </header>
        <div class="panel__body slot-body">
          <div v-for="slot in SLOTS" :key="slot.key" class="slot-card">
            <div class="slot-card__head">
              <span class="slot-card__label">{{ slot.label }}</span>
              <span v-if="partLabel(slot.key)" class="slot-card__current">
                {{ partLabel(slot.key)?.name }}
              </span>
              <span v-else class="slot-card__empty">未选择</span>
            </div>
            <div class="slot-card__row">
              <span class="slot-card__thumb">
                <img
                  v-if="partLabel(slot.key)?.thumb"
                  :src="partLabel(slot.key)?.thumb"
                  :alt="slot.label"
                />
              </span>
              <el-select
                :model-value="selection[slot.key] || ''"
                size="small"
                placeholder="选择部件"
                clearable
                @update:model-value="(value: string) => selectSlot(slot.key, value)"
              >
                <el-option
                  v-for="part in partsBySlot(slot.key)"
                  :key="part.id"
                  :label="`${part.name}（图层 ${part.layer}）`"
                  :value="part.id"
                />
              </el-select>
            </div>
          </div>
          <p v-if="!parts.length" class="slot-tip">
            部件库还是空的，先去
            <el-button link type="primary" size="small" @click="router.push('/paperdoll/parts')">
              部件库
            </el-button>
            从媒体库 / 拆分图层里挑部件
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}

.studio {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr) 280px;
  gap: 12px;
  min-height: 540px;
}

.studio__side,
.studio__stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.side-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.character-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.character-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--dur-fast) linear;
}

.character-item:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border-color));
}

.character-item.is-active {
  border-color: var(--accent);
  background: var(--accent-softer);
}

.character-item__name {
  font-size: 12.5px;
  color: var(--text-primary);
}

.character-item__meta {
  font-size: 10.5px;
  color: var(--text-tertiary);
}

.base-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--border-color);
}

.base-picker__label {
  flex: none;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.outfit-block {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
}

.outfit-block__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
}

.outfit-empty {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

.outfit-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.outfit-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  padding-right: 4px;
}

.outfit-row__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 5px 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 11.5px;
}

.outfit-row__meta {
  font-size: 10px;
  color: var(--text-tertiary);
}

.studio__canvas {
  position: relative;
  flex: 1;
  display: grid;
  place-items: center;
  overflow: hidden;
  background:
    repeating-conic-gradient(#1f2937 0% 25%, #0b1220 0% 50%) 50% / 18px 18px;
  border-radius: 0;
}

.canvas-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 32px;
  border-radius: var(--radius-lg);
  border: 1px dashed color-mix(in srgb, var(--accent) 40%, var(--border-color));
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
}

.canvas-placeholder .el-icon {
  font-size: 24px;
  color: var(--accent);
}

.stage {
  position: relative;
  width: min(100%, 60vh);
  aspect-ratio: 1 / 1;
  transform-origin: center center;
  transition: transform var(--dur-fast) linear;
}

.stage__layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.stage__hint {
  position: absolute;
  left: 50%;
  bottom: 8%;
  transform: translateX(-50%);
  margin: 0;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(11, 18, 32, 0.55);
  color: #cbd5e1;
  font-size: 11px;
  white-space: nowrap;
}

.stage__meta {
  position: absolute;
  left: 12px;
  bottom: 10px;
  font-size: 11px;
}

.stage-tools {
  display: flex;
  align-items: center;
  gap: 6px;
}

.slot-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.slot-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}

.slot-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.slot-card__label {
  color: var(--text-primary);
}

.slot-card__current {
  color: var(--accent);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot-card__empty {
  font-size: 11px;
  color: var(--text-tertiary);
}

.slot-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slot-card__thumb {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background:
    repeating-conic-gradient(#1f2937 0% 25%, #0b1220 0% 50%) 50% / 10px 10px;
}

.slot-card__thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.slot-tip {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.7;
}

@media (max-width: 1200px) {
  .studio {
    grid-template-columns: 1fr;
  }
}
</style>
