import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

let minLevel: LogLevel = 'info'
let logFile = ''

export function getLogDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function ensureFile(): string {
  if (!logFile) {
    logFile = path.join(getLogDir(), 'main.log')
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
  }
  return logFile
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

export function log(level: LogLevel, ...args: unknown[]): void {
  const method: 'log' | 'info' | 'warn' | 'error' = level === 'debug' ? 'log' : level
  console[method]('[main]', ...args)
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return
  try {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${args
      .map((item) => (typeof item === 'string' ? item : safeString(item)))
      .join(' ')}\n`
    fs.appendFileSync(ensureFile(), line, 'utf-8')
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
