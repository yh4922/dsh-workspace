/*
 * @Description: 远程 Agent 工具的后端接口 + SSH 实现
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/backend.ts
 *
 * 工具逻辑（参数校验、先读后写、输出格式）只依赖这个接口，单测用本地替身，
 * 真机测试用 SSH 实现。P2 的 stdio 加速层也只需再实现一遍本接口。
 */
import type { WorkspaceRuntime } from '../runtime.js'
import { confinedUpload, type ConfinedUploadInput, type ConfinedUploadResult } from '../sftp/confined-upload.js'

export interface RemoteStat {
  type: 'dir' | 'file' | 'symlink' | 'other'
  size: number
  mtimeMs: number
}

export interface RunOptions {
  /** 远程工作目录（POSIX 绝对路径）。 */
  cwd: string
  timeoutMs: number
  /** 每个输出流保留的最大字节数（保留尾部 —— 报错通常在最后）。 */
  maxBytes: number
  signal?: AbortSignal
}

export interface RunResult {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  /** 退出码；被信号终止、超时或中止时为 null。 */
  code: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
}

export interface AgentBackend {
  /** 跟随符号链接的 stat；不存在返回 undefined。 */
  stat(path: string): Promise<RemoteStat | undefined>
  /** 不跟随符号链接的 stat；不存在返回 undefined。 */
  lstat(path: string): Promise<RemoteStat | undefined>
  readBytes(path: string, maxBytes: number): Promise<Buffer>
  /** 原子写入：父目录不存在则创建；保留权限位；符号链接写到真实目标。 */
  writeText(path: string, content: string): Promise<void>
  run(command: string, options: RunOptions): Promise<RunResult>
  /** 受限上传：只写到工作区根（真实路径）之内，不跟随目标处的符号链接（见 sftp/confined-upload.ts）。 */
  upload(input: ConfinedUploadInput): Promise<ConfinedUploadResult>
}

/** 文件版本：大小 + 修改时间（SFTP 的 mtime 精度为秒，同秒内的外部修改检测不到，是协议限制）。 */
export function versionOf(stat: RemoteStat): string {
  return `${stat.size}:${stat.mtimeMs}`
}

/** POSIX shell 单引号转义。 */
export function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ------------------------------------------------------------------ SSH 实现

interface ExecStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: (code: number | null, signal?: string | null) => void): unknown
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  signal?(name: string): unknown
  close(): unknown
}

/** 只保留最后 max 字节的缓冲。 */
class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max && this.chunks.length > 0) {
      this.truncated = true
      const head = this.chunks[0] as Buffer
      const excess = this.size - this.max
      if (head.length <= excess) {
        this.chunks.shift()
        this.size -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.size -= excess
      }
    }
  }
  text(): string {
    // 截断点可能切在多字节字符中间：丢掉开头不完整的 UTF-8 续字节。
    let buf = Buffer.concat(this.chunks)
    if (this.truncated) {
      let skip = 0
      while (skip < 3 && skip < buf.length && ((buf[skip] as number) & 0xc0) === 0x80) skip += 1
      buf = buf.subarray(skip)
    }
    return buf.toString('utf8')
  }
}

export class SshAgentBackend implements AgentBackend {
  constructor(
    private readonly rt: WorkspaceRuntime,
    private readonly hostId: string
  ) {}

  stat(path: string): Promise<RemoteStat | undefined> {
    return this.rt.files.statPath(this.hostId, path)
  }

  lstat(path: string): Promise<RemoteStat | undefined> {
    return this.rt.files.lstatPath(this.hostId, path)
  }

  readBytes(path: string, maxBytes: number): Promise<Buffer> {
    return this.rt.files.readBytes(this.hostId, path, maxBytes)
  }

  async writeText(path: string, content: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    await this.rt.files.mkdirp(this.hostId, parent)
    await this.rt.files.writeText(this.hostId, path, content, undefined)
  }

  async upload(input: ConfinedUploadInput): Promise<ConfinedUploadResult> {
    // 走「file」连接池的 SFTP 会话：大文件上传不拖慢终端与 Agent 的命令通道。
    return await confinedUpload(await this.rt.files.sftp(this.hostId), input)
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    const connection = await this.rt.pool.acquire(this.hostId, 'agent', () => this.rt.resolveHost(this.hostId))
    // 登录 shell（加载 PATH 等环境），优先 bash，精简系统退回 sh。
    // 工作目录不存在时明确报错，而不是在家目录里执行（那可能在错误的地方改文件）。
    const script =
      `cd ${sq(options.cwd)} 2>/dev/null || { echo "workdir not found: ${options.cwd.replace(/["\\$`]/g, '')}" >&2; exit 1; }; ` +
      `if command -v bash >/dev/null 2>&1; then exec bash -lc ${sq(command)}; else exec sh -lc ${sq(command)}; fi`
    return await new Promise<RunResult>((resolve, reject) => {
      connection.raw().exec(script, {}, (err, rawStream) => {
        if (err !== null && err !== undefined) {
          reject(err)
          return
        }
        const stream = rawStream as ExecStream
        const out = new TailBuffer(options.maxBytes)
        const errOut = new TailBuffer(options.maxBytes)
        let timedOut = false
        let aborted = false
        let settled = false
        const stop = (): void => {
          // 先发信号杀进程（OpenSSH 支持时生效），再关通道。
          try {
            stream.signal?.('KILL')
          } catch {
            /* 服务端不支持信号 */
          }
          try {
            stream.close()
          } catch {
            /* 已关闭 */
          }
        }
        const timer = setTimeout(() => {
          timedOut = true
          stop()
        }, options.timeoutMs)
        const onAbort = (): void => {
          aborted = true
          stop()
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted === true) onAbort()

        stream.on('data', (chunk: Buffer) => out.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => errOut.push(chunk))
        stream.on('close', (code: number | null, signal?: string | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve({
            stdout: out.text(),
            stderr: errOut.text(),
            stdoutTruncated: out.truncated,
            stderrTruncated: errOut.truncated,
            code: timedOut || aborted ? null : typeof code === 'number' ? code : null,
            signal: timedOut || aborted ? null : (signal ?? null),
            timedOut,
            aborted
          })
        })
      })
    })
  }
}

export { TailBuffer }
