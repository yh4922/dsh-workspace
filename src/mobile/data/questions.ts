/*
 * @Description: H5 —— agent 向用户提问（ask_user_question）的请求解析与答复组装（纯函数，单测见 questions.test.ts）
 * @Author: YangHeng
 * @Date: 2026-11-20 11:00:00
 * @FilePath: /dsh-workspace/src/mobile/data/questions.ts
 *
 * 宿主协议（dsh-user-questions / dsh-api-remotes / dsh-api-gateway，详见 .docs/移动端H5/宿主线协议.md §3「提问」）：
 * - 前台等待：$events 下行 {type:'waterfall',event:'user-questions/request',eventId,agentId,
 *   request:{questions:[{id,question,header?,detail?,options?:[{label,description?}],multiSelect?}],wait?:{callId,timed?}}}；
 *   答复 $events/result outcome {kind:'result',value:{answers:[{id,selected:string[],custom?}]}}；
 *   某题 selected 为空且无 custom = 用户跳过该题（模型按「跳过」理解，不是放行）。
 * - 超时后仍可回答（timed 模式）：会话投影 userQuestions.active 中 state==='continued' 的条目，
 *   用 RPC userQuestions/answer {agentId:sessionId,callId,answer:{answers}} 答复（宿主把它作为 user-question-reply 消息注入）。
 */

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  id: string
  question: string
  header?: string
  detail?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface Answer {
  id: string
  selected: string[]
  custom?: string
}

/** 单题草稿：选中的选项 label、自定义输入、是否跳过。 */
export interface Draft {
  selected: string[]
  custom: string
  skipped: boolean
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * 解析问题数组（waterfall request.questions 与投影 active[].questions 同形）。
 * 宽容处理：缺 id / question 的条目丢弃；全部无效时返回 undefined，调用方据此决定不接管该事件。
 */
export function parseQuestions(v: unknown): Question[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Question[] = []
  for (const raw of v) {
    const q = rec(raw)
    const id = str(q?.id)
    const question = str(q?.question)
    if (q === undefined || id === undefined || question === undefined) continue
    const options: QuestionOption[] = []
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const label = str(rec(o)?.label)
      if (label === undefined) continue
      const description = str(rec(o)?.description)
      options.push(description !== undefined ? { label, description } : { label })
    }
    const item: Question = { id, question, options, multiSelect: q.multiSelect === true || q.multi_select === true }
    const header = str(q.header)
    if (header !== undefined) item.header = header
    const detail = str(q.detail)
    if (detail !== undefined) item.detail = detail
    out.push(item)
  }
  return out.length > 0 ? out : undefined
}

export function emptyDraft(): Draft {
  return { selected: [], custom: '', skipped: false }
}

/** 单选点同一项取消、点别项替换；多选切换。任何选择都会取消「跳过」。 */
export function toggleOption(q: Question, d: Draft, label: string): Draft {
  const has = d.selected.includes(label)
  const selected = q.multiSelect ? (has ? d.selected.filter((s) => s !== label) : [...d.selected, label]) : has ? [] : [label]
  return { ...d, selected, skipped: false }
}

export function isAnswered(d: Draft): boolean {
  return d.skipped || d.selected.length > 0 || d.custom.trim() !== ''
}

/**
 * 草稿 → 答复批次。与桌面端 QuestionComposer 规则一致：
 * 跳过 → selected:[]；单选题填了自定义内容时以自定义为准（selected 清空），多选题两者并存。
 */
export function buildAnswers(questions: readonly Question[], drafts: readonly Draft[]): { answers: Answer[] } {
  return {
    answers: questions.map((q, i) => {
      const d = drafts[i] ?? emptyDraft()
      if (d.skipped) return { id: q.id, selected: [] }
      const custom = d.custom.trim()
      const selected = custom === '' || q.multiSelect ? [...d.selected] : []
      return custom === '' ? { id: q.id, selected } : { id: q.id, selected, custom }
    })
  }
}

/** 全部跳过（用户明确表示不回答；模型按跳过处理，不视为许可）。 */
export function skipAll(questions: readonly Question[]): { answers: Answer[] } {
  return { answers: questions.map((q) => ({ id: q.id, selected: [] })) }
}

/** 第一道既没作答也没标记跳过的题；全部完成返回 -1。 */
export function firstUnanswered(drafts: readonly Draft[]): number {
  return drafts.findIndex((d) => !isAnswered(d))
}

// ---------------------------------------------------------------- 分步答题（与桌面 QuestionComposer 一致：一次一题）
// 状态放在纯 reducer 里：组件只负责渲染与动画方向，便于单测，也便于在模块级缓存里按请求恢复（流式刷新 / 重挂载不丢答案）。

export interface StepState {
  /** 当前显示的题号（0 起）。 */
  index: number
  drafts: Draft[]
  /** 最近一次切题方向：1 向后、-1 向前，驱动横向滑入动画。 */
  dir: 1 | -1
  /** 提交校验失败等提示；任何编辑 / 切题都会清掉。 */
  error?: string
}

export type StepAction =
  | { type: 'go'; index: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'toggle'; label: string }
  | { type: 'custom'; text: string }
  | { type: 'skip' }
  | { type: 'submit' }

export function initStep(count: number): StepState {
  return { index: 0, drafts: Array.from({ length: count }, () => emptyDraft()), dir: 1 }
}

function clampIndex(i: number, count: number): number {
  return Math.max(0, Math.min(count - 1, i))
}

function moveTo(state: StepState, index: number, count: number): StepState {
  const next = clampIndex(index, count)
  if (next === state.index) return state.error === undefined ? state : { index: state.index, drafts: state.drafts, dir: state.dir }
  return { index: next, drafts: state.drafts, dir: next > state.index ? 1 : -1 }
}

function withDraft(state: StepState, draft: Draft): StepState {
  return { index: state.index, drafts: state.drafts.map((d, i) => (i === state.index ? draft : d)), dir: state.dir }
}

/**
 * 分步答题 reducer。规则：
 * - 上一题 / 下一题 / 点进度可自由切换（不强制先答当前题），最终由「提交」统一校验；
 * - 单选题选中某项后自动进入下一题（桌面端同样如此，少一次点击）；取消选中或多选不跳；
 * - 「跳过此题」再点一次撤销；跳过后自动进入下一题，但最后一题跳过不会自动提交，仍需点「提交」；
 * - 提交时有未完成的题：跳到第一道未完成题并给出提示（宿主协议没有「部分作答」，空答复会被当成跳过，必须用户明确）。
 */
export function stepReducer(questions: readonly Question[], state: StepState, action: StepAction): StepState {
  const count = questions.length
  if (count === 0) return state
  const q = questions[state.index]
  const d = state.drafts[state.index] ?? emptyDraft()
  switch (action.type) {
    case 'go':
      return moveTo(state, action.index, count)
    case 'next':
      return moveTo(state, state.index + 1, count)
    case 'prev':
      return moveTo(state, state.index - 1, count)
    case 'toggle': {
      if (q === undefined) return state
      const next = withDraft(state, toggleOption(q, d, action.label))
      const picked = (next.drafts[state.index]?.selected.length ?? 0) > 0
      return !q.multiSelect && picked && state.index < count - 1 ? moveTo(next, state.index + 1, count) : next
    }
    case 'custom':
      return withDraft(state, { ...d, custom: action.text, skipped: false })
    case 'skip': {
      if (d.skipped) return withDraft(state, emptyDraft())
      const next = withDraft(state, { ...emptyDraft(), skipped: true })
      return state.index < count - 1 ? moveTo(next, state.index + 1, count) : next
    }
    case 'submit': {
      const missing = firstUnanswered(state.drafts)
      if (missing < 0) return state.error === undefined ? state : { index: state.index, drafts: state.drafts, dir: state.dir }
      const moved = moveTo(state, missing, count)
      return { ...moved, error: count > 1 ? `第 ${missing + 1} 题还没回答，请选择、输入或跳过` : '请选择、输入或跳过' }
    }
  }
}

export interface ContinuedQuestion {
  callId: string
  questions: Question[]
}

/** 从会话投影 userQuestions（{active:[{callId,questions,state}],settled}）取出仍可回答的超时提问。 */
export function continuedQuestions(projection: unknown): ContinuedQuestion[] {
  const active = rec(projection)?.active
  if (!Array.isArray(active)) return []
  const out: ContinuedQuestion[] = []
  for (const raw of active) {
    const r = rec(raw)
    const callId = str(r?.callId)
    const questions = parseQuestions(r?.questions)
    if (r?.state === 'continued' && callId !== undefined && questions !== undefined) out.push({ callId, questions })
  }
  return out
}

/**
 * 该 durable 事件是否会改变 userQuestions 投影（提问转为 continued，或迟到答复落盘）。
 * follow 只在这些事件后刷新投影，避免每个工具结果都打一次 RPC。
 */
export function touchesQuestionProjection(type: string, data: unknown): boolean {
  const d = rec(data)
  if (type === 'user/message') return rec(d?.source)?.kind === 'user-question-reply'
  if (type !== 'tool/result') return false
  const content = rec(d?.message)?.content
  if (!Array.isArray(content)) return false
  const text = content.map((b) => (rec(b)?.type === 'text' ? (str(rec(b)?.text) ?? '') : '')).find((t) => t.includes('"pending"'))
  if (text === undefined) return false
  try {
    return rec(JSON.parse(text))?.pending === true
  } catch {
    return false
  }
}
