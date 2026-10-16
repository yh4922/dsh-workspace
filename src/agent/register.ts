/*
 * @Description: 为远程会话的 Agent 注册同名工具（遮蔽内置实现），本地会话只多一个 open_in_sidebar
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/register.ts
 *
 * 机制（已用真实 ToolRuntime 验证，见 shadow.test.ts）：
 *   agent/created → 会话 cwd 反查绑定 → 是远程工作区才在该 Agent 的作用域注册同名工具。
 *   注册的定义 = 内置定义（参数、输出 schema、render、界面卡片原样保留）+ 替换后的 execute。
 *   本地会话不接管任何内置工具 → 内置工具的清单与行为与未安装本插件时完全相同。
 *   例外：open_in_sidebar（方案 3.6）本机 / 远程会话都注册（偏好可关），并遮蔽 BS 的 sidebar_open。
 *
 * 不用全局「当前主机」路由：dsh-remote 曾因此把 A 会话的命令打到 B 会话的机器上（其 issue #25）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceRuntime } from '../runtime.js'
import type { BindingStore, RemoteBinding } from '../workspace/bindings.js'
import { isLocalHostPath, pathKey } from '../workspace/bindings.js'
import { SshAgentBackend, type AgentBackend } from './backend.js'
import type { PreimageStore } from './preimages.js'
import {
  remoteBash,
  remoteEdit,
  remoteGlob,
  remoteGrep,
  remoteRead,
  remoteWrite,
  renderBash,
  type BashValue,
  type ReadCaps,
  type RemoteToolEnv,
  type ToolExec
} from './remote-tools.js'
import { UPLOAD_TOOL_NAME, uploadToolDefinition, type UploadDeps } from './upload-tool.js'
import type { AttachmentService } from './upload-source.js'
import { createRemotePresent, type PresentExec, type TurnBoundarySource } from './present-tool.js'
import { openToolDefinition, type OpenToolDeps } from './open-tool.js'
import { BS_OPEN_TOOL_NAME, OPEN_TOOL_NAME } from '../wire/open-in-sidebar.js'

interface ToolDefinitionLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  [key: string]: unknown
}

interface ScopedTools {
  get(name: string, scope?: unknown): ToolDefinitionLike | undefined
  register(definition: unknown): () => void
  restrict(filter: { deny?: string[]; allow?: string[] }): () => void
}

interface AgentLike {
  ctx: {
    inject(
      deps: string[],
      callback: (c: { tools: ScopedTools; on?: (event: string, listener: (...args: never[]) => unknown) => () => void }) => void
    ): { dispose(): unknown }
  }
  session: { id?: string; header: { cwd?: string } }
}

/**
 * 本地 shell 工具：远程会话里默认隐藏，否则模型可能在本机执行命令。
 * 主机配置 allowLocalShell 打开时保留它们 —— 此时命令确实跑在本机（主机表单有警示、日志留痕、提示词说明）。
 */
const LOCAL_SHELLS = ['pwsh', 'powershell', 'cmd']

export interface AgentToolsDeps {
  rt: WorkspaceRuntime
  bindings: BindingStore
  preimages: PreimageStore
  /** 测试替身：自定义后端（默认 SSH）。 */
  backendFor?: (binding: RemoteBinding) => AgentBackend
  /** 本机没有内置 bash 时用来定义远程 bash（运行时从宿主取 @deepseek-ai/dsh-tools 的 defineTool）。 */
  defineTool?: (definition: unknown) => unknown
  /**
   * open_in_sidebar 的开关（偏好 sidebar.openInSidebar）与变化订阅。不传（或没有 defineTool）则不注册，
   * 此时本地会话仍保持「不注册任何东西」。
   */
  openInSidebar?: { enabled(): boolean; subscribe(listener: () => void): () => void }
  /**
   * 该主机的远程会话是否保留本机 shell（主机配置 allowLocalShell）。不传 = 一律隐藏。
   * 挂载时读一次，之后每次 subscribeHosts 通知再读，已打开的会话从下一轮对话起按新配置生效。
   */
  keepLocalShell?: (hostId: string) => boolean
  /**
   * 该主机的远程会话是否允许内置文件工具读写本机文件（主机配置 allowLocalFiles）。
   * 与 keepLocalShell 不同，这里不做「挂载时读一次」：五工具按路径分发，每次调用现读（即时生效）。
   */
  keepLocalFiles?: (hostId: string) => boolean
  /** 主机配置变化订阅（保险箱写盘后通知）。不传 = 只在挂载时读一次。 */
  subscribeHosts?: (listener: () => void) => () => void
  /**
   * 当前实际保留着本机 shell 的 Agent（系统提示词据此说明 pwsh 跑在本机），随配置变化即时增删。
   * 提示词以它为准而不是只看主机配置：两者在同步完成前的瞬间可能不一致。
   */
  localShellAgents?: WeakSet<object>
}

/**
 * 从内置 read 的参数说明里取默认行数（render 依赖它，两边必须一致）。
 *
 * 不能对整个 parameters 取「第一个 Defaults to N.」：内置 read 的 offset 说明是
 * 「1-based first line to return. Defaults to 1.」，且 offset 排在 limit 之前，
 * 于是抓到的是 1 —— 远程 read 每次只返回一行，且 limit 参数一律被拒
 * （limit must be less than or equal to 1）。所以只读 limit 属性自己的说明；
 * 取不到（没有 limit，或说明里没写默认值）就用 2000，绝不回退到整段文本，
 * 否则又会抓到别的属性的数字。
 */
export function readLimitOf(builtin: ToolDefinitionLike | undefined): number {
  const params = (builtin?.parameters ?? {}) as { limit?: { description?: unknown }; properties?: { limit?: { description?: unknown } } }
  // 兼容扁平形状（dsh-tool-fs 当前写法）与 JSON Schema 的 properties 包裹
  const limit = params.properties?.limit ?? params.limit
  const match = /Defaults to (\d+)\./.exec(String(limit?.description ?? ''))
  const n = match === null ? NaN : Number(match[1])
  return Number.isInteger(n) && n > 0 ? n : 2000
}

/**
 * 挂载 Agent 工具。返回清理函数（插件卸载时释放所有作用域注册）。
 */
export function mountAgentTools(ctx: Context, deps: AgentToolsDeps): () => void {
  const c = ctx as unknown as {
    on(event: string, listener: (...args: unknown[]) => unknown): () => void
    emit(event: string, ...args: unknown[]): void
    waterfall?: (event: string, ...args: unknown[]) => Promise<unknown>
    get(name: string): unknown
  }
  const scopes = new Map<AgentLike, { dispose(): unknown }>()
  const backends = new Map<string, AgentBackend>()
  const backendFor =
    deps.backendFor ??
    ((binding: RemoteBinding): AgentBackend => {
      // 每台主机一个后端实例：远端能力探测（rg / GNU find）按主机缓存一次。
      let backend = backends.get(binding.hostId)
      if (backend === undefined) {
        backend = new SshAgentBackend(deps.rt, binding.hostId)
        backends.set(binding.hostId, backend)
      }
      return backend
    })

  const sandboxMode = async (exec: ToolExec): Promise<string | undefined> => {
    const policy = c.get('sandboxPolicy') as { resolve(input: object): unknown } | undefined
    if (policy === undefined || exec.agent === undefined) return undefined
    const resolved = (await policy.resolve({ session: exec.agent.session })) as { mode?: string } | undefined
    return resolved?.mode
  }

  const envFor = (binding: RemoteBinding, caps: ReadCaps): RemoteToolEnv => ({
    binding,
    backend: backendFor(binding),
    preimages: deps.preimages,
    caps,
    sandboxMode,
    observe: (target, observation, exec) => c.emit('fs/observed', target, observation, exec),
    intent: async (event, target, exec) =>
      typeof c.waterfall === 'function' ? await c.waterfall(event, target, exec, () => Promise.resolve(undefined)) : undefined
  })

  /** 执行时再核对一次：会话若已不在这个远程工作区（极端情况），拒绝而不是操作错的机器。 */
  const guard = (binding: RemoteBinding, exec: ToolExec): void => {
    const now = deps.bindings.resolve(exec.agent?.session.header.cwd)
    if (now === undefined || pathKey(now.localPath) !== pathKey(binding.localPath)) {
      throw new Error('this session is no longer bound to the remote workspace; start a new session in the workspace')
    }
  }

  // ---------------------------------------------------------------- open_in_sidebar（本机与远程会话都注册）
  const openSwitch = deps.defineTool !== undefined ? deps.openInSidebar : undefined
  /** 每个 Agent 的 open_in_sidebar 清理函数（撤销偏好订阅与注册）。 */
  const openOffs = new Map<AgentLike, () => void>()
  const openDeps: OpenToolDeps = {
    resolveBinding: (cwd) => deps.bindings.resolve(cwd),
    remoteStat: (binding, p) => backendFor(binding).stat(p)
  }

  /**
   * 在 Agent 作用域注册 open_in_sidebar，并遮蔽 BS 的 sidebar_open（存在时）：
   * 优先 restrict 从清单里去掉（模型只看到一个打开工具）；restrict 不可用 / 抛错时用同一实现同名注册遮蔽，
   * 这样无论哪种情况都不会让 BS 的实现执行（它只会把请求排进 BS 自己的侧栏队列）。
   * BS 不存在时什么也不做 —— restrict 未知工具名会抛错，所以先 get 再处理。
   * 偏好 sidebar.openInSidebar 变化时即时注册 / 撤销（不用重开会话）。
   */
  const mountOpen = (agent: AgentLike, tools: ScopedTools): void => {
    // inject 回调可能因 tools 服务重建而重跑：先清掉上一轮的订阅。
    openOffs.get(agent)?.()
    const define = deps.defineTool as (definition: unknown) => unknown
    const register = (): (() => void) => {
      const offs: Array<() => void> = [tools.register(define(openToolDefinition(openDeps)))]
      if (tools.get(BS_OPEN_TOOL_NAME, agent) !== undefined) {
        try {
          offs.push(tools.restrict({ deny: [BS_OPEN_TOOL_NAME] }))
        } catch {
          try {
            offs.push(tools.register(define(openToolDefinition(openDeps, BS_OPEN_TOOL_NAME))))
          } catch (error) {
            deps.rt.log.error('', 'agent', `遮蔽 ${BS_OPEN_TOOL_NAME} 失败`, error)
          }
        }
      }
      return () => {
        for (const off of offs.reverse()) {
          try {
            off()
          } catch {
            /* 作用域已随 Agent 释放：注册已被一并撤下 */
          }
        }
      }
    }
    let off: (() => void) | undefined
    const sync = (): void => {
      const on = openSwitch?.enabled() === true
      if (on && off === undefined) {
        try {
          off = register()
        } catch (error) {
          deps.rt.log.error('', 'agent', `注册 ${OPEN_TOOL_NAME} 失败`, error)
        }
      } else if (!on && off !== undefined) {
        off()
        off = undefined
      }
    }
    sync()
    const unsubscribe = openSwitch?.subscribe(sync) ?? (() => undefined)
    openOffs.set(agent, () => {
      unsubscribe()
      off?.()
      off = undefined
      openOffs.delete(agent)
    })
  }

  // ---------------------------------------------------------------- 本机 shell（远程会话，按主机配置即时同步）
  /** 每个远程 Agent 的本机 shell 清理函数（撤销主机配置订阅与隐藏）。 */
  const shellOffs = new Map<AgentLike, () => void>()

  /**
   * 远程会话里的本机 shell（pwsh / powershell / cmd）：主机配置 allowLocalShell 关闭时隐藏，打开时保留
   * （命令真的在本机执行）。主机配置变化即时同步：已打开的会话不用重建，下一轮对话起按新配置生效 ——
   * 关闭尤其要即时，用户关开关就是在收回权限。
   * 隐藏优先 restrict 从清单里去掉；去不掉就用同名的拒绝版本遮蔽，绝不让它在本机执行。
   * @returns 首次同步隐藏了的工具（接管日志用）与隐藏失败的工具
   */
  const mountLocalShells = (
    agent: AgentLike,
    binding: RemoteBinding,
    tools: ScopedTools,
    builtins: Array<[string, ToolDefinitionLike]>
  ): { hidden: string[]; failed: string[] } => {
    // inject 回调可能因 tools 服务重建而重跑：先清掉上一轮的订阅。
    shellOffs.get(agent)?.()
    const result = { hidden: [] as string[], failed: [] as string[] }
    if (builtins.length === 0) return result
    const names = builtins.map(([name]) => name).join(', ')
    const session = agent.session.id ?? '?'

    const hideAll = (): (() => void) => {
      const offs: Array<() => void> = []
      for (const [name, builtin] of builtins) {
        try {
          try {
            offs.push(tools.restrict({ deny: [name] }))
          } catch {
            offs.push(
              tools.register({
                ...builtin,
                execute: async () => {
                  throw new Error(`${name} is not available in a remote workspace (it would run on the local computer); use bash, which runs on the remote host`)
                }
              })
            )
          }
          result.hidden.push(name)
        } catch (error) {
          result.failed.push(`hide ${name}`)
          deps.rt.log.error(binding.hostId, 'agent', `隐藏本机 shell ${name} 失败`, error)
        }
      }
      return () => {
        for (const off of offs.reverse()) {
          try {
            off()
          } catch {
            /* 作用域已随 Agent 释放：注册已被一并撤下 */
          }
        }
      }
    }

    let state: 'hidden' | 'kept' | undefined
    let unhide: (() => void) | undefined
    const sync = (initial: boolean): void => {
      const next = safeKeepLocalShell(deps, binding.hostId) ? 'kept' : 'hidden'
      if (next === state) return
      if (next === 'hidden') {
        unhide = hideAll()
        deps.localShellAgents?.delete(agent)
        if (!initial) deps.rt.log.warn(binding.hostId, 'agent', `主机配置已关闭本机 shell：此远程会话里的 ${names} 已隐藏，下一轮对话起不可用（${session}）。`)
      } else {
        unhide?.()
        unhide = undefined
        deps.localShellAgents?.add(agent)
        deps.rt.log.warn(
          binding.hostId,
          'agent',
          initial
            ? `该主机配置了保留本机 shell：${names} 在此远程会话里可用，命令将在本机执行（${session}）。`
            : `主机配置已打开本机 shell：此远程会话里的 ${names} 下一轮对话起可用，命令将在本机执行（${session}）。`
        )
      }
      state = next
    }
    sync(true)
    const unsubscribe = deps.subscribeHosts?.(() => sync(false)) ?? (() => undefined)
    shellOffs.set(agent, () => {
      unsubscribe()
      unhide?.()
      unhide = undefined
      deps.localShellAgents?.delete(agent)
      shellOffs.delete(agent)
    })
    return result
  }

  const attach = (agent: AgentLike): void => {
    if (scopes.has(agent)) return
    const binding = deps.bindings.resolve(agent.session?.header?.cwd)
    // 本机会话只有 open_in_sidebar 需要注册；它没启用（未传开关）时本机会话保持零注册。
    if (binding === undefined && openSwitch === undefined) return

    const fiber = agent.ctx.inject(['tools'], (scoped) => {
      if (openSwitch !== undefined) {
        // 单独 try：这里抛错会让 cordis 回滚本回调里的全部注册（含远程工具接管）。
        try {
          mountOpen(agent, scoped.tools)
        } catch (error) {
          deps.rt.log.error(binding?.hostId ?? '', 'agent', `注册 ${OPEN_TOOL_NAME} 失败`, error)
        }
      }
      if (binding === undefined) return
      const tools = scoped.tools
      const caps: ReadCaps = { limit: readLimitOf(tools.get('read', agent)), maxLineLength: 2000, maxBytes: 50 * 1024 }
      const env = envFor(binding, caps)
      /**
       * 必须按「该 Agent 的视图」查内置工具：DSH 0.1.7 起内置工具注册在 preset 作用域（Agent 的祖先），
       * 不在全局层，tools.get(name) 不带作用域查不到 —— 曾因此一个工具也没接管，Agent 的 write 写到了本机。
       */
      const builtinOf = (name: string): ToolDefinitionLike | undefined => tools.get(name, agent)
      const taken: string[] = []
      const failed: string[] = []
      // 每一步单独 try：inject 回调里任何一处抛错，cordis 会回滚本回调里已做的全部注册。
      const step = (name: string, fn: () => boolean): void => {
        try {
          if (fn()) taken.push(name)
        } catch (error) {
          failed.push(name)
          deps.rt.log.error(binding.hostId, 'agent', `接管工具 ${name} 失败`, error)
        }
      }
      const wrap = (name: string, run: (args: never, exec: ToolExec) => Promise<unknown>): boolean => {
        const builtin = builtinOf(name)
        if (builtin === undefined) return false
        tools.register({
          ...builtin,
          execute: async (args: unknown, exec: unknown) => {
            guard(binding, exec as ToolExec)
            return await run(args as never, exec as ToolExec)
          }
        })
        return true
      }
      /**
       * 内置文件工具按路径分发（主机配置 allowLocalFiles）：
       * 路径指向本机（Windows 盘符 / UNC 且不在占位目录内）且开关打开 → 交还宿主内置实现（本机文件系统）；
       * 其余一律走远程管线 —— 默认（开关关闭）行为与旧版完全一致，本机路径照旧被 toRemotePath 拒绝。
       * 每次调用现读开关：保存主机后已打开的会话下一轮对话即按新配置生效，无需重建。
       */
      const wrapWithLocalFiles = (
        name: string,
        localPathOf: (args: never) => string | undefined,
        run: (args: never, exec: ToolExec) => Promise<unknown>
      ): boolean => {
        const builtin = builtinOf(name)
        if (builtin === undefined) return false
        tools.register({
          ...builtin,
          execute: async (args: unknown, exec: unknown) => {
            const p = localPathOf(args as never)
            if (p !== undefined && isLocalHostPath(binding, p) && safeKeepLocalFiles(deps, binding.hostId)) {
              return await builtin.execute(args, exec)
            }
            return await run(args as never, exec as ToolExec)
          }
        })
        return true
      }
      const filePathOf = (args: { file_path?: string }): string | undefined => args.file_path
      const searchPathOf = (args: { path?: string }): string | undefined => args.path
      step('read', () => wrapWithLocalFiles('read', filePathOf, (args, exec) => remoteRead(env, args, exec)))
      step('write', () => wrapWithLocalFiles('write', filePathOf, (args, exec) => remoteWrite(env, args, exec)))
      step('edit', () => wrapWithLocalFiles('edit', filePathOf, (args, exec) => remoteEdit(env, args, exec)))
      step('glob', () => wrapWithLocalFiles('glob', searchPathOf, (args, exec) => remoteGlob(env, args, exec)))
      step('grep', () => wrapWithLocalFiles('grep', searchPathOf, (args, exec) => remoteGrep(env, args, exec)))
      step('bash', () => {
        if (wrap('bash', (args, exec) => remoteBash(env, args, exec))) return true
        if (deps.defineTool === undefined) return false
        tools.register(deps.defineTool(remoteBashDefinition(binding, env, guard)))
        return true
      })
      // 本机 shell：按主机配置隐藏 / 保留，配置变化即时同步（见 mountLocalShells）。
      // 内置定义先取好：隐藏后再查可能查不到 / 查到遮蔽版本，恢复时要用原定义。
      try {
        const builtins = LOCAL_SHELLS.flatMap((n): Array<[string, ToolDefinitionLike]> => {
          const builtin = builtinOf(n)
          return builtin === undefined ? [] : [[n, builtin]]
        })
        const shells = mountLocalShells(agent, binding, tools, builtins)
        taken.push(...shells.hidden.map((n) => `hide ${n}`))
        failed.push(...shells.failed)
      } catch (error) {
        failed.push('local shells')
        deps.rt.log.error(binding.hostId, 'agent', '处理本机 shell 失败', error)
      }
      // 附件上传：宿主没有附件服务（旧版）或拿不到 defineTool 时不注册，不暴露一个必然失败的工具。
      step(UPLOAD_TOOL_NAME, () => {
        if (deps.defineTool === undefined || c.get('attachments') === undefined) return false
        const uploadDeps: UploadDeps = {
          attachments: () => c.get('attachments') as AttachmentService | undefined,
          audit: (level, message) => deps.rt.log[level](binding.hostId, 'agent', message)
        }
        tools.register(deps.defineTool(uploadToolDefinition(env, uploadDeps, (exec) => guard(binding, exec))))
        return true
      })
      // present：远程路径在宿主那里按本机文件系统校验必然失败。包装宿主定义（描述、render、卡片不变），
      // 缺 sessionProjections 或作用域不能挂监听时不接管，宿主原实现照常工作。
      step('present', () => {
        const builtin = builtinOf('present')
        const projections = c.get('sessionProjections') as TurnBoundarySource | undefined
        if (builtin === undefined || typeof projections?.stateOf !== 'function' || typeof scoped.on !== 'function') return false
        const present = createRemotePresent({
          binding,
          backend: env.backend,
          projections,
          builtinExecute: (args, exec) => builtin.execute(args, exec)
        })
        // tools/result 按 Agent 作用域分发（ToolRuntime.notifyResult 的 scopeTarget），宿主 present 也在这一层监听；
        // 挂在本 inject 作用域上，Agent 释放时随 fiber 一并撤下。
        scoped.on('tools/result', (exec: unknown, result: unknown) => {
          present.onResult(exec as PresentExec, result as { isError?: boolean } | undefined)
        })
        tools.register({
          ...builtin,
          execute: async (args: unknown, exec: unknown) => {
            guard(binding, exec as ToolExec)
            return await present.execute(args, exec as PresentExec)
          }
        })
        return true
      })
      deps.rt.log.info(
        binding.hostId,
        'agent',
        `远程会话已接管 Agent 工具：${taken.join(', ') || '无'}${failed.length > 0 ? `；失败：${failed.join(', ')}` : ''}（${binding.remotePath}，${agent.session.id ?? '?'}）`
      )
    })
    scopes.set(agent, fiber)
  }

  const detach = (agent: AgentLike): void => {
    const fiber = scopes.get(agent)
    if (fiber === undefined) return
    scopes.delete(agent)
    shellOffs.get(agent)?.()
    deps.localShellAgents?.delete(agent)
    openOffs.get(agent)?.()
    void fiber.dispose()
  }

  // 事件参数是 { agent, source }（dsh-agent 约定）；子代理与恢复的会话同样触发。
  const offCreated = c.on('agent/created', (payload: unknown) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    if (agent === undefined) return
    try {
      attach(agent)
    } catch (error) {
      deps.rt.log.error('', 'agent', '为远程会话注册 Agent 工具失败', error)
    }
  })
  const offDisposed = c.on('agent/disposed', (payload: unknown) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    if (agent !== undefined) detach(agent)
  })

  return () => {
    offCreated()
    offDisposed()
    for (const agent of [...scopes.keys()]) detach(agent)
  }
}

/** 读主机配置「保留本机 shell」；读取失败按默认（隐藏）处理 —— 这里绝不抛错，否则 cordis 会回滚本次 inject 里的全部注册。 */
function safeKeepLocalShell(deps: AgentToolsDeps, hostId: string): boolean {
  try {
    return deps.keepLocalShell?.(hostId) === true
  } catch (error) {
    deps.rt.log.error(hostId, 'agent', '读取主机配置 allowLocalShell 失败，按默认隐藏本机 shell', error)
    return false
  }
}

/** 读主机配置「允许本机文件读写」；读取失败按默认（关闭 → 走远程管线）处理，绝不抛错。 */
function safeKeepLocalFiles(deps: AgentToolsDeps, hostId: string): boolean {
  try {
    return deps.keepLocalFiles?.(hostId) === true
  } catch (error) {
    deps.rt.log.error(hostId, 'agent', '读取主机配置 allowLocalFiles 失败，按默认拒绝本机路径', error)
    return false
  }
}

/**
 * 系统提示词：只对远程会话输出内容，本地会话返回空串（dsh-remote issue #13 的教训）。
 * @param keepLocalShell 该主机配置了保留本机 shell：必须告诉模型 pwsh 等跑在本机，否则它会把本机结果当成服务器结果。
 * @param keepLocalFiles 该主机配置了允许本机文件读写：read 等内置文件工具的本机绝对路径（Windows 盘符 / UNC）直接作用于本机。
 */
export function remotePromptText(binding: RemoteBinding | undefined, hostLabel: string, keepLocalShell = false, keepLocalFiles = false): string {
  if (binding === undefined) return ''
  const localShell = keepLocalShell
    ? [
        // 写成「如果有」：调用方在拿不到会话实际状态时按主机配置判断，此时本机可能根本没有这些 shell（如 macOS / Linux）。
        `If pwsh / powershell / cmd tools are available in this session, they run on THIS computer, not on ${hostLabel}; their default working directory is the local placeholder ${binding.localPath}.`,
        'Use bash for anything about the remote workspace. Only use the local shells when the user explicitly needs this computer (comparing environments, local tools reaching services on the remote host, local files). They cannot see remote files; never treat their output as describing the remote host.'
      ]
    : []
  // 文件工具的路径口径随 allowLocalFiles 变化：关 = 一律远程；开 = 本机绝对路径（Windows 盘符 / UNC）走本机。
  const fileTools = keepLocalFiles
    ? 'The read, write, edit, glob and grep tools operate on that remote host by default: use POSIX paths (absolute or relative to the workspace root). A Windows absolute path such as C:\\... or \\\\server\\share points to THIS computer and is read / written locally — use it only when the user explicitly asks about files on this computer, and never mix local and remote paths in one call.'
    : 'The read, write, edit, glob, grep and bash tools operate on that remote host, not on this computer.'
  return [
    `This session's workspace is a remote SSH workspace on ${hostLabel}, rooted at ${binding.remotePath}.`,
    fileTools,
    `Use POSIX paths: absolute (e.g. ${binding.remotePath.replace(/\/+$/, '')}/src/main.ts) or relative to the workspace root.`,
    `The local directory ${binding.localPath} is only a placeholder that binds this session to the remote host; do not put project files there.`,
    'bash runs `bash -lc` on the remote host in a fresh shell each call (pass workdir instead of cd). run_in_background is unavailable; for long-running processes use `nohup <cmd> > /tmp/<name>.log 2>&1 &` and read the log.',
    'present accepts remote paths (absolute or relative to the workspace root); the delivery card opens a preview of the remote file in the sidebar. Files on this computer can still be presented, but not mixed with remote files in one call.',
    'Local files cannot be copied to the remote host by path. To put an image or file from this conversation (pasted by the user or produced by a tool) into the workspace, use upload_to_remote with its attachment id (sha256:…) and a path relative to the workspace root.',
    'Never run `git commit`, `git push`, `git reset --hard`, `git rebase` or other history-changing git commands on the remote host unless the user explicitly asks for that exact action in this conversation; leave changes uncommitted and tell the user.',
    ...localShell
  ].join('\n')
}

/** 本机没有内置 bash（Windows 上只有 pwsh）时的远程 bash 定义，契约与内置 bash 的前台结果一致。 */
function remoteBashDefinition(binding: RemoteBinding, env: RemoteToolEnv, guard: (b: RemoteBinding, e: ToolExec) => void): unknown {
  return {
    name: 'bash',
    description:
      'Execute a bash command (`bash -lc`) on the remote host of this workspace and return its stdout/stderr. Each call runs in a fresh shell; pass `workdir` instead of using `cd`. Long output is truncated to its tail.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).'
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 120000, capped at 600000; the command is killed on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the workspace root; a relative path is resolved against it.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          stdout: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } }
          },
          stderr: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } }
          }
        }
      },
      render: (_args: unknown, value: BashValue) => [{ type: 'text', text: renderBash(value) }]
    },
    async execute(args: unknown, exec: unknown) {
      guard(binding, exec as ToolExec)
      return await remoteBash(env, args as never, exec as ToolExec)
    },
    presentCall(args: { command?: string; description?: string }) {
      return { card: 'generic', title: args.description ?? args.command ?? 'bash', kind: 'execute', rawInput: args.command }
    }
  }
}
