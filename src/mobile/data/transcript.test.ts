import { describe, expect, it } from 'vitest'
import { assembleChunks, buildTranscript, contextEntry, expandStream, findGap, isRunning, mergeEvents, presentedFiles, reasoningDurations, withThinking, type WireEvent } from './transcript'
import { FollowModel } from './follow'

const ev = (seq: number, type: string, data: unknown, surfaceOp: unknown = undefined): WireEvent => ({ seq, type, time: 1000 + seq, data, ...(surfaceOp !== undefined ? { surfaceOp } : {}) })
const user = (seq: number, text: string, rpcId = `r${seq}`) =>
  ev(seq, 'user/message', { role: 'user', id: `m${seq}`, content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }, 'append')

describe('expandStream', () => {
  it('展开压缩记录并还原时间', () => {
    const chunks = expandStream([
      { type: 'reasoning-chunks', time0: 100, index: 0, dt: [500, 1500], texts: ['想', '一', '想'] },
      { type: 'text-chunks', time0: 3000, index: 1, dt: [10], texts: ['你', '好'] },
      { type: 'tool-call-chunks', time0: 3100, index: 2, dt: [5], id: 'c1', name: 'read', args: ['{"a"', ':1}'] },
      { type: 'chunk', time: 3200, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      'garbage'
    ])
    expect(chunks.map((c) => c.time)).toEqual([100, 600, 2100, 3000, 3010, 3100, 3105, 3200])
    const blocks = assembleChunks(chunks)
    expect(blocks.map((b) => [b.type, b.text])).toEqual([
      ['reasoning', '想一想'],
      ['text', '你好'],
      ['tool-call', '{"a":1}']
    ])
    expect(blocks[2]?.name).toBe('read')
    expect(reasoningDurations([{ type: 'reasoning-chunks', time0: 100, index: 0, dt: [500, 1500], texts: ['a', 'b', 'c'] }])).toEqual([2000])
  })
})

describe('buildTranscript', () => {
  it('用户消息、思考、文本、工具调用与结果配对', () => {
    const events: WireEvent[] = [
      ev(0, 'turn/start', { turn: 1 }),
      user(1, '修一下'),
      ev(2, 'step/start', { turn: 1, step: 1 }),
      ev(
        3,
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '先看文件' },
              { type: 'text', text: '我来读取' },
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"src/a.ts"}' }
            ]
          },
          stream: [{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [12000], texts: ['先看', '文件'] }]
        },
        'append'
      ),
      ev(4, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/a.ts"}' }),
      ev(5, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }, 'append'),
      ev(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    ]
    const { items, rpcIds } = buildTranscript(events)
    expect(items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'text', 'tool'])
    expect(rpcIds.has('r1')).toBe(true)
    const r = items[1]
    expect(r?.kind === 'reasoning' && r.durationMs).toBe(12000)
    const t = items[3]
    expect(t?.kind === 'tool' && [t.status, t.result, t.name]).toEqual(['ok', 'ok', 'read'])
    expect(isRunning(events)).toBe(false)
  })

  it('忽略压缩副本；注入的上下文合并成一行；未完成工具在 turn/end 后标记中断；错误提示', () => {
    const events: WireEvent[] = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', { content: [{ type: 'text', text: '指令' }], source: { kind: 'agent-instructions' } }, 'append'),
      ev(2, 'user/message', { content: [{ type: 'text', text: '现在 10 点' }], source: { kind: 'time-context', form: 'snapshot' } }, 'append'),
      ev(3, 'user/message', { content: [{ type: 'text', text: '摘要' }], source: { kind: 'user' } }, { op: 'replace', startSeq: 0, endSeq: 1 }),
      ev(4, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'x', name: 'bash', arguments: '{}' }] }, stream: [] }, 'append'),
      ev(5, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } })
    ]
    const { items } = buildTranscript(events)
    expect(items.map((i) => i.kind)).toEqual(['context', 'tool', 'notice'])
    const c = items[0]
    expect(c?.kind === 'context' && [c.key, c.entries.map((e) => e.label)]).toEqual(['x1', ['工作区指令', '时间']])
    expect(items[1]?.kind === 'tool' && items[1].status).toBe('interrupted')
    expect(items[2]?.kind === 'notice' && items[2].text).toContain('boom')
  })

  it('present 交付文件按 turn 汇总放在 turn 末尾（真实 deliverables/presented 结构）', () => {
    const { items } = buildTranscript([
      ev(0, 'turn/start', { turn: 4 }),
      user(1, '做吧'),
      ev(2, 'deliverables/presented', { turn: 4, callId: 'toolu_1', files: [{ path: 'C:\\DshChat\\bui-wechat\\.tasks\\todo.md', description: '任务计划' }] }),
      ev(3, 'assistant/message', { turn: 4, step: 2, message: { content: [{ type: 'text', text: '完成' }] }, stream: [] }, 'append'),
      ev(4, 'deliverables/presented', { turn: 4, callId: 'toolu_2', files: [{ path: '/tmp/a.png' }, { bad: 1 }] }),
      ev(5, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'files'])
    const f = items[2]
    expect(f?.kind === 'files' && f.files).toEqual([
      { path: 'C:\\DshChat\\bui-wechat\\.tasks\\todo.md', name: 'todo.md', description: '任务计划' },
      { path: '/tmp/a.png', name: 'a.png' }
    ])
  })

  it('运行中无可见输出时补「思考中」；空 reasoning 流式块也显示', () => {
    const running = [ev(0, 'turn/start', { turn: 1 }), user(1, 'hi')]
    expect(buildTranscript(running).items.map((i) => i.kind)).toEqual(['user', 'thinking'])
    const live = { attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 1, nextIndex: 1, chunks: [{ time: 1, chunk: { type: 'block-start' as const, index: 0, blockType: 'reasoning' } }] }
    const withLive = buildTranscript(running, live).items
    expect(withLive.map((i) => i.kind)).toEqual(['user', 'reasoning'])
    expect(withLive[1]?.kind === 'reasoning' && withLive[1].streaming).toBe(true)
    // 工具运行中不需要占位；已结束的会话不占位
    const tool = buildTranscript([...running, ev(2, 'tool/call', { turn: 1, callId: 'c', name: 'bash', arguments: '{}' })]).items
    expect(tool.map((i) => i.kind)).toEqual(['user', 'tool'])
    expect(buildTranscript([...running, ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]).items.map((i) => i.kind)).toEqual(['user'])
  })

  it('withThinking：占位总在最后（乐观气泡之后），不等待时移除', () => {
    const u = { kind: 'user' as const, key: 'p1', seq: 9, text: 'q', images: [], files: [], pending: 'sending' as const }
    const base = buildTranscript([ev(0, 'turn/start', { turn: 1 })]).items
    expect(withThinking([...base, u], true).map((i) => i.key)).toEqual(['p1', 'thinking'])
    expect(withThinking([...base, u], false).map((i) => i.key)).toEqual(['p1'])
  })

  it('contextEntry / presentedFiles 宽容解析', () => {
    expect(contextEntry({ kind: 'skill-invocation', name: 'grill-me' }, [{ type: 'text', text: 'x' }])).toEqual({ label: '技能：grill-me', text: 'x' })
    expect(contextEntry({ kind: 'plugin:dsh-better-sidebar' }, []).label).toBe('dsh-better-sidebar')
    expect(presentedFiles({ files: 'nope' })).toEqual([])
  })

  it('图片 / 文件附件', () => {
    const { items } = buildTranscript([
      ev(1, 'user/message', {
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'x.png' } },
          { type: 'file', attachment: { attachmentId: 'b', name: 'log.txt', bytes: 10 } }
        ],
        source: { kind: 'user' }
      }, 'append')
    ])
    const u = items[0]
    expect(u?.kind === 'user' && [u.images.length, u.files[0]?.name]).toEqual([1, 'log.txt'])
  })

  it('live attempt 在 durable 落盘后不重复显示，块 key 一致', () => {
    const live = {
      attemptId: 'a1',
      turn: 2,
      step: 1,
      startedAfterSeq: 5,
      nextIndex: 2,
      chunks: [
        { time: 1, chunk: { type: 'text-delta' as const, index: 0, text: '你' } },
        { time: 2, chunk: { type: 'text-delta' as const, index: 0, text: '好' } }
      ]
    }
    const a = buildTranscript([user(5, 'hi')], live).items
    expect(a.map((i) => [i.kind, i.key])).toEqual([
      ['user', 'u5'],
      ['text', 'b2.1.0']
    ])
    expect(a[1]?.kind === 'text' && a[1].streaming).toBe(true)
    const b = buildTranscript(
      [user(5, 'hi'), ev(6, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '你好' }] }, stream: [] }, 'append')],
      live
    ).items
    expect(b.map((i) => [i.kind, i.key])).toEqual([
      ['user', 'u5'],
      ['text', 'b2.1.0']
    ])
    expect(b[1]?.kind === 'text' && b[1].streaming).toBeUndefined()
  })
})

describe('事件合并', () => {
  it('按 seq 去重排序并找断档', () => {
    const m = mergeEvents([ev(1, 'a', 1), ev(2, 'a', 2)], [ev(2, 'b', 2), ev(5, 'a', 5)])
    expect(m.map((e) => [e.seq, e.type])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [5, 'a']
    ])
    expect(findGap(m)).toEqual({ from: 3, to: 4 })
  })
})

describe('FollowModel', () => {
  const snap = (records: WireEvent[], extra: Record<string, unknown> = {}) => ({
    type: 'snapshot',
    cursor: records.at(-1)?.seq ?? -1,
    records: records.map((event) => ({ type: 'event', event })),
    hasMore: false,
    projections: { asOfSeq: 0, values: { title: 'T' } },
    assistantStream: { revision: 0 },
    ...extra
  })

  it('流式帧 revision 连续；不连续要求重开；end committed 后等 durable 才收掉', () => {
    const m = new FollowModel()
    m.snapshot(snap([user(0, 'q')]))
    expect(m.state.projections.title).toBe('T')
    expect(m.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 })).toEqual({})
    m.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } })
    expect(m.state.live?.chunks.length).toBe(1)
    m.stream({ type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } })
    expect(m.state.live).toBeDefined()
    m.event({ type: 'assistant/message', seq: 1, time: 0, data: { turn: 1, step: 1, message: { content: [] } }, surfaceOp: 'append' })
    expect(m.state.live).toBeUndefined()
    expect(m.stream({ type: 'start', attemptId: 'b', revision: 9, turn: 1, step: 2 })).toEqual({ resync: true })
  })

  it('重连快照恢复压缩格式 activeAttempt，并检测断档', () => {
    const m = new FollowModel()
    m.snapshot(snap([user(0, 'q'), ev(1, 'turn/start', { turn: 1 })]))
    const effect = m.snapshot(
      snap([ev(5, 'turn/start', { turn: 2 })], {
        assistantStream: {
          revision: 7,
          activeAttempt: { attemptId: 'z', startedAfterSeq: 5, turn: 2, step: 1, nextIndex: 2, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] }] }
        }
      })
    )
    expect(effect.gap).toEqual({ from: 2, to: 4 })
    expect(m.state.live?.chunks.map((c) => (c.chunk.type === 'text-delta' ? c.chunk.text : ''))).toEqual(['a', 'b'])
    expect(m.state.events.map((e) => e.seq)).toEqual([0, 1, 5])
    // 补齐
    m.page([2, 3, 4].map((seq) => ({ type: 'event', event: { type: 'x', seq, time: 0, data: {} } })))
    expect(findGap(m.state.events)).toBeUndefined()
    // 实时事件断档
    expect(m.event({ type: 'y', seq: 8, time: 0, data: {} }).gap).toEqual({ from: 6, to: 7 })
    expect(m.stream({ type: 'chunk', attemptId: 'z', revision: 8, index: 2, time: 3, chunk: { type: 'text-delta', index: 0, text: 'c' } })).toEqual({})
  })

  it('向上分页合并并更新 hasMore；补不齐时丢弃旧事件', () => {
    const m = new FollowModel()
    m.snapshot({ ...snap([ev(10, 'turn/start', { turn: 3 })]), hasMore: true })
    expect(m.state.hasMore).toBe(true)
    m.page([{ type: 'event', event: { type: 'turn/start', seq: 9, time: 0, data: {} } }], { older: true, hasMore: false })
    expect(m.state.events.map((e) => e.seq)).toEqual([9, 10])
    expect(m.state.hasMore).toBe(false)
    m.dropBefore(10)
    expect(m.state.events.map((e) => e.seq)).toEqual([10])
    expect(m.state.hasMore).toBe(true)
  })
})
