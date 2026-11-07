# Bellwether phase 2: chat tabs, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "+" starts a Claude or Codex chat on the space's machine; the chat tab reads the agent's session log through `bw feed` (user bubbles, markdown replies, one sentence per tool run, a changed-files line, inline pictures), sends messages through `bw send` with its conversation guard, and flips to the agent's terminal with `⌘J`.

**Architecture:** The vendored `herdr-core` parses logs and finds a terminal's log; three reviewed changes make it skip Codex sub-agent rollouts, honour `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, and read Codex 0.167's records. `bw` adapts Flockbook modfeed's tail, rows and cursor-and-splice feed, and adds per-terminal root memory, `bw locate`, a window-side `bw send` and `bw picture`. `bw feed` runs on the space's machine through phase 0's `shared/helper.js`; `bw send` and `bw picture` run on the window machine with a `machine/t` address. In JavaScript, a pure `shared/chat-tabs.js` decides how a new tab becomes a chat tab and how `⌘J` flips it; `bw-new` records a pending chat, `bw-tabs` (always shown) adopts the new tab and handles `bw-tabs.chat-flip`, and `bw-chat` draws one chat.

**Tech Stack:** Rust 1.99.1 (edition 2021) with the vendored `herdr-core` as a path dependency, serde, chrono, unicode-segmentation; JavaScript ES modules for Herdr's gpui-kit runtime (herdr-app 0.1.13 API copy); Bun 1.4.4; POSIX `sh`; `hc` 0.1.18; real `claude` 2.1.319 and `codex` 0.167.0 for the verify script.

**Spec:** `docs/specs/2026-11-06-bellwether-design.md` revision 4 (Seamless machines; Tabs; Chat, including "Sources and parsing" and "Sending and answering"; done check 2; Risks 1, 2, 6), with the build amendment log at the end of `docs/specs/2026-11-06-bellwether-design-intent.md`; phase plan `docs/plans/2026-11-06-bellwether-phases.md`, phase 2; phase 0 plan and spike note `docs/research/2026-11-06-phase0-spike.md`; phase 1 plan `docs/plans/2026-11-06-bellwether-phase-1.md` (harness, `bw-tabs`, `bw-new`, `shared/`).

## Build environment (macmini, 2026-11-06)

- Phase 0's and phase 1's build environment applies: no `herdr-app`, no `~/.config/herdr-app`, `hc` 0.1.18, PATH prefix `/opt/homebrew/opt/rustup/bin`. Window checks go to `docs/drafts/herdr-window-checks.md`.
- Phase 1 is merged into `main` (PR #3, `a333ce7`). Phase 2 works on branch `phase-2-chat`, cut from `main` at that merge, and its worktrees branch from `phase-2-chat`. Names this plan cites from the phase 1 plan (`mount`, `createPoke`, `menuEntries`, `tabItems`, `mergeKeys`, `statusIcon`, `ICONS`) are checked against the merged code before use; where the code differs, follow the code and note it in the commit body.
- `hc run --on bwloop` works (probe, this session): `hc run --on bwloop --bg --name bw-p2-probe --no-parent --no-notify -- sh -c 'echo HOME=$HOME; cat'` printed `{"address":"bwloop/t1",…,"cwd":"/Users/dkishore/.bwl"}`; `hc send bwloop/t1 hello-probe` from the user's core delivered the text (`hc read bwloop/t1` showed it); `hc get bwloop/t1 --json` gave `argv`, `cwd`, `pid`, `foreground {argv, cwd, name, pid}`; `hc exec --on bwloop hc ls --json` listed the same terminal as `t1`, so a helper on bwloop sees its own core's local address. The probe was killed and removed.
- `hc send` parses a text that starts with `-` as its own option: `hc send --json bwloop/t2 "--force"` failed with "the following required arguments were not provided: <TEXT>", while `hc send --json -- bwloop/t3 "--force -x"` delivered `--force -x` literally (probe, this session; both probe terminals removed). `bw` therefore always puts `--` before the address and text.
- bwloop's core is started by the user's core, which runs in the Background launchd session and cannot read the login keychain (spike note, section 3), so Claude cannot log in there. Codex reads `auth.json`, not the keychain. The remote half of the verify script therefore runs Codex on bwloop with a scratch `CODEX_HOME` holding a copy of `~/.codex/auth.json`, deleted on exit, as the spike did. Claude on another machine is owed to a window run.
- A crate outside `crates/vendor`'s workspace can depend on `herdr-core` by path: a scratch crate with `herdr-core = { path = "…/crates/vendor/herdr-core" }` passed `cargo clippy --all-targets -- -D warnings` (this session); Cargo resolved the vendored manifest's `*.workspace = true` keys from `crates/vendor/Cargo.toml`, and clippy linted only the scratch crate.

## Open questions settled

1. **Modfeed: adapt or write anew.** Adapt `protocol.rs` (`JsonLines`, `fnv1a`), `tail.rs` (whole), `rows.rs` (rows, separators, footers, `pics`) and `feed.rs` (cursor, splice, `--before`) with small changes listed in Tasks 2 and 5. Rewrite `locate.rs`: it snapshots the core through the socket client and resolves every pane in one pass with one shared cache file (`flockbook-modfeed/src/locate.rs:117-155`); Bellwether calls `hc get` once, resolves one terminal, and keeps one cache file per terminal so concurrent polls of different chat tabs never overwrite each other's state. Take from `status.rs` only its log fallback, `tail::model`, which already lives in `tail.rs`; the status-line wrapper is Flockbook's own. Write anew: `bw send` (keeps the guard of `cards.rs:310-325`, delivers with the `hc` CLI), `bw picture`, tool sentences, the changed-files row, cache pruning.
   Evidence: `feed.rs` keeps no process and stores row hashes per terminal (`feed.rs:1-5`); `cli.rs:236-245` builds an `HcClient` socket client, while phase 0 chose the `hc` CLI through `BW_HC` for testability (phase 0 decision 6).
2. **`bw feed` protocol.** JSON lines, no header or end line (phase 0's style, which `shared/helper.js` already parses). `bw version` reports `protocol: 2` and `version: "0.2.0"`, and `shared/helper.js` asks for both, so every machine's helper is reinstalled once automatically. Lines: `log` (agent, terminal, session, path, start, size, cursor, model), then `unchanged`, or `splice {at, count}` followed by the rows from `at` on; or one `state` line (`no_core`, `no_terminal`, `not_agent`, `no_log`, exit 0) when there is nothing to read. The cursor is `2.<fnv(path)>.<start>.<size>.<fnv(row hashes)>.<p>` with `p` 1 for a `--pictures` read; a cursor from another path, range or mode reads as none and gets `splice 0`. Only real failures print `{"type":"error"}` (usage exit 2, others exit 1), which `helper.js` names `failed`.
   Evidence: `shared/helper.js:110-126` (an error line becomes `failed`, any non-JSON line `bad_output`); `feed.rs:28-36` (cursor), `:79-111` (splice).
3. **How `bw feed` finds a terminal's log.** On the space's machine, `bw` runs `hc get <t> --json` and builds a `herdr-core` pane with `hc::mapper::Term::parse` and `mapper::pane`; only `claude` and `codex` kinds go on (else `not_agent`). The per-terminal cache `~/.cache/bellwether/feeds/<core>/<terminal>.json` (`<core>` is `HC_SESSION`, else `default`) remembers the root: kind, pids, agent pid, path, session, checked time. A root younger than 30 s with the same pids and an existing file is used without a process scan. Otherwise `bw` lists processes once, finds the agent process (`resolver::hc_agent_process`), reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME` from that process's environment in its `ps -E` line (then from `bw`'s own environment, then `~/.claude` and `~/.codex`), sets the resolver's `claude_dir`, `projects_dir` and `codex_dir`, and resolves that one terminal with the paths of other live terminals' cache entries as `claimed` (live by one `hc ls --json`). When the resolver gives no answer and the agent pid is unchanged, the remembered root stays; a different definite answer (Claude `/clear` or Codex `/new`) replaces it. Claude paths follow `continued-in`. Files in `feeds/` older than 7 days are deleted on each write.
   Evidence: `herdr-core/src/resolver.rs:40-46` (`Proc.line` holds the environment), `:245-262` (dirs are fields), `:520-528` (hc Claude: `<claude_dir>/<pid>.json`); `session_log.rs:156-158` ("no `CODEX_HOME` / `CLAUDE_CONFIG_DIR` here"); spec "Defaults nobody discussed" (feeds 7 days).
4. **Vendored-core change for root discovery.** Codex 0.167 runs a sub-agent in the parent's process and writes it a rollout in the same folder with the same cwd, so today both the open-files route and the cwd route see two candidates and return none (`resolver.rs:935` takes exactly one hit; `:570-583` needs exactly one candidate; `codex_meta_data` ignores `source`, `:1118-1131`). Change: `codex_meta_full` reads `id` and whether `session_meta.payload.source` is an object with `subagent`; `codex_candidates`, `codex_matches` and the open files `find` passes to `log_path` skip sub-agent rollouts. Second change, same commit: `log_path_in(open, kind, grok_home, roots: &LogRoots)` takes the Codex sessions and Claude projects roots instead of `home + "/.codex/sessions/"` (`resolver.rs:935`), `find` passes the resolver's own dirs, and `log_path` keeps its signature by calling it with `LogRoots::in_home(home)`. Tests: Task 1's `codex_candidates_skip_subagent_rollouts` and `log_path_in_uses_codex_home_and_skips_children` on the scrubbed `codex-subagent` recording. `UPSTREAM` lists each change with its test.
   Evidence: `tests/fixtures/sessions/codex-subagent/` holds a parent rollout and a child whose `session_meta.source` is `{"subagent":{"thread_spawn":{"parent_thread_id":…}}}`; `REVIEW.md` Focus 8.
5. **Codex 0.167 records.** A third vendored change: Codex 0.167's `exec` (and `js`) tool is JavaScript that calls `tools.exec_command({cmd:"…"})` or `tools.apply_patch("*** Begin Patch…")`. `codex_label` and the call summary classify the input: an `exec_command` call is "Ran a command" with its `cmd` as summary; an `apply_patch` call is "Edited files" with the patch's `*** Add|Update|Delete File:` paths; other code is "Ran a script" / "Ran %d scripts". `spawn_agent` is "Started a sub-agent" / "Started %d sub-agents", `wait_agent` "Waited for a sub-agent" / "Waited for sub-agents %d times". A `response_item` of type `agent_message` becomes a `Status` item: `FINAL_ANSWER` reads "`<sender's last path part>` finished: `<payload, first 200 characters>`", `NEW_TASK` reads "Sent a task to `<recipient's last part>`".
   Evidence: `jq` over `tests/fixtures/sessions/codex-*`: inputs `text(await tools.exec_command({cmd:"touch approved.txt",…}))`, `text(await tools.apply_patch("*** Begin Patch\n*** Add File: /scratch/codex-question/colour.txt…"))`, `const r = await tools.exec_command({cmd:"ls | wc -l",…})`; `agent_message` content `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/count_entries\nPayload:\n2`; `conversation/mod.rs:452` reads only `response_item` and `:567-577` labels `exec` as a command whatever it runs.
6. **Tool-run sentences.** `herdr-core` already groups a run of tool calls into chips with counted text ("Read 3 files", "Ran 2 commands", `conversation/mod.rs:605-640`). `bw` joins a tools row's chip texts into one `sentence`: one chip as it is; two as "A and b"; more as "A, b and c", each chip after the first starting lower case ("Read 3 files and ran 2 commands"). The row also carries `live` (some call has no result yet: spinner) and `error` (some call failed). A turn whose tools edited files ends with a `changed` row ("Changed 2 files", with the paths) before its footer: Claude `Edit`, `MultiEdit`, `NotebookEdit` and `Write` summaries, Codex `apply_patch` paths, distinct, in order.
   Evidence: spec Chat timeline bullet; `rows.rs:283-322` (turn footer, where the changed row goes).
7. **`bw send`.** Runs on the window machine: `bw send --terminal <[machine/]t> --expect-kind <k> --expect-session <id> --expect-path <p> --text <s>`. It learns the terminal's current root by `bw locate` (in process for this machine; `hc exec --on <machine>` running the helper there otherwise), refuses with `refused-conversation` when kind, session or path differ, then runs `hc send --json -- <address> <text>`, never `--force`. Results, one line `{"type":"send","result","message"}`: `sent`; `refused-prompt` when `hc` refuses with `blocked`; `refused-conversation`; `unconfirmed` when `hc send` has not returned after 25 s (it waits for 3 s without typing, and `exec` stops the mod's call at 30 s). `not_found` and `finished` are an error line `no_terminal`; `machine_unknown` and `unavailable` are `unreachable`. The text reaches `hc` as one argv element after `--`: `bw`'s `--text` takes the next argument verbatim even when it starts with `-`, and `hc` reads nothing after `--` as an option; no shell reads it.
   Evidence: the `hc send` probe in Build environment; `hc schema` method `terminal.send`: "Refuses a blocked program unless `force`", errors `not_found`, `machine_unknown`, `finished`, `unavailable`, `blocked`, `status_mismatch`; `hc send --help` takes `machine/t7`; `cards.rs:310-325`; spec "Sending and answering".
8. **Pictures.** `bw feed --pictures` gives each user or tools row `pics: [{format, width, height, offset, index, digest}]` (`rows.rs:52-78`); `bw-chat` always reads with `--pictures` so row ids never change between modes. The window-side `bw picture --terminal <[machine/]t> --offset <n> --index <i> --digest <16 hex>` reads the picture on the space's machine (`bw picture-read` there through `hc exec --on`, which prints one `picture-data` line with base64; locally in process), using the log path that terminal's cache remembers, so no caller passes a path. `herdr-core`'s `log_image::read` rejects a picture whose fingerprint no longer matches. Over 4 MB (`4 * 1024 * 1024` bytes, decoded) it answers `state: "too_big"` and copies nothing. It writes `<app home>/data/bellwether/pictures/<digest>.<format>` (app home: `$HERDR_APP_HOME`, else `~/.config/herdr-app`; folders made 0700) and prints `file` relative to the app home, which is what `image()` takes. The digest is the unique name: the same picture is copied once. Pictures older than 7 days are pruned on each write. Tests set `HERDR_APP_HOME` to a scratch folder, since `~/.config/herdr-app` does not exist on this Mac.
   Evidence: `gpui-kit.d.ts:20284` (`image` reads "from the application's own directory"); `log_image.rs:272-276`; `hc.rs:5` (60 s exec timeout covers a 4 MB transfer); 4 MB of picture is about 5.6 MB of base64, under `exec`'s 8 MiB.
9. **`bw-chat` structure and borrowed JavaScript.** Files in `mods/bw-chat/`: `main.js` (the view: poll loop, state, header, layout), `timeline.js` (rows to elements), `composer.js`, `feedstate.js`, `estimate.js`, `mdblocks.js`, `pictures.js` (which pictures to fetch, one in flight, one try per digest), `target.js` (props to `{machine, terminal, local, kind}`, poll interval, state copy). Adapted from Flockbook at `c0420c7` (MIT, Copyright (c) 2026 Min-Chen Lee), each with a `THIRD_PARTY_NOTICES.md` row in its commit: `feedstate.js` (nearly whole), `estimate.js` (whole, `READ_W` 760 → 736, heights for `tools`, `changed` and picture rows), `mdblocks.js` (whole), `composer.js` (Textarea, Enter sends, Shift-Enter newline; files, paste and status tags dropped), `chat.js` (virtual list opened at the newest row, older rows on scroll-up; cards, top bar, helper card and menus dropped). Not borrowed: `cards.js`, `top.js`, `sidecar.js`, `state.js`.
   Evidence: `flockbook/herdr-app/mods/flockbook/chat.js:1-24` imports cards, top bar and helper card; `feedstate.js:30-64`; `gpui-kit.d.ts:21399` (`TextareaState` with `set_auto_grow`), `:21276` (`v_virtual_list`).
10. **Chat entries in "+".** `run()` returns null (`herdr.d.ts:79`), so `tab.new` gives the caller no tab, pane or terminal id. `bw-new`'s "New chat" rows therefore record a pending chat in `shared("bw.chat-tabs")` (kind, machine, space, the space's tab ids before the call) and then run `tab.new {space, name, argv}` (or `space.new {folder, machine, tab, argv}` without a space). `bw-tabs`, always shown, adopts on render: the first tab in that space that was not there before and has a terminal pane gets `pane.split {direction: "right", pane, mod: "bw-chat", props: {terminal, machine, kind}}`; when the `bw-chat` pane appears, its id is recorded and `pane.zoom {pane}` runs once. A split with no pane after 5 s is tried once more, then the tab stays a terminal tab and a notification says so; a pending chat with no tab after 30 s is dropped with a notification. The agent's argv is `agent.run` from `knownAgents({ on })` unchanged: phase 2 passes no per-session additions, since the only ones the spec names are the browser MCP server and its instructions (phase 4), and a Codex `developer_instructions` addition replaces the user's value unless `bw` first reads that machine's TOML (spike note, section 2). `shared/chat-tabs.js` exports `chatArgv(kind, run, extras = [])` as the place phase 4 adds them.
    Evidence: spec Tabs bullet 4; phase plan phase 4 step 2; phase 1 decision 12.
11. **`⌘J`.** `keys/bellwether.json` gains `"cmd-j": "bw-tabs.chat-flip"` in `layout:bellwether`, merged by phase 1's `scripts/keys-merge.js` (which refuses a key the user bound elsewhere). A terminal-section binding of `cmd-j` would win while the terminal has focus (`AGENTS.md:487`); `keys-merge` reports it as shadowed. `bw-tabs`'s command task only sets `this.flip = true` and calls `cx.notify()`, because tasks never read live data; `render` then reads `panes()` and runs `flipActions`: chat zoomed → `pane.zoom {chat}`, `pane.zoom {terminal}`, `pane.focus {terminal}`; terminal zoomed → the reverse; neither zoomed → zoom and focus the pane that is not focused. A tab that is not a chat tab, or whose terminal pane is gone, gets no action. `bw-chat` is `focusable` and focuses its composer on `"focus"`. The header's `⌘J` hint runs `run("bw-tabs.chat-flip")`.
    Evidence: `AGENTS.md:800` (`<mod>.<command>` reaches shown copies only), `:480-490`; phase 1 Global Constraints (no live reads in tasks).
12. **Hidden-tab polling.** `bw-chat`'s loop sleeps 2000 ms while shown and 10000 ms while not, start to start, and wakes early on a poke. `render` decides shown: its tab is the active tab of the active space and either its pane is zoomed or the tab is not zoomed; a chat behind its terminal's zoom counts as hidden. A change to shown pokes the loop, so flipping back reads at once. Hidden copies stay alive and keep their tasks (`AGENTS.md:795-800`); that a hidden copy re-renders on live changes is owed to the window.
    Evidence: spec Tabs last bullet; phase 1's `createPoke` (`shared/refresh-driver.js`).
13. **The 100 ms CPU rule.** Phase 2 measures and writes no watcher. `scripts/verify/feed-cost.sh` runs `/usr/bin/time -l bw feed --log <file> --agent <k> --pictures` on the largest Claude and Codex logs on this Mac three ways (first read, unchanged cursor, after one appended line on a scratch copy) and records user plus system milliseconds and the file sizes, never paths or content, in `docs/research/2026-11-06-phase2-feed.md`. Phase 7 decides on a watcher.
    Evidence: spec Decisions "Helper model"; phase plan phase 7 step 1.
14. **Done check 2 here and owed.** Runs here: `cargo test -p bw --locked` and the vendored tests (root rows of all six recordings equal their hand counts; a Codex root resolves beside its child; refusals with a fake `hc`), and `scripts/verify/sessions.sh` with real agents (Claude and Codex in a private core on this Mac; Codex on bwloop for the remote half; a send naming the old conversation after `/clear` and after `/new` is refused with the screen unchanged; a missing helper on bwloop is named `missing`, then installed by `bw machine install bwloop`). Owed to the window (Task 12's list): the chat drawn, "+" starting a Codex chat whose process runs on macmini, `⌘J` both ways, hidden polling, pictures shown, Claude on another machine. Children and the tree are phase 3's half of done check 2.
    Evidence: spec done check 2; intent build amendment "in phase 1, done check 1's '+' step runs as 'starts Codex from New terminal'… phase 2… reruns the original wording".

## Spec changes (one line each, for the intent file's amendment log)

- Composer results: add "not sent (`<reason>`)" for a closed terminal or an unreachable machine beside the four named results, because `hc send`'s `not_found`, `finished` and `unavailable` fit none of them.
- Pictures: the copy is named `<digest>.<format>` and pruned after 7 days; add "pictures 7 days" to the cache pruning default, since the folder would otherwise grow without bound.
- Tabs: "+" records a pending chat in `shared("bw.chat-tabs")` and `bw-tabs` adds the chat pane when the new tab appears, because `run("tab.new")` returns no ids (`herdr.d.ts:79`).
- Tabs: a chat pane behind its terminal's zoom counts as not shown and polls every 10 s; flipping back reads at once.
- Tabs: until phase 4, chat agents start with `agent.run` unchanged; the per-session additions arrive with the browser.
- Sources and parsing: Codex 0.167's `exec` and `js` tools run JavaScript; tool lines name the inner `tools.exec_command` and `tools.apply_patch` calls, and `agent_message` records show as status lines.
- Build note (not the spec's words): done check 2's remote half runs with Codex on `bwloop`; Claude on another machine is owed to a window run, because bwloop's core cannot read the keychain.

## Global Constraints

- Mods are named `bw-<name>`; shared state keys start with `bw.`; the new mod is `bw-chat`.
- Mods use only names declared in `herdr.d.ts` and `gpui-kit.d.ts`; no `setTimeout`, no DOM, no top-level `await`, no `cx` kept past its callback.
- No mod reads `agents()`, `spaces()`, `panes()`, `terminals()` or `focused()` from a timer, a spawned task or a `nextCommand` loop; commands that depend on live data run from `render` or an event handler, and every one that `render` runs is guarded so a second render does not repeat it.
- Polling: a shown chat every 2000 ms, a hidden one every 10000 ms, start to start; no timer under 1000 ms; animation uses `.spin(900)`.
- `bw send` never passes `--force`; it carries `--expect-kind`, `--expect-session` and `--expect-path`; it runs on the window machine with a `machine/t` address for a remote terminal.
- `bw feed`, `bw locate` and `bw picture-read` run on the space's machine (`helper.call(machine, …)`); `bw send` and `bw picture` run on the window machine (`helper.call(null, …)`).
- Values reach `sh -c` scripts only as positional arguments; `hc` gets argv, never a command string.
- Picture cap 4 MB (`4 * 1024 * 1024` decoded bytes); pictures go to `<app home>/data/bellwether/pictures/`; the cache to `~/.cache/bellwether/feeds/`; both pruned at 7 days; no transcript text in any cache (row hashes and paths only).
- Sizes: chat header 36 px; timeline column at most 736 px; user bubbles right-aligned, at most 80 % of the column, radius 16; one line per tool run; the tab bar and "+" menu keep phase 1's sizes (232 px menu, 30 px rows).
- Every change under `crates/vendor/herdr-core` has a test and an `UPSTREAM` line naming it.
- Code copied or adapted from Flockbook gets a `THIRD_PARTY_NOTICES.md` row (file here, source path, commit `c0420c7f9a720631108f2d269dcf9f4bd62634ff`, "adapted" or "copied") in the same commit. Several tasks add rows to that one file; merges keep every row.
- Tests live outside `mods/`; JavaScript tests run through phase 1's harness (`tests/harness/mount.js`); Rust tests use `BW_HC` with `crates/bw/tests/fake-hc`, `BW_CACHE_DIR` and `HERDR_APP_HOME` scratch folders.
- Agents in verify scripts run in scratch folders under `/private/tmp/claude-501/`, in a private core (`HC_SESSION=bw-sessions`), started from the script's shell with `env -i` as `record-session` does; never in this repository; nothing they write enters the repository.
- Before every commit: `git diff --cached --stat` lists only the intended files; else `git reset -q` and stage again. Conventional commits, about 50-character titles, bodies wrapped at 72.

## Review Focus

1. Two Codex terminals in one folder started seconds apart, one with a sub-agent: each chat shows its own root, never the other's or a child's. Test in Task 7 (`other_live_terminals_paths_are_claimed`).
2. A message that starts with `-`, holds a newline, quotes, `$(…)` or `--force`: it reaches the agent byte for byte and `hc` is never given `--force`. Tests in Task 9 (`send_types_text_verbatim`) and Task 11 (`claude-send-verbatim`).
3. The agent exits and its terminal pane closes while the chat pane stays: the chat says "Claude exited" with a Close tab button, the composer is disabled, and `⌘J` runs nothing. Tests in Task 6 (`terminal gone: flip does nothing`) and Task 8 (`terminal gone is named`).
4. A log whose last line is still being written, or a log replaced by a shorter one: the feed never shows half a line, and a shrunk file gets `splice 0` with fresh rows. Tests in Task 5 (`partial_last_line_is_left_for_next_read`, `shrunk_log_restarts_at_zero`).
5. A picture over 4 MB, one whose fingerprint no longer matches, or a machine that goes offline mid-fetch: a named placeholder ("Picture too large (5.1 MB)", "Picture unavailable"), one try per digest per chat, never a broken image. Tests in Task 10 (`over_cap_is_too_big`, `digest_mismatch_is_gone`) and Task 8 (`pictures: one fetch per digest, named placeholders`).

---

## Tasks and waves

Tasks in one wave touch different files (except appended `THIRD_PARTY_NOTICES.md` rows) and run in parallel T3 worktrees; each wave merges before the next starts.

| Wave | Task | Depends on |
|---|---|---|
| A | 1 Vendored core: Codex roots, log roots, Codex 0.167 records | phase 1 merged |
| A | 2 Helper 0.2.0, chat command frame, `hc` calls | phase 1 merged |
| A | 3 `shared/chat-tabs.js` | phase 1 merged |
| A | 4 `bw-chat` pure modules (feedstate, estimate, mdblocks) | phase 1 merged |
| B | 5 `bw feed` rows, sentences, cursor and goldens | 1, 2 |
| B | 6 "+" chat entries, adoption and `⌘J` in `bw-new` and `bw-tabs` | 3 |
| C | 7 `bw locate` and `bw feed --terminal` | 1, 2, 5 |
| C | 8 `bw-chat` mod | 3, 4, 5 |
| D | 9 `bw send` | 2, 7 |
| D | 10 `bw picture` and `bw picture-read` | 2, 5, 7 |
| E | 11 Done check 2 verify script and feed cost | 7, 9, 10 |
| F | 12 Phase checks | all |

### Task 1: Vendored core changes (wave A)

**Files:**
- Modify: `crates/vendor/herdr-core/src/resolver.rs`, `crates/vendor/herdr-core/src/conversation/mod.rs`, `crates/vendor/herdr-core/UPSTREAM`, `THIRD_PARTY_NOTICES.md` (the `crates/vendor/herdr-core/` row's "How" becomes "copied, then changed as `UPSTREAM` lists")
- Create: `crates/vendor/herdr-core/tests/bellwether.rs`

**Interfaces:**
- Produces in `herdr_core::resolver`:
  - `pub struct CodexMeta { pub id: String, pub cwd: String, pub start: Date, pub subagent: bool }`, `pub fn codex_meta_full(first_line: &[u8]) -> Option<CodexMeta>`; `codex_meta_data` keeps its signature and calls it.
  - `pub struct LogRoots { pub claude_projects: String, pub codex_sessions: String, pub cursor_projects: String, pub pi_dir: String }`, `impl LogRoots { pub fn in_home(home: &str) -> LogRoots }`.
  - `pub fn log_path_in(open_files: &[String], kind: &str, grok_home: Option<&str>, roots: &LogRoots) -> Option<String>`; `log_path` unchanged in signature and result.
  - `codex_candidates` and `codex_matches` skip rollouts whose meta has `subagent`; `SessionResolver::find` drops open Codex files whose first line is a sub-agent's (read with the existing 1 MB prefix) before `log_path_in`, which gets `codex_sessions: self.codex_dir`, `claude_projects: self.projects_dir`.
- Produces in `herdr_core::conversation`: `codex_label` and the Codex call summary as decision 5; `agent_message` records as `ItemKind::Status`.

- [ ] **Step 1: Write the failing tests** in `tests/bellwether.rs`. Fixtures come from `concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/fixtures/sessions/")`. The Codex rollouts are copied into a temp `sessions/YYYY/MM/DD/` folder under names built from each `session_meta` timestamp in local time (`rollout-<local %Y-%m-%dT%H-%M-%S>-<id>.jsonl`), so the test does not depend on the recorder's time zone.

```rust
#[test] fn codex_candidates_skip_subagent_rollouts() {
    // parent and child of codex-subagent copied in; cwd "/scratch/codex-subagent"; after = parent start - 1 s
    assert_eq!(names(codex_candidates(&dir, "/scratch/codex-subagent", after, after + Duration::hours(1))),
               vec![parent_name]);
}
#[test] fn log_path_in_uses_codex_home_and_skips_children() {
    let roots = LogRoots { codex_sessions: format!("{tmp}/codex-home/sessions"), ..LogRoots::in_home("/nohome") };
    // open files: parent and child rollouts under that root, filtered as find() filters them
    assert_eq!(log_path_in(&open_without_children, "codex", None, &roots), Some(parent_path));
    assert_eq!(log_path(&open_without_children, "codex", None, "/nohome"), None);
}
#[test] fn codex_meta_full_reads_id_and_subagent() { /* child: subagent true, id 01a1b4a1-dfcb-…; parent: false */ }
#[test] fn codex_exec_command_is_a_command() { /* codex-approval: one chip "Ran a command", call summary "touch approved.txt" */ }
#[test] fn codex_exec_apply_patch_is_an_edit() { /* codex-question: chips "Edited files" with summaries "/scratch/codex-question/colour.txt", then ".../size.txt" */ }
#[test] fn codex_spawn_and_wait_labels() { /* codex-subagent parent: chips "Started a sub-agent", "Waited for a sub-agent" */ }
#[test] fn codex_agent_message_is_a_status() { /* codex-subagent parent: a Status item "count_entries finished: 2" */ }
#[test] fn other_exec_code_is_a_script() { /* synthetic custom_tool_call exec with input "text(1+1)" → "Ran a script" */ }
```

- [ ] **Step 2:** Run `cargo test --manifest-path crates/vendor/Cargo.toml --locked --target-dir target/vendor --test bellwether`. Expected: FAIL (names missing).
- [ ] **Step 3:** Implement the changes in `resolver.rs` and `conversation/mod.rs`. Inner-call parsing uses the crate's existing `regex` dependency: `tools\.exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"` (JSON-unescape the capture) and `tools\.apply_patch\(` with `\*\*\* (?:Add|Update|Delete) File: (.+)` on the unescaped argument. With several inner calls, an `exec_command` decides the label and the summary is the first command plus " (+N more)".
- [ ] **Step 4:** Run every vendored test: `cargo test --manifest-path crates/vendor/Cargo.toml --workspace --locked --target-dir target/vendor`. Expected: PASS, upstream tests unchanged.
- [ ] **Step 5:** `UPSTREAM` "Changes:" replaces "None." with three dated lines: what changed in which file and the test that pins it (`codex_candidates_skip_subagent_rollouts`, `log_path_in_uses_codex_home_and_skips_children`, `codex_meta_full_reads_id_and_subagent`; the four Codex record tests). Update the notices row.
- [ ] **Step 6: Commit** `fix(vendor): find Codex roots beside sub-agents` (body: the three changes and their tests).

### Task 2: Helper 0.2.0, the chat command frame and `hc` calls (wave A)

**Files:**
- Modify: `crates/bw/src/machine/mod.rs` (`RUN_HELPER` becomes `pub(crate)` for Tasks 9 and 10; nothing else there changes), `crates/bw/Cargo.toml` (version `0.2.0`; dependencies `herdr-core = { path = "../vendor/herdr-core" }`, `chrono = "0.4"`, `unicode-segmentation = "1"`, `serde = { version = "1", features = ["derive"] }`), `Cargo.lock`, `crates/bw/src/version.rs` (`PROTOCOL = 2`), `crates/bw/src/main.rs` (arms `feed`, `locate`, `send`, `picture`, `picture-read` → `chat::run`; usage text), `crates/bw/src/hc.rs`, `crates/bw/tests/fake-hc`, `crates/bw/tests/version.rs`, `shared/helper.js` (`PROTOCOL = 2`, `HELPER_VERSION = "0.2.0"`), `shared/helper.test.js`, the copies of `helper.js` in `mods/bw-*` (by `scripts/sync.sh --shared-only`), `THIRD_PARTY_NOTICES.md` (`chat/protocol.rs`)
- Create: `crates/bw/src/chat/mod.rs`, `chat/args.rs`, `chat/cache.rs`, `chat/protocol.rs`, and stubs `chat/feed.rs`, `chat/locate.rs`, `chat/send.rs`, `chat/picture.rs`

**Interfaces:**
- Produces `chat::run(cmd: &str, args: &[String]) -> ExitCode`, dispatching to `feed::run`, `locate::run`, `send::run`, `picture::run`, `picture::run_read`. Each stub prints `{"type":"error","code":"not_built","message":"<cmd> arrives in a later task"}` and exits 1; Tasks 5, 7, 9, 10 replace only their own file.
- Produces `chat/args.rs`: `pub struct Args`, `pub fn parse(args: &[String], flags: &[&str], options: &[&str]) -> Result<Args, String>`, `Args::get(&self, name: &str) -> Option<&str>`, `Args::has(&self, flag: &str) -> bool`. `--text` takes the next element verbatim; any other value that is empty or starts with `-` is an error; an unknown or repeated option is an error.
- Produces `chat/protocol.rs` (adapted from modfeed `protocol.rs`): `JsonLines { lines }`, `emit`, `emit_value`, `raw`, `text`; `fnv1a(&str) -> String`.
- Produces `chat/cache.rs`:
  - `pub struct Root { pub kind: String, pub pids: Vec<i32>, pub agent_pid: Option<i32>, pub path: String, pub session: String, pub checked_ms: i64 }`
  - `pub struct TerminalCache { pub version: u32 /* 1 */, pub root: Option<Root>, pub feed: Option<serde_json::Value> }` (serde, unknown fields ignored)
  - `pub fn cache_dir() -> PathBuf` (`$BW_CACHE_DIR`, else `$HOME/.cache/bellwether`), `pub fn core_name() -> String` (`HC_SESSION`, else `default`), `pub fn terminal_file(terminal: &str) -> PathBuf` (`feeds/<core>/<terminal>.json`, characters outside `[A-Za-z0-9_-]` as `_`), `pub fn log_file(path: &Path) -> PathBuf` (`feeds/log/<fnv1a(path)>.json`)
  - `pub fn read(file: &Path) -> TerminalCache` (missing or broken → default), `pub fn write(file: &Path, c: &TerminalCache) -> std::io::Result<()>` (temp file then rename, file 0600, folders 0700, then `prune`), `pub fn prune(dir: &Path, max_age: Duration)` (7 days), `pub fn roots_except(core_dir: &Path, terminal: &str) -> Vec<(String, Root)>`
- Produces `chat/locate.rs` (stub, signatures final): `pub struct Located { pub terminal: String, pub agent: String, pub session: String, pub path: PathBuf, pub pid: Option<i32>, pub status: Option<String> }`, `pub enum LocateFailure { NoCore(String), NoTerminal(String), NotAgent(String), NoLog { agent: String } }`, `impl LocateFailure { pub fn state_line(&self) -> serde_json::Value }` (`{"type":"state","state":"no_core"|"no_terminal"|"not_agent"|"no_log","agent"?,"message"}`), `pub fn locate(terminal: &str, now_ms: i64) -> Result<Located, LocateFailure>` (stub returns `NoCore("not built")`), `pub fn run(args) -> ExitCode`.
- Produces in `hc.rs`: `pub fn hc_get(address: &str) -> Result<Value, HcError>` (`hc get <address> --json`), `pub fn hc_ls() -> Result<Value, HcError>` (`hc ls --json`), `pub fn hc_send(address: &str, text: &str, timeout: Duration) -> Result<Value, HcError>` (argv exactly `send --json -- <address> <text>`, killed after `timeout` → `HcError::TimedOut`). `HcError` gains `Refused { kind: String, message: String }` for `blocked`, `not_found`, `finished`, `status_mismatch`, and `TimedOut`. Each has a `*_with(program: &OsStr, …)` form the unit tests call, so no test sets `BW_HC` in-process.
- Produces in `fake-hc`: `get <addr>` prints `$FAKE_HC_GET_DIR/<addr with / as _>.json` or fails `not_found` (exit 1); `ls` prints `$FAKE_HC_LS` (a file) or `{"terminals":[]}`; `send [--json] -- <addr> <text>` (refused with `usage` when `--` is missing or `--force` comes before it) appends `send <addr> <text>` to the log, sleeps `${FAKE_HC_SEND_SLEEP:-0}`, then fails with `$FAKE_HC_SEND_FAIL` as kind when set, else prints `{"started":1,"status":"working","turn":1}`; `exec` prints the file `$FAKE_HC_EXEC_OUT` as stdout instead of running when it is set. `--on` is optional for `get`, `ls` and `send`.

- [ ] **Step 1: Write the failing tests**: `crates/bw/tests/version.rs` expects `protocol == 2` and `version == "0.2.0"`; a new integration test `bw feed` prints `code == "not_built"`; unit tests in `args.rs` (`text_value_may_start_with_dash`, `other_value_may_not`, `unknown_option_is_refused`, `repeated_option_is_refused`), `cache.rs` (`round_trip`, `broken_file_reads_as_empty`, `prune_removes_only_old_files`, `terminal_names_are_safe_file_names` for `macmini/t5` and `../x`), `hc.rs` (`get_parses_json`, `send_argv_is_double_dash_address_text` for the text `--force -x`, `blocked_is_refused_with_kind`, `slow_send_times_out` with the fake and a 1 s timeout); `shared/helper.test.js` expects `HELPER_VERSION` `"0.2.0"` and an old `0.1.0` helper read as `outdated`.
- [ ] **Step 2:** Run `cargo test -p bw --locked` (first `cargo build -p bw` to update `Cargo.lock`) and `bun test shared/helper.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. `protocol.rs` gets its notices row.
- [ ] **Step 4:** Run `scripts/sync.sh --shared-only`, then `scripts/test.sh`. Expected: exit 0; `git status` shows each mod's `helper.js` copy changed with its source.
- [ ] **Step 5: Commit** `feat(bw): add the chat command frame for helper 0.2.0`.

### Task 3: `shared/chat-tabs.js` (wave A)

**Files:**
- Create: `shared/chat-tabs.js`, `shared/chat-tabs.test.js`, `tests/fixtures/live/chat-tab.json`

**Interfaces:**
- Produces (pure, no Herdr imports):

```ts
ChatTabs = { version: 1, tabs: { [tabId]: Entry }, pending: Pending[] }
Entry = { tab, space, machine: string|null, kind: "claude"|"codex", terminal, terminalPane, chatPane: string|null,
          split: { at: number, tries: number } | null, zoomed: boolean, failed: boolean, created: number }
Pending = { id, kind, machine: string|null, space: string|null, folder: string|null,
            beforeTabs: string[], beforeSpaces: string[], name, at: number }
```

  - `CHAT_PENDING_MS = 30000`, `SPLIT_RETRY_MS = 5000`.
  - `readChatTabs(value) → ChatTabs` (anything else reads as empty).
  - `addPending(value, p: Omit<Pending, "id">, now) → ChatTabs` (id `p-<now>-<n>`).
  - `adopt(value, spaces, panes, now) → { next: ChatTabs | null, actions: [cmd, args][], notices: { title, body }[] }`; `next` null means unchanged, so the caller writes `setShared` only on change. Rules: a pending with a space adopts the first tab of that space not in `beforeTabs` and not already an entry, once one of its panes has a terminal; without a space, the first tab of a new space (not in `beforeSpaces`) on that machine. Adoption yields `["pane.split", { direction: "right", pane: terminalPane, mod: "bw-chat", props: { terminal, machine, kind } }]` and `split {at: now, tries: 1}`. An entry with `chatPane` null and a `bw-chat` pane in its tab records it and yields `["pane.zoom", { pane }]` once (`zoomed` true). No chat pane by `split.at + SPLIT_RETRY_MS`: split again once (`tries: 2`); after that `failed: true` and a notice "Chat pane did not open; the agent keeps running in this tab". A pending older than `CHAT_PENDING_MS` is dropped with "<Agent> chat did not start". Entries whose tab is gone are dropped. Ids are used as Herdr gives them (remote ids keep their `machine/` prefix).
  - `flipActions(value, activeTabId, panes) → [cmd, args][]` (decision 11).
  - `entryForTerminal(value, terminal) → Entry | null`; `isShown(entry, spaces, panes) → boolean` (decision 12).
  - `chatArgv(kind, run, extras = []) → string[]` (`[...run, ...extras]`).
- Produces `tests/fixtures/live/chat-tab.json` (phase 1 fixture format): space `s1` active with chat tab `tb8` (terminal pane `p8` with terminal `t8`, a Claude agent working; mod pane `p9` `bw-chat`, zoomed, `tb8.zoomed` true) and terminal tab `tb7`; remote space `macmini/s3` with chat tab `macmini/tb5` (terminal `macmini/t5` Codex, mod pane `macmini/p6`); `shared["bw.chat-tabs"]` holding both entries; `exec` answers for `bw feed` from Task 5's goldens are added by Task 8.

- [ ] **Step 1: Write the failing tests**:

```js
test("adopts the new tab once, then records the chat pane and zooms once", () => {
  let s = addPending(null, { kind: "claude", machine: null, space: "s1", folder: null, beforeTabs: ["tb7"], beforeSpaces: [], name: "Claude" }, 0);
  const r1 = adopt(s, spacesWithNewTab, panesTerminalOnly, 100);
  expect(r1.actions).toEqual([["pane.split", { direction: "right", pane: "p8", mod: "bw-chat", props: { terminal: "t8", machine: null, kind: "claude" } }]]);
  expect(adopt(r1.next, spacesWithNewTab, panesTerminalOnly, 200).actions).toEqual([]);   // second render: no second split
  const r3 = adopt(r1.next, spacesWithNewTab, panesWithChat, 300);
  expect(r3.actions).toEqual([["pane.zoom", { pane: "p9" }]]);
  expect(adopt(r3.next, spacesWithNewTab, panesWithChat, 400).next).toBe(null);
});
test("split retried once after 5 s, then failed with a notice", …);
test("pending expires after 30 s with a notice", …);
test("no space: adopts the new space's first tab on that machine", …);
test("remote ids keep their machine prefix in props and entries", …);
test("closed tabs are dropped", …);
test("flip: chat zoomed → unzoom chat, zoom and focus terminal; and back", …);
test("flip: neither zoomed zooms the unfocused pane; not a chat tab or no terminal pane: nothing", …);
test("isShown: active tab and zoomed chat; behind the terminal's zoom is hidden; another tab is hidden", …);
test("readChatTabs tolerates null, arrays and junk", …);
```

- [ ] **Step 2:** Run `bun test shared/chat-tabs.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `shared/chat-tabs.js` and the live fixture.
- [ ] **Step 4:** Run the same, then `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): model chat tabs and the flip`.

### Task 4: `bw-chat` pure modules (wave A)

**Files:**
- Create: `mods/bw-chat/feedstate.js`, `mods/bw-chat/estimate.js`, `mods/bw-chat/mdblocks.js`, `tests/mods/bw-chat-pure.test.js`
- Modify: `THIRD_PARTY_NOTICES.md` (three rows)

**Interfaces:**
- Consumes (by shape): Task 5's lines (decision 2, Task 5 Interfaces).
- Produces `feedstate.js` (from Flockbook `feedstate.js`): `emptyFeed(terminal)`, `applyFeed(state, answer) → number` (first changed row index, -1 for none), `applyOlder(state, answer, before) → number`, `olderFrom(state) → number | null`. Changes from the source: a `state` line sets `state.waiting = { state, agent, message }` and keeps rows; `log.session` is kept as `state.session`; a new `path` or `session` empties the rows.
- Produces `estimate.js` (from Flockbook `estimate.js`): `READ_W = 736`, `GUTTER = 24`, `columnWidth(paneWidth)`, `rowHeight(row, width, open = false)`, `sizes(rows, width, open)`. New kinds: `tools` 28 px closed, plus 22 px per call when open; `changed` 28 px; a picture row adds `min(320, width * h / w)` per picture plus 8.
- Produces `mdblocks.js` (copied): `splitBlocks`, `markdownView(id, text, t, width)`, `codeBlockAt`, `codeCopyText`, `tableCells`.

- [ ] **Step 1: Write the failing tests** in `tests/mods/bw-chat-pure.test.js` (imports the three files directly; `mdblocks` through the harness preload, since it imports `gpui-kit`): `splice replaces rows from at`, `unchanged changes nothing`, `a new session empties the rows`, `a state line keeps rows and names the wait`, `older rows go on top once`, `columnWidth caps at 736`, `tools row grows when open`, `picture row height keeps the aspect ratio up to 320`, `splitBlocks finds fences and tables`.
- [ ] **Step 2:** Run `bun test tests/mods/bw-chat-pure.test.js`. Expected: FAIL.
- [ ] **Step 3:** Adapt the three files; add their notices rows (source paths `herdr-app/mods/flockbook/<file>`).
- [ ] **Step 4:** Run the same. Expected: PASS. `scripts/check.sh` still passes (no `main.js` yet, so the mod is not rendered).
- [ ] **Step 5: Commit** `feat(bw-chat): adapt feed state, heights and markdown`.

### Task 5: `bw feed`: rows, sentences, cursor and goldens (wave B)

**Files:**
- Create: `crates/bw/src/chat/tail.rs`, `crates/bw/src/chat/rows.rs`, `crates/bw/src/chat/sentence.rs`, `crates/bw/tests/feed.rs`, `tests/fixtures/feed/<scenario>.jsonl` (six), `tests/fixtures/feed/README.md`
- Modify: `crates/bw/src/chat/feed.rs` (replaces the stub), `THIRD_PARTY_NOTICES.md` (`tail.rs`, `rows.rs`, `feed.rs`)

**Interfaces:**
- Consumes: Task 1's labels; Task 2's `args`, `cache`, `protocol`, `locate::locate`, `LocateFailure::state_line`.
- Produces commands:
  - `bw feed --log <path> --agent claude|codex [--cursor <c>] [--pictures]`: state in `cache::log_file(path)`.
  - `bw feed --terminal <t> [--cursor <c>] [--pictures]`: `locate::locate(t, now)`; on failure prints its `state_line()`; else feeds `located.path` with state in `cache::terminal_file(t)`'s `feed`, and the `log` line names `terminal` and `session`.
  - `bw feed (--terminal <t> | --log <path> --agent <k>) --before <start> [--pictures]`: `{"type":"older","path","start","count"}` plus rows; no state change.
- Produces lines: `log {agent, terminal|null, session, path, start, size, cursor, model?}`, `unchanged`, `splice {at, count}`, and rows:

```json
{"type":"row","k":"user|assistant|tools|changed|perm|question|status|sep|footer","id":"…","text":"…","ts":0,
 "images":1,"pics":[{"format":"png","width":16,"height":16,"offset":0,"index":0,"digest":"<16 hex>"}],
 "chips":[{"symbol","text","calls":[{"name","summary","done","error","output"}]}],
 "sentence":"Read 3 files and ran 2 commands","live":false,"error":false,"files":["…"],"perm":{…},"question":{…}}
```

- Produces `sentence::join(texts: &[String]) -> String`; `rows::rows(items, now, tz) -> Vec<FeedRow>` with `sentence`, `live`, `error` on tools rows and a `changed` row (`id` `c-<last item id>`, `text` "Changed N file(s)", `files`) before each footer whose turn edited files.
- Test knobs read by `feed.rs` only: `BW_NOW_MS` (now) and `BW_TZ=UTC` (else local time), so goldens are stable.
- Goldens: `bw feed --log <root file> --agent <k> --pictures` output for each recording, with `path` and `cursor` removed from the `log` line (they hold the checkout's path).

- [ ] **Step 1: Write the failing tests** in `crates/bw/tests/feed.rs` (copies each recording to a temp folder first; `BW_CACHE_DIR` temp):

```rust
#[test] fn rows_match_hand_counts() {
    for s in ["claude-subagents", "claude-picture", "claude-approval", "codex-subagent", "codex-question", "codex-approval"] {
        let e = expect(s); let rows = feed_rows(s);
        assert_eq!(count(&rows, "user"), e["user_messages"], "{s} user");
        assert_eq!(count(&rows, "assistant"), e["assistant_messages"], "{s} assistant");
        assert_eq!(calls(&rows) + count(&rows, "question"), e["tool_calls"], "{s} tool calls");
        assert_eq!(pics(&rows), e["pictures"], "{s} pictures");
    }
}
#[test] fn tool_sentences() { /* claude-subagents: "Delegated 3 tasks"; codex-subagent: "Started a sub-agent and waited for a sub-agent" */ }
#[test] fn sentence_join_rules() { assert_eq!(join(&s(["Read 3 files", "Ran 2 commands"])), "Read 3 files and ran 2 commands");
    assert_eq!(join(&s(["Read a file", "Searched the code 2 times", "Ran a command"])), "Read a file, searched the code 2 times and ran a command"); }
#[test] fn changed_files_row_ends_an_editing_turn() { /* codex-question: two changed rows, "Changed 1 file", files [".../colour.txt"], [".../size.txt"], each before a footer */ }
#[test] fn live_tool_line_until_result() { /* claude-approval cut after the tool_use line: tools row live true; append the result line and feed with the cursor: splice at that row, live false */ }
#[test] fn unchanged_cursor_prints_unchanged() {}
#[test] fn growth_splices_from_first_changed_row() {}
#[test] fn partial_last_line_is_left_for_next_read() {}   // Review Focus 4
#[test] fn shrunk_log_restarts_at_zero() {}                // Review Focus 4
#[test] fn cursor_from_other_path_or_mode_is_ignored() {}
#[test] fn before_reads_older_rows() {}
#[test] fn goldens_are_current() {}                        // BW_BLESS=1 rewrites tests/fixtures/feed/
#[test] fn terminal_mode_prints_the_locate_state() {}      // stub locate: {"type":"state","state":"no_core"}
```

  If a hand count and the rows disagree, read the log, decide which is wrong, and say so in the commit body; `expect.json` is not edited to match.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test feed`. Expected: FAIL.
- [ ] **Step 3:** Adapt `tail.rs` (whole) and `rows.rs` (add `sentence`, `live`, `error`, `files`, the `changed` row; keep `TEXT_CAP` 20000, `OUTPUT_CAP` 400, `SEPARATOR_GAP_S` 900), write `sentence.rs`, adapt `feed.rs` (cursor version `2` and mode flag; state as `serde_json::Value` in the cache's `feed`; `MAX_SPAN` 8 MB; tail `BYTES` 2 MB). Notices rows.
- [ ] **Step 4:** `BW_BLESS=1 cargo test -p bw --locked --test feed goldens_are_current`, then the whole suite. Expected: PASS. `scripts/verify/scrub-fixture --check tests/fixtures/feed` exits 0. `tests/fixtures/feed/README.md` says how the goldens are made and that Task 8's tests read them.
- [ ] **Step 5: Commit** `feat(bw): feed a session log as chat rows`.

### Task 6: "+" chat entries, adoption and `⌘J` (wave B)

**Files:**
- Modify: `mods/bw-new/entries.js`, `mods/bw-new/main.js`, `mods/bw-new/.shared` (add `chat-tabs`), `mods/bw-tabs/main.js`, `mods/bw-tabs/.shared` (add `chat-tabs`), `keys/bellwether.json`, `tests/mods/bw-new.test.js`, `tests/mods/bw-tabs.test.js`, `tests/keys-merge.test.js` (only if it pins the keys file's content)
- Create: `tests/mods/bw-tabs-chat.test.js`

**Interfaces:**
- Consumes: Task 3 (`addPending`, `adopt`, `flipActions`, `readChatTabs`, `chatArgv`, `tests/fixtures/live/chat-tab.json`); phase 1 `menuEntries`, `mount`, `mergeKeys`.
- Produces in `menuEntries`: a "New chat" section first with rows `chat-claude` "Claude" and `chat-codex` "Codex", enabled and hinted exactly as phase 1's terminal rows for the same agent, with action `["chat", { kind, name: agent.name, argv: chatArgv(kind, agent.run) }]`.
- `bw-new` on a `chat` row: `closeOverlay(props().overlay)`, then `setShared("bw.chat-tabs", addPending(shared("bw.chat-tabs"), { kind, machine, space, folder, beforeTabs, beforeSpaces, name }, Date.now()))` (before-ids from `spaces()` in the click handler), then `run("tab.new", { space, name, argv })` or, without a space, `run("space.new", { folder, machine: machine ?? "", tab: name, argv })`.
- `bw-tabs` render: `adopt(…)`; `setShared` only when `next` is not null; runs `actions` in order; `notify({ title, body, level: "warning" })` per notice. A `nextCommand` task sets `this.flip = true` on `"chat-flip"` and calls `cx.notify()`; render runs `flipActions(…)` for the active tab when `this.flip`, then clears it. A chat tab shows the program icon of its agent (from its terminal pane), not the mod's.
- Produces `keys/bellwether.json`: `{ "layout:bellwether": { "cmd-alt-b": "layout.toggle:right", "cmd-j": "bw-tabs.chat-flip" } }`.

- [ ] **Step 1: Write the failing tests**:

```js
test("entries: New chat rows for installed agents", () => expect(row("chat-codex", { agents: [codex(true)], ctx: { space: "macmini/s3", machine: "macmini", folder: "/home/u/gamma" } }).action)
  .toEqual(["chat", { kind: "codex", name: "Codex", argv: ["codex"] }]));
test("chat click records pending, then tab.new in that space", async () => {
  const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o1" }, live: live("two-machines") });
  await m.click("row-chat-codex");
  expect(m.log.closed).toEqual(["o1"]);
  expect(m.log.shared.at(-1)[1].pending[0]).toMatchObject({ kind: "codex", machine: "macmini", space: "macmini/s3", beforeTabs: ["macmini/tb5"] });
  expect(m.log.run.at(-1)).toEqual(["tab.new", { space: "macmini/s3", name: "Codex", argv: ["codex"] }]);
});
test("bw-tabs adopts the new tab: split, then zoom once across renders", …);
test("⌘J flips chat → terminal and back", async () => { /* nextCommand "chat-flip" on chat-tab.json, flush, render: pane.zoom p9, pane.zoom p8, pane.focus p8 */ });
test("terminal gone: flip does nothing", …);                       // Review Focus 3
test("flip on a terminal tab does nothing", …);
test("expired pending is dropped with a notification", …);
test("keys: cmd-j merges into an empty file and conflicts with a user's cmd-j", …);
test("chat tab shows its agent's icon", …);
```

- [ ] **Step 2:** Run `bun test tests/mods/bw-new.test.js tests/mods/bw-tabs.test.js tests/mods/bw-tabs-chat.test.js tests/keys-merge.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-tabs): start chat tabs and flip them with cmd-j`.

### Task 7: `bw locate` and `bw feed --terminal` (wave C)

**Files:**
- Create: `crates/bw/src/chat/dirs.rs`, `crates/bw/tests/locate.rs`
- Modify: `crates/bw/src/chat/locate.rs` (replaces the stub), `THIRD_PARTY_NOTICES.md` (`locate.rs`: "adapted from `xplat/flockbook-modfeed/src/locate.rs` (`fresh`, `latest`, `absolute`, cache write)")

**Interfaces:**
- Consumes: Task 1 (`log_path_in`, `codex_meta_full`, sub-agent skipping), Task 2 (`hc_get`, `hc_ls`, `cache`, `Located`, `LocateFailure`), Task 5 (`feed --terminal` calls `locate`).
- Produces `dirs.rs`: `pub fn env_value(ps_line: &str, key: &str) -> Option<String>` (the last whitespace-separated `KEY=` word; a value with spaces is not supported), `pub struct AgentDirs { pub claude_config: PathBuf, pub codex_home: PathBuf }`, `pub fn agent_dirs(ps_line: &str, own_env: &HashMap<String, String>, home: &Path) -> AgentDirs`.
- Produces `locate.rs`: `locate` as decision 3, through an inner `pub fn locate_with(term: &Value, procs: &[Proc], open_files: &dyn Fn(&[i32]) -> Vec<String>, cache_file: &Path, claimed: &HashSet<String>, own_env, home, now_ms) -> Result<Located, LocateFailure>` that unit tests drive with fixed processes and files. Session: Claude's file stem; Codex's `codex_meta_full(...).id`. `bw locate --terminal <t>` prints `{"type":"located","terminal","agent","session","path","pid","status"}` or the state line.

- [ ] **Step 1: Write the failing tests**: unit tests in `locate.rs` and `dirs.rs`:

```rust
#[test] fn claude_pid_file_names_the_session() { /* temp CLAUDE_CONFIG_DIR with sessions/<pid>.json {pid, sessionId, procStart} and projects/<slug>/<sid>.jsonl (claude-approval copy) → Located { agent: "claude", session: sid, path } */ }
#[test] fn codex_root_beside_child() { /* open files = parent and child rollouts under a temp CODEX_HOME read from the agent's ps line → the parent, session = its id */ }
#[test] fn codex_home_from_agent_env() { assert_eq!(agent_dirs("node /x/codex CODEX_HOME=/s/ch PATH=/bin", &env(), home).codex_home, PathBuf::from("/s/ch")); }
#[test] fn remembered_root_kept_when_resolver_is_unsure() {}   // same agent pid, two candidates → cached root
#[test] fn new_conversation_replaces_root() {}                 // pid file names a new sessionId → new path and session
#[test] fn other_live_terminals_paths_are_claimed() {}         // Review Focus 1: two codex in one cwd, one with a child
#[test] fn fresh_cache_skips_the_process_scan() {}             // procs closure never called when checked < 30 s
```

  and integration tests in `crates/bw/tests/locate.rs` with `fake-hc`: `get` not found → `state == "no_terminal"`; a `sh` terminal → `not_agent`; hc unreachable → `no_core`; `bw feed --terminal t1` prints the same state line.
- [ ] **Step 2:** Run `cargo test -p bw --locked`. Expected: FAIL.
- [ ] **Step 3:** Implement `dirs.rs` and `locate.rs`. `locate` builds the real inputs: `hc_get`, `resolver::processes()`, `resolver::open_files`, `cache::terminal_file`, `claimed` from `cache::roots_except` limited to terminals `hc_ls` lists as live.
- [ ] **Step 4:** Run `cargo test -p bw --locked` and `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): find a terminal's session log and keep it`.

### Task 8: The `bw-chat` mod (wave C)

**Files:**
- Create: `mods/bw-chat/main.js`, `mods/bw-chat/timeline.js`, `mods/bw-chat/composer.js`, `mods/bw-chat/pictures.js`, `mods/bw-chat/target.js`, `mods/bw-chat/mod.json`, `mods/bw-chat/.shared`, `mods/bw-chat/icons/{terminal,file,edit,search,web,agent,tool,send,picture,changes}.svg`, `tests/mods/bw-chat.test.js`, `tests/fixtures/live/chat-remote.json`
- Modify: `tests/harness/kit-stub.js` (`TextView`, `Textarea`, `TextareaState`, `v_virtual_list`, `VirtualListScrollHandle`, `Scrollbar`, each refusing undeclared methods as phase 1's stubs do), `tests/harness/mount.js` (`image` paths under `data/bellwether/pictures/` accepted), `tests/harness/cx.js` (only if `cx.sleep` does not record its milliseconds), `tests/fixtures/live/props.json` (`bw-chat`: `{terminal: "t8", machine: null, kind: "claude"}`, `{terminal: "macmini/t5", machine: "macmini", kind: "codex"}`, `{}`), `tests/fixtures/live/chat-tab.json` (`exec` answers from the goldens), `THIRD_PARTY_NOTICES.md` (`main.js`/`timeline.js` from `chat.js`, `composer.js`)

**Interfaces:**
- Consumes: Task 3 (`entryForTerminal`, `isShown`, `readChatTabs`); Task 4 modules; Task 5 lines and goldens; Task 9's send line and Task 10's picture lines (by shape, decisions 7 and 8); phase 0 `createHelper`, `parseLines`; phase 1 `createPoke`, `statusIcon`, `programIcon`, `machineTag`, `ago`.
- Produces `target.js`: `targetOf(props) → { machine: string|null, terminal: string, local: string, kind } | null` (`local` drops the `machine/` prefix); `POLL_SHOWN_MS = 2000`, `POLL_HIDDEN_MS = 10000`, `pollMs(shown)`; `waitingText(state, agentName)` (`no_core` "Herdr's core on <machine> is not answering", `no_terminal` "<Agent> exited", `not_agent` "This terminal runs no Claude or Codex", `no_log` "Waiting for <Agent>'s session log"); `sendText(result, agentName)` for `sent`, `refused-prompt` ("Not sent: <Agent> is waiting on a prompt. Answer it in the terminal (⌘J)."), `refused-conversation` ("Not sent: this terminal now shows another conversation."), `unconfirmed` ("Sent, but Herdr did not confirm it in time. Check the terminal (⌘J)."), and failures ("Not sent: <message>").
- Produces `pictures.js`: `createPictures() → { wanted(rows) → Pic[], start(digest), done(digest, line), fileOf(digest) → string|null, stateOf(digest) → "loading"|"too_big"|"gone"|"failed"|null }` with one fetch in flight and one try per digest.
- `main.js`: `init` reads `targetOf(props())`, makes the helper (`localInstall` as `bw-projects` does), the feed state, `createPoke`, `createPictures`, the composer (`TextareaState` with `set_auto_grow(1, 8)`, placeholder "Message Claude…" or "Message Codex…"), and one loop task: `helper.call(machine, ["feed", "--terminal", local, "--pictures", …cursor])`, `applyFeed`, `cx.notify()` when a row changed, then the next wanted picture (`helper.call(null, ["picture", "--terminal", terminal, "--offset", o, "--index", i, "--digest", d])`), then `await Promise.race([cx.sleep(pollMs(this.shown)), poke.wait()])`. Scroll to the top loads `feed --before`. `render` reads live data: `this.shown = isShown(entry, spaces(), panes())` (poke on change), the terminal pane (branch, program, present or gone). Header 36 px: program icon, agent name, branch, `machineTag` when remote, the `⌘J` hint button (`run("bw-tabs.chat-flip")`); the threads button arrives in phase 3. Timeline in a 736 px column (`v_virtual_list` with `sizes`, opened at the newest row): user bubbles right-aligned (80 %, radius 16, `t.raised`), assistant markdown (`markdownView`), tools rows as one line (icon from the first chip's symbol, `sentence`, `.spin(900)` ring when `live`, check when done, error colour when `error`; click toggles the calls: name, summary, output in monospace), `changed` rows ("Changed N files · Open in Changes" → `run("layout.select", { stack: "right-body", child: "changes" })`), pictures (`image(file)` scaled to the column, at most 320 px tall; placeholders "Loading picture…", "Picture too large (5.1 MB)", "Picture unavailable"), `perm` and `question` rows as one notice line "<Agent> is waiting for you · Answer in terminal (⌘J)", `sep` and `footer` in `t.dim`. Composer: Enter sends `helper.call(null, ["send", "--terminal", terminal, "--expect-kind", kind, "--expect-session", state.session, "--expect-path", state.path, "--text", text])`, Shift-Enter adds a line; text starting with `/` goes as typed (slash commands pass through); disabled with the waiting text until the first `log` line, while a send is in flight, and when the terminal is gone; result text under the box; the box clears on `sent` and `unconfirmed` only. Named states fill the timeline: helper `missing`, `installing` ("Setting up Bellwether on <machine>"), `outdated`, `unreachable`, `failed`, `bad_output`, and the feed's `state` lines, each with a "Show terminal (⌘J)" button; "<Agent> exited" adds "Close tab" (`tab.close {id}`). A `"focus"` command focuses the composer. `mod.json`: `{"place":"none","title":"Chat","focusable":true}`. `.shared`: `helper`, `ui`, `refresh-driver`, `chat-tabs`.

- [ ] **Step 1: Write the failing tests** in `tests/mods/bw-chat.test.js` (fake `exec` answering `sh -c … bw feed` with the goldens, `bw send` and `bw picture` with fixed lines):

```js
test("renders a golden: bubble, markdown, tool sentence, changed line", async () => {
  const m = await mount("bw-chat", { props: { terminal: "t8", machine: null, kind: "codex" }, live: live("chat-tab") });
  expect(textOf(m.el)).toContain("Changed 1 file · Open in Changes");
});
test("tool line expands on click to its calls", …);
test("remote chat feeds there with the local address and sends here with the full address", async () => {
  /* chat-remote.json: log.exec has feed with on "macmini" and args containing "t5" (not "macmini/t5"); after typing and Enter,
     a send with on null and args [..., "--terminal", "macmini/t5", "--expect-kind", "codex", "--expect-session", "<id>", "--expect-path", "<p>", "--text", "hi"] */
});
test("named send results; text kept on refusal", …);
test("hidden chat polls every 10 s, shown every 2 s", …);       // cx.sleep durations
test("terminal gone is named, composer disabled, Close tab", …);  // Review Focus 3
test("helper missing on macmini is named, then installing", …);
test("pictures: one fetch per digest, named placeholders", …);   // Review Focus 5
test("no props renders a named state", …);
test("focus command focuses the composer", …);
```

- [ ] **Step 2:** Run `bun test tests/mods/bw-chat.test.js`. Expected: FAIL.
- [ ] **Step 3:** Extend the harness stubs, then implement the mod; notices rows; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS; the stand-in line counts `bw-chat`.
- [ ] **Step 5: Commit** `feat(bw-chat): draw a chat from the agent's log`.

### Task 9: `bw send` (wave D)

**Files:**
- Create: `crates/bw/tests/send.rs`
- Modify: `crates/bw/src/chat/send.rs` (replaces the stub), `THIRD_PARTY_NOTICES.md` (`send.rs`: "the conversation guard of `xplat/flockbook-modfeed/src/cards.rs:310-325`, adapted")

**Interfaces:**
- Consumes: Task 2 (`args`, `hc_send`, `hc_exec`, `HcError`), Task 7 (`locate`, `bw locate` line).
- Produces `bw send` as decision 7. Local address: `locate(t)` in process. `m/t`: `hc_exec(m, ["sh", "-c", RUN_HELPER, "bw", "locate", "--terminal", t])` (phase 0's fixed script), parse the `located` or `state` line. Then `hc_send(address, text, 25 s)` with the full address. `BW_SEND_TIMEOUT_S` overrides 25 for tests.

- [ ] **Step 1: Write the failing tests** with `fake-hc` (`FAKE_HC_GET_DIR` for local terminals; `FAKE_HC_EXEC_OUT` holding a `located` line for `bwloop/t1`; `FAKE_HC_LOG`):

```rust
#[test] fn send_types_text_verbatim() {   // Review Focus 2
    let text = "--force -x \"q\" $(touch /tmp/no) \nline 2";
    let out = bw_send("bwloop/t1", "codex", SID, PATH, text);
    assert_eq!(result(&out), "sent");
    assert_eq!(fake_log_lines("send"), vec![format!("send bwloop/t1 {text}")]);   // one call, no --force before it
}
#[test] fn other_kind_is_refused_conversation() {}      // no send in the log
#[test] fn other_session_is_refused_conversation() {}
#[test] fn other_path_is_refused_conversation() {}
#[test] fn blocked_is_refused_prompt() {}               // FAKE_HC_SEND_FAIL=blocked
#[test] fn finished_terminal_is_no_terminal() {}        // FAKE_HC_SEND_FAIL=finished → error line code no_terminal
#[test] fn unreachable_machine_is_named() {}            // FAKE_HC_OFFLINE=1 → error code unreachable
#[test] fn slow_send_is_unconfirmed() {}                // FAKE_HC_SEND_SLEEP=3, BW_SEND_TIMEOUT_S=1
#[test] fn missing_expectations_are_usage() {}          // each --expect-* is required
```

- [ ] **Step 2:** Run `cargo test -p bw --locked --test send`. Expected: FAIL.
- [ ] **Step 3:** Implement `send.rs`.
- [ ] **Step 4:** Run `cargo test -p bw --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): send a message only to the shown conversation`.

### Task 10: `bw picture` and `bw picture-read` (wave D)

**Files:**
- Create: `crates/bw/tests/picture.rs`
- Modify: `crates/bw/src/chat/picture.rs` (replaces the stub)

**Interfaces:**
- Consumes: Task 2 (`args`, `cache`, `hc_exec`), Task 5 (`pics` fields), Task 7 (the cache's `root.path`); `herdr_core::log_image::{read, Ref}`.
- Produces `bw picture-read --terminal <t> --offset <n> --index <i> --digest <hex>` (space's machine): `{"type":"picture-data","digest","format","bytes","base64"}`, or `{"type":"picture","digest","state":"too_big","bytes"}`, or `state: "gone"` (no cached root, fingerprint mismatch, unreadable). Produces `bw picture --terminal <[m/]t> …` (window machine): local reads in process, remote through `hc_exec(m, ["sh", "-c", RUN_HELPER, "bw", "picture-read", …])`; writes `<app home>/data/bellwether/pictures/<digest>.<format>` unless it exists (then touches its mtime), prunes files older than 7 days, prints `{"type":"picture","digest","file":"data/bellwether/pictures/<digest>.<format>","bytes"}`; offline → `state: "unreachable"`. `MAX_PICTURE = 4 * 1024 * 1024`.

- [ ] **Step 1: Write the failing tests** (`HERDR_APP_HOME`, `BW_CACHE_DIR` temp; the `claude-picture` recording copied and named in a cache entry for `t1`; offset, index and digest from its golden):
  - `local_picture_lands_in_app_home`: the file exists, its bytes equal the decoded base64 of the recording's image block, `file` is relative.
  - `same_digest_is_copied_once`.
  - `over_cap_is_too_big`: a synthetic log line with a 4.1 MB PNG; nothing written. (Review Focus 5)
  - `digest_mismatch_is_gone`. (Review Focus 5)
  - `remote_picture_goes_through_the_helper_there`: `FAKE_HC_ROOT` holds `.local/share/bellwether/helper/current/bw` linked to the test binary and its own cache; the fake's `exec` runs it with `HOME` there.
  - `offline_machine_is_unreachable`.
  - `prunes_pictures_older_than_7_days`.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test picture`. Expected: FAIL.
- [ ] **Step 3:** Implement `picture.rs`.
- [ ] **Step 4:** Run `cargo test -p bw --locked` and `scripts/test.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): copy a log's pictures for the chat`.

### Task 11: Done check 2 verify script and feed cost (wave E)

**Files:**
- Create: `scripts/verify/sessions.sh`, `scripts/verify/sessions-run.js`, `scripts/verify/feed-cost.sh`, `docs/research/2026-11-06-phase2-feed.md`

**Interfaces:**
- Consumes: Tasks 7, 9, 10 (`bw locate`, `bw feed`, `bw send`, `bw picture`); phase 0 `scripts/install-helper.sh`, `bw machine install`, `shared/helper.js`, `scripts/verify/lib-scratch.sh`; the spike's private-core and `env -i` recipes.
- Produces `scripts/verify/sessions.sh [--offline] [--machine M]` printing `PASS <name>` or `FAIL <name>: <why>`, exiting 1 on any FAIL, deleting only scratch folders it made and stopping its private core and terminals on exit. `--offline` runs only the fixture checks (`bw feed --log` on each recording equals its golden), so `scripts/test.sh` runs it. Without `--machine` the remote half is skipped and says so; Task 12 runs `--machine bwloop`.
- `sessions-run.js` builds `createHelper` with an `exec` that runs `hc exec --on M …` (or locally), for the `missing` then installed check.

Checks, with `claude --model haiku` and `codex -m gpt-6-luna -c model_reasoning_effort="low"` in scratch git repositories under `/private/tmp/claude-501/bw-sessions/`, local half in `HC_SESSION=bw-sessions` (started from this shell), trust dialogs answered as the spike did:
- `claude-feed-shows-turn`: `bw send` "Reply with the word PINEAPPLE", `hc wait`, then `bw feed --terminal` rows hold that user row and an assistant row containing PINEAPPLE.
- `claude-send-verbatim`: a message `-- "$(echo no)" --force` arrives as one user row with exactly that text. (Review Focus 2)
- `claude-old-conversation-refused`: note `session`, type `/clear` with `hc send`, wait for `bw locate` to report a new session, then `bw send` with the old `--expect-session`: `result == "refused-conversation"`, `hc read` equal before and after, and no new user row in either log.
- `claude-prompt-refused`: in a `--permission-mode default` session asked to `touch blocked.txt`, once `hc get` reports blocked, `bw send` gives `refused-prompt`, `blocked.txt` is absent and the screen is unchanged; then `hc keys` answers "No" (Escape) and the session ends.
- `claude-picture-copied`: Claude reads a 16×16 PNG; `bw picture` for the row's pic writes `data/bellwether/pictures/<digest>.png` under a scratch `HERDR_APP_HOME`, equal to the source bytes.
- `codex-feed-local` and `codex-root-beside-child`: a Codex session asked to spawn one sub-agent; after the child's rollout exists, `bw locate` reports the parent's id (its `session_meta` has no `parent_thread_id`).
- Remote half (`--machine bwloop`), Codex in `hc run --on bwloop` with `env CODEX_HOME=<scratch with a copy of auth.json> PATH=/opt/homebrew/bin:… codex …` from the user's core: `bwloop-helper-missing-named` (remove the helper's `current` link there; `helper.call("bwloop", ["version"], { install: false })` is `missing`), `bwloop-helper-installed` (`ensure` installs; `bw version` there is protocol 2, 0.2.0), `bwloop-codex-feed` (`bw feed` through the helper there shows the turn), `bwloop-codex-send` (window-side `bw send --terminal bwloop/tN` is `sent` and the reply shows), `bwloop-old-conversation-refused` (`/new` there, then the old session refused, screen unchanged). The scratch `CODEX_HOME` is deleted on exit; a check that `bw locate` there reports `agent: "codex"` fails loudly if the `env` wrapper hides Codex from kind detection.
- `feed-cost.sh` as decision 13.

- [ ] **Step 1:** Write `sessions.sh --offline` first and run it. Expected: PASS lines for the six goldens.
- [ ] **Step 2:** Write the live checks; run `scripts/verify/sessions.sh`. Expected: every local line PASS. A check that fails for a reason in the agent, not Bellwether (a model that will not say the word), gets one rerun; a second failure is reported with its output.
- [ ] **Step 3:** Run `scripts/verify/sessions.sh --machine bwloop`. Expected: every line PASS; `hc ls --json` and `HC_SESSION=bw-sessions hc ls --json` show none of the script's terminals afterwards; the scratch folders and `CODEX_HOME` copy are gone.
- [ ] **Step 4:** Run `scripts/verify/feed-cost.sh`; write the note with the timings and sizes only. `rg -n '/Users/|dkishore' docs/research/2026-11-06-phase2-feed.md` prints nothing.
- [ ] **Step 5: Commit** `test: verify chat feeds and sends with real agents`.

### Task 12: Phase checks (main checkout, after waves A to E)

- [ ] **Step 1:** Merge the wave branches into the phase branch; resolve `THIRD_PARTY_NOTICES.md` by keeping every row; `scripts/sync.sh --shared-only`; `git status` shows no changed shared copy.
- [ ] **Step 2:** Run `scripts/test.sh`, `scripts/verify/install.sh --machine bwloop`, `scripts/verify/sessions.sh --machine bwloop`, `scripts/verify/scrub-fixture --check tests/fixtures`. Expected: exit 0 each.
- [ ] **Step 3:** Update `README.md` (status, `bw feed|locate|send|picture`, `keys/bellwether.json`'s `cmd-j`, `scripts/verify/sessions.sh`) and `AGENTS.md` only where a fact changed, with `doc-updater`.
- [ ] **Step 4:** Append "## Phase 2" to `docs/drafts/herdr-window-checks.md` (untracked):
  - `herdr-app check` on `bw-chat`, `bw-tabs`, `bw-new`; `bun scripts/keys-merge.js` shows `cmd-j` added (or a conflict), then `--apply`; `keys()` lists no other `cmd-j`.
  - From empty state in the window on the MacBook: "+" → New chat → Claude in a local space makes one tab with the terminal and the chat, the chat zoomed; the tab's status icon follows the agent while the chat is zoomed; `agents()` lists the agent; a first message typed in the composer reaches the agent and its reply appears within 3 s of the log line; tool lines read as sentences with a spinner, then a check; a picture the agent reads shows inline.
  - `⌘J` from the chat shows and focuses the terminal; `⌘J` from the terminal shows the chat and focuses the composer; the header hint does the same; an agent line click in `bw-projects` keeps the chat's zoom.
  - Done check 1's original "+" wording: "+" on the macmini space → New chat → Codex, then `hc exec --on macmini pgrep codex` prints a pid; its chat feeds through macmini's helper and sends with the window's `bw send`; the tab carries the machine tag.
  - Claude in a chat tab on macmini (the remote half this Mac could not run): feed, send, refusal after `/clear`.
  - Hidden polling: with two chat tabs, the hidden one's `bw feed` calls arrive every 10 s and the shown one's every 2 s (count `bw` invocations with a wrapper in the stage's `bin`); a hidden copy re-renders when its tab is shown again.
  - Closing a chat tab ends the agent; quitting the agent leaves the chat saying "Claude exited" with Close tab.
  - A pending chat whose agent fails to start shows the 30 s notification; `pane.zoom` on the terminal while the chat is zoomed switches the zoom in one or two calls (record which, for `flipActions`).
- [ ] **Step 5:** Run `independent-review` on the phase diff (Codex reviewer); fix confirmed findings; rerun `scripts/test.sh` and `scripts/verify/sessions.sh --machine bwloop`.
- [ ] **Step 6:** Apply the spec changes above to the spec (Tabs, Chat composer line, Sources and parsing, Defaults) and log each in one line in the intent file's build amendment log with the original wording and the evidence; commit `docs: log phase 2 spec changes`.

## Defaults nobody discussed

- Helper version 0.2.0 and protocol 2, so every machine reinstalls once.
- Tool icons map from `herdr-core`'s chip symbols (`terminal`, `doc.text`, `pencil`, `magnifyingglass`, `globe`, `person.2`, others a wrench) to Bellwether's own SVGs.
- Pictures at most 320 px tall in the timeline, scaled to the column; one picture fetch in flight per chat; one try per digest.
- A pending chat waits 30 s; a missing chat pane gets one retry after 5 s.
- The composer grows from 1 to 8 rows; Enter sends, Shift-Enter adds a line; the text stays in the box on any refusal.
- `unconfirmed` after 25 s of `hc send`.
- Approval and question rows in phase 2 are one notice line pointing to the terminal; the dock is phase 3.
- "Open in Changes" selects the right sidebar's Changes panel, which says "coming in phase 5" until then.
- Codex sub-agent and agent-message lines read "Started a sub-agent", "Waited for a sub-agent", "<name> finished: <answer>".
