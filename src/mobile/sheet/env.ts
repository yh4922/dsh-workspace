/*
 * @Description: H5 抽屉 —— 复用桌面侧栏组件所需的运行环境替身（WorkspaceApi / t / RemoteIndex / 样式注入）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:40:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/env.ts
 *
 * src/client/sidebar 的组件原本由宿主插槽注入 {t, api, index, openResource, sessionId}：
 * - api：桌面端经 ctx.remote 挂载；H5 没有宿主外壳，改走 wsApi（POST /api/dshWorkspace/<method>），错误转成同形的 RemoteCallError；
 * - t：桌面端由宿主 i18n 绑定；这里直接查插件自带词典；
 * - index：RemoteIndex 的 sessions() 原本取宿主 sessions 服务，这里用 cwd.ts 的缓存冒充；
 * - 样式：src/client/styles.ts 的 injectStyles（含 xterm 样式），只在面板分片里调用，不进首屏。
 * 只被各面板（懒加载分片）import，SheetHost 本身不依赖它。
 */
import { useEffect, useState } from 'react'
import { RemoteCallError, type WorkspaceApi } from '../../client/api.js'
import type { Translate } from '../../client/context.js'
import { DICTIONARIES, withVars } from '../../client/locale.js'
import { RemoteIndex } from '../../client/sidebar/remote-index.js'
import { injectStyles } from '../../client/styles.js'
import { loadSidebarPrefs } from '../../client/sidebar-prefs.js'
import { RpcError, wsApi } from '../net/rpc.js'
import { ensureSessionCwd, sessionsService } from './cwd.js'

/** 插件网关调用替身：与桌面端 createApi 同一形状。 */
export const api: WorkspaceApi = {
  call(method, payload) {
    return wsApi(method, payload).catch((error: unknown) => {
      if (error instanceof RpcError) throw new RemoteCallError(error.code, error.message, error.details)
      throw error
    })
  }
}

const lang: 'zh' | 'en' = typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language) ? 'en' : 'zh'
const dict = DICTIONARIES[lang] as Record<string, string>
const fallback = DICTIONARIES.zh as Record<string, string>

export const t: Translate = withVars((key) => dict[key] ?? fallback[key] ?? key)

export const index = new RemoteIndex(async () => (await api.call('remoteWorkspaces', {})).workspaces, () => sessionsService)

let booted = false

/** 注入复用组件的样式、取回侧边栏偏好（查看器的文件关联 / 大文件阈值）。重复调用无副作用。 */
export function bootClientEnv(): void {
  if (booted) return
  booted = true
  injectStyles()
  void loadSidebarPrefs(api).catch(() => undefined)
}

export type WorkspaceReady = 'loading' | 'ready'

/**
 * 面板挂载前等两件事：远程工作区列表（判断远程 / 本地）与本会话 cwd。
 * 二者都是 RemoteIndex 同步查询的数据源，没到齐就渲染会先按「不是工作区」显示再闪成正常内容。
 */
export function useWorkspaceReady(sessionId: string): WorkspaceReady {
  const [ready, setReady] = useState<string | undefined>(undefined)
  useEffect(() => {
    bootClientEnv()
    let live = true
    void Promise.all([index.refresh(), ensureSessionCwd(sessionId)]).finally(() => {
      if (live) setReady(sessionId)
    })
    return () => {
      live = false
    }
  }, [sessionId])
  return ready === sessionId ? 'ready' : 'loading'
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
