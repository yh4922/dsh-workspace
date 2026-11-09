/*
 * @Description: 远程工具逻辑测试（内存后端）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/remote-tools.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeBackend } from './fake-backend.js'
import { PreimageStore } from './preimages.js'
import {
  buildWindow,
  expandBraces,
  globToRegExp,
  remoteBash,
  remoteEdit,
  remoteGlob,
  remoteGrep,
  remoteRead,
  remoteWrite,
  renderBash,
  type RemoteToolEnv,
  type ToolExec
} from './remote-tools.js'
import { versionOf } from './backend.js'

let dir: string
let backend: FakeBackend
let observed: Array<{ key: string; kind: string; version?: string }>
let intents: Map<string, unknown>
let mode: string | undefined
let env: RemoteToolEnv

const binding = { localPath: path.join(tmpdir(), 'dshws-ph', 'app'), hostId: 'h1', remotePath: '/srv/app', title: 'app', createdAt: '' }
const exec: ToolExec = { agent: { session: { id: 's1', header: { cwd: binding.localPath } } }, signal: new AbortController().signal }

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dshws-tools-'))
  backend = new FakeBackend()
  backend.addDir('/srv/app')
  observed = []
  intents = new Map()
  mode = undefined
  env = {
    binding,
    backend,
    preimages: new PreimageStore(() => dir),
    caps: { limit: 2000, maxLineLength: 2000, maxBytes: 50 * 1024 },
    observe: (t, o) => observed.push({ key: t.targetKey, kind: o.kind, ...(o.kind === 'present' ? { version: o.version } : {}) }),
    intent: async (event, t) => {
      const v = intents.get(`${event}|${t.targetKey}`)
      if (v instanceof Error) throw v
      return v
    },
    sandboxMode: async () => mode
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fsError = (code: string): Error => Object.assign(new Error(code), { code })

describe('read', () => {
  it('行号窗口、相对路径解析、记录观察版本', async () => {
    backend.put('/srv/app/a.txt', 'one\ntwo\nthree\n')
    const v = await remoteRead(env, { file_path: 'a.txt', offset: 2, limit: 1 }, exec)
    expect(v).toEqual({ path: '/srv/app/a.txt', offset: 2, lines: [{ number: 2, text: 'two' }], totalLines: 3 })
    expect(observed).toEqual([{ key: 'ssh://h1/srv/app/a.txt', kind: 'present', version: versionOf((await backend.stat('/srv/app/a.txt'))!) }])
  })

  it('CRLF 去掉 \\r；超长行截断；字节上限截断', () => {
    const caps = { limit: 2000, maxLineLength: 5, maxBytes: 1000 }
    const w = buildWindow('abcdefgh\r\nx\r\nyyyy\r\nz\r\n', 1, 2000, caps, 'f')
    expect(w.lines[0]?.text).toBe('abcde... (line truncated to 5 chars)')
    expect(w.totalLines).toBe(4)
    expect(buildWindow('aaaa\nbbbb\ncccc\ndddd', 1, 2000, { limit: 2000, maxLineLength: 100, maxBytes: 12 }, 'f').lines).toHaveLength(2)
  })

  it('不存在：记录「不存在」观察并报与内置相同的错误', async () => {
    await expect(remoteRead(env, { file_path: '/srv/app/nope' }, exec)).rejects.toThrow('cannot read "/srv/app/nope": not found')
    expect(observed[0]?.kind).toBe('absent')
  })

  it('二进制、目录、越界 offset、非法 limit', async () => {
    backend.put('/srv/app/bin', Buffer.from([1, 0, 2]))
    await expect(remoteRead(env, { file_path: 'bin' }, exec)).rejects.toThrow('binary file')
    await expect(remoteRead(env, { file_path: '.' }, exec)).rejects.toThrow('not a regular file')
    backend.put('/srv/app/a', 'x\n')
    await expect(remoteRead(env, { file_path: 'a', offset: 9 }, exec)).rejects.toThrow('offset 9 is out of range')
    await expect(remoteRead(env, { file_path: 'a', limit: 3000 }, exec)).rejects.toThrow('limit must be less than or equal to 2000')
  })

  it('【安全】占位目录之外的本机路径被拒绝', async () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/'
    if (process.platform === 'win32') await expect(remoteRead(env, { file_path: outside }, exec)).rejects.toThrow(/本机路径/)
  })
})

describe('write', () => {
  it('新建文件：记录「原本不存在」的 pre-image，并观察新版本', async () => {
    const v = await remoteWrite(env, { file_path: 'src/new.ts', content: 'a\r\nb' }, exec)
    expect(v).toEqual({ path: '/srv/app/src/new.ts', operation: 'create', before: null, after: 'a\nb' })
    expect(backend.text('/srv/app/src/new.ts')).toBe('a\r\nb')
    expect(env.preimages.list('s1')[0]).toMatchObject({ path: '/srv/app/src/new.ts', absent: true })
    expect(observed.at(-1)?.kind).toBe('present')
  })

  it('【先读后写】策略要求「不存在才创建」但文件已存在 → 与内置相同的补救提示', async () => {
    backend.put('/srv/app/x', 'old')
    intents.set('fs/write-intent|ssh://h1/srv/app/x', { kind: 'createIfAbsent' })
    await expect(remoteWrite(env, { file_path: 'x', content: 'new' }, exec)).rejects.toThrow(
      'cannot modify "/srv/app/x": file has not been read — read the file, then retry'
    )
    expect(backend.text('/srv/app/x')).toBe('old')
  })

  it('【冲突】读过之后被外部修改 → 拒绝，远端内容不变', async () => {
    backend.put('/srv/app/x', 'old')
    const seen = versionOf((await backend.stat('/srv/app/x'))!)
    backend.put('/srv/app/x', 'changed by someone')
    intents.set('fs/write-intent|ssh://h1/srv/app/x', { kind: 'replaceIfVersion', version: seen })
    await expect(remoteWrite(env, { file_path: 'x', content: 'mine' }, exec)).rejects.toThrow(/file changed since it was read — re-read/)
    expect(backend.text('/srv/app/x')).toBe('changed by someone')
  })

  it('覆盖：before 为原内容；同一文件多次写，pre-image 只保留第一次之前的内容', async () => {
    backend.put('/srv/app/x', 'v0')
    await remoteWrite(env, { file_path: 'x', content: 'v1' }, exec)
    const v = await remoteWrite(env, { file_path: 'x', content: 'v2' }, exec)
    expect(v.before).toBe('v1')
    const entries = env.preimages.list('s1')
    expect(entries).toHaveLength(1)
    expect(env.preimages.read('s1', entries[0]!.sha256!)?.toString()).toBe('v0')
  })

  it('【沙箱】只读模式拒绝；workspace-write 拒绝工作区外；要求提权直接拒绝', async () => {
    mode = 'read-only'
    await expect(remoteWrite(env, { file_path: 'x', content: '' }, exec)).rejects.toThrow('read-only mode')
    mode = 'workspace-write'
    await expect(remoteWrite(env, { file_path: '/etc/passwd', content: '' }, exec)).rejects.toThrow('outside the remote workspace')
    await remoteWrite(env, { file_path: 'ok.txt', content: '' }, exec)
    mode = undefined
    await expect(remoteWrite(env, { file_path: 'y', content: '', sandbox_permissions: 'danger-full-access' }, exec)).rejects.toThrow(/escalation/)
  })
})

describe('edit', () => {
  it('唯一匹配替换；保留 CRLF；返回归一化的 before / after', async () => {
    backend.put('/srv/app/a.ts', 'let a = 1\r\nlet b = 2\r\n')
    const v = await remoteEdit(env, { file_path: 'a.ts', old_string: 'b = 2', new_string: 'b = 3' }, exec)
    expect(backend.text('/srv/app/a.ts')).toBe('let a = 1\r\nlet b = 3\r\n')
    expect(v).toEqual({ path: '/srv/app/a.ts', before: 'let a = 1\nlet b = 2\n', after: 'let a = 1\nlet b = 3\n' })
  })

  it('未找到 / 多处匹配 / replace_all / 参数校验', async () => {
    backend.put('/srv/app/a', 'x x x')
    await expect(remoteEdit(env, { file_path: 'a', old_string: 'y', new_string: 'z' }, exec)).rejects.toThrow('old_string was not found in "/srv/app/a"')
    await expect(remoteEdit(env, { file_path: 'a', old_string: 'x', new_string: 'z' }, exec)).rejects.toThrow('old_string matched 3 times')
    await remoteEdit(env, { file_path: 'a', old_string: 'x', new_string: 'z', replace_all: true }, exec)
    expect(backend.text('/srv/app/a')).toBe('z z z')
    await expect(remoteEdit(env, { file_path: 'a', old_string: '', new_string: 'q' }, exec)).rejects.toThrow('old_string must be a non-empty string')
    await expect(remoteEdit(env, { file_path: 'a', old_string: 'q', new_string: 'q' }, exec)).rejects.toThrow('must differ')
  })

  it('【先读后写】没读过就改 → 与内置相同的补救提示', async () => {
    backend.put('/srv/app/a', 'x')
    intents.set('fs/edit-intent|ssh://h1/srv/app/a', fsError('FS_NOT_OBSERVED'))
    await expect(remoteEdit(env, { file_path: 'a', old_string: 'x', new_string: 'y' }, exec)).rejects.toThrow(
      'cannot modify "/srv/app/a": file has not been read — read the file, then retry'
    )
  })
})

describe('glob', () => {
  it('无斜杠模式匹配任意层级的文件名；按修改时间新→旧；路径相对工作区根', async () => {
    backend.responder = (cmd) =>
      cmd.startsWith('find / -maxdepth 0')
        ? { stdout: 'ok' }
        : { stdout: '100.0\t/srv/app/a.ts\n300.5\t/srv/app/src/b.ts\n200\t/srv/app/src/c.js\n' }
    const v = await remoteGlob(env, { pattern: '*.ts' }, exec)
    expect(v).toEqual({ root: '.', paths: ['src/b.ts', 'a.ts'] })
    const anchored = await remoteGlob(env, { pattern: 'src/**/*.{ts,js}' }, exec)
    expect(anchored.paths).toEqual(['src/b.ts', 'src/c.js'])
  })

  it('globToRegExp / expandBraces', () => {
    expect(globToRegExp('**/*.test.ts').test('a/b/x.test.ts')).toBe(true)
    expect(globToRegExp('**/*.test.ts').test('x.test.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false)
    expect(globToRegExp('file[0-9].txt').test('file7.txt')).toBe(true)
    expect(expandBraces('*.{js,jsx}')).toEqual(['*.js', '*.jsx'])
  })
})

describe('grep', () => {
  it('解析 NUL 分隔的输出（文件名里有冒号也不错位）', async () => {
    backend.responder = (cmd) =>
      cmd.includes('command -v rg') ? { stdout: 'yes' } : { stdout: '/srv/app/a:b.ts\u00003:const x = 1\n/srv/app/c.ts\u000012:x\r\n', code: 0 }
    const v = await remoteGrep(env, { pattern: 'x', include: '*.ts' }, exec)
    expect(v.matches).toEqual([
      { path: 'a:b.ts', lineNumber: 3, line: 'const x = 1' },
      { path: 'c.ts', lineNumber: 12, line: 'x' }
    ])
    expect(backend.commands.at(-1)?.command).toContain("--glob '*.ts'")
  })

  it('没有 rg 时用 grep，并展开花括号 include', async () => {
    backend.responder = (cmd) => (cmd.includes('grep -P') ? { stdout: 'yes' } : { stdout: '', code: 1 })
    const v = await remoteGrep(env, { pattern: 'x', include: '*.{js,ts}' }, exec)
    expect(v.matches).toEqual([])
    expect(backend.commands.at(-1)?.command).toMatch(/grep -rnIZ -P .*--include='\*\.js' --include='\*\.ts'/)
  })
})

describe('bash', () => {
  it('默认在工作区根执行；workdir 相对根；结果形状与内置前台结果一致', async () => {
    backend.responder = () => ({ stdout: 'hi\n', stderr: 'warn\n', code: 3 })
    const v = await remoteBash(env, { command: 'echo hi', description: 'Say hi', workdir: 'src' }, exec)
    expect(backend.commands.at(-1)?.options.cwd).toBe('/srv/app/src')
    expect(v).toMatchObject({ kind: 'foreground', cwd: '/srv/app/src', exitCode: 3, timedOut: false, timeoutMs: 120000 })
    expect(renderBash(v)).toBe('hi\n[stderr]\nwarn\n[exit code: 3]')
  })

  it('无输出 / 超时标记', () => {
    const base = { kind: 'foreground' as const, signal: null, aborted: false, timeoutMs: 5, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    expect(renderBash({ ...base, exitCode: 0, timedOut: false })).toBe('(no output)')
    expect(renderBash({ ...base, exitCode: null, timedOut: true })).toBe('(no output)\n[timed out after 5ms]')
  })

  it('后台运行、只读模式、缺少 description 均拒绝', async () => {
    await expect(remoteBash(env, { command: 'x', description: 'd', run_in_background: true }, exec)).rejects.toThrow(/nohup/)
    await expect(remoteBash(env, { command: 'x', description: ' ' }, exec)).rejects.toThrow('invalid description')
    mode = 'read-only'
    await expect(remoteBash(env, { command: 'x', description: 'd' }, exec)).rejects.toThrow('read-only')
  })
})
