// Orca Island worker.
// Event -> SessionStore (src/state.ts) -> delivery:
//   L1 statusBar summary (always), L2 native helper (macOS, src/bridge.ts), L3 notifications.show
//   when the helper is unavailable (breaker tripped / missing / another helper owns the island) or
//   off-macOS. An opt-in event recorder (setting `record`) helps when reporting bugs.
//
// Palette commands are few on purpose (a changed command list needs a new approval);
// new actions are panels.handle requests (`orca plugin dev request plugin island.next`).
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { IslandBridge, type HelperKind, type HelperMsg } from './bridge'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { SessionStore, DEFAULT_CONFIG, itemIdOf, type Alert, type Item, type Summary, type Config, type ExternalEntry } from './state'
import { OrcaSource, DEFAULT_CLI, cliRunner, walPathOf, botUrl, type External, type PsWorktree, type Run, type SourceOutput } from './orca-source'
import { Answerer } from './answer'
import { ensureHelper, type BuildResult } from './helper-build'
import { jump, jumpTarget } from './jump'
import { PeekQueue } from './peek'
import { parsePrompt } from './tui'
import { Directory, MINE, buildGroups, fallbackName, secondary, type GroupMode } from './directory'

const EVENTS_KEY = 'rec:events'
const ITEMS_KEY = 'island:items'
const MAX_EVENTS = 3000
const ORCA_BUNDLE_ID = 'com.stablyai.orca'
const SEEN_RUNS_KEY = 'island:seenRuns'
const MODE_KEY = 'island:groupMode'
const RECONCILE_MS = 60_000
/** Failed runs older than this when first seen are history, not news. */
const RUN_NEWS_MS = 24 * 3600_000
const SEEN_ROW_MS = 30 * 60_000

/** Test seams: never set in Orca. */
export const testDeps: { run?: Run; open?: (url: string) => void; walPath?: string; debounceMs?: number; helperBinary?: string; hint?: (text: string) => void; helperEnv?: Record<string, string>; now?: () => number; powerCheckMs?: number } = {}
const wall = () => (testDeps.now ?? Date.now)()

export const displayName = (i: Item): string => i.name ?? fallbackName(i)
const dur = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} 秒` : ms < 3600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.floor(ms / 3600_000)} 小时 ${Math.round((ms % 3600_000) / 60_000)} 分`)
/** A duration in plain words: 25 分钟, 1 小时 10 分钟. */
export const spanText = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`
}
export type ChangeSummary = { title: string; lines: string[]; badge: string; ids: string[]; text: string; ttlMs: number }
/**
 * What changed while the island was off or the person away (design F8): only rows whose state began
 * in that time. Older waiting rows are not news; their number gets its own, honest line.
 * Under a minute, or nothing new: no summary.
 */
export function changesSummary(items: Item[], since: number, now: number, kind: 'off' | 'away'): ChangeSummary | undefined {
  if (now - since < 60_000) return undefined
  const fresh = (i: Item) => i.stateSince >= since
  const names = (xs: Item[]) => xs.slice(0, 2).map((i) => `「${displayName(i)}」`).join('') + (xs.length > 2 ? ` 等 ${xs.length} 个` : '')
  const asks = items.filter((i) => i.state === 'needs_you' && fresh(i)).sort((a, b) => a.stateSince - b.stateSince)
  const failed = items.filter((i) => i.state === 'failed' && fresh(i))
  const done = items.filter((i) => (i.state === 'done' || i.state === 'interrupted') && fresh(i))
  const older = items.filter((i) => i.state === 'needs_you' && !fresh(i)).length
  const lines: string[] = []
  if (asks.length) lines.push(`${asks.length} 个问题在等你回答：${names(asks)}`)
  if (failed.length) lines.push(`${failed.length} 个任务失败：${failed.slice(0, 2).map(displayName).join('、')}${failed.length > 2 ? ` 等 ${failed.length} 个` : ''}`)
  if (done.length) lines.push(`${done.length} 个任务完成`)
  if (!lines.length) return undefined
  if (older) lines.push(`另有 ${older} 个问题之前就在等你`)
  const title = kind === 'off' ? `关闭的 ${spanText(now - since)}里` : `你离开的 ${spanText(now - since)}里`
  const n = asks.length + failed.length + done.length
  const ids = [...asks, ...failed, ...done].map((i) => i.id)
  // Long ttl: the helper keeps it up until it is hovered or 20 s pass, after the first input (F8).
  return { title, lines, badge: `${n} 条新消息`, ids, text: [title, ...lines].join('\n'), ttlMs: 20000 }
}
/** The island's master switch: on, or off until `until` (epoch ms; absent = until turned on). */
export type Power = { on: true } | { on: false; until?: number; since: number }
export type OffChoice = 'hour' | 'morning' | 'forever'
/** When an "off" choice ends: 1 hour, the next 08:00 local time, or never. */
export function offUntil(choice: OffChoice, now: number): number | undefined {
  if (choice === 'hour') return now + 3600_000
  if (choice === 'forever') return undefined
  const d = new Date(now)
  d.setHours(8, 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}
const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** Status bar while off: grey, with the end time; pressing it turns the island on. */
export function offStatus(p: Power, now: number): { text: string; tone: 'neutral'; tooltip: string } {
  if (p.on) throw new Error('on')
  const end = p.until === undefined ? '' : new Date(p.until).toDateString() === new Date(now).toDateString() ? `（到 ${hhmm(p.until)}）` : `（到明天 ${hhmm(p.until)}）`
  return { text: `Island 已关闭${end}`, tone: 'neutral', tooltip: '点击打开 Island' }
}

/** What kind of row, for a small glyph: a terminal session, a bot (item or chat), or Orca itself. */
export const rowSource = (i: Item): 'terminal' | 'bot' | 'orca' | '' =>
  i.kind === 'bot_item' || i.botChat ? 'bot' : i.kind && i.kind !== 'session' ? 'orca' : i.terminalId ? 'terminal' : ''

/** The one line of a peek. */
export function peekLine(i: Item): string {
  const took = i.stateSince > i.startedAt ? ` · 用时 ${dur(i.stateSince - i.startedAt)}` : ''
  if (i.state === 'needs_you') return i.detail ?? '需要你处理'
  if (i.botChat && i.state === 'done') return `回复了${i.detail ? ` · ${i.detail}` : ''}`
  if (i.state === 'failed') return `失败${i.detail ? ` · ${i.detail}` : took}`
  if (i.state === 'interrupted') return `已中断${took}`
  return i.state === 'done' ? `完成${took}` : '运行中'
}
export const groupLabel = (i: Item): string => i.bot ?? i.project ?? (i.kind && i.kind !== 'session' ? 'Orca' : MINE)

export function pluginDirFrom(metaUrl: string | undefined, cwd: string): string {
  if (metaUrl && metaUrl.startsWith('file:')) return resolve(dirname(fileURLToPath(metaUrl)), '..')
  return cwd
}

type Rec = { seq: number; at: number; event: string; payload: unknown }
type AgentEvent = PluginEvents['agent.status.changed']

/** Simple mapping used by the recorder and tests; the live mapping is SessionStore. */
export function islandState(e: AgentEvent): { state: string; outcome?: string } {
  const main = e.mainAgent
  const st = main?.state ?? e.state
  if (e.state === 'blocked') return { state: 'blocked' }
  if (st === 'done') {
    const o = main?.outcome
    if (o === 'failure' || o === 'interruption') return { state: 'failed', outcome: o }
    return { state: 'done', outcome: o }
  }
  return { state: st }
}

export { itemIdOf as itemId } from './state'

/** Status bar text for a summary (L1). */
export function statusText(s: Summary, next?: Item): { text: string; tone: 'neutral' | 'warning' | 'danger' | 'success'; tooltip: string } {
  const parts: string[] = []
  if (s.blocked) parts.push(`需要你 ${s.blocked}`)
  if (s.unreadFailed) parts.push(`失败 ${s.unreadFailed}`)
  if (s.unreadDone) parts.push(`完成 ${s.unreadDone}`)
  if (s.working) parts.push(`运行中 ${s.working}`)
  const text = parts.join(' · ') || 'Island'
  const tone = s.blocked ? 'warning' : s.unreadFailed ? 'danger' : s.unreadDone ? 'success' : 'neutral'
  const tooltip = next ? `下一个：${displayName(next)}（${groupLabel(next)}），点击跳转` : 'Orca Island'
  return { text, tone, tooltip }
}

/** L3 notification text for an alert. */
export function notificationFor(a: Alert, items: Item[]): { title: string; body: string } {
  const byId = new Map(items.map((i) => [i.id, i]))
  const its = a.ids.map((id) => byId.get(id)).filter(Boolean) as Item[]
  const where = (i: Item) => [i.workspace, i.branch].filter(Boolean).join(' / ')
  if (its.length === 1) {
    const i = its[0]
    const name = displayName(i)
    const title =
      i.botChat && i.state === 'done'
        ? `${i.bot ?? name} 回复了`
        : i.kind && i.kind !== 'session'
          ? i.bot ? `${i.bot} 需要你：${name}` : name
          : `${{ needs_you: '需要你', failed: '失败', done: '完成', interrupted: '已中断', working: '运行中' }[i.state]}：${name}`
    return { title, body: i.detail ?? (secondary(i) || groupLabel(i)) }
  }
  const c = a.counts
  const bits = [c.needs_you && `${c.needs_you} 个需要你`, c.failed && `${c.failed} 个失败`, c.done && `${c.done} 个完成`, c.interrupted && `${c.interrupted} 个中断`].filter(Boolean)
  return { title: `Orca Island: ${bits.join('，')}`, body: its.map(displayName).slice(0, 4).join(' · ') }
}

const timers = {
  now: () => Date.now(),
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export default function activate(orca: OrcaWorkerApi): void {
  let metaUrl: string | undefined
  try {
    metaUrl = import.meta.url
  } catch {
    metaUrl = undefined
  }
  const pluginDir = pluginDirFrom(metaUrl, process.cwd())
  orca.log(`activate: pluginDir=${pluginDir} node=${process.version} pid=${process.pid} platform=${process.platform}`)

  const disposers: (() => void)[] = []
  let disposed = false

  // ---- settings ------------------------------------------------------------------------------
  type Settings = {
    helper: string
    record: boolean
    preset: Config['preset']
    displayMode: string
    sounds: boolean
    systemNotifications: boolean
    minWorkSec: number
    hotkey: boolean
    hideFromCapture: boolean
    orcaSource: boolean
    orcaCli: string
    allowAnswer: boolean
    /** 启用 Orca Island: the master switch, mirrored from `power` (either one changes both). */
    enabled: boolean
  }
  let settings: Settings = {
    helper: 'swift',
    record: false,
    preset: 'standard',
    displayMode: 'auto',
    sounds: true,
    systemNotifications: true,
    minWorkSec: DEFAULT_CONFIG.minWorkSec,
    hotkey: true,
    hideFromCapture: true,
    orcaSource: true,
    orcaCli: '',
    allowAnswer: false,
    enabled: true
  }
  const loadSettings = async (): Promise<void> => {
    try {
      const all = (await orca.settings.get()) as Partial<Settings>
      settings = { ...settings, ...Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined && v !== null)) }
    } catch (e) {
      orca.log(`settings.get failed: ${String(e)}`)
    }
    store.config = { ...store.config, preset: settings.preset, sounds: settings.sounds, minWorkSec: settings.minWorkSec }
  }

  // ---- recorder (opt-in) -----------------------------------------------------------------
  let chain: Promise<unknown> = Promise.resolve()
  let seq = 0
  const record = (event: string, payload: unknown): Promise<unknown> => {
    if (!settings.record) return chain
    chain = chain
      .then(async () => {
        const list = ((await orca.storage.get(EVENTS_KEY)) as Rec[] | null) ?? []
        seq = Math.max(seq, list.length ? list[list.length - 1].seq : 0) + 1
        list.push({ seq, at: Date.now(), event, payload: JSON.parse(JSON.stringify(payload ?? null)) })
        if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
        await orca.storage.set(EVENTS_KEY, list as never)
      })
      .catch((e) => orca.log(`record failed: ${String(e)}`))
    return chain
  }

  /** When the screen was locked (for the away summary's span and its "new" cut-off). */
  let lockedSince: number | undefined
  /** The summary as the helper takes it: one peek message with a title, lines, a badge and the new rows. */
  const summaryMsg = (c: ChangeSummary | undefined) => (c ? { text: c.text, title: c.title, lines: c.lines, badge: c.badge, ids: c.ids, ttlMs: c.ttlMs } : undefined)
  // ---- master switch -------------------------------------------------------------------------
  const POWER_KEY = 'island:power'
  let power: Power = { on: true }
  // ---- delivery ------------------------------------------------------------------------------
  let bridge: IslandBridge | undefined
  let helperUp = false
  const helperMsgs: HelperMsg[] = []
  const helperAvailable = () => !!bridge && helperUp

  let lastStatus = ''
  let statusRetry: ReturnType<typeof setTimeout> | undefined
  let statusFails = 0
  /**
   * The status bar is the way back when the island is off, so an update that Orca refuses (it does
   * for a moment after a load) is retried until it lands; only a landed update is remembered.
   */
  const pushStatus = async (s: Summary, force = false): Promise<void> => {
    const st = power.on ? statusText(s, store.next()) : offStatus(power, wall())
    const k = JSON.stringify([st, power.on])
    if (k === lastStatus && !force) return
    try {
      await orca.host.call('statusBar.update', { id: 'island-summary', ...st, visible: true })
      // The pause button is there only while the island is on (off: the summary item turns it on).
      await orca.host.call('statusBar.update', { id: 'island-power', visible: power.on, tooltip: '关闭 Island 1 小时（列表顶部 ⏻ 有更多选项）' })
      lastStatus = k
      if (statusFails || !power.on) orca.log(`status bar: ${st.text}${statusFails ? ` (after ${statusFails} refused)` : ''}`)
      statusFails = 0
    } catch (e) {
      statusFails++
      lastStatus = ''
      if (statusFails <= 3 || statusFails % 20 === 0) orca.log(`statusBar.update failed (${statusFails}): ${String(e)}`)
      clearTimeout(statusRetry)
      if (!disposed) statusRetry = setTimeout(() => void pushStatus(store.summary()), Math.min(250 * 2 ** Math.min(statusFails, 5), 8000))
    }
  }
  disposers.push(() => clearTimeout(statusRetry))

  let persistTimer: ReturnType<typeof setTimeout> | undefined
  /** What the last × or 清空已完成 took away, for 撤销 (10 s). */
  let undoStack: { items: Item[]; at: number } | undefined
  const SNOOZES_KEY = 'island:snoozes'
  const persistSnoozes = () => void orca.storage.set(SNOOZES_KEY, JSON.parse(JSON.stringify(store.snoozes()))).catch((e) => orca.log(`snoozes: ${String(e)}`))
  const persist = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void orca.storage.set(ITEMS_KEY, JSON.parse(JSON.stringify(store.snapshot()))).catch((e) => orca.log(`persist failed: ${String(e)}`))
    }, 500)
  }

  const l3 = async (a: Alert): Promise<void> => {
    if (!power.on || !settings.systemNotifications) return
    if (a.priority >= 2 && !a.peek) return // count-only (suppressed / quiet preset)
    if (a.priority > 2) return
    if (!a.peek && !a.sound) return // fully suppressed (Orca frontmost on this workspace, snooze)
    const n = notificationFor(a, store.items())
    try {
      await orca.host.call('notifications.show', n)
    } catch (e) {
      orca.log(`notifications.show failed: ${String(e)}`)
    }
  }

  // What the helper draws: readable name, secondary line, group label.
  const row = (i: Item) => {
    const t = jumpTarget(i)
    const source = rowSource(i)
    return { ...i, title: displayName(i), sub: secondary(i), group: groupLabel(i), reply: !!i.botChat && i.state === 'done', line: peekLine(i), jump: t.tab ? `${t.label}（标签「${t.tab}」）` : t.label, isNew: i.state === 'needs_you' && i.unread, source }
  }
  // Peeks shown and peeks not shown (with why), kept in memory so a live check has evidence.
  const peekLog: Record<string, unknown>[] = []
  const logPeek = (e: Record<string, unknown>) => {
    peekLog.push({ at: Date.now(), ...e, presence: { ...store.presence } })
    if (peekLog.length > 60) peekLog.shift()
  }
  const peeks = new PeekQueue(
    timers,
    {
      show: (p) => {
        bridge?.send({ type: 'peek', ...p })
        if (!p.id && !p.more && !p.text) return
        logPeek({ ...p })
      },
      skipped: (ids, reason) => logPeek({ ids, suppressed: reason })
    },
    (id) => store.items().some((i) => i.id === id && (i.state === 'needs_you' || i.unread))
  )
  disposers.push(() => peeks.clear())
  let mode: GroupMode = 'project'
  const toggled = new Map<string, boolean>()
  let groupsQueued = false
  const pushGroups = () => {
    if (groupsQueued) return
    groupsQueued = true
    queueMicrotask(() => {
      groupsQueued = false
      if (!disposed) bridge?.send({ type: 'groups', mode, groups: buildGroups(store.items(), mode, toggled) })
    })
  }

  const store = new SessionStore(timers, {
    upsert: (item) => {
      bridge?.send({ type: 'upsert', item: row(item) as never })
      pushGroups()
      persist()
    },
    remove: (id) => {
      bridge?.send({ type: 'remove', id })
      pushGroups()
      persist()
    },
    summary: (s) => {
      bridge?.send({ type: 'summary', ...s, finished: store.finishedCount() })
      void pushStatus(s)
    },
    alert: (a) => {
      void record('island.alert', a)
      if (!power.on) return // off: tracked, never shown or notified
      if (helperAvailable()) {
        const quiet = a.ids.filter((id) => !a.peekIds.includes(id))
        if (quiet.length) logPeek({ ids: quiet, suppressed: a.suppressedBy ?? 'policy' })
        if (a.peek) peeks.add(a.peekIds, a.ttlMs, (id) => store.get(id)?.state === 'needs_you', a.sound)
      } else {
        void l3(a)
      }
    }
  })
  disposers.push(() => store.dispose())

  // ---- enrichment: workspace name/branch (workspace.list) and agent kind (agents.list) ----------
  const wsCache = new Map<string, { name: string; branch: string | null }>()
  const wsByPath = new Map<string, string>()
  let wsCacheAt = 0
  const refreshWorkspaces = async (force = false): Promise<void> => {
    if (!force && Date.now() - wsCacheAt < 30_000) return
    wsCacheAt = Date.now()
    try {
      const r = await orca.host.call('workspace.list', {})
      for (const w of r.workspaces) {
        wsCache.set(w.id, { name: w.name, branch: w.branch })
        wsByPath.set(w.path, w.id)
      }
    } catch (e) {
      orca.log(`workspace.list failed: ${String(e)}`)
    }
  }
  const agentKind = new Map<string, string>() // sessionId -> kind
  const enrich = async (id: string, e: AgentEvent): Promise<void> => {
    if (e.workspaceListId) {
      if (!wsCache.has(e.workspaceListId)) await refreshWorkspaces(true)
      const w = wsCache.get(e.workspaceListId)
      if (w) store.enrich(id, { workspace: w.name, branch: w.branch ?? undefined })
    }
    if (e.sessionId && !agentKind.has(e.sessionId) && e.workspaceListId) {
      try {
        const r = await orca.host.call('agents.list', { workspaceId: e.workspaceListId })
        for (const a of r.agents) if (a.sessionId && a.agent) agentKind.set(a.sessionId, a.agent)
      } catch {
        // workspace may be gone
      }
    }
    const kind = e.sessionId ? agentKind.get(e.sessionId) : undefined
    if (kind) store.enrich(id, { agent: kind })
  }

  // ---- orca source: names, grouping, Orca's own needs-you --------------------------------------
  const dir = new Directory()
  let source: OrcaSource | undefined
  let seeded = false
  const applyPlace = (i: Item): void => {
    if (i.scope) return
    const p = dir.place(i.paneKey, i.title)
    if (!p) return
    const { name, project, workspace, branch, bot, agent, botChat, dispatched, tab } = p
    const botId = botChat ? dir.bots.find((b) => b.name === bot)?.id : undefined
    store.enrich(i.id, { name, project, workspace, branch, bot, agent, botChat: botChat || undefined, dispatched: dispatched || undefined, tab, openUrl: botId && botUrl(botId), detail: botChat && i.state === 'done' ? p.lastMessage : undefined })
  }
  const seedFromPs = (worktrees: PsWorktree[]): void => {
    for (const wt of worktrees) {
      for (const a of wt.agents ?? []) {
        if (a.state === 'done' || !a.mainAgent) continue
        store.seed({
          workspaceId: null,
          workspaceListId: wt.worktreeId.startsWith('folder:') ? wt.worktreeId : wsByPath.get(wt.path ?? ''),
          paneKey: a.paneKey,
          state: a.state,
          receivedAt: Date.now(),
          mainAgent: { state: a.mainAgent.state, stateStartedAt: a.mainAgent.stateStartedAt }
        })
      }
    }
  }
  const toEntry = (e: External): ExternalEntry => {
    const wt = e.botName ? dir.botHome(e.botName) : dir.worktree(e.worktreeId)
    return {
      id: e.id, kind: e.kind, version: e.version, state: e.state, title: e.title, detail: e.detail, options: e.options, question: e.question, asks: e.asks, intro: e.intro, tab: e.tab, since: e.since, openUrl: e.openUrl,
      bot: e.botName ?? wt?.bot ?? undefined,
      project: wt?.repo ?? undefined,
      workspace: wt?.displayName ?? undefined,
      workspaceListId: wt?.worktreeId.startsWith('folder:') ? wt.worktreeId : undefined
    }
  }
  let seenRuns: string[] = []
  const sourceOut: SourceOutput = {
    sync: (scope, entries) => store.syncExternal(scope, entries.map(toEntry)),
    scopes: (prefix, alive) => store.keepScopes(prefix, alive),
    failedRuns: (entries) => {
      const fresh = entries.filter((e) => !seenRuns.includes(e.version))
      if (!fresh.length) return
      seenRuns = [...seenRuns, ...fresh.map((e) => e.version)].slice(-300)
      void orca.storage.set(SEEN_RUNS_KEY, seenRuns).catch((e) => orca.log(`seenRuns: ${String(e)}`))
      store.addExternal('runs', fresh.filter((e) => Date.now() - e.since < RUN_NEWS_MS).map(toEntry))
    },
    directory: (d) => {
      dir.update(d)
      if (d.worktrees && !seeded) {
        seeded = true
        seedFromPs(d.worktrees)
      }
      for (const i of store.items()) applyPlace(i)
    },
    log: (l) => orca.log(l)
  }
  const startSource = async (): Promise<void> => {
    source?.stop()
    source = undefined
    if (!settings.orcaSource) {
      orca.log('orca source: off')
      store.keepScopes('', []) // its entries can no longer be refreshed
      return
    }
    const userData = process.env.ORCA_USER_DATA_PATH || (process.platform === 'darwin' ? resolve(homedir(), 'Library/Application Support/orca') : undefined)
    const cli = settings.orcaCli || process.env.ORCA_CLI_COMMAND || DEFAULT_CLI
    source = new OrcaSource({
      run: testDeps.run ?? cliRunner(cli, process.env.ORCA_USER_DATA_PATH),
      out: sourceOut,
      walPath: testDeps.run ? testDeps.walPath : userData && walPathOf(userData),
      debounceMs: testDeps.debounceMs
    })
    source.start()
  }
  disposers.push(() => source?.stop())
  const openUrl = (url: string): void => {
    if (!/^orca:\/\/bot\/[A-Za-z0-9_-]{1,128}$/.test(url)) return
    if (testDeps.open) return testDeps.open(url)
    execFile(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], (err) => err && orca.log(`open ${url}: ${String(err)}`))
  }

  // ---- presence (from helper; workspace focus from Orca) ---------------------------------------
  const updatePresence = (p: Partial<typeof store.presence>) => {
    store.presence = { ...store.presence, ...p }
  }

  // ---- focus / jump ----------------------------------------------------------------------------
  const focusItem = async (id: string): Promise<unknown> => {
    const it = store.get(id)
    if (!it) return { target: 'orca', exact: false, tried: ['unknown item'] }
    const result = await jump(it, {
      focus: (terminalId) => orca.host.call('terminal.focus', { terminalId }),
      agents: async (workspaceId) => (await orca.host.call('agents.list', { workspaceId })).agents,
      terminals: async (workspaceId) => (await orca.host.call('terminal.list', { workspaceId })).terminals,
      openWorkspace: (workspaceId) => orca.host.call('workspace.open', { workspaceId }),
      openUrl,
      setTerminal: (t) => store.setTerminal(id, t)
    })
    store.markRead([id])
    // Not exact (a chat or bot item): say which tab to switch to, since Orca cannot open it for us.
    // Orca can open the bot but cannot pick its right-sidebar tab, nor a chat tab, for a plugin:
    // say where to look. Bot items are listed under 主页 (需要你处理); chats under 聊天.
    if (!result.exact) {
      const where = it.bot ?? it.workspace ?? 'Orca'
      const text =
        it.kind === 'bot_item'
          ? `已打开 ${where}，请在右侧切到「主页」查看待你决定`
          : result.tab
            ? `已打开 ${where}，请在右侧「聊天」里切到「${result.tab}」`
            : undefined
      if (text) {
        bridge?.send({ type: 'hint', text })
        testDeps.hint?.(text)
      }
    }
    orca.log(`jump ${id.slice(0, 14)} -> ${result.target} exact=${result.exact}${result.tab ? ' tab-hint' : ''} [${result.tried.join(', ')}]`)
    void record('island.focus', { id, result })
    return result
  }

  // ---- detail view -----------------------------------------------------------------------------
  /** Only with the terminal grant, and the setting on. */
  const canAnswer = () => power.on && settings.allowAnswer && ['terminal:read', 'terminal:send'].every((c) => orca.grantedCapabilities.includes(c))
  const answerer = new Answerer((l) => orca.log(l))
  const readLines = async (terminalId: string) => (await orca.host.call('terminal.read', { terminalId, maxLines: 80 })).lines
  const ioFor = (it: Item) => ({
    // The switch can go off while an answer is under way: nothing is read or typed after that.
    read: async () => {
      if (!power.on) throw new Error('island off')
      return readLines(it.terminalId!)
    },
    send: async (text: string, enter?: boolean) => power.on && (await orca.host.call('terminal.sendText', { terminalId: it.terminalId!, text, enter: !!enter })).accepted,
    focus: async () => {
      if (!power.on || !(await orca.host.call('terminal.focus', { terminalId: it.terminalId! })).focused) return false
      // Reads and keys are accepted only once Orca reports this terminal's workspace as the active
      // one, which lags behind the focus call: wait for it (at most about 2 s).
      for (let i = 0; i < 20; i++) {
        const ctx = await orca.host.call('workspace.readContext').catch(() => null)
        if (ctx?.terminals.some((x) => x.id === it.terminalId)) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    }
  })
  let openId: string | undefined
  const openDetail = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const it = store.get(id)
    if (!it) return undefined
    openId = id
    store.markRead([id])
    const t = jumpTarget(it)
    const base = { type: 'detail', id, title: displayName(it), source: [groupLabel(it), secondary(it)].filter(Boolean).join(' · '), primary: t.label, answerable: false, options: [] as unknown[] }
    let d: Record<string, unknown> = base
    // `inputKind` says why there is (or is not) an input: orca = answerable only in Orca; off = the island
    // switch is off; none = nothing to answer.
    if (it.kind === 'bot_item') {
      // One block per question, each with its own options; the whole text only when there are none.
      d = it.asks?.length
        ? { ...base, question: it.intro ?? '', asks: it.asks, inputKind: 'orca', primary: '去 Orca 回答' }
        : { ...base, question: it.question ?? it.detail, inputKind: 'orca', primary: '去 Orca 回答' }
    }
    else if (it.state === 'needs_you' && it.terminalId && (it.agent === 'claude' || !it.agent) && !canAnswer()) {
      // Switch off: the terminal is not read, so only what Orca's agent list says is shown.
      d = { ...base, question: dir.asking(it.paneKey) ?? it.detail, inputKind: 'off', primary: t.label }
    } else if (it.state === 'needs_you' && it.terminalId && (it.agent === 'claude' || !it.agent) && canAnswer()) {
      const p = await readLines(it.terminalId).then(parsePrompt).catch(() => null)
      if (openId !== id) return undefined
      if (p && !p.editing) d = { ...base, question: `${p.title}\n${p.ask === p.question ? '' : p.ask + '\n'}${p.question}`.trim(), options: p.options.filter((o) => o.freeText !== 'type'), textOption: p.options.find((o) => o.freeText)?.n, answerable: true, signature: p.signature }
      else d = { ...base, question: it.detail, inputKind: 'orca', note: p ? '终端里正在输入，请在 Orca 里回答' : '没能识别这个提示，请在 Orca 里回答' }
    } else d = { ...base, question: dir.asking(it.paneKey) ?? it.question ?? it.detail, inputKind: it.state === 'needs_you' ? 'orca' : 'none', primary: it.state === 'needs_you' && t.kind !== 'terminal' ? '去 Orca 回答' : t.label }
    bridge?.send(d as HelperMsg)
    return d
  }
  const REASON: Record<string, string> = { gone: '已在别处处理', editing: '终端里正在输入，没有发送', unfocused: '没能切到这个终端，没有发送', refused: 'Orca 没有接受这次输入', unsupported: '这个选项不能在这里回答', empty: '内容为空', error: '读取终端失败，没有继续发送' }
  const answerFrom = async (msg: { id?: unknown; option?: unknown; text?: unknown; signature?: unknown }): Promise<Record<string, unknown>> => {
    const it = typeof msg.id === 'string' ? store.get(msg.id) : undefined
    let out: Record<string, unknown>
    if (!it?.terminalId || !canAnswer() || typeof msg.option !== 'number' || typeof msg.signature !== 'string') out = { ok: false, text: REASON.unsupported }
    else {
      const r = await answerer.answer(it.terminalId, ioFor(it), { signature: msg.signature, option: msg.option, ...(typeof msg.text === 'string' ? { text: msg.text } : {}) })
      out = r.ok ? { ok: true, text: r.confirmed ? '已发送' : '已发送，但提示还在，请到 Orca 里确认' } : !power.on ? { ok: false, reason: 'off', text: 'Island 已关闭，没有发送' } : { ok: false, reason: r.reason, text: REASON[r.reason] }
    }
    bridge?.send({ type: 'answered', id: String(msg.id ?? ''), ...out })
    return out
  }

  const jumpNext = async (): Promise<unknown> => {
    const it = store.next()
    if (!it) return { jumped: false }
    return { jumped: true, id: it.id, title: it.title, result: await focusItem(it.id) }
  }

  // ---- helper ----------------------------------------------------------------------------------
  const helperConfig = () => ({
    displayMode: settings.displayMode,
    sounds: settings.sounds,
    hotkey: settings.hotkey,
    hideFromCapture: settings.hideFromCapture,
    allowAnswer: settings.allowAnswer,
    /** The switch is offered only when terminal access was granted. */
    answerGranted: ['terminal:read', 'terminal:send'].every((c) => orca.grantedCapabilities.includes(c)),
    locale: 'zh-CN'
  })

  const setMode = async (m: GroupMode): Promise<void> => {
    mode = m
    pushGroups()
    await orca.storage.set(MODE_KEY, m).catch((e) => orca.log(`mode: ${String(e)}`))
  }

  const onHelper = async (msg: HelperMsg): Promise<void> => {
    // Typed answers are never kept: not in this log, not in the recorder.
    const kept: HelperMsg = { ...msg }
    delete kept.text
    delete kept.signature
    helperMsgs.push({ ...kept, _at: Date.now() })
    if (helperMsgs.length > 50) helperMsgs.shift()
    if (msg.type !== 'pong') void record('helper.' + msg.type, kept)
    switch (msg.type) {
      case 'clicked': {
        const action = msg.action as string
        const id = msg.id as string | undefined
        if (action === 'pick' && id) {
          // Orca lets only you answer bot items: open where it can be answered, and remind which one.
          await focusItem(id)
          bridge?.send({ type: 'picked', id, text: typeof msg.label === 'string' ? `已为你打开 Orca，请在那里选择「${msg.label}」` : '已为你打开 Orca' })
        } else if ((action === 'focus' || action === 'jump') && id) {
          peeks.skip()
          await focusItem(id)
        } else if (action === 'open' && id) await openDetail(id)
        else if (action === 'answer') await answerFrom(msg as Record<string, unknown>)
        else if ((action === 'mark_read' || action === 'dismiss') && id) {
          const r = store.dismiss(id)
          if (r) {
            undoStack = { items: [r.item], at: Date.now() }
            persistSnoozes()
            bridge?.send({ type: 'toast', text: r.kind === 'snoozed' ? '已隐藏，问题仍待处理（30 分钟后再提醒）' : '已移除', undo: true })
          }
        } else if (action === 'clear_finished') {
          const gone = store.clearFinished()
          if (gone.length) {
            undoStack = { items: gone, at: Date.now() }
            persistSnoozes()
            bridge?.send({ type: 'toast', text: `已清空 ${gone.length} 项`, undo: true })
          }
        } else if (action === 'undo') {
          if (undoStack && Date.now() - undoStack.at < 10_000) store.undo(undoStack.items)
          undoStack = undefined
          persistSnoozes()
        }
        else if (action === 'power_off' && (msg.choice === 'hour' || msg.choice === 'morning' || msg.choice === 'forever')) await turnOff(msg.choice, 'island')
        else if (action === 'mark_all_read') store.markRead()
        else if (action === 'set_mode' && (msg.mode === 'project' || msg.mode === 'bot')) await setMode(msg.mode)
        else if (action === 'toggle_group' && typeof msg.key === 'string') {
          toggled.set(msg.key, !!msg.collapsed)
          pushGroups()
        } else if (action === 'snooze') updatePresence({ snoozeUntil: Date.now() + ((msg.minutes as number) ?? 30) * 60_000 })
        break
      }
      case 'list':
        peeks.setListOpen(!!msg.open)
        if (!msg.open) openId = undefined
        break
      case 'peeked':
        if (peekLog.length) Object.assign(peekLog[peekLog.length - 1], { screens: msg.screens })
        break
      case 'hotkey':
        if (power.on) await jumpNext()
        break
      case 'setting': {
        // Only this one switch is writable from the island; turning it on needs the confirm the
        // helper shows ("开启后，Island 可以向你的终端输入"), sent back as confirmed: true.
        // hideFromCapture needs no confirm: either way nothing is read or typed.
        const key = msg.key
        if ((key !== 'allowAnswer' && key !== 'hideFromCapture') || typeof msg.value !== 'boolean') break
        if (key === 'allowAnswer' && msg.value && msg.confirmed !== true) break
        try {
          await orca.settings.set(key, msg.value)
          settings[key] = msg.value
          orca.log(`${key} set to ${msg.value} from the island`)
        } catch (e) {
          orca.log(`${key}: ${String((e as { code?: string })?.code ?? e)}`)
        }
        bridge?.send({ type: 'config', config: helperConfig() })
        break
      }
      case 'collapsed':
        // Hovering the card is "seeing" it: finished items get marked read (docs/architecture.md).
        if (msg.seen) {
          store.markSeen(Array.isArray(msg.ids) ? (msg.ids as string[]) : [])
        }
        break
      case 'presence':
        updatePresence({ orcaFrontmost: msg.frontmostBundleId === ORCA_BUNDLE_ID, locked: !!msg.locked })
        if (msg.locked && !lockedSince) lockedSince = wall()
        peeks.setLocked(!!msg.locked, () => {
          const since = lockedSince ?? wall()
          lockedSince = undefined
          return summaryMsg(changesSummary(store.items(), since, wall(), 'away'))
        })
        if (!msg.locked) lockedSince = undefined
        break
      case 'held':
        updatePresence({ locked: true })
        if (!lockedSince) lockedSince = wall()
        peeks.held(typeof msg.id === 'string' ? msg.id : '')
        break
      case 'error':
        orca.log(`helper error ${msg.code}: ${msg.message}`)
        break
      case 'setting_test':
        // Tests only (island.helperMsg): a setting changed in Orca's settings UI.
        await orca.settings.set(String(msg.key), msg.value as never)
        await onSettingChanged(String(msg.key))
        break
    }
  }

  let build: BuildResult | undefined
  let toldNoSwiftc = false
  /** Builds (or finds) the Swift helper; JXA when that is not possible on this Mac. */
  const swiftBinary = async (): Promise<string | undefined> => {
    if (testDeps.helperBinary !== undefined) return testDeps.helperBinary || undefined
    build = await ensureHelper(pluginDir, {}, (msg) => void orca.host.call('statusBar.update', { id: 'island-summary', text: msg, tone: 'neutral' }).catch(() => undefined))
    lastStatus = '' // the status bar may have shown build progress
    void pushStatus(store.summary())
    if (build.ok) {
      if (build.built) orca.log(`helper compiled in ${build.ms} ms: ${build.path}`)
      return build.path
    }
    orca.log(`helper build: ${build.reason}${build.detail ? ` (${build.detail})` : ''}; using the JXA helper`)
    if (build.reason === 'no-swiftc' && !toldNoSwiftc) {
      toldNoSwiftc = true
      void orca.host.call('notifications.show', { title: 'Orca Island：正在使用简化版 Island', body: '安装 Xcode 命令行工具后可使用完整版：在终端运行 xcode-select --install，然后重启插件。' }).catch(() => undefined)
    }
    return undefined
  }

  const startHelper = async (override?: string): Promise<void> => {
    bridge?.stop()
    bridge = undefined
    helperUp = false
    let kind = override ?? settings.helper
    if (!power.on) {
      orca.log('island is off: no helper')
      return
    }
    if (kind === 'off' || process.platform !== 'darwin') {
      orca.log(`helper disabled (kind=${kind}, platform=${process.platform}): L1 + L3 only`)
      return
    }
    let binary: string | undefined
    if (kind === 'swift') {
      binary = await swiftBinary()
      if (!binary) kind = 'jxa'
      if (disposed) return
    }
    const b = new IslandBridge({
      pluginDir,
      kind: kind as HelperKind,
      binary,
      bundleId: ORCA_BUNDLE_ID,
      config: helperConfig,
      ...(testDeps.helperEnv ? { env: testDeps.helperEnv } : {}),
      onMessage: (m) => void onHelper(m),
      onStatus: (st, detail) => {
        helperUp = st === 'ready'
        peeks.setListOpen(false) // a fresh helper starts as the pill
        if (helperUp) pushGroups()
        if (helperUp && pendingSummary) {
          // The unlock summary's path: shown after the first input, no sound.
          b.send({ type: 'peek', ...pendingSummary })
          logPeek({ text: pendingSummary.text, reason: 'back on' })
          pendingSummary = undefined
        }
        orca.log(`helper ${st}${detail ? ` (${detail})` : ''}`)
        if (st === 'tripped') void record('helper.tripped', { detail })
      },
      log: (l) => orca.log(l)
    })
    bridge = b
    // Replay the current island into the new helper (the bridge replays it after every restart).
    for (const it of store.items()) b.send({ type: 'upsert', item: row(it) as never })
    b.start()
    orca.log(`helper started kind=${kind} pid=${b.pid}`)
  }
  disposers.push(() => bridge?.stop())

  // ---- master switch: off stops the helper, alerts, notifications and terminal access ------------
  let powerTimer: ReturnType<typeof setTimeout> | undefined
  /** Off items are still tracked; on return, one silent summary of what happened meanwhile. */
  const applyPower = async (next: Power, why: string): Promise<void> => {
    const was = power
    power = next
    clearTimeout(powerTimer)
    if (!next.on && next.until !== undefined) {
      powerTimer = setTimeout(() => void checkPower(), Math.max(0, next.until - wall()))
      ;(powerTimer as { unref?: () => void }).unref?.()
    }
    await orca.storage.set(POWER_KEY, JSON.parse(JSON.stringify(next))).catch((e) => orca.log(`power: ${String(e)}`))
    if (settings.enabled !== next.on) {
      settings.enabled = next.on
      await orca.settings.set('enabled', next.on).catch((e) => orca.log(`enabled: ${String(e)}`))
    }
    await pushStatus(store.summary(), true)
    if (was.on === next.on) return
    orca.log(`island ${next.on ? 'on' : `off${next.until ? ` until ${new Date(next.until).toISOString()}` : ''}`} (${why})`)
    if (!next.on) {
      // The one notification while off: how to get back (sent as it goes off; it says where).
      void orca.host
        .call('notifications.show', { title: 'Island 已关闭', body: `${next.until ? `会在 ${new Date(next.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动打开。` : ''}点状态栏的「Island 已关闭」或在插件设置里打开「启用 Orca Island」。` })
        .catch((e) => orca.log(`notifications.show failed: ${String(e)}`))
      peeks.clear()
      openId = undefined
      bridge?.stop()
      bridge = undefined
      helperUp = false
      return
    }
    await startHelper()
    const sum = !was.on ? summaryMsg(changesSummary(store.items(), was.since, wall(), 'off')) : undefined
    if (sum) pendingSummary = sum
  }
  /** Shown once the new helper is ready (silent, never a replay of peeks). */
  let pendingSummary: ReturnType<typeof summaryMsg>
  /** Timed "off" ends by itself; checked by timer and again after sleep, reload and restart. */
  const checkPower = async (): Promise<void> => {
    if (!power.on && power.until !== undefined && wall() >= power.until) await applyPower({ on: true }, 'time is up')
  }
  const turnOff = (choice: OffChoice, why: string) => applyPower({ on: false, until: offUntil(choice, wall()), since: wall() }, why)
  const turnOn = (why: string) => applyPower({ on: true }, why)
  // Timers stop while the Mac sleeps; a wall-clock check catches an end time passed meanwhile.
  // While off, the status bar is re-applied on every check: it is the way back.
  const powerCheck = setInterval(() => {
    void checkPower()
    if (!power.on) void pushStatus(store.summary(), true)
  }, testDeps.powerCheckMs ?? 30_000)
  ;(powerCheck as { unref?: () => void }).unref?.()
  disposers.push(() => {
    clearInterval(powerCheck)
    clearTimeout(powerTimer)
  })

  // ---- reconciliation & heartbeat ------------------------------------------------------------
  let pingSeq = 0
  const tick = setInterval(async () => {
    store.sweepSeen(SEEN_ROW_MS)
    if (!store.hasActive()) return // idle: no polling
    if (helperUp) bridge?.send({ type: 'ping', seq: ++pingSeq })
    const stale = store.staleWorking()
    const byWs = new Map<string, true>()
    for (const it of stale) if (it.workspaceListId) byWs.set(it.workspaceListId, true)
    for (const ws of byWs.keys()) {
      try {
        const r = await orca.host.call('agents.list', { workspaceId: ws })
        const present = new Set(r.agents.filter((a) => a.state !== 'done').map((a) => a.sessionId).filter(Boolean) as string[])
        const removed = store.reconcile(ws, present)
        if (removed.length) orca.log(`reconcile ${ws}: removed ${removed.length} stale`)
      } catch {
        store.reconcile(ws, new Set()) // workspace gone
      }
    }
  }, RECONCILE_MS)
  disposers.push(() => clearInterval(tick))

  const seedFromHost = async (): Promise<void> => {
    seeded = true
    for (const ws of wsCache.keys()) {
      try {
        const r = await orca.host.call('agents.list', { workspaceId: ws })
        for (const a of r.agents) {
          if (a.sessionId && a.agent) agentKind.set(a.sessionId, a.agent)
          if (!a.sessionId || a.state === 'done' || disposed) continue
          store.seed({
            workspaceId: null,
            workspaceListId: ws,
            paneKey: a.terminalId ? `term:${a.terminalId}` : `session:${a.sessionId}`,
            terminalId: a.terminalId ?? undefined,
            title: a.title ?? a.task?.title ?? undefined,
            state: a.state,
            receivedAt: Date.now(),
            sessionId: a.sessionId,
            mainAgent: { state: a.state, stateStartedAt: a.stateStartedAt }
          })
        }
      } catch {
        // ignore
      }
    }
  }

  // ---- startup ---------------------------------------------------------------------------------
  const ready = (async () => {
    await loadSettings()
    // Right after a reload the host can refuse for a moment ('not enabled with current consent').
    // Without the saved items every open question looks new and is announced again, so wait for it.
    for (let i = 0; i < 20 && !disposed; i++) {
      try {
        await orca.storage.keys()
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250 * (i + 1)))
      }
    }
    // Even after keys() answers, the first reads can still be refused for a moment: retry the
    // whole restore, or the saved rows, snoozes and power state are lost (and rows come back).
    for (let attempt = 0; attempt < 12 && !disposed; attempt++) {
    try {
      const saved = (await orca.storage.get(ITEMS_KEY)) as Item[] | null
      if (Array.isArray(saved) && saved.length) store.restore(saved)
      const sn = await orca.storage.get('island:snoozes')
      if (Array.isArray(sn)) store.restoreSnoozes(sn as never)
      const runs = await orca.storage.get(SEEN_RUNS_KEY)
      if (Array.isArray(runs)) seenRuns = runs as string[]
      if ((await orca.storage.get(MODE_KEY)) === 'bot') mode = 'bot'
      const pw = (await orca.storage.get(POWER_KEY)) as Power | null
      if (pw && pw.on === false) power = { on: false, since: pw.since ?? wall(), ...(typeof pw.until === 'number' ? { until: pw.until } : {}) }
      orca.log(`restored ${Array.isArray(saved) ? saved.length : 0} rows, ${Array.isArray(sn) ? sn.length : 0} snoozes, switch ${power.on ? 'on' : `off${power.until ? ` until ${new Date(power.until).toISOString()}` : ''}`}${attempt ? ` (attempt ${attempt + 1})` : ''}`)
      break
    } catch (e) {
      orca.log(`restore failed (attempt ${attempt + 1}): ${String(e)}`)
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
    }
    // The setting wins when the two disagree: it was changed while the plugin was not running
    // (whenever the island goes off the setting is set off too).
    const offSince = power.on ? undefined : power.since
    if (!settings.enabled && power.on) power = { on: false, since: wall() }
    else if (settings.enabled && !power.on) power = { on: true }
    if (!power.on && power.until !== undefined && wall() >= power.until) power = { on: true } // ended meanwhile
    if (power.on && offSince !== undefined) {
      const sum = summaryMsg(changesSummary(store.items(), offSince, wall(), 'off'))
      if (sum) pendingSummary = sum
    }
    if (!power.on && power.until !== undefined) {
      powerTimer = setTimeout(() => void checkPower(), power.until - wall())
      ;(powerTimer as { unref?: () => void }).unref?.()
    }
    if (power.on !== settings.enabled) {
      settings.enabled = power.on
      await orca.settings.set('enabled', power.on).catch((e) => orca.log(`enabled: ${String(e)}`))
    }
    await orca.storage.set(POWER_KEY, JSON.parse(JSON.stringify(power))).catch(() => undefined)
    void pushStatus(store.summary())
    await startHelper()
    // Seed sessions already waiting on the person (an approval prompt open before we started).
    await refreshWorkspaces(true)
    await startSource()
    if (!settings.orcaSource) await seedFromHost()
    else void source!.request('full').then(() => (seeded ? undefined : seedFromHost())) // CLI unavailable
  })()

  // ---- events ----------------------------------------------------------------------------------
  {
    const d = orca.events.on('agent.status.changed', async (e) => {
      await ready
      void record('agent.status.changed', e)
      const place = dir.place(e.paneKey)
      store.onAgentEvent(place?.botChat ? { ...e, botChat: true } : e)
      const id = itemIdOf(e)
      const it = store.get(id)
      if (!it) return
      applyPlace(it)
      // Names come late rather than holding up the alert.
      if (!place || (place.botChat && e.state === 'done')) source?.trigger('directory')
      if (!place) void enrich(id, e)
    })
    disposers.push(() => d.dispose())
  }
  {
    const d = orca.events.on('workspace.changed', (e) => {
      void record('workspace.changed', e)
      const now = e.context?.terminals.map((t) => t.id) ?? []
      // A terminal that was in the focused workspace and no longer is has been closed.
      if (store.presence.focusedWorkspace && store.presence.focusedWorkspace === (e.context?.workspaceId ?? null)) {
        for (const t of store.presence.focusedTerminals ?? []) if (!now.includes(t)) store.terminalClosed(t)
      }
      updatePresence({ focusedWorkspace: e.context?.workspaceId ?? null, focusedTerminals: now })
      source?.trigger('directory')
    })
    disposers.push(() => d.dispose())
  }
  {
    const d = orca.events.on('workspace.created', (e) => {
      void record('workspace.created', e)
      void refreshWorkspaces(true)
      source?.trigger('directory')
    })
    disposers.push(() => d.dispose())
  }
  {
    const d = orca.events.on('workspace.removed', (e) => {
      void record('workspace.removed', e)
      store.onWorkspaceRemoved(e.workspaceListId, e.workspaceId)
      source?.trigger('directory')
    })
    disposers.push(() => d.dispose())
  }
  const onSettingChanged = async (key: string): Promise<void> => {
      const before = { ...settings }
      await loadSettings()
      if (key === 'enabled' || before.enabled !== settings.enabled) {
        if (settings.enabled && !power.on) await turnOn('setting')
        else if (!settings.enabled && power.on) await turnOff('forever', 'setting')
        return
      }
      if (before.orcaSource !== settings.orcaSource || before.orcaCli !== settings.orcaCli) await startSource()
      if (key === 'helper' || before.helper !== settings.helper) await startHelper()
      else bridge?.send({ type: 'config', config: helperConfig() })
  }
  {
    const d = orca.settings.onDidChange(({ key }) => onSettingChanged(key))
    disposers.push(() => d.dispose())
  }

  // ---- commands (approved ids) and requests ------------------------------------------------
  const dump = async (input?: unknown) => {
    await chain
    const list = ((await orca.storage.get(EVENTS_KEY)) as Rec[] | null) ?? []
    const f = (input ?? {}) as { event?: string; last?: number }
    let out = f.event ? list.filter((r) => r.event === f.event) : list
    if (f.last) out = out.slice(-f.last)
    return { count: list.length, recording: settings.record, events: out }
  }
  const clear = async () => {
    await chain
    await orca.storage.set(EVENTS_KEY, [])
    seq = 0
    return { cleared: true }
  }
  const probe = async (input?: unknown) => {
    const want = ((input ?? {}) as { workspaceId?: string }).workspaceId
    const out: Record<string, unknown> = {}
    const tryCall = async (name: string, fn: () => Promise<unknown>) => {
      try {
        out[name] = await fn()
      } catch (e) {
        const err = e as { code?: string; message?: string }
        out[name] = { error: err.code ?? 'error', message: err.message ?? String(e) }
      }
    }
    await tryCall('readContext', () => orca.host.call('workspace.readContext'))
    await tryCall('agents.list', () => orca.host.call('agents.list'))
    if (want) await tryCall('agents.list(ws)', () => orca.host.call('agents.list', { workspaceId: want }))
    await tryCall('workspace.list', () => orca.host.call('workspace.list', { includeStatus: true }))
    out.island = { items: store.items(), summary: store.summary(), presence: store.presence }
    return out
  }
  const helperStatus = async () => {
    const seqNo = Date.now()
    const sent = bridge?.send({ type: 'ping', seq: seqNo }) ?? false
    bridge?.send({ type: 'debug_state' })
    await new Promise((r) => setTimeout(r, 400))
    return {
      pluginDir,
      kind: settings.helper,
      pid: bridge?.pid,
      up: helperUp,
      tripped: bridge?.tripped,
      build,
      lastError: bridge?.lastError,
      pingSent: sent,
      pongReceived: helperMsgs.some((m) => m.type === 'pong' && m.seq === seqNo),
      state: [...helperMsgs].reverse().find((m) => m.type === 'state'),
      presence: store.presence,
      peekLog: peekLog.slice(-20),
      canAnswer: canAnswer(),
      recent: helperMsgs.slice(-8)
    }
  }
  /** Injects a synthetic agent turn (dev/live checks): `{state, title?, terminalId?, workspaceListId?, sessionId?, workMs?}`. */
  const test = async (input?: unknown) => {
    const i = (input ?? {}) as { state?: string; title?: string; terminalId?: string; workspaceListId?: string; sessionId?: string; workMs?: number; outcome?: string }
    const sessionId = i.sessionId ?? `test-${Math.random().toString(36).slice(2, 8)}`
    const base = { workspaceId: null, workspaceListId: i.workspaceListId, paneKey: `test:${sessionId}`, terminalId: i.terminalId, title: i.title ?? 'Test agent', sessionId }
    const t0 = Date.now() - (i.workMs ?? 60_000)
    store.onAgentEvent({ ...base, state: 'working', receivedAt: t0, mainAgent: { state: 'working', stateStartedAt: t0 } } as AgentEvent)
    const st = (i.state ?? 'waiting') as AgentEvent['state']
    if (st !== 'working') {
      store.onAgentEvent({ ...base, state: st, receivedAt: Date.now(), mainAgent: { state: st, stateStartedAt: Date.now(), ...(i.outcome ? { outcome: i.outcome } : {}) } } as AgentEvent)
    }
    return { id: `s:${sessionId}` }
  }
  const remove = async (input?: unknown) => {
    const id = ((input ?? {}) as { id?: string }).id
    store.markRead(id ? [id] : undefined)
    return { ok: true }
  }
  const restartHelper = async (input?: unknown) => {
    await startHelper(((input ?? {}) as { kind?: string }).kind)
    return { pid: bridge?.pid }
  }
  /** Status bar press: jump to the next needs-you / unread item; with nothing pending, open the sidebar. */
  const statusClick = async () => {
    if (!power.on) {
      await turnOn('status bar')
      void record('statusBar.pressed', { turnedOn: true })
      return { turnedOn: true }
    }
    const r = (await jumpNext()) as { jumped: boolean }
    if (!r.jumped) {
      try {
        await orca.host.call('commands.run', { action: 'sidebar.right.toggle' })
      } catch (e) {
        orca.log(`commands.run failed: ${String(e)}`)
      }
    }
    void record('statusBar.pressed', r)
    return r
  }
  const reset = async () => {
    for (const it of store.items()) store.markRead([it.id])
    store.dispose()
    bridge?.resetItems()
    bridge?.send({ type: 'reset' })
    await orca.storage.set(ITEMS_KEY, [])
    return { ok: true, remaining: store.items().length }
  }

  const table: Record<string, (input?: unknown) => Promise<unknown>> = {
    // approved palette commands
    'island.dump': dump,
    'island.clear': clear,
    'island.probe': probe,
    'island.helper.status': helperStatus,
    'island.helper.restart': restartHelper,
    'island.test': test,
    'island.statusClick': statusClick,
    // requests only (no manifest change)
    'island.next': jumpNext,
    /** Status bar pause button (no args): off for 1 hour; pressed while off, on again. As a request:
     *  `{on: true}` or `{on: false, choice: 'hour' | 'morning' | 'forever'}`. */
    'island.power': async (input) => {
      if (input === undefined || input === null || (typeof input === 'object' && !('on' in (input as object)))) {
        if (power.on) await turnOff('hour', 'status bar')
        else await turnOn('status bar')
        return power
      }
      const i = (input ?? {}) as { on?: boolean; choice?: OffChoice }
      if (i.on) await turnOn('request')
      else await turnOff(i.choice === 'hour' || i.choice === 'morning' ? i.choice : 'forever', 'request')
      return power
    },
    'island.markRead': remove,
    'island.dismiss': async (input) => (await onHelper({ type: 'clicked', action: 'dismiss', id: String((input as { id?: string })?.id) }), { ok: true }),
    'island.clearFinished': async () => (await onHelper({ type: 'clicked', action: 'clear_finished' }), { ok: true, finished: store.finishedCount() }),
    'island.undo': async () => (await onHelper({ type: 'clicked', action: 'undo' }), { ok: true }),
    /** Clears the rows of a terminal that was closed (also done automatically on workspace changes). */
    'island.terminalClosed': async (input) => ({ removed: store.terminalClosed(String((input as { terminalId?: string })?.terminalId)) }),
    'island.snooze': async (input) => {
      const min = ((input ?? {}) as { minutes?: number }).minutes ?? 30
      updatePresence({ snoozeUntil: Date.now() + min * 60_000 })
      return { snoozeUntil: store.presence.snoozeUntil }
    },
    'island.items': async () => ({ items: store.items(), summary: store.summary(), presence: store.presence, helperUp, power }),
    'island.reset': reset,
    'island.jump': async (input) => focusItem(String((input as { id?: string })?.id)),
    /** Live check only: the host's workspace.open, to compare jump targets. */
    'island.openWorkspace': async (input) => orca.host.call('workspace.open', { workspaceId: String((input as { workspaceId?: string })?.workspaceId) }),
    'island.open': async (input) => openDetail(String((input as { id?: string })?.id)),
    'island.answer': async (input) => answerFrom((input ?? {}) as Record<string, unknown>),
    'island.groups': async (input) => buildGroups(store.items(), ((input ?? {}) as { mode?: GroupMode }).mode ?? mode, toggled),
    'island.setMode': async (input) => {
      const m = ((input ?? {}) as { mode?: string }).mode
      if (m === 'project' || m === 'bot') await setMode(m)
      return { mode }
    },
    'island.refresh': async () => {
      await source?.request('full')
      return { ok: !!source && !source.backingOff }
    },
    'island.record': async (input) => {
      const on = ((input ?? {}) as { on?: boolean }).on !== false
      await orca.settings.set('record', on)
      settings.record = on
      return { record: on }
    },
    /** Tests: handle a message as if the helper had sent it. */
    'island.helperMsg': async (input) => (await onHelper(input as HelperMsg), { ok: true }),
    'island.helper.send': async (input) => ({ sent: bridge?.send(input as HelperMsg) ?? false })
  }
  const PALETTE = new Set(['island.dump', 'island.clear', 'island.probe', 'island.helper.status', 'island.helper.restart', 'island.test', 'island.statusClick', 'island.power'])
  for (const [name, fn] of Object.entries(table)) {
    // Answers must be strict JSON: undefined fields are refused ("non-JSON value"), so round-trip.
    orca.panels.handle(name as never, async (input: unknown) => JSON.parse(JSON.stringify((await fn(input)) ?? null)) as never)
    if (PALETTE.has(name)) orca.commands.register(name, async (args) => JSON.parse(JSON.stringify((await fn(args)) ?? null)))
  }

  stopAll = () => {
    disposed = true
    clearTimeout(persistTimer)
    for (const d of disposers.splice(0)) {
      try {
        d()
      } catch {
        // ignore
      }
    }
  }
}

let stopAll: (() => void) | undefined
export function deactivate(): void {
  stopAll?.()
}
