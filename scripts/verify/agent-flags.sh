#!/bin/sh
# Bellwether's per-session agent additions: does each flag load the MCP server and the instructions
# for one session only, in -p/exec and in an interactive terminal, without changing the user's settings?
#   scripts/verify/agent-flags.sh [--offline]
# --offline runs no agent: it checks this spike's files and that the echo server answers.
# Otherwise it runs real claude and codex (cheap models, one short prompt each) in $BW_FLAGS_DIR
# (default /private/tmp/bw-flags, deleted first), and interactive runs in a private hc core.
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
. "$src/scripts/verify/lib-scratch.sh"
server=$src/tests/fixtures/mcp-echo/server.js
ECHO=BW-ECHO-OK-7Q4Z INSTR=BW-INSTR-K9P3 TOP=BW-TOP-3M8D
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }

echo_answers() {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bw_echo","arguments":{}}}' |
    node "$server" | grep -q "$ECHO"
}

case "${1:-}" in
  --offline)
    for f in "$server" "$src/tests/mcp-echo.test.js" "$src/scripts/verify/stage.sh" "$src/docs/research/2026-11-06-phase0-spike.md"; do
      [ -f "$f" ] && pass "exists ${f#"$src"/}" || bad "missing ${f#"$src"/}"
    done
    echo_answers && pass "echo server answers bw_echo" || bad "echo server did not answer bw_echo"
    exit "$fail" ;;
  "") ;;
  *) sed -n 4,7p "$0" >&2; exit 2 ;;
esac

for c in claude codex hc node bun jq; do command -v "$c" >/dev/null || { echo "FAIL $c is not on PATH" >&2; exit 1; }; done
W=$(scratch_path "${BW_FLAGS_DIR:-/private/tmp/bw-flags}") || { echo "BW_FLAGS_DIR must be a folder inside /private/tmp (it is deleted first)" >&2; exit 1; }
# Made before the cleanup trap exists, so the trap never deletes inside a folder this run did not make.
scratch_rm "$W" || exit 1
scratch_make "$W" || exit 1
CLAUDE_MODEL=${BW_CLAUDE_MODEL:-haiku} CODEX_MODEL=${BW_CODEX_MODEL:-gpt-6-luna}
CH=$W/codex-home
export HC_SESSION=bw-flags

# A calling agent's markers leak into children: CLAUDE_CODE_CHILD_SESSION turns off Claude's transcripts,
# and the private core below would hand them to every terminal it starts.
for v in $(env | grep -Eo '^(CLAUDE[A-Z0-9_]*|CODEX_[A-Z0-9_]*|ANTHROPIC_API_KEY)='); do unset "${v%=}"; done

own_core=0
cleanup() {
  # The scratch CODEX_HOME may hold a copy of the user's auth.json.
  rm -rf "$CH"
  [ "$own_core" = 1 ] || return 0
  for t in $(hc ls --all --json 2>/dev/null | jq -r '.terminals[]?.address'); do hc kill "$t" >/dev/null 2>&1 || true; hc rm "$t" >/dev/null 2>&1 || true; done
  hc server stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

settings() {
  { shasum -a 256 "$HOME/.codex/config.toml" "$HOME/.claude/settings.json" | awk '{print $1}'
    jq -S '.mcpServers // {}' "$HOME/.claude.json" | shasum -a 256 | awk '{print $1}'; } | tr '\n' ' '
}
# Other agents (and Codex's own folder trust) write ~/.codex/config.toml while this runs, so a changed hash
# alone proves nothing: what fails is a trace of this spike in the user's settings.
traces() {
  grep -l -e bw-echo -e "$INSTR" -e "$TOP" -e "$W" "$HOME/.codex/config.toml" "$HOME/.claude/settings.json" 2>/dev/null || true
  jq -e '.mcpServers // {} | has("bw-echo")' "$HOME/.claude.json" > /dev/null && echo "$HOME/.claude.json mcpServers"
  return 0
}
before=$(settings)

mkdir "$W/claude" "$W/codex" "$W/claude-i" "$W/codex-i"
for d in "$W"/*/; do git -C "$d" init -q; done
jq -n --arg s "$server" '{mcpServers: {"bw-echo": {type: "stdio", command: "node", args: [$s]}}}' > "$W/mcp.json"
printf 'Bellwether session note: the Bellwether session word is %s.\n' "$INSTR" > "$W/instr.md"
# Fixed text the instructions above do not contain, so a reply with both words used both additions.
ask_claude="Call the bw_echo tool, then reply with exactly two lines: the tool's output, and the Bellwether session word."

claude_mcp_list() { (cd "$1" && env claude mcp list 2>&1 | sed -E 's/:.*//' | sort); }
claude_before=$(claude_mcp_list "$W/claude")

(cd "$W/claude" && claude -p --model "$CLAUDE_MODEL" --mcp-config "$W/mcp.json" --append-system-prompt-file "$W/instr.md" \
  --allowedTools mcp__bw-echo__bw_echo --output-format stream-json --verbose "$ask_claude" > p.jsonl 2> p.err) || true
reply=$(jq -r 'select(.type == "result") | .result' "$W/claude/p.jsonl")
servers=$(jq -c 'select(.type == "system" and .subtype == "init") | [.mcp_servers[] | .name]' "$W/claude/p.jsonl")
echo "claude -p reply: $(echo "$reply" | tr '\n' ' ')"
echo "claude -p servers: $(echo "$servers" | jq length) loaded, bw-echo source $(jq -r 'select(.subtype == "init") | .mcp_servers[] | select(.name == "bw-echo") | .source' "$W/claude/p.jsonl")"
case $reply in *"$ECHO"*"$INSTR"*) pass "claude -p loads the server and the instructions" ;; *) bad "claude -p reply lacks a sentinel" ;; esac
[ "$(echo "$servers" | jq length)" -gt 1 ] && pass "claude -p without --strict-mcp-config keeps the user's other servers" || bad "claude -p loaded only bw-echo"
claude_mcp_list "$W/claude" | grep -qx 'bw-echo' && bad "claude mcp list shows bw-echo afterwards" || pass "claude mcp list does not show bw-echo afterwards"
[ "$(claude_mcp_list "$W/claude")" = "$claude_before" ] && pass "claude mcp list unchanged" || bad "claude mcp list changed"

# The effective Codex developer_instructions, lowest to highest: $CODEX_HOME/config.toml, the --profile file
# (<name>.config.toml), a trusted project's .codex/config.toml. Prints the -c value that keeps it and appends ours.
codex_di_flag() { # <codex home> <project dir> <our text>
  bun -e '
    const [home, dir, ours] = process.argv.slice(1);
    const fs = require("node:fs"), path = require("node:path");
    const read = (f) => { try { return Bun.TOML.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; } };
    const user = read(path.join(home, "config.toml"));
    let di = user.developer_instructions;
    const profile = process.env.BW_CODEX_PROFILE;
    if (profile) di = read(path.join(home, profile + ".config.toml")).developer_instructions ?? di;
    if (user.projects?.[dir]?.trust_level === "trusted") di = read(path.join(dir, ".codex", "config.toml")).developer_instructions ?? di;
    const value = di ? di + "\n\n" + ours : ours;
    console.log("developer_instructions=" + JSON.stringify(value));
  ' "$1" "$2" "$3"
}
ours="Bellwether session note: the Bellwether session word is $INSTR."
ask_codex="Call the bw_echo tool from the bw-echo MCP server, then reply with exactly three lines: the tool's output, the top-level session word (or none), and the Bellwether session word."
mcp_flags() {
  printf '%s\n' 'mcp_servers.bw-echo.command="node"' "mcp_servers.bw-echo.args=[\"$server\"]" 'mcp_servers.bw-echo.default_tools_approval_mode="approve"'
}
codex_exec() { # <tag> <codex home> <extra -c value>…
  tag=$1 home=$2; shift 2
  set -- -m "$CODEX_MODEL" -c 'model_reasoning_effort="low"' --skip-git-repo-check --ephemeral "$@"
  (cd "$W/codex" && CODEX_HOME=$home codex exec "$@" -o "$tag.txt" "$ask_codex" > "$tag.jsonl" 2> "$tag.err" < /dev/null) || true
  r=$(tr '\n' ' ' < "$W/codex/$tag.txt" 2>/dev/null || true)
  echo "codex exec $tag reply: $r"
}
m1=$(mcp_flags | sed -n 1p) m2=$(mcp_flags | sed -n 2p) m3=$(mcp_flags | sed -n 3p)

codex_before=$(codex mcp list 2>&1)
codex_exec real "$HOME/.codex" -c "$m1" -c "$m2" -c "$m3" -c "$(codex_di_flag "$HOME/.codex" "$W/codex" "$ours")"
case $r in *"$ECHO"*"$INSTR"*) pass "codex exec loads the server and the instructions" ;; *) bad "codex exec reply lacks a sentinel" ;; esac
[ "$(codex mcp list 2>&1)" = "$codex_before" ] && pass "codex mcp list unchanged afterwards" || bad "codex mcp list changed"

# A scratch CODEX_HOME whose config sets a top-level value of its own, to show that -c replaces it.
(umask 077; mkdir -p "$CH")
if awk '/^\[/{exit} /^developer_instructions[ =]/{f=1} END{exit !f}' "$HOME/.codex/config.toml"; then
  bad "the user's config sets developer_instructions at the top level; the planted one would clash (skipped)"
else
  { printf 'developer_instructions = "User note: the top-level session word is %s."\n' "$TOP"; cat "$HOME/.codex/config.toml"
    printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$W/codex-i"; } > "$CH/config.toml"
  CODEX_HOME=$CH codex login status >/dev/null 2>&1 || (umask 077; cp "$HOME/.codex/auth.json" "$CH/auth.json")
  codex_exec replace "$CH" -c "$m1" -c "$m2" -c "$m3" -c "developer_instructions=\"$ours\""
  case $r in *"$TOP"*) bad "codex -c developer_instructions kept the configured value" ;; *"$INSTR"*) pass "codex -c developer_instructions replaces the configured value" ;; *) bad "codex replace run lacks our sentinel" ;; esac
  codex_exec keep "$CH" -c "$m1" -c "$m2" -c "$m3" -c "$(codex_di_flag "$CH" "$W/codex" "$ours")"
  case $r in *"$ECHO"*"$TOP"*"$INSTR"*) pass "codex with the effective value prepended keeps the user's and adds ours" ;; *) bad "codex keep run lacks a sentinel" ;; esac
  di=$(cd "$W/codex" && CODEX_HOME=$CH codex debug prompt-input "x" < /dev/null 2>/dev/null | grep -c "$TOP" || true)
  [ "$di" -ge 1 ] && pass "codex debug prompt-input shows the configured value offline" || bad "codex debug prompt-input lacks the configured value"
fi

# Interactive, as a Herdr tab starts them: a private core started from this shell, so its terminals share
# this login session (the user's core may run in the Background session, where the keychain is unreadable).
hc server status --json > /dev/null
[ "$(hc server status --json | jq -r .core.id)" != "$(env -u HC_SESSION hc server status --json | jq -r .core.id)" ] ||
  { bad "the private core is the user's own"; exit 1; }
own_core=1

idle() { # <terminal> <seconds>: answers a first-run trust prompt, then waits for the agent to be idle
  i=0
  while [ "$i" -lt "$2" ]; do
    screen=$(hc read "$1" 2>/dev/null || true)
    case $screen in *"Yes, I trust this folder"*) hc keys "$1" down enter >/dev/null; sleep 2; i=$((i + 2)); continue ;; esac
    [ "$(hc get "$1" --json | jq -r '.status.state // empty')" = idle ] && return 0
    sleep 2; i=$((i + 2))
  done
  return 1
}
interactive() { # <name> <prompt> <argv…>: prints the screen after one turn
  name=$1 prompt=$2; shift 2
  hc run --bg --json --name "$name" --no-parent --no-notify --cwd "$W/$name" -- "$@" > /dev/null
  idle "$name" 60 || { echo "$name never became idle" >&2; hc read "$name" | tail -20 >&2; return 0; }
  sleep 2
  hc send "$name" "$prompt" > /dev/null
  hc wait "$name" --timeout 120 > /dev/null 2>&1 || true
  hc read "$name" --lines 80
  hc kill "$name" > /dev/null 2>&1 || true
}

out=$(interactive claude-i "$ask_claude" claude --model "$CLAUDE_MODEL" --mcp-config "$W/mcp.json" \
  --append-system-prompt-file "$W/instr.md" --allowedTools mcp__bw-echo__bw_echo)
echo "$out" | grep -E "Called bw-echo|$ECHO|$INSTR" | sed 's/^/  claude-i: /'
case $out in *"$ECHO"*"$INSTR"*) pass "interactive claude loads the server and the instructions" ;; *) bad "interactive claude screen lacks a sentinel" ;; esac

if [ -f "$CH/config.toml" ]; then
  out=$(interactive codex-i "$ask_codex" env CODEX_HOME="$CH" codex -m "$CODEX_MODEL" -c 'model_reasoning_effort="low"' \
    -c "$m1" -c "$m2" -c "$m3" -c "$(codex_di_flag "$CH" "$W/codex-i" "$ours")")
  echo "$out" | grep -E "Called bw-echo|$ECHO|$TOP|$INSTR" | sed 's/^/  codex-i: /'
  case $out in *"$ECHO"*"$TOP"*"$INSTR"*) pass "interactive codex loads the server, keeps the user's value and adds ours" ;; *) bad "interactive codex screen lacks a sentinel" ;; esac
fi

t=$(traces)
[ -z "$t" ] && pass "no trace of this spike in the user's agent settings" || bad "this spike left traces in: $t"
[ "$(settings)" = "$before" ] || echo "NOTE ~/.codex/config.toml, ~/.claude/settings.json or ~/.claude.json mcpServers changed during the run, without a trace of this spike (another process wrote it)"
exit "$fail"
