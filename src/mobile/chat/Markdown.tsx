/*
 * @Description: H5 会话 —— markdown 块（流式时实时重渲染；静止后按需加载 highlight.js 高亮代码块）
 * @Author: YangHeng
 * @Date: 2026-11-19 17:05:00
 * @FilePath: /dsh-workspace/src/mobile/chat/Markdown.tsx
 *
 * 文件 chip（.c-fl[data-path]）的点击由消息列表容器统一代理（见 pages/Session.tsx），这里只负责产出 HTML。
 */
import { memo, useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from './md-render.js'

type Hljs = { highlightElement(el: HTMLElement): void; configure(opts: object): void }
let hljsPromise: Promise<Hljs> | undefined

function loadHljs(): Promise<Hljs> {
  hljsPromise ??= import('highlight.js/lib/common').then((m) => {
    const h = (m as unknown as { default: Hljs }).default
    h.configure({ ignoreUnescapedHTML: true })
    return h
  })
  return hljsPromise
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 流式输出期间不高亮：每个 chunk 都会重写 innerHTML，高亮白做。
    if (streaming === true) return
    const el = ref.current
    if (el === null) return
    const blocks = [...el.querySelectorAll<HTMLElement>('pre.c-code > code[class*="language-"]')]
    if (blocks.length === 0) return
    let cancelled = false
    loadHljs()
      .then((hljs) => {
        if (cancelled) return
        for (const b of blocks) {
          if (b.dataset.hl === '1') continue
          try {
            hljs.highlightElement(b)
          } catch {
            /* 不认识的语言：保持纯文本 */
          }
          b.dataset.hl = '1'
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [html, streaming])
  return <div ref={ref} className={streaming === true ? 'c-md c-streaming' : 'c-md'} dangerouslySetInnerHTML={{ __html: html }} />
})
