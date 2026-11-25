// Readable names and grouping. Pure: built from `orca worktree ps`, `bot list`, `bot chats`.
import { firstLine, type Bot, type Chat, type PsAgent, type PsWorktree } from './orca-source'
import type { Item } from './state'

export type GroupMode = 'project' | 'bot'
export const MINE = '我的会话'

export type Place = {
  name?: string
  project?: string
  workspace?: string
  branch?: string
  /** Bot this belongs to (its home chat, a workspace it owns, or a worker it dispatched). */
  bot?: string
  agent?: string
  botChat: boolean
  dispatched: boolean
  worktreeId?: string
  lastMessage?: string
  /** The chat tab's own title (bot chats). */
  tab?: string
}

const GENERIC = new Set(['agent', 'claude', 'claude code', 'codex', 'opencode', 'gemini', 'terminal', 'chat', 'zsh', 'bash', 'new session', '~'])
export function isGeneric(s: string | null | undefined, kind?: string | null): boolean {
  const t = s?.trim().toLowerCase()
  return !t || GENERIC.has(t) || t === kind?.toLowerCase()
}

export const shortBranch = (b: string | null | undefined): string | undefined => b?.replace(/^refs\/heads\//, '') || undefined

/** Orca chats: `structured-agent-session-<orcaSessionId>:<tab>`. */
export const chatIdOf = (paneKey: string): string | undefined => /^structured-agent-session-([0-9a-f-]{36})/.exec(paneKey)?.[1]

/** A person's prompt, not the mail header or preamble Orca puts in front of dispatched work. */
function promptName(p: string | null | undefined): string | undefined {
  if (!p) return undefined
  const subject = /^Subject:\s*(.+)$/m.exec(p)?.[1]
  return firstLine(/^\s*────/.test(p) ? subject : p, 30)
}

export class Directory {
  private worktrees: PsWorktree[] = []
  private chatTitles = new Map<string, string>()
  private chatBots = new Map<string, string>()
  private panes = new Map<string, { agent: PsAgent; wt: PsWorktree }>()
  bots: Bot[] = []

  update(d: { worktrees?: PsWorktree[]; bots?: Bot[]; chats?: Map<string, Chat[]> }): void {
    if (d.bots) this.bots = d.bots
    if (d.chats) {
      for (const [bot, list] of d.chats) {
        for (const c of list) {
          this.chatBots.set(c.id, bot)
          if (c.title) this.chatTitles.set(c.id, c.title)
        }
      }
    }
    if (d.worktrees) {
      this.worktrees = d.worktrees
      this.panes.clear()
      for (const wt of d.worktrees) for (const agent of wt.agents ?? []) this.panes.set(agent.paneKey, { agent, wt })
    }
  }

  has(paneKey: string): boolean {
    return this.panes.has(paneKey)
  }

  agents(): { agent: PsAgent; wt: PsWorktree }[] {
    return [...this.panes.values()]
  }

  botHome(botName: string): PsWorktree | undefined {
    return this.worktrees.find((w) => w.botHome && w.bot === botName)
  }

  worktree(id: string | undefined): PsWorktree | undefined {
    return id ? this.worktrees.find((w) => w.worktreeId === id) : undefined
  }

  /** What a waiting agent is asking, as far as `worktree ps` shows it. */
  asking(paneKey: string): string | undefined {
    const a = this.panes.get(paneKey)?.agent
    if (!a) return undefined
    const input = a.toolInput == null ? '' : typeof a.toolInput === 'string' ? a.toolInput : JSON.stringify(a.toolInput)
    const tool = a.toolName && a.state !== 'done' ? `${a.toolName}${input ? `：${input.slice(0, 400)}` : ''}` : ''
    return [tool, a.lastAssistantMessage?.slice(0, 1500)].filter(Boolean).join('\n\n') || undefined
  }

  /** The bot at the top of the dispatch chain. */
  private dispatcher(paneKey: string | null | undefined): string | undefined {
    for (let key = paneKey, i = 0; key && i < 8; i++) {
      const p = this.panes.get(key)
      if (!p) return undefined
      if (p.wt.botHome && p.wt.bot) return p.wt.bot
      key = p.agent.parentPaneKey
    }
    return undefined
  }

  place(paneKey: string, tabTitle?: string): Place | undefined {
    const p = this.panes.get(paneKey)
    if (!p) {
      // A bot chat with no open tab (an automation's run, say) is not in `worktree ps`.
      const id = chatIdOf(paneKey)
      const owner = id && this.chatBots.get(id)
      if (!id || !owner) return undefined
      const t = this.chatTitles.get(id)
      const home = this.botHome(owner)
      return { name: t && t !== owner ? `${owner} · ${t}` : owner, tab: t, project: home?.repo ?? undefined, workspace: home?.displayName ?? undefined, bot: owner, botChat: true, dispatched: false, worktreeId: home?.worktreeId }
    }
    const { agent, wt } = p
    const kind = agent.agentType ?? undefined
    const good = (s: string | null | undefined) => (isGeneric(s, kind) ? undefined : s!.trim())
    // A terminal a person opened in a bot's folder is not that bot's chat.
    const botChat = !!(wt.botHome && wt.bot && chatIdOf(paneKey))
    const bot = wt.bot ?? this.dispatcher(agent.parentPaneKey)
    let name: string | undefined
    let tab: string | undefined
    if (botChat) {
      const chat = this.chatTitles.get(agent.orcaSessionId ?? '') ?? good(agent.activity?.title) ?? good(agent.conversationName)
      tab = chat
      name = chat && chat !== wt.bot ? `${wt.bot} · ${chat}` : wt.bot!
    } else {
      name = good(agent.taskTitle) ?? good(agent.displayName) ?? good(tabTitle) ?? good(agent.conversationName) ?? promptName(agent.prompt) ?? good(wt.displayName)
    }
    return {
      name,
      project: wt.repo ?? undefined,
      workspace: wt.displayName ?? undefined,
      branch: shortBranch(wt.branch),
      bot: bot ?? undefined,
      agent: kind,
      botChat,
      dispatched: !botChat && !!(agent.parentPaneKey || agent.taskTitle),
      worktreeId: wt.worktreeId,
      lastMessage: firstLine(agent.lastAssistantMessage),
      tab: tab ?? (chatIdOf(paneKey) ? (good(agent.activity?.title) ?? good(agent.conversationName) ?? good(agent.taskTitle)) : undefined)
    }
  }
}

/** Never a bare "Agent": what we show before the directory knows the pane. */
export function fallbackName(i: Pick<Item, 'title' | 'workspace' | 'agent'>): string {
  if (!isGeneric(i.title, i.agent)) return i.title
  return i.workspace ?? (i.agent ? `${i.agent} 会话` : '未命名会话')
}

const KIND_LABEL: Record<string, string> = { bot_item: '待你决定', plugin: '插件', automation: '自动化', gate: '编排' }

export function secondary(i: Item): string {
  if (i.kind && i.kind !== 'session') return KIND_LABEL[i.kind]
  const where = [i.botChat ? undefined : i.workspace, i.branch].filter(Boolean).join(' / ')
  return [i.agent, where, i.dispatched && i.bot ? `由 ${i.bot} 派出` : undefined].filter(Boolean).join(' · ')
}

export type Counts = { needs_you: number; failed: number; done: number; working: number }
export type Section = { name?: string; ids: string[] }
export type Group = { key: string; name: string; counts: Counts; collapsed: boolean; sections: Section[] }

const RANK: Record<Item['state'], number> = { needs_you: 0, failed: 1, done: 2, interrupted: 2, working: 4 }
const rank = (i: Item): number => (i.state === 'needs_you' || i.state === 'working' || i.unread ? RANK[i.state] : 5)
// Newest prompt first, so one that just arrived is never below the fold; the rest oldest first.
const byRank = (a: Item, b: Item): number => rank(a) - rank(b) || (rank(a) === 0 ? b.stateSince - a.stateSince : a.stateSince - b.stateSince)

/** The tree the card and menu draw. `toggled` holds groups the person opened/closed by hand. */
export function buildGroups(items: Item[], mode: GroupMode, toggled: Map<string, boolean> = new Map()): Group[] {
  const buckets = new Map<string, Item[]>()
  for (const i of items) {
    const name = mode === 'bot' ? (i.bot ?? MINE) : (i.project ?? (i.bot ? 'Bots' : i.kind && i.kind !== 'session' ? 'Orca' : '其他'))
    buckets.set(name, [...(buckets.get(name) ?? []), i])
  }
  const groups = [...buckets].map(([name, list]) => {
    const sorted = [...list].sort(byRank)
    const sections = new Map<string, string[]>()
    for (const i of sorted) {
      const sub = mode === 'project' ? (name === 'Bots' ? (i.bot ?? '') : (i.workspace ?? '')) : ''
      sections.set(sub, [...(sections.get(sub) ?? []), i.id])
    }
    const counts: Counts = { needs_you: 0, failed: 0, done: 0, working: 0 }
    for (const i of list) {
      if (i.state === 'needs_you') counts.needs_you++
      else if (i.state === 'working') counts.working++
      else if (i.unread) counts[i.state === 'failed' ? 'failed' : 'done']++
    }
    const key = `${mode}:${name}`
    const idle = counts.needs_you + counts.failed + counts.done + counts.working === 0
    const group: Group = { key, name, counts, collapsed: toggled.get(key) ?? idle, sections: [...sections].map(([n, ids]) => ({ ...(n ? { name: n } : {}), ids })) }
    return { group, top: sorted[0] }
  })
  return groups.sort((a, b) => byRank(a.top, b.top)).map((g) => g.group)
}
