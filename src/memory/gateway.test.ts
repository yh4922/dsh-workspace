/*
 * @Description: 作用域记忆网关测试 —— 输入严格校验 + 网关到业务层的完整往返
 * @Author: YangHeng
 * @Date: 2026-10-16 21:45:00
 * @FilePath: /dsh-workspace/src/memory/gateway.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_MANIFEST } from '../wire/manifest.js'
import { DEFAULT_CONFIG, createRuntime, type WorkspaceRuntime } from '../runtime.js'

const descriptor = (HOST_MANIFEST.invocations as Array<{ method: string; parameters: Array<{ codec: { schema: { parse(v: unknown): unknown } } }> }>).find((d) => d.method === 'memory')
const parse = (v: unknown) => descriptor?.parameters[0]?.codec.schema.parse(v)

describe('memory 输入校验', () => {
  it('合法 op 通过；未知字段 / 未知 op / 空内容被拒', () => {
    expect(() => parse({ op: 'add', scope: { layer: 'global' }, draft: { content: 'x' } })).not.toThrow()
    expect(() => parse({ op: 'settings', patch: { enabled: true, summarizerModel: null } })).not.toThrow()
    expect(() => parse({ op: 'add', scope: { layer: 'global' }, draft: { content: '' } })).toThrow()
    expect(() => parse({ op: 'add', scope: { layer: 'global', extra: 1 }, draft: { content: 'x' } })).toThrow()
    expect(() => parse({ op: 'drop' })).toThrow()
    expect(() => parse({ op: 'update', scope: { layer: 'project', projectId: 'p' }, id: 'm', patch: { importance: 'urgent' } })).toThrow()
  })
})

describe('memory 网关往返', () => {
  let dir: string
  let rt: WorkspaceRuntime
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'dshws-memgw-'))
    rt = createRuntime(DEFAULT_CONFIG, { persistTerminals: false, memoryRoot: dir })
    rt.host.sessions = { get: (id: string) => (id === 's1' ? { header: { cwd: '/nonexistent-dshws/repo' } } : undefined) }
    rt.host.sessionPersistence = { stat: async () => undefined }
    rt.memory.refs.workspaceRegistry = { list: () => [{ id: 'w1', path: '/nonexistent-dshws/repo', title: 'repo' }] }
  })
  afterEach(() => {
    rt.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('总览 / 会话视图 / 审批 / 孤儿清理', async () => {
    const svc = rt.memory.service
    expect(await svc.handle({ op: 'status' })).toEqual({ enabled: false, pendingCount: 0 })
    await svc.handle({ op: 'settings', patch: { enabled: true } })
    await svc.handle({ op: 'add', scope: { layer: 'session', sessionId: 's1' }, draft: { content: '目标', section: 'goal' } })
    await svc.handle({ op: 'add', scope: { layer: 'session', sessionId: 'gone' }, draft: { content: '孤儿' } })
    rt.memory.store.propose({ layer: 'project', projectId: 'w1', content: '约定', source: { by: 'summarizer', sessionId: 's1' } })

    const overview = (await svc.handle({ op: 'overview' })) as Awaited<ReturnType<typeof svc.overview>>
    expect(overview.pendingCount).toBe(1)
    expect(overview.projects.find((p) => p.id === 'w1')?.sessions.map((s) => s.sessionId)).toEqual(['s1'])
    expect(overview.looseSessions.map((s) => [s.sessionId, s.exists])).toEqual([['gone', false]])

    const view = await svc.sessionView('s1')
    expect(view.project).toEqual({ id: 'w1', title: 'repo' })
    expect(view.candidates).toHaveLength(1)
    expect(await svc.handle({ op: 'approveAll', sessionId: 's1' })).toEqual({ count: 1 })
    expect((await svc.sessionView('s1')).projectEntries.map((e) => e.content)).toEqual(['约定'])

    expect(await svc.handle({ op: 'orphans' })).toEqual([{ sessionId: 'gone', projectId: '_none', entryCount: 1 }])
    // 只删宿主确认不存在的会话：传进来的正常会话 ID 被忽略
    expect(await svc.handle({ op: 'cleanup', sessionIds: ['gone', 's1'] })).toEqual({ removed: 1 })
    expect(rt.memory.store.list({ layer: 'session', sessionId: 's1' })).toHaveLength(1)
  })

  it('会话里的待审批数只算本工作区相关的', async () => {
    rt.host.sessions = {
      get: (id: string) => {
        const cwd = { s1: '/nonexistent-dshws/repo', s2: '/nonexistent-dshws/repo', o1: '/nonexistent-dshws/other', l1: '/nonexistent-dshws/loose' }[id]
        return cwd !== undefined ? { header: { cwd } } : undefined
      }
    }
    rt.memory.refs.workspaceRegistry = {
      list: () => [
        { id: 'w1', path: '/nonexistent-dshws/repo', title: 'repo' },
        { id: 'w2', path: '/nonexistent-dshws/other', title: 'other' }
      ]
    }
    const svc = rt.memory.service
    await svc.handle({ op: 'settings', patch: { enabled: true } })
    const { store } = rt.memory
    store.propose({ layer: 'project', projectId: 'w1', content: '本项目约定', source: { by: 'summarizer', sessionId: 's2' } })
    store.propose({ layer: 'global', content: '本项目其他会话提出的全局', source: { by: 'summarizer', sessionId: 's2' } })
    store.propose({ layer: 'project', projectId: 'w2', content: '别的项目', source: { by: 'summarizer', sessionId: 'o1' } })
    store.propose({ layer: 'global', content: '别的项目提出的全局', source: { by: 'summarizer', sessionId: 'o1' } })
    store.propose({ layer: 'global', content: '无项目会话提出的', source: { by: 'summarizer', sessionId: 'l1' } })

    expect(await svc.handle({ op: 'status' })).toEqual({ enabled: true, pendingCount: 5 })
    expect(await svc.handle({ op: 'status', sessionId: 's1' })).toEqual({ enabled: true, pendingCount: 2 })
    expect((await svc.sessionView('s1')).candidates.map((c) => c.content).sort()).toEqual(['本项目其他会话提出的全局', '本项目约定'])
    // 不属于任何项目的会话只看自己提出的
    expect(await svc.handle({ op: 'status', sessionId: 'l1' })).toEqual({ enabled: true, pendingCount: 1 })
    // 会话里的「全部拒绝」只作用于看到的那一批
    expect(await svc.handle({ op: 'rejectAll', sessionId: 's1' })).toEqual({ count: 2 })
    expect(store.candidates()).toHaveLength(3)
  })

  it('手动整理：未启用 / 无模型服务时如实返回原因', async () => {
    const svc = rt.memory.service
    expect(await svc.handle({ op: 'reorganize', sessionId: 's1' })).toEqual({ started: false, reason: '记忆模块未启用。' })
    await svc.handle({ op: 'settings', patch: { enabled: true } })
    expect(await svc.handle({ op: 'reorganize', sessionId: 's1' })).toEqual({ started: false, reason: '宿主模型服务不可用。' })
  })

  it('模型列表：按服务商读取，单个服务商失败不影响其余；已保存但列不出的设置值保留', async () => {
    rt.memory.refs.llm = {
      stream: () => (async function* () {})(),
      listProviders: () => [{ id: 'ds', name: 'DeepSeek' }, { id: 'bad', name: 'Broken' }],
      listModels: async (p: string) => {
        if (p === 'bad') throw new Error('401')
        return [{ id: 'deepseek-chat', name: 'DeepSeek V3' }]
      }
    }
    await rt.memory.service.handle({ op: 'settings', patch: { summarizerModel: { provider: 'gone', model: 'm1' } } })
    expect(await rt.memory.service.handle({ op: 'models' })).toEqual([
      { provider: 'ds', model: 'deepseek-chat', label: 'DeepSeek V3', group: 'DeepSeek' },
      { provider: 'gone', model: 'm1', label: 'm1', group: 'gone（当前不可用）' }
    ])
  })

  it('标题：新增 / 修改 / 清除；搜索命中标题；AI 生成标题用默认模型并清理输出', async () => {
    const svc = rt.memory.service
    const e = (await svc.handle({ op: 'add', scope: { layer: 'global' }, draft: { title: '  回复语言 ', content: '一律用中文回复' } })) as { id: string; title?: string }
    expect(e.title).toBe('回复语言')
    expect(((await svc.handle({ op: 'search', query: '语言' })) as unknown[]).length).toBe(1)
    const cleared = (await svc.handle({ op: 'update', scope: { layer: 'global' }, id: e.id, patch: { title: '' } })) as { title?: string }
    expect(cleared.title).toBeUndefined()

    let seen: Record<string, unknown> = {}
    rt.memory.refs.agentDefaultModel = { currentSelection: () => ({ provider: 'ds', model: 'chat' }) }
    rt.memory.refs.llm = {
      stream: (opts: Record<string, unknown>) => {
        seen = opts
        return (async function* () {
          yield { type: 'text-delta', text: '标题：「接口统一返回格式」。\n多余的说明' }
        })()
      }
    }
    expect(await svc.handle({ op: 'suggestTitle', content: '接口统一返回 code/msg/data' })).toEqual({ title: '接口统一返回格式' })
    expect(seen).toMatchObject({ provider: 'ds', model: 'chat' })

    rt.memory.refs.agentDefaultModel = { currentSelection: () => undefined }
    await expect(svc.handle({ op: 'suggestTitle', content: 'x' })).rejects.toThrow('没有可用的默认模型')
  })
})