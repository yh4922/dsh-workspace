/*
 * @Description: 「标签右键菜单增强与固定」的接入 —— 受偏好 tabEnhance 控制：开 = 注册菜单项 + 启动固定标签运行时，关 = 全部撤销
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/register.ts
 *
 * 等 sidebarRight 服务出现再启动（宿主先声明插槽、后提供服务）；服务重建时随子作用域撤下并重挂。
 * 菜单项优先注册到宿主 contextMenus 服务（0.2.2+，由宿主 Menu 渲染）；没有该服务的旧宿主才用 sidebar.right.tab.menu.item 插槽自绘。
 * 宿主会吞掉插槽注册回调里的异常（只表现成「菜单项静默不出现」），所以注册逐层 try/catch，并在注册后自检条目是否真的进了插槽。
 * 关闭开关时：撤销菜单注册、移除隐藏关闭按钮的 CSS、停止补开 / 排序；固定记录保留在 localStorage，重新打开后继续生效。
 */
import type { ClientContext, Translate } from '../context.js'
import type { SlotsPeek } from '../workspace/bridge-compat.js'
import { getSidebarPrefs, subscribeSidebarPrefs } from '../sidebar-prefs.js'
import type { SidebarRightLike } from './host-layout.js'
import { createPinManager } from './pin-manager.js'
import { TabMenuItems, buildMenuItems, toHostActions, type HostMenuAction, type MenuDeps } from './menu.js'
import type { StorageLike } from './pins.js'
import type { TabRecordLike } from './host-layout.js'

/** 宿主 contextMenus 服务里本插件用到的部分（sidebar-right 的 tab target 值为 { sessionId, paneId, tab }）。 */
interface ContextMenusLike {
  register?(input: {
    id: string
    target: string
    order: number
    resolve(target: { sessionId?: string; paneId?: string; tab?: TabRecordLike } | undefined): HostMenuAction[]
  }): () => void
}

export const TAB_MENU_SLOT = 'sidebar.right.tab.menu.item'
export const TAB_MENU_ID = 'dshws-tab-enhance'

export interface TabEnhanceDeps {
  t: Translate
  index: MenuDeps['index']
  /** 文件管理的 kind；未注册（偏好关闭）时 undefined。 */
  filesKind(): string | undefined
}

type InjectableCtx = ClientContext & {
  inject?(
    deps: string[],
    cb: (sub: { get(name: string): unknown; effect(f: () => () => void, label?: string): unknown }) => void
  ): { dispose(): void } | (() => void)
}

function localStore(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** 启用一次：固定运行时 + 菜单注册。返回撤销函数。 */
function enable(ctx: ClientContext, get: (name: string) => unknown, deps: TabEnhanceDeps, log: (m: string, e?: unknown) => void): () => void {
  const right = (): SidebarRightLike | undefined => get('sidebarRight') as SidebarRightLike | undefined
  const isMultiple = (kind: string): boolean | undefined => {
    try {
      const def = (get('sidebarRightTabs') as { get?: (k: string) => { multiple?: boolean } | undefined } | undefined)?.get?.(kind)
      return def === undefined ? undefined : def.multiple === true
    } catch {
      return undefined
    }
  }
  const manager = createPinManager({ right, isMultiple, storage: localStore, log })
  const menuDeps: MenuDeps = { t: deps.t, manager, right, isMultiple, index: deps.index, filesKind: deps.filesKind, log }

  let offSlot: () => void = () => undefined
  // 新宿主（0.2.2+）：通过 contextMenus 声明动作，由宿主 Menu 渲染，样式与「关闭」等宿主项一致；
  // 此时不能再注册插槽组件，否则同一批项会以无样式的原生按钮再出现一遍。
  const menus = get('contextMenus') as ContextMenusLike | undefined
  if (typeof menus?.register === 'function') {
    try {
      offSlot = menus.register({
        id: TAB_MENU_ID,
        target: 'tab',
        order: 200,
        resolve: (target) => {
          const { sessionId, tab } = target ?? {}
          if (typeof sessionId !== 'string' || tab === undefined || typeof tab.id !== 'string') return []
          try {
            return toHostActions(buildMenuItems(menuDeps, sessionId, tab), log)
          } catch (error) {
            log('生成标签菜单失败', error)
            return []
          }
        }
      })
    } catch (error) {
      log('注册标签右键菜单动作失败', error)
    }
  } else try {
    offSlot = ctx.slots.inject(TAB_MENU_SLOT, () => {
      try {
        const off = ctx.slots.register(
          { name: TAB_MENU_SLOT, id: TAB_MENU_ID, order: 100, inject: () => ({ deps: menuDeps }) },
          TabMenuItems as never
        )
        // 自检：宿主吞异常 / 插槽语义变化时条目可能没进去，至少在控制台留下线索。
        const entries = (ctx.slots as unknown as SlotsPeek).entries?.(TAB_MENU_SLOT)
        if (entries !== undefined && !entries.some((e) => e.component === TabMenuItems)) log('标签右键菜单项注册后未出现在插槽中')
        return off
      } catch (error) {
        log('注册标签右键菜单项失败', error)
        return () => undefined
      }
    })
  } catch (error) {
    log('注入标签右键菜单插槽失败', error)
  }
  return () => {
    try {
      offSlot()
    } catch (error) {
      log('撤销标签右键菜单项失败', error)
    }
    manager.dispose()
  }
}

export function registerTabEnhance(ctx: ClientContext, deps: TabEnhanceDeps, log: (m: string, e?: unknown) => void): () => void {
  const c = ctx as InjectableCtx
  const mount = (get: (name: string) => unknown): (() => void) => {
    let off: (() => void) | undefined
    const sync = (): void => {
      const on = getSidebarPrefs().tabEnhance
      if (on && off === undefined) {
        try {
          off = enable(ctx, get, deps, log)
        } catch (error) {
          log('启用标签右键菜单增强失败', error)
        }
      } else if (!on && off !== undefined) {
        const dispose = off
        off = undefined
        dispose()
      }
    }
    sync()
    const unsubscribe = subscribeSidebarPrefs(sync)
    return () => {
      unsubscribe()
      off?.()
      off = undefined
    }
  }
  const safeGet = (name: string): unknown => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  if (typeof c.inject !== 'function') return mount(safeGet)
  const fiber = c.inject(['sidebarRight'], (sub) => {
    sub.effect(() => mount(safeGet), 'dsh-workspace: tab enhance')
  })
  return () => {
    if (typeof fiber === 'function') fiber()
    else fiber.dispose()
  }
}
