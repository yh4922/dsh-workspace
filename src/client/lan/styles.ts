/*
 * @Description: 「远程访问」页签与 H5 外壳样式
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/client/lan/styles.ts
 *
 * H5 规则全部挂在 html[data-dshws-h5] 下：只有经局域网代理 + 窄屏时外壳才写这个属性，本机桌面零影响。
 * 宿主各包的类名是构建哈希，跨版本可能变，选择器只用 data-* 属性与结构（:has(> [data-rightbar-col]) 定位 AppFrame）。
 */

export const LAN_CSS = `
.dshws-lan-loading { padding: 24px; color: var(--dsw-alias-label-tertiary); }
.dshws-lan-state { display: inline-block; margin-left: 8px; padding: 0 8px; border-radius: 9px; font-size: 11.5px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dshws-lan-state[data-state="running"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.dshws-lan-state[data-state="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dshws-lan-addr { display: flex; gap: 20px; align-items: flex-start; padding: 12px 0 14px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshws-lan-urls { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.dshws-lan-url { display: flex; align-items: center; gap: 10px; }
.dshws-lan-url-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border: 1px solid transparent; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: 12.5px var(--ds-font-family-code); cursor: pointer; text-align: left; }
.dshws-lan-url[data-active="true"] .dshws-lan-url-text { border-color: var(--dsw-alias-state-business-primary); }
.dshws-lan-qrbox { flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dshws-lan-qr { border-radius: 8px; }
.dshws-lan-field { width: 200px; }
.dshws-lan-field[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dshws-lan-num { width: 80px; }
.dshws-lan-actions { display: flex; justify-content: flex-end; padding: 4px 0 10px; }
.dshws-lan-pw { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dshws-lan-pw-code { font: 600 18px var(--ds-font-family-code); letter-spacing: .12em; color: var(--dsw-alias-label-primary); }
.dshws-lan-ip { margin-left: 6px; font: 12px var(--ds-font-family-code); color: var(--dsw-alias-label-tertiary); }
.dshws-lan-empty { padding: 10px 0 12px; }
@media (max-width: 640px) {
  .dshws-lan .dshws-set-row { flex-wrap: wrap; gap: 10px; }
  .dshws-lan .dshws-set-control { width: 100%; justify-content: flex-start; }
  .dshws-lan-field { width: 100%; }
  .dshws-lan-addr { flex-direction: column; }
  .dshws-lan-qrbox { align-self: center; }
}
`

export const H5_CSS = `
/* ---------- H5：改造宿主外壳 ---------- */
/* 主区放进第 1 列、左栏移出布局。与 dsh-pocket（另一个手机适配插件）的网格写法一致：
 * 它会把主区强制放进第 1 列（grid-column: 1 !important），若这里把第 1 列设成 0 宽，主区就被压没 —— 会话页一片空白。 */
html[data-dshws-h5] div:has(> [data-rightbar-col]) { grid-template-columns: minmax(0, 1fr) 0 0 !important; }
html[data-dshws-h5] div:has(> [data-rightbar-col]) > :first-child { display: none !important; }
html[data-dshws-h5] div:has(> [data-rightbar-col]) > :nth-child(2) { grid-column: 1 !important; grid-row: 1 !important; min-width: 0 !important; }
html[data-dshws-h5] div:has(> [data-rightbar-col]) > [data-side="sidebar"] { display: none !important; }
/* dsh-pocket 的左上角悬浮按钮 / 遮罩 / 会话头「目录」按钮都是打开左侧抽屉用的，H5 外壳下左栏已由工作区 / 会话列表替代，点了只会弹键盘没反应：让位隐藏。 */
html[data-dshws-h5] [data-mobile-nav="fab"],
html[data-dshws-h5] [data-mobile-nav="backdrop"],
html[data-dshws-h5] [data-mobile-nav="toggle"] { display: none !important; }
html[data-dshws-h5] [data-conversation-tabs] { display: none !important; }
/* 状态栏 / 刘海让位（与 dsh-pocket 一致；没装 pocket 时也需要）。 */
html[data-dshws-h5] div:has(> [data-rightbar-col]) { padding-top: env(safe-area-inset-top, 0px) !important; }
/* 会话页：宿主会话头整个隐藏（只限主区，右栏里的侧边对话不受影响），主区下移让出自建 AppBar 的高度。 */
html[data-dshws-h5="session"] div:has(> [data-rightbar-col]) > :nth-child(2) header:has([data-conversation-header-leading]) { display: none !important; }
html[data-dshws-h5="session"] div:has(> [data-rightbar-col]) > :nth-child(2) { padding-top: 48px !important; box-sizing: border-box !important; }

/* ---------- H5：切页滑动动画 ---------- */
@keyframes dshws-h5-in-right { from { transform: translateX(100%); } to { transform: none; } }
@keyframes dshws-h5-in-left { from { transform: translateX(-30%); opacity: .6; } to { transform: none; opacity: 1; } }
.dshws-h5-page[data-anim="forward"], .dshws-h5-appbar[data-anim="forward"] { animation: dshws-h5-in-right .28s cubic-bezier(.2, .8, .2, 1); }
.dshws-h5-page[data-anim="back"], .dshws-h5-appbar[data-anim="back"] { animation: dshws-h5-in-left .28s cubic-bezier(.2, .8, .2, 1); }
/* 进入会话：宿主会话主区与 AppBar 一起从右侧滑入（属性从 sessions 变成 session 时选择器开始命中，动画即播放一次）。 */
html[data-dshws-h5="session"] div:has(> [data-rightbar-col]) > :nth-child(2) { animation: dshws-h5-in-right .28s cubic-bezier(.2, .8, .2, 1); }
@media (prefers-reduced-motion: reduce) {
  .dshws-h5-page, .dshws-h5-appbar, html[data-dshws-h5="session"] div:has(> [data-rightbar-col]) > :nth-child(2) { animation: none !important; }
}

/* ---------- H5：一、二级页面 ---------- */
/* 宿主没有全局 border-box：width:100% + padding 的列表行会比屏幕宽，右侧时间被裁掉。 */
.dshws-h5-page, .dshws-h5-page *, .dshws-h5-page *::before, .dshws-h5-page *::after,
.dshws-h5-appbar, .dshws-h5-appbar * { box-sizing: border-box; }
.dshws-h5-page {
  position: absolute; inset: 0; z-index: 1; pointer-events: auto; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary);
  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);
  -webkit-tap-highlight-color: transparent;
}
.dshws-h5-top { flex-shrink: 0; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 48px; padding: 0 6px;
  border-bottom: .5px solid var(--dsw-alias-border-l2); }
.dshws-h5-top-title { font-size: 17px; font-weight: 600; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.dshws-h5-top-side { display: flex; align-items: center; min-width: 0; }
.dshws-h5-top-side[data-end="true"] { justify-content: flex-end; }
.dshws-h5-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 0; border-radius: 10px;
  background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dshws-h5-icon-btn:active { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-h5-icon-btn:disabled { opacity: .4; }
.dshws-h5-text-btn { height: 36px; padding: 0 10px; border: 0; background: transparent; color: var(--dsw-alias-state-business-primary); font-size: 14px; }
.dshws-h5-search { flex-shrink: 0; display: flex; align-items: center; gap: 8px; margin: 10px 12px; padding: 0 12px; height: 36px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); }
.dshws-h5-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font-size: 15px; }
.dshws-h5-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.dshws-h5-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px; border: 0; background: transparent; color: inherit;
  text-align: left; font: inherit; cursor: pointer; position: relative; }
.dshws-h5-row::after { content: ''; position: absolute; left: 70px; right: 0; bottom: 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
/* 会话列表行：比工作区行（有 44px 头像撑高）矮一截，单独加大触控区与字号，避免挤成一条。 */
.dshws-h5-row[data-static="true"] { min-height: 64px; padding: 14px 16px 14px 18px; gap: 14px; }
.dshws-h5-row[data-static="true"] .dshws-h5-row-main { gap: 5px; }
.dshws-h5-row[data-static="true"] .dshws-h5-row-title { font-size: 16.5px; line-height: 1.35; }
.dshws-h5-row[data-static="true"] .dshws-h5-row-time { font-size: 12.5px; }
.dshws-h5-row[data-static="true"] .dshws-h5-row-sub { font-size: 13px; }
.dshws-h5-row[data-static="true"]::after { left: 42px; }
.dshws-h5-row:active { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-h5-avatar { flex-shrink: 0; width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 600; color: #fff; background: hsl(var(--h5-hue) 55% 52%); }
.dshws-h5-avatar[data-remote="true"] { border-radius: 50%; }
.dshws-h5-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dshws-h5-row-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshws-h5-row-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 500; }
.dshws-h5-row-time { margin-left: auto; flex-shrink: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dshws-h5-row-sub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; color: var(--dsw-alias-label-tertiary); }
.dshws-h5-running { color: var(--dsw-alias-state-success-primary); }
.dshws-h5-tag { flex-shrink: 0; padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); }
.dshws-h5-tag[data-remote="true"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.dshws-h5-badge { flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center;
  color: #fff; background: var(--dsw-alias-state-success-primary); }
.dshws-h5-dot { flex-shrink: 0; width: 10px; height: 10px; border-radius: 50%; background: var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); }
.dshws-h5-dot[data-running="true"] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 25%, transparent); }
.dshws-h5-empty { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 56px 24px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 14px; }
.dshws-h5-primary { height: 40px; padding: 0 22px; border: 0; border-radius: 10px; background: var(--dsw-alias-state-business-primary); color: #fff; font-size: 15px; font-weight: 600; }
.dshws-h5-swipe { position: relative; overflow: hidden; }
.dshws-h5-swipe-actions { position: absolute; top: 0; right: 0; bottom: 0; display: flex; }
.dshws-h5-swipe-actions > button { flex: 1; border: 0; color: #fff; font-size: 14px; background: var(--dsw-static-neutral-500, #7f8287); }
.dshws-h5-swipe-actions > button[data-tone="danger"] { background: var(--dsw-alias-state-error-primary, #e5484d); }
.dshws-h5-swipe-body { position: relative; background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); transition: transform .2s ease; touch-action: pan-y; }
.dshws-h5-toast { position: absolute; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); max-width: 86vw; padding: 8px 14px;
  border-radius: 10px; font-size: 13px; color: #fff; background: rgba(0, 0, 0, .78); }
.dshws-h5-switch { position: absolute; right: 12px; bottom: calc(84px + env(safe-area-inset-bottom)); pointer-events: auto; height: 34px; padding: 0 14px; border: 0;
  border-radius: 17px; font-size: 13px; color: #fff; background: var(--dsw-alias-state-business-primary); box-shadow: 0 4px 14px rgba(0, 0, 0, .18); }

/* ---------- H5：会话页自建 AppBar ---------- */
.dshws-h5-appbar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 1; pointer-events: auto;
  display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; align-items: center;
  height: calc(48px + env(safe-area-inset-top, 0px)); padding: env(safe-area-inset-top, 0px) 2px 0;
  background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary);
  border-bottom: .5px solid var(--dsw-alias-border-l2); -webkit-tap-highlight-color: transparent;
}
.dshws-h5-appbar-title { min-width: 0; display: flex; flex-direction: column; align-items: center; line-height: 1.25; }
.dshws-h5-appbar-main { max-width: 100%; display: inline-flex; align-items: center; gap: 6px; }
.dshws-h5-appbar-main .dshws-h5-dot { width: 8px; height: 8px; }
.dshws-h5-appbar-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; }
.dshws-h5-appbar-sub { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
`
