# Reference survey, 2026-11-06

What the reference projects do, from reading their source. Nothing here was
run against the installed Herdr (herdr-app 0.1.13, herdr-core `hc` 0.1.18).
Two Claude research agents and one Codex agent read the code independently;
their conclusions agreed.

Commits read: Flockbook `c0420c7`, Shepherdr `4552191`, herdr-t3 `17bbad1`,
herdr-layout-examples `0ec9676`. Clone them again at those commits to check a
claim. Line counts are raw `wc -l`.

## Herdr's customization model

From `~/.config/herdr-app/AGENTS.md` and its type files:

- A layout is a JSON tree of `row`, `column`, `stack` and `block` nodes. A block
  shows a mod, a terminal, the active tab, or one agent's terminal.
- Mods are JavaScript with gpui-kit builders, drawn natively by GPUI: no DOM,
  HTML, web view, Node APIs or `setTimeout`. Saving a file reloads the mod.
- `exec(cmd, args, { cwd, on })` resolves once with the whole output, capped at
  30 s and 8 MiB (`herdr.d.ts:10-13`). There is no streaming. Long-running work
  must live outside the mod and be polled, or written to files that the mod
  watches with `watchFolder` (local only).
- Shipped layouts and mods are replaced on every start. `layout.clone` and
  `mod.clone` make editable copies. Click state lives in `layouts/.state/`.
- Mods run from the window machine's `~/.config/herdr-app`; spaces can be on
  other machines, and `exec(..., { on })` runs there.
- `herdr-app check <mod>` loads a mod and renders it once. It misses deferred
  rows and later async states, so a screenshot (`herdr-app shot`) is also
  needed.

## What Herdr already ships for the requested features

- `spaces` mod: groups spaces by machine and nests worktree spaces under their
  repo's space, with branch, ahead/behind and uncommitted changes. There is no
  project grouping beyond that.
- `worktree` mod: new, open and remove worktrees under
  `~/.herdr/worktrees/<repo>/<branch>`.
- `changes` mod (`mods/changes/main.js`): staged and unstaged changes against
  `HEAD` only (`git status --porcelain`, `git diff HEAD|--cached --numstat`).
  No diff against `origin/main` or a chosen ref.
- `files` mod: a file tree and read-only viewer.
- `agents()` gives each agent's status (`working`, `blocked`, `done`, `idle`)
  and `terminals()` gives each sub-agent's `parent`.

## Flockbook (minchenlee/flockbook, MIT)

- **Shape:** one mod, `herdr-app/mods/flockbook/`, 22 JS files and 2,873 lines,
  with no agent-specific code. A Rust helper, `flockbook-modfeed`, does all the
  per-agent work (`xplat/flockbook-modfeed/src`, 8,456 lines plus 4,320 lines
  of tests). It is built on a shared crate, `xplat/herdr-core` (11,486 lines),
  which the unreleased iced app also uses. A Swift copy of the helper exists
  for the macOS app; CI checks the two give the same output.
- **Protocol:** `herdr-app/docs/protocol.md` (403 lines). One command per
  helper run, JSON Lines on stdout: a `header` (protocol 1), rows, an `end`.
  `feed` returns a cursor and either `unchanged` or a `splice{at,count}` of
  rows. Row kinds: `user`, `assistant`, `tools`, `perm`, `question`, `status`,
  `sep`, `footer`.
- **Polling:** `feed` every 2 s, `card` at most every 1.5 s while blocked,
  `status` every 5 s (`chat.js`, `cards.js`). It does not use `watchFolder`.
- **Finding the log:** from the agent's process tree, the log file it holds
  open (`ps`/`lsof` on macOS, `/proc` on Linux); Claude through
  `~/.claude/sessions/<pid>.json`; Codex by folder and start time
  (`xplat/herdr-core/src/resolver.rs`, 1,209 lines).
- **Agents:** Claude Code, Codex, Cursor, Grok, pi, Antigravity. Parsers in
  `xplat/herdr-core/src/conversation/` (Claude and Codex 833 lines).
- **Replies:** herdr-core's `terminal.send`, which pastes once nobody has typed
  for about 3 s (`herdr-core/src/hc/client.rs:107`).
- **Approvals and questions:** found from the log plus the screen
  (`terminal.read`), answered with keys. The screen is read again right before
  each key; if the prompt changed, nothing is sent. One answer per prompt is
  recorded as a claim file. Approval keys cover Claude, Grok and Antigravity;
  Codex approvals are not handled from the chat. Question pickers match screens
  captured from Claude Code 2.1.296 and Codex 0.162.1
  (`question/mod.rs`, 1,437 lines), so agent updates can break them.
- **Install:** the helper embeds the layout and mod and writes them with a
  hash ledger (`install.rs`, 452 lines); it refuses to overwrite files it did
  not write and merges `keys.json` without replacing the user's keys.
- **Limits in its RECIPE:** row heights are estimated because `TextView` line
  height is fixed and `list` cannot be scrolled from code; `TextView.markdown`
  draws code and tables square, so the mod draws them itself; Cmd-V needs
  `cx.bind_keys`; there is no compare-and-send in herdr-core.
- **Not checked:** whether Flockbook shows sub-agents or their input requests
  in the chat. The planning session should read the Claude parser for
  `isSidechain` and Task tool handling, and Codex's sub-agent records.

## Shepherdr (eliasstravik/shepherdr, MIT)

- **Chat:** `mods/chat/main.js` (4,275 lines) plus 2,816 lines of chat code in
  `core/` (`chat-log.js` 1,045). It reads the same session logs with shell and
  awk run through `exec`, waits with `watchFolder` locally and polls every
  1.5-4 s remotely, and draws with `TextView.markdown`.
- **Sending:** `core/send.js` runs `hc send`, presses Esc when the agent sits
  in its own dialog, and presses Ctrl-Enter when Claude shows "ctrl+enter to
  send now".
- **Cards:** a Claude Code PermissionRequest hook (`mods/chat/ask-hook.sh`, 82
  lines) writes each request to a file and waits up to 30 min for an answer
  file. Its installer merges that hook into `~/.claude/settings.json`. Codex
  questions are shown read-only and answered in the terminal.
- **Everything else:** tasks in worktrees, review, Autopilot, voice, a Bun
  service on 127.0.0.1:7788 under launchd, and a React web app. 29 mods,
  about 16,500 lines of mod code of its own.
- **Install:** a 1,420-line Python installer with a hash ledger, `.new` copies
  beside edited files, backups, and uninstall.

## herdr-t3 (JinJieBeWater/herdr-t3, Apache-2.0)

- A T3 Code-like layout: an Inbox sidebar by attention, a Lists sidebar of
  spaces and agents, slim tabs, framed panes. About 12,400 lines of JS.
- Development pattern worth copying: `shared/` holds JS that several mods use;
  `scripts/sync.sh` copies it into each mod and rsyncs real copies into
  `~/.config/herdr-app` (its comment: Herdr does not load a mod's SVGs through
  a symlink; not verified on 0.1.13); `scripts/check.sh` runs `herdr-app check`
  on every mod and fails when a shared copy differs.
- `scripts/demo/stage.sh` runs a separate Herdr window with its own core, app
  home and HOME for screenshots, so tests never touch the real one.
- `extras/mods/review` and `pulls-review` are a PR review panel.

## herdr-layout-examples (herdrdev, by the Herdr org)

- Each example mirrors the app home: `layouts/`, `mods/`, `RECIPE.md`,
  `preview.png`, an optional `keys.json`. Share a layout by adding the GitHub
  topic `herdr-layout`.
- `threads/mods/t4-composer/main.js` (61 lines) is the smallest composer: a box
  under the live terminal that runs `hc send` on Enter.

## Effort estimates for a chat view

Excluding tests and assets. These are the research agents' estimates, not
measurements.

| Tier | New code | Effort |
|---|---:|---|
| Terminal with a composer under it | 150-400 lines | hours to 2 days |
| One agent's log as markdown, with a composer | 800-2,000 | several days |
| Own chat UI on Flockbook's helper and cards | 1,500-3,500 | 1 to several weeks |
| Several agents with cards, written from scratch | 10,000+ | weeks to months |

## Open points for the plan

- The Rust toolchain on macbook lacks `cargo`
  (`rustup` reports it is "not applicable to the stable-aarch64-apple-darwin
  toolchain"). Fix that before any Rust build.
- Whether to vendor Flockbook's `herdr-core` crate, depend on it by Git
  revision, or port only the parsers.
- How the helper runs: one process per poll, like Flockbook, or a long-running
  watcher that writes files the mods watch.
- Linear access from a mod: an API key in the helper's config, and how the
  key is stored. Mods can `fetch`, but a key should not live in mod code.
- Sub-agent display and their input requests (see Flockbook, not checked).
