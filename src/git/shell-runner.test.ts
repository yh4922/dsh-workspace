/*
 * @Description: 远程 git 执行器（argv 单引号转义拼 shell 命令）—— 用本机 sh 代替 SSH exec 跑一遍完整流程
 * @Author: YangHeng
 * @Date: 2026-09-30 17:00:00
 * @FilePath: /dsh-workspace/src/git/shell-runner.test.ts
 *
 * 真机集成测试（git.integration.test.ts）需要 SSH 主机；这里在本机验证「拼出来的命令」本身是对的：
 * 引号、中文路径、临时索引（GIT_INDEX_FILE）、标准输入等。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecResult } from '../sftp/exec.js'
import { GitRepo, shellGitRunner, type ShellExec } from './remote-git.js'

/** 找一个 POSIX sh：Windows 用 Git for Windows 自带的 sh.exe。 */
function findSh(): string | undefined {
  if (process.platform !== 'win32') return existsSync('/bin/sh') ? '/bin/sh' : undefined
  try {
    const git = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() ?? ''
    const sh = path.join(path.dirname(path.dirname(git)), 'bin', 'sh.exe')
    return existsSync(sh) ? sh : undefined
  } catch {
    return undefined
  }
}

const SH = findSh()

const localShell = (sh: string): ShellExec => (command, options) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(sh, ['-c', command], { windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('close', (code) => {
      const stdout = Buffer.concat(out)
      const truncated = stdout.length > options.maxBytes
      resolve({ stdout: stdout.subarray(0, options.maxBytes).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: truncated ? null : code, timedOut: false, truncated })
    })
    child.stdin.end(options.input ?? '')
  })

describe.skipIf(SH === undefined)('shellGitRunner（本机 sh 代替 SSH）', () => {
  it('中文与带引号的参数、暂存提交、临时索引编辑分支', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dshws-sh-'))).replace(/\\/g, '/')
    const g = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    writeFileSync(path.join(root, "it's 中文.txt"), 'x')
    const git = new GitRepo(shellGitRunner(localShell(SH as string), root), root)
    const status = await git.status()
    expect((status as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(["it's 中文.txt"])
    await git.stage(["it's 中文.txt"])
    await git.commit("say 'hi' $HOME `x`")
    expect((await git.log(0, 5))[0]?.subject).toBe("say 'hi' $HOME `x`")
    await git.createBranch('feat', 'refs/heads/main')
    await git.branchSave('refs/heads/feat', 'n.txt', 'hello\n')
    expect((await git.branchInfo('refs/heads/feat')).pending).toBe(1)
    await git.branchCommit('refs/heads/feat', 'add n')
    expect((await git.file('refs/heads/feat', 'n.txt')).text).toBe('hello\n')
    expect((await git.branchChanges('refs/heads/feat')).files).toEqual([])
  // Windows 下每次调用都要起 sh + git 子进程，整个用例约起几十个进程：单跑约 3.6s，
  // 全量并行时 CPU 争用会超过 vitest 默认 5s 而偶发失败（还会卡住发布脚本的测试关卡），故单独放宽上限。
  }, 30_000)
})
