/*
 * @Description: 移动端 H5 独立页面路由 —— 只对「经局域网反代」的请求提供 lib/mobile/ 静态资源
 * @Author: YangHeng
 * @Date: 2026-11-19 14:45:00
 * @FilePath: /dsh-workspace/src/mobile-route.ts
 *
 *   GET /dsh-workspace/m  与  /dsh-workspace/m/     index.html（no-cache）
 *   GET /dsh-workspace/m/assets/<子路径>             构建产物（带 hash 的长缓存，其余 no-cache）
 *
 * 为什么只认反代：需求约定 H5 只经「远程访问」打开（受 cookie 门禁保护），本机直连一律 404，
 * 不给本机浏览器多一个入口。判定 = 反代标记头 + 回环来源（反代总是从 127.0.0.1 连上游）+ 信任围栏；
 * 标记头由反代覆盖写入（手机端伪造的同名头会被改写），本机进程伪造它也只能看到本来就能看的静态页。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { isTrustedRequest } from './terminal/trust-fence.js'
import { LAN_PROXY_MARK, isLoopbackAddress } from './lan/local-route.js'
import { MOBILE_PREFIX, desktopCookieString } from './wire/mobile.js'

export { MOBILE_PREFIX } from './wire/mobile.js'

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  woff2: 'font/woff2'
}

/** rolldown 产物名形如 name-<hash>.js（见 scripts/build-mobile.mjs），内容变名字就变，可以放心长缓存。 */
const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/

export interface MobileFile {
  file: string
  type: string
  /** 文件名带内容 hash：可 immutable 长缓存。 */
  immutable: boolean
}

/**
 * 把请求路径映射到 lib/mobile 下的文件；不认识的一律 undefined（= 404）。
 * assets 子树逐段校验（不允许空段、.、..、反斜杠、NUL、冒号），拼出的路径再确认仍在 assets 目录下 —— 没有目录穿越。
 */
export function resolveMobileFile(dir: string, pathname: string): MobileFile | undefined {
  if (pathname === MOBILE_PREFIX || pathname === `${MOBILE_PREFIX}/` || pathname === `${MOBILE_PREFIX}/index.html`) {
    return { file: path.join(dir, 'index.html'), type: TYPES.html as string, immutable: false }
  }
  const assetsPrefix = `${MOBILE_PREFIX}/assets/`
  if (!pathname.startsWith(assetsPrefix)) return undefined
  let segments: string[]
  try {
    segments = pathname.slice(assetsPrefix.length).split('/').map((s) => decodeURIComponent(s))
  } catch {
    return undefined
  }
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..' || /[\\/\0:]/.test(s))) return undefined
  const name = segments[segments.length - 1] as string
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const type = Object.hasOwn(TYPES, ext) && ext !== 'html' ? TYPES[ext] : undefined
  if (type === undefined) return undefined
  const base = path.join(dir, 'assets')
  const file = path.join(base, ...segments)
  if (!file.startsWith(base + path.sep)) return undefined
  return { file, type, immutable: HASHED.test(name) }
}

/** 请求是否来自本插件的局域网反代（见文件头）。 */
export function isProxiedRequest(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustedHosts: readonly string[]): boolean {
  return req.headers[LAN_PROXY_MARK] === '1' && isLoopbackAddress(req.socket.remoteAddress) && isTrustedRequest(req as never, trustedHosts)
}

/** 产物缺失（开发时没跑 build:mobile）：给一个能回桌面版的说明页，而不是让 302 后的手机白屏。 */
function missingPage(): string {
  const cookie = JSON.stringify(desktopCookieString(true))
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>DSH</title></head><body style="font:15px/1.6 system-ui;padding:24px;background:#0f1115;color:#e6e8ee">',
    '<p>移动端页面资源尚未构建（lib/mobile 缺失）。</p>',
    `<p><a href="/" style="color:#4f8cff" onclick='document.cookie=${cookie}'>使用桌面版</a></p>`,
    '</body></html>'
  ].join('')
}

export function createMobileHandler(dir: string, trustedHosts: () => readonly string[]) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 非反代一律 404（而非 403）：本机直连看起来就像没有这个页面，不暴露入口。
    if (!isProxiedRequest(req, trustedHosts())) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const hit = resolveMobileFile(dir, pathname)
    if (hit === undefined) {
      res.writeHead(404).end()
      return
    }
    if (!existsSync(hit.file) || !statSync(hit.file).isFile()) {
      if (hit.type.startsWith('text/html')) {
        res.writeHead(503, { 'Content-Type': hit.type, 'Cache-Control': 'no-store' }).end(missingPage())
        return
      }
      res.writeHead(404).end()
      return
    }

    const gzFile = `${hit.file}.gz`
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const useGz = acceptsGzip && existsSync(gzFile)
    const served = useGz ? gzFile : hit.file
    const stat = statSync(served)
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${useGz ? '-gz' : ''}"`
    const headers: Record<string, string | number> = {
      'Content-Type': hit.type,
      ETag: etag,
      // index.html 每次确认（插件升级后立刻拿到新入口）；带 hash 的分片内容不变，一年内不再请求。
      'Cache-Control': hit.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff'
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end()
      return
    }
    headers['Content-Length'] = stat.size
    if (useGz) headers['Content-Encoding'] = 'gzip'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(served)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}
