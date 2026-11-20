import type { ComfyJob, MediaItem, MediaKind, MediaSyncResult } from '../../shared/types'
import { getDb, now, persist } from '../store'
import { log } from '../logger'
import { getComfyHistory } from './comfy'

/**
 * 媒体库：把工作流生成的结果（图片/视频/音频）登记到本地库。
 * - 执行完毕（主进程轮询到 success）时即登记一次
 * - 也可以手动「同步 ComfyUI 历史」：把 ComfyUI 自己 history 里的输出补进来
 * 只存引用（filename + subfolder），真实文件仍在 ComfyUI 的 output 目录。
 */

function detectKind(filename: string, fallback?: string): MediaKind {
  const lower = filename.toLowerCase()
  if (/\.(png|jpe?g|webp|bmp|tiff?)$/.test(lower)) return 'image'
  if (/\.(mp4|webm|mov|mkv|gif|apng)$/.test(lower)) return 'video'
  if (/\.(mp3|wav|flac|ogg|m4a|aac|opus)$/.test(lower)) return 'audio'
  return (fallback as MediaKind) ?? 'image'
}

function makeId(prefix: string, filename: string, subfolder: string): string {
  return `${prefix}:${subfolder ? `${subfolder}/` : ''}${filename}`
}

export function listMedia(): MediaItem[] {
  return [...(getDb().media ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function removeMedia(id: string): { ok: boolean } {
  const db = getDb()
  const before = db.media.length
  db.media = db.media.filter((item) => item.id !== id)
  if (db.media.length === before) return { ok: false }
  persist()
  return { ok: true }
}

function hasFile(filename: string, subfolder: string): boolean {
  return (getDb().media ?? []).some(
    (item) => item.filename === filename && (item.subfolder ?? '') === (subfolder ?? '')
  )
}

/** 任务成功时登记它产出的文件（轮询到 success 就会走到这里） */
export function recordMediaFromJob(job: ComfyJob): number {
  const db = getDb()
  let added = 0
  for (const output of job.outputs ?? []) {
    const subfolder = output.subfolder ?? ''
    if (hasFile(output.filename, subfolder)) continue
    const item: MediaItem = {
      id: makeId(job.id, output.filename, subfolder),
      filename: output.filename,
      subfolder,
      type: detectKind(output.filename, output.type),
      bytes: output.bytes ?? 0,
      promptId: '',
      jobId: job.id,
      workflowId: job.workflowId,
      workflowName: job.workflowName,
      category: job.category,
      createdAt: now()
    }
    db.media.push(item)
    added += 1
  }
  if (added > 0) {
    log('info', '媒体库登记', `${job.workflowName || job.workflowId} +${added}`)
    persist()
  }
  return added
}

/** 从 ComfyUI 的 /history 同步输出（应用重启/外部生成也能补录） */
export async function syncMediaFromHistory(): Promise<MediaSyncResult> {
  let history
  try {
    history = await getComfyHistory(200)
  } catch (error) {
    return { added: 0, total: getDb().media.length, error: (error as Error).message }
  }
  const db = getDb()
  let added = 0
  for (const entry of history) {
    for (const output of entry.outputs) {
      const subfolder = output.subfolder ?? ''
      if (hasFile(output.filename, subfolder)) continue
      db.media.push({
        id: makeId(`hist_${entry.promptId}`, output.filename, subfolder),
        filename: output.filename,
        subfolder,
        type: detectKind(output.filename, output.type),
        bytes: output.bytes ?? 0,
        promptId: entry.promptId,
        workflowId: '',
        workflowName: '',
        category: '',
        createdAt: entry.finishedAt ? new Date(entry.finishedAt).toISOString() : now()
      })
      added += 1
    }
  }
  if (added > 0) {
    log('info', '媒体库同步', `+${added}`)
    persist()
  }
  return { added, total: db.media.length }
}
