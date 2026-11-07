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

# scratch_procs <dir> [pid...]: prints, one per line, the processes still using <dir>: those whose cwd or
# command line is inside it, each listed pid that runs and the members of its process group. The shells
# running this function, up to the script, are left out: their argv may name <dir> without using it.
scratch_procs() {
  _sd=$(scratch_path "$1") || return 1
  _sg=$(printf '%s' "$1" | sed 's:/*$::')
  shift
  # exec keeps the substitution from forking a copy of this shell, so $PPID is this shell.
  _self=$(exec sh -c 'echo $PPID')
  _ps=$(exec ps -ax -o pid= -o ppid= -o pgid= -o command= 2> /dev/null) || _ps=
  _cp=$(lsof -a -d cwd -Fpn 2> /dev/null | awk -v a="$_sd" -v b="$_sg" '
    /^p/ { p = substr($0, 2) }
    /^n/ { n = substr($0, 2); if (n == a || index(n, a "/") == 1 || n == b || index(n, b "/") == 1) print p }'; true)
  printf '%s\n' "$_ps" | awk -v a="$_sd" -v b="$_sg" -v self="$_self" -v top="$$" -v cwd="$_cp" -v want="$*" '
    function inside(s, d,   k, ch) {
      while ((k = index(s, d)) > 0) {
        ch = substr(s, k + length(d), 1)
        if (ch == "" || ch == "/" || ch == " ") return 1
        s = substr(s, k + 1)
      }
      return 0
    }
    NF >= 3 { n++; pid[n] = $1; pp[$1] = $2; pg[$1] = $3; c = $0; sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ */, "", c); cmd[$1] = c }
    END {
      p = self
      while (p != "" && p + 0 > 1 && !(p in skip)) { skip[p] = 1; if (p == top) break; p = pp[p] }
      # A subshell of one of those is a forked copy with the same argv.
      for (i = 1; i <= n; i++) { q = pid[i]; if ((pp[q] in skip) && cmd[q] == cmd[pp[q]]) skip[q] = 1 }
      k = split(cwd, cw, "\n"); for (i = 1; i <= k; i++) if (cw[i] != "") hit[cw[i]] = 1
      k = split(want, w, " "); for (i = 1; i <= k; i++) if (w[i] != "") listed[w[i]] = 1
      for (i = 1; i <= n; i++) {
        q = pid[i]
        if (q in skip) continue
        if ((q in hit) || (q in listed) || (pg[q] in listed) || inside(cmd[q], a) || inside(cmd[q], b)) print q
      }
    }' | sort -un
}

# scratch_rm_idle <dir> [pid...]: scratch_rm, unless scratch_procs lists a process: then <dir> stays, with
# the output those processes still write, and a FAIL on stderr names them and <dir>.
scratch_rm_idle() {
  _sd=$(scratch_path "$1") || return 1
  [ -e "$_sd" ] || return 0
  _busy=$(scratch_procs "$@") || return 1
  if [ -n "$_busy" ]; then
    echo "FAIL kept $_sd: process(es) $(printf '%s\n' "$_busy" | tr '\n' ' ')still use it; stop them, then delete it or run again" >&2
    return 1
  fi
  scratch_rm "$_sd"
}
