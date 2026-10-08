/*
 * @Description: 右侧栏远程会话判定测试 —— 地址解析、路径映射、按会话查远程工作区
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/remote-index.test.ts
 */
import { describe, expect, it } from 'vitest'
import { RemoteIndex, displayPath, localFileAddress, normalizePosix, parseFileAddress, revealPlan, sessionFileAddress, toLocalPosix, toRemotePath } from './remote-index.js'
import { centeredScrollTop } from './VirtualList.js'

describe('显示文件位置：定位计划与滚动', () => {
  it('展开从根到父目录的每一级；点开头的段需要显示隐藏文件；根外 / 根本身不定位', () => {
    expect(revealPlan('/srv/app', '/srv/app/public/img/a.png')).toEqual({ dirs: ['/srv/app/public', '/srv/app/public/img'], hidden: false })
    expect(revealPlan('/srv/app/', '/srv/app/a.png')).toEqual({ dirs: [], hidden: false })
    expect(revealPlan('/srv/app', '/srv/app/.github/wf.yml')).toEqual({ dirs: ['/srv/app/.github'], hidden: true })
    expect(revealPlan('/', '/etc/hosts')).toEqual({ dirs: ['/etc'], hidden: false })
    expect(revealPlan('/srv/app', '/srv/apple/a')).toBeUndefined()
    expect(revealPlan('/srv/app', '/srv/app')).toBeUndefined()
  })

  it('目标行居中，靠顶部时不出现负值', () => {
    const offsets = [0, 26, 52, 78, 104, 130]
    expect(centeredScrollTop(offsets, 4, 52, 0)).toBe(91)
    expect(centeredScrollTop(offsets, 0, 520, 0)).toBe(0)
    expect(centeredScrollTop(offsets, 4, 52, 40)).toBe(131)
  })
})

const ws = {
  localPath: 'C:\\Users\\yangheng\\.dsh\\workspaces\\remote\\192.168.3.112-ps-22\\测试DSH远程',
  hostId: 'h1',
  remotePath: '/home/ps/testdsh',
  title: '测试DSH远程'
}

function indexWith(sessions: Record<string, { cwd?: string }>) {
  const index = new RemoteIndex(async () => [ws], () => ({ list: { getSnapshot: () => ({ byId: sessions }), subscribe: () => () => undefined } }))
  return index
}

describe('文件地址', () => {
  it('DSH 生成的会话地址（远程绝对路径保留前导 /，中文逐段编码）可往返', () => {
    const addr = sessionFileAddress('session-1', '/home/ps/testdsh/calculator/index.html')
    expect(addr).toBe('dsh-resource://file/session/session-1//home/ps/testdsh/calculator/index.html')
    expect(parseFileAddress(addr)).toEqual({ scope: 'session', sessionId: 'session-1', path: '/home/ps/testdsh/calculator/index.html' })
    expect(parseFileAddress(sessionFileAddress('s', '文档/说明.md'))?.path).toBe('文档/说明.md')
  })

  it('absolute 地址：盘符与 POSIX', () => {
    expect(parseFileAddress('dsh-resource://file/absolute/C:/x/y.txt')?.path).toBe('C:/x/y.txt')
    expect(parseFileAddress('dsh-resource://file/absolute/home/a')?.path).toBe('/home/a')
    expect(parseFileAddress('https://x')).toBeUndefined()
  })
})

describe('路径映射', () => {
  it('远程绝对路径原样；相对路径接到远程根；.. 折叠', () => {
    expect(toRemotePath(ws, '/home/ps/testdsh/app.js')).toBe('/home/ps/testdsh/app.js')
    expect(toRemotePath(ws, 'calculator/index.html')).toBe('/home/ps/testdsh/calculator/index.html')
    expect(toRemotePath(ws, 'a/../b')).toBe('/home/ps/testdsh/b')
    expect(normalizePosix('/a/./b/../c')).toBe('/a/c')
  })

  it('占位目录下的本机路径换成远程路径（大小写、斜杠方向不敏感）；其他本机路径不属于该工作区', () => {
    expect(toRemotePath(ws, 'c:/users/yangheng/.dsh/workspaces/remote/192.168.3.112-ps-22/测试DSH远程/x/y.ts')).toBe('/home/ps/testdsh/x/y.ts')
    expect(toRemotePath(ws, 'C:\\home\\ps\\testdsh\\app.js')).toBeUndefined()
  })

  it('macOS / Linux：占位目录本身以 / 开头，也要先换成远程路径（不能当远程路径原样发出去）', () => {
    const mac = { ...ws, localPath: '/Users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app' }
    expect(toRemotePath(mac, '/Users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app/src/a.ts')).toBe('/home/ps/testdsh/src/a.ts')
    expect(toRemotePath(mac, '/Users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app')).toBe('/home/ps/testdsh')
    // 真正的远程绝对路径照旧
    expect(toRemotePath(mac, '/home/ps/testdsh/b.ts')).toBe('/home/ps/testdsh/b.ts')
    // Linux 区分大小写：只差大小写的路径不算占位目录
    expect(toRemotePath(mac, '/users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app/x')).toBe('/users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app/x')
  })
})

describe('RemoteIndex', () => {
  it('只有远程工作区的会话里的地址才被认领（这是修「点开文件读 C 盘」的判定）', async () => {
    const index = indexWith({ remote: { cwd: ws.localPath }, local: { cwd: 'C:\\DshChat' } })
    await index.refresh()
    const hit = index.resolveAddress(sessionFileAddress('remote', '/home/ps/testdsh/calculator/index.html'))
    expect(hit?.remotePath).toBe('/home/ps/testdsh/calculator/index.html')
    expect(hit?.workspace.hostId).toBe('h1')
    expect(index.resolveAddress(sessionFileAddress('local', '/home/ps/testdsh/app.js'))).toBeUndefined()
    expect(index.resolveAddress(sessionFileAddress('unknown', 'a.txt'))).toBeUndefined()
    expect(index.bySession('remote')?.title).toBe('测试DSH远程')
  })

  it('远程会话里交付的本机文件（盘符路径）不认领，交回宿主预览', async () => {
    const index = indexWith({ remote: { cwd: ws.localPath } })
    await index.refresh()
    // 宿主 fileAddressFor 对本机盘符路径生成的就是这种地址。
    expect(index.resolveAddress('dsh-resource://file/session/remote/C:/DshChat/pic/a.png')).toBeUndefined()
    expect(index.resolveAddress(sessionFileAddress('remote', '/home/ps/testdsh/public/a.png'))?.remotePath).toBe('/home/ps/testdsh/public/a.png')
  })

  it('列表内容没变时不通知、沿用旧对象（否则远程 Git 面板会反复整页重载并关掉预览）', async () => {
    let list = [{ ...ws }]
    const index = new RemoteIndex(async () => list.map((w) => ({ ...w })), () => ({ list: { getSnapshot: () => ({ byId: { s: { cwd: ws.localPath } } }), subscribe: () => () => undefined } }))
    let notified = 0
    index.subscribe(() => notified++)
    await index.refresh()
    const first = index.bySession('s')
    await index.refresh()
    await index.refresh()
    expect(notified).toBe(1)
    expect(index.bySession('s')).toBe(first)
    list = [{ ...ws, title: '改名' }]
    await index.refresh()
    expect(notified).toBe(2)
    expect(index.bySession('s')?.title).toBe('改名')
  })

  it('列表未加载 / 加载失败时一律不认领（交还原处理方，而不是报错）', async () => {
    const failing = new RemoteIndex(async () => {
      throw new Error('not ready')
    }, () => undefined)
    await failing.refresh()
    expect(failing.resolveAddress(sessionFileAddress('s', '/x'))).toBeUndefined()
  })
})

describe('本地工作区（文件管理 / Git 仓库）', () => {
  it('本地 POSIX 形式、显示路径、绝对文件地址', () => {
    expect(toLocalPosix('C:\\DshChat\\ws\\')).toBe('/C:/DshChat/ws')
    expect(toLocalPosix('D:\\')).toBe('/D:')
    expect(toLocalPosix('/home/me/p/')).toBe('/home/me/p')
    expect(displayPath('/C:/DshChat/ws/a.ts')).toBe('C:\\DshChat\\ws\\a.ts')
    expect(displayPath('/home/ps/a')).toBe('/home/ps/a')
    expect(localFileAddress('/C:/x/中 文.ts')).toBe('dsh-resource://file/absolute/C:/x/%E4%B8%AD%20%E6%96%87.ts')
    expect(parseFileAddress(localFileAddress('/C:/x/a.ts'))).toEqual({ scope: 'absolute', path: 'C:/x/a.ts' })
    expect(parseFileAddress(localFileAddress('/home/a'))).toEqual({ scope: 'absolute', path: '/home/a' })
  })

  it('workspaceFor：远程会话给远程工作区，本地会话给 local:<会话 id>；对象稳定；bySession 仍只认远程', async () => {
    const index = indexWith({ r: { cwd: `${ws.localPath}\\sub` }, l: { cwd: 'C:\\DshChat\\proj' }, n: {} })
    await index.refresh()
    expect(index.workspaceFor('r')).toMatchObject({ hostId: 'h1', remotePath: '/home/ps/testdsh', local: false })
    const local = index.workspaceFor('l')
    expect(local).toEqual({ localPath: 'C:\\DshChat\\proj', hostId: 'local:l', remotePath: '/C:/DshChat/proj', title: 'proj', local: true })
    expect(index.workspaceFor('l')).toBe(local)
    expect(index.workspaceFor('n')).toBeUndefined()
    expect(index.bySession('l')).toBeUndefined()
    // 本插件的远程文件查看器不认领本地文件（交给宿主 / 其他插件的查看器）
    expect(index.resolveAddress(localFileAddress('/C:/DshChat/proj/a.ts'))).toBeUndefined()
  })
})