#!/bin/sh
# Done check 1 without a window: the project tree built from real Git on this Mac and on another
# machine matches Git, a closed row opens its exact folder, counts follow an edit within 2 s, and an
# unreachable machine keeps its rows.
#   scripts/verify/projects.sh [--offline | --machine <name>]
# This Mac's repositories go in /private/tmp/bw-verify-projects; <name>'s in $BW_PROJECTS_REMOTE_ROOT
# (default $HOME/bw-verify/projects there), built by sending make-repos.sh as `hc exec --on <name> sh -c <script> sh <root>`.
# --offline uses no other machine: gamma is built under the local root and served by a local exec
# named bw-stand-in, and the remote half of counts-within-2s is skipped. No flag does the same and
# prints a PENDING line for the remote half.
# The remote counts check edits alpha's feat worktree on <name>, not gamma: gamma has no commits, and
# the counts script diffs against HEAD.
# Prints PASS <check> or FAIL <check>: <why>; exits 1 on any FAIL. Deletes only roots holding .bw-verify.
set -u
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
hc=${BW_HC:-hc}
L=/private/tmp/bw-verify-projects
machine= offline=0 R=
case "${1:-}" in
  "") ;;
  --offline) offline=1 ;;
  --machine) machine=${2:?--machine needs a name} ;;
  *) sed -n 5p "$0" >&2; exit 2 ;;
esac

cleanup() {
  [ -f "$L/.bw-verify" ] && rm -rf "$L"
  [ -e "$L" ] && echo "FAIL cleanup: $L is still there"
  if [ -n "$R" ]; then
    "$hc" exec --on "$machine" -- sh -c '[ -f "$1/.bw-verify" ] && rm -rf "$1"; rmdir "${1%/*}" 2> /dev/null; [ ! -e "$1" ]' sh "$R" ||
      echo "FAIL cleanup: $R on $machine is still there"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# make-repos prints "alpha<TAB><root>/alpha/.git" with <root> resolved as Git spells it.
root_of() { printf '%s\n' "$1" | awk -F '\t' '$1 == "alpha" { sub(/\/alpha\/\.git$/, "", $2); print $2 }'; }
beta_of() { printf '%s\n' "$1" | awk -F '\t' '$1 == "beta" { print $2 }'; }

out=$(sh "$src/scripts/verify/make-repos.sh" "$L") || { echo "FAIL setup: make-repos.sh $L"; exit 1; }
local_root=$(root_of "$out") beta=$(beta_of "$out")
set -- --root "$local_root" --beta "$beta"

if [ -n "$machine" ]; then
  home=$("$hc" exec --on "$machine" -- sh -c 'printf %s "$HOME"' 2>&1) && [ -n "$home" ] ||
    { echo "FAIL setup: hc exec --on $machine cannot read its HOME: $home"; exit 1; }
  R=${BW_PROJECTS_REMOTE_ROOT:-$home/bw-verify/projects}
  out=$("$hc" exec --on "$machine" -- sh -c "$(cat "$src/scripts/verify/make-repos.sh")" sh "$R" 2>&1) ||
    { echo "FAIL setup: make-repos.sh $R on $machine: $out"; exit 1; }
  set -- "$@" --machine "$machine" --remote-root "$(root_of "$out")"
else
  out=$(sh "$src/scripts/verify/make-repos.sh" "$L/remote") || { echo "FAIL setup: make-repos.sh $L/remote"; exit 1; }
  set -- "$@" --remote-root "$(root_of "$out")"
fi

bun "$src/scripts/verify/projects-run.js" "$@"
status=$?
[ -z "$machine" ] && [ "$offline" = 0 ] && echo "PENDING counts-within-2s on another machine: no --machine given"
exit "$status"
