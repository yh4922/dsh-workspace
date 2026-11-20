/*
 * @Description: H5 底部抽屉 —— 全局开关状态（openSheet / closeSheet 与 SheetHost 共享）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:30:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/store.ts
 */
import { useSyncExternalStore } from 'react'

export type SheetTab = 'files' | 'git' | 'ssh' | 'context' | 'browser'

export interface OpenSheetOptions {
  tab: SheetTab
  path?: string
  line?: number
  url?: string
}

export interface SheetState {
  open: boolean
  tab: SheetTab
  /** 每次 openSheet 自增，面板据此响应同一 tab 的重复跳转 */
  seq: number
  path?: string
  line?: number
  url?: string
}

let state: SheetState = { open: false, tab: 'files', seq: 0 }
const listeners = new Set<() => void>()

function emit(next: SheetState): void {
  state = next
  for (const l of listeners) l()
}

export function openSheet(opts: OpenSheetOptions): void {
  emit({ open: true, tab: opts.tab, seq: state.seq + 1, path: opts.path, line: opts.line, url: opts.url })
}

export function closeSheet(): void {
  if (state.open) emit({ ...state, open: false })
}

/** 切 tab（抽屉内部使用，不携带跳转参数） */
export function switchTab(tab: SheetTab): void {
  emit({ ...state, open: true, tab, path: undefined, line: undefined, url: undefined })
}

export function getSheetState(): SheetState {
  return state
}

export function subscribeSheet(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useSheetState(): SheetState {
  return useSyncExternalStore(subscribeSheet, getSheetState, getSheetState)
}
