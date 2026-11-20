/*
 * @Description: H5 RPC —— 封包 / 解包 / 上传地址
 * @Author: YangHeng
 * @Date: 2026-11-19 15:45:00
 * @FilePath: /dsh-workspace/src/mobile/net/rpc.test.ts
 */
import { describe, expect, it } from 'vitest'
import { RpcError, decodeResult, encodeRequest, newRpcId, uploadUrl } from './rpc.js'

describe('H5 RPC 封包', () => {
  it('按宿主线协议封包，endpoint 同时作 method', () => {
    expect(encodeRequest('session/list', { _request: {} }, 'r1')).toEqual({
      type: 'client-request',
      rpcId: 'r1',
      method: 'session/list',
      payload: { args: { _request: {} } }
    })
  })
  it('rpcId 是 v4 UUID 形状且不重复', () => {
    const a = newRpcId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newRpcId()).not.toBe(a)
  })
})

describe('H5 RPC 解包', () => {
  it('server-response 外层与裸 result 都接受', () => {
    expect(decodeResult({ type: 'server-response', rpcId: 'r', result: { ok: true, value: 42 } })).toBe(42)
    expect(decodeResult({ ok: true, value: 'x' })).toBe('x')
  })
  it('ok:false 抛出带 code / details 的 RpcError', () => {
    try {
      decodeResult({ result: { ok: false, error: { code: 'session/not-found', message: '没有', details: { id: 's' } } } }, 404)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError)
      expect(e).toMatchObject({ code: 'session/not-found', message: '没有', details: { id: 's' }, status: 404 })
    }
  })
  it('缺字段的错误给兜底 code；无法识别的响应报 bad-response', () => {
    expect(() => decodeResult({ ok: false })).toThrow(expect.objectContaining({ code: 'gateway/internal' }))
    expect(() => decodeResult('oops')).toThrow(expect.objectContaining({ code: 'rpc/bad-response' }))
    expect(() => decodeResult({ result: {} })).toThrow(expect.objectContaining({ code: 'rpc/bad-response' }))
  })
})

describe('附件上传地址', () => {
  it('编码文件名，图片带 mediaType', () => {
    const u = new URL(uploadUrl('s 1', '截图 (1)&x.png', 'image/png'), 'http://x')
    expect(u.pathname).toBe('/api/session/uploadFileBinary')
    expect(Object.fromEntries(u.searchParams)).toEqual({ sessionId: 's 1', name: '截图 (1)&x.png', mediaType: 'image/png' })
    expect(uploadUrl('s', 'a.txt')).toBe('/api/session/uploadFileBinary?sessionId=s&name=a.txt')
  })
})
