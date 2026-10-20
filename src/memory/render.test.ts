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
    expect(text).toContain('## 项目记忆（repo）\n- 第一行\n  第二行')
    expect(text).not.toContain('dev 专用')
    expect(text.indexOf('## 项目记忆')).toBeLessThan(text.indexOf('## 全局记忆'))
    expect(text).toContain('## 全局记忆\n- [置顶] 顶\n- [重要] 高\n- 低')
  })

  it('同样的数据渲染逐字相同', () => {
    const g = [entry({ content: 'a' }), entry({ content: 'b' })]
    expect(renderLongTerm({ global: g })).toBe(renderLongTerm({ global: [...g].reverse() }))
  })
})

describe('转义', () => {
  it('拆开 {{ 防止被宿主当提示词变量', () => {
    expect(renderLongTerm({ global: [entry({ content: '模板 {{name}} 原样' })] })).toContain('模板 { {name}} 原样')
  })
})

describe('renderSession', () => {
  it('按固定分节顺序，跳过空分节', () => {
    const text = renderSession([
      entry({ layer: 'session', section: 'progress', content: '做到第 2 步' }),
      entry({ layer: 'session', section: 'goal', content: '实现记忆' }),
      entry({ layer: 'session', section: 'rejected', content: '方案 A 太贵', enabled: false })
    ])
    expect(text).toContain('## 目标\n- 实现记忆\n\n## 进度\n- 做到第 2 步')
    expect(text).not.toContain('## 已排除方案')
    expect(renderSession([])).toBe('')
  })
})
