# Roadmap

Ideas, roughly in order. Issues and PRs welcome; items marked *(good first issue)* are small and self-contained.

## Next

- **English UI.** The interface is Chinese only. Move strings to one table and add English, chosen from the system language. *(good first issue for single screens)*
- **Stuck and quota alerts.**
  - Warn when an agent has been `working` with no output for a long time.
  - Warn when it stops on a usage limit or quota message.
- **Quiet hours and Focus mode.** Respect a macOS Focus, or a schedule in settings: count only, no peeks, no sounds. (A manual off switch exists already.)
- **Fullscreen policy.** When the front app is fullscreen (a video, a presentation), stay hidden or show only needs-you. Make this a setting.
- **Redacting terminal excerpts.** Before a prompt's text is shown, mask anything that looks like a token, key or password.
- **Checking a notch screen.** The notch geometry (`auxiliaryTopLeftArea` / `auxiliaryTopRightArea`) is written but has only been tested on non-notch displays. Reports and screenshots from notch MacBooks would help.

## Later

- **Phone push** for needs-you while you are away from the Mac: [Bark](https://github.com/Finb/Bark), Feishu, [ntfy](https://ntfy.sh), Telegram. Opt-in per channel. This is the only feature that would make network requests, so it stays off by default and is clearly marked.
- **More agents.** Codex, opencode and others report states slightly differently (for example, opencode sends no `outcome` on cancel). Recordings of their status events are welcome.
- **Configurable hotkey** in settings.
- **Full JXA fallback** (list and detail), for Macs without the Xcode command-line tools.
- **Windows/Linux: a real island.** Today these systems get only the status bar and system notifications (see [Platform support](../README.md#platform-support)). *(help wanted)*

## Needs Orca

These need APIs that Orca's plugin host does not have yet. Until it does, Island for Orca uses only supported APIs, says what it could not do, and tells you where to look.

- **Answering bot items** from the island, once [stablyai/orca#48010](https://github.com/stablyai/orca/issues/48010) lands. Until then, a bot item opens the bot in Orca.
- **Open one bot item from a link.**
  - [stablyai/orca#49398](https://github.com/stablyai/orca/pull/49398) is an open PR by another contributor. It adds `orca://bot/<botId>?botItem=<item uid>`.
  - The island already sends `?botItem=<uid>` on bot-item jumps (1.0.2). Older Orca versions ignore it and still open the bot.
  - Once Orca ships it, the jump lands on the item. Until the island can tell the item really opened, it keeps showing where to click.
- Also proposed on #48010:
  - **Open a bot on a given right-sidebar tab** (主页 / 聊天). `orca://bot/<id>` selects the bot, but the right sidebar stays on whatever tab was open last. The island shows "请在右侧切到「主页」".
  - **Open one chat tab** of a bot. The island names the chat to switch to.
  - **Open a specific bot item, even when the bot is already open.** Opening `orca://bot/<id>` again changes nothing on screen when that bot is shown, for example when 主页 shows another item's details. The island names the item (`#61 …`) and the steps to it.
- **Reveal a plugin panel** from a status-bar click.
- **The focused pane**, so a prompt in the terminal you are looking at can stay silent. Today this works per workspace only.
- **A documented `permission` state** in `agent.status.changed`. Today a Claude Code permission prompt arrives as `waiting`.
