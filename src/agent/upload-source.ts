/*
 * @Description: upload_to_remote 的来源解析 —— 只认「本会话引用过」的附件，经宿主附件服务读取并核对哈希
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/upload-source.ts
 *
 * 为什么限定本会话：附件库是全局共享的内容寻址存储，里面有别的会话、别的项目的附件。
 * 只凭 hash 就能读的话，远端文件里的提示注入拿到任一 hash 就能借本工具把它外传。
 * 授权语义与宿主 session.attachment RPC 一致：attachmentId 必须被本会话事件引用。
 *
 * 扫描的载体（2026-09-30 实测本机全部会话日志确认）：
 *   - 宿主声明的内容字段里的 image / file 块（与 dsh-session-log-export 的 collectEventAttachmentRefs 同一套事件类型）
 *   - dsh-imagegen 的 tool/result：图片引用不在内容块里，而在 data.meta.images[]（snake_case 字段）
 * 绝不按路径直接读 ~/.dsh/attachments：宿主布局会变，且会绕过宿主的完整性校验。
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { UploadError } from './upload-path.js'

export const ATTACHMENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/

export interface ImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface FileRef {
  attachmentId: string
  name: string
  bytes: number
}

export type SessionAttachment = { kind: 'image'; ref: ImageRef } | { kind: 'file'; ref: FileRef }

/** 宿主 attachments 服务中本工具用到的部分。 */
export interface AttachmentService {
  readImage(ref: ImageRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>
  readFileStream?(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function imageRefOf(v: unknown): ImageRef | undefined {
  if (!isRec(v) || typeof v.attachmentId !== 'string' || typeof v.mediaType !== 'string') return undefined
  if (!num(v.bytes) || !num(v.width) || !num(v.height)) return undefined
  return {
    attachmentId: v.attachmentId,
    mediaType: v.mediaType,
    bytes: v.bytes,
    width: v.width,
    height: v.height,
    ...(typeof v.name === 'string' ? { name: v.name } : {})
  }
}

function fileRefOf(v: unknown): FileRef | undefined {
  if (!isRec(v) || typeof v.attachmentId !== 'string' || typeof v.name !== 'string' || !num(v.bytes)) return undefined
  return { attachmentId: v.attachmentId, name: v.name, bytes: v.bytes }
}

/** dsh-imagegen 的 meta.images 条目（snake_case）→ 宿主图片引用。 */
function imagegenRefOf(v: unknown): ImageRef | undefined {
  if (!isRec(v)) return undefined
  return imageRefOf({ attachmentId: v.attachment_id, mediaType: v.media_type, bytes: v.bytes, width: v.width, height: v.height, name: v.name })
}

function collectBlocks(content: unknown, out: SessionAttachment[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRec(block)) continue
    if (block.type === 'image') {
      const ref = imageRefOf(block.attachment)
      if (ref !== undefined) out.push({ kind: 'image', ref })
    } else if (block.type === 'file') {
      const ref = fileRefOf(block.attachment)
      if (ref !== undefined) out.push({ kind: 'file', ref })
    }
  }
}

/** 结果里带 meta.images（snake_case）的生图工具（dsh-imagegen）。其他工具的 meta 不认，避免被伪造的引用扩大授权范围。 */
export const IMAGEGEN_TOOLS: ReadonlySet<string> = new Set(['generate_image', 'edit_image', 'get_image_generation_task'])

/** tool/result 对应的调用 id（宿主两种写法：message.source.callId / message.toolCallId）。 */
function resultCallId(message: Rec | undefined): string | undefined {
  const source = isRec(message?.source) ? message.source : undefined
  const id = source?.callId ?? message?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/**
 * 收集一个会话事件里引用的全部附件。只读宿主声明的内容字段，未知事件保持不透明。
 * @param toolNameOf 调用 id → 工具名（来自 tool/call 事件）；只有生图工具结果里的 meta.images 才计入
 */
export function attachmentsInEvent(event: unknown, toolNameOf: (callId: string) => string | undefined = () => undefined): SessionAttachment[] {
  const out: SessionAttachment[] = []
  if (!isRec(event) || !isRec(event.data)) return out
  const data = event.data
  const message = isRec(data.message) ? data.message : undefined
  switch (event.type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      collectBlocks(data.content, out)
      return out
    case 'tool/result': {
      collectBlocks(message?.content, out)
      // dsh-imagegen：生成的图片只以 meta.images 的形式出现在结果里。
      const callId = resultCallId(message)
      const tool = callId === undefined ? undefined : toolNameOf(callId)
      if (tool !== undefined && IMAGEGEN_TOOLS.has(tool) && isRec(data.meta) && Array.isArray(data.meta.images)) {
        for (const item of data.meta.images) {
          const ref = imagegenRefOf(item)
          if (ref !== undefined) out.push({ kind: 'image', ref })
        }
      }
      return out
    }
    case 'system/message':
    case 'developer/message':
    case 'team/message/queued':
      collectBlocks(message?.content, out)
      return out
    case 'agent/inbox/spliced':
      if (Array.isArray(data.inserted)) for (const m of data.inserted) if (isRec(m)) collectBlocks(m.content, out)
      return out
    case 'compaction/summary':
      collectBlocks(data.summary, out)
      collectBlocks(data.rawOutput, out)
      return out
    case 'assistant/message':
      collectBlocks(message?.content, out)
      break
    case 'assistant/attempt':
      break
    default:
      return out
  }
  if (Array.isArray(data.stream)) {
    for (const record of data.stream) {
      if (isRec(record) && record.type === 'chunk' && isRec(record.chunk) && record.chunk.type === 'block-end') {
        collectBlocks([record.chunk.block], out)
      }
    }
  }
  return out
}

/** 在会话事件里按 id 找附件引用；同一 id 取最近一次出现。 */
export function findSessionAttachment(events: readonly unknown[], attachmentId: string): SessionAttachment | undefined {
  // 先建「调用 id → 工具名」表：tool/result 自身不带工具名，要对回 tool/call。
  const names = new Map<string, string>()
  for (const event of events) {
    if (isRec(event) && event.type === 'tool/call' && isRec(event.data) && typeof event.data.callId === 'string' && typeof event.data.name === 'string') {
      names.set(event.data.callId, event.data.name)
    }
  }
  const toolNameOf = (callId: string): string | undefined => names.get(callId)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const hit = attachmentsInEvent(events[i], toolNameOf).find((a) => a.ref.attachmentId === attachmentId)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 取会话事件：宿主 Session 提供 snapshotEvents()（api-session-controller 用法），旧版退回 events 数组。 */
export function sessionEventsOf(session: unknown): readonly unknown[] | undefined {
  if (!isRec(session)) return undefined
  const snapshot = session.snapshotEvents
  if (typeof snapshot === 'function') {
    const events = (snapshot as () => unknown).call(session)
    if (Array.isArray(events)) return events
  }
  return Array.isArray(session.events) ? session.events : undefined
}

export interface OpenedAttachment {
  kind: 'image' | 'file'
  /** 声明的字节数（写入后按此核对）。 */
  bytes: number
  stream: Readable
  /**
   * 流读完后调用：核对实际内容的 sha256 等于 attachmentId。
   * 附件是内容寻址的，这一步不依赖宿主实现，独立证明「传出去的就是这个附件」。
   */
  verify(): void
  /** 已读字节的 sha256（sha256:hex）。 */
  digest(): string
}

/**
 * 解析并打开附件。
 * @throws UploadError（UPLOAD_BAD_ID / UPLOAD_NOT_IN_SESSION / UPLOAD_TOO_LARGE / UPLOAD_NOT_FOUND / UPLOAD_CORRUPT）
 */
export async function openSessionAttachment(
  service: AttachmentService,
  events: readonly unknown[],
  attachmentId: unknown,
  maxBytes: number,
  signal?: AbortSignal
): Promise<OpenedAttachment> {
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw new UploadError(`invalid attachment_id ${JSON.stringify(attachmentId)}: expected "sha256:" followed by 64 lowercase hex digits`, 'UPLOAD_BAD_ID')
  }
  const found = findSessionAttachment(events, attachmentId)
  if (found === undefined) {
    throw new UploadError(
      `attachment ${attachmentId} is not referenced in this session; only images/files that appeared in this conversation can be uploaded`,
      'UPLOAD_NOT_IN_SESSION'
    )
  }
  if (found.ref.bytes > maxBytes) {
    throw new UploadError(`attachment ${attachmentId} is ${found.ref.bytes} bytes, larger than the ${maxBytes}-byte upload limit`, 'UPLOAD_TOO_LARGE')
  }

  const hash = createHash('sha256')
  let source: AsyncIterable<Uint8Array>
  if (found.kind === 'image') {
    const ref = found.ref
    // 用到时才读（整张图读进内存）：目标已存在、受保护等在远端先被拒绝时不白读。
    source = (async function* () {
      let data: Uint8Array
      try {
        data = (await service.readImage(ref, signal)).data
      } catch (error) {
        throw hostError(error, attachmentId)
      }
      yield data
    })()
  } else {
    if (typeof service.readFileStream !== 'function') {
      throw new UploadError('this DSH version cannot read file attachments', 'UPLOAD_NOT_FOUND')
    }
    const iterable = service.readFileStream(found.ref, signal)
    source = (async function* () {
      try {
        for await (const chunk of iterable) yield chunk
      } catch (error) {
        throw hostError(error, attachmentId)
      }
    })()
  }
  const hashed = (async function* () {
    for await (const chunk of source) {
      hash.update(chunk)
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    }
  })()

  let digest: string | undefined
  const finish = (): string => (digest ??= `sha256:${hash.digest('hex')}`)
  return {
    kind: found.kind,
    bytes: found.ref.bytes,
    stream: Readable.from(hashed, { objectMode: false }),
    digest: finish,
    verify() {
      if (finish() !== attachmentId) {
        throw new UploadError(`attachment ${attachmentId} failed integrity verification (content hash ${finish()})`, 'UPLOAD_CORRUPT')
      }
    }
  }
}

/** 宿主 AttachmentError 的 code → 本工具错误码。 */
function hostError(error: unknown, attachmentId: string): unknown {
  const code = (error as { code?: string } | null)?.code
  if (code === 'ATTACHMENT_NOT_FOUND') return new UploadError(`attachment ${attachmentId} is missing from the attachment store`, 'UPLOAD_NOT_FOUND')
  if (code === 'ATTACHMENT_CORRUPT') return new UploadError(`attachment ${attachmentId} failed integrity verification`, 'UPLOAD_CORRUPT')
  return error
}
