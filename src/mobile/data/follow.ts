/*
 * @Description: H5 会话 —— session/follow 状态机（快照 / 事件 / 流式帧 / 重连合并 / 断档补齐 / 向上分页）与 React hook
 * @Author: YangHeng
 * @Date: 2026-11-19 16:45:00
 * @FilePath: /dsh-workspace/src/mobile/data/follow.ts
 *
 * 协议见 .docs/移动端H5/宿主线协议.md §3 与宿主 dsh-api-session-controller：
 * - 首帧 snapshot{cursor,records,hasMore,projections,assistantStream{revision,activeAttempt?}}；
 * - 之后 {type:'event',event} 与 {type:'assistant-stream',frame}；frame.revision 每帧 +1（start 且 revision=1 表示宿主重启），
 *   不连续说明丢帧，只能重开流拿新快照（resync）；
 * - 断线重连后 mux 自动重新 open，服务端再发一份 snapshot：与已有事件按 seq 合并；新快照窗口与旧数据之间有断档时，
 *   用 session/events{throughSeq,beforeSeq} 从断档末尾往前补齐；补不齐就丢掉断档之前的旧事件（改为可向上分页）。
 * FollowModel 不含网络，便于单测；useSessionFollow 负责接线。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rpc } from '../net/rpc.js'
import { openStream, type StreamHandle } from '../net/mux.js'
import { touchesQuestionProjection } from './questions.js'
import { eventsOf, expandStream, mergeEvents, type LiveAttempt, type TimedChunk, type WireEvent } from './transcript.js'

export interface FollowState {
  /** 首个快照已到。 */
  ready: boolean
  events: WireEvent[]
  /** 更早的事件还没加载（可向上分页）。 */
  hasMore: boolean
  live?: LiveAttempt
  header?: Record<string, unknown>
  projections: Record<string, unknown>
  error?: string
}

export type FollowEffect = { gap?: { from: number; to: number }; resync?: boolean; projectionsStale?: boolean }

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 纯状态机：吃 follow 帧，吐出需要的副作用（补断档 / 重开流 / 刷新投影）。 */
export class FollowModel {
  state: FollowState = { ready: false, events: [], hasMore: false, projections: {} }
  /** 已知最大 durable seq（含）。 */
  cursor = -1
  /** 流帧 revision（每帧 +1）。 */
  revision = 0
  /** 已收到 end committed、等待对应 durable 事件的 seq（到了再收掉 live，避免内容闪一下）。 */
  private settleSeq: number | undefined

  private set(patch: Partial<FollowState>): void {
    this.state = { ...this.state, ...patch }
  }

  private maxSeq(events: readonly WireEvent[]): number {
    return events.length === 0 ? -1 : (events[events.length - 1] as WireEvent).seq
  }

  /** 首帧或重连后的快照。 */
  snapshot(frame: Record<string, unknown>): FollowEffect {
    const incoming = eventsOf(frame.records)
    const snapCursor = Math.max(num(frame.cursor) ?? -1, this.maxSeq(incoming))
    const stream = rec(frame.assistantStream)
    this.revision = num(stream?.revision) ?? 0
    const active = rec(stream?.activeAttempt)
    let live: LiveAttempt | undefined
    if (active !== undefined && typeof active.attemptId === 'string') {
      const nextIndex = num(active.nextIndex) ?? 0
      const chunks: TimedChunk[] = expandStream(Array.isArray(active.stream) ? active.stream : []).slice(0, nextIndex)
      live = {
        attemptId: active.attemptId,
        turn: num(active.turn) ?? 0,
        step: num(active.step) ?? 0,
        startedAfterSeq: num(active.startedAfterSeq) ?? -1,
        nextIndex,
        chunks
      }
    }
    this.settleSeq = undefined
    const projections = rec(rec(frame.projections)?.values) ?? this.state.projections
    const header = rec(frame.header) ?? this.state.header
    const hasMoreSnap = frame.hasMore === true
    const prev = this.state.events
    const effect: FollowEffect = {}
    if (!this.state.ready || prev.length === 0) {
      this.set({ ready: true, events: incoming, hasMore: hasMoreSnap, live, projections, header })
    } else if (incoming.length === 0) {
      this.set({ live, projections, header })
    } else {
      const first = (incoming[0] as WireEvent).seq
      const merged = mergeEvents(prev, incoming)
      const prevFirst = (prev[0] as WireEvent).seq
      // 旧数据比新窗口更早时，「更早还有没有」以旧数据为准；否则以快照为准。
      const hasMore = prevFirst < first ? this.state.hasMore : hasMoreSnap
      this.set({ ready: true, events: merged, hasMore, live, projections, header })
      if (first > this.cursor + 1) effect.gap = { from: this.cursor + 1, to: first - 1 }
    }
    this.cursor = Math.max(this.cursor, snapCursor)
    return effect
  }

  /** 一个 durable 事件。 */
  event(raw: unknown): FollowEffect {
    const [e] = eventsOf([{ type: 'event', event: raw }])
    if (e === undefined) return {}
    const effect: FollowEffect = {}
    if (this.state.ready && e.seq > this.cursor + 1 && this.cursor >= 0) effect.gap = { from: this.cursor + 1, to: e.seq - 1 }
    this.cursor = Math.max(this.cursor, e.seq)
    const patch: Partial<FollowState> = { events: mergeEvents(this.state.events, [e]) }
    const live = this.state.live
    if (live !== undefined) {
      const d = rec(e.data)
      const sameStep = (e.type === 'assistant/message' || e.type === 'assistant/attempt') && num(d?.turn) === live.turn && num(d?.step) === live.step
      if (sameStep || (this.settleSeq !== undefined && e.seq >= this.settleSeq)) {
        patch.live = undefined
        this.settleSeq = undefined
      }
    }
    // 提问转入「可续答」或迟到答复落盘会改 userQuestions 投影，会话页据此显示 / 收起续答卡片。
    if (e.type === 'turn/end' || e.type === 'session/title' || e.type.startsWith('model') || touchesQuestionProjection(e.type, e.data)) effect.projectionsStale = true
    this.set(patch)
    return effect
  }

  /** 一个 assistant-stream 帧。返回 resync 表示需要重开流。 */
  stream(frame: Record<string, unknown>): FollowEffect {
    const revision = num(frame.revision)
    if (revision === undefined) return {}
    const restart = frame.type === 'start' && revision === 1
    if (!restart && revision !== this.revision + 1) {
      this.revision = revision
      return { resync: true }
    }
    this.revision = revision
    const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : ''
    const live = this.state.live
    switch (frame.type) {
      case 'start':
        this.settleSeq = undefined
        this.set({
          live: {
            attemptId,
            turn: num(frame.turn) ?? 0,
            step: num(frame.step) ?? 0,
            startedAfterSeq: num(frame.startedAfterSeq) ?? this.cursor,
            nextIndex: 0,
            chunks: []
          }
        })
        return {}
      case 'chunk': {
        // 不认识的 attempt（错过了 start）：忽略瞬时内容，等它落盘。
        if (live === undefined || live.attemptId !== attemptId) return {}
        if (num(frame.index) !== live.nextIndex) return { resync: true }
        const chunk = rec(frame.chunk)
        if (chunk === undefined) return {}
        this.set({ live: { ...live, nextIndex: live.nextIndex + 1, chunks: [...live.chunks, { time: num(frame.time) ?? 0, chunk: chunk as unknown as TimedChunk['chunk'] }] } })
        return {}
      }
      case 'end': {
        if (live === undefined || live.attemptId !== attemptId) return {}
        const outcome = rec(frame.outcome)
        const seq = num(outcome?.seq)
        if (outcome?.kind !== 'committed' || seq === undefined || this.state.events.some((e) => e.seq === seq)) {
          this.set({ live: undefined })
          this.settleSeq = undefined
        } else this.settleSeq = seq
        return {}
      }
      default:
        return {}
    }
  }

  /** 合并一页补齐 / 更早的事件。older=true 时更新 hasMore。 */
  page(records: unknown, opts: { older?: boolean; hasMore?: boolean } = {}): WireEvent[] {
    const incoming = eventsOf(records)
    const patch: Partial<FollowState> = { events: mergeEvents(this.state.events, incoming) }
    if (opts.older === true) patch.hasMore = opts.hasMore === true
    this.set(patch)
    return incoming
  }

  /** 断档补不齐：丢掉 seq < keepFrom 的旧事件，改为可向上分页。 */
  dropBefore(keepFrom: number): void {
    this.set({ events: this.state.events.filter((e) => e.seq >= keepFrom), hasMore: true })
  }

  setProjections(values: Record<string, unknown>): void {
    this.set({ projections: values })
  }

  setError(message: string | undefined): void {
    this.set({ error: message })
  }

  firstSeq(): number | undefined {
    return this.state.events[0]?.seq
  }
}

// ---------------------------------------------------------------- 网络接线

/** 首屏窗口：最近 3 轮（至少 4 条消息），单页最多 60 条消息。 */
export const TURN_WINDOW = { minMessages: 4, minTurns: 3 } as const
export const PAGE_MAX_MESSAGES = 60
const GAP_MAX_PAGES = 8

interface EventsPage {
  records?: unknown
  hasMore?: boolean
  cursor?: number
}

export interface SessionFollow {
  state: FollowState
  loadOlder(): Promise<void>
  loadingOlder: boolean
  refreshProjections(): void
}

/**
 * 订阅一个会话：快照 + 实时事件 + 流式输出。状态更新按动画帧合并（流式 chunk 很密）。
 */
export function useSessionFollow(sessionId: string): SessionFollow {
  const modelRef = useRef<FollowModel>(new FollowModel())
  const [state, setState] = useState<FollowState>(modelRef.current.state)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadingRef = useRef(false)
  const address = { kind: 'session', sessionId }

  const frameRef = useRef<number | undefined>(undefined)
  const flush = useCallback(() => {
    if (frameRef.current !== undefined) return
    const run = (): void => {
      frameRef.current = undefined
      setState(modelRef.current.state)
    }
    frameRef.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number)
  }, [])

  const projTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refreshProjections = useCallback(() => {
    if (projTimer.current !== undefined) clearTimeout(projTimer.current)
    projTimer.current = setTimeout(() => {
      projTimer.current = undefined
      rpc<{ kind?: string; values?: Record<string, unknown> } | null>('session/projections', { request: { sessionId } })
        .then((v) => {
          if (v?.values !== undefined) {
            modelRef.current.setProjections(v.values)
            flush()
          }
        })
        .catch(() => undefined)
    }, 300)
  }, [sessionId, flush])

  useEffect(() => {
    const model = new FollowModel()
    modelRef.current = model
    setState(model.state)
    let disposed = false
    let handle: StreamHandle | undefined
    let filling = false

    const fillGap = async (gap: { from: number; to: number }): Promise<void> => {
      if (filling) return
      filling = true
      try {
        let before = gap.to + 1
        for (let i = 0; i < GAP_MAX_PAGES && before > gap.from; i++) {
          const page = await rpc<EventsPage>('session/events', {
            request: { address: { kind: 'session', sessionId }, throughSeq: gap.to, beforeSeq: before, maxMessages: PAGE_MAX_MESSAGES }
          })
          if (disposed) return
          const got = model.page(page.records)
          flush()
          const first = got[0]?.seq
          if (first === undefined || page.hasMore !== true) return
          before = first
        }
        if (before > gap.from) {
          model.dropBefore(gap.to + 1)
          flush()
        }
      } catch {
        // 补不齐：保留新窗口，旧的断档前内容丢弃，避免显示错乱。
        if (!disposed) {
          model.dropBefore(gap.to + 1)
          flush()
        }
      } finally {
        filling = false
      }
    }

    const apply = (effect: FollowEffect): void => {
      if (effect.gap !== undefined) void fillGap(effect.gap)
      if (effect.projectionsStale === true) refreshProjections()
      if (effect.resync === true) reopen()
      flush()
    }

    const open = (): void => {
      handle = openStream<Record<string, unknown>>(
        'session/follow',
        { request: { address: { kind: 'session', sessionId }, activate: true, assistantStream: true, maxMessages: PAGE_MAX_MESSAGES, turnWindow: TURN_WINDOW } },
        {
          onItem(value) {
            if (disposed || value === null || typeof value !== 'object') return
            if (value.type === 'snapshot') {
              model.setError(undefined)
              apply(model.snapshot(value))
            } else if (value.type === 'event') apply(model.event(value.event))
            else if (value.type === 'assistant-stream') {
              const f = rec(value.frame)
              if (f !== undefined) apply(model.stream(f))
            }
          },
          onError(error) {
            if (disposed) return
            model.setError(error.message)
            flush()
            // 服务端结束了这条流（例如会话被归档 / 宿主重启）：稍后重开。
            setTimeout(() => {
              if (!disposed) open()
            }, 3000)
          },
          onEnd() {
            if (!disposed) setTimeout(() => !disposed && open(), 1000)
          }
        }
      )
    }

    const reopen = (): void => {
      handle?.close()
      if (!disposed) open()
    }

    open()
    return () => {
      disposed = true
      handle?.close()
      if (frameRef.current !== undefined) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
        frameRef.current = undefined
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const loadOlder = useCallback(async (): Promise<void> => {
    const model = modelRef.current
    const first = model.firstSeq()
    if (loadingRef.current || !model.state.hasMore || first === undefined || first <= 0) return
    loadingRef.current = true
    setLoadingOlder(true)
    try {
      const page = await rpc<EventsPage>('session/events', {
        request: { address, beforeSeq: first, maxMessages: PAGE_MAX_MESSAGES, turnWindow: TURN_WINDOW }
      })
      if (modelRef.current !== model) return
      model.page(page.records, { older: true, hasMore: page.hasMore === true })
      setState(model.state)
    } finally {
      loadingRef.current = false
      setLoadingOlder(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return { state, loadOlder, loadingOlder, refreshProjections }
}
