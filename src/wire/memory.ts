/*
 * @Description: 作用域记忆 —— 宿主与浏览器共享的类型与常量（不依赖 zod / node:）
 * @Author: YangHeng
 * @Date: 2026-10-16 18:40:00
 * @FilePath: /dsh-workspace/src/wire/memory.ts
 *
 * 三层记忆：会话（固定 7 个分节下的条目）/ 项目（宿主工作区 UUID）/ 全局。
 * 会话层由助手直接写；项目与全局经「待选记忆」审批后生效；用户手动新增的直接生效。
 */

export const MEMORY_LAYERS = ['session', 'project', 'global'] as const
export type MemoryLayer = (typeof MEMORY_LAYERS)[number]

/** 会话记忆的固定分节（顺序即展示与注入顺序）。 */
export const MEMORY_SECTIONS = ['goal', 'constraints', 'decisions', 'progress', 'facts', 'rejected', 'questions'] as const
export type MemorySection = (typeof MEMORY_SECTIONS)[number]

/** 分节中文名（注入文本与界面共用）。 */
export const SECTION_LABELS: Record<MemorySection, string> = {
  goal: '目标',
  constraints: '约束与用户纠正',
  decisions: '已定决策',
  progress: '进度',
  facts: '关键事实',
  rejected: '已排除方案',
  questions: '待确认问题'
}

export const IMPORTANCE = ['high', 'medium', 'low'] as const
export type Importance = (typeof IMPORTANCE)[number]

/** 写入者：用户（界面）/ 助手（主模型工具）/ 后台总结。 */
export const AUTHORS = ['user', 'assistant', 'summarizer'] as const
export type Author = (typeof AUTHORS)[number]

/** 不属于任何已登记工作区的会话，其会话记忆归在这个伪项目下。 */
export const NO_PROJECT = '_none'

/** 「最近删除」保留天数。 */
export const TRASH_RETENTION_DAYS = 30

/** 单条记忆内容上限（字符）。 */
export const MEMORY_CONTENT_MAX = 4000

/** 记忆标题上限（字符）。标题可选：手动填写，或用默认模型从内容生成。 */
export const MEMORY_TITLE_MAX = 60

export interface MemorySource {
  sessionId?: string
  /** 第几轮（从 1 起；不明时缺省）。 */
  turn?: number
  by: Author
}

export interface MemoryEntry {
  id: string
  layer: MemoryLayer
  /** 仅会话层。 */
  section?: MemorySection
  /** 可选标题（卡片上显示；缺省时卡片只显示内容摘要）。 */
  title?: string
  content: string
  enabled: boolean
  pinned: boolean
  importance: Importance
  /** 仅项目层：只在这些 git 分支下生效；缺省 / 空数组 = 所有分支。 */
  branches?: string[]
  source: MemorySource
  createdAt: number
  updatedAt: number
}

/** 浏览器 / 工具指定作用域的方式。会话层只给会话 ID，所属项目由宿主解析。 */
export type MemoryScope =
  | { layer: 'global' }
  | { layer: 'project'; projectId: string }
  | { layer: 'session'; sessionId: string }

/** 可编辑字段。 */
export interface MemoryPatch {
  /** 空串 = 清除标题。 */
  title?: string
  content?: string
  enabled?: boolean
  pinned?: boolean
  importance?: Importance
  branches?: string[]
  section?: MemorySection
}

export interface MemoryDraft {
  title?: string
  content: string
  section?: MemorySection
  importance?: Importance
  pinned?: boolean
  branches?: string[]
}

/** 待选记忆：只针对项目层与全局。 */
export interface MemoryCandidate {
  id: string
  layer: 'project' | 'global'
  /** layer=project 时必有。 */
  projectId?: string
  title?: string
  content: string
  importance: Importance
  source: MemorySource
  createdAt: number
  /** 被重复提议并合并的次数（首次为 1）。 */
  hits: number
}

export type HistoryOp = 'create' | 'update' | 'delete' | 'restore' | 'revert'

export interface HistoryRecord {
  id: string
  entryId: string
  /** 作用域键：global / project:<id> / session:<sessionId>。 */
  scopeKey: string
  op: HistoryOp
  by: Author
  before?: MemoryEntry
  after?: MemoryEntry
  at: number
}

export interface TrashItem {
  id: string
  scopeKey: string
  /** 会话层所属项目（恢复时定位文件用）。 */
  projectId?: string
  entry: MemoryEntry
  deletedAt: number
}

export interface MemoryModelRef {
  provider: string
  model: string
}

export interface MemorySettings {
  /** 总开关，默认关闭。 */
  enabled: boolean
  /** 后台总结模型；null = 沿用会话当前模型。 */
  summarizerModel: MemoryModelRef | null
  /** 每隔几轮后台总结一次。 */
  summarizeEveryTurns: number
  /** 是否给主模型注册 scoped_memory 工具。 */
  toolEnabled: boolean
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: false,
  summarizerModel: null,
  summarizeEveryTurns: 8,
  toolEnabled: true
}

export interface ProjectSummary {
  id: string
  title: string
  path: string
  /** 远程工作区：主机显示名与远程路径。 */
  remote?: { hostId: string; host: string; remotePath: string }
  /** 宿主登记里已不存在（UUID 变化 / 登记被删）。 */
  unlinked: boolean
  entryCount: number
  sessions: Array<{ sessionId: string; title: string; entryCount: number; exists: boolean | null }>
}

export interface MemoryOverview {
  settings: MemorySettings
  globalCount: number
  pendingCount: number
  projects: ProjectSummary[]
  /** 不属于任何项目的会话。 */
  looseSessions: ProjectSummary['sessions']
}

export interface SessionMemoryView {
  enabled: boolean
  sessionId: string
  project: { id: string; title: string } | null
  session: MemoryEntry[]
  projectEntries: MemoryEntry[]
  globalEntries: MemoryEntry[]
  candidates: MemoryCandidate[]
  /** 后台总结是否正在进行。 */
  summarizing: boolean
}

export interface SearchHit {
  scope: MemoryScope
  scopeTitle: string
  entry: MemoryEntry
}

export interface CandidateDecision {
  id: string
  /** 修改后通过。 */
  title?: string
  content?: string
  layer?: 'project' | 'global'
  importance?: Importance
}

/** 网关 memory 方法的输入（按 op 分派）。 */
export type MemoryInput =
  /** sessionId 给定时待审批数只算与该会话所在工作区相关的条目。 */
  | { op: 'status'; sessionId?: string }
  | { op: 'overview' }
  | { op: 'settings'; patch: Partial<MemorySettings> }
  | { op: 'models' }
  | { op: 'list'; scope: MemoryScope }
  | { op: 'sessionView'; sessionId: string }
  | { op: 'add'; scope: MemoryScope; draft: MemoryDraft }
  | { op: 'update'; scope: MemoryScope; id: string; patch: MemoryPatch }
  | { op: 'remove'; scope: MemoryScope; id: string }
  | { op: 'promote'; scope: MemoryScope; id: string; to: 'project' | 'global' }
  | { op: 'history'; scope: MemoryScope; id: string }
  | { op: 'revert'; scope: MemoryScope; id: string; recordId: string }
  | { op: 'trash' }
  | { op: 'restore'; trashId: string }
  | { op: 'candidates'; sessionId?: string }
  | { op: 'approve'; decision: CandidateDecision }
  | { op: 'reject'; id: string }
  | { op: 'approveAll'; sessionId?: string }
  | { op: 'rejectAll'; sessionId?: string }
  | { op: 'search'; query: string }
  /** 用默认模型为一段记忆内容生成标题（不写入，只返回建议）。 */
  | { op: 'suggestTitle'; content: string }
  | { op: 'reorganize'; sessionId: string }
  | { op: 'orphans' }
  | { op: 'cleanup'; sessionIds: string[] }

/** 各 op 的输出（浏览器按 op 断言类型）。 */
export interface MemoryOutputs {
  /** 轻量轮询：会话顶部标签据此决定是否显示、标签上的待审批数。 */
  status: { enabled: boolean; pendingCount: number }
  overview: MemoryOverview
  settings: MemorySettings
  /** 后台总结可选模型（与 DSH 模型选择器同源）；group = 服务商显示名。 */
  models: Array<{ provider: string; model: string; label: string; group: string }>
  list: MemoryEntry[]
  sessionView: SessionMemoryView
  add: MemoryEntry
  update: MemoryEntry
  remove: { ok: true }
  promote: MemoryEntry
  history: HistoryRecord[]
  revert: MemoryEntry
  trash: TrashItem[]
  restore: MemoryEntry
  candidates: MemoryCandidate[]
  approve: MemoryEntry
  reject: { ok: true }
  approveAll: { count: number }
  rejectAll: { count: number }
  search: SearchHit[]
  suggestTitle: { title: string }
  reorganize: { started: boolean; reason?: string }
  orphans: Array<{ sessionId: string; projectId: string; entryCount: number }>
  cleanup: { removed: number }
}

export type MemoryOp = MemoryInput['op']

/** 作用域键（历史记录、去重、通知共用）。 */
export function scopeKeyOf(scope: MemoryScope): string {
  if (scope.layer === 'global') return 'global'
  if (scope.layer === 'project') return `project:${scope.projectId}`
  return `session:${scope.sessionId}`
}

/** 归一化后比较内容（去重用）：压缩空白、忽略大小写与常见结尾标点。 */
export function normalizeContent(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。.!！;；]+$/u, '')
    .toLowerCase()
}

const IMPORTANCE_RANK: Record<Importance, number> = { high: 0, medium: 1, low: 2 }

/** 注入 / 展示排序：置顶 > 高 > 中 > 低，同档按创建时间。 */
export function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const r = IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]
  if (r !== 0) return r
  return a.createdAt - b.createdAt
}
