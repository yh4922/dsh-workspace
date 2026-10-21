/*
 * @Description: 作用域记忆 —— 「记忆」页 → 会话顶部标签数字的上报通道
 * @Author: YangHeng
 * @Date: 2026-10-21 15:20:00
 * @FilePath: /dsh-workspace/src/client/memory/pending-bus.ts
 *
 * 单独成模块：register.ts 引用 SessionMemoryTab，反过来上报不能再引用 register.ts（避免循环依赖）。
 */

type Reporter = (sessionId: string, count: number) => void

const reporters = new Set<Reporter>()

/** 「记忆」页拿到最新数据时上报待审批数：标签数字立即跟上（只对当前会话生效）。 */
export function reportMemoryPending(sessionId: string, count: number): void {
  for (const fn of reporters) fn(sessionId, count)
}

/** 订阅上报；返回取消订阅。 */
export function onMemoryPending(fn: Reporter): () => void {
  reporters.add(fn)
  return () => {
    reporters.delete(fn)
  }
}
