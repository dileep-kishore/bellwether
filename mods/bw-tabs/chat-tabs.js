// Chat tabs: how a tab "+" started becomes a terminal beside a bw-chat pane, how ⌘J flips between
// the two, and when a chat counts as shown. Pure and Herdr-free: callers pass spaces(), panes() and now.

/** @typedef {"claude" | "codex"} ChatKind */

/**
 * @typedef {object} Entry One chat tab, keyed by its tab id in `ChatTabs.tabs`.
 * @property {string} tab
 * @property {string} space
 * @property {string | null} machine
 * @property {ChatKind} kind
 * @property {string} terminal full address, `machine/t` when remote
 * @property {string} terminalPane
 * @property {string | null} chatPane
 * @property {{ at: number, tries: number } | null} split
 * @property {boolean} zoomed the chat pane's one zoom has run
 * @property {boolean} failed
 * @property {number} created
 */

/**
 * @typedef {object} Pending A chat "+" asked for whose tab has not appeared yet.
 * @property {string} id
 * @property {ChatKind} kind
 * @property {string | null} machine
 * @property {string | null} space
 * @property {string | null} folder
 * @property {string[]} beforeTabs the space's tab ids before tab.new
 * @property {string[]} beforeSpaces every space id before space.new
 * @property {string} name
 * @property {number} at
 */

/**
 * @typedef {object} ChatTabs The value of `shared("bw.chat-tabs")`.
 * @property {1} version
 * @property {Record<string, Entry>} tabs
 * @property {Pending[]} pending
 */

/** @typedef {[string, Record<string, unknown>]} Action */
/** @typedef {{ title: string, body: string }} Notice */

export const CHAT_PENDING_MS = 30000;
export const SPLIT_RETRY_MS = 5000;
const SPLIT_TRIES = 2;

const isKind = (/** @type {unknown} */ k) => k === "claude" || k === "codex";
const isStr = (/** @type {unknown} */ s) => typeof s === "string" && s !== "";
const strOrNull = (/** @type {unknown} */ s) => s === null || typeof s === "string";
const isNum = (/** @type {unknown} */ n) => typeof n === "number" && Number.isFinite(n);
const isObj = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((s) => typeof s === "string");

/** @param {string} tabId @param {any} e @returns {Entry | null} */
function readEntry(tabId, e) {
  if (!isObj(e) || e.tab !== tabId || !isStr(e.space) || !strOrNull(e.machine) || !isKind(e.kind)) return null;
  if (!isStr(e.terminal) || !isStr(e.terminalPane) || !(e.chatPane === null || isStr(e.chatPane))) return null;
  const split = isObj(e.split) && isNum(e.split.at) && isNum(e.split.tries) ? { at: e.split.at, tries: e.split.tries } : null;
  return {
    tab: e.tab, space: e.space, machine: e.machine, kind: e.kind, terminal: e.terminal, terminalPane: e.terminalPane,
    chatPane: e.chatPane, split, zoomed: e.zoomed === true, failed: e.failed === true, created: isNum(e.created) ? e.created : 0,
  };
}

/** @param {any} p @returns {Pending | null} */
function readPending(p) {
  if (!isObj(p) || !isStr(p.id) || !isKind(p.kind) || !strOrNull(p.machine) || !strOrNull(p.space) || !strOrNull(p.folder)) return null;
  if (!strings(p.beforeTabs) || !strings(p.beforeSpaces) || typeof p.name !== "string" || !isNum(p.at)) return null;
  return {
    id: p.id, kind: p.kind, machine: p.machine, space: p.space, folder: p.folder,
    beforeTabs: [...p.beforeTabs], beforeSpaces: [...p.beforeSpaces], name: p.name, at: p.at,
  };
}

/**
 * A fresh copy of the stored value; anything malformed reads as empty, entry by entry.
 * @param {unknown} value
 * @returns {ChatTabs}
 */
export function readChatTabs(value) {
  /** @type {ChatTabs} */
  const out = { version: 1, tabs: {}, pending: [] };
  const v = /** @type {any} */ (value);
  if (!isObj(v) || v.version !== 1) return out;
  if (isObj(v.tabs)) {
    for (const [id, e] of Object.entries(v.tabs)) {
      const entry = readEntry(id, e);
      if (entry) out.tabs[id] = entry;
    }
  }
  if (Array.isArray(v.pending)) {
    for (const p of v.pending) {
      const pending = readPending(p);
      if (pending) out.pending.push(pending);
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {Omit<Pending, "id" | "at">} p
 * @param {number} now
 * @returns {ChatTabs}
 */
export function addPending(value, p, now) {
  const s = readChatTabs(value);
  const ids = new Set(s.pending.map((x) => x.id));
  let n = 0;
  while (ids.has(`p-${now}-${n}`)) n += 1;
  s.pending.push({
    id: `p-${now}-${n}`, kind: p.kind, machine: p.machine ?? null, space: p.space ?? null, folder: p.folder ?? null,
    beforeTabs: [...(p.beforeTabs ?? [])], beforeSpaces: [...(p.beforeSpaces ?? [])], name: p.name, at: now,
  });
  return s;
}

/** @param {any[]} panes @param {string} tabId */
const terminalPaneIn = (panes, tabId) => panes.find((p) => p.tab === tabId && !p.mod && isStr(p.terminal)) ?? null;

/** @param {Entry} e @returns {Action} */
const splitAction = (e) => ["pane.split", {
  direction: "right", pane: e.terminalPane, mod: "bw-chat", props: { terminal: e.terminal, machine: e.machine, kind: e.kind },
}];

/**
 * The tab a pending chat should take, or null while it has not appeared.
 * @param {Pending} p
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @param {Record<string, Entry>} tabs
 */
function newTabFor(p, spaces, panes, tabs) {
  const free = (/** @type {any} */ t) => !tabs[t.id] && terminalPaneIn(panes, t.id);
  if (p.space !== null) {
    const space = spaces.find((s) => s.id === p.space);
    const t = space?.tabs.find((/** @type {any} */ t) => !p.beforeTabs.includes(t.id) && free(t));
    return t ? { space, tab: t } : null;
  }
  for (const space of spaces) {
    if (p.beforeSpaces.includes(space.id) || (space.machine ?? null) !== p.machine) continue;
    const t = space.tabs[0];
    if (t && free(t)) return { space, tab: t };
  }
  return null;
}

/**
 * One render's worth of chat-tab bookkeeping. `next` is null when nothing changed, so the caller
 * writes `setShared` only on change; a second call with the same inputs yields no actions.
 * @param {unknown} value `shared("bw.chat-tabs")`
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @param {number} now
 * @returns {{ next: ChatTabs | null, actions: Action[], notices: Notice[] }}
 */
export function adopt(value, spaces, panes, now) {
  const s = readChatTabs(value);
  /** @type {Action[]} */
  const actions = [];
  /** @type {Notice[]} */
  const notices = [];
  let changed = false;

  const liveTabs = new Set(spaces.flatMap((sp) => sp.tabs.map((/** @type {any} */ t) => t.id)));
  for (const id of Object.keys(s.tabs)) {
    if (liveTabs.has(id)) continue;
    delete s.tabs[id];
    changed = true;
  }

  /** @type {Pending[]} */
  const waiting = [];
  for (const p of s.pending) {
    const found = newTabFor(p, spaces, panes, s.tabs);
    if (found) {
      const pane = terminalPaneIn(panes, found.tab.id);
      /** @type {Entry} */
      const e = {
        tab: found.tab.id, space: found.space.id, machine: p.machine, kind: p.kind, terminal: pane.terminal,
        terminalPane: pane.pane, chatPane: null, split: { at: now, tries: 1 }, zoomed: false, failed: false, created: now,
      };
      s.tabs[e.tab] = e;
      actions.push(splitAction(e));
      changed = true;
    } else if (now - p.at > CHAT_PENDING_MS) {
      notices.push({ title: `${p.name} chat did not start`, body: "No new tab appeared within 30 s." });
      changed = true;
    } else {
      waiting.push(p);
    }
  }
  s.pending = waiting;

  for (const e of Object.values(s.tabs)) {
    if (e.chatPane === null) {
      const chat = panes.find((p) => p.tab === e.tab && p.mod === "bw-chat");
      if (chat) {
        e.chatPane = chat.pane;
        e.failed = false;
        changed = true;
      } else if (!e.failed && e.split && now >= e.split.at + SPLIT_RETRY_MS) {
        if (e.split.tries < SPLIT_TRIES) {
          e.split = { at: now, tries: e.split.tries + 1 };
          actions.push(splitAction(e));
        } else {
          e.failed = true;
          notices.push({ title: "Chat pane did not open", body: "The agent keeps running in this tab." });
        }
        changed = true;
      }
    }
    if (e.chatPane !== null && !e.zoomed) {
      e.zoomed = true;
      actions.push(["pane.zoom", { pane: e.chatPane }]);
      changed = true;
    }
  }

  return { next: changed ? s : null, actions, notices };
}

/**
 * When `adopt` next has something to do by the clock alone (a pending expiring, a split retry), or null.
 * @param {unknown} value
 * @returns {number | null}
 */
export function wakeAt(value) {
  const s = readChatTabs(value);
  const times = [
    ...s.pending.map((p) => p.at + CHAT_PENDING_MS + 1),
    ...Object.values(s.tabs).filter((e) => e.chatPane === null && !e.failed && e.split).map((e) => /** @type {{ at: number }} */ (e.split).at + SPLIT_RETRY_MS),
  ];
  return times.length ? Math.min(...times) : null;
}

/**
 * @param {Entry} e
 * @param {any[]} panes PaneInfo[]
 */
function panesOf(e, panes) {
  const chat = e.chatPane === null ? null : panes.find((p) => p.pane === e.chatPane && p.tab === e.tab && p.mod === "bw-chat") ?? null;
  const term = panes.find((p) => p.pane === e.terminalPane && p.tab === e.tab && p.terminal === e.terminal) ?? null;
  return { chat, term };
}

/**
 * The commands ⌘J runs in the active tab: none unless it is a chat tab with both panes present.
 * @param {unknown} value
 * @param {string | null} activeTabId
 * @param {any[]} panes PaneInfo[]
 * @returns {Action[]}
 */
export function flipActions(value, activeTabId, panes) {
  const e = activeTabId === null ? null : readChatTabs(value).tabs[activeTabId];
  if (!e) return [];
  const { chat, term } = panesOf(e, panes);
  if (!chat || !term) return [];
  /** @param {any} from @param {any} to @returns {Action[]} */
  const swap = (from, to) => [["pane.zoom", { pane: from.pane }], ["pane.zoom", { pane: to.pane }], ["pane.focus", { pane: to.pane }]];
  if (chat.zoomed) return swap(chat, term);
  if (term.zoomed) return swap(term, chat);
  // With focus outside both panes, the chat is the one shown.
  const target = chat.focused ? term : chat;
  return [["pane.zoom", { pane: target.pane }], ["pane.focus", { pane: target.pane }]];
}

/**
 * @param {unknown} value
 * @param {string} terminal full address
 * @returns {Entry | null}
 */
export function entryForTerminal(value, terminal) {
  return Object.values(readChatTabs(value).tabs).find((e) => e.terminal === terminal) ?? null;
}

/**
 * Shown: its tab is the active tab of the active space, and its chat pane is zoomed or the tab is not.
 * @param {Entry | null} entry
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 */
export function isShown(entry, spaces, panes) {
  if (!entry) return false;
  const space = spaces.find((s) => s.active);
  const tab = space?.tabs.find((/** @type {any} */ t) => t.id === entry.tab);
  if (!tab?.active) return false;
  const chat = entry.chatPane === null ? null : panes.find((p) => p.pane === entry.chatPane);
  return Boolean(chat?.zoomed) || !tab.zoomed;
}

/**
 * The argv a chat tab starts its agent with; phase 4 passes its per-session additions as `extras`.
 * @param {ChatKind} _kind
 * @param {string[]} run `agent.run` from knownAgents
 * @param {string[]} [extras]
 */
export function chatArgv(_kind, run, extras = []) {
  return [...run, ...extras];
}
