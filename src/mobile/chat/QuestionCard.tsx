/*
 * @Description: H5 会话 —— agent 提问卡片（ask_user_question）：分步答题（一次一题）、单选 / 多选 / 自定义输入 / 单题跳过 / 全部跳过
 * @Author: YangHeng
 * @Date: 2026-11-20 11:15:00
 * @FilePath: /dsh-workspace/src/mobile/chat/QuestionCard.tsx
 *
 * 多题时与桌面 QuestionComposer 一致改为分步：顶部「问题 n / N」+ 分段进度（已答 / 已跳过有标记，可点跳转），
 * 底部「上一题 / 下一题」，最后一题为「提交」；全部完成后才一次性发出答复（协议没有部分作答，空答复 = 跳过）。
 * 单题不显示进度与翻页，直接提交。分步状态是 data/questions.ts 的纯 reducer，
 * 并按请求 key 缓存在模块级：流式刷新、列表重排甚至离开会话再回来都不丢已填答案；提交成功后清除。
 */
import { useState } from 'react'
import {
  buildAnswers,
  firstUnanswered,
  initStep,
  isAnswered,
  skipAll,
  stepReducer,
  type Answer,
  type Question,
  type StepAction,
  type StepState
} from '../data/questions.js'
import { Icon } from '../icons.js'

export interface QuestionCardProps {
  /** 请求的稳定标识（eventId / callId），用作答题进度缓存 key。 */
  stateKey: string
  questions: Question[]
  /** 已超时、仍可回答（走 userQuestions/answer）时显示的提示。 */
  hint?: string
  onSubmit: (answer: { answers: Answer[] }) => Promise<void>
}

/** 请求 key → 答题进度。条目只在提交成功时删除；单个会话同时挂起的提问很少，不做淘汰。 */
const progress = new Map<string, StepState>()

function useStepper(key: string, questions: readonly Question[]): [StepState, (a: StepAction) => void] {
  const [state, setState] = useState<StepState>(() => {
    const cached = progress.get(key)
    return cached !== undefined && cached.drafts.length === questions.length ? cached : initStep(questions.length)
  })
  const dispatch = (a: StepAction): void =>
    setState((cur) => {
      const next = stepReducer(questions, cur, a)
      progress.set(key, next)
      return next
    })
  return [state, dispatch]
}

export function QuestionCard({ stateKey, questions, hint, onSubmit }: QuestionCardProps) {
  const [st, dispatch] = useStepper(stateKey, questions)
  const [busy, setBusy] = useState<'submit' | 'skip' | undefined>()
  const [sendErr, setSendErr] = useState<string | undefined>()

  const count = questions.length
  const multi = count > 1
  const index = Math.min(st.index, count - 1)
  const q = questions[index]
  const d = st.drafts[index]
  if (q === undefined || d === undefined) return null
  const last = index === count - 1
  const locked = busy !== undefined
  const act = (a: StepAction): void => {
    setSendErr(undefined)
    dispatch(a)
  }

  const send = (kind: 'submit' | 'skip'): void => {
    if (locked) return
    if (kind === 'submit' && firstUnanswered(st.drafts) >= 0) {
      act({ type: 'submit' })
      return
    }
    setBusy(kind)
    setSendErr(undefined)
    onSubmit(kind === 'skip' ? skipAll(questions) : buildAnswers(questions, st.drafts)).then(
      () => progress.delete(stateKey),
      (e: unknown) => {
        setSendErr(e instanceof Error ? e.message : '提交失败')
        setBusy(undefined)
      }
    )
  }

  const err = sendErr ?? st.error

  return (
    <div className="c-card c-qcard" data-tone="warn">
      <div className="c-card-hd">
        <Icon name="triangleAlert" size={16} />
        <span>需要你回答</span>
        {!multi && q.header !== undefined ? <b className="c-card-tag">{q.header}</b> : null}
        {multi ? (
          <span className="c-q-count mono" aria-live="polite">
            问题 <b>{index + 1}</b> / {count}
          </span>
        ) : null}
      </div>
      {multi ? (
        <div className="c-q-steps" role="tablist" aria-label="答题进度">
          {questions.map((x, i) => {
            const di = st.drafts[i]
            const mark = i === index ? 'current' : di?.skipped ? 'skipped' : di !== undefined && isAnswered(di) ? 'done' : 'todo'
            return (
              <button
                key={x.id}
                type="button"
                role="tab"
                className="c-q-step"
                data-state={mark}
                data-answered={di !== undefined && isAnswered(di) ? 'true' : undefined}
                aria-selected={i === index}
                aria-label={`第 ${i + 1} 题${mark === 'done' ? '（已答）' : mark === 'skipped' ? '（已跳过）' : ''}`}
                disabled={locked}
                onClick={() => act({ type: 'go', index: i })}
              />
            )
          })}
        </div>
      ) : null}
      {hint !== undefined ? <div className="c-card-sub">{hint}</div> : null}

      {/* key 随题号变：切题时整块重挂载，触发按方向的滑入动画（也让 textarea 光标 / 滚动位置归零） */}
      <div key={multi ? index : 'single'} className="c-q" data-dir={multi ? (st.dir > 0 ? 'next' : 'prev') : undefined} data-skipped={d.skipped ? 'true' : undefined}>
        {(multi && q.header !== undefined) || q.multiSelect ? (
          <div className="c-q-hd">
            {multi && q.header !== undefined ? <b>{q.header}</b> : null}
            {q.multiSelect ? <small>可多选</small> : null}
          </div>
        ) : null}
        <div className="c-card-body">{q.question}</div>
        {q.detail !== undefined ? <pre className="c-q-detail">{q.detail}</pre> : null}
        {q.options.length > 0 ? (
          <div className="c-opts" role={q.multiSelect ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const selected = d.selected.includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  className="c-opt"
                  role={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  data-multi={q.multiSelect ? 'true' : undefined}
                  data-selected={selected ? 'true' : 'false'}
                  disabled={locked}
                  onClick={() => act({ type: 'toggle', label: o.label })}
                >
                  <i className="c-opt-mark" aria-hidden="true" />
                  <span className="c-opt-text">
                    {o.label}
                    {o.description !== undefined ? <small>{o.description}</small> : null}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
        <textarea
          className="c-card-input"
          rows={q.options.length > 0 ? 1 : 3}
          placeholder={q.options.length > 0 ? '其他（自定义回答）' : '输入你的回答'}
          value={d.custom}
          disabled={locked}
          onChange={(e) => act({ type: 'custom', text: e.target.value })}
        />
        {multi ? (
          <div className="c-q-foot">
            <button type="button" className="c-link-btn" disabled={locked} onClick={() => act({ type: 'skip' })}>
              {d.skipped ? '已跳过 · 撤销' : '跳过此题'}
            </button>
            <button type="button" className="c-link-btn" disabled={locked} onClick={() => send('skip')}>
              {busy === 'skip' ? '提交中…' : '全部跳过'}
            </button>
          </div>
        ) : null}
      </div>

      {err !== undefined ? <div className="c-appr-err">{err}</div> : null}
      <div className="c-card-actions">
        {multi ? (
          <>
            <button type="button" className="c-btn" disabled={locked || index === 0} onClick={() => act({ type: 'prev' })}>
              <Icon name="chevronLeft" size={16} />
              上一题
            </button>
            {last ? (
              <button type="button" className="c-btn c-btn-pri" disabled={locked} onClick={() => send('submit')}>
                {busy === 'submit' ? '提交中…' : '提交'}
              </button>
            ) : (
              <button type="button" className="c-btn c-btn-pri" disabled={locked} onClick={() => act({ type: 'next' })}>
                下一题
                <Icon name="chevronRight" size={16} />
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="c-btn" disabled={locked} onClick={() => send('skip')}>
              {busy === 'skip' ? '提交中…' : '跳过'}
            </button>
            <button type="button" className="c-btn c-btn-pri" disabled={locked} onClick={() => send('submit')}>
              {busy === 'submit' ? '提交中…' : '提交'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
