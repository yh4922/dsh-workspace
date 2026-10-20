/*
 * @Description: 远程工作区主页面（主区整页）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/WorkspacePage.tsx
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronLeft, IconPlus } from '../icons.js'
import type { HostView } from '../../types.js'
import type { WorkspaceApi } from '../api.js'
import type { Translate } from '../context.js'
import { GroupForm } from './GroupForm.js'
import { HostForm } from './HostForm.js'
import { HostList, type TestState } from './HostList.js'
import { LogPanel } from './LogPanel.js'
import { TerminalsPane } from './TerminalsPane.js'
import { DialogProvider, useDialogs } from './dialogs.js'
import { takeRequestedSection } from './update-flag.js'
import { FilesPane } from './FilesPane.js'
import { SettingsPane } from './SettingsPane.js'
import { SidebarPane } from './SidebarPane.js'
import { MemoryPane } from '../memory/MemoryPane.js'
import { useWorkspace, messageOf } from './useWorkspace.js'
import { AutoUnlockDialog, ChangePasswordDialog, HostKeyDialog, SetupBanner, UnlockBanner } from './vault.js'

/** 浏览器端 xterm 的回滚行数（与宿主端 scrollback 各自独立：宿主存的是回放用的原始字节）。 */
const CLIENT_SCROLLBACK_LINES = 5000
/** 打开终端时的初始尺寸；视图挂载后会按容器实际尺寸立即重新同步。 */
const INITIAL_COLS = 120
const INITIAL_ROWS = 32

type Section = 'hosts' | 'files' | 'terminals' | 'logs' | 'memory' | 'sidebar' | 'settings'

export interface WorkspacePageProps {
  t: Translate
  api: WorkspaceApi
  backToConversation: () => void
  /** 进入本页时的回调（移动端用来收起宿主左侧抽屉）；预览替身不传。 */
  onEnter?: () => void
}

type HostDialog = { mode: 'closed' } | { mode: 'new'; group?: string } | { mode: 'edit'; host: HostView }
type GroupDialog = { mode: 'closed' } | { mode: 'new'; parent?: string; preset?: string } | { mode: 'edit'; path: string }

/** 外层只负责挂对话框服务：内层组件要用 useDialogs，必须处在 Provider 之内。 */
export function WorkspacePage(props: WorkspacePageProps) {
  return (
    <DialogProvider t={props.t}>
      <WorkspacePageInner {...props} />
    </DialogProvider>
  )
}

function WorkspacePageInner(props: WorkspacePageProps) {
  const { t } = props
  const model = useWorkspace(props.api)
  const state = model.state
  const dialogs = useDialogs()

  // 移动端：进入本页时收起宿主左侧抽屉（宿主只对会话导航这么做）。只在挂载时跑一次。
  useEffect(() => {
    props.onEnter?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 插件代码被宿主重载（例如刚装完新版本）后，入口会请求直接打开某个分区（见 update-flag.ts）。
  const [section, setSection] = useState<Section>(() => (takeRequestedSection() as Section | null) ?? 'hosts')
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [filesHost, setFilesHost] = useState<string | null>(null)
  /** 文件页首次访问后保持挂载：切走再回来不丢展开状态和进行中的上传。 */
  const [filesVisited, setFilesVisited] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [hostDialog, setHostDialog] = useState<HostDialog>({ mode: 'closed' })
  const [groupDialog, setGroupDialog] = useState<GroupDialog>({ mode: 'closed' })
  const [changingPassword, setChangingPassword] = useState(false)
  const [enablingAutoUnlock, setEnablingAutoUnlock] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const hosts = state?.hosts ?? []
  const groups = state?.groups ?? []
  const groupPaths = useMemo(() => {
    const set = new Set<string>(groups.map((g) => g.path))
    for (const h of hosts) if (h.groupPath !== '') set.add(h.groupPath)
    return [...set].sort()
  }, [hosts, groups])

  const notify = (text: string): void => setToast(text)
  /** 把失败以 toast 呈现；vault-locked / host-key 已由 model.call 路由，不重复提示。 */
  const report = (error: unknown): void => notify(t('error.generic', { message: messageOf(error) }))

  // ---------------------------------------------------------------- 操作

  /**
   * 打开终端并切到终端页。失败时（如保险箱锁定）留在原处：
   * vault-locked 已由 model.call 路由成解锁横幅高亮，这里只需提示其余错误。
   */
  const openTerminal = async (hostId: string, options: { cwd?: string; title?: string } = {}): Promise<void> => {
    setOpening(hostId)
    try {
      const view = await model.call(
        'openTerminal',
        { hostId, cols: INITIAL_COLS, rows: INITIAL_ROWS, ...options },
        { hostId }
      )
      setActiveTerminal(view.id)
      setSection('terminals')
    } finally {
      setOpening(null)
    }
  }

  const test = async (host: HostView): Promise<void> => {
    setTests((prev) => ({ ...prev, [host.id]: { running: true } }))
    setSelectedId(host.id)
    try {
      const result = await model.call('testConnection', { id: host.id }, { hostId: host.id })
      setTests((prev) => ({ ...prev, [host.id]: { running: false, result } }))
    } catch (error) {
      setTests((prev) => ({
        ...prev,
        [host.id]: { running: false, result: { ok: false, message: messageOf(error) } }
      }))
    }
  }

  const deleteHost = async (host: HostView): Promise<void> => {
    const ok = await dialogs.confirm({
      title: t('host.delete'),
      message: t('host.deleteConfirm', { name: host.label }),
      confirmLabel: t('host.delete'),
      danger: true
    })
    if (ok) model.call('deleteHost', { id: host.id }).catch(report)
  }

  /**
   * 拖拽换分组：只改 groupPath，其余字段原样带回；认证 / 代理不发送即保留（不需要解锁取旧密文）。
   */
  const moveHost = async (host: HostView, groupPath: string): Promise<void> => {
    if (host.groupPath === groupPath) return
    try {
      await model.call(
        'saveHost',
        {
          id: host.id,
          label: host.label,
          hostname: host.hostname,
          port: host.port,
          groupPath,
          jumpHostIds: host.jumpHostIds,
          ...(host.username !== undefined ? { username: host.username } : {}),
          ...(host.startupCommand !== undefined ? { startupCommand: host.startupCommand } : {}),
          ...(host.environmentVariables !== undefined ? { environmentVariables: host.environmentVariables } : {}),
          ...(host.notes !== undefined ? { notes: host.notes } : {})
        },
        { hostId: host.id }
      )
      notify(t('host.moved', { name: host.label, group: groupPath === '' ? t('form.groupNone') : groupPath }))
    } catch (error) {
      report(error)
    }
  }

  const deleteGroup = async (path: string): Promise<void> => {
    const ok = await dialogs.confirm({
      title: t('group.delete'),
      message: t('group.deleteConfirm', { name: path }),
      confirmLabel: t('group.delete'),
      danger: true
    })
    if (ok) model.call('deleteGroup', { path }).catch(report)
  }

  /** 明文备份以文件形式下载，而不是显示在页面上：避免凭据停留在 DOM 里。 */
  const exportVault = async (): Promise<void> => {
    if (!(await dialogs.confirm({ title: t('vault.export'), message: t('vault.exportWarn') }))) return
    try {
      const data = await model.call('exportVault', {})
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dsh-workspace-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      report(error)
    }
  }

  const importVault = async (file: File): Promise<void> => {
    try {
      const payload = JSON.parse(await file.text()) as { hosts?: unknown[]; groups?: unknown[] }
      const result = await model.call('importVault', payload as never)
      notify(t('vault.imported', { hosts: result.hosts, groups: result.groups }))
    } catch (error) {
      report(error)
    }
  }

  const editingGroup =
    groupDialog.mode === 'edit' ? groups.find((g) => g.path === groupDialog.path) : undefined

  // ---------------------------------------------------------------- 渲染

  return (
    <div className="dshws-page">
      <button type="button" className="dshws-back" onClick={props.backToConversation}>
        <IconChevronLeft size={14} />
        <span>{t('back')}</span>
      </button>

      {/* 头部只留标题与简介：「上锁」「更多」（改主密码 / 导出 / 导入）都在「全局配置」页签里 */}
      <div className="dshws-head">
        <div className="dshws-head-text">
          <h2 className="dshws-title">{t('title')}</h2>
          <p className="dshws-intro">{t('intro')}</p>
        </div>
      </div>

      {state !== null && !state.ssh2.available ? (
        <div className="dshws-banner" data-tone="error">
          <div className="dshws-banner-text">
            <div className="dshws-banner-title">{t('ssh2.missing')}</div>
            {state.ssh2.error !== undefined ? (
              <div className="dshws-banner-hint" style={{ whiteSpace: 'pre-wrap' }}>
                {state.ssh2.error}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {state !== null && !state.initialized ? (
        <SetupBanner
          t={t}
          onSetup={async (password) => {
            await model.call('initVault', { password })
          }}
        />
      ) : null}

      {state !== null && state.initialized && !state.unlocked ? (
        <UnlockBanner
          t={t}
          attention={model.unlockRequested}
          onUnlock={async (password) => (await model.call('unlock', { password })).ok}
          onRemember={async (password) => {
            const r = await model.call('setAutoUnlock', { enabled: true, password })
            if (r.enabled) notify(t('vault.autoUnlockOn'))
          }}
        />
      ) : null}

      {/* 路由没挂上时明确告知，而不是让终端一直「连接中」、上传无声失败。 */}
      {state !== null && !state.webRoutes && (section === 'terminals' || section === 'files') ? (
        <div className="dshws-banner" data-tone="warn">
          <div className="dshws-banner-text">
            <div className="dshws-banner-title">{t('web.unavailableTitle')}</div>
            <div className="dshws-banner-hint">{t('web.unavailable')}</div>
          </div>
        </div>
      ) : null}

      <div className="dshws-sections" role="tablist">
        {(['hosts', 'files', 'terminals', 'logs', 'memory', 'sidebar', 'settings'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            data-active={section === key}
            onClick={() => {
              if (key === 'files') {
                setFilesVisited(true)
                // 首次进入文件页且未选主机时，默认第一台。
                if (filesHost === null && hosts[0] !== undefined) setFilesHost(hosts[0].id)
              }
              setSection(key)
            }}
          >
            {t(`section.${key}`)}
            {key === 'terminals' && (state?.terminals.length ?? 0) > 0 ? (
              <span className="dshws-count">{state?.terminals.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="dshws-body" data-section={section}>
        {section === 'hosts' ? (
          <div className="dshws-scroll">
            <div className="dshws-page-toolbar">
              <div className="dshws-search">
                <input
                  className="dshws-input"
                  placeholder={t('list.search')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t('list.search')}
                />
              </div>
              <Button size="sm" variant="primary" icon={<IconPlus size={16} />} onClick={() => setHostDialog({ mode: 'new' })}>
                {t('list.newHost')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setGroupDialog({ mode: 'new' })}>
                {t('list.newGroup')}
              </Button>
            </div>

            {model.loading ? null : (
              <HostList
                t={t}
                hosts={hosts}
                groups={groups}
                statuses={state?.statuses ?? []}
                query={query.trim()}
                selectedId={selectedId}
                tests={tests}
                opening={opening}
                onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
                onTest={(host) => void test(host)}
                onOpenTerminal={(host) => void openTerminal(host.id).catch(report)}
                onOpenFiles={(host) => {
                  setFilesHost(host.id)
                  setFilesVisited(true)
                  setSection('files')
                }}
                onEdit={(host) => setHostDialog({ mode: 'edit', host })}
                onDisconnect={(host) => void model.call('disconnect', { id: host.id }).catch(report)}
                onForgetKey={(host) =>
                  void model
                    .call('forgetHostKey', { id: host.id })
                    .then(() => notify(t('hostKey.forgotten')))
                    .catch(report)
                }
                onDelete={deleteHost}
                onAddHostInGroup={(path) => setHostDialog({ mode: 'new', group: path })}
                onEditGroup={(path) =>
                  groups.some((g) => g.path === path)
                    ? setGroupDialog({ mode: 'edit', path })
                    : // 只由主机 groupPath 推导出的虚拟分组：以「新建」形式补一条同路径的记录。
                      setGroupDialog({ mode: 'new', preset: path })
                }
                onDeleteGroup={deleteGroup}
                onMoveHost={(host, groupPath) => void moveHost(host, groupPath)}
              />
            )}
          </div>
        ) : null}

        {/* 文件页首次访问后保持挂载、只切可见性。 */}
        {filesVisited ? (
          <div className="dshws-fill" style={{ display: section === 'files' ? 'flex' : 'none' }}>
            <FilesPane
              t={t}
              model={model}
              hosts={hosts}
              hostId={filesHost}
              onHostChange={setFilesHost}
              onOpenTerminal={(hostId, cwd) => void openTerminal(hostId, { cwd }).catch(report)}
              notify={notify}
            />
          </div>
        ) : null}

        {/* 终端页始终挂载、只切换可见性：离开终端页再回来不会断开连接、不会重放。 */}
        <div className="dshws-fill" style={{ display: section === 'terminals' ? 'flex' : 'none' }}>
          <TerminalsPane
            t={t}
            model={model}
            terminals={state?.terminals ?? []}
            recent={state?.recentTerminals ?? []}
            hosts={hosts}
            activeId={activeTerminal}
            scrollback={CLIENT_SCROLLBACK_LINES}
            onActivate={setActiveTerminal}
            onOpen={openTerminal}
            onError={(message) => notify(t('error.generic', { message }))}
          />
        </div>

        {section === 'logs' ? (
          <div className="dshws-scroll">
            <LogPanel t={t} model={model} hosts={hosts} hostId={selectedId} onHostChange={setSelectedId} />
          </div>
        ) : null}

        {section === 'memory' ? (
          <div className="dshws-scroll">
            <MemoryPane t={t} call={model.call} notify={notify} onError={report} />
          </div>
        ) : null}

        {section === 'sidebar' ? (
          <div className="dshws-scroll">
            <SidebarPane t={t} call={model.call} notify={notify} onError={report} />
          </div>
        ) : null}

        {section === 'settings' ? (
          <div className="dshws-scroll">
            <SettingsPane
              t={t}
              call={model.call}
              autoUnlock={state?.initialized === true ? state.autoUnlock : null}
              // 原来在头部「上锁 / 更多」里的四件事，统一放到这里
              vault={{ initialized: state?.initialized === true, unlocked: state?.unlocked === true }}
              onLock={() => void model.call('lock', {}).catch(report)}
              onChangePassword={() => setChangingPassword(true)}
              onExport={() => void exportVault()}
              onImport={(file) => void importVault(file)}
              // 开启要再确认一次主密码；关闭直接删掉本机记住的密钥。
              onEnableAutoUnlock={() => setEnablingAutoUnlock(true)}
              onDisableAutoUnlock={() =>
                void model
                  .call('setAutoUnlock', { enabled: false })
                  .then(() => notify(t('vault.autoUnlockOff')))
                  .catch(report)
              }
              onError={report}
            />
          </div>
        ) : null}
      </div>

      {/* 弹窗按需挂载：每次打开都是全新的表单状态，不残留上次的输入（尤其是密码）。 */}
      {hostDialog.mode !== 'closed' ? (
        <HostForm
          t={t}
          open
          host={hostDialog.mode === 'edit' ? hostDialog.host : undefined}
          {...(hostDialog.mode === 'new' && hostDialog.group !== undefined ? { defaultGroup: hostDialog.group } : {})}
          hosts={hosts}
          groupPaths={groupPaths}
          onClose={() => setHostDialog({ mode: 'closed' })}
          onSave={async (input) => {
            await model.call('saveHost', input)
            setHostDialog({ mode: 'closed' })
          }}
          // 走 model.call：保险箱锁定 / 指纹变更照样路由到解锁横幅与指纹警告。
          onTest={(input) => model.call('testDraft', input, input.id !== undefined ? { hostId: input.id } : {})}
        />
      ) : null}

      {groupDialog.mode !== 'closed' ? (
        <GroupForm
          t={t}
          open
          group={editingGroup}
          {...(groupDialog.mode === 'new' && groupDialog.parent !== undefined ? { parentPath: groupDialog.parent } : {})}
          {...(groupDialog.mode === 'new' && groupDialog.preset !== undefined ? { presetPath: groupDialog.preset } : {})}
          groupPaths={groupPaths}
          onClose={() => setGroupDialog({ mode: 'closed' })}
          onSave={async (input) => {
            await model.call('saveGroup', input)
            setGroupDialog({ mode: 'closed' })
          }}
        />
      ) : null}

      {enablingAutoUnlock && state !== null ? (
        <AutoUnlockDialog
          t={t}
          open
          scheme={state.autoUnlock.scheme}
          onClose={() => setEnablingAutoUnlock(false)}
          onEnable={async (password) => {
            const r = await model.call('setAutoUnlock', { enabled: true, password })
            if (r.enabled) notify(t('vault.autoUnlockOn'))
            return r.ok
          }}
        />
      ) : null}

      {changingPassword ? (
        <ChangePasswordDialog
          t={t}
          open
          onClose={() => setChangingPassword(false)}
          onChange={async (oldPassword, newPassword) => {
            const { ok } = await model.call('changePassword', { oldPassword, newPassword })
            if (ok) notify(t('vault.changed'))
            return ok
          }}
        />
      ) : null}

      <HostKeyDialog
        t={t}
        alert={model.hostKeyAlert}
        onClose={model.dismissHostKeyAlert}
        onTrust={async (hostId) => {
          await model.call('forgetHostKey', { id: hostId })
          notify(t('hostKey.forgotten'))
        }}
      />

      {toast !== null ? <Toast text={toast} onDone={() => setToast(null)} /> : null}
    </div>
  )
}
