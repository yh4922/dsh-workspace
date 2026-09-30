/*
 * @Description: 宿主与浏览器共享的 Typert 远程契约（方法名、描述符构造）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/wire/contract.ts
 *
 * 本文件会被打进浏览器 bundle，因此不得 import zod 或任何 node: 模块。
 * 两端的 invocation 清单都由 buildDescriptors() 生成，保证 id / 参数完全一致 ——
 * 手写两份清单是 skill-mcp-panel 那种写法，一旦漏改一边，调用会在运行时才失败。
 */

// 远程清单与描述符的身份名：typert 注册表按 `${PACKAGE}#...` 建键（同进程内不能重名），
// 所以用真实包名，且不能含 '#'。注意它与 HTTP 路由前缀、错误码命名空间是两回事，后者保持 dsh-workspace 不变。
export const PACKAGE = '@yh4922/dsh-workspace'
export const SERVICE = 'dshWorkspace'

/** 全部远程方法。每个方法只接收一个 payload 参数，返回一个值。 */
export const METHODS = [
  'state',
  'initVault',
  'unlock',
  'lock',
  'changePassword',
  'saveHost',
  'deleteHost',
  'saveGroup',
  'deleteGroup',
  'testConnection',
  'disconnect',
  'logs',
  'clearLogs',
  'forgetHostKey',
  'exportVault',
  'importVault',
  'openTerminal',
  'closeTerminal',
  'renameTerminal',
  'setTerminalKeepAlive',
  'clearRecentTerminals',
  'sftpHome',
  'sftpList',
  'sftpRead',
  'sftpMkdir',
  'sftpCreateFile',
  'sftpRename',
  'sftpRemove',
  'sftpSearch',
  'getPrefs',
  'setIgnore',
  'testDraft',
  'sftpWrite',
  'editorAsset',
  'setTakeover',
  'createRemoteWorkspace',
  'remoteWorkspaces',
  'previewUrl',
  'git',
  'setAutoUnlock',
  'sftpCopy',
  'localList',
  'localMkdir',
  'sftpReadData',
  'updateStatus',
  'updateCheck',
  'updateInstall',
  'setFilesTakeover',
  'presentedFile'
] as const

/** 经远程调用分段下发的编辑器资源。 */
export const EDITOR_ASSETS = ['monaco.js', 'editor.worker.js'] as const
export type EditorAssetName = (typeof EDITOR_ASSETS)[number]

export type MethodName = (typeof METHODS)[number]

/** Typert codec 的最小结构。两代 harness 契约并存：旧版读 schema.parse，新版读 create().parse。 */
export interface Codec {
  mode: 'strict'
  typeSymbol: string
  schema: { parse: (value: unknown) => unknown }
  create: () => { parse: (value: unknown) => unknown }
}

export type CodecFactory = (symbol: string, method: MethodName, side: 'in' | 'out') => Codec

/** 生成全部 invocation 描述符。codecFor 由各端注入（宿主用 zod，浏览器用直通）。 */
export function buildDescriptors(codecFor: CodecFactory): Array<Record<string, unknown>> {
  return METHODS.map((method) => ({
    id: `${PACKAGE}#${SERVICE}/${method}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'payload',
        wire: 'payload',
        source: 'json',
        codec: codecFor(`${PACKAGE}#${method}.in`, method, 'in')
      }
    ],
    result: codecFor(`${PACKAGE}#${method}.out`, method, 'out')
  }))
}

/** 构造一个同时兼容两代契约的 codec。 */
export function makeCodec(typeSymbol: string, parse: (value: unknown) => unknown): Codec {
  const schema = { parse }
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

/** 本插件对外暴露的错误码。浏览器按 code 分支，而不是解析 message。 */
export const ERROR_CODES = {
  vaultLocked: 'dsh-workspace/vault-locked',
  vaultUninitialized: 'dsh-workspace/vault-uninitialized',
  invalidConfig: 'dsh-workspace/invalid-config',
  hostKeyChanged: 'dsh-workspace/host-key-changed',
  ssh2Unavailable: 'dsh-workspace/ssh2-unavailable',
  exists: 'dsh-workspace/exists',
  notFound: 'dsh-workspace/not-found',
  conflict: 'dsh-workspace/conflict',
  failed: 'dsh-workspace/failed'
} as const

/** 文件上传 / 下载的 HTTP 路由前缀（宿主注册、浏览器调用两端共用）。 */
// 注意：不能带结尾斜杠。宿主 webserver 的前缀匹配规则是「路径 === 前缀 或 以 前缀 + '/' 开头」，
// 带了结尾斜杠就要求 '/dsh-workspace/sftp//...'，永远匹配不上（曾导致桌面版上传下载全部 404）。
export const SFTP_HTTP_PREFIX = '/dsh-workspace/sftp'

/** 离线安装包上传路由前缀（同样不能带结尾斜杠）。 */
export const UPDATE_HTTP_PREFIX = '/dsh-workspace/update'

/** 终端 WebSocket 路径（宿主注册、浏览器连接两端共用）。 */
export const TERMINAL_WS_PATH = '/dsh-workspace/ws/terminal'

/** 终端不存在时 socket 的关闭码：浏览器据此停止重连。 */
export const WS_CLOSE_NOT_FOUND = 4404
