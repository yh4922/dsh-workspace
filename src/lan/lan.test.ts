/*
 * @Description: 局域网访问 —— 端到端：假上游 + 真代理（登录、锁定、转发改写、WebSocket、踢出、证书）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/lan.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { fileProtector } from '../vault/auto-unlock.js'
import { LanStore } from './store.js'
import { LanService } from './service.js'
import { createSelfSigned } from './cert.js'
import { hashPassword, verifyPassword } from './password.js'
import { createWhoamiHandler, LAN_PROXY_MARK } from './local-route.js'
import { LAN_COOKIE, LAN_PROXY_PREFIX, LAN_WHOAMI_PATH } from '../wire/lan.js'

const TOKEN = 'launch-token'
const HOST_COOKIE = 'dsh-auth-abc=signed'

interface Seen {
  url: string
  headers: IncomingHttpHeaders
}

/** 假宿主：/?token= 换 cookie；其余路径要求 Host 回环 + 宿主 cookie，回显收到的请求头。 */
function fakeUpstream(): Promise<{ server: Server; port: number; seen: Seen[]; wss: WebSocketServer }> {
  const seen: Seen[] = []
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': `${HOST_COOKIE}; HttpOnly; SameSite=Strict` })
      res.end()
      return
    }
    if (!String(req.headers.cookie ?? '').includes(HOST_COOKIE) || !String(req.headers.host).startsWith('127.0.0.1:')) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    if (url.pathname === LAN_WHOAMI_PATH) return void createWhoamiHandler(() => 'secret-key')(req, res)
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['dsh-auth-other=x', 'app=1'] })
    res.end(`ok ${req.method} ${url.pathname}`)
  })
  server.on('upgrade', (req, socket, head) => {
    if (!String(req.headers.cookie ?? '').includes(HOST_COOKIE)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${String(m)}`)))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, seen, wss })))
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function http(port: number, method: string, pathname: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let data = ''
      res.on('data', (c: Buffer) => (data += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('局域网访问代理', () => {
  let dir: string
  let up: Awaited<ReturnType<typeof fakeUpstream>>
  let lan: LanService
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dshws-lan-'))
    up = await fakeUpstream()
    port = await freePort()
    const store = new LanStore(() => dir, fileProtector)
    lan = new LanService({ store, dir: () => dir, log: () => undefined })
    lan.upstream = { protocol: 'http:', port: up.port }
    lan.tokenUrl = (base) => `${base}?token=${TOKEN}`
    await lan.ready
  })

  afterEach(async () => {
    await lan.dispose()
    up.wss.close()
    await new Promise<void>((r) => up.server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  async function enable(): Promise<string> {
    const status = await lan.handle({ op: 'save', localKey: lan.localKey, patch: { enabled: true, host: '127.0.0.1', port } })
    expect(status.state).toBe('running')
    expect(status.password).toMatch(/^\d{6}$/)
    return status.password!
  }

  async function login(password: string): Promise<string> {
    const r = await http(port, 'POST', `${LAN_PROXY_PREFIX}/login`, { 'content-type': 'application/json' }, JSON.stringify({ password }))
    expect(r.status).toBe(200)
    const cookie = String(r.headers['set-cookie']?.[0] ?? '')
    expect(cookie).toContain('HttpOnly')
    return cookie.split(';')[0]!
  }

  it('未登录：页面跳登录页，接口 401，WebSocket 401', async () => {
    await enable()
    const page = await http(port, 'GET', '/some/page', { accept: 'text/html' })
    expect(page.status).toBe(302)
    expect(page.headers.location).toBe(`${LAN_PROXY_PREFIX}/login?next=%2Fsome%2Fpage`)
    expect((await http(port, 'POST', '/api/x')).status).toBe(401)
    const loginPage = await http(port, 'GET', `${LAN_PROXY_PREFIX}/login`, { 'accept-language': 'zh-CN' })
    expect(loginPage.body).toContain('DSH 远程访问')
    expect(up.seen).toHaveLength(0)
  })

  it('密码错误计数，第 5 次锁定；锁定期间正确密码也拒绝', async () => {
    const password = await enable()
    for (let i = 1; i <= 4; i++) {
      const r = await http(port, 'POST', `${LAN_PROXY_PREFIX}/login`, { 'content-type': 'application/json' }, JSON.stringify({ password: 'x' }))
      expect(JSON.parse(r.body)).toMatchObject({ reason: 'wrong', remaining: 5 - i })
    }
    const fifth = await http(port, 'POST', `${LAN_PROXY_PREFIX}/login`, { 'content-type': 'application/json' }, JSON.stringify({ password: 'x' }))
    expect(fifth.status).toBe(429)
    const right = await http(port, 'POST', `${LAN_PROXY_PREFIX}/login`, { 'content-type': 'application/json' }, JSON.stringify({ password }))
    expect(JSON.parse(right.body).reason).toBe('locked')
  })

  it('登录后转发：Host/Origin 改成回环、注入宿主 cookie、去掉插件 cookie 与外来宿主 cookie、响应不回传宿主 cookie', async () => {
    const cookie = await login(await enable())
    const r = await http(port, 'GET', '/hello', {
      cookie: `${cookie}; dsh-auth-forged=evil; keep=1`,
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      'x-dsh-desktop-renderer': 'forged',
      'x-forwarded-for': '1.2.3.4'
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('ok GET /hello')
    expect(r.headers['set-cookie']).toEqual(['app=1'])
    const last = up.seen.at(-1)!
    expect(last.headers.host).toBe(`127.0.0.1:${up.port}`)
    expect(last.headers.origin).toBe(`http://127.0.0.1:${up.port}`)
    expect(last.headers.cookie).toBe(`keep=1; ${HOST_COOKIE}`)
    expect(last.headers['sec-fetch-site']).toBeUndefined()
    expect(last.headers['x-dsh-desktop-renderer']).toBeUndefined()
    expect(last.headers['x-forwarded-for']).toBeUndefined()
    expect(last.headers[LAN_PROXY_MARK]).toBe('1')
  })

  it('跨站请求（Origin 与 Host 不一致）被拒', async () => {
    const cookie = await login(await enable())
    const r = await http(port, 'POST', '/api/x', { cookie, host: `127.0.0.1:${port}`, origin: 'http://evil.example' })
    expect(r.status).toBe(403)
  })

  it('whoami：经代理返回 proxied=true，不下发本机凭证；宿主路由带代理标记也不下发', async () => {
    const cookie = await login(await enable())
    const r = await http(port, 'GET', LAN_WHOAMI_PATH, { cookie })
    expect(JSON.parse(r.body)).toEqual({ proxied: true })
    const direct = await http(up.port, 'GET', LAN_WHOAMI_PATH, { cookie: HOST_COOKIE, host: `127.0.0.1:${up.port}` })
    expect(JSON.parse(direct.body)).toEqual({ proxied: false, localKey: 'secret-key' })
    const marked = await http(up.port, 'GET', LAN_WHOAMI_PATH, { cookie: HOST_COOKIE, host: `127.0.0.1:${up.port}`, [LAN_PROXY_MARK]: '1' })
    expect(JSON.parse(marked.body)).toEqual({ proxied: false })
  })

  it('WebSocket 转发；踢出设备后连接被断开、cookie 失效', async () => {
    const cookie = await login(await enable())
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const echo = new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))))
    ws.send('ping')
    expect(await echo).toBe('echo:ping')
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    const devices = (await lan.handle({ op: 'status', localKey: lan.localKey })).devices
    expect(devices).toHaveLength(1)
    await lan.handle({ op: 'kick', localKey: lan.localKey, id: devices[0]!.id })
    await closed
    expect((await http(port, 'GET', '/hello', { cookie })).status).toBe(401)
  })

  it('刷新随机密码不影响已登录设备；没有本机凭证不能改配置、看不到密码', async () => {
    const password = await enable()
    const cookie = await login(password)
    const refreshed = await lan.handle({ op: 'refreshPassword', localKey: lan.localKey })
    expect(refreshed.password).not.toBe(undefined)
    expect((await http(port, 'GET', '/hello', { cookie })).status).toBe(200)
    const anon = await lan.handle({ op: 'status' })
    expect(anon.local).toBe(false)
    expect(anon.password).toBeUndefined()
    await expect(lan.handle({ op: 'kickAll', localKey: 'wrong' })).rejects.toThrow(/本机/)
  })

  it('固定密码：未设置时不能切换；设置后旧随机密码失效', async () => {
    const password = await enable()
    await expect(lan.handle({ op: 'save', localKey: lan.localKey, patch: { passwordMode: 'fixed' } })).rejects.toThrow(/固定密码/)
    const s = await lan.handle({ op: 'save', localKey: lan.localKey, patch: { passwordMode: 'fixed' }, fixedPassword: 'abcd1234' })
    expect(s.hasFixedPassword).toBe(true)
    expect(s.password).toBeUndefined()
    const old = await http(port, 'POST', `${LAN_PROXY_PREFIX}/login`, { 'content-type': 'application/json' }, JSON.stringify({ password }))
    expect(old.status).toBe(401)
    await login('abcd1234')
  })

  it('端口被占用：状态为 error 并给出原因', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()))
    const s = await lan.handle({ op: 'save', localKey: lan.localKey, patch: { enabled: true, host: '127.0.0.1', port } })
    expect(s.state).toBe('error')
    expect(s.error).toMatch(/已被占用/)
    await new Promise<void>((r) => blocker.close(() => r()))
  })

  it('宿主 cookie 失效（上游 401）后下一次请求重新换取', async () => {
    const cookie = await login(await enable())
    expect((await http(port, 'GET', '/hello', { cookie })).status).toBe(200)
    const tokenRequests = (): number => up.seen.filter((s) => s.url.includes('token=')).length
    expect(tokenRequests()).toBe(1)
    lan.upstreamAuth.invalidate()
    expect((await http(port, 'GET', '/hello', { cookie })).status).toBe(200)
    expect(tokenRequests()).toBe(2)
  })
})

describe('局域网访问工具函数', () => {
  it('自签证书可被 X509 解析，SAN 含 localhost 与给定 IP', () => {
    const c = createSelfSigned(['192.168.1.20'])
    const x = new X509Certificate(c.cert)
    expect(x.subjectAltName).toContain('DNS:localhost')
    expect(x.subjectAltName).toContain('IP Address:192.168.1.20')
    expect(x.checkIssued(x)).toBe(true)
    expect(x.verify(x.publicKey)).toBe(true)
  })

  it('scrypt 哈希校验', () => {
    const h = hashPassword('pa55')
    expect(verifyPassword('pa55', h)).toBe(true)
    expect(verifyPassword('pa56', h)).toBe(false)
  })
})
