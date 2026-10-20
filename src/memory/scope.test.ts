/*
 * @Description: 会话 → 项目归属解析测试
 * @Author: YangHeng
 * @Date: 2026-10-16 19:10:00
 * @FilePath: /dsh-workspace/src/memory/scope.test.ts
 */
import { describe, expect, it } from 'vitest'
import { ScopeResolver, comparablePath, matchWorkspace } from './scope.js'

const WS = [
  { id: 'a', path: 'C:\\Work\\repo' },
  { id: 'b', path: 'C:\\Work\\repo\\packages\\ui' },
  { id: 'c', path: '/home/me/proj' }
]

describe('matchWorkspace', () => {
  it('最长前缀：子目录归最近的已登记祖先', () => {
    expect(matchWorkspace('C:\\Work\\repo\\src', WS, 'win32')?.id).toBe('a')
    expect(matchWorkspace('c:/work/REPO/packages/ui/src', WS, 'win32')?.id).toBe('b')
    expect(matchWorkspace('C:\\Work\\repo', WS, 'win32')?.id).toBe('a')
  })

  it('同名前缀但不是子目录不算；Linux 区分大小写', () => {
    expect(matchWorkspace('C:\\Work\\repo2', WS, 'win32')).toBeUndefined()
    expect(matchWorkspace('/home/me/Proj/x', WS, 'linux')).toBeUndefined()
    expect(matchWorkspace('/home/me/proj/x', WS, 'linux')?.id).toBe('c')
  })

  it('comparablePath 去尾分隔符但保留盘符根', () => {
    expect(comparablePath('C:\\', 'win32')).toBe('c:/')
    expect(comparablePath('/a/b/', 'linux')).toBe('/a/b')
  })
})

describe('ScopeResolver', () => {
  it('解析后 projectOf 同步可读；登记表缓存，工作区后登记也能被识别', async () => {
    let clock = 0
    let list = [{ id: 'c', path: '/nonexistent-dshws/proj' }]
    let calls = 0
    const resolver = new ScopeResolver(
      {
        listWorkspaces: async () => {
          calls += 1
          return list
        },
        sessionCwd: async (sid) => (sid === 's1' ? '/nonexistent-dshws/proj/sub' : sid === 's2' ? '/nonexistent-dshws/other' : undefined),
        platform: 'linux'
      },
      () => clock
    )
    expect(resolver.projectOf('s1')).toBeNull()
    expect((await resolver.ensure('s1')).projectId).toBe('c')
    expect(resolver.projectOf('s1')).toBe('c')
    expect((await resolver.ensure('s2')).projectId).toBeNull()
    expect((await resolver.ensure('s9')).projectId).toBeNull()
    expect(calls).toBe(1)

    list = [...list, { id: 'd', path: '/nonexistent-dshws/other' }]
    clock += 20_000
    expect((await resolver.ensure('s2')).projectId).toBe('d')
  })
})
