/*
 * @Description: Typert 远程网关 —— 浏览器调用宿主的唯一入口
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/gateway.ts
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { RemoteError, RemoteService, remoteErrorOf } from './wire/remote.js'
import type { WorkspaceRuntime } from './runtime.js'
import type { GroupRecord, HostAuth, HostProxy, HostRecord } from './types.js'
import { ERROR_CODES, SERVICE } from './wire/contract.js'
import type { AuthInput, MethodIO, ProxyInput, SaveGroupInput, SaveHostInput } from './wire/dto.js'
import { isSsh2Available, ssh2LoadFailure } from './ssh/lazy.js'
import { HostKeyChangedError } from './ssh/hostkey.js'
import { SshConnection } from './ssh/connection.js'
import { ResolveError, resolveTarget } from './vault/inherit.js'
import type { ResolvedTarget } from './types.js'
import { VaultLockedError, VaultUninitializedError, normalizeGroupPath } from './vault/store.js'
import type { TerminalView } from './terminal/registry.js'
import { RemoteConflictError, RemoteExistsError, normalizeRemotePath } from './sftp/remote-fs.js'
import { DEFAULT_IGNORE } from './sftp/ignore.js'
import { insideRoot, previewUrl } from './preview-route.js'
import { GitError, RemoteGit } from './git/remote-git.js'
import { LocalBrowseError, listLocalDirectory, makeLocalDirectory } from './local/browse.js'
import { fromLocalPosix, isLocalId, toLocalPosix } from './local/local-fs.js'
import { LocalGit } from './local/local-git.js'
import type { GitRepo } from './git/remote-git.js'
import type { RemoteFs } from './sftp/remote-fs.js'
import { toRemotePath } from './workspace/bindings.js'
import { REMOTE_MARKER } from './agent/present-tool.js'

/** 远程（RemoteFs）与本地（LocalFs）共同的文件操作面。 */
type FileOps = Pick<
  RemoteFs,
  'home' | 'list' | 'readText' | 'readData' | 'writeText' | 'mkdir' | 'createFile' | 'rename' | 'remove' | 'copy' | 'search' | 'openDownload' | 'upload' | 'statPath'
>

/**
 * 本机浏览错误 → 远程错误。消息沿用宿主 DirectoryBrowseError 的格式（`directory-picker/<kind>: ...`），
 * 浏览器端 classifyBrowseError / isEmptyDirQuirk 对两种来源一视同仁。
 */
function localRemote(error: unknown): unknown {
  if (!(error instanceof LocalBrowseError)) return error
  const kind = error.kind === 'invalid' ? 'unreadable' : error.kind
  const code = error.kind === 'exists' ? ERROR_CODES.exists : ERROR_CODES.failed
  return new RemoteError(code, `directory-picker/${kind}: ${error.message}`, {})
}

/** 新建主机测试时的临时 id（不会进入保险箱）。 */
const DRAFT_ID = '__draft__'

/** 编辑器资源分段大小（字符数）。 */
const ASSET_CHUNK_CHARS = 512 * 1024

type In<M extends keyof MethodIO> = MethodIO[M][0]
type Out<M extends keyof MethodIO> = Promise<MethodIO[M][1]>

/** SFTP 协议状态码（ssh2 放在 error.code 上）。 */
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3

/**
 * 把内部异常映射为带稳定 code 的 RemoteError。
 *
 * 网关会把普通 Error 统一包成 `gateway/internal`，浏览器就无法区分
 * 「保险箱锁了（该弹解锁框）」与「连接失败（该显示原因）」。所以这里逐类映射。
 */
export function toRemote(error: unknown): RemoteError {
  // 已经是带 code 的 RemoteError（如 ssh2-unavailable）就原样放行，
  // 否则会被下面的兜底分支改写成 failed，浏览器据 code 的分支全部失效。
  const existing = remoteErrorOf(error)
  if (existing !== undefined) return existing as RemoteError
  if (error instanceof VaultLockedError) {
    return new RemoteError(ERROR_CODES.vaultLocked, error.message, {})
  }
  if (error instanceof VaultUninitializedError) {
    return new RemoteError(ERROR_CODES.vaultUninitialized, error.message, {})
  }
  if (error instanceof HostKeyChangedError) {
    return new RemoteError(ERROR_CODES.hostKeyChanged, error.message, {
      endpoint: error.endpoint,
      expected: error.expected,
      actual: error.actual
    })
  }
  if (error instanceof ResolveError) {
    return new RemoteError(ERROR_CODES.invalidConfig, error.message, {})
  }
  if (error instanceof RemoteConflictError) {
    return new RemoteError(ERROR_CODES.conflict, error.message, { mtime: error.mtime, size: error.size })
  }
  if (error instanceof RemoteExistsError) {
    return new RemoteError(ERROR_CODES.exists, error.message, { path: error.remotePath })
  }
  const sftpCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  // 本地文件（node:fs）的错误码。
  if (sftpCode === 'ENOENT') return new RemoteError(ERROR_CODES.notFound, '路径不存在（可能已被删除或移动）。', {})
  if (sftpCode === 'EACCES' || sftpCode === 'EPERM') return new RemoteError(ERROR_CODES.failed, '权限不足：当前用户无权执行此操作（或文件正被其他程序占用）。', {})
  if (sftpCode === 'EEXIST') return new RemoteError(ERROR_CODES.exists, '目标已存在。', { path: String((error as { path?: unknown }).path ?? '') })
  if (sftpCode === 'ENOTEMPTY') return new RemoteError(ERROR_CODES.failed, '目录不为空。', {})
  if (sftpCode === SFTP_NO_SUCH_FILE) {
    // ssh2 的原始消息只有 "No such file"，补上可读说明。
    return new RemoteError(ERROR_CODES.notFound, '远端路径不存在（可能已被删除或移动）。', {})
  }
  if (sftpCode === SFTP_PERMISSION_DENIED) {
    return new RemoteError(ERROR_CODES.failed, '权限不足：当前登录用户无权执行此操作。', {})
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteError(ERROR_CODES.failed, message, {})
}

export class WorkspaceGateway extends RemoteService {
  private readonly rt: WorkspaceRuntime

  constructor(ctx: Context, runtime: WorkspaceRuntime) {
    super(ctx, SERVICE)
    this.rt = runtime
  }

  /** 统一包裹：同步与异步异常都走 toRemote。 */
  private async guard<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      throw toRemote(error)
    }
  }

  // ---------------------------------------------------------------- 状态

  state(_: In<'state'>): Out<'state'> {
    return this.guard(async () => {
      // 先等启动时的自动解锁：否则界面会先闪出「已锁定」再自己消失。
      await this.rt.autoUnlockReady
      const { vault, pool, knownHosts } = this.rt
      const failure = ssh2LoadFailure()
      return {
        initialized: vault.isInitialized(),
        unlocked: vault.isUnlocked(),
        autoUnlock: { enabled: this.rt.autoUnlock.enabled(), scheme: this.rt.autoUnlock.scheme },
        ssh2: {
          available: isSsh2Available(),
          ...(failure !== undefined
            ? { error: failure instanceof Error ? failure.message : String(failure) }
            : {})
        },
        hosts: vault.listHostViews(),
        groups: vault.listGroupViews(),
        statuses: pool.listStatuses(),
        knownHosts: knownHosts.list(),
        terminals: this.rt.terminals.list(),
        recentTerminals: this.rt.terminals.listRecent(),
        webRoutes: this.rt.web.mounted
      }
    })
  }

  // ---------------------------------------------------------------- 主密码

  initVault(input: In<'initVault'>): Out<'initVault'> {
    return this.guard(() => {
      this.rt.vault.initialize(input.password)
      this.rt.log.info('', 'vault', '已设置主密码。')
      return { ok: true as const }
    })
  }

  unlock(input: In<'unlock'>): Out<'unlock'> {
    return this.guard(() => {
      const ok = this.rt.vault.unlock(input.password)
      // 解锁失败要留痕：连续失败可能是有人在试密码。
      if (ok) this.rt.log.info('', 'vault', '保险箱已解锁。')
      else this.rt.log.warn('', 'vault', '主密码错误，解锁失败。')
      return { ok }
    })
  }

  lock(_: In<'lock'>): Out<'lock'> {
    return this.guard(() => {
      this.rt.vault.lock()
      this.rt.log.info('', 'vault', '保险箱已上锁。')
      return { ok: true as const }
    })
  }

  changePassword(input: In<'changePassword'>): Out<'changePassword'> {
    return this.guard(async () => {
      const ok = this.rt.vault.changeMasterPassword(input.oldPassword, input.newPassword)
      if (ok) this.rt.log.info('', 'vault', '主密码已修改。')
      else this.rt.log.warn('', 'vault', '修改主密码失败：原密码错误。')
      // 已开启自动解锁：换成新密钥，否则下次启动会因密钥不匹配而解锁失败。
      if (ok && this.rt.autoUnlock.enabled()) await this.rt.autoUnlock.save(this.rt.vault.exportKey())
      return { ok }
    })
  }

  /**
   * 自动解锁开关。开启需要再输入一次主密码（确认是本人在操作），然后把密钥加密保存在本机；
   * 关闭即删除该文件，下次启动恢复手动输入主密码。
   */
  setAutoUnlock(input: In<'setAutoUnlock'>): Out<'setAutoUnlock'> {
    return this.guard(async () => {
      if (!input.enabled) {
        this.rt.autoUnlock.clear()
        this.rt.log.info('', 'vault', '已关闭自动解锁，下次启动需要输入主密码。')
        return { ok: true, enabled: false }
      }
      if (!this.rt.vault.unlock(input.password ?? '')) {
        this.rt.log.warn('', 'vault', '开启自动解锁失败：主密码错误。')
        return { ok: false, enabled: this.rt.autoUnlock.enabled() }
      }
      await this.rt.autoUnlock.save(this.rt.vault.exportKey())
      this.rt.log.info('', 'vault', `已开启自动解锁（${this.rt.autoUnlock.scheme === 'dpapi' ? 'Windows DPAPI 加密保存' : '仅本人可读的文件'}）。`)
      return { ok: true, enabled: true }
    })
  }

  // ---------------------------------------------------------------- 主机

  saveHost(input: In<'saveHost'>): Out<'saveHost'> {
    return this.guard(() => {
      const { vault, pool } = this.rt
      const existing = input.id !== undefined ? vault.getHost(input.id) : undefined
      if (input.id !== undefined && existing === undefined) {
        throw new Error(`主机不存在：${input.id}`)
      }
      if (input.id !== undefined && input.jumpHostIds.includes(input.id)) {
        throw new Error('主机不能把自己设为跳板机。')
      }
      for (const jumpId of input.jumpHostIds) {
        if (vault.getHost(jumpId) === undefined) throw new Error(`跳板机不存在：${jumpId}`)
      }

      const plain = plainHostFields(input)

      if (existing === undefined) {
        const auth = input.auth == null ? undefined : buildAuth(input.auth, undefined)
        const proxy = input.proxy == null ? undefined : buildProxy(input.proxy, undefined)
        const created = vault.createHost({
          ...plain,
          ...(auth !== undefined ? { auth } : {}),
          ...(proxy !== undefined ? { proxy } : {})
        })
        this.rt.log.info(created.id, 'config', `已新增主机「${created.label}」。`)
        return viewOf(this.rt, created.id)
      }

      // 编辑：只有真的改了凭据才去取旧密文 —— 改个备注不该要求解锁。
      const patch: Parameters<typeof vault.updateHost>[1] = { ...plain }
      if (input.auth !== undefined) {
        patch.auth =
          input.auth === null ? null : buildAuth(input.auth, () => this.secretsOf(existing.id).auth)
      }
      if (input.proxy !== undefined) {
        patch.proxy =
          input.proxy === null
            ? null
            : buildProxy(input.proxy, () => this.secretsOf(existing.id).proxy)
      }
      vault.updateHost(existing.id, patch)

      // 只有「连接方式」变了才断开：改名、改备注、改启动命令不影响已建立的连接，
      // 断开会把该主机上正在用的终端全部杀掉。
      if (connectionChanged(existing, input)) {
        pool.disconnect(existing.id)
        this.rt.log.info(existing.id, 'config', '连接参数已变更，已断开旧连接，下次使用时按新配置重连。')
      }
      this.rt.log.info(existing.id, 'config', `已更新主机「${input.label}」。`)
      return viewOf(this.rt, existing.id)
    })
  }

  deleteHost(input: In<'deleteHost'>): Out<'deleteHost'> {
    return this.guard(() => {
      const host = this.rt.vault.getHost(input.id)
      this.rt.vault.deleteHost(input.id)
      this.rt.terminals.closeHost(input.id)
      this.rt.pool.disconnect(input.id)
      this.rt.log.info(input.id, 'config', `已删除主机「${host?.label ?? input.id}」。`)
      return { ok: true as const }
    })
  }

  /** 按需取某主机的旧凭据（编辑时沿用未修改的密码）。 */
  private secretsOf(id: string): HostRecord {
    const host = this.rt.vault.getHostWithSecrets(id)
    if (host === undefined) throw new Error(`主机不存在：${id}`)
    return host
  }

  // ---------------------------------------------------------------- 分组

  saveGroup(input: In<'saveGroup'>): Out<'saveGroup'> {
    return this.guard(() => {
      const { vault } = this.rt
      const path = normalizeGroupPath(input.path)
      const previous =
        input.previousPath !== undefined ? normalizeGroupPath(input.previousPath) : undefined

      // 先原子地改名（密文随记录一起搬走），之后就是对新路径的普通更新。
      if (previous !== undefined && previous !== '' && previous !== path) {
        vault.renameGroup(previous, path)
      }

      const existingSecrets = (): GroupRecord | undefined =>
        vault.listGroupsWithSecrets().find((g) => g.path === path)

      const defaults: Parameters<typeof vault.upsertGroup>[1] = plainGroupDefaults(input)
      if (input.auth !== undefined) {
        defaults.auth =
          input.auth === null ? null : buildAuth(input.auth, () => existingSecrets()?.defaults.auth)
      }
      if (input.proxy !== undefined) {
        defaults.proxy =
          input.proxy === null
            ? null
            : buildProxy(input.proxy, () => existingSecrets()?.defaults.proxy)
      }
      vault.upsertGroup(path, defaults)

      this.rt.log.info('', 'config', `已保存分组「${path}」。`)
      const view = vault.listGroupViews().find((g) => g.path === path)
      if (view === undefined) throw new Error(`分组保存后未找到：${path}`)
      return view
    })
  }

  deleteGroup(input: In<'deleteGroup'>): Out<'deleteGroup'> {
    return this.guard(() => {
      this.rt.vault.deleteGroup(input.path)
      this.rt.log.info('', 'config', `已删除分组「${input.path}」，其下主机已移到根。`)
      return { ok: true as const }
    })
  }

  // ---------------------------------------------------------------- 连接

  /**
   * 测试连接。
   *
   * 用一条独立连接而不是连接池：测试不应该顶掉用户正在用的终端连接，
   * 也不应该在池里留下一条没人用的连接。测完即关。
   */
  testConnection(input: In<'testConnection'>): Out<'testConnection'> {
    return this.guard(() => this.runTest(this.rt.resolveHost(input.id), input.id))
  }

  /**
   * 用表单里尚未保存的配置测试连接（编辑 / 新建弹窗里的「测试」按钮）。
   *
   * 不落盘：按与保存相同的规则构造一条临时主机记录（凭据留空 = 沿用旧值），
   * 在内存里替换进主机库再解析目标 —— 分组继承、跳板链都按「保存后」的样子生效。
   */
  testDraft(input: In<'testDraft'>): Out<'testDraft'> {
    return this.guard(() => {
      const { vault } = this.rt
      const existing = input.id !== undefined ? vault.getHost(input.id) : undefined
      if (input.id !== undefined && existing === undefined) throw new Error(`主机不存在：${input.id}`)
      if (input.id !== undefined && input.jumpHostIds.includes(input.id)) {
        throw new Error('主机不能把自己设为跳板机。')
      }

      const draftId = existing?.id ?? DRAFT_ID
      const previous = existing === undefined ? undefined : () => this.secretsOf(existing.id)
      // 与保存语义一致：undefined = 不改（沿用旧值），null = 去掉。
      const auth =
        input.auth === undefined
          ? previous?.().auth
          : input.auth === null
            ? undefined
            : buildAuth(input.auth, previous === undefined ? undefined : () => previous().auth)
      const proxy =
        input.proxy === undefined
          ? previous?.().proxy
          : input.proxy === null
            ? undefined
            : buildProxy(input.proxy, previous === undefined ? undefined : () => previous().proxy)

      const now = new Date().toISOString()
      const draft: HostRecord = {
        ...plainHostFields(input),
        id: draftId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(auth !== undefined ? { auth } : {}),
        ...(proxy !== undefined ? { proxy } : {})
      }

      // 已解锁用全量明文库（跳板、分组继承的凭据都要）；未解锁只能用无凭据版本。
      const library = vault.isUnlocked()
        ? vault.exportPlain()
        : { hosts: vault.listHosts(), groups: vault.listGroups() }
      const hosts = new Map(library.hosts.map((h) => [h.id, h]))
      hosts.set(draftId, draft)
      let target: ResolvedTarget
      try {
        target = resolveTarget(draftId, hosts, library.groups)
      } catch (error) {
        if (error instanceof ResolveError && !vault.isUnlocked() && vault.isInitialized() && /锁定/.test(error.message)) {
          throw new VaultLockedError()
        }
        throw error
      }
      return this.runTest(target, existing?.id ?? '')
    })
  }

  /**
   * 执行一次连接测试。
   *
   * 用一条独立连接而不是连接池：测试不应该顶掉用户正在用的终端连接，
   * 也不应该在池里留下一条没人用的连接。测完即关。
   */
  private async runTest(target: ResolvedTarget, logId: string): Promise<MethodIO['testConnection'][1]> {
    if (!isSsh2Available()) {
      throw new RemoteError(ERROR_CODES.ssh2Unavailable, 'ssh2 不可用，请查看连接日志中的修复指引。', {})
    }
    const startedAt = Date.now()
    let connection: SshConnection | undefined
    try {
      connection = await SshConnection.connect(target, this.rt.knownHosts, this.rt.log, {
        timeoutMs: this.rt.config.connectTimeoutMs
      })
      const system = await execOnce(connection, 'uname -srm')
      const latencyMs = Date.now() - startedAt
      this.rt.log.info(logId, 'test', `连接测试成功（${latencyMs}ms）：${system}`)
      return { ok: true, latencyMs, message: '连接成功', system }
    } catch (error) {
      // 指纹变更是安全事件，要以专门的 code 抛给浏览器，不能降级成普通失败。
      if (error instanceof HostKeyChangedError) throw error
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    } finally {
      connection?.close()
    }
  }

  disconnect(input: In<'disconnect'>): Out<'disconnect'> {
    return this.guard(() => {
      this.rt.pool.disconnect(input.id)
      this.rt.log.info(input.id, 'handshake', '已手动断开连接。')
      return { ok: true as const }
    })
  }

  /**
   * 遗忘某主机的指纹记录，下次连接重新走 TOFU。
   * 这是「服务器重装后指纹变更」的正规恢复路径，必须由用户显式触发。
   */
  forgetHostKey(input: In<'forgetHostKey'>): Out<'forgetHostKey'> {
    return this.guard(() => {
      const host = this.rt.vault.getHost(input.id)
      if (host === undefined) throw new Error(`主机不存在：${input.id}`)
      this.rt.knownHosts.forget(host.hostname, host.port)
      this.rt.log.warn(
        input.id,
        'handshake',
        `已遗忘 ${host.hostname}:${host.port} 的主机指纹，下次连接将重新记录。`
      )
      return { ok: true as const }
    })
  }

  // ---------------------------------------------------------------- 日志

  logs(input: In<'logs'>): Out<'logs'> {
    return this.guard(() => this.rt.log.list(input.hostId, input.limit ?? 200))
  }

  clearLogs(input: In<'clearLogs'>): Out<'clearLogs'> {
    return this.guard(() => {
      this.rt.log.clear(input.hostId)
      return { ok: true as const }
    })
  }

  // ---------------------------------------------------------------- 终端

  /**
   * 打开终端。等 shell 真正就绪才返回，失败以带 code 的错误抛出：
   * 保险箱锁定时浏览器据此弹解锁框，而不是得到一个立刻报错的空终端。
   */
  openTerminal(input: In<'openTerminal'>): Out<'openTerminal'> {
    return this.guard(async () => {
      if (!isSsh2Available()) {
        throw new RemoteError(ERROR_CODES.ssh2Unavailable, 'ssh2 不可用，请查看连接日志中的修复指引。', {})
      }
      const host = this.rt.vault.getHost(input.hostId)
      if (host === undefined) throw new Error(`主机不存在：${input.hostId}`)
      const title = input.title?.trim() || defaultTitle(host.label, this.rt.terminals.list(), input.hostId)
      return await this.rt.terminals.open(input.hostId, {
        cols: input.cols,
        rows: input.rows,
        title,
        ...(input.cwd !== undefined && input.cwd.trim() !== '' ? { cwd: input.cwd } : {})
      })
    })
  }

  closeTerminal(input: In<'closeTerminal'>): Out<'closeTerminal'> {
    return this.guard(() => {
      this.rt.terminals.close(input.id)
      return { ok: true as const }
    })
  }

  renameTerminal(input: In<'renameTerminal'>): Out<'renameTerminal'> {
    return this.guard(() => this.rt.terminals.rename(input.id, input.title))
  }

  setTerminalKeepAlive(input: In<'setTerminalKeepAlive'>): Out<'setTerminalKeepAlive'> {
    return this.guard(() => this.rt.terminals.setKeepAlive(input.id, input.keepAlive))
  }

  clearRecentTerminals(_: In<'clearRecentTerminals'>): Out<'clearRecentTerminals'> {
    return this.guard(() => {
      this.rt.terminals.clearRecent()
      return { ok: true as const }
    })
  }

  // ---------------------------------------------------------------- 文件（SFTP）

  sftpHome(input: In<'sftpHome'>): Out<'sftpHome'> {
    return this.guard(async () => ({ path: await this.fs(input.hostId).home(input.hostId) }))
  }

  sftpList(input: In<'sftpList'>): Out<'sftpList'> {
    return this.guard(() => this.fs(input.hostId).list(input.hostId, input.path))
  }

  sftpRead(input: In<'sftpRead'>): Out<'sftpRead'> {
    return this.guard(() =>
      this.fs(input.hostId).readText(input.hostId, input.path, this.rt.config.maxReadBytes)
    )
  }

  /**
   * 分段下发编辑器脚本。
   *
   * 为什么不用 HTTP 静态路由：DSH Desktop 里插件的 HTTP 路由实测不可达（资源路由 404），
   * 而本调用走的是浏览器与宿主之间已确认可用的通道，网页版 / 桌面版一致。
   * 分段是为了避免单条消息过大；前端拼接后生成 blob 地址加载，整页只取一次。
   */
  editorAsset(input: In<'editorAsset'>): Out<'editorAsset'> {
    return this.guard(() => {
      const asset = this.readAsset(input.name)
      const total = Math.max(1, Math.ceil(asset.text.length / ASSET_CHUNK_CHARS))
      if (input.index >= total) throw new Error(`分段序号越界：${input.index}/${total}`)
      const start = input.index * ASSET_CHUNK_CHARS
      return { index: input.index, total, chunk: asset.text.slice(start, start + ASSET_CHUNK_CHARS), version: asset.version }
    })
  }

  private assetCache = new Map<string, { text: string; version: string }>()

  /** 读取资源（只接受 EDITOR_ASSETS 白名单里的名字，由输入 schema 保证），按文件版本缓存。 */
  private readAsset(name: string): { text: string; version: string } {
    const dir = this.rt.web.assetsDir
    if (dir === undefined) throw new Error('编辑器资源目录未设置。')
    const file = path.join(dir, name)
    const stat = statSync(file)
    const version = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`
    const cached = this.assetCache.get(name)
    if (cached !== undefined && cached.version === version) return cached
    const fresh = { text: readFileSync(file, 'utf8'), version }
    this.assetCache.set(name, fresh)
    return fresh
  }

  /** 单个内联资源的上限：远程调用是整包 JSON（base64 再膨胀 1/3），太大的图片 / 字体直接放弃内联。 */
  sftpReadData(input: In<'sftpReadData'>): Out<'sftpReadData'> {
    return this.guard(() => this.fs(input.hostId).readData(input.hostId, input.path, 8 * 1024 * 1024))
  }

  sftpWrite(input: In<'sftpWrite'>): Out<'sftpWrite'> {
    return this.guard(() =>
      this.fs(input.hostId).writeText(input.hostId, input.path, input.content, input.expectedMtime)
    )
  }

  sftpMkdir(input: In<'sftpMkdir'>): Out<'sftpMkdir'> {
    return this.guard(async () => ({
      path: await this.fs(input.hostId).mkdir(input.hostId, input.parent, input.name)
    }))
  }

  sftpCreateFile(input: In<'sftpCreateFile'>): Out<'sftpCreateFile'> {
    return this.guard(async () => ({
      path: await this.fs(input.hostId).createFile(input.hostId, input.parent, input.name)
    }))
  }

  sftpRename(input: In<'sftpRename'>): Out<'sftpRename'> {
    return this.guard(async () => ({
      path: await this.fs(input.hostId).rename(input.hostId, input.path, input.name)
    }))
  }

  /** 删除（目录递归）。安全边界在 RemoteFs.remove 里强制，浏览器端的确认只是第一道。 */
  sftpRemove(input: In<'sftpRemove'>): Out<'sftpRemove'> {
    return this.guard(() => this.fs(input.hostId).remove(input.hostId, input.path))
  }

  sftpCopy(input: In<'sftpCopy'>): Out<'sftpCopy'> {
    return this.guard(async () => ({
      path: await this.fs(input.hostId).copy(input.hostId, input.source, input.targetDir)
    }))
  }

  sftpSearch(input: In<'sftpSearch'>): Out<'sftpSearch'> {
    return this.guard(() => this.fs(input.hostId).search(input.hostId, input.root, input.query))
  }

  getPrefs(_: In<'getPrefs'>): Out<'getPrefs'> {
    return this.guard(() => this.prefsOutput())
  }

  setIgnore(input: In<'setIgnore'>): Out<'setIgnore'> {
    return this.guard(() => {
      const prefs = this.rt.prefs.setIgnore(input.rules)
      this.rt.log.info('', 'config', `已更新自定义忽略规则（${prefs.ignore.length} 条）。`)
      return this.prefsOutput(prefs)
    })
  }

  setTakeover(input: In<'setTakeover'>): Out<'setTakeover'> {
    return this.guard(() => {
      const prefs = this.rt.prefs.setTakeover(input.enabled)
      this.rt.log.info('', 'config', `已${input.enabled ? '开启' : '关闭'}「接管添加工作区」，刷新页面后生效。`)
      return this.prefsOutput(prefs)
    })
  }

  setFilesTakeover(input: In<'setFilesTakeover'>): Out<'setFilesTakeover'> {
    return this.guard(() => {
      const prefs = this.rt.prefs.setFilesTakeover(input.enabled)
      this.rt.log.info('', 'config', `已${input.enabled ? '开启' : '关闭'}「接管 DSH 文件侧栏」。`)
      return this.prefsOutput(prefs)
    })
  }

  private prefsOutput(prefs = this.rt.prefs.get()): MethodIO['getPrefs'][1] {
    return {
      ignore: prefs.ignore,
      defaultIgnore: [...DEFAULT_IGNORE],
      takeoverAddWorkspace: prefs.takeoverAddWorkspace,
      takeoverFilesSidebar: prefs.takeoverFilesSidebar
    }
  }

  /**
   * Git 仓库面板。只允许在工作区根目录里执行，浏览器不能拿任意目录让宿主跑 git：
   * - 远程：根目录必须是该主机已登记的远程工作区
   * - 本地（hostId = local:<sessionId>）：根目录由宿主按会话 cwd 推导，忽略浏览器传的 root
   * 改动类操作（暂存 / 丢弃 / 提交 / 切换分支）写连接日志，事后可查。
   */
  git(input: In<'git'>): Out<'git'> {
    return this.guard(async () => {
      if (isLocalId(input.hostId)) return await this.localGit(input)
      const hostId = this.requireHost(input.hostId)
      const root = normalizeRemotePath(input.root)
      if (!this.rt.bindings.list().some((b) => b.hostId === hostId && b.remotePath === root)) {
        throw new Error(`不是已登记的远程工作区：${root}`)
      }
      const rootGit = new RemoteGit(this.rt, hostId, root)
      // 在「另一个 git 工作目录」里执行（分支检出在那里）：只允许本仓库自己的工作目录，由 git 列出为准。
      let git: GitRepo = rootGit
      let where = root
      if (input.worktree !== undefined && normalizeRemotePath(input.worktree) !== root) {
        where = normalizeRemotePath(input.worktree)
        if (!(await rootGit.isOwnWorktree(where))) throw new Error(`不是该仓库的工作目录：${where}`)
        git = new RemoteGit(this.rt, hostId, where)
      }
      return await this.gitOp(git, input, hostId, where)
    })
  }

  /** 本地工作区的 git：路径在线上是本地 POSIX 形式（/C:/x），这里与原生路径互转。 */
  private async localGit(input: In<'git'>): Promise<unknown> {
    const scope = await this.rt.localScope(input.hostId)
    const rootGit = new LocalGit(scope.root)
    let git: GitRepo = rootGit
    let where = scope.root
    if (input.worktree !== undefined) {
      const wt = fromLocalPosix(input.worktree)
      const same = process.platform === 'win32' ? wt.toLowerCase() === scope.root.toLowerCase() : wt === scope.root
      if (!same) {
        if (!(await rootGit.isOwnWorktree(wt))) throw new Error(`不是该仓库的工作目录：${input.worktree}`)
        git = new LocalGit(wt)
        where = wt
      }
    }
    const result = await this.gitOp(git, input, '', where)
    // 分支检出所在目录：换回线上的本地 POSIX 形式，前端据此列目录 / 打开文件。
    if (input.op === 'branchInfo') {
      const info = result as { worktreePath?: string }
      if (info.worktreePath !== undefined) return { ...info, worktreePath: toLocalPosix(info.worktreePath) }
    }
    return result
  }

  private async gitOp(git: GitRepo, input: In<'git'>, hostId: string, where: string): Promise<unknown> {
    const note = (what: string): void => this.rt.log.info(hostId, 'git', `${where}：${what}`)
    try {
      switch (input.op) {
        case 'status':
          return await git.status()
        case 'log':
          return { commits: await git.log(input.skip, input.limit, input.ref) }
        case 'tree':
          return await git.tree(input.ref, input.dir)
        case 'file':
          return await git.file(input.ref, input.path)
        case 'compare':
          return await git.compare(input.base, input.target)
        case 'branches':
          return { branches: await git.branches() }
        case 'show':
          return { files: await git.show(input.hash, input.parent) }
        case 'diff':
          return await git.diff(input.target)
        case 'stage':
          await git.stage(input.paths)
          note(`暂存 ${input.paths.length} 个文件`)
          return { ok: true }
        case 'unstage':
          await git.unstage(input.paths)
          note(`取消暂存 ${input.paths.length} 个文件`)
          return { ok: true }
        case 'discard':
          await git.discard(input.tracked, input.untracked)
          this.rt.log.warn(hostId, 'git', `${where}：丢弃改动 ${input.tracked.length + input.untracked.length} 个文件（${[...input.tracked, ...input.untracked].slice(0, 5).join(', ')}）`)
          return { ok: true }
        case 'commit': {
          const hash = await git.commit(input.message)
          note(`提交 ${hash}：${input.message.split('\n')[0]}`)
          return { hash }
        }
        // ---- 编辑非检出分支（临时索引，不碰工作目录）
        case 'branchInfo':
          return await git.branchInfo(input.ref)
        case 'branchChanges':
          return await git.branchChanges(input.ref)
        case 'branchSave':
          await git.branchSave(input.ref, input.path, input.content)
          return { ok: true }
        case 'branchRevert':
          await git.branchRevert(input.ref, input.paths)
          note(`${input.ref}：撤销 ${input.paths.length} 个文件的未提交改动`)
          return { ok: true }
        case 'branchDiscard':
          await git.branchDiscard(input.ref)
          this.rt.log.warn(hostId, 'git', `${where}：丢弃分支 ${input.ref} 的全部未提交改动`)
          return { ok: true }
        case 'branchCommit': {
          const hash = await git.branchCommit(input.ref, input.message)
          note(`在分支 ${input.ref} 上提交 ${hash}（未检出）：${input.message.split('\n')[0]}`)
          return { hash }
        }
        case 'createBranch': {
          const ref = await git.createBranch(input.name, input.from)
          note(`基于 ${input.from} 新建本地分支 ${ref}（未检出）`)
          return { ref }
        }
      }
    } catch (error) {
      if (error instanceof GitError) throw new RemoteError(ERROR_CODES.failed, error.message, {})
      throw error
    }
  }
  // ---------------------------------------------------------------- 本机目录（添加工作区兜底）

  /** 宿主目录选择器只有 native 能力时（macOS 桌面版），「添加工作区」的应用内浏览走这里。 */
  localList(input: In<'localList'>): Out<'localList'> {
    return this.guard(() => listLocalDirectory(input.path).catch((error: unknown) => Promise.reject(localRemote(error))))
  }

  localMkdir(input: In<'localMkdir'>): Out<'localMkdir'> {
    return this.guard(async () => {
      try {
        return { path: await makeLocalDirectory(input.parent, input.name) }
      } catch (error) {
        throw localRemote(error)
      }
    })
  }

  /**
   * 交付卡片里的文件 → 远程路径（不是远程工作区文件返回 null，浏览器交还宿主处理）。
   * 读事件与宿主 /api/present.open 同一个入口（sessionQuery.readEvent），校验规则同宿主 isPresentedData / isPresentedFile；
   * 路径换算与远程 present（agent/present-tool.ts）一致：toRemotePath 抛错 = 本机文件。
   */
  presentedFile(input: In<'presentedFile'>): Out<'presentedFile'> {
    return this.guard(async () => {
      const query = this.ctx.get('sessionQuery') as
        | { readEvent(q: { sessionId: string; seq: number; before: number; after: number }, signal: AbortSignal): Promise<unknown> }
        | undefined
      if (query === undefined) return { remote: null }
      const read = (await query.readEvent({ sessionId: input.sessionId, seq: input.seq, before: 0, after: 0 }, AbortSignal.timeout(10_000))) as
        | { target?: { type?: unknown; data?: unknown }; session?: { cwd?: unknown } }
        | undefined
      const data = read?.target?.type === 'deliverables/presented' ? (read.target.data as { turn?: unknown; callId?: unknown; files?: unknown }) : undefined
      // 与宿主 isPresentedData 同样的校验。
      const validTurn = typeof data?.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 1
      if (data === undefined || !validTurn || typeof data.callId !== 'string' || data.callId === '' || !Array.isArray(data.files)) return { remote: null }
      const file = data.files[input.index] as ({ path?: unknown } & Record<string, unknown>) | undefined
      if (typeof file?.path !== 'string' || file.path.trim() === '') return { remote: null }
      const binding = this.rt.bindings.resolve(typeof read?.session?.cwd === 'string' ? read.session.cwd : undefined)
      if (binding === undefined) return { remote: null }
      let remotePath: string
      try {
        remotePath = toRemotePath(binding, file.path)
      } catch {
        return { remote: null }
      }
      // 远程 present 写入的事件带远程标记：以它为准（与分类时的结论一致，含工作区根以外的远程路径）。
      if (file[REMOTE_MARKER] === binding.hostId) return { remote: { hostId: binding.hostId, remotePath } }
      // 没有标记（宿主原实现写的、或旧版本写的）：只有落在远程工作区根内才当远程文件 ——
      // macOS / Linux 宿主上交还宿主的本机文件（/Users/me/a.png）也以 / 开头，不能据此误判。
      if (insideRoot(binding.remotePath, remotePath)) return { remote: { hostId: binding.hostId, remotePath } }
      return { remote: null }
    })
  }

  remoteWorkspaces(_: In<'remoteWorkspaces'>): Out<'remoteWorkspaces'> {
    return this.guard(() => ({
      workspaces: this.rt.bindings.list().map((b) => ({ localPath: b.localPath, hostId: b.hostId, remotePath: b.remotePath, title: b.title }))
    }))
  }

  /**
   * 预览地址。令牌只绑定「该文件所在的远程工作区根目录」：不属于任何远程工作区的路径拒绝签发，
   * 这样预览页（以及它引用的相对资源）最多只能读到这个工作区里的文件。
   */
  previewUrl(input: In<'previewUrl'>): Out<'previewUrl'> {
    return this.guard(async () => {
      const target = normalizeRemotePath(input.path)
      if (isLocalId(input.hostId)) {
        // 本地：令牌绑定会话工作区根目录（或同仓库的其他 git 工作目录），路径用线上的本地 POSIX 形式。
        const native = await this.rt.localFiles.resolve(input.hostId, target)
        const scope = await this.rt.localScope(input.hostId)
        const roots = [scope.root, ...(await scope.extraRoots())]
        const root = roots.find((r) => insideRoot(toLocalPosix(r), toLocalPosix(native)))
        if (root === undefined) throw new Error(`该文件不在当前工作区内：${target}`)
        return { url: previewUrl(this.rt.previews.grant(input.hostId, toLocalPosix(root)), target) }
      }
      const hostId = this.requireHost(input.hostId)
      const bound = this.rt.bindings.list().filter((b) => b.hostId === hostId)
      let root = bound
        .filter((b) => insideRoot(b.remotePath, target))
        .sort((a, b) => b.remotePath.length - a.remotePath.length)[0]?.remotePath
      // 也允许远程工作区仓库自己的其他 git 工作目录（分支检出在那里时，远程 Git 面板在那里预览）；
      // 由 git 列出为准，令牌只绑定那个工作目录。
      if (root === undefined) {
        for (const b of bound) {
          const hit = (await new RemoteGit(this.rt, hostId, b.remotePath).worktreeRoots().catch(() => [])).find((w) => insideRoot(w, target))
          if (hit !== undefined) {
            root = hit
            break
          }
        }
      }
      if (root === undefined) throw new Error(`该文件不在任何远程工作区内：${target}`)
      return { url: previewUrl(this.rt.previews.grant(hostId, root), target) }
    })
  }

  /**
   * 远程工作区：先确认远程目录真实存在（连不上 / 路径错在这里就报，而不是建出一个坏工作区），
   * 再建本地占位目录并登记。DSH 工作区本身由浏览器端用返回的 localPath 创建（与官方流程一致）。
   */
  createRemoteWorkspace(input: In<'createRemoteWorkspace'>): Out<'createRemoteWorkspace'> {
    return this.guard(async () => {
      const hostId = this.requireHost(input.hostId)
      const host = this.rt.vault.getHost(hostId) as HostRecord
      const remotePath = normalizeRemotePath(input.remotePath)
      const info = await this.rt.files.statPath(hostId, remotePath)
      if (info === undefined) throw new Error(`远程目录不存在：${remotePath}`)
      if (info.type !== 'dir') throw new Error(`不是目录：${remotePath}`)
      const binding = this.rt.bindings.create({
        hostId,
        endpoint: [host.hostname, host.username, String(host.port)].filter(Boolean).join('-'),
        remotePath,
        title: input.title.trim()
      })
      this.rt.log.info(hostId, 'workspace', `已创建远程工作区「${binding.title}」→ ${remotePath}（本地占位 ${binding.localPath}）`)
      return { localPath: binding.localPath, title: binding.title }
    })
  }

  /**
   * 文件操作的实现：local:<sessionId> 走本地工作区（根目录由宿主按会话推导），其余为保险箱里的远程主机。
   * 两者接口一致，侧栏前端无需区分。
   */
  private fs(hostId: string): FileOps {
    if (isLocalId(hostId)) return this.rt.localFiles
    this.requireHost(hostId)
    return this.rt.files
  }

  /** 主机必须存在于保险箱里：浏览器不能拿任意 id 让宿主去连。 */
  private requireHost(hostId: string): string {
    if (this.rt.vault.getHost(hostId) === undefined) throw new Error(`主机不存在：${hostId}`)
    if (!isSsh2Available()) {
      throw new RemoteError(ERROR_CODES.ssh2Unavailable, 'ssh2 不可用，请查看连接日志中的修复指引。', {})
    }
    return hostId
  }

  // ---------------------------------------------------------------- 自更新

  updateStatus(_: In<'updateStatus'>): Out<'updateStatus'> {
    return this.guard(() => this.rt.updater.status())
  }

  updateCheck(input: In<'updateCheck'>): Out<'updateCheck'> {
    return this.guard(() => this.rt.updater.check(input.force === true))
  }

  /** 安装在后台进行（pnpm 可能要一两分钟），立即返回；界面轮询 updateStatus 看进度。 */
  updateInstall(input: In<'updateInstall'>): Out<'updateInstall'> {
    return this.guard(() => (input.source === 'latest' ? this.rt.updater.startLatest() : this.rt.updater.startUpload(input.token)))
  }

  // ---------------------------------------------------------------- 备份

  exportVault(_: In<'exportVault'>): Out<'exportVault'> {
    return this.guard(() => {
      const data = this.rt.vault.exportPlain()
      this.rt.log.warn('', 'vault', `已导出明文备份（${data.hosts.length} 台主机）。请妥善保管该文件。`)
      return data
    })
  }

  importVault(input: In<'importVault'>): Out<'importVault'> {
    return this.guard(() => {
      const result = this.rt.vault.importPlain(input)
      this.rt.log.info('', 'vault', `已导入 ${result.hosts} 台主机、${result.groups} 个分组。`)
      return result
    })
  }
}

// ------------------------------------------------------------------ 辅助

/**
 * 编辑是否改变了「怎么连」。
 * 分组路径算在内：换分组可能换掉继承来的用户名、凭据、跳板与代理。
 */
function connectionChanged(before: HostRecord, input: SaveHostInput): boolean {
  if (input.auth !== undefined || input.proxy !== undefined) return true
  const nextUser = nonEmpty(input.username) ? input.username.trim() : undefined
  return (
    before.hostname !== input.hostname.trim() ||
    before.port !== input.port ||
    before.username !== nextUser ||
    before.groupPath !== normalizeGroupPath(input.groupPath) ||
    before.jumpHostIds.join('\n') !== input.jumpHostIds.join('\n')
  )
}

/** 同一主机开多个终端时自动编号：srv、srv (2)、srv (3)… */
function defaultTitle(label: string, open: TerminalView[], hostId: string): string {
  const count = open.filter((t) => t.hostId === hostId).length
  return count === 0 ? label : `${label} (${count + 1})`
}

function viewOf(rt: WorkspaceRuntime, id: string): MethodIO['saveHost'][1] {
  const view = rt.vault.listHostViews().find((h) => h.id === id)
  if (view === undefined) throw new Error(`主机保存后未找到：${id}`)
  return view
}

/** 取主机的非凭据字段，空串统一视为「未设置」。 */
function plainHostFields(input: SaveHostInput): Omit<HostRecord, 'id' | 'createdAt' | 'updatedAt' | 'auth' | 'proxy'> {
  return {
    label: input.label.trim(),
    hostname: input.hostname.trim(),
    port: input.port,
    groupPath: normalizeGroupPath(input.groupPath),
    jumpHostIds: input.jumpHostIds,
    ...(nonEmpty(input.username) ? { username: input.username.trim() } : {}),
    ...(nonEmpty(input.startupCommand) ? { startupCommand: input.startupCommand } : {}),
    ...(input.environmentVariables !== undefined && Object.keys(input.environmentVariables).length > 0
      ? { environmentVariables: input.environmentVariables }
      : {}),
    ...(nonEmpty(input.notes) ? { notes: input.notes } : {})
  }
}

function plainGroupDefaults(input: SaveGroupInput): {
  username?: string
  port?: number
  jumpHostIds?: string[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
  auth?: HostAuth | null
  proxy?: HostProxy | null
} {
  return {
    ...(nonEmpty(input.username) ? { username: input.username.trim() } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.jumpHostIds !== undefined && input.jumpHostIds.length > 0
      ? { jumpHostIds: input.jumpHostIds }
      : {}),
    ...(nonEmpty(input.startupCommand) ? { startupCommand: input.startupCommand } : {}),
    ...(input.environmentVariables !== undefined && Object.keys(input.environmentVariables).length > 0
      ? { environmentVariables: input.environmentVariables }
      : {})
  }
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/**
 * 由表单输入构造认证信息。
 *
 * 凭据留空 = 沿用旧值：浏览器拿不到原文，编辑表单无法回填，
 * 所以只能约定「不填就是不改」。旧值通过 previous() 惰性获取 ——
 * 只有确实需要沿用时才解密，从而只在必要时要求解锁。
 */
function buildAuth(input: AuthInput, previous: (() => HostAuth | undefined) | undefined): HostAuth {
  switch (input.kind) {
    case 'password': {
      if (nonEmpty(input.password)) return { kind: 'password', password: input.password }
      const old = previous?.()
      if (old?.kind === 'password' && old.password !== '') return old
      throw new Error('请填写密码。')
    }
    case 'keyPath': {
      const passphrase = resolvePassphrase(input, previous, 'keyPath')
      return {
        kind: 'keyPath',
        keyPath: input.keyPath.trim(),
        ...(passphrase !== undefined ? { passphrase } : {})
      }
    }
    case 'keyContent': {
      let keyContent = input.keyContent
      if (!nonEmpty(keyContent)) {
        const old = previous?.()
        if (old?.kind === 'keyContent' && old.keyContent !== '') keyContent = old.keyContent
        else throw new Error('请粘贴私钥内容。')
      }
      const passphrase = resolvePassphrase(input, previous, 'keyContent')
      return { kind: 'keyContent', keyContent, ...(passphrase !== undefined ? { passphrase } : {}) }
    }
    case 'agent':
      return { kind: 'agent' }
  }
}

function resolvePassphrase(
  input: { passphrase?: string; clearPassphrase?: boolean },
  previous: (() => HostAuth | undefined) | undefined,
  kind: 'keyPath' | 'keyContent'
): string | undefined {
  if (input.clearPassphrase === true) return undefined
  if (nonEmpty(input.passphrase)) return input.passphrase
  const old = previous?.()
  if (old?.kind === kind && old.passphrase !== undefined) return old.passphrase
  return undefined
}

function buildProxy(input: ProxyInput, previous: (() => HostProxy | undefined) | undefined): HostProxy {
  const base: HostProxy = {
    kind: input.kind,
    host: input.host.trim(),
    port: input.port,
    ...(nonEmpty(input.username) ? { username: input.username.trim() } : {})
  }
  if (input.clearPassword === true) return base
  if (nonEmpty(input.password)) return { ...base, password: input.password }
  // 没有用户名就不可能有代理密码，不必为此去解密旧值。
  if (base.username === undefined) return base
  const old = previous?.()
  return old?.password !== undefined ? { ...base, password: old.password } : base
}

/** 执行一条短命令并返回去掉首尾空白的 stdout。 */
function execOnce(connection: SshConnection, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    connection.raw().exec(command, {}, (err, stream) => {
      if (err !== null && err !== undefined) {
        reject(err)
        return
      }
      const s = stream as NodeJS.ReadableStream & { on(event: 'close', l: () => void): void }
      let out = ''
      s.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      s.on('close', () => {
        resolve(out.trim())
      })
    })
  })
}
