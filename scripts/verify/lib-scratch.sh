# Scratch folders the verify scripts make and delete; sourced, not run.
# A folder counts only when it resolves strictly inside $scratch_root, and only a folder that
# scratch_make created (it holds .bw-scratch) may be deleted.
scratch_root=/private/tmp

# scratch_path <dir>: prints <dir> with its parent resolved, or fails when it is not strictly inside $scratch_root.
scratch_path() {
  case $1 in /*) ;; *) echo "$1: not an absolute path" >&2; return 1 ;; esac
  case /$1/ in */../* | */./*) echo "$1: has a . or .. component" >&2; return 1 ;; esac
  _sp=$(printf '%s' "$1" | sed 's:/*$::')
  _sb=${_sp##*/} _sp=${_sp%/*}
  [ -n "$_sb" ] || { echo "$1: names no folder" >&2; return 1; }
  _sr=$(cd "$scratch_root" 2> /dev/null && pwd -P) || { echo "$scratch_root: missing" >&2; return 1; }
  _sp=$(cd "${_sp:-/}" 2> /dev/null && pwd -P) || { echo "$1: its parent folder does not exist" >&2; return 1; }
  case $_sp/ in "$_sr"/*) ;; *) echo "$1: not inside $_sr" >&2; return 1 ;; esac
  # rm -rf on a link removes only the link, and the marker test would read through it.
  [ ! -L "$_sp/$_sb" ] || { echo "$1: is a symlink" >&2; return 1; }
  printf '%s\n' "$_sp/$_sb"
}

# scratch_make <dir>: creates <dir>, which must not exist yet, and marks it as this script's.
scratch_make() {
  _sd=$(scratch_path "$1") || return 1
  mkdir "$_sd" || return 1
  echo "made by ${0##*/}; scratch_rm deletes only folders holding this file" > "$_sd/.bw-scratch"
}

# scratch_owned <dir>: succeeds when <dir> exists and scratch_make made it.
scratch_owned() {
  _sd=$(scratch_path "$1") || return 1
  [ -d "$_sd" ] && [ -f "$_sd/.bw-scratch" ] && return 0
  echo "$_sd has no .bw-scratch marker, so no verify script made it: delete it yourself if it is scratch" >&2
  return 1
}

# scratch_rm <dir>: deletes <dir> when scratch_make made it; a missing <dir> is already gone.
scratch_rm() {
  _sd=$(scratch_path "$1") || return 1
  [ -e "$_sd" ] || return 0
  scratch_owned "$_sd" || return 1
  rm -rf "$_sd"
}
