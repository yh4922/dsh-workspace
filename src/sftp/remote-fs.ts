/*
 * @Description: 远端文件操作 —— SFTP 会话复用、列目录、预览、增删改名、上传下载流、文件名搜索
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/remote-fs.ts
 *
 * 只支持 Linux / 类 Unix 远端（需求文档已确定）：路径一律按 POSIX 处理。
 */
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WorkspaceRuntime } from '../runtime.js'
import type { SshConnection } from '../ssh/connection.js'
import { shellQuote } from '../terminal/ssh-shell.js'
import { execCapture } from './exec.js'
import { buildMatcher, type IgnoreMatcher } from './ignore.js'

const posix = path.posix

// ------------------------------------------------------------------ 类型

export type EntryType = 'dir' | 'file' | 'symlink' | 'other'

export interface RemoteEntry {
  name: string
  path: string
  type: EntryType
  size: number
  /** 修改时间（毫秒时间戳）。 */
  mtime: number
  /** 权限位，如 0o755。 */
  mode: number
  /** 符号链接的目标（原样，可能是相对路径）。 */
  linkTarget?: string
  /** 符号链接是否指向目录（可展开）。悬空链接为 false。 */
  linkIsDir?: boolean
  /** 命中忽略规则（仅用于淡化显示）。 */
  ignored: boolean
  hidden: boolean
}

export interface ListResult {
  path: string
  entries: RemoteEntry[]
  /** 条目超过上限，只返回了前一部分。 */
  truncated: boolean
}

export interface ReadResult {
  path: string
  size: number
  /** 修改时间（毫秒）。保存时回传，用于检测「打开后被别人改过」。 */
  mtime: number
  content: string
  truncated: boolean
  binary: boolean
  /**
   * 内容不是合法 UTF-8（如 GBK 编码的配置文件）。按 UTF-8 解码已丢失信息，
   * 若允许编辑保存会把文件写坏，所以前端据此只读展示。
   */
  lossy: boolean
}

/** 保存冲突：远端文件在打开之后被修改过。 */
export class RemoteConflictError extends Error {
  constructor(
    readonly remotePath: string,
    readonly mtime: number,
    readonly size: number
  ) {
    super(`文件在打开之后已被修改：${remotePath}`)
    this.name = 'RemoteConflictError'
  }
}

export interface SearchResult {
  root: string
  matches: Array<{ path: string; type: 'dir' | 'file' }>
  truncated: boolean
  timedOut: boolean
}

export interface RemoveResult {
  files: number
  dirs: number
}

/** 上传冲突：目标已存在且未要求覆盖。 */
export class RemoteExistsError extends Error {
  readonly code = 'exists'
  constructor(readonly remotePath: string) {
    super(`目标已存在：${remotePath}`)
    this.name = 'RemoteExistsError'
  }
}

// ------------------------------------------------------------------ ssh2 SFTP 最小结构

interface SftpAttrs {
  mode: number
  size: number
  mtime: number
}

interface SftpDirEntry {
  filename: string
  attrs: SftpAttrs
}

type Cb<T = void> = (err: (Error & { code?: number }) | null | undefined, value: T) => void

export interface SftpLike {
  readdir(p: string, cb: Cb<SftpDirEntry[]>): void
  stat(p: string, cb: Cb<SftpAttrs>): void
  lstat(p: string, cb: Cb<SftpAttrs>): void
  readlink(p: string, cb: Cb<string>): void
  realpath(p: string, cb: Cb<string>): void
  mkdir(p: string, cb: Cb): void
  rmdir(p: string, cb: Cb): void
  unlink(p: string, cb: Cb): void
  rename(from: string, to: string, cb: Cb): void
  /** OpenSSH 扩展 posix-rename：目标存在时原子覆盖。 */
  ext_openssh_rename?(from: string, to: string, cb: Cb): void
  open(p: string, flags: string, cb: Cb<Buffer>): void
  close(handle: Buffer, cb: Cb): void
  createReadStream(p: string, options?: { start?: number; end?: number }): Readable
  createWriteStream(p: string, options?: { flags?: string; mode?: number }): Writable
  on(event: 'close' | 'end', listener: () => void): unknown
  end(): void
}

function call<T>(fn: (cb: Cb<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, value) => {
      if (err !== null && err !== undefined) reject(err)
      else resolve(value)
    })
  })
}

/** SFTP 状态码 2 = NO_SUCH_FILE。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 2
}

// ------------------------------------------------------------------ 模式位

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export function typeOfMode(mode: number): EntryType {
  const kind = mode & S_IFMT
  if (kind === S_IFDIR) return 'dir'
  if (kind === S_IFREG) return 'file'
  if (kind === S_IFLNK) return 'symlink'
  return 'other'
}

// ------------------------------------------------------------------ 路径

/**
 * 校验并规范化远端路径。只接受绝对路径；拒绝 NUL（SFTP 协议里会截断路径）。
 * normalize 会折叠 `..`，所以 `/home/a/../../etc` 得到 `/etc`，不会越出绝对路径语义。
 */
export function normalizeRemotePath(input: string): string {
  if (typeof input !== 'string' || input === '') throw new Error('路径不能为空。')
  if (input.includes('\0')) throw new Error('路径包含非法字符。')
  if (!input.startsWith('/')) throw new Error(`只接受绝对路径：${input}`)
  const normalized = posix.normalize(input)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** 校验文件名（单段）。 */
export function validateName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') throw new Error('名称不合法。')
  if (/[/\0]/.test(trimmed)) throw new Error('名称不能包含 / 或空字符。')
  if (Buffer.byteLength(trimmed) > 255) throw new Error('名称过长。')
  return trimmed
}

/** 路径层级数：`/` = 0，`/home` = 1，`/home/ls` = 2。 */
function depthOf(p: string): number {
  return p === '/' ? 0 : p.split('/').length - 1
}

// ------------------------------------------------------------------ 会话

interface CachedSession {
  connection: SshConnection
  sftp: SftpLike
}

const MAX_ENTRIES = 5000
const LINK_LOOKUP_LIMIT = 200
const LINK_CONCURRENCY = 8
const BINARY_SNIFF_BYTES = 8000
const REMOVE_LIMIT = 200_000

export class RemoteFs {
  private sessions = new Map<string, CachedSession>()
  private pending = new Map<string, Promise<SftpLike>>()
  private disposed = false

  constructor(
    private readonly rt: WorkspaceRuntime,
    /** 用户自定义的忽略规则（每次调用现取，改了立即生效）。 */
    private readonly userIgnore: () => readonly string[] = () => []
  ) {}

  /**
   * 取某主机的 SFTP 会话。走「file」连接池：大文件传输不会拖慢终端。
   * 底层连接换了（断线重连）就重新开 SFTP 子系统，并合并并发请求。
   */
  async sftp(hostId: string): Promise<SftpLike> {
    if (this.disposed) throw new Error('文件服务已停止。')
    const connection = await this.rt.pool.acquire(hostId, 'file', () => this.rt.resolveHost(hostId))
    const cached = this.sessions.get(hostId)
    if (cached !== undefined && cached.connection === connection) return cached.sftp

    const inflight = this.pending.get(hostId)
    if (inflight !== undefined) return await inflight

    const opening = new Promise<SftpLike>((resolve, reject) => {
      connection.raw().sftp((err, raw) => {
        if (err !== null && err !== undefined) {
          reject(new Error(`打开 SFTP 子系统失败：${err.message}（远端 sshd 可能未启用 sftp-server）`, { cause: err }))
          return
        }
        resolve(raw as SftpLike)
      })
    })
    this.pending.set(hostId, opening)
    try {
      const sftp = await opening
      if (this.disposed) {
        sftp.end()
        throw new Error('文件服务已停止。')
      }
      const drop = (): void => {
        if (this.sessions.get(hostId)?.sftp === sftp) this.sessions.delete(hostId)
      }
      sftp.on('close', drop)
      sftp.on('end', drop)
      this.sessions.set(hostId, { connection, sftp })
      return sftp
    } finally {
      this.pending.delete(hostId)
    }
  }

  /** 远端家目录（文件浏览的默认起点）。 */
  async home(hostId: string): Promise<string> {
    const sftp = await this.sftp(hostId)
    return normalizeRemotePath(await call<string>((cb) => sftp.realpath('.', cb)))
  }

  /**
   * 列目录。
   * - 按「目录在前、名称自然序」排序
   * - 符号链接额外查目标类型（有上限，大目录里全是链接时不至于卡死）
   * - 忽略标记只用于淡化显示，由调用方决定是否隐藏
   */
  async list(hostId: string, dir: string): Promise<ListResult> {
    const target = normalizeRemotePath(dir)
    const sftp = await this.sftp(hostId)
    const raw = await call<SftpDirEntry[]>((cb) => sftp.readdir(target, cb))

    const filtered = raw.filter((e) => e.filename !== '.' && e.filename !== '..')
    const truncated = filtered.length > MAX_ENTRIES
    const kept = truncated ? filtered.slice(0, MAX_ENTRIES) : filtered

    const matcher = await this.matcherFor(sftp, target)
    const entries: RemoteEntry[] = kept.map((e) => {
      const full = target === '/' ? `/${e.filename}` : `${target}/${e.filename}`
      const type = typeOfMode(e.attrs.mode)
      return {
        name: e.filename,
        path: full,
        type,
        size: e.attrs.size,
        mtime: e.attrs.mtime * 1000,
        mode: e.attrs.mode & 0o7777,
        ignored: matcher.ignores(full, type === 'dir'),
        hidden: e.filename.startsWith('.')
      }
    })

    await this.resolveLinks(sftp, entries.filter((e) => e.type === 'symlink').slice(0, LINK_LOOKUP_LIMIT))

    entries.sort((a, b) => {
      const ad = a.type === 'dir' || a.linkIsDir === true ? 0 : 1
      const bd = b.type === 'dir' || b.linkIsDir === true ? 0 : 1
      if (ad !== bd) return ad - bd
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return { path: target, entries, truncated }
  }

  /** 为符号链接补上目标与「是否指向目录」。悬空链接照常列出，只是不可展开。 */
  private async resolveLinks(sftp: SftpLike, links: RemoteEntry[]): Promise<void> {
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < links.length) {
        const entry = links[index] as RemoteEntry
        index += 1
        try {
          entry.linkTarget = await call<string>((cb) => sftp.readlink(entry.path, cb))
        } catch {
          /* 无权限读取链接内容：保持未知 */
        }
        try {
          const attrs = await call<SftpAttrs>((cb) => sftp.stat(entry.path, cb))
          entry.linkIsDir = typeOfMode(attrs.mode) === 'dir'
        } catch {
          entry.linkIsDir = false
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, links.length) }, worker))
  }

  /** 该目录下的忽略判定器：默认规则 + 用户规则 + 该目录自己的 .gitignore。 */
  private async matcherFor(sftp: SftpLike, dir: string): Promise<IgnoreMatcher> {
    let gitignore: string | undefined
    try {
      const file = dir === '/' ? '/.gitignore' : `${dir}/.gitignore`
      const attrs = await call<SftpAttrs>((cb) => sftp.stat(file, cb))
      // 超大的 .gitignore 不读，避免一次列目录拉一个巨型文件。
      if (typeOfMode(attrs.mode) === 'file' && attrs.size <= 256 * 1024) {
        gitignore = (await readAll(sftp.createReadStream(file))).toString('utf8')
      }
    } catch {
      /* 没有 .gitignore */
    }
    return buildMatcher(dir, this.userIgnore(), gitignore)
  }

  /**
   * 读取文件用于预览。超过上限只读前一段；含 NUL 字节判为二进制、不返回内容。
   */
  async readText(hostId: string, file: string, maxBytes: number): Promise<ReadResult> {
    const target = normalizeRemotePath(file)
    const sftp = await this.sftp(hostId)
    const attrs = await call<SftpAttrs>((cb) => sftp.stat(target, cb))
    if (typeOfMode(attrs.mode) !== 'file') throw new Error('只能预览普通文件。')

    const limit = Math.min(attrs.size, maxBytes)
    const buffer = limit === 0 ? Buffer.alloc(0) : await readAll(sftp.createReadStream(target, { start: 0, end: limit - 1 }))
    const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES)
    const binary = sniff.includes(0)
    const content = binary ? '' : buffer.toString('utf8')
    const lossy = !binary && !utf8RoundTrips(buffer, attrs.size > maxBytes)
    return {
      path: target,
      size: attrs.size,
      mtime: attrs.mtime * 1000,
      content,
      truncated: attrs.size > maxBytes,
      binary,
      lossy
    }
  }

  /**
   * 读取整个文件的原始字节（base64），给桌面版的预览内联资源用（图片 / 字体 / 样式 / 脚本）。
   * 桌面版宿主只给 DSH 自己页面来源的请求放行，沙箱预览 iframe 里的相对资源请求会被拒，只能经远程调用取回后内联。
   */
  async readData(hostId: string, file: string, maxBytes: number): Promise<{ path: string; size: number; base64: string }> {
    const target = normalizeRemotePath(file)
    const sftp = await this.sftp(hostId)
    const attrs = await call<SftpAttrs>((cb) => sftp.stat(target, cb))
    if (typeOfMode(attrs.mode) !== 'file') throw new Error('只能读取普通文件。')
    if (attrs.size > maxBytes) throw new Error(`文件过大（${attrs.size} 字节，上限 ${maxBytes}）。`)
    const buffer = attrs.size === 0 ? Buffer.alloc(0) : await readAll(sftp.createReadStream(target))
    return { path: target, size: attrs.size, base64: buffer.toString('base64') }
  }

  /**
   * 保存编辑器内容。
   *
   * - 冲突检测：远端 mtime 与打开时不同则拒绝（SFTP 的 mtime 精度为秒，同一秒内的
   *   外部修改检测不到，这是协议限制）
   * - 原子写入：同目录临时文件写完再改名，中途断线不会留下半截文件
   * - 符号链接：写到链接指向的真实文件，否则改名会把链接本身替换成普通文件
   * - 保留权限位：否则编辑一个脚本会丢掉可执行位
   */
  async writeText(
    hostId: string,
    file: string,
    content: string,
    expectedMtime: number | undefined
  ): Promise<{ path: string; size: number; mtime: number }> {
    const requested = normalizeRemotePath(file)
    const sftp = await this.sftp(hostId)

    let target = requested
    let mode = 0o644
    let existed = true
    try {
      const link = await call<SftpAttrs>((cb) => sftp.lstat(requested, cb))
      if (typeOfMode(link.mode) === 'symlink') {
        target = normalizeRemotePath(await call<string>((cb) => sftp.realpath(requested, cb)))
      }
      const attrs = await call<SftpAttrs>((cb) => sftp.stat(target, cb))
      if (typeOfMode(attrs.mode) !== 'file') throw new Error('只能保存到普通文件。')
      if (expectedMtime !== undefined && attrs.mtime * 1000 !== expectedMtime) {
        throw new RemoteConflictError(requested, attrs.mtime * 1000, attrs.size)
      }
      mode = attrs.mode & 0o7777
    } catch (error) {
      if (!isNotFound(error)) throw error
      // 打开后被删掉了：带着 expectedMtime 视为冲突，由用户决定是否重新创建。
      if (expectedMtime !== undefined) throw new RemoteConflictError(requested, 0, 0)
      existed = false
    }

    const dir = posix.dirname(target)
    const tmp = posix.join(dir, `.${posix.basename(target)}.dshws-${randomBytes(4).toString('hex')}.part`)
    const bytes = Buffer.from(content, 'utf8')
    try {
      await pipeline(Readable.from([bytes]), sftp.createWriteStream(tmp, { flags: 'wx', mode }))
      if (existed) await replace(sftp, tmp, target)
      else await call((cb) => sftp.rename(tmp, target, cb))
    } catch (error) {
      await call((cb) => sftp.unlink(tmp, cb)).catch(() => undefined)
      throw error
    }
    const after = await call<SftpAttrs>((cb) => sftp.stat(target, cb))
    this.rt.log.info(hostId, 'sftp', `已保存 ${requested}（${bytes.length} 字节）`)
    return { path: requested, size: after.size, mtime: after.mtime * 1000 }
  }

  // ---------------------------------------------------------------- Agent 工具用的底层能力

  /** stat（跟随符号链接）；不存在返回 undefined，其他错误照常抛出。 */
  async statPath(hostId: string, file: string): Promise<{ type: EntryType; size: number; mtimeMs: number } | undefined> {
    const sftp = await this.sftp(hostId)
    try {
      const attrs = await call<SftpAttrs>((cb) => sftp.stat(normalizeRemotePath(file), cb))
      return { type: typeOfMode(attrs.mode), size: attrs.size, mtimeMs: attrs.mtime * 1000 }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  /** lstat（不跟随符号链接）；不存在返回 undefined，其他错误照常抛出。 */
  async lstatPath(hostId: string, file: string): Promise<{ type: EntryType; size: number; mtimeMs: number } | undefined> {
    const sftp = await this.sftp(hostId)
    try {
      const attrs = await call<SftpAttrs>((cb) => sftp.lstat(normalizeRemotePath(file), cb))
      return { type: typeOfMode(attrs.mode), size: attrs.size, mtimeMs: attrs.mtime * 1000 }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  /** 读取整个文件的字节；超过 maxBytes 直接拒绝（不静默截断 —— 截断后再写回会丢内容）。 */
  async readBytes(hostId: string, file: string, maxBytes: number): Promise<Buffer> {
    const target = normalizeRemotePath(file)
    const sftp = await this.sftp(hostId)
    const attrs = await call<SftpAttrs>((cb) => sftp.stat(target, cb))
    if (attrs.size > maxBytes) {
      throw new Error(`cannot read "${target}": file is ${attrs.size} bytes, larger than the ${maxBytes}-byte limit for remote files`)
    }
    return attrs.size === 0 ? Buffer.alloc(0) : await readAll(sftp.createReadStream(target))
  }

  /** 逐级创建目录（已存在的跳过）。 */
  async mkdirp(hostId: string, dir: string): Promise<void> {
    const target = normalizeRemotePath(dir)
    const sftp = await this.sftp(hostId)
    const parts = target.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = `${current}/${part}`
      try {
        const attrs = await call<SftpAttrs>((cb) => sftp.stat(current, cb))
        if (typeOfMode(attrs.mode) !== 'dir') throw new Error(`cannot create directory "${current}": a non-directory file exists`)
      } catch (error) {
        if (!isNotFound(error)) throw error
        await call((cb) => sftp.mkdir(current, cb)).catch(async (mkErr: unknown) => {
          // 并发创建同一目录：别人刚建好也算成功。
          if ((await this.statPath(hostId, current))?.type !== 'dir') throw mkErr
        })
      }
    }
  }

  async mkdir(hostId: string, parent: string, name: string): Promise<string> {
    const target = posix.join(normalizeRemotePath(parent), validateName(name))
    const sftp = await this.sftp(hostId)
    await call((cb) => sftp.mkdir(target, cb))
    this.rt.log.info(hostId, 'sftp', `已新建目录 ${target}`)
    return target
  }

  /** 新建空文件。'wx' = 独占创建：同名文件已存在时失败，绝不截断已有文件。 */
  async createFile(hostId: string, parent: string, name: string): Promise<string> {
    const target = posix.join(normalizeRemotePath(parent), validateName(name))
    const sftp = await this.sftp(hostId)
    const handle = await call<Buffer>((cb) => sftp.open(target, 'wx', cb)).catch((error: unknown) => {
      throw new Error(`新建文件失败（可能已存在同名文件）：${target}`, { cause: error })
    })
    await call((cb) => sftp.close(handle, cb))
    this.rt.log.info(hostId, 'sftp', `已新建文件 ${target}`)
    return target
  }

  /** 重命名（同目录内改名）。目标已存在时拒绝，避免静默覆盖。 */
  async rename(hostId: string, from: string, newName: string): Promise<string> {
    const source = normalizeRemotePath(from)
    const target = posix.join(posix.dirname(source), validateName(newName))
    if (target === source) return source
    const sftp = await this.sftp(hostId)
    if (await exists(sftp, target)) throw new RemoteExistsError(target)
    await call((cb) => sftp.rename(source, target, cb))
    this.rt.log.info(hostId, 'sftp', `已重命名 ${source} → ${target}`)
    return target
  }

  /**
   * 复制文件或目录到 targetDir（远端 `cp -RPp`：递归、不跟随符号链接、保留权限与时间）。
   * 目标已有同名项时按「名称 copy.扩展名」「名称 copy 2.扩展名」… 依次取不冲突的名字，绝不覆盖。
   * 拒绝把目录复制进它自己或它的子目录（cp 会无限嵌套）。
   */
  async copy(hostId: string, from: string, targetDir: string): Promise<string> {
    const source = normalizeRemotePath(from)
    const dir = normalizeRemotePath(targetDir)
    if (source === '/') throw new Error('不能复制根目录。')
    if (dir === source || dir.startsWith(`${source}/`)) throw new Error(`不能把目录复制到它自己里面：${source} → ${dir}`)
    const sftp = await this.sftp(hostId)
    const srcAttrs = await call<SftpAttrs>((cb) => sftp.lstat(source, cb))
    const dirAttrs = await call<SftpAttrs>((cb) => sftp.stat(dir, cb))
    if (typeOfMode(dirAttrs.mode) !== 'dir') throw new Error(`目标不是目录：${dir}`)

    const target = await freeCopyName(sftp, dir, posix.basename(source), typeOfMode(srcAttrs.mode) === 'dir')
    const connection = await this.rt.pool.acquire(hostId, 'file', () => this.rt.resolveHost(hostId))
    const out = await execCapture(connection, `cp -RPp -- ${shellQuote(source)} ${shellQuote(target)}`, { timeoutMs: 120_000, maxBytes: 64 * 1024 })
    if (out.timedOut) throw new Error(`复制超时（2 分钟），可能仍在远端进行：${source} → ${target}`)
    if (out.code !== 0) throw new Error(`复制失败：${out.stderr.trim() || `退出码 ${String(out.code)}`}`)
    this.rt.log.info(hostId, 'sftp', `已复制 ${source} → ${target}`)
    return target
  }

  /**
   * 删除文件或目录（目录递归删除）。
   *
   * 安全边界：
   * - 拒绝删除 `/`、一级目录（如 /etc、/home）与家目录本身 —— 界面误点的代价太大
   * - 用 lstat 判断类型：符号链接只删链接本身，绝不顺着链接进入目标目录
   * - 条目数设上限，防止误删整个数据盘时一路删到底
   */
  async remove(hostId: string, target: string): Promise<RemoveResult> {
    const path0 = normalizeRemotePath(target)
    if (depthOf(path0) < 2) throw new Error(`出于安全考虑，不允许删除根目录或一级目录：${path0}`)
    const home = await this.home(hostId)
    if (path0 === home) throw new Error(`出于安全考虑，不允许删除家目录本身：${path0}`)

    const sftp = await this.sftp(hostId)
    const result: RemoveResult = { files: 0, dirs: 0 }

    const walk = async (p: string): Promise<void> => {
      if (result.files + result.dirs >= REMOVE_LIMIT) {
        throw new Error(`待删除条目超过 ${REMOVE_LIMIT} 个，已中止。请在终端中手动处理。`)
      }
      const attrs = await call<SftpAttrs>((cb) => sftp.lstat(p, cb))
      if (typeOfMode(attrs.mode) === 'dir') {
        const children = await call<SftpDirEntry[]>((cb) => sftp.readdir(p, cb))
        for (const child of children) {
          if (child.filename === '.' || child.filename === '..') continue
          await walk(`${p}/${child.filename}`)
        }
        await call((cb) => sftp.rmdir(p, cb))
        result.dirs += 1
      } else {
        await call((cb) => sftp.unlink(p, cb))
        result.files += 1
      }
    }

    try {
      await walk(path0)
    } finally {
      this.rt.log.info(hostId, 'sftp', `删除 ${path0}：${result.files} 个文件、${result.dirs} 个目录。`)
    }
    return result
  }

  /**
   * 按文件名模糊搜索（远端 find 实时执行，不建常驻索引）。
   * 忽略规则转成 find 的 -prune，node_modules 这类目录不会被遍历。
   */
  async search(hostId: string, root: string, query: string, limit = 500): Promise<SearchResult> {
    const base = normalizeRemotePath(root)
    const q = query.trim()
    if (q === '') return { root: base, matches: [], truncated: false, timedOut: false }
    const sftp = await this.sftp(hostId)
    const matcher = await this.matcherFor(sftp, base)

    // 查询词里的 glob 元字符按字面匹配，避免用户输入 * 或 [ 时意外展开。
    const literal = q.replace(/[\\*?[\]]/g, (ch) => `\\${ch}`)
    const connection = await this.rt.pool.acquire(hostId, 'file', () => this.rt.resolveHost(hostId))
    const gnu = await this.supportsPrintf(hostId, connection)
    const args = [
      'find',
      base,
      '-mindepth',
      '1',
      '-maxdepth',
      '16',
      ...matcher.toFindPrune(),
      '-iname',
      `*${literal}*`,
      // GNU find 直接输出类型；BusyBox 等精简 find 没有 -printf，只能分两类各查一次类型。
      ...(gnu ? ['-printf', '%y %p\\n'] : ['-print'])
    ]
    // 2>/dev/null：无权限目录会刷大量 stderr，与结果无关。
    const command = `${args.map(shellQuote).join(' ')} 2>/dev/null | head -n ${limit + 1}`
    const out = await execCapture(connection, command, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 })

    const matches: SearchResult['matches'] = []
    for (const line of out.stdout.split('\n')) {
      if (gnu) {
        if (line.length < 3) continue
        const kind = line[0]
        const p = line.slice(2)
        if (kind === 'd') matches.push({ path: p, type: 'dir' })
        else if (kind === 'f' || kind === 'l') matches.push({ path: p, type: 'file' })
      } else if (line !== '') {
        // 没有类型信息：先都当文件，点开时前端按实际类型处理。
        matches.push({ path: line, type: 'file' })
      }
    }
    const truncated = matches.length > limit || out.truncated
    return { root: base, matches: matches.slice(0, limit), truncated, timedOut: out.timedOut }
  }

  private printfSupport = new Map<string, boolean>()

  /** 探测远端 find 是否支持 -printf（每台主机只探测一次）。 */
  private async supportsPrintf(hostId: string, connection: SshConnection): Promise<boolean> {
    const cached = this.printfSupport.get(hostId)
    if (cached !== undefined) return cached
    const probe = await execCapture(connection, "find / -maxdepth 0 -printf 'ok' 2>/dev/null", {
      timeoutMs: 5000,
      maxBytes: 64
    })
    const ok = probe.stdout.trim() === 'ok'
    this.printfSupport.set(hostId, ok)
    return ok
  }

  // ---------------------------------------------------------------- 流

  /** 打开下载流。只允许普通文件（包括指向普通文件的符号链接）。 */
  async openDownload(hostId: string, file: string): Promise<{ stream: Readable; size: number; name: string }> {
    const target = normalizeRemotePath(file)
    const sftp = await this.sftp(hostId)
    const attrs = await call<SftpAttrs>((cb) => sftp.stat(target, cb))
    if (typeOfMode(attrs.mode) !== 'file') throw new Error('只能下载普通文件。')
    return { stream: sftp.createReadStream(target), size: attrs.size, name: posix.basename(target) }
  }

  /**
   * 上传：先写同目录下的临时文件，完整写完再改名为目标名。
   * 中途断线只会留下临时文件（并尝试清理），不会产生半截的目标文件。
   */
  async upload(
    hostId: string,
    dir: string,
    name: string,
    source: Readable,
    options: { overwrite: boolean }
  ): Promise<{ path: string }> {
    const parent = normalizeRemotePath(dir)
    const target = posix.join(parent, validateName(name))
    const sftp = await this.sftp(hostId)

    const parentAttrs = await call<SftpAttrs>((cb) => sftp.stat(parent, cb))
    if (typeOfMode(parentAttrs.mode) !== 'dir') throw new Error(`上传目标不是目录：${parent}`)
    const existed = await exists(sftp, target)
    if (existed && !options.overwrite) throw new RemoteExistsError(target)

    const tmp = posix.join(parent, `.${posix.basename(target)}.dshws-${randomBytes(4).toString('hex')}.part`)
    try {
      await pipeline(source, sftp.createWriteStream(tmp, { flags: 'wx' }))
      if (existed) await replace(sftp, tmp, target)
      else await call((cb) => sftp.rename(tmp, target, cb))
    } catch (error) {
      await call((cb) => sftp.unlink(tmp, cb)).catch(() => undefined)
      throw error
    }
    this.rt.log.info(hostId, 'sftp', `已上传 ${target}${existed ? '（覆盖）' : ''}`)
    return { path: target }
  }

  dispose(): void {
    this.disposed = true
    for (const { sftp } of this.sessions.values()) {
      try {
        sftp.end()
      } catch {
        /* 已关闭 */
      }
    }
    this.sessions.clear()
  }
}

// ------------------------------------------------------------------ 辅助

async function exists(sftp: SftpLike, p: string): Promise<boolean> {
  try {
    await call<SftpAttrs>((cb) => sftp.lstat(p, cb))
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/**
 * 复制目标名：不冲突就用原名，否则「a copy.txt」「a copy 2.txt」…（目录不拆扩展名；点开头的隐藏文件不当扩展名）。
 */
export function copyNameCandidates(name: string, isDir: boolean): (n: number) => string {
  const dot = isDir ? -1 : name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return (n) => (n === 0 ? name : n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`)
}

async function freeCopyName(sftp: SftpLike, dir: string, name: string, isDir: boolean): Promise<string> {
  const nameAt = copyNameCandidates(name, isDir)
  for (let n = 0; n < 1000; n++) {
    const candidate = posix.join(dir, nameAt(n))
    if (!(await exists(sftp, candidate))) return candidate
  }
  throw new Error(`找不到可用的复制目标名：${posix.join(dir, name)}`)
}

/**
 * posix-rename 失败是否因为「服务端不支持该扩展」：ssh2 在服务端未声明扩展时同步抛出
 * 「Server does not support this extended request」（无状态码），服务端拒绝时回 OP_UNSUPPORTED（8）。
 * 只有这两种情况才能退化为「删旧 + 改名」；权限不足等真实失败若也退化，删旧成功、改名失败会丢掉原文件。
 */
export function isRenameUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 8) return true
  return code === undefined && /does not support/i.test(error instanceof Error ? error.message : String(error))
}

/**
 * 用临时文件替换已存在的目标。优先 OpenSSH 的 posix-rename（原子覆盖）；
 * 服务端不支持时退化为「删旧 + 改名」，两步之间有极短的目标缺失窗口。
 */
async function replace(sftp: SftpLike, tmp: string, target: string): Promise<void> {
  const posixRename = sftp.ext_openssh_rename?.bind(sftp)
  if (posixRename !== undefined) {
    try {
      await call((cb) => posixRename(tmp, target, cb))
      return
    } catch (error) {
      if (!isRenameUnsupported(error)) throw error
    }
  }
  await call((cb) => sftp.unlink(target, cb))
  await call((cb) => sftp.rename(tmp, target, cb))
}

/**
 * 字节按 UTF-8 解码再编码后是否不变（不变 = 合法 UTF-8，编辑保存不会损坏文件）。
 * 被截断的内容末尾可能切在一个多字节字符中间（最多 3 字节），比较时把这段让出去。
 */
export function utf8RoundTrips(buffer: Buffer, truncated: boolean): boolean {
  const body = truncated ? buffer.subarray(0, Math.max(0, buffer.length - 3)) : buffer
  const reencoded = Buffer.from(buffer.toString('utf8'), 'utf8')
  return reencoded.subarray(0, body.length).equals(body)
}

function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(Buffer.concat(chunks)))
  })
}
