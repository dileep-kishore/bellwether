// The right sidebar. With no `panel` prop this copy is the 36 px strip that switches the
// `right-body` stack; with `panel` it is that stack child's placeholder until its phase fills it.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, run, setShared, shared, spaces, theme } from "herdr";
import { PANELS, choose, chosen, wanted } from "./choice.js";

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
  /** @param {{ panel?: string } | undefined} props */
  init(props) {
    /** @type {string | null} */
    this.panel = props?.panel ?? null;
    // The space and panel last asked of layout.select, so a layout() that has not caught up yet
    // does not get the same command on every render.
    /** @type {string | null} */
    this.asked = null;
  }

  render() {
    const t = theme();
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

    const shown = space ? chosen(stored, space.id) : (PANELS.find((p) => p.id === stack?.active)?.id ?? chosen(stored, null));
    return h_flex().id("right-strip").h(36).w_full().flex_none().px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border).children(
      PANELS.map((p) => {
        const on = p.id === shown;
        return h_flex().id(`right-tab-${p.id}`).h(24).px(10).items_center().rounded(6).cursor_pointer().text_size(12)
          .text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.bg(t.selected).font_medium())
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click(() => {
            run("layout.select", { stack: STACK, child: p.id });
            if (!space) return;
            this.asked = `${space.id}\n${p.id}`;
            setShared(KEY, choose(shared(KEY), space.id, p.id, ids));
          })
          .child(p.label);
      }),
    );
  }

  /** @param {Record<string, string>} t */
  placeholder(t) {
    const p = PANELS.find((x) => x.id === this.panel);
    const copy = p ? `${p.label}: coming in phase ${p.phase}` : `Unknown panel: ${this.panel}`;
    return v_flex().size_full().items_center().justify_center().p(16).bg(t.chrome).text_size(13).text_color(t.dim).child(div().text_center().child(copy));
  }
}
