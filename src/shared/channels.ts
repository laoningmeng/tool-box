/** IPC 通道名集中管理：renderer / preload / main 三处共用，避免手写字符串。 */
export const IPC = {
  settings: {
    get: 'settings:get',
    save: 'settings:save',
    reset: 'settings:reset',
    export: 'settings:export',
    import: 'settings:import'
  },
  system: {
    info: 'system:info',
    openPath: 'system:open-path',
    pickDirectory: 'system:pick-directory',
    pickModelDirectory: 'system:pick-model-directory',
    cacheSize: 'system:cache-size',
    clearCache: 'system:clear-cache',
    backupNow: 'system:backup-now',
    checkUpdate: 'system:check-update'
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    setTitlebar: 'window:set-titlebar',
    toggleFullscreen: 'window:toggle-fullscreen',
    isFullscreen: 'window:is-fullscreen'
  },
  resource: {
    list: 'resource:list',
    summary: 'resource:summary',
    create: 'resource:create',
    update: 'resource:update',
    remove: 'resource:remove',
    categories: 'resource:categories'
  },
  model: {
    list: 'model:list',
    summary: 'model:summary',
    import: 'model:import',
    update: 'model:update',
    remove: 'model:remove',
    reveal: 'model:reveal',
    read: 'model:read',
    saveGroup: 'model:save-group',
    removeGroup: 'model:remove-group',
    exportGroup: 'model:export-group'
  },
  modelConfig: {
    get: 'model-config:get',
    save: 'model-config:save',
    pickDir: 'model-config:pick-dir',
    test: 'model-config:test'
  },
  python: {
    status: 'python:status',
    runtime: 'python:runtime',
    restart: 'python:restart'
  },
  comfy: {
    status: 'comfy:status',
    workflows: 'comfy:workflows',
    parse: 'comfy:parse',
    upload: 'comfy:upload-workflow',
    remove: 'comfy:remove-workflow',
    run: 'comfy:run',
    jobs: 'comfy:jobs',
    job: 'comfy:job',
    cancel: 'comfy:cancel',
    uploadImage: 'comfy:upload-image',
    output: 'comfy:output',
    open: 'comfy:open'
  }
} as const
