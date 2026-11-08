#!/bin/sh
# Done check C: the Changes panel equals Git, here and on another machine.
#   scripts/verify/git.sh [--offline | --machine <name>]
# Builds make-diff-repos.sh's repositories in /private/tmp/bw-verify-diff on this Mac (default and --offline,
# which are the same: neither needs another machine) or on <name> through hc exec, then runs git-run.js. Here it
# uses this checkout's bw ($BW_BIN, else target/debug/bw); on <name>, the installed helper, which this
# checkout's release bw installs when it is missing or older.
# Prints PASS <check> or FAIL <check>: <why>; exits 1 on any FAIL. Deletes only a root holding .bw-verify.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
hc=${BW_HC:-hc}
root=/private/tmp/bw-verify-diff
machine=
case "${1:-}" in
  "" | --offline) ;;
  --machine) machine=${2:?--machine needs a name} ;;
  *) sed -n 3p "$0" >&2; exit 2 ;;
esac

on() { if [ -n "$machine" ]; then "$hc" exec --on "$machine" -- "$@"; else "$@"; fi; }
cleanup() {
  on sh -c '[ -f "$1/.bw-verify" ] && rm -rf "$1"; [ ! -e "$1" ]' sh "$root" ||
    echo "FAIL cleanup: $root on ${machine:-this Mac} is still there"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

on sh -c "$(cat "$src/scripts/verify/make-diff-repos.sh")" sh "$root" > /dev/null ||
  { echo "FAIL setup: make-diff-repos.sh $root on ${machine:-this Mac}"; exit 1; }

if [ -n "$machine" ]; then
  cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
  bun "$src/scripts/verify/git-run.js" --root "$root" --machine "$machine" --install-bw "$src/target/release/bw"
else
  bw=${BW_BIN:-$src/target/debug/bw}
  [ -x "$bw" ] || cargo build --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
  bun "$src/scripts/verify/git-run.js" --root "$root" --bw "$bw"
fi
