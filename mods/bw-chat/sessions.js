// Up to 24 per-terminal chat sessions for stack-mode bw-chat, backed by retained host slots
// created in init() so render() never allocates TextareaState or VirtualListScrollHandle.
import { emptyFeed } from "./feedstate.js";
import { createGuard } from "./focus-guard.js";
import { chipsFor } from "./linear-attach.js";
import { agentName } from "./target.js";

export const MAX_SESSIONS = 24;

/** @typedef {import("./target.js").Kind} Kind */
/** @typedef {import("./target.js").StackFound} StackFound */
/** @typedef {import("./feedstate.js").FeedState} FeedState */
/** @typedef {import("./dock-model.js").Request} Request */
/** @typedef {import("./dock-model.js").Draft} Draft */
/** @typedef {import("./threads-model.js").Row} ThreadRow */
/** @typedef {import("./pr-model.js").PrSummary} PrSummary */

/**
 * @typedef {object} QueueItem
 * @property {string} id
 * @property {string} text
 * @property {number} at_ms
 * @property {string} expect_kind
 * @property {string | null} expect_session
 * @property {boolean} [unverified_startup]
 */

/**
 * @typedef {object} QueueView
 * @property {boolean} held
 * @property {string | null} holdReason
 * @property {QueueItem[]} items
 */

/**
 * @typedef {object} SessionSlot
 * @property {number} index
 * @property {any} scroll VirtualListScrollHandle
 * @property {{ claude: import("./composer.js").Composer, codex: import("./composer.js").Composer }} composers
 */

/**
 * @typedef {object} SessionState
 * @property {string} terminal
 * @property {string} local
 * @property {string | null} machine
 * @property {Kind} kind
 * @property {string} name
 * @property {string} tab
 * @property {string} pane
 * @property {string} spaceId
 * @property {string} folder
 * @property {string | null} branch
 * @property {SessionSlot} slot
 * @property {any} scroll
 * @property {import("./composer.js").Composer} composer
 * @property {FeedState} feed
 * @property {{ child: null } | { child: string } | { child?: undefined, terminal: string, local: string, kind: Kind | null, program: string }} view
 * @property {FeedState | null} sub
 * @property {any} tree
 * @property {any} cards
 * @property {Request[]} requests
 * @property {{ open: boolean, running: string[] } | null} toggle
 * @property {ThreadRow[]} rows
 * @property {Set<string>} sendingIds
 * @property {Map<string, string>} answerNotes
 * @property {Set<string>} cardsShown
 * @property {Set<string>} wentOut
 * @property {Map<string, Draft>} drafts
 * @property {string | null} otherKey
 * @property {string | null} viewNote
 * @property {ReturnType<typeof createGuard>} guard
 * @property {boolean} drawnGuarded
 * @property {Set<string>} open
 * @property {WeakMap<object, { w: number, open: boolean, h: number }>} heights
 * @property {boolean} follow
 * @property {boolean} topSeen
 * @property {boolean} wantOlder
 * @property {boolean} olderBusy
 * @property {boolean} sending
 * @property {{ text: string, bad: boolean } | null} note
 * @property {string | null} status
 * @property {boolean} wantDrain
 * @property {boolean} draining
 * @property {QueueView} queue
 * @property {boolean} queueLoaded
 * @property {number} queueCheckedAt
 * @property {boolean} queueBusy
 * @property {PrSummary | null} pr
 * @property {string | null} prHeadOid
 * @property {string | null} prRepo
 * @property {string | null} prRepoFolder
 * @property {string | null} prKey
 * @property {number} prCheckedAt
 * @property {boolean} prBusy
 */

/** @returns {QueueView} */
export function emptyQueue() {
  return { held: false, holdReason: null, items: [] };
}

/**
 * Parses a `{"type":"queue", ...}` NDJSON line from `bw queue`.
 * @param {any[]} lines
 * @returns {QueueView | null}
 */
export function parseQueueLine(lines) {
  const line = (lines ?? []).find((l) => l && typeof l === "object" && l.type === "queue");
  if (!line) return null;
  const items = Array.isArray(line.items)
    ? line.items
        .filter(
          (/** @type {any} */ x) =>
            x && typeof x === "object" && typeof x.id === "string" && typeof x.text === "string",
        )
        .map((/** @type {any} */ x) => ({
          id: x.id,
          text: x.text,
          at_ms: Number(x.at_ms) || 0,
          expect_kind: typeof x.expect_kind === "string" ? x.expect_kind : "",
          expect_session: typeof x.expect_session === "string" ? x.expect_session : null,
          unverified_startup: x.unverified_startup === true,
        }))
    : [];
  return {
    held: line.held === true,
    holdReason: typeof line.hold_reason === "string" && line.hold_reason ? line.hold_reason : null,
    items,
  };
}

/**
 * Builds a fresh `SessionState` bound to `slot`.
 * @param {StackFound} target
 * @param {SessionSlot} slot
 * @param {number} now
 * @returns {SessionState}
 */
export function createSession(target, slot, now) {
  const composer = slot.composers[target.kind];
  composer.clear();
  return {
    terminal: target.terminal,
    local: target.local,
    machine: target.machine,
    kind: target.kind,
    name: agentName(target.kind),
    tab: target.tab,
    pane: target.pane,
    spaceId: target.spaceId,
    folder: target.folder,
    branch: target.branch,
    slot,
    scroll: slot.scroll,
    composer,
    feed: emptyFeed(target.terminal),
    view: { child: null },
    sub: null,
    tree: null,
    cards: null,
    requests: [],
    toggle: null,
    rows: [],
    sendingIds: new Set(),
    answerNotes: new Map(),
    cardsShown: new Set(),
    wentOut: new Set(),
    drafts: new Map(),
    otherKey: null,
    viewNote: null,
    guard: createGuard(now),
    drawnGuarded: true,
    open: new Set(),
    heights: new WeakMap(),
    follow: true,
    topSeen: false,
    wantOlder: false,
    olderBusy: false,
    sending: false,
    note: null,
    status: target.status ?? null,
    wantDrain: false,
    draining: false,
    queue: emptyQueue(),
    queueLoaded: false,
    queueCheckedAt: 0,
    queueBusy: false,
    pr: null,
    prHeadOid: null,
    prRepo: null,
    prRepoFolder: null,
    prKey: null,
    prCheckedAt: 0,
    prBusy: false,
  };
}

/**
 * Resets a session when the same terminal address now runs a different agent kind.
 * @param {SessionState} s
 * @param {StackFound} target
 * @param {number} now
 */
function rebindKind(s, target, now) {
  s.kind = target.kind;
  s.name = agentName(target.kind);
  s.composer = s.slot.composers[target.kind];
  s.composer.clear();
  s.feed = emptyFeed(target.terminal);
  s.view = { child: null };
  s.sub = null;
  s.tree = null;
  s.cards = null;
  s.requests = [];
  s.toggle = null;
  s.rows = [];
  s.sendingIds.clear();
  s.answerNotes.clear();
  s.cardsShown.clear();
  s.wentOut.clear();
  s.drafts.clear();
  s.otherKey = null;
  s.viewNote = null;
  s.guard = createGuard(now);
  s.drawnGuarded = true;
  s.open.clear();
  s.follow = true;
  s.topSeen = false;
  s.wantOlder = false;
  s.olderBusy = false;
  s.sending = false;
  s.note = null;
  s.wantDrain = false;
  s.draining = false;
  s.queue = emptyQueue();
  s.queueLoaded = false;
  s.queueCheckedAt = 0;
}

/**
 * Whether `session` holds unsent composer text or attached Linear issue chips and must not be evicted.
 * @param {SessionState} session
 * @param {unknown} sharedAttach
 * @returns {boolean}
 */
export function hasUnsentDraft(session, sharedAttach) {
  const text = String(session.composer?.input?.value?.() ?? "").trim();
  if (text !== "") return true;
  return chipsFor(sharedAttach, session.tab).length > 0;
}

export class SessionMap {
  /**
   * @param {SessionSlot[]} slots pre-allocated retained state slots
   * @param {SessionSlot} fallbackSlot emergency slot if all slots hold unsent drafts
   * @param {number} [max]
   */
  constructor(slots, fallbackSlot, max = MAX_SESSIONS) {
    /** @type {Map<string, SessionState>} */
    this.map = new Map();
    /** @type {SessionSlot[]} */
    this.freeSlots = [...slots];
    this.fallbackSlot = fallbackSlot;
    this.max = max;
  }

  get size() {
    return this.map.size;
  }

  /** @param {string} terminal @returns {SessionState | null} */
  get(terminal) {
    return this.map.get(terminal) ?? null;
  }

  /** @returns {IterableIterator<SessionState>} */
  values() {
    return this.map.values();
  }

  /**
   * Acquires or updates `target`'s session, moving it to MRU and evicting the oldest unprotected
   * entry when the map reaches `max`.
   * @param {StackFound} target
   * @param {unknown} sharedAttach
   * @param {number} now
   * @returns {{ session: SessionState, created: boolean }}
   */
  acquire(target, sharedAttach, now) {
    const existing = this.map.get(target.terminal);
    if (existing) {
      this.map.delete(target.terminal);
      this.map.set(target.terminal, existing);
      existing.machine = target.machine;
      existing.local = target.local;
      existing.tab = target.tab;
      existing.pane = target.pane;
      existing.spaceId = target.spaceId;
      existing.folder = target.folder;
      existing.branch = target.branch;
      if (existing.kind !== target.kind) rebindKind(existing, target, now);
      return { session: existing, created: false };
    }

    if (this.map.size >= this.max) {
      for (const [key, candidate] of this.map.entries()) {
        if (hasUnsentDraft(candidate, sharedAttach)) continue;
        this.map.delete(key);
        if (candidate.slot !== this.fallbackSlot) {
          candidate.slot.composers.claude.clear();
          candidate.slot.composers.codex.clear();
          this.freeSlots.push(candidate.slot);
        }
        break;
      }
    }

    const slot = this.freeSlots.shift() ?? this.fallbackSlot;
    slot.composers.claude.clear();
    slot.composers.codex.clear();
    const session = createSession(target, slot, now);
    this.map.set(target.terminal, session);
    return { session, created: true };
  }
}

/**
 * Updates `shared("bw.chat-agent")` so `tabId` pins `terminal`, pruning closed tabs.
 * @param {unknown} stored
 * @param {string} tabId
 * @param {string} terminal
 * @param {Iterable<string>} [liveTabs]
 * @returns {Record<string, string>}
 */
export function pinTabAgent(stored, tabId, terminal, liveTabs) {
  const keep = liveTabs ? new Set(liveTabs) : null;
  /** @type {Record<string, string>} */
  const next = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) {
      if (keep && !keep.has(k)) continue;
      if (typeof v === "string" && v !== "") next[k] = v;
    }
  }
  next[tabId] = terminal;
  return next;
}
