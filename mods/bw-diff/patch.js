// Drawing a patch: a header with the file and its actions, then one 20 px row per line with old and new
// line numbers, added and removed lines tinted Green and Red over Base, hunk headers on Surface 0.
import { div } from "gpui-kit";
import { h_flex, Scrollbar, v_flex, v_virtual_list } from "gpui-base";
import { settings } from "herdr";
import { joinPages, patchRows, size } from "./model.js";
import { alpha, MOCHA, TERMINAL } from "./palette.js";
import { button, spinner } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("gpui-kit").Color} Color */

const ROW = 20;
/** The tints a patch row takes over Base; scripts/verify/contrast.js checks text on both. */
export const ADDED_TINT = /** @type {Color} */ (alpha(MOCHA.green, 0.12));
export const REMOVED_TINT = /** @type {Color} */ (alpha(MOCHA.red, 0.12));

/**
 * A status letter's colour: added and untracked Green, deleted and unmerged Red (bright on a selected
 * row), modified Peach, renamed and copied Blue (bright on a selected row).
 * @param {Theme} t @param {string} letter @param {boolean} selected
 */
export function letterColor(t, letter, selected) {
  if (letter === "A" || letter === "U") return t.done;
  if (letter === "D" || letter === "!") return /** @type {Color} */ (selected ? TERMINAL.ansi[9] : MOCHA.red);
  if (letter === "R" || letter === "C") return selected ? /** @type {Color} */ (TERMINAL.ansi[12]) : t.working;
  if (letter === "M") return t.blocked;
  return selected ? t.foreground : t.muted;
}

/**
 * `+N` in Green and `−M` in Red, each left out when zero or unknown.
 * @param {Theme} t @param {number | null} added @param {number | null} removed @param {boolean} selected @param {string} id
 */
export function counts(t, added, removed, selected, id) {
  const out = [];
  if (added) out.push(div().id(`${id}-added`).flex_none().text_size(11).text_color(t.done).child(`+${added}`));
  if (removed)
    out.push(
      div()
        .id(`${id}-removed`)
        .flex_none()
        .text_size(11)
        .text_color(/** @type {Color} */ (selected ? TERMINAL.ansi[9] : MOCHA.red))
        .child(`−${removed}`),
    );
  return out;
}

/**
 * @param {Theme} t
 * @param {{ id: string, title: string, detail: string, actions: any[], onMore: (cx: any) => void,
 *   patch: import("./main.js").PatchState | null }} o
 */
export function patchView(t, o) {
  const p = o.patch;
  const head = h_flex()
    .id(`${o.id}-head`)
    .h(36)
    .flex_none()
    .px(12)
    .gap(8)
    .items_center()
    .border_t(1)
    .border_b(1)
    .border_color(t.border)
    .bg(t.chrome)
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(div().truncate().text_size(12.5).font_medium().child(o.title))
        .child(div().truncate().text_size(11).text_color(t.muted).child(o.detail)),
    )
    .when(Boolean(p?.loading), (el) => el.child(spinner(t, 12)))
    .children(o.actions);
  const body = v_flex().id(`${o.id}-body`).flex_1().min_h(0).relative().bg(t.background);
  if (!p || (p.loading && p.pages.length === 0)) return v_flex().id(o.id).flex_1().min_h(0).child(head).child(body);
  if (p.error && p.pages.length === 0)
    return v_flex()
      .id(o.id)
      .flex_1()
      .min_h(0)
      .child(head)
      .child(body.p(12).child(div().text_size(12).text_color(t.muted).child(p.error)));

  const { text, cut } = joinPages(p.pages);
  const rows = patchRows(text, cut);
  if (rows.length === 0) rows.push({ kind: "meta", old: null, new: null, text: "No text changes" });
  const more = p.pages.length < p.total;
  const longest = rows.reduce((n, r) => Math.max(n, r.text.length), 0);
  const width = Math.min(6000, Math.max(300, longest * 7 + 96));
  const font = /** @type {any} */ (settings())?.font_family ?? "JetBrains Mono";
  body.child(
    div()
      .id(`${o.id}-x`)
      .size_full()
      .overflow_x_scrollbar()
      .font_family(font)
      .text_size(11.5)
      .child(
        div()
          .w_full()
          .min_w(width)
          .h_full()
          .child(
            v_virtual_list(
              `${o.id}-rows`,
              rows.length,
              ROW,
              (i) => String(i),
              (range) => {
                const out = [];
                for (let i = range.start; i < range.end; i++) out.push(patchRow(t, rows[i]));
                return out;
              },
            ).size_full(),
          ),
      ),
  );
  body.child(Scrollbar.vertical(`${o.id}-rows`).absolute().inset_0());
  const pane = v_flex().id(o.id).flex_1().min_h(0).child(head).child(body);
  if (more)
    pane.child(
      h_flex()
        .id(`${o.id}-more-row`)
        .h(36)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .border_t(1)
        .border_color(t.border)
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11.5)
            .text_color(t.muted)
            .child(`Page ${p.pages.length} of ${p.total} · ${size(p.bytes)}`),
        )
        .child(
          button(t, {
            id: `${o.id}-more`,
            label: p.loading ? "Loading…" : "Show more",
            h: 24,
            enabled: !p.loading,
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => o.onMore(cx),
          }),
        ),
    );
  return pane;
}

/** @param {number | null} n */
const num = (n) => (n === null ? "" : String(n));

/** @param {Theme} t @param {import("./model.js").PatchRow} r */
function patchRow(t, r) {
  if (r.kind === "hunk" || r.kind === "meta" || r.kind === "note") {
    return h_flex()
      .h(ROW)
      .w_full()
      .flex_none()
      .px(12)
      .items_center()
      .when(r.kind === "hunk", (el) => el.bg(t.raised))
      .text_color(t.muted)
      .child(div().min_w(0).truncate().child(r.text));
  }
  const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : r.kind === "cut" ? "·" : " ";
  return h_flex()
    .h(ROW)
    .w_full()
    .flex_none()
    .items_center()
    .when(r.kind === "add", (el) => el.bg(ADDED_TINT))
    .when(r.kind === "del", (el) => el.bg(REMOVED_TINT))
    .child(div().w(40).flex_none().pr(6).text_right().text_color(t.muted).child(num(r.old)))
    .child(div().w(40).flex_none().pr(6).text_right().text_color(t.muted).child(num(r.new)))
    .child(div().w(14).flex_none().text_color(t.muted).child(sign))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_color(r.kind === "cut" ? t.muted : t.foreground)
        .child(r.kind === "cut" ? `Line too large to show (${size(r.bytes ?? 0)})` : r.text),
    );
}
