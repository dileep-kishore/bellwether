#!/bin/sh
# Copy this repo's layout and bw-* mods into a Herdr app home.
# Real copies, not symlinks: Herdr does not load a mod's own SVGs through a symlink.
#   scripts/sync.sh [--dry-run] [--shared-only]
# --shared-only copies shared/ into the repository's mod folders and stops, so it needs no app home.
set -eu
src=$(cd "$(dirname "$0")/.." && pwd)
app=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
dry=""
shared_only=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry="--dry-run" ;;
    --shared-only) shared_only=1 ;;
    *) echo "usage: scripts/sync.sh [--dry-run] [--shared-only]" >&2; exit 2 ;;
  esac
done

# shared/<file>.js goes into every mod whose .shared file lists <file>, one name per line.
for list in "$src"/mods/bw-*/.shared; do
  [ -f "$list" ] || continue
  mod=$(dirname "$list")
  while IFS= read -r name || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    [ -f "$src/shared/$name.js" ] || { echo "$list names shared/$name.js, which does not exist" >&2; exit 1; }
    if [ -n "$dry" ]; then echo "would copy shared/$name.js into $(basename "$mod")"
    else cp "$src/shared/$name.js" "$mod/"; fi
  done < "$list"
done
[ "$shared_only" = 1 ] && exit 0

[ -d "$app/mods" ] || { echo "no Herdr app home at $app: open the Herdr app once first" >&2; exit 1; }

# Herdr writes jsconfig.json and the .d.ts files into mod folders; leave them out.
gen="--exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json --exclude .shared"
found=0
for d in "$src"/mods/bw-*/; do
  [ -d "$d" ] || continue
  found=1
  rsync -a --delete --itemize-changes $dry $gen "$d" "$app/mods/$(basename "$d")/"
done
[ "$found" = 1 ] || echo "no mods/bw-* yet"

for f in "$src"/layouts/bellwether.*; do
  [ -f "$f" ] || { echo "no layouts/bellwether.json yet"; break; }
  rsync -a --itemize-changes $dry "$f" "$app/layouts/"
done
