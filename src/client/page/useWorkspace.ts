/*
 * @Description: 页面状态 —— 轮询宿主快照、统一错误路由、暴露操作
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/useWorkspace.ts
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ERROR_CODES, type MethodName } from '../../wire/contract.js'
import type { MethodIO, StateOutput } from '../../wire/dto.js'
import { RemoteCallError, type WorkspaceApi } from '../api.js'

/** 轮询间隔。页面只在打开时轮询，连接状态点需要近实时反映。 */
const POLL_MS = 3000

/**
 * 只读方法：调用成功后不需要刷新整页状态。
 * 文件浏览会高频调用这些方法（展开一个目录就是一次），每次都连带刷新会让请求量翻倍。
 */
const READ_ONLY = new Set<MethodName>([
  'state',
  'logs',
  'sftpHome',
  'sftpList',
  'sftpRead',
  'sftpSearch',
  'getPrefs',
  'editorAsset',
  'updateStatus',
  'updateCheck',
  // 远程访问页 5 秒轮询一次；它的写入也不影响主机 / 终端状态，不必连带刷新整页。
  'lan'
])

export interface HostKeyAlert {
  hostId: string
  endpoint: string
  expected: string
  actual: string
}

export interface WorkspaceModel {
  state: StateOutput | null
  loading: boolean
  /** 需要用户解锁时置位（由 vault-locked 错误触发），页面据此聚焦解锁框。 */
  unlockRequested: boolean
  hostKeyAlert: HostKeyAlert | null
  dismissHostKeyAlert(): void
  /** 走 HTTP（上传 / 下载）而非 Typert 的调用遇到锁定时，由调用方主动触发解锁提示。 */
  requestUnlock(): void
  refresh(): Promise<void>
  /**
   * 调用远程方法。vault-locked / host-key-changed 这类「需要用户介入」的错误
   * 在这里统一路由到对应的 UI 状态，调用方只需处理剩余的业务失败。
   */
  call<M extends MethodName>(
    method: M,
    payload: MethodIO[M][0],
    context?: { hostId?: string }
  ): Promise<MethodIO[M][1]>
}

export function useWorkspace(api: WorkspaceApi): WorkspaceModel {
  const [state, setState] = useState<StateOutput | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlockRequested, setUnlockRequested] = useState(false)
  const [hostKeyAlert, setHostKeyAlert] = useState<HostKeyAlert | null>(null)
  const alive = useRef(true)

  const fetchState = async (): Promise<void> => {
    try {
      const next = await api.call('state', {})
      if (!alive.current) return
      setState(next)
      if (next.unlocked) setUnlockRequested(false)
    } catch {
      // 轮询失败（宿主重启中等）不打断用户，下一轮自然恢复。
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  // 上一次 state 还没回来就不再发，而是等它：请求在浏览器里排队时（并发连接被占满），
  // 每 3 秒无条件轮询会越堆越多，连接空出来后又一起涌上去。
  const inflight = useRef<Promise<void> | null>(null)
  const refresh = useCallback(async () => {
    if (inflight.current !== null) return await inflight.current
    const run = fetchState()
    inflight.current = run
    try {
      await run
    } finally {
      inflight.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])
  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => {
      // 页面在后台标签页时不轮询，省掉无意义的请求。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh()
    }, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const call = useCallback(
    async <M extends MethodName>(
      method: M,
      payload: MethodIO[M][0],
      context?: { hostId?: string }
    ): Promise<MethodIO[M][1]> => {
      try {
        const result = await api.call(method, payload)
        if (!READ_ONLY.has(method)) void refresh()
        return result
      } catch (error) {
        if (error instanceof RemoteCallError) {
          if (error.code === ERROR_CODES.vaultLocked) setUnlockRequested(true)
          if (error.code === ERROR_CODES.hostKeyChanged) {
            const d = error.details as { endpoint?: string; expected?: string; actual?: string }
            setHostKeyAlert({
              hostId: context?.hostId ?? '',
              endpoint: d.endpoint ?? '',
              expected: d.expected ?? '',
              actual: d.actual ?? ''
            })
          }
        }
        void refresh()
        throw error
      }
    },
    [api, refresh]
  )

  const requestUnlock = useCallback(() => setUnlockRequested(true), [])
  const dismissHostKeyAlert = useCallback(() => setHostKeyAlert(null), [])

  // 注意：每次状态轮询都会得到新的 state，因此这个对象本身每 3 秒就换一次身份。
  // 子组件的 effect / useCallback 应依赖其中稳定的函数（call、refresh、requestUnlock），
  // 而不是整个 model —— 否则每次轮询都会连带重启子组件的定时器和请求。
  return {
    state,
    loading,
    unlockRequested,
    hostKeyAlert,
    dismissHostKeyAlert,
    requestUnlock,
    refresh,
    call
  }
}

/** 把任意错误转成给用户看的一句话。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
