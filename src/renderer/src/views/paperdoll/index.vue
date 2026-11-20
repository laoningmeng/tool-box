<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Avatar, Check, Delete, Grid, MagicStick, Plus } from '@element-plus/icons-vue'
import type { DollCharacter, MediaItem } from '@shared/types'

/** 纸娃娃系统 · 角色列表：新建角色 = 取名 + 从媒体库挑素材 */
const router = useRouter()

const characters = ref<DollCharacter[]>([])
const loading = ref(false)
const covers = ref<Record<string, string>>({})

const dialogVisible = ref(false)
const submitting = ref(false)
const name = ref('')
const mediaItems = ref<MediaItem[]>([])
const mediaPreviews = ref<Record<string, string>>({})
const mediaLoading = ref(false)
const selectedIds = ref<string[]>([])

const stats = computed(() => ({
  characters: characters.value.length,
  images: characters.value.reduce((total, item) => total + item.images.length, 0),
  outfits: 0
}))

const selectedSet = computed(() => new Set(selectedIds.value))
const imagesInLibrary = computed(() => mediaItems.value.filter((item) => item.type === 'image'))

const modules = [
  {
    path: '/paperdoll/parts',
    title: '部件库',
    caption: '头 / 身体 / 手臂 / 腿 / 装饰等可换装部件',
    icon: Grid
  },
  {
    path: '/paperdoll/studio',
    title: '换装台',
    caption: '选角色 → 勾选部件 → 实时预览与导出',
    icon: MagicStick
  }
]

function formatTime(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (num: number): string => String(num).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadCover(character: DollCharacter): Promise<void> {
  const first = character.images[0]
  if (!first || covers.value[character.id]) return
  try {
    const data = await window.api.comfy.output(first.filename, first.subfolder)
    covers.value = { ...covers.value, [character.id]: data.dataUrl }
  } catch {
    /* 单张封面失败不影响列表 */
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    characters.value = await window.api.doll.list()
    for (const item of characters.value) void loadCover(item)
  } catch (error) {
    ElMessage.error(`加载角色失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function loadMediaPreview(item: MediaItem): Promise<void> {
  if (mediaPreviews.value[item.id]) return
  try {
    const data = await window.api.comfy.output(item.filename, item.subfolder)
    mediaPreviews.value = { ...mediaPreviews.value, [item.id]: data.dataUrl }
  } catch {
    /* 预览失败就留空 */
  }
}

async function openDialog(): Promise<void> {
  name.value = ''
  selectedIds.value = []
  dialogVisible.value = true
  mediaLoading.value = true
  try {
    mediaItems.value = await window.api.media.list()
    for (const item of imagesInLibrary.value.slice(0, 80)) void loadMediaPreview(item)
  } catch (error) {
    ElMessage.error(`读取媒体库失败：${(error as Error).message}`)
  } finally {
    mediaLoading.value = false
  }
}

function toggleSelect(item: MediaItem): void {
  if (selectedSet.value.has(item.id)) {
    selectedIds.value = selectedIds.value.filter((id) => id !== item.id)
  } else {
    selectedIds.value = [...selectedIds.value, item.id]
  }
}

async function submit(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) {
    ElMessage.warning('先给角色起个名字')
    return
  }
  if (selectedIds.value.length === 0) {
    ElMessage.warning('至少从媒体库选一张素材')
    return
  }
  const images = mediaItems.value
    .filter((item) => selectedSet.value.has(item.id))
    .map((item) => ({ mediaId: item.id, filename: item.filename, subfolder: item.subfolder }))
  submitting.value = true
  try {
    await window.api.doll.create({ name: trimmed, images })
    dialogVisible.value = false
    ElMessage.success(`已创建角色「${trimmed}」（${images.length} 张素材）`)
    await refresh()
  } catch (error) {
    ElMessage.error(`创建失败：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

async function handleRemove(character: DollCharacter): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除角色「${character.name}」？媒体库里的素材不会被删除。`, '删除角色', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await window.api.doll.remove(character.id)
  if (result.ok) {
    ElMessage.success('已删除角色')
    await refresh()
  }
}

function openModule(path: string): void {
  void router.push(path)
}

onMounted(() => void refresh())
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">纸娃娃系统</h1>
        <p class="page-desc">
          新建角色 = 角色取名 + 从媒体库挑素材（底图 / 各部位图层）。素材只引用不复制，删角色不影响媒体库。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openDialog">新建角色</el-button>
    </header>

    <section class="overview">
      <article class="stat-card">
        <span class="stat-card__label">角色</span>
        <strong class="stat-card__value num">{{ stats.characters }}</strong>
        <span class="stat-card__hint">换装主体</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">素材</span>
        <strong class="stat-card__value num">{{ stats.images }}</strong>
        <span class="stat-card__hint">来自媒体库</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">换装方案</span>
        <strong class="stat-card__value num">{{ stats.outfits }}</strong>
        <span class="stat-card__hint">保存的成套搭配</span>
      </article>
    </section>

    <section class="module-grid">
      <article
        v-for="item in modules"
        :key="item.path"
        class="module-card"
        role="button"
        tabindex="0"
        @click="openModule(item.path)"
        @keyup.enter="openModule(item.path)"
      >
        <el-icon class="module-card__icon"><component :is="item.icon" /></el-icon>
        <div class="module-card__body">
          <strong>{{ item.title }}</strong>
          <span class="text-muted">{{ item.caption }}</span>
        </div>
      </article>
    </section>

    <section class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">角色列表</h2>
          <p class="panel__subtitle">每个角色携带自己的素材集合，换装台里按槽位拼装</p>
        </div>
        <span class="text-muted">{{ characters.length }} 个角色</span>
      </header>
      <div class="panel__body">
        <el-empty v-if="!loading && !characters.length" description="还没有角色：点右上角「新建角色」，取名后从媒体库挑素材">
          <el-button type="primary" plain :icon="Plus" @click="openDialog">新建第一个角色</el-button>
        </el-empty>
        <div v-else class="doll-grid">
          <article v-for="item in characters" :key="item.id" class="doll-card">
            <div class="doll-card__cover">
              <img v-if="covers[item.id]" :src="covers[item.id]" :alt="item.name" />
              <div v-else class="doll-card__placeholder">
                <el-icon><Avatar /></el-icon>
              </div>
              <span class="doll-card__count">{{ item.images.length }} 张素材</span>
            </div>
            <div class="doll-card__body">
              <strong class="doll-card__name" :title="item.name">{{ item.name }}</strong>
              <span class="doll-card__time num">{{ formatTime(item.createdAt) }}</span>
              <div class="doll-card__actions">
                <el-button link type="primary" size="small" @click="openModule('/paperdoll/studio')">
                  进入换装台
                </el-button>
                <el-button link type="danger" size="small" :icon="Delete" @click="handleRemove(item)">
                  删除
                </el-button>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- 新建角色：取名 + 从媒体库选素材 -->
    <el-dialog v-model="dialogVisible" title="新建角色" width="760px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="角色名">
          <el-input v-model="name" maxlength="32" show-word-limit placeholder="例如：主角 / 小怪 / 店长" />
        </el-form-item>
        <el-form-item :label="`从媒体库选择素材（已选 ${selectedIds.length} 张）`">
          <div v-loading="mediaLoading" class="picker">
            <el-empty
              v-if="!mediaLoading && !imagesInLibrary.length"
              description="媒体库里还没有图片，先去「执行流程」生成或同步 ComfyUI 历史"
              :image-size="70"
            />
            <button
              v-for="item in imagesInLibrary"
              :key="item.id"
              type="button"
              class="picker__item"
              :class="{ 'is-selected': selectedSet.has(item.id) }"
              :title="item.filename"
              @click="toggleSelect(item)"
            >
              <img v-if="mediaPreviews[item.id]" :src="mediaPreviews[item.id]" :alt="item.filename" />
              <span v-else class="picker__empty">加载中…</span>
              <span v-if="selectedSet.has(item.id)" class="picker__check">
                <el-icon><Check /></el-icon>
              </span>
              <span class="picker__name mono">{{ item.filename }}</span>
            </button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-hint">选中的图片会作为该角色的素材集合（可多选）</span>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">创建角色</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.stat-card__label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.stat-card__value {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.stat-card__hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.module-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color var(--dur-fast) linear, transform var(--dur-fast) linear;
}

.module-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color));
  transform: translateY(-1px);
}

.module-card__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--accent-softer);
  color: var(--accent);
  font-size: 18px;
  flex: none;
}

.module-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 13px;
}

.doll-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
}

.doll-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-surface);
}

.doll-card__cover {
  position: relative;
  aspect-ratio: 1 / 1;
  display: grid;
  place-items: center;
  background: var(--bg-subtle);
  overflow: hidden;
}

.doll-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.doll-card__placeholder {
  color: var(--text-tertiary);
  font-size: 30px;
}

.doll-card__count {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(11, 18, 32, 0.62);
  color: #e2e8f0;
  font-size: 10.5px;
}

.doll-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px 10px;
}

.doll-card__name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doll-card__time {
  font-size: 10.5px;
  color: var(--text-tertiary);
}

.doll-card__actions {
  display: flex;
  justify-content: space-between;
  padding-top: 2px;
}

.picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  width: 100%;
  max-height: 44vh;
  min-height: 120px;
  overflow-y: auto;
  padding: 4px;
}

.picker__item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--dur-fast) linear, box-shadow var(--dur-fast) linear;
}

.picker__item:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color));
}

.picker__item.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.picker__item img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  display: block;
}

.picker__empty {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  color: var(--text-tertiary);
  font-size: 11px;
  background: var(--bg-subtle);
}

.picker__check {
  position: absolute;
  right: 6px;
  top: 6px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
}

.picker__name {
  padding: 3px 6px;
  font-size: 10px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.dialog-hint {
  margin-right: auto;
  font-size: 11px;
  color: var(--text-tertiary);
}

@media (max-width: 1100px) {
  .overview,
  .module-grid {
    grid-template-columns: 1fr;
  }
}
</style>
