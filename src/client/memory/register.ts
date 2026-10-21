/*
 * @Description: 作用域记忆 —— 会话顶部「记忆」标签的注册（模块启用时才出现）
 * @Author: YangHeng
 * @Date: 2026-10-16 21:25:00
 * @FilePath: /dsh-workspace/src/client/memory/register.ts
 *
 * 启用状态与待审批数由宿主决定，浏览器只能轮询：页面可见时每 5 秒拉一次 status（很轻），
 * 切换会话时立即拉；「记忆」页加载到新数据时也会直接上报（pending-bus），不等轮询。
 *
 * 标签文字里的数字：
 * - 只算与「当前会话所在工作区」相关的待审批（status 带上 sessionId，口径与看板「待审核」列一致）；
 * - 宿主只在 conversation.view 插槽变动 / 切语言时才重新读 label()，数字变了也不会自己刷新 ——
 *   所以变了就在同一拍里注册并立刻撤掉一个占位条目，触发一次（微任务合并的）插槽通知，标签不会闪。
 */
import { createElement } from 'react'
import type { ClientContext, Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { memoryCaller } from './api.js'
import { SessionMemoryTab } from './SessionMemoryTab.js'
import { FitView } from '../sidebar/fit-height.js'
import { onMemoryPending } from './pending-bus.js'

export const CONV_MEMORY_ID = 'dsh-workspace.conversation.memory'
const BUMP_ID = `${CONV_MEMORY_ID}.label-refresh`
const POLL_MS = 5_000

const refreshers = new Set<() => void>()

/** 设置页切换总开关后调用：标签立即出现 / 消失，不等下一次轮询。 */
export function refreshMemoryTab(): void {
  for (const fn of refreshers) fn()
}

interface CurrentSession {
  getSnapshot(): { key?: string } | undefined
  subscribe(listener: () => void): () => void
}

export function registerMemoryTab(ctx: ClientContext, t: Translate, api: WorkspaceApi, log: (m: string, e?: unknown) => void): () => void {
  const call = memoryCaller(api.call.bind(api))
  let pending = 0
  let off: (() => void) | undefined
  let disposed = false
  let offCurrent: (() => void) | undefined
  /** 丢弃过期响应：切会话后旧会话的 status 晚到不能覆盖新数字。 */
  let seq = 0
  // FitView 把视图钉成可视高度：看板四列才能各自滚动，而不是整个会话容器一起滚
  const View = (props: { sessionId: string }) => createElement(FitView, null, createElement(SessionMemoryTab, { t, api, sessionId: props.sessionId }))

  // uiSession 往往晚于本插件提供：每次用时现取，取到后再订阅「当前会话」变化
  const current = (): CurrentSession | undefined => (ctx.get('uiSession') as { adapter?: { current?: CurrentSession } } | undefined)?.adapter?.current
  const currentKey = (): string | undefined => current()?.getSnapshot()?.key

  /** 让宿主重新读一次 label()（见文件头说明）。 */
  const bumpLabel = (): void => {
    if (off === undefined) return
    try {
      // 与正式标签同一种注册方式（插槽已声明，工厂同步执行）；注册后立刻撤掉
      ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: BUMP_ID, order: 9999 }, View as never))()
    } catch (error) {
      log('刷新「记忆」标签数字失败', error)
    }
  }
  const setPending = (n: number): void => {
    if (n === pending) return
    pending = n
    bumpLabel()
  }

  const sync = (): void => {
    if (offCurrent === undefined) {
      const cur = current()
      if (cur !== undefined) offCurrent = cur.subscribe(sync)
    }
    const sessionId = currentKey()
    const mine = ++seq
    void call(sessionId !== undefined ? { op: 'status', sessionId } : { op: 'status' }).then(
      (s) => {
        if (disposed || mine !== seq) return
        if (s.enabled && off === undefined) {
          pending = s.pendingCount
          try {
            off = ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                // 标签文字带待审批数：宿主重读标签时调用 label()
                { name: 'conversation.view', id: CONV_MEMORY_ID, order: 22, label: () => (pending > 0 ? `${t('memory.tab')} (${pending})` : t('memory.tab')) },
                View as never
              )
            )
          } catch (error) {
            log('注册会话顶部「记忆」标签失败', error)
          }
        } else if (!s.enabled && off !== undefined) {
          off()
          off = undefined
        } else {
          setPending(s.pendingCount)
        }
      },
      () => undefined
    )
  }
  const report = (sessionId: string, count: number): void => {
    if (disposed || sessionId !== currentKey()) return
    seq += 1 // 页面数据更新，作废在途的 status
    setPending(count)
  }

  refreshers.add(sync)
  const offReport = onMemoryPending(report)
  sync()
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') sync()
  }, POLL_MS)
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') sync()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    disposed = true
    refreshers.delete(sync)
    offReport()
    clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    offCurrent?.()
    off?.()
    off = undefined
  }
}
