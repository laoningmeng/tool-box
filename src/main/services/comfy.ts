import path from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import type {
  ComfyInputs,
  ComfyJob,
  ComfyOutputData,
  ComfyRunRequest,
  ComfyStatus,
  ComfyWorkflow,
  PsdLayerImage,
  PsdLayerSheet,
  WorkflowCategory
} from '../../shared/types'
import { getComfyUrl, getDb, persist } from '../store'
import { convertUiToApi, isUiWorkflow } from './workflow-convert'
import { pythonRunner } from '../python'
import { log } from '../logger'

/**
 * 工作流模块的主进程服务：
 * - 元数据存本地 JSON 数据库（store.workflows）
 * - 状态 / 执行 / 出图 通过内置 Python 后端代理到 ComfyUI
 */

interface ApiEnvelope<T> {
  ok: boolean
  item?: T
  items?: T
  error?: string
}

async function ensureBackend(): Promise<void> {
  if (!pythonRunner.available) {
    throw new Error(
      `未找到项目内置 Python 运行时（${pythonRunner.executable}），请先执行 npm run setup:python`
    )
  }
  await pythonRunner.ensureRunning()
}

export async function getComfyStatus(): Promise<ComfyStatus> {
  const url = getComfyUrl()
  // 状态查询是"探测"语义：后端不可用时返回带 error 的状态，而不是抛错，
  // 这样渲染层可以直接提示「未就绪」，其它 IPC 调用仍然会在需要时抛错。
  const degraded = (error: string): ComfyStatus => ({
    connected: false,
    url,
    version: '',
    device: '',
    vram: '',
    queueRunning: 0,
    queuePending: 0,
    error
  })

  if (!pythonRunner.available) {
    return degraded(
      `未找到项目内置 Python 运行时（${pythonRunner.executable}），请先执行 npm run setup:python`
    )
  }

  try {
    await pythonRunner.ensureRunning()
    const data = await pythonRunner.request<ApiEnvelope<ComfyStatus>>({
      path: '/api/comfy/status',
      timeout: 30000
    })
    return data.item ?? degraded('后端未返回 ComfyUI 状态')
  } catch (error) {
    return degraded((error as Error).message)
  }
}

export function listWorkflows(category?: WorkflowCategory): ComfyWorkflow[] {
  const items = getDb().workflows
  return category ? items.filter((item) => item.category === category) : items
}

export function removeWorkflow(id: string): { ok: boolean } {
  const db = getDb()
  const target = db.workflows.find((item) => item.id === id)
  if (!target) throw new Error('工作流不存在')
  db.workflows = db.workflows.filter((item) => item.id !== id)
  delete db.workflowGraphs[id]
  persist()
  log('info', '删除工作流', id)
  return { ok: true }
}

export async function runWorkflow(payload: {
  workflowId: string
  workflowName?: string
  category: WorkflowCategory
  graph: Record<string, unknown>
}): Promise<{ jobId: string }> {
  await ensureBackend()
  const data = await pythonRunner.request<ApiEnvelope<{ jobId?: string }>>({
    method: 'POST',
    path: '/api/comfy/run',
    body: payload,
    timeout: 60000
  })
  const jobId = data.item?.jobId
  if (!jobId) throw new Error('后端未返回任务 id')
  return { jobId }
}

export async function listJobs(category?: WorkflowCategory): Promise<ComfyJob[]> {
  await ensureBackend()
  const query = category ? `?category=${encodeURIComponent(category)}` : ''
  const data = await pythonRunner.request<ApiEnvelope<ComfyJob[]>>({
    path: `/api/comfy/jobs${query}`,
    timeout: 30000
  })
  return data.items ?? []
}

export interface ComfyHistoryEntry {
  promptId: string
  finishedAt: number | null
  outputs: Array<{
    filename: string
    subfolder: string
    type: string
    bytes: number
    key?: string
    label?: string
    storage?: string
  }>
}

/** 拉 ComfyUI 的历史输出（媒体库同步用） */
export async function getComfyHistory(maxItems = 200): Promise<ComfyHistoryEntry[]> {
  await ensureBackend()
  const data = await pythonRunner.request<ApiEnvelope<ComfyHistoryEntry[]>>({
    path: `/api/comfy/history?max_items=${maxItems}`,
    timeout: 60000
  })
  return data.items ?? []
}

export async function getJob(jobId: string): Promise<ComfyJob | null> {
  await ensureBackend()
  const data = await pythonRunner.request<ApiEnvelope<ComfyJob>>({
    path: `/api/comfy/jobs/${encodeURIComponent(jobId)}`,
    timeout: 30000
  })
  return data.item ?? null
}

export async function cancelJob(jobId: string): Promise<{ ok: boolean }> {
  await ensureBackend()
  await pythonRunner.request({
    method: 'POST',
    path: `/api/comfy/jobs/${encodeURIComponent(jobId)}/cancel`,
    timeout: 15000
  })
  return { ok: true }
}

/** 把 ComfyUI 输出（媒体库图片）复制到 input 目录，作为参考图使用 */
export async function uploadOutputForComfy(
  filename: string,
  subfolder: string
): Promise<{ ok: boolean; name?: string }> {
  await ensureBackend()
  const data = await pythonRunner.request<ApiEnvelope<{ name?: string }>>({
    method: 'POST',
    path: '/api/comfy/upload-output',
    body: { filename, subfolder },
    timeout: 120000
  })
  if (!data.item?.name) throw new Error('上传失败')
  return { ok: true, name: data.item.name }
}

/** 解析 PSD 图层清单（角色拆分结果的分层预览） */
export async function getPsdLayers(
  filename: string,
  subfolder: string,
  thumb = 160
): Promise<PsdLayerSheet> {
  await ensureBackend()
  const params = new URLSearchParams({ filename, subfolder, thumb: String(thumb) })
  const data = await pythonRunner.request<ApiEnvelope<PsdLayerSheet>>({
    method: 'GET',
    path: `/api/comfy/psd-layers?${params.toString()}`,
    timeout: 120000
  })
  if (!data.item) throw new Error('解析 PSD 失败')
  return data.item
}

/** 取 PSD 某层的完整图片 */
export async function getPsdLayerImage(
  filename: string,
  subfolder: string,
  index: number
): Promise<PsdLayerImage> {
  await ensureBackend()
  const params = new URLSearchParams({ filename, subfolder, index: String(index) })
  const data = await pythonRunner.request<ApiEnvelope<PsdLayerImage>>({
    method: 'GET',
    path: `/api/comfy/psd-layer-image?${params.toString()}`,
    timeout: 120000
  })
  if (!data.item) throw new Error('读取图层失败')
  return data.item
}

/** 列出 ComfyUI 输出目录里的文件（角色拆分产出的 PSD） */
export async function listOutputFiles(
  ext = 'psd',
  since?: number
): Promise<{
  dir: string
  files: Array<{ filename: string; subfolder?: string; bytes: number; mtime: number }>
  reason?: string
}> {
  await ensureBackend()
  const params = new URLSearchParams({ ext })
  if (since) params.set('since', String(since))
  const data = await pythonRunner.request<
    ApiEnvelope<{
      dir: string
      files: Array<{ filename: string; subfolder?: string; bytes: number; mtime: number }>
      reason?: string
    }>
  >({
    method: 'GET',
    path: `/api/comfy/output-files?${params.toString()}`,
    timeout: 20000
  })
  return data.item ?? { dir: '', files: [] }
}

export async function uploadImage(
  win: BrowserWindow | null
): Promise<{ ok: boolean; canceled?: boolean; name?: string }> {
  const options: Electron.OpenDialogOptions = {
    title: '选择源图（将上传到 ComfyUI 的 input 目录）',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }

  await ensureBackend()
  const data = await pythonRunner.request<ApiEnvelope<{ name?: string }>>({
    method: 'POST',
    path: '/api/comfy/upload',
    body: { path: result.filePaths[0] },
    timeout: 120000
  })
  if (!data.item?.name) throw new Error('上传失败')
  return { ok: true, name: data.item.name }
}

export async function getOutput(
  filename: string,
  subfolder: string,
  storage = 'output'
): Promise<ComfyOutputData> {
  await ensureBackend()
  const query = `?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(storage)}`
  const buffer = await pythonRunner.requestBuffer(`/api/comfy/output${query}`, 120000)
  const ext = path.extname(filename).toLowerCase()
  const mime =
    ext === '.mp4'
      ? 'video/mp4'
      : ext === '.webm'
        ? 'video/webm'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/png'
  return { mime, bytes: buffer.length, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
}

export async function openComfy(): Promise<void> {
  await shell.openExternal(getComfyUrl())
}

let objectInfoCache: { at: number; data: Record<string, any> } | null = null

/** 拉取 ComfyUI 的节点定义（界面格式转 API 格式时要用），缓存 5 分钟 */
export async function getObjectInfo(): Promise<Record<string, any> | null> {
  if (objectInfoCache && Date.now() - objectInfoCache.at < 5 * 60 * 1000) return objectInfoCache.data
  const url = getComfyUrl().replace(/\/+$/, '')
  try {
    const response = await fetch(url + '/object_info', { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, any>
    objectInfoCache = { at: Date.now(), data }
    return data
  } catch {
    return null
  }
}

/** 执行前统一图格式：界面格式（含子图）转成 ComfyUI 能吃的 API 格式 */
export async function prepareGraphForRun(graph: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isUiWorkflow(graph)) return graph
  const objectInfo = await getObjectInfo()
  const converted = convertUiToApi(graph, objectInfo)
  if (Object.keys(converted.graph).length === 0) {
    throw new Error('界面格式流程转换失败：没有解析出可执行节点')
  }
  if (converted.warnings.length > 0) {
    log('warn', '流程转换提示', converted.warnings.slice(0, 3).join(' | '))
  }
  return converted.graph as unknown as Record<string, unknown>
}

/** 供执行阶段注入参数：把界面参数写进图里（按节点类型匹配） */
export function injectInputs(graph: Record<string, unknown>, inputs: ComfyInputs): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(graph)) as Record<string, any>
  const findSampler = () =>
    Object.values(copy).find((node) => node?.class_type === 'KSampler' || node?.class_type === 'KSamplerAdvanced')
  const sampler = findSampler() as Record<string, any> | undefined
  if (sampler) {
    const samplerInputs = (sampler.inputs ??= {})
    // 只覆盖「字面量」参数：被连线驱动的输入（值是 [nodeId, slot]）交给流程自己控制，
    // 否则会把 turbo 流程的 8 步/CFG1 冲成 28/7，直接烧出杂色。
    const overridable = (key: string): boolean => typeof samplerInputs[key] === 'number'
    if (Number.isFinite(inputs.steps) && overridable('steps')) samplerInputs.steps = inputs.steps
    if (Number.isFinite(inputs.cfg) && overridable('cfg')) samplerInputs.cfg = inputs.cfg
    if (Number.isFinite(inputs.seed) && overridable('seed')) samplerInputs.seed = inputs.seed
    if (Number.isFinite(inputs.denoise) && overridable('denoise')) samplerInputs.denoise = inputs.denoise
  }
  // 多参考图：按 LoadImage 节点顺序依次注入（图生图 2/3 参考图、图生视频、角色拆分）
  const images = (inputs.images ?? []).filter((item) => typeof item === 'string' && item)
  if (images.length > 0) {
    const loadImageNodes = Object.entries(copy)
      .filter(([, node]) => node?.class_type === 'LoadImage')
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    loadImageNodes.forEach(([, node], index) => {
      const name = images[index] ?? images[images.length - 1]
      if (name) (node.inputs ??= {}).image = name
    })
  }
  // 音效类流程：提示词写在 WooshSample.prompt 上
  if (inputs.prompt) {
    for (const node of Object.values(copy) as Array<Record<string, any>>) {
      if (/^Woosh/.test(String(node?.class_type ?? '')) && typeof node.inputs?.prompt === 'string') {
        node.inputs.prompt = inputs.prompt
        break
      }
    }
  }
  // 正向提示词：优先写进「采样器 positive 指向的文本节点」，没有则退回第一个 CLIPTextEncode。
  // Qwen / Flux 这类流程用的是 TextEncodeQwenImage21 之类的自定义节点，字段名是 prompt 而不是 text。
  const writePrompt = (target: Record<string, any> | undefined, text: string): boolean => {
    if (!target) return false
    const nodeInputs = (target.inputs ??= {})
    if (typeof nodeInputs.text === 'string') {
      nodeInputs.text = text
      return true
    }
    if (typeof nodeInputs.prompt === 'string') {
      nodeInputs.prompt = text
      return true
    }
    return false
  }
  const resolveNode = (ref: unknown): Record<string, any> | undefined => {
    if (!Array.isArray(ref) || ref.length < 1) return undefined
    return copy[String(ref[0])] as Record<string, any> | undefined
  }
  let positiveConsumed = false
  if (inputs.prompt) {
    const positiveNode = resolveNode((sampler?.inputs as Record<string, any> | undefined)?.positive)
    positiveConsumed = writePrompt(positiveNode, inputs.prompt)
    if (positiveConsumed) inputs = { ...inputs, prompt: undefined }
  }
  // 负向提示词：采样器 negative 指向的节点里有 negative_prompt/text 就写进去
  if (inputs.negative) {
    const negativeNode = resolveNode((sampler?.inputs as Record<string, any> | undefined)?.negative)
    const negativeInputs = (negativeNode?.inputs ?? {}) as Record<string, unknown>
    if (typeof negativeInputs.negative_prompt === 'string') {
      negativeInputs.negative_prompt = inputs.negative
    } else if (typeof negativeInputs.text === 'string' && negativeNode !== resolveNode((sampler?.inputs as Record<string, any> | undefined)?.positive)) {
      negativeInputs.text = inputs.negative
    }
  }

  for (const node of Object.values(copy) as Array<Record<string, any>>) {
    const nodeInputs = (node.inputs ??= {})
    if (!positiveConsumed && node.class_type === 'CLIPTextEncode' && inputs.prompt && typeof nodeInputs.text === 'string') {
      // 只覆盖第一个文本节点，避免把负向提示词也换掉
      nodeInputs.text = inputs.prompt
      positiveConsumed = true
      inputs = { ...inputs, prompt: undefined }
    }
    if (/Empty.*Latent/.test(node.class_type)) {
      // 支持 EmptyLatentImage / EmptySD3LatentImage 等（Z-Image 用的是 SD3 版本）
      if (Number.isFinite(inputs.width) && typeof nodeInputs.width === 'number') nodeInputs.width = inputs.width
      if (Number.isFinite(inputs.height) && typeof nodeInputs.height === 'number') nodeInputs.height = inputs.height
    }
  }
  return copy
}
