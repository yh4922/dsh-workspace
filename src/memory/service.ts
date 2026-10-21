/*
 * @Description: 作用域记忆 —— 业务层（网关 memory 方法与 scoped_memory 工具共用）
 * @Author: YangHeng
 * @Date: 2026-10-16 19:25:00
 * @FilePath: /dsh-workspace/src/memory/service.ts
 */
import { MemoryStore } from './store.js'
import { ScopeResolver, type RegisteredWorkspace } from './scope.js'
import {
  NO_PROJECT,
  type MemoryCandidate,
  type MemoryEntry,
  type MemoryInput,
  type MemoryOutputs,
  type MemoryOverview,
  type MemoryScope,
  type ProjectSummary,
  type SearchHit,
  type SessionMemoryView
} from '../wire/memory.js'

export interface SessionInfo {
  title: string
  /** null = 无法判断（宿主服务未就绪）。 */
  exists: boolean | null
}

export interface MemoryServiceDeps {
  store: MemoryStore
  scope: ScopeResolver
  /** 会话标题与是否存在（孤儿清理、界面展示）。 */
  sessionInfo(sessionId: string): Promise<SessionInfo>
  /** 远程工作区的主机信息（本机工作区返回 undefined）。 */
  remoteOf(workspacePath: string): ProjectSummary['remote'] | undefined
  /** 可选的后台总结模型。 */
  listModels(): Promise<MemoryOutputs['models']>
  /** 手动整理：立即触发一次后台总结。 */
  reorganize(sessionId: string): Promise<MemoryOutputs['reorganize']>
  isSummarizing(sessionId: string): boolean
  /** 用默认模型为内容生成标题。 */
  suggestTitle(content: string): Promise<string>
}

function titleOf(ws: RegisteredWorkspace): string {
  if (ws.title !== undefined && ws.title.trim() !== '') return ws.title
  const parts = ws.path.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? ws.path
}

/** 关键词搜索：空白分词，全部命中才算（忽略大小写）。 */
export function matchesQuery(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return false
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  get store(): MemoryStore {
    return this.deps.store
  }

  /** 会话层作用域需要先解析所属项目（store 的 projectOf 依赖缓存）。 */
  private async prepare(scope: MemoryScope): Promise<void> {
    if (scope.layer === 'session') await this.deps.scope.ensure(scope.sessionId)
  }

  /** 记下项目标题 / 路径快照：登记丢失后界面仍能认出它。 */
  private async rememberProjects(): Promise<RegisteredWorkspace[]> {
    const list = await this.deps.scope.workspaces()
    for (const ws of list) {
      if (this.deps.store.listProjectIds().includes(ws.id)) {
        const remote = this.deps.remoteOf(ws.path)
        this.deps.store.rememberProject(ws.id, { title: titleOf(ws), path: ws.path, ...(remote !== undefined ? { remote } : {}) })
      }
    }
    return list
  }

  async overview(): Promise<MemoryOverview> {
    const { store } = this.deps
    const registered = await this.rememberProjects()
    const ids = new Set([...registered.map((w) => w.id), ...store.listProjectIds().filter((id) => id !== NO_PROJECT)])
    const projects: ProjectSummary[] = []
    for (const id of ids) {
      const ws = registered.find((w) => w.id === id)
      const meta = store.projectMeta(id)
      const sessions = await this.sessionsOf(id)
      const entryCount = store.list({ layer: 'project', projectId: id }).length
      const path = ws?.path ?? meta?.path ?? ''
      const remote = ws !== undefined ? this.deps.remoteOf(ws.path) : meta?.remote
      projects.push({
        id,
        title: ws !== undefined ? titleOf(ws) : meta?.title ?? id,
        path,
        ...(remote !== undefined ? { remote } : {}),
        unlinked: ws === undefined,
        entryCount,
        sessions
      })
    }
    // 有记忆的排前面，其次按标题
    projects.sort((a, b) => Number(b.entryCount + b.sessions.length > 0) - Number(a.entryCount + a.sessions.length > 0) || a.title.localeCompare(b.title))
    return {
      settings: store.getSettings(),
      globalCount: store.list({ layer: 'global' }).length,
      pendingCount: store.candidates().length,
      projects,
      looseSessions: await this.sessionsOf(NO_PROJECT)
    }
  }

  private async sessionsOf(projectId: string): Promise<ProjectSummary['sessions']> {
    const out: ProjectSummary['sessions'] = []
    for (const s of this.deps.store.listSessions(projectId)) {
      const info = await this.deps.sessionInfo(s.sessionId).catch((): SessionInfo => ({ title: s.sessionId, exists: null }))
      out.push({ sessionId: s.sessionId, title: info.title, entryCount: s.entryCount, exists: info.exists })
    }
    return out
  }

  /**
   * 与某会话所在工作区相关的待审批：本会话提出的、指向本项目的、或由本项目其他会话提出的全局候选。
   * 会话不属于任何项目时只算本会话提出的 —— 其他工作区的候选不该挤进这里的计数。
   */
  async candidatesFor(sessionId: string): Promise<MemoryCandidate[]> {
    const projectId = (await this.deps.scope.ensure(sessionId)).projectId
    const all = this.deps.store.candidates()
    if (projectId === null) return all.filter((c) => c.source.sessionId === sessionId)
    const out: MemoryCandidate[] = []
    for (const c of all) {
      const src = c.source.sessionId
      if (src === sessionId || (c.layer === 'project' && c.projectId === projectId)) out.push(c)
      else if (c.layer === 'global' && src !== undefined && (await this.deps.scope.ensure(src).catch(() => ({ projectId: null }))).projectId === projectId) out.push(c)
    }
    return out
  }

  async sessionView(sessionId: string): Promise<SessionMemoryView> {
    const { store } = this.deps
    const scope = await this.deps.scope.ensure(sessionId)
    const projectId = scope.projectId
    return {
      enabled: store.getSettings().enabled,
      sessionId,
      project: projectId !== null && scope.workspace !== undefined ? { id: projectId, title: titleOf(scope.workspace) } : null,
      session: store.list({ layer: 'session', sessionId }),
      projectEntries: projectId !== null ? store.list({ layer: 'project', projectId }) : [],
      globalEntries: store.list({ layer: 'global' }),
      // 与标签上的数字同口径：本工作区相关的全部待审批，而不只是本会话提出的
      candidates: await this.candidatesFor(sessionId),
      summarizing: this.deps.isSummarizing(sessionId)
    }
  }

  /** 搜索。restrictTo 给定时只搜该会话所属项目（含本项目其他会话）与全局 —— 模型工具用。 */
  async search(query: string, restrictTo?: string): Promise<SearchHit[]> {
    const { store } = this.deps
    const hits: SearchHit[] = []
    const push = (scope: MemoryScope, scopeTitle: string, entries: MemoryEntry[]): void => {
      for (const entry of entries) if (matchesQuery(`${entry.title ?? ''} ${entry.content}`, query)) hits.push({ scope, scopeTitle, entry })
    }
    push({ layer: 'global' }, '全局', store.list({ layer: 'global' }))
    let projectIds: string[]
    if (restrictTo !== undefined) {
      const own = (await this.deps.scope.ensure(restrictTo)).projectId
      projectIds = own === null ? [] : [own]
      if (own === null) push({ layer: 'session', sessionId: restrictTo }, '本会话', store.list({ layer: 'session', sessionId: restrictTo }))
    } else {
      projectIds = store.listProjectIds()
    }
    const registered = await this.deps.scope.workspaces()
    for (const pid of projectIds) {
      const ws = registered.find((w) => w.id === pid)
      const title = pid === NO_PROJECT ? '无项目' : ws !== undefined ? titleOf(ws) : store.projectMeta(pid)?.title ?? pid
      if (pid !== NO_PROJECT) push({ layer: 'project', projectId: pid }, `项目：${title}`, store.list({ layer: 'project', projectId: pid }))
      for (const s of store.listSessions(pid)) {
        push({ layer: 'session', sessionId: s.sessionId }, `会话：${s.sessionId === restrictTo ? '本会话' : s.sessionId}（${title}）`, store.list({ layer: 'session', sessionId: s.sessionId }))
      }
    }
    return hits
  }

  /** 已不存在的会话（只列出宿主明确说不存在的，判断不了的不算）。 */
  async orphans(): Promise<MemoryOutputs['orphans']> {
    const out: MemoryOutputs['orphans'] = []
    for (const pid of this.deps.store.listProjectIds()) {
      for (const s of this.deps.store.listSessions(pid)) {
        const info = await this.deps.sessionInfo(s.sessionId).catch((): SessionInfo => ({ title: '', exists: null }))
        if (info.exists === false) out.push({ sessionId: s.sessionId, projectId: pid, entryCount: s.entryCount })
      }
    }
    return out
  }

  /** 网关入口：按 op 分派。所有用户界面操作的写入者都是 user。 */
  async handle(input: MemoryInput): Promise<MemoryOutputs[MemoryInput['op']]> {
    const { store } = this.deps
    switch (input.op) {
      case 'status': {
        const enabled = store.getSettings().enabled
        // 关闭时不必解析会话所属项目（status 是高频轮询）
        const pending = input.sessionId === undefined || !enabled ? store.candidates() : await this.candidatesFor(input.sessionId)
        return { enabled, pendingCount: pending.length }
      }
      case 'overview':
        return this.overview()
      case 'settings':
        return store.setSettings(input.patch)
      case 'models':
        return this.deps.listModels()
      case 'list':
        await this.prepare(input.scope)
        return store.list(input.scope)
      case 'sessionView':
        return this.sessionView(input.sessionId)
      case 'add':
        await this.prepare(input.scope)
        return store.add(input.scope, input.draft, { by: 'user', ...(input.scope.layer === 'session' ? { sessionId: input.scope.sessionId } : {}) })
      case 'update':
        await this.prepare(input.scope)
        return store.update(input.scope, input.id, input.patch, 'user')
      case 'remove':
        await this.prepare(input.scope)
        store.remove(input.scope, input.id, 'user')
        return { ok: true as const }
      case 'promote': {
        if (input.scope.layer !== 'session') throw new Error('只有会话记忆可以提升。')
        const scope = await this.deps.scope.ensure(input.scope.sessionId)
        return store.promote(input.scope, input.id, input.to, scope.projectId)
      }
      case 'history':
        await this.prepare(input.scope)
        return store.history(input.scope, input.id)
      case 'revert':
        await this.prepare(input.scope)
        return store.revert(input.scope, input.id, input.recordId, 'user')
      case 'trash':
        return store.trash()
      case 'restore':
        return store.restore(input.trashId, 'user').entry
      case 'candidates':
        return store.candidates(input.sessionId !== undefined ? { sessionId: input.sessionId } : {})
      case 'approve':
        return (await this.approve(input.decision)).entry
      case 'reject':
        store.reject(input.id)
        return { ok: true as const }
      case 'approveAll': {
        let count = 0
        // 会话里的「全部通过 / 拒绝」作用于该会话看到的那一批（本工作区相关）
        for (const c of input.sessionId !== undefined ? await this.candidatesFor(input.sessionId) : store.candidates()) {
          try {
            await this.approve({ id: c.id })
            count += 1
          } catch {
            /* 单条失败（如所属项目已不存在）不影响其余，留在待审批里 */
          }
        }
        return { count }
      }
      case 'rejectAll': {
        if (input.sessionId === undefined) return { count: store.rejectAll() }
        const list = await this.candidatesFor(input.sessionId)
        for (const c of list) store.reject(c.id)
        return { count: list.length }
      }
      case 'search':
        return this.search(input.query)
      case 'suggestTitle':
        return { title: await this.deps.suggestTitle(input.content) }
      case 'reorganize':
        return this.deps.reorganize(input.sessionId)
      case 'orphans':
        return this.orphans()
      case 'cleanup': {
        // 只删宿主确认不存在的会话：防止浏览器传错 ID 误删正常会话的记忆
        const orphanIds = new Set((await this.orphans()).map((o) => o.sessionId))
        let removed = 0
        for (const sid of input.sessionIds) {
          if (!orphanIds.has(sid)) continue
          store.deleteSession(sid)
          removed += 1
        }
        return { removed }
      }
    }
  }

  private async approve(decision: { id: string; content?: string; layer?: 'project' | 'global'; importance?: MemoryEntry['importance'] }): Promise<{ scope: MemoryScope; entry: MemoryEntry }> {
    const candidate = this.deps.store.candidates().find((c: MemoryCandidate) => c.id === decision.id)
    let fallback: string | null = null
    if (candidate?.source.sessionId !== undefined) fallback = (await this.deps.scope.ensure(candidate.source.sessionId)).projectId
    return this.deps.store.approve(decision, fallback)
  }
}
