#!/bin/sh
# Install bw on this machine, then on another one through hc, and check what runs there.
#   scripts/verify/install.sh [--machine <name>]
# Without --machine only this machine's half runs. Prints PASS/FAIL lines; exits 1 on any FAIL.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
hc=${BW_HC:-hc}
machine=
case "${1:-}" in
  "") ;;
  --machine) machine=${2:?--machine needs a name} ;;
  *) echo "usage: scripts/verify/install.sh [--machine <name>]" >&2; exit 2 ;;
esac

failed=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failed=1; }
field() { printf '%s\n' "$1" | jq -r "$2" 2>/dev/null; }

bw=$("$src/scripts/install-helper.sh") || { fail "scripts/install-helper.sh"; exit 1; }
local_v=$("$bw" version) || { fail "$bw version"; exit 1; }
want_p=$(field "$local_v" .protocol)
want_v=$(field "$local_v" .version)
if [ -x "$HOME/.local/share/bellwether/helper/$want_v/bw" ] &&
   [ "$(readlink "$HOME/.local/share/bellwether/helper/current")" = "$want_v" ]; then
  pass "installed here: $bw is protocol $want_p version $want_v"
else
  fail "installed here: helper/$want_v/bw or the current link is missing"
fi

if [ -z "$machine" ]; then
  echo "PENDING the other machine's half: no --machine given"
  exit "$failed"
fi

s=$("$bw" machine status "$machine" | tail -1)
case $(field "$s" .state) in
  current|missing|outdated) pass "status $machine before install: $(field "$s" .state) ($(field "$s" .uname))" ;;
  *) fail "status $machine before install: $s" ;;
esac

out=$("$bw" machine install "$machine" --force)
end=$(printf '%s\n' "$out" | tail -1)
parts=$(printf '%s\n' "$out" | jq -s '[.[] | select(.step == "copy")] | length' 2>/dev/null)
if [ "$(field "$end" .type)" = installed ] && [ "$(field "$end" .sha256)" = "$(shasum -a 256 "$bw" | cut -c1-64)" ]; then
  pass "install --force on $machine: $(field "$end" .bytes) bytes in $parts part(s), sha256 matches this machine's bw"
else
  fail "install --force on $machine: $end"
fi

remote=$("$hc" exec --on "$machine" -- sh -c '"$HOME"/.local/share/bellwether/helper/current/bw version' 2>&1)
if [ "$(field "$remote" .protocol)" = "$want_p" ] && [ "$(field "$remote" .version)" = "$want_v" ]; then
  pass "bw version on $machine matches here: protocol $want_p version $want_v"
else
  fail "bw version on $machine: $remote"
fi

s=$("$bw" machine status "$machine" | tail -1)
[ "$(field "$s" .state)" = current ] && pass "status $machine after install: current" || fail "status $machine after install: $s"

end=$("$bw" machine install "$machine" | tail -1)
[ "$(field "$end" .already)" = true ] && pass "install on $machine again: already current, nothing copied" || fail "install on $machine again: $end"

exit "$failed"
