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

export type WorkflowCategory = 't2i' | 'i2i' | 'i2v' | 't2a' | 'split'

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
  /** 多参考图（图生图 2/3 参考图、图生视频等，按 LoadImage 节点顺序映射） */
  images?: string[]
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
  /** 需要上传几张参考图（按 LoadImage 节点数统计） */
  imageInputs?: number
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
  outputs: Array<{ node: string; classType: string; type: 'image' | 'video' | 'audio' }>
  /** 需要几张参考图（LoadImage 节点数） */
  imageInputs: number
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

/* -------------------------------- 3D 模型 -------------------------------- */

/** 模型来源工具：本地导入的模型分别由这三个工具导出 */
export type ModelSource = 'tripo' | 'meshy' | 'blender' | 'unknown'

export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'blend' | 'zip' | 'other'

/** 部件分组：把若干部件打成一个可命名、可导出的组（如「双手持枪」） */
export interface ModelPartGroup {
  id: string
  name: string
  /** ModelViewer 给出的稳定结构路径（如 "0.3.12"），跨次加载不变 */
  partKeys: string[]
  createdAt: string
}

/** 烘焙后的绑定姿态：每根骨骼的局部变换（按骨骼名存） */
export interface ModelBonePose {
  name: string
  position: [number, number, number]
  quaternion: [number, number, number, number]
}

export interface ModelAsset {
  id: string
  name: string
  /** 来源工具（按路径与扩展名自动识别，可在列表里手动改） */
  source: ModelSource
  format: ModelFormat
  /** 源文件绝对路径，库只做引用，不复制文件 */
  path: string
  /** 字节数 */
  size: number
  note: string
  tags: string[]
  /** 在实验台里保存的部件分组 */
  groups?: ModelPartGroup[]
  /** 绑定到模型的动作（动作库生成 / 精修后保存） */
  actions?: ModelAction[]
  /** 部件备注（part 结构路径 -> 备注文字），仅本地辅助，不写入模型文件 */
  partNotes?: Record<string, string>
  /** 烘焙到模型的绑定姿态；存在时所有动作都以它为基准 */
  bindPose?: ModelBonePose[]
  createdAt: string
  updatedAt: string
  /** 查询时实时计算（文件是否还在），不落库 */
  exists?: boolean
}

/** 一条骨骼轨道：times 严格递增，quats 是展平的局部四元数 (x,y,z,w) */
export interface ModelActionTrack {
  bone: string
  times: number[]
  quats: number[]
}

export type ModelActionOrigin = 'native' | 'library' | 'custom'

/** 绑定在模型上的动作片段 */
export interface ModelAction {
  id: string
  name: string
  duration: number
  loop: boolean
  fps: number
  origin: ModelActionOrigin
  /** origin=library 时记录动作库 kind */
  sourceKind?: string
  tracks: ModelActionTrack[]
  /** 是否经过手动精修 */
  edited: boolean
  createdAt: string
}

/** 外部动作文件（Mixamo FBX / glb），主进程读字节交给渲染层解析 */
export interface ActionAssetFile {
  name: string
  bytes: Uint8Array
}

export interface ModelActionInput {
  name: string
  duration: number
  loop: boolean
  fps?: number
  origin?: ModelActionOrigin
  sourceKind?: string
  tracks: ModelActionTrack[]
  edited?: boolean
}

export interface ModelInput {
  name?: string
  source?: ModelSource
  note?: string
  tags?: string[]
}

export interface ModelQuery {
  keyword?: string
  source?: ModelSource | 'all'
  format?: ModelFormat | 'all'
}

export interface ModelSummary {
  total: number
  /** 总体积（字节） */
  bytes: number
  bySource: Record<ModelSource, number>
}

export interface ModelImportResult {
  ok: boolean
  canceled: boolean
  /** 新入库数量 */
  added: number
  /** 已存在（同路径）跳过数量 */
  skipped: number
  items: ModelAsset[]
  message?: string
}

/** 密钥类配置的对外视图：永远不回传明文 */
export interface SecretState {
  configured: boolean
  /** 形如 sk-ab••••1a2b，未配置为空串 */
  masked: string
}

export interface ModelConfigView {
  defaultImportDir: string
  autoDetectSource: boolean
  tripo: SecretState
  meshy: SecretState
  /** 当前系统是否提供安全存储（Windows DPAPI / macOS Keychain） */
  secureStorage: boolean
}

export interface ModelConfigPatch {
  /** 传空串表示清除；不传表示不改 */
  tripoApiKey?: string
  meshyApiKey?: string
  defaultImportDir?: string
  autoDetectSource?: boolean
}

/** 落库形态：密钥可能是 `enc:v1:` 密文，渲染层不要直接使用 */
export interface ModelConfigStored {
  tripoApiKey: string
  meshyApiKey: string
  defaultImportDir: string
  autoDetectSource: boolean
}

export interface ModelExportResult {
  ok: boolean
  canceled?: boolean
  /** 导出文件路径 */
  path?: string
  /** 导出后自动登记进模型库的新资产 */
  asset?: ModelAsset
  bytes?: number
  message?: string
}

export interface ModelApi {
  list(query?: ModelQuery): Promise<ModelAsset[]>
  summary(): Promise<ModelSummary>
  /**
   * 导入模型：不传 paths 时打开系统文件选择框（支持多选）；
   * 传了 paths 则直接按这些路径入库（供拖拽导入 / 自动化验收使用）。
   */
  import(paths?: string[]): Promise<ModelImportResult>
  update(id: string, input: ModelInput): Promise<ModelAsset>
  remove(id: string): Promise<{ ok: boolean }>
  /** 读取模型文件字节（预览 / 实验台用），只读、不落盘 */
  readFile(id: string): Promise<Uint8Array>
  /** 在系统文件管理器中定位该模型 */
  reveal(id: string): Promise<void>
  /** 保存部件分组 */
  saveGroup(modelId: string, name: string, partKeys: string[]): Promise<ModelPartGroup>
  removeGroup(modelId: string, groupId: string): Promise<{ ok: boolean }>
  /** 保存一帧精修后的动作，绑定到模型 */
  saveAction(modelId: string, input: ModelActionInput): Promise<ModelAction>
  removeAction(modelId: string, actionId: string): Promise<{ ok: boolean }>
  /** 保存部件备注（空字符串 = 清除），返回该模型最新的备注表 */
  setPartNote(modelId: string, partKey: string, note: string): Promise<Record<string, string>>
  /** 选择并读取外部动作文件（.fbx / .glb / .gltf） */
  pickActionFiles(): Promise<ActionAssetFile[]>
  /** 保存/清除烘焙的绑定姿态（null = 恢复原始绑定姿态） */
  saveBindPose(modelId: string, pose: ModelBonePose[] | null): Promise<ModelAsset>
  /**
   * 导出一组部件为 glb 文件，并自动登记进模型库。
   * 不传 targetPath 时弹保存对话框（自动化测试可直接给路径）。
   */
  exportGroup(payload: {
    modelId: string
    name: string
    bytes: Uint8Array
    targetPath?: string
  }): Promise<ModelExportResult>
}

/** 密钥连通性检测结果 */
export interface ApiKeyTestResult {
  ok: boolean
  /** HTTP 状态码；网络层失败为 0 */
  status: number
  /** 可直接展示的结论，例如「可用 · 余额 1000」 */
  message: string
  latencyMs: number
  /** 远端返回的额度等附加信息 */
  detail?: string
}

export interface ModelConfigApi {
  get(): Promise<ModelConfigView>
  save(patch: ModelConfigPatch): Promise<ModelConfigView>
  pickImportDir(): Promise<string | null>
  /**
   * 检测 API Key 是否可用。
   * 传 apiKey 时测这次输入的值（还没保存也行），不传则测已保存的密钥。
   */
  test(tool: 'tripo' | 'meshy', apiKey?: string): Promise<ApiKeyTestResult>
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
  /** 切换系统全屏（F11 那种真全屏，不含应用内布局） */
  toggleFullscreen(): Promise<boolean>
  isFullscreen(): Promise<boolean>
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
  model: ModelApi
  modelConfig: ModelConfigApi
  python: PythonApi
  comfy: ComfyApi
}
