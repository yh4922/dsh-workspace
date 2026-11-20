/*
 * @Description: H5 终端快捷键条 —— 按键 → 终端输入序列（纯函数，便于单测）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:00:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/keys.ts
 *
 * 手机软键盘没有 Tab / Esc / Ctrl / 方向键。Ctrl 做成「粘滞修饰」：点一下后，下一个按键（快捷键条或软键盘）按 Ctrl 组合发送。
 */

export type QuickKey = 'tab' | 'esc' | 'up' | 'down' | 'left' | 'right' | 'pipe' | 'slash' | 'tilde'

export const QUICK_KEYS: ReadonlyArray<{ key: QuickKey; label: string }> = [
  { key: 'tab', label: 'Tab' },
  { key: 'esc', label: 'Esc' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'left', label: '←' },
  { key: 'right', label: '→' },
  { key: 'pipe', label: '|' },
  { key: 'slash', label: '/' },
  { key: 'tilde', label: '~' }
]

const ARROW: Record<'up' | 'down' | 'left' | 'right', string> = { up: 'A', down: 'B', right: 'C', left: 'D' }

/**
 * 单个字符的 Ctrl 组合（与 xterm 键盘处理一致）：字母 → 0x01~0x1a；@ / 空格 → NUL；[ \ ] ^ _ → 0x1b~0x1f；? → DEL。
 * 其他字符无 Ctrl 含义，原样返回。
 */
export function ctrlChar(ch: string): string {
  if (ch.length !== 1) return ch
  const c = ch.toUpperCase().charCodeAt(0)
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c - 0x40)
  if (ch === '@' || ch === ' ' || ch === '2') return '\x00'
  if (ch === '[' || ch === '3') return '\x1b'
  if (ch === '\\' || ch === '4') return '\x1c'
  if (ch === ']' || ch === '5') return '\x1d'
  if (ch === '^' || ch === '6') return '\x1e'
  if (ch === '_' || ch === '-' || ch === '7') return '\x1f'
  if (ch === '?' || ch === '8') return '\x7f'
  return ch
}

/** 软键盘输入经 Ctrl 改写：只改写第一个字符（粘滞修饰只作用一次），其余原样。 */
export function applyCtrl(data: string): string {
  if (data === '') return data
  const first = [...data][0] as string
  return ctrlChar(first) + data.slice(first.length)
}

/**
 * 快捷键 → 序列。
 * @param ctrl 粘滞 Ctrl 是否按下：方向键发 CSI 1;5 x，其余字符按 ctrlChar。
 * @param appCursor 终端处于应用光标键模式时方向键发 SS3（ESC O x）。
 */
export function quickKeySequence(key: QuickKey, ctrl: boolean, appCursor: boolean): string {
  switch (key) {
    case 'tab':
      return ctrl ? ctrlChar('i') : '\t'
    case 'esc':
      return '\x1b'
    case 'pipe':
      return ctrl ? ctrlChar('\\') : '|'
    case 'slash':
      return ctrl ? ctrlChar('_') : '/'
    case 'tilde':
      return ctrl ? ctrlChar('^') : '~'
    default: {
      const code = ARROW[key]
      if (ctrl) return `\x1b[1;5${code}`
      return appCursor ? `\x1bO${code}` : `\x1b[${code}`
    }
  }
}
