/*
 * @Description: H5 —— 工作区状态（workspace/follow 流 + 置顶 / 归档操作）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:10:00
 * @FilePath: /dsh-workspace/src/mobile/data/workspaces.ts
 *
 * workspace/follow 首帧 baseline（全量），之后是增量帧 upsert / remove / order / archived / pinned，
 * 可见性变化时宿主改发 replace（全量）。宿主 asar 实测帧形状见 applyWorkspaceFrame。
 * 流一旦打开就常驻（首页与会话详情都要工作区名）；mux 重连时宿主会再发一帧 baseline，直接整体替换。
 */
import { useSyncExternalStore } from 'react'
import { openStream } from '../net/mux.js'
import { RpcError, rpc } from '../net/rpc.js'

export interface WorkspaceItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt?: number
  updatedAt?: number
}

export interface WorkspaceState {
  /** 宿主给出的工作区顺序。 */
  items: WorkspaceItem[]
  archivedSessionIds: string[]
  /** 最近置顶的在前。 */
  pinnedSessionIds: string[]
}

export type WorkspaceFrame =
  | { type: 'baseline' | 'replace'; value: Partial<WorkspaceState> }
  | { type: 'upsert'; workspace: WorkspaceItem }
  | { type: 'remove'; workspaceId: string }
  | { type: 'order'; workspaceIds: string[] }
  | { type: 'archived'; archivedSessionIds: string[] }
  | { type: 'pinned'; pinnedSessionIds: string[] }

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function normItem(raw: unknown): WorkspaceItem | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  if (typeof w.workspaceId !== 'string') return undefined
  return {
    workspaceId: w.workspaceId,
    path: typeof w.path === 'string' ? w.path : '',
    title: typeof w.title === 'string' ? w.title : '',
    sessionIds: strs(w.sessionIds),
    ...(typeof w.createdAt === 'number' ? { createdAt: w.createdAt } : {}),
    ...(typeof w.updatedAt === 'number' ? { updatedAt: w.updatedAt } : {})
  }
}

/** 工作区显示名：title 为空时取路径末段。 */
export function workspaceLabel(w: Pick<WorkspaceItem, 'title' | 'path'>): string {
  if (w.title.trim() !== '') return w.title
  const seg = w.path.split(/[\\/]+/).filter(Boolean)
  return seg[seg.length - 1] ?? w.path
}

/**
 * 合并一帧（纯函数）。baseline / replace 全量替换；增量帧需要已有状态，没有则忽略（返回 undefined 保持「未就绪」）。
 * 不认识的帧原样返回旧状态。
 */
export function applyWorkspaceFrame(prev: WorkspaceState | undefined, frame: unknown): WorkspaceState | undefined {
  if (frame === null || typeof frame !== 'object') return prev
  const f = frame as Record<string, unknown>
  if (f.type === 'baseline' || f.type === 'replace') {
    const v = (f.value ?? {}) as Record<string, unknown>
    const items = Array.isArray(v.items) ? v.items.map(normItem).filter((x): x is WorkspaceItem => x !== undefined) : []
    return { items, archivedSessionIds: strs(v.archivedSessionIds), pinnedSessionIds: strs(v.pinnedSessionIds) }
  }
  if (prev === undefined) return prev
  switch (f.type) {
    case 'upsert': {
      const w = normItem(f.workspace)
      if (w === undefined) return prev
      const i = prev.items.findIndex((x) => x.workspaceId === w.workspaceId)
      const items = i < 0 ? [...prev.items, w] : prev.items.map((x, j) => (j === i ? w : x))
      return { ...prev, items }
    }
    case 'remove':
      return { ...prev, items: prev.items.filter((x) => x.workspaceId !== f.workspaceId) }
    case 'order': {
      const order = strs(f.workspaceIds)
      const rank = new Map(order.map((id, i) => [id, i]))
      const items = [...prev.items].sort((a, b) => (rank.get(a.workspaceId) ?? 1e9) - (rank.get(b.workspaceId) ?? 1e9))
      return { ...prev, items }
    }
    case 'archived':
      return { ...prev, archivedSessionIds: strs(f.archivedSessionIds) }
    case 'pinned':
      return { ...prev, pinnedSessionIds: strs(f.pinnedSessionIds) }
    default:
      return prev
  }
}

// ---------------------------------------------------------------- store

interface Snapshot {
  state: WorkspaceState | undefined
  error: RpcError | undefined
}

let snap: Snapshot = { state: undefined, error: undefined }
const listeners = new Set<() => void>()
const reopenListeners = new Set<() => void>()
let started = false

function emit(next: Partial<Snapshot>): void {
  snap = { ...snap, ...next }
  for (const l of [...listeners]) l()
}

function start(): void {
  if (started) return
  started = true
  openStream<unknown>(
    'workspace/follow',
    {},
    {
      onItem: (frame) => {
        const state = applyWorkspaceFrame(snap.state, frame)
        if (state !== snap.state || snap.error !== undefined) emit({ state, error: undefined })
      },
      onError: (error) => {
        started = false
        emit({ error })
      },
      onEnd: () => {
        started = false
      },
      // 重连：保留旧数据直到新 baseline 到达（不闪骨架）。
      onReopen: () => {
        for (const l of [...reopenListeners]) l()
      }
    }
  )
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 当前工作区快照（首次调用即打开 workspace/follow）。 */
export function useWorkspaces(): Snapshot {
  return useSyncExternalStore(subscribe, () => snap)
}

export function getWorkspaces(): WorkspaceState | undefined {
  return snap.state
}

/** 订阅工作区状态变化（非 React 消费方，如 sessions store）。 */
export function subscribeWorkspaces(listener: () => void): () => void {
  return subscribe(listener)
}

/** mux 重连后 workspace/follow 重新 open 时回调（sessions 据此决定是否增量刷新）。 */
export function onWorkspaceReopen(listener: () => void): () => void {
  reopenListeners.add(listener)
  return () => reopenListeners.delete(listener)
}

/** 流报错后重试（例如重新登录后）。 */
export function retryWorkspaces(): void {
  emit({ error: undefined })
  start()
}

// ---------------------------------------------------------------- actions（乐观更新，宿主随后推送 pinned / archived 帧校正）

function optimistic(mut: (s: WorkspaceState) => WorkspaceState): () => void {
  const before = snap.state
  if (before !== undefined) emit({ state: mut(before) })
  return () => {
    if (before !== undefined) emit({ state: before })
  }
}

async function act(endpoint: string, sessionId: string, mut: (s: WorkspaceState) => WorkspaceState): Promise<void> {
  const rollback = optimistic(mut)
  try {
    await rpc<unknown>(endpoint, { request: { sessionId } })
  } catch (error) {
    rollback()
    throw error
  }
}

export function pinSession(sessionId: string): Promise<void> {
  return act('workspace/pinSession', sessionId, (s) => ({ ...s, pinnedSessionIds: [sessionId, ...s.pinnedSessionIds.filter((x) => x !== sessionId)] }))
}

export function unpinSession(sessionId: string): Promise<void> {
  return act('workspace/unpinSession', sessionId, (s) => ({ ...s, pinnedSessionIds: s.pinnedSessionIds.filter((x) => x !== sessionId) }))
}

export function archiveSession(sessionId: string): Promise<void> {
  return act('workspace/archiveSession', sessionId, (s) => ({
    ...s,
    archivedSessionIds: [...s.archivedSessionIds.filter((x) => x !== sessionId), sessionId],
    pinnedSessionIds: s.pinnedSessionIds.filter((x) => x !== sessionId)
  }))
}

/** 新建会话（工作区内），返回 sessionId。 */
export async function createSession(workspaceId: string): Promise<string> {
  const v = await rpc<{ sessionId?: unknown }>('session/create', { request: { workspaceId } })
  if (v === null || typeof v !== 'object' || typeof v.sessionId !== 'string') throw new RpcError('rpc/bad-response', '新建会话返回格式无法识别')
  return v.sessionId
}
