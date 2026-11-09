/*
 * @Description: 远程会话的 read / write / edit / glob / grep / bash 实现
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/remote-tools.ts
 *
 * 每个函数返回的值与 DSH 内置同名工具的 output schema 完全一致，由内置工具自己的 render
 * 渲染给模型 —— 模型看到的文本、界面卡片与本地会话逐字相同（模型无感切换）。
 * 错误文案也照抄内置实现（dsh-tool-fs / dsh-fs-local），模型的纠错习惯可以直接沿用。
 *
 * 先读后写：复用 DSH 的 fs-observation-policy（事件驱动，不依赖本地文件系统），
 * 远程文件的标识是 ssh://<主机 id><远程路径>，版本是「大小:修改时间」。
 */
import path from 'node:path'
import type { AgentBackend, RemoteStat, RunResult } from './backend.js'
import { sq, versionOf } from './backend.js'
import type { PreimageStore } from './preimages.js'
import { relativeToRoot, toRemotePath, type RemoteBinding } from '../workspace/bindings.js'

// ------------------------------------------------------------------ 环境

export interface ToolExec {
  agent?: { session: { id?: string; header: { cwd?: string } } }
  signal: AbortSignal
}

export interface FsTarget {
  targetKey: string
  displayPath: string
}

export interface RemoteToolEnv {
  binding: RemoteBinding
  backend: AgentBackend
  preimages: PreimageStore
  /** 广播观察结果（fs/observed）。 */
  observe(target: FsTarget, observation: { kind: 'present'; version: string } | { kind: 'absent' }, exec: ToolExec): void
  /** 取写 / 改意图（fs/write-intent、fs/edit-intent）；没有策略插件时返回 undefined。 */
  intent(event: 'fs/write-intent' | 'fs/edit-intent', target: FsTarget, exec: ToolExec): Promise<unknown>
  /** 当前会话的沙箱模式；无沙箱服务时 undefined（视为不限制）。 */
  sandboxMode(exec: ToolExec): Promise<string | undefined>
  caps: ReadCaps
}

export interface ReadCaps {
  /** 默认也是最大的行数（必须与内置 read 的配置一致，render 依赖它判断「字节截断」）。 */
  limit: number
  maxLineLength: number
  maxBytes: number
}

/** 远程文件整读上限：再大的文件请用 bash 的 head / sed 分段查看。 */
export const REMOTE_READ_MAX_BYTES = 32 * 1024 * 1024
/** glob / grep 的输出与时间上限。 */
const SEARCH_MAX_BYTES = 16 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 60_000
/** bash 默认 / 最大超时，与内置一致的量级。 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000
export const BASH_MAX_TIMEOUT_MS = 600_000
/** bash 每个输出流保留的尾部字节数。 */
const BASH_MAX_OUTPUT_BYTES = 64 * 1024

/** 与 dsh-fs 的 FsError 同形：带 code，便于日志与测试识别。 */
export class RemoteFsError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'FsError'
  }
}

function targetOf(env: RemoteToolEnv, remotePath: string): FsTarget {
  return { targetKey: `ssh://${env.binding.hostId}${remotePath}`, displayPath: remotePath }
}

function sessionIdOf(exec: ToolExec): string {
  return exec.agent?.session.id ?? 'no-session'
}

/** 解析路径；本机路径越界等错误统一成模型能理解的一句话。 */
function resolvePath(env: RemoteToolEnv, input: string): string {
  return toRemotePath(env.binding, input)
}

// ------------------------------------------------------------------ 沙箱

/** 写入类操作的沙箱检查。沙箱无法约束远端进程，这里只能约束本插件自己执行的文件写入。 */
async function assertWritable(env: RemoteToolEnv, exec: ToolExec, remotePath: string, args: Record<string, unknown>): Promise<void> {
  if (args.sandbox_permissions !== undefined) {
    throw new RemoteFsError('sandbox escalation is not available in remote workspaces; the remote host enforces its own permissions', 'FS_SANDBOX_DENIED')
  }
  const mode = await env.sandboxMode(exec)
  if (mode === 'read-only') {
    throw new RemoteFsError(`[sandbox: file access denied under read-only mode] cannot modify "${remotePath}"`, 'FS_SANDBOX_DENIED')
  }
  if (mode === 'workspace-write') {
    const root = env.binding.remotePath.replace(/\/+$/, '') || '/'
    const inside = root === '/' || remotePath === root || remotePath.startsWith(`${root}/`)
    if (!inside) {
      throw new RemoteFsError(
        `[sandbox: file access denied under workspace-write mode] "${remotePath}" is outside the remote workspace ${root}`,
        'FS_SANDBOX_DENIED'
      )
    }
  }
}

// ------------------------------------------------------------------ 文本解码

function decodeText(buffer: Buffer, displayPath: string, verb: 'read' | 'edit'): string {
  if (buffer.includes(0)) throw new RemoteFsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new RemoteFsError(`cannot ${verb} "${displayPath}": not valid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n')

// ------------------------------------------------------------------ read

export interface ReadArgs {
  file_path: string
  offset?: number
  limit?: number
}

export interface ReadValue {
  path: string
  offset: number
  lines: Array<{ number: number; text: string }>
  totalLines: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

/** 行窗口：与内置 buildWindow 相同的行长 / 字节上限与越界规则。 */
export function buildWindow(text: string, offset: number, limit: number, caps: ReadCaps, displayPath: string): { lines: ReadValue['lines']; totalLines: number } {
  const raw = text.split('\n')
  // 末尾换行不算一行（与逐块扫描的内置实现一致）。
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const lines: ReadValue['lines'] = []
  let bytes = 0
  let cappedByBytes = false
  for (let i = 0; i < raw.length; i += 1) {
    const number = i + 1
    if (cappedByBytes || number < offset || lines.length >= limit) continue
    let line = (raw[i] as string).endsWith('\r') ? (raw[i] as string).slice(0, -1) : (raw[i] as string)
    if (line.length > caps.maxLineLength) line = `${line.substring(0, caps.maxLineLength)}... (line truncated to ${caps.maxLineLength} chars)`
    const size = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (bytes + size > caps.maxBytes) {
      cappedByBytes = true
      continue
    }
    bytes += size
    lines.push({ number, text: line })
  }
  const totalLines = raw.length
  if (!cappedByBytes && offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new RemoteFsError(`offset ${offset} is out of range for "${displayPath}" (${totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines, totalLines }
}

export async function remoteRead(env: RemoteToolEnv, args: ReadArgs, exec: ToolExec): Promise<ReadValue> {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : positiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? env.caps.limit : positiveInteger(args.limit, 'limit')
  if (limit > env.caps.limit) throw new Error(`limit must be less than or equal to ${env.caps.limit}`)

  const remotePath = resolvePath(env, args.file_path)
  const target = targetOf(env, remotePath)
  const info = await env.backend.stat(remotePath)
  if (info === undefined) {
    env.observe(target, { kind: 'absent' }, exec)
    throw new RemoteFsError(`cannot read "${remotePath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') throw new RemoteFsError(`cannot read "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  const text = decodeText(await env.backend.readBytes(remotePath, REMOTE_READ_MAX_BYTES), remotePath, 'read')
  const window = buildWindow(text, offset, limit, env.caps, remotePath)
  env.observe(target, { kind: 'present', version: versionOf(info) }, exec)
  return { path: remotePath, offset, lines: window.lines, totalLines: window.totalLines }
}

// ------------------------------------------------------------------ 写入前置：意图 + 版本守卫

type Intent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string } | undefined

/** 把观察策略的拒绝统一成内置工具的补救文案（内置 remediateFsError）。 */
function remediate(error: unknown, displayPath: string): unknown {
  const code = (error as { code?: string } | null)?.code
  if (code === 'FS_NOT_OBSERVED') {
    return new RemoteFsError(`cannot modify "${displayPath}": file has not been read — read the file, then retry`, code)
  }
  if (code === 'FS_STALE_VERSION') {
    return new RemoteFsError(`${(error as Error).message} — re-read the file, then retry`, code)
  }
  return error
}

/** 读取改动前内容用于 pre-image 与 diff 基线；二进制 / 过大返回 undefined 的文本。 */
async function readBaseline(env: RemoteToolEnv, remotePath: string, info: RemoteStat | undefined): Promise<Buffer | undefined> {
  if (info === undefined || info.type !== 'file') return undefined
  if (info.size > REMOTE_READ_MAX_BYTES) return undefined
  return await env.backend.readBytes(remotePath, REMOTE_READ_MAX_BYTES)
}

function textOrNull(buffer: Buffer | undefined): string | null {
  if (buffer === undefined || buffer.includes(0)) return null
  try {
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ write

export interface WriteArgs {
  file_path: string
  content: string
  [key: string]: unknown
}

export interface WriteValue {
  path: string
  operation: 'create' | 'update'
  before: string | null
  after: string
}

export async function remoteWrite(env: RemoteToolEnv, args: WriteArgs, exec: ToolExec): Promise<WriteValue> {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const remotePath = resolvePath(env, args.file_path)
  await assertWritable(env, exec, remotePath, args)
  const target = targetOf(env, remotePath)
  try {
    const intent = (await env.intent('fs/write-intent', target, exec)) as Intent
    const existing = await env.backend.stat(remotePath)
    if (existing !== undefined && existing.type !== 'file') {
      throw new RemoteFsError(`cannot write "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (intent?.kind === 'replaceIfVersion') {
      if (existing === undefined) throw new RemoteFsError(`cannot write "${remotePath}": file no longer exists`, 'FS_STALE_VERSION')
      if (versionOf(existing) !== intent.version) {
        throw new RemoteFsError(`cannot write "${remotePath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    } else if (intent?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new RemoteFsError(`cannot overwrite existing "${remotePath}" without reading it first`, 'FS_NOT_OBSERVED')
    }

    const baseline = await readBaseline(env, remotePath, existing)
    env.preimages.capture(sessionIdOf(exec), { hostId: env.binding.hostId, path: remotePath, tool: 'write' }, existing === undefined ? undefined : baseline)
    await env.backend.writeText(remotePath, args.content)
    const after = await env.backend.stat(remotePath)
    if (after !== undefined) env.observe(target, { kind: 'present', version: versionOf(after) }, exec)
    return {
      path: remotePath,
      operation: existing === undefined ? 'create' : 'update',
      before: existing === undefined ? null : textOrNull(baseline),
      after: normalizeLineEndings(args.content)
    }
  } catch (error) {
    throw remediate(error, remotePath)
  }
}

// ------------------------------------------------------------------ edit

export interface EditArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
  [key: string]: unknown
}

export interface EditValue {
  path: string
  before: string
  after: string
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

export async function remoteEdit(env: RemoteToolEnv, args: EditArgs, exec: ToolExec): Promise<EditValue> {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  const remotePath = resolvePath(env, args.file_path)
  await assertWritable(env, exec, remotePath, args)
  const target = targetOf(env, remotePath)
  try {
    const intent = (await env.intent('fs/edit-intent', target, exec)) as { version?: string } | undefined
    const existing = await env.backend.stat(remotePath)
    if (existing === undefined) throw new RemoteFsError(`cannot edit "${remotePath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new RemoteFsError(`cannot edit "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (intent?.version !== undefined && versionOf(existing) !== intent.version) {
      throw new RemoteFsError(`cannot edit "${remotePath}": file changed since it was read`, 'FS_STALE_VERSION')
    }

    const buffer = await env.backend.readBytes(remotePath, REMOTE_READ_MAX_BYTES)
    const raw = decodeText(buffer, remotePath, 'edit')
    const crlf = raw.includes('\r\n')
    const content = normalizeLineEndings(raw)
    const oldNorm = normalizeLineEndings(args.old_string)
    const newNorm = normalizeLineEndings(args.new_string)
    const replacements = countOccurrences(content, oldNorm)
    if (replacements === 0) throw new RemoteFsError(`old_string was not found in "${remotePath}"`, 'FS_EDIT_NOT_FOUND')
    if (args.replace_all !== true && replacements > 1) {
      throw new RemoteFsError(
        `old_string matched ${replacements} times in "${remotePath}"; provide a more specific old_string or set replace_all to true`,
        'FS_AMBIGUOUS_EDIT'
      )
    }
    const edited = content.split(oldNorm).join(newNorm)
    // 保持文件原有的换行风格（Windows 风格的文件改完仍是 CRLF）。
    const output = crlf ? edited.split('\n').join('\r\n') : edited

    env.preimages.capture(sessionIdOf(exec), { hostId: env.binding.hostId, path: remotePath, tool: 'edit' }, buffer)
    await env.backend.writeText(remotePath, output)
    const after = await env.backend.stat(remotePath)
    if (after !== undefined) env.observe(target, { kind: 'present', version: versionOf(after) }, exec)
    return { path: remotePath, before: content, after: edited }
  } catch (error) {
    throw remediate(error, remotePath)
  }
}

// ------------------------------------------------------------------ glob

/** glob → 正则：** 跨目录、* 不跨目录、?、{a,b}、[...]。 */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  let braceDepth = 0
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // 「**/」匹配零到多级目录；单独的「**」匹配任意字符（含 /）。
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
        continue
      }
      re += '[^/]*'
    } else if (ch === '?') {
      re += '[^/]'
    } else if (ch === '{') {
      braceDepth += 1
      re += '(?:'
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1
      re += ')'
    } else if (ch === ',' && braceDepth > 0) {
      re += '|'
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) {
        re += '\\['
      } else {
        let body = pattern.slice(i + 1, close)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        re += `[${body.replace(/\\/g, '\\\\')}]`
        i = close
      }
    } else {
      re += ch.replace(/[.+^$()|\\]/g, '\\$&')
    }
    i += 1
  }
  return new RegExp(`^${re}$`)
}

export interface GlobArgs {
  pattern: string
  path?: string
}

export interface GlobValue {
  root: string
  paths: string[]
}

/** 每个后端（主机）探测一次的远端能力。 */
const capabilityCache = new WeakMap<AgentBackend, { gnuFind?: boolean; rg?: boolean; grepP?: boolean }>()

async function probe(env: RemoteToolEnv, key: 'gnuFind' | 'rg' | 'grepP', command: string, expect: string): Promise<boolean> {
  const cache = capabilityCache.get(env.backend) ?? {}
  capabilityCache.set(env.backend, cache)
  if (cache[key] !== undefined) return cache[key] as boolean
  const out = await env.backend.run(command, { cwd: '/', timeoutMs: 10_000, maxBytes: 1024 })
  cache[key] = out.stdout.trim() === expect
  return cache[key] as boolean
}

async function searchRoot(env: RemoteToolEnv, input: string | undefined, verb: string): Promise<{ root: string; info: RemoteStat }> {
  const root = input === undefined ? env.binding.remotePath : resolvePath(env, input)
  const info = await env.backend.stat(root)
  if (info === undefined) throw new RemoteFsError(`cannot ${verb} "${root}": not found`, 'FS_NOT_FOUND')
  return { root, info }
}

function assertSearchFinished(run: RunResult, verb: string): void {
  if (run.aborted) throw new Error(`${verb} aborted`)
  if (run.timedOut) throw new Error(`${verb} timed out after ${SEARCH_TIMEOUT_MS}ms; narrow the pattern or path`)
}

export async function remoteGlob(env: RemoteToolEnv, args: GlobArgs, exec: ToolExec): Promise<GlobValue> {
  if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
  const { root, info } = await searchRoot(env, args.path, 'search')
  if (info.type !== 'dir') throw new RemoteFsError(`cannot search "${root}": not a directory`, 'FS_NOT_DIRECTORY')
  const gnu = await probe(env, 'gnuFind', "find / -maxdepth 0 -printf ok 2>/dev/null", 'ok')
  // 与内置一致：包含隐藏与被忽略的文件，只不进入版本库元数据目录。
  const prune = `\\( -name .git -o -name .svn -o -name .hg \\) -prune -o -type f`
  const command = gnu
    ? `find ${sq(root)} ${prune} -printf '%T@\\t%p\\n' 2>/dev/null`
    : `find ${sq(root)} ${prune} -print 2>/dev/null`
  const run = await env.backend.run(command, { cwd: root, timeoutMs: SEARCH_TIMEOUT_MS, maxBytes: SEARCH_MAX_BYTES, signal: exec.signal })
  assertSearchFinished(run, 'glob')

  const pattern = args.pattern.replace(/^\.\//, '')
  const matcher = globToRegExp(pattern)
  const anchored = pattern.includes('/')
  const found: Array<{ path: string; mtime: number }> = []
  for (const line of run.stdout.split('\n')) {
    if (line === '') continue
    let mtime = 0
    let full = line
    if (gnu) {
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      mtime = Number(line.slice(0, tab))
      full = line.slice(tab + 1)
    }
    const relToSearch = full === root ? '' : full.slice(root === '/' ? 1 : root.length + 1)
    const subject = anchored ? relToSearch : path.posix.basename(full)
    if (matcher.test(subject)) found.push({ path: full, mtime })
  }
  // 最近修改的在前（与内置 ripgrep 的修改时间排序一致）。
  found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  return {
    root: args.path === undefined ? '.' : relativeToRoot(env.binding, root),
    paths: found.map((f) => relativeToRoot(env.binding, f.path))
  }
}

// ------------------------------------------------------------------ grep

export interface GrepArgs {
  pattern: string
  path?: string
  include?: string
}

export interface GrepValue {
  matches: Array<{ path: string; lineNumber: number; line: string }>
}

/** 展开 {a,b} —— GNU grep 的 --include 不支持花括号。 */
export function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob)
  if (m === null) return [glob]
  const [whole, body] = m as unknown as [string, string]
  return body.split(',').flatMap((alt) => expandBraces(glob.replace(whole, alt)))
}

export async function remoteGrep(env: RemoteToolEnv, args: GrepArgs, exec: ToolExec): Promise<GrepValue> {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  const { root } = await searchRoot(env, args.path, 'search')
  const hasRg = await probe(env, 'rg', 'command -v rg >/dev/null 2>&1 && echo yes', 'yes')
  let command: string
  if (hasRg) {
    const include = args.include !== undefined ? `--glob ${sq(args.include)} ` : ''
    command = `rg --no-heading --with-filename --line-number --null --color never --no-messages ${include}-e ${sq(args.pattern)} -- ${sq(root)}`
  } else {
    // ripgrep 的正则语法与 PCRE 最接近（\d、\w、非贪婪）；BusyBox 等不支持 -P 时退回扩展正则。
    const pcre = await probe(env, 'grepP', "echo a | grep -P 'a' >/dev/null 2>&1 && echo yes", 'yes')
    const includes = args.include !== undefined ? expandBraces(args.include).map((g) => `--include=${sq(g)} `).join('') : ''
    const excludes = ['.git', '.svn', '.hg', 'node_modules'].map((d) => `--exclude-dir=${d} `).join('')
    command = `grep -rnIZ ${pcre ? '-P' : '-E'} ${excludes}${includes}-e ${sq(args.pattern)} -- ${sq(root)} 2>/dev/null`
  }
  const run = await env.backend.run(command, { cwd: root, timeoutMs: SEARCH_TIMEOUT_MS, maxBytes: SEARCH_MAX_BYTES, signal: exec.signal })
  assertSearchFinished(run, 'grep')
  // 退出码 1 = 没有匹配；2 = 出错（如正则非法），此时报告 stderr。
  if (run.code === 2 && run.stdout === '') throw new Error(`grep failed: ${run.stderr.trim() || 'invalid pattern'}`)

  const matches: GrepValue['matches'] = []
  for (const record of run.stdout.split('\n')) {
    const nul = record.indexOf('\0')
    if (nul === -1) continue
    const file = record.slice(0, nul)
    const rest = record.slice(nul + 1)
    const colon = rest.indexOf(':')
    const lineNumber = Number(rest.slice(0, colon))
    if (colon === -1 || !Number.isInteger(lineNumber)) continue
    const line = rest.slice(colon + 1)
    matches.push({ path: relativeToRoot(env.binding, file), lineNumber, line: line.endsWith('\r') ? line.slice(0, -1) : line })
  }
  return { matches }
}

// ------------------------------------------------------------------ bash

export interface BashArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  [key: string]: unknown
}

export interface BashValue {
  kind: 'foreground'
  /**
   * 实际执行目录（远程 POSIX 路径）。DSH 0.2.1-rc.2 起内置 bash 的前台结果要求它（issue #14）；
   * 0.2.0 及更早的宿主 schema 没有这个字段且禁止多余字段 —— 包装内置定义时按宿主 schema 决定是否保留（见 register.ts）。
   */
  cwd?: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean }
  stderr: { text: string; truncated: boolean }
}

export async function remoteBash(env: RemoteToolEnv, args: BashArgs, exec: ToolExec): Promise<BashValue> {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (typeof args.description !== 'string' || args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.run_in_background === true) {
    throw new Error(
      'run_in_background is not supported in remote workspaces yet; start the command with `nohup <cmd> > /tmp/<name>.log 2>&1 &` and read the log file instead'
    )
  }
  if (args.sandbox_permissions !== undefined) {
    throw new Error('sandbox escalation is not available in remote workspaces; the remote host enforces its own permissions')
  }
  // 远端进程无法被本机沙箱约束：只读模式下不执行任何命令，宁可拒绝也不冒改动远端的风险。
  if ((await env.sandboxMode(exec)) === 'read-only') {
    throw new Error('[sandbox: file access denied under read-only mode] remote commands cannot be sandboxed, so bash is disabled in read-only mode')
  }
  const timeoutMs = Math.min(args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS)
  const cwd = args.workdir === undefined ? env.binding.remotePath : resolvePath(env, args.workdir)
  const run = await env.backend.run(args.command, { cwd, timeoutMs, maxBytes: BASH_MAX_OUTPUT_BYTES, signal: exec.signal })
  if (run.aborted) throw new Error('aborted')
  return {
    kind: 'foreground',
    cwd,
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    aborted: false,
    timeoutMs,
    stdout: { text: run.stdout, truncated: run.stdoutTruncated },
    stderr: { text: run.stderr, truncated: run.stderrTruncated }
  }
}

/**
 * 与内置 bash 的 renderResult 相同的文本（本机没有内置 bash —— 如 Windows 只有 pwsh —— 时，
 * 远程 bash 用自己的定义，渲染仍保持一致）。
 */
export function renderBash(value: BashValue): string {
  const streamText = (s: { text: string; truncated: boolean }): string =>
    s.truncated ? `${s.text}\n[output truncated; full output: (unavailable)]` : s.text
  const out = streamText(value.stdout)
  const err = streamText(value.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== 0 && !value.timedOut) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}
