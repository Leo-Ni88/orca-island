import { assert, test, describe } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanFreeText, parsePrompt, redactSecrets } from './tui'
import { Answerer, type TerminalIo } from './answer'

const fx = (n: string): string[] => readFileSync(resolve(import.meta.dirname, `fixtures/tui/${n}.txt`), 'utf8').split('\n')
const sigOf = (n: string): string => parsePrompt(fx(n))!.signature

/** A terminal that moves from screen to screen when it receives the expected key. */
function term(screens: Record<string, Record<string, string>>, start: string) {
  const st = { at: start, sent: [] as string[], focused: 0, focusOk: true, reads: 0, onRead: undefined as undefined | ((n: number) => void) }
  const io: TerminalIo = {
    read: async () => {
      st.onRead?.(++st.reads)
      return fx(st.at)
    },
    send: async (t, enter) => {
      st.sent.push(t + (enter ? '⏎' : ''))
      st.at = screens[st.at]?.[t] ?? screens[st.at]?.['*'] ?? st.at
      return true
    },
    focus: async () => (st.focused++, st.focusOk)
  }
  return { st, io }
}
const mk = (log: string[] = []) => new Answerer((l) => log.push(l), async () => {})
const DOWN = '\u001b[B'

describe('parsing recorded Claude Code 2.1.322 screens', () => {
  test('Bash permission', () => {
    const p = parsePrompt(fx('bash'))!
    assert.equal(p.title, 'Bash command')
    assert.equal(p.ask, 'touch /tmp/demo/one.txt')
    assert.equal(p.question, 'Do you want to proceed?')
    assert.deepEqual(p.options.map((o) => o.n), [1, 2, 3, 4])
    assert.equal(p.options[1].label, 'Yes, and always allow access to /tmp/demo from this project', 'the whole grant is shown')
    assert.equal(p.options[3].freeText, 'amend')
    assert.equal(p.cursor, 1)
  })
  test('file permission', () => {
    const p = parsePrompt(fx('write'))!
    assert.equal(p.title, 'Create file')
    assert.equal(p.question, 'Do you want to create notes.txt?')
    assert.equal(p.options.length, 3)
  })
  test('question, without the "Chat about this" row', () => {
    const p = parsePrompt(fx('ask'))!
    assert.deepEqual([p.kind, p.title, p.question], ['question', 'Color', 'Which color?'])
    assert.deepEqual(p.options.map((o) => o.label), ['Red', 'Green', 'Blue', 'Type something.'])
    assert.equal(p.editing, false)
  })
  test('moving the cursor or typing keeps the signature; typing is flagged', () => {
    for (const n of ['bash-down', 'bash-amend', 'bash-amend-typed']) assert.equal(sigOf(n), sigOf('bash'), n)
    assert.equal(parsePrompt(fx('bash-cursor2'))!.title, 'Bash command')
    assert.equal(parsePrompt(fx('bash-down'))!.cursor, 4)
    assert.equal(parsePrompt(fx('bash-down'))!.editing, false)
    for (const n of ['ask2-type', 'ask2-typed']) assert.equal(sigOf(n), sigOf('ask2'), n)
    assert.notEqual(sigOf('ask'), sigOf('ask2'))
  })
  test('cursor on another option drops the amend hint: that is not typing', () => {
    const p = parsePrompt(fx('bash-cursor2'))!
    assert.deepEqual([p.cursor, p.editing, p.amendOpen], [2, false, false])
    assert.equal(p.options[3].label, 'No')
  })
  test('amend row open but empty is not typing; with text it is', () => {
    assert.deepEqual([parsePrompt(fx('bash-amend'))!.editing, parsePrompt(fx('bash-amend'))!.amendOpen], [false, true])
    assert.deepEqual([parsePrompt(fx('bash-amend-typed'))!.editing, parsePrompt(fx('bash-amend-typed'))!.amendOpen], [true, true])
    assert.deepEqual([parsePrompt(fx('ask2-type'))!.editing, parsePrompt(fx('ask2-typed'))!.editing], [false, true])
  })
  test('not confident -> null: answered screens, several questions, prose that looks like options', () => {
    for (const n of ['ask-after', 'write-after', 'ask-two']) assert.equal(parsePrompt(fx(n)), null, n)
    assert.equal(parsePrompt(['Do you want to proceed?', ' 1. Yes', ' 2. No', '', '❯ ']), null)
    assert.equal(parsePrompt(['Do you want to proceed?', ' 1. Yes', ' 2. No', ' Esc to cancel · Tab to amend']), null, 'no rule above')
    assert.equal(parsePrompt([...fx('bash'), '❯ something else']), null, 'no longer the last thing on screen')
    assert.equal(parsePrompt([]), null)
  })
  test('the next prompt after an amended answer is a different one', () => {
    assert.equal(parsePrompt(fx('bash-after'))!.ask, 'touch /tmp/demo/two.txt')
    assert.notEqual(sigOf('bash-after'), sigOf('bash'))
  })
  test('folder trust screen and an answered question are never answerable', () => {
    for (const n of ['trust', 'ask2-after']) assert.equal(parsePrompt(fx(n)), null, n)
  })
  test('free text is one line without control codes', () => assert.equal(cleanFreeText(' a\n\u001b[B b\t\u0003c '), 'a [B b c'))
  test('redactSecrets masks keys, tokens and passwords, and leaves plain text alone', () => {
    assert.equal(redactSecrets('api_key=FAKE-EXAMPLE-KEY-0000'), 'api_key=[redacted]')
    assert.equal(redactSecrets('Authorization: Bearer FAKE-TOKEN-0000000000000000'), 'Authorization: Bearer [redacted]')
    assert.equal(redactSecrets('password: fake-password-1234'), 'password: [redacted]')
    assert.equal(redactSecrets('key sk-EXAMPLE00000000000000000000 here'), 'key [redacted] here')
    assert.equal(redactSecrets('run the tests, no secrets here'), 'run the tests, no secrets here')
  })
  test('redactSecrets: more key formats (all values made up)', () => {
    const cases: [string, string][] = [
      ['key sk-ant-api03-FAKEFAKEFAKEFAKEFAKE_0000 here', 'key [redacted] here'],
      ['OPENAI=sk-proj-FAKE_fake-0000000000000000000', 'OPENAI=[redacted]'],
      ['export DB_PASSWORD=hunter2', 'export DB_PASSWORD=[redacted]'],
      ['GITHUB_TOKEN=abc123 npm publish', 'GITHUB_TOKEN=[redacted] npm publish'],
      ['STRIPE_SECRET="fake secret value"', 'STRIPE_SECRET=[redacted]'],
      ['MY_API_KEY=fakekey000 MY_APIKEY=fakekey111', 'MY_API_KEY=[redacted] MY_APIKEY=[redacted]'],
      ['AWS_ACCESS_KEY=FAKEACCESS0000 SSH_PRIVATE_KEY=fakepk', 'AWS_ACCESS_KEY=[redacted] SSH_PRIVATE_KEY=[redacted]'],
      ['my_passwd=FakePass1 x', 'my_passwd=[redacted] x'],
      ['git clone https://deploy:FakePass123@git.example.invalid/repo.git', 'git clone https://deploy:[redacted]@git.example.invalid/repo.git'],
      ['psql postgres://app:fake-pw@db.example.invalid:5432/app', 'psql postgres://app:[redacted]@db.example.invalid:5432/app'],
      ['mysql -u root -pFakePass1 app', 'mysql -u root -p[redacted] app'],
      ['tool --password=FakePass1 --user x', 'tool --password=[redacted] --user x'],
      ['tool --password FakePass1 --user x', 'tool --password [redacted] --user x'],
      ['token gho_FAKEFAKEFAKEFAKEFAKE0000', 'token [redacted]'],
      ['ghs_FAKEFAKEFAKEFAKEFAKE0000 ghu_FAKEFAKEFAKEFAKEFAKE0000 ghr_FAKEFAKEFAKEFAKEFAKE0000', '[redacted] [redacted] [redacted]'],
      ['aws_secret_access_key FAKEfakeFAKEfake/0000+fakeFAKE', 'aws_secret_access_key [redacted]'],
      ['{"password": "fake pass with spaces", "user": "x"}', '{"password": "[redacted]", "user": "x"}'],
      ['{"apiToken": "fake"}', '{"apiToken": "[redacted]"}'],
      ['client_secret: abc', 'client_secret: [redacted]'],
      ['password: "x"', 'password: [redacted]']
    ]
    for (const [i, o] of cases) assert.equal(redactSecrets(i), o, i)
  })
  test('redactSecrets leaves ordinary text alone', () => {
    for (const t of [
      'git checkout fix/passwordless-login',
      'open src/auth/password_reset.ts',
      'git show 3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
      'the secret santa list is ready',
      'set the password: later',
      'the token: none',
      'mysql -p app',
      'run the tests, no secrets here',
      'skip-ci and sk-short'
    ])
      assert.equal(redactSecrets(t), t, t)
  })
  test('a prompt excerpt carrying secrets is redacted before it reaches the helper', () => {
    const lines = fx('bash').map((l) =>
      l.replace(
        'touch /tmp/demo/one.txt',
        'curl https://example.invalid?api_key=FAKE-EXAMPLE-KEY-0000 -H "Authorization: Bearer FAKE-TOKEN-0000000000000000"'
      )
    )
    const p = parsePrompt(lines)!
    assert.equal(p.ask, 'curl https://example.invalid?api_key=[redacted] -H "Authorization: Bearer [redacted]"')
    assert.ok(!p.ask.includes('FAKE-EXAMPLE-KEY-0000') && !p.ask.includes('FAKE-TOKEN'), 'no fake secret in ask')
    assert.ok(!p.signature.includes('FAKE-EXAMPLE-KEY-0000') && !p.signature.includes('FAKE-TOKEN'), 'no fake secret in signature')
    assert.equal(p.question, 'Do you want to proceed?')
  })
})

describe('guard', () => {
  test('option: sends one key after re-reading, and confirms', async () => {
    const t = term({ bash: { '1': 'write-after' } }, 'bash')
    const log: string[] = []
    assert.deepEqual(await mk(log).answer('t1', t.io, { signature: sigOf('bash'), option: 1 }), { ok: true, confirmed: true })
    assert.deepEqual(t.st.sent, ['1'])
    assert.deepEqual(log, ['answer: terminal=t1 option=1'])
  })
  test('prompt already gone, or another prompt: nothing is sent', async () => {
    for (const at of ['ask-after', 'write', 'ask']) {
      const t = term({}, at)
      assert.deepEqual(await mk().answer('t', t.io, { signature: sigOf('bash'), option: 1 }), { ok: false, reason: 'gone' })
      assert.deepEqual(t.st.sent, [])
      assert.equal(t.st.focused, 1, 'the pane is shown first, then read')
    }
  })
  test('prompt changes between the first read and the send: nothing is sent', async () => {
    const t = term({}, 'bash')
    t.st.onRead = (n) => n === 2 && (t.st.at = 'write')
    assert.deepEqual(await mk().answer('t', t.io, { signature: sigOf('bash'), option: 1 }), { ok: false, reason: 'gone' })
    assert.deepEqual(t.st.sent, [])
  })
  test('someone is typing in the terminal: nothing is sent', async () => {
    const t = term({}, 'bash-amend-typed')
    assert.deepEqual(await mk().answer('t', t.io, { signature: sigOf('bash'), option: 1 }), { ok: false, reason: 'editing' })
    assert.deepEqual(t.st.sent, [])
  })
  test('pane cannot be shown: nothing is sent', async () => {
    const t = term({}, 'bash')
    t.st.focusOk = false
    assert.equal((await mk().answer('t', t.io, { signature: sigOf('bash'), option: 1 }) as { reason: string }).reason, 'unfocused')
    assert.deepEqual(t.st.sent, [])
  })
  test('unknown option, or empty text: nothing is sent', async () => {
    const t = term({}, 'bash')
    for (const a of [{ option: 9 }, { option: 1, text: 'x' }, { option: 4, text: ' \n ' }]) assert.equal((await mk().answer('t', t.io, { signature: sigOf('bash'), ...a })).ok, false)
    assert.deepEqual(t.st.sent, [])
  })
  test('a key that does nothing is reported as unconfirmed, and not retried', async () => {
    const t = term({}, 'bash')
    assert.deepEqual(await mk().answer('t', t.io, { signature: sigOf('bash'), option: 1 }), { ok: true, confirmed: false })
    assert.deepEqual(t.st.sent, ['1'])
  })
  test('two clicks at once send once', async () => {
    const t = term({ bash: { '1': 'write-after' } }, 'bash')
    const a = mk()
    const r = await Promise.all([a.answer('t', t.io, { signature: sigOf('bash'), option: 1 }), a.answer('t', t.io, { signature: sigOf('bash'), option: 1 })])
    assert.equal(r.filter((x) => x.ok).length, 1)
    assert.deepEqual(t.st.sent, ['1'])
  })
  test('read failure: nothing is sent, the error is not thrown', async () => {
    const t = term({}, 'bash')
    t.io.read = async () => Promise.reject(new Error('terminal_exited'))
    assert.deepEqual(await mk().answer('t', t.io, { signature: sigOf('bash'), option: 1 }), { ok: false, reason: 'error' })
    assert.deepEqual(t.st.sent, [])
  })
})

describe('free text', () => {
  test('permission: cursor to No, Tab, text, Enter; the text is not logged', async () => {
    const t = term({ bash: { [DOWN]: 'bash-down' }, 'bash-down': { '\t': 'bash-amend' }, 'bash-amend': { '*': 'write-after' } }, 'bash')
    const log: string[] = []
    assert.deepEqual(await mk(log).answer('t', t.io, { signature: sigOf('bash'), option: 4, text: 'use a\nsecret name' }), { ok: true, confirmed: true })
    assert.deepEqual(t.st.sent, [DOWN, '\t', 'use a secret name⏎'])
    assert.ok(!log.join().includes('secret'))
  })
  test('question: the "Type something." row', async () => {
    const t = term({ ask2: { '3': 'ask2-type' }, 'ask2-type': { '*': 'ask-after' } }, 'ask2')
    assert.deepEqual(await mk().answer('t', t.io, { signature: sigOf('ask2'), option: 3, text: 'a triangle' }), { ok: true, confirmed: true })
    assert.deepEqual(t.st.sent, ['3', 'a triangle⏎'])
  })
  test('free text from a prompt whose cursor sits on option 2', async () => {
    const t2 = term({ 'bash-cursor2': { [DOWN]: 'bash-down' }, 'bash-down': { '\t': 'bash-amend' }, 'bash-amend': { '*': 'write-after' } }, 'bash-cursor2')
    const r = await mk().answer('t', t2.io, { signature: sigOf('bash-cursor2'), option: 4, text: 'x' })
    assert.equal(r.ok, false, 'its signature differs from the other file, so the guard stops at the first move')
  })
  test('the text row did not open: the text is never typed', async () => {
    const t = term({ bash: { [DOWN]: 'bash-down' } }, 'bash')
    assert.equal((await mk().answer('t', t.io, { signature: sigOf('bash'), option: 4, text: 'rm -rf' })).ok, false)
    assert.ok(!t.st.sent.some((s) => s.includes('rm')))
  })
  test('prompt answered elsewhere after Tab: the text is never typed', async () => {
    const t = term({ bash: { [DOWN]: 'bash-down' }, 'bash-down': { '\t': 'ask-after' } }, 'bash')
    assert.equal((await mk().answer('t', t.io, { signature: sigOf('bash'), option: 4, text: 'rm -rf' }) as { reason: string }).reason, 'gone')
    assert.ok(!t.st.sent.some((s) => s.includes('rm')))
  })
})
