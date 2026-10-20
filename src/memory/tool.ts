/*
 * @Description: 作用域记忆 —— 主模型工具 scoped_memory
 * @Author: YangHeng
 * @Date: 2026-10-16 20:00:00
 * @FilePath: /dsh-workspace/src/memory/tool.ts
 *
 * 会话层直接写；项目 / 全局只生成待选记忆（用户审批后生效）。不提供删除 —— 删除只能由用户在界面上做。
 * 只能读写当前会话所属项目与全局（R2.7）。
 */
import { IMPORTANCE, MEMORY_SECTIONS, SECTION_LABELS, type Importance, type MemoryEntry, type MemorySection } from '../wire/memory.js'
import type { MemoryService } from './service.js'
import type { ScopeResolver } from './scope.js'

export const MEMORY_TOOL_NAME = 'scoped_memory'

export interface MemoryToolArgs {
  action: 'add' | 'update' | 'disable' | 'list' | 'search'
  layer?: 'session' | 'project' | 'global'
  section?: MemorySection
  title?: string
  content?: string
  id?: string
  importance?: Importance
  query?: string
}

export interface MemoryToolValue {
  ok: boolean
  message: string
  entries?: Array<{ id: string; layer: string; section?: string; title?: string; content: string; enabled: boolean }>
}

interface ToolExecLike {
  agent?: { id?: string; session?: { id?: string } }
}

export interface MemoryToolDeps {
  service: MemoryService
  scope: ScopeResolver
}

function brief(e: MemoryEntry): NonNullable<MemoryToolValue['entries']>[number] {
  return { id: e.id, layer: e.layer, ...(e.section !== undefined ? { section: e.section } : {}), ...(e.title !== undefined ? { title: e.title } : {}), content: e.content, enabled: e.enabled }
}

function titleOf(args: MemoryToolArgs): { title?: string } {
  return args.title !== undefined && args.title.trim() !== '' ? { title: args.title } : {}
}

/** 执行一次工具调用（导出给测试）。参数错误以 ok:false 返回，让模型自己改正，而不是抛成工具错误。 */
export async function executeMemoryTool(deps: MemoryToolDeps, sessionId: string, args: MemoryToolArgs): Promise<MemoryToolValue> {
  const { store } = deps.service
  const layer = args.layer ?? 'session'
  const { projectId } = await deps.scope.ensure(sessionId)
  const source = { by: 'assistant' as const, sessionId }
  switch (args.action) {
    case 'add': {
      const content = args.content?.trim() ?? ''
      if (content === '') return { ok: false, message: 'add 需要 content。' }
      if (layer === 'session') {
        const entry = store.add({ layer: 'session', sessionId }, { ...titleOf(args), content, section: args.section ?? 'facts', ...(args.importance !== undefined ? { importance: args.importance } : {}) }, source)
        return { ok: true, message: `已写入会话记忆（${SECTION_LABELS[entry.section ?? 'facts']}）。`, entries: [brief(entry)] }
      }
      if (layer === 'project' && projectId === null) return { ok: false, message: '当前会话不属于任何已登记的工作区，不能写项目记忆；可写会话记忆或全局记忆。' }
      const candidate = store.propose({ layer, projectId, ...titleOf(args), content, ...(args.importance !== undefined ? { importance: args.importance } : {}), source })
      if (candidate === undefined) return { ok: true, message: `${layer === 'project' ? '项目' : '全局'}记忆里已有相同内容，无需重复记录。` }
      return { ok: true, message: `已提交为待选${layer === 'project' ? '项目' : '全局'}记忆，等待用户在「记忆」面板审批后生效（不要声称已经记住）。` }
    }
    case 'update':
    case 'disable': {
      // 只允许直接改会话层；项目 / 全局的修改要走待选（用户把关）
      if (layer !== 'session') {
        if (args.action === 'disable') return { ok: false, message: '项目 / 全局记忆只能由用户在「记忆」面板里禁用或删除；如需修正，请用 add 提交一条新的待选记忆说明更正内容。' }
        const content = args.content?.trim() ?? ''
        if (content === '') return { ok: false, message: 'update 需要 content。' }
        if (layer === 'project' && projectId === null) return { ok: false, message: '当前会话不属于任何已登记的工作区。' }
        store.propose({ layer, projectId, ...titleOf(args), content, ...(args.importance !== undefined ? { importance: args.importance } : {}), source })
        return { ok: true, message: '已提交为待选记忆（修正版），等待用户审批。' }
      }
      if (args.id === undefined || args.id === '') return { ok: false, message: `${args.action} 需要 id（先用 list 查看）。` }
      const scope = { layer: 'session' as const, sessionId }
      if (!store.list(scope).some((e) => e.id === args.id)) return { ok: false, message: `本会话没有 id 为 ${args.id} 的记忆。` }
      if (args.action === 'disable') {
        const entry = store.update(scope, args.id, { enabled: false }, 'assistant')
        return { ok: true, message: '已禁用。', entries: [brief(entry)] }
      }
      const content = args.content?.trim()
      if ((content === undefined || content === '') && args.title === undefined && args.section === undefined && args.importance === undefined) return { ok: false, message: 'update 至少要给 content / section / importance 之一。' }
      const entry = store.update(
        scope,
        args.id,
        { ...titleOf(args), ...(content !== undefined && content !== '' ? { content } : {}), ...(args.section !== undefined ? { section: args.section } : {}), ...(args.importance !== undefined ? { importance: args.importance } : {}) },
        'assistant'
      )
      return { ok: true, message: '已更新。', entries: [brief(entry)] }
    }
    case 'list': {
      const entries =
        layer === 'session'
          ? store.list({ layer: 'session', sessionId })
          : layer === 'project'
            ? projectId === null
              ? []
              : store.list({ layer: 'project', projectId })
            : store.list({ layer: 'global' })
      return { ok: true, message: entries.length === 0 ? '没有记忆。' : `共 ${entries.length} 条。`, entries: entries.map(brief) }
    }
    case 'search': {
      const query = args.query?.trim() ?? args.content?.trim() ?? ''
      if (query === '') return { ok: false, message: 'search 需要 query。' }
      const hits = await deps.service.search(query, sessionId)
      return { ok: true, message: hits.length === 0 ? '没有匹配的记忆。' : `找到 ${hits.length} 条。`, entries: hits.slice(0, 50).map((h) => brief(h.entry)) }
    }
  }
}

function formatValue(value: MemoryToolValue): string {
  const lines = [value.message]
  for (const e of value.entries ?? []) {
    lines.push(`- [${e.id}] (${e.layer}${e.section !== undefined ? `/${e.section}` : ''}${e.enabled ? '' : '，已禁用'}) ${e.title !== undefined ? `【${e.title}】` : ''}${e.content}`)
  }
  return lines.join('\n')
}

/** 工具定义（交给宿主 defineTool）。 */
export function memoryToolDefinition(deps: MemoryToolDeps): unknown {
  return {
    name: MEMORY_TOOL_NAME,
    description:
      'Scoped memory for this conversation, its project (workspace) and the user globally. ' +
      'Use it when the user explicitly asks you to remember / forget / correct something, or to look up what was remembered. ' +
      'layer=session (default) is this conversation\'s running summary and takes effect immediately; sections: ' +
      MEMORY_SECTIONS.map((s) => `${s}=${SECTION_LABELS[s]}`).join(', ') +
      '. layer=project / global only create a pending candidate that the user must approve in the Memory panel — never claim it is already remembered. ' +
      'Actions: add, update (session: by id; project/global: submits a corrected candidate), disable (session only), list, search (current project and global only). There is no delete. ' +
      'A background summarizer also maintains session memory, so do not call this after every message.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'update', 'disable', 'list', 'search'], description: 'What to do.' },
      layer: { type: 'string', enum: ['session', 'project', 'global'], description: 'Memory layer (default session).' },
      section: { type: 'string', enum: [...MEMORY_SECTIONS], description: 'Session section for add/update (default facts).' },
      title: { type: 'string', description: 'Short title (one line, under 20 words) summarising the memory. Recommended for add.' },
      content: { type: 'string', description: 'Memory text for add/update. Keep the user\'s own wording for requests and corrections.' },
      id: { type: 'string', description: 'Entry id for session update/disable (from list).' },
      importance: { type: 'string', enum: [...IMPORTANCE], description: 'high / medium / low (default medium).' },
      query: { type: 'string', description: 'Keywords for search (space separated, all must match).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the action succeeded.' },
          message: { type: 'string', required: true, description: 'Result message.' },
          entries: {
            type: 'array',
            description: 'Affected or listed entries.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                section: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true }
              }
            }
          }
        }
      },
      render: (_args: unknown, value: MemoryToolValue) => [{ type: 'text', text: formatValue(value) }]
    },
    async execute(args: unknown, exec: unknown) {
      const e = exec as ToolExecLike
      const sessionId = e.agent?.session?.id ?? e.agent?.id
      if (sessionId === undefined) return { ok: false, message: '无法确定当前会话。' }
      return await executeMemoryTool(deps, sessionId, args as MemoryToolArgs)
    }
  }
}
