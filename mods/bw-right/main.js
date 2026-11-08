// The right sidebar. With no `panel` prop this copy is the 36 px strip that switches the
// `right-body` stack; with `panel` it is that stack child's placeholder until its phase fills it.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, props, run, setShared, shared, spaces } from "herdr";
import { PANELS, choose, chosen, wanted } from "./choice.js";
import { themeColors } from "./ui.js";

/** Each panel's placeholder icon, from the mod that will fill it. @type {Record<string, string>} */
const PANEL_ICON = {
  changes: "mods/bw-chat/icons/changes.svg",
  issues: "mods/bw-right/icons/issues.svg",
  browser: "mods/bw-browser/icons/globe.svg",
};

/** @typedef {import("./ui.js").Theme} Theme */

const KEY = "bw.right.tab";
const STACK = "right-body";

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

export default class Right extends View {
  init() {
    // Herdr passes init no props; props() holds the layout's.
    const p = /** @type {{ panel?: string } | null} */ (props());
    /** @type {string | null} */
    this.panel = p?.panel ?? null;
    // The space and panel last asked of layout.select, so a layout() that has not caught up yet
    // does not get the same command on every render.
    /** @type {string | null} */
    this.asked = null;
  }

  render() {
    const t = themeColors();
    if (this.panel !== null) return this.placeholder(t);

    const all = spaces();
    const space = all.find((s) => s.active) ?? null;
    const ids = all.map((s) => s.id);
    const stack = find(layout(), STACK);
    const stored = shared(KEY);

    const want = stack ? wanted(stored, space?.id, stack.active) : null;
    if (want === null) this.asked = null;
    else if (space && this.asked !== `${space.id}\n${want}`) {
      this.asked = `${space.id}\n${want}`;
      run("layout.select", { stack: STACK, child: want });
    }

    const shown = space
      ? chosen(stored, space.id)
      : (PANELS.find((p) => p.id === stack?.active)?.id ?? chosen(stored, null));
    return h_flex()
      .id("right-strip")
      .h(36)
      .w_full()
      .flex_none()
      .px(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("right-track")
          .h(28)
          .p(2)
          .gap(2)
          .items_center()
          .rounded(14)
          .bg(t.raised)
          .children(
            PANELS.map((p) => {
              const on = p.id === shown;
              return h_flex()
                .id(`right-tab-${p.id}`)
                .h(24)
                .px(10)
                .gap(6)
                .items_center()
                .rounded(12)
                .cursor_pointer()
                .text_size(12)
                .text_color(on ? t.foreground : t.muted)
                .when(on, (el) =>
                  el
                    .bg(t.selected)
                    .font_medium()
                    .child(div().id(`right-dot-${p.id}`).size(6).flex_none().rounded(3).bg(t.accent)),
                )
                .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
                .on_click(() => {
                  run("layout.select", { stack: STACK, child: p.id });
                  if (!space) return;
                  this.asked = `${space.id}\n${p.id}`;
                  setShared(KEY, choose(shared(KEY), space.id, p.id, ids));
                })
                .child(p.label);
            }),
          ),
      );
  }

  /** @param {Theme} t */
  placeholder(t) {
    const p = PANELS.find((x) => x.id === this.panel);
    const copy = p ? `Coming in phase ${p.phase}.` : `Unknown panel: ${this.panel}`;
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .gap(10)
      .p(16)
      .bg(t.chrome)
      .child(
        div()
          .size(40)
          .rounded(20)
          .bg(t.raised)
          .flex()
          .items_center()
          .justify_center()
          .child(
            svg(PANEL_ICON[p?.id ?? ""] ?? PANEL_ICON.issues)
              .size(18)
              .text_color(t.accent),
          ),
      )
      .child(
        div()
          .text_size(13)
          .font_medium()
          .text_color(t.foreground)
          .child(p ? p.label : "Panel"),
      )
      .child(div().text_center().text_size(12).text_color(t.muted).child(copy));
  }
}
