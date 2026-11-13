# Bellwether UI and Cockpit workflow refinement, implementation plan

> **For agentic workers:** Execute this plan wave-by-wave on `feat/refine-ui-flockbook-cockpit`. Steps use checkbox (`- [ ]`) syntax for tracking. Run the scheduled tiered `independent-review` gates at each wave boundary before moving to the next wave.

**Goal:** Deliver a Flockbook-calm shell over flattened Catppuccin Mocha (`#1e1e2e` Base field, `1.12:1` raised, `1.30:1` border, `244 px` docked sidebar with a `6 px` floating peek drawer, `380 px` closed-by-default right inspector, sibling `chat` / `panes` / `needs` / `overview` stack screens), plus the Cockpit workflow quartet (`bw pr`, `bw queue` with 5-gate `Stop`-hook auto-drain, `bw-needs` inline `1-9` triage, and line-anchored diff comments in `bw-diff`) and the skill-native `bw-drafts` inspector (`HTML`, 6-column `decisions.tsv`, plan checklists, and allow-listed `independent-review` `ledger.md`).

**Architecture:** `bw` moves to version `0.8.0` and protocol `8`, adding `bw pr` (run on the window machine via `BW_GH_BIN` with a `60 s` `0600` cache and stale offline fallback), `bw queue` (run on `space.machine` under an OS `FolderLock`, binding `expect_session` via `chat::locate` on `add`, triggered by a detached `bw queue drain --on-stop` child from `bw event` on root `"Stop"` payloads and guarded by five safety gates), and `bw drafts` (run on `space.machine` for worktree and allow-listed `$TMPDIR/*/ledger.md` or registered ledger reads, plus `bw drafts stage` on `on: null` for remote HTML staging). On the window side, `layouts/bellwether.json` mounts `bw-tabs` above a four-screen `stack` (`chat`, `panes`, `needs`, `overview`) with Herdr's native `sidebar-peek` floating drawer (`peek: 6`) and a hidden `right` inspector (`changes`, `issues`, `drafts`, `browser`). Every mod reads live `layout()` directly in `render()`, while `bw-tabs` mirrors `screen.active` into `shared("bw.screen")` and runs explicit keyboard focus handoff (`pane.focus`, `bw-chat.focus`, `bw-needs.focus`).

**Tech Stack:** Rust `1.99.1` (edition 2021); `herdr-core` (vendored); `serde`, `serde_json`, `sha2`, `similar`, `libc`; JavaScript ES modules for Herdr `0.1.13` (`gpui-kit` and `gpui-base`); Bun `1.4.4`; Biome `2.6.4`; TypeScript `7.0.2`; POSIX `sh`; `hc`; `gh` CLI; `/opt/homebrew/bin/cliclick` and Quartz window sizing inside `scripts/verify/stage.sh`.

**Spec:** `docs/specs/2026-11-13-bellwether-ui-cockpit-refinement.md` (status: `design-reviewed`, `2026-11-13`), companion intent record `docs/specs/2026-11-13-bellwether-ui-cockpit-refinement-intent.md`, earlier visual spec `docs/specs/2026-11-07-bellwether-visual-overhaul.md` (where Done Check 3 is amended for badge-only breathing motion), `AGENTS.md`, `REVIEW.md`, `docs/development.md`, `docs/architecture.md`, and `docs/helper.md`.

## Build environment (`macmini`, 2026-11-13)

- Worktree: `/Users/dkishore/.t3/worktrees/bellwether/t3-e31d7d9a-e2f8a6623e36df64` on branch `feat/refine-ui-flockbook-cockpit` from `origin/main` (`ed8020b13676a153a8f528e5d5c6ce894ec81b3b`).
- Toolchain verified on `macmini`: `rustc 1.99.1` (`/opt/homebrew/opt/rustup/bin/cargo`), `bun 1.4.4`, `herdr-app` (`/Users/dkishore/.local/bin/herdr-app`), `gh` (`/opt/homebrew/bin/gh`), and `cliclick` (`/opt/homebrew/bin/cliclick`).
- Live `~/.config/herdr-app` remains untouched throughout Waves 1-4; all GUI, layout, contrast, focus-guard, and motion checks run in `scripts/verify/stage.sh` (`/private/tmp/bw-stage` with `HC_SESSION=bw-stage`).
- Untracked personal review artifacts and screenshots stay in `/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/` (covered by `.gitignore`).

## Global Constraints

- Mods are named `bw-<name>` (`bw-needs`, `bw-overview`, `bw-drafts` join the existing 12 mods, making 15 mods total); shared state keys start with `bw.`.
- Mods call `agents()`, `spaces()`, `panes()`, `terminals()`, `focused()`, and `layout()` only synchronously inside `render()` (or `init()`), never inside `cx.timer`, `cx.spawn`, or `nextCommand()` loops.
- `shared/palette.js` is the sole JavaScript source of hex literals; `bun scripts/gen-theme.js` writes `themes/bellwether.json`, and `scripts/sync.sh --shared-only` syncs shared modules into mod folders. Every new `shared/<name>.js` copied into mods is added to `biome.jsonc` (`!mods/*/<name>.js`).
- Git commands invoked from JS or `bw` carry read-only flags (`--no-optional-locks`, `-c core.fsmonitor=false`, `--no-textconv`).
- PR actions never execute `gh pr merge`; they deliver `/babysit-pr <number>` or `/merge-pr <number>` through `bw send` or `bw queue add` on `space.machine`.
- Code adapted from Flockbook (`minchenlee/flockbook`, MIT, `c9afaf7`) or Cockpit (`quaresc/cockpit`, MIT, `7ae5aa6`) is recorded in `THIRD_PARTY_NOTICES.md` in the same commit.
- Before every commit, run `git diff --cached --stat` and confirm only intended files are staged (`git reset -q` and re-stage if Syncthing dirtied the index).

## Tiered Council Review Schedule (`independent-review`)

Because Gemini 4 Carbon (Google family) authors the implementation, eligible cross-family reviewers come from OpenAI (`GPT-6.1 Sol`, high effort), Anthropic (`Claude Opus 5.5`, high effort), and xAI (`Grok 4.7`, high effort):

1. **Review Gate 1 (after Wave 1, Tasks 1-4): Tier 2 Deep Review on Rust helper (`bw` 0.8.0).** Wave 1 introduces OS file locks (`FolderLock`), detached `Stop`-hook process spawning, session-bound message delivery (`bw queue`), and external `$TMPDIR` file reads (`bw drafts`). Launch two cross-family finders in parallel via T3 `delegate_task`: `GPT-6.1 Sol` (Correctness and Concurrency lens) and `Claude Opus 5.5` (Boundaries, Security, and Multi-Machine lens). Ground all citations, verify every P0-P2 finding with the opposite family (`Opus` <-> `Sol`), register `ledger.md` via `bw drafts register-ledger`, and fix all confirmed/plausible findings before Wave 2.
2. **Review Gate 2 (after Wave 2, Tasks 5-8): Tier 1 Review on Shell, Focus Handoff, Palette, and Stack `bw-chat`.** Launch a fast single cross-family finder (`GPT-6.1 Sol`, full scope on Wave 2 commits) with `Claude Opus 5.5` verification for any findings, checking focus-guard timing, multi-agent `bw.chat-agent` routing, `bw.screen` poll cadence (`2 s` / `10 s`), and Mocha AA contrast before building Wave 3 views.
3. **Review Gate 3 (after Wave 3 and Stage Verification, Tasks 9-12): Tier 3 Full Council Review on `origin/main..HEAD`.** Launch all three eligible council seats (`GPT-6.1 Sol`, `Claude Opus 5.5`, and `Grok 4.7`), ground citations, run cross-family verifiers, reconcile the session's `ledger.md`, fix every confirmed/plausible finding, and re-run `scripts/test.sh --offline` plus stage checks before refreshing the HTML feature summary page.

## Review Focus

1. Queue misrouting or premature auto-drain: `bw queue add` without `--session` followed by `/clear` or `/new` must hold (`session_changed`); a pending `PermissionRequest` / `AskUserQuestion` card or a root assistant message ending in `?` outside fenced code must hold (`assistant_question`); an interrupted or errored turn must hold (`interrupted_or_error`); concurrent `Stop` hook + `bw-chat` fallback drains must deliver item 0 at most once under `FolderLock`.
2. Multi-agent tab targeting and focus safety: `Open chat` from `bw-needs` and `bw-overview` must pin `shared("bw.chat-agent")` and focus that agent; switching `panes -> chat` via `⌘J` must record `TERMINAL_FOCUS` `leftAt` immediately so the 3 s answer guard holds; pressing `1-9` in `bw-needs` or `bw-chat` must never leak keys to a hidden terminal.
3. Solo-repo PR merge readiness and remote parity: `Merge PR` and `Ready to land` must light up when `reviewDecision` is `"APPROVED"`, `""`, or `null` (with open, non-draft, 0 failing/pending checks, 0 unresolved threads, and matching `headRefOid`), `bw pr` must run on `on: null` with stale offline fallback, and PR buttons must never call `gh pr merge`.
4. Unselected-file diff anchors and `bw drafts` containment: `bw-diff` batch send must preflight `bw diff patch` across every commented file (including files no longer selected) and hold if any excerpt shifted `> 5` lines; `bw drafts read` must allow only canonical `<worktree>` entries and allow-listed `ledger.md` files, rejecting sibling raw review transcripts and symlink escapes.

---

## Wave 1: Rust Helper `0.8.0` (`protocol 8`) - `bw pr`, `bw queue`, and `bw drafts`

### Task 1: Bump helper version to `0.8.0` and protocol to `8`

**Files:**
- Modify: `crates/bw/Cargo.toml`, `Cargo.lock`, `crates/bw/src/version.rs`
- Modify: `shared/helper.js` (and sync into `mods/bw-*/helper.js` via `scripts/sync.sh --shared-only`)
- Modify: `crates/bw/tests/version.rs`, `crates/bw/tests/install.rs`, `shared/helper.test.js`, `tests/mods/bw-chat-dock.test.js`, `tests/mods/bw-chat-threads.test.js`, `tests/fixtures/live/browser-panel.json`, `tests/fixtures/live/chat-remote.json`, `tests/fixtures/live/chat-requests.json`, `tests/fixtures/live/chat-tab.json`, `scripts/verify/sessions-run.js`
- Modify: `README.md`, `RECIPE.md`, `docs/architecture.md`, `docs/development.md`, `docs/helper.md`

- [ ] **Step 1: Update `PROTOCOL = 8` and `HELPER_VERSION = "0.8.0"` across Rust, JS, fixtures, and docs.**
  Run `git grep -l -F -e '0.7.0' -e 'PROTOCOL: u32' -e 'protocol":7' -e 'protocol: 7' -e 'protocol"], 7' -- ':!tests/fixtures/sessions' ':!docs/research/*'` to ensure zero stale `0.7.0` / `protocol 7` assertions remain.
- [ ] **Step 2: Refresh `Cargo.lock` and sync shared JS copies.**
  Run `cargo build -p bw` (updating `Cargo.lock` cleanly so `--locked` passes) and `scripts/sync.sh --shared-only`.
- [ ] **Step 3: Verify version and install tests.**
  Run `cargo test -p bw --test version --test install --locked && bun test shared/helper.test.js tests/mods/bw-chat-dock.test.js tests/mods/bw-chat-threads.test.js`.
- [ ] **Step 4: Commit Task 1.**
  Verify `git diff --cached --stat` and commit `build(bw): bump helper to 0.8.0 and protocol 8`.

### Task 2: Implement `bw pr` cached GitHub PR/CI/thread status (`crates/bw/src/pr/`)

**Files:**
- Create: `crates/bw/src/pr/mod.rs`
- Modify: `crates/bw/src/main.rs`, `docs/helper.md`
- Create: `scripts/verify/pr.sh`

- [ ] **Step 1: Write unit and integration tests first for `bw pr status`.**
  Cover repo slug validation (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`), flag-like branch rejection (`--evil`), cache key `sha256(repo + "\0" + branch)`, `0600` file / `0700` folder permissions, `60 s` TTL, cache bypass on `--refresh` or changed `--head`, GraphQL rollup parsing (`StatusContext` and `CheckRun` states into `passing`, `failing`, `pending`, plus `reviewThreads` unresolved count and `reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | null`), and offline/unauthenticated/`no_gh` fallback returning `"stale": true` when cached or typed `{"type":"error"}` when uncached.
- [ ] **Step 2: Implement `crates/bw/src/pr/mod.rs` and wire `Some("pr") => pr::run(&args[1..])` in `main.rs`.**
  Execute `BW_GH_BIN` (default `"gh"`) with argv (never shell string) and a `10 s` process timeout (`WaitTimeout` loop polling `try_wait` so hung `gh` calls are killed cleanly).
- [ ] **Step 3: Create `scripts/verify/pr.sh` (`--offline` + live `gh` mode).**
  Exercise `BW_GH_BIN` fake GraphQL fixtures for `APPROVED`, `null` reviewDecision ready-to-land, `CHANGES_REQUESTED`, failing checks, draft PR, non-GitHub error, and offline stale cache, plus a real `gh` query on `macmini` when run without `--offline`.
- [ ] **Step 4: Verify and commit Task 2.**
  Run `cargo test -p bw --locked && sh scripts/verify/pr.sh --offline && sh scripts/verify/pr.sh`, check `git diff --cached --stat`, and commit `feat(bw): add cached bw pr status command`.

### Task 3: Implement `bw queue` and `Stop`-hook 5-gate auto-drain (`crates/bw/src/queue/`, `crates/bw/src/events/mod.rs`)

**Files:**
- Create: `crates/bw/src/queue/mod.rs`, `crates/bw/src/queue/store.rs`, `crates/bw/src/queue/drain.rs`
- Modify: `crates/bw/src/requests/claims.rs` (make `FolderLock` reusable across `bw` modules via `pub(crate)`), `crates/bw/src/events/mod.rs`, `crates/bw/src/chat/locate.rs` / `crates/bw/src/chat/tail.rs` (expose helpers needed for Gate 4 and Gate 5), `crates/bw/src/main.rs`, `docs/helper.md`
- Create: `scripts/verify/queue.sh`

- [ ] **Step 1: Add `"Stop"` to `EVENTS` in `crates/bw/src/events/mod.rs` and `#[serde(default)] pub stop_hook_active: bool` on `Event`.**
  When `record()` writes a root `"Stop"` event (`e.agent_id.is_none()`) and `queue::has_runnable(&e.core, &e.terminal)` is true, spawn `std::env::current_exe()` with `["queue", "drain", "--terminal", &e.terminal, "--on-stop", &e.id]` and `Stdio::null()` for stdin/stdout/stderr so `bw event` exits `0` immediately. Update `crates/bw/tests/hooks.rs` if it pins `EVENTS` length.
- [ ] **Step 2: Implement `crates/bw/src/queue/store.rs` (`list`, `add`, `edit`, `move`, `remove`, `clear`, `resume`).**
  Serialize all reads/writes per `<core>/<terminal>` with `FolderLock` (`0700` dir, `0600` JSON temp-and-rename), cap at `20` items and `64 KiB` per item, and run `chat::locate` inside `bw queue add` to bind `expect_session` to the live session (storing `expect_session: None, unverified_startup: true, agent_pid` only when the agent process is starting up without a transcript yet, and rejecting mismatched explicit `--session`).
- [ ] **Step 3: Implement `crates/bw/src/queue/drain.rs` with settle polling and the 5 safety gates.**
  When `--on-stop` is passed, poll `hc::hc_get` every `250 ms` up to `BW_QUEUE_SETTLE_MAX_MS` (default `65_000 ms`) until terminal status leaves `"working"`. Acquire `FolderLock` and verify:
  - Gate 1: `!queue.held && !queue.items.is_empty()` and `last_drain_event.as_deref() != on_stop`.
  - Gate 2: `hc_get` terminal status is `"done"` or `"idle"`.
  - Gate 3: `requests::cards` has zero pending requests across root and running sub-agents and status is not `"blocked"` (if pending, leave unpopped and unheld so answering later allows future drain).
  - Gate 4: inspect the latest root session turn; if interrupted (`[Request interrupted by user` or `turn_aborted`) or errored, set `held = true, hold_reason = Some("interrupted_or_error")` and keep item 0; if the root assistant's final non-empty paragraph or line outside fenced code blocks ends with `?`, set `held = true, hold_reason = Some("assistant_question")` and keep item 0.
  - Gate 5: `chat::locate` matches `expect_kind`; if `expect_session` is `Some(s)`, live `session_id` must equal `s`; if `None` (`unverified_startup`), require matching `agent_pid` and at most the initial startup turn with zero `/clear` or `/new` resets; otherwise set `held = true, hold_reason = Some("session_changed")`.
  Call `chat::send` (never `--force`). Pop item 0 only on `"sent"`; on send failure, keep item 0 and set `held = true` with the failure code.
- [ ] **Step 4: Create `scripts/verify/queue.sh` (`--offline`) covering Done Check 4(a)-(d).**
  Test `Stop` settle delay (`1.2 s` simulated sibling hook), pending request card hold, trailing prose `?` hold (`assistant_question`), interrupted turn hold (`interrupted_or_error`), omitted `--session` + `/clear` replacement hold (`session_changed`), `bw queue resume`, and concurrent `drain` single-delivery under `FolderLock`.
- [ ] **Step 5: Verify and commit Task 3.**
  Run `cargo test --workspace --locked && sh scripts/verify/queue.sh --offline`, check `git diff --cached --stat`, and commit `feat(bw): add bw queue with 5-gate Stop auto-drain`.

### Task 4: Implement `bw drafts` worktree, external ledger, and remote HTML staging (`crates/bw/src/drafts/`)

**Files:**
- Create: `crates/bw/src/drafts/mod.rs`
- Modify: `crates/bw/src/main.rs`, `docs/helper.md`
- Create: `scripts/verify/drafts.sh`

- [ ] **Step 1: Write unit tests for `bw drafts list`, `read`, `register-ledger`, and `stage`.**
  Test recursive discovery under `docs/drafts`, `docs/plans`, `docs/superpowers`, `.audit` (including `.audit/*.tsv` classified as `decisions`), root `decisions.tsv` and `tasks.md`, symlink-escape rejection, `node_modules`/`.git` skipping, 200-file cap, 512 KiB read cap, `register-ledger` pointer storage under `~/.local/state/bellwether/reviews/<sha256(canonical_worktree)>/<id>.json`, `$TMPDIR/*/ledger.md` and `/private/tmp/*/ledger.md` discovery matching canonical `<worktree>`, strict refusal to read sibling files like `report-sol.txt` or `transcript.jsonl` in `$TMPDIR`, and 32-entry LRU pruning in `bw drafts stage`.
- [ ] **Step 2: Implement `crates/bw/src/drafts/mod.rs` and wire `Some("drafts") => drafts::run(&args[1..])` in `main.rs`.**
  Support both stdin piping and `--machine <m> --path <worktree> --file <id>` (`hc_exec` relay via `machine::RUN_HELPER`) in `bw drafts stage --name <slug.html>`.
- [ ] **Step 3: Create `scripts/verify/drafts.sh` (`--offline`).**
  Verify nested HTML, 6-column `decisions.tsv` written by `log.sh`, `.audit/run.tsv`, root `tasks.md`, external `mktemp -d` `ledger.md`, path-traversal / sibling-transcript rejection, and `bw drafts stage`.
- [ ] **Step 4: Verify and commit Task 4.**
  Run `cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked && sh scripts/verify/drafts.sh --offline`, check `git diff --cached --stat`, and commit `feat(bw): add bw drafts inspector and external ledger discovery`.

### Review Gate 1: Tier 2 Deep Review on Wave 1 (`crates/bw/`, `scripts/verify/{pr,queue,drafts}.sh`)

- [ ] **Step 5: Run Tier 2 Deep `independent-review` (`GPT-6.1 Sol` + `Claude Opus 5.5`).**
  Pin `HEAD`, launch `Sol` (Correctness & Concurrency lens) and `Opus` (Boundaries, Security & Multi-Machine lens) via T3 `delegate_task`, ground citations, verify all findings cross-family, register the run's `ledger.md` with `bw drafts register-ledger`, fix all confirmed/plausible findings, and re-run `cargo test --workspace --locked` + `pr.sh` / `queue.sh` / `drafts.sh`.

---

## Wave 2: Flattened Mocha Palette, Calm Shell, `bw-tabs`, and Stack `bw-chat`

### Task 5: Flatten Catppuccin Mocha palette, neutral monograms, badge-only motion, and Flockbook sidebar rows

**Files:**
- Modify: `shared/palette.js`, `themes/bellwether.json` (via `bun scripts/gen-theme.js`), `shared/ui.js`, `scripts/verify/contrast.js`
- Modify: `tests/theme.test.js`, `tests/ui.test.js`
- Modify: `mods/bw-projects/main.js`, `mods/bw-projects/rows.js`, `mods/bw-status/main.js`, `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Update `shared/palette.js` and regenerate `themes/bellwether.json`.**
  Set `canvas: M.base`, `surface: M.base`, `chrome: M.mantle`, `popover: M.mantle`, `raised: mix(M.surface0, M.base, 0.45)` (`#272738`), `border: M.surface0` (`#313244`), `input: M.overlay1` (`#7f849c`), `selected: mix(M.surface1, M.base, 0.55)` (`#333546`), `hover: alpha(M.text, 0.07)` (`#cdd6f412`), `MUTED_ON_SELECTED = M.subtext0` (`5.43:1` on `#333546`, keeping `M.subtext1` available where needed). Run `bun scripts/gen-theme.js`.
- [ ] **Step 2: Update `shared/ui.js` and `scripts/verify/contrast.js`.**
  Switch `monogram()` to neutral `20 px` rounded squares (`bg(t.raised)`, `border(1)`, `border_color(t.border)`, `text_color(t.muted)`, `rounded(6)`). Remove `.loop("opacity", MOTION.breathe)` from `glyph()` for `status === "blocked"` so row, tab, pane, chip, and banner blocked marks are static `Peach`; add a dedicated `needsCountPill(t, count, active, onClick)` helper (or top-bar pill) that is the sole element carrying `.loop("opacity", MOTION.breathe)`. Update `scripts/verify/contrast.js` for all flattened fills (`#1e1e2e`, `#181825`, `#272738`, `#333546`, `Overlay 1` `#7f849c` `3.96:1` on `raised`, `Text` `8.35:1` and `Subtext 0` `5.43:1` on `selected`, and breathing `Needs you` pill at `0.65` opacity).
- [ ] **Step 3: Update `mods/bw-projects/` for flat 2-tier Flockbook rows and `props: { peek: true }` floating drawer mode.**
  When `props()?.peek === true`: if `!find(layout(), "sidebar")?.hidden`, render an empty `div()` so Herdr hides the floating frame; when `sidebar.hidden` is `true`, render the `244 px` vertical project/agent tree cleanly inside the floating drawer without mutating layout on hover. Record any Flockbook row styling adaptation in `THIRD_PARTY_NOTICES.md`.
- [ ] **Step 4: Sync shared copies and verify palette/UI tests.**
  Run `scripts/sync.sh --shared-only && bun scripts/verify/contrast.js && bun test tests/theme.test.js tests/ui.test.js tests/mods/bw-projects*.test.js`. Commit `feat(ui): flatten Catppuccin Mocha steps and Flockbook sidebar rows`.

### Task 6: Shell layout, keybindings, stack `bw-tabs` coordinator, focus handoff, and `bw-new` migration

**Files:**
- Modify: `layouts/bellwether.json`, `layouts/bellwether.svg`, `keys/bellwether.json`
- Modify: `shared/chat-tabs.js`, `shared/chat-tabs.test.js`
- Modify: `mods/bw-tabs/main.js`, `mods/bw-tabs/model.js`, `mods/bw-tabs/.shared`
- Modify: `mods/bw-new/main.js`, `mods/bw-new/entries.js`, `mods/bw-pane/main.js`
- Modify: `tests/layout.test.js`, `tests/keys-merge.test.js`, `tests/mods/bw-tabs*.test.js`, `tests/mods/bw-new*.test.js`

- [ ] **Step 1: Rewrite `layouts/bellwether.json`, `layouts/bellwether.svg`, and `keys/bellwether.json`.**
  Configure `sidebar` (`244 px`, `min: 200`, `max: 420`, `projects` + `40 px` `workspace-chrome`), `work` (`background: "surface"`, `48 px` `tabs` + `screen` stack `["chat", "panes", "needs", "overview"]` with `floating: [{ id: "sidebar-peek", content: { mod: "bw-projects", props: { peek: true } }, edge: "left", align: "start", peek: 6 }]`, `panes.pane.lone = false`, `panes.pane.header = { content: { mod: "bw-pane" }, height: 28, position: "top", reveal: "hover" }`, zero `status` block), and `right` (`hidden: true`, `size: { px: 380 }`, `min: 280`, `max: 620`, `right-body` stack `["changes", "issues", "drafts", "browser"]`, temporarily keeping a placeholder for `drafts` until Task 11 or adding `mods/bw-drafts` skeleton so `herdr-app check` passes at every commit). Bind `cmd-b`, `cmd-j`, `cmd-shift-'`, `cmd-shift-n`, `cmd-shift-o`, and `cmd-alt-b` in `keys/bellwether.json`.
- [ ] **Step 2: Update `shared/chat-tabs.js` and `mods/bw-new/` for frameless stack chat tabs and legacy split cleanup.**
  `"New chat"` creates a single-pane agent tab in `bw.chat-tabs` (no `pane.split` or `pane.zoom`); `"New terminal"` sets `bw.tab-view[tabId] = "panes"`. Legacy pre-upgrade split tabs carrying `mod === "bw-chat"` unzoom and close only the `bw-chat` pane during `adopt()`. Update `focusRecord()` so `screenActive !== "panes"` passes `focusedTerminal = null`, recording `leftAt` immediately when leaving `"panes"`.
- [ ] **Step 3: Upgrade `mods/bw-tabs/` with the two `36 px` floating capsules, `bw.screen` mirroring, `Needs you` count pill, and explicit focus handoff.**
  Mirror `screen.active` one-way into `shared("bw.screen")`; deduplicate `layout.select` with `this.askedScreen`; handle `chat-flip` (`⌘J`), `terminal-peek` (`⌘⇧'`), `needs-toggle` (`⌘⇧N`), and `overview-toggle` (`⌘⇧O`); run `pane.focus`, `bw-chat.focus`, or `bw-needs.focus` on screen transitions; scale macOS traffic-light clearance (`78 * (settings().zoom ?? 1)`) when `sidebar.hidden` is true; and aggregate blocked/PR attention counts for the breathing `Needs you` pill without polling live functions in timers.
- [ ] **Step 4: Sync and verify layout, keybindings, `bw-tabs`, and `bw-new` tests.**
  Run `scripts/sync.sh --shared-only && bun test shared/chat-tabs.test.js tests/layout.test.js tests/keys-merge.test.js tests/mods/bw-tabs*.test.js tests/mods/bw-new*.test.js && scripts/check.sh`. Commit `feat(shell): switch layout and bw-tabs to frameless four-screen stack`.

### Task 7: Add GitHub remote parsing and shared PR/skill helpers (`shared/git-parse.js`, `shared/git.js`, `shared/pr-model.js`)

**Files:**
- Modify: `shared/git-parse.js`, `shared/git-parse.test.js`, `shared/git.js`, `shared/git.test.js`
- Create: `shared/pr-model.js`, `shared/pr-model.test.js`
- Modify: `biome.jsonc` (add `!mods/*/pr-model.js`)

- [ ] **Step 1: Add `parseGithubRepo(remoteUrl)` in `shared/git-parse.js` and `remoteOrigin` + `headOid` read-only git reads in `shared/git.js`.**
  Support `git@github.com:owner/repo(.git)`, `https://github.com/owner/repo(.git)`, and `ssh://git@github.com/owner/repo(.git)`, returning `null` for non-GitHub hosts.
- [ ] **Step 2: Create `shared/pr-model.js` with pure predicates and skill command builders.**
  Export `isMergeReady(pr, headOid)` (open, non-draft, `failing === 0`, `pending === 0`, `unresolvedThreads === 0`, `headRefOid` matches `headOid` when non-null, and `reviewDecision` in `["APPROVED", "", null]`), `prNeedsAttention(pr)` (`failing > 0` or `unresolvedThreads > 0` or `reviewDecision === "CHANGES_REQUESTED"`), `babysitCommand(number)` (`"/babysit-pr <n>"`), and `mergeCommand(number)` (`"/merge-pr <n>"`).
- [ ] **Step 3: Sync and verify unit tests.**
  Run `scripts/sync.sh --shared-only && bun test shared/git-parse.test.js shared/git.test.js shared/pr-model.test.js`. Commit `feat(shared): add GitHub remote parser and PR skill model`.

### Task 8: Upgrade `mods/bw-chat/` for 24-session stack mode, multi-agent pinning, PR chip, and queue drawer

**Files:**
- Modify: `mods/bw-chat/main.js`, `mods/bw-chat/target.js`, `mods/bw-chat/composer.js`, `mods/bw-chat/timeline.js`, `mods/bw-chat/.shared`
- Create: `mods/bw-chat/sessions.js`, `mods/bw-chat/context-strip.js`
- Modify: `tests/mods/bw-chat*.test.js`

- [ ] **Step 1: Implement `mods/bw-chat/sessions.js` (`SessionMap` up to 24 terminal addresses).**
  Support both `props().terminal` (per-pane harness mode) and empty `props()` (layout stack mode). Never evict an entry holding non-empty composer text or attached Linear chips. Resolve the active tab's target agent in priority order: `shared("bw.chat-agent")?.[tabId]` (if live in tab) -> focused Claude/Codex pane in tab -> first Claude/Codex pane in tab. Handle `nextCommand()` `"focus"` (`bw-chat.focus`) to focus the active question dock or composer.
- [ ] **Step 2: Update `bw-chat` poll cadence, `focus-guard`, header removal, and `Open in Changes` right-inspector reveal.**
  In stack mode, drop the `36 px` top bar; check `(shared("bw.screen") ?? "chat") === "chat"` inside the background poll loop so switching to `panes`/`needs`/`overview` drops `bw feed` from `2 s` to `10 s` immediately; ensure `TERMINAL_FOCUS` enforces the `3 s` cooldown after `panes -> chat`; remove `.loop("opacity")` from waiting banners (`F13`); and call `run("layout.show", { id: "right" })` whenever `Open in Changes` is clicked.
- [ ] **Step 3: Add `mods/bw-chat/context-strip.js` (multi-agent switcher pill, 1-line PR chip, and queue drawer + composer `Enter` enqueue).**
  While the target agent's live status is `"working"`, composer `Enter` enqueues via `bw queue add` (`Queue` primary button; `⇧⌘Enter` sends immediately). Render inline edit, move up/down, delete, `Resume` (when `held`), and `Send now` controls on queued items. Trigger one lock-serialized fallback `bw queue drain --terminal <t>` when active terminal status transitions `working -> done|idle` with `items.length > 0 && !held`. Render the PR chip (`Open PR` via `bw browser new`, `Babysit PR`, and `Merge PR` via `/babysit-pr` and `/merge-pr` routed to `bw send` when idle/done or `bw queue add` when working).
- [ ] **Step 4: Sync and verify `bw-chat` harness tests.**
  Add tests for stack-mode session switching, multi-agent `bw.chat-agent` switcher, `bw.screen` `2 s` / `10 s` cadence, composer `Enter` queueing while working, PR `null`-reviewDecision `Merge PR` button, and `Open in Changes` showing `right`. Run `scripts/sync.sh --shared-only && bun test tests/mods/bw-chat*.test.js && scripts/check.sh`. Commit `feat(bw-chat): add stack session LRU, queue drawer, and PR skill strip`.

### Review Gate 2: Tier 1 Focused Review on Wave 2 (`shared/`, `layouts/`, `keys/`, `mods/bw-{tabs,new,projects,chat}/`)

- [ ] **Step 5: Run Tier 1 `independent-review` (`GPT-6.1 Sol` + `Claude Opus 5.5` verifier).**
  Verify Wave 2 commits against the spec and `REVIEW.md` (focusing on `TERMINAL_FOCUS` 3 s guard, `bw.chat-agent` multi-agent routing, zero live polling, and Mocha AA contrast), reconcile `ledger.md`, and fix any confirmed/plausible issues before Wave 3.

---

## Wave 3: Cockpit Views & Skill Sidecar (`bw-needs`, `bw-overview`, `bw-diff`, `bw-drafts`, `bw-right`)

### Task 9: Build `mods/bw-needs/` (`Needs you` / `Whose move`) and `mods/bw-overview/`

**Files:**
- Create: `mods/bw-needs/mod.json`, `mods/bw-needs/.shared`, `mods/bw-needs/main.js`, `mods/bw-needs/model.js`
- Create: `mods/bw-overview/mod.json`, `mods/bw-overview/.shared`, `mods/bw-overview/main.js`
- Create: `shared/dock-model.js` / `shared/dock.js` or share request-card helpers cleanly via `shared/` (added to `biome.jsonc`) so `bw-chat` and `bw-needs` render identical `1-9` + `Other...` cards with `focus-guard.js`
- Create: `tests/mods/bw-needs.test.js`, `tests/mods/bw-overview.test.js`

- [ ] **Step 1: Extract or share `focus-guard.js` and request-card helpers via `shared/` (updating `biome.jsonc` and `.shared`) if needed by both `bw-chat` and `bw-needs`.**
- [ ] **Step 2: Implement `mods/bw-needs/` two-column triage surface.**
  Left `300 px` list groups all spaces/agents into `Needs you`, `Ready to land`, `Working`, and `Idle`. Right `680 px` detail column renders `answerable` cards with inline `1-9` shortcuts, `Other...` input, 3 s `focus-guard`, and `bw answer` on `space.machine`; renders `"Waiting in terminal"` + `"Open terminal"` (zero fabricated answer buttons) when `status === "blocked"` without a session card; and renders PR check/thread summary + `Open PR` / `Babysit PR` / `Merge PR` for PR-driven rows. `Open chat` and double-click write `shared("bw.chat-agent")` and run `agent.focus` before selecting the space/tab and `screen = "chat"`. Handle `bw-needs.focus` command to focus its root `FocusHandle`.
- [ ] **Step 3: Implement `mods/bw-overview/` cross-space fleet grid.**
  Render neutral monograms, machine tags, branch + PR badges, and agent rows with one-click pinned jump to `chat` or `panes`.
- [ ] **Step 4: Sync and verify `bw-needs` and `bw-overview` tests.**
  Run `scripts/sync.sh --shared-only && bun test tests/mods/bw-needs.test.js tests/mods/bw-overview.test.js && scripts/check.sh`. Commit `feat(mods): add bw-needs inline triage and bw-overview fleet screens`.

### Task 10: Add scope pills, line-anchored comments, and unselected-file preflight to `mods/bw-diff/`

**Files:**
- Modify: `mods/bw-diff/main.js`, `mods/bw-diff/model.js`, `mods/bw-diff/patch.js`, `mods/bw-diff/.shared`
- Create: `mods/bw-diff/comments.js`
- Modify: `THIRD_PARTY_NOTICES.md`, `tests/mods/bw-diff.test.js`

- [ ] **Step 1: Add `Uncommitted`, `Branch`, and `PR` scope pills in `mods/bw-diff/`.**
  `PR` scope reads the open PR's `baseRefName` from `bw pr status` and diffs against `<remote>/<baseRefName>`, falling back to the `Branch` base picker when no open PR exists.
- [ ] **Step 2: Key virtual rows by `{patchDigest}:{kind}:{oldLine}:{newLine}` and wire `.on_item_click` on `v_virtual_list`.**
  Keep zero event handlers inside `v_virtual_list`'s row closure (`REVIEW.md` / Done Check 5). Verify `patchDigest === this.patch.digest` on click, highlight selected/commented rows, and mount a single retained `InputState` composer bar **below** `v_virtual_list` (`Enter` / `Save` saves, `Esc` cancels).
- [ ] **Step 3: Implement `mods/bw-diff/comments.js` stale-anchor revalidation (`±5` lines) and multi-file preflight check.**
  Revalidate comments whenever a file's `patchDigest` changes. On `Send N comments` / `Queue N comments`, run a preflight `bw diff patch` check across every distinct commented `{ path, section, base }` (including files not currently selected); if any comment becomes `stale: true`, abort delivery with a clear notice and keep all drafts. Otherwise format the `path:line (side)` + quoted excerpt markdown block, send via `bw send` or `bw queue add` on `space.machine`, and clear drafts only on `sent` / `queued`. Attribute Cockpit (`quaresc/cockpit`, MIT, `7ae5aa6`) in `THIRD_PARTY_NOTICES.md`.
- [ ] **Step 4: Sync and verify `bw-diff` tests (including Done Check 5(c) unselected-file mutation test).**
  Run `scripts/sync.sh --shared-only && bun test tests/mods/bw-diff.test.js && scripts/check.sh`. Commit `feat(bw-diff): add scope pills, line comments, and preflight anchor check`.

### Task 11: Build `mods/bw-drafts/` and 4-tab `mods/bw-right/` (`Changes`, `Issues`, `Drafts`, `Browser`)

**Files:**
- Modify: `mods/bw-right/choice.js`, `mods/bw-right/main.js`, `tests/mods/bw-right.test.js`
- Create: `mods/bw-drafts/mod.json`, `mods/bw-drafts/.shared`, `mods/bw-drafts/main.js`, `mods/bw-drafts/model.js`
- Create: `tests/mods/bw-drafts.test.js`
- Modify: `docs/usage.md`, `docs/architecture.md`

- [ ] **Step 1: Update `mods/bw-right/` to four segments (`Changes`, `Issues`, `Drafts`, `Browser`) plus a right-aligned `×` hide button (`layout.hide { id: "right" }`).**
- [ ] **Step 2: Implement `mods/bw-drafts/` (`HTML`, 6-column `decisions.tsv` / `.audit/*.tsv`, plan checklists, and `ledger.md`).**
  Poll `bw drafts list` via `refresh-driver.js` only while `right` is visible and `right-body.active === "drafts"`. Render:
  - HTML rows with `Open in Browser` (`bw browser new` with local `file://` URL on `machine === null`, or `bw drafts stage --machine` on `on: null` followed by `bw browser new` for remote spaces).
  - Header-parsed `decisions.tsv` and `.audit/*.tsv` rows displaying `ts`, `phase` pill, `decision`, `why`, compact `evidence` path, and `result` pill.
  - Plan/task markdown (`docs/plans/*.md`, `tasks.md`) with `- [x]` / `- [ ]` progress bar/count and checklist items, plus `TextView.markdown` for `ledger.md` and notes.
- [ ] **Step 3: Update `docs/usage.md` and `docs/architecture.md`, sync, and verify tests.**
  Run `scripts/sync.sh --shared-only && bun test tests/mods/bw-right.test.js tests/mods/bw-drafts.test.js && scripts/check.sh`. Commit `feat(bw-drafts): add Drafts and Audit sidecar tab in bw-right`.

---

## Wave 4: Full Suite, Stage Window Verification, Tier 3 Council Review, and HTML Summary Refresh

### Task 12: Execute Done Checks 1-6 (`scripts/test.sh --offline` + `scripts/verify/stage.sh`) and Tier 3 Council Review

**Files:**
- Create: `scripts/verify/ui-stage.sh` (reproducible stage-window verification helper driving `stage.sh`, Quartz `934x980` and `1440x980` bounds, `cliclick m:3,300`, pixel sampling, 10-shot idle stillness, `Needs you` badge-only motion box check, `BW_HELPER` `2 s` / `10 s` cadence check, and `3 s` focus-guard check)
- Save untracked shots to: `/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/shots/`

- [ ] **Step 1: Run the full offline suite (`scripts/test.sh --offline`) and install the `0.8.0` helper locally (`scripts/install-helper.sh`) if needed by stage.**
  Confirm zero warnings across `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, vendored `herdr-core` tests, `bunx biome ci --error-on-warnings .`, `bunx tsc -p types`, `bun test`, `herdr-app check` on all 15 mods, single-hex-source `grep`, `contrast.js`, and all `scripts/verify/*.sh --offline` scripts.
- [ ] **Step 2: Run live stage-window verification (`scripts/verify/stage.sh` + `ui-stage.sh`) at `934x980` (OmniWM half-tile) and `1440x980`.**
  Capture and visually inspect screenshots (`view_file`) of `chat` (`934 px` and `1440 px`), `panes` (`⌘J` > 650 px width), `⌘B` hidden-sidebar `6 px` floating peek drawer (`cliclick m:3,300`) over both `chat` and `panes`, `needs`, `overview`, `bw-diff` with line comments, and `bw-drafts` showing `bellwether-ui-cockpit-refinement.html`, `decisions.tsv`, `tasks.md`, and the registered `ledger.md`. Always run `stage.sh down` cleanly afterward and confirm `~/.config/herdr-app` is untouched.
- [ ] **Step 3: Run Review Gate 3 - Tier 3 Full Council `independent-review` (`GPT-6.1 Sol`, `Claude Opus 5.5`, `Grok 4.7`) on `origin/main..HEAD`.**
  Ground all citations, verify every finding cross-family, reconcile `ledger.md` (and register it via `bw drafts register-ledger`), fix every confirmed or plausible finding, and re-run `scripts/test.sh --offline` plus stage checks to green.

### Task 13: Refresh feature summary HTML artifact with live stage screenshots and final review scores

**Files:**
- Modify: `/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/build-page.py`, `/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/bellwether-ui-cockpit-refinement.html`, `/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/bellwether-ui-cockpit-inline.html`

- [ ] **Step 1: Update `bellwether-ui-cockpit-refinement.html` to `Implementation · 6 of 6 done checks passing`, embed real stage screenshots alongside Flockbook comparison notes, and record all review score lines (`Tier 2 design`, `Tier 2 Wave 1`, `Tier 1 Wave 2`, `Tier 3 Council`).**
- [ ] **Step 2: Run `check.py`, `audit.ts` (4 viewports), `html_preview` (`728 px` dark + `390 px` light), and `html_render` before final handoff.**
