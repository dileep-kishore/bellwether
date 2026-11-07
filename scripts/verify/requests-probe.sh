#!/bin/sh
# Phase 3's experiment (plan Task 1, decision 1): runs real Claude and Codex until each approval and
# prompt shows, and prints CASE <case>: <result> for each, PENDING for a case it skipped.
#   scripts/verify/requests-probe.sh [--machine <name>] [--save <dir>] [--only <groups>]
#   a, b, c-esc, c-always, g  record-session claude-child-approval: foreground and background
#        sub-agents' Bash approvals, root approvals answered with esc and 2, meta.json while a
#        child runs
#   d-y, d-p, d-esc, e  record-session codex-child-approval: root approvals answered with y, p and
#        esc, then a spawn_agent child's approval answered with y
#   f    an untrusted Codex hooks.json: what Codex shows, whether a hook runs, what /hooks then t
#        writes to config.toml, and whether each trusted_hash is the one computed from hooks.json
#   h    HC_TERMINAL_ID and HC_SESSION in a hook against the terminal's address, its core and what
#        hc exec sees, and the variables of a terminal in the default core
#   j-1, j-2, j-enter, j-esc  Codex's /new folder prompt, reached by bw send --text /new after one
#        turn and answered with that key, each in a fresh Codex
#   i    with --machine: case d's y on that machine, its hooks trusted by computed hashes
# Agents run in a private hc core (HC_SESSION=bw-probe) started from this shell, in scratch git
# repositories under /private/tmp/claude-501/bw-probe; Codex with a scratch CODEX_HOME holding a
# copy of ~/.codex/auth.json and a bare HOME. Recorder hooks are named only in those scratch
# folders. --save <dir> (a new folder under /private/tmp) keeps the scrubbed screens, statuses,
# payloads and notes. Spends tokens: Claude haiku, Codex gpt-6-luna at low effort. On exit it stops
# the private core, kills its terminals on <name>, deletes the scratch folders (auth.json copies
# included) and the Claude project folders its runs wrote, and fails if ~/.claude/settings.json,
# ~/.codex/hooks.json or ~/.codex/config.toml changed. --only runs a comma-separated subset of the
# groups claude (a b c g), codex (d e), f (f h), j and i.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"
machine= save= only=claude,codex,f,j,i
while [ $# -gt 0 ]; do
  case $1 in
    --machine) machine=${2:?--machine needs a name}; shift 2 ;;
    --save) save=${2:?--save needs a folder}; shift 2 ;;
    --only) only=${2:?--only needs groups}; shift 2 ;;
    *) sed -n 4p "$0" >&2; exit 2 ;;
  esac
done
if [ -n "$save" ]; then
  save=$(scratch_path "$save") || exit 2
  [ ! -e "$save" ] || { echo "$save exists" >&2; exit 2; }
fi

L=/private/tmp/claude-501/bw-probe
core=bw-probe
out=$L/out
R=
remote_terms=
failed=0
real="$HOME/.claude/settings.json $HOME/.codex/hooks.json $HOME/.codex/config.toml"

fail() { echo "FAIL $1: $2"; failed=1; }
# Agents started from inside another Claude session inherit CLAUDE_CODE_CHILD_SESSION, which turns
# transcript saving off; the private core and everything it starts get a bare environment.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG=en_US.UTF-8 TERM=xterm-256color \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
hcp() { HC_SESSION=$core hc "$@"; }
hcu() { env -u HC_SESSION hc "$@"; }
bwp() { HC_SESSION=$core BW_CACHE_DIR=$L/cache "$bw" "$@"; }
sums() { for f in $real; do [ -f "$f" ] && shasum -a 256 "$f"; done; }

# An abort (set -u, a signal) reaches here with its own non-zero status, which must not read as a pass.
cleanup() {
  [ "$1" = 0 ] || failed=1
  # The probe's own evidence goes through the same scrubber as the recordings, before anything is kept.
  if [ -d "$out" ]; then
    BW_REC_ROOT=$L bun "$src/scripts/verify/scrub-fixture" "$out" >/dev/null || { echo "FAIL scrub: residue in $out"; failed=1; }
    [ -z "$save" ] || cp -R "$out" "$save" || echo "FAIL cleanup: could not save to $save"
  fi
  hcp server stop >/dev/null 2>&1
  for t in $remote_terms; do hcu kill "$t" >/dev/null 2>&1; done
  if [ -n "$R" ]; then
    hcu exec --on "$machine" -- sh -c '[ -f "$1/.bw-verify" ] && rm -rf "$1"; [ ! -e "$1" ]' sh "$R" >/dev/null 2>&1 ||
      echo "FAIL cleanup: $R on $machine is still there"
  fi
  # Asking a stopped core anything starts it again, so look at the processes still in the folder.
  sleep 2
  left=$(lsof -a -d cwd -Fn 2>/dev/null | grep -c "^n$L/")
  [ "$left" -gt 0 ] && echo "FAIL cleanup: $left process(es) still run in $L"
  for d in "$L"/* "$L"/rec/*; do
    [ -d "$d" ] || continue
    p=$(printf %s "$d" | sed 's/[^A-Za-z0-9]/-/g')
    rm -rf "$HOME/.claude/projects/$p" "/private/tmp/claude-$(id -u)/$p"
  done
  scratch_rm "$L" || echo "FAIL cleanup: $L is still there"
  if [ "$(sums)" != "$before" ]; then echo "FAIL cleanup: the user's Claude or Codex settings changed during the run"; exit 1; fi
  exit "$failed"
}

before=$(sums)
[ -e "$L" ] && { scratch_rm "$L" || { echo "FAIL setup: $L is left from another run and has no marker"; exit 1; }; }
scratch_make "$L" || { echo "FAIL setup: scratch $L"; exit 1; }
trap 'cleanup $?' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$out" "$L/cache"
cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
bw=$src/target/release/bw

# wait_screen <term> <regex> [tries]: polls the screen every 2 s, through the core $rd names.
rd=hcp
wait_screen() {
  n=${3:-30}
  while [ "$n" -gt 0 ]; do
    $rd read "$1" --lines 80 2>/dev/null | grep -Eq "$2" && return 0
    sleep 2
    n=$((n - 1))
  done
  return 1
}

# make_repo <dir>: a scratch git repository with one commit.
make_repo() {
  mkdir -p "$1" && git -C "$1" init -q && printf 'alpha\n' >"$1/a.txt" && git -C "$1" add a.txt &&
    git -C "$1" -c user.name='Test User' -c user.email=user@example.com commit -qm init
}

# recorder <file> <payload dir>: a hook that saves its stdin and HC_* variables and prints nothing.
recorder() {
  cat >"$1" <<'HOOK'
#!/bin/sh
ms=$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000')
cat >"$1/$ms-$$-$2.json"
env | grep '^HC_' | sort >"$1/$ms-$$-$2.env"
exit 0
HOOK
}
# hooks_json <hook> <payload dir>: a Codex hooks.json naming the recorder for three events.
hooks_json() {
  jq -n --arg h "sh $1 $2" '
    def run($e): [{type: "command", command: "\($h) \($e)", timeout: 5}];
    {hooks: {PermissionRequest: [{matcher: "*", hooks: run("PermissionRequest")}],
             SubagentStart: [{hooks: run("SubagentStart")}],
             SubagentStop: [{hooks: run("SubagentStop")}]}}'
}
# trust_lines <hooks.json> <its absolute path>: the [hooks.state] entries Codex 0.167 writes when the
# user trusts each hook. trusted_hash is sha256 over Codex's normalized hook identity as JSON with
# sorted keys (codex-rs hooks/src/engine/discovery.rs hook_hash, config/src/fingerprint.rs).
trust_lines() {
  jq -r '.hooks | to_entries[] | .key as $e
    | ($e | gsub("(?<a>[a-z])(?<b>[A-Z])"; "\(.a)_\(.b)") | ascii_downcase) as $ev
    | .value | to_entries[] | .key as $g | .value as $grp | $grp.hooks | to_entries[]
    | ({event_name: $ev, hooks: [.value + {async: (.value.async // false), timeout: (.value.timeout // 600)}]}
       + (if $grp.matcher then {matcher: $grp.matcher} else {} end)) as $id
    | "\($ev):\($g):\(.key)\t\($id | tojson)"' "$1" |
    while IFS='	' read -r key id; do
      h=$(printf '%s' "$id" | jq -cS . | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)
      printf '[hooks.state."%s:%s"]\ntrusted_hash = "sha256:%s"\n\n' "$2" "$key" "$h"
    done
}
# codex_home <dir> <repo>...: a scratch CODEX_HOME with auth.json that trusts each repository.
codex_home() {
  h=$1
  shift
  mkdir -m 700 "$h" && cp "$HOME/.codex/auth.json" "$h/auth.json" || return 1
  for r in "$@"; do printf '[projects."%s"]\ntrust_level = "trusted"\n\n' "$r"; done >"$h/config.toml"
}
# start_codex <name> <repo> <home> <flags>...: prints the new terminal's address.
start_codex() {
  name=$1 repo=$2 home=$3
  shift 3
  mkdir -p "$L/bare-home"
  hcp run --json --bg --no-parent --no-notify --name "$name" --cwd "$repo" -- /usr/bin/env CODEX_HOME="$home" \
    HOME="$L/bare-home" codex -m gpt-6-luna -c 'model_reasoning_effort="low"' "$@" | jq -r '.address // empty'
}
# type_in <term> <text>: hc refuses to type into a terminal whose output has not settled; retry for 30 s.
type_in() {
  n=15
  until hcp send --json -- "$1" "$2" >/dev/null 2>&1; do
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 2
  done
}
ESC_ASK='Run exactly this shell command with escalated sandbox permissions (ask me for approval first) and nothing else'
BOX='Would you like to run the following command'

# Cases a to e and g: record-session prints their CASE lines.
rec() {
  BW_REC_ROOT=$L/rec BW_REC_CORE=$core sh "$src/scripts/verify/record-session" "$1" --out "$out/$1" 2>"$L/$1.err" |
    grep '^CASE' || true
  [ -f "$out/$1/expect.json" ] || fail "$1" "record-session stopped: $(tail -3 "$L/$1.err" | tr '\n' ' ')"
}
mkdir -p "$L/rec"
# has <group>: whether --only names it.
has() { case ,$only, in *,$1,*) return 0 ;; esac; return 1; }
if has claude; then rec claude-child-approval; else echo "PENDING a, b, c, g: not in --only"; fi
if has codex; then rec codex-child-approval; else echo "PENDING d, e: not in --only"; fi

clean HC_SESSION=$core hc server status >/dev/null || { echo "FAIL setup: private core $core"; exit 1; }
export HC_SESSION=$core

case_f() {
  d=$L/f home=$L/f-home pay=$L/f-hooks
  make_repo "$d" && codex_home "$home" "$d" && mkdir -p "$pay" || { fail f "setup"; return; }
  recorder "$L/hook.sh"
  # Group 1 of each event is the group bw hooks apply writes, so Codex's own trusted_hash for it is a
  # known answer; its script, in the bare HOME Codex runs with, only drains stdin.
  mkdir -p "$L/bare-home/.local/share/bellwether/hooks"
  printf '#!/bin/sh\ncat >/dev/null\nexit 0\n' >"$L/bare-home/.local/share/bellwether/hooks/bw-event"
  hooks_json "$L/hook.sh" "$pay" | jq --arg c ': bellwether-hook=1; sh "$HOME/.local/share/bellwether/hooks/bw-event" codex' \
    '.hooks |= with_entries(.value += [{hooks: [{type: "command", command: $c, timeout: 5}]}])' >"$home/hooks.json"
  cp "$home/config.toml" "$out/f-config-before.toml"
  t=$(start_codex bw-probe-f "$d" "$home" -a on-request -s read-only)
  [ -n "$t" ] || { fail f "codex did not start"; return; }
  if ! wait_screen "$t" 'Hooks need review' 15; then fail f-untrusted "no 'Hooks need review' screen"; hcp kill "$t" >/dev/null; return; fi
  hcp read "$t" >"$out/screen-f-review.txt"
  hcp get --json "$t" | jq -c .status >"$out/status-f-review.json"
  # 3. Continue without trusting (hooks won't run)
  hcp keys --json -- "$t" 3 >/dev/null
  wait_screen "$t" 'Ask Codex' 10 || { fail f-untrusted "composer did not come back after 3"; hcp kill "$t" >/dev/null; return; }
  type_in "$t" "$ESC_ASK: touch f-untrusted.txt"
  if wait_screen "$t" "$BOX" 30; then
    ran=$(ls "$pay" | grep -c json)
    hcp keys --json -- "$t" y >/dev/null
    wait_screen "$t" 'Ask Codex' 30
    hcp wait "$t" --timeout 60 >/dev/null 2>&1
    [ "$ran" = 0 ] && echo "CASE f-untrusted: Codex starts at 'Hooks need review' ($(grep -c '^ *[›]* *[0-9]\.' "$out/screen-f-review.txt") options); after 3 an approval showed with no hook run (0 payloads)" ||
      fail f-untrusted "$ran payloads while the hooks were untrusted"
  else
    fail f-untrusted "no approval box"
  fi
  type_in "$t" /hooks
  wait_screen "$t" 'Lifecycle hooks' 10 || { fail f-trust "/hooks showed nothing"; hcp kill "$t" >/dev/null; return; }
  hcp read "$t" >"$out/screen-f-hooks.txt"
  hcp keys --json -- "$t" t >/dev/null
  sleep 2
  hcp read "$t" >"$out/screen-f-hooks-trusted.txt"
  hcp keys --json -- "$t" esc >/dev/null
  diff "$out/f-config-before.toml" "$home/config.toml" | sed -n 's/^> //p' >"$out/f-config-added.toml"
  trust_lines "$home/hooks.json" "$home/hooks.json" >"$out/f-config-computed.toml"
  wrote=$(grep -c trusted_hash "$out/f-config-added.toml")
  bad=0
  for k in $(grep -o '^\[hooks.state\.[^]]*' "$out/f-config-computed.toml" | sed 's/^\[//'); do
    a=$(grep -A1 -F "[$k]" "$out/f-config-added.toml" | grep trusted_hash)
    b=$(grep -A1 -F "[$k]" "$out/f-config-computed.toml" | grep trusted_hash)
    [ -n "$a" ] && [ "$a" = "$b" ] || bad=$((bad + 1))
  done
  want=$(grep -c trusted_hash "$out/f-config-computed.toml")
  # The groups bw hooks apply writes, with the hash Codex gave each: Task 6's known answer.
  jq -c --rawfile added "$out/f-config-added.toml" '.hooks | to_entries[] | .key as $e | .value[1] |
    {event: $e, matcher, command: .hooks[0].command, timeout: .hooks[0].timeout,
     trusted_hash: ($added | capture(":\($e | gsub("(?<a>[a-z])(?<b>[A-Z])"; "\(.a)_\(.b)") | ascii_downcase):1:0\"\\]\ntrusted_hash = \"(?<h>[^\"]+)\"").h)}' \
    "$home/hooks.json" >"$out/f-bellwether-trust.jsonl"
  [ "$bad" = 0 ] && [ "$wrote" = "$want" ] && echo "CASE f-trust: /hooks then t wrote $wrote [hooks.state.\"<hooks.json>:<event>:<group>:<hook>\"] trusted_hash entries, each equal to the computed hash" ||
    fail f-trust "config.toml gained $wrote trusted_hash lines; $bad differ from the computed ones"
  type_in "$t" "$ESC_ASK: touch f-trusted.txt"
  if wait_screen "$t" "$BOX" 30; then
    sleep 1
    pr=$(ls "$pay" | grep -c 'PermissionRequest.json')
    hcp keys --json -- "$t" y >/dev/null
    wait_screen "$t" 'Ask Codex' 30
    hcp wait "$t" --timeout 60 >/dev/null 2>&1
    [ "$pr" -ge 1 ] && echo "CASE f-trusted: the next approval ran the PermissionRequest hook in the same Codex, no restart" ||
      fail f-trusted "no PermissionRequest payload after trusting"
  else
    fail f-trusted "no approval box"
  fi
  # Case h from this terminal's hook.
  env_file=$(ls "$pay"/*PermissionRequest.env 2>/dev/null | head -1)
  cp "$env_file" "$out/h-hook-private.env" 2>/dev/null
  cp "$pay"/*PermissionRequest.json "$out/" 2>/dev/null
  hc exec -- sh -c 'env | grep ^HC_ | sort' >"$out/h-exec-private.env"
  hcu run --json --no-parent --no-notify --rm --cwd "$L" -- sh -c "env | grep '^HC_' | sort > $out/h-default-terminal.env" >/dev/null
  hcu exec -- sh -c 'env | grep ^HC_ | sort' >"$out/h-exec-default.env"
  tid=$(sed -n 's/^HC_TERMINAL_ID=//p' "$out/h-hook-private.env")
  hs=$(sed -n 's/^HC_SESSION=//p' "$out/h-hook-private.env")
  es=$(sed -n 's/^HC_SESSION=//p' "$out/h-exec-private.env")
  ds=$(sed -n 's/^HC_SESSION=//p' "$out/h-default-terminal.env")
  dt=$(sed -n 's/^HC_TERMINAL_ID=//p' "$out/h-default-terminal.env")
  [ "$tid" = "$t" ] && [ "$hs" = "$core" ] && [ "$es" = "$core" ] &&
    echo "CASE h: hook HC_TERMINAL_ID=$tid (the terminal's address) HC_SESSION=$hs, as hc exec sees it ($es); a default-core terminal has HC_TERMINAL_ID=$dt and ${ds:+HC_SESSION=$ds}${ds:-no HC_SESSION}, as hc exec there" ||
    fail h "hook HC_TERMINAL_ID=$tid HC_SESSION=$hs; terminal $t, core $core, hc exec HC_SESSION=$es"
  hcp kill "$t" >/dev/null
}

# settle <term>: sets $l to bw locate --fresh once it no longer says ambiguous (at most 120 s) and
# $settled to the seconds that took.
settle() {
  settled=0
  while [ "$settled" -lt 120 ]; do
    l=$(bwp locate --terminal "$1" --fresh)
    printf %s "$l" | grep -q '"ambiguous"' || return 0
    sleep 5
    settled=$((settled + 5))
  done
}

# case_j <tag> <key>: one turn, bw send /new, then <key> on the folder prompt.
case_j() {
  tag=$1 key=$2 d=$L/j-$tag
  make_repo "$d" && printf '[projects."%s"]\ntrust_level = "trusted"\n\n' "$d" >>"$jhome/config.toml" || { fail "j-$tag" setup; return; }
  # Codex's own approval and sandbox defaults: started with -s workspace-write, the conversation option 2
  # makes fails its first turn ("Failed to start turn: the selected permission profile cannot be
  # safely represented by the legacy app-server sandbox policy").
  t=$(start_codex "bw-probe-j-$tag" "$d" "$jhome")
  [ -n "$t" ] && wait_screen "$t" 'Ask Codex' 20 || { fail "j-$tag" "codex did not start"; return; }
  type_in "$t" 'Reply with the word MANGO only.'
  hcp wait "$t" --timeout 90 >/dev/null 2>&1
  settle "$t"
  old=$l
  os=$(printf %s "$old" | jq -r '.session // empty')
  op=$(printf %s "$old" | jq -r '.path // empty')
  [ -n "$op" ] || { fail "j-$tag" "bw locate after the first turn: $old"; hcp kill "$t" >/dev/null; return; }
  r=$(bwp send --terminal "$t" --expect-kind codex --expect-session "$os" --expect-path "$op" --text /new)
  printf %s "$r" | grep -q '"sent"' || { fail "j-$tag" "bw send /new: $r"; hcp kill "$t" >/dev/null; return; }
  wait_screen "$t" 'Where should the new conversation run' 8 || { fail "j-$tag" "no folder prompt after /new"; hcp kill "$t" >/dev/null; return; }
  sleep 1
  hcp read "$t" >"$out/screen-j-$tag.txt"
  st=$(hcp get --json "$t" | jq -c .status)
  printf '%s\n' "$st" >"$out/status-j-$tag.json"
  during=$(bwp locate --terminal "$t" --fresh)
  printf '%s\n' "$during" >"$out/locate-j-$tag-during.json"
  hcp keys --json -- "$t" "$key" >/dev/null
  sleep 3
  hcp read "$t" >"$out/screen-j-$tag-after.txt"
  gone=yes
  grep -q 'Where should the new conversation run' "$out/screen-j-$tag-after.txt" && gone=no
  settle "$t"
  after=$l
  printf '%s\n' "$after" >"$out/locate-j-$tag-after.json"
  dl=$(printf %s "$during" | jq -r '.type + ":" + (.state // .session)' | sed "s/$os/old/")
  if [ "$key" = esc ]; then
    [ "$gone" = yes ] && printf %s "$after" | grep -q "\"$os\"" &&
      echo "CASE j-esc: hc $(printf %s "$st" | jq -r .state) while shown; bw locate during: $dl; esc closed the prompt and kept the old conversation" ||
      fail j-esc "prompt gone: $gone; bw locate after esc: $after"
    hcp kill "$t" >/dev/null
    return
  fi
  ns=$(printf %s "$after" | jq -r 'select(.state == "no_log") | .session // empty')
  [ -n "$ns" ] && [ "$ns" != "$os" ] || { fail "j-$tag" "prompt gone: $gone; bw locate ${settled}s after the key: $after"; hcp kill "$t" >/dev/null; return; }
  r=$(bwp send --terminal "$t" --expect-kind codex --expect-session "$ns" --expect-path none --text 'Reply with the word KIWI only.')
  printf %s "$r" | grep -q '"sent"' || { fail "j-$tag" "bw send to the new session: $r"; hcp kill "$t" >/dev/null; return; }
  hcp wait "$t" --timeout 90 >/dev/null 2>&1
  n=0 np=
  while [ -z "$np" ] && [ "$n" -lt 24 ]; do
    nl=$(bwp locate --terminal "$t" --fresh)
    np=$(printf %s "$nl" | jq -r '.path // empty')
    [ -n "$np" ] || sleep 5
    n=$((n + 1))
  done
  printf '%s\n' "$nl" >"$out/locate-j-$tag-first.json"
  hcp read "$t" >"$out/screen-j-$tag-first.txt"
  [ -n "$np" ] || { fail "j-$tag" "no log after the new conversation's first message: $(grep -m1 'Failed to start turn' "$out/screen-j-$tag-first.txt")"; hcp kill "$t" >/dev/null; return; }
  cwd=
  [ -n "$np" ] && cwd=$(head -1 "$np" | jq -r .payload.cwd)
  where=other
  [ "$cwd" = "$d" ] && where="the same folder"
  case $cwd in "$jhome"/worktrees/*/j-$tag) where="a new worktree \$CODEX_HOME/worktrees/<id>/j-$tag" ;; esac
  echo "CASE j-$tag: hc $(printf %s "$st" | jq -r .state) while shown; bw locate during: $dl; after $key: ambiguous for ${settled}s, then no_log naming the new session; its first message ran in $where"
  printf '%s\n' "$cwd" >"$out/j-$tag-cwd.txt"
  hcp kill "$t" >/dev/null
}

case_i() {
  M=$machine
  rhome=$(hcu exec --on "$M" -- sh -c 'printf %s "$HOME"' 2>&1) && [ -n "$rhome" ] || { fail i "hc exec --on $M: $rhome"; return; }
  rpath=$(hcu exec --on "$M" -- sh -c 'printf %s "$PATH"')
  R=$rhome/bw-verify/probe
  hcu exec --on "$M" -- sh -c '[ ! -e "$1" ] || [ -f "$1/.bw-verify" ] && rm -rf "$1" && umask 077 && mkdir -p "$1/home" "$1/hooks" "$1/codex-home" &&
    : > "$1/.bw-verify" && cd "$1" && mkdir i && cd i && git init -q && printf "alpha\n" > a.txt && git add a.txt &&
    git -c user.name="Test User" -c user.email=user@example.com commit -qm init' sh "$R" >/dev/null 2>&1 ||
    { fail i "$R on $M (a folder without .bw-verify is never deleted)"; R=; return; }
  recorder "$L/hook-i.sh"
  hooks_json "$R/hook.sh" "$R/hooks" >"$L/i-hooks.json"
  { printf '[projects."%s"]\ntrust_level = "trusted"\n\n' "$R/i"; trust_lines "$L/i-hooks.json" "$R/codex-home/hooks.json"; } >"$L/i-config.toml"
  for f in hook.sh:hook-i.sh codex-home/hooks.json:i-hooks.json codex-home/config.toml:i-config.toml; do
    hcu file write --json --on "$M" "$R/${f%%:*}" <"$L/${f#*:}" >/dev/null || { fail i "hc file write $f"; return; }
  done
  hcu file write --json --on "$M" "$R/codex-home/auth.json" <"$HOME/.codex/auth.json" >/dev/null || { fail i "auth.json"; return; }
  hcu exec --on "$M" -- chmod 600 "$R/codex-home/auth.json"
  a=$(hcu run --json --bg --on "$M" --no-parent --no-notify --name bw-probe-i --cwd "$R/i" -- /usr/bin/env CODEX_HOME="$R/codex-home" \
    HOME="$R/home" PATH="$rpath" codex -m gpt-6-luna -c 'model_reasoning_effort="low"' -a on-request -s read-only | jq -r '.address // empty')
  [ -n "$a" ] || { fail i "hc run --on $M"; return; }
  remote_terms="$remote_terms $a"
  local=${a#"$M"/}
  rd=hcu
  wait_screen "$a" 'Hooks need review|Ask Codex' 20
  if hcu read "$a" | grep -q 'Hooks need review'; then fail i "Codex on $M did not accept the computed trusted_hash values"; return; fi
  # hc send from this core would type an <hc from> wrapper there; that machine's own core types it as is.
  hcu exec --on "$M" -- hc send --json -- "$local" "$ESC_ASK: touch remote.txt" >/dev/null
  wait_screen "$a" "$BOX" 30 || { fail i "no approval box on $M"; return; }
  sleep 1
  hcu read "$a" >"$out/screen-i.txt"
  hcu get --json "$a" | jq -c .status >"$out/status-i.json"
  hcu exec --on "$M" -- test -e "$R/i/remote.txt" && { fail i "remote.txt exists before y"; return; }
  hcu keys --json -- "$a" y >/dev/null
  n=10
  until hcu exec --on "$M" -- test -e "$R/i/remote.txt" || [ "$n" = 0 ]; do sleep 2; n=$((n - 1)); done
  hcu exec --on "$M" -- sh -c 'cat "$1"/hooks/*PermissionRequest.json' sh "$R" >"$out/i-PermissionRequest.json" 2>/dev/null
  hcu exec --on "$M" -- sh -c 'cat "$1"/hooks/*PermissionRequest.env' sh "$R" >"$out/h-hook-$M.env" 2>/dev/null
  hcu exec --on "$M" -- sh -c 'env | grep ^HC_ | sort' >"$out/h-exec-$M.env"
  tid=$(sed -n 's/^HC_TERMINAL_ID=//p' "$out/h-hook-$M.env")
  if hcu exec --on "$M" -- test -e "$R/i/remote.txt"; then
    echo "CASE i: on $M the box showed in that machine's terminal (hc $(jq -r '.state + "/" + (.kind // "")' "$out/status-i.json")); y created remote.txt; its hook ran with no review (computed hashes) and saw HC_TERMINAL_ID=$tid, $M's own address ($local)"
  else
    fail i "remote.txt missing after y on $M"
  fi
  hcu kill "$a" >/dev/null 2>&1
}

if has f; then case_f; else echo "PENDING f, h: not in --only"; fi
if has j; then
  jhome=$L/j-home
  codex_home "$jhome" || fail j "scratch CODEX_HOME"
  case_j 1 1
  case_j 2 2
  case_j enter enter
  case_j esc esc
else
  echo "PENDING j: not in --only"
fi
if [ -z "$machine" ]; then echo "PENDING i: no --machine given"; elif has i; then case_i; else echo "PENDING i: not in --only"; fi
