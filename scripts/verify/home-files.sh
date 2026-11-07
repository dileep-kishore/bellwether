#!/bin/sh
# The files under a HOME that a verify run may create or change, saved and put back one by one; requests.sh runs
# this text with sh -c on the other machine.
#   home-files.sh sums <home> <path>...             sha256 of each file under the paths, sorted
#   home-files.sh save <home> <saved> <path>...     copies each file and lists each folder into <saved>
#   home-files.sh restore <home> <saved> <path>...  puts back each saved file that changed or went, deletes each
#     file that was not there and then each folder that was not there; files that did not change are left alone.
#   "File" here also means a symbolic link, saved and compared as the link itself, never its target.
set -u
mode=${1:?mode} home=${2:?home}
shift 2
cd "$home" || exit 1

entries() { find "$1" \( -type f -o -type l \); }
# Two saved entries are equal when both are the same link, or both are regular files with the same bytes.
same() { if [ -L "$1" ] || [ -L "$2" ]; then [ -L "$1" ] && [ -L "$2" ] && [ "$(readlink "$1")" = "$(readlink "$2")" ]; else cmp -s "$1" "$2"; fi; }

sums() { for p in "$@"; do [ -e "$p" ] && find "$p" -type f -exec shasum -a 256 {} +; done | sort; }

case $mode in
  sums) sums "$@" ;;
  save)
    saved=${1:?saved}
    shift
    mkdir -p "$saved/files" && : > "$saved/dirs" || exit 1
    for p in "$@"; do
      [ -e "$p" ] || continue
      find "$p" -type d >> "$saved/dirs" && entries "$p" > "$saved/list" || exit 1
      while IFS= read -r f; do
        mkdir -p "$saved/files/$(dirname "$f")" && cp -pP "$f" "$saved/files/$f" || exit 1
      done < "$saved/list"
    done
    ;;
  restore)
    saved=${1:?saved}
    shift
    [ -d "$saved/files" ] && [ -f "$saved/dirs" ] || { echo "$saved: nothing saved" >&2; exit 1; }
    status=0
    for p in "$@"; do [ -e "$p" ] && entries "$p"; done > "$saved/now"
    while IFS= read -r f; do
      if [ -f "$saved/files/$f" ] || [ -L "$saved/files/$f" ]; then
        same "$f" "$saved/files/$f" || { rm -f "$f" && cp -pP "$saved/files/$f" "$f"; } || status=1
      else
        rm -f "$f" || status=1
      fi
    done < "$saved/now"
    (cd "$saved/files" && entries .) > "$saved/was" || status=1
    while IFS= read -r f; do
      f=${f#./}
      [ -e "$f" ] || [ -L "$f" ] || { mkdir -p "$(dirname "$f")" && cp -pP "$saved/files/$f" "$f"; } || status=1
    done < "$saved/was"
    for p in "$@"; do [ -d "$p" ] && find "$p" -depth -type d; done > "$saved/dirs-now"
    while IFS= read -r d; do
      grep -qxF "$d" "$saved/dirs" && continue
      # rmdir, never rm -rf: a folder that still holds something (a socket, a fifo) is reported, not emptied.
      rmdir "$d" 2> /dev/null || { echo "$home/$d: made during the run and not empty once its files went" >&2; status=1; }
    done < "$saved/dirs-now"
    exit "$status"
    ;;
  *) echo "home-files.sh: no mode $mode" >&2; exit 2 ;;
esac
