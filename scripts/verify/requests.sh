#!/bin/sh
# Done check 3 without a window: approvals and questions of real agents and their sub-agents reach a card and are
# answered with bw answer, pressing keys only into the prompt the card shows, here and on another machine.
#   scripts/verify/requests.sh [--offline] [--machine <name>]
# --offline (scripts/test.sh runs it): bw cards over each tests/fixtures/cards case against its golden, bw hooks
# on copies of tests/fixtures/hooks in a scratch HOME, and the chat's 3 s focus guard in the harness.
# Live, here: Claude haiku (--permission-mode default, hooks from the scratch repository's .claude/settings.json)
# for root, foreground and background sub-agent approvals, a prompt answered in the terminal first, and Deny;
# Codex gpt-6-luna at low effort (a scratch CODEX_HOME with a copy of ~/.codex/auth.json, Bellwether's hooks and
# their trust entries) for root and sub-agent approvals and an async question. Agents run in a private hc core
# (HC_SESSION=bw-requests) in scratch git repositories under /private/tmp/claude-501/bw-requests. Their hooks run
# "$HOME/.local/share/bellwether/hooks/bw-event", so that script is put there for the run and taken away after
# (or put back as it was). With --machine, which must be a machine hc machine ls --json marks temporary (bwloop):
# bw machine setup <name> --diff, --apply, --check, a trust step written into <name>'s ~/.codex/config.toml, then
# Codex there (CODEX_HOME=~/.codex) for an approval, a stale card and an async question, all through the helper
# there; on exit --remove, and scripts/verify/home-files.sh puts back each file under <name>'s ~/.claude, ~/.codex
# and Bellwether's hooks and backups folders that the run changed or removed, and deletes each file and folder
# the run created.
# BW_VERIFY_ONLY=claude,codex,remote runs only those groups, for a rerun. Prints PASS <check> or FAIL <check>: <why>;
# exits 1 on any FAIL, including when ~/.claude/settings.json, ~/.codex/hooks.json or ~/.codex/config.toml here
# changed during the run.
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
    *) sed -n 4p "$0" >&2; exit 2 ;;
  esac
done
[ "$offline" = 1 ] && [ -n "$machine" ] && { echo "--offline and --machine exclude each other" >&2; exit 2; }
# The run writes that machine's real ~/.claude and ~/.codex, and Codex there writes its own files during the run;
# only a temporary machine has no other writer whose changes the cleanup could undo.
if [ -n "$machine" ] && ! "$hc" machine ls --json 2> /dev/null |
  jq -e --arg m "$machine" 'any(.machines[]?; .name == $m and .temporary == true)' > /dev/null 2>&1; then
  echo "--machine $machine: hc machine ls --json does not mark it temporary; this run writes and puts back its ~/.claude and ~/.codex, so it runs only on a temporary machine such as bwloop" >&2
  exit 2
fi

real="$HOME/.claude/settings.json $HOME/.codex/hooks.json $HOME/.codex/config.toml"
sums() { for f in $real; do [ -f "$f" ] && shasum -a 256 "$f"; done; }
before=$(sums)

cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
bw=$src/target/release/bw

if [ "$offline" = 1 ]; then
  status=0
  if out=$(cargo test --locked -q -p bw --manifest-path "$src/Cargo.toml" --test cards cards_goldens_are_current 2>&1); then
    echo "PASS cards-goldens: bw cards over each tests/fixtures/cards case ($(ls "$src/tests/fixtures/cards" | wc -l | tr -d ' ') goldens) equals its golden"
  else
    echo "FAIL cards-goldens: $(printf %s "$out" | grep -E 'stale goldens|panicked|error' | head -3 | tr '\n' ' ')"
    status=1
  fi
  tmp=$(mktemp -d /private/tmp/claude-501/bw-requests-offline.XXXXXX) || { echo "FAIL setup: mktemp"; exit 1; }
  bun "$src/scripts/verify/requests-run.js" --bw "$bw" --offline --scratch "$tmp" || status=1
  rm -rf "$tmp"
  # The guard tests in the chat's harness: disabled while the terminal has focus and until 3 s after, and at mount.
  if out=$(cd "$src" && bun test tests/mods/bw-chat-dock.test.js tests/mods/bw-chat-requests-pure.test.js -t 'focus|guard' 2>&1) &&
    n=$(printf %s "$out" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p') && [ "${n:-0}" -gt 0 ]; then
    echo "PASS focus-guard-harness: $n bw-chat tests: answer buttons disabled while the chat's terminal has focus, until 3000 ms after it left, and at a fresh mount; no bw answer runs while disabled"
  else
    echo "FAIL focus-guard-harness: $(printf %s "$out" | tail -5 | tr '\n' ' ')"
    status=1
  fi
  [ "$(sums)" = "$before" ] || { echo "FAIL settings: the user's Claude or Codex settings changed during the run"; status=1; }
  exit "$status"
fi

L=/private/tmp/claude-501/bw-requests
R= H=
core=bw-requests
core_pid=
hook_script=$HOME/.local/share/bellwether/hooks/bw-event
hook_saved=0 hook_dir_made=0
# The paths under <machine>'s HOME this run may create or change; home-files.sh saves and puts back their files.
remote_paths=".claude .codex .local/share/bellwether/hooks .local/share/bellwether/backups"
home_files=$(cat "$src/scripts/verify/home-files.sh") || { echo "FAIL setup: read home-files.sh"; exit 1; }

# Agents started from inside another Claude session inherit CLAUDE_CODE_CHILD_SESSION, which turns
# transcript saving off; the private core and everything it starts get a bare environment.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG=en_US.UTF-8 TERM=xterm-256color \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}

cfail() { echo "FAIL cleanup: $*"; cleanup_failed=1; }
cleanup_failed=0
# An abort (set -u, a signal) reaches here with its own non-zero status, which must not read as a pass.
cleanup() {
  status=$1
  HC_SESSION=$core "$hc" server stop > /dev/null 2>&1
  if [ -n "$machine" ] && [ -f "$L/remote-terminals" ]; then
    while read -r t; do
      "$hc" kill "$t" > /dev/null 2>&1
      [ "$("$hc" get --json "$t" 2> /dev/null | jq -r .state 2> /dev/null)" = live ] && cfail "$t is still live"
    done < "$L/remote-terminals"
  fi
  if [ -n "$H" ]; then
    "$bw" machine setup "$machine" --remove > "$L/remove.out" 2>&1 || cfail "bw machine setup $machine --remove: $(cat "$L/remove.out")"
    out=$("$hc" exec --on "$machine" -- sh -c "$home_files" sh restore "$H" "$R/saved" $remote_paths 2>&1) ||
      cfail "could not put back $remote_paths on $machine: $out"
    now=$("$hc" exec --on "$machine" -- sh -c "$home_files" sh sums "$H" $remote_paths 2>&1)
    [ "$now" = "$remote_before" ] || cfail "$machine's $remote_paths differ from before the run"
  fi
  if [ -n "$R" ]; then
    "$hc" exec --on "$machine" -- sh -c '[ -f "$1/.bw-verify" ] && rm -rf "$1"; [ ! -e "$1" ]' sh "$R" > /dev/null 2>&1 ||
      cfail "$R on $machine is still there"
  fi
  if [ "$hook_saved" = 1 ]; then
    cp -p "$L/bw-event.saved" "$hook_script" || cfail "could not put back $hook_script"
  else
    rm -f "$hook_script"
    [ "$hook_dir_made" = 1 ] && rmdir "${hook_script%/*}" 2> /dev/null
  fi
  # Asking a stopped core anything starts it again, so look at its process and the agents' folders.
  sleep 2
  [ -n "$core_pid" ] && kill -0 "$core_pid" 2> /dev/null && cfail "the $core core (pid $core_pid) still runs"
  left=$(lsof -a -d cwd -Fn 2> /dev/null | grep -c "^n$L/")
  [ "$left" -gt 0 ] && cfail "$left process(es) still run in $L"
  # Claude writes each scratch repository's log under ~/.claude/projects/<its path with - for others>, and a
  # scratchpad under /private/tmp/claude-<uid>/<the same name>.
  for d in "$L"/claude-*; do
    [ -d "$d" ] || continue
    p=$(printf %s "$d" | sed 's/[^A-Za-z0-9]/-/g')
    rm -rf "$HOME/.claude/projects/$p" "/private/tmp/claude-$(id -u)/$p"
    [ -e "$HOME/.claude/projects/$p" ] && cfail "$HOME/.claude/projects/$p is still there"
  done
  scratch_rm "$L" || cfail "$L is still there"
  [ "$(sums)" = "$before" ] || cfail "the user's Claude or Codex settings changed during the run"
  [ "$cleanup_failed" = 0 ] && exit "$status"
  exit 1
}

[ -e "$L" ] && { scratch_rm "$L" || { echo "FAIL setup: $L is left from another run and has no marker"; exit 1; }; }
scratch_make "$L" || { echo "FAIL setup: scratch $L"; exit 1; }
trap 'cleanup $?' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$L/cache" "$L/hooks-home"

if [ -e "$hook_script" ]; then cp -p "$hook_script" "$L/bw-event.saved" && hook_saved=1 || { echo "FAIL setup: save $hook_script"; exit 1; }; fi
[ -d "${hook_script%/*}" ] || hook_dir_made=1
mkdir -p "${hook_script%/*}" && cp "$src/hooks/bw-event" "$hook_script" && chmod 755 "$hook_script" ||
  { echo "FAIL setup: $hook_script"; exit 1; }

core_pid=$(clean HC_SESSION=$core "$hc" server status --json | jq -r .pid) && [ -n "$core_pid" ] ||
  { echo "FAIL setup: private core $core"; exit 1; }
set -- --bw "$bw" --scratch "$L" --core "$core"

if [ -n "$machine" ]; then
  home=$("$hc" exec --on "$machine" -- sh -c 'printf %s "$HOME"' 2>&1) && [ -n "$home" ] ||
    { echo "FAIL setup: hc exec --on $machine cannot read its HOME: $home"; exit 1; }
  R=$home/bw-verify/requests
  "$hc" exec --on "$machine" -- sh -c '[ ! -e "$1" ] || [ -f "$1/.bw-verify" ] && rm -rf "$1" && umask 077 &&
    mkdir -p "$1/saved" && : > "$1/.bw-verify"' sh "$R" > /dev/null 2>&1 ||
    { echo "FAIL setup: $R on $machine (a folder without .bw-verify is never deleted)"; R=; exit 1; }
  remote_before=$("$hc" exec --on "$machine" -- sh -c "$home_files" sh sums "$home" $remote_paths 2>&1)
  out=$("$hc" exec --on "$machine" -- sh -c "$home_files" sh save "$home" "$R/saved" $remote_paths 2>&1) ||
    { echo "FAIL setup: could not save $remote_paths on $machine: $out"; exit 1; }
  H=$home
  set -- "$@" --machine "$machine" --remote-root "$R" --remote-home "$H"
fi

bun "$src/scripts/verify/requests-run.js" "$@"
