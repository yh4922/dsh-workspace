/*
 * @Description: 注入文本渲染测试
 * @Author: YangHeng
 * @Date: 2026-10-16 19:18:00
 * @FilePath: /dsh-workspace/src/memory/render.test.ts
 */
import { describe, expect, it } from 'vitest'
import { branchVisible, renderLongTerm, renderSession } from './render.js'
import type { MemoryEntry } from '../wire/memory.js'

let seq = 0
function entry(partial: Partial<MemoryEntry>): MemoryEntry {
  seq += 1
  return {
    id: `m${seq}`,
    layer: 'global',
    content: 'x',
    enabled: true,
    pinned: false,
    importance: 'medium',
    source: { by: 'user' },
    createdAt: seq,
    updatedAt: seq,
    ...partial
  }
}

describe('branchVisible', () => {
  it('未限定分支总是可见；限定了分支时读不到分支不可见', () => {
    expect(branchVisible(entry({}), undefined)).toBe(true)
    expect(branchVisible(entry({ branches: ['main'] }), undefined)).toBe(false)
    expect(branchVisible(entry({ branches: ['main'] }), 'dev')).toBe(false)
    expect(branchVisible(entry({ branches: ['main'] }), 'main')).toBe(true)
  })
})

describe('renderLongTerm', () => {
  it('两层都空返回空串；禁用条目不注入', () => {
    expect(renderLongTerm({ global: [] })).toBe('')
    expect(renderLongTerm({ global: [entry({ enabled: false })] })).toBe('')
  })

  it('排序与标记；项目在前；分支过滤；多行缩进', () => {
    const text = renderLongTerm({
      global: [entry({ content: '低', importance: 'low' }), entry({ content: '高', importance: 'high' }), entry({ content: '顶', pinned: true })],
      project: { title: 'repo', entries: [entry({ layer: 'project', content: 'dev 专用', branches: ['dev'] }), entry({ layer: 'project', content: '第一行\n第二行' })] },
      branch: 'main'
    })
    expect(text).toContain('## 项目记忆（repo）\n- [P1] 第一行\n  第二行')
    expect(text).not.toContain('dev 专用')
    expect(text.indexOf('## 项目记忆')).toBeLessThan(text.indexOf('## 全局记忆'))
    expect(text).toContain('## 全局记忆\n- [G1][置顶] 顶\n- [G2][重要] 高\n- [G3] 低')
  })

  it('包在 <user_memory> 里，含强约束引导语与块尾自检', () => {
    const text = renderLongTerm({ global: [entry({ content: '用中文' })] })
    expect(text.startsWith('<user_memory>\n')).toBe(true)
    expect(text.endsWith('\n发出回复前，逐条确认没有违反以上记忆。\n</user_memory>')).toBe(true)
    expect(text).toContain('优先级高于本系统提示词中其他默认行为与风格要求')
  })

  it('有标题时首行加粗；条目内 Markdown 标题降级为加粗行，代码块内不动', () => {
    const text = renderLongTerm({
      global: [entry({ title: '开发规范', content: '# 全局规范\n## 一、原则\n- 简洁\n```sh\n# 注释\n```', pinned: true, importance: 'high' })]
    })
    expect(text).toContain('- [G1][置顶·重要] **开发规范**\n  **全局规范**\n  **一、原则**\n  - 简洁\n  ```sh\n  # 注释\n  ```')
    // 外层只有两级标题，条目内容不再产生 # / ## 标题
    expect(text.match(/^#{1,2} /gm)).toEqual(['# ', '## '])
  })

  it('同样的数据渲染逐字相同', () => {
    const g = [entry({ content: 'a' }), entry({ content: 'b' })]
    expect(renderLongTerm({ global: g })).toBe(renderLongTerm({ global: [...g].reverse() }))
  })
})

describe('原样保留', () => {
  it('{{ 不再拆开（section 已关闭宿主插值）', () => {
    expect(renderLongTerm({ global: [entry({ content: '模板 {{name}} 原样' })] })).toContain('模板 {{name}} 原样')
  })
})

describe('renderSession', () => {
  it('按固定分节顺序，跳过空分节', () => {
    const text = renderSession([
      entry({ layer: 'session', section: 'progress', content: '做到第 2 步' }),
      entry({ layer: 'session', section: 'goal', content: '实现记忆' }),
      entry({ layer: 'session', section: 'rejected', content: '方案 A 太贵', enabled: false })
    ])
    expect(text).toContain('## 目标\n- [S1] 实现记忆\n\n## 进度\n- [S2] 做到第 2 步')
    expect(text.startsWith('<session_memory>\n')).toBe(true)
    expect(text.endsWith('\n</session_memory>')).toBe(true)
    expect(text).not.toContain('## 已排除方案')
    expect(renderSession([])).toBe('')
  })
})
