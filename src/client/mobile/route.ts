/*
 * @Description: H5 外壳 —— hash 路由与启用状态（框架无关的小 store）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/mobile/route.ts
 *
 * 宿主没有 URL 路由，导航全在内存里；手机上返回键 / 侧滑返回只认浏览器历史。
 * 所以三级页面用 hash 记在历史里：#/ 工作区列表、#/w/<id> 会话列表、#/s/<id> 会话。
 */

export type Route = { level: 'home' } | { level: 'sessions'; workspaceId: string } | { level: 'session'; sessionId: string }

export function parseRoute(hash: string): Route {
  const m = /^#\/(w|s)\/(.+)$/.exec(hash)
  if (m === null) return { level: 'home' }
  const id = decodeURIComponent(m[2]!)
  return m[1] === 'w' ? { level: 'sessions', workspaceId: id } : { level: 'session', sessionId: id }
}

export function routeHash(route: Route): string {
  if (route.level === 'sessions') return `#/w/${encodeURIComponent(route.workspaceId)}`
  if (route.level === 'session') return `#/s/${encodeURIComponent(route.sessionId)}`
  return '#/'
}

/** 视口小于它才启用 H5 外壳（与宿主右栏自动全屏的断点一致）。 */
export const H5_MAX_WIDTH = 768
/** 用户选择「桌面版」的偏好（按设备记在浏览器里）。 */
const DESKTOP_PREF = 'dshws.h5.desktop'

export interface ShellState {
  /** 是否经局域网代理访问（whoami 结论）。 */
  proxied: boolean
  narrow: boolean
  preferDesktop: boolean
  route: Route
  /** 进入当前页面时是否由外壳自己 push 过历史（决定「返回」用 history.back 还是改写 hash）。 */
  depth: number
  /** 最近一次切页的方向：决定滑入动画从右（进入下一级）还是从左（返回上一级）。 */
  direction: Direction
}

export type Direction = 'forward' | 'back' | 'none'

const RANK = { home: 0, sessions: 1, session: 2 } as const

/** 按层级判断方向；同级（会话之间切换）视为前进。 */
export function directionOf(from: Route, to: Route): Direction {
  return RANK[to.level] < RANK[from.level] ? 'back' : 'forward'
}

type Listener = () => void

function readPref(): boolean {
  try {
    return localStorage.getItem(DESKTOP_PREF) === '1'
  } catch {
    return false
  }
}

export function createShellStore() {
  let state: ShellState = {
    proxied: false,
    narrow: typeof window !== 'undefined' && window.innerWidth < H5_MAX_WIDTH,
    preferDesktop: readPref(),
    route: typeof location !== 'undefined' ? parseRoute(location.hash) : { level: 'home' },
    depth: 0,
    direction: 'none'
  }
  const listeners = new Set<Listener>()
  const set = (patch: Partial<ShellState>): void => {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }
  const sync = (): void => {
    const route = parseRoute(location.hash)
    if (routeHash(route) !== routeHash(state.route)) set({ route, depth: Math.max(0, state.depth - 1), direction: directionOf(state.route, route) })
  }
  const onResize = (): void => {
    const narrow = window.innerWidth < H5_MAX_WIDTH
    if (narrow !== state.narrow) set({ narrow })
  }
  const store = {
    getSnapshot: (): ShellState => state,
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    active: (): boolean => state.proxied && state.narrow && !state.preferDesktop,
    setProxied: (proxied: boolean): void => set({ proxied }),
    setPreferDesktop(value: boolean): void {
      try {
        if (value) localStorage.setItem(DESKTOP_PREF, '1')
        else localStorage.removeItem(DESKTOP_PREF)
      } catch {
        /* 隐私模式 */
      }
      set({ preferDesktop: value })
    },
    /** 前进到新页面（写入历史，返回键可回退）；replace=true 时只改写当前条目。 */
    go(route: Route, replace = false): void {
      const hash = routeHash(route)
      if (hash === routeHash(state.route) && location.hash === hash) return
      if (replace) history.replaceState(history.state, '', hash)
      else history.pushState(history.state, '', hash)
      set({ route, depth: replace ? state.depth : state.depth + 1, direction: directionOf(state.route, route) })
    },
    /** 返回上一级：自己 push 过就 history.back（与返回键一致），否则（刷新后直达）改写到上级。 */
    back(parent: Route): void {
      if (state.depth > 0) history.back()
      else store.go(parent, true)
    },
    install(): () => void {
      window.addEventListener('popstate', sync)
      window.addEventListener('hashchange', sync)
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('popstate', sync)
        window.removeEventListener('hashchange', sync)
        window.removeEventListener('resize', onResize)
      }
    }
  }
  return store
}

export type ShellStore = ReturnType<typeof createShellStore>
