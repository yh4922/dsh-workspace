/*
 * @Description: H5 —— 首页（最近会话：筛选 / 搜索 / 最近与按工作区视图 / 置顶归档 / 新建 / 下拉刷新）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:18:00
 * @FilePath: /dsh-workspace/src/mobile/pages/Home.tsx
 *
 * 数据：data/workspaces（workspace/follow 流）+ data/sessions（session/list + 本地缓存）。
 * list 未到达（且没有缓存）时只显示骨架，不按工作区顺序先排一版——避免旧版「先乱排再跳动」。
 */
import { useEffect, useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react'
import { useApprovals } from '../data/approvals.js'
import { isAuthError, refreshSessions, useSessions, type SessionMeta } from '../data/sessions.js'
import { archiveSession, createSession, pinSession, retryWorkspaces, unpinSession, useWorkspaces, workspaceLabel } from '../data/workspaces.js'
import { switchToDesktop } from '../desktop.js'
import { ALL, buildChips, filterSessions, groupByWorkspace } from '../home/filter.js'
import { SessionCard, SessionSkeleton } from '../home/SessionCard.js'
import { WorkspacePicker } from '../home/WorkspacePicker.js'
import { BrandMark, Icon } from '../icons.js'
import { navigate } from '../router.js'

type ViewMode = 'recent' | 'group'
const VIEW_KEY = 'dshws.m.home.view'
const PULL_TRIGGER = 56

/** 右上角菜单：「切换桌面版」放在这里，免得误触（切过去 30 天都不会自动回来）。 */
function HomeMenu() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // 下一帧再挂：避免打开菜单的那次点击冒泡上来立刻把它关掉。
    const id = requestAnimationFrame(() => document.addEventListener('click', close))
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('click', close)
    }
  }, [open])
  return (
    <div className="m-menu">
      <button type="button" className="m-icon-btn" aria-label="更多" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="ellipsis" size={20} />
      </button>
      {open ? (
        <div className="m-menu-pop" role="menu">
          <button type="button" role="menuitem" className="m-menu-item" onClick={() => void refreshSessions()}>
            <Icon name="refreshCw" size={16} />
            刷新列表
          </button>
          <button type="button" role="menuitem" className="m-menu-item" onClick={switchToDesktop}>
            <Icon name="monitor" size={16} />
            切换桌面版
          </button>
        </div>
      ) : null}
    </div>
  )
}

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'group' ? 'group' : 'recent'
  } catch {
    return 'recent'
  }
}

/** 每分钟刷新一次「N分钟前」。 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function AuthExpired() {
  return (
    <div className="m-page">
      <header className="m-bar">
        <div className="m-brand">
          <BrandMark />
          <b>DSH</b>
        </div>
      </header>
      <main className="m-body h-auth">
        <p>登录已失效</p>
        <small>请重新登录远程访问后再打开本页。</small>
        <button type="button" className="h-btn-pri" onClick={() => location.assign('/')}>
          去登录
        </button>
      </main>
    </div>
  )
}

export function Home() {
  const sessions = useSessions()
  const ws = useWorkspaces()
  const approvals = useApprovals()
  const now = useNow()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [chip, setChip] = useState<string>(ALL)
  const [view, setView] = useState<ViewMode>(readView)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [toast, setToast] = useState<string | undefined>(undefined)
  const [pull, setPull] = useState(0)
  const pullStart = useRef<number | undefined>(undefined)
  const bodyRef = useRef<HTMLElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      /* 忽略 */
    }
  }, [view])

  useEffect(() => {
    if (toast === undefined) return
    const id = setTimeout(() => setToast(undefined), 2500)
    return () => clearTimeout(id)
  }, [toast])

  const wsChips = useMemo(() => ws.state?.items.map((w) => ({ workspaceId: w.workspaceId, label: workspaceLabel(w) })), [ws.state])
  const chips = useMemo(() => buildChips(wsChips, sessions.list), [wsChips, sessions.list])
  // 选中的工作区被删掉了：回到「全部」。
  const activeChip = chips.some((c) => c.id === chip) ? chip : ALL
  const visible = useMemo(() => filterSessions(sessions.list, activeChip, query), [sessions.list, activeChip, query])
  const groups = useMemo(() => (view === 'group' ? groupByWorkspace(visible) : []), [view, visible])

  if (isAuthError(sessions.error) || isAuthError(ws.error)) return <AuthExpired />

  const run = (p: Promise<void>, fail: string): void => {
    p.catch((e: unknown) => setToast(isAuthError(e) ? '登录已失效' : `${fail}：${e instanceof Error ? e.message : String(e)}`))
  }
  const togglePin = (m: SessionMeta): void => {
    setOpenId(undefined)
    run(m.pinned ? unpinSession(m.sessionId) : pinSession(m.sessionId), m.pinned ? '取消置顶失败' : '置顶失败')
  }
  const archive = (m: SessionMeta): void => {
    setOpenId(undefined)
    run(archiveSession(m.sessionId), '归档失败')
  }
  const onCreate = async (workspaceId: string): Promise<void> => {
    const id = await createSession(workspaceId)
    setPicking(false)
    navigate({ page: 'session', sessionId: id })
  }

  const card = (m: SessionMeta) => {
    const pending = approvals[m.sessionId] ?? []
    const first = pending[0]
    return (
      <SessionCard
        key={m.sessionId}
        meta={m}
        now={now}
        approvals={pending.length}
        {...(first !== undefined ? { approvalHint: `需要审批：${first.reason ?? first.toolName}` } : {})}
        open={openId === m.sessionId}
        onOpenChange={(o) => setOpenId(o ? m.sessionId : undefined)}
        onClick={() => navigate({ page: 'session', sessionId: m.sessionId })}
        onTogglePin={() => togglePin(m)}
        onArchive={() => archive(m)}
      />
    )
  }

  // 下拉刷新：只在列表滚到顶时生效。
  const onTouchStart = (e: ReactTouchEvent): void => {
    pullStart.current = (bodyRef.current?.scrollTop ?? 0) <= 0 ? e.touches[0]?.clientY : undefined
  }
  const onTouchMove = (e: ReactTouchEvent): void => {
    if (pullStart.current === undefined) return
    const dy = (e.touches[0]?.clientY ?? 0) - pullStart.current
    setPull(dy > 0 ? Math.min(80, dy * 0.5) : 0)
  }
  const onTouchEnd = (): void => {
    if (pull >= PULL_TRIGGER) {
      retryWorkspaces()
      void refreshSessions()
    }
    pullStart.current = undefined
    setPull(0)
  }

  const sync = sessions.loading ? '同步中' : sessions.fromCache ? '缓存 · 连接中' : sessions.error !== undefined ? '同步失败' : ''
  const runningCount = visible.filter((m) => m.running).length
  const waitingCount = visible.filter((m) => (approvals[m.sessionId]?.length ?? 0) > 0).length
  const chipLabel = activeChip === ALL ? '全部工作区' : (chips.find((c) => c.id === activeChip)?.label ?? '工作区')

  let content
  if (!sessions.ready) {
    content =
      sessions.error !== undefined && !sessions.loading ? (
        <div className="h-empty">
          <p>加载失败：{sessions.error.message}</p>
          <button type="button" className="h-btn-pri" onClick={() => void refreshSessions()}>
            重试
          </button>
        </div>
      ) : (
        <SessionSkeleton />
      )
  } else if (visible.length === 0) {
    content = <p className="m-placeholder">{query.trim() !== '' ? '没有匹配的会话' : '暂无会话，点右上角「新建」开始'}</p>
  } else if (view === 'recent') {
    content = <div className="h-list">{visible.map(card)}</div>
  } else {
    content = (
      <div className="h-groups">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.id)
          return (
            <section key={g.id || '_'} className="h-group">
              <button
                type="button"
                className="h-group-hd"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s)
                    if (n.has(g.id)) n.delete(g.id)
                    else n.add(g.id)
                    return n
                  })
                }
              >
                <span className="h-caret" data-open={isCollapsed ? 'false' : 'true'}>
                  <Icon name="chevronRight" size={14} />
                </span>
                <b>{g.title}</b>
                <small>[{g.items.length}]</small>
              </button>
              {isCollapsed ? null : <div className="h-list">{g.items.map(card)}</div>}
            </section>
          )
        })}
      </div>
    )
  }

  return (
    <div className="m-page">
      <header className="m-bar h-bar">
        {searching ? (
          <label className="h-search">
            <Icon name="search" size={16} />
            <input type="search" autoFocus placeholder="搜索会话标题" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        ) : (
          <div className="m-brand">
            <BrandMark />
            <b>DSH</b>
            <small>REMOTE</small>
          </div>
        )}
        <button
          type="button"
          className="m-icon-btn"
          data-variant="box"
          aria-label={searching ? '关闭搜索' : '搜索'}
          onClick={() => {
            if (searching) setQuery('')
            setSearching((v) => !v)
          }}
        >
          <Icon name={searching ? 'x' : 'search'} size={18} />
        </button>
        <button type="button" className="m-icon-btn" data-variant="primary" aria-label="新建会话" onClick={() => setPicking(true)}>
          <Icon name="plus" size={20} />
        </button>
        <HomeMenu />
      </header>
      <main ref={bodyRef} className="m-body h-body" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        <div className="h-pull" style={{ height: pull }}>
          {pull > 0 ? (pull >= PULL_TRIGGER ? '松开刷新' : '下拉刷新') : null}
        </div>
        <div className="h-head">
          <nav className="h-crumb" aria-label="位置">
            会话 <i>/</i> {chipLabel}
          </nav>
          <div className="h-title-row">
            <h1 className="h-h1">最近会话</h1>
            <div className="h-seg" role="tablist" aria-label="视图">
              <button type="button" role="tab" aria-selected={view === 'recent'} data-on={view === 'recent' ? 'true' : 'false'} onClick={() => setView('recent')}>
                最近
              </button>
              <button type="button" role="tab" aria-selected={view === 'group'} data-on={view === 'group' ? 'true' : 'false'} onClick={() => setView('group')}>
                按工作区
              </button>
            </div>
          </div>
          <p className="h-meta">
            {sessions.ready ? (
              <>
                <span>
                  共 <b>{visible.length}</b> 个会话
                </span>
                <span>
                  运行中 <b data-tone={runningCount > 0 ? 'ok' : undefined}>{runningCount}</b>
                </span>
                <span>
                  待审批 <b data-tone={waitingCount > 0 ? 'warn' : undefined}>{waitingCount}</b>
                </span>
              </>
            ) : null}
            {sync !== '' ? <span data-tone={sessions.error !== undefined && !sessions.loading ? 'danger' : undefined}>{sync}</span> : null}
          </p>
        </div>
        <div className="h-chips" role="tablist" aria-label="工作区筛选">
          {chips.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={c.id === activeChip} className="h-chip" data-on={c.id === activeChip ? 'true' : 'false'} onClick={() => setChip(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        {content}
      </main>
      {picking ? <WorkspacePicker items={ws.state?.items} onPick={onCreate} onClose={() => setPicking(false)} /> : null}
      {toast !== undefined ? (
        <div className="h-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  )
}

