/*
 * @Description: Monaco 对比视图（左右 / 上下切换、折叠未改动），只读
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/DiffView.tsx
 */
import { useEffect, useRef, useState } from 'react'
import type * as MonacoApi from 'monaco-editor'
import type { Translate } from '../context.js'
import { ensureMonacoCss, languageFor, loadMonaco, type AssetFetcher } from '../files/monaco-loader.js'
import { isLight, resolveColor } from '../terminal/theme.js'

export interface DiffViewProps {
  t: Translate
  path: string
  original: string
  modified: string
  fetchAsset: AssetFetcher
  sideBySide: boolean
  /** 折叠未改动的区域（类似 VS Code：只显示改动及上下文，其余可点开）。 */
  collapseUnchanged: boolean
}

/** 折叠未改动区域的参数：改动上下各保留 3 行上下文，不足 3 行的未改动段不折叠。 */
function hideUnchanged(enabled: boolean): MonacoApi.editor.IDiffEditorOptions['hideUnchangedRegions'] {
  return { enabled, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 }
}

export function DiffView(props: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoApi.editor.IStandaloneDiffEditor | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Monaco 异步加载期间开关可能被切换：创建时读最新值。
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    let disposed = false
    let models: MonacoApi.editor.ITextModel[] = []
    loadMonaco(props.fetchAsset)
      .then((monaco) => {
        if (disposed || hostRef.current === null) return
        ensureMonacoCss(hostRef.current)
        const bg = resolveColor('var(--dsw-alias-bg-layer-1)', '#1e1e1e')
        monaco.editor.setTheme(isLight(bg) ? 'vs' : 'vs-dark')
        const name = props.path.slice(props.path.lastIndexOf('/') + 1)
        const firstLine = props.modified.split('\n', 1)[0] ?? ''
        const language = languageFor(monaco, name, firstLine)
        const original = monaco.editor.createModel(props.original, language)
        const modified = monaco.editor.createModel(props.modified, language)
        models = [original, modified]
        const editor = monaco.editor.createDiffEditor(hostRef.current, {
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          renderSideBySide: latest.current.sideBySide,
          // 不让 Monaco 在窄时（默认 < 900px）自动改成上下视图：分栏右侧常不足 900px，
          // 那样「左右 / 上下」按钮点了没反应（用户实测踩到）。以用户选择为准。
          useInlineViewWhenSpaceIsLimited: false,
          fontSize: 12,
          minimap: { enabled: false },
          hideUnchangedRegions: hideUnchanged(latest.current.collapseUnchanged),
          scrollBeyondLastLine: false,
          renderOverviewRuler: false
        })
        editor.setModel({ original, modified })
        editorRef.current = editor
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
      for (const m of models) m.dispose()
    }
    // 内容变化时父组件用新 key 重建本组件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: props.sideBySide })
  }, [props.sideBySide])

  useEffect(() => {
    editorRef.current?.updateOptions({ hideUnchangedRegions: hideUnchanged(props.collapseUnchanged) })
  }, [props.collapseUnchanged])

  if (error !== null) return <div className="dshws-tree-note" data-tone="error">{props.t('editor.loadFailed', { message: error })}</div>
  return <div className="dshws-diff-host" ref={hostRef} />
}
