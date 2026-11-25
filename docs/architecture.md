# Architecture

Orca Island has two parts:
- an Orca **trusted-worker plugin** in TypeScript, which decides what to show,
- a small **native helper** in Swift/SwiftUI, which draws the island.

They talk JSON Lines over the helper's stdin and stdout.

```
Orca ──events / host API──▶ worker (src/worker.ts) ──JSON Lines──▶ helper (helper/island.swift)
  ▲                            │   SessionStore (state.ts)                 one panel per screen
  └──── terminal.focus, ◀──────┘   OrcaSource (orca-source.ts)  ◀──clicked / presence / hotkey──┘
        workspace.open …           Directory (directory.ts)
```

## Worker (`src/`)

| File | What it does |
|---|---|
| `worker.ts` | Wiring. Subscribes to Orca events and feeds the store. Sends items to the helper (L2), the status bar (L1) or system notifications (L3). Handles clicks, jumps and answers. Persists rows and snoozes. |
| `state.ts` | `SessionStore`, the state machine. Pure: no Orca APIs, with the clock and timers injected. |
| `orca-source.ts` | Reads things the plugin API does not give, using the `orca` CLI that ships with Orca: bot questions, plugin approvals, failed automations, orchestration gates, and the worktree/bot directory. Re-reads when Orca's database changes (one `stat` per second) and every 60 s. Backs off on errors. |
| `directory.ts` | Turns panes into readable names and groups (by project or by bot). |
| `jump.ts` | Where a click goes: `terminal.focus` for a terminal, `orca://bot/…` or `workspace.open` otherwise. |
| `tui.ts`, `answer.ts` | Parse a Claude Code prompt from terminal lines, and answer it only if its signature is unchanged. |
| `peek.ts` | Which item the collapsed island previews, one at a time. |
| `bridge.ts` | Spawns the helper and does the `hello`/`ready` handshake. Restarts with 1 s→60 s backoff, and replays items after a restart. Stops retrying after more than 3 crashes in 60 s, then falls back to notifications. |
| `helper-build.ts` | First-run compile of `helper/island.swift` with `xcrun swiftc -O` into `~/Library/Caches/orca-island/<hash>/`. Falls back to JXA without swiftc. |

### State machine

Items are keyed by session (`s:<sessionId>`, else `p:<paneKey>`). Rules learned from recorded agent sessions:

| Agent status | Island | Rule |
|---|---|---|
| `waiting` or `blocked` after a `working` | **needs you** (P0) | Shown after 1.5 s stable. Never expires. One reminder after 3 min. |
| `done` + `failure` | failed (P1) | 3 s stable |
| `done` + `interruption` | interrupted (P2, silent) | |
| `done` with no outcome / `success` | done (P2) | 3 s stable, and only if the turn ran ≥ `minWorkSec` |
| `done` + `cancellation` / `superseded` | row removed, silent | |
| `done` before any `working` | ignored | Every new session starts with a spurious `done` |
| `working` | counts only | Cancels a pending done or needs-you, which absorbs waiting↔working flicker |

- **Deduplication.** Frames are deduped on `(state, stateStartedAt, outcome)`, and older frames are dropped.
- **Batching.** Alerts within 2.5 s are batched into one peek. Needs-you goes out at once.

**Dismissing.**
- × on a finished row removes it until that session has a new event. For bot and run rows, the removed version is remembered.
- × on a needs-you row hides it for 30 minutes, or until the question changes.
- Both are persisted in plugin storage, and 撤销 (undo) works for 10 s.

**Master switch.**
- Off for 1 hour, until 08:00, or until turned on. The end is stored as an absolute time and checked again after sleep, reload and restart.
- Off stops the helper on purpose. That is not counted as a crash, and nothing falls back to notifications.
- While off: no alerts, and no terminal reads or keys, even for an answer already under way. Rows are still tracked.
- The status bar summary item reads 「Island 已关闭」 and turns the island back on. Status bar updates are retried until Orca accepts them, and re-applied while off.
- The 启用 Orca Island setting mirrors the switch both ways.

**Suppression.**
- When Orca is in front and the item is in the focused workspace, it stays silent.
- While the screen is locked, nothing peeks. A "while you were away" summary shows after the first input on return.

### Orca decisions (`orca-source.ts`)

Bot items waiting for a decision, plugins waiting for approval, failed automation runs and pending orchestration gates come from the `orca` CLI (`--json`):
`bot list`, `bot item list`, `bot chats`, `worktree ps`, `plugin list`, `automations runs`, `orchestration run-list` and `gate-list`.
Bots that run on another computer are skipped.

## Helper (`helper/island.swift`)

- One borderless, non-activating `NSPanel` per screen, above the menu bar. It never takes focus, except for the answer text field.
- **Size.** On a notch screen it is the notch width plus wings. Otherwise it is a pill at the top center.
- **Shape.** One SwiftUI `IslandShape` morphs between pill → peek → list → detail. The window itself never animates.
- **Mouse.** The panel ignores the mouse outside the island's shape.
- **Clicks.** A click activates Orca, then reports `clicked`. The worker does the jump.
- **Presence.** It reports the frontmost app and the lock state for suppression.
- **Hotkey.** Global hotkey ⌃⌥⇧U via Carbon `RegisterEventHotKey`, so no Accessibility permission is needed.
- **Single instance.** A `flock` lock file. A second helper exits with code 3.
- **Capture.** `sharingType = .none` by default ("hide from capture").
- `helper/island.jxa.js` is a reduced fallback (pill only) for Macs without the Xcode command-line tools.

### Protocol (JSON Lines, one object per line, `v: 1`)

Worker → helper:

| type | |
|---|---|
| `hello`, `config` | bundle id of Orca, settings |
| `upsert` / `remove` / `reset` | items |
| `groups` | list grouping (by project or bot) |
| `peek` | preview one item, or a summary text |
| `detail` | question, options and input kind for an opened row |
| `picked`, `answered`, `hint`, `toast` | feedback after an action |
| `summary` | counts |
| `ping`, `quit` | |

Helper → worker:

| type | |
|---|---|
| `ready` | screens |
| `clicked` | `action`: `open`, `jump`, `answer`, `pick`, `dismiss`, `clear_finished`, `undo`, `mark_all_read`, `snooze`, `power_off`, `set_mode`, `toggle_group`, `open_orca`, `settings`… |
| `presence` | frontmost app, locked |
| `hotkey` | |
| `pong`, `error` | |

Debug messages (`debug_*`, `snap`, `record`, `demo_clock`) are used by the tests and by `tools/demo.py`. They work only with
`ISLAND_OFFSCREEN=1`, where nothing is shown on screen.

## Answering

Answering is off by default. It needs `terminal:read` and `terminal:send` granted, plus the "answering" setting confirmed in ⚙.

1. When a needs-you row from a Claude Code terminal is opened, the worker reads the terminal once and parses the prompt (`tui.ts`). It sends the question and options to the helper, with a signature.
2. On a pick, the worker focuses the terminal and waits until Orca reports it active. It then re-reads the prompt and sends keys only if the signature still matches. Otherwise it says the prompt changed.
3. Terminal text is never logged or stored.
