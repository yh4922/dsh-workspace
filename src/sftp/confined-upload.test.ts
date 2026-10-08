/*
 * @Description: 受限上传的安全测试（内存 SFTP：符号链接逃逸、O_EXCL、竞态、覆盖语义）
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/sftp/confined-upload.test.ts
 */
import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { protectedTargetReason } from '../agent/upload-path.js'
import { confinedUpload, isInside, type ConfinedUploadInput } from './confined-upload.js'
import { FakeSftp } from './fake-sftp.js'

const ROOT = '/srv/app'

function world(): FakeSftp {
  return new FakeSftp().dir(ROOT).dir('/home/dev').file('/etc/passwd', 'root:x:0:0').dir('/tmp/outside')
}

function upload(sftp: FakeSftp, rel: string, content = 'DATA', extra: Partial<ConfinedUploadInput> = {}) {
  return confinedUpload(sftp, {
    root: ROOT,
    segments: rel.split('/'),
    source: Readable.from([Buffer.from(content)]),
    bytes: Buffer.byteLength(content),
    overwrite: false,
    protect: protectedTargetReason,
    ...extra
  })
}

const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

/** 所有节点中没有残留的临时文件。 */
const noTemp = (s: FakeSftp): boolean => ![...s.nodes.keys()].some((k) => k.includes('.dshws-'))

describe('confinedUpload', () => {
  it('正常写入：自动建目录，权限 0644，返回按绑定根写法的路径', async () => {
    const s = world()
    const r = await upload(s, 'public/img/logo.png')
    expect(r).toEqual({ path: '/srv/app/public/img/logo.png', requestedPath: '/srv/app/public/img/logo.png', realPath: '/srv/app/public/img/logo.png', operation: 'create' })
    expect(s.text('/srv/app/public/img/logo.png')).toBe('DATA')
    const node = s.nodes.get('/srv/app/public/img/logo.png') as { mode: number }
    expect(node.mode).toBe(0o644)
    expect(noTemp(s)).toBe(true)
  })

  it('中间目录是指向工作区外的链接 → UPLOAD_OUTSIDE_WORKSPACE，外部不被写入', async () => {
    const s = world().link('/srv/app/out', '/tmp/outside')
    // 在走目录这一层就拦下（报链接本身的路径），不依赖后面的父目录复核兜底。
    await expect(upload(s, 'out/x.txt')).rejects.toMatchObject({ code: 'UPLOAD_OUTSIDE_WORKSPACE', message: expect.stringContaining('"/srv/app/out"') })
    expect(s.nodes.has('/tmp/outside/x.txt')).toBe(false)
  })

  it('相对链接 ../ 逃逸同样被拒', async () => {
    const s = world().link('/srv/app/up', '../../etc')
    expect(await code(upload(s, 'up/passwd'))).toBe('UPLOAD_OUTSIDE_WORKSPACE')
    expect(s.text('/etc/passwd')).toBe('root:x:0:0')
  })

  it('工作区内的目录链接允许，按真实路径写入', async () => {
    const s = world().dir('/srv/app/assets').link('/srv/app/a', 'assets')
    const r = await upload(s, 'a/x.txt')
    expect(r.realPath).toBe('/srv/app/assets/x.txt')
    expect(r.path).toBe('/srv/app/assets/x.txt')
    // 模型原来的写法也返回：上层据此把两种写法都登记为「已读过」。
    expect(r.requestedPath).toBe('/srv/app/a/x.txt')
  })

  it('目标本身是链接（即使指向工作区外的文件）→ UPLOAD_TARGET_SYMLINK，不跟随', async () => {
    const s = world().link('/srv/app/passwd', '/etc/passwd')
    expect(await code(upload(s, 'passwd', 'PWNED', { overwrite: true }))).toBe('UPLOAD_TARGET_SYMLINK')
    expect(s.text('/etc/passwd')).toBe('root:x:0:0')
  })

  it('目标是悬空链接 → 同样拒绝', async () => {
    const s = world().link('/srv/app/new.txt', '/tmp/outside/created-by-link')
    expect(await code(upload(s, 'new.txt'))).toBe('UPLOAD_TARGET_SYMLINK')
    expect(s.nodes.has('/tmp/outside/created-by-link')).toBe(false)
  })

  it('工作区根本身是链接：按真实路径校验，正常写入', async () => {
    const s = new FakeSftp().dir('/data/app').link('/srv/app', '/data/app').dir('/home/dev')
    const r = await upload(s, 'x.txt')
    expect(r.realPath).toBe('/data/app/x.txt')
    expect(r.path).toBe('/srv/app/x.txt')
  })

  it('已存在：未设 overwrite → UPLOAD_EXISTS；设了 → 原子覆盖（有无 posix-rename 都行）', async () => {
    for (const posixRename of [true, false]) {
      const s = world().file('/srv/app/a.txt', 'old', 0o755)
      s.supportsPosixRename = posixRename
      expect(await code(upload(s, 'a.txt'))).toBe('UPLOAD_EXISTS')
      expect(s.text('/srv/app/a.txt')).toBe('old')
      const before: string[] = []
      const r = await upload(s, 'a.txt', 'new', { overwrite: true, beforeOverwrite: async (t) => void before.push(`${t.path}|${t.realPath}`) })
      expect(r.operation).toBe('overwrite')
      expect(before).toEqual(['/srv/app/a.txt|/srv/app/a.txt'])
      expect(s.text('/srv/app/a.txt')).toBe('new')
      // 覆盖后不继承原可执行位。
      expect((s.nodes.get('/srv/app/a.txt') as { mode: number }).mode).toBe(0o644)
      expect(noTemp(s)).toBe(true)
    }
  })

  it('目标是目录 / 中间段是文件 → UPLOAD_BAD_TARGET', async () => {
    const s = world().dir('/srv/app/d').file('/srv/app/f', 'x')
    expect(await code(upload(s, 'd'))).toBe('UPLOAD_BAD_TARGET')
    expect(await code(upload(s, 'f/x.txt'))).toBe('UPLOAD_BAD_TARGET')
  })

  it('受保护目标按真实路径判断：link -> .git 绕不过', async () => {
    const s = world().dir('/srv/app/.git/hooks').link('/srv/app/g', '.git')
    expect(await code(upload(s, '.git/hooks/pre-commit'))).toBe('UPLOAD_PROTECTED_TARGET')
    expect(await code(upload(s, 'g/hooks/pre-commit'))).toBe('UPLOAD_PROTECTED_TARGET')
    expect(s.nodes.has('/srv/app/.git/hooks/pre-commit')).toBe(false)
  })

  it('家目录下紧接的点文件受保护：根是家目录本身，或它的上级（/home、/）', async () => {
    const s = new FakeSftp().dir('/home/dev')
    const r = (root: string, rel: string) =>
      confinedUpload(s, { root, segments: rel.split('/'), source: Readable.from([Buffer.from('x')]), bytes: 1, overwrite: true, protect: protectedTargetReason })
    expect(await code(r('/home/dev', '.bashrc'))).toBe('UPLOAD_PROTECTED_TARGET')
    expect(await code(r('/home/dev', '.config/autostart/x.desktop'))).toBe('UPLOAD_PROTECTED_TARGET')
    expect(await code(r('/home', 'dev/.bashrc'))).toBe('UPLOAD_PROTECTED_TARGET')
    expect(await code(r('/', 'home/dev/.config/autostart/x.desktop'))).toBe('UPLOAD_PROTECTED_TARGET')
    expect(await code(r('/home/dev', 'proj/.env.example'))).toBeUndefined()
    expect(s.nodes.has('/home/dev/.bashrc')).toBe(false)
  })

  it('posix-rename 真实失败（如权限）→ 直接报错，不退化成「删旧 + 改名」，原文件保留', async () => {
    const s = world().file('/srv/app/a.txt', 'old')
    s.posixRenameError = Object.assign(new Error('Permission denied'), { code: 3 })
    s.renameError = Object.assign(new Error('Permission denied'), { code: 3 })
    expect(await code(upload(s, 'a.txt', 'new', { overwrite: true }))).toBe(3)
    expect(s.text('/srv/app/a.txt')).toBe('old')
    expect(noTemp(s)).toBe(true)
  })

  it('服务端不支持 posix-rename（ssh2 同步抛出）→ 退化为删旧 + 改名', async () => {
    const s = world().file('/srv/app/a.txt', 'old')
    s.posixRenameThrowsUnsupported = true
    const r = await upload(s, 'a.txt', 'new', { overwrite: true })
    expect(r.operation).toBe('overwrite')
    expect(s.text('/srv/app/a.txt')).toBe('new')
  })

  it('目标名接近 255 字节：临时文件名截断，不超过文件名上限', async () => {
    const s = world()
    const created: string[] = []
    s.beforeCreate = (p) => void created.push(p)
    const name = `${'长'.repeat(80)}.png` // 244 字节
    await upload(s, name)
    const tmpName = (created[0] as string).split('/').pop() as string
    expect(Buffer.byteLength(tmpName)).toBeLessThanOrEqual(255)
    expect(s.nodes.has(`/srv/app/${name}`)).toBe(true)
  })

  it('竞态：改名前父目录被换成外链 → 拒绝并清理临时文件', async () => {
    const s = world().dir('/srv/app/sub')
    let swapped = false
    // 写完临时文件、改名之前动手脚（verify 钩子正好在这个时机）：整个 sub 换成外链。
    const p = upload(s, 'sub/x.txt', 'DATA', {
      verify: () => {
        for (const key of [...s.nodes.keys()]) if (key === '/srv/app/sub' || key.startsWith('/srv/app/sub/')) s.nodes.delete(key)
        s.link('/srv/app/sub', '/tmp/outside')
        swapped = true
      }
    })
    expect(await code(p)).toBe('UPLOAD_OUTSIDE_WORKSPACE')
    expect(swapped).toBe(true)
    expect(s.nodes.has('/tmp/outside/x.txt')).toBe(false)
  })

  it('竞态：改名前目标被换成链接 → UPLOAD_TARGET_SYMLINK', async () => {
    const s = world()
    const p = upload(s, 'x.txt', 'DATA', { verify: () => void s.link('/srv/app/x.txt', '/etc/passwd') })
    expect(await code(p)).toBe('UPLOAD_TARGET_SYMLINK')
    expect(s.text('/etc/passwd')).toBe('root:x:0:0')
    expect(noTemp(s)).toBe(true)
  })

  it('临时文件路径上被预置链接（O_EXCL）→ 创建失败，不跟随写到外部', async () => {
    const s = world()
    // 随机名无法预测，但攻击者可能恰好抢在打开前放好链接：用钩子在打开瞬间预置。
    s.beforeCreate = (p) => void s.link(p, '/etc/passwd')
    await expect(upload(s, 'x.txt', 'PWNED')).rejects.toThrow('exists')
    expect(s.text('/etc/passwd')).toBe('root:x:0:0')
    expect(s.nodes.has('/srv/app/x.txt')).toBe(false)
  })

  it('字节数不符 / verify 抛错 → 放弃写入且无残留', async () => {
    const s = world()
    expect(await code(upload(s, 'x.txt', 'DATA', { bytes: 99 }))).toBe('UPLOAD_SIZE_MISMATCH')
    const bad = upload(s, 'y.txt', 'DATA', {
      verify: () => {
        throw Object.assign(new Error('hash'), { code: 'UPLOAD_CORRUPT' })
      }
    })
    expect(await code(bad)).toBe('UPLOAD_CORRUPT')
    expect(s.nodes.has('/srv/app/x.txt') || s.nodes.has('/srv/app/y.txt')).toBe(false)
    expect(noTemp(s)).toBe(true)
  })

  it('中止：不产生目标文件，临时文件已清理', async () => {
    const s = world()
    const controller = new AbortController()
    const source = new Readable({ read() {} })
    const p = upload(s, 'big.bin', '', { source, bytes: 10, signal: controller.signal })
    source.push(Buffer.from('abc'))
    setTimeout(() => controller.abort(), 10)
    expect(await code(p)).toBe('ABORT_ERR')
    expect(s.nodes.has('/srv/app/big.bin')).toBe(false)
    expect(noTemp(s)).toBe(true)
  })

  it('工作区根不存在 → UPLOAD_ROOT_NOT_FOUND', async () => {
    const s = new FakeSftp()
    expect(await code(upload(s, 'x.txt'))).toBe('UPLOAD_ROOT_NOT_FOUND')
  })

  it('isInside 边界：前缀相同但不是子目录', () => {
    expect(isInside('/srv/app', '/srv/app')).toBe(true)
    expect(isInside('/srv/app', '/srv/app/x')).toBe(true)
    expect(isInside('/srv/app', '/srv/apple/x')).toBe(false)
    expect(isInside('/', '/anything')).toBe(true)
  })
})
