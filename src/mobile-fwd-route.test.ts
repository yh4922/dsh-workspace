/*
 * @Description: H5 本机端口转发路由 —— 路径 / 端口校验与头改写
 * @Author: YangHeng
 * @Date: 2026-11-19 17:10:00
 * @FilePath: /dsh-workspace/src/mobile-fwd-route.test.ts
 */
import { describe, expect, it } from 'vitest'
import { FWD_SANDBOX_CSP, forwardRequestHeaders, forwardResponseHeaders, rewriteLocation } from './mobile-fwd-route.js'
import { MOBILE_FWD_PREFIX, isForwardablePort, parseFwdUrl } from './wire/mobile-fwd.js'
import { LAN_PROXY_MARK } from './lan/local-route.js'

const P = MOBILE_FWD_PREFIX

describe('parseFwdUrl', () => {
  it('解析端口与目标路径（保留查询串、不解码）', () => {
    expect(parseFwdUrl(`${P}/5173/`)).toEqual({ kind: 'ok', port: 5173, target: '/' })
    expect(parseFwdUrl(`${P}/3000/a/b%20c.js?x=1&y=%2F`)).toEqual({ kind: 'ok', port: 3000, target: '/a/b%20c.js?x=1&y=%2F' })
    expect(parseFwdUrl(`${P}/8080/..%2f..%2fetc`)).toEqual({ kind: 'ok', port: 8080, target: '/..%2f..%2fetc' })
  })
  it('无结尾斜杠 → 重定向（带上查询串）', () => {
    expect(parseFwdUrl(`${P}/5173`)).toEqual({ kind: 'redirect', location: `${P}/5173/` })
    expect(parseFwdUrl(`${P}/5173?a=1`)).toEqual({ kind: 'redirect', location: `${P}/5173/?a=1` })
  })
  it('非法端口与路径', () => {
    for (const u of [
      `${P}/`,
      `${P}`,
      `${P}/0/`,
      `${P}/065/`,
      `${P}/65536/`,
      `${P}/99999/`,
      `${P}/80a/`,
      `${P}/-1/`,
      `${P}/1e3/`,
      `${P}/80/a\\b`,
      `${P}/80/a\r\nHost: x`,
      `${P}/80/a\u0000`,
      '/dsh-workspace/m/fwdx/80/',
      '/dsh-workspace/m/assets/80/',
      `${P}/%38%30/`
    ]) {
      expect(parseFwdUrl(u), u).toEqual({ kind: 'invalid' })
    }
    expect(parseFwdUrl(`${P}/65535/`)).toEqual({ kind: 'ok', port: 65535, target: '/' })
    expect(parseFwdUrl(`${P}/1/x`)).toEqual({ kind: 'ok', port: 1, target: '/x' })
  })
})

describe('isForwardablePort', () => {
  it('拒绝 DSH 自身端口与反代端口、越界端口', () => {
    const denied = [28177, 8443]
    expect(isForwardablePort(5173, denied)).toBe(true)
    expect(isForwardablePort(28177, denied)).toBe(false)
    expect(isForwardablePort(8443, denied)).toBe(false)
    expect(isForwardablePort(0, [])).toBe(false)
    expect(isForwardablePort(65536, [])).toBe(false)
    expect(isForwardablePort(80.5, [])).toBe(false)
  })
})

describe('头改写', () => {
  it('请求：去 Cookie / 反代标记 / 逐跳头，Host 与 Origin 改为本机端口', () => {
    const out = forwardRequestHeaders(
      {
        host: '192.168.1.2:8443',
        cookie: 'dsh_session=secret',
        connection: 'keep-alive',
        [LAN_PROXY_MARK]: '1',
        'x-forwarded-for': '1.2.3.4',
        origin: 'https://192.168.1.2:8443',
        referer: `https://192.168.1.2:8443${P}/5173/page?q=1`,
        accept: 'text/html'
      },
      5173
    )
    expect(out).toEqual({ host: 'localhost:5173', origin: 'http://localhost:5173', referer: 'http://localhost:5173/page?q=1', accept: 'text/html' })
  })
  it('响应：去 Set-Cookie / XFO / HSTS / Clear-Site-Data，CSP 去 frame-ancestors 并追加 sandbox，Location 加前缀', () => {
    const out = forwardResponseHeaders(
      {
        'set-cookie': ['a=1'],
        'x-frame-options': 'DENY',
        'strict-transport-security': 'max-age=1',
        'clear-site-data': '"cookies"',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'content-type': 'text/html',
        location: '/login'
      },
      3000
    )
    expect(out['set-cookie']).toBeUndefined()
    expect(out['x-frame-options']).toBeUndefined()
    expect(out['strict-transport-security']).toBeUndefined()
    expect(out['clear-site-data']).toBeUndefined()
    expect(out['content-security-policy']).toEqual(["default-src 'self'", FWD_SANDBOX_CSP])
    expect(out.location).toBe(`${P}/3000/login`)
    expect(out['content-type']).toBe('text/html')
    expect(forwardResponseHeaders({}, 1)['content-security-policy']).toEqual([FWD_SANDBOX_CSP])
    expect(FWD_SANDBOX_CSP).not.toContain('allow-same-origin')
  })
  it('Location：本机绝对地址换成转发地址，外站与相对地址原样', () => {
    expect(rewriteLocation('http://localhost:4000/a?b#c', 3000)).toBe(`${P}/4000/a?b#c`)
    expect(rewriteLocation('http://127.0.0.1/x', 3000)).toBe(`${P}/80/x`)
    expect(rewriteLocation('https://example.com/x', 3000)).toBe('https://example.com/x')
    expect(rewriteLocation('next', 3000)).toBe('next')
    expect(rewriteLocation('//evil.com/x', 3000)).toBe('//evil.com/x')
  })
})
