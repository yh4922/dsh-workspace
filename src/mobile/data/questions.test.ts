/*
 * @Description: H5 —— 提问解析 / 答复组装 / $events 提问处理单测（样本字段取自真实会话日志与宿主 dsh-user-questions 源码）
 * @Author: YangHeng
 * @Date: 2026-11-20 11:30:00
 * @FilePath: /dsh-workspace/src/mobile/data/questions.test.ts
 */
import { describe, expect, it } from 'vitest'
import { buildAnswers, continuedQuestions, emptyDraft, firstUnanswered, initStep, isAnswered, parseQuestions, skipAll, stepReducer, toggleOption, touchesQuestionProjection, type StepAction, type StepState } from './questions'
import { createApprovalStore } from './approvals'

const QUESTIONS = [
  {
    id: 'scope',
    header: '复刻范围',
    question: 'BUI 版复刻到什么程度？',
    options: [{ label: '主窗口全功能 (Recommended)', description: '工作量适中' }, { label: '完全 1:1' }]
  },
  { id: 'web', question: '是否对比 Web 版？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'free', question: '还有什么要求？' }
]

describe('parseQuestions', () => {
  it('解析选项 / 多选 / header，丢弃坏条目', () => {
    const qs = parseQuestions([...QUESTIONS, { id: 'x' }, 'bad', { question: 'no id' }])
    expect(qs?.map((q) => [q.id, q.multiSelect, q.options.length, q.header])).toEqual([
      ['scope', false, 2, '复刻范围'],
      ['web', true, 2, undefined],
      ['free', false, 0, undefined]
    ])
    expect(qs?.[0]?.options[0]).toEqual({ label: '主窗口全功能 (Recommended)', description: '工作量适中' })
    // 工具参数形态（multi_select）也认
    expect(parseQuestions([{ id: 'a', question: 'q', multi_select: true }])?.[0]?.multiSelect).toBe(true)
    expect(parseQuestions([])).toBeUndefined()
    expect(parseQuestions('x')).toBeUndefined()
  })
})

describe('答复组装', () => {
  const qs = parseQuestions(QUESTIONS) ?? []
  it('单选替换、多选切换；跳过 = selected 空且无 custom；单选有自定义时以自定义为准', () => {
    const [q0, q1, q2] = qs
    if (q0 === undefined || q1 === undefined || q2 === undefined) throw new Error('fixture')
    let d0 = toggleOption(q0, emptyDraft(), '完全 1:1')
    d0 = toggleOption(q0, d0, '主窗口全功能 (Recommended)')
    expect(d0.selected).toEqual(['主窗口全功能 (Recommended)'])
    let d1 = toggleOption(q1, emptyDraft(), 'A')
    d1 = { ...toggleOption(q1, d1, 'B'), custom: ' C ' }
    const d2 = { ...emptyDraft(), skipped: true }
    expect(isAnswered(emptyDraft())).toBe(false)
    expect([d0, d1, d2].every(isAnswered)).toBe(true)
    expect(buildAnswers(qs, [d0, d1, d2])).toEqual({
      answers: [
        { id: 'scope', selected: ['主窗口全功能 (Recommended)'] },
        { id: 'web', selected: ['A', 'B'], custom: 'C' },
        { id: 'free', selected: [] }
      ]
    })
    expect(buildAnswers(qs, [{ ...d0, custom: '自定义' }])).toEqual({
      answers: [
        { id: 'scope', selected: [], custom: '自定义' },
        { id: 'web', selected: [] },
        { id: 'free', selected: [] }
      ]
    })
    expect(skipAll(qs).answers.every((a) => a.selected.length === 0 && a.custom === undefined)).toBe(true)
  })
})

describe('userQuestions 投影', () => {
  it('只取 continued 条目', () => {
    const view = {
      active: [
        { callId: 'c1', questions: QUESTIONS, state: 'continued' },
        { callId: 'c2', questions: QUESTIONS, state: 'open' }
      ],
      settled: []
    }
    expect(continuedQuestions(view).map((q) => q.callId)).toEqual(['c1'])
    expect(continuedQuestions(undefined)).toEqual([])
  })
  it('pending 结果与迟到答复会刷新投影，普通工具结果不会', () => {
    const pending = { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"pending":true,"callId":"c1","message":"..."}' }] } }
    const answered = { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"answers":[{"id":"scope","selected":["完全 1:1"]}]}' }] } }
    expect(touchesQuestionProjection('tool/result', pending)).toBe(true)
    expect(touchesQuestionProjection('tool/result', answered)).toBe(false)
    expect(touchesQuestionProjection('user/message', { source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' } })).toBe(true)
    expect(touchesQuestionProjection('user/message', { source: { kind: 'user' } })).toBe(false)
  })
})

describe('$events 提问', () => {
  it('user-questions/request 入表、不自动 next；cancel 移除；未知 waterfall 仍回 next', () => {
    const s = createApprovalStore()
    s.handle({ type: 'ready', clientId: 'cl' })
    const r = s.handle({ type: 'waterfall', event: 'user-questions/request', eventId: 'e1', agentId: 'S1', request: { questions: QUESTIONS, wait: { callId: 'toolu_1', timed: true } } })
    expect(r.autoNext).toBeUndefined()
    expect(s.questions().S1?.map((q) => [q.eventId, q.callId, q.questions.length])).toEqual([['e1', 'toolu_1', 3]])
    expect(s.snapshot()).toEqual({})
    // 问题解析不出来（协议变化）就交给其它客户端
    expect(s.handle({ type: 'waterfall', event: 'user-questions/request', eventId: 'e2', agentId: 'S1', request: { questions: [] } }).autoNext).toBe('e2')
    expect(s.handle({ type: 'waterfall', event: 'other/event', eventId: 'e3', agentId: 'S1', request: {} }).autoNext).toBe('e3')
    s.handle({ type: 'cancel', eventId: 'e1' })
    expect(s.questions()).toEqual({})
  })
  it('审批与提问共存，reset 一并清空', () => {
    const s = createApprovalStore()
    s.handle({ type: 'waterfall', event: 'approval/request', eventId: 'a', agentId: 'S', request: { toolName: 'bash' } })
    s.handle({ type: 'waterfall', event: 'user-questions/request', eventId: 'q', agentId: 'S', request: { questions: QUESTIONS } })
    expect([s.snapshot().S?.length, s.questions().S?.length]).toEqual([1, 1])
    s.reset()
    expect([s.snapshot(), s.questions()]).toEqual([{}, {}])
  })
})

describe('分步答题 reducer', () => {
  const qs = parseQuestions(QUESTIONS) ?? []
  const run = (actions: StepAction[], from: StepState = initStep(qs.length)): StepState => actions.reduce((s, a) => stepReducer(qs, s, a), from)

  it('上一题 / 下一题 / 点进度自由切换，越界夹住，方向随之变化', () => {
    expect(run([{ type: 'next' }]).index).toBe(1)
    expect(run([{ type: 'next' }, { type: 'next' }, { type: 'next' }]).index).toBe(2)
    const back = run([{ type: 'go', index: 2 }, { type: 'prev' }])
    expect([back.index, back.dir]).toEqual([1, -1])
    expect(run([{ type: 'prev' }]).index).toBe(0)
    const s = initStep(qs.length)
    expect(stepReducer(qs, s, { type: 'prev' })).toBe(s) // 无变化时返回同一对象，避免无谓重渲染
  })

  it('单选选中后自动下一题；取消选中与多选不跳；最后一题不越界', () => {
    const s1 = run([{ type: 'toggle', label: '完全 1:1' }])
    expect([s1.index, s1.drafts[0]?.selected]).toEqual([1, ['完全 1:1']])
    const s2 = run([{ type: 'toggle', label: 'A' }], s1)
    expect([s2.index, s2.drafts[1]?.selected]).toEqual([1, ['A']])
    const s3 = run([{ type: 'go', index: 0 }, { type: 'toggle', label: '完全 1:1' }], s2)
    expect([s3.index, s3.drafts[0]?.selected]).toEqual([0, []])
  })

  it('跳过此题前进、再点撤销；最后一题跳过不自动提交', () => {
    const s1 = run([{ type: 'skip' }])
    expect([s1.index, s1.drafts[0]?.skipped]).toEqual([1, true])
    const s2 = run([{ type: 'prev' }, { type: 'skip' }], s1)
    expect([s2.index, s2.drafts[0]]).toEqual([0, emptyDraft()])
    const last = run([{ type: 'go', index: 2 }, { type: 'skip' }])
    expect([last.index, last.drafts[2]?.skipped]).toEqual([2, true])
  })

  it('自定义输入取消跳过；任何编辑清掉错误', () => {
    const s = run([{ type: 'go', index: 2 }, { type: 'skip' }, { type: 'custom', text: '加测试' }])
    expect(s.drafts[2]).toEqual({ selected: [], custom: '加测试', skipped: false })
    const err = run([{ type: 'submit' }])
    expect(err.error).toBeDefined()
    expect(run([{ type: 'custom', text: 'x' }], err).error).toBeUndefined()
  })

  it('提交校验：跳到第一道未完成题并提示；全部完成时无错误、可组装答复', () => {
    const partial = run([{ type: 'toggle', label: '完全 1:1' }, { type: 'go', index: 2 }, { type: 'custom', text: '无' }, { type: 'submit' }])
    expect([partial.index, partial.dir, partial.error]).toEqual([1, -1, '第 2 题还没回答，请选择、输入或跳过'])
    const done = run([{ type: 'skip' }, { type: 'submit' }], partial)
    expect(done.error).toBeUndefined()
    expect(firstUnanswered(done.drafts)).toBe(-1)
    expect(buildAnswers(qs, done.drafts).answers).toEqual([
      { id: 'scope', selected: ['完全 1:1'] },
      { id: 'web', selected: [] },
      { id: 'free', selected: [], custom: '无' }
    ])
  })

  it('单题：提示不带题号', () => {
    const one = qs.slice(0, 1)
    expect(stepReducer(one, initStep(1), { type: 'submit' }).error).toBe('请选择、输入或跳过')
  })
})