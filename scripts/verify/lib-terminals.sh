# The terminals a verify run starts in the user's own hc core, where Bellwether's own launches start theirs
# under the same names; sourced, not run.

# bw_slug <machine>: the slug in bw's terminal names for that machine (crates/bw/src/browser/forward.rs slug).
bw_slug() {
  _ts=$(printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9-]/-/g' | cut -c1-25)
  printf '%s\n' "${_ts:-machine}"
}

# run_names <machine>: what bw browser agent-args --machine <machine> starts in the calling core, the
# machine's forward and its npx warm, one name per line.
run_names() {
  _ts=$(bw_slug "$1")
  printf '%s\n' "bw-fwd-$_ts" "$(printf '%s' "bw-warm-$_ts" | cut -c1-32)"
}

# sort_new <before> <name>...: reads hc ls --all --json on stdin. For each live bw-* terminal whose address
# was not live in <before> (hc ls --all --json from the run's start) it prints "own <address> <name>" when
# its name is one of <name> and no terminal live in <before> had that name, else "other <address> <name>".
# An unreadable <before> makes every terminal "other".
sort_new() {
  _tb=$1
  shift
  printf '%s' "$_tb" | jq -e 'type == "object"' > /dev/null 2>&1 || _tb='{"unreadable": true}'
  jq -r --argjson before "$_tb" '
    ($before.terminals // [] | map(select(.state == "live"))) as $b
    | .terminals[]? | select(.state == "live") | (.name // "") as $n | .address as $a
    | select($n | startswith("bw-"))
    | select(any($b[]; .address == $a) | not)
    | if ($before.unreadable | not) and any($ARGS.positional[]; . == $n) and (any($b[]; .name == $n) | not)
      then "own \($a) \($n)" else "other \($a) \($n)" end' --args "$@"
}
