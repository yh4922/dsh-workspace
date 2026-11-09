/*
 * @Description: 局域网访问（远程访问）—— 宿主与浏览器共享的类型与常量
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/wire/lan.ts
 *
 * 本文件会被打进浏览器 bundle，不得 import zod 或任何 node: 模块。
 */

export type LanProtocol = 'http' | 'https'
export type LanPasswordMode = 'fixed' | 'random'

/** 用户可编辑的配置（持久化在 ~/.dsh/workspaces/lan.json）。 */
export interface LanConfig {
  /** 总开关；DSH 启动时据此自动拉起服务。 */
  enabled: boolean
  /** 监听地址，默认 0.0.0.0（全部网卡）。 */
  host: string
  /** 监听端口，默认 3088。被占用时报错停止，不自动换端口（手机上记住的地址会失效）。 */
  port: number
  protocol: LanProtocol
  passwordMode: LanPasswordMode
  /** 随机密码刷新周期（分钟）。 */
  randomIntervalMinutes: number
  /** 登录有效期（天）。 */
  sessionDays: number
}

export const LAN_DEFAULT_CONFIG: LanConfig = {
  enabled: false,
  host: '0.0.0.0',
  port: 3088,
  protocol: 'http',
  passwordMode: 'random',
  randomIntervalMinutes: 60,
  sessionDays: 7
}

/** 随机密码刷新周期预设（分钟）。 */
export const LAN_INTERVAL_PRESETS = [30, 60, 1440] as const
/** 登录有效期可选值（天）。 */
export const LAN_SESSION_DAYS = [1, 7, 30] as const
export const LAN_INTERVAL_MIN = 5
export const LAN_INTERVAL_MAX = 30 * 24 * 60
export const LAN_FIXED_PASSWORD_MIN = 4
export const LAN_FIXED_PASSWORD_MAX = 128

/** 同一 IP 连续输错多少次锁定、锁定多久。 */
export const LAN_LOCK_THRESHOLD = 5
export const LAN_LOCK_MS = 5 * 60_000

/** 已登录设备（token 只在宿主存 sha256，这里不含任何凭据）。 */
export interface LanDevice {
  id: string
  ip: string
  userAgent: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

export type LanRunState = 'stopped' | 'starting' | 'running' | 'error'

/** Desktop「允许在浏览器中打开」门禁：open = 已开启；closed = 关着（代理会被宿主 403）；unavailable = 非 Desktop，无此门禁。 */
export type LanDesktopGate = 'open' | 'closed' | 'unavailable' | 'incompatible'

export interface LanStatus {
  config: LanConfig
  /** 是否已设置固定密码（只给布尔值，哈希不出宿主）。 */
  hasFixedPassword: boolean
  state: LanRunState
  /** state = error 时的原因（端口被占用等）。 */
  error?: string
  /** 访问地址（本机全部局域网 IPv4）。 */
  urls: string[]
  /** 当前随机密码；只有本机调用（带 localKey）才返回。 */
  password?: string
  /** 随机密码下次刷新时间。 */
  passwordExpiresAt?: number
  devices: LanDevice[]
  /** 调用方是否本机（经代理访问的页面为 false，配置只读）。 */
  local: boolean
  desktopGate: LanDesktopGate
  /** 代理的上游（本机 DSH Web 服务）地址；宿主 Web 服务未就绪时为空。 */
  upstream?: string
}

export interface LanConfigPatch {
  enabled?: boolean
  host?: string
  port?: number
  protocol?: LanProtocol
  passwordMode?: LanPasswordMode
  randomIntervalMinutes?: number
  sessionDays?: number
}

export type LanInput =
  | { op: 'status'; localKey?: string }
  | { op: 'save'; localKey: string; patch: LanConfigPatch; fixedPassword?: string }
  | { op: 'refreshPassword'; localKey: string }
  | { op: 'kick'; localKey: string; id: string }
  | { op: 'kickAll'; localKey: string }
  | { op: 'openGate'; localKey: string }

/** 每个 op 都返回最新状态，界面直接整份替换。 */
export type LanOutput = LanStatus

/** 宿主路由：本机直连返回 localKey；代理对同一路径自己应答 proxied=true。 */
export const LAN_WHOAMI_PATH = '/dsh-workspace/lan/whoami'

export interface LanWhoami {
  proxied: boolean
  localKey?: string
}

/** 代理自己的路径前缀（登录页、登录、登出），不会转发给宿主。 */
export const LAN_PROXY_PREFIX = '/__dshws_lan'
export const LAN_COOKIE = 'dshws_lan'

/** 校验 host：IPv4 字面量、0.0.0.0、::、localhost。只用于界面提示与宿主二次校验。 */
export function isValidLanHost(host: string): boolean {
  if (host === 'localhost' || host === '::' || host === '0.0.0.0') return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host.split('.').every((p) => Number(p) <= 255)
  return /^[0-9a-fA-F:]+$/.test(host) && host.includes(':')
}
