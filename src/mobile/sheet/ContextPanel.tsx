/*
 * @Description: H5 抽屉 · 上下文面板 —— 占比条、token 用量、当前模型、dsh-context 分类占比（可选）、会话记忆、压缩上下文
 * @Author: YangHeng
 * @Date: 2026-11-19 16:20:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/ContextPanel.tsx
 *
 * 刷新策略取简：面板可见时每 5 秒拉一次 session/projections（数据量小），不订阅 session/control 流。
 * dsh-context 未安装 / 接口失败 → 分类块整体隐藏，不报错。会话记忆走插件 memory 方法的 sessionView。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionMemoryView } from '../../wire/memory.js'
import { memoryCaller } from '../../client/memory/api.js'
import { rpc, wsApi } from '../net/rpc.js'
import { categoryShares, formatTokens, projectionView, type CategoryShare, type ProjectionView } from './context-data.js'
import type { PanelProps } from './panel.js'

const POLL_MS = 5000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadDetail(sessionId: string): Promise<CategoryShare[]> {
  // 宿主线协议未确认 detail 的形参名：先按 {sessionId}，不认再试 {request:{sessionId}}；都失败视为不可用。
  for (const args of [{ sessionId }, { request: { sessionId } }]) {
    try {
      const shares = categoryShares(await rpc<unknown>('dsh-context/detail', args))
      if (shares.length > 0) return shares
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404) return []
    }
  }
  return []
}

export default function ContextPanel(props: PanelProps) {
  const { sessionId, active } = props
  // 直接用 wsApi，不 import env.ts：上下文面板不需要复用组件与样式，避免拖进那个大分片。
  const memory = useMemo(() => memoryCaller((method, payload) => wsApi(method, payload)), [])
  const [proj, setProj] = useState<ProjectionView | null>(null)
  const [projError, setProjError] = useState<string | null>(null)
  const [shares, setShares] = useState<CategoryShare[]>([])
  const [mem, setMem] = useState<SessionMemoryView | null>(null)
  const [compact, setCompact] = useState<'idle' | 'busy' | 'done' | string>('idle')

  const load = useCallback(() => {
    void rpc<unknown>('session/projections', { request: { sessionId } }).then(
      (v) => {
        setProj(projectionView(v))
        setProjError(null)
      },
      (e: unknown) => setProjError(errorText(e))
    )
    void loadDetail(sessionId).then(setShares)
    void memory({ op: 'sessionView', sessionId }).then(setMem, () => setMem(null))
  }, [memory, sessionId])

  useEffect(() => {
    if (!active) return
    load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [active, load])

  const runCompact = (): void => {
    if (!window.confirm('压缩上下文会用摘要替换较早的对话内容，确定继续？')) return
    setCompact('busy')
    void rpc('commands/execute', { agentId: sessionId, line: '/compact', submittedAttachments: [] }).then(
      () => {
        setCompact('done')
        load()
      },
      (e: unknown) => setCompact(`失败：${errorText(e)}`)
    )
  }

  const pressure = proj?.pressure
  const pct = pressure === undefined ? 0 : Math.min(100, Math.round(pressure.ratio * 100))
  const tone = pressure === undefined ? undefined : pressure.ratio >= 0.85 ? 'error' : pressure.ratio >= 0.6 ? 'warn' : 'ok'
  const shareTotal = shares.reduce((s, c) => s + c.tokens, 0)

  return (
    <div className="m-sheet-scroll m-ctx">
      <section className="m-ctx-card">
        <div className="m-ctx-head">
          <b>上下文占用</b>
          <span>{pressure === undefined ? '—' : `${formatTokens(pressure.used)} / ${formatTokens(pressure.window)}（${Math.round(pressure.ratio * 100)}%）`}</span>
        </div>
        <div className="m-ctx-bar" data-tone={tone}>
          <i style={{ width: `${pct}%` }} />
        </div>
        {proj?.model !== undefined ? <div className="m-ctx-sub">模型：{proj.model}</div> : null}
        {projError !== null ? <div className="m-sheet-note" data-tone="error">{projError}</div> : null}
        <div className="m-ctx-actions">
          <button type="button" className="m-sheet-btn" disabled={compact === 'busy'} onClick={runCompact}>
            {compact === 'busy' ? '压缩中…' : '压缩上下文'}
          </button>
          {compact === 'done' ? <span className="m-ctx-sub">已提交压缩</span> : null}
          {compact !== 'idle' && compact !== 'busy' && compact !== 'done' ? <span className="m-ctx-sub" data-tone="error">{compact}</span> : null}
        </div>
      </section>

      {shares.length > 0 ? (
        <section className="m-ctx-card">
          <div className="m-ctx-head">
            <b>分类占比</b>
            <span>{formatTokens(shareTotal)}</span>
          </div>
          <div className="m-ctx-stack">
            {shares.map((c) => (
              <i key={c.key} data-cat={c.key} style={{ flexGrow: c.tokens }} title={c.label} />
            ))}
          </div>
          {shares.map((c) => (
            <div key={c.key} className="m-ctx-row">
              <span className="m-ctx-dot" data-cat={c.key} />
              <span>{c.label}</span>
              <em>
                {formatTokens(c.tokens)} · {Math.round((c.tokens / shareTotal) * 100)}%
              </em>
            </div>
          ))}
        </section>
      ) : null}

      {proj?.usage !== undefined ? (
        <section className="m-ctx-card">
          <div className="m-ctx-head">
            <b>Token 用量</b>
          </div>
          {(
            [
              ['输入（未缓存）', proj.usage.uncachedInputTokens],
              ['缓存读取', proj.usage.cacheReadTokens],
              ['缓存写入', proj.usage.cacheWriteTokens],
              ['输出', proj.usage.outputTokens]
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="m-ctx-row">
              <span>{label}</span>
              <em>{formatTokens(n)}</em>
            </div>
          ))}
        </section>
      ) : null}

      {mem !== null && mem.enabled ? (
        <section className="m-ctx-card">
          <div className="m-ctx-head">
            <b>会话记忆</b>
            <span>
              {mem.summarizing ? '总结中 · ' : ''}项目 {mem.projectEntries.length} · 全局 {mem.globalEntries.length}
              {mem.candidates.length > 0 ? ` · 待审核 ${mem.candidates.length}` : ''}
            </span>
          </div>
          {mem.session.length === 0 ? <div className="m-ctx-sub">本会话暂无记忆</div> : null}
          {mem.session.map((e) => (
            <div key={e.id} className="m-ctx-mem" data-off={!e.enabled}>
              {e.title !== undefined && e.title !== '' ? <b>{e.title}</b> : null}
              <p>{e.content}</p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}
