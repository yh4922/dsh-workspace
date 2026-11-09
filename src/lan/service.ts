/*
 * @Description: 局域网访问 —— 生命周期（启停、热应用、随机密码轮换）与网关 op 分派
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/service.ts
 */
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import {
  LAN_FIXED_PASSWORD_MAX,
  LAN_FIXED_PASSWORD_MIN,
  LAN_INTERVAL_MAX,
  LAN_INTERVAL_MIN,
  isValidLanHost,
  type LanConfig,
  type LanConfigPatch,
  type LanDesktopGate,
  type LanInput,
  type LanRunState,
  type LanStatus
} from '../wire/lan.js'
import { LanAuth } from './auth.js'
import { loadOrCreateCertificate } from './cert.js'
import { hashPassword, randomPassword, sameString } from './password.js'
import { createLanProxy, type LanProxy } from './proxy.js'
import type { LanStore, RandomSecret } from './store.js'
import { UpstreamAuth, upstreamOrigin, type UpstreamTarget } from './upstream.js'

/** 宿主设置服务里本模块用到的部分（Desktop「允许在浏览器中打开」）。 */
export interface SettingsFace {
  describe(): Array<{ ns: unknown; value?: unknown }>
  update(ns: string, patch: Record<string, unknown>): Promise<unknown> | unknown
}

export interface LanServiceDeps {
  store: LanStore
  /** 证书缓存目录。 */
  dir: () => string
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
}

/** Desktop 设置命名空间（loader entry id），见宿主 settings-bridge。 */
const DESKTOP_NS = 'desktop-shell'
/** setTimeout 上限约 24.8 天：更长的周期分段等待。 */
const MAX_TIMER = 2 ** 31 - 1

/** 本机全部局域网 IPv4（不含回环、链路本地 169.254）。 */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' && (item.family as unknown) !== 4) continue
      if (item.internal || item.address.startsWith('169.254.')) continue
      out.push(item.address)
    }
  }
  return [...new Set(out)]
}

export class LanError extends Error {}

export class LanService {
  /** 本进程随机生成的本机凭证：只经宿主回环路由下发（经代理拿不到），修改配置必须带上它。 */
  readonly localKey = randomBytes(24).toString('base64url')
  readonly auth: LanAuth
  readonly upstreamAuth: UpstreamAuth
  /** 由 index.ts 在宿主 webServer 就绪 / 撤下时填入。 */
  upstream: UpstreamTarget | undefined
  tokenUrl: ((base: string) => string | undefined) | undefined
  settings: (() => SettingsFace | undefined) | undefined

  private state: LanRunState = 'stopped'
  private error: string | undefined
  private proxy: LanProxy | undefined
  private random: RandomSecret | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly now: () => number
  readonly ready: Promise<void>

  constructor(private readonly deps: LanServiceDeps) {
    this.now = deps.now ?? Date.now
    const store = deps.store
    this.auth = new LanAuth(
      store,
      {
        mode: () => store.get().config.passwordMode,
        fixedHash: () => store.get().fixedHash,
        randomPassword: () => (this.random !== undefined && this.random.expiresAt > this.now() ? this.random.password : undefined),
        sessionDays: () => store.get().config.sessionDays
      },
      this.now
    )
    this.upstreamAuth = new UpstreamAuth(
      () => this.upstream,
      (base) => this.tokenUrl?.(base)
    )
    this.ready = (async () => {
      this.random = await store.loadSecret().catch(() => undefined)
      await this.ensureRandom()
      if (store.get().config.enabled) await this.serial(() => this.restart())
    })().catch((error: unknown) => {
      this.deps.log('error', `远程访问初始化失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** 串行化启停：连续改配置时不会出现两个服务抢同一端口。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private config(): LanConfig {
    return this.deps.store.get().config
  }

  /** 随机模式下保证有一个未过期的密码，并按过期时间排下一次轮换。 */
  private async ensureRandom(force = false): Promise<void> {
    if (this.disposed) return
    const cfg = this.config()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (cfg.passwordMode !== 'random') return
    const at = this.now()
    const period = cfg.randomIntervalMinutes * 60_000
    if (this.random !== undefined && !force) {
      // 周期改了：按新周期从签发时刻重新计算到期时间。
      const expiresAt = this.random.issuedAt + period
      if (expiresAt !== this.random.expiresAt) this.random = { ...this.random, expiresAt }
    }
    if (force || this.random === undefined || this.random.expiresAt <= at) {
      this.random = { password: randomPassword(), issuedAt: at, expiresAt: at + period }
      try {
        await this.deps.store.saveSecret(this.random)
      } catch (error) {
        // 落盘失败只影响重启后沿用：本次运行照常使用内存里的新密码。
        this.deps.log('warn', `远程访问：随机密码保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
      this.deps.log('info', '远程访问：随机密码已刷新。')
    }
    const delay = Math.max(1000, Math.min(MAX_TIMER, this.random.expiresAt - this.now()))
    this.timer = setTimeout(() => void this.ensureRandom(), delay)
    this.timer.unref?.()
  }

  private async stopProxy(): Promise<void> {
    const proxy = this.proxy
    this.proxy = undefined
    if (proxy !== undefined) await proxy.stop()
    this.state = 'stopped'
  }

  private async restart(): Promise<void> {
    await this.stopProxy()
    this.error = undefined
    const cfg = this.config()
    if (!cfg.enabled || this.disposed) return
    if (cfg.passwordMode === 'fixed' && this.deps.store.get().fixedHash === undefined) {
      this.state = 'error'
      this.error = '尚未设置固定密码'
      return
    }
    if (this.upstream !== undefined && cfg.port === this.upstream.port) {
      this.state = 'error'
      this.error = `端口 ${cfg.port} 与 DSH 自身端口冲突`
      return
    }
    this.state = 'starting'
    try {
      const tls = cfg.protocol === 'https' ? loadOrCreateCertificate(this.deps.dir(), lanAddresses()) : undefined
      const proxy = createLanProxy({
        host: cfg.host,
        port: cfg.port,
        ...(tls !== undefined ? { tls: { key: tls.key, cert: tls.cert } } : {}),
        upstream: () => this.upstream,
        upstreamAuth: this.upstreamAuth,
        auth: this.auth,
        sessionDays: () => this.config().sessionDays,
        log: (level, message) => this.deps.log(level, message)
      })
      await proxy.start()
      this.proxy = proxy
      this.state = 'running'
      this.deps.log('info', `远程访问已启动：${cfg.protocol}://${cfg.host}:${cfg.port}`)
    } catch (error) {
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      this.deps.log('error', `远程访问启动失败：${this.error}`)
    }
  }

  private desktopGate(): LanDesktopGate {
    let entry: { value?: unknown } | undefined
    try {
      entry = this.settings?.()?.describe().find((e) => String(e.ns) === DESKTOP_NS)
    } catch {
      entry = undefined
    }
    if (entry === undefined) return 'unavailable'
    const value = (entry.value ?? {}) as { mode?: unknown; openBrowser?: unknown; networkExposure?: unknown }
    if (value.mode !== undefined && value.mode !== 'compatibility') return 'incompatible'
    // 宿主规则：openBrowser 或 networkExposure=lan 任一成立即放行普通浏览器（desktopBrowserAccessEnabled）。
    return value.openBrowser === true || value.networkExposure === 'lan' ? 'open' : 'closed'
  }

  private isLocal(key: string | undefined): boolean {
    return typeof key === 'string' && sameString(key, this.localKey)
  }

  status(local: boolean): LanStatus {
    const data = this.deps.store.get()
    const cfg = data.config
    const scheme = cfg.protocol
    const hosts = cfg.host === '0.0.0.0' || cfg.host === '::' ? lanAddresses() : [cfg.host]
    const random = cfg.passwordMode === 'random' ? this.random : undefined
    return {
      config: { ...cfg },
      hasFixedPassword: data.fixedHash !== undefined,
      state: this.state,
      ...(this.error !== undefined ? { error: this.error } : {}),
      urls: hosts.map((h) => `${scheme}://${h.includes(':') ? `[${h}]` : h}:${cfg.port}/`),
      ...(local && random !== undefined ? { password: random.password } : {}),
      ...(random !== undefined ? { passwordExpiresAt: random.expiresAt } : {}),
      devices: this.auth.devices(),
      local,
      desktopGate: this.desktopGate(),
      ...(this.upstream !== undefined ? { upstream: upstreamOrigin(this.upstream) } : {})
    }
  }

  async handle(input: LanInput): Promise<LanStatus> {
    await this.ready
    if (input.op === 'status') return this.status(this.isLocal(input.localKey))
    if (!this.isLocal(input.localKey)) throw new LanError('远程访问配置只能在本机 DSH 中修改。')
    switch (input.op) {
      case 'save':
        await this.serial(() => this.save(input.patch, input.fixedPassword))
        break
      case 'refreshPassword':
        if (this.config().passwordMode !== 'random') throw new LanError('当前不是随机密码模式。')
        await this.ensureRandom(true)
        break
      case 'kick':
        this.auth.kick(input.id)
        break
      case 'kickAll':
        this.auth.kickAll()
        break
      case 'openGate': {
        const settings = this.settings?.()
        if (settings === undefined || this.desktopGate() === 'unavailable') throw new LanError('当前不是 DSH Desktop，没有这项设置。')
        if (this.desktopGate() === 'incompatible') throw new LanError('Desktop 当前不是兼容模式，无法允许浏览器访问。')
        await settings.update(DESKTOP_NS, { openBrowser: true })
        this.upstreamAuth.invalidate()
        break
      }
    }
    return this.status(true)
  }

  private async save(patch: LanConfigPatch, fixedPassword: string | undefined): Promise<void> {
    const data = this.deps.store.get()
    const next: LanConfig = { ...data.config }
    if (patch.host !== undefined) {
      const host = patch.host.trim()
      if (!isValidLanHost(host)) throw new LanError('监听地址无效：请填写 IP 地址（如 0.0.0.0）。')
      next.host = host
    }
    if (patch.port !== undefined) next.port = patch.port
    if (patch.protocol !== undefined) next.protocol = patch.protocol
    if (patch.passwordMode !== undefined) next.passwordMode = patch.passwordMode
    if (patch.randomIntervalMinutes !== undefined) {
      if (patch.randomIntervalMinutes < LAN_INTERVAL_MIN || patch.randomIntervalMinutes > LAN_INTERVAL_MAX) {
        throw new LanError(`刷新周期需在 ${LAN_INTERVAL_MIN}–${LAN_INTERVAL_MAX} 分钟之间。`)
      }
      next.randomIntervalMinutes = patch.randomIntervalMinutes
    }
    if (patch.sessionDays !== undefined) next.sessionDays = patch.sessionDays
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    let fixedHash = data.fixedHash
    if (fixedPassword !== undefined) {
      if (fixedPassword.length < LAN_FIXED_PASSWORD_MIN || fixedPassword.length > LAN_FIXED_PASSWORD_MAX) {
        throw new LanError(`固定密码长度需在 ${LAN_FIXED_PASSWORD_MIN}–${LAN_FIXED_PASSWORD_MAX} 位之间。`)
      }
      fixedHash = hashPassword(fixedPassword)
    }
    if (next.passwordMode === 'fixed' && fixedHash === undefined) throw new LanError('请先设置固定密码。')
    if (this.upstream !== undefined && next.port === this.upstream.port) throw new LanError(`端口 ${next.port} 是 DSH 自身端口，请换一个。`)
    const listenChanged =
      next.enabled !== data.config.enabled || next.host !== data.config.host || next.port !== data.config.port || next.protocol !== data.config.protocol
    this.deps.store.save({ ...data, config: next, ...(fixedHash !== undefined ? { fixedHash } : {}) })
    await this.ensureRandom()
    // 只有监听参数变化才重启服务：改密码 / 周期 / 有效期不打断已连接的设备。
    if (listenChanged || (next.enabled && this.state !== 'running')) await this.restart()
  }

  /** 宿主 Web 服务就绪后补一次启动（DSH 启动时插件可能先于 webServer 就绪）。 */
  onUpstreamChange(): void {
    this.upstreamAuth.invalidate()
    if (this.config().enabled && this.state === 'error') void this.serial(() => this.restart())
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.serial(() => this.stopProxy())
  }
}
