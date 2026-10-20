/*
 * @Description: 作用域记忆 —— 会话 → 项目（宿主登记的工作区）归属解析
 * @Author: YangHeng
 * @Date: 2026-10-16 19:05:00
 * @FilePath: /dsh-workspace/src/memory/scope.ts
 *
 * 项目 = 宿主 workspaceRegistry 的工作区 UUID（本机 / 远程占位目录一视同仁）。
 * 会话 cwd 是某工作区的子目录时归入「最近的已登记祖先」（最长前缀）。
 *
 * MemoryStore 需要同步的 projectOf，而会话 cwd 与登记表都要异步取，
 * 所以这里维护一个缓存：调用方在操作某会话前先 await ensure(sessionId)。
 */
import { realpath } from 'node:fs/promises'

export interface RegisteredWorkspace {
  id: string
  path: string
  title?: string
}

export interface ScopeHost {
  /** 宿主登记的全部工作区；服务未就绪时返回 undefined。 */
  listWorkspaces(): Promise<RegisteredWorkspace[] | undefined>
  /** 会话的工作目录（热会话 / 冷会话都要能取）。 */
  sessionCwd(sessionId: string): Promise<string | undefined>
  platform?: NodeJS.Platform
}

export interface SessionScope {
  sessionId: string
  cwd: string | undefined
  /** null = 不属于任何已登记工作区。 */
  projectId: string | null
  workspace: RegisteredWorkspace | undefined
}

/** 规范化成可比较的形式：统一分隔符、去尾分隔符，Windows / macOS 忽略大小写。 */
export function comparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  let s = p.replace(/\\/g, '/')
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '')
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s
}

/** 在登记表里找 cwd 的最近祖先（含自身）。 */
export function matchWorkspace(cwd: string, workspaces: readonly RegisteredWorkspace[], platform: NodeJS.Platform = process.platform): RegisteredWorkspace | undefined {
  const target = comparablePath(cwd, platform)
  let best: RegisteredWorkspace | undefined
  let bestLen = -1
  for (const ws of workspaces) {
    const root = comparablePath(ws.path, platform)
    const inside = target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
    if (inside && root.length > bestLen) {
      best = ws
      bestLen = root.length
    }
  }
  return best
}

/** 登记表缓存多久后重新拉取（毫秒）。新建工作区后最多晚这么久才被识别。 */
const REGISTRY_TTL_MS = 10_000

export class ScopeResolver {
  private readonly sessions = new Map<string, SessionScope>()
  private registry: { at: number; list: RegisteredWorkspace[] } | undefined

  constructor(
    private readonly host: ScopeHost,
    private readonly now: () => number = Date.now
  ) {}

  /** 同步读取已解析过的会话归属（未解析过 = null）。 */
  projectOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.projectId ?? null
  }

  cached(sessionId: string): SessionScope | undefined {
    return this.sessions.get(sessionId)
  }

  async workspaces(force = false): Promise<RegisteredWorkspace[]> {
    if (!force && this.registry !== undefined && this.now() - this.registry.at < REGISTRY_TTL_MS) return this.registry.list
    const list = (await this.host.listWorkspaces().catch(() => undefined)) ?? this.registry?.list ?? []
    this.registry = { at: this.now(), list }
    return list
  }

  /** 解析并缓存会话归属。cwd 取不到时归为无项目（仍可用会话层与全局）。 */
  async ensure(sessionId: string): Promise<SessionScope> {
    const cwd = await this.host.sessionCwd(sessionId).catch(() => undefined)
    const known = this.sessions.get(sessionId)
    if (known !== undefined && known.cwd === cwd && known.projectId !== null) return known
    let resolved = cwd
    if (cwd !== undefined && cwd !== '') {
      try {
        resolved = await realpath(cwd)
      } catch {
        // 目录已不存在（冷会话 / 已删目录）：按原样比较，登记表里的路径同样是当时的规范路径
        resolved = cwd
      }
    }
    const workspace = resolved === undefined || resolved === '' ? undefined : matchWorkspace(resolved, await this.workspaces(), this.host.platform)
    const scope: SessionScope = { sessionId, cwd, projectId: workspace?.id ?? null, workspace }
    this.sessions.set(sessionId, scope)
    return scope
  }
}
