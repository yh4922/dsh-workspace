/*
 * @Description: H5 —— 切换到桌面版（写 30 天偏好 cookie 后回到宿主首页）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:12:00
 * @FilePath: /dsh-workspace/src/mobile/desktop.ts
 */
import { desktopCookieString } from '../wire/mobile.js'

/**
 * 反代看到 dshws_desktop=1 就不再把 / 302 回来；桌面版里的旧 H5 外壳也据此不接管。
 * 用 replace：返回键不应再回到 H5（回来又会被当成「想用 H5」）。
 */
export function switchToDesktop(): void {
  document.cookie = desktopCookieString(true)
  location.replace('/')
}
