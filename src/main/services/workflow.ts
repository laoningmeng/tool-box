import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type {
  ComfyParseReport,
  ComfyParseResult,
  ComfyWorkflow,
  WorkflowCategory
} from '../../shared/types'
import {
  collectUiClassTypes,
  convertUiToApi,
  detectCategoryFromTypes,
  isUiWorkflow
} from './workflow-convert'
import { getDb, now, persist } from '../store'
import { log } from '../logger'
import { cancelJob as cancelComfyJob } from './comfy'

/**
 * 流程导入与解析：
 * - 支持 ComfyUI 的 API 格式（Workflow → Save (API Format)）
 * - 界面格式（含 nodes/links）会给出明确提示，参考 docs 里的转换思路自行扩展
 */

function typesOf(graph: Record<string, unknown>): string[] {
  if (isUiWorkflow(graph)) return collectUiClassTypes(graph)
  return Object.values(graph).map((node) => String((node as { class_type?: string })?.class_type ?? ''))
}

function apiGraphOf(graph: Record<string, unknown>): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  // 界面格式（含子图）先转成 API 图，统计节点 / 模型 / 输出都基于转换后的结果
  const converted = isUiWorkflow(graph) ? convertUiToApi(graph) : { graph: {}, warnings: [] as string[] }
  if (!isUiWorkflow(graph)) {
    return graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  }
  return converted.graph
}

function summarize(graph: Record<string, unknown>, fileName: string): ComfyParseReport {
  const ui = isUiWorkflow(graph)
  const types = typesOf(graph)
  const classTypes = new Map<string, number>()
  for (const type of types) classTypes.set(type, (classTypes.get(type) ?? 0) + 1)

  const api = apiGraphOf(graph)
  const models = new Set<string>()
  const outputs: ComfyParseReport['outputs'] = []
  const modelKeys = ['ckpt_name', 'lora_name', 'vae_name', 'model_name', 'clip_name', 'unet_name']
  let imageInputs = 0
  for (const [nodeId, node] of Object.entries(api)) {
    for (const key of modelKeys) {
      const value = node.inputs?.[key]
      if (typeof value === 'string' && value) models.add(value)
    }
    if (node.class_type === 'LoadImage' || node.class_type === 'LoadImageMask') imageInputs += 1
    if (node.class_type === 'SaveImage' || node.class_type === 'PreviewImage') {
      outputs.push({ node: nodeId, classType: node.class_type, type: 'image' })
    }
    if (node.class_type === 'SaveAnimatedWEBP' || node.class_type === 'SaveVideo' || node.class_type === 'VHS_VideoCombine') {
      outputs.push({ node: nodeId, classType: node.class_type, type: 'video' })
    }
    if (/^SaveAudio/.test(node.class_type)) {
      outputs.push({ node: nodeId, classType: node.class_type, type: 'audio' })
    }
  }

  // 采样默认值：执行页用它预填（turbo 流程 steps=8 / cfg=1，别用通用默认 28/7）
  const defaults: { steps?: number; cfg?: number; width?: number; height?: number } = {}
  for (const node of Object.values(api)) {
    if (defaults.steps === undefined && /^KSampler/.test(node.class_type)) {
      const steps = node.inputs?.steps
      const cfg = node.inputs?.cfg
      if (typeof steps === 'number') defaults.steps = steps
      if (typeof cfg === 'number') defaults.cfg = cfg
    }
    if (defaults.width === undefined && /Empty.*Latent/.test(node.class_type)) {
      const width = node.inputs?.width
      const height = node.inputs?.height
      if (typeof width === 'number') defaults.width = width
      if (typeof height === 'number') defaults.height = height
    }
  }

  const category = detectCategoryFromTypes(types)
  const nodeCount = Object.keys(api).length
  return {
    format: ui ? 'comfy-ui' : 'comfy-api',
    fileName,
    nodeCount,
    classTypes: [...classTypes.entries()].map(([classType, count]) => ({ classType, count })),
    models: [...models],
    category,
    categoryConfidence: category ? 'high' : 'none',
    inputs: {
      prompt: classTypes.has('CLIPTextEncode') || types.some((type) => /TextEncode|Woosh/.test(type)),
      negative: classTypes.has('CLIPTextEncode'),
      width: types.some((type) => /EmptyLatent|EmptySD3|ResolutionSelector/.test(type)),
      height: types.some((type) => /EmptyLatent|EmptySD3|ResolutionSelector/.test(type)),
      steps: types.includes('KSampler'),
      cfg: types.includes('KSampler'),
      seed: types.includes('KSampler'),
      image: imageInputs > 0
    },
    imageInputs,
    defaults,
    outputs,
    runnable: nodeCount > 0,
    warnings: ui
      ? []
      : nodeCount > 0
        ? []
        : ['流程图为空，无法解析出可执行节点']
  }
}

function readWorkflowPayload(filePath: string): { graph: Record<string, unknown>; report: ComfyParseReport } {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  const fileName = path.basename(filePath)
  // 支持两种格式：ComfyUI 界面格式（nodes 数组）与 API 格式（id -> {class_type}）
  if (isUiWorkflow(raw)) {
    const report = summarize(raw, fileName)
    if (report.nodeCount === 0) throw new Error('流程图为空：界面格式里没有可转换的节点')
    return { graph: raw, report }
  }
  // 允许导入「带 graph 字段」的包装文件
  const graph =
    raw && typeof raw === 'object' && 'graph' in raw && raw.graph && typeof raw.graph === 'object'
      ? (raw.graph as Record<string, unknown>)
      : raw
  const first = Object.values(graph)[0] as { class_type?: string } | undefined
  if (!first || typeof first !== 'object' || !first.class_type) {
    throw new Error('无法识别该流程文件：需要 ComfyUI 的 API 格式或界面格式 JSON')
  }
  return { graph, report: summarize(graph, fileName) }
}

export async function parseWorkflowFile(
  win: BrowserWindow | null,
  filePath?: string
): Promise<ComfyParseResult> {
  let target = filePath
  if (!target) {
    const options: Electron.OpenDialogOptions = {
      title: '上传流程（ComfyUI API 格式 JSON）',
      properties: ['openFile'],
      filters: [{ name: '流程文件', extensions: ['json'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    target = result.filePaths[0]
  }
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${target}`)
  const { graph, report } = readWorkflowPayload(target)
  log('info', '解析流程', report.fileName, report.format, report.nodeCount)
  return { ok: true, fileName: report.fileName, report, graph }
}

export function uploadWorkflow(payload: {
  fileName: string
  name: string
  category: WorkflowCategory
  graph: Record<string, unknown>
  description?: string
  tags?: string[]
  runnable: boolean
  format: string
}): ComfyWorkflow {
  const db = getDb()
  const id = `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const report = summarize(payload.graph, payload.fileName)
  const stamp = now()
  const item: ComfyWorkflow = {
    id,
    name: payload.name.trim() || path.basename(payload.fileName, '.json'),
    category: payload.category,
    description: payload.description?.trim() || report.warnings[0] || '',
    fileName: `${id}.json`,
    nodeCount: report.nodeCount,
    models: report.models,
    tags: payload.tags ?? report.models.slice(0, 2),
    builtin: false,
    runnable: payload.runnable,
    imageInputs: report.imageInputs,
    defaults: report.defaults,
    format: payload.format,
    createdAt: stamp,
    updatedAt: stamp
  }
  db.workflows.unshift(item)
  db.workflowGraphs[id] = payload.graph
  persist()
  log('info', '保存流程', item.name, item.category)
  return item
}

export function cancelJob(jobId: string): Promise<{ ok: boolean }> {
  return cancelComfyJob(jobId)
}
