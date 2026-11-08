// One agent's chat beside its terminal. One loop task reads `bw feed --tree --cards` on the space's machine
// (every 2 s while shown, 10 s while hidden, start to start) and never reads live data; render reads the
// panes, terminals and focus, decides shown, and pokes the loop when that changes. Sends and answers go
// through the helper on the space's machine; pictures and hook setup through this Mac's helper.
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
import { CHAT_SHOWN, hasMod, isShown, leftAt, shownFrom, TERMINAL_FOCUS } from "./chat-tabs.js";
import { choose } from "./choice.js";
import { Composer } from "./composer.js";
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
import { columnWidth, rowHeight } from "./estimate.js";
import { applyFeed, applyOlder, emptyFeed, expectation, freshChat, newConversation, olderFrom } from "./feedstate.js";
import { createGuard, guardedUntil, isGuarded, observe, observeLeft } from "./focus-guard.js";
import { createHelper, parseLines } from "./helper.js";
import { createPictures } from "./pictures.js";
import { createPoke } from "./refresh-driver.js";
import {
  TRUST_STEP,
  agentName,
  helperText,
  hooksState,
  hooksText,
  pollMs,
  resolveTarget,
  sendText,
  targetOf,
  waitingText,
} from "./target.js";
import { subagentBar, threadsButton, threadsCard, threadsPill } from "./threads.js";
import { barText, cardOpen, pillText, threadRows, toggleCard } from "./threads-model.js";
import { timeline, waitsInTerminal } from "./timeline.js";
import { ICONS, machineTag, programIcon, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

// bw-right's per-space panel choice.
const RIGHT_TAB = "bw.right.tab";
const WINDOW_ID = "bw.window-id";
const DISMISSED = "bw.hooks-dismissed";
const ROOT_ENDED = "This conversation ended; showing the new one";

/** @typedef {import("./target.js").Target} Target */
/** @typedef {import("./target.js").Found} Found */
/** @typedef {import("./target.js").Located} Located */
/** @typedef {import("./feedstate.js").FeedState} FeedState */
/** @typedef {import("./dock-model.js").Request} Request */
/** @typedef {import("./dock-model.js").Card} Card */
/** @typedef {import("./dock-model.js").Draft} Draft */
/** @typedef {import("./threads-model.js").Row} Row */
/** @typedef {{ title: string, message: string, exited: boolean }} Problem */
/** @typedef {"claude" | "codex"} Kind */

/**
 * What the chat shows: the parent's conversation, a sub-agent's own log, or a terminal sub-agent as a chat of
 * its own terminal (`terminal` in this window's namespace, `local` on the space's machine).
 * @typedef {{ child: null } | { child: string } | { child?: undefined, terminal: string, local: string, kind: Kind | null, program: string }} ViewState
 */

/**
 * @typedef {object} HooksUi The hooks notice's Review and Apply steps for one machine.
 * @property {string} machine the machine name, "local" for this Mac
 * @property {"loading" | "diff" | "applying" | "applied" | "failed"} phase
 * @property {any[]} [diff] the `hooks-diff` lines
 * @property {string} [message]
 */

/** @param {ViewState} v @returns {v is { terminal: string, local: string, kind: Kind | null, program: string }} */
const isTerminalView = (v) => "terminal" in v && typeof v.terminal === "string";

/** @param {string} address @returns {string | null} */
const machineOfAddress = (address) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : null);

/** The pending question that holds the keyboard and the Other field: the oldest one a click can answer.
 * @param {Request[]} requests @returns {Request | null} */
function activeQuestion(requests) {
  const qs = requests.filter(
    (r) => (r.kind === "question" || r.kind === "question_async") && r.state === "pending" && r.answerable,
  );
  qs.sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));
  return qs[0] ?? null;
}

const NO_KEYS_WITH = ["control", "alt", "platform", "function"];
// Results after which the request's keys or message reached the terminal, or another answer holds it.
const WENT_OUT = new Set(["answered", "declined", "uncertain", "sent", "already-answered"]);

export default class Chat extends View {
  /** @param {unknown} _props Herdr passes undefined; props() holds this pane's props. @param {any} cx */
  init(_props, cx) {
    const props = /** @type {unknown} */ (herdrProps());
    /** What the props name, in the namespace of the window that wrote them. @type {Target | null} */
    this.id = targetOf(props);
    /** @type {string | null} */
    this.window = typeof (/** @type {any} */ (props)?.window) === "string" ? /** @type {any} */ (props).window : null;
    this.alive = true;
    if (!this.id) return;
    this.name = agentName(this.id.kind);
    /** The terminal in this chat's own tab, as this window names it; null while it is not found. @type {Found | null} */
    this.target = null;
    /** @type {Located} */
    this.located = { state: "missing" };
    /** The parent conversation's feed. */
    this.feed = emptyFeed(this.id.terminal);
    /** @type {ViewState} */
    this.view = { child: null };
    /** A sub-agent's or terminal sub-agent's feed while its view is open. @type {FeedState | null} */
    this.sub = null;
    /** @type {any} the last `tree` line */
    this.tree = null;
    /** @type {any} the last `cards` line */
    this.cards = null;
    /** @type {Request[]} */
    this.requests = [];
    /** @type {{ open: boolean, running: string[] } | null} */
    this.toggle = null;
    /** @type {Row[]} */
    this.rows = [];
    /** @type {Map<string, { kind: Kind | null, program: string }>} terminal sub-agents seen in render */
    this.termInfo = new Map();
    this.guard = createGuard(Date.now());
    this.drawnGuarded = true;
    /** @type {Set<string>} requests whose `bw answer` runs */
    this.sendingIds = new Set();
    /** @type {Map<string, string>} the last `bw answer` result by request */
    this.answerNotes = new Map();
    /** @type {Set<string>} requests whose keys or message went out; no second click while they stay pending */
    this.wentOut = new Set();
    /** @type {Map<string, Draft>} */
    this.drafts = new Map();
    /** @type {string | null} which draft step the Other field shows */
    this.otherKey = null;
    /** @type {string | null} */
    this.viewNote = null;
    /** @type {HooksUi | null} */
    this.hooksUi = null;
    this.poke = createPoke();
    this.pictures = createPictures();
    this.picturesBusy = false;
    this.scroll = VirtualListScrollHandle.new();
    /** @type {Set<string>} */
    this.open = new Set();
    /** @type {WeakMap<object, { w: number, open: boolean, h: number }>} */
    this.heights = new WeakMap();
    this.width = 0;
    /** The pane's height from on_size_change; 0 before the first layout. */
    this.paneHeight = 0;
    this.follow = true;
    this.topSeen = false;
    this.wantOlder = false;
    this.olderBusy = false;
    this.sending = false;
    /** @type {{ text: string, bad: boolean } | null} */
    this.note = null;
    /** @type {string | null} the machine the helper is being installed on */
    this.installing = null;
    // Read once here so the first feed and the loop's first sleep are right; render keeps them current.
    const ps = panes();
    this.locate(spaces(), ps);
    /** This chat's own pane, as the last render saw it. @type {string | null} */
    this.chatPane = null;
    /** The layout has bw-tabs, the writer of the shown list, as the last render saw it. */
    this.listed = false;
    /** @type {boolean} */
    this.shown = this.readShown(spaces(), ps);
    this.status = this.statusOf(ps);
    this.composer = new Composer({ placeholder: `Message ${this.name}…`, onSend: (text, cx) => this.send(text, cx) });
    // Retained state is made here, never in render: one keyboard target and one Other field, for the active question.
    this.focus = cx.focus_handle();
    this.other = InputState.new({ placeholder: "Other…" });
    this.other.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      const a = activeQuestion(this.requests);
      if (!a) return;
      const d = this.draftOf(a);
      const v = this.other.value();
      if (v === (d.other[d.step] ?? "")) return;
      this.drafts.set(a.id, setOther(d, d.step, v));
      cx?.notify?.();
    });

    const bw = `${home()}/.local/share/bellwether/helper/current/bw`;
    // The loop task's own cx, so an install can redraw before it finishes.
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
          try {
            if (this.target) {
              await this.readFeed(cx);
              if (this.wantOlder) await this.readOlder(cx);
              this.startPictures(cx);
            }
          } catch (e) {
            // A thrown error would end the loop and freeze the chat; name it and keep polling.
            applyFeed(this.viewFeed(), {
              ok: false,
              state: "failed",
              message: e instanceof Error ? e.message : String(e),
            });
            cx.notify();
          }
          const now = Date.now();
          // The guard ended since the last frame: draw the buttons enabled again.
          if (this.drawnGuarded && !isGuarded(this.guard, now)) cx.notify();
          // A hidden copy is not drawn, so render cannot tell it went out of sight; bw-tabs's list can.
          // Only bw-tabs writes the list, so in a layout without it the list is stale and render decides.
          if (this.listed) this.shown = shownFrom(shared(CHAT_SHOWN), this.chatPane, this.shown);
          let wait = Math.max(0, pollMs(this.shown) - (now - started));
          if (this.answerable() && isGuarded(this.guard, now))
            wait = Math.max(1000, Math.min(wait, guardedUntil(this.guard) - now));
          await this.poke.wait(cx.sleep(wait));
        }
      } finally {
        loopCx = null;
      }
    });
    cx.spawn(async () => {
      while (this.alive) if ((await nextCommand()) === "focus") this.composer.focus();
    });
  }

  close() {
    this.alive = false;
    this.poke?.poke();
  }

  /** @returns {FeedState} the feed the view shows */
  viewFeed() {
    return this.view.child || isTerminalView(this.view) ? /** @type {FeedState} */ (this.sub) : this.feed;
  }

  /** @param {any[]} ps PaneInfo[] */
  statusOf(ps) {
    const t = this.target;
    return t ? (ps.find((p) => p.pane === t.pane)?.status ?? null) : null;
  }

  /** A pending request a click could answer once the guard ends. */
  answerable() {
    return this.requests.some((r) => r.state === "pending" && r.answerable);
  }

  /**
   * Finds this chat's terminal again; a different one than before starts the feed over, so rows and a
   * send never mix two terminals. Returns whether the target changed.
   * @param {any[]} all SpaceInfo[] @param {any[]} ps PaneInfo[]
   */
  locate(all, ps) {
    const id = /** @type {Target} */ (this.id);
    const located = resolveTarget(id, this.window !== null && this.window === shared(WINDOW_ID), all, ps);
    this.located = located;
    const next = located.state === "found" ? located.target : null;
    const prev = this.target;
    this.target = next;
    if (!next || !prev) return next !== prev;
    if (next.machine === prev.machine && next.local === prev.local) return false;
    this.feed = emptyFeed(next.terminal);
    this.setView({ child: null }, null);
    // Another terminal: no request, answer or guard of the old one may carry over.
    this.tree = null;
    this.toggle = null;
    this.requests = [];
    this.cards = null;
    this.answerNotes.clear();
    this.wentOut.clear();
    this.guard = createGuard(Date.now());
    return true;
  }

  /**
   * Opens another view. Leaving or entering a terminal sub-agent's view drops the requests and starts a new
   * focus guard, since its dock answers another terminal.
   * @param {ViewState} next @param {any} cx null from render or the loop
   */
  setView(next, cx) {
    const was = this.view;
    const wasT = isTerminalView(was) ? was.terminal : null;
    const nextT = isTerminalView(next) ? next.terminal : null;
    this.view = next;
    this.sub = next.child || nextT ? emptyFeed(nextT ?? this.target?.terminal ?? "") : null;
    this.open.clear();
    this.follow = true;
    this.wantOlder = false;
    this.note = null;
    this.viewNote = null;
    if (wasT !== nextT) {
      this.requests = [];
      this.cards = null;
      this.answerNotes.clear();
      this.wentOut.clear();
      this.guard = createGuard(Date.now());
    }
    this.poke.poke();
    cx?.notify();
  }

  /** The chat's tab: its terminal's, or the one it was left alone in. */
  tab() {
    const l = this.located;
    return l.state === "found" ? l.target.tab : l.state === "exited" ? l.tab : null;
  }

  /** @param {any[]} all SpaceInfo[] @param {any[]} ps PaneInfo[] */
  readShown(all, ps) {
    const tab = this.tab();
    if (tab === null) return false;
    const chat = ps.find((p) => p.tab === tab && p.mod === "bw-chat");
    this.chatPane = chat?.pane ?? null;
    this.listed = hasMod(layout(), "bw-tabs");
    return isShown({ tab, chatPane: this.chatPane }, all, ps);
  }

  /**
   * A sub-agent view's answer names a root other than the one the chat shows: Claude's `/clear` or Codex's `/new`.
   * @param {any[]} lines
   */
  rootEnded(lines) {
    const root = this.feed.session;
    if (!root) return false;
    /** @param {unknown} s */
    const other = (s) => typeof s === "string" && s !== "" && s !== root;
    // A new root whose log exists already answers tree + no_child + cards, with no log line.
    return lines.some(
      (l) =>
        (l?.type === "tree" && other(l.root)) ||
        (other(l?.session) && (l.type === "log" || l.type === "cards" || (l.type === "state" && l.state === "no_log"))),
    );
  }

  /**
   * Keeps the `tree`, `cards` and `request` lines of one answer. Returns whether any changed.
   * @param {any[]} lines @param {boolean} withTree the poll asked for the tree
   */
  applySide(lines, withTree) {
    let changed = false;
    if (withTree) {
      // No tree line comes while the root has no log: no sub-agents to list then.
      const tree = lines.find((l) => l?.type === "tree") ?? null;
      if (JSON.stringify(tree) !== JSON.stringify(this.tree)) changed = true;
      this.tree = tree;
    }
    const cards = lines.find((l) => l?.type === "cards") ?? null;
    const requests = cards
      ? /** @type {Request[]} */ (lines.filter((l) => l?.type === "request" && typeof l.id === "string"))
      : [];
    if (
      JSON.stringify(cards) !== JSON.stringify(this.cards) ||
      JSON.stringify(requests) !== JSON.stringify(this.requests)
    )
      changed = true;
    this.cards = cards;
    this.requests = requests;
    const ids = new Set(requests.map((r) => r.id));
    for (const id of [...this.drafts.keys()]) if (!ids.has(id)) this.drafts.delete(id);
    for (const id of [...this.answerNotes.keys()]) if (!ids.has(id)) this.answerNotes.delete(id);
    const pending = new Set(requests.filter((r) => r.state === "pending").map((r) => r.id));
    for (const id of [...this.wentOut]) if (!pending.has(id)) this.wentOut.delete(id);
    this.syncOther();
    return changed;
  }

  /** Reads the view's feed. When the root ended it shows the parent, whose read the poke in `setView` starts.
   * @param {any} cx @returns {Promise<void>} */
  async readFeed(cx) {
    const t = /** @type {Found} */ (this.target);
    const view = this.view;
    const feed = this.viewFeed();
    const own = isTerminalView(view);
    const args = ["feed", "--terminal", own ? view.local : t.local, "--pictures"];
    // A terminal sub-agent has a session tree of its own, which is not this chat's.
    if (!own) args.push("--tree");
    args.push("--cards");
    if (view.child) args.push("--session", view.child);
    if (feed.cursor) args.push("--cursor", feed.cursor);
    const answer = await this.helper.call(t.machine, args);
    if (this.view !== view || this.viewFeed() !== feed) return;
    const installed = this.installing !== null;
    this.installing = null;
    if (view.child && answer.ok && this.rootEnded(answer.lines)) {
      this.setView({ child: null }, null);
      this.viewNote = ROOT_ENDED;
      this.tree = null;
      cx.notify();
      return;
    }
    const at = applyFeed(feed, answer);
    const side = answer.ok && this.applySide(answer.lines, !own);
    if (at >= 0 || installed) {
      if (this.follow) this.toNewest();
      cx.notify();
    } else if (side) cx.notify();
  }

  /** The first row is on screen and the log goes back further: read the part before and put it on top.
   * @param {any} cx */
  async readOlder(cx) {
    this.wantOlder = false;
    const t = /** @type {Found} */ (this.target);
    const view = this.view;
    const feed = this.viewFeed();
    const before = olderFrom(feed);
    if (before === null) return;
    this.olderBusy = true;
    try {
      const args = ["feed", "--terminal", isTerminalView(view) ? view.local : t.local];
      if (view.child) args.push("--session", view.child);
      args.push("--before", String(before), "--pictures");
      const answer = await this.helper.call(t.machine, args);
      if (this.viewFeed() !== feed) return;
      const added = applyOlder(feed, answer, before);
      // The row that was first stays where it was.
      if (added) this.scroll.scroll_to_item(added, "top");
    } finally {
      this.olderBusy = false;
      cx.notify();
    }
  }

  /** Copies the wanted pictures one at a time in their own task, so a slow copy never holds up the feed.
   * @param {any} cx */
  startPictures(cx) {
    const feed = this.viewFeed();
    if (this.picturesBusy || !this.pictures.wanted(feed.rows).length) return;
    const view = this.view;
    if (view.child) {
      // bw picture reads the terminal's root log, so a sub-agent's pictures are named, never fetched.
      for (let p = this.pictures.wanted(feed.rows)[0]; p; p = this.pictures.wanted(feed.rows)[0]) {
        this.pictures.start(p.digest);
        this.pictures.done(p.digest, { ok: false });
      }
      cx.notify();
      return;
    }
    this.picturesBusy = true;
    const terminal = isTerminalView(view) ? view.terminal : /** @type {Found} */ (this.target).terminal;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        for (
          let p = this.pictures.wanted(feed.rows)[0];
          p && this.alive && this.viewFeed() === feed;
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

  toNewest() {
    const n = this.viewFeed().rows.length;
    if (n) this.scroll.scroll_to_item(n - 1, "top");
  }

  /** Where the composer sends: the parent's terminal, or a terminal sub-agent's; none in a sub-agent's view. */
  sendTarget() {
    const t = this.target;
    if (!t) return null;
    const v = this.view;
    if (isTerminalView(v))
      return v.kind
        ? {
            machine: t.machine,
            local: v.local,
            kind: v.kind,
            feed: /** @type {FeedState} */ (this.sub),
            name: agentName(v.kind),
          }
        : null;
    if (v.child) return null;
    return { machine: t.machine, local: t.local, kind: t.kind, feed: this.feed, name: this.name };
  }

  /** Runs from the composer's submit, an event. @param {string} text @param {any} cx */
  send(text, cx) {
    const st = this.sendTarget();
    if (!st) return;
    const expect = expectation(st.feed, st.kind);
    if (this.sending || !expect) return;
    const { session, path } = expect;
    this.sending = true;
    this.note = null;
    this.viewNote = null;
    cx.notify();
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
      text,
    ];
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        // hc wraps text sent from another core as `<hc from=…>`, so slash commands only run when sent there.
        const answer = await this.helper.call(st.machine, args);
        const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l.type === "send") : null;
        const result = typeof line?.result === "string" ? line.result : "failed";
        const message = answer.ok === true ? String(line?.message || "bw send printed no result") : answer.message;
        const went = result === "sent" || result === "unconfirmed";
        this.note = result === "sent" ? null : { text: sendText(result, st.name, message), bad: !went };
        if (went) this.composer.clear();
      } finally {
        this.sending = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /**
   * What `bw answer` is told to expect, or null when no click may answer. In a sub-agent's view the parent's
   * feed is not read, so the root conversation is the one the `cards` line names, while it is the chat's.
   * @returns {{ kind: Kind, session: string, path: string } | null}
   */
  answerExpect() {
    const t = this.target;
    if (!t) return null;
    const v = this.view;
    if (isTerminalView(v)) {
      const e = v.kind ? expectation(/** @type {FeedState} */ (this.sub), v.kind) : null;
      return e && v.kind ? { kind: v.kind, ...e } : null;
    }
    if (v.child) {
      const c = this.cards;
      const ok =
        c &&
        typeof c.session === "string" &&
        c.session &&
        typeof c.path === "string" &&
        c.path &&
        c.session === this.feed.session;
      return ok ? { kind: t.kind, session: c.session, path: c.path } : null;
    }
    const e = expectation(this.feed, t.kind);
    return e ? { kind: t.kind, ...e } : null;
  }

  /** @param {{ id: string, question?: any }} req @returns {Draft} */
  draftOf(req) {
    let d = this.drafts.get(req.id);
    if (!d) {
      d = emptyDraft(req.question);
      this.drafts.set(req.id, d);
    }
    return d;
  }

  /** Puts the active question's Other text for its shown step in the field, when that step changed. */
  syncOther() {
    const a = activeQuestion(this.requests);
    const d = a ? this.draftOf(a) : null;
    const key = a && d ? `${a.id}:${d.step}` : null;
    const want = d ? (d.other[d.step] ?? "") : "";
    // A pick on the same step clears the draft's Other text, which the field must show too.
    if (key === this.otherKey && this.other.value() === want) return;
    this.otherKey = key;
    this.other.set_value(want);
  }

  /** @param {string} id */
  requestOf(id) {
    return this.requests.find((r) => r.id === id) ?? null;
  }

  /**
   * Sends one click's answer with `bw answer` on the space's machine. Every check the card's buttons show is
   * made again here, since a click can arrive after the frame that drew them.
   * @param {Request | null} req @param {{ action: string } | { answers: { picks: number[], other?: string }[] }} choice @param {any} cx
   */
  answer(req, choice, cx) {
    const t = this.target;
    if (!t || !req || req.state !== "pending" || !req.answerable || this.sendingIds.size || this.wentOut.has(req.id))
      return;
    if (isGuarded(this.guard, Date.now())) return;
    const expect = this.answerExpect();
    const v = this.view;
    const local = isTerminalView(v) ? v.local : t.local;
    const name = isTerminalView(v) && v.kind ? agentName(v.kind) : this.name;
    let args;
    try {
      args = answerArgs(req, choice, { local }, expect);
    } catch {
      return;
    }
    this.sendingIds.add(req.id);
    this.answerNotes.delete(req.id);
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      let text = "";
      try {
        const answer = await this.helper.call(t.machine, args);
        // The find keeps only an answer line whose result is a string.
        const line = /** @type {{ result: string, state?: string, message?: string } | null} */ (
          answer.ok ? answer.lines.find((l) => l?.type === "answer" && typeof l.result === "string") : null
        );
        if (line && WENT_OUT.has(line.result)) this.wentOut.add(req.id);
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
        this.sendingIds.delete(req.id);
        if (text) this.answerNotes.set(req.id, text);
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** Brings the shown view's terminal in front: a terminal sub-agent's own, else the chat tab's terminal. */
  showTerminal() {
    const v = this.view;
    // A sub-agent has no pane in the chat's tab and terminal.show would replace the chat's pane; peek opens it over the tab.
    if (isTerminalView(v)) run("terminal.peek", { terminal: v.terminal });
    else run("bw-tabs.chat-flip");
  }

  /** @param {Card} card @param {string} button @param {any} cx */
  clickCard(card, button, cx) {
    if (button === "terminal") {
      this.showTerminal();
      return;
    }
    const req = this.requestOf(card.id);
    if (button === "submit") {
      if (!req) return;
      const d = this.draftOf(req);
      if (complete(d)) this.answer(req, { answers: answersOf(d) }, cx);
      return;
    }
    this.answer(req, { action: button }, cx);
  }

  /** @param {Card} card @param {number} step @param {number} index @param {any} cx */
  chooseOption(card, step, index, cx) {
    const req = this.requestOf(card.id);
    if (!req) return;
    const d = this.draftOf(req);
    this.drafts.set(req.id, d.multi[step] ? toggle(d, step, index) : pick(d, step, index));
    this.focus.focus();
    this.syncOther();
    cx.notify();
  }

  /** @param {Card} card @param {number} step @param {any} cx */
  showStep(card, step, cx) {
    const req = this.requestOf(card.id);
    if (!req) return;
    const d = this.draftOf(req);
    if (!Number.isInteger(step) || step < 0 || step >= d.counts.length) return;
    this.drafts.set(req.id, { ...d, step });
    this.syncOther();
    cx.notify();
  }

  /** A digit picks an option and never submits; Enter submits. @param {Card} card @param {any} e @param {any} cx */
  cardKey(card, e, cx) {
    if (NO_KEYS_WITH.some((m) => e?.modifiers?.[m])) return;
    const req = this.requestOf(card.id);
    if (!req) return;
    const key = String(e?.key ?? "");
    if (/^[1-9]$/.test(key)) {
      const d = this.draftOf(req);
      this.drafts.set(req.id, digit(d, d.step, Number(key)));
      this.syncOther();
      cx.stop_propagation?.();
      cx.notify();
    } else if (key === "enter") {
      cx.stop_propagation?.();
      this.clickCard(card, "submit", cx);
    }
  }

  /**
   * The hooks notice for this chat's machine, or null. `bw machine setup` runs on this Mac and reaches the
   * space's machine itself.
   * @param {string | null} machine @param {Kind} kind
   * @returns {import("./dock.js").Notice | null}
   */
  hooksNotice(machine, kind) {
    const state = hooksState(this.cards?.hooks, kind);
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

  /** @param {any} row */
  height(row) {
    const w = columnWidth(this.width),
      open = this.open.has(row.id);
    const c = this.heights.get(row);
    if (c && c.w === w && c.open === open) return c.h;
    const h = rowHeight(row, w, open);
    this.heights.set(row, { w, open, h });
    return h;
  }

  /** @param {string} key @param {any} cx */
  clickRow(key, cx) {
    const row = this.viewFeed().rows.find((r) => r.id === key);
    if (!row) return;
    if (row.k === "tools") {
      if (!this.open.delete(key)) this.open.add(key);
      cx.notify();
    } else if (row.k === "changed") {
      run("layout.select", { stack: "right-body", child: "changes" });
      // Stored as bw-right's strip stores a click, or its next render restores the space's last choice.
      const all = spaces();
      const space = all.find((s) => s.active);
      if (space) {
        const ids = all.map((s) => s.id);
        setShared(RIGHT_TAB, choose(shared(RIGHT_TAB), space.id, "changes", ids));
      }
    } else if (waitsInTerminal(row)) {
      this.showTerminal();
    }
  }

  /** A threads card row: the parent's view, a sub-agent's log, or a terminal sub-agent's chat. @param {Row} row @param {any} cx */
  openRow(row, cx) {
    if (row.kind === "parent") {
      if (this.view.child || isTerminalView(this.view)) this.setView({ child: null }, cx);
      return;
    }
    const open = row.open;
    if (open && "child" in open) {
      if (this.view.child !== open.child) this.setView({ child: open.child }, cx);
      return;
    }
    if (open && "terminal" in open && this.target) {
      const address = open.terminal;
      const m = this.target.machine;
      const local = m !== null && address.startsWith(`${m}/`) ? address.slice(m.length + 1) : address;
      const info = this.termInfo.get(address);
      if (!isTerminalView(this.view) || this.view.terminal !== address) {
        this.setView({ terminal: address, local, kind: info?.kind ?? null, program: info?.program ?? row.type }, cx);
      }
    }
  }

  /** @param {any} e @param {any} cx */
  wheel(e, cx) {
    if (!((e?.delta?.y ?? 0) > 0)) return;
    if (this.follow) {
      this.follow = false;
      cx.notify();
    }
    // Older rows load only when you scroll up with the first row on screen.
    if (this.topSeen && !this.olderBusy && !this.wantOlder && olderFrom(this.viewFeed()) !== null) {
      this.wantOlder = true;
      this.poke.poke();
    }
  }

  /** @param {Theme} t @param {Problem} p @param {any} term @param {string | null} tab */
  buttons(t, p, term, tab) {
    const button = (/** @type {string} */ id, /** @type {string} */ label, /** @type {() => void} */ act) =>
      div()
        .id(id)
        .h(26)
        .px(10)
        .flex_none()
        .flex()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .border(1)
        .border_color(t.border)
        .text_size(12)
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click(act)
        .child(label);
    return h_flex()
      .gap(8)
      .items_center()
      .when(Boolean(term), (el) => el.child(button("show-terminal", "Show terminal (⌘J)", () => this.showTerminal())))
      .when(p.exited && tab !== null, (el) =>
        el.child(button("close-tab", "Close tab", () => run("tab.close", { id: /** @type {string} */ (tab) }))),
      );
  }

  /** @param {Theme} t @param {any} term @param {boolean} gone @param {number} subs sub-agent rows */
  header(t, term, gone, subs) {
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
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(this.name))
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
            this.toggle = toggleCard(this.rows, this.toggle);
            cx.notify();
          }),
        ),
      )
      .when(!gone, (el) =>
        el.child(
          h_flex()
            .id("flip")
            .h(24)
            .px(8)
            .gap(6)
            .flex_none()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .text_size(12)
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.showTerminal())
            .child("Terminal")
            .child(div().text_color(t.dim).child("⌘J")),
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
    if (!this.id) {
      return root.child(
        v_flex()
          .id("chat-state")
          .flex_1()
          .items_center()
          .justify_center()
          .gap(6)
          .px(24)
          .child(div().text_size(13.5).text_color(t.foreground).child("This chat names no terminal"))
          .child(div().text_size(12).text_color(t.dim).child("Start a chat from + in the tab bar.")),
      );
    }

    const now = Date.now();
    const all = spaces();
    const ps = panes();
    const moved = this.locate(all, ps);
    const shown = this.readShown(all, ps);
    const status = this.statusOf(ps);
    if (shown !== this.shown || moved || status !== this.status) {
      this.shown = shown;
      this.status = status;
      this.poke.poke();
    }
    const target = this.target;
    const view = this.view;
    const own = isTerminalView(view);
    const ours = own ? view.terminal : (target?.terminal ?? null);
    this.guard = observe(this.guard, focused()?.terminal ?? null, ours, now);
    // The terminal may have had focus while this copy was hidden and not drawn; bw-tabs saw it leave.
    this.guard = observeLeft(this.guard, leftAt(shared(TERMINAL_FOCUS), ours));
    const term = target ? (ps.find((p) => p.pane === target.pane) ?? null) : null;
    const tab = this.tab();
    const f = this.viewFeed();
    const lost = this.located.state === "missing";
    const gone = this.located.state === "exited" || (!lost && this.feed.waiting?.state === "no_terminal");
    const kind = own ? view.kind : /** @type {Target} */ (this.id).kind;
    const name = own && view.kind ? agentName(view.kind) : this.name;
    // No log yet, and the first message may go: a chat that never saw one, or the agent's new conversation.
    const fresh = !gone && !lost && kind !== null && !view.child && (freshChat(f, kind) || newConversation(f, kind));

    // Terminal sub-agents are offered only on the parent's machine, where the chat's helper reads them.
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
          this.tree,
          terms,
          own ? [] : this.requests,
          { terminal: target.terminal, kind: target.kind, name: this.name, status },
          now,
        )
      : [];
    this.rows = rows;
    const subs = rows.length - 1;

    /** @type {Problem | null} */
    let problem = null;
    if (lost)
      problem = {
        title: "Chat target not found",
        message: `No single ${this.name} terminal in this window's chat tabs matches this chat.`,
        exited: false,
      };
    else if (gone) problem = { title: `${this.name} exited`, message: "", exited: true };
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

    root.child(this.header(t, term, gone, subs));
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
            el.child(div().max_w(560).text_size(11.5).text_color(t.dim).truncate().child(problem.message)),
          )
          .child(this.buttons(t, problem, term, tab)),
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
            open: this.open,
            pictures: this.pictures,
          },
          {
            sizes: viewRows.map((r) => this.height(r)),
            scroll: this.scroll,
            onClick: (key, cx) => this.clickRow(key, cx),
            onWheel: (e, cx) => this.wheel(e, cx),
            onRange: (range) => {
              this.topSeen = range.start === 0;
              // Herdr also lays out one representative row ({0, 1}) each frame to measure it; that is not the view.
              if (range.start === 0 && range.end === 1 && viewRows.length > 1) return;
              // A scrollbar drag moves the list with no wheel event, so the range alone says whether the end is in view.
              this.follow = range.end >= viewRows.length;
            },
          },
        ),
      );
    }
    if (subs > 0) {
      const current = view.child ?? (own ? view.terminal : null);
      body.child(
        cardOpen(rows, this.toggle)
          ? threadsCard(rows, { t, current, onRow: (row, cx) => this.openRow(row, cx), paneHeight: this.paneHeight })
          : threadsPill(pillText(rows), t, (cx) => {
              this.toggle = toggleCard(this.rows, this.toggle);
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
          .child(this.buttons(t, problem, term, tab)),
      );
    }
    if (this.viewNote) {
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
          .child(this.viewNote),
      );
    }

    const guarded = isGuarded(this.guard, now);
    this.drawnGuarded = guarded;
    const cards = dockCards(this.requests, {
      now,
      guarded,
      sending: this.sendingIds,
      agentName: name,
      expect: this.answerExpect(),
    }).map((c) => ({
      ...c,
      buttons: c.buttons.map((b) =>
        b.id === "terminal"
          ? b
          : { ...b, enabled: b.enabled && !this.wentOut.has(c.id) && (b.id !== "submit" || complete(this.draftOf(c))) },
      ),
    }));
    const active = activeQuestion(this.requests);
    const docked = dock(
      {
        t,
        cards,
        notice: target && kind ? this.hooksNotice(target.machine, kind) : null,
        draftOf: (c) => this.draftOf(c),
        active: active?.id ?? null,
        focus: this.focus,
        other: this.other,
        notes: this.answerNotes,
      },
      {
        onButton: (c, b, cx) => this.clickCard(c, b, cx),
        onOption: (c, step, i, cx) => this.chooseOption(c, step, i, cx),
        onStep: (c, step, cx) => this.showStep(c, step, cx),
        onKey: (c, e, cx) => this.cardKey(c, e, cx),
        onNotice: (b, cx) => this.clickNotice(b, cx),
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
        this.name,
      );
      root.child(subagentBar(text, this.name, t, (cx) => this.setView({ child: null }, cx)));
      if (!own) return root;
    }

    const reason = gone
      ? `${this.name} exited`
      : own && !view.kind
        ? "This terminal runs no Claude or Codex"
        : this.sending
          ? "Sending…"
          : problem
            ? problem.title
            : fresh || (f.path && f.session)
              ? null
              : f.loaded
                ? waitingText("no_log", name)
                : "Loading…";
    return root.child(
      this.composer.render(t, { disabled: reason !== null, reason, sending: this.sending, note: this.note }),
    );
  }
}
