/*
 * @Description: H5 抽屉 · 浏览器面板 —— 地址栏 + iframe；本机地址经插件转发路由
 * @Author: YangHeng
 * @Date: 2026-11-19 16:50:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/BrowserPanel.tsx
 *
 * 外站可能以 X-Frame-Options / frame-ancestors 拒绝嵌入，跨源 iframe 无法探知是否被拒，
 * 所以始终提供「在新标签打开」，并在外站地址下给出提示。
 * 转发页面运行在 CSP sandbox 的不透明源里（服务端加头），这里的 iframe 也不给 allow-same-origin，双保险。
 */
import { useEffect, useState } from 'react'
import { toFrameTarget, type FrameTarget } from './browser-url.js'
import type { PanelProps } from './panel.js'
import { Icon } from '../icons.js'

/** 记住上次地址：关抽屉 / 切 tab 再回来不丢。 */
let lastInput = ''

export default function BrowserPanel(props: PanelProps) {
  const { state } = props
  const [input, setInput] = useState(lastInput)
  const [target, setTarget] = useState<FrameTarget | undefined>(() => toFrameTarget(lastInput))
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const go = (value: string): void => {
    const next = toFrameTarget(value)
    lastInput = value
    setInput(value)
    if (next === undefined) {
      setError('地址无效（仅支持 http / https）')
      return
    }
    setError(null)
    setTarget(next)
    setNonce((n) => n + 1)
  }

  useEffect(() => {
    if (state.tab === 'browser' && state.url !== undefined && state.url !== '') go(state.url)
    // 只响应新的 openSheet 调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.seq])

  return (
    <div className="m-sheet-browser">
      <form
        className="m-sheet-urlbar"
        onSubmit={(e) => {
          e.preventDefault()
          go(input)
        }}
      >
        <input
          className="m-sheet-input"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="localhost:5173 或 https://…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="m-sheet-btn" data-primary="true">
          打开
        </button>
        {target !== undefined ? (
          <button type="button" className="m-sheet-btn" title="刷新" onClick={() => setNonce((n) => n + 1)}>
            <Icon name="rotateCw" size={16} />
          </button>
        ) : null}
      </form>
      {error !== null ? <div className="m-sheet-note" data-tone="error">{error}</div> : null}
      {target !== undefined ? (
        <>
          <div className="m-sheet-hint">
            <span>{target.forwarded ? '本机地址，经插件转发（Cookie / 存储受限，不支持 WebSocket）' : '若页面空白，可能是网站禁止被嵌入'}</span>
            <a className="m-sheet-link" href={target.src} target="_blank" rel="noopener noreferrer">
              在新标签打开
            </a>
          </div>
          <iframe
            key={`${target.src}#${nonce}`}
            className="m-sheet-frame"
            src={target.src}
            title={target.display}
            sandbox={
              target.forwarded
                ? 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'
                : 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'
            }
            referrerPolicy="no-referrer"
          />
        </>
      ) : (
        <div className="m-sheet-note">输入地址后打开。电脑上的 localhost / 127.0.0.1 地址会经插件转发到手机。</div>
      )}
    </div>
  )
}
