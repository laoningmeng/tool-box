import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  ComfyInputs,
  ComfyJob,
  ComfyParseResult,
  ComfyStatus,
  ComfyWorkflow,
  WorkflowCategory
} from '@shared/types'

/** 工作流模块 store：流程库 + ComfyUI 连接状态 + 执行任务轮询 */
export const useWorkflowStore = defineStore('workflow', () => {
  const workflows = ref<ComfyWorkflow[]>([])
  const status = ref<ComfyStatus | null>(null)
  const loading = ref(false)
  const statusLoading = ref(false)

  const job = ref<ComfyJob | null>(null)
  const outputs = ref<Array<{ filename: string; dataUrl: string; type: string }>>([])
  const running = ref(false)

  let timer: ReturnType<typeof setInterval> | null = null

  const connected = computed(() => Boolean(status.value?.connected))

  function byCategory(category: WorkflowCategory): ComfyWorkflow[] {
    return workflows.value.filter((item) => item.category === category)
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      workflows.value = await window.api.comfy.workflows()
    } finally {
      loading.value = false
    }
  }

  async function loadStatus(): Promise<void> {
    statusLoading.value = true
    try {
      status.value = await window.api.comfy.status()
    } catch (error) {
      status.value = {
        connected: false,
        url: '',
        version: '',
        device: '',
        vram: '',
        queueRunning: 0,
        queuePending: 0,
        error: (error as Error).message
      }
    } finally {
      statusLoading.value = false
    }
  }

  function parseFile(filePath?: string): Promise<ComfyParseResult> {
    return window.api.comfy.parseFile(filePath)
  }

  async function upload(payload: Parameters<typeof window.api.comfy.uploadWorkflow>[0]): Promise<ComfyWorkflow> {
    const item = await window.api.comfy.uploadWorkflow(payload)
    await refresh()
    return item
  }

  async function remove(id: string): Promise<void> {
    await window.api.comfy.removeWorkflow(id)
    await refresh()
  }

  async function loadOutputs(current: ComfyJob): Promise<void> {
    const loaded: Array<{ filename: string; dataUrl: string; type: string }> = []
    for (const item of current.outputs) {
      try {
        const data = await window.api.comfy.output(item.filename, item.subfolder)
        loaded.push({ filename: item.filename, dataUrl: data.dataUrl, type: item.type })
      } catch {
        /* 单个结果失败不影响其它 */
      }
    }
    outputs.value = loaded
  }

  function stopPolling(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  async function run(workflow: ComfyWorkflow, inputs: ComfyInputs): Promise<void> {
    if (running.value) return
    running.value = true
    job.value = null
    outputs.value = []
    try {
      const { jobId } = await window.api.comfy.run({ workflowId: workflow.id, inputs })
      stopPolling()
      timer = setInterval(async () => {
        const current = await window.api.comfy.job(jobId)
        if (!current) return
        job.value = current
        if (current.status === 'running') return
        stopPolling()
        running.value = false
        if (current.status === 'success') void loadOutputs(current)
      }, 1200)
    } catch (error) {
      running.value = false
      throw error
    }
  }

  async function cancel(): Promise<void> {
    if (!job.value) return
    await window.api.comfy.cancel(job.value.id)
    stopPolling()
    running.value = false
  }

  return {
    workflows,
    status,
    loading,
    statusLoading,
    job,
    outputs,
    running,
    connected,
    byCategory,
    refresh,
    loadStatus,
    parseFile,
    upload,
    remove,
    run,
    cancel,
    loadOutputs,
    stopPolling
  }
})
