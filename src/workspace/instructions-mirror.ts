/*
 * @Description: 远程工作区的项目指令镜像 —— 把远端 AGENTS.md / CLAUDE.md 同步进本地占位目录（issue #16）
 * @Author: YangHeng
 * @Date: 2026-11-23 15:50:00
 * @FilePath: /dsh-workspace/src/workspace/instructions-mirror.ts
 *
 * 宿主指令加载器（@deepseek-ai/dsh-agent-instructions）只认本机文件系统：
 * 从会话 cwd（远程会话 = 本地占位目录）向上找 `.git` 定项目根，再沿「项目根 → cwd」逐层读 AGENTS.md 等文件。
 * 占位目录里没有这些文件，所以远程项目的指令从来不会被注入。dsh-fs 是全局单一服务、无法按路径挂载，
 * 替换它风险太大；这里改为在加载器读取之前，把远端指令文件镜像到占位目录的对应层级。
 *
 * 取舍：
 * - 只在「工作区根 ~ 会话 cwd」之间镜像。远端项目根在工作区根之上时，以工作区根为项目根：
 *   占位目录的父层可能是别的工作区、被折叠（> 8 层）、让过位（带哈希）或旧布局，逐层对应不可靠。
 * - 根标记用空的 `.git` 目录：加载器的 marker 检测只看存在与否（文件 / 目录都算），
 *   而 git 遇到无效的 `.git` 目录会跳过继续向上找，不会像空的 `.git` 文件那样报「invalid gitfile」。
 *   只在本地不存在时创建并登记，清理时只 rmdir 空目录。
 * - 镜像清单单独存放（MIRROR_MANIFEST_FILE），不动 `.dsh-workspace.json` 的结构。
 *   只删除 / 覆盖清单里登记过且内容未被改动的文件，用户自己放的文件绝不碰。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { renameWithRetry } from '../fs-atomic.js'
import { pathKey, type RemoteBinding } from './bindings.js'

/** 镜像清单文件名：与 `.dsh-workspace.json` 同目录（工作区占位目录根）。 */
export const MIRROR_MANIFEST_FILE = '.dsh-workspace.mirror.json'

/** 与宿主加载器默认候选一致：先普通指令文件，再 *.local.md。 */
export const INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'] as const

/** 项目根标记：宿主默认 projectRootMarkers = ['.git']。 */
export const PROJECT_ROOT_MARKER = '.git'

/** 宿主单个指令文件上限（maxSourceBytes 默认 1 MiB），超过的加载器也不会读，镜像了也白费。 */
export const MAX_MIRROR_BYTES = 1024 * 1024

/** 远端读取能力的最小切面：RemoteFs 天然满足，测试可用内存实现替换。 */
export interface MirrorSource {
  statPath(hostId: string, file: string): Promise<{ type: string; size: number; mtimeMs: number } | undefined>
  readBytes(hostId: string, file: string, maxBytes: number): Promise<Buffer>
}

export interface MirrorOptions {
  source: MirrorSource
  /** 错误与跳过原因只写日志，绝不抛给会话。 */
  log?: (hostId: string, message: string) => void
  /** 单次刷新等待上限（毫秒）；超时后本步不再等，刷新在后台继续，下次补上。 */
  timeoutMs?: number
  /** 同一工作区 + cwd 成功刷新后多久内不再探测（毫秒）。 */
  throttleMs?: number
  maxBytes?: number
  now?: () => number
}

export type MirrorOutcome = 'refreshed' | 'cached' | 'timeout' | 'error' | 'disposed'

interface ManifestEntry {
  remoteMtimeMs: number
  size: number
  /** 写入内容的摘要：本地文件被用户改过（摘要不符）就视为用户文件，不再覆盖或删除。 */
  sha256: string
}

interface Manifest {
  version: 1
  /** 键：相对占位目录根的 POSIX 路径（如 `AGENTS.md`、`sub/CLAUDE.md`）。 */
  files: Record<string, ManifestEntry>
  /** 插件创建的根标记所在层（相对路径，'' = 工作区根）。 */
  markers: string[]
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

function remoteOf(binding: RemoteBinding, rel: string): string {
  const root = binding.remotePath.replace(/\/+$/, '')
  if (rel === '') return root === '' ? '/' : root
  return `${root}/${rel}`
}

/**
 * 会话 cwd 相对占位目录根的各层（POSIX，由浅到深，含根 ''）。
 * cwd 不在占位目录内（理论上不会发生，resolve 就是向上找到的）时只返回根层。
 */
export function layersOf(binding: RemoteBinding, localCwd: string | undefined): string[] {
  if (localCwd === undefined || localCwd === '') return ['']
  let rel = path.relative(binding.localPath, localCwd)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // 写法差异（符号链接 / 大小写）：退到规范化键再比一次
    rel = path.relative(pathKey(binding.localPath), pathKey(localCwd))
    if (rel.startsWith('..') || path.isAbsolute(rel)) return ['']
  }
  const parts = rel.split(path.sep).filter((s) => s !== '' && s !== '.')
  const layers = ['']
  for (let i = 0; i < parts.length; i += 1) layers.push(parts.slice(0, i + 1).join('/'))
  return layers
}

/**
 * 远程工作区指令镜像器。每个工作区（占位目录）的刷新串行执行，避免并发写同一份清单。
 */
export class InstructionsMirror {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly lastDone = new Map<string, number>()
  private disposed = false

  constructor(private readonly options: MirrorOptions) {}

  /**
   * 确保镜像是新的：节流期内直接返回；否则刷新并最多等待 timeoutMs。
   * 永不抛错 —— 指令镜像只是增强，任何失败都不能阻断会话。
   */
  async ensure(binding: RemoteBinding, localCwd: string | undefined): Promise<MirrorOutcome> {
    if (this.disposed) return 'disposed'
    const layers = layersOf(binding, localCwd)
    const key = `${pathKey(binding.localPath)}\n${layers[layers.length - 1] ?? ''}`
    const now = this.options.now ?? Date.now
    const done = this.lastDone.get(key)
    if (done !== undefined && now() - done < (this.options.throttleMs ?? 30_000)) return 'cached'

    let running = this.inflight.get(key)
    if (running === undefined) {
      running = this.serial(binding.localPath, () => this.refresh(binding, layers))
        .then(() => {
          this.lastDone.set(key, now())
        })
        .catch((error: unknown) => {
          this.options.log?.(binding.hostId, `同步远程项目指令文件失败：${error instanceof Error ? error.message : String(error)}`)
          throw error
        })
        .finally(() => {
          this.inflight.delete(key)
        })
      this.inflight.set(key, running)
    }
    // 超时后后台任务继续跑完（结果下次直接命中），这里只是不再等它
    const settled = running.then(
      () => 'refreshed' as const,
      () => 'error' as const
    )
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.timeoutMs ?? 3000)
    })
    try {
      const outcome = await Promise.race([settled, timeout])
      if (outcome === 'timeout') this.options.log?.(binding.hostId, '同步远程项目指令文件超时，本步跳过，后台完成后下一步生效。')
      return outcome
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 停止接受新的刷新（插件卸载时调用）；已在跑的刷新自然结束。 */
  dispose(): void {
    this.disposed = true
    this.lastDone.clear()
  }

  private serial<T>(localPath: string, task: () => Promise<T>): Promise<T> {
    const key = pathKey(localPath)
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    const tail = next.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }

  /**
   * 一次完整刷新：定项目根 → 放根标记 → 逐层同步指令文件 → 写回清单。
   * @param layers 由浅到深的相对层（含根 ''），见 layersOf。
   */
  async refresh(binding: RemoteBinding, layers: string[]): Promise<void> {
    const { source } = this.options
    const maxBytes = this.options.maxBytes ?? MAX_MIRROR_BYTES
    const manifest = readManifest(binding.localPath)
    let dirty = false

    // 1. 远端项目根：从 cwd 层向上找 `.git`（文件也算：worktree / submodule 的 .git 是文件），最多到工作区根
    let rootIndex = 0
    for (let i = layers.length - 1; i > 0; i -= 1) {
      if ((await source.statPath(binding.hostId, remoteOf(binding, joinRel(layers[i] as string, PROJECT_ROOT_MARKER)))) !== undefined) {
        rootIndex = i
        break
      }
    }
    const rootLayer = layers[rootIndex] as string

    // 2. 根标记：让宿主 findProjectRoot 恰好停在这一层（也挡住占位目录之上偶然存在的 .git）
    const markerPath = path.join(binding.localPath, ...rootLayer.split('/').filter(Boolean), PROJECT_ROOT_MARKER)
    if (!existsSync(markerPath)) {
      mkdirSync(markerPath, { recursive: true })
      if (!manifest.markers.includes(rootLayer)) manifest.markers.push(rootLayer)
      dirty = true
    }
    // 项目根变了：撤掉本链上插件留下的旧标记，否则加载器会停在更深的旧根
    for (const layer of [...manifest.markers]) {
      if (layer === rootLayer || !layers.includes(layer)) continue
      try {
        rmdirSync(path.join(binding.localPath, ...layer.split('/').filter(Boolean), PROJECT_ROOT_MARKER))
      } catch {
        /* 不存在或非空（用户放了东西）：都不再归插件管 */
      }
      manifest.markers = manifest.markers.filter((m) => m !== layer)
      dirty = true
    }

    // 3. 逐层同步；项目根之上的层不会被加载器读取，旧镜像一并清掉
    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i] as string
      for (const name of INSTRUCTION_FILE_CANDIDATES) {
        const rel = joinRel(layer, name)
        const local = path.join(binding.localPath, ...rel.split('/'))
        const entry = manifest.files[rel]
        if (i < rootIndex) {
          if (entry !== undefined) {
            removeMirror(local, entry)
            delete manifest.files[rel]
            dirty = true
          }
          continue
        }
        const remote = await source.statPath(binding.hostId, remoteOf(binding, rel))
        const usable = remote !== undefined && remote.type === 'file' && remote.size <= maxBytes
        if (!usable) {
          if (remote !== undefined && remote.type === 'file') this.options.log?.(binding.hostId, `远程指令文件超过 ${maxBytes} 字节，跳过镜像：${remoteOf(binding, rel)}`)
          if (entry !== undefined) {
            removeMirror(local, entry)
            delete manifest.files[rel]
            dirty = true
          }
          continue
        }
        const localHash = hashOf(local)
        if (entry === undefined) {
          // 用户自己放的同名文件：尊重它，不覆盖
          if (localHash !== undefined) continue
        } else if (localHash !== undefined && localHash !== entry.sha256) {
          // 镜像被用户改过：从此归用户，不再覆盖或删除
          delete manifest.files[rel]
          dirty = true
          continue
        } else if (localHash !== undefined && entry.remoteMtimeMs === remote.mtimeMs && entry.size === remote.size) {
          continue // 远端未变：不读不写
        }
        const data = await source.readBytes(binding.hostId, remoteOf(binding, rel), maxBytes)
        writeAtomic(local, data)
        manifest.files[rel] = { remoteMtimeMs: remote.mtimeMs, size: remote.size, sha256: sha256(data) }
        dirty = true
      }
    }

    if (dirty) writeManifest(binding.localPath, manifest)
  }
}

function hashOf(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) return 'not-a-file'
    return sha256(readFileSync(file))
  } catch {
    return undefined
  }
}

/** 只删除内容仍与登记一致的镜像：用户改过的文件保留。 */
function removeMirror(file: string, entry: ManifestEntry): void {
  if (hashOf(file) === entry.sha256) rmSync(file, { force: true })
}

function writeAtomic(file: string, data: Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, data)
  renameWithRetry(tmp, file)
}

interface AgentLike {
  session?: { header?: { cwd?: string } }
}

interface HookContext {
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/**
 * 挂载钩子：会话创建时预热，每步开始前（agent/pre-step）刷新镜像。
 *
 * 时序：宿主指令加载器的 pre-step 处理器先 `await next()`，之后才 compose（读占位目录）。
 * 本处理器在调用 next() 之前完成刷新，因此无论在中间件链里排在加载器之前还是之后，
 * 镜像都先于加载器读取落盘。仅远程工作区会话（resolveBinding 命中）生效，本地会话直接放行。
 * @returns 撤销函数（挂在 ctx.effect 上）。
 */
export function mountInstructionsMirror(
  ctx: unknown,
  deps: { mirror: InstructionsMirror; resolveBinding: (cwd: string | undefined) => RemoteBinding | undefined }
): () => void {
  const c = ctx as HookContext
  const bindingOf = (agent: AgentLike | undefined): { binding: RemoteBinding; cwd: string | undefined } | undefined => {
    try {
      const cwd = agent?.session?.header?.cwd
      const binding = deps.resolveBinding(cwd)
      return binding === undefined ? undefined : { binding, cwd }
    } catch {
      return undefined
    }
  }
  const offStep = c.on('agent/pre-step', (async (payload: { agent?: AgentLike }, next: () => Promise<unknown>) => {
    const hit = bindingOf(payload?.agent)
    if (hit !== undefined) await deps.mirror.ensure(hit.binding, hit.cwd)
    return await next()
  }) as never)
  // 预热：不 await —— agent/created 的监听会被宿主等待，SFTP 连接慢时不能拖住会话创建
  const offCreated = c.on('agent/created', ((payload: { agent?: AgentLike }) => {
    const hit = bindingOf(payload?.agent)
    if (hit !== undefined) void deps.mirror.ensure(hit.binding, hit.cwd)
  }) as never)
  return () => {
    offStep()
    offCreated()
    deps.mirror.dispose()
  }
}

export function readManifest(localRoot: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(path.join(localRoot, MIRROR_MANIFEST_FILE), 'utf8')) as Partial<Manifest>
    const files: Record<string, ManifestEntry> = {}
    for (const [rel, e] of Object.entries(parsed.files ?? {})) {
      if (typeof e?.sha256 === 'string' && typeof e.size === 'number' && typeof e.remoteMtimeMs === 'number') files[rel] = e
    }
    const markers = Array.isArray(parsed.markers) ? parsed.markers.filter((m): m is string => typeof m === 'string') : []
    return { version: 1, files, markers }
  } catch {
    // 不存在或损坏：当作空清单（宁可少删，不会误删用户文件）
    return { version: 1, files: {}, markers: [] }
  }
}

function writeManifest(localRoot: string, manifest: Manifest): void {
  writeAtomic(path.join(localRoot, MIRROR_MANIFEST_FILE), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
}
