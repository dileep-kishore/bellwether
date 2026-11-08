// The Linear issues attached to this chat's composer: one chip each, a preview card while the pointer is on
// a chip, and the Trim or As file choice a description over 8 KB needs before Send.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { needsChoice, sizeText, TEXT_LIMIT } from "./linear-attach.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./linear-attach.js").Chip} Chip */

const ISSUE_ICON = "mods/bw-chat/icons/issue.svg";
const CLOSE_ICON = "mods/bw-chat/icons/close.svg";

/**
 * @typedef {object} ChipHandlers
 * @property {(id: string, on: boolean, cx: any) => void} hover
 * @property {(id: string, cx: any) => void} remove
 * @property {(id: string, mode: "trim" | "file", cx: any) => void} mode
 */

/**
 * The chips row, the hovered chip's preview, and a choice row per long description; null with no chips.
 * @param {Theme} t @param {Chip[]} chips @param {string | null} hovered @param {ChipHandlers} on
 */
export function chipsView(t, chips, hovered, on) {
  if (!chips.length) return null;
  const box = v_flex().id("chips").w_full().gap(6);
  const shown = chips.find((c) => c.identifier === hovered) ?? null;
  if (shown) box.child(preview(t, shown));
  box.child(
    h_flex()
      .id("chips-row")
      .w_full()
      .flex_wrap()
      .gap(6)
      .children(chips.map((c) => chip(t, c, on))),
  );
  for (const c of chips.filter((c) => c.bytes > TEXT_LIMIT)) box.child(choice(t, c, on));
  return box;
}

/** @param {Theme} t @param {Chip} c @param {ChipHandlers} on */
function chip(t, c, on) {
  const id = c.identifier;
  return h_flex()
    .id(`chip-${id}`)
    .h(24)
    .max_w(260)
    .pl(8)
    .pr(4)
    .gap(6)
    .items_center()
    .rounded(12)
    .bg(t.raised)
    .border(1)
    .border_color(needsChoice(c) ? t.blocked : t.border)
    .text_size(12)
    .on_hover((/** @type {boolean} */ over, /** @type {any} */ cx) => on.hover(id, over, cx))
    .child(svg(ISSUE_ICON).size(12).flex_none().text_color(t.accent))
    .child(div().flex_none().font_medium().child(id))
    .child(div().min_w(0).truncate().text_color(t.muted).child(c.title))
    .child(
      div()
        .id(`chip-x-${id}`)
        .size(18)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(9)
        .cursor_pointer()
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => on.remove(id, cx))
        .child(svg(CLOSE_ICON).size(10)),
    );
}

/** @param {Theme} t @param {Chip} c */
function preview(t, c) {
  return v_flex()
    .id("chip-preview")
    .w_full()
    .p(10)
    .gap(4)
    .rounded(10)
    .bg(t.raised)
    .border(1)
    .border_color(t.border)
    .text_size(12)
    .child(
      h_flex()
        .gap(6)
        .text_color(t.muted)
        .child(div().font_medium().text_color(t.foreground).child(c.identifier))
        .child(div().child(c.state))
        .child(div().child(sizeText(c.bytes))),
    )
    .child(div().font_medium().child(c.title))
    .when(Boolean(c.preview), (el) =>
      el.child(
        div()
          .text_color(t.muted)
          .max_h(64)
          .overflow_hidden()
          .child(c.preview.length >= 400 ? `${c.preview}…` : c.preview),
      ),
    )
    .child(div().text_color(t.muted).truncate().child(c.url));
}

/** @param {Theme} t @param {Chip} c @param {ChipHandlers} on */
function choice(t, c, on) {
  const pick = (/** @type {"trim" | "file"} */ mode, /** @type {string} */ label) => {
    const sel = c.mode === mode;
    return h_flex()
      .id(`chip-${mode}-${c.identifier}`)
      .h(22)
      .px(8)
      .items_center()
      .rounded(11)
      .cursor_pointer()
      .text_size(11.5)
      .bg(sel ? t.selected : t.raised)
      .text_color(sel ? t.foreground : t.muted)
      .when(!sel, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => on.mode(c.identifier, mode, cx))
      .child(label);
  };
  return h_flex()
    .id(`chip-choice-${c.identifier}`)
    .w_full()
    .gap(6)
    .items_center()
    .flex_wrap()
    .text_size(11.5)
    .child(
      div()
        .text_color(c.mode ? t.muted : t.blocked)
        .child(`${c.identifier}'s description is ${sizeText(c.bytes)}, over 8 KB:`),
    )
    .child(pick("trim", "Trim to 8 KB"))
    .child(pick("file", "Send as a file"));
}
