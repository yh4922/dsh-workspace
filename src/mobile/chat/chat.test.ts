import { describe, expect, it } from 'vitest'
import { lineDiff, toolDiffs } from './diff'
import { resolvePath, splitFileRefs, wholeFileRef } from './links'
import { renderMarkdown } from './md-render'
import { toolSummary } from './tool-summary'

describe('文件路径识别', () => {
  it('识别相对 / 绝对 / 行号路径', () => {
    const refs = splitFileRefs('改了 src/a/b.ts 和 styles.ts:46，见 /etc/x.conf 与 C:\\x\\y.tsx:3:2。')
      .filter((p) => p.ref !== undefined)
      .map((p) => p.ref)
    expect(refs).toEqual([{ path: 'src/a/b.ts' }, { path: 'styles.ts', line: 46 }, { path: '/etc/x.conf' }, { path: 'C:\\x\\y.tsx', line: 3 }])
  })
  it('不误伤 URL、版本号、缩写', () => {
    const refs = splitFileRefs('见 https://a.com/b.js ，版本 1.2.3，e.g. vs. example.com').filter((p) => p.ref !== undefined)
    expect(refs).toEqual([])
  })
  it('整段 code 与相对路径解析', () => {
    expect(wholeFileRef('src/a.ts:10')).toEqual({ path: 'src/a.ts', line: 10 })
    expect(wholeFileRef('npm run build')).toBeUndefined()
    expect(resolvePath('src/a.ts', '/home/u/p')).toBe('/home/u/p/src/a.ts')
    expect(resolvePath('../b.ts', 'C:\\w\\p')).toBe('C:\\w\\b.ts')
    expect(resolvePath('/abs.ts', '/x')).toBe('/abs.ts')
  })
})

describe('markdown', () => {
  it('转义原始 HTML、文件 chip、过滤 javascript 链接', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> 见 `src/a.ts:4` 和 [x](javascript:alert(1)) 以及 src/b.ts')
    expect(html).not.toContain('<img')
    expect(html).toContain('data-path="src/a.ts" data-line="4"')
    expect(html).toContain('data-path="src/b.ts"')
    expect(html).not.toContain('javascript:')
  })
  it('代码块转义', () => {
    expect(renderMarkdown('```ts\nconst a = "<b>"\n```')).toContain('&lt;b&gt;')
  })
})

describe('diff', () => {
  it('LCS 行 diff', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: ' ', text: 'a' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'x' },
      { kind: ' ', text: 'c' }
    ])
  })
  it('优先 meta.diffs，其次参数', () => {
    expect(toolDiffs('edit', undefined, { diffs: [{ path: 'p', oldText: null, newText: 'n' }] })).toEqual([{ path: 'p', lines: [{ kind: '+', text: 'n' }] }])
    expect(toolDiffs('edit', { file_path: 'f', old_string: 'o', new_string: 'n' }, undefined)?.[0]?.lines.length).toBe(2)
    expect(toolDiffs('bash', { command: 'ls' }, undefined)).toBeUndefined()
  })
})

describe('工具摘要', () => {
  it('取主参数', () => {
    expect(toolSummary('read', '{"file_path":"src/a.ts","offset":3}')).toEqual({ text: 'src/a.ts', ref: { path: 'src/a.ts', line: 3 } })
    expect(toolSummary('bash', '{"command":"pnpm test"}').text).toBe('pnpm test')
    expect(toolSummary('x', '{"a":').text).toBe('{"a":')
  })
})
