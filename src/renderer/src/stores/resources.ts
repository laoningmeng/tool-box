import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  PagedResult,
  ResourceInput,
  ResourceItem,
  ResourceQuery,
  ResourceSummary
} from '@shared/types'

/** 通用 CRUD 模块 store：列表 / 分页 / 筛选 / 新增编辑删除 */
export const useResourceStore = defineStore('resources', () => {
  const items = ref<ResourceItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(12)
  const keyword = ref('')
  const category = ref('all')
  const status = ref<ResourceQuery['status']>('all')
  const loading = ref(false)
  const summary = ref<ResourceSummary | null>(null)

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
  const filtersActive = computed(() => Boolean(keyword.value) || category.value !== 'all' || status.value !== 'all')

  function buildQuery(): ResourceQuery {
    return {
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      category: category.value === 'all' ? undefined : category.value,
      status: status.value
    }
  }

  async function fetchList(): Promise<void> {
    loading.value = true
    try {
      const result: PagedResult<ResourceItem> = await window.api.resource.list(buildQuery())
      items.value = result.items
      total.value = result.total
    } finally {
      loading.value = false
    }
  }

  async function fetchSummary(): Promise<void> {
    summary.value = await window.api.resource.summary()
  }

  async function refresh(): Promise<void> {
    await Promise.all([fetchList(), fetchSummary()])
  }

  async function create(input: ResourceInput): Promise<ResourceItem> {
    const item = await window.api.resource.create(input)
    await refresh()
    return item
  }

  async function update(id: string, input: Partial<ResourceInput>): Promise<ResourceItem> {
    const item = await window.api.resource.update(id, input)
    await refresh()
    return item
  }

  async function remove(id: string): Promise<boolean> {
    const result = await window.api.resource.remove(id)
    await refresh()
    return result.ok
  }

  function setPage(next: number): void {
    page.value = Math.min(Math.max(1, next), totalPages.value)
    void fetchList()
  }

  function resetFilters(): void {
    keyword.value = ''
    category.value = 'all'
    status.value = 'all'
    page.value = 1
    void fetchList()
  }

  return {
    items,
    total,
    page,
    pageSize,
    keyword,
    category,
    status,
    loading,
    summary,
    totalPages,
    filtersActive,
    fetchList,
    fetchSummary,
    refresh,
    create,
    update,
    remove,
    setPage,
    resetFilters
  }
})
