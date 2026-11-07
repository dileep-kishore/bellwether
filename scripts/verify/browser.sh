#!/bin/sh
# Done check 6 without a window: real Claude and Codex agents share one Bellwether Chrome through the flags
# bw browser agent-args gives them, each clicking in a tab of its own, Codex on another machine through a real
# ssh -R forward, and nothing outside the run's sessions gains the MCP server.
#   scripts/verify/browser.sh --offline | --machine <name>
# --offline runs no agent and starts nothing: the files exist, bun test tests/browser passes, and bw browser
# status parses. --machine takes only a machine hc machine ls --json marks temporary (bwloop): its helper is
# installed for the run, bw browser agent-args reaches it through a scratch sshd (lib-sshd.sh), and
# scripts/verify/home-files.sh puts back each file the run changed under its ~/.claude, ~/.codex, Bellwether's
# folder, ~/.npm and ~/.cache/chrome-devtools-mcp, and deletes each file and folder the run created there.
# Here, the Chrome runs on a scratch profile and a free port (BW_CHROME_PROFILE, BW_CHROME_PORT; never 9222 or
# the real profile) and is stopped with bw browser down; local agents run in a private hc core (HC_SESSION=
# bw-browser); bw browser forward runs in the user's core, the only one that knows the machine, and the files
# it and agent-args write under ~/.local/share/bellwether/{agent,browser} are put back the same way.
# Prints PASS <check>: <what> or FAIL <check>: <why>; exits 1 on any FAIL, including when ~/.claude/settings.json,
# ~/.codex/hooks.json or ~/.codex/config.toml changed, ~/.claude.json gained a bw-browser or sentinel text, or
# the user's own Chrome processes changed. BW_CLAUDE_MODEL (haiku) and BW_CODEX_MODEL (gpt-6-luna) pick models.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"
. "$src/scripts/verify/lib-sshd.sh"
. "$src/scripts/verify/lib-terminals.sh"
hc=${BW_HC:-hc}
offline=0 machine=
while [ $# -gt 0 ]; do
  case $1 in
    --offline) offline=1; shift ;;
    --machine) machine=${2:?--machine needs a name}; shift 2 ;;
    *) sed -n 5p "$0" >&2; exit 2 ;;
  esac
done
[ "$offline" = 1 ] && [ -n "$machine" ] && { echo "--offline and --machine exclude each other" >&2; exit 2; }
[ "$offline" = 1 ] || [ -n "$machine" ] || { echo "the live run needs --machine <a temporary machine>, for Codex there" >&2; exit 2; }

# The user's core is the default one; a calling agent's markers would leak into the agents this starts
# (CLAUDE_CODE_CHILD_SESSION turns transcripts off, CODEX_HOME would move Codex's config).
unset HC_SESSION
for v in $(env | grep -Eo '^(CLAUDE[A-Z0-9_]*|CODEX_[A-Z0-9_]*|ANTHROPIC_API_KEY)='); do unset "${v%=}"; done

failed=0
pass() { echo "PASS $1: $2"; }
fail() { echo "FAIL $1: $2"; failed=1; }

cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
bw=$src/target/release/bw

free_port() {
  _fp=$(_sshd_free_port)
  while [ "$_fp" = 9222 ]; do _fp=$(_sshd_free_port); done
  echo "$_fp"
}

if [ "$offline" = 1 ]; then
  for f in tests/browser/page.html tests/browser/server.js tests/browser/cdp.js agent/browser.md agent/browser-claude.md \
    agent/browser-codex.md agent/browser-mcp scripts/verify/lib-sshd.sh scripts/verify/home-files.sh; do
    [ -s "$src/$f" ] && pass "exists" "$f" || fail "exists" "$f is missing or empty"
  done
  if out=$(cd "$src" && bun test tests/browser 2>&1) && n=$(printf %s "$out" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p') && [ "${n:-0}" -gt 0 ]; then
    pass "browser-tests" "bun test tests/browser: $n pass"
  else
    fail "browser-tests" "$(printf %s "$out" | tail -5 | tr '\n' ' ')"
  fi
  tmp=$(mktemp -d /private/tmp/claude-501/bwv-offline.XXXXXX) || { echo "FAIL setup: mktemp"; exit 1; }
  port=$(free_port)
  out=$(BW_CHROME_PORT=$port BW_CHROME_PROFILE=$tmp/chrome HERDR_APP_HOME=$tmp/app "$bw" browser status 2>&1)
  if printf '%s\n' "$out" | jq -e -s 'length > 0 and .[0].type == "chrome" and .[0].state == "stopped" and (.[0].port | tostring) == $p' \
    --arg p "$port" > /dev/null 2>&1; then
    pass "status-parses" "bw browser status on a free port ($port) prints JSON lines, the first a chrome line saying stopped"
  else
    fail "status-parses" "$(printf %s "$out" | head -3 | tr '\n' ' ')"
  fi
  rm -rf "$tmp"
  exit "$failed"
fi

for c in bun jq curl lsof uuidgen claude codex npx ssh-keygen shasum; do
  command -v "$c" > /dev/null || { echo "FAIL setup: $c is not on PATH"; exit 1; }
done
# The run installs a helper there and writes its ~/.codex, ~/.npm and Bellwether's folder; only a temporary
# machine has no other writer whose changes the cleanup could undo.
if ! "$hc" machine ls --json 2> /dev/null |
  jq -e --arg m "$machine" 'any(.machines[]?; .name == $m and .temporary == true)' > /dev/null 2>&1; then
  echo "--machine $machine: hc machine ls --json does not mark it temporary; this run installs a helper there and writes and puts back its home folders, so it runs only on a temporary machine such as bwloop" >&2
  exit 2
fi

# No "bw-browser" in any scratch path: Claude records each folder it runs in in ~/.claude.json, which the trace
# check reads.
L=/private/tmp/claude-501/bwv-chrome
core=bw-browser
CLAUDE_MODEL=${BW_CLAUDE_MODEL:-haiku} CODEX_MODEL=${BW_CODEX_MODEL:-gpt-6-luna}
SENT_TOP=BW-SENT-TOP-$(uuidgen | cut -c1-8) SENT_PROJ=BW-SENT-PROJ-$(uuidgen | cut -c1-8)
local_paths=".local/share/bellwether/agent .local/share/bellwether/browser"
remote_paths=".claude .codex .local/share/bellwether .npm .cache/chrome-devtools-mcp"
home_files=$(cat "$src/scripts/verify/home-files.sh") || { echo "FAIL setup: read home-files.sh"; exit 1; }

real="$HOME/.claude/settings.json $HOME/.codex/hooks.json $HOME/.codex/config.toml"
sums() { for f in $real; do [ -f "$f" ] && shasum -a 256 "$f"; done; }
# The main processes of every Chrome this run did not start (the user's, pid 433 when this was written).
user_chromes() {
  for _p in $(pgrep -f '^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome( |$)'); do
    ps -ww -o pid=,lstart=,command= -p "$_p" 2> /dev/null
  done | grep -vF -- "--user-data-dir=$L/" | sort
}
claude_mcp_names() {
  (cd "$L" && clean env -u ANTHROPIC_API_KEY claude mcp list 2>&1) |
    grep -v -e '^Checking MCP server health' -e '^[[:space:]]*$' | sed -E 's/ - (✔|✘|!|-) .*$//' | sort
}
# Agents started from inside another session inherit its markers; the private core and its terminals get a
# bare environment.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG=en_US.UTF-8 TERM=xterm-256color \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
hcr() { HC_SESSION=$core "$hc" "$@"; }
there() { "$hc" exec --on "$machine" -- "$@"; }
helper_there() { there sh -c '"$HOME"/.local/share/bellwether/helper/current/bw "$@"' sh "$@"; }
# start_bg <name> <argv>: runs it in the background, its first stdout line in $L/<name>.out, its pid in $L/<name>.pid.
start_bg() {
  _n=$1
  shift
  "$@" < /dev/null > "$L/$_n.out" 2> "$L/$_n.err" &
  echo $! > "$L/$_n.pid"
  _i=50
  until [ -s "$L/$_n.out" ]; do
    _i=$((_i - 1))
    [ "$_i" -gt 0 ] && kill -0 "$(cat "$L/$_n.pid")" 2> /dev/null || { cat "$L/$_n.err" >&2; return 1; }
    sleep 0.2
  done
  head -1 "$L/$_n.out"
}
clicks() { jq -s -c 'map("\(.who):\(.button)") | sort' "$L/clicks.jsonl" 2> /dev/null; }
click_count() { jq -s --arg w "$1" --argjson b "$2" 'map(select(.who == $w and .button == $b)) | length' "$L/clicks.jsonl" 2> /dev/null || echo 0; }
# wait_click <who> <button> <seconds>
wait_click() {
  _i=$3
  until [ "$(click_count "$1" "$2")" -ge 1 ]; do
    _i=$((_i - 1))
    [ "$_i" -gt 0 ] || return 1
    sleep 1
  done
}
# The Chrome pages whose URL's who= is $1, from /json/list.
pages_of() {
  curl -s --max-time 3 "http://127.0.0.1:$cport/json/list" |
    jq -r --arg w "$1" '.[] | select(.type == "page") | select((.url | capture("[?&]who=(?<w>[^&#]*)")?.w) == $w) | .id'
}
close_tabs() { for _id in $(pages_of "$1"); do "$bw" browser close --id "$_id" > /dev/null 2>&1; done; }
show() { sed '/^[[:space:]]*$/d' | tail -"${2:-8}" | cut -c1-200 | sed "s/^/  $1| /"; }
slug() { printf %s "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

before=$(sums)
chromes_before=$(user_chromes)
R= H= local_saved=0 cport= sport= fport= started=false core_pid= forward_up=0 remote_terms= terms_before=
remote_before= helper_before= local_before=

cleanup() {
  status=$1
  set +e
  for t in $remote_terms; do "$hc" kill "$t" > /dev/null 2>&1; "$hc" rm "$t" > /dev/null 2>&1; done
  if [ "$forward_up" = 1 ]; then
    out=$("$bw" browser forward stop --machine "$machine" 2>&1)
    [ "$(printf %s "$out" | jq -r .state 2> /dev/null)" = stopped ] || fail "cleanup" "bw browser forward stop --machine $machine: $out"
  fi
  # A "+" for another machine during the run starts bw-fwd-*/bw-warm-* here too: only the names this
  # run's machine gets, absent at the start, are this run's.
  own=$(run_names "$machine")
  "$hc" ls --all --json 2> /dev/null | sort_new "$terms_before" $own | while read -r k t n; do
    if [ "$k" = own ]; then
      "$hc" kill "$t" > /dev/null 2>&1
      "$hc" rm "$t" > /dev/null 2>&1
    else
      echo "NOTE left $n ($t) running: a bw- terminal this run did not start"
    fi
  done
  left=$("$hc" ls --all --json 2> /dev/null | sort_new "$terms_before" $own | awk '$1 == "own" { printf "%s ", $2 }')
  left=$left$("$hc" ls --all --json 2> /dev/null |
    jq -r '[.terminals[]? | select(.state == "live") | select((.name // "") | startswith("bwv-")) | .address] | join(" ")')
  [ -z "$left" ] && pass "cleanup-terminals" "the user's core lists no live terminal of this run (bwv-*, $(echo $own))" ||
    fail "cleanup-terminals" "still live in the user's core: $left"
  HC_SESSION=$core "$hc" server stop > /dev/null 2>&1
  for p in "$L"/*.pid; do [ -f "$p" ] && kill "$(cat "$p")" 2> /dev/null; done
  # MCP servers whose agent ended without stopping them; ours name this run's ports.
  for p in $(pgrep -f "chrome-devtools-mcp@1.12.0 --wsEndpoint ws://127.0.0.1:(${cport:-x}|${fport:-x})/"); do
    echo "NOTE killed a chrome-devtools-mcp its agent left running: $(ps -ww -o command= -p "$p" | cut -c1-120)"
    kill "$p" 2> /dev/null
  done
  sshd_down "$L/sshd" > /dev/null 2>&1
  i=10
  while [ -n "$(pgrep -f "$L/sshd/")" ] && [ "$i" -gt 0 ]; do sleep 0.5; i=$((i - 1)); done
  [ -z "$(pgrep -f "$L/sshd/")" ] || fail "cleanup" "a scratch sshd under $L/sshd still runs"
  # Only this run uses the scratch profile, so any Chrome on it is this run's.
  if [ "$started" = true ] || pgrep -f -- "--user-data-dir=$L/chrome" > /dev/null; then
    out=$("$bw" browser down 2>&1)
    [ "$(printf %s "$out" | jq -r .state 2> /dev/null)" = stopped ] || fail "chrome-down" "bw browser down: $out"
    # down answers once the port and SingletonLock are gone; the process may live about 10 s longer.
    i=20
    while pgrep -f -- "--user-data-dir=$L/chrome" > /dev/null && [ "$i" -gt 0 ]; do sleep 1; i=$((i - 1)); done
    if pgrep -f -- "--user-data-dir=$L/chrome" > /dev/null; then
      fail "chrome-down" "a Chrome on $L/chrome still runs 20 s after bw browser down: $(pgrep -fl -- "--user-data-dir=$L/chrome" | cut -c1-120 | head -2 | tr '\n' ' ')"
    else
      pass "chrome-down" "bw browser down said stopped and no process on the scratch profile is left ($((20 - i)) s after)"
    fi
  fi
  if [ "$local_saved" = 1 ]; then
    out=$(sh -c "$home_files" sh restore "$HOME" "$L/saved-local" $local_paths 2>&1) || fail "cleanup" "could not put back $local_paths here: $out"
    [ "$(sh -c "$home_files" sh sums "$HOME" $local_paths)" = "$local_before" ] &&
      pass "cleanup-local-files" "~/.local/share/bellwether/agent and browser hold what they held before the run" ||
      fail "cleanup-local-files" "~/.local/share/bellwether/agent or browser differ from before the run"
  fi
  if [ -n "$H" ]; then
    out=$(there sh -c "$home_files" sh restore "$H" "$R/saved" $remote_paths 2>&1) || fail "cleanup" "could not put back $remote_paths on $machine: $out"
    [ "$(there sh -c "$home_files" sh sums "$H" $remote_paths 2>&1)" = "$remote_before" ] &&
      pass "cleanup-remote-files" "$machine's $remote_paths hold what they held before the run" ||
      fail "cleanup-remote-files" "$machine's $remote_paths differ from before the run"
    now=$(there sh -c 'readlink "$1/current"; ls "$1"' sh "$H/.local/share/bellwether/helper" 2>&1)
    [ "$now" = "$helper_before" ] && pass "cleanup-helper" "$machine's helper/current points at $(printf %s "$now" | head -1) again and no helper folder was added" ||
      fail "cleanup-helper" "$machine's helper folder is now: $(printf %s "$now" | tr '\n' ' ')"
    new=$(there sh -c 'find "$1" \( -type f -o -type l \) -newer "$2/.bw-verify" ! -path "$1/.local/state/*" ! -path "$2/*" | head -5' sh "$H" "$R" 2>&1)
    [ -z "$new" ] || fail "cleanup-remote-files" "files written on $machine during the run outside the folders put back: $(printf %s "$new" | tr '\n' ' ')"
  fi
  if [ -n "$R" ]; then
    there sh -c '[ -f "$1/.bw-verify" ] && rm -rf "$1"; [ ! -e "$1" ]' sh "$R" > /dev/null 2>&1 || fail "cleanup" "$R on $machine is still there"
  fi
  sleep 2
  [ -n "$core_pid" ] && kill -0 "$core_pid" 2> /dev/null && fail "cleanup" "the $core core (pid $core_pid) still runs"
  # Claude writes each folder's log under ~/.claude/projects/<its path with - for others>, and a scratchpad
  # under /private/tmp/claude-<uid>/<the same name>; they stay with $L while a process still uses it.
  logs=$(for d in "$L" "$L"/*; do [ -d "$d" ] && slug "$d"; done)
  if scratch_rm_idle "$L" $(cat "$L"/*.pid 2> /dev/null) $core_pid; then
    for p in $logs; do rm -rf "$HOME/.claude/projects/$p" "/private/tmp/claude-$(id -u)/$p"; done
  else
    fail "cleanup" "kept $L and its folders' Claude logs for the processes above"
  fi
  [ "$(sums)" = "$before" ] && pass "settings-unchanged" "sha256 of ~/.claude/settings.json, ~/.codex/hooks.json and ~/.codex/config.toml as before: $(sums | cut -c1-12 | tr '\n' ' ')" ||
    fail "settings-unchanged" "~/.claude/settings.json, ~/.codex/hooks.json or ~/.codex/config.toml changed during the run"
  t=$(grep -lF -e bw-browser -e "$SENT_TOP" -e "$SENT_PROJ" "$HOME/.claude.json" $real 2> /dev/null)
  [ -z "$t" ] && pass "no-trace" "~/.claude.json and the files above hold no bw-browser, $SENT_TOP or $SENT_PROJ text (~/.claude.json is not hashed: Claude sessions elsewhere on this Mac write it)" ||
    fail "no-trace" "bw-browser or a sentinel is in: $t"
  [ "$(user_chromes)" = "$chromes_before" ] &&
    pass "user-chrome" "the user's Chrome processes are as before: $(printf %s "$chromes_before" | awk '{print "pid " $1}' | tr '\n' ' ')" ||
    fail "user-chrome" "the user's Chrome processes changed: before [$chromes_before] now [$(user_chromes)]"
  [ "$failed" = 0 ] && exit "$status"
  exit 1
}

# The pids a killed run recorded count as its processes.
[ -e "$L" ] && { scratch_rm_idle "$L" $(cat "$L"/*.pid 2> /dev/null) || { echo "FAIL setup: $L is left from another run and was not deleted (above)"; exit 1; }; }
scratch_make "$L" || { echo "FAIL setup: scratch $L"; exit 1; }
trap 'cleanup $?' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$L/app" "$L/cache" "$L/claude-p" "$L/claude-i" "$L/sent/home" "$L/sent/plain" "$L/sent/proj/.codex" "$L/saved-local"
(umask 077; mkdir "$L/chrome")
cport=$(free_port)
export BW_CHROME_PORT=$cport BW_CHROME_PROFILE=$L/chrome HERDR_APP_HOME=$L/app BW_CACHE_DIR=$L/cache
terms_before=$("$hc" ls --all --json 2> /dev/null)

pass "settings-before" "$(sums | awk '{print $1}' | cut -c1-12 | tr '\n' ' ')for $real; user Chrome pids $(printf %s "$chromes_before" | awk '{print $1}' | tr '\n' ' ')"
local_before=$(sh -c "$home_files" sh sums "$HOME" $local_paths)
out=$(sh -c "$home_files" sh save "$HOME" "$L/saved-local" $local_paths 2>&1) || { echo "FAIL setup: could not save $local_paths: $out"; exit 1; }
# Set only once saved: a restore without a save would delete the folders' files.
local_saved=1
claude_before=$(claude_mcp_names)
codex_before=$(codex mcp list 2>&1)
if printf '%s\n' "$claude_before" "$codex_before" | grep -q bw-browser; then
  fail "mcp-lists-before" "claude mcp list or codex mcp list already names bw-browser"
else
  pass "mcp-lists-before" "claude mcp list names $(printf '%s\n' "$claude_before" | wc -l | tr -d ' ') servers and codex mcp list prints $(printf '%s\n' "$codex_before" | wc -l | tr -d ' ') lines, none bw-browser"
fi

home=$(there sh -c 'printf %s "$HOME"' 2>&1) && [ -n "$home" ] || { echo "FAIL setup: hc exec --on $machine cannot read its HOME: $home"; exit 1; }
R=$home/bw-verify/chrome
there sh -c '{ [ ! -e "$1" ] || [ -f "$1/.bw-verify" ]; } && rm -rf "$1" && umask 077 &&
  mkdir -p "$1/saved" "$1/codex-r" "$1/codex-home" && : > "$1/.bw-verify"' sh "$R" > /dev/null 2>&1 ||
  { echo "FAIL setup: $R on $machine (a folder without .bw-verify is never deleted)"; R=; exit 1; }
remote_before=$(there sh -c "$home_files" sh sums "$home" $remote_paths 2>&1)
helper_before=$(there sh -c 'readlink "$1/current"; ls "$1"' sh "$home/.local/share/bellwether/helper" 2>&1)
out=$(there sh -c "$home_files" sh save "$home" "$R/saved" $remote_paths 2>&1) || { echo "FAIL setup: could not save $remote_paths on $machine: $out"; exit 1; }
H=$home

core_pid=$(clean HC_SESSION=$core "$hc" server status --json | jq -r .pid) && [ -n "$core_pid" ] || { echo "FAIL setup: private core $core"; exit 1; }
[ "$(hcr server status --json | jq -r .core.id)" != "$("$hc" server status --json | jq -r .core.id)" ] || { echo "FAIL setup: the private core is the user's own"; exit 1; }

out=$("$bw" machine install "$machine" 2>&1)
end=$(printf '%s\n' "$out" | tail -1)
v=$(helper_there version 2>&1)
if [ "$(printf %s "$end" | jq -r .type 2> /dev/null)" = installed ] && [ "$(printf %s "$v" | jq -r .version 2> /dev/null)" = "$("$bw" version | jq -r .version)" ]; then
  pass "helper-installed" "bw machine install $machine: $(printf %s "$v" | jq -c '{protocol, version}') there (was $(printf %s "$helper_before" | head -1))"
else
  fail "helper-installed" "bw machine install $machine: $end; bw version there: $v"
  exit 1
fi

up=$("$bw" browser up 2>&1)
started=$(printf %s "$up" | jq -r .started 2> /dev/null)
chrome_id=$(printf %s "$up" | jq -r .browser_id 2> /dev/null)
if [ "$(printf %s "$up" | jq -r .state 2> /dev/null)" = running ] && [ -n "$chrome_id" ]; then
  pass "chrome-up" "bw browser up: running on 127.0.0.1:$cport, scratch profile, $(printf %s "$up" | jq -r .version), was running before: $([ "$started" = true ] && echo no || echo yes)"
else
  fail "chrome-up" "bw browser up: $up"
  exit 1
fi

srv=$(start_bg clicksrv bun "$src/tests/browser/server.js" --port 0 --log "$L/clicks.jsonl") && sport=$(printf %s "$srv" | jq -r .port) ||
  { fail "click-server" "tests/browser/server.js did not start"; exit 1; }
pass "click-server" "tests/browser/server.js serves page.html on 127.0.0.1:$sport and logs clicks"

ssh_out=$(sshd_up "$L/sshd" 2>&1) || { fail "scratch-sshd" "$ssh_out"; exit 1; }
SSH_CONFIG=$(printf %s "$ssh_out" | sed -n 's/^SSH_CONFIG=\([^ ]*\) .*/\1/p')
SSH_TARGET=$(printf %s "$ssh_out" | sed -n 's/.* SSH_TARGET=\([^ ]*\)$/\1/p')
pass "scratch-sshd" "sshd as $USER on 127.0.0.1:$(cat "$L/sshd/port"), target $SSH_TARGET"

# agent-args here runs in the private core, so the npx warm it may start ends with that core.
a=$(HC_SESSION=$core "$bw" browser agent-args --kind claude --machine "" --cwd "$L/claude-p" 2>&1)
if printf %s "$a" | jq -e '.browser == "ready" and (.argv | index("--mcp-config")) and (.argv | index("--allowedTools")) and
  (.argv | index("--append-system-prompt-file")) and ((.argv | index("--strict-mcp-config")) | not)' > /dev/null 2>&1; then
  claude_q=$(printf %s "$a" | jq -r '.argv | @sh')
  pass "agent-args-claude" "here: ready, argv $(printf %s "$a" | jq -c '.argv | map(sub(".*/"; "…/"))'), no --strict-mcp-config"
else
  fail "agent-args-claude" "$a"
  exit 1
fi
forward_up=1
a=$("$bw" browser agent-args --kind codex --machine "$machine" --cwd "$R/codex-r" --target "$SSH_TARGET" --ssh-config "$SSH_CONFIG" 2>&1)
if printf %s "$a" | jq -e '.browser == "ready" and (.argv | any(startswith("mcp_servers.bw-browser.args="))) and
  (.argv | any(startswith("developer_instructions=")))' > /dev/null 2>&1; then
  codex_q=$(printf %s "$a" | jq -r '.argv | @sh')
  pass "agent-args-codex" "$machine through $SSH_TARGET: ready, $(printf %s "$a" | jq '.argv | length') argv items: $(printf %s "$a" | jq -r '[.argv[] | select(startswith("mcp_servers") or startswith("developer")) | split("=")[0]] | join(", ")')"
else
  fail "agent-args-codex" "$a"
  exit 1
fi
fwd=$("$bw" browser status 2>&1 | jq -c --arg m "$machine" 'select(.type == "forward" and .machine == $m)')
fport=$(printf %s "$fwd" | jq -r .port)
addrs=$(lsof -nP -iTCP:"$fport" -sTCP:LISTEN -Fn 2> /dev/null | sed -n 's/^n//p' | sort -u | tr '\n' ' ')
via_id=$(curl -s --max-time 3 "http://127.0.0.1:$fport/json/version" | jq -r '.webSocketDebuggerUrl | split("/") | last' 2> /dev/null)
if [ "$(printf %s "$fwd" | jq -r .state)" = ready ] && [ "$addrs" = "127.0.0.1:$fport " ] && [ "$via_id" = "$chrome_id" ]; then
  pass "forward-ready" "bw browser status: forward to $machine ready on port $fport, terminal $(printf %s "$fwd" | jq -r .terminal); lsof lists only 127.0.0.1:$fport; /json/version through it names this Chrome ($chrome_id)"
else
  fail "forward-ready" "forward $fwd; listeners [$addrs]; browser id through it $via_id, Chrome's $chrome_id"
fi
pf=$(there sh -c 'cat "$HOME"/.local/share/bellwether/agent/ports/*' 2>&1)
[ "$pf" = "$(printf '%s\n%s' "$fport" "$chrome_id")" ] &&
  pass "remote-port-file" "$machine's agent/ports file holds the forward's port $fport and the Chrome's id $chrome_id" ||
  fail "remote-port-file" "$machine's agent/ports holds [$pf], the forward is on $fport to browser $chrome_id"

# Codex's rollout and PATH are that machine's; Codex gets a scratch CODEX_HOME holding a copy of auth.json.
rpath=$(there sh -c 'printf %s "$PATH"' 2>&1)
w=$("$hc" file write --json --on "$machine" "$R/codex-home/auth.json" < "$HOME/.codex/auth.json" 2>&1) &&
  there chmod 600 "$R/codex-home/auth.json" > /dev/null 2>&1 || { fail "codex-home" "hc file write auth.json on $machine: $w"; exit 1; }

page() { echo "http://127.0.0.1:$sport/page.html?who=$1"; }
ask() { # <who> <button> <screenshot 0|1>
  _s=
  [ "$3" = 1 ] && _s=" Then take a screenshot of that tab so I can see the result."
  echo "Use the bw-browser browser tools. Open $(page "$1") in a new tab of your own, take a snapshot, and click the button labelled \"Button $2\" exactly once.$_s Reply with the tab's title and URL."
}
start_claude_p() {
  cp_sid=$(uuidgen | tr 'A-Z' 'a-z')
  eval "set -- $claude_q"
  cp_addr=$(hcr run --bg --json --no-parent --no-notify --name "bwv-claude-p$attempt" --cwd "$L/claude-p" -- env -u ANTHROPIC_API_KEY \
    claude --model "$CLAUDE_MODEL" --session-id "$cp_sid" "$@" -p "$(ask claude-p 3 1)" 2>&1 | jq -r .address 2> /dev/null)
}
start_codex_r() {
  eval "set -- $codex_q"
  cr_addr=$("$hc" run --bg --json --on "$machine" --no-parent --no-notify --name "bwv-codex-r$attempt" --cwd "$R/codex-r" -- \
    /usr/bin/env CODEX_HOME="$R/codex-home" PATH="$rpath" codex exec --skip-git-repo-check -m "$CODEX_MODEL" \
    -c 'model_reasoning_effort="low"' -s read-only "$@" "$(ask codex-r 5 1)" 2>&1 | jq -r .address 2> /dev/null)
  remote_terms="$remote_terms $cr_addr"
}

# The two agents run at the same time; one whose click is missing runs once more with the same prompt, after its
# tab is closed so the log still names one tab per agent.
need_p=1 need_r=1 attempt=1
while [ "$attempt" -le 2 ] && [ $((need_p + need_r)) -gt 0 ]; do
  [ "$need_p" = 1 ] && start_claude_p
  [ "$need_r" = 1 ] && start_codex_r
  if [ "$need_p" = 1 ]; then
    hcr wait "$cp_addr" --timeout 300 > /dev/null 2>&1
    echo "claude -p attempt $attempt, last lines:"
    hcr read "$cp_addr" --lines 30 2>&1 | show claude-p
    wait_click claude-p 3 5 && need_p=0 || close_tabs claude-p
  fi
  if [ "$need_r" = 1 ]; then
    "$hc" wait "$cr_addr" --timeout 300 > /dev/null 2>&1
    echo "codex exec on $machine attempt $attempt, last lines:"
    "$hc" read "$cr_addr" --lines 30 2>&1 | show codex-r
    wait_click codex-r 5 5 && need_r=0 || close_tabs codex-r
  fi
  attempt=$((attempt + 1))
done
[ "$need_p" = 0 ] && pass "claude-p-clicked" "claude -p --model $CLAUDE_MODEL with agent-args' argv clicked button 3 in its tab (attempt $((attempt - 1 - need_r)) or earlier)" ||
  fail "claude-p-clicked" "claude -p logged no click on button 3 in two attempts"
[ "$need_r" = 0 ] && pass "codex-clicked" "codex exec -m $CODEX_MODEL on $machine with agent-args' argv, through the forward, clicked button 5 in its tab" ||
  fail "codex-clicked" "codex exec on $machine logged no click on button 5 in two attempts"

got=$(clicks)
pids_p=$(pages_of claude-p) pids_r=$(pages_of codex-r)
trusted=$(jq -s 'all(.trusted == true)' "$L/clicks.jsonl" 2> /dev/null)
if [ "$got" = '["claude-p:3","codex-r:5"]' ] && [ "$(printf '%s\n' "$pids_p" | grep -c .)" = 1 ] &&
  [ "$(printf '%s\n' "$pids_r" | grep -c .)" = 1 ] && [ "$pids_p" != "$pids_r" ] && [ "$trusted" = true ]; then
  pass "click-log" "exactly $got, trusted, each from the one tab with its who= ($(printf %s "$pids_p" | cut -c1-8) and $(printf %s "$pids_r" | cut -c1-8))"
else
  fail "click-log" "clicks $got (trusted: $trusted); tabs who=claude-p [$pids_p], who=codex-r [$pids_r]"
fi

st=$("$bw" browser status 2>&1)
n_p=$(printf '%s\n' "$st" | jq -s --arg u "who=claude-p" '[.[] | select(.type == "tab" and (.url | contains($u)))] | length' 2> /dev/null)
n_r=$(printf '%s\n' "$st" | jq -s --arg u "who=codex-r" '[.[] | select(.type == "tab" and (.url | contains($u)))] | length' 2> /dev/null)
[ "$n_p" = 1 ] && [ "$n_r" = 1 ] && pass "status-tabs" "bw browser status lists Claude's and Codex's tabs ($(printf '%s\n' "$st" | jq -s '[.[] | select(.type == "tab")] | length') tabs in all)" ||
  fail "status-tabs" "bw browser status lists $n_p who=claude-p and $n_r who=codex-r tabs"

out=$(bun "$src/tests/browser/cdp.js" --port "$cport" --who claude-p --click 7 2>&1)
if wait_click claude-p 7 10 && jq -s -e 'last | .who == "claude-p" and .button == 7' "$L/clicks.jsonl" > /dev/null &&
  jq -s -e '(map(select(.who == "claude-p")) | map(.at_ms)) as $t | ($t | length) == 2 and $t[1] > $t[0]' "$L/clicks.jsonl" > /dev/null; then
  pass "stand-in-click" "tests/browser/cdp.js clicked button 7 in Claude's tab; the page logged it after the agent's click"
else
  fail "stand-in-click" "cdp.js: $out; clicks $(clicks)"
fi

# Interactive Claude in the private core, as a Herdr tab starts it.
ci_ok=0 attempt=1
while [ "$attempt" -le 2 ] && [ "$ci_ok" = 0 ]; do
  eval "set -- $claude_q"
  ci=$(hcr run --bg --json --no-parent --no-notify --name "bwv-claude-i$attempt" --cwd "$L/claude-i" -- env -u ANTHROPIC_API_KEY \
    claude --model "$CLAUDE_MODEL" "$@" 2>&1 | jq -r .address 2> /dev/null)
  i=30 ready=0
  while [ "$i" -gt 0 ]; do
    s=$(hcr read "$ci" --lines 60 2>&1)
    case $s in
      *"trust this folder"*) hcr keys "$ci" down enter > /dev/null 2>&1 ;;
      *'Try "'* | *"for shortcuts"*) ready=1; break ;;
    esac
    sleep 2
    i=$((i - 1))
  done
  if [ "$ready" = 1 ]; then
    sleep 2
    hcr send "$ci" "$(ask claude-i 2 0)" > /dev/null 2>&1
    hcr wait "$ci" --timeout 240 > /dev/null 2>&1
    wait_click claude-i 2 10
  fi
  screen=$(hcr read "$ci" --lines 200 2>&1)
  echo "interactive claude attempt $attempt, lines naming bw-browser and the last lines:"
  printf '%s\n' "$screen" | grep -E 'bw-browser' | show claude-i 6
  printf '%s\n' "$screen" | show claude-i 6
  hcr kill "$ci" > /dev/null 2>&1
  if [ "$(click_count claude-i 2)" -ge 1 ] && printf %s "$screen" | grep -q "Called bw-browser"; then ci_ok=1; else close_tabs claude-i; fi
  attempt=$((attempt + 1))
done
got=$(clicks)
if [ "$ci_ok" = 1 ] && [ "$got" = '["claude-i:2","claude-p:3","claude-p:7","codex-r:5"]' ]; then
  pass "interactive-claude" "Claude in the private core shows \"Called bw-browser\" and clicked button 2 in its tab; the log is exactly $got"
else
  fail "interactive-claude" "Called bw-browser on screen and click logged: $ci_ok; clicks $got"
fi

log=$HOME/.claude/projects/$(slug "$L/claude-p")/$cp_sid.jsonl
pics=$("$bw" feed --log "$log" --agent claude --pictures 2>&1 |
  jq -s -c '[.[] | select(.k == "tools") | select(any(.chips[]?.calls[]?; .name == "mcp__bw-browser__take_screenshot")) | select((.pics // []) | length > 0) | .pics[0] | {format, width, height}]' 2> /dev/null)
[ -n "$pics" ] && [ "$pics" != "[]" ] && pass "claude-picture" "bw feed --log <claude -p log> --pictures: the take_screenshot tools row has a picture $pics" ||
  fail "claude-picture" "no picture on a take_screenshot tools row of $log: [$pics]"
roll=$(there sh -c 'ls -t $(find "$1/sessions" -name "rollout-*.jsonl") | head -1' sh "$R/codex-home" 2>&1)
there cat "$roll" > "$L/codex-rollout.jsonl" 2> /dev/null
pics=$("$bw" feed --log "$L/codex-rollout.jsonl" --agent codex --pictures 2>&1 |
  jq -s -c '[.[] | select(.k == "tools") | select((.pics // []) | length > 0) | .pics[0] | {format, width, height}]' 2> /dev/null)
[ -n "$pics" ] && [ "$pics" != "[]" ] && pass "codex-picture" "bw feed --log <codex rollout from $machine> --pictures: a tools row has a picture $pics (Codex passed the screenshot to image(), as browser-codex.md says)" ||
  fail "codex-picture" "no picture on a tools row of $roll; input_image items in it: $(grep -o '"input_image"' "$L/codex-rollout.jsonl" 2> /dev/null | wc -l | tr -d ' ')"

# port-check on that machine: the forward passes; a stub on 0.0.0.0 with this Chrome's id and a stub on
# 127.0.0.1 with another id fail.
cat > "$L/stub.js" << 'JS'
const [host, id] = process.argv.slice(2);
const s = Bun.serve({ hostname: host, port: 0, fetch: () => Response.json({ Browser: "Chrome/stub", webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/devtools/browser/${id}` }) });
console.log(s.port);
JS
check_there() { helper_there browser port-check --port "$1" --browser-id "$chrome_id" 2>&1; }
ok=$(check_there "$fport")
wild=$(start_bg stub-wild bun "$L/stub.js" 0.0.0.0 "$chrome_id")
other=$(start_bg stub-other bun "$L/stub.js" 127.0.0.1 "$(uuidgen | tr 'A-Z' 'a-z')")
bad_w=$(check_there "$wild") bad_o=$(check_there "$other")
if printf %s "$ok" | jq -e '.ok == true' > /dev/null 2>&1 && printf %s "$bad_w" | jq -e '.ok == false' > /dev/null 2>&1 &&
  printf %s "$bad_o" | jq -e '.ok == false and (.reason | contains("answers for browser"))' > /dev/null 2>&1; then
  pass "port-check" "on $machine: the forward's $fport passes with this Chrome's id; a stub on 0.0.0.0:$wild fails ($(printf %s "$bad_w" | jq -r .reason)); a stub with another id on 127.0.0.1:$other fails"
else
  fail "port-check" "forward: $ok; wildcard stub: $bad_w; other-id stub: $bad_o"
fi
for s in stub-wild stub-other; do kill "$(cat "$L/$s.pid")" 2> /dev/null; done

a=$("$bw" browser agent-args --kind codex --machine "$machine" 2>&1)
printf %s "$a" | jq -e '.browser == "unavailable" and .argv == [] and (.reason | contains("via"))' > /dev/null 2>&1 &&
  pass "via" "agent-args --machine $machine without the test target: unavailable, argv [], \"$(printf %s "$a" | jq -r .reason)\"" ||
  fail "via" "$a"

# Codex's effective developer_instructions: the top-level value where no project layer sets one, the trusted
# project's where it does; agent-args' flag must keep that value and add Bellwether's text after it.
printf 'developer_instructions = "%s: the top-level value."\n\n[projects."%s"]\ntrust_level = "trusted"\n\n[projects."%s"]\ntrust_level = "trusted"\n' \
  "$SENT_TOP" "$L/sent/plain" "$L/sent/proj" > "$L/sent/home/config.toml"
printf 'developer_instructions = """\n%s: the trusted project'"'"'s value."""\n' "$SENT_PROJ" > "$L/sent/proj/.codex/config.toml"
sent_check() { # <folder> <kept> <dropped>
  _a=$(CODEX_HOME=$L/sent/home HC_SESSION=$core "$bw" browser agent-args --kind codex --machine "" --cwd "$1" 2>&1)
  printf %s "$_a" | jq -e '.browser == "ready"' > /dev/null 2>&1 || { echo "agent-args: $_a"; return 1; }
  _q=$(printf %s "$_a" | jq -r '.argv | @sh')
  _p=$(cd "$1" && eval "set -- $_q" && CODEX_HOME=$L/sent/home codex "$@" debug prompt-input x < /dev/null 2>&1)
  _k=$(printf %s "$_p" | grep -o "$2: [^\"]*Bellwether browser" | head -1)
  [ -n "$_k" ] && ! printf %s "$_p" | grep -q "$3" && return 0
  echo "$1: prompt-input has $2: $(printf %s "$_p" | grep -c "$2"), $3: $(printf %s "$_p" | grep -c "$3"), Bellwether browser: $(printf %s "$_p" | grep -c 'Bellwether browser')"
  return 1
}
if r1=$(sent_check "$L/sent/plain" "$SENT_TOP" "$SENT_PROJ") && r2=$(sent_check "$L/sent/proj" "$SENT_PROJ" "$SENT_TOP"); then
  pass "codex-sentinel" "codex debug prompt-input with agent-args' argv renders $SENT_TOP then \"Bellwether browser\" in a folder without a project layer, and $SENT_PROJ (the trusted project's own value, which replaces the top-level one) then \"Bellwether browser\" in the project"
else
  fail "codex-sentinel" "${r1:-} ${r2:-}"
fi

claude_after=$(claude_mcp_names)
codex_after=$(codex mcp list 2>&1)
[ "$claude_after" = "$claude_before" ] && ! printf %s "$claude_after" | grep -q bw-browser &&
  pass "claude-mcp-list" "claude mcp list names the same servers as before the run, none bw-browser" ||
  fail "claude-mcp-list" "claude mcp list changed: $(printf '%s\n' "$claude_before" > "$L/m1"; printf '%s\n' "$claude_after" > "$L/m2"; diff "$L/m1" "$L/m2" | tr '\n' ' ')"
[ "$codex_after" = "$codex_before" ] && ! printf %s "$codex_after" | grep -q bw-browser &&
  pass "codex-mcp-list" "codex mcp list prints what it printed before the run, no bw-browser" ||
  fail "codex-mcp-list" "codex mcp list changed"
exit "$failed"
