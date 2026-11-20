/*
 * @Description: H5 会话 —— 会话事件 / 流式帧 → 消息视图模型（纯函数，单测见 transcript.test.ts）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:30:00
 * @FilePath: /dsh-workspace/src/mobile/data/transcript.ts
 *
 * 事件格式见 .docs/移动端H5/宿主线协议.md §3 与宿主 dsh-session SessionEventMap：
 * - 只渲染 surfaceOp === 'append' 的消息事件（压缩产生的 replace 副本只给模型看，人类记录用原始 append 事件）；
 * - user/message：source.kind === 'user' 是人类气泡；其余来源（工作区指令、技能目录、时间、代理消息…）与桌面端一致
 *   作为「上下文注入」显示，相邻的合并成一行（桌面 dsh-client-ui-chat messageDefinition → contextMessage）；
 * - deliverables/presented（present 工具交付）按 turn 汇总成文件卡片，放在该 turn 结束处（桌面放在 turnTail）；
 * - 运行中但没有可见输出时补一个「思考中」占位（模型 reasoning 为空 / 刚开始 / 工具之间）；
 * - assistant/message.message.content 里的 tool-call 块与随后 tool/result（按 toolCallId）配对成工具卡片；
 * - 正在生成的一次 attempt（assistant-stream 帧，或重连快照里压缩格式的 activeAttempt.stream）展开成同形的块，
 *   块 key 用 turn.step.index，落盘后 durable 块沿用同一 key，界面不闪、不丢展开状态。
 */

export interface WireEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
}

export type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage' }
  | { type: 'finish'; reason?: unknown }

export interface TimedChunk {
  time: number
  chunk: StreamChunk
}

/** 一次正在生成（或刚结束、等待落盘事件）的助手 attempt。 */
export interface LiveAttempt {
  attemptId: string
  turn: number
  step: number
  startedAfterSeq: number
  /** 期望的下一个 chunk 帧序号。 */
  nextIndex: number
  chunks: TimedChunk[]
}

export interface ImageAtt {
  /** 宿主附件引用（session/attachment 读取字节用）；本地待发送消息用 url。 */
  ref?: Record<string, unknown>
  url?: string
  name?: string
  mediaType?: string
}

export interface FileAtt {
  name: string
  bytes?: number
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'interrupted'

/** 一条注入的上下文（非人类输入的 user/message）：来源标签 + 正文。 */
export interface ContextEntry {
  label: string
  text: string
}

/** present 工具交付的文件（deliverables/presented 事件）。path 为宿主绝对路径。 */
export interface PresentedFile {
  path: string
  name: string
  description?: string
}

export type ChatItem =
  | { kind: 'user'; key: string; seq: number; text: string; images: ImageAtt[]; files: FileAtt[]; pending?: 'sending' | 'queued' | 'failed' }
  | { kind: 'text'; key: string; text: string; streaming?: boolean }
  | { kind: 'reasoning'; key: string; text: string; durationMs?: number; streaming?: boolean }
  | {
      kind: 'tool'
      key: string
      callId: string
      name: string
      argsText: string
      status: ToolStatus
      result?: string
      meta?: unknown
    }
  | { kind: 'notice'; key: string; text: string; tone: 'error' | 'info' }
  | { kind: 'context'; key: string; entries: ContextEntry[] }
  | { kind: 'files'; key: string; files: PresentedFile[] }
  /** 正在运行但还没有可见输出（等首个 token / 工具之间）：显示「思考中…」占位。 */
  | { kind: 'thinking'; key: string }

// ---------------------------------------------------------------- 小工具

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 宿主事件是否是「人类可见记录」：非消息事件一律算；消息事件只认 append（缺省视为 append，兼容旧格式）。 */
function isAppend(e: WireEvent): boolean {
  return e.surfaceOp === undefined || e.surfaceOp === 'append'
}

// ---------------------------------------------------------------- 流

/**
 * 展开压缩流记录（text-chunks / reasoning-chunks / tool-call-chunks / chunk），宽容处理坏记录（跳过）。
 * 与宿主 dsh-llm expandAssistantStream 等价。
 */
export function expandStream(records: readonly unknown[]): TimedChunk[] {
  const out: TimedChunk[] = []
  for (const r of records) {
    const o = rec(r)
    if (o === undefined) continue
    if (o.type === 'chunk') {
      const chunk = rec(o.chunk)
      const time = num(o.time)
      if (chunk !== undefined && time !== undefined) out.push({ time, chunk: chunk as unknown as StreamChunk })
      continue
    }
    const time0 = num(o.time0)
    const index = num(o.index)
    if (time0 === undefined || index === undefined) continue
    const dt = arr(o.dt)
    const members = arr(o.type === 'tool-call-chunks' ? o.args : o.texts)
    let time = time0
    members.forEach((m, i) => {
      if (i > 0) time += num(dt[i - 1]) ?? 0
      const text = str(m) ?? ''
      if (o.type === 'text-chunks') out.push({ time, chunk: { type: 'text-delta', index, text } })
      else if (o.type === 'reasoning-chunks') out.push({ time, chunk: { type: 'reasoning-delta', index, text } })
      else if (o.type === 'tool-call-chunks') {
        const c: StreamChunk = { type: 'tool-call-delta', index, id: str(o.id) ?? '', argumentsDelta: text }
        const name = str(o.name)
        if (name !== undefined) c.name = name
        out.push({ time, chunk: c })
      }
    })
  }
  return out
}

interface AssembledBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
  t0?: number
  t1?: number
}

/** 把一串 chunk 拼成按 index 排序的内容块（reasoning 记录首末时间，用于「思考 N 秒」）。 */
export function assembleChunks(chunks: readonly TimedChunk[]): AssembledBlock[] {
  const byIndex = new Map<number, AssembledBlock>()
  const order: number[] = []
  const get = (index: number, type: AssembledBlock['type']): AssembledBlock => {
    let b = byIndex.get(index)
    if (b === undefined) {
      b = { type, text: '' }
      byIndex.set(index, b)
      order.push(index)
    }
    return b
  }
  for (const { time, chunk } of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        get(chunk.index, 'text').text += chunk.text
        break
      case 'reasoning-delta': {
        const b = get(chunk.index, 'reasoning')
        b.text += chunk.text
        b.t0 ??= time
        b.t1 = time
        break
      }
      case 'tool-call-delta': {
        const b = get(chunk.index, 'tool-call')
        if (chunk.id !== '') b.id = chunk.id
        if (chunk.name !== undefined) b.name = chunk.name
        b.text += chunk.argumentsDelta
        break
      }
      case 'block-start': {
        const t = chunk.blockType === 'reasoning' || chunk.blockType === 'tool-call' ? chunk.blockType : chunk.blockType === 'text' ? 'text' : undefined
        if (t !== undefined) {
          const b = get(chunk.index, t)
          if (t === 'reasoning') b.t0 ??= time
        }
        break
      }
      case 'block-end': {
        const blk = rec(chunk.block)
        const t = blk?.type
        if (t === 'text' || t === 'reasoning') {
          const b = get(chunk.index, t)
          b.text = str(blk?.text) ?? b.text
          if (t === 'reasoning') b.t1 = time
        } else if (t === 'tool-call') {
          const b = get(chunk.index, 'tool-call')
          b.id = str(blk?.id) ?? b.id
          b.name = str(blk?.name) ?? b.name
          b.text = str(blk?.arguments) ?? b.text
        }
        break
      }
      default:
        break
    }
  }
  return order.sort((a, b) => a - b).map((i) => byIndex.get(i) as AssembledBlock)
}

/** reasoning 块耗时（毫秒）：取压缩流里各 reasoning 块的首末时间。按出现顺序返回。 */
export function reasoningDurations(stream: readonly unknown[]): number[] {
  return assembleChunks(expandStream(stream))
    .filter((b) => b.type === 'reasoning')
    .map((b) => (b.t0 !== undefined && b.t1 !== undefined ? Math.max(0, b.t1 - b.t0) : 0))
}

// ---------------------------------------------------------------- 事件合并

/** 按 seq 合并去重（后来者覆盖），升序返回。 */
export function mergeEvents(base: readonly WireEvent[], incoming: readonly WireEvent[]): WireEvent[] {
  if (incoming.length === 0) return base as WireEvent[]
  const map = new Map<number, WireEvent>()
  for (const e of base) map.set(e.seq, e)
  for (const e of incoming) map.set(e.seq, e)
  return [...map.values()].sort((a, b) => a.seq - b.seq)
}

/** 从 follow / events 的 records（{type:'event',event}）里取出事件。 */
export function eventsOf(records: unknown): WireEvent[] {
  const out: WireEvent[] = []
  for (const r of arr(records)) {
    const e = rec(rec(r)?.event)
    if (e === undefined) continue
    const seq = num(e.seq)
    const type = str(e.type)
    if (seq === undefined || type === undefined) continue
    out.push({ type, seq, time: num(e.time) ?? 0, data: e.data, ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}) })
  }
  return out
}

/**
 * 找出已知事件里第一个 seq 断档（升序事件，期望连续）。返回缺失区间 [from, to]（含）。
 */
export function findGap(events: readonly WireEvent[]): { from: number; to: number } | undefined {
  for (let i = 1; i < events.length; i++) {
    const prev = (events[i - 1] as WireEvent).seq
    const cur = (events[i] as WireEvent).seq
    if (cur > prev + 1) return { from: prev + 1, to: cur - 1 }
  }
  return undefined
}

/** 事件窗口里最后一个 turn/start 之后没有对应 turn/end → 正在运行。 */
export function isRunning(events: readonly WireEvent[]): boolean | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = (events[i] as WireEvent).type
    if (t === 'turn/end') return false
    if (t === 'turn/start') return true
  }
  return undefined
}

// ---------------------------------------------------------------- 视图模型

function textOfContent(content: unknown): string {
  return arr(content)
    .map((b) => {
      const o = rec(b)
      return o?.type === 'text' ? (str(o.text) ?? '') : ''
    })
    .filter((s) => s !== '')
    .join('\n')
}

/** 工具结果正文：文本块拼接，图片记为「[图片]」。 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((b) => {
      const o = rec(b)
      if (o?.type === 'text') return str(o.text) ?? ''
      if (o?.type === 'image') return '[图片]'
      return ''
    })
    .filter((s) => s !== '')
    .join('\n')
}

/** 注入来源 → 中文标签（未知来源原样显示 kind，插件来源去掉 plugin: 前缀）。 */
const CONTEXT_LABELS: Record<string, string> = {
  'agent-instructions': '工作区指令',
  'skill-catalog': '技能目录',
  'skill-invocation': '技能',
  'runtime-context': '运行环境',
  'time-context': '时间',
  'agent-message': '代理消息',
  'subagent-settled': '子代理结果',
  'subagent-report': '子代理汇报',
  'tool-jobs': '后台任务',
  'model-selection': '模型切换',
  'repeat-tool-reminder': '重复调用提醒',
  goal: '目标',
  'tool-goal': '目标',
  schedule: '定时任务',
  'working-directory': '工作目录',
  'user-approval': '审批策略',
  'user-question-reply': '提问回复',
  'session-reference': '跨会话召回',
  plugin: '插件',
  bot: 'Bot'
}

/** 一条非人类 user/message → 上下文条目。 */
export function contextEntry(source: Record<string, unknown>, content: unknown): ContextEntry {
  const kind = str(source.kind) ?? '上下文'
  let label = CONTEXT_LABELS[kind] ?? (kind.startsWith('plugin:') ? kind.slice(7) : kind)
  const name = str(source.name)
  if (kind === 'skill-invocation' && name !== undefined) label = `技能：${name}`
  return { label, text: textOfContent(content) }
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** deliverables/presented.data.files → 文件列表（坏条目跳过）。 */
export function presentedFiles(data: unknown): PresentedFile[] {
  const out: PresentedFile[] = []
  for (const f of arr(rec(data)?.files)) {
    const o = rec(f)
    const path = str(o?.path)
    if (path === undefined || path === '') continue
    const file: PresentedFile = { path, name: basenameOf(path) }
    const description = str(o?.description)
    if (description !== undefined && description !== '') file.description = description
    out.push(file)
  }
  return out
}

/** 列表尾部是否已有「正在进行」的可见内容（流式文本 / 思考，或运行中的工具），有就不需要占位。 */
function tailActive(items: readonly ChatItem[]): boolean {
  const last = items[items.length - 1]
  if (last === undefined) return false
  if (last.kind === 'text' || last.kind === 'reasoning') return last.streaming === true
  return last.kind === 'tool' && last.status === 'running'
}

/**
 * 按需在末尾放「思考中」占位（先去掉已有的，保证它总在最后，例如乐观用户气泡之后）。
 * @param waiting 是否在等助手输出：会话运行中，或刚发出、宿主还没回显 turn/start。
 */
export function withThinking(items: readonly ChatItem[], waiting: boolean): ChatItem[] {
  const rest = items.filter((i) => i.kind !== 'thinking')
  if (!waiting || tailActive(rest)) return rest.length === items.length ? (items as ChatItem[]) : rest
  return [...rest, { kind: 'thinking', key: 'thinking' }]
}

function failureMessage(reason: Record<string, unknown> | undefined): string {
  const err = rec(reason?.error)
  return str(err?.message) ?? str(err?.code) ?? '未知错误'
}

export interface Transcript {
  items: ChatItem[]
  /** 已落盘的用户 prompt 的 requestId（source.rpcId），用于收掉本地乐观气泡。 */
  rpcIds: Set<string>
}

/**
 * 事件 + 正在生成的 attempt → 消息列表。
 * @param events 升序、去重后的事件
 * @param live 正在生成的 attempt（若对应 durable assistant/message 已到，会自动忽略）
 */
export function buildTranscript(events: readonly WireEvent[], live?: LiveAttempt): Transcript {
  const items: ChatItem[] = []
  const rpcIds = new Set<string>()
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }> & { turn: number }>()
  const durableSteps = new Set<string>()
  const presented = new Map<number, { key: string; files: PresentedFile[] }>()
  /** 交付文件放在 turn 末尾（与桌面 turnTail 一致）；turn 未结束时放在列表最后。 */
  const flushPresented = (turn: number | undefined): void => {
    for (const [t, g] of [...presented]) {
      if (turn !== undefined && t > turn) continue
      items.push({ kind: 'files', key: g.key, files: g.files })
      presented.delete(t)
    }
  }

  const pushAssistantBlocks = (turn: number, step: number, blocks: AssembledBlock[], durations: number[], streaming: boolean): void => {
    let r = 0
    blocks.forEach((b, i) => {
      const key = `b${turn}.${step}.${i}`
      if (b.type === 'text') {
        if (b.text.trim() === '') return
        items.push(streaming ? { kind: 'text', key, text: b.text, streaming: true } : { kind: 'text', key, text: b.text })
      } else if (b.type === 'reasoning') {
        const d = durations[r++]
        // 流式中的空思考块也要显示：不少模型只回传空 reasoning（思考内容不可见），否则整段思考期界面一片空白。
        if (b.text.trim() === '' && !streaming) return
        const item: ChatItem = { kind: 'reasoning', key, text: b.text }
        if (d !== undefined && d > 0) item.durationMs = d
        if (streaming) item.streaming = true
        items.push(item)
      } else {
        const callId = b.id ?? `${key}`
        if (tools.has(callId)) return
        const tool = { kind: 'tool' as const, key: `t${callId}`, callId, name: b.name ?? '工具', argsText: b.text, status: 'running' as ToolStatus, turn }
        tools.set(callId, tool)
        items.push(tool)
      }
    })
  }

  for (const e of events) {
    const d = rec(e.data)
    switch (e.type) {
      case 'user/message': {
        if (!isAppend(e) || d === undefined) break
        const source = rec(d.source)
        if (source !== undefined && source.kind !== 'user') {
          const entry = contextEntry(source, d.content)
          const last = items[items.length - 1]
          if (last?.kind === 'context') last.entries.push(entry)
          else items.push({ kind: 'context', key: `x${e.seq}`, entries: [entry] })
          break
        }
        const rpcId = str(source?.rpcId)
        if (rpcId !== undefined) rpcIds.add(rpcId)
        const images: ImageAtt[] = []
        const files: FileAtt[] = []
        for (const b of arr(d.content)) {
          const o = rec(b)
          const att = rec(o?.attachment)
          if (o?.type === 'image' && att !== undefined) images.push({ ref: att, name: str(att.name), mediaType: str(att.mediaType) })
          else if (o?.type === 'file' && att !== undefined) files.push({ name: str(att.name) ?? '文件', bytes: num(att.bytes) })
        }
        items.push({ kind: 'user', key: `u${e.seq}`, seq: e.seq, text: textOfContent(d.content), images, files })
        break
      }
      case 'assistant/message': {
        if (!isAppend(e) || d === undefined) break
        const turn = num(d.turn) ?? 0
        const step = num(d.step) ?? 0
        durableSteps.add(`${turn}.${step}`)
        const msg = rec(d.message)
        const blocks: AssembledBlock[] = arr(msg?.content).flatMap((b): AssembledBlock[] => {
          const o = rec(b)
          if (o?.type === 'text' || o?.type === 'reasoning') return [{ type: o.type, text: str(o.text) ?? '' }]
          if (o?.type === 'tool-call') return [{ type: 'tool-call', text: str(o.arguments) ?? '', id: str(o.id), name: str(o.name) }]
          return []
        })
        pushAssistantBlocks(turn, step, blocks, reasoningDurations(arr(d.stream)), false)
        if (d.interrupted === true) items.push({ kind: 'notice', key: `n${e.seq}`, text: '已中断', tone: 'info' })
        break
      }
      case 'tool/call': {
        if (d === undefined) break
        const callId = str(d.callId)
        if (callId === undefined || tools.has(callId)) break
        const tool = { kind: 'tool' as const, key: `t${callId}`, callId, name: str(d.name) ?? '工具', argsText: str(d.arguments) ?? '', status: 'running' as ToolStatus, turn: num(d.turn) ?? 0 }
        tools.set(callId, tool)
        items.push(tool)
        break
      }
      case 'tool/result': {
        if (!isAppend(e) || d === undefined) break
        const msg = rec(d.message)
        const callId = str(msg?.toolCallId)
        const tool = callId === undefined ? undefined : tools.get(callId)
        if (tool === undefined) break
        const isError = msg?.isError === true
        tool.status = isError ? 'error' : 'ok'
        const reason = str(rec(d.error)?.reason)
        const text = toolResultText(msg?.content)
        tool.result = reason !== undefined && !text.includes(reason) ? `${reason}\n${text}` : text
        if (d.meta !== undefined) tool.meta = d.meta
        break
      }
      case 'deliverables/presented': {
        const turn = num(d?.turn) ?? 0
        const files = presentedFiles(d)
        if (files.length === 0) break
        const group = presented.get(turn)
        if (group === undefined) presented.set(turn, { key: `f${e.seq}`, files })
        else group.files.push(...files)
        break
      }
      case 'turn/end': {
        const turn = num(d?.turn)
        flushPresented(turn)
        for (const t of tools.values()) if (t.status === 'running' && (turn === undefined || t.turn <= turn)) t.status = 'interrupted'
        const reason = rec(d?.reason)
        if (reason?.kind === 'error') items.push({ kind: 'notice', key: `n${e.seq}`, text: `出错：${failureMessage(reason)}`, tone: 'error' })
        else if (reason?.kind === 'aborted') items.push({ kind: 'notice', key: `n${e.seq}`, text: '已停止', tone: 'info' })
        else if (reason?.kind === 'max-tokens') items.push({ kind: 'notice', key: `n${e.seq}`, text: '输出达到长度上限', tone: 'info' })
        break
      }
      default:
        break
    }
  }

  if (live !== undefined && !durableSteps.has(`${live.turn}.${live.step}`)) {
    const blocks = assembleChunks(live.chunks)
    const durations = blocks.filter((b) => b.type === 'reasoning').map((b) => (b.t0 !== undefined && b.t1 !== undefined ? b.t1 - b.t0 : 0))
    pushAssistantBlocks(live.turn, live.step, blocks, durations, true)
  }
  flushPresented(undefined)

  // 结果到达前的工具不带 turn 字段给界面（只是内部配对用）。
  for (const t of tools.values()) delete (t as { turn?: number }).turn
  // live 已落盘（等 follow 收掉）时不算「在等输出」，否则 durable 文本后面会闪一下占位。
  const running = (live !== undefined && !durableSteps.has(`${live.turn}.${live.step}`)) || isRunning(events) === true
  return { items: withThinking(items, running), rpcIds }
}
