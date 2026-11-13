// Chat tabs and screen routing: how "+" launches single-pane chat or terminal tabs, how legacy bw-chat
// split panes close cleanly, how ⌘J flips between chat and panes, and how focus leaves are tracked.
// Pure and Herdr-free: callers pass spaces(), panes(), shared values, and now.

/** @typedef {"claude" | "codex"} ChatKind */
/** @typedef {"chat" | "panes" | "needs" | "overview"} ScreenId */
/** @typedef {"chat" | "panes"} TabScreen */

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
 * @property {boolean} zoomed
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
 * @typedef {object} PendingTabView A "New terminal" launch whose tab should open in `panes`.
 * @property {string} id
 * @property {string | null} machine
 * @property {string | null} space
 * @property {string | null} folder
 * @property {string[]} beforeTabs
 * @property {string[]} beforeSpaces
 * @property {string | null} name null for unnamed shell tabs
 * @property {number} at
 */

/**
 * @typedef {object} ChatTabs The value of `shared("bw.chat-tabs")`.
 * @property {1} version
 * @property {Record<string, Entry>} tabs
 * @property {Pending[]} pending
 * @property {string[]} [closing] legacy bw-chat pane ids already asked to close
 */

/** @typedef {[string, Record<string, unknown>]} Action */
/** @typedef {{ title: string, body: string }} Notice */

export const CHAT_PENDING_MS = 30000;
export const CHAT_SHOWN = "bw.chat-shown";
export const TERMINAL_FOCUS = "bw.terminal-focus";
export const SCREEN_KEY = "bw.screen";
export const TAB_VIEW = "bw.tab-view";
export const PENDING_TAB_VIEW = "bw.tab-view.pending";
export const CHAT_AGENT = "bw.chat-agent";
export const PR_SUMMARY = "bw.pr-summary";

const FOCUS_KEEP_MS = 60_000;

const isKind = (/** @type {unknown} */ k) => k === "claude" || k === "codex";
const isTabScreen = (/** @type {unknown} */ v) => v === "chat" || v === "panes";
const isStr = (/** @type {unknown} */ s) => typeof s === "string" && s !== "";
const strOrNull = (/** @type {unknown} */ s) => s === null || typeof s === "string";
const isNum = (/** @type {unknown} */ n) => typeof n === "number" && Number.isFinite(n);
const isObj = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((s) => typeof s === "string");

/** @param {string} tabId @param {any} e @returns {Entry | null} */
function readEntry(tabId, e) {
  if (!isObj(e) || e.tab !== tabId || !isStr(e.space) || !strOrNull(e.machine) || !isKind(e.kind)) return null;
  if (!isStr(e.terminal) || !isStr(e.terminalPane) || !(e.chatPane === null || isStr(e.chatPane))) return null;
  const split =
    isObj(e.split) && isNum(e.split.at) && isNum(e.split.tries) ? { at: e.split.at, tries: e.split.tries } : null;
  return {
    tab: e.tab,
    space: e.space,
    machine: e.machine,
    kind: e.kind,
    terminal: e.terminal,
    terminalPane: e.terminalPane,
    chatPane: e.chatPane,
    split,
    zoomed: e.zoomed === true,
    failed: e.failed === true,
    created: isNum(e.created) ? e.created : 0,
  };
}

/** @param {any} p @returns {Pending | null} */
function readPending(p) {
  if (
    !isObj(p) ||
    !isStr(p.id) ||
    !isKind(p.kind) ||
    !strOrNull(p.machine) ||
    !strOrNull(p.space) ||
    !strOrNull(p.folder)
  )
    return null;
  if (!strings(p.beforeTabs) || !strings(p.beforeSpaces) || typeof p.name !== "string" || !isNum(p.at)) return null;
  return {
    id: p.id,
    kind: p.kind,
    machine: p.machine,
    space: p.space,
    folder: p.folder,
    beforeTabs: [...p.beforeTabs],
    beforeSpaces: [...p.beforeSpaces],
    name: p.name,
    at: p.at,
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
  if (Array.isArray(v.closing)) {
    const closing = v.closing.filter(isStr);
    if (closing.length) out.closing = [...new Set(closing)];
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
    id: `p-${now}-${n}`,
    kind: p.kind,
    machine: p.machine ?? null,
    space: p.space ?? null,
    folder: p.folder ?? null,
    beforeTabs: [...(p.beforeTabs ?? [])],
    beforeSpaces: [...(p.beforeSpaces ?? [])],
    name: p.name,
    at: now,
  });
  return s;
}

/** @param {any[]} panes @param {string} tabId */
const terminalPaneIn = (panes, tabId) => panes.find((p) => p.tab === tabId && !p.mod && isStr(p.terminal)) ?? null;

/** The agent a terminal pane runs, from Herdr's program table or the agent's own report. @param {any} pane
 * @returns {ChatKind | null} */
export function paneKind(pane) {
  const key = pane?.program?.key;
  if (isKind(key)) return key;
  return pane?.app === "codex" ? "codex" : pane?.app === "claude-code" ? "claude" : null;
}

/** @param {unknown} f */
const trimSlash = (f) => String(f ?? "").replace(/\/+$/, "");

/**
 * The new tab a pending chat should take, named as it asked, in its space or a new space in its folder;
 * null until it appears.
 * @param {Pending} p
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @param {Record<string, Entry>} tabs
 */
function newTabFor(p, spaces, panes, tabs) {
  const ours = (/** @type {any} */ t) => t.name === p.name && !tabs[t.id] && terminalPaneIn(panes, t.id);
  if (p.space !== null) {
    const space = spaces.find((s) => s.id === p.space);
    const t = space?.tabs.find((/** @type {any} */ t) => !p.beforeTabs.includes(t.id) && ours(t));
    return t ? { space, tab: t } : null;
  }
  for (const space of spaces) {
    if (p.beforeSpaces.includes(space.id) || (space.machine ?? null) !== p.machine) continue;
    if (p.folder !== null && trimSlash(space.folder) !== trimSlash(p.folder)) continue;
    const t = space.tabs[0];
    if (t && ours(t)) return { space, tab: t };
  }
  return null;
}

/**
 * One render's worth of chat-tab bookkeeping. Single-pane chat tabs are recorded without splitting or zooming,
 * and pre-upgrade `mod === "bw-chat"` split panes are unzoomed and closed while leaving their terminal intact.
 * `next` is null when nothing changed; a second call with the same inputs yields no actions.
 * @param {unknown} value `shared("bw.chat-tabs")`
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @param {number} now
 * @param {string | null} [_windowId]
 * @returns {{ next: ChatTabs | null, actions: Action[], notices: Notice[] }}
 */
export function adopt(value, spaces, panes, now, _windowId = null) {
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
      s.tabs[found.tab.id] = {
        tab: found.tab.id,
        space: found.space.id,
        machine: p.machine,
        kind: p.kind,
        terminal: pane.terminal,
        terminalPane: pane.pane,
        chatPane: null,
        split: null,
        zoomed: false,
        failed: false,
        created: now,
      };
      changed = true;
    } else if (now - p.at > CHAT_PENDING_MS) {
      notices.push({ title: `${p.name} chat did not start`, body: "No new tab appeared within 30 s." });
      changed = true;
    } else {
      waiting.push(p);
    }
  }
  s.pending = waiting;

  // Register pre-upgrade tabs that had one Claude/Codex terminal alongside a legacy bw-chat split pane.
  for (const space of spaces) {
    for (const t of space.tabs) {
      if (s.tabs[t.id]) continue;
      const terms = panes.filter((p) => p.tab === t.id && !p.mod && isStr(p.terminal));
      const chats = panes.filter((p) => p.tab === t.id && p.mod === "bw-chat");
      const kind = terms.length === 1 ? paneKind(terms[0]) : null;
      if (!kind || chats.length === 0) continue;
      s.tabs[t.id] = {
        tab: t.id,
        space: space.id,
        machine: space.machine ?? null,
        kind,
        terminal: terms[0].terminal,
        terminalPane: terms[0].pane,
        chatPane: null,
        split: null,
        zoomed: false,
        failed: false,
        created: now,
      };
      changed = true;
    }
  }

  // Clear legacy split fields on stored entries.
  for (const e of Object.values(s.tabs)) {
    if (e.chatPane !== null || e.split !== null || e.zoomed || e.failed) {
      e.chatPane = null;
      e.split = null;
      e.zoomed = false;
      e.failed = false;
      changed = true;
    }
  }

  // Close legacy bw-chat split panes on tabs that still hold a live terminal pane, once per pane id.
  const liveChatPaneIds = new Set(panes.filter((p) => p.mod === "bw-chat" && isStr(p.pane)).map((p) => p.pane));
  const prevClosing = s.closing ?? [];
  const nextClosing = prevClosing.filter((id) => liveChatPaneIds.has(id));
  if (nextClosing.length !== prevClosing.length) changed = true;
  const closingSet = new Set(nextClosing);

  for (const chat of panes) {
    if (chat.mod !== "bw-chat" || !isStr(chat.pane) || !liveTabs.has(chat.tab)) continue;
    if (!panes.some((p) => p.tab === chat.tab && !p.mod && isStr(p.terminal))) continue;
    if (closingSet.has(chat.pane)) continue;
    if (chat.zoomed) actions.push(["pane.zoom", { pane: chat.pane }]);
    actions.push(["pane.close", { pane: chat.pane }]);
    closingSet.add(chat.pane);
    nextClosing.push(chat.pane);
    changed = true;
  }

  if (nextClosing.length) s.closing = nextClosing;
  else delete s.closing;

  return { next: changed ? s : null, actions, notices };
}

/**
 * Reads `shared("bw.tab-view")` (`Record<tabId, "chat" | "panes">`).
 * @param {unknown} value
 * @returns {Record<string, TabScreen>}
 */
export function readTabViews(value) {
  /** @type {Record<string, TabScreen>} */
  const out = {};
  if (!isObj(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (isStr(k) && isTabScreen(v)) out[k] = v;
  }
  return out;
}

/**
 * Sets `tabId`'s screen override and prunes closed tabs.
 * @param {unknown} value
 * @param {string} tabId
 * @param {TabScreen} view
 * @param {Iterable<string>} [liveTabs]
 * @returns {Record<string, TabScreen>}
 */
export function writeTabView(value, tabId, view, liveTabs) {
  const prev = readTabViews(value);
  const keep = liveTabs ? new Set(liveTabs) : null;
  /** @type {Record<string, TabScreen>} */
  const out = {};
  for (const [k, v] of Object.entries(prev)) {
    if (!keep || keep.has(k) || k === tabId) out[k] = v;
  }
  out[tabId] = view;
  return out;
}

/** @param {unknown} value @returns {PendingTabView[]} */
export function readPendingTabViews(value) {
  if (!Array.isArray(value)) return [];
  /** @type {PendingTabView[]} */
  const out = [];
  for (const p of value) {
    if (
      !isObj(p) ||
      !isStr(p.id) ||
      !strOrNull(p.machine) ||
      !strOrNull(p.space) ||
      !strOrNull(p.folder) ||
      !strOrNull(p.name) ||
      !strings(p.beforeTabs) ||
      !strings(p.beforeSpaces) ||
      !isNum(p.at)
    )
      continue;
    out.push({
      id: p.id,
      machine: p.machine,
      space: p.space,
      folder: p.folder,
      beforeTabs: [...p.beforeTabs],
      beforeSpaces: [...p.beforeSpaces],
      name: p.name,
      at: p.at,
    });
  }
  return out;
}

/**
 * Records a "New terminal" launch so `bw-tabs` marks its tab `"panes"` in `bw.tab-view` once it appears.
 * @param {unknown} value
 * @param {Omit<PendingTabView, "id" | "at">} p
 * @param {number} now
 * @returns {PendingTabView[]}
 */
export function addPendingTabView(value, p, now) {
  const list = readPendingTabViews(value);
  const ids = new Set(list.map((x) => x.id));
  let n = 0;
  while (ids.has(`tv-${now}-${n}`)) n += 1;
  list.push({
    id: `tv-${now}-${n}`,
    machine: p.machine ?? null,
    space: p.space ?? null,
    folder: p.folder ?? null,
    beforeTabs: [...(p.beforeTabs ?? [])],
    beforeSpaces: [...(p.beforeSpaces ?? [])],
    name: p.name ?? null,
    at: now,
  });
  return list;
}

/**
 * Adopts pending "New terminal" launches into `bw.tab-view` (`"panes"`) and prunes closed tabs.
 * @param {unknown} viewsValue `shared("bw.tab-view")`
 * @param {unknown} pendingValue `shared("bw.tab-view.pending")`
 * @param {any[]} spaces
 * @param {any[]} panes
 * @param {unknown} chatTabsValue `shared("bw.chat-tabs")`
 * @param {number} now
 * @returns {{ nextViews: Record<string, TabScreen> | null, nextPending: PendingTabView[] | null }}
 */
export function adoptTabViews(viewsValue, pendingValue, spaces, panes, chatTabsValue, now) {
  const views = readTabViews(viewsValue);
  const pending = readPendingTabViews(pendingValue);
  const chatTabs = readChatTabs(chatTabsValue);
  const liveTabs = new Set(spaces.flatMap((sp) => sp.tabs.map((/** @type {any} */ t) => t.id)));
  let viewsChanged = false;
  let pendingChanged = false;

  for (const id of Object.keys(views)) {
    if (!liveTabs.has(id)) {
      delete views[id];
      viewsChanged = true;
    }
  }

  const claimed = new Set(Object.keys(views));
  for (const id of Object.keys(chatTabs.tabs)) claimed.add(id);

  /** @type {PendingTabView[]} */
  const waiting = [];
  for (const p of pending) {
    const matchTab = (/** @type {any} */ t) =>
      !claimed.has(t.id) && (p.name === null ? !t.named : t.name === p.name) && Boolean(terminalPaneIn(panes, t.id));
    let found = null;
    if (p.space !== null) {
      const space = spaces.find((s) => s.id === p.space);
      found = space?.tabs.find((/** @type {any} */ t) => !p.beforeTabs.includes(t.id) && matchTab(t)) ?? null;
    } else {
      for (const space of spaces) {
        if (p.beforeSpaces.includes(space.id) || (space.machine ?? null) !== p.machine) continue;
        if (p.folder !== null && trimSlash(space.folder) !== trimSlash(p.folder)) continue;
        const t = space.tabs[0];
        if (t && matchTab(t)) {
          found = t;
          break;
        }
      }
    }
    if (found) {
      views[found.id] = "panes";
      claimed.add(found.id);
      viewsChanged = true;
      pendingChanged = true;
    } else if (now - p.at > CHAT_PENDING_MS) {
      pendingChanged = true;
    } else {
      waiting.push(p);
    }
  }

  return {
    nextViews: viewsChanged ? views : null,
    nextPending: pendingChanged ? waiting : null,
  };
}

/**
 * Whether `tabId` is a chat-capable tab (listed in `bw.chat-tabs` or holding a Claude/Codex terminal pane).
 * @param {string | null} tabId
 * @param {any[]} panes
 * @param {unknown} chatTabs
 * @returns {boolean}
 */
export function isChatTab(tabId, panes, chatTabs) {
  if (!tabId) return false;
  if (readChatTabs(chatTabs).tabs[tabId]) return true;
  return panes.some((p) => p.tab === tabId && !p.mod && paneKind(p) !== null);
}

/**
 * Resolves `tabId`'s desired screen (`"chat"` or `"panes"`).
 * @param {string | null} tabId
 * @param {any[]} panes
 * @param {unknown} chatTabs
 * @param {unknown} tabViews
 * @returns {TabScreen}
 */
export function desiredScreen(tabId, panes, chatTabs, tabViews) {
  if (!tabId) return "chat";
  const override = readTabViews(tabViews)[tabId];
  if (override === "panes") return "panes";
  const chat = isChatTab(tabId, panes, chatTabs);
  if (override === "chat" && chat) return "chat";
  return chat ? "chat" : "panes";
}

/**
 * Resolves the target Claude/Codex agent pane in `tabId` in priority order:
 * `bw.chat-agent[tabId]` -> focused Claude/Codex pane -> `bw.chat-tabs[tabId]` -> first Claude/Codex pane.
 * @param {string | null} tabId
 * @param {any[]} panes
 * @param {unknown} [chatTabs]
 * @param {unknown} [chatAgents]
 * @returns {{ pane: string, terminal: string, kind: ChatKind } | null}
 */
export function resolveTabAgent(tabId, panes, chatTabs = null, chatAgents = null) {
  if (!tabId) return null;
  const agentPanes = panes
    .filter((p) => p.tab === tabId && !p.mod && isStr(p.terminal) && paneKind(p) !== null)
    .map((p) => ({
      pane: String(p.pane ?? ""),
      terminal: p.terminal,
      kind: /** @type {ChatKind} */ (paneKind(p)),
      focused: Boolean(p.focused),
    }));
  if (agentPanes.length === 0) return null;
  const pinned = isObj(chatAgents) ? /** @type {any} */ (chatAgents)[tabId] : null;
  if (isStr(pinned)) {
    const hit = agentPanes.find((p) => p.terminal === pinned);
    if (hit) return { pane: hit.pane, terminal: hit.terminal, kind: hit.kind };
  }
  const focusedPane = agentPanes.find((p) => p.focused);
  if (focusedPane) return { pane: focusedPane.pane, terminal: focusedPane.terminal, kind: focusedPane.kind };
  const recorded = readChatTabs(chatTabs).tabs[tabId]?.terminal;
  if (isStr(recorded)) {
    const hit = agentPanes.find((p) => p.terminal === recorded);
    if (hit) return { pane: hit.pane, terminal: hit.terminal, kind: hit.kind };
  }
  const first = agentPanes[0];
  return { pane: first.pane, terminal: first.terminal, kind: first.kind };
}

/**
 * Resolves the active terminal address in `tabId` (target agent terminal, else focused terminal, else first terminal).
 * @param {string | null} tabId
 * @param {any[]} panes
 * @param {unknown} [chatTabs]
 * @param {unknown} [chatAgents]
 * @returns {string | null}
 */
export function resolveTabTerminal(tabId, panes, chatTabs = null, chatAgents = null) {
  if (!tabId) return null;
  const agent = resolveTabAgent(tabId, panes, chatTabs, chatAgents);
  if (agent) return agent.terminal;
  const terms = panes.filter((p) => p.tab === tabId && !p.mod && isStr(p.terminal));
  return (terms.find((p) => p.focused) ?? terms[0])?.terminal ?? null;
}

/**
 * When `adopt` or `adoptTabViews` next has a pending expiry by the clock alone, or null.
 * @param {unknown} value `shared("bw.chat-tabs")`
 * @param {unknown} [pendingViews] `shared("bw.tab-view.pending")`
 * @returns {number | null}
 */
export function wakeAt(value, pendingViews = null) {
  const s = readChatTabs(value);
  const pv = readPendingTabViews(pendingViews);
  const times = [...s.pending.map((p) => p.at + CHAT_PENDING_MS + 1), ...pv.map((p) => p.at + CHAT_PENDING_MS + 1)];
  return times.length ? Math.min(...times) : null;
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
 * Legacy helper for per-pane `bw-chat` instances: the bw-chat panes on screen in the active tab.
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @returns {string[]}
 */
export function shownChatPanes(spaces, panes) {
  const tab = spaces.find((s) => s.active)?.tabs.find((/** @type {any} */ t) => t.active);
  if (!tab) return [];
  return panes
    .filter((p) => p.mod === "bw-chat" && p.tab === tab.id && (p.zoomed || !tab.zoomed))
    .map((p) => p.pane)
    .sort();
}

/**
 * Whether a layout tree shows `mod` in a block, floating blocks included.
 * @param {any} node `layout()` @param {string} mod
 * @returns {boolean}
 */
export function hasMod(node, mod) {
  if (!isObj(node)) return false;
  if (isObj(node.content) && node.content.mod === mod) return true;
  return [
    ...(Array.isArray(node.children) ? node.children : []),
    ...(Array.isArray(node.floating) ? node.floating : []),
  ].some((c) => hasMod(c, mod));
}

/**
 * Whether `pane` is on screen by bw-tabs's stored list; `fallback` when there is no list or no pane.
 * @param {unknown} stored the value of `shared(CHAT_SHOWN)`
 * @param {string | null} pane this chat's pane
 * @param {boolean} fallback
 */
export function shownFrom(stored, pane, fallback) {
  if (pane === null || stored === undefined || stored === null) return fallback;
  return Array.isArray(stored) && stored.includes(pane);
}

/**
 * The focus record after `focused()?.terminal` is `focused` at `now`, or null when unchanged.
 * Treating `screenActive !== "panes"` as `focused = null` records `leftAt` immediately when switching
 * from `panes` to `chat` or `needs`, starting the 3 s answer-button cooldown cleanly.
 * @param {unknown} stored
 * @param {string | null} focused
 * @param {number} now
 * @param {string} [screenActive]
 * @returns {{ focused: string | null, left: Record<string, number> } | null}
 */
export function focusRecord(stored, focused, now, screenActive = "panes") {
  const active = screenActive === "panes" ? focused : null;
  const was =
    isObj(stored) && strOrNull(/** @type {any} */ (stored).focused) ? /** @type {any} */ (stored).focused : null;
  if (isObj(stored) ? was === active : active === null) return null;
  const old = isObj(stored) && isObj(/** @type {any} */ (stored).left) ? /** @type {any} */ (stored).left : {};
  /** @type {Record<string, number>} */
  const left = {};
  for (const [t, at] of Object.entries(old)) if (isNum(at) && now - at < FOCUS_KEEP_MS && t !== active) left[t] = at;
  if (was !== null && was !== active) left[was] = now;
  return { focused: active, left };
}

/** When focus last left `terminal` by the record, or null. @param {unknown} stored @param {string | null} terminal */
export function leftAt(stored, terminal) {
  if (terminal === null || !isObj(stored)) return null;
  const at = isObj(/** @type {any} */ (stored).left) ? /** @type {any} */ (stored).left[terminal] : undefined;
  return isNum(at) ? at : null;
}

/**
 * Shown: its tab is the active tab of the active space, and its chat pane is zoomed or the tab is not.
 * @param {Pick<Entry, "tab" | "chatPane"> | null} entry
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
 * The argv a chat tab starts its agent with; per-session browser flags pass as `extras`.
 * @param {ChatKind} _kind
 * @param {string[]} run `agent.run` from knownAgents
 * @param {string[]} [extras]
 */
export function chatArgv(_kind, run, extras = []) {
  return [...run, ...extras];
}
