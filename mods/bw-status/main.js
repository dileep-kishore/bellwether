// The status bar under the active tab: the shown space's machine and branch, how many agents run and
// how many need the person, and the command palette's key. Written for Bellwether.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, keys, run, spaces, window } from "herdr";
import { ICONS, MOTION, pill, statusMark, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {"working" | "blocked" | "done" | "idle"} Status */

/** @type {Status[]} */
const URGENCY = ["blocked", "done", "working", "idle"];

/** The most urgent status in a list, as Herdr ranks them, or null for none. @param {unknown[]} list */
export function mostUrgent(list) {
  return URGENCY.find((s) => list.includes(s)) ?? null;
}

/**
 * The command palette's binding as the person reads it ("⌘⇧P"), or null when nothing binds it.
 * @param {{ section: string, keys: string, action: string }[]} bindings @param {boolean} mac
 */
export function paletteKey(bindings, mac) {
  const b = bindings.find((k) => k.section === "global" && k.action === "app.palette");
  if (!b) return null;
  /** @type {Record<string, string>} */
  const names = mac
    ? { cmd: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥", option: "⌥" }
    : { cmd: "Ctrl+", ctrl: "Ctrl+", shift: "Shift+", alt: "Alt+", option: "Alt+" };
  // "cmd--" binds the minus key: the last part is the key itself.
  const parts = b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b.keys.split("-");
  return parts.map((p) => names[p.toLowerCase()] ?? p.toUpperCase()).join("");
}

export default class StatusBar extends View {
  render() {
    const t = themeColors();
    const space = spaces().find((s) => s.active) ?? null;
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const urgent = mostUrgent(list.map((a) => a.status));
    const mac = window()?.platform === "macos";
    const key = paletteKey(keys(), mac);
    const machine = space?.machine ?? null;
    const item = (/** @type {string} */ icon, /** @type {string} */ text) =>
      h_flex()
        .flex_none()
        .min_w(0)
        .gap(6)
        .items_center()
        .child(svg(icon).size(13).flex_none().text_color(t.dim))
        .child(div().min_w(0).truncate().child(text));
    return h_flex()
      .id("bw-status")
      .size_full()
      .px(14)
      .gap(14)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .text_color(t.muted)
      .child(item(machine ? ICONS.server : ICONS.monitor, machine ?? (mac ? "This Mac" : "This computer")))
      .when(Boolean(space?.branch), (el) => el.child(item(ICONS.branch, String(space?.branch))))
      .child(
        h_flex()
          .flex_none()
          .gap(6)
          .items_center()
          .child(statusMark(t, urgent ?? "idle", 12, "status-agents"))
          .child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`),
      )
      .when(needs > 0, (el) =>
        el.child(pill(t, `${needs} needs you`, "request", "status-needs").loop("opacity", MOTION.breathe)),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .id("status-palette")
          .flex_none()
          .h(20)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(10)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("app.palette"))
          .when(key !== null, (el) =>
            el.child(
              div()
                .text_color(t.foreground)
                .child(/** @type {string} */ (key)),
            ),
          )
          .child("commands"),
      );
  }
}
