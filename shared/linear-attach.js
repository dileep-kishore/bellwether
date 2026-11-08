// Linear issues attached to a chat's composer, kept in `shared("bw.chat.attach")` by the chat's tab id:
// bw-linear adds a chip, bw-chat shows it and turns it into text at Send. Pure and Herdr-free.

export const ATTACH = "bw.chat.attach";
/** A description longer than this is trimmed or sent as a file (design spec, Issues). */
export const TEXT_LIMIT = 8 * 1024;
const PREVIEW = 400;
const MAX_CHIPS = 10;

/**
 * @typedef {object} Chip
 * @property {string} identifier
 * @property {string} title
 * @property {string} url
 * @property {string} state
 * @property {string} preview the description's start, for the hover card
 * @property {number} bytes the description's length in UTF-8
 * @property {"trim" | "file" | null} mode how a description over the limit goes
 * @property {number} at
 */

const isObj = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");

/** @param {any} c @returns {Chip | null} */
function readChip(c) {
  if (!isObj(c) || typeof c.identifier !== "string" || !/^[A-Za-z0-9]+-\d+$/.test(c.identifier)) return null;
  return {
    identifier: c.identifier,
    title: str(c.title),
    url: str(c.url),
    state: str(c.state),
    preview: str(c.preview).slice(0, PREVIEW),
    bytes: Number.isFinite(c.bytes) ? Number(c.bytes) : 0,
    mode: c.mode === "trim" || c.mode === "file" ? c.mode : null,
    at: Number(c.at) || 0,
  };
}

/** @param {unknown} value @returns {Record<string, Chip[]>} */
function readTabs(value) {
  /** @type {Record<string, Chip[]>} */
  const out = {};
  const v = /** @type {any} */ (value);
  if (!isObj(v) || v.version !== 1 || !isObj(v.tabs)) return out;
  for (const [tab, list] of Object.entries(v.tabs)) {
    if (!Array.isArray(list)) continue;
    const chips = list.map(readChip).filter((c) => c !== null);
    if (chips.length) out[tab] = /** @type {Chip[]} */ (chips);
  }
  return out;
}

/** @param {Record<string, Chip[]>} tabs */
const wrap = (tabs) => ({ version: 1, tabs });

/** UTF-8 bytes in `s`, counted by hand: Herdr's script runtime has no TextEncoder. @param {string} s */
function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** @param {unknown} stored @param {string | null} tab @returns {Chip[]} */
export function chipsFor(stored, tab) {
  return tab === null ? [] : (readTabs(stored)[tab] ?? []);
}

/**
 * A chip for an issue as `bw linear issue` printed it.
 * @param {any} line @param {number} now
 * @returns {Chip | null}
 */
export function chipFrom(line, now) {
  const description = str(line?.description);
  return readChip({
    identifier: line?.identifier,
    title: line?.title,
    url: line?.url,
    state: line?.state?.name,
    preview: description.slice(0, PREVIEW),
    bytes: Number.isFinite(line?.bytes) ? line.bytes : utf8Length(description),
    mode: null,
    at: now,
  });
}

/**
 * The stored value with `chip` on `tab`'s composer, once; tabs not in `liveTabs` are dropped.
 * @param {unknown} stored @param {string} tab @param {Chip} chip @param {string[]} liveTabs
 */
export function addChip(stored, tab, chip, liveTabs) {
  const tabs = readTabs(stored);
  for (const t of Object.keys(tabs)) if (t !== tab && !liveTabs.includes(t)) delete tabs[t];
  const list = (tabs[tab] ?? []).filter((c) => c.identifier !== chip.identifier);
  tabs[tab] = [...list, chip].slice(-MAX_CHIPS);
  return wrap(tabs);
}

/** @param {unknown} stored @param {string} tab @param {string} identifier */
export function removeChip(stored, tab, identifier) {
  return clearChips(stored, tab, [identifier]);
}

/** @param {unknown} stored @param {string} tab @param {string[]} identifiers */
export function clearChips(stored, tab, identifiers) {
  const tabs = readTabs(stored);
  const list = (tabs[tab] ?? []).filter((c) => !identifiers.includes(c.identifier));
  if (list.length) tabs[tab] = list;
  else delete tabs[tab];
  return wrap(tabs);
}

/** @param {unknown} stored @param {string} tab @param {string} identifier @param {"trim" | "file" | null} mode */
export function setChipMode(stored, tab, identifier, mode) {
  const tabs = readTabs(stored);
  tabs[tab] = (tabs[tab] ?? []).map((c) => (c.identifier === identifier ? { ...c, mode } : c));
  return wrap(tabs);
}

/** Over the limit with no choice yet: Send must wait. @param {Chip} chip */
export const needsChoice = (chip) => chip.bytes > TEXT_LIMIT && chip.mode === null;

/**
 * The window-side `bw` arguments that build a chip's text. `terminal` is the chat's full terminal address,
 * where `hc put` sends a description that goes as a file.
 * @param {Chip} chip @param {string} terminal
 * @returns {string[]}
 */
export function textArgs(chip, terminal) {
  const args = ["linear", "issue", "--id", chip.identifier, "--text"];
  if (chip.bytes > TEXT_LIMIT && chip.mode === "trim") args.push("--trim");
  if (chip.bytes > TEXT_LIMIT && chip.mode === "file") args.push("--put", terminal);
  return args;
}

/**
 * What Send types: each issue's text (it ends in a `---` line), then the user's message.
 * @param {string[]} texts @param {string} message
 */
export function composeMessage(texts, message) {
  const head = texts.map((t) => (t.endsWith("\n") ? t : `${t}\n`)).join("");
  return message ? `${head}${message}` : head.replace(/\n+$/, "");
}

/**
 * The tab Attach adds to: the active space's active tab, when it holds a bw-chat pane.
 * @param {any[]} spaces SpaceInfo[] @param {any[]} panes PaneInfo[]
 * @returns {string | null}
 */
export function chatTabOf(spaces, panes) {
  const tab = spaces.find((s) => s.active)?.tabs?.find((/** @type {any} */ t) => t.active);
  if (!tab) return null;
  return panes.some((p) => p.mod === "bw-chat" && p.tab === tab.id) ? tab.id : null;
}

/** "9.1 KB" @param {number} bytes */
export function sizeText(bytes) {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}
