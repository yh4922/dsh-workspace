/*
 * @Description: 测试用内存 SFTP —— 支持目录 / 文件 / 符号链接、realpath、O_EXCL，以及注入竞态的钩子
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/sftp/fake-sftp.ts
 */
import path from 'node:path'
import { Writable } from 'node:stream'
import type { ConfinedSftp } from './confined-upload.js'

const posix = path.posix
type Node = { kind: 'dir' } | { kind: 'file'; data: Buffer; mode: number } | { kind: 'link'; target: string }
type Cb<T> = (err: (Error & { code?: number }) | null | undefined, value: T) => void

const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

function sftpError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code })
}
const NO_SUCH_FILE = 2
const FAILURE = 4

export class FakeSftp implements ConfinedSftp {
  nodes = new Map<string, Node>([['/', { kind: 'dir' }]])
  /** SFTP 登录目录（realpath('.') 的结果）。 */
  home = '/home/dev'
  supportsPosixRename = true
  /** rename 生效前调用：用于模拟「检查之后、改名之前」被人动了手脚。 */
  beforeRename: ((from: string, to: string) => void) | undefined
  /** createWriteStream 打开前调用：用于在临时文件路径上预置链接。 */
  beforeCreate: ((p: string) => void) | undefined
  /** 模拟 posix-rename 的真实失败（如权限不足）。 */
  posixRenameError: (Error & { code?: number }) | undefined
  /** 模拟服务端未声明 posix-rename 扩展（ssh2 同步抛错）。 */
  posixRenameThrowsUnsupported = false
  /** 模拟普通 rename 失败。 */
  renameError: (Error & { code?: number }) | undefined

  dir(p: string): this {
    let cur = ''
    for (const part of p.split('/').filter(Boolean)) {
      cur = `${cur}/${part}`
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'dir' })
    }
    return this
  }

  file(p: string, content: string | Buffer, mode = 0o644): this {
    this.dir(posix.dirname(p))
    this.nodes.set(p, { kind: 'file', data: Buffer.isBuffer(content) ? content : Buffer.from(content), mode })
    return this
  }

  link(p: string, target: string): this {
    this.dir(posix.dirname(p))
    this.nodes.set(p, { kind: 'link', target })
    return this
  }

  text(p: string): string | undefined {
    const n = this.nodes.get(p)
    return n?.kind === 'file' ? n.data.toString() : undefined
  }

  /** 解析路径（跟随所有链接）；不存在的末段保留字面。 */
  resolve(p: string, followLast = true, depth = 0): string {
    if (depth > 40) throw sftpError(FAILURE, 'too many levels of symbolic links')
    const abs = posix.normalize(p.startsWith('/') ? p : posix.join(this.home, p))
    const parts = abs.split('/').filter(Boolean)
    let cur = '/'
    for (let i = 0; i < parts.length; i += 1) {
      const next = posix.join(cur, parts[i] as string)
      const node = this.nodes.get(next)
      const last = i === parts.length - 1
      if (node?.kind === 'link' && (!last || followLast)) {
        const target = node.target.startsWith('/') ? node.target : posix.join(cur, node.target)
        cur = this.resolve(target, true, depth + 1)
      } else {
        cur = next
      }
    }
    return cur
  }

  private attrs(node: Node): { mode: number; size: number; mtime: number } {
    if (node.kind === 'dir') return { mode: S_IFDIR | 0o755, size: 0, mtime: 0 }
    if (node.kind === 'link') return { mode: S_IFLNK | 0o777, size: node.target.length, mtime: 0 }
    return { mode: S_IFREG | node.mode, size: node.data.length, mtime: 0 }
  }

  lstat(p: string, cb: Cb<{ mode: number; size: number; mtime: number }>): void {
    const real = posix.join(this.resolve(posix.dirname(p)), posix.basename(p))
    const node = this.nodes.get(real)
    if (node === undefined) cb(sftpError(NO_SUCH_FILE, 'No such file'), undefined as never)
    else cb(null, this.attrs(node))
  }

  stat(p: string, cb: Cb<{ mode: number; size: number; mtime: number }>): void {
    try {
      const node = this.nodes.get(this.resolve(p))
      if (node === undefined) cb(sftpError(NO_SUCH_FILE, 'No such file'), undefined as never)
      else cb(null, this.attrs(node))
    } catch (error) {
      cb(error as Error, undefined as never)
    }
  }

  realpath(p: string, cb: Cb<string>): void {
    try {
      const real = this.resolve(p)
      if (!this.nodes.has(real)) cb(sftpError(NO_SUCH_FILE, 'No such file'), undefined as never)
      else cb(null, real)
    } catch (error) {
      cb(error as Error, undefined as never)
    }
  }

  mkdir(p: string, cb: Cb<void>): void {
    const real = posix.join(this.resolve(posix.dirname(p)), posix.basename(p))
    if (this.nodes.has(real)) return cb(sftpError(FAILURE, 'exists'), undefined)
    if (this.nodes.get(posix.dirname(real))?.kind !== 'dir') return cb(sftpError(NO_SUCH_FILE, 'no parent'), undefined)
    this.nodes.set(real, { kind: 'dir' })
    cb(null, undefined)
  }

  unlink(p: string, cb: Cb<void>): void {
    const real = posix.join(this.resolve(posix.dirname(p)), posix.basename(p))
    const node = this.nodes.get(real)
    if (node === undefined || node.kind === 'dir') return cb(sftpError(NO_SUCH_FILE, 'No such file'), undefined)
    this.nodes.delete(real)
    cb(null, undefined)
  }

  private move(from: string, to: string, overwrite: boolean): Error | undefined {
    this.beforeRename?.(from, to)
    const src = posix.join(this.resolve(posix.dirname(from)), posix.basename(from))
    const dst = posix.join(this.resolve(posix.dirname(to)), posix.basename(to))
    const node = this.nodes.get(src)
    if (node === undefined) return sftpError(NO_SUCH_FILE, 'No such file')
    if (this.nodes.has(dst) && !overwrite) return sftpError(FAILURE, 'exists')
    this.nodes.delete(src)
    this.nodes.set(dst, node)
    return undefined
  }

  rename(from: string, to: string, cb: Cb<void>): void {
    if (this.renameError !== undefined) return cb(this.renameError, undefined)
    cb(this.move(from, to, false) ?? null, undefined)
  }

  get ext_openssh_rename(): ((from: string, to: string, cb: Cb<void>) => void) | undefined {
    if (!this.supportsPosixRename) return undefined
    return (from, to, cb) => {
      // 与 ssh2 一致：服务端未声明扩展时同步抛出（无状态码）。
      if (this.posixRenameThrowsUnsupported) throw new Error('Server does not support this extended request')
      if (this.posixRenameError !== undefined) return cb(this.posixRenameError, undefined)
      cb(this.move(from, to, true) ?? null, undefined)
    }
  }

  createWriteStream(p: string, options?: { flags?: string; mode?: number }): Writable {
    this.beforeCreate?.(p)
    const chunks: Buffer[] = []
    const exclusive = options?.flags === 'wx'
    let real: string | undefined
    // 与 POSIX open 一致：O_EXCL 时路径存在（包括悬空链接）即失败、绝不跟随；
    // 非独占打开会跟随末段链接，写到链接指向处 —— 用来复现「预置链接」攻击。
    const open = (): Error | undefined => {
      if (real !== undefined) return undefined
      const literal = posix.join(this.resolve(posix.dirname(p)), posix.basename(p))
      if (exclusive && this.nodes.has(literal)) return sftpError(FAILURE, 'exists')
      real = exclusive ? literal : this.resolve(p)
      if (this.nodes.get(posix.dirname(real))?.kind !== 'dir') return sftpError(NO_SUCH_FILE, 'no parent')
      this.nodes.set(real, { kind: 'file', data: Buffer.alloc(0), mode: options?.mode ?? 0o644 })
      return undefined
    }
    return new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        const error = open()
        if (error !== undefined) return cb(error)
        chunks.push(chunk)
        this.nodes.set(real as string, { kind: 'file', data: Buffer.concat(chunks), mode: options?.mode ?? 0o644 })
        cb()
      },
      final: (cb) => cb(open() ?? null)
    })
  }
}
