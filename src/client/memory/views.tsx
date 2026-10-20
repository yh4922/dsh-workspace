/*
 * @Description: 作用域记忆 —— 共用视图：板块面板 / 记忆卡片 / 详情弹窗 / 新增弹窗 / 待选卡片与审批弹窗
 * @Author: YangHeng
 * @Date: 2026-10-16 20:45:00
 * @FilePath: /dsh-workspace/src/client/memory/views.tsx
 *
 * 远程工作区页「记忆」tab 与会话顶部「记忆」tab 共用。每条记忆是一张卡片（摘要 + 标签 + 快捷开关），
 * 点开弹窗看全文、元信息、修改历史并做全部操作。两处都不一定在 DialogProvider 里，
 * 所以删除确认用弹窗内二次确认，不用 window.confirm（Electron 下不可用）。
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { MemoryCall } from './api.js'
import {
  IMPORTANCE,
  MEMORY_SECTIONS,
  MEMORY_TITLE_MAX,
  type HistoryRecord,
  type Importance,
  type MemoryCandidate,
  type MemoryEntry,
  type MemoryPatch,
  type MemoryScope,
  type MemorySection
} from '../../wire/memory.js'

export interface MemoryViewEnv {
  t: Translate
  call: MemoryCall
  /** 写入成功后刷新数据。 */
  refresh(): void
  notify(message: string): void
  onError(error: unknown): void
}

export function formatTime(ms: number): string {
  if (ms <= 0) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 卡片摘要：压平换行，过长截断（CSS 再按 3 行裁剪）。 */
export function summaryOf(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function parseBranches(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

// ---------------------------------------------------------------- 小图标（线性 SVG，与插件其余图标一致）

function Svg(props: { children: ReactNode; size?: number }) {
  const size = props.size ?? 14
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  )
}
export const IconPin = () => (
  <Svg>
    <path d="M9.5 2.5 13.5 6.5 10.5 8 8 10.5 7 13 3 9 5.5 8 8 5.5Z" />
    <path d="M5 11 2.5 13.5" />
  </Svg>
)
export const IconPower = () => (
  <Svg>
    <path d="M8 2.5v5" />
    <path d="M4.5 4.5a5 5 0 1 0 7 0" />
  </Svg>
)
export const IconPlus = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)
export const IconSpark = () => (
  <Svg size={16}>
    <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" />
  </Svg>
)
export const IconLayers = () => (
  <Svg size={16}>
    <path d="M8 2 14 5 8 8 2 5Z" />
    <path d="M2 8 8 11 14 8" />
    <path d="M2 11 8 14 14 11" />
  </Svg>
)
export const IconFolder = () => (
  <Svg size={16}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
  </Svg>
)
export const IconGlobe = () => (
  <Svg size={16}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
  </Svg>
)
export const IconInbox = () => (
  <Svg size={16}>
    <path d="M2 9.5 3.8 3.5h8.4L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
    <path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" />
  </Svg>
)
export const IconChat = () => (
  <Svg size={16}>
    <path d="M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7l-3 2.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
  </Svg>
)

// ---------------------------------------------------------------- 板块面板

export interface PanelProps {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  count?: number
  actions?: ReactNode
  /** 强调色板块（待审批）。 */
  tone?: 'accent'
  /** 传了就可以折叠。 */
  open?: boolean
  onToggle?(): void
  children?: ReactNode
}

/** 一个带标题栏的板块：图标 + 标题 + 计数 + 副标题 + 右侧操作，正文在下。 */
export function Panel(props: PanelProps) {
  const collapsible = props.onToggle !== undefined
  const open = props.open !== false
  const head = (
    <>
      {props.icon !== undefined ? <span className="dshws-mem-panel-icon">{props.icon}</span> : null}
      <span className="dshws-mem-panel-titles">
        <span className="dshws-mem-panel-title">
          {props.title}
          {props.count !== undefined ? <span className="dshws-mem-panel-count">{props.count}</span> : null}
        </span>
        {props.subtitle !== undefined ? <span className="dshws-mem-panel-sub">{props.subtitle}</span> : null}
      </span>
    </>
  )
  return (
    <section className="dshws-mem-panel" data-tone={props.tone} data-open={open}>
      <div className="dshws-mem-panel-head">
        {collapsible ? (
          <button type="button" className="dshws-mem-panel-toggle" aria-expanded={open} onClick={props.onToggle}>
            <span className="dshws-mem-caret" data-open={open}>
              <Svg size={12}>
                <path d="M6 4l4 4-4 4" />
              </Svg>
            </span>
            {head}
          </button>
        ) : (
          <div className="dshws-mem-panel-toggle" data-static="true">
            {head}
          </div>
        )}
        {props.actions !== undefined ? <div className="dshws-mem-panel-actions">{props.actions}</div> : null}
      </div>
      {open && props.children !== undefined ? <div className="dshws-mem-panel-body">{props.children}</div> : null}
    </section>
  )
}

export function EmptyState(props: { text: string; icon?: ReactNode }) {
  return (
    <div className="dshws-mem-empty-state">
      <span className="dshws-mem-empty-icon">{props.icon ?? <IconLayers />}</span>
      <span>{props.text}</span>
    </div>
  )
}

/** 统计小卡（总览用）。 */
export function StatCard(props: { label: string; value: number | string; icon: ReactNode; tone?: string; onClick?(): void }) {
  const body = (
    <>
      <span className="dshws-mem-stat-icon">{props.icon}</span>
      <span className="dshws-mem-stat-text">
        <span className="dshws-mem-stat-value">{props.value}</span>
        <span className="dshws-mem-stat-label">{props.label}</span>
      </span>
    </>
  )
  return props.onClick !== undefined ? (
    <button type="button" className="dshws-mem-stat" data-tone={props.tone} onClick={props.onClick}>
      {body}
    </button>
  ) : (
    <div className="dshws-mem-stat" data-tone={props.tone}>
      {body}
    </div>
  )
}

// ---------------------------------------------------------------- 卡片

function EntryBadges(props: { t: Translate; entry: MemoryEntry; showSection?: boolean }) {
  const { t, entry } = props
  return (
    <>
      {props.showSection === true && entry.section !== undefined ? (
        <span className="dshws-mem-badge" data-section={entry.section}>
          {t(`memory.section.${entry.section}`)}
        </span>
      ) : null}
      {entry.pinned ? (
        <span className="dshws-mem-badge" data-tone="accent">
          {t('memory.pinned')}
        </span>
      ) : null}
      {entry.importance !== 'medium' ? (
        <span className="dshws-mem-badge" data-tone={entry.importance === 'high' ? 'warn' : 'muted'}>
          {t(`memory.importance.${entry.importance}`)}
        </span>
      ) : null}
      {!entry.enabled ? (
        <span className="dshws-mem-badge" data-tone="muted">
          {t('memory.disabled')}
        </span>
      ) : null}
      {(entry.branches ?? []).map((b) => (
        <span key={b} className="dshws-mem-badge">
          ⎇ {b}
        </span>
      ))}
    </>
  )
}

function sourceText(t: Translate, source: MemoryEntry['source'], at: number): string {
  const parts = [t(`memory.by.${source.by}`)]
  if (source.turn !== undefined) parts.push(t('memory.turn', { n: String(source.turn) }))
  parts.push(formatTime(at))
  return parts.filter((p) => p !== '').join(' · ')
}

/** 卡片外壳：整卡可点（回车 / 空格同样可打开），内部按钮自行阻止冒泡。 */
function CardShell(props: { onOpen(): void; title: string; attrs?: Record<string, string | boolean | undefined>; children: ReactNode }) {
  return (
    <div
      className="dshws-mem-card"
      role="button"
      tabIndex={0}
      title={props.title}
      {...props.attrs}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onOpen()
        }
      }}
    >
      {props.children}
    </div>
  )
}

function EntryCard(props: { env: MemoryViewEnv; scope: MemoryScope; entry: MemoryEntry; showSection?: boolean; onOpen(): void }) {
  const { env, scope, entry } = props
  const { t } = env
  const [busy, setBusy] = useState(false)
  const quick = (patch: MemoryPatch) => (e: MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    void env
      .call({ op: 'update', scope, id: entry.id, patch })
      .then(() => env.refresh(), env.onError)
      .finally(() => setBusy(false))
  }
  // 没有任何标签时不留空白标签行：快捷按钮浮在右上角，摘要右侧让出位置
  const bare = !entry.pinned && entry.enabled && entry.importance === 'medium' && (entry.branches ?? []).length === 0 && props.showSection !== true
  return (
    <CardShell
      onOpen={props.onOpen}
      title={t('memory.clickHint')}
      attrs={{ 'data-enabled': String(entry.enabled), 'data-pinned': String(entry.pinned), 'data-importance': entry.importance, 'data-bare': String(bare) }}
    >
      <div className="dshws-mem-card-head">
        <div className="dshws-mem-meta">
          <EntryBadges t={t} entry={entry} {...(props.showSection === true ? { showSection: true } : {})} />
        </div>
        <div className="dshws-mem-card-quick">
          <button type="button" className="dshws-mem-icon-btn" data-on={entry.pinned} disabled={busy} title={entry.pinned ? t('memory.unpin') : t('memory.pin')} aria-label={entry.pinned ? t('memory.unpin') : t('memory.pin')} onClick={quick({ pinned: !entry.pinned })}>
            <IconPin />
          </button>
          <button type="button" className="dshws-mem-icon-btn" data-on={entry.enabled} disabled={busy} title={entry.enabled ? t('memory.disable') : t('memory.enable')} aria-label={entry.enabled ? t('memory.disable') : t('memory.enable')} onClick={quick({ enabled: !entry.enabled })}>
            <IconPower />
          </button>
        </div>
      </div>
      {entry.title !== undefined ? <div className="dshws-mem-card-title">{entry.title}</div> : null}
      <div className="dshws-mem-card-summary" data-sub={entry.title !== undefined}>{summaryOf(entry.content)}</div>
      <div className="dshws-mem-card-foot">{sourceText(t, entry.source, entry.updatedAt)}</div>
    </CardShell>
  )
}

// ---------------------------------------------------------------- 详情弹窗

function KV(props: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="dshws-mem-kv">
      {props.rows.map(([k, v]) => (
        <div key={k} className="dshws-mem-kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function EntryDetailDialog(props: { env: MemoryViewEnv; scope: MemoryScope; entry: MemoryEntry; canPromoteProject: boolean; onClose(): void }) {
  const { env, scope, entry } = props
  const { t } = env
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const [titleDraft, setTitleDraft] = useState(entry.title ?? '')
  const [branches, setBranches] = useState((entry.branches ?? []).join(', '))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<HistoryRecord[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const loadHistory = (): void => {
    void env.call({ op: 'history', scope, id: entry.id }).then(setHistory, env.onError)
  }
  const run = (task: () => Promise<unknown>, done?: string, after?: () => void): void => {
    setBusy(true)
    void task()
      .then(() => {
        if (done !== undefined) env.notify(done)
        env.refresh()
        if (showHistory) loadHistory()
        after?.()
      }, env.onError)
      .finally(() => setBusy(false))
  }
  const patch = (p: MemoryPatch, done?: string, after?: () => void): void => run(() => env.call({ op: 'update', scope, id: entry.id, patch: p }), done, after)

  const title = `${t(`memory.layer.${entry.layer}`)}${entry.section !== undefined ? ` · ${t(`memory.section.${entry.section}`)}` : ''}`
  const rows: Array<[string, ReactNode]> = [
    [t('memory.meta.status'), entry.enabled ? t('memory.stateOn') : t('memory.disabled')],
    [t('memory.importance'), t(`memory.importance.${entry.importance}`)],
    [t('memory.meta.source'), sourceText(t, entry.source, 0)],
    [t('memory.meta.created'), formatTime(entry.createdAt)],
    [t('memory.meta.updated'), formatTime(entry.updatedAt)]
  ]
  if (entry.source.sessionId !== undefined) rows.push([t('memory.meta.session'), <code key="s">{entry.source.sessionId}</code>])
  if (scope.layer === 'project') rows.push([t('memory.meta.branches'), (entry.branches ?? []).length > 0 ? (entry.branches ?? []).join(', ') : t('memory.allBranches')])

  return (
    <Modal
      open
      title={title}
      closeLabel={t('common.close')}
      className="dshws-mem-detail-dialog"
      onClose={props.onClose}
      footer={
        <div className="dshws-mem-dialog-foot">
          <div className="dshws-mem-dialog-foot-left">
            {confirmDelete ? (
              <>
                <span className="dshws-mem-hint">{t('memory.deleteHint')}</span>
                <Button size="sm" variant="primary" className="dshws-danger-btn" disabled={busy} onClick={() => run(() => env.call({ op: 'remove', scope, id: entry.id }), t('memory.deleted'), props.onClose)}>
                  {t('memory.confirmDelete')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                  {t('form.cancel')}
                </Button>
              </>
            ) : (
              <button type="button" className="dshws-link-btn" data-tone="danger" onClick={() => setConfirmDelete(true)}>
                {t('memory.delete')}
              </button>
            )}
          </div>
          <div className="dshws-mem-dialog-foot-right">
            {editing ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  {t('form.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || draft.trim() === ''}
                  onClick={() => {
                    // 标题传空串 = 清除
                    const p: MemoryPatch = { content: draft.trim(), title: titleDraft.trim() }
                    if (scope.layer === 'project') p.branches = parseBranches(branches)
                    patch(p, t('memory.saved'), () => setEditing(false))
                  }}
                >
                  {t('memory.save')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(entry.content)
                    setTitleDraft(entry.title ?? '')
                    setBranches((entry.branches ?? []).join(', '))
                    setEditing(true)
                  }}
                >
                  {t('memory.edit')}
                </Button>
                <Button size="sm" variant="primary" onClick={props.onClose}>
                  {t('common.close')}
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="dshws-mem-detail-body">
        <div className="dshws-mem-meta">
          <EntryBadges t={t} entry={entry} />
        </div>
        {editing ? (
          <div className="dshws-mem-edit">
            <TitleField env={env} value={titleDraft} content={draft} onChange={setTitleDraft} />
            <textarea className="dshws-input dshws-mem-textarea" rows={6} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
            {scope.layer === 'project' ? (
              <input className="dshws-input" placeholder={t('memory.branchesPlaceholder')} value={branches} onChange={(e) => setBranches(e.target.value)} />
            ) : null}
          </div>
        ) : (
          <>
            {entry.title !== undefined ? <div className="dshws-mem-detail-title">{entry.title}</div> : <div className="dshws-mem-hint">{t('memory.noTitle')}</div>}
            <div className="dshws-mem-detail-content">{entry.content}</div>
          </>
        )}

        <div className="dshws-mem-detail-actions">
          <Button size="sm" variant="outline" icon={<IconPower />} disabled={busy} onClick={() => patch({ enabled: !entry.enabled })}>
            {entry.enabled ? t('memory.disable') : t('memory.enable')}
          </Button>
          <Button size="sm" variant="outline" icon={<IconPin />} disabled={busy} onClick={() => patch({ pinned: !entry.pinned })}>
            {entry.pinned ? t('memory.unpin') : t('memory.pin')}
          </Button>
          <label className="dshws-mem-inline-field">
            {t('memory.importance')}
            <select className="dshws-mem-select" value={entry.importance} disabled={busy} onChange={(e) => patch({ importance: e.target.value as Importance })}>
              {IMPORTANCE.map((i) => (
                <option key={i} value={i}>
                  {t(`memory.importance.${i}`)}
                </option>
              ))}
            </select>
          </label>
          {scope.layer === 'session' ? (
            <label className="dshws-mem-inline-field">
              {t('memory.sectionLabel')}
              <select className="dshws-mem-select" value={entry.section ?? 'facts'} disabled={busy} onChange={(e) => patch({ section: e.target.value as MemorySection })}>
                {MEMORY_SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {t(`memory.section.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {scope.layer === 'session' && props.canPromoteProject ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => env.call({ op: 'promote', scope, id: entry.id, to: 'project' }), t('memory.promoted'))}>
              {t('memory.promoteProject')}
            </Button>
          ) : null}
          {scope.layer === 'session' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => env.call({ op: 'promote', scope, id: entry.id, to: 'global' }), t('memory.promoted'))}>
              {t('memory.promoteGlobal')}
            </Button>
          ) : null}
        </div>

        <KV rows={rows} />

        <div className="dshws-mem-history-block">
          <button
            type="button"
            className="dshws-link-btn"
            onClick={() => {
              if (!showHistory && history === null) loadHistory()
              setShowHistory(!showHistory)
            }}
          >
            {showHistory ? t('memory.hideHistory') : t('memory.history')}
          </button>
          {showHistory ? (
            <div className="dshws-mem-history">
              {history === null ? <div className="dshws-mem-empty">{t('memory.loading')}</div> : null}
              {history?.length === 0 ? <div className="dshws-mem-empty">{t('memory.noHistory')}</div> : null}
              {history?.map((r) => {
                const version = r.after ?? r.before
                return (
                  <div key={r.id} className="dshws-mem-hrow">
                    <div className="dshws-mem-meta">
                      <span className="dshws-mem-badge">{t(`memory.op.${r.op}`)}</span>
                      <span className="dshws-mem-source">
                        {t(`memory.by.${r.by}`)} · {formatTime(r.at)}
                      </span>
                      {version !== undefined && r.op !== 'delete' ? (
                        <button type="button" className="dshws-link-btn" disabled={busy} onClick={() => run(() => env.call({ op: 'revert', scope, id: entry.id, recordId: r.id }), t('memory.reverted'))}>
                          {t('memory.revertTo')}
                        </button>
                      ) : null}
                    </div>
                    {version !== undefined ? (
                      <div className="dshws-mem-content" data-muted={r.op === 'delete' || !version.enabled}>
                        {version.content}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- 标题输入（手动 / AI 生成）

/**
 * 标题输入框 + 「AI 生成」：用 DSH 默认模型根据当前内容给出标题，填进输入框由用户确认后随表单保存。
 * 生成期间按钮转圈；失败在输入框下方提示，不清掉已填内容。
 */
export function TitleField(props: { env: MemoryViewEnv; value: string; content: string; onChange(value: string): void }) {
  const { env } = props
  const { t } = env
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const generate = (): void => {
    setBusy(true)
    setProblem(null)
    void env
      .call({ op: 'suggestTitle', content: props.content.trim() })
      .then(
        (r) => props.onChange(r.title),
        (e: unknown) => setProblem(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="dshws-mem-title-field">
      <div className="dshws-mem-title-row">
        <input
          className="dshws-input"
          maxLength={MEMORY_TITLE_MAX}
          placeholder={t('memory.titlePlaceholder')}
          aria-label={t('memory.titleLabel')}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <Button size="sm" variant="outline" icon={busy ? <span className="dshws-mem-spin" /> : <IconSpark />} disabled={busy || props.content.trim() === ''} title={t('memory.aiTitleHint')} onClick={generate}>
          {busy ? t('memory.aiTitleBusy') : t('memory.aiTitle')}
        </Button>
      </div>
      {problem !== null ? <div className="dshws-field-error">{problem}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------- 新增弹窗

export function AddDialog(props: { env: MemoryViewEnv; scope: MemoryScope; section?: MemorySection; onClose(): void }) {
  const { env, scope } = props
  const { t } = env
  const [content, setContent] = useState('')
  const [title, setTitle] = useState('')
  const [section, setSection] = useState<MemorySection>(props.section ?? 'facts')
  const [importance, setImportance] = useState<Importance>('medium')
  const [pinned, setPinned] = useState(false)
  const [branches, setBranches] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    const text = content.trim()
    if (text === '') return
    setBusy(true)
    const list = parseBranches(branches)
    void env
      .call({
        op: 'add',
        scope,
        draft: {
          ...(title.trim() !== '' ? { title: title.trim() } : {}),
          content: text,
          importance,
          pinned,
          ...(scope.layer === 'session' ? { section } : {}),
          ...(scope.layer === 'project' && list.length > 0 ? { branches: list } : {})
        }
      })
      .then(() => {
        env.notify(t('memory.added'))
        env.refresh()
        props.onClose()
      }, env.onError)
      .finally(() => setBusy(false))
  }
  return (
    <Modal
      open
      title={`${t('memory.add')} · ${t(`memory.layer.${scope.layer}`)}`}
      closeLabel={t('common.close')}
      className="dshws-mem-detail-dialog"
      onClose={props.onClose}
      footer={
        <div className="dshws-mem-dialog-foot">
          <div className="dshws-mem-dialog-foot-left" />
          <div className="dshws-mem-dialog-foot-right">
            <Button size="sm" variant="outline" onClick={props.onClose}>
              {t('form.cancel')}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || content.trim() === ''} onClick={submit}>
              {t('memory.addSubmit')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="dshws-mem-detail-body">
        {/* 标题在上（阅读顺序），焦点仍先落在内容框：AI 生成标题要先有内容 */}
        <TitleField env={env} value={title} content={content} onChange={setTitle} />
        <textarea className="dshws-input dshws-mem-textarea" rows={6} autoFocus placeholder={t('memory.addPlaceholder')} value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="dshws-mem-detail-actions">
          {scope.layer === 'session' ? (
            <label className="dshws-mem-inline-field">
              {t('memory.sectionLabel')}
              <select className="dshws-mem-select" value={section} onChange={(e) => setSection(e.target.value as MemorySection)}>
                {MEMORY_SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {t(`memory.section.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="dshws-mem-inline-field">
            {t('memory.importance')}
            <select className="dshws-mem-select" value={importance} onChange={(e) => setImportance(e.target.value as Importance)}>
              {IMPORTANCE.map((i) => (
                <option key={i} value={i}>
                  {t(`memory.importance.${i}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="dshws-mem-inline-field">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            {t('memory.pin')}
          </label>
        </div>
        {scope.layer === 'project' ? (
          <input className="dshws-input" placeholder={t('memory.branchesPlaceholder')} value={branches} onChange={(e) => setBranches(e.target.value)} />
        ) : null}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- 条目列表

export interface EntryListProps {
  env: MemoryViewEnv
  scope: MemoryScope
  entries: MemoryEntry[]
  canPromoteProject?: boolean
  emptyText?: string
  /** false = 不显示顶部的计数与「新增」（会话看板把新增放在列头）。 */
  toolbar?: boolean
}

/** 卡片列表 + 新增。会话层按固定分节分成小板块。 */
export function EntryList(props: EntryListProps) {
  const { env, scope, entries } = props
  const { t } = env
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ section?: MemorySection } | null>(null)
  const open = openId === null ? undefined : entries.find((e) => e.id === openId)
  // 条目被删除 / 换了作用域后关掉弹窗
  useEffect(() => {
    if (openId !== null && open === undefined) setOpenId(null)
  }, [openId, open])

  const enabled = entries.filter((e) => e.enabled).length
  const grid = (list: MemoryEntry[], showSection: boolean) => (
    <div className="dshws-mem-grid">
      {list.map((entry) => (
        <EntryCard key={entry.id} env={env} scope={scope} entry={entry} {...(showSection ? { showSection: true } : {})} onOpen={() => setOpenId(entry.id)} />
      ))}
    </div>
  )

  return (
    <div className="dshws-mem-list">
      {props.toolbar === false ? null : (<div className="dshws-mem-listbar">
        <span className="dshws-mem-hint">{entries.length === 0 ? '' : t('memory.countSummary', { n: String(entries.length), m: String(enabled) })}</span>
        <Button size="sm" variant="outline" icon={<IconPlus />} onClick={() => setAdding({})}>
          {t('memory.add')}
        </Button>
      </div>)}
      {entries.length === 0 ? <EmptyState text={props.emptyText ?? t('memory.empty')} /> : null}
      {scope.layer === 'session'
        ? MEMORY_SECTIONS.map((section) => {
            const list = entries.filter((e) => (e.section ?? 'facts') === section)
            if (list.length === 0) return null
            return (
              <div key={section} className="dshws-mem-sec" data-section={section}>
                <div className="dshws-mem-sec-head">
                  <span className="dshws-mem-sec-dot" />
                  <span className="dshws-mem-sec-title">{t(`memory.section.${section}`)}</span>
                  <span className="dshws-mem-panel-count">{list.length}</span>
                  <button type="button" className="dshws-mem-icon-btn" title={t('memory.addToSection')} aria-label={t('memory.addToSection')} onClick={() => setAdding({ section })}>
                    <IconPlus />
                  </button>
                </div>
                {grid(list, false)}
              </div>
            )
          })
        : entries.length > 0
          ? grid(entries, false)
          : null}
      {open !== undefined ? <EntryDetailDialog key={open.id} env={env} scope={scope} entry={open} canPromoteProject={props.canPromoteProject === true} onClose={() => setOpenId(null)} /> : null}
      {adding !== null ? <AddDialog env={env} scope={scope} {...(adding.section !== undefined ? { section: adding.section } : {})} onClose={() => setAdding(null)} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------- 待选

function candidateTarget(t: Translate, c: MemoryCandidate, projectTitle?: string): string {
  return c.layer === 'global' ? t('memory.layer.global') : `${t('memory.layer.project')}${projectTitle !== undefined ? `：${projectTitle}` : ''}`
}

function CandidateCard(props: { env: MemoryViewEnv; candidate: MemoryCandidate; projectTitle?: string; onOpen(): void }) {
  const { env, candidate } = props
  const { t } = env
  const [busy, setBusy] = useState(false)
  const act = (op: 'approve' | 'reject') => (e: MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    const task = op === 'approve' ? env.call({ op: 'approve', decision: { id: candidate.id } }) : env.call({ op: 'reject', id: candidate.id })
    void task
      .then(() => {
        env.notify(t(op === 'approve' ? 'memory.approved' : 'memory.rejected'))
        env.refresh()
      }, env.onError)
      .finally(() => setBusy(false))
  }
  return (
    <CardShell onOpen={props.onOpen} title={t('memory.clickHint')} attrs={{ 'data-candidate': 'true', 'data-importance': candidate.importance }}>
      <div className="dshws-mem-card-head">
        <div className="dshws-mem-meta">
          <span className="dshws-mem-badge" data-tone="accent">
            → {candidateTarget(t, candidate, props.projectTitle)}
          </span>
          {candidate.importance !== 'medium' ? (
            <span className="dshws-mem-badge" data-tone={candidate.importance === 'high' ? 'warn' : 'muted'}>
              {t(`memory.importance.${candidate.importance}`)}
            </span>
          ) : null}
          {candidate.hits > 1 ? <span className="dshws-mem-badge">{t('memory.hits', { n: String(candidate.hits) })}</span> : null}
        </div>
      </div>
      {candidate.title !== undefined ? <div className="dshws-mem-card-title">{candidate.title}</div> : null}
      <div className="dshws-mem-card-summary" data-sub={candidate.title !== undefined}>{summaryOf(candidate.content)}</div>
      <div className="dshws-mem-card-foot dshws-mem-card-foot-actions">
        <span>{sourceText(t, candidate.source, candidate.createdAt)}</span>
        <span className="dshws-mem-card-btns">
          <Button size="sm" variant="outline" disabled={busy} onClick={act('reject')}>
            {t('memory.reject')}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={act('approve')}>
            {t('memory.approve')}
          </Button>
        </span>
      </div>
    </CardShell>
  )
}

function CandidateDialog(props: { env: MemoryViewEnv; candidate: MemoryCandidate; projectTitle?: string; onClose(): void }) {
  const { env, candidate } = props
  const { t } = env
  const [content, setContent] = useState(candidate.content)
  const [title, setTitle] = useState(candidate.title ?? '')
  const [layer, setLayer] = useState<'project' | 'global'>(candidate.layer)
  const [importance, setImportance] = useState<Importance>(candidate.importance)
  const [busy, setBusy] = useState(false)
  const changed = content.trim() !== candidate.content || title.trim() !== (candidate.title ?? '') || layer !== candidate.layer || importance !== candidate.importance
  const run = (task: () => Promise<unknown>, done: string): void => {
    setBusy(true)
    void task()
      .then(() => {
        env.notify(done)
        env.refresh()
        props.onClose()
      }, env.onError)
      .finally(() => setBusy(false))
  }
  const rows: Array<[string, ReactNode]> = [
    [t('memory.meta.target'), candidateTarget(t, candidate, props.projectTitle)],
    [t('memory.meta.source'), sourceText(t, candidate.source, 0)],
    [t('memory.meta.created'), formatTime(candidate.createdAt)],
    [t('memory.meta.hits'), String(candidate.hits)]
  ]
  if (candidate.source.sessionId !== undefined) rows.push([t('memory.meta.session'), <code key="s">{candidate.source.sessionId}</code>])
  return (
    <Modal
      open
      title={t('memory.candidateDetail')}
      closeLabel={t('common.close')}
      className="dshws-mem-detail-dialog"
      onClose={props.onClose}
      footer={
        <div className="dshws-mem-dialog-foot">
          <div className="dshws-mem-dialog-foot-left">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => env.call({ op: 'reject', id: candidate.id }), t('memory.rejected'))}>
              {t('memory.reject')}
            </Button>
          </div>
          <div className="dshws-mem-dialog-foot-right">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || content.trim() === ''}
              onClick={() => run(() => env.call({ op: 'approve', decision: { id: candidate.id, ...(changed ? { title: title.trim(), content: content.trim(), layer, importance } : {}) } }), t('memory.approved'))}
            >
              {changed ? t('memory.approveEdited') : t('memory.approve')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="dshws-mem-detail-body">
        <div className="dshws-mem-hint">{t('memory.candidateEditHint')}</div>
        <TitleField env={env} value={title} content={content} onChange={setTitle} />
        <textarea className="dshws-input dshws-mem-textarea" rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="dshws-mem-detail-actions">
          <label className="dshws-mem-inline-field">
            {t('memory.layerLabel')}
            <select className="dshws-mem-select" value={layer} onChange={(e) => setLayer(e.target.value as 'project' | 'global')}>
              <option value="project">{t('memory.layer.project')}</option>
              <option value="global">{t('memory.layer.global')}</option>
            </select>
          </label>
          <label className="dshws-mem-inline-field">
            {t('memory.importance')}
            <select className="dshws-mem-select" value={importance} onChange={(e) => setImportance(e.target.value as Importance)}>
              {IMPORTANCE.map((i) => (
                <option key={i} value={i}>
                  {t(`memory.importance.${i}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <KV rows={rows} />
      </div>
    </Modal>
  )
}

export function CandidateList(props: { env: MemoryViewEnv; candidates: MemoryCandidate[]; sessionId?: string; projectTitles?: Record<string, string>; toolbar?: boolean }) {
  const { env, candidates } = props
  const { t } = env
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const open = openId === null ? undefined : candidates.find((c) => c.id === openId)
  const titleOf = (c: MemoryCandidate): string | undefined => (c.projectId !== undefined ? props.projectTitles?.[c.projectId] : undefined)
  const bulk = (op: 'approveAll' | 'rejectAll'): void => {
    setBusy(true)
    void env
      .call({ op, ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}) })
      .then((r) => {
        env.notify(t(op === 'approveAll' ? 'memory.approvedN' : 'memory.rejectedN', { n: String(r.count) }))
        env.refresh()
      }, env.onError)
      .finally(() => setBusy(false))
  }
  if (candidates.length === 0) return <EmptyState text={t('memory.noCandidates')} icon={<IconInbox />} />
  return (
    <div className="dshws-mem-list">
      {props.toolbar === false ? null : (<div className="dshws-mem-listbar">
        {/* 说明文字由外层板块的副标题给出，这里只留数量 */}
        <span className="dshws-mem-hint">{t('memory.pendingCount', { n: String(candidates.length) })}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk('rejectAll')}>
          {t('memory.rejectAll')}
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => bulk('approveAll')}>
          {t('memory.approveAll')}
        </Button>
      </div>)}
      <div className="dshws-mem-grid">
        {candidates.map((c) => {
          const title = titleOf(c)
          return <CandidateCard key={c.id} env={env} candidate={c} {...(title !== undefined ? { projectTitle: title } : {})} onOpen={() => setOpenId(c.id)} />
        })}
      </div>
      {open !== undefined ? (
        <CandidateDialog key={open.id} env={env} candidate={open} {...(titleOf(open) !== undefined ? { projectTitle: titleOf(open) as string } : {})} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  )
}

/** 只读卡片（最近删除 / 搜索结果）：摘要 + 标签 + 右下角一个操作。 */
export function SimpleCard(props: { badges: ReactNode; heading?: string; content: string; foot: ReactNode; action?: ReactNode; onOpen?(): void; title?: string }) {
  const inner = (
    <>
      <div className="dshws-mem-card-head">
        <div className="dshws-mem-meta">{props.badges}</div>
      </div>
      {props.heading !== undefined ? <div className="dshws-mem-card-title">{props.heading}</div> : null}
      <div className="dshws-mem-card-summary" data-sub={props.heading !== undefined}>{summaryOf(props.content)}</div>
      <div className="dshws-mem-card-foot dshws-mem-card-foot-actions">
        <span>{props.foot}</span>
        {props.action !== undefined ? <span className="dshws-mem-card-btns">{props.action}</span> : null}
      </div>
    </>
  )
  return props.onOpen !== undefined ? (
    <CardShell onOpen={props.onOpen} title={props.title ?? ''}>
      {inner}
    </CardShell>
  ) : (
    <div className="dshws-mem-card" data-static="true">
      {inner}
    </div>
  )
}
