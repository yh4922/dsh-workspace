/*
 * @Description: upload_to_remote 来源解析：会话范围授权、三种载体、完整性核对
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/upload-source.test.ts
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { attachmentsInEvent, findSessionAttachment, openSessionAttachment, sessionEventsOf, type AttachmentService } from './upload-source.js'

const idOf = (data: Buffer): string => `sha256:${createHash('sha256').update(data).digest('hex')}`
const IMG = Buffer.from('fake-png-bytes')
const FILE = Buffer.from('hello file')
const IMG_ID = idOf(IMG)
const FILE_ID = idOf(FILE)
const imageRef = { attachmentId: IMG_ID, mediaType: 'image/png', bytes: IMG.length, width: 2, height: 1, name: 'a.png' }
const fileRef = { attachmentId: FILE_ID, name: 'notes.txt', bytes: FILE.length }

/** 真实会话日志里的三种形状（2026-09-30 从本机日志采样）。 */
const events = [
  { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: imageRef }] } },
  { type: 'user/message', data: { content: [{ type: 'file', attachment: fileRef }] } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'gen-1', name: 'generate_image', arguments: {} } },
  {
    type: 'tool/result',
    data: {
      message: { role: 'tool', source: { kind: 'tool', callId: 'gen-1' }, toolCallId: 'gen-1', content: [{ type: 'text', text: '{"task_id":"t"}' }] },
      meta: { images: [{ attachment_id: `sha256:${'b'.repeat(64)}`, media_type: 'image/png', bytes: 5, width: 1, height: 1 }] }
    }
  },
  // 其他工具结果里的 meta.images 不算（可能是伪造的引用）。
  { type: 'tool/call', data: { turn: 1, step: 2, callId: 'mcp-1', name: 'some_mcp_tool', arguments: {} } },
  {
    type: 'tool/result',
    data: {
      message: { role: 'tool', source: { kind: 'tool', callId: 'mcp-1' }, content: [] },
      meta: { images: [{ attachment_id: `sha256:${'d'.repeat(64)}`, media_type: 'image/png', bytes: 5, width: 1, height: 1 }] }
    }
  }
]

function service(overrides: Partial<Record<string, Uint8Array>> = {}): AttachmentService & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readImage(ref) {
      reads.push(ref.attachmentId)
      return { data: overrides[ref.attachmentId] ?? IMG }
    },
    async *readFileStream(ref) {
      reads.push(ref.attachmentId)
      const data = overrides[ref.attachmentId] ?? FILE
      yield data.subarray(0, 3)
      yield data.subarray(3)
    }
  }
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks)
}

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('会话内附件引用扫描', () => {
  it('识别 user 消息的图片 / 文件块与 imagegen 的 meta.images', () => {
    expect(findSessionAttachment(events, IMG_ID)).toEqual({ kind: 'image', ref: imageRef })
    expect(findSessionAttachment(events, FILE_ID)).toEqual({ kind: 'file', ref: fileRef })
    expect(findSessionAttachment(events, `sha256:${'b'.repeat(64)}`)).toMatchObject({ kind: 'image', ref: { mediaType: 'image/png', bytes: 5 } })
  })

  it('meta.images 只认生图工具的结果：其他工具 / 找不到对应 tool/call 的都不算', () => {
    expect(findSessionAttachment(events, `sha256:${'d'.repeat(64)}`)).toBeUndefined()
    const orphan = [events[3]] // 只有 tool/result，没有 tool/call
    expect(findSessionAttachment(orphan, `sha256:${'b'.repeat(64)}`)).toBeUndefined()
  })

  it('assistant 流式 block-end、inbox 插入、compaction 摘要里的引用也算', () => {
    expect(attachmentsInEvent({ type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'block-end', block: { type: 'image', attachment: imageRef } } }] } })).toHaveLength(1)
    expect(attachmentsInEvent({ type: 'agent/inbox/spliced', data: { inserted: [{ content: [{ type: 'image', attachment: imageRef }] }] } })).toHaveLength(1)
    expect(attachmentsInEvent({ type: 'compaction/summary', data: { summary: [{ type: 'file', attachment: fileRef }] } })).toHaveLength(1)
  })

  it('未知事件类型与非声明字段不扫描（与宿主语义一致）', () => {
    expect(attachmentsInEvent({ type: 'custom/thing', data: { content: [{ type: 'image', attachment: imageRef }] } })).toEqual([])
    expect(attachmentsInEvent({ type: 'user/message', data: { other: [{ type: 'image', attachment: imageRef }] } })).toEqual([])
    expect(attachmentsInEvent({ type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: IMG_ID } }] } })).toEqual([])
  })

  it('sessionEventsOf 优先 snapshotEvents()，退回 events', () => {
    expect(sessionEventsOf({ snapshotEvents: () => [1], events: [2] })).toEqual([1])
    expect(sessionEventsOf({ events: [2] })).toEqual([2])
    expect(sessionEventsOf({})).toBeUndefined()
  })
})

describe('openSessionAttachment', () => {
  it('图片：经服务读取，内容哈希与 id 一致', async () => {
    const svc = service()
    const opened = await openSessionAttachment(svc, events, IMG_ID, 1024)
    expect(opened.kind).toBe('image')
    expect(await drain(opened.stream)).toEqual(IMG)
    expect(() => opened.verify()).not.toThrow()
    expect(opened.digest()).toBe(IMG_ID)
    expect(svc.reads).toEqual([IMG_ID])
  })

  it('文件：分块流式读取', async () => {
    const opened = await openSessionAttachment(service(), events, FILE_ID, 1024)
    expect(await drain(opened.stream)).toEqual(FILE)
    expect(() => opened.verify()).not.toThrow()
  })

  it('id 格式不对 → UPLOAD_BAD_ID，且不读取', async () => {
    const svc = service()
    for (const bad of ['sha256:ABC', IMG_ID.toUpperCase(), ` ${IMG_ID}`, 'C:\\Users\\me\\.ssh\\id_rsa', '../x', 42]) {
      expect(await codeOf(openSessionAttachment(svc, events, bad, 1024))).toBe('UPLOAD_BAD_ID')
    }
    expect(svc.reads).toEqual([])
  })

  it('不在本会话 → UPLOAD_NOT_IN_SESSION，且不读取', async () => {
    const svc = service()
    expect(await codeOf(openSessionAttachment(svc, events, `sha256:${'c'.repeat(64)}`, 1024))).toBe('UPLOAD_NOT_IN_SESSION')
    expect(await codeOf(openSessionAttachment(svc, [], IMG_ID, 1024))).toBe('UPLOAD_NOT_IN_SESSION')
    expect(svc.reads).toEqual([])
  })

  it('超过上限 → UPLOAD_TOO_LARGE，且不读取', async () => {
    const svc = service()
    expect(await codeOf(openSessionAttachment(svc, events, IMG_ID, 3))).toBe('UPLOAD_TOO_LARGE')
    expect(svc.reads).toEqual([])
  })

  it('读出的内容与 id 不符 → verify 抛 UPLOAD_CORRUPT', async () => {
    const opened = await openSessionAttachment(service({ [IMG_ID]: Buffer.from('tampered') }), events, IMG_ID, 1024)
    await drain(opened.stream)
    expect(() => opened.verify()).toThrow(expect.objectContaining({ code: 'UPLOAD_CORRUPT' }))
  })

  it('图片用到时才读：打开时不读取，读流时才调用服务', async () => {
    const svc = service()
    const opened = await openSessionAttachment(svc, events, IMG_ID, 1024)
    expect(svc.reads).toEqual([])
    await drain(opened.stream)
    expect(svc.reads).toEqual([IMG_ID])
  })

  it('宿主报对象缺失 / 损坏 → 映射为本工具错误码（在读流时抛出）', async () => {
    const svc: AttachmentService = {
      readImage: async () => {
        throw Object.assign(new Error('missing'), { code: 'ATTACHMENT_NOT_FOUND' })
      }
    }
    const missing = await openSessionAttachment(svc, events, IMG_ID, 1024)
    await expect(drain(missing.stream)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
    const broken: AttachmentService = {
      readImage: async () => ({ data: IMG }),
      async *readFileStream() {
        yield FILE
        throw Object.assign(new Error('bad'), { code: 'ATTACHMENT_CORRUPT' })
      }
    }
    const opened = await openSessionAttachment(broken, events, FILE_ID, 1024)
    await expect(drain(opened.stream)).rejects.toMatchObject({ code: 'UPLOAD_CORRUPT' })
  })
})
