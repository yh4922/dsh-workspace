/*
 * @Description: 远程会话的 present —— 在远端校验文件，成功后按宿主格式追加 deliverables/presented 事件
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/present-tool.ts
 *
 * 宿主 present（dsh-tool-present）用本机文件系统校验路径，远程路径一律 file not found，交付卡片出不来。
 * 这里只替换「校验」这一段，事件格式与时序照抄宿主，卡片 / 正文链接 / 折叠全部复用宿主界面；
 * 点击卡片走 dsh-resource://file/session/<会话>/<路径>，由本插件的 dsh-workspace:remote-file 标签接管预览。
 *
 * 与宿主的耦合（核对版本：@deepseek-ai/dsh-tool-present、dsh-client-ui-deliverables 0.2.0-rc.2）：
 *   - 事件 deliverables/presented 的数据 { turn, callId, files: [{ path, description? }] }
 *   - sessionProjections.stateOf(session, 'turnBoundary') 的 openTurnStartSeq / lastTurn
 * 方案：.docs/远程工作区/远程文件交付卡片方案.md
 */
import { existsSync } from 'node:fs'
import { toRemotePath, type RemoteBinding } from '../workspace/bindings.js'
import type { AgentBackend } from './backend.js'
import { RemoteFsError } from './remote-tools.js'

/** 宿主 present 的默认上限（dsh-tool-present Config.maxFiles 默认 8）。 */
export const PRESENT_MAX_FILES = 8
export const PRESENTED_EVENT = 'deliverables/presented'

export interface PresentFile {
  path: string
  description?: string
}

export interface PresentValue {
  turn: number
  files: PresentFile[]
}

interface SessionLike {
  append(type: string, data: unknown): unknown
}

export interface PresentExec {
  callId?: string
  signal?: AbortSignal
  agent?: { session: unknown }
}

export interface TurnBoundarySource {
  stateOf(session: unknown, key: 'turnBoundary'): unknown
}

export interface RemotePresentDeps {
  binding: RemoteBinding
  backend: AgentBackend
  projections: TurnBoundarySource
  /** 宿主原 execute：全部是本机文件时交还给它（行为与未安装本插件时一致）。 */
  builtinExecute: (args: unknown, exec: unknown) => Promise<unknown>
  maxFiles?: number
  /** 路径分类的平台 / 存在性替身（测试用）。 */
  classify?: Omit<ClassifyOptions, 'remoteExists'>
}

type PathKind = { kind: 'local' } | { kind: 'remote'; remotePath: string }

/**
 * 交付事件里标记「这是远程工作区文件」的字段（值为主机 id）。
 * 宿主前端的 isPresentedFile 只看 path / description，多出的字段无影响；
 * 卡片 ▾ 菜单的服务端查询（gateway.presentedFile）据此判断，与这里的分类结论保证一致。
 */
export const REMOTE_MARKER = 'remoteHost'

export interface ClassifyOptions {
  /** 本机宿主平台（测试替身用）。 */
  platform?: NodeJS.Platform
  localExists?: (p: string) => boolean
  remoteExists?: (p: string) => Promise<boolean>
}

function insideRoot(root: string, p: string): boolean {
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root
  return r === '/' || p === r || p.startsWith(`${r}/`)
}

/**
 * 本机路径 → local；其余换算成远程绝对路径。
 * - Windows 宿主：盘符 / UNC 是本机，/ 开头只可能是远程（toRemotePath 的判定）。
 * - macOS / Linux 宿主：/ 开头有歧义（/Users/me/a.png 也是 / 开头）。只对「不在远程工作区根下」的这类路径
 *   做一次存在性判断：本机存在且远端不存在 → 本机文件（交还宿主，与安装本插件前行为一致）。
 *   在远程根下、相对路径、占位目录下的路径没有歧义，一律远程。
 */
export async function classifyPresentPath(binding: RemoteBinding, input: string, options: ClassifyOptions = {}): Promise<PathKind> {
  let remotePath: string
  try {
    remotePath = toRemotePath(binding, input)
  } catch {
    // toRemotePath 只对「不在占位目录下的本机绝对路径」（盘符 / UNC）抛错。
    return { kind: 'local' }
  }
  const platform = options.platform ?? process.platform
  const raw = input.trim()
  if (platform !== 'win32' && raw.startsWith('/') && !insideRoot(binding.remotePath, remotePath)) {
    const localExists = options.localExists ?? ((p: string) => existsSync(p))
    if (localExists(raw) && options.remoteExists !== undefined && !(await options.remoteExists(remotePath))) return { kind: 'local' }
  }
  return { kind: 'remote', remotePath }
}

function openTurn(projections: TurnBoundarySource, session: unknown): number | undefined {
  const boundary = projections.stateOf(session, 'turnBoundary') as { openTurnStartSeq?: unknown; lastTurn?: unknown } | undefined
  if (boundary === undefined || boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === undefined) return undefined
  return typeof boundary.lastTurn === 'number' ? boundary.lastTurn : undefined
}

/**
 * 创建远程 present：execute 替换宿主实现，onResult 挂到 Agent 作用域的 tools/result 上。
 */
export function createRemotePresent(deps: RemotePresentDeps): {
  execute(args: unknown, exec: PresentExec): Promise<unknown>
  onResult(exec: PresentExec, result: { isError?: boolean } | undefined): void
} {
  const maxFiles = deps.maxFiles ?? PRESENT_MAX_FILES
  /** 与宿主同样按 exec 记下待追加的声明：工具返回后才判定成败，失败 / 中断不留卡片。 */
  const pending = new WeakMap<object, { session: SessionLike; turn: number; files: PresentFile[] }>()

  return {
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present requires an agent Session')
      const files = (args as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) throw new Error('present requires a files array')
      const remoteExists = async (p: string): Promise<boolean> => (await deps.backend.lstat(p).catch(() => undefined)) !== undefined
      const kinds: PathKind[] = []
      for (const f of files as PresentFile[]) {
        kinds.push(typeof f?.path === 'string' ? await classifyPresentPath(deps.binding, f.path, { ...deps.classify, remoteExists }) : { kind: 'remote', remotePath: '' })
      }
      // 全部是本机文件：交还宿主（如生图后复制到本机工作区再 present 的预览图）。
      if (kinds.length > 0 && kinds.every((k) => k.kind === 'local')) return await deps.builtinExecute(args, exec)
      if (kinds.some((k) => k.kind === 'local')) {
        throw new Error('present cannot mix files on this computer with files in the remote workspace in one call; present them in two separate calls')
      }

      const session = exec.agent.session as SessionLike
      const turn = openTurn(deps.projections, session)
      if (turn === undefined) throw new Error('present requires an open turn')
      if (files.length === 0 || files.length > maxFiles) throw new Error(`present accepts 1 to ${maxFiles} files`)

      const accepted: PresentFile[] = []
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i] as PresentFile
        if (typeof file.path !== 'string' || file.path.trim().length === 0) throw new Error('present requires a non-empty file path')
        const remotePath = (kinds[i] as { remotePath: string }).remotePath
        // 文案照抄宿主：模型已有的纠错习惯直接适用。符号链接按「不是普通文件」拒绝，与宿主 lstat 语义一致。
        const entry = await deps.backend.lstat(remotePath)
        if (entry !== undefined && entry.type !== 'file') throw new Error(`Cannot present ${file.path}: not a regular file`)
        if (entry === undefined) {
          throw new RemoteFsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, 'FS_NOT_FOUND')
        }
        // 记录规范化后的远程绝对路径：卡片点击时 /srv/... 能被无歧义地识别为远程路径。
        accepted.push({ ...file, path: remotePath })
      }
      exec.signal?.throwIfAborted()
      pending.set(exec, { session, turn, files: accepted })
      return { turn, files: accepted } satisfies PresentValue
    },

    onResult(exec, result) {
      const delivery = pending.get(exec)
      pending.delete(exec)
      if (delivery === undefined || result === undefined || result.isError === true) return
      // 宿主前端要求 callId 为非空字符串（isPresentedData），否则整条事件被忽略。
      if (typeof exec.callId !== 'string' || exec.callId === '') return
      // 事件里的每个文件带上远程标记（工具返回值不带：宿主 output schema 不允许多余字段）。
      const files = delivery.files.map((f) => ({ ...f, [REMOTE_MARKER]: deps.binding.hostId }))
      delivery.session.append(PRESENTED_EVENT, { turn: delivery.turn, callId: exec.callId, files })
    }
  }
}
