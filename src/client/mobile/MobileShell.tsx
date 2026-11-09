/*
 * @Description: H5 外壳 —— 工作区列表 / 会话列表（一、二级页），三级页交给宿主原版会话
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/mobile/MobileShell.tsx
 *
 * 挂在宿主 shell.overlay（盖在整个 AppFrame 上）。到了会话页本组件不渲染任何东西，
 * 用户看到的就是宿主原版会话（左栏与顶部 tab 由 CSS 隐藏，返回 / 更多按钮在 HeaderBar）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { DialogProvider, useDialogs } from '../page/dialogs.js'
import { LAN_PROXY_PREFIX } from '../../wire/lan.js'
import { sessionTitle, summarize, workspaceName, workspaceOf, type MobileHost, type SessionRow, type Store, type WorkspaceSummary } from './host.js'
import type { Direction, ShellStore } from './route.js'

export interface MobileShellProps {
  t: Translate
  api: WorkspaceApi
  store: ShellStore
  host: MobileHost
}

const NOOP_STORE: Store<undefined> = { getSnapshot: () => undefined, subscribe: () => () => undefined }

/** 订阅宿主 store；服务还没就绪时返回 undefined，并每秒重试一次直到拿到。 */
export function useHostStore<T>(pick: () => Store<T> | undefined): T | undefined {
  const [, force] = useState(0)
  const source = pick()
  useEffect(() => {
    if (source !== undefined) return
    const timer = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [source])
  const store = (source ?? NOOP_STORE) as Store<T | undefined>
  // 绑定后的函数要按 store 记忆：每次渲染换新函数会让 React 反复退订 / 重订。
  const subscribe = useMemo(() => store.subscribe.bind(store), [store])
  const getSnapshot = useMemo(() => store.getSnapshot.bind(store), [store])
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function useShell(store: ShellStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** 聊天列表式时间：今天显示时分，昨天显示「昨天」，更早显示月/日。 */
function listTime(at: number, t: Translate): string {
  if (at <= 0) return ''
  const d = new Date(at)
  const now = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('lan.dayAgo', { n: 1 })
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function Avatar(props: { name: string; remote: boolean }) {
  const ch = Array.from(props.name.trim())[0] ?? '?'
  let hash = 0
  for (const c of props.name) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return (
    <span className="dshws-h5-avatar" style={{ ['--h5-hue' as string]: String(Math.abs(hash) % 360) }} data-remote={props.remote}>
      {ch.toUpperCase()}
    </span>
  )
}

function Icon(props: { d: string; size?: number }) {
  const s = props.size ?? 20
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={props.d} />
    </svg>
  )
}

const ICON_BACK = 'M15 18l-6-6 6-6'
const ICON_PLUS = 'M12 5v14M5 12h14'
const ICON_MORE = 'M5 12h.01M12 12h.01M19 12h.01'
const ICON_SEARCH = 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35'

function TopBar(props: { title: ReactNode; left?: ReactNode; right?: ReactNode }) {
  return (
    <header className="dshws-h5-top">
      <div className="dshws-h5-top-side">{props.left}</div>
      <div className="dshws-h5-top-title">{props.title}</div>
      <div className="dshws-h5-top-side" data-end="true">
        {props.right}
      </div>
    </header>
  )
}

/** 左滑露出操作按钮的行（触摸手势；横向位移超过纵向才接管，不影响列表上下滚动）。 */
function SwipeRow(props: { children: ReactNode; actions: Array<{ label: string; tone?: 'danger'; onClick(): void }>; onOpen(): void }) {
  const width = props.actions.length * 76
  const [x, setX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number; base: number; locked: boolean } | null>(null)
  return (
    <div className="dshws-h5-swipe">
      {/* 只在滑开 / 拖动时显示：常驻在行底下时，红色「归档」按钮会从行的亚像素边缘透出来（细红边）。 */}
      <div className="dshws-h5-swipe-actions" style={{ width, visibility: x < 0 || dragging ? 'visible' : 'hidden' }}>
        {props.actions.map((a) => (
          <button
            key={a.label}
            type="button"
            data-tone={a.tone}
            onClick={() => {
              setX(0)
              a.onClick()
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div
        className="dshws-h5-swipe-body"
        style={{ transform: `translateX(${x}px)`, transition: dragging ? 'none' : undefined }}
        onTouchStart={(e) => {
          const p = e.touches[0]!
          start.current = { x: p.clientX, y: p.clientY, base: x, locked: false }
        }}
        onTouchMove={(e) => {
          const s = start.current
          if (s === null) return
          const p = e.touches[0]!
          const dx = p.clientX - s.x
          const dy = p.clientY - s.y
          if (!s.locked) {
            if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
              s.locked = true
              setDragging(true)
            } else if (Math.abs(dy) > 8) {
              start.current = null
              return
            } else return
          }
          setX(Math.max(-width, Math.min(0, s.base + dx)))
        }}
        onTouchEnd={() => {
          const s = start.current
          start.current = null
          setDragging(false)
          if (s?.locked === true) setX((cur) => (cur < -width / 2 ? -width : 0))
        }}
        onClick={() => {
          if (x !== 0) {
            setX(0)
            return
          }
          props.onOpen()
        }}
      >
        {props.children}
      </div>
    </div>
  )
}

function Home(props: MobileShellProps & { anim: Direction; summaries: WorkspaceSummary[]; remotePaths: Set<string> }) {
  const { t, store } = props
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = q === '' ? props.summaries : props.summaries.filter((s) => `${workspaceName(s.item, t('h5.workspaces'))} ${s.item.path}`.toLowerCase().includes(q))
  const logout = (): void => {
    void fetch(`${LAN_PROXY_PREFIX}/logout`, { method: 'POST', credentials: 'same-origin' }).finally(() => location.replace('/'))
  }
  return (
    <div className="dshws-h5-page" data-anim={props.anim}>
      <TopBar
        left={
          <button type="button" className="dshws-h5-text-btn" onClick={() => store.setPreferDesktop(true)}>
            {t('h5.desktop')}
          </button>
        }
        title={t('h5.workspaces')}
        right={
          <button type="button" className="dshws-h5-text-btn" onClick={logout}>
            {t('h5.logout')}
          </button>
        }
      />
      <div className="dshws-h5-search">
        <Icon d={ICON_SEARCH} size={16} />
        <input value={query} placeholder={t('h5.search')} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="dshws-h5-list">
        {list.length === 0 ? <div className="dshws-h5-empty">{t('h5.empty')}</div> : null}
        {list.map((s) => {
          const name = workspaceName(s.item, t('h5.workspaces'))
          const remote = props.remotePaths.has(normPath(s.item.path))
          return (
            <button key={s.item.workspaceId} type="button" className="dshws-h5-row" onClick={() => store.go({ level: 'sessions', workspaceId: s.item.workspaceId })}>
              <Avatar name={name} remote={remote} />
              <span className="dshws-h5-row-main">
                <span className="dshws-h5-row-line">
                  <span className="dshws-h5-row-title">{name}</span>
                  <span className="dshws-h5-tag" data-remote={remote}>
                    {remote ? t('h5.remote') : t('h5.local')}
                  </span>
                  <span className="dshws-h5-row-time">{listTime(s.activeAt, t)}</span>
                </span>
                <span className="dshws-h5-row-line">
                  <span className="dshws-h5-row-sub">{s.latest !== undefined ? sessionTitle(s.latest, t('h5.untitled')) : t('h5.noSession')}</span>
                  {s.running > 0 ? <span className="dshws-h5-badge">{s.running}</span> : null}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Sessions(props: MobileShellProps & { anim: Direction; summary: WorkspaceSummary | undefined; isRunning(row: SessionRow): boolean; onNew(): void }) {
  const { t, store, host } = props
  const dialogs = useDialogs()
  const [error, setError] = useState<string | null>(null)
  const summary = props.summary
  const fail = (e: unknown): void => setError(t('h5.failed', { message: e instanceof Error ? e.message : String(e) }))
  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(timer)
  }, [error])
  return (
    <div className="dshws-h5-page" data-anim={props.anim}>
      <TopBar
        left={
          <button type="button" className="dshws-h5-icon-btn" aria-label={t('h5.back')} onClick={() => store.back({ level: 'home' })}>
            <Icon d={ICON_BACK} size={22} />
          </button>
        }
        title={summary !== undefined ? workspaceName(summary.item, t('h5.workspaces')) : ''}
        right={
          <button type="button" className="dshws-h5-icon-btn" aria-label={t('h5.newSession')} disabled={summary === undefined} onClick={props.onNew}>
            <Icon d={ICON_PLUS} size={22} />
          </button>
        }
      />
      <div className="dshws-h5-list">
        {summary !== undefined && summary.sessions.length === 0 ? (
          <div className="dshws-h5-empty">
            {t('h5.sessionsEmpty')}
            <button type="button" className="dshws-h5-primary" onClick={props.onNew}>
              {t('h5.newSession')}
            </button>
          </div>
        ) : null}
        {summary?.sessions.map((row) => {
          const title = sessionTitle(row, t('h5.untitled'))
          return (
            <SwipeRow
              key={row.id}
              onOpen={() => store.go({ level: 'session', sessionId: row.id })}
              actions={[
                {
                  label: t('h5.rename'),
                  onClick: () =>
                    void dialogs
                      .prompt({ title: t('h5.rename'), label: t('h5.renamePrompt'), defaultValue: title })
                      .then((next) => (next !== null && next.trim() !== '' && next.trim() !== title ? host.rename(row.id, next.trim()) : undefined))
                      .catch(fail)
                },
                {
                  label: t('h5.archive'),
                  tone: 'danger',
                  onClick: () =>
                    void dialogs
                      .confirm({ title: t('h5.archive'), message: t('h5.archiveConfirm', { name: title }), danger: true })
                      .then((ok) => (ok ? host.archive(row.id) : 'ok'))
                      .then((r) => {
                        if (r === 'active') setError(t('h5.archiveActive'))
                      })
                      .catch(fail)
                }
              ]}
            >
              <span className="dshws-h5-row" data-static="true">
                <span className="dshws-h5-dot" data-running={props.isRunning(row)} />
                <span className="dshws-h5-row-main">
                  <span className="dshws-h5-row-line">
                    <span className="dshws-h5-row-title">{title}</span>
                    <span className="dshws-h5-row-time">{listTime(row.updatedAt ?? 0, t)}</span>
                  </span>
                  {props.isRunning(row) ? <span className="dshws-h5-row-sub dshws-h5-running">{t('h5.running')}</span> : null}
                </span>
              </span>
            </SwipeRow>
          )
        })}
      </div>
      {error !== null ? <div className="dshws-h5-toast">{error}</div> : null}
    </div>
  )
}

function ShellInner(props: MobileShellProps) {
  const { t, store, host } = props
  const shell = useShell(store)
  const ws = useHostStore(host.workspaces)
  const ss = useHostStore(host.sessions)
  const status = useHostStore(host.status)
  const current = useHostStore(host.current)
  const currentKey = current?.key
  const [remotePaths, setRemotePaths] = useState<Set<string>>(new Set())
  const awaitingNew = useRef<{ before: string | undefined } | null>(null)
  const active = shell.proxied && shell.narrow && !shell.preferDesktop

  useEffect(() => {
    if (!active) return
    void props.api.call('remoteWorkspaces', {}).then(
      (out) => setRemotePaths(new Set(out.workspaces.map((b) => normPath(b.localPath)))),
      () => undefined
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 根节点标记：CSS 据此隐藏宿主左栏与会话顶部 tab（只在 H5 启用时生效）。
  useEffect(() => {
    const root = document.documentElement
    if (active) root.dataset.dshwsH5 = shell.route.level
    else delete root.dataset.dshwsH5
    return () => {
      delete root.dataset.dshwsH5
    }
  }, [active, shell.route.level])

  // 进入会话页：让宿主主区显示该会话（刷新后直达 #/s/<id> 也走这里）。
  const routeSession = shell.route.level === 'session' ? shell.route.sessionId : undefined
  useEffect(() => {
    if (!active || routeSession === undefined) return
    if (currentKey !== routeSession) host.openSession(routeSession)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, routeSession])

  // 新建会话：宿主 startSession 不返回 id，等「当前会话」变成新的那个再进入会话页。
  useEffect(() => {
    const wait = awaitingNew.current
    if (!active || wait === null || currentKey === undefined || currentKey === wait.before) return
    awaitingNew.current = null
    store.go({ level: 'session', sessionId: currentKey })
  }, [active, currentKey, store])

  // 在会话页里宿主切换了会话（如分叉、从右栏打开）：同步 hash，返回键仍回到会话列表。
  useEffect(() => {
    if (!active || routeSession === undefined || currentKey === undefined || currentKey === routeSession) return
    store.go({ level: 'session', sessionId: currentKey }, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey])

  const summaries = useMemo(() => summarize(ws, ss, status, currentKey), [ws, ss, status, currentKey])

  if (!active) {
    if (shell.proxied && shell.narrow && shell.preferDesktop) {
      return (
        <button type="button" className="dshws-h5-switch" onClick={() => store.setPreferDesktop(false)}>
          {t('h5.mobile')}
        </button>
      )
    }
    return null
  }
  if (shell.route.level === 'session') {
    const sessionId = shell.route.sessionId
    const row = ss?.byId?.[sessionId]
    const owner = workspaceOf(ws, sessionId)
    return (
      <SessionBar
        {...props}
        key={sessionId}
        anim={shell.direction}
        title={sessionTitle(row, t('h5.untitled'))}
        subtitle={owner !== undefined ? workspaceName(owner, t('h5.workspaces')) : ''}
        running={(status?.get(sessionId)?.running ?? row?.running) === true}
        onBack={() => store.back(owner !== undefined ? { level: 'sessions', workspaceId: owner.workspaceId } : { level: 'home' })}
      />
    )
  }
  if (shell.route.level === 'sessions') {
    const workspaceId = shell.route.workspaceId
    const summary = summaries.find((s) => s.item.workspaceId === workspaceId)
    return (
      <Sessions
        {...props}
        key={workspaceId}
        anim={shell.direction}
        summary={summary}
        isRunning={(row) => status?.get(row.id)?.running ?? row.running === true}
        onNew={() => {
          awaitingNew.current = { before: currentKey }
          if (!host.startSession(workspaceId)) awaitingNew.current = null
        }}
      />
    )
  }
  return <Home {...props} key="home" anim={shell.direction} summaries={summaries} remotePaths={remotePaths} />
}

export function MobileShell(props: MobileShellProps) {
  return (
    <DialogProvider t={props.t}>
      <ShellInner {...props} />
    </DialogProvider>
  )
}

/**
 * 会话页自建 AppBar：返回 / 会话标题 + 所属工作区 / 更多（打开右侧栏）。
 * 宿主原版会话头（面包屑、子智能体、工具按钮）在手机上挤成一团，H5 下由 CSS 整个隐藏，主区下移让出这条栏的高度。
 */
function SessionBar(props: MobileShellProps & { anim: Direction; title: string; subtitle: string; running: boolean; onBack(): void }) {
  const { t, host } = props
  return (
    <header className="dshws-h5-appbar" data-anim={props.anim}>
      <button type="button" className="dshws-h5-icon-btn" aria-label={t('h5.back')} onClick={props.onBack}>
        <Icon d={ICON_BACK} size={22} />
      </button>
      <div className="dshws-h5-appbar-title">
        <span className="dshws-h5-appbar-main">
          {props.running ? <span className="dshws-h5-dot" data-running="true" /> : null}
          <span className="dshws-h5-appbar-text">{props.title}</span>
        </span>
        {props.subtitle !== '' ? <span className="dshws-h5-appbar-sub">{props.subtitle}</span> : null}
      </div>
      <button type="button" className="dshws-h5-icon-btn" aria-label={t('h5.more')} onClick={() => host.toggleRight()}>
        <Icon d={ICON_MORE} size={22} />
      </button>
    </header>
  )
}
