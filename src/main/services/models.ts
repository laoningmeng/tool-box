import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, safeStorage, shell } from 'electron'
import type {
  ModelAsset,
  ModelConfigPatch,
  ModelConfigView,
  ModelFormat,
  ModelImportResult,
  ModelInput,
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
