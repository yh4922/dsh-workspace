/*
 * @Description: 信任列表来源测试 —— 兼容 DSH 0.1.x（webRuntime）与 0.2.1+（connection）
 * @Author: YangHeng
 * @Date: 2026-10-19 11:55:00
 * @FilePath: /dsh-workspace/src/trusted-hosts.test.ts
 */
import { describe, expect, it } from 'vitest'
import { trustedHostsOf } from './index.js'

const ctxWith = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })

describe('trustedHostsOf', () => {
  it('优先 webRuntime（旧内核），其次 connection（0.2.1+）', () => {
    expect(trustedHostsOf(ctxWith({ webRuntime: { trustedHosts: ['a:1'] }, connection: { trustedHosts: ['b'] } }))).toEqual(['a:1'])
    expect(trustedHostsOf(ctxWith({ connection: { trustedHosts: ['b', 3] } }))).toEqual(['b'])
  })

  it('都没有 / get 抛错：空表（只放行本机回环）', () => {
    expect(trustedHostsOf(ctxWith({}))).toEqual([])
    expect(
      trustedHostsOf({
        get() {
          throw new Error('cannot get property without inject')
        }
      })
    ).toEqual([])
  })
})
