// Agent chat surface: supports both per-pane props (`props().terminal`, harness compatibility) and
// layout-level stack mode (`props()` empty, 24-session LRU across spaces and tabs). One loop task
// polls `bw feed --tree --cards` (2 s while shown, 10 s while hidden) without reading live Herdr data.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, VirtualListScrollHandle } from "gpui-base";
import {
  exec,
  focused,
  home,
  layout,
  nextCommand,
  panes,
  props as herdrProps,
  run,
  setShared,
  shared,
  spaces,
  terminals,
} from "herdr";
import {
  CHAT_AGENT,
  CHAT_SHOWN,
  PR_SUMMARY,
  SCREEN_KEY,
  TERMINAL_FOCUS,
  hasMod,
  isShown,
  leftAt,
  shownFrom,
} from "./chat-tabs.js";
import { choose } from "./choice.js";
import { chipsView } from "./chips.js";
import { Composer } from "./composer.js";
import { contextStrip } from "./context-strip.js";
import { dock } from "./dock.js";
import {
  answerArgs,
  answerNote,
  answersOf,
  complete,
  digit,
  dockCards,
  emptyDraft,
  pick,
  setOther,
  toggle,
} from "./dock-model.js";
import { READ_W, columnWidth, rowHeight } from "./estimate.js";
import { applyFeed, applyOlder, emptyFeed, expectation, freshChat, newConversation, olderFrom } from "./feedstate.js";
import { REVEAL, withReveal } from "./diff-reveal.js";
import { createGuard, guardedUntil, isGuarded, observe, observeLeft } from "./focus-guard.js";
import { headOid, remoteOrigin } from "./git.js";
import { createHelper, parseLines } from "./helper.js";
import {
  ATTACH,
  chipFrom,
  chipsFor,
  clearChips,
  composeMessage,
  needsChoice,
  refreshChip,
  removeChip,
  setChipMode,
  sizeText,
  textArgs,
} from "./linear-attach.js";
import { createPictures } from "./pictures.js";
import {
  babysitCommand,
  mergeCommand,
  parsePrLines,
  prStatusArgs,
  toSharedPrEntry,
  updateSharedPrSummary,
} from "./pr-model.js";
import { createPoke } from "./refresh-driver.js";
import { MAX_SESSIONS, SessionMap, createSession, parseQueueLine, pinTabAgent } from "./sessions.js";
import {
  TRUST_STEP,
  agentName,
  helperText,
  hooksState,
  hooksText,
  isPerPaneProps,
  pollMs,
  resolveStackTarget,
  resolveTarget,
  sendText,
  targetOf,
  waitingText,
} from "./target.js";
import { subagentBar, threadsButton, threadsCard, threadsPill } from "./threads.js";
import { barText, cardOpen, pillText, threadRows, toggleCard } from "./threads-model.js";
import { timeline, waitsInTerminal } from "./timeline.js";
import { ICONS, button as uiButton, findLayout, machineTag, programIcon, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./target.js").Target} Target */
/** @typedef {import("./target.js").Found} Found */
/** @typedef {import("./target.js").StackFound} StackFound */
/** @typedef {import("./target.js").Located} Located */
/** @typedef {import("./target.js").StackLocated} StackLocated */
/** @typedef {import("./feedstate.js").FeedState} FeedState */
/** @typedef {import("./dock-model.js").Request} Request */
/** @typedef {import("./dock-model.js").Card} Card */
/** @typedef {import("./dock-model.js").Draft} Draft */
/** @typedef {import("./threads-model.js").Row} Row */
/** @typedef {import("./sessions.js").SessionState} SessionState */
/** @typedef {import("./sessions.js").SessionSlot} SessionSlot */
/** @typedef {import("./sessions.js").QueueItem} QueueItem */
/** @typedef {import("./pr-model.js").PrSummary} PrSummary */
/** @typedef {{ title: string, message: string, exited: boolean }} Problem */
/** @typedef {"claude" | "codex"} Kind */

const CHAT_TABS = "bw.chat-tabs";
const RIGHT_TAB = "bw.right.tab";
const WINDOW_ID = "bw.window-id";
const DISMISSED = "bw.hooks-dismissed";
const ROOT_ENDED = "This conversation ended; showing the new one";
const QUEUE_IDLE_POLL_MS = 10_000;
const PR_SHOWN_POLL_MS = 30_000;
const PR_HIDDEN_POLL_MS = 60_000;

/**
 * @typedef {{ child: null } | { child: string } | { child?: undefined, terminal: string, local: string, kind: Kind | null, program: string }} ViewState
 */

/**
 * @typedef {object} HooksUi
 * @property {string} machine
 * @property {"loading" | "diff" | "applying" | "applied" | "failed"} phase
 * @property {any[]} [diff]
 * @property {string} [message]
 */

/** @param {ViewState} v @returns {v is { terminal: string, local: string, kind: Kind | null, program: string }} */
const isTerminalView = (v) => "terminal" in v && typeof v.terminal === "string";

/** @param {string} address @returns {string | null} */
const machineOfAddress = (address) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : null);

/**
 * The pending question that holds the keyboard and the Other field: the oldest one a click can answer.
 * @param {Request[]} requests @returns {Request | null}
 */
function activeQuestion(requests) {
  const qs = requests.filter(
    (r) => (r.kind === "question" || r.kind === "question_async") && r.state === "pending" && r.answerable,
  );
  qs.sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));
  return qs[0] ?? null;
}

const NO_KEYS_WITH = ["control", "alt", "platform", "function"];
const WENT_OUT = new Set(["answered", "declined", "uncertain", "sent", "already-answered"]);

export default class Chat extends View {
  /** @returns {any} */
  get scroll() {
    return this.session?.scroll ?? null;
  }

  /** @returns {Composer | null} */
  get composer() {
    return this.session?.composer ?? null;
  }

  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    const rawProps = /** @type {unknown} */ (herdrProps());
    this.stackMode = !isPerPaneProps(rawProps);
    /** @type {Target | null} */
    this.id = this.stackMode ? null : targetOf(rawProps);
    /** @type {string | null} */
    this.window =
      !this.stackMode && typeof (/** @type {any} */ (rawProps)?.window) === "string"
        ? /** @type {any} */ (rawProps).window
        : null;
    this.alive = true;
    if (!this.stackMode && !this.id) return;

    this.poke = createPoke();
    this.pictures = createPictures();
    this.picturesBusy = false;
    this.width = 0;
    this.paneHeight = 0;
    /** @type {string | null} */
    this.threadHover = null;
    /** @type {string | null} */
    this.chipHover = null;
    /** @type {HooksUi | null} */
    this.hooksUi = null;
    /** @type {string | null} */
    this.installing = null;
    /** @type {{ terminal: string, id: string } | null} */
    this.editingQueue = null;
    /** @type {Map<string, { kind: Kind | null, program: string }>} */
    this.termInfo = new Map();
    /** @type {string[]} */
    this.liveSpaceIds = [];
    /** @type {string[]} */
    this.liveTabIds = [];
    /** @type {string | null} */
    this.chatPane = null;
    this.listed = false;
    this.layoutScreen = "chat";

    /**
     * Allocates a retained slot during `init()` so `render()` never constructs host state.
     * @param {number} index
     * @param {Kind | null} [onlyKind]
     * @returns {SessionSlot}
     */
    const makeSlot = (index, onlyKind = null) => {
      const scroll = VirtualListScrollHandle.new();
      const sendFrom = (/** @type {string} */ text, /** @type {any} */ cx, /** @type {any} */ opts) => {
        if (this.session) this.submitText(this.session, text, cx, opts);
      };
      const claude =
        onlyKind === null || onlyKind === "claude"
          ? new Composer({ placeholder: "Message Claude…", onSend: sendFrom })
          : /** @type {any} */ (null);
      const codex =
        onlyKind === null || onlyKind === "codex"
          ? new Composer({ placeholder: "Message Codex…", onSend: sendFrom })
          : /** @type {any} */ (null);
      return { index, scroll, composers: { claude: claude ?? codex, codex: codex ?? claude } };
    };

    if (this.stackMode) {
      /** @type {SessionSlot[]} */
      const pool = [];
      for (let i = 0; i < MAX_SESSIONS; i++) pool.push(makeSlot(i));
      this.sessions = new SessionMap(pool, makeSlot(MAX_SESSIONS), MAX_SESSIONS);
      this.perPaneSlot = null;
    } else {
      this.sessions = null;
      this.perPaneSlot = makeSlot(0, /** @type {Target} */ (this.id).kind);
    }

    /** @type {Located} */
    this.located = { state: "missing" };
    /** @type {StackLocated} */
    this.stackLocated = { state: "no_agent", space: null, tab: null, hasTerminal: false, agents: [] };
    /** @type {SessionState | null} */
    this.perPaneSession = null;
    /** @type {SessionState | null} */
    this.session = null;
    /** @type {StackFound | null} */
    this.target = null;
    /** @type {boolean} */
    this.wantFocus = false;
    /** @type {SessionState | null} */
    this.focusedForCmd = null;
    /** @type {boolean} */
    this.sessionSwitched = false;
    /** @type {boolean} */
    this.firstStackRender = this.stackMode;

    this.focus = cx.focus_handle();
    this.other = InputState.new({ placeholder: "Other…" });
    this.other.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      const s = this.session;
      if (!s) return;
      const a = activeQuestion(s.requests);
      if (!a) return;
      const d = this.draftOf(s, a);
      const v = this.other.value();
      if (v === (d.other[d.step] ?? "")) return;
      s.drafts.set(a.id, setOther(d, d.step, v));
      cx?.notify?.();
    });

    this.editInput = InputState.new({ placeholder: "Edit queued message…" });
    this.editInput.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => cx?.notify?.());
    this.editInput.on("submit", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      const ed = this.editingQueue;
      const s = this.session;
      if (!ed || !s || s.terminal !== ed.terminal) return;
      this.saveQueueEdit(s, ed.id, cx);
    });

    const now = Date.now();
    const all = spaces();
    const ps = panes();
    this.locateCurrent(all, ps, now);
    this.sessionSwitched = false;
    /** @type {boolean} */
    this.shown = false;
    this.shown = this.readShown(all, ps);

    const bw = `${home()}/.local/share/bellwether/helper/current/bw`;
    /** @type {any} */
    let loopCx = null;
    this.helper = createHelper({
      exec,
      localInstall: async (machine) => {
        this.installing = machine;
        loopCx?.notify();
        let r;
        try {
          r = await exec(bw, ["machine", "install", machine], { on: null });
        } catch (e) {
          throw new Error(
            `could not start bw on this Mac (${e instanceof Error ? e.message : String(e)}): run scripts/install-helper.sh`,
          );
        }
        if (!r.stdout.trim()) throw new Error(r.stderr.trim() || `bw exited ${r.code}`);
        return parseLines(r.stdout);
      },
    });

    cx.spawn(async (/** @type {any} */ cx) => {
      loopCx = cx;
      try {
        while (this.alive) {
          const started = Date.now();
          const s = this.session;
          const target = this.target;
          try {
            if (s && target) {
              await this.readFeed(s, target, cx);
              if (s.wantOlder) await this.readOlder(s, target, cx);
              this.startPictures(s, target, cx);
              if (this.stackMode) {
                if (s.wantDrain && !s.draining && !s.queueBusy) {
                  await this.drainQueueFallback(s, cx);
                } else if (!s.queueBusy) {
                  await this.maybeReadQueue(s, started, cx);
                }
                await this.maybeReadPr(s, started, cx);
              }
            }
          } catch (e) {
            if (s) {
              applyFeed(this.viewFeedOf(s), {
                ok: false,
                state: "failed",
                message: e instanceof Error ? e.message : String(e),
              });
              cx.notify();
            }
          }
          const doneAt = Date.now();
          const cur = this.session;
          if (cur?.drawnGuarded && !isGuarded(cur.guard, doneAt)) cx.notify();
          if (this.stackMode) {
            const screenVal = shared(SCREEN_KEY);
            const activeScreen = typeof screenVal === "string" ? screenVal : this.layoutScreen;
            this.shown = Boolean(this.target) && activeScreen === "chat";
          } else if (this.listed) {
            this.shown = shownFrom(shared(CHAT_SHOWN), this.chatPane, this.shown);
          }
          let wait = Math.max(0, pollMs(this.shown) - (doneAt - started));
          if (cur && this.answerableOf(cur) && isGuarded(cur.guard, doneAt)) {
            wait = Math.max(1000, Math.min(wait, guardedUntil(cur.guard) - doneAt));
          }
          await this.poke.wait(cx.sleep(wait));
        }
      } finally {
        loopCx = null;
      }
    });

    /** @type {SessionState | null} */
    this.pendingFocusSession = null;
    this.focusPoke = createPoke();

    cx.spawn(async (/** @type {any} */ cx) => {
      while (this.alive) {
        if ((await nextCommand()) !== "focus") continue;
        this.wantFocus = true;
        const s = this.session;
        if (s) {
          this.focusSession(s);
          this.focusedForCmd = s;
        } else {
          this.focusedForCmd = null;
        }
        cx?.notify?.();
      }
    });

    cx.spawn(async () => {
      while (this.alive) {
        await this.focusPoke.wait();
        if (!this.alive) return;
        const s = this.pendingFocusSession;
        this.pendingFocusSession = null;
        if (s && s === this.session) this.focusSession(s);
      }
    });
  }

  /** @param {SessionState} s */
  focusSession(s) {
    if (activeQuestion(s.requests)) this.focus.focus();
    else s.composer?.focus?.();
  }

  /** @param {SessionState} s */
  scheduleFocus(s) {
    this.pendingFocusSession = s;
    this.focusPoke.poke();
  }

  close() {
    this.alive = false;
    this.poke?.poke();
    this.focusPoke?.poke();
  }

  /** @param {SessionState} s @returns {FeedState} */
  viewFeedOf(s) {
    return s.view.child || isTerminalView(s.view) ? /** @type {FeedState} */ (s.sub) : s.feed;
  }

  /** @param {SessionState} s */
  answerableOf(s) {
    return s.requests.some((r) => r.state === "pending" && r.answerable);
  }

  /**
   * Resolves the current target and active `SessionState` in either stack mode or per-pane props mode.
   * Returns whether the active target or status changed.
   * @param {any[]} all SpaceInfo[]
   * @param {any[]} ps PaneInfo[]
   * @param {number} now
   * @returns {boolean}
   */
  locateCurrent(all, ps, now) {
    this.liveSpaceIds = all.map((sp) => sp.id);
    this.liveTabIds = all.flatMap((sp) => (sp.tabs ?? []).map((/** @type {any} */ tb) => tb.id));

    if (this.stackMode) {
      const prevSession = this.session;
      const prevStatus = prevSession?.status ?? null;
      const located = resolveStackTarget(all, ps, shared(CHAT_TABS), shared(CHAT_AGENT));
      this.stackLocated = located;
      this.sessionSwitched = false;
      if (located.state !== "found") {
        const changed = this.target !== null || this.session !== null;
        this.target = null;
        this.session = null;
        return changed;
      }
      const { session, created } = /** @type {SessionMap} */ (this.sessions).acquire(
        located.target,
        shared(ATTACH),
        now,
      );
      const nextPrKey = `${session.machine ?? ""}\0${session.folder}\0${session.branch ?? ""}`;
      let prKeyChanged = false;
      if (session.prKey !== null && session.prKey !== nextPrKey) {
        this.clearSessionPr(session, null);
        session.prCheckedAt = 0;
        prKeyChanged = true;
      }
      const nextStatus = located.target.status ?? null;
      if (
        !created &&
        session.status === "working" &&
        (nextStatus === "done" || nextStatus === "idle") &&
        session.queue.items.length > 0 &&
        !session.queue.held &&
        !session.draining
      ) {
        session.wantDrain = true;
      }
      session.status = nextStatus;
      const switched = prevSession !== session;
      this.sessionSwitched = prevSession !== null && switched;
      this.session = session;
      this.target = located.target;
      if (switched) {
        if (this.editingQueue && this.editingQueue.terminal !== session.terminal) {
          this.editingQueue = null;
          this.editInput.set_value("");
        }
        this.syncOther(session);
      }
      return switched || created || prevStatus !== nextStatus || session.wantDrain || prKeyChanged;
    }

    const id = /** @type {Target} */ (this.id);
    if (!this.perPaneSession) {
      this.perPaneSession = createSession(
        {
          ...id,
          tab: "",
          pane: "",
          spaceId: "",
          folder: "",
          branch: null,
          status: null,
          title: agentName(id.kind),
          program: null,
          focused: false,
        },
        /** @type {SessionSlot} */ (this.perPaneSlot),
        now,
      );
    }
    const located = resolveTarget(id, this.window !== null && this.window === shared(WINDOW_ID), all, ps);
    this.located = located;
    const prev = this.target;
    if (located.state !== "found") {
      this.target = null;
      this.session = this.perPaneSession;
      return prev !== null;
    }
    const found = located.target;
    const pane = ps.find((p) => p.pane === found.pane) ?? null;
    const space = all.find((sp) => (sp.tabs ?? []).some((/** @type {any} */ tb) => tb.id === found.tab)) ?? null;
    /** @type {StackFound} */
    const stackTarget = {
      ...found,
      spaceId: String(space?.id ?? ""),
      folder: String(pane?.cwd || space?.folder || ""),
      branch: typeof pane?.branch === "string" && pane.branch ? pane.branch : (space?.branch ?? null),
      status: pane?.status ?? null,
      title: String(pane?.title || agentName(found.kind)),
      program: pane?.program ?? null,
      focused: Boolean(pane?.focused),
    };
    const switchedTerminal = Boolean(
      prev && (prev.machine !== stackTarget.machine || prev.local !== stackTarget.local),
    );
    if (switchedTerminal) {
      this.perPaneSession = createSession(stackTarget, /** @type {SessionSlot} */ (this.perPaneSlot), now);
    } else {
      this.perPaneSession.machine = stackTarget.machine;
      this.perPaneSession.local = stackTarget.local;
      this.perPaneSession.terminal = stackTarget.terminal;
      this.perPaneSession.tab = stackTarget.tab;
      this.perPaneSession.pane = stackTarget.pane;
      this.perPaneSession.spaceId = stackTarget.spaceId;
      this.perPaneSession.folder = stackTarget.folder;
      this.perPaneSession.branch = stackTarget.branch;
    }
    const prevStatus = this.perPaneSession.status;
    this.perPaneSession.status = stackTarget.status;
    this.session = this.perPaneSession;
    this.target = stackTarget;
    if (switchedTerminal) this.syncOther(this.session);
    return prev === null || switchedTerminal || prevStatus !== stackTarget.status;
  }

  /**
   * Opens another view inside `s`. Leaving or entering a terminal sub-agent's view drops its requests and
   * starts a fresh 3 s focus guard.
   * @param {SessionState} s
   * @param {ViewState} next
   * @param {any} cx
   */
  setView(s, next, cx) {
    const was = s.view;
    const wasT = isTerminalView(was) ? was.terminal : null;
    const nextT = isTerminalView(next) ? next.terminal : null;
    s.view = next;
    s.sub = next.child || nextT ? emptyFeed(nextT ?? s.terminal) : null;
    s.open.clear();
    s.follow = true;
    s.wantOlder = false;
    s.note = null;
    s.viewNote = null;
    if (wasT !== nextT) {
      s.requests = [];
      s.cards = null;
      s.answerNotes.clear();
      s.wentOut.clear();
      s.guard = createGuard(Date.now());
    }
    if (this.session === s) this.syncOther(s);
    this.poke.poke();
    cx?.notify();
  }

  /** @returns {string | null} */
  currentTab() {
    if (this.stackMode) {
      return this.stackLocated.tab;
    }
    const l = this.located;
    return l.state === "found" ? l.target.tab : l.state === "exited" ? l.tab : null;
  }

  /** @param {any[]} all SpaceInfo[] @param {any[]} ps PaneInfo[] */
  readShown(all, ps) {
    const tree = layout();
    this.listed = hasMod(tree, "bw-tabs");
    if (this.stackMode) {
      const screenNode = findLayout(tree, "screen");
      const rawScreen = typeof screenNode?.active === "string" ? screenNode.active : "chat";
      this.layoutScreen = rawScreen;
      if (!this.target) return false;
      if (rawScreen !== "chat") return false;
      const sharedScreen = shared(SCREEN_KEY);
      if (this.listed && typeof sharedScreen === "string") return sharedScreen === "chat";
      return true;
    }
    const tab = this.currentTab();
    if (tab === null) return false;
    const chat = ps.find((p) => p.tab === tab && p.mod === "bw-chat");
    this.chatPane = chat?.pane ?? null;
    return isShown({ tab, chatPane: this.chatPane }, all, ps);
  }

  /** @param {SessionState} s @param {any[]} lines */
  rootEnded(s, lines) {
    const root = s.feed.session;
    if (!root) return false;
    /** @param {unknown} x */
    const other = (x) => typeof x === "string" && x !== "" && x !== root;
    return lines.some(
      (l) =>
        (l?.type === "tree" && other(l.root)) ||
        (other(l?.session) && (l.type === "log" || l.type === "cards" || (l.type === "state" && l.state === "no_log"))),
    );
  }

  /** @param {SessionState} s @param {any[]} lines @param {boolean} withTree */
  applySide(s, lines, withTree) {
    let changed = false;
    if (withTree) {
      const tree = lines.find((l) => l?.type === "tree") ?? null;
      if (JSON.stringify(tree) !== JSON.stringify(s.tree)) changed = true;
      s.tree = tree;
    }
    const cards = lines.find((l) => l?.type === "cards") ?? null;
    const requests = cards
      ? /** @type {Request[]} */ (lines.filter((l) => l?.type === "request" && typeof l.id === "string"))
      : [];
    if (JSON.stringify(cards) !== JSON.stringify(s.cards) || JSON.stringify(requests) !== JSON.stringify(s.requests)) {
      changed = true;
    }
    s.cards = cards;
    s.requests = requests;
    const ids = new Set(requests.map((r) => r.id));
    for (const id of [...s.drafts.keys()]) if (!ids.has(id)) s.drafts.delete(id);
    for (const id of [...s.answerNotes.keys()]) if (!ids.has(id)) s.answerNotes.delete(id);
    const pending = new Set(requests.filter((r) => r.state === "pending").map((r) => r.id));
    for (const id of [...s.wentOut]) if (!pending.has(id)) s.wentOut.delete(id);
    if (this.session === s) this.syncOther(s);
    return changed;
  }

  /** @param {SessionState} s @param {StackFound} target @param {any} cx */
  async readFeed(s, target, cx) {
    const view = s.view;
    const feed = this.viewFeedOf(s);
    const own = isTerminalView(view);
    const args = ["feed", "--terminal", own ? view.local : target.local, "--pictures"];
    if (!own) args.push("--tree");
    args.push("--cards");
    if (view.child) args.push("--session", view.child);
    if (feed.cursor) args.push("--cursor", feed.cursor);
    const answer = await this.helper.call(target.machine, args);
    if (s.view !== view || this.viewFeedOf(s) !== feed) return;
    const installed = this.installing !== null;
    this.installing = null;
    if (view.child && answer.ok && this.rootEnded(s, answer.lines)) {
      this.setView(s, { child: null }, null);
      s.viewNote = ROOT_ENDED;
      s.tree = null;
      cx.notify();
      return;
    }
    const at = applyFeed(feed, answer);
    const side = answer.ok && this.applySide(s, answer.lines, !own);
    if (at >= 0 && answer.ok && answer.lines.some((l) => l?.type === "row" && l.k === "changed")) {
      s.prCheckedAt = 0;
    }
    if (at >= 0 || installed) {
      if (s.follow) this.toNewest(s);
      cx.notify();
    } else if (side) {
      cx.notify();
    }
  }

  /** @param {SessionState} s @param {StackFound} target @param {any} cx */
  async readOlder(s, target, cx) {
    s.wantOlder = false;
    const view = s.view;
    const feed = this.viewFeedOf(s);
    const before = olderFrom(feed);
    if (before === null) return;
    s.olderBusy = true;
    try {
      const args = ["feed", "--terminal", isTerminalView(view) ? view.local : target.local];
      if (view.child) args.push("--session", view.child);
      args.push("--before", String(before), "--pictures");
      const answer = await this.helper.call(target.machine, args);
      if (this.viewFeedOf(s) !== feed) return;
      const added = applyOlder(feed, answer, before);
      if (added) s.scroll.scroll_to_item(added, "top");
    } finally {
      s.olderBusy = false;
      cx.notify();
    }
  }

  /** @param {SessionState} s @param {StackFound} target @param {any} cx */
  startPictures(s, target, cx) {
    const feed = this.viewFeedOf(s);
    if (this.picturesBusy || !this.pictures.wanted(feed.rows).length) return;
    const view = s.view;
    if (view.child) {
      for (let p = this.pictures.wanted(feed.rows)[0]; p; p = this.pictures.wanted(feed.rows)[0]) {
        this.pictures.start(p.digest);
        this.pictures.done(p.digest, { ok: false });
      }
      cx.notify();
      return;
    }
    this.picturesBusy = true;
    const terminal = isTerminalView(view) ? view.terminal : target.terminal;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        for (
          let p = this.pictures.wanted(feed.rows)[0];
          p && this.alive && this.viewFeedOf(s) === feed;
          p = this.pictures.wanted(feed.rows)[0]
        ) {
          this.pictures.start(p.digest);
          const answer = await this.helper.call(null, [
            "picture",
            "--terminal",
            terminal,
            "--offset",
            String(p.offset),
            "--index",
            String(p.index),
            "--digest",
            p.digest,
          ]);
          this.pictures.done(p.digest, answer);
          cx.notify();
        }
      } finally {
        this.picturesBusy = false;
      }
    });
  }

  /** @param {SessionState} s @param {number} now @param {any} cx */
  async maybeReadQueue(s, now, cx) {
    const active = !s.queueLoaded || s.queue.items.length > 0 || s.queue.held || s.status === "working";
    if (!active && now - s.queueCheckedAt < QUEUE_IDLE_POLL_MS) return;
    await this.readQueue(s, cx);
  }

  /** @param {SessionState} s @param {any} cx */
  async readQueue(s, cx) {
    s.queueCheckedAt = Date.now();
    const answer = await this.helper.call(s.machine, ["queue", "list", "--terminal", s.local]);
    if (!answer.ok) return;
    const next = parseQueueLine(answer.lines);
    if (!next) return;
    const changed = !s.queueLoaded || JSON.stringify(next) !== JSON.stringify(s.queue);
    s.queue = next;
    s.queueLoaded = true;
    if (changed) cx.notify();
  }

  /** @param {SessionState} s @param {any} cx */
  async drainQueueFallback(s, cx) {
    s.wantDrain = false;
    s.draining = true;
    try {
      await this.helper.call(s.machine, ["queue", "drain", "--terminal", s.local]);
      await this.readQueue(s, cx);
    } finally {
      s.draining = false;
      cx.notify();
    }
  }

  /** @param {SessionState} s @param {any} cx */
  clearSessionPr(s, cx) {
    const had = s.pr !== null || s.prHeadOid !== null;
    s.pr = null;
    s.prHeadOid = null;
    let sharedChanged = false;
    if (s.spaceId) {
      const nextSummary = updateSharedPrSummary(shared(PR_SUMMARY), s.spaceId, null, this.liveSpaceIds);
      if (nextSummary) {
        setShared(PR_SUMMARY, nextSummary);
        sharedChanged = true;
      }
    }
    if ((had || sharedChanged) && cx) cx.notify();
  }

  /** @param {SessionState} s @param {number} now @param {any} cx */
  async maybeReadPr(s, now, cx) {
    const folder = s.folder;
    const branch = s.branch;
    const key = `${s.machine ?? ""}\0${folder}\0${branch ?? ""}`;
    const interval = this.shown ? PR_SHOWN_POLL_MS : PR_HIDDEN_POLL_MS;
    if (s.prKey === key && s.prCheckedAt > 0 && now - s.prCheckedAt < interval) return;
    if (s.prKey !== null && s.prKey !== key) {
      this.clearSessionPr(s, cx);
    }
    s.prKey = key;
    s.prCheckedAt = now;

    if (!folder || !branch || branch === "HEAD") {
      this.clearSessionPr(s, cx);
      return;
    }

    const stillCurrent = () => `${s.machine ?? ""}\0${s.folder}\0${s.branch ?? ""}` === key;
    const folderKey = `${s.machine ?? ""}\0${folder}`;
    if (s.prRepoFolder !== folderKey) {
      const origin = await remoteOrigin(exec, s.machine, folder);
      if (!stillCurrent()) return;
      if (!origin.ok) return;
      s.prRepoFolder = folderKey;
      s.prRepo = origin.repo;
    }

    if (!s.prRepo) {
      this.clearSessionPr(s, cx);
      return;
    }

    const head = await headOid(exec, s.machine, folder);
    if (!stillCurrent()) return;
    const oid = head.ok ? head.oid : null;
    const args = prStatusArgs(s.prRepo, branch, oid);
    if (!args) return;
    const answer = await this.helper.call(null, args);
    if (!stillCurrent()) return;
    if (!answer.ok) return;
    const parsed = parsePrLines(answer.lines);
    if (!parsed.ok) return;

    const changed = JSON.stringify(parsed.pr) !== JSON.stringify(s.pr) || oid !== s.prHeadOid;
    s.pr = parsed.pr;
    s.prHeadOid = oid;
    if (s.spaceId) {
      const entry = toSharedPrEntry(parsed.pr, oid);
      const nextSummary = updateSharedPrSummary(shared(PR_SUMMARY), s.spaceId, entry, this.liveSpaceIds);
      if (nextSummary) setShared(PR_SUMMARY, nextSummary);
    }
    if (changed) cx.notify();
  }

  /** @param {SessionState} s */
  toNewest(s) {
    const n = this.viewFeedOf(s).rows.length;
    if (n) s.scroll?.scroll_to_item?.(n - 1, "top");
  }

  /** @param {SessionState} s */
  sendTargetOf(s) {
    if (!this.target && this.session === s) return null;
    const v = s.view;
    if (isTerminalView(v)) {
      return v.kind
        ? {
            machine: s.machine,
            local: v.local,
            kind: v.kind,
            feed: /** @type {FeedState} */ (s.sub),
            name: agentName(v.kind),
            ownTerminal: true,
          }
        : null;
    }
    if (v.child) return null;
    return { machine: s.machine, local: s.local, kind: s.kind, feed: s.feed, name: s.name, ownTerminal: false };
  }

  /**
   * Handles composer submit: enqueues via `bw queue add` in stack mode while `status === "working"`
   * (unless `opts.forceSend` is true), otherwise sends immediately via `bw send`.
   * @param {SessionState} s
   * @param {string} text
   * @param {any} cx
   * @param {{ forceSend?: boolean }} [opts]
   */
  submitText(s, text, cx, opts = {}) {
    const st = this.sendTargetOf(s);
    if (!st) return;
    const expect = expectation(st.feed, st.kind);
    if (s.sending || s.queueBusy || !expect) return;
    const { session, path } = expect;
    const tab = s.tab || this.currentTab();
    const chips = chipsFor(shared(ATTACH), tab);
    const long = chips.find(needsChoice);
    if (long) {
      s.note = {
        text: `${long.identifier}'s description is ${sizeText(long.bytes)}: choose Trim or Send as a file on its chip`,
        bad: true,
      };
      cx.notify();
      return;
    }
    const queueIt = this.stackMode && !opts?.forceSend && !st.ownTerminal && s.status === "working";
    s.sending = true;
    s.note = null;
    s.viewNote = null;
    cx.notify();
    const address = st.machine ? `${st.machine}/${st.local}` : st.local;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        /** @type {string[]} */
        const texts = [];
        for (const chip of chips) {
          const built = await this.helper.call(null, textArgs(chip, address));
          const line = built.ok ? /** @type {any} */ (built.lines.find((l) => l.type === "linear-text")) : null;
          if (!line || typeof line.text !== "string") {
            if (built.ok === false && built.code === "too_large" && tab !== null) {
              await this.resizeChip(tab, chip.identifier);
              s.note = {
                text: `${chip.identifier}'s description is now over 8 KB: choose Trim or Send as a file on its chip`,
                bad: true,
              };
              return;
            }
            const why = built.ok === false ? built.message : "bw linear printed no text";
            s.note = { text: `Could not read ${chip.identifier}: ${why}; nothing was sent`, bad: true };
            return;
          }
          texts.push(line.text);
        }

        const fullText = composeMessage(texts, text);
        if (queueIt) {
          const qArgs = ["queue", "add", "--terminal", st.local, "--kind", st.kind];
          if (session !== "none") qArgs.push("--session", session);
          qArgs.push("--text", fullText);
          const answer = await this.helper.call(st.machine, qArgs);
          const q = answer.ok ? parseQueueLine(answer.lines) : null;
          if (q) {
            s.queue = q;
            s.queueLoaded = true;
            s.queueCheckedAt = Date.now();
            s.draftText = "";
            s.composer?.clear?.();
            if (tab !== null && chips.length) {
              setShared(
                ATTACH,
                clearChips(
                  shared(ATTACH),
                  tab,
                  chips.map((c) => c.identifier),
                ),
              );
            }
          } else {
            const err = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
            const why = answer.ok === true ? String(err?.message || "bw queue add printed no result") : answer.message;
            s.note = {
              text: `Not queued: ${why}`,
              bad: true,
            };
          }
          return;
        }

        const args = [
          "send",
          "--terminal",
          st.local,
          "--expect-kind",
          st.kind,
          "--expect-session",
          session,
          "--expect-path",
          path,
          "--text",
          fullText,
        ];
        const answer = await this.helper.call(st.machine, args);
        const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l.type === "send") : null;
        const result = typeof line?.result === "string" ? line.result : "failed";
        const message = answer.ok === true ? String(line?.message || "bw send printed no result") : answer.message;
        const went = result === "sent" || result === "unconfirmed";
        s.note = result === "sent" ? null : { text: sendText(result, st.name, message), bad: !went };
        if (went) {
          s.draftText = "";
          s.composer?.clear?.();
        }
        if (went && tab !== null && chips.length) {
          setShared(
            ATTACH,
            clearChips(
              shared(ATTACH),
              tab,
              chips.map((c) => c.identifier),
            ),
          );
        }
      } finally {
        s.sending = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /**
   * Sends or enqueues a PR skill slash command (`/babysit-pr` or `/merge-pr`) without touching unsent
   * composer text or attached Linear chips.
   * @param {SessionState} s
   * @param {string} commandText
   * @param {any} cx
   */
  runSkillCommand(s, commandText, cx) {
    const st = this.sendTargetOf(s);
    const expect = st ? expectation(st.feed, st.kind) : null;
    if (!st || !expect || s.sending || s.queueBusy) {
      s.note = { text: `Wait for ${s.name}'s session before running ${commandText}.`, bad: true };
      cx.notify();
      return;
    }
    const queueIt = !st.ownTerminal && s.status === "working";
    s.sending = true;
    s.note = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        if (queueIt) {
          const qArgs = ["queue", "add", "--terminal", st.local, "--kind", st.kind];
          if (expect.session !== "none") qArgs.push("--session", expect.session);
          qArgs.push("--text", commandText);
          const answer = await this.helper.call(st.machine, qArgs);
          const q = answer.ok ? parseQueueLine(answer.lines) : null;
          if (q) {
            s.queue = q;
            s.queueLoaded = true;
            s.queueCheckedAt = Date.now();
            s.note = { text: `Queued ${commandText}.`, bad: false };
          } else {
            const err = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
            const why = answer.ok === true ? String(err?.message || "bw queue add failed") : answer.message;
            s.note = {
              text: `Not queued: ${why}`,
              bad: true,
            };
          }
          return;
        }
        const answer = await this.helper.call(st.machine, [
          "send",
          "--terminal",
          st.local,
          "--expect-kind",
          st.kind,
          "--expect-session",
          expect.session,
          "--expect-path",
          expect.path,
          "--text",
          commandText,
        ]);
        const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l.type === "send") : null;
        const result = typeof line?.result === "string" ? line.result : "failed";
        const message = answer.ok === true ? String(line?.message || "bw send printed no result") : answer.message;
        const went = result === "sent" || result === "unconfirmed";
        s.note = went
          ? { text: `Sent ${commandText}.`, bad: false }
          : { text: sendText(result, st.name, message), bad: true };
      } finally {
        s.sending = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {SessionState} s @param {PrSummary} pr @param {any} cx */
  openPr(s, pr, cx) {
    if (s.prBusy) return;
    run("layout.show", { id: "right" });
    run("layout.select", { stack: "right-body", child: "browser" });
    const all = spaces();
    const space = all.find((sp) => sp.active);
    if (space) {
      setShared(
        RIGHT_TAB,
        choose(
          shared(RIGHT_TAB),
          space.id,
          "browser",
          all.map((sp) => sp.id),
        ),
      );
    }
    s.prBusy = true;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        let answer = await this.helper.call(null, ["browser", "new", "--url", pr.url]);
        const first = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "tab-action") : null;
        if (first && first.ok === false && /\(stopped\)$/.test(String(first.message ?? ""))) {
          const up = await this.helper.call(null, ["browser", "up"]);
          const chrome = up.ok ? up.lines.find((/** @type {any} */ l) => l?.type === "chrome") : null;
          if (chrome?.state === "running") {
            answer = await this.helper.call(null, ["browser", "new", "--url", pr.url]);
          }
        }
        const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "tab-action") : null;
        if (!answer.ok || line?.ok === false) {
          const why = answer.ok === true ? String(line?.message || "failed") : answer.message;
          s.note = {
            text: `Could not open PR in Browser: ${why}`,
            bad: true,
          };
        }
      } finally {
        s.prBusy = false;
        cx.notify();
      }
    });
  }

  /** @param {SessionState} s @param {string[]} subArgs @param {any} cx @param {() => void} [afterOk] */
  mutateQueue(s, subArgs, cx, afterOk) {
    if (s.queueBusy) return;
    s.queueBusy = true;
    s.note = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const answer = await this.helper.call(s.machine, ["queue", ...subArgs]);
        const q = answer.ok ? parseQueueLine(answer.lines) : null;
        if (q) {
          s.queue = q;
          s.queueLoaded = true;
          s.queueCheckedAt = Date.now();
          afterOk?.();
        } else {
          const err = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
          const why = answer.ok === true ? String(err?.message || "no result") : answer.message;
          s.note = {
            text: `Queue update failed: ${why}`,
            bad: true,
          };
        }
      } finally {
        s.queueBusy = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {SessionState} s @param {string} id @param {any} cx */
  saveQueueEdit(s, id, cx) {
    const nextText = this.editInput.value().trim();
    if (!nextText || s.queueBusy) return;
    this.mutateQueue(s, ["edit", "--terminal", s.local, "--id", id, "--text", nextText], cx, () => {
      if (this.editingQueue?.id === id) {
        this.editingQueue = null;
        this.editInput.set_value("");
      }
    });
  }

  /** @param {SessionState} s @param {QueueItem} item @param {any} cx */
  sendQueuedNow(s, item, cx) {
    if (s.sending || s.queueBusy) return;
    const expect = expectation(s.feed, s.kind);
    if (!expect) {
      s.note = { text: `Wait for ${s.name}'s session before sending.`, bad: true };
      cx.notify();
      return;
    }
    s.queueBusy = true;
    s.note = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const answer = await this.helper.call(s.machine, [
          "queue",
          "send",
          "--terminal",
          s.local,
          "--id",
          item.id,
          "--expect-kind",
          s.kind,
          "--expect-session",
          expect.session,
          "--expect-path",
          expect.path,
        ]);
        const q = answer.ok ? parseQueueLine(answer.lines) : null;
        if (q) {
          s.queue = q;
          s.queueLoaded = true;
          s.queueCheckedAt = Date.now();
        } else {
          await this.readQueue(s, cx);
        }
        const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l.type === "send") : null;
        const err = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
        const result = typeof line?.result === "string" ? line.result : "failed";
        const message =
          answer.ok === true
            ? String(line?.message || err?.message || "bw queue send printed no result")
            : answer.message;
        const went = result === "sent" || result === "unconfirmed" || result === "already-sent";
        s.note =
          result === "sent" || result === "already-sent"
            ? null
            : { text: sendText(result, s.name, message), bad: !went };
        if (went && this.editingQueue?.id === item.id) {
          this.editingQueue = null;
          this.editInput.set_value("");
        }
      } finally {
        s.queueBusy = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {string} tab @param {string} id */
  async resizeChip(tab, id) {
    const answer = await this.helper.call(null, ["linear", "issue", "--id", id]);
    const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l.type === "linear-issue") : null;
    const fresh = line ? chipFrom(line, Date.now()) : null;
    if (fresh) setShared(ATTACH, refreshChip(shared(ATTACH), tab, fresh));
  }

  /** @param {SessionState} s @returns {{ kind: Kind, session: string, path: string } | null} */
  answerExpect(s) {
    if (!this.target && this.session === s) return null;
    const v = s.view;
    if (isTerminalView(v)) {
      const e = v.kind ? expectation(/** @type {FeedState} */ (s.sub), v.kind) : null;
      return e && v.kind ? { kind: v.kind, ...e } : null;
    }
    if (v.child) {
      const c = s.cards;
      const ok =
        c &&
        typeof c.session === "string" &&
        c.session &&
        typeof c.path === "string" &&
        c.path &&
        c.session === s.feed.session;
      return ok ? { kind: s.kind, session: c.session, path: c.path } : null;
    }
    const e = expectation(s.feed, s.kind);
    return e ? { kind: s.kind, ...e } : null;
  }

  /** @param {SessionState} s @param {{ id: string, question?: any }} req @returns {Draft} */
  draftOf(s, req) {
    let d = s.drafts.get(req.id);
    if (!d) {
      d = emptyDraft(req.question);
      s.drafts.set(req.id, d);
    }
    return d;
  }

  /** @param {SessionState} s */
  syncOther(s) {
    const a = activeQuestion(s.requests);
    const d = a ? this.draftOf(s, a) : null;
    const key = a && d ? `${s.terminal}:${a.id}:${d.step}` : null;
    const want = d ? (d.other[d.step] ?? "") : "";
    if (key === s.otherKey && this.other.value() === want) return;
    s.otherKey = key;
    this.other.set_value(want);
  }

  /** @param {SessionState} s @param {string} id */
  requestOf(s, id) {
    return s.requests.find((r) => r.id === id) ?? null;
  }

  /** @param {SessionState} s @param {Request | null} req @param {{ action: string } | { answers: { picks: number[], other?: string }[] }} choice @param {any} cx */
  answer(s, req, choice, cx) {
    if (req?.state !== "pending" || !req.answerable || s.sendingIds.size || s.wentOut.has(req.id)) return;
    if (isGuarded(s.guard, Date.now())) return;
    const expect = this.answerExpect(s);
    const v = s.view;
    const local = isTerminalView(v) ? v.local : s.local;
    const name = isTerminalView(v) && v.kind ? agentName(v.kind) : s.name;
    let args;
    try {
      args = answerArgs(req, choice, { local }, expect);
    } catch {
      return;
    }
    s.sendingIds.add(req.id);
    s.answerNotes.delete(req.id);
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      let text = "";
      try {
        const answer = await this.helper.call(s.machine, args);
        const line = /** @type {{ result: string, state?: string, message?: string } | null} */ (
          answer.ok ? answer.lines.find((l) => l?.type === "answer" && typeof l.result === "string") : null
        );
        if (line && WENT_OUT.has(line.result)) s.wentOut.add(req.id);
        text = line
          ? answerNote(line, req.kind, name)
          : answerNote(
              { result: "failed", message: answer.ok === true ? "bw answer printed no result" : answer.message },
              req.kind,
              name,
            );
      } catch (e) {
        text = answerNote({ result: "failed", message: e instanceof Error ? e.message : String(e) }, req.kind, name);
      } finally {
        s.sendingIds.delete(req.id);
        if (text) s.answerNotes.set(req.id, text);
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {SessionState | null} s */
  showTerminal(s) {
    const v = s?.view;
    if (v && isTerminalView(v)) run("terminal.peek", { terminal: v.terminal });
    else run("bw-tabs.chat-flip");
  }

  /** @param {SessionState} s @param {Card} card @param {string} button @param {any} cx */
  clickCard(s, card, button, cx) {
    if (button === "terminal") {
      this.showTerminal(s);
      return;
    }
    const req = this.requestOf(s, card.id);
    if (button === "submit") {
      if (!req) return;
      const d = this.draftOf(s, req);
      if (complete(d)) this.answer(s, req, { answers: answersOf(d) }, cx);
      return;
    }
    this.answer(s, req, { action: button }, cx);
  }

  /** @param {SessionState} s @param {Card} card @param {number} step @param {number} index @param {any} cx */
  chooseOption(s, card, step, index, cx) {
    const req = this.requestOf(s, card.id);
    if (!req) return;
    const d = this.draftOf(s, req);
    s.drafts.set(req.id, d.multi[step] ? toggle(d, step, index) : pick(d, step, index));
    this.focus.focus();
    this.syncOther(s);
    cx.notify();
  }

  /** @param {SessionState} s @param {Card} card @param {number} step @param {any} cx */
  showStep(s, card, step, cx) {
    const req = this.requestOf(s, card.id);
    if (!req) return;
    const d = this.draftOf(s, req);
    if (!Number.isInteger(step) || step < 0 || step >= d.counts.length) return;
    s.drafts.set(req.id, { ...d, step });
    this.syncOther(s);
    cx.notify();
  }

  /** @param {SessionState} s @param {Card} card @param {any} e @param {any} cx */
  cardKey(s, card, e, cx) {
    if (NO_KEYS_WITH.some((m) => e?.modifiers?.[m])) return;
    const req = this.requestOf(s, card.id);
    if (!req) return;
    const key = String(e?.key ?? "");
    if (/^[1-9]$/.test(key)) {
      const d = this.draftOf(s, req);
      s.drafts.set(req.id, digit(d, d.step, Number(key)));
      this.syncOther(s);
      cx.stop_propagation?.();
      cx.notify();
    } else if (key === "enter") {
      cx.stop_propagation?.();
      this.clickCard(s, card, "submit", cx);
    }
  }

  /**
   * @param {SessionState} s
   * @param {string | null} machine
   * @param {Kind} kind
   * @returns {import("./dock.js").Notice | null}
   */
  hooksNotice(s, machine, kind) {
    const state = hooksState(s.cards?.hooks, kind);
    const key = machine ?? "local";
    const ui = this.hooksUi?.machine === key ? this.hooksUi : null;
    if (state === "untrusted")
      return { text: /** @type {string} */ (hooksText(state, machine)), step: TRUST_STEP, buttons: [] };
    if (state !== "missing" && state !== "outdated") return null;
    if (ui?.phase === "applied") {
      return {
        text: `Bellwether hooks are set up on ${machine ?? "this Mac"}; new requests name who asked`,
        buttons: [],
      };
    }
    const dismissed = /** @type {Record<string, unknown> | undefined} */ (shared(DISMISSED));
    if (dismissed && typeof dismissed === "object" && dismissed[key] === true) return null;
    const diff = ui?.diff?.map((l) => ({ path: String(l.path ?? ""), diff: String(l.diff ?? "") }));
    const later = { id: "hooks-dismiss", label: "Not now" };
    /** @type {import("./dock.js").NoticeButton[]} */
    let buttons;
    if (ui?.phase === "diff" || ui?.phase === "applying")
      buttons = [{ id: "hooks-apply", label: "Apply", primary: true, enabled: ui.phase === "diff" }, later];
    else
      buttons = [
        {
          id: "hooks-review",
          label: ui?.phase === "loading" ? "Reading changes…" : "Review changes",
          primary: true,
          enabled: ui?.phase !== "loading",
        },
        later,
      ];
    return { text: /** @type {string} */ (hooksText(state, machine)), diff, message: ui?.message, buttons };
  }

  /** @param {string} button @param {any} cx */
  clickNotice(button, cx) {
    const machine = this.target?.machine ?? null;
    const key = machine ?? "local";
    if (button === "hooks-dismiss") {
      const was = shared(DISMISSED);
      setShared(DISMISSED, { ...(was && typeof was === "object" ? was : {}), [key]: true });
      this.hooksUi = null;
      cx.notify();
      return;
    }
    const ui = this.hooksUi?.machine === key ? this.hooksUi : null;
    if (ui?.phase === "loading" || ui?.phase === "applying") return;
    if (button === "hooks-review") {
      this.hooksUi = { machine: key, phase: "loading" };
      cx.notify();
      cx.spawn(async (/** @type {any} */ cx) => {
        const answer = await this.helper.call(null, ["machine", "setup", key, "--diff"]);
        const lines = answer.ok ? answer.lines.filter((/** @type {any} */ l) => l?.type === "hooks-diff") : [];
        const error = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
        this.hooksUi = lines.length
          ? { machine: key, phase: "diff", diff: lines }
          : {
              machine: key,
              phase: "failed",
              message: `Could not read the changes: ${answer.ok === true ? (error?.message ?? "bw printed no diff") : answer.message}`,
            };
        cx.notify();
      });
    } else if (button === "hooks-apply" && ui?.phase === "diff") {
      const sha = (/** @type {string} */ agent) => String(ui.diff?.find((l) => l?.agent === agent)?.sha256 ?? "");
      const args = ["machine", "setup", key, "--apply", "--expect-sha", `${sha("claude")},${sha("codex")}`];
      this.hooksUi = { ...ui, phase: "applying" };
      cx.notify();
      cx.spawn(async (/** @type {any} */ cx) => {
        const answer = await this.helper.call(null, args);
        const applied = answer.ok && answer.lines.some((/** @type {any} */ l) => l?.type === "hooks-applied");
        const error = answer.ok ? answer.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
        this.hooksUi = applied
          ? { machine: key, phase: "applied" }
          : {
              machine: key,
              phase: "failed",
              message: `Not applied: ${answer.ok === true ? (error?.message ?? "bw printed no result") : answer.message}`,
            };
        this.poke.poke();
        cx.notify();
      });
    }
  }

  /** @param {SessionState} s @param {any} row */
  height(s, row) {
    const w = columnWidth(this.width);
    const open = s.open.has(row.id);
    const c = s.heights.get(row);
    if (c && c.w === w && c.open === open) return c.h;
    const h = rowHeight(row, w, open);
    s.heights.set(row, { w, open, h });
    return h;
  }

  /** @param {SessionState} s @param {string} key @param {any} cx */
  clickRow(s, key, cx) {
    const row = this.viewFeedOf(s).rows.find((r) => r.id === key);
    if (!row) return;
    if (row.k === "tools") {
      if (!s.open.delete(key)) s.open.add(key);
      cx.notify();
    } else if (row.k === "changed") {
      run("layout.show", { id: "right" });
      run("layout.select", { stack: "right-body", child: "changes" });
      const all = spaces();
      const space = all.find((sp) => sp.active);
      if (space) {
        const ids = all.map((sp) => sp.id);
        setShared(RIGHT_TAB, choose(shared(RIGHT_TAB), space.id, "changes", ids));
        const files = Array.isArray(row.files) ? row.files.filter((f) => typeof f === "string" && f) : [];
        if (files.length === 1) setShared(REVEAL, withReveal(shared(REVEAL), space.id, files[0], Date.now(), ids));
      }
    } else if (waitsInTerminal(row)) {
      this.showTerminal(s);
    }
  }

  /** @param {SessionState} s @param {Row} row @param {any} cx */
  openRow(s, row, cx) {
    if (row.kind === "parent") {
      if (s.view.child || isTerminalView(s.view)) this.setView(s, { child: null }, cx);
      return;
    }
    const open = row.open;
    if (open && "child" in open) {
      if (s.view.child !== open.child) this.setView(s, { child: open.child }, cx);
      return;
    }
    if (open && "terminal" in open) {
      const address = open.terminal;
      const m = s.machine;
      const local = m !== null && address.startsWith(`${m}/`) ? address.slice(m.length + 1) : address;
      const info = this.termInfo.get(address);
      if (!isTerminalView(s.view) || s.view.terminal !== address) {
        this.setView(s, { terminal: address, local, kind: info?.kind ?? null, program: info?.program ?? row.type }, cx);
      }
    }
  }

  /** @param {SessionState} s @param {any} e @param {any} cx */
  wheel(s, e, cx) {
    if (!((e?.delta?.y ?? 0) > 0)) return;
    if (s.follow) {
      s.follow = false;
      cx.notify();
    }
    if (s.topSeen && !s.olderBusy && !s.wantOlder && olderFrom(this.viewFeedOf(s)) !== null) {
      s.wantOlder = true;
      this.poke.poke();
    }
  }

  /** @param {Theme} t @param {Problem} p @param {any} term @param {string | null} tab @param {SessionState | null} s */
  buttons(t, p, term, tab, s) {
    const button = (/** @type {string} */ id, /** @type {string} */ label, /** @type {() => void} */ act) =>
      uiButton(t, { id, label, h: 26, onClick: () => act() });
    return h_flex()
      .gap(8)
      .items_center()
      .when(Boolean(term), (el) => el.child(button("show-terminal", "Show terminal (⌘J)", () => this.showTerminal(s))))
      .when(p.exited && tab !== null, (el) =>
        el.child(button("close-tab", "Close tab", () => run("tab.close", { id: /** @type {string} */ (tab) }))),
      );
  }

  /** @param {Theme} t @param {SessionState} s @param {any} term @param {boolean} gone @param {number} subs */
  header(t, s, term, gone, subs) {
    const target = this.target;
    return h_flex()
      .id("chat-header")
      .h(36)
      .flex_none()
      .w_full()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(programIcon(term?.program ?? null, t, 14))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(s.name))
      .when(Boolean(term?.branch), (el) =>
        el.child(
          h_flex()
            .min_w(0)
            .gap(4)
            .items_center()
            .text_size(12)
            .text_color(t.muted)
            .child(svg(ICONS.branch).size(12).flex_none())
            .child(div().min_w(0).truncate().child(String(term.branch))),
        ),
      )
      .when(Boolean(target?.machine), (el) => el.child(machineTag(String(target?.machine), t)))
      .child(div().flex_1())
      .when(subs > 0, (el) =>
        el.child(
          threadsButton(subs, t, (cx) => {
            s.toggle = toggleCard(s.rows, s.toggle);
            cx.notify();
          }),
        ),
      )
      .when(!gone, (el) =>
        el.child(
          h_flex()
            .id("flip")
            .h(24)
            .px(9)
            .gap(6)
            .flex_none()
            .items_center()
            .rounded(12)
            .cursor_pointer()
            .text_size(12)
            .text_color(t.muted)
            .hover((st) => st.bg(t.hover))
            .on_click(() => this.showTerminal(s))
            .child("Terminal")
            .child(div().text_color(t.foreground).child("⌘J")),
        ),
      );
  }

  render() {
    const t = themeColors();
    const root = v_flex()
      .id("chat-root")
      .size_full()
      .min_w(0)
      .bg(t.background)
      .on_size_change((/** @type {{ width: number, height: number }} */ size, /** @type {any} */ cx) => {
        if (Math.abs(size.width - this.width) < 1 && Math.abs((size.height || 0) - this.paneHeight) < 1) return;
        this.width = size.width;
        this.paneHeight = size.height || 0;
        cx.notify();
      });

    if (!this.stackMode && !this.id) {
      return root.child(
        v_flex()
          .id("chat-state")
          .flex_1()
          .items_center()
          .justify_center()
          .gap(6)
          .px(24)
          .child(div().text_size(13.5).text_color(t.foreground).child("This chat names no terminal"))
          .child(div().text_size(12).text_color(t.muted).child("Start a chat from + in the tab bar.")),
      );
    }

    const now = Date.now();
    const all = spaces();
    const ps = panes();
    const moved = this.locateCurrent(all, ps, now);
    const shown = this.readShown(all, ps);
    if (shown !== this.shown || moved) {
      this.shown = shown;
      this.poke.poke();
    }

    if (this.stackMode && this.stackLocated.state !== "found") {
      const st = this.stackLocated;
      const exited = st.state === "exited";
      const title = exited ? `${agentName(st.kind)} exited` : "No active agent chat";
      const sub = exited
        ? ""
        : st.hasTerminal
          ? "This tab runs a shell terminal."
          : "Start a Claude or Codex chat from + in the tab bar.";
      return root.child(
        v_flex()
          .id("chat-state")
          .flex_1()
          .items_center()
          .justify_center()
          .gap(8)
          .px(24)
          .child(div().text_size(13.5).text_color(t.foreground).child(title))
          .when(Boolean(sub), (el) => el.child(div().text_size(12).text_color(t.muted).child(sub)))
          .child(
            this.buttons(
              t,
              { title, message: sub, exited },
              st.state === "no_agent" && st.hasTerminal ? true : null,
              st.tab,
              null,
            ),
          ),
      );
    }

    const s = /** @type {SessionState} */ (this.session);
    const target = this.target;
    const view = s.view;
    const own = isTerminalView(view);
    const ours = own ? view.terminal : (target?.terminal ?? null);
    const fFocus = focused();
    let focusedNow = false;
    if (this.wantFocus) {
      const prev = this.focusedForCmd;
      this.wantFocus = false;
      this.focusedForCmd = null;
      this.sessionSwitched = false;
      if (prev !== s) {
        this.scheduleFocus(s);
        focusedNow = true;
      }
    } else if (this.sessionSwitched) {
      this.sessionSwitched = false;
      if (this.shown) {
        this.scheduleFocus(s);
        focusedNow = true;
      }
    }
    if (this.firstStackRender) {
      this.firstStackRender = false;
      if (
        !focusedNow &&
        this.shown &&
        this.layoutScreen !== "panes" &&
        fFocus?.pane !== null &&
        fFocus?.pane !== undefined &&
        fFocus?.terminal !== null &&
        fFocus?.terminal !== undefined
      ) {
        this.scheduleFocus(s);
      }
    }
    const focusedTerm =
      this.stackMode && this.layoutScreen !== "panes" && fFocus?.pane !== null ? null : (fFocus?.terminal ?? null);
    s.guard = observe(s.guard, focusedTerm, ours, now);
    s.guard = observeLeft(s.guard, leftAt(shared(TERMINAL_FOCUS), ours));
    const term = target ? (ps.find((p) => p.pane === target.pane) ?? null) : null;
    const tab = this.currentTab();
    const f = this.viewFeedOf(s);
    const lost = !this.stackMode && this.located.state === "missing";
    const gone =
      (!this.stackMode && this.located.state === "exited") || (!lost && s.feed.waiting?.state === "no_terminal");
    const kind = own ? view.kind : s.kind;
    const name = own && view.kind ? agentName(view.kind) : s.name;
    const fresh = !gone && !lost && kind !== null && !view.child && (freshChat(f, kind) || newConversation(f, kind));

    const terms = target
      ? terminals().filter(
          (x) => typeof x?.address === "string" && machineOfAddress(x.address) === machineOfAddress(target.terminal),
        )
      : [];
    this.termInfo = new Map(
      terms.map((x) => [
        x.address,
        {
          kind: x.program?.key === "claude" || x.program?.key === "codex" ? x.program.key : null,
          program: String(x.program?.name || x.program?.key || "terminal"),
        },
      ]),
    );
    const rows = target
      ? threadRows(
          s.tree,
          terms,
          own ? [] : s.requests,
          { terminal: target.terminal, kind: target.kind, name: s.name, status: s.status },
          now,
        )
      : [];
    s.rows = rows;
    const subs = Math.max(0, rows.length - 1);

    /** @type {Problem | null} */
    let problem = null;
    if (lost)
      problem = {
        title: "Chat target not found",
        message: `No single ${s.name} terminal in this window's chat tabs matches this chat.`,
        exited: false,
      };
    else if (gone) problem = { title: `${s.name} exited`, message: "", exited: true };
    else if (this.installing !== null)
      problem = { title: helperText("installing", this.installing), message: "", exited: false };
    else if (f.error)
      problem = { title: helperText(f.error.state, target?.machine ?? null), message: f.error.message, exited: false };
    else if (f.waiting && !fresh)
      problem = {
        title: waitingText(f.waiting.state, name, target?.machine ?? null),
        message: f.waiting.message,
        exited: false,
      };

    if (!this.stackMode) root.child(this.header(t, s, term, gone, subs));

    const body = div().id("chat-body").relative().flex_1().min_h(0).w_full().flex().flex_col();
    const viewRows = f.rows;
    if (problem && !viewRows.length) {
      body.child(
        v_flex()
          .id("chat-state")
          .flex_1()
          .min_h(0)
          .items_center()
          .justify_center()
          .gap(8)
          .px(32)
          .child(div().text_size(13.5).text_color(t.foreground).child(problem.title))
          .when(Boolean(problem.message), (el) =>
            el.child(div().max_w(560).text_size(11.5).text_color(t.muted).truncate().child(problem.message)),
          )
          .child(this.buttons(t, problem, term, tab, s)),
      );
    } else if (!f.loaded || !viewRows.length) {
      body.child(
        v_flex()
          .flex_1()
          .min_h(0)
          .items_center()
          .justify_center()
          .px(24)
          .text_size(13)
          .text_color(t.muted)
          .child(
            f.loaded ? (view.child ? "No messages yet." : "No messages yet. Send the first one below.") : "Loading…",
          ),
      );
    } else {
      const col = columnWidth(this.width);
      body.child(
        timeline(
          viewRows,
          {
            t,
            pane: this.width || 800,
            col,
            agent: name,
            blocked: !own && term?.status === "blocked",
            open: s.open,
            pictures: this.pictures,
          },
          {
            listId: this.stackMode ? `chat-${s.terminal}` : "chat",
            sizes: viewRows.map((r) => this.height(s, r)),
            scroll: s.scroll,
            onClick: (key, cx) => this.clickRow(s, key, cx),
            onWheel: (e, cx) => this.wheel(s, e, cx),
            onRange: (range) => {
              s.topSeen = range.start === 0;
              if (range.start === 0 && range.end === 1 && viewRows.length > 1) return;
              s.follow = range.end >= viewRows.length;
            },
          },
        ),
      );
    }
    if (subs > 0) {
      const current = view.child ?? (own ? view.terminal : null);
      body.child(
        cardOpen(rows, s.toggle)
          ? threadsCard(rows, {
              t,
              current,
              onRow: (row, cx) => this.openRow(s, row, cx),
              paneHeight: this.paneHeight,
              paneWidth: this.width,
              hovered: this.threadHover,
              onHover: (id, on, cx) => {
                const next = on ? id : this.threadHover === id ? null : this.threadHover;
                if (next === this.threadHover) return;
                this.threadHover = next;
                cx.notify();
              },
            })
          : threadsPill(pillText(rows), t, (cx) => {
              s.toggle = toggleCard(s.rows, s.toggle);
              cx.notify();
            }),
      );
    }
    root.child(body);

    if (problem && viewRows.length) {
      root.child(
        h_flex()
          .id("chat-notice")
          .w_full()
          .flex_none()
          .px(16)
          .pt(8)
          .gap(10)
          .items_center()
          .justify_center()
          .child(
            div()
              .min_w(0)
              .truncate()
              .text_size(12.5)
              .text_color(problem.exited ? t.foreground : t.muted)
              .child(problem.title),
          )
          .child(this.buttons(t, problem, term, tab, s)),
      );
    }
    if (s.viewNote) {
      root.child(
        h_flex()
          .id("view-note")
          .w_full()
          .flex_none()
          .px(16)
          .pt(8)
          .justify_center()
          .text_size(12.5)
          .text_color(t.muted)
          .child(s.viewNote),
      );
    }

    const guarded = isGuarded(s.guard, now);
    s.drawnGuarded = guarded;
    const cards = dockCards(s.requests, {
      now,
      guarded,
      sending: s.sendingIds,
      agentName: name,
      expect: this.answerExpect(s),
    }).map((c) => ({
      ...c,
      buttons: c.buttons.map((b) =>
        b.id === "terminal"
          ? b
          : {
              ...b,
              enabled: b.enabled && !s.wentOut.has(c.id) && (b.id !== "submit" || complete(this.draftOf(s, c))),
            },
      ),
    }));
    for (const id of s.cardsShown) if (!cards.some((c) => c.id === id)) s.cardsShown.delete(id);
    const active = activeQuestion(s.requests);
    const docked = dock(
      {
        t,
        cards,
        notice: target && kind ? this.hooksNotice(s, target.machine, kind) : null,
        draftOf: (c) => this.draftOf(s, c),
        active: active?.id ?? null,
        focus: this.focus,
        other: this.other,
        notes: s.answerNotes,
        shown: s.cardsShown,
      },
      {
        onButton: (c, b, cx) => this.clickCard(s, c, b, cx),
        onOption: (c, step, i, cx) => this.chooseOption(s, c, step, i, cx),
        onStep: (c, step, cx) => this.showStep(s, c, step, cx),
        onKey: (c, e, cx) => this.cardKey(s, c, e, cx),
        onNotice: (b, cx) => this.clickNotice(b, cx),
        onShown: (id, cx) => {
          s.cardsShown.add(id);
          cx.notify();
        },
      },
    );
    if (docked) root.child(docked);

    if (view.child || own) {
      const row = rows.find((r) => r.id === (view.child ?? (own ? view.terminal : null)));
      const text = barText(
        row ?? {
          id: "",
          kind: "child",
          depth: 1,
          state: "done",
          type: own ? view.program : "sub-agent",
          description: "",
          since: "",
          requests: 0,
          open: null,
        },
        s.name,
      );
      root.child(
        subagentBar(text, s.name, t, (cx) => this.setView(s, { child: null }, cx), {
          centered: this.stackMode,
          maxW: READ_W,
        }),
      );
      if (!own) return root;
    }

    const reason = gone
      ? `${s.name} exited`
      : own && !view.kind
        ? "This terminal runs no Claude or Codex"
        : s.sending
          ? "Sending…"
          : problem
            ? problem.title
            : fresh || (f.path && f.session)
              ? null
              : f.loaded
                ? waitingText("no_log", name)
                : "Loading…";

    if (this.stackMode && !own && target) {
      const strip = contextStrip(
        {
          t,
          machine: target.machine,
          agents: this.stackLocated.agents,
          activeTerminal: target.terminal,
          pr: s.pr,
          prHeadOid: s.prHeadOid,
          prBusy: s.prBusy,
          queue: s.queue,
          queueBusy: s.queueBusy,
          sending: s.sending,
          canSendNow: reason === null && expectation(s.feed, s.kind) !== null,
          editingId: this.editingQueue?.terminal === s.terminal ? this.editingQueue.id : null,
          editInput: this.editInput,
        },
        {
          onSelectAgent: (terminal, cx) => {
            if (!tab) return;
            setShared(CHAT_AGENT, pinTabAgent(shared(CHAT_AGENT), tab, terminal, this.liveTabIds));
            this.wantFocus = true;
            this.focusedForCmd = null;
            run("agent.focus", { terminal });
            cx.notify();
          },
          onOpenPr: (pr, cx) => this.openPr(s, pr, cx),
          onBabysitPr: (pr, cx) => this.runSkillCommand(s, babysitCommand(pr.number), cx),
          onMergePr: (pr, cx) => this.runSkillCommand(s, mergeCommand(pr.number), cx),
          onQueueResume: (cx) => this.mutateQueue(s, ["resume", "--terminal", s.local], cx),
          onQueueClear: (cx) =>
            this.mutateQueue(s, ["clear", "--terminal", s.local], cx, () => {
              if (this.editingQueue?.terminal === s.terminal) {
                this.editingQueue = null;
                this.editInput.set_value("");
              }
            }),
          onQueueEditStart: (item, cx) => {
            this.editingQueue = { terminal: s.terminal, id: item.id };
            this.editInput.set_value(item.text);
            this.editInput.focus();
            cx?.timer?.after?.(30, (/** @type {any} */ tcx) => {
              if (!this.alive || !this.editingQueue) return;
              this.editInput.focus();
              tcx?.notify?.();
            });
            cx.notify();
          },
          onQueueEditSave: (id, cx) => this.saveQueueEdit(s, id, cx),
          onQueueEditCancel: (cx) => {
            this.editingQueue = null;
            this.editInput.set_value("");
            cx.notify();
          },
          onQueueMove: (id, to, cx) =>
            this.mutateQueue(s, ["move", "--terminal", s.local, "--id", id, "--to", String(to)], cx),
          onQueueSendNow: (item, cx) => this.sendQueuedNow(s, item, cx),
          onQueueRemove: (id, cx) =>
            this.mutateQueue(s, ["remove", "--terminal", s.local, "--id", id], cx, () => {
              if (this.editingQueue?.id === id) {
                this.editingQueue = null;
                this.editInput.set_value("");
              }
            }),
        },
      );
      if (strip) root.child(strip);
    }

    const chips = chipsView(t, chipsFor(shared(ATTACH), tab), this.chipHover, {
      hover: (id, on, cx) => {
        const next = on ? id : this.chipHover === id ? null : this.chipHover;
        if (next === this.chipHover) return;
        this.chipHover = next;
        cx.notify();
      },
      remove: (id, cx) => {
        if (tab === null) return;
        s.note = null;
        setShared(ATTACH, removeChip(shared(ATTACH), tab, id));
        cx.notify();
      },
      mode: (id, mode, cx) => {
        if (tab === null) return;
        s.note = null;
        setShared(ATTACH, setChipMode(shared(ATTACH), tab, id, mode));
        cx.notify();
      },
    });
    const queueMode = this.stackMode && !own && s.status === "working";
    return root.child(
      s.composer.render(t, {
        disabled: reason !== null,
        reason,
        sending: s.sending,
        queueMode,
        note: s.note,
        chips,
      }),
    );
  }
}
