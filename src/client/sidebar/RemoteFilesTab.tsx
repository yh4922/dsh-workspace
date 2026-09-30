/*
 * @Description: 右侧栏「文件管理」标签 —— 当前工作区（远程经 SFTP / 本地直接读写）的文件树，点文件在右侧栏打开；右键菜单（重命名 / 复制 / 粘贴 / 复制路径）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/RemoteFilesTab.tsx
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteEntry } from '../../wire/dto.js'
import { displayPath, localFileAddress, revealPlan, sessionFileAddress } from './remote-index.js'
import { RemoteFileViewer, type SidebarBodyProps } from './RemoteFileTab.js'
import { Split } from './Split.js'
import { NOTE_HEIGHT, ROW_HEIGHT, VirtualList } from './VirtualList.js'
import { isOutdatedHostError, useLocalSupport } from './host-support.js'
import { RenameInput, useRemoteFileMenu } from './file-menu.js'
import { EmptyState, FileIcon, IconButton, IconChevron, IconEye, IconFile, IconFolder, IconRefresh } from './ui.js'

interface DirState {
  loading: boolean
  entries?: RemoteEntry[]
  error?: string
}

/** 标签 id → 已处理的「显示文件位置」导航身份（见下方定位 effect）。 */
const handledReveals = new Map<string, string>()

export function RemoteFilesTab(props: SidebarBodyProps) {
  const { t, api, index, sessionId } = props
  const [, setVersion] = useState(0)
  useEffect(() => index.subscribe(() => setVersion((v) => v + 1)), [index])
  const workspace = index.workspaceFor(sessionId)
  // 升级后只刷新了页面、宿主端还是旧版：本地会话直接提示重启，而不是报「主机不存在：local:…」。
  const support = useLocalSupport(api, workspace?.local === true)
  // 依赖用字符串而不是 workspace 对象：对象换了但内容没变时不重载。
  const hostId = workspace?.hostId
  const root = workspace?.remotePath
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** 「显示文件位置」定位到的文件：只高亮并滚动过去，不打开（窄面板里打开会盖住列表）。 */
  const [focus, setFocus] = useState<{ path: string; nonce: number } | null>(null)
  const wideRef = useRef(false)
  // 导航参数（交付卡片「显示文件位置」经 sidebarRight.openTab 传入）；会话顶部标签没有 useTabInfo。
  const tabInfo = props.useTabInfo?.()
  const params = tabInfo?.tab.navigation?.params as { reveal?: unknown; nonce?: unknown } | undefined
  const reveal = typeof params?.reveal === 'string' ? params.reveal : undefined
  // 这次导航的身份：宿主每次 navigate 递增 revision；旧宿主没有时退回 openTab 传入的 nonce。
  const revealKey = `${tabInfo?.tab.navigation?.revision ?? ''}|${typeof params?.nonce === 'number' ? params.nonce : ''}`
  const tabId = tabInfo?.tab.id

  /**
   * 打开文件：够宽就在本页右侧打开；右侧栏里的窄面板维持原来的「新开一个文件标签」；
   * 会话顶部标签（没有标签信息）窄时也在本页打开（整页覆盖列表，✕ 返回）。
   */
  const openFile = (path: string): void => {
    // 用户自己点开文件后，定位高亮就不再有意义（否则会同时出现两个高亮行）。
    setFocus(null)
    // 本地文件交给宿主（或其他插件）的查看器：本插件的文件查看器只认领远程文件。
    if (!wideRef.current && props.useTabInfo !== undefined) props.openResource(workspace?.local === true ? localFileAddress(path) : sessionFileAddress(sessionId, path))
    else setSelected(path)
  }

  const loadDir = useCallback(
    async (dir: string) => {
      if (hostId === undefined) return
      setDirs((d) => ({ ...d, [dir]: { ...d[dir], loading: true } }))
      try {
        const r = await api.call('sftpList', { hostId, path: dir })
        setDirs((d) => ({ ...d, [dir]: { loading: false, entries: r.entries } }))
      } catch (err) {
        setDirs((d) => ({ ...d, [dir]: { loading: false, error: err instanceof Error ? err.message : String(err) } }))
      }
    },
    [api, hostId]
  )

  useEffect(() => {
    if (root !== undefined) void loadDir(root)
  }, [loadDir, root])

  // 定位：展开从根到文件所在目录的每一级并（重新）加载 —— 文件可能刚由 Agent 创建，旧列表里还没有它。
  // 宿主把导航参数保留到标签关闭：组件重新挂载（切会话回来、面板重建）时不能再执行一遍，
  // 所以按「标签 + 导航身份」记下已处理的，记录放在模块级（组件状态会随重新挂载丢失）。
  useEffect(() => {
    if (reveal === undefined || root === undefined || tabId === undefined) return
    if (handledReveals.get(tabId) === revealKey) return
    const plan = revealPlan(root, reveal)
    if (plan === undefined) return
    handledReveals.set(tabId, revealKey)
    setExpanded((cur) => new Set([...cur, ...plan.dirs]))
    for (const dir of [root, ...plan.dirs]) void loadDir(dir)
    // 目标在隐藏目录里时打开「显示隐藏文件」（否则目标行不渲染）；用户随时可以再关掉。
    if (plan.hidden) setShowHidden(true)
    setFocus({ path: reveal, nonce: Date.now() })
  }, [reveal, revealKey, tabId, root, loadDir])

  const menu = useRemoteFileMenu({
    t,
    api,
    hostId: hostId ?? '',
    root: root ?? '/',
    editable: true,
    reloadDir: (dir) => void loadDir(dir),
    onRenamed: (from, to) => {
      // 打开着的文件（或它所在的目录）被改名：跟着换路径。
      setSelected((cur) => (cur === null ? cur : cur === from ? to : cur.startsWith(`${from}/`) ? to + cur.slice(from.length) : cur))
      setExpanded((cur) => new Set([...cur].map((p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p))))
    },
    onPasted: (dir) => {
      if (dir !== root) setExpanded((cur) => new Set(cur).add(dir))
    },
    onCreatedFile: (path) => openFile(path),
    onRemoved: (path) => {
      setSelected((cur) => (cur !== null && (cur === path || cur.startsWith(`${path}/`)) ? null : cur))
    }
  })

  if (workspace === undefined || root === undefined) {
    return <div className="dshws-side-note">{t('side.noWorkspace')}</div>
  }
  if (support === 'outdated') return <div className="dshws-side-note" data-tone="error">{t('side.localNeedsRestart')}</div>

  const toggle = (dir: string): void => {
    const next = new Set(expanded)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (dirs[dir]?.entries === undefined) void loadDir(dir)
    }
    setExpanded(next)
  }

  /**
   * 把展开着的目录树拍平成行（虚拟滚动只渲染可见的几十行，几千个文件也不卡）。
   * 行的种类：条目 / 正在改名的条目 / 加载中或出错的提示。
   */
  type Row = { kind: 'entry'; entry: RemoteEntry; depth: number } | { kind: 'note'; key: string; text: string; depth: number; tone?: 'error' }
  const rows: Row[] = []
  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir]
    if (state === undefined || (state.loading && state.entries === undefined)) {
      rows.push({ kind: 'note', key: `${dir}#loading`, text: t('files.loading'), depth })
      return
    }
    if (state.error !== undefined) {
      rows.push({ kind: 'note', key: `${dir}#error`, text: isOutdatedHostError(state.error) ? t('side.localNeedsRestart') : state.error, depth, tone: 'error' })
      return
    }
    for (const e of state.entries ?? []) {
      if (!showHidden && e.hidden) continue
      rows.push({ kind: 'entry', entry: e, depth })
      if ((e.type === 'dir' || e.linkIsDir === true) && expanded.has(e.path)) walk(e.path, depth + 1)
    }
  }
  walk(root, 0)
  const rootEmpty = rows.length === 0

  const renderRow = (r: Row) => {
    if (r.kind === 'note') {
      return (
        <div className="dshws-tree-note" data-tone={r.tone} title={r.text} style={{ paddingLeft: 12 + r.depth * 14 }}>
          {r.text}
        </div>
      )
    }
    const e = r.entry
    const depth = r.depth
    const isDir = e.type === 'dir' || e.linkIsDir === true
    const open = expanded.has(e.path)
    if (menu.renaming === e.path) {
      return <RenameInput initial={e.name} paddingLeft={6 + depth * 14} onSubmit={(name) => void menu.submitRename(e.path, name)} onCancel={menu.cancelRename} />
    }
    return (
      <button
        type="button"
        className="dshws-row"
        data-ignored={e.ignored}
        data-hidden={e.hidden}
        data-selected={selected === e.path || focus?.path === e.path}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={displayPath(e.path)}
        onClick={() => (isDir ? toggle(e.path) : openFile(e.path))}
        onContextMenu={(ev) => menu.openFor(ev, e.path, isDir)}
      >
        <span className="dshws-row-caret">{isDir ? <IconChevron size={12} open={open} /> : null}</span>
        {isDir ? <IconFolder open={open} /> : <FileIcon name={e.name} />}
        <span className="dshws-row-name">{e.name}</span>
        {e.linkTarget !== undefined ? <span className="dshws-row-dim">→ {e.linkTarget}</span> : null}
      </button>
    )
  }
  const list = (
    <div className="dshws-side">
      <div className="dshws-toolbar">
        <IconFolder open />
        <span className="dshws-toolbar-title" title={`${workspace.title}: ${displayPath(root)}`}>
          {workspace.title}
        </span>
        <IconButton title={t('add.showHidden')} active={showHidden} onClick={() => setShowHidden(!showHidden)}>
          <IconEye off={!showHidden} />
        </IconButton>
        <IconButton
          title={t('add.refresh')}
          onClick={() => {
            void loadDir(root)
            for (const d of expanded) void loadDir(d)
          }}
        >
          <IconRefresh />
        </IconButton>
      </div>
      <div className="dshws-subbar dshws-mono" title={displayPath(root)}>
        {displayPath(root)}
      </div>
      <VirtualList
        items={rows}
        itemKey={(r) => (r.kind === 'entry' ? r.entry.path : r.key)}
        itemHeight={(r) => (r.kind === 'entry' ? ROW_HEIGHT : NOTE_HEIGHT)}
        renderItem={renderRow}
        scrollTo={focus === null ? undefined : { key: focus.path, nonce: focus.nonce }}
        onContextMenu={menu.openForRoot}
        footer={rootEmpty ? <EmptyState text={t('add.emptyDir')} /> : undefined}
      />
      {menu.node}
    </div>
  )

  return (
    <Split
      list={list}
      storageKey="files"
      resizeLabel={t('side.resizeList')}
      onWideChange={(w) => {
        wideRef.current = w
      }}
      placeholder={<EmptyState icon={<IconFile size={30} />} text={t('side.pickFile')} />}
      detail={
        selected === null ? null : (
          <RemoteFileViewer
            key={selected}
            t={t}
            api={api}
            hostId={workspace.hostId}
            remotePath={selected}
            workspaceTitle={workspace.title}
            onClose={() => setSelected(null)}
          />
        )
      }
    />
  )
}
