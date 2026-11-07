// Fake "herdr" module for the headless harness. Tests set live data in `fake` and read what the
// mod asked for in `log`. Adapted from Flockbook's herdr-app/test/stub/herdr.mjs (MIT, see
// THIRD_PARTY_NOTICES.md); unlike it, the module exports exactly the names herdr.d.ts declares.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import api from "./api.json";

export const repo = resolve(import.meta.dir, "../..");

/** @typedef {"init" | "render" | "event" | "task" | "timer"} Phase */

// AsyncLocalStorage follows a spawned body across its awaits, so a task resumed by a render-time
// poke still reads as "task".
const phases = new AsyncLocalStorage();
/** @type {Phase} */
let fallbackPhase = "init";

/** @param {Phase} p */
export function setPhase(p) {
  fallbackPhase = p;
}
/** @returns {Phase} */
export function phase() {
  return phases.getStore() ?? fallbackPhase;
}
/** @template T @param {Phase} p @param {() => T} fn @returns {T} */
export function inPhase(p, fn) {
  return phases.run(p, fn);
}

/** Rule breaks seen since the last reset; mount throws the first after each step, so a mod that
 * catches the immediate throw still fails. @type {Error[]} */
export const violations = [];
/** @param {string} message @returns {never} */
export function refuse(message) {
  const e = new Error(message);
  violations.push(e);
  throw e;
}

let activityCount = 0;
/** A counter every stub call bumps, so cx.flush can tell when tasks stop making progress. */
export const activity = () => activityCount;
export function touch() {
  activityCount++;
}

const LAYOUT = JSON.parse(readFileSync(join(repo, "layouts/bellwether.json"), "utf8"));
const LIVE_REFUSED = new Set(["agents", "spaces", "panes", "terminals", "focused"]);
const OWN_COMMAND = /^bw-[a-z0-9-]+\.[\w-]+$/;

/**
 * @typedef {{ on?: string | null, cmd: string, argsInclude?: string[], result: { code: number, stdout: string, stderr: string } | "reject" }} ExecAnswer
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, on?: string | null }) => unknown} ExecFn
 */

function defaults() {
  return {
    machines: [{ name: null, layout: "ready" }],
    spaces: [],
    panes: [],
    agents: [],
    terminals: [],
    focused: null,
    layout: structuredClone(LAYOUT),
    window: { platform: "macos", titlebar: "none", buttons: false, maximized: false, fullscreen: false, active: true },
    settings: {},
    /** @type {Record<string, unknown>} */
    shared: {},
    props: {},
    keys: [],
    placement: null,
    home: "/home/test",
    appHome: "/home/test/.config/herdr-app",
    /** @type {ExecAnswer[] | ExecFn} */
    exec: [],
    /** @type {Record<string, unknown[]> | ((opts?: { on?: string | null }) => unknown)} */
    knownAgents: { "": [] },
    /** @type {null | ((dir: string) => Promise<string[]>)} */
    watchFolder: null,
    /** @type {null | string | ((opts?: { prompt?: string }) => unknown)} */
    pickFolder: null,
    /** @type {null | Record<string, string> | ((path: string, opts?: { on?: string | null }) => unknown)} */
    readTextFile: null,
    /** @type {null | ((path: string, text: string, expected: string | null) => unknown)} */
    writeTextFile: null,
    /** @type {null | (() => Promise<string>)} */
    nextCommand: null,
  };
}

/** @type {ReturnType<typeof defaults> & Record<string, any>} */
export const fake = defaults();

export const log = {
  /** @type {([string] | [string, Record<string, unknown>])[]} */ run: [],
  /** @type {[string, string[], unknown][]} */ exec: [],
  /** @type {[string, unknown][]} */ shared: [],
  /** @type {unknown[]} */ overlays: [],
  /** @type {string[]} */ closed: [],
  /** @type {string[]} */ order: [],
  /** @type {unknown[]} */ notify: [],
  /** @type {[string, Phase][]} */ live: [],
  /** @type {unknown[]} */ knownAgents: [],
  /** @type {string[]} */ watch: [],
  /** @type {[string, string, string | null][]} */ writes: [],
  /** @type {string[]} */ sounds: [],
};

class MemoryStorage {
  #m = new Map();
  get length() {
    return this.#m.size;
  }
  /** @param {number} i */ key(i) {
    return [...this.#m.keys()][i] ?? null;
  }
  /** @param {string} k */ getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  /** @param {string} k @param {unknown} v */ setItem(k, v) {
    this.#m.set(String(k), String(v));
  }
  /** @param {string} k */ removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}
if (typeof globalThis.localStorage === "undefined") globalThis.localStorage = /** @type {any} */ (new MemoryStorage());

let overlayCount = 0;
let notifyCount = 0;

export function reset() {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, defaults());
  for (const k of Object.keys(log)) /** @type {any} */ (log)[k] = [];
  violations.length = 0;
  fallbackPhase = "init";
  globalThis.localStorage.clear();
}

/** @param {string} name */
function readLive(name) {
  touch();
  const p = phase();
  log.live.push([name, p]);
  if (LIVE_REFUSED.has(name) && (p === "task" || p === "timer")) refuse(`live data read from a ${p}: ${name}()`);
  return structuredClone(fake[name]);
}

/** @param {string} name @param {Record<string, unknown> | undefined} args */
function checkCommand(name, args) {
  if (OWN_COMMAND.test(name)) return;
  const spec = /** @type {Record<string, { args: string[], required: string[] }>} */ (api.commands)[name];
  if (!spec) refuse(`unknown command ${name}`);
  for (const k of Object.keys(args ?? {})) if (!spec.args.includes(k)) refuse(`${name}: unknown argument ${k}`);
  for (const r of spec.required) if (args?.[r] === undefined) refuse(`${name}: missing required argument ${r}`);
}

/** @param {string} cmd @param {string[]} args @param {{ on?: string | null } | undefined} opts */
async function answerExec(cmd, args, opts) {
  if (typeof fake.exec === "function") return fake.exec(cmd, args, opts);
  const on = opts?.on ?? null;
  // Arguments match by whole element, so "/r/alpha" never matches "/r/alpha-wt/feat".
  const hit = fake.exec.find(
    (e) =>
      e.cmd === cmd && (!("on" in e) || (e.on ?? null) === on) && (e.argsInclude ?? []).every((a) => args.includes(a)),
  );
  if (!hit) return { code: 127, stdout: "", stderr: `stub: no fixture answer for ${cmd} ${args.join(" ")}` };
  if (hit.result === "reject") throw new Error(`stub: exec ${cmd} on ${on ?? "this machine"} rejected`);
  return { ...hit.result };
}

const themeProxy = () => new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${k}` : undefined) });
const never = () => new Promise(() => {});

/** @type {Record<string, (...a: any[]) => any>} */
const impl = {
  machines: () => readLive("machines"),
  spaces: () => readLive("spaces"),
  panes: () => readLive("panes"),
  agents: () => readLive("agents"),
  terminals: () => readLive("terminals"),
  focused: () => readLive("focused"),
  layout: () => readLive("layout"),
  window: () => readLive("window"),
  placement: () => structuredClone(fake.placement),
  settings: () => structuredClone(fake.settings),
  keys: () => structuredClone(fake.keys),
  props: () => fake.props ?? {},
  theme: themeProxy,
  themes: () => [],
  fonts: () => [],
  layouts: () => ["main", "bellwether"],
  commands: () =>
    Object.entries(api.commands).map(([name, c]) => ({
      name,
      args: c.args.map((a) => ({ name: a, required: c.required.includes(a) })),
      about: "",
    })),
  home: () => fake.home,
  appHome: () => fake.appHome,
  shared: (/** @type {string} */ k) => {
    touch();
    return structuredClone(fake.shared[k]);
  },
  setShared: (/** @type {string} */ k, /** @type {unknown} */ v) => {
    touch();
    fake.shared[k] = structuredClone(v);
    log.shared.push([k, structuredClone(v)]);
    return null;
  },
  run: (/** @type {string} */ name, /** @type {Record<string, unknown> | undefined} */ args) => {
    touch();
    checkCommand(name, args);
    log.run.push(args === undefined ? [name] : [name, structuredClone(args)]);
    return null;
  },
  setAgentOrder: (/** @type {string[]} */ list) => {
    touch();
    log.order = [...list];
    return null;
  },
  openOverlay: (/** @type {unknown} */ spec) => {
    touch();
    log.overlays.push(structuredClone(spec));
    return `o${++overlayCount}`;
  },
  closeOverlay: (/** @type {string} */ id) => {
    touch();
    log.closed.push(id);
    return null;
  },
  notify: (/** @type {unknown} */ n) => {
    touch();
    log.notify.push(structuredClone(n));
    return `n${++notifyCount}`;
  },
  playSound: (/** @type {string} */ s) => {
    log.sounds.push(s);
    return null;
  },
  exec: async (/** @type {string} */ cmd, /** @type {string[]} */ args = [], /** @type {any} */ opts) => {
    touch();
    log.exec.push([cmd, [...args], opts]);
    const r = await answerExec(cmd, args, opts);
    touch();
    return r;
  },
  hc: (/** @type {string[]} */ args) => impl.exec("hc", args),
  knownAgents: async (/** @type {{ on?: string | null } | undefined} */ opts) => {
    touch();
    log.knownAgents.push(opts);
    const k = fake.knownAgents;
    const r = typeof k === "function" ? await k(opts) : structuredClone(k?.[opts?.on ?? ""] ?? []);
    touch();
    return r;
  },
  watchFolder: (/** @type {string} */ dir) => {
    touch();
    log.watch.push(dir);
    return fake.watchFolder ? fake.watchFolder(dir) : never();
  },
  pickFolder: async (/** @type {any} */ opts) =>
    typeof fake.pickFolder === "function" ? fake.pickFolder(opts) : fake.pickFolder,
  readTextFile: async (/** @type {string} */ path, /** @type {any} */ opts) => {
    const r = fake.readTextFile;
    if (typeof r === "function") return r(path, opts);
    return r?.[path] ?? null;
  },
  writeTextFile: async (
    /** @type {string} */ path,
    /** @type {string} */ text,
    /** @type {string | null} */ expected,
  ) => {
    log.writes.push([path, text, expected]);
    return fake.writeTextFile ? fake.writeTextFile(path, text, expected) : null;
  },
  nextCommand: () => (fake.nextCommand ? fake.nextCommand() : never()),
};

/** @param {string} name */
const unfaked = (name) => () => {
  throw new Error(`stub: ${name} not faked`);
};

/** The namespace the preload hands Bun for `import … from "herdr"`: every declared name, nothing else. */
export const herdrModule = Object.fromEntries(api.herdr.map((n) => [n, impl[n] ?? unfaked(n)]));
