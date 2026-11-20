/*
 * @Description: H5 抽屉 · Git 面板 —— 直接复用桌面 GitTab（会话顶部标签同款用法：不传 useTabInfo）
 * @Author: YangHeng
 * @Date: 2026-11-19 15:52:00
 * @FilePath: /dsh-workspace/src/mobile/sheet/GitPanel.tsx
 */
import { GitTab } from '../../client/sidebar/GitTab.js'
import { api, index, t, useWorkspaceReady } from './env.js'
import { openSheet } from './store.js'
import type { PanelProps } from './panel.js'

export default function GitPanel(props: PanelProps) {
  const ready = useWorkspaceReady(props.sessionId)
  if (ready !== 'ready') return <div className="m-sheet-note">{t('files.loading')}</div>
  return (
    <div className="m-sheet-fill">
      <GitTab
        t={t}
        api={api}
        index={index}
        sessionId={props.sessionId}
        openResource={(address) => {
          const p = index.resolveAddress(address)?.remotePath ?? index.resolveLocalAddress(address)?.path
          if (p !== undefined) openSheet({ tab: 'files', path: p })
        }}
      />
    </div>
  )
}
