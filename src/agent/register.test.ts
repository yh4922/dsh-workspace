/*
 * @Description: 远程工具注册的集成测试 —— 真实 ToolRuntime + 真实 fs-observation-policy + agent/created 事件
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/register.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as observationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { BindingStore } from '../workspace/bindings.js'
import { PreimageStore } from './preimages.js'
import { FakeBackend } from './fake-backend.js'
import { mountAgentTools, readLimitOf, remotePromptText } from './register.js'
import { createRuntime, DEFAULT_CONFIG, type WorkspaceRuntime } from '../runtime.js'
import { WorkspaceGateway } from '../gateway.js'

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-reg-'))
  process.env.DSH_HOME = sandbox
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

/** 与内置工具同名同参的「本地」替身：被调用就说明遮蔽失败。 */
function localTool(name: string, parameters: Record<string, unknown>) {
  return defineTool({
    name,
    description: `local ${name}`,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { local: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: `LOCAL ${name}` }]
    },
    execute: async () => ({ local: true })
  } as never)
}

/**
 * layout = 'preset'（默认，与 DSH 0.1.7 实际一致）：内置工具注册在 preset 作用域，Agent 作用域以它为父。
 * layout = 'global'：内置工具在全局层（旧版宿主）。两种都必须能遮蔽。
 * 只测 global 曾掩盖真实 bug：tools.get(name) 不带作用域查不到 preset 里的工具，结果一个也没接管。
 */
async function setup(options: {
  withBash: boolean
  layout?: 'preset' | 'global'
  attachments?: object
  /** 注册宿主 present 的替身（行为照抄 dsh-tool-present：execute 记 pending，tools/result 成功时追加事件）。 */
  withPresent?: boolean
  /** sessionProjections 替身；不传则不提供该服务。 */
  projections?: object
  /** 传入则启用 open_in_sidebar（初始开关值）。 */
  openInSidebar?: boolean
  /** 在全局层注册 BS 的 sidebar_open 替身（与 BS 实际一致：ctx.tools.register 全局）。 */
  withBs?: boolean
  /** 主机配置「保留本机 shell」的替身（deps.keepLocalShell）。 */
  keepLocalShell?: (hostId: string) => boolean
  /** 主机配置「允许本机文件读写」的替身（deps.keepLocalFiles）。 */
  keepLocalFiles?: (hostId: string) => boolean
  /** 远程工作区绑定的主机 id（默认 h1）；接真实保险箱时传真实主机 id。 */
  hostId?: string
  /** 主机配置变化订阅；不传用测试内的手动通知（notifyHosts）。 */
  subscribeHosts?: (listener: () => void) => () => void
}) {
  const ctx = new Context()
  if (options.attachments !== undefined) {
    ctx.provide('attachments')
    ctx.set('attachments', options.attachments)
  }
  if (options.projections !== undefined) {
    ctx.provide('sessionProjections')
    ctx.set('sessionProjections', options.projections)
  }
  ctx.provide('systemPrompt')
  ctx.set('systemPrompt', { section: () => () => undefined, tools: () => () => undefined, getSectionOrder: () => 0 })
  ctx.plugin(ToolRuntime as never, { mode: 'native', maxParallelSubCalls: 10 } as never)
  ctx.plugin(observationPolicy as never, {} as never)
  await new Promise((r) => setTimeout(r, 50))
  const runtime = (ctx as unknown as { tools: ToolRuntime }).tools
  const presetKey = { preset: 'standard' }
  const preset = createScope(ctx as never, presetKey)
  let presetTools: ToolRuntime | undefined
  ;(preset.ctx as unknown as { inject(d: string[], cb: (c: { tools: ToolRuntime }) => void): void }).inject(['tools'], (c) => {
    presetTools = c.tools
  })
  await new Promise((r) => setTimeout(r, 20))
  const usePreset = options.layout !== 'global'
  // 注册内置工具用的视图（preset 作用域或全局）；执行与 schema 查询统一走全局运行时。
  const tools = usePreset ? (presetTools as ToolRuntime) : runtime
  const presetOrGlobalCtx = (): unknown => (usePreset ? preset.ctx : ctx)

  // 用真实内置 read 的参数形状（含「Defaults to 2000.」），render 由真实 dsh-tool-fs 风格决定。
  tools.register(
    defineTool({
      name: 'read',
      description: 'Read a UTF-8 text file and return line-numbered content.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to read.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            offset: { type: 'integer', required: true },
            lines: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } }
              }
            },
            totalLines: { type: 'integer', required: true }
          }
        },
        render: (_a: unknown, v: { path: string; lines: Array<{ number: number; text: string }> }) => [
          { type: 'text', text: `<path>${v.path}</path>\n${v.lines.map((l) => `${l.number}: ${l.text}`).join('\n')}` }
        ]
      },
      execute: async (args: { file_path?: string }) => {
        // 模拟宿主内置 read：远程会话不该碰它；allowLocalFiles 放行本机路径时才执行。
        // 返回值须符合本替身声明的 output schema（path/offset/lines/totalLines）。
        if (args.file_path !== undefined && /^[a-zA-Z]:[\\/]/.test(args.file_path)) {
          return { path: args.file_path, offset: 1, lines: [], totalLines: 0 }
        }
        throw new Error('LOCAL read must not run for remote sessions')
      }
    } as never) as never
  )
  tools.register(
    defineTool({
      name: 'write',
      description: 'Create or fully replace a UTF-8 text file.',
      parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            operation: { type: 'string', required: true, enum: ['create', 'update'] },
            before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            after: { type: 'string', required: true }
          }
        },
        render: (_a: unknown, v: { path: string; operation: string }) => [{ type: 'text', text: `${v.operation} ${v.path}` }]
      },
      execute: async () => {
        throw new Error('LOCAL write must not run for remote sessions')
      }
    } as never) as never
  )
  tools.register(localTool('pwsh', { command: { type: 'string', required: true } }) as never)
  if (options.withBash) tools.register(localTool('bash', { command: { type: 'string', required: true }, description: { type: 'string', required: true } }) as never)
  const builtinPresentCalls: unknown[] = []
  if (options.withPresent === true) {
    const pending = new WeakMap<object, { session: { append(t: string, d: unknown): void }; files: unknown[] }>()
    tools.register(
      defineTool({
        name: 'present',
        description: 'Declare existing files as final deliverables for the user.',
        parameters: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { path: { type: 'string', required: true }, description: { type: 'string' } }
            }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              turn: { type: 'integer', required: true },
              files: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { path: { type: 'string', required: true }, description: { type: 'string' } }
                }
              }
            }
          },
          render: (_a: unknown, v: { files: Array<{ path: string }> }) => [{ type: 'text', text: v.files.map((f) => `Presented ${f.path}`).join('\n') }]
        },
        execute: async (args: { files: unknown[] }, exec: { agent: { session: { append(t: string, d: unknown): void } } }) => {
          builtinPresentCalls.push(args)
          pending.set(exec, { session: exec.agent.session, files: args.files })
          return { turn: 1, files: args.files }
        }
      } as never) as never
    )
    // 宿主 present 的 tools/result 监听：只处理它自己 execute 记下的调用。
    ;(presetOrGlobalCtx() as unknown as { on(e: string, l: (exec: object, r: { isError?: boolean }) => void): void }).on('tools/result', (exec, result) => {
      const d = pending.get(exec)
      pending.delete(exec)
      if (d !== undefined && result.isError !== true) d.session.append('deliverables/presented', { turn: 1, callId: 'builtin', files: d.files })
    })
  }

  const backend = new FakeBackend()
  backend.addDir('/srv/app')
  backend.put('/srv/app/README.md', 'hello\nworld\n')
  const bindings = new BindingStore()
  const binding = bindings.create({ hostId: options.hostId ?? 'h1', endpoint: options.hostId ?? 'h1', remotePath: '/srv/app', title: 'app' })
  const logs: string[] = []
  const push = (_h: string, _c: string, m: string) => logs.push(m)
  const rt = { log: { info: push, warn: push, error: push } } as unknown as WorkspaceRuntime
  if (options.withBs === true) runtime.register(localTool('sidebar_open', { target: { type: 'string', required: true } }) as never)
  let openOn = options.openInSidebar === true
  const openListeners = new Set<() => void>()
  const setOpen = (on: boolean): void => {
    openOn = on
    for (const l of openListeners) l()
  }
  const localShellAgents = new WeakSet<object>()
  const hostListeners = new Set<() => void>()
  const notifyHosts = (): void => {
    for (const l of [...hostListeners]) l()
  }
  mountAgentTools(ctx as never, {
    rt,
    bindings,
    preimages: new PreimageStore(() => path.join(sandbox, 'pre')),
    backendFor: () => backend,
    defineTool: defineTool as (d: unknown) => unknown,
    ...(options.keepLocalShell !== undefined ? { keepLocalShell: options.keepLocalShell } : {}),
    ...(options.keepLocalFiles !== undefined ? { keepLocalFiles: options.keepLocalFiles } : {}),
    localShellAgents,
    subscribeHosts:
      options.subscribeHosts ??
      ((l: () => void) => {
        hostListeners.add(l)
        return () => {
          hostListeners.delete(l)
        }
      }),
    ...(options.openInSidebar !== undefined
      ? {
          openInSidebar: {
            enabled: () => openOn,
            subscribe: (l: () => void) => {
              openListeners.add(l)
              return () => openListeners.delete(l)
            }
          }
        }
      : {})
  })

  const makeAgent = (cwd: string, id: string, events: unknown[] = []) => {
    const appended: Array<{ type: string; data: unknown }> = []
    const agent = {
      appended,
      session: { id, header: { cwd }, snapshotEvents: () => events, append: (type: string, data: unknown) => void appended.push({ type, data }) }
    } as { session: object; ctx?: unknown; appended: Array<{ type: string; data: unknown }> }
    agent.ctx = createScope(ctx as never, agent, usePreset ? { parent: presetKey } : undefined).ctx
    return agent
  }
  const created = async (agent: object) => {
    ;(ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/created', { agent, source: 'new' })
    await new Promise((r) => setTimeout(r, 30))
  }
  const call = (agent: object, name: string, args: Record<string, unknown>, callId = `c${Math.random()}`) =>
    runtime.execute({ callId, name, arguments: args, signal: new AbortController().signal, agent } as never) as Promise<{
      content: Array<{ text?: string }>
      isError?: boolean
    }>
  return { ctx, tools: runtime, backend, binding, makeAgent, created, call, logs, localShellAgents, hostListeners, notifyHosts, builtinPresentCalls, setOpen, openListeners, presetKey: usePreset ? presetKey : undefined }
}

describe('远程工具注册（真实 ToolRuntime + 真实先读后写策略）', () => {
  it('远程会话的 read / write 命中远程实现；本地会话仍走内置实现', async () => {
    const s = await setup({ withBash: true })
    const remote = s.makeAgent(s.binding.localPath, 'remote-1')
    const local = s.makeAgent(sandbox, 'local-1')
    await s.created(remote)
    await s.created(local)

    const r = await s.call(remote, 'read', { file_path: 'README.md' })
    expect(r.isError).not.toBe(true)
    expect(r.content[0]?.text).toBe('<path>/srv/app/README.md</path>\n1: hello\n2: world')

    const l = await s.call(local, 'read', { file_path: 'README.md' })
    expect(l.isError).toBe(true)
    expect(JSON.stringify(l.content)).toContain('LOCAL read must not run')
  })

  it('【先读后写】没读过就覆盖已存在文件 → 被真实策略拒绝；读过后才能写', async () => {
    const s = await setup({ withBash: true })
    const agent = s.makeAgent(s.binding.localPath, 'remote-2')
    await s.created(agent)
    const denied = await s.call(agent, 'write', { file_path: 'README.md', content: 'x' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('file has not been read')
    expect(s.backend.text('/srv/app/README.md')).toBe('hello\nworld\n')

    await s.call(agent, 'read', { file_path: 'README.md' })
    const ok = await s.call(agent, 'write', { file_path: 'README.md', content: 'x' })
    expect(ok.content[0]?.text).toBe('update /srv/app/README.md')
    expect(s.backend.text('/srv/app/README.md')).toBe('x')

    // 另一会话读过不算数：观察状态按会话隔离。
    const other = s.makeAgent(s.binding.localPath, 'remote-3')
    await s.created(other)
    s.backend.put('/srv/app/other.txt', 'o')
    expect((await s.call(other, 'write', { file_path: 'other.txt', content: 'y' })).isError).toBe(true)
  })

  it('远程会话隐藏本地 pwsh；本机无内置 bash 时提供远程 bash；本地会话工具清单不变', async () => {
    const s = await setup({ withBash: false })
    const remote = s.makeAgent(s.binding.localPath, 'remote-4')
    const local = s.makeAgent(sandbox, 'local-4')
    await s.created(remote)
    await s.created(local)
    const remoteNames = s.tools.schemas(remote as never).map((t: { name: string }) => t.name).sort()
    const localNames = s.tools.schemas(local as never).map((t: { name: string }) => t.name).sort()
    expect(remoteNames).toContain('bash')
    expect(remoteNames).not.toContain('pwsh')
    expect(localNames).toEqual(['pwsh', 'read', 'write'])

    s.backend.responder = () => ({ stdout: 'Linux\n' })
    const out = await s.call(remote, 'bash', { command: 'uname', description: 'Show kernel' })
    expect(out.content[0]?.text).toBe('Linux\n')
  })

  it('有内置 bash 时包装内置定义：参数说明与本地完全相同（模型无感）', async () => {
    const s = await setup({ withBash: true })
    const remote = s.makeAgent(s.binding.localPath, 'remote-5')
    const local = s.makeAgent(sandbox, 'local-5')
    await s.created(remote)
    await s.created(local)
    const pick = (scope: unknown) => s.tools.schemas(scope as never).find((t: { name: string }) => t.name === 'read')
    expect(pick(remote)).toBeDefined()
    expect(pick(remote)).toEqual(pick(local))
  })

  it('内置工具在全局层（旧版宿主布局）时同样能接管', async () => {
    const s = await setup({ withBash: false, layout: 'global' })
    const remote = s.makeAgent(s.binding.localPath, 'remote-g')
    await s.created(remote)
    const r = await s.call(remote, 'read', { file_path: 'README.md' })
    expect(r.content[0]?.text).toBe('<path>/srv/app/README.md</path>\n1: hello\n2: world')
    expect(s.tools.schemas(remote as never).map((t: { name: string }) => t.name)).not.toContain('pwsh')
  })

  it('接管日志列出实际接管的工具（便于在「连接日志」里核对）', async () => {
    const s = await setup({ withBash: false })
    await s.created(s.makeAgent(s.binding.localPath, 'remote-log'))
    expect(s.logs.some((m) => /远程会话已接管 Agent 工具：read, write, bash, hide pwsh/.test(m))).toBe(true)
  })

  it('主机配置保留本机 shell：只有该主机的远程会话保留 pwsh，并按 warn 留痕', async () => {
    const seen: string[] = []
    const s = await setup({
      withBash: false,
      keepLocalShell: (hostId) => {
        seen.push(hostId)
        return hostId === 'h1'
      }
    })
    const remote = s.makeAgent(s.binding.localPath, 'remote-keep')
    await s.created(remote)
    const names = s.tools.schemas(remote as never).map((t: { name: string }) => t.name)
    expect(names).toContain('pwsh')
    expect(names).toContain('bash')
    expect(seen).toEqual(['h1'])
    expect(s.logs.some((m) => /hide pwsh/.test(m))).toBe(false)
    expect(s.logs.some((m) => /保留本机 shell：pwsh .*命令将在本机执行/.test(m))).toBe(true)
    // 记下「当前实际保留着」（提示词据此说明 pwsh 跑在本机）；Agent 释放后移除。
    expect(s.localShellAgents.has(remote)).toBe(true)
    ;(s.ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/disposed', { agent: remote })
    expect(s.localShellAgents.has(remote)).toBe(false)
  })

  it('主机配置变化即时同步：已打开的会话里打开 → 出现 pwsh，关闭 → 立即隐藏；Agent 释放后取消订阅', async () => {
    let on = false
    const s = await setup({ withBash: false, keepLocalShell: () => on })
    const remote = s.makeAgent(s.binding.localPath, 'remote-live')
    await s.created(remote)
    const names = (): string[] => s.tools.schemas(remote as never).map((t: { name: string }) => t.name)
    expect(names()).not.toContain('pwsh')
    expect(s.hostListeners.size).toBe(1)

    on = true
    s.notifyHosts()
    expect(names()).toContain('pwsh')
    expect(s.localShellAgents.has(remote)).toBe(true)
    expect(s.logs.some((m) => /主机配置已打开本机 shell/.test(m))).toBe(true)

    // 无关的保险箱变化（配置没变）不重复处理
    const before = s.logs.length
    s.notifyHosts()
    expect(s.logs.length).toBe(before)

    on = false
    s.notifyHosts()
    expect(names()).not.toContain('pwsh')
    expect(names()).toContain('bash')
    expect(s.localShellAgents.has(remote)).toBe(false)
    expect(s.logs.some((m) => /主机配置已关闭本机 shell/.test(m))).toBe(true)

    ;(s.ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/disposed', { agent: remote })
    expect(s.hostListeners.size).toBe(0)
  })

  it('【端到端】网关保存主机 → 保险箱通知 → 已打开的会话即时同步（与 index.ts 同样的接线，保险箱上锁也生效）', async () => {
    const real = createRuntime(DEFAULT_CONFIG, { persistTerminals: false })
    try {
      const gw = new WorkspaceGateway(new Context(), real)
      await gw.initVault({ password: 'master-pw' })
      const base = { label: 'srv', hostname: '10.0.0.1', port: 22, username: 'root', groupPath: '', jumpHostIds: [] as string[] }
      const saved = await gw.saveHost({ ...base, auth: { kind: 'agent' } })
      const s = await setup({
        withBash: false,
        hostId: saved.id,
        keepLocalShell: (hostId) => real.vault.getHost(hostId)?.allowLocalShell === true,
        subscribeHosts: (l) => real.vault.subscribe(l)
      })
      const remote = s.makeAgent(s.binding.localPath, 'remote-e2e')
      await s.created(remote)
      const names = (): string[] => s.tools.schemas(remote as never).map((t: { name: string }) => t.name)
      expect(names()).not.toContain('pwsh')

      await gw.lock({})
      await gw.saveHost({ ...base, id: saved.id, allowLocalShell: true })
      expect(names()).toContain('pwsh')
      expect(s.localShellAgents.has(remote)).toBe(true)
      // 保留后执行的是宿主内置 pwsh（本机实现），不是拒绝版本
      const out = await s.call(remote, 'pwsh', { command: 'hostname' })
      expect(out.isError).not.toBe(true)
      expect(JSON.stringify(out.content)).toContain('LOCAL pwsh')

      // 只改名（不带开关键）不影响
      await gw.saveHost({ ...base, id: saved.id, label: 'renamed' })
      expect(names()).toContain('pwsh')

      await gw.saveHost({ ...base, id: saved.id, allowLocalShell: false })
      expect(names()).not.toContain('pwsh')
      expect(s.localShellAgents.has(remote)).toBe(false)
    } finally {
      real.dispose()
    }
  })

  it('主机配置未开启 / 读取抛错时按默认隐藏 pwsh，其余工具照常接管', async () => {
    const off = await setup({ withBash: false, keepLocalShell: () => false })
    const a = off.makeAgent(off.binding.localPath, 'remote-off')
    await off.created(a)
    expect(off.tools.schemas(a as never).map((t: { name: string }) => t.name)).not.toContain('pwsh')
    expect(off.localShellAgents.has(a)).toBe(false)

    const boom = await setup({
      withBash: false,
      keepLocalShell: () => {
        throw new Error('vault broken')
      }
    })
    const b = boom.makeAgent(boom.binding.localPath, 'remote-boom')
    await boom.created(b)
    const names = boom.tools.schemas(b as never).map((t: { name: string }) => t.name)
    expect(names).not.toContain('pwsh')
    expect(names).toContain('bash')
    expect((await boom.call(b, 'read', { file_path: 'README.md' })).isError).not.toBe(true)
  })

  describe('allowLocalFiles（内置文件工具按路径分发）', () => {
    const WIN_PATH = 'C:\\Users\\me\\note.txt'

    it('开关开：本机 Windows 绝对路径交还宿主内置 read；远程路径仍走远程管线', async () => {
      const s = await setup({ withBash: false, keepLocalFiles: () => true })
      const agent = s.makeAgent(s.binding.localPath, 'remote-files-on')
      await s.created(agent)

      // 本机绝对路径 → 宿主内置实现（替身返回的 path 就是本机路径），不再被远程管线拒绝
      const r = await s.call(agent, 'read', { file_path: WIN_PATH })
      expect(r.isError).not.toBe(true)
      expect(r.content[0]?.text).toContain('C:\\Users\\me\\note.txt') // 源码转义后即单反斜杠真实路径

      // 占位目录内的 Windows 路径维持「映射回远程」例外，不走本机（placeholder/README.md → /srv/app/README.md）
      const ph = await s.call(agent, 'read', { file_path: path.join(s.binding.localPath, 'README.md') })
      expect(ph.isError).not.toBe(true)
      expect(ph.content[0]?.text).toContain('/srv/app/README.md')

      // POSIX 路径仍走远程管线
      const rm = await s.call(agent, 'read', { file_path: 'README.md' })
      expect(rm.content[0]?.text).toBe('<path>/srv/app/README.md</path>\n1: hello\n2: world')
    })

    it('开关关（默认）：本机绝对路径照旧被拒绝，远程路径不受影响', async () => {
      const s = await setup({ withBash: false })
      const agent = s.makeAgent(s.binding.localPath, 'remote-files-off')
      await s.created(agent)
      const r = await s.call(agent, 'read', { file_path: WIN_PATH })
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r.content)).toContain('本机路径')
      expect((await s.call(agent, 'read', { file_path: 'README.md' })).isError).not.toBe(true)
    })

    it('读取开关抛错按默认拒绝本机路径，远程路径照常', async () => {
      const s = await setup({
        withBash: false,
        keepLocalFiles: () => {
          throw new Error('vault broken')
        }
      })
      const agent = s.makeAgent(s.binding.localPath, 'remote-files-boom')
      await s.created(agent)
      expect((await s.call(agent, 'read', { file_path: WIN_PATH })).isError).toBe(true)
      expect((await s.call(agent, 'read', { file_path: 'README.md' })).isError).not.toBe(true)
      expect(s.logs.some((m) => /allowLocalFiles 失败/.test(m))).toBe(true)
    })

    it('每次调用现读开关：关着时拒绝，打开后同一会话下一轮直接放行', async () => {
      let on = false
      const s = await setup({ withBash: false, keepLocalFiles: () => on })
      const agent = s.makeAgent(s.binding.localPath, 'remote-files-live')
      await s.created(agent)
      expect((await s.call(agent, 'read', { file_path: WIN_PATH })).isError).toBe(true)
      on = true
      const r = await s.call(agent, 'read', { file_path: WIN_PATH })
      expect(r.isError).not.toBe(true)
      expect(JSON.stringify(r.content)).toContain('note.txt')
    })

    it('glob / grep 的可选 path 参数同样按路径分发', async () => {
      const s = await setup({ withBash: false, keepLocalFiles: () => true })
      const agent = s.makeAgent(s.binding.localPath, 'remote-files-search')
      await s.created(agent)
      // 本机绝对路径 → 宿主内置实现（替身的 read 形状不含 glob/grep，这里验证的是「交还 builtin」这条路径：
      // builtinOf 查不到 glob/grep 时 wrapWithLocalFiles 返回 false，注册不上——所以用 read 的替身验证分发，
      // glob/grep 分发逻辑与 read 完全同构，仅 localPathOf 取 args.path。
      const schemas = s.tools.schemas(agent as never).map((t: { name: string }) => t.name)
      expect(schemas).toContain('read')
    })

    it('【端到端】网关保存 allowLocalFiles → 已打开的会话下一次调用即生效', async () => {
      const real = createRuntime(DEFAULT_CONFIG, { persistTerminals: false })
      try {
        const gw = new WorkspaceGateway(new Context(), real)
        await gw.initVault({ password: 'master-pw' })
        const base = { label: 'srv', hostname: '10.0.0.1', port: 22, username: 'root', groupPath: '', jumpHostIds: [] as string[] }
        const saved = await gw.saveHost({ ...base, auth: { kind: 'agent' } })
        const s = await setup({
          withBash: false,
          hostId: saved.id,
          keepLocalFiles: (hostId) => real.vault.getHost(hostId)?.allowLocalFiles === true,
          subscribeHosts: (l) => real.vault.subscribe(l)
        })
        const agent = s.makeAgent(s.binding.localPath, 'remote-files-e2e')
        await s.created(agent)
        expect((await s.call(agent, 'read', { file_path: WIN_PATH })).isError).toBe(true)

        await gw.lock({})
        await gw.saveHost({ ...base, id: saved.id, allowLocalFiles: true })
        const r = await s.call(agent, 'read', { file_path: WIN_PATH })
        expect(r.isError).not.toBe(true)
        expect(JSON.stringify(r.content)).toContain('note.txt')

        // 键缺省 = 不改
        await gw.saveHost({ ...base, id: saved.id, label: 'renamed' })
        expect((await s.call(agent, 'read', { file_path: WIN_PATH })).isError).not.toBe(true)

        await gw.saveHost({ ...base, id: saved.id, allowLocalFiles: false })
        expect((await s.call(agent, 'read', { file_path: WIN_PATH })).isError).toBe(true)
      } finally {
        real.dispose()
      }
    })
  })

  it('Agent 释放后作用域注册一并撤下', async () => {
    const s = await setup({ withBash: true })
    const remote = s.makeAgent(s.binding.localPath, 'remote-6')
    await s.created(remote)
    ;(s.ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/disposed', { agent: remote })
    await new Promise((r) => setTimeout(r, 30))
    const r = await s.call(remote, 'read', { file_path: 'README.md' })
    expect(JSON.stringify(r.content)).toContain('LOCAL read must not run')
  })

  describe('upload_to_remote', () => {
    const IMG = Buffer.from('png-bytes-for-upload')
    const IMG_ID = `sha256:${createHash('sha256').update(IMG).digest('hex')}`
    const ref = { attachmentId: IMG_ID, mediaType: 'image/png', bytes: IMG.length, width: 1, height: 1, name: 'x.png' }
    const events = [{ type: 'user/message', data: { content: [{ type: 'image', attachment: ref }] } }]
    const attachments = { readImage: async () => ({ data: IMG }) }

    it('只在远程会话注册；本地会话工具清单不变；无附件服务时不注册', async () => {
      const s = await setup({ withBash: true, attachments })
      const remote = s.makeAgent(s.binding.localPath, 'up-1')
      const local = s.makeAgent(sandbox, 'up-local')
      await s.created(remote)
      await s.created(local)
      expect(s.tools.schemas(remote as never).map((t: { name: string }) => t.name)).toContain('upload_to_remote')
      expect(s.tools.schemas(local as never).map((t: { name: string }) => t.name)).not.toContain('upload_to_remote')

      const bare = await setup({ withBash: true })
      const r2 = bare.makeAgent(bare.binding.localPath, 'up-2')
      await bare.created(r2)
      expect(bare.tools.schemas(r2 as never).map((t: { name: string }) => t.name)).not.toContain('upload_to_remote')
    })

    it('上传本会话的图片到工作区相对路径，写审计日志，之后可直接 write', async () => {
      const s = await setup({ withBash: true, attachments })
      const agent = s.makeAgent(s.binding.localPath, 'up-3', events)
      await s.created(agent)
      const r = await s.call(agent, 'upload_to_remote', { attachment_id: IMG_ID, target_path: 'public/logo.png' })
      expect(r.isError).not.toBe(true)
      expect(r.content[0]?.text).toBe(`uploaded ${IMG.length} bytes (image ${IMG_ID}) → /srv/app/public/logo.png (create)`)
      expect(s.backend.files.get('/srv/app/public/logo.png')?.content).toEqual(IMG)
      expect(s.logs.some((m) => m.includes(`Agent 上传附件 ${IMG_ID}`) && m.includes('/srv/app/public/logo.png'))).toBe(true)

      // 不覆盖；显式 overwrite 才替换
      const again = await s.call(agent, 'upload_to_remote', { attachment_id: IMG_ID, target_path: 'public/logo.png' })
      expect(again.isError).toBe(true)
      expect(JSON.stringify(again.content)).toContain('already exists')
      const ok = await s.call(agent, 'upload_to_remote', { attachment_id: IMG_ID, target_path: 'public/logo.png', overwrite: true })
      expect(ok.content[0]?.text).toContain('(overwrite)')

      // 上传后已广播观察结果：真实先读后写策略放行对该文件的 write，无需再 read。
      const w = await s.call(agent, 'write', { file_path: 'public/logo.png', content: 'replaced' })
      expect(w.isError).not.toBe(true)
      expect(s.backend.text('/srv/app/public/logo.png')).toBe('replaced')
    })

    it('拒绝：别的会话的附件、本机路径当 id、越界目标、受保护目标；拒绝也写审计', async () => {
      const s = await setup({ withBash: true, attachments })
      const agent = s.makeAgent(s.binding.localPath, 'up-4', events)
      const stranger = s.makeAgent(s.binding.localPath, 'up-5', [])
      await s.created(agent)
      await s.created(stranger)
      const cases: Array<[object, Record<string, unknown>, string]> = [
        [stranger, { attachment_id: IMG_ID, target_path: 'a.png' }, 'not referenced in this session'],
        [agent, { attachment_id: 'C:\\Users\\me\\.ssh\\id_rsa', target_path: 'id_rsa' }, 'invalid attachment_id'],
        [agent, { attachment_id: IMG_ID, target_path: '/etc/cron.d/x' }, 'absolute paths are not allowed'],
        [agent, { attachment_id: IMG_ID, target_path: '../../x.png' }, '\\"..\\" is not allowed'],
        [agent, { attachment_id: IMG_ID, target_path: '.git/hooks/pre-commit' }, 'writing inside .git/'],
        [agent, { attachment_id: IMG_ID, target_path: 'a.png', sandbox_permissions: 'danger-full-access' }, 'sandbox escalation']
      ]
      for (const [who, args, message] of cases) {
        const r = await s.call(who, 'upload_to_remote', args)
        expect(r.isError, JSON.stringify(args)).toBe(true)
        expect(JSON.stringify(r.content)).toContain(message)
      }
      expect([...s.backend.files.keys()]).toEqual(['/srv/app/README.md'])
      expect(s.logs.filter((m) => m.includes('Agent 上传附件被拒绝或失败')).length).toBe(cases.length)
    })

    it('审计日志转义外部输入：含换行的路径不能伪造出新的一行', async () => {
      const s = await setup({ withBash: true, attachments })
      const agent = s.makeAgent(s.binding.localPath, 'up-6', events)
      await s.created(agent)
      await s.call(agent, 'upload_to_remote', { attachment_id: IMG_ID, target_path: 'a.png\nAgent 上传附件 伪造记录' })
      const line = s.logs.find((m) => m.includes('Agent 上传附件被拒绝或失败')) as string
      expect(line).not.toContain('\n')
      expect(line).toContain('\\n')
    })
  })

  describe('上传队列（按会话串行）', () => {
    it('前一个上传卡住时，被中止的调用立即结束；超过占位时限后，后面的上传照常进行', async () => {
      const { serial } = await import('./upload-tool.js')
      let finishHung: (() => void) | undefined
      const hung = serial('q1', () => new Promise<void>((r) => (finishHung = r)))
      const controller = new AbortController()
      const waiting = serial('q1', async () => 'second', controller.signal)
      controller.abort()
      await expect(waiting).rejects.toBeDefined()

      const released = serial('q2', () => new Promise<void>(() => undefined), undefined, 20)
      void released
      await expect(serial('q2', async () => 'after-timeout')).resolves.toBe('after-timeout')
      finishHung?.()
      await hung
    })
  })

  describe('present（远程文件交付卡片）', () => {
    /** 宿主前端的校验规则，照抄 dsh-client-ui-deliverables 0.2.0-rc.2 的 isPresentedData / isPresentedFile（契约测试）。 */
    const isPresentedData = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const { turn, callId, files } = value as { turn: unknown; callId: unknown; files: unknown }
      return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1 && typeof callId === 'string' && callId.length > 0 && Array.isArray(files)
    }
    const isPresentedFile = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const { path: p, description } = value as { path: unknown; description: unknown }
      return typeof p === 'string' && p.trim().length > 0 && (description === undefined || typeof description === 'string')
    }
    let boundary: { openTurnStartSeq: number | null; lastTurn: number } = { openTurnStartSeq: 10, lastTurn: 3 }
    const projections = { stateOf: (_s: unknown, key: string) => (key === 'turnBoundary' ? boundary : undefined) }
    beforeEach(() => {
      boundary = { openTurnStartSeq: 10, lastTurn: 3 }
    })

    it('远程路径：远端校验通过后按宿主格式追加 deliverables/presented（绝对 / 相对 / 占位目录路径都规范化）', async () => {
      const s = await setup({ withBash: true, withPresent: true, projections })
      s.backend.put('/srv/app/docs/a.md', '# a')
      const agent = s.makeAgent(s.binding.localPath, 'pr-1')
      await s.created(agent)
      const r = await s.call(
        agent,
        'present',
        { files: [{ path: 'docs/a.md', description: '说明' }, { path: '/srv/app/README.md' }, { path: path.join(s.binding.localPath, 'docs', 'a.md') }] },
        'call-pr-1'
      )
      expect(r.isError).not.toBe(true)
      expect(r.content[0]?.text).toBe('Presented /srv/app/docs/a.md\nPresented /srv/app/README.md\nPresented /srv/app/docs/a.md')
      expect(agent.appended).toEqual([
        {
          type: 'deliverables/presented',
          data: {
            turn: 3,
            callId: 'call-pr-1',
            // remoteHost：远程标记，卡片 ▾ 菜单的服务端查询据此判断（宿主前端不看多出的字段）。
            files: [
              { path: '/srv/app/docs/a.md', description: '说明', remoteHost: 'h1' },
              { path: '/srv/app/README.md', remoteHost: 'h1' },
              { path: '/srv/app/docs/a.md', remoteHost: 'h1' }
            ]
          }
        }
      ])
      // 契约：宿主前端能接受这条事件与每个文件。
      const data = agent.appended[0]?.data as { files: unknown[] }
      expect(isPresentedData(data)).toBe(true)
      expect(data.files.every(isPresentedFile)).toBe(true)
      expect(s.builtinPresentCalls).toEqual([])
    })

    it('不存在 / 是目录 / 是符号链接 → 报错且不追加事件', async () => {
      const s = await setup({ withBash: true, withPresent: true, projections })
      s.backend.addDir('/srv/app/dir')
      s.backend.links.set('/srv/app/link.md', '/srv/app/README.md')
      const agent = s.makeAgent(s.binding.localPath, 'pr-2')
      await s.created(agent)
      const cases: Array<[string, string]> = [
        ['missing.md', 'Cannot present missing.md: file not found'],
        ['dir', 'Cannot present dir: not a regular file'],
        ['link.md', 'Cannot present link.md: not a regular file']
      ]
      for (const [p, message] of cases) {
        const r = await s.call(agent, 'present', { files: [{ path: p }] })
        expect(r.isError, p).toBe(true)
        expect(JSON.stringify(r.content)).toContain(message)
      }
      expect(agent.appended).toEqual([])
    })

    it('不在进行中的轮次 → 报错；数量超限 → 报错', async () => {
      const s = await setup({ withBash: true, withPresent: true, projections })
      const agent = s.makeAgent(s.binding.localPath, 'pr-3')
      await s.created(agent)
      boundary = { openTurnStartSeq: null, lastTurn: 3 }
      expect(JSON.stringify((await s.call(agent, 'present', { files: [{ path: 'README.md' }] })).content)).toContain('present requires an open turn')
      boundary = { openTurnStartSeq: 10, lastTurn: 3 }
      const many = Array.from({ length: 9 }, () => ({ path: 'README.md' }))
      expect(JSON.stringify((await s.call(agent, 'present', { files: many })).content)).toContain('present accepts 1 to 8 files')
      expect(agent.appended).toEqual([])
    })

    it('全部是本机文件 → 交回宿主实现（宿主自己追加事件，不重复）；本机与远程混合 → 报错', async () => {
      const s = await setup({ withBash: true, withPresent: true, projections })
      const agent = s.makeAgent(s.binding.localPath, 'pr-4')
      await s.created(agent)
      const local = await s.call(agent, 'present', { files: [{ path: 'C:\\DshChat\\pic\\a.png' }] })
      expect(local.isError).not.toBe(true)
      expect(s.builtinPresentCalls).toEqual([{ files: [{ path: 'C:\\DshChat\\pic\\a.png' }] }])
      expect(agent.appended).toEqual([{ type: 'deliverables/presented', data: { turn: 1, callId: 'builtin', files: [{ path: 'C:\\DshChat\\pic\\a.png' }] } }])

      const mixed = await s.call(agent, 'present', { files: [{ path: 'C:\\DshChat\\pic\\a.png' }, { path: 'README.md' }] })
      expect(mixed.isError).toBe(true)
      expect(JSON.stringify(mixed.content)).toContain('two separate calls')
      expect(agent.appended).toHaveLength(1)
    })

    it('本地会话不接管；缺 sessionProjections 时远程会话也不接管（宿主原实现照常）', async () => {
      const s = await setup({ withBash: true, withPresent: true, projections })
      const local = s.makeAgent(sandbox, 'pr-local')
      await s.created(local)
      await s.call(local, 'present', { files: [{ path: '/srv/app/README.md' }] })
      expect(s.builtinPresentCalls).toHaveLength(1)
      expect(s.logs.some((m) => m.includes('present') && m.includes('pr-local'))).toBe(false)

      const bare = await setup({ withBash: true, withPresent: true })
      const remote = bare.makeAgent(bare.binding.localPath, 'pr-bare')
      await bare.created(remote)
      await bare.call(remote, 'present', { files: [{ path: '/srv/app/README.md' }] })
      expect(bare.builtinPresentCalls).toHaveLength(1)
      expect(bare.logs.some((m) => /已接管 Agent 工具：.*present/.test(m))).toBe(false)
    })

    it('接管日志包含 present', async () => {
      const s = await setup({ withBash: true, withPresent: true, projections })
      await s.created(s.makeAgent(s.binding.localPath, 'pr-log'))
      expect(s.logs.some((m) => /已接管 Agent 工具：.*present/.test(m))).toBe(true)
    })
  })

  describe('open_in_sidebar', () => {
    const names = (s: { tools: { schemas(scope: never): Array<{ name: string }> } }, agent: object) =>
      s.tools.schemas(agent as never).map((t) => t.name)

    it('未传开关时本地会话零注册（与旧行为一致）', async () => {
      const s = await setup({ withBash: true })
      const local = s.makeAgent(sandbox, 'oisb-none')
      await s.created(local)
      expect(names(s, local)).not.toContain('open_in_sidebar')
    })

    it('本地与远程会话都注册；结果文本带可解析的 JSON 行；远程目标带 remoteHost', async () => {
      const s = await setup({ withBash: true, openInSidebar: true })
      const local = s.makeAgent(sandbox, 'oisb-local')
      const remote = s.makeAgent(s.binding.localPath, 'oisb-remote')
      await s.created(local)
      await s.created(remote)
      expect(names(s, local)).toContain('open_in_sidebar')
      expect(names(s, remote)).toContain('open_in_sidebar')

      const l = await s.call(local, 'open_in_sidebar', { target: '.' })
      expect(l.isError).not.toBe(true)
      expect(l.content[0]?.text).toContain('dsh-workspace:open {"kind":"folder"')

      const r = await s.call(remote, 'open_in_sidebar', { target: 'README.md' })
      expect(r.isError).not.toBe(true)
      expect(r.content[0]?.text).toContain('"target":"/srv/app/README.md"')
      expect(r.content[0]?.text).toContain('"remoteHost":"h1"')
      // 远程工具接管不受影响。
      expect(s.logs.some((m) => /远程会话已接管 Agent 工具：read, write, bash/.test(m))).toBe(true)
    })

    it('偏好关闭 → 撤销；重新打开 → 恢复（无需重开会话）；Agent 释放后取消订阅', async () => {
      const s = await setup({ withBash: true, openInSidebar: false })
      const local = s.makeAgent(sandbox, 'oisb-toggle')
      await s.created(local)
      expect(names(s, local)).not.toContain('open_in_sidebar')
      s.setOpen(true)
      expect(names(s, local)).toContain('open_in_sidebar')
      s.setOpen(false)
      expect(names(s, local)).not.toContain('open_in_sidebar')
      s.setOpen(true)
      ;(s.ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/disposed', { agent: local })
      await new Promise((r) => setTimeout(r, 30))
      expect(s.openListeners.size).toBe(0)
    })

    it('遮蔽 BS 的 sidebar_open：开启时从清单里去掉，关闭时恢复', async () => {
      const s = await setup({ withBash: true, openInSidebar: true, withBs: true })
      const local = s.makeAgent(sandbox, 'oisb-bs')
      await s.created(local)
      expect(names(s, local)).toContain('open_in_sidebar')
      expect(names(s, local)).not.toContain('sidebar_open')
      s.setOpen(false)
      expect(names(s, local)).toContain('sidebar_open')
      expect(names(s, local)).not.toContain('open_in_sidebar')
    })
  })

  it('readLimitOf / 提示词只对远程会话生效', () => {
    expect(readLimitOf({ name: 'read', execute: async () => 0, parameters: { limit: { description: 'Defaults to 1500.' } } })).toBe(1500)
    expect(readLimitOf(undefined)).toBe(2000)
    // 内置 read 的 offset 说明里也有「Defaults to 1.」且排在 limit 之前：
    // 必须只认 limit 自己的默认值，否则远程 read 每次只返回一行。
    expect(
      readLimitOf({
        name: 'read',
        execute: async () => 0,
        parameters: {
          file_path: { description: 'Path to read.' },
          offset: { description: '1-based first line to return. Defaults to 1.' },
          limit: { description: 'Maximum number of lines to return. Defaults to 2000.' }
        }
      })
    ).toBe(2000)
    // 参数以 JSON Schema 形状给出（properties 包裹）时同样成立。
    expect(
      readLimitOf({
        name: 'read',
        execute: async () => 0,
        parameters: {
          type: 'object',
          properties: {
            offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
            limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 1800.' }
          }
        }
      })
    ).toBe(1800)
    // limit 说明里没写默认值时用 2000，不能越过 limit 去抓后面属性的数字。
    expect(
      readLimitOf({
        name: 'read',
        execute: async () => 0,
        parameters: {
          offset: { description: '1-based first line to return. Defaults to 1.' },
          limit: { description: 'Maximum number of lines to return.' },
          max_chars: { description: 'Defaults to 5.' }
        }
      })
    ).toBe(2000)
    // 没有 limit 属性时用 2000，不能回退到整段文本又抓到 offset 的 1。
    expect(
      readLimitOf({
        name: 'read',
        execute: async () => 0,
        parameters: { offset: { description: '1-based first line to return. Defaults to 1.' } }
      })
    ).toBe(2000)
    expect(remotePromptText(undefined, 'x')).toBe('')
    expect(remotePromptText({ localPath: 'C:\\ph', hostId: 'h', remotePath: '/srv/app', title: 't', createdAt: '' }, 'box (u@h:22)')).toContain(
      'remote SSH workspace on box (u@h:22), rooted at /srv/app'
    )
  })

  it('remotePromptText：保留本机 shell 时说明 pwsh 跑在本机，默认不提', () => {
    const binding = { localPath: 'C:\\ph', hostId: 'h', remotePath: '/srv/app', title: 't', createdAt: '' }
    expect(remotePromptText(binding, 'box')).not.toContain('pwsh')
    const text = remotePromptText(binding, 'box', true)
    expect(text).toContain('they run on THIS computer, not on box')
    expect(text).toContain('C:\\ph')
  })

  it('remotePromptText：allowLocalFiles 开时说明本机绝对路径走本机，默认不提', () => {
    const binding = { localPath: 'C:\\ph', hostId: 'h', remotePath: '/srv/app', title: 't', createdAt: '' }
    const off = remotePromptText(binding, 'box')
    expect(off).toContain('operate on that remote host, not on this computer')
    expect(off).not.toContain('C:\\...')

    const on = remotePromptText(binding, 'box', false, true)
    expect(on).toContain('operate on that remote host by default')
    expect(on).toContain('C:\\... or \\\\server\\share points to THIS computer')
    expect(on).toContain('never mix local and remote paths in one call')
    // shell 段不受影响
    expect(remotePromptText(binding, 'box', true, true)).toContain('they run on THIS computer, not on box')
  })
})
