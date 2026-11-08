// The tab bar over the active tab: the active space's tabs, drag to reorder, and "+" for bw-new.
// Always shown, so it also turns the tabs "+" starts into chat tabs and runs ⌘J (bw-tabs.chat-flip).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  focused,
  home,
  layout,
  nextCommand,
  notify,
  openOverlay,
  panes,
  run,
  setShared,
  shared,
  spaces,
  window,
} from "herdr";
import { adopt, CHAT_SHOWN, flipActions, focusRecord, shownChatPanes, TERMINAL_FOCUS, wakeAt } from "./chat-tabs.js";
import { moveIndex, tabItems } from "./model.js";
import { createPoke } from "./refresh-driver.js";
import { ICONS, button, hoverFill, machineTag, mutedOnSelected, programIcon, statusMark, themeColors } from "./ui.js";

const CHAT_TABS = "bw.chat-tabs";
const WINDOW_ID = "bw.window-id";
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
    /** The tab under the pointer, for its hover fill. @type {string | null} */
    this.hovered = null;
    /** ⌘J was pressed; the next render flips the active chat tab. */
    this.flip = false;
    /** The wake time render last asked the wake task for. @type {number | null} */
    this.wakeFor = null;
    this.wake = createPoke();
    /** This app home's id if it has none stored yet; stored with the first chat pane that names it. */
    this.newWindowId = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    const stored = shared(WINDOW_ID);
    const windowId = typeof stored === "string" && stored !== "" ? stored : this.newWindowId;
    const r = adopt(shared(CHAT_TABS), all, ps, Date.now(), windowId);
    if (windowId !== stored && r.actions.some(([cmd]) => cmd === "pane.split")) setShared(WINDOW_ID, windowId);
    if (r.next) setShared(CHAT_TABS, r.next);
    for (const [cmd, args] of r.actions) run(cmd, args);
    for (const n of r.notices) notify({ ...n, level: "warning" });
    const state = r.next ?? shared(CHAT_TABS);
    // Herdr draws no hidden bw-chat copy, so its poll loop learns from this list that it went out of sight.
    const shown = shownChatPanes(all, ps);
    if (JSON.stringify(shown) !== JSON.stringify(shared(CHAT_SHOWN) ?? [])) setShared(CHAT_SHOWN, shown);
    const focus = focusRecord(shared(TERMINAL_FOCUS), focused()?.terminal ?? null, Date.now());
    if (focus) setShared(TERMINAL_FOCUS, focus);

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
    const t = themeColors();
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
      return (
        h_flex()
          .id(`tab-${c.id}`)
          .relative()
          .h(24)
          .pl(10)
          .pr(c.active ? 4 : 10)
          .gap(6)
          .flex_none()
          .items_center()
          .rounded(12)
          .text_size(12.5)
          .when(c.active, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(!c.active, (el) => el.text_color(t.muted))
          // Settled reads as italic rather than faded, so its title keeps AA contrast.
          .when(c.settled, (el) => el.italic())
          .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
            const next = on ? c.id : this.hovered === c.id ? null : this.hovered;
            if (next === this.hovered) return;
            this.hovered = next;
            cx.notify();
          })
          .on_mouse_down("left", (_e, cx) => {
            cx.stop_propagation();
            this.pressed = c.id;
            this.over = null;
          })
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
          .child(hoverFill(t, `tab-hover-${c.id}`, !c.active && this.hovered === c.id, 12))
          .when(marked, (el) =>
            el.child(div().id(`tab-drop-${c.id}`).absolute().left(-3).top(2).bottom(2).w(2).rounded(1).bg(t.accent)),
          )
          .when(c.active, (el) =>
            el.child(div().id(`tab-mark-${c.id}`).absolute().left(10).bottom(2).w(12).h(2).rounded(1).bg(t.accent)),
          )
          .child(programIcon(c.program, t, 13))
          .child(div().max_w(170).truncate().child(c.title))
          .child(statusMark(t, c.status, 12, `tab-status-${c.id}`))
          .when(Boolean(space?.machine), (el) => el.child(machineTag(String(space?.machine), t)))
          .when(c.active, (el) =>
            el.child(
              div()
                .id(`close-${c.id}`)
                .size(18)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(9)
                .text_color(mutedOnSelected)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  run("tab.close", { id: c.id });
                })
                .child(svg(ICONS.close).size(11)),
            ),
          )
      );
    };

    /** @type {{ space: string } | { machine: string | null, folder: string }} */
    const props = space ? { space: space.id } : { machine: null, folder: home() };
    return (
      h_flex()
        .id("tabs-bar")
        .h(32)
        .w_full()
        .min_w(0)
        .pl(pad)
        .pr(8)
        .gap(6)
        .items_center()
        .bg(t.canvas)
        // Presses here start the window drag, so they only forget a press that ended off the tabs.
        .on_mouse_down("left", () => {
          this.pressed = null;
          this.over = null;
        })
        .on_mouse_up("left", () => {
          this.pressed = null;
          this.over = null;
        })
        // A drag released off the bar never reaches it; the next press elsewhere ends that drag.
        .on_mouse_down_out(() => {
          this.pressed = null;
          this.over = null;
        })
        .child(
          h_flex()
            .id("tab-capsule")
            .flex_shrink_1()
            .min_w(0)
            .h(28)
            .px(2)
            .items_center()
            .rounded(14)
            .bg(t.chrome)
            .border(1)
            .border_color(t.border)
            .when(items.length === 0, (el) => el.w(0).border(0).px(0))
            .child(
              h_flex()
                .id("tab-scroll")
                .min_w(0)
                .h_full()
                .items_center()
                .gap(2)
                .overflow_x_scrollbar()
                .children(items.map(tab)),
            ),
        )
        .child(
          button(t, {
            id: "tab-new",
            kind: "ghost",
            h: 26,
            icon: svg(ICONS.plus).size(14),
            onClick: () => openOverlay({ mod: "bw-new", kind: "popup", width: 232, height: 300, frame: "none", props }),
          })
            .accessibility_label("New tab")
            .on_mouse_down("left", stop),
        )
        .child(div().flex_1())
    );
  }
}
