#!/bin/sh
# A test window apart from your own Herdr: its own core (HC_SESSION=bw-stage) and app home, with your
# real HOME so the real claude and codex keep their logins. Adapted from herdr-t3's scripts/demo/stage.sh
# (Apache-2.0; see THIRD_PARTY_NOTICES.md for the source commit and what changed).
#   stage.sh up      build it in $BW_STAGE (default /private/tmp/bw-stage), sync the layout and mods, open its window
#   stage.sh do …    run anything inside it: `stage.sh do hc ls --json`, `stage.sh do herdr-app shot x.png`
#   stage.sh down    close it, end its terminals and core, and delete $BW_STAGE (only a folder up made)
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
. "$src/scripts/verify/lib-scratch.sh"
D=$(scratch_path "${BW_STAGE:-/private/tmp/bw-stage}") || { echo "BW_STAGE must be a folder inside /private/tmp (down deletes it)" >&2; exit 1; }
A=$D/app
APP=/Applications/Herdr.app/Contents/MacOS/Herdr

# Only the stage's variables: a calling agent's shell exports its own core, app home and session markers
# (CLAUDE_CODE_CHILD_SESSION turns off Claude's transcripts), which would leak into every terminal.
stage() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" SHELL="${SHELL:-/bin/zsh}" TERM=xterm-256color \
    LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" ${SSH_AUTH_SOCK:+SSH_AUTH_SOCK="$SSH_AUTH_SOCK"} \
    PATH="$D/bin:$PATH" HC_SESSION=bw-stage HERDR_APP_HOME="$A" HERDR_TELEMETRY=0 DO_NOT_TRACK=1 "$@"
}
core_id() { "$@" hc server status --json | jq -r .core.id; }
mine() { [ "$(core_id stage)" != "$(core_id env -u HC_SESSION)" ]; }

up() {
  [ -e "$D" ] && { echo "$D exists: stage.sh down first" >&2; exit 1; }
  scratch_make "$D" || exit 1
  mkdir -p "$D/bin" "$A/mods" "$A/layouts"
  # The repo's bw, when built, ahead of any installed helper.
  for b in "$src/target/release/bw" "$src/target/debug/bw"; do [ -x "$b" ] && { ln -s "$b" "$D/bin/bw"; break; }; done
  # Starting its core from this shell keeps it in this login session; a core in the Background
  # session cannot read the keychain, so claude there is logged out.
  stage hc server status --json > /dev/null
  mine || { echo "the stage core is your own: stopping" >&2; exit 1; }
  echo "core: $(core_id stage) (yours: $(core_id env -u HC_SESSION))"
  stage sh "$src/scripts/sync.sh" > /dev/null
  echo '{ "frame.welcomed": "finished", "layout": "bellwether" }' > "$A/shared.json"
  if command -v herdr-app > /dev/null 2>&1 && [ -x "$APP" ]; then
    app
  else
    echo "window deferred: no herdr-app here"
  fi
  echo "up: $D"
}

app() {
  v=$(defaults read /Applications/Herdr.app/Contents/Info CFBundleShortVersionString)
  jq -n --arg v "$v" '{last_run: $v, presented: [$v]}' > "$A/update-notes.json"
  # A session of its own, so the window outlives the shell that started it.
  ( cd "$HOME"; stage python3 -I -c 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' "$APP" > "$D/app.log" 2>&1 < /dev/null & )
  for _ in 1 2 3 4 5 6 7 8 9 10; do stage herdr-app status > /dev/null 2>&1 && break; sleep 1; done
  # Its own window only: another Herdr window has another app home.
  for p in $(pgrep -f 'MacOS/Herdr$'); do ps eww -o command= -p "$p" | grep -q "HERDR_APP_HOME=$A " && echo "$p" > "$D/app.pid"; done
  stage herdr-app do layout.switch '{"name":"bellwether"}' > /dev/null
}

down() {
  [ -d "$D" ] || { echo "nothing at $D"; return; }
  # Before app.pid is read: a folder up did not make holds no pid of ours.
  scratch_owned "$D" || exit 1
  [ -f "$D/app.pid" ] && kill "$(cat "$D/app.pid")" 2> /dev/null || true
  if mine; then
    for t in $(stage hc ls --all --json | jq -r '.terminals[]?.address'); do
      stage hc kill "$t" > /dev/null 2>&1 || true; stage hc rm "$t" > /dev/null 2>&1 || true
    done
    stage hc server stop > /dev/null 2>&1 || true
  fi
  sleep 1; scratch_rm "$D" || exit 1; echo "down: $D removed"
}

case ${1-} in
  up) up ;;
  down) down ;;
  do) shift; stage "$@" ;;
  *) sed -n 5,7p "$0" >&2; exit 1 ;;
esac
