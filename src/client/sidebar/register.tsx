/*
 * @Description: 向 DSH 原生右侧栏注册远程工作区的三种标签
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/register.tsx
 *
 * - dsh-workspace:remote-file：文件查看器。pattern 比 better-sidebar 的 'dsh-resource://file/**' 更长，
 *   同为 extension 时按匹配长度胜出；canOpen 只认远程工作区会话里的地址，其余交还原处理方。
 *   —— 这就是「远程会话里点工具卡片的文件却去读 C:\home\...」的修复点。
 * - dsh-workspace:remote-files：远程文件树（页面标签，出现在右侧栏引导列表）。
 * - dsh-workspace:ssh：SSH 终端（可开多个）。
 *
 * 右侧栏注册表是 DSH 0.1.7 的内部接口：每项单独 try，失败只记日志，不影响插件其他功能。
 * 注意等的是 sidebarRightTabs 服务而不是插槽声明：宿主先声明插槽、后提供服务（better-sidebar 踩过）。
 */
import { createElement } from 'react'
import { FitView } from './fit-height.js'
import type { ClientContext, Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { RemoteIndex } from './remote-index.js'
import { RemoteFileTab, type SidebarTabInfo } from './RemoteFileTab.js'
import { RemoteFilesTab } from './RemoteFilesTab.js'
import { SshTab } from './SshTab.js'
import { GitTab } from './GitTab.js'
import { installPresentActions } from './present-actions.js'
import { revealPlan } from './remote-index.js'
import { FILES_KIND, TAKEOVER_FILES_ID, filesTakeover, manageFilesTakeover, onFilesTakeoverToggle, type FilesRegistry } from './files-takeover.js'

interface TabRegistry {
  register(definition: {
    id: string
    kind: string
    multiple?: boolean
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title: (address: string) => string
    guide?: ReadonlyArray<{ id: string; order: number; title: () => string; description?: () => string; icon?: (p: { size?: number }) => unknown }>
  }): () => void
  get?(kind: string): { id: string } | undefined
  subscribe?(listener: () => void): () => void
}

interface SidebarRight {
  openResource?(address: string, options?: { revealIfOpened?: boolean }): void
  /** 按类型打开页面标签（宿主 sidebarRight.openTab），params 进入该标签的导航参数。 */
  openTab?(kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
}

const FILE_ID = 'dsh-workspace:remote-file'
const FILES_ID = 'dsh-workspace:remote-files'
const SSH_ID = 'dsh-workspace:ssh'
const GIT_ID = 'dsh-workspace:git'
const CONV_FILES_ID = 'dsh-workspace-remote-files'
const CONV_GIT_ID = 'dsh-workspace-remote-git'

function Glyph(props: { size?: number; d: string }) {
  const size = typeof props.size === 'number' ? props.size : 16
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: props.d, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })
  )
}
const FOLDER_ICON = (p: { size?: number }) => createElement(Glyph, { ...p, d: 'M2 4.5h4l1.5 1.5H14v6.5H2z M10.5 9.5l1.5 1.5 1.5-1.5' })
const SSH_ICON = (p: { size?: number }) => createElement(Glyph, { ...p, d: 'M2.5 3h11v10h-11z M4.5 6l2 2-2 2 M8 10.5h3' })
const GIT_ICON = (p: { size?: number }) =>
  createElement(Glyph, { ...p, d: 'M5 3v10 M5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M5 13.5a1.5 1.5 0 1 0 0-3 M11 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M11 7.5c0 2.5-6 1.5-6 4' })

function TabTitle(props: { useTabInfo(): SidebarTabInfo }) {
  return createElement('span', null, props.useTabInfo().tab.title)
}

export function registerRemoteSidebar(ctx: ClientContext, t: Translate, api: WorkspaceApi, log: (m: string, e?: unknown) => void): () => void {
  const c = ctx as unknown as ClientContext & {
    inject(
      deps: string[],
      cb: (sub: { get(name: string): unknown; effect(f: () => () => void, label?: string): unknown }) => void
    ): { dispose(): void } | (() => void)
  }
  // 宿主没有 inject（旧版 / 精简环境）：右侧栏接入整体跳过，其余功能不受影响。
  if (typeof c.inject !== 'function') {
    log('宿主不支持 ctx.inject，跳过右侧栏接入')
    return () => undefined
  }
  const index = new RemoteIndex(
    async () => (await api.call('remoteWorkspaces', {})).workspaces,
    () => ctx.get('sessions') as never
  )
  void index.refresh()
  // 新建会话 / 新建工作区都会改变会话列表：借此刷新远程工作区列表（合并连续变化）。
  let timer: ReturnType<typeof setTimeout> | undefined
  let offSessions: (() => void) | undefined
  const watchSessions = (): void => {
    const sessions = ctx.get('sessions') as { list?: { subscribe(l: () => void): () => void } } | undefined
    if (offSessions !== undefined || sessions?.list === undefined) return
    offSessions = sessions.list.subscribe(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void index.refresh(), 500)
    })
  }
  watchSessions()

  const openResource = (address: string): void => {
    const right = ctx.get('sidebarRight') as SidebarRight | undefined
    right?.openResource?.(address, { revealIfOpened: true })
  }
  const inject = (sessionId: string) => ({ t, api, index, openResource, sessionId })

  // 交付卡片 ▾ 菜单：远程文件的「打开」→ 侧栏预览，「显示文件位置」→ 在「文件管理」里定位。
  let offPresent: () => void = () => undefined
  try {
    offPresent = installPresentActions({
      index,
      api,
      openResource,
      previewLabel: () => t('side.presentPreview'),
      canReveal: (sessionId, remotePath) => {
        const ws = index.bySession(sessionId)
        if (ws === undefined || revealPlan(ws.remotePath, remotePath) === undefined) return false
        // openTab 作用于当前显示的会话：卡片可能在子代理等其他会话的视图里，要求是同一个远程工作区。
        const current = (ctx.get('uiSession') as { adapter?: { current?: CurrentSession } } | undefined)?.adapter?.current?.getSnapshot()?.key
        if (current === undefined) return true
        const shown = index.bySession(current)
        return shown !== undefined && shown.hostId === ws.hostId && shown.remotePath === ws.remotePath
      },
      revealInFiles: (_sessionId, remotePath) => {
        // 接管了 DSH「文件」侧栏时打开接管的那个标签，避免同时出现两个文件树。
        const kind = filesTakeover.status().state === 'active' ? FILES_KIND : FILES_ID
        const right = ctx.get('sidebarRight') as SidebarRight | undefined
        // 定位是否已处理按宿主导航的 revision 判断（见 RemoteFilesTab）；nonce 供没有 revision 的旧宿主兜底。
        right?.openTab?.(kind, { params: { reveal: remotePath, nonce: Date.now() }, revealIfOpened: true })
      }
    })
  } catch (error) {
    log('接管交付卡片菜单失败', error)
  }

  const seat = c.inject(['sidebarRightTabs'], (sub) => {
    watchSessions()
    const tabs = sub.get('sidebarRightTabs') as TabRegistry | undefined
    if (tabs === undefined) return
    const attempt = (label: string, fn: () => () => void): void => {
      try {
        // 挂在本子作用域上：右侧栏服务撤下 / 重建时注册随之释放，重建后重新注册。
        sub.effect(() => fn(), `dsh-workspace: sidebar ${label}`)
      } catch (error) {
        log(`注册右侧栏「${label}」失败`, error)
      }
    }
    const slots = (id: string, body: unknown): (() => void) => {
      const a = ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, inject: inject as never }, body as never)
      )
      const b = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, TabTitle as never)
      )
      return () => {
        b()
        a()
      }
    }

    attempt(t('side.fileViewer'), () => {
      const off = tabs.register({
        id: FILE_ID,
        kind: FILE_ID,
        priority: 'extension',
        patterns: ['dsh-resource://file/session/**', 'dsh-resource://file/absolute/**'],
        canOpen: (address) => index.resolveAddress(address) !== undefined,
        title: (address) => {
          const r = index.resolveAddress(address)
          const p = r?.remotePath ?? address
          return p.slice(p.lastIndexOf('/') + 1) || p
        }
      })
      const offSlots = slots(FILE_ID, RemoteFileTab)
      return () => {
        offSlots()
        off()
      }
    })
    attempt(t('side.remoteFiles'), () => {
      const off = tabs.register({
        id: FILES_ID,
        kind: FILES_ID,
        priority: 'extension',
        title: () => t('side.remoteFiles'),
        guide: [{ id: FILES_ID, order: 11, title: () => t('side.remoteFiles'), description: () => t('side.remoteFilesHint'), icon: FOLDER_ICON }]
      })
      const offSlots = slots(FILES_ID, RemoteFilesTab)
      return () => {
        offSlots()
        off()
      }
    })
    attempt(t('side.git'), () => {
      const off = tabs.register({
        id: GIT_ID,
        kind: GIT_ID,
        priority: 'extension',
        title: () => t('side.git'),
        guide: [{ id: GIT_ID, order: 12, title: () => t('side.git'), description: () => t('side.gitHint'), icon: GIT_ICON }]
      })
      const offSlots = slots(GIT_ID, GitTab)
      return () => {
        offSlots()
        off()
      }
    })
    // 接管 DSH 自带的「文件」侧栏（kind files）：Mod+P、旧「文件」标签都改开「文件管理」。
    // 不带引导入口：自己的「文件管理」入口已在（order 11），DSH 的「文件」入口随被遮蔽的定义一起隐藏。
    // 延迟判断：给先加载的插件（better-sidebar）留出注册时间，它已接管就不抢。
    try {
      let enabled = true
      let ready = false
      const takeover = manageFilesTakeover({
        tabs: tabs as unknown as FilesRegistry,
        title: () => t('side.remoteFiles'),
        mount: () => slots(TAKEOVER_FILES_ID, RemoteFilesTab),
        enabled: () => enabled,
        ready: () => ready,
        log
      })
      sub.effect(() => {
        const offToggle = onFilesTakeoverToggle((next) => {
          enabled = next
          takeover.evaluate()
        })
        const timer = setTimeout(() => {
          void api
            .call('getPrefs', {})
            .then((p) => p.takeoverFilesSidebar, () => true)
            .then((next) => {
              enabled = next
              ready = true
              takeover.evaluate()
            })
        }, 1500)
        return () => {
          clearTimeout(timer)
          offToggle()
          takeover.dispose()
          filesTakeover.set({ state: 'pending' })
        }
      }, 'dsh-workspace: files sidebar takeover')
    } catch (error) {
      log('接管「文件」侧栏失败', error)
    }
    attempt(t('side.ssh'), () => {
      const off = tabs.register({
        id: SSH_ID,
        kind: SSH_ID,
        multiple: true,
        priority: 'extension',
        title: () => t('side.ssh'),
        guide: [{ id: SSH_ID, order: 41, title: () => t('side.ssh'), description: () => t('side.sshHint'), icon: SSH_ICON }]
      })
      const offSlots = slots(SSH_ID, SshTab)
      return () => {
        offSlots()
        off()
      }
    })
  })

  let offConversation: () => void = () => undefined
  try {
    offConversation = registerConversationTabs(ctx, { t, api, index, openResource }, log)
  } catch (error) {
    log('注册会话顶部标签失败', error)
  }

  return () => {
    offPresent()
    offConversation()
    if (timer !== undefined) clearTimeout(timer)
    offSessions?.()
    if (typeof seat === 'function') seat()
    else seat.dispose()
  }
}

interface CurrentSession {
  getSnapshot(): { key?: string } | undefined
  subscribe(listener: () => void): () => void
}

/** 会话顶部标签的注册器（抽出来便于单测）。 */
export interface ConversationTabsDeps {
  t: Translate
  api: WorkspaceApi
  index: RemoteIndex
  openResource(address: string): void
}

/**
 * 会话顶部「对话 / 轨迹」后面的「文件管理」「Git 仓库」。
 *
 * 顶部标签列表是全局的（不分会话），也没有按会话显示的条件字段 —— 所以跟着「当前会话」动态注册：
 * 当前会话有工作区（远程或本地）就注册，否则撤下（切换会话时标签会随之出现 / 消失）。
 * 撤下时若正停在这两个标签上，宿主会自动回到「对话」。
 * 组件拿到的 sessionId 是标签所在会话：已挂载的其他会话里也会看到，此时组件显示「不是远程工作区」。
 */
export function registerConversationTabs(ctx: ClientContext, deps: ConversationTabsDeps, log: (m: string, e?: unknown) => void): () => void {
  // 插件启动时 uiSession 服务往往还没提供：只取一次会取不到，标签就永远不注册（用户实测踩到）。
  // 改为等服务出现再挂；服务重建时随子作用域撤下并重挂。
  const c = ctx as unknown as {
    inject?(deps: string[], cb: (sub: { get(name: string): unknown; effect(f: () => () => void, label?: string): unknown }) => void): { dispose(): void } | (() => void)
  }
  if (typeof c.inject === 'function') {
    const fiber = c.inject(['uiSession'], (sub) => {
      const current = (sub.get('uiSession') as { adapter?: { current?: CurrentSession } } | undefined)?.adapter?.current
      if (current === undefined) {
        log('uiSession 没有 adapter.current，跳过会话顶部标签')
        return
      }
      sub.effect(() => mountConversationTabs(ctx, current, deps, log), 'dsh-workspace: conversation tabs')
    })
    return () => {
      if (typeof fiber === 'function') fiber()
      else fiber.dispose()
    }
  }
  const current = (ctx.get('uiSession') as { adapter?: { current?: CurrentSession } } | undefined)?.adapter?.current
  if (current === undefined) {
    log('宿主未提供 uiSession.adapter.current，跳过会话顶部标签')
    return () => undefined
  }
  return mountConversationTabs(ctx, current, deps, log)
}

function mountConversationTabs(ctx: ClientContext, current: CurrentSession, deps: ConversationTabsDeps, log: (m: string, e?: unknown) => void): () => void {
  // 会话顶部标签的视图区高度随内容增长：把面板钉成可视高度，左右两列才能各自滚动（见 fit-height.ts）。
  const make = (Body: typeof RemoteFilesTab) => (props: { sessionId: string }) =>
    createElement(FitView, null, createElement(Body, { ...deps, sessionId: props.sessionId }))
  const FilesView = make(RemoteFilesTab)
  const GitView = make(GitTab)

  let registered: (() => void) | null = null
  const register = (): (() => void) => {
    const offs = [
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({ name: 'conversation.view', id: CONV_FILES_ID, order: 20, label: () => deps.t('side.remoteFiles') }, FilesView as never)
      ),
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({ name: 'conversation.view', id: CONV_GIT_ID, order: 21, label: () => deps.t('side.git') }, GitView as never)
      )
    ]
    return () => {
      for (const off of offs) off()
    }
  }
  const sync = (): void => {
    const key = current.getSnapshot()?.key
    // 本地会话也有「文件管理」「Git 仓库」：只要会话有工作区（cwd）就注册。
    const remote = key !== undefined && deps.index.workspaceFor(key) !== undefined
    if (remote && registered === null) {
      try {
        registered = register()
      } catch (error) {
        log('注册会话顶部标签失败', error)
      }
    } else if (!remote && registered !== null) {
      registered()
      registered = null
    }
  }
  const offCurrent = current.subscribe(sync)
  // 远程工作区列表是异步加载的：加载完 / 新建工作区后要再判断一次。
  const offIndex = deps.index.subscribe(sync)
  sync()
  return () => {
    offCurrent()
    offIndex()
    registered?.()
    registered = null
  }
}
