// The box under the chat: Enter sends, Shift-Enter adds a line. Adapted from Flockbook's
// herdr-app/mods/flockbook/composer.js (MIT, see THIRD_PARTY_NOTICES.md): files, paste and the status tags dropped.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextareaState } from "gpui-base";
import { READ_W } from "./estimate.js";
import { spinner } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

const SEND_ICON = "mods/bw-chat/icons/send.svg";

/**
 * Enter puts a new line at the cursor before the box reports the submit. When `now` is `before` with
 * one span turned into "\n", the text to send is `before`; anything else is sent as it is.
 * @param {string} now @param {string | undefined} before
 */
export function withoutEnter(now, before) {
  if (typeof before !== "string" || now === before) return now;
  let i = 0;
  while (i < now.length && i < before.length && now[i] === before[i]) i++;
  let j = 0;
  while (j < now.length - i && j < before.length - i && now[now.length - 1 - j] === before[before.length - 1 - j]) j++;
  return now.slice(i, now.length - j) === "\n" ? before : now;
}

/**
 * @typedef {object} ComposerView what the chat tells the box on each render
 * @property {boolean} disabled
 * @property {string | null} reason shown in the box while disabled
 * @property {boolean} sending
 * @property {{ text: string, bad: boolean } | null} note the last send's result
 */

export class Composer {
  /**
   * Made in `init`: retained text state cannot be made while drawing.
   * @param {{ placeholder: string, onSend: (text: string, cx: any) => void }} opts
   */
  constructor({ placeholder, onSend }) {
    this.input = TextareaState.new({ placeholder, rows: 1 });
    this.input.set_auto_grow(1, 8);
    this.onSend = onSend;
    this.blocked = true;
    /** The box holds the keyboard: its border turns Mauve. */
    this.focused = false;
    this.input.on("focus", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      this.focused = true;
      cx.notify();
    });
    this.input.on("blur", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      this.focused = false;
      cx.notify();
    });
    // The last two texts the box reported, so a submit knows the text before Enter's new line (the box
    // reports that line's change before or after the submit).
    /** @type {[string, string]} */
    this.typed = ["", ""];
    this.input.on("change", () => {
      const v = this.input.value();
      if (v !== this.typed[1]) this.typed = [this.typed[1], v];
    });
    // On Shift-Enter the box puts the new line in itself; the submit only reports it.
    this.input.on("submit", (/** @type {any} */ e, /** @type {any} */ cx) => {
      if (e?.shift) return;
      const now = this.input.value();
      this.send(withoutEnter(now, now === this.typed[1] ? this.typed[0] : this.typed[1]), cx);
    });
  }

  /** @param {string} raw @param {any} cx */
  send(raw, cx) {
    const text = raw.replace(/\s+$/, "");
    this.setText(text);
    if (this.blocked || !text.trim()) return;
    this.onSend(text, cx);
  }

  /** @param {string} v */
  setText(v) {
    this.input.set_value(v);
    this.typed = [v, v];
  }

  clear() {
    this.setText("");
  }
  focus() {
    this.input.focus();
  }

  /** @param {Theme} t themeColors() @param {ComposerView} v */
  render(t, v) {
    this.blocked = v.disabled;
    const live = !v.disabled;
    return v_flex()
      .id("composer")
      .w_full()
      .flex_none()
      .px(16)
      .pb(14)
      .pt(6)
      .gap(6)
      .items_center()
      .child(
        v_flex()
          .id("box")
          .w_full()
          .max_w(READ_W)
          .rounded(16)
          .bg(t.chrome)
          .border(1)
          .border_color(this.focused && live ? t.accent : t.raised)
          .px(12)
          .pt(10)
          .pb(8)
          .gap(6)
          .when(v.disabled, (el) => el.opacity(0.6))
          .child(Textarea.new(this.input).w_full().disabled(v.disabled))
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12)
                  .text_color(t.muted)
                  .child(v.disabled && v.reason ? v.reason : ""),
              )
              .child(
                div()
                  .id("send")
                  .size(28)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(14)
                  .bg(live ? t.accent : t.raised)
                  .text_color(live ? t.accent_foreground : t.dim)
                  .disabled(v.disabled)
                  .when(live, (el) =>
                    el
                      .cursor_pointer()
                      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) =>
                        this.send(this.input.value(), cx),
                      ),
                  )
                  .when(live, (el) => el.hover((s) => s.opacity(0.9)))
                  .child(v.sending ? spinner(t, 13) : svg(SEND_ICON).size(14)),
              ),
          ),
      )
      .when(Boolean(v.note), (el) =>
        el.child(
          div()
            .id("send-note")
            .w_full()
            .max_w(READ_W)
            .text_size(12)
            .text_color(v.note?.bad ? t.blocked : t.muted)
            .child(v.note?.text ?? ""),
        ),
      );
  }
}
