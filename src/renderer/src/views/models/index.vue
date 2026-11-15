<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Box,
  Delete,
  MagicStick,
  Refresh,
  Search,
  Upload,
  View
} from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import { MODEL_FORMAT_OPTIONS, MODEL_SOURCE_META, MODEL_SOURCE_OPTIONS } from '@shared/constants'
import type { ModelAsset, ModelSource } from '@shared/types'
import { useModelStore } from '@renderer/stores/models'
import { formatBytes, formatDateTime } from '@renderer/utils/format'
import ModelPreviewDialog from './components/ModelPreviewDialog.vue'

/**
 * 3D 模型列表（卡片视图）。
 * 每张卡片：来源色预览区 + 名称/大小 + 预览 / 实验台 / 删除 三个操作。
 */

const store = useModelStore()
const router = useRouter()
const { items, summary, loading, importing, keyword, source, format, hasFilters } = storeToRefs(store)

const previewVisible = ref(false)
const previewModel = ref<ModelAsset | null>(null)
const dialogVisible = ref(false)
const editing = ref<ModelAsset | null>(null)

const form = reactive({
  name: '',
  source: 'unknown' as ModelSource,
  tags: [] as string[],
  note: ''
})

const THUMB_GRADIENTS: Record<ModelSource, string> = {
  tripo: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)',
  meshy: 'linear-gradient(135deg, #92400e 0%, #f59e0b 100%)',
  blender: 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)',
  unknown: 'linear-gradient(135deg, #334155 0%, #64748b 100%)'
}

onMounted(() => {
  void store.refresh()
})

function sourceMeta(value: ModelAsset['source']) {
  return MODEL_SOURCE_META[value] ?? MODEL_SOURCE_META.unknown
}

function thumbStyle(item: ModelAsset): { background: string } {
  return { background: THUMB_GRADIENTS[item.source] ?? THUMB_GRADIENTS.unknown }
}

async function handleImport(): Promise<void> {
  try {
    const result = await store.importModels()
    if (result.canceled) return
    if (!result.ok) {
      ElMessage.warning('没有导入任何文件')
      return
    }
    const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ''
    ElMessage.success(`已导入 ${result.added} 个模型${skipped}`)
    if (result.message) ElMessage.warning(result.message)
  } catch (error) {
    ElMessage.error(`导入失败：${(error as Error).message}`)
  }
}

function openPreview(item: ModelAsset): void {
  if (item.exists === false) {
    ElMessage.warning('文件已被移动或删除，无法预览')
    return
  }
  previewModel.value = item
  previewVisible.value = true
}

function openLab(item: ModelAsset): void {
  if (item.exists === false) {
    ElMessage.warning('文件已被移动或删除，无法进入实验台')
    return
  }
  void router.push({ name: 'model-lab', params: { id: item.id } })
}

async function handleRemove(item: ModelAsset): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定从模型库移除「${item.name}」？只移除登记记录，不会删除磁盘上的文件。`,
      '移除模型',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await store.remove(item.id)
  if (ok) {
    if (previewModel.value?.id === item.id) previewVisible.value = false
    ElMessage.success('已删除')
  } else {
    ElMessage.error('删除失败')
  }
}

/* ------------------------------- 编辑元信息 ------------------------------- */

function openEdit(item: ModelAsset): void {
  editing.value = item
  form.name = item.name
  form.source = item.source
  form.tags = [...item.tags]
  form.note = item.note
  previewVisible.value = false
  dialogVisible.value = true
}

async function handleSave(): Promise<void> {
  if (!editing.value) return
  if (!form.name.trim()) {
    ElMessage.warning('名称不能为空')
    return
  }
  try {
    await store.update(editing.value.id, {
      name: form.name.trim(),
      source: form.source,
      tags: form.tags,
      note: form.note.trim()
    })
    dialogVisible.value = false
    ElMessage.success('已保存')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function handleSearch(): Promise<void> {
  await store.fetchList()
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">
          模型列表
          <span class="chip">{{ summary?.total ?? 0 }} 个</span>
        </h1>
      </div>
      <el-button type="primary" :icon="Upload" :loading="importing" @click="handleImport">
        导入模型
      </el-button>
    </header>

    <section class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">模型库</h2>
          <p class="panel__subtitle">
            共 {{ items.length }} 个 · 占用 {{ formatBytes(summary?.bytes ?? 0) }}
            <span v-if="hasFilters" class="text-muted">（已筛选）</span>
          </p>
        </div>
        <div class="toolbar">
          <el-input
            v-model="keyword"
            class="toolbar__search"
            placeholder="搜索名称 / 路径 / 备注"
            :prefix-icon="Search"
            clearable
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
          <el-select v-model="source" class="toolbar__select" placeholder="全部来源" @change="handleSearch">
            <el-option label="全部来源" value="all" />
            <el-option
              v-for="option in MODEL_SOURCE_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-select v-model="format" class="toolbar__select" placeholder="全部格式" @change="handleSearch">
            <el-option label="全部格式" value="all" />
            <el-option
              v-for="option in MODEL_FORMAT_OPTIONS"
              :key="option"
              :label="option.toUpperCase()"
              :value="option"
            />
          </el-select>
          <el-button v-if="hasFilters" link type="primary" @click="store.resetFilters()">清空筛选</el-button>
          <el-button :icon="Refresh" @click="store.refresh()">刷新</el-button>
        </div>
      </header>

      <div v-loading="loading" class="panel__body">
        <div v-if="items.length > 0" class="model-grid">
          <article
            v-for="item in items"
            :key="item.id"
            class="model-card"
            :class="{ 'is-missing': item.exists === false }"
          >
            <div class="model-card__thumb" :style="thumbStyle(item)">
              <el-icon class="model-card__icon"><Box /></el-icon>
              <span class="model-card__format mono">{{ String(item.format).toUpperCase() }}</span>
              <el-tag
                class="model-card__source"
                size="small"
                effect="dark"
                :type="sourceMeta(item.source).tone"
              >
                {{ sourceMeta(item.source).label }}
              </el-tag>
              <span v-if="item.exists === false" class="model-card__missing">文件丢失</span>
            </div>

            <div class="model-card__body">
              <h3 class="model-card__name" :title="item.name">{{ item.name }}</h3>
              <p class="model-card__meta">
                {{ formatBytes(item.size) }} · {{ formatDateTime(item.updatedAt, true) }}
              </p>
            </div>

            <div class="model-card__actions">
              <el-button
                size="small"
                :icon="View"
                :disabled="item.exists === false"
                @click="openPreview(item)"
              >
                预览
              </el-button>
              <el-button
                size="small"
                :icon="MagicStick"
                :disabled="item.exists === false"
                @click="openLab(item)"
              >
                实验台
              </el-button>
              <el-button size="small" type="danger" plain :icon="Delete" @click="handleRemove(item)">
                删除
              </el-button>
            </div>
          </article>
        </div>

        <el-empty v-else-if="!loading" :description="hasFilters ? '没有匹配的模型' : '模型库还是空的'">
          <el-button v-if="hasFilters" @click="store.resetFilters()">清空筛选</el-button>
          <el-button v-else type="primary" :icon="Upload" @click="handleImport">导入第一个模型</el-button>
        </el-empty>
      </div>
    </section>

    <ModelPreviewDialog v-model="previewVisible" :model="previewModel" @edit="openEdit" />

    <el-dialog v-model="dialogVisible" title="编辑模型信息" width="520px">
      <el-form label-width="76px" label-position="left">
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="80" show-word-limit />
        </el-form-item>
        <el-form-item label="来源">
          <el-radio-group v-model="form.source">
            <el-radio-button v-for="option in MODEL_SOURCE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标签">
          <el-select
            v-model="form.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="回车创建标签，例如 角色 / 道具 / 场景"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="3" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="文件">
          <span class="mono text-muted dialog-path">{{ editing?.path }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar__search {
  width: 210px;
}

.toolbar__select {
  width: 130px;
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(252px, 1fr));
  gap: 14px;
}

.model-card {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  overflow: hidden;
  transition: border-color var(--dur-fast) linear, box-shadow var(--dur-fast) linear,
    transform var(--dur-fast) var(--ease-out);
}

.model-card:hover {
  border-color: var(--accent-border);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.model-card.is-missing {
  opacity: 0.72;
}

.model-card__thumb {
  position: relative;
  height: 118px;
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.92);
}

.model-card__icon {
  font-size: 42px;
  opacity: 0.9;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.28));
}

.model-card__format {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: rgba(0, 0, 0, 0.28);
  color: rgba(255, 255, 255, 0.92);
}

.model-card__source {
  position: absolute;
  right: 10px;
  top: 10px;
}

.model-card__missing {
  position: absolute;
  left: 10px;
  top: 10px;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: rgba(239, 68, 68, 0.92);
  color: #fff;
}

.model-card__body {
  padding: 12px 14px 6px;
  min-width: 0;
}

.model-card__name {
  margin: 0 0 4px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-card__meta {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.model-card__actions {
  display: flex;
  gap: 6px;
  padding: 10px 14px 14px;
  margin-top: auto;
}

.model-card__actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
}

.dialog-path {
  font-size: 12px;
  word-break: break-all;
}

@media (max-width: 1100px) {
  .toolbar__search,
  .toolbar__select {
    width: 100%;
  }
}
</style>
