/*
 * @Description: upload_to_remote —— 把本会话里出现过的附件上传到远程工作区（仅远程会话注册）
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/upload-tool.ts
 *
 * 安全边界（方案文档：.docs/远程工作区/附件上传工具方案.md）：
 *   来源：只接受 attachment_id，且必须被本会话引用；经宿主附件服务读取，内容哈希必须等于 id。
 *         不接受任何本机路径 —— 这个工具不能成为把 ~/.ssh、保险箱等本机文件外传的通道。
 *   目标：只接受相对工作区根的路径；远端按真实路径校验，不跟随目标处的符号链接；受保护目标默认拒绝。
 *   审计：每次调用（成功 / 失败）写一条连接日志，不含文件内容。
 */
import { versionOf } from './backend.js'
import { PREIMAGE_MAX_BYTES } from './preimages.js'
import type { RemoteToolEnv, ToolExec } from './remote-tools.js'
import { UploadError, parseUploadTarget, protectedTargetReason } from './upload-path.js'
import { openSessionAttachment, sessionEventsOf, type AttachmentService } from './upload-source.js'

export const UPLOAD_TOOL_NAME = 'upload_to_remote'
/** 单文件上限（方案 Q5）。 */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024

export interface UploadArgs {
  attachment_id: string
  target_path: string
  overwrite?: boolean
  [key: string]: unknown
}

export interface UploadValue {
  path: string
  relative: string
  bytes: number
  sha256: string
  kind: 'image' | 'file'
  operation: 'create' | 'overwrite'
}

export interface UploadDeps {
  attachments: () => AttachmentService | undefined
  /** 审计日志（连接日志的 agent 分类）。 */
  audit: (level: 'info' | 'warn', message: string) => void
  maxBytes?: number
}

/** 同一会话的上传串行执行：避免模型并发调用把 SFTP 连接池占满。 */
const queues = new Map<string, Promise<unknown>>()
/**
 * 一个上传最多占住队列多久：前一个上传卡在某个 SFTP 请求上不返回时，到时后面的上传照常进行
 * （卡住的那个仍在后台，但不再挡路）。
 */
export const UPLOAD_SLOT_TIMEOUT_MS = 10 * 60_000

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new UploadError('upload aborted', 'ABORT_ERR')
}

/** p 结束、signal 中止或超时，三者先到先返回（不抛错）。 */
function released(p: Promise<unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    // 注意：setTimeout(Infinity) 在 Node 里会被当成 1ms 立即触发，不限时就不设定时器。
    const timer = Number.isFinite(timeoutMs) ? setTimeout(resolve, timeoutMs) : undefined
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
    if (signal?.aborted === true) done()
    p.then(done, done)
  })
}

export function serial<T>(key: string, task: () => Promise<T>, signal?: AbortSignal, slotTimeoutMs = UPLOAD_SLOT_TIMEOUT_MS): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  // 排队等待也要响应中止：前一个卡住时，被中止的调用立即结束，而不是跟着一起挂起。
  const next = released(previous, signal, Number.POSITIVE_INFINITY).then(() => {
    if (signal?.aborted === true) throw abortError(signal)
    return task()
  })
  const slot = released(next, signal, slotTimeoutMs)
  queues.set(key, slot)
  void slot.then(() => {
    if (queues.get(key) === slot) queues.delete(key)
  })
  return next
}

/** 审计日志里的外部输入：转义（换行不能伪造出新的一行）并截断。 */
function quoted(value: unknown): string {
  const text = String(value)
  return JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)
}

/**
 * 执行上传。
 * @throws UploadError 或 RemoteFsError 形状的错误（带 code），文案面向模型
 */
export async function remoteUpload(env: RemoteToolEnv, deps: UploadDeps, args: UploadArgs, exec: ToolExec): Promise<UploadValue> {
  const sessionId = exec.agent?.session.id ?? 'no-session'
  const started = Date.now()
  const describe = `${quoted(args.attachment_id)} → ${quoted(args.target_path)}`
  // 审计写失败不能改写结果：成功时文件已经传上去了，失败时要保留真实的错误原因。
  const audit = (level: 'info' | 'warn', message: string): void => {
    try {
      deps.audit(level, message)
    } catch {
      /* 日志不可用时放弃审计 */
    }
  }
  try {
    const value = await serial(sessionId, () => upload(env, deps, args, exec, sessionId), exec.signal)
    audit(
      'info',
      `Agent 上传附件 ${value.sha256}（${value.kind}，${value.bytes} 字节）→ ${value.path}（${value.operation}，${Date.now() - started}ms，会话 ${sessionId}）`
    )
    return value
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'ERROR'
    audit('warn', `Agent 上传附件被拒绝或失败 [${code}] ${describe}：${quoted((error as Error)?.message ?? String(error))}（会话 ${sessionId}）`)
    throw error
  }
}

async function upload(env: RemoteToolEnv, deps: UploadDeps, args: UploadArgs, exec: ToolExec, sessionId: string): Promise<UploadValue> {
  // 1. 沙箱：本工具的边界是自身约束，danger-full-access 也不放宽；read-only 一律拒绝。
  if (args.sandbox_permissions !== undefined) {
    throw new UploadError('sandbox escalation is not available in remote workspaces; the remote host enforces its own permissions', 'FS_SANDBOX_DENIED')
  }
  if ((await env.sandboxMode(exec)) === 'read-only') {
    throw new UploadError('[sandbox: file access denied under read-only mode] upload_to_remote cannot write to the remote workspace', 'FS_SANDBOX_DENIED')
  }
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new UploadError('overwrite must be a boolean', 'UPLOAD_BAD_ARGS')

  // 2. 目标：本机侧字面校验（不连远端就能拒绝的先拒绝）；家目录点文件要按远端真实路径判断，在远端再做。
  const segments = parseUploadTarget(args.target_path)
  const literalReason = protectedTargetReason(segments)
  if (literalReason !== undefined) {
    throw new UploadError(`refusing to write "${segments.join('/')}": ${literalReason}`, 'UPLOAD_PROTECTED_TARGET')
  }

  // 3. 来源：本会话引用过的附件。
  const service = deps.attachments()
  if (service === undefined) throw new UploadError('no attachment service is mounted in this DSH version', 'UPLOAD_NOT_FOUND')
  const events = sessionEventsOf(exec.agent?.session)
  if (events === undefined) throw new UploadError('cannot read this session history to authorize the attachment', 'UPLOAD_NOT_IN_SESSION')
  const opened = await openSessionAttachment(service, events, args.attachment_id, deps.maxBytes ?? UPLOAD_MAX_BYTES, exec.signal)

  // 4. 远端受限写入：写完核对哈希后才改名生效。
  // 覆盖前的原内容先读进内存，上传真正成功后才记入存档：失败的上传不留下「改过」的记录。
  let previous: { path: string; content: Buffer } | undefined
  const result = await env.backend.upload({
    root: env.binding.remotePath,
    segments,
    source: opened.stream,
    bytes: opened.bytes,
    overwrite: args.overwrite === true,
    signal: exec.signal,
    protect: protectedTargetReason,
    verify: () => opened.verify(),
    beforeOverwrite: async ({ path, realPath }) => {
      try {
        previous = { path, content: await env.backend.readBytes(realPath, PREIMAGE_MAX_BYTES) }
      } catch {
        /* 过大或读取失败：放弃存档，不阻断上传 */
      }
    }
  })
  // 与 write / edit 共用 pre-image（可审查可回退）；新建记为「原先不存在」。
  if (result.operation === 'create') {
    env.preimages.capture(sessionId, { hostId: env.binding.hostId, path: result.path, tool: UPLOAD_TOOL_NAME }, undefined)
  } else if (previous !== undefined) {
    env.preimages.capture(sessionId, { hostId: env.binding.hostId, path: previous.path, tool: UPLOAD_TOOL_NAME }, previous.content)
  }
  // 远端文件变了：广播观察结果，之后 read / edit 这个文件不会因版本过期被拒。
  // 中间段是工作区内链接时，模型原来的写法与真实位置不同：两种写法都登记。
  const after = await env.backend.stat(result.path).catch(() => undefined)
  if (after !== undefined) {
    for (const p of new Set([result.path, result.requestedPath])) {
      env.observe({ targetKey: `ssh://${env.binding.hostId}${p}`, displayPath: p }, { kind: 'present', version: versionOf(after) }, exec)
    }
  }

  const root = env.binding.remotePath.replace(/\/+$/, '') || '/'
  const relative = root === '/' ? result.path.slice(1) : result.path.slice(root.length + 1)
  return { path: result.path, relative, bytes: opened.bytes, sha256: opened.digest(), kind: opened.kind, operation: result.operation }
}

export function renderUpload(value: UploadValue): string {
  return `uploaded ${value.bytes} bytes (${value.kind} ${value.sha256}) → ${value.path} (${value.operation})`
}

/** 工具定义（交给宿主 defineTool）。 */
export function uploadToolDefinition(env: RemoteToolEnv, deps: UploadDeps, guard: (exec: ToolExec) => void): unknown {
  const limitMb = Math.round((deps.maxBytes ?? UPLOAD_MAX_BYTES) / 1024 / 1024)
  return {
    name: UPLOAD_TOOL_NAME,
    description:
      'Upload an image or file that appeared in this conversation (pasted by the user, or produced by a tool such as generate_image / read_image) from this computer to the remote workspace. ' +
      'Identify it by its attachment id (sha256:…); only attachments referenced in this session are allowed, and local file paths are never accepted. ' +
      'Images are uploaded as stored by DSH (possibly re-encoded when attached), not necessarily the byte-identical original. ' +
      `The target must be a path relative to the remote workspace root; it cannot leave the workspace, follow a symbolic link at the target, or write into .git/, .ssh/ or login dotfiles under the home directory. Files are created without execute permission (subject to the remote umask); overwriting replaces the file, so its previous owner and permissions are not kept. Max ${limitMb} MB.`,
    parameters: {
      attachment_id: { type: 'string', required: true, description: 'Attachment id from this conversation, e.g. "sha256:" followed by 64 lowercase hex digits.' },
      target_path: {
        type: 'string',
        required: true,
        description: 'Destination path relative to the remote workspace root, e.g. "public/logo.png". Missing directories are created. Absolute paths and ".." are rejected.'
      },
      overwrite: { type: 'boolean', description: 'Replace the destination if it already exists. Defaults to false.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          relative: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          sha256: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['image', 'file'] },
          operation: { type: 'string', required: true, enum: ['create', 'overwrite'] }
        }
      },
      render: (_args: unknown, value: UploadValue) => [{ type: 'text', text: renderUpload(value) }]
    },
    async execute(args: unknown, exec: unknown) {
      guard(exec as ToolExec)
      return await remoteUpload(env, deps, args as UploadArgs, exec as ToolExec)
    },
    presentCall(args: { attachment_id?: string; target_path?: string }) {
      return { card: 'generic', title: `上传到远端 → ${args.target_path ?? '?'}`, kind: 'edit', rawInput: `${args.attachment_id ?? ''} → ${args.target_path ?? ''}` }
    }
  }
}
