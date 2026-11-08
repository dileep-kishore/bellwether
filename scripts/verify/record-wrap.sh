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
  left=$(lsof -a -d cwd -Fn 2> /dev/null | grep -c "^n$L/")
  [ "$left" -gt 0 ] && { echo "FAIL cleanup: $left process(es) still run in $L"; status=1; }
  for d in "$L"/claude-*; do
    [ -d "$d" ] || continue
    p=$(printf %s "$d" | sed 's/[^A-Za-z0-9]/-/g')
    rm -rf "$HOME/.claude/projects/$p" "/private/tmp/claude-$(id -u)/$p"
  done
  scratch_rm "$L" || { echo "FAIL cleanup: $L is still there"; status=1; }
  exit "$status"
}

[ -e "$L" ] && { scratch_rm "$L" || { echo "FAIL setup: $L is left from another run and has no marker"; exit 1; }; }
scratch_make "$L" || { echo "FAIL setup: scratch $L"; exit 1; }
trap 'cleanup $?' EXIT
trap 'exit 1' HUP INT TERM

core_pid=$(clean HC_SESSION=$core "$hc" server status --json | jq -r .pid) && [ -n "$core_pid" ] ||
  { echo "FAIL setup: private core $core"; exit 1; }
out=$src/tests/fixtures/screens
clean bun "$src/scripts/verify/record-wrap.js" --scratch "$L" --core "$core" --out "$out" || exit 1
"$src/scripts/verify/scrub-fixture" "$out"/claude-approval-*.txt "$out"/codex-approval-[0-9]*.txt "$out"/codex-new-folder-[0-9]*.txt
