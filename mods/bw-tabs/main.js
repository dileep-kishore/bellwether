// The tab bar over the active tab: the active space's tabs, drag to reorder, and "+" for bw-new.
// Always shown, so it also turns the tabs "+" starts into chat tabs and runs ⌘J (bw-tabs.chat-flip).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { home, layout, nextCommand, notify, openOverlay, panes, run, setShared, shared, spaces, theme, window } from "herdr";
import { adopt, flipActions, wakeAt } from "./chat-tabs.js";
import { moveIndex, tabItems } from "./model.js";
import { createPoke } from "./refresh-driver.js";
import { ICONS, machineTag, programIcon, statusIcon } from "./ui.js";

const CHAT_TABS = "bw.chat-tabs";
const MIN_WAKE_MS = 1000;

/** @param {any} node @param {string} id @returns {any} */
function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

/** @param {unknown} _e @param {{ stop_propagation(): void }} cx */
const stop = (_e, cx) => cx.stop_propagation();

export default class Tabs extends View {
  /** @param {unknown} _p @param {any} cx */
  init(_p, cx) {
    /** The tab a left press started on, until the release. @type {string | null} */
    this.pressed = null;
    /** The tab under the pointer while one is pressed, for the drop marker. @type {string | null} */
    this.over = null;
    /** ⌘J was pressed; the next render flips the active chat tab. */
    this.flip = false;
    /** The wake time render last asked the wake task for. @type {number | null} */
    this.wakeFor = null;
    this.wake = createPoke();

    // Tasks never read live data: this one only marks the flip, and render reads panes().
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        if ((await nextCommand()) !== "chat-flip") continue;
        this.flip = true;
        cx.notify();
      }
    });
    // A split retry or a pending chat's expiry is due by the clock alone, with no live change to redraw.
    cx.spawn(async (/** @type {any} */ cx) => {
      /** @type {{ cancel(): void } | null} */
      let timer = null;
      for (;;) {
        await this.wake.wait();
        timer?.cancel();
        timer = null;
        const at = this.wakeFor;
        if (at === null) continue;
        // No timer under 1000 ms; a retry then runs up to a second late.
        timer = cx.timer.after(Math.max(MIN_WAKE_MS, at - Date.now()), (/** @type {any} */ cx) => {
          this.wakeFor = null;
          cx.notify();
        });
      }
    });
  }

  /**
   * Adopts new chat tabs and runs a pending ⌘J. Every command here is guarded by the stored state
   * or `this.flip`, so a second render repeats none of them.
   * @param {any[]} all SpaceInfo[]
   * @param {any[]} ps PaneInfo[]
   * @param {any} space the active space
   */
  chatTabs(all, ps, space) {
    const r = adopt(shared(CHAT_TABS), all, ps, Date.now());
    if (r.next) setShared(CHAT_TABS, r.next);
    for (const [cmd, args] of r.actions) run(cmd, args);
    for (const n of r.notices) notify({ ...n, level: "warning" });
    const state = r.next ?? shared(CHAT_TABS);

    if (this.flip) {
      this.flip = false;
      const active = space?.tabs.find((/** @type {any} */ t) => t.active)?.id ?? null;
      for (const [cmd, args] of flipActions(state, active, ps)) run(cmd, args);
    }

    const at = wakeAt(state);
    if (at !== this.wakeFor) {
      this.wakeFor = at;
      this.wake.poke();
    }
  }

  render() {
    const t = theme();
    const all = spaces();
    const ps = panes();
    const space = all.find((s) => s.active) ?? null;
    this.chatTabs(all, ps, space);
    const items = tabItems(space, ps);
    const w = window();
    const sidebar = find(layout(), "sidebar");
    // With the sidebar hidden the bar's left edge sits under macOS's traffic lights.
    const pad = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && sidebar?.hidden ? 76 : 8;

    const tab = (/** @type {import("./model.js").TabItem} */ c) => {
      const marked = this.pressed !== null && this.pressed !== c.id && this.over === c.id;
      return h_flex().id(`tab-${c.id}`).h(26).px(10).gap(6).flex_none().items_center().rounded(6).text_size(12.5)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .when(marked, (el) => el.border_l(2).border_color(t.accent))
        .when(c.settled, (el) => el.opacity(0.6))
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.pressed = c.id; this.over = null; })
        .on_mouse_move((_e, cx) => {
          if (this.pressed === null || this.over === c.id) return;
          this.over = c.id;
          cx.notify();
        })
        .on_mouse_up("left", () => {
          const index = moveIndex(items, this.pressed, c.id);
          const from = this.pressed;
          this.pressed = null;
          this.over = null;
          if (index !== null && from !== null) run("tab.move", { id: from, index });
        })
        // A press on one tab and a release on another is a drag, and GPUI sends no click then.
        .on_click(() => run("tab.select", { id: c.id }))
        .child(programIcon(c.program, t))
        .child(div().max_w(170).truncate().child(c.title))
        .child(statusIcon(t, c.status))
        .when(Boolean(space?.machine), (el) => el.child(machineTag(String(space?.machine), t)))
        .when(c.active, (el) => el.child(
          div().id(`close-${c.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
            .child(svg(ICONS.close).size(12)),
        ));
    };

    const props = space ? { space: space.id } : { machine: null, folder: home() };
    return h_flex().id("tabs-bar").h(32).w_full().min_w(0).pl(pad).pr(8).gap(4).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      // Presses here start the window drag, so they only forget a press that ended off the tabs.
      .on_mouse_down("left", () => { this.pressed = null; this.over = null; })
      .on_mouse_up("left", () => { this.pressed = null; this.over = null; })
      // A drag released off the bar never reaches it; the next press elsewhere ends that drag.
      .on_mouse_down_out(() => { this.pressed = null; this.over = null; })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(items.map(tab)))
      .child(
        div().id("tab-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click(() => openOverlay({ mod: "bw-new", kind: "popup", width: 232, height: 300, props }))
          .child(svg(ICONS.plus).size(14)),
      );
  }
}
