/*
 * @Description: 移动端 H5 路由 —— 路径映射 / 目录穿越 / 仅反代可访问 / 反代首页跳转
 * @Author: YangHeng
 * @Date: 2026-11-19 16:00:00
 * @FilePath: /dsh-workspace/src/mobile-route.test.ts
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProxiedRequest, resolveMobileFile } from './mobile-route.js'
import { shouldRedirectToMobile } from './lan/proxy.js'
import { desktopCookieString, hasDesktopCookie, isMobileUserAgent } from './wire/mobile.js'

const dir = path.resolve('/tmp/lib/mobile')

describe('resolveMobileFile', () => {
  it('/m、/m/ 给 index.html，不长缓存', () => {
    for (const p of ['/dsh-workspace/m', '/dsh-workspace/m/']) {
      expect(resolveMobileFile(dir, p)).toEqual({ file: path.join(dir, 'index.html'), type: 'text/html; charset=utf-8', immutable: false })
    }
  })
  it('assets 按扩展名放行，带 hash 的可长缓存', () => {
    expect(resolveMobileFile(dir, '/dsh-workspace/m/assets/main-MF1qkgUu.js')).toMatchObject({ file: path.join(dir, 'assets', 'main-MF1qkgUu.js'), immutable: true })
    expect(resolveMobileFile(dir, '/dsh-workspace/m/assets/theme-86Vg51_CQG.css')?.type).toBe('text/css; charset=utf-8')
    expect(resolveMobileFile(dir, '/dsh-workspace/m/assets/app.js')?.immutable).toBe(false)
  })
  it('拒绝目录穿越、未知扩展名与 assets 以外的路径', () => {
    for (const p of [
      '/dsh-workspace/m/assets/../index.html',
      '/dsh-workspace/m/assets/%2e%2e/x.js',
      '/dsh-workspace/m/assets/..%2fx.js',
      '/dsh-workspace/m/assets/a%5cb.js',
      '/dsh-workspace/m/assets//x.js',
      '/dsh-workspace/m/assets/x.exe',
      '/dsh-workspace/m/assets/x.html',
      '/dsh-workspace/m/assets/%E0%A4%A.js',
      '/dsh-workspace/m/other.js'
    ]) {
      expect(resolveMobileFile(dir, p), p).toBeUndefined()
    }
  })
})

describe('isProxiedRequest', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } }) as never
  it('标记头 + 回环来源 + 回环 Host 才放行', () => {
    expect(isProxiedRequest(req({ host: '127.0.0.1:28177', 'x-dshws-lan-proxy': '1' }), [])).toBe(true)
    expect(isProxiedRequest(req({ host: '127.0.0.1:28177', 'x-dshws-lan-proxy': '1' }, '::ffff:127.0.0.1'), [])).toBe(true)
    expect(isProxiedRequest(req({ host: '127.0.0.1:28177' }), [])).toBe(false)
    expect(isProxiedRequest(req({ host: '127.0.0.1:28177', 'x-dshws-lan-proxy': '1' }, '192.168.1.5'), [])).toBe(false)
    expect(isProxiedRequest(req({ host: 'evil.com', 'x-dshws-lan-proxy': '1' }), [])).toBe(false)
  })
})

describe('反代首页跳转', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const tablet = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

  it('UA 判定：手机是，iPad / 安卓平板 / 桌面不是', () => {
    expect([iphone, android].map(isMobileUserAgent)).toEqual([true, true])
    expect([ipad, tablet, desktop, '', undefined].map(isMobileUserAgent)).toEqual([false, false, false, false, false])
  })
  it('桌面版 cookie 与登录 cookie 互不干扰', () => {
    expect(hasDesktopCookie('dshws_lan=abc; dshws_desktop=1')).toBe(true)
    expect(hasDesktopCookie('dshws_lan=abc')).toBe(false)
    expect(hasDesktopCookie('dshws_desktop=')).toBe(false)
    expect(desktopCookieString(true)).toBe('dshws_desktop=1; Max-Age=2592000; Path=/; SameSite=Lax')
    expect(desktopCookieString(false)).toContain('Max-Age=0')
  })
  it('只拦 GET / 的页面请求', () => {
    const r = (method: string, ua: string, extra: Record<string, string> = {}) => ({ method, headers: { 'user-agent': ua, accept: 'text/html', ...extra } })
    expect(shouldRedirectToMobile(r('GET', iphone), '/')).toBe(true)
    expect(shouldRedirectToMobile(r('GET', iphone, { cookie: 'dshws_desktop=1' }), '/')).toBe(false)
    expect(shouldRedirectToMobile(r('GET', iphone), '/api/session/list')).toBe(false)
    expect(shouldRedirectToMobile(r('POST', iphone), '/')).toBe(false)
    expect(shouldRedirectToMobile(r('GET', iphone, { accept: 'application/json' }), '/')).toBe(false)
    expect(shouldRedirectToMobile(r('GET', ipad), '/')).toBe(false)
    expect(shouldRedirectToMobile(r('GET', desktop), '/')).toBe(false)
  })
})
