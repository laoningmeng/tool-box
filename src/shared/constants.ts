import type {
  AppSettings,
  ResourceItem,
  WorkflowCategory
} from './types'

export const ACCENT_PRESETS = [
  { label: '靛蓝', value: '#4f46e5' },
  { label: '天青', value: '#0ea5e9' },
  { label: '翡翠', value: '#10b981' },
  { label: '琥珀', value: '#f59e0b' },
  { label: '玫瑰', value: '#e11d48' },
  { label: '紫罗兰', value: '#8b5cf6' }
]

export const THEME_OPTIONS: Array<{ label: string; value: AppSettings['themeMode'] }> = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'system' }
]

export const UI_LANGUAGE_OPTIONS: Array<{ label: string; value: AppSettings['language'] }> = [
  { label: '简体中文', value: 'zh-CN' },
  { label: 'English', value: 'en-US' }
]

export const TIMEZONE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '中国标准时间 (UTC+8)', value: 'Asia/Shanghai' },
  { label: 'UTC', value: 'UTC' },
  { label: '日本标准时间 (UTC+9)', value: 'Asia/Tokyo' },
  { label: '美国东部时间', value: 'America/New_York' }
]

export const BACKUP_INTERVAL_OPTIONS: Array<{ label: string; value: 'daily' | 'weekly' | 'manual' }> = [
  { label: '每天', value: 'daily' },
  { label: '每周', value: 'weekly' },
  { label: '仅手动', value: 'manual' }
]

export const LOG_LEVEL_OPTIONS: Array<{ label: string; value: AppSettings['logLevel'] }> = [
  { label: 'Debug', value: 'debug' },
  { label: 'Info', value: 'info' },
  { label: 'Warn', value: 'warn' },
  { label: 'Error', value: 'error' }
]

export const RESOURCE_STATUS_META: Record<
  ResourceItem['status'],
  { label: string; tone: 'success' | 'warning' | 'info' }
> = {
  active: { label: '运行中', tone: 'success' },
  paused: { label: '已暂停', tone: 'warning' },
  draft: { label: '草稿', tone: 'info' }
}

export const WORKFLOW_CATEGORY_META: Record<
  WorkflowCategory,
  { label: string; caption: string; color: string }
> = {
  t2i: { label: '文生图', caption: '文本生成图片', color: '#6366f1' },
  i2i: { label: '图生图', caption: '参考图重绘', color: '#14b8a6' },
  i2v: { label: '图生视频', caption: '图片生成视频', color: '#f59e0b' }
}

export const WORKFLOW_CATEGORIES: WorkflowCategory[] = ['t2i', 'i2i', 'i2v']

export const COMFY_SAMPLE_SIZE = ['512x512', '768x768', '1024x1024', '1280x720', '1024x576', '720x1280']
