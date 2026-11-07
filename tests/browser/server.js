// Serves the browser test page on 127.0.0.1 and logs its clicks, one JSON line each.
//   bun tests/browser/server.js --port <p> --log <file>
// Port 0 picks a free port; the first stdout line is {"type":"ready","port","url"}.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const USAGE = "usage: bun tests/browser/server.js --port <p> --log <file>";
const MAX_BODY = 4096;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{port?: number, log?: string}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--port" && /^\d{1,5}$/.test(value ?? "") && Number(value) <= 65535) out.port = Number(value);
    else if (flag === "--log" && value) out.log = value;
    else return null;
  }
  return out.port === undefined || !out.log ? null : out;
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error(USAGE);
  process.exit(2);
}
const { port, log } = args;
const page = readFileSync(new URL("./page.html", import.meta.url));
if (!existsSync(log)) writeFileSync(log, "");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/page.html") {
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (req.method === "GET" && pathname === "/clicks") {
      return new Response(readFileSync(log), { headers: { "content-type": "application/x-ndjson" } });
    }
    if (req.method === "POST" && pathname === "/click") {
      const text = await req.text();
      if (text.length > MAX_BODY) return new Response("body too large\n", { status: 413 });
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response("body is not JSON\n", { status: 400 });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return new Response("body is not a JSON object\n", { status: 400 });
      }
      // Re-serialised so a body with newlines still takes exactly one line.
      appendFileSync(log, `${JSON.stringify(body)}\n`);
      return new Response(null, { status: 204 });
    }
    return new Response("not found\n", { status: 404 });
  },
});

const stop = () => {
  server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

console.log(JSON.stringify({ type: "ready", port: server.port, url: `http://127.0.0.1:${server.port}/page.html` }));
