/*
 * @Description: 编辑器 / 对比视图的开关偏好（缩略图、折叠未改动）—— 本机持久化，并在所有打开的编辑器间同步
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/editor-prefs.ts
 *
 * 为什么要同步：文件页、右侧栏、Git 对比可能同时开着多个编辑器，
 * 在一处关掉缩略图，其它编辑器也应立即跟着变，而不是等重新打开才生效。
 */
import { useCallback, useEffect, useState } from 'react'

export type EditorPref = 'minimap' | 'diffCollapse'

/** 存储键与默认值：两项默认都开启。 */
const PREFS: Record<EditorPref, { key: string; fallback: boolean }> = {
  minimap: { key: 'dshws.editor.minimap', fallback: true },
  diffCollapse: { key: 'dshws.git.collapse', fallback: true }
}

const listeners = new Set<() => void>()
/** 本次会话内的最新值：存储不可用（隐私模式等）时以它为准。 */
const memory = new Map<EditorPref, boolean>()

function read(pref: EditorPref): boolean {
  const cached = memory.get(pref)
  if (cached !== undefined) return cached
  const { key, fallback } = PREFS[pref]
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/**
 * 读写一项开关偏好。
 * @param pref 偏好名
 * @returns [当前值, 设置函数]
 */
export function useEditorPref(pref: EditorPref): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => read(pref))
  useEffect(() => {
    const sync = (): void => setValue(read(pref))
    listeners.add(sync)
    return () => {
      listeners.delete(sync)
    }
  }, [pref])
  const set = useCallback(
    (next: boolean) => {
      memory.set(pref, next)
      try {
        localStorage.setItem(PREFS[pref].key, next ? '1' : '0')
      } catch {
        // 存储不可用（隐私模式等）时只在本次会话内生效
      }
      setValue(next)
      for (const fn of listeners) fn()
    },
    [pref]
  )
  return [value, set]
}
