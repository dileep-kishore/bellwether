#!/bin/sh
# Runs on the machine being measured, fed on stdin by poll-cost.sh: times the two calls a shown panel
# repeats, `bw feed` on the largest Claude and Codex logs and `bw diff files` on the largest Git checkout
# under $HOME, each [runs] times under /usr/bin/time -l.
#   sh -s -- <bw> <runs> < poll-cost-probe.sh
# Prints one tab-separated line per case: case, the file or checkout (with ~ for $HOME), its size, the
# answer, median and largest user plus system ms from getrusage (microseconds; /usr/bin/time rounds to
# 10 ms), the median of /usr/bin/time's user plus system, and its largest maximum resident set size.
# Only reads: log copies and the feed cache go to a scratch folder under /private/tmp, deleted on exit.
set -eu
bw=$1 runs=$2
# A path given as ~/… is this machine's home, which the caller cannot know.
case $bw in "~/"*) bw=$HOME/${bw#"~/"} ;; esac
S=$(mktemp -d /private/tmp/bw-poll-cost.XXXXXX)
echo "made by poll-cost-probe.sh" > "$S/.bw-scratch"
trap 'rm -rf "$S"' EXIT
trap 'exit 1' HUP INT TERM
export BW_CACHE_DIR=$S/cache

# argv[1]: where /usr/bin/time's report goes; argv[2]: the program's stdout; prints the user plus
# system ms of everything the run started (time, bw and its git calls).
rusage='import resource, subprocess, sys
with open(sys.argv[1], "wb") as err, open(sys.argv[2], "wb") as out:
    subprocess.run(["/usr/bin/time", "-l"] + sys.argv[3:], stdout=out, stderr=err, check=True)
r = resource.getrusage(resource.RUSAGE_CHILDREN)
print(round((r.ru_utime + r.ru_stime) * 1000, 2))'

# largest <dir> <name pattern>: the biggest matching file, by size.
largest() {
  find "$1" -type f -name "$2" -exec stat -f '%z %N' {} + 2> /dev/null | sort -n | tail -1 | cut -d' ' -f2-
}

# The checkout whose index is largest: what `git status` and `git diff` read on every call. The walk
# stops at each .git (a folder for a repository, a file for a linked worktree), never inside one. It
# skips the folders macOS guards with a privacy prompt: over SSH, reading Desktop, Documents or
# Downloads blocks until someone answers a dialog on that machine's display.
largest_checkout() {
  find "$HOME" -maxdepth 6 \( -path "$HOME/Library" -o -path "$HOME/Desktop" -o -path "$HOME/Documents" \
    -o -path "$HOME/Downloads" -o -path "$HOME/Pictures" -o -path "$HOME/Movies" -o -path "$HOME/Music" \
    -o -name node_modules -o -name .Trash -o -name .cache -o -name target -o -name .cargo -o -name .rustup \) \
    -prune -o -name .git -prune -print 2> /dev/null | while read -r g; do
    if [ -d "$g" ]; then idx=$g/index; else idx=$(sed -n 's/^gitdir: //p' "$g" 2> /dev/null)/index; fi
    [ -f "$idx" ] && echo "$(stat -f %z "$idx") ${g%/.git}"
  done | sort -n | tail -1 | cut -d' ' -f2-
}

# cost [bw args…]: runs it $runs times; sets ms_med, ms_max, time_med and rss_max.
cost() {
  : > "$S/ms"
  : > "$S/time"
  : > "$S/rss"
  i=0
  while [ "$i" -lt "$runs" ]; do
    if [ -d "$S/cache.saved" ]; then rm -rf "$S/cache"; cp -R "$S/cache.saved" "$S/cache"; fi
    python3 -I -c "$rusage" "$S/err" "$S/out" "$bw" "$@" >> "$S/ms"
    awk '$2 == "real" { u = $3; s = $5 } END { printf "%.0f\n", (u + s) * 1000 }' \
      "$S/err" >> "$S/time"
    awk '/maximum resident set size/ { print $1 }' "$S/err" >> "$S/rss"
    i=$((i + 1))
  done
  med() { sort -n "$1" | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }'; }
  max() { sort -n "$1" | tail -1; }
  ms_med=$(med "$S/ms") ms_max=$(max "$S/ms") time_med=$(med "$S/time") rss_max=$(max "$S/rss")
}

# row <case> <where> <size> <answer>: one line for the last cost.
row() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$(echo "$2" | sed "s:^$HOME:~:")" "$3" "$4" \
    "$ms_med" "$ms_max" "$time_med" "$rss_max"
}

for pair in "claude:$HOME/.claude/projects:*.jsonl" "codex:$HOME/.codex/sessions:rollout-*.jsonl"; do
  agent=${pair%%:*} rest=${pair#*:}
  from=$(largest "${rest%%:*}" "${rest#*:}")
  if [ -z "$from" ]; then
    printf 'feed %s\tnone found\t\t\t\t\t\t\n' "$agent"
    continue
  fi
  rm -rf "$S/cache"
  copy=$S/$agent.jsonl
  cp "$from" "$copy"
  size="$(stat -f %z "$copy") B"
  cost feed --log "$copy" --agent "$agent" --pictures
  row "feed $agent, first read" "$from" "$size" "$(jq -s '[.[] | select(.type == "row")] | length' "$S/out") rows"
  c=$(head -1 "$S/out" | jq -r .cursor)
  cost feed --log "$copy" --agent "$agent" --pictures --cursor "$c"
  row "feed $agent, unchanged cursor" "$from" "$size" "$(head -2 "$S/out" | tail -1 | jq -r .type)"
  # One more complete record, as an agent appends one: the log's last line again.
  tail -1 "$copy" > "$S/line"
  cat "$S/line" >> "$copy"
  size="$(stat -f %z "$copy") B"
  cp -R "$S/cache" "$S/cache.saved"
  cost feed --log "$copy" --agent "$agent" --pictures --cursor "$c"
  row "feed $agent, one appended line" "$from" "$size" "$(head -2 "$S/out" | tail -1 | jq -c '{type, at}')"
  rm -rf "$S/cache.saved"
done

top=$(largest_checkout)
if [ -z "$top" ]; then
  printf 'diff files\tnone found\t\t\t\t\t\t\n'
else
  tracked=$(git -C "$top" --no-optional-locks -c core.fsmonitor=false ls-files | wc -l | tr -d ' ')
  cost diff files --path "$top"
  row "diff files, full read" "$top" "$tracked tracked files" "$(wc -l < "$S/out" | tr -d ' ') lines"
  # A remote panel's idle poll: the token of a full read sent back while the watcher saw no event. A helper
  # before 0.7.0 has no watcher and refuses --watch.
  t="" i=0
  while [ -z "$t" ] && [ "$i" -lt 50 ]; do
    "$bw" diff files --path "$top" --watch > "$S/out" 2> /dev/null || break
    t=$(jq -r 'select(.type == "diff-token") | .token' "$S/out")
    [ -n "$t" ] || sleep 0.1
    i=$((i + 1))
  done
  if [ -n "$t" ]; then
    started=$(date +%s)
    cost diff files --path "$top" --watch --since "$t"
    row "diff files --watch, token unchanged" "$top" "$tracked tracked files" "$(jq -r .type "$S/out")"
    # The watcher's own CPU since it started, from ps (minutes:seconds).
    w=$(pgrep -f "diff watch --path $top" | head -1)
    cpu=$(ps -o time= -p "$w" | awk -F: '{ printf "%.0f", ($1 * 60 + $2) * 1000 }')
    printf 'watcher, %s s after its first read\t%s\t\tbw diff watch\t%s\t%s\t\t%s\n' \
      "$(($(date +%s) - started + 1))" "$(echo "$top" | sed "s:^$HOME:~:")" "$cpu" "$cpu" \
      "$(ps -o rss= -p "$w" | awk '{ print $1 * 1024 }')"
  fi
fi
