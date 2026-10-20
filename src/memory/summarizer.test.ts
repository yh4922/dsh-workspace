/*
 * @Description: 后台总结测试 —— 对话抽取、结果解析与应用、调度（假模型）
 * @Author: YangHeng
 * @Date: 2026-10-16 19:50:00
 * @FilePath: /dsh-workspace/src/memory/summarizer.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './store.js'
import { MAX_SESSION_ADDS, SESSION_SOFT_LIMIT, Summarizer, applyResult, buildUserPrompt, extractTranscript, parseResult, type SummarizerHost } from './summarizer.js'
import { migrateSettings } from './store.js'

let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dshws-summ-'))
  store = new MemoryStore({ root: dir, projectOf: (sid) => (sid === 'loose' ? null : 'p1') })
  store.setSettings({ enabled: true, summarizeEveryTurns: 3 })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const user = (text: string, kind = 'user') => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind } } })
const assistant = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text }, { type: 'tool-call' }] } } })
const turn = (n: number) => ({ type: 'turn/start', data: { turn: n } })

describe('extractTranscript', () => {
  it('只取最近 N 轮的真人输入与助手文本，跳过快照与推理', () => {
    const events = [turn(1), user('第一轮'), assistant('答一'), turn(2), user('快照', 'runtime-context'), user('第二轮'), assistant('答二'), turn(3), user('第三轮'), assistant('答三')]
    expect(extractTranscript(events, 2)).toBe('user: 第二轮\n\nassistant: 答二\n\nuser: 第三轮\n\nassistant: 答三')
    expect(extractTranscript(events, 10)).toContain('user: 第一轮')
    expect(extractTranscript([], 3)).toBe('')
  })
})

describe('parseResult', () => {
  it('容忍围栏与多余文字；缺省字段补齐；非法分节被拒', () => {
    const r = parseResult('好的：\n```json\n{"session":{"add":[{"section":"goal","content":"做 X"}]}}\n```')
    expect(r).toEqual({ session: { add: [{ section: 'goal', content: '做 X' }], update: [], disable: [] }, candidates: [] })
    expect(parseResult('{"session":{"add":[{"section":"facts","title":"标题A","content":"x"}]}}').session.add[0]?.title).toBe('标题A')
    expect(() => parseResult('没有')).toThrow('没有 JSON')
    expect(() => parseResult('{"session":{"add":[{"section":"bad","content":"x"}]}}')).toThrow()
  })
})

describe('applyResult', () => {
  it('写入会话、忽略不属于本会话的 id、无项目时丢弃项目候选', () => {
    const own = store.add({ layer: 'session', sessionId: 's1' }, { content: '旧进度', section: 'progress' }, { by: 'summarizer' })
    const other = store.add({ layer: 'session', sessionId: 's2' }, { content: '别人的', section: 'facts' }, { by: 'user' })
    const outcome = applyResult(store, 's1', 'p1', 4, {
      session: { add: [{ section: 'goal', content: '新目标' }, { section: 'progress', content: '旧进度' }], update: [{ id: own.id, content: '新进度' }, { id: other.id, content: '篡改' }], disable: [other.id] },
      candidates: [{ layer: 'project', content: '统一返回 code/msg/data', importance: 'high' }]
    })
    expect(outcome).toEqual({ added: 1, updated: 1, disabled: 0, proposed: 1 })
    expect(store.list({ layer: 'session', sessionId: 's2' })[0]).toMatchObject({ content: '别人的', enabled: true })
    expect(store.candidates()[0]).toMatchObject({ layer: 'project', projectId: 'p1', source: { by: 'summarizer', sessionId: 's1', turn: 4 } })

    const loose = applyResult(store, 'loose', null, undefined, { session: { add: [], update: [], disable: [] }, candidates: [{ layer: 'project', content: 'x', importance: 'medium' }] })
    expect(loose.proposed).toBe(0)
  })
})

describe('buildUserPrompt', () => {
  it('压缩模式带摘要与补漏要求；无项目时说明不要提项目候选', () => {
    const text = buildUserPrompt({ mode: 'compaction', session: [], project: null, global: [], transcript: '', compactionSummary: '摘要内容' })
    expect(text).toContain('摘要内容')
    expect(text).toContain('补进会话记忆')
    expect(text).toContain('不要提 project 候选')
  })
})

function fakeHost(reply: string | (() => never), events: unknown[] = [turn(1), user('定方案 A'), assistant('好')]): SummarizerHost & { logs: string[]; calls: number } {
  const host = {
    logs: [] as string[],
    calls: 0,
    store,
    projectOf: async () => 'p1',
    events: async () => events,
    route: () => ({ provider: 'p', model: 'm' }),
    llm: () => ({
      stream: (opts: Record<string, unknown>) => {
        host.calls += 1
        expect(opts).toMatchObject({ provider: 'p', model: 'm' })
        return (async function* () {
          if (typeof reply === 'function') reply()
          yield { type: 'text-delta', text: reply as string }
          yield { type: 'finish', kind: 'stop' }
        })()
      }
    }),
    log: (_level: 'info' | 'warn', message: string) => {
      host.logs.push(message)
    }
  }
  return host
}

describe('Summarizer', () => {
  it('每 N 轮触发一次；关闭时不触发', async () => {
    const host = fakeHost('{"session":{"add":[{"section":"decisions","content":"选方案 A"}]}}')
    const s = new Summarizer(host)
    s.onTurn('s1', 1)
    s.onTurn('s1', 2)
    expect(host.calls).toBe(0)
    s.onTurn('s1', 3)
    await new Promise((r) => setTimeout(r, 20))
    expect(host.calls).toBe(1)
    expect(store.list({ layer: 'session', sessionId: 's1' }).map((e) => e.content)).toEqual(['选方案 A'])

    store.setSettings({ enabled: false })
    for (let i = 0; i < 6; i += 1) s.onTurn('s1', i)
    await new Promise((r) => setTimeout(r, 20))
    expect(host.calls).toBe(1)
  })

  it('模型失败 / 输出不是 JSON：只记日志、不抛错', async () => {
    const bad = fakeHost('不是 JSON')
    expect(await new Summarizer(bad).run({ sessionId: 's1', mode: 'manual' })).toBeUndefined()
    expect(bad.logs.join('')).toContain('后台总结失败')
    const boom = fakeHost(() => {
      throw new Error('网络断了')
    })
    expect(await new Summarizer(boom).run({ sessionId: 's1', mode: 'manual' })).toBeUndefined()
    expect(boom.logs.join('')).toContain('网络断了')
  })

  it('同一会话运行中再请求：排队，跑完补跑一次', async () => {
    const host = fakeHost('{}')
    const s = new Summarizer(host)
    expect(s.request({ sessionId: 's1', mode: 'manual' })).toBe(true)
    expect(s.isRunning('s1')).toBe(true)
    expect(s.request({ sessionId: 's1', mode: 'compaction', compactionSummary: 'x' })).toBe(false)
    await new Promise((r) => setTimeout(r, 30))
    expect(host.calls).toBe(2)
    expect(s.isRunning('s1')).toBe(false)
  })
})

describe('自动记录的门槛', () => {
  const add = (n: number) => Array.from({ length: n }, (_, i) => ({ section: 'facts' as const, content: `事实 ${i}` }))

  it('每次最多新增 2 条、最多 1 条候选', () => {
    const outcome = applyResult(store, 's1', 'p1', 1, {
      session: { add: add(5), update: [], disable: [] },
      candidates: [
        { layer: 'project', content: 'a', importance: 'medium' },
        { layer: 'global', content: 'b', importance: 'medium' }
      ]
    })
    expect(outcome).toMatchObject({ added: MAX_SESSION_ADDS, proposed: 1 })
  })

  it('达到上限后不再新增，但禁用腾出名额后可以补', () => {
    const scope = { layer: 'session' as const, sessionId: 's1' }
    const ids = Array.from({ length: SESSION_SOFT_LIMIT }, (_, i) => store.add(scope, { content: `已有 ${i}` }, { by: 'user' }).id)
    expect(applyResult(store, 's1', 'p1', 1, { session: { add: add(2), update: [], disable: [] }, candidates: [] }).added).toBe(0)
    expect(applyResult(store, 's1', 'p1', 1, { session: { add: add(2), update: [], disable: [ids[0] as string] }, candidates: [] }).added).toBe(1)
  })

  it('提示词说明门槛；接近上限时要求只合并清理', () => {
    const many = Array.from({ length: SESSION_SOFT_LIMIT }, (_, i) => store.add({ layer: 'session', sessionId: 's1' }, { content: `x${i}` }, { by: 'user' }))
    const text = buildUserPrompt({ mode: 'turns', session: many, project: [], global: [], transcript: 'user: hi' })
    expect(text).toContain('这次不要新增')
  })

  it('旧设置文件里的默认间隔 3 迁移为 8；改过的值与新文件保留', () => {
    expect(migrateSettings({ summarizeEveryTurns: 3 })?.summarizeEveryTurns).toBe(8)
    expect(migrateSettings({ summarizeEveryTurns: 5 })?.summarizeEveryTurns).toBe(5)
    expect(migrateSettings({ summarizeEveryTurns: 3, revision: 2 } as never)?.summarizeEveryTurns).toBe(3)
  })
})
