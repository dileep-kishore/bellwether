// One agent's chat beside its terminal. One loop task reads `bw feed` on the space's machine (every
// 2 s while shown, 10 s while hidden, start to start) and never reads live data; render reads the
// panes, decides shown, and pokes the loop when that changes. Sends and pictures go through this
// Mac's helper with the terminal's full address.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { exec, home, nextCommand, panes, run, shared, spaces, theme } from "herdr";
import { entryForTerminal, isShown } from "./chat-tabs.js";
import { Composer } from "./composer.js";
import { columnWidth, rowHeight } from "./estimate.js";
import { applyFeed, applyOlder, emptyFeed, olderFrom } from "./feedstate.js";
import { createHelper, parseLines } from "./helper.js";
import { createPictures } from "./pictures.js";
import { createPoke } from "./refresh-driver.js";
import { agentName, helperText, pollMs, sendText, targetOf, waitingText } from "./target.js";
import { timeline, waitsInTerminal } from "./timeline.js";
import { ICONS, machineTag, programIcon } from "./ui.js";

const CHAT_TABS = "bw.chat-tabs";

/** @typedef {import("./target.js").Target} Target */
/** @typedef {{ title: string, message: string, exited: boolean }} Problem */

export default class Chat extends View {
  /** @param {unknown} props @param {any} cx */
  init(props, cx) {
    /** @type {Target | null} */
    this.target = targetOf(props);
    this.alive = true;
    if (!this.target) return;
    const target = this.target;
    this.name = agentName(target.kind);
    this.feed = emptyFeed(target.terminal);
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
    // Read once here so the loop's first sleep already has the right length; render keeps it current.
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
            await this.readFeed(cx);
            if (this.wantOlder) await this.readOlder(cx);
            this.startPictures(cx);
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

  /** @param {any[]} all SpaceInfo[] @param {any[]} ps PaneInfo[] */
  readShown(all, ps) {
    const target = /** @type {Target} */ (this.target);
    let entry = entryForTerminal(shared(CHAT_TABS), target.terminal);
    if (!entry) {
      // A chat placed by hand has no entry: its tab is the terminal's, its pane the bw-chat pane there.
      const term = ps.find((p) => p.terminal === target.terminal);
      const chat = term ? ps.find((p) => p.tab === term.tab && p.mod === "bw-chat") : null;
      entry = term ? /** @type {any} */ ({ tab: term.tab, chatPane: chat?.pane ?? null }) : null;
    }
    return isShown(entry, all, ps);
  }

  /** @param {any} cx */
  async readFeed(cx) {
    const t = /** @type {Target} */ (this.target);
    const args = ["feed", "--terminal", t.local, "--pictures"];
    if (this.feed.cursor) args.push("--cursor", this.feed.cursor);
    const answer = await this.helper.call(t.machine, args);
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
    const t = /** @type {Target} */ (this.target);
    const before = olderFrom(this.feed);
    if (before === null) return;
    this.olderBusy = true;
    try {
      const answer = await this.helper.call(t.machine, ["feed", "--terminal", t.local, "--before", String(before), "--pictures"]);
      const added = applyOlder(this.feed, answer, before);
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
    const t = /** @type {Target} */ (this.target);
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
    const t = /** @type {Target} */ (this.target);
    const { session, path } = this.feed;
    if (this.sending || !session || !path) return;
    this.sending = true;
    this.note = null;
    cx.notify();
    const args = ["send", "--terminal", t.terminal, "--expect-kind", t.kind, "--expect-session", session, "--expect-path", path, "--text", text];
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const answer = await this.helper.call(null, args);
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
    const target = /** @type {Target} */ (this.target);
    return h_flex().id("chat-header").h(36).flex_none().w_full().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(programIcon(term?.program ?? null, t, 14))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(this.name))
      .when(Boolean(term?.branch), (el) => el.child(h_flex().min_w(0).gap(4).items_center().text_size(12).text_color(t.muted)
        .child(svg(ICONS.branch).size(12).flex_none()).child(div().min_w(0).truncate().child(String(term.branch)))))
      .when(target.machine !== null, (el) => el.child(machineTag(String(target.machine), t)))
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
    const target = this.target;
    if (!target) {
      return root.child(v_flex().id("chat-state").flex_1().items_center().justify_center().gap(6).px(24)
        .child(div().text_size(13.5).text_color(t.foreground).child("This chat names no terminal"))
        .child(div().text_size(12).text_color(t.dim).child("Start a chat from + in the tab bar.")));
    }

    const all = spaces();
    const ps = panes();
    const shown = this.readShown(all, ps);
    if (shown !== this.shown) {
      this.shown = shown;
      this.poke.poke();
    }
    const term = ps.find((p) => p.terminal === target.terminal) ?? null;
    const tab = entryForTerminal(shared(CHAT_TABS), target.terminal)?.tab ?? term?.tab ?? null;
    const f = this.feed;
    const gone = !term || f.waiting?.state === "no_terminal";

    /** @type {Problem | null} */
    let problem = null;
    if (gone) problem = { title: `${this.name} exited`, message: "", exited: true };
    else if (this.installing !== null) problem = { title: helperText("installing", this.installing), message: "", exited: false };
    else if (f.error) problem = { title: helperText(f.error.state, target.machine), message: f.error.message, exited: false };
    else if (f.waiting) problem = { title: waitingText(f.waiting.state, this.name, target.machine), message: f.waiting.message, exited: false };

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
          if (range.end >= rows.length) this.follow = true;
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
          : !f.path || !f.session ? (f.loaded ? waitingText("no_log", this.name) : "Loading…")
            : null;
    return root.child(this.composer.render(t, { disabled: reason !== null, reason, sending: this.sending, note: this.note }));
  }
}
