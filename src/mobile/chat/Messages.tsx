/*
 * @Description: H5 会话 —— 消息条目渲染：用户气泡、思考块 / 思考中占位、助手文本、工具卡片、上下文注入、交付文件、提示、审批卡片
 * @Author: YangHeng
 * @Date: 2026-11-19 17:10:00
 * @FilePath: /dsh-workspace/src/mobile/chat/Messages.tsx
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { rpc } from '../net/rpc.js'
import type { ApprovalItem } from '../data/approvals.js'
import type { ChatItem, ImageAtt } from '../data/transcript.js'
import { toolDiffs, type FileDiffView } from './diff.js'
import { linkifyText, type FileRef } from './links.js'
import { Icon } from '../icons.js'
import { Markdown } from './Markdown.js'
import { parseArgs, toolSummary } from './tool-summary.js'
import { FileCard, FilesGroup } from './FileCard.js'

/** 折叠态长文本截断阈值（字符）。 */
const CLIP = 3000
/** 上下文注入展开后每条的摘要长度（字符）：注入内容常有上万字（技能目录、工作区指令），手机上只看摘要。 */
const CTX_CLIP = 600

/**
 * 进行中计时（秒），每秒刷新。宿主时间戳来自电脑时钟，与手机时钟可能有偏差，所以从本地首次挂载开始计。
 * @param active 为 false 时停止计时并返回 undefined
 */
function useElapsed(active: boolean): number | undefined {
  const start = useRef<number | undefined>(undefined)
  const [, setTick] = useState(0)
  if (active && start.current === undefined) start.current = Date.now()
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  return active && start.current !== undefined ? Math.floor((Date.now() - start.current) / 1000) : undefined
}

// ---------------------------------------------------------------- 图片（历史图片按需从宿主读取）

const imageCache = new Map<string, Promise<string>>()

function attachmentUrl(sessionId: string, ref: Record<string, unknown>): Promise<string> {
  const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : JSON.stringify(ref)
  let p = imageCache.get(id)
  if (p === undefined) {
    p = rpc<{ data?: string; attachment?: { mediaType?: string } }>('session/attachment', { request: { sessionId, attachment: ref } }).then((v) => {
      const type = v.attachment?.mediaType ?? (typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png')
      if (typeof v.data !== 'string') throw new Error('no data')
      return `data:${type};base64,${v.data}`
    })
    p.catch(() => imageCache.delete(id))
    imageCache.set(id, p)
  }
  return p
}

function Thumb({ sessionId, img }: { sessionId: string; img: ImageAtt }) {
  const [url, setUrl] = useState<string | undefined>(img.url)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (img.url !== undefined || img.ref === undefined) return
    let alive = true
    attachmentUrl(sessionId, img.ref).then(
      (u) => alive && setUrl(u),
      () => alive && setFailed(true)
    )
    return () => {
      alive = false
    }
  }, [sessionId, img.url, img.ref])
  if (url === undefined) return <span className="c-thumb c-thumb-empty">{failed ? <Icon name="image" size={20} /> : null}</span>
  return (
    <a className="c-thumb" href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt={img.name ?? '图片'} />
    </a>
  )
}

// ---------------------------------------------------------------- 条目

function UserBubble({ item, sessionId, onRemove }: { item: Extract<ChatItem, { kind: 'user' }>; sessionId: string; onRemove?: (key: string) => void }) {
  return (
    <div className="c-user" data-pending={item.pending}>
      {item.images.length > 0 || item.files.length > 0 ? (
        <div className="c-user-atts">
          {item.images.map((img, i) => (
            <Thumb key={i} sessionId={sessionId} img={img} />
          ))}
          {item.files.map((f, i) => (
            <FileCard key={`f${i}`} name={f.name} {...(f.bytes !== undefined ? { bytes: f.bytes } : {})} />
          ))}
        </div>
      ) : null}
      {item.text !== '' ? <div className="c-user-text" dangerouslySetInnerHTML={{ __html: linkifyText(item.text) }} /> : null}
      {item.pending !== undefined ? (
        <div className="c-user-state">
          {item.pending === 'sending' ? '发送中…' : item.pending === 'queued' ? '已发送，等待处理' : '发送失败'}
          {item.pending === 'failed' && onRemove !== undefined ? (
            <button type="button" className="c-link-btn" onClick={() => onRemove(item.key)}>
              移除
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Reasoning({ item }: { item: Extract<ChatItem, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false)
  const streaming = item.streaming === true
  const ticking = useElapsed(streaming)
  const done = item.durationMs !== undefined ? Math.max(1, Math.round(item.durationMs / 1000)) : undefined
  // 流式中取「宿主块耗时」与「本地计时」的较大者：空思考块没有 delta，只能靠本地计时让秒数走起来。
  const secs = streaming ? Math.max(done ?? 0, ticking ?? 0) : done
  const empty = item.text.trim() === ''
  return (
    <div className="c-fold" data-open={open} data-status={streaming ? 'running' : undefined}>
      <button type="button" className="c-fold-hd" onClick={() => !empty && setOpen(!open)}>
        <span className="c-caret" data-open={open}>
          <Icon name="chevronRight" size={14} />
        </span>
        <Icon name="lightbulb" size={15} className="c-fold-ic" />
        <span className={streaming ? 'c-fold-label c-shimmer' : 'c-fold-label'}>{streaming ? '思考中…' : '思考过程'}</span>
        {secs !== undefined && secs > 0 ? <span className="c-fold-meta">{secs}s</span> : null}
      </button>
      {open && !empty ? <div className="c-fold-body c-reason">{item.text}</div> : null}
    </div>
  )
}

/** 运行中但还没有可见输出时的占位（等首个 token、工具之间）。 */
function Thinking() {
  const secs = useElapsed(true) ?? 0
  return (
    <div className="c-fold c-thinking" data-status="running">
      <div className="c-fold-hd">
        <span className="c-caret" aria-hidden="true" />
        <Icon name="lightbulb" size={15} className="c-fold-ic" />
        <span className="c-fold-label c-shimmer">思考中…</span>
        {secs > 0 ? <span className="c-fold-meta">{secs}s</span> : null}
      </div>
    </div>
  )
}

/** 上下文注入：默认折叠成一行「上下文注入 · N 项」，展开看每项来源与摘要。 */
function ContextRow({ item }: { item: Extract<ChatItem, { kind: 'context' }> }) {
  const [open, setOpen] = useState(false)
  const labels = [...new Set(item.entries.map((e) => e.label))]
  return (
    <div className="c-fold c-ctx" data-open={open}>
      <button type="button" className="c-fold-hd" onClick={() => setOpen(!open)}>
        <span className="c-caret" data-open={open}>
          <Icon name="chevronRight" size={14} />
        </span>
        <Icon name="paperclip" size={15} className="c-fold-ic" />
        <span className="c-fold-label">
          上下文注入 · {item.entries.length} 项
        </span>
        <span className="c-fold-meta">{labels.slice(0, 3).join(' / ')}{labels.length > 3 ? ' …' : ''}</span>
      </button>
      {open ? (
        <div className="c-fold-body">
          {item.entries.map((e, i) => (
            <div key={i} className="c-ctx-item">
              <span className="c-ctx-label">{e.label}</span>
              <pre className="c-ctx-text">{e.text.length > CTX_CLIP ? `${e.text.slice(0, CTX_CLIP)}…（共 ${e.text.length} 字）` : e.text || '（无文本内容）'}</pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Clipped({ text, className }: { text: string; className: string }) {
  const [full, setFull] = useState(false)
  const shown = full || text.length <= CLIP ? text : `${text.slice(0, CLIP)}…`
  const html = useMemo(() => linkifyText(shown), [shown])
  return (
    <>
      <pre className={className} dangerouslySetInnerHTML={{ __html: html }} />
      {text.length > CLIP ? (
        <button type="button" className="c-link-btn" onClick={() => setFull(!full)}>
          {full ? '收起' : `展开全部（${text.length} 字符）`}
        </button>
      ) : null}
    </>
  )
}

function DiffBlock({ diffs }: { diffs: FileDiffView[] }) {
  const [full, setFull] = useState(false)
  const all = diffs.reduce((n, d) => n + d.lines.length, 0)
  let budget = full ? Infinity : 200
  return (
    <div className="c-diff">
      {diffs.map((d, i) => {
        const lines = d.lines.slice(0, Math.max(0, budget))
        budget -= lines.length
        return (
          <div key={i}>
            {d.path !== undefined && diffs.length > 1 ? <div className="c-diff-path">{d.path}</div> : null}
            <pre>
              {lines.map((l, j) => (
                <span key={j} className={l.kind === '-' ? 'del' : l.kind === '+' ? 'add' : 'ctx'}>
                  {l.kind} {l.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          </div>
        )
      })}
      {all > 200 ? (
        <button type="button" className="c-link-btn" onClick={() => setFull(!full)}>
          {full ? '收起' : `展开全部（${all} 行）`}
        </button>
      ) : null}
    </div>
  )
}

const STATUS_ICON = { ok: 'circleCheck', error: 'circleX', interrupted: 'ban' } as const

function ToolCard({ item, onOpenFile }: { item: Extract<ChatItem, { kind: 'tool' }>; onOpenFile: (ref: FileRef) => void }) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => toolSummary(item.name, item.argsText), [item.name, item.argsText])
  const args = useMemo(() => (open ? parseArgs(item.argsText) : undefined), [open, item.argsText])
  const diffs = useMemo(() => (open ? toolDiffs(item.name, args, item.meta) : undefined), [open, item.name, args, item.meta])
  const pretty = useMemo(() => (args !== undefined ? JSON.stringify(args, null, 2) : item.argsText), [args, item.argsText])
  return (
    <div className="c-tool" data-status={item.status} data-open={open}>
      <div className="c-fold-hd" role="button" tabIndex={0} onClick={() => setOpen(!open)}>
        <span className="c-caret" data-open={open}>
          <Icon name="chevronRight" size={14} />
        </span>
        <b className="c-tool-name">{item.name}</b>
        {summary.text !== '' ? (
          summary.ref !== undefined ? (
            <code
              className="c-tool-arg c-tool-arg-file"
              onClick={(e) => {
                e.stopPropagation()
                onOpenFile(summary.ref as FileRef)
              }}
            >
              {summary.text}
            </code>
          ) : (
            <code className="c-tool-arg">{summary.text}</code>
          )
        ) : null}
        <span className="c-tool-st">{item.status === 'running' ? <i className="c-spin" /> : item.status in STATUS_ICON ? <Icon name={STATUS_ICON[item.status as keyof typeof STATUS_ICON]} size={15} /> : null}</span>
      </div>
      {open ? (
        <div className="c-tool-body">
          {diffs !== undefined ? <DiffBlock diffs={diffs} /> : null}
          {diffs === undefined || item.status === 'error' ? (
            <>
              <div className="c-tool-label">参数</div>
              <Clipped className="c-pre" text={pretty} />
            </>
          ) : null}
          {item.result !== undefined && item.result !== '' && (diffs === undefined || item.status === 'error') ? (
            <>
              <div className="c-tool-label">{item.status === 'error' ? '错误' : '结果'}</div>
              <Clipped className={item.status === 'error' ? 'c-pre c-pre-err' : 'c-pre'} text={item.result} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const ChatEntry = memo(function ChatEntry({
  item,
  sessionId,
  onOpenFile,
  onRemovePending
}: {
  item: ChatItem
  sessionId: string
  onOpenFile: (ref: FileRef) => void
  onRemovePending?: (key: string) => void
}) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} sessionId={sessionId} onRemove={onRemovePending} />
    case 'reasoning':
      return <Reasoning item={item} />
    case 'text':
      return <Markdown text={item.text} streaming={item.streaming} />
    case 'tool':
      return <ToolCard item={item} onOpenFile={onOpenFile} />
    case 'notice':
      return <div className={`c-notice c-notice-${item.tone}`}>{item.text}</div>
    case 'context':
      return <ContextRow item={item} />
    case 'thinking':
      return <Thinking />
    case 'files':
      return <FilesGroup files={item.files} onOpen={(path) => onOpenFile({ path })} />
  }
})

// ---------------------------------------------------------------- 审批

export function ApprovalCard({
  item,
  detail,
  onAnswer
}: {
  item: ApprovalItem
  /** 关联工具调用的主参数（按 callId 查到时显示）。 */
  detail?: string
  onAnswer: (eventId: string, allow: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState<'allow' | 'deny' | undefined>()
  const [err, setErr] = useState<string | undefined>()
  const answer = (allow: boolean): void => {
    if (busy !== undefined) return
    setBusy(allow ? 'allow' : 'deny')
    setErr(undefined)
    onAnswer(item.eventId, allow).catch((e: unknown) => {
      setErr(e instanceof Error ? e.message : '提交失败')
      setBusy(undefined)
    })
  }
  return (
    <div className="c-appr">
      <div className="c-appr-hd">
        <Icon name="triangleAlert" size={16} />
        <span>需要审批</span>
        <b>{item.toolName}</b>
      </div>
      {item.reason !== undefined ? <div className="c-appr-reason">{item.reason}</div> : null}
      {detail !== undefined && detail !== '' ? <code className="c-appr-code">{detail}</code> : null}
      {err !== undefined ? <div className="c-appr-err">{err}</div> : null}
      <div className="c-appr-btns">
        <button type="button" className="c-btn" disabled={busy !== undefined} onClick={() => answer(false)}>
          {busy === 'deny' ? '提交中…' : '拒绝'}
        </button>
        <button type="button" className="c-btn c-btn-pri" disabled={busy !== undefined} onClick={() => answer(true)}>
          {busy === 'allow' ? '提交中…' : '批准'}
        </button>
      </div>
    </div>
  )
}
