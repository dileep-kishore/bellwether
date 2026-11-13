# Bellwether UI and Cockpit workflow refinement

Status: design-reviewed (2026-11-13). Intent record: `2026-11-13-bellwether-ui-cockpit-refinement-intent.md`.

## Why

Bellwether's Phase 7 visual overhaul (`2026-11-07-bellwether-visual-overhaul.md`) added Catppuccin
Mocha colors, rounded cards, and motion, yet the live window still feels crowded and boxed in next
to Flockbook (`minchenlee/flockbook`). In a 934 px OmniWM half-tile, keeping both the 248 px left
sidebar and 360 px right column open leaves 308 px for chat, stacks three header bars above the
conversation, paints three distinct window tones (`#11111b`, `#181825`, `#1e1e2e`) separated by
1.80:1 borders, and squeezes split terminal panes to 15 columns.

At the same time, Cockpit (`quaresc/cockpit`) demonstrates four workflow capabilities that pair
directly with Bellwether's `bw` helper and the user's daily skills: cross-agent inline triage,
cached GitHub PR/CI/thread badges, per-terminal prompt queuing, and line-anchored diff review
comments, alongside a read-only inspector for HTML artifacts, decision trails, and review ledgers.

## Goals

1. **Flockbook-grade calm shell and geometry**: dock a 244 px Flockbook-row sidebar (`⌘B` hides it to
   a 6 px left-edge floating peek drawer), close the right inspector (`380 px`) until requested, remove
   the bottom status bar from the layout, and make `chat` a frameless central stack screen over a
   single `#1e1e2e` Base field.
2. **Flattened Catppuccin Mocha surface steps**: flatten `canvas` and `surface` to `Base`
   (`#1e1e2e`), `raised` to `1.12:1` (`#272738`), and decorative hairline `border` to `1.30:1`
   (`#313244`), make workspace monograms neutral, reserve `Mauve` (`#cba6f7`) for primary actions,
   links, and focus indicators, and restrict continuous breathing motion to the top-bar `Needs you`
   count pill.
3. **Sibling stack terminal switching**: replace split-and-zoom `bw-chat` panes with sibling stack
   screens (`chat`, `panes`, `needs`, `overview`), flip `⌘J` between `chat` and `panes` with
   hover-only `bw-pane` headers (`lone: false`), and offer a quick terminal peek (`terminal.peek`).
4. **Cockpit workflow quartet**: ship the cross-agent `Needs you` / `Whose move` screen with inline
   `1-9` answering (`mods/bw-needs/`), cached GitHub PR/CI/review-thread status (`bw pr`),
   per-terminal prompt queuing (`bw queue`) that auto-drains on a clean `Stop` hook event and holds
   on blockers, and line-anchored diff comments in `bw-diff`.
5. **Skill-native sidecar and PR actions**: add a read-only `Drafts & Audit` tab (`mods/bw-drafts/`)
   in `bw-right` for `docs/drafts/**/*.html`, `decisions.tsv`, plan checklists, and
   `independent-review` `ledger.md`, and wire PR buttons to send or queue `/babysit-pr` and
   `/merge-pr` to the space's agent.

## Non-goals

- No Cockpit session auto-resume (`sessions.json`) across restarts or Syncthing machines.
- No Cockpit GPUI `show` renderer for charts, Mermaid diagrams, or before/after image sliders;
  standalone HTML artifacts opened in `bw-browser` remain the visual medium.
- No direct `gh pr merge` execution from any UI button; PR merges always flow through `/merge-pr`
  in the agent session so review and CI gates hold.
- No theme switcher or neutral-grey theme file; Catppuccin Mocha stays the sole Bellwether theme.

## Anti-goals

- Polling Herdr live functions (`agents()`, `spaces()`, `panes()`, `terminals()`, `focused()`) from
  `cx.timer` or background tasks (`REVIEW.md` line 13; `tests/harness/herdr-stub.js` throws on it).
- Scattering hex literals outside `shared/palette.js` and its synced mod copies.
- Auto-draining a queued prompt while an approval or question is pending, after an interrupted or
  errored turn, or into a replaced session after `/clear` or `/new`.
- Breaking any safety invariant from PR #9 and Phase 7: the 3 s `TERMINAL_FOCUS` answer guard,
  `claims.rs` atomic single-delivery lock, `2 s` shown / `10 s` hidden feed polling, or remote SSH
  parity via `exec(..., { on })`.
- Editing `hooks/`, `scripts/install-*`, `scripts/sync.sh`, `.stignore`, `.gitignore`, or
  `crates/bw/src/machine/` without need.

## Decided by the user

| Topic | Decision |
|---|---|
| Default shell geometry (`A1`) | Docked 244 px Flockbook-row sidebar (`⌘B` hides to left-edge peek), frameless central stack, right inspector closed until requested |
| Palette (`A2`) | Catppuccin Mocha hues with flattened surface steps (`Base` field, `1.12:1` raised, `1.30:1` hairline border), neutral monograms, `Mauve` reserved for primary actions |
| Chat / Terminal switching (`A3`) | Frameless layout-level `chat` stack screen; `⌘J` flips to sibling `panes` screen with hover-only pane headers, plus floating terminal peek |
| Cockpit Phase 1 scope (`A4`) | Cross-agent `Needs you` / `Whose move` inline `1-9` screen, `bw pr`, `bw queue`, and line-anchored diff comments in `bw-diff` |
| Skill & PR integration (`A5`) | Read-only `Drafts & Audit` inspector tab and PR buttons that queue/send `/babysit-pr` or `/merge-pr` |
| Queue draining (`A6`) | Auto-send next queued prompt on a clean `Stop` hook event; hold queue whenever an approval, question, or error is pending |

## Design

### 1. Shell geometry and stack coordination (`layouts/bellwether.json`, `keys/bellwether.json`, `mods/bw-tabs/`)

`layouts/bellwether.json` switches from split-pane chat tabs and three open columns to a two-part
default shell (`sidebar` + `work`) with an on-demand `right` inspector and zero bottom status bar:

| Layout node | Configuration | Purpose |
|---|---|---|
| `sidebar` | `size: { px: 244 }`, `min: 200`, `max: 420`, `resizable: true`, `background: "chrome"`, children: `projects` (`bw-projects`) + `chrome` (`workspace-chrome`, `40 px`) | Multi-machine Flockbook-row project switcher; `⌘B` toggles visibility via `layout.toggle { id: "sidebar" }` |
| `work` | `direction: "vertical"`, `size: { weight: 1 }`, `background: "surface"` (`#1e1e2e`), children: `tabs` (`48 px`, `window_drag: true`, `bw-tabs`) + `screen` (`stack`, `active: "chat"`, `floating: [sidebar-peek]`) | Single uninterrupted `#1e1e2e` field holding the floating capsule bar above the active screen |
| `screen.floating` | `[{ id: "sidebar-peek", content: { mod: "bw-projects", props: { peek: true } }, edge: "left", align: "start", peek: 6 }]` | Native Herdr floating drawer that reveals `bw-projects` on left-edge hover across all screens while `sidebar.hidden` is `true` |
| `screen.chat` | `{ id: "chat", mod: "bw-chat" }` | Frameless conversation column (`max_w: 760`, centered) with zero outer border or extra headers |
| `screen.panes` | `{ id: "panes", tab: "active", padding: 8, pane: { gap: 8, radius: 10, background: "background", lone: false, border: { width: 1, color: "border" }, focus: { width: 1, color: "accent" }, header: { content: { mod: "bw-pane" }, height: 28, position: "top", reveal: "hover" } } }` | Full-width terminal panes; single terminals draw frameless (`lone: false`); splits show 1 px borders and hover-only headers |
| `screen.needs` | `{ id: "needs", mod: "bw-needs" }` | Cross-agent `Needs you` / `Whose move` triage and inline `1-9` answering |
| `screen.overview` | `{ id: "overview", mod: "bw-overview" }` | Cross-space fleet overview cards |
| `right` | `hidden: true`, `size: { px: 380 }`, `min: 280`, `max: 620`, `resizable: true`, `background: "chrome"`, children: `right-tabs` (`36 px`, `bw-right`) + `right-body` (`stack`: `changes`, `issues`, `drafts`, `browser`) | On-demand sidecar inspector (`⌘⌥B`, top-bar toggle, or `Open in ...` actions) |

Herdr 0.1.13 returns live `hidden` and `stack.active` values directly from `layout()` (`~/.config/herdr-app/AGENTS.md`
line 966). `bw-tabs`, `bw-projects`, `bw-chat`, `bw-diff`, `bw-linear`, `bw-browser`, `bw-drafts`, and
`bw-right` read `layout()` directly inside `render()` with no intermediate `shell-state.js` helper or
`.state/bellwether.json` file read, preventing state drift on native `layout.toggle`, `layout.show`, or
`layout.select` commands. Because hidden stack children do not run `render()` (`AGENTS.md` line 821),
`bw-tabs` (which stays visible in `work`) mirrors `find(layout(), "screen")?.active ?? "chat"` one-way
into `shared("bw.screen")` whenever it changes so `bw-chat`'s background poll loop can observe screen
changes without calling Herdr live functions in an async task.

`bw-tabs` coordinates screen selection and keyboard focus handoff inside `render()` (where Herdr allows
`spaces()`, `agents()`, `panes()`, `focused()`, and `layout()`):

1. Each tab resolves a natural screen: `"panes"` when `shared("bw.tab-view")?.[tabId] === "panes"` or
   when the tab is a plain shell/tool tab with neither `bw.chat-tabs` membership nor a Claude/Codex
   pane, and `"chat"` when listed in `bw.chat-tabs` or running a Claude/Codex agent.
2. Explicit per-tab `⌘J` overrides live in `shared("bw.tab-view")` (`Record<tabId, "chat" | "panes">`).
   When the active tab changes while `screen.active` is `"chat"` or `"panes"`, `bw-tabs` selects that
   tab's desired screen with `this.askedScreen` deduplication (matching `bw-right/main.js` line 57).
   While `screen.active` is `"needs"` or `"overview"`, `bw-tabs` preserves that screen until the user
   clicks a tab, presses `⌘J`, or toggles `needs`/`overview`.
3. Every screen transition performs an explicit keyboard focus handoff so keystrokes never reach an
   off-screen terminal: entering `"panes"` runs `pane.focus { terminal }` on the tab's active terminal;
   entering `"chat"` runs `bw-chat.focus` (focusing the composer or active request dock); and entering
   `"needs"` runs `bw-needs.focus` (focusing `bw-needs`'s root `FocusHandle`). `focusRecord` treats
   `screen.active !== "panes"` as `focusedTerminal = null`, so `TERMINAL_FOCUS` records `leftAt`
   immediately when leaving `"panes"` for `"chat"` or `"needs"`, starting the full `3 s` answer-button
   cooldown cleanly.
4. `bw-tabs` draws two floating `36 px` pills over `t.surface` (`#1e1e2e`) with `bg(t.raised)`,
   `1 px t.border`, and `rounded(18)`: a left/center tab capsule (sidebar toggle button when
   `sidebar.hidden` is `true`, draggable tab pills with status mark + label + hover close, and `+`
   button) and a right utility capsule (`Needs you` count pill when `> 0`, `Overview` grid icon,
   `Terminal` flip/peek controls, and `Inspector` toggle). When `sidebar.hidden` is `true` on macOS
   with `titlebar: "none"` and `!w.fullscreen`, `bw-tabs` reserves traffic-light clearance on the left
   (`78 px` scaled by `settings().zoom ?? 1`).
5. Left-edge peek: `screen` declares a native Herdr `"floating"` drawer (`id: "sidebar-peek"`,
   `edge: "left"`, `align: "start"`, `peek: 6`, `AGENTS.md` lines 385-406) mounting `bw-projects` with
   `props: { peek: true }`. While `!find(layout(), "sidebar")?.hidden`, the peek instance renders an
   empty `div()` so Herdr hides the floating frame; while `sidebar.hidden` is `true`, it renders a
   fixed `244 px` vertical workspace/agent tree without mutating layout on `placement().hovered`, so
   hovering within `6 px` of the left edge slides the drawer out smoothly over `chat`, `panes`
   (including native terminal panes), `needs`, and `overview`. Any code adapted from Flockbook
   (`minchenlee/flockbook`, MIT, commit `c9afaf7`) is recorded in `THIRD_PARTY_NOTICES.md`.
6. `keys/bellwether.json` binds `cmd-b` (`layout.toggle:sidebar`), `cmd-j` (`bw-tabs.chat-flip`),
   `cmd-shift-'` (`bw-tabs.terminal-peek`, running `terminal.peek` on the active tab's agent
   terminal), `cmd-shift-n` (`bw-tabs.needs-toggle`), `cmd-shift-o` (`bw-tabs.overview-toggle`), and
   `cmd-alt-b` (`layout.toggle:right`).
7. Legacy split-pane migration and `bw-new` modes: `bw-new` starts `"New chat"` tabs as single-pane
   agent tabs (`tab.new` / `space.new`) recorded in `bw.chat-tabs` without `pane.split` or `pane.zoom`,
   while `"New terminal"` launches (both shell and terminal-first Claude/Codex) record
   `bw.tab-view[tabId] = "panes"` so they open directly in `panes`. When `adopt()` in
   `shared/chat-tabs.js` sees a pre-upgrade tab still carrying a `mod === "bw-chat"` split pane, it
   unzooms if needed and closes only the `bw-chat` mod pane (`pane.close { pane }`), leaving the live
   terminal pane intact. `mods/bw-status/` stays in the repo (updated to the flattened palette) so
   `scripts/sync.sh` needs zero changes.

### 2. Flattened Catppuccin Mocha palette and calm motion (`shared/palette.js`, `themes/bellwether.json`, `shared/ui.js`)

`shared/palette.js` remains the single file containing hex color literals (`themes/bellwether.json`
is generated or verified directly against `themeFile()` in `tests/theme.test.js`). Surface steps
flatten to match Flockbook's calm hierarchy while preserving Mocha's hues and WCAG 2.2 AA contrast:

| Role | Hex | Contrast vs `#1e1e2e` Base | Usage and contrast rule |
|---|---|---|---|
| `canvas`, `surface`, `background` | `#1e1e2e` (`Base`) | `1.00:1` | Unified reading, tab-bar, and terminal field |
| `chrome`, `popover` | `#181825` (`Mantle`) | `1.07:1` | Docked left sidebar, right inspector, and menus |
| `raised` | `#272738` (`45% Surface 0` over `Base`) | `1.12:1` | Capsule bars, user bubbles, composer, cards, monogram tiles |
| `border` | `#313244` (`Surface 0`) | `1.30:1` | Decorative 1 px hairlines on capsules, cards, and split panes |
| `input` | `#7f849c` (`Overlay 1`) | `4.43:1` (`3.96:1` on `raised`) | Interactive text inputs (`Other...`, search, comment box), meeting SC 1.4.11 (`>= 3:1`) |
| `selected` | `#333546` (`55% Surface 1` over `Base`) | `1.36:1` | Selected sidebar row, active tab pill, active segmented control (`Subtext 0` `#a6adc8` is `5.43:1` AA on `selected`) |
| `hover` | `#cdd6f412` (`Text` at 7% alpha) | translucent | Subtle hover state on `Base`, `Mantle`, and `raised` |
| `foreground` | `#cdd6f4` (`Text`) | `11.3:1` | Primary text (`8.35:1` on `selected` `#333546`) |
| `muted` | `#a6adc8` (`Subtext 0`) | `6.8:1` | Secondary text (`>= 5.4:1` on `raised` and `selected`) |
| `dim` | `#9399b2` (`Overlay 2`) | `5.3:1` | Non-text icons, idle rings (`>= 3.8:1` on `selected`), never body text |
| `accent`, `solid` | `#cba6f7` (`Mauve`) | `7.5:1` (`6.6:1` on `raised`) | Primary buttons (`Crust` `#11111b` ink, `9.2:1`), focus rings, links, drop indicators |
| `working` / `done` / `blocked` | `#89b4fa` / `#a6e3a1` / `#fab387` | `>= 6.8:1` | Semantic status marks (`Blue` spin, `Green` check, `Peach` dot) |

Visual and motion rules in `shared/ui.js` and `mods/bw-projects/`:

1. Workspace monograms switch from per-project rainbow fills to neutral `20 px` rounded squares
   (`bg(t.raised)`, `1 px t.border`, `text_color(t.muted)`, `rounded(6)`).
2. Sidebar rows follow Flockbook's flat 2-tier tree: `28 px` project header rows and `26 px`
   indented agent/worktree rows (`rounded(7)`), showing a compact branch/dirty badge only when dirty
   or ahead/behind.
3. Motion stillness update (amending `2026-11-07` Done Check 3): working marks keep `spin(900)`.
   Individual blocked marks in sidebar rows, tab pills, pane headers, timeline chips, and chat waiting
   banners draw as static `Peach` (`#fab387`) marks so multiple waiting surfaces never pulse out of
   phase. Across the entire window, only the top-bar `Needs you` count pill runs
   `loop("opacity", { from: 0.65, to: 1, period: 1400 })` (`Peach` at `0.65` alpha over `raised`
   stays above `3.8:1`).

### 3. Stack-mode `bw-chat` (`mods/bw-chat/`)

`bw-chat` supports both per-pane props (`props().terminal`, kept for harness compatibility) and
layout-level stack mode (`props()` empty):

1. In stack mode, `bw-chat` maintains an LRU `Map<string, SessionState>` (up to 24 terminal
   addresses, never evicting a session with non-empty unsent composer text or Linear chips) holding
   each terminal's `FeedState`, `VirtualListScrollHandle`, `follow` flag, `Composer` (`InputState`
   draft + Linear chips), `view` (root or sub-agent), `requests`, `drafts`, cached `pr` summary, and
   `queue` items. Switching spaces or tabs swaps the active session without losing scroll offset or
   unsent composer text.
2. `render()` resolves the active space's active tab's target agent terminal in priority order:
   first `shared("bw.chat-agent")?.[tabId]` when that terminal is still a live Claude/Codex pane in
   the active tab, then the focused Claude/Codex pane in that tab, then the first Claude/Codex pane
   in that tab. When the active tab contains more than one Claude/Codex pane, `bw-chat`'s context
   strip renders a compact agent-switcher pill (`shared("bw.chat-agent")`) so multi-agent split tabs
   make the active conversation explicit and selectable. `render()` updates
   `this.shown = find(layout(), "screen")?.active === "chat"`, feeds `TERMINAL_FOCUS` into
   `focus-guard.js` so switching `panes -> chat` via `⌘J` enforces the full `3 s` answer-button
   cooldown, and pokes the single background loop. On each iteration, the background loop refreshes
   `this.shown` from `(shared("bw.screen") ?? "chat") === "chat"` in stack mode (and
   `shownFrom(shared(CHAT_SHOWN), this.chatPane, this.shown)` in per-pane props mode) so hiding `chat`
   behind `panes`, `needs`, or `overview` drops polling from `2 s` to `10 s` without waiting for a
   hidden `render()`.
3. `bw-chat` drops its `36 px` top header bar in stack mode (tab name, status, and terminal buttons
   already live in `bw-tabs`). Remote machine tags, hook-setup notices, and sub-agent breadcrumb bars
   render only when applicable inside the `760 px` centered column.
4. Above the composer, a compact context strip shows the queued-prompt drawer (`bw queue`, hidden
   when 0 items) and a 1-line PR status chip (`bw pr`, hidden when no open PR exists on the branch)
   with `Open PR`, `Babysit PR` (sends/queues `/babysit-pr <number>`), and `Merge PR` (shown on an
   open, non-draft PR when `failing === 0`, `pending === 0`, `unresolvedThreads === 0`, `headRefOid`
   matches local `HEAD` when known, and `reviewDecision` is `"APPROVED"`, `""`, or `null`, sending or
   queuing `/merge-pr <number>`).

### 4. Cached GitHub PR status (`crates/bw/src/pr/`, `bw pr`)

`bw pr` runs on the **window machine** (`exec(..., { on: null })`), mirroring `bw linear`
(`docs/architecture.md` line 150) so remote SSH spaces reuse this Mac's `gh` keyring session without
copying tokens:

1. `shared/git-parse.js` adds `parseGithubRepo(remoteUrl)` supporting `git@github.com:owner/repo(.git)`,
   `https://github.com/owner/repo(.git)`, and `ssh://git@github.com/owner/repo(.git)`, returning
   `null` for non-GitHub remotes. `shared/git.js` reads `remote.origin.url` and `# branch.oid` with
   `READ_ONLY` flags (`--no-optional-locks -c core.fsmonitor=false`) on `space.machine`.
2. CLI contract: `bw pr status --repo <owner/repo> --branch <branch> [--head <oid>] [--refresh]`.
   Validates `<owner/repo>` (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`) and rejects flag-like branch names.
3. Cache: `~/.cache/bellwether/pr/<sha256(repo + "\0" + branch)>.json` (`0600` file in `0700` dir),
   TTL `60 s` (bypassed on `--refresh` or when `head` differs from cached `head_oid`).
4. Query: executes `BW_GH_BIN` (default `"gh"`) with a `10 s` timeout: `gh api graphql` fetching the
   branch's open (or most recent merged/closed) pull request `number`, `title`, `url`, `state`,
   `isDraft`, `baseRefName`, `headRefOid`, `reviewDecision`, `mergeStateStatus`, `reviewThreads`
   (`isResolved == false` count), and `statusCheckRollup` (`passing`, `failing`, `pending` counts).
5. Output NDJSON line: `{"type":"pr","repo":...,"branch":...,"pr":null | {...},"cached":bool,"age_s":u64,"stale":bool}`.
   When `gh` is missing, unauthenticated, or offline, `bw pr` returns a cached entry with
   `"stale": true` when one exists, or `{"type":"error","code":"no_gh"|"unauthenticated"|"offline",...}`
   without failing any mod render.

### 5. Per-terminal prompt queue and `Stop`-hook auto-drain (`crates/bw/src/queue/`, `crates/bw/src/events/mod.rs`)

`bw queue` runs on `space.machine` so the mod and `hooks/bw-event` share one filesystem and lock:

1. Storage: `~/.cache/bellwether/queue/<core>/<terminal>.json` (`0600` in `0700` dir), serialized by
   an OS `FolderLock` (`queue/<core>/<terminal>.lock`, reusing the lock pattern in
   `crates/bw/src/requests/claims.rs`). Each queued item stores
   `{ id, text, at_ms, expect_kind, expect_session, unverified_startup, agent_pid }`, plus
   queue-level `{ held: bool, hold_reason: Option<String>, last_drain_event: Option<String> }`.
2. Subcommands:
   - `bw queue list --terminal <t>`: prints `{"type":"queue","terminal":...,"held":...,"hold_reason":...,"items":[...]}`.
   - `bw queue add --terminal <t> --kind claude|codex [--session <id>] --text <msg>` (or `--text-stdin`):
     runs `chat::locate` on `space.machine` at enqueue time to bind `expect_session` to the currently
     active session (and rejects a mismatched explicit `--session`). Only when an agent process is
     still starting up with no session log yet may `expect_session` be stored as `null`, accompanied
     by `unverified_startup: true` and the live `agent_pid` marker. Appends up to 20 items (`64 KiB`
     each).
   - `bw queue edit --terminal <t> --id <id> --text <msg>`, `move --id <id> --to <index>`,
     `remove --id <id>`, `clear --terminal <t>`, and `resume --terminal <t>` (re-binds `expect_session`
     to the current live session, clears `held`, and triggers a drain check).
   - `bw queue drain --terminal <t> [--on-stop <event_id>]`: pops and sends item 0 when all safety
     gates pass.
3. `Stop` hook wiring (`A6`): `"Stop"` is added to `EVENTS` in `crates/bw/src/events/mod.rs`
   (`pub const EVENTS: [&str; 5]`), and `Event` gains `#[serde(default)] pub stop_hook_active: bool`.
   `hooks/bw-event` and `crates/bw/src/machine/hooks.rs` require zero code edits because `hooks.rs`
   already iterates `EVENTS` (each active host runs `bw hooks apply` once, and Codex workspaces refresh
   trust when hooks update). When `bw event` writes a root `"Stop"` event (`e.agent_id.is_none()`) and
   `~/.cache/bellwether/queue/<core>/<terminal>.json` has `items.len() > 0` and `!held`, `bw event`
   spawns a detached `bw queue drain --terminal <t> --on-stop <e.id>` process (`stdin/stdout/stderr`
   set to `Stdio::null()`) and exits `0` immediately so the CLI closes its hook pipe cleanly.
4. Drain settle and 5 safety gates: when `--on-stop` is given, `bw queue drain` polls `hc get` every
   `250 ms` up to `BW_QUEUE_SETTLE_MAX_MS` (default `65_000 ms`, accommodating sibling 60 s `Stop`
   hooks such as Hindsight) until the terminal leaves `"working"`. Under the queue `FolderLock`, it
   verifies all five gates before popping item 0 and calling `chat::send` (without `--force`):
   - Gate 1: `!queue.held` and `items` is non-empty.
   - Gate 2: `hc get` reports terminal status `"done"` or `"idle"` (never `"working"` or `"blocked"`).
   - Gate 3: `requests::cards` reports zero pending requests across root and running sub-agents and
     `status != "blocked"`. If a request is pending, the queue stays unpopped until answered.
   - Gate 4: the latest session turn did not end in a user interruption (`[Request interrupted by user`
     or `turn_aborted`), a turn-ending error, or a direct prose question (`?` at the end of the root
     assistant's final non-empty paragraph or line outside fenced code blocks). On interruption or
     error, `drain` sets `held = true` with `hold_reason = "interrupted_or_error"`; on a trailing
     prose question, `drain` sets `held = true` with `hold_reason = "assistant_question"`; in both
     cases item 0 stays in place.
   - Gate 5: `chat::locate` finds a live agent matching `expect_kind`. Gate 5 never blindly adopts a
     new session at drain time: when `expect_session` is non-null it must match the live `session_id`;
     when `expect_session` is `null` (`unverified_startup`), Gate 5 accepts the live session only if
     `agent_pid` matches and the session has completed at most its initial startup turn with zero
     `/clear` or `/new` resets. Otherwise `drain` sets `held = true` with
     `hold_reason = "session_changed"`.
   If `chat::send` fails or returns non-`sent`, item 0 is kept at index 0 and `held = true` is
   recorded with the failure reason.
5. Fallback when `Stop` hook is outdated: when `bw-chat` observes its active terminal transition
   `working -> done|idle` with `queue.items.length > 0 && !queue.held`, it invokes
   `bw queue drain --terminal <t>` once; `FolderLock` guarantees at-most-once delivery even if the
   `Stop` hook also ran.
6. Composer UX in `bw-chat`: while the target agent's live status is `"working"`, pressing `Enter`
   in the composer enqueues the prompt via `bw queue add` (showing a `"Queue"` button; `⇧⌘Enter` or
   a secondary menu action forces immediate delivery only when explicitly requested). Above the
   composer, queued items can be edited inline, moved up/down, deleted, resumed when held, or sent
   next.

### 6. Cross-agent `Needs you` / `Whose move` and `Overview` (`mods/bw-needs/`, `mods/bw-overview/`)

`mods/bw-needs/` provides a two-column triage surface modeled on Flockbook's `needs.js` and
Cockpit's `Whose move` board, obeying Bellwether's zero-live-polling rule:

1. `render()` reads `spaces()`, `agents()`, `panes()`, and `focused()` synchronously and triggers
   async helper reads via `refresh-driver.js` (`bw counts` + `bw cards` on each blocked/active
   space's machine, and `bw pr status` on `on: null` for branches with open PRs, refreshed on state
   change and at `10 s` intervals without calling Herdr live functions in timers).
2. Left column (`300 px`): groups across all spaces and machines into `Needs you` (pending agent
   approval/question, failing PR checks, or unresolved PR review threads), `Ready to land` (open,
   non-draft PR with `failing === 0`, `pending === 0`, `unresolvedThreads === 0`, `headRefOid`
   matching local `HEAD` when known, `reviewDecision` in `["APPROVED", "", null]`, and agent
   `idle`/`done`), `Working`, and `Idle`. Clicking any row selects it in the detail pane;
   double-clicking (or clicking `Open chat`) writes `shared("bw.chat-agent", { ...prev, [tabId]: agentAddress })`
   and runs `agent.focus { terminal: agentAddress }` before selecting that space/tab and
   `screen = "chat"`, so multi-agent split tabs open the chosen agent's conversation rather than a
   sibling pane's.
3. Right column (`flex_1`, `max_w: 680`): renders the selected row's live detail:
   - When `bw cards` returns an `answerable` pending approval or question card, renders the shared
     request card (`dock.js` / `dock-model.js`) with inline `1-9` keyboard shortcuts, `Other...` input,
     and `bw answer` routed to `space.machine` (guarded by `focus-guard.js` and `claims.rs`).
   - When Herdr reports `status === "blocked"` (`bw counts` `requests >= 1`) without an `answerable`
     session card, renders `"Waiting in terminal"` with `"Open terminal"` (switching to that space's
     tab on `screen = "panes"` and focusing that terminal) rather than fabricating buttons.
   - When the row's action is PR-driven (`Ready to land` or `CI failing`), renders the PR summary,
     check/thread counts, `Open PR` (opens URL in `bw-browser`), `Babysit PR` (queues/sends
     `/babysit-pr <number>`), and `Merge PR` (queues/sends `/merge-pr <number>`).

`mods/bw-overview/` renders a responsive multi-space card grid showing each space's neutral
monogram, name, machine tag, branch + PR badge, and live agent rows, pinning `shared("bw.chat-agent")`
and `agent.focus` on one-click jump to `chat` or `panes`.

### 7. Line-anchored diff comments and scopes (`mods/bw-diff/`, `crates/bw/src/diff/`)

`mods/bw-diff/` gains scope pills and Cockpit-inspired line-anchored review comments without putting
event handlers inside `v_virtual_list`'s item closure:

1. Scope pills at the top of `bw-diff`: `Uncommitted` (existing `Staged` + `Changes` sections),
   `Branch` (`Committed` section against base ref), and `PR` (compares against `<remote>/<baseRefName>`
   when `bw pr` reports an open PR's `baseRefName`, falling back to `Branch` base picker).
2. Line selection: `mods/bw-diff/patch.js` keys virtual rows by `{patchDigest}:{kind}:{oldLine}:{newLine}`
   rather than array position, and `v_virtual_list` attaches `.on_item_click((key, cx) => ...)` on the
   list itself (`types/herdr/gpui-kit.d.ts` line 853). Clicking a diff code row
   (`kind === "add" | "del" | "ctx"`) verifies `patchDigest === this.patch.digest` (ignoring clicks
   from a superseded paint) and selects `{ path, section, base, side: "new" | "old", line, excerpt, patchDigest }`
   where `patchDigest` is the 16-hex SHA-256 emitted by `bw diff patch` (`crates/bw/src/diff/patch.rs`
   line 179). Diff rows draw a subtle `+` gutter affordance via pure `.hover(...)` styling and
   highlight when selected or commented.
3. Comment composer: a single retained `InputState` bar mounted **below** `v_virtual_list` (never
   inside virtual rows) edits the comment for the selected line (`Enter` / `Save` stores the draft;
   `Esc` cancels).
4. Stale-anchor protection and preflight batch send: draft comments live in per-space memory keyed by
   worktree path. Whenever `bw diff` refreshes a file's patch and `patchDigest` changes, each comment
   on that file re-verifies whether `excerpt` still appears at `line` (or within `±5` lines with
   unique match, updating `line`); otherwise it marks the comment `stale: true`. Before
   `Send N comments` (or `Queue N comments` when the agent is working) formats the review block,
   `bw-diff` runs a preflight `bw diff patch` check across every distinct commented
   `{ path, section, base }` (including files no longer selected in the viewer) and aborts delivery
   with a notice if any comment newly turns `stale: true`. Valid comments format into a structured
   markdown review block (`path:line (side)`, quoted excerpt, and comment body per item) delivered via
   `bw send` or `bw queue add` on `space.machine`, clearing drafts only after `sent` / `queued`
   succeeds. Any layout/formatting ideas adapted from Cockpit (`quaresc/cockpit`, MIT, commit
   `7ae5aa6`) are attributed in `THIRD_PARTY_NOTICES.md`.

### 8. Read-only `Drafts & Audit` inspector (`mods/bw-drafts/`, `crates/bw/src/drafts/`, `mods/bw-right/`)

`bw-right` updates `PANELS` (`mods/bw-right/choice.js`) to four segments (`Changes`, `Issues`,
`Drafts`, `Browser`) and adds a compact `×` hide button (`layout.hide { id: "right" }`) at the
right end of the `36 px` strip. Every `"Open in ..."` caller (`bw-chat` changed-files chip, PR chip,
and `bw-drafts`) calls `run("layout.show", { id: "right" })` alongside `layout.select` and
`setShared("bw.right.tab", ...)` so opening an inspector tab works when `right` starts hidden.

`crates/bw/src/drafts/` (`bw drafts`) runs on `space.machine`:

1. `bw drafts list --path <worktree>`: recursively scans `<worktree>/docs/drafts`,
   `<worktree>/docs/plans`, `<worktree>/docs/superpowers`, `<worktree>/.audit`, plus root files
   `<worktree>/decisions.tsv` and `<worktree>/tasks.md` (skipping symlinks that escape `<worktree>`,
   `node_modules`, and `.git`, capped at 200 files). In addition, `bw drafts list` discovers
   `independent-review` `ledger.md` artifacts written outside `<worktree>` (`~/.agents/skills/independent-review/SKILL.md`
   lines 133 and 234) via two allow-listed sources: pointers registered by
   `bw drafts register-ledger --path <worktree> --ledger <abs_ledger_path>` under
   `~/.local/state/bellwether/reviews/<sha256(canonical_worktree)>/<id>.json` (`0600` in `0700` dir),
   and `$TMPDIR/*/ledger.md` or `/private/tmp/*/ledger.md` files whose content references canonical
   `<worktree>`. Entries return NDJSON `{ kind: "html" | "decisions" | "plan" | "ledger" | "markdown", id, label, mtime_ms, size }`
   (classifying both `decisions.tsv` and `.audit/*.tsv` as `kind: "decisions"`).
2. `bw drafts read --path <worktree> --file <id>`: canonicalizes `<worktree>` and the requested
   entry, permitting only files inside canonical `<worktree>` or an allow-listed `ledger.md` matched
   in step 1 (never sibling raw review transcripts or arbitrary paths), caps size at `512 KiB`, and
   emits UTF-8 text.
3. `bw drafts stage --name <slug.html> [--machine <m> --path <worktree> --file <id>]` (run on
   `on: null`): reads the HTML either from stdin or directly from `<m>` via `hc_exec`, writes it into
   `~/.cache/bellwether/drafts-stage/<sha256>/<slug.html>` (`0700` dir, `0600` file, pruning oldest
   staged files beyond 32 entries), and prints its `file://` URL so `bw browser new` opens remote HTML
   artifacts in Bellwether Chrome without manual SCP or large JS argument buffers.
4. `mods/bw-drafts/` renders:
   - HTML artifacts (`**/*.html`) with an `Open in Browser` button (`bw browser new`, local `file://`
     path on `space.machine === null` or `bw drafts stage --machine` on remote spaces).
   - `decisions.tsv` and `.audit/*.tsv` (`show-me-your-work`) parsed from the TSV header row,
     rendering `show-me-your-work`'s 6-column schema (`ts`, `phase`, `decision`, `why`, `evidence`,
     `result`) with `phase` and `result` pills plus compact `evidence` paths.
   - Plan markdown (`docs/plans/*.md`, `tasks.md`) with `- [x]` / `- [ ]` progress count and native
     checklist rows, plus `TextView.markdown` for `ledger.md` and notes.

### 9. Helper version bump (`crates/bw/src/version.rs`, `shared/helper.js`)

`PROTOCOL` increments from `7` to `8` and `HELPER_VERSION` from `0.7.0` to `0.8.0` across
`crates/bw/Cargo.toml`, `crates/bw/src/version.rs`, and `shared/helper.js` so `createHelper`
automatically upgrades remote helpers before calling `bw pr`, `bw queue`, or `bw drafts`. Every new
`shared/<name>.js` file synced into `mods/bw-*/` is added to `biome.jsonc`'s `!mods/*/<name>.js`
ignore list so `bunx biome ci` stays clean.

## Done checks

Each check is an observable outcome with its command and rejection criterion. All stage-window
commands run through `scripts/verify/stage.sh do ...` on `macmini` so the user's live `Herdr.app`
config (`~/.config/herdr-app`) is untouched during verification until final approved sync.

1. **Shell geometry, stack screens, and left-edge peek.** `scripts/test.sh --offline` passes
   (including updated `tests/layout.test.js` pinning `sidebar` `244 px`, `right` `hidden: true`
   `380 px`, zero `status` block, `screen` stack `["chat", "panes", "needs", "overview"]`,
   `screen.floating` `sidebar-peek` with `peek === 6`, and `panes.pane.lone === false` with
   `header.reveal === "hover"`). In `stage.sh up` resized to `934x980` (OmniWM half-tile width via
   the stage Quartz window-bounds helper), `stage.sh do herdr-app status` reports layout `bellwether`
   with zero errors; `bw-chat` renders with zero `bw-pane` header and zero internal top bar; `⌘J`
   flips `screen` to `panes` where a single terminal fills the full work width (`> 650 px`, zero
   15-col squeeze) and back to `chat`; `⌘B` hides `sidebar`, moving the pointer via
   `/opt/homebrew/bin/cliclick m:x,y` to `x = 3, y = 300` reveals the `bw-projects` floating peek
   drawer on both `chat` and `panes`, and `Open in Changes` from fresh hidden startup reveals `right`
   on `changes` and populates live changed files in `bw-diff`. Rejects: any `bw-chat` split pane
   created by `bw-new`, a visible `right` column on fresh stage startup, any second header above chat,
   or a failed `⌘B` / `⌘J` / peek / `Open in Changes` transition.
2. **Flattened Mocha palette, single hex source, and WCAG AA contrast.**
   `grep -rnoE "#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b" mods/bw-*/*.js shared/*.js` lists hex literals
   only in `shared/palette.js` and its `.shared` copies. `node scripts/verify/contrast.js` checks
   every foreground/background pair across the flattened palette (including `Text` `8.35:1` and
   `Subtext 0` `5.43:1` on `selected` `#333546`, `Overlay 1` `#7f849c` input border on `raised`
   `#272738`, composited `hover`, and the breathing `Needs you` pill at `0.65` opacity) and exits `0`
   (`>= 4.5:1` for text `< 24 px`, `>= 3:1` for meaningful marks and `input` borders). Sampled pixels
   from `stage.sh do herdr-app shot` confirm `work` background and `tabs` field both match `#1e1e2e`
   (`±2` per channel), capsule fill matches `#272738` (`±2`), and workspace monograms are neutral
   rather than rainbow-tinted. Rejects: any contrast pair below threshold, any hex literal outside
   `palette.js`, or Crust `#11111b` appearing in the reading field.
3. **Calm motion, zero live-data polling, and preserved PR #9 safety guards.** Harness tests verify
   that no mod calls `agents()`, `spaces()`, `panes()`, `terminals()`, or `focused()` inside a timer
   or async task, working marks carry `spin`, individual row/tab/banner blocked marks carry no `loop`,
   and only the top-bar `Needs you` count pill carries `loop("opacity")`. In the stage window with OSC
   7501 status fixtures: (a) an all-idle window produces 10 identical shots `150 ms` apart; (b) with
   two blocked agents, row/tab/chat marks stay still while only the `Needs you` top-bar pill bounding
   box changes pixels; (c) through `BW_HELPER` call logging, `bw-chat` polls `bw feed` every `2 s` on
   `screen = "chat"` and drops to `10 s` after switching to `panes`, `needs`, or `overview`; and (d)
   answer buttons stay disabled at `0 s` and `2 s` after `⌘J` from `panes` to `chat` and enable at
   `4 s`, while pressing `1` on `needs` sends nothing to any hidden terminal. Rejects: any pixel
   changing outside allowed motion boxes, row/tab/banner blocked marks blinking, key leakage to a
   hidden terminal, or focus-guard / feed-cadence regression.
4. **`bw pr`, `bw queue`, and `Stop`-hook auto-drain with blocker hold.** `sh scripts/verify/pr.sh --offline`
   (using `BW_GH_BIN` fake GraphQL fixtures for `reviewDecision: "APPROVED"`, `reviewDecision: null`
   ready-to-land, `CHANGES_REQUESTED`, failing-CI, draft, non-GitHub remote, and offline-stale cache)
   and `sh scripts/verify/queue.sh --offline` pass. `queue.sh --offline` proves all five gates
   end-to-end against `bw`: (a) queuing two prompts while a fake terminal is `working`, firing a
   `"Stop"` hook payload into `bw event` while simulating a `1.2 s` sibling hook delay before `hc`
   status becomes `done`, auto-sends item 0 once and leaves item 1 queued; (b) with a pending
   `PermissionRequest` / `AskUserQuestion` card or a trailing assistant prose question (`?`), `"Stop"`
   does not pop item 0 (holding with `assistant_question` on prose questions); (c) after an
   `[Request interrupted by user]` turn, or after enqueueing without `--session` and simulating
   `/clear` session replacement, `drain` sets `held: true` with the exact `hold_reason`
   (`interrupted_or_error` or `session_changed`) and sends nothing; and (d) two concurrent `drain`
   calls deliver item 0 at most once under `FolderLock`. On `macmini`, `bw pr status` against a real
   GitHub repo returns valid JSON through the logged-in `gh` CLI. Rejects: any message delivered over
   a blocker, prose question, error, or changed session, or duplicate delivery under concurrency.
5. **Cross-agent `Needs you` inline `1-9`, `bw-diff` line comments, and `bw-drafts` inspector.**
   Harness and stage verification prove: (a) `bw-needs` lists a blocked agent with an `answerable`
   question card, pressing key `1` (after the 3 s guard) invokes `bw answer` on `space.machine` with
   option 1, clicking `Open chat` on agent B in a two-agent tab pins `bw.chat-agent` and opens B's
   conversation in `bw-chat`, and a blocked shell terminal without a session card renders
   `"Waiting in terminal"` with zero answer buttons; (b) PR action buttons in `bw-needs` and `bw-chat`
   show `Merge PR` for both `APPROVED` and `null`-reviewDecision clean PRs, enqueue/send
   `/babysit-pr <n>` or `/merge-pr <n>`, and never invoke `gh pr merge`; (c) in `bw-diff`, clicking
   diff lines on file A and file B via `on_item_click`, selecting file B while mutating file A on disk
   so A's anchor moves `> 5` lines, and clicking `Send 2 comments` catches A's stale anchor in
   preflight (marking A `stale` and holding send), while sending valid comments delivers a formatted
   `path:line` review message via `bw send`/`bw queue`; and (d) `bw-drafts` lists nested
   `docs/drafts/sub/page.html`, root `tasks.md`, a 6-column `decisions.tsv` written by
   `show-me-your-work/scripts/log.sh`, and an external `mktemp -d` `ledger.md`, stages remote HTML on
   `on: null`, and opens an HTML artifact in Bellwether Chrome via `bw browser`. Rejects: handlers
   inside `v_virtual_list` row closures, silent sending of stale diff anchors from unselected files,
   path traversal or raw-transcript reads outside allow-listed `ledger.md` in `bw drafts`, or direct
   `gh pr merge` calls.
6. **Full offline suite and visual comparison review.** `scripts/test.sh --offline` and
   `scripts/check.sh` pass with zero warnings (`cargo fmt`, `cargo clippy -D warnings`, `cargo test`,
   vendored `herdr-core` tests, `biome ci`, `tsc -p types`, `bun test`, `herdr-app check` on all 15
   `bw-*` mods, and all `scripts/verify/*.sh --offline` scripts). Stage screenshots of `chat`
   (`934 px` half-tile and `1440 px` wide), `panes` (`⌘J`), hidden-sidebar peek (`⌘B`), `needs`,
   `overview`, `bw-diff` with line comments, and `bw-drafts` are inspected alongside Flockbook's
   reference layout and included in the updated HTML feature page. Rejects: any failing check or
   unaddressed visual defect.

## Left to the builder

- Exact pixel spacing inside `±2 px` of the stated capsule, row, and card dimensions, and SVG icon
  geometry for `needs`, `overview`, `queue`, and `drafts`.
- Internal module split across `shared/` (`palette.js`, `ui.js`, `git-parse.js`, `chat-tabs.js`) and
  per-mod helper files, keeping `.shared` lists and `biome.jsonc` ignores synchronized.
- Implementation task breakdown in `docs/plans/2026-11-13-bellwether-ui-cockpit-refinement-plan.md`
  after design approval.

## Amendment log

- 2026-11-13: written from the 4-model council brainstorm and 6-question user interview (`A1..A6`).
- 2026-11-13: Tier 2 design review (`Claude Opus 5.5` + `GPT-6.1 Sol`, cross-family verified) amended
  14 findings (`F1..F14`) plus `bw drafts stage --machine`: allowed `null`/`""` `reviewDecision` for
  `Ready to land` and `Merge PR` (`F1`); added external `mktemp -d` `ledger.md` and root `tasks.md`
  discovery in `bw drafts` (`F2`); bound `expect_session` at `bw queue add` time and rejected blind
  drain-time session adoption (`F3`); pinned `bw.chat-agent` on multi-agent `Open chat` (`F4`);
  matched `show-me-your-work`'s 6-column `decisions.tsv` schema and `.audit/*.tsv` (`F5`); added
  preflight patch verification across unselected files in `bw-diff` (`F6`); removed `shell-state.js`
  in favor of live `layout()` reads (`F7`) plus one-way `bw.screen` mirroring for `bw-chat`'s hidden
  poll cadence (`F8`); specified explicit screen focus handoff (`F9`); held auto-drain on trailing
  assistant prose questions (`F10`); switched left-edge peek to Herdr's native `"floating"` drawer so
  it works over terminal `panes` (`F11`); keyed `bw-diff` virtual rows by `{patchDigest}:{kind}:{old}:{new}`
  (`F12`); restricted `loop("opacity")` strictly to the top-bar `Needs you` pill (`F13`); and pinned
  stage window sizing, `cliclick` pointer checks, and `Text` on `selected` `8.35:1` contrast (`F14`).
