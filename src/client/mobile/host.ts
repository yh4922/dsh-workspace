/*
 * @Description: H5 外壳 —— 宿主客户端服务的结构探测适配层
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/mobile/host.ts
 *
 * 宿主客户端服务没有发布类型，这里只按结构探测本外壳用到的面（与 sidechat/host.ts 同一做法）：
 * - workspaces.list：工作区快照 { items: [{ workspaceId, path, title, sessionIds, createdAt }], archivedSessionIds }
 * - sessions.list：会话快照 { ids, byId: { id, displayTitle, running, blank, updatedAt, origin } }
 * - uiSession.sessionStatus：合成运行状态 Map<id, { running }>；uiSession.adapter.current：当前主会话
 * - uiWorkspace：openSession / startSession / archiveSession
 * - sidebarRight：toggleExpanded / isExpanded
 */
import { isSessionActiveRefusal } from '../sidechat/host.js'

export interface Store<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface WorkspaceItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt?: string
  updatedAt?: string
}

export interface WorkspacesSnapshot {
  items?: WorkspaceItem[]
  archivedSessionIds?: string[]
  phase?: string
}

export interface SessionRow {
  id: string
  displayTitle?: string
  title?: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
  origin?: string
  parentId?: string
}

export interface SessionsSnapshot {
  ids?: string[]
  byId?: Record<string, SessionRow | undefined>
  phase?: string
}

export type StatusSnapshot = Map<string, { running?: boolean }> | undefined

interface HostCtx {
  get(name: string): unknown
}

const fn = (target: unknown, key: string): boolean =>
  typeof target === 'object' && target !== null && typeof (target as Record<string, unknown>)[key] === 'function'

function isStore(value: unknown): value is Store<unknown> {
  return fn(value, 'getSnapshot') && fn(value, 'subscribe')
}

export interface MobileHost {
  workspaces(): Store<WorkspacesSnapshot> | undefined
  sessions(): Store<SessionsSnapshot> | undefined
  status(): Store<StatusSnapshot> | undefined
  current(): Store<{ key?: string } | undefined> | undefined
  openSession(id: string): boolean
  startSession(workspaceId: string): boolean
  rename(id: string, title: string): Promise<void>
  archive(id: string): Promise<'ok' | 'active'>
  toggleRight(): boolean
}

export function createMobileHost(ctx: HostCtx): MobileHost {
  const get = (name: string): unknown => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const listOf = (name: string): unknown => (get(name) as { list?: unknown } | undefined)?.list
  return {
    workspaces: () => {
      const s = listOf('workspaces')
      return isStore(s) ? (s as Store<WorkspacesSnapshot>) : undefined
    },
    sessions: () => {
      const s = listOf('sessions')
      return isStore(s) ? (s as Store<SessionsSnapshot>) : undefined
    },
    status: () => {
      const s = (get('uiSession') as { sessionStatus?: unknown } | undefined)?.sessionStatus
      return isStore(s) ? (s as Store<StatusSnapshot>) : undefined
    },
    current: () => {
      const s = (get('uiSession') as { adapter?: { current?: unknown } } | undefined)?.adapter?.current
      return isStore(s) ? (s as Store<{ key?: string } | undefined>) : undefined
    },
    openSession(id) {
      const ui = get('uiWorkspace')
      if (!fn(ui, 'openSession')) return false
      ;(ui as { openSession(id: string): void }).openSession(id)
      return true
    },
    startSession(workspaceId) {
      const ui = get('uiWorkspace')
      if (!fn(ui, 'startSession')) return false
      ;(ui as { startSession(id: string): void }).startSession(workspaceId)
      return true
    },
    async rename(id, title) {
      const sessions = get('sessions') as
        | {
            using?: (id: string, o: { source: string }, op: (ref: { binding?: { session?: { rename?: (t: string) => Promise<{ ok: boolean; error?: { message?: string } }> } } }) => Promise<void>) => Promise<void>
            manager?: { rename?: (id: string, t: string) => Promise<unknown> }
          }
        | undefined
      // 与宿主侧栏同一做法：using 临时持有会话再改名；没有 using 的旧宿主退回 manager.rename。
      if (typeof sessions?.using === 'function') {
        await sessions.using(id, { source: 'dsh-workspace-h5' }, async (ref) => {
          const session = ref.binding?.session
          if (typeof session?.rename !== 'function') throw new Error('rename unavailable')
          const out = await session.rename(title)
          if (!out.ok) throw new Error(out.error?.message ?? 'rename failed')
        })
        return
      }
      if (typeof sessions?.manager?.rename === 'function') {
        await sessions.manager.rename(id, title)
        return
      }
      throw new Error('rename unavailable')
    },
    async archive(id) {
      // 宿主没有删除会话接口，左侧栏的「移除」就是归档（见 sidechat/host.ts 的说明）。
      for (const name of ['uiWorkspace', 'workspaces']) {
        const svc = get(name)
        if (fn(svc, 'archiveSession')) {
          try {
            await (svc as { archiveSession(id: string, o: object): Promise<void> }).archiveSession(id, {})
            return 'ok'
          } catch (error) {
            if (isSessionActiveRefusal(error)) return 'active'
            throw error
          }
        }
      }
      throw new Error('archive unavailable')
    },
    toggleRight() {
      const right = get('sidebarRight')
      if (!fn(right, 'toggleExpanded')) return false
      try {
        ;(right as { toggleExpanded(): void }).toggleExpanded()
        return true
      } catch {
        // 主区没有会话时宿主命令会抛错
        return false
      }
    }
  }
}

/** 工作区显示名：宿主默认工作区的内部标题换成本地化名称，其余取标题或目录名。 */
export function workspaceName(item: WorkspaceItem, fallbackDefault: string): string {
  if (item.title === 'default-workspace') return fallbackDefault
  if (item.title !== '') return item.title
  const parts = item.path.split(/[\\/]/).filter((s) => s !== '')
  return parts.at(-1) ?? item.path
}

/** 会话是否显示在列表里：隐藏子代理、已归档；空白会话只在它是当前会话时显示（与宿主侧栏一致）。 */
export function visibleSession(row: SessionRow | undefined, archived: ReadonlySet<string>, currentKey: string | undefined): row is SessionRow {
  if (row === undefined) return false
  if (row.origin === 'subagent' || archived.has(row.id)) return false
  if (row.blank === true && row.id !== currentKey) return false
  return true
}

export interface WorkspaceSummary {
  item: WorkspaceItem
  sessions: SessionRow[]
  latest: SessionRow | undefined
  activeAt: number
  running: number
}

/** 汇总每个工作区：可见会话（按活跃倒序）、最近会话、最近活跃时间、运行中数量；工作区按最近活跃倒序。 */
export function summarize(
  ws: WorkspacesSnapshot | undefined,
  ss: SessionsSnapshot | undefined,
  status: StatusSnapshot,
  currentKey: string | undefined
): WorkspaceSummary[] {
  const archived = new Set(ws?.archivedSessionIds ?? [])
  const byId = ss?.byId ?? {}
  const isRunning = (row: SessionRow): boolean => status?.get(row.id)?.running ?? row.running === true
  const out = (ws?.items ?? []).map((item) => {
    const sessions = item.sessionIds
      .map((id) => byId[id])
      .filter((row): row is SessionRow => visibleSession(row, archived, currentKey))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const created = Date.parse(item.createdAt ?? '')
    const activeAt = sessions[0]?.updatedAt ?? (Number.isFinite(created) ? created : 0)
    return { item, sessions, latest: sessions[0], activeAt, running: sessions.filter(isRunning).length }
  })
  return out.sort((a, b) => b.activeAt - a.activeAt)
}

/** 会话属于哪个工作区（会话行上没有 workspaceId，只能用工作区的 sessionIds 反查）。 */
export function workspaceOf(ws: WorkspacesSnapshot | undefined, sessionId: string): WorkspaceItem | undefined {
  return ws?.items?.find((w) => w.sessionIds.includes(sessionId))
}

export function sessionTitle(row: SessionRow | undefined, untitled: string): string {
  const title = row?.displayTitle ?? row?.title ?? ''
  return title !== '' ? title : untitled
}
