/*
 * @Description: H5 会话 —— 工具调用卡片的「主参数摘要」（折叠态显示一行）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:55:00
 * @FilePath: /dsh-workspace/src/mobile/chat/tool-summary.ts
 */
import { wholeFileRef, type FileRef } from './links.js'

/** 按优先级尝试的主参数名：路径类在前（可点开文件），其次命令 / 查询 / URL。 */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path', 'target', 'cwd']
const MAIN_KEYS = ['command', 'cmd', 'pattern', 'query', 'queries', 'url', 'prompt', 'description', 'name', 'skill', 'objective', 'content']

export function parseArgs(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function oneLine(v: unknown): string | undefined {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim()
  if (Array.isArray(v)) {
    const parts = v.map(oneLine).filter((s): s is string => s !== undefined && s !== '')
    return parts.length > 0 ? parts.join(', ') : undefined
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

export interface ToolSummary {
  text: string
  ref?: FileRef
}

/** 工具参数（原始 JSON 串，流式时可能不完整）→ 一行摘要；路径参数附带文件引用。 */
export function toolSummary(_name: string, argsText: string): ToolSummary {
  const args = parseArgs(argsText)
  if (args === undefined) return { text: argsText.replace(/\s+/g, ' ').slice(0, 200) }
  for (const k of PATH_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') {
      const ref = wholeFileRef(v) ?? { path: v }
      const line = typeof args.line === 'number' ? args.line : typeof args.offset === 'number' && args.offset > 0 ? args.offset : undefined
      if (k !== 'cwd' && line !== undefined && ref.line === undefined) ref.line = line
      return { text: v, ref }
    }
  }
  for (const k of MAIN_KEYS) {
    const s = oneLine(args[k])
    if (s !== undefined && s !== '') return { text: s.slice(0, 200) }
  }
  for (const v of Object.values(args)) {
    const s = oneLine(v)
    if (s !== undefined && s !== '') return { text: s.slice(0, 200) }
  }
  return { text: '' }
}
