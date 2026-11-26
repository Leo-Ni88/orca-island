// Orca source, names and grouping, on sanitized copies of real `orca … --json` output.
import { afterEach, assert, mockHost, mountWorker, test, describe } from 'orca/testing'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as main from './worker'

// Workers in tests never compile the helper.
main.testDeps.helperBinary = ''
import { OrcaSource, botItemUrl, parseBotItems, parseFailedRuns, parseGates, parsePlugins, cliRunner, firstLine, type SourceOutput } from './orca-source'
import { Directory, MINE, buildGroups, fallbackName, isGeneric, secondary } from './directory'
import { SessionStore, itemIdOf, type Alert, type ExternalEntry, type Item } from './state'

const FX = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/orca-cli.json'), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, ms = 4000) {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await tick()
  }
}
const CHAT = 'structured-agent-session-aaaaaaaa-0000-4000-8000-000000000001:tab-1'
const WORKER = 'structured-agent-session-aaaaaaaa-0000-4000-8000-000000000003:tab-1'

/** A fake CLI over a mutable copy of the fixture. */
function fakeCli(over: Record<string, unknown> = {}) {
  const fx = { ...clone(FX), ...over }
  const st = { fx, down: false, calls: [] as string[] }
  const run = async (a: string[]): Promise<any> => {
    st.calls.push(a.join(' '))
    if (st.down) throw new Error('boom')
    const c = a.join(' ')
    if (c === 'bot list') return fx.bots
    if (c.startsWith('bot item list')) return a[a.indexOf('--bot') + 1] === 'alpha' ? fx.items : { botId: fx.bots.bots[1].id, botName: 'beta', items: [] }
    if (c.startsWith('bot chats')) return { chats: fx.chats[a[3]] }
    if (c === 'worktree ps') return fx.ps
    if (c === 'plugin list') return fx.plugins
    if (c.startsWith('automations runs')) return fx.runs
    if (c === 'orchestration run-list') return fx.runList
    if (c.startsWith('orchestration gate-list')) return fx.gates
    throw new Error(`unexpected ${c}`)
  }
  return { st, run }
}

function store() {
  let t = 1_000_000
  let q: { at: number; fn: () => void; id: number }[] = []
  let n = 0
  const alerts: Alert[] = []
  const items = new Map<string, Item>()
  const s = new SessionStore(
    { now: () => t, set: (fn, ms) => (q.push({ at: t + ms, fn, id: ++n }), n), clear: (h) => void (q = q.filter((x) => x.id !== h)) },
    { upsert: (i) => items.set(i.id, i), remove: (id) => items.delete(id), summary: () => {}, alert: (a) => alerts.push(a) }
  )
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      q.sort((a, b) => a.at - b.at || a.id - b.id)
      if (!q[0] || q[0].at > end) break
      const x = q.shift()!
      t = x.at
      x.fn()
    }
    t = end
  }
  return { s, alerts, items, advance, now: () => t }
}
const asEntries = (es: ReturnType<typeof parseBotItems>): ExternalEntry[] => es.map((e) => ({ ...e, bot: e.botName }))

describe('parsers', () => {
  test('bot item: question, options, bot link; no question still needs you', () => {
    const [a, b] = parseBotItems(FX.items, 0)
    assert.equal(a.title, '#11 去掉前缀')
    assert.equal(a.detail, '兼容期多久？')
    assert.deepEqual(a.options, ['4 周', '8 周'])
    assert.equal(a.openUrl, 'orca://bot/11111111-0000-4000-8000-000000000001?botItem=item-1')
    assert.equal(b.detail, '需要看一下')
    assert.equal(b.options, undefined)
  })
  test('several questions: each keeps its own options and recommendation, exactly as the CLI lists them', () => {
    const [e] = parseBotItems(FX.itemsMulti, 0)
    assert.deepEqual(e.asks, FX.itemsMulti.items[0].question.decisions.map((d: any) => ({ question: d.question, options: d.replies.map((r: any) => ({ label: r.label, recommended: r.recommended })) })))
    assert.equal(e.asks!.length, 2)
    assert.deepEqual(e.asks![0].options.map((o) => o.label), ['我回来了'])
    assert.deepEqual(e.asks![1].options.filter((o) => o.recommended).map((o) => o.label), ['能打，焦点也还回去了'])
    assert.equal(e.intro, '先确认两件事。')
  })
  test('a bot item knows the chat it lives in', () => assert.equal(parseBotItems(FX.items, 0)[0].tab, 'Home：daily'))
  test('snoozed items are skipped until the snooze ends', () => {
    const r = clone(FX.items)
    r.items[0].snoozedUntil = 5000
    assert.deepEqual(parseBotItems(r, 4000).map((e) => e.id), ['x:item:item-2'])
    assert.equal(parseBotItems(r, 6000).length, 2)
  })
  test('plugins, failed runs (skipped is not failed), gates', () => {
    assert.deepEqual(parsePlugins(FX.plugins, 1).map((e) => e.title), ['插件需要重新授权：Demo'])
    assert.deepEqual(parseFailedRuns(FX.runs).map((e) => e.version), ['run-bad'])
    const [g] = parseGates(FX.gates, '演示', 1)
    assert.equal(g.title, '编排等你决定：合并到哪个分支？')
    assert.deepEqual(g.options, ['main', 'dev'])
  })
  test('firstLine drops markdown and separators', () => assert.equal(firstLine('\n──── From: x ────\n## **结论**：行'), '结论：行'))
})

describe('entries in the state machine', () => {
  test('appears as P0 once; repeated refresh adds nothing; answered clears silently', () => {
    const h = store()
    const es = asEntries(parseBotItems(FX.items, 0))
    h.s.syncExternal('items:a', es)
    h.advance(2500)
    assert.equal(h.alerts.length, 1, 'two items, one preview')
    assert.equal(h.alerts[0].priority, 0)
    assert.equal(h.alerts[0].ids.length, 2)
    for (let i = 0; i < 5; i++) h.s.syncExternal('items:a', clone(es))
    assert.equal(h.alerts.length, 1)
    assert.equal(h.items.size, 2)
    h.s.syncExternal('items:a', [es[1]])
    assert.ok(!h.items.has('x:item:item-1'))
    assert.equal(h.alerts.length, 1)
    assert.equal(h.s.summary().blocked, 1)
  })
  test('one combined re-alert at 3 min, then count only', () => {
    const h = store()
    h.s.syncExternal('items:a', asEntries(parseBotItems(FX.items, 0)))
    h.advance(3 * 60_000 + 1000)
    assert.equal(h.alerts.length, 2)
    assert.equal(h.alerts[1].reason, 'realert')
    assert.equal(h.alerts[1].ids.length, 2)
    h.advance(2 * 3600_000)
    assert.equal(h.alerts.length, 2)
    assert.equal(h.s.summary().blocked, 2)
  })
  test('a new question on the same item announces again', () => {
    const h = store()
    const es = asEntries(parseBotItems(FX.items, 0))
    h.s.syncExternal('items:a', es)
    h.advance(2500)
    h.s.syncExternal('items:a', [{ ...es[0], version: 'e2', detail: '新问题' }, es[1]])
    h.advance(2500)
    assert.equal(h.alerts.length, 2)
    assert.deepEqual(h.alerts[1].ids, ['x:item:item-1'])
  })
  test('worker restart: restored entries are neither re-announced nor re-alerted a second time', () => {
    const h = store()
    const es = asEntries(parseBotItems(FX.items, 0))
    h.s.syncExternal('items:a', es)
    h.advance(4 * 60_000)
    const h2 = store()
    h2.s.restore(clone(h.s.snapshot()))
    h2.s.syncExternal('items:a', es)
    h2.advance(10 * 60_000)
    assert.equal(h2.alerts.length, 0)
    h2.s.syncExternal('items:a', [])
    assert.equal(h2.items.size, 0)
  })
  test('a deleted bot takes its entries with it; other scopes stay', () => {
    const h = store()
    h.s.syncExternal('items:a', asEntries(parseBotItems(FX.items, 0)))
    h.s.syncExternal('plugins', parsePlugins(FX.plugins, 1))
    h.s.keepScopes('items:', [])
    assert.deepEqual([...h.items.keys()], ['x:plugin:acme.demo'])
  })
})

describe('OrcaSource', () => {
  const collect = () => {
    const log: string[] = []
    const syncs: Record<string, number[]> = {}
    const out: SourceOutput = { sync: (s, e) => void (syncs[s] ??= []).push(e.length), scopes() {}, failedRuns() {}, directory() {}, log: (l) => log.push(l) }
    return { log, syncs, out }
  }
  test('CLI failure: nothing is cleared, it logs, backs off, recovers', async () => {
    const { st, run } = fakeCli()
    const c = collect()
    const src = new OrcaSource({ run, out: c.out, pollMs: 40, debounceMs: 5 })
    await src.request('full')
    st.down = true
    await src.request('full')
    assert.ok(src.backingOff)
    assert.ok(c.log.some((l) => l.includes('bot list failed')))
    assert.deepEqual(c.syncs['items:11111111-0000-4000-8000-000000000001'].at(-1), 2, 'no empty sync on failure')
    const calls = st.calls.length
    src.trigger('items')
    await tick(20)
    assert.ok(st.calls.length <= calls + 1, 'triggers ignored while backing off')
    st.down = false
    await until(() => !src.backingOff)
    src.stop()
  })
  test('one failing run of gates keeps the gates shown', async () => {
    const { run } = fakeCli({ runList: { runs: [{ id: 'run_1' }, { id: 'run_2' }] } })
    const c = collect()
    const src = new OrcaSource({ run: (a) => (a.includes('run_2') ? Promise.reject(new Error('x')) : run(a)), out: c.out })
    await src.request('full')
    src.stop()
    assert.equal(c.syncs.gates, undefined)
  })
  test('a burst of change signals is one refresh', async () => {
    const { st, run } = fakeCli()
    const src = new OrcaSource({ run, out: collect().out, debounceMs: 20 })
    await src.request('full')
    st.calls.length = 0
    for (let i = 0; i < 30; i++) src.trigger('items')
    await tick(80)
    src.stop()
    assert.equal(st.calls.length, 2, 'one item list per bot')
  })
  test('the change signal fires on appends, and survives the WAL being deleted and recreated', async () => {
    const d = mkdtempSync(join(tmpdir(), 'island-wal-'))
    const wal = join(d, 'bot-items.sqlite-wal')
    const { st, run } = fakeCli()
    const src = new OrcaSource({ run, out: collect().out, walPath: wal, debounceMs: 20, statMs: 50 })
    src.start()
    await until(() => st.calls.some((c) => c.includes('gate-list')))
    await tick(200)
    const seen = () => st.calls.filter((c) => c.startsWith('bot item list')).length
    let last = seen()
    for (const step of [() => writeFileSync(wal, 'a'), () => appendFileSync(wal, 'bb'), () => appendFileSync(wal, 'ccc'), () => rmSync(wal), () => writeFileSync(wal, 'b'), () => appendFileSync(wal, 'x')]) {
      step()
      await until(() => seen() > last)
      await tick(200)
      last = seen()
    }
    src.stop()
    rmSync(d, { recursive: true })
  })
  test('bots that live on another computer are not read', async () => {
    const remote = { ...clone(FX.bots), bots: [...FX.bots.bots, { id: 'r1', name: 'gamma', agent: 'claude', paused: false, linked: [], server: { name: 'box', on: 'box' } }] }
    const { st, run } = fakeCli({ bots: remote })
    const src = new OrcaSource({ run, out: collect().out })
    await src.request('full')
    src.stop()
    assert.ok(!st.calls.some((c) => c.includes('gamma')))
  })
  test('cliRunner: a missing binary and a non-JSON answer reject', async () => {
    await assert.rejects(cliRunner('/nonexistent/orca', undefined)(['bot', 'list']))
    await assert.rejects(cliRunner('/bin/echo', undefined)(['hi']))
  })
})

describe('names and groups', () => {
  const dir = new Directory()
  dir.update({ worktrees: FX.ps.worktrees, bots: FX.bots.bots, chats: new Map(Object.entries(FX.chats)) as never })
  const mk = (paneKey: string, over: Partial<Item> = {}): Item => {
    const p = dir.place(paneKey, 'Agent')!
    return { id: paneKey, paneKey, sessionId: null, terminalId: null, workspaceListId: null, title: 'Agent', state: 'working', priority: 4, startedAt: 0, stateSince: 0, unread: false, lastEventAt: 0, realerts: 0, ...p, ...over } as Item
  }
  test('readable names', () => {
    assert.equal(dir.place(CHAT)?.name, 'alpha · Home：daily')
    assert.equal(dir.place(WORKER)?.name, 'Release notes')
    assert.equal(dir.place('tab-9:pane-9', '登录页')?.name, '登录页')
    assert.ok(dir.place('tab-9:pane-9', 'Claude Code')!.name!.startsWith('帮我修一下登录页面'))
    assert.ok(dir.place('tab-9:pane-9')!.name!.length <= 30)
    assert.equal(dir.place('tab-8:pane-8', 'codex')?.name, 'main')
    for (const { agent } of dir.agents()) assert.ok(!isGeneric(dir.place(agent.paneKey, 'Agent')?.name), agent.paneKey)
    assert.equal(dir.place('structured-agent-session-aaaaaaaa-0000-4000-8000-000000000009:t'), undefined)
    const d2 = new Directory()
    d2.update({ chats: new Map([['alpha', [{ id: 'aaaaaaaa-0000-4000-8000-000000000009', title: '汇总 run 2' }]]]) })
    assert.equal(d2.place('structured-agent-session-aaaaaaaa-0000-4000-8000-000000000009:t')?.name, 'alpha · 汇总 run 2')
    assert.equal(fallbackName({ title: 'Agent', agent: 'claude' }), 'claude 会话')
  })
  test('worker secondary line names its bot and a short branch', () => {
    assert.equal(secondary(mk(WORKER)), 'claude · feature / me/feature · 由 alpha 派出')
    assert.equal(secondary(mk('tab-9:pane-9')), 'claude · main / main')
  })
  const all = () => [
    mk(CHAT), mk(WORKER), mk('tab-9:pane-9'),
    mk(CHAT, { id: 'x:item:1', kind: 'bot_item', state: 'needs_you', unread: true, bot: 'alpha', project: 'Bots' })
  ]
  test('project tree', () => {
    const g = buildGroups(all(), 'project')
    assert.deepEqual(g.map((x) => x.name), ['Bots', 'demo-repo'])
    assert.deepEqual(g[0].sections, [{ name: 'alpha', ids: ['x:item:1', CHAT] }])
    assert.deepEqual(g[1].sections, [{ name: 'feature', ids: [WORKER] }, { name: 'main', ids: ['tab-9:pane-9'] }])
    assert.deepEqual(g[0].counts, { needs_you: 1, failed: 0, done: 0, working: 1 })
  })
  test('bot tree: chat, its worker and its item under the bot; plain terminal under 我的会话', () => {
    const g = buildGroups(all(), 'bot')
    assert.deepEqual(g.map((x) => [x.name, x.sections[0].ids]), [['alpha', ['x:item:1', CHAT, WORKER]], [MINE, ['tab-9:pane-9']]])
  })
  test('most urgent group first; read-only groups start collapsed, and can be opened', () => {
    const items = [mk(CHAT, { state: 'done', unread: false }), mk('tab-9:pane-9', { state: 'failed', unread: true })]
    const g = buildGroups(items, 'bot')
    assert.deepEqual(g.map((x) => [x.name, x.collapsed]), [[MINE, false], ['alpha', true]])
    assert.equal(buildGroups(items, 'bot', new Map([['bot:alpha', false]]))[1].collapsed, false)
  })
})

describe('worker', () => {
  const mounted: { deactivate(): Promise<void> }[] = []
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.deactivate()
  })
  const results = { 'workspace.list': { workspaces: [], truncated: false }, 'agents.list': { agents: [] }, 'notifications.show': { delivered: true }, 'commands.run': { ran: true } }
  const up = async (cli: ReturnType<typeof fakeCli>, storage = {}) => {
    const opened: string[] = []
    main.testDeps.run = cli.run
    main.testDeps.open = (u) => opened.push(u)
    const host = mockHost({ settings: { helper: 'off' }, results, storage })
    const worker = await mountWorker(main, { host })
    mounted.push(worker)
    const items = async () => ((await worker.request('island.items' as never)) as { items: Item[] }).items
    return { host, worker, items, opened }
  }
  test('needs-you shows, notifies once, opens its bot, clears when answered; failed run announced once', async () => {
    const fx = clone(FX)
    fx.runs.runs[2].createdAt = Date.now()
    const cli = fakeCli({ runs: fx.runs })
    const w = await up(cli)
    await until(async () => (await w.items()).some((i) => i.kind === 'gate'))
    await w.worker.request('island.refresh' as never)
    const its = await w.items()
    assert.equal(its.filter((i) => i.kind === 'bot_item').length, 2)
    assert.equal(its.filter((i) => i.kind === 'automation').length, 1)
    await until(() => w.host.callsOf('notifications.show').length > 0)
    await tick(300)
    const n = w.host.callsOf('notifications.show') as { title: string }[]
    assert.deepEqual(n.map((x) => x.title), ['Island for Orca: 4 个需要你，1 个失败'], 'one refresh, one notification')
    const r = (await w.worker.request('island.next' as never)) as { jumped: boolean }
    assert.ok(r.jumped)
    cli.st.fx.items.items.length = 0
    await w.worker.request('island.refresh' as never)
    assert.equal((await w.items()).filter((i) => i.kind === 'bot_item').length, 0)
    const stored = w.host.data().storage
    assert.deepEqual(stored['island:seenRuns'], ['run-bad'])
    await w.worker.deactivate()
    mounted.length = 0
    const again = await up(cli, { 'island:seenRuns': ['run-bad'] })
    await until(async () => (await again.items()).some((i) => i.kind === 'gate'))
    assert.equal((await again.items()).filter((i) => i.kind === 'automation').length, 0, 'once per run id')
  })
  test('bot chat reply: one row and one alert for events + ps, named, with the first line, however short', async () => {
    const w = await up(fakeCli({ items: { ...FX.items, items: [] }, plugins: { plugins: [] }, runs: { runs: [] }, gates: { gates: [] } }))
    await until(async () => (await w.items()).length > 0)
    const now = Date.now()
    const e = (state: 'working' | 'done', at: number) => ({ workspaceId: null, workspaceListId: 'folder:home-1', paneKey: CHAT, state, receivedAt: at, sessionId: 'provider-session', mainAgent: { state, stateStartedAt: at } })
    await w.worker.emit('agent.status.changed', e('working', now - 2000))
    await w.worker.emit('agent.status.changed', e('done', now))
    await until(() => w.host.callsOf('notifications.show').length > 0, 8000)
    await tick(300)
    const rows = (await w.items()).filter((i) => i.paneKey === CHAT)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, itemIdOf({ paneKey: CHAT }))
    assert.equal(rows[0].name, 'alpha · Home：daily')
    assert.equal(rows[0].openUrl, 'orca://bot/11111111-0000-4000-8000-000000000001', 'a chat row has no item')
    assert.equal(rows[0].tab, 'Home：daily', 'the chat tab to look for')
    const n = w.host.callsOf('notifications.show') as { title: string; body: string }[]
    assert.equal(n.length, 1)
    assert.deepEqual(n[0], { title: 'alpha 回复了', body: '结论：可以合并。' })
  })
  test('CLI down: agent alerts still work', async () => {
    const cli = fakeCli()
    cli.st.down = true
    const w = await up(cli)
    await tick(80)
    const at = Date.now()
    const e = (state: 'working' | 'waiting') => ({ workspaceId: null, paneKey: 'tab-9:pane-9', terminalId: 't', title: '登录页', state, receivedAt: at, sessionId: 's9', mainAgent: { state, stateStartedAt: state === 'working' ? at - 60_000 : at } })
    await w.worker.emit('agent.status.changed', e('working'))
    await w.worker.emit('agent.status.changed', e('waiting'))
    await until(() => w.host.callsOf('notifications.show').length === 1)
    assert.equal((w.host.callsOf('notifications.show')[0] as { title: string }).title, '需要你：登录页')
  })
  test('bot item links: ?botItem=<uid> only for a valid uid (not all digits, plain token)', () => {
    const B = '11111111-0000-4000-8000-000000000001'
    assert.equal(botItemUrl(B, 'item-1'), `orca://bot/${B}?botItem=item-1`)
    assert.equal(botItemUrl(B, 'a1B2_c3-d4'), `orca://bot/${B}?botItem=a1B2_c3-d4`)
    assert.equal(botItemUrl(B, '12345'), `orca://bot/${B}`, 'all digits: refused upstream, so not sent')
    assert.equal(botItemUrl(B, 'x y'), `orca://bot/${B}`)
    assert.equal(botItemUrl(B, 'a&b=c'), `orca://bot/${B}`)
    assert.equal(botItemUrl(B, ''), `orca://bot/${B}`)
    assert.equal(botItemUrl(B, 'x'.repeat(129)), `orca://bot/${B}`)
  })
  test('click on a bot item opens its deep link and nothing else', async () => {
    const w = await up(fakeCli({ plugins: { plugins: [] }, runs: { runs: [] }, gates: { gates: [] } }))
    await until(async () => (await w.items()).some((i) => i.kind === 'bot_item'))
    await w.worker.command('island.statusClick')
    assert.deepEqual(w.opened, ['orca://bot/11111111-0000-4000-8000-000000000001?botItem=item-1'], 'the item uid rides along (stablyai/orca#49398); older Orca ignores it')
    assert.equal(w.host.callsOf('terminal.focus').length, 0)
  })
  test('grouping mode is remembered', async () => {
    const w = await up(fakeCli())
    await w.worker.request('island.setMode' as never, { mode: 'bot' } as never)
    assert.equal(w.host.data().storage['island:groupMode'], 'bot')
  })
})
