// State machine acceptance tests: deterministic fake clock, no Orca host needed.
import { assert, test, describe } from 'orca/testing'
import { SessionStore, type AgentEvent, type Alert, type Item, type Summary, type Config } from './state'

class FakeClock {
  t = 1_000_000
  private q: { at: number; fn: () => void; id: number }[] = []
  private n = 0
  now = () => this.t
  set = (fn: () => void, ms: number) => {
    const id = ++this.n
    this.q.push({ at: this.t + ms, fn, id })
    return id
  }
  clear = (h: unknown) => {
    this.q = this.q.filter((x) => x.id !== h)
  }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.q[0]
      if (!next || next.at > end) break
      this.q.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
  pending() {
    return this.q.length
  }
}

function setup(config: Partial<Config> = {}) {
  const clock = new FakeClock()
  const alerts: Alert[] = []
  const items = new Map<string, Item>()
  const summaries: Summary[] = []
  const store = new SessionStore(clock, {
    upsert: (i) => items.set(i.id, i),
    remove: (id) => items.delete(id),
    summary: (s) => summaries.push(s),
    alert: (a) => alerts.push(a)
  }, config)
  let n = 0
  /** Emits a frame the way Orca does; `startedAt` defaults to now (a new state). */
  const emit = (pane: string, state: AgentEvent['state'], o: { outcome?: string; startedAt?: number; session?: string; terminalId?: string | null; title?: string } = {}) => {
    const e: AgentEvent = {
      workspaceId: 'p::/ws',
      workspaceListId: 'identity:ws',
      paneKey: pane,
      state,
      receivedAt: clock.t,
      sessionId: o.session ?? `s-${pane}`,
      mainAgent: { state, stateStartedAt: o.startedAt ?? clock.t + n++ * 0, ...(o.outcome ? { outcome: o.outcome as never } : {}) }
    }
    if (o.terminalId !== null) e.terminalId = o.terminalId ?? `term-${pane}`
    if (o.title) e.title = o.title
    store.onAgentEvent(e)
  }
  return { clock, alerts, items, summaries, store, emit }
}

/** A real Claude Code turn as Orca reports it: spurious done, working, (working dup), done. */
function turn(h: ReturnType<typeof setup>, pane: string, workMs: number) {
  h.emit(pane, 'done') // spawn-time spurious done
  h.clock.advance(50)
  h.emit(pane, 'working')
  const started = h.clock.t
  h.clock.advance(workMs / 2)
  h.emit(pane, 'working', { startedAt: started }) // duplicate frame, same stateStartedAt
  h.clock.advance(workMs / 2)
}

describe('real-data mapping', () => {
  test('spurious done at session start is ignored', () => {
    const h = setup()
    h.emit('p1', 'done')
    h.clock.advance(10_000)
    assert.equal(h.items.size, 0)
    assert.equal(h.alerts.length, 0)
  })

  test('done without outcome = success after minWorkSec', () => {
    const h = setup()
    turn(h, 'p1', 30_000)
    h.emit('p1', 'done')
    h.clock.advance(2999)
    assert.equal(h.alerts.length, 0, 'not before the 3s stable window')
    h.clock.advance(10_000)
    assert.equal(h.items.get('s:s-p1')?.state, 'done')
    assert.equal(h.alerts.length, 1)
    assert.equal(h.alerts[0].priority, 2)
    assert.equal(h.alerts[0].sound, 'Glass')
  })

  test('short turn (< minWorkSec) does not alert', () => {
    const h = setup()
    turn(h, 'p1', 5_000)
    h.emit('p1', 'done')
    h.clock.advance(10_000)
    assert.equal(h.alerts.length, 0)
    assert.equal(h.items.size, 0)
  })

  test('Claude permission prompt (waiting) = P0 needs_you after 1.5s', () => {
    const h = setup()
    turn(h, 'p1', 4_000)
    h.emit('p1', 'waiting')
    h.clock.advance(1499)
    assert.equal(h.alerts.length, 0)
    h.clock.advance(1)
    assert.equal(h.alerts.length, 1)
    assert.equal(h.alerts[0].priority, 0)
    assert.equal(h.alerts[0].sound, 'Ping')
    assert.equal(h.items.get('s:s-p1')?.state, 'needs_you')
    assert.equal(h.store.summary().blocked, 1)
  })

  test('cancellation is silent and clears the item', () => {
    const h = setup()
    turn(h, 'p1', 60_000)
    h.emit('p1', 'done', { outcome: 'cancellation' })
    h.clock.advance(60_000)
    assert.equal(h.alerts.length, 0)
    assert.equal(h.items.size, 0)
  })

  test('failure = P1 Basso; interruption = P2 silent', () => {
    const h = setup()
    turn(h, 'p1', 30_000)
    h.emit('p1', 'done', { outcome: 'failure' })
    h.clock.advance(10_000)
    assert.equal(h.alerts[0].priority, 1)
    assert.equal(h.alerts[0].sound, 'Basso')
    turn(h, 'p2', 30_000)
    h.emit('p2', 'done', { outcome: 'interruption' })
    h.clock.advance(10_000)
    assert.equal(h.alerts[1].priority, 2)
    assert.equal(h.alerts[1].sound, undefined)
  })

  test('answering the permission prompt (waiting -> working) clears needs_you, keeps turn start', () => {
    const h = setup()
    turn(h, 'p1', 10_000)
    const started = h.items.get('s:s-p1')!.startedAt
    h.emit('p1', 'waiting')
    h.clock.advance(2_000)
    h.emit('p1', 'working')
    assert.equal(h.items.get('s:s-p1')?.state, 'working')
    assert.equal(h.items.get('s:s-p1')?.startedAt, started)
    assert.equal(h.store.summary().blocked, 0)
  })

  test('terminalId dropped on later frames: same item, terminalId remembered', () => {
    const h = setup()
    turn(h, 'p1', 10_000)
    h.emit('p1', 'waiting', { terminalId: null })
    h.clock.advance(2_000)
    const it = h.items.get('s:s-p1')!
    assert.equal(it.terminalId, 'term-p1')
    assert.equal(h.items.size, 1)
  })

  test('stale replay of an older state is ignored (recorded: done then waiting replay)', () => {
    const h = setup()
    turn(h, 'p1', 10_000)
    const waitingAt = h.clock.t
    h.emit('p1', 'waiting')
    h.clock.advance(2_000)
    h.emit('p1', 'working')
    h.clock.advance(1_000)
    h.emit('p1', 'waiting', { startedAt: waitingAt }) // replayed old frame
    h.clock.advance(5_000)
    assert.equal(h.items.get('s:s-p1')?.state, 'working')
    assert.equal(h.alerts.length, 1)
  })

  test('new session in the same pane replaces the old item', () => {
    const h = setup()
    turn(h, 'p1', 30_000)
    h.emit('p1', 'done')
    h.clock.advance(5_000)
    assert.ok(h.items.has('s:s-p1'))
    h.emit('p1', 'working', { session: 's2' })
    assert.ok(!h.items.has('s:s-p1'))
    assert.ok(h.items.has('s:s2'))
  })
})

describe('acceptance', () => {
  test('10 parallel agents: no miss, no duplicate, one aggregated preview', () => {
    const h = setup()
    const panes = Array.from({ length: 10 }, (_, i) => `pane${i}`)
    for (const p of panes) {
      h.emit(p, 'done') // spurious
      h.emit(p, 'working')
    }
    h.clock.advance(60_000)
    // duplicates of every working frame
    for (const p of panes) h.emit(p, 'working', { startedAt: h.clock.t - 60_000 })
    // all finish within ~1 s of each other
    for (const p of panes) {
      h.emit(p, 'done')
      h.clock.advance(100)
      h.emit(p, 'done', { startedAt: h.clock.t - 100 }) // duplicate frame
    }
    h.clock.advance(30_000)
    const done = [...h.items.values()].filter((i) => i.state === 'done')
    assert.equal(done.length, 10, 'no miss')
    assert.equal(h.alerts.length, 1, 'exactly one preview')
    assert.equal(h.alerts[0].kind, 'batch')
    assert.equal(new Set(h.alerts[0].ids).size, 10, 'no duplicate ids')
    assert.equal(h.alerts[0].counts.done, 10)
    assert.equal(h.store.summary().unreadDone, 10)
  })

  test('mixed burst: P0 goes out at once, later completions aggregate separately', () => {
    const h = setup()
    for (const p of ['a', 'b', 'c']) turn(h, p, 30_000)
    h.emit('a', 'done')
    h.emit('b', 'done')
    h.clock.advance(1_000)
    h.emit('c', 'waiting')
    h.clock.advance(1_500) // c commits (P0) -> flushes immediately
    assert.equal(h.alerts.length, 1)
    assert.equal(h.alerts[0].priority, 0)
    h.clock.advance(10_000)
    assert.equal(h.alerts.length, 2)
    assert.equal(h.alerts[1].kind, 'batch')
    assert.deepEqual(h.alerts[1].counts, { needs_you: 0, failed: 0, done: 2, interrupted: 0 })
  })

  test('waiting <-> working flicker produces no false alert', () => {
    const h = setup()
    turn(h, 'p1', 10_000)
    for (let i = 0; i < 20; i++) {
      h.emit('p1', 'waiting')
      h.clock.advance(400)
      h.emit('p1', 'working')
      h.clock.advance(400)
    }
    h.clock.advance(60_000)
    assert.equal(h.alerts.length, 0)
    assert.equal(h.items.get('s:s-p1')?.state, 'working')
  })

  test('done followed by working within 3s is dropped', () => {
    const h = setup()
    turn(h, 'p1', 30_000)
    h.emit('p1', 'done')
    h.clock.advance(2_000)
    h.emit('p1', 'working')
    h.clock.advance(60_000)
    assert.equal(h.alerts.length, 0)
  })

  test('needs_you never expires, re-alerts once after 3 min', () => {
    const h = setup()
    turn(h, 'p1', 10_000)
    h.emit('p1', 'waiting')
    h.clock.advance(2_000)
    assert.equal(h.alerts.length, 1)
    h.clock.advance(3 * 60_000)
    assert.equal(h.alerts.length, 2)
    assert.equal(h.alerts[1].reason, 'realert')
    assert.equal(h.alerts[1].sound, 'Ping')
    h.clock.advance(2 * 60 * 60_000) // 2 hours
    assert.equal(h.alerts.length, 2, 'only one re-alert by default')
    assert.equal(h.items.get('s:s-p1')?.state, 'needs_you')
    // reconciliation never removes it, even if agents.list forgot the session
    assert.deepEqual(h.store.reconcile('identity:ws', new Set()), [])
    assert.equal(h.items.get('s:s-p1')?.state, 'needs_you')
  })

  test('stale working is reconciled away only when agents.list lost it', () => {
    const h = setup()
    turn(h, 'p1', 10_000)
    turn(h, 'p2', 10_000)
    h.clock.advance(21 * 60_000)
    assert.equal(h.store.staleWorking().length, 2)
    const removed = h.store.reconcile('identity:ws', new Set(['s-p2']))
    assert.deepEqual(removed, ['s:s-p1'])
    assert.ok(h.items.has('s:s-p1') === false)
    assert.ok(h.items.has('s:s-p2'))
  })

  test('markRead removes finished items, keeps needs_you but stops its re-alert', () => {
    const h = setup()
    turn(h, 'a', 30_000)
    turn(h, 'b', 10_000)
    h.emit('a', 'done')
    h.emit('b', 'waiting')
    h.clock.advance(5_000)
    h.store.markRead()
    assert.ok(!h.items.has('s:s-a'))
    assert.equal(h.items.get('s:s-b')?.state, 'needs_you')
    const n = h.alerts.length
    h.clock.advance(10 * 60_000)
    assert.equal(h.alerts.length, n, 'no re-alert after read')
  })

  test('next(): needs_you first (oldest), then failed, then unread done', () => {
    const h = setup()
    for (const p of ['d', 'f', 'n1', 'n2']) turn(h, p, 30_000)
    h.emit('d', 'done')
    h.emit('f', 'done', { outcome: 'failure' })
    h.emit('n1', 'waiting')
    h.clock.advance(100)
    h.emit('n2', 'waiting')
    h.clock.advance(5_000)
    assert.equal(h.store.next()?.id, 's:s-n1')
    h.store.markRead(['s:s-n1'])
    assert.equal(h.store.next()?.id, 's:s-n2')
    h.store.markRead(['s:s-n2'])
    assert.equal(h.store.next()?.id, 's:s-f')
    h.store.markRead(['s:s-f'])
    assert.equal(h.store.next()?.id, 's:s-d')
    h.store.markRead(['s:s-d'])
    // only read-but-unanswered prompts remain: they are still offered, oldest first
    assert.equal(h.store.next()?.id, 's:s-n1')
  })
})

describe('delivery policy', () => {
  test('non-P0 sound rate limit: at most one per 10 s', () => {
    const h = setup()
    turn(h, 'a', 30_000)
    turn(h, 'b', 30_000)
    h.emit('a', 'done')
    h.clock.advance(6_000)
    h.emit('b', 'done')
    h.clock.advance(6_000)
    assert.equal(h.alerts.length, 2)
    assert.equal(h.alerts[0].sound, 'Glass')
    assert.equal(h.alerts[1].sound, undefined)
  })

  test('P0 sound is never rate limited', () => {
    const h = setup()
    turn(h, 'a', 30_000)
    turn(h, 'b', 30_000)
    h.emit('a', 'done')
    h.clock.advance(4_000)
    h.emit('b', 'waiting')
    h.clock.advance(2_000)
    assert.equal(h.alerts.at(-1)?.sound, 'Ping')
  })

  test('looking at exactly that terminal: silent, no peek', () => {
    const h = setup()
    h.store.presence = { orcaFrontmost: true, focusedWorkspace: 'identity:ws', focusedTerminals: ['term-a'], locked: false, snoozeUntil: 0 }
    turn(h, 'a', 30_000)
    h.emit('a', 'waiting')
    h.clock.advance(2_000)
    assert.equal(h.alerts[0].peek, false)
    assert.equal(h.alerts[0].sound, undefined)
  })

  test('Orca frontmost, same workspace but not certainly that pane: a new prompt still peeks', () => {
    for (const focusedTerminals of [[], ['term-a', 'other'], ['other']]) {
      const h = setup()
      h.store.presence = { orcaFrontmost: true, focusedWorkspace: 'identity:ws', focusedTerminals, locked: false, snoozeUntil: 0 }
      turn(h, 'a', 30_000)
      h.emit('a', 'waiting')
      h.clock.advance(2_000)
      assert.deepEqual(h.alerts[0].peekIds, ['s:s-a'])
      assert.equal(h.alerts[0].sound, 'Ping')
    }
  })

  test('Orca frontmost elsewhere: P0 peeks and sounds; P2 is count-only', () => {
    const h = setup()
    h.store.presence = { orcaFrontmost: true, focusedWorkspace: 'other', locked: false, snoozeUntil: 0 }
    turn(h, 'a', 30_000)
    h.emit('a', 'waiting')
    h.clock.advance(2_000)
    assert.equal(h.alerts[0].peek, true)
    assert.equal(h.alerts[0].sound, 'Ping')
    turn(h, 'b', 30_000)
    h.emit('b', 'done')
    h.clock.advance(10_000)
    assert.equal(h.alerts[1].peek, false)
    assert.equal(h.alerts[1].sound, undefined)
  })

  test('quiet preset: P2 neither peeks nor sounds', () => {
    const h = setup({ preset: 'quiet' })
    turn(h, 'a', 30_000)
    h.emit('a', 'done')
    h.clock.advance(10_000)
    assert.equal(h.alerts[0].peek, false)
    assert.equal(h.alerts[0].sound, undefined)
  })

  test('snooze and lock mute', () => {
    const h = setup()
    h.store.presence = { orcaFrontmost: false, focusedWorkspace: null, locked: true, snoozeUntil: 0 }
    turn(h, 'a', 30_000)
    h.emit('a', 'waiting')
    h.clock.advance(2_000)
    assert.equal(h.alerts[0].sound, undefined)
    assert.equal(h.alerts[0].peek, true)
  })
})

test('seed from agents.list: already-waiting session counts, finished one does not', () => {
  const h = setup()
  h.store.seed({ workspaceId: 'w', workspaceListId: 'identity:ws', paneKey: 'x', terminalId: 't', state: 'waiting', receivedAt: h.clock.t, sessionId: 'sx', mainAgent: { state: 'waiting', stateStartedAt: h.clock.t - 5000 } })
  h.store.seed({ workspaceId: 'w', workspaceListId: 'identity:ws', paneKey: 'y', terminalId: 't2', state: 'done', receivedAt: h.clock.t, sessionId: 'sy', mainAgent: { state: 'done', stateStartedAt: h.clock.t - 5000 } })
  h.clock.advance(2_000)
  assert.equal(h.items.get('s:sx')?.state, 'needs_you')
  assert.ok(!h.items.has('s:sy'))
})

test('restore keeps needs_you and unread done across a worker restart', () => {
  const h = setup()
  turn(h, 'a', 30_000)
  turn(h, 'b', 10_000)
  h.emit('a', 'done')
  h.emit('b', 'waiting')
  h.clock.advance(5_000)
  const snap = JSON.parse(JSON.stringify(h.store.snapshot()))
  const h2 = setup()
  h2.clock.t = h.clock.t
  h2.store.restore(snap)
  assert.equal(h2.items.get('s:s-a')?.state, 'done')
  assert.equal(h2.items.get('s:s-b')?.state, 'needs_you')
  assert.equal(h2.alerts.length, 0, 'restore does not re-announce')
  // later frames of the same sessions continue normally
  h2.emit('b', 'working')
  assert.equal(h2.items.get('s:s-b')?.state, 'working')
  h2.clock.advance(3 * 60_000)
  assert.equal(h2.alerts.length, 0)
})

test('seeded session (synthetic paneKey) is matched by the real event via sessionId', () => {
  const h = setup()
  h.store.seed({ workspaceId: 'w', workspaceListId: 'identity:ws', paneKey: 'term:t1', terminalId: 't1', state: 'working', receivedAt: h.clock.t, sessionId: 's-p1', mainAgent: { state: 'working', stateStartedAt: h.clock.t - 60_000 } })
  h.emit('p1', 'waiting')
  h.clock.advance(2_000)
  assert.equal(h.items.size, 1)
  assert.equal(h.items.get('s:s-p1')?.state, 'needs_you')
})

test('opencode shape (no mainAgent): top-level state + receivedAt drive the machine', () => {
  const h = setup()
  const base = { workspaceId: 'w', workspaceListId: 'identity:ws', paneKey: 'oc', terminalId: 'toc', title: 'OpenCode', sessionId: 'ses_x' }
  const at = (state: AgentEvent['state']) => h.store.onAgentEvent({ ...base, state, receivedAt: h.clock.t })
  at('done') // spurious, recorded at session start
  h.clock.advance(18)
  at('working')
  h.clock.advance(9)
  at('working') // duplicate with a different receivedAt (no stateStartedAt to dedupe on)
  h.clock.advance(150_000)
  at('done')
  h.clock.advance(6_000) // 3s stable + 2.5s aggregation
  assert.equal(h.alerts.length, 1)
  assert.equal(h.items.get('s:ses_x')?.state, 'done')
  // turn length measured from the first working, not the duplicate
  assert.ok(h.items.get('s:ses_x')!.stateSince - h.items.get('s:ses_x')!.startedAt >= 150_000)
})

test('a closed terminal takes its row with it, even a needs-you one', () => {
  const h = setup()
  turn(h, 'a', 10_000)
  h.emit('a', 'waiting')
  h.clock.advance(2_000)
  assert.equal(h.items.get('s:s-a')?.state, 'needs_you')
  assert.deepEqual(h.store.terminalClosed('term-a'), ['s:s-a'])
  assert.equal(h.items.size, 0)
})

describe('dismiss and clear', () => {
  const ext = (id: string, version = 'v1') => ({ id, kind: 'bot_item' as const, version, state: 'needs_you' as const, title: id, since: 1_000_000 })
  test('× on a finished row removes it at once; a new turn on that session brings it back', () => {
    const h = setup()
    turn(h, 'a', 30_000)
    h.emit('a', 'done')
    h.clock.advance(6_000)
    assert.equal(h.store.dismiss('s:s-a')?.kind, 'removed')
    assert.ok(!h.items.has('s:s-a'))
    h.emit('a', 'done', { startedAt: h.clock.t - 6_000 }) // duplicate of the old frame
    assert.ok(!h.items.has('s:s-a'), 'a duplicate frame does not bring it back')
    h.emit('a', 'working')
    assert.equal(h.items.get('s:s-a')?.state, 'working', 'a new event does')
  })
  test('× on failed and interrupted rows removes them; running rows have no ×', () => {
    const h = setup()
    turn(h, 'f', 30_000)
    h.emit('f', 'done', { outcome: 'failure' })
    turn(h, 'r', 30_000)
    h.clock.advance(6_000)
    assert.equal(h.store.dismiss('s:s-f')?.kind, 'removed')
    assert.equal(h.store.dismiss('s:s-r'), undefined)
    assert.equal(h.items.get('s:s-r')?.state, 'working')
  })
  test('× on a terminal prompt hides it for 30 min (no count, no re-alert), then it comes back once', () => {
    const h = setup()
    turn(h, 'p', 10_000)
    h.emit('p', 'waiting')
    h.clock.advance(2_000)
    const n = h.alerts.length
    assert.equal(h.store.dismiss('s:s-p')?.kind, 'snoozed')
    assert.ok(!h.items.has('s:s-p'))
    assert.equal(h.store.summary().blocked, 0, 'off the pill count')
    h.clock.advance(29 * 60_000)
    assert.equal(h.alerts.length, n, 'no re-alert while hidden')
    h.clock.advance(60_000 + 3_000)
    assert.equal(h.items.get('s:s-p')?.state, 'needs_you')
    assert.equal(h.alerts.length, n + 1)
    assert.equal(h.store.summary().blocked, 1)
  })
  test('a snoozed prompt that changes (answered, or a new one) shows the new state at once', () => {
    const h = setup()
    turn(h, 'p', 10_000)
    h.emit('p', 'waiting')
    h.clock.advance(2_000)
    h.store.dismiss('s:s-p')
    h.emit('p', 'working')
    assert.equal(h.items.get('s:s-p')?.state, 'working')
    assert.ok(!h.store.isSnoozed('s:s-p'))
  })
  test('a snoozed bot item stays hidden while the same question is open, and returns when it changes', () => {
    const h = setup()
    h.store.syncExternal('items:a', [ext('x:item:1')])
    h.clock.advance(3_000)
    h.store.dismiss('x:item:1')
    h.store.syncExternal('items:a', [ext('x:item:1')])
    assert.ok(!h.items.has('x:item:1'))
    h.store.syncExternal('items:a', [ext('x:item:1', 'v2')])
    assert.equal(h.items.get('x:item:1')?.state, 'needs_you')
  })
  test('清空已完成 removes done, failed and interrupted rows only', () => {
    const h = setup()
    for (const p of ['d', 'f', 'i', 'w', 'q']) turn(h, p, 30_000)
    h.emit('d', 'done')
    h.emit('f', 'done', { outcome: 'failure' })
    h.emit('i', 'done', { outcome: 'interruption' })
    h.emit('q', 'waiting')
    h.clock.advance(6_000)
    h.store.markRead(['s:s-d']) // read or unread: both go
    turn(h, 'd2', 30_000)
    h.emit('d2', 'done')
    h.clock.advance(6_000)
    assert.equal(h.store.finishedCount(), 3)
    const gone = h.store.clearFinished()
    assert.deepEqual(gone.map((x) => x.id).sort(), ['s:s-d2', 's:s-f', 's:s-i'])
    assert.deepEqual([...h.items.keys()].sort(), ['s:s-q', 's:s-w'])
    assert.equal(h.store.finishedCount(), 0)
  })
  test('撤销 brings back what × or 清空已完成 took', () => {
    const h = setup()
    turn(h, 'a', 30_000)
    turn(h, 'b', 10_000)
    h.emit('a', 'done')
    h.emit('b', 'waiting')
    h.clock.advance(6_000)
    const gone = h.store.clearFinished()
    h.store.undo(gone)
    assert.equal(h.items.get('s:s-a')?.state, 'done')
    const r = h.store.dismiss('s:s-b')!
    h.store.undo([r.item])
    assert.equal(h.items.get('s:s-b')?.state, 'needs_you')
    assert.ok(!h.store.isSnoozed('s:s-b'))
  })
  test('removals and snoozes survive a restart', () => {
    const h = setup()
    turn(h, 'a', 30_000)
    turn(h, 'b', 10_000)
    h.emit('a', 'done')
    h.emit('b', 'waiting')
    h.store.syncExternal('items:a', [ext('x:item:1')])
    h.clock.advance(6_000)
    h.store.dismiss('s:s-a')
    h.store.dismiss('s:s-b')
    h.store.dismiss('x:item:1')
    const snap = JSON.parse(JSON.stringify(h.store.snapshot()))
    const sz = JSON.parse(JSON.stringify(h.store.snoozes()))
    const h2 = setup()
    h2.clock.t = h.clock.t
    h2.store.restore(snap)
    h2.store.restoreSnoozes(sz)
    h2.store.syncExternal('items:a', [ext('x:item:1')])
    assert.deepEqual([...h2.items.keys()], [], 'nothing comes back')
    h2.clock.advance(31 * 60_000)
    assert.ok(h2.items.has('x:item:1'), 'the snoozed bot item returns after 30 min')
  })
})

test('a removed failed run stays gone after a restart; a new failure shows', () => {
  const h = setup()
  const reply = (version: string) => ({ id: 'x:chat:1', kind: 'automation' as const, version, state: 'failed' as const, title: 'Nightly checks', since: 1_000_000 })
  h.store.syncExternal('chats:a', [reply('m1')])
  h.clock.advance(3_000)
  assert.equal(h.store.clearFinished().length, 1)
  h.store.syncExternal('chats:a', [reply('m1')])
  assert.ok(!h.items.has('x:chat:1'), 'the next poll does not bring it back')
  const h2 = setup()
  h2.clock.t = h.clock.t
  h2.store.restore(JSON.parse(JSON.stringify(h.store.snapshot())))
  h2.store.restoreSnoozes(JSON.parse(JSON.stringify(h.store.snoozes())))
  h2.store.syncExternal('chats:a', [reply('m1')])
  assert.ok(!h2.items.has('x:chat:1'), 'nor does a restart')
  h2.store.syncExternal('chats:a', [reply('m2')])
  assert.equal(h2.items.get('x:chat:1')?.state, 'failed')
})
