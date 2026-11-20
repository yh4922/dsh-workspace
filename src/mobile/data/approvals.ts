/*
 * @Description: H5 —— $events 流全局单例：工具审批（approval/request）与 agent 提问（user-questions/request）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:30:00
 * @FilePath: /dsh-workspace/src/mobile/data/approvals.ts
 *
 * 协议见 .docs/移动端H5/宿主线协议.md §3「审批」「提问」：
 * - 订阅 `$events`（args {}），首帧 {type:'ready',clientId}；
 * - {type:'waterfall',event:'approval/request',eventId,agentId,request:{toolName,callId?,reason?,displayReason?}} 入审批表；
 * - {type:'waterfall',event:'user-questions/request',eventId,agentId,request:{questions,wait?}} 入提问表；
 * - {type:'cancel',eventId}（其他端已处理 / 宿主取消）移除；
 * - 答复 POST $events/result {clientId,eventId,outcome}。
 * 宿主只向客户端转发这两种 waterfall（dsh-api-remotes API_REMOTE_FORWARDED_EVENTS）。网关语义（dsh-api-gateway
 * receiveRemoteEventResult）：同一事件发给所有在线答复端，某端回 next 只是撤掉它自己那份投递，
 * 只有「所有端都回了 next」才落到宿主的下一个处理者（提问会因此以 NO_PROVIDER 失败）。
 * 所以：认识的事件必须接管并展示，不能回 next（以前提问被自动 next，手机单独在线时提问直接失败）；
 * 不认识的事件仍回 next —— 不影响桌面端，而不回应则会在其它端都放弃后让宿主一直挂起。
 * 重连后服务端会重发 ready（新 clientId）以及仍待处理的请求，所以重连时清空旧表。
 */
import { useSyncExternalStore } from 'react'
import { rpc } from '../net/rpc.js'
import { openStream, type StreamHandle } from '../net/mux.js'
import { parseQuestions, type Answer, type Question } from './questions.js'

export interface ApprovalItem {
  eventId: string
  toolName: string
  reason?: string
  callId?: string
}

export type ApprovalMap = Record<string, ApprovalItem[]>

export interface QuestionItem {
  eventId: string
  questions: Question[]
  /** 对应 ask_user_question 的工具调用 id（timed / 可续答时才有）。 */
  callId?: string
}

export type QuestionMap = Record<string, QuestionItem[]>

type Listener = () => void

interface Pending extends ApprovalItem {
  sessionId: string
}

interface PendingQuestion extends QuestionItem {
  sessionId: string
}

export interface ApprovalStore {
  /** 处理一个 $events 下行帧；返回需要自动回 next 的 eventId（不认识的 waterfall）。 */
  handle(frame: unknown): { autoNext?: string }
  reset(): void
  remove(eventId: string): void
  clientId(): string | undefined
  snapshot(): ApprovalMap
  questions(): QuestionMap
  subscribe(l: Listener): () => void
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** displayReason 为 {en, 'zh-CN'?, ...} 本地化表（旧版本可能是字符串）。优先中文。 */
function localizedReason(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v)
  if (v === null || typeof v !== 'object') return undefined
  const t = v as Record<string, unknown>
  const zhKey = Object.keys(t).find((k) => k.toLowerCase().startsWith('zh'))
  return (zhKey !== undefined ? str(t[zhKey]) : undefined) ?? str(t.en)
}

/** 纯状态机（不含网络），便于单测。 */
export function createApprovalStore(): ApprovalStore {
  const pending = new Map<string, Pending>()
  const asked = new Map<string, PendingQuestion>()
  const listeners = new Set<Listener>()
  let client: string | undefined
  let snap: ApprovalMap = {}
  let qsnap: QuestionMap = {}

  const emit = (): void => {
    const next: ApprovalMap = {}
    for (const p of pending.values()) {
      const item: ApprovalItem = { eventId: p.eventId, toolName: p.toolName }
      if (p.reason !== undefined) item.reason = p.reason
      if (p.callId !== undefined) item.callId = p.callId
      ;(next[p.sessionId] ??= []).push(item)
    }
    const qnext: QuestionMap = {}
    for (const q of asked.values()) {
      const item: QuestionItem = { eventId: q.eventId, questions: q.questions }
      if (q.callId !== undefined) item.callId = q.callId
      ;(qnext[q.sessionId] ??= []).push(item)
    }
    snap = next
    qsnap = qnext
    for (const l of [...listeners]) l()
  }

  const drop = (id: string): boolean => {
    const a = pending.delete(id)
    const b = asked.delete(id)
    return a || b
  }

  return {
    handle(frame) {
      if (frame === null || typeof frame !== 'object') return {}
      const f = frame as Record<string, unknown>
      if (f.type === 'ready') {
        client = str(f.clientId)
        return {}
      }
      if (f.type === 'cancel') {
        const id = str(f.eventId)
        if (id !== undefined && drop(id)) emit()
        return {}
      }
      if (f.type === 'waterfall') {
        const eventId = str(f.eventId)
        if (eventId === undefined) return {}
        const req = (f.request ?? {}) as Record<string, unknown>
        const sessionId = str(f.agentId) ?? str(req.sessionId) ?? str(req.agentId)
        if (sessionId === undefined) return { autoNext: eventId }
        if (f.event === 'approval/request') {
          const p: Pending = { eventId, sessionId, toolName: str(req.toolName) ?? '工具' }
          const reason = localizedReason(req.displayReason) ?? str(req.reason)
          if (reason !== undefined) p.reason = reason
          const callId = str(req.callId)
          if (callId !== undefined) p.callId = callId
          pending.set(eventId, p)
          emit()
          return {}
        }
        if (f.event === 'user-questions/request') {
          const questions = parseQuestions(req.questions)
          // 解析不出问题（宿主协议变化）时交给其它客户端，别让它们因为我们静默而挂起。
          if (questions === undefined) return { autoNext: eventId }
          const q: PendingQuestion = { eventId, sessionId, questions }
          const wait = req.wait !== null && typeof req.wait === 'object' ? (req.wait as Record<string, unknown>) : undefined
          const callId = str(wait?.callId)
          if (callId !== undefined) q.callId = callId
          asked.set(eventId, q)
          emit()
          return {}
        }
        return { autoNext: eventId }
      }
      return {}
    },
    reset() {
      client = undefined
      if (pending.size > 0 || asked.size > 0) {
        pending.clear()
        asked.clear()
        emit()
      }
    },
    remove(eventId) {
      if (drop(eventId)) emit()
    },
    clientId: () => client,
    snapshot: () => snap,
    questions: () => qsnap,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

const store = createApprovalStore()
let handle: StreamHandle | undefined

function postResult(eventId: string, outcome: object): Promise<unknown> {
  const clientId = store.clientId()
  if (clientId === undefined) return Promise.reject(new Error('审批通道尚未就绪'))
  return rpc('$events/result', { clientId, eventId, outcome })
}

function ensureStream(): void {
  if (handle !== undefined) return
  handle = openStream<unknown>(
    '$events',
    {},
    {
      onItem(value) {
        const { autoNext } = store.handle(value)
        if (autoNext !== undefined) void postResult(autoNext, { kind: 'next' }).catch(() => undefined)
      },
      onReopen() {
        store.reset()
      },
      onError() {
        handle = undefined
        store.reset()
        setTimeout(ensureStream, 3000)
      },
      onEnd() {
        handle = undefined
        store.reset()
        setTimeout(ensureStream, 3000)
      }
    }
  )
}

function subscribe(l: Listener): () => void {
  ensureStream()
  return store.subscribe(l)
}

/** 当前所有待审批请求，按 sessionId 分组。首次使用时建立全局 $events 订阅（不随组件卸载关闭）。 */
export function useApprovals(): ApprovalMap {
  return useSyncExternalStore(subscribe, store.snapshot, store.snapshot)
}

/** 当前所有等待回答的提问（前台 waterfall），按 sessionId 分组。 */
export function useQuestions(): QuestionMap {
  return useSyncExternalStore(subscribe, store.questions, store.questions)
}

/** 答复审批：allow → allowed-once，否则 rejected。成功后本地立即移除。 */
export async function answerApproval(eventId: string, allow: boolean): Promise<void> {
  ensureStream()
  await postResult(eventId, { kind: 'result', value: allow ? 'allowed-once' : 'rejected' })
  store.remove(eventId)
}

/** 答复前台提问（每题一项；跳过 = selected 为空且无 custom）。成功后本地立即移除。 */
export async function answerQuestion(eventId: string, answer: { answers: Answer[] }): Promise<void> {
  ensureStream()
  await postResult(eventId, { kind: 'result', value: answer })
  store.remove(eventId)
}

/** 答复已超时转入「可续答」的提问：宿主把答复作为 user-question-reply 消息注入 agent。 */
export async function answerContinuedQuestion(sessionId: string, callId: string, answer: { answers: Answer[] }): Promise<void> {
  const accepted = await rpc<boolean>('userQuestions/answer', { agentId: sessionId, callId, answer })
  if (accepted === false) throw new Error('该提问已无法回答')
}
