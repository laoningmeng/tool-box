import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  ModelAsset,
  ModelConfigPatch,
  ModelConfigView,
  ModelFormat,
  ModelImportResult,
  ModelInput,
  ModelSource,
  ModelSummary
} from '@shared/types'

/** 3D 模型模块 store：模型库列表 + 导入 + 3D 工具配置 */
export const useModelStore = defineStore('models', () => {
  const items = ref<ModelAsset[]>([])
  const summary = ref<ModelSummary | null>(null)
  const loading = ref(false)
  const importing = ref(false)
  const keyword = ref('')
  const source = ref<ModelSource | 'all'>('all')
  const format = ref<ModelFormat | 'all'>('all')
  const config = ref<ModelConfigView | null>(null)
  const configLoading = ref(false)

  const hasFilters = computed(
    () => Boolean(keyword.value.trim()) || source.value !== 'all' || format.value !== 'all'
  )

  async function fetchList(): Promise<void> {
    loading.value = true
    try {
      items.value = await window.api.model.list({
        keyword: keyword.value.trim() || undefined,
        source: source.value,
        format: format.value
      })
    } finally {
      loading.value = false
    }
  }

  async function fetchSummary(): Promise<void> {
    summary.value = await window.api.model.summary()
  }

  async function refresh(): Promise<void> {
    await Promise.all([fetchList(), fetchSummary()])
  }

  async function importModels(paths?: string[]): Promise<ModelImportResult> {
    importing.value = true
    try {
      const result = await window.api.model.import(paths)
      if (result.added > 0) await refresh()
      return result
    } finally {
      importing.value = false
    }
  }

  async function update(id: string, input: ModelInput): Promise<ModelAsset> {
    const item = await window.api.model.update(id, input)
    await refresh()
    return item
  }

  async function remove(id: string): Promise<boolean> {
    const result = await window.api.model.remove(id)
    await refresh()
    return result.ok
  }

  async function reveal(id: string): Promise<void> {
    await window.api.model.reveal(id)
  }

  /** 模型字节缓存（只留最近一个，避免 70MB 级别的模型堆内存） */
  let cachedId = ''
  let cachedBytes: Uint8Array | null = null

  async function readBytes(id: string): Promise<Uint8Array> {
    if (cachedId === id && cachedBytes) return cachedBytes
    const bytes = await window.api.model.readFile(id)
    cachedId = id
    cachedBytes = bytes
    return bytes
  }

  function resetFilters(): void {
    keyword.value = ''
    source.value = 'all'
    format.value = 'all'
    void fetchList()
  }

  async function loadConfig(): Promise<void> {
    configLoading.value = true
    try {
      config.value = await window.api.modelConfig.get()
    } finally {
      configLoading.value = false
    }
  }

  async function saveConfig(patch: ModelConfigPatch): Promise<ModelConfigView> {
    config.value = await window.api.modelConfig.save(patch)
    return config.value
  }

  async function pickImportDir(): Promise<string | null> {
    return window.api.modelConfig.pickImportDir()
  }

  return {
    items,
    summary,
    loading,
    importing,
    keyword,
    source,
    format,
    config,
    configLoading,
    hasFilters,
    fetchList,
    fetchSummary,
    refresh,
    importModels,
    update,
    remove,
    reveal,
    readBytes,
    resetFilters,
    loadConfig,
    saveConfig,
    pickImportDir
  }
})
