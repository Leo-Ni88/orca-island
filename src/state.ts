// Session state machine for Island for Orca (docs/architecture.md, "State machine").
// Pure: no Orca APIs, clock and timers are injected, so it unit-tests deterministically.
//
// Rules learned from recorded agent sessions (docs/architecture.md):
// - Claude Code tool-permission prompt arrives as `waiting` (never `blocked`) -> P0 needs_you.
// - A finished turn is `done` with NO outcome -> success. `cancellation`/`superseded` -> silent.
// - Every new session starts with a spurious `done` before its first `working` -> ignored.
// - `working` is re-sent with the same stateStartedAt -> dedupe on (state, stateStartedAt).
// - Stale frames can replay an older stateStartedAt -> ignore anything older than what we have.
// - terminalId/title drop on later frames -> key on paneKey|sessionId, remember terminalId per pane.

export type RawState = 'working' | 'blocked' | 'waiting' | 'done'
export type Outcome = 'success' | 'failure' | 'cancellation' | 'superseded' | 'interruption' | 'unconfirmed'

export type AgentEvent = {
  workspaceId: string | null
  workspaceListId?: string
  paneKey: string
  terminalId?: string
  title?: string
  state: RawState
  receivedAt: number
  mainAgent?: { state: RawState; outcome?: Outcome; stateStartedAt: number }
  sessionId?: string
  /** A bot's own chat: every finished turn is a reply to you, however short. */
  botChat?: boolean
}

export type Display = 'needs_you' | 'failed' | 'done' | 'interrupted' | 'working'
export type Priority = 0 | 1 | 2 | 3 | 4

export type Item = {
  id: string
  paneKey: string
  sessionId: string | null
  terminalId: string | null
  workspaceListId: string | null
  title: string
  workspace?: string
  branch?: string
  agent?: string
  state: Display
  priority: Priority
  outcome?: Outcome
  /** When the current turn started (first `working`). */
  startedAt: number
  /** When `state` was entered (for "waiting 2m"). */
  stateSince: number
  unread: boolean
  lastEventAt: number
  /** 'session' (default) or an entry from the orca source. */
  kind?: 'session' | 'bot_item' | 'plugin' | 'automation' | 'gate'
  detail?: string
  options?: string[]
  /** The whole question, for the detail view. */
  question?: string
  asks?: { question: string; options: { label: string; recommended: boolean }[] }[]
  intro?: string
  openUrl?: string
  /** Chat tab to look for after a jump that can only open the bot or workspace. */
  tab?: string
  /** Readable name from the directory; `title` is what the agent event said. */
  name?: string
  project?: string
  bot?: string
  botChat?: boolean
  dispatched?: boolean
  /** Orca-source entries: scope and version, so a refresh neither duplicates nor re-announces. */
  scope?: string
  version?: string
  /** The one P0 re-alert has been used (survives worker restarts). */
  realerts: number
}

export type ExternalEntry = {
  id: string
  kind: NonNullable<Item['kind']>
  version: string
  state: 'needs_you' | 'failed'
  title: string
  detail?: string
  options?: string[]
  question?: string
  asks?: Item['asks']
  intro?: string
  tab?: string
  since: number
  openUrl?: string
  bot?: string
  project?: string
  workspace?: string
  workspaceListId?: string
}

export type Alert = {
  ids: string[]
  kind: 'single' | 'batch'
  /** Highest priority among ids (0 = needs you). */
  priority: Priority
  /** System sound name, or undefined when muted / rate limited / suppressed. */
  sound?: string
  /** Show a peek (false = pill/counts only), and for which ids, in order. */
  peek: boolean
  peekIds: string[]
  ttlMs: number
  reason: 'new' | 'realert'
  /** Why some ids are not in peekIds. */
  suppressedBy?: string
  counts: { needs_you: number; failed: number; done: number; interrupted: number }
}

export type Summary = {
  blocked: number
  working: number
  unreadDone: number
  unreadFailed: number
  total: number
}

export type Config = {
  needsYouStableMs: number
  doneStableMs: number
  minWorkSec: number
  aggregateMs: number
  realertMs: number
  maxRealerts: number
  soundMinIntervalMs: number
  staleWorkingMs: number
  peekMs: { p0: number; p1: number; p2: number }
  sounds: boolean
  /** Preset: quiet = P0+P1 only; standard; all = also peek P3 (unused: no P3 events today). */
  preset: 'quiet' | 'standard' | 'all'
}

export const DEFAULT_CONFIG: Config = {
  needsYouStableMs: 1500,
  doneStableMs: 3000,
  minWorkSec: 20,
  aggregateMs: 2500,
  realertMs: 3 * 60_000,
  maxRealerts: 1,
  soundMinIntervalMs: 10_000,
  staleWorkingMs: 20 * 60_000,
  peekMs: { p0: 7000, p1: 6000, p2: 4000 },
  sounds: true,
  preset: 'standard'
}

/** Context the delivery policy needs, owned by the worker. */
export type PresenceContext = {
  /** Orca is the frontmost app. */
  orcaFrontmost: boolean
  /** workspaceListId of Orca's focused workspace. */
  focusedWorkspace: string | null
  /** Terminals of that workspace (Orca does not say which pane has focus). */
  focusedTerminals?: string[]
  /** Screen locked: no sounds. */
  locked: boolean
  /** Snoozed (pause reminders) until this epoch ms. */
  snoozeUntil: number
}

export type Timers = {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export type Output = {
  upsert(item: Item): void
  remove(id: string): void
  summary(s: Summary): void
  alert(a: Alert): void
}

type Session = Item & {
  seenWorking: boolean
  /** (state, stateStartedAt) of the last processed frame, for dedupe. */
  lastKey: string
  lastStateStartedAt: number
  pending?: { display: Display; outcome?: Outcome; timer: unknown; startedAt: number }
  realertTimer?: unknown
  /** Item is shown in the island (false while a fresh session has not yet worked). */
  visible: boolean
}

const FINISHED = new Set<Display>(['done', 'failed', 'interrupted'])
const PRIORITY: Record<Display, Priority> = { needs_you: 0, failed: 1, done: 2, interrupted: 2, working: 4 }
const SOUND: Partial<Record<Display, string>> = { needs_you: 'Ping', failed: 'Basso', done: 'Glass' }

/**
 * Item key. sessionId is a UUID and survives everything we observed (terminalId and title drop,
 * paneKey is not available from agents.list), so it wins; paneKey is the fallback.
 */
export const itemIdOf = (e: Pick<AgentEvent, 'paneKey' | 'sessionId'>): string => {
  // Orca chats: the Orca session id in the paneKey is what the CLI lists too, so events and
  // `worktree ps` land on one item (the event's sessionId is the provider's, and changes on /clear).
  const chat = /^structured-agent-session-([0-9a-f-]{36})/.exec(e.paneKey)?.[1]
  return chat ? `c:${chat}` : e.sessionId ? `s:${e.sessionId}` : `p:${e.paneKey}`
}

export class SessionStore {
  private sessions = new Map<string, Session>()
  /** Last known terminalId/title per paneKey (frames often drop them). */
  private paneInfo = new Map<string, { terminalId?: string; title?: string }>()
  private alertBuf: { id: string; display: Display; reason: 'new' | 'realert' }[] = []
  private aggTimer: unknown
  private lastSoundAt = -Infinity
  config: Config
  presence: PresenceContext = { orcaFrontmost: false, focusedWorkspace: null, locked: false, snoozeUntil: 0 }

  constructor(
    private t: Timers,
    private out: Output,
    config: Partial<Config> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ---------------------------------------------------------------- input

  /**
   * Seeds from agents.list at startup/reconcile: the session is known to exist, so a `waiting`
   * already showing must count (no spurious-done risk: agents.list reports settled states).
   */
  seed(raw: AgentEvent): void {
    const id = itemIdOf(raw)
    if (this.sessions.has(id)) return
    for (const x of this.sessions.values()) if (x.paneKey === raw.paneKey || (raw.sessionId && x.sessionId === raw.sessionId)) return
    this.onAgentEvent({ ...raw, state: 'working', mainAgent: { state: 'working', stateStartedAt: (raw.mainAgent?.stateStartedAt ?? raw.receivedAt) - 1 } })
    const s = this.sessions.get(id)
    if (s && (raw.state === 'working')) return
    if (s && raw.state !== 'done') this.onAgentEvent(raw)
    else if (s) this.hide(s) // finished before we started: nothing to announce
  }

  onAgentEvent(raw: AgentEvent): void {
    const now = this.t.now()
    const info = this.paneInfo.get(raw.paneKey) ?? {}
    const terminalId = raw.terminalId ?? info.terminalId
    const title = raw.title || info.title
    this.paneInfo.set(raw.paneKey, { terminalId, title })

    const state: RawState = raw.mainAgent?.state ?? raw.state
    // a sub-agent blocked while mainAgent is not still needs you.
    const effective: RawState = raw.state === 'blocked' ? 'blocked' : state
    const startedAt = raw.mainAgent?.stateStartedAt ?? raw.receivedAt
    const outcome = raw.mainAgent?.outcome
    const id = itemIdOf(raw)

    // The same session seeded or persisted under another key (no paneKey/sessionId yet): move it.
    if (!this.sessions.has(id)) {
      const old = [...this.sessions.values()].find((x) => !x.scope && ((raw.sessionId && x.sessionId === raw.sessionId) || (x.paneKey === raw.paneKey && !x.sessionId)))
      if (old) this.rekey(old, id)
    }
    // A new session in a pane replaces the previous one there.
    for (const s of this.sessions.values()) {
      if (s.paneKey === raw.paneKey && s.id !== id) this.drop(s.id)
    }

    let s = this.sessions.get(id)
    if (!s) {
      s = {
        id,
        paneKey: raw.paneKey,
        sessionId: raw.sessionId ?? null,
        terminalId: terminalId ?? null,
        workspaceListId: raw.workspaceListId ?? null,
        title: title || 'Agent',
        state: 'working',
        priority: 4,
        startedAt,
        stateSince: startedAt,
        unread: false,
        lastEventAt: now,
        seenWorking: false,
        lastKey: '',
        lastStateStartedAt: -Infinity,
        realerts: 0,
        visible: false
      }
      this.sessions.set(id, s)
    }
    s.lastEventAt = now
    s.paneKey = raw.paneKey
    if (raw.sessionId) s.sessionId = raw.sessionId
    if (terminalId) s.terminalId = terminalId
    if (title && title !== s.title) {
      s.title = title
      if (s.visible) this.out.upsert(this.view(s))
    }
    if (raw.workspaceListId) s.workspaceListId = raw.workspaceListId
    if (raw.botChat) s.botChat = true

    const key = `${effective}:${startedAt}:${outcome ?? ''}`
    if (key === s.lastKey) return // duplicate frame
    if (startedAt < s.lastStateStartedAt) return // stale replay of an older state
    s.lastKey = key
    s.lastStateStartedAt = startedAt
    // Any new state ends a snooze: the prompt was answered, or another one is open.
    if (this.snoozed.delete(s.id)) this.armSnoozeTimer()

    switch (effective) {
      case 'working':
        return this.toWorking(s, startedAt)
      case 'waiting':
      case 'blocked':
        return this.toNeedsYou(s, startedAt)
      case 'done':
        return this.toDone(s, startedAt, outcome)
    }
  }

  private toWorking(s: Session, startedAt: number): void {
    this.cancelPending(s) // a done/needs_you still inside its stable window is discarded
    this.cancelRealert(s)
    const continuing = s.visible && (s.state === 'working' || s.state === 'needs_you')
    // After a permission answer the same turn goes on; anything else starts a new turn.
    if (!continuing) s.startedAt = startedAt
    s.seenWorking = true
    s.unread = false
    this.setState(s, 'working', startedAt)
  }

  private toNeedsYou(s: Session, startedAt: number): void {
    if (!s.seenWorking) return // idle prompt before any work
    if (s.state === 'needs_you' && !s.pending) return
    this.cancelPending(s)
    s.pending = {
      display: 'needs_you',
      startedAt,
      timer: this.t.set(() => this.commit(s.id), this.config.needsYouStableMs)
    }
  }

  private toDone(s: Session, startedAt: number, outcome?: Outcome): void {
    if (!s.seenWorking) return // spurious done at session start
    this.cancelPending(s)
    this.cancelRealert(s)
    if (outcome === 'cancellation' || outcome === 'superseded') {
      // Silent: just clear the item.
      s.seenWorking = true
      this.hide(s)
      return
    }
    let display: Display = 'done'
    if (outcome === 'failure') display = 'failed'
    else if (outcome === 'interruption') display = 'interrupted'
    if (display === 'done' && !s.botChat && (startedAt - s.startedAt) / 1000 < this.config.minWorkSec) {
      // Too short to be worth a completion alert (counts only).
      this.hide(s)
      return
    }
    s.pending = { display, outcome, startedAt, timer: this.t.set(() => this.commit(s.id), this.config.doneStableMs) }
  }

  private commit(id: string): void {
    const s = this.sessions.get(id)
    if (!s?.pending) return
    const { display, outcome, startedAt } = s.pending
    s.pending = undefined
    s.outcome = outcome
    s.unread = true
    s.realerts = 0
    this.setState(s, display, startedAt)
    this.queueAlert(s.id, display, 'new')
    if (display === 'needs_you') this.scheduleRealert(s)
  }

  private scheduleRealert(s: Session): void {
    this.cancelRealert(s)
    if (s.realerts >= this.config.maxRealerts) return
    s.realertTimer = this.t.set(() => {
      s.realertTimer = undefined
      if (this.sessions.get(s.id) !== s || s.state !== 'needs_you' || !s.visible) return
      s.realerts++
      this.out.upsert(this.view(s)) // persisted: a restart does not re-alert again
      this.queueAlert(s.id, 'needs_you', 'realert')
      this.scheduleRealert(s)
    }, this.config.realertMs)
  }

  private cancelRealert(s: Session): void {
    if (s.realertTimer !== undefined) this.t.clear(s.realertTimer)
    s.realertTimer = undefined
  }

  private cancelPending(s: Session): void {
    if (s.pending) this.t.clear(s.pending.timer)
    s.pending = undefined
  }

  private setState(s: Session, display: Display, since: number): void {
    const changed = s.state !== display || !s.visible
    s.state = display
    s.priority = PRIORITY[display]
    if (changed) s.stateSince = since
    s.visible = true
    this.out.upsert(this.view(s))
    this.emitSummary()
  }

  /** Remove from the island but keep the session (its pane may start a new turn). */
  private hide(s: Session): void {
    this.cancelPending(s)
    this.cancelRealert(s)
    s.unread = false
    s.state = 'working'
    s.priority = 4
    if (s.visible) {
      s.visible = false
      this.out.remove(s.id)
      this.emitSummary()
    }
  }

  private rekey(s: Session, id: string): void {
    if (s.visible) this.out.remove(s.id)
    this.sessions.delete(s.id)
    for (const a of this.alertBuf) if (a.id === s.id) a.id = id
    s.id = id
    this.sessions.set(id, s)
    if (s.visible) this.out.upsert(this.view(s))
  }

  private drop(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.hide(s)
    this.sessions.delete(id)
    this.alertBuf = this.alertBuf.filter((a) => a.id !== id)
  }

  // ---------------------------------------------------------------- alerts

  private queueAlert(id: string, display: Display, reason: 'new' | 'realert'): void {
    this.alertBuf = this.alertBuf.filter((a) => a.id !== id)
    this.alertBuf.push({ id, display, reason })
    if (reason === 'realert') {
      // Several prompts announced together come due together: one reminder, not one each.
      if (this.aggTimer === undefined) this.aggTimer = this.t.set(() => this.flushAlerts(), 250)
      return
    }
    if (display === 'needs_you') {
      // P0 never waits for the aggregation window; it takes whatever is queued along.
      this.flushAlerts()
      return
    }
    if (this.aggTimer === undefined) this.aggTimer = this.t.set(() => this.flushAlerts(), this.config.aggregateMs)
  }

  flushAlerts(): void {
    if (this.aggTimer !== undefined) this.t.clear(this.aggTimer)
    this.aggTimer = undefined
    const buf = this.alertBuf.filter((a) => {
      const s = this.sessions.get(a.id)
      return s && s.visible && s.state === a.display
    })
    this.alertBuf = []
    if (!buf.length) return
    buf.sort((a, b) => PRIORITY[a.display] - PRIORITY[b.display])
    const top = buf[0]
    const priority = PRIORITY[top.display]
    const counts = { needs_you: 0, failed: 0, done: 0, interrupted: 0 }
    for (const a of buf) if (a.display !== 'working') counts[a.display]++
    const alert: Alert = {
      ids: buf.map((a) => a.id),
      kind: buf.length > 1 ? 'batch' : 'single',
      priority,
      peek: true,
      peekIds: [],
      ttlMs: priority === 0 ? this.config.peekMs.p0 : priority === 1 ? this.config.peekMs.p1 : this.config.peekMs.p2,
      reason: buf.some((a) => a.reason === 'new') ? 'new' : 'realert',
      counts
    }
    this.applyPolicy(alert, buf.map((a) => this.sessions.get(a.id)!), top.display)
    this.out.alert(alert)
  }

  /** Only certain when the focused workspace holds this one terminal. */
  private lookingAt(s: Session): boolean {
    const p = this.presence
    return !!(p.orcaFrontmost && s.terminalId && s.workspaceListId === p.focusedWorkspace && p.focusedTerminals?.length === 1 && p.focusedTerminals[0] === s.terminalId)
  }

  /** Suppression, presets, snooze and the sound rate limit (docs/architecture.md). */
  private applyPolicy(a: Alert, items: Session[], top: Display): void {
    const p = this.presence
    const now = this.t.now()
    let sound = this.config.sounds ? SOUND[top] : undefined
    // interrupted is "red-grey, silent"
    if (top === 'interrupted') sound = undefined
    if (this.config.preset === 'quiet' && a.priority >= 2) {
      a.peek = false
      a.suppressedBy = 'quiet preset'
      sound = undefined
    }
    if (now < p.snoozeUntil) {
      a.peek = false
      a.suppressedBy = 'snoozed'
      sound = undefined
    }
    // Orca's own decisions matter inside Orca too: a new prompt always peeks, unless the person is
    // looking at that very terminal. Finished work while Orca is in front only changes counts.
    const peeking = a.peek ? items.filter((s) => (s.state === 'needs_you' ? !this.lookingAt(s) : !p.orcaFrontmost)) : []
    a.peekIds = peeking.map((s) => s.id)
    if (a.peek && peeking.length < items.length) a.suppressedBy = p.orcaFrontmost ? 'Orca in front (done/failed only update counts), or looking at that terminal' : 'policy'
    a.peek = peeking.length > 0
    if (!a.peek) sound = undefined
    if (p.locked) sound = undefined
    if (sound && a.priority > 0) {
      if (now - this.lastSoundAt < this.config.soundMinIntervalMs) sound = undefined
    }
    if (sound) this.lastSoundAt = now
    a.sound = sound
  }

  // ---------------------------------------------------------------- user actions

  /** Marks items read; finished items leave the island once read. */
  markRead(ids?: string[]): void {
    const targets = ids ? ids.map((i) => this.sessions.get(i)).filter(Boolean) as Session[] : [...this.sessions.values()]
    let changed = false
    for (const s of targets) {
      if (!s.visible || !s.unread) continue
      if (s.state === 'needs_you') {
        // Reading does not answer the prompt: it stays until the agent moves on, but stops re-alerting.
        s.unread = false
        this.cancelRealert(s)
        this.out.upsert(this.view(s))
        changed = true
        continue
      }
      this.hide(s)
      changed = true
    }
    if (changed) this.emitSummary()
  }

  // ---------------------------------------------------------------- dismiss and clear

  /** Hidden needs-you rows: id -> until (epoch ms) and the question version when hidden. */
  private snoozed = new Map<string, { until: number; version?: string }>()
  private snoozeTimer: unknown
  static readonly SNOOZE_MS = 30 * 60_000

  /**
   * × on a row. Finished rows leave at once (a new event on that session shows it again).
   * Needs-you rows cannot go while the question is open: they are hidden for 30 min, or until the
   * question changes. Running rows have no ×. Returns what happened, for the undo toast.
   */
  dismiss(id: string): { kind: 'removed' | 'snoozed'; item: Item } | undefined {
    const s = this.sessions.get(id)
    if (!s?.visible || s.state === 'working') return undefined
    const item = this.view(s)
    if (s.state === 'needs_you') {
      this.snoozed.set(id, { until: this.t.now() + SessionStore.SNOOZE_MS, version: s.version })
      this.cancelRealert(s)
      s.visible = false
      this.out.remove(id)
      this.armSnoozeTimer()
      this.emitSummary()
      return { kind: 'snoozed', item }
    }
    this.forget(s)
    this.hide(s)
    return { kind: 'removed', item }
  }

  /** "清空已完成": every finished row (done, failed, interrupted), read or not. */
  clearFinished(): Item[] {
    const gone = [...this.sessions.values()].filter((s) => s.visible && FINISHED.has(s.state))
    const items = gone.map((s) => this.view(s))
    for (const s of gone) {
      this.forget(s)
      this.hide(s)
    }
    return items
  }

  /**
   * A removed bot or run row is re-reported by every poll and after a restart; remember its
   * version (for a week) so the same reply stays gone. A new version shows again.
   */
  private forget(s: Session): void {
    if (!s.scope || !s.version) return
    this.snoozed.set(s.id, { until: this.t.now() + 7 * 24 * 3600_000, version: s.version })
    this.armSnoozeTimer()
  }

  finishedCount(): number {
    return [...this.sessions.values()].filter((s) => s.visible && FINISHED.has(s.state)).length
  }

  /** Undo of × or clear: the rows come back as they were, unless the session moved on meanwhile. */
  undo(items: Item[]): void {
    for (const it of items) {
      this.snoozed.delete(it.id)
      const s = this.sessions.get(it.id)
      if (s?.visible || (s && s.lastEventAt > it.lastEventAt)) continue
      if (s) {
        Object.assign(s, it, { visible: true })
        this.out.upsert(this.view(s))
      } else this.restore([it])
      const back = this.sessions.get(it.id)
      if (back?.state === 'needs_you' && back.unread) this.scheduleRealert(back)
    }
    this.armSnoozeTimer()
    this.emitSummary()
  }

  isSnoozed(id: string): boolean {
    return this.snoozed.has(id)
  }

  /** For persistence. */
  snoozes(): [string, { until: number; version?: string }][] {
    return [...this.snoozed]
  }

  restoreSnoozes(list: [string, { until: number; version?: string }][]): void {
    for (const [id, v] of list) {
      if (v.until <= this.t.now()) continue
      const s = this.sessions.get(id)
      if (s && s.version !== v.version) continue // asked again since: show the new question
      this.snoozed.set(id, v)
      if (s?.visible && s.state === 'needs_you') {
        s.visible = false
        this.cancelRealert(s)
        this.out.remove(id)
      }
    }
    this.armSnoozeTimer()
    this.emitSummary()
  }

  private armSnoozeTimer(): void {
    if (this.snoozeTimer !== undefined) this.t.clear(this.snoozeTimer)
    this.snoozeTimer = undefined
    if (!this.snoozed.size) return
    const next = Math.min(...[...this.snoozed.values()].map((v) => v.until))
    this.snoozeTimer = this.t.set(() => {
      this.snoozeTimer = undefined
      const now = this.t.now()
      for (const [id, v] of [...this.snoozed]) if (v.until <= now) this.unsnooze(id)
      this.armSnoozeTimer()
    }, Math.max(0, next - this.t.now()))
  }

  /** Still open after the snooze: show it again, with one reminder. */
  private unsnooze(id: string): void {
    this.snoozed.delete(id)
    const s = this.sessions.get(id)
    if (!s || s.visible || s.state !== 'needs_you') return
    s.visible = true
    s.unread = true
    s.realerts = 0
    this.out.upsert(this.view(s))
    this.queueAlert(id, 'needs_you', 'realert')
    this.scheduleRealert(s)
    this.emitSummary()
  }

  /**
   * The next item to jump to: unread needs_you (oldest first), unread failed, unread done, then
   * already-seen needs_you (still unanswered). Jumping marks read, so repeated presses cycle.
   */
  next(): Item | undefined {
    const rank = (s: Session): number =>
      s.unread ? ({ needs_you: 0, failed: 1, done: 2, interrupted: 3, working: 9 } as const)[s.state] : s.state === 'needs_you' ? 4 : 9
    const cands = [...this.sessions.values()].filter((s) => s.visible && rank(s) < 9)
    cands.sort((a, b) => rank(a) - rank(b) || a.stateSince - b.stateSince)
    return cands[0] ? this.view(cands[0]) : undefined
  }

  /** The terminal is gone, or another one was found. */
  setTerminal(id: string, terminalId: string | null): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.terminalId = terminalId
    const info = this.paneInfo.get(s.paneKey)
    if (info) info.terminalId = terminalId ?? undefined
    if (s.visible) this.out.upsert(this.view(s))
  }

  /** A terminal closed: its prompt can no longer be answered, so its row goes (any state). */
  terminalClosed(terminalId: string): string[] {
    const gone = [...this.sessions.values()].filter((s) => !s.scope && s.terminalId === terminalId).map((s) => s.id)
    for (const id of gone) this.drop(id)
    return gone
  }

  get(id: string): Item | undefined {
    const s = this.sessions.get(id)
    return s ? this.view(s) : undefined
  }

  items(): Item[] {
    return [...this.sessions.values()].filter((s) => s.visible).map((s) => this.view(s))
  }

  enrich(id: string, extra: Partial<Pick<Item, 'workspace' | 'branch' | 'agent' | 'title' | 'name' | 'project' | 'bot' | 'detail' | 'botChat' | 'dispatched' | 'openUrl' | 'tab'>>): void {
    const s = this.sessions.get(id)
    if (!s) return
    let changed = false
    for (const k of ['workspace', 'branch', 'agent', 'title', 'name', 'project', 'bot', 'detail', 'botChat', 'dispatched', 'openUrl', 'tab'] as const) {
      const v = extra[k]
      if (v && s[k] !== v) {
        ;(s as Record<string, unknown>)[k] = v
        changed = true
      }
    }
    if (changed && s.visible) this.out.upsert(this.view(s))
  }

  /** Seen in the open card: no longer unread, but stays listed for a while. */
  markSeen(ids: string[]): void {
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (!s?.visible || !s.unread || s.state === 'needs_you' || s.state === 'working') continue
      s.unread = false
      s.lastEventAt = this.t.now()
      this.out.upsert(this.view(s))
    }
    this.emitSummary()
  }

  /** Finished rows already seen leave after `ms`. needs_you, unread and working never do. */
  sweepSeen(ms: number): void {
    const now = this.t.now()
    for (const s of this.sessions.values()) {
      if (s.visible && !s.unread && s.state !== 'needs_you' && s.state !== 'working' && now - s.lastEventAt >= ms) this.hide(s)
    }
  }

  // ---------------------------------------------------------------- orca source

  /**
   * Makes `scope` hold exactly `entries`. New or re-asked entries are announced together, once;
   * unchanged ones are only refreshed; missing ones (answered, snoozed) leave without a sound.
   */
  syncExternal(scope: string, entries: ExternalEntry[]): void {
    const ids = new Set(entries.map((e) => e.id))
    for (const s of [...this.sessions.values()]) if (s.scope === scope && !ids.has(s.id)) this.drop(s.id)
    const fresh = entries.filter((e) => this.putExternal(scope, e))
    for (const e of fresh) this.alertBuf.push({ id: e.id, display: e.state, reason: 'new' })
    // Found by polling, so a moment's wait costs nothing: one refresh makes one preview.
    if (fresh.length) this.armAggregate()
    this.emitSummary()
  }

  /** Adds one-shot entries (a failed run): announced once, they stay until read. */
  addExternal(scope: string, entries: ExternalEntry[]): void {
    const fresh = entries.filter((e) => !this.sessions.has(e.id) && this.putExternal(scope, e))
    for (const e of fresh) this.alertBuf.push({ id: e.id, display: e.state, reason: 'new' })
    if (fresh.length) this.armAggregate()
  }

  private armAggregate(): void {
    if (this.aggTimer === undefined) this.aggTimer = this.t.set(() => this.flushAlerts(), this.config.aggregateMs)
  }

  /** Drops entries whose scope (a deleted bot) no longer exists. */
  keepScopes(prefix: string, alive: string[]): void {
    for (const s of [...this.sessions.values()]) if (s.scope?.startsWith(prefix) && !alive.includes(s.scope)) this.drop(s.id)
  }

  /** True when the entry is new, or asks something new. */
  private putExternal(scope: string, e: ExternalEntry): boolean {
    const old = this.sessions.get(e.id)
    const isNew = !old || old.version !== e.version
    const fields = { title: e.title, detail: e.detail, options: e.options, question: e.question, asks: e.asks, intro: e.intro, tab: e.tab, openUrl: e.openUrl, bot: e.bot, project: e.project, workspace: e.workspace, workspaceListId: e.workspaceListId ?? null }
    if (old && !isNew) {
      const before = JSON.stringify(this.view(old))
      Object.assign(old, fields)
      if (old.visible && JSON.stringify(this.view(old)) !== before) this.out.upsert(this.view(old))
      return false
    }
    // Snoozed with this same question (e.g. restored after a reload): keep it, hidden and quiet.
    const sz = this.snoozed.get(e.id)
    if (sz && sz.version === e.version && !old) {
      const hidden: Session = {
        id: e.id, paneKey: e.id, sessionId: null, terminalId: null, kind: e.kind, scope, version: e.version, ...fields,
        state: e.state, priority: PRIORITY[e.state], startedAt: e.since, stateSince: e.since, unread: true,
        lastEventAt: this.t.now(), seenWorking: true, lastKey: '', lastStateStartedAt: e.since, realerts: 0, visible: false
      }
      this.sessions.set(e.id, hidden)
      return false
    }
    // A snoozed item that asks something new comes back as a new question.
    if (sz && this.snoozed.delete(e.id)) this.armSnoozeTimer()
    if (old) this.cancelRealert(old)
    const s: Session = {
      id: e.id, paneKey: e.id, sessionId: null, terminalId: null, kind: e.kind, scope, version: e.version, ...fields,
      state: e.state, priority: PRIORITY[e.state], startedAt: e.since, stateSince: e.since, unread: true,
      lastEventAt: this.t.now(), seenWorking: true, lastKey: '', lastStateStartedAt: e.since, realerts: 0, visible: true
    }
    this.sessions.set(e.id, s)
    this.out.upsert(this.view(s))
    if (e.state === 'needs_you') this.scheduleRealert(s)
    return true
  }

  // ---------------------------------------------------------------- persistence

  /** Visible items, for persisting across worker restarts. */
  snapshot(): Item[] {
    return this.items()
  }

  /** Restores persisted items (before any event). needs_you re-arms its re-alert; nothing re-alerts now. */
  restore(items: Item[]): void {
    for (const it of items) {
      if (this.sessions.has(it.id)) continue
      const s: Session = {
        ...it,
        seenWorking: true,
        lastKey: '',
        lastStateStartedAt: it.state === 'working' ? it.startedAt : it.stateSince,
        realerts: it.realerts ?? 0,
        visible: true
      }
      s.lastEventAt = this.t.now()
      this.sessions.set(it.id, s)
      if (it.terminalId) this.paneInfo.set(it.paneKey, { terminalId: it.terminalId, title: it.title })
      this.out.upsert(this.view(s))
      if (s.state === 'needs_you' && s.unread) this.scheduleRealert(s)
    }
    this.emitSummary()
  }

  // ---------------------------------------------------------------- lifecycle

  onWorkspaceRemoved(workspaceListId: string | undefined, workspaceId?: string): void {
    for (const s of [...this.sessions.values()]) {
      if ((workspaceListId && s.workspaceListId === workspaceListId) || (workspaceId && s.paneKey.includes(workspaceId))) this.drop(s.id)
    }
  }

  /** Working sessions with no event for staleWorkingMs: candidates for agents.list reconciliation. */
  staleWorking(): Item[] {
    const now = this.t.now()
    return [...this.sessions.values()]
      .filter((s) => s.visible && s.state === 'working' && !s.pending && now - s.lastEventAt >= this.config.staleWorkingMs)
      .map((s) => this.view(s))
  }

  /** Removes stale working items whose session agents.list no longer reports. Never touches needs_you or unread. */
  reconcile(workspaceListId: string, presentSessionIds: Set<string>): string[] {
    const removed: string[] = []
    for (const it of this.staleWorking()) {
      if (it.workspaceListId !== workspaceListId) continue
      if (it.sessionId && presentSessionIds.has(it.sessionId)) continue
      this.drop(it.id)
      removed.push(it.id)
    }
    return removed
  }

  hasActive(): boolean {
    return [...this.sessions.values()].some((s) => s.visible)
  }

  summary(): Summary {
    const sum: Summary = { blocked: 0, working: 0, unreadDone: 0, unreadFailed: 0, total: 0 }
    for (const s of this.sessions.values()) {
      if (!s.visible) continue
      sum.total++
      if (s.state === 'needs_you') sum.blocked++
      else if (s.state === 'working') sum.working++
      else if (s.state === 'failed' && s.unread) sum.unreadFailed++
      else if ((s.state === 'done' || s.state === 'interrupted') && s.unread) sum.unreadDone++
    }
    return sum
  }

  private lastSummary = ''
  private emitSummary(): void {
    const sum = this.summary()
    const k = JSON.stringify(sum)
    if (k === this.lastSummary) return
    this.lastSummary = k
    this.out.summary(sum)
  }

  dispose(): void {
    if (this.snoozeTimer !== undefined) this.t.clear(this.snoozeTimer)
    for (const s of this.sessions.values()) {
      this.cancelPending(s)
      this.cancelRealert(s)
    }
    if (this.aggTimer !== undefined) this.t.clear(this.aggTimer)
  }

  private view(s: Session): Item {
    const { seenWorking: _a, lastKey: _b, lastStateStartedAt: _c, pending: _d, realertTimer: _e, visible: _g, ...item } = s
    return { ...item }
  }
}
