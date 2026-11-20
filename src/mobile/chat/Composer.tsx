/*
 * @Description: H5 会话 —— 输入框：多行自增高、粘贴 / 选择附件（chip 可删、图片缩略图）、发送 / 停止、模型下拉
 * @Author: YangHeng
 * @Date: 2026-11-19 17:20:00
 * @FilePath: /dsh-workspace/src/mobile/chat/Composer.tsx
 *
 * 发送：图片（png/jpeg/gif/webp 且 ≤4MB）直接 base64 内联 {type:'image'}；其余先 uploadFile 拿 receiptId → {type:'file'}。
 * 运行中发送用 steer（插入当前回合），空闲用 queue。
 */
import { useEffect, useRef, useState } from 'react'
import { newRpcId, rpc, uploadFile } from '../net/rpc.js'
import type { ImageAtt, FileAtt } from '../data/transcript.js'
import { Icon } from '../icons.js'

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const INLINE_IMAGE_MAX = 4 * 1024 * 1024

interface Att {
  id: string
  file: File
  name: string
  isImage: boolean
  url?: string
}

export interface OutgoingPrompt {
  requestId: string
  text: string
  images: ImageAtt[]
  files: FileAtt[]
}

export interface ComposerProps {
  sessionId: string
  running: boolean
  /** 乐观显示：发送开始。 */
  onSending(p: OutgoingPrompt): void
  /** 发送结果：ok=宿主已接收。 */
  onSent(requestId: string, ok: boolean, error?: string): void
  onStop(): Promise<void>
  model: ModelPickerProps
  onFocus?(): void
}

let attSeq = 0

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error ?? new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

function clientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export function Composer(props: ComposerProps) {
  const { sessionId, running } = props
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Att[]>([])
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 自增高：1 行起，最多约 6 行（16px × 1.5 × 6 + 上下内边距 ≈ 160），之后内部滚动。
  useEffect(() => {
    const ta = taRef.current
    if (ta === null) return
    ta.style.height = 'auto'
    // scrollHeight 不含边框，需补上 offsetHeight - clientHeight（现在无边框为 0，保留以防样式再改）
    const border = ta.offsetHeight - ta.clientHeight
    ta.style.height = `${Math.min(ta.scrollHeight + border, 160)}px`
  }, [text])

  useEffect(() => () => atts.forEach((a) => a.url !== undefined && URL.revokeObjectURL(a.url)), [])

  useEffect(() => {
    if (!running) setStopping(false)
  }, [running])

  const addFiles = (files: Iterable<File>): void => {
    const next: Att[] = []
    for (const f of files) {
      const isImage = f.type.startsWith('image/')
      const name = f.name !== '' ? f.name : isImage ? `image-${Date.now()}.${f.type.split('/')[1] ?? 'png'}` : 'file'
      next.push({ id: `a${++attSeq}`, file: f, name, isImage, url: isImage ? URL.createObjectURL(f) : undefined })
    }
    if (next.length > 0) setAtts((cur) => [...cur, ...next])
  }

  const removeAtt = (id: string): void => {
    setAtts((cur) =>
      cur.filter((a) => {
        if (a.id === id && a.url !== undefined) URL.revokeObjectURL(a.url)
        return a.id !== id
      })
    )
  }

  const canSend = text.trim() !== '' || atts.length > 0

  const send = async (): Promise<void> => {
    if (!canSend) return
    const body = text.trim()
    const sending = atts
    const requestId = newRpcId()
    setText('')
    setAtts([])
    setError(undefined)
    props.onSending({
      requestId,
      text: body,
      images: sending.filter((a) => a.isImage).map((a) => ({ url: a.url, name: a.name })),
      files: sending.filter((a) => !a.isImage).map((a) => ({ name: a.name, bytes: a.file.size }))
    })
    try {
      const content: object[] = []
      if (body !== '') content.push({ type: 'text', text: body })
      for (const a of sending) {
        if (a.isImage && INLINE_IMAGE_TYPES.has(a.file.type) && a.file.size <= INLINE_IMAGE_MAX) {
          content.push({ type: 'image', mediaType: a.file.type, data: await readBase64(a.file), name: a.name })
        } else {
          const r = await uploadFile(sessionId, a.file, a.name, a.isImage)
          content.push({ type: 'file', receiptId: r.receiptId })
        }
      }
      const tz = clientTimeZone()
      await rpc('session/prompt', {
        request: { requestId, sessionId, mode: running ? 'steer' : 'queue', content, ...(tz !== undefined ? { clientTimeZone: tz } : {}) }
      })
      props.onSent(requestId, true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '发送失败'
      setError(msg)
      props.onSent(requestId, false, msg)
      // 失败把文字还回输入框（用户没开始写新内容时）。
      setText((cur) => (cur === '' ? body : cur))
    }
  }

  const stop = (): void => {
    if (stopping) return
    setStopping(true)
    props.onStop().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : '停止失败')
      setStopping(false)
    })
  }

  // 结构：错误条在容器外；附件 chip、textarea、工具条同在一个 .c-box 里，聚焦时整框高亮（主流移动 Agent App 的输入形态）。
  return (
    <div className="c-comp">
      {error !== undefined ? (
        <div className="c-comp-err" onClick={() => setError(undefined)}>
          {error}
        </div>
      ) : null}
      <div className="c-box">
        {atts.length > 0 ? (
          <div className="c-att">
            {atts.map((a) =>
              a.isImage && a.url !== undefined ? (
                <span key={a.id} className="c-att-im">
                  <img src={a.url} alt={a.name} />
                  <button type="button" aria-label="移除" onClick={() => removeAtt(a.id)}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ) : (
                <span key={a.id} className="c-att-fc">
                  <Icon name="fileText" size={16} />
                  <span>{a.name}</span>
                  <button type="button" aria-label="移除" onClick={() => removeAtt(a.id)}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              )
            )}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          className="c-input"
          rows={1}
          value={text}
          placeholder={running ? '补充说明（插入当前回合）…' : '输入消息，可粘贴图片或文件'}
          onChange={(e) => setText(e.target.value)}
          onFocus={props.onFocus}
          onPaste={(e) => {
            const files = e.clipboardData?.files
            if (files !== undefined && files.length > 0) {
              e.preventDefault()
              addFiles(Array.from(files))
            }
          }}
        />
        <div className="c-tb">
          <button type="button" className="c-tb-btn" aria-label="添加附件" onClick={() => fileRef.current?.click()}>
            <Icon name="paperclip" size={18} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files !== null) addFiles(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
          <ModelPicker {...props.model} />
          <span className="c-sp" />
          {/* 运行中有草稿时提示发送语义（steer），否则用户会以为要排到下一轮 */}
          {running && canSend ? <span className="c-hint">插入当前回合</span> : null}
          {running ? (
            <button type="button" className="c-stop" aria-label="停止" title="停止" disabled={stopping} onClick={stop}>
              <i />
            </button>
          ) : null}
          {canSend || !running ? (
            <button type="button" className="c-send" aria-label="发送" disabled={!canSend} onClick={() => void send()}>
              <Icon name="arrowUp" size={18} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 模型下拉（原生 select：手机上体验最好）

export interface CatalogModel {
  id: string
  name: string
  reasoning?: { defaultEffort?: string }
}
export interface CatalogGroup {
  id: string
  name: string
  models: CatalogModel[]
}
export interface ModelCatalog {
  default?: { provider: string; model: string }
  groups: CatalogGroup[]
}

export interface ModelPickerProps {
  catalog?: ModelCatalog
  current?: { provider: string; model: string }
  onSelect(provider: string, model: CatalogModel): void
  busy?: boolean
}

const SEP = '\u0001'

function ModelPicker({ catalog, current, onSelect, busy }: ModelPickerProps) {
  const cur = current ?? catalog?.default
  const found = cur === undefined ? undefined : catalog?.groups.find((g) => g.id === cur.provider)?.models.find((m) => m.id === cur.model)
  const label = found?.name ?? cur?.model ?? '模型'
  return (
    <label className="c-model" data-busy={busy === true}>
      <span>{label}</span>
      <Icon name="chevronDown" size={14} />
      <select
        value={cur !== undefined ? `${cur.provider}${SEP}${cur.model}` : ''}
        disabled={catalog === undefined || busy === true}
        onChange={(e) => {
          const [provider, model] = e.target.value.split(SEP)
          const m = catalog?.groups.find((g) => g.id === provider)?.models.find((x) => x.id === model)
          if (provider !== undefined && m !== undefined) onSelect(provider, m)
        }}
      >
        {cur !== undefined && found === undefined ? <option value={`${cur.provider}${SEP}${cur.model}`}>{cur.model}</option> : null}
        {catalog?.groups.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {g.models.map((m) => (
              <option key={m.id} value={`${g.id}${SEP}${m.id}`}>
                {m.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
