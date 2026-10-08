/*
 * @Description: 受限上传 —— 只允许写到远程工作区根目录（按真实路径）之内，不跟随目标处的符号链接
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/sftp/confined-upload.ts
 *
 * 全程只用 SFTP 协议操作（realpath / lstat / mkdir / rename），不经过 shell，没有命令注入面。
 * 校验时机：
 *   1. 以根目录的真实路径 R 为起点逐级走目录；中间段是符号链接时解析后必须仍在 R 内；
 *      新建的目录立刻 lstat 确认是目录（不是被换成的链接）
 *   2. 最终目标若已存在且是符号链接 → 拒绝（不跟随，与编辑保存「写到链接指向」的语义相反）
 *   3. 临时文件用 wx（O_EXCL）独占创建，预置的同名链接会让创建失败而不是被跟随
 *   4. rename 前再核对一次父目录真实路径与目标状态；写后再复核目标的真实路径与大小
 *
 * 残余风险（SFTP 没有 openat / O_NOFOLLOW 目录句柄）：远端另一进程恰好在核对与 rename 之间
 * 把父目录换成外链，理论上仍可能写到外面。能做到这一点的前提是对方已能写该工作区，
 * 本工具的定位是防误写 / 防注入错位写入，而不是防恶意远端进程（方案文档 5.3）。
 */
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UploadError } from '../agent/upload-path.js'
import { isRenameUnsupported, typeOfMode, type SftpLike } from './remote-fs.js'

const posix = path.posix

/** 受限上传用到的 SFTP 能力子集（便于用内存替身测试）。 */
export type ConfinedSftp = Pick<SftpLike, 'lstat' | 'stat' | 'realpath' | 'mkdir' | 'rename' | 'ext_openssh_rename' | 'unlink' | 'createWriteStream'>

type Attrs = { mode: number; size: number }
type Cb<T> = (err: (Error & { code?: number }) | null | undefined, value: T) => void

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

async function lstatOrUndefined(sftp: ConfinedSftp, p: string): Promise<Attrs | undefined> {
  try {
    return await call<Attrs>((cb) => sftp.lstat(p, cb))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** p 是否位于根 root 之内（含根本身）。 */
export function isInside(root: string, p: string): boolean {
  return root === '/' || p === root || p.startsWith(`${root}/`)
}

function relativeSegments(root: string, p: string): string[] {
  const rel = root === '/' ? p.slice(1) : p.slice(root.length + 1)
  return rel === '' ? [] : rel.split('/')
}

export interface ConfinedUploadInput {
  /** 远程工作区根（绑定里登记的写法，未必是真实路径）。 */
  root: string
  /** 相对根的路径段，最后一段是文件名（已通过 parseUploadTarget 校验）。 */
  segments: readonly string[]
  source: Readable
  /** 预期字节数：写完后按此核对。 */
  bytes: number
  overwrite: boolean
  signal?: AbortSignal
  /**
   * 受保护目标检查：按「解析后的真实路径」再判一次
   * （防止 `link -> .git` 这类工作区内链接绕过字面检查）。返回原因即拒绝。
   * realTarget 是目标的真实绝对路径，home 是 SFTP 登录目录的真实路径（取不到时 undefined）。
   */
  protect?: (realSegments: readonly string[], context: { realRoot: string; realTarget: string; home: string | undefined }) => string | undefined
  /** 覆盖已有文件前回调（用于存档原内容）。path 为按绑定根写法的路径，与 write / edit 的存档键一致。 */
  beforeOverwrite?: (target: { path: string; realPath: string }) => Promise<void>
  /** 字节已全部写入临时文件、改名生效前调用；抛错则放弃本次写入（用于哈希核对）。 */
  verify?: () => void
}

export interface ConfinedUploadResult {
  /** 按绑定根写法拼出的真实位置（中间段链接已解析；给模型看，与其他远程工具一致）。 */
  path: string
  /** 按模型给出的路径段拼出的写法（中间段是工作区内链接时与 path 不同）。 */
  requestedPath: string
  /** 真实路径。 */
  realPath: string
  operation: 'create' | 'overwrite'
}

/**
 * 在远程工作区内受限地写入一个文件。
 * @throws UploadError（UPLOAD_OUTSIDE_WORKSPACE / UPLOAD_TARGET_SYMLINK / UPLOAD_EXISTS / UPLOAD_PROTECTED_TARGET / UPLOAD_BAD_TARGET / UPLOAD_SIZE_MISMATCH）
 */
export async function confinedUpload(sftp: ConfinedSftp, input: ConfinedUploadInput): Promise<ConfinedUploadResult> {
  const outside = (p: string): UploadError =>
    new UploadError(`refusing to write outside the remote workspace: "${p}" resolves outside ${input.root}`, 'UPLOAD_OUTSIDE_WORKSPACE')
  const realpath = async (p: string): Promise<string> => posix.normalize(await call<string>((cb) => sftp.realpath(p, cb)))

  // 1. 根目录的真实路径：每次都重新取（根本身可能是链接，或被替换过）。
  let realRoot: string
  try {
    realRoot = await realpath(input.root)
  } catch (error) {
    if (isNotFound(error)) throw new UploadError(`the remote workspace root ${input.root} does not exist`, 'UPLOAD_ROOT_NOT_FOUND')
    throw error
  }
  realRoot = realRoot.length > 1 ? realRoot.replace(/\/+$/, '') : realRoot
  const rootAttrs = await call<Attrs>((cb) => sftp.stat(realRoot, cb))
  if (typeOfMode(rootAttrs.mode) !== 'dir') throw new UploadError(`the remote workspace root ${input.root} is not a directory`, 'UPLOAD_ROOT_NOT_FOUND')

  // 2. 逐级走目录（从真实根拼接，不再经过根处的链接）。
  const dirs = input.segments.slice(0, -1)
  const name = input.segments[input.segments.length - 1] as string
  let parent = realRoot
  for (const segment of dirs) {
    const next = posix.join(parent, segment)
    const attrs = await lstatOrUndefined(sftp, next)
    if (attrs === undefined) {
      await call<void>((cb) => sftp.mkdir(next, cb)).catch(async (error: unknown) => {
        // 并发创建：别人刚建好的也要是真目录，不能是链接。
        if (typeOfMode((await lstatOrUndefined(sftp, next))?.mode ?? 0) !== 'dir') throw error
      })
      const created = await lstatOrUndefined(sftp, next)
      if (created === undefined || typeOfMode(created.mode) !== 'dir') {
        throw new UploadError(`"${next}" is not a directory after creating it`, 'UPLOAD_TARGET_SYMLINK')
      }
      parent = next
    } else if (typeOfMode(attrs.mode) === 'symlink') {
      const resolved = await realpath(next)
      if (!isInside(realRoot, resolved)) throw outside(next)
      const target = await call<Attrs>((cb) => sftp.stat(resolved, cb))
      if (typeOfMode(target.mode) !== 'dir') throw new UploadError(`"${next}" is not a directory`, 'UPLOAD_BAD_TARGET')
      parent = resolved
    } else if (typeOfMode(attrs.mode) === 'dir') {
      parent = next
    } else {
      throw new UploadError(`"${next}" exists and is not a directory`, 'UPLOAD_BAD_TARGET')
    }
  }

  // 3. 父目录真实路径复核 + 按真实相对路径做受保护检查。
  const checkParent = async (): Promise<void> => {
    if (!isInside(realRoot, await realpath(parent))) throw outside(parent)
  }
  await checkParent()
  const target = posix.join(parent, name)
  if (input.protect !== undefined) {
    const home = await realpath('.').catch(() => undefined)
    const reason = input.protect(relativeSegments(realRoot, target), { realRoot, realTarget: target, home })
    if (reason !== undefined) throw new UploadError(`refusing to write "${target}": ${reason}`, 'UPLOAD_PROTECTED_TARGET')
  }

  // 4. 目标状态：链接一律拒绝，不跟随。
  const inspectTarget = async (): Promise<boolean> => {
    const attrs = await lstatOrUndefined(sftp, target)
    if (attrs === undefined) return false
    const type = typeOfMode(attrs.mode)
    if (type === 'symlink') throw new UploadError(`refusing to write "${target}": it is a symbolic link`, 'UPLOAD_TARGET_SYMLINK')
    if (type !== 'file') throw new UploadError(`refusing to write "${target}": it exists and is not a regular file`, 'UPLOAD_BAD_TARGET')
    if (!input.overwrite) throw new UploadError(`"${target}" already exists; set overwrite to true to replace it`, 'UPLOAD_EXISTS')
    return true
  }
  const literalRoot = input.root.length > 1 ? input.root.replace(/\/+$/, '') : input.root
  const rel = relativeSegments(realRoot, target).join('/')
  const displayPath = literalRoot === '/' ? `/${rel}` : `${literalRoot}/${rel}`
  const requested = input.segments.join('/')
  const requestedPath = literalRoot === '/' ? `/${requested}` : `${literalRoot}/${requested}`
  const existed = await inspectTarget()
  if (existed && input.beforeOverwrite !== undefined) await input.beforeOverwrite({ path: displayPath, realPath: target })

  // 5. 同目录临时文件，wx 独占创建；请求 0644（不设可执行位，实际权限再受远端 umask 约束）。
  // 临时名里的原文件名按字节截断：目标名接近 255 字节时，加上前后缀会超过文件名上限。
  const tmp = posix.join(parent, `.${truncateUtf8(name, TEMP_NAME_BYTES)}.dshws-${randomBytes(4).toString('hex')}.part`)
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length
      cb(null, chunk)
    }
  })
  try {
    await pipeline(input.source, counter, sftp.createWriteStream(tmp, { flags: 'wx', mode: 0o644 }), { signal: input.signal })
    if (written !== input.bytes) {
      throw new UploadError(`size mismatch: wrote ${written} bytes, expected ${input.bytes}`, 'UPLOAD_SIZE_MISMATCH')
    }
    input.verify?.()

    // 6. 改名前再核对一次（缩小检查与生效之间的窗口）。
    await checkParent()
    const existsNow = await inspectTarget()
    if (existsNow) await replaceFile(sftp, tmp, target)
    else await call<void>((cb) => sftp.rename(tmp, target, cb))
  } catch (error) {
    await call<void>((cb) => sftp.unlink(tmp, cb)).catch(() => undefined)
    throw error
  }

  // 7. 写后复核：必须是普通文件、真实路径在根内、大小一致。
  const after = await lstatOrUndefined(sftp, target)
  const realTarget = after === undefined ? undefined : await realpath(target).catch(() => undefined)
  if (after === undefined || typeOfMode(after.mode) !== 'file' || realTarget === undefined || !isInside(realRoot, realTarget)) {
    // 只删普通文件：若已被换成链接，unlink 也只删链接本身，不会动到外部文件。
    await call<void>((cb) => sftp.unlink(target, cb)).catch(() => undefined)
    throw new UploadError(`post-write verification failed for "${target}"; the file was removed`, 'UPLOAD_OUTSIDE_WORKSPACE')
  }
  if (after.size !== input.bytes) {
    // 位置正确、只是大小不符（改名后被别的进程改写）：不删，交给调用方报告，避免把别人刚写的内容也删掉。
    throw new UploadError(`"${target}" is ${after.size} bytes after upload, expected ${input.bytes}; it may have been modified concurrently`, 'UPLOAD_SIZE_MISMATCH')
  }

  return {
    path: displayPath,
    requestedPath,
    realPath: realTarget,
    operation: existed ? 'overwrite' : 'create'
  }
}

/** 临时文件名中保留的原文件名字节数：1（.）+ 180 + 20（.dshws-xxxxxxxx.part）≤ 255。 */
const TEMP_NAME_BYTES = 180

/** 按 UTF-8 字节截断，不切断多字节字符。 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let out = ''
  let bytes = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch)
    if (bytes + size > maxBytes) break
    out += ch
    bytes += size
  }
  return out
}

/** 用临时文件替换已存在的目标：优先 posix-rename（原子覆盖），仅在服务端不支持该扩展时退化为删旧 + 改名。 */
async function replaceFile(sftp: ConfinedSftp, tmp: string, target: string): Promise<void> {
  const posixRename = sftp.ext_openssh_rename?.bind(sftp)
  if (posixRename !== undefined) {
    try {
      await call<void>((cb) => posixRename(tmp, target, cb))
      return
    } catch (error) {
      // 权限不足等真实失败：直接报错。若也退化，「删旧」成功而「改名」失败时原文件就丢了。
      if (!isRenameUnsupported(error)) throw error
    }
  }
  await call<void>((cb) => sftp.unlink(target, cb))
  await call<void>((cb) => sftp.rename(tmp, target, cb))
}
