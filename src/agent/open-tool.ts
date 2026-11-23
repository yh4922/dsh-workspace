/*
 * @Description: Agent 工具 open_in_sidebar —— 在调用方会话的右侧栏打开文件 / 文件夹 / 网页（本机会话与远程会话都注册）
 * @Author: YangHeng
 * @Date: 2026-10-10 16:00:00
 * @FilePath: /dsh-workspace/src/agent/open-tool.ts
 *
 * 分工：宿主端只做「解析 + 校验 + 分类」（本机 fs.stat / 远程 SFTP stat），真正的打开在浏览器端：
 * 工具卡片（tool.call.toolview）看到结果由 running 变成 ok 时调 sidebarRight 打开（见 client/sidebar/open-in-sidebar.tsx）。
 * 所以只有「当前显示该会话的页面」会打开；历史重放按 callId 去重，不会重复打开。
 * 参数、返回值与 dsh-better-sidebar 的 sidebar_open 一致（另加 remoteHost），本插件在 Agent 作用域里遮蔽它。
 * 方案：.docs/远程工作区/侧边栏自建方案.md 3.6
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { RemoteBinding } from '../workspace/bindings.js'
import { classifyPresentPath, type ClassifyOptions } from './present-tool.js'
import type { RemoteStat } from './backend.js'
import {
  OPEN_TOOL_NAME,
  formatOpenResult,
  hasOtherScheme,
  isHttpUrl,
  type OpenKind,
  type OpenValue
} from '../wire/open-in-sidebar.js'

/** 目标的解析结果（尚未 stat）。 */
export type OpenPlan = { type: 'url'; url: string; title: string } | { type: 'local'; path: string } | { type: 'remote'; remotePath: string }

export interface PlanOptions extends ClassifyOptions {
  /** 会话 cwd（本机会话的相对路径基准）。 */
  cwd?: string
  /** 会话所在的远程工作区；本机会话为 undefined。 */
  binding?: RemoteBinding
}

/**
 * 分类目标：
 * - http(s) → 网址（必须能被 URL 解析）；其他协议一律拒绝，但 C:\ / C:/ 盘符是路径不是协议。
 * - 远程会话：路径按远程根解析（相对路径、/ 开头、占位目录下的本机路径都算远程）；
 *   盘符 / UNC 是本机；macOS / Linux 上「/ 开头且不在远程根下」的路径做本机存在 + 远端不存在判断
 *   （与 present 共用 classifyPresentPath，见关键记忆「跨平台路径约定」）。
 * - 本机会话：绝对路径原样，相对路径相对会话 cwd。
 */
export async function planOpenTarget(raw: string, options: PlanOptions): Promise<OpenPlan> {
  const input = raw.trim()
  if (input === '') throw new Error(`${OPEN_TOOL_NAME} requires a non-empty target`)
  if (isHttpUrl(input)) {
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      throw new Error(`"${input}" is not a valid URL`)
    }
    return { type: 'url', url: input, title: parsed.hostname !== '' ? parsed.hostname : input }
  }
  if (hasOtherScheme(input)) throw new Error(`${OPEN_TOOL_NAME} only accepts http:// and https:// URLs; use a path for files and folders`)
  if (options.binding !== undefined) {
    const kind = await classifyPresentPath(options.binding, input, options)
    if (kind.kind === 'remote') return { type: 'remote', remotePath: kind.remotePath }
    return { type: 'local', path: path.resolve(input) }
  }
  if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) return { type: 'local', path: path.resolve(input) }
  if (options.cwd === undefined || options.cwd === '') throw new Error(`"${input}" is relative but this session has no working directory; pass an absolute path`)
  return { type: 'local', path: path.resolve(options.cwd, input) }
}

function baseNameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

export interface OpenToolDeps {
  /** 按会话 cwd 查远程工作区绑定（执行时现查：会话可能已换工作区）。 */
  resolveBinding(cwd: string | undefined): RemoteBinding | undefined
  /** 远程 stat（跟随符号链接）；不存在返回 undefined。 */
  remoteStat(binding: RemoteBinding, remotePath: string): Promise<RemoteStat | undefined>
  /**
   * 远程路径 → 侧栏（SFTP 文件浏览）使用的写法。模型给的是 SSH exec 视角，SFTP 根不同的主机
   * （issue #17，群晖 DSM）上两者不一致；不传时原样交给侧栏。
   */
  clientPath?: (binding: RemoteBinding, remotePath: string) => Promise<string>
  /** 本机 stat 替身（测试用）。 */
  localStat?: (p: string) => Promise<{ isDirectory(): boolean }>
  /** 平台替身（测试用）。 */
  platform?: NodeJS.Platform
}

interface OpenExec {
  signal?: AbortSignal
  agent?: { session: { header?: { cwd?: string } } }
}

/** 执行一次打开请求：解析、校验存在性、区分文件 / 文件夹。 */
export async function executeOpen(deps: OpenToolDeps, args: { target: string; title?: string }, exec: OpenExec): Promise<OpenValue> {
  exec.signal?.throwIfAborted()
  if (exec.agent === undefined) throw new Error(`${OPEN_TOOL_NAME} requires an initiating agent`)
  const cwd = exec.agent.session.header?.cwd
  const binding = deps.resolveBinding(cwd)
  const remoteExists = async (p: string): Promise<boolean> =>
    binding !== undefined && (await deps.remoteStat(binding, p).catch(() => undefined)) !== undefined
  const plan = await planOpenTarget(args.target, { cwd, binding, remoteExists, ...(deps.platform !== undefined ? { platform: deps.platform } : {}) })
  const custom = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined

  if (plan.type === 'url') return { kind: 'url', target: plan.url, title: custom ?? plan.title, delivered: true }

  let kind: OpenKind
  let target: string
  if (plan.type === 'remote') {
    const info = await deps.remoteStat(binding as RemoteBinding, plan.remotePath)
    if (info === undefined) throw new Error(`"${args.target}" does not exist on the remote host (resolved to "${plan.remotePath}")`)
    kind = info.type === 'dir' ? 'folder' : 'file'
    target = deps.clientPath === undefined ? plan.remotePath : await deps.clientPath(binding as RemoteBinding, plan.remotePath)
  } else {
    let info: { isDirectory(): boolean }
    try {
      info = await (deps.localStat ?? stat)(plan.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`"${args.target}" does not exist (resolved to "${plan.path}")`, { cause: error })
      if (code === 'EACCES' || code === 'EPERM') throw new Error(`"${plan.path}" is not readable`, { cause: error })
      throw new Error(`cannot open "${plan.path}": ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    kind = info.isDirectory() ? 'folder' : 'file'
    target = plan.path
  }
  exec.signal?.throwIfAborted()
  const title = custom ?? (baseNameOf(target) || target)
  return { kind, target, title, delivered: true, ...(plan.type === 'remote' ? { remoteHost: (binding as RemoteBinding).hostId } : {}) }
}

/**
 * 工具定义（交给宿主 defineTool）。name 可换成 sidebar_open：BS 的同名工具无法 restrict 时用同一实现遮蔽它。
 */
export function openToolDefinition(deps: OpenToolDeps, name: string = OPEN_TOOL_NAME): unknown {
  return {
    name,
    description:
      'Open a file, a folder, or an HTTP(S) page in the right sidebar of the calling conversation. ' +
      'A file opens in the sidebar file viewer (code, Markdown, HTML, images, PDF, Office documents, media); a folder opens the file manager and reveals it; a URL opens in the sidebar browser. ' +
      'The path may be absolute or relative to the session working directory; in a remote SSH workspace, paths resolve on the remote host (relative to the remote workspace root), while drive-letter / UNC paths refer to this computer. ' +
      'The open happens in the page that is currently displaying this conversation; if the conversation is not displayed, nothing opens and the user can reopen it from the tool card. ' +
      'Use it to show the user a result (a generated report, a changed file, a local dev server page), not to read files for yourself.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Absolute or session-cwd-relative path (remote workspace: remote path or relative to the remote root), or an http:// / https:// URL.'
      },
      title: { type: 'string', description: 'Optional tab title (defaults to the file/folder name or the URL hostname).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['file', 'folder', 'url'], description: 'What was opened: file | folder | url.' },
          target: { type: 'string', required: true, description: 'The absolute path (local or remote) or URL that was opened.' },
          title: { type: 'string', required: true, description: 'The tab title used (provided title, basename, or hostname).' },
          delivered: { type: 'boolean', required: true, description: 'The request was handed to the conversation view.' },
          remoteHost: { type: 'string', description: 'Present when the target is on the remote host of this workspace.' }
        }
      },
      render: (_args: unknown, value: OpenValue) => [{ type: 'text', text: formatOpenResult(value) }]
    },
    async execute(args: unknown, exec: unknown) {
      return await executeOpen(deps, args as { target: string; title?: string }, exec as OpenExec)
    }
  }
}
