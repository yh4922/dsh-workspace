/*
 * @Description: H5 抽屉 · 上下文面板的数据整形（纯函数，便于单测）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:15:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/context-data.ts
 *
 * 数据源都是非公开契约（宿主会话投影、dsh-context 插件），形状随 DSH 升级可能变化：
 * 这里只做「认得就用、认不得就当没有」的宽松解析，界面据此隐藏对应块而不报错。
 */

export interface ContextPressure {
  used: number
  window: number
  /** 0~1，可能超过 1（已超窗口）。 */
  ratio: number
}

export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ProjectionView {
  pressure?: ContextPressure
  usage?: TokenUsage
  model?: string
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** session/projections 返回值（{kind, asOfSeq, values} 或直接 values）→ 面板视图。 */
export function projectionView(result: unknown): ProjectionView {
  const outer = obj(result)
  const values = obj(outer?.values) ?? outer ?? {}
  const view: ProjectionView = {}

  const p = obj(values.contextPressure)
  const window = num(p?.contextWindow)
  const used = num(p?.pressureTokens) ?? num(p?.projectedTokens)
  if (window !== undefined && window > 0 && used !== undefined) view.pressure = { used, window, ratio: used / window }

  const u = obj(values.tokenUsage)
  if (u !== undefined) {
    view.usage = {
      uncachedInputTokens: num(u.uncachedInputTokens) ?? 0,
      outputTokens: num(u.outputTokens) ?? 0,
      cacheReadTokens: num(u.cacheReadTokens) ?? 0,
      cacheWriteTokens: num(u.cacheWriteTokens) ?? 0
    }
  }

  const m = values.modelSelection
  if (typeof m === 'string' && m !== '') view.model = m
  else {
    const sel = obj(m)
    const model = typeof sel?.model === 'string' ? sel.model : undefined
    if (model !== undefined && model !== '') {
      const provider = typeof sel?.provider === 'string' && sel.provider !== '' ? `${sel.provider} / ` : ''
      const effort = typeof sel?.reasoningEffort === 'string' && sel.reasoningEffort !== '' ? ` · ${sel.reasoningEffort}` : ''
      view.model = `${provider}${model}${effort}`
    }
  }
  return view
}

export interface CategoryShare {
  key: string
  label: string
  tokens: number
}

const CATEGORY_LABELS: Record<string, string> = {
  system: '系统提示词',
  tools: '工具定义',
  user: '用户消息',
  inject: '注入内容',
  skill: '技能',
  assistant: '助手回复',
  tool: '工具结果'
}

/**
 * dsh-context detail / head → 分类占比。认得的形状：{sums:{user,inject,skill,assistant,tool}, systemTokens?, toolsTokens?}，
 * 也接受包在 head / timeline / value 里。认不出返回空数组（界面隐藏该块）。
 */
export function categoryShares(result: unknown): CategoryShare[] {
  const seen = new Set<unknown>()
  const find = (v: unknown, depth: number): Record<string, unknown> | undefined => {
    const o = obj(v)
    if (o === undefined || depth > 3 || seen.has(o)) return undefined
    seen.add(o)
    if (obj(o.sums) !== undefined) return o
    for (const k of ['head', 'timeline', 'value', 'state', 'snapshot']) {
      const hit = find(o[k], depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const host = find(result, 0)
  if (host === undefined) return []
  const out: CategoryShare[] = []
  const push = (key: string, v: unknown): void => {
    const n = num(v)
    if (n !== undefined && n > 0) out.push({ key, label: CATEGORY_LABELS[key] ?? key, tokens: n })
  }
  push('system', host.systemTokens)
  push('tools', host.toolsTokens)
  for (const [k, v] of Object.entries(obj(host.sums) ?? {})) push(k, v)
  return out
}

/** 1234 → 1.2k；1234567 → 1.23M。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}
