/*
 * @Description: 移动端 H5 独立页面 —— 宿主（反代 / 路由）与浏览器共享的常量与判定
 * @Author: YangHeng
 * @Date: 2026-11-19 14:40:00
 * @FilePath: /dsh-workspace/src/wire/mobile.ts
 *
 * 本文件会被打进浏览器 bundle（lib/client.js 与 lib/mobile），不得 import zod 或任何 node: 模块。
 */

/** H5 页面路由前缀（不带结尾斜杠：宿主前缀匹配规则见 contract.ts 的 SFTP_HTTP_PREFIX）。 */
export const MOBILE_PREFIX = '/dsh-workspace/m'
/** 跳转目标：带结尾斜杠，与页面里 hash 路由的根一致。 */
export const MOBILE_ENTRY = `${MOBILE_PREFIX}/`

/**
 * 「我要桌面版」偏好 cookie。用 cookie 而不是 localStorage：反代在服务端决定是否 302，只能看到 cookie。
 * 名字与登录 cookie（LAN_COOKIE = dshws_lan）不同前缀冲突：代理按 `dshws_lan=` 剥离登录 cookie，不会误伤它。
 */
export const DESKTOP_COOKIE = 'dshws_desktop'
/** 桌面版偏好记忆 30 天（需求文档 3. 自动跳转）。 */
export const DESKTOP_COOKIE_MAX_AGE = 30 * 86400

/**
 * 是否手机 UA。iPad 排除：平板屏幕够宽，桌面版体验更好；iPadOS 13+ 默认伪装成 Macintosh，本来也匹配不到。
 * Android 平板的 UA 不含 Mobile，天然排除。
 */
export function isMobileUserAgent(ua: string | undefined): boolean {
  if (ua === undefined || ua === '') return false
  if (/iPad/i.test(ua)) return false
  return /iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone|HarmonyOS.*Mobile|OpenHarmony.*Mobile/i.test(ua)
}

/** cookie 头（或 document.cookie）里是否带了桌面版偏好。 */
export function hasDesktopCookie(cookie: string | undefined): boolean {
  if (cookie === undefined) return false
  return cookie.split(';').some((part) => part.trim() === `${DESKTOP_COOKIE}=1`)
}

/**
 * 写入 / 清除桌面版偏好的 document.cookie 字符串。
 * 不加 Secure：远程访问可能是 http；不加 HttpOnly：由页面脚本写入。SameSite=Lax 与登录 cookie 一致。
 */
export function desktopCookieString(on: boolean): string {
  return `${DESKTOP_COOKIE}=${on ? '1' : ''}; Max-Age=${on ? DESKTOP_COOKIE_MAX_AGE : 0}; Path=/; SameSite=Lax`
}
