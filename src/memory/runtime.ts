/*
 * @Description: 作用域记忆 —— 运行时装配（存储 / 归属 / 业务 / 后台总结 / 注入状态）
 * @Author: YangHeng
 * @Date: 2026-10-16 20:10:00
 * @FilePath: /dsh-workspace/src/memory/runtime.ts
 *
 * 宿主服务（workspaceRegistry / llm / sessionTitle / sessionQuery / agentDefaultModel）都是可选的：
 * 由 index.ts 在 ctx.inject 子作用域里填入 / 撤下，缺席时对应能力降级而不影响其余部分。
 */
import type { WorkspaceRuntime } from '../runtime.js'
import type { MemoryEntry, MemoryModelRef, MemoryOutputs } from '../wire/memory.js'
import { MemoryStore } from './store.js'
import { ScopeResolver, type RegisteredWorkspace } from './scope.js'
import { MemoryService, type SessionInfo } from './service.js'
import { Summarizer, TITLE_SYSTEM, cleanSuggestedTitle, streamText, type LlmLike } from './summarizer.js'
import { LocalGit } from '../local/local-git.js'
import { RemoteGit } from '../git/remote-git.js'

export interface MemoryHostRefs {
  workspaceRegistry?: { list(): Array<{ id: string; path: string; title?: string }> }
  llm?: LlmLike & {
    listProviders?(): Array<{ id: string; name?: string }>
    listModels?(provider: string): Promise<Array<{ id: string; name?: string }>>
  }
  sessionTitle?: { get(session: unknown): { title?: string } | undefined }
  sessionQuery?: { readSession(id: string): Promise<{ events?: readonly unknown[] }> }
  agentDefaultModel?: { currentSelection(): { provider?: string; model?: string } | undefined }
}

interface LiveSessionLike {
  header?: { cwd?: string; origin?: string }
  snapshotEvents?(): readonly unknown[]
  requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
}

/** 分支缓存保留多久（毫秒）：每轮结束会主动刷新，这只是兜底。 */
const BRANCH_TTL_MS = 5 * 60_000

export class MemoryRuntime {
  readonly refs: MemoryHostRefs = {}
  readonly scope: ScopeResolver
  readonly store: MemoryStore
  readonly service: MemoryService
  readonly summarizer: Summarizer
  /**
   * 会话记忆的「冻结版本」：只在新开 / 恢复 / 压缩后刷新。
   * 中途写入的会话记忆不立即进系统提示词 —— 助手写入时结果已在对话历史里，
   * 冻结能让提示词前缀保持稳定（命中缓存），压缩后才需要它兜底。
   */
  readonly frozen = new Map<string, MemoryEntry[]>()
  private readonly branches = new Map<string, { branch: string | undefined; at: number }>()

  constructor(private readonly rt: WorkspaceRuntime, root?: string) {
    this.scope = new ScopeResolver({
      listWorkspaces: async () => this.refs.workspaceRegistry?.list().map((w): RegisteredWorkspace => ({ id: w.id, path: w.path, ...(w.title !== undefined ? { title: w.title } : {}) })),
      sessionCwd: (sid) => this.sessionCwd(sid)
    })
    this.store = new MemoryStore({ ...(root !== undefined ? { root } : {}), projectOf: (sid) => this.scope.projectOf(sid) })
    this.summarizer = new Summarizer({
      store: this.store,
      projectOf: async (sid) => (await this.scope.ensure(sid)).projectId,
      events: (sid) => this.sessionEvents(sid),
      route: (sid, preferred) => this.route(sid, preferred),
      llm: () => this.refs.llm,
      log: (level, message) => this.rt.log[level]('', 'memory', message),
      onApplied: (sid, mode) => {
        // 压缩补漏 / 手动整理写入后，下一步就该带上最新的会话记忆
        if (mode !== 'turns') this.freeze(sid)
      }
    })
    this.service = new MemoryService({
      store: this.store,
      scope: this.scope,
      sessionInfo: (sid) => this.sessionInfo(sid),
      remoteOf: (p) => {
        const binding = this.rt.bindings.resolve(p)
        if (binding === undefined) return undefined
        const host = this.rt.vault.listHosts().find((h) => h.id === binding.hostId)
        return { hostId: binding.hostId, host: host === undefined ? binding.hostId : `${host.label} (${host.username ?? ''}@${host.hostname})`, remotePath: binding.remotePath }
      },
      listModels: async () => this.listModels(),
      reorganize: async (sid) => {
        if (!this.store.getSettings().enabled) return { started: false, reason: '记忆模块未启用。' }
        if (this.refs.llm === undefined) return { started: false, reason: '宿主模型服务不可用。' }
        await this.scope.ensure(sid)
        const started = this.summarizer.request({ sessionId: sid, mode: 'manual' })
        return started ? { started } : { started, reason: '该会话正在整理中，完成后会再整理一次。' }
      },
      isSummarizing: (sid) => this.summarizer.isRunning(sid),
      suggestTitle: (content) => this.suggestTitle(content)
    })
  }

  // ---------------------------------------------------------------- 宿主查询

  private liveSession(sid: string): LiveSessionLike | undefined {
    return this.rt.host.sessions?.get(sid) as LiveSessionLike | undefined
  }

  async sessionCwd(sid: string): Promise<string | undefined> {
    const cwd = this.liveSession(sid)?.header?.cwd ?? (await this.rt.host.sessionPersistence?.stat(sid))?.header?.cwd
    return cwd === '' ? undefined : cwd
  }

  private async sessionInfo(sid: string): Promise<SessionInfo> {
    const live = this.liveSession(sid)
    if (live !== undefined) {
      const title = this.refs.sessionTitle?.get(live)?.title
      if (title !== undefined && title !== '') this.store.rememberSessionTitle(sid, title)
      return { title: title !== undefined && title !== '' ? title : this.store.sessionTitle(sid) ?? sid, exists: true }
    }
    const persistence = this.rt.host.sessionPersistence
    const exists = persistence === undefined ? null : (await persistence.stat(sid)) !== undefined
    return { title: this.store.sessionTitle(sid) ?? sid, exists }
  }

  private async sessionEvents(sid: string): Promise<readonly unknown[] | undefined> {
    const live = this.liveSession(sid)
    if (typeof live?.snapshotEvents === 'function') return live.snapshotEvents()
    const query = this.refs.sessionQuery
    if (query !== undefined) return (await query.readSession(sid)).events
    const persistence = this.rt.host.sessionPersistence
    if (typeof persistence?.open !== 'function') return undefined
    const handle = await persistence.open(sid, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }

  /** 模型路由：设置里指定的 > 会话已记录的 > 宿主默认模型。 */
  private route(sid: string, preferred: MemoryModelRef | null): MemoryModelRef | undefined {
    if (preferred !== null) return preferred
    const config = this.liveSession(sid)?.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && typeof config.model === 'string') return { provider: config.provider, model: config.model }
    const selection = this.refs.agentDefaultModel?.currentSelection()
    if (typeof selection?.provider === 'string' && typeof selection.model === 'string') return { provider: selection.provider, model: selection.model }
    return undefined
  }

  /**
   * 可选的后台总结模型：与 DSH 模型选择器同源（llm.listProviders + listModels，见宿主 buildModelCatalog）。
   * 单个服务商列不出来时跳过它，不影响其余；已保存但目前列不出来的设置值也保留一项，避免下拉里看不到当前值。
   */
  private async listModels(): Promise<MemoryOutputs['models']> {
    const out: MemoryOutputs['models'] = []
    const llm = this.refs.llm
    const providers = (() => {
      try {
        return llm?.listProviders?.() ?? []
      } catch {
        return []
      }
    })()
    const groups = await Promise.all(
      providers.map(async (p) => {
        try {
          return { p, models: (await llm?.listModels?.(p.id)) ?? [] }
        } catch {
          return { p, models: [] }
        }
      })
    )
    for (const { p, models } of groups) {
      for (const m of models) {
        if (typeof m?.id !== 'string' || m.id === '') continue
        out.push({ provider: p.id, model: m.id, label: m.name ?? m.id, group: p.name ?? p.id })
      }
    }
    const current = this.store.getSettings().summarizerModel
    if (current !== null && !out.some((m) => m.provider === current.provider && m.model === current.model)) {
      out.push({ ...current, label: current.model, group: `${current.provider}（当前不可用）` })
    }
    return out
  }

  /**
   * 「AI 生成标题」：用 DSH 默认模型（与新建会话时选中的同一个）；没有默认模型时退回设置里的后台总结模型。
   * 界面上点按钮才调用，结果只是建议，由用户确认后随表单一起保存。
   */
  private async suggestTitle(content: string): Promise<string> {
    const llm = this.refs.llm
    if (llm === undefined) throw new Error('宿主模型服务不可用，无法生成标题。')
    const selection = this.refs.agentDefaultModel?.currentSelection()
    const route =
      typeof selection?.provider === 'string' && typeof selection.model === 'string'
        ? { provider: selection.provider, model: selection.model }
        : this.store.getSettings().summarizerModel
    if (route === null) throw new Error('没有可用的默认模型，请先在 DSH 里选择一个模型。')
    const text = await streamText(llm, { route, system: TITLE_SYSTEM, prompt: content.slice(0, 4000), maxTokens: 1000, timeoutMs: 60_000 })
    const title = cleanSuggestedTitle(text)
    if (title === '') throw new Error('模型没有给出标题，请重试或手动填写。')
    return title
  }

  // ---------------------------------------------------------------- 注入状态

  /** 刷新会话记忆的冻结版本（新开 / 恢复 / 压缩后调用）。 */
  freeze(sid: string): void {
    this.frozen.set(sid, this.store.list({ layer: 'session', sessionId: sid }))
  }

  forget(sid: string): void {
    this.frozen.delete(sid)
    this.branches.delete(sid)
  }

  branchOf(sid: string): string | undefined {
    return this.branches.get(sid)?.branch
  }

  /**
   * 读当前 git 分支并缓存。只有项目里存在「限定分支」的启用条目才去读（远程读要走一次 SSH）。
   * 失败一律当作读不到（限定了分支的条目不注入）。
   */
  async refreshBranch(sid: string, force = false): Promise<void> {
    const cached = this.branches.get(sid)
    if (!force && cached !== undefined && Date.now() - cached.at < BRANCH_TTL_MS) return
    const { projectId, cwd } = await this.scope.ensure(sid)
    if (projectId === null || cwd === undefined) return
    const needs = this.store.list({ layer: 'project', projectId }).some((e) => e.enabled && e.branches !== undefined && e.branches.length > 0)
    if (!needs) {
      this.branches.set(sid, { branch: undefined, at: Date.now() })
      return
    }
    let branch: string | undefined
    try {
      const binding = this.rt.bindings.resolve(cwd)
      if (binding !== undefined) branch = await new RemoteGit(this.rt, binding.hostId, binding.remotePath).currentBranch()
      else branch = await new LocalGit(cwd).currentBranch()
    } catch {
      branch = undefined
    }
    this.branches.set(sid, { branch, at: Date.now() })
  }

  dispose(): void {
    this.summarizer.dispose()
  }
}

export type { LiveSessionLike }
