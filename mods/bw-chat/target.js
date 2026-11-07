// Which terminal a chat shows, how often it reads, and the words for each state. Pure.
import { paneKind } from "./chat-tabs.js";

/** @typedef {"claude" | "codex"} Kind */

/**
 * @typedef {object} Target
 * @property {string | null} machine the space's machine; null for this Mac
 * @property {string} terminal full address, `machine/t` when remote (what `bw picture` takes here)
 * @property {string} local the address on its own machine (what `bw feed` and `bw send` take there)
 * @property {Kind} kind
 */

/**
 * @typedef {Target & { tab: string, pane: string }} Found The terminal in the chat's own tab, as this window names it.
 * @typedef {{ state: "found", target: Found } | { state: "exited", tab: string } | { state: "missing" }} Located
 */

export const POLL_SHOWN_MS = 2000;
export const POLL_HIDDEN_MS = 10000;

/** @param {boolean} shown */
export const pollMs = (shown) => (shown ? POLL_SHOWN_MS : POLL_HIDDEN_MS);

/** @param {Kind} kind */
export const agentName = (kind) => (kind === "codex" ? "Codex" : "Claude");

const isStr = (/** @type {unknown} */ s) => typeof s === "string" && s !== "";

/**
 * The chat's props as a target; null when they name no Claude or Codex terminal.
 * @param {unknown} props `{ terminal, machine, kind, window? }` as bw-tabs splits the pane with, in its window's namespace
 * @returns {Target | null}
 */
export function targetOf(props) {
  const p = /** @type {any} */ (props);
  if (!p || !isStr(p.terminal) || (p.kind !== "claude" && p.kind !== "codex")) return null;
  const slash = p.terminal.indexOf("/");
  const machine = isStr(p.machine) ? p.machine : slash > 0 ? p.terminal.slice(0, slash) : null;
  if (machine === null) return { machine: null, terminal: p.terminal, local: p.terminal, kind: p.kind };
  const local = p.terminal.startsWith(`${machine}/`) ? p.terminal.slice(machine.length + 1) : p.terminal;
  if (!local || local.includes("/")) return null;
  return { machine, terminal: `${machine}/${local}`, local, kind: p.kind };
}

/**
 * The terminal a chat shows, found in this window's live panes. A mod pane is never told its own pane
 * id, so the chat's tab is the one holding a bw-chat pane beside a terminal with the props' address on
 * its own machine; props from another window (`mine` false) are in that window's namespace, so only a
 * single such tab counts, with no chat tab missing its terminal that could be this one.
 * @param {Target} id `targetOf(props)`
 * @param {boolean} mine the props were written by this app home, so `id.terminal` is this window's address
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @returns {Located}
 */
export function resolveTarget(id, mine, spaces, panes) {
  /** @type {Map<string, string | null>} */
  const machineOf = new Map();
  for (const sp of spaces) for (const t of sp.tabs) machineOf.set(t.id, sp.machine ?? null);
  const chatTabs = [...new Set(panes.filter((p) => p.mod === "bw-chat").map((p) => p.tab))].filter((t) => machineOf.has(t));
  /** @type {Found[]} */
  const found = [];
  /** @type {string[]} */
  const orphans = [];
  for (const tab of chatTabs) {
    const machine = /** @type {string | null} */ (machineOf.get(tab));
    const terms = panes.filter((p) => p.tab === tab && !p.mod && isStr(p.terminal));
    if (!terms.length) orphans.push(tab);
    for (const p of terms) {
      const local = machine !== null && p.terminal.startsWith(`${machine}/`) ? p.terminal.slice(machine.length + 1) : p.terminal;
      const kind = paneKind(p);
      if (local !== id.local || (kind !== null && kind !== id.kind)) continue;
      found.push({ machine, terminal: p.terminal, local, kind: id.kind, tab, pane: p.pane });
    }
  }
  const hits = mine ? found.filter((f) => f.terminal === id.terminal) : found;
  if (hits.length === 1 && (mine || !orphans.length)) return { state: "found", target: hits[0] };
  // An agent exiting closes its pane, leaving the chat alone in its tab.
  if (!hits.length && orphans.length === 1) return { state: "exited", tab: orphans[0] };
  return { state: "missing" };
}

/** @param {string | null} machine */
const where = (machine) => machine ?? "this Mac";

/**
 * What a `bw feed` state line means for the person.
 * @param {string} state @param {string} agent @param {string | null} [machine]
 */
export function waitingText(state, agent, machine = null) {
  switch (state) {
    case "no_core": return `Herdr's core on ${where(machine)} is not answering`;
    case "no_terminal": return `${agent} exited`;
    case "not_agent": return "This terminal runs no Claude or Codex";
    case "no_log": return `Waiting for ${agent}'s session log`;
    case "no_child": return "This sub-agent has no log yet";
    default: return `${agent}'s conversation cannot be read (${state})`;
  }
}

/**
 * The dock's hooks notice for a `cards` line's `hooks` state; null when nothing needs saying.
 * @param {string | null} state "ok", "missing", "outdated" or "untrusted" @param {string | null} machine
 */
export function hooksText(state, machine) {
  switch (state) {
    case "missing": return `Bellwether hooks are not set up on ${where(machine)}; requests show without who asked`;
    case "outdated": return `Bellwether hooks on ${where(machine)} are out of date; requests show without who asked`;
    case "untrusted": return `Codex hook not trusted on ${where(machine)}`;
    default: return null;
  }
}

/** The user's step to trust Bellwether's hook in Codex, from the phase 3 experiment's note. */
export const TRUST_STEP = "Start Codex there and choose “Trust all and continue” (2, then Enter), or type /hooks and press t.";

/**
 * The `hooks` state of a `cards` line for this chat's agent: the line may name one state or one per agent.
 * @param {unknown} hooks @param {string} kind @returns {string | null}
 */
export function hooksState(hooks, kind) {
  if (typeof hooks === "string") return hooks || null;
  const v = hooks && typeof hooks === "object" ? /** @type {Record<string, unknown>} */ (hooks)[kind] : null;
  return typeof v === "string" && v ? v : null;
}

/**
 * What a helper failure (`helper.call`'s `{ ok: false, state }`) means for the person.
 * @param {string} state @param {string | null} machine
 */
export function helperText(state, machine) {
  switch (state) {
    case "installing": return `Setting up Bellwether on ${where(machine)}`;
    case "missing": return `Bellwether's helper is missing on ${where(machine)}`;
    case "outdated": return `Bellwether's helper on ${where(machine)} is out of date`;
    case "unreachable": return `${machine ?? "This Mac"} is not answering`;
    case "bad_output": return `Bellwether's helper on ${where(machine)} printed something unexpected`;
    default: return `Bellwether's helper failed on ${where(machine)}`;
  }
}

/**
 * The line under the composer after a send.
 * @param {string} result `sent`, `refused-prompt`, `refused-conversation`, `unconfirmed`, or anything else for a failure
 * @param {string} agent
 * @param {string} [message] the failure's own words
 */
export function sendText(result, agent, message = "") {
  switch (result) {
    case "sent": return "Sent.";
    case "refused-prompt": return `Not sent: ${agent} is waiting on a prompt. Answer it in the terminal (⌘J).`;
    case "refused-conversation": return "Not sent: this terminal now shows another conversation.";
    case "unconfirmed": return "Sent, but Herdr did not confirm it in time. Check the terminal (⌘J).";
    default: return `Not sent: ${message || "bw send gave no result"}`;
  }
}

/** Bytes as megabytes with one decimal, as the picture placeholder names them. @param {number} bytes */
export const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
