# Recorded agent sessions

Each folder holds the real session logs of one scripted run of Claude Code 2.1.319 or
Codex 0.167.0, recorded on 2026-11-06 with `scripts/verify/record-session <scenario>` in a
fresh scratch git repository, then rewritten by `scripts/verify/scrub-fixture`. Nothing here
comes from the user's own sessions.

| Scenario | Agent | What it holds |
| --- | --- | --- |
| `claude-subagents` | `claude -p`, Sonnet parent, Haiku sub-agents | Three direct sub-agents (two `counter` in the foreground and background, one `nester`) and one nested `counter` at depth 2 with `parentAgentId`. Layout as Claude writes it: `<session>.jsonl` and `<session>/subagents/agent-<id>.jsonl` with `.meta.json`. |
| `claude-picture` | `claude -p`, Haiku | A `Read` of a 16x16 PNG; the tool result carries one base64 `image` block. |
| `claude-approval` | interactive `claude --permission-mode default` | A Bash approval for `touch approved.txt`. `screen-approval.txt` is `hc read` of the prompt before it was answered; the file did not exist then and did after Enter (option 1). |
| `codex-subagent` | `codex exec` | A parent that calls `spawn_agent` and `wait_agent`, with `SubAgentActivity` items, and the child's own rollout whose `session_meta` names `parent_thread_id`. |
| `codex-question` | interactive `codex --enable default_mode_request_user_input` | A `request_user_input` question answered `blue` in the TUI (`screen-question.txt`), then a `request_user_input_async` question answered by one user message `large` (`screen-async.txt`, saved before that message). |
| `codex-approval` | interactive `codex -a on-request -s read-only` | An escalation approval for `touch approved.txt`; `screen-approval.txt` is the prompt before Enter (option 1). |

Every scenario the plan and spec list was recorded. Not covered: a picture the user pastes
into the prompt (only a tool-result picture), Claude `AskUserQuestion`, and approvals raised by
a sub-agent; done check 3 exercises those live.

## expect.json

Hand-counted from the logs. The top-level counts are for the root session file `file`; each
entry in `children` has its own counts for its own `file`.

- `user_messages`: messages the user typed. Claude: `type: "user"` records whose content is
  text, not a `tool_result`. Codex: `response_item` user messages, leaving out the injected
  AGENTS.md and `<environment_context>` message.
- `assistant_messages`: Claude: `type: "assistant"` records holding a `text` block (Claude
  writes one record per content block). Codex: `response_item` assistant messages.
- `tool_calls`: Claude `tool_use` blocks; Codex `function_call` and `custom_tool_call` items.
- `pictures`: `image` blocks.
- `children[].parent`: the root session id, or the parent agent's id for a nested Claude
  sub-agent. `depth` is Claude's `spawnDepth` or Codex's `thread_spawn.depth`.
- A Codex child rollout first repeats the parent's history up to the spawn; its counts start at
  `history_start_ordinal` (`subagent_history_start_ordinal` in its `session_meta`), and
  `agent_messages` counts the `agent_message` items it received.
- `requests`: each approval or question, with the call or tool use id, the saved screen and the
  answer given.

## What scrub-fixture changed

- The home folder became `/home/user`, the username `user`, the hostname `host`, every email
  `user@example.com`, the git author `Test User`, token-shaped strings `REDACTED`, and the
  scratch folder `/scratch/<scenario>` (its slug `-scratch-<scenario>`). Screens were rewritten
  too, so their line lengths differ from what the terminal showed.
- Account and organisation ids (`accountUuid`, `organizationUuid`, `creator_account_id`,
  `creator_user_id`) became `00000000-0000-0000-0000-000000000000`.
- Long embedded instruction blocks became `[scrubbed: <what> removed by scrub-fixture]`. Keys
  and records stay; only the value changed:
  - Claude: `api-request-shape.shape.system` and `.tools`, `api-request-blob` system
    messages, `prompt_snapshot` attachments' `systemPrompt` and `tools`, and the
    `skill_listing` attachment with its `rendered` copy.
  - Codex: `session_meta.base_instructions`, every developer message, the AGENTS.md user
    message, `world_state` `agents_md`, `host_skills.body` and `tools`, and
    `additional_tools.tools`.
- Re-serialised lines lose nothing but formatting; lines no rule touched are unchanged bytes.

## Recording notes

- `record-session` runs every agent under `env -i` with only HOME, USER, PATH, LANG and TERM.
  An agent started from inside another Claude session inherits `CLAUDE_CODE_CHILD_SESSION`,
  which turns transcript saving off, and that session's entrypoint.
- Interactive scenarios run in an hc core of their own (`HC_SESSION=bw-rec`, started from the
  recording shell and stopped afterwards). Terminals in the user's usual core cannot read the
  login keychain, so Claude there starts logged out.
- Claude ran with `--setting-sources project --strict-mcp-config`, so user hooks, plugins,
  MCP servers and the user's CLAUDE.md stay out of the log. Codex has no such switch; its
  rollouts held the user's AGENTS.md, skills, memory guidance and connected apps until the
  scrubber replaced them.
- Trusting each scratch folder saves an entry in `~/.claude.json` or `~/.codex/config.toml`.
