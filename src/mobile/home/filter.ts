/*
 * @Description: H5 首页 —— 列表筛选与分组（纯函数）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:45:00
 * @FilePath: /dsh-workspace/src/mobile/home/filter.ts
 */
import type { SessionMeta } from '../data/sessions.js'

/** chip「全部」。 */
export const ALL = '*'
/** 分组视图里没有工作区归属的会话。 */
export const NO_WORKSPACE = ''

export interface Chip {
  id: string
  label: string
}

/** 隐藏归档；按工作区 chip 与标题关键字（忽略大小写）过滤。保持输入顺序。 */
export function filterSessions(list: readonly SessionMeta[], workspaceId: string, query: string): SessionMeta[] {
  const q = query.trim().toLowerCase()
  return list.filter((m) => !m.archived && (workspaceId === ALL || (m.workspaceId ?? NO_WORKSPACE) === workspaceId) && (q === '' || m.title.toLowerCase().includes(q)))
}

export interface Group {
  id: string
  title: string
  items: SessionMeta[]
}

/** 按工作区分组：组内保持原顺序（已按置顶 / 活跃排序），组按其最新会话的活跃时间排序。 */
export function groupByWorkspace(list: readonly SessionMeta[]): Group[] {
  const map = new Map<string, Group>()
  for (const m of list) {
    const id = m.workspaceId ?? NO_WORKSPACE
    let g = map.get(id)
    if (g === undefined) {
      g = { id, title: m.workspaceTitle ?? '未归属工作区', items: [] }
      map.set(id, g)
    }
    g.items.push(m)
  }
  const latest = (g: Group): number => Math.max(...g.items.map((m) => m.updatedAt))
  return [...map.values()].sort((a, b) => latest(b) - latest(a))
}

/** 工作区 chip：「全部」+ 工作区（优先用 workspace/follow 的顺序；未到时从列表推导）。 */
export function buildChips(workspaces: readonly { workspaceId: string; label: string }[] | undefined, list: readonly SessionMeta[]): Chip[] {
  const chips: Chip[] = [{ id: ALL, label: '全部' }]
  if (workspaces !== undefined) {
    for (const w of workspaces) chips.push({ id: w.workspaceId, label: w.label })
    return chips
  }
  const seen = new Set<string>()
  for (const m of list) {
    if (m.workspaceId === undefined || seen.has(m.workspaceId)) continue
    seen.add(m.workspaceId)
    chips.push({ id: m.workspaceId, label: m.workspaceTitle ?? m.workspaceId })
  }
  return chips
}
