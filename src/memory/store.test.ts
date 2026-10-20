/*
 * @Description: 作用域记忆存储测试 —— 增删改、历史回退、最近删除、待选去重与审批、分叉复制
 * @Author: YangHeng
 * @Date: 2026-10-16 18:55:00
 * @FilePath: /dsh-workspace/src/memory/store.test.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, MemoryNotFoundError } from './store.js'
import type { MemoryScope } from '../wire/memory.js'

let dir: string
let clock: number
let projects: Record<string, string | null>

function makeStore(): MemoryStore {
  return new MemoryStore({ root: dir, projectOf: (sid) => projects[sid] ?? null, now: () => clock })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dshws-memory-'))
  clock = 1_000
  projects = { s1: 'p1', s2: 'p1', s3: null }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const G: MemoryScope = { layer: 'global' }
const P: MemoryScope = { layer: 'project', projectId: 'p1' }
const S1: MemoryScope = { layer: 'session', sessionId: 's1' }

describe('设置', () => {
  it('默认关闭；非法值回落默认', () => {
    const store = makeStore()
    expect(store.getSettings()).toEqual({ enabled: false, summarizerModel: null, summarizeEveryTurns: 8, toolEnabled: true })
    store.setSettings({ enabled: true, summarizeEveryTurns: 0 })
    const reloaded = makeStore().getSettings()
    expect(reloaded.enabled).toBe(true)
    expect(reloaded.summarizeEveryTurns).toBe(8)
  })
})

describe('条目增删改', () => {
  it('新增落盘、按置顶 > 重要程度排序；会话层带分节，项目层才保留分支', () => {
    const store = makeStore()
    store.add(G, { content: '低', importance: 'low' }, { by: 'user' })
    clock += 1
    store.add(G, { content: '高', importance: 'high' }, { by: 'user' })
    clock += 1
    store.add(G, { content: '置顶', importance: 'low', pinned: true, branches: ['main'] }, { by: 'user' })
    const list = makeStore().list(G)
    expect(list.map((e) => e.content)).toEqual(['置顶', '高', '低'])
    expect(list[0]?.branches).toBeUndefined()

    const p = store.add(P, { content: '分支限定', branches: [' main ', 'main', ''] }, { by: 'user' })
    expect(p.branches).toEqual(['main'])
    const s = store.add(S1, { content: '目标 X', section: 'goal' }, { by: 'assistant', sessionId: 's1', turn: 2 })
    expect(s.section).toBe('goal')
    expect(existsSync(path.join(dir, 'projects', 'p1', 'sessions', 's1.json'))).toBe(true)
  })

  it('空内容被拒；更新不存在的条目抛 MemoryNotFoundError 且不写历史', () => {
    const store = makeStore()
    expect(() => store.add(G, { content: '   ' }, { by: 'user' })).toThrow('不能为空')
    expect(() => store.update(G, 'nope', { enabled: false }, 'user')).toThrow(MemoryNotFoundError)
    expect(existsSync(path.join(dir, 'history', 'global.jsonl'))).toBe(false)
  })

  it('禁用 / 改内容 / 清空分支', () => {
    const store = makeStore()
    const e = store.add(P, { content: 'a', branches: ['dev'] }, { by: 'user' })
    clock += 5
    const u = store.update(P, e.id, { enabled: false, content: 'b', branches: [] }, 'user')
    expect(u).toMatchObject({ enabled: false, content: 'b', updatedAt: 1_005 })
    expect(u.branches).toBeUndefined()
  })
})

describe('历史与回退', () => {
  it('每次修改都记录，可恢复到任一版本', () => {
    const store = makeStore()
    const e = store.add(G, { content: 'v1' }, { by: 'user' })
    clock += 1
    store.update(G, e.id, { content: 'v2' }, 'assistant')
    clock += 1
    store.update(G, e.id, { content: 'v3' }, 'user')
    const history = store.history(G, e.id)
    expect(history.map((h) => h.op)).toEqual(['update', 'update', 'create'])
    const created = history[2]!
    const reverted = store.revert(G, e.id, created.id, 'user')
    expect(reverted.content).toBe('v1')
    expect(store.history(G, e.id)[0]?.op).toBe('revert')
  })

  it('删除后仍可从历史恢复（条目重新出现）', () => {
    const store = makeStore()
    const e = store.add(G, { content: 'x' }, { by: 'user' })
    store.remove(G, e.id, 'user')
    expect(store.list(G)).toHaveLength(0)
    const created = store.history(G, e.id).find((h) => h.op === 'create')!
    store.revert(G, e.id, created.id, 'user')
    expect(store.list(G).map((x) => x.id)).toEqual([e.id])
  })
})

describe('最近删除', () => {
  it('删除进最近删除，可恢复；超过 30 天自动清除', () => {
    const store = makeStore()
    const a = store.add(S1, { content: 'a', section: 'facts' }, { by: 'user' })
    const b = store.add(G, { content: 'b' }, { by: 'user' })
    store.remove(S1, a.id, 'user')
    clock += 1
    store.remove(G, b.id, 'user')
    const trash = store.trash()
    expect(trash.map((t) => t.entry.content)).toEqual(['b', 'a'])
    expect(trash[1]?.projectId).toBe('p1')
    const restored = store.restore(trash[1]!.id, 'user')
    expect(restored.scope).toEqual(S1)
    expect(store.list(S1).map((e) => e.id)).toEqual([a.id])

    clock += 31 * 24 * 60 * 60 * 1000
    expect(store.trash()).toHaveLength(0)
  })
})

describe('待选记忆', () => {
  it('相同内容合并计数；与已启用条目相同则丢弃；禁用条目不参与去重', () => {
    const store = makeStore()
    const c1 = store.propose({ layer: 'project', projectId: 'p1', content: '接口返回 code/msg/data。', source: { by: 'summarizer', sessionId: 's1' } })
    const c2 = store.propose({ layer: 'project', projectId: 'p1', content: '  接口返回   CODE/msg/data ', source: { by: 'summarizer', sessionId: 's2' } })
    expect(c2?.id).toBe(c1?.id)
    expect(store.candidates()).toHaveLength(1)
    expect(store.candidates()[0]?.hits).toBe(2)

    const e = store.add(G, { content: '用中文回复' }, { by: 'user' })
    expect(store.propose({ layer: 'global', content: '用中文回复', source: { by: 'assistant' } })).toBeUndefined()
    store.update(G, e.id, { enabled: false }, 'user')
    expect(store.propose({ layer: 'global', content: '用中文回复', source: { by: 'assistant' } })).toBeDefined()
  })

  it('不属于项目的会话不能提议项目记忆', () => {
    const store = makeStore()
    expect(() => store.propose({ layer: 'project', projectId: null, content: 'x', source: { by: 'assistant', sessionId: 's3' } })).toThrow('不属于任何')
  })

  it('修改后通过、改层级、拒绝、按会话全部拒绝', () => {
    const store = makeStore()
    const a = store.propose({ layer: 'project', projectId: 'p1', content: 'a', source: { by: 'summarizer', sessionId: 's1' } })!
    const b = store.propose({ layer: 'project', projectId: 'p1', content: 'b', source: { by: 'summarizer', sessionId: 's1' } })!
    store.propose({ layer: 'global', content: 'c', source: { by: 'summarizer', sessionId: 's2' } })

    const approved = store.approve({ id: a.id, content: 'a2', layer: 'global', importance: 'high' }, 'p1')
    expect(approved.scope).toEqual(G)
    expect(approved.entry).toMatchObject({ content: 'a2', importance: 'high', source: { by: 'summarizer', sessionId: 's1' } })

    store.reject(b.id)
    expect(() => store.reject(b.id)).toThrow(MemoryNotFoundError)
    expect(store.candidates({ sessionId: 's2' })).toHaveLength(1)
    expect(store.rejectAll({ sessionId: 's2' })).toBe(1)
    expect(store.candidates()).toHaveLength(0)
  })

  it('全局待选改到项目层：用来源会话所属项目', () => {
    const store = makeStore()
    const c = store.propose({ layer: 'global', content: 'x', source: { by: 'assistant', sessionId: 's1' } })!
    const { scope } = store.approve({ id: c.id, layer: 'project' }, 'p1')
    expect(scope).toEqual(P)
  })
})

describe('会话生命周期', () => {
  it('提升到项目 / 全局：原条目保留，新条目由用户写入', () => {
    const store = makeStore()
    const e = store.add(S1, { content: '决策 A', section: 'decisions', importance: 'high' }, { by: 'assistant', sessionId: 's1' })
    const promoted = store.promote(S1, e.id, 'project', 'p1')
    expect(promoted).toMatchObject({ layer: 'project', content: '决策 A', importance: 'high', source: { by: 'user', sessionId: 's1' } })
    expect(store.list(S1)).toHaveLength(1)
    expect(() => store.promote(S1, e.id, 'project', null)).toThrow('不属于任何')
  })

  it('分叉复制父会话记忆（新 ID），子会话已有记忆时不覆盖', () => {
    const store = makeStore()
    store.add(S1, { content: 'parent', section: 'goal' }, { by: 'assistant' })
    expect(store.copySession('s1', 's2')).toBe(true)
    const child = store.list({ layer: 'session', sessionId: 's2' })
    expect(child.map((e) => e.content)).toEqual(['parent'])
    expect(child[0]?.id).not.toBe(store.list(S1)[0]?.id)
    expect(store.copySession('s1', 's2')).toBe(false)
  })

  it('会话所属项目变化后仍能找到旧文件；删除会话文件', () => {
    const store = makeStore()
    store.add(S1, { content: 'x', section: 'facts' }, { by: 'user' })
    projects.s1 = 'p2'
    const fresh = makeStore()
    expect(fresh.list(S1).map((e) => e.content)).toEqual(['x'])
    expect(fresh.listSessions('p1').map((s) => s.sessionId)).toEqual(['s1'])
    expect(fresh.deleteSession('s1')).toBe(1)
    expect(fresh.hasSessionFile('s1')).toBe(false)
  })

  it('损坏的文件按空处理，不抛错', () => {
    writeFileSync(path.join(dir, 'global.json'), '{oops')
    expect(makeStore().list(G)).toEqual([])
  })
})

describe('变更通知', () => {
  it('写入后按作用域键通知', () => {
    const store = makeStore()
    const keys: string[] = []
    store.subscribe((c) => keys.push(c.key))
    store.add(S1, { content: 'x' }, { by: 'user' })
    store.propose({ layer: 'global', content: 'y', source: { by: 'assistant' } })
    expect(keys).toEqual(['session:s1', 'candidates'])
  })
})
