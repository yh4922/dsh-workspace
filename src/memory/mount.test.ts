/*
 * @Description: 作用域记忆挂载测试 —— 提示词（冻结版本 / 开关 / 子代理）、分叉继承、压缩补漏、工具同步；scoped_memory 工具
 * @Author: YangHeng
 * @Date: 2026-10-16 20:30:00
 * @FilePath: /dsh-workspace/src/memory/mount.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, createRuntime, type WorkspaceRuntime } from '../runtime.js'
import { memoryPromptText, mountMemoryEvents } from './mount.js'
import { executeMemoryTool, MEMORY_TOOL_NAME } from './tool.js'

let dir: string
let rt: WorkspaceRuntime
let cwds: Record<string, string>

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dshws-mount-'))
  rt = createRuntime(DEFAULT_CONFIG, { persistTerminals: false, memoryRoot: dir })
  cwds = { s1: '/nonexistent-dshws/repo', s2: '/nonexistent-dshws/repo/sub', loose: '/nonexistent-dshws/elsewhere' }
  rt.host.sessions = { get: (id: string) => (cwds[id] !== undefined ? { header: { cwd: cwds[id] } } : undefined) }
  rt.memory.refs.workspaceRegistry = { list: () => [{ id: 'w1', path: '/nonexistent-dshws/repo', title: 'repo' }] }
  rt.memory.store.setSettings({ enabled: true })
})
afterEach(() => {
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

type Listener = (...args: unknown[]) => unknown
function fakeCtx() {
  const listeners = new Map<string, Listener[]>()
  return {
    on(name: string, fn: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn))
    },
    async emit(name: string, ...args: unknown[]) {
      for (const fn of listeners.get(name) ?? []) await fn(...args)
    }
  }
}

function fakeAgent(id: string, header: Record<string, unknown> = {}) {
  const registered: unknown[] = []
  let disposed = 0
  return {
    id,
    registered,
    disposedCount: () => disposed,
    session: { id, header: { cwd: cwds[id], ...header } },
    ctx: {
      inject(_deps: string[], fn: (scoped: { tools: { register(def: unknown): unknown } }) => void) {
        fn({ tools: { register: (def) => registered.push(def) } })
        return { dispose: () => (disposed += 1) }
      }
    }
  }
}

const defineTool = (d: unknown) => d

describe('提示词', () => {
  it('长期记忆即时生效；会话记忆只在冻结时刻刷新；关闭 / 子代理不注入', async () => {
    const ctx = fakeCtx()
    const off = mountMemoryEvents(ctx, rt.memory, defineTool)
    const store = rt.memory.store
    store.add({ layer: 'global' }, { content: '用中文' }, { by: 'user' })
    const agent = fakeAgent('s1')
    await ctx.emit('agent/created', { agent, source: 'startup' })
    store.add({ layer: 'project', projectId: 'w1' }, { content: '接口 code/msg/data' }, { by: 'user' })
    store.add({ layer: 'session', sessionId: 's1' }, { content: '目标 X', section: 'goal' }, { by: 'assistant' })

    let text = memoryPromptText(rt.memory, agent)
    expect(text).toContain('## 项目记忆（repo）\n- 接口 code/msg/data')
    expect(text).toContain('- 用中文')
    expect(text).not.toContain('目标 X')

    await ctx.emit('session/event', { id: 's1' }, { type: 'compaction/end', data: {} })
    text = memoryPromptText(rt.memory, agent)
    expect(text).toContain('## 目标\n- 目标 X')

    expect(memoryPromptText(rt.memory, fakeAgent('s1', { origin: 'subagent' }))).toBe('')
    store.setSettings({ enabled: false })
    expect(memoryPromptText(rt.memory, agent)).toBe('')
    off()
  })

  it('子目录会话归入祖先工作区；不属于工作区的会话没有项目记忆', async () => {
    const ctx = fakeCtx()
    mountMemoryEvents(ctx, rt.memory, defineTool)
    rt.memory.store.add({ layer: 'project', projectId: 'w1' }, { content: '项目约定' }, { by: 'user' })
    const sub = fakeAgent('s2')
    const loose = fakeAgent('loose')
    await ctx.emit('agent/created', { agent: sub, source: 'startup' })
    await ctx.emit('agent/created', { agent: loose, source: 'startup' })
    expect(memoryPromptText(rt.memory, sub)).toContain('项目约定')
    expect(memoryPromptText(rt.memory, loose)).toBe('')
  })
})

describe('生命周期', () => {
  it('分叉继承父会话记忆；子代理不继承', async () => {
    const ctx = fakeCtx()
    mountMemoryEvents(ctx, rt.memory, defineTool)
    rt.memory.store.add({ layer: 'session', sessionId: 's1' }, { content: '父进度', section: 'progress' }, { by: 'assistant' })
    cwds.child = cwds.s1 as string
    cwds.sub = cwds.s1 as string
    await ctx.emit('agent/created', { agent: fakeAgent('child', { parentSession: 's1', isSeeded: true }), source: 'startup' })
    await ctx.emit('agent/created', { agent: fakeAgent('sub', { parentSession: 's1', isSeeded: true, origin: 'subagent' }), source: 'startup' })
    expect(rt.memory.store.list({ layer: 'session', sessionId: 'child' }).map((e) => e.content)).toEqual(['父进度'])
    expect(rt.memory.store.list({ layer: 'session', sessionId: 'sub' })).toEqual([])
    expect(memoryPromptText(rt.memory, fakeAgent('child'))).toContain('父进度')
  })

  it('工具随开关注册 / 撤下；子代理不注册', async () => {
    const ctx = fakeCtx()
    mountMemoryEvents(ctx, rt.memory, defineTool)
    const agent = fakeAgent('s1')
    await ctx.emit('agent/created', { agent, source: 'startup' })
    expect((agent.registered[0] as { name: string }).name).toBe(MEMORY_TOOL_NAME)
    rt.memory.store.setSettings({ toolEnabled: false })
    expect(agent.disposedCount()).toBe(1)
    rt.memory.store.setSettings({ toolEnabled: true })
    expect(agent.registered).toHaveLength(2)
    const sub = fakeAgent('s1', { origin: 'subagent' })
    await ctx.emit('agent/created', { agent: sub, source: 'startup' })
    expect(sub.registered).toHaveLength(0)
  })

  it('agent/created 里出错不抛（否则会话创建失败）', async () => {
    const ctx = fakeCtx()
    mountMemoryEvents(ctx, rt.memory, defineTool)
    rt.memory.refs.workspaceRegistry = {
      list: () => {
        throw new Error('boom')
      }
    }
    await expect(ctx.emit('agent/created', { agent: fakeAgent('s1'), source: 'startup' })).resolves.toBeUndefined()
  })
})

describe('scoped_memory 工具', () => {
  it('会话层直接写；项目 / 全局只进待选；无项目时拒绝项目层；不能改别的会话', async () => {
    const deps = { service: rt.memory.service, scope: rt.memory.scope }
    const store = rt.memory.store
    const added = await executeMemoryTool(deps, 's1', { action: 'add', content: '记住 A', section: 'decisions' })
    expect(added.ok).toBe(true)
    const id = added.entries?.[0]?.id as string
    expect((await executeMemoryTool(deps, 's1', { action: 'update', id, content: '记住 B' })).entries?.[0]?.content).toBe('记住 B')
    expect((await executeMemoryTool(deps, 's2', { action: 'disable', id })).ok).toBe(false)

    const proj = await executeMemoryTool(deps, 's1', { action: 'add', layer: 'project', content: '项目约定' })
    expect(proj.message).toContain('待选')
    expect(store.list({ layer: 'project', projectId: 'w1' })).toEqual([])
    expect(store.candidates()[0]).toMatchObject({ layer: 'project', projectId: 'w1', source: { by: 'assistant', sessionId: 's1' } })

    expect((await executeMemoryTool(deps, 'loose', { action: 'add', layer: 'project', content: 'x' })).ok).toBe(false)
    expect((await executeMemoryTool(deps, 's1', { action: 'disable', layer: 'global', id: 'x' })).ok).toBe(false)

    const found = await executeMemoryTool(deps, 's1', { action: 'search', query: '记住' })
    expect(found.entries?.map((e) => e.content)).toEqual(['记住 B'])
  })

  it('搜索不越界到其他项目', async () => {
    const deps = { service: rt.memory.service, scope: rt.memory.scope }
    rt.memory.store.add({ layer: 'project', projectId: 'other' }, { content: '别的项目的秘密' }, { by: 'user' })
    rt.memory.store.add({ layer: 'global' }, { content: '全局秘密' }, { by: 'user' })
    const found = await executeMemoryTool(deps, 's1', { action: 'search', query: '秘密' })
    expect(found.entries?.map((e) => e.content)).toEqual(['全局秘密'])
    expect((await rt.memory.service.search('秘密')).length).toBe(2)
  })
})
