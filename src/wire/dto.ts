/*
 * @Description: 远程方法的入参 / 出参类型（宿主与浏览器共享，不依赖 zod）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/wire/dto.ts
 */
import type {
  ConnectionLogEntry,
  ConnectionStatus,
  GroupRecord,
  GroupView,
  HostRecord,
  HostView,
  KnownHostKey
} from '../types.js'
// 仅类型导入：编译后被擦除，浏览器 bundle 不会因此引入 node: 模块。
import type { RecentTerminal, TerminalView } from '../terminal/registry.js'
import type { ListResult, ReadResult, RemoteEntry, RemoveResult, SearchResult } from '../sftp/remote-fs.js'

import type { UpdateStatus, UploadView } from '../update/updater.js'

export type { RecentTerminal, TerminalView, ListResult, ReadResult, RemoteEntry, RemoveResult, SearchResult, UpdateStatus, UploadView }

/**
 * 认证输入。
 *
 * 凭据字段（password / keyContent / passphrase）留空表示「沿用已保存的值」——
 * 浏览器拿不到原文，编辑表单不可能回填，所以「不填 = 不改」是唯一合理的语义。
 * 要清除私钥口令，必须显式传 clearPassphrase。
 */
export type AuthInput =
  | { kind: 'password'; password?: string }
  | { kind: 'keyPath'; keyPath: string; passphrase?: string; clearPassphrase?: boolean }
  | { kind: 'keyContent'; keyContent?: string; passphrase?: string; clearPassphrase?: boolean }
  | { kind: 'agent' }

/** 代理输入。password 留空表示沿用；clearPassword 显式清除。 */
export interface ProxyInput {
  kind: 'socks5' | 'http'
  host: string
  port: number
  username?: string
  password?: string
  clearPassword?: boolean
}

/**
 * 保存主机。id 缺省即新建。
 * auth / proxy：键缺省 = 不改；null = 移除（改为继承分组）；对象 = 设置。
 */
export interface SaveHostInput {
  id?: string
  label: string
  hostname: string
  port: number
  username?: string
  groupPath: string
  jumpHostIds: string[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
  notes?: string
  auth?: AuthInput | null
  proxy?: ProxyInput | null
}

export interface SaveGroupInput {
  path: string
  /** 重命名时传原路径。 */
  previousPath?: string
  username?: string
  port?: number
  jumpHostIds?: string[]
  startupCommand?: string
  environmentVariables?: Record<string, string>
  auth?: AuthInput | null
  proxy?: ProxyInput | null
}

export interface StateOutput {
  initialized: boolean
  unlocked: boolean
  /** 自动解锁：enabled = 本机已记住主密钥；scheme = dpapi（Windows 加密）/ file（仅本人可读文件）。 */
  autoUnlock: { enabled: boolean; scheme: 'dpapi' | 'file' }
  ssh2: { available: boolean; error?: string }
  hosts: HostView[]
  groups: GroupView[]
  statuses: ConnectionStatus[]
  knownHosts: KnownHostKey[]
  /** 当前打开着的终端（管理页面与侧边栏共享同一份）。 */
  terminals: TerminalView[]
  /** 上次运行时打开、本次可一键重开的终端。 */
  recentTerminals: RecentTerminal[]
  /**
   * 终端 WebSocket 与文件上传 / 下载依赖宿主 webServer 上的 HTTP 路由。
   * false 表示路由尚未挂载（宿主 webServer / webRuntime 服务未就绪），界面据此提示。
   */
  webRoutes: boolean
}

export interface EditorAssetOutput {
  index: number
  total: number
  chunk: string
  /** 资源版本（构建产物大小 + 修改时间），前端据此判断是否可复用已加载的脚本。 */
  version: string
}

export interface OpenTerminalInput {
  hostId: string
  cols: number
  rows: number
  /** 登录后 cd 到的目录（从文件树「在此处打开终端」进入时传）。 */
  cwd?: string
  title?: string
}

export interface TestConnectionOutput {
  ok: boolean
  latencyMs?: number
  message: string
  /** 远端 `uname -srm` 的输出，用于在 UI 上确认连对了机器。 */
  system?: string
}

export interface MethodIO {
  state: [Record<string, never>, StateOutput]
  initVault: [{ password: string }, { ok: true }]
  unlock: [{ password: string }, { ok: boolean }]
  lock: [Record<string, never>, { ok: true }]
  changePassword: [{ oldPassword: string; newPassword: string }, { ok: boolean }]
  saveHost: [SaveHostInput, HostView]
  deleteHost: [{ id: string }, { ok: true }]
  saveGroup: [SaveGroupInput, GroupView]
  deleteGroup: [{ path: string }, { ok: true }]
  testConnection: [{ id: string }, TestConnectionOutput]
  disconnect: [{ id: string }, { ok: true }]
  logs: [{ hostId?: string; limit?: number }, ConnectionLogEntry[]]
  clearLogs: [{ hostId?: string }, { ok: true }]
  forgetHostKey: [{ id: string }, { ok: true }]
  exportVault: [Record<string, never>, { hosts: HostRecord[]; groups: GroupRecord[] }]
  importVault: [{ hosts?: HostRecord[]; groups?: GroupRecord[] }, { hosts: number; groups: number }]
  openTerminal: [OpenTerminalInput, TerminalView]
  closeTerminal: [{ id: string }, { ok: true }]
  renameTerminal: [{ id: string; title: string }, TerminalView]
  setTerminalKeepAlive: [{ id: string; keepAlive: boolean }, TerminalView]
  clearRecentTerminals: [Record<string, never>, { ok: true }]
  sftpHome: [{ hostId: string }, { path: string }]
  sftpList: [{ hostId: string; path: string }, ListResult]
  sftpRead: [{ hostId: string; path: string }, ReadResult]
  sftpMkdir: [{ hostId: string; parent: string; name: string }, { path: string }]
  sftpCreateFile: [{ hostId: string; parent: string; name: string }, { path: string }]
  sftpRename: [{ hostId: string; path: string; name: string }, { path: string }]
  sftpRemove: [{ hostId: string; path: string }, RemoveResult]
  /** 复制文件 / 目录到目标目录（同名时自动改名为「名称 copy」）；返回新路径。 */
  sftpCopy: [{ hostId: string; source: string; targetDir: string }, { path: string }]
  sftpSearch: [{ hostId: string; root: string; query: string }, SearchResult]
  getPrefs: [Record<string, never>, PrefsOutput]
  setIgnore: [{ rules: string[] }, PrefsOutput]
  /** 用表单里尚未保存的配置测试连接。 */
  testDraft: [SaveHostInput, TestConnectionOutput]
  sftpWrite: [SftpWriteInput, { path: string; size: number; mtime: number }]
  editorAsset: [{ name: 'monaco.js' | 'editor.worker.js'; index: number }, EditorAssetOutput]
  /** 开关「接管添加工作区」。 */
  setTakeover: [{ enabled: boolean }, PrefsOutput]
  /** 为远程目录建本地占位目录并登记绑定；返回的 localPath 交给 DSH 创建工作区。 */
  createRemoteWorkspace: [{ hostId: string; remotePath: string; title: string }, { localPath: string; title: string }]
  /** 全部远程工作区（侧边栏据此判断某个会话是不是远程工作区）。 */
  remoteWorkspaces: [Record<string, never>, { workspaces: RemoteWorkspaceView[] }]
  /** 为远程文件签发预览地址（令牌绑定该文件所在的远程工作区根目录）。 */
  previewUrl: [{ hostId: string; path: string }, { url: string }]
  /** 远程 Git 面板：所有 git 操作经此一个入口（按 op 区分）。 */
  git: [GitInput, unknown]
  /** 自动解锁开关；开启时需要主密码。 */
  setAutoUnlock: [{ enabled: boolean; password?: string }, { ok: boolean; enabled: boolean }]
  /** 宿主机本地目录浏览（宿主目录选择器只有 native 能力时，「添加工作区」用它做应用内浏览）。 */
  localList: [{ path?: string }, LocalListOutput]
  localMkdir: [{ parent: string; name: string }, { path: string }]
  /** 读整个文件为 base64（桌面版预览内联资源用；有大小上限）。 */
  sftpReadData: [{ hostId: string; path: string }, { path: string; size: number; base64: string }]
  /** 插件自更新：当前版本、待重启版本、上次查询结果与任务进度。 */
  updateStatus: [Record<string, never>, UpdateStatus]
  /** 查询最新版本（GitHub 直连，失败回退 npm 官方源）；force 跳过 5 分钟缓存。 */
  updateCheck: [{ force?: boolean }, UpdateStatus]
  /** 开始安装（后台执行）：latest = 下载最新版；upload = 安装已上传并确认的离线包。 */
  updateInstall: [{ source: 'latest' } | { source: 'upload'; token: string }, UpdateStatus]
  /** 开关「接管 DSH 文件侧栏」。 */
  setFilesTakeover: [{ enabled: boolean }, PrefsOutput]
  /**
   * 交付卡片（deliverables/presented 事件）里某个文件是否远程工作区文件。
   * 卡片 ▾ 菜单的请求只带「会话 + 事件序号 + 文件下标」，浏览器据此决定接管还是交还宿主。
   */
  presentedFile: [{ sessionId: string; seq: number; index: number }, { remote: { hostId: string; remotePath: string } | null }]
}

export interface LocalListOutput {
  path: string
  home: string
  entries: Array<{ name: string; path: string; hidden: boolean }>
  truncated: boolean
  /** Windows 列起始目录时附带的盘符根。 */
  drives?: string[]
}

export type GitOp =
  | { op: 'status' }
  | { op: 'log'; skip: number; limit: number; ref?: string }
  | { op: 'tree'; ref: string; dir: string }
  | { op: 'file'; ref: string; path: string }
  | { op: 'compare'; base: string; target: string }
  | { op: 'branches' }
  | { op: 'show'; hash: string; parent: string | null }
  | { op: 'diff'; target: import('../git/remote-git.js').DiffTarget }
  | { op: 'stage'; paths: string[] }
  | { op: 'unstage'; paths: string[] }
  | { op: 'discard'; tracked: string[]; untracked: string[] }
  | { op: 'commit'; message: string }
  | { op: 'branchInfo'; ref: string }
  | { op: 'branchChanges'; ref: string }
  | { op: 'branchSave'; ref: string; path: string; content: string }
  | { op: 'branchRevert'; ref: string; paths: string[] }
  | { op: 'branchDiscard'; ref: string }
  | { op: 'branchCommit'; ref: string; message: string }
  | { op: 'createBranch'; name: string; from: string }

/** worktree：分支检出在另一个 git 工作目录时，在那个目录里执行（网关校验属于同一仓库）。 */
export type GitInput = { hostId: string; root: string; worktree?: string } & GitOp

export interface RemoteWorkspaceView {
  /** 本地占位目录。 */
  localPath: string
  hostId: string
  remotePath: string
  title: string
}

export interface SftpWriteInput {
  hostId: string
  path: string
  content: string
  /**
   * 打开文件时读到的修改时间（毫秒）。远端当前值不同则拒绝保存（conflict），
   * 防止覆盖掉别人（或终端里）在此期间做的改动。不传 = 强制覆盖。
   */
  expectedMtime?: number
}

export interface PrefsOutput {
  /** 用户自定义的忽略规则。 */
  ignore: string[]
  /** 内置默认规则（只读，供界面展示）。 */
  defaultIgnore: string[]
  /** 接管「添加工作区」（默认开启）。 */
  takeoverAddWorkspace: boolean
  /** 接管 DSH 自带的「文件」侧栏（默认开启）。 */
  takeoverFilesSidebar: boolean
}
