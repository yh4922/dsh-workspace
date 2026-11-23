/*
 * @Description: SFTP ↔ exec 路径视角映射的测试（issue #17：群晖 DSM 的 SFTP 把 /volume1 当作 /）
 * @Author: YangHeng
 * @Date: 2026-11-23 16:40:00
 * @FilePath: /dsh-workspace/src/ssh/path-view.test.ts
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IDENTITY_VIEW,
  PathViews,
  bindingPathView,
  derivePrefix,
  ensureExecRoot,
  execFromEither,
  makePathView,
  resolveWorkspaceRoots,
  rootListingConsistent,
  sftpFromEither,
  toExecPath,
  toSftpPath
} from './path-view.js'
import { SshAgentBackend } from '../agent/backend.js'
import { FakeSftp } from '../sftp/fake-sftp.js'
import { RemoteFs } from '../sftp/remote-fs.js'
import type { WorkspaceRuntime } from '../runtime.js'
import { BindingStore } from '../workspace/bindings.js'
import { WORKSPACE_META_FILE, bindingsFile } from '../paths.js'

describe('纯函数', () => {
  it('derivePrefix：后缀关系推算前缀，必须在段边界上切开', () => {
    expect(derivePrefix('/homes/ps', '/volume1/homes/ps')).toBe('/volume1')
    expect(derivePrefix('/home/ps', '/home/ps')).toBe('')
    expect(derivePrefix('/home/ps/', '/home/ps')).toBe('')
    expect(derivePrefix('/', '/volume1/homes/ps')).toBe('/volume1/homes/ps') // chroot 到家目录
    expect(derivePrefix('/homes/ps', '/data/xhomes/ps')).toBeUndefined()
    expect(derivePrefix('/homes/ps', '/srv/other')).toBeUndefined()
    expect(derivePrefix('relative', '/x')).toBeUndefined()
  })

  it('toExecPath / toSftpPath 双向换算；前缀外的 exec 路径 SFTP 不可达', () => {
    expect(toExecPath('/volume1', '/AI-agent/Home-NAS')).toBe('/volume1/AI-agent/Home-NAS')
    expect(toExecPath('/volume1', '/')).toBe('/volume1')
    expect(toExecPath('', '/srv/app')).toBe('/srv/app')
    expect(toSftpPath('/volume1', '/volume1/AI-agent/Home-NAS')).toBe('/AI-agent/Home-NAS')
    expect(toSftpPath('/volume1', '/volume1')).toBe('/')
    expect(toSftpPath('/volume1', '/volume10/x')).toBeUndefined()
    expect(toSftpPath('/volume1', '/etc/hosts')).toBeUndefined()
    expect(toSftpPath('', '/etc/hosts')).toBe('/etc/hosts')
  })

  it('任一视角归一化：已在前缀内视为 exec 视角', () => {
    expect(sftpFromEither('/volume1', '/volume1/AI-agent')).toBe('/AI-agent')
    expect(sftpFromEither('/volume1', '/AI-agent')).toBe('/AI-agent')
    expect(execFromEither('/volume1', '/AI-agent')).toBe('/volume1/AI-agent')
    expect(execFromEither('/volume1', '/volume1/AI-agent')).toBe('/volume1/AI-agent')
    expect(execFromEither('', '/a')).toBe('/a')
  })

  it('rootListingConsistent：SFTP 根是 exec 前缀目录的子集', () => {
    expect(rootListingConsistent(['AI-agent', 'homes'], ['@appstore', 'AI-agent', 'homes'])).toBe(true)
    expect(rootListingConsistent(['bin', 'etc', 'usr'], ['home'])).toBe(false)
  })

  it('bindingPathView：只凭登记推算', () => {
    expect(bindingPathView({ remotePath: '/AI-agent/Home-NAS', execPath: '/volume1/AI-agent/Home-NAS' }).prefix).toBe('/volume1')
    expect(bindingPathView({ remotePath: '/srv/app' })).toBe(IDENTITY_VIEW)
  })
})

describe('PathViews：按主机检测并缓存', () => {
  const make = (opts: { sftpHome: string; execHome: string | null; sftpRoot?: string[]; execRoot?: string[] }) => {
    const calls: string[] = []
    let connection = {}
    const views = new PathViews({
      connection: async () => connection,
      sftpHome: async () => opts.sftpHome,
      sftpRootNames: async () => opts.sftpRoot ?? [],
      exec: async (_h, command) => {
        calls.push(command)
        if (command.startsWith('cd ~')) return opts.execHome === null ? { stdout: '', code: 127 } : { stdout: `${opts.execHome}\n`, code: 0 }
        if (command.startsWith('ls ')) return { stdout: (opts.execRoot ?? []).join('\n'), code: 0 }
        const m = /^cd -- '([^']*)'/.exec(command)
        return m !== null && m[1]?.startsWith('/volume1/') === true ? { stdout: `${m[1]}\n`, code: 0 } : { stdout: '', code: 1 }
      }
    })
    return { views, calls, reconnect: () => (connection = {}) }
  }

  it('DSM：推算出 /volume1；同一连接只检测一次，重连后重新检测', async () => {
    const s = make({ sftpHome: '/homes/ps', execHome: '/volume1/homes/ps', sftpRoot: ['AI-agent', 'homes'], execRoot: ['@appstore', 'AI-agent', 'homes'] })
    expect((await s.views.view('h')).prefix).toBe('/volume1')
    await s.views.view('h')
    expect(s.calls.filter((c) => c.startsWith('cd ~'))).toHaveLength(1)
    s.reconnect()
    await s.views.view('h')
    expect(s.calls.filter((c) => c.startsWith('cd ~'))).toHaveLength(2)
  })

  it('两视角一致 / 无法判定 / 根目录内容对不上 → 恒等映射（不改变旧行为）', async () => {
    expect((await make({ sftpHome: '/home/ps', execHome: '/home/ps' }).views.view('h')).prefix).toBe('')
    expect((await make({ sftpHome: '/home/ps', execHome: null }).views.view('h')).prefix).toBe('')
    expect((await make({ sftpHome: '/home/ps', execHome: '/srv/x' }).views.view('h')).prefix).toBe('')
    // /home → /data/home 这类巧合：后缀成立但根目录内容不同
    expect((await make({ sftpHome: '/home/ps', execHome: '/data/home/ps', sftpRoot: ['bin', 'etc'], execRoot: ['home'] }).views.view('h')).prefix).toBe('')
  })

  it('probeDir 与 execRoot', async () => {
    const s = make({ sftpHome: '/homes/ps', execHome: '/volume1/homes/ps', sftpRoot: [], execRoot: [] })
    expect(await s.views.probeDir('h', '/volume1/a')).toBe('/volume1/a')
    expect(await s.views.probeDir('h', '/a')).toBeUndefined()
    expect(await s.views.execRoot({ hostId: 'h', remotePath: '/a' })).toBe('/volume1/a')
    expect(await s.views.execRoot({ hostId: 'h', remotePath: '/a', execPath: '/x/a' })).toBe('/x/a')
  })
})

describe('创建校验与旧绑定补写', () => {
  /** 模拟 chroot：SFTP 根 = exec 的 /volume1。 */
  const sftp = new FakeSftp().dir('/AI-agent/Home-NAS').file('/AI-agent/readme.txt', 'x')
  const statSftp = async (p: string) =>
    await new Promise<{ type: string } | undefined>((resolve) =>
      sftp.stat(p, (err, attrs) => resolve(err ? undefined : { type: (attrs.mode & 0o170000) === 0o040000 ? 'dir' : 'file' }))
    )
  const probeExecDir = async (p: string) => (p.startsWith('/volume1/') && sftp.nodes.has(p.slice('/volume1'.length)) ? p : undefined)

  it('SFTP 视角输入：exec 根 = 前缀 + 路径', async () => {
    expect(await resolveWorkspaceRoots('/AI-agent/Home-NAS', { view: makePathView('/volume1'), statSftp, probeExecDir })).toEqual({
      sftpPath: '/AI-agent/Home-NAS',
      execPath: '/volume1/AI-agent/Home-NAS'
    })
  })

  it('SSH 视角输入（手动输入）：归一化回 SFTP 视角', async () => {
    expect(await resolveWorkspaceRoots('/volume1/AI-agent/Home-NAS', { view: makePathView('/volume1'), statSftp, probeExecDir })).toEqual({
      sftpPath: '/AI-agent/Home-NAS',
      execPath: '/volume1/AI-agent/Home-NAS'
    })
  })

  it('映射检测不到（前缀为空）时 exec 进不去 → 报错写明尝试过的路径', async () => {
    await expect(resolveWorkspaceRoots('/AI-agent/Home-NAS', { view: IDENTITY_VIEW, statSftp, probeExecDir })).rejects.toThrow(/已尝试：\/AI-agent\/Home-NAS/)
    await expect(resolveWorkspaceRoots('/nope', { view: IDENTITY_VIEW, statSftp, probeExecDir })).rejects.toThrow(/远程目录不存在/)
    await expect(resolveWorkspaceRoots('/AI-agent/readme.txt', { view: IDENTITY_VIEW, statSftp, probeExecDir })).rejects.toThrow(/不是目录/)
  })

  it('ensureExecRoot：旧绑定推算并补写；已登记只验证；前缀为空不写盘', async () => {
    const persisted: string[] = []
    const persist = (p: string) => persisted.push(p)
    expect(await ensureExecRoot({ remotePath: '/AI-agent/Home-NAS' }, { view: makePathView('/volume1'), probeExecDir, persist })).toEqual({
      execPath: '/volume1/AI-agent/Home-NAS',
      ok: true
    })
    expect(persisted).toEqual(['/volume1/AI-agent/Home-NAS'])
    await ensureExecRoot({ remotePath: '/AI-agent/Home-NAS', execPath: '/volume1/AI-agent/Home-NAS' }, { view: makePathView('/volume1'), probeExecDir, persist })
    expect(persisted).toHaveLength(1)
    expect(await ensureExecRoot({ remotePath: '/srv' }, { view: IDENTITY_VIEW, probeExecDir: async (p) => p, persist })).toEqual({ execPath: '/srv', ok: true })
    expect(persisted).toHaveLength(1)
    // 自检失败：不写盘，返回首个候选供提示
    expect(await ensureExecRoot({ remotePath: '/gone' }, { view: makePathView('/volume1'), probeExecDir, persist })).toEqual({ execPath: '/volume1/gone', ok: false })
    expect(persisted).toHaveLength(1)
  })
})

describe('BindingStore.setExecPath', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-pv-'))
    process.env.DSH_HOME = sandbox
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('旧绑定补写 execPath：映射表与 meta 都写，映射表丢失后从 meta 恢复仍带上', () => {
    const store = new BindingStore()
    const b = store.create({ hostId: 'h', endpoint: 'nas', remotePath: '/AI-agent/Home-NAS', title: 'nas' })
    expect(b.execPath).toBeUndefined()
    store.setExecPath(b.localPath, '/volume1/AI-agent/Home-NAS')
    expect(new BindingStore().resolve(b.localPath)?.execPath).toBe('/volume1/AI-agent/Home-NAS')
    const meta = JSON.parse(readFileSync(path.join(b.localPath, WORKSPACE_META_FILE), 'utf8')) as { execPath?: string }
    expect(meta.execPath).toBe('/volume1/AI-agent/Home-NAS')
    rmSync(bindingsFile()) // 删映射表：从占位目录的 meta 恢复，exec 根仍在
    expect(new BindingStore().resolve(b.localPath)?.execPath).toBe('/volume1/AI-agent/Home-NAS')
    // 与 remotePath 相同 → 不保留字段
    store.setExecPath(b.localPath, '/AI-agent/Home-NAS')
    expect(store.resolve(b.localPath)?.execPath).toBeUndefined()
  })
})

// ------------------------------------------------------------------ SSH 后端与侧栏 exec 命令的视角换算

/** 假连接：记录 exec 命令，按 respond 返回输出；sftp 子系统返回内存 SFTP。 */
function fakeConnection(sftp: FakeSftp, respond: (command: string) => string) {
  const commands: string[] = []
  const raw = {
    exec(command: string, _opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
      commands.push(command)
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close(): void }
      stream.stderr = new EventEmitter()
      stream.close = () => undefined
      cb(null, stream)
      setImmediate(() => {
        const out = respond(command)
        if (out !== '') stream.emit('data', Buffer.from(out))
        stream.emit('close', 0)
      })
    },
    sftp(cb: (err: Error | null, s: unknown) => void) {
      cb(
        null,
        Object.assign(sftp, {
          on: () => undefined,
          end: () => undefined,
          readdir: () => undefined,
          createReadStream: (p: string) => Readable.from([Buffer.from(sftp.text(sftp.resolve(p)) ?? '')])
        })
      )
    }
  }
  return { connection: { raw: () => raw }, commands }
}

function fakeRuntime(sftp: FakeSftp, prefix: string, respond: (command: string) => string = () => '') {
  const { connection, commands } = fakeConnection(sftp, respond)
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const rt = {
    log,
    pool: { acquire: async () => connection },
    resolveHost: () => ({}),
    paths: { view: async () => makePathView(prefix) }
  } as unknown as WorkspaceRuntime
  const files = new RemoteFs(rt)
  Object.assign(rt, { files })
  return { rt, files, commands }
}

describe('SshAgentBackend：exec 视角 ↔ SFTP 视角', () => {
  it('stat / read / write 把 exec 路径换成 SFTP 路径；SFTP 不可达的位置明确报错', async () => {
    const sftp = new FakeSftp().file('/AI-agent/Home-NAS/a.txt', 'hello')
    const { rt } = fakeRuntime(sftp, '/volume1')
    const backend = new SshAgentBackend(rt, 'h')
    expect((await backend.stat('/volume1/AI-agent/Home-NAS/a.txt'))?.type).toBe('file')
    expect((await backend.readBytes('/volume1/AI-agent/Home-NAS/a.txt', 1024)).toString()).toBe('hello')
    await backend.writeText('/volume1/AI-agent/Home-NAS/sub/b.txt', 'new')
    expect(sftp.text('/AI-agent/Home-NAS/sub/b.txt')).toBe('new')
    await expect(backend.stat('/etc/hosts')).rejects.toThrow(/not reachable through SFTP/)
  })

  it('upload：根换成 SFTP 视角写入，返回 / 回调里的路径是 exec 视角', async () => {
    const sftp = new FakeSftp().dir('/AI-agent/Home-NAS').file('/AI-agent/Home-NAS/old.txt', 'v0')
    const { rt } = fakeRuntime(sftp, '/volume1')
    const backend = new SshAgentBackend(rt, 'h')
    const seen: string[] = []
    const result = await backend.upload({
      root: '/volume1/AI-agent/Home-NAS',
      segments: ['old.txt'],
      source: Readable.from([Buffer.from('v1')]),
      bytes: 2,
      overwrite: true,
      beforeOverwrite: async (t) => void seen.push(t.path, t.realPath)
    })
    expect(sftp.text('/AI-agent/Home-NAS/old.txt')).toBe('v1')
    expect(result.path).toBe('/volume1/AI-agent/Home-NAS/old.txt')
    expect(result.realPath).toBe('/volume1/AI-agent/Home-NAS/old.txt')
    expect(seen).toEqual(['/volume1/AI-agent/Home-NAS/old.txt', '/volume1/AI-agent/Home-NAS/old.txt'])
  })
})

describe('侧栏 copy / search：exec 命令用 exec 视角，输出换回 SFTP 视角', () => {
  it('copy 的 cp 参数带前缀', async () => {
    const sftp = new FakeSftp().file('/AI-agent/a.txt', 'x').dir('/AI-agent/dst')
    const { files, commands } = fakeRuntime(sftp, '/volume1')
    expect(await files.copy('h', '/AI-agent/a.txt', '/AI-agent/dst')).toBe('/AI-agent/dst/a.txt')
    expect(commands.at(-1)).toBe("cp -RPp -- '/volume1/AI-agent/a.txt' '/volume1/AI-agent/dst/a.txt'")
  })

  it('search 的 find 根带前缀，结果去前缀', async () => {
    const sftp = new FakeSftp().dir('/AI-agent')
    const { files, commands } = fakeRuntime(sftp, '/volume1', (command) => {
      if (command.includes('-maxdepth 0')) return 'ok'
      return 'f /volume1/AI-agent/notes.md\nd /volume1/AI-agent/notes-dir\n'
    })
    const result = await files.search('h', '/AI-agent', 'notes')
    expect(commands.at(-1)).toContain("'find' '/volume1/AI-agent'")
    expect(result.root).toBe('/AI-agent')
    expect(result.matches).toEqual([
      { path: '/AI-agent/notes.md', type: 'file' },
      { path: '/AI-agent/notes-dir', type: 'dir' }
    ])
  })

  it('前缀为空：命令与旧版一致', async () => {
    const sftp = new FakeSftp().file('/srv/a.txt', 'x').dir('/srv/dst')
    const { files, commands } = fakeRuntime(sftp, '')
    await files.copy('h', '/srv/a.txt', '/srv/dst')
    expect(commands.at(-1)).toBe("cp -RPp -- '/srv/a.txt' '/srv/dst/a.txt'")
  })
})
