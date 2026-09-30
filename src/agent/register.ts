/*
 * @Description: 为远程会话的 Agent 注册同名工具（遮蔽内置实现），本地会话完全不受影响
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/register.ts
 *
 * 机制（已用真实 ToolRuntime 验证，见 shadow.test.ts）：
 *   agent/created → 会话 cwd 反查绑定 → 是远程工作区才在该 Agent 的作用域注册同名工具。
 *   注册的定义 = 内置定义（参数、输出 schema、render、界面卡片原样保留）+ 替换后的 execute。
 *   本地会话不注册任何东西 → 工具清单与行为与未安装本插件时完全相同。
 *
 * 不用全局「当前主机」路由：dsh-remote 曾因此把 A 会话的命令打到 B 会话的机器上（其 issue #25）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceRuntime } from '../runtime.js'
import type { BindingStore, RemoteBinding } from '../workspace/bindings.js'
import { pathKey } from '../workspace/bindings.js'
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
  ctx: { inject(deps: string[], callback: (c: { tools: ScopedTools }) => void): { dispose(): unknown } }
  session: { id?: string; header: { cwd?: string } }
}

/** 本地 shell 工具：远程会话里必须隐藏，否则模型可能在本机执行命令。 */
const LOCAL_SHELLS = ['pwsh', 'powershell', 'cmd']

export interface AgentToolsDeps {
  rt: WorkspaceRuntime
  bindings: BindingStore
  preimages: PreimageStore
  /** 测试替身：自定义后端（默认 SSH）。 */
  backendFor?: (binding: RemoteBinding) => AgentBackend
  /** 本机没有内置 bash 时用来定义远程 bash（运行时从宿主取 @deepseek-ai/dsh-tools 的 defineTool）。 */
  defineTool?: (definition: unknown) => unknown
}

/**
 * 从内置 read 的参数说明里取默认行数（render 依赖它，两边必须一致）。
 *
 * 不能对整个 parameters 取「第一个 Defaults to N.」：内置 read 的 offset 说明是
 * 「1-based first line to return. Defaults to 1.」，且 offset 排在 limit 之前，
 * 于是抓到的是 1 —— 远程 read 每次只返回一行，且 limit 参数一律被拒
 * （limit must be less than or equal to 1）。这里先把范围收缩到 limit 属性本身。
 */
export function readLimitOf(builtin: ToolDefinitionLike | undefined): number {
  const text = JSON.stringify(builtin?.parameters ?? {})
  const scoped = /"limit"\s*:\s*\{/.exec(text)
  const match = /Defaults to (\d+)\./.exec(scoped === null ? text : text.slice(scoped.index))
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

  const attach = (agent: AgentLike): void => {
    if (scopes.has(agent)) return
    const binding = deps.bindings.resolve(agent.session?.header?.cwd)
    if (binding === undefined) return

    const fiber = agent.ctx.inject(['tools'], (scoped) => {
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
      step('read', () => wrap('read', (args, exec) => remoteRead(env, args, exec)))
      step('write', () => wrap('write', (args, exec) => remoteWrite(env, args, exec)))
      step('edit', () => wrap('edit', (args, exec) => remoteEdit(env, args, exec)))
      step('glob', () => wrap('glob', (args, exec) => remoteGlob(env, args, exec)))
      step('grep', () => wrap('grep', (args, exec) => remoteGrep(env, args, exec)))
      step('bash', () => {
        if (wrap('bash', (args, exec) => remoteBash(env, args, exec))) return true
        if (deps.defineTool === undefined) return false
        tools.register(deps.defineTool(remoteBashDefinition(binding, env, guard)))
        return true
      })
      // 本机 shell：优先从清单里去掉；去不掉就用同名的拒绝版本遮蔽，绝不让它在本机执行。
      for (const name of LOCAL_SHELLS.filter((n) => builtinOf(n) !== undefined)) {
        step(`hide ${name}`, () => {
          try {
            tools.restrict({ deny: [name] })
          } catch {
            const builtin = builtinOf(name) as ToolDefinitionLike
            tools.register({
              ...builtin,
              execute: async () => {
                throw new Error(`${name} is not available in a remote workspace (it would run on the local computer); use bash, which runs on the remote host`)
              }
            })
          }
          return true
        })
      }
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

/** 系统提示词：只对远程会话输出内容，本地会话返回空串（dsh-remote issue #13 的教训）。 */
export function remotePromptText(binding: RemoteBinding | undefined, hostLabel: string): string {
  if (binding === undefined) return ''
  return [
    `This session's workspace is a remote SSH workspace on ${hostLabel}, rooted at ${binding.remotePath}.`,
    'The read, write, edit, glob, grep and bash tools operate on that remote host, not on this computer.',
    `Use POSIX paths: absolute (e.g. ${binding.remotePath.replace(/\/+$/, '')}/src/main.ts) or relative to the workspace root.`,
    `The local directory ${binding.localPath} is only a placeholder that binds this session to the remote host; do not put project files there.`,
    'bash runs `bash -lc` on the remote host in a fresh shell each call (pass workdir instead of cd). run_in_background is unavailable; for long-running processes use `nohup <cmd> > /tmp/<name>.log 2>&1 &` and read the log.',
    'Never run `git commit`, `git push`, `git reset --hard`, `git rebase` or other history-changing git commands on the remote host unless the user explicitly asks for that exact action in this conversation; leave changes uncommitted and tell the user.'
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
