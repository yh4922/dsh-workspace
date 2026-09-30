/*
 * @Description: upload_to_remote 的目标路径解析与受保护目标规则（纯函数）
 * @Author: YangHeng
 * @Date: 2026-09-30 00:00:00
 * @FilePath: /dsh-workspace/src/agent/upload-path.ts
 *
 * 目标路径只接受「相对远程工作区根」的写法，逐段校验而不是 normalize 之后再判断：
 * `a/../b` 规范化后合法，但这种写法没有正当用途，一律拒绝，审计时一眼能看懂。
 * 这里只做本机侧的字面校验；符号链接逃逸由远端 realpath 校验兜住（sftp/confined-upload.ts）。
 */

/** 上传工具的错误：带 code，模型与日志都能据此识别。 */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

const MAX_PATH_BYTES = 4096
const MAX_SEGMENT_BYTES = 255

/**
 * 解析目标路径为路径段（最后一段是文件名）。
 * @param input 模型给出的 target_path
 * @returns 非空路径段数组，已去掉 `.` 与空段
 * @throws UploadError(UPLOAD_BAD_TARGET)
 */
export function parseUploadTarget(input: unknown): string[] {
  const bad = (why: string): UploadError =>
    new UploadError(`invalid target_path ${JSON.stringify(input)}: ${why}; use a path relative to the remote workspace root, e.g. "public/logo.png"`, 'UPLOAD_BAD_TARGET')
  if (typeof input !== 'string') throw bad('expected a string')
  const raw = input.trim()
  if (raw === '') throw bad('empty path')
  if (Buffer.byteLength(raw) > MAX_PATH_BYTES) throw bad('path too long')
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw bad('control characters are not allowed')
  // 双向控制符 / 零宽字符 / BOM：能让文件名与审计日志「显示的」和「实际的」不一致（如 a\u202Egnp.exe 显示成 aexe.png）。
  if (/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(raw)) throw bad('invisible or bidirectional control characters are not allowed')
  // 远端是 POSIX：反斜杠在那里是普通字符，模型写 a\b 多半想的是两级目录，歧义不如直接拒绝。
  if (raw.includes('\\')) throw bad('backslashes are not allowed')
  if (raw.startsWith('/')) throw bad('absolute paths are not allowed')
  if (raw.startsWith('~')) throw bad('home-relative paths are not allowed')
  if (/^[a-zA-Z]:/.test(raw)) throw bad('local drive paths are not allowed')
  // 结尾是 / 或 /.（a/. 按段解析会变成文件 a，而模型的本意多半是目录 a）。
  if (raw.endsWith('/') || raw === '.' || raw.endsWith('/.')) throw bad('the path must name a file, not a directory')

  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw bad('".." is not allowed')
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) throw bad('a path segment is longer than 255 bytes')
    segments.push(segment)
  }
  if (segments.length === 0) throw bad('the path must name a file')
  return segments
}

/**
 * 任意层级出现即受保护的目录名：写 .git/hooks 等于下次 git 操作时在远端执行代码；.ssh 可成为持久化后门；
 * .husky 里的钩子会被 git 自动执行。
 */
const PROTECTED_DIRS = new Set(['.git', '.ssh', '.gnupg', '.husky'])
/** 任意位置都受保护的文件名（.envrc 会被 direnv 在进入目录时自动执行）。 */
const PROTECTED_FILES = new Set(['authorized_keys', 'authorized_keys2', '.envrc'])

/**
 * 判断目标是否落在受保护位置。
 * @param segments 相对工作区根的路径段（最后一段是文件名）
 * @param home 远端家目录的真实路径与目标的真实路径（取不到家目录时省略）：
 *   目标位于家目录下、且紧接家目录的那一段以 . 开头（.bashrc、.config/autostart/…）时拒绝 ——
 *   这些位置在登录时执行代码。按真实路径判断，与工作区根是家目录本身、它的上级（/home、/）还是链接无关。
 * @returns 命中时返回原因，否则 undefined
 */
export function protectedTargetReason(
  segments: readonly string[],
  home?: { realRoot: string; realTarget: string; home: string | undefined }
): string | undefined {
  // 比较时忽略大小写：远端区分大小写，但宁可多拒绝一个 .GIT，也不要漏掉大小写不敏感的挂载盘。
  const lower = segments.map((s) => s.toLowerCase())
  const dirHit = lower.slice(0, -1).find((s) => PROTECTED_DIRS.has(s))
  if (dirHit !== undefined) return `writing inside ${dirHit}/ is not allowed`
  const name = lower[lower.length - 1] as string
  if (PROTECTED_DIRS.has(name)) return `"${name}" is a protected name`
  if (PROTECTED_FILES.has(name)) return `writing ${name} is not allowed`
  return home === undefined ? undefined : homeDotReason(home.realRoot, home.realTarget, home.home)
}

/**
 * 目标是否是「家目录下紧接的点文件 / 点目录」里的东西。
 * 只在工作区根是家目录本身或其上级时适用：用户把工作区根设在 ~/.dotfiles 这类点目录里时，是有意在那里工作。
 */
function homeDotReason(realRoot: string, realTarget: string, home: string | undefined): string | undefined {
  if (home === undefined || home === '') return undefined
  const base = home.length > 1 ? home.replace(/\/+$/, '') : home
  const root = realRoot.length > 1 ? realRoot.replace(/\/+$/, '') : realRoot
  const rootAtOrAboveHome = root === base || root === '/' || base.startsWith(`${root}/`)
  if (!rootAtOrAboveHome) return undefined
  const prefix = base === '/' ? '/' : `${base}/`
  if (!realTarget.startsWith(prefix)) return undefined
  const first = realTarget.slice(prefix.length).split('/')[0] ?? ''
  if (!first.startsWith('.')) return undefined
  return `"${first}" directly under the remote home directory ${base} runs at login (.bashrc, .profile, .config/autostart, …); writing there is not allowed`
}
