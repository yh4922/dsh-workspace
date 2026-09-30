/*
 * @Description: 交付卡片 ▾ 菜单对远程文件的接管 ——「打开」→ 侧栏预览，「显示文件位置」→ 插件「文件管理」里定位
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/present-actions.ts
 *
 * 为什么包装 fetch：卡片的 ▾ 控件（dsh-client-ui-open-in-app 的 FileRouteAction 与 deliverables 的
 * PresentedOpenController）直接调用全局 fetch('api/present.open?sessionId&seq&index[&action=reveal]')，
 * 宿主没有提供可替换的回调；插件又没有宿主 → 浏览器的推送通道，服务端拦截后无法驱动界面。
 * 所以只在浏览器端、只对这一个路径、只对「远程工作区会话里的远程文件」接管，其余请求一律原样放行：
 *   - GET（查询关联应用）→ 返回一个「侧栏预览」应用（默认），菜单里就有「侧栏预览」和「显示文件位置」
 *   - POST action=reveal → 打开「文件管理」并定位到该文件
 *   - POST 其他（默认打开 / 选了「侧栏预览」）→ 在侧栏打开远程预览
 * 查询失败（旧宿主、会话不在、网络）一律放行给宿主 —— 最差也就是回到接管前的报错，不会更糟。
 */
import type { WorkspaceApi } from '../api.js'
import { sessionFileAddress, type RemoteIndex } from './remote-index.js'

/** 宿主卡片文件动作路由（dsh-client-ui-deliverables 的 PRESENT_OPEN_PATH）。 */
export const PRESENT_OPEN_SUFFIX = '/api/present.open'
/** 返回给 ▾ 菜单的「应用」id：选中它时 POST 带 application=该 id。 */
export const SIDEBAR_PREVIEW_APP_ID = 'dsh-workspace:sidebar-preview'

export interface PresentActionDeps {
  index: RemoteIndex
  api: Pick<WorkspaceApi, 'call'>
  /** 在侧栏打开文件地址。 */
  openResource(address: string): void
  /** 打开「文件管理」并定位到远程路径。 */
  revealInFiles(sessionId: string, remotePath: string): void
  /**
   * 「显示文件位置」能否真的定位：文件在卡片所在工作区的根下，且当前显示的会话是同一个工作区
   * （文件管理按当前会话打开）。不能时回 422，宿主提示「请在侧边栏预览」，而不是假装成功。
   */
  canReveal(sessionId: string, remotePath: string): boolean
  /** 菜单里「侧栏预览」的名称。 */
  previewLabel(): string
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 解析 ▾ 请求；不是卡片文件动作返回 undefined。 */
export function parsePresentRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  base: string
): { method: 'GET' | 'POST'; sessionId: string; seq: number; index: number; action: 'open' | 'reveal'; application?: string } | undefined {
  // 宿主传的是字符串；Request 对象不是卡片发的，不碰（也避免消费它的 body）。
  if (typeof input !== 'string' && !(input instanceof URL)) return undefined
  let url: URL
  try {
    url = new URL(String(input), base)
  } catch {
    return undefined
  }
  if (!url.pathname.endsWith(PRESENT_OPEN_SUFFIX)) return undefined
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') return undefined
  const q = url.searchParams
  const sessionId = q.get('sessionId')
  const seq = Number(q.get('seq'))
  const index = Number(q.get('index'))
  if (sessionId === null || sessionId === '' || !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(index) || index < 0) return undefined
  const action = q.get('action') === 'reveal' ? 'reveal' : 'open'
  const application = q.get('application') ?? undefined
  return { method, sessionId, seq, index, action, ...(application !== undefined ? { application } : {}) }
}

/**
 * 处理一次请求：接管时返回 Response，放行时返回 undefined。
 * 先做同步判断（是否远程工作区会话），本地会话不发任何 RPC。
 */
export async function handlePresentRequest(
  req: NonNullable<ReturnType<typeof parsePresentRequest>>,
  deps: PresentActionDeps,
  lookup: (sessionId: string, seq: number, index: number) => Promise<string | null>
): Promise<Response | undefined> {
  if (deps.index.bySession(req.sessionId) === undefined) return undefined
  let remotePath: string | null
  try {
    remotePath = await lookup(req.sessionId, req.seq, req.index)
  } catch {
    return undefined
  }
  if (remotePath === null) return undefined // 远程会话里交付的本机文件：交还宿主原生打开
  if (req.method === 'GET') {
    // 不用 Response.json 静态方法：Safari 17 以下没有（纯 Web 访问时）。
    const body = JSON.stringify([{ id: SIDEBAR_PREVIEW_APP_ID, name: deps.previewLabel(), default: true, icon: null }])
    return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
  if (req.action === 'reveal') {
    // 422 = 宿主的「没有可用的主机路径」：卡片提示在侧边栏预览，与实际情况相符。
    if (!deps.canReveal(req.sessionId, remotePath)) return new Response(null, { status: 422, headers: { 'cache-control': 'no-store' } })
    deps.revealInFiles(req.sessionId, remotePath)
  } else {
    deps.openResource(sessionFileAddress(req.sessionId, remotePath))
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

/** 全局只装一层包装：插件热更新 / 重复加载时替换依赖，而不是一层层套上去。 */
const INSTALLED = Symbol.for('dsh-workspace.present-actions')
interface Installed {
  deps: PresentActionDeps
  wrapped: Fetch
  original: Fetch
}

/**
 * 安装 fetch 包装。返回撤销函数：只有当前 fetch 仍是本包装时才还原，
 * 避免把之后别的插件装上的包装一并撤掉。
 */
export function installPresentActions(deps: PresentActionDeps, target: { fetch: Fetch } = globalThis as unknown as { fetch: Fetch }): () => void {
  const holder = target as unknown as Record<symbol, Installed | undefined>
  const uninstall = (s: Installed): void => {
    // 只有当前 fetch 仍是本包装时才还原：之后别的插件又套了一层的话，不能把它一起撤掉。
    if (target.fetch === s.wrapped) target.fetch = s.original
    if (holder[INSTALLED] === s) holder[INSTALLED] = undefined
  }
  const existing = holder[INSTALLED]
  // 已经装过（热更新时新实例先装、旧实例后卸）：只换依赖，不再套一层。
  // 旧实例卸载时依赖已不是它的 → 什么都不做；最后装的实例卸载时才真正还原 fetch。
  if (existing !== undefined && target.fetch === existing.wrapped) {
    existing.deps = deps
    return () => {
      if (existing.deps === deps) uninstall(existing)
    }
  }
  const original = target.fetch
  if (typeof original !== 'function') return () => undefined
  // 同一个交付文件的路径不会变（事件是只读日志）：按坐标缓存，▾ 菜单反复打开不再发 RPC。
  const cache = new Map<string, Promise<string | null>>()
  const state: Installed = { deps, original, wrapped: undefined as unknown as Fetch }
  const lookup = (sessionId: string, seq: number, index: number): Promise<string | null> => {
    const key = `${sessionId}\n${seq}\n${index}`
    let hit = cache.get(key)
    if (hit === undefined) {
      hit = state.deps.api.call('presentedFile', { sessionId, seq, index }).then((r) => r.remote?.remotePath ?? null)
      // 失败不缓存：下次点击重试。
      hit.catch(() => cache.delete(key))
      cache.set(key, hit)
    }
    return hit
  }
  state.wrapped = async (input, init) => {
    const req = parsePresentRequest(input, init, typeof location !== 'undefined' ? location.href : 'http://localhost/')
    if (req !== undefined) {
      const handled = await handlePresentRequest(req, state.deps, lookup).catch(() => undefined)
      if (handled !== undefined) return handled
    }
    return await original.call(target, input, init)
  }
  target.fetch = state.wrapped
  holder[INSTALLED] = state
  return () => {
    if (state.deps === deps) uninstall(state)
  }
}
