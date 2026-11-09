/*
 * @Description: 局域网访问 —— 以本机回环身份取得宿主登录 cookie
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/upstream.ts
 *
 * 宿主 /api 与页面都要求签名 cookie（dsh-auth-*，绑定 host:port）。代理用宿主连接服务的
 * authenticatedUrl() 拿到带启动 token 的地址，像本机浏览器一样 GET 一次，截下 Set-Cookie，
 * 之后转发时注入。手机端永远拿不到这份 cookie：踢出设备只需作废插件自己的 cookie。
 */
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'

export interface UpstreamTarget {
  protocol: 'http:' | 'https:'
  port: number
}

export const UPSTREAM_HOST = '127.0.0.1'

export function upstreamAuthority(target: UpstreamTarget): string {
  return `${UPSTREAM_HOST}:${target.port}`
}

export function upstreamOrigin(target: UpstreamTarget): string {
  return `${target.protocol}//${upstreamAuthority(target)}`
}

type RequestFn = (options: RequestOptions, callback?: (res: IncomingMessage) => void) => ClientRequest

/** 上游是本机回环：HTTPS 时（dsh web --tls-cert）证书多为自签，不校验。 */
export function requestFor(target: UpstreamTarget): RequestFn {
  return (target.protocol === 'https:' ? httpsRequest : httpRequest) as RequestFn
}

export class UpstreamAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/** 从 Set-Cookie 里取出宿主登录 cookie 的 name=value。 */
export function hostCookieOf(headers: IncomingHttpHeaders): string | undefined {
  const list = headers['set-cookie'] ?? []
  for (const line of list) {
    const pair = line.split(';', 1)[0]?.trim() ?? ''
    if (pair.startsWith('dsh-auth-') && pair.includes('=')) return pair
  }
  return undefined
}

export class UpstreamAuth {
  private cached: { key: string; cookie: string } | undefined
  private pending: Promise<string> | undefined

  /**
   * @param target 上游地址；宿主 Web 服务未就绪时返回 undefined
   * @param tokenUrl 由宿主连接服务生成的带启动 token 的地址（authenticatedUrl）；宿主不支持时返回 undefined
   */
  constructor(
    private readonly target: () => UpstreamTarget | undefined,
    private readonly tokenUrl: (base: string) => string | undefined
  ) {}

  invalidate(): void {
    this.cached = undefined
  }

  async cookie(): Promise<string> {
    const target = this.target()
    if (target === undefined) throw new UpstreamAuthError('宿主 Web 服务未就绪')
    const key = upstreamOrigin(target)
    if (this.cached?.key === key) return this.cached.cookie
    // 并发请求共用一次换取，避免冷启动时同时打出几十个 token 请求。
    this.pending ??= this.fetchCookie(target).finally(() => {
      this.pending = undefined
    })
    const cookie = await this.pending
    this.cached = { key, cookie }
    return cookie
  }

  private fetchCookie(target: UpstreamTarget): Promise<string> {
    const url = this.tokenUrl(`${upstreamOrigin(target)}/`)
    if (url === undefined) return Promise.reject(new UpstreamAuthError('宿主未提供浏览器登录接口（connection.authenticatedUrl）'))
    const parsed = new URL(url)
    return new Promise((resolve, reject) => {
      const req = requestFor(target)(
        {
          host: UPSTREAM_HOST,
          port: target.port,
          method: 'GET',
          path: `${parsed.pathname}${parsed.search}`,
          headers: { host: upstreamAuthority(target), accept: 'text/html' },
          rejectUnauthorized: false,
          timeout: 10_000
        },
        (res) => {
          res.resume()
          const cookie = hostCookieOf(res.headers)
          if (cookie !== undefined) {
            resolve(cookie)
            return
          }
          const status = res.statusCode ?? 0
          // Desktop 门禁：没开「允许在浏览器中打开」时普通浏览器（含本代理）一律 403。
          reject(
            new UpstreamAuthError(
              status === 403 ? '宿主拒绝了浏览器访问（请开启 Desktop「允许在浏览器中打开」）' : `宿主登录失败（HTTP ${status}）`,
              status
            )
          )
        }
      )
      req.on('timeout', () => req.destroy(new UpstreamAuthError('连接宿主超时')))
      req.on('error', (error) => reject(error instanceof UpstreamAuthError ? error : new UpstreamAuthError(`连接宿主失败：${error.message}`)))
      req.end()
    })
  }
}
