/*
 * @Description: H5 浏览器面板 —— 本机端口转发路由 /dsh-workspace/m/fwd/<端口>/<路径>（仅经局域网反代可用）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:40:00
 * @FilePath: /dsh-workspace/src/mobile-fwd-route.ts
 *
 * 手机里的 localhost 是手机自己，电脑上跑的开发服务（如 http://localhost:5173）只能经插件转发到 127.0.0.1:<端口>。
 * 安全边界：
 * - 门禁同 mobile-route.ts：只认反代请求（反代已校验登录 cookie），本机直连 404，不给本机多一个开放代理；
 * - 只转发到回环地址；拒绝 DSH 自身 Web 端口与反代端口 —— 转发到它们会带着反代注入的宿主 cookie 绕过门禁；
 * - 去掉 Cookie（反代注入的是宿主登录 cookie，不能泄露给任意本机服务）与上游 Set-Cookie / HSTS / Clear-Site-Data
 *   （转发页面与 DSH 同源，上游写 cookie 或清站点数据会作用到 DSH 本身）；
 * - 响应加 CSP sandbox（不含 allow-same-origin）：页面运行在不透明源里，脚本拿不到 DSH 同源权限。
 *   代价：依赖 cookie / localStorage 的页面功能受限；WebSocket（如 HMR）不转发。
 */
import http from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { LAN_PROXY_MARK } from './lan/local-route.js'
import { isProxiedRequest } from './mobile-route.js'
import { MOBILE_FWD_PREFIX, isForwardablePort, parseFwdUrl } from './wire/mobile-fwd.js'

export { MOBILE_FWD_PREFIX } from './wire/mobile-fwd.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** 转发页面的沙箱：允许脚本 / 表单 / 弹窗，但不给同源（见文件头）。 */
export const FWD_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

/** 请求头改写（纯函数，便于单测）。 */
export function forwardRequestHeaders(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'cookie' || key === LAN_PROXY_MARK || key.startsWith('x-forwarded-')) continue
    out[key] = v
  }
  const origin = `http://localhost:${port}`
  out.host = `localhost:${port}`
  if (out.origin !== undefined) out.origin = origin
  if (typeof out.referer === 'string') {
    try {
      const u = new URL(out.referer)
      const parsed = parseFwdUrl(`${u.pathname}${u.search}`)
      out.referer = parsed.kind === 'ok' && parsed.port === port ? `${origin}${parsed.target}` : origin
    } catch {
      delete out.referer
    }
  }
  return out
}

/** 上游 Location → 转发地址：指向同一本机端口的绝对地址与以 / 开头的路径加转发前缀，其余原样。 */
export function rewriteLocation(location: string, port: number): string {
  if (location.startsWith('//')) return location
  if (location.startsWith('/')) return `${MOBILE_FWD_PREFIX}/${port}${location}`
  try {
    const u = new URL(location)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    const p = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    if (local && (u.protocol === 'http:' || u.protocol === 'https:')) return `${MOBILE_FWD_PREFIX}/${p}${u.pathname}${u.search}${u.hash}`
  } catch {
    /* 相对地址：浏览器按当前（已带前缀的）地址解析 */
  }
  return location
}

/** 从 CSP 里去掉 frame-ancestors（否则无法嵌进 H5 的 iframe）。 */
function stripFrameAncestors(csp: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !/^frame-ancestors\b/i.test(d))
    .join('; ')
}

/** 响应头改写（纯函数，便于单测）。 */
export function forwardResponseHeaders(headers: IncomingHttpHeaders, port: number): Record<string, string | string[] | number> {
  const out: Record<string, string | string[] | number> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    if (['set-cookie', 'x-frame-options', 'strict-transport-security', 'clear-site-data', 'alt-svc', 'service-worker-allowed'].includes(key)) continue
    if (key === 'location' && typeof v === 'string') {
      out.location = rewriteLocation(v, port)
      continue
    }
    if (key === 'content-security-policy') {
      const list = (Array.isArray(v) ? v : [String(v)]).map(stripFrameAncestors).filter((s) => s !== '')
      if (list.length > 0) out[key] = list
      continue
    }
    out[key] = v
  }
  const existing = out['content-security-policy']
  out['content-security-policy'] = [...(existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]), FWD_SANDBOX_CSP]
  return out
}

export interface ForwardDeps {
  trustedHosts(): readonly string[]
  /** 禁止转发的端口（DSH Web 端口、反代端口），每次请求现取。 */
  deniedPorts(): readonly number[]
  /** 等待上游响应头的超时（毫秒）。 */
  timeoutMs?: number
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text)
}

export function createForwardHandler(deps: ForwardDeps) {
  const timeoutMs = deps.timeoutMs ?? 30_000
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isProxiedRequest(req, deps.trustedHosts())) {
      res.writeHead(404).end()
      return
    }
    const parsed = parseFwdUrl(req.url ?? '')
    if (parsed.kind === 'invalid') return sendText(res, 400, '转发地址无效')
    if (parsed.kind === 'redirect') {
      res.writeHead(301, { location: parsed.location, 'cache-control': 'no-store' }).end()
      return
    }
    if (!isForwardablePort(parsed.port, deps.deniedPorts())) return sendText(res, 403, `端口 ${parsed.port} 不允许转发`)

    const headers = forwardRequestHeaders(req.headers, parsed.port)
    const method = req.method ?? 'GET'
    // 无请求体的方法在 127.0.0.1 拒绝连接时改试 ::1（Node 17+ 的 localhost 常只监听 IPv6）；有请求体的不重试（体已开始流出）。
    const hosts = method === 'GET' || method === 'HEAD' ? ['127.0.0.1', '::1'] : ['127.0.0.1']

    await new Promise<void>((resolve) => {
      const attempt = (i: number): void => {
        const upstream = http.request({ host: hosts[i], port: parsed.port, method, path: parsed.target, headers, timeout: timeoutMs })
        upstream.on('response', (up) => {
          res.writeHead(up.statusCode ?? 502, forwardResponseHeaders(up.headers, parsed.port))
          up.pipe(res)
          up.on('end', resolve)
          up.on('error', () => {
            res.destroy()
            resolve()
          })
        })
        upstream.on('timeout', () => upstream.destroy(new Error('timeout')))
        upstream.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNREFUSED' && i + 1 < hosts.length && !res.headersSent) return attempt(i + 1)
          sendText(res, 502, error.code === 'ECONNREFUSED' ? `本机端口 ${parsed.port} 没有服务在监听` : `转发失败：${error.message}`)
          resolve()
        })
        res.on('close', () => upstream.destroy())
        if (hosts.length > 1) upstream.end()
        else req.pipe(upstream)
      }
      attempt(0)
    })
  }
}
