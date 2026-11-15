<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Camera,
  FolderOpened,
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
import type { ModelAsset } from '@shared/types'
import { MODEL_SOURCE_META } from '@shared/constants'
import { useModelStore } from '@renderer/stores/models'
import { formatBytes, formatDateTime } from '@renderer/utils/format'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import type { ViewerStructure } from '@renderer/components/model-viewer-types'

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

const model = ref<ModelAsset | null>(null)
const bytes = ref<Uint8Array | null>(null)
const loading = ref(false)
const errorText = ref('')
const viewer = ref<InstanceType<typeof ModelViewer> | null>(null)

const structure = ref<ViewerStructure | null>(null)
const stats = computed(() => structure.value?.stats ?? null)

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

const meta = computed(() => (model.value ? MODEL_SOURCE_META[model.value.source] : null))
const PART_TYPE_LABEL: Record<string, string> = {
  skinned: '蒙皮网格',
  mesh: '网格',
  lines: '线条',
  points: '点云'
}
const clips = computed(() => structure.value?.clips ?? [])
const hasClips = computed(() => clips.value.length > 0)

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

function handleParsed(next: ViewerStructure): void {
  structure.value = next
  errorText.value = ''
  // 有动作就默认加载第一个片段，方便直接拖动时间轴
  if (next.clips.length > 0) {
    clipIndex.value = 0
    playClip(0)
  }
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
  viewer.value?.focusNode(id)
}

function selectBone(id: string): void {
  selectedId.value = id
  selectedKind.value = 'bone'
  viewer.value?.focusNode(id)
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

function playClip(index: number): void {
  if (!viewer.value) return
  clipIndex.value = index
  viewer.value.playClip(index)
  viewer.value.setClipSpeed(speed.value)
  playing.value = true
}

function togglePlay(): void {
  if (!hasClips.value) return
  if (clipIndex.value < 0) {
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
  if (!hasClips.value) return
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
              v-for="part in parts"
              :key="part.id"
              class="tree-row"
              :class="{ 'is-active': selectedId === part.id, 'is-hidden': hiddenParts.has(part.id) }"
              :style="{ paddingLeft: `${8 + part.depth * 12}px` }"
              @click="selectPart(part.id)"
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
            >
              <el-icon class="tree-row__icon"><Share /></el-icon>
              <span class="tree-row__name" :title="bone.name">{{ bone.name }}</span>
              <span v-if="bone.childCount" class="tree-row__meta num">{{ bone.childCount }}</span>
            </div>
            <p v-if="bones.length === 0" class="tree-empty">
              {{ structure?.bones.length ? '没有匹配的骨骼' : '该模型没有骨骼（静态模型）' }}
            </p>
          </template>
        </div>

        <footer class="panel-foot">
          <span v-if="tab === 'parts'">显示 {{ visibleCount }} / {{ structure?.parts.length ?? 0 }}</span>
          <span v-else>共 {{ structure?.bones.length ?? 0 }} 根骨骼</span>
        </footer>
      </aside>

      <!-- 中：视口 + 工具条 + 时间轴 -->
      <section class="lab__viewport">
        <div class="view-toolbar">
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
            @parsed="handleParsed"
            @tick="handleTick"
            @error="errorText = $event"
          />
          <div v-else v-loading="loading" class="lab__placeholder">
            <span v-if="!loading">{{ errorText || '加载中…' }}</span>
          </div>
        </div>

        <div class="transport" :class="{ 'is-disabled': !hasClips }">
          <el-button
            circle
            size="small"
            :icon="playing ? VideoPause : VideoPlay"
            :disabled="!hasClips"
            @click="togglePlay"
          />
          <el-button circle size="small" :icon="RefreshLeft" :disabled="!hasClips" @click="restartClip" />
          <el-slider
            :model-value="clipTime"
            :max="clipDuration || 1"
            :step="0.01"
            :show-tooltip="false"
            :disabled="!hasClips"
            class="transport__slider"
            @input="handleSeek"
          />
          <span class="transport__time num">{{ fmtTime(clipTime) }} / {{ fmtTime(clipDuration) }}</span>
          <el-select v-model="speed" size="small" class="transport__speed" :disabled="!hasClips" @change="handleSpeed">
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
              :class="{ 'is-active': clipIndex === clip.index }"
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
          <h3 class="block__title">选中</h3>
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

.tree-empty {
  margin: 20px 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  line-height: 1.6;
}

.panel-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  font-size: 11.5px;
  color: var(--text-tertiary);
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

.block__empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
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
