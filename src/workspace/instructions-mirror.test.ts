/*
 * @Description: 远程项目指令镜像测试（issue #16）
 * @Author: YangHeng
 * @Date: 2026-11-23 16:05:00
 * @FilePath: /dsh-workspace/src/workspace/instructions-mirror.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeSftp } from '../sftp/fake-sftp.js'
import type { RemoteBinding } from './bindings.js'
import { InstructionsMirror, MIRROR_MANIFEST_FILE, layersOf, mountInstructionsMirror, readManifest, type MirrorSource } from './instructions-mirror.js'

/** FakeSftp → MirrorSource：FakeSftp 的 mtime 恒为 0，这里允许按路径覆盖以测试缓存。 */
function sourceOf(fake: FakeSftp): MirrorSource & { mtimes: Map<string, number>; reads: string[]; stats: number; delay: number } {
  const src = {
    mtimes: new Map<string, number>(),
    reads: [] as string[],
    stats: 0,
    delay: 0,
    async statPath(_hostId: string, file: string) {
      src.stats += 1
      if (src.delay > 0) await new Promise((r) => setTimeout(r, src.delay))
      return await new Promise<{ type: string; size: number; mtimeMs: number } | undefined>((resolve) => {
        fake.stat(file, (err, attrs) => {
          if (err) return resolve(undefined)
          const type = (attrs.mode & 0o170000) === 0o040000 ? 'dir' : 'file'
          resolve({ type, size: attrs.size, mtimeMs: src.mtimes.get(file) ?? 0 })
        })
      })
    },
    async readBytes(_hostId: string, file: string) {
      src.reads.push(file)
      return Buffer.from(fake.text(file) ?? '')
    }
  }
  return src
}

let sandbox: string
let binding: RemoteBinding
let fake: FakeSftp
let source: ReturnType<typeof sourceOf>
let clock: number
let mirror: InstructionsMirror

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-mirror-'))
  binding = { localPath: path.join(sandbox, 'ws'), hostId: 'h1', remotePath: '/srv/repo/app', title: 'app', createdAt: '' }
  mkdirSync(binding.localPath, { recursive: true })
  fake = new FakeSftp()
  source = sourceOf(fake)
  clock = 1000
  mirror = new InstructionsMirror({ source, now: () => clock, timeoutMs: 200 })
})
afterEach(() => {
  mirror.dispose()
  rmSync(sandbox, { recursive: true, force: true })
})

const local = (...parts: string[]): string => path.join(binding.localPath, ...parts)

describe('layersOf', () => {
  it('cwd 的子目录逐层展开，cwd 不在占位目录内时只返回根层', () => {
    expect(layersOf(binding, binding.localPath)).toEqual([''])
    expect(layersOf(binding, local('a', 'b'))).toEqual(['', 'a', 'a/b'])
    expect(layersOf(binding, path.join(sandbox, 'other'))).toEqual([''])
  })
})

describe('InstructionsMirror', () => {
  it('远端项目根在工作区根之上时，以工作区根作为标记点并镜像根层文件', async () => {
    fake.dir('/srv/repo/.git').file('/srv/repo/AGENTS.md', 'parent').file('/srv/repo/app/AGENTS.md', 'root rules').file('/srv/repo/app/CLAUDE.local.md', 'local')
    expect(await mirror.ensure(binding, binding.localPath)).toBe('refreshed')
    expect(readFileSync(local('AGENTS.md'), 'utf8')).toBe('root rules')
    expect(readFileSync(local('CLAUDE.local.md'), 'utf8')).toBe('local')
    expect(existsSync(local('.git'))).toBe(true)
    // 工作区根之上的文件不镜像（占位目录父层不可靠）
    expect(existsSync(path.join(sandbox, 'AGENTS.md'))).toBe(false)
    expect(readManifest(binding.localPath).markers).toEqual([''])
  })

  it('cwd 在子目录且远端 .git 位于中间层时，标记放在对应层，之上的层不镜像', async () => {
    mkdirSync(local('pkg', 'sub'), { recursive: true })
    fake.file('/srv/repo/app/AGENTS.md', 'ws').file('/srv/repo/app/pkg/.git', 'gitdir: x').file('/srv/repo/app/pkg/AGENTS.md', 'pkg').file('/srv/repo/app/pkg/sub/CLAUDE.md', 'sub')
    await mirror.ensure(binding, local('pkg', 'sub'))
    expect(existsSync(local('pkg', '.git'))).toBe(true)
    expect(existsSync(local('.git'))).toBe(false)
    expect(existsSync(local('AGENTS.md'))).toBe(false)
    expect(readFileSync(local('pkg', 'AGENTS.md'), 'utf8')).toBe('pkg')
    expect(readFileSync(local('pkg', 'sub', 'CLAUDE.md'), 'utf8')).toBe('sub')
  })

  it('已存在的本地 .git 不登记、不删除', async () => {
    mkdirSync(local('.git'))
    writeFileSync(local('.git', 'HEAD'), 'ref')
    await mirror.ensure(binding, binding.localPath)
    expect(readManifest(binding.localPath).markers).toEqual([])
    expect(existsSync(local('.git', 'HEAD'))).toBe(true)
  })

  it('远端更新后按 mtime + size 重新写入，未变时不读取', async () => {
    fake.file('/srv/repo/app/AGENTS.md', 'v1')
    source.mtimes.set('/srv/repo/app/AGENTS.md', 100)
    await mirror.ensure(binding, binding.localPath)
    expect(source.reads).toHaveLength(1)

    clock += 60_000
    await mirror.ensure(binding, binding.localPath)
    expect(source.reads).toHaveLength(1)

    fake.file('/srv/repo/app/AGENTS.md', 'v2!')
    source.mtimes.set('/srv/repo/app/AGENTS.md', 200)
    clock += 60_000
    await mirror.ensure(binding, binding.localPath)
    expect(source.reads).toHaveLength(2)
    expect(readFileSync(local('AGENTS.md'), 'utf8')).toBe('v2!')
  })

  it('节流期内不重复探测远端', async () => {
    fake.file('/srv/repo/app/AGENTS.md', 'v1')
    await mirror.ensure(binding, binding.localPath)
    const stats = source.stats
    expect(await mirror.ensure(binding, binding.localPath)).toBe('cached')
    expect(source.stats).toBe(stats)
  })

  it('远端删除后只删登记过的镜像，用户自己的文件与改过的镜像保留', async () => {
    fake.file('/srv/repo/app/AGENTS.md', 'a').file('/srv/repo/app/CLAUDE.md', 'c').file('/srv/repo/app/AGENTS.local.md', 'remote')
    writeFileSync(local('AGENTS.local.md'), 'mine')
    await mirror.ensure(binding, binding.localPath)
    // 用户自己的同名文件不被覆盖
    expect(readFileSync(local('AGENTS.local.md'), 'utf8')).toBe('mine')
    writeFileSync(local('CLAUDE.md'), 'edited by user')

    fake.nodes.delete('/srv/repo/app/AGENTS.md')
    fake.nodes.delete('/srv/repo/app/CLAUDE.md')
    fake.nodes.delete('/srv/repo/app/AGENTS.local.md')
    clock += 60_000
    await mirror.ensure(binding, binding.localPath)
    expect(existsSync(local('AGENTS.md'))).toBe(false)
    expect(readFileSync(local('CLAUDE.md'), 'utf8')).toBe('edited by user')
    expect(readFileSync(local('AGENTS.local.md'), 'utf8')).toBe('mine')
    expect(Object.keys(readManifest(binding.localPath).files)).toEqual([])
  })

  it('超过 1MB 的远端文件跳过，已有镜像被撤下', async () => {
    fake.file('/srv/repo/app/AGENTS.md', 'small')
    await mirror.ensure(binding, binding.localPath)
    expect(existsSync(local('AGENTS.md'))).toBe(true)
    fake.file('/srv/repo/app/AGENTS.md', Buffer.alloc(1024 * 1024 + 1, 97))
    clock += 60_000
    await mirror.ensure(binding, binding.localPath)
    expect(existsSync(local('AGENTS.md'))).toBe(false)
    expect(source.reads).toHaveLength(1)
  })

  it('超时只跳过本次，后台完成后下次命中', async () => {
    fake.file('/srv/repo/app/AGENTS.md', 'slow')
    source.delay = 100
    const quick = new InstructionsMirror({ source, now: () => clock, timeoutMs: 30 })
    expect(await quick.ensure(binding, binding.localPath)).toBe('timeout')
    expect(existsSync(local('AGENTS.md'))).toBe(false)
    await new Promise((r) => setTimeout(r, 1000))
    expect(readFileSync(local('AGENTS.md'), 'utf8')).toBe('slow')
    expect(await quick.ensure(binding, binding.localPath)).toBe('cached')
  })

  it('远端出错只记日志、不抛', async () => {
    const logs: string[] = []
    const broken = new InstructionsMirror({
      source: { statPath: async () => Promise.reject(new Error('boom')), readBytes: async () => Buffer.alloc(0) },
      log: (_h, m) => logs.push(m)
    })
    expect(await broken.ensure(binding, binding.localPath)).toBe('error')
    expect(logs.join('\n')).toContain('boom')
    expect(existsSync(local(MIRROR_MANIFEST_FILE))).toBe(false)
  })
})

describe('mountInstructionsMirror', () => {
  it('pre-step 在调用 next 之前完成镜像，本地会话直接放行', async () => {
    fake.file('/srv/repo/app/AGENTS.md', 'hooked')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = { on: (e: string, fn: (...args: unknown[]) => unknown) => (handlers.set(e, fn), () => handlers.delete(e)) }
    const off = mountInstructionsMirror(ctx, { mirror, resolveBinding: (cwd) => (cwd === binding.localPath ? binding : undefined) })
    const step = handlers.get('agent/pre-step') as (p: unknown, next: () => Promise<unknown>) => Promise<unknown>
    let seen: boolean | undefined
    const result = await step({ agent: { session: { header: { cwd: binding.localPath } } } }, async () => {
      seen = existsSync(local('AGENTS.md'))
      return 'decision'
    })
    expect(result).toBe('decision')
    expect(seen).toBe(true)
    expect(await step({ agent: { session: { header: { cwd: 'C:\\local' } } } }, async () => 'local')).toBe('local')
    off()
    expect(handlers.size).toBe(0)
  })
})
