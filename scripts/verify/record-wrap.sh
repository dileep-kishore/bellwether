#!/bin/sh
# Records a Claude approval, a Codex approval and the Codex /new folder prompt, each at two terminal widths,
# into tests/fixtures/screens/ for the rewrap tests, then scrubs them.
# usage: scripts/verify/record-wrap.sh
# Claude haiku (project settings only) and Codex gpt-6-luna (a scratch CODEX_HOME) run in a private core
# (HC_SESSION=bw-wrap) in scratch git repositories under /private/tmp/claude-501/bw-wrap; the core, the
# folders and Claude's project logs for them are removed afterwards.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
. "$src/scripts/verify/lib-scratch.sh"
hc=${BW_HC:-hc}
L=/private/tmp/claude-501/bw-wrap
core=bw-wrap
core_pid=

# Agents started from inside another Claude session inherit CLAUDE_CODE_CHILD_SESSION; the core gets a bare
# environment.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG=en_US.UTF-8 TERM=xterm-256color \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}

cleanup() {
  status=$1
  HC_SESSION=$core "$hc" server stop > /dev/null 2>&1
  sleep 2
  [ -n "$core_pid" ] && kill -0 "$core_pid" 2> /dev/null && { echo "FAIL cleanup: core $core (pid $core_pid) still runs"; status=1; }
  # Claude's logs for the scratch repositories stay with $L while a process still uses it.
  logs=$(for d in "$L"/claude-*; do [ -d "$d" ] && printf '%s\n' "$d" | sed 's/[^A-Za-z0-9]/-/g'; done)
  if scratch_rm_idle "$L" $core_pid; then
    for p in $logs; do rm -rf "$HOME/.claude/projects/$p" "/private/tmp/claude-$(id -u)/$p"; done
  else
    echo "FAIL cleanup: kept $L and its Claude logs for the processes above"
    status=1
  fi
  exit "$status"
}

[ -e "$L" ] && { scratch_rm_idle "$L" || { echo "FAIL setup: $L is left from another run and was not deleted (above)"; exit 1; }; }
scratch_make "$L" || { echo "FAIL setup: scratch $L"; exit 1; }
trap 'cleanup $?' EXIT
trap 'exit 1' HUP INT TERM

core_pid=$(clean HC_SESSION=$core "$hc" server status --json | jq -er .pid) && [ -n "$core_pid" ] ||
  { echo "FAIL setup: private core $core"; exit 1; }
out=$src/tests/fixtures/screens
clean bun "$src/scripts/verify/record-wrap.js" --scratch "$L" --core "$core" --out "$out" || exit 1
"$src/scripts/verify/scrub-fixture" "$out"/claude-approval-*.txt "$out"/codex-approval-[0-9]*.txt "$out"/codex-new-folder-[0-9]*.txt
