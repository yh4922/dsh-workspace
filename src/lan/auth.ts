/*
 * @Description: 局域网访问 —— 登录校验、失败锁定、设备会话
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/auth.ts
 *
 * 设备会话与密码解耦：刷新随机密码不影响已登录设备（用户确认的语义），
 * 只有踢出 / 过期才会失效。token 只在宿主留 sha256，lan.json 泄露也拿不到可用凭据。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { LAN_LOCK_MS, LAN_LOCK_THRESHOLD, type LanDevice } from '../wire/lan.js'
import { sameString, verifyPassword } from './password.js'
import type { LanStore, StoredDevice } from './store.js'

const DAY_MS = 24 * 60 * 60_000
/** 最后活跃时间最多每分钟落盘一次：每个请求都写文件代价太高。 */
const TOUCH_SAVE_MS = 60_000
/** 设备上限：超出时挤掉最久未活跃的，防止被反复登录撑大文件。 */
const MAX_DEVICES = 50

export type LoginResult =
  | { ok: true; token: string; device: LanDevice }
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  | { ok: false; reason: 'wrong'; remaining: number }
  | { ok: false; reason: 'unset' }

export interface PasswordSource {
  mode(): 'fixed' | 'random'
  fixedHash(): string | undefined
  randomPassword(): string | undefined
  sessionDays(): number
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function publicDevice(d: StoredDevice): LanDevice {
  const { tokenHash: _omit, ...rest } = d
  void _omit
  return rest
}

export class LanAuth {
  private failures = new Map<string, { count: number; lockedUntil: number }>()
  private lastSaved = new Map<string, number>()
  private kickListeners = new Set<(ids: ReadonlySet<string>) => void>()

  constructor(
    private readonly store: LanStore,
    private readonly source: PasswordSource,
    private readonly now: () => number = Date.now
  ) {}

  /** 设备被踢出时通知（代理据此断开该设备的 WebSocket）。 */
  onKick(listener: (ids: ReadonlySet<string>) => void): () => void {
    this.kickListeners.add(listener)
    return () => this.kickListeners.delete(listener)
  }

  lockRemaining(ip: string): number {
    const f = this.failures.get(ip)
    if (f === undefined) return 0
    const left = f.lockedUntil - this.now()
    return left > 0 ? left : 0
  }

  login(ip: string, userAgent: string, password: string): LoginResult {
    const locked = this.lockRemaining(ip)
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked }
    const mode = this.source.mode()
    let ok = false
    if (mode === 'fixed') {
      const hash = this.source.fixedHash()
      if (hash === undefined) return { ok: false, reason: 'unset' }
      ok = verifyPassword(password, hash)
    } else {
      const current = this.source.randomPassword()
      if (current === undefined) return { ok: false, reason: 'unset' }
      ok = sameString(password.trim(), current)
    }
    if (!ok) {
      const prev = this.failures.get(ip)
      // 锁定期过了重新计数，而不是在旧计数上累加（否则解锁后输错一次就又被锁）。
      const count = (prev !== undefined && prev.lockedUntil <= this.now() && prev.count >= LAN_LOCK_THRESHOLD ? 0 : (prev?.count ?? 0)) + 1
      const lockedUntil = count >= LAN_LOCK_THRESHOLD ? this.now() + LAN_LOCK_MS : 0
      this.failures.set(ip, { count, lockedUntil })
      if (lockedUntil > 0) return { ok: false, reason: 'locked', retryAfterMs: LAN_LOCK_MS }
      return { ok: false, reason: 'wrong', remaining: LAN_LOCK_THRESHOLD - count }
    }
    this.failures.delete(ip)
    const token = randomBytes(32).toString('base64url')
    const at = this.now()
    const device: StoredDevice = {
      id: randomUUID(),
      tokenHash: tokenHash(token),
      ip,
      userAgent: userAgent.slice(0, 500),
      createdAt: at,
      lastSeenAt: at,
      expiresAt: at + this.source.sessionDays() * DAY_MS
    }
    this.store.update((data) => {
      const alive = data.devices.filter((d) => d.expiresAt > at).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      return { ...data, devices: [device, ...alive].slice(0, MAX_DEVICES) }
    })
    return { ok: true, token, device: publicDevice(device) }
  }

  /** 按 cookie 里的 token 找设备；顺带刷新最后活跃时间（节流落盘）。 */
  authenticate(token: string | undefined, ip?: string): LanDevice | undefined {
    if (token === undefined || token === '') return undefined
    const hash = tokenHash(token)
    const at = this.now()
    const device = this.store.get().devices.find((d) => d.tokenHash === hash)
    if (device === undefined || device.expiresAt <= at) return undefined
    device.lastSeenAt = at
    if (ip !== undefined && ip !== '') device.ip = ip
    const saved = this.lastSaved.get(device.id) ?? 0
    if (at - saved >= TOUCH_SAVE_MS) {
      this.lastSaved.set(device.id, at)
      try {
        this.store.save(this.store.get())
      } catch {
        /* 活跃时间落盘失败不影响访问 */
      }
    }
    return publicDevice(device)
  }

  devices(): LanDevice[] {
    const at = this.now()
    return this.store
      .get()
      .devices.filter((d) => d.expiresAt > at)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(publicDevice)
  }

  kick(id: string): void {
    this.store.update((data) => ({ ...data, devices: data.devices.filter((d) => d.id !== id) }))
    this.emitKick(new Set([id]))
  }

  kickAll(): void {
    const ids = new Set(this.store.get().devices.map((d) => d.id))
    this.store.update((data) => ({ ...data, devices: [] }))
    this.emitKick(ids)
  }

  private emitKick(ids: ReadonlySet<string>): void {
    for (const listener of [...this.kickListeners]) {
      try {
        listener(ids)
      } catch {
        /* 忽略 */
      }
    }
  }
}
