#!/bin/sh
# Done Check 4 (queue half): bw queue binds expect_session at add time, detaches on Stop, waits for
# terminal settle, enforces all 5 safety gates (pending request, prose ?, interruption/error,
# session replacement after /clear or /new), supports resume, and delivers at most once under
# concurrent FolderLock contention.
#   scripts/verify/queue.sh [--offline]
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"

case "${1:-}" in
  ""|--offline) ;;
  *) echo "usage: scripts/verify/queue.sh [--offline]" >&2; exit 2 ;;
esac

root=$(scratch_path "/private/tmp/bw-verify-queue") || exit 1
[ ! -e "$root" ] || scratch_rm "$root"
scratch_make "$root" || exit 1
root=$(cd "$root" && pwd -P)

agent_pid=""
stop_agent() {
  if [ -n "$agent_pid" ] && kill -0 "$agent_pid" 2>/dev/null; then
    kill "$agent_pid" 2>/dev/null || true
    wait "$agent_pid" 2>/dev/null || true
  fi
  agent_pid=""
}
cleanup() {
  stop_agent
  scratch_rm "$root" || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

bw=${BW_BIN:-$src/target/debug/bw}
[ -x "$bw" ] || cargo build --locked -q -p bw --manifest-path "$src/Cargo.toml"
fake_hc="$src/crates/bw/tests/fake-hc"

mkdir -p "$root/gets" "$root/hc-root" "$root/cache" "$root/bin" "$root/home/.local/share/bellwether/helper/current"
ln -s "$bw" "$root/home/.local/share/bellwether/helper/current/bw"

cat > "$root/bin/codex" <<'EOF'
#!/bin/sh
fd=3
for f; do
  eval "exec $fd<\"\$f\""
  fd=$((fd + 1))
done
: > "$READY"
while :; do sleep 1; done
EOF
chmod +x "$root/bin/codex"

sid_a="01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc"
sid_b="01a1b512-1f37-7941-98b2-00c2fc7b72f3"
codex_home="$root/codex-home"
day_dir="$codex_home/sessions/2026/11/06"
mkdir -p "$day_dir" "$codex_home/thread-writer-locks"

rollout_a="$day_dir/rollout-2026-11-06T22-11-05-$sid_a.jsonl"
lock_a="$codex_home/thread-writer-locks/$sid_a.lock"
cp "$src/tests/fixtures/sessions/codex-subagent/rollout-2026-11-06T22-11-05-$sid_a.jsonl" "$rollout_a"
: > "$lock_a"

start_codex() {
  stop_agent
  ready="$root/codex-ready"
  rm -f "$ready"
  CODEX_HOME="$codex_home" READY="$ready" /bin/sh "$root/bin/codex" "$@" </dev/null >/dev/null 2>&1 &
  agent_pid=$!
  i=0
  while [ ! -f "$ready" ] && [ "$i" -lt 100 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  [ -f "$ready" ] || { echo "FAIL fake-codex-start" >&2; exit 1; }
}

write_term() {
  state_word=$1
  cat > "$root/gets/t7.json" <<JSON
{"address":"t7","argv":["codex"],"cwd":"/scratch/codex","pid":$agent_pid,"state":"live","status":{"state":"$state_word"},"foreground":{"argv":["codex"],"name":"codex","pid":$agent_pid}}
JSON
}

run_bw() {
  HOME="$root/home" \
  BW_HC="$fake_hc" \
  FAKE_HC_ROOT="$root/hc-root" \
  FAKE_HC_GET_DIR="$root/gets" \
  FAKE_HC_LOG="$root/hc.log" \
  BW_CACHE_DIR="$root/cache" \
  HC_SESSION="bw-verify-queue" \
  BW_QUEUE_SETTLE_POLL_MS=100 \
  BW_QUEUE_COOLDOWN_MS=800 \
  "$bw" "$@"
}

send_count() {
  if [ ! -f "$root/hc.log" ]; then
    echo 0
    return
  fi
  grep -c '^send t7 ' "$root/hc.log" || true
}

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1: $2" >&2; fail=1; }

# 1. Stop-hook settle delay (1.2 s simulated sibling hook) + 0600 permissions + auto-drain
start_codex "$rollout_a" "$lock_a"
write_term "working"
: > "$root/hc.log"

add1=$(run_bw queue add --terminal t7 --kind codex --text "queued-after-settle")
qfile="$root/cache/queue/bw-verify-queue/t7.json"
qmode=$(stat -f '%Lp' "$qfile")
dmode=$(stat -f '%Lp' "$root/cache/queue/bw-verify-queue")
bound_sid=$(printf '%s' "$add1" | jq -r '.item.expect_session')

(
  sleep 1.2
  write_term "done"
) &
settler=$!

HOME="$root/home" \
BW_HC="$fake_hc" \
FAKE_HC_ROOT="$root/hc-root" \
FAKE_HC_GET_DIR="$root/gets" \
FAKE_HC_LOG="$root/hc.log" \
BW_CACHE_DIR="$root/cache" \
HC_SESSION="bw-verify-queue" \
HC_TERMINAL_ID="t7" \
BW_QUEUE_SETTLE_POLL_MS=100 \
/bin/sh "$src/hooks/bw-event" codex <<JSON
{"hook_event_name":"Stop","session_id":"$sid_a","stop_hook_active":false}
JSON

sleep 0.4
early_sends=$(send_count)
wait "$settler"

i=0
while [ "$(send_count)" -lt 1 ] && [ "$i" -lt 40 ]; do
  sleep 0.1
  i=$((i + 1))
done
after_list=$(run_bw queue list --terminal t7)
if [ "$bound_sid" = "$sid_a" ] && [ "$qmode" = "600" ] && [ "$dmode" = "700" ] &&
   [ "$early_sends" = "0" ] && [ "$(send_count)" = "1" ] &&
   [ "$(printf '%s' "$after_list" | jq -r '.items | length')" = "0" ]; then
  pass "stop-hook-settle-and-auto-drain"
else
  bad "stop-hook-settle-and-auto-drain" "sid=$bound_sid mode=$qmode/$dmode early=$early_sends sends=$(send_count) list=$after_list"
fi

# Wait past post-send cooldown
sleep 0.9

# 2. Gate 3: blocked / pending request leaves item unpopped and unheld
: > "$root/hc.log"
write_term "blocked"
run_bw queue add --terminal t7 --kind codex --text "wait-for-approval" >/dev/null
d_pending=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_pending" | jq -r '[.result,.held,.remaining] | @tsv')" = "pending	false	1" ] &&
   [ "$(send_count)" = "0" ]; then
  pass "gate3-pending-request-unpopped"
else
  bad "gate3-pending-request-unpopped" "drain=$d_pending sends=$(send_count)"
fi

# 3. Gate 4: trailing prose '?' holds with assistant_question, fenced-code '?' passes, and resume delivers
write_term "done"
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:12:00.000Z","ordinal":40,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_q1","role":"assistant","content":[{"type":"output_text","text":"I found two migration paths.\n\nShould I keep backwards compatibility?"}]}}
JSON
d_q=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_q" | jq -r '[.result,.held,.hold_reason,.remaining] | @tsv')" = "held	true	assistant_question	1" ] &&
   [ "$(send_count)" = "0" ]; then
  pass "gate4-prose-question-hold"
else
  bad "gate4-prose-question-hold" "drain=$d_q sends=$(send_count)"
fi

res_q=$(run_bw queue resume --terminal t7)
if [ "$(printf '%s' "$res_q" | jq -r '[.held,(.items | length),.drain.result] | @tsv')" = "false	0	sent" ] &&
   [ "$(send_count)" = "1" ]; then
  pass "resume-acknowledges-question-and-drains"
else
  bad "resume-acknowledges-question-and-drains" "res=$res_q sends=$(send_count)"
fi

sleep 0.9

# Verify '?' inside fenced code block does NOT hold
: > "$root/hc.log"
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:12:10.000Z","ordinal":41,"type":"response_item","payload":{"type":"message","id":"msg_u2","role":"user","content":[{"type":"input_text","text":"continue"}]}}
{"timestamp":"2026-11-07T06:12:12.000Z","ordinal":42,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_a2","role":"assistant","content":[{"type":"output_text","text":"All done:\n```rust\nfn run() -> Result<(), Err> { check()? }\n```"}]}}
JSON
run_bw queue add --terminal t7 --kind codex --text "after-fenced-code" >/dev/null
d_code=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_code" | jq -r '[.result,.held,.remaining] | @tsv')" = "sent	false	0" ] &&
   [ "$(send_count)" = "1" ]; then
  pass "gate4-fenced-code-question-mark-allowed"
else
  bad "gate4-fenced-code-question-mark-allowed" "drain=$d_code sends=$(send_count)"
fi

sleep 0.9

# 4. Gate 4: interrupted turn holds with interrupted_or_error
: > "$root/hc.log"
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:12:20.000Z","ordinal":43,"type":"response_item","payload":{"type":"message","id":"msg_u3","role":"user","content":[{"type":"input_text","text":"deploy"}]}}
{"timestamp":"2026-11-07T06:12:21.000Z","ordinal":44,"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}
JSON
run_bw queue add --terminal t7 --kind codex --text "after-interrupt" >/dev/null
d_int=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_int" | jq -r '[.result,.held,.hold_reason,.remaining] | @tsv')" = "held	true	interrupted_or_error	1" ] &&
   [ "$(send_count)" = "0" ]; then
  pass "gate4-interrupted-turn-hold"
else
  bad "gate4-interrupted-turn-hold" "drain=$d_int sends=$(send_count)"
fi
run_bw queue clear --terminal t7 >/dev/null

# Restore clean turn on rollout_a before testing /new session change
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:12:30.000Z","ordinal":45,"type":"response_item","payload":{"type":"message","id":"msg_u4","role":"user","content":[{"type":"input_text","text":"status"}]}}
{"timestamp":"2026-11-07T06:12:31.000Z","ordinal":46,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_a4","role":"assistant","content":[{"type":"output_text","text":"Clean."}]}}
JSON

# 5. Gate 5: omitted --session binds SID_A, then /new replacement SID_B holds with session_changed
: > "$root/hc.log"
run_bw queue add --terminal t7 --kind codex --text "meant-for-session-a" >/dev/null

rollout_b="$day_dir/rollout-2026-11-06T22-15-00-$sid_b.jsonl"
lock_b="$codex_home/thread-writer-locks/$sid_b.lock"
sed "s/$sid_a/$sid_b/g" "$src/tests/fixtures/sessions/codex-subagent/rollout-2026-11-06T22-11-05-$sid_a.jsonl" > "$rollout_b"
: > "$lock_b"
start_codex "$rollout_b" "$lock_b"
write_term "done"

d_sess=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_sess" | jq -r '[.result,.held,.hold_reason,.remaining] | @tsv')" = "held	true	session_changed	1" ] &&
   [ "$(send_count)" = "0" ]; then
  pass "gate5-session-replacement-hold"
else
  bad "gate5-session-replacement-hold" "drain=$d_sess sends=$(send_count)"
fi

# Resume re-binds to SID_B and delivers once
res_sess=$(run_bw queue resume --terminal t7)
if [ "$(printf '%s' "$res_sess" | jq -r '[.held,(.items | length),.drain.result] | @tsv')" = "false	0	sent" ] &&
   [ "$(send_count)" = "1" ]; then
  pass "resume-rebinds-session-and-drains"
else
  bad "resume-rebinds-session-and-drains" "res=$res_sess sends=$(send_count)"
fi

sleep 0.9

# 6. Edit, move, remove, and concurrent drain single-delivery under FolderLock
: > "$root/hc.log"
i1=$(run_bw queue add --terminal t7 --kind codex --text "first" | jq -r .item.id)
i2=$(run_bw queue add --terminal t7 --kind codex --text "second" | jq -r .item.id)
i3=$(run_bw queue add --terminal t7 --kind codex --text "third" | jq -r .item.id)
run_bw queue edit --terminal t7 --id "$i2" --text "second-edited" >/dev/null
run_bw queue move --terminal t7 --id "$i2" --to 0 >/dev/null
run_bw queue remove --terminal t7 --id "$i3" >/dev/null

FAKE_HC_SEND_SLEEP=0.2 run_bw queue drain --terminal t7 >/dev/null &
p1=$!
FAKE_HC_SEND_SLEEP=0.2 run_bw queue drain --terminal t7 >/dev/null &
p2=$!
wait "$p1"
wait "$p2"

rem_list=$(run_bw queue list --terminal t7)
sent_line=$(grep '^send t7 ' "$root/hc.log" || true)
if [ "$(send_count)" = "1" ] &&
   [ "$sent_line" = "send t7 second-edited" ] &&
   [ "$(printf '%s' "$rem_list" | jq -r '.items | map(.text) | join(",")')" = "first" ]; then
  pass "edit-move-remove-and-concurrent-single-drain"
else
  bad "edit-move-remove-and-concurrent-single-drain" "sends=$(send_count) sent_line=$sent_line rem=$rem_list"
fi

exit "$fail"
