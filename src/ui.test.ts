// One item per peek, jump targets, detail view, and answering only with the extra grant.
import { afterEach, assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as main from './worker'

// Workers in tests never compile the helper.
main.testDeps.helperBinary = ''
import { PeekQueue } from './peek'
import { jump, jumpTarget, type JumpHost } from './jump'
import { buildGroups } from './directory'
import { parsePrompt } from './tui'
import { IslandBridge, type HelperMsg } from './bridge'
import type { Item } from './state'

const fxDir = resolve(import.meta.dirname, 'fixtures')
const screen = (n: string) => readFileSync(resolve(fxDir, `tui/${n}.txt`), 'utf8').split('\n')
const FX = () => JSON.parse(readFileSync(resolve(fxDir, 'orca-cli.json'), 'utf8'))
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const CHAT = 'structured-agent-session-aaaaaaaa-0000-4000-8000-000000000001:tab-1'
const item = (o: Partial<Item> = {}): Item => ({ id: 'i', paneKey: 'tab:p', sessionId: 's1', terminalId: null, workspaceListId: 'identity:ws', title: 'x', state: 'needs_you', priority: 0, startedAt: 0, stateSince: 0, unread: true, lastEventAt: 0, realerts: 0, ...o })

describe('peek queue', () => {
  const mk = (valid = (_: string) => true) => {
    let t = 0
    let q: { at: number; fn: () => void; id: number }[] = []
    let n = 0
    const shown: string[] = []
    const pq = new PeekQueue({ set: (fn, ms) => (q.push({ at: t + ms, fn, id: ++n }), n), clear: (h) => void (q = q.filter((x) => x.id !== h)) }, { show: (p) => shown.push(p.text ? p.text : p.more ? `+${p.more}` : (p.id ?? `sound:${p.sound}`)) }, valid)
    const go = (ms: number) => {
      const end = t + ms
      for (;;) {
        q.sort((a, b) => a.at - b.at)
        if (!q[0] || q[0].at > end) break
        const x = q.shift()!
        t = x.at
        x.fn()
      }
      t = end
    }
    return { pq, shown, go }
  }
  const p0 = (id: string) => id.startsWith('q')
  test('one at a time, at most three, then one "+N"', () => {
    const h = mk()
    h.pq.add(['a', 'b', 'c', 'd', 'e'], 4000, p0)
    assert.deepEqual(h.shown, ['a'])
    h.go(4350)
    assert.deepEqual(h.shown, ['a', 'b'])
    h.go(60_000)
    assert.deepEqual(h.shown, ['a', 'b', 'c', '+2'])
    h.pq.add(['f'], 4000, p0)
    assert.equal(h.shown.at(-1), 'f', 'a new burst starts over')
  })
  test('a prompt jumps the queue; repeats are merged; answered ones are skipped', () => {
    const gone = new Set<string>()
    const h = mk((id) => !gone.has(id))
    h.pq.add(['a', 'b'], 4000, p0)
    h.pq.add(['q1', 'b'], 7000, p0)
    gone.add('b')
    h.go(60_000)
    assert.deepEqual(h.shown, ['a', 'q1'])
  })
  const sum = (ids: string[]) => (ids.length ? { text: `away:${ids.join(',')}`, ttlMs: 6000 } : undefined)
  test('locked: nothing is shown; unlock shows one summary of what still stands', () => {
    const gone = new Set<string>()
    const h = mk((id) => !gone.has(id))
    h.pq.setLocked(true, sum)
    h.pq.add(['a'], 4000, p0, 'Glass')
    h.pq.add(['q1'], 7000, p0, 'Ping')
    h.pq.add(['q1', 'b'], 7000, p0)
    h.go(3600_000)
    assert.deepEqual(h.shown, [], 'no peek, no sound')
    gone.add('b')
    h.pq.setLocked(false, sum)
    h.pq.setLocked(false, sum)
    assert.deepEqual(h.shown, ['away:a,q1'])
    h.pq.add(['c'], 4000, p0)
    assert.deepEqual(h.shown, ['away:a,q1'], 'the next one waits for the summary')
    h.go(6350)
    assert.deepEqual(h.shown, ['away:a,q1', 'c'])
    h.go(60_000)
    h.pq.setLocked(true, sum)
    h.pq.setLocked(false, sum)
    assert.equal(h.shown.length, 2, 'nothing new while away: no summary')
  })
  test('locking mid-peek: the peek on screen and the waiting ones move to the summary', () => {
    const h = mk()
    h.pq.add(['a', 'b'], 4000, p0)
    h.go(1000)
    h.pq.setLocked(true, sum)
    h.go(60_000)
    assert.deepEqual(h.shown, ['a'])
    h.pq.setLocked(false, sum)
    assert.deepEqual(h.shown, ['a', 'away:b,a'])
  })
  test('the helper held one before the worker knew about the lock', () => {
    const h = mk()
    h.pq.add(['a'], 4000, p0)
    h.pq.held('a')
    h.go(60_000)
    h.pq.setLocked(false, sum)
    assert.deepEqual(h.shown, ['a', 'away:a'])
  })
  test('locked again just as the summary was sent: it comes on the next unlock', () => {
    const h = mk()
    h.pq.setLocked(true, sum)
    h.pq.add(['a'], 4000, p0)
    h.pq.setLocked(false, sum)
    h.pq.held('')
    h.go(60_000)
    h.pq.setLocked(false, sum)
    assert.deepEqual(h.shown, ['away:a', 'away:a'])
  })
  test('summary wording: only what changed, as sentences, with names', () => {
    const T = 10_000_000
    let n = 0
    const at = (state: Item['state'], since: number, name?: string) => item({ id: `i${++n}`, state, stateSince: since, name: name ?? `任务 ${n}` })
    const off = T - 25 * 60_000
    const rows = [
      at('needs_you', T - 10 * 60_000, 'Deploy to staging?'), at('needs_you', T - 5 * 60_000, '#12 Release v2.3'),
      at('failed', T - 3 * 60_000, 'Nightly checks'),
      at('done', T - 20 * 60_000), at('done', T - 2 * 60_000), at('interrupted', T - 60_000),
      ...[1, 2, 3, 4, 5].map((k) => at('needs_you', off - k * 3600_000)), // already waiting before
      at('working', T - 60_000), at('done', off - 60_000) // not news
    ]
    const s = main.changesSummary(rows, off, T, 'off')!
    assert.equal(s.title, '关闭的 25 分钟里')
    assert.deepEqual(s.lines, ['2 个问题在等你回答：「Deploy to staging?」「#12 Release v2.3」', '1 个任务失败：Nightly checks', '3 个任务完成', '另有 5 个问题之前就在等你'])
    assert.equal(s.badge, '6 条新消息')
    assert.equal(s.ids.length, 6)
    const away = main.changesSummary(rows, T - 70 * 60_000, T, 'away')!
    assert.equal(away.title, '你离开的 1 小时 10 分钟里')
    // Only names for the first two questions, then 等 N 个.
    const many = [1, 2, 3, 4].map((k) => at('needs_you', T - k * 60_000, `问题 ${k}`))
    assert.equal(main.changesSummary(many, off, T, 'away')!.lines[0], '4 个问题在等你回答：「问题 4」「问题 3」 等 4 个')
    // Under a minute, or nothing new: no summary (old waiting rows are not news).
    assert.equal(main.changesSummary(rows, T - 3000, T, 'off'), undefined)
    assert.equal(main.changesSummary(rows.slice(6), off, T, 'off'), undefined)
    assert.equal(main.spanText(3600_000), '1 小时')
  })
  test('skipped items are reported with a reason', () => {
    const why: string[] = []
    let t = 0
    let q: { at: number; fn: () => void }[] = []
    const pq = new PeekQueue({ set: (fn, ms) => (q.push({ at: t + ms, fn }), q.length), clear: () => {} }, { show: () => {}, skipped: (ids, r) => why.push(`${ids.join(',')}:${r}`) }, () => true)
    pq.setListOpen(true)
    pq.add(['a'], 4000, () => false)
    pq.setListOpen(false)
    pq.setLocked(true)
    pq.add(['b'], 4000, () => false)
    assert.deepEqual(why, ['a:list open', 'b:locked: held for the summary'])
  })
  test('no peek while the list is open, but the sound still plays', () => {
    const h = mk()
    h.pq.setListOpen(true)
    h.pq.add(['q1'], 7000, p0, 'Ping')
    assert.deepEqual(h.shown, ['sound:Ping'])
    h.pq.setListOpen(false)
    h.go(60_000)
    assert.deepEqual(h.shown, ['sound:Ping'])
  })
})

describe('jump targets', () => {
  const host = (o: Partial<JumpHost> = {}) => {
    const calls: string[] = []
    const h: JumpHost = {
      focus: async (t) => (calls.push(`focus ${t}`), { focused: true }),
      agents: async (w) => (calls.push(`agents ${w}`), []),
      terminals: async (w) => (calls.push(`terminals ${w}`), []),
      openWorkspace: async (w) => void calls.push(`open ${w}`),
      openUrl: (u) => void calls.push(`url ${u}`),
      setTerminal: (t) => void calls.push(`set ${t}`),
      ...o
    }
    return { h, calls }
  }
  const dead = (calls: string[]) => async (t: string) => {
    calls.push(`focus ${t}`)
    if (t === 'old') throw new Error('terminal_exited')
    return { focused: true }
  }
  test('terminal: the exact pane', async () => {
    const { h, calls } = host()
    const r = await jump(item({ terminalId: 't1' }), h)
    assert.deepEqual([r.target, r.exact, calls], ['terminal', true, ['focus t1']])
    assert.equal(jumpTarget(item({ terminalId: 't1' })).label, '跳转到会话')
  })
  test('missing or stale terminalId: found through agents.list by session, and remembered', async () => {
    for (const terminalId of [null, 'old']) {
      const x = host()
      x.h.focus = dead(x.calls)
      x.h.agents = async () => [{ terminalId: 'other', sessionId: 's2' }, { terminalId: 't9', sessionId: 's1' }]
      const r = await jump(item({ terminalId }), x.h)
      assert.deepEqual([r.target, r.exact, r.terminalId], ['terminal', true, 't9'])
      assert.ok(x.calls.includes('set t9'))
    }
  })
  test('then the only terminal; several are never guessed; then the workspace', async () => {
    const one = host({ terminals: async () => [{ id: 't5' }] })
    assert.equal((await jump(item(), one.h)).terminalId, 't5')
    const two = host({ terminals: async () => [{ id: 't5' }, { id: 't6' }] })
    two.h.focus = dead(two.calls)
    const r = await jump(item({ terminalId: 'old' }), two.h)
    assert.deepEqual([r.target, two.calls], ['workspace', ['focus old', 'agents identity:ws', 'set null', 'open identity:ws']])
  })
  test('worker chat opens its workspace; bot chat and bot item open the bot; labels say so', async () => {
    const worker = item({ paneKey: CHAT, workspace: 'feature', workspaceListId: 'identity:w2' })
    const w = host()
    await jump(worker, w.h)
    assert.deepEqual([w.calls, jumpTarget(worker).label], [['open identity:w2'], '打开 feature'])
    for (const [i, label] of [[item({ paneKey: CHAT, botChat: true, bot: 'alpha', openUrl: 'orca://bot/1' }), '打开 alpha'], [item({ kind: 'bot_item', openUrl: 'orca://bot/1' }), '去 Orca 回答']] as const) {
      const b = host()
      await jump(i, b.h)
      assert.deepEqual([b.calls, jumpTarget(i).label], [['url orca://bot/1'], label])
    }
  })
  test('chat rows and bot items name the tab to switch to (Orca cannot open a chat tab)', async () => {
    const chat = item({ paneKey: CHAT, botChat: true, bot: 'alpha', openUrl: 'orca://bot/1', tab: 'Nightly run 3' })
    assert.deepEqual([jumpTarget(chat).label, jumpTarget(chat).tab], ['打开 alpha', 'Nightly run 3'])
    const x = host()
    assert.equal((await jump(chat, x.h)).tab, 'Nightly run 3')
    const worker = item({ paneKey: CHAT, workspace: 'feature', workspaceListId: 'identity:w2', tab: 'Fix login' })
    assert.equal((await jump(worker, host().h)).tab, 'Fix login')
    const bi = item({ kind: 'bot_item', openUrl: 'orca://bot/1', tab: 'Home：daily' })
    assert.equal((await jump(bi, host().h)).tab, 'Home：daily')
    const term = item({ terminalId: 't1', tab: 'ignored' })
    const r = await jump(term, host().h)
    assert.deepEqual([r.exact, r.tab], [true, undefined], 'terminal jumps are exact: no hint')
  })
  test('plugin, automation and gate rows only bring Orca forward', async () => {
    for (const kind of ['plugin', 'automation', 'gate'] as const) {
      const x = host()
      assert.equal((await jump(item({ kind }), x.h)).target, 'orca')
      assert.deepEqual(x.calls, [])
    }
  })
})

test('newest prompt first inside a group; other rows oldest first', () => {
  const g = buildGroups([item({ id: 'old', stateSince: 1, bot: 'a' }), item({ id: 'new', stateSince: 9, bot: 'a' }), item({ id: 'd1', state: 'done', stateSince: 2, bot: 'a' }), item({ id: 'd2', state: 'done', stateSince: 3, bot: 'a' })], 'bot')
  assert.deepEqual(g[0].sections[0].ids, ['new', 'old', 'd1', 'd2'])
})

describe('detail view and answering', () => {
  const mounted: { deactivate(): Promise<void> }[] = []
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.deactivate()
  })
  const base = ['agent:read', 'workspace:read', 'workspace:write', 'notifications:show', 'storage:own', 'settings:own']
  const up = async (o: { grant?: boolean; allowAnswer?: boolean; lines?: string[]; cli?: boolean; items?: string } = {}) => {
    const fx = FX()
    main.testDeps.open = () => {}
    main.testDeps.run = async (a) => {
      const c = a.join(' ')
      if (!o.cli) throw new Error('down')
      if (c === 'bot list') return fx.bots
      if (c.startsWith('bot item list')) return a[4] === 'alpha' || c.includes('alpha') ? fx[o.items ?? 'items'] : { items: [] }
      if (c.startsWith('bot chats')) return { chats: [] }
      if (c === 'worktree ps') return fx.ps
      return { plugins: [], runs: [] }
    }
    const host = mockHost({
      capabilities: o.grant ? [...base, 'terminal:read', 'terminal:send'] : base,
      settings: { helper: 'off', ...(o.allowAnswer === undefined ? {} : { allowAnswer: o.allowAnswer }) },
      results: { 'workspace.list': { workspaces: [], truncated: false }, 'agents.list': { agents: [] }, 'terminal.focus': { focused: true }, 'notifications.show': { delivered: true }, 'terminal.read': { lines: o.lines ?? screen('bash'), truncated: false }, 'terminal.sendText': { accepted: true }, 'workspace.readContext': { workspaceId: 'identity:ws', branch: 'main', displayName: 'ws', terminals: [{ id: 't9' }] } }
    })
    const worker = await mountWorker(main, { host })
    mounted.push(worker)
    await tick(60)
    const req = (n: string, i?: unknown) => worker.request(n as never, i as never) as Promise<any>
    const prompt = async () => {
      const at = Date.now()
      const e = (state: 'working' | 'waiting') => ({ workspaceId: null, workspaceListId: 'identity:ws', paneKey: 'tab-9:p', terminalId: 't9', title: '登录页', state, receivedAt: at, sessionId: 's9', mainAgent: { state, stateStartedAt: state === 'working' ? at - 60_000 : at } })
      await worker.emit('agent.status.changed', e('working'))
      await worker.emit('agent.status.changed', e('waiting'))
      await tick(1700)
    }
    return { host, worker, req, prompt }
  }
  test('bot item: full question and options, read-only, 去 Orca 回答', async () => {
    const w = await up({ cli: true, grant: true, allowAnswer: true })
    await tick(100)
    const d = await w.req('island.open', { id: 'x:item:item-1' })
    assert.equal(d.answerable, false)
    assert.equal(d.primary, '去 Orca 回答')
    assert.equal(d.question, '推荐方案 B。')
    assert.deepEqual(d.asks.map((x: { question: string }) => x.question), ['兼容期多久？'])
    assert.deepEqual(d.asks[0].options.map((o: { label: string }) => o.label), ['4 周', '8 周'])
    assert.deepEqual(d.options, [])
    assert.equal(w.host.callsOf('terminal.sendText').length, 0)
  })
  test('without the grant: terminals are neither read nor typed into', async () => {
    const w = await up()
    await w.prompt()
    const d = await w.req('island.open', { id: 's:s9' })
    assert.deepEqual([d.answerable, d.primary], [false, '跳转到会话'])
    const r = await w.req('island.answer', { id: 's:s9', option: 1, signature: parsePrompt(screen('bash'))!.signature })
    assert.equal(r.ok, false)
    assert.equal(w.host.callsOf('terminal.read').length + w.host.callsOf('terminal.sendText').length, 0)
    assert.deepEqual(w.worker.refusals, [])
  })
  test('with the grant: options are shown; a click sends that key to that terminal only', async () => {
    const w = await up({ grant: true, allowAnswer: true })
    await w.prompt()
    const d = await w.req('island.open', { id: 's:s9' })
    assert.equal(d.answerable, true)
    assert.equal(d.textOption, 4)
    const r = await w.req('island.answer', { id: 's:s9', option: 1, signature: d.signature })
    assert.equal(r.ok, true)
    assert.deepEqual(w.host.callsOf('terminal.sendText'), [{ terminalId: 't9', text: '1', enter: false }])
  })
  test('prompt changed: nothing is sent, 已在别处处理', async () => {
    const w = await up({ grant: true, allowAnswer: true })
    await w.prompt()
    const d = await w.req('island.open', { id: 's:s9' })
    w.host.respond('terminal.read', { lines: screen('write'), truncated: false })
    const r = await w.req('island.answer', { id: 's:s9', option: 1, signature: d.signature })
    assert.deepEqual([r.ok, r.text], [false, '已在别处处理'])
    assert.equal(w.host.callsOf('terminal.sendText').length, 0)
  })
  test('granted but the setting is off (the default): terminals are neither read nor typed into', async () => {
    const w = await up({ grant: true })
    await w.prompt()
    assert.equal((await w.req('island.open', { id: 's:s9' })).answerable, false)
    assert.equal((await w.req('island.answer', { id: 's:s9', option: 1, signature: parsePrompt(screen('bash'))!.signature })).ok, false)
    assert.equal(w.host.callsOf('terminal.read').length + w.host.callsOf('terminal.sendText').length, 0)
  })
  test('neither the typed text nor what the terminal shows is stored or logged', async () => {
    const w = await up({ grant: true, allowAnswer: true })
    await w.prompt()
    await w.req('island.record', { on: true })
    const d = await w.req('island.open', { id: 's:s9' })
    await w.req('island.answer', { id: 's:s9', option: d.textOption, text: 'topsecret', signature: d.signature })
    await tick(600)
    const kept = JSON.stringify(w.host.data().storage) + w.worker.logs.join() + JSON.stringify(await w.req('island.helper.status'))
    assert.ok(!kept.includes('topsecret'))
    assert.ok(!kept.includes('/tmp/demo/one.txt'))
  })
  test('read-only setting, and a prompt we cannot parse: nothing to answer', async () => {
    const ro = await up({ grant: true, allowAnswer: false })
    await ro.prompt()
    assert.equal((await ro.req('island.open', { id: 's:s9' })).answerable, false)
    for (const m of mounted.splice(0)) await m.deactivate() // one worker at a time, as in Orca
    const odd = await up({ grant: true, allowAnswer: true, lines: ['? Allow this (y/n)'] })
    await odd.prompt()
    const d = await odd.req('island.open', { id: 's:s9' })
    assert.deepEqual([d.answerable, d.primary], [false, '跳转到会话'])
  })
  test('island switch: on only with the confirm and the grant; off any time', async () => {
    const w = await up({ grant: true })
    const send = (m: Record<string, unknown>) => w.worker.request('island.helperMsg' as never, m as never)
    await send({ type: 'setting', key: 'allowAnswer', value: true })
    assert.notEqual(w.host.data().settings.allowAnswer, true, 'no confirm, no change')
    await send({ type: 'setting', key: 'record', value: true, confirmed: true })
    assert.notEqual(w.host.data().settings.record, true, 'no other setting is writable from the island')
    await send({ type: 'setting', key: 'allowAnswer', value: true, confirmed: true })
    assert.equal(w.host.data().settings.allowAnswer, true)
    await send({ type: 'setting', key: 'allowAnswer', value: false })
    assert.equal(w.host.data().settings.allowAnswer, false)
  })
  test('bot item with several questions: one block each; picking an option opens the bot and names the option', async () => {
    const w = await up({ cli: true, items: 'itemsMulti' })
    for (let i = 0; i < 50 && !(await w.req('island.items')).items.some((x: { id: string }) => x.id === 'x:item:item-multi'); i++) await tick(40)
    const opened: string[] = []
    main.testDeps.open = (u) => opened.push(u)
    const d = await w.req('island.open', { id: 'x:item:item-multi' })
    assert.equal(d.asks.length, 2)
    assert.deepEqual(d.asks[1].options.map((o: { label: string }) => o.label), ['能打，焦点也还回去了', '能打，但焦点没还回去', '打不了字'])
    assert.equal(d.primary, '去 Orca 回答')
    await w.req('island.helperMsg', { type: 'clicked', action: 'pick', id: 'x:item:item-multi', label: '打不了字' })
    assert.deepEqual(opened, ['orca://bot/11111111-0000-4000-8000-000000000001'])
  })
  test('detail explains a missing input: Orca-only, or the switch is off', async () => {
    const bot = await up({ cli: true, grant: true })
    await tick(100)
    assert.equal((await bot.req('island.open', { id: 'x:item:item-1' })).inputKind, 'orca')
    for (const m of mounted.splice(0)) await m.deactivate()
    const off = await up({ grant: true })
    await off.prompt()
    const d = await off.req('island.open', { id: 's:s9' })
    assert.deepEqual([d.inputKind, d.answerable, d.options.length], ['off', false, 0])
    assert.equal(off.host.callsOf('terminal.read').length, 0, 'switch off: the terminal is not read')
  })
  test('capture switch: writable from the island, no confirm', async () => {
    const w = await up()
    await w.worker.request('island.helperMsg' as never, { type: 'setting', key: 'hideFromCapture', value: false } as never)
    assert.equal(w.host.data().settings.hideFromCapture, false)
  })
  test('closing a terminal in the focused workspace clears its prompt from the island', async () => {
    const w = await up()
    await w.worker.emit('workspace.changed', { context: { workspaceId: 'identity:ws', branch: 'main', displayName: 'ws', terminals: [{ id: 't9' }, { id: 'tx' }] } })
    await w.prompt()
    assert.equal((await w.req('island.items')).items.length, 1)
    await w.worker.emit('workspace.changed', { context: { workspaceId: 'identity:ws', branch: 'main', displayName: 'ws', terminals: [{ id: 'tx' }] } })
    assert.equal((await w.req('island.items')).items.length, 0)
  })
  test('after a bot-item jump the pill says where to look (主页)', async () => {
    const w = await up({ cli: true })
    const hints: string[] = []
    main.testDeps.hint = (t) => hints.push(t)
    for (let i = 0; i < 50 && !(await w.req('island.items')).items.some((x: { id: string }) => x.id === 'x:item:item-1'); i++) await tick(40)
    assert.equal((await w.req('island.jump', { id: 'x:item:item-1' })).target, 'bot')
    assert.deepEqual(hints, ['已打开 alpha，请在右侧切到「主页」查看待你决定'])
    main.testDeps.hint = undefined
  })
  test('opening an item clears its 新 marker and keeps the prompt', async () => {
    const w = await up()
    await w.prompt()
    await w.req('island.open', { id: 's:s9' })
    const it = (await w.req('island.items')).items[0]
    assert.deepEqual([it.state, it.unread], ['needs_you', false])
  })
})

const onExit: (() => void)[] = []
afterEach(() => onExit.splice(0).forEach((f) => f()))
const bin = resolve(import.meta.dirname, '../helper/bin/island-helper')
test('real helper, off-screen: the list opens only on a click, one item per peek, focus only for the answer input', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
  const msgs: HelperMsg[] = []
  const b = new IslandBridge({ pluginDir: resolve(import.meta.dirname, '..'), kind: 'swift', bundleId: 'none', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-ui.lock` }, config: () => ({ hotkey: false }), log: () => {}, onMessage: (m) => msgs.push(m) })
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 300 && !f(); i++) await tick(20)
    assert.ok(f(), JSON.stringify(msgs.at(-1)))
  }
  const state = async (): Promise<any> => {
    const n = msgs.length
    b.send({ type: 'debug_state' })
    await until(() => msgs.slice(n).some((m) => m.type === 'state'))
    return msgs.slice(n).find((m) => m.type === 'state')
  }
  const act = (action: string, data = {}) => b.send({ type: 'debug_act', action, data })
  onExit.push(() => b.stop())
  b.start()
  await until(() => msgs.some((m) => m.type === 'ready'))
  for (const id of ['a', 'b']) b.send({ type: 'upsert', item: { id, title: id, state: 'needs_you', unread: true } })
  b.send({ type: 'peek', id: 'a', ttlMs: 500 })
  let s = await state()
  assert.deepEqual([s.mode, s.peek, s.panels[0].canKey], ['peek', 'a', false])
  b.send({ type: 'upsert', item: { id: 'c', title: 'c', state: 'done', unread: true } })
  await tick(900)
  s = await state()
  assert.equal(s.mode, 'pill', 'back to the pill; events never open the list')
  b.send({ type: 'config', config: { debugLocked: true } })
  b.send({ type: 'peek', id: 'b', ttlMs: 500 })
  b.send({ type: 'upsert', item: { id: 'd', title: 'd', state: 'done', unread: true } })
  s = await state()
  assert.deepEqual([s.mode, s.items], ['pill', 4], 'locked: no peek, but the counts go on')
  assert.ok(msgs.some((m) => m.type === 'held' && m.id === 'b'))
  b.send({ type: 'config', config: { debugLocked: false } })
  const sum = { title: '你离开的 25 分钟里', lines: ['1 个问题在等你回答：「b」', '1 个任务完成'], badge: '2 条新消息', ids: ['b', 'd'] }
  b.send({ type: 'peek', text: '你离开的 25 分钟里\n1 个问题在等你回答：「b」\n1 个任务完成', ttlMs: 20000, ...sum })
  s = await state()
  assert.deepEqual([s.mode, s.awayBadge], ['pill', '2 条新消息'], 'not shown before any input; the pill carries the badge')
  b.send({ type: 'debug_input' })
  await tick(2300)
  s = await state()
  // The summary waits for an unlocked session by design; on a locked Mac only the badge can be checked.
  if (s.locked) assert.deepEqual([s.mode, s.awayBadge], ['pill', '2 条新消息'], 'locked: still waiting')
  else assert.deepEqual([s.mode, s.sumTitle, s.sumLines], ['peek', sum.title, sum.lines], 'shown about 2 s after the first input, as sentences')
  if (s.locked) return
  b.send({ type: 'peek', id: 'a', ttlMs: 500 })
  assert.equal((await state()).peek, '', 'an item peek does not cover the summary')
  b.send({ type: 'debug_away_hover' })
  await tick(2900)
  s = await state()
  assert.deepEqual([s.mode, s.awayBadge], ['pill', ''], 'hovered: seen, gone shortly after, badge cleared')
  act('pill', { screen: 0 })
  b.send({ type: 'peek', id: 'b', ttlMs: 500 })
  s = await state()
  assert.deepEqual([s.mode, s.panels[0].canKey], ['list', false], 'no peek over the open list')
  const lit = async (): Promise<number> => {
    const n = msgs.length
    b.send({ type: 'snap', path: join(tmpdir(), `island-snap-${process.pid}.png`), lit: true })
    await until(() => msgs.slice(n).some((m) => m.type === 'snapped'))
    return msgs.slice(n).find((m) => m.type === 'snapped')!.lit as number
  }
  await tick(900)
  assert.ok((await lit()) > 40, 'the open list is really drawn')
  b.send({ type: 'debug_key', key: 4 })
  assert.equal((await state()).selected, 1)
  b.send({ type: 'debug_key', key: 5 })
  for (let i = 0; i < 100 && (s = await state()).mode !== 'detail'; i++) await tick(10) // text is measured first
  assert.equal(s.mode, 'detail')
  await tick(900)
  assert.ok((await lit()) > 40, 'and so is the detail')
  b.send({ type: 'detail', id: s.detail, title: 't', question: 'q', options: [{ label: 'x' }], answerable: false })
  assert.equal((await state()).panels[0].canKey, false, 'read-only detail takes no focus')
  b.send({ type: 'detail', id: s.detail, title: 't', question: 'q', options: [{ n: 1, label: 'x' }], answerable: true, textOption: 1, signature: 's' })
  assert.equal((await state()).panels[0].canKey, true)
  b.send({ type: 'answered', id: s.detail, ok: false, reason: 'gone', text: '已在别处处理' })
  assert.equal((await state()).status, '已在别处处理')
  b.send({ type: 'debug_activate_other' })
  await tick(150)
  assert.equal((await state()).mode, 'detail', 'another app coming forward does not close it')
  b.send({ type: 'debug_key', key: 2 })
  s = await state()
  assert.deepEqual([s.mode, s.panels[0].canKey], ['list', false], 'Esc goes back and gives focus up')
  b.send({ type: 'debug_key', key: 2 })
  await tick(300)
  await tick(700)
  assert.equal((await state()).mode, 'pill', 'Esc again closes')
  assert.equal(await lit(), 0, 'nothing left below the pill')
  assert.equal((await state()).sharing, 'none')
  b.send({ type: 'config', config: { hideFromCapture: false } })
  assert.equal((await state()).sharing, 'readOnly', 'capture switch applies live')
  assert.ok(!msgs.some((m) => m.type === 'error'))
  b.stop()
})

test('real helper: hidden views draw nothing (no ghost of the list under a peek or the pill)', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
  const msgs: HelperMsg[] = []
  const b = new IslandBridge({ pluginDir: resolve(import.meta.dirname, '..'), kind: 'swift', bundleId: 'none', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-ghost.lock` }, config: () => ({ hotkey: false }), log: () => {}, onMessage: (m) => msgs.push(m) })
  onExit.push(() => b.stop())
  b.start()
  for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'ready'); i++) await tick(20)
  // The brightest pixel in a rect (points, y down), from the helper's own drawing.
  const probe = async (box: number[]): Promise<number> => {
    const n = msgs.length
    b.send({ type: 'snap', path: `/tmp/orca-island-test-${process.pid}-ghost.png`, probe: box })
    for (let i = 0; i < 200 && !msgs.slice(n).some((m) => m.type === 'snapped'); i++) await tick(20)
    return (msgs.slice(n).find((m) => m.type === 'snapped') as { max?: number })?.max ?? -1
  }
  for (const [id, title] of [['a', 'Deploy to staging?'], ['b', 'Run npm test?']]) b.send({ type: 'upsert', item: { id, title, state: 'needs_you', unread: true, detail: 'x', sub: 'claude · web-app / feat/login', group: 'web-app' } })
  b.send({ type: 'groups', mode: 'project', groups: [{ key: 'web-app', name: 'web-app', counts: { needs_you: 2, failed: 0, done: 0, working: 0 }, collapsed: false, sections: [{ ids: ['a', 'b'] }] }] })
  b.send({ type: 'peek', id: 'a', ttlMs: 60000 })
  await tick(1200)
  // Inside the peek, where only the hidden list's header (收起, the 项目 tab) would draw.
  assert.equal(await probe([389, 2, 429, 20]), 0, 'no hidden text right of the peek title')
  assert.equal(await probe([61, 38, 79, 52]), 0, 'no hidden text under the peek icon')
  b.stop()
})

test('real helper: clearing finished rows leaves no empty group header and recounts the rest', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
  const msgs: HelperMsg[] = []
  const b = new IslandBridge({ pluginDir: resolve(import.meta.dirname, '..'), kind: 'swift', bundleId: 'none', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-groups.lock` }, config: () => ({ hotkey: false }), log: () => {}, onMessage: (m) => msgs.push(m) })
  onExit.push(() => b.stop())
  b.start()
  for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'ready'); i++) await tick(20)
  const lines = async (): Promise<string[]> => {
    const n = msgs.length
    b.send({ type: 'debug_state' })
    for (let i = 0; i < 100 && !msgs.slice(n).some((m) => m.type === 'state'); i++) await tick(20)
    return (msgs.slice(n).find((m) => m.type === 'state') as { lines: string[] }).lines
  }
  const g = (key: string, ids: string[], counts: Record<string, number>) => ({ key, name: key, counts: { needs_you: 0, failed: 0, done: 0, working: 0, ...counts }, collapsed: false, sections: [{ ids }] })
  b.send({ type: 'upsert', item: { id: 'q', title: 'q', state: 'needs_you' } })
  b.send({ type: 'upsert', item: { id: 'd1', title: 'd1', state: 'done' } })
  b.send({ type: 'upsert', item: { id: 'd2', title: 'd2', state: 'done' } })
  b.send({ type: 'upsert', item: { id: 'f', title: 'f', state: 'failed' } })
  b.send({ type: 'groups', mode: 'project', groups: [g('web-app', ['q', 'd1'], { needs_you: 1, done: 1 }), g('api-server', ['d2'], { done: 1 }), g('mobile-app', ['f'], { failed: 1 })] })
  b.send({ type: 'debug_act', action: 'pill', data: { screen: 0 } })
  await tick(400)
  assert.deepEqual(await lines(), ['g:web-app|!1✓1', 'r:q', 'r:d1', 'g:api-server|✓1', 'r:d2', 'g:mobile-app|✗1', 'r:f'])
  b.send({ type: 'debug_act', action: 'clear_finished', data: {} })
  await tick(800) // the staggered collapse; the worker's new groups are not sent here on purpose
  assert.deepEqual(await lines(), ['g:web-app|!1', 'r:q'], 'only the needs-you row and its header, with the new count')
  b.stop()
})

test('real helper: ↗ in the open list, then the tab hint: the list closes and the pill shows the whole hint', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
  const msgs: HelperMsg[] = []
  const b = new IslandBridge({ pluginDir: resolve(import.meta.dirname, '..'), kind: 'swift', bundleId: 'none', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-hint.lock` }, config: () => ({ hotkey: false }), log: () => {}, onMessage: (m) => msgs.push(m) })
  onExit.push(() => b.stop())
  b.start()
  for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'ready'); i++) await tick(20)
  const state = async (): Promise<any> => {
    const n = msgs.length
    b.send({ type: 'debug_state' })
    for (let i = 0; i < 100 && !msgs.slice(n).some((m) => m.type === 'state'); i++) await tick(20)
    return msgs.slice(n).find((m) => m.type === 'state')
  }
  b.send({ type: 'upsert', item: { id: 'x:item:1', title: '#12 Release v2.3 with a long title', state: 'needs_you', group: 'atlas', kind: 'bot_item' } })
  b.send({ type: 'debug_act', action: 'pill', data: { screen: 0 } })
  await tick(500)
  const narrow = (await state()).pillW
  b.send({ type: 'debug_act', action: 'jump', data: { id: 'x:item:1' } }) // ↗: activates Orca, closes the list
  await tick(60)
  const hint = '已打开 atlas，请在右侧切到「主页」查看待你决定'
  b.send({ type: 'hint', text: hint }) // what the worker sends right after the jump
  await tick(700)
  const s = await state()
  assert.deepEqual([s.mode, s.hint], ['pill', hint], 'the hint is up on the pill after the list closed')
  assert.ok(s.pillW >= s.hintW + 50, `the pill fits the whole hint (${s.hintW} pt of text in ${s.pillW} pt; ${narrow} before)`)
  b.stop()
})

test('real helper: clicking the summary opens the list at the first new row', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
  const msgs: HelperMsg[] = []
  const b = new IslandBridge({ pluginDir: resolve(import.meta.dirname, '..'), kind: 'swift', bundleId: 'none', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-sum.lock` }, config: () => ({ hotkey: false, debugAwayNow: true }), log: () => {}, onMessage: (m) => msgs.push(m) })
  onExit.push(() => b.stop())
  b.start()
  for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'ready'); i++) await tick(20)
  const state = async (): Promise<any> => {
    const n = msgs.length
    b.send({ type: 'debug_state' })
    for (let i = 0; i < 100 && !msgs.slice(n).some((m) => m.type === 'state'); i++) await tick(20)
    return msgs.slice(n).find((m) => m.type === 'state')
  }
  for (const [id, st] of [['old1', 'needs_you'], ['old2', 'needs_you'], ['new1', 'needs_you'], ['f', 'failed']]) b.send({ type: 'upsert', item: { id, title: id, state: st, group: 'web-app' } })
  b.send({ type: 'groups', mode: 'project', groups: [{ key: 'w', name: 'web-app', counts: { needs_you: 3, failed: 1, done: 0, working: 0 }, collapsed: false, sections: [{ ids: ['old1', 'old2', 'new1', 'f'] }] }] })
  await tick(300)
  b.send({ type: 'peek', text: 'x', title: '关闭的 25 分钟里', lines: ['1 个问题在等你回答：「new1」', '1 个任务失败：f', '另有 2 个问题之前就在等你'], badge: '2 条新消息', ids: ['new1', 'f'], ttlMs: 20000 })
  await tick(700)
  let s = await state()
  assert.deepEqual([s.mode, s.sumTitle], ['peek', '关闭的 25 分钟里'])
  // A click on the summary peek is the "pill" tap on its area: here the same action the view sends.
  b.send({ type: 'debug_act', action: 'open_new', data: { screen: 0 } })
  await tick(600)
  s = await state()
  assert.equal(s.mode, 'list')
  assert.equal(s.lines.filter((l: string) => l.startsWith('r:'))[s.selected], 'r:new1', 'the first new row is selected')
  b.stop()
})

test('real helper: the ⏻ and ⚙ header icons are the same optical size', { skip: process.platform !== 'darwin' || !existsSync(bin) } as never, async () => {
  const msgs: HelperMsg[] = []
  const b = new IslandBridge({ pluginDir: resolve(import.meta.dirname, '..'), kind: 'swift', bundleId: 'none', env: { ISLAND_OFFSCREEN: '1', ISLAND_LOCK_PATH: `/tmp/orca-island-test-${process.pid}-icons.lock` }, config: () => ({ hotkey: false }), log: () => {}, onMessage: (m) => msgs.push(m) })
  onExit.push(() => b.stop())
  b.start()
  for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'ready'); i++) await tick(20)
  b.send({ type: 'upsert', item: { id: 'a', title: 'a', state: 'needs_you' } })
  b.send({ type: 'debug_act', action: 'pill', data: { screen: 0 } })
  await tick(900)
  const ink = async (box: number[]): Promise<number[]> => {
    const n = msgs.length
    b.send({ type: 'snap', path: `/tmp/orca-island-test-${process.pid}-icons.png`, ink: box })
    for (let i = 0; i < 200 && !msgs.slice(n).some((m) => m.type === 'snapped'); i++) await tick(20)
    return (msgs.slice(n).find((m) => m.type === 'snapped') as { ink: number[] }).ink
  }
  // The header's right end: ⚙ is the last 26 pt button inside the 14 pt padding, ⏻ the one before it.
  const n = msgs.length
  b.send({ type: 'debug_state' })
  for (let i = 0; i < 100 && !msgs.slice(n).some((m) => m.type === 'state'); i++) await tick(20)
  const st = msgs.slice(n).find((m) => m.type === 'state') as { panels: { frame: string; w: number }[] }
  const canvas = Number(/\{\{[-\d.]+, [-\d.]+\}, \{([\d.]+),/.exec(st.panels[0].frame)![1])
  const right = (canvas + st.panels[0].w) / 2 - 8 - 14
  const gear = await ink([right - 26, 20, right, 52])
  const power = await ink([right - 54, 20, right - 26, 52])
  assert.ok(gear.length && power.length, `both drawn (${gear} / ${power})`)
  const h = (r: number[]) => r[3] - r[1]
  assert.ok(Math.abs(h(gear) - h(power)) <= 1, `ink heights ${h(power)} vs ${h(gear)} pt`)
  b.stop()
})
