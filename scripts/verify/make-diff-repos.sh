#!/bin/sh
# Builds the Git repositories that `bw diff` tests and done check C (scripts/verify/git.sh) read.
#   scripts/verify/make-diff-repos.sh <root>
# Under <root>:
#   changes   branch feat, two commits past its merge base with origin/main, which has moved one commit on;
#             tag v1 on the first commit; staged, unstaged and untracked changes including a rename, binary
#             files, a path with a space and a leading dash, and *.tc files whose textconv, external diff
#             and fsmonitor hook would each create <root>/textconv-ran;
#   nobase    commits and no remote;  headonly  origin/HEAD -> origin/trunk and no origin/main;
#   unborn    no commits, one staged file.
# Prints "name<TAB>path" for each, then "marker<TAB><root>/textconv-ran". Rebuilds a <root> holding
# .bw-verify; refuses any other non-empty <root>. Sources nothing, so it also runs as
# `sh -c "<script>" sh <root>` on another machine.
set -eu

[ $# -eq 1 ] || { echo "usage: make-diff-repos.sh <root>" >&2; exit 2; }
root=$1
case $root in /*) ;; *) echo "$root: not an absolute path" >&2; exit 2 ;; esac
marker=.bw-verify

if [ -L "$root" ]; then
  echo "$root: is a symlink" >&2; exit 1
elif [ -d "$root" ]; then
  if [ -f "$root/$marker" ]; then
    rm -rf "$root/changes" "$root/changes-origin.git" "$root/nobase" "$root/headonly" "$root/headonly-origin.git" \
      "$root/unborn" "$root/textconv-ran" "$root/hooks"
  elif [ -n "$(ls -A "$root")" ]; then
    echo "$root: not empty and has no $marker, so make-diff-repos.sh did not make it" >&2; exit 1
  fi
elif [ -e "$root" ]; then
  echo "$root: not a folder" >&2; exit 1
else
  mkdir -p "$root"
fi
echo "made by make-diff-repos.sh; it rebuilds only folders holding this file" > "$root/$marker"
root=$(cd "$root" && pwd -P)
ran=$root/textconv-ran

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_EXTERNAL_DIFF
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=bw-verify GIT_AUTHOR_EMAIL=bw-verify@example.invalid
export GIT_COMMITTER_NAME=bw-verify GIT_COMMITTER_EMAIL=bw-verify@example.invalid
stamp() { export GIT_AUTHOR_DATE="2026-01-0${1}T00:00:00Z" GIT_COMMITTER_DATE="2026-01-0${1}T00:00:00Z"; }

# Each would leave the marker if Git ran it; the repository config below names them.
mkdir -p "$root/hooks"
printf '#!/bin/sh\ntouch "%s"\ncat "$1"\n' "$ran" > "$root/hooks/textconv"
printf '#!/bin/sh\ntouch "%s"\n' "$ran" > "$root/hooks/external"
printf '#!/bin/sh\ntouch "%s"\nexit 1\n' "$ran" > "$root/hooks/fsmonitor"
chmod 755 "$root/hooks/textconv" "$root/hooks/external" "$root/hooks/fsmonitor"

# changes
stamp 1
git init -q --bare -b main "$root/changes-origin.git"
git init -q -b main "$root/changes"
cd "$root/changes"
printf 'one\ntwo\nthree\n' > notes.txt
printf 'staged\n' > staged.txt
printf 'a\nb\nc\nd\ne\nf\n' > old-name.txt
printf '\000\001\002first\n' > pic.bin
printf 'gone\n' > gone.txt
printf 'dash\n' > 'dash -name.txt'
printf 'marked\n' > mark.tc
printf '*.tc diff=mark\n' > .gitattributes
git add -A
git commit -q -m "changes: first"
git tag v1
git remote add origin "$root/changes-origin.git"
git push -q -u origin main
git checkout -q -b feat
stamp 2
printf 'feature\n' > feature.txt
git add feature.txt
git commit -q -m "feat: add feature"
stamp 3
printf 'marked\nagain\n' > mark.tc
git commit -q -am "feat: change mark"
# origin/main moves on after feat left it, so Tip and Merge base differ.
git checkout -q main
stamp 4
printf 'main moved\n' > main-only.txt
git add main-only.txt
git commit -q -m "main: moved on"
git push -q origin main
git checkout -q feat
# Staged
printf 'staged\nmore\n' > staged.txt
git mv old-name.txt new-name.txt
printf '\000\001\002second\n' > pic.bin
printf 'marked\nagain\nstaged\n' > mark.tc
git add staged.txt pic.bin mark.tc
# Unstaged
printf 'one\ntwo changed\nthree\nfour\n' > notes.txt
rm gone.txt
printf 'dash\nedited\n' > 'dash -name.txt'
# Untracked
printf 'f1\nf2\nf3\n' > fresh.txt
printf '\000blob\n' > blob.dat
mkdir newdir
printf 'inner' > newdir/inner.txt
printf 'fresh tc\n' > fresh.tc
# Set last: the fsmonitor hook would run on this script's own git calls.
git config diff.mark.textconv "$root/hooks/textconv"
git config diff.external "$root/hooks/external"
git config core.fsmonitor "$root/hooks/fsmonitor"

# nobase
stamp 1
git init -q -b main "$root/nobase"
printf 'nobase\n' > "$root/nobase/README.md"
git -C "$root/nobase" add README.md
git -C "$root/nobase" commit -q -m "nobase: first"

# headonly
git init -q --bare -b trunk "$root/headonly-origin.git"
git init -q -b trunk "$root/headonly"
printf 'head\n' > "$root/headonly/README.md"
git -C "$root/headonly" add README.md
git -C "$root/headonly" commit -q -m "headonly: first"
git -C "$root/headonly" remote add origin "$root/headonly-origin.git"
git -C "$root/headonly" push -q -u origin trunk
git -C "$root/headonly" remote set-head origin trunk > /dev/null
git -C "$root/headonly" checkout -q -b work
printf 'work\n' > "$root/headonly/work.txt"
git -C "$root/headonly" add work.txt
stamp 2
git -C "$root/headonly" commit -q -m "headonly: work"

# unborn
git init -q -b main "$root/unborn"
printf 'unborn\n' > "$root/unborn/first.txt"
git -C "$root/unborn" add first.txt

printf 'changes\t%s\n' "$root/changes"
printf 'nobase\t%s\n' "$root/nobase"
printf 'headonly\t%s\n' "$root/headonly"
printf 'unborn\t%s\n' "$root/unborn"
printf 'marker\t%s\n' "$ran"
