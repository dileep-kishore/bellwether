// The right sidebar's Browser panel: the Bellwether Chrome's tabs and forwards. One loop task runs
// `bw browser status` on this Mac every 2 s, start to start, while the panel is drawn, and never reads
// live data; render reads the layout and the active space, decides shown, and pokes the loop.
import { View, div, image, svg } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import { exec, layout, spaces } from "herdr";
import { createHelper } from "./helper.js";
import {
  canForward,
  canStart,
  forwardKey,
  forwardLabel,
  forwardState,
  isShown,
  portOf,
  resultText,
  viewOf,
} from "./model.js";
import { createPoke } from "./refresh-driver.js";
import { hoverFill, mutedOnSelected, pill, spinner, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

const POLL_MS = 2000;
const MIN_SLEEP_MS = 1000;
const NOTE_MS = 4000;

/** @param {string} name */
const icon = (name) => `mods/bw-browser/icons/${name}.svg`;

/**
 * The header pill's tone for a Chrome state: Mauve while running, Peach when its port is taken,
 * Red when it failed or is missing, plain otherwise.
 * @param {string} state @returns {import("./ui.js").PillTone}
 */
export function stateTone(state) {
  if (state === "running") return "accent";
  if (state === "port_taken") return "blocked";
  if (state === "start_failed" || state === "not_installed" || state === "helper") return "failed";
  return "machine";
}

/** A forward's pill tone: Green when ready, Peach while it waits, Red when it failed. @param {string} state
 * @returns {import("./ui.js").PillTone} */
export function forwardTone(state) {
  if (state === "ready") return "done";
  if (state === "failed" || state === "error") return "failed";
  return "blocked";
}

/** @typedef {import("./model.js").View} PanelView */
/** @typedef {import("./model.js").Tab} Tab */
/** @typedef {import("./model.js").Forward} Forward */
/** @typedef {"up" | "new" | "arrange" | "focus" | "close" | "stop" | "dev"} Action */

export default class Browser extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    /** @type {PanelView} */
    this.view = viewOf(null, null);
    /** Whether the layout shows the panel, as render last read it. @type {boolean} */
    this.shown = false;
    // Herdr draws only shown copies: a read whose notify brought no render means the copy is hidden.
    this.drawn = false;
    /** The loop waits for a poke, with no sleep, until render finds the panel shown and drawn. */
    this.parked = false;
    /** @type {{ id: string, machine: string | null } | null} the active space, as render last read it */
    this.space = null;
    /** @type {string | null} the tab row under the pointer */
    this.hovered = null;
    /** @type {string | null} the id of the button or row whose action runs; other clicks wait for it */
    this.busy = null;
    /** @type {{ id: number, text: string } | null} */
    this.note = null;
    this.noteCount = 0;
    this.adding = false;
    this.portInput = InputState.new({ placeholder: "Port, e.g. 3000" });
    this.poke = createPoke();
    this.helper = createHelper({
      exec,
      // Every call here runs on this Mac, which never installs through the helper.
      localInstall: async () => {
        throw new Error("bw browser runs on this Mac only");
      },
    });

    cx.spawn(async (/** @type {any} */ cx) => {
      while (this.alive) {
        if (!this.shown || !this.drawn) {
          this.parked = true;
          await this.poke.wait();
          continue;
        }
        const started = Date.now();
        await this.read(cx);
        const wait = Math.max(MIN_SLEEP_MS, POLL_MS - (Date.now() - started));
        await this.poke.wait(cx.sleep(wait));
      }
    });
  }

  close() {
    this.alive = false;
    this.poke.poke();
  }

  /** @param {any} cx */
  async read(cx) {
    let answer;
    try {
      answer = await this.helper.call(null, ["browser", "status"]);
    } catch (e) {
      answer = { ok: false, state: "failed", message: e instanceof Error ? e.message : String(e) };
    }
    this.view = answer.ok ? viewOf(answer.lines, null) : viewOf(null, /** @type {any} */ (answer));
    this.drawn = false;
    cx.notify();
  }

  /**
   * Runs one `bw browser …` command, shows its result line, and pokes the loop so the panel reads again.
   * @param {Action} action @param {string[]} args @param {any} cx
   * @param {{ key: string, title?: string }} from the clicked element's id, and the tab's title for a tab action
   */
  act(action, args, cx, { key, title }) {
    if (this.busy) return;
    this.busy = key;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      let answer;
      try {
        answer = await this.helper.call(null, ["browser", ...args]);
      } catch (e) {
        answer = { ok: false, state: "failed", message: e instanceof Error ? e.message : String(e) };
      }
      this.busy = null;
      if (action === "dev" && answer.ok) {
        this.adding = false;
        this.portInput.set_value("");
      }
      this.say(resultText(action, /** @type {any} */ (answer), title), cx);
      this.poke.poke();
    });
  }

  /** Shows `text` for 4 s; a newer note keeps its own 4 s. @param {string} text @param {any} cx */
  say(text, cx) {
    const id = ++this.noteCount;
    this.note = { id, text };
    cx.notify();
    cx.timer.after(NOTE_MS, (/** @type {any} */ cx) => {
      if (this.note?.id !== id) return;
      this.note = null;
      cx.notify();
    });
  }

  /** @param {any} cx */
  addForward(cx) {
    const space = this.space;
    if (this.busy || !space || !canForward(space).ok) return;
    const port = portOf(this.portInput.value());
    if (port === null) {
      this.say("Enter a port from 1 to 65535", cx);
      return;
    }
    this.act(
      "dev",
      ["forward", "dev", "--machine", /** @type {string} */ (space.machine), "--port", String(port)],
      cx,
      { key: "browser-forward-add" },
    );
  }

  render() {
    const t = themeColors();
    const shown = isShown(layout());
    const space = spaces().find((s) => s.active) ?? null;
    this.space = space ? { id: space.id, machine: space.machine ?? null } : null;
    // The panel was shown or hidden, or is drawn again after the loop parked; clearing parked here
    // keeps a second render from poking again.
    if (shown !== this.shown || (shown && this.parked)) {
      this.shown = shown;
      this.parked = false;
      this.poke.poke();
    }
    this.drawn = true;

    const v = this.view;
    const root = v_flex()
      .id("browser-root")
      .size_full()
      .bg(t.chrome)
      .text_size(13)
      .text_color(t.foreground)
      .child(this.header(t, v));
    if (this.note) {
      root.child(
        h_flex()
          .id("browser-note")
          .flex_none()
          .px(12)
          .pt(8)
          .justify_center()
          .child(
            div()
              .max_w_full()
              .h(26)
              .px(12)
              .flex()
              .items_center()
              .rounded(13)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .text_size(12)
              .text_color(t.foreground)
              .truncate()
              .child(this.note.text),
          ),
      );
    }
    if (v.states !== null) {
      root.child(
        v_flex()
          .id("browser-state")
          .flex_1()
          .items_center()
          .justify_center()
          .px(24)
          .text_size(13)
          .text_color(t.muted)
          .child(div().text_center().child(v.states)),
      );
    } else {
      root.child(
        v_flex()
          .id("browser-tabs")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .p(6)
          .gap(2)
          .children(v.tabs.map((tab) => this.tabRow(t, tab))),
      );
    }
    if (v.chrome.state !== "loading") root.child(this.forwards(t, v.forwards));
    return root;
  }

  /** @param {Theme} t @param {PanelView} v */
  header(t, v) {
    const running = v.chrome.state === "running";
    return h_flex()
      .id("browser-header")
      .h(36)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg(icon("chrome")).size(16).flex_none().text_color(t.accent))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(8)
          .items_center()
          .child(div().flex_none().text_size(13).font_medium().child("Bellwether Chrome"))
          .child(pill(t, v.chrome.label, stateTone(v.chrome.state), "browser-state-pill").min_w(0).truncate()),
      )
      .when(running, (el) =>
        el
          .child(
            this.button(t, "browser-new-tab", "plus", "New tab", (cx) =>
              this.act("new", ["new"], cx, { key: "browser-new-tab" }),
            ),
          )
          .child(
            this.button(t, "browser-arrange", "arrange", "Arrange", (cx) =>
              this.act("arrange", ["arrange"], cx, { key: "browser-arrange" }),
            ),
          ),
      )
      .when(canStart(v.chrome.state), (el) =>
        el.child(
          this.button(t, "browser-start", "chrome", "Start", (cx) =>
            this.act("up", ["up"], cx, { key: "browser-start" }),
          ),
        ),
      );
  }

  /**
   * A small header or row button; it shows a spinner while its own action runs.
   * @param {Theme} t @param {string} id @param {string | null} iconName @param {string} label
   * @param {(cx: any) => void} onClick
   */
  button(t, id, iconName, label, onClick) {
    const running = this.busy === id;
    const idle = this.busy === null;
    return h_flex()
      .id(id)
      .flex_none()
      .h(24)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(12)
      .bg(t.raised)
      .text_size(11.5)
      .text_color(idle ? t.foreground : t.muted)
      .when(idle, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onClick(cx))
      .when(running, (el) => el.child(spinner(t, 12)))
      .when(!running && iconName !== null, (el) =>
        el.child(
          svg(icon(/** @type {string} */ (iconName)))
            .size(12)
            .flex_none()
            .text_color(t.muted),
        ),
      )
      .child(label);
  }

  /** @param {Theme} t @param {Tab} tab */
  tabRow(t, tab) {
    const hovered = this.hovered === tab.id;
    const picture = div()
      .id(`browser-favicon-${tab.id}`)
      .size(24)
      .flex_none()
      .rounded(6)
      .bg(t.raised)
      .flex()
      .items_center()
      .justify_center()
      .child(tab.favicon ? image(tab.favicon).w(16).h(16).rounded(3) : svg(icon("globe")).size(14).text_color(t.dim));
    return h_flex()
      .id(`browser-tab-${tab.id}`)
      .h(40)
      .flex_none()
      .relative()
      .pl(10)
      .pr(6)
      .gap(10)
      .items_center()
      .rounded(10)
      .cursor_pointer()
      .when(tab.active, (el) => el.bg(t.selected))
      .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
        const next = on ? tab.id : this.hovered === tab.id ? null : this.hovered;
        if (next === this.hovered) return;
        this.hovered = next;
        cx.notify();
      })
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) =>
        this.act("focus", ["focus", "--id", tab.id], cx, { key: `browser-tab-${tab.id}`, title: tab.title }),
      )
      .child(hoverFill(t, `browser-tab-hover-${tab.id}`, !tab.active && hovered, 10))
      .when(tab.active, (el) =>
        el.child(
          div().id(`browser-tab-bar-${tab.id}`).absolute().left(0).top(10).bottom(10).w(2).rounded(1).bg(t.accent),
        ),
      )
      .child(picture)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(13).text_color(t.foreground).child(tab.title))
          .child(
            div()
              .truncate()
              .text_size(11)
              .text_color(tab.active ? mutedOnSelected : t.muted)
              .child(tab.secondary),
          ),
      )
      .when(hovered, (el) =>
        el.child(
          h_flex()
            .id(`browser-tab-close-${tab.id}`)
            .flex_none()
            .size(22)
            .items_center()
            .justify_center()
            .rounded(11)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
              cx.stop_propagation();
              this.act("close", ["close", "--id", tab.id], cx, {
                key: `browser-tab-close-${tab.id}`,
                title: tab.title,
              });
            })
            .child(svg(icon("close")).size(12).text_color(t.muted)),
        ),
      );
  }

  /** @param {Theme} t @param {Forward[]} list */
  forwards(t, list) {
    const can = canForward(this.space);
    const section = v_flex()
      .id("browser-forwards")
      .flex_none()
      .border_t(1)
      .border_color(t.border)
      .py(6)
      .child(
        h_flex()
          .h(24)
          .px(12)
          .items_center()
          .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child("FORWARDS"))
          .child(
            h_flex()
              .id("browser-forward-port")
              .h(22)
              .px(9)
              .items_center()
              .rounded(11)
              .text_size(11)
              .text_color(can.ok ? t.accent : t.muted)
              .when(can.ok, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
              .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
                if (!can.ok) return;
                this.adding = !this.adding;
                if (this.adding) this.portInput.focus();
                cx.notify();
              })
              .child("Forward port"),
          ),
      );
    if (!can.ok)
      section.child(div().id("browser-forward-hint").px(12).text_size(11).text_color(t.muted).child(can.hint));
    else if (this.adding) {
      section.child(
        h_flex()
          .h(28)
          .px(12)
          .gap(6)
          .items_center()
          .child(
            Input.new(this.portInput)
              .id("browser-forward-input")
              .flex_1()
              .h(28)
              .px(8)
              .items_center()
              .rounded(10)
              .border(1)
              .border_color(t.input)
              .bg(t.background)
              .text_size(13)
              .text_color(t.foreground),
          )
          .child(this.button(t, "browser-forward-add", null, "Add", (cx) => this.addForward(cx))),
      );
    }
    for (const f of list) section.child(this.forwardRow(t, f));
    return section;
  }

  /** @param {Theme} t @param {Forward} f */
  forwardRow(t, f) {
    const key = forwardKey(f);
    const ready = f.state === "ready";
    const args = ["forward", "stop", "--machine", f.machine, ...(f.kind === "dev" ? ["--dev", String(f.port)] : [])];
    return h_flex()
      .id(`browser-forward-row-${key}`)
      .h(28)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(
            div()
              .flex_none()
              .text_size(13)
              .text_color(ready ? t.foreground : t.muted)
              .child(forwardLabel(f)),
          )
          .child(pill(t, forwardState(f), forwardTone(f.state), `browser-forward-state-${key}`))
          .when(!ready && f.reason !== "", (el) =>
            el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(f.reason)),
          ),
      )
      .child(
        this.button(t, `browser-forward-stop-${key}`, null, "Stop", (cx) =>
          this.act("stop", args, cx, { key: `browser-forward-stop-${key}` }),
        ),
      );
  }
}
