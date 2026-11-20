/*
 * @Description: H5 会话 —— 文本中文件路径识别（src/a/b.ts、a.ts:46、绝对路径、Windows 路径）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:10:00
 * @FilePath: /dsh-workspace/src/mobile/chat/links.ts
 *
 * 纯函数，供 markdown 渲染与工具参数摘要共用。故意不用正则后行断言（(?<!)）：iOS 16.4 以前的 Safari 不支持，
 * 整个模块会直接语法错误。
 */

export interface FileRef {
  path: string
  line?: number
}

export interface TextPiece {
  text: string
  ref?: FileRef
}

/**
 * 一个路径候选：可选的盘符 / 根 / ./ 前缀 + 若干目录段 + 带扩展名的文件名 + 可选 :行号[:列号]。
 * 扩展名须以字母开头（排除 1.2.3 之类的版本号）。
 */
const PATH_RE =
  /(^|[\s"'`(（[{<>,，;；:：=])((?:[A-Za-z]:[\\/]|~[\\/]|\/|\.{1,2}[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d{1,7})(?::\d{1,5})?|#L(\d{1,7}))?(?=$|[\s"'`)）\]}<>,，;；。！？!?：:]|\.(?:\s|$))/g

/** 常见非文件的「点号单词」：域名后缀、缩写等，没有目录分隔符又没有行号时一律不当路径。 */
function plausible(path: string, hasLine: boolean): boolean {
  if (path.includes('://')) return false
  const hasSep = path.includes('/') || path.includes('\\')
  if (!hasSep && !hasLine) {
    // 无目录、无行号：只接受常见源码 / 配置扩展名，避免把 e.g.、vs.、example.com 当成文件。
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return COMMON_EXT.has(ext)
  }
  if (/^\d/.test(path) && !hasSep) return false
  return true
}

const COMMON_EXT = new Set(
  'ts tsx js jsx mjs cjs json md mdx css scss less html vue svelte py rs go java kt swift c h cpp hpp cs rb php sh ps1 yml yaml toml ini sql txt lock xml gradle'.split(
    ' '
  )
)

/** 把一段纯文本切成普通文本与文件引用。 */
export function splitFileRefs(text: string): TextPiece[] {
  const out: TextPiece[] = []
  let last = 0
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_RE.exec(text)) !== null) {
    const lead = m[1] ?? ''
    const path = m[2] ?? ''
    const lineStr = m[3] ?? m[4]
    const start = m.index + lead.length
    const end = m.index + m[0].length
    if (!plausible(path, lineStr !== undefined)) {
      // 回退到前缀后一位继续扫描，避免整段被吞掉。
      PATH_RE.lastIndex = m.index + Math.max(1, lead.length + 1)
      continue
    }
    if (start > last) out.push({ text: text.slice(last, start) })
    const ref: FileRef = { path }
    if (lineStr !== undefined) ref.line = Number(lineStr)
    out.push({ text: text.slice(start, end), ref })
    last = end
    if (m[0].length === 0) PATH_RE.lastIndex++
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** 整段文本恰好是一个文件引用（行内 code 用）。 */
export function wholeFileRef(text: string): FileRef | undefined {
  const t = text.trim()
  const pieces = splitFileRefs(t)
  return pieces.length === 1 && pieces[0]?.ref !== undefined ? pieces[0].ref : undefined
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** 相对路径按会话 cwd 拼成绝对路径（cwd 未知时原样返回）。分隔符跟随 cwd 风格。 */
export function resolvePath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || isAbsolutePath(path)) return path
  const win = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\')
  const sep = win ? '\\' : '/'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (const seg of path.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  const joined = parts.join(sep)
  return !win && !joined.startsWith('/') ? `/${joined}` : joined
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function escapeHtml(s: string): string {
  return esc(s)
}

/** 文件引用 → 可点击 chip 的 HTML（点击由容器事件代理处理，见 Markdown.tsx）。 */
export function fileChipHtml(label: string, ref: FileRef): string {
  const line = ref.line !== undefined ? ` data-line="${ref.line}"` : ''
  return `<a class="c-fl" role="button" data-path="${esc(ref.path)}"${line}>${esc(label)}</a>`
}

/** 纯文本 → 转义并把文件路径换成 chip。 */
export function linkifyText(text: string): string {
  return splitFileRefs(text)
    .map((p) => (p.ref !== undefined ? fileChipHtml(p.text, p.ref) : esc(p.text)))
    .join('')
}
