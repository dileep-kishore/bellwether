#!/bin/sh
# Builds the Git repositories that the Git layer tests and done check 1 read.
#   scripts/verify/make-repos.sh <root>
# Under <root>: alpha (main one commit ahead of origin/main; worktrees alpha-wt/feat with +3 -1 in
# notes.txt, alpha-wt/detached, alpha/.worktrees/nested), alpha-origin.git, beta, gamma (no commits).
# Prints "alpha<TAB><common dir>" and "beta<TAB><common dir>". Rebuilds a <root> holding .bw-verify;
# refuses any other non-empty <root>. Sources nothing, so it also runs as `sh -c "<script>" sh <root>`.
set -eu

[ $# -eq 1 ] || { echo "usage: make-repos.sh <root>" >&2; exit 2; }
root=$1
case $root in /*) ;; *) echo "$root: not an absolute path" >&2; exit 2 ;; esac
marker=.bw-verify

if [ -L "$root" ]; then
  echo "$root: is a symlink" >&2; exit 1
elif [ -d "$root" ]; then
  if [ -f "$root/$marker" ]; then
    rm -rf "$root/alpha" "$root/alpha-origin.git" "$root/alpha-wt" "$root/beta" "$root/gamma"
  elif [ -n "$(ls -A "$root")" ]; then
    echo "$root: not empty and has no $marker, so make-repos.sh did not make it" >&2; exit 1
  fi
elif [ -e "$root" ]; then
  echo "$root: not a folder" >&2; exit 1
else
  mkdir -p "$root"
fi
echo "made by make-repos.sh; it rebuilds only folders holding this file" > "$root/$marker"
root=$(cd "$root" && pwd -P)

# The user's Git config (hooks, signing, default branch) must not change what gets built.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=bw-verify GIT_AUTHOR_EMAIL=bw-verify@example.invalid
export GIT_COMMITTER_NAME=bw-verify GIT_COMMITTER_EMAIL=bw-verify@example.invalid
# Fixed dates give the same commit ids on every machine.
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z

git init -q --bare -b main "$root/alpha-origin.git"
git init -q -b main "$root/alpha"
cd "$root/alpha"
printf 'one\ntwo\nthree\nfour\n' > notes.txt
printf 'alpha\n' > README.md
printf '\000\001\002\003binary\n' > logo.bin
git add notes.txt README.md logo.bin
git commit -q -m "alpha: first"
git remote add origin "$root/alpha-origin.git"
git push -q -u origin main
printf 'second\n' >> README.md
git commit -q -am "alpha: second"
# The nested worktree would otherwise show as untracked in the main checkout.
printf '/.worktrees/\n' >> .git/info/exclude
mkdir -p "$root/alpha-wt" "$root/alpha/.worktrees"
git worktree add -q -b feat "$root/alpha-wt/feat" main
git -C "$root/alpha-wt/feat" branch -q --set-upstream-to=origin/main
git worktree add -q --detach "$root/alpha-wt/detached" main
git worktree add -q -b nested "$root/alpha/.worktrees/nested" main
printf 'one\ntwo-a\ntwo-b\ntwo-c\nthree\nfour\n' > "$root/alpha-wt/feat/notes.txt"

git init -q -b main "$root/beta"
printf 'beta\n' > "$root/beta/README.md"
git -C "$root/beta" add README.md
git -C "$root/beta" commit -q -m "beta: first"

git init -q -b main "$root/gamma"

printf 'alpha\t%s\n' "$root/alpha/.git"
printf 'beta\t%s\n' "$root/beta/.git"
