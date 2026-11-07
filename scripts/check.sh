#!/bin/sh
# Every check this repo has: shared copies exist and match their source, and herdr-app check passes on each mod.
# Without herdr-app on PATH the headless harness renders each mod instead; the real check stays owed.
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

for list in mods/bw-*/.shared; do
  [ -f "$list" ] || continue
  mod=$(dirname "$list")
  while IFS= read -r name || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    [ -f "shared/$name.js" ] || { echo "FAIL $list names shared/$name.js, which does not exist"; fail=1; continue; }
    [ -f "$mod/$name.js" ] || { echo "FAIL $mod/$name.js missing: run scripts/sync.sh --shared-only"; fail=1; }
  done < "$list"
done

mods=0
for d in mods/bw-*/; do
  [ -d "$d" ] && mods=$((mods + 1))
done
checked=0
standin=0
if command -v herdr-app >/dev/null 2>&1; then
  for d in mods/bw-*/; do
    [ -d "$d" ] || continue
    checked=$((checked + 1))
    out=$(herdr-app check "$d" 2>&1) || { echo "FAIL herdr-app check $d"; echo "$out" | tail -20; fail=1; }
  done
else
  standin=$mods
  if out=$(bun test tests/harness tests/mods 2>&1); then
    echo "STAND-IN headless render for $mods mods (herdr-app check owed)"
  else
    echo "FAIL headless render (bun test tests/harness tests/mods)"
    echo "$out" | tail -30
    fail=1
  fi
fi

if [ -f layouts/bellwether.json ]; then
  jq empty layouts/bellwether.json 2>/dev/null || { echo "FAIL layouts/bellwether.json is not valid JSON"; fail=1; }
fi

[ "$fail" = 0 ] && echo "all checks passed ($checked mods checked by herdr-app, $standin by the stand-in)"
exit "$fail"
