/*
 * @Description: H5 抽屉 —— 面板公共 props（各面板懒加载分片共享的类型）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:45:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/panel.ts
 */
import type { SheetState } from './store.js'

export interface PanelProps {
  sessionId: string
  /** 抽屉当前状态（含 openSheet 带来的 path / line / url 与 seq）。 */
  state: SheetState
  /** 本面板是否为当前 tab 且抽屉打开（终端据此重新适配尺寸）。 */
  active: boolean
}
