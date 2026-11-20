/*
 * @Description: H5 抽屉 · 浏览器面板的地址换算（纯函数，便于单测）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:30:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/browser-url.ts
 *
 * 手机上的 localhost 指手机自己：电脑上的本机地址要经插件转发路由 /dsh-workspace/m/fwd/<端口>/<路径>（见 src/mobile-fwd-route.ts）。
 */
import { MOBILE_FWD_PREFIX } from '../../wire/mobile-fwd.js'

export interface FrameTarget {
  /** iframe 的 src。 */
  src: string
  /** 是否经插件转发（本机地址）。 */
  forwarded: boolean
  /** 规范化后的原始地址（显示 / 新标签打开用）。 */
  display: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return LOCAL_HOSTS.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h.endsWith('.localhost')
}

/**
 * 用户输入 → iframe 地址。无协议时补 http://（本机开发服务多为 http）；纯数字视为本机端口。
 * 非 http(s) 协议或无法解析返回 undefined。
 */
export function toFrameTarget(input: string): FrameTarget | undefined {
  let raw = input.trim()
  if (raw === '') return undefined
  if (/^\d{1,5}(\/.*)?$/.test(raw)) raw = `localhost:${raw}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!isLocalHostname(url.hostname)) return { src: url.href, forwarded: false, display: url.href }
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { src: `${MOBILE_FWD_PREFIX}/${port}${url.pathname}${url.search}${url.hash}`, forwarded: true, display: url.href }
}
