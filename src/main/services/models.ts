import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, safeStorage, shell } from 'electron'
import type {
  ApiKeyTestResult,
  ModelAction,
  ModelActionInput,
  ModelActionOrigin,
  ModelActionTrack,
  ModelBonePose,
  ModelAsset,
  ModelConfigPatch,
  ModelConfigView,
  ModelExportResult,
  ModelFormat,
  ModelImportResult,
  ModelInput,
  ModelPartGroup,
  ModelQuery,
  ModelSource,
  ModelSummary,
  SecretState
} from '../../shared/types'
import { getDb, now, persist } from '../store'
import { log } from '../logger'

/**
 * 3D 模型库：只登记「用户本机已导出的模型文件」，不复制文件、不托管内容。
 *
 * - 导入：系统文件选择框（多选）→ 读 size/mtime → 按路径与扩展名识别来源 → 入库
 * - 去重：同一绝对路径只登记一次（Windows 下不区分大小写）
 * - 密钥：API Key 用 Electron safeStorage 加密后落库，对外只返回掩码
 */

/** 支持的模型扩展名（Tripo / Meshy 直接下载 glb，Blender 可能是 blend/fbx/obj/glb） */
const MODEL_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'blend', 'zip', 'usdz', 'stl'] as const

const SOURCE_HINTS: Array<{ source: ModelSource; pattern: RegExp }> = [
  { source: 'tripo', pattern: /tripo/i },
  { source: 'meshy', pattern: /meshy/i },
  { source: 'blender', pattern: /blender/i }
]

const SECRET_PREFIX = 'enc:v1:'

/* ------------------------------- 路径与识别 ------------------------------- */

function formatOf(ext: string): ModelFormat {
  const lower = ext.replace('.', '').toLowerCase()
  if (lower === 'glb' || lower === 'gltf' || lower === 'fbx' || lower === 'obj' || lower === 'blend') {
    return lower
  }
  if (lower === 'zip') return 'zip'
  return 'other'
}

/** 先看路径/文件名里有没有工具特征，再退回按扩展名推断 */
function detectSource(filePath: string, autoDetect: boolean): ModelSource {
  if (autoDetect) {
    const haystack = filePath.replace(/\\/g, '/')
    for (const hint of SOURCE_HINTS) {
      if (hint.pattern.test(haystack)) return hint.source
    }
  }
  if (path.extname(filePath).toLowerCase() === '.blend') return 'blender'
  return 'unknown'
}

function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/* --------------------------------- 查询 --------------------------------- */

function matchesQuery(item: ModelAsset, query: ModelQuery): boolean {
  const keyword = query.keyword?.trim().toLowerCase()
  if (keyword) {
    const haystack = `${item.name} ${item.path} ${item.note} ${item.tags.join(' ')}`.toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  if (query.source && query.source !== 'all' && item.source !== query.source) return false
  if (query.format && query.format !== 'all' && item.format !== query.format) return false
  return true
}

export function listModels(query: ModelQuery = {}): ModelAsset[] {
  return getDb()
    .models.filter((item) => matchesQuery(item, query))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => ({ ...item, exists: fs.existsSync(item.path) }))
}

export function summarizeModels(): ModelSummary {
  const items = getDb().models
  const bySource: Record<ModelSource, number> = { tripo: 0, meshy: 0, blender: 0, unknown: 0 }
  let bytes = 0
  for (const item of items) {
    bySource[item.source] += 1
    bytes += item.size
  }
  return { total: items.length, bytes, bySource }
}

/* --------------------------------- 导入 --------------------------------- */

export async function importModels(
  win: BrowserWindow | null,
  requestedPaths?: string[]
): Promise<ModelImportResult> {
  const config = getDb().modelConfig
  let filePaths = requestedPaths?.filter((item) => Boolean(item?.trim())) ?? []

  if (filePaths.length === 0) {
    const options: Electron.OpenDialogOptions = {
      title: '导入 3D 模型',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '3D 模型', extensions: [...MODEL_EXTENSIONS] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    if (config.defaultImportDir && fs.existsSync(config.defaultImportDir)) {
      options.defaultPath = config.defaultImportDir
    }

    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true, added: 0, skipped: 0, items: [] }
    }
    filePaths = result.filePaths
  }

  const db = getDb()
  const existing = new Set(db.models.map((item) => normalizePath(item.path)))
  const added: ModelAsset[] = []
  let skipped = 0
  const errors: string[] = []

  for (const filePath of filePaths) {
    const key = normalizePath(filePath)
    if (existing.has(key)) {
      skipped += 1
      continue
    }
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) {
        skipped += 1
        continue
      }
      const stamp = now()
      const item: ModelAsset = {
        id: `mdl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: path.basename(filePath, path.extname(filePath)),
        source: detectSource(filePath, config.autoDetectSource),
        format: formatOf(path.extname(filePath)),
        path: path.resolve(filePath),
        size: stat.size,
        note: '',
        tags: [],
        createdAt: stamp,
        updatedAt: stamp
      }
      db.models.unshift(item)
      existing.add(key)
      added.push(item)
    } catch (error) {
      errors.push(`${path.basename(filePath)}：${(error as Error).message}`)
    }
  }

  if (added.length > 0) {
    persist()
    log('info', '导入 3D 模型', added.map((item) => `${item.source}:${item.name}`).join(', '))
  }

  return {
    ok: added.length > 0,
    canceled: false,
    added: added.length,
    skipped,
    items: added,
    message: errors.length ? errors.join('；') : undefined
  }
}

/* ------------------------------- 编辑与移除 ------------------------------- */

export function updateModel(id: string, input: ModelInput): ModelAsset {
  const target = getDb().models.find((item) => item.id === id)
  if (!target) throw new Error('模型不存在')
  if (input.name !== undefined) target.name = input.name.trim() || target.name
  if (input.source !== undefined) target.source = input.source
  if (input.note !== undefined) target.note = input.note.slice(0, 500)
  if (input.tags !== undefined) {
    target.tags = input.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12)
  }
  target.updatedAt = now()
  persist()
  return target
}

export function removeModel(id: string): { ok: boolean } {
  const db = getDb()
  const before = db.models.length
  db.models = db.models.filter((item) => item.id !== id)
  persist()
  return { ok: db.models.length < before }
}

export function revealModel(id: string): void {
  const target = getDb().models.find((item) => item.id === id)
  if (!target) throw new Error('模型不存在')
  if (!fs.existsSync(target.path)) throw new Error('文件已被移动或删除')
  shell.showItemInFolder(target.path)
}

/** 读取模型字节，供渲染层用 three.js 预览；大文件会有一次性拷贝开销 */
export function readModelFile(id: string): Uint8Array {
  const target = getDb().models.find((item) => item.id === id)
  if (!target) throw new Error('模型不存在')
  if (!fs.existsSync(target.path)) throw new Error('文件已被移动或删除')
  const buffer = fs.readFileSync(target.path)
  return new Uint8Array(buffer)
}

/* -------------------------------- 部件分组 -------------------------------- */

function requireModel(modelId: string): ModelAsset {
  const model = getDb().models.find((item) => item.id === modelId)
  if (!model) throw new Error('模型不存在')
  return model
}

export function saveModelGroup(modelId: string, name: string, partKeys: string[]): ModelPartGroup {
  const model = requireModel(modelId)
  const trimmed = name.trim()
  if (!trimmed) throw new Error('分组名称不能为空')
  if (partKeys.length === 0) throw new Error('请先选择部件')
  const group: ModelPartGroup = {
    id: `grp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: trimmed.slice(0, 40),
    partKeys: [...new Set(partKeys)].slice(0, 500),
    createdAt: now()
  }
  model.groups = [...(model.groups ?? []), group]
  model.updatedAt = now()
  persist()
  log('info', '保存部件分组', `${model.name} / ${group.name} (${group.partKeys.length})`)
  return group
}

export function removeModelGroup(modelId: string, groupId: string): { ok: boolean } {
  const model = requireModel(modelId)
  const before = model.groups?.length ?? 0
  model.groups = (model.groups ?? []).filter((item) => item.id !== groupId)
  model.updatedAt = now()
  persist()
  return { ok: (model.groups.length ?? 0) < before }
}

/** 单条轨道最多关键帧数 / 单个动作最多轨道数，防止脏数据把库撑爆 */
const MAX_KEYS_PER_TRACK = 600
const MAX_TRACKS_PER_ACTION = 640

function sanitizeActionInput(input: ModelActionInput): {
  name: string
  duration: number
  loop: boolean
  fps: number
  origin: ModelActionOrigin
  sourceKind?: string
  edited: boolean
  tracks: ModelActionTrack[]
} {
  const name = (input.name ?? '').trim().slice(0, 60) || '精修动作'
  const duration = Number(input.duration)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) {
    throw new Error('动作时长不合法')
  }
  const tracks: ModelActionTrack[] = []
  for (const track of input.tracks ?? []) {
    const bone = String(track?.bone ?? '').trim()
    const times = (track?.times ?? []).slice(0, MAX_KEYS_PER_TRACK)
    const quats = (track?.quats ?? []).slice(0, MAX_KEYS_PER_TRACK * 4)
    if (!bone || times.length === 0 || quats.length !== times.length * 4) continue
    tracks.push({
      bone,
      times: times.map((value) => Number(value.toFixed(4))),
      quats: quats.map((value) => Number(value.toFixed(6)))
    })
    if (tracks.length >= MAX_TRACKS_PER_ACTION) break
  }
  if (tracks.length === 0) throw new Error('动作没有可保存的骨骼轨道')
  return {
    name,
    duration: Number(duration.toFixed(4)),
    loop: Boolean(input.loop),
    fps: Math.min(Math.max(Math.round(input.fps ?? 30), 1), 120),
    origin: input.origin ?? 'custom',
    sourceKind: input.sourceKind,
    edited: Boolean(input.edited),
    tracks
  }
}

export function saveModelAction(modelId: string, input: ModelActionInput): ModelAction {
  const model = requireModel(modelId)
  const clean = sanitizeActionInput(input)
  const action: ModelAction = {
    id: `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    createdAt: now(),
    ...clean
  }
  model.actions = [...(model.actions ?? []), action]
  model.updatedAt = now()
  persist()
  log(
    'info',
    '绑定动作',
    `${model.name} / ${action.name}（${action.tracks.length} 根骨骼，${action.duration}s）`
  )
  return action
}

/** 部件备注：只存在本地库里，不写进模型文件；空字符串表示清除 */
export function setModelPartNote(modelId: string, partKey: string, note: string): Record<string, string> {
  const model = requireModel(modelId)
  const key = String(partKey ?? '').trim()
  if (!key || key.length > 64) throw new Error('部件标识不合法')
  const text = String(note ?? '').trim().slice(0, 24)
  const notes: Record<string, string> = { ...(model.partNotes ?? {}) }
  if (text) notes[key] = text
  else delete notes[key]
  model.partNotes = notes
  model.updatedAt = now()
  persist()
  log('info', '部件备注', `${model.name} / ${key} -> ${text || '(清除)'}`)
  return notes
}

/** 烘焙绑定姿态到模型（null = 清除，恢复模型原始绑定姿态） */
export function saveModelBindPose(modelId: string, pose: ModelBonePose[] | null): ModelAsset {
  const model = requireModel(modelId)
  if (pose === null) {
    delete model.bindPose
    log('info', '清除绑定姿态', model.name)
  } else {
    const clean: ModelBonePose[] = []
    for (const item of pose.slice(0, 500)) {
      if (!item || typeof item.name !== 'string' || !item.name) continue
      const position = toVec3(item.position)
      const quaternion = toQuat(item.quaternion)
      if (!position || !quaternion) continue
      clean.push({ name: item.name.slice(0, 96), position, quaternion })
    }
    if (clean.length === 0) throw new Error('绑定姿态数据为空')
    model.bindPose = clean
    log('info', '烘焙绑定姿态', `${model.name} / ${clean.length} 根骨骼`)
  }
  model.updatedAt = now()
  persist()
  return model
}

function toVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const out = value.map((item) => Number(item))
  if (out.some((item) => !Number.isFinite(item))) return null
  return [out[0], out[1], out[2]]
}

function toQuat(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const out = value.map((item) => Number(item))
  if (out.some((item) => !Number.isFinite(item))) return null
  return [out[0], out[1], out[2], out[3]]
}

export function removeModelAction(modelId: string, actionId: string): { ok: boolean } {
  const model = requireModel(modelId)
  const before = model.actions?.length ?? 0
  model.actions = (model.actions ?? []).filter((item) => item.id !== actionId)
  model.updatedAt = now()
  persist()
  return { ok: (model.actions.length ?? 0) < before }
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export'
}

export async function exportModelGroup(
  win: BrowserWindow | null,
  payload: { modelId: string; name: string; bytes: Uint8Array; targetPath?: string }
): Promise<ModelExportResult> {
  const model = requireModel(payload.modelId)
  const bytes = payload.bytes
  if (!bytes || bytes.length === 0) throw new Error('导出的模型没有数据')

  let targetPath = payload.targetPath?.trim() ?? ''
  if (!targetPath) {
    const options: Electron.SaveDialogOptions = {
      title: '导出分组模型',
      buttonLabel: '导出',
      defaultPath: path.join(
        path.dirname(model.path),
        `${safeFilePart(model.name)}_${safeFilePart(payload.name)}.glb`
      ),
      filters: [{ name: 'glTF 二进制', extensions: ['glb'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    targetPath = result.filePath
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, Buffer.from(bytes))

  const stat = fs.statSync(targetPath)
  const stamp = now()
  const asset: ModelAsset = {
    id: `mdl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: path.basename(targetPath, path.extname(targetPath)),
    source: model.source,
    format: 'glb',
    path: path.resolve(targetPath),
    size: stat.size,
    note: `由「${model.name}」的部件分组「${payload.name}」导出`,
    tags: ['分组导出'],
    createdAt: stamp,
    updatedAt: stamp
  }
  getDb().models.unshift(asset)
  persist()
  log('info', '导出部件分组', `${payload.name} -> ${targetPath} (${Math.round(stat.size / 1024)} KB)`)
  return { ok: true, path: targetPath, asset, bytes: stat.size }
}

/* ------------------------------ 配置与密钥 ------------------------------ */

function seal(value: string): string {
  const plain = value.trim()
  if (!plain) return ''
  if (plain.includes('•')) return plain // 防御：误传掩码时不动原值
  if (!safeStorage.isEncryptionAvailable()) return plain
  return SECRET_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

function open(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith(SECRET_PREFIX)) return stored
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'))
  } catch (error) {
    log('warn', '解密模型 API Key 失败', (error as Error).message)
    return ''
  }
}

function mask(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 8) return '••••••'
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`
}

function secretState(stored: string): SecretState {
  const plain = open(stored)
  return { configured: Boolean(plain), masked: mask(plain) }
}

export function getModelConfigView(): ModelConfigView {
  const config = getDb().modelConfig
  return {
    defaultImportDir: config.defaultImportDir,
    autoDetectSource: config.autoDetectSource,
    tripo: secretState(config.tripoApiKey),
    meshy: secretState(config.meshyApiKey),
    secureStorage: safeStorage.isEncryptionAvailable()
  }
}

export function saveModelConfig(patch: ModelConfigPatch): ModelConfigView {
  const config = getDb().modelConfig
  if (patch.tripoApiKey !== undefined) config.tripoApiKey = seal(patch.tripoApiKey)
  if (patch.meshyApiKey !== undefined) config.meshyApiKey = seal(patch.meshyApiKey)
  if (patch.defaultImportDir !== undefined) config.defaultImportDir = patch.defaultImportDir.trim()
  if (patch.autoDetectSource !== undefined) config.autoDetectSource = Boolean(patch.autoDetectSource)
  persist()
  log('info', '更新 3D 工具配置', `tripo=${patch.tripoApiKey !== undefined ? 'changed' : 'kept'} meshy=${patch.meshyApiKey !== undefined ? 'changed' : 'kept'}`)
  return getModelConfigView()
}

/** 选择外部动作文件（Mixamo FBX / glb），读成字节交给渲染层解析与重定向 */
export async function pickActionFiles(
  win: BrowserWindow | null
): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const options: Electron.OpenDialogOptions = {
    title: '导入外部动作（Mixamo FBX / glb）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '动作文件', extensions: ['fbx', 'glb', 'gltf'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return []
  const files: Array<{ name: string; bytes: Uint8Array }> = []
  for (const filePath of result.filePaths.slice(0, 20)) {
    try {
      const stat = await fs.promises.stat(filePath)
      // 单个动作文件限制 40MB，避免把整个动作包一次性读进来
      if (!stat.isFile() || stat.size > 40 * 1024 * 1024) continue
      const bytes = await fs.promises.readFile(filePath)
      files.push({ name: path.basename(filePath), bytes })
    } catch {
      // 跳过读不了的文件
    }
  }
  return files
}

export async function pickImportDir(win: BrowserWindow | null): Promise<string | null> {
  const current = getDb().modelConfig.defaultImportDir
  const options: Electron.OpenDialogOptions = {
    title: '选择默认导入目录',
    properties: ['openDirectory', 'createDirectory']
  }
  if (current && fs.existsSync(current)) options.defaultPath = current
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/* ------------------------------ 密钥连通性检测 ------------------------------ */

type ModelTool = 'tripo' | 'meshy'

/**
 * 两个平台的「余额」接口，都是纯读、调用免费，最适合用来验证 Key：
 * - Tripo: GET /v3/account/balance
 * - Meshy: GET /openapi/v1/balance
 * 国际站点不通时回退到国内域名。
 */
const BALANCE_ENDPOINTS: Record<ModelTool, string[]> = {
  tripo: ['https://openapi.tripo3d.com/v3/account/balance', 'https://openapi.tripo3d.ai/v3/account/balance'],
  meshy: ['https://api.meshy.ai/openapi/v1/balance', 'https://api.meshy.cn/openapi/v1/balance']
}

const TEST_TIMEOUT_MS = 12000

function pickBalance(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const nested = (record.data ?? {}) as Record<string, unknown>
  const balance = record.balance ?? nested.balance
  if (typeof balance === 'number') return `余额 ${balance}`
  if (typeof balance === 'string' && balance) return `余额 ${balance}`
  return ''
}

export async function testModelKey(tool: ModelTool, apiKey?: string): Promise<ApiKeyTestResult> {
  const config = getDb().modelConfig
  const stored = tool === 'tripo' ? config.tripoApiKey : config.meshyApiKey
  const key = (apiKey ?? '').trim() || open(stored)
  if (!key) {
    return { ok: false, status: 0, message: '还没有填写 API Key', latencyMs: 0 }
  }

  const endpoints = BALANCE_ENDPOINTS[tool]
  let lastError = ''
  for (const url of endpoints) {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal
      })
      const latencyMs = Date.now() - started
      const text = await response.text().catch(() => '')
      let payload: unknown = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }

      if (response.ok) {
        const detail = pickBalance(payload)
        return {
          ok: true,
          status: response.status,
          message: detail ? `可用 · ${detail}` : '可用',
          latencyMs,
          detail: detail || undefined
        }
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, message: '密钥无效或已过期（401/403）', latencyMs }
      }
      if (response.status === 402) {
        return { ok: false, status: 402, message: '密钥有效，但账户额度不足', latencyMs }
      }
      if (response.status === 429) {
        return { ok: false, status: 429, message: '密钥有效，但请求被限流，稍后再试', latencyMs }
      }
      const hint = text.slice(0, 120).replace(/\s+/g, ' ').trim()
      return {
        ok: false,
        status: response.status,
        message: `服务返回 HTTP ${response.status}`,
        latencyMs,
        detail: hint || undefined
      }
    } catch (error) {
      const latencyMs = Date.now() - started
      const aborted = (error as Error).name === 'AbortError'
      lastError = aborted ? '请求超时' : (error as Error).message
      log('warn', `检测 ${tool} API Key 失败（${url}）`, lastError, `${latencyMs}ms`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    ok: false,
    status: 0,
    message: `无法连接 ${tool === 'tripo' ? 'Tripo' : 'Meshy'} 服务：${lastError || '网络错误'}`,
    latencyMs: 0
  }
}
