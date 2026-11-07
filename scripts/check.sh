#!/bin/sh
# Every check this repo has: shared copies match their source, and herdr-app check passes on each mod.
set -u
src=$(cd "$(dirname "$0")/.." && pwd)
cd "$src"
fail=0

for s in shared/*.js; do
  [ -f "$s" ] || continue
  for c in $(find mods -name "$(basename "$s")"); do
    cmp -s "$s" "$c" || { echo "FAIL $c differs from $s: edit $s, then run scripts/sync.sh"; fail=1; }
  done
done

checked=0
for d in mods/bw-*/; do
  [ -d "$d" ] || continue
  checked=$((checked + 1))
  out=$(herdr-app check "$d" 2>&1) || { echo "FAIL herdr-app check $d"; echo "$out" | tail -20; fail=1; }
done

if [ -f layouts/bellwether.json ]; then
  jq empty layouts/bellwether.json 2>/dev/null || { echo "FAIL layouts/bellwether.json is not valid JSON"; fail=1; }
fi

[ "$fail" = 0 ] && echo "all checks passed ($checked mods)"
exit "$fail"
