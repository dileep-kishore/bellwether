// Helpers the live verify checks share (sessions-run.js, requests-run.js): processes, hc terminals, scratch
// repositories, Codex homes and the PASS/FAIL lines.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseLines } from "../../shared/helper.js";

export const HC = process.env.BW_HC || "hc";
export const AGENT_PATH = `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

/** PASS, FAIL and PENDING lines, and whether any FAIL was printed. */
export function reporter() {
  const r = {
    failed: false,
    pass: (/** @type {string} */ name, /** @type {string} */ what) => console.log(`PASS ${name}: ${what}`),
    fail: (/** @type {string} */ name, /** @type {string} */ why) => {
      r.failed = true;
      console.log(`FAIL ${name}: ${why}`);
    },
    pending: (/** @type {string} */ name, /** @type {string} */ why) => console.log(`PENDING ${name}: ${why}`),
    /** Runs `f`; a throw is that check's FAIL. @param {string} name @param {() => Promise<unknown>} f */
    check: async (name, f) => {
      try {
        await f();
      } catch (e) {
        r.fail(name, e instanceof Error ? e.message : String(e));
      }
    },
  };
  return r;
}

export const short = (/** @type {unknown} */ v) => JSON.stringify(v).slice(0, 300);
export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** A word no earlier message holds, so a search of every log finds only this run's text. */
export const marker = (/** @type {string} */ what) => `BW-${what}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */

/** @param {string[]} argv @param {{ env?: Record<string, string>, stdin?: Blob }} [o] @returns {Promise<ExecResult>} */
export async function spawn(argv, o = {}) {
  const p = Bun.spawn(argv, { stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: o.env ?? process.env });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** `process.env` with `set` applied; an undefined value removes the variable. @param {Record<string, string | undefined>} set */
export function envWith(set) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries({ ...process.env, ...set })) if (v !== undefined) env[k] = v;
  return env;
}
/** The user's own core, for the other machine. */
export const USER_ENV = envWith({ HC_SESSION: undefined });

/** JSON lines, or none when the output is not JSON lines. @param {string} stdout */
export function lines(stdout) {
  try {
    return parseLines(stdout);
  } catch {
    return [];
  }
}

/** `hc <args>` against the user's core. @param {string[]} args */
export const hcUser = (args) => spawn([HC, ...args], { env: USER_ENV });

// Rejects like Herdr's exec when hc cannot reach the machine; otherwise the program's own result.
/** @param {string} machine @param {string} cmd @param {string[]} args @returns {Promise<ExecResult>} */
export async function viaHc(machine, cmd, args) {
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

/** Polls `f` every `ms` until it returns a truthy value or `limit` ms pass. @template T @param {() => Promise<T>} f */
export async function until(f, limit = 30000, ms = 1000) {
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
export async function makeRepo(dir, files = {}, run = (argv) => spawn(argv)) {
  const script = 'set -e; mkdir -p "$1"; cd "$1"; git init -q; printf "alpha\\n" > a.txt; git add .; git -c user.name="Test User" -c user.email=user@example.com commit -qm init';
  const r = await run(["sh", "-c", script, "sh", dir]);
  if (r.code !== 0) throw new Error(`git repository ${dir}: ${r.stderr.trim()}`);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

/** A terminal in some core: how to read, type into, wait on and look up its conversation. */
export class Term {
  /**
   * @param {string} address what hc in the user's or private core calls it
   * @param {string} local what bw on its own machine calls it
   * @param {(args: string[]) => Promise<ExecResult>} hcCall hc in the core that runs it
   * @param {(args: string[]) => Promise<any[]>} bw bw on its own machine
   */
  constructor(address, local, hcCall, bw) {
    this.address = address;
    this.local = local;
    this.hcCall = hcCall;
    this.bw = bw;
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
  /** Types `text` with hc send itself, for a check that is not about bw send. @param {string} text */
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

/** Claude's trust dialog for a new folder defaults to "No, exit". @param {Term} t */
export async function claudeReady(t) {
  if (!(await t.waitScreen(/trust this folder|Try "|for shortcuts/))) throw new Error(`Claude in ${t.address} never showed its prompt`);
  if (/trust this folder/.test(await t.screen(60))) await t.keys("down", "enter");
  if (!(await t.waitScreen(/Try "|for shortcuts/))) throw new Error(`Claude in ${t.address} never showed its prompt`);
}

/** @param {Term} t */
export async function codexReady(t) {
  if (!(await t.waitScreen(/Ask Codex|Trust this folder|Hooks need review/))) throw new Error(`Codex in ${t.address} never showed its prompt`);
  const s = await t.screen(60);
  if (/Hooks need review/.test(s)) throw new Error(`Codex in ${t.address} asks to review its hooks: the trust entries were not accepted`);
  if (/Trust this folder/.test(s)) await t.keys("enter");
  if (!(await t.waitScreen(/Ask Codex|›/))) throw new Error(`Codex in ${t.address} never showed its prompt`);
}

/** Lines of `after` that `before` does not have. @param {string} before @param {string} after */
export function changed(before, after) {
  const was = new Set(before.split("\n"));
  return after.split("\n").filter((l) => !was.has(l)).map((l) => l.trim()).filter(Boolean);
}

/** Every file under `dir` holding `text`. @param {string} dir @param {string} text */
export function filesWith(dir, text) {
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

/** The rollouts under a CODEX_HOME, parent or child by `session_meta.payload.source`. @param {string} home */
export function rollouts(home) {
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

/** A scratch CODEX_HOME that trusts each repository and holds a copy of this Mac's auth.json. @param {string} home @param {string[]} repos */
export function codexHome(home, ...repos) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  copyFileSync(join(process.env.HOME ?? "", ".codex/auth.json"), join(home, "auth.json"));
  writeFileSync(join(home, "config.toml"), trustProjects(repos));
}

/** `[projects."<repo>"] trust_level = "trusted"` for each repository. @param {string[]} repos */
export const trustProjects = (repos) => repos.map((r) => `[projects.${JSON.stringify(r)}]\ntrust_level = "trusted"\n`).join("\n");

/** @param {unknown} v @returns {unknown} */
function sortedKeys(v) {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(/** @type {any} */ (v)[k])]));
  return v;
}

/**
 * The `[hooks.state]` entries Codex 0.167 writes when the user trusts every hook in `hooks` (the parsed
 * hooks.json at `path`): sha256 of the compact sorted-key identity, as docs/research/2026-11-06-phase3-requests.md
 * case (f) records and tests/fixtures/hooks/codex-trusted-hash.json checks.
 * @param {any} hooks @param {string} path
 */
export function trustHooks(hooks, path) {
  let out = "";
  for (const [event, groups] of Object.entries(hooks.hooks ?? {})) {
    const ev = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    /** @type {any[]} */ (groups).forEach((g, gi) => {
      g.hooks.forEach((/** @type {any} */ h, hi) => {
        const id = { event_name: ev, hooks: [{ ...h, async: h.async ?? false, timeout: h.timeout ?? 600 }], ...(g.matcher ? { matcher: g.matcher } : {}) };
        const hash = createHash("sha256").update(JSON.stringify(sortedKeys(id))).digest("hex");
        out += `[hooks.state.${JSON.stringify(`${path}:${ev}:${gi}:${hi}`)}]\ntrusted_hash = "sha256:${hash}"\n\n`;
      });
    });
  }
  return out;
}
