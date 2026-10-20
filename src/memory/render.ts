/*
 * @Description: 作用域记忆 —— 注入文本渲染（纯函数）
 * @Author: YangHeng
 * @Date: 2026-10-16 19:15:00
 * @FilePath: /dsh-workspace/src/memory/render.ts
 *
 * 只渲染已启用的条目，不设体积上限；排序：置顶 > 高 > 中 > 低。
 * 文本要稳定：同样的数据必须渲染出逐字相同的字符串，宿主据此判断「没变就不重复追加」。
 */
import { MEMORY_SECTIONS, SECTION_LABELS, compareEntries, type MemoryEntry } from '../wire/memory.js'

/** 分支过滤：限定了分支的条目，只有当前分支已知且在列表里才注入（读不到分支一律不注入）。 */
export function branchVisible(entry: MemoryEntry, branch: string | undefined): boolean {
  if (entry.branches === undefined || entry.branches.length === 0) return true
  return branch !== undefined && entry.branches.includes(branch)
}

function bullet(entry: MemoryEntry): string {
  const tags: string[] = []
  if (entry.pinned) tags.push('置顶')
  if (entry.importance === 'high') tags.push('重要')
  const prefix = tags.length > 0 ? `[${tags.join('·')}] ` : ''
  // 多行内容缩进到同一条目下，避免被模型当成新的列表项；
  // 拆开 {{：宿主提示词会把 {{name}} 当变量插值，未知变量直接抛错（整步失败）
  return `- ${prefix}${entry.content.replace(/\{\{/g, '{ {').replace(/\r?\n/g, '\n  ')}`
}

function enabledSorted(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => e.enabled).sort(compareEntries)
}

export interface LongTermInput {
  global: readonly MemoryEntry[]
  project?: { title: string; entries: readonly MemoryEntry[] }
  branch?: string
}

/** 全局 + 项目记忆。两层都没有可注入条目时返回空串。 */
export function renderLongTerm(input: LongTermInput): string {
  const global = enabledSorted(input.global)
  const project = input.project === undefined ? [] : enabledSorted(input.project.entries).filter((e) => branchVisible(e, input.branch))
  if (global.length === 0 && project.length === 0) return ''
  const lines = [
    '# 作用域记忆',
    '以下是用户确认过的长期记忆，请遵守。冲突时越具体越优先：会话记忆 > 项目记忆 > 全局记忆。'
  ]
  if (project.length > 0) {
    lines.push('', `## 项目记忆（${input.project?.title ?? ''}）`, ...project.map(bullet))
  }
  if (global.length > 0) {
    lines.push('', '## 全局记忆', ...global.map(bullet))
  }
  return lines.join('\n')
}

/** 会话记忆（按固定分节）。没有可注入条目时返回空串。 */
export function renderSession(entries: readonly MemoryEntry[]): string {
  const enabled = entries.filter((e) => e.enabled)
  if (enabled.length === 0) return ''
  const lines = [
    '# 会话记忆',
    '这是本次对话的持续摘要（对话被压缩后以此为准继续工作）。用户的纠正与已排除方案务必遵守，不要重复提议已排除的方案。'
  ]
  for (const section of MEMORY_SECTIONS) {
    const items = enabled.filter((e) => (e.section ?? 'facts') === section).sort(compareEntries)
    if (items.length === 0) continue
    lines.push('', `## ${SECTION_LABELS[section]}`, ...items.map(bullet))
  }
  return lines.join('\n')
}
