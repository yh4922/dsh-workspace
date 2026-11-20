/*
 * @Description: H5 底部抽屉宿主 —— 遮罩 + 拖拽手柄（半屏 / 全屏两档，下拉关闭）+ 顶部 tab + 懒加载面板
 * @Author: YangHeng
 * @Date: 2026-11-19 15:30:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/SheetHost.tsx
 *
 * 本文件随会话页静态打包，必须保持轻量：面板（复用 sidebar / terminal，体积大）一律 React.lazy + import()，
 * 打开对应 tab 时才下载分片；复用组件的样式也在面板分片里注入（env.ts），不进首屏。
 * 抽屉打开期间访问过的面板保持挂载（隐藏），切 tab 不重连终端、不丢文件树展开状态；关闭抽屉时全部卸载。
 */
import { Suspense, lazy, useEffect, useRef, useState, type FC, type LazyExoticComponent, type PointerEvent as ReactPointerEvent } from 'react'
import { closeSheet, switchTab, useSheetState, type SheetTab } from './store.js'
import type { PanelProps } from './panel.js'
import { Icon } from '../icons.js'

const PANELS: Record<SheetTab, LazyExoticComponent<FC<PanelProps>>> = {
  files: lazy(() => import('./FilesPanel.js')),
  git: lazy(() => import('./GitPanel.js')),
  ssh: lazy(() => import('./SshPanel.js')),
  context: lazy(() => import('./ContextPanel.js')),
  browser: lazy(() => import('./BrowserPanel.js'))
}

const TABS: ReadonlyArray<{ tab: SheetTab; label: string }> = [
  { tab: 'files', label: '文件' },
  { tab: 'git', label: 'Git' },
  { tab: 'ssh', label: 'SSH' },
  { tab: 'context', label: '上下文' },
  { tab: 'browser', label: '浏览器' }
]

type Snap = 'half' | 'full'

/** 半屏档占视口高度的比例（效果图 58%）。 */
const HALF_RATIO = 0.58
/** 从半屏再往下拖超过这么多像素（或快速下滑）即关闭。 */
const CLOSE_DRAG_PX = 90
/** 快速滑动判定（px/ms）。 */
const FLING = 0.6

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

function snapHeight(snap: Snap, vh: number): number {
  // 全屏档在顶部留出安全区 + 一点缝隙，看得出是抽屉。
  return snap === 'full' ? vh - 8 : Math.round(vh * HALF_RATIO)
}

/** 每个 tab 默认档位：终端需要空间，默认全屏。 */
function defaultSnap(tab: SheetTab): Snap {
  return tab === 'ssh' ? 'full' : 'half'
}

export const SheetHost: FC<{ sessionId: string }> = ({ sessionId }) => {
  const state = useSheetState()
  const [snap, setSnap] = useState<Snap>('half')
  const [drag, setDrag] = useState<number | null>(null)
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : viewportHeight()))
  const [visited, setVisited] = useState<ReadonlySet<SheetTab>>(new Set())
  const start = useRef<{ y: number; h: number; t: number; lastY: number; lastT: number } | null>(null)

  // 打开 / 切换 tab：记下访问过的面板，并按 tab 选择默认档位（SSH 全屏；其余保持当前档位）。
  useEffect(() => {
    if (!state.open) {
      setVisited(new Set())
      return
    }
    setVisited((v) => (v.has(state.tab) ? v : new Set([...v, state.tab])))
    if (defaultSnap(state.tab) === 'full') setSnap('full')
  }, [state.open, state.tab, state.seq])

  // 首次打开时重置为半屏（SSH 除外）。
  const wasOpen = useRef(false)
  useEffect(() => {
    if (state.open && !wasOpen.current) setSnap(defaultSnap(state.tab))
    wasOpen.current = state.open
  }, [state.open, state.tab])

  useEffect(() => {
    const onResize = (): void => setVh(viewportHeight())
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [])

  // 切换会话：抽屉属于会话页，换会话时关掉。
  useEffect(() => () => closeSheet(), [sessionId])

  // Esc 关闭（外接键盘 / 桌面调试）。
  useEffect(() => {
    if (!state.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.closest('.dshws-term') !== null)) closeSheet()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.open])

  if (!state.open) return null

  const base = snapHeight(snap, vh)
  const height = drag ?? base

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // 此时不 setPointerCapture：捕获后 click 落在容器上，tab 按钮就点不动了；确认是拖拽（移动超过阈值）再捕获。
    const now = performance.now()
    start.current = { y: e.clientY, h: base, t: now, lastY: e.clientY, lastT: now }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = start.current
    if (s === null) return
    const dy = e.clientY - s.y
    if (drag === null) {
      if (Math.abs(dy) < 6) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 指针已释放 */
      }
    }
    s.lastY = e.clientY
    s.lastT = performance.now()
    setDrag(Math.max(80, Math.min(snapHeight('full', vh), s.h - dy)))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = start.current
    start.current = null
    if (s === null) return
    if (drag === null) {
      // 轻点手柄：在两档间切换。
      if (e.target instanceof HTMLElement && e.target.closest('.m-sheet-grip') !== null) setSnap(snap === 'half' ? 'full' : 'half')
      return
    }
    const dt = Math.max(1, performance.now() - s.t)
    const velocity = (e.clientY - s.y) / dt // >0 向下
    const current = drag
    setDrag(null)
    const half = snapHeight('half', vh)
    const full = snapHeight('full', vh)
    if (current < half - CLOSE_DRAG_PX || (velocity > FLING && current < half)) {
      closeSheet()
      return
    }
    if (velocity > FLING) setSnap('half')
    else if (velocity < -FLING) setSnap('full')
    else setSnap(Math.abs(current - full) < Math.abs(current - half) ? 'full' : 'half')
  }

  return (
    <div className="m-sheet-root">
      <div className="m-sheet-mask" onClick={() => closeSheet()} />
      <div className="m-sheet" data-dragging={drag !== null} data-snap={snap} style={{ height }} role="dialog" aria-modal="true">
        <div
          className="m-sheet-drag"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            start.current = null
            setDrag(null)
          }}
        >
          <div className="m-sheet-grip" aria-label={snap === 'half' ? '展开为全屏' : '收起为半屏'} />
          <div className="m-sheet-tabs">
            <div className="m-sheet-tablist" role="tablist">
              {TABS.map((x) => (
                <button
                  key={x.tab}
                  type="button"
                  role="tab"
                  aria-selected={state.tab === x.tab}
                  className="m-sheet-tab"
                  data-on={state.tab === x.tab}
                  onClick={() => switchTab(x.tab)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <button type="button" className="m-sheet-close" aria-label="关闭" onClick={() => closeSheet()}>
              <Icon name="x" size={18} />
            </button>
          </div>
        </div>
        <div className="m-sheet-body">
          {TABS.filter((x) => visited.has(x.tab) || x.tab === state.tab).map((x) => {
            const Panel = PANELS[x.tab]
            const on = x.tab === state.tab
            return (
              <div key={x.tab} className="m-sheet-pane" hidden={!on}>
                <Suspense fallback={<div className="m-sheet-note">加载中…</div>}>
                  <Panel sessionId={sessionId} state={state} active={on} />
                </Suspense>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
