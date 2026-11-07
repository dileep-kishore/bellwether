#!/bin/sh
# What one `bw feed --log … --pictures` costs on the largest Claude and Codex logs on this Mac:
# a first read, a read with an unchanged cursor, and a read after one appended line.
#   scripts/verify/feed-cost.sh [runs]
# Each case runs [runs] times (default 5) on a scratch copy of the log; prints a Markdown table of
# sizes and user plus system milliseconds, never a path or a log's text. /usr/bin/time -l rounds to
# 10 ms and these reads take less, so the child's getrusage gives microseconds instead.
# The copies and the cache live in a scratch folder deleted on exit.
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"
runs=${1:-5}

cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml"
bw=$src/target/release/bw
S=/private/tmp/claude-501/bw-feed-cost
[ -e "$S" ] && scratch_rm "$S"
scratch_make "$S"
trap 'scratch_rm "$S"' EXIT
trap 'exit 1' HUP INT TERM

# largest <dir> <name pattern>: the biggest matching file, by size.
largest() {
  find "$1" -type f -name "$2" -exec stat -f '%z %N' {} + 2> /dev/null | sort -n | tail -1 | cut -d' ' -f2-
}

# cost <log> <agent> [cursor]: median and largest user+sys ms of $runs reads.
# With cache.saved present, each read starts from that cache, so every run sees the same cursor state.
cost() {
  : > "$S/ms"
  i=0
  while [ "$i" -lt "$runs" ]; do
    if [ -d "$S/cache.saved" ]; then rm -rf "$S/cache"; cp -R "$S/cache.saved" "$S/cache"; fi
    BW_CACHE_DIR=$S/cache python3 -I -c "$rusage" "$S/out" "$bw" feed --log "$1" --agent "$2" --pictures \
      ${3:+--cursor "$3"} >> "$S/ms"
    i=$((i + 1))
  done
  sort -n "$S/ms" | awk '{ a[NR] = $1 } END { printf "%.1f | %.1f", a[int((NR + 1) / 2)], a[NR] }'
}

# argv[1] gets the program's stdout; prints its user plus system time in ms.
rusage='import resource, subprocess, sys
with open(sys.argv[1], "wb") as out:
    subprocess.run(sys.argv[2:], stdout=out, check=True)
r = resource.getrusage(resource.RUSAGE_CHILDREN)
print(round((r.ru_utime + r.ru_stime) * 1000, 1))'

cursor_of() { head -1 "$S/out" | jq -r .cursor; }

echo "| Log | Size | Read | Median ms (user+sys) | Max ms | Output |"
echo "| --- | ---: | --- | ---: | ---: | --- |"
for pair in "claude:$HOME/.claude/projects:*.jsonl" "codex:$HOME/.codex/sessions:rollout-*.jsonl"; do
  agent=${pair%%:*} rest=${pair#*:}
  from=$(largest "${rest%%:*}" "${rest#*:}")
  [ -n "$from" ] || { echo "| $agent | none found | | | | |"; continue; }
  copy=$S/$agent.jsonl
  cp "$from" "$copy"
  size=$(stat -f %z "$copy")
  first=$(cost "$copy" "$agent")
  rows=$(jq -s '[.[] | select(.type == "row")] | length' "$S/out")
  c=$(cursor_of)
  echo "| $agent | $size B | first read | $first | $rows rows |"
  same=$(cost "$copy" "$agent" "$c")
  echo "| $agent | $size B | unchanged cursor | $same | $(head -2 "$S/out" | tail -1 | jq -r .type) |"
  # One more complete record: the log's last line again, as an agent appends one.
  tail -1 "$copy" > "$S/line"
  cat "$S/line" >> "$copy"
  grown=$(stat -f %z "$copy")
  cp -R "$S/cache" "$S/cache.saved"
  more=$(cost "$copy" "$agent" "$c")
  rm -rf "$S/cache.saved"
  echo "| $agent | $grown B | one appended line | $more | $(head -2 "$S/out" | tail -1 | jq -c '{type, at, count}') |"
done
