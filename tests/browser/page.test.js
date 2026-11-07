import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pickPage } from "./cdp.js";

const here = new URL(".", import.meta.url).pathname;
const serverJs = join(here, "server.js");
const cdpJs = join(here, "cdp.js");
const pageHtml = join(here, "page.html");

/** @type {Array<() => void | Promise<void>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "bw-page-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Reads stdout until the first full line. */
async function firstLine(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0];
}

/** Starts server.js on a free port; the cleanup stops it and checks it exits 0. */
async function startServer(log) {
  const proc = Bun.spawn([process.execPath, serverJs, "--port", "0", "--log", log], {
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await proc.exited;
  });
  const ready = JSON.parse(await firstLine(proc.stdout));
  expect(ready.type).toBe("ready");
  return { proc, port: ready.port };
}

/** Resolves true when a TCP connect to host:port succeeds. */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 1000 });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}

describe("server.js", () => {
  test("server serves the page and logs a click", async () => {
    const log = join(scratch(), "clicks.jsonl");
    const { port } = await startServer(log);
    const base = `http://127.0.0.1:${port}`;

    const page = await fetch(`${base}/page.html?who=t1`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe(readFileSync(pageHtml, "utf8"));

    const body = { who: "t1", button: 3, at_ms: 1762500000000, trusted: false };
    const post = await fetch(`${base}/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(post.status).toBe(204);
    expect((await fetch(`${base}/click`, { method: "POST", body: "not json" })).status).toBe(400);

    const lines = (await (await fetch(`${base}/clicks`)).text()).split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l))).toEqual([body]);
    expect(JSON.parse(lines[0])).toMatchObject({ who: "t1", button: 3 });
    expect(readFileSync(log, "utf8")).toBe(`${JSON.stringify(body)}\n`);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  test("server binds loopback only", async () => {
    const { proc, port } = await startServer(join(scratch(), "clicks.jsonl"));
    expect(await canConnect("127.0.0.1", port)).toBe(true);

    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal && a.family === "IPv4")
      .map((a) => a.address);
    const lsof = Bun.which("lsof");
    expect(lan.length > 0 || lsof !== null).toBe(true);
    for (const addr of lan) expect(await canConnect(addr, port)).toBe(false);
    if (lsof) {
      const out = Bun.spawnSync([lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]).stdout.toString();
      const names = out.split("\n").filter((l) => l.startsWith("n"));
      expect(names).toEqual([`n127.0.0.1:${port}`]);
    }

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(await canConnect("127.0.0.1", port)).toBe(false);
  });

  test("server refuses a missing --log with a usage line", async () => {
    const proc = Bun.spawn([process.execPath, serverJs, "--port", "0"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
    expect((await new Response(proc.stderr).text()).trim().split("\n")).toHaveLength(1);
  });
});

describe("page.html", () => {
  test("page has nine buttons and a log", async () => {
    const html = readFileSync(pageHtml, "utf8");
    let title = "";
    /** @type {Array<{id: string, text: string}>} */
    const buttons = [];
    let logs = 0;
    let script = "";
    let style = "";
    await new HTMLRewriter()
      .on("title", {
        text: (t) => {
          title += t.text;
        },
      })
      .on("button", {
        element(el) {
          buttons.push({ id: el.getAttribute("id") ?? "", text: "" });
        },
        text(t) {
          buttons[buttons.length - 1].text += t.text;
        },
      })
      .on("ol#log", {
        element: () => {
          logs += 1;
        },
      })
      .on("script", {
        text: (t) => {
          script += t.text;
        },
      })
      .on("style", {
        text: (t) => {
          style += t.text;
        },
      })
      .transform(new Response(html))
      .text();

    expect(title).toBe("Bellwether test page");
    expect(buttons).toEqual(Array.from({ length: 9 }, (_, i) => ({ id: `b${i + 1}`, text: `Button ${i + 1}` })));
    expect(logs).toBe(1);
    expect(style).toMatch(/button\s*\{[^}]*width:\s*120px;[^}]*height:\s*48px;/);
    expect(script.length).toBeGreaterThan(0);
  });

  test("a click shows in the log and posts who, button, time and trust", async () => {
    const html = readFileSync(pageHtml, "utf8");
    let script = "";
    await new HTMLRewriter()
      .on("script", {
        text: (t) => {
          script += t.text;
        },
      })
      .transform(new Response(html))
      .text();

    /** Runs the page script against a small fake DOM and returns its parts. */
    function load(search) {
      const listeners = new Map();
      const items = [];
      const posts = [];
      const el = (id) => ({ id, textContent: "", addEventListener: (_, f) => listeners.set(id, f) });
      const nodes = new Map(
        ["who", "log", ...Array.from({ length: 9 }, (_, i) => `b${i + 1}`)].map((id) => [id, el(id)]),
      );
      nodes.get("log").append = (li) => items.push(li);
      const document = {
        getElementById: (id) => nodes.get(id) ?? null,
        querySelectorAll: () => [...nodes.values()].filter((n) => /^b\d$/.test(n.id)),
        createElement: () => ({ textContent: "" }),
      };
      const fakeFetch = (url, init) => {
        posts.push({ url, init });
        return Promise.resolve({ ok: true });
      };
      new Function("document", "location", "fetch", script)(document, { search }, fakeFetch);
      return { listeners, items, posts, nodes };
    }

    const a = load("?who=claude-p");
    expect(a.nodes.get("who").textContent).toBe("claude-p");
    const before = Date.now();
    a.listeners.get("b3")({ isTrusted: true });
    expect(a.items.map((i) => i.textContent)).toEqual(["Button 3 clicked (claude-p)"]);
    expect(a.posts).toHaveLength(1);
    expect(a.posts[0].url).toBe("/click");
    expect(a.posts[0].init.method).toBe("POST");
    const sent = JSON.parse(a.posts[0].init.body);
    expect(Object.keys(sent).sort()).toEqual(["at_ms", "button", "trusted", "who"]);
    expect(sent).toMatchObject({ who: "claude-p", button: 3, trusted: true });
    expect(sent.at_ms).toBeGreaterThanOrEqual(before);

    const b = load("");
    b.listeners.get("b9")({ isTrusted: false });
    expect(b.items[0].textContent).toBe("Button 9 clicked (none)");
    expect(JSON.parse(b.posts[0].init.body)).toMatchObject({ who: "none", button: 9, trusted: false });
  });
});

/**
 * A fake Chrome: `/json/list` and one page WebSocket per target id. It sends an
 * event before each reply, as Chrome may.
 */
function fakeChrome(pages, { wsHost } = {}) {
  /** @type {Array<{target: string, origin: string | null, method: string, params: any}>} */
  const calls = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/list") {
        const host = wsHost ?? `127.0.0.1:${srv.port}`;
        return Response.json(pages.map((p) => ({ ...p, webSocketDebuggerUrl: `ws://${host}/devtools/page/${p.id}` })));
      }
      const m = url.pathname.match(/^\/devtools\/page\/(.+)$/);
      if (m && srv.upgrade(req, { data: { target: m[1], origin: req.headers.get("origin") } })) return;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        calls.push({ target: ws.data.target, origin: ws.data.origin, method: msg.method, params: msg.params });
        ws.send(JSON.stringify({ method: "Page.frameNavigated", params: {} }));
        ws.send(JSON.stringify({ id: msg.id + 1000, result: {} }));
        const result =
          msg.method === "Runtime.evaluate" ? { result: { type: "object", value: { x: 75, y: 130 } } } : {};
        ws.send(JSON.stringify({ id: msg.id, result }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port, calls };
}

async function runCdp(args) {
  const proc = Bun.spawn([process.execPath, cdpJs, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
}

const tabs = [
  { id: "SW1", type: "service_worker", url: "http://127.0.0.1:1/page.html?who=b" },
  { id: "A1", type: "page", url: "http://127.0.0.1:1/page.html?who=a" },
  { id: "B2", type: "page", url: "http://127.0.0.1:1/page.html?who=b" },
  { id: "C3", type: "page", url: "http://127.0.0.1:1/page.html?who=bb" },
];

describe("cdp.js", () => {
  test("cdp.js picks the tab by who", async () => {
    const chrome = fakeChrome(tabs);
    const r = await runCdp(["--port", String(chrome.port), "--who", "b", "--click", "7"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toEqual({ type: "cdp-click", who: "b", button: 7, target: "B2", x: 75, y: 130 });

    expect(chrome.calls.every((c) => c.target === "B2")).toBe(true);
    // Chrome refuses a DevTools WebSocket whose Origin it does not allow.
    expect(chrome.calls.every((c) => c.origin === null)).toBe(true);
    expect(chrome.calls.map((c) => c.method)).toEqual([
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    const [evaluate, press, release] = chrome.calls.map((c) => c.params);
    expect(evaluate.expression).toContain('"#b7"');
    expect(evaluate.returnByValue).toBe(true);
    expect(press).toEqual({ type: "mousePressed", x: 75, y: 130, button: "left", buttons: 1, clickCount: 1 });
    expect(release).toEqual({ type: "mouseReleased", x: 75, y: 130, button: "left", buttons: 0, clickCount: 1 });
  });

  test("cdp.js refuses no match, two matches and a non-loopback WebSocket", async () => {
    const none = await runCdp(["--port", String(fakeChrome(tabs).port), "--who", "z", "--click", "1"]);
    expect(none.code).toBe(1);
    expect(none.err.trim().split("\n")).toHaveLength(1);
    expect(none.err).toContain("who=z");

    const two = fakeChrome([...tabs, { id: "B4", type: "page", url: "http://127.0.0.1:1/page.html?who=b" }]);
    const dup = await runCdp(["--port", String(two.port), "--who", "b", "--click", "1"]);
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("2 tabs");
    expect(two.calls).toEqual([]);

    const far = fakeChrome(tabs, { wsHost: "10.0.0.9:9222" });
    const remote = await runCdp(["--port", String(far.port), "--who", "a", "--click", "1"]);
    expect(remote.code).toBe(1);
    expect(remote.err).toContain("loopback");

    const bad = await runCdp(["--port", "1", "--who", "a", "--click", "10"]);
    expect(bad.code).toBe(2);
  });

  test("pickPage matches the who value exactly and skips non-pages", () => {
    expect(pickPage(tabs, "b").id).toBe("B2");
    expect(pickPage(tabs, "bb").id).toBe("C3");
    expect(() => pickPage(tabs, "")).toThrow();
  });
});
