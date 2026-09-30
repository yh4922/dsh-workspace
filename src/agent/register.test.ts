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
async function setup(options: {
  withBash: boolean
  layout?: 'preset' | 'global'
  attachments?: object
  /** 注册宿主 present 的替身（行为照抄 dsh-tool-present：execute 记 pending，tools/result 成功时追加事件）。 */
  withPresent?: boolean
  /** sessionProjections 替身；不传则不提供该服务。 */
  projections?: object
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
        offset: { type: 'number', description: '1-based first line.' },
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
  const binding = bindings.create({ hostId: 'h1', endpoint: 'h1', remotePath: '/srv/app', title: 'app' })
  const logs: string[] = []
  const push = (_h: string, _c: string, m: string) => logs.push(m)
  const rt = { log: { info: push, warn: push, error: push } } as unknown as WorkspaceRuntime
  mountAgentTools(ctx as never, {
    rt,
    bindings,
    preimages: new PreimageStore(() => path.join(sandbox, 'pre')),
    backendFor: () => backend,
    defineTool: defineTool as (d: unknown) => unknown
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
  return { ctx, tools: runtime, backend, binding, makeAgent, created, call, logs, builtinPresentCalls, presetKey: usePreset ? presetKey : undefined }
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

  it('readLimitOf / 提示词只对远程会话生效', () => {
    expect(readLimitOf({ name: 'read', execute: async () => 0, parameters: { limit: { description: 'Defaults to 1500.' } } })).toBe(1500)
    expect(readLimitOf(undefined)).toBe(2000)
    expect(remotePromptText(undefined, 'x')).toBe('')
    expect(remotePromptText({ localPath: 'C:\\ph', hostId: 'h', remotePath: '/srv/app', title: 't', createdAt: '' }, 'box (u@h:22)')).toContain(
      'remote SSH workspace on box (u@h:22), rooted at /srv/app'
    )
  })
})
