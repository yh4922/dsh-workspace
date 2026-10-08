/*
 * @Description: 虚拟滚动列表 —— 只渲染可见区域的行（文件树、Git 改动列表共用）
 * @Author: YangHeng
 * @Date: 2026-09-30 14:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/VirtualList.tsx
 *
 * 为什么自己写：浏览器端只能用宿主提供的几个种子模块，不宜为此打包一个第三方虚拟列表库；
 * 这里的行高都是已知的固定值（行 26px、分区标题 28px、提示行 32px），按前缀和定位即可。
 *
 * 结构：滚动容器 = [header（不虚拟，如提交框）] + [上占位] + [可见行] + [下占位]。
 * 分区标题可声明为 sticky：它滚出渲染范围后仍单独渲染在可见行之前，并从上占位里扣掉自身高度，位置不变。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'

export interface VirtualListProps<T> {
  items: readonly T[]
  itemKey(item: T, index: number): string
  itemHeight(item: T): number
  renderItem(item: T, index: number): ReactNode
  /** 分区标题：滚过之后仍吸附在顶部。 */
  isSticky?(item: T): boolean
  /** 列表之前的固定内容（在同一个滚动容器里，随列表一起滚动）。 */
  header?: ReactNode
  /** 列表之后的固定内容（如空状态提示）。 */
  footer?: ReactNode
  className?: string
  onContextMenu?(e: ReactMouseEvent<HTMLDivElement>): void
  /** 可见区上下额外渲染的像素。 */
  overscanPx?: number
  /**
   * 滚动到某一行（按 itemKey）并居中。每个 nonce 只滚一次；目标行还没出现（目录尚在加载）时，
   * 等它出现后再滚。
   */
  scrollTo?: { key: string; nonce: number }
}

/** 纯函数：让第 index 行居中的 scrollTop（不小于 0）。 */
export function centeredScrollTop(offsets: readonly number[], index: number, viewport: number, headerHeight: number): number {
  const top = headerHeight + (offsets[index] as number)
  const height = (offsets[index + 1] as number) - (offsets[index] as number)
  return Math.max(0, Math.round(top - (viewport - height) / 2))
}

/** 纯函数：前缀和里第一个「结束位置 > y」的下标（二分）。 */
export function indexAt(offsets: readonly number[], y: number): number {
  // offsets[i] = 第 i 行的顶部；offsets[n] = 总高
  let lo = 0
  let hi = offsets.length - 2
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((offsets[mid] as number) <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 纯函数：给定滚动位置与视口高度，算出要渲染的行区间 [start, end)。 */
export function visibleRange(offsets: readonly number[], scrollTop: number, viewport: number, overscan: number): [number, number] {
  const n = offsets.length - 1
  if (n <= 0) return [0, 0]
  const start = indexAt(offsets, Math.max(0, scrollTop - overscan))
  const end = Math.min(n, indexAt(offsets, scrollTop + viewport + overscan) + 1)
  return [start, end]
}

export function VirtualList<T>(props: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [headerHeight, setHeaderHeight] = useState(0)
  const overscan = props.overscanPx ?? 300

  const offsets = useMemo(() => {
    const out = new Array<number>(props.items.length + 1)
    out[0] = 0
    for (let i = 0; i < props.items.length; i += 1) out[i + 1] = (out[i] as number) + props.itemHeight(props.items[i] as T)
    return out
    // itemHeight 通常是内联函数；只随数据变化重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.items])

  // 视口高度与 header 高度随容器 / 内容变化（拖动分栏、提交框换行）。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    setViewport(el.clientHeight || 600)
    setHeaderHeight(headerRef.current?.offsetHeight ?? 0)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setViewport(el.clientHeight || 600)
      setHeaderHeight(headerRef.current?.offsetHeight ?? 0)
    })
    ro.observe(el)
    if (headerRef.current !== null) ro.observe(headerRef.current)
    return () => ro.disconnect()
  }, [])

  // header 内容可能在挂载后才出现或改变高度（错误提示、提交框）：每次渲染后核对一次。
  useLayoutEffect(() => {
    const h = headerRef.current?.offsetHeight ?? 0
    if (h !== headerHeight) setHeaderHeight(h)
  })

  // 数据变短（折叠目录、刷新）后滚动位置可能越界：以浏览器实际值为准。
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && el.scrollTop !== scrollTop) setScrollTop(el.scrollTop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.items])

  const scrolledNonce = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    const target = props.scrollTo
    const el = scrollRef.current
    if (target === undefined || el === null || scrolledNonce.current === target.nonce) return
    const index = props.items.findIndex((item, i) => props.itemKey(item, i) === target.key)
    if (index < 0) return
    scrolledNonce.current = target.nonce
    // 直接读实际高度：viewport 状态在首次提交前还是默认值 600，矮面板会居中偏移。
    const next = centeredScrollTop(offsets, index, el.clientHeight || viewport, headerRef.current?.offsetHeight ?? headerHeight)
    el.scrollTop = next
    setScrollTop(el.scrollTop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollTo?.key, props.scrollTo?.nonce, offsets, viewport, headerHeight])

  const total = offsets[offsets.length - 1] as number
  const listTop = scrollTop - headerHeight
  const [start, end] = visibleRange(offsets, Math.max(0, listTop), viewport + Math.min(0, listTop), overscan)

  // 最近一个在可见区之上的 sticky 行：单独渲染在前面，保持吸顶。
  let stuck = -1
  if (props.isSticky !== undefined && start > 0 && !props.isSticky(props.items[start] as T)) {
    for (let i = start - 1; i >= 0; i -= 1) {
      if (props.isSticky(props.items[i] as T)) {
        stuck = i
        break
      }
    }
  }
  const stuckHeight = stuck >= 0 ? (offsets[stuck + 1] as number) - (offsets[stuck] as number) : 0

  const rows: ReactNode[] = []
  const row = (i: number): ReactNode => {
    const item = props.items[i] as T
    const h = (offsets[i + 1] as number) - (offsets[i] as number)
    const sticky = props.isSticky?.(item) === true
    return (
      <div key={props.itemKey(item, i)} className="dshws-vrow" data-sticky={sticky} style={{ height: h }}>
        {props.renderItem(item, i)}
      </div>
    )
  }
  if (stuck >= 0) rows.push(row(stuck))
  for (let i = start; i < end; i += 1) rows.push(row(i))

  return (
    <div
      ref={scrollRef}
      className={props.className ?? 'dshws-side-tree'}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onContextMenu={props.onContextMenu}
    >
      {props.header !== undefined ? <div ref={headerRef}>{props.header}</div> : null}
      <div style={{ height: Math.max(0, (offsets[start] as number) - stuckHeight) }} aria-hidden="true" />
      {rows}
      <div style={{ height: Math.max(0, total - (offsets[end] as number)) }} aria-hidden="true" />
      {props.footer}
    </div>
  )
}

/** 行高（与 styles.ts 保持一致）。 */
export const ROW_HEIGHT = 26
export const SECTION_HEIGHT = 28
export const NOTE_HEIGHT = 32
