#!/bin/sh
# Live stage-window verification for the Bellwether UI and Cockpit refinement (Done Checks 1-6).
#   scripts/verify/ui-stage.sh [--shots-dir <dir>]
# Runs exclusively inside scripts/verify/stage.sh (/private/tmp/bw-stage, HC_SESSION=bw-stage) so
# the user's live ~/.config/herdr-app is never touched. Headless suites skip this window script.
set -eu

src=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
. "$src/scripts/verify/lib-scratch.sh"

SHOTS="/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/shots"
LEDGER_DEFAULT="/Users/dkishore/.t3/userdata/antigravity-tmp/ac0a3dfd6ddd/run-PYiUVm/bw-wave1-review.ONzm2c/ledger.md"
LEDGER="${BW_VERIFY_LEDGER:-$LEDGER_DEFAULT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --shots-dir) SHOTS=${2:?--shots-dir needs a path}; shift 2 ;;
    *) echo "usage: scripts/verify/ui-stage.sh [--shots-dir <dir>]" >&2; exit 2 ;;
  esac
done

[ "$(uname)" = Darwin ] || { echo "FAIL macOS required" >&2; exit 1; }
for c in cc bun node jq python3 osascript cliclick herdr-app hc gh cargo; do
  command -v "$c" >/dev/null 2>&1 || { echo "FAIL missing tool: $c" >&2; exit 1; }
done

STAGE="$src/scripts/verify/stage.sh"
D="/private/tmp/bw-stage"
W="/private/tmp/bw-ui-stage"
mkdir -p "$SHOTS"

failed=0
pass() { echo "PASS $1: $2"; }
bad() { echo "FAIL $1: $2"; failed=1; }

herdr_home_state() {
  target="$HOME/.config/herdr-app"
  if [ ! -e "$target" ]; then
    echo "ABSENT"
    return
  fi
  find "$target" -path "$target/telemetry" -prune -o -type f -print 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    shasum -a 256 "$f"
  done
}

before_herdr_home=$(herdr_home_state)

cleanup() {
  rc=$?
  set +e
  sh "$STAGE" down >/dev/null 2>&1 || true
  if [ -d "$W" ]; then
    for sub in cockpit-demo api-worker; do
      slug=$(printf '%s' "$W/$sub" | sed 's/[^A-Za-z0-9]/-/g')
      rm -rf "$HOME/.claude/projects/$slug" "/private/tmp/claude-$(id -u)/$slug" 2>/dev/null || true
    done
    scratch_rm "$W" >/dev/null 2>&1 || rm -rf "$W" 2>/dev/null || true
  fi
  after_herdr_home=$(herdr_home_state)
  if [ "$after_herdr_home" != "$before_herdr_home" ]; then
    echo "FAIL herdr-home: ~/.config/herdr-app changed during stage verification" >&2
    exit 1
  fi
  [ "$rc" -eq 0 ] && exit "$failed"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Keep macOS CVDisplayLink active if the display dimmed while idle; exits automatically with this script PID.
caffeinate -u -w "$$" >/dev/null 2>&1 </dev/null &
sleep 0.6

is_screen_locked() {
  osascript -l JavaScript -e 'function run() {
    ObjC.import("CoreGraphics");
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
    return list.some((w) => w.kCGWindowOwnerName === "loginwindow" && w.kCGWindowLayer >= 1000) ? "1" : "0";
  }'
}

if [ "$(is_screen_locked)" = "1" ]; then
  echo "FAIL screen-locked: macOS loginwindow screen lock is active; unlock the display before running ui-stage.sh" >&2
  exit 1
fi

[ -e "$D" ] && sh "$STAGE" down >/dev/null 2>&1 || true
[ -e "$W" ] && { scratch_rm "$W" || rm -rf "$W"; }
scratch_make "$W"

echo "==> Building release bw 0.8.0"
cargo build --release --locked -q -p bw --manifest-path "$src/Cargo.toml"
BW="$src/target/release/bw"

# Zero-dependency PNG RGBA decoder, region sampler, motion-box differ, and colour locator in Bun.
cat > "$W/pixels.js" << 'JS'
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function readPng(file) {
  const buf = readFileSync(file);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error(`not a PNG: ${file}`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG depth=${depth} colorType=${colorType}`);
      }
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const rgb = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const curr = new Uint8Array(stride);
  let srcOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[srcOff++];
    for (let i = 0; i < stride; i++) {
      const x = raw[srcOff++];
      const a = i >= bpp ? curr[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = x;
      if (filter === 1) v = (x + a) & 255;
      else if (filter === 2) v = (x + b) & 255;
      else if (filter === 3) v = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (x + paeth(a, b, c)) & 255;
      curr[i] = v;
    }
    prev.set(curr);
    let dst = y * width * 3;
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      rgb[dst++] = curr[s];
      rgb[dst++] = curr[s + 1];
      rgb[dst++] = curr[s + 2];
    }
  }
  return { width, height, rgb };
}

function hexRgb(h) {
  const s = h.startsWith("#") ? h.slice(1) : h;
  return [Number.parseInt(s.slice(0, 2), 16), Number.parseInt(s.slice(2, 4), 16), Number.parseInt(s.slice(4, 6), 16)];
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function close(a, b, tol = 2) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

function dominant(im, x0, y0, x1, y1) {
  const counts = new Map();
  const ax0 = Math.max(0, Math.floor(x0));
  const ay0 = Math.max(0, Math.floor(y0));
  const ax1 = Math.min(im.width, Math.ceil(x1));
  const ay1 = Math.min(im.height, Math.ceil(y1));
  for (let y = ay0; y < ay1; y++) {
    for (let x = ax0; x < ax1; x++) {
      const i = (y * im.width + x) * 3;
      const k = (im.rgb[i] << 16) | (im.rgb[i + 1] << 8) | im.rgb[i + 2];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let bestK = 0;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestK = k;
      bestN = n;
    }
  }
  return [(bestK >> 16) & 255, (bestK >> 8) & 255, bestK & 255];
}

function hasColor(im, x0, y0, x1, y1, wantHex, tol = 2) {
  const want = hexRgb(wantHex);
  const ax0 = Math.max(0, Math.floor(x0));
  const ay0 = Math.max(0, Math.floor(y0));
  const ax1 = Math.min(im.width, Math.ceil(x1));
  const ay1 = Math.min(im.height, Math.ceil(y1));
  let hits = 0;
  for (let y = ay0; y < ay1; y++) {
    for (let x = ax0; x < ax1; x++) {
      const i = (y * im.width + x) * 3;
      if (close([im.rgb[i], im.rgb[i + 1], im.rgb[i + 2]], want, tol)) hits++;
    }
  }
  return hits;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "dominant") {
  const [file, lw, x0, y0, x1, y1] = args;
  const im = readPng(file);
  const scale = im.width / Number(lw);
  const rgb = dominant(im, Number(x0) * scale, Number(y0) * scale, Number(x1) * scale, Number(y1) * scale);
  console.log(JSON.stringify({ hex: toHex(rgb), rgb, scale, width: im.width, height: im.height }));
} else if (cmd === "palette-check") {
  const [file, lw] = args;
  const im = readPng(file);
  const s = im.width / Number(lw);
  const sidebar = dominant(im, 24 * s, 450 * s, 210 * s, 820 * s);
  const work = dominant(im, 252 * s, 120 * s, 290 * s, 700 * s);
  const tabsField = dominant(im, 560 * s, 6 * s, 740 * s, 42 * s);
  const capsuleHits = hasColor(im, 250 * s, 6 * s, 540 * s, 42 * s, "#272738", 3);
  const crustInWork = hasColor(im, 252 * s, 52 * s, 840 * s, 920 * s, "#11111b", 1);
  // Check monogram area in sidebar (top-left of project headers, x=18..48, y=70..260): zero warm/green rainbow pixels.
  let rainbow = 0;
  for (let y = Math.floor(70 * s); y < Math.ceil(260 * s); y++) {
    for (let x = Math.floor(18 * s); x < Math.ceil(48 * s); x++) {
      const i = (y * im.width + x) * 3;
      const r = im.rgb[i], g = im.rgb[i + 1], b = im.rgb[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min > 35 && (r > b + 20 || g > b + 20)) {
        rainbow++;
      }
    }
  }
  const res = {
    sidebar: toHex(sidebar),
    work: toHex(work),
    tabsField: toHex(tabsField),
    capsuleHits,
    crustInWork,
    rainbowMonogramPixels: rainbow,
    ok:
      close(sidebar, hexRgb("#181825"), 2) &&
      close(work, hexRgb("#1e1e2e"), 2) &&
      close(tabsField, hexRgb("#1e1e2e"), 2) &&
      capsuleHits > 50 &&
      crustInWork === 0 &&
      rainbow === 0,
  };
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
} else if (cmd === "find-color") {
  const [file, lw, wantHex, tol, x0, y0, x1, y1, minRowStr] = args;
  const im = readPng(file);
  const s = im.width / Number(lw);
  const want = hexRgb(wantHex);
  const t = Number(tol);
  const minRow = minRowStr ? Number(minRowStr) : Math.max(1, Math.round(s));
  let sumX = 0, sumY = 0, count = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  let bandEndY = -1;
  for (let y = Math.floor(Number(y0) * s); y < Math.ceil(Number(y1) * s); y++) {
    let rowHits = 0, rowSumX = 0, rowMinX = 1e9, rowMaxX = -1;
    for (let x = Math.floor(Number(x0) * s); x < Math.ceil(Number(x1) * s); x++) {
      const i = (y * im.width + x) * 3;
      if (close([im.rgb[i], im.rgb[i + 1], im.rgb[i + 2]], want, t)) {
        rowHits++;
        rowSumX += x;
        if (x < rowMinX) rowMinX = x;
        if (x > rowMaxX) rowMaxX = x;
      }
    }
    if (bandEndY < 0 && rowHits >= minRow) {
      bandEndY = y + Math.ceil(18 * s);
    }
    if (bandEndY >= 0 && y <= bandEndY && rowHits > 0) {
      sumX += rowSumX;
      sumY += y * rowHits;
      count += rowHits;
      if (rowMinX < minX) minX = rowMinX;
      if (y < minY) minY = y;
      if (rowMaxX > maxX) maxX = rowMaxX;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) {
    console.log(JSON.stringify({ found: false, count: 0 }));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      found: true,
      count,
      logicalX: Math.round(sumX / count / s),
      logicalY: Math.round(sumY / count / s),
      logicalBox: [Math.floor(minX / s), Math.floor(minY / s), Math.ceil(maxX / s), Math.ceil(maxY / s)],
    }),
  );
} else if (cmd === "burst-diff") {
  const [dir, prefix, countStr, lw, allowedJson] = args;
  const n = Number(countStr);
  const allowed = allowedJson ? JSON.parse(allowedJson) : [];
  const base = readPng(`${dir}/${prefix}-0.png`);
  const s = base.width / Number(lw);
  const scaledAllowed = allowed.map(([x0, y0, x1, y1]) => [
    Math.floor(x0 * s),
    Math.floor(y0 * s),
    Math.ceil(x1 * s),
    Math.ceil(y1 * s),
  ]);
  let changedTotal = 0;
  let outsideTotal = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  const mask = new Uint8Array(base.width * base.height);
  for (let k = 1; k < n; k++) {
    const cur = readPng(`${dir}/${prefix}-${k}.png`);
    for (let p = 0; p < mask.length; p++) {
      const i = p * 3;
      if (
        base.rgb[i] !== cur.rgb[i] ||
        base.rgb[i + 1] !== cur.rgb[i + 1] ||
        base.rgb[i + 2] !== cur.rgb[i + 2]
      ) {
        mask[p] = 1;
      }
    }
  }
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      if (!mask[y * base.width + x]) continue;
      changedTotal++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const inside = scaledAllowed.some(([ax0, ay0, ax1, ay1]) => x >= ax0 && x <= ax1 && y >= ay0 && y <= ay1);
      if (!inside) outsideTotal++;
    }
  }
  const logicalBbox =
    changedTotal > 0 ? [Math.floor(minX / s), Math.floor(minY / s), Math.ceil(maxX / s), Math.ceil(maxY / s)] : null;
  console.log(JSON.stringify({ changedTotal, outsideTotal, logicalBbox }));
}
JS

# Native Mach-O codex and claude stubs so herdr-core mapper sees real foreground process names ("codex", "claude"),
# proc_pidinfo sees each process's open .jsonl descriptor, and hc parses colon-separated OSC 7501 reports.
mkdir -p "$W/bin" "$W/codex-home/sessions/2026/11/06" "$W/codex-home/thread-writer-locks" "$W/claude-cfg/sessions"

cat > "$W/agent-stub.c" << 'C_EOF'
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void print_crlf(const char *s) {
    for (const char *p = s; *p; p++) {
        if (*p == '\n') fputc('\r', stdout);
        fputc(*p, stdout);
    }
    fputs("\r\n", stdout);
}

int main(int argc, char **argv) {
    if (argc < 4) return 2;
    const char *app = argv[1];
    const char *log_path = argv[2];
    const char *ctrl_path = argv[3];

    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) strcpy(cwd, ".");

    const char *cfg = getenv("CLAUDE_CONFIG_DIR");
    const char *sid = getenv("FAKE_CLAUDE_SID");
    if (cfg && *cfg && sid && *sid) {
        char sdir[PATH_MAX], sfile[PATH_MAX], cmd[128], lstart[128];
        lstart[0] = '\0';
        snprintf(cmd, sizeof(cmd), "TZ=UTC LC_ALL=C ps -o lstart= -p %d", (int)getpid());
        FILE *ps = popen(cmd, "r");
        if (ps) {
            if (fgets(lstart, sizeof(lstart), ps)) {
                size_t len = strlen(lstart);
                while (len > 0 && (lstart[len - 1] == '\n' || lstart[len - 1] == '\r' || lstart[len - 1] == ' ')) {
                    lstart[--len] = '\0';
                }
            }
            pclose(ps);
        }
        char *start_ptr = lstart;
        while (*start_ptr == ' ') start_ptr++;
        snprintf(sdir, sizeof(sdir), "%s/sessions", cfg);
        mkdir(sdir, 0700);
        snprintf(sfile, sizeof(sfile), "%s/%d.json", sdir, (int)getpid());
        FILE *sf = fopen(sfile, "w");
        if (sf) {
            fprintf(sf, "{\"pid\":%d,\"sessionId\":\"%s\",\"cwd\":\"%s\",\"procStart\":\"%s\"}\n",
                    (int)getpid(), sid, cwd, start_ptr);
            fclose(sf);
        }
    }

    int log_fd = open(log_path, O_RDONLY);
    (void)log_fd;

    char prev[65536];
    prev[0] = '\0';
    int first = 1;

    for (;;) {
        char buf[65536];
        buf[0] = '\0';
        FILE *cf = fopen(ctrl_path, "r");
        if (cf) {
            size_t n = fread(buf, 1, sizeof(buf) - 1, cf);
            buf[n] = '\0';
            fclose(cf);
        } else {
            strcpy(buf, "idle");
        }

        if (first || strcmp(buf, prev) != 0) {
            strcpy(prev, buf);
            first = 0;

            char spec[128];
            const char *sep = strstr(buf, "\n---SCREEN---\n");
            const char *screen = "";
            if (sep) {
                size_t slen = (size_t)(sep - buf);
                if (slen >= sizeof(spec)) slen = sizeof(spec) - 1;
                memcpy(spec, buf, slen);
                spec[slen] = '\0';
                screen = sep + strlen("\n---SCREEN---\n");
            } else {
                snprintf(spec, sizeof(spec), "%s", buf);
                for (char *p = spec; *p; p++) {
                    if (*p == '\n' || *p == '\r' || *p == ' ') { *p = '\0'; break; }
                }
            }
            if (!spec[0]) strcpy(spec, "idle");

            fputs("\033[2J\033[H", stdout);
            if (*screen) {
                print_crlf(screen);
            } else {
                printf("  %s session ready (%s)\r\n  cwd: %s\r\n", app, spec, cwd);
            }

            char *colon = strchr(spec, ':');
            if (colon) {
                *colon = '\0';
                const char *k = colon + 1;
                printf("\033]7501;state=%s:kind=%s:app=%s\033\\", spec, k, app);
            } else {
                printf("\033]7501;state=%s:app=%s\033\\", spec, app);
            }
            fflush(stdout);
        }
        usleep(80000);
    }
}
C_EOF

cc -O2 "$W/agent-stub.c" -o "$W/bin/codex"
cc -O2 "$W/agent-stub.c" -o "$W/bin/claude"
chmod +x "$W/bin/codex" "$W/bin/claude"

# Prepare Space 1 (cockpit-demo) git repo with changed files, drafts, tasks.md, and decisions.tsv.
REPO1="$W/cockpit-demo"
mkdir -p "$REPO1/src" "$REPO1/docs/drafts/ui-refinement"
git -C "$REPO1" init -q -b main
cat > "$REPO1/src/shell.js" << 'EOF'
export function workColumnWidth(windowWidth, sidebarHidden, rightHidden) {
  const sidebar = sidebarHidden ? 0 : 244;
  const right = rightHidden ? 0 : 380;
  return Math.max(320, windowWidth - sidebar - right);
}
EOF
cat > "$REPO1/src/queue.rs" << 'EOF'
pub fn can_drain(status: &str, held: bool) -> bool {
    !held && (status == "done" || status == "idle")
}
EOF
git -C "$REPO1" add .
git -C "$REPO1" -c user.name="Bellwether Verify" -c user.email="verify@example.com" commit -qm "feat: initial shell and queue"
git -C "$REPO1" remote add origin https://github.com/cli/cli.git
git -C "$REPO1" update-ref refs/remotes/origin/main HEAD
git -C "$REPO1" checkout -qb feat/ui-cockpit

cat > "$REPO1/src/shell.js" << 'EOF'
export const PEEK_STRIP_PX = 6;

export function workColumnWidth(windowWidth, sidebarHidden, rightHidden) {
  const sidebar = sidebarHidden ? PEEK_STRIP_PX : 244;
  const right = rightHidden ? 0 : 380;
  return Math.max(360, windowWidth - sidebar - right);
}

export function shouldBreatheNeedsPill(blockedCount) {
  return blockedCount > 0;
}
EOF
git -C "$REPO1" add src/shell.js
git -C "$REPO1" -c user.name="Bellwether Verify" -c user.email="verify@example.com" commit -qm "feat(shell): reserve 6 px floating peek strip"

# Uncommitted changes in REPO1 so bw-diff shows rich Uncommitted and Branch scopes.
cat >> "$REPO1/src/shell.js" << 'EOF'

export function guardCooldownRemainingMs(leftAt, now, windowMs = 3000) {
  return Math.max(0, leftAt + windowMs - now);
}
EOF
cat > "$REPO1/src/queue.rs" << 'EOF'
pub fn can_drain(status: &str, held: bool, has_blocker_card: bool, asks_question: bool) -> bool {
    !held && !has_blocker_card && !asks_question && (status == "done" || status == "idle")
}
EOF

# Populate real draft artifacts in REPO1 (HTML page, 6-column decisions.tsv, root tasks.md).
cp "/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/bellwether-ui-cockpit-refinement.html" \
  "$REPO1/docs/drafts/ui-refinement/bellwether-ui-cockpit-refinement.html"
cp "/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/decisions.tsv" \
  "$REPO1/docs/drafts/ui-refinement/decisions.tsv"
cp "/Volumes/WorkSSD/Personal/bellwether/docs/drafts/ui-refinement/tasks.md" \
  "$REPO1/tasks.md"

# Prepare Space 2 (api-worker) git repo.
REPO2="$W/api-worker"
mkdir -p "$REPO2/src"
git -C "$REPO2" init -q -b fix/session-guard
printf 'export const MAX_SESSIONS = 24;\n' > "$REPO2/src/sessions.js"
git -C "$REPO2" add .
git -C "$REPO2" -c user.name="Bellwether Verify" -c user.email="verify@example.com" commit -qm "init api-worker"

# Prepare Codex rollout variants for Space 1 (rewriting /scratch/codex-question to REPO1/src/shell.js so Open in Changes selects it).
SID_CODEX="01a1b4a2-6731-7140-87be-4960d8a7aefe"
ROLLOUT="$W/codex-home/sessions/2026/11/06/rollout-2026-11-06T22-11-44-$SID_CODEX.jsonl"
sed -e "s|/scratch/codex-question/size.txt|$REPO1/src/shell.js|g" \
    -e "s|/scratch/codex-question/colour.txt|$REPO1/src/shell.js|g" \
    -e "s|/scratch/codex-question|$REPO1|g" \
    "$src/tests/fixtures/sessions/codex-question/rollout-2026-11-06T22-11-44-$SID_CODEX.jsonl" > "$W/rollout-full.jsonl"
awk '{ print } /"name":"request_user_input",/ { exit }' "$W/rollout-full.jsonl" > "$W/rollout-blocked.jsonl"
cat "$W/rollout-full.jsonl" > "$ROLLOUT"
: > "$W/codex-home/thread-writer-locks/$SID_CODEX.lock"
echo "idle" > "$W/ctrl-codex"

# Prepare Claude transcript variants for Space 2.
SID_CLAUDE="e186f156-fd30-4aab-a0b6-d3922b281731"
SLUG2=$(printf '%s' "$REPO2" | sed 's/[^A-Za-z0-9]/-/g')
mkdir -p "$W/claude-cfg/projects/$SLUG2"
CLAUDE_LOG="$W/claude-cfg/projects/$SLUG2/$SID_CLAUDE.jsonl"
sed "s|/scratch/claude-approval|$REPO2|g" \
  "$src/tests/fixtures/sessions/claude-approval/$SID_CLAUDE.jsonl" > "$W/claude-full.jsonl"
awk '{ print } /"id":"toolu_01SGHovZaso4tVTRPTHPkAEF"/ { exit }' "$W/claude-full.jsonl" > "$W/claude-blocked.jsonl"
cat "$W/claude-full.jsonl" > "$CLAUDE_LOG"
echo "idle" > "$W/ctrl-claude"

echo "==> Starting isolated stage window (stage.sh up)"
sh "$STAGE" up
PID=$(cat "$D/app.pid")

# Inject isolated stage paths into stage's bw-log wrapper so bw finds stage transcripts on macOS 27
# and keeps ledger pointers inside $W/bw-state without touching ~/.claude, ~/.codex, or ~/.local/state.
mkdir -p "$W/bw-state"
cat > "$D/bin/bw-log" <<LOG
#!/bin/sh
export CLAUDE_CONFIG_DIR="$W/claude-cfg"
export CODEX_HOME="$W/codex-home"
export BW_STATE_DIR="$W/bw-state"
sub=\${2:-}
case \$sub in -*) sub="" ;; esac
now_ts=\$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
printf '%s %s %s\n' "\$now_ts" "\${1:-}" "\$sub" >> "$D/helper-calls.log"
if [ "\${1:-}" = "diff" ] && [ "\${2:-}" = "patch" ]; then
  printf '%s %s\n' "\$now_ts" "\$*" >> "$D/diff-patch-calls.log"
fi
exec "$D/bin/bw" "\$@"
LOG
chmod +x "$D/bin/bw-log"
: > "$D/diff-patch-calls.log"

# Merge Bellwether keyboard shortcuts into the stage app home only.
bun "$src/scripts/keys-merge.js" --apply --home "$D/app" >/dev/null

# Register the external review ledger in the stage environment for REPO1.
if [ -f "$LEDGER" ]; then
  sh "$STAGE" do env BW_STATE_DIR="$W/bw-state" bw drafts register-ledger --path "$REPO1" --ledger "$LEDGER" >/dev/null
fi

DISP_ID=$(jq -r '.display // empty' "$HOME/.config/herdr-app/window.json" 2>/dev/null || true)
BUNDLE=/Applications/Herdr.app
[ -d "$BUNDLE" ] || BUNDLE=$HOME/Applications/Herdr.app
APP_BIN=$BUNDLE/Contents/MacOS/Herdr

omni_wid() {
  if command -v omniwmctl >/dev/null 2>&1; then
    omniwmctl query windows --fields id,pid --json 2>/dev/null | jq -r --argjson p "$PID" '.result.payload.windows[]? | select(.pid == $p) | .id' | head -n 1
  fi
}

raise_stage() {
  ow=$(omni_wid)
  if [ -n "${ow:-}" ]; then
    omniwmctl window focus "$ow" >/dev/null 2>&1 || true
  fi
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $PID) to true" >/dev/null 2>&1 || true
  sleep 0.3
}

quartz_bounds() {
  osascript -l JavaScript -e 'function run(argv) {
    ObjC.import("CoreGraphics");
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
    const wins = list
      .filter((w) => w.kCGWindowOwnerPID == argv[0] && w.kCGWindowLayer == 0 && (w.kCGWindowName === "Herdr" || w.kCGWindowBounds.Height > 200))
      .sort((a, b) => (b.kCGWindowBounds.Width * b.kCGWindowBounds.Height) - (a.kCGWindowBounds.Width * a.kCGWindowBounds.Height))
      .map((w) => w.kCGWindowBounds);
    return JSON.stringify(wins[0] || null);
  }' "$PID"
}

resize_stage() {
  wx=$1 wy=$2 ww=$3 wh=$4
  ow=$(omni_wid)
  if [ -n "${ow:-}" ]; then
    omniwmctl window set-container-primary-span "$ow" "$ww" >/dev/null 2>&1 || true
    omniwmctl window focus "$ow" >/dev/null 2>&1 || true
    sleep 0.6
  else
    old_pid=$(cat "$D/app.pid")
    kill "$old_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 15; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.2
    done
    rm -f "$D/app/herdr-app.sock"
    jq -n --arg d "$DISP_ID" --argjson x "$wx" --argjson y "$wy" --argjson w "$ww" --argjson h "$wh" \
      '{state:"windowed", bounds:[$x, $y, $w, $h]} + (if $d != "" then {display:$d} else {} end)' > "$D/app/window.json"
    sh "$STAGE" do python3 -I -c '
import os, subprocess, sys
with open(sys.argv[2], "wb") as log:
    p = subprocess.Popen([sys.argv[3]], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, cwd=os.path.expanduser("~"))
with open(sys.argv[1], "w") as pf:
    pf.write(str(p.pid) + "\n")
' "$D/app.pid" "$D/app.log" "$APP_BIN"
    for _ in 1 2 3 4 5 6 7 8 9 15; do
      sh "$STAGE" do herdr-app status >/dev/null 2>&1 && break
      sleep 0.4
    done
    PID=$(cat "$D/app.pid")
    raise_stage
    sleep 0.5
  fi
}

shot() {
  out=$1
  raise_stage
  sh "$STAGE" do herdr-app shot "$out" >/dev/null
}

# ---- Done Check 1: 934 px OmniWM half-tile, stack flip, 6 px peek, Open in Changes ----
echo "==> Done Check 1: Shell geometry, stack screens, and left-edge peek"
resize_stage 0 40 934 980
b934=$(quartz_bounds)
bw_w=$(printf '%s' "$b934" | jq -r '.Width // 0')
bw_h=$(printf '%s' "$b934" | jq -r '.Height // 0')
bw_x=$(printf '%s' "$b934" | jq -r '.X // 0')
bw_y=$(printf '%s' "$b934" | jq -r '.Y // 40')
park_x=$((bw_x + 500))
park_y=$((bw_y + 500))
cliclick "m:$park_x,$park_y"
if [ "$bw_w" = "934" ] && [ "$bw_h" -ge 900 ]; then
  pass "dc1-bounds-934" "Quartz stage window bounds ${bw_x},${bw_y} ${bw_w}x${bw_h}"
else
  bad "dc1-bounds-934" "expected 934x>=900, got $b934"
fi

st_json=$(sh "$STAGE" do herdr-app status)
if printf '%s' "$st_json" | jq -e '.layout == "bellwether" and (.errors | length) == 0' >/dev/null; then
  pass "dc1-status" "layout bellwether with zero mod/layout errors"
else
  bad "dc1-status" "unexpected status: $st_json"
fi

# Open Space 2 (api-worker, Claude) and Space 1 (cockpit-demo, Codex, active).
s2_json=$(sh "$STAGE" do herdr-app do space.new --json \
  --name "api-worker" \
  --folder "$REPO2" \
  --tab "session-guard" \
  --argv "[\"/usr/bin/env\",\"CLAUDE_CONFIG_DIR=$W/claude-cfg\",\"FAKE_CLAUDE_SID=$SID_CLAUDE\",\"$W/bin/claude\",\"claude-code\",\"$CLAUDE_LOG\",\"$W/ctrl-claude\"]" 2>/dev/null || \
  sh "$STAGE" do herdr-app do space.new \
  "{\"name\":\"api-worker\",\"folder\":\"$REPO2\",\"tab\":\"session-guard\",\"argv\":[\"/usr/bin/env\",\"CLAUDE_CONFIG_DIR=$W/claude-cfg\",\"FAKE_CLAUDE_SID=$SID_CLAUDE\",\"$W/bin/claude\",\"claude-code\",\"$CLAUDE_LOG\",\"$W/ctrl-claude\"]}")
t_claude=$(printf '%s' "$s2_json" | jq -r '.terminal')

s1_json=$(sh "$STAGE" do herdr-app do space.new \
  "{\"name\":\"cockpit-demo\",\"folder\":\"$REPO1\",\"tab\":\"ui-cockpit\",\"argv\":[\"/usr/bin/env\",\"CODEX_HOME=$W/codex-home\",\"$W/bin/codex\",\"codex\",\"$ROLLOUT\",\"$W/ctrl-codex\"]}")
t_codex=$(printf '%s' "$s1_json" | jq -r '.terminal')

# Wait for both agents to report OSC 7501 status and for bw-chat to render the conversation.
sleep 3.5
ls_json=$(sh "$STAGE" do herdr-app ls)
split_chat_panes=$(printf '%s' "$ls_json" | jq '[.. | objects | select(.mod? == "bw-chat")] | length')
if [ "$split_chat_panes" = "0" ]; then
  pass "dc1-zero-split-chat-panes" "zero per-tab bw-chat split panes ($t_codex, $t_claude)"
else
  bad "dc1-zero-split-chat-panes" "found $split_chat_panes bw-chat split panes"
fi

# Dismiss the stage hooks notice ("Not now") once if shown so stage screenshots stay clean and free of notice buttons.
shot "$W/initial-chat.png"
if h_btn=$(bun "$W/pixels.js" find-color "$W/initial-chat.png" 934 "#cba6f7" 4 260 350 550 920 40 2>/dev/null); then
  hx_max=$(printf '%s' "$h_btn" | jq -r '.logicalBox[2]')
  hy_mid=$(printf '%s' "$h_btn" | jq -r '.logicalY')
  raise_stage
  cliclick "c:$((bw_x + hx_max + 36)),$((bw_y + hy_mid))"
  sleep 0.8
fi
cliclick "c:$((bw_x + 120)),$((bw_y + 500))" "m:$park_x,$park_y"
sleep 0.4

shot "$SHOTS/chat-934.png"
right_fresh=$(bun "$W/pixels.js" dominant "$SHOTS/chat-934.png" 934 860 220 920 620 | jq -r .hex)
if [ "$right_fresh" = "#1e1e2e" ]; then
  pass "dc1-right-hidden-startup" "fresh startup keeps 380 px right inspector hidden (x=860..920 is Base $right_fresh)"
else
  bad "dc1-right-hidden-startup" "expected #1e1e2e at right edge on fresh startup, got $right_fresh"
fi

# Flip chat -> panes via ⌘J command and verify full work width (> 60 cols, zero 15-col squeeze).
sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
sleep 1.0
shot "$SHOTS/panes-934.png"
term_cols=$(sh "$STAGE" do hc get "$t_codex" --json | jq -r '.cols // .size.cols // 0')
panes_right_bg=$(bun "$W/pixels.js" dominant "$SHOTS/panes-934.png" 934 260 120 900 700 | jq -r .hex)
if [ "${term_cols:-0}" -gt 60 ] && [ "$panes_right_bg" = "#1e1e2e" ]; then
  pass "dc1-cmd-j-panes" "⌘J flipped to panes with full width (${term_cols} cols > 60, zero 15-col squeeze)"
else
  bad "dc1-cmd-j-panes" "cols=$term_cols bg=$panes_right_bg"
fi
sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
sleep 1.0

before_peek_w=$(sh "$STAGE" do herdr-app status | jq -r '.floats["sidebar-peek"].bounds[2] // 0')

# Hide sidebar (⌘B) and verify 6 px left-edge floating peek on both chat and panes.
sh "$STAGE" do herdr-app do layout.toggle '{"id":"sidebar"}' >/dev/null
raise_stage
cliclick "m:$park_x,$park_y"
sleep 0.7
sh "$STAGE" do herdr-app shot "$W/chat-sidebar-hidden.png" >/dev/null
hidden_left=$(bun "$W/pixels.js" dominant "$W/chat-sidebar-hidden.png" 934 24 75 180 280 | jq -r .hex)
chat_peek_bounds=$(sh "$STAGE" do herdr-app status | jq -c '.floats["sidebar-peek"].bounds // [0,0,0,0]')

peek_edge_x=$((bw_x + 14))
peek_hover_x=$((bw_x + 40))
peek_hover_y=$((bw_y + 140))
cliclick "m:$peek_edge_x,$peek_hover_y" "m:$peek_hover_x,$peek_hover_y"
sleep 0.8
sh "$STAGE" do herdr-app shot "$SHOTS/peek-chat-934.png" >/dev/null
peek_chat_left=$(bun "$W/pixels.js" dominant "$SHOTS/peek-chat-934.png" 934 24 75 180 280 | jq -r .hex)

cliclick "m:$park_x,$park_y"
sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
sleep 0.8
panes_peek_bounds=$(sh "$STAGE" do herdr-app status | jq -c '.floats["sidebar-peek"].bounds // [0,0,0,0]')
cliclick "m:$peek_edge_x,$peek_hover_y" "m:$peek_hover_x,$peek_hover_y"
sleep 0.8
sh "$STAGE" do herdr-app shot "$SHOTS/peek-panes-934.png" >/dev/null
peek_panes_left=$(bun "$W/pixels.js" dominant "$SHOTS/peek-panes-934.png" 934 24 75 180 280 | jq -r .hex)

locked_now=$(is_screen_locked)
if [ "$locked_now" = "0" ] && [ "$hidden_left" = "#1e1e2e" ] && [ "$peek_chat_left" = "#181825" ] && [ "$peek_panes_left" = "#181825" ]; then
  pass "dc1-floating-peek" "⌘B hid sidebar ($hidden_left) and pointer hover revealed Mantle drawer ($peek_chat_left / $peek_panes_left) on chat and panes"
else
  bad "dc1-floating-peek" "locked=$locked_now before_w=$before_peek_w hidden=$hidden_left peek_chat=$peek_chat_left($chat_peek_bounds) peek_panes=$peek_panes_left($panes_peek_bounds)"
fi

# Restore sidebar and return to chat.
cliclick "m:$park_x,$park_y"
sh "$STAGE" do herdr-app do layout.toggle '{"id":"sidebar"}' >/dev/null
sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
sleep 1.0
shot "$W/chat-before-open-changes.png"

# Locate "Open in Changes" (Mauve #cba6f7 label inside chat timeline) and verify right inspector reveals on changes.
if oic=$(bun "$W/pixels.js" find-color "$W/chat-before-open-changes.png" 934 "#cba6f7" 20 380 120 560 760 1 2>/dev/null); then
  cx=$((bw_x + $(printf '%s' "$oic" | jq -r .logicalX)))
  cy=$((bw_y + $(printf '%s' "$oic" | jq -r .logicalY)))
  sp1_id=$(printf '%s' "$s1_json" | jq -r '.space')
  t_oic=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  raise_stage
  cliclick "c:$cx,$cy"
  sleep 1.4
  shot "$SHOTS/open-in-changes-934.png"
  right_after=$(bun "$W/pixels.js" dominant "$SHOTS/open-in-changes-934.png" 934 720 120 920 320 | jq -r .hex)
  locked_oic=$(is_screen_locked)
  if [ "$locked_oic" = "0" ] && [ "$right_after" != "#1e1e2e" ] &&
     jq -e --arg sp "$sp1_id" '."bw.right.tab"[$sp] == "changes"' "$D/app/shared.json" >/dev/null 2>&1 &&
     awk -v t0="$t_oic" -v p="$REPO1" '$1 >= t0 && index($0, "--path " p " --section changes --file src/shell.js") > 0 { ok=1 } END { exit(ok ? 0 : 1) }' "$D/diff-patch-calls.log"; then
    pass "dc1-open-in-changes" "clicked Mauve Open in Changes link at ($cx,$cy), revealed right inspector ($right_after), and loaded src/shell.js patch in Changes"
  else
    bad "dc1-open-in-changes" "locked=$locked_oic right_after=$right_after at ($cx,$cy) or missing bw.right.tab/src/shell.js patch load for $sp1_id"
  fi
else
  bad "dc1-open-in-changes" "could not locate Mauve Open in Changes link in chat timeline"
fi

# Hide right inspector again before Done Check 2 & 3 stillness checks.
sh "$STAGE" do herdr-app do layout.hide '{"id":"right"}' >/dev/null
cliclick "c:$((bw_x + 120)),$((bw_y + 500))" "m:$park_x,$park_y"
sleep 0.8

# ---- Done Check 2: Single hex source, WCAG AA contrast, and stage pixel sampling ----
echo "==> Done Check 2: Flattened Mocha palette, single hex source, and contrast"
non_palette=$(cd "$src" && grep -rnoE "#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b" mods/bw-*/*.js shared/*.js | cut -d: -f1 | sort -u | grep -v '/palette\.js$' || true)
if [ -z "$non_palette" ]; then
  pass "dc2-single-hex-source" "hex literals appear only in shared/palette.js and synced palette.js copies"
else
  bad "dc2-single-hex-source" "unexpected files with hex literals: $non_palette"
fi

if node "$src/scripts/verify/contrast.js" > "$W/contrast.log" 2>&1; then
  pass "dc2-contrast" "contrast.js passed all foreground/background/border/pill pairs"
else
  bad "dc2-contrast" "contrast.js failed: $(tail -n 3 "$W/contrast.log" | tr '\n' ' ')"
fi

if pal_res=$(bun "$W/pixels.js" palette-check "$SHOTS/chat-934.png" 934); then
  pass "dc2-sampled-pixels" "sampled chat-934.png matches flattened Mocha roles: $pal_res"
else
  bad "dc2-sampled-pixels" "sampled pixels off target: $pal_res"
fi

# ---- Done Check 3: Idle stillness, Needs you pill-only motion, 2s/10s feed cadence, 3s focus guard ----
echo "==> Done Check 3: Calm motion, feed cadence, and focus-guard safety"
mkdir -p "$W/burst"
raise_stage
cliclick "c:$((bw_x + 120)),$((bw_y + 500))" "m:$park_x,$park_y"
sleep 1.2
i=0
while [ "$i" -lt 10 ]; do
  sh "$STAGE" do herdr-app shot "$W/burst/idle-$i.png" >/dev/null
  sleep 0.15
  i=$((i + 1))
done
idle_diff=$(bun "$W/pixels.js" burst-diff "$W/burst" "idle" 10 934 '[]')
idle_changed=$(printf '%s' "$idle_diff" | jq -r .changedTotal)
if [ "$idle_changed" = "0" ]; then
  pass "dc3-idle-stillness" "10 all-idle shots 150 ms apart are pixel-identical (0 changed pixels)"
else
  bad "dc3-idle-stillness" "expected 0 changed pixels when idle, got $idle_diff"
fi

# Put BOTH agents into blocked state (truncated pending transcripts + colon OSC 7501 + prompt screens)
# and verify ONLY the top-bar Needs you pill breathes.
cat "$W/rollout-blocked.jsonl" > "$ROLLOUT"
{
  printf 'blocked:question\n---SCREEN---\n'
  sed "s|/scratch/codex-question|$REPO1|g" "$src/tests/fixtures/sessions/codex-question/screen-question.txt"
} > "$W/ctrl-codex"
cat "$W/claude-blocked.jsonl" > "$CLAUDE_LOG"
{
  printf 'blocked:permission\n---SCREEN---\n'
  sed "s|/scratch/claude-approval|$REPO2|g" "$src/tests/fixtures/sessions/claude-approval/screen-approval.txt"
} > "$W/ctrl-claude"

# Wait for dock card appear animation and counts poll to settle, then blur any input caret.
sleep 3.2
raise_stage
cliclick "c:$((bw_x + 120)),$((bw_y + 500))" "m:$park_x,$park_y"
sleep 0.6
i=0
while [ "$i" -lt 10 ]; do
  sh "$STAGE" do herdr-app shot "$W/burst/blocked-$i.png" >/dev/null
  sleep 0.15
  i=$((i + 1))
done
cp "$W/burst/blocked-0.png" "$SHOTS/blocked-stillness-934.png"

# Allowed box: strictly the top-bar Needs you pill inside tabs (x=250..934, y=0..48).
blocked_diff=$(bun "$W/pixels.js" burst-diff "$W/burst" "blocked" 10 934 '[[250,0,934,48]]')
b_changed=$(printf '%s' "$blocked_diff" | jq -r .changedTotal)
b_outside=$(printf '%s' "$blocked_diff" | jq -r .outsideTotal)
b_bbox=$(printf '%s' "$blocked_diff" | jq -c .logicalBbox)
if [ "$b_changed" -gt 0 ] && [ "$b_outside" = "0" ]; then
  pass "dc3-needs-pill-only-motion" "blocked burst changed $b_changed px strictly inside top-bar Needs you pill ($b_bbox), 0 px outside"
else
  bad "dc3-needs-pill-only-motion" "expected >0 inside top bar and 0 outside, got $blocked_diff"
fi

# 3 s focus guard check on Space 2 (claude-approval, whose Approve primary button needs no option pick):
# flip chat -> panes for 1.5 s, flip panes -> chat, sample left dock button area (x=260..550, y=550..960) at 0 s, 2 s, and 4 s.
sh "$STAGE" do herdr-app do agent.focus "{\"terminal\":\"$t_claude\"}" >/dev/null
sleep 2.4
sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
sleep 1.5
sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
t0=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
for sec in 0 2 4; do
  now=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  rem=$(awk -v t0="$t0" -v s="$sec" -v now="$now" 'BEGIN { d = (t0 + s + 0.18) - now; if (d > 0) printf "%.3f", d; else print "0" }')
  [ "$rem" = "0" ] || sleep "$rem"
  sh "$STAGE" do herdr-app shot "$W/guard-${sec}s.png" >/dev/null
done
cp "$W/guard-0s.png" "$SHOTS/focus-guard-0s.png"
cp "$W/guard-4s.png" "$SHOTS/focus-guard-4s.png"

g0_mauve=0
if bun "$W/pixels.js" find-color "$W/guard-0s.png" 934 "#cba6f7" 8 260 550 550 750 >/dev/null 2>&1; then g0_mauve=1; fi
g2_mauve=0
if bun "$W/pixels.js" find-color "$W/guard-2s.png" 934 "#cba6f7" 8 260 550 550 750 >/dev/null 2>&1; then g2_mauve=1; fi
g4_mauve=0
if bun "$W/pixels.js" find-color "$W/guard-4s.png" 934 "#cba6f7" 8 260 550 550 750 >/dev/null 2>&1; then g4_mauve=1; fi
if [ "$g0_mauve" = "0" ] && [ "$g2_mauve" = "0" ] && [ "$g4_mauve" = "1" ]; then
  pass "dc3-focus-guard-0-2-4s" "dock Approve button stayed disabled at 0 s and 2 s after ⌘J and enabled in Mauve at 4 s"
else
  bad "dc3-focus-guard-0-2-4s" "mauve presence at 0s=$g0_mauve 2s=$g2_mauve 4s=$g4_mauve"
fi

# Return focus to Space 1 (cockpit-demo).
sh "$STAGE" do herdr-app do agent.focus "{\"terminal\":\"$t_codex\"}" >/dev/null
sleep 1.0

# Key isolation on needs screen: switch to needs, press '1' while guarded, verify hidden terminal screens did not change.
before_t1=$(sh "$STAGE" do hc read "$t_codex" --lines 40)
before_t2=$(sh "$STAGE" do hc read "$t_claude" --lines 40)
sh "$STAGE" do herdr-app do bw-tabs.needs-toggle >/dev/null
sleep 0.4
raise_stage
cliclick t:1
sleep 0.5
after_t1=$(sh "$STAGE" do hc read "$t_codex" --lines 40)
after_t2=$(sh "$STAGE" do hc read "$t_claude" --lines 40)
if [ "$before_t1" = "$after_t1" ] && [ "$before_t2" = "$after_t2" ]; then
  pass "dc3-needs-key-isolation" "pressing key 1 on needs sent nothing to hidden terminals ($t_codex, $t_claude)"
else
  bad "dc3-needs-key-isolation" "hidden terminal screen changed after pressing 1 on needs"
fi

# BW_HELPER feed cadence check: ~2 s on chat (6.5 s window -> >= 3 calls) vs ~10 s on panes/needs/overview (6.5 s window -> <= 1 call).
: >> "$D/helper-calls.log"
sh "$STAGE" do herdr-app do bw-tabs.needs-toggle >/dev/null
sleep 0.6
c_start=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
sleep 6.5
c_end=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
chat_feeds=$(awk -v a="$c_start" -v b="$c_end" '$2 == "feed" && $1 >= a && $1 <= b { c++ } END { print c + 0 }' "$D/helper-calls.log")

sh "$STAGE" do herdr-app do bw-tabs.chat-flip >/dev/null
sleep 0.5
before_ov_t1=$(sh "$STAGE" do hc read "$t_codex" --lines 40)
before_ov_t2=$(sh "$STAGE" do hc read "$t_claude" --lines 40)
sh "$STAGE" do herdr-app do bw-tabs.overview-toggle >/dev/null
sleep 0.6
raise_stage
cliclick t:1
sleep 0.5
after_ov_t1=$(sh "$STAGE" do hc read "$t_codex" --lines 40)
after_ov_t2=$(sh "$STAGE" do hc read "$t_claude" --lines 40)
if [ "$before_ov_t1" = "$after_ov_t1" ] && [ "$before_ov_t2" = "$after_ov_t2" ]; then
  pass "dc3-overview-key-isolation" "pressing key 1 on overview after panes -> overview sent nothing to hidden terminals ($t_codex, $t_claude)"
else
  bad "dc3-overview-key-isolation" "hidden terminal screen changed after pressing 1 on overview"
fi

h_start=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
sleep 6.5
h_end=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
hidden_feeds=$(awk -v a="$h_start" -v b="$h_end" '$2 == "feed" && $1 >= a && $1 <= b { c++ } END { print c + 0 }' "$D/helper-calls.log")

if [ "$chat_feeds" -ge 3 ] && [ "$hidden_feeds" -le 1 ]; then
  pass "dc3-feed-cadence" "BW_HELPER logged $chat_feeds feed polls in 6.5 s on chat (~2 s) and $hidden_feeds in 6.5 s off chat (~10 s)"
else
  bad "dc3-feed-cadence" "expected chat_feeds>=3 and hidden_feeds<=1 in 6.5 s, got chat=$chat_feeds hidden=$hidden_feeds"
fi

# ---- Done Check 4: Live bw pr status via logged-in gh CLI ----
echo "==> Done Check 4: Live bw pr status via logged-in gh CLI"
if pr_out=$("$BW" pr status --repo cli/cli --branch trunk 2>"$W/pr.err") &&
   printf '%s\n' "$pr_out" | head -n 1 | jq -e '.type == "pr"' >/dev/null; then
  pass "dc4-live-gh-pr" "bw pr status --repo cli/cli --branch trunk returned valid NDJSON: $(printf '%s\n' "$pr_out" | head -n 1 | cut -c1-120)"
else
  bad "dc4-live-gh-pr" "live bw pr status failed: $(cat "$W/pr.err" 2>/dev/null)"
fi

# ---- Done Checks 5 & 6: 1440 px wide screenshots of all Cockpit views ----
echo "==> Done Checks 5 & 6: Capturing 1440 px Cockpit views (chat, needs, overview, bw-diff comments, bw-drafts)"
resize_stage 0 40 1440 980
b1440=$(quartz_bounds)
w1440=$(printf '%s' "$b1440" | jq -r '.Width // 0')
h1440=$(printf '%s' "$b1440" | jq -r '.Height // 0')
bw_x=$(printf '%s' "$b1440" | jq -r '.X // 0')
bw_y=$(printf '%s' "$b1440" | jq -r '.Y // 40')
park_x=$((bw_x + 500))
park_y=$((bw_y + 500))
if [ "$w1440" = "1440" ] && [ "$h1440" -ge 900 ]; then
  pass "dc6-bounds-1440" "Quartz stage window bounds ${bw_x},${bw_y} ${w1440}x${h1440}"
else
  bad "dc6-bounds-1440" "expected 1440x>=900, got $b1440"
fi

# Capture Needs you at 1440 px first while both agents are blocked (Codex question + Claude approval).
sh "$STAGE" do herdr-app do layout.select '{"stack":"screen","child":"needs"}' >/dev/null
sleep 3.0
shot "$SHOTS/needs-1440.png"

# Set Space 1 to done (keeping Space 2 blocked) and capture Overview at 1440 px showing mixed fleet status.
cat "$W/rollout-full.jsonl" > "$ROLLOUT"
echo "done" > "$W/ctrl-codex"
sh "$STAGE" do herdr-app do layout.select '{"stack":"screen","child":"overview"}' >/dev/null
sleep 2.4
shot "$SHOTS/overview-1440.png"

# Return both spaces to idle with full transcripts and capture clean 1440 px Chat screen on Space 1.
cat "$W/claude-full.jsonl" > "$CLAUDE_LOG"
echo "idle" > "$W/ctrl-codex"
echo "idle" > "$W/ctrl-claude"
sh "$STAGE" do herdr-app do agent.focus "{\"terminal\":\"$t_codex\"}" >/dev/null 2>&1 || true
sh "$STAGE" do herdr-app do layout.select '{"stack":"screen","child":"chat"}' >/dev/null
sleep 4.5
cliclick "c:$((bw_x + 120)),$((bw_y + 500))" "m:$park_x,$park_y"
sleep 0.4
shot "$SHOTS/chat-1440.png"

# Reveal right rail on Changes (bw-diff), select src/shell.js, save a line comment, and open inline composer on the next row.
sh "$STAGE" do herdr-app do layout.show '{"id":"right"}' >/dev/null
sleep 0.6
raise_stage
cliclick "c:$((bw_x + 1110)),$((bw_y + 18))"
sleep 1.4
cliclick "c:$((bw_x + 1160)),$((bw_y + 228))"
sleep 1.0
shot "$W/diff-file-selected.png"

# Right column spans x = 1060..1440 at 1440 px; added rows 13..15 of src/shell.js sit at y = 545..595.
dx=$((bw_x + 1180))
dy=$((bw_y + 550))
raise_stage
cliclick "c:$dx,$dy"
sleep 0.5
cliclick "t:Keep 6 px peek width aligned with layout.json"
sleep 0.3
cliclick kp:return
sleep 0.6
cliclick "c:$dx,$((dy + 20))"
sleep 0.6
shot "$SHOTS/diff-comments-1440.png"

# Switch right-body to Drafts (bw-drafts) via its tab pill (x=1280, y=18) so bw.right.tab updates too.
raise_stage
cliclick "c:$((bw_x + 1280)),$((bw_y + 18))"
sleep 2.4
shot "$SHOTS/drafts-1440.png"

final_status=$(sh "$STAGE" do herdr-app status)
if printf '%s' "$final_status" | jq -e '(.errors | length) == 0' >/dev/null; then
  pass "dc6-zero-runtime-errors" "herdr-app status reported zero mod/render errors after visiting all screens and sidecar tabs"
else
  bad "dc6-zero-runtime-errors" "herdr-app status reported errors: $final_status"
fi

# Verify bw drafts list in stage sees all 4 expected artifact kinds on REPO1.
drafts_out=$(sh "$STAGE" do env BW_STATE_DIR="$W/bw-state" bw drafts list --path "$REPO1")
for want_kind in html decisions plan ledger; do
  if printf '%s\n' "$drafts_out" | jq -e --arg k "$want_kind" 'select(.type == "draft" and .kind == $k)' >/dev/null; then
    pass "dc5-drafts-$want_kind" "bw drafts listed $want_kind artifact in stage workspace"
  else
    bad "dc5-drafts-$want_kind" "missing $want_kind in bw drafts list output"
  fi
done

echo "==> Tearing down stage window (stage.sh down)"
sh "$STAGE" down
[ ! -e "$D" ] && pass "dc6-stage-down" "stage.sh down removed $D cleanly" || bad "dc6-stage-down" "$D still exists"

after_check=$(herdr_home_state)
if [ "$after_check" = "$before_herdr_home" ]; then
  pass "dc6-herdr-home-untouched" "~/.config/herdr-app unchanged throughout verification"
else
  bad "dc6-herdr-home-untouched" "~/.config/herdr-app changed"
fi

[ "$failed" -eq 0 ] && echo "ALL STAGE CHECKS PASSED"
exit "$failed"
