/*
 * @Description: 远程 Git 面板「本会话记住的仓库根」—— 容器目录工作区里选中的子目录，按会话存在浏览器本地
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/repo-root.ts
 *
 * 为什么按会话、存在浏览器：这是界面偏好（这个会话在哪个子目录里干活），不影响远程仓库；
 * 侧栏与会话顶部的「远程 Git」拿到的是同一个 sessionId，自然共用同一份设置。
 * 没有会话记录时回落到「最近一次选过的路径」（键不带后缀），新会话也能接着上次的位置。
 */

const PREFIX = 'dshws.git.repoRoot.'
const LAST = 'dshws.git.repoRoot'

interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(): KV | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** 去掉首尾空白与结尾斜杠；空串归一成 null（= 工作区根）。 */
function normalize(value: string | null): string | null {
  if (value === null) return null
  const v = value.trim().replace(/\/+$/, '')
  return v === '' ? null : v
}

/** 本会话上次选中的仓库根（线上路径）；没有会话记录时用全局兜底；都没有为 null。 */
export function getRepoRoot(sessionId: string, kv: KV | undefined = storage()): string | null {
  const own = normalize(kv?.getItem(PREFIX + sessionId) ?? null)
  return own ?? normalize(kv?.getItem(LAST) ?? null)
}

/** 记住本会话的仓库根；path 为 null 表示回到工作区根（同时清掉全局兜底）。 */
export function setRepoRoot(sessionId: string, path: string | null, kv: KV | undefined = storage()): void {
  if (kv === undefined) return
  const v = normalize(path)
  if (v === null) {
    kv.removeItem(PREFIX + sessionId)
    kv.removeItem(LAST)
    return
  }
  kv.setItem(PREFIX + sessionId, v)
  kv.setItem(LAST, v)
}
