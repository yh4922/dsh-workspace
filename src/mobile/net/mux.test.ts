/*
 * @Description: H5 流通道 —— 退避、帧解析、断线重连后重新 open、前台恢复
 * @Author: YangHeng
 * @Date: 2026-11-19 15:50:00
 * @FilePath: /dsh-workspace/src/mobile/net/mux.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { STALE_HIDDEN_MS, backoffDelay, createMux, encodeOpen, parseDownFrame, type SocketLike } from './mux.js'

describe('退避', () => {
  it('指数增长并封顶；抖动只往下减', () => {
    const none = () => 0
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, none))).toEqual([500, 1000, 2000, 4000])
    expect(backoffDelay(10, none)).toBe(15_000)
    expect(backoffDelay(1000, none)).toBe(15_000)
    expect(backoffDelay(0, () => 1)).toBe(350)
  })
})

describe('帧', () => {
  it('open 帧形状', () => {
    expect(encodeOpen('m1', 'session/follow', { request: {} })).toEqual({ type: 'open', streamId: 'm1', endpoint: 'session/follow', payload: { args: { request: {} } } })
  })
  it('只认 item / error / end 且必须有 streamId', () => {
    expect(parseDownFrame('{"type":"item","streamId":"a","value":1}')).toEqual({ type: 'item', streamId: 'a', value: 1 })
    expect(parseDownFrame('{"type":"end","streamId":"a"}')?.type).toBe('end')
    expect(parseDownFrame('{"type":"item","value":1}')).toBeUndefined()
    expect(parseDownFrame('{"type":"ping","streamId":"a"}')).toBeUndefined()
    expect(parseDownFrame('not json')).toBeUndefined()
  })
})

class FakeSocket implements SocketLike {
  readyState = 0
  sent: unknown[] = []
  closed = false
  onopen: SocketLike['onopen'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  onmessage: SocketLike['onmessage'] = null
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.({})
  }
  push(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let now = 0
  const mux = createMux({
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    url: () => 'ws://x/api/remote.mux',
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => timers.splice(0),
    now: () => now,
    random: () => 0
  })
  return { mux, sockets, timers, advance: (ms: number) => (now += ms) }
}

describe('复用通道', () => {
  it('连上后发 open，按 streamId 分发 item；error / end 结束流', () => {
    const { mux, sockets } = setup()
    const onItem = vi.fn()
    const onEnd = vi.fn()
    mux.openStream('workspace/follow', {}, { onItem, onEnd })
    const ws = sockets[0]!
    expect(ws.sent).toEqual([])
    ws.open()
    const open = ws.sent[0] as { streamId: string; endpoint: string }
    expect(open.endpoint).toBe('workspace/follow')
    ws.push({ type: 'item', streamId: open.streamId, value: { type: 'baseline' } })
    ws.push({ type: 'item', streamId: 'other', value: 1 })
    expect(onItem).toHaveBeenCalledTimes(1)
    ws.push({ type: 'end', streamId: open.streamId })
    expect(onEnd).toHaveBeenCalledOnce()
    expect(mux.size()).toBe(0)
  })

  it('断线按退避重连，重连后用新 streamId 重新 open 并先通知 onReopen', () => {
    const { mux, sockets, timers } = setup()
    const statuses: string[] = []
    mux.subscribeStatus((s) => statuses.push(s))
    const onReopen = vi.fn()
    mux.openStream('session/follow', { request: { address: 1 } }, { onItem: () => undefined, onReopen })
    sockets[0]!.open()
    const first = (sockets[0]!.sent[0] as { streamId: string }).streamId
    sockets[0]!.drop()
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(500)
    timers.shift()!.fn()
    sockets[1]!.open()
    const again = sockets[1]!.sent[0] as { streamId: string; payload: unknown }
    expect(again.streamId).not.toBe(first)
    expect(again.payload).toEqual({ args: { request: { address: 1 } } })
    expect(onReopen).toHaveBeenCalledOnce()
    expect(statuses).toEqual(['closed', 'connecting', 'open', 'connecting', 'open'])
  })

  it('close() 发 cancel；没有存活流时断线不再重连', () => {
    const { mux, sockets, timers } = setup()
    const h = mux.openStream('$events', {}, { onItem: () => undefined })
    sockets[0]!.open()
    const id = (sockets[0]!.sent[0] as { streamId: string }).streamId
    h.close()
    expect(sockets[0]!.sent[1]).toEqual({ type: 'cancel', streamId: id })
    sockets[0]!.drop()
    expect(timers).toHaveLength(0)
    expect(mux.status()).toBe('closed')
  })

  it('后台待久了切回前台：丢弃旧 socket 立即重连；短暂切换不打扰', () => {
    const { mux, sockets, advance } = setup()
    mux.openStream('workspace/follow', {}, { onItem: () => undefined })
    sockets[0]!.open()
    mux.onHidden()
    advance(1000)
    mux.onVisible()
    expect(sockets).toHaveLength(1)
    mux.onHidden()
    advance(STALE_HIDDEN_MS)
    mux.onVisible()
    expect(sockets[0]!.closed).toBe(true)
    expect(sockets).toHaveLength(2)
  })
})
