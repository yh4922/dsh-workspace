/*
 * @Description: 局域网访问 —— 配置 / 设备 / 随机密码的持久化
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/store.ts
 *
 * lan.json：配置、固定密码哈希、已登录设备（token 只存 sha256）—— 不含任何可直接使用的凭据。
 * lan.secret：当前随机密码。随机密码要在配置页明文显示，没法只存哈希，所以单独一个文件，
 * Windows 下经 DPAPI 加密（与自动解锁同一套 KeyProtector），其他系统仅本人可读（0600）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { renameWithRetry } from '../fs-atomic.js'
import { pluginRoot } from '../paths.js'
import { defaultProtector, type KeyProtector } from '../vault/auto-unlock.js'
import { LAN_DEFAULT_CONFIG, LAN_INTERVAL_MAX, LAN_INTERVAL_MIN, isValidLanHost, type LanConfig, type LanDevice } from '../wire/lan.js'

export interface StoredDevice extends LanDevice {
  /** 登录 token 的 sha256（hex）。 */
  tokenHash: string
}

export interface LanData {
  config: LanConfig
  fixedHash?: string
  devices: StoredDevice[]
}

export interface RandomSecret {
  password: string
  issuedAt: number
  expiresAt: number
}

/** 规范化配置：文件被手改坏或字段缺失时逐项退回默认值，不让整个功能起不来。 */
export function normalizeConfig(raw: unknown): LanConfig {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof LanConfig, unknown>>
  const d = LAN_DEFAULT_CONFIG
  const int = (x: unknown, min: number, max: number, fallback: number): number =>
    typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : fallback
  return {
    enabled: v.enabled === true,
    host: typeof v.host === 'string' && isValidLanHost(v.host) ? v.host : d.host,
    port: int(v.port, 1, 65535, d.port),
    protocol: v.protocol === 'https' ? 'https' : 'http',
    passwordMode: v.passwordMode === 'fixed' ? 'fixed' : 'random',
    randomIntervalMinutes: int(v.randomIntervalMinutes, LAN_INTERVAL_MIN, LAN_INTERVAL_MAX, d.randomIntervalMinutes),
    sessionDays: int(v.sessionDays, 1, 365, d.sessionDays)
  }
}

function normalizeDevices(raw: unknown): StoredDevice[] {
  if (!Array.isArray(raw)) return []
  const out: StoredDevice[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const d = item as Partial<StoredDevice>
    if (typeof d.id !== 'string' || typeof d.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(d.tokenHash)) continue
    out.push({
      id: d.id,
      tokenHash: d.tokenHash,
      ip: typeof d.ip === 'string' ? d.ip : '',
      userAgent: typeof d.userAgent === 'string' ? d.userAgent.slice(0, 500) : '',
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
      lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : 0,
      expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : 0
    })
  }
  return out
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameWithRetry(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows 上 chmod 只影响只读位 */
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    // 去 BOM：用户用 PowerShell 5.1 手改过的文件会带 BOM（作用域记忆踩过的坑）。
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

export class LanStore {
  private data: LanData | undefined

  constructor(
    private readonly dir: () => string = pluginRoot,
    private readonly protector: KeyProtector = defaultProtector()
  ) {}

  private file(): string {
    return path.join(this.dir(), 'lan.json')
  }

  private secretFile(): string {
    return path.join(this.dir(), 'lan.secret')
  }

  get(): LanData {
    if (this.data !== undefined) return this.data
    const raw = readJson(this.file()) as Partial<LanData> | undefined
    this.data = {
      config: normalizeConfig(raw?.config),
      ...(typeof raw?.fixedHash === 'string' && raw.fixedHash.startsWith('scrypt$') ? { fixedHash: raw.fixedHash } : {}),
      devices: normalizeDevices(raw?.devices)
    }
    return this.data
  }

  save(next: LanData): LanData {
    writeAtomic(this.file(), JSON.stringify({ version: 1, ...next }, null, 2))
    this.data = next
    return next
  }

  update(fn: (current: LanData) => LanData): LanData {
    return this.save(fn(this.get()))
  }

  /** 读取随机密码；没有 / 损坏 / 换了账号解不开都返回 undefined（调用方重新生成）。 */
  async loadSecret(): Promise<RandomSecret | undefined> {
    const shape = readJson(this.secretFile()) as { version?: unknown; scheme?: unknown; data?: unknown } | undefined
    if (shape?.version !== 1 || typeof shape.data !== 'string' || shape.scheme !== this.protector.scheme) return undefined
    try {
      const plain = JSON.parse((await this.protector.unprotect(shape.data)).toString('utf8')) as Partial<RandomSecret>
      if (typeof plain.password !== 'string' || typeof plain.expiresAt !== 'number' || typeof plain.issuedAt !== 'number') return undefined
      return { password: plain.password, issuedAt: plain.issuedAt, expiresAt: plain.expiresAt }
    } catch {
      return undefined
    }
  }

  async saveSecret(secret: RandomSecret): Promise<void> {
    const data = await this.protector.protect(Buffer.from(JSON.stringify(secret), 'utf8'))
    writeAtomic(this.secretFile(), JSON.stringify({ version: 1, scheme: this.protector.scheme, data }))
  }
}
