#!/bin/sh
# Phase 4 probe: how Chrome 156's DevTools endpoints, Chrome DevTools MCP 1.12.0, Claude's and Codex's
# logs and a scratch sshd behave. Prints answers (a) to (k) for docs/research/2026-11-07-phase4-browser.md;
# BW_PROBE_FIXTURES=<dir> receives the tests/fixtures/browser files it captured, to review and copy in.
#   scripts/verify/browser-probe.sh [--offline] [--no-agents]
# --offline starts nothing: it checks the committed fixtures and that lib-sshd.sh parses.
# Otherwise it starts a second Chrome on a scratch profile and a free port (never 9222) beside the
# user's, which it never signals or reads beyond its ps line, and stops it with CDP Browser.close.
# (h) runs claude -p and codex exec in a private hc core, so it spends tokens; --no-agents skips it.
set -eu
src=$(cd "$(dirname "$0")/../.." && pwd)
. "$src/scripts/verify/lib-scratch.sh"
. "$src/scripts/verify/lib-sshd.sh"
fix=$src/tests/fixtures/browser
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }

agents=1
case "${1:-}" in
  --offline)
    for f in json-version.json json-list.json lsof-loopback.txt lsof-wildcard.txt lsof-other.txt; do
      [ -s "$fix/$f" ] && pass "exists tests/fixtures/browser/$f" || bad "missing tests/fixtures/browser/$f"
    done
    [ -f "$src/docs/research/2026-11-07-phase4-browser.md" ] && pass "exists the probe note" || bad "missing the probe note"
    jq -e '.webSocketDebuggerUrl | test("^ws://127\\.0\\.0\\.1:[0-9]+/devtools/browser/")' "$fix/json-version.json" > /dev/null &&
      pass "json-version.json names a loopback browser WebSocket" || bad "json-version.json has no browser WebSocket"
    jq -e 'map(select(.type == "page")) | length > 0' "$fix/json-list.json" > /dev/null &&
      pass "json-list.json lists pages" || bad "json-list.json lists no page"
    for f in lsof-loopback.txt lsof-wildcard.txt lsof-other.txt; do
      grep -q '^p[0-9]' "$fix/$f" && grep -q '^c' "$fix/$f" && grep -q '^n' "$fix/$f" &&
        pass "$f has p, c and n fields" || bad "$f lacks a p, c or n field"
    done
    sh -n "$src/scripts/verify/lib-sshd.sh" && pass "lib-sshd.sh parses" || bad "lib-sshd.sh does not parse"
    bun "$src/scripts/verify/scrub-fixture" --check "$fix" > /dev/null && pass "fixtures scrubbed" || bad "fixtures hold private values"
    exit "$fail" ;;
  --no-agents) agents=0 ;;
  "") ;;
  *) sed -n 5,10p "$0" >&2; exit 2 ;;
esac

for c in bun jq curl lsof hc open lsappinfo osascript ssh ssh-keygen npx claude codex; do
  command -v "$c" > /dev/null || { echo "FAIL $c is not on PATH" >&2; exit 1; }
done
[ "$(uname)" = Darwin ] || { echo "FAIL this probe is for macOS" >&2; exit 1; }
APP=${BW_CHROME_APP:-/Applications/Google Chrome.app}
[ -d "$APP" ] || { echo "FAIL no Chrome at $APP" >&2; exit 1; }
W=$(scratch_path "${BW_PROBE_DIR:-/private/tmp/claude-501/bw-probe}") || exit 1
scratch_rm_idle "$W" || { echo "FAIL $W is left from another probe and was not deleted (above)" >&2; exit 1; }
scratch_make "$W" || exit 1
PROFILE=$W/profile
mkdir -m 700 "$PROFILE" "$W/fixtures"
CORE=bw-p4probe
CH=$W/codex-home
# A calling agent's markers leak into children: CLAUDE_CODE_CHILD_SESSION turns off Claude's transcripts.
for v in $(env | grep -Eo '^(CLAUDE[A-Z0-9_]*|CODEX_[A-Z0-9_]*|ANTHROPIC_API_KEY)='); do unset "${v%=}"; done

q() { printf '\n## (%s) %s\n' "$1" "$2"; }
# run <argv>: prints the command, then its output and a non-zero exit.
run() {
  printf '$ %s\n' "$*"
  _rc=0
  "$@" 2>&1 || _rc=$?
  [ "$_rc" = 0 ] || echo "(exit $_rc)"
  return 0
}
free_port() {
  _fp=$(_sshd_free_port)
  while [ "$_fp" = 9222 ]; do _fp=$(_sshd_free_port); done
  echo "$_fp"
}
# The main Chrome processes not started by this probe: the user's, by pid and ps line.
user_chromes() {
  for _p in $(pgrep -f '^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome( |$)' || true); do
    ps -ww -o pid=,ppid=,lstart=,command= -p "$_p" 2> /dev/null || true
  done | grep -vF -- "--user-data-dir=$PROFILE" || true
}
asn_pid() { lsappinfo info -only pid "$1" | sed -n 's/.*pid = \([0-9]*\).*/\1/p'; }
# front: the frontmost app's name, and where the probe's Chrome sits in the front-to-back app list.
front() {
  _a=$(lsappinfo front)
  _n=$(lsappinfo info -only name "$_a" | head -1 | sed 's/^"\([^"]*\)".*/\1/')
  _i=0 _r=none
  for _x in $(lsappinfo visibleProcessList | grep -o 'ASN:[0-9a-fx-]*'); do
    _i=$((_i + 1))
    [ "$(asn_pid "$_x")" = "${CPID:-x}" ] && _r=$_i
  done
  echo "front app: $_n (pid $(asn_pid "$_a")); probe Chrome's place front to back: $_r of $_i"
}
# windows <pid>: on-screen layer-0 windows of that pid, from CGWindowListCopyWindowInfo.
windows() {
  osascript -l JavaScript -e 'function run(argv) { ObjC.import("CoreGraphics");
    const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
    return JSON.stringify(l.filter((w) => w.kCGWindowOwnerPID == argv[0] && w.kCGWindowLayer == 0).map((w) => ({id: w.kCGWindowNumber, bounds: w.kCGWindowBounds}))); }' "$1"
}
listener_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fp 2> /dev/null | sed -n 's/^p//p' | head -1; }
ours() { ps -ww -o command= -p "$1" 2> /dev/null | grep -qF -- "--user-data-dir=$PROFILE"; }
wait_port() {
  _n=${2:-50}
  until lsof -nP -iTCP:"$1" -sTCP:LISTEN > /dev/null 2>&1; do
    _n=$((_n - 1))
    [ "$_n" -gt 0 ] || return 1
    sleep 0.2
  done
}
cdp() { bun "$W/cdp.js" "$@"; }
hcr() { HC_SESSION=$CORE hc "$@"; }
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG=en_US.UTF-8 TERM=xterm-256color \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
# trunc: a jq filter that keeps a log line's shape and drops its long strings.
TRUNC='walk(if type == "string" and length > 120 then "<\(length) chars>" else . end)'

CPID= SRV_PID= core_up=0 claude_proj= claude_pad= ssh_pids=
cleanup() {
  set +e
  for _p in $ssh_pids; do kill "$_p" 2> /dev/null; done
  if [ "$core_up" = 1 ]; then
    for _t in p4-claude p4-codex; do hcr kill "$_t" > /dev/null 2>&1; hcr rm "$_t" > /dev/null 2>&1; done
    hcr server stop > /dev/null 2>&1
  fi
  rm -rf "$CH"
  if [ -n "${PORT:-}" ] && _l=$(listener_pid "$PORT") && [ -n "$_l" ] && ours "$_l"; then
    cdp close "$PORT" > /dev/null 2>&1
    _n=50
    while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 && [ "$_n" -gt 0 ]; do sleep 0.2; _n=$((_n - 1)); done
  fi
  [ -z "$SRV_PID" ] || kill "$SRV_PID" 2> /dev/null
  sshd_down "$W/sshd" > /dev/null 2>&1
  sshd_down "$W/sshd-gw" > /dev/null 2>&1
  sleep 1
  if pgrep -f -- "--user-data-dir=$PROFILE" > /dev/null; then
    echo "FAIL a Chrome on $PROFILE is still running after Browser.close:" >&2
    pgrep -fl -- "--user-data-dir=$PROFILE" | cut -c1-160 >&2
  fi
  # Claude's logs of the probe's folder stay with $W while a process still uses it.
  scratch_rm_idle "$W" $SRV_PID $CPID $ssh_pids || exit 1
  [ -z "$claude_proj" ] || rm -rf "$claude_proj"
  [ -z "$claude_pad" ] || rm -rf "$claude_pad"
}
trap cleanup EXIT INT TERM

cat > "$W/cdp.js" << 'JS'
// CDP and MCP client for browser-probe.sh: cdp.js <command> <port> [args].
const [cmd, port, ...rest] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onopen = () => resolve({
      call(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const i = ++id;
          waiting.set(i, res);
          ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
          setTimeout(() => waiting.delete(i) && rej(new Error(`${method} timed out`)), 15000);
        });
      },
      close() { ws.close(); },
    });
  });
}
const browser = async () => connect((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl);
const pages = async () => (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === "page");

// active: each page's window, visibilityState and hasFocus(), read over one browser socket.
async function active() {
  const c = await browser();
  const t0 = performance.now();
  const out = [];
  for (const p of await pages()) {
    const w = await c.call("Browser.getWindowForTarget", { targetId: p.id });
    const s = (await c.call("Target.attachToTarget", { targetId: p.id, flatten: true })).result.sessionId;
    const r = await c.call("Runtime.evaluate", { expression: "[document.visibilityState, document.hasFocus()]", returnByValue: true }, s);
    await c.call("Target.detachFromTarget", { sessionId: s });
    const [visibility, focus] = r.result?.result?.value ?? [r.error?.message, null];
    out.push({ id: p.id.slice(0, 8), title: p.title, window: w.result?.windowId, visibility, hasFocus: focus });
  }
  c.close();
  return { ms: Math.round(performance.now() - t0), pages: out };
}

// JPEG and PNG sizes from their headers.
function imageInfo(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { format: "png", bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { format: "jpeg", bytes: buf.length, width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return { format: "unknown", bytes: buf.length };
}

async function mcp(url, outDir) {
  const argv = ["npx", "-y", "chrome-devtools-mcp@1.12.0", "--browserUrl", base, "--no-usage-statistics",
    "--no-performance-crux", "--screenshotFormat", "jpeg", "--screenshotMaxWidth", "1280"];
  console.log(`$ ${argv.join(" ")}  (JSON-RPC over stdio)`);
  const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const waiting = new Map();
  (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      }
    }
  })();
  let n = 0;
  const send = (o) => { p.stdin.write(JSON.stringify(o) + "\n"); p.stdin.flush(); };
  const req = (method, params) => new Promise((res, rej) => {
    const i = ++n;
    waiting.set(i, res);
    send({ jsonrpc: "2.0", id: i, method, params });
    setTimeout(() => waiting.delete(i) && rej(new Error(`${method} timed out`)), 120000);
  });
  const tool = async (name, args) => {
    const t0 = Date.now();
    const r = await req("tools/call", { name, arguments: args });
    const content = r.result?.content ?? [];
    console.log(`tools/call ${name} ${JSON.stringify(args)} -> ${Date.now() - t0} ms, isError ${r.result?.isError ?? false}${r.error ? `, error ${r.error.message}` : ""}`);
    return content;
  };
  const text = (content) => content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try {
    const init = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bw-probe", version: "0" } });
    console.log(`serverInfo ${JSON.stringify(init.result?.serverInfo)}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = (await req("tools/list", {})).result.tools;
    console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    for (const name of ["list_pages", "new_page", "select_page", "take_screenshot", "take_snapshot", "click", "close_page"]) {
      const t = tools.find((x) => x.name === name);
      console.log(`  ${name}(${t ? Object.keys(t.inputSchema?.properties ?? {}).join(", ") : "missing"})`);
    }
    console.log(`before new_page: /json/list order and active ${JSON.stringify(await active())}`);
    console.log(`list_pages says:\n${text(await tool("list_pages", {}))}`);
    const opened = text(await tool("new_page", { url, background: true }));
    console.log(`new_page says:\n${opened}`);
    await Bun.sleep(1500);
    console.log(`after new_page: /json/list order and active ${JSON.stringify(await active())}`);
    const line = opened.split("\n").find((l) => l.includes(url)) ?? "";
    const pageId = Number((line.match(/(\d+):/) ?? [])[1]);
    console.log(`pageId of the new page: ${pageId}`);
    const target = (await pages()).find((t) => t.url === url);
    const c = await browser();
    const win = (await c.call("Browser.getWindowForTarget", { targetId: target.id })).result.windowId;
    await c.call("Browser.setWindowBounds", { windowId: win, bounds: { left: 40, top: 60, width: 1700, height: 900 } });
    console.log(`its window ${win} set to 1700 by 900 points, so the screenshot shows --screenshotMaxWidth`);
    c.close();
    await Bun.sleep(1000);
    const shot = await tool("take_screenshot", Number.isFinite(pageId) ? { pageId } : {});
    for (const c of shot) {
      if (c.type === "image") {
        const bytes = Buffer.from(c.data, "base64");
        await Bun.write(`${outDir}/mcp-shot.bin`, bytes);
        console.log(`  image item: mimeType ${c.mimeType}, base64 ${c.data.length} chars, ${JSON.stringify(imageInfo(bytes))}`);
      } else console.log(`  ${c.type} item: ${JSON.stringify(c).slice(0, 300)}`);
    }
    console.log(`after take_screenshot: active ${JSON.stringify(await active())}`);
    const snap = text(await tool("take_snapshot", Number.isFinite(pageId) ? { pageId } : {}));
    console.log(`take_snapshot text: ${snap.length} chars; first lines:\n${snap.split("\n").slice(0, 6).join("\n")}`);
  } finally {
    p.stdin.end();
    p.kill();
    const err = await new Response(p.stderr).text();
    console.log(`server stderr (${err.length} chars), first lines:\n${err.split("\n").slice(0, 4).join("\n")}`);
  }
}

if (cmd === "version") console.log(JSON.stringify(await (await fetch(`${base}/json/version`)).json()));
else if (cmd === "browser") {
  // browser <port> <method> <params json>: one call on the browser target.
  const c = await browser();
  const r = await c.call(rest[0], JSON.parse(rest[1] ?? "{}"));
  c.close();
  console.log(JSON.stringify(r.error ? { error: r.error } : { result: r.result }));
} else if (cmd === "close") {
  const c = await browser();
  c.call("Browser.close").catch(() => {});
  await Bun.sleep(500);
} else if (cmd === "active") {
  const r = await active();
  console.log(`(${r.ms} ms for ${r.pages.length} pages over one browser socket)`);
  for (const p of r.pages) console.log(JSON.stringify(p));
} else if (cmd === "window") {
  // window <port> <url>: opens the page in a new window, as a user's second window.
  const c = await browser();
  console.log(JSON.stringify((await c.call("Target.createTarget", { url: rest[0], newWindow: true })).result));
  c.close();
} else if (cmd === "mcp") await mcp(rest[0], rest[1]);
else if (cmd === "image") console.log(JSON.stringify(imageInfo(Buffer.from(await Bun.stdin.text(), "base64"))));
else { console.error(`unknown command ${cmd}`); process.exit(2); }
process.exit(0);
JS

DOT_PNG=iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGO4IydHEmIY1TAaSnLDNmkAAJozGBASWxyzAAAAAElFTkSuQmCC
cat > "$W/pages.js" << 'JS'
// Test pages for browser-probe.sh: pages.js <port>; binds 127.0.0.1 only.
const png = Buffer.from(process.env.DOT_PNG, "base64");
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const page = (title, head = "", body = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head>` +
  `<body style="margin:0;background:#2a6;font:32px sans-serif"><h1>${title}</h1>${body}</body></html>`;
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2]),
  fetch(req) {
    const path = new URL(req.url).pathname;
    const html = (s) => new Response(s, { headers: { "content-type": "text/html" } });
    if (path === "/icon.png") return new Response(png, { headers: { "content-type": "image/png" } });
    if (path === "/doc.pdf") return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    if (path === "/sw.js") return new Response("self.addEventListener('fetch', () => {});", { headers: { "content-type": "text/javascript" } });
    if (path === "/a.html") return html(page("Probe A", `<link rel="icon" href="data:image/png;base64,${process.env.DOT_PNG}">`));
    if (path === "/b.html") return html(page("Probe B", `<link rel="icon" href="/icon.png">`));
    if (path === "/sw.html") return html(page("Probe SW", "", "<script>navigator.serviceWorker.register('/sw.js')</script>"));
    const m = path.match(/^\/([a-z0-9-]+)\.html$/);
    if (m) return html(page(`Probe ${m[1]}`));
    return new Response("not found", { status: 404 });
  },
});
JS

echo "# Phase 4 browser probe, $(date '+%Y-%m-%d %H:%M %Z'), $(sw_vers -productName) $(sw_vers -productVersion)"
run "$APP/Contents/MacOS/Google Chrome" --version
run npx -y chrome-devtools-mcp@1.12.0 --version
run claude --version
run codex --version
run /usr/sbin/sshd -V
user_before=$(user_chromes)
echo "user's Chrome before (pid ppid start command):"
echo "$user_before"
PORT=$(free_port)
SRV=$(free_port)
echo "scratch profile $PROFILE, debugging port $PORT, page server 127.0.0.1:$SRV"
DOT_PNG=$DOT_PNG bun "$W/pages.js" "$SRV" > "$W/pages.log" 2>&1 &
SRV_PID=$!
wait_port "$SRV" || { echo "FAIL the page server did not start" >&2; exit 1; }

q a "open -n -g starts a second Chrome beside the user's and leaves focus"
front_before=$(front)
echo "before: $front_before"
case $front_before in "front app: loginwindow "*) echo "the screen is locked, so loginwindow stays in front: the focus answers here say only what the app order shows" ;; esac
run open -n -g -a "$APP" --args --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check
t0=$(date +%s)
n=75
until curl -sf --max-time 1 "http://127.0.0.1:$PORT/json/version" > /dev/null; do
  n=$((n - 1))
  [ "$n" -gt 0 ] || { echo "FAIL Chrome did not answer /json/version in 15 s" >&2; exit 1; }
  sleep 0.2
done
echo "/json/version answered after $(($(date +%s) - t0)) s"
CPID=$(listener_pid "$PORT")
ours "$CPID" || { echo "FAIL the listener on $PORT (pid $CPID) is not the probe's Chrome" >&2; exit 1; }
echo "probe Chrome: pid $CPID; its command line holds --user-data-dir=$PROFILE"
user_mid=$(user_chromes)
[ "$user_mid" = "$user_before" ] && pass "the user's Chrome pid and ps line are unchanged" || bad "the user's Chrome changed: $user_mid"
sleep 2
echo "after: $(front)"

q f "SingletonLock while running"
run ls -l "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
lock=$(readlink "$PROFILE/SingletonLock" || true)
echo "SingletonLock -> $lock; Chrome pid $CPID"
case $lock in *-"$CPID") pass "SingletonLock names host-$CPID" ;; *) bad "SingletonLock does not end in -$CPID" ;; esac

q j "lsof -Fpcn for a loopback, a wildcard and another program's listener"
run lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fpcn
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fpcn > "$W/fixtures/lsof-loopback.txt"
echo "another program (the Bun page server) on 127.0.0.1:$SRV:"
run lsof -nP -iTCP:"$SRV" -sTCP:LISTEN -Fpcn
lsof -nP -iTCP:"$SRV" -sTCP:LISTEN -Fpcn > "$W/fixtures/lsof-other.txt"
run ps -ww -o command= -p "$CPID"
echo "(the wildcard listener comes from the scratch sshd in (i))"

q d "PUT /json/new and GET /json/new"
run curl -s -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:$PORT/json/new?http://127.0.0.1:$SRV/get.html"
run curl -s -X PUT -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:$PORT/json/new?http://127.0.0.1:$SRV/a.html"
for p in b.html c.html sw.html doc.pdf; do
  curl -s -X PUT "http://127.0.0.1:$PORT/json/new?http://127.0.0.1:$SRV/$p" | jq -c '{id: .id[0:8], type, url}'
done
run curl -s -X PUT -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:$PORT/json/new?devtools://devtools/bundled/inspector.html"
run curl -s -X PUT -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:$PORT/json/new"
sleep 3
run cdp version "$PORT"
cdp version "$PORT" | jq . > "$W/fixtures/json-version.json"
BID=$(jq -r '.webSocketDebuggerUrl | split("/") | last' "$W/fixtures/json-version.json")
echo "browser id (last segment of webSocketDebuggerUrl): $BID"
echo "WebSocket upgrade with and without an Origin header:"
key=dGhlIHNhbXBsZSBub25jZQ==
run sh -c "curl -s -i --max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: $key' http://127.0.0.1:$PORT/devtools/browser/$BID | head -1"
run sh -c "curl -s -i --max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: $key' -H 'Origin: http://example.com' http://127.0.0.1:$PORT/devtools/browser/$BID | head -2"

q b "/json/list order after /json/activate of the second tab"
listing() { curl -s "http://127.0.0.1:$PORT/json/list" | jq -c '.[] | {type, title, url: .url[0:60], id: .id[0:8], favicon: (.faviconUrl // null | if . then .[0:40] else null end)}'; }
echo "all targets now (opened in order: new tab page, a, b, c, sw, doc.pdf, devtools, blank):"
listing
curl -s "http://127.0.0.1:$PORT/json/list" | jq . > "$W/fixtures/json-list.json"
run cdp active "$PORT"
second=$(curl -s "http://127.0.0.1:$PORT/json/list" | jq -r '[.[] | select(.type == "page" and .title == "Probe B")][0].id')
q c "whether /json/activate brings Chrome to the front"
echo "before: $(front)"
run curl -s -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:$PORT/json/activate/$second"
sleep 1
echo "after: $(front)"
echo "(b) continued: order after activating Probe B ($(printf %s "$second" | cut -c1-8)):"
listing
run cdp active "$PORT"
third=$(curl -s "http://127.0.0.1:$PORT/json/list" | jq -r '[.[] | select(.type == "page" and .title == "Probe A")][0].id')
curl -s "http://127.0.0.1:$PORT/json/activate/$third" > /dev/null
sleep 1
echo "after activating Probe A ($(printf %s "$third" | cut -c1-8)):"
listing
run cdp active "$PORT"
echo "a second window, as a user's (Target.createTarget newWindow: true):"
run cdp window "$PORT" "http://127.0.0.1:$SRV/w2.html"
sleep 1
run cdp active "$PORT"
curl -s "http://127.0.0.1:$PORT/json/activate/$second" > /dev/null
sleep 1
echo "after /json/activate of Probe B (first window):"
run cdp active "$PORT"

q e "Browser.getWindowForTarget, setWindowBounds, and CGWindowList bounds"
run cdp browser "$PORT" Browser.getWindowForTarget "{\"targetId\":\"$second\"}"
WID=$(cdp browser "$PORT" Browser.getWindowForTarget "{\"targetId\":\"$second\"}" | jq -r .result.windowId)
run osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); const n = $.CGMainDisplayID(); const b = $.CGDisplayBounds(n); JSON.stringify({main: n, bounds: b})'
echo "CGWindowList for pid $CPID before: $(windows "$CPID")"
run cdp browser "$PORT" Browser.setWindowBounds "{\"windowId\":$WID,\"bounds\":{\"left\":120,\"top\":140,\"width\":900,\"height\":640}}"
sleep 1
run cdp browser "$PORT" Browser.getWindowBounds "{\"windowId\":$WID}"
echo "CGWindowList for pid $CPID: $(windows "$CPID")"
run cdp browser "$PORT" Browser.setWindowBounds "{\"windowId\":$WID,\"bounds\":{\"windowState\":\"maximized\"}}"
sleep 1
run cdp browser "$PORT" Browser.getWindowBounds "{\"windowId\":$WID}"
echo "setting left/top while maximized:"
run cdp browser "$PORT" Browser.setWindowBounds "{\"windowId\":$WID,\"bounds\":{\"left\":200,\"top\":160,\"width\":800,\"height\":600}}"
sleep 1
run cdp browser "$PORT" Browser.getWindowBounds "{\"windowId\":$WID}"
run cdp browser "$PORT" Browser.setWindowBounds "{\"windowId\":$WID,\"bounds\":{\"windowState\":\"normal\"}}"
sleep 1
run cdp browser "$PORT" Browser.setWindowBounds "{\"windowId\":$WID,\"bounds\":{\"left\":200,\"top\":160,\"width\":800,\"height\":600}}"
sleep 1
run cdp browser "$PORT" Browser.getWindowBounds "{\"windowId\":$WID}"
echo "CGWindowList for pid $CPID: $(windows "$CPID")"

q g "chrome-devtools-mcp 1.12.0 over --browserUrl: new_page with background: true"
mkdir "$W/mcp"
cdp mcp "$PORT" "http://127.0.0.1:$SRV/mcp.html" "$W/mcp" 2>&1 || echo "(exit $?)"
echo "after the MCP run: $(front)"

if [ "$agents" = 1 ]; then
  q h "Claude's JSONL and Codex's rollout and take_screenshot's image"
  MCP_ARGS=$(jq -cn --arg u "http://127.0.0.1:$PORT" '["-y","chrome-devtools-mcp@1.12.0","--browserUrl",$u,"--no-usage-statistics","--no-performance-crux","--screenshotFormat","jpeg","--screenshotMaxWidth","1280"]')
  mkdir "$W/p4-claude" "$W/p4-codex" "$W/feed-home"
  git -C "$W/p4-claude" init -q
  git -C "$W/p4-codex" init -q
  jq -n --argjson a "$MCP_ARGS" '{mcpServers: {"bw-browser": {type: "stdio", command: "npx", args: $a}}}' > "$W/claude-mcp.json"
  slug=$(printf %s "$W/p4-claude" | sed 's/[^A-Za-z0-9]/-/g')
  [ -e "$HOME/.claude/projects/$slug" ] || claude_proj=$HOME/.claude/projects/$slug
  [ -e "/private/tmp/claude-$(id -u)/$slug" ] || claude_pad=/private/tmp/claude-$(id -u)/$slug
  clean HC_SESSION="$CORE" hc server status > /dev/null
  core_up=1
  sid=$(uuidgen | tr 'A-Z' 'a-z')
  prompt_for() {
    echo "Use the bw-browser MCP tools (load them with ToolSearch if they are deferred). First call new_page with url http://127.0.0.1:$SRV/$1.html and background true. Then call take_screenshot with the pageId of that new page. Then reply with the single word done."
  }
  echo "$ hc run (private core $CORE) -- env -u ANTHROPIC_API_KEY claude --session-id <uuid> --setting-sources project --strict-mcp-config --mcp-config claude-mcp.json --allowedTools mcp__bw-browser --model haiku -p '<new_page then take_screenshot>'"
  hcr run --bg --json --no-parent --no-notify --name p4-claude --cwd "$W/p4-claude" -- env -u ANTHROPIC_API_KEY claude \
    --session-id "$sid" --setting-sources project --strict-mcp-config --mcp-config "$W/claude-mcp.json" \
    --allowedTools mcp__bw-browser --model haiku -p "$(prompt_for agent-claude)" > /dev/null
  hcr wait p4-claude --timeout 300 > /dev/null 2>&1 || true
  echo "claude's screen, last lines:"
  hcr read p4-claude --lines 8 2>&1 | sed '/^[[:space:]]*$/d' | tail -4
  log=$HOME/.claude/projects/$slug/$sid.jsonl
  if [ -f "$log" ]; then
    echo "Claude log: $(wc -l < "$log" | tr -d ' ') lines, $(wc -c < "$log" | tr -d ' ') bytes"
    echo "tool calls: $(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$log" | tr '\n' ' ')"
    echo "lines that carry an image, shape only:"
    jq -c "select(tostring | test(\"\\\"type\\\":\\\"image\\\"\")) | {type, keys: keys, content: .message.content, toolUseResult} | $TRUNC" "$log"
    jq -r '.. | objects | select(.type == "image") | .source.data // empty' "$log" | while read -r d; do
      echo "  image: $(printf %s "$d" | cdp image 0)"
    done
    if [ -x "$src/target/debug/bw" ]; then
      echo "$ HERDR_APP_HOME=<scratch> bw feed --log <claude log> --agent claude --pictures   (tools rows)"
      HERDR_APP_HOME=$W/feed-home "$src/target/debug/bw" feed --log "$log" --agent claude --pictures 2>&1 |
        jq -c 'select(.k == "tools") | {sentence, calls: [.chips[]?.calls[]?.name], pics}' || true
    fi
  else
    bad "no Claude log at $log"
  fi

  mkdir -m 700 "$CH"
  cp "$HOME/.codex/auth.json" "$CH/auth.json"
  : > "$CH/config.toml"
  # codex_case <page> <how the prompt says to return the screenshot>: one codex exec, then its rollout.
  codex_case() {
    touch "$W/codex-mark"
    sleep 1
    echo "$ hc run (private core $CORE) -- env CODEX_HOME=<scratch> codex exec --skip-git-repo-check -m gpt-6-luna -c model_reasoning_effort=\"low\" -s read-only -c mcp_servers.bw-browser.command=\"npx\" -c mcp_servers.bw-browser.args=[…] -c mcp_servers.bw-browser.default_tools_approval_mode=\"approve\" -c mcp_servers.bw-browser.startup_timeout_sec=60 '<new_page then take_screenshot$2>'"
    hcr run --bg --json --no-parent --no-notify --name p4-codex --cwd "$W/p4-codex" -- env CODEX_HOME="$CH" codex exec \
      --skip-git-repo-check -m gpt-6-luna -c 'model_reasoning_effort="low"' -s read-only \
      -c 'mcp_servers.bw-browser.command="npx"' -c "mcp_servers.bw-browser.args=$MCP_ARGS" \
      -c 'mcp_servers.bw-browser.default_tools_approval_mode="approve"' -c mcp_servers.bw-browser.startup_timeout_sec=60 \
      "$(prompt_for "$1")$2" > /dev/null
    hcr wait p4-codex --timeout 300 > /dev/null 2>&1 || true
    echo "codex's screen, last lines:"
    hcr read p4-codex --lines 8 2>&1 | sed '/^[[:space:]]*$/d' | tail -4
    hcr rm p4-codex > /dev/null 2>&1 || true
    for r in $(find "$CH/sessions" -name 'rollout-*.jsonl' -newer "$W/codex-mark" 2> /dev/null); do
      echo "Codex rollout: $(wc -l < "$r" | tr -d ' ') lines, $(wc -c < "$r" | tr -d ' ') bytes"
      echo "exec inputs: $(jq -c 'select(.type == "response_item" and .payload.type == "custom_tool_call") | .payload.input' "$r" | tr '\n' ' ')"
      echo "lines that name take_screenshot or carry an image, shape only:"
      jq -c "select(tostring | test(\"take_screenshot|image\")) | select(.type != \"session_meta\" and .type != \"turn_context\" and .type != \"world_state\") | select(.payload.type != \"additional_tools\" and .payload.type != \"message\") | {type, payload: .payload} | $TRUNC" "$r" | cut -c1-900
      echo "custom_tool_call_output text items over 1000 chars, first 100 chars each:"
      jq -r 'select(.type == "response_item" and .payload.type == "custom_tool_call_output") | .payload.output[]? | select(.type == "input_text") | .text | select(length > 1000) | "  \(length) chars: \(.[0:100] | gsub("\n"; "\\n"))"' "$r"
      echo "input_image items anywhere in the rollout: $(jq '[.. | objects | select(.type == "input_image")] | length' "$r" | awk '{s += $1} END {print s}')"
      jq -r '.. | strings | select(startswith("data:image/")) | sub("^data:image/[a-z]+;base64,"; "")' "$r" | sort -u | while read -r d; do
        echo "  data: URL image: $(printf %s "$d" | cdp image 0)"
      done
      jq -r '.. | objects | select(.type == "image" and .data) | .data' "$r" | sort -u | while read -r d; do
        echo "  image item: $(printf %s "$d" | cdp image 0)"
      done
      if [ -x "$src/target/debug/bw" ]; then
        echo "$ HERDR_APP_HOME=<scratch> bw feed --log <codex rollout> --agent codex --pictures   (tools rows)"
        HERDR_APP_HOME=$W/feed-home "$src/target/debug/bw" feed --log "$r" --agent codex --pictures 2>&1 |
          jq -c 'select(.k == "tools") | {sentence, calls: [.chips[]?.calls[]?.name], pics}' || true
      fi
    done
  }
  codex_case agent-codex ""
  echo "the same, asking Codex to show the picture with exec's image() helper:"
  codex_case agent-codex-image " In the exec tool, pass the screenshot's image block to image(...) so you see it, and do not text() the result."
  echo "tabs after both agents:"
  listing
  run cdp active "$PORT"
  for t in p4-claude p4-codex; do hcr kill "$t" > /dev/null 2>&1 || true; hcr rm "$t" > /dev/null 2>&1 || true; done
  hcr server stop > /dev/null 2>&1 || true
  core_up=0
  rm -rf "$CH"
  [ -z "$claude_proj" ] || rm -rf "$claude_proj"
  [ -z "$claude_pad" ] || rm -rf "$claude_pad"
fi

q i "lib-sshd.sh as the user, and ssh -N -R 127.0.0.1:<p>:127.0.0.1:<chrome port>"
eval "$(sshd_up "$W/sshd")"
echo "SSH_CONFIG=<scratch>/sshd/ssh_config SSH_TARGET=$SSH_TARGET, sshd on 127.0.0.1:$(cat "$W/sshd/port")"
run ps -ww -o user=,pid=,command= -p "$(cat "$W/sshd/sshd.pid")"
FP=$(free_port)
echo "$ ssh -F <scratch>/ssh_config -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -N -R 127.0.0.1:$FP:127.0.0.1:$PORT $SSH_TARGET"
ssh -F "$SSH_CONFIG" -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ControlMaster=no -o ControlPath=none -N -R "127.0.0.1:$FP:127.0.0.1:$PORT" "$SSH_TARGET" < /dev/null > "$W/ssh-r.log" 2>&1 &
ssh_pids="$ssh_pids $!"
if wait_port "$FP"; then
  run lsof -nP -iTCP:"$FP" -sTCP:LISTEN -Fpcn
  owner=$(listener_pid "$FP")
  run ps -ww -o user=,pid=,ppid=,command= -p "$owner"
  fwd_id=$(curl -s --max-time 3 "http://127.0.0.1:$FP/json/version" | jq -r '.webSocketDebuggerUrl | split("/") | last')
  echo "browser id through the forward: $fwd_id"
  [ "$fwd_id" = "$BID" ] && pass "the forward reaches the probe Chrome" || bad "the forward answered $fwd_id"
  lsof -nP -iTCP:"$FP" -sTCP:LISTEN -Fn | grep -qx "n127.0.0.1:$FP" && pass "lsof shows n127.0.0.1:$FP" || bad "lsof does not show n127.0.0.1:$FP"
else
  bad "ssh -R opened no listener on $FP"
  cat "$W/ssh-r.log"
fi
CLOSED=$(free_port)
FP2=$(free_port)
echo "GatewayPorts no, client asks for 0.0.0.0 (forwarded to a closed port, $CLOSED):"
ssh -F "$SSH_CONFIG" -o ExitOnForwardFailure=yes -o BatchMode=yes -N -R "0.0.0.0:$FP2:127.0.0.1:$CLOSED" "$SSH_TARGET" < /dev/null > "$W/ssh-r2.log" 2>&1 &
ssh_pids="$ssh_pids $!"
wait_port "$FP2" && run lsof -nP -iTCP:"$FP2" -sTCP:LISTEN -Fpcn || { bad "no listener on $FP2"; cat "$W/ssh-r2.log"; }
echo "the same port asked for again while it is held (ExitOnForwardFailure):"
run ssh -F "$SSH_CONFIG" -o ExitOnForwardFailure=yes -o BatchMode=yes -N -R "127.0.0.1:$FP2:127.0.0.1:$CLOSED" "$SSH_TARGET"
echo "BatchMode with a key the server does not accept:"
ssh-keygen -q -t ed25519 -N '' -f "$W/stranger"
# A copy of the scratch config with only the IdentityFile changed, so known_hosts stays the scratch one.
sed "s|IdentityFile .*|IdentityFile $W/stranger|" "$SSH_CONFIG" > "$W/stranger_config"
run ssh -F "$W/stranger_config" -o BatchMode=yes -o ConnectTimeout=5 -o ExitOnForwardFailure=yes \
  -N -R "127.0.0.1:$(free_port):127.0.0.1:$CLOSED" "$SSH_TARGET"

echo "GatewayPorts yes (a second scratch sshd), client asks for 127.0.0.1:"
eval "$(BW_SSHD_GATEWAY_PORTS=yes sshd_up "$W/sshd-gw")"
FP3=$(free_port)
ssh -F "$SSH_CONFIG" -o ExitOnForwardFailure=yes -o BatchMode=yes -N -R "127.0.0.1:$FP3:127.0.0.1:$CLOSED" "$SSH_TARGET" < /dev/null > "$W/ssh-r3.log" 2>&1 &
ssh_pids="$ssh_pids $!"
if wait_port "$FP3"; then
  run lsof -nP -iTCP:"$FP3" -sTCP:LISTEN -Fpcn
  lsof -nP -iTCP:"$FP3" -sTCP:LISTEN -Fpcn > "$W/fixtures/lsof-wildcard.txt"
else
  bad "no listener on $FP3"
  cat "$W/ssh-r3.log"
fi
for p in $ssh_pids; do kill "$p" 2> /dev/null || true; done
ssh_pids=
sleep 1
for p in "$FP" "$FP2" "$FP3"; do
  lsof -nP -iTCP:"$p" -sTCP:LISTEN > /dev/null 2>&1 && bad "a listener on $p outlived its ssh" || pass "no listener on $p after ssh exits"
done
sshd_down "$W/sshd"
sshd_down "$W/sshd-gw"
pgrep -f 'sshd.*bw-probe' > /dev/null && bad "a scratch sshd is still running" || pass "no scratch sshd left"

q k "Codex 0.167 and -c mcp_servers.bw-browser.startup_timeout_sec=60"
mkdir -m 700 "$CH"
: > "$CH/config.toml"
run env CODEX_HOME="$CH" codex -c 'mcp_servers.bw-browser.command="sh"' -c 'mcp_servers.bw-browser.args=["/x/browser-mcp","w1"]' \
  -c 'mcp_servers.bw-browser.default_tools_approval_mode="approve"' -c mcp_servers.bw-browser.startup_timeout_sec=60 mcp get bw-browser --json
run env CODEX_HOME="$CH" codex -c 'mcp_servers.bw-browser.command="sh"' -c mcp_servers.bw-browser.startup_timeout_sec=60 mcp list
echo "an invalid value, for comparison:"
run env CODEX_HOME="$CH" codex -c 'mcp_servers.bw-browser.command="sh"' -c 'mcp_servers.bw-browser.startup_timeout_sec="sixty"' mcp get bw-browser --json
rm -rf "$CH"

q end "stopping the probe Chrome with CDP Browser.close"
run cdp close "$PORT"
n=50
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 && [ "$n" -gt 0 ]; do sleep 0.2; n=$((n - 1)); done
sleep 2
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 && bad "port $PORT still listens" || pass "port $PORT closed"
pgrep -f -- "--user-data-dir=$PROFILE" > /dev/null && bad "a Chrome on the scratch profile is still running" || pass "no Chrome on the scratch profile"
[ -e "$PROFILE/SingletonLock" ] || [ -L "$PROFILE/SingletonLock" ] && echo "SingletonLock after Browser.close: still there -> $(readlink "$PROFILE/SingletonLock")" ||
  echo "SingletonLock after Browser.close: removed"
user_after=$(user_chromes)
echo "user's Chrome after:"
echo "$user_after"
[ "$user_after" = "$user_before" ] && pass "the user's Chrome pid and ps line are unchanged" || bad "the user's Chrome changed"
lsof -nP -iTCP:9222 -sTCP:LISTEN > /dev/null 2>&1 && echo "note: something listens on 9222 (not the probe's)" || echo "nothing listens on 9222"

if [ -n "${BW_PROBE_FIXTURES:-}" ]; then
  mkdir -p "$BW_PROBE_FIXTURES"
  cp "$W"/fixtures/* "$BW_PROBE_FIXTURES"/
  echo "fixtures copied to $BW_PROBE_FIXTURES"
fi
exit "$fail"
