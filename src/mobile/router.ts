/*
 * @Description: H5 —— hash 路由（#/ 首页、#/s/<sessionId> 会话详情）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:10:00
 * @FilePath: /dsh-workspace/src/mobile/router.ts
 *
 * 用 hash 而不是 path：页面由插件路由 /dsh-workspace/m/ 单文件提供，hash 变化不发请求、刷新也不会 404；
 * 手机返回键 / 侧滑返回只认浏览器历史，所以每次进入下一级都 pushState。
 */
import { useSyncExternalStore } from 'react'

export type MobileRoute = { page: 'home' } | { page: 'session'; sessionId: string }
export type Direction = 'forward' | 'back' | 'none'

export function parseHash(hash: string): MobileRoute {
  const m = /^#\/s\/(.+)$/.exec(hash)
  if (m === null) return { page: 'home' }
  try {
    return { page: 'session', sessionId: decodeURIComponent(m[1] as string) }
  } catch {
    return { page: 'home' }
  }
}

export function formatHash(route: MobileRoute): string {
  return route.page === 'session' ? `#/s/${encodeURIComponent(route.sessionId)}` : '#/'
}

const RANK = { home: 0, session: 1 } as const

/** 层级变浅为后退，其余（含会话之间切换）为前进：决定滑入动画方向。 */
export function directionOf(from: MobileRoute, to: MobileRoute): Direction {
  if (formatHash(from) === formatHash(to)) return 'none'
  return RANK[to.page] < RANK[from.page] ? 'back' : 'forward'
}

interface RouterState {
  route: MobileRoute
  direction: Direction
}

let state: RouterState = { route: typeof location === 'undefined' ? { page: 'home' } : parseHash(location.hash), direction: 'none' }
/** 本页面自己 push 过几层：决定「返回」用 history.back（与返回键一致）还是改写 hash（刷新后直达详情）。 */
let depth = 0
const listeners = new Set<() => void>()

function set(route: MobileRoute): void {
  state = { route, direction: directionOf(state.route, route) }
  for (const l of [...listeners]) l()
}

function onPop(): void {
  const route = parseHash(location.hash)
  if (formatHash(route) === formatHash(state.route)) return
  depth = Math.max(0, depth - 1)
  set(route)
}

let installed = false
function subscribe(listener: () => void): () => void {
  if (!installed && typeof window !== 'undefined') {
    installed = true
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 当前路由与切页方向。 */
export function useRoute(): RouterState {
  return useSyncExternalStore(subscribe, () => state)
}

/** 前进到新页面（写历史）；replace=true 只改写当前条目。 */
export function navigate(route: MobileRoute, replace = false): void {
  const hash = formatHash(route)
  if (hash === formatHash(state.route)) return
  if (replace) history.replaceState(history.state, '', hash)
  else {
    history.pushState(history.state, '', hash)
    depth++
  }
  set(route)
}

/** 返回首页。 */
export function goBack(): void {
  if (depth > 0) history.back()
  else navigate({ page: 'home' }, true)
}
