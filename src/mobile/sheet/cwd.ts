/*
 * @Description: H5 抽屉 —— 会话 cwd 缓存（RemoteIndex 判定远程 / 本机工作区、解析相对路径的数据源）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:55:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/cwd.ts
 *
 * 独立成文件且只依赖 net/rpc：index.ts 对外导出 primeSessionCwd，不能因此把 env.ts（复用组件、样式）拖进首屏分片。
 */
import { rpc } from '../net/rpc.js'

const cwds = new Map<string, string>()
const listeners = new Set<() => void>()
let listLoad: Promise<void> | undefined

interface SessionRow {
  sessionId?: unknown
  cwd?: unknown
}

/** 从 session/list 的返回里取行（兼容数组 / {sessions} / {items} / {rows}）。 */
export function rowsOf(value: unknown): SessionRow[] {
  if (Array.isArray(value)) return value as SessionRow[]
  const v = value as { sessions?: unknown; items?: unknown; rows?: unknown } | null
  for (const k of ['sessions', 'items', 'rows'] as const) {
    const list = v?.[k]
    if (Array.isArray(list)) return list as SessionRow[]
  }
  return []
}

function setCwd(sessionId: string, cwd: string): void {
  if (cwds.get(sessionId) === cwd) return
  cwds.set(sessionId, cwd)
  for (const l of [...listeners]) l()
}

/** 外部（首页 / 会话页数据层）已知 cwd 时预先填入。 */
export function primeSessionCwd(sessionId: string, cwd: string | undefined): void {
  if (cwd !== undefined && cwd !== '') setCwd(sessionId, cwd)
}

/**
 * 确保拿到某会话的 cwd：缓存命中直接返回；否则拉一次 session/list（只在打开抽屉且缓存缺失时发生，并发合并）。
 */
export async function ensureSessionCwd(sessionId: string): Promise<string | undefined> {
  const hit = cwds.get(sessionId)
  if (hit !== undefined) return hit
  if (listLoad === undefined) {
    listLoad = rpc<unknown>('session/list', { _request: {} })
      .then((value) => {
        for (const row of rowsOf(value)) {
          if (typeof row.sessionId === 'string' && typeof row.cwd === 'string' && row.cwd !== '') setCwd(row.sessionId, row.cwd)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        listLoad = undefined
      })
  }
  await listLoad
  return cwds.get(sessionId)
}

/** 冒充宿主 sessions 服务的最小形状（RemoteIndex 只用 list.getSnapshot().byId[id].cwd 与 subscribe）。 */
export const sessionsService = {
  list: {
    getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } {
      const byId: Record<string, { cwd?: string }> = {}
      for (const [id, cwd] of cwds) byId[id] = { cwd }
      return { byId }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
