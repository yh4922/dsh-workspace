/*
 * @Description: 作用域记忆 —— 浏览器端调用封装（按 op 推出精确的返回类型）
 * @Author: YangHeng
 * @Date: 2026-10-16 20:40:00
 * @FilePath: /dsh-workspace/src/client/memory/api.ts
 */
import type { MemoryInput, MemoryOutputs } from '../../wire/memory.js'
import type { WorkspaceApi } from '../api.js'

export type MemoryCall = <I extends MemoryInput>(input: I) => Promise<MemoryOutputs[I['op']]>

export function memoryCaller(call: WorkspaceApi['call']): MemoryCall {
  return (input) => call('memory', input) as never
}
