/*
 * @Description: H5 外壳 —— 路由解析与工作区汇总
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/mobile/mobile.test.ts
 */
import { describe, expect, it } from 'vitest'
import { directionOf, parseRoute, routeHash } from './route.js'
import { summarize, workspaceName, workspaceOf } from './host.js'
import { deviceName } from '../lan/format.js'
import { qrPath } from '../lan/Qr.js'

describe('H5 路由', () => {
  it('hash 往返', () => {
    for (const r of [{ level: 'home' }, { level: 'sessions', workspaceId: 'w/1 中' }, { level: 'session', sessionId: 's:2' }] as const) {
      expect(parseRoute(routeHash(r))).toEqual(r)
    }
    expect(parseRoute('#/x/1')).toEqual({ level: 'home' })
    expect(parseRoute('')).toEqual({ level: 'home' })
  })
  it('切页方向：进入下一级 / 同级为前进，回上级为返回', () => {
    expect(directionOf({ level: 'home' }, { level: 'sessions', workspaceId: 'a' })).toBe('forward')
    expect(directionOf({ level: 'session', sessionId: 's' }, { level: 'sessions', workspaceId: 'a' })).toBe('back')
    expect(directionOf({ level: 'session', sessionId: 's' }, { level: 'session', sessionId: 't' })).toBe('forward')
  })
})

describe('工作区汇总', () => {
  const ws = {
    archivedSessionIds: ['a3'],
    items: [
      { workspaceId: 'A', path: 'C:\\p\\alpha', title: '', sessionIds: ['a1', 'a2', 'a3', 'a4', 'a5'], createdAt: '2026-01-01T00:00:00Z' },
      { workspaceId: 'B', path: '/p/beta', title: 'default-workspace', sessionIds: [], createdAt: '2026-10-01T00:00:00Z' }
    ]
  }
  const ss = {
    byId: {
      a1: { id: 'a1', displayTitle: '旧', updatedAt: 100 },
      a2: { id: 'a2', displayTitle: '新', updatedAt: 5_000_000_000_000, running: true },
      a3: { id: 'a3', displayTitle: '归档', updatedAt: 9e15 },
      a4: { id: 'a4', displayTitle: '子代理', updatedAt: 9e15, origin: 'subagent' },
      a5: { id: 'a5', displayTitle: '空白', updatedAt: 9e15, blank: true }
    }
  }
  it('隐藏归档 / 子代理 / 非当前空白会话，按活跃排序，统计运行中', () => {
    const out = summarize(ws, ss, undefined, undefined)
    expect(out.map((s) => s.item.workspaceId)).toEqual(['A', 'B'])
    expect(out[0]!.sessions.map((s) => s.id)).toEqual(['a2', 'a1'])
    expect(out[0]!.running).toBe(1)
    expect(out[1]!.latest).toBeUndefined()
  })
  it('合成状态优先于行上的 running；当前空白会话可见', () => {
    const out = summarize(ws, ss, new Map([['a2', { running: false }]]), 'a5')
    expect(out[0]!.running).toBe(0)
    expect(out[0]!.sessions[0]!.id).toBe('a5')
  })
  it('显示名与反查', () => {
    expect(workspaceName(ws.items[0]!, '默认')).toBe('alpha')
    expect(workspaceName(ws.items[1]!, '默认')).toBe('默认')
    expect(workspaceOf(ws, 'a2')?.workspaceId).toBe('A')
  })
})

describe('远程访问页工具', () => {
  it('设备名识别', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(deviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/120.0 Mobile Safari/537.36')).toBe('Android · Chrome')
  })
  it('二维码矩阵', () => {
    const { size, d } = qrPath('http://192.168.1.20:3088/')
    expect(size).toBeGreaterThanOrEqual(21)
    expect(d.startsWith('M')).toBe(true)
  })
})
