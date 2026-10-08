/*
 * @Description: 远程 present 的路径分类（三种宿主平台）与事件追加时序
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/present-tool.test.ts
 */
import { describe, expect, it } from 'vitest'
import { FakeBackend } from './fake-backend.js'
import { REMOTE_MARKER, classifyPresentPath, createRemotePresent } from './present-tool.js'

const winBinding = { localPath: 'C:\\ph\\app', hostId: 'h1', remotePath: '/srv/app', title: 'app', createdAt: '' }
const macBinding = { ...winBinding, localPath: '/Users/me/.dsh/workspaces/remote/h1/app' }

describe('classifyPresentPath', () => {
  it('Windows 宿主：盘符 / UNC 是本机；/ 开头与相对路径是远程（不做本机存在性判断）', async () => {
    const opts = { platform: 'win32' as const, localExists: () => true, remoteExists: async () => false }
    expect(await classifyPresentPath(winBinding, 'C:\\pic\\a.png', opts)).toEqual({ kind: 'local' })
    expect(await classifyPresentPath(winBinding, '\\\\srv\\share\\a.png', opts)).toEqual({ kind: 'local' })
    expect(await classifyPresentPath(winBinding, '/tmp/a.png', opts)).toEqual({ kind: 'remote', remotePath: '/tmp/a.png' })
    expect(await classifyPresentPath(winBinding, 'docs/a.md', opts)).toEqual({ kind: 'remote', remotePath: '/srv/app/docs/a.md' })
    expect(await classifyPresentPath(winBinding, 'C:\\ph\\app\\docs\\a.md', opts)).toEqual({ kind: 'remote', remotePath: '/srv/app/docs/a.md' })
  })

  it('macOS / Linux 宿主：远程根以外的 / 路径，本机存在且远端不存在 → 本机（交还宿主）', async () => {
    const local = new Set(['/Users/me/pic.png', '/tmp/both.txt', '/srv/app/x.png'])
    const remote = new Set(['/tmp/both.txt', '/srv/app/x.png'])
    const opts = { platform: 'darwin' as const, localExists: (p: string) => local.has(p), remoteExists: async (p: string) => remote.has(p) }
    expect(await classifyPresentPath(macBinding, '/Users/me/pic.png', opts)).toEqual({ kind: 'local' })
    // 两边都有：远程优先（远程会话里 / 路径默认指远端，与 read / write 一致）
    expect(await classifyPresentPath(macBinding, '/tmp/both.txt', opts)).toEqual({ kind: 'remote', remotePath: '/tmp/both.txt' })
    // 在远程根下：没有歧义，一律远程（不看本机）
    expect(await classifyPresentPath(macBinding, '/srv/app/x.png', opts)).toEqual({ kind: 'remote', remotePath: '/srv/app/x.png' })
    // 两边都没有：按远程处理（随后报 file not found，文案与宿主一致）
    expect(await classifyPresentPath(macBinding, '/nowhere/a.png', opts)).toEqual({ kind: 'remote', remotePath: '/nowhere/a.png' })
    // 占位目录下的路径：换算到远程根
    expect(await classifyPresentPath(macBinding, '/Users/me/.dsh/workspaces/remote/h1/app/a.md', opts)).toEqual({ kind: 'remote', remotePath: '/srv/app/a.md' })
  })
})

describe('createRemotePresent', () => {
  const setup = () => {
    const backend = new FakeBackend()
    backend.put('/srv/app/a.md', '# a')
    const appended: Array<{ type: string; data: unknown }> = []
    const session = { append: (type: string, data: unknown) => void appended.push({ type, data }) }
    const builtin: unknown[] = []
    const present = createRemotePresent({
      binding: macBinding,
      backend,
      projections: { stateOf: () => ({ openTurnStartSeq: 1, lastTurn: 2 }) },
      builtinExecute: async (args) => {
        builtin.push(args)
        return { turn: 2, files: [] }
      },
      classify: { platform: 'darwin', localExists: (p) => p === '/Users/me/pic.png' }
    })
    return { present, session, appended, builtin }
  }

  it('成功 → 追加事件，每个文件带远程标记；结果被判为错误（isError）或没有结果 → 不追加', async () => {
    const s = setup()
    const ok = { callId: 'c1', agent: { session: s.session } }
    expect(await s.present.execute({ files: [{ path: 'a.md' }] }, ok)).toEqual({ turn: 2, files: [{ path: '/srv/app/a.md' }] })
    s.present.onResult(ok, { isError: false })
    expect(s.appended).toEqual([{ type: 'deliverables/presented', data: { turn: 2, callId: 'c1', files: [{ path: '/srv/app/a.md', [REMOTE_MARKER]: 'h1' }] } }])

    const failed = { callId: 'c2', agent: { session: s.session } }
    await s.present.execute({ files: [{ path: 'a.md' }] }, failed)
    s.present.onResult(failed, { isError: true })
    const none = { callId: 'c3', agent: { session: s.session } }
    await s.present.execute({ files: [{ path: 'a.md' }] }, none)
    s.present.onResult(none, undefined)
    expect(s.appended).toHaveLength(1)
  })

  it('macOS 宿主上 present 本机文件（远程会话）→ 交还宿主原实现', async () => {
    const s = setup()
    await s.present.execute({ files: [{ path: '/Users/me/pic.png' }] }, { callId: 'c4', agent: { session: s.session } })
    expect(s.builtin).toEqual([{ files: [{ path: '/Users/me/pic.png' }] }])
  })
})
