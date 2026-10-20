/*
 * @Description: 在工作区里执行 git，供右侧栏「Git 仓库」面板使用（远程经 SSH，本地直接起进程）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/git/remote-git.ts
 *
 * 仓库逻辑（GitRepo）与「怎么执行 git」（GitRunner）分开：
 * - 远程：argv 逐个单引号转义后拼成 `cd <root> && git ...`，经 SSH exec 执行（RemoteGit）
 * - 本地：child_process 直接以 argv 启动 git，不经过 shell（local/local-git.ts）
 *
 * 安全边界：
 * - 只在「已登记的工作区根目录」里执行（由网关校验：远程 = 该主机的绑定，本地 = 会话 cwd）
 * - 文件路径必须是仓库内相对路径（不许绝对路径、不许 ..），一律放在 -- 之后，不会被当成选项
 * - 查看分支只接受完整引用名（refs/heads|remotes|tags/…），先 rev-parse 成提交号再使用
 * - 不做检出：查看其他分支全程只读对象库，不改 HEAD、暂存区与工作区
 * - core.fsmonitor=false：恶意仓库的 .git/config 可借 fsmonitor 在 status 时执行任意命令
 */
import { createHash } from 'node:crypto'
import { sq } from '../agent/backend.js'
import type { WorkspaceRuntime } from '../runtime.js'
import { execCapture, type ExecOptions, type ExecResult } from '../sftp/exec.js'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStatusV2,
  parseLsTree,
  parseWorktrees,
  isViewableRef,
  type GitWorktree,
  type GitTreeEntry,
  type GitBranch,
  type GitChangedFile,
  type GitCommit,
  type GitStatus
} from './parse.js'

export type { GitBranch, GitChangedFile, GitCommit, GitStatus, GitTreeEntry }

/** diff 两侧内容的单边上限：超过就只提示「文件过大」，不把几十 MB 塞进浏览器。 */
export const DIFF_SIDE_MAX = 2 * 1024 * 1024

export interface DiffSides {
  original: string
  modified: string
  binary: boolean
  tooLarge: boolean
}

export interface RunOpts {
  timeoutMs?: number
  maxBytes?: number
  /** 改用该临时索引文件（GIT_INDEX_FILE）。 */
  index?: string
  input?: string
}

/** 每条 git 命令都带的全局参数。 */
export const GIT_GLOBAL_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false']

/**
 * 执行 git 与读写仓库内少量辅助文件（临时索引记录）的方式。
 * 路径参数都是仓库所在机器上的绝对路径（本地为 git 输出的正斜杠形式，如 C:/x/.git）。
 */
export interface GitRunner {
  /** 在工作目录执行 git（argv 不含 git 本身与全局参数）；非零退出码不抛错。 */
  git(argv: string[], options: RunOpts): Promise<ExecResult>
  /** 读工作目录里的文件（仓库内相对路径），最多 maxBytes 字节。 */
  catRelative(rel: string, maxBytes: number): Promise<{ stdout: string; code: number | null; truncated: boolean }>
  /** 读文本文件；不存在返回 undefined。 */
  readText(abs: string): Promise<string | undefined>
  exists(abs: string): Promise<boolean>
  writeText(abs: string, text: string): Promise<void>
  mkdirp(abs: string): Promise<void>
  rm(abs: readonly string[]): Promise<void>
  /** 路径比较键：本地 Windows 不区分大小写、统一正斜杠；远程原样。 */
  pathKey(p: string): string
  /** 没装 git 时的提示。 */
  readonly noGitMessage: string
}

/**
 * 查看分支时的编辑方式（每次写操作前都会重新判断，对用户无感）：
 * - worktree：就是工作目录当前检出的分支 —— 直接读写文件，改动 / 提交走普通 git status / commit
 * - index：其他本地分支 —— 改动存在本插件的临时索引里，提交用 commit-tree + update-ref，不碰工作目录
 * - worktree 也包括「在另一个 git worktree 里检出的分支」：直接在那个目录里改、提交
 * - readonly：远程分支 / 标签（需先建本地分支），或检出所在目录已被删除的分支
 */
export interface BranchInfo {
  mode: 'worktree' | 'index' | 'readonly'
  /** worktree 模式：直接读写、提交所在的目录（当前分支 = 工作区根；另一个 git worktree = 那个目录）。 */
  worktreePath?: string
  reason?: 'remote' | 'tag' | 'otherWorktree'
  /** 分支当前指向的提交。 */
  tip: string
  /** 未提交改动数（index 模式）。 */
  pending: number
}

export type DiffTarget =
  | { kind: 'worktree'; path: string; untracked?: boolean }
  | { kind: 'head'; path: string }
  | { kind: 'staged'; path: string }
  | { kind: 'branch'; ref: string; path: string; origPath?: string }
  | { kind: 'commit'; hash: string; parent: string | null; path: string; origPath?: string }

export class GitError extends Error {}

/** 仓库内相对路径校验。 */
export function checkRepoPath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new GitError(`非法路径：${p}`)
  }
  return normalized
}

export function checkHash(h: string): string {
  if (!/^[0-9a-f]{7,64}$/.test(h)) throw new GitError(`非法提交号：${h}`)
  return h
}

const EMPTY_SIDE = { text: '', binary: false, tooLarge: false }

export class GitRepo {
  constructor(
    protected readonly runner: GitRunner,
    /** 工作目录（git 所在机器上的路径）。 */
    protected readonly root: string
  ) {}

  private run(argv: string[], options: RunOpts = {}): Promise<ExecResult> {
    return this.runner.git(argv, options)
  }

  private async runOk(argv: string[], options?: RunOpts): Promise<string> {
    const r = await this.run(argv, options)
    if (r.timedOut) throw new GitError(`git 命令超时：git ${argv.join(' ').slice(0, 80)}`)
    if (r.code !== 0) throw new GitError((r.stderr.trim() || r.stdout.trim() || `git 退出码 ${String(r.code)}`).slice(0, 2000))
    return r.stdout
  }

  async status(): Promise<GitStatus | { isRepo: false; reason: string }> {
    const r = await this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    if (r.code !== 0) {
      const reason = r.stderr.trim()
      if (/not a git repository/i.test(reason)) return { isRepo: false, reason: '该目录不是 Git 仓库。' }
      if (/command not found|not found|ENOENT/i.test(reason)) return { isRepo: false, reason: this.runner.noGitMessage }
      throw new GitError(reason || `git status 失败（退出码 ${String(r.code)}）`)
    }
    return { isRepo: true, ...parseStatusV2(r.stdout) }
  }

  /**
   * 当前分支名（作用域记忆的分支过滤用）。比 status 轻得多：不扫工作区。
   * @returns 分离 HEAD、不是仓库、没装 git 时返回 undefined
   */
  async currentBranch(): Promise<string | undefined> {
    const r = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (r.timedOut || r.code !== 0) return undefined
    const name = r.stdout.trim()
    return name === '' || name === 'HEAD' ? undefined : name
  }

  /** 提交历史：不传引用为全部分支；传引用则只看该分支（查看其他分支时用）。 */
  async log(skip: number, limit: number, ref?: string): Promise<GitCommit[]> {
    const scope = ref === undefined ? '--all' : await this.resolve(ref)
    // --decorate=full：装饰给出完整引用名（refs/remotes/…、tag: refs/tags/…），界面据此准确区分远程 / 本地 / 标签。
    const r = await this.run([
      'log',
      scope,
      '--decorate=full',
      '--topo-order',
      // -z：记录之间用 NUL 分隔（提交说明里可能含任意字符，见 LOG_FORMAT 的说明）。
      '-z',
      `--skip=${Math.max(0, skip | 0)}`,
      '-n',
      String(Math.min(1000, Math.max(1, limit | 0))),
      `--format=${LOG_FORMAT}`
    ])
    // 空仓库（还没有提交）时 log 报错：视为没有历史。
    if (r.code !== 0) {
      if (/does not have any commits|bad default revision|unknown revision/i.test(r.stderr)) return []
      throw new GitError(r.stderr.trim() || 'git log 失败')
    }
    return parseLog(r.stdout)
  }

  async branches(): Promise<GitBranch[]> {
    return parseBranches(await this.runOk(['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']))
  }

  /** 某个提交改了哪些文件（合并提交相对第一个父提交）。 */
  async show(hash: string, parent: string | null): Promise<GitChangedFile[]> {
    const h = checkHash(hash)
    const out =
      parent === null
        ? await this.runOk(['diff-tree', '--no-commit-id', '--root', '-r', '-z', '-M', '--name-status', h])
        : await this.runOk(['diff', '-z', '-M', '--name-status', checkHash(parent), h])
    return parseNameStatus(out)
  }

  /** 取某个版本的文件内容；不存在返回 ''。index 给出时 `:路径` 读该临时索引里的版本。 */
  private async blob(spec: string, index?: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
    const r = await this.run(['show', spec], { maxBytes: DIFF_SIDE_MAX + 1, ...(index !== undefined ? { index } : {}) })
    if (r.code !== 0 && !r.truncated) return EMPTY_SIDE
    return sideOf(r.stdout, r.truncated)
  }

  private async worktreeFile(path: string): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
    const r = await this.runner.catRelative(path, DIFF_SIDE_MAX + 1)
    if (r.code !== 0 && !r.truncated) return EMPTY_SIDE
    return sideOf(r.stdout, r.truncated)
  }

  async diff(target: DiffTarget): Promise<DiffSides> {
    const path = checkRepoPath(target.path)
    let a: { text: string; binary: boolean; tooLarge: boolean }
    let b: { text: string; binary: boolean; tooLarge: boolean }
    if (target.kind === 'worktree') {
      // 未暂存改动：暂存区（没有则 HEAD / 空）→ 工作区。
      a = target.untracked === true ? EMPTY_SIDE : await this.blob(`:${path}`)
      b = await this.worktreeFile(path)
    } else if (target.kind === 'head') {
      // 「AI 改动」：最近提交 → 工作区（暂存与否都算），文件不在 HEAD 里则左侧为空、已删除则右侧为空。
      a = await this.blob(`HEAD:${path}`)
      b = await this.worktreeFile(path)
    } else if (target.kind === 'staged') {
      a = await this.blob(`HEAD:${path}`)
      b = await this.blob(`:${path}`)
    } else if (target.kind === 'branch') {
      // 分支上未提交的改动：基准提交 → 临时索引。
      const { index, base } = await this.pendingState(target.ref)
      const orig = target.origPath === undefined ? path : checkRepoPath(target.origPath)
      a = base === null ? EMPTY_SIDE : await this.blob(`${base}:${orig}`)
      b = index === null ? a : await this.blob(`:${path}`, index)
    } else {
      const hash = checkHash(target.hash)
      const orig = target.origPath === undefined ? path : checkRepoPath(target.origPath)
      a = target.parent === null ? EMPTY_SIDE : await this.blob(`${checkHash(target.parent)}:${orig}`)
      b = await this.blob(`${hash}:${path}`)
    }
    return { original: a.text, modified: b.text, binary: a.binary || b.binary, tooLarge: a.tooLarge || b.tooLarge }
  }

  private pathArgs(paths: readonly string[]): string[] {
    if (paths.length === 0) throw new GitError('没有选择文件')
    return paths.map((p) => checkRepoPath(p))
  }

  async stage(paths: readonly string[]): Promise<void> {
    await this.runOk(['add', '-A', '--', ...this.pathArgs(paths)])
  }

  async unstage(paths: readonly string[]): Promise<void> {
    const hasHead = (await this.run(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
    // 还没有任何提交时没有 HEAD 可以 reset，只能从暂存区移除。
    await this.runOk(hasHead ? ['reset', '-q', '--', ...this.pathArgs(paths)] : ['rm', '--cached', '-r', '-q', '--', ...this.pathArgs(paths)])
  }

  /** 丢弃工作区改动：已跟踪文件恢复为暂存区版本；未跟踪文件删除。 */
  async discard(tracked: readonly string[], untracked: readonly string[]): Promise<void> {
    if (tracked.length > 0) await this.runOk(['checkout', '--', ...this.pathArgs(tracked)])
    if (untracked.length > 0) await this.runOk(['clean', '-f', '-q', '--', ...this.pathArgs(untracked)])
  }

  async commit(message: string): Promise<string> {
    const text = message.trim()
    if (text === '') throw new GitError('提交说明不能为空')
    await this.runOk(['commit', '-q', '-m', text])
    return (await this.runOk(['rev-parse', '--short', 'HEAD'])).trim()
  }

  // ---------------------------------------------------------------- 只读查看其他分支（不检出）

  /** 引用 → 提交号。只接受可查看的引用；不存在时报错。 */
  async resolve(ref: string): Promise<string> {
    if (!isViewableRef(ref)) throw new GitError(`非法引用：${ref}`)
    const r = await this.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`])
    const hash = r.stdout.trim()
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(hash)) throw new GitError(`找不到分支或提交：${ref}`)
    return hash
  }

  /**
   * 某个引用下某个目录的内容：ls-tree 直接读对象库，不碰工作区。
   * 该分支有未提交改动时，读临时索引生成的目录快照（write-tree 只写对象库），新增 / 删除的文件也能反映出来。
   */
  async tree(ref: string, dir: string): Promise<{ hash: string; entries: GitTreeEntry[] }> {
    const hash = await this.resolve(ref)
    const { index } = await this.pendingState(ref)
    const treeish = index === null ? hash : (await this.runOk(['write-tree'], { index })).trim()
    const d = dir === '' ? '' : checkRepoPath(dir).replace(/\/+$/, '')
    const out = await this.runOk(['ls-tree', '-z', '-l', d === '' ? treeish : `${treeish}:${d}`])
    return { hash, entries: parseLsTree(out, d) }
  }

  /** 某个引用下某个文件的内容（有未提交改动时读临时索引里的版本），不碰工作区。 */
  async file(ref: string, path: string): Promise<{ hash: string; text: string; binary: boolean; tooLarge: boolean }> {
    const hash = await this.resolve(ref)
    const p = checkRepoPath(path)
    const { index } = await this.pendingState(ref)
    const side = index === null ? await this.blob(`${hash}:${p}`) : await this.blob(`:${p}`, index)
    return { hash, ...side }
  }

  // ---------------------------------------------------------------- 编辑非检出分支（临时索引）

  private gitDirCache: string | undefined

  private async gitDir(): Promise<string> {
    if (this.gitDirCache === undefined) this.gitDirCache = (await this.runOk(['rev-parse', '--absolute-git-dir'])).trim()
    return this.gitDirCache
  }

  /** 某分支的临时索引与「基准提交」记录文件（放在 .git 里，不占工作目录、不进版本库）。 */
  private async indexFiles(ref: string): Promise<{ dir: string; index: string; baseFile: string }> {
    const dir = `${await this.gitDir()}/dsh-workspace`
    const key = createHash('sha1').update(ref).digest('hex').slice(0, 16)
    return { dir, index: `${dir}/idx-${key}`, baseFile: `${dir}/idx-${key}.base` }
  }

  /** 临时索引现状：不存在时 index / base 为 null。 */
  private async pendingState(ref: string): Promise<{ index: string | null; base: string | null }> {
    if (!isViewableRef(ref) || !ref.startsWith('refs/heads/')) return { index: null, base: null }
    const f = await this.indexFiles(ref)
    if (!(await this.runner.exists(f.index))) return { index: null, base: null }
    const base = (await this.runner.readText(f.baseFile))?.trim() ?? ''
    if (!/^[0-9a-f]{40,64}$/.test(base)) return { index: null, base: null }
    return { index: f.index, base }
  }

  /** 判断该分支的编辑方式（见 BranchInfo）。每次写操作前都会调用。 */
  async branchInfo(ref: string): Promise<BranchInfo> {
    const tip = await this.resolve(ref)
    if (ref.startsWith('refs/remotes/')) return { mode: 'readonly', reason: 'remote', tip, pending: 0 }
    if (ref.startsWith('refs/tags/') || ref === 'HEAD') return { mode: 'readonly', reason: 'tag', tip, pending: 0 }
    const head = (await this.run(['symbolic-ref', '-q', 'HEAD'])).stdout.trim()
    if (head === ref) return { mode: 'worktree', worktreePath: this.root, tip, pending: 0 }
    // 在另一个 git worktree 里检出的分支：不能走临时索引（改引用会让那个目录与提交对不上），
    // 而是直接在那个目录里改文件、提交 —— 与当前分支同一种方式，用户无感。
    const other = (await this.worktrees()).find((w) => w.branch === ref)
    if (other !== undefined) {
      if (other.prunable) return { mode: 'readonly', reason: 'otherWorktree', tip, pending: 0 }
      return { mode: 'worktree', worktreePath: await this.mapToWorktree(other.path), tip, pending: 0 }
    }
    return { mode: 'index', tip, pending: (await this.branchChanges(ref)).files.length }
  }

  /** 本仓库的全部 git 工作目录（第一个是主工作目录）。 */
  async worktrees(): Promise<GitWorktree[]> {
    const r = await this.run(['worktree', 'list', '--porcelain'])
    return r.code === 0 ? parseWorktrees(r.stdout) : []
  }

  /**
   * 工作区根目录可能是仓库的子目录：换到另一个工作目录时保持同样的子目录
   * （/repo/sub → /wt/feature/sub），文件树与本分支看到的范围一致。
   */
  private async mapToWorktree(worktreeTop: string): Promise<string> {
    const top = (await this.runOk(['rev-parse', '--show-toplevel'])).trim().replace(/[\\/]+$/, '')
    const root = this.root.replace(/[\\/]+$/, '')
    const k = (p: string): string => this.runner.pathKey(p)
    const rel = k(root) === k(top) ? '' : k(root).startsWith(`${k(top)}/`) ? root.slice(top.length).replace(/\\/g, '/') : ''
    return `${worktreeTop.replace(/[\\/]+$/, '')}${rel}`
  }

  /** 某路径是不是本仓库某个工作目录（含映射后的子目录）：网关据此允许在该目录执行 git。 */
  async isOwnWorktree(path: string): Promise<boolean> {
    const k = (p: string): string => this.runner.pathKey(p.replace(/[\\/]+$/, ''))
    if (k(path) === k(this.root)) return true
    return (await this.worktreeRoots()).some((w) => k(w) === k(path))
  }

  /** 本仓库各工作目录（映射到与工作区根相同的子目录；不含已删除的）。不是 git 仓库时为空。 */
  async worktreeRoots(): Promise<string[]> {
    const roots: string[] = []
    for (const w of await this.worktrees()) if (!w.prunable) roots.push(await this.mapToWorktree(w.path))
    return roots
  }

  private async requireIndexMode(ref: string): Promise<BranchInfo> {
    const info = await this.branchInfo(ref)
    if (info.mode === 'worktree') throw new GitError('该分支已是工作目录当前检出的分支，请刷新后在改动页操作。')
    if (info.mode === 'readonly') throw new GitError(info.reason === 'otherWorktree' ? '该分支检出所在的工作目录已不存在（可在终端执行 git worktree prune）。' : '远程分支与标签不能直接修改，请先基于它新建本地分支。')
    return info
  }

  /**
   * 确保临时索引存在并基于分支最新提交。
   * 已有索引但没有未提交改动、而分支在此期间前进了：跟着前进（否则之后的改动会基于旧版本）。
   */
  private async ensureIndex(ref: string, tip: string): Promise<string> {
    const f = await this.indexFiles(ref)
    const state = await this.pendingState(ref)
    if (state.index !== null && state.base === tip) return state.index
    if (state.index !== null && state.base !== null) {
      const pending = parseNameStatus(await this.runOk(['diff-index', '--cached', '-z', '-M', '--name-status', state.base], { index: state.index }))
      if (pending.length > 0) return state.index
    }
    await this.runner.mkdirp(f.dir)
    await this.runOk(['read-tree', tip], { index: f.index })
    try {
      await this.runner.writeText(f.baseFile, tip)
    } catch (error) {
      throw new GitError(`无法写入临时索引：${error instanceof Error ? error.message : String(error)}`)
    }
    return f.index
  }

  /** 分支上未提交的改动（临时索引相对基准提交）。 */
  async branchChanges(ref: string): Promise<{ base: string | null; files: GitChangedFile[] }> {
    const { index, base } = await this.pendingState(ref)
    if (index === null || base === null) return { base: null, files: [] }
    return { base, files: parseNameStatus(await this.runOk(['diff-index', '--cached', '-z', '-M', '--name-status', base], { index })) }
  }

  /** 保存一个文件到分支（写入临时索引，尚未提交）。 */
  async branchSave(ref: string, path: string, content: string): Promise<void> {
    const p = checkRepoPath(path)
    const info = await this.requireIndexMode(ref)
    const index = await this.ensureIndex(ref, info.tip)
    const blob = (await this.runOk(['hash-object', '-w', '--stdin'], { input: content })).trim()
    if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new GitError('写入文件内容失败')
    // 保留原文件的权限位（如可执行脚本 100755）；新文件用 100644。
    const existing = (await this.runOk(['ls-files', '-s', '-z', '--', p], { index })).split(/\s/)[0]
    const mode = existing !== undefined && /^1[0-7]{5}$/.test(existing) ? existing : '100644'
    await this.runOk(['update-index', '--add', '--cacheinfo', mode, blob, p], { index })
  }

  /** 撤销分支上某些文件的未提交改动（临时索引里恢复为基准版本）。 */
  async branchRevert(ref: string, paths: readonly string[]): Promise<void> {
    await this.requireIndexMode(ref)
    const { index, base } = await this.pendingState(ref)
    if (index === null || base === null) return
    await this.runOk(['reset', '-q', base, '--', ...this.pathArgs(paths)], { index })
  }

  /** 丢弃分支上全部未提交改动。 */
  async branchDiscard(ref: string): Promise<void> {
    if (!isViewableRef(ref) || !ref.startsWith('refs/heads/')) throw new GitError(`非法引用：${ref}`)
    const f = await this.indexFiles(ref)
    await this.runner.rm([f.index, f.baseFile, `${f.index}.replay`])
  }

  /**
   * 提交分支上的改动：write-tree → commit-tree（父提交 = 分支最新提交）→ update-ref（带旧值，防并发覆盖）。
   * 若编辑期间分支已被别人前进：把改过的文件重放到新提交上；同一文件两边都改过则拒绝（不做自动合并）。
   */
  async branchCommit(ref: string, message: string): Promise<string> {
    const text = message.trim()
    if (text === '') throw new GitError('提交说明不能为空')
    const info = await this.requireIndexMode(ref)
    const { index, base } = await this.pendingState(ref)
    if (index === null || base === null) throw new GitError('该分支没有未提交的改动')
    const changes = parseNameStatus(await this.runOk(['diff-index', '--cached', '-z', '-M', '--name-status', base], { index }))
    if (changes.length === 0) throw new GitError('该分支没有未提交的改动')

    let tree: string
    if (base === info.tip) {
      tree = (await this.runOk(['write-tree'], { index })).trim()
    } else {
      const touched = new Set(changes.flatMap((c) => (c.origPath === undefined ? [c.path] : [c.path, c.origPath])))
      const upstream = (await this.runOk(['diff', '--name-only', '-z', base, info.tip])).split('\0').filter(Boolean)
      const clash = upstream.filter((p) => touched.has(p))
      if (clash.length > 0) {
        throw new GitError(`编辑期间该分支已有新提交，且同样改动了：${clash.slice(0, 5).join('、')}。请撤销这些文件的改动后重新编辑。`)
      }
      const replay = `${index}.replay`
      await this.runOk(['read-tree', info.tip], { index: replay })
      for (const p of touched) {
        const entry = (await this.runOk(['ls-files', '-s', '-z', '--', p], { index })).split(/\s/)
        const [mode, blob] = entry
        if (mode !== undefined && blob !== undefined && /^[0-9a-f]{40,64}$/.test(blob)) {
          await this.runOk(['update-index', '--add', '--cacheinfo', mode, blob, p], { index: replay })
        } else {
          await this.runOk(['update-index', '--force-remove', '--', p], { index: replay })
        }
      }
      tree = (await this.runOk(['write-tree'], { index: replay })).trim()
    }
    const commit = (await this.runOk(['commit-tree', tree, '-p', info.tip, '-F', '-'], { input: text })).trim()
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError('生成提交失败')
    // 带旧值更新：这一瞬间分支若被别人改了，git 拒绝更新，不会覆盖别人的提交。
    await this.runOk(['update-ref', '-m', `dsh-workspace: ${text.split('\n')[0]}`, ref, commit, info.tip])
    await this.branchDiscard(ref)
    return commit.slice(0, 12)
  }

  /** 基于某个引用新建本地分支（只建引用，不检出）。 */
  async createBranch(name: string, from: string): Promise<string> {
    const branch = name.trim()
    if (branch === '' || branch.startsWith('-')) throw new GitError(`非法分支名：${name}`)
    const valid = await this.run(['check-ref-format', '--branch', branch])
    if (valid.code !== 0) throw new GitError(`非法分支名：${branch}`)
    const hash = await this.resolve(from)
    const ref = `refs/heads/${branch}`
    // 旧值为空：分支已存在时 git 拒绝，不会覆盖。
    const r = await this.run(['update-ref', ref, hash, ''])
    if (r.code !== 0) throw new GitError(/exists|already/i.test(r.stderr) ? `分支已存在：${branch}` : r.stderr.trim())
    return ref
  }

  /** 两个引用之间有差异的文件（直接比较两端快照）。返回解析后的提交号，diff 用 commit 目标即可。 */
  async compare(base: string, target: string): Promise<{ base: string; target: string; files: GitChangedFile[] }> {
    const b = await this.resolve(base)
    const t = await this.resolve(target)
    return { base: b, target: t, files: parseNameStatus(await this.runOk(['diff', '-z', '-M', '--name-status', b, t])) }
  }
}

/** 在远端执行一条 shell 命令（SSH exec）。抽出来便于测试用本机 sh 代替。 */
export type ShellExec = (command: string, options: ExecOptions) => Promise<ExecResult>

/** 远程执行：经 SSH exec，argv 逐个单引号转义后拼成一条 shell 命令。 */
export function shellGitRunner(exec: ShellExec, root: string): GitRunner {
  const sh = (command: string) => exec(`cd ${sq(root)} && ${command}`, { timeoutMs: 30_000, maxBytes: 1 << 20 })
  return {
    noGitMessage: '远程主机未安装 git。',
    pathKey: (p) => p,
    async git(argv, options) {
      const env = options.index === undefined ? '' : `GIT_INDEX_FILE=${sq(options.index)} `
      const command = `cd ${sq(root)} && ${env}git ${[...GIT_GLOBAL_ARGS, ...argv].map(sq).join(' ')}`
      return await exec(command, {
        timeoutMs: options.timeoutMs ?? 30_000,
        maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
        ...(options.input !== undefined ? { input: options.input } : {})
      })
    },
    async catRelative(rel, maxBytes) {
      return await exec(`cd ${sq(root)} && cat -- ${sq(rel)}`, { timeoutMs: 30_000, maxBytes })
    },
    async readText(abs) {
      const r = await sh(`test -f ${sq(abs)} && cat ${sq(abs)}`)
      return r.code === 0 ? r.stdout : undefined
    },
    async exists(abs) {
      return (await sh(`test -e ${sq(abs)}`)).code === 0
    },
    async writeText(abs, text) {
      const r = await sh(`printf %s ${sq(text)} > ${sq(abs)}`)
      if (r.code !== 0) throw new Error(r.stderr.trim() || `退出码 ${String(r.code)}`)
    },
    async mkdirp(abs) {
      await sh(`mkdir -p ${sq(abs)}`)
    },
    async rm(abs) {
      await sh(`rm -f -- ${abs.map(sq).join(' ')}`)
    }
  }
}

/** 远程工作区的 git（保持原有构造方式：运行时 + 主机 + 远程根目录）。 */
export class RemoteGit extends GitRepo {
  constructor(rt: WorkspaceRuntime, hostId: string, root: string) {
    const exec: ShellExec = async (command, options) =>
      execCapture(await rt.pool.acquire(hostId, 'agent', () => rt.resolveHost(hostId)), command, options)
    super(shellGitRunner(exec, root), root)
  }
}

function sideOf(raw: string, truncated: boolean): { text: string; binary: boolean; tooLarge: boolean } {
  if (truncated) return { text: '', binary: false, tooLarge: true }
  if (raw.includes('\0')) return { text: '', binary: true, tooLarge: false }
  return { text: raw, binary: false, tooLarge: false }
}
