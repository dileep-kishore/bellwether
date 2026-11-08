#!/bin/sh
# Done check E's cost half: what one `bw feed` and one `bw diff files` cost on the largest session logs
# and the largest Git checkout under the home folder, here or on another machine.
#   scripts/verify/poll-cost.sh [--machine <name>] [--bw <path>] [runs]
# Here it runs this checkout's release build; with --machine, the helper installed there (through
# hc exec, nothing on that machine's display). Each case runs [runs] times (default 5) under
# /usr/bin/time -l. Prints a Markdown table with the files' paths, never a log's text.
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
machine= bw= runs=5
while [ $# -gt 0 ]; do
  case $1 in
    --machine) machine=${2:?--machine needs a name}; shift ;;
    --bw) bw=${2:?--bw needs a path}; shift ;;
    -*) sed -n 4p "$0" >&2; exit 2 ;;
    *) runs=$1 ;;
  esac
  shift
done

probe=$src/scripts/verify/poll-cost-probe.sh
if [ -n "$machine" ]; then
  out=$(hc exec -i --on "$machine" --timeout 600 -- sh -s -- "${bw:-~/.local/share/bellwether/helper/current/bw}" "$runs" < "$probe")
  where=$machine
else
  if [ -z "$bw" ]; then
    cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml"
    bw=$src/target/release/bw
  fi
  out=$(sh -s -- "$bw" "$runs" < "$probe")
  where=$(hostname -s)
fi

echo "$where, $runs runs per case; ms are user plus system CPU of the call and the Git it ran"
echo
echo "| Case | File or checkout | Size | Answer | Median ms | Max ms | time -l ms | Max RSS |"
echo "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |"
echo "$out" | awk -F'\t' '{ printf "| %s | `%s` | %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5, $6, $7, $8 }'
