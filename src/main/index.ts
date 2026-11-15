import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron'
import { initStore, getDb, getLogsDir } from './store'
import { registerIpc } from './ipc'
import { pythonRunner } from './python'
import { log } from './logger'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

function resolveIcon(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.ico')
  ]
  return candidates.find((item) => item && fs.existsSync(item))
}

function createWindow(): void {
  const icon = resolveIcon()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f6fb',
    icon,
    // 使用自绘标题栏 + 系统窗口按钮覆盖层（Windows）
    // 这里的初始值对应「亮色主题」；渲染层启动后会按当前主题、并通过
    // window:set-titlebar 在切换主题时重新同步（见 src/renderer/src/stores/app.ts）
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f6f8fc',
      symbolColor: '#334155',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 实验台要一直跑 3D 动画，窗口失焦时不被 Chromium 降频
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray(): void {
  const icon = resolveIcon()
  if (!icon) return
  tray = new Tray(nativeImage.createFromPath(icon))
  tray.setToolTip('穷哥们的工具箱')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => mainWindow?.show() },
      {
        label: '退出',
        click: () => {
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => mainWindow?.show())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    initStore()
    registerIpc()
    log('info', '应用启动', app.getVersion(), process.platform, process.arch, 'logs:', getLogsDir())
    createWindow()
    createTray()

    if (getDb().settings.autoStartPython) {
      void pythonRunner.start()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void pythonRunner.stop()
  })
}
