<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Camera, FolderOpened, RefreshLeft } from '@element-plus/icons-vue'
import type { ModelAsset } from '@shared/types'
import { MODEL_SOURCE_META } from '@shared/constants'
import { useModelStore } from '@renderer/stores/models'
import { formatBytes, formatDateTime } from '@renderer/utils/format'
import ModelViewer from '@renderer/components/ModelViewer.vue'

/**
 * 实验台：大画布 + 显示参数调节 + 截图。
 * 和「预览」共用一个 ModelViewer，只是这里可以长时间调参。
 */

const route = useRoute()
const router = useRouter()
const store = useModelStore()

const model = ref<ModelAsset | null>(null)
const bytes = ref<Uint8Array | null>(null)
const loading = ref(false)
const errorText = ref('')
const viewer = ref<InstanceType<typeof ModelViewer> | null>(null)
const stats = ref<{ triangles: number; meshes: number; size: string } | null>(null)

const autoRotate = ref(true)
const wireframe = ref(false)
const showGrid = ref(true)
const background = ref('#0b1220')
const exposure = ref(1)

const presetColors = ['#0b1220', '#141a24', '#1e293b', '#0f172a', '#f4f6fb', '#2b2140']

const meta = computed(() => (model.value ? MODEL_SOURCE_META[model.value.source] : null))

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

function handleError(message: string): void {
  errorText.value = message
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
  <div class="app-page">
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

    <section class="lab">
      <div class="lab__stage">
        <ModelViewer
          v-if="bytes"
          ref="viewer"
          :bytes="bytes"
          :format="model?.format"
          :auto-rotate="autoRotate"
          :wireframe="wireframe"
          :show-grid="showGrid"
          :background="background"
          :exposure="exposure"
          @loaded="stats = $event"
          @error="handleError"
        />
        <div v-else v-loading="loading" class="lab__placeholder">
          <span v-if="!loading">{{ errorText || '加载中…' }}</span>
        </div>
      </div>

      <aside class="lab__panel">
        <section class="lab__block">
          <h3 class="lab__title">显示</h3>
          <div class="lab__row">
            <span>自动旋转</span>
            <el-switch v-model="autoRotate" size="small" />
          </div>
          <div class="lab__row">
            <span>线框模式</span>
            <el-switch v-model="wireframe" size="small" />
          </div>
          <div class="lab__row">
            <span>接地网格</span>
            <el-switch v-model="showGrid" size="small" />
          </div>
          <div class="lab__row">
            <span>背景色</span>
            <el-color-picker v-model="background" size="small" :predefine="presetColors" />
          </div>
          <div class="lab__row">
            <span>光照强度</span>
            <el-slider v-model="exposure" :min="0.3" :max="2.5" :step="0.1" size="small" class="lab__slider" />
          </div>
        </section>

        <section class="lab__block">
          <h3 class="lab__title">模型数据</h3>
          <div class="lab__row">
            <span>来源</span>
            <el-tag v-if="meta" size="small" effect="light" :type="meta.tone">{{ meta.label }}</el-tag>
          </div>
          <div class="lab__row">
            <span>格式 / 大小</span>
            <span class="mono">{{ model?.format?.toUpperCase() }} · {{ formatBytes(model?.size ?? 0) }}</span>
          </div>
          <div class="lab__row">
            <span>三角形</span>
            <span class="num">{{ stats ? stats.triangles.toLocaleString('zh-CN') : '—' }}</span>
          </div>
          <div class="lab__row">
            <span>网格数</span>
            <span class="num">{{ stats?.meshes ?? '—' }}</span>
          </div>
          <div class="lab__row">
            <span>尺寸</span>
            <span class="num">{{ stats?.size ?? '—' }}</span>
          </div>
          <div class="lab__row">
            <span>更新时间</span>
            <span class="num text-muted">{{ formatDateTime(model?.updatedAt, true) }}</span>
          </div>
        </section>

        <section class="lab__actions">
          <el-button :icon="RefreshLeft" @click="resetView">重置视角</el-button>
          <el-button type="primary" :icon="Camera" @click="saveScreenshot">截图保存</el-button>
        </section>

        <p class="lab__path mono" :title="model?.path">{{ model?.path }}</p>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}

.lab {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  min-height: 0;
}

.lab__stage {
  height: calc(100vh - var(--titlebar-height) - var(--header-height) - 150px);
  min-height: 420px;
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

.lab__panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  max-height: calc(100vh - var(--titlebar-height) - var(--header-height) - 150px);
  overflow-y: auto;
}

.lab__block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lab__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}

.lab__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-secondary);
  min-height: 24px;
}

.lab__slider {
  width: 120px;
}

.lab__actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

.lab__actions :deep(.el-button) {
  flex: 1;
}

.lab__path {
  font-size: 10.5px;
  color: var(--text-tertiary);
  word-break: break-all;
  line-height: 1.5;
  margin: 0;
}

@media (max-width: 1100px) {
  .lab {
    grid-template-columns: 1fr;
  }

  .lab__stage {
    height: 420px;
  }

  .lab__panel {
    max-height: none;
  }
}
</style>
