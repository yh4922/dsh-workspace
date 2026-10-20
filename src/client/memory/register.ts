/*
 * @Description: 作用域记忆 —— 会话顶部「记忆」标签的注册（模块启用时才出现）
 * @Author: YangHeng
 * @Date: 2026-10-16 21:25:00
 * @FilePath: /dsh-workspace/src/client/memory/register.ts
 *
 * 启用状态与待审批数由宿主决定，浏览器只能轮询：每 15 秒拉一次 status（很轻），
 * 另外暴露 refreshMemoryTab() 给「记忆」页在切换开关后立即同步。
 */
import { createElement } from 'react'
import type { ClientContext, Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { memoryCaller } from './api.js'
import { SessionMemoryTab } from './SessionMemoryTab.js'
import { FitView } from '../sidebar/fit-height.js'

export const CONV_MEMORY_ID = 'dsh-workspace.conversation.memory'
const POLL_MS = 15_000

const refreshers = new Set<() => void>()

/** 设置页切换总开关后调用：标签立即出现 / 消失，不等下一次轮询。 */
export function refreshMemoryTab(): void {
  for (const fn of refreshers) fn()
}

export function registerMemoryTab(ctx: ClientContext, t: Translate, api: WorkspaceApi, log: (m: string, e?: unknown) => void): () => void {
  const call = memoryCaller(api.call.bind(api))
  let pending = 0
  let off: (() => void) | undefined
  let disposed = false
  // FitView 把视图钉成可视高度：看板四列才能各自滚动，而不是整个会话容器一起滚
  const View = (props: { sessionId: string }) => createElement(FitView, null, createElement(SessionMemoryTab, { t, api, sessionId: props.sessionId }))

  const sync = (): void => {
    void call({ op: 'status' }).then(
      (s) => {
        if (disposed) return
        pending = s.pendingCount
        if (s.enabled && off === undefined) {
          try {
            off = ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                // 标签文字带待审批数：宿主每次渲染标签都会重新调用 label()
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
        }
      },
      () => undefined
    )
  }
  refreshers.add(sync)
  sync()
  const timer = setInterval(sync, POLL_MS)
  return () => {
    disposed = true
    refreshers.delete(sync)
    clearInterval(timer)
    off?.()
    off = undefined
  }
}
