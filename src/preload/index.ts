import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/channels'
import type {
  ActionAssetFile,
  ApiKeyTestResult,
  AppSettings,
  AppSystemInfo,
  BackupResult,
  BridgeApi,
  ComfyJob,
  ComfyOutputData,
  ComfyParseResult,
  ComfyRunRequest,
  ComfyStatus,
  ComfyWorkflow,
  ModelAction,
  ModelActionInput,
  ComfyOutputFileList,
  PsdLayerImage,
  PsdLayerSheet,
  DollCharacter,
  DollCharacterInput,
  DollPartInput,
  PaperDollPart,
  MediaBatch,
  MediaItem,
  MediaSyncResult,
  ModelBonePose,
  ModelAsset,
  ModelConfigPatch,
  ModelConfigView,
  ModelExportResult,
  ModelImportResult,
  ModelInput,
  ModelPartGroup,
  ModelQuery,
  ModelSummary,
  PagedResult,
  PythonRuntimeInfo,
  PythonStatus,
  ResourceInput,
  ResourceItem,
  ResourceQuery,
  ResourceSummary,
  UpdateCheckResult,
  WorkflowCategory
} from '../shared/types'

/**
 * 渲染层唯一入口：只暴露明确的方法，不暴露 ipcRenderer / node API。
 */

const api: BridgeApi = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settings.get),
    save: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settings.save, patch),
    reset: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settings.reset),
    export: (): Promise<{ ok: boolean; file?: string; canceled?: boolean }> =>
      ipcRenderer.invoke(IPC.settings.export),
    import: (): Promise<{ ok: boolean; canceled?: boolean; settings?: AppSettings }> =>
      ipcRenderer.invoke(IPC.settings.import)
  },
  system: {
    info: (): Promise<AppSystemInfo> => ipcRenderer.invoke(IPC.system.info),
    openPath: (target: 'userData' | 'logs' | 'data' | 'models'): Promise<void> =>
      ipcRenderer.invoke(IPC.system.openPath, target),
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.system.pickDirectory),
    pickModelDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.system.pickModelDirectory),
    cacheSize: (): Promise<number> => ipcRenderer.invoke(IPC.system.cacheSize),
    clearCache: (): Promise<number> => ipcRenderer.invoke(IPC.system.clearCache),
    backupNow: (): Promise<BackupResult> => ipcRenderer.invoke(IPC.system.backupNow),
    checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.system.checkUpdate)
  },
  window: {
    minimize: (): void => ipcRenderer.send(IPC.window.minimize),
    toggleMaximize: (): void => ipcRenderer.send(IPC.window.toggleMaximize),
    close: (): void => ipcRenderer.send(IPC.window.close),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.isMaximized),
    toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.toggleFullscreen),
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.isFullscreen),
    setTitlebar: (options: { color: string; symbolColor: string }): void =>
      ipcRenderer.send(IPC.window.setTitlebar, options)
  },
  resource: {
    list: (query: ResourceQuery): Promise<PagedResult<ResourceItem>> =>
      ipcRenderer.invoke(IPC.resource.list, query),
    summary: (): Promise<ResourceSummary> => ipcRenderer.invoke(IPC.resource.summary),
    create: (input: ResourceInput): Promise<ResourceItem> =>
      ipcRenderer.invoke(IPC.resource.create, input),
    update: (id: string, input: Partial<ResourceInput>): Promise<ResourceItem> =>
      ipcRenderer.invoke(IPC.resource.update, id, input),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.resource.remove, id),
    categories: (): Promise<string[]> => ipcRenderer.invoke(IPC.resource.categories)
  },
  model: {
    list: (query?: ModelQuery): Promise<ModelAsset[]> => ipcRenderer.invoke(IPC.model.list, query),
    summary: (): Promise<ModelSummary> => ipcRenderer.invoke(IPC.model.summary),
    import: (paths?: string[]): Promise<ModelImportResult> =>
      ipcRenderer.invoke(IPC.model.import, paths),
    update: (id: string, input: ModelInput): Promise<ModelAsset> =>
      ipcRenderer.invoke(IPC.model.update, id, input),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.model.remove, id),
    readFile: (id: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.model.read, id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke(IPC.model.reveal, id),
    saveGroup: (modelId: string, name: string, partKeys: string[]): Promise<ModelPartGroup> =>
      ipcRenderer.invoke(IPC.model.saveGroup, modelId, name, partKeys),
    removeGroup: (modelId: string, groupId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.model.removeGroup, modelId, groupId),
    saveAction: (modelId: string, input: ModelActionInput): Promise<ModelAction> =>
      ipcRenderer.invoke(IPC.model.saveAction, modelId, input),
    removeAction: (modelId: string, actionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.model.removeAction, modelId, actionId),
    setPartNote: (modelId: string, partKey: string, note: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke(IPC.model.setPartNote, modelId, partKey, note),
    pickActionFiles: (): Promise<ActionAssetFile[]> => ipcRenderer.invoke(IPC.model.pickActionFiles),
    saveBindPose: (modelId: string, pose: ModelBonePose[] | null): Promise<ModelAsset> =>
      ipcRenderer.invoke(IPC.model.saveBindPose, modelId, pose),
    exportGroup: (payload: {
      modelId: string
      name: string
      bytes: Uint8Array
      targetPath?: string
    }): Promise<ModelExportResult> => ipcRenderer.invoke(IPC.model.exportGroup, payload)
  },
  modelConfig: {
    get: (): Promise<ModelConfigView> => ipcRenderer.invoke(IPC.modelConfig.get),
    save: (patch: ModelConfigPatch): Promise<ModelConfigView> =>
      ipcRenderer.invoke(IPC.modelConfig.save, patch),
    pickImportDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.modelConfig.pickDir),
    test: (tool: 'tripo' | 'meshy', apiKey?: string): Promise<ApiKeyTestResult> =>
      ipcRenderer.invoke(IPC.modelConfig.test, tool, apiKey)
  },
  python: {
    status: (): Promise<PythonStatus> => ipcRenderer.invoke(IPC.python.status),
    runtime: (): Promise<PythonRuntimeInfo> => ipcRenderer.invoke(IPC.python.runtime),
    restart: (): Promise<PythonRuntimeInfo> => ipcRenderer.invoke(IPC.python.restart)
  },
  comfy: {
    status: (): Promise<ComfyStatus> => ipcRenderer.invoke(IPC.comfy.status),
    workflows: (category?: WorkflowCategory): Promise<ComfyWorkflow[]> =>
      ipcRenderer.invoke(IPC.comfy.workflows, category),
    parseFile: (filePath?: string): Promise<ComfyParseResult> =>
      ipcRenderer.invoke(IPC.comfy.parse, filePath),
    uploadWorkflow: (payload: Parameters<BridgeApi['comfy']['uploadWorkflow']>[0]): Promise<ComfyWorkflow> =>
      ipcRenderer.invoke(IPC.comfy.upload, payload),
    removeWorkflow: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.comfy.remove, id),
    run: (request: ComfyRunRequest): Promise<{ jobId: string }> =>
      ipcRenderer.invoke(IPC.comfy.run, request),
    jobs: (category?: WorkflowCategory): Promise<ComfyJob[]> =>
      ipcRenderer.invoke(IPC.comfy.jobs, category),
    job: (jobId: string): Promise<ComfyJob | null> => ipcRenderer.invoke(IPC.comfy.job, jobId),
    cancel: (jobId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.comfy.cancel, jobId),
    uploadImage: (): Promise<{ ok: boolean; canceled?: boolean; name?: string }> =>
      ipcRenderer.invoke(IPC.comfy.uploadImage),
    uploadOutput: (filename: string, subfolder: string): Promise<{ ok: boolean; name?: string }> =>
      ipcRenderer.invoke(IPC.comfy.uploadOutput, filename, subfolder),
    outputFiles: (ext?: string, since?: number): Promise<ComfyOutputFileList> =>
      ipcRenderer.invoke(IPC.comfy.outputFiles, ext, since),
    psdLayers: (filename: string, subfolder: string, thumb?: number): Promise<PsdLayerSheet> =>
      ipcRenderer.invoke(IPC.comfy.psdLayers, filename, subfolder, thumb),
    psdLayerImage: (filename: string, subfolder: string, index: number): Promise<PsdLayerImage> =>
      ipcRenderer.invoke(IPC.comfy.psdLayerImage, filename, subfolder, index),
    output: (filename: string, subfolder: string, storage?: string): Promise<ComfyOutputData> =>
      ipcRenderer.invoke(IPC.comfy.output, filename, subfolder, storage),
    openComfy: (): Promise<void> => ipcRenderer.invoke(IPC.comfy.open)
  },
  media: {
    list: (): Promise<MediaItem[]> => ipcRenderer.invoke(IPC.media.list),
    sync: (): Promise<MediaSyncResult> => ipcRenderer.invoke(IPC.media.sync),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.media.remove, id),
    removeMany: (ids: string[]): Promise<{ removed: number }> =>
      ipcRenderer.invoke(IPC.media.removeMany, ids),
    batches: (): Promise<MediaBatch[]> => ipcRenderer.invoke(IPC.media.batches),
    removeBatch: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.media.removeBatch, id)
  },
  doll: {
    list: (): Promise<DollCharacter[]> => ipcRenderer.invoke(IPC.doll.list),
    parts: (): Promise<PaperDollPart[]> => ipcRenderer.invoke(IPC.doll.parts),
    createPart: (input: DollPartInput): Promise<PaperDollPart> =>
      ipcRenderer.invoke(IPC.doll.createPart, input),
    removePart: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.doll.removePart, id),
    create: (input: DollCharacterInput): Promise<DollCharacter> => ipcRenderer.invoke(IPC.doll.create, input),
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.doll.remove, id)
  }
}

contextBridge.exposeInMainWorld('api', api)
