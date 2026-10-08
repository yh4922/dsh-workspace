/*
 * @Description: 网关（浏览器可调用的全部远程方法）与 Typert 清单的测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/gateway.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from './wire/remote.js'
import { WorkspaceGateway, toRemote } from './gateway.js'
import { RemoteConflictError, RemoteExistsError } from './sftp/remote-fs.js'
import { createRuntime, DEFAULT_CONFIG, type WorkspaceRuntime } from './runtime.js'
import { HOST_MANIFEST } from './wire/manifest.js'
import { buildDescriptors, ERROR_CODES, METHODS, makeCodec } from './wire/contract.js'
import type { SaveHostInput } from './wire/dto.js'
import type { ShellChannel } from './terminal/registry.js'

let sandbox: string
let rt: WorkspaceRuntime
let gw: WorkspaceGateway

/** 网关测试不走真实 SSH：终端用假通道，关闭时发出 close 事件。 */
function fakeShell(): ShellChannel {
  const ch = new EventEmitter() as EventEmitter & ShellChannel
  let closed = false
  Object.assign(ch, {
    write: () => true,
    setWindow: () => undefined,
    close: () => {
      if (closed) return
      closed = true
      ch.emit('close')
    }
  })
  return ch
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-gw-'))
  process.env.DSH_HOME = sandbox
  rt = createRuntime(DEFAULT_CONFIG, { shellOpener: async () => fakeShell(), persistTerminals: false })
  gw = new WorkspaceGateway(new Context(), rt)
})

afterEach(() => {
  rt.dispose()
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

function host(patch: Partial<SaveHostInput> = {}): SaveHostInput {
  return {
    label: 'srv',
    hostname: '10.0.0.1',
    port: 22,
    username: 'root',
    groupPath: '',
    jumpHostIds: [],
    ...patch
  }
}

/** 断言一个 promise 以指定 code 的 RemoteError 失败。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    expect.unreachable(`应当以 ${code} 失败`)
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code)
  }
}

describe('Typert 清单', () => {
  it('每个 METHODS 条目都有描述符，且网关实现了对应方法', () => {
    expect(HOST_MANIFEST.invocations).toHaveLength(METHODS.length)
    for (const method of METHODS) {
      expect(typeof (gw as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('浏览器端与宿主端的描述符除 codec 外完全一致', () => {
    // 两端都由 buildDescriptors 生成；这里模拟浏览器端的直通 codec 再比对，
    // 防止将来有人手改其中一边导致调用在运行时才失配。
    const client = buildDescriptors((symbol) => makeCodec(symbol, (v) => v))
    const strip = (list: Array<Record<string, unknown>>): unknown =>
      JSON.parse(JSON.stringify(list, (key, value) => (key === 'schema' || key === 'create' ? undefined : value)))
    expect(strip(client)).toEqual(strip(HOST_MANIFEST.invocations))
  })

  it('输入校验：名称为空被拒绝', () => {
    const saveHost = HOST_MANIFEST.invocations.find((d) => d.method === 'saveHost') as {
      parameters: Array<{ codec: { schema: { parse(v: unknown): unknown } } }>
    }
    const codec = saveHost.parameters[0]?.codec
    expect(() => codec?.schema.parse(host({ label: '  ' }))).toThrow()
    expect(() => codec?.schema.parse(host({ port: 70000 }))).toThrow()
    expect(() => codec?.schema.parse(host())).not.toThrow()
  })
})

describe('主密码流程', () => {
  it('state 反映初始化与解锁状态', async () => {
    let s = await gw.state({})
    expect(s.initialized).toBe(false)
    expect(s.unlocked).toBe(false)
    await gw.initVault({ password: 'master-pw' })
    s = await gw.state({})
    expect(s.initialized).toBe(true)
    expect(s.unlocked).toBe(true)
    await gw.lock({})
    expect((await gw.state({})).unlocked).toBe(false)
  })

  it('错误主密码返回 ok:false 并留下警告日志', async () => {
    await gw.initVault({ password: 'master-pw' })
    await gw.lock({})
    expect((await gw.unlock({ password: 'wrong' })).ok).toBe(false)
    expect(rt.log.list().some((e) => e.level === 'warn' && e.stage === 'vault')).toBe(true)
  })

  it('未设置主密码就保存密码 → vault-uninitialized（引导去设置）', async () => {
    await expectCode(
      gw.saveHost(host({ auth: { kind: 'password', password: 'p' } })),
      ERROR_CODES.vaultUninitialized
    )
  })

  it('已锁定时保存密码 → vault-locked（引导去解锁）', async () => {
    await gw.initVault({ password: 'master-pw' })
    await gw.lock({})
    await expectCode(
      gw.saveHost(host({ auth: { kind: 'password', password: 'p' } })),
      ERROR_CODES.vaultLocked
    )
  })
})

describe('主机编辑语义', () => {
  beforeEach(async () => {
    await gw.initVault({ password: 'master-pw' })
  })

  it('返回给浏览器的视图不含密码', async () => {
    const view = await gw.saveHost(host({ auth: { kind: 'password', password: 'TOP-SECRET' } }))
    expect(JSON.stringify(view)).not.toContain('TOP-SECRET')
    expect(view.auth).toEqual({ kind: 'password', hasSecret: true, hasPassphrase: false })
  })

  it('编辑时密码留空 = 沿用原密码', async () => {
    const created = await gw.saveHost(host({ auth: { kind: 'password', password: 'KEEP-ME' } }))
    await gw.saveHost(host({ id: created.id, label: 'renamed', auth: { kind: 'password' } }))
    expect(rt.vault.getHostWithSecrets(created.id)?.auth).toEqual({ kind: 'password', password: 'KEEP-ME' })
    expect(rt.vault.getHost(created.id)?.label).toBe('renamed')
  })

  it('不传 auth 键 = 完全不动凭据，且锁定状态下也能改名', async () => {
    const created = await gw.saveHost(host({ auth: { kind: 'password', password: 'KEEP-ME' } }))
    await gw.lock({})
    // 改个名字不该要求输主密码。
    await gw.saveHost(host({ id: created.id, label: 'renamed-while-locked' }))
    await gw.unlock({ password: 'master-pw' })
    expect(rt.vault.getHostWithSecrets(created.id)?.auth).toEqual({ kind: 'password', password: 'KEEP-ME' })
  })

  it('新建时密码留空被拒绝', async () => {
    await expectCode(gw.saveHost(host({ auth: { kind: 'password' } })), ERROR_CODES.failed)
  })

  it('切换认证方式后沿用逻辑不跨类型', async () => {
    const created = await gw.saveHost(host({ auth: { kind: 'password', password: 'OLD' } }))
    // 从密码切到私钥内容，没填私钥 —— 不能把旧密码当私钥沿用。
    await expectCode(
      gw.saveHost(host({ id: created.id, auth: { kind: 'keyContent' } })),
      ERROR_CODES.failed
    )
  })

  it('私钥口令可显式清除', async () => {
    const created = await gw.saveHost(
      host({ auth: { kind: 'keyPath', keyPath: '/k/id', passphrase: 'pp' } })
    )
    await gw.saveHost(
      host({ id: created.id, auth: { kind: 'keyPath', keyPath: '/k/id', clearPassphrase: true } })
    )
    expect(rt.vault.getHostWithSecrets(created.id)?.auth).toEqual({ kind: 'keyPath', keyPath: '/k/id' })
  })

  it('代理密码留空沿用，clearPassword 清除', async () => {
    const proxy = { kind: 'socks5' as const, host: 'px', port: 1080, username: 'u' }
    const created = await gw.saveHost(host({ proxy: { ...proxy, password: 'PX' } }))
    await gw.saveHost(host({ id: created.id, proxy }))
    expect(rt.vault.getHostWithSecrets(created.id)?.proxy?.password).toBe('PX')
    await gw.saveHost(host({ id: created.id, proxy: { ...proxy, clearPassword: true } }))
    expect(rt.vault.getHostWithSecrets(created.id)?.proxy?.password).toBeUndefined()
  })

  it('不能把自己设为跳板机', async () => {
    const created = await gw.saveHost(host())
    await expectCode(
      gw.saveHost(host({ id: created.id, jumpHostIds: [created.id] })),
      ERROR_CODES.failed
    )
  })

  it('引用不存在的跳板机被拒绝', async () => {
    await expectCode(gw.saveHost(host({ jumpHostIds: ['ghost'] })), ERROR_CODES.failed)
  })
})

describe('分组', () => {
  beforeEach(async () => {
    await gw.initVault({ password: 'master-pw' })
  })

  it('重命名分组：子分组与主机一起迁移，凭据随行', async () => {
    await gw.saveGroup({ path: 'prod', auth: { kind: 'password', password: 'GROUP-PW' } })
    await gw.saveGroup({ path: 'prod/web', username: 'deploy' })
    const h = await gw.saveHost(host({ groupPath: 'prod/web' }))

    await gw.saveGroup({ path: 'production', previousPath: 'prod' })

    const paths = rt.vault.listGroups().map((g) => g.path).sort()
    expect(paths).toEqual(['production', 'production/web'])
    expect(rt.vault.getHost(h.id)?.groupPath).toBe('production/web')
    expect(rt.vault.listGroupsWithSecrets().find((g) => g.path === 'production')?.defaults.auth).toEqual({
      kind: 'password',
      password: 'GROUP-PW'
    })
  })

  it('不能把分组移到自己的子路径下', async () => {
    await gw.saveGroup({ path: 'prod' })
    await expectCode(gw.saveGroup({ path: 'prod/inner', previousPath: 'prod' }), ERROR_CODES.failed)
    // 失败后原分组必须完好。
    expect(rt.vault.listGroups().map((g) => g.path)).toEqual(['prod'])
  })

  it('主机继承分组的密码并能解析出完整目标', async () => {
    await gw.saveGroup({ path: 'prod', username: 'root', auth: { kind: 'password', password: 'INHERITED' } })
    const h = await gw.saveHost(host({ groupPath: 'prod', auth: null }))
    delete (h as { username?: string }).username
    const target = rt.resolveHost(h.id)
    expect(target.auth).toEqual({ kind: 'password', password: 'INHERITED' })
  })

  it('锁定时解析需要继承密码的主机 → vault-locked', async () => {
    await gw.saveGroup({ path: 'prod', auth: { kind: 'password', password: 'INHERITED' } })
    const h = await gw.saveHost(host({ groupPath: 'prod', auth: null }))
    await gw.lock({})
    await expectCode(gw.testConnection({ id: h.id }), ERROR_CODES.vaultLocked)
  })
})

describe('日志与连接', () => {
  it('测试一个不可达的主机返回 ok:false 而不是抛错', async () => {
    await gw.initVault({ password: 'master-pw' })
    // 127.0.0.1:1 基本不可能有 SSH 服务，会被立即拒绝。
    const h = await gw.saveHost(
      host({ hostname: '127.0.0.1', port: 1, auth: { kind: 'password', password: 'x' } })
    )
    const result = await gw.testConnection({ id: h.id })
    expect(result.ok).toBe(false)
    expect(result.message.length).toBeGreaterThan(0)
    // 失败必须留痕。
    expect((await gw.logs({ hostId: h.id })).some((e) => e.level === 'error')).toBe(true)
  })

  it('删除被引用的跳板主机 → 失败并说明引用方', async () => {
    const bastion = await gw.saveHost(host({ label: 'bastion' }))
    await gw.saveHost(host({ label: 'app', jumpHostIds: [bastion.id] }))
    try {
      await gw.deleteHost({ id: bastion.id })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('app')
    }
  })
})

describe('终端', () => {
  /** 记录 pool.disconnect 调用，用于断言「改名不断连」。 */
  function spyDisconnect(): string[] {
    const calls: string[] = []
    const original = rt.pool.disconnect.bind(rt.pool)
    rt.pool.disconnect = (id: string, kind?: 'terminal' | 'file') => {
      calls.push(id)
      original(id, kind)
    }
    return calls
  }

  it('打开终端后出现在 state 中，默认标题为主机名，同主机自动编号', async () => {
    const h = await gw.saveHost(host({ label: 'web-01' }))
    const a = await gw.openTerminal({ hostId: h.id, cols: 80, rows: 24 })
    const b = await gw.openTerminal({ hostId: h.id, cols: 80, rows: 24 })
    expect(a.title).toBe('web-01')
    expect(b.title).toBe('web-01 (2)')
    expect((await gw.state({})).terminals.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('只改名称 / 备注不断开连接 —— 否则会杀掉该主机上所有终端', async () => {
    const h = await gw.saveHost(host({ label: 'web-01' }))
    const term = await gw.openTerminal({ hostId: h.id, cols: 80, rows: 24 })
    const calls = spyDisconnect()
    await gw.saveHost(host({ id: h.id, label: 'web-01-renamed', notes: '改了备注' }))
    expect(calls).toEqual([])
    expect(rt.terminals.get(term.id)?.status).toBe('open')
  })

  it('改了连接参数（地址 / 端口 / 用户 / 分组 / 跳板 / 凭据）则断开', async () => {
    const h = await gw.saveHost(host())
    const bastion = await gw.saveHost(host({ label: 'bastion' }))
    const cases: Array<Partial<SaveHostInput>> = [
      { hostname: '10.0.0.2' },
      { port: 2222 },
      { username: 'other' },
      { groupPath: 'prod' },
      { jumpHostIds: [bastion.id] },
      { auth: { kind: 'agent' } }
    ]
    for (const change of cases) {
      const calls = spyDisconnect()
      await gw.saveHost(host({ id: h.id, ...change }))
      expect(calls, JSON.stringify(change)).toContain(h.id)
    }
  })

  it('删除主机时关闭它的全部终端', async () => {
    const h = await gw.saveHost(host())
    await gw.openTerminal({ hostId: h.id, cols: 80, rows: 24 })
    await gw.deleteHost({ id: h.id })
    expect(rt.terminals.list()).toHaveLength(0)
  })

  it('打开不存在主机的终端 → 明确报错', async () => {
    await expectCode(gw.openTerminal({ hostId: 'ghost', cols: 80, rows: 24 }), ERROR_CODES.failed)
  })

  it('改名与后台保留', async () => {
    const h = await gw.saveHost(host())
    const term = await gw.openTerminal({ hostId: h.id, cols: 80, rows: 24 })
    expect((await gw.renameTerminal({ id: term.id, title: '构建' })).title).toBe('构建')
    expect((await gw.setTerminalKeepAlive({ id: term.id, keepAlive: true })).keepAlive).toBe(true)
    await gw.closeTerminal({ id: term.id })
    expect(rt.terminals.list()).toHaveLength(0)
  })
})

describe('错误映射 toRemote', () => {
  it('【回归】已带 code 的 RemoteError 原样放行，不被改写成 failed', () => {
    // 此前 toRemote 会把 ssh2-unavailable 这类已带 code 的错误重新包成 failed，
    // 浏览器据 code 的分支全部失效。
    const original = new RemoteError(ERROR_CODES.ssh2Unavailable, 'ssh2 不可用', {})
    expect(toRemote(original).code).toBe(ERROR_CODES.ssh2Unavailable)
  })

  it('SFTP 状态码：2 → not-found，3 → 权限不足', () => {
    expect(toRemote(Object.assign(new Error('No such file'), { code: 2 })).code).toBe(ERROR_CODES.notFound)
    const denied = toRemote(Object.assign(new Error('Permission denied'), { code: 3 }))
    expect(denied.code).toBe(ERROR_CODES.failed)
    expect(denied.message).toContain('权限不足')
  })

  it('目标已存在 → exists，并带上路径', () => {
    const mapped = toRemote(new RemoteExistsError('/tmp/a'))
    expect(mapped.code).toBe(ERROR_CODES.exists)
    expect(mapped.details).toEqual({ path: '/tmp/a' })
  })
})

describe('测试未保存的表单（testDraft）', () => {
  // 127.0.0.1:1 必然拒绝连接：测试不依赖网络，也能走完「解析 → 连接 → 失败」全程。
  const unreachable = { hostname: '127.0.0.1', port: 1 }

  beforeEach(async () => {
    await gw.initVault({ password: 'master-pw' })
  })

  it('新建主机的草稿：返回失败原因，且不会写进保险箱', async () => {
    const result = await gw.testDraft(host({ ...unreachable, auth: { kind: 'password', password: 'p' } }))
    expect(result.ok).toBe(false)
    expect(result.message.length).toBeGreaterThan(0)
    expect(rt.vault.listHosts()).toHaveLength(0)
  })

  it('编辑中的草稿：已保存的配置保持不变', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'password', password: 'old' } }))
    await gw.testDraft(host({ id: saved.id, ...unreachable, label: '改了名' }))
    const after = rt.vault.getHost(saved.id)
    expect(after?.hostname).toBe('10.0.0.1')
    expect(after?.label).toBe('srv')
  })

  it('凭据未改动时沿用已保存的密码（锁定时要求解锁）', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'password', password: 'old' } }))
    await gw.lock({})
    await expectCode(gw.testDraft(host({ id: saved.id, ...unreachable })), ERROR_CODES.vaultLocked)
  })

  it('新建时密码为空 → 明确报错，而不是拿空密码去连', async () => {
    await expectCode(gw.testDraft(host({ ...unreachable, auth: { kind: 'password', password: '' } })), ERROR_CODES.failed)
  })

  it('把自己设为跳板 → 拒绝', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'agent' } }))
    await expectCode(gw.testDraft(host({ id: saved.id, jumpHostIds: [saved.id] })), ERROR_CODES.failed)
  })

  it('保存冲突映射为 conflict，并带上远端当前的修改时间', () => {
    const mapped = toRemote(new RemoteConflictError('/a', 1700000000000, 12))
    expect(mapped.code).toBe(ERROR_CODES.conflict)
    expect(mapped.details).toEqual({ mtime: 1700000000000, size: 12 })
  })
})

describe('添加工作区（createRemoteWorkspace / setTakeover）', () => {
  beforeEach(async () => {
    await gw.initVault({ password: 'master-pw' })
  })

  it('远程目录存在 → 建占位目录并登记；会话 cwd 可反查；重复添加幂等', async () => {
    const saved = await gw.saveHost(host({ hostname: 'box.example', username: 'ps', auth: { kind: 'agent' } }))
    rt.files.statPath = async () => ({ type: 'dir', size: 0, mtimeMs: 0 })
    const a = await gw.createRemoteWorkspace({ hostId: saved.id, remotePath: '/home/ps/中山渔业/', title: '渔业' })
    expect(path.basename(a.localPath)).toBe('渔业')
    expect(a.localPath).toContain('box.example-ps-22')
    expect(rt.bindings.resolve(a.localPath)).toMatchObject({ hostId: saved.id, remotePath: '/home/ps/中山渔业' })
    const again = await gw.createRemoteWorkspace({ hostId: saved.id, remotePath: '/home/ps/中山渔业', title: '渔业' })
    expect(again.localPath).toBe(a.localPath)
  })

  it('远程路径不存在 / 不是目录 / 主机不存在 → 明确报错，不建任何目录', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'agent' } }))
    rt.files.statPath = async () => undefined
    await expectCode(gw.createRemoteWorkspace({ hostId: saved.id, remotePath: '/nope', title: 'x' }), ERROR_CODES.failed)
    rt.files.statPath = async () => ({ type: 'file', size: 1, mtimeMs: 0 })
    await expectCode(gw.createRemoteWorkspace({ hostId: saved.id, remotePath: '/etc/hosts', title: 'x' }), ERROR_CODES.failed)
    await expectCode(gw.createRemoteWorkspace({ hostId: 'ghost', remotePath: '/srv', title: 'x' }), ERROR_CODES.failed)
    expect(rt.bindings.list()).toHaveLength(0)
  })

  it('【安全】输入校验：远程路径必须是绝对路径，名称不能为空', () => {
    const d = HOST_MANIFEST.invocations.find((x) => x.method === 'createRemoteWorkspace') as {
      parameters: Array<{ codec: { schema: { parse(v: unknown): unknown } } }>
    }
    const schema = d.parameters[0]?.codec.schema
    expect(() => schema?.parse({ hostId: 'h', remotePath: 'relative/p', title: 'x' })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', remotePath: '/p', title: '   ' })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', remotePath: '/p', title: 'ok' })).not.toThrow()
  })

  it('【安全】git 只能在已登记的远程工作区根目录执行；输入校验拦截非法提交号', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'agent' } }))
    await expectCode(gw.git({ hostId: saved.id, root: '/etc', op: 'status' }), ERROR_CODES.failed)
    const d = HOST_MANIFEST.invocations.find((x) => x.method === 'git') as {
      parameters: Array<{ codec: { schema: { parse(v: unknown): unknown } } }>
    }
    const schema = d.parameters[0]?.codec.schema
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'show', hash: 'HEAD;rm -rf /', parent: null })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'status' })).not.toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'push' })).toThrow()
    // 已取消检出：面板只能查看其他分支，不能切换工作目录的分支。
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'checkout', name: 'main' })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'tree', ref: 'HEAD~1', dir: '' })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'tree', ref: 'refs/heads/main', dir: '' })).not.toThrow()
    // 编辑分支：引用必须是完整引用名；目标 diff 类型 branch 同样校验
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'branchSave', ref: 'refs/heads/f', path: 'a.txt', content: 'x' })).not.toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'branchSave', ref: 'f;rm -rf /', path: 'a.txt', content: 'x' })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'branchCommit', ref: 'refs/heads/f', message: '' })).toThrow()
    expect(() => schema?.parse({ hostId: 'h', root: '/srv', op: 'diff', target: { kind: 'branch', ref: 'HEAD~2', path: 'a' } })).toThrow()
  })

  it('remoteWorkspaces 列出绑定；previewUrl 只为工作区内的文件签发，令牌绑定工作区根', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'agent' } }))
    rt.files.statPath = async () => ({ type: 'dir', size: 0, mtimeMs: 0 })
    // 工作区外的路径会再问一次 git 有没有其他工作目录：这里没有真实主机，连接直接失败 → 视为没有。
    rt.pool.acquire = async () => {
      throw new Error('offline')
    }
    await gw.createRemoteWorkspace({ hostId: saved.id, remotePath: '/srv/app', title: 'app' })
    expect((await gw.remoteWorkspaces({})).workspaces).toEqual([expect.objectContaining({ hostId: saved.id, remotePath: '/srv/app', title: 'app' })])
    const { url } = await gw.previewUrl({ hostId: saved.id, path: '/srv/app/web/index.html' })
    expect(url).toMatch(/^\/dsh-workspace\/preview\/[A-Za-z0-9_-]+\/srv\/app\/web\/index\.html$/)
    await expectCode(gw.previewUrl({ hostId: saved.id, path: '/etc/passwd' }), ERROR_CODES.failed)
    await expectCode(gw.previewUrl({ hostId: saved.id, path: '/srv/application/x' }), ERROR_CODES.failed)
  })

  it('presentedFile：交付卡片里的远程文件 → 远程路径；本机文件 / 非远程会话 / 无效事件 → null', async () => {
    const saved = await gw.saveHost(host({ auth: { kind: 'agent' } }))
    rt.files.statPath = async () => ({ type: 'dir', size: 0, mtimeMs: 0 })
    const ws = await gw.createRemoteWorkspace({ hostId: saved.id, remotePath: '/srv/app', title: 'app' })
    const events: Record<number, { target: { type: string; data: unknown }; session: { cwd?: string } }> = {
      5: { target: { type: 'deliverables/presented', data: { turn: 1, callId: 'c', files: [{ path: '/srv/app/a.png' }, { path: 'C:\\pic\\b.png' }, { path: 'docs/c.md' }] } }, session: { cwd: ws.localPath } },
      6: { target: { type: 'deliverables/presented', data: { turn: 1, callId: 'c', files: [{ path: '/srv/app/a.png' }] } }, session: { cwd: sandbox } },
      7: { target: { type: 'tool/result', data: {} }, session: { cwd: ws.localPath } },
      // 工作区根以外：带远程标记的是远程文件；没有标记的（macOS / Linux 上交还宿主的本机文件）不是。
      9: {
        target: { type: 'deliverables/presented', data: { turn: 2, callId: 'c', files: [{ path: '/tmp/report.md', remoteHost: saved.id }, { path: '/Users/me/pic.png' }] } },
        session: { cwd: ws.localPath }
      },
      // 与宿主 isPresentedData 一致：turn 无效的事件不认。
      10: { target: { type: 'deliverables/presented', data: { turn: 0, callId: 'c', files: [{ path: '/srv/app/a.png' }] } }, session: { cwd: ws.localPath } }
    }
    const ctx = new Context()
    ctx.provide('sessionQuery')
    ctx.set('sessionQuery', {
      readEvent: async (q: { sessionId: string; seq: number }) => {
        const hit = events[q.seq]
        if (hit === undefined) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' })
        return hit
      }
    })
    const g = new WorkspaceGateway(ctx, rt)
    expect(await g.presentedFile({ sessionId: 's', seq: 5, index: 0 })).toEqual({ remote: { hostId: saved.id, remotePath: '/srv/app/a.png' } })
    expect(await g.presentedFile({ sessionId: 's', seq: 5, index: 1 })).toEqual({ remote: null })
    expect(await g.presentedFile({ sessionId: 's', seq: 5, index: 2 })).toEqual({ remote: { hostId: saved.id, remotePath: '/srv/app/docs/c.md' } })
    expect(await g.presentedFile({ sessionId: 's', seq: 5, index: 9 })).toEqual({ remote: null })
    expect(await g.presentedFile({ sessionId: 's', seq: 6, index: 0 })).toEqual({ remote: null })
    expect(await g.presentedFile({ sessionId: 's', seq: 7, index: 0 })).toEqual({ remote: null })
    expect(await g.presentedFile({ sessionId: 's', seq: 9, index: 0 })).toEqual({ remote: { hostId: saved.id, remotePath: '/tmp/report.md' } })
    expect(await g.presentedFile({ sessionId: 's', seq: 9, index: 1 })).toEqual({ remote: null })
    expect(await g.presentedFile({ sessionId: 's', seq: 10, index: 0 })).toEqual({ remote: null })
    await expectCode(g.presentedFile({ sessionId: 's', seq: 8, index: 0 }), ERROR_CODES.failed)
    // 宿主没有 sessionQuery（旧版）：返回 null，浏览器交还宿主处理。
    expect(await gw.presentedFile({ sessionId: 's', seq: 5, index: 0 })).toEqual({ remote: null })
  })

  it('接管开关：默认开启，关闭后持久化（重建运行时仍为关闭）', async () => {
    expect((await gw.getPrefs({})).takeoverAddWorkspace).toBe(true)
    expect((await gw.setTakeover({ enabled: false })).takeoverAddWorkspace).toBe(false)
    const rt2 = createRuntime(DEFAULT_CONFIG, { shellOpener: async () => fakeShell(), persistTerminals: false })
    expect(rt2.prefs.get().takeoverAddWorkspace).toBe(false)
    rt2.dispose()
    // 关闭开关不影响已有的忽略规则。
    await gw.setIgnore({ rules: ['dist'] })
    expect((await gw.getPrefs({})).takeoverAddWorkspace).toBe(false)
  })
})

describe('编辑器资源分段下发（editorAsset）', () => {
  it('分段拼回与原文逐字一致（含跨段边界的中文），越界报错', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dshws-asset-'))
    // 跨越 3 个分段（每段 512K 字符），并在分段边界处放中文。
    const text = `${'a'.repeat(512 * 1024 - 1)}中文${'b'.repeat(700 * 1024)}结尾`
    writeFileSync(path.join(dir, 'monaco.js'), text)
    rt.web.assetsDir = dir
    try {
      const first = await gw.editorAsset({ name: 'monaco.js', index: 0 })
      expect(first.total).toBe(3)
      const parts = [first.chunk]
      for (let i = 1; i < first.total; i += 1) {
        const part = await gw.editorAsset({ name: 'monaco.js', index: i })
        expect(part.version).toBe(first.version)
        parts.push(part.chunk)
      }
      expect(parts.join('')).toBe(text)
      await expectCode(gw.editorAsset({ name: 'monaco.js', index: 3 }), ERROR_CODES.failed)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('资源更新后版本号随之变化（前端据此拒绝拼接两个版本）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dshws-asset-'))
    writeFileSync(path.join(dir, 'monaco.js'), 'v1')
    rt.web.assetsDir = dir
    try {
      const v1 = (await gw.editorAsset({ name: 'monaco.js', index: 0 })).version
      writeFileSync(path.join(dir, 'monaco.js'), 'version-2')
      const v2 = await gw.editorAsset({ name: 'monaco.js', index: 0 })
      expect(v2.version).not.toBe(v1)
      expect(v2.chunk).toBe('version-2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('资源目录未设置时明确报错；state 如实报告路由未挂载', async () => {
    rt.web.assetsDir = undefined
    await expectCode(gw.editorAsset({ name: 'monaco.js', index: 0 }), ERROR_CODES.failed)
    expect((await gw.state({})).webRoutes).toBe(false)
  })

  it('【安全】资源名只接受白名单（输入校验层拦截路径穿越）', () => {
    const d = HOST_MANIFEST.invocations.find((x) => x.method === 'editorAsset') as {
      parameters: Array<{ codec: { schema: { parse(v: unknown): unknown } } }>
    }
    const schema = d.parameters[0]?.codec.schema
    expect(() => schema?.parse({ name: '../../package.json', index: 0 })).toThrow()
    expect(() => schema?.parse({ name: 'monaco.js', index: 0 })).not.toThrow()
  })
})

describe('文件接口', () => {
  it('未登记的主机 id 一律拒绝，不会去连任意主机', async () => {
    for (const call of [
      () => gw.sftpHome({ hostId: 'ghost' }),
      () => gw.sftpList({ hostId: 'ghost', path: '/' }),
      () => gw.sftpRemove({ hostId: 'ghost', path: '/tmp/x' }),
      () => gw.sftpSearch({ hostId: 'ghost', root: '/', query: 'a' })
    ]) {
      await expectCode(call(), ERROR_CODES.failed)
    }
  })

  it('忽略规则可读写，并附带只读的默认规则', async () => {
    const initial = await gw.getPrefs({})
    expect(initial.ignore).toEqual([])
    expect(initial.defaultIgnore).toContain('node_modules/')
    const saved = await gw.setIgnore({ rules: ['  *.log  ', '', 'tmp/'] })
    // 首尾空白被去掉、空行被丢弃。
    expect(saved.ignore).toEqual(['*.log', 'tmp/'])
    expect((await gw.getPrefs({})).ignore).toEqual(['*.log', 'tmp/'])
  })

  it('文件接口的输入校验：路径必须是绝对路径', () => {
    const list = HOST_MANIFEST.invocations.find((d) => d.method === 'sftpList') as {
      parameters: Array<{ codec: { schema: { parse(v: unknown): unknown } } }>
    }
    const codec = list.parameters[0]?.codec
    expect(() => codec?.schema.parse({ hostId: 'h', path: 'relative/p' })).toThrow()
    expect(() => codec?.schema.parse({ hostId: 'h', path: '/abs' })).not.toThrow()
  })
})

describe('本地工作区（hostId = local:<会话 id>）', () => {
  it('文件与 git 都按会话 cwd 在本机执行，不查保险箱；工作区外的路径被拒', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'dshws-gw-local-'))
    writeFileSync(path.join(ws, 'a.txt'), 'hello')
    rt.host.sessions = { get: (id) => (id === 's1' ? { header: { cwd: ws } } : undefined) }
    const lp = (p: string): string => (process.platform === 'win32' ? `/${p.replace(/\\/g, '/')}` : p)
    const root = lp(realpathSync(ws))
    const listed = await gw.sftpList({ hostId: 'local:s1', path: root })
    expect(listed.entries.map((e) => e.name)).toEqual(['a.txt'])
    expect((await gw.sftpRead({ hostId: 'local:s1', path: `${root}/a.txt` })).content).toBe('hello')
    expect(await gw.sftpHome({ hostId: 'local:s1' })).toEqual({ path: root })
    await expect(gw.sftpList({ hostId: 'local:s1', path: lp(realpathSync(tmpdir())) })).rejects.toThrow(/不在当前工作区内/)
    await expect(gw.sftpList({ hostId: 'local:nope', path: root })).rejects.toThrow(/会话没有工作目录/)
    const status = (await gw.git({ hostId: 'local:s1', root, op: 'status' })) as { isRepo: boolean }
    expect(status.isRepo).toBe(false)
    rmSync(ws, { recursive: true, force: true })
  })
})