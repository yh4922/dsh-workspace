/*
 * @Description: H5 —— iOS 软键盘遮挡：用 visualViewport 算出被键盘盖住的高度
 * @Author: YangHeng
 * @Date: 2026-11-19 17:25:00
 * @FilePath: /dsh-workspace/src/mobile/chat/keyboard.ts
 *
 * iOS Safari 弹出键盘时不缩小布局视口（100dvh 不变），固定在底部的输入框会被盖住；visualViewport 才反映可见区域。
 * Android Chrome 默认会缩布局视口，此时算出来是 0，不影响。
 */
import { useEffect, useState } from 'react'

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (vv === null || vv === undefined) return
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
        // 小于 60px 视为地址栏伸缩之类的抖动，不算键盘。
        setInset(covered > 60 ? covered : 0)
        // iOS 会把整个页面往上推来露出输入框，这里改由我们自己留出空间，把文档滚回顶。
        if (covered > 60 && window.scrollY !== 0) window.scrollTo(0, 0)
      })
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}
