// Stands in for the user's own click: presses and releases the mouse on #b<n> of the
// one Chrome tab whose URL has who=<w>, through CDP on 127.0.0.1.
//   bun tests/browser/cdp.js --port <p> --who <w> --click <n>
// Prints {"type":"cdp-click","who","button","target","x","y"}; a failure prints one stderr line and exits 1.

const USAGE = "usage: bun tests/browser/cdp.js --port <p> --who <w> --click <1-9>";
const TIMEOUT_MS = 10000;

/**
 * @typedef {object} Target
 * @property {string} id
 * @property {string} type
 * @property {string} url
 * @property {string} [webSocketDebuggerUrl]
 */

/**
 * The one page target whose URL's `who` query value is exactly `who`.
 * @param {Target[]} list
 * @param {string} who
 * @returns {Target}
 */
export function pickPage(list, who) {
  if (!who) throw new Error("who is empty");
  const hits = list.filter((t) => {
    if (t.type !== "page") return false;
    try {
      return new URL(t.url).searchParams.get("who") === who;
    } catch {
      return false;
    }
  });
  if (hits.length === 0) throw new Error(`no Chrome tab has who=${who} in its URL`);
  // Two tabs with one who would make the click land in a tab the test cannot name.
  if (hits.length > 1) throw new Error(`${hits.length} tabs have who=${who}: ${hits.map((t) => t.id).join(", ")}`);
  return hits[0];
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{port?: number, who?: string, click?: number}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1] ?? ""];
    if (flag === "--port" && /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)
      out.port = Number(value);
    else if (flag === "--who" && value) out.who = value;
    else if (flag === "--click" && /^[1-9]$/.test(value)) out.click = Number(value);
    else return null;
  }
  return out.port === undefined || !out.who || out.click === undefined ? null : out;
}

/**
 * A CDP session on one WebSocket: numbered calls, events skipped.
 * @param {string} url
 */
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 1;
    /** @type {Map<number, {resolve: (v: unknown) => void, reject: (e: Error) => void}>} */
    const waiting = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message ?? "CDP error"}`));
      else w.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onclose = () => {
      for (const w of waiting.values()) w.reject(new Error("the tab's WebSocket closed"));
      waiting.clear();
    };
    ws.onopen = () =>
      resolve({
        /** @param {string} method @param {object} params */
        call(method, params) {
          const id = next++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => waiting.set(id, { resolve: res, reject: rej }));
        },
        close: () => ws.close(),
      });
  });
}

/** @param {{port: number, who: string, click: number}} args */
async function main({ port, who, click }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`/json/list answered ${res.status}`);
  const target = pickPage(await res.json(), who);
  const ws = target.webSocketDebuggerUrl ?? "";
  if (!/^ws:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(ws)) {
    throw new Error(`tab ${target.id} has a WebSocket that is not on loopback: ${ws || "none"}`);
  }
  const cdp = await open(ws);
  try {
    const selector = JSON.stringify(`#b${click}`);
    const expression = `(() => {
      const b = document.querySelector(${selector});
      if (!b) return null;
      b.scrollIntoView({ block: "center", inline: "center" });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`;
    const evaluated = await cdp.call("Runtime.evaluate", { expression, returnByValue: true });
    const point = evaluated?.result?.value;
    if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
      throw new Error(`tab ${target.id} has no #b${click}`);
    }
    const { x, y } = point;
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    console.log(JSON.stringify({ type: "cdp-click", who, button: click, target: target.id, x, y }));
  } finally {
    cdp.close();
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const timer = setTimeout(() => {
    console.error(`cdp.js: no answer within ${TIMEOUT_MS} ms`);
    process.exit(1);
  }, TIMEOUT_MS);
  main(args).then(
    () => {
      clearTimeout(timer);
      process.exit(0);
    },
    (e) => {
      clearTimeout(timer);
      console.error(`cdp.js: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
