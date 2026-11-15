import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { log } from './logger'

/**
 * 项目内置 Python 运行时的启动器：
 * - 使用 runtime/python 下的解释器，不依赖宿主机 Python
 * - 随机端口 + 每次启动生成的 token，仅监听 127.0.0.1
 * - 健康检查通过后才算「就绪」，失败时把 stderr 尾部带出来
 */

export interface RunnerStatus {
  available: boolean
  running: boolean
  port: number
  token: string
  version: string
  executable: string
  runtimeDir: string
  error: string
}

interface ApiEnvelope<T> {
  ok: boolean
  item?: T
  error?: string
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export class PythonRunner {
  private child: ChildProcess | null = null
  private port = 0
  private token = ''
  private ready = false
  private lastError = ''
  private starting: Promise<void> | null = null
  private versionCache = ''

  /** 解释器版本（如 3.11.18）：首次读取时同步执行 `python --version` 并缓存 */
  get version(): string {
    if (this.versionCache) return this.versionCache
    if (!this.available) return ''
    try {
      const output = execFileSync(this.executable, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      })
      this.versionCache = String(output).trim().replace(/^Python\s+/i, '')
    } catch (error) {
      log('warn', '读取 Python 版本失败', (error as Error).message)
      this.versionCache = ''
    }
    return this.versionCache
  }

  get runtimeDir(): string {
    if (process.env.APP_PYTHON_RUNTIME) return process.env.APP_PYTHON_RUNTIME
    if (app.isPackaged) return path.join(process.resourcesPath, 'runtime')
    return path.join(app.getAppPath(), 'runtime')
  }

  get executable(): string {
    const name = process.platform === 'win32' ? 'python.exe' : 'python3'
    return path.join(this.runtimeDir, 'python', name)
  }

  get available(): boolean {
    return fs.existsSync(this.executable)
  }

  get running(): boolean {
    return this.child !== null && this.ready
  }

  status(): RunnerStatus {
    return {
      available: this.available,
      running: this.running,
      port: this.port,
      token: this.token,
      version: this.version,
      executable: this.executable,
      runtimeDir: this.runtimeDir,
      error: this.lastError
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.starting) return this.starting
    this.starting = this.doStart().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async doStart(): Promise<void> {
    if (!this.available) {
      this.lastError = `未找到项目内置 Python 运行时：${this.executable}`
      log('warn', this.lastError)
      return
    }
    const serverFile = path.join(this.runtimeDir, 'backend', 'server.py')
    if (!fs.existsSync(serverFile)) {
      this.lastError = `未找到后端脚本：${serverFile}`
      log('warn', this.lastError)
      return
    }

    this.port = await findFreePort()
    this.token = Array.from({ length: 32 }, () =>
      '0123456789abcdef'[Math.floor(Math.random() * 16)]
    ).join('')

    const args = [
      serverFile,
      '--port',
      String(this.port),
      '--token',
      this.token,
      '--data-dir',
      path.join(app.getPath('userData'), 'data'),
      '--comfy-url',
      process.env.APP_COMFY_URL || 'http://127.0.0.1:8188',
      '--app-version',
      app.getVersion()
    ]

    // 清掉宿主机 Python 环境变量，确保用的是内置运行时
    const env = { ...process.env }
    delete env.PYTHONHOME
    delete env.PYTHONPATH
    env.PYTHONUNBUFFERED = '1'
    env.PYTHONIOENCODING = 'utf-8'

    const child = spawn(this.executable, args, {
      cwd: this.runtimeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => log('info', '[python]', chunk.trimEnd()))
    child.stderr?.on('data', (chunk: string) => log('warn', '[python]', chunk.trimEnd()))
    child.on('exit', (code) => {
      this.ready = false
      this.child = null
      log('warn', `Python 后端退出，code=${code}`)
    })

    const healthy = await this.waitHealthy(20000)
    if (!healthy) {
      this.lastError = 'Python 后端启动超时'
      log('error', this.lastError)
      return
    }
    this.ready = true
    this.lastError = ''
    log('info', 'Python 后端就绪 port', this.port)
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/health`, {
          headers: { 'X-App-Token': this.token }
        })
        if (response.ok) return true
      } catch {
        /* 还没起来 */
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  async ensureRunning(): Promise<void> {
    if (!this.running) await this.start()
    if (!this.running) throw new Error(this.lastError || 'Python 后端未就绪')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async stop(): Promise<void> {
    if (!this.child) return
    this.ready = false
    const child = this.child
    this.child = null
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }

  async request<T>(options: {
    method?: string
    path: string
    body?: unknown
    timeout?: number
  }): Promise<T> {
    await this.ensureRunning()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 30000)
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${options.path}`, {
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Token': this.token
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      })
      const payload = (await response.json()) as ApiEnvelope<T>
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `后端返回 ${response.status}`)
      }
      return payload as T
    } finally {
      clearTimeout(timer)
    }
  }

  async requestBuffer(pathname: string, timeout = 60000): Promise<Buffer> {
    await this.ensureRunning()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
        headers: { 'X-App-Token': this.token },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`后端返回 ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }
}

export const pythonRunner = new PythonRunner()
