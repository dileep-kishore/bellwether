# Phase 0 spike: per-session agent flags and the isolated stage

Run on macmini, 2026-11-06, with `claude` 2.1.319, `codex` 0.167.0, `hc`
0.1.18, node 26.12.1 and Bun 1.4.4. Agents ran in scratch folders under
`/private/tmp/claude-501/bw-flags/`; models were `haiku` and `gpt-6-luna`.
`scripts/verify/agent-flags.sh` repeats every check below in about two
minutes (`BW_FLAGS_DIR=… sh scripts/verify/agent-flags.sh`); its last full run
printed 14 PASS lines and exited 0. The MCP server is
`tests/fixtures/mcp-echo/server.js`: one tool, `bw_echo`, that returns
`BW-ECHO-OK-7Q4Z`. The instructions carry a second sentinel,
`BW-INSTR-K9P3`, that the prompt does not contain.

## Answers

| Question | Result |
| --- | --- |
| 1. Claude `--mcp-config` and `--append-system-prompt-file` load for that session only | PASS |
| 1. `--strict-mcp-config` needed | No. It removes every other server, so Bellwether must not pass it |
| 2. Codex `-c mcp_servers.<name>.…` loads for that run only | PASS, with `default_tools_approval_mode="approve"` on the server |
| 2. `-c developer_instructions=…` replaces the configured value | Yes (PASS for prepending the effective value) |
| 2. Keys that hold the effective value | top-level `config.toml`, then `<profile>.config.toml` under `--profile`, then a trusted project's `.codex/config.toml` |
| 3. Interactive matches `-p`/`exec` | PASS for both agents, in a private `hc` core |

## 1. Claude

```sh
claude -p --model haiku --mcp-config mcp.json --append-system-prompt-file instr.md \
  --allowedTools mcp__bw-echo__bw_echo --output-format stream-json --verbose \
  "Call the bw_echo tool, then reply with exactly two lines: the tool's output, and the Bellwether session word."
```

`mcp.json` is `{"mcpServers":{"bw-echo":{"type":"stdio","command":"node","args":["<repo>/tests/fixtures/mcp-echo/server.js"]}}}`.
The reply was `BW-ECHO-OK-7Q4Z` / `BW-INSTR-K9P3`. The `init` event listed 24
servers, `bw-echo` among them with `"source":"dynamic"`, next to the user's
`user`, `plugin` and `claudeai` servers. Afterwards `claude mcp list`, run in
the same folder, printed the same server names as before and no `bw-echo`.
`~/.claude/settings.json` and `~/.claude.json`'s `mcpServers` kept their
SHA-256.

With `--strict-mcp-config` added, `init` listed only
`[{"name":"bw-echo","status":"connected","source":"dynamic"}]`. The flag drops
the user's own, plugin and claude.ai servers, so Bellwether leaves it out.

`--allowedTools mcp__bw-echo__bw_echo` lets the session call the tool without
a permission prompt; the interactive run passed it too.

## 2. Codex

```sh
codex exec -m gpt-6-luna -c 'model_reasoning_effort="low"' --skip-git-repo-check --ephemeral \
  -c 'mcp_servers.bw-echo.command="node"' \
  -c 'mcp_servers.bw-echo.args=["<repo>/tests/fixtures/mcp-echo/server.js"]' \
  -c 'mcp_servers.bw-echo.default_tools_approval_mode="approve"' \
  -c 'developer_instructions="<effective value>\n\nBellwether session note: the Bellwether session word is BW-INSTR-K9P3."' \
  "<prompt>"
```

Without `default_tools_approval_mode`, the server loaded and Codex called
`bw_echo`, but the call failed: `MCP tool call requires approval, but approval
policy is never` (`exec`'s policy). The key name comes from Codex 0.167's
config schema (`RawMcpServerConfig.default_tools_approval_mode`; values
include `approve`). With it, the item ended `"status":"completed"` and the
reply carried both sentinels. `codex mcp list` printed the same output before
and after the run, and `~/.codex/config.toml` gained no line naming
`bw-echo`, a sentinel or the scratch folder.

### `developer_instructions` precedence

A scratch `CODEX_HOME` held a copy of the user's `config.toml` with a planted
top-level `developer_instructions` (sentinel `BW-TOP-3M8D`) and a copy of
`auth.json`, because `codex login status` there said `Not logged in` (Codex
here does not read the keychain). The copy was deleted after each run. Each
run asked for every session word in the instructions.

| Run | Layers present | `-c` | Words in the reply |
| --- | --- | --- | --- |
| A | top level | none | `BW-TOP-3M8D` |
| B | top level | `developer_instructions="…BW-INSTR…"` | `BW-INSTR-K9P3` |
| C | top level | top-level text + ours | `BW-TOP-3M8D`, `BW-INSTR-K9P3` |
| D | top level, `[profiles.bwp]` table, no `--profile` | none | `BW-TOP-3M8D` |
| E | same, `--profile bwp` | none | error: `--profile bwp cannot be used while … config.toml contains legacy profile = "bwp" or [profiles.bwp] config` |
| F | top level, `bwq.config.toml`, `--profile bwq` | none | `BW-PFILE-8T1W` |
| G | same as F | ours | `BW-INSTR-K9P3` |
| H | top level, untrusted project `.codex/config.toml` | none | `BW-TOP-3M8D` |
| I | same, trust passed with `-c projects."<dir>".trust_level="trusted"` | none | `BW-TOP-3M8D` |
| K | same, trust written in the scratch `config.toml` | none | `BW-PROJ-2H6V` |
| L | same as K | ours | `BW-INSTR-K9P3` (the first try answered "I can't provide hidden instruction tokens."; the rerun gave the word) |

`codex debug prompt-input` renders the same developer message without a model
call: in the trusted project it held `BW-PROJ-2H6V`, with `--profile bwq` and
a trusted project it still held `BW-PROJ-2H6V`, and in a subfolder of the
trusted project it held `BW-PROJ-2H6V` too.

Findings:

- `-c developer_instructions` replaces the configured value at every layer
  (B, G, L). Bellwether must prepend the effective value.
- Codex 0.167 rejects `profile = "<name>"` in `config.toml`
  (`legacy profile = "bwp" config is no longer supported; use --profile bwp
  with bwp.config.toml instead`). A `[profiles.<name>]` table is ignored
  without `--profile` and is an error with it. A Bellwether launch passes no
  `--profile`, so no profile layer applies unless Bellwether adds one.
- The effective value, lowest to highest: `$CODEX_HOME/config.toml` top level,
  `$CODEX_HOME/<profile>.config.toml` when `--profile` is passed, then a
  trusted project's `.codex/config.toml`. Trust must be in the file; `-c`
  trust does not load the project layer.
- The value contains newlines and quotes; `JSON.stringify` of the string is a
  valid TOML basic string for `-c`. The spike's reader parses with
  `Bun.TOML.parse`; Bellwether's mods would need a TOML reader in `bw`, since
  the `config.toml` lives on the space's machine.

## 3. Interactive

The user's `hc` core runs in the Background launchd session
(`launchctl managername` prints `Background`). There `security
find-generic-password -s "Claude Code-credentials" -w` exits 36
(errSecInteractionNotAllowed), so an interactive Claude started by that core
showed "API Usage Billing" and answered "Not logged in · Please run /login".
That core's PATH is `~/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, so a
`node` MCP server and the user's SessionStart hook failed to start
(`/bin/sh: node: command not found`).

A private core started from this shell (`HC_SESSION=bw-flags hc server
status`) runs in the Aqua session (`launchctl managername` prints `Aqua`),
reads the keychain (exit 0) and inherits this shell's PATH. Interactive runs
used it:

```sh
hc run --bg --name claude-i --no-parent --no-notify --cwd "$W/claude-i" -- \
  claude --model haiku --mcp-config "$W/mcp.json" --append-system-prompt-file "$W/instr.md" \
  --allowedTools mcp__bw-echo__bw_echo
hc send claude-i "<prompt>"; hc wait claude-i --timeout 120; hc read claude-i --lines 80; hc kill claude-i

hc run --bg --name codex-i --no-parent --no-notify --cwd "$W/codex-i" -- \
  env CODEX_HOME="$CH" codex -m gpt-6-luna -c 'model_reasoning_effort="low"' \
  -c 'mcp_servers.bw-echo.command="node"' -c 'mcp_servers.bw-echo.args=["…/server.js"]' \
  -c 'mcp_servers.bw-echo.default_tools_approval_mode="approve"' \
  -c 'developer_instructions="User note: … BW-TOP-3M8D.\n\nBellwether session note: … BW-INSTR-K9P3."'
```

Claude's screen: `Called bw-echo`, then `⏺ BW-ECHO-OK-7Q4Z` / `BW-INSTR-K9P3`.
A fresh folder first shows Claude's trust dialog ("Yes, I trust this
folder", default "No, exit"); the script answers it with `hc keys down
enter`. Codex's screen: `• Called bw-echo.bw_echo └ BW-ECHO-OK-7Q4Z`, then
`BW-ECHO-OK-7Q4Z` / `BW-TOP-3M8D` / `BW-INSTR-K9P3`. Codex got the folder's
trust from the scratch `config.toml` so its trust prompt never wrote to the
user's file. `hc` reported `status.app` `claude-code` and `codex`, `idle`
before and after the turn.

Other observations:

- A shell exported by a calling agent leaks `CLAUDE_CODE_CHILD_SESSION` into a
  core it starts. Claude then printed "Transcript saving is off — inherited
  CLAUDE_CODE_CHILD_SESSION marker". `agent-flags.sh` and `stage.sh` drop
  those variables.
- With `env -u ANTHROPIC_API_KEY claude …` as argv, `hc run` reported
  `"agent":"env"`, while `foreground.argv` and `status.app` still named
  Claude.
- While the first full run was going, another session's Codex runs wrote
  `[projects."/private/tmp/claude-501/bw-rec/…"]` trust entries into the user's
  `~/.codex/config.toml`. The script therefore fails on a trace of this spike
  in the user's settings and only notes a changed hash.

## Isolated stage

`scripts/verify/stage.sh up`, `do hc ls --json`, `down`:

```text
core: aba4815a0dd9518021eae1a0240ca172 (yours: 495a7fa4c01bdb33213c3868c28d6caa)
window deferred: no herdr-app here
up: /private/tmp/bw-stage
{"hidden_finished":0,"terminals":[]}
down: /private/tmp/bw-stage removed
```

Inside the stage, `hc exec` saw `HC_SESSION=bw-stage`, no `CLAUDE*`
variables, and a readable keychain (exit 0). After `down`, the stage core's
pid was gone and `/private/tmp/bw-stage` no longer existed. `up` synced
`layouts/bellwether.json` into `/private/tmp/bw-stage/app/layouts/`.

## Owed window half

These need `herdr-app` and go to `docs/drafts/herdr-window-checks.md`:

- `stage.sh up` opens the window, `layout.switch {name: "bellwether"}`
  applies, and a shot shows it.
- A chat tab started with `tab.new {space, argv}`, argv as in section 3 but
  without the `env` wrapper, then `pane.split {direction: "right", mod:
  "bw-chat"}`: zoom flips to the chat and back, both ways, with `⌘J`.
- The tab's status icon follows the agent (working, then idle) while the chat
  pane is zoomed.
- Closing the tab ends the agent process.
- `agents()` lists the agent while its pane is hidden by the zoom.
- The window's own core (not a Background-session core) can read the keychain,
  so a Claude tab is logged in.
