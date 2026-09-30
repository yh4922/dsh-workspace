/*
 * @Description: 侧边栏用的「远程会话」判定 —— 远程工作区列表缓存、文件地址解析、路径映射
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/remote-index.ts
 *
 * DSH 右侧栏的 canOpen 是同步调用，所以远程工作区列表必须预先缓存在浏览器里；
 * 会话列表变化（新建会话、新建工作区）时刷新。
 */
import type { RemoteWorkspaceView } from '../../wire/dto.js'

/** DSH 文件资源地址前缀（格式与 @deepseek-ai/dsh-util-workspace-path 的 fileAddressFor 一致）。 */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

export type FileAddress = { scope: 'session'; sessionId: string; path: string } | { scope: 'absolute'; path: string }

/** 解析 dsh-resource://file/ 地址；非法返回 undefined。 */
export function parseFileAddress(address: string): FileAddress | undefined {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
    const end = address.search(/[?#]/)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      if (rest.length === 0) return undefined
      const joined = rest.map(decodeURIComponent).join('/')
      // 盘符路径 C:/x 原样；POSIX 路径补回前导 /；UNC 保留 //。
      return { scope, path: /^[A-Za-z]:/.test(joined) ? joined : `/${joined}` }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 会话范围的文件地址（远程绝对路径保留前导 /，与 DSH 生成的写法一致）。 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':')
  return `${FILE_ADDRESS_PREFIX}session/${enc(sessionId)}/${path.split('/').map(enc).join('/')}`
}

/**
 * 本地文件（本地 POSIX 形式）的绝对文件地址：交给宿主 / 其他插件的查看器打开本地文件。
 * /C:/x/a.ts → dsh-resource://file/absolute/C:/x/a.ts；/home/a → dsh-resource://file/absolute/home/a
 */
export function localFileAddress(p: string): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':')
  const native = /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p.replace(/^\/+/, '')
  return `${FILE_ADDRESS_PREFIX}absolute/${native.split('/').map(enc).join('/')}`
}

/**
 * 本机路径的比较键：统一斜杠、去结尾斜杠。
 * 只有 Windows 风格路径（盘符 / UNC）忽略大小写 —— Linux 区分大小写，一律转小写会让只差大小写的两个工作区互相串。
 */
export function localKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(s) || /^[A-Za-z]:$/.test(s) || s.startsWith('//') ? s.toLowerCase() : s
}

/** POSIX 路径规范化（折叠 . 与 ..）。 */
export function normalizePosix(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * 地址里的路径 → 远程绝对路径。
 * - 远程绝对路径（/home/...）原样
 * - 占位目录下的本机路径（模型照抄会话 cwd）换成远程根下的对应路径
 * - 相对路径相对远程根
 * 其他本机路径返回 undefined（不属于这个远程工作区）。
 */
export function toRemotePath(ws: RemoteWorkspaceView, input: string): string | undefined {
  const p = input.replace(/\\/g, '/')
  // 先判断是否位于占位目录下：macOS / Linux 的占位目录本身就以 / 开头（/Users/me/.dsh/...），
  // 若先按「/ 开头 = 远程路径」处理，会把本机路径原样当远程路径用。
  const key = localKey(p)
  const root = localKey(ws.localPath)
  if (key === root || key.startsWith(`${root}/`)) {
    const rel = p.slice(ws.localPath.replace(/\\/g, '/').replace(/\/+$/, '').length)
    return normalizePosix(`${ws.remotePath}/${rel}`)
  }
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('//')) return undefined
  if (p.startsWith('/')) return normalizePosix(p)
  return normalizePosix(`${ws.remotePath}/${p}`)
}

/**
 * 「显示文件位置」的定位计划：从根到文件所在目录要展开的每一级；路径中有点开头的段时需要显示隐藏文件。
 * 不在根下返回 undefined（不是这个工作区的文件，不定位）。
 */
export function revealPlan(root: string, target: string): { dirs: string[]; hidden: boolean } | undefined {
  const base = root.length > 1 ? root.replace(/\/+$/, '') : root
  if (target === base || !target.startsWith(base === '/' ? '/' : `${base}/`)) return undefined
  const segments = target.slice(base === '/' ? 1 : base.length + 1).split('/').filter(Boolean)
  if (segments.length === 0) return undefined
  const dirs: string[] = []
  let cur = base
  for (const seg of segments.slice(0, -1)) {
    cur = cur === '/' ? `/${seg}` : `${cur}/${seg}`
    dirs.push(cur)
  }
  return { dirs, hidden: segments.some((s) => s.startsWith('.')) }
}

/** 本地会话在线上的「主机 id」前缀（与宿主 local/local-fs.ts 的 LOCAL_ID_PREFIX 一致）。 */
export const LOCAL_HOST_PREFIX = 'local:'

/** 侧栏面板的工作区：远程工作区，或本地会话的 cwd。 */
export interface SideWorkspace extends RemoteWorkspaceView {
  local: boolean
}

/** 本机路径 → 本地 POSIX 形式（C:\x → /C:/x；macOS / Linux 原样），去掉结尾斜杠。 */
export function toLocalPosix(p: string): string {
  const s = p.replace(/\\/g, '/')
  const trimmed = s.length > 1 ? s.replace(/\/+$/, '') : s
  return /^[A-Za-z]:/.test(trimmed) ? `/${trimmed}` : trimmed
}

/** 界面显示 / 复制用的路径：本地 Windows 路径还原成 C:\x\y，其余原样。 */
export function displayPath(p: string): string {
  return /^\/[A-Za-z]:(\/|$)/.test(p) ? p.slice(1).replace(/\//g, '\\') : p
}

function baseNameOf(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s
}

interface SessionsService {
  list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> }; subscribe(listener: () => void): () => void }
}

/** 远程工作区索引：列表缓存 + 按会话 / 本机路径查找。 */
export class RemoteIndex {
  private list: RemoteWorkspaceView[] = []
  private listeners = new Set<() => void>()

  constructor(
    private readonly load: () => Promise<RemoteWorkspaceView[]>,
    private readonly sessions: () => SessionsService | undefined
  ) {}

  /**
   * 重新拉取列表。只有内容真的变了才通知订阅者，且未变的条目沿用旧对象：
   * 会话列表在 Agent 运行时变化非常频繁（每次都会触发这里），若每次都换新对象，
   * 依赖 workspace 的面板（远程 Git / 远程文件）会反复整页重载，并关掉右侧已打开的预览。
   */
  async refresh(): Promise<void> {
    try {
      const next = await this.load()
      const oldByKey = new Map(this.list.map((w) => [JSON.stringify(w), w]))
      const merged = next.map((w) => oldByKey.get(JSON.stringify(w)) ?? w)
      const changed = merged.length !== this.list.length || merged.some((w, i) => w !== this.list[i])
      if (!changed) return
      this.list = merged
      for (const l of this.listeners) l()
    } catch {
      /* 宿主未就绪：保留旧列表，下次会话变化时再试 */
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 某本机路径（会话 cwd）所属的远程工作区。 */
  byLocalPath(p: string | undefined): RemoteWorkspaceView | undefined {
    if (p === undefined || p === '') return undefined
    const key = localKey(p)
    return this.list.find((w) => {
      const root = localKey(w.localPath)
      return key === root || key.startsWith(`${root}/`)
    })
  }

  sessionCwd(sessionId: string): string | undefined {
    return this.sessions()?.list.getSnapshot().byId[sessionId]?.cwd
  }

  bySession(sessionId: string): RemoteWorkspaceView | undefined {
    return this.byLocalPath(this.sessionCwd(sessionId))
  }

  private localCache = new Map<string, SideWorkspace>()

  /**
   * 「文件管理」「Git 仓库」用的工作区：远程会话 = 远程工作区；本地会话 = 会话 cwd（hostId 为 local:<会话 id>，
   * 路径用本地 POSIX 形式，宿主按会话推导根目录并限制在其内）。没有 cwd 返回 undefined。
   * 同一会话、同一 cwd 返回同一个对象，依赖它的面板不会因为对象换了而重载。
   */
  workspaceFor(sessionId: string): SideWorkspace | undefined {
    const remote = this.bySession(sessionId)
    if (remote !== undefined) return { ...remote, local: false }
    const cwd = this.sessionCwd(sessionId)
    if (cwd === undefined || cwd === '') return undefined
    const cached = this.localCache.get(sessionId)
    if (cached !== undefined && cached.localPath === cwd) return cached
    const view: SideWorkspace = {
      localPath: cwd,
      hostId: `${LOCAL_HOST_PREFIX}${sessionId}`,
      remotePath: toLocalPosix(cwd),
      title: baseNameOf(cwd),
      local: true
    }
    this.localCache.set(sessionId, view)
    return view
  }

  /** 文件地址 → {工作区, 远程路径}；不属于远程工作区返回 undefined。 */
  resolveAddress(address: string): { workspace: RemoteWorkspaceView; remotePath: string; sessionId?: string } | undefined {
    const parsed = parseFileAddress(address)
    if (parsed === undefined) return undefined
    if (parsed.scope === 'session') {
      const workspace = this.bySession(parsed.sessionId)
      if (workspace === undefined) return undefined
      const remotePath = toRemotePath(workspace, parsed.path === '' ? '.' : parsed.path)
      return remotePath === undefined ? undefined : { workspace, remotePath, sessionId: parsed.sessionId }
    }
    const workspace = this.byLocalPath(parsed.path)
    if (workspace === undefined) return undefined
    const remotePath = toRemotePath(workspace, parsed.path)
    return remotePath === undefined ? undefined : { workspace, remotePath }
  }
}
