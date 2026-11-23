/*
 * @Description: SFTP 视角 ↔ SSH exec 视角的路径映射（issue #17：群晖 DSM 等 SFTP 根 ≠ exec 根的主机）
 * @Author: YangHeng
 * @Date: 2026-11-23 16:05:00
 * @FilePath: /dsh-workspace/src/ssh/path-view.ts
 *
 * 为什么需要：有的主机把 SFTP 子系统限制在某个子目录里（DSM 把 /volume1 当作 SFTP 的 /），
 * 而 exec 通道看到的是真实根。文件浏览走 SFTP，Agent 的 bash / glob / grep、git、终端走 exec，
 * 同一个目录在两边的写法不同：SFTP 的 /AI-agent/Home-NAS = exec 的 /volume1/AI-agent/Home-NAS。
 *
 * 映射模型只有一个「exec 前缀」：exec 路径 = 前缀 + SFTP 路径。前缀为 '' 表示两边一致（绝大多数主机）。
 * 前缀的推算：比较 SFTP realpath('.') 与 exec `cd ~ && pwd -P`，exec 结果以 SFTP 结果结尾时多出的部分即前缀；
 * 再用根目录列表核对一次，防止「家目录本身是符号链接」之类的巧合把正常主机误判成有前缀。
 * 判定不了时一律回退为 ''：与旧版行为完全一致，宁可不修也不把路径改错。
 */
import path from 'node:path'
import type { WorkspaceRuntime } from '../runtime.js'
import { execCapture } from '../sftp/exec.js'

const posix = path.posix

/** POSIX shell 单引号转义（不 import terminal/ssh-shell：那边反过来依赖本文件，避免循环引用）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ------------------------------------------------------------------ 纯函数

/** 规范化 POSIX 绝对路径（折叠 . / ..，去掉结尾斜杠）；不是绝对路径返回 undefined。 */
function clean(p: string): string | undefined {
  const s = p.trim()
  if (!s.startsWith('/')) return undefined
  const n = posix.normalize(s)
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

/**
 * 由两个视角下的家目录推算 exec 前缀。
 * @returns 前缀（'' = 两视角一致）；无法判定（两者毫无后缀关系）时 undefined
 * @example derivePrefix('/homes/ps', '/volume1/homes/ps') === '/volume1'
 */
export function derivePrefix(sftpHome: string, execHome: string): string | undefined {
  const s = clean(sftpHome)
  const e = clean(execHome)
  if (s === undefined || e === undefined) return undefined
  if (s === e) return ''
  // SFTP 被限制在家目录里（chroot 到 ~）：SFTP 的 / 就是 exec 的家目录。
  if (s === '/') return e
  if (!e.endsWith(s)) return undefined
  const prefix = e.slice(0, e.length - s.length)
  // 必须在路径段边界上切开：/data/xhomes/ps 与 /homes/ps 不算。
  return prefix.startsWith('/') && !prefix.endsWith('/') ? prefix : undefined
}

/** SFTP 视角 → exec 视角。 */
export function toExecPath(prefix: string, sftpPath: string): string {
  if (prefix === '') return sftpPath
  return sftpPath === '/' ? prefix : `${prefix}${sftpPath}`
}

/** exec 视角 → SFTP 视角；不在前缀之内（SFTP 看不到）时返回 undefined。 */
export function toSftpPath(prefix: string, execPath: string): string | undefined {
  if (prefix === '') return execPath
  if (execPath === prefix) return '/'
  return execPath.startsWith(`${prefix}/`) ? execPath.slice(prefix.length) : undefined
}

/**
 * 不确定视角的路径（用户手动输入、终端 cwd）→ exec 视角：已在前缀之内的视为 exec 视角原样返回，否则按 SFTP 视角加前缀。
 * DSM 的 SFTP 视角里不会再出现 /volume1 这一级，所以这个判定不会把真正的 SFTP 路径误认。
 */
export function execFromEither(prefix: string, p: string): string {
  if (prefix !== '' && toSftpPath(prefix, p) !== undefined) return p
  return toExecPath(prefix, p)
}

/** 不确定视角的路径 → SFTP 视角（与 execFromEither 对称）。 */
export function sftpFromEither(prefix: string, p: string): string {
  return toSftpPath(prefix, p) ?? p
}

/**
 * 核对前缀：SFTP 根目录下的每个名字都应出现在 exec 的前缀目录里。
 * DSM 的 SFTP 根只列出有权限的共享文件夹（/volume1 里还有 @appstore 等），所以按子集判断。
 */
export function rootListingConsistent(sftpRootNames: readonly string[], execPrefixNames: readonly string[]): boolean {
  const exec = new Set(execPrefixNames)
  return sftpRootNames.every((n) => exec.has(n))
}

/** 某台主机的路径视角映射。 */
export interface PathView {
  /** exec 前缀（'' = 两视角一致）。 */
  readonly prefix: string
  toExec(sftpPath: string): string
  toSftp(execPath: string): string | undefined
}

export function makePathView(prefix: string): PathView {
  return {
    prefix,
    toExec: (p) => toExecPath(prefix, p),
    toSftp: (p) => toSftpPath(prefix, p)
  }
}

export const IDENTITY_VIEW: PathView = makePathView('')

/**
 * 只凭绑定登记的两视角根推算映射（不连主机）：登记了 execPath 时前缀 = execPath 去掉 remotePath 后缀。
 * 用在不值得为此发起连接的地方（交付卡片换算路径），没登记时按两视角一致处理。
 */
export function bindingPathView(binding: { remotePath: string; execPath?: string }): PathView {
  if (binding.execPath === undefined) return IDENTITY_VIEW
  return makePathView(derivePrefix(binding.remotePath, binding.execPath) ?? '')
}

/** 远程工作区的两视角根目录。 */
export interface WorkspaceRoots {
  /** SFTP 视角（绑定的 remotePath，决定占位目录名）。 */
  sftpPath: string
  /** exec 视角（Agent、git、终端使用）。 */
  execPath: string
}

/**
 * 添加工作区时确定两视角根目录：输入可以是任一视角，先 SFTP 校验存在且是目录，再在 exec 里探测。
 * exec 候选依次为「前缀 + 路径」与原路径；都进不去时报错并说明尝试过的路径 —— 这正是 issue #17 的现场，
 * 与其建出一个 Agent 一用就报 workdir not found 的工作区，不如在添加时就说清楚。
 * @param probeExecDir exec 里 cd 成功返回真实路径，失败返回 undefined（连接错误照常抛出）
 */
export async function resolveWorkspaceRoots(
  input: string,
  deps: {
    view: PathView
    statSftp(p: string): Promise<{ type: string } | undefined>
    probeExecDir(p: string): Promise<string | undefined>
  }
): Promise<WorkspaceRoots> {
  const sftpPath = sftpFromEither(deps.view.prefix, input)
  const info = await deps.statSftp(sftpPath)
  if (info === undefined) throw new Error(`远程目录不存在：${sftpPath}`)
  if (info.type !== 'dir') throw new Error(`不是目录：${sftpPath}`)
  const candidates = [...new Set([deps.view.toExec(sftpPath), sftpPath])]
  for (const candidate of candidates) {
    if ((await deps.probeExecDir(candidate)) !== undefined) return { sftpPath, execPath: candidate }
  }
  throw new Error(
    `SFTP 中存在目录 ${sftpPath}，但 SSH 命令通道里找不到它（已尝试：${candidates.join('、')}）。` +
      '该主机的 SFTP 可能被限制在某个子目录中（chroot，如群晖 DSM 把 /volume1 映射为 SFTP 的 /）。请确认 SSH 登录后该目录的真实路径。'
  )
}

/**
 * 会话接管时确定工作区的 exec 根（顺带完成自检）：已登记 execPath 的只验证；
 * 旧绑定（没有 execPath）按映射推算候选并探测，成功则交给 persist 补写，之后不再推算。
 * @returns ok=false 表示 exec 里进不去该目录（工具照常注册，报错时由调用方给出提示）
 */
export async function ensureExecRoot(
  binding: { remotePath: string; execPath?: string },
  deps: { view: PathView; probeExecDir(p: string): Promise<string | undefined>; persist(execPath: string): void }
): Promise<{ execPath: string; ok: boolean }> {
  const candidates = binding.execPath !== undefined ? [binding.execPath] : [...new Set([deps.view.toExec(binding.remotePath), binding.remotePath])]
  for (const candidate of candidates) {
    if ((await deps.probeExecDir(candidate)) === undefined) continue
    // 与现有登记一致（含「未登记 = 与 remotePath 相同」）时不写盘。
    if ((binding.execPath ?? binding.remotePath) !== candidate) deps.persist(candidate)
    return { execPath: candidate, ok: true }
  }
  return { execPath: candidates[0] as string, ok: false }
}

// ------------------------------------------------------------------ 按主机缓存的服务

export interface PathViewDeps {
  /** 当前底层连接（缓存身份：连接换了 = 可能重连到了别的机器，重新推算）。 */
  connection(hostId: string): Promise<object>
  sftpHome(hostId: string): Promise<string>
  sftpRootNames(hostId: string): Promise<string[]>
  exec(hostId: string, command: string): Promise<{ stdout: string; code: number | null }>
  log?: { info(hostId: string, message: string): void; warn(hostId: string, message: string): void }
}

/** 按主机检测并缓存路径视角映射；连接断开重连后失效重算。 */
export class PathViews {
  private cache = new Map<string, { connection: object; view: Promise<PathView> }>()

  constructor(private readonly deps: PathViewDeps) {}

  /** 该主机的映射。检测失败（命令不可用、输出异常）回退为恒等映射，不抛错；连接本身失败照常抛出。 */
  async view(hostId: string): Promise<PathView> {
    const connection = await this.deps.connection(hostId)
    const cached = this.cache.get(hostId)
    if (cached !== undefined && cached.connection === connection) return await cached.view
    const view = this.detect(hostId)
    this.cache.set(hostId, { connection, view })
    try {
      return await view
    } catch (error) {
      if (this.cache.get(hostId)?.view === view) this.cache.delete(hostId)
      throw error
    }
  }

  /** 工作区绑定的 exec 根：已登记的直接用；旧绑定按映射推算（不探测、不补写，补写由会话接管时完成）。 */
  async execRoot(binding: { hostId: string; remotePath: string; execPath?: string }): Promise<string> {
    if (binding.execPath !== undefined) return binding.execPath
    return (await this.view(binding.hostId)).toExec(binding.remotePath)
  }

  /** exec 里 cd 进该目录：成功返回 `pwd -P`，进不去返回 undefined。 */
  async probeDir(hostId: string, execPath: string): Promise<string | undefined> {
    const out = await this.deps.exec(hostId, `cd -- ${shellQuote(execPath)} 2>/dev/null && pwd -P`)
    const real = out.stdout.trim()
    return out.code === 0 && real.startsWith('/') ? real : undefined
  }

  private async detect(hostId: string): Promise<PathView> {
    const sftpHome = await this.deps.sftpHome(hostId)
    const home = await this.deps.exec(hostId, 'cd ~ 2>/dev/null && pwd -P')
    const execHome = home.stdout.trim()
    if (home.code !== 0 || !execHome.startsWith('/')) {
      this.deps.log?.warn(hostId, `无法取得 SSH 命令通道的家目录，按 SFTP 与 SSH 路径一致处理（SFTP 家目录 ${sftpHome}）。`)
      return IDENTITY_VIEW
    }
    const prefix = derivePrefix(sftpHome, execHome)
    if (prefix === undefined) {
      this.deps.log?.warn(hostId, `SFTP 家目录 ${sftpHome} 与 SSH 家目录 ${execHome} 对不上，按路径一致处理。`)
      return IDENTITY_VIEW
    }
    if (prefix === '') return IDENTITY_VIEW
    // 核对：家目录是符号链接等巧合也会产生「后缀关系」，用根目录列表再确认一次。列不出来时信任推算结果。
    try {
      const names = await this.deps.exec(hostId, `ls -A1 -- ${shellQuote(prefix)} 2>/dev/null`)
      if (names.code === 0 && !rootListingConsistent(await this.deps.sftpRootNames(hostId), names.stdout.split('\n').filter(Boolean))) {
        this.deps.log?.warn(hostId, `推算出 SFTP 根对应 SSH ${prefix}，但两边的根目录内容不一致，按路径一致处理。`)
        return IDENTITY_VIEW
      }
    } catch {
      /* 核对失败不影响推算结果 */
    }
    this.deps.log?.info(hostId, `检测到 SFTP 根与 SSH 根不同：SFTP / 对应 SSH ${prefix}（如群晖 DSM），路径将自动换算。`)
    return makePathView(prefix)
  }
}

/** 运行时装配：SFTP 与 exec 都走「file」连接池（与侧栏文件操作同一条连接）。 */
export function createPathViews(rt: WorkspaceRuntime): PathViews {
  const connection = (hostId: string) => rt.pool.acquire(hostId, 'file', () => rt.resolveHost(hostId))
  return new PathViews({
    connection,
    sftpHome: (hostId) => rt.files.home(hostId),
    sftpRootNames: async (hostId) => (await rt.files.list(hostId, '/')).entries.map((e) => e.name),
    exec: async (hostId, command) => await execCapture(await connection(hostId), command, { timeoutMs: 15_000, maxBytes: 1024 * 1024 }),
    log: { info: (h, m) => rt.log.info(h, 'sftp', m), warn: (h, m) => rt.log.warn(h, 'sftp', m) }
  })
}
