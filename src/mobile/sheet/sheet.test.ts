/*
 * @Description: H5 抽屉 —— 快捷键序列、浏览器地址换算、上下文数据整形、开关状态
 * @Author: YangHeng
 * @Date: 2026-11-19 17:15:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/sheet.test.ts
 */
import { describe, expect, it } from 'vitest'
import { applyCtrl, ctrlChar, quickKeySequence } from './keys.js'
import { toFrameTarget } from './browser-url.js'
import { categoryShares, formatTokens, projectionView } from './context-data.js'
import { closeSheet, getSheetState, openSheet, switchTab } from './store.js'
import { rowsOf } from './cwd.js'

describe('终端快捷键', () => {
  it('Ctrl 组合', () => {
    expect(ctrlChar('c')).toBe('\x03')
    expect(ctrlChar('C')).toBe('\x03')
    expect(ctrlChar('[')).toBe('\x1b')
    expect(ctrlChar('?')).toBe('\x7f')
    expect(ctrlChar('1')).toBe('1')
    expect(applyCtrl('dls')).toBe('\x04ls')
    expect(applyCtrl('')).toBe('')
  })
  it('方向键随光标模式与 Ctrl 变化', () => {
    expect(quickKeySequence('up', false, false)).toBe('\x1b[A')
    expect(quickKeySequence('up', false, true)).toBe('\x1bOA')
    expect(quickKeySequence('left', true, true)).toBe('\x1b[1;5D')
    expect(quickKeySequence('tab', false, false)).toBe('\t')
    expect(quickKeySequence('esc', true, false)).toBe('\x1b')
    expect(quickKeySequence('pipe', false, false)).toBe('|')
    expect(quickKeySequence('tilde', false, false)).toBe('~')
  })
})

describe('浏览器地址', () => {
  it('本机地址经转发', () => {
    expect(toFrameTarget('localhost:5173/a?b=1#h')?.src).toBe('/dsh-workspace/m/fwd/5173/a?b=1#h')
    expect(toFrameTarget('http://127.0.0.1:3000')?.src).toBe('/dsh-workspace/m/fwd/3000/')
    expect(toFrameTarget('http://[::1]:8080/x')?.src).toBe('/dsh-workspace/m/fwd/8080/x')
    expect(toFrameTarget('8000')?.src).toBe('/dsh-workspace/m/fwd/8000/')
    expect(toFrameTarget('http://localhost')?.src).toBe('/dsh-workspace/m/fwd/80/')
    expect(toFrameTarget('http://app.localhost:5173/')?.forwarded).toBe(true)
  })
  it('外站直连，非法地址拒绝', () => {
    expect(toFrameTarget('example.com')).toEqual({ src: 'http://example.com/', forwarded: false, display: 'http://example.com/' })
    expect(toFrameTarget('https://a.b/c')?.forwarded).toBe(false)
    expect(toFrameTarget('javascript:alert(1)')).toBeUndefined()
    expect(toFrameTarget('file:///etc/passwd')).toBeUndefined()
    expect(toFrameTarget('   ')).toBeUndefined()
  })
})

describe('上下文数据', () => {
  it('投影 → 占比 / 用量 / 模型', () => {
    const v = projectionView({
      kind: 'sequenced',
      values: {
        contextPressure: { pressureTokens: 50_000, contextWindow: 200_000 },
        tokenUsage: { uncachedInputTokens: 10, outputTokens: 20 },
        modelSelection: { provider: 'ds', model: 'v4', reasoningEffort: 'high' }
      }
    })
    expect(v.pressure).toEqual({ used: 50_000, window: 200_000, ratio: 0.25 })
    expect(v.usage).toEqual({ uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(v.model).toBe('ds / v4 · high')
    expect(projectionView(null)).toEqual({})
    expect(projectionView({ values: { contextPressure: { pressureTokens: 1 } } }).pressure).toBeUndefined()
  })
  it('dsh-context 分类：认得的形状才用', () => {
    expect(categoryShares({ head: { sums: { user: 100, tool: 0, assistant: 50 }, systemTokens: 30 } }).map((c) => [c.key, c.tokens])).toEqual([
      ['system', 30],
      ['user', 100],
      ['assistant', 50]
    ])
    expect(categoryShares({ foo: 1 })).toEqual([])
    expect(categoryShares('x')).toEqual([])
  })
  it('token 格式化', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2000)).toBe('2k')
    expect(formatTokens(1_230_000)).toBe('1.23M')
  })
})

describe('抽屉状态与会话列表', () => {
  it('open / switch / close', () => {
    openSheet({ tab: 'files', path: 'a.ts', line: 3 })
    const s1 = getSheetState()
    expect(s1).toMatchObject({ open: true, tab: 'files', path: 'a.ts', line: 3 })
    switchTab('git')
    expect(getSheetState()).toMatchObject({ open: true, tab: 'git', seq: s1.seq })
    expect(getSheetState().path).toBeUndefined()
    closeSheet()
    expect(getSheetState().open).toBe(false)
  })
  it('session/list 外形兼容', () => {
    expect(rowsOf([{ sessionId: 'a' }])).toHaveLength(1)
    expect(rowsOf({ sessions: [{}, {}] })).toHaveLength(2)
    expect(rowsOf(null)).toEqual([])
  })
})
