/*
 * @Description: H5 首页 —— 相对时间（刚刚 / N分钟前 / N小时前 / 昨天 / N天前 / 日期）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:30:00
 * @FilePath: /dsh-workspace/src/mobile/home/time.ts
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function relativeTime(t: number, now: number = Date.now()): string {
  if (!Number.isFinite(t) || t <= 0) return ''
  const diff = now - t
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分钟前`
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  if (days <= 0) return `${Math.floor(diff / HOUR)}小时前`
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  const d = new Date(t)
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
