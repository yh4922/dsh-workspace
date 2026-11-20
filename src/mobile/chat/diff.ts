/*
 * @Description: H5 会话 —— edit / write 类工具的简单行级 diff（LCS），以及从工具参数 / 结果 meta 提取 diff
 * @Author: YangHeng
 * @Date: 2026-11-19 16:25:00
 * @FilePath: /dsh-workspace/src/mobile/chat/diff.ts
 */

export interface DiffLine {
  kind: ' ' | '-' | '+'
  text: string
}

export interface FileDiffView {
  path?: string
  lines: DiffLine[]
}

/** 超过这个行数乘积就不做 LCS（O(n·m) 内存），退化为「全删 + 全增」。 */
const LCS_LIMIT = 250_000

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  if (a.length * b.length > LCS_LIMIT) {
    return [...a.map((text) => ({ kind: '-' as const, text })), ...b.map((text) => ({ kind: '+' as const, text }))]
  }
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（一维数组按行存）
  const dp = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number): number => dp[i * (m + 1) + j] as number
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i] as string })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) out.push({ kind: '-', text: a[i++] as string })
    else out.push({ kind: '+', text: b[j++] as string })
  }
  while (i < n) out.push({ kind: '-', text: a[i++] as string })
  while (j < m) out.push({ kind: '+', text: b[j++] as string })
  return out
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * 提取工具调用的 diff：优先结果 meta.diffs（dsh-tool-fs 写入，带上下文），否则用参数 old_string/new_string、
 * content（write）推断。无法推断返回 undefined。
 */
export function toolDiffs(name: string, args: Record<string, unknown> | undefined, meta: unknown): FileDiffView[] | undefined {
  const diffs = rec(meta)?.diffs
  if (Array.isArray(diffs) && diffs.length > 0) {
    const views: FileDiffView[] = []
    for (const d of diffs) {
      const r = rec(d)
      const newText = str(r?.newText)
      if (r === undefined || newText === undefined) continue
      const oldText = r.oldText === null ? '' : (str(r.oldText) ?? '')
      views.push({ path: str(r.path), lines: lineDiff(oldText, newText) })
    }
    if (views.length > 0) return views
  }
  if (args === undefined) return undefined
  const path = str(args.file_path) ?? str(args.path) ?? str(args.filePath)
  const oldS = str(args.old_string) ?? str(args.oldString) ?? str(args.old_str)
  const newS = str(args.new_string) ?? str(args.newString) ?? str(args.new_str)
  if (oldS !== undefined && newS !== undefined) return [{ path, lines: lineDiff(oldS, newS) }]
  if (/write|create/i.test(name)) {
    const content = str(args.content) ?? str(args.file_text)
    if (content !== undefined) return [{ path, lines: lineDiff('', content) }]
  }
  return undefined
}
