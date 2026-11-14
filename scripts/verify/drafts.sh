#!/bin/sh
# Done Check 5(d): bw drafts lists nested HTML, root tasks.md, 6-column decisions.tsv (log.sh),
# .audit/*.tsv, and external mktemp -d ledger.md; rejects sibling transcripts, symlink escapes,
# and path traversal; and stages local/remote HTML at 0600 inside 0700 with 32-entry LRU pruning.
#   scripts/verify/drafts.sh [--offline]
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH
. "$src/scripts/verify/lib-scratch.sh"

case "${1:-}" in
  ""|--offline) ;;
  *) echo "usage: scripts/verify/drafts.sh [--offline]" >&2; exit 2 ;;
esac

root=$(scratch_path "/private/tmp/bw-verify-drafts") || exit 1
[ ! -e "$root" ] || scratch_rm "$root"
scratch_make "$root" || exit 1
ext_run=$(mktemp -d "${TMPDIR:-/tmp}/bw-verify-ledger.XXXXXX")
cleanup() {
  rm -rf "$ext_run" || true
  scratch_rm "$root" || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

bw=${BW_BIN:-$src/target/debug/bw}
[ -x "$bw" ] || cargo build --locked -q -p bw --manifest-path "$src/Cargo.toml"

wt="$root/wt"
cache="$root/cache"
state="$root/state"
mkdir -p "$wt/docs/drafts/sub" "$wt/docs/plans" "$wt/.audit" "$cache" "$state"

cat > "$wt/docs/drafts/sub/page.html" <<'HTML'
<!doctype html>
<html><head><title>Draft Cockpit</title></head><body><h1>Draft Cockpit</h1></body></html>
HTML

cat > "$wt/tasks.md" <<'MD'
# Tasks
- [x] Build bw pr
- [ ] Build bw drafts
MD

cat > "$wt/docs/plans/2026-11-13-sample-plan.md" <<'MD'
# Sample Plan
- [x] Step 1
MD

cat > "$wt/.audit/run.tsv" <<'TSV'
ts	phase	decision	why	evidence	result
2026-11-13T10:00:00Z	verify	check	ensure offline	scripts/verify/drafts.sh	pass
TSV

log_sh="$HOME/.agents/skills/show-me-your-work/scripts/log.sh"
if [ -x "$log_sh" ]; then
  "$log_sh" "$wt/decisions.tsv" implement "add bw drafts" "read-only inspector" "crates/bw/src/drafts/mod.rs" ok
else
  cat > "$wt/decisions.tsv" <<'TSV'
ts	phase	decision	why	evidence	result
2026-11-13T10:05:00Z	implement	add bw drafts	read-only inspector	crates/bw/src/drafts/mod.rs	ok
TSV
fi

printf 'SECRET=1\n' > "$wt/.env"
printf 'OUTSIDE=1\n' > "$root/outside.md"
ln -s "$root/outside.md" "$wt/docs/drafts/escape.md"
ln -s "../../.env" "$wt/docs/plans/local-plan.md"
ln -s "../../.env" "$wt/docs/drafts/secret.html"

canon_wt=$(cd "$wt" && pwd -P)
cat > "$ext_run/ledger.md" <<EOF
# Independent Review Ledger
Target worktree: \`$canon_wt\`
- [P2] Sample verified finding
EOF
printf 'raw confidential transcript\n' > "$ext_run/report-sol.txt"
printf '{"secret":true}\n' > "$ext_run/transcript.jsonl"

mkdir -p "$root/registered-review"
cat > "$root/registered-review/ledger.md" <<'EOF'
# Registered External Ledger
Confirmed: 0
EOF

bwd() {
  BW_CACHE_DIR="$cache" BW_STATE_DIR="$state" "$bw" drafts "$@"
}

# 1. Register external ledger outside $TMPDIR and list all worktree + external entries.
reg_json=$(bwd register-ledger --path "$wt" --ledger "$root/registered-review/ledger.md")
LIST_OUT=$(bwd list --path "$wt")

REG_JSON="$reg_json" LIST_OUT="$LIST_OUT" bun -e '
  const reg = JSON.parse(process.env.REG_JSON);
  if (reg.type !== "ledger-registered" || !reg.id.startsWith("ledger:")) {
    throw new Error("bad register-ledger output: " + process.env.REG_JSON);
  }
  const rows = process.env.LIST_OUT.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (byId.get("docs/drafts/sub/page.html")?.kind !== "html") throw new Error("missing nested html");
  if (byId.get("tasks.md")?.kind !== "plan") throw new Error("missing root tasks.md");
  if (byId.get("docs/plans/2026-11-13-sample-plan.md")?.kind !== "plan") throw new Error("missing plan.md");
  if (byId.get("decisions.tsv")?.kind !== "decisions") throw new Error("missing decisions.tsv");
  if (byId.get(".audit/run.tsv")?.kind !== "decisions") throw new Error("missing .audit/run.tsv");
  if (
    byId.has("docs/drafts/escape.md") ||
    byId.has("docs/plans/local-plan.md") ||
    byId.has("docs/drafts/secret.html") ||
    byId.has(".env")
  ) {
    throw new Error("leaked disallowed file");
  }
  const ledgers = rows.filter((r) => r.kind === "ledger");
  if (ledgers.length < 2) throw new Error("expected both $TMPDIR and registered ledgers, got " + ledgers.length);
  if (!byId.has(reg.id)) throw new Error("missing registered ledger id");
'
echo "PASS drafts-list-and-external-ledger-discovery"

# 2. Read 6-column decisions.tsv and allow-listed external ledger.
DEC_READ=$(bwd read --path "$wt" --file "decisions.tsv")
TMP_LEDGER_ID=$(LIST_OUT="$LIST_OUT" REG_JSON="$reg_json" bun -e '
  const reg = JSON.parse(process.env.REG_JSON);
  const rows = process.env.LIST_OUT.trim().split("\n").map((l) => JSON.parse(l));
  const tmpLedger = rows.find((r) => r.kind === "ledger" && r.id !== reg.id);
  if (!tmpLedger) throw new Error("missing tmpdir ledger");
  process.stdout.write(tmpLedger.id);
')
LED_READ=$(bwd read --path "$wt" --file "$TMP_LEDGER_ID")

DEC_READ="$DEC_READ" LED_READ="$LED_READ" bun -e '
  const dec = JSON.parse(process.env.DEC_READ);
  if (dec.type !== "draft-read" || dec.kind !== "decisions") throw new Error("bad decisions read");
  const header = dec.text.split("\n")[0];
  if (header !== "ts\tphase\tdecision\twhy\tevidence\tresult") {
    throw new Error("unexpected 6-column header: " + JSON.stringify(header));
  }
  const led = JSON.parse(process.env.LED_READ);
  if (led.type !== "draft-read" || led.kind !== "ledger" || !led.text.includes("Independent Review Ledger")) {
    throw new Error("bad external ledger read");
  }
'
echo "PASS drafts-read-6col-decisions-and-external-ledger"

# 3. Strictly reject sibling raw transcripts, symlink escapes, internal non-allowlisted symlinks, traversal, and .env.
for bad_target in \
  "$ext_run/report-sol.txt" \
  "$ext_run/transcript.jsonl" \
  "docs/drafts/escape.md" \
  "docs/plans/local-plan.md" \
  "docs/drafts/secret.html" \
  "../outside.md" \
  ".env"
do
  if err_out=$(bwd read --path "$wt" --file "$bad_target" 2>/dev/null); then
    echo "FAIL expected read rejection for $bad_target, got: $err_out" >&2
    exit 1
  fi
done
if err_out=$(bwd read --path "$wt" --file "docs/drafts/secret.html" --stage 2>/dev/null); then
  echo "FAIL expected --stage rejection for docs/drafts/secret.html, got: $err_out" >&2
  exit 1
fi
if bwd register-ledger --path "$wt" --ledger "$ext_run/report-sol.txt" >/dev/null 2>&1; then
  echo "FAIL expected register-ledger rejection for report-sol.txt" >&2
  exit 1
fi
echo "PASS drafts-rejects-sibling-transcripts-and-escapes"

# 4. Stage HTML from local worktree, stdin, and remote --machine relay via fake hc.
fake_hc="$root/fake-hc"
cat > "$fake_hc" <<EOF
#!/bin/sh
set -eu
# Simulate: hc exec --json --on=remotebox --timeout=60 -- sh -c '<RUN_HELPER>' bw drafts read ...
shift 5 # exec --json --on=... --timeout=... --
shift 4 # sh -c <RUN_HELPER> bw
set +e
raw_out=\$(BW_CACHE_DIR="$cache" BW_STATE_DIR="$state" "$bw" "\$@")
rc=\$?
set -e
b64=\$(printf '%s\n' "\$raw_out" | base64 | tr -d '\n')
printf '{"code":%d,"stdout":"%s","timed_out":false,"truncated":false}\n' "\$rc" "\$b64"
EOF
chmod +x "$fake_hc"

STAGED_LOCAL=$(bwd stage --name local-page.html --path "$wt" --file "docs/drafts/sub/page.html")
STAGED_REMOTE=$(BW_HC="$fake_hc" BW_CACHE_DIR="$cache" BW_STATE_DIR="$state" \
  "$bw" drafts stage --name remote-page.html --machine remotebox --path "$wt" --file "docs/drafts/sub/page.html")
STAGED_STDIN=$(printf '<!doctype html><h1>Stdin</h1>' | bwd stage --name stdin-page.html)

STAGED_LOCAL="$STAGED_LOCAL" STAGED_REMOTE="$STAGED_REMOTE" STAGED_STDIN="$STAGED_STDIN" CACHE_DIR="$cache" bun -e '
  import { statSync, readFileSync } from "node:fs";
  const l = JSON.parse(process.env.STAGED_LOCAL);
  const r = JSON.parse(process.env.STAGED_REMOTE);
  const s = JSON.parse(process.env.STAGED_STDIN);
  for (const item of [l, r, s]) {
    if (item.type !== "draft-staged" || !item.url.startsWith("file:///")) {
      throw new Error("bad staged output: " + JSON.stringify(item));
    }
    const mode = statSync(item.path).mode & 0o777;
    if (mode !== 0o600) throw new Error("expected 0600 staged file, got " + mode.toString(8));
  }
  const dirMode = statSync(process.env.CACHE_DIR + "/drafts-stage").mode & 0o777;
  if (dirMode !== 0o700) throw new Error("expected 0700 stage dir, got " + dirMode.toString(8));
  if (!readFileSync(r.path, "utf8").includes("Draft Cockpit")) throw new Error("remote staged content mismatch");
'
echo "PASS drafts-stage-local-stdin-and-remote-machine"
