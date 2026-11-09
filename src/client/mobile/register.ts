/*
 * @Description: H5 外壳接入 —— 只在「经局域网代理访问」时注册
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/mobile/register.ts
 *
 * 本机 Desktop / 本机浏览器永远不注册（whoami 返回 proxied=false），桌面体验零影响。
 * 经代理时注册 shell.overlay：一、二级页整页，会话页只渲染自建 AppBar（宿主会话头由 CSS 隐藏）；
 * 组件内部再按「窄屏 && 未选桌面版」决定是否显示，切换无需刷新。
 */
import type { ClientContext, Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { whoami } from '../lan/whoami.js'
import { createMobileHost } from './host.js'
import { MobileShell } from './MobileShell.js'
import { createShellStore } from './route.js'

const OVERLAY_ID = 'dsh-workspace-h5'

export function registerMobileShell(ctx: ClientContext, t: Translate, api: WorkspaceApi, log: (message: string, error?: unknown) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  let disposed = false
  const disposers: Array<() => void> = []
  void whoami().then((w) => {
    if (disposed || !w.proxied) return
    const store = createShellStore()
    store.setProxied(true)
    disposers.push(store.install())
    const host = createMobileHost(ctx)
    const inject = () => ({ t, api, store, host })
    try {
      disposers.push(
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, inject }, MobileShell as never))
      )
    } catch (error) {
      log('H5 外壳接入 shell.overlay 失败', error)
    }
  })
  return () => {
    disposed = true
    for (const d of disposers.splice(0)) d()
    delete document.documentElement.dataset.dshwsH5
  }
}
