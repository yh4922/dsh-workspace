/*
 * @Description: H5 —— 顶部「重连中」细条
 * @Author: YangHeng
 * @Date: 2026-11-19 15:15:00
 * @FilePath: /dsh-workspace/src/mobile/components/ReconnectBar.tsx
 */
import { useEffect, useState } from 'react'
import { subscribeStatus, type MuxStatus } from '../net/mux.js'

/**
 * 只在「连上过之后又断开」时出现：首次连接属于正常加载（页面有骨架屏），不该闪一条警告；
 * 没有存活流时通道会主动保持 closed，那也不是故障。
 */
export function ReconnectBar() {
  const [status, setStatus] = useState<MuxStatus>('closed')
  const [everOpen, setEverOpen] = useState(false)
  useEffect(
    () =>
      subscribeStatus((s) => {
        setStatus(s)
        if (s === 'open') setEverOpen(true)
      }),
    []
  )
  const show = everOpen && status === 'connecting'
  return (
    <div className="m-reconnect" data-show={show ? 'true' : 'false'} role="status" aria-live="polite">
      {show ? '连接已断开，正在重连…' : null}
    </div>
  )
}
