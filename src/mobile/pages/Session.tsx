/*
 * @Description: H5 —— 会话详情：顶栏（返回 / 重命名 / 面板）、消息流（流式、分页、折叠）、审批、输入框、底部抽屉
 * @Author: YangHeng
 * @Date: 2026-11-19 17:30:00
 * @FilePath: /dsh-workspace/src/mobile/pages/Session.tsx
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { rpc } from '../net/rpc.js'
import { goBack } from '../router.js'
import { answerApproval, answerContinuedQuestion, answerQuestion, useApprovals, useQuestions } from '../data/approvals.js'
import { useSessionFollow } from '../data/follow.js'
import { continuedQuestions } from '../data/questions.js'
import { patchSessionMeta, UNTITLED, useSessionMeta } from '../data/sessions.js'
import { buildTranscript, isRunning, withThinking, type ChatItem } from '../data/transcript.js'
import { QuestionCard } from '../chat/QuestionCard.js'
import { openSheet, primeSessionCwd, SheetHost } from '../sheet/index.js'
import { ApprovalCard, ChatEntry } from '../chat/Messages.js'
import { Composer, type CatalogModel, type ModelCatalog, type OutgoingPrompt } from '../chat/Composer.js'
import { useKeyboardInset } from '../chat/keyboard.js'
import { resolvePath, type FileRef } from '../chat/links.js'
import { toolSummary } from '../chat/tool-summary.js'
import { Icon } from '../icons.js'

type Pending = Extract<ChatItem, { kind: 'user' }> & { requestId: string }

let catalogPromise: Promise<ModelCatalog> | undefined
function loadCatalog(): Promise<ModelCatalog> {
  catalogPromise ??= rpc<ModelCatalog>('session/modelCatalog', {}).catch((e: unknown) => {
    catalogPromise = undefined
    throw e
  })
  return catalogPromise
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function selectionOf(v: unknown): { provider: string; model: string } | undefined {
  const r = rec(v)
  return typeof r?.provider === 'string' && typeof r.model === 'string' ? { provider: r.provider, model: r.model } : undefined
}

function basename(p: string | undefined): string | undefined {
  if (p === undefined) return undefined
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1]
}

/** 会话页浅色背景：iOS / Android 浏览器状态栏（theme-color）跟着变白，离开时恢复首页的深色。 */
const LIGHT_THEME_COLOR = '#ffffff'
function useLightThemeColor(): void {
  useEffect(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    const saved = metas.map((m) => m.content)
    for (const m of metas) m.content = LIGHT_THEME_COLOR
    return () => metas.forEach((m, i) => (m.content = saved[i] ?? m.content))
  }, [])
}

export function Session({ sessionId }: { sessionId: string }) {
  const meta = useSessionMeta(sessionId)
  const { state, loadOlder, loadingOlder, refreshProjections } = useSessionFollow(sessionId)
  const approvals = useApprovals()[sessionId] ?? []
  const kb = useKeyboardInset()
  useLightThemeColor()
  const cwd = typeof state.header?.cwd === 'string' ? state.header.cwd : meta?.cwd
  useEffect(() => {
    if (cwd !== undefined) primeSessionCwd(sessionId, cwd)
  }, [sessionId, cwd])

  // ------------------------------------------------ 消息
  const transcript = useMemo(() => buildTranscript(state.events, state.live), [state.events, state.live])
  const [pending, setPending] = useState<Pending[]>([])
  useEffect(() => {
    // 宿主已落盘（source.rpcId 对上）的乐观气泡收掉。
    setPending((cur) => (cur.some((p) => transcript.rpcIds.has(p.requestId)) ? cur.filter((p) => !transcript.rpcIds.has(p.requestId)) : cur))
  }, [transcript.rpcIds])

  const derivedRunning = isRunning(state.events)
  const running = state.live !== undefined || (derivedRunning ?? meta?.running ?? false)
  // 刚发出（宿主还没回显 turn/start）也算在等回复，立即给「思考中」占位，而不是等首个 token。
  const awaiting = running || pending.some((p) => p.pending !== 'failed')
  const items: ChatItem[] = useMemo(() => withThinking([...transcript.items, ...pending], awaiting), [transcript.items, pending, awaiting])

  // ------------------------------------------------ 提问：前台等待（$events）+ 超时后可续答（userQuestions 投影）
  const questions = useQuestions()[sessionId] ?? []
  const continued = useMemo(() => {
    const live = new Set(questions.map((q) => q.callId).filter((id) => id !== undefined))
    return continuedQuestions(state.projections.userQuestions).filter((q) => !live.has(q.callId))
  }, [questions, state.projections.userQuestions])

  // ------------------------------------------------ 标题 / 重命名
  const projTitle = typeof state.projections.title === 'string' ? state.projections.title : undefined
  const title = meta !== undefined && meta.title !== '' && meta.title !== UNTITLED ? meta.title : (projTitle ?? meta?.title ?? '会话')
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const commitTitle = (): void => {
    setEditing(false)
    const next = draftTitle.trim()
    if (next === '' || next === title) return
    patchSessionMeta(sessionId, { title: next })
    rpc<{ title?: string }>('session/rename', { request: { sessionId, title: next } })
      .then((v) => {
        if (typeof v?.title === 'string') patchSessionMeta(sessionId, { title: v.title })
        refreshProjections()
      })
      .catch(() => patchSessionMeta(sessionId, { title }))
  }

  const asking = questions.length + continued.length > 0
  const status = approvals.length > 0 || asking ? 'wait' : running ? 'run' : 'idle'
  const subtitle = meta?.workspaceTitle ?? basename(cwd)

  // ------------------------------------------------ 模型
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>()
  const [modelOverride, setModelOverride] = useState<{ provider: string; model: string } | undefined>()
  const [modelBusy, setModelBusy] = useState(false)
  useEffect(() => {
    let alive = true
    loadCatalog().then(
      (c) => alive && setCatalog(c),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])
  const ms = rec(state.projections.modelSelection)
  const currentModel = modelOverride ?? selectionOf(ms?.next) ?? selectionOf(ms?.lastUsed)
  useEffect(() => setModelOverride(undefined), [state.projections.modelSelection])
  const selectModel = (provider: string, m: CatalogModel): void => {
    setModelOverride({ provider, model: m.id })
    setModelBusy(true)
    rpc('session/selectModel', {
      request: { sessionId, provider, model: m.id, ...(m.reasoning?.defaultEffort !== undefined ? { reasoningEffort: m.reasoning.defaultEffort } : {}) }
    })
      .then(() => refreshProjections())
      .catch(() => setModelOverride(undefined))
      .finally(() => setModelBusy(false))
  }

  // ------------------------------------------------ 文件链接
  const openFile = useCallback(
    (ref: FileRef) => openSheet({ tab: 'files', path: resolvePath(ref.path, cwd), ...(ref.line !== undefined ? { line: ref.line } : {}) }),
    [cwd]
  )
  const onListClick = (e: MouseEvent): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.c-fl[data-path]')
    if (el === null) return
    e.preventDefault()
    e.stopPropagation()
    const line = Number(el.dataset.line)
    openFile({ path: el.dataset.path ?? '', ...(Number.isFinite(line) && line > 0 ? { line } : {}) })
  }

  // ------------------------------------------------ 滚动：贴底跟随、上滑分页保持位置
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const anchorRef = useRef<number | undefined>(undefined)
  const firstScroll = useRef(true)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 200 && state.hasMore && !loadingOlder && state.ready) {
      anchorRef.current = el.scrollHeight - el.scrollTop
      void loadOlder().catch(() => (anchorRef.current = undefined))
    }
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (anchorRef.current !== undefined && !loadingOlder) {
      el.scrollTop = el.scrollHeight - anchorRef.current
      anchorRef.current = undefined
      return
    }
    if (stickRef.current || firstScroll.current) {
      el.scrollTop = el.scrollHeight
      if (state.ready && items.length > 0) firstScroll.current = false
    }
  }, [items, approvals.length, questions.length, continued.length, loadingOlder, state.ready, kb])

  // ------------------------------------------------ 发送 / 停止
  const onSending = (p: OutgoingPrompt): void => {
    stickRef.current = true
    setPending((cur) => [...cur, { kind: 'user', key: `p${p.requestId}`, seq: Number.MAX_SAFE_INTEGER, requestId: p.requestId, text: p.text, images: p.images, files: p.files, pending: 'sending' }])
  }
  const onSent = (requestId: string, ok: boolean): void => {
    setPending((cur) => cur.map((p) => (p.requestId === requestId ? { ...p, pending: ok ? 'queued' : 'failed' } : p)))
  }
  const removePending = useCallback((key: string) => setPending((cur) => cur.filter((p) => p.key !== key)), [])
  const stop = async (): Promise<void> => {
    await rpc('session/cancel', { request: { sessionId } })
  }

  const toolByCall = useMemo(() => {
    const m = new Map<string, string>()
    for (const it of transcript.items) if (it.kind === 'tool') m.set(it.callId, toolSummary(it.name, it.argsText).text)
    return m
  }, [transcript.items])

  return (
    <div className="m-page c-page m-light" style={kb > 0 ? { paddingBottom: kb } : undefined}>
      <header className="m-bar">
        <button type="button" className="m-icon-btn c-back" aria-label="返回" onClick={goBack}>
          <Icon name="chevronLeft" size={22} />
        </button>
        <div className="m-bar-title">
          {editing ? (
            <input
              className="c-title-input"
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                else if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <b
              onClick={() => {
                setDraftTitle(title)
                setEditing(true)
              }}
            >
              {title}
            </b>
          )}
          <small>
            <span className={`c-st c-st-${status}`}>
              <i className="m-dot" data-pulse={status === 'run' ? 'true' : undefined} />
              {status === 'wait' ? (approvals.length > 0 ? '待审批' : '待回答') : status === 'run' ? '运行中' : '空闲'}
            </span>
            {subtitle !== undefined ? <span className="c-sub">{subtitle}</span> : null}
          </small>
        </div>
        {/* 顶栏与画布同色，按钮去掉方框只留图标，避免顶栏比内容更抢眼 */}
        <button type="button" className="m-icon-btn" aria-label="面板" onClick={() => openSheet({ tab: 'files' })}>
          <Icon name="panelBottom" size={18} />
        </button>
      </header>

      <main ref={scrollRef} className="c-scroll" onScroll={onScroll} onClick={onListClick}>
        {state.hasMore ? <div className="c-more">{loadingOlder ? '加载中…' : '上滑加载更早消息'}</div> : null}
        {!state.ready ? (
          <div className="c-skel">
            <i style={{ width: '60%', marginLeft: 'auto' }} />
            <i style={{ width: '90%' }} />
            <i style={{ width: '75%' }} />
          </div>
        ) : items.length === 0 ? (
          <p className="m-placeholder">还没有消息，发一条开始吧。</p>
        ) : null}
        {items.map((it) => (
          <ChatEntry key={it.key} item={it} sessionId={sessionId} onOpenFile={openFile} onRemovePending={removePending} />
        ))}
        {approvals.map((a) => (
          <ApprovalCard key={a.eventId} item={a} detail={a.callId !== undefined ? toolByCall.get(a.callId) : undefined} onAnswer={answerApproval} />
        ))}
        {questions.map((q) => (
          <QuestionCard key={q.eventId} stateKey={q.callId ?? q.eventId} questions={q.questions} onSubmit={(answer) => answerQuestion(q.eventId, answer)} />
        ))}
        {continued.map((q) => (
          <QuestionCard key={`c${q.callId}`} stateKey={q.callId} questions={q.questions} hint="等待已超时，agent 继续工作中；现在回答仍会送达" onSubmit={(answer) => answerContinuedQuestion(sessionId, q.callId, answer).then(refreshProjections)} />
        ))}
        {state.error !== undefined ? <div className="c-notice c-notice-error">连接异常：{state.error}</div> : null}
      </main>

      <Composer
        sessionId={sessionId}
        running={running}
        onSending={onSending}
        onSent={onSent}
        onStop={stop}
        onFocus={() => {
          stickRef.current = true
        }}
        model={{ catalog, current: currentModel, onSelect: selectModel, busy: modelBusy }}
      />
      <SheetHost sessionId={sessionId} />
    </div>
  )
}
