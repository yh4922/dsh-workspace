import { describe, expect, it } from 'vitest'
import { relativeTime } from '../home/time.js'
import { ALL, filterSessions, groupByWorkspace } from '../home/filter.js'
import { buildSessionList, compareSessions, isAuthError, mergeRows, parseSessionList, patchRows, toCacheRows, UNTITLED, type SessionMeta } from './sessions.js'
import { applyWorkspaceFrame, type WorkspaceState } from './workspaces.js'
import { RPC_UNAUTHORIZED, RpcError } from '../net/rpc.js'

const ws: WorkspaceState = {
  items: [
    { workspaceId: 'w1', path: '/a/proj-one', title: '', sessionIds: ['s1', 's2'], createdAt: 1 },
    { workspaceId: 'w2', path: '/b', title: 'Infra', sessionIds: ['s3'], createdAt: 2 }
  ],
  archivedSessionIds: ['s4'],
  pinnedSessionIds: ['s2']
}

const list = {
  items: [
    { sessionId: 's1', updatedAt: 300, running: true, blank: false, projections: { kind: 'sequenced', asOfSeq: 1, values: { title: '一' } } },
    { sessionId: 's2', updatedAt: 100, running: false, blank: false, projections: { values: { title: '二' } } },
    { sessionId: 's3', updatedAt: 500, running: false, blank: false },
    { sessionId: 's4', updatedAt: 900, running: false, blank: false, projections: { values: { title: '归档' } } },
    { sessionId: 'sub', updatedAt: 999, running: true, blank: false, parentSessionId: 's1' },
    { sessionId: 'blank', updatedAt: 998, running: false, blank: true },
    { bogus: true }
  ]
}

describe('parseSessionList', () => {
  it('取 projections.values.title，丢弃坏行', () => {
    const rows = parseSessionList(list)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toMatchObject({ sessionId: 's1', title: '一', running: true, updatedAt: 300 })
    expect(rows[2]?.title).toBe('')
    expect(rows[4]?.parentSessionId).toBe('s1')
  })
  it('接受裸数组与 ISO 时间', () => {
    const rows = parseSessionList([{ sessionId: 'x', updatedAt: '1970-01-01T00:00:01.000Z' }])
    expect(rows[0]?.updatedAt).toBe(1000)
  })
})

describe('buildSessionList', () => {
  it('过滤子代理与空白会话，置顶在前，其余按 updatedAt 倒序', () => {
    const out = buildSessionList(parseSessionList(list), ws)
    expect(out.map((m) => m.sessionId)).toEqual(['s2', 's4', 's3', 's1'])
    expect(out[0]).toMatchObject({ pinned: true, workspaceId: 'w1', workspaceTitle: 'proj-one' })
    expect(out.find((m) => m.sessionId === 's4')?.archived).toBe(true)
    expect(out.find((m) => m.sessionId === 's3')).toMatchObject({ title: UNTITLED, workspaceTitle: 'Infra' })
  })
  it('工作区未到时仍按 updatedAt 排序，用缓存字段兜底', () => {
    const rows = parseSessionList(list).map((r) => (r.sessionId === 's1' ? { ...r, cachedWorkspaceId: 'w1', cachedPinned: true } : r))
    const out = buildSessionList(rows, undefined)
    expect(out.map((m) => m.sessionId)).toEqual(['s1', 's4', 's3', 's2'])
    expect(out[0]?.workspaceId).toBe('w1')
  })
  it('compareSessions 同时间按 id 稳定', () => {
    const a = { sessionId: 'a', updatedAt: 1, pinned: false } as SessionMeta
    const b = { sessionId: 'b', updatedAt: 1, pinned: false } as SessionMeta
    expect([b, a].sort(compareSessions).map((m) => m.sessionId)).toEqual(['a', 'b'])
  })
})

describe('mergeRows / patchRows / cache', () => {
  it('新 list 全量替换，但保留本地标题兜底', () => {
    const prev = [{ sessionId: 's1', title: '本地', updatedAt: 1, running: false, blank: false }]
    const next = [
      { sessionId: 's1', title: '', updatedAt: 5, running: true, blank: false },
      { sessionId: 's9', title: 'n', updatedAt: 2, running: false, blank: false }
    ]
    expect(mergeRows(prev, next)).toEqual([
      { sessionId: 's1', title: '本地', updatedAt: 5, running: true, blank: false },
      { sessionId: 's9', title: 'n', updatedAt: 2, running: false, blank: false }
    ])
  })
  it('patchRows 改标题，新活动解除 blank，未知 id 补行', () => {
    const rows = [{ sessionId: 's1', title: '', updatedAt: 1, running: false, blank: true }]
    expect(patchRows(rows, 's1', { title: 'T' })[0]).toMatchObject({ title: 'T', blank: true })
    expect(patchRows(rows, 's1', { updatedAt: 9 })[0]).toMatchObject({ updatedAt: 9, blank: false })
    expect(patchRows(rows, 'new', { title: 'N' })).toHaveLength(2)
  })
  it('缓存行往返后排序不变', () => {
    const metas = buildSessionList(parseSessionList(list), ws)
    expect(buildSessionList(toCacheRows(metas), undefined).map((m) => m.sessionId)).toEqual(metas.map((m) => m.sessionId))
  })
})

describe('applyWorkspaceFrame', () => {
  it('baseline 全量，增量帧合并，未就绪时忽略增量', () => {
    expect(applyWorkspaceFrame(undefined, { type: 'pinned', pinnedSessionIds: ['x'] })).toBeUndefined()
    let s = applyWorkspaceFrame(undefined, { type: 'baseline', value: ws })
    s = applyWorkspaceFrame(s, { type: 'upsert', workspace: { workspaceId: 'w3', path: '/c', title: 'C', sessionIds: [] } })
    s = applyWorkspaceFrame(s, { type: 'order', workspaceIds: ['w3', 'w2', 'w1'] })
    s = applyWorkspaceFrame(s, { type: 'remove', workspaceId: 'w2' })
    s = applyWorkspaceFrame(s, { type: 'archived', archivedSessionIds: [] })
    expect(s?.items.map((w) => w.workspaceId)).toEqual(['w3', 'w1'])
    expect(s?.archivedSessionIds).toEqual([])
    s = applyWorkspaceFrame(s, { type: 'replace', value: { items: [] } })
    expect(s).toEqual({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })
  })
})

describe('首页筛选 / 分组 / 时间', () => {
  const metas = buildSessionList(parseSessionList(list), ws)
  it('隐藏归档，按工作区与标题过滤', () => {
    expect(filterSessions(metas, ALL, '').map((m) => m.sessionId)).toEqual(['s2', 's3', 's1'])
    expect(filterSessions(metas, 'w1', '').map((m) => m.sessionId)).toEqual(['s2', 's1'])
    expect(filterSessions(metas, ALL, '一').map((m) => m.sessionId)).toEqual(['s1'])
  })
  it('分组按组内最新活跃排序', () => {
    const groups = groupByWorkspace(filterSessions(metas, ALL, ''))
    expect(groups.map((g) => g.id)).toEqual(['w2', 'w1'])
  })
  it('relativeTime', () => {
    const now = new Date(2026, 10, 19, 12, 0).getTime()
    expect(relativeTime(now - 10_000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5分钟前')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3小时前')
    expect(relativeTime(new Date(2026, 10, 18, 23, 0).getTime(), now)).toBe('昨天')
    expect(relativeTime(new Date(2026, 10, 15).getTime(), now)).toBe('4天前')
    expect(relativeTime(new Date(2026, 0, 2).getTime(), now)).toBe('1月2日')
  })
  it('isAuthError', () => {
    expect(isAuthError(new RpcError(RPC_UNAUTHORIZED, 'x', {}, 401))).toBe(true)
    expect(isAuthError(new RpcError('http/403', 'x', {}, 403))).toBe(true)
    expect(isAuthError(new RpcError('rpc/network', 'x'))).toBe(false)
  })
})
