# Bellwether phase plan

Status: for the user's approval, 2026-11-06. Built from
`docs/specs/2026-11-06-bellwether-design.md` revision 4; the spec decides
what is built and how it looks, this file decides the order and the steps.
Each phase gets a detailed task plan (superpowers `writing-plans`) when it
starts, so later phases use what earlier ones taught.

Every phase ends with `scripts/sync.sh`, `scripts/check.sh`, a look at the
window (`herdr-app shot`), the phase's done checks on this Mac and on a
macmini space, and one commit per logical change after `git diff --cached
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

## Phase 5: Changes

Usable: the Changes panel with Staged, Changes and Committed on branch
against `origin/main` or any ref, the patch below, and diffs as tabs.

1. `bw diff files|patch|refs|fetch` with the read-only flags and
   `--no-textconv`; one round trip for the lists; pages under 4 MiB; fixture
   repositories from a script, including the textconv marker.
2. `mods/bw-diff`: header with the base picker, age, Fetch and the Merge
   base / Tip switch; the three sections; the patch; "Open as tab".
3. Done check 4.

## Phase 6: Issues

Usable: the Issues panel showing the linked Linear project's issues, inline
issue view, Attach into the chat.

1. `bw linear projects|issues|issue|search` over GraphQL with the key from
   Keychain; pages of 50; dated cache; named errors. `scripts/linear-key.sh`
   (the user pastes the key into a secure prompt).
2. Links per repository in `shared("bw.linear.links")` by normalized
   `origin` URL, else `[machine, common dir]`, moving to the origin key when
   one appears; the link picker with a name-match suggestion, also offered
   from the project menu.
3. `mods/bw-linear`: header, Project, Mine, All filter, search, grouped list,
   inline issue with Attach, Open in Linear, Copy branch name.
4. Composer chips in `bw-chat`: hover preview, text built at Send, the 8 KB
   rule with `hc put`.
5. Done check 5.

## Phase 7: measure and finish

1. Time `bw feed` and `bw diff files` on the largest real logs and
   repositories here and on macmini; add a watcher only past 100 ms CPU per
   2 s poll.
2. `RECIPE.md` and a preview image.
3. Rerun all done checks, `independent-review` of the whole change, fixes,
   affected checks again, and the plan page refreshed with each result.

## Order and why

The foundation installs the helper on macmini first, so every later phase is
checked on both machines from the start, as the user asked. The sidebar and
tab frame come next because they need no Rust and every other part lives
inside them. Chats and their sub-agents carry the most risk and the most
value. The browser follows because it rides on how Bellwether starts chat
agents. Changes and Issues are self-contained right-sidebar panels; Issues
comes last because Attach needs the composer.
