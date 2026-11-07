// Done check 2's checks. Run by scripts/verify/sessions.sh, which builds bw, makes the scratch
// folders and the private core, and deletes them.
//   bun sessions-run.js --bw B --offline
//   bun sessions-run.js --bw B --scratch L --core C [--machine M --remote-root R]
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHelper, parseLines } from "../../shared/helper.js";

const { values: opt } = parseArgs({
  options: {
    bw: { type: "string" },
    offline: { type: "boolean" },
    scratch: { type: "string" },
    core: { type: "string" },
    machine: { type: "string" },
    "remote-root": { type: "string" },
  },
});
if (!opt.bw || (!opt.offline && (!opt.scratch || !opt.core)) || (opt.machine && !opt["remote-root"])) {
  console.error("usage: bun sessions-run.js --bw B (--offline | --scratch L --core C [--machine M --remote-root R])");
  process.exit(2);
}
const BW = opt.bw;
const HC = process.env.BW_HC || "hc";
const REPO = join(import.meta.dir, "../..");
const SESSIONS = join(REPO, "tests/fixtures/sessions");
const FEEDS = join(REPO, "tests/fixtures/feed");
const SCENARIOS = ["claude-subagents", "claude-picture", "claude-approval", "codex-subagent", "codex-question", "codex-approval"];
// 2026-11-07T00:00:00Z, as the goldens were made (tests/fixtures/feed/README.md).
const NOW_MS = "1794009600000";
const CLAUDE = ["claude", "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config"];
const CODEX_FLAGS = ["-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-a", "never", "-s", "workspace-write"];
const AGENT_PATH = `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const DOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGO4IydHEmIY1TAaSnLDNmkAAJozGBASWxyzAAAAAElFTkSuQmCC";
const RUN_HELPER = 'exec "$HOME"/.local/share/bellwether/helper/current/bw "$@"';

let failed = false;
const pass = (/** @type {string} */ name, /** @type {string} */ what) => console.log(`PASS ${name}: ${what}`);
const fail = (/** @type {string} */ name, /** @type {string} */ why) => {
  failed = true;
  console.log(`FAIL ${name}: ${why}`);
};
const pending = (/** @type {string} */ name, /** @type {string} */ why) => console.log(`PENDING ${name}: ${why}`);
const short = (/** @type {unknown} */ v) => JSON.stringify(v).slice(0, 300);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */

/** @param {string[]} argv @param {{ env?: Record<string, string>, stdin?: Blob }} [o] @returns {Promise<ExecResult>} */
async function spawn(argv, o = {}) {
  const p = Bun.spawn(argv, { stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: o.env ?? process.env });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** `process.env` with `set` applied; an undefined value removes the variable. @param {Record<string, string | undefined>} set */
function envWith(set) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries({ ...process.env, ...set })) if (v !== undefined) env[k] = v;
  return env;
}
/** The user's own core, for the other machine. */
const USER_ENV = envWith({ HC_SESSION: undefined });
/** The private core and a scratch cache, for this Mac's agents. */
const PRIVATE_ENV = envWith({ HC_SESSION: opt.core, BW_CACHE_DIR: opt.scratch ? join(opt.scratch, "cache") : undefined });

/** @param {string} stdout */
function lines(stdout) {
  try {
    return parseLines(stdout);
  } catch {
    return [];
  }
}

/** `bw <args>` here, against the private core. @param {string[]} args @param {Record<string, string>} [extra] */
async function bwHere(args, extra = {}) {
  const r = await spawn([BW, ...args], { env: { ...PRIVATE_ENV, ...extra } });
  return lines(r.stdout);
}

/** `hc <args>` against the private core. @param {string[]} args */
const hcHere = (args) => spawn([HC, ...args], { env: PRIVATE_ENV });
/** `hc <args>` against the user's core. @param {string[]} args */
const hcUser = (args) => spawn([HC, ...args], { env: USER_ENV });

// Rejects like Herdr's exec when hc cannot reach the machine; otherwise the program's own result.
/** @param {string} machine @param {string} cmd @param {string[]} args @returns {Promise<ExecResult>} */
async function viaHc(machine, cmd, args) {
  const r = await hcUser(["exec", "--json", "--on", machine, "--", cmd, ...args]);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error(`hc exec --on ${machine}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
  if (j.error) throw new Error(`hc exec --on ${machine}: ${j.error.message}`);
  const text = (/** @type {string} */ b64) => Buffer.from(b64 ?? "", "base64").toString("utf8");
  return { code: j.code ?? 1, stdout: text(j.stdout), stderr: text(j.stderr) };
}

/** What a log's rows hold, for comparing with expect.json. @param {any[]} rows */
function counts(rows) {
  const n = (/** @type {string} */ k) => rows.filter((r) => r.k === k).length;
  const calls = rows.filter((r) => r.k === "tools").flatMap((r) => r.chips).reduce((s, c) => s + c.calls.length, 0);
  const pics = rows.reduce((s, r) => s + (r.pics?.length ?? 0), 0);
  return { user_messages: n("user"), assistant_messages: n("assistant"), tool_calls: calls + n("question"), pictures: pics };
}

const SCRUBBED_AGENTS = '"type":"input_text","text":"[scrubbed: AGENTS.md instructions removed by scrub-fixture]"';
/** The Codex AGENTS.md message as Codex writes it, same length (crates/bw/tests/feed.rs `as_written`). @param {string} log */
function asWritten(log) {
  const head = '"type":"input_text","text":"# AGENTS.md instructions, scrubbed';
  return log.replaceAll(SCRUBBED_AGENTS, head.padEnd(SCRUBBED_AGENTS.length - 1, " ") + '"');
}

async function offline() {
  const tmp = (await spawn(["mktemp", "-d", "/private/tmp/claude-501/bw-sessions-offline.XXXXXX"])).stdout.trim();
  try {
    for (const s of SCENARIOS) {
      const expect = JSON.parse(readFileSync(join(SESSIONS, s, "expect.json"), "utf8"));
      const copy = join(tmp, expect.file);
      writeFileSync(copy, asWritten(readFileSync(join(SESSIONS, s, expect.file), "utf8")));
      const got = await bwHere(["feed", "--log", copy, "--agent", expect.agent, "--pictures"], { BW_NOW_MS: NOW_MS, BW_TZ: "UTC", BW_CACHE_DIR: join(tmp, "cache") });
      const log = got.find((l) => l.type === "log");
      if (log) {
        delete log.path;
        delete log.cursor;
      }
      const want = lines(readFileSync(join(FEEDS, `${s}.jsonl`), "utf8"));
      Bun.deepEquals(got, want)
        ? pass(`golden-${s}`, `${got.length} lines equal tests/fixtures/feed/${s}.jsonl`)
        : fail(`golden-${s}`, `bw feed --log differs from its golden (${got.length} lines, golden ${want.length})`);
      const c = counts(got.filter((l) => l.type === "row"));
      const hand = { user_messages: expect.user_messages, assistant_messages: expect.assistant_messages, tool_calls: expect.tool_calls, pictures: expect.pictures };
      Bun.deepEquals(c, hand)
        ? pass(`root-rows-${s}`, `user ${c.user_messages}, assistant ${c.assistant_messages}, tool calls ${c.tool_calls}, pictures ${c.pictures} equal expect.json`)
        : fail(`root-rows-${s}`, `rows ${short(c)}, hand counts ${short(hand)}`);
    }
    // Phase 3 reads children; until then bw feed has no child mode, so record what it gives today.
    const sub = JSON.parse(readFileSync(join(SESSIONS, "claude-subagents/expect.json"), "utf8"));
    const nested = sub.children.find((/** @type {any} */ c) => c.depth === 2);
    const rows = (await bwHere(["feed", "--log", join(SESSIONS, "claude-subagents", nested.file), "--agent", "claude"], { BW_CACHE_DIR: join(tmp, "cache") })).filter((l) => l.type === "row");
    pending("child-rows", `phase 3 builds child feeds; today bw feed --log on the nested sub-agent's log gives ${rows.length} rows (hand count: user ${nested.user_messages}, assistant ${nested.assistant_messages}, tool calls ${nested.tool_calls})`);
    pending("tree-nested-subagent", `phase 3 builds the tree from parentAgentId and parent_thread_id; the recording holds ${sub.children.length} Claude children, one nested under ${nested.parent}`);
  } finally {
    await spawn(["rm", "-rf", tmp]);
  }
}

/** Polls `f` every `ms` until it returns a truthy value or `limit` ms pass. @template T @param {() => Promise<T>} f */
async function until(f, limit = 30000, ms = 1000) {
  const end = Date.now() + limit;
  for (;;) {
    const v = await f();
    if (v || Date.now() > end) return v;
    await sleep(ms);
  }
}

/**
 * A git repository with one commit. @param {string} dir @param {Record<string, Buffer | string>} [files]
 * @param {(argv: string[]) => Promise<ExecResult>} [run] where to run the commands
 */
async function makeRepo(dir, files = {}, run = (argv) => spawn(argv)) {
  const script = 'set -e; mkdir -p "$1"; cd "$1"; git init -q; printf "alpha\\n" > a.txt; git add .; git -c user.name="Test User" -c user.email=user@example.com commit -qm init';
  const r = await run(["sh", "-c", script, "sh", dir]);
  if (r.code !== 0) throw new Error(`git repository ${dir}: ${r.stderr.trim()}`);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

/** A terminal in some core: how to read, type into, wait on and look up its conversation. */
class Term {
  /**
   * @param {string} address what hc in the user's or private core calls it
   * @param {string} local what bw on its own machine calls it
   * @param {(args: string[]) => Promise<ExecResult>} hcCall hc in the core that runs it
   * @param {(args: string[]) => Promise<any[]>} bw bw on its own machine
   */
  constructor(address, local, hcCall, bw) {
    Object.assign(this, { address, local, hcCall, bw });
  }
  /** @param {number} [n] */
  async screen(n = 40) {
    return (await this.hcCall(["read", this.address, "--lines", String(n)])).stdout;
  }
  /** The screen once two reads 2 s apart agree, so a redraw still under way is not taken for a change. */
  async steady() {
    let last = await this.screen();
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const now = await this.screen();
      if (now === last) return now;
      last = now;
    }
    return last;
  }
  /** @param {RegExp} re @param {number} [limit] */
  async waitScreen(re, limit = 40000) {
    return until(async () => re.test(await this.screen(60)), limit, 2000);
  }
  /** The first message, typed as in the terminal itself: no log confirms a conversation before it. @param {string} text */
  async type(text) {
    return until(async () => (await this.hcCall(["send", "--json", "--", this.address, text])).code === 0, 30000, 2000);
  }
  /** @param {...string} keys */
  async keys(...keys) {
    return this.hcCall(["keys", this.address, ...keys]);
  }
  async wait(limit = 120) {
    return this.hcCall(["wait", this.address, "--timeout", String(limit), "--json"]);
  }
  async get() {
    const r = await this.hcCall(["get", this.address, "--json"]);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }
  /** `bw locate --terminal <t> --fresh`'s line. */
  async locate() {
    return (await this.bw(["locate", "--terminal", this.local, "--fresh"]))[0] ?? null;
  }
  async rows() {
    return (await this.bw(["feed", "--terminal", this.local])).filter((l) => l.type === "row");
  }
  /** @param {{ agent: string, session: string, path: string }} c @param {string} text */
  async send(c, text) {
    const out = await this.bw(["send", "--terminal", this.local, "--expect-kind", c.agent, "--expect-session", c.session, "--expect-path", c.path, "--text", text]);
    return out.find((l) => l.type === "send") ?? out[0] ?? null;
  }
  async kill() {
    await this.hcCall(["kill", this.address]);
  }
}

/** @param {string} name @param {string} cwd @param {string[]} argv @returns {Promise<Term>} */
async function startHere(name, cwd, argv) {
  const r = await hcHere(["run", "--json", "--bg", "--no-parent", "--no-notify", "--name", name, "--cwd", cwd, "--", ...argv]);
  const j = JSON.parse(r.stdout || "{}");
  if (!j.address) throw new Error(`hc run ${name}: ${r.stderr.trim() || r.stdout.trim()}`);
  return new Term(j.address, j.address, hcHere, (args) => bwHere(args));
}

/** Claude's trust dialog for a new folder defaults to "No, exit". @param {Term} t */
async function claudeReady(t) {
  if (!(await t.waitScreen(/trust this folder|Try "|for shortcuts/))) throw new Error(`Claude in ${t.address} never showed its prompt`);
  if (/trust this folder/.test(await t.screen(60))) await t.keys("down", "enter");
  if (!(await t.waitScreen(/Try "|for shortcuts/))) throw new Error(`Claude in ${t.address} never showed its prompt`);
}

/** @param {Term} t */
async function codexReady(t) {
  if (!(await t.waitScreen(/Ask Codex|Trust this folder/))) throw new Error(`Codex in ${t.address} never showed its prompt`);
  if (/Trust this folder/.test(await t.screen(60))) await t.keys("enter");
  if (!(await t.waitScreen(/Ask Codex|›/))) throw new Error(`Codex in ${t.address} never showed its prompt`);
}

/** The terminal's conversation once its log exists. @param {Term} t */
async function located(t) {
  return until(async () => {
    const l = await t.locate();
    return l?.type === "located" ? l : null;
  }, 40000);
}

/** Rows once `want` holds for them. @param {Term} t @param {(rows: any[]) => boolean} want */
async function rowsWhen(t, want, limit = 40000) {
  let last = [];
  const ok = await until(async () => {
    last = await t.rows();
    return want(last);
  }, limit);
  return { ok: Boolean(ok), rows: last };
}

const userRow = (/** @type {any[]} */ rows, /** @type {string} */ text) => rows.some((r) => r.k === "user" && r.text === text);
const replyHas = (/** @type {any[]} */ rows, /** @type {string} */ word) => rows.some((r) => r.k === "assistant" && String(r.text).includes(word));
const tail = (/** @type {any[]} */ rows) => short(rows.slice(-4).map((r) => ({ k: r.k, text: String(r.text ?? r.sentence ?? "").slice(0, 60) })));
/** A word no earlier message holds, so a search of every log finds only this run's text. */
const marker = (/** @type {string} */ what) => `BW-${what}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/** Every file under `dir` holding `text`. @param {string} dir @param {string} text */
function filesWith(dir, text) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const hits = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    if (readFileSync(p, "utf8").includes(text)) hits.push(p);
  }
  return hits;
}

/**
 * A send naming the conversation shown before `/clear` or `/new` is refused, and nothing changes.
 * @param {string} name @param {Term} t @param {any} old the `located` line before
 * @param {(text: string) => Promise<string[]>} logsWith the agent's log files holding `text`
 */
async function oldRefused(name, t, old, logsWith) {
  const text = marker("REFUSED");
  const now = await until(async () => {
    const l = await t.locate();
    return l && !(l.type === "located" && l.session === old.session) ? l : null;
  }, 40000);
  if (!now) return fail(name, `bw locate still names ${old.session} after the new conversation`);
  const before = await t.steady();
  const rowsBefore = (await bwOld(t, old)).length;
  const r = await t.send(old, text);
  await sleep(4000);
  const after = await t.screen();
  const rowsAfter = (await bwOld(t, old)).length;
  const hits = await logsWith(text);
  if (r?.result !== "refused-conversation") return fail(name, `bw send gave ${short(r)}`);
  if (before !== after) return fail(name, `the screen changed after the refused send: ${short(changed(before, after))}`);
  if (rowsBefore !== rowsAfter || hits.length) return fail(name, `a log changed: rows ${rowsBefore} → ${rowsAfter}, text in ${hits.length} file(s)`);
  pass(name, `now ${now.type === "located" ? `session ${now.session}` : now.state}; old session ${old.session} refused, screen and logs unchanged`);
}

/** Lines of `after` that `before` does not have. @param {string} before @param {string} after */
function changed(before, after) {
  const was = new Set(before.split("\n"));
  return after.split("\n").filter((l) => !was.has(l)).map((l) => l.trim()).filter(Boolean);
}

/** The old conversation's rows, read by path on the terminal's machine. @param {Term} t @param {any} old */
async function bwOld(t, old) {
  return (await t.bw(["feed", "--log", old.path, "--agent", old.agent])).filter((l) => l.type === "row");
}

/** @param {string} name @param {() => Promise<void>} f */
async function check(name, f) {
  try {
    await f();
  } catch (e) {
    fail(name, e instanceof Error ? e.message : String(e));
  }
}

async function claudeChecks() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "claude-chat");
  await makeRepo(dir, { "dot.png": Buffer.from(DOT_PNG, "base64") });
  const t = await startHere("bw-sessions-claude", dir, CLAUDE);
  try {
    await claudeReady(t);
    await t.type("Read dot.png with the Read tool and name its colour in one word.");
    await t.wait();
    const first = await located(t);
    if (!first) return fail("claude-feed-shows-turn", "bw locate found no log after the first message");

    await check("claude-feed-shows-turn", async () => {
      const ask = "Reply with the word PINEAPPLE only.";
      const r = await t.send(first, ask);
      if (r?.result !== "sent") return fail("claude-feed-shows-turn", `bw send gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, ask) && replyHas(rows, "PINEAPPLE"));
      got.ok ? pass("claude-feed-shows-turn", `sent; the feed holds the user row and a reply with PINEAPPLE`) : fail("claude-feed-shows-turn", `feed ends ${tail(got.rows)}`);
    });

    await check("claude-send-verbatim", async () => {
      const text = '-- "$(echo no)" --force';
      const r = await t.send(first, text);
      if (r?.result !== "sent") return fail("claude-send-verbatim", `bw send gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, text));
      got.ok ? pass("claude-send-verbatim", `one user row reads exactly ${text}`) : fail("claude-send-verbatim", `feed ends ${tail(got.rows)}`);
    });

    await check("claude-picture-copied", async () => {
      const feed = await bwHere(["feed", "--terminal", t.local, "--pictures"]);
      const pic = feed.filter((l) => l.type === "row").flatMap((r) => r.pics ?? [])[0];
      if (!pic) return fail("claude-picture-copied", "no row lists a picture");
      const app = join(L, "app-home");
      mkdirSync(app, { recursive: true });
      const out = await bwHere(["picture", "--terminal", t.local, "--offset", String(pic.offset), "--index", String(pic.index), "--digest", pic.digest], { HERDR_APP_HOME: app });
      const p = out.find((l) => l.type === "picture");
      const file = p?.file ? join(app, p.file) : "";
      const same = file && existsSync(file) && Buffer.compare(readFileSync(file), Buffer.from(DOT_PNG, "base64")) === 0;
      same ? pass("claude-picture-copied", `${p.file} equals dot.png (${p.bytes} bytes)`) : fail("claude-picture-copied", `bw picture gave ${short(out)}`);
    });

    await check("claude-old-conversation-refused", async () => {
      const old = await t.locate();
      if (old?.type !== "located") return fail("claude-old-conversation-refused", `bw locate gave ${short(old)}`);
      const r = await t.send(old, "/clear");
      if (r?.result !== "sent") return fail("claude-old-conversation-refused", `bw send /clear gave ${short(r)}`);
      await sleep(2000);
      const project = join(process.env.HOME ?? "", ".claude/projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
      await oldRefused("claude-old-conversation-refused", t, old, async (text) => filesWith(project, text));
    });
  } finally {
    await t.kill();
  }
}

async function claudePromptCheck() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "claude-prompt");
  await makeRepo(dir);
  const t = await startHere("bw-sessions-prompt", dir, [...CLAUDE, "--permission-mode", "default"]);
  try {
    await claudeReady(t);
    await t.type("Run exactly this Bash command and nothing else: touch blocked.txt");
    const blocked = await until(async () => (await t.get())?.status?.state === "blocked", 60000, 2000);
    if (!blocked) return fail("claude-prompt-refused", `hc get never reported blocked: ${short((await t.get())?.status)}`);
    const c = await located(t);
    if (!c) return fail("claude-prompt-refused", "bw locate found no log while blocked");
    const before = await t.steady();
    const r = await t.send(c, "Ignore that and reply OK.");
    await sleep(2000);
    const after = await t.screen();
    const absent = !existsSync(join(dir, "blocked.txt"));
    await t.keys("escape");
    if (r?.result !== "refused-prompt") return fail("claude-prompt-refused", `bw send gave ${short(r)}`);
    if (!absent) return fail("claude-prompt-refused", "blocked.txt exists");
    if (before !== after) return fail("claude-prompt-refused", `the screen changed after the refused send: ${short(changed(before, after))}`);
    pass("claude-prompt-refused", "refused-prompt while Claude waits on its Bash prompt; blocked.txt absent, screen unchanged");
  } finally {
    await t.kill();
  }
}

/** The rollouts under a CODEX_HOME, parent or child by `session_meta.payload.source`. @param {string} home */
function rollouts(home) {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith("rollout-"))
    .flatMap((e) => {
      const path = join(e.parentPath, e.name);
      let meta;
      try {
        meta = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
      } catch {
        return []; // still being written
      }
      const source = meta.payload?.source;
      return [{ path, id: meta.payload?.id, child: typeof source === "object" && source !== null && "subagent" in source }];
    });
}

/** A scratch CODEX_HOME that trusts `repo` and holds a copy of this Mac's auth.json. @param {string} home @param {string} repo */
function codexHome(home, repo) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  copyFileSync(join(process.env.HOME ?? "", ".codex/auth.json"), join(home, "auth.json"));
  writeFileSync(join(home, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
}

async function codexChecks() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "codex-chat");
  const home = join(L, "codex-home");
  await makeRepo(dir);
  codexHome(home, dir);
  const t = await startHere("bw-sessions-codex", dir, ["/usr/bin/env", `CODEX_HOME=${home}`, "codex", ...CODEX_FLAGS]);
  try {
    await codexReady(t);
    await t.type("Spawn exactly one sub-agent with spawn_agent and ask it to run 'ls | wc -l' and report the number. Wait for it, then reply with its number only.");
    await check("codex-root-beside-child", async () => {
      const child = await until(async () => rollouts(home).find((r) => r.child), 120000, 2000);
      await t.wait(180);
      const parent = rollouts(home).find((r) => !r.child);
      if (!child || !parent) return fail("codex-root-beside-child", `rollouts: ${short(rollouts(home).map((r) => ({ id: r.id, child: r.child })))}`);
      const l = await t.locate();
      l?.type === "located" && l.session === parent.id && l.path === parent.path
        ? pass("codex-root-beside-child", `bw locate names the parent ${parent.id}, not the child ${child.id}`)
        : fail("codex-root-beside-child", `bw locate gave ${short(l)}; parent ${parent.id}, child ${child.id}`);
    });
    await check("codex-feed-local", async () => {
      const c = await located(t);
      if (!c) return fail("codex-feed-local", "bw locate found no log");
      const ask = "Reply with the word PINEAPPLE only.";
      const r = await t.send(c, ask);
      if (r?.result !== "sent") return fail("codex-feed-local", `bw send gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, ask) && replyHas(rows, "PINEAPPLE"));
      got.ok ? pass("codex-feed-local", "sent; the feed holds the user row and a reply with PINEAPPLE") : fail("codex-feed-local", `feed ends ${tail(got.rows)}`);
    });
  } finally {
    await t.kill();
  }
}

async function remoteChecks() {
  const M = /** @type {string} */ (opt.machine);
  const R = /** @type {string} */ (opt["remote-root"]);
  const L = /** @type {string} */ (opt.scratch);
  const helper = createHelper({
    exec: (cmd, args, { on }) => (on == null ? spawn([cmd, ...args]) : viaHc(on, cmd, args)),
    localInstall: async (machine) => lines((await spawn([BW, "machine", "install", machine], { env: USER_ENV })).stdout),
  });
  const there = (/** @type {string[]} */ argv) => viaHc(M, argv[0], argv.slice(1));

  await check(`${M}-helper-missing-named`, async () => {
    const mv = await there(["sh", "-c", 'h=$HOME/.local/share/bellwether/helper; [ -L "$h/current" ] && mv "$h/current" "$h/current.bw-sessions"']);
    if (mv.code !== 0) return fail(`${M}-helper-missing-named`, `could not move helper/current aside on ${M}: ${mv.stderr.trim()}`);
    const r = await helper.call(M, ["version"], { install: false });
    !r.ok && r.state === "missing" ? pass(`${M}-helper-missing-named`, `helper.call names it missing: ${r.message}`) : fail(`${M}-helper-missing-named`, short(r));
  });
  await check(`${M}-helper-installed`, async () => {
    const ready = await helper.ensure(M);
    const v = lines((await there(["sh", "-c", RUN_HELPER, "bw", "version"])).stdout)[0];
    ready.ok && v?.protocol === 2 && v?.version === "0.2.0"
      ? pass(`${M}-helper-installed`, `ensure ran bw machine install ${M}; bw version there is protocol 2, 0.2.0`)
      : fail(`${M}-helper-installed`, `ensure gave ${short(ready)}; bw version ${short(v)}`);
  });

  const dir = `${R}/codex-chat`;
  const home = `${R}/codex-home`;
  await makeRepo(dir, {}, there);
  const wrote = await spawn([HC, "file", "write", "--json", "--on", M, `${home}/auth.json`], { env: USER_ENV, stdin: Bun.file(join(process.env.HOME ?? "", ".codex/auth.json")) });
  if (wrote.code !== 0) return fail(`${M}-codex-feed`, `hc file write auth.json on ${M}: ${wrote.stderr.trim()}`);
  await there(["sh", "-c", 'chmod 600 "$1/auth.json"; printf "[projects.\\"%s\\"]\\ntrust_level = \\"trusted\\"\\n" "$2" > "$1/config.toml"', "sh", home, dir]);

  const run = await hcUser(["run", "--json", "--bg", "--on", M, "--no-parent", "--no-notify", "--name", "bw-sessions-codex", "--cwd", dir, "--",
    "/usr/bin/env", `CODEX_HOME=${home}`, `PATH=${AGENT_PATH}`, "codex", ...CODEX_FLAGS]);
  const address = JSON.parse(run.stdout || "{}").address;
  if (!address) return fail(`${M}-codex-feed`, `hc run --on ${M}: ${run.stderr.trim() || run.stdout.trim()}`);
  appendFileSync(join(L, "remote-terminals"), `${address}\n`);
  const local = address.slice(M.length + 1);
  const bwThere = async (/** @type {string[]} */ args) => {
    const r = await helper.call(M, args);
    return r.ok ? r.lines : [{ type: "failure", ...r }];
  };
  // Typing the first message goes through that machine's own core, as a key press there would.
  const hcThere = async (/** @type {string[]} */ args) => (args[0] === "send" ? there(["hc", ...args.slice(0, 3), local, ...args.slice(4)]) : hcUser(args));
  const t = new Term(address, local, hcThere, bwThere);
  try {
    await codexReady(t);
    await check(`${M}-codex-kind`, async () => {
      const l = await t.locate();
      l?.agent === "codex" ? pass(`${M}-codex-kind`, `bw locate there names codex behind the env wrapper (${l.type === "state" ? l.state : l.session})`) : fail(`${M}-codex-kind`, `bw locate there gave ${short(l)}: the env wrapper hides Codex`);
    });
    await t.type("Reply with the word MANGO only.");
    await t.wait();
    const first = await located(t);
    if (!first) return fail(`${M}-codex-feed`, "bw locate there found no log after the first message");
    await check(`${M}-codex-feed`, async () => {
      const got = await rowsWhen(t, (rows) => userRow(rows, "Reply with the word MANGO only.") && replyHas(rows, "MANGO"));
      got.ok ? pass(`${M}-codex-feed`, "bw feed through the helper there shows the turn") : fail(`${M}-codex-feed`, `feed ends ${tail(got.rows)}`);
    });
    await check(`${M}-codex-send`, async () => {
      const ask = "Reply with the word PINEAPPLE only.";
      const r = await t.send(first, ask);
      if (r?.result !== "sent") return fail(`${M}-codex-send`, `bw send through the helper there gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, ask) && replyHas(rows, "PINEAPPLE"));
      got.ok ? pass(`${M}-codex-send`, "sent through the helper there; the feed holds the user row as typed (no <hc from> wrapper) and the reply") : fail(`${M}-codex-send`, `feed ends ${tail(got.rows)}`);
    });
    await check(`${M}-old-conversation-refused`, async () => {
      const old = await t.locate();
      if (old?.type !== "located") return fail(`${M}-old-conversation-refused`, `bw locate gave ${short(old)}`);
      const r = await t.send(old, "/new");
      if (r?.result !== "sent") return fail(`${M}-old-conversation-refused`, `bw send /new gave ${short(r)}`);
      // In a Git repository Codex 0.167 asks where the new conversation runs; Enter keeps this folder.
      if (await t.waitScreen(/Where should the new conversation run/, 10000)) await t.keys("enter");
      if (/<hc from/.test(await t.screen())) return fail(`${M}-old-conversation-refused`, "the screen shows an <hc from> wrapper");
      await oldRefused(`${M}-old-conversation-refused`, t, old, async (text) => {
        const g = await there(["grep", "-rlF", "--", text, `${home}/sessions`]);
        return g.stdout.split("\n").filter(Boolean);
      });
    });
  } finally {
    await t.kill();
  }
}

if (opt.offline) {
  await offline();
} else {
  await offline();
  for (const [name, f] of [["claude", claudeChecks], ["claude-prompt", claudePromptCheck], ["codex", codexChecks]]) {
    await check(/** @type {string} */ (name), /** @type {() => Promise<void>} */ (f));
  }
  if (opt.machine) await check(String(opt.machine), remoteChecks);
}
process.exit(failed ? 1 : 0);
