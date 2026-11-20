import type { ComfyJob, MediaBatch, MediaItem, MediaKind, MediaSyncResult } from '../../shared/types'
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

/** 批量删除记录（不动 ComfyUI 原文件） */
export function removeMediaMany(ids: string[]): { removed: number } {
  const db = getDb()
  const target = new Set(ids)
  const before = db.media.length
  const removedItems = db.media.filter((item) => target.has(item.id))
  db.media = db.media.filter((item) => !target.has(item.id))
  for (const item of removedItems) tombstone(item.filename, item.subfolder ?? '')
  const removed = before - db.media.length
  if (removed > 0) persist()
  return { removed }
}

export function removeMedia(id: string): { ok: boolean } {
  const db = getDb()
  const before = db.media.length
  const target = db.media.find((item) => item.id === id)
  if (!target) return { ok: false }
  db.media = db.media.filter((item) => item.id !== id)
  tombstone(target.filename, target.subfolder ?? '')
  if (db.media.length === before) return { ok: false }
  persist()
  return { ok: true }
}

function mediaKey(filename: string, subfolder: string): string {
  return subfolder ? `${subfolder}/${filename}` : filename
}

function isTombstoned(filename: string, subfolder: string): boolean {
  return (getDb().deletedMediaKeys ?? []).includes(mediaKey(filename, subfolder))
}

function tombstone(filename: string, subfolder: string): void {
  const db = getDb()
  const key = mediaKey(filename, subfolder)
  if (!db.deletedMediaKeys.includes(key)) db.deletedMediaKeys.push(key)
  if (db.deletedMediaKeys.length > 5000) db.deletedMediaKeys = db.deletedMediaKeys.slice(-5000)
}

function hasFile(filename: string, subfolder: string): boolean {
  return (getDb().media ?? []).some(
    (item) => item.filename === filename && (item.subfolder ?? '') === (subfolder ?? '')
  )
}

/** 任务成功时登记它产出的文件（轮询到 success 就会走到这里） */
export function listMediaBatches(): MediaBatch[] {
  return [...(getDb().mediaBatches ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function removeMediaBatch(id: string): { ok: boolean } {
  const db = getDb()
  const before = db.mediaBatches.length
  db.mediaBatches = db.mediaBatches.filter((item) => item.id !== id)
  if (db.mediaBatches.length === before) return { ok: false }
  persist()
  return { ok: true }
}

/** 角色拆分：把一次产出的所有图层合成一个批次（不再散落成几十条图片记录） */
function recordSplitBatch(job: ComfyJob): boolean {
  const outputs = job.outputs ?? []
  const layers = outputs.filter((item) => item.key === 'compositor_layers')
  if (layers.length < 2) return false
  const db = getDb()
  const batchId = `batch_${job.id}`
  if (db.mediaBatches.some((item) => item.id === batchId)) return true
  const composite = outputs.find((item) => item.key === 'images')
  const batch: MediaBatch = {
    id: batchId,
    jobId: job.id,
    workflowId: job.workflowId,
    workflowName: job.workflowName,
    createdAt: now(),
    cover: composite
      ? { filename: composite.filename, subfolder: composite.subfolder ?? '', storage: composite.storage }
      : { filename: layers[0].filename, subfolder: layers[0].subfolder ?? '', storage: layers[0].storage },
    layers: layers.map((item) => ({
      filename: item.filename,
      subfolder: item.subfolder ?? '',
      storage: item.storage,
      label: item.label
    }))
  }
  db.mediaBatches.unshift(batch)
  if (db.mediaBatches.length > 200) db.mediaBatches = db.mediaBatches.slice(0, 200)
  log('info', '角色拆分批次', `${job.workflowName || job.workflowId} · ${layers.length} 层`)
  persist()
  return true
}

export function recordMediaFromJob(job: ComfyJob): number {
  const db = getDb()
  let added = 0
  if (recordSplitBatch(job)) return 0
  for (const output of job.outputs ?? []) {
    const subfolder = output.subfolder ?? ''
    if ((output as { storage?: string }).storage === 'temp') continue
    if (isTombstoned(output.filename, subfolder)) continue
    if (hasFile(output.filename, subfolder)) continue
    const item: MediaItem = {
      id: makeId(job.id, output.filename, subfolder),
      filename: output.filename,
      subfolder,
      storage: (output as { storage?: string }).storage || 'output',
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
  // 老版本把 ComfyUI 的临时预览图（temp/ComfyUI_temp_*）也存了进来，这里顺手清掉
  const beforeCleanup = db.media.length
  db.media = db.media.filter(
    (item) => item.storage !== 'temp' && !/^ComfyUI_temp_/i.test(item.filename)
  )
  const cleaned = beforeCleanup - db.media.length
  let added = 0
  for (const entry of history) {
    // 角色拆分：历史里的图层（temp compositor_layers）也归成一个批次
    const layers = entry.outputs.filter((item) => item.key === 'compositor_layers')
    if (layers.length >= 2) {
      const batchId = `batch_hist_${entry.promptId}`
      if (!db.mediaBatches.some((item) => item.id === batchId)) {
        const composite = entry.outputs.find((item) => item.key === 'images')
        db.mediaBatches.unshift({
          id: batchId,
          jobId: `hist_${entry.promptId}`,
          workflowId: '',
          workflowName: '角色拆分 · SeeThrough',
          createdAt: entry.finishedAt ? new Date(entry.finishedAt).toISOString() : now(),
          cover: composite
            ? { filename: composite.filename, subfolder: composite.subfolder ?? '', storage: composite.storage }
            : { filename: layers[0].filename, subfolder: layers[0].subfolder ?? '', storage: layers[0].storage },
          layers: layers.map((item) => ({
            filename: item.filename,
            subfolder: item.subfolder ?? '',
            storage: item.storage,
            label: item.label
          }))
        })
        if (db.mediaBatches.length > 200) db.mediaBatches = db.mediaBatches.slice(0, 200)
        added += 1
      }
      continue
    }
    for (const output of entry.outputs) {
      const subfolder = output.subfolder ?? ''
      if (hasFile(output.filename, subfolder)) continue
      if ((output as { storage?: string }).storage === 'temp') continue
      if (isTombstoned(output.filename, subfolder)) continue
      db.media.push({
        id: makeId(`hist_${entry.promptId}`, output.filename, subfolder),
        filename: output.filename,
        subfolder,
        storage: (output as { storage?: string }).storage || 'output',
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
  if (added > 0 || cleaned > 0) {
    log('info', '媒体库同步', `+${added} / 清理临时预览 ${cleaned}`)
    persist()
  }
  return { added: added, total: db.media.length }
}
