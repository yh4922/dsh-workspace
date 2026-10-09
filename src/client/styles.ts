/*
 * @Description: 页面样式 —— 全部取宿主 --dsw- 主题变量，随明暗主题切换
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/styles.ts
 *
 * 以字符串形式注入 <style>，而不是依赖打包器的 CSS 处理：
 * 浏览器 bundle 被包在 __ModuleLoader__ 里，CSS 抽取产物无处挂载。
 * 所有类名带 dshws- 前缀，避免与宿主或其他插件冲突。
 */
import { XTERM_CSS } from './terminal/xterm-css.generated.js'

export const STYLE_ID = 'dsh-workspace-styles'

export const CSS = `
.dshws-page {
  height: 100%;
  display: flex; flex-direction: column;
  overflow: hidden;
  padding: 16px 32px 12px;
  box-sizing: border-box;
  width: 100%; max-width: 100%; min-width: 0;
  /* 窄屏的文件预览浮层以本页为定位上下文（absolute），这样不会盖住宿主网页版的头部 */
  position: relative;
  /* 宽度只由外层决定、不由内容撑开：宿主外层若是 grid / min-width:auto 的容器，
     文件 / 终端 / 日志页里的宽内容会把整页撑宽，右上角开关就被推出可视区 */
  contain: inline-size;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
/* min-width: 0：子项不许按内容最小宽度撑宽页面（曾把右上角的开关挤出屏幕） */
.dshws-page > * { flex-shrink: 0; min-width: 0; }
.dshws-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dshws-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 32px; }
.dshws-fill { flex: 1 1 auto; min-height: 0; flex-direction: column; }

/* 分区标签 */
.dshws-sections {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
/* 只匹配分区标签本身：宿主 Switch 也是 button，放进标签栏会被这套样式撑变形（曾导致右上角开关被挤出屏幕） */
.dshws-sections > button[role="tab"] {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; margin-bottom: -1px; cursor: pointer;
  background: none; border: 0; border-bottom: 2px solid transparent;
  color: var(--dsw-alias-label-secondary); font-size: 14px;
}
.dshws-sections > button[role="tab"]:hover { color: var(--dsw-alias-label-primary); }
.dshws-sections > button[role="tab"][data-active="true"] {
  color: var(--dsw-alias-label-primary); font-weight: 500;
  border-bottom-color: var(--dsw-alias-brand-primary);
}
.dshws-count {
  min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
  border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
}

/* 终端区域 */
.dshws-terms { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dshws-tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; flex-shrink: 0; padding: 0 0 8px; scrollbar-width: thin; }
.dshws-tab {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
  max-width: 240px; height: 30px; box-sizing: border-box; padding: 0 4px 0 10px; cursor: pointer; user-select: none;
  border: 1px solid transparent; border-radius: 8px; font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
}
.dshws-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-tab[data-active="true"] {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 500;
  border-color: var(--dsw-alias-border-l2); box-shadow: 0 1px 2px rgba(0, 0, 0, .04);
}
.dshws-tab[data-exited="true"] .dshws-tab-title { color: var(--dsw-alias-label-tertiary); }
.dshws-tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-tab-btn {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 20px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));
}
.dshws-tab:hover .dshws-tab-btn, .dshws-tab[data-active="true"] .dshws-tab-btn { color: var(--dsw-alias-label-tertiary); }
.dshws-tab-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-tab-pin { font-size: 8px; color: var(--dsw-alias-state-business-primary); }
.dshws-tab-new { border: 0; font-size: 14px; height: 30px; padding: 0 10px; border-radius: 8px; }
.dshws-tab-new:disabled { cursor: default; opacity: .7; }

/* 页内对话框 */
.dshws-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
/* 宽度跟随宿主 Modal 内容区：写死 min-width 会把输入框撑出弹窗 */
.dshws-dialog-form { display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; box-sizing: border-box; }
.dshws-dialog-message { white-space: pre-wrap; line-height: 1.6; word-break: break-all; }

/* 右侧栏远程标签：占满宿主给的高度，编辑器 / 终端 / 预览自己滚动 */
.dshws-side { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0; }
.dshws-side-note { padding: 16px; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.dshws-side-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dshws-side-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-shrink: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-side-title { flex: 1; min-width: 0; font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-side-path { flex-shrink: 0; padding: 2px 10px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-side-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; overflow: hidden; }
.dshws-side-seg button { border: 0; background: transparent; padding: 2px 8px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.dshws-side-seg button[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* 单个开关按钮（展开全部 / 缩略图）：外观与分段按钮一致，按下态高亮 */
.dshws-side-toggle, .dshws-code-toggle {
  flex-shrink: 0; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: transparent;
  padding: 2px 8px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dshws-side-toggle[data-active="true"], .dshws-code-toggle[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-code-toggle { padding: 0 6px; font-size: 11px; border-radius: 4px; }
.dshws-side-banner { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
.dshws-side-frame { flex: 1 1 auto; min-height: 0; width: 100%; border: 0; background: #fff; }
.dshws-side-image { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; align-items: flex-start; justify-content: center; padding: 12px; }
.dshws-side-image img { max-width: 100%; }
.dshws-side-tree { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0; }
.dshws-side-row {
  display: flex; align-items: center; gap: 4px; width: 100%; border: 0; background: transparent; cursor: pointer;
  padding-top: 3px; padding-bottom: 3px; padding-right: 8px; font-size: 13px; text-align: left; color: var(--dsw-alias-label-primary);
}
.dshws-side-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-side-row[data-ignored="true"] { color: var(--dsw-alias-label-tertiary); }
.dshws-side-caret { width: 12px; flex-shrink: 0; color: var(--dsw-alias-label-tertiary); }
.dshws-side-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-side-term { position: relative; }
.dshws-side-term .dshws-term { flex: 1 1 auto; min-height: 0; }

/* 会话顶部标签的内容区：占满宿主给的区域 */
.dshws-conv-view { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0; }

/* 自适应分栏：宽时左列表（固定宽，可滚动）右内容；窄时只显示其一 */
.dshws-split { display: flex; flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0; }
/* 两列各自滚动：列不溢出，滚动只发生在列内的列表 / 编辑器里 */
.dshws-split-list, .dshws-split-detail { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
/* 虚拟滚动的行：高度由 VirtualList 固定，内容不得撑高 */
.dshws-vrow { overflow: hidden; box-sizing: border-box; }
.dshws-vrow[data-sticky="true"] { position: sticky; top: -4px; z-index: 2; background: var(--dsw-alias-bg-layer-1); }
.dshws-vrow > .dshws-tree-note { padding-top: 0; padding-bottom: 0; line-height: 32px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshws-vrow > .dshws-rename { padding-top: 0; padding-bottom: 0; }
.dshws-vrow > .dshws-git-section-head { position: static; }
.dshws-split[data-wide="false"] > div { flex: 1 1 auto; }
/* 宽屏：列表宽度由 Split 按拖动结果内联给出（flex-basis），这里是未量到宽度前的兜底 */
.dshws-split[data-wide="true"] > .dshws-split-list { flex: 0 0 clamp(300px, 40%, 520px); min-width: 240px; }
/* 分隔条：6px 可拖区域，中间 1px 线；悬停 / 拖动 / 键盘聚焦时加粗高亮 */
.dshws-split-handle { position: relative; flex: 0 0 6px; margin: 0 -3px; z-index: 2; cursor: col-resize; touch-action: none; outline: none; }
.dshws-split-handle::after { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-50%);
  background: var(--dsw-alias-border-l2); transition: width .12s, background-color .12s; }
.dshws-split-handle:hover::after, .dshws-split-handle:focus-visible::after, .dshws-split[data-dragging="true"] > .dshws-split-handle::after {
  width: 3px; background: var(--dsw-alias-state-business-primary); }
/* 拖动时：禁止选中文字，右侧（编辑器 / iframe 预览）不吃指针事件，光标保持为调整宽度 */
.dshws-split[data-dragging="true"] { cursor: col-resize; user-select: none; }
.dshws-split[data-dragging="true"] > .dshws-split-detail { pointer-events: none; }
.dshws-split[data-wide="true"] > .dshws-split-detail { flex: 1 1 auto; }
.dshws-split-empty { margin: auto; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.dshws-side-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-hover); }

/* 远程 Git 面板 */
.dshws-diff-host { flex: 1 1 auto; min-height: 0; }
.dshws-git-ab { color: var(--dsw-alias-label-tertiary); font-weight: 400; font-size: 12px; }
.dshws-git-tabs { display: flex; gap: 2px; padding: 4px 8px 0; flex-shrink: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-git-tabs button {
  border: 0; background: transparent; padding: 5px 10px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary);
  border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 4px;
}
.dshws-git-tabs button[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.dshws-git-section { padding: 4px 0; }
.dshws-git-section-head {
  display: flex; align-items: center; justify-content: space-between; padding: 4px 10px;
  font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}
.dshws-git-row { display: flex; align-items: center; min-width: 0; }
.dshws-git-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-git-row .dshws-git-actions { display: none; gap: 2px; padding-right: 6px; }
.dshws-git-row:hover .dshws-git-actions { display: inline-flex; }
.dshws-git-confirm { display: inline-flex; align-items: center; gap: 4px; padding-right: 6px; font-size: 11px; color: var(--dsw-alias-state-warn-primary); white-space: nowrap; }
.dshws-link-btn[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); }
.dshws-git-file {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 3px 10px; border: 0; background: transparent;
  cursor: pointer; font-size: 13px; text-align: left; color: var(--dsw-alias-label-primary);
}
.dshws-git-commit-files .dshws-git-file:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-git-status { width: 14px; flex-shrink: 0; font-family: ui-monospace, Consolas, monospace; font-size: 11px; font-weight: 700; text-align: center; }
.dshws-git-status[data-s="M"] { color: #d29922; }
.dshws-git-status[data-s="A"], .dshws-git-status[data-s="U"], .dshws-git-status[data-s="?"] { color: #3fb950; }
.dshws-git-status[data-s="D"] { color: #f85149; }
.dshws-git-status[data-s="R"], .dshws-git-status[data-s="C"] { color: #58a6ff; }
.dshws-git-dir { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-git-commit { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; }
.dshws-git-commit .dshws-textarea { resize: vertical; font-size: 12px; }
.dshws-git-commit-btn {
  height: 28px; border: 0; border-radius: 6px; cursor: pointer; font-size: 12px;
  background: var(--dsw-alias-brand-primary); color: #fff;
}
.dshws-git-commit-btn:disabled { opacity: .45; cursor: default; }
.dshws-git-newbranch { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
.dshws-git-newbranch .dshws-input { flex: 1; min-width: 0; height: 28px; font-size: 12px; }
.dshws-git-branch {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 10px; border: 0; background: transparent;
  cursor: pointer; font-size: 13px; text-align: left; color: var(--dsw-alias-label-primary);
}
.dshws-git-branch:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-git-branch[data-head="true"] { font-weight: 600; cursor: default; }
.dshws-git-branch-mark { width: 10px; color: var(--dsw-alias-brand-primary); }
.dshws-git-branch .dshws-git-dir { margin-left: auto; }
.dshws-git-commit-row {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 8px 0 4px; border: 0; background: transparent;
  cursor: pointer; text-align: left; color: var(--dsw-alias-label-primary); font-size: 12px;
}
.dshws-git-commit-row:hover, .dshws-git-commit-row[data-open="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-git-graph { flex-shrink: 0; display: block; }
.dshws-git-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-git-meta { flex-shrink: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-git-ref { display: inline-block; margin-right: 4px; padding: 0 5px; border-radius: 8px; font-size: 10px; line-height: 16px; border: 1px solid var(--dsw-alias-border-l3); }
.dshws-git-ref[data-kind="head"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dshws-git-ref[data-kind="remote"] { color: var(--dsw-alias-label-tertiary); }
.dshws-git-ref[data-kind="tag"] { color: #d29922; border-color: #d29922; }
.dshws-git-commit-files { padding: 4px 0 6px 24px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-git-commit-files > .dshws-git-dir { padding: 2px 10px; }
.dshws-git-more { display: block; margin: 8px auto; }

/* ---------------------------------------------------------------- 远程文件 / 远程 Git 视觉统一
 * 行高 26px、图标 16px、间距 6px；颜色全部取 DSH 设计变量，深浅主题自动跟随。
 * 强调色用 state-business-primary（DSH 的蓝色强调），主按钮用 button-primary-fill（brand-primary 在 DSH 里是灰色）。 */
.dshws-ico { flex-shrink: 0; display: block; }
.dshws-chevron { color: var(--dsw-alias-label-tertiary); transition: transform .12s ease; }
.dshws-chevron.is-open { transform: rotate(90deg); }
.dshws-ico-folder { color: #e0a53c; }
.dshws-file-ico { display: inline-flex; flex-shrink: 0; color: var(--dsw-alias-label-tertiary); }

.dshws-toolbar {
  display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 6px 0 10px; flex-shrink: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
}
.dshws-toolbar-title {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshws-subbar {
  flex-shrink: 0; padding: 5px 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshws-ibtn {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex-shrink: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dshws-ibtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-ibtn[data-active="true"] { color: var(--dsw-alias-state-business-primary); }
.dshws-ibtn[data-tone="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dshws-ibtn:disabled { opacity: .4; cursor: default; }

/* 树 / 列表行 */
.dshws-row {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding-right: 10px;
  border: 0; background: transparent; cursor: pointer; text-align: left; font-size: 13px; color: var(--dsw-alias-label-primary);
}
.dshws-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-active); box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary); }
.dshws-row[data-ignored="true"] .dshws-row-name, .dshws-row[data-hidden="true"] .dshws-row-name { color: var(--dsw-alias-label-tertiary); }
.dshws-row:disabled { cursor: default; }
.dshws-row-caret { display: inline-flex; width: 12px; flex-shrink: 0; }
.dshws-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-row-dim { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-side-tree { padding: 4px 0 12px; }

/* 注意不能叫 .dshws-empty：主页面已有同名类（带虚线框），会串样式。 */
.dshws-emptystate {
  display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 16px;
  font-size: 12px; color: var(--dsw-alias-label-tertiary); text-align: center;
}
.dshws-emptystate .dshws-ico { color: var(--dsw-alias-label-dimmed); }
.dshws-preview > .dshws-emptystate { margin: auto; max-width: 320px; line-height: 1.6; }
.dshws-tree-icon { display: inline-flex; align-items: center; justify-content: center; }
.dshws-split-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; }

/* 徽标 */
.dshws-pill {
  display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; flex-shrink: 0;
  font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
}
.dshws-pill[data-tone="accent"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.dshws-st {
  display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex-shrink: 0;
  border-radius: 4px; font: 700 10px/1 ui-monospace, Consolas, monospace;
  color: var(--st); background: color-mix(in srgb, var(--st) 14%, transparent);
  --st: var(--dsw-alias-label-tertiary);
}
.dshws-st[data-s="M"] { --st: #d08a00; }
.dshws-st[data-s="A"], .dshws-st[data-s="U"] { --st: #16a34a; }
.dshws-st[data-s="D"] { --st: #e5484d; }
.dshws-st[data-s="R"], .dshws-st[data-s="C"] { --st: #3b82f6; }
.dshws-side-name[data-deleted="true"] { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }

/* Git：页签、区段、文件行 */
.dshws-git-ab { display: inline-flex; gap: 4px; }
.dshws-git-ab > span {
  padding: 0 6px; height: 18px; line-height: 18px; border-radius: 9px; font-size: 11px; font-weight: 500;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3);
}
.dshws-git-tabs { gap: 4px; padding: 0 8px; }
.dshws-git-tabs button { height: 34px; padding: 0 10px; font-size: 12.5px; border-bottom-width: 2px; }
.dshws-git-tabs button[data-active="true"] { font-weight: 600; border-bottom-color: var(--dsw-alias-state-business-primary); }
.dshws-git-tabs .dshws-count {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 16px; text-align: center;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3);
}
.dshws-git-section { padding: 2px 0 6px; }
.dshws-git-section-head {
  position: sticky; top: 0; z-index: 1; height: 28px; padding: 0 10px; background: var(--dsw-alias-bg-layer-1);
  font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: none; color: var(--dsw-alias-label-tertiary);
}
.dshws-git-row { border-radius: 0; }
.dshws-git-row .dshws-git-actions { gap: 0; padding-right: 4px; }
.dshws-git-file { height: 26px; gap: 6px; padding: 0 10px; font-size: 13px; }
.dshws-git-commit-files .dshws-git-file:hover, .dshws-git-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-git-dir { margin-left: 2px; }

/* 提交区 */
.dshws-git-commit { gap: 8px; padding: 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-git-commit .dshws-textarea {
  min-height: 56px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.5;
  background: var(--dsw-alias-bg-layer-2);
}
.dshws-git-commit .dshws-textarea:focus { background: var(--dsw-alias-bg-layer-1); }
.dshws-git-commit-btn {
  height: 30px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
  background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted);
}
.dshws-git-commit-btn:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dshws-git-commit-btn:disabled { opacity: .35; }

/* 分支 */
.dshws-git-branch { height: 30px; gap: 8px; padding: 0 10px; }
.dshws-git-branch-mark { display: inline-flex; width: auto; color: var(--dsw-alias-label-tertiary); }
.dshws-git-branch[data-head="true"] .dshws-git-branch-mark { color: var(--dsw-alias-state-business-primary); }
.dshws-git-branch .dshws-git-dir {
  padding: 1px 6px; border-radius: 4px; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
}
.dshws-git-branch[data-head="true"] { cursor: pointer; }

/* 顶部分支选择器（下拉） */
.dshws-git-toolbar { position: relative; }
.dshws-bp { flex: 1; min-width: 0; display: flex; }
.dshws-bp-trigger {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; height: 28px; padding: 0 8px 0 6px; margin-left: -4px;
  border: 0; border-radius: 6px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dshws-bp-trigger:hover, .dshws-bp-trigger[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-bp-trigger[data-viewing="true"] { color: var(--dsw-alias-state-business-primary); }
.dshws-bp-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshws-bp-trigger .dshws-chevron { transform: rotate(90deg); }
.dshws-bp-trigger .dshws-chevron.is-open { transform: rotate(-90deg); }
.dshws-bp-pop {
  position: absolute; top: calc(100% + 4px); left: 6px; right: 6px; z-index: 30; display: flex; flex-direction: column;
  max-height: min(460px, 70vh); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
}
.dshws-bp-head { display: flex; align-items: center; gap: 4px; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-bp-head .dshws-input { flex: 1; min-width: 0; height: 28px; font-size: 12.5px; }
.dshws-bp-notes { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
/* 提示各压成一行：超出省略，悬停 title 看全文 */
.dshws-bp-note {
  display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 8px; border-radius: 6px; font-size: 12px;
  color: var(--bn); background: color-mix(in srgb, var(--bn) 9%, transparent); --bn: var(--dsw-alias-state-business-primary);
}
.dshws-bp-note[data-tone="warn"] { --bn: var(--dsw-alias-state-warn-primary); }
.dshws-bp-note .dshws-ico-folder { color: inherit; }
.dshws-bp-note-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-bp-note .dshws-link-btn { flex-shrink: 0; font-weight: 600; }
.dshws-bp-note .dshws-ibtn { color: inherit; width: 24px; height: 24px; }
.dshws-bp-list { flex: 1; min-height: 0; overflow: auto; padding: 2px 0 6px; }
.dshws-bp-list .dshws-git-section-head { background: var(--dsw-alias-bg-layer-1); }
.dshws-git-branch-row[data-viewing="true"] { background: var(--dsw-alias-interactive-bg-active); }

/* 分支行：左侧查看按钮 + 右侧「设为默认」图钉（悬停或已设为默认时显示） */
.dshws-git-branch-row { display: flex; align-items: center; min-width: 0; }
.dshws-git-branch-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-git-branch-row .dshws-git-branch { flex: 1; min-width: 0; }
.dshws-git-branch-row .dshws-git-branch:hover { background: transparent; }
.dshws-git-branch-pin { padding-right: 4px; visibility: hidden; }
.dshws-git-branch-row:hover .dshws-git-branch-pin, .dshws-git-branch-row[data-default="true"] .dshws-git-branch-pin { visibility: visible; }

/* 历史：提交行、引用徽标 */
.dshws-git-commit-row { height: 28px; gap: 4px; padding: 0 10px 0 6px; }
.dshws-git-subject { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dshws-git-subject-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-git-meta { display: inline-flex; gap: 6px; align-items: center; max-width: 42%; }
.dshws-git-author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-git-ref {
  display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; height: 18px; margin-right: 0; padding: 0 6px;
  border: 0; border-radius: 9px; font-size: 10.5px; font-weight: 500;
  color: var(--ref); background: color-mix(in srgb, var(--ref) 13%, transparent); --ref: var(--dsw-alias-label-secondary);
}
.dshws-git-ref[data-kind="head"] { --ref: var(--dsw-alias-state-business-primary); font-weight: 700; }
.dshws-git-ref[data-kind="local"] { --ref: #16a34a; }
.dshws-git-ref[data-kind="remote"] { --ref: var(--dsw-alias-label-tertiary); }
.dshws-git-ref[data-kind="tag"] { --ref: #d08a00; }
/* 展开的提交详情：左侧留出与分叉图同宽的栏位，由 GraphRail 接上泳道竖线 */
.dshws-git-commit-files { position: relative; padding: 4px 0 8px 0; background: var(--dsw-alias-bg-layer-2); }
.dshws-git-rail { position: absolute; left: 6px; top: 0; height: 100%; }
.dshws-git-commit-files .dshws-git-file { padding-left: calc(var(--rail, 14px) + 14px); }
.dshws-git-commit-info {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 12px 6px calc(var(--rail, 14px) + 14px);
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary);
}

/* 横幅（查看分支 / 只读说明 / 冲突） */
.dshws-side-banner {
  margin: 8px 10px 0; padding: 7px 10px; border-radius: 8px; line-height: 1.5;
  background: color-mix(in srgb, var(--bn) 10%, transparent); color: var(--bn);
  --bn: var(--dsw-alias-state-warn-primary);
}
.dshws-side-banner[data-tone="info"] { --bn: var(--dsw-alias-state-business-primary); }
.dshws-side-banner > span { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.dshws-side-banner .dshws-link-btn { flex-shrink: 0; font-weight: 600; }

/* 内容页标题栏里的文字按钮 */
.dshws-side-head .dshws-link-btn { display: inline-flex; align-items: center; gap: 2px; }

/* 全局配置页签：每组一张卡片；配置行左侧标题 + 说明、右侧开关 */
.dshws-settings { display: flex; flex-direction: column; gap: 16px; max-width: 760px; padding-top: 4px; }
.dshws-set-card { padding: 14px 18px 8px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dshws-set-card > .dshws-section-title { margin-bottom: 4px; }
.dshws-set-row { display: flex; align-items: center; gap: 24px; padding: 12px 0; }
.dshws-set-row + .dshws-set-row { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshws-set-row[data-disabled="true"] .dshws-set-title { color: var(--dsw-alias-label-tertiary); }
.dshws-set-text { flex: 1; min-width: 0; }
.dshws-set-title { font-size: 13.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dshws-set-desc { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dshws-set-note { display: block; margin-top: 2px; color: var(--dsw-alias-state-warn-primary); }
.dshws-set-control { flex-shrink: 0; display: flex; align-items: center; }
.dshws-set-link { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-state-business-primary); text-decoration: none; font-size: 13px; }
.dshws-set-link:hover { text-decoration: underline; }
.dshws-set-note[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dshws-set-actions { gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dshws-link-button { padding: 0; border: 0; background: none; font: inherit; font-size: 12px; color: var(--dsw-alias-state-business-primary); cursor: pointer; }
.dshws-link-button:hover { text-decoration: underline; }
.dshws-update-notes, .dshws-update-error { margin: 0 0 12px; padding: 10px 12px; max-height: 240px; overflow: auto; border-radius: 8px; white-space: pre-wrap; word-break: break-word;
  font-size: 12px; line-height: 1.6; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dshws-update-error { color: var(--dsw-alias-state-error-primary); }
/* 升级完成、待重启的提示条（卡片顶部，醒目色） */
.dshws-update-restart {
  display: flex; align-items: center; gap: 12px; margin: 6px 0 8px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent);
}
.dshws-update-restart-ico { flex-shrink: 0; color: var(--dsw-alias-state-business-primary); }
.dshws-update-restart-text { flex: 1; min-width: 0; }
.dshws-update-restart-title { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshws-update-restart-desc { margin-top: 3px; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
@media (max-width: 640px) { .dshws-update-restart { flex-wrap: wrap; } }
.dshws-update-progress { display: flex; align-items: center; gap: 8px; padding: 10px 0 12px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.dshws-about { padding: 8px 0 12px; }
.dshws-about-head { display: flex; align-items: baseline; gap: 8px; }
.dshws-about-name { font-size: 16px; font-weight: 600; }
.dshws-about-ver { padding: 1px 7px; border-radius: 9px; font-size: 11.5px; font-weight: 500; line-height: 18px;
  color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.dshws-about-desc { margin: 6px 0 14px; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dshws-about-kv { margin: 0 0 14px; }
.dshws-about-kv dd .dshws-set-link { font-family: inherit; }
.dshws-about-links { display: flex; flex-wrap: wrap; gap: 8px 20px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }

/* 添加工作区弹窗：左侧位置栏（本机快捷目录 / 盘符 / 远程主机）+ 右侧目录浏览。内部一律 min-width: 0，避免长路径撑出弹窗 */
.dshws-picker.dshws-picker { width: min(880px, 100%); max-height: 100%; gap: 16px; }
.dshws-pk { display: grid; grid-template-columns: 208px minmax(0, 1fr); height: min(400px, calc(100dvh - 330px)); min-height: 240px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
.dshws-pk-rail { display: flex; flex-direction: column; gap: 1px; padding: 8px 6px; overflow-y: auto; min-width: 0;
  background: var(--dsw-alias-bg-layer-1); border-right: 1px solid var(--dsw-alias-border-l2); }
.dshws-pk-rail-title { padding: 10px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-tertiary); }
.dshws-pk-rail-title:first-child { padding-top: 2px; }
.dshws-pk-rail-note { padding: 2px 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshws-pk-place {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 30px; padding: 5px 8px;
  border: 0; border-radius: 6px; background: transparent; cursor: pointer; text-align: left;
  font-size: 13px; color: var(--dsw-alias-label-secondary);
}
.dshws-pk-place > svg { flex-shrink: 0; color: var(--dsw-alias-label-tertiary); }
.dshws-pk-place:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-pk-place[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dshws-pk-place[data-active="true"] > svg { color: var(--dsw-alias-state-business-primary); }
.dshws-pk-place-sub { padding-left: 30px; }
.dshws-pk-place-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-pk-host { min-height: 42px; padding-top: 6px; padding-bottom: 6px; }
.dshws-pk-host-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; line-height: 1.35; }
.dshws-pk-host-sub { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-pk-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dshws-pk-source { padding: 8px 12px 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-pk-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px;
  text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshws-pk-empty > svg { color: var(--dsw-alias-label-tertiary); }
.dshws-pk-empty .dshws-add-unlock { width: min(360px, 100%); }
.dshws-pk-bottom { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; min-width: 0; }
.dshws-pk-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-width: 0; flex-wrap: wrap; }
.dshws-pk-footer-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dshws-add-row { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; }
.dshws-add-row > span { flex-shrink: 0; width: 48px; color: var(--dsw-alias-label-secondary); }
.dshws-add-row > .dshws-input, .dshws-add-row > .dshws-select { flex: 1; min-width: 0; }
.dshws-add-unlock { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.dshws-add-unlock .dshws-input { flex: 1; min-width: 160px; }
.dshws-add-selected {
  padding-left: 56px; font-size: 12px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshws-fb { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dshws-fb-bar { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); min-width: 0; }
.dshws-fb-path { flex: 1; min-width: 0; height: 28px !important; font-size: 12px !important; }
.dshws-fb-crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 4px; overflow-x: auto; scrollbar-width: none; cursor: text; }
.dshws-fb-crumbs::-webkit-scrollbar { display: none; }
.dshws-fb-crumb-seat { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.dshws-fb-crumb-seat > svg { color: var(--dsw-alias-label-tertiary); }
.dshws-fb-crumb {
  max-width: 180px; padding: 2px 6px; border: 0; border-radius: 5px; background: transparent; cursor: pointer;
  font-size: 13px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshws-fb-crumb:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-fb-crumb[data-current="true"] { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dshws-fb-list { flex: 1; min-height: 0; overflow: auto; padding: 4px 6px; }
.dshws-fb-list[data-loading="true"] { opacity: .6; }
.dshws-fb-note { padding: 16px 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); text-align: center; }
.dshws-fb-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); text-align: left; white-space: pre-wrap; word-break: break-word; }
/* 目录浏览错误横幅：在工具栏与列表之间，淡红底 + 图标；原始报错折叠在「详情」里 */
.dshws-fb-error {
  display: flex; align-items: flex-start; gap: 8px; margin: 8px 8px 0; padding: 8px 6px 8px 10px; border-radius: 8px; min-width: 0;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
  font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary);
}
.dshws-fb-error > svg { flex-shrink: 0; margin-top: 2px; color: var(--dsw-alias-state-error-primary); }
.dshws-fb-error-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshws-fb-error-title { font-weight: 500; overflow-wrap: anywhere; }
.dshws-fb-error-hint { color: var(--dsw-alias-label-secondary); }
.dshws-fb-error-detail {
  margin-top: 4px; padding: 6px 8px; border-radius: 6px; max-height: 96px; overflow: auto; user-select: text;
  background: var(--dsw-alias-bg-layer-1); font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all;
}
.dshws-fb-error-actions { display: flex; gap: 12px; margin-top: 2px; }
.dshws-fb-error-actions:empty { display: none; }
.dshws-fb-error-actions .dshws-link-btn { font-size: 12px; }
.dshws-fb-error-close { flex-shrink: 0; width: 22px !important; height: 22px !important; }
.dshws-fb-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 6px 10px; border: 0; border-radius: 6px;
  background: transparent; cursor: pointer; text-align: left; font-size: 13px; color: var(--dsw-alias-label-primary);
}
.dshws-fb-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-fb-item:hover .dshws-chevron { color: var(--dsw-alias-label-secondary); }
.dshws-fb-item[data-hidden="true"] { color: var(--dsw-alias-label-tertiary); }
.dshws-fb-item[data-hidden="true"] .dshws-ico-folder { opacity: .55; }
.dshws-fb-item-ico { display: inline-flex; flex-shrink: 0; }
.dshws-fb-item-ico[data-kind="drive"] { color: var(--dsw-alias-label-secondary); }
.dshws-fb-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-fb-mkdir { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dshws-fb-mkdir .dshws-input { height: 28px; flex: 1; min-width: 0; max-width: 280px; }
.dshws-link-btn { border: 0; background: transparent; cursor: pointer; color: var(--dsw-alias-state-business-primary); font-size: 12px; padding: 2px 4px; border-radius: 4px; }
.dshws-link-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-link-btn:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }

/* 主机 / 分组弹窗：宿主 Modal 默认只有 380px。主机表单加宽到 720px，正文区滚动、标题与底栏固定 */
.dshws-form-dialog.dshws-form-dialog { width: min(720px, 100%); max-height: 100%; }
.dshws-group-dialog.dshws-group-dialog { width: min(460px, 100%); }
.dshws-form-content.dshws-form-content { flex: 1 1 auto; min-height: 0; }
.dshws-form-content.dshws-form-content > :last-child { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 2px; }
.dshws-group-dialog .dshws-form { gap: 16px; }

/* 分组下拉（替代原生 datalist） */
.dshws-gsel { position: relative; min-width: 0; }
.dshws-gsel-trigger {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; box-sizing: border-box; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-size: 13.5px; cursor: pointer; text-align: left;
}
.dshws-gsel-trigger:hover { border-color: var(--dsw-alias-border-l4); }
.dshws-gsel-trigger[data-open="true"] { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }
.dshws-gsel-trigger > svg:last-child { flex-shrink: 0; color: var(--dsw-alias-label-tertiary); transition: transform .12s; }
.dshws-gsel-trigger[data-open="true"] > svg:last-child { transform: rotate(180deg); }
.dshws-gsel-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-gsel-value[data-empty="true"] { color: var(--dsw-alias-label-tertiary); }
.dshws-gsel-pop {
  z-index: 2000; display: flex; flex-direction: column; max-height: 300px; box-sizing: border-box; padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0, 0, 0, .16));
}
.dshws-gsel-search.dshws-gsel-search { height: 30px; font-size: 12.5px; flex-shrink: 0; margin-bottom: 4px; }
.dshws-gsel-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.dshws-gsel-opt {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 10px; flex-shrink: 0;
  border: 0; border-radius: 6px; background: transparent; cursor: pointer; text-align: left;
  font-size: 13px; color: var(--dsw-alias-label-primary);
}
.dshws-gsel-opt:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-gsel-opt[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); font-weight: 500; }
.dshws-gsel-opt:disabled { opacity: .4; cursor: default; }
.dshws-gsel-opt[data-create="true"] { color: var(--dsw-alias-state-business-primary); }
.dshws-gsel-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-gsel-root { color: var(--dsw-alias-label-secondary); }
.dshws-gsel-empty { padding: 10px; font-size: 12px; text-align: center; color: var(--dsw-alias-label-tertiary); }

/* 右键菜单（远程文件树 / Git 改动列表） */
.dshws-ctx {
  position: fixed; z-index: 3000; min-width: 180px; max-width: 280px; padding: 4px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0, 0, 0, .16));
}
.dshws-ctx-item {
  display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: 30px; padding: 0 12px; box-sizing: border-box;
  border: 0; border-radius: 6px; background: transparent; cursor: pointer; text-align: left;
  font-size: 13px; color: var(--dsw-alias-label-primary); white-space: nowrap;
}
.dshws-ctx-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-ctx-item:disabled { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); cursor: default; }
.dshws-ctx-item[data-danger="true"]:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dshws-ctx-item[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
.dshws-ctx-ico { display: none; }
.dshws-ctx-ico:not(:empty) { display: inline-flex; width: 16px; }
.dshws-ctx-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2); }
.dshws-ctx-sep:first-child, .dshws-ctx-sep + .dshws-ctx-sep, .dshws-ctx-sep:last-child { display: none; }
/* 浮动提示气泡：挂在 body 上、fixed 定位在右键处，不占文档流（不会推动列表） */
.dshws-float {
  position: fixed; z-index: 3100; max-width: 280px; padding: 6px 10px; box-sizing: border-box; pointer-events: none;
  border-radius: 8px; font-size: 12px; line-height: 1.45; word-break: break-word;
  color: var(--dsw-alias-label-primary-inverted, #fff); background: color-mix(in srgb, var(--dsw-alias-label-primary) 88%, transparent);
  box-shadow: 0 6px 18px rgba(0, 0, 0, .18); animation: dshws-float-in .14s ease-out; transition: opacity .2s, transform .2s;
}
.dshws-float[data-tone="error"] { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dshws-float[data-leaving="true"] { opacity: 0; transform: translateY(-4px); }
@keyframes dshws-float-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
/* 侧栏里的小浮层：输入名称 / 确认删除（挂在 body 上，出现在右键处） */
.dshws-ask {
  position: fixed; z-index: 3050; width: 280px; max-width: calc(100vw - 16px); padding: 12px; box-sizing: border-box; outline: none;
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0, 0, 0, .16)); animation: dshws-float-in .12s ease-out;
  font-size: 13px; color: var(--dsw-alias-label-primary);
}
.dshws-ask-title { font-weight: 500; }
.dshws-ask-message { line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.dshws-ask-input { width: 100%; box-sizing: border-box; }
.dshws-ask-note { min-height: 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dshws-ask-note:empty { display: none; }
.dshws-ask-row { display: flex; justify-content: flex-end; gap: 8px; }
.dshws-ask-btn {
  height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
}
.dshws-ask-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-ask-btn[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-state-business-primary); color: #fff; }
.dshws-ask-btn[data-primary="true"][data-danger="true"] { background: var(--dsw-alias-state-error-primary); }

/* 连接中 / 加载中的小转圈 */
.dshws-spinner {
  display: inline-block; flex-shrink: 0; width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 25%, transparent);
  border-top-color: var(--dsw-alias-state-business-primary); animation: dshws-spin .8s linear infinite;
}
@keyframes dshws-spin { to { transform: rotate(360deg); } }
.dshws-fb-connecting { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; min-height: 160px;
  padding: 24px; box-sizing: border-box; text-align: center; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dshws-fb-connecting .dshws-spinner { width: 22px; height: 22px; border-width: 2.5px; }

/* 添加工作区左栏：可折叠的「此电脑」「远程主机」与分组树 */
.dshws-pk-rail-toggle { display: flex; align-items: center; gap: 4px; width: 100%; border: 0; background: transparent; cursor: pointer; text-align: left; }
.dshws-pk-rail-toggle:hover { color: var(--dsw-alias-label-secondary); }
.dshws-pk-rail-toggle .dshws-pk-count { margin-left: auto; }
.dshws-pk-count { flex-shrink: 0; min-width: 16px; height: 16px; padding: 0 5px; box-sizing: border-box; border-radius: 8px; font-size: 10.5px; font-weight: 500; line-height: 16px; text-align: center;
  color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.dshws-pk-group { min-height: 28px; font-size: 12.5px; font-weight: 500; }
.dshws-pk-group > .dshws-ico-folder { color: #e0a53c; }
.dshws-pk-group .dshws-pk-count { margin-left: auto; }
.dshws-pk-folder { padding: 0; gap: 0; cursor: default; }
.dshws-pk-fold { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 22px; height: 30px; padding: 0 0 0 4px;
  border: 0; background: transparent; cursor: pointer; color: var(--dsw-alias-label-tertiary); }
.dshws-pk-folder-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; height: 30px; padding: 0 8px 0 2px; border: 0; background: transparent; cursor: pointer;
  text-align: left; font: inherit; color: inherit; }
.dshws-pk-folder-main > svg { flex-shrink: 0; color: var(--dsw-alias-label-tertiary); }
.dshws-pk-folder[data-active="true"] .dshws-pk-folder-main > svg { color: var(--dsw-alias-state-business-primary); }
.dshws-pk-host[data-phase="connecting"] .dshws-pk-host-sub { color: var(--dsw-alias-state-business-primary); }
.dshws-pk-host[data-phase="error"] .dshws-pk-host-sub { color: var(--dsw-alias-state-error-primary); }
.dshws-rename { display: flex; align-items: center; padding: 2px 8px 2px 0; }
.dshws-rename-input.dshws-rename-input { height: 26px; font-size: 13px; padding: 0 6px; margin-left: 30px; }

/* 主机拖拽换分组 */
.dshws-host[draggable="true"] { cursor: grab; }
.dshws-host[data-dragging="true"] { opacity: .45; }
.dshws-group[data-drop="true"] { box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary); border-radius: 4px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent); }
.dshws-group[data-drop-same="true"] { box-shadow: inset 0 0 0 2px var(--dsw-alias-border-l3); background: transparent; }
.dshws-drop-root {
  display: flex; align-items: center; justify-content: center; height: 38px; margin: 6px; box-sizing: border-box;
  border: 1.5px dashed var(--dsw-alias-border-l3); border-radius: 8px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary);
}
.dshws-drop-root[data-drop="true"]:not([data-disabled="true"]) { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent); }
.dshws-danger-btn { background: var(--dsw-alias-state-error-primary) !important; border-color: transparent !important; }
.dshws-term-stack {
  flex: 1 1 auto; min-height: 0; display: flex;
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 0 8px 8px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.dshws-term-slot { flex: 1 1 auto; min-width: 0; min-height: 0; flex-direction: column; }
.dshws-term { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
.dshws-term-host { flex: 1 1 auto; min-height: 0; padding: 6px 4px 4px 10px; overflow: hidden; }
.dshws-term-host .xterm { height: 100%; }
.dshws-term-banner {
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  padding: 6px 12px; font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dshws-term-banner[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dshws-term-banner[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dshws-term-search {
  position: absolute; top: 8px; right: 16px; z-index: 5;
  display: flex; gap: 4px; align-items: center;
  padding: 4px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-elevation-prominent);
}
.dshws-term-search .dshws-input { width: 260px; height: 28px; }
/* 终端右键菜单：fixed 定位于鼠标处（相对视口），不受终端区域 overflow 裁剪 */
.dshws-ctx-menu {
  position: fixed; z-index: 1000; min-width: 200px; padding: 4px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px; box-shadow: var(--dsw-elevation-prominent);
}
.dshws-ctx-item {
  display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 16px;
  padding: 6px 10px; border: 0; border-radius: 5px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary); font-size: 13px; text-align: left;
}
.dshws-ctx-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-ctx-item:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dshws-ctx-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dshws-ctx-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2); }
.dshws-term-notice {
  position: absolute; bottom: 12px; right: 16px; z-index: 5; padding: 6px 12px; border-radius: 8px; font-size: 12px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent);
}
/* 编辑器状态栏的语言下拉 */
.dshws-code-lang {
  height: 20px; font-size: 11px; border: 1px solid transparent; border-radius: 4px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary); margin-right: auto;
}
.dshws-code-lang:hover { border-color: var(--dsw-alias-border-l3); }

/* 文件浏览 */
.dshws-files { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.dshws-files-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex-shrink: 0; }
.dshws-files-path { flex: 1; min-width: 200px; }
.dshws-files-search { width: 220px; }
.dshws-crumbs { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; font-size: 13px; }
.dshws-crumb-sep { color: var(--dsw-alias-label-tertiary); margin: 0 4px; }
.dshws-link {
  background: none; border: 0; padding: 0 2px; cursor: pointer; font-size: inherit;
  color: var(--dsw-alias-brand-primary);
}
.dshws-link:hover { text-decoration: underline; }
.dshws-icon-btn:disabled { opacity: .4; cursor: default; }
.dshws-files-body {
  flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(280px, 2fr) 3fr; gap: 8px;
}
.dshws-tree, .dshws-preview {
  min-height: 0; overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshws-tree { padding: 4px 0; }
.dshws-tree[data-drop="true"] { outline: 2px dashed var(--dsw-alias-brand-primary); outline-offset: -4px; }
.dshws-tree-row {
  display: flex; align-items: center; gap: 6px; height: 28px; padding-right: 6px;
  cursor: pointer; user-select: none; font-size: 13px; white-space: nowrap;
}
.dshws-tree-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-tree-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-active); }
.dshws-tree-row[data-ignored="true"] { opacity: .5; }
.dshws-tree-row[data-drop="true"] { outline: 2px dashed var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshws-tree-caret { width: 12px; display: inline-flex; color: var(--dsw-alias-label-tertiary); transition: transform .12s; transform: rotate(-90deg); }
.dshws-tree-caret[data-open="true"] { transform: none; }
.dshws-tree-icon { width: 16px; text-align: center; font-size: 13px; }
.dshws-tree-name { overflow: hidden; text-overflow: ellipsis; }
.dshws-tree-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-left: 6px; overflow: hidden; text-overflow: ellipsis; }
.dshws-tree-more {
  margin-left: auto; visibility: hidden;
  width: 22px; height: 22px; border: 0; border-radius: 5px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary);
}
.dshws-tree-row:hover .dshws-tree-more { visibility: visible; }
.dshws-tree-more:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-tree-note { padding: 8px 12px; font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: pre-wrap; }
.dshws-tree-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dshws-tree-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
/* 预览区由编辑器自己滚动，外层不能再出滚动条（否则会与 Monaco 的虚拟滚动打架） */
.dshws-preview { display: flex; flex-direction: column; overflow: hidden; }
.dshws-preview-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-shrink: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dshws-preview-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-preview-head .dshws-tree-meta { flex: 1; }
.dshws-dirty { color: var(--dsw-alias-state-warn-primary); }

/* 代码编辑器 */
.dshws-code { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dshws-code-host { flex: 1 1 auto; min-height: 0; }
/* Monaco 在 iPad / 触屏 UA 下会自己渲染一个悬浮键盘按钮（editor.contrib.iPadShowKeyboard，
 * 元素类名就是 iPadShowKeyboard）：手机上点了不会按预期唤出输入法，直接隐藏。
 * 只作用于本插件的编辑器，宿主其它 Monaco 实例不受影响。 */
.dshws-code-host .iPadShowKeyboard { display: none !important; }
.dshws-code-status {
  flex-shrink: 0; display: flex; gap: 12px; justify-content: flex-end;
  padding: 3px 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary);
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dshws-uploads {
  flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2);
  max-height: 160px; overflow-y: auto;
}
.dshws-upload { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dshws-upload-name { width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-upload progress { flex: 1; height: 6px; }
.dshws-upload-error { flex: 1; color: var(--dsw-alias-state-error-primary); }
.dshws-back {
  display: inline-flex; align-items: center; gap: 4px;
  background: none; border: 0; padding: 4px 0; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 13px;
}
.dshws-back:hover { color: var(--dsw-alias-label-primary); }
.dshws-head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px 16px; margin: 12px 0 20px; }
.dshws-head-text { flex: 1 1 320px; min-width: 0; }
.dshws-title { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
.dshws-intro { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }
.dshws-head-actions { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; align-items: center; margin-left: auto; }

/* 提示横幅 */
.dshws-banner {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 14px 16px; margin-bottom: 16px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l3);
}
.dshws-banner[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary); }
.dshws-banner[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary); }
.dshws-banner-text { flex: 1; min-width: 220px; }
.dshws-banner-title { font-weight: 600; margin-bottom: 4px; }
.dshws-banner-hint { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.dshws-banner-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshws-banner-form .dshws-input { width: 180px; }

/* 工具条 */
/* 注意：不能叫 .dshws-toolbar —— 右侧栏已用这个类名（38px 高 + 底边线），两边会互相串样式 */
.dshws-page-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.dshws-page-toolbar .dshws-search { flex: 1; max-width: 360px; }

/* 分组与主机列表：整体放在一张卡片里，行之间细分隔线 */
.dshws-hostlist {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
}
.dshws-group { margin: 0; }
.dshws-group-head {
  display: flex; align-items: center; gap: 6px; height: 34px;
  padding: 0 8px 0 10px; cursor: pointer; user-select: none;
  background: var(--dsw-alias-bg-layer-2); border-top: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); font-size: 12.5px; font-weight: 600;
}
.dshws-hostlist > .dshws-group:first-child > .dshws-group-head { border-top: 0; }
.dshws-group-head:hover { color: var(--dsw-alias-label-primary); }
.dshws-group-caret { display: inline-flex; color: var(--dsw-alias-label-tertiary); transition: transform .15s; }
.dshws-group-head[data-open="false"] .dshws-group-caret { transform: rotate(-90deg); }
.dshws-group-head .dshws-ico-folder { color: #e0a53c; }
.dshws-group-count {
  min-width: 18px; height: 18px; padding: 0 6px; border-radius: 9px; box-sizing: border-box;
  font-size: 11px; font-weight: 500; line-height: 18px; text-align: center;
  color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
}
.dshws-group-actions { margin-left: auto; display: flex; gap: 2px; visibility: hidden; }
.dshws-group-head:hover .dshws-group-actions { visibility: visible; }
.dshws-group-body { padding-left: 0; }
.dshws-group-body .dshws-group-head { padding-left: 26px; }
.dshws-group-body .dshws-host { padding-left: 26px; }
.dshws-group-body .dshws-group-body .dshws-host { padding-left: 42px; }

.dshws-host {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-height: 56px;
  padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshws-hostlist > div:first-child > .dshws-host { border-top: 0; }
.dshws-host:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-host[data-selected="true"] { background: var(--dsw-alias-interactive-bg-active); box-shadow: inset 3px 0 0 var(--dsw-alias-state-business-primary); }
.dshws-host-icon {
  position: relative; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 32px; height: 32px; border-radius: 9px;
  color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
}
.dshws-host[data-state="done"] .dshws-host-icon { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.dshws-host[data-state="error"] .dshws-host-icon { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dshws-host-dot {
  position: absolute; right: -2px; bottom: -2px; display: inline-flex; padding: 2px; border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1);
}
.dshws-host-main { flex: 1 1 220px; min-width: 0; cursor: pointer; }
.dshws-host-label { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.dshws-host-name { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshws-host-addr {
  display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 3px;
  color: var(--dsw-alias-label-tertiary); font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dshws-host-addr > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-host-live { flex-shrink: 0; font-family: var(--dsw-font-family); color: var(--dsw-alias-state-success-primary); }
/* 窄屏时整组操作按钮换到下一行靠右，而不是把页面撑宽 */
.dshws-host-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; margin-left: auto; }
.dshws-host-sep { width: 1px; height: 16px; margin: 0 2px; background: var(--dsw-alias-border-l2); }
.dshws-host-result { font-size: 12px; margin-top: 4px; }
.dshws-host-result[data-ok="true"] { color: var(--dsw-alias-state-success-primary); }
.dshws-host-result[data-ok="false"] { color: var(--dsw-alias-state-error-primary); }

/* 行内次级按钮：带图标，描边轻；ghost 版无描边 */
.dshws-act {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; flex-shrink: 0;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12.5px;
}
.dshws-act:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l4); }
.dshws-act[data-ghost="true"] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.dshws-act[data-ghost="true"]:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dshws-act:disabled { opacity: .5; cursor: default; }
.dshws-act .dshws-ico-folder { color: inherit; }

.dshws-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 18px;
  padding: 0 7px; border-radius: 9px; font-size: 11px; font-weight: 500;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dshws-chip[data-kind="via"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 11%, transparent); }
.dshws-chip[data-kind="proxy"] { color: #8b5cf6; background: color-mix(in srgb, #8b5cf6 12%, transparent); }

.dshws-empty {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px 16px; text-align: center;
  color: var(--dsw-alias-label-tertiary);
  border: 1px dashed var(--dsw-alias-border-l3); border-radius: 12px;
}
/* 日志 */
.dshws-log { margin-top: 28px; }
.dshws-log-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dshws-log-title { font-weight: 600; flex: 1; }
.dshws-log-body {
  max-height: 280px; overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dshws-log-row { display: flex; gap: 10px; padding: 5px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshws-log-row:last-child { border-bottom: 0; }
.dshws-log-time { color: var(--dsw-alias-label-tertiary); flex-shrink: 0; }
.dshws-log-level { flex-shrink: 0; width: 38px; }
.dshws-log-row[data-level="error"] .dshws-log-level { color: var(--dsw-alias-state-error-primary); }
.dshws-log-row[data-level="warn"] .dshws-log-level { color: var(--dsw-alias-state-warn-primary); }
.dshws-log-row[data-level="info"] .dshws-log-level { color: var(--dsw-alias-state-success-primary); }
.dshws-log-stage { color: var(--dsw-alias-label-tertiary); flex-shrink: 0; width: 72px; }
.dshws-log-msg { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.dshws-log-detail { color: var(--dsw-alias-label-tertiary); margin-top: 2px; white-space: pre-wrap; }
.dshws-log-empty { padding: 16px; text-align: center; color: var(--dsw-alias-label-tertiary); }

/* 表单：每个区段一张浅色卡片，区段标题带左侧强调条 */
.dshws-form { display: flex; flex-direction: column; gap: 12px; }
.dshws-form > section {
  padding: 14px 16px 16px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
}
.dshws-section-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
  letter-spacing: 0; margin-bottom: 12px;
}
.dshws-section-title::before {
  content: ''; width: 3px; height: 13px; border-radius: 2px; background: var(--dsw-alias-state-business-primary);
}
.dshws-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.dshws-grid .dshws-span-2 { grid-column: span 2; }
.dshws-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshws-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshws-label .dshws-req { color: var(--dsw-alias-state-error-primary); margin-left: 2px; }
.dshws-field-hint { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshws-field-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dshws-input, .dshws-textarea, .dshws-select {
  width: 100%; box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px; font-size: 13.5px; outline: none;
  font-family: inherit;
  transition: border-color .12s, box-shadow .12s;
}
.dshws-input, .dshws-select { height: 34px; padding: 0 10px; }
.dshws-textarea { padding: 8px 10px; resize: vertical; min-height: 64px; line-height: 1.5; }
.dshws-textarea.dshws-mono, .dshws-input.dshws-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px;
}
.dshws-input:hover, .dshws-textarea:hover, .dshws-select:hover { border-color: var(--dsw-alias-border-l4); }
.dshws-input:focus, .dshws-textarea:focus, .dshws-select:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);
}
.dshws-input::placeholder, .dshws-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
/* 原生下拉：去掉系统外观，换成与输入框一致的外观 + 自绘箭头 */
.dshws-select {
  appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
}

/* 分段选择：浅色轨道 + 选中项浮起（不再用整块黑色） */
.dshws-segment {
  display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px;
  border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
}
.dshws-segment button {
  height: 28px; padding: 0 12px; border-radius: 7px; cursor: pointer; font-size: 12.5px;
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
}
.dshws-segment button:hover { color: var(--dsw-alias-label-primary); }
.dshws-segment button[data-active="true"] {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .12), 0 0 0 1px var(--dsw-alias-border-l2);
}
.dshws-segment + .dshws-grid, .dshws-segment + .dshws-field { margin-top: 12px; }
.dshws-jump-list { display: flex; flex-direction: column; gap: 6px; }
.dshws-jump-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
}
.dshws-jump-index { color: var(--dsw-alias-label-tertiary); font-size: 12px; width: 16px; }
.dshws-jump-name { flex: 1; }

.dshws-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
/* 底栏两行：按钮一行（测试靠左，取消 / 保存靠右），测试结果单独占下一行 —— 结果文本长短不影响按钮布局 */
.dshws-footer-wrap { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
.dshws-footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.dshws-footer-test { margin-right: auto; }
.dshws-footer-result { margin-top: 0; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dshws-form-error {
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-state-error-primary);
}

.dshws-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; font-size: 13px; }
.dshws-kv dt { color: var(--dsw-alias-label-tertiary); }
.dshws-kv dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }

.dshws-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 8px; border: 0; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary);
}
.dshws-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-icon-btn[data-danger="true"]:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }

.dshws-panel-icon { display: inline-flex; align-items: center; justify-content: center; }

/* 窄屏（≤640px）：只新增规则，不改动上面的桌面样式。
 * ⚠️ 断点必须与 src/client/narrow.ts 的 NARROW_MAX_WIDTH 保持一致。 */
@media (max-width: 640px) {
  /* 1. 页面内边距收窄 */
  .dshws-page { padding-left: 12px; padding-right: 12px; }
  /* 2. 头部不换行：标题缩小、说明文字隐藏，把空间留给右上角操作 */
  .dshws-head { flex-wrap: nowrap; }
  .dshws-head-text { flex: 1 1 0; min-width: 0; }
  .dshws-title { font-size: 18px; }
  .dshws-intro { display: none; }
  /* 3. 页签横向滚动、不换行（只作用于 role="tab" 的按钮，避免宿主 Switch 被套样式） */
  .dshws-sections { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .dshws-sections::-webkit-scrollbar { display: none; }
  .dshws-sections > button[role="tab"] { flex: 0 0 auto; }
  /* 4. 主机行不换行、整卡左右滑动（桌面仍是 wrap + 无横向滚动） */
  .dshws-hostlist { overflow-x: auto; overflow-y: hidden; }
  .dshws-host { flex-wrap: nowrap; min-width: 560px; }
  /* 5. 文件页：树 / 预览改单列，工具条元素占满整行 */
  .dshws-files-body { grid-template-columns: 1fr; }
  .dshws-files-path { min-width: 0; }
  .dshws-files-search { width: 100%; }
  .dshws-upload-name { width: auto; flex: 1 1 120px; }
  /* 5b. 预览改全屏浮层：未选文件时整块不占位，选中后铺满本页（absolute，不盖宿主头部） */
  .dshws-preview { display: none; }
  .dshws-preview[data-open="true"] {
    display: flex; position: absolute; inset: 0; z-index: 3200;
    padding: 8px 12px 12px; background: var(--dsw-alias-bg-layer-1);
  }
  .dshws-preview[data-open="true"] .dshws-preview-head { flex-wrap: wrap; }
  /* 5c. 编辑器顶部那行「大小 · 权限 · 修改时间」在手机上太挤，隐藏（桌面保留） */
  .dshws-preview[data-open="true"] .dshws-preview-head .dshws-tree-meta { display: none; }
  /* 6. 表单 / 关于信息单列 */
  .dshws-grid { grid-template-columns: 1fr; }
  .dshws-kv { grid-template-columns: 1fr; }
  /* 7. 添加工作区弹窗：左栏位置列表改上下排列并限高，保证下方目录列表可见 */
  .dshws-pk { grid-template-columns: 1fr; }
  .dshws-pk-rail { max-height: 38vh; }
  /* 7b. 单列后高度改成「一屏之内」：弹窗整体不超过视口，各块内部自己滚动（桌面仍是固定高度） */
  .dshws-picker { max-height: calc(100dvh - 16px); }
  /* 必须是「确定高度 + 纵向 flex」：原先 grid + height:auto 时，下方行按内容撑高、被 .dshws-pk 的 overflow 裁掉，
   * .dshws-fb-list 永远拿不到有限高度，于是不能滚动、只露出前几行（进盘符后尤其明显） */
  .dshws-pk { display: flex; flex-direction: column; height: max(240px, min(52dvh, calc(100dvh - 330px))); max-height: none; min-height: 0; }
  .dshws-pk-rail { flex: 0 0 auto; max-height: 20dvh; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .dshws-pk-main { flex: 1 1 0; min-height: 0; }
  .dshws-fb-list { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
  .dshws-pk-bottom { flex-shrink: 0; }
  /* 7c. 名称/路径这类「标签 + 输入框」行：标签不占固定 48px，把宽度让给输入框 */
  .dshws-add-row > span { width: auto; }
  /* 7d. 弹窗底栏竖排：左右两组各占一行，按钮不会再被挤到屏幕外 */
  .dshws-pk-footer { flex-direction: column; align-items: stretch; }
  .dshws-pk-footer > * { width: 100%; }
  .dshws-pk-footer-left { flex-wrap: wrap; }
  /* 8. 日志行允许换行，固定列宽改成自适应 */
  .dshws-log-row { flex-wrap: wrap; }
  .dshws-log-level, .dshws-log-stage { width: auto; }
  /* 9. 弹窗底栏按钮：窄屏允许换行并均分宽度（只命中真实存在的容器类，宿主 Button 没有稳定类名） */
  .dshws-dialog-actions { flex-wrap: wrap; }
  .dshws-dialog-actions > button, .dshws-footer > button { flex: 1 1 auto; }
  .dshws-footer { flex-wrap: wrap; }
}
`

/** 注入样式（本插件样式 + xterm 样式），返回移除函数（交给 ctx.effect 管理生命周期）。 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) existing.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `${XTERM_CSS}\n${CSS}`
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
