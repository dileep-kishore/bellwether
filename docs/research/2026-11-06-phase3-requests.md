# Phase 3: where approvals show, and what the hooks receive

Run on macmini, 2026-11-07, with Claude Code 2.1.319 (Haiku parent and
`toucher` sub-agent), Codex 0.167.0 (`gpt-6-luna`, low effort) and `hc`
0.1.18, by `scripts/verify/requests-probe.sh`. The fixtures come from four
runs: every case with `--machine bwloop`, which stopped in case (j); `--only
j,i --machine bwloop`; `--only f,j` after case (f) gained Bellwether's own hook
groups; and `--only j` after case (j) moved to Codex's default sandbox. Every
case passed in its last run. The session fixtures and the (f) screens come
from the first run, `codex-approval-bwloop.txt` from the second,
`tests/fixtures/hooks/codex-trusted-hash.json` from the third and the (j)
screens from the fourth. Each agent ran
in a private hc core (`HC_SESSION=bw-probe`) in a scratch git repository
under `/private/tmp/claude-501/bw-probe`. Recorder hooks were named only in
the scratch repository's `.claude/settings.json` (Claude ran with
`--setting-sources project`) or in a scratch `CODEX_HOME`. The user's
`~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.codex/config.toml`
kept their SHA-256 through every run. Cases (a) to (e) and (g) are the
`record-session` scenarios `claude-child-approval` and `codex-child-approval`,
whose scrubbed logs, screens, statuses and payloads are in
`tests/fixtures/sessions/`. The other screens are in `tests/fixtures/screens/`.
An exploratory session before the script gave the same results; where only it
showed something, the text says so.

Every "screen" below is `hc read` while the prompt showed, before any key.
"hc status" is `hc get --json` `.status` at that moment.

## Claude Code 2.1.319

In a terminal, Claude 2.1.319 starts every sub-agent in the background. Its
own telemetry schema says `run_in_background` "count[s] as unset while the
parameter is not offered (background tasks disabled, or subagents forced into
the background: in a terminal, …)". Asked for a foreground child, Haiku and
Sonnet both passed `"run_in_background":"false"` as a string, and Claude still
printed "Backgrounded agent" and wrote `"requestShape":"background"`,
`"launchedWithDefaults":true`. A foreground child needs
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; then `meta.json` has
`"requestShape":"foreground"`. A user's sub-agents in Herdr are therefore
background children unless they set that variable.

### (a) Foreground sub-agent, Bash `touch fg.txt`

| Question | Answer |
| --- | --- |
| Where it shows | The parent's screen, in the same box as a root approval, below the transcript. |
| Screen text | `Bash command · from the toucher agent`, the description, the command between dashed rules, `Do you want to proceed?`, options `1. Yes`, `2. Yes, and always allow access to <cwd> from this project`, `3. Yes, and switch to auto mode · …`, `4. No`, footer `Esc to cancel · Tab to amend`. The transcript above shows `toucher(…)` with `Bash(touch fg.txt)  Running…` nested. |
| Box names the sub-agent | Yes, by type: `from the toucher agent`. Not by id. |
| Payload keys (`PermissionRequest`) | `session_id` (the root), `transcript_path` (the root's log), `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type`, `effort`, `hook_event_name`, `tool_name`, `tool_input` (`command`, `description`), `permission_suggestions`. No `tool_use_id`. |
| Keys | `1` approved; `fg.txt` existed afterwards. |
| hc status | `{"app":"claude-code","kind":"permission","msg":"approve Bash: touch fg.txt","state":"blocked"}`. `hc get` also lists the child under `records` keyed by its agent id, with its description as `title`. |

### (b) Background sub-agent, Bash `touch bg.txt`

| Question | Answer |
| --- | --- |
| Where it shows | The parent's screen, same box, while the parent's turn has ended with "Waiting for 1 background agent to finish". |
| Screen text | As (a), footer adds `· ctrl+x ctrl+k twice to stop background agents`; the transcript shows `toucher(…)` `Backgrounded agent (↓ to manage · ctrl+o to expand)`. |
| Box names the sub-agent | Yes: `from the toucher agent`. |
| Payload keys | As (a). |
| Keys | `1` approved; `bg.txt` existed afterwards. |
| hc status | `blocked`, `kind: permission`, `msg: approve Bash: touch bg.txt`. |

The background child never waits in a list out of sight: its prompt takes the
parent's screen as a foreground child's does.

### (c) Root approvals answered with `esc` and `2`

| Question | `c-esc`: `touch esc.txt` | `c-always`: `touch always.txt` |
| --- | --- | --- |
| Where it shows | The parent's screen | The parent's screen |
| Screen text | `Bash command`, no `from the … agent`, the same four options | Same |
| Payload keys | As (a) without `agent_id` and `agent_type` | Same |
| Keys | `esc`: no file; the transcript shows `Interrupted · What should Claude do instead?` and the turn ends | `2`: file created. Option 2's label is `Yes, and always allow access to <cwd> from this project`; no `.claude/settings.local.json` appeared |
| hc status | `blocked`/`permission` | `blocked`/`permission` |

Option 2 starts with `Yes, and`, so decision 8's Always rule offers it. Its
label names the folder, not the command.

### (g) `meta.json` while a child runs

`<session>/subagents/agent-<id>.meta.json` exists from the child's start with
no `finished` key (`running-a.meta.json`, `running-b.meta.json`, copied while
each approval showed). `"finished":true` is added when the child ends. A
missing `finished` therefore reads as running, as decision 3 allows.

### Other Claude hook events

- `PreToolUse` fires 20 to 45 ms before `PermissionRequest` for the same call
  and carries `tool_use_id` (`toolu_…`, the id of the `tool_use` block in the
  child's own log), plus `agent_id` and `agent_type` for a child.
- `SubagentStart`: `session_id`, `transcript_path` (the root's), `cwd`,
  `scratchpad_dir`, `prompt_id`, `agent_id`, `agent_type`, `hook_event_name`.
  `agent_id` equals the `agent-<id>` file name; the `Agent` call's
  `PreToolUse` `tool_use_id` equals `meta.json` `toolUseId`.
- `SubagentStop`: adds `permission_mode`, `effort`, `stop_hook_active`,
  `agent_transcript_path` (`…/subagents/agent-<id>.jsonl`),
  `last_assistant_message`, `background_tasks` (each running background child
  with `id`, `status`, `description`, `agent_type`) and `session_crons`.
- Claude also runs agents of its own: after each turn a `SubagentStop`
  arrives with `"agent_type":""`, an `agent_id` no `SubagentStart` named, and
  an `agent_transcript_path` whose file never exists (its
  `last_assistant_message` is the next-prompt suggestion shown in the
  composer). Readers must drop `SubagentStop` events whose `agent_type` is
  empty or whose `agent_id` no `SubagentStart` named.

## Codex 0.167.0

### (d) Root approvals answered with `y`, `p` and `esc`

Codex asked only when told to request escalation: with `-a on-request -s
read-only` and a plain "run touch x", `gpt-6-luna` ran it in the sandbox,
reported "operation not permitted" and asked nothing. The probe's message
says "with escalated sandbox permissions (ask me for approval first)".

| Question | `y` (`d-y`) | `p` (`d-p`) | `esc` (`d-esc`) |
| --- | --- | --- | --- |
| Where it shows | The parent's screen, above the composer | Same | Same |
| Screen text | `Would you like to run the following command?`, `Environment: local`, `Reason: <the model's justification>`, `$ touch d-y.txt`, `› 1. Yes, proceed (y)`, `2. Yes, and don't ask again for commands that start with \`touch d-y.txt\` (p)`, `3. No, and tell Codex what to do differently (esc)`, `Press enter to confirm or esc to cancel` | Same | Same |
| Payload keys (`PermissionRequest`) | `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `tool_name` (`Bash`), `tool_input` (`command`, `description` = the box's Reason). No `tool_use_id`. | Same | Same |
| Result | File created; `✔ You approved codex to run touch d-y.txt this time` | File created; `✔ You approved codex to always run commands that start with touch d-p.txt`; `$CODEX_HOME/rules/default.rules` gained `prefix_rule(pattern=["touch", "d-p.txt"], decision="allow")` | No file; `✗ You canceled the request to run touch d-esc.txt`, `■ Conversation interrupted`; the turn ends |
| hc status | `{"app":"codex","kind":"permission","state":"blocked"}` (no `msg`) | Same | Same |

The `Environment: local` line, absent from phase 2's `codex-approval` screen,
sits between the question and `Reason:`. A key pressed while no box shows goes
to the composer (the exploration typed a stray `y` there), so `bw answer`
must never press a key without the fresh re-read decision 10 requires.

Codex's `PreToolUse` carries `tool_use_id` `exec-<uuid>`: the `id` of the
`CommandExecution` item in the rollout's `item_completed` event, not the
`call_…` id of the `custom_tool_call` record.

### (e) A `spawn_agent` child's approval, `touch child.txt`

| Question | Answer |
| --- | --- |
| Where it shows | The parent's screen, while the parent shows `• Waiting for agents`. |
| Screen text | As (d) with one more line, `Thread: /root/<the child's agent path>`, between the question and `Environment:`, and the footer `Press enter to confirm or esc to cancel or o to open thread`. |
| Box names the sub-agent | Yes, by agent path (`/root/run_touch_child`), the `agent_path` of the parent's `SubAgentActivity` item. |
| Payload keys | As (d) plus `agent_id` (the child's thread id) and `agent_type` (`default`). `session_id` is the root's; `transcript_path` is the child's rollout. |
| Keys | `y` on the parent's terminal approved it; `child.txt` existed afterwards. |
| hc status | `blocked`/`permission`, as (d). |

Codex `SubagentStart` has `session_id` (root), `turn_id`, `transcript_path`
(the child's rollout), `cwd`, `hook_event_name`, `model`, `permission_mode`,
`agent_id`, `agent_type`. `SubagentStop` has `transcript_path` (the root's),
`agent_transcript_path` (the child's), `stop_hook_active`,
`last_assistant_message` and the same ids. A root `spawn_agent` call fires
`PreToolUse` with `tool_use_id` `call_…`, the call id of the parent's
`spawn_agent` record.

### (f) An untrusted `hooks.json`

| Question | Answer |
| --- | --- |
| What Codex shows | At start, before the composer, a dialog (`tests/fixtures/screens/codex-hooks-review.txt`): `Hooks need review`, `N hooks are new or changed.`, `Hooks can run outside the sandbox after you trust them.`, `1. Review hooks`, `2. Trust all and continue`, `3. Continue without trusting (hooks won't run)`, `enter confirm · esc skip`. A digit only moves the cursor here; Enter confirms. Esc skips it, as `3` does. hc status while it shows: `null`. |
| Whether an untrusted hook runs | No. After `3`, an approval showed and the recorder wrote no payload. The footer shows `⚠ 1 warning · f2 to view`, but that warning is about `-c` overrides, not hooks. |
| How to trust | `/hooks` lists each event with `Installed`, `Active` and `Review` columns and `⚠ N hooks need review before they can run.` (`codex-hooks-untrusted.txt`); `t` trusts all; `enter` opens an event's hooks, each with `Source  User config - <path>`, `Command`, `Timeout`, `Trust  New hook - review required` and `t trust`. The startup dialog's `2` then Enter does the same. |
| What `config.toml` gains | One table per hook, `[hooks.state."<absolute hooks.json path>:<snake_case event>:<group index>:<hook index>"]` with `trusted_hash = "sha256:<hex>"`, under an empty `[hooks.state]`; nothing else about hooks. (Codex also wrote `[tui]` and `[tui.model_availability_nux]` entries of its own.) |
| When it takes effect | At once: the next approval in the same Codex ran the `PermissionRequest` hook, no restart. |
| How `trusted_hash` is computed | `sha256` of the compact JSON, keys sorted, of `{event_name, matcher (omitted when the group has none), hooks: [the hook + {async: false unless set, timeout: its value, else 600}]}`. Source: `openai/codex` `codex-rs/hooks/src/engine/discovery.rs` (`hook_hash`) and `codex-rs/config/src/fingerprint.rs` (`version_for_toml`), read through `gh api` on 2026-11-07; checked against all 13 hashes Codex wrote in the exploration and two case (f) runs. The hash depends on neither the file path nor the group index. |
| Known answer | Case (f) appended to each event the group `bw hooks apply` will write (decision 6: no matcher, `timeout` 5, command `: bellwether-hook=1; sh "$HOME/.local/share/bellwether/hooks/bw-event" codex`). Codex's hashes for them are in `tests/fixtures/hooks/codex-trusted-hash.json`; `PermissionRequest` is `sha256:9987bcd3…`. |
| Pre-written trust | Case (i) wrote the computed `trusted_hash` entries into a fresh `config.toml` before Codex first started: no review dialog showed and the hook ran. |

### (h) `HC_*` variables in a hook

| Where the hook ran | `HC_TERMINAL_ID` | `HC_SESSION` | Socket | What `hc exec` there sees |
| --- | --- | --- | --- | --- |
| Codex and Claude in the private core `bw-probe` | The terminal's address in that core (`t4`, `t18`), as `hc get` names it | `bw-probe` | `HC_TERMINAL_SOCKET=~/.local/state/herdr-core/bw-probe/bw-probe.sock` | `HC_SESSION=bw-probe`, no terminal id |
| A shell terminal in the user's default core | `t6` | absent | `…/herdr-core/default/default.sock` | no `HC_SESSION` |
| Codex on bwloop (case i) | `t16`, the address on bwloop, without the `bwloop/` prefix the window's core uses | absent | `<bwloop HOME>/.local/state/herdr-core/default/default.sock` | no `HC_SESSION` |

Every hook also has `HC_SCOPE`, a new value per process. The hook's
`HC_TERMINAL_ID` is the local address `bw` takes on that machine, and an
absent `HC_SESSION` means the default core, as decision 5 reads it.

### (i) Codex root approval on bwloop

| Question | Answer |
| --- | --- |
| Where it shows | The bwloop terminal's own screen (`codex-approval-bwloop.txt`), the same box as (d). |
| Payload keys | As (d). |
| Keys | `y` from the window's core (`hc keys -- bwloop/t16 y`) approved it; `remote.txt` existed afterwards. Text was typed with `hc exec --on bwloop -- hc send -- t16 …`, as phase 2 found it must be. |
| hc status | `{"app":"codex","kind":"permission","state":"blocked"}`. |

Codex there ran with `CODEX_HOME=<bwloop HOME>/bw-verify/probe/codex-home`, not
`<bwloop HOME>/.codex` as the plan's build environment named it, so the
script never touches a real Codex home when `--machine` names another
machine.

### (j) The `/new` folder prompt

After one turn in a scratch Git repository, `bw send --expect-session <id>
--expect-path <log> --text /new` (through the probe's own core) gave `sent`,
and Codex showed (`codex-new-folder.txt`):

```
  Where should the new conversation run?

› 1. Use current Git worktree  Keep using the current working directory
  2. Create new Git worktree   Create a separate checkout of this repository in another directory

  enter select · esc back
```

| Key | What happened | Folder of the new conversation | `bw locate --fresh` while shown | After the key |
| --- | --- | --- | --- | --- |
| `1` | Picks option 1 at once (no Enter) | The same folder | `located`, the old session and log | `ambiguous` ("Codex has several conversations open") for 60 s, then `no_log` naming the new session; the next `bw send --expect-session <new> --expect-path none` started it |
| `2` | Picks option 2 at once: Codex makes a detached worktree at `$CODEX_HOME/worktrees/<4 hex>/<repository name>` and prints `• Working directory changed to: <it>` | The new worktree | The same | The same as `1` |
| `enter` | Picks the highlighted option, 1 | The same folder | The same | The same as `1` |
| `esc` | Closes the prompt; no new conversation | (the old one stays) | The same | `located`, the old session at once |

- hc says `{"app":"codex","state":"idle"}` while the prompt shows, never
  `blocked`.
- hc's `cwd` for the terminal stays the old folder after `2`.
- Started with `-s workspace-write` (as `sessions-run.js` starts Codex), the
  conversation that option 2 makes fails its first message: `■ Failed to start
  turn: the selected permission profile cannot be safely represented by the
  legacy app-server sandbox policy; select a named or legacy-compatible
  permission profile`, and no rollout is written. With Codex's own defaults
  (no `-a` or `-s`), and in exploration with `-a on-request -s read-only`, it
  ran. The probe uses the defaults for this case.

## Consequences for the later tasks

Decision 1's rules, applied:

- **Claude sub-agent approvals are answerable through the parent terminal.**
  Foreground (a) and background (b) children show the root's box shape on the
  parent's screen, and `1` there approved them. No case showed a prompt only in
  a list, so the conditional spec change for a background child (show-only,
  "Answer in the terminal") is not needed. Task 13 logs no change to done check
  3's background half.
- **Codex sub-agent approvals are answerable** (decision 12): the child's box
  shows on the parent's screen, and `y` there created `child.txt`. The box
  differs from the root's by a `Thread: /root/<agent path>` line after the
  question and the footer `Press enter to confirm or esc to cancel or o to open
  thread`. Task 7's matcher must read both footers and both forms (with and
  without `Thread:`), and `codex_child_box_is_read` should use
  `codex-child-approval/screen-e.txt`. Then `CODEX_CHILD_ANSWERABLE` can be
  `true` in Task 7's commit.
- **Attribution.** The event's agent id field is `agent_id` in both agents:
  Claude's `agent-<id>` file id, Codex's child thread id. `agent_type` is
  Claude's agent type or Codex's `default`. Root events have no `agent_id`.
  Neither agent puts `tool_use_id` on `PermissionRequest`. It is on the
  `PreToolUse` that fires 20 to 45 ms earlier for the same call (Claude: the
  `tool_use` id in the child's or root's own log; Codex: `exec-<uuid>`, the
  `CommandExecution` item id, not the `call_…` id). Decision 5's
  `tool_use_id` field is null for every `PermissionRequest` unless `bw event`
  also records `PreToolUse`. A box that names its agent (`from the toucher
  agent`, `Thread: /root/<path>`) names the type or path, not the id, so it
  can only confirm.
- **Event noise.** Claude sends `SubagentStop` for agents of its own (empty
  `agent_type`, no matching `SubagentStart`, a transcript that never exists).
  Readers drop them.
- **Claude state.** `meta.json` has no `finished` key while a child runs and
  `"finished":true` after; decision 3's "missing reads as running" holds.
  Every child in a terminal is `requestShape: "background"` unless
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` is set.
- **Keys.** Claude: approve `1`, always `2` (its label `Yes, and always allow
  access to <cwd> from this project` starts with `Yes, and`), deny `esc`
  (the call ends `Interrupted`, a rejection in the log). Codex: approve `y`,
  always `p` (writes `prefix_rule(pattern=[…], decision="allow")` to
  `$CODEX_HOME/rules/default.rules`), deny `esc` (cancels the call and ends
  the turn: `■ Conversation interrupted`). Codex's root box now has an
  `Environment: local` line between the question and `Reason:`; Task 7's
  matcher must allow it. A key pressed with no box on screen goes to the
  composer.
- **Codex hook trust.** Untrusted hooks never run; Codex asks at every start
  until they are trusted. The verify scripts can trust Bellwether's hooks by
  writing the computed `trusted_hash` (case i) or by pressing `2` then Enter
  on the startup dialog. The user's step on each machine, for the chat's
  "Codex hook not trusted on <machine>" notice: start Codex, choose "Trust
  all and continue" (`2`, Enter), or type `/hooks` and press `t`. `bw hooks
  check` can compare `trusted_hash` exactly: it is the same on every machine,
  and `tests/fixtures/hooks/codex-trusted-hash.json` is its known answer.
- **The `/new` folder prompt is answerable from the dock.** Its screen is read
  above. Each option's key (`1`, `2`) acts alone, and both started the new
  conversation in the folder the option names; `enter` takes option 1 and
  `esc` closes it. hc never says `blocked` while it shows, so `bw cards` must
  read the screen while hc says `idle` for a Codex terminal, for this matcher
  only. While it shows, `bw locate` still names the old session and log. After
  `1`, `2` or Enter, it says `ambiguous` for about 60 s, then `no_log` naming
  the new session, so a chat card answered within that minute sees
  `ambiguous` (decision 9's `reason: "ambiguous"`). For Task 12, sessions
  that start Codex with `-s workspace-write` cannot use option 2.
- **Codex child rollouts** started with `fork_turns: "none"` repeat no parent
  history and have no `subagent_history_start_ordinal`. Task 5 should treat a
  missing ordinal as 0 (Task 2's `FileScope::CodexChild { from_ordinal: 0 }`),
  not as an error.
- **Codex asks only for escalation.** Under `-a on-request -s read-only`, a
  plain "run touch x" made `gpt-6-luna` try the sandbox, fail and ask
  nothing. Task 12's prompts must ask for escalated permissions, as the probe
  does.

## Not confirmed

- Claude on another machine (its core there cannot read the keychain), as the
  plan expects.
- A nested sub-agent's approval (depth 2) in either agent, and a Codex
  background child.
- Codex edit or MCP approvals, which the plan leaves as "Answer in the
  terminal".
- Whether `trusted_hash` keeps this shape in Codex versions after 0.167.0:
  the source read was `openai/codex` main on 2026-11-07, and it matched what
  0.167.0 wrote.
