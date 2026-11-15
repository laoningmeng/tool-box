<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import { RESOURCE_STATUS_META } from '@shared/constants'
import type { ResourceItem } from '@shared/types'
import { useResourceStore } from '@renderer/stores/resources'
import ResourceDialog from './components/ResourceDialog.vue'

/**
 * 通用 CRUD 页面模板：统计卡 + 筛选 + 表格 + 新建/编辑弹窗。
 * 换成真实业务时，把字段与文案按领域替换即可，交互结构不用动。
 */

const store = useResourceStore()
const { items, total, page, pageSize, keyword, category, status, loading, summary, totalPages } =
  storeToRefs(store)

const dialogVisible = ref(false)
const editing = ref<ResourceItem | null>(null)
const categories = ref<string[]>([])

const stats = computed(() => [
  { label: '资源总数', value: summary.value?.total ?? 0 },
  { label: '运行中', value: summary.value?.active ?? 0 },
  { label: '已暂停', value: summary.value?.paused ?? 0 },
  { label: '草稿', value: summary.value?.draft ?? 0 }
])

onMounted(async () => {
  await store.refresh()
  categories.value = await window.api.resource.categories()
})

function openCreate(): void {
  editing.value = null
  dialogVisible.value = true
}

function openEdit(item: ResourceItem): void {
  editing.value = item
  dialogVisible.value = true
}

async function handleRemove(item: ResourceItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${item.name}」？该操作不可恢复。`, '删除资源', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  const ok = await store.remove(item.id)
  if (ok) ElMessage.success('已删除')
  else ElMessage.error('删除失败')
}

async function handleSearch(): Promise<void> {
  page.value = 1
  await store.fetchList()
}

async function handleSaved(): Promise<void> {
  dialogVisible.value = false
  categories.value = await window.api.resource.categories()
  await store.refresh()
}
</script>

<template>
  <div class="app-page">
    <header class="page-head">
      <div>
        <h1 class="page-title">
          资源管理
          <span class="chip">{{ total }} 条</span>
        </h1>
        <p class="page-desc">
          通用 CRUD 模版：表格、筛选、分页、新建/编辑弹窗都已接好主进程数据库，替换字段即可复用。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建资源</el-button>
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
          <h2 class="panel__title">资源列表</h2>
          <p class="panel__subtitle">共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页</p>
        </div>
        <div class="toolbar">
          <el-input
            v-model="keyword"
            class="toolbar__search"
            placeholder="搜索名称 / 描述 / 标签"
            :prefix-icon="Search"
            clearable
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
          <el-select v-model="category" class="toolbar__select" placeholder="全部分组" clearable>
            <el-option label="全部分组" value="all" />
            <el-option v-for="item in categories" :key="item" :label="item" :value="item" />
          </el-select>
          <el-select v-model="status" class="toolbar__select">
            <el-option label="全部状态" value="all" />
            <el-option
              v-for="(meta, key) in RESOURCE_STATUS_META"
              :key="key"
              :label="meta.label"
              :value="key"
            />
          </el-select>
          <el-button :icon="Refresh" @click="store.refresh()">刷新</el-button>
        </div>
      </header>

      <div class="panel__body panel__body--flush">
        <el-table v-loading="loading" :data="items" class="resource-table">
          <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
          <el-table-column prop="category" label="分组" width="140" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="RESOURCE_STATUS_META[row.status as ResourceItem['status']].tone"
                effect="light"
              >
                {{ RESOURCE_STATUS_META[row.status as ResourceItem['status']].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="评分" width="90">
            <template #default="{ row }">
              <span class="num">{{ row.score }}</span>
            </template>
          </el-table-column>
          <el-table-column label="标签" min-width="160">
            <template #default="{ row }">
              <span v-for="tag in row.tags" :key="tag" class="chip chip--sm">{{ tag }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="handleRemove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <el-pagination
            :current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="prev, pager, next"
            background
            @current-change="store.setPage"
          />
        </div>
      </div>
    </section>

    <ResourceDialog
      v-model="dialogVisible"
      :record="editing"
      :categories="categories"
      @saved="handleSaved"
    />
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

.resource-table {
  width: 100%;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 14px 18px;
}

.chip--sm {
  margin-right: 6px;
  font-size: 11px;
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
