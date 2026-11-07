#!/bin/sh
# Every check that needs no Herdr window; stops at the first failure.
#   scripts/test.sh [--offline]
# Verify scripts always run with --offline, and only those that accept it, so the flag changes nothing yet.
set -eu
src=$(cd "$(dirname "$0")/.." && pwd)
cd "$src"
export PATH=/opt/homebrew/opt/rustup/bin:$PATH

case "${1:-}" in
  ""|--offline) ;;
  *) echo "usage: scripts/test.sh [--offline]" >&2; exit 2 ;;
esac

step() { echo "==> $*"; "$@"; }

step cargo fmt --check
step cargo clippy --workspace --all-targets --locked -- -D warnings
step cargo test --workspace --locked
# Vendored crates have their own workspace: tested here, never formatted or linted.
step cargo test --manifest-path crates/vendor/Cargo.toml --workspace --locked --target-dir target/vendor

# Without node_modules, bunx would fetch whatever npm calls "biome" instead of the pinned one.
[ -x node_modules/.bin/biome ] || { echo "the pinned JavaScript tools are missing: run bun install" >&2; exit 1; }
step bunx biome ci --error-on-warnings .

js_tests=$(find . \( -name node_modules -o -name target -o -name .git -o -path ./docs/drafts \) -prune -o \
  -type f \( -name '*.test.js' -o -name '*.test.ts' -o -name '*_test.js' -o -name '*_test.ts' \
  -o -name '*.spec.js' -o -name '*.spec.ts' -o -name '*_spec.js' -o -name '*_spec.ts' \) -print | head -1)
if [ -n "$js_tests" ]; then
  step bun test
else
  echo "==> bun test skipped: no test files yet"
fi

step scripts/check.sh

for v in scripts/verify/*.sh; do
  [ -f "$v" ] || continue
  grep -q -e '--offline' "$v" || continue
  step sh "$v" --offline
done

echo "all tests passed"
