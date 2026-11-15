<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, EditPen, FolderOpened, Refresh, Search, Upload } from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import { MODEL_FORMAT_OPTIONS, MODEL_SOURCE_META, MODEL_SOURCE_OPTIONS } from '@shared/constants'
import type { ModelAsset, ModelSource } from '@shared/types'
import { useModelStore } from '@renderer/stores/models'
import { formatBytes, formatDateTime } from '@renderer/utils/format'

/**
 * 3D 模型列表：登记本机导出的模型（Tripo / Meshy / Blender）。
 * 库只做引用，不复制源文件；移除只出库，不删文件。
 */

const store = useModelStore()
const { items, summary, loading, importing, keyword, source, format, hasFilters } = storeToRefs(store)

const stats = computed(() => [
  { label: '模型总数', value: summary.value?.total ?? 0 },
  { label: 'Tripo', value: summary.value?.bySource.tripo ?? 0 },
  { label: 'Meshy', value: summary.value?.bySource.meshy ?? 0 },
  { label: 'Blender', value: summary.value?.bySource.blender ?? 0 }
])

const totalSize = computed(() => formatBytes(summary.value?.bytes ?? 0))

onMounted(() => {
  void store.refresh()
})

function sourceMeta(value: ModelAsset['source']) {
  return MODEL_SOURCE_META[value] ?? MODEL_SOURCE_META.unknown
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

async function handleReveal(item: ModelAsset): Promise<void> {
  try {
    await store.reveal(item.id)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function handleRemove(item: ModelAsset): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定从模型库移除「${item.name}」？只移除登记记录，不会删除磁盘上的文件。`,
      '移除模型',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const ok = await store.remove(item.id)
  if (ok) ElMessage.success('已移除')
  else ElMessage.error('移除失败')
}

/* ------------------------------- 编辑元信息 ------------------------------- */

const dialogVisible = ref(false)
const editing = ref<ModelAsset | null>(null)
const form = reactive({
  name: '',
  source: 'unknown' as ModelSource,
  tags: [] as string[],
  note: ''
})

function openEdit(item: ModelAsset): void {
  editing.value = item
  form.name = item.name
  form.source = item.source
  form.tags = [...item.tags]
  form.note = item.note
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
        <p class="page-desc">
          登记从 Tripo、Meshy、Blender 导出的 3D 模型文件（glb / gltf / fbx / obj / blend）。
          模型库只记录路径与元信息，不复制文件；移除也只是出库。
        </p>
      </div>
      <el-button type="primary" :icon="Upload" :loading="importing" @click="handleImport">
        导入模型
      </el-button>
    </header>

    <section class="stat-grid">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-card__label">{{ item.label }}</span>
        <strong class="stat-card__value num">{{ item.value }}</strong>
      </article>
    </section>

    <section class="panel">
      <header class="panel__head">
        <div>
          <h2 class="panel__title">模型库</h2>
          <p class="panel__subtitle">
            共 {{ items.length }} 个 · 占用 {{ totalSize }}
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

      <div v-loading="loading" class="panel__body panel__body--flush">
        <el-table v-if="items.length > 0" :data="items" class="model-table">
          <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="model-name">
                <strong>{{ row.name }}</strong>
                <span v-if="row.exists === false" class="model-name__badge">文件丢失</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="light" :type="sourceMeta(row.source).tone">
                {{ sourceMeta(row.source).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="格式" width="90">
            <template #default="{ row }">
              <span class="mono">{{ String(row.format).toUpperCase() }}</span>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="110">
            <template #default="{ row }">
              <span class="num">{{ formatBytes(row.size) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="路径" min-width="240" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="mono text-muted">{{ row.path }}</span>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" width="160">
            <template #default="{ row }">
              <span class="num text-muted">{{ formatDateTime(row.updatedAt, true) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="190" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" :icon="FolderOpened" :disabled="row.exists === false" @click="handleReveal(row)">
                定位
              </el-button>
              <el-button link type="primary" size="small" :icon="EditPen" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" :icon="Delete" @click="handleRemove(row)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-empty v-else-if="!loading" :description="hasFilters ? '没有匹配的模型' : '模型库还是空的'">
          <el-button v-if="hasFilters" @click="store.resetFilters()">清空筛选</el-button>
          <el-button v-else type="primary" :icon="Upload" @click="handleImport">导入第一个模型</el-button>
        </el-empty>
      </div>
    </section>

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
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 20px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}

.stat-card__label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.stat-card__value {
  font-size: 26px;
  font-weight: 650;
  color: var(--text-primary);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar__search {
  width: 220px;
}

.toolbar__select {
  width: 140px;
}

.model-table {
  width: 100%;
}

.model-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.model-name strong {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-name__badge {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  color: var(--danger);
  background: var(--danger-soft);
}

.dialog-path {
  font-size: 12px;
  word-break: break-all;
}

@media (max-width: 1100px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .toolbar__search,
  .toolbar__select {
    width: 100%;
  }
}
</style>
