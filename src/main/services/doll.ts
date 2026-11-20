import type { DollCharacter, DollCharacterImage, DollCharacterInput } from '../../shared/types'
import { getDb, now, persist } from '../store'
import { log } from '../logger'

/** 纸娃娃角色：名字 + 从媒体库挑选的素材引用（只存引用，不复制文件） */
export function listDollCharacters(): DollCharacter[] {
  return [...(getDb().dollCharacters ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

function normalizeImages(images: DollCharacterInput['images']): DollCharacterImage[] {
  const list: DollCharacterImage[] = []
  const seen = new Set<string>()
  for (const item of images ?? []) {
    if (!item || typeof item.filename !== 'string' || !item.filename) continue
    const mediaId = String(item.mediaId ?? '')
    if (mediaId && seen.has(mediaId)) continue
    if (mediaId) seen.add(mediaId)
    list.push({
      mediaId,
      filename: item.filename.slice(0, 255),
      subfolder: String(item.subfolder ?? '').slice(0, 255)
    })
    if (list.length >= 32) break
  }
  return list
}

export function createDollCharacter(input: DollCharacterInput): DollCharacter {
  const name = String(input?.name ?? '').trim().slice(0, 32)
  if (!name) throw new Error('角色名不能为空')
  const images = normalizeImages(input?.images)
  if (images.length === 0) throw new Error('至少从媒体库选一张素材')

  const stamp = now()
  const item: DollCharacter = {
    id: `doll_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name,
    images,
    createdAt: stamp,
    updatedAt: stamp
  }
  getDb().dollCharacters.unshift(item)
  persist()
  log('info', '新建纸娃娃角色', `${item.name}（${images.length} 张素材）`)
  return item
}

export function removeDollCharacter(id: string): { ok: boolean } {
  const db = getDb()
  const before = db.dollCharacters.length
  db.dollCharacters = db.dollCharacters.filter((item) => item.id !== id)
  if (db.dollCharacters.length === before) return { ok: false }
  persist()
  return { ok: true }
}
