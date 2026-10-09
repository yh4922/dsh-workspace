/*
 * @Description: 右侧栏「Git 仓库」（远程工作区经 SSH、本地工作区直接执行 git）—— 改动（暂存 / 提交 / 丢弃 / diff）、查看其他分支（只读）、提交历史分叉图
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/GitTab.tsx
 *
 * 所有 git 命令经宿主在远程工作区根目录执行（网关校验根目录）。
 * 「分支」只用于挑选要查看的分支：查看时读对象库（ls-tree / show / log / diff），
 * 不检出 —— 远程目录当前的分支、暂存区和文件都不变（与 uGit 的「切换查看」一致）。
 * 会改变仓库的操作只有改动页的暂存 / 丢弃 / 提交，都由用户点击触发；丢弃需二次确认。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Split } from './Split.js'
import { NOTE_HEIGHT, ROW_HEIGHT, SECTION_HEIGHT, VirtualList } from './VirtualList.js'
import { getDefaultRef, setDefaultRef } from './git-default.js'
import { EmptyState, FileIcon, IconBack, IconBranch, IconButton, IconChevron, IconCloud, IconCommit, IconEye, IconFolder, IconMinus, IconPin, IconPlus, IconRefresh, IconSubmodule, IconTag, IconUndo, StatusBadge } from './ui.js'
import type { GitBranch, GitChangedFile, GitCommit, GitFileStatus, GitStatus, GitTreeEntry } from '../../git/parse.js'
import type { BranchInfo, DiffSides, DiffTarget } from '../../git/remote-git.js'
import { graphWidth, layoutGraph, type GraphRow } from '../../git/graph.js'
import type { GitOp } from '../../wire/dto.js'
import { CodeEditor } from '../files/CodeEditor.js'
import { useEditorPref } from '../editor-prefs.js'
import { isLight, resolveColor } from '../terminal/theme.js'
import { DiffView } from './DiffView.js'
import { markdownDocument } from './markdown.js'
import { RemoteFileViewer, type SidebarBodyProps } from './RemoteFileTab.js'
import { copyText, relativeTo, showFloat, useContextMenu, type MenuItem } from './ContextMenu.js'
import { RenameInput, useRemoteFileMenu } from './file-menu.js'
import { displayPath } from './remote-index.js'
import { useLocalSupport } from './host-support.js'

/** 未查看其他分支时的页签：与查看分支时一致，都是 文件 / 改动 / 历史。 */
type View = 'files' | 'changes' | 'history'
type ViewTab = 'files' | 'changes' | 'history' | 'compare'
type NotRepo = { isRepo: false; reason: string }
const PAGE = 300
const LANE_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#e11d48', '#a855f7', '#14b8a6', '#eab308', '#64748b']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(ms).toLocaleDateString()
}

export function GitTab(props: SidebarBodyProps) {
  const { t, api, index, sessionId } = props
  const [, setVersion] = useState(0)
  useEffect(() => index.subscribe(() => setVersion((v) => v + 1)), [index])
  const workspace = index.workspaceFor(sessionId)
  const support = useLocalSupport(api, workspace?.local === true)
  // 依赖用主机 + 目录这两个字符串，而不是 workspace 对象：对象换了但内容没变时，
  // 不应让 call / refresh 等回调变化 —— 它们一变就会触发重载并清掉右侧已打开的预览。
  const wsHost = workspace?.hostId
  const wsRoot = workspace?.remotePath

  /** worktree：分支检出在另一个 git 工作目录时，在那个目录里执行（宿主校验属于同一仓库）。 */
  const call = useCallback(
    async <T,>(op: GitOp, worktree?: string): Promise<T> => {
      if (wsHost === undefined || wsRoot === undefined) throw new Error(t('side.noWorkspace'))
      return (await api.call('git', {
        hostId: wsHost,
        root: wsRoot,
        ...(worktree !== undefined ? { worktree } : {}),
        ...op
      })) as T
    },
    [api, wsHost, wsRoot, t]
  )

  const [view, setView] = useState<View>('files')
  /** 正在查看的分支（只读，不检出）；null = 查看工作目录本身。 */
  const [viewing, setViewing] = useState<GitBranch | null>(null)
  const [viewTab, setViewTab] = useState<ViewTab>('files')
  const [viewFile, setViewFile] = useState<{ path: string; text?: string; binary?: boolean; tooLarge?: boolean; error?: string } | null>(null)
  /** 所查看分支的编辑方式（每次进入 / 写操作后重新取；宿主写操作前还会再判断一次）。 */
  const [binfo, setBinfo] = useState<BranchInfo | null>(null)
  /** 分支内容变化计数：保存 / 撤销 / 提交后递增，文件树与改动列表据此重载。 */
  const [rev, setRev] = useState(0)
  const [fileMode, setFileMode] = useState<'code' | 'preview'>('code')
  const [status, setStatus] = useState<GitStatus | NotRepo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<{ target: DiffTarget; title: string; worktree?: string; sides?: DiffSides; error?: string } | null>(null)
  /** 右侧打开的真实文件（远程绝对路径）：diff 里点「查看源文件」时用。与 diff / 分支文件互斥。 */
  const [source, setSource] = useState<string | null>(null)
  const [sideBySide, setSideBySide] = useState(() => localStorage.getItem('dshws.git.sbs') !== '0')
  const [collapseUnchanged, setCollapseUnchanged] = useEditorPref('diffCollapse')

  /**
   * 刷新 git status。结果与上次相同则不更新状态（轮询时列表不闪、不重渲染）；
   * 不同则整体替换 —— 列表按路径作 key，React 只更新变化的行（增量更新，不整页重载）。
   */
  const lastStatusJson = useRef('')
  const refresh = useCallback(async () => {
    try {
      const next = await call<GitStatus | NotRepo>({ op: 'status' })
      const json = JSON.stringify(next)
      setError(null)
      if (json === lastStatusJson.current) return
      lastStatusJson.current = json
      setStatus(next)
    } catch (err) {
      setError(messageOf(err))
    }
  }, [call])

  useEffect(() => {
    if (wsHost !== undefined) void refresh()
  }, [refresh, wsHost])

  /**
   * 本会话默认查看的分支：进入面板（每次挂载）时自动切到它查看。
   * 只套用一次 —— 之后用户点「回到当前分支」或换别的分支，以用户操作为准。
   * 分支已不存在时静默忽略（设置保留，分支恢复后仍会生效）。
   */
  const [defaultRef, setDefaultRefState] = useState<string | null>(() => getDefaultRef(sessionId))
  const appliedDefault = useRef(false)
  useEffect(() => {
    if (appliedDefault.current || defaultRef === null || status === null || !status.isRepo) return
    appliedDefault.current = true
    call<{ branches: GitBranch[] }>({ op: 'branches' }).then(
      (r) => {
        const b = r.branches.find((x) => x.ref === defaultRef)
        if (b !== undefined) {
          setViewing(b)
          setViewTab('files')
        }
      },
      () => undefined
    )
  }, [call, defaultRef, status])
  const changeDefault = (ref: string | null): void => {
    setDefaultRef(sessionId, ref)
    setDefaultRefState(ref)
  }

  /** 执行一个改动类操作，完成后刷新状态。 */
  const act = async (op: GitOp): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await call(op)
      await refresh()
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  // 右侧内容「后打开的为准」：diff 与分支文件互斥，打开一个就关掉另一个。
  // 否则 diff 优先级更高，先开过 diff 再点分支文件时右侧不更新（用户实测踩到）。
  const openDiff = async (target: DiffTarget, title: string, worktree?: string): Promise<void> => {
    setViewFile(null)
    setSource(null)
    const base = { target, title, ...(worktree !== undefined ? { worktree } : {}) }
    setDiff(base)
    try {
      const sides = await call<DiffSides>({ op: 'diff', target }, worktree)
      setDiff({ ...base, sides })
    } catch (err) {
      setDiff({ ...base, error: messageOf(err) })
    }
  }

  const loadBranchInfo = useCallback(
    async (ref: string) => {
      try {
        setBinfo(await call<BranchInfo>({ op: 'branchInfo', ref }))
      } catch (err) {
        setError(messageOf(err))
      }
    },
    [call]
  )
  // 只在「查看的分支」真正变化时清空右侧：loadBranchInfo 走 ref，不作为依赖（它的身份变化不代表换了分支）。
  const loadBranchInfoRef = useRef(loadBranchInfo)
  loadBranchInfoRef.current = loadBranchInfo
  const viewingRef = viewing?.ref ?? null
  useEffect(() => {
    setBinfo(null)
    // 换了要查看的分支（或回到当前分支）：上一个分支的 diff / 文件不再相关。
    setDiff(null)
    setViewFile(null)
    setSource(null)
    if (viewingRef !== null) void loadBranchInfoRef.current(viewingRef)
  }, [viewingRef])
  // 所在页签对这个分支不适用（如当前分支没有「比较」）时回到「文件」。
  useEffect(() => {
    if (binfo !== null && !viewTabs(binfo).includes(viewTab)) setViewTab('files')
  }, [binfo, viewTab])

  /**
   * 所查看分支检出在另一个 git 工作目录时，那个目录的路径（改文件、改动页、提交都在那里进行）。
   * 当前分支 / 未检出的分支为 undefined。
   */
  const otherWorktree =
    viewing !== null && binfo?.mode === 'worktree' && binfo.worktreePath !== undefined && workspace !== undefined && binfo.worktreePath !== workspace.remotePath
      ? binfo.worktreePath
      : undefined
  const [wtStatus, setWtStatus] = useState<GitStatus | null>(null)
  const refreshWt = useCallback(async () => {
    if (otherWorktree === undefined) {
      setWtStatus(null)
      return
    }
    try {
      const s = await call<GitStatus | NotRepo>({ op: 'status' }, otherWorktree)
      setWtStatus(s.isRepo ? s : null)
    } catch (err) {
      setError(messageOf(err))
    }
  }, [call, otherWorktree])
  useEffect(() => {
    void refreshWt()
  }, [refreshWt])

  /** 另一个工作目录里的暂存 / 丢弃 / 提交。 */
  const actWt = async (op: GitOp): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await call(op, otherWorktree)
      await refreshWt()
      setRev((r) => r + 1)
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 分支内容变了：重载文件树 / 改动列表 / 分支信息（当前分支还要刷新 git status）。 */
  const branchChanged = (): void => {
    setRev((r) => r + 1)
    if (viewing !== null) void loadBranchInfo(viewing.ref)
    void refresh()
    void refreshWt()
  }

  /**
   * 改动页可见时自动刷新：进入时立即刷新，之后每 8 秒一次（页面在前台时），窗口重新获得焦点时也刷新。
   * 这样 Agent / 终端 / 编辑器在别处改了文件，改动页不用手动点刷新（用户要求）。
   * 未检出分支的改动存在本插件的临时索引里，只会被本面板改动，保存时已刷新，无需轮询。
   */
  const changesVisible = (viewing === null && view === 'changes') || (viewing !== null && viewTab === 'changes' && binfo?.mode === 'worktree')
  const pollRef = useRef<() => void>(() => undefined)
  pollRef.current = () => {
    void refresh()
    if (otherWorktree !== undefined) void refreshWt()
  }
  useEffect(() => {
    if (!changesVisible) return
    pollRef.current()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') pollRef.current()
    }, 8000)
    const onFocus = (): void => pollRef.current()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [changesVisible, otherWorktree])

  const openViewFile = async (path: string): Promise<void> => {
    if (viewing === null) return
    setDiff(null)
    setSource(null)
    setFileMode(/\.(md|markdown|mdx)$/i.test(path) ? 'preview' : 'code')
    setViewFile({ path })
    // 当前检出分支：文件就是远程目录里的真实文件，交给远程文件编辑器（右侧直接读写）。
    if (binfo?.mode === 'worktree') return
    try {
      const r = await call<{ text: string; binary: boolean; tooLarge: boolean }>({ op: 'file', ref: viewing.ref, path })
      setViewFile({ path, text: r.text, binary: r.binary, tooLarge: r.tooLarge })
    } catch (err) {
      setViewFile({ path, error: messageOf(err) })
    }
  }

  if (workspace === undefined) return <div className="dshws-side-note">{t('side.noWorkspace')}</div>
  if (support === 'outdated') return <div className="dshws-side-note" data-tone="error">{t('side.localNeedsRestart')}</div>

  /** 当前检出分支的文件树：远程目录里的真实文件（SFTP），隐藏 .git。路径统一为仓库内相对路径。 */
  // 当前分支 = 工作区根目录；检出在另一个 git 工作目录的分支 = 那个目录。
  const rootDir = (otherWorktree ?? workspace.remotePath).replace(/\/+$/, '')
  const worktreeLoader = async (dir: string): Promise<GitTreeEntry[]> => {
    const r = await api.call('sftpList', { hostId: workspace.hostId, path: dir === '' ? rootDir || '/' : `${rootDir}/${dir}` })
    return r.entries
      .filter((e) => !(dir === '' && e.name === '.git'))
      .map((e): GitTreeEntry => ({ name: e.name, path: dir === '' ? e.name : `${dir}/${e.name}`, type: e.type === 'dir' || e.linkIsDir === true ? 'tree' : 'blob' }))
      .sort((a, b) => (a.type === 'tree' ? 0 : 1) - (b.type === 'tree' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  }

  /**
   * diff 里的「查看源文件」：打开对应分支里的这个文件。
   * - 正在查看某个分支：打开该分支的文件（当前分支 / 另一个工作目录 → 真实文件；未检出分支 → 分支里的版本，可编辑）
   * - 没在查看分支（改动页 / 全部历史）：打开远程目录里的真实文件
   */
  const openSourceOf = (d: { target: DiffTarget; worktree?: string }): void => {
    const path = d.target.path
    if (viewing !== null) {
      void openViewFile(path)
      return
    }
    setDiff(null)
    setViewFile(null)
    setSource(`${(d.worktree ?? workspace.remotePath).replace(/\/+$/, '')}/${path}`)
  }

  /** 改动列表右键「打开文件」：在右侧打开工作目录里的真实文件（可编辑）。 */
  const openAbs = (abs: string): void => {
    setDiff(null)
    setViewFile(null)
    setSource(abs)
  }

  // 内容页（diff / 分支里的文件）：宽时显示在右侧，窄时整页覆盖列表 —— 由 Split 决定。
  let detail: ReactNode = null

  // ---------------------------------------------------------------- 分支里的文件
  if (diff === null && viewing !== null && viewFile !== null && binfo?.mode === 'worktree') {
    detail = (
      <RemoteFileViewer
        key={viewFile.path}
        t={t}
        api={api}
        hostId={workspace.hostId}
        remotePath={`${rootDir}/${viewFile.path}`}
        workspaceTitle={workspace.title}
        onSaved={branchChanged}
        onClose={() => {
          setViewFile(null)
          branchChanged()
        }}
      />
    )
  } else if (diff === null && source !== null) {
    // diff 里点「查看源文件」：工作目录里的真实文件（当前分支 / 分支所在的工作目录），可直接编辑。
    detail = (
      <RemoteFileViewer
        key={source}
        t={t}
        api={api}
        hostId={workspace.hostId}
        remotePath={source}
        workspaceTitle={workspace.title}
        onSaved={branchChanged}
        onClose={() => setSource(null)}
      />
    )
  } else if (diff === null && viewing !== null && viewFile !== null) {
    const isMd = /\.(md|markdown|mdx)$/i.test(viewFile.path)
    const editable = binfo?.mode === 'index'
    detail = (
      <div className="dshws-side">
        <div className="dshws-side-head">
          <button type="button" className="dshws-link-btn" onClick={() => setViewFile(null)}>
            <IconBack size={14} />
            {t('git.back')}
          </button>
          <span className="dshws-side-title" title={viewFile.path}>
            {viewFile.path.slice(viewFile.path.lastIndexOf('/') + 1)}
          </span>
          {isMd ? (
            <span className="dshws-side-seg">
              <button type="button" data-active={fileMode === 'code'} onClick={() => setFileMode('code')}>{t('side.code')}</button>
              <button type="button" data-active={fileMode === 'preview'} onClick={() => setFileMode('preview')}>{t('side.preview')}</button>
            </span>
          ) : null}
        </div>
        <div className="dshws-side-path dshws-mono">
          {shortRef(viewing.ref)} : {viewFile.path} · {editable ? t('git.branchEditHint') : t('editor.readOnly')}
        </div>
        {viewFile.error !== undefined ? (
          <div className="dshws-tree-note" data-tone="error">{viewFile.error}</div>
        ) : viewFile.text === undefined ? (
          <div className="dshws-tree-note">{t('files.loading')}</div>
        ) : viewFile.binary === true ? (
          <div className="dshws-tree-note">{t('git.binary')}</div>
        ) : viewFile.tooLarge === true ? (
          <div className="dshws-tree-note">{t('git.tooLarge')}</div>
        ) : isMd && fileMode === 'preview' ? (
          // 分支里的文件不在工作目录，相对图片无从加载：不给 <base>。
          <iframe
            className="dshws-side-frame"
            title={viewFile.path}
            sandbox=""
            srcDoc={markdownDocument(viewFile.text, undefined, !isLight(resolveColor('var(--dsw-alias-bg-layer-1)', '#ffffff')))}
          />
        ) : (
          <CodeEditor
            key={`${viewing.ref}:${viewFile.path}:${binfo?.mode ?? ''}`}
            t={t}
            path={viewFile.path}
            content={viewFile.text}
            readOnly={!editable}
            onDirtyChange={() => undefined}
            onSave={async (value) => {
              // 写进该分支的临时索引（未提交）；宿主会再判断一次编辑方式。
              try {
                await call({ op: 'branchSave', ref: viewing.ref, path: viewFile.path, content: value })
                setViewFile((cur) => (cur !== null && cur.path === viewFile.path ? { ...cur, text: value } : cur))
                branchChanged()
              } catch (err) {
                setError(messageOf(err))
                throw err
              }
            }}
            registerSave={() => undefined}
            fetchAsset={(name, i) => api.call('editorAsset', { name, index: i })}
          />
        )}
      </div>
    )
  }

  // ---------------------------------------------------------------- diff
  if (diff !== null) {
    detail = (
      <div className="dshws-side">
        <div className="dshws-side-head">
          <button type="button" className="dshws-link-btn" onClick={() => setDiff(null)}>
            <IconBack size={14} />
            {t('git.back')}
          </button>
          <span className="dshws-side-title" title={diff.title}>
            {diff.title}
          </span>
          <button type="button" className="dshws-link-btn" title={t('git.openSourceHint')} onClick={() => openSourceOf(diff)}>
            {t('git.openSource')}
          </button>
          <span className="dshws-side-seg">
            <button type="button" data-active={sideBySide} onClick={() => { setSideBySide(true); localStorage.setItem('dshws.git.sbs', '1') }}>
              {t('git.sideBySide')}
            </button>
            <button type="button" data-active={!sideBySide} onClick={() => { setSideBySide(false); localStorage.setItem('dshws.git.sbs', '0') }}>
              {t('git.inline')}
            </button>
          </span>
          <button
            type="button"
            className="dshws-side-toggle"
            data-active={!collapseUnchanged}
            aria-pressed={!collapseUnchanged}
            title={collapseUnchanged ? t('git.expandAllHint') : t('git.collapseHint')}
            onClick={() => setCollapseUnchanged(!collapseUnchanged)}
          >
            {t('git.expandAll')}
          </button>
        </div>
        {diff.error !== undefined ? (
          <div className="dshws-tree-note" data-tone="error">{diff.error}</div>
        ) : diff.sides === undefined ? (
          <div className="dshws-tree-note">{t('files.loading')}</div>
        ) : diff.sides.binary ? (
          <div className="dshws-tree-note">{t('git.binary')}</div>
        ) : diff.sides.tooLarge ? (
          <div className="dshws-tree-note">{t('git.tooLarge')}</div>
        ) : (
          <DiffView
            key={JSON.stringify(diff.target)}
            t={t}
            path={diff.target.path}
            original={diff.sides.original}
            modified={diff.sides.modified}
            sideBySide={sideBySide}
            collapseUnchanged={collapseUnchanged}
            fetchAsset={(name, i) => api.call('editorAsset', { name, index: i })}
          />
        )}
      </div>
    )
  }

  const repo = status !== null && status.isRepo ? status : null

  const list = (
    <div className="dshws-side">
      <div className="dshws-toolbar dshws-git-toolbar">
        {repo === null ? (
          <>
            <IconBranch />
            <span className="dshws-toolbar-title" title={displayPath(workspace.remotePath)}>
              {workspace.title}
            </span>
          </>
        ) : (
          <BranchPicker
            t={t}
            call={call}
            repo={repo}
            viewing={viewing}
            binfo={binfo}
            otherWorktree={otherWorktree}
            defaultRef={defaultRef}
            onSetDefault={changeDefault}
            onView={(b) => {
              setViewing(b)
              setViewTab('files')
              setViewFile(null)
            }}
            onBackToCurrent={() => {
              setViewing(null)
              setViewFile(null)
            }}
          />
        )}
        {viewing === null && repo !== null && repo.upstream !== null && (repo.ahead > 0 || repo.behind > 0) ? (
          <span className="dshws-git-ab" title={t('git.aheadBehind', { upstream: repo.upstream, ahead: repo.ahead, behind: repo.behind })}>
            {repo.ahead > 0 ? <span>↑{repo.ahead}</span> : null}
            {repo.behind > 0 ? <span>↓{repo.behind}</span> : null}
          </span>
        ) : null}
        <IconButton title={t('add.refresh')} disabled={busy} onClick={branchChanged}>
          <IconRefresh />
        </IconButton>
      </div>
      {repo !== null && viewing !== null ? (
        <>
          {binfo?.mode === 'readonly' && binfo.reason !== 'otherWorktree' ? (
            <CreateLocalBranch
              t={t}
              call={call}
              from={viewing}
              onCreated={(ref, name) => {
                setViewing({ ref, name, remote: false, head: false, commit: viewing.commit, upstream: null })
                setViewFile(null)
                void refresh()
              }}
            />
          ) : null}
          <div className="dshws-git-tabs" role="tablist">
            {viewTabs(binfo).map((v) => (
              <button key={v} type="button" role="tab" data-active={viewTab === v} onClick={() => setViewTab(v)}>
                {t(`git.view.${v}`)}
                {v === 'changes' && pendingCount(binfo, otherWorktree !== undefined ? wtStatus : repo) > 0 ? (
                  <span className="dshws-count">{pendingCount(binfo, otherWorktree !== undefined ? wtStatus : repo)}</span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {repo !== null && viewing === null ? (
        <div className="dshws-git-tabs" role="tablist">
          {(['files', 'changes', 'history'] as const).map((v) => (
            <button key={v} type="button" role="tab" data-active={view === v} onClick={() => setView(v)}>
              {t(`git.view.${v}`)}
              {v === 'changes' && repo.files.length > 0 ? <span className="dshws-count">{repo.files.length}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {error !== null ? <div className="dshws-tree-note" data-tone="error">{error}</div> : null}
      {status === null ? (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      ) : !status.isRepo ? (
        <div className="dshws-side-note">{status.reason}</div>
      ) : viewing !== null && binfo === null ? (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      ) : viewing !== null ? (
        viewTab === 'files' ? (
          <TreeView
            key={`${viewing.ref}:${binfo?.mode ?? ''}`}
            t={t}
            reloadKey={`${viewing.ref}:${binfo?.mode ?? ''}:${rev}`}
            selected={viewFile?.path}
            load={binfo?.mode === 'worktree' ? worktreeLoader : (dir) => call<{ entries: GitTreeEntry[] }>({ op: 'tree', ref: viewing.ref, dir }).then((r) => r.entries)}
            onOpen={(p) => void openViewFile(p)}
            menu={{
              api,
              hostId: workspace.hostId,
              root: rootDir,
              // 检出着的分支是磁盘上的真实文件，可重命名 / 复制 / 粘贴；其他分支只在对象库里，只能复制相对路径。
              editable: binfo?.mode === 'worktree',
              onRenamed: (from, to) => {
                setViewFile((cur) => (cur !== null && cur.path === from ? { ...cur, path: to } : cur))
                branchChanged()
              }
            }}
          />
        ) : viewTab === 'changes' ? (
          binfo?.mode === 'worktree' && otherWorktree !== undefined ? (
            wtStatus === null ? (
              <div className="dshws-tree-note">{t('files.loading')}</div>
            ) : (
              <ChangesView t={t} status={wtStatus} busy={busy} act={actWt} openDiff={(target, title) => openDiff(target, title, otherWorktree)} rootDir={otherWorktree} openFile={openAbs} />
            )
          ) : binfo?.mode === 'worktree' ? (
            <ChangesView t={t} status={status} busy={busy} act={act} openDiff={openDiff} rootDir={workspace.remotePath} openFile={openAbs} />
          ) : binfo?.mode === 'index' ? (
            <BranchChangesView t={t} call={call} refName={viewing.ref} reloadKey={String(rev)} openDiff={openDiff} onChanged={branchChanged} />
          ) : (
            <div className="dshws-side-note">{t(`git.readonly.${binfo?.reason ?? 'tag'}`)}</div>
          )
        ) : viewTab === 'history' ? (
          <HistoryView key={viewing.ref} t={t} call={call} openDiff={openDiff} refName={viewing.ref} />
        ) : (
          <CompareView t={t} call={call} refName={viewing.ref} openDiff={openDiff} />
        )
      ) : view === 'files' ? (
        // 远程目录当前分支的真实文件（与查看分支时的「文件」页同一套），点开即在右侧直接编辑。
        <TreeView
          key="current"
          t={t}
          reloadKey={`current:${rev}`}
          selected={source !== null && source.startsWith(`${rootDir}/`) ? source.slice(rootDir.length + 1) : undefined}
          load={worktreeLoader}
          onOpen={(p) => {
            setDiff(null)
            setViewFile(null)
            setSource(`${rootDir}/${p}`)
          }}
          menu={{
            api,
            hostId: workspace.hostId,
            root: rootDir,
            editable: true,
            onRenamed: (from, to) => {
              setSource((cur) => (cur === `${rootDir}/${from}` ? `${rootDir}/${to}` : cur))
              void refresh()
            }
          }}
        />
      ) : view === 'changes' ? (
        <ChangesView t={t} status={status} busy={busy} act={act} openDiff={openDiff} rootDir={workspace.remotePath} openFile={openAbs} />
      ) : (
        <HistoryView t={t} call={call} openDiff={openDiff} />
      )}
    </div>
  )

  return <Split list={list} detail={detail} storageKey="git" resizeLabel={t('side.resizeList')} placeholder={<EmptyState icon={<IconCommit size={30} />} text={t('git.pickItem')} />} />
}

// ------------------------------------------------------------------ 改动

interface ChangesProps {
  t: SidebarBodyProps['t']
  status: GitStatus
  busy: boolean
  act(op: GitOp): Promise<boolean>
  openDiff(target: DiffTarget, title: string): Promise<void>
  /** 该改动列表所在工作目录的远程绝对路径（复制绝对路径 / 打开文件用）。 */
  rootDir: string
  /** 在右侧打开工作目录里的真实文件（远程绝对路径）。 */
  openFile(abs: string): void
}

function ChangesView(props: ChangesProps) {
  const { t, status, busy, act } = props
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [menuNode, openMenu] = useContextMenu()
  // 浮动气泡提示，不插进列表（避免列表抖动）。
  const copyPath = (text: string): void => {
    void copyText(text).then(() => showFloat(t('ctx.copiedPath')))
  }

  /**
   * 右键菜单：按所在分区给出可用的 git 操作 ——
   * 已暂存 → 取消暂存；未暂存 → 暂存 / 放弃更改；未跟踪 → 暂存 / 删除文件（放弃）。
   * 同一文件可能同时出现在「已暂存」和「未暂存」，各自的菜单只作用于那一份改动。
   * 放弃仍走行内二次确认；工作目录里已删除的文件没有「打开文件」。
   */
  const rowMenu = (e: ReactMouseEvent, f: GitFileStatus, section: 'staged' | 'unstaged' | 'untracked', key: string): void => {
    const letter = section === 'staged' ? f.index : section === 'untracked' ? 'U' : f.worktree
    const abs = `${props.rootDir.replace(/\/+$/, '')}/${f.path}`
    const deletedOnDisk = f.worktree === 'D' || (section === 'staged' && letter === 'D' && f.worktree === '.')
    const items: MenuItem[] = [
      ...(section !== 'untracked' ? [{ id: 'diff', label: t('ctx.viewDiff') }] : []),
      ...(!deletedOnDisk ? [{ id: 'open', label: t('ctx.openFile') }] : []),
      { type: 'separator' },
      ...(section === 'staged'
        ? [{ id: 'unstage', label: t('git.unstage'), disabled: busy }]
        : [
            { id: 'stage', label: t('git.stage'), disabled: busy },
            { id: 'discard', label: section === 'untracked' ? t('ctx.deleteUntracked') : t('git.discard'), danger: true, disabled: busy }
          ]),
      { type: 'separator' },
      { id: 'rel', label: t('ctx.copyRel') },
      { id: 'abs', label: t('ctx.copyAbs') }
    ]
    openMenu(e, items, (id) => {
      if (id === 'diff') void props.openDiff(section === 'staged' ? { kind: 'staged', path: f.path } : { kind: 'worktree', path: f.path, untracked: false }, f.path)
      if (id === 'open') props.openFile(abs)
      if (id === 'stage') void act({ op: 'stage', paths: [f.path] })
      if (id === 'unstage') void act({ op: 'unstage', paths: [f.path] })
      if (id === 'discard') setConfirming(key)
      if (id === 'rel') copyPath(f.path)
      if (id === 'abs') copyPath(abs)
    })
  }
  const staged = status.files.filter((f) => f.kind !== 'untracked' && f.index !== '.' && f.index !== '?')
  const unstaged = status.files.filter((f) => f.kind !== 'untracked' && f.worktree !== '.')
  const untracked = status.files.filter((f) => f.kind === 'untracked')

  const discard = async (files: GitFileStatus[]): Promise<void> => {
    setConfirming(null)
    await act({
      op: 'discard',
      tracked: files.filter((f) => f.kind !== 'untracked').map((f) => f.path),
      untracked: files.filter((f) => f.kind === 'untracked').map((f) => f.path)
    })
  }

  const row = (f: GitFileStatus, section: 'staged' | 'unstaged' | 'untracked') => {
    const letter = section === 'staged' ? f.index : section === 'untracked' ? 'U' : f.worktree
    const key = `${section}:${f.path}`
    const name = f.path.slice(f.path.lastIndexOf('/') + 1)
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    return (
      <div key={key} className="dshws-git-row" onContextMenu={(e) => rowMenu(e, f, section, key)}>
        <button
          type="button"
          className="dshws-git-file"
          title={f.origPath !== undefined ? `${f.origPath} → ${f.path}` : f.path}
          onClick={() =>
            void props.openDiff(
              section === 'staged' ? { kind: 'staged', path: f.path } : { kind: 'worktree', path: f.path, untracked: section === 'untracked' },
              f.path
            )
          }
        >
          <StatusBadge s={letter} />
          <FileIcon name={name} />
          <span className="dshws-side-name" data-deleted={letter === 'D'}>{name}</span>
          {dir !== '' ? <span className="dshws-git-dir">{dir}</span> : null}
        </button>
        {confirming === key ? (
          <span className="dshws-git-confirm">
            {t('git.confirmDiscard')}
            <button type="button" className="dshws-link-btn" data-tone="danger" onClick={() => void discard([f])}>{t('common.confirm')}</button>
            <button type="button" className="dshws-link-btn" onClick={() => setConfirming(null)}>{t('form.cancel')}</button>
          </span>
        ) : (
          <span className="dshws-git-actions">
            {section !== 'staged' ? (
              <IconButton title={t('git.discard')} tone="danger" disabled={busy} onClick={() => setConfirming(key)}><IconUndo /></IconButton>
            ) : null}
            {section === 'staged' ? (
              <IconButton title={t('git.unstage')} disabled={busy} onClick={() => void act({ op: 'unstage', paths: [f.path] })}><IconMinus /></IconButton>
            ) : (
              <IconButton title={t('git.stage')} disabled={busy} onClick={() => void act({ op: 'stage', paths: [f.path] })}><IconPlus /></IconButton>
            )}
          </span>
        )}
      </div>
    )
  }

  type Kind = 'staged' | 'unstaged' | 'untracked'
  type Row = { kind: 'head'; section: Kind; title: string; files: GitFileStatus[] } | { kind: 'file'; section: Kind; file: GitFileStatus }
  // 拍平成「分区标题 + 文件行」后虚拟滚动；分区标题吸顶。
  const rows: Row[] = []
  const pushSection = (title: string, files: GitFileStatus[], kind: Kind): void => {
    if (files.length === 0) return
    rows.push({ kind: 'head', section: kind, title, files })
    for (const f of files) rows.push({ kind: 'file', section: kind, file: f })
  }
  pushSection(t('git.staged'), staged, 'staged')
  pushSection(t('git.unstaged'), unstaged, 'unstaged')
  pushSection(t('git.untracked'), untracked, 'untracked')

  const renderRow = (r: Row) =>
    r.kind === 'file' ? (
      row(r.file, r.section)
    ) : (
      <div className="dshws-git-section-head">
        <span>{r.title} ({r.files.length})</span>
        {r.section === 'staged' ? (
          <button type="button" className="dshws-link-btn" disabled={busy} onClick={() => void act({ op: 'unstage', paths: r.files.map((f) => f.path) })}>
            {t('git.unstageAll')}
          </button>
        ) : (
          <button type="button" className="dshws-link-btn" disabled={busy} onClick={() => void act({ op: 'stage', paths: r.files.map((f) => f.path) })}>
            {t('git.stageAll')}
          </button>
        )}
      </div>
    )

  return (
    <>
      <VirtualList
        items={rows}
        itemKey={(r) => (r.kind === 'head' ? `head:${r.section}` : `${r.section}:${r.file.path}`)}
        itemHeight={(r) => (r.kind === 'head' ? SECTION_HEIGHT : ROW_HEIGHT)}
        isSticky={(r) => r.kind === 'head'}
        renderItem={renderRow}
        header={
          <>
            <div className="dshws-git-commit">
              <textarea
                className="dshws-textarea"
                rows={3}
                value={message}
                placeholder={staged.length > 0 ? t('git.messagePlaceholder') : t('git.nothingStaged')}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                type="button"
                className="dshws-git-commit-btn"
                disabled={busy || staged.length === 0 || message.trim() === ''}
                onClick={() => void act({ op: 'commit', message }).then((ok) => ok && setMessage(''))}
              >
                {t('git.commit')} ({staged.length})
              </button>
            </div>
            {status.files.length === 0 ? <div className="dshws-side-note">{t('git.clean')}</div> : null}
          </>
        }
      />
      {menuNode}
    </>
  )
}
// ------------------------------------------------------------------ 分支选择器（顶部下拉：只切换要查看的分支，不检出）

interface BranchPickerProps {
  t: SidebarBodyProps['t']
  call<T>(op: GitOp): Promise<T>
  repo: GitStatus
  /** 正在查看的分支；null = 远程目录当前分支（未进入查看）。 */
  viewing: GitBranch | null
  binfo: BranchInfo | null
  /** 所查看分支检出在另一个 git 工作目录时的路径。 */
  otherWorktree: string | undefined
  /** 本会话默认查看的分支（完整引用名）。 */
  defaultRef: string | null
  onSetDefault(ref: string | null): void
  onView(branch: GitBranch): void
  onBackToCurrent(): void
}

/**
 * 顶部分支选择器：工具栏上显示「正在看哪个分支」，点开是分支列表。
 * 原来正文里的「正在查看 … / 检出在 … / 只读原因」提示都收进下拉顶部，各一行（悬停看全文），
 * 正文区因此只剩文件 / 改动 / 历史本身。
 */
function BranchPicker(props: BranchPickerProps) {
  const { t, call, repo, viewing } = props
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setBranches((await call<{ branches: GitBranch[] }>({ op: 'branches' })).branches)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [call])

  // 每次打开都重新取一次：分支可能在终端 / Agent 那边被新建、删除。
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 点外面 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (hostRef.current !== null && !hostRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const currentName = repo.branch ?? `(${repo.detached ?? 'detached'})`
  const shownName = viewing?.name ?? currentName
  const keyword = filter.trim().toLowerCase()
  const match = (b: GitBranch): boolean => keyword === '' || b.name.toLowerCase().includes(keyword)

  const list = (title: string, items: GitBranch[]) =>
    items.length === 0 ? null : (
      <div className="dshws-git-section">
        <div className="dshws-git-section-head"><span>{title} ({items.length})</span></div>
        {items.map((b) => {
          const isDefault = props.defaultRef === b.ref
          const isViewing = viewing?.ref === b.ref
          return (
            <div key={b.ref} className="dshws-git-branch-row" data-default={isDefault} data-viewing={isViewing}>
              <button
                type="button"
                className="dshws-git-branch"
                data-head={b.head}
                title={t('git.viewHint', { name: b.name })}
                onClick={() => {
                  setOpen(false)
                  props.onView(b)
                }}
              >
                <span className="dshws-git-branch-mark">{b.remote ? <IconCloud size={14} /> : <IconBranch size={14} />}</span>
                <span className="dshws-side-name">{b.name}</span>
                {b.head ? <span className="dshws-pill" data-tone="accent">{t('git.current')}</span> : null}
                {isDefault ? <span className="dshws-pill" data-tone="accent">{t('git.default')}</span> : null}
                <span className="dshws-git-dir dshws-mono">{b.commit}</span>
              </button>
              <span className="dshws-git-branch-pin">
                <IconButton
                  title={isDefault ? t('git.unsetDefault') : t('git.setDefault')}
                  active={isDefault}
                  onClick={() => props.onSetDefault(isDefault ? null : b.ref)}
                >
                  <IconPin filled={isDefault} />
                </IconButton>
              </span>
            </div>
          )
        })}
      </div>
    )

  const isDefaultViewing = viewing !== null && props.defaultRef === viewing.ref

  return (
    <div className="dshws-bp" ref={hostRef}>
      <button type="button" className="dshws-bp-trigger" data-viewing={viewing !== null} aria-expanded={open} title={t('git.branchesHint')} onClick={() => setOpen(!open)}>
        {viewing !== null ? <IconEye size={15} /> : <IconBranch size={15} />}
        <span className="dshws-bp-name">{shownName}</span>
        {viewing !== null ? <span className="dshws-pill" data-tone="accent">{t('git.viewingTag')}</span> : null}
        <IconChevron size={12} open={open} className="dshws-ico dshws-bp-caret" />
      </button>
      {open ? (
        <div className="dshws-bp-pop" role="dialog">
          <div className="dshws-bp-head">
            <input
              className="dshws-input"
              autoFocus
              value={filter}
              placeholder={t('git.filterBranches')}
              onChange={(e) => setFilter(e.target.value)}
            />
            <IconButton title={t('git.refreshBranches')} disabled={loading} onClick={() => void load()}>
              <IconRefresh />
            </IconButton>
          </div>
          {viewing !== null ? (
            <div className="dshws-bp-notes">
              <div className="dshws-bp-note" data-tone="info" title={t('git.viewing', { name: viewing.name })}>
                <IconEye size={13} />
                <span className="dshws-bp-note-text">{t('git.viewingLine', { name: viewing.name, current: currentName })}</span>
                <IconButton title={isDefaultViewing ? t('git.unsetDefault') : t('git.setDefault')} active={isDefaultViewing} onClick={() => props.onSetDefault(isDefaultViewing ? null : viewing.ref)}>
                  <IconPin size={14} filled={isDefaultViewing} />
                </IconButton>
                <button
                  type="button"
                  className="dshws-link-btn"
                  onClick={() => {
                    setOpen(false)
                    props.onBackToCurrent()
                  }}
                >
                  {t('git.backToCurrent')}
                </button>
              </div>
              {props.otherWorktree !== undefined ? (
                <div className="dshws-bp-note" data-tone="info" title={t('git.inWorktree', { path: displayPath(props.otherWorktree) })}>
                  <IconFolder size={13} />
                  <span className="dshws-bp-note-text dshws-mono">{t('git.inWorktreeLine', { path: displayPath(props.otherWorktree) })}</span>
                </div>
              ) : null}
              {props.binfo?.mode === 'readonly' ? (
                <div className="dshws-bp-note" data-tone="warn" title={t(`git.readonly.${props.binfo.reason ?? 'tag'}`)}>
                  <span className="dshws-bp-note-text">{t(`git.readonlyLine.${props.binfo.reason ?? 'tag'}`)}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="dshws-bp-list">
            {error !== null ? <div className="dshws-tree-note" data-tone="error">{error}</div> : null}
            {branches === null && error === null ? <div className="dshws-tree-note">{t('files.loading')}</div> : null}
            {branches !== null ? list(t('git.local'), branches.filter((b) => !b.remote && match(b))) : null}
            {branches !== null ? list(t('git.remoteBranches'), branches.filter((b) => b.remote && match(b))) : null}
            {branches !== null && !branches.some(match) ? <EmptyState text={t('list.noMatch')} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ 查看模式：分支的文件树

interface ViewProps {
  t: SidebarBodyProps['t']
  call<T>(op: GitOp): Promise<T>
  refName: string
}

/**
 * 分支文件树。数据来源由 loader 决定（对用户无感）：
 * 当前检出分支 → 远程目录里的真实文件（SFTP）；其他分支 → git 对象库（含未提交改动的临时索引）。
 * reloadKey 变化（切换分支 / 保存 / 撤销 / 提交后）时整棵树重新加载。
 */
/** 文件树右键菜单所需信息。editable=false：未检出的分支（文件不在磁盘上），只能复制相对路径。 */
interface TreeMenuProps {
  api: SidebarBodyProps['api']
  hostId: string
  /** 树根在远程的绝对路径（仓库内相对路径以它为基准）。 */
  root: string
  editable: boolean
  /** 条目改名（仓库内相对路径），打开着的文件据此换路径。 */
  onRenamed?(from: string, to: string): void
}

function TreeView(props: { t: SidebarBodyProps['t']; load(dir: string): Promise<GitTreeEntry[]>; reloadKey: string; selected?: string; onOpen(path: string): void; menu?: TreeMenuProps }) {
  const { t } = props
  const [dirs, setDirs] = useState<Record<string, { entries?: GitTreeEntry[]; error?: string }>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const loaderRef = useRef(props.load)
  loaderRef.current = props.load

  // 用最新的 loader（它每次渲染都是新函数），但只在 reloadKey 变化时整体重载。
  const load = useCallback(async (dir: string) => {
    try {
      const entries = await loaderRef.current(dir)
      setDirs((d) => ({ ...d, [dir]: { entries } }))
    } catch (err) {
      setDirs((d) => ({ ...d, [dir]: { error: messageOf(err) } }))
    }
  }, [])
  useEffect(() => {
    // 不先清空：旧内容保留到新结果回来再原地替换，避免整棵树闪成「加载中」。
    void load('')
    // 已展开的目录保持展开并重新加载（保存 / 提交后不必重新点开）。
    for (const d of expanded) void load(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, props.reloadKey])

  const m = props.menu
  const rootAbs = (m?.root ?? '').replace(/\/+$/, '')
  const toAbs = (rel: string): string => (rel === '' ? rootAbs || '/' : `${rootAbs}/${rel}`)
  const toRel = (abs: string): string => {
    const r = relativeTo(rootAbs || '/', abs)
    return r === '.' ? '' : r
  }
  const menu = useRemoteFileMenu({
    t,
    api: m?.api as SidebarBodyProps['api'],
    hostId: m?.hostId ?? '',
    root: rootAbs || '/',
    editable: m?.editable === true,
    reloadDir: (abs) => void load(toRel(abs)),
    onRenamed: (from, to) => {
      const [f, n] = [toRel(from), toRel(to)]
      setExpanded((cur) => new Set([...cur].map((p) => (p === f ? n : p.startsWith(`${f}/`) ? n + p.slice(f.length) : p))))
      m?.onRenamed?.(f, n)
    },
    onPasted: (abs) => {
      const rel = toRel(abs)
      if (rel !== '') setExpanded((cur) => new Set(cur).add(rel))
    }
  })

  // 拍平成行后虚拟滚动（见 VirtualList.tsx）。
  type Row = { kind: 'entry'; entry: GitTreeEntry; depth: number } | { kind: 'note'; key: string; text: string; depth: number; tone?: 'error' }
  const rows: Row[] = []
  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir]
    if (state === undefined) {
      rows.push({ kind: 'note', key: `${dir}#loading`, text: t('files.loading'), depth })
      return
    }
    if (state.error !== undefined) {
      rows.push({ kind: 'note', key: `${dir}#error`, text: state.error, depth, tone: 'error' })
      return
    }
    for (const e of state.entries ?? []) {
      rows.push({ kind: 'entry', entry: e, depth })
      if (e.type === 'tree' && expanded.has(e.path)) walk(e.path, depth + 1)
    }
  }
  walk('', 0)

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
    const isDir = e.type === 'tree'
    if (m !== undefined && menu.renaming === toAbs(e.path)) {
      return <RenameInput initial={e.name} paddingLeft={8 + depth * 14} onSubmit={(name) => void menu.submitRename(toAbs(e.path), name)} onCancel={menu.cancelRename} />
    }
    return (
      <button
        type="button"
        className="dshws-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={e.path}
        data-selected={props.selected === e.path}
        disabled={e.type === 'commit'}
        onContextMenu={m !== undefined ? (ev) => menu.openFor(ev, toAbs(e.path), isDir) : undefined}
        onClick={() => {
          if (!isDir) {
            props.onOpen(e.path)
            return
          }
          const next = new Set(expanded)
          if (next.has(e.path)) next.delete(e.path)
          else {
            next.add(e.path)
            if (dirs[e.path] === undefined) void load(e.path)
          }
          setExpanded(next)
        }}
      >
        <span className="dshws-row-caret">{isDir ? <IconChevron size={12} open={expanded.has(e.path)} /> : null}</span>
        {isDir ? <IconFolder open={expanded.has(e.path)} /> : e.type === 'commit' ? <IconSubmodule /> : <FileIcon name={e.name} />}
        <span className="dshws-row-name">{e.name}</span>
      </button>
    )
  }

  return (
    <>
      <VirtualList
        items={rows}
        itemKey={(r) => (r.kind === 'entry' ? r.entry.path : r.key)}
        itemHeight={(r) => (r.kind === 'entry' ? ROW_HEIGHT : NOTE_HEIGHT)}
        renderItem={renderRow}
        onContextMenu={m !== undefined ? menu.openForRoot : undefined}
      />
      {menu.node}
    </>
  )
}
// ------------------------------------------------------------------ 查看模式：非检出分支的改动（临时索引）

function BranchChangesView(props: {
  t: SidebarBodyProps['t']
  call<T>(op: GitOp): Promise<T>
  refName: string
  reloadKey: string
  openDiff(target: DiffTarget, title: string): Promise<void>
  /** 撤销 / 丢弃 / 提交之后通知上层刷新分支信息与文件树。 */
  onChanged(): void
}) {
  const { t, call, refName } = props
  const [files, setFiles] = useState<GitChangedFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    call<{ files: GitChangedFile[] }>({ op: 'branchChanges', ref: refName }).then(
      (r) => setFiles(r.files),
      (err: unknown) => setError(messageOf(err))
    )
  }, [call, refName, props.reloadKey])

  const run = async (op: GitOp): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setConfirming(null)
    try {
      await call(op)
      props.onChanged()
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  type Row = { kind: 'head' } | { kind: 'file'; file: GitChangedFile }
  const rows: Row[] = files !== null && files.length > 0 ? [{ kind: 'head' }, ...files.map((f): Row => ({ kind: 'file', file: f }))] : []

  const renderRow = (r: Row) => {
    if (r.kind === 'head') {
      return (
        <div className="dshws-git-section-head">
          <span>{t('git.unstaged')} ({files?.length ?? 0})</span>
          {confirming === '*' ? (
            <span className="dshws-git-confirm">
              {t('git.confirmDiscard')}
              <button type="button" className="dshws-link-btn" data-tone="danger" onClick={() => void run({ op: 'branchDiscard', ref: refName })}>{t('common.confirm')}</button>
              <button type="button" className="dshws-link-btn" onClick={() => setConfirming(null)}>{t('form.cancel')}</button>
            </span>
          ) : (
            <button type="button" className="dshws-link-btn" disabled={busy} onClick={() => setConfirming('*')}>
              {t('git.discardAll')}
            </button>
          )}
        </div>
      )
    }
    const f = r.file
    return (
      <div className="dshws-git-row">
        <button
          type="button"
          className="dshws-git-file"
          title={f.origPath !== undefined ? `${f.origPath} → ${f.path}` : f.path}
          onClick={() =>
            void props.openDiff(
              { kind: 'branch', ref: refName, path: f.path, ...(f.origPath !== undefined ? { origPath: f.origPath } : {}) },
              `${shortRef(refName)} · ${f.path}`
            )
          }
        >
          <StatusBadge s={f.status} />
          <FileIcon name={f.path.slice(f.path.lastIndexOf('/') + 1)} />
          <span className="dshws-side-name" data-deleted={f.status === 'D'}>{f.path}</span>
        </button>
        {confirming === f.path ? (
          <span className="dshws-git-confirm">
            {t('git.confirmDiscard')}
            <button type="button" className="dshws-link-btn" data-tone="danger" onClick={() => void run({ op: 'branchRevert', ref: refName, paths: f.origPath !== undefined ? [f.path, f.origPath] : [f.path] })}>
              {t('common.confirm')}
            </button>
            <button type="button" className="dshws-link-btn" onClick={() => setConfirming(null)}>{t('form.cancel')}</button>
          </span>
        ) : (
          <span className="dshws-git-actions">
            <IconButton title={t('git.discard')} tone="danger" disabled={busy} onClick={() => setConfirming(f.path)}><IconUndo /></IconButton>
          </span>
        )}
      </div>
    )
  }

  return (
    <VirtualList
      items={rows}
      itemKey={(r) => (r.kind === 'head' ? 'head' : r.file.path)}
      itemHeight={(r) => (r.kind === 'head' ? SECTION_HEIGHT : ROW_HEIGHT)}
      isSticky={(r) => r.kind === 'head'}
      renderItem={renderRow}
      header={
        <>
          <div className="dshws-tree-note">{t('git.branchChangesHint', { name: shortRef(refName) })}</div>
          <div className="dshws-git-commit">
            <textarea
              className="dshws-textarea"
              rows={3}
              value={message}
              placeholder={files !== null && files.length > 0 ? t('git.messagePlaceholder') : t('git.branchNothing')}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              type="button"
              className="dshws-git-commit-btn"
              disabled={busy || files === null || files.length === 0 || message.trim() === ''}
              onClick={() => void run({ op: 'branchCommit', ref: refName, message }).then((ok) => ok && setMessage(''))}
            >
              {t('git.commitTo', { name: shortRef(refName) })} ({files?.length ?? 0})
            </button>
          </div>
          {error !== null ? <div className="dshws-tree-note" data-tone="error">{error}</div> : null}
          {files === null && error === null ? <div className="dshws-tree-note">{t('files.loading')}</div> : null}
        </>
      }
    />
  )
}
// ------------------------------------------------------------------ 查看模式：远程分支 / 标签 → 新建本地分支后才能改

function CreateLocalBranch(props: { t: SidebarBodyProps['t']; call<T>(op: GitOp): Promise<T>; from: GitBranch; onCreated(ref: string, name: string): void }) {
  const { t } = props
  const suggested = props.from.remote ? props.from.name.slice(props.from.name.indexOf('/') + 1) : `${props.from.name}-edit`
  const [name, setName] = useState(suggested)
  const [error, setError] = useState<string | null>(null)
  const create = async (): Promise<void> => {
    setError(null)
    try {
      const r = await props.call<{ ref: string }>({ op: 'createBranch', name: name.trim(), from: props.from.ref })
      props.onCreated(r.ref, name.trim())
    } catch (err) {
      setError(messageOf(err))
    }
  }
  return (
    <div className="dshws-git-newbranch">
      <input className="dshws-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      <button type="button" className="dshws-link-btn" disabled={name.trim() === ''} onClick={() => void create()}>
        {t('git.createLocal')}
      </button>
      {error !== null ? <span className="dshws-tree-note" data-tone="error">{error}</span> : null}
    </div>
  )
}

// ------------------------------------------------------------------ 查看模式：与当前分支比较

function CompareView(props: ViewProps & { openDiff(target: DiffTarget, title: string): Promise<void> }) {
  const { t, call, refName } = props
  const [result, setResult] = useState<{ base: string; target: string; files: GitChangedFile[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setResult(null)
    call<{ base: string; target: string; files: GitChangedFile[] }>({ op: 'compare', base: 'HEAD', target: refName }).then(setResult, (err: unknown) =>
      setError(messageOf(err))
    )
  }, [call, refName])

  if (error !== null) return <div className="dshws-tree-note" data-tone="error">{error}</div>
  if (result === null) return <div className="dshws-tree-note">{t('files.loading')}</div>
  return (
    <VirtualList
      items={result.files}
      itemKey={(f) => f.path}
      itemHeight={() => ROW_HEIGHT}
      header={<div className="dshws-tree-note">{t('git.compareHint', { count: result.files.length })}</div>}
      renderItem={(f) => (
        <button
          type="button"
          className="dshws-git-file"
          title={f.origPath !== undefined ? `${f.origPath} → ${f.path}` : f.path}
          onClick={() =>
            void props.openDiff(
              // 复用提交对比：左 = 当前分支（HEAD）快照，右 = 查看的分支快照。
              { kind: 'commit', hash: result.target, parent: result.base, path: f.path, ...(f.origPath !== undefined ? { origPath: f.origPath } : {}) },
              `HEAD ↔ ${shortRef(refName)} · ${f.path}`
            )
          }
        >
          <StatusBadge s={f.status} />
          <FileIcon name={f.path.slice(f.path.lastIndexOf('/') + 1)} />
          <span className="dshws-side-name" data-deleted={f.status === 'D'}>{f.path}</span>
        </button>
      )}
    />
  )
}

/** 查看分支时的页签：当前检出分支与自己比较没有意义，不显示「比较」。 */
function viewTabs(info: BranchInfo | null): ViewTab[] {
  return info?.mode === 'worktree' ? ['files', 'changes', 'history'] : ['files', 'changes', 'history', 'compare']
}

/** 「改动」页签上的数字：当前分支 = git status 的文件数；其他分支 = 临时索引里的未提交改动数。 */
function pendingCount(info: BranchInfo | null, repo: GitStatus | null): number {
  if (info === null) return 0
  return info.mode === 'worktree' ? (repo?.files.length ?? 0) : info.pending
}

/**
 * 提交上的引用装饰属于哪类。宿主用 --decorate=full 取完整引用名，按前缀判断才准确
 * （短名 origin/x 与本地分支 feature/x 在形态上分不开）。
 */
function refKind(r: string): 'head' | 'tag' | 'remote' | 'local' {
  if (r.startsWith('HEAD')) return 'head'
  if (r.startsWith('tag: ')) return 'tag'
  if (r.startsWith('refs/remotes/')) return 'remote'
  return 'local'
}

/** 装饰的显示名：去掉 HEAD -> / tag: 与 refs/xxx/ 前缀。 */
function refLabel(r: string): string {
  return r.replace(/^HEAD -> /, '').replace(/^tag: /, '').replace(/^refs\/(heads|remotes|tags)\//, '')
}

/** refs/heads/main → main；refs/remotes/origin/x → origin/x。 */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '')
}

// ------------------------------------------------------------------ 历史

const ROW_H = 28
const LANE_W = 14

/**
 * 展开提交详情时，左侧继续画出「穿过这一段」的泳道竖线，分叉图不会在展开处断开。
 * 用本行结束时仍在等待的泳道（row.lanes）—— 正是下一行开头要接上的那些线。
 */
function GraphRail(props: { lanes: ReadonlyArray<string | null>; width: number }) {
  const x = (lane: number): number => lane * LANE_W + LANE_W / 2
  return (
    <svg className="dshws-git-rail" width={props.width * LANE_W} height="100%" preserveAspectRatio="none" aria-hidden="true">
      {props.lanes.map((l, i) =>
        l === null ? null : <line key={i} x1={x(i)} x2={x(i)} y1="0" y2="100%" stroke={LANE_COLORS[i % LANE_COLORS.length]} strokeWidth={2} />
      )}
    </svg>
  )
}

function GraphCell(props: { row: GraphRow; width: number; merge?: boolean }) {
  const { row, width } = props
  const x = (lane: number): number => lane * LANE_W + LANE_W / 2
  const mid = ROW_H / 2
  const color = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length] as string
  const paths: Array<{ d: string; c: string }> = []
  if (row.incoming) paths.push({ d: `M${x(row.col)} 0 L${x(row.col)} ${mid}`, c: color(row.col) })
  for (const e of row.edges) {
    if (e.kind === 'pass' && e.from !== row.col) paths.push({ d: `M${x(e.from)} 0 L${x(e.to)} ${ROW_H}`, c: color(e.from) })
    else if (e.kind === 'pass') paths.push({ d: `M${x(row.col)} ${mid} L${x(row.col)} ${ROW_H}`, c: color(row.col) })
    else if (e.kind === 'merge-in') paths.push({ d: `M${x(e.from)} 0 C${x(e.from)} ${mid} ${x(e.to)} 0 ${x(e.to)} ${mid}`, c: color(e.from) })
    else paths.push({ d: `M${x(e.from)} ${mid} C${x(e.to)} ${mid} ${x(e.to)} ${ROW_H} ${x(e.to)} ${ROW_H}`, c: color(e.to) })
  }
  return (
    <svg className="dshws-git-graph" width={width * LANE_W} height={ROW_H} aria-hidden="true">
      {paths.map((p, i) => (
        <path key={i} d={p.d} stroke={p.c} strokeWidth={2} fill="none" strokeLinecap="round" />
      ))}
      {props.merge ? (
        // 合并提交画成空心点，一眼区分「合并」与普通提交。
        <circle cx={x(row.col)} cy={mid} r={4} fill="var(--dsw-alias-bg-layer-1)" stroke={color(row.col)} strokeWidth={2} />
      ) : (
        <circle cx={x(row.col)} cy={mid} r={4.2} fill={color(row.col)} stroke="var(--dsw-alias-bg-layer-1)" strokeWidth={1.5} />
      )}
    </svg>
  )
}

interface HistoryProps {
  t: SidebarBodyProps['t']
  call<T>(op: GitOp): Promise<T>
  openDiff(target: DiffTarget, title: string): Promise<void>
  /** 只看某个分支的历史；不传为全部分支。 */
  refName?: string
}

function HistoryView(props: HistoryProps) {
  const { t, call } = props
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<{ hash: string; files?: GitChangedFile[]; error?: string } | null>(null)

  const loadMore = useCallback(
    async (reset: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const skip = reset ? 0 : commits.length
        const page = (await call<{ commits: GitCommit[] }>({ op: 'log', skip, limit: PAGE, ...(props.refName !== undefined ? { ref: props.refName } : {}) })).commits
        setCommits((cur) => (reset ? page : [...cur, ...page]))
        setDone(page.length < PAGE)
      } catch (err) {
        setError(messageOf(err))
      } finally {
        setLoading(false)
      }
    },
    [call, commits.length]
  )
  useEffect(() => {
    void loadMore(true)
    // 只在进入历史页时加载一次；之后由「加载更多」追加。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = useMemo(() => layoutGraph(commits), [commits])
  const width = useMemo(() => graphWidth(rows), [rows])

  const toggle = async (c: GitCommit): Promise<void> => {
    if (open?.hash === c.hash) {
      setOpen(null)
      return
    }
    setOpen({ hash: c.hash })
    try {
      const files = (await call<{ files: GitChangedFile[] }>({ op: 'show', hash: c.hash, parent: c.parents[0] ?? null })).files
      setOpen({ hash: c.hash, files })
    } catch (err) {
      setOpen({ hash: c.hash, error: messageOf(err) })
    }
  }

  return (
    <div className="dshws-side-tree">
      {error !== null ? <div className="dshws-tree-note" data-tone="error">{error}</div> : null}
      {commits.length === 0 && !loading && error === null ? <div className="dshws-side-note">{t('git.noCommits')}</div> : null}
      {commits.map((c, i) => (
        <div key={c.hash}>
          <button type="button" className="dshws-git-commit-row" data-open={open?.hash === c.hash} onClick={() => void toggle(c)} title={`${c.hash}\n${c.author} · ${new Date(c.date).toLocaleString()}`}>
            <GraphCell row={rows[i] as GraphRow} width={width} merge={c.parents.length > 1} />
            <span className="dshws-git-subject">
              {c.refs.map((r) => {
                const kind = refKind(r)
                return (
                  <span key={r} className="dshws-git-ref" data-kind={kind}>
                    {kind === 'tag' ? <IconTag size={11} /> : kind === 'remote' ? <IconCloud size={11} /> : <IconBranch size={11} />}
                    {refLabel(r)}
                  </span>
                )
              })}
              <span className="dshws-git-subject-text">{c.subject}</span>
            </span>
            <span className="dshws-git-meta">
              <span className="dshws-git-author">{c.author}</span>
              <span>{relTime(c.date)}</span>
            </span>
          </button>
          {open?.hash === c.hash ? (
            <div className="dshws-git-commit-files" style={{ ['--rail' as string]: `${width * LANE_W}px` }}>
              <GraphRail lanes={(rows[i] as GraphRow).lanes} width={width} />
              <div className="dshws-git-commit-info">
                <IconCommit size={14} />
                <span className="dshws-mono">{c.hash.slice(0, 12)}</span>
                <span>{c.author}</span>
                <span>{new Date(c.date).toLocaleString()}</span>
                {c.parents.length > 1 ? <span className="dshws-pill">{t('git.mergeVsFirst')}</span> : null}
              </div>
              {open.error !== undefined ? <div className="dshws-tree-note" data-tone="error">{open.error}</div> : null}
              {open.files === undefined && open.error === undefined ? <div className="dshws-tree-note">{t('files.loading')}</div> : null}
              {open.files?.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className="dshws-git-file"
                  onClick={() =>
                    void props.openDiff(
                      { kind: 'commit', hash: c.hash, parent: c.parents[0] ?? null, path: f.path, ...(f.origPath !== undefined ? { origPath: f.origPath } : {}) },
                      `${c.hash.slice(0, 7)} · ${f.path}`
                    )
                  }
                >
                  <StatusBadge s={f.status} />
                  <FileIcon name={f.path.slice(f.path.lastIndexOf('/') + 1)} />
                  <span className="dshws-side-name" data-deleted={f.status === 'D'}>{f.path}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      {!done && commits.length > 0 ? (
        <button type="button" className="dshws-link-btn dshws-git-more" disabled={loading} onClick={() => void loadMore(false)}>
          {loading ? t('files.loading') : t('git.loadMore')}
        </button>
      ) : null}
    </div>
  )
}
