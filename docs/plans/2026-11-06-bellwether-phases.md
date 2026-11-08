# Bellwether phase plan

Status: phases 0 to 4 built and merged (PRs #2 to #11). Phases 4b to 7
revised and approved 2026-11-07; the user's answers are in
`2026-11-06-bellwether-phases-intent.md` beside this file. Built from
`docs/specs/2026-11-06-bellwether-design.md` revision 4 and
`docs/specs/2026-11-07-bellwether-visual-overhaul.md`; the specs decide
what is built and how it looks, this file decides the order and the steps.
Each phase gets a detailed task plan (superpowers `writing-plans`) when it
starts, so later phases use what earlier ones taught.

Every phase ends with `scripts/sync.sh`, `scripts/check.sh`, a look at the
window (`herdr-app shot`), the phase's done checks on the window machine and
on a second machine, and one commit per logical change after `git diff --cached
--stat` lists only the intended files (the repository syncs `.git` through
Syncthing). Every borrowed file is recorded in `THIRD_PARTY_NOTICES.md` in
the commit that copies it. Test recordings come from scripted sessions and
pass `scripts/verify/scrub-fixture` before they enter the repository.

## Phase 0: foundation

Usable: the `bellwether` layout (still Herdr's look), `bw version` on this
Mac and macmini, and answers to the two mechanics questions the design
rests on.

1. Repair cargo (the user approves this on the plan page): `rustup component
   remove cargo --toolchain stable-aarch64-apple-darwin`, then `rustup
   component add cargo …`; if removal fails, `rustup toolchain install stable
   --force`. Check: `cargo --version` prints 1.99.1.
2. `target` in `.stignore`.
3. `herdr-app do layout.clone '{"name":"main","as":"bellwether"}'`, copied
   into `layouts/`, round-tripped by `sync.sh`.
4. Cargo workspace with `crates/bw` and `rust-toolchain.toml` (1.99.1);
   `bw version` prints protocol and build as JSON.
5. Vendor Flockbook's `herdr-core` at `c0420c7` into `crates/vendor/`
   unchanged with `UPSTREAM`; adapt modfeed's `remote.rs` into `bw machine
   install <machine>`: build, copy with `hc file write --on` in parts under
   6 MB, check SHA-256 there, link `current`. Install on macmini. Add `cargo
   zigbuild` targets for Linux, built when tsuki returns.
6. `shared/helper.js`: one function per call, routed by machine through `sh
   -c` with `$HOME`, protocol check, named error states, automatic `bw
   machine install` when the version is missing or old.
7. Isolated test window after herdr-t3's `scripts/demo/stage.sh` (own app
   home, core, HOME) for Herdr state, with the real `claude`, `codex` and
   `hc` on its PATH and its own `bw`.
8. `scripts/verify/record-session` and `scripts/verify/scrub-fixture`:
   scripted sessions with the real agents in a scratch folder (three direct
   and one nested Claude sub-agent, one Codex sub-agent, an approval, a Codex
   async question, a screenshot), scrubbed, with hand-counted expectations.
9. Spike, in the isolated window: a tab made by `tab.new {argv: ["claude"]}`
   plus `pane.split {mod}` and `pane.zoom`, flipped both ways; check that the
   tab's status follows the agent, closing the tab ends the agent, and
   `agents()` still lists it. Check that `claude --mcp-config …
   --append-system-prompt-file …` and `codex -c mcp_servers.… -c
   developer_instructions=…` load the server and instructions for that
   session only. If the zoom flip misbehaves, fall back to a chat-only tab
   that shows its terminal with `terminal.show`, and record which.

## Phase 1: window and project sidebar

Usable: the three-column window with projects, worktrees and agent lines on
the left, Bellwether's tab bar and "+" menu (terminal entries), and an empty
right sidebar, on both machines.

1. `shared/projects-model.js` with `bun test`: group by `[machine, absolute
   common dir]`, merge `git worktree list --porcelain -z`, attach agents by
   space, rank status, merge remembered projects; fixtures include two
   repositories and a machine offline.
2. `mods/bw-projects`: machine headings, project headers, worktree rows,
   agent lines (24 px) with state icons, sub-agent and request counts, a
   rail below 160 px; Add project, Remove, New and Open worktree; watches and
   timers as the spec says (2 s for the selected remote worktree); `agent.focus` on agent clicks; `space.select` or
   `space.new {folder, machine}` on dimmed rows.
3. `mods/bw-tabs` and `mods/bw-new`: the tab bar for the active space, icons,
   status, close, drag to reorder, machine tag; "+" with New terminal
   (Shell, Claude, Codex, from `knownAgents({ on })`) and the worktree
   actions.
4. `mods/bw-right`: the right sidebar with its Changes, Issues, Browser strip
   and "coming in phase N" panels.
5. Layout: left `bw-projects`, middle `bw-tabs` over `{ "tab": "active" }`,
   right `bw-right`, Herdr's `workspace-status`; keys merged into a
   `layout:bellwether` section after showing the diff.
6. Amend the repository `AGENTS.md` line about watching Git.
7. Done check 1 (without the chat part of "+").

## Phase 2: chat tabs

Usable: "+" starts a Claude or Codex chat on the space's machine; the chat
reads the agent's log with grouped tool lines and pictures, sends messages,
and flips to the terminal with `⌘J`.

1. Root discovery fix in the vendored resolver (skip Codex sub-agent
   rollouts; remember the root per terminal), with a parent-and-child test.
2. Adapt modfeed's `protocol`, `rows`, `feed`, `tail`, `locate`, `status`
   into `crates/bw/src/chat/`; Codex 0.167 `exec`, `js`, `agent_message`;
   `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; tool runs summarized as sentences.
3. `bw feed`, `bw send` (expected kind, session and path; window-side;
   named results), `bw feed --pictures` and window-side `bw picture`.
4. `mods/bw-chat`: header, timeline (bubbles, markdown, tool lines, changed
   files line, pictures), composer with chips, slow polling when hidden;
   adapt Flockbook's `chat.js`, `mdblocks.js`, `estimate.js`, `composer.js`,
   `feedstate.js`.
5. Chat entries in "+": `tab.new` on the space's machine, `pane.split
   {direction: "right", mod: "bw-chat"}`, both pane ids in
   `shared("bw.chat-tabs")`, zoom the chat; `bw-tabs` handles
   `bw-tabs.chat-flip` on `⌘J`, zooming and focusing the other pane; test
   the key both ways.
6. Done check 2 (parent rows, refusal, helper install).

## Phase 3: sub-agents and requests

Usable: the threads card and each sub-agent's own transcript; approvals and
questions from the agent and its sub-agents answered in the dock, on both
machines.

1. Experiment with the real agents in a scratch folder: Claude foreground
   and background sub-agent approvals and a Codex sub-agent approval; where
   each prompt shows, its screen text, and what each `PermissionRequest`
   hook receives. Save sanitized screens as matcher fixtures.
2. Vendored-core change: parse each session file on its own. Session tree in
   `bw` from `parentAgentId`, `toolUseId`, `parent_thread_id` and `parent`;
   `bw feed --session`.
3. `hooks/bw-event` and `bw machine setup`: show the settings diff, append
   after existing groups in `~/.claude/settings.json` and
   `~/.codex/hooks.json` on each machine; the chat shows "Codex hook not
   trusted on <machine>" until the user trusts it.
4. `bw cards` and `bw answer`: occurrence-scoped claims; Flockbook's
   matchers; the Codex 0.167 approval matcher; the message path for Codex
   async questions; the 3 s focus guard; re-read after delivery.
5. `bw-chat`: threads card (folded pill, rows, nesting), sub-agent views
   with the parent bar, request dock (approval and question cards, 1 to 9
   keys, Other). `bw-projects`: counts per agent.
6. Done checks 2 (children) and 3.

## Phase 4: browser

Usable: a Bellwether Chrome beside Herdr that the user and every chat's
agent use, on this Mac and from macmini, with its tabs in the right sidebar.

1. `bw browser up|tabs|focus|close|arrange`: start or reuse Chrome with
   `~/.local/share/bellwether/chrome` and `--remote-debugging-port=9222` on
   127.0.0.1; tab list from `/json/list`; `Browser.setWindowBounds` to sit
   beside the Herdr window.
2. `agent/browser.md` (instructions after T3 Code's) and the per-session MCP
   config for Chrome DevTools MCP 1.12.0 with `--browserUrl`; written to each
   machine by `bw machine setup`; passed by "+" to Claude
   (`--mcp-config`, `--append-system-prompt-file`) and Codex (`-c
   mcp_servers.bw-browser…`, `-c developer_instructions=…` holding the
   effective existing value followed by Bellwether's text; tested with a
   sentinel).
3. Forwards: `ssh -o ExitOnForwardFailure=yes -N -R
   127.0.0.1:<port>:127.0.0.1:9222 <target>` per machine, with `<target>`
   from `hc machine ls --json` and `<port>` free on that machine; check
   loopback-only listening and the browser id through the port before giving
   agents the MCP config; reconnect with the same checks; named state for
   `via` machines. "Forward port" for dev servers (`ssh -L`, same option).
4. `mods/bw-browser`: status, tabs (title, URL, favicon, active), focus,
   close, New tab, Arrange, forwards.
5. `tests/browser/page.html` (numbered buttons, a click log) and
   `scripts/verify/browser.sh`. Done check 6.

## What changed after phase 4

Phases 0 to 4 were planned on the MacBook's word that the window ran there
and the second machine was macmini. Since then:

- PR #9 ran the owed window checks on the MacBook in the stage window:
  36 PASS, 6 FAIL, 15 BLOCKED, the blocked ones for lack of pointer and key
  input. The list is in the synced checkout at
  `/Volumes/WorkSSD/Personal/bellwether/docs/drafts/window-check-results/results.md`
  (T3 worktrees have no `docs/drafts/`). Its fixes added `props()` in place
  of `init` props, the `bw.chat-shown` and `bw.terminal-focus` shared keys
  written by `bw-tabs`, the threads card at the timeline's top right, a
  null-`window()` guard in `bw-projects`, `BW_SCRUB_HOSTS`, and `stage.sh`
  finding Herdr in `~/Applications`.
- PR #10 replaced Herdr's look with Catppuccin Mocha (`themes/bellwether.json`,
  Mauve accent), made `shared/palette.js` the only colour source, added
  `bw-status` (the bar under the active tab) and `bw-pane` (pane headers),
  Flockbook's shapes and motion that follows state only, `BW_HELPER` in
  `shared/helper.js` for counting helper calls on the window machine, and
  "Open in Changes", which stores `changes` in `shared("bw.right.tab")` for
  the space. New panels follow that spec's palette, shapes and motion rules
  and its contrast script (`scripts/verify/contrast.js`).
- PR #11 keyed a chat bubble's TextView by its width.
- The repository now has an `origin` (`dileep-kishore/bellwether` on
  GitHub), so done check 5's "bellwether (no `origin`)" case needs another
  repository.
- The Mac mini now runs Herdr 0.1.13 with the `bellwether` layout and is the
  window machine for every check from here on. The user allows pointer and
  key input on its display, through `cliclick` or `osascript` System Events
  after they grant Accessibility, and only on the Herdr window and the
  Bellwether Chrome, never their own Chrome.
- The second machine is `macbook`, the SSH machine in the Mac mini's default
  core. `bwloop` cannot serve: it is a temporary `via` machine, so Herdr
  gives it no spaces and the browser gets no forward to it. On `macbook`
  the checks use scratch folders under `/private/tmp/`, run nothing on its
  display, and remove every space, terminal and folder they made. Claude
  started there by the Mac mini's core runs unlogged (keychain), so Claude
  halves on another machine stay owed; Codex halves run. The existing
  scripted checks keep their `--machine bwloop` runs as well.

## Phase 4b: follow-ups and the blocked window checks

Usable: the request dock keeps one answerable card through a terminal
rewrap, the Browser panel marks an active tab while Herdr is in front, chat
bubbles fit narrow panes, and every phase 1 to 4 window check has a PASS or
FAIL with evidence. One PR, before Changes.

1. Prompt identity that survives a rewrap. Today the Claude approval id
   (`screen_prompt`, `crates/vendor/herdr-core/src/approval.rs:282-284`) and
   the Codex folder id (`crates/bw/src/requests/codex_folder.rs:59-60`) hash
   the box's drawn lines, so a narrower or wider pane gives a Claude
   approval a second "Left the screen" card and marked the waiting Codex
   folder card answered. Build each id from the prompt's text with every
   whitespace character and the rule glyphs (`╌`, `─`, `│`) removed, since
   Claude and Codex rewrap words, Codex breaks commands inside a word, and
   the rules are drawn to the pane's width; the Codex folder id uses the
   question and the option labels only, since a narrow pane drops the
   descriptions. The Codex parsers find a question that wrapped over several
   lines. Leave the matchers' input as drawn, so `codex_folder.rs:42` still
   splits options on two spaces, and keep the final screen guard in `bw
   answer` (`crates/bw/src/requests/answer.rs:349-356`). Commands that
   differ only in whitespace share an id, as `same_call` already treats
   them (`crates/bw/src/requests/matchers.rs:184-227`).
   Test-first with screens recorded from real agents at two widths, every
   test name containing `rewrap`: the same Claude approval and the same
   Codex folder prompt at two widths give one id and one pending card with
   its key bound; two approvals whose commands differ in one character give
   two ids.
   The `screen_prompt` change is a reviewed step in the vendored crate with
   its `UPSTREAM` note.
2. The Browser panel's active tab. `document.hasFocus()` gives one active
   tab per Chrome window while Chrome is in front, none while Herdr is in
   front, and true for every tab an agent opened in the background. Keep
   the per-window set while the Bellwether Chrome is the frontmost app.
   Otherwise, when no tab or more than one tab reports focus, mark the tab
   Bellwether last focused or opened, kept in the helper's browser state.
   The existing `active_comes_from_has_focus` test keeps its two active
   tabs with Chrome in front; new tests cover the two fallback cases. Fix
   the header state cut to "Run…" at 360 px.
3. The chat column's minimum: let the column shrink to the pane's width less
   its gutters, so a pane under 288 px wraps bubbles instead of clipping
   them (`mods/bw-chat/estimate.js:332`), with a harness test at 200, 288
   and 800 px.
4. README "Known limits": Claude started by a core that SSH started cannot
   read the login keychain and runs unlogged; start the core from the
   machine's own session.
5. Run on the Mac mini every FAIL and BLOCKED item of the MacBook run's
   `results.md` (21 rows), plus the items steps 1 to 3 touch, with pointer
   and key input under the limits above. Record each in
   `docs/drafts/phase5-onward/window-checks.md` with the original item text
   unchanged in its second column, PASS or FAIL, and a shot or log. A FAIL
   caused by Bellwether gets a fix in this PR, at most three attempts each
   (the user's bound on fix loops), and one still failing after three goes
   to the PR's Found list with its attempts. A FAIL caused by Herdr, macOS
   or the other machine's setup is recorded with its evidence.
6. Done checks A and B below.

## Phase 5: Changes

Usable: the Changes panel with Staged, Changes and Committed on branch
against `origin/main` or any ref, the patch below, and diffs as tabs, for a
space on either machine.

1. `bw diff files|patch|refs|fetch` with the read-only flags
   (`--no-optional-locks -c core.fsmonitor=false -c
   diff.autoRefreshIndex=false`, `--no-ext-diff --no-textconv --no-color`);
   one round trip for the three lists with `+N −M` per file and the
   worktree's absolute common dir; pages under 4 MiB, a patch larger than
   one page paged and a single line past it named "too large"; renames,
   binary files and untracked files named; the base resolved as the spec
   says (`origin/main`, else `origin/HEAD`'s target, else none, which opens
   the picker) and typed refs checked with `rev-parse --verify
   --end-of-options <ref>^{commit}`. Bump the helper to 0.5.0, protocol 5,
   so every machine's helper reinstalls. Fixture repositories come from
   `scripts/verify/git.sh`, including the textconv marker that must never
   be written.
2. `mods/bw-diff`: replaces the Changes placeholder in `right-body`. Header
   `<branch> → <base> ▾` with the base's short hash and age, Fetch, and the
   Merge base / Tip switch; the base kept per project in
   `shared("bw.diff.base")` under `projectKey(machine, commonDir)` from
   `shared/projects-model.js`. The three sections after Orca with status
   letters and counts; a file click shows its patch below, unified, with old
   and new line numbers and the overhaul palette's added and removed tints;
   "Open as tab" runs `tab.new {mod: "bw-diff", props}` with the space,
   worktree, file, base and the `window` id, as phase 2 learned to carry it.
3. Refresh: while the panel is shown, a local worktree refreshes on
   `watchFolder` and a remote one every 1.5 s start to start, as the project
   sidebar does; a hidden panel makes no helper call; Fetch runs only on
   click.
4. "Open in Changes" in a chat selects the Changes tab, and when the line
   names one file it also selects that file, through
   `shared("bw.diff.reveal")` keyed by space; a line naming several files
   selects none.
5. Done check C below (spec done check 4), then the window run of the panel
   and the tab on the Mac mini and on a `macbook` space.

## Phase 6: Issues

Usable: the Issues panel showing the linked Linear project's issues, inline
issue view, Attach into the chat.

1. The key: asked for once with T3's secure prompt during the build and
   stored in this Mac's Keychain by `scripts/linear-key.sh` (service
   `bellwether.linear`); the MacBook runs the same script once when the user
   next uses it there. `bw linear projects|issues|issue|search` over GraphQL
   reads the key with `security find-generic-password -s bellwether.linear
   -w`; pages of 50; a dated cache under `~/.cache/bellwether/linear/` (30
   days); named errors (no key, key refused, offline with the cached list's
   age).
2. Links per repository in `shared("bw.linear.links")` by normalized `origin`
   URL, else `[machine, common dir]`, moving to the origin key when one
   appears; the link picker with a name-match suggestion, also offered from
   the project menu (`bw-menu`).
3. `mods/bw-linear`: replaces the Issues placeholder. Header, Project, Mine,
   All filter, search, list grouped by state, inline issue with Attach, Open
   in Linear, Copy branch name. The list loads when the panel is shown and
   every 60 s while it stays shown, and on a refresh click; a hidden panel
   makes no call.
4. Composer chips in `bw-chat`: hover preview, text built at Send, the 8 KB
   rule with `hc put`.
5. Test data, created once through the Linear connector at setup: a
   `Bellwether` project in the user's Play/Hobbies/Misc team with about six
   scratch issues in mixed states, one assigned to the user, and a second
   `Bellwether scratch` project in the same team with three issues of its
   own, so two links show different lists. Bellwether itself never writes to
   Linear.
6. Done check D below (spec done check 5, amended).

## Phase 7: measure and finish

1. Time `bw feed` on the largest real session log and `bw diff files` on the
   largest Git checkout under `~` on the Mac mini and on `macbook`; add a
   watcher only past 100 ms CPU per poll (done check E).
2. `RECIPE.md` and `preview.png` in Herdr's recipe format (Herdr's
   `AGENTS.md`, Recipes), written, not published.
3. Rerun every done check of the design spec, the overhaul spec and this
   plan from empty state on the Mac mini, `independent-review` of the whole
   change, fixes, affected checks again, and the plan page refreshed with
   each result (done check F).

## Done checks for phases 4b to 7

Each is an observable result with the command that shows it, run with the
window on the Mac mini and the remote half on `macbook`.

- A. One card per prompt through a rewrap (known answer). The new `rewrap`
  tests pass: one Claude approval and the Codex folder prompt, each recorded
  at two widths, give one id each and one pending card, and two approvals
  whose commands differ in one character give two ids. In the window, narrowing the pane of
  a Claude chat whose approval waits leaves one card and no "Left the
  screen" note while the box is on screen, and Approve then answers it;
  narrowing a Codex chat's pane while its `/new` folder prompt waits leaves
  one pending card whose options still read as label and detail, and
  clicking the first option starts the new conversation. Rejects: a second
  card, a card marked answered while its prompt waits, or a `rewrap` filter
  that runs zero tests. Command: `cargo test -p bw --locked rewrap` (prints
  at least 5 passed), `scripts/verify/requests.sh`, `herdr-app shot`, `hc
  read`.
- B. Every phase 1 to 4 window item settled (run on real inputs). Each of
  the 21 FAIL and BLOCKED rows of the MacBook run's `results.md` has a row
  in `docs/drafts/phase5-onward/window-checks.md` with PASS or FAIL and a
  shot or log; none is BLOCKED for lack of pointer or key input; each
  Bellwether FAIL is fixed or listed in the PR's Found with three attempts.
  Rejects: a missing or changed original item, or a BLOCKED row whose reason
  is input. Command: `comm -23 <(awk -F'|' '/^\| [0-9] \|/ && $4 ~
  /FAIL|BLOCKED/ {print $3}' <results.md> | sort) <(awk -F'|' '/^\| [0-9]
  \|/ {print $3}' <window-checks.md> | sort)` prints nothing (every
  original row is present), and each `BLOCKED` row in `window-checks.md`
  names a reason other than input.
- C. Changes equal Git, on both machines (reference comparison; spec done
  check 4, amended). The reference commands, all with `--no-ext-diff
  --no-textconv --no-color`: Staged equals `git diff --cached`; Changes
  equals `git diff` plus `git ls-files --others --exclude-standard`, each
  untracked file's patch equal to `git diff --no-index -- /dev/null
  <file>`; Committed in Merge base mode equals `git diff $(git merge-base
  <base> HEAD) HEAD` and in Tip mode `git diff <base> HEAD`, where `<base>`
  is the resolved default or the typed `<ref>^{commit}`. With no
  `origin/main` and no `origin/HEAD`, `bw diff files` reports no base and
  the panel shows the picker instead of a Committed list. Fixtures: an
  untracked file, a rename, a binary file, a textconv marker that is never
  written, a typed ref, Tip mode, and no default base; the panel's rows for
  this worktree equal the same commands. Command: `scripts/verify/git.sh`,
  `scripts/verify/git.sh --machine macbook`, `herdr-app shot`.
- D. Issues follow the link and Attach reaches the right chat (app run;
  spec done check 5, amended). A scratch repository with no `origin` linked
  to `Bellwether` and one with an `origin` linked to `Bellwether scratch`:
  each default list's identifiers equal a GraphQL query for its own
  project's open issues, and the two lists differ; Mine and All change them
  accordingly; adding an `origin` to the first repository keeps its link;
  Attach then Send in chat A puts `Linear issue <id>: <title>` first in A's
  next user message and leaves chat B unchanged; the key's first 12
  characters appear nowhere on disk. Command: `scripts/verify/linear.sh`,
  `scripts/verify/sessions.sh`, `rg -F` over the app home, the cache, the
  helper data and the repository (the pattern passed on standard input, so
  it is never printed).
- E. Polling stays cheap (property). In the headless harness, with `exec`
  recorded, a hidden Changes or Issues panel for a local and for a remote
  space makes 0 helper calls in 12 s of timers, and the shown remote Changes
  panel makes one call every 1.5 s (the positive control). In the stage
  window, the `BW_HELPER` wrapper's `helper-calls.log` shows the same for a
  local space, and a shown Changes panel shows a plain edit within 2 s.
  `bw feed` on the largest session log and `bw diff files` on the largest
  Git checkout cost under 100 ms CPU per call, or, past that, the watcher
  phase 7 adds keeps each poll under 100 ms. Command: `bun test
  tests/mods/`, `scripts/verify/stage.sh up` with `helper-calls.log`,
  `/usr/bin/time -l` on each call.
- F. The finished window from empty state (app run). The design spec's six
  done checks, the overhaul spec's done checks and A to E pass on the Mac
  mini in one run, recorded with shots in
  `docs/drafts/phase5-onward/final-run.md`. In those specs' words, "this
  Mac" is the Mac mini, "macmini" is `macbook`, and the overhaul's "stage
  window on the MacBook" is the stage window on the Mac mini (design intent
  amendment log, 2026-11-07); the Claude halves on another machine are
  owed for the keychain reason above.

## Order and why

Phases 0 to 4 are built. Phase 4b comes first because the rewrap bug loses
an answerable request, and the blocked window checks test code that phases
5 and 6 build beside; fixing what they find in the same PR leaves later
phases on verified ground. Changes and Issues are self-contained
right-sidebar panels; Issues comes last because Attach needs the composer.
Phase 7 measures and reruns everything once the window holds every panel.
Each phase is its own PR against `main`; a phase stacks on an earlier one
only when it needs that phase's unmerged code.
