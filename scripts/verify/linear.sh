#!/bin/sh
# Done check D's list half: Issues follow each repository's link, Mine and All change the list, a new origin
# keeps the link, and the Linear key's first 12 characters are on no file.
#   scripts/verify/linear.sh [--fake | --offline]
# Uses this checkout's bw ($BW_BIN, else target/debug/bw) and the key in this Mac's Keychain; with --fake
# (--offline, as scripts/test.sh runs it), or when the Keychain has no key, a loopback fake of Linear and a
# made-up key, and the live run stays owed.
# Prints PASS <check> or FAIL <check>: <why>; exits 1 on any FAIL. Deletes only a root holding .bw-verify.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
root=/private/tmp/bw-verify-linear
fake=
case "${1:-}" in
  "") security find-generic-password -s bellwether.linear >/dev/null 2>&1 ||
        { echo "OWED live: no bellwether.linear key in the Keychain (scripts/linear-key.sh); running --fake"; fake=--fake; } ;;
  --fake | --offline) fake=--fake ;;
  *) sed -n 4p "$0" >&2; exit 2 ;;
esac

cleanup() {
  [ -f "$root/.bw-verify" ] && rm -rf "$root"
  [ ! -e "$root" ] || echo "FAIL cleanup: $root is still there"
}
[ ! -e "$root" ] || [ -f "$root/.bw-verify" ] || { echo "FAIL setup: $root exists and is not a verify root"; exit 1; }
cleanup
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

bw=${BW_BIN:-$src/target/debug/bw}
[ -x "$bw" ] || cargo build --locked -q -p bw --manifest-path "$src/Cargo.toml" || { echo "FAIL setup: cargo build"; exit 1; }
bun "$src/scripts/verify/linear-run.js" --root "$root" --bw "$bw" $fake
