/*
 * @Description: 远程工作区绑定 —— 本地占位目录 ↔ {主机, 远程路径}
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/workspace/bindings.ts
 *
 * DSH 的工作区必须是本机真实目录（workspaceRegistry 做 realpath + isDirectory），
 * 会话与工作区的绑定本质是会话的 cwd。所以远程工作区 = 一个本地占位目录 + 本表的一条记录。
 * Agent 运行时拿到的是会话 cwd，用它反查本表即知道该会话对应哪台主机、哪个远程目录。
 *
 * 主键用规范化后的占位目录路径，而不是 workspaceId：工作区删掉重加后 id 会变，路径不变。
 * 占位目录内另写一份 meta 文件作为双保险 —— 映射表丢失时可据此重建；
 * 同一远程目录允许并存多条登记（新旧布局目录共存），各自凭 meta 重建、互不挤占。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { renameWithRetry } from '../fs-atomic.js'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { WORKSPACE_META_FILE, bindingsFile, pluginRoot, safeSegment } from '../paths.js'

export interface RemoteBinding {
  /** 本地占位目录（绝对路径，创建时的原样写法）。 */
  localPath: string
  hostId: string
  /** 远程工作区根目录（POSIX 绝对路径）。 */
  remotePath: string
  title: string
  createdAt: string
}

interface MetaFile {
  kind: 'dsh-workspace/remote'
  version: 1
  hostId: string
  remotePath: string
  title: string
  createdAt: string
}

/** 占位目录的统一根：与保险箱等数据文件分开放。 */
export function remoteWorkspacesRoot(): string {
  return path.join(pluginRoot(), 'remote')
}

/**
 * 路径的比较键：绝对化、尽量 realpath、Windows 下忽略大小写。
 * 会话 cwd 与创建时的写法可能在大小写、符号链接、结尾斜杠上不同，统一后再比较。
 */
export function pathKey(p: string): string {
  let resolved = path.resolve(p)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    /* 目录已不存在：按字面比较 */
  }
  resolved = resolved.replace(/[\\/]+$/, '')
  return caseInsensitiveFs() ? resolved.toLowerCase() : resolved
}

/**
 * 本机文件系统是否不区分大小写：Windows（NTFS）与 macOS（APFS / HFS+ 默认）是，Linux 不是。
 * macOS 的 realpath 不会把大小写规范化，会话 cwd 与登记路径只差大小写时要靠这里兜住。
 */
export function caseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * 目录名：保留中文等 Unicode 字符（工作区标题默认取目录名，全变成下划线就没法看了），
 * 只替换 Windows 文件名非法字符，并去掉结尾的点与空格（Windows 会静默吞掉）。
 */
export function folderName(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  // 带扩展名的也是保留名（aux.api、con.d 在 Windows 上同样建不出来）。
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
  if (cleaned === '' || reserved.test(cleaned)) return `_${cleaned}`
  return cleaned.slice(0, 120)
}

/** 远程根目录（`/`）的占位段：不能退化成 `root`，否则与常见的 `/root` 抢同一个目录。 */
export const REMOTE_ROOT_SEGMENT = '_root'

/** 占位目录的最大层级：更深的远程路径把剩余部分折叠成一个短哈希段，防止占位目录超出 Windows 的路径长度上限。 */
export const MAX_REMOTE_PATH_SEGMENTS = 8

/**
 * 远程绝对路径 → 占位目录的各级段名。
 *
 * 占位目录按远程路径的真实结构逐级展开（/root/Yunzai → <endpoint>/root/Yunzai），
 * 这样 DSH「按工作区树」分组时，子目录能像本地工作区一样挂在父工作区下面 ——
 * 该分组的判据是「已登记工作区路径是它的祖先目录」，与目录名无关。
 * 逐段消毒（保留中文），丢弃空段与 . / ..；远程根没有段，用固定段兜住。
 * 超过 MAX_REMOTE_PATH_SEGMENTS 层时保留前面各段，剩余部分折叠成一个短哈希段（确定性，重复创建落位一致）。
 * 注意：折叠使超过 8 层的远程路径不再保证占位目录的父子嵌套
 *（/a/b/c/d/e/f/g/h/i 与 …/i/j 折叠后是兄弟节点而非祖先）——避免超过 Windows 路径长度上限的取舍。
 */
export function remotePathSegments(remotePath: string): string[] {
  const segments = remotePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..')
  if (segments.length === 0) return [REMOTE_ROOT_SEGMENT]
  const names = segments.map((s) => folderName(s))
  if (names.length <= MAX_REMOTE_PATH_SEGMENTS) return names
  const fold = createHash('sha256').update(segments.join('/')).digest('hex').slice(0, 8)
  return [...names.slice(0, MAX_REMOTE_PATH_SEGMENTS - 1), fold]
}

/** 远程路径包含关系：child 等于 parent 或位于 parent 之下（按 POSIX 逐段比较，用于判断占位目录的合法父子）。 */
export function isRemoteInside(child: string, parent: string): boolean {
  if (child === parent) return true
  const base = parent === '/' ? '' : parent.replace(/\/+$/, '')
  return child.startsWith(`${base}/`)
}

export class BindingStore {
  private data: Map<string, RemoteBinding> | undefined

  constructor(private readonly file: () => string = bindingsFile) {}

  private load(): Map<string, RemoteBinding> {
    if (this.data !== undefined) return this.data
    const map = new Map<string, RemoteBinding>()
    const file = this.file()
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { bindings?: RemoteBinding[] }
        for (const b of parsed.bindings ?? []) {
          if (typeof b?.localPath === 'string' && typeof b.hostId === 'string' && typeof b.remotePath === 'string') {
            map.set(pathKey(b.localPath), b)
          }
        }
      } catch {
        // 映射表损坏：不抛错，保持为空 —— 会话仍可按占位目录里的 meta 文件恢复。
      }
    }
    this.data = map
    return map
  }

  private persist(): void {
    const file = this.file()
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, bindings: [...this.load().values()] }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(tmp, file)
  }

  list(): RemoteBinding[] {
    return [...this.load().values()]
  }

  /**
   * 按会话 cwd（或其下任意子目录）查绑定。
   * 先查映射表；查不到再看目录里的 meta 文件（映射表丢失时自愈并补登记）。
   */
  resolve(cwd: string | undefined): RemoteBinding | undefined {
    if (cwd === undefined || cwd === '') return undefined
    const map = this.load()
    let current = pathKey(cwd)
    // 自下而上找：会话 cwd 一般就是占位目录本身，但也兼容其子目录。
    for (let i = 0; i < 64; i += 1) {
      const hit = map.get(current)
      if (hit !== undefined) return hit
      const recovered = this.fromMeta(current)
      if (recovered !== undefined) return recovered
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return undefined
  }

  private fromMeta(dir: string): RemoteBinding | undefined {
    const metaPath = path.join(dir, WORKSPACE_META_FILE)
    if (!existsSync(metaPath)) return undefined
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<MetaFile>
      if (meta.kind !== 'dsh-workspace/remote' || typeof meta.hostId !== 'string' || typeof meta.remotePath !== 'string') {
        return undefined
      }
      const map = this.load()
      const binding: RemoteBinding = {
        localPath: dir,
        hostId: meta.hostId,
        remotePath: meta.remotePath,
        title: typeof meta.title === 'string' ? meta.title : path.basename(dir),
        createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : new Date().toISOString()
      }
      map.set(pathKey(dir), binding)
      this.persist()
      return binding
    } catch {
      return undefined
    }
  }

  /**
   * 创建远程工作区的占位目录并登记。
   * 占位目录按远程路径的真实结构逐级展开（/root/Yunzai → <endpoint>/root/Yunzai），
   * 于是 DSH「按工作区树」分组能把子目录挂在父工作区下面，与本地工作区一致。
   * 落位是确定性的（目录段与撞车哈希都只由 hostId + remotePath 决定），先落位再判幂等：
   * 已有同主机同远程目录的登记落在同一位置（含带哈希后缀的目录）时直接返回。
   * 旧版本把占位目录建在 <endpoint>/<标题>：命中旧布局登记时保留旧登记，只新增新布局登记
   * （同一远程目录允许多条登记并存；不删旧登记也不动旧目录——已有会话的 cwd 还引用它，
   * 删了登记它们就静默失联）。目录段撞车（不同远程目录消毒后落到同一段）时追加短哈希区分。
   */
  create(input: { hostId: string; endpoint: string; remotePath: string; title: string }): RemoteBinding {
    const dir = this.availableDir(input)
    const same = this.list().find(
      (b) =>
        b.hostId === input.hostId &&
        b.remotePath === input.remotePath &&
        existsSync(b.localPath) &&
        pathKey(b.localPath) === pathKey(dir)
    )
    if (same !== undefined) return same
    return this.freshRegistration(input, dir)
  }

  /**
   * 返回一个不与别的远程目录冲突的落位：逐级检查从 endpoint 根到末级的每一层，
   * 某层已被「别的」远程目录占据（登记或 meta 指向的远程路径不包含 input，或属于别的主机）时，
   * 从该层起目录名追加短哈希让位（确定性，重复创建落位一致）——否则占位目录会挂进别人的地盘
   * （例如 /srv/a*b/c 落进 /srv/a:b 的目录；大小写不敏感的文件系统上 /root/App 落进 /root/app）。
   * 占据者与 input 同主机且包含 input（input 在其远程路径内部）是合法嵌套，照常穿过；
   * 没有登记与 meta 的目录是占位路径的中间层（例如先建了 /root/Yunzai，就有了 …/root），照旧收编——
   * 但收编末级前要确认它下面没有别的远程工作区（防大小写变体抢走子工作区的父目录）。
   */
  private availableDir(input: { hostId: string; endpoint: string; remotePath: string }): string {
    const root = path.join(remoteWorkspacesRoot(), safeSegment(input.endpoint))
    return this.walkAvailable(input, root, remotePathSegments(input.remotePath))
  }

  /** availableDir 的递归体：从 startDir 起逐级落下 segs，逐级做占据检查与让位。 */
  private walkAvailable(input: { hostId: string; endpoint: string; remotePath: string }, startDir: string, segs: string[]): string {
    const digest = createHash('sha256').update(`${input.hostId}\n${input.remotePath}`).digest('hex')
    type Claim = { hostId: string; remotePath: string }
    const claimOf = (candidate: string): Claim | undefined => {
      const other = this.load().get(pathKey(candidate))
      if (other !== undefined) return { hostId: other.hostId, remotePath: other.remotePath }
      if (!existsSync(candidate)) return undefined
      return this.fromMetaNoPersist(candidate)
    }
    // 同主机且占据者包含 input 才算合法嵌套；不同主机的目录一律让位，绝不共用同一个占位目录。
    const foreign = (claimed: Claim | undefined): boolean =>
      claimed !== undefined && (claimed.hostId !== input.hostId || !isRemoteInside(input.remotePath, claimed.remotePath))
    let dir = startDir
    let i = 0
    while (i < segs.length) {
      const seg = segs[i] as string
      const candidate = path.join(dir, seg)
      const claim = claimOf(candidate)
      const last = i === segs.length - 1
      const blocked =
        foreign(claim) ||
        // 末级收编没有任何登记与 meta 的目录前，确认它下面（同主机）已登记的工作区都在 input 之内：
        // 大小写不敏感的文件系统上 /Root 会撞进 /root/Yunzai 的父目录 ep/root，照常收编会把子工作区挂错父，
        // 之后再次创建 /root/Yunzai 还会因落位漂移登记出第二个占位目录（幂等失效）。
        (claim === undefined && last && this.descendantOutside(input, candidate))
      if (!blocked) {
        dir = candidate
        i += 1
        continue
      }
      // 该层被别的远程目录占着：先看同层有没有「已让位的同族目录」（带 meta、其远程路径
      // 包含 input）——父工作区当年让位到这里，input 属于它的子树，从它内部继续落位，
      // 父子才不会在盘上被拆成兄弟（/srv/a:b 占着 a_b 时，/srv/a*b 已让位到 a_b-xxxxxx，
      // 其子目录 /srv/a*b/c 应落在 a_b-xxxxxx/c）。
      const settled = this.settledInside(input, dir)
      if (settled !== undefined) {
        const base = settled.claim === '/' ? '' : settled.claim.replace(/\/+$/, '')
        const rest = input.remotePath.slice(base.length)
        const restSegs = rest
          .split('/')
          .filter((s) => s !== '' && s !== '.' && s !== '..')
          .map(folderName)
        return this.walkAvailable(input, settled.dir, restSegs)
      }
      // 没有同族目录：让位。先试 6 位短哈希，仍被占就用完整哈希（防御性兜底，正常到不了）。
      for (const tag of [digest.slice(0, 6), digest]) {
        const tagged = path.join(dir, `${seg}-${tag}`)
        if (foreign(claimOf(tagged))) continue
        return this.walkAvailable(input, tagged, segs.slice(i + 1))
      }
      return this.walkAvailable(input, path.join(dir, `${seg}-${digest}`), segs.slice(i + 1))
    }
    return dir
  }

  /** 在 dir 的直接子目录里找一个带 meta 且其远程路径包含 input 的「已让位」目录（同主机才认作同族）。 */
  private settledInside(input: { hostId: string; endpoint: string; remotePath: string }, dir: string): { dir: string; claim: string } | undefined {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(dir, entry.name)
      const meta = this.fromMetaNoPersist(candidate)
      if (meta === undefined || meta.hostId !== input.hostId || !isRemoteInside(input.remotePath, meta.remotePath)) continue
      return { dir: candidate, claim: meta.remotePath }
    }
    return undefined
  }

  /** dir 子树内已登记的工作区是否不全属于本主机、或不全落在 input 远程路径之下——有就 true，dir 不能被 input 收编。 */
  private descendantOutside(input: { hostId: string; remotePath: string }, dir: string): boolean {
    const prefix = `${pathKey(dir)}${path.sep}`
    for (const b of this.load().values()) {
      if (!pathKey(b.localPath).startsWith(prefix)) continue
      if (b.hostId !== input.hostId || !isRemoteInside(b.remotePath, input.remotePath)) return true
    }
    return false
  }

  /** 在给定目录落位：建目录、写 meta、登记并持久化（create 的共用尾段）。 */
  private freshRegistration(input: { hostId: string; endpoint: string; remotePath: string; title: string }, dir: string): RemoteBinding {
    mkdirSync(dir, { recursive: true })

    const binding: RemoteBinding = {
      localPath: dir,
      hostId: input.hostId,
      remotePath: input.remotePath,
      title: input.title,
      createdAt: new Date().toISOString()
    }
    const meta: MetaFile = {
      kind: 'dsh-workspace/remote',
      version: 1,
      hostId: binding.hostId,
      remotePath: binding.remotePath,
      title: binding.title,
      createdAt: binding.createdAt
    }
    writeFileSync(path.join(dir, WORKSPACE_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    this.load().set(pathKey(dir), binding)
    this.persist()
    return binding
  }

  private fromMetaNoPersist(dir: string): { hostId: string; remotePath: string } | undefined {
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, WORKSPACE_META_FILE), 'utf8')) as Partial<MetaFile>
      return typeof meta.hostId === 'string' && typeof meta.remotePath === 'string' ? { hostId: meta.hostId, remotePath: meta.remotePath } : undefined
    } catch {
      return undefined
    }
  }

  /** 更新标题（工作区改名时同步）。 */
  rename(localPath: string, title: string): void {
    const b = this.load().get(pathKey(localPath))
    if (b === undefined) return
    b.title = title
    this.persist()
  }

  /** 解除登记（不删占位目录：DSH 的会话记录仍引用它）。 */
  remove(localPath: string): boolean {
    const removed = this.load().delete(pathKey(localPath))
    if (removed) this.persist()
    return removed
  }
}

/**
 * 把模型给出的路径映射到远程绝对路径。
 * - 远程绝对路径（/home/...）原样使用
 * - 以占位目录开头的本地绝对路径（模型照抄了会话 cwd）换成远程根
 * - 相对路径相对远程根
 * 结果一律 POSIX 规范化（折叠 . 与 ..）。
 */
export function toRemotePath(binding: RemoteBinding, input: string): string {
  const raw = input.trim()
  let remote: string
  // 顺序很重要：先判断「是否位于占位目录下」，再把 / 开头的当远程路径。
  // macOS / Linux 的占位目录本身就以 / 开头（/Users/me/.dsh/...），先判远程会把本机路径原样发给远端。
  const rel = isWindowsAbsolute(raw) || path.isAbsolute(raw) ? localRelative(binding.localPath, path.resolve(raw)) : undefined
  if (rel !== undefined) {
    remote = rel === '' ? binding.remotePath : `${binding.remotePath}/${rel}`
  } else if (raw.startsWith('/') && !isWindowsAbsolute(raw)) {
    remote = raw
  } else if (isWindowsAbsolute(raw) || path.isAbsolute(raw)) {
    throw new Error(`远程工作区中不能访问本机路径：${raw}。请使用远程路径（如 ${binding.remotePath}/...）或相对路径。`)
  } else {
    remote = `${binding.remotePath}/${raw}`
  }
  const normalized = path.posix.normalize(remote.replace(/\\/g, '/'))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * target 位于 root 之下时返回 POSIX 形式的相对路径（root 本身为 ''），否则 undefined。
 * 字面路径与 realpath 两种写法都试：家目录 / DSH_HOME 可能是符号链接（Linux /home → /data/home、
 * macOS /var → /private/var），会话 cwd 与登记时的写法未必一致。Windows 的 path.relative 本身不区分大小写。
 */
function localRelative(root: string, target: string): string | undefined {
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  for (const r of [root, real(root)]) {
    for (const t of [target, real(target)]) {
      const rel = path.relative(r, t)
      if (rel === '') return ''
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
      // macOS：posix 的 path.relative 区分大小写，文件系统却不区分。只按不区分大小写比较根部分，
      // 余下部分保留原样（它要发往远端，远端 Linux 区分大小写）。
      if (process.platform === 'darwin') {
        const rr = r.replace(/\/+$/, '')
        const lower = t.toLowerCase()
        if (lower === rr.toLowerCase()) return ''
        if (lower.startsWith(`${rr.toLowerCase()}/`)) return t.slice(rr.length + 1)
      }
    }
  }
  return undefined
}

function isWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/**
 * 该路径是否指向本机（而不是远程主机）。内置文件工具（read / write / edit / glob / grep）
 * 按它分发：本机路径且主机开了 allowLocalFiles → 交还宿主内置实现；其余走远程管线。
 * 判定与 toRemotePath 的 throw 分支逐分支对齐（同一输入不会一边 throw 一边放行）：
 * - 只有 Windows 盘符 / UNC 写法算本机路径（macOS / Linux 的绝对路径以 / 开头，天然是远程路径）
 * - 占位目录内的本机路径维持「映射回远程路径」的例外，不算本机
 */
export function isLocalHostPath(binding: RemoteBinding, input: string): boolean {
  if (typeof input !== 'string') return false
  const raw = input.trim()
  if (!isWindowsAbsolute(raw)) return false
  return localRelative(binding.localPath, path.resolve(raw)) === undefined
}

/** 远程路径相对远程根的显示形式（glob / grep 输出用），不在根下时返回绝对路径。 */
export function relativeToRoot(binding: RemoteBinding, remote: string): string {
  const root = binding.remotePath.replace(/\/+$/, '') || '/'
  if (remote === root) return '.'
  if (root === '/') return remote.slice(1)
  return remote.startsWith(`${root}/`) ? remote.slice(root.length + 1) : remote
}
