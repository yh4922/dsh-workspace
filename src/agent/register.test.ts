/*
 * @Description: 远程工具注册的集成测试 —— 真实 ToolRuntime + 真实 fs-observation-policy + agent/created 事件
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/agent/register.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import type { WorkspaceRuntime } from '../runtime.js'

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
async function setup(options: { withBash: boolean; layout?: 'preset' | 'global' }) {
  const ctx = new Context()
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
      execute: async () => {
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

  const backend = new FakeBackend()
  backend.addDir('/srv/app')
  backend.put('/srv/app/README.md', 'hello\nworld\n')
  const bindings = new BindingStore()
  const binding = bindings.create({ hostId: 'h1', endpoint: 'h1', remotePath: '/srv/app', title: 'app' })
  const logs: string[] = []
  const rt = { log: { info: (_h: string, _c: string, m: string) => logs.push(m), error: (_h: string, _c: string, m: string) => logs.push(m) } } as unknown as WorkspaceRuntime
  mountAgentTools(ctx as never, {
    rt,
    bindings,
    preimages: new PreimageStore(() => path.join(sandbox, 'pre')),
    backendFor: () => backend,
    defineTool: defineTool as (d: unknown) => unknown
  })

  const makeAgent = (cwd: string, id: string) => {
    const agent = { session: { id, header: { cwd } } } as { session: object; ctx?: unknown }
    agent.ctx = createScope(ctx as never, agent, usePreset ? { parent: presetKey } : undefined).ctx
    return agent
  }
  const created = async (agent: object) => {
    ;(ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/created', { agent, source: 'new' })
    await new Promise((r) => setTimeout(r, 30))
  }
  const call = (agent: object, name: string, args: Record<string, unknown>) =>
    runtime.execute({ callId: `c${Math.random()}`, name, arguments: args, signal: new AbortController().signal, agent } as never) as Promise<{
      content: Array<{ text?: string }>
      isError?: boolean
    }>
  return { ctx, tools: runtime, backend, binding, makeAgent, created, call, logs, presetKey: usePreset ? presetKey : undefined }
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

  it('Agent 释放后作用域注册一并撤下', async () => {
    const s = await setup({ withBash: true })
    const remote = s.makeAgent(s.binding.localPath, 'remote-6')
    await s.created(remote)
    ;(s.ctx as unknown as { emit(e: string, p: unknown): void }).emit('agent/disposed', { agent: remote })
    await new Promise((r) => setTimeout(r, 30))
    const r = await s.call(remote, 'read', { file_path: 'README.md' })
    expect(JSON.stringify(r.content)).toContain('LOCAL read must not run')
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
            limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' }
          }
        }
      })
    ).toBe(2000)
    expect(remotePromptText(undefined, 'x')).toBe('')
    expect(remotePromptText({ localPath: 'C:\\ph', hostId: 'h', remotePath: '/srv/app', title: 't', createdAt: '' }, 'box (u@h:22)')).toContain(
      'remote SSH workspace on box (u@h:22), rooted at /srv/app'
    )
  })
})
