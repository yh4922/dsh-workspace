/*
 * @Description: 代码编辑器（Monaco）—— 语法高亮、编辑、Ctrl+S 保存、跟随宿主明暗主题
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/files/CodeEditor.tsx
 */
import { useEffect, useRef, useState } from 'react'
import type * as MonacoApi from 'monaco-editor'
import type { Translate } from '../context.js'
import { isLight, onHostThemeChange, resolveColor } from '../terminal/theme.js'
import { useEditorPref } from '../editor-prefs.js'
import { checkMonacoLayout, ensureMonacoCss, languageFor, languageOptions, loadMonaco, type AssetFetcher, type Monaco } from './monaco-loader.js'

export interface CodeEditorProps {
  t: Translate
  /** 远端路径（用于推断语言与模型标识）。 */
  path: string
  content: string
  readOnly: boolean
  /** 未保存状态变化时通知父组件（切换文件前提示丢弃）。 */
  onDirtyChange: (dirty: boolean) => void
  /** 保存；抛错表示失败（编辑器保持「未保存」）。 */
  onSave: (value: string) => Promise<void>
  /** 取编辑器资源的一段（经远程调用）。 */
  fetchAsset: AssetFetcher
  /** 父组件拿到保存入口（工具栏按钮用）。 */
  registerSave: (save: (() => Promise<void>) | null) => void
}

/** rgb()/rgba() → #rrggbb。Monaco 主题颜色只认十六进制。 */
function toHex(rgb: string): string {
  const m = rgb.match(/\d+(\.\d+)?/g)
  if (m === null || m.length < 3) return '#1e1e1e'
  return `#${m
    .slice(0, 3)
    .map((v) => Math.round(Number(v)).toString(16).padStart(2, '0'))
    .join('')}`
}

/** 以宿主背景色派生编辑器主题，让编辑器与页面融为一体，而不是一块突兀的纯黑/纯白。 */
function applyHostTheme(monaco: Monaco): void {
  const bg = resolveColor('var(--dsw-alias-bg-layer-1)', '#1e1e1e')
  const light = isLight(bg)
  monaco.editor.defineTheme('dshws', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': toHex(bg),
      'editorGutter.background': toHex(bg),
      'minimap.background': toHex(bg)
    }
  })
  monaco.editor.setTheme('dshws')
}

let modelSeq = 0

export function CodeEditor(props: CodeEditorProps) {
  const { t } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; message?: string; language?: string }>({
    phase: 'loading'
  })
  // 回调存 ref：编辑器只创建一次，但要始终调用最新的父组件回调。
  const latest = useRef(props)
  latest.current = props
  const [languages, setLanguages] = useState<Array<{ id: string; label: string }>>([])
  /** 手动切换语言：只改高亮方式，不动文件内容。 */
  const switchLanguage = useRef<(id: string) => void>(() => undefined)
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | undefined>(undefined)
  const [minimap, setMinimap] = useEditorPref('minimap')
  const minimapRef = useRef(minimap)
  minimapRef.current = minimap

  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: minimap } })
  }, [minimap])

  // 只读状态可在编辑器创建后变化（编辑器只建一次）：同步到 Monaco。
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly })
  }, [props.readOnly])

  useEffect(() => {
    let disposed = false
    let editor: MonacoApi.editor.IStandaloneCodeEditor | undefined
    let model: MonacoApi.editor.ITextModel | undefined
    let offTheme: (() => void) | undefined
    let savedVersion = 0
    let saving = false

    const setDirty = (): void => {
      if (model === undefined) return
      latest.current.onDirtyChange(model.getAlternativeVersionId() !== savedVersion)
    }

    const save = async (): Promise<void> => {
      if (model === undefined || saving || latest.current.readOnly) return
      if (model.getAlternativeVersionId() === savedVersion) return
      saving = true
      const version = model.getAlternativeVersionId()
      try {
        await latest.current.onSave(model.getValue())
        // 以「发起保存时」的版本为准：保存期间继续输入的内容仍算未保存。
        savedVersion = version
        setDirty()
      } finally {
        saving = false
      }
    }

    loadMonaco(latest.current.fetchAsset)
      .then((monaco) => {
        if (disposed || hostRef.current === null) return
        ensureMonacoCss(hostRef.current)
        applyHostTheme(monaco)
        offTheme = onHostThemeChange(() => applyHostTheme(monaco))

        const name = props.path.slice(props.path.lastIndexOf('/') + 1)
        const newline = props.content.indexOf('\n')
        const firstLine = newline === -1 ? props.content : props.content.slice(0, newline)
        const language = languageFor(monaco, name, firstLine)
        modelSeq += 1
        // 每个编辑器独占一个带序号的模型 URI：同一文件重新打开不会撞上旧模型。
        model = monaco.editor.createModel(props.content, language, monaco.Uri.parse(`dshws://${modelSeq}${encodeURI(props.path)}`))
        savedVersion = model.getAlternativeVersionId()
        editor = monaco.editor.create(hostRef.current, {
          model,
          readOnly: props.readOnly,
          automaticLayout: true,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
          // Monaco 异步加载期间开关可能被切换：读最新值。
          minimap: { enabled: minimapRef.current },
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          tabSize: 2,
          detectIndentation: true,
          wordWrap: 'off',
          unicodeHighlight: { ambiguousCharacters: false }
        })
        editorRef.current = editor
        const created = hostRef.current
        setTimeout(() => checkMonacoLayout(created), 0)
        // 创建期间 readOnly 可能已变（例如分支编辑方式刚取回）：以最新值为准。
        if (latest.current.readOnly !== props.readOnly) editor.updateOptions({ readOnly: latest.current.readOnly })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void save().catch(() => undefined)
        })
        model.onDidChangeContent(setDirty)
        latest.current.registerSave(save)
        setLanguages(languageOptions(monaco.languages.getLanguages()))
        const current = model
        switchLanguage.current = (id) => {
          monaco.editor.setModelLanguage(current, id)
          setState((s) => ({ ...s, language: id }))
        }
        setState({ phase: 'ready', language })
        if (!props.readOnly) editor.focus()
      })
      .catch((error: unknown) => {
        if (!disposed) setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      })

    return () => {
      disposed = true
      editorRef.current = undefined
      latest.current.registerSave(null)
      offTheme?.()
      editor?.dispose()
      model?.dispose()
    }
    // 编辑器与「路径 + 初始内容」绑定；重新加载文件时父组件用新 key 重建本组件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="dshws-code">
      {state.phase === 'loading' ? <div className="dshws-tree-note">{t('editor.loading')}</div> : null}
      {state.phase === 'error' ? (
        <div className="dshws-tree-note" data-tone="error">
          {t('editor.loadFailed', { message: state.message ?? '' })}
        </div>
      ) : null}
      <div className="dshws-code-host" ref={hostRef} style={{ display: state.phase === 'error' ? 'none' : 'block' }} />
      {state.phase === 'ready' ? (
        <div className="dshws-code-status">
          <select
            className="dshws-code-lang"
            value={state.language}
            title={t('editor.language')}
            aria-label={t('editor.language')}
            onChange={(e) => switchLanguage.current(e.target.value)}
          >
            {languages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="dshws-code-toggle"
            data-active={minimap}
            aria-pressed={minimap}
            title={t('editor.minimapHint')}
            onClick={() => setMinimap(!minimap)}
          >
            {t('editor.minimap')}
          </button>
          {props.readOnly ? <span>{t('editor.readOnly')}</span> : <span>{t('editor.saveHint')}</span>}
        </div>
      ) : null}
    </div>
  )
}
