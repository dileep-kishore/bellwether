#!/bin/sh
# Store a Linear personal API key in this Mac's login Keychain, where `bw linear` reads it.
#   scripts/linear-key.sh < keyfile      the key on standard input
#   scripts/linear-key.sh                a prompt that does not echo, when standard input is a terminal
# BW_LINEAR_SERVICE names another Keychain service, for tests; the default is bellwether.linear.
# The key never reaches an argument list: `security -i` reads its command, with the key in hex, from a pipe.
set -eu
service=${BW_LINEAR_SERVICE:-bellwether.linear}
case "$service" in
  *[!A-Za-z0-9._-]* | "") echo "linear-key: BW_LINEAR_SERVICE may hold only letters, digits, '.', '_' and '-'" >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo "usage: scripts/linear-key.sh < keyfile" >&2; exit 2; }

if [ -t 0 ]; then
  printf 'Linear personal API key: ' >&2
  old=$(stty -g)
  trap 'stty "$old"' EXIT INT TERM
  stty -echo
  IFS= read -r key || key=""
  stty "$old"
  trap - EXIT INT TERM
  printf '\n' >&2
else
  # One line; a trailing newline or carriage return from a file is not part of the key.
  IFS= read -r key || [ -n "${key:-}" ] || key=""
  key=$(printf '%s' "$key" | tr -d '\r')
fi

# Linear's personal keys are lin_api_ and 40 letters or digits; nothing else may reach the Keychain.
if ! printf '%s' "$key" | grep -Eq '^lin_api_[A-Za-z0-9]{32,64}$'; then
  echo "linear-key: that does not look like a Linear personal API key (lin_api_ and 40 letters or digits)" >&2
  exit 1
fi

hex=$(printf '%s' "$key" | od -An -v -tx1 | tr -d ' \n')
account=${USER:-$(id -un)}
case "$account" in
  *[!A-Za-z0-9._-]*) echo "linear-key: the account name $account needs quoting this script does not do" >&2; exit 2 ;;
esac
# Its output can repeat the command, hex and all, so none of it is printed.
printf 'add-generic-password -U -s %s -a %s -l %s -X %s\n' "$service" "$account" "$service" "$hex" | security -i >/dev/null 2>&1 || true
hex=""
# security -i exits 0 even when a command fails, so read the item back; an update that failed leaves the old key.
stored=$(security find-generic-password -s "$service" -a "$account" -w 2>/dev/null) || stored=""
same=0
[ "$stored" = "$key" ] && same=1
stored=""
key=""
if [ "$same" != 1 ]; then
  echo "linear-key: the Keychain did not take the key (is the login Keychain locked?)" >&2
  exit 1
fi
echo "linear-key: stored in the login Keychain as service $service, account $account"
