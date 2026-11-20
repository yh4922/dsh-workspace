/*
 * @Description: H5 首页 —— 会话卡片（左滑露出「置顶 / 归档」）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:35:00
 * @FilePath: /dsh-workspace/src/mobile/home/SessionCard.tsx
 *
 * 手势只认水平滑动：首次移动超过阈值时判定方向，竖直则放弃（交给列表滚动）。
 * 同一时间只展开一张卡片（openId 由首页持有）。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useQuestions } from '../data/approvals.js'
import type { SessionMeta } from '../data/sessions.js'
import { Icon } from '../icons.js'
import { relativeTime } from './time.js'

/** 两个操作按钮的总宽度（与 home.css .h-actions 一致）。 */
const ACTIONS_W = 144
const SLOP = 8

export interface SessionCardProps {
  meta: SessionMeta
  approvals: number
  approvalHint?: string
  open: boolean
  now: number
  onOpenChange(open: boolean): void
  onClick(): void
  onTogglePin(): void
  onArchive(): void
}

export function SessionCard({ meta, approvals, approvalHint, open, now, onOpenChange, onClick, onTogglePin, onArchive }: SessionCardProps) {
  const [drag, setDrag] = useState<number | undefined>(undefined)
  const g = useRef<{ x: number; y: number; id: number; axis: 'x' | 'y' | undefined; base: number; moved: boolean } | undefined>(undefined)

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    g.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: undefined, base: open ? -ACTIONS_W : 0, moved: false }
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = g.current
    if (s === undefined || s.id !== e.pointerId) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (s.axis === undefined) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (s.axis === 'x') e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (s.axis !== 'x') return
    s.moved = true
    setDrag(Math.max(-ACTIONS_W - 24, Math.min(0, s.base + dx)))
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = g.current
    if (s === undefined || s.id !== e.pointerId) return
    g.current = undefined
    if (s.axis === 'x' && drag !== undefined) {
      onOpenChange(drag < -ACTIONS_W / 2)
      setDrag(undefined)
      return
    }
    setDrag(undefined)
    if (s.axis === undefined && !s.moved) {
      if (open) onOpenChange(false)
      else onClick()
    }
  }
  const onCancel = (): void => {
    g.current = undefined
    setDrag(undefined)
  }

  // 提问直接读全局 $events 单例（与审批同一条流），不经首页透传：首页只需要知道「有没有待处理」。
  const questions = useQuestions()[meta.sessionId]?.length ?? 0
  const x = drag ?? (open ? -ACTIONS_W : 0)
  const state = approvals > 0 || questions > 0 ? 'wait' : meta.running ? 'run' : undefined

  return (
    <div className="h-swipe">
      {/* 收起时隐藏：卡片高度有小数像素时，底下的操作按钮会在行边缘漏出一条色线。 */}
      <div className="h-actions" aria-hidden={!open} data-show={open || drag !== undefined ? 'true' : 'false'}>
        <button type="button" className="h-act h-act-pin" tabIndex={open ? 0 : -1} onClick={onTogglePin}>
          <Icon name="pin" size={16} />
          {meta.pinned ? '取消置顶' : '置顶'}
        </button>
        <button type="button" className="h-act h-act-archive" tabIndex={open ? 0 : -1} onClick={onArchive}>
          <Icon name="archive" size={16} />
          归档
        </button>
      </div>
      <div
        className="h-card"
        data-state={state}
        data-dragging={drag !== undefined ? 'true' : undefined}
        style={{ transform: x === 0 ? undefined : `translateX(${x}px)` }}
        role="button"
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onClick()
        }}
      >
        <div className="h-row">
          {meta.pinned ? (
            <span className="h-pin" aria-label="已置顶">
              <Icon name="pin" size={13} />
            </span>
          ) : null}
          <b className="h-title">{meta.title}</b>
          <time className="h-time">{relativeTime(meta.updatedAt, now)}</time>
        </div>
        {approvalHint === undefined && questions > 0 ? (
          <p className="h-sub">
            <Icon name="triangleAlert" size={13} />
            <span>agent 正在等你回答问题</span>
          </p>
        ) : null}
        {approvalHint !== undefined ? (
          <p className="h-sub">
            <Icon name="triangleAlert" size={13} />
            <span>{approvalHint}</span>
          </p>
        ) : null}
        <div className="h-row">
          {meta.workspaceTitle !== undefined ? <span className="h-ws">{meta.workspaceTitle}</span> : null}
          <span className="h-row-sp" />
          {meta.running ? (
            <span className="m-tag" data-tone="ok">
              <i className="m-dot" data-pulse="true" />
              运行中
            </span>
          ) : null}
          {approvals > 0 ? (
            <span className="m-tag" data-tone="warn">
              待审批{approvals > 1 ? <b className="h-num">{approvals}</b> : null}
            </span>
          ) : null}
          {questions > 0 ? (
            <span className="m-tag" data-tone="warn">
              待回答{questions > 1 ? <b className="h-num">{questions}</b> : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function SessionSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="h-skel-list" aria-busy="true" aria-label="加载中">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-skel">
          <i style={{ width: '60%' }} />
          <i style={{ width: '90%' }} />
          <i style={{ width: '30%' }} />
        </div>
      ))}
    </div>
  )
}
