import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  AppSettings,
  ComfyWorkflow,
  ModelAsset,
  DollCharacter,
  MediaItem,
  ModelConfigStored,
  ResourceItem
} from '../shared/types'
import {
  defaultModelConfig,
  defaultSettings,
  seedResources,
  seedWorkflows
} from '../shared/seed'

/**
 * 极简 JSON 数据库：单文件、原子写入、启动时合并默认值。
 * 业务量变大后可替换为 better-sqlite3，接口保持不变即可。
 */

export interface Database {
  version: number
  settings: AppSettings
  resources: ResourceItem[]
  workflows: ComfyWorkflow[]
  /** 工作流流程图，与元数据分开存，避免列表接口返回大对象 */
  workflowGraphs: Record<string, Record<string, unknown>>
  /** 3D 模型库（只存引用，不复制源文件） */
  models: ModelAsset[]
  /** 3D 工具配置（API Key 可能是 enc:v1: 密文） */
  modelConfig: ModelConfigStored
  /** 用户主动删掉的内置流程 id：不再自动补回来 */
  deletedBuiltinIds: string[]
  /** 媒体库：工作流生成结果的引用 */
  media: MediaItem[]
  /** 纸娃娃角色 */
  dollCharacters: DollCharacter[]
}

const DB_VERSION = 2
let db: Database | null = null
let dbFile = ''

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function now(): string {
  return new Date().toISOString()
}

export function getDataDir(): string {
  const dir = db?.settings.dataDir?.trim()
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  const fallback = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(fallback, { recursive: true })
  return fallback
}

export function getLogsDir(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getBackupDir(): string {
  const dir = path.join(app.getPath('userData'), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getModelDir(): string {
  const dir = db?.settings.modelDir?.trim()
  const target = dir || path.join(app.getPath('userData'), 'models')
  fs.mkdirSync(target, { recursive: true })
  return target
}

export function getComfyUrl(): string {
  return db?.settings.comfyUrl?.trim() || 'http://127.0.0.1:8188'
}

function seedDatabase(): Database {
  const stamp = now()
  return {
    version: DB_VERSION,
    settings: { ...defaultSettings },
    resources: seedResources.map((item, index) => ({
      ...item,
      id: `res_seed${index + 1}`,
      createdAt: stamp,
      updatedAt: stamp
    })),
    workflows: seedWorkflows.map((item) => {
      const { graph: _graph, ...rest } = item
      return {
        ...rest,
        fileName: `${item.id}.json`,
        createdAt: '',
        updatedAt: ''
      }
    }),
    workflowGraphs: Object.fromEntries(
      seedWorkflows.map((item) => [item.id, item.graph as Record<string, unknown>])
    ),
    // 模型库默认为空：这些文件在用户本机，不能伪造示例路径
    models: [],
    modelConfig: { ...defaultModelConfig },
    deletedBuiltinIds: [],
    media: [],
    dollCharacters: []
  }
}

/** 从 seed 里取内置工作流的图（运行时按 id 查找） */
export function getBuiltinGraph(id: string): Record<string, unknown> | null {
  const found = seedWorkflows.find((item) => item.id === id)
  return found ? (found.graph as Record<string, unknown>) : null
}

/** 老数据库补齐新增的内置流程（按 id 去重，不覆盖用户自己上传的） */
function mergeBuiltinWorkflows(existing: ComfyWorkflow[], deleted: Set<string> = new Set()): ComfyWorkflow[] {
  const seedById = new Map(seedWorkflows.map((seed) => [seed.id, seed]))
  // 老库里已存在的内置流程：补齐后加的字段（默认采样参数、参考图数、格式）
  const list = existing.map((item) => {
    const seed = seedById.get(item.id)
    if (!seed) return item
    return {
      ...item,
      format: item.format || seed.format,
      imageInputs: item.imageInputs ?? seed.imageInputs,
      defaults: item.defaults ?? seed.defaults
    }
  })
  for (const seed of seedWorkflows) {
    if (deleted.has(seed.id)) continue
    if (list.some((item) => item.id === seed.id)) continue
    const { graph: _graph, ...rest } = seed
    list.push({ ...rest, fileName: `${seed.id}.json`, createdAt: '', updatedAt: '' })
  }
  return list
}

function mergeBuiltinGraphs(
  existing: Record<string, Record<string, unknown>>,
  deleted: Set<string> = new Set()
): Record<string, Record<string, unknown>> {
  const graphs = { ...existing }
  for (const seed of seedWorkflows) {
    if (deleted.has(seed.id)) continue
    if (!graphs[seed.id]) graphs[seed.id] = seed.graph as Record<string, unknown>
  }
  return graphs
}

function mergeDefaults(raw: Partial<Database>): Database {
  const base = seedDatabase()
  return {
    version: DB_VERSION,
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    resources: Array.isArray(raw.resources) ? (raw.resources as ResourceItem[]) : base.resources,
    workflows: mergeBuiltinWorkflows(
      Array.isArray(raw.workflows) ? (raw.workflows as ComfyWorkflow[]) : base.workflows,
      new Set(raw.deletedBuiltinIds ?? [])
    ),
    workflowGraphs: mergeBuiltinGraphs(
      raw.workflowGraphs && typeof raw.workflowGraphs === 'object'
        ? (raw.workflowGraphs as Record<string, Record<string, unknown>>)
        : base.workflowGraphs,
      new Set(raw.deletedBuiltinIds ?? [])
    ),
    models: Array.isArray(raw.models) ? (raw.models as ModelAsset[]) : base.models,
    modelConfig: { ...base.modelConfig, ...(raw.modelConfig ?? {}) },
    deletedBuiltinIds: Array.isArray(raw.deletedBuiltinIds) ? raw.deletedBuiltinIds : [],
    media: Array.isArray(raw.media) ? (raw.media as MediaItem[]) : [],
    dollCharacters: Array.isArray(raw.dollCharacters) ? (raw.dollCharacters as DollCharacter[]) : []
  }
}

export function initStore(): void {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  dbFile = path.join(dir, 'database.json')
  if (fs.existsSync(dbFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dbFile, 'utf-8')) as Partial<Database>
      db = mergeDefaults(raw)
    } catch {
      db = seedDatabase()
    }
  } else {
    db = seedDatabase()
  }
  persist()
  // 统一使用用户数据目录下的数据目录
  fs.mkdirSync(path.join(app.getPath('userData'), 'data'), { recursive: true })
}

export function getDb(): Database {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

export function persist(): void {
  if (!db || !dbFile) return
  const temp = `${dbFile}.tmp`
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), 'utf-8')
  fs.renameSync(temp, dbFile)
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getDb()
  current.settings = { ...current.settings, ...patch }
  persist()
  return current.settings
}

export function resetSettings(): AppSettings {
  const current = getDb()
  current.settings = { ...defaultSettings }
  persist()
  return current.settings
}

export function createResource(input: Omit<ResourceItem, 'id' | 'createdAt' | 'updatedAt'>): ResourceItem {
  const stamp = now()
  const item: ResourceItem = { ...input, id: generateId('res'), createdAt: stamp, updatedAt: stamp }
  getDb().resources.unshift(item)
  persist()
  return item
}

export function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(target)
    else {
      try {
        total += fs.statSync(target).size
      } catch {
        /* 忽略占用中的文件 */
      }
    }
  }
  return total
}

/** 备份数据库到 backups/，返回备份文件与大小 */
export function backupDatabase(): { file: string; bytes: number } {
  persist()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(getBackupDir(), `database-${stamp}.json`)
  fs.copyFileSync(dbFile, target)
  return { file: target, bytes: fs.statSync(target).size }
}

export function getWorkflowGraph(id: string): Record<string, unknown> | null {
  return getDb().workflowGraphs[id] ?? null
}

export function setWorkflowGraph(id: string, graph: Record<string, unknown>): void {
  getDb().workflowGraphs[id] = graph
  persist()
}

export function deleteWorkflowGraph(id: string): void {
  delete getDb().workflowGraphs[id]
  persist()
}