/** 通用格式化工具：数字、时间、体积、时长 */

export function formatNumber(value: number | null | undefined): string {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num)) return '0'
  return num.toLocaleString('zh-CN')
}

/** 大数字紧凑显示：12,680 -> 1.3 万 */
export function formatCompact(value: number | null | undefined): string {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num)) return '0'
  if (Math.abs(num) >= 100_000_000) return `${(num / 100_000_000).toFixed(1)} 亿`
  if (Math.abs(num) >= 10_000) return `${(num / 10_000).toFixed(1)} 万`
  return num.toLocaleString('zh-CN')
}

export function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes ?? 0)
  if (!Number.isFinite(num) || num <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let value = num
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/** 分钟 -> 可读时长 */
export function formatMinutes(minutes: number | null | undefined): string {
  const num = Number(minutes ?? 0)
  if (!Number.isFinite(num) || num <= 0) return '0 分钟'
  if (num >= 60 * 24) return `${(num / 60 / 24).toFixed(1)} 天`
  if (num >= 60) return `${(num / 60).toFixed(1)} 小时`
  return `${Math.round(num)} 分钟`
}

/** 2026-11-02 14:10:00 -> 11-02 14:10 */
export function formatDateTime(value: string | null | undefined, withYear = false): string {
  if (!value) return '-'
  const normalized = value.replace('T', ' ').replace('Z', '')
  if (withYear) return normalized.slice(0, 16)
  const datePart = normalized.slice(0, 10)
  const timePart = normalized.slice(11, 16)
  const currentYear = new Date().getFullYear().toString()
  const prefix = datePart.startsWith(currentYear) ? datePart.slice(5) : datePart
  return timePart ? `${prefix} ${timePart}` : prefix
}

/** 相对时间：3 分钟前 */
export function fromNow(value: string | null | undefined): string {
  if (!value) return '-'
  const time = new Date(value.replace(' ', 'T')).getTime()
  if (Number.isNaN(time)) return String(value)
  const diff = Date.now() - time
  if (diff < 0) return '刚刚'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return formatDateTime(value)
}

export function todayLabel(): string {
  const now = new Date()
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${week[now.getDay()]}`
}

export function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

/** 由主色生成头像渐变 */
export function gradientFrom(color: string): string {
  return `linear-gradient(135deg, ${color} 0%, ${color}b3 55%, ${color}66 100%)`
}
