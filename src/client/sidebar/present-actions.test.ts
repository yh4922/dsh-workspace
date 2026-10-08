/*
 * @Description: 交付卡片 ▾ 菜单接管：只接管远程会话里的远程文件，其余原样放行
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/present-actions.test.ts
 */
import { describe, expect, it } from 'vitest'
import { RemoteIndex } from './remote-index.js'
import { SIDEBAR_PREVIEW_APP_ID, installPresentActions, parsePresentRequest, type PresentActionDeps } from './present-actions.js'

const ws = { localPath: 'C:\\ph\\app', hostId: 'h1', remotePath: '/srv/app', title: 'app' }
const BASE = 'http://127.0.0.1:43120/'

async function setup(lookup: (seq: number, index: number) => string | null | Error = () => '/srv/app/a.png') {
  const index = new RemoteIndex(async () => [ws], () => ({
    list: { getSnapshot: () => ({ byId: { remote: { cwd: ws.localPath }, local: { cwd: 'C:\\DshChat' } } }), subscribe: () => () => undefined }
  }))
  await index.refresh()
  const calls: string[] = []
  const rpc: Array<{ seq: number; index: number }> = []
  const deps: PresentActionDeps = {
    index,
    api: {
      call: (async (_m: string, p: { seq: number; index: number }) => {
        rpc.push(p)
        const r = lookup(p.seq, p.index)
        if (r instanceof Error) throw r
        return { remote: r === null ? null : { hostId: 'h1', remotePath: r } }
      }) as never
    },
    openResource: (a) => calls.push(`open ${a}`),
    revealInFiles: (s, p) => calls.push(`reveal ${s} ${p}`),
    canReveal: (_s, p) => p.startsWith('/srv/app/'),
    previewLabel: () => '侧栏预览'
  }
  const original: string[] = []
  const target = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      original.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return new Response('host', { status: 500 })
    }
  }
  const uninstall = installPresentActions(deps, target as never)
  return { target, calls, rpc, original, uninstall, deps }
}

const url = (session: string, extra = ''): string => `api/present.open?sessionId=${session}&seq=5&index=0${extra}`

describe('parsePresentRequest', () => {
  it('只识别卡片文件动作路由', () => {
    expect(parsePresentRequest(url('s', '&action=reveal'), { method: 'POST' }, BASE)).toEqual({ method: 'POST', sessionId: 's', seq: 5, index: 0, action: 'reveal' })
    expect(parsePresentRequest(url('s', '&application=x'), { method: 'POST' }, BASE)).toMatchObject({ action: 'open', application: 'x' })
    expect(parsePresentRequest('api/changes.open?sessionId=s&seq=5&index=0', undefined, BASE)).toBeUndefined()
    expect(parsePresentRequest('api/present.open?sessionId=s&seq=x&index=0', undefined, BASE)).toBeUndefined()
    expect(parsePresentRequest(new Request(new URL(url('s'), BASE)), undefined, BASE)).toBeUndefined()
    expect(parsePresentRequest(url('s'), { method: 'DELETE' }, BASE)).toBeUndefined()
  })
})

describe('installPresentActions', () => {
  it('远程会话的远程文件：GET 返回「侧栏预览」应用；打开 → 侧栏预览；显示位置 → 文件管理定位', async () => {
    const s = await setup()
    const apps = await (await s.target.fetch(url('remote'))).json()
    expect(apps).toEqual([{ id: SIDEBAR_PREVIEW_APP_ID, name: '侧栏预览', default: true, icon: null }])
    expect((await s.target.fetch(url('remote'), { method: 'POST' })).status).toBe(204)
    expect((await s.target.fetch(url('remote', `&application=${SIDEBAR_PREVIEW_APP_ID}`), { method: 'POST' })).status).toBe(204)
    expect((await s.target.fetch(url('remote', '&action=reveal'), { method: 'POST' })).status).toBe(204)
    expect(s.calls).toEqual([
      'open dsh-resource://file/session/remote//srv/app/a.png',
      'open dsh-resource://file/session/remote//srv/app/a.png',
      'reveal remote /srv/app/a.png'
    ])
    expect(s.original).toEqual([])
    // 同一坐标只查一次。
    expect(s.rpc).toHaveLength(1)
  })

  it('本地会话：不发 RPC，原样交给宿主', async () => {
    const s = await setup()
    await s.target.fetch(url('local', '&action=reveal'), { method: 'POST' })
    expect(s.rpc).toEqual([])
    expect(s.original).toEqual([`POST ${url('local', '&action=reveal')}`])
  })

  it('远程会话里交付的本机文件、查询失败：交还宿主；失败不缓存', async () => {
    let fail = true
    const s = await setup((_seq, index) => (index === 1 ? null : fail ? new Error('offline') : '/srv/app/a.png'))
    await s.target.fetch('api/present.open?sessionId=remote&seq=5&index=1', { method: 'POST' })
    await s.target.fetch(url('remote'), { method: 'POST' })
    expect(s.original).toHaveLength(2)
    fail = false
    expect((await s.target.fetch(url('remote'), { method: 'POST' })).status).toBe(204)
    expect(s.rpc.filter((r) => r.index === 0)).toHaveLength(2)
  })

  it('其他请求原样放行；卸载只还原自己的包装', async () => {
    const s = await setup()
    await s.target.fetch('api/present.host')
    expect(s.original).toEqual(['GET api/present.host'])
    const mine = s.target.fetch
    s.uninstall()
    expect(s.target.fetch).not.toBe(mine)

    const t = await setup()
    const later = async () => new Response('other')
    t.target.fetch = later as never
    t.uninstall()
    expect(t.target.fetch).toBe(later)
  })

  it('定位不了（工作区根以外 / 当前显示的是别的工作区）→ 422（宿主提示在侧边栏预览），不假装成功', async () => {
    const s = await setup(() => '/tmp/report.md')
    expect((await s.target.fetch(url('remote', '&action=reveal'), { method: 'POST' })).status).toBe(422)
    expect(s.calls).toEqual([])
    // 「打开」不受影响：照常在侧栏预览
    expect((await s.target.fetch(url('remote'), { method: 'POST' })).status).toBe(204)
    expect(s.calls).toEqual(['open dsh-resource://file/session/remote//tmp/report.md'])
  })

  it('热更新：新实例先装、旧实例后卸 → 只套一层、用新依赖；最后卸载才还原', async () => {
    const s = await setup()
    const hostFetch = (s.target as { fetch: unknown }).fetch
    const first = s.target.fetch
    const calls2: string[] = []
    const off2 = installPresentActions({ ...s.deps, revealInFiles: (_i, p) => void calls2.push(p) }, s.target as never)
    expect(s.target.fetch).toBe(first) // 没有再套一层
    s.uninstall() // 旧实例卸载：依赖已不是它的，什么都不做
    expect(s.target.fetch).toBe(first)
    await s.target.fetch(url('remote', '&action=reveal'), { method: 'POST' })
    expect(calls2).toEqual(['/srv/app/a.png'])
    expect(s.calls).toEqual([])
    off2()
    expect(s.target.fetch).not.toBe(first)
    void hostFetch
  })
})
