// The request dock above the composer: hooks notices on top, then one card per request, newest last.
// Draws dock-model.js cards and question drafts; the chat decides what a click does.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { READ_W } from "./estimate.js";
import { icon } from "./timeline.js";
import { ICONS, MOTION, appear, button } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

/** @typedef {import("./dock-model.js").Card} Card */
/** @typedef {import("./dock-model.js").Button} Button */
/** @typedef {import("./dock-model.js").Draft} Draft */

/**
 * @typedef {object} NoticeButton
 * @property {string} id
 * @property {string} label
 * @property {boolean} [primary]
 * @property {boolean} [enabled] absent counts as enabled
 */

/**
 * @typedef {object} Notice A line at the dock's top (hooks not set up, Codex hook not trusted).
 * @property {string} text
 * @property {string} [step] how to fix it
 * @property {{ path: string, diff: string }[]} [diff] `bw machine setup --diff`'s files, once read
 * @property {string} [message] the last Review or Apply result
 * @property {NoticeButton[]} buttons
 */

/**
 * @typedef {object} DockHandlers
 * @property {(card: Card, button: string, cx: any) => void} onButton
 * @property {(card: Card, step: number, index: number, cx: any) => void} onOption
 * @property {(card: Card, step: number, cx: any) => void} onStep
 * @property {(card: Card, event: any, cx: any) => void} onKey
 * @property {(button: string, cx: any) => void} onNotice
 * @property {(id: string, cx: any) => void} onShown a card was laid out for the first time
 */

/**
 * @typedef {object} DockView
 * @property {Theme} t themeColors()
 * @property {Card[]} cards
 * @property {Notice | null} notice
 * @property {(card: Card) => Draft} draftOf
 * @property {string | null} active the question card that holds the keyboard and the Other field
 * @property {any} focus the FocusHandle the active card tracks
 * @property {any} other the InputState of the active card's Other field
 * @property {Map<string, string>} notes `bw answer` results by request id
 * @property {Set<string>} shown cards laid out once, which fade in
 */

const MONO = "Menlo";

/**
 * A card's button: primary is Mauve, the rest Surface 0. A disabled one still reports its click,
 * so the chat's own check (focus guard, sending) is what refuses it.
 * @param {string} id @param {string} label @param {boolean} enabled @param {boolean} primary @param {Theme} t
 * @param {(cx: any) => void} act
 */
function pushButton(id, label, enabled, primary, t, act) {
  return button(t, { id, label, kind: primary ? "primary" : "secondary", enabled, on: "raised" }).on_click(
    (/** @type {unknown} */ _e, /** @type {any} */ cx) => act(cx),
  );
}

/** @param {any} q */
const isMulti = (q) => Boolean(q?.multi ?? q?.multi_select ?? q?.multiSelect);

/**
 * @param {Card} c @param {DockView} v @param {DockHandlers} h @returns {any}
 */
function questionBody(c, v, h) {
  const { t } = v;
  const qs = Array.isArray(c.question?.questions) ? c.question.questions : [];
  if (!qs.length) return null;
  const d = v.draftOf(c);
  const step = Math.min(d.step, qs.length - 1);
  const q = qs[step];
  const options = Array.isArray(q?.options) ? q.options : [];
  const active = v.active === c.id;
  const pending = c.state === "pending";
  const multi = isMulti(q);
  const picked = d.picks[step] ?? [];
  const keys = v_flex()
    .id(`qkeys-${c.id}`)
    .w_full()
    .gap(2)
    .when(active, (el) =>
      el.track_focus(v.focus).on_key_down((/** @type {any} */ e, /** @type {any} */ cx) => h.onKey(c, e, cx)),
    )
    .child(
      div()
        .w_full()
        .text_size(13)
        .text_color(t.foreground)
        .whitespace_normal()
        .child(String(q?.text ?? q?.question ?? "")),
    )
    .children(
      options.map((/** @type {any} */ o, /** @type {number} */ i) => {
        const on = picked.includes(i);
        const glyph = multi
          ? div()
              .size(14)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(3)
              .border(1)
              // Overlay 2 keeps an empty box at 3:1 on the Surface 0 card; Surface 1 would be 1.4:1.
              .border_color(on ? t.accent : t.dim)
              .when(on, (el) => el.bg(t.accent).child(svg(ICONS.check).size(10).text_color(t.background)))
          : div()
              .size(14)
              .flex_none()
              .rounded(7)
              .border(on ? 4 : 1)
              .border_color(on ? t.accent : t.dim);
        return h_flex()
          .id(`qopt-${c.id}-${step}-${i}`)
          .w_full()
          .min_h(28)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(8)
          .when(on, (el) => el.bg(t.hover))
          .when(pending, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onOption(c, step, i, cx)),
          )
          .child(
            div()
              .w(12)
              .flex_none()
              .text_size(11)
              .text_color(t.muted)
              .child(i < 9 ? String(i + 1) : ""),
          )
          .child(glyph)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(
                div()
                  .text_size(13)
                  .text_color(t.foreground)
                  .whitespace_normal()
                  .child(String(o?.label ?? "")),
              )
              .when(Boolean(o?.description), (el) =>
                el.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(String(o.description))),
              ),
          );
      }),
    );
  return v_flex()
    .w_full()
    .gap(6)
    .when(qs.length > 1, (el) =>
      el.child(
        h_flex()
          .gap(4)
          .flex_wrap()
          .children(
            qs.map((/** @type {any} */ x, /** @type {number} */ i) =>
              div()
                .id(`qstep-${c.id}-${i}`)
                .h(24)
                .px(8)
                .flex()
                .items_center()
                .rounded(8)
                .text_size(12)
                .cursor_pointer()
                .when(i === step, (s) => s.bg(t.hover).text_color(t.foreground))
                .when(i !== step, (s) => s.text_color(t.muted).hover((x) => x.bg(t.hover)))
                .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onStep(c, i, cx))
                .child(String(x?.header || `Question ${i + 1}`)),
            ),
          ),
      ),
    )
    .child(keys)
    .when(active && pending, (el) =>
      el.child(
        Input.new(v.other)
          .id(`qother-${c.id}`)
          .w_full()
          .h(30)
          .px(10)
          .items_center()
          .rounded(8)
          .border(1)
          .border_color(t.input)
          .bg(t.chrome)
          .text_size(13)
          .text_color(t.foreground),
      ),
    );
}

/** @param {Card} c @param {DockView} v @param {DockHandlers} h */
function card(c, v, h) {
  const { t } = v;
  const pending = c.state === "pending" || c.state === "sending";
  const glyph = c.kind === "approval" ? icon("approval") : icon("question");
  const note = (c.state === "pending" && v.notes.get(c.id)) || c.note;
  const command = c.command.trim();
  const tool = c.kind === "approval" ? c.tool.trim() : "";
  const detail = c.detail.trim() && c.detail.trim() !== command ? c.detail.trim() : "";
  // Approval asks in Peach, a question in Blue; an answered card's check fades in over the icon.
  const answered = c.state === "answered";
  const hue = c.kind === "approval" ? t.blocked : t.working;
  const mark = div()
    .id(`card-icon-${c.id}`)
    .relative()
    .size(24)
    .flex_none()
    .rounded(8)
    .bg(t.chrome)
    .flex()
    .items_center()
    .justify_center()
    .child(
      svg(glyph)
        .id(`card-glyph-${c.id}`)
        .size(14)
        .text_color(pending ? hue : t.dim)
        .opacity(answered ? 0 : 1)
        .transition("opacity", MOTION.fade),
    )
    .child(
      svg(ICONS.check)
        .id(`card-done-${c.id}`)
        .absolute()
        .top(5)
        .left(5)
        .size(14)
        .text_color(t.done)
        .opacity(answered ? 1 : 0)
        .transition("opacity", MOTION.fade),
    );
  return appear(
    v_flex()
      .id(`card-${c.id}`)
      .w_full()
      .flex_none()
      .rounded(12)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .shadow_sm()
      .px(16)
      .py(12)
      .gap(8)
      .on_size_change((/** @type {unknown} */ _s, /** @type {any} */ cx) => {
        if (!v.shown.has(c.id)) h.onShown(c.id, cx);
      }),
    v.shown.has(c.id),
  )
    .child(
      h_flex()
        .w_full()
        .gap(8)
        .items_center()
        .child(mark)
        .child(
          div()
            .flex_1()
            .min_w(0)
            .max_h(36)
            .overflow_hidden()
            .whitespace_normal()
            .text_size(13)
            .font_semibold()
            .text_color(t.foreground)
            .child(c.title),
        ),
    )
    .when(Boolean(command || tool), (el) =>
      el.child(
        v_flex()
          .id(`cmd-${c.id}`)
          .w_full()
          .max_h(288)
          .overflow_y_scrollbar()
          .rounded(8)
          .bg(t.chrome)
          .px(10)
          .py(8)
          .gap(4)
          .font_family(MONO)
          .text_size(12)
          .text_color(t.foreground)
          .whitespace_normal()
          .when(Boolean(tool), (b) => b.child(div().id(`tool-${c.id}`).text_size(11.5).text_color(t.muted).child(tool)))
          .when(Boolean(command), (b) => b.child(div().w_full().child(command))),
      ),
    )
    .when(Boolean(detail), (el) =>
      el.child(div().w_full().text_size(12).text_color(t.muted).whitespace_normal().child(detail)),
    )
    .map((el) => {
      const body = c.kind === "question" || c.kind === "question_async" ? questionBody(c, v, h) : null;
      return body ? el.child(body) : el;
    })
    .when(Boolean(note), (el) =>
      el.child(
        div()
          .id(`card-note-${c.id}`)
          .w_full()
          .text_size(12)
          .whitespace_normal()
          .text_color(c.state === "stale" || c.state === "uncertain" ? t.blocked : t.muted)
          .child(String(note)),
      ),
    )
    .when(c.buttons.length > 0, (el) =>
      el.child(
        h_flex()
          .w_full()
          .gap(8)
          .flex_wrap()
          .children(
            c.buttons.map((b) =>
              pushButton(`answer-${c.id}-${b.id}`, b.label, b.enabled, b.primary, t, (cx) => h.onButton(c, b.id, cx)),
            ),
          ),
      ),
    );
}

/** @param {Notice} n @param {Theme} t @param {DockHandlers} h */
function notice(n, t, h) {
  return v_flex()
    .id("hooks-notice")
    .w_full()
    .flex_none()
    .rounded(12)
    .bg(t.raised)
    .border(1)
    .border_color(t.border)
    .px(16)
    .py(10)
    .gap(8)
    .child(div().w_full().text_size(13).text_color(t.foreground).whitespace_normal().child(n.text))
    .when(Boolean(n.step), (el) =>
      el.child(div().w_full().text_size(12).text_color(t.muted).whitespace_normal().child(String(n.step))),
    )
    .when(Boolean(n.diff?.length), (el) =>
      el.child(
        v_flex()
          .id("hooks-diff")
          .w_full()
          .max_h(288)
          .overflow_y_scrollbar()
          .rounded(8)
          .bg(t.chrome)
          .px(10)
          .py(8)
          .gap(6)
          .font_family(MONO)
          .text_size(11.5)
          .text_color(t.foreground)
          .children(
            (n.diff ?? []).map((f) =>
              v_flex()
                .w_full()
                .child(div().text_color(t.muted).child(f.path))
                .child(
                  div()
                    .whitespace_normal()
                    .child(f.diff || "No change"),
                ),
            ),
          ),
      ),
    )
    .when(Boolean(n.message), (el) =>
      el.child(div().w_full().text_size(12).text_color(t.muted).whitespace_normal().child(String(n.message))),
    )
    .when(n.buttons.length > 0, (el) =>
      el.child(
        h_flex()
          .w_full()
          .gap(8)
          .flex_wrap()
          .children(
            n.buttons.map((b) =>
              pushButton(b.id, b.label, b.enabled !== false, Boolean(b.primary), t, (cx) => h.onNotice(b.id, cx)),
            ),
          ),
      ),
    );
}

/**
 * The dock, at most 45 % of the pane and scrolling; null when it has nothing to show.
 * @param {DockView} v @param {DockHandlers} h
 */
export function dock(v, h) {
  if (!v.cards.length && !v.notice) return null;
  return v_flex()
    .id("dock")
    .w_full()
    .flex_none()
    .max_h("45%")
    .overflow_y_scrollbar()
    .px(16)
    .pt(8)
    .gap(8)
    .items_center()
    .child(
      v_flex()
        .w_full()
        .max_w(READ_W)
        .gap(8)
        .when(Boolean(v.notice), (el) => el.child(notice(/** @type {Notice} */ (v.notice), v.t, h)))
        .children(v.cards.map((c) => card(c, v, h))),
    );
}
