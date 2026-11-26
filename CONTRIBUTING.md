# Contributing to Island for Orca

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Setup

You need:
- macOS 14 or newer
- [Orca](https://orca.dev) 1.4.259 or newer (it ships the `orca` command-line tool)
- the Xcode command-line tools (`xcode-select --install`)
- Node 24.22 or newer, but only for running the tests without Orca (`--experimental-transform-types`; some earlier 24.x builds reject it)

```sh
git clone https://github.com/Leo-Ni88/orca-island
cd orca-island
orca plugin types .          # TypeScript typings into .orca/ (gitignored)
orca plugin dev load .       # load it as a development plugin; Orca asks you to approve its access
```

After you edit code, run `orca plugin dev reload .`.
- Code edits do not need a new approval.
- New capabilities need one.
- Don't count on Orca's approval prompt as a review step for new commands or status bar items: a dev reload has been seen to accept a new command without prompting.
- List every command, status bar item and capability change in your PR so it gets reviewed.

## Tests

```sh
orca plugin test .           # the full suite, including the worker tests on Orca's test host
orca plugin validate .       # the manifest, the way Orca and the plugin directory check it
sh tools/ci/run-tests.sh     # without Orca: worker-host tests are skipped (this is what CI runs)
```

- The state machine (`src/state.ts`) is pure and uses a fake clock, so most behaviour can be tested without timers or Orca.
- The helper tests spawn the real Swift helper off-screen (`ISLAND_OFFSCREEN=1`). They need it compiled:
  `xcrun swiftc -O -o helper/bin/island-helper helper/island.swift`.

## Looking at the UI without real data

`tools/demo.py` drives the helper off-screen with the made-up data in `demo/demo-data.json`, and the helper draws its own view into
PNG files. It never captures the screen. All screenshots in `media/` are made this way.

```sh
xcrun swiftc -O -o helper/bin/island-helper helper/island.swift
python3 -m pip install pillow          # and: brew install ffmpeg
python3 tools/make_media.py            # rebuilds media/ (icon, cover, screenshots, GIFs)
```

For GIFs the helper runs its animations 8 times slower off-screen (`ISLAND_SLOW`), so every frame is drawn on time.

## Ground rules

- **Never put real data in the repository.** Code, tests, fixtures, docs and images use made-up names only: projects `web-app`,
  `api-server`, `mobile-app`; bots `atlas`, `nova`; branches `feat/login`, `fix/cache`. No real paths, usernames or terminal
  output.
- **Keep the access small.** A new capability or command changes the approval every user sees, so explain why in the PR.
- **No network, no tracking.**
- **Supported Orca APIs only.** If something needs an API Orca does not have, note it in `docs/roadmap.md` instead of reaching into
  Orca's internals.
- Prefer small PRs with a test.

## Where things are

See [docs/architecture.md](docs/architecture.md).
