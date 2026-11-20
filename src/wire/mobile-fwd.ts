/*
 * @Description: H5 浏览器面板的本机端口转发 —— 宿主路由与浏览器共享的前缀与路径校验（纯函数）
 * @Author: YangHeng
 * @Date: 2026-11-19 16:35:00
 * @FilePath: /dsh-workspace/src/wire/mobile-fwd.ts
 *
 * 本文件会被打进浏览器 bundle，不得 import zod 或任何 node: 模块。
 */
import { MOBILE_PREFIX } from './mobile.js'

/** /dsh-workspace/m/fwd/<端口>/<路径>：宿主按最长前缀匹配，不会被 MOBILE_PREFIX 的静态资源路由抢走。 */
export const MOBILE_FWD_PREFIX = `${MOBILE_PREFIX}/fwd`

export type FwdParse =
  | { kind: 'ok'; port: number; target: string }
  /** /fwd/<端口>（无结尾斜杠）：重定向到带斜杠的地址，页面里的相对路径才能落在转发前缀下。 */
  | { kind: 'redirect'; location: string }
  | { kind: 'invalid' }

/**
 * 解析原始请求地址（req.url，含查询串，不做解码以免改变上游看到的路径）。
 * target 是发往上游的 request-target：以 / 开头，保留原查询串。
 */
export function parseFwdUrl(rawUrl: string): FwdParse {
  const q = rawUrl.indexOf('?')
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q)
  const search = q === -1 ? '' : rawUrl.slice(q)
  const head = `${MOBILE_FWD_PREFIX}/`
  if (!path.startsWith(head)) return { kind: 'invalid' }
  const rest = path.slice(head.length)
  const slash = rest.indexOf('/')
  const portText = slash === -1 ? rest : rest.slice(0, slash)
  if (!/^[1-9]\d{0,4}$/.test(portText)) return { kind: 'invalid' }
  const port = Number(portText)
  if (port > 65535) return { kind: 'invalid' }
  if (slash === -1) return { kind: 'redirect', location: `${head}${port}/${search}` }
  const target = `${rest.slice(slash)}${search}`
  // 控制字符 / 反斜杠一律拒绝（防请求走私与路径歧义）；# 不会出现在 req.url 里，出现即非法。
  if (/[\u0000-\u001f\u007f\\#]/.test(target)) return { kind: 'invalid' }
  return { kind: 'ok', port, target }
}

/** 端口是否允许转发：拒绝 DSH 自身 Web 端口与远程访问反代端口（否则可绕过反代门禁 / 复用宿主 cookie）。 */
export function isForwardablePort(port: number, denied: readonly number[]): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && !denied.includes(port)
}
