/*
 * @Description: 「远程访问」页签 —— 启用与管理、监听地址 / 端口 / 协议、固定或定时随机密码、设备管理
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/lan/LanPane.tsx
 *
 * 所有修改都带本机凭证 localKey（经 whoami 取得）：经局域网代理打开的页面拿不到它，整页只读。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { useWorkspace } from '../page/useWorkspace.js'
import { SettingRow } from '../page/SettingsPane.js'
import { useDialogs } from '../page/dialogs.js'
import {
  LAN_FIXED_PASSWORD_MAX,
  LAN_FIXED_PASSWORD_MIN,
  LAN_INTERVAL_MAX,
  LAN_INTERVAL_MIN,
  LAN_INTERVAL_PRESETS,
  LAN_SESSION_DAYS,
  isValidLanHost,
  type LanConfigPatch,
  type LanDevice,
  type LanInput,
  type LanStatus
} from '../../wire/lan.js'
import { whoami } from './whoami.js'
import { Qr } from './Qr.js'
import { deviceName, relTime } from './format.js'

export interface LanPaneProps {
  t: Translate
  call: ReturnType<typeof useWorkspace>['call']
  notify(text: string): void
  onError(error: unknown): void
}

/** 状态轮询间隔：设备列表、随机密码轮换、运行状态都靠它刷新。 */
const POLL_MS = 5000

type Op = LanInput extends infer T ? (T extends { localKey: string } ? Omit<T, 'localKey'> : never) : never

function clock(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  const sameDay = new Date().toDateString() === d.toDateString()
  return `${sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${p(d.getHours())}:${p(d.getMinutes())}`
}

function intervalLabel(t: Translate, minutes: number): string {
  if (minutes % 1440 === 0) return t('lan.days', { n: minutes / 1440 })
  if (minutes % 60 === 0) return t('lan.hours', { n: minutes / 60 })
  return t('lan.minutes', { n: minutes })
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // HTTP 局域网页面没有 clipboard 权限：退回 execCommand。
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

export function LanPane(props: LanPaneProps) {
  const { t } = props
  const dialogs = useDialogs()
  const [status, setStatus] = useState<LanStatus | null>(null)
  const [localKey, setLocalKey] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // 监听参数的草稿：点「保存并应用」才提交（改端口会重启服务，不能每敲一个字就重启）。
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<'http' | 'https'>('http')
  const [customInterval, setCustomInterval] = useState('')
  const [fixed, setFixed] = useState('')
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  // 两个「只在界面上先切过去」的状态：轮询回来的宿主状态不能把它们冲掉。
  const [customMode, setCustomMode] = useState(false)
  const [pendingFixed, setPendingFixed] = useState(false)
  const keyRef = useRef<string | undefined>(undefined)
  const draftDirty = useRef(false)

  const adopt = (next: LanStatus): void => {
    setStatus(next)
    if (!draftDirty.current) {
      setHost(next.config.host)
      setPort(String(next.config.port))
      setProtocol(next.config.protocol)
    }
  }

  const refresh = (): Promise<void> =>
    props.call('lan', { op: 'status', ...(keyRef.current !== undefined ? { localKey: keyRef.current } : {}) }).then(adopt, props.onError)

  useEffect(() => {
    let alive = true
    void whoami().then((w) => {
      if (!alive) return
      keyRef.current = w.localKey
      setLocalKey(w.localKey)
      void refresh()
    })
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (op: Op, done?: string): Promise<boolean> => {
    if (keyRef.current === undefined) return false
    setBusy(true)
    try {
      adopt(await props.call('lan', { ...op, localKey: keyRef.current } as LanInput))
      if (done !== undefined) props.notify(done)
      return true
    } catch (error) {
      props.onError(error)
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = (patch: LanConfigPatch, done?: string, fixedPassword?: string): Promise<boolean> =>
    run({ op: 'save', patch, ...(fixedPassword !== undefined ? { fixedPassword } : {}) }, done)

  if (status === null) return <div className="dshws-lan-loading">…</div>

  const cfg = { ...status.config, ...(pendingFixed && status.config.passwordMode === 'random' ? { passwordMode: 'fixed' as const } : {}) }
  const readonly = !status.local || localKey === undefined
  const disabled = readonly || busy
  const portNum = Number(port)
  const listenValid = isValidLanHost(host.trim()) && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  const listenDirty = host.trim() !== cfg.host || portNum !== cfg.port || protocol !== cfg.protocol
  const presets = LAN_INTERVAL_PRESETS as readonly number[]
  const isCustom = customMode || !presets.includes(cfg.randomIntervalMinutes)
  const shownQr = qrUrl !== null && status.urls.includes(qrUrl) ? qrUrl : (status.urls[0] ?? null)

  return (
    <div className="dshws-settings dshws-lan">
      {readonly ? (
        <div className="dshws-banner" data-tone="warn">
          <div className="dshws-banner-text">
            <div className="dshws-banner-hint">{t('lan.readonly')}</div>
          </div>
        </div>
      ) : null}

      {status.desktopGate === 'closed' || status.desktopGate === 'incompatible' ? (
        <div className="dshws-banner" data-tone="warn">
          <div className="dshws-banner-text">
            <div className="dshws-banner-hint">{t(status.desktopGate === 'closed' ? 'lan.gateClosed' : 'lan.gateIncompatible')}</div>
          </div>
          {status.desktopGate === 'closed' ? (
            <Button size="sm" variant="primary" disabled={disabled} onClick={() => void run({ op: 'openGate' }, t('lan.gateOpened'))}>
              {t('lan.gateOpen')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <section className="dshws-set-card">
        <SettingRow
          title={t('lan.enableTitle')}
          desc={
            <>
              {t('lan.enableDesc')}
              <span className="dshws-lan-state" data-state={status.state}>
                {t(`lan.state.${status.state}`)}
                {status.error !== undefined ? `：${status.error}` : ''}
              </span>
            </>
          }
          control={<Switch checked={cfg.enabled} label={t('lan.enableTitle')} disabled={disabled} onChange={(next) => void save({ enabled: next })} />}
        />
        <div className="dshws-lan-addr">
          <div className="dshws-lan-urls">
            <div className="dshws-set-title">{t('lan.urls')}</div>
            {status.urls.length === 0 ? <div className="dshws-set-desc">{t('lan.noUrls')}</div> : null}
            {status.urls.map((url) => (
              <div key={url} className="dshws-lan-url" data-active={url === shownQr}>
                <button type="button" className="dshws-lan-url-text" onClick={() => setQrUrl(url)}>
                  {url}
                </button>
                <button type="button" className="dshws-link-button" onClick={() => void copyText(url).then((ok) => ok && props.notify(t('lan.copied')))}>
                  {t('lan.copy')}
                </button>
              </div>
            ))}
          </div>
          {shownQr !== null && cfg.enabled ? (
            <div className="dshws-lan-qrbox">
              <Qr text={shownQr} size={132} />
              <span>{t('lan.qrHint')}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('lan.listen')}</div>
        <SettingRow
          title={t('lan.host')}
          desc={t('lan.hostDesc')}
          control={
            <input
              className="dshws-input dshws-lan-field"
              value={host}
              disabled={disabled}
              data-invalid={!isValidLanHost(host.trim())}
              onChange={(e) => {
                draftDirty.current = true
                setHost(e.target.value)
              }}
            />
          }
        />
        <SettingRow
          title={t('lan.port')}
          desc={t('lan.portDesc')}
          control={
            <input
              className="dshws-input dshws-lan-field"
              inputMode="numeric"
              value={port}
              disabled={disabled}
              onChange={(e) => {
                draftDirty.current = true
                setPort(e.target.value.replace(/\D/g, '').slice(0, 5))
              }}
            />
          }
        />
        <SettingRow
          title={t('lan.protocol')}
          desc={
            <>
              {t('lan.protocolDesc')}
              {protocol === 'http' ? <span className="dshws-set-note">{t('lan.httpWarn')}</span> : null}
            </>
          }
          control={
            <select
              className="dshws-select dshws-lan-field"
              value={protocol}
              disabled={disabled}
              onChange={(e) => {
                draftDirty.current = true
                setProtocol(e.target.value === 'https' ? 'https' : 'http')
              }}
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
          }
        />
        <div className="dshws-lan-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || !listenValid || !listenDirty}
            onClick={() =>
              void save({ host: host.trim(), port: portNum, protocol }, t('lan.applied')).then((ok) => {
                if (ok) draftDirty.current = false
              })
            }
          >
            {t('lan.apply')}
          </Button>
        </div>
      </section>

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('lan.password')}</div>
        <SettingRow
          title={t('lan.mode')}
          desc={t('lan.lockDesc')}
          control={
            <select
              className="dshws-select dshws-lan-field"
              value={cfg.passwordMode}
              disabled={disabled}
              onChange={(e) => {
                const mode = e.target.value === 'fixed' ? 'fixed' : 'random'
                // 没设固定密码就切过去会被宿主拒绝：先只切界面，等用户输入密码一起提交。
                setPendingFixed(mode === 'fixed' && !status.hasFixedPassword)
                if (mode === 'random' || status.hasFixedPassword) void save({ passwordMode: mode })
              }}
            >
              <option value="random">{t('lan.modeRandom')}</option>
              <option value="fixed">{t('lan.modeFixed')}</option>
            </select>
          }
        />
        {cfg.passwordMode === 'random' ? (
          <>
            <SettingRow
              title={t('lan.current')}
              desc={status.passwordExpiresAt !== undefined ? t('lan.expires', { time: clock(status.passwordExpiresAt) }) : ''}
              control={
                <div className="dshws-lan-pw">
                  <span className="dshws-lan-pw-code">{status.password ?? t('lan.hidden')}</span>
                  {status.password !== undefined ? (
                    <Button size="sm" variant="outline" onClick={() => void copyText(status.password!).then((ok) => ok && props.notify(t('lan.copied')))}>
                      {t('lan.copy')}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run({ op: 'refreshPassword' }, t('lan.refreshed'))}>
                    {t('lan.refresh')}
                  </Button>
                </div>
              }
            />
            <SettingRow
              title={t('lan.interval')}
              desc={t('lan.intervalDesc')}
              control={
                <div className="dshws-lan-pw">
                  <select
                    className="dshws-select dshws-lan-field"
                    value={isCustom ? 'custom' : String(cfg.randomIntervalMinutes)}
                    disabled={disabled}
                    onChange={(e) => {
                      if (e.target.value === 'custom') {
                        setCustomInterval(String(cfg.randomIntervalMinutes))
                        setCustomMode(true)
                      } else {
                        setCustomMode(false)
                        void save({ randomIntervalMinutes: Number(e.target.value) })
                      }
                    }}
                  >
                    {presets.map((m) => (
                      <option key={m} value={String(m)}>
                        {intervalLabel(t, m)}
                      </option>
                    ))}
                    <option value="custom">{t('lan.custom')}</option>
                  </select>
                  {isCustom ? (
                    <>
                      <input
                        className="dshws-input dshws-lan-num"
                        inputMode="numeric"
                        value={customInterval !== '' || customMode ? customInterval : String(cfg.randomIntervalMinutes)}
                        disabled={disabled}
                        onChange={(e) => setCustomInterval(e.target.value.replace(/\D/g, '').slice(0, 5))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled || !(Number(customInterval) >= LAN_INTERVAL_MIN && Number(customInterval) <= LAN_INTERVAL_MAX)}
                        onClick={() => void save({ randomIntervalMinutes: Number(customInterval) }, t('lan.applied'))}
                      >
                        {t('lan.apply')}
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            />
          </>
        ) : (
          <SettingRow
            title={status.hasFixedPassword ? t('lan.fixedReset') : t('lan.fixedSet')}
            desc={
              <>
                {t('lan.fixedDesc', { min: LAN_FIXED_PASSWORD_MIN, max: LAN_FIXED_PASSWORD_MAX })}
                <span className="dshws-set-note" data-tone={status.hasFixedPassword ? 'ok' : undefined}>
                  {status.hasFixedPassword ? t('lan.fixedHas') : t('lan.fixedNone')}
                </span>
              </>
            }
            control={
              <div className="dshws-lan-pw">
                <input
                  className="dshws-input dshws-lan-field"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('lan.fixedPlaceholder')}
                  value={fixed}
                  disabled={disabled}
                  onChange={(e) => setFixed(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={disabled || fixed.length < LAN_FIXED_PASSWORD_MIN || fixed.length > LAN_FIXED_PASSWORD_MAX}
                  onClick={() =>
                    void save({ passwordMode: 'fixed' }, t('lan.applied'), fixed).then((ok) => {
                      if (ok) {
                        setFixed('')
                        setPendingFixed(false)
                      }
                    })
                  }
                >
                  {t('lan.fixedSave')}
                </Button>
              </div>
            }
          />
        )}
        <SettingRow
          title={t('lan.session')}
          desc={t('lan.sessionDesc')}
          control={
            <select className="dshws-select dshws-lan-field" value={String(cfg.sessionDays)} disabled={disabled} onChange={(e) => void save({ sessionDays: Number(e.target.value) })}>
              {(LAN_SESSION_DAYS as readonly number[]).map((d) => (
                <option key={d} value={String(d)}>
                  {t('lan.days', { n: d })}
                </option>
              ))}
            </select>
          }
        />
      </section>

      <section className="dshws-set-card">
        <div className="dshws-sbm-cardhead">
          <div className="dshws-section-title">
            {t('lan.devices')} {status.devices.length > 0 ? <span className="dshws-count">{status.devices.length}</span> : null}
          </div>
          {status.devices.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void dialogs
                  .confirm({ title: t('lan.kickAll'), message: t('lan.kickConfirm', { n: status.devices.length }), danger: true })
                  .then((ok) => ok && run({ op: 'kickAll' }))
              }
            >
              {t('lan.kickAll')}
            </Button>
          ) : null}
        </div>
        {status.devices.length === 0 ? <div className="dshws-set-desc dshws-lan-empty">{t('lan.devicesEmpty')}</div> : null}
        {status.devices.map((d: LanDevice) => (
          <div key={d.id} className="dshws-set-row">
            <div className="dshws-set-text">
              <div className="dshws-set-title">
                {d.userAgent !== '' ? deviceName(d.userAgent) : t('lan.unknownDevice')} <span className="dshws-lan-ip">{d.ip}</span>
              </div>
              <div className="dshws-set-desc">
                {t('lan.lastSeen', { time: relTime(t, d.lastSeenAt) })} · {t('lan.loginAt', { time: clock(d.createdAt) })}
              </div>
            </div>
            <div className="dshws-set-control">
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run({ op: 'kick', id: d.id })}>
                {t('lan.kick')}
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
