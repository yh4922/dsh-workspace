/*
 * @Description: 标签右键菜单项测试 —— 关闭类目标与禁用、可固定判断的禁用说明、文件类的复制路径与定位、降级
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/menu.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { LayoutLike, SidebarRightLike, TabRecordLike } from './host-layout.js'
import { buildMenuItems, fileTargetOf, toHostActions, type MenuDeps } from './menu.js'
import type { PinManager } from './pin-manager.js'
import { pinKey } from './pins.js'

const FILE = 'dsh-workspace:remote-file'
const FILES = 'dsh-workspace:remote-files'
const tabOf = (id: string, contentId = `dsh-resource://file/absolute/C:/w/${id}.txt`, kind = FILE): TabRecordLike => ({ id, kind, contentId })

/** 本机会话 s1，cwd = C:\w；远程会话 r1 映射远程工作区 /srv/app。 */
const index: MenuDeps['index'] = {
  bySession: (sid) => (sid === 'r1' ? { hostId: 'h1', remotePath: '/srv/app', localPath: 'C:\\remote\\app', title: 'app' } : undefined),
  sessionCwd: (sid) => (sid === 's1' ? 'C:\\w' : undefined),
  resolveAddress: (address) =>
    address.startsWith('dsh-resource://file/session/r1/')
      ? { workspace: { hostId: 'h1', remotePath: '/srv/app', localPath: 'C:\\remote\\app', title: 'app' }, remotePath: `/srv/app/${address.slice('dsh-resource://file/session/r1/'.length)}`, sessionId: 'r1' }
      : undefined,
  resolveLocalAddress: (address) => (address.startsWith('dsh-resource://file/absolute/') ? { path: `/${address.slice('dsh-resource://file/absolute/'.length)}` } : undefined)
} as MenuDeps['index']

function deps(layout: LayoutLike | undefined, pinned: TabRecordLike[] = [], right: Partial<SidebarRightLike> = {}): MenuDeps & { closed: string[] } {
  const closed: string[] = []
  const keys = new Set(pinned.map(pinKey))
  const manager = {
    subscribe: () => () => undefined,
    version: () => 0,
    pins: () => pinned.map((t) => ({ kind: t.kind, contentId: t.contentId })),
    pinnedIds: () => new Set(pinned.map((t) => t.id)),
    isPinned: (_sid: string, t: TabRecordLike) => keys.has(pinKey(t)),
    pin: () => true,
    unpin: () => undefined,
    dispose: () => undefined
  } as unknown as PinManager
  const r: SidebarRightLike = {
    adopted: { get: () => ({ store: { getSnapshot: () => ({ bySession: layout === undefined ? {} : { s1: { layout } } }), subscribe: () => () => undefined } }) },
    mounted: { getSnapshot: () => 's1', subscribe: () => () => undefined },
    closeIn: (_sid, id) => void closed.push(id),
    ...right
  }
  return { t: (k) => k, manager, right: () => r, isMultiple: () => undefined, index, filesKind: () => FILES, log: () => undefined, closed }
}

function paneLayout(ids: string[]): LayoutLike {
  const tabs: LayoutLike['tabs'] = {}
  for (const id of ids) tabs[id] = tabOf(id)
  return { rootId: 'A', nodes: { A: { kind: 'pane', id: 'A', host: 'dock', tabs: ids } }, floats: [], expanded: true, tabs }
}

const byId = (items: ReturnType<typeof buildMenuItems>, id: string) => items.find((i) => i.id === id)

describe('标签右键菜单项', () => {
  it('关闭类：跳过固定标签，逐个 closeIn；没有目标时禁用', () => {
    const d = deps(paneLayout(['a', 'b', 'c']), [tabOf('a')])
    const items = buildMenuItems(d, 's1', tabOf('b'))
    expect(byId(items, 'closeLeft')?.disabled).toBe(true)
    expect(byId(items, 'closeRight')?.disabled).toBe(false)
    byId(items, 'closeAll')!.run!()
    expect(d.closed).toEqual(['b', 'c'])
    // 开头不带组间分隔线（组件自己画一条）。
    expect(items[0]?.separator).not.toBe(true)
  })

  it('固定 / 取消固定；multiple 标签禁用并说明原因', () => {
    const d = deps(paneLayout(['a']), [tabOf('a')])
    expect(byId(buildMenuItems(d, 's1', tabOf('a')), 'unpin')).toBeDefined()
    const term = buildMenuItems(deps(paneLayout(['a'])), 's1', { id: 't', kind: 'terminal', contentId: 'sidebar://terminal/1' })
    expect(byId(term, 'pin')).toMatchObject({ disabled: true, title: 'tabmenu.pinMultiple' })
    // 非文件标签没有复制路径。
    expect(byId(term, 'copyPath')).toBeUndefined()
  })

  it('降级（读不到布局）：左右禁用，其他 / 全部按会话全体 + close 关；固定禁用', () => {
    const closed: string[] = []
    const d = deps(undefined, [], {
      closeIn: undefined,
      close: (id) => void closed.push(id),
      openTabs: { getSnapshot: () => [{ sessionId: 's1', tabId: 'a', kind: FILE, contentId: tabOf('a').contentId }, { sessionId: 's1', tabId: 'b', kind: FILE, contentId: tabOf('b').contentId }] }
    })
    const items = buildMenuItems(d, 's1', tabOf('a'))
    expect(byId(items, 'closeLeft')).toMatchObject({ disabled: true, title: 'tabmenu.hostUnsupported' })
    byId(items, 'closeOthers')!.run!()
    expect(closed).toEqual(['b'])
    expect(byId(items, 'pin')).toMatchObject({ disabled: true, title: 'tabmenu.hostUnsupported' })
  })

  it('宿主既无 closeIn 也无 close：不出关闭类，只剩固定 / 文件项', () => {
    const items = buildMenuItems(deps(paneLayout(['a']), [], { closeIn: undefined }), 's1', tabOf('a'))
    expect(byId(items, 'closeAll')).toBeUndefined()
    expect(items[0]?.id).toBe('pin')
  })
})

describe('文件类标签：复制路径与在文件管理中显示', () => {
  it('本机文件：复制原生路径；在会话 cwd 内才定位', () => {
    const inside = fileTargetOf(index, 's1', 'dsh-resource://file/absolute/C:/w/src/a.ts', FILES, 7)
    expect(inside).toEqual({ copy: 'C:\\w\\src\\a.ts', reveal: { kind: FILES, params: { reveal: '/C:/w/src/a.ts', nonce: 7 } } })
    const outside = fileTargetOf(index, 's1', 'dsh-resource://file/absolute/D:/x.txt', FILES, 7)
    expect(outside).toEqual({ copy: 'D:\\x.txt' })
  })
  it('远程文件：复制远程路径；同一远程工作区的会话里定位', () => {
    expect(fileTargetOf(index, 'r1', 'dsh-resource://file/session/r1/src/a.ts', FILES, 1)).toEqual({
      copy: '/srv/app/src/a.ts',
      remote: true,
      reveal: { kind: FILES, params: { reveal: '/srv/app/src/a.ts', nonce: 1 } }
    })
  })
  it('远程工作区会话的菜单不提供「在文件管理中显示」，只保留复制路径', () => {
    const items = buildMenuItems(deps(paneLayout(['a'])), 'r1', { id: 'a', kind: FILE, contentId: 'dsh-resource://file/session/r1/src/a.ts' })
    expect(byId(items, 'copyPath')).toBeDefined()
    expect(byId(items, 'reveal')).toBeUndefined()
  })
  it('文件管理未开启时不定位；非文件地址返回 undefined', () => {
    expect(fileTargetOf(index, 's1', 'dsh-resource://file/absolute/C:/w/a.ts', undefined, 1)).toEqual({ copy: 'C:\\w\\a.ts' })
    expect(fileTargetOf(index, 's1', 'sidebar://x', FILES, 1)).toBeUndefined()
  })
  it('菜单里定位不可用时禁用并说明', () => {
    const items = buildMenuItems(deps(paneLayout(['a'])), 's1', { id: 'a', kind: FILE, contentId: 'dsh-resource://file/absolute/D:/x.txt' })
    expect(byId(items, 'reveal')).toMatchObject({ disabled: true, title: 'tabmenu.revealUnavailable' })
    expect(byId(items, 'copyPath')?.disabled).toBeUndefined()
  })
})

describe('toHostActions', () => {
  it('分隔线折叠为下一项的 separatorBefore，首项与宿主组隔开，禁用态保留', () => {
    const actions = toHostActions(
      [
        { id: 'closeLeft', label: 'L', disabled: true, title: 'x' },
        { id: 'closeAll', label: 'A' },
        { id: 'pin-sep', separator: true },
        { id: 'pin', label: 'P' }
      ],
      () => undefined
    )
    expect(actions.map(({ run: _run, ...a }) => a)).toEqual([
      { id: 'closeLeft', label: 'L', disabled: true, separatorBefore: true },
      { id: 'closeAll', label: 'A' },
      { id: 'pin', label: 'P', separatorBefore: true }
    ])
  })

  it('动作抛错时记日志而不向宿主抛出', () => {
    const logs: string[] = []
    const [action] = toHostActions([{ id: 'x', label: 'X', run: () => { throw new Error('boom') } }], (m) => logs.push(m))
    expect(() => action!.run!()).not.toThrow()
    expect(logs).toHaveLength(1)
  })
})
