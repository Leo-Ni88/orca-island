// Guarded answering of a Claude Code prompt in an Orca terminal.
// Rule: every key is sent only right after a read that shows the very same prompt. Anything else
// -> nothing is sent. Logs name the terminal and the option number, never typed text.
import { cleanFreeText, parsePrompt, type TuiPrompt } from './tui'

export type TerminalIo = {
  read(): Promise<readonly string[]>
  send(text: string, enter?: boolean): Promise<boolean>
  /** Orca's plugin API types only into the active workspace, so its pane is shown first. */
  focus(): Promise<boolean>
}
export type AnswerResult = { ok: true; confirmed: boolean } | { ok: false; reason: 'gone' | 'editing' | 'unfocused' | 'refused' | 'unsupported' | 'empty' | 'error' }
export type Answer = { signature: string; option: number; text?: string }

const DOWN = '\u001b[B'
const UP = '\u001b[A'

export class Answerer {
  private busy = new Set<string>()
  private step = 'start'

  constructor(
    private log: (line: string) => void,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  async answer(terminalId: string, io: TerminalIo, a: Answer): Promise<AnswerResult> {
    if (this.busy.has(terminalId)) return { ok: false, reason: 'refused' }
    this.busy.add(terminalId)
    try {
      return await this.run(terminalId, io, a)
    } catch (e) {
      this.log(`answer: terminal=${terminalId} option=${a.option} failed at ${this.step}: ${String((e as { code?: string })?.code ?? 'error').slice(0, 40)} ${String((e as Error)?.message ?? '').slice(0, 120)}`)
      return { ok: false, reason: 'error' }
    } finally {
      this.busy.delete(terminalId)
    }
  }

  private async same(io: TerminalIo, signature: string): Promise<TuiPrompt | null> {
    this.step = 'read'
    const p = parsePrompt(await io.read())
    return p && p.signature === signature ? p : null
  }

  private async run(terminalId: string, io: TerminalIo, a: Answer): Promise<AnswerResult> {
    const text = a.text === undefined ? undefined : cleanFreeText(a.text)
    if (text === '') return { ok: false, reason: 'empty' }
    // Orca reads and types only in the focused workspace: show the pane first, then look.
    this.step = 'focus'
    if (!(await io.focus())) return { ok: false, reason: 'unfocused' }
    const first = await this.same(io, a.signature)
    if (!first) return { ok: false, reason: 'gone' }
    if (first.editing) return { ok: false, reason: 'editing' }
    const opt = first.options.find((o) => o.n === a.option)
    if (!opt || (text !== undefined && !opt.freeText) || (text === undefined && opt.freeText === 'type')) return { ok: false, reason: 'unsupported' }
    let sent: boolean
    if (text === undefined) {
      const now = await this.same(io, a.signature)
      if (!now || now.editing) return { ok: false, reason: now ? 'editing' : 'gone' }
      this.step = 'send'
      sent = await io.send(String(a.option))
    } else {
      const r = await this.openFreeText(io, a, opt.freeText!)
      if (r) return r
      sent = await io.send(text, true)
    }
    if (!sent) return { ok: false, reason: 'refused' }
    this.log(`answer: terminal=${terminalId} option=${a.option}${text === undefined ? '' : ' (free text)'}`)
    for (let i = 0; i < 6; i++) {
      await this.sleep(250)
      if (!(await this.same(io, a.signature))) return { ok: true, confirmed: true }
    }
    return { ok: true, confirmed: false }
  }

  /** Puts the cursor in the free-text row, checking the screen before every key. */
  private async openFreeText(io: TerminalIo, a: Answer, how: 'amend' | 'type'): Promise<AnswerResult | undefined> {
    const keyed = async (key: string): Promise<AnswerResult | undefined> => {
      const p = await this.same(io, a.signature)
      if (!p) return { ok: false, reason: 'gone' }
      if (p.editing) return { ok: false, reason: 'editing' }
      if (!(await io.send(key))) return { ok: false, reason: 'refused' }
      await this.sleep(200)
      return undefined
    }
    if (how === 'type') {
      const bad = await keyed(String(a.option))
      if (bad) return bad
    } else {
      for (let i = 0; i < 8; i++) {
        const p = await this.same(io, a.signature)
        if (!p) return { ok: false, reason: 'gone' }
        if (p.cursor === a.option) break
        if (!p.cursor) return { ok: false, reason: 'unsupported' }
        const bad = await keyed(p.cursor < a.option ? DOWN : UP)
        if (bad) return bad
      }
      const p = await this.same(io, a.signature)
      if (p?.cursor !== a.option) return { ok: false, reason: p ? 'unsupported' : 'gone' }
      const bad = await keyed('\t')
      if (bad) return bad
    }
    const p = await this.same(io, a.signature)
    if (!p) return { ok: false, reason: 'gone' }
    return p.amendOpen && p.cursor === a.option ? undefined : { ok: false, reason: 'unsupported' }
  }
}
