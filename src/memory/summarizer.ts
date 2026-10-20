/*
 * @Description: 作用域记忆 —— 后台总结（每 N 轮 / 压缩补漏 / 手动整理）
 * @Author: YangHeng
 * @Date: 2026-10-16 19:40:00
 * @FilePath: /dsh-workspace/src/memory/summarizer.ts
 *
 * 用一次独立的模型调用从最近几轮对话里提取：
 *   - 会话记忆的增 / 改 / 禁用 → 直接写入（写入者 summarizer）
 *   - 项目 / 全局候选 → 进待选记忆，等用户审批
 * 这次调用不进入主对话上下文；失败只记日志，不打断对话。同一会话同一时刻只跑一个任务。
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { IMPORTANCE, MEMORY_SECTIONS, SECTION_LABELS, type MemoryEntry, type MemoryModelRef } from '../wire/memory.js'
import type { MemoryStore } from './store.js'

export type SummarizeMode = 'turns' | 'compaction' | 'manual'

/** 每条消息截断长度与整段对话上限（字符）：控制后台调用成本。 */
const MESSAGE_MAX = 2000
const TRANSCRIPT_MAX = 24_000
/** 后台调用超时。 */
const CALL_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------- 对话抽取

interface EventLike {
  type?: unknown
  data?: unknown
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`
}

/**
 * 从会话事件里取最近 turns 轮的真人输入与助手文本（跳过运行时快照、压缩检查点、工具调用）。
 * @returns 形如「user: … / assistant: …」的文本；没有内容时为空串
 */
export function extractTranscript(events: readonly unknown[], turns: number): string {
  // 先找出最后 turns 个 turn/start 的位置
  const starts: number[] = []
  events.forEach((e, i) => {
    if ((e as EventLike)?.type === 'turn/start') starts.push(i)
  })
  const from = starts.length > turns ? (starts[starts.length - turns] as number) : 0
  const lines: string[] = []
  for (let i = from; i < events.length; i += 1) {
    const event = events[i] as EventLike
    const data = event?.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    if (event.type === 'user/message') {
      const source = data.source as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      const text = textBlocks(data.content)
      if (text !== '') lines.push(`user: ${clip(text, MESSAGE_MAX)}`)
    } else if (event.type === 'assistant/message') {
      const text = textBlocks((data.message as { content?: unknown } | undefined)?.content)
      if (text !== '') lines.push(`assistant: ${clip(text, MESSAGE_MAX)}`)
    }
  }
  // 超长时保留最近的部分（最新的信息最有价值）
  let out = lines.join('\n\n')
  if (out.length > TRANSCRIPT_MAX) out = `…（更早的内容已省略）\n${out.slice(out.length - TRANSCRIPT_MAX)}`
  return out
}

// ---------------------------------------------------------------- 提示词

/**
 * 自动记录的门槛：只收「以后反复要用、记错会出事」的信息。
 * 会话记忆每一步都随系统提示词发送，条目越多上下文越重 —— 宁可少记，靠用户手动 / 助手工具补。
 */
export const SUMMARIZER_SYSTEM = [
  '你是对话记忆整理器，负责维护「会话记忆」，并发现值得长期保存的「项目记忆」「全局记忆」候选。',
  '会话记忆会随每一轮对话发送给助手，条目越多越占上下文，所以门槛要高：只记录重要且之后会反复用到的信息，大多数轮次应该什么都不新增。',
  '会话记忆分节：' + MEMORY_SECTIONS.map((s) => `${s}=${SECTION_LABELS[s]}`).join('，') + '。',
  '值得自动记录的（只有这几类）：',
  '- 工作流：编译、运行、测试、打包、发布、部署的固定步骤与命令（含必须的参数、顺序、环境）。',
  '- 依赖：项目依赖的关键基础库 / 框架 / 服务及其版本或兼容约束、必须用 / 禁止用某个库。',
  '- 用户明确提出的要求、纠正与禁止事项（保留原话）。',
  '- 已确定的关键决策与已排除的方案（避免之后重复讨论）。',
  '- 当前任务目标与大的阶段进度（一条即可，变化时 update 而不是新增）。',
  '- 会反复用到的关键事实：路径、端口、配置项、账号以外的环境信息、已定位的根因。',
  '不要记录：闲聊、一次性的中间步骤、刚看过的代码细节、临时报错、你自己的推理过程、已经在对话里完成且不再相关的事。',
  '规则：',
  '1. 每次最多新增 2 条会话记忆；能 update 已有条目就不要新增；内容重复或相近的合并成一条。',
  '2. 已有条目过时就 update（给出完整新内容），不再成立或不再重要就 disable。',
  '3. 内容要短而精确：一条只讲一件事，命令 / 路径 / 版本号逐字照抄。',
  '4. 项目候选 = 对这个项目以后所有对话都成立的工作流、依赖约束、约定、踩坑；全局候选 = 跨项目的个人偏好与通用规范。只有用户明确表达或反复体现的才提，每次最多 1 条，拿不准就不提。',
  '5. 只输出一个 JSON 对象，不要任何解释，格式：',
  '{"session":{"add":[{"section":"facts","title":"…","content":"…"}],"update":[{"id":"m_…","content":"…"}],"disable":["m_…"]},"candidates":[{"layer":"project","title":"…","content":"…","importance":"medium"}]}',
  'title 是一句话标题（不超过 20 个字，概括这条记忆讲什么），content 是完整内容。',
  '没有值得记录的内容时（这是常态）输出 {"session":{"add":[],"update":[],"disable":[]},"candidates":[]}。'
].join('\n')

function listEntries(entries: readonly MemoryEntry[], withId: boolean): string {
  const enabled = entries.filter((e) => e.enabled)
  if (enabled.length === 0) return '（无）'
  return enabled.map((e) => `- ${withId ? `[${e.id}] ` : ''}${e.section !== undefined ? `(${e.section}) ` : ''}${e.content}`).join('\n')
}

export interface PromptInput {
  mode: SummarizeMode
  session: readonly MemoryEntry[]
  project: readonly MemoryEntry[] | null
  global: readonly MemoryEntry[]
  transcript: string
  compactionSummary?: string
}

export function buildUserPrompt(input: PromptInput): string {
  const active = input.session.filter((e) => e.enabled).length
  const parts = [
    `## 当前会话记忆（共 ${active} 条生效；可 update / disable，用方括号里的 id）`,
    ...(active >= SESSION_SOFT_LIMIT ? [`会话记忆已达 ${active} 条，超过建议上限 ${SESSION_SOFT_LIMIT}：这次不要新增，只做合并（update）与清理（disable）。`] : []),
    listEntries(input.session, true),
    '## 已有项目记忆（不要重复提候选）',
    input.project === null ? '（本会话不属于任何项目：不要提 project 候选）' : listEntries(input.project, false),
    '## 已有全局记忆（不要重复提候选）',
    listEntries(input.global, false)
  ]
  if (input.mode === 'compaction' && input.compactionSummary !== undefined) {
    parts.push(
      '## 对话刚被压缩，以下是压缩摘要',
      '请检查：摘要里有、会话记忆里缺失、且属于上面几类重要信息的内容，补进会话记忆（最多 2 条）。',
      clip(input.compactionSummary, TRANSCRIPT_MAX)
    )
  }
  if (input.mode === 'manual') parts.push('## 用户要求重新整理会话记忆：请合并重复、清理过时和不重要的内容，使会话记忆简洁准确（目标不超过 ' + SESSION_SOFT_LIMIT + ' 条）。')
  parts.push('## 最近的对话', input.transcript === '' ? '（无）' : input.transcript)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------- 结果解析与应用

const resultSchema = z.object({
  session: z
    .object({
      add: z.array(z.object({ section: z.enum(MEMORY_SECTIONS), title: z.string().max(200).optional(), content: z.string().min(1).max(4000) })).max(50).default([]),
      update: z.array(z.object({ id: z.string().min(1).max(64), title: z.string().max(200).optional(), content: z.string().min(1).max(4000) })).max(50).default([]),
      disable: z.array(z.string().min(1).max(64)).max(50).default([])
    })
    .default({ add: [], update: [], disable: [] }),
  candidates: z
    .array(z.object({ layer: z.enum(['project', 'global']), title: z.string().max(200).optional(), content: z.string().min(1).max(4000), importance: z.enum(IMPORTANCE).default('medium') }))
    .max(20)
    .default([])
})

export type SummarizerResult = z.infer<typeof resultSchema>

/** 从模型输出里取 JSON（容忍 ```json 围栏与前后多余文字）。 */
export function parseResult(text: string): SummarizerResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('总结结果里没有 JSON。')
  return resultSchema.parse(JSON.parse(text.slice(start, end + 1)))
}

export interface ApplyOutcome {
  added: number
  updated: number
  disabled: number
  proposed: number
}

/** 会话记忆自动维护的建议上限（生效条数）；达到后自动总结不再新增，只合并 / 清理。 */
export const SESSION_SOFT_LIMIT = 15
/** 每次自动总结最多新增的会话条目 / 待选候选数：模型偶尔不听话，这里兜底。 */
export const MAX_SESSION_ADDS = 2
export const MAX_CANDIDATES = 1

/** 把结果写进存储。id 不属于本会话的更新 / 禁用直接忽略（模型幻觉的 id 不能改到别的数据）。 */
export function applyResult(store: MemoryStore, sessionId: string, projectId: string | null, turn: number | undefined, result: SummarizerResult): ApplyOutcome {
  const scope = { layer: 'session' as const, sessionId }
  const own = new Set(store.list(scope).map((e) => e.id))
  const source = { by: 'summarizer' as const, sessionId, ...(turn !== undefined ? { turn } : {}) }
  const outcome: ApplyOutcome = { added: 0, updated: 0, disabled: 0, proposed: 0 }
  const existing = new Set(store.list(scope).filter((e) => e.enabled).map((e) => e.content.trim()))
  // 先处理禁用：腾出名额后再按上限新增
  let room = Math.min(MAX_SESSION_ADDS, Math.max(0, SESSION_SOFT_LIMIT - existing.size + result.session.disable.filter((id) => own.has(id)).length))
  for (const item of result.session.add) {
    if (room <= 0) break
    if (existing.has(item.content.trim())) continue
    room -= 1
    store.add(scope, { ...(item.title !== undefined ? { title: item.title } : {}), content: item.content, section: item.section }, source)
    outcome.added += 1
  }
  for (const item of result.session.update) {
    if (!own.has(item.id)) continue
    store.update(scope, item.id, { ...(item.title !== undefined && item.title.trim() !== '' ? { title: item.title } : {}), content: item.content }, 'summarizer')
    outcome.updated += 1
  }
  for (const id of result.session.disable) {
    if (!own.has(id)) continue
    store.update(scope, id, { enabled: false }, 'summarizer')
    outcome.disabled += 1
  }
  for (const c of result.candidates) {
    if (outcome.proposed >= MAX_CANDIDATES) break
    if (c.layer === 'project' && projectId === null) continue
    const proposed = store.propose({ layer: c.layer, projectId, ...(c.title !== undefined ? { title: c.title } : {}), content: c.content, importance: c.importance, source })
    if (proposed !== undefined) outcome.proposed += 1
  }
  return outcome
}

// ---------------------------------------------------------------- 调度

export interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

export interface SummarizerHost {
  store: MemoryStore
  /** 解析会话所属项目（异步，会刷新缓存）。 */
  projectOf(sessionId: string): Promise<string | null>
  /** 读取会话事件（热会话直接取，冷会话只读打开）。 */
  events(sessionId: string): Promise<readonly unknown[] | undefined>
  /** 选模型：设置 > 会话已记录的路由 > 默认模型。 */
  route(sessionId: string, preferred: MemoryModelRef | null): MemoryModelRef | undefined
  llm(): LlmLike | undefined
  log(level: 'info' | 'warn', message: string): void
  /** 会话记忆写入后（注入链路据此刷新冻结版本 / 界面刷新）。 */
  onApplied?(sessionId: string, mode: SummarizeMode): void
}

export interface RunRequest {
  sessionId: string
  mode: SummarizeMode
  turn?: number
  compactionSummary?: string
}

export class Summarizer {
  private readonly running = new Set<string>()
  /** 运行中又来了请求：跑完后补跑一次（压缩补漏不能丢）。 */
  private readonly queued = new Map<string, RunRequest>()
  private readonly turnCounters = new Map<string, number>()
  private disposed = false
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly host: SummarizerHost) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** 每轮结束调用：累计到间隔轮数就触发。 */
  onTurn(sessionId: string, turn: number | undefined): void {
    const settings = this.host.store.getSettings()
    if (!settings.enabled) return
    const count = (this.turnCounters.get(sessionId) ?? 0) + 1
    if (count < settings.summarizeEveryTurns) {
      this.turnCounters.set(sessionId, count)
      return
    }
    this.turnCounters.set(sessionId, 0)
    this.request({ sessionId, mode: 'turns', ...(turn !== undefined ? { turn } : {}) })
  }

  /**
   * 提交任务。正在跑同一会话时排队（同会话只保留一个排队任务，压缩补漏优先）。
   * @returns 是否立即开始
   */
  request(req: RunRequest): boolean {
    if (this.disposed) return false
    if (this.running.has(req.sessionId)) {
      const pending = this.queued.get(req.sessionId)
      if (pending === undefined || pending.mode !== 'compaction') this.queued.set(req.sessionId, req)
      return false
    }
    this.running.add(req.sessionId)
    void this.run(req).finally(() => {
      this.running.delete(req.sessionId)
      const next = this.queued.get(req.sessionId)
      if (next !== undefined) {
        this.queued.delete(req.sessionId)
        this.request(next)
      }
    })
    return true
  }

  /** 实际执行；导出给测试直接 await。 */
  async run(req: RunRequest): Promise<ApplyOutcome | undefined> {
    const { store } = this.host
    try {
      if (!store.getSettings().enabled) return undefined
      const llm = this.host.llm()
      if (llm === undefined) {
        this.host.log('warn', '作用域记忆：宿主模型服务不可用，跳过本次总结。')
        return undefined
      }
      const route = this.host.route(req.sessionId, store.getSettings().summarizerModel)
      if (route === undefined) {
        this.host.log('warn', '作用域记忆：找不到可用的模型（会话没有记录模型且没有默认模型），跳过本次总结。')
        return undefined
      }
      const projectId = await this.host.projectOf(req.sessionId)
      const events = (await this.host.events(req.sessionId)) ?? []
      const turns = Math.max(2, store.getSettings().summarizeEveryTurns + 1)
      const transcript = extractTranscript(events, req.mode === 'manual' ? Math.max(turns, 10) : turns)
      if (transcript === '' && req.compactionSummary === undefined) return undefined
      const prompt = buildUserPrompt({
        mode: req.mode,
        session: store.list({ layer: 'session', sessionId: req.sessionId }),
        project: projectId === null ? null : store.list({ layer: 'project', projectId }),
        global: store.list({ layer: 'global' }),
        transcript,
        ...(req.compactionSummary !== undefined ? { compactionSummary: req.compactionSummary } : {})
      })
      const text = await this.complete(llm, route, prompt, req.sessionId)
      const outcome = applyResult(store, req.sessionId, projectId, req.turn, parseResult(text))
      this.host.log('info', `作用域记忆：${req.mode === 'compaction' ? '压缩补漏' : req.mode === 'manual' ? '手动整理' : '后台总结'}完成（新增 ${outcome.added}，修改 ${outcome.updated}，禁用 ${outcome.disabled}，待选 ${outcome.proposed}）。`)
      this.host.onApplied?.(req.sessionId, req.mode)
      return outcome
    } catch (error) {
      this.host.log('warn', `作用域记忆：后台总结失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async complete(llm: LlmLike, route: MemoryModelRef, prompt: string, sessionId: string): Promise<string> {
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      return await streamText(llm, { route, system: SUMMARIZER_SYSTEM, prompt, maxTokens: 4000, sessionId, timeoutMs: CALL_TIMEOUT_MS, signal: controller.signal })
    } finally {
      this.controllers.delete(controller)
    }
  }
  dispose(): void {
    this.disposed = true
    for (const c of this.controllers) c.abort(new Error('插件卸载'))
    this.controllers.clear()
    this.queued.clear()
  }
}

/**
 * 一次独立的模型调用，读完全部文本。失败以 finish 块返回（不抛）的情况也转成异常。
 * 后台总结与「AI 生成标题」共用。
 */
export async function streamText(
  llm: LlmLike,
  options: { route: MemoryModelRef; system: string; prompt: string; maxTokens: number; timeoutMs: number; sessionId?: string; signal?: AbortSignal }
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('模型调用超时')), options.timeoutMs)
  const onAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let text = ''
    const stream = llm.stream({
      provider: options.route.provider,
      model: options.route.model,
      system: options.system,
      messages: [{ role: 'user', id: randomUUID(), content: [{ type: 'text', text: options.prompt }], source: { kind: 'dsh-workspace-memory' } }],
      maxTokens: options.maxTokens,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      signal: controller.signal
    })
    for await (const chunk of stream) {
      const c = chunk as { type?: unknown; text?: unknown; finish?: { kind?: unknown; failure?: { message?: unknown } }; kind?: unknown; failure?: { message?: unknown } }
      if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
      // 失败以 finish 块的形式返回而不是抛错：两种可能的形状都认
      const finish = c.type === 'finish' ? (c.finish ?? c) : undefined
      if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
        throw new Error(typeof finish.failure?.message === 'string' ? finish.failure.message : `模型调用失败（${String(finish.kind)}）`)
      }
    }
    if (text.trim() === '') throw new Error('模型没有返回内容。')
    return text
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export const TITLE_SYSTEM = '你为一条记忆生成标题。只输出标题本身：一句话、不超过 20 个字、概括这条记忆讲什么；不要引号、标点结尾、解释或前缀。标题语言与内容语言一致。'

/** 清理模型给出的标题：去掉引号 / 「标题：」前缀 / 结尾标点，取第一行。 */
export function cleanSuggestedTitle(raw: string): string {
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '') ?? ''
  return line
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    // 首尾的引号、书名号、markdown 记号与结尾标点一起剥掉（模型常输出「标题」。这种形式）
    .replace(/^["'“”‘’「」『』《》*#\s]+|["'“”‘’「」『』《》*\s。.!！;；，,]+$/gu, '')
    .slice(0, 60)
}
