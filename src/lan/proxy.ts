/*
 * @Description: 局域网访问 —— 带密码门禁的反向代理（HTTP / HTTPS / WebSocket）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/proxy.ts
 *
 * 安全边界：除登录页外所有路径都要求插件 cookie（含宿主 /api、静态资源、插件路由、WebSocket）。
 * 这样也顺带挡住了「插件既有路由只校验 Host/Origin」的隐患 —— 经本代理的请求在门口就被拦下。
 * 上游视角：每个请求都像本机回环浏览器发出（Host/Origin 改成 127.0.0.1:<port>，注入宿主 cookie）。
 */
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import { LAN_COOKIE, LAN_PROXY_PREFIX, LAN_WHOAMI_PATH, type LanDevice } from '../wire/lan.js'
import type { LanAuth } from './auth.js'
import { LAN_PROXY_MARK } from './local-route.js'
import { loginPage, pickLang } from './login-page.js'
import { UpstreamAuthError, requestFor, upstreamAuthority, upstreamOrigin, type UpstreamAuth, type UpstreamTarget } from './upstream.js'

export interface LanProxyOptions {
  host: string
  port: number
  tls?: { key: string; cert: string }
  upstream: () => UpstreamTarget | undefined
  upstreamAuth: UpstreamAuth
  auth: LanAuth
  sessionDays: () => number
  log: (level: 'info' | 'warn', message: string) => void
}

/** 逐跳头：只对单条连接有意义，不能转发。 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'])
/** 上游信任围栏会据这些头判断来源，或会泄露 / 伪造身份：一律去掉。 */
const STRIPPED = new Set(['sec-fetch-site', 'x-dsh-desktop-renderer', 'forwarded', 'x-real-ip'])

export function clientIp(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

/** 去掉插件 cookie 与外来的宿主 cookie（防止手机端伪造），再拼上代理持有的宿主 cookie。 */
export function rewriteCookie(header: string | undefined, hostCookie: string): string {
  const kept = (header ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith(`${LAN_COOKIE}=`) && !s.startsWith('dsh-auth-'))
  return [...kept, hostCookie].join('; ')
}

/** 请求头改写：让上游看到的是本机回环的同源请求。 */
export function rewriteRequestHeaders(headers: IncomingHttpHeaders, target: UpstreamTarget, hostCookie: string, upgrade: boolean): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const k = key.toLowerCase()
    if (STRIPPED.has(k) || k.startsWith('x-forwarded-')) continue
    if (HOP_BY_HOP.has(k) && !(upgrade && (k === 'connection' || k === 'upgrade'))) continue
    out[k] = value
  }
  const origin = upstreamOrigin(target)
  out.host = upstreamAuthority(target)
  if (out.origin !== undefined) out.origin = origin
  if (typeof out.referer === 'string') {
    try {
      const u = new URL(out.referer)
      out.referer = `${origin}${u.pathname}${u.search}`
    } catch {
      delete out.referer
    }
  }
  out.cookie = rewriteCookie(typeof headers.cookie === 'string' ? headers.cookie : undefined, hostCookie)
  // 标记「经代理」：宿主侧 whoami 路由据此拒绝下发本机凭证（改写后 Host 也是回环，只能靠这个区分）。
  out[LAN_PROXY_MARK] = '1'
  if (upgrade) {
    out.connection = 'Upgrade'
    out.upgrade = headers.upgrade ?? 'websocket'
  }
  return out
}

/** 响应头改写：去掉宿主 cookie（不能落到手机上）、把指向上游的绝对 Location 改回相对路径。 */
export function rewriteResponseHeaders(headers: IncomingHttpHeaders, target: UpstreamTarget): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const k = key.toLowerCase()
    if (k === 'connection' || k === 'keep-alive') continue
    if (k === 'set-cookie') {
      const list = (Array.isArray(value) ? value : [String(value)]).filter((c) => !c.trim().startsWith('dsh-auth-'))
      if (list.length > 0) out[k] = list
      continue
    }
    out[k] = value
  }
  const loc = out.location
  if (typeof loc === 'string' && loc.startsWith(upstreamOrigin(target))) out.location = loc.slice(upstreamOrigin(target).length) || '/'
  return out
}

/** 浏览器跨站请求（Origin 与 Host 不一致）直接拒绝：SameSite 之外再挡一层 CSRF / 跨站 WebSocket。 */
export function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === 'null') return origin === 'null'
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

function wantsHtml(req: IncomingMessage): boolean {
  return req.method === 'GET' && (req.headers['sec-fetch-dest'] === 'document' || String(req.headers.accept ?? '').includes('text/html'))
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface LanProxy {
  readonly server: Server
  start(): Promise<void>
  stop(): Promise<void>
}

export function createLanProxy(options: LanProxyOptions): LanProxy {
  const secure = options.tls !== undefined
  const sockets = new Map<string, Set<Duplex>>()

  const cookieAttrs = (maxAgeSeconds: number): string =>
    `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`

  const deviceOf = (req: IncomingMessage): LanDevice | undefined =>
    options.auth.authenticate(readCookie(req.headers.cookie, LAN_COOKIE), clientIp(req))

  const offKick = options.auth.onKick((ids) => {
    for (const id of ids) {
      for (const s of sockets.get(id) ?? []) s.destroy()
      sockets.delete(id)
    }
  })

  async function handleOwn(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === `${LAN_PROXY_PREFIX}/login` && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer'
      })
      res.end(loginPage(pickLang(req.headers['accept-language'])))
      return
    }
    if (pathname === `${LAN_PROXY_PREFIX}/login` && req.method === 'POST') {
      if (crossOrigin(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden' })
      let password = ''
      try {
        const body = JSON.parse(await readBody(req)) as { password?: unknown }
        password = typeof body.password === 'string' ? body.password.slice(0, 256) : ''
      } catch {
        return sendJson(res, 400, { ok: false, reason: 'bad-request' })
      }
      const ip = clientIp(req)
      const result = options.auth.login(ip, String(req.headers['user-agent'] ?? ''), password)
      if (!result.ok) {
        if (result.reason !== 'unset') options.log('warn', `远程访问：${ip} 登录失败（${result.reason === 'locked' ? '已锁定' : '密码错误'}）。`)
        return sendJson(res, result.reason === 'locked' ? 429 : 401, result)
      }
      options.log('info', `远程访问：${ip} 登录成功。`)
      return sendJson(res, 200, { ok: true }, { 'set-cookie': `${LAN_COOKIE}=${result.token}; ${cookieAttrs(options.sessionDays() * 86400)}` })
    }
    if (pathname === `${LAN_PROXY_PREFIX}/logout` && req.method === 'POST') {
      if (crossOrigin(req)) return sendJson(res, 403, { ok: false })
      const device = deviceOf(req)
      if (device !== undefined) options.auth.kick(device.id)
      return sendJson(res, 200, { ok: true }, { 'set-cookie': `${LAN_COOKIE}=; ${cookieAttrs(0)}` })
    }
    res.writeHead(404)
    res.end()
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = options.upstream()
    if (target === undefined) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('DSH Web 服务未就绪')
      return
    }
    let hostCookie: string
    try {
      hostCookie = await options.upstreamAuth.cookie()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.log('warn', `远程访问：换取宿主登录失败：${message}`)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(message)
      return
    }
    const upstreamReq = requestFor(target)(
      {
        host: '127.0.0.1',
        port: target.port,
        method: req.method,
        path: req.url,
        headers: rewriteRequestHeaders(req.headers, target, hostCookie, false),
        rejectUnauthorized: false
      },
      (up) => {
        // 宿主 cookie 失效（换了签名密钥 / 过期）：作废缓存，下一次请求重新换取。
        if (up.statusCode === 401) options.upstreamAuth.invalidate()
        res.writeHead(up.statusCode ?? 502, rewriteResponseHeaders(up.headers, target))
        up.pipe(res)
      }
    )
    upstreamReq.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`上游错误：${error.message}`)
      } else res.destroy()
    })
    // 客户端中途断开（取消上传、关页面）：同步中止上游，避免挂起的长请求。
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy()
    })
    req.pipe(upstreamReq)
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://lan.invalid').pathname
    if (pathname === LAN_PROXY_PREFIX || pathname.startsWith(`${LAN_PROXY_PREFIX}/`)) return handleOwn(req, res, pathname)
    const device = deviceOf(req)
    if (device === undefined) {
      if (wantsHtml(req)) {
        res.writeHead(302, { location: `${LAN_PROXY_PREFIX}/login?next=${encodeURIComponent(req.url ?? '/')}`, 'cache-control': 'no-store' })
        res.end()
      } else {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('unauthorized')
      }
      return
    }
    if (crossOrigin(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    // 代理自己应答：浏览器端据此判断「经代理访问」（启用 H5 外壳、远程访问配置只读）。
    if (pathname === LAN_WHOAMI_PATH) return sendJson(res, 200, { proxied: true })
    await forward(req, res)
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const device = deviceOf(req)
    if (device === undefined || crossOrigin(req)) {
      socket.end(`HTTP/1.1 ${device === undefined ? '401 Unauthorized' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`)
      return
    }
    const target = options.upstream()
    if (target === undefined) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    socket.on('error', () => socket.destroy())
    void options.upstreamAuth
      .cookie()
      .then((hostCookie) => {
        const upReq = requestFor(target)({
          host: '127.0.0.1',
          port: target.port,
          method: 'GET',
          path: req.url,
          headers: rewriteRequestHeaders(req.headers, target, hostCookie, true),
          rejectUnauthorized: false
        })
        upReq.on('upgrade', (up, upSocket, upHead) => {
          const lines = [`HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? 'Switching Protocols'}`]
          for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`)
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          if (upHead.length > 0) socket.write(upHead)
          if (head.length > 0) upSocket.write(head)
          upSocket.on('error', () => socket.destroy())
          upSocket.on('close', () => socket.destroy())
          socket.on('close', () => upSocket.destroy())
          upSocket.pipe(socket)
          socket.pipe(upSocket)
          // 记到设备名下：踢出时一并断开（否则已连上的 WebSocket 会一直活着）。
          let set = sockets.get(device.id)
          if (set === undefined) sockets.set(device.id, (set = new Set()))
          set.add(socket)
          socket.on('close', () => set.delete(socket))
        })
        upReq.on('response', (up) => {
          if (up.statusCode === 401) options.upstreamAuth.invalidate()
          socket.end(`HTTP/1.1 ${up.statusCode ?? 502} ${up.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`)
          up.resume()
        })
        upReq.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'))
        upReq.end()
      })
      .catch((error: unknown) => {
        if (error instanceof UpstreamAuthError) options.log('warn', `远程访问：换取宿主登录失败：${error.message}`)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      })
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    onRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(error instanceof Error ? error.message : String(error))
      } else res.destroy()
    })
  }
  const server: Server = secure ? (createHttpsServer({ key: options.tls!.key, cert: options.tls!.cert }, handler) as unknown as Server) : createHttpServer(handler)
  server.on('upgrade', onUpgrade)
  // 长连接（WebSocket、流式 /api）不能被默认的请求超时掐断。
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  return {
    server,
    start: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off('listening', onListening)
          reject(
            new Error(
              error.code === 'EADDRINUSE'
                ? `端口 ${options.port} 已被占用`
                : error.code === 'EACCES'
                  ? `没有权限监听端口 ${options.port}`
                  : error.code === 'EADDRNOTAVAIL'
                    ? `本机没有地址 ${options.host}`
                    : error.message
            )
          )
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(options.port, options.host)
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        offKick()
        for (const set of sockets.values()) for (const s of set) s.destroy()
        sockets.clear()
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
  }
}
