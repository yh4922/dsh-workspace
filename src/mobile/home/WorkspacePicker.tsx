/*
 * @Description: H5 首页 —— 新建会话：选择工作区（底部弹层）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:40:00
 * @FilePath: /dsh-workspace/src/mobile/home/WorkspacePicker.tsx
 */
import { useState } from 'react'
import { workspaceLabel, type WorkspaceItem } from '../data/workspaces.js'
import { Icon } from '../icons.js'

export interface WorkspacePickerProps {
  items: WorkspaceItem[] | undefined
  onPick(workspaceId: string): Promise<void>
  onClose(): void
}

export function WorkspacePicker({ items, onPick, onClose }: WorkspacePickerProps) {
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [err, setErr] = useState<string | undefined>(undefined)
  const pick = (id: string): void => {
    if (busy !== undefined) return
    setBusy(id)
    setErr(undefined)
    onPick(id).catch((e: unknown) => {
      setBusy(undefined)
      setErr(e instanceof Error ? e.message : '新建失败')
    })
  }
  return (
    <div className="h-mask" onClick={onClose}>
      <div className="h-pop" role="dialog" aria-label="选择工作区" onClick={(e) => e.stopPropagation()}>
        <div className="h-pop-hd">
          <div className="h-pop-title">
            <b>新建会话</b>
            <small>选择工作区{items !== undefined ? ` · ${items.length}` : ''}</small>
          </div>
          <button type="button" className="m-icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="h-pop-body">
          {items === undefined ? <p className="m-placeholder">正在加载工作区…</p> : null}
          {items !== undefined && items.length === 0 ? <p className="m-placeholder">还没有工作区，请先在桌面版创建。</p> : null}
          {items?.map((w) => (
            <button key={w.workspaceId} type="button" className="h-ws-item" data-busy={busy === w.workspaceId} disabled={busy !== undefined} onClick={() => pick(w.workspaceId)}>
              <Icon name="folder" size={18} />
              <span>
                <b>{workspaceLabel(w)}</b>
                <small>{busy === w.workspaceId ? '正在创建…' : w.path}</small>
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
          {err !== undefined ? <p className="h-err">{err}</p> : null}
        </div>
      </div>
    </div>
  )
}
