import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type {
  ComfyParseReport,
  ComfyParseResult,
  ComfyWorkflow,
  WorkflowCategory
} from '../../shared/types'
import { getDb, now, persist } from '../store'
import { log } from '../logger'
import { cancelJob as cancelComfyJob } from './comfy'

/**
 * 流程导入与解析：
 * - 支持 ComfyUI 的 API 格式（Workflow → Save (API Format)）
 * - 界面格式（含 nodes/links）会给出明确提示，参考 docs 里的转换思路自行扩展
 */

function detectCategory(graph: Record<string, unknown>): WorkflowCategory | null {
  const types = new Set(
    Object.values(graph).map((node) => String((node as { class_type?: string })?.class_type ?? ''))
  )
  if (
    types.has('SVD_img2vid_Conditioning') ||
    types.has('CreateVideo') ||
    types.has('SaveVideo') ||
    types.has('SaveAnimatedWEBP')
  ) {
    return 'i2v'
  }
  if (types.has('LoadImage') && types.has('VAEEncode')) return 'i2i'
  if (types.has('EmptyLatentImage') && types.has('KSampler')) return 't2i'
  if (types.has('LoadImage') && types.has('KSampler')) return 'i2i'
  return null
}

function summarize(graph: Record<string, unknown>, fileName: string): ComfyParseReport {
  const nodes = Object.values(graph) as Array<{ class_type?: string; inputs?: Record<string, unknown> }>
  const classTypes = new Map<string, number>()
  const models = new Set<string>()
  const outputs: ComfyParseReport['outputs'] = []
  const modelKeys = ['ckpt_name', 'lora_name', 'vae_name', 'model_name', 'clip_name', 'unet_name']

  nodes.forEach((node, index) => {
    const type = String(node.class_type ?? 'unknown')
    classTypes.set(type, (classTypes.get(type) ?? 0) + 1)
    for (const key of modelKeys) {
      const value = node.inputs?.[key]
      if (typeof value === 'string' && value) models.add(value)
    }
    if (type === 'SaveImage' || type === 'PreviewImage') {
      outputs.push({ node: String(index), classType: type, type: 'image' })
    }
    if (type === 'SaveAnimatedWEBP' || type === 'SaveVideo' || type === 'VHS_VideoCombine') {
      outputs.push({ node: String(index), classType: type, type: 'video' })
    }
  })

  const isApi = nodes.every((node) => node && typeof node.class_type === 'string')
  const category = detectCategory(graph)
  return {
    format: isApi ? 'comfy-api' : 'unknown',
    fileName,
    nodeCount: nodes.length,
    classTypes: [...classTypes.entries()].map(([classType, count]) => ({ classType, count })),
    models: [...models],
    category,
    categoryConfidence: category ? 'high' : 'none',
    inputs: {
      prompt: classTypes.has('CLIPTextEncode'),
      negative: classTypes.has('CLIPTextEncode'),
      width: classTypes.has('EmptyLatentImage'),
      height: classTypes.has('EmptyLatentImage'),
      steps: classTypes.has('KSampler'),
      cfg: classTypes.has('KSampler'),
      seed: classTypes.has('KSampler'),
      image: classTypes.has('LoadImage')
    },
    outputs,
    runnable: isApi && nodes.length > 0,
    warnings: isApi
      ? []
      : ['该文件不是 ComfyUI API 格式：请在 ComfyUI 中使用「Workflow → Save (API Format)」导出后再上传']
  }
}

function readWorkflowPayload(filePath: string): { graph: Record<string, unknown>; report: ComfyParseReport } {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  const fileName = path.basename(filePath)
  // 允许导入「带 graph 字段」的包装文件
  const graph =
    raw && typeof raw === 'object' && 'graph' in raw && raw.graph && typeof raw.graph === 'object'
      ? (raw.graph as Record<string, unknown>)
      : raw
  const first = Object.values(graph)[0] as { class_type?: string } | undefined
  if (!first || typeof first !== 'object' || !first.class_type) {
    throw new Error('无法识别该流程文件：需要 ComfyUI 的 API 格式 JSON')
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
