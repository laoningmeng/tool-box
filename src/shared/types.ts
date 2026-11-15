/**
 * 全应用 IPC 契约：渲染层 ↔ 主进程 ↔ 本地后端。
 * 新增能力时先在这里加类型，再按 channels → preload → ipc → renderer 的顺序实现。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type LanguageCode = 'zh-CN' | 'en-US'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type BackupInterval = 'daily' | 'weekly' | 'manual'

export interface AppSettings {
  /** 产品名（标题栏、关于页展示） */
  systemName: string
  /** 公司 / 团队名 */
  company: string
  themeMode: ThemeMode
  /** 主题色（HEX），会动态生成 Element Plus 的 primary 色阶 */
  accentColor: string
  /** 紧凑布局 */
  compactMode: boolean
  /** 是否显示面包屑 */
  showBreadcrumb: boolean
  language: LanguageCode
  /** 时区标识，仅用于展示/业务扩展 */
  timezone: string
  /** 开机自启 */
  autoLaunch: boolean
  /** 最小化到托盘 */
  minimizeToTray: boolean
  /** 关闭到托盘 */
  closeToTray: boolean
  logLevel: LogLevel
  /** 最大并发任务数 */
  maxConcurrent: number
  /** 自动备份数据库 */
  autoBackup: boolean
  backupInterval: BackupInterval
  /** 退出时清理缓存 */
  clearCacheOnExit: boolean
  /** 数据目录（图片/导出等），留空用默认 */
  dataDir: string
  /** 模型目录（如需要本地模型） */
  modelDir: string
  /** ComfyUI 服务地址（工作流模块用） */
  comfyUrl: string
  /** 启动时拉起本地 Python 后端 */
  autoStartPython: boolean
}

export interface AppSystemInfo {
  appName: string
  appVersion: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  cpuModel: string
  cpuCores: number
  /** 已格式化的可读文本，例如 "39.9 GB / 63.8 GB" */
  totalMemory: string
  freeMemory: string
  /** 已格式化的运行时长，例如 "1 分钟" */
  uptime: string
  packaged: boolean
  userDataPath: string
  dataPath: string
  logsPath: string
}

export interface UpdateCheckResult {
  current: string
  latest: string
  hasUpdate: boolean
  notes?: string
  checkedAt: string
}

export interface BackupResult {
  ok: boolean
  filePath?: string
  size?: number
  message?: string
}

export interface PythonRuntimeInfo {
  available: boolean
  running: boolean
  version: string
  executable: string
  runtimeDir: string
  port: number
  backendVersion: string
  error?: string
}

export interface PythonStatus {
  ready: boolean
  version: string
  executable: string
  components: Record<string, boolean>
  error?: string
}

/* ------------------------------- 通用资源模块 ------------------------------- */

export interface ResourceItem {
  id: string
  name: string
  category: string
  tags: string[]
  description: string
  /** 0~100 的进度/健康度等，业务自行定义语义 */
  score: number
  status: 'active' | 'paused' | 'draft'
  createdAt: string
  updatedAt: string
}

export interface ResourceInput {
  name: string
  category: string
  tags: string[]
  description: string
  score: number
  status: ResourceItem['status']
}

export interface ResourceQuery {
  page: number
  pageSize: number
  keyword?: string
  category?: string
  status?: ResourceItem['status'] | 'all'
}

export interface PagedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ResourceSummary {
  total: number
  active: number
  paused: number
  draft: number
  categories: Array<{ name: string; count: number }>
}

/* -------------------------------- 工作流模块 -------------------------------- */

export type WorkflowCategory = 't2i' | 'i2i' | 'i2v'

export interface ComfyStatus {
  connected: boolean
  url: string
  version: string
  device: string
  vram: string
  queueRunning: number
  queuePending: number
  error: string
}

export interface ComfyInputs {
  prompt?: string
  negative?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  seed?: number
  image?: string
  denoise?: number
  frames?: number
  fps?: number
}

export interface ComfyWorkflow {
  id: string
  name: string
  category: WorkflowCategory
  description: string
  fileName: string
  nodeCount: number
  models: string[]
  tags: string[]
  builtin: boolean
  runnable: boolean
  format: string
  createdAt: string
  updatedAt: string
}

export interface ComfyParseReport {
  format: 'comfy-api' | 'comfy-ui' | 'unknown'
  fileName: string
  nodeCount: number
  classTypes: Array<{ classType: string; count: number }>
  models: string[]
  category: WorkflowCategory | null
  categoryConfidence: 'high' | 'medium' | 'low' | 'none'
  inputs: Partial<Record<string, boolean>>
  outputs: Array<{ node: string; classType: string; type: 'image' | 'video' }>
  runnable: boolean
  warnings: string[]
}

export interface ComfyParseResult {
  ok: boolean
  canceled?: boolean
  fileName?: string
  report?: ComfyParseReport
  graph?: Record<string, unknown>
}

export interface ComfyRunRequest {
  workflowId: string
  inputs: ComfyInputs
}

export interface ComfyJob {
  id: string
  workflowId: string
  workflowName: string
  category: WorkflowCategory
  status: 'running' | 'success' | 'failed' | 'canceled'
  progress: number
  message: string
  logs: string[]
  outputs: Array<{ filename: string; type: string; subfolder: string; bytes: number }>
  startedAt: number
  finishedAt: number | null
  elapsed: number
}

export interface ComfyOutputData {
  dataUrl: string
  mime: string
  bytes: number
}

/* ---------------------------------- API ---------------------------------- */

export interface SettingsApi {
  get(): Promise<AppSettings>
  save(patch: Partial<AppSettings>): Promise<AppSettings>
  reset(): Promise<AppSettings>
  export(): Promise<{ ok: boolean; file?: string; canceled?: boolean }>
  import(): Promise<{ ok: boolean; canceled?: boolean; settings?: AppSettings }>
}

export interface SystemApi {
  info(): Promise<AppSystemInfo>
  openPath(target: 'userData' | 'logs' | 'data' | 'models'): Promise<void>
  pickDirectory(): Promise<string | null>
  pickModelDirectory(): Promise<string | null>
  cacheSize(): Promise<number>
  clearCache(): Promise<number>
  backupNow(): Promise<BackupResult>
  checkUpdate(): Promise<UpdateCheckResult>
}

export interface WindowApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  /**
   * 同步 Windows 原生窗口按钮覆盖层（titleBarOverlay）的配色。
   * color 要等于自绘标题栏右端的纯色，否则右上角会出现一块不同颜色的矩形。
   */
  setTitlebar(options: { color: string; symbolColor: string }): void
}

export interface ResourceApi {
  list(query: ResourceQuery): Promise<PagedResult<ResourceItem>>
  summary(): Promise<ResourceSummary>
  create(input: ResourceInput): Promise<ResourceItem>
  update(id: string, input: Partial<ResourceInput>): Promise<ResourceItem>
  remove(id: string): Promise<{ ok: boolean }>
  categories(): Promise<string[]>
}

export interface PythonApi {
  status(): Promise<PythonStatus>
  runtime(): Promise<PythonRuntimeInfo>
  restart(): Promise<PythonRuntimeInfo>
}

export interface ComfyApi {
  status(): Promise<ComfyStatus>
  workflows(category?: WorkflowCategory): Promise<ComfyWorkflow[]>
  parseFile(filePath?: string): Promise<ComfyParseResult>
  uploadWorkflow(payload: {
    fileName: string
    name: string
    category: WorkflowCategory
    graph: Record<string, unknown>
    description?: string
    tags?: string[]
    runnable: boolean
    format: string
  }): Promise<ComfyWorkflow>
  removeWorkflow(id: string): Promise<{ ok: boolean }>
  run(request: ComfyRunRequest): Promise<{ jobId: string }>
  jobs(category?: WorkflowCategory): Promise<ComfyJob[]>
  job(jobId: string): Promise<ComfyJob | null>
  cancel(jobId: string): Promise<{ ok: boolean }>
  uploadImage(): Promise<{ ok: boolean; canceled?: boolean; name?: string }>
  output(filename: string, subfolder: string): Promise<ComfyOutputData>
  openComfy(): Promise<void>
}

export interface BridgeApi {
  settings: SettingsApi
  system: SystemApi
  window: WindowApi
  resource: ResourceApi
  python: PythonApi
  comfy: ComfyApi
}
