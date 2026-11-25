// Item 52: the master switch. Off stops the helper, alerts, notifications and terminal access,
// keeps tracking, and comes back on by itself (timed), from the status bar or from the setting.
import { afterEach, assert, describe, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as main from './worker'
import { parsePrompt } from './tui'

main.testDeps.helperBinary = ''
main.testDeps.run = async () => {
  throw new Error('no cli in tests')
}
main.testDeps.open = () => {}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const screen = (n: string) => readFileSync(resolve(import.meta.dirname, `fixtures/tui/${n}.txt`), 'utf8').split('\n')
/** System notifications other than the one that says how to turn it back on. */
const alerts = (h: { callsOf(m: string): unknown[] }) => h.callsOf('notifications.show').filter((n) => (n as { title: string }).title !== 'Island 已关闭')
const BASE = ['agent:read', 'workspace:read', 'workspace:write', 'notifications:show', 'storage:own', 'settings:own']

describe('pure helpers', () => {
  test('offUntil: an hour, the next 08:00, or never', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m).getTime()
    assert.equal(main.offUntil('hour', at(14)), at(15))
    assert.equal(main.offUntil('morning', at(14)), new Date(2026, 10, 26, 8).getTime(), 'afternoon: tomorrow 08:00')
    assert.equal(main.offUntil('morning', at(2)), at(8), 'small hours: this morning 08:00')
    assert.equal(main.offUntil('morning', at(8)), new Date(2026, 10, 26, 8).getTime(), 'at 08:00 sharp: the next one')
    assert.equal(main.offUntil('forever', at(14)), undefined)
  })
  test('offStatus: grey, Island 已关闭 with the end time', () => {
    const now = new Date(2026, 10, 25, 14).getTime()
    assert.deepEqual(main.offStatus({ on: false, since: now, until: now + 3600_000 }, now), { text: 'Island 已关闭（到 15:00）', tone: 'neutral', tooltip: '点击打开 Island' })
    assert.equal(main.offStatus({ on: false, since: now, until: new Date(2026, 10, 26, 8).getTime() }, now).text, 'Island 已关闭（到明天 08:00）')
    assert.equal(main.offStatus({ on: false, since: now }, now).text, 'Island 已关闭')
  })
})

const mounted: { deactivate(): Promise<void> }[] = []
afterEach(async () => {
  for (const w of mounted.splice(0)) await w.deactivate()
  main.testDeps.now = undefined
  main.testDeps.powerCheckMs = undefined
  main.testDeps.helperEnv = undefined
  main.testDeps.helperBinary = ''
})

type Up = { helper?: 'off' | 'swift'; grant?: boolean; storage?: Record<string, unknown>; settings?: Record<string, unknown>; host?: ReturnType<typeof mockHost> }
async function up(o: Up = {}) {
  const host =
    o.host ??
    mockHost({
      capabilities: o.grant ? [...BASE, 'terminal:read', 'terminal:send'] : BASE,
      settings: { helper: o.helper ?? 'off', allowAnswer: !!o.grant, ...(o.settings ?? {}) } as never,
      storage: (o.storage ?? {}) as never,
      results: {
        'workspace.list': { workspaces: [], truncated: false },
        'agents.list': { agents: [] },
        'terminal.focus': { focused: true },
        'notifications.show': { delivered: true },
        'terminal.read': { lines: screen('bash'), truncated: false },
        'terminal.sendText': { accepted: true },
        'workspace.readContext': { workspaceId: 'identity:ws', branch: 'main', displayName: 'ws', terminals: [{ id: 't9' }] }
      }
    })
  const worker = await mountWorker(main, { host })
  mounted.push(worker)
  await tick(80)
  const req = (n: string, i?: unknown) => worker.request(n as never, i as never) as Promise<any>
  let k = 0
  /** A Claude Code prompt in terminal t9 (or a finished turn), from real-shaped status frames. */
  const turn = async (end: 'waiting' | 'done', sid = `s${++k}`) => {
    const at = Date.now()
    const e = (state: 'working' | 'waiting' | 'done', t: number) => ({ workspaceId: null, workspaceListId: 'identity:ws', paneKey: `tab-9:${sid}`, terminalId: 't9', title: '登录页', state, receivedAt: t, sessionId: sid, mainAgent: { state, stateStartedAt: t } })
    await worker.emit('agent.status.changed', e('working', at - 60_000))
    await worker.emit('agent.status.changed', e(end, at))
    await tick(end === 'waiting' ? 1700 : 3200)
    return `s:${sid}`
  }
  const status = () => host.callsOf('statusBar.update').filter((c) => (c as { id: string }).id === 'island-summary').at(-1) as { text: string; tone: string }
  return { host, worker, req, turn, status }
}

describe('turning it off', () => {
  for (const choice of ['hour', 'morning', 'forever'] as const) {
    test(`关 ${choice}: stored with an absolute end, status bar grey, setting in sync`, async () => {
      const w = await up()
      const t0 = Date.now()
      const p = await w.req('island.power', { on: false, choice })
      assert.equal(p.on, false)
      const stored = w.host.data().storage['island:power'] as { on: boolean; until?: number }
      assert.equal(stored.on, false)
      if (choice === 'forever') assert.equal(stored.until, undefined)
      else assert.ok(Math.abs(stored.until! - main.offUntil(choice, t0)!) < 1000, 'absolute time')
      assert.match(w.status().text, /^Island 已关闭/)
      assert.equal(w.status().tone, 'neutral')
      assert.equal(w.host.data().settings.enabled, false, '启用 Orca Island follows')
    })
  }

  test('off: no system notification, even though the helper is not running', async () => {
    const w = await up()
    await w.req('island.power', { on: false, choice: 'forever' })
    await w.turn('waiting')
    await w.turn('done')
    assert.equal(alerts(w.host).length, 0)
    const items = await w.req('island.items')
    assert.deepEqual(items.items.map((i: { state: string }) => i.state).sort(), ['done', 'needs_you'], 'still tracked')
  })

  test('off: terminals are neither read nor typed into, even with answering on', async () => {
    const w = await up({ grant: true })
    const id = await w.turn('waiting')
    await w.req('island.power', { on: false, choice: 'hour' })
    const d = await w.req('island.open', { id })
    assert.equal(d.answerable, false)
    const r = await w.req('island.answer', { id, option: 1, signature: parsePrompt(screen('bash'))!.signature })
    assert.equal(r.ok, false)
    assert.equal(w.host.callsOf('terminal.read').length + w.host.callsOf('terminal.sendText').length, 0)
  })

  test('off while an answer is under way: nothing is typed', async () => {
    const w = await up({ grant: true })
    const id = await w.turn('waiting')
    const d = await w.req('island.open', { id })
    assert.equal(d.answerable, true)
    const reads = w.host.callsOf('terminal.read').length
    // The answer focuses the terminal and then waits for Orca to report it active: turn it off meanwhile.
    w.host.respond('workspace.readContext', { workspaceId: 'identity:ws', branch: 'main', displayName: 'ws', terminals: [] })
    const pending = w.req('island.answer', { id, option: 1, signature: d.signature })
    await tick(150)
    await w.req('island.power', { on: false, choice: 'forever' })
    w.host.respond('workspace.readContext', { workspaceId: 'identity:ws', branch: 'main', displayName: 'ws', terminals: [{ id: 't9' }] })
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(w.host.callsOf('terminal.sendText').length, 0, 'no key sent')
    assert.equal(w.host.callsOf('terminal.read').length, reads, 'no read after off')
  })

  test('off: the hotkey does not jump', async () => {
    const w = await up()
    await w.turn('waiting')
    await w.req('island.power', { on: false, choice: 'forever' })
    await w.req('island.helperMsg', { type: 'hotkey' })
    assert.equal(w.host.callsOf('terminal.focus').length, 0)
  })
})

describe('coming back on', () => {
  test('timed off ends by itself; the status bar comes back', async () => {
    let now = Date.now()
    main.testDeps.now = () => now
    main.testDeps.powerCheckMs = 30
    const w = await up()
    await w.req('island.power', { on: false, choice: 'hour' })
    now += 59 * 60_000
    await tick(80)
    assert.equal((await w.req('island.items')).power.on, false)
    now += 61_000 // past the end, as after a sleep: the timer never fired, the wall-clock check does it
    await tick(80)
    assert.equal((await w.req('island.items')).power.on, true)
    assert.doesNotMatch(w.status().text, /已关闭/)
    assert.equal(w.host.data().settings.enabled, true)
  })

  test('across a restart: still off before the end, on after it', async () => {
    let now = Date.now()
    main.testDeps.now = () => now
    const w1 = await up()
    await w1.req('island.power', { on: false, choice: 'hour' })
    await w1.worker.deactivate()
    mounted.splice(0)
    const w2 = await up({ host: w1.host })
    assert.equal((await w2.req('island.items')).power.on, false, 'reload within the hour: still off')
    assert.match(w2.status().text, /Island 已关闭（到/)
    await w2.worker.deactivate()
    mounted.splice(0)
    now += 2 * 3600_000
    const w3 = await up({ host: w1.host })
    assert.equal((await w3.req('island.items')).power.on, true, 'restart after the end: on')
    assert.equal(w1.host.data().settings.enabled, true)
  })

  test('the status bar press turns it on; while on, the press keeps jumping', async () => {
    const w = await up()
    const id = await w.turn('waiting')
    await w.req('island.power', { on: false, choice: 'forever' })
    const r = await w.worker.command('island.statusClick')
    assert.deepEqual(r, { turnedOn: true })
    assert.equal(w.host.callsOf('terminal.focus').length, 0, 'the press that turns it on does not also jump')
    const r2 = (await w.worker.command('island.statusClick')) as { jumped: boolean; id: string }
    assert.deepEqual([r2.jumped, r2.id], [true, id])
  })

  test('setting and switch stay in sync both ways', async () => {
    const w = await up()
    // The person flips 启用 Orca Island in Orca's settings (the worker hears it through settings.onDidChange).
    await w.req('island.helperMsg', { type: 'setting_test', key: 'enabled', value: false })
    assert.equal((await w.req('island.items')).power.on, false, 'setting off -> island off')
    assert.match(w.status().text, /^Island 已关闭$/, 'until turned on')
    await w.req('island.helperMsg', { type: 'setting_test', key: 'enabled', value: true })
    assert.equal((await w.req('island.items')).power.on, true, 'setting on -> island on')
    await w.req('island.power', { on: false, choice: 'morning' })
    assert.equal(w.host.data().settings.enabled, false, 'island off -> setting off')
    await w.req('island.power', { on: true })
    assert.equal(w.host.data().settings.enabled, true, 'island on -> setting on')
  })

  test('setting turned off while not running: it starts off', async () => {
    const w = await up({ settings: { enabled: false } })
    assert.equal((await w.req('island.items')).power.on, false)
    assert.match(w.status().text, /^Island 已关闭$/)
  })
})

const bin = resolve(import.meta.dirname, '../helper/bin/island-helper')
describe('with the real helper', () => {
  test('off stops the helper (not a crash, no breaker, no L3); on brings it back with the list and one summary', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
    main.testDeps.helperBinary = bin
    main.testDeps.helperEnv = { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-power.lock` }
    const w = await up({ helper: 'swift' })
    for (let i = 0; i < 200 && !(await w.req('island.items')).helperUp; i++) await tick(20)
    const pid1 = (await w.req('island.helper.status')).pid
    assert.ok(pid1)
    await w.req('island.power', { on: false, choice: 'forever' })
    await tick(300)
    let alive = true
    try {
      process.kill(pid1, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'helper process stopped')
    const st = await w.req('island.helper.status')
    assert.equal(st.tripped, undefined, 'no bridge, so nothing tripped')
    // Things happen while off: tracked, never shown or notified.
    const q = await w.turn('waiting')
    const d = await w.turn('done')
    // 25 minutes later (the wall clock the switch uses): the summary covers a real stretch.
    const later = Date.now() + 25 * 60_000
    main.testDeps.now = () => later
    assert.equal(alerts(w.host).length, 0)
    await w.req('island.power', { on: true })
    for (let i = 0; i < 200 && !(await w.req('island.items')).helperUp; i++) await tick(20)
    await tick(300)
    const s = await w.req('island.helper.status')
    assert.notEqual(s.pid, pid1, 'a new helper')
    const peeks = s.peekLog.filter((p: { id?: string; text?: string }) => p.id || p.text)
    assert.deepEqual(peeks.map((p: { text?: string }) => p.text), ['关闭的 25 分钟里\n1 个问题在等你回答：「登录页」\n1 个任务完成'], 'one summary, no replayed item peeks')
    const sent = s.recent.filter((m: { type: string }) => m.type === 'peeked')
    assert.ok(sent.every((m: { id?: string }) => !m.id), 'the helper showed no item peek')
    const items = (await w.req('island.items')).items.map((i: { id: string }) => i.id).sort()
    assert.deepEqual(items, [d, q].sort(), 'the list is right')
    assert.equal(alerts(w.host).length, 0)
  })
})

describe('status bar pause button (island.power)', () => {
  test('pressed while on: off for 1 hour, the button hides; the summary item then turns it on', async () => {
    const w = await up()
    const t0 = Date.now()
    const p = (await w.worker.command('island.power')) as { on: boolean; until?: number }
    assert.equal(p.on, false)
    assert.ok(p.until! - t0 >= 3600_000 - 1000 && p.until! - t0 <= 3600_000 + 1000)
    const pw = w.host.callsOf('statusBar.update').filter((c) => (c as { id: string }).id === 'island-power').at(-1) as { visible: boolean }
    assert.equal(pw.visible, false, 'no pause button while off')
    assert.match(w.status().text, /^Island 已关闭（到 /)
    await w.worker.command('island.statusClick')
    assert.equal((await w.req('island.items')).power.on, true)
    const pw2 = w.host.callsOf('statusBar.update').filter((c) => (c as { id: string }).id === 'island-power').at(-1) as { visible: boolean }
    assert.equal(pw2.visible, true)
    assert.deepEqual(w.worker.refusals, [])
  })
})

describe('never locked out', () => {
  test('a status bar update refused at startup is retried until it lands', async () => {
    let refused = 3
    const host = mockHost({
      capabilities: BASE,
      settings: { helper: 'off' },
      results: {
        'workspace.list': { workspaces: [], truncated: false },
        'agents.list': { agents: [] },
        'notifications.show': { delivered: true },
        'statusBar.update': () => {
          if (refused-- > 0) throw hostError('not_permitted', 'plugin is not enabled with current consent')
          return { ok: true }
        }
      }
    })
    const w = await up({ host })
    await tick(4000)
    const landed = w.host.calls.filter((c) => c.method === 'statusBar.update').length
    assert.ok(landed > 3, `retried (${landed} calls)`)
    assert.ok(w.worker.logs.some((l) => /^status bar: .*\(after 3 refused\)$/.test(l)), w.worker.logs.join(' | '))
  })

  test('turning off always lands an off-state update, and one notification says how to get back', async () => {
    const w = await up()
    await w.req('island.power', { on: false, choice: 'hour' })
    assert.match(w.status().text, /^Island 已关闭（到 /)
    const n = w.host.callsOf('notifications.show') as { title: string; body: string }[]
    assert.equal(n.length, 1, 'exactly one notification')
    assert.equal(n[0].title, 'Island 已关闭')
    assert.match(n[0].body, /点状态栏的「Island 已关闭」或在插件设置里打开「启用 Orca Island」/)
    await w.req('island.power', { on: false, choice: 'forever' }) // already off: no second one
    assert.equal(w.host.callsOf('notifications.show').length, 1)
  })

  test('while off, the status bar is re-applied on the heartbeat (in case Orca dropped it)', async () => {
    main.testDeps.powerCheckMs = 40
    const w = await up()
    await w.req('island.power', { on: false, choice: 'forever' })
    const before = w.host.callsOf('statusBar.update').length
    await tick(200)
    const after = w.host.callsOf('statusBar.update').filter((c) => (c as { id: string }).id === 'island-summary')
    assert.ok(w.host.callsOf('statusBar.update').length > before + 2, 're-applied')
    assert.match((after.at(-1) as { text: string }).text, /^Island 已关闭$/)
  })

  test('the setting turns it back on after the island was turned off from the list', async () => {
    const w = await up()
    await w.req('island.helperMsg', { type: 'clicked', action: 'power_off', choice: 'forever' })
    assert.equal((await w.req('island.items')).power.on, false)
    await w.req('island.helperMsg', { type: 'setting_test', key: 'enabled', value: true })
    assert.equal((await w.req('island.items')).power.on, true)
    assert.doesNotMatch(w.status().text, /已关闭/)
  })
})

test('rows say what they are: terminal, bot or Orca (for the glyph in the list)', async () => {
  const sent: { item: { id: string; source: string } }[] = []
  main.testDeps.helperBinary = ''
  const w = await up()
  const id = await w.turn('waiting')
  // The helper is off in tests, so read what it would be sent through the bridge's replay of the store.
  const items = (await w.req('island.items')).items as { id: string; terminalId?: string }[]
  assert.equal(items.find((i) => i.id === id)?.terminalId, 't9')
  assert.equal(main.rowSource({ id, kind: 'session', terminalId: 't9' } as never), 'terminal')
  assert.equal(main.rowSource({ id: 'x', kind: 'bot_item' } as never), 'bot')
  assert.equal(main.rowSource({ id: 'c', botChat: true } as never), 'bot')
  assert.equal(main.rowSource({ id: 'a', kind: 'automation' } as never), 'orca')
  void sent
})
