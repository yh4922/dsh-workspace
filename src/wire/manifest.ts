/*
 * @Description: 宿主端 Typert 清单 —— 输入用 zod 严格校验，输出直通
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/wire/manifest.ts
 */
import { z } from 'zod'
import { PACKAGE, buildDescriptors, type Codec, type MethodName } from './contract.js'
import type { MethodIO } from './dto.js'

// 编译期保证 dto 的 MethodIO 与 contract 的 METHODS 一一对应，漏一个直接报错。
type AssertSameKeys<A, B> = [Exclude<keyof A, B>, Exclude<B, keyof A>] extends [never, never]
  ? true
  : never
const _methodsInSync: AssertSameKeys<MethodIO, MethodName> = true
void _methodsInSync

const empty = z.object({})

const id = z.string().min(1).max(200)
const port = z.number().int().min(1).max(65535)
const shortText = z.string().max(500)
const env = z.record(z.string().max(200), z.string().max(4000))

const authInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), password: z.string().max(4096).optional() }),
  z.object({
    kind: z.literal('keyPath'),
    keyPath: z.string().min(1).max(4096),
    passphrase: z.string().max(4096).optional(),
    clearPassphrase: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('keyContent'),
    // 私钥正文可能较长（RSA 4096 约 3.3KB），留足余量。
    keyContent: z.string().max(65536).optional(),
    passphrase: z.string().max(4096).optional(),
    clearPassphrase: z.boolean().optional()
  }),
  z.object({ kind: z.literal('agent') })
])

const proxyInput = z.object({
  kind: z.enum(['socks5', 'http']),
  host: z.string().min(1).max(500),
  port,
  username: shortText.optional(),
  password: z.string().max(4096).optional(),
  clearPassword: z.boolean().optional()
})

const saveHost = z.object({
  id: id.optional(),
  label: z.string().trim().min(1, '名称不能为空').max(200),
  hostname: z.string().trim().min(1, '主机地址不能为空').max(500),
  port,
  username: shortText.optional(),
  groupPath: z.string().max(500),
  jumpHostIds: z.array(id).max(8),
  startupCommand: z.string().max(4000).optional(),
  environmentVariables: env.optional(),
  notes: z.string().max(10000).optional(),
  auth: authInput.nullable().optional(),
  proxy: proxyInput.nullable().optional()
})

const saveGroup = z.object({
  path: z.string().trim().min(1, '分组路径不能为空').max(500),
  previousPath: z.string().max(500).optional(),
  username: shortText.optional(),
  port: port.optional(),
  jumpHostIds: z.array(id).max(8).optional(),
  startupCommand: z.string().max(4000).optional(),
  environmentVariables: env.optional(),
  auth: authInput.nullable().optional(),
  proxy: proxyInput.nullable().optional()
})

const password = z.string().min(1).max(1024)

/** 各方法的输入 schema。备份导入的主机结构较复杂，这里只校验外形，逐字段校验在 vault 内完成。 */
/** 远端绝对路径（进一步的规范化与校验在 remote-fs 里做）。 */
const remotePath = z.string().min(1).max(4096).startsWith('/')
/** 单段文件名。 */
const fileName = z.string().trim().min(1).max(255)

const INPUTS: Record<MethodName, z.ZodType> = {
  state: empty,
  initVault: z.object({ password }),
  unlock: z.object({ password }),
  lock: empty,
  changePassword: z.object({ oldPassword: password, newPassword: password }),
  saveHost,
  deleteHost: z.object({ id }),
  saveGroup,
  deleteGroup: z.object({ path: z.string().min(1).max(500) }),
  testConnection: z.object({ id }),
  disconnect: z.object({ id }),
  logs: z.object({ hostId: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).optional() }),
  clearLogs: z.object({ hostId: z.string().max(200).optional() }),
  forgetHostKey: z.object({ id }),
  exportVault: empty,
  importVault: z.object({
    hosts: z.array(z.record(z.string(), z.unknown())).max(10000).optional(),
    groups: z.array(z.record(z.string(), z.unknown())).max(10000).optional()
  }),
  openTerminal: z.object({
    hostId: id,
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(500),
    cwd: z.string().max(4096).optional(),
    title: z.string().max(200).optional()
  }),
  closeTerminal: z.object({ id }),
  renameTerminal: z.object({ id, title: z.string().trim().min(1).max(200) }),
  setTerminalKeepAlive: z.object({ id, keepAlive: z.boolean() }),
  clearRecentTerminals: empty,
  sftpHome: z.object({ hostId: id }),
  sftpList: z.object({ hostId: id, path: remotePath }),
  sftpRead: z.object({ hostId: id, path: remotePath }),
  sftpMkdir: z.object({ hostId: id, parent: remotePath, name: fileName }),
  sftpCreateFile: z.object({ hostId: id, parent: remotePath, name: fileName }),
  sftpRename: z.object({ hostId: id, path: remotePath, name: fileName }),
  sftpRemove: z.object({ hostId: id, path: remotePath }),
  sftpCopy: z.object({ hostId: id, source: remotePath, targetDir: remotePath }),
  sftpSearch: z.object({ hostId: id, root: remotePath, query: z.string().max(200) }),
  getPrefs: empty,
  setIgnore: z.object({ rules: z.array(z.string().max(500)).max(500) }),
  testDraft: saveHost,
  // 编辑器只允许编辑完整读入的文件（预览上限 1MB 可配），这里给足余量但仍设上限。
  sftpWrite: z.object({
    hostId: id,
    path: remotePath,
    content: z.string().max(16 * 1024 * 1024),
    expectedMtime: z.number().int().nonnegative().optional()
  }),
  editorAsset: z.object({ name: z.enum(['monaco.js', 'editor.worker.js']), index: z.number().int().min(0).max(1000) }),
  setTakeover: z.object({ enabled: z.boolean() }),
  createRemoteWorkspace: z.object({ hostId: id, remotePath, title: z.string().trim().min(1).max(120) }),
  remoteWorkspaces: z.object({}),
  previewUrl: z.object({ hostId: id, path: remotePath }),
  git: gitSchema(),
  setAutoUnlock: z.object({ enabled: z.boolean(), password: z.string().max(1024).optional() }),
  // 本地路径是否绝对、是否规范由 local/browse.ts 校验（Windows 与 POSIX 规则不同）。
  localList: z.object({ path: z.string().max(4096).optional() }),
  localMkdir: z.object({ parent: z.string().min(1).max(4096), name: fileName }),
  sftpReadData: z.object({ hostId: id, path: remotePath }),
  updateStatus: empty,
  updateCheck: z.object({ force: z.boolean().optional() }),
  updateInstall: z.discriminatedUnion('source', [
    z.object({ source: z.literal('latest') }),
    z.object({ source: z.literal('upload'), token: z.string().uuid() })
  ]),
  setFilesTakeover: z.object({ enabled: z.boolean() }),
  presentedFile: z.object({ sessionId: z.string().min(1).max(256), seq: z.number().int().nonnegative(), index: z.number().int().min(0).max(1000) })
}

/** 远程 Git 各操作的输入校验（路径是否在仓库内由 RemoteGit 再校验一次）。 */
function gitSchema() {
  const repoPath = z.string().min(1).max(4096)
  const hash = z.string().regex(/^[0-9a-f]{7,64}$/)
  // 查看分支用：只接受 HEAD 或完整引用名（宿主端再用 isViewableRef + rev-parse 校验一次）。
  const ref = z.string().min(1).max(255).regex(/^(HEAD|refs\/(heads|remotes|tags)\/.+)$/)
  const base = { hostId: id, root: remotePath, worktree: remotePath.optional() }
  return z.discriminatedUnion('op', [
    z.object({ ...base, op: z.literal('status') }),
    z.object({ ...base, op: z.literal('log'), skip: z.number().int().min(0).max(1_000_000), limit: z.number().int().min(1).max(1000), ref: ref.optional() }),
    z.object({ ...base, op: z.literal('tree'), ref, dir: z.string().max(4096) }),
    z.object({ ...base, op: z.literal('file'), ref, path: repoPath }),
    z.object({ ...base, op: z.literal('compare'), base: ref, target: ref }),
    z.object({ ...base, op: z.literal('branches') }),
    z.object({ ...base, op: z.literal('show'), hash, parent: hash.nullable() }),
    z.object({
      ...base,
      op: z.literal('diff'),
      target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('worktree'), path: repoPath, untracked: z.boolean().optional() }),
        z.object({ kind: z.literal('staged'), path: repoPath }),
        z.object({ kind: z.literal('commit'), hash, parent: hash.nullable(), path: repoPath, origPath: repoPath.optional() }),
        z.object({ kind: z.literal('branch'), ref, path: repoPath, origPath: repoPath.optional() })
      ])
    }),
    z.object({ ...base, op: z.literal('branchInfo'), ref }),
    z.object({ ...base, op: z.literal('branchChanges'), ref }),
    // 与编辑器保存同一上限（sftpWrite 也是 16MB 量级）；更大的文件不应在面板里编辑。
    z.object({ ...base, op: z.literal('branchSave'), ref, path: repoPath, content: z.string().max(16 * 1024 * 1024) }),
    z.object({ ...base, op: z.literal('branchRevert'), ref, paths: z.array(repoPath).min(1).max(5000) }),
    z.object({ ...base, op: z.literal('branchDiscard'), ref }),
    z.object({ ...base, op: z.literal('branchCommit'), ref, message: z.string().min(1).max(20_000) }),
    z.object({ ...base, op: z.literal('createBranch'), name: z.string().min(1).max(255), from: ref }),
    z.object({ ...base, op: z.literal('stage'), paths: z.array(repoPath).min(1).max(5000) }),
    z.object({ ...base, op: z.literal('unstage'), paths: z.array(repoPath).min(1).max(5000) }),
    z.object({ ...base, op: z.literal('discard'), tracked: z.array(repoPath).max(5000), untracked: z.array(repoPath).max(5000) }),
    z.object({ ...base, op: z.literal('commit'), message: z.string().min(1).max(20_000) })
  ])
}

/**
 * 宿主端 codec 直接持有真实的 zod schema（与 skill-mcp-panel 宿主端一致），
 * 而不是只带 parse 的包装 —— 网关除 parse 外可能还会读取 schema 的其他能力。
 * 输出用 z.unknown()：输出只来自本插件自身代码，严格校验反而可能误删字段。
 */
function zodCodec(typeSymbol: string, schema: z.ZodType): Codec {
  return {
    mode: 'strict',
    typeSymbol,
    schema: schema as unknown as Codec['schema'],
    create: () => schema as unknown as Codec['schema']
  }
}

const OUTPUT = z.unknown()

export const HOST_MANIFEST = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: buildDescriptors((symbol, method, side) =>
    side === 'in' ? zodCodec(symbol, INPUTS[method]) : zodCodec(symbol, OUTPUT)
  ),
  model: { services: [], events: [], objects: [] }
}
