/*
 * @Description: H5 hash 路由 —— 解析 / 生成 / 切页方向
 * @Author: YangHeng
 * @Date: 2026-11-19 15:55:00
 * @FilePath: /dsh-workspace/src/mobile/router.test.ts
 */
import { describe, expect, it } from 'vitest'
import { directionOf, formatHash, parseHash } from './router.js'

describe('H5 独立页面路由', () => {
  it('hash 往返（含特殊字符）', () => {
    for (const r of [{ page: 'home' }, { page: 'session', sessionId: 's/1 中?#' }] as const) expect(parseHash(formatHash(r))).toEqual(r)
    expect(parseHash('')).toEqual({ page: 'home' })
    expect(parseHash('#/w/1')).toEqual({ page: 'home' })
    expect(parseHash('#/s/%E0%A4%A')).toEqual({ page: 'home' })
  })
  it('进入详情为前进，回首页为后退，同页无动画', () => {
    const home = { page: 'home' } as const
    const s = { page: 'session', sessionId: 'a' } as const
    expect(directionOf(home, s)).toBe('forward')
    expect(directionOf(s, home)).toBe('back')
    expect(directionOf(s, { page: 'session', sessionId: 'b' })).toBe('forward')
    expect(directionOf(home, home)).toBe('none')
  })
})
