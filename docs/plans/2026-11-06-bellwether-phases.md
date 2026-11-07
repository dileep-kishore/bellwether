# Bellwether phase plan

Status: draft for the user's approval, 2026-11-06. Built from
`docs/specs/2026-11-06-bellwether-design.md` revision 3; that spec decides
what is built, this file decides the order and the steps. The look of each
feature follows the user's answers on the plan page
(`docs/drafts/bellwether-plan/bellwether-plan.html`). Each phase gets its own
detailed task plan (superpowers `writing-plans`) when it starts, so later
phases use what earlier ones taught.

Every phase ends with `scripts/sync.sh`, `scripts/check.sh`, a look at the
window (`herdr-app shot`), the phase's done checks, and one commit per
logical change after `git diff --cached --stat` lists only the intended files
(the repository syncs `.git` through Syncthing). Every borrowed file is
recorded in `THIRD_PARTY_NOTICES.md` in the commit that copies it. Test
recordings come from scripted sessions and pass `scripts/verify/scrub-fixture`
before they enter the repository.

## Phase 0: setup and browser spike

Usable result: the `bellwether` layout, identical to Herdr's `main`; `bw
version` runs; the browser route is chosen.

1. Repair cargo (the user approves this on the plan page): `rustup component
   remove cargo --toolchain stable-aarch64-apple-darwin`, then `rustup
   component add cargo --toolchain stable-aarch64-apple-darwin`; if removal
   fails on the missing manifest, `rustup toolchain install stable --force`.
   Check: `cargo --version` prints 1.99.1. Same check on macmini before its
   first build.
2. Add `target` to `.stignore` before the first build.
3. `herdr-app do layout.clone '{"name":"main","as":"bellwether"}'`, copy the
   clone into `layouts/`, set its preview, and confirm `sync.sh`
   round-trips it.
4. A Cargo workspace at the root with `crates/bw` (`bw version` prints the
   protocol number and build hash as JSON) and `rust-toolchain.toml` pinning
   1.99.1.
5. `scripts/install-helper.sh`: `cargo build --release -p bw`, install to
   `~/.local/share/bellwether/bin/<version>/bw`, point `current` at it. Run
   on macbook and macmini.
6. The isolated test window after herdr-t3's `scripts/demo/stage.sh` (its
   own app home, core and HOME) for Herdr state; notice entry if code is
   adapted (Apache-2.0). Because it changes HOME, it installs its own copy of
   `bw` and puts the real `claude`, `codex` and `hc` on its PATH (stage.sh
   puts fake launchers there).
7. Fixture provisioning: `scripts/verify/record-session` runs scripted
   prompts with the real `claude` (in `--permission-mode default`) and
   `codex` in a scratch folder under the user's real login, producing the
   recordings done checks 2 and 3 need (three direct and one nested Claude
   sub-agent, one Codex sub-agent, an approval, a Codex async question);
   `scripts/verify/scrub-fixture` keeps only parser fields, swaps text for
   the scripted text, and fails on home paths, email addresses and
   token-like strings. Hand-counted expectations go beside each fixture.
8. `shared/helper.js`: call `bw` locally or on a machine through `sh -c` with
   `$HOME`, parse JSON Lines, check the protocol, return a named error state.
9. Browser spike, time-boxed to one session, in the isolated window:
   - Kept harness: `tests/browser/page.html` (draws a frame number and
     acknowledges each click, key and scroll with a sequence number) and
     `scripts/verify/browser-spike.sh`, which drives 50 clicks and prints
     frames per second drawn and the median click-to-acknowledged-frame
     milliseconds, from timestamps the mod records.
   - Route A: a first `bw browser serve` that launches Chrome with a scratch
     profile and remote debugging, writes each screencast JPEG under a new
     name (written then renamed) in the test app home's `data/`, plus a mod
     that draws the newest frame, scales pointer positions, and forwards
     clicks, keys and scrolls. Probe that `image()` draws a new file under
     `data/` and that old frames can be pruned while shown.
   - Route B: install awrit in a scratch prefix, start its Electron with
     `--remote-debugging-port`, run it in a test pane, and confirm Chrome
     DevTools MCP controls the page the pane shows.
   - A route passes at 5 fps and a 300 ms median, and only if typing,
     scrolling, a resize, and an MCP click followed by a user click on the
     same page all work. Pick the first that passes, else C. The harness
     stays; the route code is rewritten properly in phase 4.

## Phase 1: project sidebar

Usable result: remembered projects, every worktree, agent status.

1. `shared/projects-model.js`, pure functions with `bun test`: group by
   `[machine, absolute common dir]`, merge `git worktree list --porcelain -z`,
   attach agents by space, rank status blocked > done > working > idle, merge
   remembered projects. Tests use recorded Git output and recorded `spaces()`
   and `agents()` values, including two unrelated repositories.
2. `mods/bw-projects` in the user's chosen row style: machine headings,
   project rows, worktree rows (open and dimmed), agents with status, counts,
   a rail below 160 px. Git through `exec`; `watchFolder` on local common
   dirs and on each open worktree's folder, debounced to one refresh per
   second, a 30 s refresh for open worktrees, a 60 s fallback when a watch is
   rejected, 15 s timer for remote ones; no polling of live data.
3. Actions: agent click runs `agent.focus`; dimmed worktree click runs
   `space.select` or `space.new {folder, machine}`; project menu: New
   worktree and Open worktree (Herdr's dialog), Remove; header: Add project
   (`pickFolder` here, typed path for another machine). `setAgentOrder`
   follows the list.
4. Swap Herdr's `spaces` and `agents` blocks for `bw-projects` (and the
   Linear slot the user chose) in the layout; keep `workspace-chrome`,
   `tabs`, `files` and `changes`.
5. Amend the repository `AGENTS.md` line about watching Git (spec,
   "Constraints from Herdr").
6. Done check 1.

## Phase 2: chat for one agent

Usable result: read any Claude Code or Codex agent as a chat and send it
messages; `cmd-j` flips to its terminal.

1. Vendor Flockbook's `xplat/herdr-core` at `c0420c7` into
   `crates/vendor/herdr-core` unchanged, with `UPSTREAM` and its tests
   passing (`cargo test -p herdr-core`), and its notice entry.
2. Fix root discovery in the vendored resolver: skip Codex rollouts whose
   `session_meta` names a sub-agent; remember the root per terminal in
   `~/.cache/bellwether/roots/`. Test with a parent and child rollout in one
   folder.
3. Adapt modfeed's `protocol`, `rows`, `feed`, `tail`, `locate`, `status`
   into `crates/bw/src/chat/` with notice entries; drop `serve`, `phone`,
   `install`, `remote`, `update`. Handle Codex 0.167 `exec`, `js` and
   `agent_message` records. Honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
4. `bw feed`; `bw send` with `--expect-kind`, `--expect-session`,
   `--expect-path`, run on the window machine with `machine/t` addresses;
   named results.
5. Pictures: `bw feed --pictures` lists picture ids; `bw picture` (window
   machine) fetches each through `hc exec --on`, caps it at 4 MB, writes it
   under `~/.config/herdr-app/data/bellwether/pictures/`. Fixture: a
   recorded screenshot tool result.
6. `mods/bw-chat`: adapt Flockbook's `chat.js`, `mdblocks.js`,
   `estimate.js`, `composer.js`, `feedstate.js`; the tool-detail style the
   user chose; drafts per root session until confirmed; inline pictures.
7. Layout: the main block becomes a `stack` of `bw-chat`, `{ "agent":
   "focused" }` and (if chosen) `bw-diff`, with `mods/bw-switch` as its
   header; `cmd-j` through a `layout:bellwether` section merged into
   `keys.json` after showing the diff.
8. Done check 2 (parent rows, expect-session refusal, missing helper).

## Phase 3: sub-agents and requests

Usable result: sub-agents in the chat, and approvals and questions from any
of them answered there.

1. Experiment first, with the real agents in a scratch folder: a Claude foreground and
   background sub-agent approval and a Codex sub-agent approval; record where
   each prompt shows, the screen text, and what each agent's
   `PermissionRequest` hook receives. Save sanitized screens as matcher
   fixtures.
2. Parser change in the vendored core: parse each session file on its own,
   so sub-agent files keep their sidechain lines. One commit with a test.
3. Session tree in `bw`: Claude children by `parentAgentId`, else
   `toolUseId` across all files; Codex children by `parent_thread_id`;
   terminal children by `parent`. `bw feed --session`. Child rows.
4. `hooks/bw-event` (acts only with `$HC_TERMINAL_ID`) and
   `scripts/install-hooks.sh [--remove]`: show the diff, append groups after
   the existing ones in `~/.claude/settings.json` and `~/.codex/hooks.json`.
   Tell the user to trust the Codex hook on each machine; the chat shows the
   untrusted state until then.
5. `bw cards` and `bw answer`: occurrence-scoped claims; Flockbook's screen
   matchers; a Codex approval matcher from step 1's fixtures; the
   message-bound path for Codex async questions; the 3 s focus guard;
   screen re-read after delivery and the "uncertain" state.
6. `bw-chat`: sub-agent cards and views in the user's chosen style, no
   composer in in-process sub-agent views, request cards where the user
   chose. `bw-projects`: sub-agent and request counts per agent.
7. Done checks 2 (children) and 3.

## Phase 4: shared browser

Usable result: a browser the user and the agents share.

Route A (if the spike chose it):

1. `bw browser serve` as a kept, unlabeled core terminal: Chrome with
   `~/.local/share/bellwether/chrome`, remote debugging on 127.0.0.1, CDP
   screencast to `~/.config/herdr-app/data/bellwether/browser/`, keeping
   the last few frames; `bw browser input|tabs|open`.
2. `mods/bw-browser` in the chosen place: frame view, address bar, back,
   forward, reload, tabs, open in Chrome, the "who acted last" strip; input
   forwarding.
3. Chrome DevTools MCP with `--browserUrl` added for Claude Code (user scope)
   and Codex on every machine with spaces; `bw browser serve` keeps an `ssh
   -N -R <port>:127.0.0.1:<port>` forward open to each remote machine so its
   agents reach the same browser.

Route B: a pane action that starts awrit with its Electron's
`--remote-debugging-port`, plus step 3 pointed at that port. Route C: Chrome
DevTools MCP with `--autoConnect` for agents on this Mac (agents on macmini
use their own Chrome there), screenshots inline in the chat through phase
2's picture path, URLs open in Chrome.

4. Done check 6.

## Phase 5: diff viewer

Usable result: review a worktree's staged, unstaged and committed changes
against `origin/main` or a picked ref, on any machine.

1. `bw diff files|patch|refs|fetch` on the Git CLI with the read-only flags
   and `--no-textconv`; one round trip for the lists; pages under 4 MiB.
   Fixture repositories built by a test script, including a textconv marker.
2. `mods/bw-diff` in the chosen place: three lists, base picker with typed
   ref, base date and Fetch, merge-base and tip-to-tip switch, per-file patch
   with line numbers, base kept per project in `shared()`.
3. Done check 4.

## Phase 6: Linear

Usable result: Linear issues in the sidebar, attached to a chat.

1. `bw linear issues|issue|search`: GraphQL, key read with `security` (macOS)
   or `secret-tool` or the 0600 file (Linux), pages of 50, dated cache,
   errors as named states. `scripts/linear-key.sh` stores the key without
   echoing; the user runs it (or pastes into a secure prompt) when this phase
   starts.
2. `mods/bw-linear` in the chosen slot: grouped list, search, issue view in
   the chosen style, Attach.
3. Composer chips in `bw-chat`: hover preview, text built at Send, the 8 KB
   rule with `hc put` for long descriptions.
4. Done check 5.

## Phase 7: measure and finish

1. Time `bw feed` and `bw diff files` on the user's largest real logs and
   repositories, locally and on macmini. Add a watcher only past 100 ms CPU
   per 2 s poll; otherwise record the numbers.
2. `RECIPE.md` for the layout and a preview image.
3. Rerun all done checks, run `independent-review` on the whole change, fix,
   rerun affected checks, refresh the plan page with each check's result.

## Order and why

The browser spike comes first because the user calls the browser
indispensable and its route changes phase 4's work. The sidebar is the first
built feature because it needs no Rust and is where the chat's agent gets
picked (the user's choice). The chat and its sub-agents come next because the
brief puts them first and they carry the largest risk. The browser follows
because agents drive it from the chat. The diff viewer is self-contained and
can move earlier if phase 3 stalls. Linear comes last because it needs the
chat's composer.
