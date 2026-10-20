/*
 * @Description: 远程工作区页「记忆」tab —— 设置（弹窗）、三层记忆浏览与编辑、待审批、最近删除、搜索、孤儿清理
 * @Author: YangHeng
 * @Date: 2026-10-16 21:00:00
 * @FilePath: /dsh-workspace/src/client/memory/MemoryPane.tsx
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { SettingRow } from '../page/SettingsPane.js'
import { memoryCaller } from './api.js'
import { CandidateList, EmptyState, EntryList, IconChat, IconFolder, IconGlobe, IconInbox, IconLayers, IconSpark, Panel, SimpleCard, StatCard, formatTime, type MemoryViewEnv } from './views.js'
import { refreshMemoryTab } from './register.js'
import type { MemoryCandidate, MemoryEntry, MemoryOutputs, MemoryOverview, MemoryScope, MemorySettings, SearchHit, TrashItem } from '../../wire/memory.js'

export interface MemoryPaneProps {
  t: Translate
  call: WorkspaceApi['call']
  notify(message: string): void
  onError(error: unknown): void
}

type Selection =
  | { kind: 'global' }
  | { kind: 'project'; id: string }
  | { kind: 'session'; sessionId: string; projectId: string | null }
  | { kind: 'pending' }
  | { kind: 'trash' }
  | { kind: 'search' }

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'project' && b.kind === 'project') return a.id === b.id
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  return true
}

export function MemoryPane(props: MemoryPaneProps) {
  const { t } = props
  const call = useMemo(() => memoryCaller(props.call), [props.call])
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [selection, setSelection] = useState<Selection>({ kind: 'global' })
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([])
  const [trash, setTrash] = useState<TrashItem[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [query, setQuery] = useState('')
  const [tick, setTick] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    void call({ op: 'overview' }).then(setOverview, props.onError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, tick])

  useEffect(() => {
    const s = selection
    if (s.kind === 'global') void call({ op: 'list', scope: { layer: 'global' } }).then(setEntries, props.onError)
    else if (s.kind === 'project') void call({ op: 'list', scope: { layer: 'project', projectId: s.id } }).then(setEntries, props.onError)
    else if (s.kind === 'session') void call({ op: 'list', scope: { layer: 'session', sessionId: s.sessionId } }).then(setEntries, props.onError)
    else if (s.kind === 'pending') void call({ op: 'candidates' }).then(setCandidates, props.onError)
    else if (s.kind === 'trash') void call({ op: 'trash' }).then(setTrash, props.onError)
    else if (s.kind === 'search' && query.trim() !== '') void call({ op: 'search', query: query.trim() }).then(setHits, props.onError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, selection, tick])

  const env: MemoryViewEnv = { t, call, refresh, notify: props.notify, onError: props.onError }
  const projectTitles = useMemo(() => Object.fromEntries((overview?.projects ?? []).map((p) => [p.id, p.title])), [overview])

  const scope: MemoryScope | null =
    selection.kind === 'global'
      ? { layer: 'global' }
      : selection.kind === 'project'
        ? { layer: 'project', projectId: selection.id }
        : selection.kind === 'session'
          ? { layer: 'session', sessionId: selection.sessionId }
          : null

  const treeItem = (sel: Selection, label: string, count: number | undefined, extra?: { hint?: string; tone?: string; depth?: number; icon?: JSX.Element }) => (
    <button
      type="button"
      className="dshws-mem-node"
      data-active={sameSelection(sel, selection)}
      data-tone={extra?.tone}
      style={{ paddingLeft: 10 + (extra?.depth ?? 0) * 16 }}
      title={extra?.hint ?? label}
      onClick={() => setSelection(sel)}
    >
      {extra?.icon !== undefined ? <span className="dshws-mem-node-icon">{extra.icon}</span> : null}
      <span className="dshws-mem-node-label">{label}</span>
      {count !== undefined && count > 0 ? <span className="dshws-mem-panel-count">{count}</span> : null}
    </button>
  )

  // 右侧板块的标题 / 副标题 / 图标随选中节点变化
  const sessionInfo =
    selection.kind === 'session'
      ? [...(overview?.projects ?? []).flatMap((p) => p.sessions.map((s) => ({ ...s, project: p.title }))), ...(overview?.looseSessions ?? []).map((s) => ({ ...s, project: '' }))].find((s) => s.sessionId === selection.sessionId)
      : undefined
  const projectInfo = selection.kind === 'project' ? overview?.projects.find((p) => p.id === selection.id) : undefined
  const head: { title: string; subtitle?: string; icon: JSX.Element; tone?: 'accent' } =
    selection.kind === 'global'
      ? { title: t('memory.layer.global'), subtitle: t('memory.globalHint'), icon: <IconGlobe /> }
      : selection.kind === 'project'
        ? {
            title: `${t('memory.layer.project')}：${projectInfo?.title ?? selection.id}`,
            subtitle: projectInfo?.remote !== undefined ? `${projectInfo.remote.host} : ${projectInfo.remote.remotePath}` : projectInfo?.path ?? '',
            icon: <IconFolder />
          }
        : selection.kind === 'session'
          ? { title: sessionInfo?.title ?? t('memory.layer.session'), subtitle: `${t('memory.layer.session')}${sessionInfo?.project ? ` · ${sessionInfo.project}` : ''}`, icon: <IconChat /> }
          : selection.kind === 'pending'
            ? { title: t('memory.pending'), subtitle: t('memory.candidatesHint'), icon: <IconInbox />, tone: 'accent' }
            : selection.kind === 'trash'
              ? { title: t('memory.trash'), subtitle: t('memory.trashHint'), icon: <IconLayers /> }
              : { title: t('memory.searchResults', { n: String(hits.length) }), subtitle: query, icon: <IconSpark /> }
  const sessionCount = (overview?.projects ?? []).reduce((a, p) => a + p.sessions.length, 0) + (overview?.looseSessions.length ?? 0)
  const projectCount = (overview?.projects ?? []).filter((p) => p.entryCount > 0).length

  return (
    <div className="dshws-mem-page">
      {/* 设置不常改：收进弹窗，页面顶部只留一个按钮 + 启用状态 */}
      {settingsOpen ? (
        <Modal open title={t('memory.settings')} closeLabel={t('common.close')} className="dshws-mem-settings-dialog" onClose={() => setSettingsOpen(false)}>
          <SettingsCard t={t} settings={overview?.settings ?? null} call={call} onSaved={refresh} onError={props.onError} />
        </Modal>
      ) : null}

      {/* 总览：状态 + 设置入口 + 四个统计 */}
      <section className="dshws-mem-hero">
        <div className="dshws-mem-hero-main">
          <span className="dshws-mem-hero-icon">
            <IconLayers />
          </span>
          <div className="dshws-mem-hero-text">
            <div className="dshws-mem-hero-title">
              {t('memory.heroTitle')}
              {overview !== null ? (
                <span className="dshws-mem-badge" data-tone={overview.settings.enabled ? 'accent' : 'muted'}>
                  {overview.settings.enabled ? t('memory.stateOn') : t('memory.stateOff')}
                </span>
              ) : null}
            </div>
            <div className="dshws-mem-hero-sub">{t('memory.heroSub')}</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
            {t('memory.settings')}
          </Button>
        </div>
        <div className="dshws-mem-stats">
          <StatCard label={t('memory.pending')} value={overview?.pendingCount ?? '–'} icon={<IconInbox />} tone="accent" onClick={() => setSelection({ kind: 'pending' })} />
          <StatCard label={t('memory.layer.global')} value={overview?.globalCount ?? '–'} icon={<IconGlobe />} onClick={() => setSelection({ kind: 'global' })} />
          <StatCard label={t('memory.statProjects')} value={overview === null ? '–' : projectCount} icon={<IconFolder />} />
          <StatCard label={t('memory.statSessions')} value={overview === null ? '–' : sessionCount} icon={<IconChat />} />
        </div>
      </section>

      <div className="dshws-mem-toolbar">
        <div className="dshws-search">
          <input
            className="dshws-input"
            placeholder={t('memory.search')}
            aria-label={t('memory.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim() !== '') {
                setSelection({ kind: 'search' })
                refresh()
              }
            }}
          />
        </div>
        <Button size="sm" variant="outline" onClick={refresh}>
          {t('memory.refresh')}
        </Button>
        <CleanupButton t={t} call={call} notify={props.notify} onError={props.onError} onDone={refresh} />
      </div>

      <div className="dshws-mem-split">
        <nav className="dshws-mem-tree" aria-label={t('memory.tree')}>
          <div className="dshws-mem-tree-title">{t('memory.treeOverview')}</div>
          {treeItem({ kind: 'pending' }, t('memory.pending'), overview?.pendingCount, { tone: 'accent', icon: <IconInbox /> })}
          {treeItem({ kind: 'global' }, t('memory.layer.global'), overview?.globalCount, { icon: <IconGlobe /> })}
          {treeItem({ kind: 'trash' }, t('memory.trash'), undefined, { icon: <IconLayers /> })}
          <div className="dshws-mem-tree-title">{t('memory.projects')}</div>
          {(overview?.projects ?? []).length === 0 ? <div className="dshws-mem-tree-empty">{t('memory.noProjects')}</div> : null}
          {(overview?.projects ?? []).map((p) => (
            <div key={p.id} className="dshws-mem-tree-group">
              {treeItem({ kind: 'project', id: p.id }, `${p.title}${p.unlinked ? ` · ${t('memory.unlinked')}` : ''}`, p.entryCount, {
                hint: p.remote !== undefined ? `${p.remote.host}:${p.remote.remotePath}` : p.path,
                icon: p.remote !== undefined ? <span className="dshws-mem-remote-dot" title={p.remote.host}>☁</span> : <IconFolder />,
                ...(p.unlinked ? { tone: 'muted' } : {})
              })}
              {p.sessions.map((s) => (
                <div key={s.sessionId}>
                  {treeItem({ kind: 'session', sessionId: s.sessionId, projectId: p.id }, s.title, s.entryCount, { depth: 1, hint: s.sessionId, icon: <IconChat />, ...(s.exists === false ? { tone: 'muted' } : {}) })}
                </div>
              ))}
            </div>
          ))}
          {(overview?.looseSessions.length ?? 0) > 0 ? <div className="dshws-mem-tree-title">{t('memory.looseSessions')}</div> : null}
          {(overview?.looseSessions ?? []).map((s) => (
            <div key={s.sessionId}>{treeItem({ kind: 'session', sessionId: s.sessionId, projectId: null }, s.title, s.entryCount, { hint: s.sessionId, icon: <IconChat />, ...(s.exists === false ? { tone: 'muted' } : {}) })}</div>
          ))}
        </nav>

        <Panel title={head.title} {...(head.subtitle !== undefined && head.subtitle !== '' ? { subtitle: head.subtitle } : {})} icon={head.icon} {...(head.tone !== undefined ? { tone: head.tone } : {})}>
          {scope !== null ? (
            <EntryList env={env} scope={scope} entries={entries} canPromoteProject={selection.kind === 'session' && selection.projectId !== null && selection.projectId !== '_none'} />
          ) : null}
          {selection.kind === 'pending' ? <CandidateList env={env} candidates={candidates} projectTitles={projectTitles} /> : null}
          {selection.kind === 'trash' ? <TrashView env={env} items={trash} /> : null}
          {selection.kind === 'search' ? <SearchView t={t} hits={hits} onOpen={setSelection} /> : null}
        </Panel>
      </div>
    </div>
  )
}

function SettingsCard(props: { t: Translate; settings: MemorySettings | null; call: ReturnType<typeof memoryCaller>; onSaved(): void; onError(e: unknown): void }) {
  const { t, settings } = props
  const [every, setEvery] = useState('')
  const [models, setModels] = useState<MemoryOutputs['models'] | null>(null)
  /** 保存结果提示（弹窗内显示：页面级 Toast 会被弹窗遮罩挡住）。 */
  const [flash, setFlash] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  useEffect(() => {
    if (settings === null) return
    setEvery(String(settings.summarizeEveryTurns))
  }, [settings])
  useEffect(() => {
    void props.call({ op: 'models' }).then(setModels, () => setModels([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const show = (text: string, tone: 'ok' | 'error'): void => {
    setFlash({ text, tone })
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }
  const save = (patch: Partial<MemorySettings>): void => {
    void props.call({ op: 'settings', patch }).then(
      () => {
        props.onSaved()
        show(t('memory.saved'), 'ok')
        // 会话顶部「记忆」标签跟随总开关立即出现 / 消失
        if (patch.enabled !== undefined) refreshMemoryTab()
      },
      (error: unknown) => {
        show(t('error.generic', { message: error instanceof Error ? error.message : String(error) }), 'error')
        props.onError(error)
      }
    )
  }
  const disabled = settings === null
  // 下拉选项的值：provider + NUL + model（两者都可能含 / 等字符，NUL 不会出现在 id 里）
  const keyOf = (m: { provider: string; model: string }): string => `${m.provider}\u0000${m.model}`
  const current = settings?.summarizerModel ?? null
  const groups = new Map<string, MemoryOutputs['models']>()
  for (const m of models ?? []) groups.set(m.group, [...(groups.get(m.group) ?? []), m])
  return (
    <section className="dshws-mem-settings">
      {flash !== null ? (
        <div className="dshws-mem-flash" data-tone={flash.tone} role="status">
          {flash.text}
        </div>
      ) : null}
      <SettingRow
        title={t('memory.enabled')}
        desc={t('memory.enabledHint')}
        disabled={disabled}
        control={<Switch checked={settings?.enabled === true} label={t('memory.enabled')} disabled={disabled} onChange={(next) => save({ enabled: next })} />}
      />
      <SettingRow
        title={t('memory.toolEnabled')}
        desc={t('memory.toolEnabledHint')}
        disabled={disabled}
        control={<Switch checked={settings?.toolEnabled === true} label={t('memory.toolEnabled')} disabled={disabled} onChange={(next) => save({ toolEnabled: next })} />}
      />
      <SettingRow
        title={t('memory.every')}
        desc={t('memory.everyHint')}
        disabled={disabled}
        control={
          <input
            className="dshws-input dshws-mem-number"
            type="number"
            min={1}
            max={50}
            value={every}
            disabled={disabled}
            aria-label={t('memory.every')}
            onChange={(e) => setEvery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            onBlur={() => {
              const n = Number(every)
              if (!Number.isInteger(n) || n < 1 || n > 50) {
                setEvery(String(settings?.summarizeEveryTurns ?? 8))
                show(t('memory.everyInvalid'), 'error')
              } else if (n !== settings?.summarizeEveryTurns) save({ summarizeEveryTurns: n })
            }}
          />
        }
      />
      <SettingRow
        title={t('memory.model')}
        desc={models !== null && models.length === 0 ? `${t('memory.modelHint')} ${t('memory.modelNone')}` : t('memory.modelHint')}
        disabled={disabled}
        control={
          <select
            className="dshws-mem-select dshws-mem-model-select"
            aria-label={t('memory.model')}
            disabled={disabled || models === null}
            value={current === null ? '' : keyOf(current)}
            onChange={(e) => {
              const value = e.target.value
              const picked = (models ?? []).find((m) => keyOf(m) === value)
              save({ summarizerModel: picked === undefined ? null : { provider: picked.provider, model: picked.model } })
            }}
          >
            <option value="">{models === null ? t('memory.loading') : t('memory.modelSession')}</option>
            {[...groups.entries()].map(([group, list]) => (
              <optgroup key={group} label={group}>
                {list.map((m) => (
                  <option key={keyOf(m)} value={keyOf(m)}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        }
      />
    </section>
  )
}

function CleanupButton(props: { t: Translate; call: ReturnType<typeof memoryCaller>; notify(m: string): void; onError(e: unknown): void; onDone(): void }) {
  const { t } = props
  const [orphans, setOrphans] = useState<MemoryOutputs['orphans'] | null>(null)
  if (orphans === null) {
    return (
      <Button size="sm" variant="outline" onClick={() => void props.call({ op: 'orphans' }).then(setOrphans, props.onError)}>
        {t('memory.cleanup')}
      </Button>
    )
  }
  if (orphans.length === 0) {
    return (
      <span className="dshws-mem-hint">
        {t('memory.noOrphans')}{' '}
        <button type="button" className="dshws-link-btn" onClick={() => setOrphans(null)}>
          {t('common.close')}
        </button>
      </span>
    )
  }
  return (
    <span className="dshws-mem-hint">
      {t('memory.cleanupConfirm', { n: String(orphans.length), m: String(orphans.reduce((a, o) => a + o.entryCount, 0)) })}{' '}
      <button
        type="button"
        className="dshws-link-btn"
        data-tone="danger"
        onClick={() =>
          void props.call({ op: 'cleanup', sessionIds: orphans.map((o) => o.sessionId) }).then((r) => {
            props.notify(t('memory.cleaned', { n: String(r.removed) }))
            setOrphans(null)
            props.onDone()
          }, props.onError)
        }
      >
        {t('memory.confirmDelete')}
      </button>{' '}
      <button type="button" className="dshws-link-btn" data-tone="muted" onClick={() => setOrphans(null)}>
        {t('form.cancel')}
      </button>
    </span>
  )
}

function TrashView(props: { env: MemoryViewEnv; items: TrashItem[] }) {
  const { env } = props
  const { t } = env
  if (props.items.length === 0) return <EmptyState text={t('memory.trashEmpty')} />
  return (
    <div className="dshws-mem-grid">
      {props.items.map((item) => (
        <SimpleCard
          key={item.id}
          badges={<span className="dshws-mem-badge">{t(`memory.layer.${item.entry.layer}`)}</span>}
          {...(item.entry.title !== undefined ? { heading: item.entry.title } : {})}
          content={item.entry.content}
          foot={`${t('memory.deletedAt')} ${formatTime(item.deletedAt)}`}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void env.call({ op: 'restore', trashId: item.id }).then(() => {
                  env.notify(t('memory.restored'))
                  env.refresh()
                }, env.onError)
              }
            >
              {t('memory.restore')}
            </Button>
          }
        />
      ))}
    </div>
  )
}

function SearchView(props: { t: Translate; hits: SearchHit[]; onOpen(sel: Selection): void }) {
  const { t } = props
  if (props.hits.length === 0) return <EmptyState text={t('memory.noHits')} icon={<IconSpark />} />
  return (
    <div className="dshws-mem-grid">
      {props.hits.map((h) => (
        <SimpleCard
          key={`${h.scope.layer}:${h.entry.id}`}
          title={t('memory.openScope')}
          badges={<span className="dshws-mem-badge" data-tone="accent">{h.scopeTitle}</span>}
          {...(h.entry.title !== undefined ? { heading: h.entry.title } : {})}
          content={h.entry.content}
          foot={formatTime(h.entry.updatedAt)}
          onOpen={() =>
            props.onOpen(
              h.scope.layer === 'global'
                ? { kind: 'global' }
                : h.scope.layer === 'project'
                  ? { kind: 'project', id: h.scope.projectId }
                  : { kind: 'session', sessionId: h.scope.sessionId, projectId: null }
            )
          }
        />
      ))}
    </div>
  )
}
