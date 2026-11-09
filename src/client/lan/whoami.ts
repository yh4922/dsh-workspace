/*
 * @Description: 浏览器端 —— 判断「是否经局域网代理访问」并取本机凭证
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/lan/whoami.ts
 *
 * 同源相对地址请求：经代理时由代理应答 proxied=true；本机直连时宿主路由下发 localKey。
 * 页面生命周期内只问一次（结果不会变）；请求失败按「本机、无凭证」处理（配置只读，H5 不启用）。
 */
import { LAN_WHOAMI_PATH, type LanWhoami } from '../../wire/lan.js'

let cached: Promise<LanWhoami> | undefined

export function whoami(): Promise<LanWhoami> {
  cached ??= fetch(LAN_WHOAMI_PATH, { credentials: 'same-origin', cache: 'no-store' })
    .then((r): Promise<LanWhoami> | LanWhoami => (r.ok ? (r.json() as Promise<LanWhoami>) : { proxied: false }))
    .then((v) => ({ proxied: v.proxied === true, ...(typeof v.localKey === 'string' ? { localKey: v.localKey } : {}) }))
    .catch(() => ({ proxied: false }))
  return cached
}
