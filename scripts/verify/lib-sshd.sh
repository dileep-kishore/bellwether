# A scratch sshd run as the user on a free 127.0.0.1 port, for testing ssh -R and -L forwards
# without Remote Login or ~/.ssh; sourced, not run, after lib-scratch.sh.
#   sshd_up <dir>    makes <dir> (scratch_make), starts sshd there and prints
#                    SSH_CONFIG=<file> SSH_TARGET=bw-scratch; the port is in <dir>/port
#   sshd_down <dir>  kills that sshd by its pid file and deletes <dir> (scratch_rm)
# BW_SSHD_GATEWAY_PORTS (default no) sets GatewayPorts, so a test can make a wildcard listener.

# _sshd_free_port: a port the kernel just handed out on 127.0.0.1; another process may take it first.
_sshd_free_port() {
  /usr/bin/python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()' 2> /dev/null ||
    bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);'
}

sshd_up() {
  command -v scratch_make > /dev/null || { echo "sshd_up: source lib-scratch.sh first" >&2; return 1; }
  [ -x /usr/sbin/sshd ] || { echo "sshd_up: /usr/sbin/sshd is missing" >&2; return 1; }
  _xd=$(scratch_path "$1") || return 1
  scratch_make "$_xd" || return 1
  ssh-keygen -q -t ed25519 -N '' -C bw-scratch-host -f "$_xd/host_ed25519" || return 1
  ssh-keygen -q -t ed25519 -N '' -C bw-scratch-client -f "$_xd/client_ed25519" || return 1
  cp "$_xd/client_ed25519.pub" "$_xd/authorized_keys"
  _xp=$(_sshd_free_port) || { echo "sshd_up: no free port" >&2; return 1; }
  echo "$_xp" > "$_xd/port"
  cat > "$_xd/sshd_config" << EOF
ListenAddress 127.0.0.1
Port $_xp
HostKey $_xd/host_ed25519
PidFile $_xd/sshd.pid
AuthorizedKeysFile $_xd/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowTcpForwarding yes
GatewayPorts ${BW_SSHD_GATEWAY_PORTS:-no}
EOF
  cat > "$_xd/ssh_config" << EOF
Host bw-scratch
  HostName 127.0.0.1
  Port $_xp
  User $USER
  IdentityFile $_xd/client_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile $_xd/known_hosts
  StrictHostKeyChecking accept-new
EOF
  /usr/sbin/sshd -t -f "$_xd/sshd_config" || { echo "sshd_up: sshd -t rejected $_xd/sshd_config" >&2; return 1; }
  # sshd re-executes itself, so it needs its absolute path; -D keeps it in the foreground of this background job.
  # Its stdout must not be the caller's, or $(sshd_up …) waits for sshd to exit.
  /usr/sbin/sshd -D -e -f "$_xd/sshd_config" < /dev/null > /dev/null 2> "$_xd/sshd.log" &
  _xs=$!
  echo "$_xs" > "$_xd/sshd.pid"
  _xn=50
  until grep -q "Server listening on 127.0.0.1 port $_xp" "$_xd/sshd.log" 2> /dev/null; do
    _xn=$((_xn - 1))
    # sshd rewrites sshd.pid (its PidFile) once it listens, so a read here can find it empty.
    if [ "$_xn" -le 0 ] || ! kill -0 "$_xs" 2> /dev/null; then
      echo "sshd_up: sshd did not start; its log:" >&2
      cat "$_xd/sshd.log" >&2
      return 1
    fi
    sleep 0.2
  done
  echo "SSH_CONFIG=$_xd/ssh_config SSH_TARGET=bw-scratch"
}

sshd_down() {
  _xd=$(scratch_path "$1") || return 1
  [ -e "$_xd" ] || return 0
  scratch_owned "$_xd" || return 1
  if [ -f "$_xd/sshd.pid" ]; then
    _xk=$(cat "$_xd/sshd.pid")
    # Only a pid whose command line names this folder's config is ours to kill.
    if ps -ww -o command= -p "$_xk" 2> /dev/null | grep -qF "$_xd/sshd_config"; then
      kill "$_xk" 2> /dev/null || true
      _xn=25
      while kill -0 "$_xk" 2> /dev/null && [ "$_xn" -gt 0 ]; do sleep 0.2; _xn=$((_xn - 1)); done
    fi
  fi
  # Only processes that are sshd: a shell whose command line holds the path must survive.
  for _xk in $(pgrep -f "$_xd/sshd_config"); do
    case $(ps -ww -o command= -p "$_xk" 2> /dev/null) in
      sshd:* | /usr/sbin/sshd*) kill "$_xk" 2> /dev/null || true ;;
    esac
  done
  scratch_rm "$_xd"
}
