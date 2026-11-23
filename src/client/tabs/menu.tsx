/*
 * @Description: 右侧栏标签右键菜单的插件项 —— 关闭左侧 / 右侧 / 其他 / 全部、固定 / 取消固定，文件类标签再加复制路径、在文件管理中显示
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/menu.tsx
 *
 * DSH 0.2.2 起宿主改用 contextMenus 服务（target 'tab'）声明菜单动作，菜单换成 primitives 的 Menu，不再有 [data-dockkit-tab-menu] 容器，
 * 下面自绘的 <button> 失去样式变成原生按钮 —— 所以有该服务时走 toHostActions 交给宿主渲染（见 register.ts），下面的插槽组件只给旧宿主兜底。
 * 插槽 sidebar.right.tab.menu.item（list，会话作用域）：宿主把插件项排在它唯一的「关闭」之后，owner props = { tab, dismiss }，
 * 标准 prop sessionId 是菜单所在会话。执行动作必须 dismiss（菜单是宿主的，只会因自己的动作关闭）。
 * 菜单容器的样式是宿主 CSS Module 的哈希类名，拿不到，所以按宿主 [data-dockkit-tab-menu] [role=menuitem] 的样式自写一份（tabs/styles.ts）。
 * 插槽总会渲染占位：没有任何可显示的项时返回 null，不渲染任何可见内容。
 */
import { useSyncExternalStore } from 'react'
import type { Translate } from '../context.js'
import { copyText } from '../sidebar/ContextMenu.js'
import { folderAction } from '../sidebar/folder-redirect.js'
import { revealParams } from '../sidebar/open-in-sidebar.js'
import { FILE_ADDRESS_PREFIX, displayPath, parseFileAddress, toLocalPosix, type RemoteIndex } from '../sidebar/remote-index.js'
import { mountedSession, openTabsOf, readLayout, type LayoutLike, type SidebarRightLike, type TabRecordLike } from './host-layout.js'
import { closeTargets, closeTargetsFlat, pinKey, pinnability, type CloseMode } from './pins.js'
import type { PinManager } from './pin-manager.js'

export interface MenuItem {
  id: string
  label?: string
  separator?: boolean
  disabled?: boolean
  title?: string
  run?: () => void
}

type FileIndex = Pick<RemoteIndex, 'resolveAddress' | 'resolveLocalAddress' | 'bySession' | 'sessionCwd'>

/** 文件类标签的「复制路径」与「在文件管理中显示」目标。 */
export interface FileTarget {
  /** 复制用路径（远程绝对路径 / 本机原生路径）。 */
  copy: string
  /** 在菜单所在会话的「文件管理」里定位；文件不在该会话工作区内 / 文件管理未开启时为 undefined。 */
  reveal?: { kind: string; params: Record<string, unknown> }
  /** 远程工作区会话里的文件：菜单不提供「在文件管理中显示」（用户要求去掉）。 */
  remote?: boolean
}

/**
 * 文件地址 → 复制路径与定位参数（与 open_in_sidebar 的文件夹定位同一套 folderAction / revealParams）。
 * 定位只在菜单所在会话的工作区内：远程要求同一远程工作区，本机要求在会话 cwd 内。
 * @param filesKind 文件管理的 kind（接管了宿主「文件」侧栏时是 files）；未注册时为 undefined。
 */
export function fileTargetOf(index: FileIndex, sessionId: string, contentId: string, filesKind: string | undefined, now: number): FileTarget | undefined {
  if (!contentId.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const revealOf = (root: string | undefined, path: string, local: boolean): FileTarget['reveal'] => {
    if (filesKind === undefined) return undefined
    const action = folderAction(root, path, local)
    return action.kind === 'reveal' && action.target !== undefined ? { kind: filesKind, params: revealParams(action.target, false, now) } : undefined
  }
  const remote = index.resolveAddress(contentId)
  if (remote !== undefined) {
    const ws = index.bySession(sessionId)
    const same = ws !== undefined && ws.hostId === remote.workspace.hostId && ws.remotePath === remote.workspace.remotePath
    const reveal = same ? revealOf(ws!.remotePath, remote.remotePath, false) : undefined
    return { copy: remote.remotePath, remote: true, ...(reveal !== undefined ? { reveal } : {}) }
  }
  const local = index.resolveLocalAddress(contentId)
  if (local !== undefined) {
    const cwd = index.bySession(sessionId) === undefined ? index.sessionCwd(sessionId) : undefined
    const reveal = cwd === undefined || cwd === '' ? undefined : revealOf(toLocalPosix(cwd), local.path, true)
    return { copy: displayPath(local.path), ...(reveal !== undefined ? { reveal } : {}) }
  }
  // 解析不了（会话 cwd 未知的相对路径等）：至少能复制地址里的路径。
  const parsed = parseFileAddress(contentId)
  return parsed === undefined || parsed.path === '' ? undefined : { copy: displayPath(parsed.path) }
}

export interface MenuDeps {
  t: Translate
  manager: PinManager
  right(): SidebarRightLike | undefined
  isMultiple(kind: string): boolean | undefined
  index: FileIndex
  filesKind(): string | undefined
  log(message: string, error?: unknown): void
}

/**
 * 菜单项（纯计算 + 动作闭包）。
 * - 能读到布局：关闭类只作用于该标签所在窗格、跳过固定标签，逐个 closeIn；
 * - 读不到布局（降级）：左 / 右无法计算 → 禁用；其他 / 全部按会话全体（公开 openTabs）计算，用 close 关（仅当前显示会话）；
 * - 固定需要布局（排序 / 关闭即取消固定都靠它），读不到时禁用。
 */
export function buildMenuItems(deps: MenuDeps, sessionId: string, tab: TabRecordLike): MenuItem[] {
  const { t, manager } = deps
  const right = deps.right()
  const layout: LayoutLike | undefined = readLayout(right, sessionId)
  const mounted = mountedSession(right)
  const closeOne: ((tabId: string) => void) | undefined =
    typeof right?.closeIn === 'function'
      ? (id) => right.closeIn!(sessionId, id)
      : typeof right?.close === 'function' && mounted === sessionId
        ? (id) => right.close!(id)
        : undefined
  const items: MenuItem[] = []

  if (closeOne !== undefined) {
    const pinned = layout !== undefined ? manager.pinnedIds(sessionId) : flatPinned(manager, sessionId, openTabsOf(right, sessionId))
    const flat = layout === undefined ? openTabsOf(right, sessionId) : []
    const closeItem = (id: string, mode: CloseMode): MenuItem => {
      const targets =
        layout !== undefined ? closeTargets(layout, tab.id, mode, pinned) : mode === 'others' || mode === 'all' ? closeTargetsFlat(flat, tab.id, mode, pinned) : undefined
      if (targets === undefined) return { id, label: t(`tabmenu.${id}`), disabled: true, title: t('tabmenu.hostUnsupported') }
      return {
        id,
        label: t(`tabmenu.${id}`),
        disabled: targets.length === 0,
        run: () => {
          for (const target of targets) {
            try {
              closeOne(target)
            } catch (error) {
              deps.log('关闭标签失败', error)
            }
          }
        }
      }
    }
    items.push(closeItem('closeLeft', 'left'), closeItem('closeRight', 'right'), closeItem('closeOthers', 'others'), closeItem('closeAll', 'all'))
  }

  const isPinned = manager.isPinned(sessionId, tab)
  if (isPinned) {
    items.push({ id: 'pin-sep', separator: true }, { id: 'unpin', label: t('tabmenu.unpin'), run: () => manager.unpin(sessionId, tab) })
  } else {
    const check = pinnability(tab, deps.isMultiple)
    const reason = !check.ok ? t(check.reason === 'multiple' ? 'tabmenu.pinMultiple' : 'tabmenu.pinUnsupported') : layout === undefined ? t('tabmenu.hostUnsupported') : undefined
    items.push(
      { id: 'pin-sep', separator: true },
      {
        id: 'pin',
        label: t('tabmenu.pin'),
        ...(reason !== undefined ? { disabled: true, title: reason } : {}),
        run: () => {
          if (!manager.pin(sessionId, tab)) deps.log('固定标签失败：读不到右侧栏布局')
        }
      }
    )
  }

  const file = fileTargetOf(deps.index, sessionId, tab.contentId, deps.filesKind(), Date.now())
  if (file !== undefined) {
    const reveal = file.reveal
    items.push(
      { id: 'file-sep', separator: true },
      { id: 'copyPath', label: t('tabmenu.copyPath'), run: () => void copyText(file.copy).catch((error: unknown) => deps.log('复制路径失败', error)) }
    )
    // 远程工作区会话不提供「在文件管理中显示」，只保留复制路径
    if (file.remote !== true) items.push(
      {
        id: 'reveal',
        label: t('tabmenu.reveal'),
        ...(reveal === undefined ? { disabled: true, title: t('tabmenu.revealUnavailable') } : {}),
        run: () => {
          if (reveal === undefined) return
          const options = { params: reveal.params, revealIfOpened: true }
          if (typeof right?.openTabIn === 'function') right.openTabIn(sessionId, reveal.kind, options)
          else right?.openTab?.(reveal.kind, options)
        }
      }
    )
  }
  // 组件会在最前面画一条分隔线（与宿主「关闭」隔开），这里去掉开头的组间分隔线，避免连着两条；
  // 只剩分隔线（没有任何可点项）时整体不显示。
  while (items[0]?.separator === true) items.shift()
  return items.some((i) => i.separator !== true) ? items : []
}

/** 宿主 contextMenus 服务的菜单动作（dsh-client-ui-context-menu，DSH 0.2.2 起）。 */
export interface HostMenuAction {
  id: string
  label: string
  disabled?: boolean
  separatorBefore?: boolean
  run?: () => void
}

/**
 * MenuItem[] → 宿主菜单动作：宿主用 primitives 的 Menu 统一渲染，样式与宿主项一致，不用再自绘 <button>。
 * 分隔线折叠为下一项的 separatorBefore；第一项也带分隔线，与宿主「关闭」组隔开。
 * 宿主动作没有 title（悬浮提示），禁用原因只能丢掉，禁用态本身仍保留。
 */
export function toHostActions(items: readonly MenuItem[], log: MenuDeps['log']): HostMenuAction[] {
  const actions: HostMenuAction[] = []
  let separate = true
  for (const item of items) {
    if (item.separator === true) {
      separate = true
      continue
    }
    const run = item.run
    actions.push({
      id: item.id,
      label: item.label ?? item.id,
      ...(item.disabled === true ? { disabled: true } : {}),
      ...(separate ? { separatorBefore: true } : {}),
      run: () => {
        // 宿主在动作抛错时只弹一个笼统的「失败」提示，这里先记下具体原因
        try {
          run?.()
        } catch (error) {
          log(`标签菜单「${item.label ?? item.id}」执行失败`, error)
        }
      }
    })
    separate = false
  }
  return actions
}

/** 降级：没有布局时按 (kind, contentId) 匹配固定项。 */
function flatPinned(manager: PinManager, sessionId: string, tabs: readonly TabRecordLike[]): Set<string> {
  const keys = new Set(manager.pins(sessionId).map(pinKey))
  return new Set(tabs.filter((t) => keys.has(pinKey(t))).map((t) => t.id))
}

export interface TabMenuItemsProps {
  tab?: TabRecordLike
  dismiss?: () => void
  sessionId?: string
  deps?: MenuDeps
}

/** 插槽组件：宿主「关闭」之后，以分隔线开头。 */
export function TabMenuItems(props: TabMenuItemsProps) {
  const deps = props.deps
  const noop = (): (() => void) => () => undefined
  useSyncExternalStore(deps?.manager.subscribe ?? noop, deps?.manager.version ?? (() => 0))
  const { tab, sessionId } = props
  if (deps === undefined || tab === undefined || sessionId === undefined || typeof tab.id !== 'string') return null
  let items: MenuItem[]
  try {
    items = buildMenuItems(deps, sessionId, tab)
  } catch (error) {
    deps.log('生成标签菜单失败', error)
    return null
  }
  if (items.length === 0) return null
  const dismiss = (): void => {
    try {
      props.dismiss?.()
    } catch {
      /* 菜单已卸载 */
    }
  }
  return (
    <>
      <div role="separator" className="dshws-tabmenu-sep" />
      {items.map((item) =>
        item.separator === true ? (
          <div key={item.id} role="separator" className="dshws-tabmenu-sep" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="dshws-tabmenu-item"
            data-dshws-tabmenu={item.id}
            aria-disabled={item.disabled === true ? true : undefined}
            title={item.title}
            onClick={() => {
              if (item.disabled === true) return
              dismiss()
              try {
                item.run?.()
              } catch (error) {
                deps.log(`标签菜单「${item.label ?? item.id}」执行失败`, error)
              }
            }}
          >
            {item.label}
          </button>
        )
      )}
    </>
  )
}
