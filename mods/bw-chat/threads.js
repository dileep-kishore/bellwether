// The threads card floating over the timeline, its folded pill, the header's threads button and the bar
// that replaces the composer in a sub-agent's view. Draws threads-model.js rows; decides nothing.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { icon } from "./timeline.js";
import { statusIcon } from "./ui.js";

/** @typedef {import("./threads-model.js").Row} Row */

export const CARD_W = 312;
const ROW_H = 28;
const INDENT = 16;
const EDGE = 12;

/** @type {Record<Row["state"], "working" | "done" | "blocked">} */
const GLYPH = { running: "working", done: "done", asks: "blocked" };

/** @param {Row} row */
export const rowId = (row) => (row.kind === "parent" ? "row-parent" : `row-${row.kind}-${row.id}`);

/**
 * @param {Row} row @param {Record<string, string>} t @param {boolean} current the view shows this row
 * @param {(row: Row, cx: any) => void} onRow
 */
function threadRow(row, t, current, onRow) {
  return h_flex().id(rowId(row)).h(ROW_H).w_full().flex_none().pl(8 + INDENT * row.depth).pr(8).gap(6).items_center()
    .rounded(6).cursor_pointer().when(current, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onRow(row, cx))
    .child(statusIcon(t, GLYPH[row.state], 12))
    .child(div().flex_none().text_size(13).text_color(t.foreground).child(row.type))
    .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(row.description))
    .when(Boolean(row.since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(row.since)))
    .when(row.requests > 0, (el) => el.child(div().id(`badge-${row.id}`).flex_none().h(16).px(5).flex().items_center().rounded(8)
      .bg(t.blocked).text_size(11).text_color(t.background).child(String(row.requests))));
}

/**
 * The card at the timeline's top right, at most half the pane's height and scrolling.
 * @param {Row[]} rows @param {{ t: Record<string, string>, current: string | null, onRow: (row: Row, cx: any) => void }} o
 *   `current` is the row id the view shows; null for the parent
 */
export function threadsCard(rows, o) {
  const { t } = o;
  return v_flex().id("threads-card").absolute().top(EDGE).right(EDGE).w(CARD_W).max_h("50%").p(4).gap(0)
    .rounded(8).bg(t.raised).border(1).border_color(t.border).shadow_md().overflow_y_scrollbar()
    .children(rows.map((r) => threadRow(r, t, (o.current ?? null) === (r.kind === "parent" ? null : r.id), o.onRow)));
}

/** The folded card. @param {string} text pillText(rows) @param {Record<string, string>} t @param {(cx: any) => void} onClick */
export function threadsPill(text, t, onClick) {
  return h_flex().id("threads-pill").absolute().top(EDGE).right(EDGE).h(26).px(10).gap(6).items_center().rounded(13)
    .bg(t.raised).border(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover)).text_size(12).text_color(t.muted)
    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onClick(cx))
    .child(text);
}

/** The header button with the sub-agent count. @param {number} count @param {Record<string, string>} t @param {(cx: any) => void} onClick */
export function threadsButton(count, t, onClick) {
  return h_flex().id("threads-button").h(24).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
    .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onClick(cx))
    .child(svg(icon("threads")).size(14).flex_none()).child(String(count));
}

/**
 * The 44 px bar of a sub-agent's view: "Explore · sub-agent of Claude · running · Back to Claude".
 * @param {string} text barText(row, parentName) @param {string} parentName @param {Record<string, string>} t
 * @param {(cx: any) => void} onBack
 */
export function subagentBar(text, parentName, t, onBack) {
  return h_flex().id("subagent-bar").h(44).w_full().flex_none().px(16).gap(6).items_center().justify_center().border_t(1).border_color(t.border)
    .child(div().min_w(0).truncate().text_size(13).text_color(t.muted).child(text))
    .child(div().flex_none().text_size(13).text_color(t.dim).child("·"))
    .child(h_flex().id("back").h(26).px(8).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onBack(cx))
      .child(svg(icon("back")).size(14).flex_none()).child(`Back to ${parentName}`));
}
