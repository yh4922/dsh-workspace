/*
 * @Description: 主机、分组、连接状态等核心数据结构
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/types.ts
 */

/** 认证方式。私钥支持「引用本地路径」与「内容内嵌加密」两种形态。 */
export type HostAuth =
  | { kind: 'password'; password: string }
  | { kind: 'keyPath'; keyPath: string; passphrase?: string }
  | { kind: 'keyContent'; keyContent: string; passphrase?: string }
  | { kind: 'agent' }

/** 出站代理。仅支持 SOCKS5 与 HTTP CONNECT。 */
export interface HostProxy {
  kind: 'socks5' | 'http'
  host: string
  port: number
  username?: string
  password?: string
}

/** 一台可连接的主机。 */
export interface HostRecord {
  id: string
  label: string
  hostname: string
  port: number
  username?: string
  /** 所属分组路径，如 `prod/web`；空串表示根。 */
  groupPath: string
  auth?: HostAuth
  proxy?: HostProxy
  /** 跳板链：按顺序引用其他主机 id，支持多级。 */
  jumpHostIds: string[]
  /** 连接后自动执行的命令。 */
  startupCommand?: string
  /** 附加环境变量。 */
  environmentVariables?: Record<string, string>
  notes?: string
  /**
   * 该主机的远程工作区会话保留本机 shell（pwsh / powershell / cmd）。缺省 = 隐藏。
   * 打开后这些命令在**本机**执行（工具链装在本机时用）；只认 `=== true`，不参与分组继承。
   * 明文字段：保险箱上锁时也要能读到（会话挂载工具、保存主机后即时同步都会读）。
   */
  allowLocalShell?: boolean
  /**
   * 该主机的远程工作区会话可用内置文件工具（read / write / edit / glob / grep）读写本机文件。
   * 缺省 = 关闭（本机绝对路径照旧拒绝）。只认 `=== true`，不参与分组继承。
   * 明文字段：保险箱上锁时也要能读到（会话挂载工具、每次工具调用分发、保存主机后即时同步都会读）。
   */
  allowLocalFiles?: boolean
  createdAt: string
  updatedAt: string
}

/** 分组默认值：主机可继承并逐字段覆盖。 */
export interface GroupDefaults {
  username?: string
  port?: number
  auth?: HostAuth
  proxy?: HostProxy
  jumpHostIds?: string[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
}

/** 一个分组节点。path 用 `/` 分隔，支持多层嵌套。 */
export interface GroupRecord {
  path: string
  defaults: GroupDefaults
  createdAt: string
  updatedAt: string
}

/**
 * 解析完毕的连接参数：已套用分组继承、已解密凭据、跳板链已展开为实际主机。
 * 这是连接池真正消费的形态，不落盘。
 */
export interface ResolvedTarget {
  hostId: string
  label: string
  hostname: string
  port: number
  username: string
  auth: HostAuth
  proxy?: HostProxy
  /** 展开后的跳板链，按连接顺序排列（先连第一个）。 */
  jumpChain: ResolvedTarget[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
}

/** 连接状态，用于 UI 上的状态指示点。 */
export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'error'
  | 'locked'

export interface ConnectionStatus {
  hostId: string
  phase: ConnectionPhase
  /** 最近一次握手到就绪的耗时（毫秒）。 */
  latencyMs?: number
  /** 本次连接建立的时间戳。 */
  connectedAt?: string
  /** 累计重连次数。 */
  reconnectCount: number
  lastError?: string
}

/** 已知主机指纹记录（TOFU）。 */
export interface KnownHostKey {
  /** `hostname:port` */
  endpoint: string
  keyType: string
  /** base64 编码的指纹。 */
  fingerprint: string
  addedAt: string
}

/** 远程工作区绑定：workspaceId 是宿主分配的稳定 UUID。 */
export interface WorkspaceBinding {
  workspaceId: string
  hostId: string
  remotePath: string
  /** 本地目录（满足宿主 realpath 硬约束），位于 ~/.dsh/workspaces/ 下。 */
  localPath: string
  createdAt: string
}

/** 连接日志条目。失败必须逐条可见，禁止静默吞掉。 */
export interface ConnectionLogEntry {
  id: string
  hostId: string
  at: string
  level: 'debug' | 'info' | 'warn' | 'error'
  /** 阶段：handshake / auth / exec / sftp / forward / terminal。 */
  stage: string
  message: string
  detail?: string
}

/**
 * 传给浏览器的主机视图 —— 永远不含任何凭据原文。
 *
 * 浏览器端只需要知道「有没有设置过密码」来决定表单的占位提示，
 * 不需要也不应该拿到密码本身：一旦下发，就会进 DevTools、进页面内存快照。
 */
export interface HostAuthView {
  kind: HostAuth['kind']
  /** keyPath 认证时的私钥路径（路径不是秘密）。 */
  keyPath?: string
  /** 密码 / 私钥内容是否已设置。 */
  hasSecret: boolean
  /** 私钥口令是否已设置。 */
  hasPassphrase: boolean
}

export interface HostProxyView {
  kind: HostProxy['kind']
  host: string
  port: number
  username?: string
  hasPassword: boolean
}

export interface HostView {
  id: string
  label: string
  hostname: string
  port: number
  username?: string
  groupPath: string
  jumpHostIds: string[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
  notes?: string
  allowLocalShell?: boolean
  allowLocalFiles?: boolean
  auth: HostAuthView | null
  proxy: HostProxyView | null
  createdAt: string
  updatedAt: string
}

export interface GroupDefaultsView {
  username?: string
  port?: number
  auth: HostAuthView | null
  proxy: HostProxyView | null
  jumpHostIds?: string[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
}

export interface GroupView {
  path: string
  defaults: GroupDefaultsView
  createdAt: string
  updatedAt: string
}
