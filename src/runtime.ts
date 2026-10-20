/*
 * @Description: 插件运行时句柄的类型与组装（独立成文件以避免 index ↔ gateway 循环依赖）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/runtime.ts
 */
import { ConnectionLog } from './log/connection-log.js'
import { KnownHosts } from './ssh/hostkey.js'
import { SshPool } from './ssh/pool.js'
import { ResolveError, resolveTarget } from './vault/inherit.js'
import { Vault, VaultLockedError, VaultUninitializedError } from './vault/store.js'
import { TerminalRegistry, type ShellOpener } from './terminal/registry.js'
import { bytesForLines } from './terminal/scrollback.js'
import { createSshShellOpener } from './terminal/ssh-shell.js'
import { RemoteFs } from './sftp/remote-fs.js'
import { PrefsStore } from './prefs.js'
import { BindingStore } from './workspace/bindings.js'
import { PreimageStore } from './agent/preimages.js'
import { PreviewGrants } from './preview-route.js'
import { autoUnlockFile, pluginRoot, terminalsFile } from './paths.js'
import { AutoUnlockStore, type KeyProtector } from './vault/auto-unlock.js'
import type { ResolvedTarget } from './types.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Updater, type PluginManagerLike } from './update/updater.js'
import { realpath } from 'node:fs/promises'
import { LOCAL_ANY_ID, LocalFs, sessionOfLocalId, type LocalScope } from './local/local-fs.js'
import { LocalGit } from './local/local-git.js'
import type { HostInternal } from './host-internal/index.js'
import { MemoryRuntime } from './memory/runtime.js'

/** 插件运行时配置（与 index.ts 的 Config schema 对应）。 */
export interface RuntimeConfig {
  transferConcurrency: number
  commandTimeoutMs: number
  connectTimeoutMs: number
  maxReconnectAttempts: number
  scrollbackLines: number
  maxReadBytes: number
  logCapacity: number
  /** 无人查看的终端多久后自动回收（分钟）。0 表示永不回收。 */
  terminalDetachedTtlMinutes: number
  /** 单次上传上限（MB）。 */
  maxUploadMegabytes: number
}

/** 各模块（网关、终端、SFTP、Agent 工具）共享的运行时依赖。 */
export interface WorkspaceRuntime {
  readonly config: RuntimeConfig
  readonly log: ConnectionLog
  readonly vault: Vault
  readonly knownHosts: KnownHosts
  readonly pool: SshPool
  readonly terminals: TerminalRegistry
  readonly files: RemoteFs
  /** 本地工作区文件（hostId 形如 local:<sessionId>，根目录按会话 cwd 推导）。 */
  readonly localFiles: LocalFs
  /** 本地会话的工作区范围（根目录 + 同仓库的其他 git 工作目录）。 */
  localScope(id: string): Promise<LocalScope>
  readonly prefs: PrefsStore
  /** 远程工作区：本地占位目录 ↔ {主机, 远程路径}。 */
  readonly bindings: BindingStore
  /** 远程写入前的原内容存档。 */
  readonly preimages: PreimageStore
  /** HTML 预览令牌（进程内存，插件重载即失效）。 */
  readonly previews: PreviewGrants
  /** 自动解锁（本机记住主密钥）。 */
  readonly autoUnlock: AutoUnlockStore
  /** 启动时的自动解锁尝试；网关的 state 先等它，界面就不会先闪出「已锁定」。 */
  readonly autoUnlockReady: Promise<void>
  /** 宿主 HTTP 侧状态（由 index.ts 在路由挂载 / 撤下时更新）。 */
  readonly web: WebState
  /** 宿主可选服务（由 index.ts 在 ctx.inject 子作用域里填入 / 撤下）。 */
  readonly host: HostServices
  /** 插件自更新。 */
  readonly updater: Updater
  /** 作用域记忆（数据在 ~/.dsh/workspaces/memory）。 */
  readonly memory: MemoryRuntime
  /** 按 hostId 解析出可连接目标（套用分组继承、展开跳板链、按需解密凭据）。 */
  resolveHost(hostId: string): ResolvedTarget
  /** 释放全部资源（终端、文件会话、连接池、内存中的密钥）。 */
  dispose(): void
}

export interface WebState {
  /** 终端 WebSocket、文件上传 / 下载、资源路由是否已挂到宿主 webServer 上。 */
  mounted: boolean
  /** 编辑器资源目录（构建产物 lib/assets）；未设置时编辑器不可用。 */
  assetsDir: string | undefined
}

export interface HostServices {
  /** 宿主插件管理器（安装 / 升级插件）；纯 dsh web 等环境可能没有。 */
  pluginManager: PluginManagerLike | undefined
  /** 宿主会话服务：按 sessionId 取 cwd（本地文件管理 / Git 仓库据此确定根目录）。 */
  sessions: SessionsLike | undefined
  /** 冷会话（未加载进内存）的持久化记录。 */
  sessionPersistence: SessionPersistenceLike | undefined
  /** 宿主内部对象适配层（任务页：子代理 / 团队 / 会话事件，见 host-internal/）；未装配时任务页数据返回不可用。 */
  internal: HostInternal | undefined
}

export interface SessionPersistenceLike {
  stat(id: string): Promise<{ header?: { cwd?: string } } | undefined> | { header?: { cwd?: string } } | undefined
  /** 只读打开冷会话的事件日志（DSH 0.1.5+；不取写权限，会话在别处运行时也能读）。 */
  open?(id: string, mode: 'read'): Promise<{ read(): Promise<{ events: readonly unknown[] }>; close(): Promise<void> | void }>
}

/** 宿主 sessions 服务里本插件用到的部分。 */
export interface SessionsLike {
  get(id: string): { header?: { cwd?: string }; snapshotEvents?(): readonly unknown[] } | undefined
}

export interface RuntimeOverrides {
  /** 测试替身：不走真实 SSH 的 shell 打开器。 */
  shellOpener?: ShellOpener
  /** 测试用：不持久化「最近终端」。 */
  persistTerminals?: boolean
  /** 测试替身：自动解锁的密钥保护方式（默认 Windows DPAPI）。 */
  keyProtector?: KeyProtector
  /** 测试用：作用域记忆的数据目录（默认 ~/.dsh/workspaces/memory）。 */
  memoryRoot?: string
}

/**
 * 组装运行时。index.ts 与测试共用这一份，保证测试覆盖的就是真实运行的装配逻辑。
 */
export function createRuntime(config: RuntimeConfig, overrides: RuntimeOverrides = {}): WorkspaceRuntime {
  const log = new ConnectionLog(config.logCapacity)
  const vault = new Vault()
  const knownHosts = new KnownHosts()
  const pool = new SshPool(knownHosts, log, {
    timeoutMs: config.connectTimeoutMs,
    maxReconnectAttempts: config.maxReconnectAttempts,
    // 保险箱锁定 / 未初始化、配置错误（缺用户名、跳板成环）都不会随时间自愈，重试只是白等。
    isRetryable: (error) =>
      !(error instanceof VaultLockedError) &&
      !(error instanceof VaultUninitializedError) &&
      !(error instanceof ResolveError)
  })

  /**
   * 每次连接都重新解析目标，而不是缓存 ResolvedTarget。
   * 这样用户在管理页面改了主机配置（换密钥、改跳板）后，
   * 下一次重连自动生效，不需要手动断开。
   */
  const resolveHost = (hostId: string): ResolvedTarget => {
    if (vault.isUnlocked()) {
      // 已解锁时整库解密。不能只给目标和直接跳板取凭据：分组继承来的跳板、
      // 跳板自身的跳板（多级链）、从分组继承的密码，都需要完整凭据才能连。
      const { hosts, groups } = vault.exportPlain()
      return resolveTarget(hostId, new Map(hosts.map((h) => [h.id, h])), groups)
    }
    // 未解锁：用无凭据版本尝试。整条链路都不需要密码（例如私钥路径且无口令）
    // 时照样能连，只有真正缺凭据时才要求解锁 —— 懒解锁的本意。
    try {
      return resolveTarget(
        hostId,
        new Map(vault.listHosts().map((h) => [h.id, h])),
        vault.listGroups()
      )
    } catch (error) {
      if (error instanceof ResolveError && vault.isInitialized() && /锁定/.test(error.message)) {
        throw new VaultLockedError()
      }
      throw error
    }
  }

  // 终端注册表与文件服务都依赖运行时本身（连接池、目标解析），
  // 所以先建出不含它们的部分，再补上。
  const prefs = new PrefsStore()
  const web: WebState = { mounted: false, assetsDir: undefined }
  const host: HostServices = { pluginManager: undefined, sessions: undefined, sessionPersistence: undefined, internal: undefined }
  // 包根目录的 package.json：打包后本文件在 lib/index.js，源码时在 src/runtime.ts，上一级都是包根。
  const updater = new Updater({
    packageFile: fileURLToPath(new URL('../package.json', import.meta.url)),
    dir: path.join(pluginRoot(), 'updates'),
    log,
    pluginManager: () => host.pluginManager
  })
  const bindings = new BindingStore()
  const preimages = new PreimageStore()
  const previews = new PreviewGrants()
  const autoUnlock = new AutoUnlockStore(autoUnlockFile, overrides.keyProtector)
  // 自动解锁失败（换了 Windows 账号、改过主密码、文件损坏）不影响使用：记日志，回到手动输入主密码。
  const autoUnlockReady = (async () => {
    if (!autoUnlock.enabled() || !vault.isInitialized() || vault.isUnlocked()) return
    try {
      const key = await autoUnlock.load()
      if (key !== undefined && vault.unlockWithKey(key)) log.info('', 'vault', '已自动解锁保险箱（本机记住的主密钥）。')
      else log.warn('', 'vault', '自动解锁失败：保存的密钥与当前主密码不匹配，请手动解锁后重新开启自动解锁。')
    } catch (error) {
      log.warn('', 'vault', `自动解锁失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  const partial = { config, log, vault, knownHosts, pool, resolveHost, prefs, web, host, updater, bindings, preimages, previews, autoUnlock, autoUnlockReady } as Omit<
    WorkspaceRuntime,
    'terminals' | 'files' | 'localFiles' | 'localScope' | 'dispose' | 'memory'
  >
  const runtime = partial as WorkspaceRuntime
  const terminals = new TerminalRegistry(overrides.shellOpener ?? createSshShellOpener(runtime), log, {
    scrollbackBytes: bytesForLines(config.scrollbackLines),
    detachedTtlMs: config.terminalDetachedTtlMinutes * 60_000,
    ...(overrides.persistTerminals === false ? {} : { recentFile: terminalsFile() })
  })
  const files = new RemoteFs(runtime, () => prefs.get().ignore)

  /**
   * 本地会话的工作区范围：根目录只由宿主按会话 cwd 推导（浏览器只给会话 id）。
   * 远程工作区的本地占位目录不算本地工作区 —— 那类会话一律走远程通道。
   */
  const localScope = async (id: string): Promise<LocalScope> => {
    // local:* 是只读通道（localRead / 下载路由），不对应任何会话：明确拒绝，不把 '*' 交给宿主会话服务去查。
    if (id === LOCAL_ANY_ID) throw new Error('本机任意路径通道只读，不能用于工作区操作。')
    const sessionId = sessionOfLocalId(id)
    let cwd = host.sessions?.get(sessionId)?.header?.cwd
    if (cwd === undefined) cwd = (await host.sessionPersistence?.stat(sessionId))?.header?.cwd
    if (cwd === undefined || cwd === '') {
      throw new Error(host.sessions === undefined ? '宿主会话服务未就绪，请稍后重试。' : `会话没有工作目录（或会话不存在）：${sessionId}`)
    }
    if (bindings.resolve(cwd) !== undefined) throw new Error('这是远程工作区会话，请使用远程文件通道。')
    const root = await realpath(cwd)
    return {
      root,
      extraRoots: async () => (await new LocalGit(root).worktreeRoots().catch(() => [])).map((p) => path.resolve(p))
    }
  }
  const localFiles = new LocalFs(localScope, log, () => prefs.get().ignore)
  const memory = new MemoryRuntime(runtime, overrides.memoryRoot)

  Object.assign(runtime, {
    terminals,
    files,
    localFiles,
    localScope,
    memory,
    dispose() {
      memory.dispose()
      // 先关终端与文件会话（它们挂在连接池的连接上），再关连接池。
      terminals.dispose()
      files.dispose()
      pool.dispose()
      vault.lock()
      log.clear()
    }
  })
  return runtime
}

/** 默认配置，与 index.ts 的 Config schema 默认值保持一致（测试与降级场景使用）。 */
export const DEFAULT_CONFIG: RuntimeConfig = {
  transferConcurrency: 8,
  commandTimeoutMs: 120_000,
  connectTimeoutMs: 20_000,
  maxReconnectAttempts: 5,
  scrollbackLines: 5000,
  maxReadBytes: 1024 * 1024,
  logCapacity: 500,
  terminalDetachedTtlMinutes: 30,
  maxUploadMegabytes: 2048
}
