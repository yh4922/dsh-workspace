/*
 * @Description: H5 会话 —— 助手消息 markdown → 安全 HTML（文件路径 chip、禁原始 HTML、危险链接降级）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:20:00
 * @FilePath: /dsh-workspace/src/mobile/chat/md-render.ts
 *
 * 为什么自写一个小管线而不复用 src/client/viewers/markdown-render.ts：那里服务于无脚本 iframe 预览，
 * 产物允许原始 HTML；这里 HTML 直接进主文档（dangerouslySetInnerHTML），必须转义原始 HTML、过滤 javascript: 链接。
 * 代码高亮在渲染后按需 import highlight.js（单独分片），见 Markdown.tsx。
 * 文件名不叫 markdown.ts：Windows 不区分大小写，会与 Markdown.tsx 撞名。
 */
import { Marked, type Tokens } from 'marked'
import { escapeHtml, fileChipHtml, linkifyText, wholeFileRef } from './links.js'

const SAFE_HREF = /^(https?:|mailto:|#)/i
/** 图片链接前的线性图标（Lucide「image」，ISC，见 src/mobile/icons.tsx）。 */
const IMAGE_ICON =
  '<svg class="m-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>'

function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 链接文字里不能再嵌 chip（<a> 不可嵌套）。 */
function stripChips(html: string): string {
  return html.replace(/<a class="c-fl"[^>]*>([\s\S]*?)<\/a>/g, '$1')
}

let instance: Marked | undefined

function md(): Marked {
  if (instance !== undefined) return instance
  const m = new Marked({ gfm: true, breaks: true, async: false })
  m.use({
    renderer: {
      // 原始 HTML 一律按文本显示：助手输出不可信。
      html(token: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(token.text)
      },
      text(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Text | Tokens.Escape): string {
        if ('tokens' in token && token.tokens !== undefined && token.tokens.length > 0) return this.parser.parseInline(token.tokens)
        const raw = 'escaped' in token && token.escaped === true ? unescapeEntities(token.text) : token.text
        return linkifyText(raw)
      },
      codespan(token: Tokens.Codespan): string {
        const raw = unescapeEntities(token.text)
        const ref = wholeFileRef(raw)
        if (ref !== undefined) return fileChipHtml(raw, ref)
        return `<code>${escapeHtml(raw)}</code>`
      },
      code(token: Tokens.Code): string {
        const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
        return `<pre class="c-code"><code${cls}>${escapeHtml(token.text)}</code></pre>\n`
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link): string {
        const inner = stripChips(this.parser.parseInline(token.tokens))
        if (!SAFE_HREF.test(token.href)) return inner
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      },
      image(token: Tokens.Image): string {
        // 不自动加载外部图片（隐私 / 流量）：显示为链接。
        if (!SAFE_HREF.test(token.href)) return escapeHtml(token.text)
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer" class="c-md-img">${IMAGE_ICON}${escapeHtml(token.text || token.href)}</a>`
      }
    }
  })
  instance = m
  return m
}

/** markdown → HTML（同步、纯函数）。 */
export function renderMarkdown(text: string): string {
  try {
    return md().parse(text) as string
  } catch {
    return `<p>${linkifyText(text)}</p>`
  }
}
