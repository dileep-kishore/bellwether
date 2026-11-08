// What the Browser panel shows, from `bw browser status`'s lines. Imports nothing, so `bun test` runs it.

/**
 * @typedef {object} Chrome
 * @property {string} state the `chrome` line's state, "loading" before the first read, "helper" when bw failed
 * @property {string} label the header's state text
 * @property {string} message
 */

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {string} title the page title, else its URL
 * @property {string} url
 * @property {string} secondary host and path for http(s), else the URL
 * @property {string | null} favicon a cached file under the app home, else null (the globe)
 * @property {boolean} active
 */

/**
 * @typedef {object} Forward
 * @property {"browser" | "dev"} kind
 * @property {string} machine
 * @property {string} target
 * @property {number} port
 * @property {string} state
 * @property {string} reason
 * @property {string} terminal
 */

/**
 * @typedef {object} View
 * @property {Chrome} chrome
 * @property {Tab[]} tabs
 * @property {Forward[]} forwards
 * @property {string | null} states the named state that replaces the tab list, null to draw the list
 */

/** @typedef {{ ok: false, state: string, message: string }} HelperFailure */

// Only the cache bw writes; `image()` would read any path under the app home.
const FAVICON = /^data\/bellwether\/favicons\/[0-9a-f]{16}\.(png|jpg|gif|webp|svg)$/;

/** @type {Record<string, string>} */
const LABELS = {
  stopped: "Not running",
  port_taken: "Port taken",
  no_debug_port: "No debugging port",
  not_installed: "Not installed",
  start_failed: "Start failed",
};

/** @type {Record<string, string>} */
const HELPER_LABELS = { missing: "Helper missing", outdated: "Helper outdated", installing: "Installing helper" };

/** @param {string} s */
const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v : "");

/** Host and path of an http(s) URL, without a bare "/" path; any other URL as it is. @param {string} url */
export function secondary(url) {
  const m = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (!m) return url;
  return m[2] === "/" ? m[1] : m[1] + m[2];
}

/** @param {any} l @returns {Tab | null} */
function tabOf(l) {
  const id = str(l.id);
  if (!id) return null;
  const url = str(l.url);
  const favicon = typeof l.favicon === "string" && FAVICON.test(l.favicon) ? l.favicon : null;
  return { id, title: str(l.title) || url || id, url, secondary: secondary(url), favicon, active: l.active === true };
}

/** @param {any} l @returns {Forward | null} */
function forwardOf(l) {
  const port = Number(l.port);
  if (!str(l.machine) || !Number.isInteger(port)) return null;
  return {
    kind: l.kind === "dev" ? "dev" : "browser",
    machine: l.machine,
    target: str(l.target),
    port,
    state: str(l.state) || "unknown",
    reason: str(l.reason),
    terminal: str(l.terminal),
  };
}

/**
 * The panel's view of one `bw browser status` answer, or of the helper's failure to give one.
 * @param {object[] | null} lines null before the first read
 * @param {HelperFailure | null} helperFailure
 * @returns {View}
 */
export function viewOf(lines, helperFailure) {
  if (helperFailure) {
    const label = HELPER_LABELS[helperFailure.state] ?? "Unavailable";
    return {
      chrome: { state: "helper", label, message: helperFailure.message },
      tabs: [],
      forwards: [],
      states: helperFailure.message,
    };
  }
  if (!lines) {
    return {
      chrome: { state: "loading", label: "Checking…", message: "" },
      tabs: [],
      forwards: [],
      states: "Reading the Bellwether Chrome…",
    };
  }
  const all = /** @type {any[]} */ (lines);
  const c = all.find((l) => l?.type === "chrome");
  const forwards = /** @type {Forward[]} */ (
    all
      .filter((l) => l?.type === "forward")
      .map(forwardOf)
      .filter(Boolean)
  );
  if (!c) {
    const message = "bw browser status printed no chrome line";
    return { chrome: { state: "helper", label: "Unavailable", message }, tabs: [], forwards, states: message };
  }
  const state = str(c.state) || "unknown";
  const message = str(c.message);
  if (state !== "running") {
    return {
      chrome: { state, label: LABELS[state] ?? sentence(state.replace(/_/g, " ")), message },
      tabs: [],
      forwards,
      states: sentence(message) || state,
    };
  }
  const tabs = /** @type {Tab[]} */ (
    all
      .filter((l) => l?.type === "tab")
      .map(tabOf)
      .filter(Boolean)
  );
  const label = `Running · ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;
  return { chrome: { state, label, message }, tabs, forwards, states: tabs.length ? null : "No tabs open" };
}

/** Whether the header offers Start: Chrome is not running and starting it could help. @param {string} state */
export const canStart = (state) => state === "stopped" || state === "no_debug_port" || state === "start_failed";

/**
 * A forward row's text: "macmini · browser :52817 · ready", "localhost:3000 ← macmini".
 * @param {Pick<Forward, "kind" | "machine" | "port" | "state">} f
 */
export function forwardLabel(f) {
  if (f.kind === "dev") return `localhost:${f.port} ← ${f.machine}`;
  return `${f.machine} · browser :${f.port}`;
}

/** A forward's state as its pill says it. @param {Pick<Forward, "state">} f */
export const forwardState = (f) => f.state.replace(/_/g, " ");

/** The unique part of a forward's element ids. @param {Pick<Forward, "kind" | "machine" | "port">} f */
export const forwardKey = (f) => `${f.machine}-${f.kind}-${f.port}`;

/**
 * Whether "Forward port" can forward from the active space's machine.
 * @param {{ id: string, machine: string | null } | null} space
 * @returns {{ ok: boolean, hint: string }}
 */
export function canForward(space) {
  if (!space) return { ok: false, hint: "No space is open" };
  if (space.machine == null) return { ok: false, hint: "This space is on this Mac" };
  return { ok: true, hint: `Forward a port from ${space.machine}` };
}

/** A port typed into the field, or null. @param {string} text */
export function portOf(text) {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

/** @param {any} node @param {string} id @param {boolean} hidden @returns {{ node: any, hidden: boolean } | null} */
function find(node, id, hidden) {
  if (!node || typeof node !== "object") return null;
  const h = hidden || node.hidden === true;
  if (node.id === id) return { node, hidden: h };
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = find(c, id, h);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether the window shows the Browser panel: the `right-body` stack's active child is `browser`
 * and no node above it is hidden. `layout()` is the window's, so the active space does not change it.
 * @param {unknown} layoutNode
 */
export function isShown(layoutNode) {
  const hit = find(layoutNode, "right-body", false);
  return Boolean(hit && !hit.hidden && hit.node.active === "browser");
}

/** @param {any[]} lines @param {string} type */
const lineOf = (lines, type) => lines.find((l) => l?.type === type) ?? null;

/**
 * The result line an action shows.
 * @param {"up" | "new" | "arrange" | "focus" | "close" | "stop" | "dev"} action
 * @param {{ ok: true, lines: object[] } | HelperFailure} answer
 * @param {string} [title] the tab's title, for focus and close
 */
export function resultText(action, answer, title = "") {
  const verb = {
    up: "Start",
    new: "New tab",
    arrange: "Arrange",
    focus: "Focus",
    close: "Close",
    stop: "Stop",
    dev: "Forward port",
  }[action];
  if (answer.ok === false) return `${verb} failed: ${answer.message.trim()}`;
  const lines = /** @type {any[]} */ (answer.lines);
  if (action === "up") {
    const c = lineOf(lines, "chrome");
    if (!c) return `${verb} failed: bw printed no chrome line`;
    if (c.state === "running") return c.started ? "Started the Bellwether Chrome" : "The Bellwether Chrome is running";
    return sentence(str(c.message)) || str(c.state);
  }
  if (action === "arrange") {
    const a = lineOf(lines, "arrange");
    return a ? sentence(str(a.message)) || str(a.state) : `${verb} failed: bw printed no arrange line`;
  }
  if (action === "stop" || action === "dev") {
    const f = forwardOf(lineOf(lines, "forward") ?? {});
    if (!f) return action === "stop" ? "Stopped the forward" : `${verb} failed: bw printed no forward line`;
    return f.reason ? `${forwardLabel(f)}: ${f.reason}` : forwardLabel(f);
  }
  const t = lineOf(lines, "tab-action");
  if (!t) return `${verb} failed: bw printed no tab-action line`;
  if (t.ok !== true) return `${verb} failed: ${str(t.message)}`;
  if (action === "new") return "Opened a new tab";
  const name = title || "the tab";
  return action === "focus" ? `Focused ${name}` : `Closed ${name}`;
}
