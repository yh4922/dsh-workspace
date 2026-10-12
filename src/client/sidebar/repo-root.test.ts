/*
 * @Description: 「本会话记住的仓库根」单测 —— 会话优先 / 全局兜底 / 清除 / 归一化
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/repo-root.test.ts
 */
import { describe, expect, it } from 'vitest'
import { getRepoRoot, setRepoRoot } from './repo-root.js'

function fakeKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value)
    },
    removeItem: (key: string): void => {
      data.delete(key)
    },
    dump: (): Record<string, string> => Object.fromEntries(data)
  }
}

describe('仓库根记忆', () => {
  it('按会话保存，别的会话读不到自己的键但能吃到全局兜底', () => {
    const kv = fakeKv()
    setRepoRoot('s1', '/root/Yunzai', kv)
    expect(getRepoRoot('s1', kv)).toBe('/root/Yunzai')
    // 没记过的会话拿全局兜底（= 最近一次选过的路径）
    expect(getRepoRoot('s2', kv)).toBe('/root/Yunzai')
    setRepoRoot('s2', '/root/nbr', kv)
    expect(getRepoRoot('s1', kv)).toBe('/root/Yunzai')
    expect(getRepoRoot('s2', kv)).toBe('/root/nbr')
    expect(getRepoRoot('s3', kv)).toBe('/root/nbr')
  })

  it('结尾斜杠与空白会被归一，空值等于「回到工作区根」', () => {
    const kv = fakeKv()
    setRepoRoot('s1', '  /root/Yunzai/  ', kv)
    expect(getRepoRoot('s1', kv)).toBe('/root/Yunzai')
    setRepoRoot('s1', '/', kv)
    expect(getRepoRoot('s1', kv)).toBeNull()
  })

  it('清除会话记录时连全局兜底一起清掉', () => {
    const kv = fakeKv()
    setRepoRoot('s1', '/root/Yunzai', kv)
    setRepoRoot('s1', null, kv)
    expect(getRepoRoot('s1', kv)).toBeNull()
    expect(getRepoRoot('s2', kv)).toBeNull()
    expect(kv.dump()).toEqual({})
  })

  it('localStorage 不可用（没有 KV）时安静降级', () => {
    expect(getRepoRoot('s1', undefined)).toBeNull()
    expect(() => setRepoRoot('s1', '/root/Yunzai', undefined)).not.toThrow()
  })
})
