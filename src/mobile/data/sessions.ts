/*
 * @Description: H5 —— 会话摘要（session/list + 工作区反查 + 本地缓存秒开）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:20:00
 * @FilePath: /dsh-workspace/src/mobile/data/sessions.ts
 *
 * session/list 返回 {items:[{sessionId,updatedAt,running,blank,cwd?,parentSessionId?,origin?,projections?:{values:{title}}}]}，
 * 行里没有工作区，用 workspace/follow 的 sessionIds 反查；置顶 / 归档同样来自 workspace/follow。
 *
 * 首屏：localStorage 里上一次的摘要先渲染（秒开），网络数据到达后整体替换。list 从未到达（且无缓存）时保持骨架，
 * 绝不先按工作区顺序排出一份再跳动——排序只认 session.updatedAt。
 * 刷新策略：首次订阅拉一次；之后只在「回到前台 / mux 重连」且距上次刷新 >30s 时再拉，不是每次重连都全量拉。
 */
import { useSyncExternalStore } from 'react'
import { RPC_UNAUTHORIZED, RpcError, rpc } from '../net/rpc.js'
import { getWorkspaces, onWorkspaceReopen, subscribeWorkspaces, workspaceLabel, type WorkspaceState } from './workspaces.js'

export type SessionMeta = {
  sessionId: string
  title: string
  cwd?: string
  workspaceId?: string
  workspaceTitle?: string
  updatedAt: number
  running: boolean
  pinned: boolean
  archived: boolean
}

/** 规整后的 session/list 行（缓存行也用它：cached* 字段在工作区数据未到时兜底）。 */
export interface SessionRow {
  sessionId: string
  title: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  parentSessionId?: string
  cachedWorkspaceId?: string
  cachedWorkspaceTitle?: string
  cachedPinned?: boolean
  cachedArchived?: boolean
}

export const UNTITLED = '未命名会话'
/** 前台恢复 / 重连后，距上次刷新超过它才重新拉 list。 */
export const REFRESH_STALE_MS = 30_000
const CACHE_KEY = 'dshws.m.sessions.v1'
const CACHE_MAX = 80

// ---------------------------------------------------------------- 纯函数（单测覆盖）

function toTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return 0
}

/** 解析 session/list 的返回值（{items} 或裸数组）。坏行丢弃。 */
export function parseSessionList(value: unknown): SessionRow[] {
  const items = Array.isArray(value) ? value : value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : []
  const out: SessionRow[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.sessionId !== 'string') continue
    const proj = r.projections as { values?: { title?: unknown } } | undefined
    const title = typeof proj?.values?.title === 'string' ? proj.values.title : typeof r.title === 'string' ? r.title : ''
    out.push({
      sessionId: r.sessionId,
      title,
      updatedAt: toTime(r.updatedAt),
      running: r.running === true,
      blank: r.blank === true,
      ...(typeof r.cwd === 'string' ? { cwd: r.cwd } : {}),
      ...(typeof r.parentSessionId === 'string' && r.parentSessionId !== '' ? { parentSessionId: r.parentSessionId } : {})
    })
  }
  return out
}

/** 是否出现在首页列表：子代理会话（有 parentSessionId）与空白会话不展示。 */
export function isListable(row: Pick<SessionRow, 'parentSessionId' | 'blank'>): boolean {
  return row.parentSessionId === undefined && !row.blank
}

/** 置顶在前，其余按 updatedAt 倒序；同时间按 id 稳定排序。 */
export function compareSessions(a: SessionMeta, b: SessionMeta): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
}

/** 行 + 工作区 → 摘要（不过滤、不排序）。工作区未到时用缓存字段兜底。 */
export function toMeta(row: SessionRow, ws: WorkspaceState | undefined, index?: Map<string, { id: string; title: string }>): SessionMeta {
  const owner = ws !== undefined ? (index ?? workspaceIndex(ws)).get(row.sessionId) : undefined
  const workspaceId = ws !== undefined ? owner?.id : row.cachedWorkspaceId
  const workspaceTitle = ws !== undefined ? owner?.title : row.cachedWorkspaceTitle
  return {
    sessionId: row.sessionId,
    title: row.title.trim() !== '' ? row.title : UNTITLED,
    ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workspaceTitle !== undefined ? { workspaceTitle } : {}),
    updatedAt: row.updatedAt,
    running: row.running,
    pinned: ws !== undefined ? ws.pinnedSessionIds.includes(row.sessionId) : row.cachedPinned === true,
    archived: ws !== undefined ? ws.archivedSessionIds.includes(row.sessionId) : row.cachedArchived === true
  }
}

/** sessionId → 所属工作区（反查 sessionIds）。 */
export function workspaceIndex(ws: WorkspaceState): Map<string, { id: string; title: string }> {
  const m = new Map<string, { id: string; title: string }>()
  for (const w of ws.items) {
    const title = workspaceLabel(w)
    for (const id of w.sessionIds) if (!m.has(id)) m.set(id, { id: w.workspaceId, title })
  }
  return m
}

/** 首页列表：过滤子代理 / 空白会话后排序（归档的保留并标记，由界面决定是否隐藏）。 */
export function buildSessionList(rows: readonly SessionRow[], ws: WorkspaceState | undefined): SessionMeta[] {
  const index = ws !== undefined ? workspaceIndex(ws) : undefined
  return rows.filter(isListable).map((r) => toMeta(r, ws, index)).sort(compareSessions)
}

/** 合并一次新的 list：新行整体替换（list 是全量）；新行标题为空而旧行有本地改名时保留旧标题。 */
export function mergeRows(prev: readonly SessionRow[], next: readonly SessionRow[]): SessionRow[] {
  const old = new Map(prev.map((r) => [r.sessionId, r]))
  return next.map((r) => {
    const o = old.get(r.sessionId)
    return r.title === '' && o !== undefined && o.title !== '' ? { ...r, title: o.title } : r
  })
}

/** 本地修改一行（改标题、运行态、活跃时间等）；行不存在时补一行（例如刚新建的会话）。 */
export function patchRows(rows: readonly SessionRow[], id: string, partial: Partial<Omit<SessionMeta, 'sessionId'>>): SessionRow[] {
  const apply = (r: SessionRow): SessionRow => ({
    ...r,
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    // 有了新活动就不再是空白会话（否则要等下次 list 才出现在首页）。
    ...(partial.updatedAt !== undefined ? { updatedAt: partial.updatedAt, blank: false } : {}),
    ...(partial.running !== undefined ? { running: partial.running } : {}),
    ...(partial.cwd !== undefined ? { cwd: partial.cwd } : {}),
    ...(partial.workspaceId !== undefined ? { cachedWorkspaceId: partial.workspaceId } : {}),
    ...(partial.workspaceTitle !== undefined ? { cachedWorkspaceTitle: partial.workspaceTitle } : {}),
    ...(partial.pinned !== undefined ? { cachedPinned: partial.pinned } : {}),
    ...(partial.archived !== undefined ? { cachedArchived: partial.archived } : {})
  })
  if (rows.some((r) => r.sessionId === id)) return rows.map((r) => (r.sessionId === id ? apply(r) : r))
  return [...rows, apply({ sessionId: id, title: '', updatedAt: Date.now(), running: false, blank: false })]
}

/** 摘要 → 缓存行（只缓存首页可见的前若干条）。 */
export function toCacheRows(list: readonly SessionMeta[], max = CACHE_MAX): SessionRow[] {
  return list.slice(0, max).map((m) => ({
    sessionId: m.sessionId,
    title: m.title === UNTITLED ? '' : m.title,
    updatedAt: m.updatedAt,
    running: m.running,
    blank: false,
    ...(m.cwd !== undefined ? { cwd: m.cwd } : {}),
    ...(m.workspaceId !== undefined ? { cachedWorkspaceId: m.workspaceId } : {}),
    ...(m.workspaceTitle !== undefined ? { cachedWorkspaceTitle: m.workspaceTitle } : {}),
    cachedPinned: m.pinned,
    cachedArchived: m.archived
  }))
}

/** 登录失效：反代门禁 401，或 HTTP 401/403。 */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  return error.code === RPC_UNAUTHORIZED || error.status === 401 || error.status === 403 || error.code === 'http/401' || error.code === 'http/403'
}

// ---------------------------------------------------------------- store

export interface SessionsSnapshot {
  /** 首页列表（已排序，含 archived 标记）；ready=false 时为空数组。 */
  list: SessionMeta[]
  /** 有可展示数据（网络或缓存）。false 时首页显示骨架。 */
  ready: boolean
  /** 当前列表来自本地缓存（网络数据尚未到达）。 */
  fromCache: boolean
  loading: boolean
  error: RpcError | undefined
}

let rows: SessionRow[] = []
let fromNetwork = false
let fromCache = false
let loading = false
let error: RpcError | undefined
let lastRefresh = 0
let inflight: Promise<void> | undefined
let allMap = new Map<string, SessionMeta>()
let snapshot: SessionsSnapshot = { list: [], ready: false, fromCache: false, loading: false, error: undefined }
const listeners = new Set<() => void>()

function readCache(): SessionRow[] | undefined {
  try {
    const text = localStorage.getItem(CACHE_KEY)
    if (text === null) return undefined
    const v = JSON.parse(text) as { rows?: unknown }
    return Array.isArray(v.rows) ? (v.rows as SessionRow[]).filter((r) => r !== null && typeof r === 'object' && typeof r.sessionId === 'string') : undefined
  } catch {
    return undefined
  }
}

function writeCache(list: readonly SessionMeta[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), rows: toCacheRows(list.filter((m) => !m.archived)) }))
  } catch {
    /* 隐私模式 / 配额满：缓存只是加速，失败无妨 */
  }
}

function rebuild(): void {
  const ws = getWorkspaces()
  const index = ws !== undefined ? workspaceIndex(ws) : undefined
  allMap = new Map(rows.map((r) => [r.sessionId, toMeta(r, ws, index)]))
  const list = rows
    .filter(isListable)
    .map((r) => allMap.get(r.sessionId) as SessionMeta)
    .sort(compareSessions)
  const ready = fromNetwork || fromCache
  snapshot = { list: ready ? list : [], ready, fromCache: fromCache && !fromNetwork, loading, error }
  for (const l of [...listeners]) l()
}

let initialized = false
let lastUnknownKey = ''
function init(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  const cached = readCache()
  if (cached !== undefined && cached.length > 0) {
    rows = cached
    fromCache = true
  }
  subscribeWorkspaces(() => {
    rebuild()
    maybeRefreshForUnknown()
  })
  onWorkspaceReopen(() => {
    if (document.visibilityState === 'visible') refreshIfStale()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshIfStale()
  })
  rebuild()
  void refreshSessions()
}

/** 工作区里出现 list 中没有的会话（别处新建）：补拉一次。同一批未知 id 只拉一次，避免死循环。 */
function maybeRefreshForUnknown(): void {
  const ws = getWorkspaces()
  if (ws === undefined || !fromNetwork || inflight !== undefined) return
  const known = new Set(rows.map((r) => r.sessionId))
  const archived = new Set(ws.archivedSessionIds)
  const unknown = ws.items.flatMap((w) => w.sessionIds).filter((id) => !known.has(id) && !archived.has(id))
  if (unknown.length === 0) return
  const key = unknown.sort().join(',')
  if (key === lastUnknownKey) return
  lastUnknownKey = key
  void refreshSessions()
}

function refreshIfStale(): void {
  if (Date.now() - lastRefresh > REFRESH_STALE_MS) void refreshSessions()
}

/** 拉取 session/list 并合并（并发调用共享同一请求）。失败记入 error，不抛出。 */
export function refreshSessions(): Promise<void> {
  if (inflight !== undefined) return inflight
  lastRefresh = Date.now()
  loading = true
  rebuild()
  inflight = (async () => {
    try {
      const value = await rpc<unknown>('session/list', { _request: {} })
      rows = fromNetwork ? mergeRows(rows, parseSessionList(value)) : parseSessionList(value)
      fromNetwork = true
      error = undefined
    } catch (e) {
      error = e instanceof RpcError ? e : new RpcError('rpc/network', e instanceof Error ? e.message : '加载失败')
    } finally {
      loading = false
      inflight = undefined
      rebuild()
      if (fromNetwork && getWorkspaces() !== undefined) writeCache(snapshot.list)
    }
  })()
  return inflight
}

function subscribe(listener: () => void): () => void {
  init()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 首页用的完整快照。 */
export function useSessions(): SessionsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** 首页列表（已过滤子代理 / 空白会话、已排序；含 archived 标记）。 */
export function useSessionList(): SessionMeta[] {
  return useSyncExternalStore(subscribe, () => snapshot.list)
}

/** 任一会话摘要（含空白 / 子代理会话）；未加载到时 undefined。 */
export function getSessionMeta(id: string): SessionMeta | undefined {
  init()
  return allMap.get(id)
}

export function useSessionMeta(id: string): SessionMeta | undefined {
  return useSyncExternalStore(subscribe, () => allMap.get(id))
}

/** 本地修改摘要（P3 改标题 / 运行态变化后调用），立即反映到首页与缓存。 */
export function patchSessionMeta(id: string, partial: Partial<Omit<SessionMeta, 'sessionId'>>): void {
  init()
  rows = patchRows(rows, id, partial)
  rebuild()
  if (fromNetwork) writeCache(snapshot.list)
}
