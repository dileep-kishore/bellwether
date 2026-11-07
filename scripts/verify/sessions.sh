#!/bin/sh
# Done check 2 without a window: bw feed on the six recordings, then real Claude and Codex fed,
# sent to and refused through bw, here and on another machine. Each chat's first message goes
# through `bw send --expect-session none`, as a fresh chat tab sends it.
#   scripts/verify/sessions.sh [--offline] [--machine <name>]
# --offline runs only the recordings' checks (scripts/test.sh runs it). Without --machine the
# other machine's half prints PENDING. Spends tokens: Claude haiku and Codex gpt-6-luna, low effort.
# Here, agents run in a private hc core (HC_SESSION=bw-sessions) started from this shell, in scratch
# git repositories under /private/tmp/claude-501/bw-sessions, Codex with a scratch CODEX_HOME holding
# a copy of ~/.codex/auth.json. On <name>, Codex runs in that machine's core under
# $BW_SESSIONS_REMOTE_ROOT (default: $HOME/bw-verify/sessions there), and the helper's `current` link
# is moved aside to show it missing, then reinstalled by `bw machine install <name>`.
# Prints PASS <check>, FAIL <check>: <why> or PENDING <check>: <why>; exits 1 on any FAIL. On exit it
# stops the private core, kills its terminals on <name>, deletes the scratch folders (auth.json
# copies included) and the Claude project folders its runs wrote, and puts the helper link back.
# Claude's trust dialog leaves an entry per scratch folder in ~/.claude.json, as record-session's do;
# the script never edits that file, since a running Claude may be writing it.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"
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

cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
bw=$src/target/release/bw

if [ "$offline" = 1 ]; then
  exec bun "$src/scripts/verify/sessions-run.js" --bw "$bw" --offline
fi

L=/private/tmp/claude-501/bw-sessions
R=
core=bw-sessions
core_pid=
helper_rel=.local/share/bellwether/helper

# Agents started from inside another Claude session inherit CLAUDE_CODE_CHILD_SESSION, which turns
# transcript saving off; the private core and everything it starts get a bare environment.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG=en_US.UTF-8 TERM=xterm-256color \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}

cfail() { echo "FAIL cleanup: $*"; cleanup_failed=1; }
cleanup_failed=0
cleanup() {
  HC_SESSION=$core "$hc" server stop > /dev/null 2>&1
  if [ -n "$machine" ] && [ -f "$L/remote-terminals" ]; then
    while read -r t; do
      "$hc" kill "$t" > /dev/null 2>&1
      [ "$("$hc" get --json "$t" 2> /dev/null | jq -r .state 2> /dev/null)" = live ] && cfail "$t is still live"
    done < "$L/remote-terminals"
  fi
  # Asking a stopped core anything starts it again, so look at its process and the agents' folders.
  sleep 2
  [ -n "$core_pid" ] && kill -0 "$core_pid" 2> /dev/null && cfail "the $core core (pid $core_pid) still runs"
  left=$(lsof -a -d cwd -Fn 2> /dev/null | grep -c "^n$L/")
  [ "$left" -gt 0 ] && cfail "$left process(es) still run in $L"
  if [ -n "$machine" ]; then
    # The run moved helper/current aside; put it back unless the install made a new one.
    "$hc" exec --on "$machine" -- sh -c 'h=$HOME/$1; [ -L "$h/current.bw-sessions" ] || exit 0
      if [ -e "$h/current" ]; then rm "$h/current.bw-sessions"; else mv "$h/current.bw-sessions" "$h/current"; fi' \
      sh "$helper_rel" > /dev/null 2>&1 || cfail "helper link on $machine"
    if [ -n "$R" ]; then
      "$hc" exec --on "$machine" -- sh -c '[ -f "$1/.bw-verify" ] && rm -rf "$1"; [ ! -e "$1" ]' sh "$R" > /dev/null 2>&1 ||
        cfail "$R on $machine is still there"
    fi
  fi
  # Claude writes each scratch repository's log under ~/.claude/projects/<its path with - for others>.
  for d in "$L"/claude-*; do
    [ -d "$d" ] || continue
    p=$HOME/.claude/projects/$(printf %s "$d" | sed 's/[^A-Za-z0-9]/-/g')
    [ -d "$p" ] && rm -rf "$p"
    [ -e "$p" ] && cfail "$p is still there"
  done
  scratch_rm "$L" || cfail "$L is still there"
  [ -e "$L" ] && cfail "$L is still there"
  [ "$cleanup_failed" = 0 ] || exit 1
}

[ -e "$L" ] && { scratch_rm "$L" || { echo "FAIL setup: $L is left from another run and has no marker"; exit 1; }; }
scratch_make "$L" || { echo "FAIL setup: scratch $L"; exit 1; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

core_pid=$(clean HC_SESSION=$core "$hc" server status --json | jq -r .pid) && [ -n "$core_pid" ] ||
  { echo "FAIL setup: private core $core"; exit 1; }
set -- --bw "$bw" --scratch "$L" --core "$core"

if [ -n "$machine" ]; then
  home=$("$hc" exec --on "$machine" -- sh -c 'printf %s "$HOME"' 2>&1) && [ -n "$home" ] ||
    { echo "FAIL setup: hc exec --on $machine cannot read its HOME: $home"; exit 1; }
  R=${BW_SESSIONS_REMOTE_ROOT:-$home/bw-verify/sessions}
  "$hc" exec --on "$machine" -- sh -c '[ ! -e "$1" ] || [ -f "$1/.bw-verify" ] && rm -rf "$1" && umask 077 &&
    mkdir -p "$1" && : > "$1/.bw-verify"' sh "$R" > /dev/null 2>&1 ||
    { echo "FAIL setup: $R on $machine (a folder without .bw-verify is never deleted)"; R=; exit 1; }
  set -- "$@" --machine "$machine" --remote-root "$R"
fi

bun "$src/scripts/verify/sessions-run.js" "$@"
status=$?
[ -z "$machine" ] && echo "PENDING the other machine's half: no --machine given"
exit "$status"
