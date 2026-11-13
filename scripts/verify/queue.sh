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
claude_pid=""
sib_pid=""
stop_agent() {
  if [ -n "$agent_pid" ] && kill -0 "$agent_pid" 2>/dev/null; then
    kill "$agent_pid" 2>/dev/null || true
    wait "$agent_pid" 2>/dev/null || true
  fi
  agent_pid=""
}
cleanup() {
  stop_agent
  for p in "$claude_pid" "$sib_pid"; do
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      wait "$p" 2>/dev/null || true
    fi
  done
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
  BW_QUEUE_COOLDOWN_MS="${BW_QUEUE_COOLDOWN_MS:-800}" \
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

# 1. Stop-hook settle delay (1.2 s simulated sibling hook) + 2 queued items + 0600 permissions + auto-drain
start_codex "$rollout_a" "$lock_a"
write_term "working"
: > "$root/hc.log"

add1=$(run_bw queue add --terminal t7 --kind codex --text "queued-after-settle-1")
run_bw queue add --terminal t7 --kind codex --text "queued-after-settle-2" >/dev/null
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
after_list=""
while [ "$i" -lt 60 ]; do
  if [ "$(send_count)" -ge 1 ]; then
    after_list=$(run_bw queue list --terminal t7)
    if [ "$(printf '%s' "$after_list" | jq -r '.items | length')" = "1" ]; then
      break
    fi
  fi
  sleep 0.1
  i=$((i + 1))
done
[ -n "$after_list" ] || after_list=$(run_bw queue list --terminal t7)
sent_first=$(grep '^send t7 ' "$root/hc.log" || true)
rem_first=$(printf '%s' "$after_list" | jq -r '.items[0].text // ""')
if [ "$bound_sid" = "$sid_a" ] && [ "$qmode" = "600" ] && [ "$dmode" = "700" ] &&
   [ "$early_sends" = "0" ] && [ "$(send_count)" = "1" ] &&
   [ "$sent_first" = "send t7 queued-after-settle-1" ] &&
   [ "$rem_first" = "queued-after-settle-2" ]; then
  pass "stop-hook-settle-and-auto-drain"
else
  bad "stop-hook-settle-and-auto-drain" "sid=$bound_sid mode=$qmode/$dmode early=$early_sends sends=$(send_count) sent=$sent_first list=$after_list"
fi
run_bw queue clear --terminal t7 >/dev/null

# Wait past post-send cooldown
sleep 0.9

# 2. Gate 2/3: blocked terminal AND done terminal with pending async question / PermissionRequest leave item unpopped & unheld
: > "$root/hc.log"
write_term "blocked"
run_bw queue add --terminal t7 --kind codex --text "wait-for-approval" >/dev/null
d_blocked=$(run_bw queue drain --terminal t7)

write_term "done"
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:11:48.000Z","ordinal":36,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_perm_1","status":"completed","call_id":"call_perm_1","name":"exec","input":"const r = await tools.exec_command({cmd:\"touch perm-gate3.txt\", sandbox_permissions:\"require_escalated\", justification:\"Allow touch perm-gate3.txt?\"});\ntext(r.output);\n"}}
JSON
printf '{"session_id":"%s","turn_id":"turn_perm_1","transcript_path":"%s","cwd":"/scratch/codex-subagent","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"touch perm-gate3.txt"},"tool_use_id":"exec-perm-gate3-1"}\n' "$sid_a" "$rollout_a" |
  HC_TERMINAL_ID="t7" run_bw event --agent codex
printf '{"session_id":"%s","turn_id":"turn_perm_1","transcript_path":"%s","cwd":"/scratch/codex-subagent","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch perm-gate3.txt","description":"Allow touch perm-gate3.txt?"}}\n' "$sid_a" "$rollout_a" |
  HC_TERMINAL_ID="t7" run_bw event --agent codex
d_perm=$(run_bw queue drain --terminal t7)
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:11:49.000Z","ordinal":36,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_perm_1","call_id":"call_perm_1","output":[{"type":"input_text","text":"Script completed\nOutput:\n"}]}}
{"timestamp":"2026-11-07T06:11:50.000Z","ordinal":37,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_async_q1","name":"request_user_input_async","arguments":"{\"questions\":[{\"title\":\"Which target?\",\"options\":[\"dev\",\"prod\"]}]}","call_id":"call_async_q1"}}
{"timestamp":"2026-11-07T06:11:50.010Z","ordinal":38,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc","turn_id":"turn_async_1","item":{"type":"AgentMessage","id":"call_async_q1","content":[{"type":"Text","text":"Which target?\n- dev\n- prod"}],"phase":"final_answer","delivery":"async","questions":[{"title":"Which target?","options":["dev","prod"]}]}}}
{"timestamp":"2026-11-07T06:11:50.020Z","ordinal":39,"type":"response_item","payload":{"type":"function_call_output","id":"fco_async_q1","call_id":"call_async_q1","output":"{\"accepted\":true}"}}
JSON
d_pending=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_blocked" | jq -r '[.result,.held,.remaining] | @tsv')" = "pending	false	1" ] &&
   [ "$(printf '%s' "$d_perm" | jq -r '[.result,.reason,.held,.remaining] | @tsv')" = "pending	pending_request	false	1" ] &&
   [ "$(printf '%s' "$d_pending" | jq -r '[.result,.reason,.held,.remaining] | @tsv')" = "pending	pending_request	false	1" ] &&
   [ "$(send_count)" = "0" ]; then
  pass "gate3-pending-request-unpopped"
else
  bad "gate3-pending-request-unpopped" "blocked=$d_blocked perm=$d_perm pending=$d_pending sends=$(send_count)"
fi

# Resolve the async question with a user reply turn, then test Gate 4 multi-line prose question
cat >> "$rollout_a" <<'JSON'
{"timestamp":"2026-11-07T06:11:55.000Z","ordinal":40,"type":"response_item","payload":{"type":"message","id":"msg_ans_q1","role":"user","content":[{"type":"input_text","text":"dev"}]}}
{"timestamp":"2026-11-07T06:12:00.000Z","ordinal":41,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_q1","role":"assistant","content":[{"type":"output_text","text":"Which migration path should I take?\n\n1. Keep backwards compatibility (recommended)\n2. Break the API"}]}}
JSON

# 3. Gate 4: multi-line prose '?' (question followed by options) holds with assistant_question, fenced-code '?' passes, and resume delivers
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
{"timestamp":"2026-11-07T06:12:10.000Z","ordinal":42,"type":"response_item","payload":{"type":"message","id":"msg_u2","role":"user","content":[{"type":"input_text","text":"continue"}]}}
{"timestamp":"2026-11-07T06:12:12.000Z","ordinal":43,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_a2","role":"assistant","content":[{"type":"output_text","text":"All done:\n```rust\nfn run() -> Result<(), Err> { check()? }\n```"}]}}
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
{"timestamp":"2026-11-07T06:12:20.000Z","ordinal":44,"type":"response_item","payload":{"type":"message","id":"msg_u3","role":"user","content":[{"type":"input_text","text":"deploy"}]}}
{"timestamp":"2026-11-07T06:12:21.000Z","ordinal":45,"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}
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
{"timestamp":"2026-11-07T06:12:30.000Z","ordinal":46,"type":"response_item","payload":{"type":"message","id":"msg_u4","role":"user","content":[{"type":"input_text","text":"status"}]}}
{"timestamp":"2026-11-07T06:12:31.000Z","ordinal":47,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_a4","role":"assistant","content":[{"type":"output_text","text":"Clean."}]}}
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

# 7. Gate 1 inflight reservation recovery: orphaned inflight_item_id holds with uncertain_delivery instead of re-sending
: > "$root/hc.log"
jq '.inflight_item_id = .items[0].id' "$qfile" > "$qfile.tmp" && mv "$qfile.tmp" "$qfile"
chmod 600 "$qfile"
d_unc=$(run_bw queue drain --terminal t7)
if [ "$(printf '%s' "$d_unc" | jq -r '[.result,.held,.hold_reason,.remaining] | @tsv')" = "held	true	uncertain_delivery	1" ] &&
   [ "$(send_count)" = "0" ]; then
  pass "gate1-inflight-reservation-uncertain-delivery-hold"
else
  bad "gate1-inflight-reservation-uncertain-delivery-hold" "drain=$d_unc sends=$(send_count)"
fi
run_bw queue clear --terminal t7 >/dev/null

# 8. Gate 5 unverified_startup (NoLog -> awaiting_session_log -> sibling session write -> 1-turn transcript -> PID mismatch)
cat > "$root/bin/claude" <<'EOF'
#!/bin/sh
: > "$READY"
while :; do sleep 1; done
EOF
chmod +x "$root/bin/claude"

claude_pid=""
stop_claude() {
  if [ -n "$claude_pid" ] && kill -0 "$claude_pid" 2>/dev/null; then
    kill "$claude_pid" 2>/dev/null || true
    wait "$claude_pid" 2>/dev/null || true
  fi
  claude_pid=""
}
start_claude() {
  stop_claude
  cready="$root/claude-ready"
  rm -f "$cready"
  READY="$cready" /bin/sh "$root/bin/claude" </dev/null >/dev/null 2>&1 &
  claude_pid=$!
  i=0
  while [ ! -f "$cready" ] && [ "$i" -lt 100 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  [ -f "$cready" ] || { echo "FAIL fake-claude-start" >&2; exit 1; }
}

claude_cwd="$root/claude-work"
mkdir -p "$claude_cwd"
enc_cwd=$(printf '%s' "$claude_cwd" | tr '/.' '--')
claude_proj="$root/home/.claude/projects/$enc_cwd"
mkdir -p "$claude_proj"

start_claude
cat > "$root/gets/t8.json" <<JSON
{"address":"t8","argv":["claude"],"cwd":"$claude_cwd","pid":$claude_pid,"state":"live","status":{"state":"done"},"foreground":{"argv":["claude"],"name":"claude","pid":$claude_pid}}
JSON
cat > "$root/hc-root/ls.json" <<'JSON'
{"terminals":[{"address":"t7","state":"live"},{"address":"t8","state":"live"},{"address":"t9","state":"live"}]}
JSON

: > "$root/hc.log"
u_add1=$(FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue add --terminal t8 --kind claude --text "startup-first")
FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue add --terminal t8 --kind claude --text "startup-second" >/dev/null
u_flag=$(printf '%s' "$u_add1" | jq -r '[.item.unverified_startup,(.item.expect_session == null)] | @tsv')

# While NoLog persists, drain waits with awaiting_session_log (never sends into logless terminal)
d_wait=$(FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue drain --terminal t8)

# Sibling session starts and writes output in the same project dir AFTER t8's startup item was queued (must NOT hold t8!)
sid_sib="11111111-2222-4333-8444-555555555555"
cat > "$claude_proj/$sid_sib.jsonl" <<'JSON'
{"isSidechain":false,"type":"user","uuid":"u1","sessionId":"11111111-2222-4333-8444-555555555555","message":{"role":"user","content":"sibling"}}
{"isSidechain":false,"type":"assistant","uuid":"a1","sessionId":"11111111-2222-4333-8444-555555555555","message":{"model":"claude-sonnet","role":"assistant","content":[{"type":"text","text":"Sibling reply."}]}}
JSON
t8_pid=$claude_pid
claude_pid=""
start_claude
sib_pid=$claude_pid
claude_pid=$t8_pid
mkdir -p "$root/home/.claude/sessions"
sib_start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$sib_pid" | sed 's/^ *//;s/ *$//')
cat > "$root/home/.claude/sessions/$sib_pid.json" <<JSON
{"pid":$sib_pid,"sessionId":"$sid_sib","cwd":"$claude_cwd","procStart":"$sib_start"}
JSON
cat > "$root/gets/t9.json" <<JSON
{"address":"t9","argv":["claude"],"cwd":"$claude_cwd","pid":$sib_pid,"state":"live","status":{"state":"working"},"foreground":{"argv":["claude"],"name":"claude","pid":$sib_pid}}
JSON
FAKE_HC_LS="$root/hc-root/ls.json" run_bw feed --terminal t9 >/dev/null

# Now t8 writes its pid session file and initial 1-turn transcript under the same claude_pid
sid_c="22222222-3333-4444-8555-666666666666"
c_start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$claude_pid" | sed 's/^ *//;s/ *$//')
cat > "$root/home/.claude/sessions/$claude_pid.json" <<JSON
{"pid":$claude_pid,"sessionId":"$sid_c","cwd":"$claude_cwd","procStart":"$c_start"}
JSON
cat > "$claude_proj/$sid_c.jsonl" <<'JSON'
{"isSidechain":false,"type":"user","uuid":"u1","sessionId":"22222222-3333-4444-8555-666666666666","message":{"role":"user","content":"init"}}
{"isSidechain":false,"type":"assistant","uuid":"a1","sessionId":"22222222-3333-4444-8555-666666666666","message":{"model":"claude-sonnet","role":"assistant","content":[{"type":"text","text":"Initialized."}]}}
JSON

d_startup=$(FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue drain --terminal t8)
rem_startup=$(FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue list --terminal t8)
sent_t8=$(grep -c '^send t8 startup-first$' "$root/hc.log" || true)

# Restarting t8's agent (new PID) while another unverified_startup item is queued holds with session_changed
FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue clear --terminal t8 >/dev/null
rm -f "$claude_proj/$sid_c.jsonl" "$root/home/.claude/sessions/$claude_pid.json" "$root/cache/feeds/bw-verify-queue/t8.json"
FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue add --terminal t8 --kind claude --text "startup-pid-change" >/dev/null
start_claude
cat > "$root/gets/t8.json" <<JSON
{"address":"t8","argv":["claude"],"cwd":"$claude_cwd","pid":$claude_pid,"state":"live","status":{"state":"done"},"foreground":{"argv":["claude"],"name":"claude","pid":$claude_pid}}
JSON
d_pid=$(BW_QUEUE_COOLDOWN_MS=0 FAKE_HC_LS="$root/hc-root/ls.json" run_bw queue drain --terminal t8)

stop_claude
kill "$sib_pid" 2>/dev/null || true
wait "$sib_pid" 2>/dev/null || true

if [ "$u_flag" = "true	true" ] &&
   [ "$(printf '%s' "$d_wait" | jq -r '[.result,.reason,.held] | @tsv')" = "pending	awaiting_session_log	false" ] &&
   [ "$(printf '%s' "$d_startup" | jq -r '[.result,.held,.remaining] | @tsv')" = "sent	false	1" ] &&
   [ "$(printf '%s' "$rem_startup" | jq -r '[.items[0].expect_session,.items[0].unverified_startup] | @tsv')" = "$sid_c	false" ] &&
   [ "$sent_t8" = "1" ] &&
   [ "$(printf '%s' "$d_pid" | jq -r '[.result,.held,.hold_reason] | @tsv')" = "held	true	session_changed" ]; then
  pass "gate5-unverified-startup-nolog-sibling-and-pid-guard"
else
  bad "gate5-unverified-startup-nolog-sibling-and-pid-guard" "flag=$u_flag wait=$d_wait startup=$d_startup rem=$rem_startup sent=$sent_t8 pid=$d_pid"
fi

# 9. Atomic bw queue send under FolderLock: pops item on sent, returns already-sent without duplicate delivery, and retains item on refused-conversation
: > "$root/hc.log"
qs1=$(run_bw queue add --terminal t7 --kind codex --text "send-now-item" | jq -r .item.id)
qs2=$(run_bw queue add --terminal t7 --kind codex --text "keep-queued-item" | jq -r .item.id)
refused_out=$(run_bw queue send --terminal t7 --id "$qs1" --expect-kind codex --expect-session "wrong-session" --expect-path "$rollout_b")
sent_out=$(run_bw queue send --terminal t7 --id "$qs1" --expect-kind codex --expect-session "$sid_b" --expect-path "$rollout_b")
dup_out=$(run_bw queue send --terminal t7 --id "$qs1" --expect-kind codex --expect-session "$sid_b" --expect-path "$rollout_b")
if [ "$(printf '%s' "$refused_out" | jq -rs '[.[0].result, (.[1].items | length)] | @tsv')" = "refused-conversation	2" ] &&
   [ "$(printf '%s' "$sent_out" | jq -rs '[.[0].result, (.[1].items | map(.id) | join(","))] | @tsv')" = "sent	$qs2" ] &&
   [ "$(printf '%s' "$dup_out" | jq -rs '[.[0].result, (.[1].items | map(.id) | join(","))] | @tsv')" = "already-sent	$qs2" ] &&
   [ "$(send_count)" = "1" ]; then
  pass "atomic-queue-send-and-pop"
else
  bad "atomic-queue-send-and-pop" "refused=$refused_out sent=$sent_out dup=$dup_out sends=$(send_count)"
fi

exit "$fail"
