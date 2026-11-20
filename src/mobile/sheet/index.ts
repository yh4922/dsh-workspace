/*
 * @Description: H5 —— 底部抽屉（文件 / Git / SSH / 上下文 / 浏览器面板）对外入口，P4 实现
 * @Author: YangHeng
 * @Date: 2026-11-19 15:22:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/index.ts
 *
 * 各面板体积大（复用 sidebar / terminal），由 SheetHost 以 React.lazy + import() 懒加载，不进首屏入口分片。
 * 会话页只需：<SheetHost sessionId={id} /> 常驻渲染；任意处调用 openSheet({tab, path?, line?, url?}) / closeSheet()。
 */
export type { SheetTab, OpenSheetOptions } from './store.js'
export { openSheet, closeSheet } from './store.js'
export { SheetHost } from './SheetHost.js'
/** 会话页 / 首页已知会话 cwd 时可预先填入，文件面板打开时就不必再拉 session/list。 */
export { primeSessionCwd } from './cwd.js'
