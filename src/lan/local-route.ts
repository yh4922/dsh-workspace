/*
 * @Description: 局域网访问 —— 宿主路由 whoami：本机直连下发 localKey
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/local-route.ts
 *
 * 浏览器 → 宿主的 RPC 走 /api 的 WebSocket 复用通道，网关方法看不到请求来自哪里，
 * 所以「本机才能改配置」用一张进程内凭证实现：只有回环直连（Host 也是回环）的页面能从这里拿到它。
 * 经本插件代理的请求在代理侧就被截下（代理自己应答 proxied=true），这里再按代理标记头兜底一次。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LanWhoami } from '../wire/lan.js'

export const LAN_PROXY_MARK = 'x-dshws-lan-proxy'

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const a = address.startsWith('::ffff:') ? address.slice(7) : address
  return a === '::1' || a.startsWith('127.')
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

export function createWhoamiHandler(localKey: () => string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const local = isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(req.headers.host) && req.headers[LAN_PROXY_MARK] === undefined
    const body: LanWhoami = local ? { proxied: false, localKey: localKey() } : { proxied: false }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
}
