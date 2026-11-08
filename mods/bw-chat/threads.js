// The threads card floating over the timeline, its folded pill, the header's threads button and the bar
// that replaces the composer in a sub-agent's view. Draws threads-model.js rows; decides nothing.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { icon } from "./timeline.js";
import { hoverFill, mutedOnSelected, pill, statusMark } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

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
 * @param {Row} row @param {Theme} t @param {boolean} current the view shows this row
 * @param {boolean} hovered @param {{ onRow: (row: Row, cx: any) => void, onHover: (id: string, on: boolean, cx: any) => void }} h
 */
function threadRow(row, t, current, hovered, h) {
  const id = rowId(row);
  return h_flex()
    .id(id)
    .relative()
    .h(ROW_H)
    .w_full()
    .flex_none()
    .pl(8 + INDENT * row.depth)
    .pr(8)
    .gap(6)
    .items_center()
    .rounded(8)
    .cursor_pointer()
    .when(current, (el) => el.bg(t.selected))
    .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => h.onHover(id, on, cx))
    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onRow(row, cx))
    .child(hoverFill(t, `hover-${id}`, hovered && !current, 8))
    .when(current, (el) =>
      el.child(div().id(`bar-${id}`).absolute().left(0).top(7).bottom(7).w(2).rounded(1).bg(t.accent)),
    )
    .child(statusMark(t, GLYPH[row.state], 12, `mark-${id}`))
    .child(div().flex_none().text_size(13).text_color(t.foreground).child(row.type))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(13)
        .text_color(current ? mutedOnSelected : t.muted)
        .child(row.description),
    )
    .when(Boolean(row.since), (el) =>
      el.child(
        div()
          .flex_none()
          .text_size(11)
          .text_color(current ? mutedOnSelected : t.muted)
          .child(row.since),
      ),
    )
    .when(row.requests > 0, (el) => el.child(pill(t, String(row.requests), "request", `badge-${row.id}`)));
}

/**
 * The card at the timeline's top right, at most half the pane's height and scrolling.
 * Herdr drops an absolute element's insets when that element scrolls, and a percentage cap collapses
 * the scrolling box, so the card only places itself and an inner box capped in pixels scrolls.
 * @param {Row[]} rows
 * @param {{ t: Theme, current: string | null, onRow: (row: Row, cx: any) => void, paneHeight: number, paneWidth?: number,
 *   hovered?: string | null, onHover?: (id: string, on: boolean, cx: any) => void }} o
 *   `current` is the row id the view shows; null for the parent. `paneHeight` is 0 before the first layout.
 *   `hovered` is the element id of the row under the pointer.
 */
export function threadsCard(rows, o) {
  const { t } = o;
  return v_flex()
    .id("threads-card")
    .absolute()
    .top(EDGE)
    .right(EDGE)
    .w(cardWidth(o.paneWidth ?? 0))
    .rounded(12)
    .bg(t.popover)
    .border(1)
    .border_color(t.border)
    .shadow_md()
    .child(
      v_flex()
        .id("threads-rows")
        .max_h(cardMaxHeight(o.paneHeight))
        .p(4)
        .gap(0)
        .overflow_y_scrollbar()
        .children(
          rows.map((r) =>
            threadRow(r, t, (o.current ?? null) === (r.kind === "parent" ? null : r.id), o.hovered === rowId(r), {
              onRow: o.onRow,
              onHover: o.onHover ?? (() => {}),
            }),
          ),
        ),
    );
}

/** CARD_W, narrowed to keep 12 px on each side in a narrow pane; CARD_W before the pane is measured.
 * @param {number} paneWidth */
export function cardWidth(paneWidth) {
  return paneWidth > 0 ? Math.max(160, Math.min(CARD_W, paneWidth - 2 * EDGE)) : CARD_W;
}

/** Half the pane, or 320 px before the pane has been measured. @param {number} paneHeight */
export function cardMaxHeight(paneHeight) {
  return paneHeight > 0 ? Math.round(paneHeight / 2) : 320;
}

/** The folded card. @param {string} text pillText(rows) @param {Theme} t @param {(cx: any) => void} onClick */
export function threadsPill(text, t, onClick) {
  return h_flex()
    .id("threads-pill")
    .absolute()
    .top(EDGE)
    .right(EDGE)
    .h(28)
    .px(12)
    .gap(6)
    .items_center()
    .rounded(14)
    .bg(t.popover)
    .border(1)
    .border_color(t.border)
    .shadow_sm()
    .cursor_pointer()
    .hover((s) => s.bg(t.raised))
    .text_size(12)
    .text_color(t.muted)
    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onClick(cx))
    .child(text);
}

/** The header button with the sub-agent count. @param {number} count @param {Theme} t @param {(cx: any) => void} onClick */
export function threadsButton(count, t, onClick) {
  return h_flex()
    .id("threads-button")
    .h(24)
    .px(8)
    .gap(6)
    .flex_none()
    .items_center()
    .rounded(12)
    .cursor_pointer()
    .text_size(12)
    .text_color(t.muted)
    .hover((s) => s.bg(t.hover))
    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onClick(cx))
    .child(svg(icon("threads")).size(14).flex_none())
    .child(String(count));
}

/**
 * The 44 px bar of a sub-agent's view: "Explore · sub-agent of Claude · running · Back to Claude".
 * @param {string} text barText(row, parentName) @param {string} parentName @param {Theme} t
 * @param {(cx: any) => void} onBack
 */
export function subagentBar(text, parentName, t, onBack) {
  return h_flex()
    .id("subagent-bar")
    .h(44)
    .w_full()
    .flex_none()
    .px(16)
    .gap(6)
    .items_center()
    .justify_center()
    .border_t(1)
    .border_color(t.border)
    .child(div().min_w(0).truncate().text_size(13).text_color(t.muted).child(text))
    .child(div().flex_none().text_size(13).text_color(t.dim).child("·"))
    .child(
      h_flex()
        .id("back")
        .h(26)
        .px(8)
        .gap(4)
        .flex_none()
        .items_center()
        .rounded(13)
        .cursor_pointer()
        .text_size(13)
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => onBack(cx))
        .child(svg(icon("back")).size(14).flex_none())
        .child(`Back to ${parentName}`),
    );
}
