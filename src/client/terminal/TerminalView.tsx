/*
 * @Description: 交互式终端视图 —— xterm + 自动适配尺寸 + 搜索 + 断线重连
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/terminal/TerminalView.tsx
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { TerminalView as TerminalInfo } from '../../wire/dto.js'
import type { Translate } from '../context.js'
import { hostStreamBaseUrl, TerminalLink, terminalSocketUrl } from './link.js'
import { onHostThemeChange, themeFromHost } from './theme.js'

export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'gone'

/** 当前是否 macOS（决定快捷键用 ⌘ 还是 Ctrl、Option 是否当 Meta）。 */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

export interface TerminalViewProps {
  t: Translate
  terminalId: string
  /** 是否为当前可见的标签页：切回时需要重新适配尺寸并聚焦。 */
  active: boolean
  scrollback: number
  onStatus?: (terminal: TerminalInfo) => void
  onLinkState?: (state: LinkState) => void
  /** 远端 shell 已结束（exited）：「重新连接」据此改为在同主机新开 shell 替换。 */
  exited?: boolean
  /** 新开 shell 替换当前终端（由父组件实现：同主机、同标题）。 */
  onRestart?: () => void
  /** 键盘 / 粘贴输入发往远端前的改写（移动端粘滞 Ctrl 用）；缺省原样发送。 */
  transformInput?: (data: string) => string
  /** 终端就绪时交出发送句柄，卸载时回调 null（移动端快捷键条用）。 */
  onHandle?: (handle: TerminalHandle | null) => void
}

/** 外部向终端注入输入的句柄。 */
export interface TerminalHandle {
  /** 原样发给远端（不经 transformInput）。 */
  send(data: string): void
  focus(): void
  /** 是否处于应用光标键模式（vim / less 等）：方向键序列应为 ESC O x 而非 ESC [ x。 */
  applicationCursor(): boolean
}

/** 右键菜单位置（相对视口）。 */
interface MenuAt {
  x: number
  y: number
  hasSelection: boolean
}

export function TerminalView(props: TerminalViewProps) {
  const { t } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const linkRef = useRef<TerminalLink | null>(null)
  const lastSize = useRef<{ cols: number; rows: number } | null>(null)
  const handlersRef = useRef(props)
  handlersRef.current = props

  const [linkState, setLinkState] = useState<LinkState>('connecting')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const relinkRef = useRef<() => void>(() => undefined)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 点击菜单以外任何地方、按 Esc、滚动或窗口失焦时关闭菜单。
  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close)
    }
  }, [menu])

  const flash = (text: string): void => {
    setNotice(text)
    setTimeout(() => setNotice(null), 2500)
  }

  const copySelection = (): void => {
    const selection = termRef.current?.getSelection() ?? ''
    if (selection === '') return
    void navigator.clipboard?.writeText(selection).then(
      () => flash(t('term.copied')),
      () => flash(t('term.clipboardDenied'))
    )
  }

  const pasteClipboard = (): void => {
    const term = termRef.current
    if (term === null) return
    // 走 term.paste：会按终端的括号粘贴模式包裹，多行内容不会被逐行立即执行。
    void navigator.clipboard?.readText().then(
      (text) => {
        if (text !== '') term.paste(text)
        term.focus()
      },
      () => flash(t('term.clipboardDenied'))
    )
  }

  const reconnect = (): void => {
    if (props.exited === true || linkState === 'gone') props.onRestart?.()
    else relinkRef.current()
    termRef.current?.focus()
  }

  const onMenuSelect = (id: string): void => {
    setMenu(null)
    const term = termRef.current
    if (id === 'copy') copySelection()
    if (id === 'paste') pasteClipboard()
    if (id === 'selectAll') term?.selectAll()
    if (id === 'clear') term?.clear()
    if (id === 'find') {
      setSearchOpen(true)
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
    if (id === 'reconnect') reconnect()
    if (id !== 'find' && id !== 'reconnect') term?.focus()
  }

  // ---------------------------------------------------------------- 生命周期

  useEffect(() => {
    const container = hostRef.current
    if (container === null) return

    const term = new Terminal({
      theme: themeFromHost(),
      scrollback: props.scrollback,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: false,
      // macOS：Option 当 Meta 用（bash/zsh 的 Alt+B/F/D 按词移动），否则会输出 ∫ƒ∂；Option+点击强制选中文字。
      macOptionIsMeta: IS_MAC,
      macOptionClickForcesSelection: IS_MAC
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // 快捷键：搜索 = macOS ⌘F / 其他 Ctrl+F；Ctrl+Shift+C 复制选区；Ctrl+Shift+V 粘贴（macOS 用系统的 ⌘C / ⌘V）。
    // 普通 Ctrl+C 必须原样发给远端（中断进程）；macOS 上 Ctrl+F 也要留给 readline / vim / less（前进一字符 / 翻页）。
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const findMod = IS_MAC ? event.metaKey : event.ctrlKey
      if (findMod && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
        return false
      }
      // 返回 false 只让 xterm 不处理，不会取消浏览器默认行为：不 preventDefault 的话，
      // Chromium 的 Ctrl+Shift+V（粘贴为纯文本）还会再触发一次 paste，内容被粘两遍。
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        const selection = term.getSelection()
        if (selection !== '') void navigator.clipboard?.writeText(selection)
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        void navigator.clipboard?.readText().then((text) => term.paste(text))
        return false
      }
      return true
    })

    const makeLink = (): TerminalLink =>
      new TerminalLink(
        terminalSocketUrl(props.terminalId, window.location, hostStreamBaseUrl()),
        {
          onAttach: () => {
            // 每次接入服务端都会整段回放 scrollback，先清屏避免内容重复。
            term.reset()
            lastSize.current = null
            syncSize()
          },
          onOutput: (bytes) => term.write(bytes),
          onStatus: (info) => handlersRef.current.onStatus?.(info),
          onLinkState: (state) => {
            setLinkState(state)
            handlersRef.current.onLinkState?.(state)
          }
        },
        (url) => new WebSocket(url) as never
      )
    linkRef.current = makeLink()

    /** 丢弃当前连接、重新接入：远端进程不受影响，已有输出整段回放。 */
    relinkRef.current = () => {
      linkRef.current?.dispose()
      const next = makeLink()
      linkRef.current = next
      next.connect()
    }

    // 始终发给「当前」连接：重新接入后旧连接已作废。
    const inputSub = term.onData((data) => {
      const transform = handlersRef.current.transformInput
      linkRef.current?.sendInput(transform === undefined ? data : transform(data))
    })
    handlersRef.current.onHandle?.({
      send: (data) => linkRef.current?.sendInput(data),
      focus: () => term.focus(),
      applicationCursor: () => term.modes.applicationCursorKeysMode
    })

    /** 适配容器尺寸并把行列同步给远端；尺寸未变时不发送。 */
    const syncSize = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      const size = { cols: term.cols, rows: term.rows }
      const prev = lastSize.current
      if (prev !== null && prev.cols === size.cols && prev.rows === size.rows) return
      lastSize.current = size
      linkRef.current?.sendResize(size.cols, size.rows)
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      // 拖动分栏时 ResizeObserver 会高频触发，合并成一次，避免远端被刷屏重绘。
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(syncSize, 60)
    })
    observer.observe(container)

    const offTheme = onHostThemeChange(() => {
      term.options.theme = themeFromHost()
    })

    linkRef.current.connect()

    return () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      observer.disconnect()
      offTheme()
      inputSub.dispose()
      relinkRef.current = () => undefined
      handlersRef.current.onHandle?.(null)
      // 只断开本视图，不关闭远端终端：刷新或切换页面后仍可接回。
      linkRef.current?.dispose()
      term.dispose()
      termRef.current = null
      linkRef.current = null
    }
    // 终端实例与 terminalId 绑定；scrollback 只在创建时生效。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.terminalId])

  // 切回可见时重新适配并聚焦：隐藏期间容器尺寸为 0，xterm 无法测量。
  useEffect(() => {
    if (!props.active) return
    const frame = requestAnimationFrame(() => {
      const fit = fitRef.current
      const term = termRef.current
      if (fit === null || term === null) return
      try {
        fit.fit()
      } catch {
        return
      }
      const size = { cols: term.cols, rows: term.rows }
      const prev = lastSize.current
      if (prev === null || prev.cols !== size.cols || prev.rows !== size.rows) {
        lastSize.current = size
        linkRef.current?.sendResize(size.cols, size.rows)
      }
      term.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [props.active])

  // ---------------------------------------------------------------- 搜索

  const findNext = (backwards = false): void => {
    const search = searchRef.current
    if (search === null || query === '') return
    if (backwards) search.findPrevious(query)
    else search.findNext(query)
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  return (
    <div className="dshws-term">
      {linkState === 'reconnecting' || linkState === 'connecting' ? (
        <div className="dshws-term-banner" data-tone="warn">
          {linkState === 'connecting' ? t('term.connecting') : t('term.reconnecting')}
        </div>
      ) : null}
      {linkState === 'gone' ? (
        <div className="dshws-term-banner" data-tone="error">
          {t('term.gone')}
        </div>
      ) : null}

      {searchOpen ? (
        <div className="dshws-term-search">
          <input
            ref={searchInputRef}
            className="dshws-input"
            placeholder={t('term.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (e.target.value !== '') searchRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') findNext(e.shiftKey)
              if (e.key === 'Escape') closeSearch()
            }}
          />
          <button type="button" className="dshws-icon-btn" title={t('term.prev')} onClick={() => findNext(true)}>
            ↑
          </button>
          <button type="button" className="dshws-icon-btn" title={t('term.next')} onClick={() => findNext(false)}>
            ↓
          </button>
          <button type="button" className="dshws-icon-btn" title={t('common.close')} onClick={closeSearch}>
            ×
          </button>
        </div>
      ) : null}

      <div
        className="dshws-term-host"
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault()
          // 菜单约 200×240，靠近窗口右 / 下边缘时往回收，避免超出可视区。
          const x = Math.min(e.clientX, window.innerWidth - 210)
          const y = Math.min(e.clientY, window.innerHeight - 250)
          setMenu({ x, y, hasSelection: (termRef.current?.getSelection() ?? '') !== '' })
        }}
      />

      {menu !== null ? (
        <div
          className="dshws-ctx-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          // 阻止冒泡到 window 的 pointerdown（那是「点外面关闭」的监听），否则点菜单项前菜单就没了。
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { id: 'copy', label: t('term.menuCopy'), hint: IS_MAC ? '⌘C' : 'Ctrl+Shift+C', disabled: !menu.hasSelection },
            { id: 'paste', label: t('term.menuPaste'), hint: IS_MAC ? '⌘V' : 'Ctrl+Shift+V' },
            { id: 'selectAll', label: t('term.menuSelectAll') },
            { id: 'sep1' },
            { id: 'find', label: t('term.menuFind'), hint: IS_MAC ? '⌘F' : 'Ctrl+F' },
            { id: 'clear', label: t('term.menuClear') },
            { id: 'sep2' },
            {
              id: 'reconnect',
              label: props.exited === true || linkState === 'gone' ? t('term.menuRestart') : t('term.menuReconnect')
            }
          ].map((item) =>
            item.label === undefined ? (
              <div key={item.id} className="dshws-ctx-sep" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="dshws-ctx-item"
                disabled={item.disabled === true}
                onClick={() => onMenuSelect(item.id)}
              >
                <span>{item.label}</span>
                {item.hint !== undefined ? <span className="dshws-ctx-hint">{item.hint}</span> : null}
              </button>
            )
          )}
        </div>
      ) : null}

      {notice !== null ? <div className="dshws-term-notice">{notice}</div> : null}
    </div>
  )
}
