# Security

## Reporting a problem

Please report security issues privately through
[GitHub security advisories](https://github.com/Leo-Ni88/orca-island/security/advisories/new),
not in a public issue. You should get an answer within a week.

## What the plugin can do

Island for Orca runs as an Orca **trusted worker**. Orca shows you the access it asks for before you approve it:

| Capability | Used for |
|---|---|
| `agent:read` | Agent status events (working, waiting, done) |
| `workspace:read` | Workspace names and branches, which terminal belongs where |
| `workspace:write` | Jumping to a terminal or workspace when you click ↗ |
| `notifications:show` | System notifications when the island cannot be shown |
| `storage:own`, `settings:own` | Its own rows, snoozes, on/off state and settings |
| `terminal:read` | Reading the prompt on screen, **only** while a row needs you, **only** when answering is on |
| `terminal:send` | Typing your choice into that terminal, **only** after you pick it in the island |

It also adds:
- seven commands to Orca's command palette, mostly for diagnostics;
- two status bar items: a summary, and a pause button that turns the island off for an hour.

## What it reads

- **Agent status events from Orca.** Status, title, workspace, branch and the agent's current task text.
- **Orca's command-line tool.** The plugin runs the `orca` CLI that ships with Orca (`--json`):
  - `bot list`, `bot item list`, `bot chats` (bot questions waiting for you, and chat names),
  - `worktree ps`,
  - `plugin list`,
  - `automations runs`,
  - `orchestration run-list`, `gate-list`.

  The "显示 Orca 的待你决定" setting turns this off.
- **One file's timestamp and size.** To notice new bot questions quickly, it `stat`s Orca's `bot-items.sqlite-wal` in Orca's data folder once a second: only the file's timestamps and size, never its contents.
- **Terminals.** Only while answering is on, and only for a Claude Code prompt you open in the island (see below).

## What it stores

Everything goes into plugin storage, inside Orca's data folder:
- **The current rows.** Titles, questions, commands or tool names, options and message lines, taken from Orca's own status and bot data. They are kept so the list survives a restart.
- **Your state.** Hidden (snoozed) rows, removed ones, the on/off state and the grouping mode.
- **Recorded events, only if you turn on the `record` setting.** For debugging, it then stores the raw agent and workspace events (up to 3000) until you clear them with "Island: Clear recorded events" or turn the setting off.

Its log (`orca plugin logs`) has jump targets, errors and a short restore summary. Terminal text never goes there.

## Terminal text

Answering is off by default. You turn it on in the island's ⚙ and confirm.
- When it is off, the plugin neither reads nor types into any terminal.
- When it is on, it reads a terminal only while you have that terminal's prompt open in the island.
- It types only after your click, and only if the prompt on screen still has the signature you saw.
- What `terminal.read` returns:
  - is parsed in memory,
  - is sent only to the helper so you can see the question and options,
  - never goes to plugin storage, the log or the event recorder.
- What you type to answer is not logged or stored either. The log has the terminal id and the option number only.
- When the island is turned off, reading and typing stop at once, even for an answer that is already under way.

## Opening things

When you jump to a bot, the plugin asks macOS to open `orca://bot/<id>` (`/usr/bin/open`). For a bot item it adds `?botItem=<item id>`, so Orca versions that support it open the item itself. It opens no other URLs.

## The native helper

The island is drawn by a small Swift program, `helper/island.swift`. On first use it is compiled on your Mac with `xcrun swiftc`
into `~/Library/Caches/orca-island/<hash>/`. No binary ships in this repository.

The helper:
- talks only to the plugin, over stdin and stdout,
- opens no network connections,
- never captures the screen,
- by default asks macOS to keep the island out of screenshots and recordings (best effort).

Without the Xcode command-line tools a reduced JXA version (`helper/island.jxa.js`) runs instead.

## No tracking

The plugin makes no network requests and collects no analytics.
