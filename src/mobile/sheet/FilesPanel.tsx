/*
 * @Description: H5 抽屉 · 文件面板 —— 复用 RemoteFilesTab（目录树）与 RemoteFileViewer（查看器，含行定位）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:50:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/FilesPanel.tsx
 *
 * openSheet({tab:'files', path, line})：path 可为相对路径（相对会话 cwd）或绝对路径，
 * 解析规则与桌面查看器一致（RemoteFileTab 的 viewerTargetOf）：远程工作区 → SFTP；本机 → 工作区内可写、工作区外只读。
 * 目录树在窄屏下点文件会在树内整页打开查看器（✕ 返回），不需要这里接管。
 */
import { useEffect, useState } from 'react'
import { LOCAL_ANY_HOST } from '../../wire/contract.js'
import { RemoteFilesTab } from '../../client/sidebar/RemoteFilesTab.js'
import { RemoteFileViewer, type FileNav } from '../../client/sidebar/RemoteFileTab.js'
import { LOCAL_HOST_PREFIX, isInsideLocal, sessionFileAddress, toLocalPosix, type RemoteIndex } from '../../client/sidebar/remote-index.js'
import { api, index, t, useWorkspaceReady } from './env.js'
import type { PanelProps } from './panel.js'
import { Icon } from '../icons.js'

export interface FileTarget {
  hostId: string
  path: string
  title: string
  root: string
}

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s
}

/** 会话里的路径（相对 cwd 或绝对）→ 查看器目标；解析不了返回 undefined。 */
export function fileTargetOf(idx: RemoteIndex, sessionId: string, input: string): FileTarget | undefined {
  const address = sessionFileAddress(sessionId, input.replace(/\\/g, '/'))
  const remote = idx.resolveAddress(address)
  if (remote !== undefined) {
    return { hostId: remote.workspace.hostId, path: remote.remotePath, title: remote.workspace.title, root: remote.workspace.remotePath }
  }
  const local = idx.resolveLocalAddress(address)
  if (local === undefined) return undefined
  const cwd = local.cwd
  const inside = cwd !== undefined && idx.bySession(sessionId) === undefined && isInsideLocal(cwd, local.path)
  return {
    hostId: inside ? `${LOCAL_HOST_PREFIX}${sessionId}` : LOCAL_ANY_HOST,
    path: local.path,
    title: inside ? baseName(cwd as string) : t('viewer.localFile'),
    root: inside ? toLocalPosix(cwd as string) : local.path.slice(0, Math.max(local.path.lastIndexOf('/'), 1))
  }
}

interface Opened {
  input: string
  nav?: FileNav
}

export default function FilesPanel(props: PanelProps) {
  const { sessionId, state } = props
  const ready = useWorkspaceReady(sessionId)
  const [opened, setOpened] = useState<Opened | null>(null)

  // 每次 openSheet({tab:'files', path}) 打开一次（seq 区分重复跳转到同一文件同一行）。
  useEffect(() => {
    if (state.tab !== 'files' || state.path === undefined || state.path === '') return
    const line = state.line !== undefined && Number.isInteger(state.line) && state.line > 0 ? state.line : undefined
    setOpened({ input: state.path, ...(line !== undefined ? { nav: { line, key: `h5-${state.seq}` } } : {}) })
  }, [state.seq, state.tab, state.path, state.line])

  if (ready !== 'ready') return <div className="m-sheet-note">{t('files.loading')}</div>

  if (opened !== null) {
    const target = fileTargetOf(index, sessionId, opened.input)
    return (
      <div className="m-sheet-files">
        <div className="m-sheet-crumb">
          <button type="button" className="m-sheet-link" onClick={() => setOpened(null)}>
            <Icon name="chevronLeft" size={16} />
            文件树
          </button>
          <span className="m-sheet-crumb-path">{opened.input}</span>
        </div>
        {target === undefined ? (
          <div className="m-sheet-note">无法解析路径：{opened.input}</div>
        ) : (
          <div className="m-sheet-fill">
            <RemoteFileViewer
              key={`${target.hostId}:${target.path}`}
              t={t}
              api={api}
              hostId={target.hostId}
              remotePath={target.path}
              workspaceTitle={target.title}
              workspaceRoot={target.root}
              {...(opened.nav !== undefined ? { nav: opened.nav } : {})}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="m-sheet-fill">
      <RemoteFilesTab
        t={t}
        api={api}
        index={index}
        sessionId={sessionId}
        openResource={(address) => {
          // 只在带 useTabInfo 的右侧栏窄面板里调用；H5 不传 useTabInfo，这里仅作兜底：按地址直接打开查看器。
          const r = index.resolveAddress(address)?.remotePath ?? index.resolveLocalAddress(address)?.path
          if (r !== undefined) setOpened({ input: r })
        }}
      />
    </div>
  )
}
