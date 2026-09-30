/*
 * @Description: 测试用内存后端（远程文件系统 + 可编排的命令输出）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/fake-backend.ts
 */
import type { ConfinedUploadInput, ConfinedUploadResult } from '../sftp/confined-upload.js'
import type { AgentBackend, RemoteStat, RunOptions, RunResult } from './backend.js'
import { UploadError } from './upload-path.js'

export class FakeBackend implements AgentBackend {
  files = new Map<string, { content: Buffer; mtimeMs: number }>()
  dirs = new Set<string>(['/'])
  commands: Array<{ command: string; options: RunOptions }> = []
  /** 按命令内容返回的结果；未命中时返回空输出、退出码 0。 */
  responder: (command: string, options: RunOptions) => Partial<RunResult> = () => ({})
  private clock = 1_700_000_000_000

  addDir(p: string): void {
    let cur = ''
    for (const part of p.split('/').filter(Boolean)) {
      cur = `${cur}/${part}`
      this.dirs.add(cur)
    }
  }

  put(p: string, content: string | Buffer): void {
    this.addDir(p.slice(0, p.lastIndexOf('/')) || '/')
    this.clock += 1000
    this.files.set(p, { content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), mtimeMs: this.clock })
  }

  text(p: string): string | undefined {
    return this.files.get(p)?.content.toString('utf8')
  }

  /** 符号链接：路径 → 目标（绝对路径）。stat 跟随，lstat 不跟随。 */
  links = new Map<string, string>()

  async lstat(p: string): Promise<RemoteStat | undefined> {
    if (this.links.has(p)) return { type: 'symlink', size: 0, mtimeMs: 0 }
    return await this.stat(p)
  }

  async stat(p: string): Promise<RemoteStat | undefined> {
    const link = this.links.get(p)
    if (link !== undefined) return await this.stat(link)
    const f = this.files.get(p)
    if (f !== undefined) return { type: 'file', size: f.content.length, mtimeMs: f.mtimeMs }
    if (this.dirs.has(p)) return { type: 'dir', size: 0, mtimeMs: 0 }
    return undefined
  }

  async readBytes(p: string, maxBytes: number): Promise<Buffer> {
    const f = this.files.get(p)
    if (f === undefined) throw new Error(`no such file ${p}`)
    if (f.content.length > maxBytes) throw new Error('too large')
    return f.content
  }

  async writeText(p: string, content: string): Promise<void> {
    this.put(p, content)
  }

  /** 简化版受限上传（无符号链接）：链接逃逸等场景由 sftp/confined-upload.test.ts 用内存 SFTP 覆盖。 */
  async upload(input: ConfinedUploadInput): Promise<ConfinedUploadResult> {
    const root = input.root.replace(/\/+$/, '') || '/'
    const target = `${root === '/' ? '' : root}/${input.segments.join('/')}`
    const reason = input.protect?.(input.segments, { realRoot: root, realTarget: target, home: undefined })
    if (reason !== undefined) throw new UploadError(`refusing to write "${target}": ${reason}`, 'UPLOAD_PROTECTED_TARGET')
    if (this.dirs.has(target)) throw new UploadError(`refusing to write "${target}": it exists and is not a regular file`, 'UPLOAD_BAD_TARGET')
    const existed = this.files.has(target)
    if (existed && !input.overwrite) throw new UploadError(`"${target}" already exists; set overwrite to true to replace it`, 'UPLOAD_EXISTS')
    if (existed) await input.beforeOverwrite?.({ path: target, realPath: target })
    const chunks: Buffer[] = []
    for await (const chunk of input.source) chunks.push(Buffer.from(chunk as Buffer))
    const data = Buffer.concat(chunks)
    if (data.length !== input.bytes) throw new UploadError(`size mismatch: wrote ${data.length} bytes, expected ${input.bytes}`, 'UPLOAD_SIZE_MISMATCH')
    input.verify?.()
    this.put(target, data)
    return { path: target, requestedPath: target, realPath: target, operation: existed ? 'overwrite' : 'create' }
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    this.commands.push({ command, options })
    return {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      code: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      ...this.responder(command, options)
    }
  }
}
