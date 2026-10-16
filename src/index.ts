/*
 * @Description: dsh-workspace 宿主入口
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/index.ts
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebSocketServer } from 'ws'
import type { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSsh2Available, ssh2LoadFailure } from './ssh/lazy.js'
import { ensurePluginRoot } from './vault/store.js'
import { WorkspaceGateway } from './gateway.js'
import { HOST_MANIFEST } from './wire/manifest.js'
import { TERMINAL_WS_PATH } from './wire/contract.js'
import { createRuntime, type SessionPersistenceLike, type SessionsLike, type WorkspaceRuntime } from './runtime.js'
import type { PluginManagerLike } from './update/updater.js'
import { UPDATE_HTTP_PREFIX, createUpdateHttpHandler } from './update/http.js'
import path from 'node:path'
import { pluginRoot } from './paths.js'
import { isLocalId } from './local/local-fs.js'
import { isTrustedRequest } from './terminal/trust-fence.js'
import { attachSocket, terminalIdFromUrl, type SocketLike } from './terminal/socket.js'
import { SFTP_HTTP_PREFIX, createSftpHttpHandler } from './sftp/http.js'
import { ASSETS_PREFIX, createAssetsHandler } from './assets-route.js'
import { PREVIEW_PREFIX, createPreviewHandler } from './preview-route.js'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentTools, remotePromptText } from './agent/register.js'
import { createHostInternal, type ProbeContext } from './host-internal/index.js'

export const name = 'dsh-workspace'

// 供构建后验证脚本（scripts/verify-monaco-browser.mjs）直接测试发布产物里的资源路由。
export { ASSETS_PREFIX, createAssetsHandler } from './assets-route.js'

/**
 * 只硬依赖 typert（浏览器 ↔ 宿主的远程调用通道），它属于宿主核心组合，总是存在。
 *
 * webServer / webRuntime（终端 WebSocket）放在 ctx.inject 子作用域里按需启用：
 * 缺席时只是终端不可用，主机管理照常工作。tools / systemPrompt 留到 P1。
 */
export const inject = ['typert']

export const Config = z.object({
  /** 文件传输并发度。终端与文件分池，所以这里只影响 SFTP 批量传输。 */
  transferConcurrency: z.natural().min(1).max(32).default(8),
  /** 远端命令默认超时（毫秒）。长命令应转后台而不是调高这个值。 */
  commandTimeoutMs: z.natural().min(1000).default(120_000),
  /** SSH 握手超时（毫秒）。 */
  connectTimeoutMs: z.natural().min(1000).default(20_000),
  /** 断线后的最大重连尝试次数。 */
  maxReconnectAttempts: z.natural().min(1).max(20).default(5),
  /** 终端 scrollback 行数上限。 */
  scrollbackLines: z.natural().min(200).max(100_000).default(5000),
  /** 单文件读取上限（字节）。超过会炸 Agent 上下文，应先搜索再读片段。 */
  maxReadBytes: z.natural().min(1024).default(1024 * 1024),
  /** 连接日志保留条数。 */
  logCapacity: z.natural().min(50).max(5000).default(500),
  /** 无人查看的终端多久后自动回收（分钟）；0 = 永不回收。标记「后台保留」的终端不受影响。 */
  terminalDetachedTtlMinutes: z.natural().max(7 * 24 * 60).default(30),
  /** 单次上传文件大小上限（MB）。 */
  maxUploadMegabytes: z.natural().min(1).max(64 * 1024).default(2048)
})

export type PluginConfig = ReturnType<typeof Config>

interface TypertHost {
  register(manifest: unknown): () => void
}

interface UpgradeRequest {
  url?: string
  headers: Record<string, string | string[] | undefined>
}

interface WebServerFace {
  registerUpgrade(route: {
    path: string
    handler: (req: UpgradeRequest, socket: unknown, head: Uint8Array) => void
  }): () => void
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }): () => void
}

interface WebRuntimeFace {
  trustedHosts: readonly string[]
}

export function apply(ctx: Context, config: PluginConfig): void {
  ensurePluginRoot()
  const runtime = createRuntime(config)
  const { log, vault } = runtime

  // 启动时探测一次 ssh2 可用性，把结论写进日志。
  // 这样用户点「连接」之前就能在日志面板看到环境问题，而不是等到失败才知道。
  if (!isSsh2Available()) {
    log.error(
      '',
      'startup',
      'ssh2 不可用：SSH 相关功能将无法使用（主机管理页面仍可正常浏览与编辑）。',
      ssh2LoadFailure()
    )
  } else {
    log.info('', 'startup', 'ssh2 加载成功。')
  }

  // 保险箱只读取结构，不解锁 —— 懒解锁，首次需要凭据时才要求主密码。
  try {
    vault.load()
    log.info('', 'startup', `保险箱已就绪，共 ${vault.listHosts().length} 台主机。`)
  } catch (cause) {
    log.error('', 'startup', '保险箱加载失败。', cause)
  }

  // 构造即注册 cordis 服务 `dshWorkspace`；清单让 API 网关能分发浏览器的调用。
  new WorkspaceGateway(ctx, runtime)
  const typert = (ctx as unknown as { typert: TypertHost }).typert
  ctx.effect(() => typert.register(HOST_MANIFEST), 'dsh-workspace: typert manifest')

  // 编辑器资源目录：构建产物 lib/assets/，与本文件（lib/index.js）同级。
  // 放在 web 子作用域之外：编辑器资源走远程调用下发，不依赖宿主 HTTP 服务。
  try {
    runtime.web.assetsDir = fileURLToPath(new URL('./assets/', import.meta.url))
  } catch (cause) {
    log.error('', 'startup', '无法定位编辑器资源目录，文件编辑器将不可用。', cause)
  }

  // 终端 WebSocket 与文件传输：webServer / webRuntime 就绪后才挂载。
  // 记录两个服务当前是否可见 —— 路由没挂上时，连接日志里能直接看到缺的是哪个。
  const has = (name: string): boolean => {
    try {
      return (ctx as unknown as { get(n: string): unknown }).get(name) !== undefined
    } catch {
      return false
    }
  }
  log.info('', 'startup', `等待宿主 Web 服务：webServer=${has('webServer') ? '已就绪' : '未就绪'}，webRuntime=${has('webRuntime') ? '已就绪' : '未就绪'}。`)
  const inject = (ctx as unknown as {
    inject(deps: string[], callback: (sub: Context) => void): unknown
  }).inject.bind(ctx)
  inject(['webServer', 'webRuntime'], (sub) => mountTerminalSocket(sub, runtime))

  // 宿主可选服务：插件管理器（自更新）与会话（本地文件管理按会话取工作区根目录）。
  // 放进 inject 子作用域：服务不存在时对应功能提示不可用，不影响其余部分。
  inject(['pluginManager'], (sub) => {
    sub.effect(() => {
      runtime.host.pluginManager = (sub as unknown as { pluginManager: PluginManagerLike }).pluginManager
      return () => {
        runtime.host.pluginManager = undefined
      }
    }, 'dsh-workspace: plugin manager')
  })
  inject(['sessions'], (sub) => {
    sub.effect(() => {
      runtime.host.sessions = (sub as unknown as { sessions: SessionsLike }).sessions
      return () => {
        runtime.host.sessions = undefined
      }
    }, 'dsh-workspace: sessions')
  })
  inject(['sessionPersistence'], (sub) => {
    sub.effect(() => {
      runtime.host.sessionPersistence = (sub as unknown as { sessionPersistence: SessionPersistenceLike }).sessionPersistence
      return () => {
        runtime.host.sessionPersistence = undefined
      }
    }, 'dsh-workspace: session persistence')
  })

  // 任务页（方案 3.7）的宿主内部对象适配层：只做结构探测，构造或监听失败都不影响插件其余部分。
  ctx.effect(() => {
    try {
      const internal = createHostInternal(ctx as unknown as ProbeContext)
      runtime.host.internal = internal
      return () => {
        runtime.host.internal = undefined
        internal.dispose()
      }
    } catch (cause) {
      log.warn('', 'startup', `任务页宿主适配层初始化失败，任务页数据将不可用：${cause instanceof Error ? cause.message : String(cause)}`)
      return () => undefined
    }
  }, 'dsh-workspace: host internal')

  // P1：远程会话的 Agent 工具。只在会话 cwd 属于远程工作区时接管内置工具，本地会话零影响；
  // 例外是 open_in_sidebar（本机 / 远程都注册，受「侧边栏」偏好 openInSidebar 控制，切换即时生效）。
  // 主机配置「远程会话保留本机 shell」：getHost 读明文字段，保险箱上锁时也能读到。
  const keepLocalShell = (hostId: string): boolean => runtime.vault.getHost(hostId)?.allowLocalShell === true
  // 主机配置「远程会话可用内置文件工具读写本机文件」：同样读明文字段。文件工具每次调用现读（即时生效）。
  const keepLocalFiles = (hostId: string): boolean => runtime.vault.getHost(hostId)?.allowLocalFiles === true
  /** 当前实际保留着本机 shell 的 Agent：提示词据此说明（随主机配置变化即时增删）。 */
  const localShellAgents = new WeakSet<object>()
  ctx.effect(
    () =>
      mountAgentTools(ctx, {
        rt: runtime,
        bindings: runtime.bindings,
        preimages: runtime.preimages,
        defineTool: defineTool as (d: unknown) => unknown,
        openInSidebar: {
          enabled: () => runtime.prefs.get().sidebar.openInSidebar,
          subscribe: (listener) => runtime.prefs.subscribe(() => listener())
        },
        keepLocalShell,
        keepLocalFiles,
        // 保存主机后已打开的远程会话即时同步（打开 / 关闭都不用重建会话）。
        subscribeHosts: (listener) => runtime.vault.subscribe(listener),
        localShellAgents
      }),
    'dsh-workspace: agent tools'
  )
  inject(['systemPrompt'], (sub) => mountRemotePrompt(sub, runtime, localShellAgents))

  // 所有副作用都挂在 fiber 上，卸载/重载时自动回收。
  // 连接池尤其重要：不回收会留下常驻 SSH 连接与 keepalive 定时器。
  ctx.effect(() => () => runtime.dispose(), 'dsh-workspace.teardown')
}

/**
 * 系统提示词：告诉远程会话的模型「工具作用于哪台主机、用什么路径」。
 * 本地会话返回空串 —— 提示词不能对本地会话生效（dsh-remote issue #13）。
 */
function mountRemotePrompt(ctx: Context, runtime: WorkspaceRuntime, localShellAgents: WeakSet<object>): void {
  const prompt = (ctx as unknown as {
    systemPrompt: {
      section(section: { name: string; order: number; text: (input: { scope?: unknown }) => string }): unknown
      getSectionOrder(name: string): number
    }
  }).systemPrompt
  let order = 1000
  try {
    order = prompt.getSectionOrder('WEB_SURFACE')
  } catch {
    /* 宿主未定义该锚点：用默认顺序 */
  }
  const disposer = prompt.section({
    name: 'dsh-workspace:remote',
    order,
    text: ({ scope }) => {
      const cwd = (scope as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
      const binding = runtime.bindings.resolve(cwd)
      if (binding === undefined) return ''
      const host = runtime.vault.listHosts().find((h) => h.id === binding.hostId)
      const label = host === undefined ? binding.hostId : `${host.label} (${host.username}@${host.hostname}:${host.port})`
      // 以会话实际状态为准（随配置即时同步）；拿不到会话对象时退回主机配置，提示词用「如果有」措辞兜底。
      const keep = (typeof scope === 'object' && scope !== null && localShellAgents.has(scope)) || host?.allowLocalShell === true
      // 文件读写无会话级状态机（每次调用现读开关），提示词直接按主机配置判断。
      return remotePromptText(binding, label, keep, host?.allowLocalFiles === true)
    }
  })
  if (typeof disposer === 'function') ctx.effect(() => disposer as () => void, 'dsh-workspace: remote prompt')
}

/** 注册终端 WebSocket 升级路由，并在前面挡一道与 /api 网关一致的信任围栏。 */
function mountTerminalSocket(ctx: Context, runtime: WorkspaceRuntime): void {
  const face = ctx as unknown as { webServer: WebServerFace & { port?: number }; webRuntime: WebRuntimeFace }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  runtime.log.info('', 'startup', `宿主 Web 服务已就绪（端口 ${face.webServer.port ?? '未知'}），开始挂载终端与文件传输路由。`)

  // 挂载状态随本作用域的生命周期：服务撤下时自动回到「未挂载」，界面据此提示。
  ctx.effect(() => {
    runtime.web.mounted = true
    return () => {
      runtime.web.mounted = false
      runtime.log.warn('', 'startup', '宿主 Web 服务已撤下，终端与文件传输路由随之卸载。')
    }
  }, 'dsh-workspace: web mounted flag')

  ctx.effect(
    () =>
      face.webServer.registerUpgrade({
        path: TERMINAL_WS_PATH,
        handler: (req, socket, head) => {
          // 每次请求现读 trustedHosts：部署方更新信任列表后无需重启插件即生效。
          if (!isTrustedRequest(req, face.webRuntime.trustedHosts)) {
            // 带上 Origin：页面来源与宿主地址不一致（如桌面版自定义页面来源）时，靠它判断是哪一种被拒。
            runtime.log.warn(
              '',
              'terminal',
              '拒绝了一次不受信任的终端连接请求。',
              `host=${String(req.headers.host ?? '')} origin=${String(req.headers.origin ?? '')} sec-fetch-site=${String(req.headers['sec-fetch-site'] ?? '')}`
            )
            ;(socket as Duplex).destroy()
            return
          }
          const terminalId = terminalIdFromUrl(req.url)
          if (terminalId === undefined) {
            ;(socket as Duplex).destroy()
            return
          }
          wss.handleUpgrade(req as unknown as IncomingMessage, socket as Duplex, Buffer.from(head), (ws) => {
            attachSocket(runtime.terminals, ws as unknown as SocketLike, terminalId)
          })
        }
      }),
    'dsh-workspace: terminal WebSocket'
  )

  ctx.effect(
    () => () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
    'dsh-workspace: terminal WebSocket server'
  )

  // 文件上传 / 下载：流式对接 SFTP，挡在同一道信任围栏之后（围栏在 handler 内部）。
  ctx.effect(
    () =>
      face.webServer.register({
        kind: 'prefix',
        path: SFTP_HTTP_PREFIX,
        handler: createSftpHttpHandler({
          rt: runtime,
          fs: runtime.files,
          localFs: runtime.localFiles,
          trustedHosts: () => face.webRuntime.trustedHosts,
          maxUploadBytes: runtime.config.maxUploadMegabytes * 1024 * 1024
        })
      }),
    'dsh-workspace: sftp HTTP routes'
  )

  // 离线安装包上传（只检查不安装，确认后经 updateInstall 安装）。
  ctx.effect(
    () =>
      face.webServer.register({
        kind: 'prefix',
        path: UPDATE_HTTP_PREFIX,
        handler: createUpdateHttpHandler({
          updater: runtime.updater,
          dir: path.join(pluginRoot(), 'updates'),
          log: runtime.log,
          trustedHosts: () => face.webRuntime.trustedHosts
        })
      }),
    'dsh-workspace: update upload route'
  )

  // 编辑器资源的 HTTP 入口（网页版可用；前端默认走远程调用，这里仅作补充）。
  const assetsDir = runtime.web.assetsDir
  if (assetsDir !== undefined) {
    ctx.effect(
      () =>
        face.webServer.register({
          kind: 'prefix',
          path: ASSETS_PREFIX,
          handler: createAssetsHandler(assetsDir, () => face.webRuntime.trustedHosts)
        }),
      'dsh-workspace: static assets'
    )
  }
  // 远程 HTML 预览：令牌鉴权（见 preview-route.ts），经 SFTP 读取。
  ctx.effect(
    () =>
      face.webServer.register({
        kind: 'prefix',
        path: PREVIEW_PREFIX,
        handler: createPreviewHandler({
          grants: runtime.previews,
          trustedHosts: () => face.webRuntime.trustedHosts,
          open: async (hostId, remotePath) => {
            const d = await (isLocalId(hostId) ? runtime.localFiles : runtime.files).openDownload(hostId, remotePath)
            return { stream: d.stream, size: d.size }
          }
        })
      }),
    'dsh-workspace: html preview route'
  )
  runtime.log.info('', 'startup', '终端与文件传输路由挂载完成。')
}
