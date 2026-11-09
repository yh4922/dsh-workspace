/*
 * @Description: 远程访问页的纯函数（相对时间、设备名），单独成文件便于测试（不牵连宿主 UI 组件）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/lan/format.ts
 */
import type { Translate } from '../context.js'

export function relTime(t: Translate, at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return t('lan.justNow')
  if (diff < 3600_000) return t('lan.minAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('lan.hourAgo', { n: Math.floor(diff / 3600_000) })
  return t('lan.dayAgo', { n: Math.floor(diff / 86400_000) })
}

/** UA → 一眼能认出的设备名（只做常见几类，识别不了就原样截断）。 */
export function deviceName(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /MicroMessenger/.test(ua) ? '微信' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  const name = [os, browser].filter((s) => s !== '').join(' · ')
  return name !== '' ? name : ua.slice(0, 40)
}
