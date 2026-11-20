/*
 * @Description: H5 会话 —— 文件卡片：present 工具交付的文件、用户消息里的文件附件
 * @Author: YangHeng
 * @Date: 2026-11-20 11:10:00
 * @FilePath: /dsh-workspace/src/mobile/chat/FileCard.tsx
 *
 * 结构类名与 chat.css 通用卡片约定一致（.c-card.c-filecard / .c-filecard-ic / -main / -go），组件特有补充在 cards.css。
 * 交付文件带宿主绝对路径，点击在底部抽屉的文件面板打开；用户附件只有附件 id 没有路径，只展示不可点。
 */
import type { PresentedFile } from '../data/transcript.js'
import { Icon } from '../icons.js'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i

/** 由文件名推断类型标签（大写扩展名），无扩展名时返回 undefined。 */
export function fileKind(name: string): string | undefined {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name)
  return m?.[1]?.toUpperCase()
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export interface FileCardProps {
  name: string
  path?: string
  description?: string
  bytes?: number
  onOpen?: (path: string) => void
}

export function FileCard({ name, path, description, bytes, onOpen }: FileCardProps) {
  const meta = [formatBytes(bytes), fileKind(name)].filter((s) => s !== undefined && s !== '').join(' · ')
  const clickable = path !== undefined && onOpen !== undefined
  const body = (
    <>
      <span className="c-filecard-ic">
        <Icon name={IMAGE_EXT.test(name) ? 'image' : 'fileText'} size={18} />
      </span>
      <span className="c-filecard-main">
        <b>{name}</b>
        {description !== undefined ? <span className="c-filecard-desc">{description}</span> : null}
        {path !== undefined ? <small title={path}>{path}</small> : meta !== '' ? <small>{meta}</small> : null}
      </span>
      {clickable ? <Icon name="chevronRight" size={16} className="c-filecard-go" /> : null}
    </>
  )
  if (!clickable) return <div className="c-card c-filecard" data-static="true">{body}</div>
  return (
    <a
      className="c-card c-filecard"
      href="#"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onOpen(path)
      }}
    >
      {body}
    </a>
  )
}

/** 一个 turn 的交付文件组。 */
export function FilesGroup({ files, onOpen }: { files: PresentedFile[]; onOpen: (path: string) => void }) {
  return (
    <div className="c-files">
      <div className="c-files-hd">
        <Icon name="paperclip" size={13} />
        <span>交付文件 · {files.length}</span>
      </div>
      {files.map((f, i) => (
        <FileCard key={`${f.path}#${i}`} name={f.name} path={f.path} {...(f.description !== undefined ? { description: f.description } : {})} onOpen={onOpen} />
      ))}
    </div>
  )
}
