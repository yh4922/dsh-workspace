/*
 * @Description: 保险箱加解密与主机读写的回归测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/vault/vault.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkVerifier, deriveKey, makeVerifier, newSalt, open, seal } from './crypto.js'
import { Vault, VaultLockedError, VaultUninitializedError } from './store.js'
import { collectDefaults, ResolveError, resolveTarget } from './inherit.js'
import type { GroupRecord, HostRecord } from '../types.js'

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-'))
  process.env.DSH_HOME = sandbox
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

describe('crypto', () => {
  it('seal/open 往返保持原文', () => {
    const key = deriveKey('pw', newSalt())
    const sealed = seal(key, 'hunter2')
    expect(sealed.c).not.toBe('hunter2')
    expect(open(key, sealed)).toBe('hunter2')
  })

  it('错误密钥解密必须抛错，而不是返回垃圾', () => {
    const salt = newSalt()
    const good = deriveKey('right', salt)
    const bad = deriveKey('wrong', salt)
    const sealed = seal(good, 'secret')
    expect(() => open(bad, sealed)).toThrow()
  })

  it('校验串只认正确密码', () => {
    const salt = newSalt()
    const key = deriveKey('right', salt)
    const verifier = makeVerifier(key)
    expect(checkVerifier(key, verifier)).toBe(true)
    expect(checkVerifier(deriveKey('wrong', salt), verifier)).toBe(false)
  })

  it('密文被篡改时校验失败', () => {
    const key = deriveKey('pw', newSalt())
    const verifier = makeVerifier(key)
    const tampered = { ...verifier, c: Buffer.from('tampered').toString('base64') }
    expect(checkVerifier(key, tampered)).toBe(false)
  })
})

describe('Vault', () => {
  it('锁定时可以列主机，但拿不到凭据', () => {
    const vault = new Vault()
    vault.initialize('master')
    const host = vault.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))
    vault.lock()

    // 列表可见是刻意设计：看主机名无害，「没解锁就一片空白」才是糟糕体验。
    const listed = vault.listHosts()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.label).toBe('srv')
    expect(listed[0]?.auth).toEqual({ kind: 'password', password: '' })

    expect(() => vault.getHostWithSecrets(host.id)).toThrow(VaultLockedError)
  })

  it('解锁后可取回凭据原文', () => {
    const vault = new Vault()
    vault.initialize('master')
    const host = vault.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))
    vault.lock()
    expect(vault.unlock('wrong')).toBe(false)
    expect(vault.unlock('master')).toBe(true)
    expect(vault.getHostWithSecrets(host.id)?.auth).toEqual({ kind: 'password', password: 'p@ss' })
  })

  it('改非敏感字段不需要解锁，且不破坏已存的密文', () => {
    const vault = new Vault()
    vault.initialize('master')
    const host = vault.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))
    vault.lock()

    vault.updateHost(host.id, { label: 'renamed' })

    expect(vault.unlock('master')).toBe(true)
    const after = vault.getHostWithSecrets(host.id)
    expect(after?.label).toBe('renamed')
    expect(after?.auth).toEqual({ kind: 'password', password: 'p@ss' })
  })

  it('subscribe：写盘后通知（新增 / 修改 / 删除主机），监听方抛错不影响保存，取消订阅后不再通知', () => {
    const vault = new Vault()
    let count = 0
    const off = vault.subscribe(() => {
      count += 1
      throw new Error('listener boom')
    })
    const host = vault.createHost(baseHost({}))
    vault.updateHost(host.id, { allowLocalShell: true })
    expect(vault.getHost(host.id)?.allowLocalShell).toBe(true)
    vault.updateHost(host.id, { allowLocalFiles: true })
    expect(vault.getHost(host.id)?.allowLocalFiles).toBe(true)
    vault.deleteHost(host.id)
    expect(count).toBe(4)
    off()
    vault.createHost(baseHost({}))
    expect(count).toBe(4)
  })

  it('改主密码后旧密码失效、凭据仍可解出', () => {
    const vault = new Vault()
    vault.initialize('old-master')
    const host = vault.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))

    expect(vault.changeMasterPassword('old-master', 'new-master')).toBe(true)
    vault.lock()
    expect(vault.unlock('old-master')).toBe(false)
    expect(vault.unlock('new-master')).toBe(true)
    expect(vault.getHostWithSecrets(host.id)?.auth).toEqual({ kind: 'password', password: 'p@ss' })
  })

  it('主密码过短被拒绝', () => {
    expect(() => new Vault().initialize('12345')).toThrow(/至少 6 位/)
  })

  it('未设置主密码时保存凭据，报「未初始化」而不是「已锁定」', () => {
    const vault = new Vault()
    // 两种处境给用户的引导完全不同：一个是去设置，一个是去解锁。
    expect(() =>
      vault.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))
    ).toThrow(VaultUninitializedError)
  })

  it('不带凭据的主机不需要主密码也能保存', () => {
    const vault = new Vault()
    const host = vault.createHost(baseHost({ auth: { kind: 'keyPath', keyPath: '/k/id_rsa' } }))
    expect(vault.getHost(host.id)?.auth).toEqual({ kind: 'keyPath', keyPath: '/k/id_rsa' })
  })

  it('auth 置为 null 即移除凭据，改为继承分组', () => {
    const vault = new Vault()
    vault.initialize('master')
    const host = vault.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))
    vault.updateHost(host.id, { auth: null })
    expect(vault.getHost(host.id)?.auth).toBeUndefined()
  })

  it('浏览器视图只带「是否设置过」的标志，绝不含凭据原文', () => {
    const vault = new Vault()
    vault.initialize('master')
    vault.createHost(
      baseHost({
        auth: { kind: 'keyContent', keyContent: 'PRIVATE-KEY-BODY', passphrase: 'pp' },
        proxy: { kind: 'socks5', host: 'px', port: 1080, username: 'u', password: 'proxy-pw' }
      })
    )
    const view = vault.listHostViews()[0]
    expect(view?.auth).toEqual({ kind: 'keyContent', hasSecret: true, hasPassphrase: true })
    expect(view?.proxy).toEqual({ kind: 'socks5', host: 'px', port: 1080, username: 'u', hasPassword: true })
    // 序列化后整串都不应出现任何密文或原文。
    const wire = JSON.stringify(view)
    for (const secret of ['PRIVATE-KEY-BODY', 'pp"', 'proxy-pw']) {
      expect(wire).not.toContain(secret)
    }
  })

  it('分组凭据加密落盘，磁盘上找不到明文', () => {
    const vault = new Vault()
    vault.initialize('master')
    vault.upsertGroup('prod', { username: 'root', auth: { kind: 'password', password: 'GROUP-SECRET' } })
    const onDisk = readFileSync(path.join(sandbox, 'workspaces', 'vault.json'), 'utf8')
    // 早期版本分组默认值是明文写盘的，这是那次缺陷的回归测试。
    expect(onDisk).not.toContain('GROUP-SECRET')
    expect(onDisk).toContain('root')
  })

  it('分组凭据锁定时不可读，解锁后可读', () => {
    const vault = new Vault()
    vault.initialize('master')
    vault.upsertGroup('prod', { auth: { kind: 'password', password: 'GROUP-SECRET' } })
    vault.lock()
    expect(() => vault.listGroupsWithSecrets()).toThrow(VaultLockedError)
    expect(vault.listGroups()[0]?.defaults.auth).toEqual({ kind: 'password', password: '' })
    vault.unlock('master')
    expect(vault.listGroupsWithSecrets()[0]?.defaults.auth).toEqual({
      kind: 'password',
      password: 'GROUP-SECRET'
    })
  })

  it('改主密码时分组凭据一并重新加密', () => {
    const vault = new Vault()
    vault.initialize('old-master')
    vault.upsertGroup('prod', { auth: { kind: 'password', password: 'GROUP-SECRET' } })
    vault.changeMasterPassword('old-master', 'new-master')
    vault.lock()
    vault.unlock('new-master')
    expect(vault.listGroupsWithSecrets()[0]?.defaults.auth).toEqual({
      kind: 'password',
      password: 'GROUP-SECRET'
    })
  })

  it('更新分组时不传 auth 则保留原凭据', () => {
    const vault = new Vault()
    vault.initialize('master')
    vault.upsertGroup('prod', { username: 'a', auth: { kind: 'password', password: 'KEEP' } })
    vault.upsertGroup('prod', { username: 'b' })
    const group = vault.listGroupsWithSecrets()[0]
    expect(group?.defaults.username).toBe('b')
    expect(group?.defaults.auth).toEqual({ kind: 'password', password: 'KEEP' })
  })

  it('分组路径被规范化', () => {
    const vault = new Vault()
    vault.upsertGroup(' /prod// web/ ', {})
    expect(vault.listGroups()[0]?.path).toBe('prod/web')
  })

  it('被分组引用为跳板的主机同样不能删除', () => {
    const vault = new Vault()
    const bastion = vault.createHost(baseHost({ label: 'bastion' }))
    vault.upsertGroup('prod', { jumpHostIds: [bastion.id] })
    expect(() => vault.deleteHost(bastion.id)).toThrow(/分组「prod」/)
  })

  it('被引用为跳板的主机不能删除', () => {
    const vault = new Vault()
    vault.initialize('master')
    const bastion = vault.createHost(baseHost({ label: 'bastion' }))
    vault.createHost(baseHost({ label: 'app', jumpHostIds: [bastion.id] }))

    // 静默删除会让依赖它的主机在下次连接时以费解的错误爆掉。
    expect(() => vault.deleteHost(bastion.id)).toThrow(/跳板机/)
  })

  it('数据能跨实例持久化', () => {
    const first = new Vault()
    first.initialize('master')
    first.createHost(baseHost({ auth: { kind: 'password', password: 'p@ss' } }))

    const second = new Vault()
    expect(second.isInitialized()).toBe(true)
    expect(second.listHosts()).toHaveLength(1)
    expect(second.unlock('master')).toBe(true)
    const id = second.listHosts()[0]?.id as string
    expect(second.getHostWithSecrets(id)?.auth).toEqual({ kind: 'password', password: 'p@ss' })
  })
})

describe('分组继承与跳板展开', () => {
  it('深层分组自顶向下合并，子层覆盖父层', () => {
    const groups: GroupRecord[] = [
      group('prod', { username: 'root', port: 22 }),
      group('prod/web', { username: 'deploy' })
    ]
    expect(collectDefaults('prod/web', groups)).toEqual({ username: 'deploy', port: 22 })
  })

  it('主机字段覆盖分组默认值', () => {
    const groups = [group('prod', { username: 'root' })]
    const host = baseHost({ groupPath: 'prod', username: 'app', auth: { kind: 'agent' } })
    const resolved = resolveTarget(host.id, new Map([[host.id, host]]), groups)
    expect(resolved.username).toBe('app')
  })

  it('主机缺用户名时回落到分组默认值', () => {
    const groups = [group('prod', { username: 'root' })]
    const host = baseHost({ groupPath: 'prod', auth: { kind: 'agent' } })
    delete (host as Partial<HostRecord>).username
    const resolved = resolveTarget(host.id, new Map([[host.id, host]]), groups)
    expect(resolved.username).toBe('root')
  })

  it('跳板链按顺序展开', () => {
    const bastion = baseHost({ label: 'bastion', auth: { kind: 'agent' } })
    const app = baseHost({ label: 'app', auth: { kind: 'agent' }, jumpHostIds: [bastion.id] })
    const hosts = new Map([
      [bastion.id, bastion],
      [app.id, app]
    ])
    const resolved = resolveTarget(app.id, hosts, [])
    expect(resolved.jumpChain).toHaveLength(1)
    expect(resolved.jumpChain[0]?.label).toBe('bastion')
  })

  it('循环跳板被检测并报错，而不是栈溢出', () => {
    const a = baseHost({ label: 'a', auth: { kind: 'agent' } })
    const b = baseHost({ label: 'b', auth: { kind: 'agent' }, jumpHostIds: [a.id] })
    a.jumpHostIds = [b.id]
    const hosts = new Map([
      [a.id, a],
      [b.id, b]
    ])
    expect(() => resolveTarget(a.id, hosts, [])).toThrow(ResolveError)
  })

  it('缺少认证方式时给出明确错误', () => {
    const host = baseHost({})
    delete (host as Partial<HostRecord>).auth
    expect(() => resolveTarget(host.id, new Map([[host.id, host]]), [])).toThrow(/认证方式/)
  })
})

let seq = 0

function baseHost(patch: Partial<HostRecord>): HostRecord {
  seq += 1
  const now = new Date().toISOString()
  return {
    id: `host-${seq}`,
    label: 'srv',
    hostname: '10.0.0.1',
    port: 22,
    username: 'root',
    groupPath: '',
    jumpHostIds: [],
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

function group(path: string, defaults: GroupRecord['defaults']): GroupRecord {
  const now = new Date().toISOString()
  return { path, defaults, createdAt: now, updatedAt: now }
}
