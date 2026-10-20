/*
 * @Description: 作用域记忆的样式（由 styles.ts 的 injectStyles 一并注入）
 * @Author: YangHeng
 * @Date: 2026-10-16 21:35:00
 * @FilePath: /dsh-workspace/src/client/memory/styles.ts
 *
 * 颜色全部取宿主 --dsw- 主题变量；窄屏断点与 narrow.ts 一致（640px）。
 * 结构：总览（hero + 统计卡）→ 板块（panel：标题栏 + 正文）→ 卡片网格（card：标签 + 摘要 + 来源）→ 详情弹窗。
 */
export const MEMORY_CSS = `
.dshws-mem-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 24px; min-width: 0; }
.dshws-mem-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshws-mem-toolbar .dshws-search { flex: 1 1 240px; min-width: 0; }

/* ---------- 总览 ---------- */
.dshws-mem-hero {
  display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent), transparent 60%);
}
.dshws-mem-hero-main { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dshws-mem-hero-icon {
  flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); color: var(--dsw-alias-state-business-primary);
}
.dshws-mem-hero-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshws-mem-hero-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshws-mem-hero-sub { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dshws-mem-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dshws-mem-stat {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; min-width: 0; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; background: var(--dsw-alias-bg-l1, transparent); color: inherit; font: inherit; text-align: left;
}
button.dshws-mem-stat { cursor: pointer; }
button.dshws-mem-stat:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2)); }
.dshws-mem-stat-icon { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshws-mem-stat[data-tone="accent"] .dshws-mem-stat-icon { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); color: var(--dsw-alias-state-business-primary); }
.dshws-mem-stat-text { display: flex; flex-direction: column; min-width: 0; }
.dshws-mem-stat-value { font-size: 18px; font-weight: 600; line-height: 1.2; color: var(--dsw-alias-label-primary); }
.dshws-mem-stat-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- 左侧导航 ---------- */
.dshws-mem-split { display: grid; grid-template-columns: minmax(210px, 270px) minmax(0, 1fr); gap: 14px; align-items: start; }
.dshws-mem-tree {
  position: sticky; top: 0; display: flex; flex-direction: column; gap: 1px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px; max-height: 75vh; overflow: auto;
}
.dshws-mem-tree-title { padding: 10px 10px 4px; font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--dsw-alias-label-tertiary); }
.dshws-mem-tree-empty { padding: 2px 10px 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dshws-mem-tree-group + .dshws-mem-tree-group { margin-top: 2px; }
.dshws-mem-node {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.dshws-mem-node:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-mem-node[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); }
.dshws-mem-node[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dshws-mem-node-icon { flex: none; display: grid; place-items: center; width: 16px; color: var(--dsw-alias-label-tertiary); }
.dshws-mem-node[data-active="true"] .dshws-mem-node-icon { color: inherit; }
.dshws-mem-node-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-mem-remote-dot { font-size: 12px; }

/* ---------- 板块 ---------- */
.dshws-mem-panel { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden; }
.dshws-mem-panel[data-tone="accent"] { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-border-l2)); }
.dshws-mem-panel-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px; min-width: 0;
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 60%, transparent);
}
.dshws-mem-panel[data-open="true"] .dshws-mem-panel-head { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-mem-panel[data-tone="accent"] .dshws-mem-panel-head { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.dshws-mem-panel-toggle {
  display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; padding: 0; border: 0; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dshws-mem-panel-toggle[data-static="true"] { cursor: default; }
.dshws-mem-caret { flex: none; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary); transition: transform .15s; }
.dshws-mem-caret[data-open="true"] { transform: rotate(90deg); }
.dshws-mem-panel-icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--dsw-alias-bg-l1, transparent); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); }
.dshws-mem-panel[data-tone="accent"] .dshws-mem-panel-icon { color: var(--dsw-alias-state-business-primary); }
.dshws-mem-panel-titles { display: flex; flex-direction: column; min-width: 0; }
.dshws-mem-panel-title { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-mem-panel-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-mem-panel-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  font-size: 11px; font-weight: 500; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary);
}
.dshws-mem-panel[data-tone="accent"] .dshws-mem-panel-count { background: var(--dsw-alias-state-business-primary); color: #fff; }
.dshws-mem-panel-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.dshws-mem-panel-body { padding: 12px 14px 14px; min-width: 0; }

/* ---------- 列表 / 分节 ---------- */
.dshws-mem-list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dshws-mem-listbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshws-mem-sec { display: flex; flex-direction: column; gap: 8px; }
.dshws-mem-sec-head { display: flex; align-items: center; gap: 8px; }
.dshws-mem-sec-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sec-color, var(--dsw-alias-label-tertiary)); }
.dshws-mem-sec-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshws-mem-sec-head .dshws-mem-icon-btn { margin-left: auto; }
[data-section="goal"] { --sec-color: #2563eb; }
[data-section="constraints"] { --sec-color: #dc2626; }
[data-section="decisions"] { --sec-color: #7c3aed; }
[data-section="progress"] { --sec-color: #0891b2; }
[data-section="facts"] { --sec-color: #059669; }
[data-section="rejected"] { --sec-color: #9ca3af; }
[data-section="questions"] { --sec-color: #d97706; }
.dshws-mem-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }

/* ---------- 卡片 ---------- */
.dshws-mem-card {
  position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 12px 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-l1, transparent);
  cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s; outline: none;
}
.dshws-mem-card[data-static="true"] { cursor: default; }
.dshws-mem-card:not([data-static="true"]):hover, .dshws-mem-card:focus-visible {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-border-l2));
  box-shadow: 0 4px 14px rgba(0, 0, 0, .08); transform: translateY(-1px);
}
/* 左侧色条：置顶 / 重要一眼可见 */
.dshws-mem-card::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: transparent; }
.dshws-mem-card[data-importance="high"]::before { background: var(--dsw-alias-state-warning-primary, #d97706); }
.dshws-mem-card[data-pinned="true"]::before { background: var(--dsw-alias-state-business-primary); }
.dshws-mem-card[data-candidate="true"] { border-style: dashed; }
.dshws-mem-card[data-enabled="false"] { opacity: .62; }
.dshws-mem-card[data-enabled="false"] .dshws-mem-card-summary { text-decoration: line-through; }
.dshws-mem-card-head { display: flex; align-items: flex-start; gap: 6px; min-height: 18px; }
.dshws-mem-card-head .dshws-mem-meta { flex: 1 1 auto; }
.dshws-mem-card[data-bare="true"] .dshws-mem-card-head { position: absolute; top: 8px; right: 8px; min-height: 0; }
.dshws-mem-card[data-bare="true"] .dshws-mem-card-summary { padding-right: 52px; }
.dshws-mem-card[data-bare="true"] .dshws-mem-card-summary[data-sub="true"] { padding-right: 0; }
.dshws-mem-card-quick { display: flex; gap: 2px; flex: none; opacity: .55; transition: opacity .15s; }
.dshws-mem-card:hover .dshws-mem-card-quick, .dshws-mem-card:focus-within .dshws-mem-card-quick { opacity: 1; }
.dshws-mem-card-summary {
  font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.dshws-mem-card-title { font-size: 13px; font-weight: 600; line-height: 1.45; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 有标题时摘要退为次要文字、最多 2 行 */
.dshws-mem-card-summary[data-sub="true"] { font-size: 12px; color: var(--dsw-alias-label-secondary); -webkit-line-clamp: 2; }
.dshws-mem-card[data-bare="true"] .dshws-mem-card-title { padding-right: 52px; }
.dshws-mem-detail-title { font-size: 15px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); word-break: break-word; }
.dshws-mem-title-field { display: flex; flex-direction: column; gap: 4px; }
.dshws-mem-title-row { display: flex; align-items: center; gap: 8px; }
.dshws-mem-title-row .dshws-input { flex: 1 1 auto; min-width: 0; }
.dshws-mem-title-row button { flex: none; }
.dshws-mem-card-foot { margin-top: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshws-mem-card-foot-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dshws-mem-card-btns { display: inline-flex; gap: 6px; }
.dshws-mem-icon-btn {
  display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.dshws-mem-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshws-mem-icon-btn[data-on="true"] { color: var(--dsw-alias-state-business-primary); }
.dshws-mem-icon-btn:disabled { opacity: .5; cursor: progress; }

/* ---------- 标签 ---------- */
.dshws-mem-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.dshws-mem-badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; height: 20px; border-radius: 10px; font-size: 11px; white-space: nowrap;
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary);
}
.dshws-mem-badge[data-section]::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--sec-color); }
.dshws-mem-badge[data-tone="accent"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); color: var(--dsw-alias-state-business-primary); }
.dshws-mem-badge[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 16%, transparent); color: var(--dsw-alias-state-warning-primary, #d97706); }
.dshws-mem-badge[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dshws-mem-source { font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* ---------- 空状态 ---------- */
.dshws-mem-empty-state {
  display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 28px 12px; border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px; font-size: 13px; color: var(--dsw-alias-label-tertiary); text-align: center;
}
.dshws-mem-empty-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--dsw-alias-interactive-bg-hover); }
.dshws-mem-empty { padding: 12px 4px; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.dshws-mem-hint { flex: 1 1 auto; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }

/* ---------- 弹窗 ---------- */
.dshws-mem-detail-dialog.dshws-mem-detail-dialog { width: min(640px, 100%); max-height: 100%; }
.dshws-mem-detail-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; max-height: 64vh; overflow: auto; }
.dshws-mem-detail-content {
  padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-interactive-bg-hover);
  font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary);
}
.dshws-mem-detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshws-mem-inline-field { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshws-mem-kv { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.dshws-mem-kv-row { display: flex; gap: 8px; min-width: 0; font-size: 12px; }
.dshws-mem-kv-row dt { flex: none; color: var(--dsw-alias-label-tertiary); }
.dshws-mem-kv-row dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dshws-mem-kv-row code { font-size: 11px; }
.dshws-mem-dialog-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; flex-wrap: wrap; }
.dshws-mem-dialog-foot-left, .dshws-mem-dialog-foot-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshws-mem-dialog-foot .dshws-link-btn[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); }
.dshws-mem-history-block { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.dshws-mem-history { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dshws-mem-hrow { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-left: 2px solid var(--dsw-alias-border-l2); }
.dshws-mem-content { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.dshws-mem-content[data-muted="true"] { color: var(--dsw-alias-label-tertiary); }

/* ---------- 表单控件 ---------- */
.dshws-mem-select {
  height: 26px; padding: 0 4px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary);
}
.dshws-mem-textarea { width: 100%; min-height: 80px; resize: vertical; font: inherit; font-size: 13px; line-height: 1.6; box-sizing: border-box; }
.dshws-mem-edit { display: flex; flex-direction: column; gap: 8px; }
.dshws-mem-number { width: 72px; }
.dshws-mem-settings-dialog.dshws-mem-settings-dialog { width: min(640px, 100%); max-height: 100%; }
.dshws-mem-settings { display: flex; flex-direction: column; min-width: 0; }
.dshws-mem-model-select { height: 30px; width: 240px; max-width: 100%; font-size: 13px; }
.dshws-mem-flash {
  align-self: flex-start; margin-bottom: 4px; padding: 3px 10px; border-radius: 10px; font-size: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 14%, transparent); color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dshws-mem-flash[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); }

/* ---------- 会话顶部标签 ---------- */
.dshws-mem-tab { position: relative; display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 28px; max-width: 1080px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.dshws-mem-toast {
  position: sticky; top: 0; z-index: 2; align-self: center; padding: 4px 12px; border-radius: 12px; font-size: 12px;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-l1, #fff);
}

/* ---------- 会话顶部标签：看板 ---------- */
/* 外层 FitView 已钉成可视高度：看板占满，概览固定，四列各自滚动 */
/* min-width: 0 + width: 100%：否则长不换行文本（副标题、路径）会把整个看板撑得比视口还宽 */
/*
 * 响应式按「看板自身宽度」而不是视口：拖宽右侧栏 / 左侧栏挤压会话区时视口不变，@media 不会触发。
 * 外壳 .dshws-mem-board-host 声明为尺寸容器，下面的断点都用 @container memboard。
 */
.dshws-mem-board-host { container: memboard / inline-size; display: flex; flex-direction: column; flex: 1 1 auto; width: 100%; min-width: 0; height: 100%; min-height: 0; }
.dshws-mem-board { position: relative; display: flex; flex-direction: column; gap: 12px; width: 100%; min-width: 0; height: 100%; min-height: 0; padding: 12px 16px 14px; box-sizing: border-box; }
.dshws-mem-board > * { min-width: 0; }
.dshws-mem-overview {
  flex: none; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent), transparent 60%);
}
.dshws-mem-overview-main { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dshws-mem-overview-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.dshws-mem-ostat {
  display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; min-width: 0;
  padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-l1, transparent);
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dshws-mem-ostat:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2)); }
.dshws-mem-ostat-icon { grid-row: span 2; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshws-mem-ostat[data-tone="accent"] .dshws-mem-ostat-icon { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); color: var(--dsw-alias-state-business-primary); }
.dshws-mem-ostat-value { font-size: 16px; font-weight: 600; line-height: 1.2; color: var(--dsw-alias-label-primary); }
.dshws-mem-ostat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-mem-spin { width: 8px; height: 8px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: dshws-mem-spin .8s linear infinite; }
@keyframes dshws-mem-spin { to { transform: rotate(360deg); } }

/* 四列：待审核 / 会话（最宽）/ 项目 / 全局 */
.dshws-mem-cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.dshws-mem-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden; }
.dshws-mem-col[data-tone="accent"] { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-border-l2)); }
.dshws-mem-col-head {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 60%, transparent);
}
.dshws-mem-col[data-tone="accent"] .dshws-mem-col-head { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.dshws-mem-col[data-tone="accent"] .dshws-mem-panel-count { background: var(--dsw-alias-state-business-primary); color: #fff; }
.dshws-mem-col-head .dshws-mem-panel-titles { flex: 1 1 auto; }
.dshws-mem-col-actions { flex: none; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; }
.dshws-mem-col-add {
  display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-l1, transparent); color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dshws-mem-col-add:hover { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-border-l2)); }
.dshws-mem-col-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; }
/* 列里卡片单列排布，比页面里的网格更紧凑 */
.dshws-mem-col .dshws-mem-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; }
.dshws-mem-col .dshws-mem-list { gap: 10px; }
.dshws-mem-col .dshws-mem-card { padding: 10px 10px 8px; gap: 6px; }
.dshws-mem-col .dshws-mem-empty-state { padding: 22px 10px; }

/* 中等宽度：两列两行，看板内整体滚动（外壳高度已钉住） */
@container memboard (max-width: 1100px) {
  .dshws-mem-board { overflow-y: auto; }
  .dshws-mem-cols { flex: none; }
  .dshws-mem-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshws-mem-col { max-height: 520px; }
}

@container memboard (max-width: 640px) {
  /* 窄屏：概览数字变分段切换，一次只显示一列，列占满剩余高度 */
  .dshws-mem-board { height: 100%; overflow: hidden; padding: 8px 8px 10px; gap: 8px; }
  .dshws-mem-overview { padding: 10px; gap: 8px; }
  .dshws-mem-overview-main { flex-wrap: wrap; }
  .dshws-mem-cols { flex: 1 1 auto; }
  .dshws-mem-overview-main .dshws-mem-hero-sub { display: none; }
  .dshws-mem-overview-stats { gap: 4px; }
  .dshws-mem-ostat { grid-template-columns: 1fr; grid-template-rows: auto auto; justify-items: center; padding: 6px 2px; text-align: center; }
  .dshws-mem-ostat-icon { display: none; }
  .dshws-mem-ostat[data-active="true"] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
  .dshws-mem-ostat[data-active="true"] .dshws-mem-ostat-label { color: var(--dsw-alias-state-business-primary); }
  .dshws-mem-cols { display: flex; flex-direction: column; }
  .dshws-mem-col { display: none; max-height: none; flex: 1 1 auto; }
  .dshws-mem-col[data-active="true"] { display: flex; }
  .dshws-mem-col-head { padding: 8px 10px; }
  .dshws-mem-col-body { padding: 8px; }
}

@media (max-width: 640px) {
  .dshws-mem-split { grid-template-columns: minmax(0, 1fr); }
  .dshws-mem-tree { position: static; max-height: 40vh; }
  .dshws-mem-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshws-mem-hero-main { flex-wrap: wrap; }
  .dshws-mem-tab { padding: 8px 10px 20px; }
  .dshws-mem-grid { grid-template-columns: minmax(0, 1fr); }
  .dshws-mem-kv { grid-template-columns: minmax(0, 1fr); }
  .dshws-mem-panel-head { padding: 10px 12px; }
  .dshws-mem-panel-body { padding: 10px 12px 12px; }
}
`
