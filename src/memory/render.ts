/*
 * @Description: 作用域记忆 —— 注入文本渲染（纯函数）
 * @Author: YangHeng
 * @Date: 2026-10-16 19:15:00
 * @FilePath: /dsh-workspace/src/memory/render.ts
 *
 * 只渲染已启用的条目，不设体积上限；排序：置顶 > 高 > 中 > 低。
 * 文本要稳定：同样的数据必须渲染出逐字相同的字符串，宿主据此判断「没变就不重复追加」。
 *
 * 格式为提高遵守度而设计（2026-10-30）：
 *   - 整段包在 <user_memory> / <session_memory> 标签里：和周围大段 Markdown 规则划清边界，
 *     中转网关把系统提示词降成 user 消息时也依然醒目；
 *   - 引导语写明优先级高于宿主默认风格，块尾再放一句自检（利用近因效应）；
 *   - 条目编号 P1 / G1 / S1 便于模型引用；条目内的 Markdown 标题降级为加粗行，避免与外层 ## 同级打乱层级。
 * 不再拆 {{：section 已声明 interpolate:false（mount.ts），宿主原样保留文本。
 */
import { MEMORY_SECTIONS, SECTION_LABELS, compareEntries, type MemoryEntry } from '../wire/memory.js'

/** 分支过滤：限定了分支的条目，只有当前分支已知且在列表里才注入（读不到分支一律不注入）。 */
export function branchVisible(entry: MemoryEntry, branch: string | undefined): boolean {
  if (entry.branches === undefined || entry.branches.length === 0) return true
  return branch !== undefined && entry.branches.includes(branch)
}

/** 条目内的 Markdown 标题降级为加粗行（代码块内不动），避免与外层「## 全局记忆」等标题同级。 */
function demoteHeadings(text: string): string {
  let inFence = false
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      if (inFence) return line
      const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
      return m === null ? line : `**${m[1]}**`
    })
    .join('\n')
}

/**
 * 渲染一条记忆。
 * @param code 条目编号（P1 / G1 / S1），便于模型引用与自检
 */
function bullet(entry: MemoryEntry, code: string): string {
  const tags: string[] = []
  if (entry.pinned) tags.push('置顶')
  if (entry.importance === 'high') tags.push('重要')
  const prefix = `[${code}]${tags.length > 0 ? `[${tags.join('·')}]` : ''} `
  const title = entry.title?.trim()
  const body = demoteHeadings(entry.content)
  const text = title !== undefined && title !== '' ? `**${title}**\n${body}` : body
  // 多行内容缩进到同一条目下，避免被模型当成新的列表项
  return `- ${prefix}${text.replace(/\n/g, '\n  ')}`
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
    '<user_memory>',
    '# 作用域记忆（用户确认的长期规则）',
    '以下规则由用户亲自确认，优先级高于本系统提示词中其他默认行为与风格要求（安全规则除外）；与其他指令冲突时以此为准。越具体越优先：会话记忆 > 项目记忆 > 全局记忆。'
  ]
  if (project.length > 0) {
    lines.push('', `## 项目记忆（${input.project?.title ?? ''}）`, ...project.map((e, i) => bullet(e, `P${i + 1}`)))
  }
  if (global.length > 0) {
    lines.push('', '## 全局记忆', ...global.map((e, i) => bullet(e, `G${i + 1}`)))
  }
  lines.push('', '发出回复前，逐条确认没有违反以上记忆。', '</user_memory>')
  return lines.join('\n')
}

/** 会话记忆（按固定分节）。没有可注入条目时返回空串。 */
export function renderSession(entries: readonly MemoryEntry[]): string {
  const enabled = entries.filter((e) => e.enabled)
  if (enabled.length === 0) return ''
  const lines = [
    '<session_memory>',
    '# 会话记忆',
    '这是本次对话的持续摘要（对话被压缩后以此为准继续工作）。用户的纠正与已排除方案务必遵守，不要重复提议已排除的方案。'
  ]
  let n = 0
  for (const section of MEMORY_SECTIONS) {
    const items = enabled.filter((e) => (e.section ?? 'facts') === section).sort(compareEntries)
    if (items.length === 0) continue
    lines.push('', `## ${SECTION_LABELS[section]}`, ...items.map((e) => bullet(e, `S${(n += 1)}`)))
  }
  lines.push('</session_memory>')
  return lines.join('\n')
}
