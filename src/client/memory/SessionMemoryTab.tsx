/*
 * @Description: 会话顶部「记忆」tab —— 看板布局：顶部概览 + 待审核 / 会话记忆 / 项目 / 全局 四列
 * @Author: YangHeng
 * @Date: 2026-10-16 21:15:00
 * @FilePath: /dsh-workspace/src/client/memory/SessionMemoryTab.tsx
 *
 * 只用于会话顶部标签（远程工作区页的「记忆」页签仍是导航 + 板块布局）。
 * 布局：宽屏四列各自滚动；中等宽度两列两行；窄屏（≤640px）列头变成分段切换，一次只看一列。
 * 后台总结、助手工具随时会写入：可见时每 5 秒拉一次（数据量小，一次调用拿全）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { memoryCaller } from './api.js'
import { AddDialog, CandidateList, EmptyState, EntryList, IconChat, IconFolder, IconGlobe, IconInbox, IconLayers, IconPlus, IconSpark, type MemoryViewEnv } from './views.js'
import type { MemoryScope, SessionMemoryView } from '../../wire/memory.js'

const POLL_MS = 5000

export interface SessionMemoryTabProps {
  t: Translate
  api: WorkspaceApi
  sessionId: string
}

type Column = 'pending' | 'session' | 'project' | 'global'

/** 一列：列头（图标 + 标题 + 计数 + 说明 + 操作）+ 可滚动正文。 */
function BoardColumn(props: { id: Column; active: boolean; title: string; hint: string; icon: ReactNode; count: number; tone?: 'accent'; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="dshws-mem-col" data-col={props.id} data-active={props.active} data-tone={props.tone}>
      <header className="dshws-mem-col-head">
        <span className="dshws-mem-panel-icon">{props.icon}</span>
        <span className="dshws-mem-panel-titles">
          <span className="dshws-mem-panel-title">
            {props.title}
            <span className="dshws-mem-panel-count">{props.count}</span>
          </span>
          <span className="dshws-mem-panel-sub" title={props.hint}>
            {props.hint}
          </span>
        </span>
        {props.actions !== undefined ? <span className="dshws-mem-col-actions">{props.actions}</span> : null}
      </header>
      <div className="dshws-mem-col-body">{props.children}</div>
    </section>
  )
}

export function SessionMemoryTab(props: SessionMemoryTabProps) {
  const { t, sessionId } = props
  const call = useMemo(() => memoryCaller(props.api.call.bind(props.api)), [props.api])
  const [view, setView] = useState<SessionMemoryView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** 窄屏下当前显示的列（宽屏忽略）。 */
  const [column, setColumn] = useState<Column>('session')
  const [adding, setAdding] = useState<MemoryScope | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** 首次加载时若有待审核，窄屏默认先看待审核（用户要主动处理的）。 */
  const pickedInitial = useRef(false)

  const load = useCallback(() => {
    void call({ op: 'sessionView', sessionId }).then(
      (v) => {
        setView(v)
        setError(null)
        if (!pickedInitial.current) {
          pickedInitial.current = true
          if (v.candidates.length > 0) setColumn('pending')
        }
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
  }, [call, sessionId])

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => () => clearTimeout(timer.current), [])

  const notify = (text: string): void => {
    setMessage(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(null), 2500)
  }
  const env: MemoryViewEnv = {
    t,
    call,
    refresh: load,
    notify,
    onError: (e) => notify(t('error.generic', { message: e instanceof Error ? e.message : String(e) }))
  }

  if (view === null) return <div className="dshws-mem-board-host"><div className="dshws-mem-board"><EmptyState text={error ?? t('memory.loading')} /></div></div>
  if (!view.enabled) return <div className="dshws-mem-board-host"><div className="dshws-mem-board"><EmptyState text={t('memory.disabledHint')} /></div></div>

  const enabledOf = (list: Array<{ enabled: boolean }>): number => list.filter((e) => e.enabled).length
  const bulk = (op: 'approveAll' | 'rejectAll'): void => {
    setBulkBusy(true)
    void call({ op, sessionId })
      .then((r) => {
        notify(t(op === 'approveAll' ? 'memory.approvedN' : 'memory.rejectedN', { n: String(r.count) }))
        load()
      }, env.onError)
      .finally(() => setBulkBusy(false))
  }
  const addButton = (scope: MemoryScope, label: string) => (
    <button type="button" className="dshws-mem-col-add" title={label} aria-label={label} onClick={() => setAdding(scope)}>
      <IconPlus />
    </button>
  )

  const columns: Array<{ id: Column; label: string; count: number; icon: ReactNode; accent?: boolean }> = [
    { id: 'pending', label: t('memory.colPending'), count: view.candidates.length, icon: <IconInbox />, accent: view.candidates.length > 0 },
    { id: 'session', label: t('memory.colSession'), count: view.session.length, icon: <IconChat /> },
    { id: 'project', label: t('memory.colProject'), count: view.projectEntries.length, icon: <IconFolder /> },
    { id: 'global', label: t('memory.colGlobal'), count: view.globalEntries.length, icon: <IconGlobe /> }
  ]

  return (
    // 外壳是尺寸容器：断点跟随标签实际宽度（侧栏挤压时也生效）
    <div className="dshws-mem-board-host">
    <div className="dshws-mem-board">
      {message !== null ? <div className="dshws-mem-toast">{message}</div> : null}

      {/* ---------- 会话关联记忆概览 ---------- */}
      <section className="dshws-mem-overview">
        <div className="dshws-mem-overview-main">
          <span className="dshws-mem-hero-icon">
            <IconLayers />
          </span>
          <div className="dshws-mem-hero-text">
            <div className="dshws-mem-hero-title">
              {t('memory.overviewTitle')}
              {view.summarizing ? (
                <span className="dshws-mem-badge" data-tone="accent">
                  <span className="dshws-mem-spin" />
                  {t('memory.summarizing')}
                </span>
              ) : null}
            </div>
            <div className="dshws-mem-hero-sub">
              {view.project !== null ? t('memory.tabSubProject', { project: view.project.title }) : t('memory.tabSubLoose')}
              {' · '}
              {t('memory.overviewInjected', { n: String(enabledOf(view.session) + enabledOf(view.projectEntries) + enabledOf(view.globalEntries)) })}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            icon={<IconSpark />}
            disabled={view.summarizing}
            onClick={() =>
              void call({ op: 'reorganize', sessionId }).then((r) => {
                notify(r.started ? t('memory.reorganizeStarted') : r.reason ?? t('memory.reorganizeBusy'))
                load()
              }, env.onError)
            }
          >
            {t('memory.reorganize')}
          </Button>
        </div>
        {/* 概览里的四个数字同时是窄屏的列切换器：点哪个看哪列 */}
        <div className="dshws-mem-overview-stats" role="tablist" aria-label={t('memory.tab')}>
          {columns.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              className="dshws-mem-ostat"
              aria-selected={column === c.id}
              data-active={column === c.id}
              data-tone={c.accent === true ? 'accent' : undefined}
              onClick={() => {
                setColumn(c.id)
                // 宽屏下列都在：滚到对应列，保持「点了有反应」
                document.querySelector(`.dshws-mem-col[data-col="${c.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
              }}
            >
              <span className="dshws-mem-ostat-icon">{c.icon}</span>
              <span className="dshws-mem-ostat-value">{c.count}</span>
              <span className="dshws-mem-ostat-label">{c.label}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ---------- 四列看板 ---------- */}
      <div className="dshws-mem-cols">
        <BoardColumn
          id="pending"
          active={column === 'pending'}
          title={t('memory.colPending')}
          hint={t('memory.colPendingHint')}
          icon={<IconInbox />}
          count={view.candidates.length}
          {...(view.candidates.length > 0 ? { tone: 'accent' as const } : {})}
          {...(view.candidates.length > 0
            ? {
                actions: (
                  <>
                    <button type="button" className="dshws-link-btn" data-tone="muted" disabled={bulkBusy} onClick={() => bulk('rejectAll')}>
                      {t('memory.rejectAll')}
                    </button>
                    <button type="button" className="dshws-link-btn" disabled={bulkBusy} onClick={() => bulk('approveAll')}>
                      {t('memory.approveAll')}
                    </button>
                  </>
                )
              }
            : {})}
        >
          <CandidateList env={env} candidates={view.candidates} sessionId={sessionId} toolbar={false} {...(view.project !== null ? { projectTitles: { [view.project.id]: view.project.title } } : {})} />
        </BoardColumn>

        <BoardColumn id="session" active={column === 'session'} title={t('memory.colSession')} hint={t('memory.sessionHint')} icon={<IconChat />} count={view.session.length} actions={addButton({ layer: 'session', sessionId }, t('memory.add'))}>
          <EntryList env={env} scope={{ layer: 'session', sessionId }} entries={view.session} canPromoteProject={view.project !== null} emptyText={t('memory.sessionEmpty')} toolbar={false} />
        </BoardColumn>

        <BoardColumn
          id="project"
          active={column === 'project'}
          title={view.project !== null ? `${t('memory.colProject')} · ${view.project.title}` : t('memory.colProject')}
          hint={view.project !== null ? t('memory.projectHint') : t('memory.tabSubLoose')}
          icon={<IconFolder />}
          count={view.projectEntries.length}
          {...(view.project !== null ? { actions: addButton({ layer: 'project', projectId: view.project.id }, t('memory.add')) } : {})}
        >
          {view.project !== null ? (
            <EntryList env={env} scope={{ layer: 'project', projectId: view.project.id }} entries={view.projectEntries} toolbar={false} emptyText={t('memory.projectEmpty')} />
          ) : (
            <EmptyState text={t('memory.noProjectForSession')} icon={<IconFolder />} />
          )}
        </BoardColumn>

        <BoardColumn id="global" active={column === 'global'} title={t('memory.colGlobal')} hint={t('memory.globalHint')} icon={<IconGlobe />} count={view.globalEntries.length} actions={addButton({ layer: 'global' }, t('memory.add'))}>
          <EntryList env={env} scope={{ layer: 'global' }} entries={view.globalEntries} toolbar={false} emptyText={t('memory.globalEmpty')} />
        </BoardColumn>
      </div>

      {adding !== null ? <AddDialog env={env} scope={adding} onClose={() => setAdding(null)} /> : null}
    </div>
    </div>
  )
}
