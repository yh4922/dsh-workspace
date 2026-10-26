/*
 * @Description: 新建 / 编辑主机的弹窗表单
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/HostForm.tsx
 */
import { useMemo, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown, IconClose, IconPlus } from '../icons.js'
import type { HostView } from '../../types.js'
import type { SaveHostInput, TestConnectionOutput } from '../../wire/dto.js'
import type { Translate } from '../context.js'
import {
  AuthFields,
  Field,
  ProxyFields,
  authDraftFrom,
  authInputFrom,
  formatEnv,
  parseEnv,
  proxyDraftFrom,
  proxyInputFrom,
  validPort,
  type AuthDraft,
  type ProxyDraft
} from './fields.js'
import { messageOf } from './useWorkspace.js'
import { GroupSelect } from './GroupSelect.js'

export interface HostFormProps {
  t: Translate
  open: boolean
  /** 编辑时传入；新建时为 undefined。 */
  host: HostView | undefined
  /** 新建时预填的分组路径（从分组行上的「+」进入时）。 */
  defaultGroup?: string
  hosts: HostView[]
  groupPaths: string[]
  onClose: () => void
  onSave: (input: SaveHostInput) => Promise<void>
  /** 用尚未保存的表单值测试连接。 */
  onTest: (input: SaveHostInput) => Promise<TestConnectionOutput>
}

export function HostForm(props: HostFormProps) {
  const { t, host } = props
  const [label, setLabel] = useState(host?.label ?? '')
  const [hostname, setHostname] = useState(host?.hostname ?? '')
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [username, setUsername] = useState(host?.username ?? '')
  const [groupPath, setGroupPath] = useState(host?.groupPath ?? props.defaultGroup ?? '')
  const [jumpHostIds, setJumpHostIds] = useState<string[]>(host?.jumpHostIds ?? [])
  // 不再提供「继承分组」：旧数据里继承认证的主机按「密码」展示；未改动认证区块时保存不会动它。
  const [auth, setAuth] = useState<AuthDraft>(() =>
    authDraftFrom(host === undefined || host.auth === null ? { kind: 'password', hasSecret: false, hasPassphrase: false } : host.auth)
  )
  const [proxy, setProxy] = useState<ProxyDraft>(() => proxyDraftFrom(host?.proxy))
  const [startupCommand, setStartupCommand] = useState(host?.startupCommand ?? '')
  const [envText, setEnvText] = useState(formatEnv(host?.environmentVariables))
  const [notes, setNotes] = useState(host?.notes ?? '')
  const [allowLocalShell, setAllowLocalShell] = useState(host?.allowLocalShell === true)
  const [allowLocalFiles, setAllowLocalFiles] = useState(host?.allowLocalFiles === true)
  // 打开了本机 shell / 本机文件读写的主机默认展开高级区：这是安全相关配置，编辑时要一眼能看到。
  const [showAdvanced, setShowAdvanced] = useState(
    host !== undefined &&
      (host.startupCommand !== undefined ||
        host.environmentVariables !== undefined ||
        host.notes !== undefined ||
        host.allowLocalShell === true ||
        host.allowLocalFiles === true)
  )

  // 编辑时只有动过认证 / 代理区块才发送对应键：「没动 = 不改」，
  // 这样只改名字的保存不会因为要取旧密码而要求解锁。新建时始终发送。
  const [authTouched, setAuthTouched] = useState(host === undefined)
  const [proxyTouched, setProxyTouched] = useState(host === undefined)

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const envParsed = useMemo(() => parseEnv(envText), [envText])
  const errors = {
    label: label.trim() === '' ? t('form.required') : undefined,
    hostname: hostname.trim() === '' ? t('form.required') : undefined,
    port: validPort(port) ? undefined : t('form.portInvalid'),
    env: envParsed.ok ? undefined : t('form.envInvalid', { line: envParsed.line }),
    proxy:
      proxy.enabled && (proxy.host.trim() === '' || !validPort(proxy.port)) ? t('form.portInvalid') : undefined
  }
  const hasError = Object.values(errors).some((e) => e !== undefined)

  // 可选跳板：排除自己，以及已在链上的。
  const jumpCandidates = props.hosts.filter((h) => h.id !== host?.id && !jumpHostIds.includes(h.id))
  const nameOf = (id: string): string => props.hosts.find((h) => h.id === id)?.label ?? id

  /** 由当前表单值组装请求体（保存与测试共用，保证「测的就是要存的」）。 */
  const buildInput = (): SaveHostInput | undefined => {
    if (!envParsed.ok) return undefined
    const authInput = authInputFrom(auth, authTouched)
    const proxyInput = proxyInputFrom(proxy, proxyTouched)
    return {
      ...(host !== undefined ? { id: host.id } : {}),
      // 测试时名称可以还没填，用地址顶上（保存时名称仍是必填）。
      label: label.trim() !== '' ? label.trim() : hostname.trim(),
      hostname: hostname.trim(),
      port: Number(port),
      groupPath,
      jumpHostIds,
      ...(username.trim() !== '' ? { username: username.trim() } : {}),
      ...(startupCommand.trim() !== '' ? { startupCommand } : {}),
      ...(Object.keys(envParsed.env).length > 0 ? { environmentVariables: envParsed.env } : {}),
      ...(notes.trim() !== '' ? { notes } : {}),
      // 始终发送：关掉时要显式写 false 才能覆盖旧值（服务端按补丁合并）。
      allowLocalShell,
      allowLocalFiles,
      ...(authInput !== undefined ? { auth: authInput } : {}),
      ...(proxyInput !== undefined ? { proxy: proxyInput } : {})
    }
  }

  const submit = async (): Promise<void> => {
    setSubmitted(true)
    const input = buildInput()
    if (hasError || input === undefined) return
    setSaving(true)
    setFormError(null)
    try {
      await props.onSave(input)
    } catch (error) {
      setFormError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  /** 用尚未保存的表单值测试连接；只要求连接相关字段合法，名称可以还没填。 */
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionOutput | null>(null)
  const test = async (): Promise<void> => {
    setSubmitted(true)
    const input = buildInput()
    if (errors.hostname !== undefined || errors.port !== undefined || errors.env !== undefined || errors.proxy !== undefined || input === undefined) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await props.onTest(input))
    } catch (error) {
      setTestResult({ ok: false, message: messageOf(error) })
    } finally {
      setTesting(false)
    }
  }

  const shown = (key: keyof typeof errors) => (submitted ? errors[key] : undefined)

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={host === undefined ? t('form.newHost') : t('form.editHost')}
      closeLabel={t('common.close')}
      className="dshws-form-dialog"
      contentClassName="dshws-form-content"
      footer={
        <div className="dshws-footer-wrap">
          <div className="dshws-footer">
            <div className="dshws-footer-test">
              <Button variant="outline" onClick={() => void test()} disabled={testing || saving}>
                {testing ? t('host.testing') : t('host.test')}
              </Button>
            </div>
            <Button variant="outline" onClick={props.onClose} disabled={saving}>
              {t('form.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={saving}>
              {saving ? t('form.saving') : t('form.save')}
            </Button>
          </div>
          {testResult !== null ? (
            <div className="dshws-host-result dshws-footer-result" data-ok={testResult.ok}>
              {testResult.ok
                ? t('host.testOk', { ms: testResult.latencyMs ?? 0, system: testResult.system ?? '' })
                : t('host.testFail', { message: testResult.message })}
            </div>
          ) : null}
        </div>
      }
    >
      <div className="dshws-form">
        {formError !== null ? <div className="dshws-form-error">{formError}</div> : null}

        <section>
          <div className="dshws-section-title">{t('form.basic')}</div>
          <div className="dshws-grid">
            <Field label={t('form.label')} required error={shown('label')} className="dshws-span-2">
              <input className="dshws-input" value={label} autoFocus onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label={t('form.hostname')} required error={shown('hostname')}>
              <input
                className="dshws-input dshws-mono"
                value={hostname}
                placeholder="192.168.1.10"
                onChange={(e) => setHostname(e.target.value)}
              />
            </Field>
            <Field label={t('form.port')} required error={shown('port')}>
              <input
                className="dshws-input"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Field label={t('form.username')}>
              <input className="dshws-input" value={username} placeholder="root" onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label={t('form.group')}>
              <GroupSelect t={t} value={groupPath} paths={props.groupPaths} allowCreate rootLabel={t('form.groupNone')} onChange={setGroupPath} />
            </Field>
          </div>
        </section>

        <section>
          <div className="dshws-section-title">{t('form.auth')}</div>
          <AuthFields
            t={t}
            draft={auth}
            saved={host?.auth}
            allowInherit={false}
            onChange={(next) => {
              setAuth(next)
              setAuthTouched(true)
            }}
          />
        </section>

        <section>
          <div className="dshws-section-title">{t('form.jump')}</div>
          <div className="dshws-jump-list">
            {jumpHostIds.length === 0 ? (
              <span className="dshws-field-hint">{t('form.jumpNone')}</span>
            ) : (
              jumpHostIds.map((id, index) => (
                <div className="dshws-jump-item" key={id}>
                  <span className="dshws-jump-index">{index + 1}</span>
                  <span className="dshws-jump-name">{nameOf(id)}</span>
                  <button
                    type="button"
                    className="dshws-icon-btn"
                    aria-label={t('host.delete')}
                    onClick={() => setJumpHostIds(jumpHostIds.filter((x) => x !== id))}
                  >
                    <IconClose size={14} />
                  </button>
                </div>
              ))
            )}
            {jumpCandidates.length > 0 ? (
              <select
                className="dshws-select"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') setJumpHostIds([...jumpHostIds, e.target.value])
                }}
              >
                <option value="">
                  {'+ '}
                  {t('form.jumpAdd')}
                </option>
                {jumpCandidates.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label} ({h.hostname})
                  </option>
                ))}
              </select>
            ) : null}
            {jumpHostIds.length > 0 ? <span className="dshws-field-hint">{t('form.jumpHint')}</span> : null}
          </div>
        </section>

        <section>
          <div className="dshws-section-title">{t('form.proxy')}</div>
          <ProxyFields
            t={t}
            draft={proxy}
            saved={host?.proxy}
            onChange={(next) => {
              setProxy(next)
              setProxyTouched(true)
            }}
          />
          {submitted && errors.proxy !== undefined ? (
            <span className="dshws-field-error">{errors.proxy}</span>
          ) : null}
        </section>

        <section>
          <button type="button" className="dshws-back" onClick={() => setShowAdvanced(!showAdvanced)}>
            <span style={{ display: 'inline-flex', transform: showAdvanced ? 'none' : 'rotate(-90deg)' }}>
              <IconChevronDown size={14} />
            </span>
            {t('form.advanced')}
          </button>
          {showAdvanced ? (
            <div className="dshws-grid" style={{ marginTop: 10 }}>
              <Field label={t('form.startup')} className="dshws-span-2">
                <input
                  className="dshws-input dshws-mono"
                  value={startupCommand}
                  onChange={(e) => setStartupCommand(e.target.value)}
                />
              </Field>
              <Field label={t('form.env')} hint={t('form.envHint')} error={shown('env')} className="dshws-span-2">
                <textarea
                  className="dshws-textarea dshws-mono"
                  rows={3}
                  spellCheck={false}
                  value={envText}
                  placeholder="NODE_ENV=production"
                  onChange={(e) => setEnvText(e.target.value)}
                />
              </Field>
              <Field label={t('form.notes')} className="dshws-span-2">
                <textarea className="dshws-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <Field label={t('form.localShell')} hint={t('form.localShellHint')} className="dshws-span-2">
                <span className="dshws-check">
                  <input type="checkbox" checked={allowLocalShell} onChange={(e) => setAllowLocalShell(e.target.checked)} />
                  {t('form.localShellCheck')}
                </span>
                {allowLocalShell ? <span className="dshws-set-note">{t('form.localShellOn')}</span> : null}
              </Field>
              <Field label={t('form.localFiles')} hint={t('form.localFilesHint')} className="dshws-span-2">
                <span className="dshws-check">
                  <input type="checkbox" checked={allowLocalFiles} onChange={(e) => setAllowLocalFiles(e.target.checked)} />
                  {t('form.localFilesCheck')}
                </span>
                {allowLocalFiles ? <span className="dshws-set-note">{t('form.localFilesOn')}</span> : null}
              </Field>
            </div>
          ) : null}
        </section>
      </div>
    </Modal>
  )
}

/** 供外部复用的「+」图标，避免各处重复 import。 */
export const PlusIcon = IconPlus
