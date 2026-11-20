/*
 * @Description: H5 抽屉 · SSH 面板 —— 复用 TerminalView（WS /dsh-workspace/ws/terminal）+ 快捷键条（粘滞 Ctrl）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:05:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/SshPanel.tsx
 *
 * 主机选择与 SshTab 一致：远程工作区会话 → 该工作区主机、初始目录为远程根。
 * 本机工作区会话：插件终端只能连保险箱里的 SSH 主机（本机 shell 属于宿主终端，H5 拿不到它的协议），
 * 所以给出主机列表让用户选一台。保险箱上锁时就地输入主密码解锁。
 * 终端 id 按会话缓存在模块级：切 tab / 关抽屉会卸载视图，但远端终端留在宿主，回来时接回同一个（输出整段回放）。
 */
import { useEffect, useRef, useState } from 'react'
import { ERROR_CODES } from '../../wire/contract.js'
import type { HostView } from '../../types.js'
import { RemoteCallError } from '../../client/api.js'
import { TerminalView, type TerminalHandle } from '../../client/terminal/TerminalView.js'
import { api, errorText, index, t, useWorkspaceReady } from './env.js'
import { QUICK_KEYS, applyCtrl, quickKeySequence } from './keys.js'
import type { PanelProps } from './panel.js'
import { Icon, type IconName } from '../icons.js'

/** 方向键用线性图标，其余键帽保留等宽文字。 */
const KEY_ICON: Partial<Record<(typeof QUICK_KEYS)[number]['key'], IconName>> = { up: 'arrowUp', down: 'arrowDown', left: 'arrowLeft', right: 'arrowRight' }

interface Target {
  hostId: string
  cwd?: string
  title?: string
}

/** 会话 → 终端 id（Promise 防止并发重复打开）。 */
const terminals = new Map<string, Promise<string>>()
/** 本机会话里用户选过的主机。 */
const chosenHosts = new Map<string, string>()

export default function SshPanel(props: PanelProps) {
  const { sessionId } = props
  const ready = useWorkspaceReady(sessionId)
  const [chosen, setChosen] = useState<string | undefined>(() => chosenHosts.get(sessionId))
  if (ready !== 'ready') return <div className="m-sheet-note">{t('term.connecting')}</div>
  const ws = index.bySession(sessionId)
  const target: Target | undefined =
    ws !== undefined ? { hostId: ws.hostId, cwd: ws.remotePath, title: ws.title } : chosen !== undefined ? { hostId: chosen } : undefined
  if (target === undefined) {
    return (
      <HostPicker
        onPick={(id) => {
          chosenHosts.set(sessionId, id)
          setChosen(id)
        }}
      />
    )
  }
  return (
    <TerminalSession
      key={`${sessionId}|${target.hostId}`}
      cacheKey={`${sessionId}|${target.hostId}`}
      target={target}
      active={props.active}
      {...(ws === undefined ? { onSwitchHost: () => { chosenHosts.delete(sessionId); setChosen(undefined) } } : {})}
    />
  )
}

/** 保险箱上锁 → 输入主密码。 */
function UnlockForm(props: { onDone(): void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="m-sheet-form"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        void api
          .call('unlock', { password })
          .then((r) => (r.ok ? props.onDone() : setError('主密码不正确')), (err: unknown) => setError(errorText(err)))
          .finally(() => setBusy(false))
      }}
    >
      <div className="m-sheet-note">保险箱已上锁，输入主密码以连接 SSH。</div>
      <input className="m-sheet-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="主密码" />
      <button type="submit" className="m-sheet-btn" data-primary="true" disabled={busy || password === ''}>
        解锁
      </button>
      {error !== null ? <div className="m-sheet-note" data-tone="error">{error}</div> : null}
    </form>
  )
}

function HostPicker(props: { onPick(id: string): void }) {
  const [hosts, setHosts] = useState<HostView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void api.call('state', {}).then(
      (s) => live && setHosts(s.hosts),
      (err: unknown) => live && setError(errorText(err))
    )
    return () => {
      live = false
    }
  }, [])
  if (error !== null) return <div className="m-sheet-note" data-tone="error">{error}</div>
  if (hosts === null) return <div className="m-sheet-note">{t('files.loading')}</div>
  return (
    <div className="m-sheet-scroll">
      <div className="m-sheet-note">本机工作区会话：H5 暂不支持本机终端，可选择一台 SSH 主机打开终端。</div>
      {hosts.length === 0 ? <div className="m-sheet-note">保险箱里还没有主机。</div> : null}
      {hosts.map((h) => (
        <button key={h.id} type="button" className="m-sheet-row" onClick={() => props.onPick(h.id)}>
          <b>{h.label}</b>
          <small>
            {h.username !== undefined && h.username !== '' ? `${h.username}@` : ''}
            {h.hostname}:{h.port}
          </small>
        </button>
      ))}
    </div>
  )
}

function TerminalSession(props: { cacheKey: string; target: Target; active: boolean; onSwitchHost?: () => void }) {
  const { target, cacheKey } = props
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<{ text: string; locked: boolean } | null>(null)
  const [exited, setExited] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  const handle = useRef<TerminalHandle | null>(null)

  const setCtrlBoth = (v: boolean): void => {
    ctrlRef.current = v
    setCtrl(v)
  }

  useEffect(() => {
    let pending = terminals.get(cacheKey)
    if (pending === undefined) {
      pending = api
        .call('openTerminal', {
          hostId: target.hostId,
          cols: 80,
          rows: 24,
          ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
          ...(target.title !== undefined ? { title: target.title } : {})
        })
        .then((view) => view.id)
      terminals.set(cacheKey, pending)
      pending.catch(() => terminals.delete(cacheKey))
    }
    let live = true
    pending.then(
      (id) => live && setTerminalId(id),
      (err: unknown) =>
        live &&
        setError({
          text: errorText(err),
          locked: err instanceof RemoteCallError && (err.code === ERROR_CODES.vaultLocked || err.code === ERROR_CODES.vaultUninitialized)
        })
    )
    return () => {
      live = false
    }
  }, [cacheKey, nonce, target.hostId, target.cwd, target.title])

  const retry = (): void => {
    terminals.delete(cacheKey)
    setError(null)
    setTerminalId(null)
    setNonce((n) => n + 1)
  }

  if (error !== null) {
    if (error.locked) return <UnlockForm onDone={retry} />
    return (
      <div className="m-sheet-note" data-tone="error">
        {error.text}
        <button type="button" className="m-sheet-link" onClick={retry}>
          {t('term.menuReconnect')}
        </button>
      </div>
    )
  }
  if (terminalId === null) return <div className="m-sheet-note">{t('term.connecting')}</div>

  const press = (key: (typeof QUICK_KEYS)[number]['key']): void => {
    const h = handle.current
    if (h === null) return
    h.send(quickKeySequence(key, ctrlRef.current, h.applicationCursor()))
    setCtrlBoth(false)
  }

  return (
    <div className="m-sheet-term">
      {props.onSwitchHost !== undefined ? (
        <div className="m-sheet-crumb">
          <button type="button" className="m-sheet-link" onClick={props.onSwitchHost}>
            <Icon name="chevronLeft" size={16} />
            换主机
          </button>
        </div>
      ) : null}
      <div className="m-sheet-fill dshws-side-term">
        <TerminalView
          key={terminalId}
          t={t}
          terminalId={terminalId}
          active={props.active}
          scrollback={3000}
          exited={exited}
          onStatus={(s) => setExited(s.status === 'exited')}
          onRestart={() => {
            setExited(false)
            retry()
          }}
          transformInput={(data) => {
            if (!ctrlRef.current) return data
            setCtrlBoth(false)
            return applyCtrl(data)
          }}
          onHandle={(h) => {
            handle.current = h
          }}
        />
      </div>
      <div className="m-sheet-keys" role="toolbar" aria-label="终端快捷键">
        {/* pointerdown 阻止默认：点按键不让 xterm 的隐藏输入框失焦，软键盘保持弹出。 */}
        <button type="button" className="m-sheet-key" data-on={ctrl} onPointerDown={(e) => e.preventDefault()} onClick={() => setCtrlBoth(!ctrlRef.current)}>
          Ctrl
        </button>
        {QUICK_KEYS.map((k) => (
          <button key={k.key} type="button" className="m-sheet-key" aria-label={k.label} onPointerDown={(e) => e.preventDefault()} onClick={() => press(k.key)}>
            {KEY_ICON[k.key] !== undefined ? <Icon name={KEY_ICON[k.key] as IconName} size={16} /> : k.label}
          </button>
        ))}
      </div>
    </div>
  )
}
