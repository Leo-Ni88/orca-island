// Claude Code TUI prompts, read from `terminal.read` lines.
// Parses only shapes recorded from Claude Code 2.1.322 (src/fixtures/tui); anything else -> null,
// and the island falls back to "去 Orca 回答". Pure: no Orca APIs.

export type PromptKind = 'permission' | 'question'
export type PromptOption = {
  /** The number Claude Code shows; pressing it selects the option. */
  n: number
  label: string
  /** Selecting it lets the person type: permission "No" (via Tab) or a question's "Type something.". */
  freeText?: 'amend' | 'type'
}
export type TuiPrompt = {
  kind: PromptKind
  /** "Bash command", "Create file", or the question header ("Color"). */
  title: string
  /** What is being asked: the command or file, or the question text. */
  ask: string
  question: string
  options: PromptOption[]
  /** Someone is typing into the prompt's own free-text row: never answer over them. */
  editing: boolean
  /** The free-text row is open (cursor on it), whether or not anything is typed yet. */
  amendOpen?: boolean
  /** The row the cursor (❯) is on. */
  cursor: number
  /** Identifies this prompt on screen: same signature = the same prompt is still showing. */
  signature: string
}

const SEP = /^─{8,}$/
const OPTION = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/
const PERMISSION_FOOTER = /^\s*Esc to cancel(?: · Tab to amend)?\s*$/
const QUESTION_FOOTER = /^\s*Enter to select · /

/** Strips the cursor arrow and trailing hint so a selection move does not look like a new prompt. */
const cleanLabel = (s: string): string => s.replace(/\s+·\s+.*$/, (m) => (/auto mode|shift\+tab/.test(m) ? m : '')).trim()

/**
 * Masks API keys, tokens and passwords in text shown outside the terminal. Rules run in order:
 * 1. Credentials inside URLs, command-line password flags, JSON values and env-style assignments.
 * 2. `label: value` / `label=value`: always for clear key names (api_key, client_secret, …); for the
 *    loose words (password, secret, token, …) only when the value looks like a secret (quoted, has a
 *    digit or a symbol, or is 12+ characters), so prose like "set the password: later" stays.
 * 3. Bearer tokens and known key prefixes (sk-…, gh*_, github_pat_, AKIA, xox*).
 * Anything not matching a pattern is left alone.
 */
const R = '[redacted]'
const KEYNAME = '(?:api[_-]?key|apikey|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)'
const LOOSE = '(?:secret|password|passwd|pwd|token)'
const secretish = (v: string): boolean => /^["']/.test(v) || /[0-9]/.test(v) || /[^A-Za-z]/.test(v) || v.length >= 12
export function redactSecrets(s: string): string {
  return (
    s
      // scheme://user:PASS@host
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${R}@`)
      // -pPASS (mysql), --password=PASS, --password PASS
      .replace(/(\s-p)(?=\S)(?!assword)[^\s'"]+/g, `$1${R}`)
      .replace(/(--password(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, `$1${R}`)
      // "password": "with spaces" (JSON, either quote style for the key)
      .replace(/(["'](?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key)[A-Za-z0-9_-]*)["']\s*:\s*)("[^"]*"|'[^']*')/gi, `$1"${R}"`)
      // NAME=value where NAME ends in a secret word (env style)
      .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${R}`)
      // aws_secret_access_key <value> (space, as in ~/.aws/credentials or CLI output)
      .replace(/\b(aws_secret_access_key\s+)(?![:=])([A-Za-z0-9/+=]{16,})/gi, `$1${R}`)
      // clear key names: always
      .replace(new RegExp(`\\b(${KEYNAME}\\s*[:=]\\s*)(?!\\[redacted\\])(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi'), `$1${R}`)
      // loose words: only a secret-looking value
      .replace(new RegExp(`\\b(${LOOSE}\\s*[:=]\\s*)(?!\\[redacted\\])("[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi'), (m, label: string, v: string) => (secretish(v) ? label + R : m))
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, `Bearer ${R}`)
      // sk-…, including sk-ant-… and sk-proj-… (dashes and underscores inside)
      .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, R)
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, R)
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, R)
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, R)
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, R)
  )
}

export function parsePrompt(lines: readonly string[]): TuiPrompt | null {
  const L = lines.map((l) => l.replace(/\s+$/, ''))
  // The prompt is the last block on screen; its footer is the last non-empty line.
  let end = L.length - 1
  while (end >= 0 && !L[end].trim()) end--
  if (end < 0) return null
  if (PERMISSION_FOOTER.test(L[end])) return parsePermission(L, end)
  if (QUESTION_FOOTER.test(L[end])) return parseQuestion(L, end)
  return null
}

function parsePermission(L: string[], footer: number): TuiPrompt | null {
  const opts: PromptOption[] = []
  let i = footer - 1
  while (i >= 0 && !L[i].trim()) i--
  for (; i >= 0; i--) {
    const m = OPTION.exec(L[i])
    if (!m) break
    opts.unshift({ n: Number(m[1]), label: cleanLabel(m[2]) })
  }
  const question = L[i]?.trim() ?? ''
  if (opts.length < 2 || !/\?$/.test(question) || !sequential(opts)) return null
  // Header: the first line after the separator above the prompt.
  const cursor = cursorOf(L, i + 1, footer)
  let top = i - 1
  while (top >= 0 && !SEP.test(L[top].trim())) top--
  const block = L.slice(top + 1, i).map((l) => l.trim()).filter((l) => l && !/^Tip:/.test(l))
  const title = block[0] ?? 'Permission'
  if (top < 0) return null
  const body = block.slice(1).filter((l) => !/^╌{8,}$/.test(l))
  // The thing to approve sits between the dashed rules; else the description line.
  const dashed: string[] = []
  let inside = false
  for (const l of L.slice(top + 1, i).map((x) => x.trim())) {
    if (/^╌{8,}$/.test(l)) {
      inside = !inside
      continue
    }
    if (inside && l) dashed.push(l)
  }
  const ask = (dashed.join(' ') || body.join(' ')).slice(0, 300)
  const last = opts[opts.length - 1]
  if (!/^No\b/.test(last.label)) return null
  // Claude Code shows 'Tab to amend' only while the cursor is on an option that can be amended, and
  // replaces the label of the last option with what is being typed. So typing = the cursor is on the
  // last option, the hint is gone, and its label is no longer plain 'No'. (Recorded: cursor on 2 also
  // drops the hint, with nobody typing.)
  const onLast = cursor === last.n
  const editing = onLast && !/Tab to amend/.test(L[footer]) && !/^No(, and tell Claude what to do differently)?$/.test(last.label)
  const amendOpen = onLast && !/Tab to amend/.test(L[footer])
  last.freeText = 'amend'
  if (amendOpen) last.label = 'No'
  const redactedOpts = opts.map((o) => ({ ...o, label: redactSecrets(o.label) }))
  return { kind: 'permission', title: redactSecrets(title), ask: redactSecrets(ask), question: redactSecrets(question), options: redactedOpts, editing, amendOpen, cursor, signature: sig('permission', redactSecrets(title), redactSecrets(ask), redactSecrets(question), redactedOpts) }
}

function parseQuestion(L: string[], footer: number): TuiPrompt | null {
  // Options (with indented descriptions), a separator, then "Chat about this" below it.
  const opts: PromptOption[] = []
  let question = ''
  let header = ''
  let multi = false
  let start = footer - 1
  while (start >= 0 && !/^\s*[☐☒✔]|^←/.test(L[start])) start--
  if (start < 0) return null
  multi = /^←/.test(L[start].trim())
  header = L[start].replace(/^[\s←→]+|[\s←→]+$/g, '').replace(/^[☐☒]\s*/, '').trim()
  let q = start + 1
  while (q < footer && !L[q].trim()) q++
  question = L[q]?.trim() ?? ''
  let typed = false
  for (let i = q + 1; i < footer; i++) {
    const m = OPTION.exec(L[i])
    if (!m) continue
    const label = m[2].trim()
    if (/^Chat about this$/.test(label)) continue // leaves the question for the chat: not an answer
    opts.push({ n: Number(m[1]), label })
  }
  // The row above "Chat about this" is the free-text row; anything else in it is being typed.
  const last = opts[opts.length - 1]
  const lastRaw = last?.label ?? ''
  if (last) {
    const cursorHere = cursorOf(L, q + 1, footer) === last.n
    typed = cursorHere
    if (!/^Type something\.?$/.test(last.label)) {
      if (!cursorHere) return null
      last.label = 'Type something.'
    }
    last.freeText = 'type'
  }
  // Several questions are answered on separate tabs; the island answers one at a time only.
  if (multi || opts.length < 2 || !question || !sequential(opts)) return null
  const redactedOpts = opts.map((o) => ({ ...o, label: redactSecrets(o.label) }))
  return { kind: 'question', title: redactSecrets(header), ask: redactSecrets(question), question: redactSecrets(question), options: redactedOpts, editing: typed && !/^Type something\.?$/.test(lastRaw), amendOpen: typed, cursor: cursorOf(L, q + 1, footer), signature: sig('question', redactSecrets(header), redactSecrets(question), redactSecrets(question), redactedOpts) }
}

function cursorOf(L: string[], from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const m = /^\s*❯\s*(\d{1,2})\./.exec(L[i])
    if (m) return Number(m[1])
  }
  return 0
}

const sequential = (o: PromptOption[]): boolean => o.every((x, i) => x.n === o[0].n + i) && o[0].n === 1

function sig(kind: string, title: string, ask: string, question: string, opts: PromptOption[]): string {
  // The option the cursor is on, and typed amend text, change between reads: leave them out.
  const labels = opts.map((o) => (o.freeText ? `${o.n}.*` : `${o.n}.${o.label}`)).join('|')
  return [kind, title, ask, question, labels].join('␟')
}

/** Free text must fit on one line and not carry terminal control codes. */
export function cleanFreeText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
}
