// mountWorker + mockHost tests for the worker, plus the real helper round trip (macOS only).
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

// Workers in tests never compile the helper.
main.testDeps.helperBinary = ''
import { IslandBridge, type HelperMsg } from './bridge'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

// Unit tests never spawn the real CLI or open URLs.
main.testDeps.run = async () => {
  throw new Error('no cli in tests')
}
main.testDeps.open = () => {}

const pluginDir = resolve(import.meta.dirname ?? '.', '..')
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

const ev = (state: 'working' | 'blocked' | 'waiting' | 'done', extra: Record<string, unknown> = {}) => ({
  workspaceId: 'p::/ws',
  workspaceListId: 'identity:ws1',
  paneKey: 'tab-1:pane-1',
  terminalId: 't1',
  title: 'fix flaky tests',
  state,
  receivedAt: Date.now(),
  sessionId: 's1',
  mainAgent: { state, stateStartedAt: Date.now() },
  ...extra
})

const results = {
  'workspace.list': { workspaces: [{ id: 'identity:ws1', kind: 'worktree', name: 'web-app', path: '/ws', branch: 'feat/x', hostId: 'local' }], truncated: false },
  'agents.list': { agents: [] },
  'terminal.focus': { focused: true },
  'notifications.show': { delivered: true }
}

async function waitFor(fn: () => boolean, ms = 4000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await tick()
  }
}

test('helper off (non-macOS path): needs-you falls back to L3 notifications.show and L1 status bar', async () => {
  const host = mockHost({ settings: { helper: 'off', record: false }, results })
  const worker = await mountWorker(main, { host })
  await tick(50)
  await worker.emit('agent.status.changed', ev('working', { mainAgent: { state: 'working', stateStartedAt: Date.now() - 60_000 } }))
  await worker.emit('agent.status.changed', ev('waiting'))
  await waitFor(() => host.callsOf('notifications.show').length > 0)
  const n = host.callsOf('notifications.show')[0] as { title: string; body: string }
  assert.match(n.title, /需要你：fix flaky tests/)
  assert.match(n.body, /web-app \/ feat\/x/)
  const sb = host.callsOf('statusBar.update').filter((c) => (c as { id: string }).id === 'island-summary').at(-1) as { text: string; tone: string }
  assert.equal(sb.tone, 'warning')
  assert.match(sb.text, /需要你 1/)
  // status bar press jumps to it
  const r = (await worker.command('island.statusClick')) as { jumped: boolean; id: string }
  assert.equal(r.jumped, true)
  assert.deepEqual(host.callsOf('terminal.focus').at(-1), { terminalId: 't1' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('cancellation is silent end to end', async () => {
  const host = mockHost({ settings: { helper: 'off' }, results })
  const worker = await mountWorker(main, { host })
  await tick(50)
  await worker.emit('agent.status.changed', ev('working', { mainAgent: { state: 'working', stateStartedAt: Date.now() - 60_000 } }))
  await worker.emit('agent.status.changed', ev('done', { mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: Date.now() } }))
  await tick(3500)
  assert.equal(host.callsOf('notifications.show').length, 0)
  const items = (await worker.request('island.items' as never)) as { items: unknown[] }
  assert.equal(items.items.length, 0)
  await worker.deactivate()
})

test('items persist in storage and are restored on the next activation', async () => {
  const host = mockHost({ settings: { helper: 'off' }, results })
  const w1 = await mountWorker(main, { host })
  await tick(50)
  await w1.emit('agent.status.changed', ev('working', { mainAgent: { state: 'working', stateStartedAt: Date.now() - 60_000 } }))
  await w1.emit('agent.status.changed', ev('waiting'))
  await tick(2200)
  await w1.deactivate()
  const stored = host.data().storage['island:items'] as { state: string }[]
  assert.equal(stored?.[0]?.state, 'needs_you')
  const w2 = await mountWorker(main, { host })
  await tick(100)
  const items = (await w2.request('island.items' as never)) as { items: { state: string }[] }
  assert.equal(items.items[0]?.state, 'needs_you')
  await w2.deactivate()
})

test('recorder (opt-in) records and dumps', async () => {
  const host = mockHost({ settings: { helper: 'off', record: true }, results })
  const worker = await mountWorker(main, { host })
  await tick(50)
  await worker.command('island.clear')
  await worker.emit('agent.status.changed', ev('working'))
  await worker.emit('workspace.changed', { context: null })
  const out = (await worker.command('island.dump')) as { count: number; events: { event: string }[] }
  assert.deepEqual(out.events.map((e) => e.event), ['agent.status.changed', 'workspace.changed'])
  await worker.deactivate()
})

test('statusText and notificationFor', () => {
  assert.deepEqual(main.statusText({ blocked: 0, working: 0, unreadDone: 0, unreadFailed: 0, total: 0 }).text, 'Island')
  const s = main.statusText({ blocked: 1, working: 3, unreadDone: 2, unreadFailed: 0, total: 6 })
  assert.equal(s.text, '需要你 1 · 完成 2 · 运行中 3')
  assert.equal(s.tone, 'warning')
  const n = main.notificationFor(
    { ids: ['a', 'b', 'c'], kind: 'batch', priority: 2, peek: true, peekIds: [], ttlMs: 4000, reason: 'new', counts: { needs_you: 0, failed: 0, done: 3, interrupted: 0 } },
    ['a', 'b', 'c'].map((id) => ({ id, title: `T${id}`, state: 'done' }) as never)
  )
  assert.equal(n.title, 'Island for Orca: 3 个完成')
})

for (const kind of ['swift', 'jxa'] as const) {
  const bin = kind === 'swift' ? resolve(pluginDir, 'helper/bin/island-helper') : resolve(pluginDir, 'helper/island.jxa.js')
  test(`${kind} helper: spawn, ready, ping/pong, exit on stdin EOF`, { skip: process.platform !== 'darwin' || !existsSync(bin) }, async () => {
    const msgs: HelperMsg[] = []
    let resolveReady!: () => void
    const ready = new Promise<void>((r) => (resolveReady = r))
    const logs: string[] = []
    const b = new IslandBridge({
      pluginDir,
      kind,
      bundleId: 'com.stablyai.orca',
      env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-${kind}.lock` },
      config: () => ({ hotkey: false }),
      readyTimeoutMs: 8000,
      log: (l) => logs.push(l),
      onMessage: (m) => {
        msgs.push(m)
        if (m.type === 'ready') resolveReady()
      }
    })
    b.start()
    const guard = setTimeout(() => resolveReady(), 9000)
    await ready
    clearTimeout(guard)
    assert.ok(b.ready, `no ready; logs: ${logs.join(' | ')}`)
    const pid = b.pid!
    b.send({ type: 'ping', seq: 42 })
    b.send({ type: 'upsert', item: { id: 'x:1', title: 'unit test', state: 'working' } })
    b.send({ type: 'remove', id: 'x:1' })
    await waitFor(() => msgs.some((m) => m.type === 'pong'), 3000)
    assert.ok(msgs.some((m) => m.type === 'pong' && m.seq === 42), 'pong')
    assert.equal((msgs[0] as { impl?: string }).impl, kind)
    b.stop()
    const t1 = Date.now()
    let alive = true
    while (alive && Date.now() - t1 < 3000) {
      try {
        process.kill(pid, 0)
        await tick(50)
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, `helper ${pid} should exit after stdin EOF; logs: ${logs.join(' | ')}`)
  })
}

test('swift helper singleton: a second instance on the same lock exits 3 and the bridge trips (-> L3)', { skip: process.platform !== 'darwin' || !existsSync(resolve(pluginDir, 'helper/bin/island-helper')) }, async () => {
  const lock = `/tmp/orca-island-test-${process.pid}-single.lock`
  const mk = (onStatus: (s: string) => void) =>
    new IslandBridge({ pluginDir, kind: 'swift', bundleId: 'x', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: lock }, config: () => ({ hotkey: false }), log: () => {}, onMessage: () => {}, onStatus })
  let s1 = ''
  let s2 = ''
  const a = mk((s) => (s1 = s))
  a.start()
  await waitFor(() => s1 === 'ready', 5000)
  const b = mk((s) => (s2 = s))
  b.start()
  await waitFor(() => s2 === 'tripped', 8000)
  assert.equal(b.lastError, 'already_running')
  a.stop()
  b.stop()
})

test('× through the worker: a needs-you prompt is snoozed, undo brings it back; the snooze survives a restart', async () => {
  const host = mockHost({ settings: { helper: 'off' }, results })
  const w1 = await mountWorker(main, { host })
  await tick(50)
  await w1.emit('agent.status.changed', ev('working', { mainAgent: { state: 'working', stateStartedAt: Date.now() - 60_000 } }))
  await w1.emit('agent.status.changed', ev('waiting'))
  await tick(2200)
  const ids = async (w: typeof w1) => ((await w.request('island.items' as never)) as { items: { id: string }[] }).items.map((i) => i.id)
  assert.deepEqual(await ids(w1), ['s:s1'])
  await w1.request('island.dismiss' as never, { id: 's:s1' } as never)
  assert.deepEqual(await ids(w1), [])
  await w1.request('island.undo' as never)
  assert.deepEqual(await ids(w1), ['s:s1'], 'undo')
  await w1.request('island.dismiss' as never, { id: 's:s1' } as never)
  await tick(50)
  await w1.deactivate()
  const w2 = await mountWorker(main, { host })
  await tick(150)
  assert.deepEqual(await ids(w2), [], 'still hidden after a restart')
  await w2.deactivate()
})

test('restore retries when the first storage reads are refused right after a reload', async () => {
  const saved = [{ id: 's:s9', paneKey: 'tab-1:pane-1', sessionId: 's9', terminalId: 't1', workspaceListId: 'identity:ws1', title: 'saved', state: 'needs_you', priority: 0, startedAt: 1, stateSince: 2, unread: true, lastEventAt: 3, realerts: 0 }]
  let refused = 2
  // keys() answers, but the next storage.get calls are refused twice, as Orca did on a live load.
  const host = mockHost({
    settings: { helper: 'off' },
    results: {
      ...results,
      'storage.keys': { keys: ['island:items'] },
      'storage.get': (p: { key: string }) => {
        if (refused-- > 0) throw hostError('not_permitted', 'plugin is not enabled with current consent')
        return { value: p.key === 'island:items' ? saved : null }
      }
    }
  })
  const w = await mountWorker(main, { host })
  try {
    await tick(1200)
    const items = (await w.request('island.items' as never)) as { items: { id: string }[] }
    assert.deepEqual(items.items.map((i) => i.id), ['s:s9'], `the saved row is back; logs: ${w.logs.filter((l) => /restore|storage/.test(l)).join(' | ')}`)
    assert.ok(w.logs.some((l) => /^restored 1 rows, 0 snoozes, switch on \(attempt 3\)$/.test(l)), w.logs.join(' | '))
  } finally {
    await w.deactivate()
  }
})
