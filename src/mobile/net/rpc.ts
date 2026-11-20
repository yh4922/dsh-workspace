/*
 * @Description: H5 —— 宿主 HTTP RPC 客户端（POST /api/<ns>/<method>）与附件上传
 * @Author: YangHeng
 * @Date: 2026-11-19 14:50:00
 * @FilePath: /dsh-workspace/src/mobile/net/rpc.ts
 *
 * H5 不加载宿主外壳，没有 ctx.remote，只能按宿主线协议直接发请求（见 .docs/移动端H5/宿主线协议.md §1）。
 * 鉴权全靠同源 cookie：反代把手机的登录 cookie 换成宿主 cookie，这里只需 credentials: 'same-origin'。
 * 封包 / 解包写成纯函数，便于单测；协议变化（DSH 升级）只改这一处。
 */
import type { MethodName } from '../../wire/contract.js'
import type { MethodIO } from '../../wire/dto.js'

/** 宿主返回 ok:false、HTTP 失败或响应不可解析时抛出。按 code 分支，不要解析 message。 */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** HTTP 状态码（宿主正常应答的业务错误为 undefined）。 */
    readonly status?: number
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** 反代门禁拒绝（登录过期 / 被踢出）：界面据此跳回登录页。 */
export const RPC_UNAUTHORIZED = 'lan/unauthorized'

export interface ClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { args: object }
}

interface WireResult {
  ok?: unknown
  value?: unknown
  error?: { code?: unknown; message?: unknown; details?: unknown }
}

/**
 * 生成 rpcId。不用 crypto.randomUUID：它只在安全上下文可用，而远程访问常是局域网 http；
 * getRandomValues 不受此限制。
 */
export function newRpcId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 按宿主线协议封包：endpoint 形如 'session/list'，同时是 URL 路径与 method 字段。 */
export function encodeRequest(endpoint: string, args: object, rpcId: string = newRpcId()): ClientRequest {
  return { type: 'client-request', rpcId, method: endpoint, payload: { args } }
}

/** `{ok,value}|{ok:false,error}` → value 或抛 RpcError。宿主 server-response 外层与 result 本身都接受。 */
export function decodeResult<T>(body: unknown, status?: number): T {
  const outer = body as { type?: unknown; result?: unknown } | null
  const result = (outer !== null && typeof outer === 'object' && 'result' in outer ? outer.result : body) as WireResult | null
  if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw new RpcError('rpc/bad-response', '宿主响应格式无法识别', {}, status)
  }
  if (result.ok) return result.value as T
  const e = result.error ?? {}
  const details = e.details !== null && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {}
  throw new RpcError(typeof e.code === 'string' ? e.code : 'gateway/internal', typeof e.message === 'string' ? e.message : '未知错误', details, status)
}

/** 解析响应体：JSON 或 multipart（metadata 部分为 JSON；字节部分 P1 暂不需要，忽略）。 */
async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('multipart/')) {
    const form = await res.formData()
    const meta = form.get('metadata')
    const text = typeof meta === 'string' ? meta : meta === null ? '' : await meta.text()
    return JSON.parse(text) as unknown
  }
  const text = await res.text()
  if (text === '') return undefined
  return JSON.parse(text) as unknown
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  } catch (error) {
    if ((error as { name?: unknown }).name === 'AbortError') throw error
    throw new RpcError('rpc/network', error instanceof Error ? error.message : '网络错误')
  }
  // 401 来自反代门禁（宿主自己的 401 已被反代换 cookie 重试吸收），不是业务错误。
  if (res.status === 401) throw new RpcError(RPC_UNAUTHORIZED, '登录已过期，请重新登录', {}, 401)
  let body: unknown
  try {
    body = await readBody(res)
  } catch {
    throw new RpcError(res.ok ? 'rpc/bad-response' : `http/${res.status}`, `宿主响应无法解析（HTTP ${res.status}）`, {}, res.status)
  }
  if (!res.ok && (body === undefined || body === null || typeof body !== 'object')) {
    throw new RpcError(`http/${res.status}`, `请求失败（HTTP ${res.status}）`, {}, res.status)
  }
  return decodeResult<T>(body, res.ok ? undefined : res.status)
}

/**
 * 调用宿主 RPC。
 * @param endpoint 形如 'session/list'、'workspace/archiveSession'
 * @param args 形参对象（宿主按形参名取值），无参传 {}
 */
export async function rpc<T>(endpoint: string, args: object, opts: { signal?: AbortSignal } = {}): Promise<T> {
  return send<T>(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(encodeRequest(endpoint, args)),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {})
  })
}

/** 调用本插件网关方法（POST /api/dshWorkspace/<method>，形参固定 {payload}）。类型与桌面端 WorkspaceApi 同源。 */
export function wsApi<M extends MethodName>(method: M, payload: MethodIO[M][0], opts: { signal?: AbortSignal } = {}): Promise<MethodIO[M][1]> {
  return rpc<MethodIO[M][1]>(`dshWorkspace/${method}`, { payload }, opts)
}

export interface UploadReceipt {
  receiptId: string
  [key: string]: unknown
}

/** 拼上传地址（纯函数，便于单测）。图片带 mediaType，宿主据此按图片附件处理。 */
export function uploadUrl(sessionId: string, name: string, mediaType?: string): string {
  const q = new URLSearchParams({ sessionId, name })
  if (mediaType !== undefined && mediaType !== '') q.set('mediaType', mediaType)
  return `/api/session/uploadFileBinary?${q.toString()}`
}

/**
 * 上传附件原始字节，返回回执；prompt 里用 {type:'file', receiptId}。回执只在同一会话内有效。
 * @param isImage 图片附件带上 mediaType（缺省 image/png：剪贴板图片有时没有 type）
 */
export async function uploadFile(sessionId: string, file: File | Blob, name: string, isImage: boolean, opts: { signal?: AbortSignal } = {}): Promise<UploadReceipt> {
  const mediaType = isImage ? file.type || 'image/png' : undefined
  return send<UploadReceipt>(uploadUrl(sessionId, name, mediaType), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {})
  })
}
