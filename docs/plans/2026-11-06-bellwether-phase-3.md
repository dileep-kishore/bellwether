# Bellwether phase 3: sub-agents and requests, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat shows its session's sub-agents in a threads card, opens each sub-agent's own transcript, and takes the approvals and questions of the agent and its sub-agents in a dock above the composer, pressing keys only into the prompt the card shows, for a space on this Mac or on another machine; the project sidebar counts sub-agents and waiting requests per agent.

**Architecture:** One vendored-core change lets `herdr-core` parse a sub-agent's file as a session of its own. `bw` builds the session tree from Claude's `subagents/*.meta.json` and Codex's `SubAgentActivity` records, feeds a child's transcript (`bw feed --session`), records hook events (`hooks/bw-event` execs `bw event`), installs those hooks (`bw machine setup`), and reads requests (approvals, questions, and Codex's `/new` folder prompt) from the screen, the logs and the events (`bw cards`, also appended to each chat poll by `bw feed --cards --tree`). `bw answer` runs on the space's machine through the helper there, as phase 2's `bw send` does, and checks the conversation with `bw send`'s guard: it re-reads the screen, claims the occurrence, presses the keys, and reads the screen again. In `bw-chat`, pure modules decide the threads rows, the dock cards and the 3 s focus guard; the mod draws them. `bw-projects` reads `bw counts` per machine.

**Tech Stack:** Rust 1.99.1 (edition 2021), the vendored `herdr-core` (path dependency), serde, serde_json with `preserve_order`, `toml` 0.8, `similar` 2 (line diff); JavaScript ES modules for Herdr's gpui-kit runtime (herdr-app 0.1.13 API copy in `docs/drafts/herdr-api/`); Bun 1.4.4; POSIX `sh`; `hc` 0.1.18; real `claude` 2.1.319 and `codex` 0.167.0 for the probe and verify scripts.

**Spec:** `docs/specs/2026-11-06-bellwether-design.md` revision 4 (Chat: threads card, sub-agent views, request dock; Sources and parsing; Sending and answering; Seamless machines, hooks bullet; done checks 2 and 3; Risks 2, 3, 4, 7; Defaults: cache pruning), with every amendment log in `docs/specs/2026-11-06-bellwether-design-intent.md` (interview answer 2: "Answer in chat via keys"); phase plan `docs/plans/2026-11-06-bellwether-phases.md`, phase 3; phase 2 plan `docs/plans/2026-11-06-bellwether-phase-2.md`, whose Interfaces this plan uses as contracts where the build left them unchanged; where it changed them, the merged code, the README's phase 2 sections ("What phase 2 delivers", "The bw helper on each machine") and the intent file's "Amendment log, build" entries of 2026-11-07 win (Build environment lists them); `REVIEW.md` (Focus 1 and Human review paths `hooks/`, `crates/bw/src/machine/`).

## Build environment (macmini, 2026-11-06)

- Phases 0 to 2's environment applies: no `herdr-app`, no `~/.config/herdr-app`, `hc` 0.1.18, PATH prefix `/opt/homebrew/opt/rustup/bin`. Window checks go to `docs/drafts/herdr-window-checks.md` (untracked).
- Phase 2 is merged into `main` (PR #4, `11c22e9`). Phase 3 works on branch `phase-3-requests`, cut from `main` at that merge, and its worktrees branch from `phase-3-requests`. The phase 2 names this plan cites were checked against the merged code (this session): `chat::locate::{locate, locate_fresh, Located, LocateFailure}`, `chat::cache::{cache_dir, core_name, terminal_file, log_file, read, write, prune, roots_except}`, `chat::args::parse`, `chat::protocol::{JsonLines, fnv1a}`, `chat::dirs::{AgentDirs, agent_dirs, codex_home_of_open}`, `chat::tail::{read, read_before, items, items_at}`, `hc::{hc_get, hc_ls, hc_send, hc_exec, HcError}`, `machine::RUN_HELPER` (`pub(crate)`), `mods/bw-chat/{main,target,feedstate,estimate}.js`, `shared/chat-tabs.js`, and `scripts/verify/sessions.sh`, whose checks live in `scripts/verify/sessions-run.js`. Where code merged later differs, follow the code and say so in the commit body.
- What phase 2 shipped that differs from its plan, and that this plan builds on:
  - `bw send` runs on the space's machine through the helper there (`helper.call(t.machine, …)`) with the terminal's local address, because `hc send` from another core types the text as `<hc from="…">…</hc>` and `/new` never runs (commit `45c871a`). `bw answer` runs there the same way, so the screen read, the guard and the key are one local step.
  - `bw send`'s guard (`crates/bw/src/chat/send.rs`, `check` over `locate::locate_fresh`): `--expect-session <id> --expect-path <log>` passes only while a fresh lookup names that session and log; `<id> --expect-path none` passes only while it names that session with no log yet for a live agent of the expected kind (after Claude's `/clear` or Codex's `/new`); `none --expect-path none` passes only while the agent names a positively fresh session; `none` with a log path is a usage error; an `ambiguous` lookup refuses every form. The chat picks the form with `mods/bw-chat/feedstate.js` `expectation(feed, kind)`, which returns null when nothing may be sent.
  - `bw locate` and `bw feed` state lines are `no_core`, `no_terminal`, `not_agent`, `no_log` (with `session` when the agent named its new conversation, which has no log until its first message) and `ambiguous` (no single conversation: no candidate, several, one another terminal claims, or a Codex terminal holding more than one open root thread, as Codex 0.167 does for 60 s after `/resume`).
  - The chat finds its terminal in its own tab (`mods/bw-chat/target.js` `resolveTarget`, commit `17b4b1d`): new chat props are `{terminal, machine, kind, window}`, `window` being the writing app home's `bw.window-id`. `this.target` is a `Found` `{machine, terminal, local, kind, tab, pane}` or null; `terminal` is the address in this window's namespace (what `focused()` and `terminals()` name), `local` the address on the space's machine (what `bw` takes there).
  - The helper is 0.2.0, protocol 2: `crates/bw/Cargo.toml`, `crates/bw/src/version.rs`, `crates/bw/tests/{version,install}.rs`, `shared/helper.js` and its test, and the `<machine>-helper-installed` check in `scripts/verify/sessions-run.js` all name it. Phase 3 moves every one to 0.3.0, protocol 3 (decision 15).
  - macOS 27 hides another process's environment, so `bw locate` takes `CODEX_HOME` from the rollouts the agent holds open (`dirs::codex_home_of_open`) and `CLAUDE_CONFIG_DIR` only from `bw`'s own environment (commit `98cba29`).
  - In a Git repository, Codex 0.167's `/new` stops at a folder prompt, "Where should the new conversation run?", before the new conversation starts. `sessions-run.js` presses Enter there with `hc keys`; a `/new` sent from the chat's composer waits there, and the chat has nothing to answer it with (decision 8 adds it to the dock).
  - `scripts/verify/sessions.sh --offline` prints `PENDING child-rows` and `PENDING tree-nested-subagent`, left for phase 3 (decision 16).
  - Clippy's dead-code lint fails on a stub nothing calls; phase 2 removed its `not_built` stub at the end (commit `deb3d27`).
- The user's core cannot read the login keychain (spike note, section 3). Live checks run in a private core started from the script's shell (`HC_SESSION=bw-requests`, `bw-probe` for the experiment), agents under `env -i` as `record-session` does, in scratch git repositories under `/private/tmp/claude-501/`.
- `bwloop` (from `hc machine ls --json`): `"via": true`, target `env HOME=/Users/dkishore/.bwl sh -c`, HOME `/Users/dkishore/.bwl`, `codex`, `claude` and `jq` on its PATH, no `.codex` or `.claude` folder yet, `~/.local/share/bellwether/helper` present (probe, this session). Its core cannot read the keychain, so Claude there is logged out; Codex reads `auth.json`. The remote half uses Codex there with `CODEX_HOME=/Users/dkishore/.bwl/.codex` holding a copy of `~/.codex/auth.json`, deleted on exit. Task 1 confirms an interactive Codex there answers a prompt.
- The user's `~/.claude/settings.json` (42 KB, 2-space JSON) has 13 hook events, each a group from Orca (`: orca-agent-hook-form=1;` style commands) and, under `PreToolUse`, the user's own `deny-dangerous.sh` group first; `~/.codex/hooks.json` has the same shape with 9 events; Codex 0.167's `hooks` feature is stable and on (`codex features list`). Codex records trust per hook in `~/.codex/config.toml` as `[hooks.state."<absolute hooks.json path>:<snake_case event>:<group index>:<hook index>"]` with `trusted_hash` (and `enabled`). No test or script edits either real file: tests use scratch HOMEs, and every verify script records both files' SHA-256 at start and fails if they changed at exit.

## Open questions settled

1. **The experiment comes first (Task 1).** Before any matcher or hook code, `scripts/verify/requests-probe.sh` runs the real agents in a private core with a recorder hook (a scratch-only script that saves its stdin and the `HC_*` variables) and saves, for each case, the screen while the prompt shows, the hook payloads, `hc get --json` (status and `kind`) and the logs: (a) a Claude foreground sub-agent's Bash approval, (b) a Claude background sub-agent's Bash approval, (c) a Claude root approval answered with `hc keys … 2` (always allow) and one with `esc`, (d) a Codex root approval answered with `y`, then `p`, then `esc`, (e) a Codex sub-agent's approval (`spawn_agent` whose task runs `touch child.txt` under `-a on-request -s read-only`), (f) whether an untrusted Codex `hooks.json` entry runs, what Codex shows to trust it and what `config.toml` gains (scratch `CODEX_HOME` only), (g) whether `meta.json` `finished` is `false` while a Claude child runs, (h) whether `HC_TERMINAL_ID` and `HC_SESSION` in a hook equal what `hc exec` sees, (i) the same Codex root approval on bwloop, (j) Codex 0.167's `/new` folder prompt ("Where should the new conversation run?"), reached by `bw send --text /new` in a scratch Git repository after one turn: its screen, its options and the key each takes, the hc status while it shows, and what `bw locate --fresh` prints while it shows and after each option. The note `docs/research/2026-11-06-phase3-requests.md` records a table per case: where the prompt shows (the parent's screen, a child view, nowhere), its screen text, whether the box names the sub-agent, the payload's keys, which keys answered it, and the hc status. Scrubbed fixtures: `tests/fixtures/sessions/claude-child-approval/` and `codex-child-approval/` (new `record-session` scenarios: logs, `screen-*.txt`, `hooks/*.json`), plus `tests/fixtures/screens/` for the extra screens. Rules the later tasks follow:
   - A case whose prompt shows on the parent's screen with the same box shape is answerable through the parent terminal. A case whose prompt shows nowhere on that screen (for example a background child that waits in a list) gets a show-only card ("Answer in the terminal") and Task 13 logs a spec change for done check 3's background half.
   - Sub-agent attribution uses, in order: the event's agent id field (named by the note), the child log whose open call matches the box, the root. A box that names its agent is used only to confirm.
   - Codex child approvals are answerable only if case (e) saved a box the Codex matcher reads and `y` on it created `child.txt`; else they stay show-only (Risk 3).
   - If case (f) shows untrusted hooks never run, the verify scripts trust them the way the note records (keys in the scratch Codex's TUI), and the chat names "Codex hook not trusted on <machine>".
   - The `/new` folder prompt is answerable from the dock if case (j) saved a screen whose options the matcher reads and each recorded key started the new conversation in the folder it names; else its card is show-only. If hc does not say `blocked` while it shows, `bw cards` also reads the screen while hc says `idle` for a Codex terminal, for this matcher only, and the note records that.
   Evidence: spec Risk 3 ("unverified; show-only until the phase 3 experiment and matcher pass"); `tests/fixtures/sessions/README.md` ("Not covered: … approvals raised by a sub-agent"); phase plan phase 3 step 1.
2. **Parse each session file on its own (vendored change).** Claude writes every line of a sub-agent file with `"isSidechain": true` (12 or 13 per file in `claude-subagents`, 0 in the root), and `ConversationParser::feed_at` drops those lines (`conversation/mod.rs:232`), so a child file parses empty. A Codex child rollout first repeats the parent's history up to `session_meta.subagent_history_start_ordinal` (17 in `codex-subagent`). Change: `pub enum FileScope { Root, ClaudeSubagent, CodexChild { from_ordinal: u64 } }`, `ConversationParser::with_scope(scope) -> ConversationParser` (`new()` is `with_scope(FileScope::Root)`), `parse_lines_in(scope, lines)`. `ClaudeSubagent` keeps sidechain lines; `CodexChild` skips lines whose top-level `ordinal` is below `from_ordinal` (lines without one are kept); `Root` is unchanged. Tests in `crates/vendor/herdr-core/tests/bellwether.rs` and a dated `UPSTREAM` line.
   Evidence: `grep -c '"isSidechain":true'` over the recordings; `codex-subagent/expect.json` (`history_start_ordinal: 17`, child counts user 0, assistant 1, tool calls 1, agent messages 1); `REVIEW.md` Focus "vendored … without a test and an UPSTREAM note".
3. **The session tree** lives in `bw` (`crates/bw/src/chat/tree.rs`), from files only, never a folder scan of all sessions. Claude: each `<root stem>/subagents/agent-<id>.meta.json` gives `agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape` (`"background"` marks a background child), `finished`, and from depth 2 `parentAgentId`; the parent is `parentAgentId`, else the root session. Codex: the root's `event_msg` `item_completed` items of type `SubAgentActivity` (`kind` `started`/`completed`, `agent_thread_id`, `agent_path`, `id` = the `spawn_agent` call id) list the children; each child file is found with `session_log::locate_codex(id, sessions_dir)`, where `sessions_dir` is the root rollout's own `<home>/sessions` (four folders up from the root's path, as `dirs::codex_home_of_open` reads it), and its `session_meta` gives `parent_thread_id`, `source.subagent.thread_spawn.depth`, `agent_nickname`, `subagent_history_start_ordinal`; nested Codex children come from each child's own `SubAgentActivity` items, depth at most 8, each id once. State: Claude `finished: true` → done, else running (Task 1 case (g) checks `false` is written while it runs; if `finished` is absent until the end, a missing field reads as running); Codex `completed` → done, else running. Terminal sub-agents (their own Herdr terminal, `terminals()` `parent` equal to the chat's terminal) are added in the mod, not by `bw`. The parent's `Agent`/`spawn_agent` call id links a child to the tool line that started it.
   Evidence: `claude-subagents/*/subagents/*.meta.json` (depth-1 files have no `parentAgentId`; the background child has `"requestShape":"background"`); `codex-subagent` parent lines 17 and 24; `session_log.rs:202` (`locate_codex`); intent build note of 2026-11-07 (macOS 27 hides the agent's environment, so a Codex tree reads its sessions folder from the root's own path); spec Sources and parsing bullet 4; phase 1 `shared/projects-model.js:264-269` (terminal children).
4. **`bw feed --session <child>`.** `bw feed --terminal <t> --session <child id> [--cursor <c>] [--pictures]` locates the root as phase 2 does, builds the tree, and feeds that child's file with its `FileScope`; its `log` line carries `session` (the root), `child` and the child's `path`; feed state is kept in `cache::child_file(t, child)` = `feeds/<core>/<terminal>.<fnv1a(child)>.json`. An id not in the tree prints `{"type":"state","state":"no_child","child"}`. When the root has no log to read, `bw feed` prints the root's locate state line as phase 2 does (`no_log` with or without `session`, `ambiguous`, …) and no `tree` line; a `no_log` naming a session other than the one the chat shows means the root changed (decision 13). `--log <path> --agent <k> --scope claude-subagent|codex-child:<ordinal>` feeds a child file directly (tests, goldens). `--tree` prints one `tree` line before the rows; `--cards` prints the `cards` and `request` lines after them (decision 9), so a chat poll is one `exec`. `--cards` also prints them after a `no_log` or `ambiguous` state line, from the screen alone (`session` and `path` null), so a prompt on a conversation with no log yet, such as the `/new` folder prompt, still reaches the dock.
   Evidence: phase 2 decision 2 (cursor names its path, so a child's cursor never fits the root); spec done check 3 ("within 3 s"): a 2 s poll plus one round trip leaves no room for a second call.
5. **`hooks/bw-event` and the event files.** The hook is a POSIX `sh` wrapper: no `$HC_TERMINAL_ID`, or one holding `/` or `..`, exits 0 at once (Shepherdr's gate, `mods/chat/ask-hook.sh:19-21`); else it runs `"$HOME/.local/share/bellwether/helper/current/bw" event --agent "$1"` with the hook's stdin, sends that program's stdout and stderr to `/dev/null`, and exits 0 whatever happened, so it never makes a decision or prints a word Claude or Codex could read as one. A missing helper drains stdin and exits 0. `bw event` parses the payload (JSON parsing in `sh` would need `jq`, which a machine may lack), keeps only the fields below, and writes one file atomically (temp then rename, 0600, folders 0700): `~/.cache/bellwether/events/<terminal>/<at_ms>-<pid>-<n>.json` = `{"v":1,"id":"<at_ms>-<pid>-<n>","at_ms","agent":"claude"|"codex","event":"PermissionRequest"|"SubagentStart"|"SubagentStop","terminal","core":"<HC_SESSION or default>","session","transcript","agent_id","agent_type","tool","command","tool_use_id","cwd"}` (absent fields `null`; `command` is `tool_input.command`, else `file_path`, else the compact `tool_input` JSON, cut at 2,000 characters). The folder is keyed by terminal only and readers filter by root session and child ids, so a core-name mismatch between the hook and `hc exec` (case (h)) cannot hide events. Each write prunes `events/`: files older than 24 h, then the oldest until at most 2,000 remain. Hook entries carry `"timeout": 5`; `bw event` finishes in under 200 ms on a 1 MB payload.
   Evidence: spec Pieces (`hooks/bw-event`: "Records approval and sub-agent events; decides nothing"), Defaults (events 24 h and 2,000 files); Shepherdr `ask-hook.sh:19-21`; the user's hook groups use `"timeout": 10`.
6. **`bw machine setup`.** `bw hooks check|diff|apply|remove` runs on the machine whose settings it edits; `bw machine setup <machine> --check|--diff|--apply|--remove` runs it there through `hc exec --on` with `RUN_HELPER` (in process for the window machine, `bw machine setup local`). Targets: `--claude-settings <file>` or `$CLAUDE_CONFIG_DIR/settings.json` or `$HOME/.claude/settings.json`; `--codex-hooks <file>` or `$CODEX_HOME/hooks.json` or `$HOME/.codex/hooks.json`; the script goes to `$HOME/.local/share/bellwether/hooks/bw-event` (0755, embedded with `include_str!`). `apply` appends one group per event (`PermissionRequest`, `SubagentStart`, `SubagentStop`) after every existing group, Orca's and the user's included: Claude `{"matcher":"*","hooks":[{"type":"command","command":": bellwether-hook=1; sh \"$HOME/.local/share/bellwether/hooks/bw-event\" claude","timeout":5}]}` (no `matcher` on the two sub-agent events), Codex the same without `matcher` and with `codex`. The marker `: bellwether-hook=1;` identifies Bellwether's groups: `apply` twice changes nothing; `remove` deletes only marked groups and empty event arrays it emptied, giving back the original bytes when nothing else changed. Files are parsed with key order kept and written as 2-space JSON plus a newline; a file that is not valid JSON is refused untouched (`cannot read <file>: <error>; nothing changed`); `apply` refuses when the file's SHA-256 differs from the one `diff` printed (`--expect-sha`). Before writing, the old file is copied to `~/.local/share/bellwether/backups/<name>.<at_ms>` and `~/.local/share/bellwether/hooks/installed.json` records `{version, path, sha256_before, sha256_after, at_ms}` (Risk 7). `diff` prints a unified diff per file (`similar`). `check` prints `{"type":"hooks","claude":"ok|missing|outdated","codex":"ok|missing|untrusted|outdated"}`: `outdated` when the script's SHA-256 differs from the embedded one; `untrusted` when `config.toml` (read with `toml`) has no `trusted_hash` under `hooks.state."<codex hooks path>:<event>:<our group index>:0"` for each of the three events (if Task 1 finds how `trusted_hash` is computed, `check` compares it too). The chat runs `diff` and shows it before `apply` (decision 13). The real install on this Mac and the user's other machines is Task 13's named step and waits for the user; trusting Codex's hook is the user's step on each machine.
   Evidence: spec Seamless machines ("appended after Orca's and the user's own; Codex asks the user to trust them once per machine"); intent amendment "hooks appended after existing groups, act only in Herdr terminals, and a 'Codex hook not trusted' state"; the user's `config.toml` `hooks.state` keys (Build environment).
7. **Request identity and claims.** A request is `{terminal, root session, child, occurrence}`, its id `r3.<fnv1a of the four joined by \n>`; while the root has no log, its session part is the `no_log` line's `session`, else `none`. The occurrence is the hook event id bound to it, else the log's `tool_use_id`/call id, else `<screen id>@<first seen ms>`; a screen box seen at two reads in a row is the same occurrence, and once seen absent the next one is new. Bindings live in `~/.cache/bellwether/requests/<core>/<terminal>.json` (pruned at 24 h). Claims adapt Flockbook's `answered.rs` (exclusive create under `flock`, `hold` while blocked, release when nothing went out) with one change: a claim matches its occurrence id only, never another prompt with the same tool and command, so a second `touch a.txt` prompt is never treated as answered.
   Evidence: intent amendment "request claims keyed by occurrence, not command text" (design review, P3 confirmed); `flockbook-modfeed/src/answered.rs:69-72` (`same` matches id or tool and command).
8. **Matchers.** Claude approvals and questions use the vendored `approval::{screen_box, screen_prompt, screen_request, card_request}` and `question::{pending_question, answer_question, load_all_questions, message_text}` unchanged, driven through `requests::screen::HcScreen`, a `PaneScreen` over the `hc` CLI (`hc read <t> --json` `.text`, `hc keys <t> <names…>`, `hc send`, and `snapshot` from `hc get` mapped as phase 2 maps it). Claude keys: approve `1`, always `2` (offered only when the box's option 2 starts with `Yes, and` or `Yes, allow`; its text is the button's label), deny `esc`. The Codex 0.167 approval matcher is new, in `bw` (`requests/codex_approval.rs`): the last line `Would you like to run the following command?`, then `Reason:` and `$ <command>` lines (continuation lines until a blank or an option line), then options `1. Yes, proceed (y)`, an optional `2. … (p)`, `3. … (esc)`, ending at `Press enter to confirm or esc to cancel`; `›` before an option is stripped, so moving the cursor keeps the id; the id is `hash_id("codex\n" + box lines)`. Codex keys: approve `y`, always `p`, deny `esc`, each confirmed by Task 1 case (d). The Codex 0.167 `/new` folder prompt matcher is new too (`requests/codex_folder.rs`): the line `Where should the new conversation run?`, then the numbered options and the footer as Task 1 case (j) saved them; `›` is stripped as above; the id is `hash_id("codex-folder\n" + box lines)`; each option becomes an action `option-<n>` whose label is the option's text and whose keys are the ones case (j) recorded. It gives a `prompt` request (decision 9) with no Always or Deny. Any other Codex prompt (edits, MCP) is shown as "Answer in the terminal". Codex `request_user_input` pickers use `question::codex_screen`/`codex_exact` as Flockbook does.
   Evidence: `tests/fixtures/sessions/codex-approval/screen-approval.txt`; `scripts/verify/sessions-run.js` (`waitScreen(/Where should the new conversation run/)`, then Enter, before a `/new` takes effect); `approval.rs:143-178` (`prompt_ids` reads only Claude, Grok and agy boxes); `approval.rs:21-22` (`1`, `Escape`); spec "plus a Codex 0.167 approval matcher built in phase 3".
9. **`bw cards` and the states.** `bw cards --terminal <t>` (and `bw feed --cards`) prints `{"type":"cards","terminal","agent","session","path","status","status_kind","hooks","screen":"read|unread|failed"}` then one `request` line each: `{"type":"request","id","kind":"approval|question|question_async|prompt","state","answerable","reason","who":{"child","agent_type","description","depth"}|null,"title","tool","command","detail","actions":[{"id":"approve|always|deny|option-<n>","label"}],"question","unread","screen_id","event","tool_use_id","at_ms","resolved_ms"}`. The screen is read only while `hc get` says `blocked` (Flockbook's `check_approval` and `read_question`). States, computed by `bw`: `pending` (its box is on screen, or an async question has no answer yet); `answered` and `declined` (Bellwether's key or message went out and the box left; deny gives `declined`); `answered_terminal` and `declined_terminal` (the box left with no Bellwether claim; declined when its call's result in the log is a rejection); `stale` (the box left and its call has no result yet); `uncertain` (keys went out and the re-read did not show the box leave, or `hc keys` timed out). The mod adds `sending` while its `bw answer` runs. Resolved requests are listed for 10 s after `resolved_ms`, then dropped. `answerable` is false with `reason` `codex_child` (decision 12), `clipped` (the box's top is off screen), `no_match` (a prompt on screen no matcher reads), `other_view` (a request of a terminal sub-agent, answered in its own view), or `ambiguous` (the root lookup names no single conversation, which `bw answer` refuses, decision 10). Two pending events with the same tool and command bind to one box: the card answers the box and names both children; no key ever depends on which child asked.
   Evidence: spec Sending and answering ("States: pending, sending, answered, answered in the terminal, declined, stale, uncertain"); `cards.rs:108-146` (`look`); done check 3 ("a prompt answered in the terminal first leaves a stale card that presses no key").
10. **`bw answer`, the focus guard and the re-read.** `bw answer --terminal <t> --request <id> --expect-kind <k> --expect-session <id|none> --expect-path <log|none> (--action approve|always|deny|option-<n> | --answers <json>)` runs on the space's machine with the local address (`helper.call(machine, …)`), as `bw send` does since phase 2, so the last screen read and the key are one local step with no network hop between them. Its expectations take `bw send`'s forms and rules (Build environment), with the same code: Task 9 makes `send.rs`'s `Expect`, `check` and `shown_here` `pub(crate)` and calls them, so the two guards cannot drift; the chat passes `expectation(feed, kind)`. Order: expectations (else `refused-conversation`); a fresh `cards` pass with its own screen read; the request must be there, `pending` and `answerable` (else `stale` or `not-answerable`, no key); claim (`already-answered`, `busy`); `KeyGate` with a fresh `hc get` (same kind and program, else `refused-agent`); read the screen again and require the same `screen_id` (else release, `stale`); send the keys; then read the screen every 300 ms for up to 3 s: box gone → `answered`/`declined`, box still there or another box while the log has no result → `uncertain` (claim held). The whole run stops at 25 s with `uncertain` if keys went out, else `failed`. Results: one line `{"type":"answer","result","state","message"}`. The 3 s focus guard is in the mod: `render` passes `focused()?.terminal` and `Date.now()` to `observe` (`mods/bw-chat/focus-guard.js`), which keeps when the chat's terminal last had focus; answer buttons are disabled while it has focus and until 3000 ms after it lost it; a freshly mounted chat counts as focused at mount. While guarded the poll loop sleeps until the guard ends (at least 1000 ms), so the buttons come back without a fast timer. Herdr's own 3 s quiet rule still holds keys after typing from any client (Risk 2, shown as `uncertain`).
    Evidence: spec Sending and answering last bullet; Risk 2; `cards.rs:150-197` (`approve`); phase 2 Global Constraints (no timer under 1000 ms); `herdr.d.ts:227` (`focused()`).
11. **Codex async questions** (`request_user_input_async`, `Delivery::Message`): `bw answer --answers` builds the text with `question::message_text(q, answers)` and sends it with `hc_send(<local t>, text, 20 s)` after the same expectation check; `blocked` → `refused-prompt`, nothing recorded. On `sent` the occurrence becomes `answered` and the card leaves; a user message after the question in the log with no Bellwether claim makes it `answered_terminal`.
    Evidence: intent amendment "Codex `request_user_input_async` answered as one user message recorded against its request"; `codex-question/screen-async.txt` and its `expect.json` (`answered_by_user_message: true`).
12. **Codex sub-agent approvals** show under their child in the threads card and as a dock card with `answerable: false`, `reason: "codex_child"`, and only the "Answer in terminal" button, until Task 1 case (e) and Task 7's `codex_child_box_is_read` pass; then `requests::matchers::CODEX_CHILD_ANSWERABLE` becomes `true` in Task 7's commit, which names the evidence.
    Evidence: spec Risk 3; Defaults ("Codex approval cards show-only until matched").
13. **`bw-chat`: threads card, sub-agent views and dock.** One poll per interval: `bw feed --terminal <this.target.local> --pictures --tree --cards [--session <child>]` on `this.target.machine`, the target phase 2's `resolveTarget` found in the chat's own tab. Threads card: floating at the timeline's top right (312 px wide, 12 px from the top and right edges, at most half the pane's height, scrolling), after Orca's crew card and T3's lineage list: the parent row, then each child nested by depth (16 px per level), 28 px rows with state icon (spinning ring running, check done, the `blocked` question mark when it has a request), type, description in `t.dim`, time ("4m"), request badge. It is open while any child runs or asks and folds to a pill ("2 sub-agents · 1 asks") otherwise; the header's threads button (count) toggles it, and the user's choice holds until the set of running children changes. Clicking a child opens its transcript; the composer gives way to a 44 px bar "Explore · sub-agent of Claude · running · Back to Claude". A terminal sub-agent opens as a chat of its own terminal (`bw feed --terminal <its local t>`, composer sending to it with its own expectations): its address comes from `terminals()` in this window's namespace, and its local address drops the `<machine>/` prefix as `resolveTarget` does; it is offered only on the parent's machine. A root change (`/clear`, `/new`: a `log` line with another session, or a `no_log` line naming a new `session`, which `feedstate.js` already treats as a new conversation) returns to the parent view with "This conversation ended; showing the new one". Dock, above the composer in every view (one screen, one prompt): one card per request, newest last, after Orca's approval card (`NativeChatApprovalCard.tsx:74,105,162`: radius 8, border, padding 16 by 12, 16 px icon, 13 px semibold title up to two lines, monospace command block at most 288 px tall, buttons wrapping with 8 px gaps): "Approval needed from <who>" or "<who> asks", buttons Approve (primary), Always allow (when offered), Deny, Answer in terminal (`run("bw-tabs.chat-flip")`); questions with step tabs when several, options with 1 to 9 key hints, multi-select checkboxes, an "Other" field and Submit. A digit pressed while a question card has focus selects that option and never submits. Codex's `/new` folder prompt shows as a `prompt` card, "Codex asks where the new conversation should run", with one button per option (decision 8) and Answer in terminal, so a `/new` sent from the composer finishes in the chat. Every answer button needs `expectation(feed, kind)` to be non-null, as the composer's send does. The dock takes at most 45 % of the pane and scrolls. Hooks notices sit at the dock's top: "Bellwether hooks are not set up on <machine>; requests show without who asked · Review changes" (expands to the `bw machine setup <m> --diff` text, then Apply, or Not now kept in `shared("bw.hooks-dismissed")` per machine) and "Codex hook not trusted on <machine>" with the trust step from Task 1's note.
    Evidence: spec Chat (threads card, request dock, sizes); Defaults (threads card 312 px); user review answer 4 ("threads rail … floating thing, similar to how T3Code has it"), answer 5 ("dark above the composer").
14. **Counts in `bw-projects`.** `bw counts --terminals <t1,t2,…>` (space's machine) prints one `{"type":"count","terminal","subagents","requests"}` per terminal from cached roots, the tree and the event files, with no screen read: `subagents` counts running in-process children; `requests` is, while `hc get` says blocked, the larger of 1 and the pending `PermissionRequest` events whose call is still open in the root or a child log, plus unanswered async questions. `bw-projects` calls it per machine with agent lines every 10 s, start to start, and at once when an agent's status changes in `agents()` (seen in `render`); `projectsModel`'s agent lines add these to phase 1's terminal-child count and fill `requests`.
    Evidence: spec Project sidebar rows ("`+N` sub-agents, a request badge"); `shared/projects-model.js:264-285` (`requests: 0` today); phase 1 refresh timers.
15. **Helper 0.3.0, protocol 3** (phase 2 shipped 0.2.0, protocol 2), so every machine's helper reinstalls once with the new commands (`tree`, `event`, `hooks`, `cards`, `answer`, `counts`, `machine setup`). Every place that names the version moves in Task 3 (Build environment lists them).
    Evidence: phase 2 decision 2 (`shared/helper.js` checks both); `shared/helper.js:3-4`, `crates/bw/src/version.rs:3`.
16. **Done checks here and owed.** Done check 2 (children) runs here: `cargo test -p bw --locked` (tree and child rows of `claude-subagents` and `codex-subagent` equal `expect.json`, including the nested `counter` under `nester`) and `scripts/verify/sessions.sh` (checks in `sessions-run.js`): offline, phase 2's `PENDING child-rows` and `PENDING tree-nested-subagent` become checks that pass; live, `claude-children-live` (`bw tree` children equal `ls <session>/subagents/*.jsonl | wc -l` and the nested child's parent) and `codex-child-tree` here and on bwloop; and `claude-clear-next-message` and `codex-new-next-message`, which after a real `/clear` and `/new` send the chat's next message with `--expect-session <new id> --expect-path none` and find it as the new conversation's first user row (Codex's folder prompt answered through its dock card, decision 8). Owed to the window: the card drawn and nested, a click opening the child's transcript, the bar's text. Done check 3 runs here as `scripts/verify/requests.sh` (Task 12): Claude `--permission-mode default` root, foreground and background children each `touch`, `test ! -f` before `bw answer`, `test -f` after, the request under the right child within one `bw cards` call of the prompt appearing; answered in the terminal first gives `stale` with `hc read` unchanged; deny; a Codex async question answered as one message; a Codex child's card show-only (or answered, decision 12); the focus guard through the harness tests; Codex on bwloop for the remote half. Owed: the dock and card drawn within 3 s in the window from empty state on this Mac and a macmini space, the buttons disabled within 3 s of terminal focus on screen, Claude on another machine (keychain).
    Evidence: spec done checks 2 and 3; intent build note on bwloop and Claude; intent build entry of 2026-11-07 on `no_log` naming the new session (P2A-1, commits `47b0479`, `bda1d0a`), which phase 2 checked only offline and through the refusal of the old session.

## Spec changes (one line each, for the intent file's amendment log)

- Sending and answering: `bw answer` runs on the space's machine with the local address, as `bw send` does, so the last screen read and the key are one local step.
- Sending and answering: Codex 0.167's `/new` folder prompt ("Where should the new conversation run?") is a screen-bound request, shown in the dock and answered with its option's key, since a `/new` sent from the chat stops there.
- Pieces: `hooks/bw-event` is a `sh` gate that execs the installed `bw event`, which writes `~/.cache/bellwether/events/<terminal>/`; parsing JSON in `sh` needs `jq`, which a machine may lack.
- Seamless machines: hooks install when the user applies the diff the chat shows (`bw machine setup <machine> --diff`, then `--apply`), with a backup and an install record; `--remove` takes them out.
- Chat: the chat's poll carries the tree and the requests (`bw feed --tree --cards`), one `exec` per poll, to keep done check 3's 3 s.
- Chat: the threads card is open while a sub-agent runs or asks and folds to the pill otherwise; the header's threads button toggles it.
- Chat: the dock shows the session's requests in every view, since the parent's terminal shows one prompt at a time.
- Chat: request states name who answered (`answered`/`declined` by Bellwether, `answered_terminal`/`declined_terminal`), and resolved cards stay 10 s.
- Project sidebar: `+N` counts running sub-agents; counts come from `bw counts` every 10 s per machine and on status changes.
- Conditional on Task 1: a background Claude sub-agent whose prompt never shows on the parent's screen gets a show-only card, and done check 3's background half becomes "shows under its sub-agent; answered in the terminal".
- Build note (not the spec's words): done check 3's remote half runs with Codex on bwloop; Claude on another machine is owed to a window run.

## Global Constraints

- Mods are named `bw-<name>`; shared state keys start with `bw.`; no new mod in this phase.
- Mods use only names declared in `herdr.d.ts` and `gpui-kit.d.ts`; no `setTimeout`, no DOM, no top-level `await`, no `cx` kept past its callback.
- No mod reads `agents()`, `spaces()`, `panes()`, `terminals()` or `focused()` from a timer, a spawned task or a `nextCommand` loop; `render` reads them, and every command it runs is guarded against a second render.
- Polling: a shown chat every 2000 ms, a hidden one every 10000 ms, start to start; `bw counts` every 10000 ms per machine; no sleep under 1000 ms; animation uses `.spin(900)`.
- No key reaches a terminal except from `bw answer` after its fresh re-read shows the request's `screen_id`; no `--force` anywhere; `bw answer` checks `--expect-kind`, `--expect-session` and `--expect-path` with `bw send`'s code and rules (`<id> <log>`, `<id> none`, `none none`; `ambiguous` refuses every form) and refuses on any difference.
- `bw feed`, `bw locate`, `bw send`, `bw picture-read`, `bw tree`, `bw cards`, `bw answer`, `bw counts`, `bw hooks` and `bw event` run on the space's machine (`helper.call(machine, …)`, local addresses); `bw picture` and `bw machine setup` run on the window machine (`helper.call(null, …)`).
- The hook prints nothing on stdout or stderr and exits 0 in every case; it does nothing outside a Herdr terminal.
- Hook groups are appended after every existing group; only groups whose command starts with `: bellwether-hook=1;` are ever changed or removed.
- Tests and scripts never write `~/.claude/settings.json`, `~/.codex/hooks.json` or `~/.codex/config.toml`; scripts check their SHA-256 at start and exit; bwloop's HOME `/Users/dkishore/.bwl` and scratch HOMEs may be written.
- Cache: `~/.cache/bellwether/events/` (24 h, at most 2,000 files), `requests/` (24 h), `feeds/` (7 days, phase 2); event files hold the fields of decision 5 only, never a transcript.
- Sizes: threads card 312 px, rows 28 px, indent 16 px per depth; sub-agent bar 44 px; dock cards radius 8, padding 16 by 12, command block at most 288 px, dock at most 45 % of the pane; text 13 px, 11 px for times and badges.
- Every change under `crates/vendor/herdr-core` has a test and an `UPSTREAM` line naming it.
- Code copied or adapted from Flockbook (MIT, Copyright (c) 2026 Min-Chen Lee, commit `c0420c7f9a720631108f2d269dcf9f4bd62634ff`) or Shepherdr (MIT, Copyright (c) 2026 Elias Stravik, commit `4552191829b5e67dee60a1c780f41224575ef685`) gets a `THIRD_PARTY_NOTICES.md` row in the same commit; merges keep every row.
- Tests live outside `mods/`; JavaScript tests run through `tests/harness/mount.js`; Rust tests use `BW_HC` with `crates/bw/tests/fake-hc`, `BW_CACHE_DIR`, `HOME` and `HERDR_APP_HOME` scratch folders.
- Before every commit: `git diff --cached --stat` lists only the intended files; else `git reset -q` and stage again. Conventional commits, about 50-character titles, bodies wrapped at 72.

## Review Focus

1. A prompt answered in the terminal and followed by an identical one (`touch a.txt` twice): a click on the first card presses nothing and says "Changed on screen; nothing was pressed". Tests in Task 9 (`next_occurrence_with_same_command_is_stale`) and Task 12 (`claude-stale-after-terminal-answer`).
2. Two sub-agents asking the same command at once: one card answers the box on screen and names both; no key depends on attribution. Test in Task 8 (`two_children_same_command_bind_one_box`).
3. Approve clicked within 3 s of the terminal having focus, including right after `⌘J` back to the chat or a fresh mount: the button is disabled and no `bw answer` runs. Tests in Task 4 (`guard holds 3 s after focus leaves`, `fresh mount is guarded`) and Task 11 (`buttons disabled while the terminal had focus`).
4. The hook on a machine without the helper, outside Herdr, with a 1 MB or broken payload, or an unwritable cache: exit 0, no output, done in under 1 s. Tests in Task 6 (`hook_without_helper_is_silent`, `outside_herdr_does_nothing`, `broken_payload_writes_nothing`, `unwritable_cache_still_exits_0`).
5. Settings that are not valid JSON, or that changed between the diff and Apply: refused, file untouched. Tests in Task 6 (`invalid_settings_are_refused_untouched`, `changed_since_diff_is_refused`).

---

## Tasks and waves

Tasks in one wave touch different files (except appended `THIRD_PARTY_NOTICES.md` rows) and run in parallel T3 worktrees; each wave merges into `phase-3-requests` before the next starts.

| Wave | Task | Depends on |
|---|---|---|
| A | 1 Experiment: prompts, screens, hook payloads | phase 2 merged |
| A | 2 Vendored core: parse each session file on its own | phase 2 merged |
| A | 3 Helper 0.3.0 frame and `HcScreen` | phase 2 merged |
| A | 4 `bw-chat` pure models: threads, dock, focus guard | phase 2 merged |
| B | 5 Session tree, `bw tree`, `bw feed --session --tree` | 2, 3 |
| B | 6 `bw event`, `hooks/bw-event`, `bw hooks`, `bw machine setup` | 1, 3 |
| B | 7 Matchers: Claude wrappers, the Codex 0.167 approval box and `/new` folder prompt | 1, 3 |
| C | 8 `bw cards`, the request store and `bw feed --cards` | 5, 6, 7 |
| C | 11 `bw-chat`: threads card, sub-agent views, dock, hooks notices | 4; 5, 6, 8, 9 by line shape |
| D | 9 `bw answer` and claims | 3, 8 |
| D | 10 `bw counts` and `bw-projects` counts | 5, 8 |
| E | 12 Verify scripts: `requests.sh`; children and new-conversation sends in `sessions.sh` | 6, 8, 9, 10 |
| F | 13 Phase checks, window list, install step, review | all |

### Task 1: The experiment (wave A)

**Files:**
- Create: `scripts/verify/requests-probe.sh`, `docs/research/2026-11-06-phase3-requests.md`, `tests/fixtures/sessions/claude-child-approval/` and `tests/fixtures/sessions/codex-child-approval/` (logs, `screen-*.txt`, `hooks/*.json`, `expect.json`), `tests/fixtures/screens/*.txt` (including `codex-new-folder.txt` from case (j))
- Modify: `scripts/verify/record-session` (scenarios `claude-child-approval`, `codex-child-approval`; a scratch recorder hook), `scripts/verify/scrub.js` (only if hook payload JSON needs a rule it lacks), `scripts/verify/scrub-fixture.test.js`, `tests/fixtures/sessions/README.md`

**Interfaces:**
- Produces the note's tables (decision 1) and these fixtures, named so Tasks 6 to 9 find them: `hooks/<case>-<Event>.json` (raw payload, scrubbed), `screen-<case>.txt` (`hc read` while the prompt shows), `status-<case>.json` (`hc get --json` `status`), and in `expect.json` `requests: [{case, kind, tool, command, child, screen, keys, answer, result}]`. Case (j) gives `tests/fixtures/screens/codex-new-folder.txt` and a note table of each option's text, key, the folder the new conversation ran in, and `bw locate --fresh` before and after.
- Produces `scripts/verify/requests-probe.sh [--machine bwloop]`: reruns every case; prints `CASE <name>: <one-line result>`; deletes its scratch folders and `CODEX_HOME` copy; stops its private core.

- [ ] **Step 1:** Write the recorder: a scratch `hook.sh` that copies stdin to `<scratch>/hooks/<event>-<ms>.json` and `env | grep '^HC_'` beside it; a scratch `.claude/settings.json` (project level, `--setting-sources project`) and a scratch `CODEX_HOME/hooks.json` naming it; a scratch `.claude/agents/toucher.md` (tools Bash; "run exactly the command you are given").
- [ ] **Step 2:** Run cases (a) to (h) and (j) in `HC_SESSION=bw-probe`; for each prompt save the screen and status before any key, then the key, then `test -f`. Case (f): first run Codex with the untrusted `hooks.json`, check whether the recorder wrote a file, then trust it the way the TUI offers and save the screen and the `config.toml` lines it added. Case (j): after one turn, `bw send --expect-session <id> --expect-path <log> --text /new` through the probe's own core; save the folder prompt's screen and status, run `bw locate --fresh`, press one option's key, and record the folder of the new conversation and `bw locate --fresh` again; repeat once per option in a fresh Codex.
- [ ] **Step 3:** Run case (i) on bwloop (`hc run --on bwloop`, `CODEX_HOME=/Users/dkishore/.bwl/.codex` with a copied `auth.json`).
- [ ] **Step 4:** Copy the two scenarios' logs and screens through `scripts/verify/scrub-fixture`; `scripts/verify/scrub-fixture --check tests/fixtures` exits 0; hand-count `expect.json` from the logs.
- [ ] **Step 5:** Write the note: one table per case, then "Consequences" applying decision 1's rules (answerable or show-only per case, the event field names for agent id and tool use id, Codex trust steps, keys, and for the folder prompt whether hc says `blocked` and what `bw locate` says while it shows). `rg -n '/Users/|dkishore' docs/research/2026-11-06-phase3-requests.md tests/fixtures` prints nothing; the real settings files' SHA-256 equal their values from before Step 2.
- [ ] **Step 6: Commit** `test: record sub-agent approvals and hook payloads`.

### Task 2: Parse each session file on its own (wave A)

**Files:**
- Modify: `crates/vendor/herdr-core/src/conversation/mod.rs`, `crates/vendor/herdr-core/src/lib.rs` (re-export `FileScope` if `conversation` items are re-exported there), `crates/vendor/herdr-core/tests/bellwether.rs`, `crates/vendor/herdr-core/UPSTREAM`

**Interfaces:**
- Produces in `herdr_core::conversation`: `#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)] pub enum FileScope { #[default] Root, ClaudeSubagent, CodexChild { from_ordinal: u64 } }`, `ConversationParser::with_scope(scope: FileScope) -> ConversationParser`, `pub fn parse_lines_in<S: AsRef<str>>(scope: FileScope, lines: &[S]) -> Vec<ConversationItem>`.

- [ ] **Step 1: Write the failing tests** in `tests/bellwether.rs`:

```rust
#[test] fn claude_subagent_file_parses_on_its_own() {
    // each child of claude-subagents/expect.json, ClaudeSubagent scope:
    // user texts == 1, assistant texts == 1, tool calls == 1
}
#[test] fn root_scope_still_skips_sidechain_lines() { /* a child file with Root scope → no items */ }
#[test] fn codex_child_starts_at_its_history_ordinal() {
    // child rollout, CodexChild { from_ordinal: 17 }: user 0, assistant 1, tool calls 1, one Status item
}
#[test] fn codex_child_without_scope_repeats_the_parent() { /* Root scope: the parent's user message is there */ }
```

- [ ] **Step 2:** Run `cargo test --manifest-path crates/vendor/Cargo.toml --locked --target-dir target/vendor --test bellwether`. Expected: FAIL (names missing).
- [ ] **Step 3:** Implement the scope in `ConversationParser` (a field read in `feed_at` before the sidechain return and before Codex dispatch).
- [ ] **Step 4:** Run every vendored test (`--workspace`). Expected: PASS, upstream tests unchanged.
- [ ] **Step 5:** Add a dated `UPSTREAM` line naming the change and the four tests.
- [ ] **Step 6: Commit** `fix(vendor): parse a sub-agent file as its own session`.

### Task 3: Helper 0.3.0 frame and `HcScreen` (wave A)

**Files:**
- Modify: `crates/bw/Cargo.toml` (version `0.3.0`; `serde_json` feature `preserve_order`; `toml = "0.8"`, `similar = "2"`), `Cargo.lock`, `crates/bw/src/version.rs` (`PROTOCOL = 3`), `crates/bw/src/main.rs` (arms `tree` → `chat::run`; `event` → `events::run`; `hooks` → `machine::hooks::run`; `cards`, `answer`, `counts` → `requests::run`; usage), `crates/bw/src/chat/mod.rs` (`tree` arm), `crates/bw/src/machine/mod.rs` (`setup` sub-command arm and `mod hooks;`), `crates/bw/src/hc.rs`, `crates/bw/tests/fake-hc`, `crates/bw/tests/version.rs`, `crates/bw/tests/install.rs` (`PROTOCOL = 3`), `shared/helper.js` (`PROTOCOL = 3`, `HELPER_VERSION = "0.3.0"`), `shared/helper.test.js` (its "this window needs helper 0.2.0, protocol 2" test), the `helper.js` copies (`scripts/sync.sh --shared-only`), `scripts/verify/sessions-run.js` (`<machine>-helper-installed` expects protocol 3, 0.3.0)
- Create: `crates/bw/src/requests/mod.rs` (declares every module below, so later tasks never edit it), `requests/screen.rs`, stubs `chat/tree.rs`, `events/mod.rs`, `machine/hooks.rs`, `requests/{cards,answer,counts,matchers,codex_approval,codex_folder,store,claims}.rs`

**Interfaces:**
- Produces stubs that print `{"type":"error","code":"not_built","message":"<cmd> arrives in a later task"}` and exit 1; Tasks 5 to 10 replace only their own files. Each command stub is called from a `main.rs` arm, and a module with no command holds nothing yet, so clippy's dead-code lint passes; once the stubs are replaced, nothing may print `not_built` (phase 2 removed its own in `deb3d27`), and Task 13 checks that `rg -n not_built crates/bw/src` prints nothing.
- Produces in `hc.rs`: `pub fn hc_read(address: &str) -> Result<String, HcError>` (`read <address> --json`, `.text`), `pub fn hc_keys(address: &str, keys: &[&str], timeout: Duration) -> Result<Value, HcError>` (argv exactly `keys --json -- <address> <key>…`; `TimedOut` past `timeout`; `Refused` kinds as `hc_send`), each with a `*_with(program, …)` form.
- Produces in `fake-hc`: `read <addr>` prints `{"text": <$FAKE_HC_SCREEN_DIR/<addr>.txt>, "complete": true, "how": "screen"}`, then advances to `<addr>.after.txt` once a `keys` call was logged if that file exists; `keys [--json] -- <addr> <k>…` appends `keys <addr> <k…>` to the log, sleeps `${FAKE_HC_KEYS_SLEEP:-0}`, fails with `$FAKE_HC_KEYS_FAIL` when set, else prints `{"turn":1,"status":"working"}`.
- Produces `requests::screen::HcScreen { pub address: String, pub keys_timeout: Duration }` implementing `herdr_core::screen::PaneScreen` (`backend` Hc; `snapshot` one workspace, one tab, one pane from `hc_get` through `hc::mapper`; `visible_text` `hc_read`; `send_named_keys` with Herdr names mapped to hc names: `Enter`→`enter`, `Escape`→`esc`, `Down`→`down`, `Up`→`up`, `Tab`→`tab`, `Space`→`space`, `C-c`→`ctrl+c`, single characters as they are; `send_keys` through `herdr_core::hc::keys::names`; `send_text` `hc_send`; `respond` unused by `bw`, returns `Err(HerdrError::Unsupported)`; `pause` sleeps unless `BW_NO_PAUSE=1`).

- [ ] **Step 1: Write the failing tests:** `version.rs` expects protocol 3, version `"0.3.0"`; unit tests `read_returns_screen_text`, `keys_argv_is_double_dash_address_keys`, `slow_keys_time_out`, `named_keys_map_to_hc_names`, `snapshot_maps_one_pane_with_its_agent` (fake `get` for a Claude terminal); integration: each new command prints `not_built`; `crates/bw/tests/install.rs` installs a protocol 3 build; `shared/helper.test.js` reads a `0.2.0`, protocol 2 helper as `outdated`.
- [ ] **Step 2:** Run `cargo test -p bw --locked` and `bun test shared/helper.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `scripts/test.sh`. Expected: exit 0; each mod's `helper.js` copy changed with its source.
- [ ] **Step 5: Commit** `feat(bw): add the request command frame for 0.3.0`.

### Task 4: `bw-chat` pure models (wave A)

**Files:**
- Create: `mods/bw-chat/threads-model.js`, `mods/bw-chat/dock-model.js`, `mods/bw-chat/focus-guard.js`, `tests/mods/bw-chat-requests-pure.test.js`

**Interfaces:**
- Consumes by shape: Task 5's `tree` line, Task 8's `cards` and `request` lines, Task 9's `answer` line (decisions 9 and 10), `terminals()` rows.
- Produces `threads-model.js`:
  - `threadRows(tree, terminals, requests, root: { terminal, kind, name }, now) → Row[]`, `Row = { id, kind: "parent"|"child"|"terminal", depth, state: "running"|"done"|"asks", type, description, since: string, requests: number, open: { child } | { terminal } | null }`; children in start order under their parent; terminal children (`parent` equal to `root.terminal`, `state` live) at depth 1 with their program as type.
  - `pillText(rows) → string` ("1 sub-agent", "2 sub-agents · 1 asks"); `cardOpen(rows, toggle: { open, running: string[] } | null) → boolean` (decision 13); `barText(row, parentName) → string`.
- Produces `dock-model.js`:
  - `RESOLVED_SHOW_MS = 10000`; `dockCards(requests, { now, guarded, sending: Set<string>, agentName }) → Card[]`, `Card = { id, kind, title, who, tool, command, state, note, buttons: { id: "approve"|"always"|"deny"|"option-<n>"|"terminal"|"submit", label, enabled, primary }[], question }`; `titleOf(req, agentName)` (a `prompt` card: "Codex asks where the new conversation should run"); `stateNote(state)`: `answered` "Approved" (or "Answered"), `declined` "Denied", `answered_terminal` "Answered in the terminal", `declined_terminal` "Denied in the terminal", `stale` "Changed on screen; nothing was pressed", `uncertain` "Sent, but the screen did not change. Check the terminal (⌘J)."; `not-answerable` notes: `codex_child` "Codex sub-agent approvals are answered in the terminal for now", `clipped` "Command too long to show here. Read it in the terminal", `no_match`, `other_view`, `ambiguous` (`waitingText("ambiguous", …)` from phase 2's `target.js`).
  - `answerArgs(req, choice: { action } | { answers }, target: { local }, expect: { kind, session, path }) → string[]`; `expect` is `{ kind, ...expectation(feed, kind) }` from phase 2's `feedstate.js`, so `session` and `path` may be `"none"`; `dockCards` takes `expect: null` as one more reason to disable every answer button.
  - Question drafts: `emptyDraft(question)`, `pick(draft, step, index)`, `toggle(draft, step, index)`, `setOther(draft, step, text)`, `digit(draft, step, n)` (1 to 9, selects only), `answersOf(draft) → { picks: number[], other?: string }[]`, `complete(draft) → boolean`.
- Produces `focus-guard.js`: `FOCUS_QUIET_MS = 3000`, `createGuard(now)`, `observe(guard, focusedTerminal, ours, now) → guard`, `guardedUntil(guard) → number` (`Infinity` while focused), `isGuarded(guard, now)`.

- [ ] **Step 1: Write the failing tests:**

```js
test("rows nest the nested counter under nester", () => { /* a tree line written in the test with claude-subagents/expect.json's ids, parents and depths: depths [0,1,1,1,2], the depth-2 row right after nester */ });
test("terminal children join at depth 1", …);
test("pill text and open rule", () => { expect(pillText(rows2running1asks)).toBe("2 sub-agents · 1 asks"); /* user fold holds until running set changes */ });
test("bar text", () => expect(barText(explore, "Claude")).toBe("Explore · sub-agent of Claude · running"));
test("approval card: title, buttons, always only when offered", …);
test("guarded or sending disables every answer button but Answer in terminal", …);
test("resolved cards stay 10 s with their note", …);
test("show-only card has only Answer in terminal and its note", …);
test("answerArgs for approve and for answers", () => expect(answerArgs(req, { action: "approve" }, { local: "t5" }, exp))
  .toEqual(["answer", "--terminal", "t5", "--request", req.id, "--expect-kind", "claude", "--expect-session", "s1", "--expect-path", "/p", "--action", "approve"]));
test("answerArgs after /new passes the new session with path none", …);
test("no expectation disables every answer button but Answer in terminal", …);
test("folder prompt card: its title, one button per option, no Always or Deny", …);
test("digit selects and never submits", …);
test("guard holds 3 s after focus leaves", () => { let g = createGuard(0); g = observe(g, "t5", "t5", 100);
  expect(isGuarded(g, 2000)).toBe(true); g = observe(g, "t9", "t5", 5000); expect(isGuarded(g, 7999)).toBe(true); expect(isGuarded(g, 8000)).toBe(false); });
test("fresh mount is guarded", () => { const g = createGuard(1000); expect(isGuarded(g, 3999)).toBe(true); expect(isGuarded(g, 4000)).toBe(false); });
```

- [ ] **Step 2:** Run `bun test tests/mods/bw-chat-requests-pure.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the three modules (no Herdr imports).
- [ ] **Step 4:** Run the same, then `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-chat): model threads, dock cards and the focus guard`.

### Task 5: Session tree, `bw tree`, `bw feed --session --tree` (wave B)

**Files:**
- Modify: `crates/bw/src/chat/tree.rs` (replaces the stub), `crates/bw/src/chat/feed.rs`, `crates/bw/src/chat/tail.rs` (scope passed to the parser), `crates/bw/src/chat/cache.rs` (`child_file`)
- Create: `crates/bw/tests/tree.rs`, `tests/fixtures/feed/children/<scenario>-<child>.jsonl` (five goldens)

**Interfaces:**
- Consumes: Task 2 `FileScope`, `parse_lines_in`; phase 2 `locate`, `LocateFailure::state_line`, `cache`, feed cursor and splice.
- Produces in `chat/tree.rs`:
  - `pub struct Child { pub id: String, pub parent: String, pub depth: u32, pub agent_type: String, pub nickname: Option<String>, pub description: String, pub tool_use_id: Option<String>, pub background: bool, pub running: bool, pub path: PathBuf, pub scope: FileScope, pub started_ms: Option<i64>, pub ended_ms: Option<i64> }`
  - `pub struct Tree { pub agent: String, pub root: String, pub path: PathBuf, pub children: Vec<Child> }`
  - `pub fn claude_tree(root_path: &Path, root_session: &str) -> Tree`, `pub fn codex_tree(root_path: &Path, root_session: &str, sessions_dir: &Path) -> Tree`, `pub fn tree_of(located: &Located) -> Tree` (Claude children beside `located.path`, Codex children in the root rollout's own sessions folder, decision 3; `Located` carries no `AgentDirs`, and the agent's environment cannot be read on macOS 27), `impl Tree { pub fn child(&self, id: &str) -> Option<&Child>; pub fn line(&self) -> serde_json::Value }`
  - `tree` line: `{"type":"tree","agent","root","children":[{"id","parent","depth","type","nickname","description","tool_use_id","background","state":"running|done","started_ms","ended_ms"}]}`; Codex `type` is the last part of `agent_path`; `description` is the first 120 characters of the spawn call's task text (Claude: `meta.description`).
- Produces commands: `bw tree --terminal <t>` (the line or the locate state line); `bw feed --terminal <t> --session <id>`, `--tree`, and `--log <path> --agent <k> --scope root|claude-subagent|codex-child:<n>` (decision 4).

- [ ] **Step 1: Write the failing tests** in `crates/bw/tests/tree.rs` (recordings copied to temp folders; Codex children under a temp `sessions/YYYY/MM/DD/` as phase 2 Task 1 names them):

```rust
#[test] fn claude_tree_matches_expect() { /* ids, parent, depth, type, tool_use_id, background of the 4 children == expect.json; a640… under ad16… */ }
#[test] fn codex_tree_matches_expect() { /* one child 01a1b4a1-dfcb-…: parent root, depth 1, type "count_entries", nickname "Hypatia", done */ }
#[test] fn child_rows_match_hand_counts() { /* bw feed --log <child> --scope …: user, assistant, tool calls == expect children[] */ }
#[test] fn running_child_reads_as_running() { /* meta finished:false copy; Codex root cut before the completed item */ }
#[test] fn session_feed_names_root_and_child() { /* fake hc get + cached root: log line session == root, child == id, path == child file */ }
#[test] fn unknown_child_is_named() { /* state no_child */ }
#[test] fn root_state_line_passes_through() { /* fake locate no_log with session, and ambiguous: that state line, no tree line */ }
#[test] fn codex_children_found_under_the_roots_own_home() { /* root and child under <tmp>/other-home/sessions, HOME elsewhere: child listed */ }
#[test] fn child_cursor_is_kept_apart_from_root() { /* root feed then child feed: each prints splice 0 once, then unchanged */ }
#[test] fn codex_cycle_and_depth_are_bounded() { /* synthetic child naming its own id as a SubAgentActivity: listed once */ }
#[test] fn child_goldens_are_current() {}   // BW_BLESS=1 rewrites tests/fixtures/feed/children/
```

- [ ] **Step 2:** Run `cargo test -p bw --locked --test tree`. Expected: FAIL.
- [ ] **Step 3:** Implement `tree.rs`, the `--session`, `--tree` and `--scope` paths, `cache::child_file`.
- [ ] **Step 4:** `BW_BLESS=1 cargo test -p bw --locked --test tree child_goldens_are_current`, then `cargo test -p bw --locked` and `scripts/verify/scrub-fixture --check tests/fixtures/feed`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): build the session tree and feed sub-agents`.

### Task 6: Hook events and `bw machine setup` (wave B)

**Files:**
- Create: `hooks/bw-event`, `crates/bw/src/events/mod.rs` (replaces the stub), `crates/bw/tests/events.rs`, `crates/bw/tests/hooks.rs`, `tests/fixtures/hooks/settings-before.json`, `tests/fixtures/hooks/codex-hooks-before.json`, `tests/fixtures/hooks/config-trusted.toml`
- Modify: `crates/bw/src/machine/hooks.rs` (replaces the stub), `crates/bw/src/machine/mod.rs` (`setup`), `THIRD_PARTY_NOTICES.md` (a Shepherdr section: `hooks/bw-event` adapts the `$HC_TERMINAL_ID` gate of `mods/chat/ask-hook.sh:19-21`)

**Interfaces:**
- Consumes: Task 1's `hooks/*.json` payloads and field names; Task 3's frame; phase 2 `cache::cache_dir`, `cache::core_name`.
- Produces in `events/mod.rs`: `pub struct Event { pub id, pub at_ms: i64, pub agent, pub event, pub terminal, pub core, pub session: Option<String>, pub transcript: Option<String>, pub agent_id: Option<String>, pub agent_type: Option<String>, pub tool: Option<String>, pub command: Option<String>, pub tool_use_id: Option<String>, pub cwd: Option<String> }` (serde), `pub fn from_payload(agent: &str, terminal: &str, core: &str, payload: &Value, at_ms: i64) -> Option<Event>`, `pub fn write(e: &Event) -> io::Result<PathBuf>`, `pub fn read(terminal: &str, since_ms: i64) -> Vec<Event>` (oldest first, unreadable files skipped), `pub fn prune(dir: &Path, max_age: Duration, max_files: usize)`; `bw event --agent claude|codex` reads stdin (at most 4 MB), needs `HC_TERMINAL_ID`, writes, prints nothing, exits 0.
- Produces in `machine/hooks.rs`: `pub const MARKER: &str = ": bellwether-hook=1;"`, `pub struct Targets { pub claude: PathBuf, pub codex: PathBuf, pub codex_config: PathBuf, pub script: PathBuf }`, `pub fn targets(args, env, home) -> Targets`, `pub fn planned(kind: &str, current: Option<&str>) -> Result<String, String>` (the new text), `pub fn removed(current: &str) -> Result<String, String>`, `pub fn diff(path: &Path, old: &str, new: &str) -> String`, `pub fn check(t: &Targets) -> Value`; commands `bw hooks check|diff|apply [--expect-sha <claude sha>,<codex sha>]|remove [--claude-settings F] [--codex-hooks F]`; `bw machine setup <machine|local> --check|--diff|--apply [--expect-sha …]|--remove` relays the same lines from there.
- Produces lines: `check` one `{"type":"hooks","claude","codex"}`; `diff` one `{"type":"hooks-diff","agent":"claude"|"codex","path","sha256","changed","diff"}` per file (`sha256` of the file as read, `""` when absent); `apply` one `{"type":"hooks-applied","agent","path","changed","backup"}` per file; `remove` one `{"type":"hooks-removed","agent","path","changed"}` per file; a refusal is `{"type":"error","code":"unreadable"|"changed_since_diff","message"}`, exit 1.

- [ ] **Step 1: Write the failing tests** (`crates/bw/tests/events.rs`, `hooks.rs`; scratch `HOME`, `BW_CACHE_DIR`):

```rust
#[test] fn each_recorded_payload_maps_to_an_event() { /* every tests/fixtures/sessions/*/hooks/*.json → event, tool, command, agent_id as the note's table says */ }
#[test] fn hook_writes_one_file_and_prints_nothing() { /* sh hooks/bw-event claude < payload with HC_TERMINAL_ID=t5 and the test bw as current: stdout and stderr empty, exit 0, one file under events/t5/ */ }
#[test] fn outside_herdr_does_nothing() {}                 // Review Focus 4
#[test] fn hook_without_helper_is_silent() {}              // Review Focus 4
#[test] fn broken_payload_writes_nothing() {}              // Review Focus 4, also a 1 MB payload under 1 s
#[test] fn unwritable_cache_still_exits_0() {}             // Review Focus 4
#[test] fn terminal_with_slash_or_dots_is_ignored() {}
#[test] fn prune_keeps_2000_and_24h() {}
#[test] fn apply_appends_after_existing_groups() { /* settings-before.json: the user's group and Orca's group keep their places; ours last in PermissionRequest, SubagentStart, SubagentStop; every other key and value unchanged */ }
#[test] fn apply_twice_changes_nothing() {}
#[test] fn remove_gives_back_the_original_bytes() {}
#[test] fn missing_files_are_created() {}
#[test] fn invalid_settings_are_refused_untouched() {}     // Review Focus 5
#[test] fn changed_since_diff_is_refused() {}              // Review Focus 5
#[test] fn backup_and_install_record_are_written() {}
#[test] fn codex_untrusted_until_config_has_hashes() { /* config-trusted.toml with our three keys → ok; without → untrusted */ }
#[test] fn outdated_script_is_named() {}
#[test] fn machine_setup_relays_through_hc_exec() { /* fake hc exec runs the test bw with HOME there: --diff prints that machine's paths */ }
```

- [ ] **Step 2:** Run `cargo test -p bw --locked --test events --test hooks`. Expected: FAIL.
- [ ] **Step 3:** Write `hooks/bw-event` (gate, `exec` of the helper with stdout and stderr to `/dev/null`, `exit 0`), `events/mod.rs`, `machine/hooks.rs`, `setup`; the notices row.
- [ ] **Step 4:** Run `cargo test -p bw --locked` and `sh -n hooks/bw-event`. Expected: PASS. The real files' SHA-256 are unchanged.
- [ ] **Step 5: Commit** `feat(bw): record hook events and set up the hooks` (body: human review paths `hooks/`, `crates/bw/src/machine/`).

### Task 7: Matchers (wave B)

**Files:**
- Modify: `crates/bw/src/requests/matchers.rs`, `crates/bw/src/requests/codex_approval.rs`, `crates/bw/src/requests/codex_folder.rs` (all three replace stubs)
- Create: `crates/bw/tests/matchers.rs`, `tests/fixtures/screens/codex-approval-wrapped.txt`, `tests/fixtures/screens/codex-approval-cursor-2.txt`, `tests/fixtures/screens/codex-new-folder-cursor-2.txt` (all three made by hand from the saved screens and marked so in the README)

**Interfaces:**
- Consumes: Task 1 screens and keys (case (j) for the folder prompt); vendored `approval`, `question`.
- Produces in `codex_approval.rs`: `pub struct CodexBox { pub command: String, pub reason: String, pub lines: Vec<String>, pub always: Option<String> }`, `pub fn codex_box(screen: &str) -> Option<CodexBox>`, `pub fn codex_id(b: &CodexBox) -> String`.
- Produces in `codex_folder.rs`: `pub struct FolderBox { pub options: Vec<(String /* label */, Vec<&'static str> /* keys */)>, pub lines: Vec<String> }`, `pub fn folder_box(screen: &str) -> Option<FolderBox>`, `pub fn folder_id(b: &FolderBox) -> String` (decision 8).
- Produces in `matchers.rs`: `pub const CODEX_CHILD_ANSWERABLE: bool` (decision 12), `pub struct Action { pub id: String, pub label: String, pub keys: Vec<&'static str> }` (`id` is `approve`, `always`, `deny` or `option-<n>`), `pub struct ScreenPrompt { pub agent: String, pub screen_id: String, pub title: String, pub tool: String, pub command: String, pub detail: String, pub clipped: bool, pub actions: Vec<Action> }`, `pub fn approval_on_screen(agent: &str, screen: &str) -> Option<ScreenPrompt>`, `pub fn folder_prompt_on_screen(agent: &str, screen: &str) -> Option<ScreenPrompt>` (Codex only; `tool` `"new_conversation"`, `command` empty, one action per option), `pub fn same_call(tool: &str, command: &str, p: &ScreenPrompt) -> bool` (whitespace-insensitive, line breaks as one space or none, as `approval.rs:187-206`), `pub fn other_prompt(agent: &str, screen: &str) -> bool` (a prompt shape no matcher reads: Claude `Do you want` without a box, Codex `Would you like to` other than the command shape).

- [ ] **Step 1: Write the failing tests:**

```rust
#[test] fn claude_box_from_saved_screen() { /* claude-approval: tool Bash, command "touch approved.txt", actions approve ["1"], always label "Yes, and always allow access to /scratch/claude-approval from this project" keys ["2"], deny ["esc"] */ }
#[test] fn claude_child_boxes_from_task1() { /* each claude-child-approval screen: same shape, command as expect.json */ }
#[test] fn codex_box_from_saved_screen() { /* command "touch approved.txt", reason, actions y / p / esc */ }
#[test] fn codex_id_ignores_the_cursor() { /* codex-approval-cursor-2.txt id == saved screen id */ }
#[test] fn codex_wrapped_command_joins() {}
#[test] fn codex_box_needs_its_footer_and_options() { /* screen cut before "Press enter…" → None */ }
#[test] fn codex_question_screen_is_not_an_approval() { /* screen-question.txt → None */ }
#[test] fn codex_child_box_is_read() { /* codex-child-approval screen → Some, if Task 1 saved one; else the test asserts CODEX_CHILD_ANSWERABLE is false */ }
#[test] fn codex_new_folder_prompt_from_saved_screen() { /* codex-new-folder.txt: one action per option, labels and keys as Task 1's note */ }
#[test] fn codex_new_folder_id_ignores_the_cursor() { /* codex-new-folder-cursor-2.txt id == saved screen id */ }
#[test] fn folder_prompt_is_not_an_approval_or_other() { /* approval_on_screen None; other_prompt false */ }
#[test] fn unknown_prompt_is_other() {}
```

- [ ] **Step 2:** Run `cargo test -p bw --locked --test matchers`. Expected: FAIL.
- [ ] **Step 3:** Implement; set `CODEX_CHILD_ANSWERABLE` per decision 12 and name the evidence in the commit body.
- [ ] **Step 4:** Run `cargo test -p bw --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): read Claude and Codex prompts`.

### Task 8: `bw cards`, the request store and `bw feed --cards` (wave C)

**Files:**
- Modify: `crates/bw/src/requests/cards.rs`, `crates/bw/src/requests/store.rs` (both replace stubs), `crates/bw/src/chat/feed.rs` (`--cards`), `THIRD_PARTY_NOTICES.md` (`cards.rs`: "the screen-first rule of `xplat/flockbook-modfeed/src/cards.rs:108-146` (`look`), adapted")
- Create: `crates/bw/tests/cards.rs`, `tests/fixtures/cards/<case>.jsonl` (goldens)

**Interfaces:**
- Consumes: Task 5 `Tree`; Task 6 `events::read`; Task 7 matchers; Task 3 `HcScreen`, `hc_read`; vendored `question::pending_question`, `card_request`; phase 2 `locate`, `tail`.
- Produces in `store.rs`: `pub struct Occurrence { pub id: String, pub kind: String, pub screen_id: Option<String>, pub event: Option<String>, pub tool_use_id: Option<String>, pub child: Option<String>, pub first_seen_ms: i64, pub last_seen_ms: i64, pub state: String, pub by: Option<String>, pub resolved_ms: Option<i64> }`, `pub struct Store { pub version: u32, pub root: String, pub occurrences: Vec<Occurrence> }`, `pub fn store_file(terminal: &str) -> PathBuf` (`requests/<core>/<terminal>.json`), `load`, `save` (atomic, prunes `requests/` at 24 h), `pub fn request_id(terminal, root, child: Option<&str>, occurrence) -> String`.
- Produces in `cards.rs`: `pub struct CardsInput { pub terminal: String, pub agent: String, pub root: String, pub path: Option<PathBuf> /* None while the root has no log */, pub status: Option<String>, pub status_kind: Option<String>, pub screen: Option<Result<String, String>>, pub tree: Tree, pub events: Vec<Event>, pub logs: Vec<(Option<String> /* child */, Vec<ConversationItem>)>, pub hooks: String }`, `pub fn build(input: &CardsInput, store: &mut Store, now_ms: i64) -> (Value /* cards line */, Vec<Value> /* request lines */)` (pure), `pub fn gather(terminal: &str, now_ms: i64) -> Result<CardsInput, LocateFailure>` (after a `NoLog` or `Ambiguous` lookup it still returns an input with the screen only, `root` the `no_log` session or `none`, decision 4; one `hc_get`, `hc_read` only while blocked, the root's and at most 16 running children's tails, events since the root's start, `bw hooks check` cached 60 s in `requests/hooks-check.json`), `bw cards --terminal <t>` and `bw feed --cards`.

- [ ] **Step 1: Write the failing tests** (pure `build` over fixtures; integration with `fake-hc` screens):

```rust
#[test] fn root_approval_is_pending_with_its_tool_use_id() { /* claude-approval log + screen: one request, kind approval, who null, tool_use_id toolu_01SG…, actions 3 */ }
#[test] fn child_approval_sits_under_its_child() { /* claude-child-approval fg case: who.child == the child id from expect.json, via the event's agent id */ }
#[test] fn child_found_from_its_log_without_hooks() { /* same, events empty, hooks "missing": who.child from the child's open call */ }
#[test] fn two_children_same_command_bind_one_box() {}            // Review Focus 2
#[test] fn box_gone_with_result_is_answered_terminal() {}
#[test] fn box_gone_with_rejection_is_declined_terminal() {}
#[test] fn box_gone_without_result_is_stale() {}
#[test] fn same_box_at_two_reads_is_one_occurrence() {}
#[test] fn async_question_pending_then_answered_terminal() { /* codex-question log cut before/after the user message "large" */ }
#[test] fn codex_root_approval_is_answerable() {}
#[test] fn codex_child_approval_follows_the_constant() {}          // decision 12
#[test] fn folder_prompt_card_while_the_new_root_has_no_log() { /* codex-new-folder screen, locate no_log: one prompt request, who null, actions one per option */ }
#[test] fn ambiguous_root_gives_show_only_cards() { /* reason ambiguous, answerable false */ }
#[test] fn unread_screen_when_not_blocked() { /* status working: screen "unread", no hc read call in the fake's log */ }
#[test] fn resolved_requests_drop_after_10_s() {}
#[test] fn new_root_starts_a_new_store() {}
#[test] fn feed_cards_appends_cards_after_rows() {}
#[test] fn cards_goldens_are_current() {}   // BW_BLESS=1 rewrites tests/fixtures/cards/
```

- [ ] **Step 2:** Run `cargo test -p bw --locked --test cards`. Expected: FAIL.
- [ ] **Step 3:** Implement `store.rs`, `cards.rs`, `--cards`; notices row.
- [ ] **Step 4:** Bless the goldens, then `cargo test -p bw --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): list a session's waiting requests`.

### Task 9: `bw answer` and claims (wave D)

**Files:**
- Modify: `crates/bw/src/requests/answer.rs`, `crates/bw/src/requests/claims.rs` (both replace stubs), `crates/bw/src/chat/send.rs` (`Expect`, `check`, `shown_here` and the `none` parsing become `pub(crate)`, behaviour unchanged), `crates/bw/src/chat/mod.rs` (`pub(crate) mod send`), `THIRD_PARTY_NOTICES.md` (`claims.rs` from `answered.rs`, adapted: occurrence ids only; `answer.rs` from `cards.rs:150-282` `approve` and `answer`, adapted)
- Create: `crates/bw/tests/answer.rs`

**Interfaces:**
- Consumes: Task 3 (`HcScreen`, `hc_keys`, `hc_send`), Task 7 (`Action.keys`), Task 8 (`gather`, `build`, `Store`); phase 2 `args`, `locate::locate_fresh`, `send`'s guard (decision 10); vendored `keygate`, `question::{answer_question, load_all_questions, message_text}`.
- Produces in `claims.rs`: `pub enum Claim { Got, Taken, Busy }`, `pub struct Claims { dir: PathBuf }`, `Claims::for_terminal(terminal: &str) -> Claims` (`requests/<core>/<terminal>/claims/`), `claim(&self, occurrence: &str, blocked: bool, now: SystemTime) -> Claim`, `hold(&self, occurrence)`, `release(&self, occurrence)`, `is_claimed(&self, occurrence, blocked, now) -> bool`, `seen(&self, live: &[String])` (claims of occurrences not on screen go after a read that worked); `HELD_WAIT` 60 s.
- Produces `bw answer` as decision 10; result line `{"type":"answer","result":"answered|declined|stale|uncertain|refused-conversation|refused-agent|refused-prompt|already-answered|busy|not-answerable|failed","state","message"}`; `BW_ANSWER_DEADLINE_S` (default 25) and `BW_NO_PAUSE` for tests.

- [ ] **Step 1: Write the failing tests** (`fake-hc` with `<addr>.txt` and `<addr>.after.txt` screens, logs in temp, `FAKE_HC_LOG`):

```rust
#[test] fn approve_presses_1_once_then_answered() { /* keys log == ["keys t1 1"]; result answered */ }
#[test] fn always_presses_2_and_deny_presses_esc() {}
#[test] fn codex_approve_presses_y() {}
#[test] fn other_screen_before_key_is_stale_and_presses_nothing() {}
#[test] fn next_occurrence_with_same_command_is_stale() {}      // Review Focus 1
#[test] fn second_click_is_already_answered() {}
#[test] fn concurrent_answers_press_once() { /* two processes at once: one keys line; the other already-answered or busy */ }
#[test] fn other_session_is_refused_conversation() {}
#[test] fn expectations_follow_bw_send() { /* <id> none passes only that no_log session; none none only a fresh one; none <log> is usage; ambiguous refuses all: refused-conversation, no keys line */ }
#[test] fn folder_prompt_option_presses_its_key() { /* codex-new-folder screen, --action option-1: keys as Task 1's note; after-screen without the prompt: answered */ }
#[test] fn other_program_is_refused_agent() { /* hc get now names another process */ }
#[test] fn box_still_there_after_keys_is_uncertain() { /* no .after.txt */ }
#[test] fn slow_keys_are_uncertain() { /* FAKE_HC_KEYS_SLEEP=3, BW_ANSWER_DEADLINE_S=1 */ }
#[test] fn not_answerable_presses_nothing() { /* codex child, constant false */ }
#[test] fn async_answer_sends_one_message() { /* codex-question async: one send line with message_text's text */ }
#[test] fn async_blocked_is_refused_prompt() {}
#[test] fn picker_question_keys_follow_answer_question() { /* codex-question picker: keys as question::steps gives for picks [1] */ }
```

- [ ] **Step 2:** Run `cargo test -p bw --locked --test answer`. Expected: FAIL.
- [ ] **Step 3:** Implement `claims.rs` and `answer.rs`; notices rows.
- [ ] **Step 4:** Run `cargo test -p bw --locked` and `scripts/test.sh`. Expected: PASS, with `crates/bw/tests/send.rs` and `send.rs`'s unit tests unchanged.
- [ ] **Step 5: Commit** `feat(bw): answer a request only while it is on screen`.

### Task 10: `bw counts` and the sidebar counts (wave D)

**Files:**
- Modify: `crates/bw/src/requests/counts.rs` (replaces the stub), `shared/projects-model.js`, `shared/projects-model.test.js`, `mods/bw-projects/main.js`, `mods/bw-projects/projects-model.js` (by `scripts/sync.sh --shared-only`, with the other copies), `tests/mods/bw-projects.test.js`, `tests/fixtures/live/two-machines.json` (`exec` answers for `bw counts`)
- Create: `crates/bw/tests/counts.rs`

**Interfaces:**
- Consumes: Task 5 `tree_of`; Task 6 `events::read`; Task 8 `Store`; phase 2 `cache` roots (no process scan when fresh).
- Produces `bw counts --terminals <t1,t2,…>` (decision 14), at most 64 terminals per call.
- Produces in `projects-model.js`: the model's input gains `counts: { [address]: { subagents, requests } }`; an agent line's `subagents` is the terminal-child count plus `counts[address].subagents`, its `requests` is `counts[address].requests` (0 when absent).
- `bw-projects`: one loop per machine with agent lines, `helper.call(machine, ["counts", "--terminals", locals.join(",")])` every 10000 ms start to start, poked when `render` sees an agent's status change; results kept in `this.counts` and `cx.notify()` on change.

- [ ] **Step 1: Write the failing tests:** Rust `counts_from_tree_and_events` (claude-child-approval: subagents 1 while running, requests 1 while blocked), `not_blocked_has_no_screen_requests`, `async_question_counts`, `unknown_terminal_is_zero`; JS `agent lines add in-process sub-agents and requests`, `counts loop per machine every 10 s` (`cx.sleep` durations, `exec` args with local addresses), `status change pokes the counts loop`.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test counts` and `bun test shared/projects-model.test.js tests/mods/bw-projects.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `cargo test -p bw --locked`, `bun test`, `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-projects): count sub-agents and waiting requests`.

### Task 11: `bw-chat` threads card, sub-agent views, dock (wave C)

**Files:**
- Create: `mods/bw-chat/threads.js`, `mods/bw-chat/dock.js`, `mods/bw-chat/icons/{threads,approval,question,back}.svg`, `tests/mods/bw-chat-threads.test.js`, `tests/mods/bw-chat-dock.test.js`, `tests/fixtures/live/chat-requests.json`
- Modify: `mods/bw-chat/main.js` (view state, poll arguments, header threads button, layout of card and dock, focus observation, answer calls), `mods/bw-chat/target.js` (`no_child` and hooks notice texts), `tests/harness/kit-stub.js` (only stubs the new elements need, refusing undeclared methods), `tests/fixtures/live/props.json` (only if a new props case is needed; props stay `{terminal, machine, kind, window}`)

**Interfaces:**
- Consumes: Task 4 models; Task 5 `tree` line and `--session`; Task 8 lines; Task 9 `answer` line; Task 6 `bw machine setup` lines (by shape); phase 2 `targetOf`, `resolveTarget`, `pollMs`, `waitingText`, `applyFeed`, `expectation`, `createPoke`, `flipActions`.
- `main.js`: `this.view = { child: null } | { child: id } | { terminal: address }`; the loop's call is `["feed", "--terminal", this.target.local, "--pictures", "--tree", "--cards", …(child ? ["--session", child] : []), …cursor]` on `this.target.machine` (a terminal child's view feeds `--terminal <its local>`, decision 13); nothing is read while `this.target` is null ("Chat target not found"); rows go to the view's feed state, `tree` and `request` lines to `this.tree` and `this.requests`. `render` calls `observe(this.guard, focused()?.terminal ?? null, this.target?.terminal ?? null, Date.now())`, where `this.target.terminal` is the `Found` address in this window's namespace, as `focused()` names it; it reads `terminals()` for terminal children, and pokes the loop when the root agent's status changes. While guarded, the loop sleeps `Math.max(1000, Math.min(pollMs(shown), guardedUntil(g) - now))`. A click runs `helper.call(this.target.machine, answerArgs(req, choice, this.target, { kind, ...expectation(this.feed, kind) }))` only when `expectation` is non-null, marks the card `sending` until the line returns, then shows its result note and polls at once. Hooks notices call `helper.call(null, ["machine", "setup", machine ?? "local", "--diff"])` and, on Apply, `["machine", "setup", machine ?? "local", "--apply", "--expect-sha", "<claude sha256>,<codex sha256>"]` with both values from the `hooks-diff` lines it showed.

- [ ] **Step 1: Write the failing tests:**

```js
test("threads card lists the children nested, then opens a child's transcript", async () => {
  /* chat-requests.json: tree line with 2 children; click row-child-<id>: next exec args contain "--session", "<id>"; composer replaced by "Explore · sub-agent of Claude · running · Back to Claude" */
});
test("Back returns to the parent and its composer", …);
test("pill when nothing runs; header button toggles", …);
test("terminal sub-agent opens as its own chat with a composer that sends to it", …);
test("root change returns to the parent view with a notice", …);
test("dock shows approval under its sub-agent and Approve calls answer on the space's machine", async () => {
  /* remote: exec on "macmini", args ["answer","--terminal","t5",…,"--action","approve"] */
});
test("buttons disabled while the terminal had focus", …);          // Review Focus 3: focused().terminal = chat's terminal, then away; disabled until 3 s later
test("sending state, then the result note", …);
test("show-only Codex child card offers only Answer in terminal", …);
test("question card: step tabs, digit selects, Submit sends answers", …);
test("async question Submit sends one answer call", …);
test("Codex /new from the composer: the folder prompt card's option calls answer, then the chat names the new conversation", async () => {
  /* feed lines: cards with a prompt request; click option-1: args […,"--action","option-1"]; next feed no_log with a new session: rows dropped, composer sends with --expect-session <new> --expect-path none */
});
test("hooks missing: Review changes shows the diff, Apply passes the sha", …);
test("Codex hook not trusted is named", …);
test("hidden chat still polls every 10 s with --cards", …);
```

- [ ] **Step 2:** Run `bun test tests/mods/bw-chat-threads.test.js tests/mods/bw-chat-dock.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `threads.js` (card, pill, rows, bar), `dock.js` (cards, question steps, notices) and the `main.js` changes; harness stubs if needed.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-chat): show sub-agents and answer requests`.

### Task 12: Verify scripts (wave E)

**Files:**
- Create: `scripts/verify/requests.sh`, `scripts/verify/requests-run.js` (only if a check needs `createHelper` as `sessions-run.js` does)
- Modify: `scripts/verify/sessions.sh` (header comment and usage only), `scripts/verify/sessions-run.js` (where phase 2's checks live: offline `child-rows` and `tree-nested-subagent` turned from `PENDING` into checks, and the live checks `claude-children-live`, `codex-child-tree`, `claude-clear-next-message`, `codex-new-next-message`)

**Interfaces:**
- Consumes: Tasks 5, 6, 8, 9, 10; phase 2 `sessions.sh` recipes (`firstMessage`, `oldRefused`, `Term`); Task 1's trust steps and keys; `scripts/verify/lib-scratch.sh`.
- Produces `scripts/verify/requests.sh [--offline] [--machine M]` printing `PASS <name>` or `FAIL <name>: <why>`, exit 1 on any FAIL; deletes only scratch folders it made; stops its core and terminals; checks the real settings files' SHA-256 at start and exit. `--offline` runs `bw cards` over each `tests/fixtures/cards` case and the hooks fixtures against their goldens, and `bun test tests/mods/bw-chat-dock.test.js -t focus` (`focus-guard-harness`), so `scripts/test.sh` runs it.

Checks, with `claude --model haiku --permission-mode default --setting-sources project` (the scratch repository's `.claude/settings.json` written by `bw hooks apply --claude-settings`) and `codex -m gpt-6-luna -c model_reasoning_effort="low"` with a scratch `CODEX_HOME` (copied `auth.json`, folder trust, hooks from `bw hooks apply --codex-hooks`, trusted per Task 1):
- `hooks-setup-scratch`: `bw hooks diff|apply|remove` on copies of `tests/fixtures/hooks/*-before.json` in a scratch HOME: applied text equals the expected file, apply twice is unchanged, remove gives the original bytes.
- `claude-root-approval`: Claude asked to `touch root.txt`: the first `bw cards` after `hc get` says blocked lists it (`who` null) and takes under 1 s; `test ! -f root.txt`; `bw answer --action approve` gives `answered`; `test -f root.txt`.
- `claude-fg-child-approval` and `claude-bg-child-approval`: Claude told to have the `toucher` agent run `touch fg.txt` in the foreground, then `touch bg.txt` with `run_in_background`; each request's `who.child` equals the child id `bw tree` lists for that description; absent before, present after (or, for a case Task 1 made show-only, answered with `hc keys` and the card `answered_terminal`).
- `claude-stale-after-terminal-answer`: a prompt answered with `hc keys <t> 1`; after the box left, `hc read` A; `bw answer` with the old request gives `stale`; `hc read` B equals A; `bw cards` shows `answered_terminal`. (Review Focus 1)
- `claude-deny`: Deny gives `declined`; the file is absent; the session goes on.
- `codex-root-approval`: `-a on-request -s read-only`, `touch codex.txt`, approve with `y` through `bw answer`; present after.
- `codex-async-question`: `--enable default_mode_request_user_input`, the async "Which size?" question; `bw answer --answers '[{"picks":[1]}]'` gives `answered`; the rollout gains exactly one user message, equal to `message_text`'s text; `size.txt` holds `large`.
- `codex-child-approval`: a `spawn_agent` child asking `touch child.txt`: the request lists under that child; show-only (`answerable` false) or answered, per decision 12.
- `focus-guard-harness` (also offline).
- Remote half (`--machine bwloop`): `bw machine setup bwloop --diff` names `/Users/dkishore/.bwl/.claude/settings.json` and `/Users/dkishore/.bwl/.codex/hooks.json`; `--apply`, `--check` (Codex `untrusted`, then `ok` after the trust step), Codex there with `CODEX_HOME=/Users/dkishore/.bwl/.codex`: `bwloop-codex-approval` (`bw cards` and `bw answer` through `hc exec --on bwloop` with the helper there; `hc exec --on bwloop test -f`), `bwloop-stale`, `bwloop-async-question`; at exit `--remove`, the copied `auth.json` deleted, and both bwloop files equal to their state before the run (or absent if they were).
- `sessions.sh`: `child-rows` and `tree-nested-subagent` offline (child rows equal `claude-subagents/expect.json`'s hand counts; `bw tree` puts the nested child under its parent); `claude-children-live` (a Claude asked for one foreground and one nested sub-agent: `bw tree` children count equals `ls <session>/subagents/*.jsonl | wc -l`, the nested child's `parent` is its parent's id) and `codex-child-tree` (here and with `--machine bwloop`).
- `sessions.sh`: `claude-clear-next-message` and `codex-new-next-message` (and `<machine>-codex-new-next-message` with `--machine`). Claude's runs on its terminal after phase 2's `claude-old-conversation-refused`, the remote one after `<machine>-old-conversation-refused`, and `codex-new-next-message` sends its own `/new` at the end of `codexChecks`. After a real `/clear` (Claude) or `/new` (Codex) sent with `bw send`, wait until `bw locate` prints `no_log` with a `session` other than the old one; Codex's folder prompt is answered with `bw answer --action option-<n>` on the `prompt` request `bw cards` lists (decision 8), in place of phase 2's `hc keys enter`. Then `bw send --expect-session <that id> --expect-path none --text <marker>` gives `sent`; once `bw locate` names a log, its session is that id and the feed's first user row reads exactly `<marker>`; a second send with the same `<id> none` expectation is refused (`refused-conversation`), since the log now exists.

- [ ] **Step 1:** Write `requests.sh --offline` and run it. Expected: PASS lines.
- [ ] **Step 2:** Write the live checks; run `scripts/verify/requests.sh`. Expected: every local line PASS. A check that fails for a reason in the agent (a model that does not call the tool) gets one rerun; a second failure is reported with its output.
- [ ] **Step 3:** Run `scripts/verify/requests.sh --machine bwloop` and `scripts/verify/sessions.sh --machine bwloop`. Expected: every line PASS; `hc ls --json` and `HC_SESSION=bw-requests hc ls --json` list none of the script's terminals afterwards.
- [ ] **Step 4: Commit** `test: verify requests and sub-agent trees live`.

### Task 13: Phase checks (main checkout, after waves A to E)

- [ ] **Step 1:** Merge the wave branches into `phase-3-requests`; keep every `THIRD_PARTY_NOTICES.md` row; `scripts/sync.sh --shared-only`; `git status` shows no changed shared copy.
- [ ] **Step 2:** Run `scripts/test.sh`, `scripts/verify/install.sh --machine bwloop`, `scripts/verify/sessions.sh --machine bwloop`, `scripts/verify/requests.sh --machine bwloop`, `scripts/verify/scrub-fixture --check tests/fixtures`. Expected: exit 0 each; `sessions.sh --offline` prints no `PENDING`; `rg -n not_built crates/bw/src` prints nothing.
- [ ] **Step 3:** Update `README.md` (status; helper 0.3.0, protocol 3 where it says 0.2.0 and protocol 2; `bw tree|cards|answer|counts|event|hooks|machine setup`, and `bw answer` beside `bw send` on the space's machine; the dock's `/new` folder prompt; the hooks and how to remove them; `scripts/verify/requests.sh`) and `AGENTS.md` only where a fact changed, with `doc-updater`.
- [ ] **Step 4:** Prepare the real install, which waits for the user: run `bw machine setup local --diff` here on macmini (the user's real files, read only) and save it to `docs/drafts/hooks-install-macmini.diff` (untracked); the MacBook (the window machine, not reachable from here) and tsuki (offline) get theirs from the chat's Review changes notice on first use. List in the phase report "Blocked on me: approve `bw machine setup <machine> --apply` for macmini, the MacBook and tsuki, then trust `bw-event` in Codex on each (the step from Task 1's note)". Nothing is applied to a real settings file in this phase without that approval.
- [ ] **Step 5:** Append "## Phase 3" to `docs/drafts/herdr-window-checks.md`:
  - `herdr-app check` on `bw-chat` and `bw-projects`; a shot of a chat with the threads card open and folded, nested rows, and the dock with an approval and a question.
  - From empty state in the window on the MacBook and in a macmini space: a `claude --permission-mode default` chat tab whose foreground and background sub-agents each run `touch <name>.txt`: each approval under its sub-agent in the card and in the dock within 3 s (count from the hook event's `at_ms` to the shot); Approve creates the file (`test -f`, with `hc exec --on macmini` there); a prompt answered in the terminal first leaves a stale card that presses no key (`hc read` before and after).
  - `⌘J` to the terminal and back: the buttons are disabled at once and enabled 3 s after the terminal lost focus.
  - A Codex chat's async question answered from the dock as one message; a Codex child's card as decision 12 says.
  - `/new` typed in a Codex chat's composer in a Git repository: the folder prompt card shows in the dock; an option starts the new conversation in that folder; the chat drops the old rows and its next message is the new conversation's first user row.
  - Clicking a sub-agent row shows its transcript and the bar; Back returns; a terminal sub-agent's view sends to it.
  - The sidebar's `+N` and request badge follow the chat within 10 s; Claude on another machine (the half bwloop could not run); the hooks notice, Review changes, Apply, then the requests name who asked.
- [ ] **Step 6:** Run `independent-review` on the phase diff (Codex reviewer); fix confirmed findings; rerun `scripts/test.sh` and the affected verify scripts.
- [ ] **Step 7:** The spec changes above went into the spec with this plan (2026-11-07 entries in the intent file's build amendment log), the background one as "conditional on the phase 3 experiment". If Task 1 made the background half show-only, state it in done check 3 without the condition; if Task 1 found the background prompt on the parent's screen, remove the conditional sentence. Log that, and any other spec change the build made, in one line each in the build amendment log with the original wording and evidence; commit `docs: log phase 3 spec changes`.

## Defaults nobody discussed

- Helper 0.3.0, protocol 3; one reinstall per machine.
- Hook entries time out at 5 s; `bw event` keeps a fixed field list, commands cut at 2,000 characters, payloads read up to 4 MB.
- Backups of edited settings under `~/.local/share/bellwether/backups/`, an install record in `~/.local/share/bellwether/hooks/installed.json`.
- The Codex trust check looks up our group's index; if another tool later inserts a group before ours, Codex sees a new hook and the chat says it is not trusted again.
- Requests resolved by any route stay in the dock for 10 s; the re-read after keys polls every 300 ms for 3 s; `bw answer` stops at 25 s.
- `bw cards` reads at most 16 running children's logs; Codex trees go at most 8 levels deep.
- Sidebar counts every 10 s per machine; `+N` counts running sub-agents only.
- The threads card is open while a sub-agent runs or asks; descriptions cut at 120 characters; times as "4m".
- Digit keys select a question option and never submit; Submit or Enter on the focused card sends.
- Codex's `/new` folder prompt card has one button per option and Answer in terminal, and no Always or Deny.
- Hooks notices can be dismissed per machine; Apply needs the diff's SHA-256 to still match.
