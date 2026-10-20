/*
 * @Description: 作用域记忆 —— 挂到宿主：系统提示词、生命周期事件、scoped_memory 工具
 * @Author: YangHeng
 * @Date: 2026-10-16 20:20:00
 * @FilePath: /dsh-workspace/src/memory/mount.ts
 *
 * 注入方式选 systemPrompt.section 而不是 context：
 *   context 快照是「所有 context 拼成一份、整份比较」，别的 context（时间等）一变整份重发进历史，
 *   记忆跟着一遍遍重复 —— 这正是要替换的 memory-evolve 费 token 的原因。
 *   section 每步重建但不进历史，文本稳定时命中提示词缓存；长期记忆很少变，会话记忆用冻结版本。
 */
import type { MemoryRuntime } from './runtime.js'
import { renderLongTerm, renderSession } from './render.js'
import { MEMORY_TOOL_NAME, memoryToolDefinition } from './tool.js'

interface AgentLike {
  id?: string
  session?: { id?: string; header?: { cwd?: string; origin?: string; parentSession?: string; isSeeded?: boolean } }
  ctx: { inject(deps: string[], fn: (scoped: { tools: { register(def: unknown): unknown } }) => void): { dispose(): unknown } }
}

interface OnContext {
  on(name: string, listener: (...args: unknown[]) => unknown): () => void
}

interface PromptFace {
  section(section: { name: string; order: number; text: (input: { scope?: unknown }) => string }): unknown
  getSectionOrder(name: string): number
}

export const MEMORY_SECTION_NAME = 'dsh-workspace:memory'

function sessionIdOf(agent: AgentLike | undefined): string | undefined {
  return agent?.session?.id ?? agent?.id
}

function isSubagent(agent: AgentLike | undefined): boolean {
  return agent?.session?.header?.origin === 'subagent'
}

/** 系统提示词片段的文本（导出给测试）。 */
export function memoryPromptText(mem: MemoryRuntime, agent: AgentLike | undefined): string {
  if (!mem.store.getSettings().enabled) return ''
  const sid = sessionIdOf(agent)
  // 子代理不注入：它只做被委派的一小块任务，长期记忆由主会话把关，省 token
  if (sid === undefined || isSubagent(agent)) return ''
  const scope = mem.scope.cached(sid)
  const projectId = scope?.projectId ?? null
  const longTerm = renderLongTerm({
    global: mem.store.list({ layer: 'global' }),
    ...(projectId !== null
      ? { project: { title: scope?.workspace?.title ?? projectTitle(scope?.workspace?.path ?? projectId), entries: mem.store.list({ layer: 'project', projectId }) } }
      : {}),
    ...(mem.branchOf(sid) !== undefined ? { branch: mem.branchOf(sid) as string } : {})
  })
  const session = renderSession(mem.frozen.get(sid) ?? [])
  return [longTerm, session].filter((t) => t !== '').join('\n\n')
}

function projectTitle(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== '')
  return parts[parts.length - 1] ?? p
}

export function mountMemoryPrompt(ctx: unknown, mem: MemoryRuntime): void {
  const prompt = (ctx as { systemPrompt: PromptFace }).systemPrompt
  let order = 1000
  try {
    order = prompt.getSectionOrder('WEB_SURFACE') + 1
  } catch {
    /* 宿主未定义该锚点：用默认顺序 */
  }
  const disposer = prompt.section({
    name: MEMORY_SECTION_NAME,
    order,
    text: ({ scope }) => {
      try {
        return memoryPromptText(mem, scope as AgentLike | undefined)
      } catch {
        // 读盘失败等异常不能让整步失败
        return ''
      }
    }
  })
  if (typeof disposer === 'function') (ctx as { effect(fn: () => () => void, label: string): void }).effect(() => disposer as () => void, 'dsh-workspace: memory prompt')
}

/**
 * 生命周期事件 + 工具。返回撤销函数（挂在 ctx.effect 上）。
 * @param defineTool 宿主 defineTool（缺省时不注册工具）
 */
export function mountMemoryEvents(ctx: unknown, mem: MemoryRuntime, defineTool: ((d: unknown) => unknown) | undefined): () => void {
  const c = ctx as OnContext
  const agents = new Map<string, AgentLike>()
  const toolFibers = new Map<AgentLike, { dispose(): unknown }>()
  /** 压缩摘要：compaction/summary 先到，compaction/end 时使用。 */
  const pendingSummary = new Map<string, string>()

  const syncTool = (agent: AgentLike): void => {
    const settings = mem.store.getSettings()
    const want = settings.enabled && settings.toolEnabled && defineTool !== undefined && !isSubagent(agent)
    const fiber = toolFibers.get(agent)
    if (want && fiber === undefined) {
      try {
        const next = agent.ctx.inject(['tools'], (scoped) => {
          scoped.tools.register((defineTool as (d: unknown) => unknown)(memoryToolDefinition({ service: mem.service, scope: mem.scope })))
        })
        toolFibers.set(agent, next)
      } catch {
        /* 工具注册失败不影响对话 */
      }
    } else if (!want && fiber !== undefined) {
      toolFibers.delete(agent)
      void fiber.dispose()
    }
  }

  const offCreated = c.on('agent/created', async (payload: unknown) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    const sid = sessionIdOf(agent)
    if (agent === undefined || sid === undefined) return
    agents.set(sid, agent)
    try {
      await mem.scope.ensure(sid)
      const header = agent.session?.header
      // 分叉：子会话继承父会话当时的会话记忆（子代理也带 parentSession，用 origin 排除）
      if (header?.parentSession !== undefined && header.isSeeded === true && header.origin !== 'subagent') {
        await mem.scope.ensure(header.parentSession)
        mem.store.copySession(header.parentSession, sid)
      }
      mem.freeze(sid)
      syncTool(agent)
      if (mem.store.getSettings().enabled) void mem.refreshBranch(sid, true).catch(() => undefined)
    } catch {
      /* agent/created 的监听会被 await，抛错会让会话创建失败：一律吞掉 */
    }
  })

  const offTurn = c.on('agent/turn-stopping', (payload: unknown) => {
    const p = payload as { agent?: AgentLike; turn?: number } | undefined
    const sid = sessionIdOf(p?.agent)
    if (sid === undefined || isSubagent(p?.agent)) return
    try {
      mem.summarizer.onTurn(sid, typeof p?.turn === 'number' ? p.turn : undefined)
      if (mem.store.getSettings().enabled) void mem.refreshBranch(sid, true).catch(() => undefined)
    } catch {
      /* 不影响回合结束 */
    }
  })

  const offDisposed = c.on('agent/disposed', (payload: unknown) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    const sid = sessionIdOf(agent)
    if (agent === undefined) return
    const fiber = toolFibers.get(agent)
    if (fiber !== undefined) {
      toolFibers.delete(agent)
      void fiber.dispose()
    }
    if (sid !== undefined && agents.get(sid) === agent) {
      agents.delete(sid)
      mem.forget(sid)
      pendingSummary.delete(sid)
    }
  })

  const offEvent = c.on('session/event', (session: unknown, event: unknown) => {
    const sid = (session as { id?: string } | undefined)?.id
    const e = event as { type?: string; data?: { summary?: unknown } } | undefined
    if (sid === undefined || e === undefined) return
    if (e.type === 'compaction/summary') {
      const blocks = Array.isArray(e.data?.summary) ? (e.data?.summary as Array<{ type?: string; text?: string }>) : []
      pendingSummary.set(sid, blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(''))
    } else if (e.type === 'compaction/end') {
      // 压缩完成：先把现有会话记忆冻结进提示词（立即兜底），再后台补漏；补漏写完会再刷新一次
      mem.freeze(sid)
      const summary = pendingSummary.get(sid)
      pendingSummary.delete(sid)
      if (mem.store.getSettings().enabled && summary !== undefined && summary !== '') {
        mem.summarizer.request({ sessionId: sid, mode: 'compaction', compactionSummary: summary })
      }
    }
  })

  // 设置变化（开关 / 工具开关）对已打开的会话即时生效
  const offSettings = mem.store.subscribe((change) => {
    if (change.key !== 'settings') return
    for (const agent of agents.values()) syncTool(agent)
  })

  return () => {
    offCreated()
    offTurn()
    offDisposed()
    offEvent()
    offSettings()
    for (const fiber of toolFibers.values()) void fiber.dispose()
    toolFibers.clear()
    agents.clear()
  }
}

export { MEMORY_TOOL_NAME }
