// Source "orca": things Orca itself wants you to see, read through the `orca` CLI (no plugin
// event exists for them). Never reads Orca's databases: the bot-items WAL is only a change signal.
// Any failure leaves the last good data in place; the island keeps working without this source.
import { execFile } from 'node:child_process'
import { unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export type ExternalKind = 'bot_item' | 'plugin' | 'automation' | 'gate'
export type External = {
  id: string
  kind: ExternalKind
  /** Changes when you are being asked something new: re-announces. */
  version: string
  state: 'needs_you' | 'failed'
  title: string
  detail?: string
  options?: string[]
  question?: string
  /** One block per question the bot asked, each with its own replies. */
  asks?: Ask[]
  intro?: string
  /** The chat the item belongs to: where Orca shows its answer buttons. */
  tab?: string
  since: number
  botId?: string
  botName?: string
  /** Workspace id the entry belongs to, as `worktree ps` names it. */
  worktreeId?: string
  openUrl?: string
}

export type Bot = { id: string; name: string }
export type PsAgent = {
  paneKey: string
  orcaSessionId?: string | null
  parentPaneKey?: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  agentType?: string | null
  prompt?: string | null
  taskTitle?: string | null
  displayName?: string | null
  conversationName?: string | null
  lastAssistantMessage?: string | null
  toolName?: string | null
  toolInput?: unknown
  mainAgent?: { state: 'working' | 'blocked' | 'waiting' | 'done'; outcome?: string; stateStartedAt: number } | null
  structuredHostOwned?: boolean
  activity?: { title?: string | null } | null
}
export type PsWorktree = {
  worktreeId: string
  repo?: string | null
  path?: string
  branch?: string | null
  bot?: string | null
  botHome?: boolean | null
  displayName?: string | null
  agents?: PsAgent[]
}
export type Chat = { id: string; title?: string | null }

type Any = Record<string, any>
export const botUrl = (botId: string): string => `orca://bot/${botId}`

// ---- pure parsers (tested on recorded shapes) ---------------------------------------------------

export function parseBotItems(result: Any, now: number): External[] {
  const bot: Bot = { id: result.botId, name: result.botName }
  return ((result.items ?? []) as Any[])
    .filter((i) => i.status === 'needs_you' && !(i.snoozedUntil && i.snoozedUntil > now))
    .map((i) => {
      const q = i.question as Any | null
      const options = ((q?.decisions ?? []) as Any[]).flatMap((d) => ((d.replies ?? []) as Any[]).map((r) => String(r.label)))
      return {
        id: `x:item:${i.uid}`,
        kind: 'bot_item' as const,
        version: String(q?.eventId ?? i.uid),
        state: 'needs_you' as const,
        title: `#${i.number} ${i.title}`,
        detail: firstLine(q?.decisions?.length === 1 ? q.decisions[0].question : (q?.gist ?? q?.text ?? i.description)),
        // The text before the numbered questions (the asks carry the rest).
        intro: q?.decisions?.length ? firstLine(q.gist) : undefined,
        options: options.length ? options : undefined,
        question: fullQuestion(q, i.description),
        asks: asksOf(q),
        tab: typeof i.chat?.title === 'string' ? i.chat.title : undefined,
        since: i.lastActivityAt ?? now,
        botId: bot.id,
        botName: bot.name,
        openUrl: botUrl(bot.id)
      }
    })
}

/** `question.decisions` as the CLI gives it: each question with its own replies and its recommendation. */
export type Ask = { question: string; options: { label: string; recommended: boolean }[] }
function asksOf(q: Any | null): Ask[] | undefined {
  const ds = (q?.decisions ?? []) as Any[]
  const out = ds.map((d) => ({ question: String(d.question ?? ''), options: ((d.replies ?? []) as Any[]).map((r) => ({ label: String(r.label), recommended: r.recommended === true })) }))
  return out.length ? out : undefined
}

/** Everything asked, with the replies under each decision. */
function fullQuestion(q: Any | null, description: unknown): string | undefined {
  if (!q) return typeof description === 'string' ? description.slice(0, 4000) : undefined
  return typeof q.text === 'string' ? q.text.slice(0, 4000) : undefined
}

export function parsePlugins(result: Any, now: number): External[] {
  return ((result.plugins ?? []) as Any[])
    .filter((p) => p.needsReconsent)
    .map((p) => ({
      id: `x:plugin:${p.pluginKey}`,
      kind: 'plugin' as const,
      version: String(p.consentFingerprint ?? p.version ?? ''),
      state: 'needs_you' as const,
      title: `插件需要重新授权：${p.name}`,
      detail: '设置 → 插件',
      since: now
    }))
}

/** `dispatch_failed` is the only status Orca itself shows as failed; `failed` is for a later Orca. */
export function parseFailedRuns(result: Any): External[] {
  return ((result.runs ?? []) as Any[])
    .filter((r) => r.status === 'dispatch_failed' || r.status === 'failed')
    .map((r) => ({
      id: `x:run:${r.id}`,
      kind: 'automation' as const,
      version: String(r.id),
      state: 'failed' as const,
      title: `自动化失败：${r.title}`,
      detail: firstLine(typeof r.error === 'string' ? r.error : r.error?.message),
      since: r.createdAt ?? 0,
      worktreeId: r.workspaceId ?? undefined
    }))
}

export function parseGates(result: Any, objective: string | undefined, now: number): External[] {
  return ((result.gates ?? []) as Any[])
    .filter((g) => g.status === 'pending')
    .map((g) => ({
      id: `x:gate:${g.id}`,
      kind: 'gate' as const,
      version: String(g.id),
      state: 'needs_you' as const,
      title: `编排等你决定：${firstLine(g.question) ?? g.id}`,
      detail: objective,
      options: gateOptions(g.options),
      since: now
    }))
}

function gateOptions(v: unknown): string[] | undefined {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v
    if (!Array.isArray(a) || !a.length) return undefined
    return a.map((o) => (typeof o === 'string' ? o : String(o?.label ?? o?.title ?? JSON.stringify(o))))
  } catch {
    return undefined
  }
}

/** First meaningful line, markdown marks removed, cut to `max` characters. */
export function firstLine(s: unknown, max = 120): string | undefined {
  if (typeof s !== 'string') return undefined
  for (const raw of s.split('\n')) {
    const line = raw.replace(/\*\*|__|`/g, '').replace(/^[\s#>*-]+/, '').trim()
    if (line && !/^[─—-]{3,}/.test(raw.trim())) return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return undefined
}

// ---- runner -------------------------------------------------------------------------------------

export type Run = (args: string[]) => Promise<Any>

export function cliRunner(cli: string, userDataPath: string | undefined): Run {
  // A bare environment: the worker's own ORCA_* variables must not scope the CLI to some pane or host.
  const env: Record<string, string> = { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' }
  if (userDataPath) env.ORCA_USER_DATA_PATH = userDataPath
  return (args) =>
    new Promise((res, rej) => {
      execFile(cli, [...args, '--json'], { env, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        try {
          const j = JSON.parse(stdout) as Any
          if (j.ok) return res(j.result as Any)
          return rej(new Error(`orca ${args.slice(0, 3).join(' ')}: ${j.error?.code ?? 'failed'}`))
        } catch {
          return rej(err ?? new Error(`orca ${args.slice(0, 3).join(' ')}: not JSON`))
        }
      })
    })
}

export type SourceOutput = {
  /** Full set for one scope; entries of that scope missing from it are gone. Only called on success. */
  sync(scope: string, entries: External[]): void
  /** Scopes that still exist (a deleted bot's scope is dropped). */
  scopes(prefix: string, alive: string[]): void
  failedRuns(entries: External[]): void
  directory(d: { worktrees?: PsWorktree[]; bots?: Bot[]; chats?: Map<string, Chat[]> }): void
  log(line: string): void
}

export type SourceOptions = {
  run: Run
  out: SourceOutput
  walPath?: string
  pollMs?: number
  debounceMs?: number
  statMs?: number
  now?: () => number
}

type Job = 'items' | 'directory' | 'full'

export class OrcaSource {
  private bots: Bot[] = []
  private chats = new Map<string, Chat[]>()
  private queued = new Set<Job>()
  private running: Promise<void> | undefined
  private debounce = new Map<Job, ReturnType<typeof setTimeout>>()
  private poll: ReturnType<typeof setTimeout> | undefined
  private watching = false
  private failures = 0
  private lastDirectory = -Infinity
  private stopped = false

  constructor(private o: SourceOptions) {}

  start(): void {
    this.attachWatch()
    void this.request('full')
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.poll)
    for (const t of this.debounce.values()) clearTimeout(t)
    if (this.watching && this.o.walPath) unwatchFile(this.o.walPath, this.onStat)
  }

  get backingOff(): boolean {
    return this.failures > 0
  }

  /** Debounced trigger (WAL change, unknown pane, workspace change). Ignored while backing off. */
  trigger(job: Job): void {
    if (this.stopped || this.backingOff || this.debounce.has(job)) return
    this.debounce.set(
      job,
      setTimeout(() => {
        this.debounce.delete(job)
        void this.request(job)
      }, Math.max(this.o.debounceMs ?? 1000, job === 'directory' ? this.lastDirectory + 4 * (this.o.debounceMs ?? 1000) - Date.now() : 0))
    )
  }

  /** Runs `job` now; calls made while one runs are merged into one following pass. */
  request(job: Job): Promise<void> {
    this.queued.add(job)
    this.running ??= this.drain().finally(() => (this.running = undefined))
    return this.running
  }

  private async drain(): Promise<void> {
    while (this.queued.size && !this.stopped) {
      const jobs = new Set(this.queued)
      this.queued.clear()
      const full = jobs.has('full')
      let ok = true
      if (full) ok = await this.refreshBots()
      if (ok && (full || jobs.has('items'))) await this.refreshItems()
      if (ok && (full || jobs.has('directory'))) await this.refreshDirectory()
      if (ok && full) await this.refreshRest()
      if (full) this.schedule(ok)
    }
  }

  private schedule(ok: boolean): void {
    if (this.stopped) return
    if (ok && this.failures) this.o.out.log('orca source: CLI is back')
    this.failures = ok ? 0 : this.failures + 1
    const base = this.o.pollMs ?? 60_000
    const delay = Math.min(base * 2 ** this.failures, Math.max(base, 15 * 60_000))
    clearTimeout(this.poll)
    this.poll = setTimeout(() => void this.request('full'), delay)
  }

  private async attempt<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const r = await fn()
      return this.stopped ? undefined : r
    } catch (e) {
      if (!this.stopped) this.o.out.log(`orca source: ${what} failed: ${String(e).slice(0, 160)}`)
      return undefined
    }
  }

  private async refreshBots(): Promise<boolean> {
    const r = await this.attempt('bot list', () => this.o.run(['bot', 'list']))
    if (!r) return false
    // A bot that runs on a paired computer ('server') has no items on this one: the CLI says
    // 'No bot named …'. Only local bots are read.
    this.bots = ((r.bots ?? []) as Any[]).filter((b) => !b.server).map((b) => ({ id: b.id, name: b.name }))
    this.o.out.scopes('items:', this.bots.map((b) => `items:${b.id}`))
    this.o.out.directory({ bots: this.bots })
    return true
  }

  private async refreshItems(): Promise<void> {
    for (const b of this.bots) {
      await this.attempt(`items of ${b.name}`, async () => {
        const r = await this.o.run(['bot', 'item', 'list', '--bot', b.name, '--status', 'needs-you', '--limit', '100'])
        if (!this.stopped) this.o.out.sync(`items:${b.id}`, parseBotItems(r, this.now()))
      })
    }
  }

  private async refreshDirectory(): Promise<void> {
    this.lastDirectory = Date.now()
    const ps = await this.attempt('worktree ps', () => this.o.run(['worktree', 'ps']))
    if (ps) this.o.out.directory({ worktrees: ps.worktrees ?? [], chats: this.chats })
  }

  private async refreshRest(): Promise<void> {
    for (const b of this.bots) {
      const r = await this.attempt(`chats of ${b.name}`, () => this.o.run(['bot', 'chats', '--bot', b.name]))
      if (r) this.chats.set(b.name, r.chats ?? [])
    }
    if (!this.stopped) this.o.out.directory({ chats: this.chats })
    const plugins = await this.attempt('plugin list', () => this.o.run(['plugin', 'list']))
    if (plugins) this.o.out.sync('plugins', parsePlugins(plugins, this.now()))
    const runs = await this.attempt('automations runs', () => this.o.run(['automations', 'runs', '--limit', '20']))
    if (runs) this.o.out.failedRuns(parseFailedRuns(runs))
    // Gates are scoped to a run, but a named run can be read without binding to it.
    const list = await this.attempt('run-list', () => this.o.run(['orchestration', 'run-list']))
    if (!list) return
    const gates: External[] = []
    for (const run of ((list.runs ?? []) as Any[]).slice(0, 10)) {
      const g = await this.attempt('gate-list', () => this.o.run(['orchestration', 'gate-list', '--run', run.id, '--status', 'pending']))
      if (!g) return // partial: keep what is shown
      gates.push(...parseGates(g, run.objective, this.now()))
    }
    this.o.out.sync('gates', gates)
  }

  /**
   * Stat polling of the one file, once a second. fs.watch cannot do it: a directory watch misses
   * appends to the WAL, and a file watch ends when SQLite deletes and recreates it.
   */
  private attachWatch(): void {
    if (!this.o.walPath || this.watching) return
    this.watching = true
    watchFile(this.o.walPath, { interval: this.o.statMs ?? 1000, persistent: false }, this.onStat)
  }

  private onStat = (a: { mtimeMs: number; size: number; ino: number }, b: { mtimeMs: number; size: number; ino: number }): void => {
    if (a.mtimeMs !== b.mtimeMs || a.size !== b.size || a.ino !== b.ino) this.trigger('items')
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }
}

export const walPathOf = (userData: string): string => join(userData, 'bot-items.sqlite-wal')
