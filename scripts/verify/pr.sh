#!/bin/sh
# Done Check 4 (PR half): bw pr status caches GraphQL replies at 0600, handles APPROVED and null
# reviewDecision, invalidates on --head or --refresh, rejects malformed/flag args, and serves stale
# cache entries when gh is missing, unauthenticated, or offline.
#   scripts/verify/pr.sh [--offline]
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"

offline=0
case "${1:-}" in
  "") ;;
  --offline) offline=1 ;;
  *) echo "usage: scripts/verify/pr.sh [--offline]" >&2; exit 2 ;;
esac

root=$(scratch_path "/private/tmp/bw-verify-pr") || exit 1
[ ! -e "$root" ] || scratch_rm "$root"
scratch_make "$root" || exit 1
cleanup() { scratch_rm "$root" || true; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

bw=${BW_BIN:-$src/target/debug/bw}
[ -x "$bw" ] || cargo build --locked -q -p bw --manifest-path "$src/Cargo.toml"

cache="$root/cache"
fake_gh="$root/fake-gh"
calls="$root/calls.log"
mode_file="$root/mode"

cat > "$fake_gh" <<'EOF'
#!/bin/sh
set -eu
printf 'call\n' >> "$FAKE_GH_CALLS"
mode=$(cat "$FAKE_GH_MODE")
case "$mode" in
  approved)
    cat <<'JSON'
{"data":{"repository":{"open":{"nodes":[{"number":42,"title":"feat: cockpit","url":"https://github.com/dkishore/bellwether/pull/42","state":"OPEN","isDraft":false,"baseRefName":"main","headRefOid":"1111111111111111111111111111111111111111","reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","reviewThreads":{"totalCount":1,"nodes":[{"isResolved":true}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"totalCount":2,"nodes":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"StatusContext","state":"SUCCESS"}]}}}}]}}]},"closed":{"nodes":[]}}}}
JSON
    ;;
  solo_null)
    cat <<'JSON'
{"data":{"repository":{"open":{"nodes":[{"number":43,"title":"feat: solo pr","url":"https://github.com/dkishore/bellwether/pull/43","state":"OPEN","isDraft":false,"baseRefName":"main","headRefOid":"2222222222222222222222222222222222222222","reviewDecision":null,"mergeStateStatus":"CLEAN","reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"totalCount":1,"nodes":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}}}}]}}]},"closed":{"nodes":[]}}}}
JSON
    ;;
  changes_failing_draft)
    cat <<'JSON'
{"data":{"repository":{"open":{"nodes":[{"number":44,"title":"wip: draft","url":"https://github.com/dkishore/bellwether/pull/44","state":"OPEN","isDraft":true,"baseRefName":"main","headRefOid":"3333333333333333333333333333333333333333","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"BLOCKED","reviewThreads":{"totalCount":2,"nodes":[{"isResolved":false},{"isResolved":true}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"totalCount":2,"nodes":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"},{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":null}]}}}}]}}]},"closed":{"nodes":[]}}}}
JSON
    ;;
  offline)
    echo 'Post "https://api.github.com/graphql": dial tcp: i/o timeout' >&2
    exit 1
    ;;
  unauth)
    echo 'To get started with GitHub CLI, please run:  gh auth login' >&2
    exit 4
    ;;
esac
EOF
chmod +x "$fake_gh"

run_pr() {
  BW_CACHE_DIR="$cache" BW_GH_BIN="$fake_gh" FAKE_GH_CALLS="$calls" FAKE_GH_MODE="$mode_file" "$bw" pr "$@"
}

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1: $2" >&2; fail=1; }

# 1. APPROVED open PR + 0600 cache hit
printf 'approved' > "$mode_file"
: > "$calls"
out1=$(run_pr status --repo dkishore/bellwether --branch feat/cockpit --head 1111111111111111111111111111111111111111)
out2=$(run_pr status --repo dkishore/bellwether --branch feat/cockpit --head 1111111111111111111111111111111111111111)
n_calls=$(wc -l < "$calls" | tr -d ' ')
if [ "$(printf '%s' "$out1" | jq -r '[.type,.cached,.stale,.pr.number,.pr.reviewDecision,.pr.passing,.pr.failing,.pr.unresolvedThreads] | @tsv')" = "pr	false	false	42	APPROVED	2	0	0" ] &&
   [ "$(printf '%s' "$out2" | jq -r '[.cached,.stale,.pr.number] | @tsv')" = "true	false	42" ] &&
   [ "$n_calls" = "1" ]; then
  pass "approved-and-ttl-cache"
else
  bad "approved-and-ttl-cache" "out1=$out1 out2=$out2 calls=$n_calls"
fi

# 2. --head mismatch invalidates cache and solo null reviewDecision parses cleanly
printf 'solo_null' > "$mode_file"
out3=$(run_pr status --repo dkishore/bellwether --branch feat/cockpit --head 2222222222222222222222222222222222222222)
if [ "$(printf '%s' "$out3" | jq -r '[.cached,.stale,.pr.number,(.pr.reviewDecision == null),.pr.passing,.pr.failing,.pr.unresolvedThreads] | @tsv')" = "false	false	43	true	1	0	0" ]; then
  pass "solo-null-review-decision-and-head-invalidation"
else
  bad "solo-null-review-decision-and-head-invalidation" "out3=$out3"
fi

# 3. Offline / unauthenticated / missing gh serve stale cache when cached, and typed error when uncached
printf 'offline' > "$mode_file"
out4=$(run_pr status --repo dkishore/bellwether --branch feat/cockpit --refresh)
out5=$(BW_CACHE_DIR="$cache" BW_GH_BIN="$root/does-not-exist" "$bw" pr status --repo dkishore/bellwether --branch feat/cockpit --refresh)
if [ "$(printf '%s' "$out4" | jq -r '[.cached,.stale,.pr.number] | @tsv')" = "true	true	43" ] &&
   [ "$(printf '%s' "$out5" | jq -r '[.cached,.stale,.pr.number] | @tsv')" = "true	true	43" ]; then
  pass "stale-cache-fallback"
else
  bad "stale-cache-fallback" "out4=$out4 out5=$out5"
fi

set +e
err_unauth=$(printf 'unauth' > "$mode_file"; run_pr status --repo dkishore/bellwether --branch feat/uncached)
code_unauth=$?
err_nogh=$(BW_CACHE_DIR="$cache" BW_GH_BIN="$root/does-not-exist" "$bw" pr status --repo dkishore/bellwether --branch feat/uncached)
code_nogh=$?
err_flag=$(run_pr status --repo dkishore/bellwether --branch --evil)
code_flag=$?
err_repo=$(run_pr status --repo https://gitlab.com/a/b --branch main)
code_repo=$?
set -e
if [ "$code_unauth" = 1 ] && [ "$(printf '%s' "$err_unauth" | jq -r .code)" = "unauthenticated" ] &&
   [ "$code_nogh" = 1 ] && [ "$(printf '%s' "$err_nogh" | jq -r .code)" = "no_gh" ] &&
   [ "$code_flag" = 2 ] && [ "$code_repo" = 2 ]; then
  pass "uncached-errors-and-validation"
else
  bad "uncached-errors-and-validation" "unauth=$code_unauth/$err_unauth nogh=$code_nogh/$err_nogh flag=$code_flag repo=$code_repo"
fi

# 4. CHANGES_REQUESTED, failing CI, pending check, unresolved thread, and draft flags
printf 'changes_failing_draft' > "$mode_file"
out6=$(run_pr status --repo dkishore/bellwether --branch feat/draft)
if [ "$(printf '%s' "$out6" | jq -r '[.pr.number,.pr.isDraft,.pr.reviewDecision,.pr.failing,.pr.pending,.pr.unresolvedThreads] | @tsv')" = "44	true	CHANGES_REQUESTED	1	1	1" ]; then
  pass "changes-requested-failing-draft"
else
  bad "changes-requested-failing-draft" "out6=$out6"
fi

# 5. Live gh check when online
if [ "$offline" = 0 ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    live_out=$(BW_CACHE_DIR="$cache" "$bw" pr status --repo cli/cli --branch trunk)
    if [ "$(printf '%s' "$live_out" | jq -r .type)" = "pr" ]; then
      pass "live-gh-graphql"
    else
      bad "live-gh-graphql" "live_out=$live_out"
    fi
  else
    echo "OWED live-gh-graphql: gh is missing or unauthenticated"
  fi
fi

exit "$fail"
