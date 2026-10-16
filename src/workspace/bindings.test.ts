/*
 * @Description: 远程工作区绑定测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/workspace/bindings.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BindingStore,
  REMOTE_ROOT_SEGMENT,
  folderName,
  isLocalHostPath,
  isRemoteInside,
  relativeToRoot,
  remotePathSegments,
  remoteWorkspacesRoot,
  toRemotePath
} from './bindings.js'
import { WORKSPACE_META_FILE, bindingsFile } from '../paths.js'

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-bind-'))
  process.env.DSH_HOME = sandbox
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

const input = { hostId: 'h1', endpoint: '10.0.0.1-root-22', remotePath: '/home/ps/中山渔业', title: '中山渔业' }

describe('BindingStore', () => {
  it('创建占位目录、写 meta、登记；目录名保留中文', () => {
    const store = new BindingStore()
    const b = store.create(input)
    expect(existsSync(b.localPath)).toBe(true)
    expect(path.basename(b.localPath)).toBe('中山渔业')
    const meta = JSON.parse(readFileSync(path.join(b.localPath, WORKSPACE_META_FILE), 'utf8'))
    expect(meta).toMatchObject({ kind: 'dsh-workspace/remote', hostId: 'h1', remotePath: '/home/ps/中山渔业' })
    expect(store.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
  })

  it('同一主机同一远程目录再次创建：幂等返回同一记录', () => {
    const store = new BindingStore()
    expect(store.create(input).localPath).toBe(store.create(input).localPath)
    expect(store.list()).toHaveLength(1)
  })

  it('旧布局登记再次创建：新增新布局登记，旧登记保留（同主机同远程目录多条并存）', () => {
    const store = new BindingStore()
    // 手工构造一条旧布局登记（旧版占位目录 = <endpoint>/<标题>）。
    const legacyDir = path.join(remoteWorkspacesRoot(), input.endpoint, folderName(input.title))
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, WORKSPACE_META_FILE), JSON.stringify({ kind: 'dsh-workspace/remote', version: 1, hostId: input.hostId, remotePath: input.remotePath, title: input.title, createdAt: '2026-01-01T00:00:00.000Z' }, null, 2), 'utf8')
    store.resolve(legacyDir) // 触发 meta 自愈，把旧布局登记补进映射表
    expect(store.list()).toHaveLength(1)

    const b = store.create(input)
    expect(b.localPath).toBe(path.join(remoteWorkspacesRoot(), input.endpoint, ...remotePathSegments(input.remotePath)))
    expect(b.localPath).not.toBe(legacyDir)
    expect(existsSync(path.join(b.localPath, WORKSPACE_META_FILE))).toBe(true)
    // 新旧两条登记并存：不删旧登记也不动旧目录——已有会话的 cwd 还指向旧目录，
    // 删了登记它们就静默失联（上游评审 #9 第 1 条，方案 A）。
    expect(store.list()).toHaveLength(2)
    expect(existsSync(legacyDir)).toBe(true)
    expect(existsSync(path.join(legacyDir, WORKSPACE_META_FILE))).toBe(true)
    // 指向旧目录的旧会话仍被认作远程工作区（凭旧目录 meta 反查，不走幽灵防线）。
    expect(store.resolve(legacyDir)?.remotePath).toBe('/home/ps/中山渔业')
    expect(store.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
  })

  it('新布局登记再次创建：直接幂等返回，不重建目录', () => {
    const store = new BindingStore()
    const first = store.create(input)
    const again = store.create(input)
    expect(again.localPath).toBe(first.localPath)
    expect(again.createdAt).toBe(first.createdAt)
    expect(store.list()).toHaveLength(1)
  })

  it('占位目录按远程路径结构展开：子目录落在父工作区目录内（DSH 按工作区树据此嵌套）', () => {
    const store = new BindingStore()
    const parent = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'root' })
    const child = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/Yunzai', title: '云崽' })
    expect(parent.localPath).toBe(path.join(remoteWorkspacesRoot(), 'ep', 'root'))
    expect(child.localPath).toBe(path.join(parent.localPath, 'Yunzai'))
    expect(store.resolve(child.localPath)?.remotePath).toBe('/root/Yunzai')
  })

  it('先建子目录再建父目录：父目录收编中间层，创建顺序不影响嵌套', () => {
    const store = new BindingStore()
    const child = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/Yunzai', title: '云崽' })
    const parent = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'root' })
    expect(parent.localPath).toBe(path.dirname(child.localPath))
    expect(new BindingStore().resolve(parent.localPath)?.remotePath).toBe('/root')
  })

  it('远程根用固定段，不与常见的 /root 抢同一个目录', () => {
    const store = new BindingStore()
    const root = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/', title: 'root' })
    const home = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'root' })
    expect(path.basename(root.localPath)).toBe(REMOTE_ROOT_SEGMENT)
    expect(home.localPath).toBe(path.join(remoteWorkspacesRoot(), 'ep', 'root'))
    expect(root.localPath).not.toBe(home.localPath)
  })

  it('不同远程目录消毒后落到同一段：目录名追加短哈希，不串台', () => {
    const store = new BindingStore()
    const a = store.create({ ...input, remotePath: '/srv/a:b', title: 'a:b' })
    const b = store.create({ ...input, remotePath: '/srv/a*b', title: 'a*b' })
    expect(a.localPath).not.toBe(b.localPath)
    expect(store.resolve(a.localPath)?.remotePath).toBe('/srv/a:b')
    expect(store.resolve(b.localPath)?.remotePath).toBe('/srv/a*b')
  })

  it('撞车让位目录重复创建：幂等返回原登记，不删自己的登记（上游评审 #9 第 2 条）', () => {
    const store = new BindingStore()
    store.create({ ...input, remotePath: '/srv/a:b', title: 'a:b' })
    const first = store.create({ ...input, remotePath: '/srv/a*b', title: 'a*b' })
    expect(path.basename(first.localPath)).toMatch(/a_b-[0-9a-f]{6}$/)
    const second = store.create({ ...input, remotePath: '/srv/a*b', title: 'a*b' })
    expect(second.localPath).toBe(first.localPath)
    expect(second.createdAt).toBe(first.createdAt)
    expect(store.list()).toHaveLength(2)
    expect(store.resolve(first.localPath)?.remotePath).toBe('/srv/a*b')
  })

  it('让位父目录的子工作区挂回让位目录内，不挂进占错节点的兄弟（上游评审 #9 第 4 条）', () => {
    const store = new BindingStore()
    store.create({ ...input, remotePath: '/srv/a:b', title: 'a:b' })
    const parent = store.create({ ...input, remotePath: '/srv/a*b', title: 'a*b' })
    expect(path.basename(parent.localPath)).toMatch(/a_b-[0-9a-f]{6}$/)
    const child = store.create({ ...input, remotePath: '/srv/a*b/c', title: 'c' })
    expect(child.localPath).toBe(path.join(parent.localPath, 'c'))
    expect(store.resolve(child.localPath)?.remotePath).toBe('/srv/a*b/c')
  })

  it('不同大小写的远程目录在大小写不敏感文件系统上互相让位、各自解析正确', () => {
    const store = new BindingStore()
    const lower = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/app', title: 'app' })
    const upper = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/App', title: 'App' })
    expect(upper.localPath).not.toBe(lower.localPath)
    expect(store.resolve(lower.localPath)?.remotePath).toBe('/root/app')
    expect(store.resolve(upper.localPath)?.remotePath).toBe('/root/App')
  })

  it('不同主机的同一远程目录分别让位，互不覆盖登记（上游评审 #9 R2-A）', () => {
    const store = new BindingStore()
    const a = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/srv/app', title: 'app' })
    const b = store.create({ hostId: 'h2', endpoint: 'ep', remotePath: '/srv/app', title: 'app' })
    expect(b.localPath).not.toBe(a.localPath)
    expect(store.list()).toHaveLength(2)
    expect(store.resolve(a.localPath)?.hostId).toBe('h1')
    expect(store.resolve(b.localPath)?.hostId).toBe('h2')
    // 重复创建各自幂等：回到原登记，不新增、不覆盖
    expect(store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/srv/app', title: 'app' }).localPath).toBe(a.localPath)
    expect(store.create({ hostId: 'h2', endpoint: 'ep', remotePath: '/srv/app', title: 'app' }).localPath).toBe(b.localPath)
    expect(store.list()).toHaveLength(2)
  })

  it('大小写变体不收编已登记子工作区的父目录，再次创建原工作区仍幂等（上游评审 #9 R2-B）', () => {
    const store = new BindingStore()
    const child = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/Yunzai', title: 'Yunzai' })
    const upper = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/Root', title: 'Root' })
    // /Root 不得把子工作区的父目录 ep/root 当成自己的占位目录收编
    expect(upper.localPath).not.toBe(path.dirname(child.localPath))
    expect(store.resolve(path.dirname(child.localPath))?.remotePath).toBeUndefined()
    expect(store.resolve(child.localPath)?.remotePath).toBe('/root/Yunzai')
    expect(store.resolve(upper.localPath)?.remotePath).toBe('/Root')
    // 幂等回归：/Root 收编失败后，再次创建 /root/Yunzai 落位不变、不新增重复登记
    const again = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/Yunzai', title: 'Yunzai' })
    expect(again.localPath).toBe(child.localPath)
    expect(store.list()).toHaveLength(2)
  })

  it('跨主机不收编已登记子工作区的父目录，再次创建原工作区仍幂等（上游评审 #9 R3-X）', () => {
    const store = new BindingStore()
    // h2 先建 /root/Yunzai（落在 ep/root/Yunzai），h1 再建 /root 时不得把中间层 ep/root 收编挂到自己名下
    const child = store.create({ hostId: 'h2', endpoint: 'ep', remotePath: '/root/Yunzai', title: 'c' })
    const parent = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'p' })
    expect(parent.localPath).not.toBe(path.dirname(child.localPath))
    expect(store.resolve(path.dirname(child.localPath))?.hostId).toBeUndefined()
    expect(store.resolve(parent.localPath)?.remotePath).toBe('/root')
    expect(store.resolve(child.localPath)?.hostId).toBe('h2')
    // 幂等回归：h2 再次创建 /root/Yunzai 回原目录，不新增重复登记
    const again = store.create({ hostId: 'h2', endpoint: 'ep', remotePath: '/root/Yunzai', title: 'c' })
    expect(again.localPath).toBe(child.localPath)
    expect(store.list()).toHaveLength(2)
  })

  it('映射表丢失后，新旧两条登记各自凭占位目录里的 meta 自愈（上游评审 #9 第 3 条）', () => {
    const store = new BindingStore()
    const legacyDir = path.join(remoteWorkspacesRoot(), input.endpoint, folderName(input.title))
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, WORKSPACE_META_FILE), JSON.stringify({ kind: 'dsh-workspace/remote', version: 1, hostId: input.hostId, remotePath: input.remotePath, title: input.title, createdAt: '2026-01-01T00:00:00.000Z' }, null, 2), 'utf8')
    store.resolve(legacyDir) // 触发 meta 自愈
    const b = store.create(input)
    expect(store.list()).toHaveLength(2)
    unlinkSync(bindingsFile())
    const recovered = new BindingStore()
    expect(recovered.resolve(legacyDir)?.remotePath).toBe('/home/ps/中山渔业')
    expect(recovered.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
    expect(recovered.list()).toHaveLength(2)
  })

  it('会话 cwd 写法不同（大小写 / 结尾斜杠 / 子目录）也能反查', () => {
    const store = new BindingStore()
    const b = store.create({ ...input, title: 'App' })
    expect(store.resolve(`${b.localPath}${path.sep}`)?.hostId).toBe('h1')
    expect(store.resolve(path.join(b.localPath, 'sub', 'dir'))?.hostId).toBe('h1')
    if (process.platform === 'win32') expect(store.resolve(b.localPath.toUpperCase())?.hostId).toBe('h1')
  })

  it('本地普通目录不是远程工作区', () => {
    expect(new BindingStore().resolve(sandbox)).toBeUndefined()
    expect(new BindingStore().resolve(undefined)).toBeUndefined()
  })

  it('映射表丢失：按占位目录里的 meta 文件自愈并补登记', () => {
    const b = new BindingStore().create(input)
    unlinkSync(bindingsFile())
    const fresh = new BindingStore()
    expect(fresh.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
    expect(existsSync(bindingsFile())).toBe(true)
  })

  it('映射表损坏不抛错', () => {
    const store = new BindingStore(() => path.join(sandbox, 'bad.json'))
    writeFileSync(path.join(sandbox, 'bad.json'), '{not json')
    expect(store.list()).toEqual([])
  })

  it('解除登记后不再是远程工作区（meta 也要避免自愈：remove 后删 meta 由调用方决定）', () => {
    const store = new BindingStore()
    const b = store.create(input)
    expect(store.remove(b.localPath)).toBe(true)
    unlinkSync(path.join(b.localPath, WORKSPACE_META_FILE))
    expect(store.resolve(b.localPath)).toBeUndefined()
  })
})

describe('remotePathSegments', () => {
  it('逐段消毒、丢弃空段与 . / ..；远程根用固定段', () => {
    expect(remotePathSegments('/home/ps/中山渔业')).toEqual(['home', 'ps', '中山渔业'])
    expect(remotePathSegments('/srv/a:b*c')).toEqual(['srv', 'a_b_c'])
    expect(remotePathSegments('/./a//b/../c/')).toEqual(['a', 'b', 'c'])
    expect(remotePathSegments('/')).toEqual([REMOTE_ROOT_SEGMENT])
    expect(remotePathSegments('')).toEqual([REMOTE_ROOT_SEGMENT])
    expect(remotePathSegments('/a/b/c')).toEqual(['a', 'b', 'c']) // 8 层以内不折叠
  })

  it('超过 8 层的远程路径：保留前 7 段，剩余折叠为 8 位十六进制短哈希段（确定性）', () => {
    const deep = remotePathSegments('/a/b/c/d/e/f/g/h/i')
    expect(deep).toEqual([...remotePathSegments('/a/b/c/d/e/f/g'), expect.stringMatching(/^[0-9a-f]{8}$/)])
    expect(deep).toEqual(remotePathSegments('/a/b/c/d/e/f/g/h/i/')) // 尾斜杠不改变折叠结果
    expect(remotePathSegments('/a/b/c/d/e/f/g/h/x')[7]).not.toBe(deep[7])
  })
})

describe('isRemoteInside', () => {
  it('相等或真子路径为真；仅同前缀不是；远程根包含一切', () => {
    expect(isRemoteInside('/root', '/root')).toBe(true)
    expect(isRemoteInside('/root/Yunzai', '/root')).toBe(true)
    expect(isRemoteInside('/rootx', '/root')).toBe(false)
    expect(isRemoteInside('/root', '/root/Yunzai')).toBe(false)
    expect(isRemoteInside('/anything', '/')).toBe(true)
    expect(isRemoteInside('/srv/a*b/c', '/srv/a*b')).toBe(true)
  })
})

describe('folderName', () => {
  it('替换非法字符、处理保留名与结尾点', () => {
    expect(folderName('a:b*c?')).toBe('a_b_c_')
    expect(folderName('con')).toBe('_con')
    expect(folderName('name. ')).toBe('name')
    expect(folderName('')).toBe('_')
  })
})

describe('toRemotePath', () => {
  const b = { localPath: path.join(tmpdir(), 'ph', 'app'), hostId: 'h', remotePath: '/srv/app', title: 'app', createdAt: '' }

  it('远程绝对路径原样；相对路径相对远程根；. 与 .. 折叠', () => {
    expect(toRemotePath(b, '/etc/hosts')).toBe('/etc/hosts')
    expect(toRemotePath(b, 'src/a.ts')).toBe('/srv/app/src/a.ts')
    expect(toRemotePath(b, './src/../README.md')).toBe('/srv/app/README.md')
    expect(toRemotePath(b, '.')).toBe('/srv/app')
  })

  it('模型照抄会话 cwd 写出的本地绝对路径 → 换成远程根下对应路径', () => {
    expect(toRemotePath(b, path.join(b.localPath, 'src', 'a.ts'))).toBe('/srv/app/src/a.ts')
    expect(toRemotePath(b, b.localPath)).toBe('/srv/app')
  })

  it('【安全】占位目录以外的本机路径一律拒绝 —— 远程会话绝不能碰本机文件', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : path.join(tmpdir(), 'other')
    if (process.platform === 'win32') expect(() => toRemotePath(b, outside)).toThrow(/本机路径/)
  })

  it('relativeToRoot', () => {
    expect(relativeToRoot(b, '/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(relativeToRoot(b, '/srv/app')).toBe('.')
    expect(relativeToRoot(b, '/etc/x')).toBe('/etc/x')
  })
})

describe('isLocalHostPath（allowLocalFiles 的路径判定，与 toRemotePath 的拒绝分支逐分支对齐）', () => {
  const b = { localPath: path.join(tmpdir(), 'ph', 'app'), hostId: 'h', remotePath: '/srv/app', title: 'app', createdAt: '' }

  it('Windows 盘符 / UNC 绝对路径算本机；POSIX 绝对、相对路径永远不算（allowLocalFiles 不改变远程口径）', () => {
    expect(isLocalHostPath(b, 'C:\\Users\\me\\note.txt')).toBe(true)
    expect(isLocalHostPath(b, 'c:/users/me/note.txt')).toBe(true)
    expect(isLocalHostPath(b, '\\\\server\\share\\a.txt')).toBe(true)
    expect(isLocalHostPath(b, '/etc/hosts')).toBe(false)
    expect(isLocalHostPath(b, 'src/a.ts')).toBe(false)
    expect(isLocalHostPath(b, '.')).toBe(false)
    expect(isLocalHostPath(b, '')).toBe(false)
  })

  it('占位目录内的 Windows 路径不算本机 —— 与 toRemotePath 的「映射回远程」例外一致', () => {
    expect(isLocalHostPath(b, path.join(b.localPath, 'src', 'a.ts'))).toBe(false)
    expect(isLocalHostPath(b, b.localPath)).toBe(false)
    expect(isLocalHostPath(b, path.join(b.localPath, '..', 'elsewhere', 'x.txt'))).toBe(true)
  })

  it('非字符串输入按不算本机处理（与工具参数缺省一致）', () => {
    expect(isLocalHostPath(b, undefined as unknown as string)).toBe(false)
  })
})
