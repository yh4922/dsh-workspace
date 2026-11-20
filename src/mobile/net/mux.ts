/*
 * @Description: H5 —— 宿主流通道 /api/remote.mux 客户端（单例 WebSocket、多路复用、自动重连）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:00:00
 * @FilePath: /dsh-workspace/src/mobile/net/mux.ts
 *
 * 协议见 .docs/移动端H5/宿主线协议.md §2：仅 JSON 文本帧，上行 open / cancel，下行 item / error / end。
 * 宿主没有续传：断线后对仍存活的流重新 open，服务端会再发一帧完整 snapshot，由调用方 onItem 自行合并去重。
 *
 * 手机上的连接经常「被动死亡」：切后台后系统冻结页面，socket 仍报 OPEN 但已经收不到数据。
 * 所以切回前台时，若在后台待得够久就主动断开重连，而不是等一个永远不会来的 close 事件。
 */
import { RpcError } from './rpc.js'

export type MuxStatus = 'connecting' | 'open' | 'closed'

export interface StreamHandlers<T = unknown> {
  /** 每个下行 item；重连后会先收到新的 snapshot（取决于 endpoint）。 */
  onItem(value: T): void
  /** 服务端报错（流随之结束）。断线不算错误：会自动重连并重新 open。 */
  onError?(error: RpcError): void
  /** 服务端正常结束流。 */
  onEnd?(): void
  /** 断线重连后重新 open 之前调用：提示调用方「接下来是一份新快照」。 */
  onReopen?(): void
}

export interface StreamHandle {
  close(): void
}

export type UpFrame =
  | { type: 'open'; streamId: string; endpoint: string; payload: { args: object } }
  | { type: 'cancel'; streamId: string }

export type DownFrame =
  | { type: 'item'; streamId: string; value: unknown }
  | { type: 'error'; streamId: string; error: unknown }
  | { type: 'end'; streamId: string }

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  /** 0~1，延迟在 [d*(1-jitter), d] 间随机，避免多个标签页同时撞上来。 */
  jitter?: number
}

/**
 * 第 attempt 次重连（从 0 开始）前的等待：base * 2^attempt，封顶 max，再减去随机抖动。
 * 首次断线 500ms 内就重试：手机切网络通常一两秒就恢复，等久了用户会以为卡死。
 */
export function backoffDelay(attempt: number, random: () => number = Math.random, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500
  const max = opts.maxMs ?? 15_000
  const jitter = opts.jitter ?? 0.3
  const raw = Math.min(max, base * 2 ** Math.max(0, Math.min(attempt, 30)))
  return Math.round(raw * (1 - jitter * random()))
}

export function encodeOpen(streamId: string, endpoint: string, args: object): UpFrame {
  return { type: 'open', streamId, endpoint, payload: { args } }
}

/** 解析下行帧；不认识的帧返回 undefined（忽略，不让一帧坏数据打断整条连接）。 */
export function parseDownFrame(text: string): DownFrame | undefined {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  if (v === null || typeof v !== 'object') return undefined
  const f = v as { type?: unknown; streamId?: unknown }
  if (typeof f.streamId !== 'string') return undefined
  if (f.type === 'item' || f.type === 'error' || f.type === 'end') return v as DownFrame
  return undefined
}

/** 把下行 error 帧的 error 字段转成 RpcError（与 rpc() 的错误同形，界面统一处理）。 */
export function toRpcError(error: unknown): RpcError {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; details?: unknown }
  const details = e.details !== null && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {}
  return new RpcError(typeof e.code === 'string' ? e.code : 'stream/error', typeof e.message === 'string' ? e.message : '流已中断', details)
}

/** 与 WebSocket 兼容的最小形状（单测注入假实现）。 */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export interface MuxDeps {
  createSocket(url: string): SocketLike
  url(): string
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  now(): number
  random(): number
}

/** 在后台待超过它，切回前台就主动重连（见文件头「被动死亡」）。 */
export const STALE_HIDDEN_MS = 15_000
const OPEN = 1

interface LiveStream {
  endpoint: string
  args: object
  handlers: StreamHandlers<never>
  /** 当前连接上的 streamId；每次重新 open 都换新的，旧连接残留的帧自然对不上。 */
  streamId: string
}

/**
 * 创建一个复用通道。页面里只用 defaultMux（下方单例）；工厂形式只为了单测能注入假 socket / 假时钟。
 */
export function createMux(deps: MuxDeps) {
  const streams = new Map<string, LiveStream>()
  const statusListeners = new Set<(s: MuxStatus) => void>()
  let socket: SocketLike | undefined
  let status: MuxStatus = 'closed'
  let attempt = 0
  let timer: unknown
  let seq = 0
  let hiddenAt: number | undefined
  /** 是否成功连上过：之后的每次 open 都是「重连」，要提示调用方准备接新快照。 */
  let everOpened = false

  const setStatus = (next: MuxStatus): void => {
    if (next === status) return
    status = next
    for (const l of [...statusListeners]) l(next)
  }

  const nextId = (): string => `m${++seq}`
  const sendFrame = (frame: UpFrame): void => {
    if (socket !== undefined && socket.readyState === OPEN) socket.send(JSON.stringify(frame))
  }
  const sendOpen = (s: LiveStream): void => sendFrame(encodeOpen(s.streamId, s.endpoint, s.args))

  /** 按 streamId 找流（下行帧只带 streamId）。流不多（个位数），线性查找足够。 */
  const byStreamId = (streamId: string): [string, LiveStream] | undefined => {
    for (const entry of streams) if (entry[1].streamId === streamId) return entry
    return undefined
  }

  function onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    const frame = parseDownFrame(data)
    if (frame === undefined) return
    const hit = byStreamId(frame.streamId)
    if (hit === undefined) return
    const [key, s] = hit
    if (frame.type === 'item') s.handlers.onItem(frame.value as never)
    else if (frame.type === 'error') {
      streams.delete(key)
      s.handlers.onError?.(toRpcError(frame.error))
    } else {
      streams.delete(key)
      s.handlers.onEnd?.()
    }
  }

  function connect(): void {
    if (timer !== undefined) {
      deps.clearTimer(timer)
      timer = undefined
    }
    if (socket !== undefined) return
    setStatus('connecting')
    const ws = deps.createSocket(deps.url())
    socket = ws
    const isReconnect = attempt > 0 || everOpened
    ws.onopen = () => {
      if (socket !== ws) return
      attempt = 0
      everOpened = true
      setStatus('open')
      for (const s of streams.values()) {
        s.streamId = nextId()
        if (isReconnect) s.handlers.onReopen?.()
        sendOpen(s)
      }
    }
    ws.onmessage = (ev) => {
      if (socket === ws) onMessage(ev.data)
    }
    ws.onerror = () => undefined
    ws.onclose = () => {
      if (socket !== ws) return
      socket = undefined
      scheduleReconnect()
    }
  }

  function scheduleReconnect(): void {
    // 没有存活的流就不重连：空连接只会白白耗电，下次 openStream 时再连。
    if (streams.size === 0) {
      setStatus('closed')
      return
    }
    setStatus('connecting')
    if (timer !== undefined) return
    const delay = backoffDelay(attempt++, deps.random)
    timer = deps.setTimer(() => {
      timer = undefined
      connect()
    }, delay)
  }

  /** 丢弃当前 socket 并立即重连（退避清零）。 */
  function reconnectNow(): void {
    attempt = 0
    const old = socket
    socket = undefined
    if (old !== undefined) {
      old.onopen = old.onclose = old.onerror = old.onmessage = null
      try {
        old.close()
      } catch {
        /* 已经关了 */
      }
    }
    if (streams.size > 0) connect()
    else setStatus('closed')
  }

  return {
    /**
     * 打开一个流。连接未就绪时先记下，连上后统一 open；断线重连后自动重新 open。
     * @param endpoint 形如 'session/follow'、'workspace/follow'、'$events'
     */
    openStream<T>(endpoint: string, args: object, handlers: StreamHandlers<T>): StreamHandle {
      const key = nextId()
      const s: LiveStream = { endpoint, args, handlers: handlers as StreamHandlers<never>, streamId: nextId() }
      streams.set(key, s)
      if (socket === undefined) connect()
      else sendOpen(s)
      return {
        close() {
          const cur = streams.get(key)
          if (cur === undefined) return
          streams.delete(key)
          sendFrame({ type: 'cancel', streamId: cur.streamId })
        }
      }
    },
    status: (): MuxStatus => status,
    /** 订阅连接状态（立即回放一次当前值），返回取消函数。 */
    subscribeStatus(cb: (s: MuxStatus) => void): () => void {
      statusListeners.add(cb)
      cb(status)
      return () => statusListeners.delete(cb)
    },
    /** 页面转入后台。 */
    onHidden(): void {
      hiddenAt = deps.now()
    },
    /** 页面回到前台：后台太久（socket 可能已被动死亡）或当前没连上，立即重连。 */
    onVisible(): void {
      const away = hiddenAt === undefined ? 0 : deps.now() - hiddenAt
      hiddenAt = undefined
      if (streams.size === 0) return
      if (away >= STALE_HIDDEN_MS || socket === undefined || socket.readyState !== OPEN) reconnectNow()
    },
    /** 网络恢复：没连上就立刻重试，不等退避计时器。 */
    onOnline(): void {
      if (streams.size > 0 && (socket === undefined || socket.readyState !== OPEN)) reconnectNow()
    },
    /** 存活流数量（调试 / 单测）。 */
    size: (): number => streams.size
  }
}

export type Mux = ReturnType<typeof createMux>

let defaultMux: Mux | undefined

/** 页面单例：同源 ws/wss，挂上前后台与网络恢复监听。 */
function mux(): Mux {
  if (defaultMux !== undefined) return defaultMux
  const m = createMux({
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    url: () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/remote.mux`,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: Math.random
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') m.onHidden()
    else m.onVisible()
  })
  window.addEventListener('online', () => m.onOnline())
  // iOS 从后台恢复有时只触发 pageshow（bfcache），不触发 visibilitychange。
  window.addEventListener('pageshow', (ev) => {
    if ((ev as PageTransitionEvent).persisted) m.onVisible()
  })
  defaultMux = m
  return m
}

/** 打开一个宿主流（见 createMux().openStream）。 */
export function openStream<T>(endpoint: string, args: object, handlers: StreamHandlers<T>): StreamHandle {
  return mux().openStream(endpoint, args, handlers)
}

/** 订阅连接状态（立即回放当前值），用于顶部「重连中」细条。 */
export function subscribeStatus(cb: (s: MuxStatus) => void): () => void {
  return mux().subscribeStatus(cb)
}
