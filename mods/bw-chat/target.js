// Which terminal a chat shows, how often it reads, and the words for each state. Pure.

/** @typedef {"claude" | "codex"} Kind */

/**
 * @typedef {object} Target
 * @property {string | null} machine the space's machine; null for this Mac
 * @property {string} terminal full address, `machine/t` when remote (what `bw picture` takes here)
 * @property {string} local the address on its own machine (what `bw feed` and `bw send` take there)
 * @property {Kind} kind
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
 * @param {unknown} props `{ terminal, machine, kind }` as bw-tabs splits the pane with
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
    default: return `${agent}'s conversation cannot be read (${state})`;
  }
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
