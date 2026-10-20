/*
 * @Description: 作用域记忆的本机存储 —— 条目 / 历史 / 最近删除 / 待选记忆 / 设置
 * @Author: YangHeng
 * @Date: 2026-10-16 18:45:00
 * @FilePath: /dsh-workspace/src/memory/store.ts
 *
 * 目录（根默认 ~/.dsh/workspaces/memory）：
 *   settings.json
 *   global.json
 *   projects/<工作区UUID>/project.json            项目条目 + 标题 / 路径快照
 *   projects/<工作区UUID|_none>/sessions/<会话>.json
 *   candidates.json
 *   history/<作用域键>.jsonl                      只追加
 *   trash.json
 *
 * 所有写都走 mutate()：先落盘当前文件，再追加历史 —— 保证每次修改都能回退。
 * 全部同步 IO：数据量小（每个作用域至多几百条），同步写能让并发写天然串行，不需要锁。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { renameWithRetry } from '../fs-atomic.js'
import { pluginRoot, safeSegment } from '../paths.js'
import {
  DEFAULT_MEMORY_SETTINGS,
  IMPORTANCE,
  MEMORY_SECTIONS,
  MEMORY_TITLE_MAX,
  NO_PROJECT,
  TRASH_RETENTION_DAYS,
  compareEntries,
  normalizeContent,
  scopeKeyOf,
  type Author,
  type CandidateDecision,
  type HistoryOp,
  type HistoryRecord,
  type MemoryCandidate,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryPatch,
  type MemoryScope,
  type MemorySettings,
  type MemorySource,
  type TrashItem
} from '../wire/memory.js'

export function memoryRoot(): string {
  return path.join(pluginRoot(), 'memory')
}

/** 项目元信息快照：宿主登记丢失后，界面仍能显示它原来是哪个目录。 */
export interface ProjectMeta {
  title: string
  path: string
  remote?: { hostId: string; host: string; remotePath: string }
}

interface ScopeFile {
  version: 1
  entries: MemoryEntry[]
  /** 仅项目文件。 */
  meta?: ProjectMeta
  /** 仅会话文件：会话首次写入时所属的项目（迁移 / 孤儿清理用）。 */
  projectId?: string
  /** 仅会话文件：会话标题快照。 */
  title?: string
}

/** 变更通知：作用域键（候选变化用 'candidates'，设置变化用 'settings'）。 */
export type MemoryChange = { key: string; sessionId?: string }

export interface MemoryStoreOptions {
  root?: string
  /** 会话 → 所属项目 ID（null = 不属于任何项目）。由 scope.ts 提供。 */
  projectOf: (sessionId: string) => string | null
  now?: () => number
}

export class MemoryNotFoundError extends Error {
  constructor(what: string) {
    super(`记忆不存在：${what}`)
    this.name = 'MemoryNotFoundError'
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

export class MemoryStore {
  readonly root: string
  private readonly projectOf: (sessionId: string) => string | null
  private readonly now: () => number
  private readonly cache = new Map<string, ScopeFile>()
  /** 会话 → 已存在的会话文件路径（会话所属项目变化后仍能找到旧文件）。 */
  private readonly sessionPaths = new Map<string, string>()
  private readonly listeners = new Set<(change: MemoryChange) => void>()
  private settingsCache: MemorySettings | undefined

  constructor(options: MemoryStoreOptions) {
    this.root = options.root ?? memoryRoot()
    this.projectOf = options.projectOf
    this.now = options.now ?? Date.now
  }

  // ---------------------------------------------------------------- 通知

  subscribe(listener: (change: MemoryChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(change: MemoryChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch {
        /* 监听方出错不影响写入结果 */
      }
    }
  }

  // ---------------------------------------------------------------- 设置

  getSettings(): MemorySettings {
    if (this.settingsCache !== undefined) return this.settingsCache
    const raw = this.readJson<Partial<MemorySettings> & { revision?: number }>(path.join(this.root, 'settings.json'))
    this.settingsCache = normalizeSettings(migrateSettings(raw))
    return this.settingsCache
  }

  setSettings(patch: Partial<MemorySettings>): MemorySettings {
    const next = normalizeSettings({ ...this.getSettings(), ...patch })
    this.writeJson(path.join(this.root, 'settings.json'), { ...next, revision: SETTINGS_REVISION })
    this.settingsCache = next
    this.emit({ key: 'settings' })
    return next
  }

  // ---------------------------------------------------------------- 路径

  private projectDir(projectId: string): string {
    return path.join(this.root, 'projects', safeSegment(projectId))
  }

  /** 会话文件路径：优先已存在的文件（所属项目可能已变），否则按当前归属。 */
  sessionFile(sessionId: string): string {
    const known = this.sessionPaths.get(sessionId)
    if (known !== undefined && existsSync(known)) return known
    const name = `${safeSegment(sessionId)}.json`
    const projectId = this.projectOf(sessionId) ?? NO_PROJECT
    const preferred = path.join(this.projectDir(projectId), 'sessions', name)
    if (existsSync(preferred)) {
      this.sessionPaths.set(sessionId, preferred)
      return preferred
    }
    for (const dir of this.listProjectDirs()) {
      const candidate = path.join(this.root, 'projects', dir, 'sessions', name)
      if (existsSync(candidate)) {
        this.sessionPaths.set(sessionId, candidate)
        return candidate
      }
    }
    return preferred
  }

  private fileOf(scope: MemoryScope): string {
    if (scope.layer === 'global') return path.join(this.root, 'global.json')
    if (scope.layer === 'project') return path.join(this.projectDir(scope.projectId), 'project.json')
    return this.sessionFile(scope.sessionId)
  }

  private listProjectDirs(): string[] {
    const dir = path.join(this.root, 'projects')
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- 读

  private load(scope: MemoryScope): ScopeFile {
    const file = this.fileOf(scope)
    const cached = this.cache.get(file)
    if (cached !== undefined) return cached
    const raw = this.readJson<Partial<ScopeFile>>(file)
    const loaded: ScopeFile = {
      version: 1,
      entries: Array.isArray(raw?.entries) ? raw.entries.filter(isEntryLike).map((e) => normalizeEntry(e, scope.layer)) : [],
      ...(raw?.meta !== undefined ? { meta: raw.meta } : {}),
      ...(typeof raw?.projectId === 'string' ? { projectId: raw.projectId } : {}),
      ...(typeof raw?.title === 'string' ? { title: raw.title } : {})
    }
    this.cache.set(file, loaded)
    return loaded
  }

  /** 列出作用域内全部条目（已排序）。 */
  list(scope: MemoryScope): MemoryEntry[] {
    return [...this.load(scope).entries].sort(compareSessionAware)
  }

  get(scope: MemoryScope, id: string): MemoryEntry {
    const entry = this.load(scope).entries.find((e) => e.id === id)
    if (entry === undefined) throw new MemoryNotFoundError(id)
    return entry
  }

  hasSessionFile(sessionId: string): boolean {
    return existsSync(this.sessionFile(sessionId))
  }

  projectMeta(projectId: string): ProjectMeta | undefined {
    return this.load({ layer: 'project', projectId }).meta
  }

  /** 记录项目标题 / 路径快照（只在变化时写盘）。 */
  rememberProject(projectId: string, meta: ProjectMeta): void {
    const scope: MemoryScope = { layer: 'project', projectId }
    const data = this.load(scope)
    if (JSON.stringify(data.meta) === JSON.stringify(meta)) return
    data.meta = meta
    this.save(scope, data)
  }

  /** 会话标题快照：冷会话取标题要读整份日志，所以在会话活着时顺手记下。只记已有记忆文件的会话。 */
  rememberSessionTitle(sessionId: string, title: string): void {
    if (!this.hasSessionFile(sessionId)) return
    const scope: MemoryScope = { layer: 'session', sessionId }
    const data = this.load(scope)
    if (data.title === title) return
    data.title = title
    this.save(scope, data)
  }

  sessionTitle(sessionId: string): string | undefined {
    if (!this.hasSessionFile(sessionId)) return undefined
    return this.load({ layer: 'session', sessionId }).title
  }

  /** 所有有数据的项目 ID（含 _none）。 */
  listProjectIds(): string[] {
    return this.listProjectDirs()
  }

  /** 某项目目录下有会话文件的会话。 */
  listSessions(projectId: string): Array<{ sessionId: string; entryCount: number }> {
    const dir = path.join(this.projectDir(projectId), 'sessions')
    if (!existsSync(dir)) return []
    const out: Array<{ sessionId: string; entryCount: number }> = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const sessionId = name.slice(0, -'.json'.length)
      const file = path.join(dir, name)
      this.sessionPaths.set(sessionId, file)
      out.push({ sessionId, entryCount: this.load({ layer: 'session', sessionId }).entries.length })
    }
    return out
  }

  // ---------------------------------------------------------------- 写

  add(scope: MemoryScope, draft: MemoryDraft, source: MemorySource): MemoryEntry {
    const content = draft.content.trim()
    if (content === '') throw new Error('记忆内容不能为空。')
    const t = this.now()
    const entry: MemoryEntry = {
      id: `m_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      layer: scope.layer,
      ...(scope.layer === 'session' ? { section: draft.section ?? 'facts' } : {}),
      ...(cleanTitle(draft.title) !== undefined ? { title: cleanTitle(draft.title) as string } : {}),
      content,
      enabled: true,
      pinned: draft.pinned === true,
      importance: draft.importance ?? 'medium',
      ...(scope.layer === 'project' && draft.branches !== undefined && draft.branches.length > 0 ? { branches: cleanBranches(draft.branches) } : {}),
      source,
      createdAt: t,
      updatedAt: t
    }
    this.mutate(scope, source.by, 'create', (data) => {
      data.entries.push(entry)
      return { after: entry }
    })
    return entry
  }

  update(scope: MemoryScope, id: string, patch: MemoryPatch, by: Author): MemoryEntry {
    let result: MemoryEntry | undefined
    this.mutate(scope, by, 'update', (data) => {
      const index = data.entries.findIndex((e) => e.id === id)
      if (index < 0) throw new MemoryNotFoundError(id)
      const before = data.entries[index] as MemoryEntry
      const next: MemoryEntry = { ...before, updatedAt: this.now() }
      if (patch.title !== undefined) {
        const title = cleanTitle(patch.title)
        if (title !== undefined) next.title = title
        else delete next.title
      }
      if (patch.content !== undefined) {
        const content = patch.content.trim()
        if (content === '') throw new Error('记忆内容不能为空。')
        next.content = content
      }
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.pinned !== undefined) next.pinned = patch.pinned
      if (patch.importance !== undefined) next.importance = patch.importance
      if (patch.section !== undefined && scope.layer === 'session') next.section = patch.section
      if (patch.branches !== undefined && scope.layer === 'project') {
        const branches = cleanBranches(patch.branches)
        if (branches.length > 0) next.branches = branches
        else delete next.branches
      }
      data.entries[index] = next
      result = next
      return { before, after: next }
    })
    return result as MemoryEntry
  }

  /** 删除：移入「最近删除」。 */
  remove(scope: MemoryScope, id: string, by: Author): void {
    this.mutate(scope, by, 'delete', (data) => {
      const index = data.entries.findIndex((e) => e.id === id)
      if (index < 0) throw new MemoryNotFoundError(id)
      const [before] = data.entries.splice(index, 1) as [MemoryEntry]
      const trash = this.loadTrash()
      trash.push({
        id: `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        scopeKey: scopeKeyOf(scope),
        ...(scope.layer === 'session' ? { projectId: data.projectId ?? this.projectOf(scope.sessionId) ?? NO_PROJECT } : {}),
        entry: before,
        deletedAt: this.now()
      })
      this.saveTrash(trash)
      return { before }
    })
  }

  /** 会话条目提升到项目 / 全局（用户操作，直接生效）；原条目保留。 */
  promote(scope: MemoryScope, id: string, to: 'project' | 'global', projectId: string | null): MemoryEntry {
    const entry = this.get(scope, id)
    const target: MemoryScope = to === 'global' ? { layer: 'global' } : projectScope(projectId)
    return this.add(target, { ...(entry.title !== undefined ? { title: entry.title } : {}), content: entry.content, importance: entry.importance, pinned: entry.pinned }, { ...entry.source, by: 'user' })
  }

  // ---------------------------------------------------------------- 历史

  private historyFile(scope: MemoryScope): string {
    return path.join(this.root, 'history', `${safeSegment(scopeKeyOf(scope))}.jsonl`)
  }

  history(scope: MemoryScope, entryId: string): HistoryRecord[] {
    const file = this.historyFile(scope)
    if (!existsSync(file)) return []
    const out: HistoryRecord[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as HistoryRecord
        if (record.entryId === entryId) out.push(record)
      } catch {
        /* 坏行跳过：只追加文件被截断时最多丢最后一行 */
      }
    }
    // 文件按写入顺序追加：直接倒序即「新的在前」，同一毫秒内的多次修改也不会乱序
    return out.reverse()
  }

  /** 把条目恢复成某条历史记录里的版本（记录的 after，没有 after 时取 before）。 */
  revert(scope: MemoryScope, entryId: string, recordId: string, by: Author): MemoryEntry {
    const record = this.history(scope, entryId).find((r) => r.id === recordId)
    const version = record?.after ?? record?.before
    if (record === undefined || version === undefined) throw new MemoryNotFoundError(`历史记录 ${recordId}`)
    let result: MemoryEntry | undefined
    this.mutate(scope, by, 'revert', (data) => {
      const index = data.entries.findIndex((e) => e.id === entryId)
      const restored: MemoryEntry = { ...version, updatedAt: this.now() }
      const before = index >= 0 ? data.entries[index] : undefined
      if (index >= 0) data.entries[index] = restored
      else data.entries.push(restored)
      result = restored
      return { ...(before !== undefined ? { before } : {}), after: restored }
    })
    return result as MemoryEntry
  }

  // ---------------------------------------------------------------- 最近删除

  private loadTrash(): TrashItem[] {
    const raw = this.readJson<TrashItem[]>(path.join(this.root, 'trash.json'))
    return Array.isArray(raw) ? raw : []
  }

  private saveTrash(items: TrashItem[]): void {
    this.writeJson(path.join(this.root, 'trash.json'), items)
  }

  /** 最近删除（新的在前）；顺带清掉超过保留期的。 */
  trash(): TrashItem[] {
    const all = this.loadTrash()
    const cutoff = this.now() - TRASH_RETENTION_DAYS * DAY_MS
    const kept = all.filter((t) => t.deletedAt >= cutoff)
    if (kept.length !== all.length) this.saveTrash(kept)
    return kept.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  restore(trashId: string, by: Author): { scope: MemoryScope; entry: MemoryEntry } {
    const items = this.trash()
    const index = items.findIndex((t) => t.id === trashId)
    if (index < 0) throw new MemoryNotFoundError(`已删除条目 ${trashId}`)
    const item = items[index] as TrashItem
    const scope = scopeFromKey(item.scopeKey)
    if (scope.layer === 'session' && item.projectId !== undefined && !this.hasSessionFile(scope.sessionId)) {
      // 会话文件已被清理：按删除时的项目位置重建，而不是按当前归属
      this.sessionPaths.set(scope.sessionId, path.join(this.projectDir(item.projectId), 'sessions', `${safeSegment(scope.sessionId)}.json`))
    }
    const entry: MemoryEntry = { ...item.entry, updatedAt: this.now() }
    this.mutate(scope, by, 'restore', (data) => {
      data.entries = data.entries.filter((e) => e.id !== entry.id)
      data.entries.push(entry)
      return { after: entry }
    })
    items.splice(index, 1)
    this.saveTrash(items)
    return { scope, entry }
  }

  // ---------------------------------------------------------------- 待选记忆

  private loadCandidates(): MemoryCandidate[] {
    const raw = this.readJson<MemoryCandidate[]>(path.join(this.root, 'candidates.json'))
    return Array.isArray(raw) ? raw : []
  }

  private saveCandidates(items: MemoryCandidate[]): void {
    this.writeJson(path.join(this.root, 'candidates.json'), items)
    this.emit({ key: 'candidates' })
  }

  candidates(filter: { sessionId?: string } = {}): MemoryCandidate[] {
    return this.loadCandidates()
      .filter((c) => filter.sessionId === undefined || c.source.sessionId === filter.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 提议一条待选记忆。与已有待选内容相同 → 合并（hits+1）；与目标层已启用条目相同 → 丢弃。
   * @returns 新建或合并后的待选；被丢弃时返回 undefined
   */
  propose(input: { layer: 'project' | 'global'; projectId?: string | null; title?: string; content: string; importance?: Importance; source: MemorySource }): MemoryCandidate | undefined {
    const content = input.content.trim()
    if (content === '') return undefined
    if (input.layer === 'project' && (input.projectId === undefined || input.projectId === null)) {
      throw new Error('当前会话不属于任何已登记的工作区，不能写项目记忆。')
    }
    const key = normalizeContent(content)
    const target: MemoryScope = input.layer === 'global' ? { layer: 'global' } : { layer: 'project', projectId: input.projectId as string }
    if (this.list(target).some((e) => e.enabled && normalizeContent(e.content) === key)) return undefined
    const items = this.loadCandidates()
    const same = items.find((c) => c.layer === input.layer && (c.projectId ?? null) === (input.layer === 'project' ? input.projectId : null) && normalizeContent(c.content) === key)
    if (same !== undefined) {
      same.hits += 1
      this.saveCandidates(items)
      return same
    }
    const candidate: MemoryCandidate = {
      id: `c_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      layer: input.layer,
      ...(input.layer === 'project' ? { projectId: input.projectId as string } : {}),
      ...(cleanTitle(input.title) !== undefined ? { title: cleanTitle(input.title) as string } : {}),
      content,
      importance: input.importance ?? 'medium',
      source: input.source,
      createdAt: this.now(),
      hits: 1
    }
    items.push(candidate)
    this.saveCandidates(items)
    return candidate
  }

  /** 通过（可修改内容 / 层级 / 重要程度）。改到项目层时用 fallbackProjectId（来源会话所属项目）。 */
  approve(decision: CandidateDecision, fallbackProjectId: string | null): { scope: MemoryScope; entry: MemoryEntry } {
    const items = this.loadCandidates()
    const index = items.findIndex((c) => c.id === decision.id)
    if (index < 0) throw new MemoryNotFoundError(`待选记忆 ${decision.id}`)
    const candidate = items[index] as MemoryCandidate
    const layer = decision.layer ?? candidate.layer
    const scope: MemoryScope = layer === 'global' ? { layer: 'global' } : projectScope(candidate.projectId ?? fallbackProjectId)
    const entry = this.add(
      scope,
      { ...(cleanTitle(decision.title ?? candidate.title) !== undefined ? { title: cleanTitle(decision.title ?? candidate.title) as string } : {}), content: decision.content ?? candidate.content, importance: decision.importance ?? candidate.importance },
      candidate.source
    )
    items.splice(index, 1)
    this.saveCandidates(items)
    return { scope, entry }
  }

  reject(id: string): void {
    const items = this.loadCandidates()
    const next = items.filter((c) => c.id !== id)
    if (next.length === items.length) throw new MemoryNotFoundError(`待选记忆 ${id}`)
    this.saveCandidates(next)
  }

  rejectAll(filter: { sessionId?: string } = {}): number {
    const items = this.loadCandidates()
    const next = items.filter((c) => !(filter.sessionId === undefined || c.source.sessionId === filter.sessionId))
    const count = items.length - next.length
    if (count > 0) this.saveCandidates(next)
    return count
  }

  // ---------------------------------------------------------------- 会话生命周期

  /** 分叉：把父会话的会话记忆复制给子会话（子会话已有文件时不动）。 */
  copySession(parentId: string, childId: string): boolean {
    if (this.hasSessionFile(childId) || !this.hasSessionFile(parentId)) return false
    const parent = this.load({ layer: 'session', sessionId: parentId })
    const scope: MemoryScope = { layer: 'session', sessionId: childId }
    const t = this.now()
    const data: ScopeFile = {
      version: 1,
      entries: parent.entries.map((e) => ({ ...e, id: `m_${randomUUID().replace(/-/g, '').slice(0, 16)}`, updatedAt: t })),
      projectId: this.projectOf(childId) ?? NO_PROJECT
    }
    this.save(scope, data)
    return true
  }

  /** 删除整个会话文件（孤儿清理；不进最近删除）。 */
  deleteSession(sessionId: string): number {
    if (!this.hasSessionFile(sessionId)) return 0
    const file = this.sessionFile(sessionId)
    const count = this.load({ layer: 'session', sessionId }).entries.length
    rmSync(file, { force: true })
    this.cache.delete(file)
    this.sessionPaths.delete(sessionId)
    this.emit({ key: `session:${sessionId}`, sessionId })
    return count
  }

  // ---------------------------------------------------------------- 内部

  private mutate(
    scope: MemoryScope,
    by: Author,
    op: HistoryOp,
    fn: (data: ScopeFile) => { before?: MemoryEntry; after?: MemoryEntry }
  ): void {
    const data = this.load(scope)
    // 先在副本上改：fn 抛错时缓存保持原样
    const draft: ScopeFile = { ...data, entries: [...data.entries] }
    const change = fn(draft)
    if (scope.layer === 'session' && draft.projectId === undefined) draft.projectId = this.projectOf(scope.sessionId) ?? NO_PROJECT
    this.save(scope, draft)
    const entryId = change.after?.id ?? change.before?.id
    if (entryId !== undefined) {
      const record: HistoryRecord = {
        id: `h_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        entryId,
        scopeKey: scopeKeyOf(scope),
        op,
        by,
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
        at: this.now()
      }
      const file = this.historyFile(scope)
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    }
  }

  private save(scope: MemoryScope, data: ScopeFile): void {
    const file = this.fileOf(scope)
    this.writeJson(file, data)
    this.cache.set(file, data)
    if (scope.layer === 'session') this.sessionPaths.set(scope.sessionId, file)
    this.emit({ key: scopeKeyOf(scope), ...(scope.layer === 'session' ? { sessionId: scope.sessionId } : {}) })
  }

  private readJson<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined
    try {
      // 去掉 BOM：用户用 Windows 记事本 / PowerShell 5.1 手改过的文件会带上它，JSON.parse 直接失败
      return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T
    } catch {
      // 损坏文件按空处理：下一次写入会覆盖修复（历史文件里仍有全部版本可找回）
      return undefined
    }
  }

  private writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(tmp, file)
  }
}

type Importance = MemoryEntry['importance']

function projectScope(projectId: string | null | undefined): MemoryScope {
  if (projectId === null || projectId === undefined || projectId === NO_PROJECT) {
    throw new Error('当前会话不属于任何已登记的工作区，不能写项目记忆。')
  }
  return { layer: 'project', projectId }
}

/** 会话层按分节顺序，再按通用规则。 */
function compareSessionAware(a: MemoryEntry, b: MemoryEntry): number {
  if (a.section !== undefined && b.section !== undefined && a.section !== b.section) {
    return MEMORY_SECTIONS.indexOf(a.section) - MEMORY_SECTIONS.indexOf(b.section)
  }
  return compareEntries(a, b)
}

export function scopeFromKey(key: string): MemoryScope {
  if (key === 'global') return { layer: 'global' }
  if (key.startsWith('project:')) return { layer: 'project', projectId: key.slice('project:'.length) }
  if (key.startsWith('session:')) return { layer: 'session', sessionId: key.slice('session:'.length) }
  throw new Error(`无法识别的作用域：${key}`)
}

function cleanBranches(branches: string[]): string[] {
  return [...new Set(branches.map((b) => b.trim()).filter((b) => b !== ''))]
}

function isEntryLike(value: unknown): value is MemoryEntry {
  return typeof value === 'object' && value !== null && typeof (value as MemoryEntry).id === 'string' && typeof (value as MemoryEntry).content === 'string'
}

/** 读入时补齐缺省字段（手工编辑过的文件也能用）。 */
/** 标题：压成一行、去首尾空白、截到上限；空 = 无标题。 */
export function cleanTitle(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const flat = title.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TITLE_MAX)
  return flat === '' ? undefined : flat
}

function normalizeEntry(e: MemoryEntry, layer: MemoryEntry['layer']): MemoryEntry {
  const t = typeof e.createdAt === 'number' ? e.createdAt : 0
  return {
    ...e,
    layer,
    enabled: e.enabled !== false,
    pinned: e.pinned === true,
    importance: (IMPORTANCE as readonly string[]).includes(e.importance) ? e.importance : 'medium',
    ...(layer === 'session' ? { section: (MEMORY_SECTIONS as readonly string[]).includes(e.section ?? '') ? e.section : 'facts' } : {}),
    source: typeof e.source === 'object' && e.source !== null ? e.source : { by: 'user' },
    createdAt: t,
    updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : t
  }
}

/**
 * 设置文件版本。2：自动总结默认间隔 3 → 8 轮（3 轮太频繁、会话记忆膨胀）。
 * 旧文件里的 3 几乎都是当时的默认值（保存任一设置会把整份写盘），升级时一并改成新默认；用户改过的其他值保留。
 */
const SETTINGS_REVISION = 2

export function migrateSettings(raw: (Partial<MemorySettings> & { revision?: number }) | undefined): Partial<MemorySettings> | undefined {
  if (raw === undefined || (raw.revision ?? 1) >= SETTINGS_REVISION) return raw
  return raw.summarizeEveryTurns === 3 ? { ...raw, summarizeEveryTurns: DEFAULT_MEMORY_SETTINGS.summarizeEveryTurns } : raw
}

function normalizeSettings(raw: Partial<MemorySettings> | undefined): MemorySettings {
  const every = raw?.summarizeEveryTurns
  const model = raw?.summarizerModel
  return {
    enabled: raw?.enabled === true,
    summarizerModel:
      model !== null && typeof model === 'object' && typeof model.provider === 'string' && typeof model.model === 'string' && model.provider !== '' && model.model !== ''
        ? { provider: model.provider, model: model.model }
        : null,
    summarizeEveryTurns: typeof every === 'number' && Number.isInteger(every) && every >= 1 && every <= 50 ? every : DEFAULT_MEMORY_SETTINGS.summarizeEveryTurns,
    toolEnabled: raw?.toolEnabled !== false
  }
}
