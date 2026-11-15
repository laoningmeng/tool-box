<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { EditPen, FolderOpened } from '@element-plus/icons-vue'
import type { ModelAsset } from '@shared/types'
import { MODEL_SOURCE_META } from '@shared/constants'
import { useModelStore } from '@renderer/stores/models'
import { formatBytes, formatDateTime } from '@renderer/utils/format'
import ModelViewer from '@renderer/components/ModelViewer.vue'

/** 预览弹窗：three.js 渲染模型 + 基础信息；「实验台」由使用方跳转 */
const props = defineProps<{ modelValue: boolean; model: ModelAsset | null }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  edit: [model: ModelAsset]
}>()

const store = useModelStore()

const bytes = ref<Uint8Array | null>(null)
const loading = ref(false)
const errorText = ref('')
const autoRotate = ref(true)
const wireframe = ref(false)
const stats = ref<{ triangles: number; meshes: number; size: string } | null>(null)

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const meta = computed(() => (props.model ? MODEL_SOURCE_META[props.model.source] : null))

async function loadModel(id: string): Promise<void> {
  loading.value = true
  errorText.value = ''
  stats.value = null
  bytes.value = null
  try {
    bytes.value = await store.readBytes(id)
  } catch (error) {
    errorText.value = (error as Error).message
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.model?.id] as const,
  ([isOpen, id]) => {
    if (!isOpen || !id) {
      bytes.value = null
      stats.value = null
      return
    }
    autoRotate.value = true
    wireframe.value = false
    void loadModel(id)
  },
  { immediate: true }
)

function handleLoaded(info: { triangles: number; meshes: number; size: string }): void {
  stats.value = info
}

function handleError(message: string): void {
  errorText.value = message
}

async function handleReveal(): Promise<void> {
  if (!props.model) return
  try {
    await store.reveal(props.model.id)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="model?.name || '模型预览'"
    width="960px"
    top="6vh"
    destroy-on-close
    class="preview-dialog"
  >
    <div class="preview">
      <div class="preview__stage">
        <ModelViewer
          v-if="bytes"
          :bytes="bytes"
          :format="model?.format"
          :auto-rotate="autoRotate"
          :wireframe="wireframe"
          :show-grid="true"
          background="#0b1220"
          @loaded="handleLoaded"
          @error="handleError"
        />
        <div v-else v-loading="loading" class="preview__placeholder">
          <span v-if="!loading">{{ errorText || '加载中…' }}</span>
        </div>
      </div>

      <aside class="preview__side">
        <div class="preview__row">
          <span class="preview__label">来源</span>
          <el-tag v-if="meta" size="small" effect="light" :type="meta.tone">{{ meta.label }}</el-tag>
        </div>
        <div class="preview__row">
          <span class="preview__label">格式</span>
          <span class="mono">{{ model?.format?.toUpperCase() }}</span>
        </div>
        <div class="preview__row">
          <span class="preview__label">大小</span>
          <span class="num">{{ formatBytes(model?.size ?? 0) }}</span>
        </div>
        <div class="preview__row">
          <span class="preview__label">三角形</span>
          <span class="num">{{ stats ? stats.triangles.toLocaleString('zh-CN') : '—' }}</span>
        </div>
        <div class="preview__row">
          <span class="preview__label">网格数</span>
          <span class="num">{{ stats?.meshes ?? '—' }}</span>
        </div>
        <div class="preview__row">
          <span class="preview__label">尺寸</span>
          <span class="num">{{ stats?.size ?? '—' }}</span>
        </div>
        <div class="preview__row">
          <span class="preview__label">更新时间</span>
          <span class="num text-muted">{{ formatDateTime(model?.updatedAt, true) }}</span>
        </div>

        <el-divider />

        <div class="preview__switch">
          <span>自动旋转</span>
          <el-switch v-model="autoRotate" size="small" />
        </div>
        <div class="preview__switch">
          <span>线框模式</span>
          <el-switch v-model="wireframe" size="small" />
        </div>

        <el-alert
          v-if="errorText && bytes"
          :title="errorText"
          type="error"
          :closable="false"
          show-icon
          class="preview__alert"
        />
        <p class="preview__path mono" :title="model?.path">{{ model?.path }}</p>
      </aside>
    </div>

    <template #footer>
      <el-button :icon="FolderOpened" @click="handleReveal">在文件夹中显示</el-button>
      <el-button :icon="EditPen" @click="model && emit('edit', model)">编辑信息</el-button>
      <el-button type="primary" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.preview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 16px;
  height: 520px;
}

.preview__stage {
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: #0b1220;
  min-height: 0;
}

.preview__placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  color: rgba(226, 232, 240, 0.65);
  font-size: 13px;
  padding: 0 24px;
  text-align: center;
}

.preview__side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  overflow-y: auto;
}

.preview__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}

.preview__label {
  color: var(--text-tertiary);
}

.preview__switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.preview__alert {
  margin-top: 4px;
}

.preview__path {
  margin-top: auto;
  font-size: 11px;
  color: var(--text-tertiary);
  word-break: break-all;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .preview {
    grid-template-columns: 1fr;
    height: auto;
  }

  .preview__stage {
    height: 380px;
  }
}
</style>
