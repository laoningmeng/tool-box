import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import type {
  AppSettings,
  AppSystemInfo,
  BackupResult,
  ModelBonePose,
  ModelConfigPatch,
  ModelInput,
  ModelQuery,
  PagedResult,
  ResourceInput,
  ResourceItem,
  ResourceQuery,
  ResourceSummary,
  UpdateCheckResult
} from '../shared/types'
import { IPC } from '../shared/channels'
import {
  backupDatabase,
  createResource,
  dirSize,
  getBackupDir,
  getCacheDir,
  getDataDir,
  getDb,
  getLogsDir,
  getModelDir,
  persist,
  resetSettings,
  saveSettings
} from './store'
import { log, setLogLevel } from './logger'
import { pythonRunner } from './python'
import {
  getComfyStatus,
  listWorkflows,
  removeWorkflow,
  runWorkflow,
  listJobs,
  getJob,
  getOutput,
  getPsdLayerImage,
  getPsdLayers,
  listOutputFiles,
  uploadImage,
  uploadOutputForComfy,
  openComfy,
  injectInputs,
  prepareGraphForRun
} from './services/comfy'
import { parseWorkflowFile, uploadWorkflow, cancelJob } from './services/workflow'
import {
  listMedia,
  listMediaBatches,
  recordMediaFromJob,
  removeMedia,
  removeMediaBatch,
  removeMediaMany,
  syncMediaFromHistory
} from './services/media'
import {
  createDollCharacter,
  createDollPart,
  listDollCharacters,
  listDollParts,
  removeDollCharacter,
  removeDollPart
} from './services/doll'
import {
  exportModelGroup,
  getModelConfigView,
  importModels,
  listModels,
  pickActionFiles,
  pickImportDir,
  saveModelBindPose,
  readModelFile,
  removeModel,
  removeModelAction,
  removeModelGroup,
  revealModel,
  saveModelAction,
  saveModelConfig,
  saveModelGroup,
  setModelPartNote,
  summarizeModels,
  testModelKey,
  updateModel
} from './services/models'
import type { ComfyRunRequest, ModelActionInput, WorkflowCategory } from '../shared/types'

function listResources(query: ResourceQuery): PagedResult<ResourceItem> {
  const db = getDb()
  const keyword = (query.keyword ?? '').trim().toLowerCase()
  let items = db.resources
  if (keyword) {
    items = items.filter((item) =>
      [item.name, item.description, item.category, ...item.tags]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    )
  }
  if (query.category && query.category !== 'all') {
    items = items.filter((item) => item.category === query.category)
  }
  if (query.status && query.status !== 'all') {
    items = items.filter((item) => item.status === query.status)
  }
  const total = items.length
  const start = (query.page - 1) * query.pageSize
  return { items: items.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize }
}

export function registerIpc(): void {
  /* --------------------------------- 设置 --------------------------------- */
  ipcMain.handle(IPC.settings.get, () => getDb().settings)
  ipcMain.handle(IPC.settings.save, (_event, patch: Partial<AppSettings>) => {
    const next = saveSettings(patch)
    if (patch.logLevel) setLogLevel(patch.logLevel)
    if (patch.autoLaunch !== undefined) {
      app.setLoginItemSettings({ openAtLogin: Boolean(patch.autoLaunch) })
    }
    return next
  })
  ipcMain.handle(IPC.settings.reset, () => resetSettings())
  ipcMain.handle(IPC.settings.export, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: '导出设置',
      defaultPath: path.join(app.getPath('documents'), `${getDb().settings.systemName}-settings.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    fs.writeFileSync(result.filePath, JSON.stringify(getDb().settings, null, 2), 'utf-8')
    return { ok: true, file: result.filePath }
  })
  ipcMain.handle(IPC.settings.import, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '导入设置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    const raw = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8')) as Partial<AppSettings>
    return { ok: true, settings: saveSettings(raw) }
  })

  /* --------------------------------- 系统 --------------------------------- */
  ipcMain.handle(IPC.system.info, (): AppSystemInfo => {
    const os = require('node:os') as typeof import('node:os')
    const cpus = os.cpus()
    const gb = (value: number): string => `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
    const minutes = Math.max(1, Math.round(process.uptime() / 60))
    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus[0]?.model ?? '',
      cpuCores: cpus.length,
      totalMemory: gb(os.totalmem()),
      freeMemory: gb(os.freemem()),
      uptime: minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`,
      packaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
      dataPath: getDataDir(),
      logsPath: getLogsDir()
    }
  })
  ipcMain.handle(IPC.system.openPath, async (_event, target: 'userData' | 'logs' | 'data' | 'models') => {
    const map = {
      userData: app.getPath('userData'),
      logs: getLogsDir(),
      data: getDataDir(),
      models: getModelDir()
    }
    const dir = map[target] ?? getDataDir()
    fs.mkdirSync(dir, { recursive: true })
    // 用 explorer 打开，避免 shell.openPath 在受限会话下返回错误对话框
    if (process.platform === 'win32') {
      require('node:child_process').spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    await shell.openPath(dir)
  })
  ipcMain.handle(IPC.system.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.system.pickModelDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.system.cacheSize, () => dirSize(getCacheDir()))
  ipcMain.handle(IPC.system.clearCache, () => {
    const dir = getCacheDir()
    const size = dirSize(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    return size
  })
  ipcMain.handle(IPC.system.backupNow, (): BackupResult => {
    try {
      const backup = backupDatabase()
      log('info', '数据库备份完成', backup.file)
      return { ok: true, filePath: backup.file, size: backup.bytes }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })
  ipcMain.handle(IPC.system.checkUpdate, (): UpdateCheckResult => {
    // 本地应用：默认不做远端检查，接入更新服务后在这里替换实现
    const current = app.getVersion()
    return { current, latest: current, hasUpdate: false, checkedAt: new Date().toISOString() }
  })

  /* --------------------------------- 窗口 --------------------------------- */
  ipcMain.on(IPC.window.minimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on(IPC.window.toggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.window.close, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle(IPC.window.isMaximized, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
  ipcMain.handle(IPC.window.toggleFullscreen, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })
  ipcMain.handle(IPC.window.isFullscreen, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  })
  // 渲染层换主题 / 改标题栏配色时同步 Windows 原生窗口按钮区（titleBarOverlay）
  ipcMain.on(IPC.window.setTitlebar, (event, options: { color: string; symbolColor: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || process.platform !== 'win32') return
    if (!options?.color) return
    try {
      win.setTitleBarOverlay({
        color: options.color,
        symbolColor: options.symbolColor || '#e2e8f0',
        height: 44
      })
    } catch (error) {
      log('warn', '同步标题栏覆盖层失败', (error as Error).message)
    }
  })

  /* ------------------------------- 资源 CRUD ------------------------------- */
  ipcMain.handle(IPC.resource.list, (_event, query: ResourceQuery) => listResources(query))
  ipcMain.handle(IPC.resource.summary, (): ResourceSummary => {
    const items = getDb().resources
    const categories = new Map<string, number>()
    for (const item of items) categories.set(item.category, (categories.get(item.category) ?? 0) + 1)
    return {
      total: items.length,
      active: items.filter((item) => item.status === 'active').length,
      paused: items.filter((item) => item.status === 'paused').length,
      draft: items.filter((item) => item.status === 'draft').length,
      categories: [...categories.entries()].map(([name, count]) => ({ name, count }))
    }
  })
  ipcMain.handle(IPC.resource.create, (_event, input: ResourceInput) => createResource(input))
  ipcMain.handle(IPC.resource.update, (_event, id: string, input: Partial<ResourceInput>) => {
    const db = getDb()
    const target = db.resources.find((item) => item.id === id)
    if (!target) throw new Error('资源不存在')
    Object.assign(target, input, { updatedAt: new Date().toISOString() })
    persist()
    return target
  })
  ipcMain.handle(IPC.resource.remove, (_event, id: string) => {
    const db = getDb()
    const before = db.resources.length
    db.resources = db.resources.filter((item) => item.id !== id)
    persist()
    return { ok: db.resources.length < before }
  })
  ipcMain.handle(IPC.resource.categories, () => {
    return [...new Set(getDb().resources.map((item) => item.category))].filter(Boolean)
  })

  /* -------------------------------- 3D 模型 -------------------------------- */
  ipcMain.handle(IPC.model.list, (_event, query?: ModelQuery) => listModels(query ?? {}))
  ipcMain.handle(IPC.model.summary, () => summarizeModels())
  ipcMain.handle(IPC.model.import, (event, paths?: string[]) =>
    importModels(BrowserWindow.fromWebContents(event.sender), paths)
  )
  ipcMain.handle(IPC.model.update, (_event, id: string, input: ModelInput) => updateModel(id, input))
  ipcMain.handle(IPC.model.remove, (_event, id: string) => removeModel(id))
  ipcMain.handle(IPC.model.reveal, (_event, id: string) => revealModel(id))
  ipcMain.handle(IPC.model.read, (_event, id: string) => readModelFile(id))
  ipcMain.handle(IPC.model.saveGroup, (_event, modelId: string, name: string, partKeys: string[]) =>
    saveModelGroup(modelId, name, partKeys)
  )
  ipcMain.handle(IPC.model.removeGroup, (_event, modelId: string, groupId: string) =>
    removeModelGroup(modelId, groupId)
  )
  ipcMain.handle(IPC.model.saveAction, (_event, modelId: string, input: ModelActionInput) =>
    saveModelAction(modelId, input)
  )
  ipcMain.handle(IPC.model.removeAction, (_event, modelId: string, actionId: string) =>
    removeModelAction(modelId, actionId)
  )
  ipcMain.handle(IPC.model.setPartNote, (_event, modelId: string, partKey: string, note: string) =>
    setModelPartNote(modelId, partKey, note)
  )
  ipcMain.handle(IPC.model.saveBindPose, (_event, modelId: string, pose: ModelBonePose[] | null) =>
    saveModelBindPose(modelId, pose)
  )
  ipcMain.handle(IPC.model.pickActionFiles, (event) =>
    pickActionFiles(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(
    IPC.model.exportGroup,
    (event, payload: { modelId: string; name: string; bytes: Uint8Array; targetPath?: string }) =>
      exportModelGroup(BrowserWindow.fromWebContents(event.sender), payload)
  )
  ipcMain.handle(IPC.modelConfig.get, () => getModelConfigView())
  ipcMain.handle(IPC.modelConfig.save, (_event, patch: ModelConfigPatch) => saveModelConfig(patch))
  ipcMain.handle(IPC.modelConfig.pickDir, (event) => pickImportDir(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle(IPC.modelConfig.test, (_event, tool: 'tripo' | 'meshy', apiKey?: string) =>
    testModelKey(tool, apiKey)
  )

  /* --------------------------------- Python -------------------------------- */
  ipcMain.handle(IPC.python.status, async () => {
    try {
      const data = await pythonRunner.request<{ ok: boolean; item: Record<string, unknown> }>({
        path: '/api/status',
        timeout: 15000
      })
      return { ready: true, version: String(data.item?.version ?? ''), executable: pythonRunner.executable, components: {} }
    } catch (error) {
      return { ready: false, version: '', executable: pythonRunner.executable, components: {}, error: (error as Error).message }
    }
  })
  ipcMain.handle(IPC.python.runtime, async () => {
    if (!pythonRunner.running) await pythonRunner.start()
    return pythonRunner.status()
  })
  ipcMain.handle(IPC.python.restart, async () => {
    await pythonRunner.restart()
    return pythonRunner.status()
  })

  /* -------------------------------- ComfyUI -------------------------------- */
  ipcMain.handle(IPC.doll.list, () => listDollCharacters())
  ipcMain.handle(IPC.doll.create, (_event, input: Parameters<typeof createDollCharacter>[0]) =>
    createDollCharacter(input)
  )
  ipcMain.handle(IPC.doll.remove, (_event, id: string) => removeDollCharacter(id))
  ipcMain.handle(IPC.doll.parts, () => listDollParts())
  ipcMain.handle(IPC.doll.createPart, (_event, input: Parameters<typeof createDollPart>[0]) =>
    createDollPart(input)
  )
  ipcMain.handle(IPC.doll.removePart, (_event, id: string) => removeDollPart(id))
  ipcMain.handle(IPC.media.list, () => listMedia())
  ipcMain.handle(IPC.media.sync, () => syncMediaFromHistory())
  ipcMain.handle(IPC.media.remove, (_event, id: string) => removeMedia(id))
  ipcMain.handle(IPC.media.removeMany, (_event, ids: string[]) => removeMediaMany(ids))
  ipcMain.handle(IPC.media.batches, () => listMediaBatches())
  ipcMain.handle(IPC.media.removeBatch, (_event, id: string) => removeMediaBatch(id))
  ipcMain.handle(IPC.comfy.status, () => getComfyStatus())
  ipcMain.handle(IPC.comfy.workflows, (_event, category?: WorkflowCategory) => listWorkflows(category))
  ipcMain.handle(IPC.comfy.parse, async (event, filePath?: string) =>
    parseWorkflowFile(BrowserWindow.fromWebContents(event.sender), filePath)
  )
  ipcMain.handle(IPC.comfy.upload, (_event, payload: Parameters<typeof uploadWorkflow>[0]) => uploadWorkflow(payload))
  ipcMain.handle(IPC.comfy.remove, (_event, id: string) => removeWorkflow(id))
  ipcMain.handle(IPC.comfy.run, async (_event, request: ComfyRunRequest) => {
    const db = getDb()
    const workflow = db.workflows.find((item) => item.id === request.workflowId)
    const graph = db.workflowGraphs[request.workflowId]
    if (!workflow || !graph) throw new Error('工作流不存在或缺少流程定义')
    // 界面格式（含子图）先转成 API 格式，参数注入才能认出 KSampler / LoadImage 等节点
    const apiGraph = await prepareGraphForRun(graph)
    const injected = injectInputs(apiGraph, request.inputs)
    return runWorkflow({
      workflowId: workflow.id,
      workflowName: workflow.name,
      category: workflow.category,
      graph: injected
    })
  })
  ipcMain.handle(IPC.comfy.jobs, (_event, category?: WorkflowCategory) => listJobs(category))
  ipcMain.handle(IPC.comfy.job, async (_event, jobId: string) => {
    const job = await getJob(jobId)
    // 轮询到成功的瞬间就把产出登记进媒体库（失败不登记）
    if (job && job.status === 'success') recordMediaFromJob(job)
    return job
  })
  ipcMain.handle(IPC.comfy.cancel, (_event, jobId: string) => cancelJob(jobId))
  ipcMain.handle(IPC.comfy.uploadImage, async (event) =>
    uploadImage(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(IPC.comfy.uploadOutput, (_event, filename: string, subfolder: string) =>
    uploadOutputForComfy(filename, subfolder)
  )
  ipcMain.handle(IPC.comfy.output, (_event, filename: string, subfolder: string, storage?: string) =>
    getOutput(filename, subfolder, storage)
  )
  ipcMain.handle(IPC.comfy.outputFiles, (_event, ext?: string, since?: number) =>
    listOutputFiles(ext, since)
  )
  ipcMain.handle(IPC.comfy.psdLayers, (_event, filename: string, subfolder: string, thumb?: number) =>
    getPsdLayers(filename, subfolder, thumb)
  )
  ipcMain.handle(IPC.comfy.psdLayerImage, (_event, filename: string, subfolder: string, index: number) =>
    getPsdLayerImage(filename, subfolder, index)
  )
  ipcMain.handle(IPC.comfy.open, () => openComfy())

  // 备份目录在退出时可清理提示用
  void getBackupDir
}
