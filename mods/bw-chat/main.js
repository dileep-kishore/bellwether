// One agent's chat beside its terminal. One loop task reads `bw feed` on the space's machine (every
// 2 s while shown, 10 s while hidden, start to start) and never reads live data; render reads the
// panes, decides shown, and pokes the loop when that changes. Sends go through the helper on the
// space's machine; pictures through this Mac's helper with the terminal's full address.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { exec, home, nextCommand, panes, run, shared, spaces, theme } from "herdr";
import { isShown } from "./chat-tabs.js";
import { Composer } from "./composer.js";
import { columnWidth, rowHeight } from "./estimate.js";
import { applyFeed, applyOlder, emptyFeed, freshChat, olderFrom } from "./feedstate.js";
import { createHelper, parseLines } from "./helper.js";
import { createPictures } from "./pictures.js";
import { createPoke } from "./refresh-driver.js";
import { agentName, helperText, pollMs, resolveTarget, sendText, targetOf, waitingText } from "./target.js";
import { timeline, waitsInTerminal } from "./timeline.js";
import { ICONS, machineTag, programIcon } from "./ui.js";

const WINDOW_ID = "bw.window-id";

/** @typedef {import("./target.js").Target} Target */
/** @typedef {import("./target.js").Found} Found */
/** @typedef {import("./target.js").Located} Located */
/** @typedef {{ title: string, message: string, exited: boolean }} Problem */

export default class Chat extends View {
  /** @param {unknown} props @param {any} cx */
  init(props, cx) {
    /** What the props name, in the namespace of the window that wrote them. @type {Target | null} */
    this.id = targetOf(props);
    /** @type {string | null} */
    this.window = typeof (/** @type {any} */ (props))?.window === "string" ? /** @type {any} */ (props).window : null;
    this.alive = true;
    if (!this.id) return;
    this.name = agentName(this.id.kind);
    /** The terminal in this chat's own tab, as this window names it; null while it is not found. @type {Found | null} */
    this.target = null;
    /** @type {Located} */
    this.located = { state: "missing" };
    this.feed = emptyFeed(this.id.terminal);
    this.poke = createPoke();
    this.pictures = createPictures();
    this.picturesBusy = false;
    this.scroll = VirtualListScrollHandle.new();
    /** @type {Set<string>} */
    this.open = new Set();
    /** @type {WeakMap<object, { w: number, open: boolean, h: number }>} */
    this.heights = new WeakMap();
    this.width = 0;
    this.follow = true;
    this.topSeen = false;
    this.wantOlder = false;
    this.olderBusy = false;
    this.sending = false;
    /** @type {{ text: string, bad: boolean } | null} */
    this.note = null;
    /** @type {string | null} the machine the helper is being installed on */
    this.installing = null;
    // Read once here so the first feed and the loop's first sleep are right; render keeps both current.
    this.locate(spaces(), panes());
    this.shown = this.readShown(spaces(), panes());
    this.composer = new Composer({ placeholder: `Message ${this.name}…`, onSend: (text, cx) => this.send(text, cx) });

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
          throw new Error(`could not start bw on this Mac (${e instanceof Error ? e.message : String(e)}): run scripts/install-helper.sh`);
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
            applyFeed(this.feed, { ok: false, state: "failed", message: e instanceof Error ? e.message : String(e) });
            cx.notify();
          }
          const wait = Math.max(0, pollMs(this.shown) - (Date.now() - started));
          await Promise.race([cx.sleep(wait), this.poke.wait()]);
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
    this.open.clear();
    this.follow = true;
    this.note = null;
    return true;
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
    return isShown({ tab, chatPane: chat?.pane ?? null }, all, ps);
  }

  /** @param {any} cx */
  async readFeed(cx) {
    const t = /** @type {Found} */ (this.target);
    const feed = this.feed;
    const args = ["feed", "--terminal", t.local, "--pictures"];
    if (feed.cursor) args.push("--cursor", feed.cursor);
    const answer = await this.helper.call(t.machine, args);
    if (this.feed !== feed) return;
    const installed = this.installing !== null;
    this.installing = null;
    const at = applyFeed(this.feed, answer);
    if (at >= 0 || installed) {
      if (this.follow) this.toNewest();
      cx.notify();
    }
  }

  /** The first row is on screen and the log goes back further: read the part before and put it on top.
   * @param {any} cx */
  async readOlder(cx) {
    this.wantOlder = false;
    const t = /** @type {Found} */ (this.target);
    const feed = this.feed;
    const before = olderFrom(feed);
    if (before === null) return;
    this.olderBusy = true;
    try {
      const answer = await this.helper.call(t.machine, ["feed", "--terminal", t.local, "--before", String(before), "--pictures"]);
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
    if (this.picturesBusy || !this.pictures.wanted(this.feed.rows).length) return;
    this.picturesBusy = true;
    const t = /** @type {Found} */ (this.target);
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        for (let p = this.pictures.wanted(this.feed.rows)[0]; p && this.alive; p = this.pictures.wanted(this.feed.rows)[0]) {
          this.pictures.start(p.digest);
          const answer = await this.helper.call(null, ["picture", "--terminal", t.terminal, "--offset", String(p.offset), "--index", String(p.index), "--digest", p.digest]);
          this.pictures.done(p.digest, answer);
          cx.notify();
        }
      } finally {
        this.picturesBusy = false;
      }
    });
  }

  toNewest() {
    const n = this.feed.rows.length;
    if (n) this.scroll.scroll_to_item(n - 1, "top");
  }

  /** Runs from the composer's submit, an event. @param {string} text @param {any} cx */
  send(text, cx) {
    const t = this.target;
    if (!t) return;
    const fresh = freshChat(this.feed, t.kind);
    const { session, path } = fresh ? { session: "none", path: "none" } : this.feed;
    if (this.sending || !session || !path) return;
    this.sending = true;
    this.note = null;
    cx.notify();
    const args = ["send", "--terminal", t.local, "--expect-kind", t.kind, "--expect-session", session, "--expect-path", path, "--text", text];
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        // hc wraps text sent from another core as `<hc from=…>`, so slash commands only run when sent there.
        const answer = await this.helper.call(t.machine, args);
        const line = answer.ok ? answer.lines.find((/** @type {any} */ l) => l.type === "send") : null;
        const result = typeof line?.result === "string" ? line.result : "failed";
        const message = answer.ok ? String(line?.message || "bw send printed no result") : answer.message;
        const went = result === "sent" || result === "unconfirmed";
        this.note = result === "sent" ? null : { text: sendText(result, this.name, message), bad: !went };
        if (went) this.composer.clear();
      } finally {
        this.sending = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {any} row */
  height(row) {
    const w = columnWidth(this.width), open = this.open.has(row.id);
    const c = this.heights.get(row);
    if (c && c.w === w && c.open === open) return c.h;
    const h = rowHeight(row, w, open);
    this.heights.set(row, { w, open, h });
    return h;
  }

  /** @param {string} key @param {any} cx */
  clickRow(key, cx) {
    const row = this.feed.rows.find((r) => r.id === key);
    if (!row) return;
    if (row.k === "tools") {
      if (!this.open.delete(key)) this.open.add(key);
      cx.notify();
    } else if (row.k === "changed") {
      run("layout.select", { stack: "right-body", child: "changes" });
    } else if (waitsInTerminal(row)) {
      run("bw-tabs.chat-flip");
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
    if (this.topSeen && !this.olderBusy && !this.wantOlder && olderFrom(this.feed) !== null) {
      this.wantOlder = true;
      this.poke.poke();
    }
  }

  /** @param {Record<string, string>} t @param {Problem} p @param {any} term @param {string | null} tab */
  buttons(t, p, term, tab) {
    const button = (/** @type {string} */ id, /** @type {string} */ label, /** @type {() => void} */ act) =>
      div().id(id).h(26).px(10).flex_none().flex().items_center().rounded(6).cursor_pointer().border(1).border_color(t.border)
        .text_size(12).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(act).child(label);
    return h_flex().gap(8).items_center()
      .when(Boolean(term), (el) => el.child(button("show-terminal", "Show terminal (⌘J)", () => run("bw-tabs.chat-flip"))))
      .when(p.exited && tab !== null, (el) => el.child(button("close-tab", "Close tab", () => run("tab.close", { id: /** @type {string} */ (tab) }))));
  }

  /** @param {Record<string, string>} t @param {any} term @param {boolean} gone */
  header(t, term, gone) {
    const target = this.target;
    return h_flex().id("chat-header").h(36).flex_none().w_full().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(programIcon(term?.program ?? null, t, 14))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(this.name))
      .when(Boolean(term?.branch), (el) => el.child(h_flex().min_w(0).gap(4).items_center().text_size(12).text_color(t.muted)
        .child(svg(ICONS.branch).size(12).flex_none()).child(div().min_w(0).truncate().child(String(term.branch)))))
      .when(Boolean(target?.machine), (el) => el.child(machineTag(String(target?.machine), t)))
      .child(div().flex_1())
      .when(!gone, (el) => el.child(h_flex().id("flip").h(24).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click(() => run("bw-tabs.chat-flip"))
        .child("Terminal").child(div().text_color(t.dim).child("⌘J"))));
  }

  /** @param {any} cx */
  render(cx) {
    const t = theme();
    const root = v_flex().id("chat-root").size_full().min_w(0).bg(t.background)
      .on_size_change((/** @type {{ width: number }} */ size, /** @type {any} */ cx) => {
        if (Math.abs(size.width - this.width) < 1) return;
        this.width = size.width;
        cx.notify();
      });
    if (!this.id) {
      return root.child(v_flex().id("chat-state").flex_1().items_center().justify_center().gap(6).px(24)
        .child(div().text_size(13.5).text_color(t.foreground).child("This chat names no terminal"))
        .child(div().text_size(12).text_color(t.dim).child("Start a chat from + in the tab bar.")));
    }

    const all = spaces();
    const ps = panes();
    const moved = this.locate(all, ps);
    const shown = this.readShown(all, ps);
    if (shown !== this.shown || moved) {
      this.shown = shown;
      this.poke.poke();
    }
    const target = this.target;
    const term = target ? ps.find((p) => p.pane === target.pane) ?? null : null;
    const tab = this.tab();
    const f = this.feed;
    const lost = this.located.state === "missing";
    const gone = this.located.state === "exited" || (!lost && f.waiting?.state === "no_terminal");
    const fresh = !gone && !lost && freshChat(f, /** @type {Target} */ (this.id).kind);

    /** @type {Problem | null} */
    let problem = null;
    if (lost) problem = { title: "Chat target not found", message: `No single ${this.name} terminal in this window's chat tabs matches this chat.`, exited: false };
    else if (gone) problem = { title: `${this.name} exited`, message: "", exited: true };
    else if (this.installing !== null) problem = { title: helperText("installing", this.installing), message: "", exited: false };
    else if (f.error) problem = { title: helperText(f.error.state, target?.machine ?? null), message: f.error.message, exited: false };
    else if (f.waiting && !fresh) problem = { title: waitingText(f.waiting.state, this.name, target?.machine ?? null), message: f.waiting.message, exited: false };

    root.child(this.header(t, term, gone));
    const rows = f.rows;
    if (problem && !rows.length) {
      root.child(v_flex().id("chat-state").flex_1().min_h(0).items_center().justify_center().gap(8).px(32)
        .child(div().text_size(13.5).text_color(t.foreground).child(problem.title))
        .when(Boolean(problem.message), (el) => el.child(div().max_w(560).text_size(11.5).text_color(t.dim).truncate().child(problem.message)))
        .child(this.buttons(t, problem, term, tab)));
    } else if (!f.loaded || !rows.length) {
      root.child(v_flex().flex_1().min_h(0).items_center().justify_center().px(24).text_size(13).text_color(t.muted)
        .child(f.loaded ? "No messages yet. Send the first one below." : "Loading…"));
    } else {
      const col = columnWidth(this.width);
      root.child(timeline(rows, {
        t, pane: this.width || 800, col, agent: this.name, blocked: term?.status === "blocked", open: this.open, pictures: this.pictures,
      }, {
        sizes: rows.map((r) => this.height(r)),
        scroll: this.scroll,
        onClick: (key, cx) => this.clickRow(key, cx),
        onWheel: (e, cx) => this.wheel(e, cx),
        onRange: (range) => {
          this.topSeen = range.start === 0;
          // Herdr also lays out one representative row ({0, 1}) each frame to measure it; that is not the view.
          if (range.start === 0 && range.end === 1 && rows.length > 1) return;
          // A scrollbar drag moves the list with no wheel event, so the range alone says whether the end is in view.
          this.follow = range.end >= rows.length;
        },
      }));
      if (problem) {
        root.child(h_flex().id("chat-notice").w_full().flex_none().px(16).pt(8).gap(10).items_center().justify_center()
          .child(div().min_w(0).truncate().text_size(12.5).text_color(problem.exited ? t.foreground : t.muted).child(problem.title))
          .child(this.buttons(t, problem, term, tab)));
      }
    }

    const reason = gone ? `${this.name} exited`
      : this.sending ? "Sending…"
        : problem ? problem.title
          : fresh || (f.path && f.session) ? null
            : f.loaded ? waitingText("no_log", this.name) : "Loading…";
    return root.child(this.composer.render(t, { disabled: reason !== null, reason, sending: this.sending, note: this.note }));
  }
}
