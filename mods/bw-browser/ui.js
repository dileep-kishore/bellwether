// Small drawing pieces every Bellwether mod shares: icons, status marks, pills, chips, monogram tiles,
// cards and buttons, in Catppuccin Mocha shapes. Colours come from theme() roles, or palette.js where
// Herdr has no role.
import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";
import { MUTED_ON_SELECTED, MOCHA, TILE_HUES, mix } from "./palette.js";

/** @typedef {import("gpui-kit").Color} Color */
/** Theme colours by name, as `themeColors()` returns them. @typedef {Record<string, Color>} Theme */

/** Herdr's `theme()`, typed as the `#rrggbb` colours it returns; herdr.d.ts declares them as plain strings. */
export const themeColors = () => /** @type {Theme} */ (theme());

/** @typedef {"working" | "blocked" | "done" | "idle"} Status */
/** @typedef {{ icon?: string | null, tint?: boolean } | null | undefined} ProgramLike */

const NAMES = [
  "ring",
  "ring-spin",
  "check",
  "question",
  "plus",
  "close",
  "branch",
  "server",
  "monitor",
  "chevron-right",
  "chevron-down",
  "more",
  "terminal",
];

/** Paths of Bellwether's own SVGs, as svg() takes them. @type {Readonly<Record<string, string>>} */
export const ICONS = Object.freeze(Object.fromEntries(NAMES.map((n) => [n, `mods/bw-projects/icons/${n}.svg`])));

/** How each status moves; idle and done are still once settled. */
export const MOTION = Object.freeze({
  spin: 900,
  breathe: Object.freeze({ from: 0.65, to: 1, period: 1400 }),
  fade: 180,
  appear: 140,
  hover: 120,
});

/** Secondary text on a Surface 1 fill (selected rows, the active tab), where `muted` falls under 4.5:1. */
export const mutedOnSelected = /** @type {Color} */ (MUTED_ON_SELECTED);

/** A Surface 0 fill under the pointer: the hover tint composited, so it lightens rather than replaces. */
export const raisedHover = /** @type {Color} */ (mix(MOCHA.text, MOCHA.surface0, 0x14 / 255));

/** @param {unknown} status @returns {status is Status} */
const isStatus = (status) => status === "working" || status === "blocked" || status === "done" || status === "idle";

/**
 * An agent's state, drawn the same everywhere: working is a Blue arc that spins, blocked a Peach
 * question mark that breathes, done a Green check, idle a still ring. Anything else draws an empty
 * box so rows stay aligned. With `id`, the check stays mounted under it and fades in when the
 * status turns done; without one it simply appears.
 * @param {Theme} t themeColors()
 * @param {Status | null | undefined} status
 * @param {number} [size]
 * @param {string | null} [id] stable across renders, unique in the mod
 */
export function statusMark(t, status, size = 12, id = null) {
  if (!isStatus(status)) return div().size(size).flex_none();
  if (id === null) return glyph(t, status, size);
  const done = status === "done";
  const box = div().id(id).relative().size(size).flex_none();
  return box
    .when(!done, (el) => el.child(glyph(t, status, size)))
    .child(
      svg(ICONS.check)
        .id(`${id}-done`)
        .absolute()
        .top(0)
        .left(0)
        .size(size)
        .text_color(t.done)
        .opacity(done ? 1 : 0)
        .transition("opacity", MOTION.fade),
    );
}

/** @param {Theme} t @param {Status} status @param {number} size */
function glyph(t, status, size) {
  if (status === "working")
    return svg(ICONS["ring-spin"]).size(size).flex_none().text_color(t.working).spin(MOTION.spin);
  if (status === "blocked")
    return svg(ICONS.question).size(size).flex_none().text_color(t.blocked).loop("opacity", MOTION.breathe);
  if (status === "done") return svg(ICONS.check).size(size).flex_none().text_color(t.done);
  return svg(ICONS.ring).size(size).flex_none().text_color(t.idle);
}

/** The earlier name of statusMark, without the fading check. */
export const statusIcon = (/** @type {Theme} */ t, /** @type {Status | null | undefined} */ status, size = 12) =>
  statusMark(t, status, size);

/** A spinning Mauve arc: preparing, sending, settling. @param {Theme} t @param {number} [size] */
export const spinner = (t, size = 12) =>
  svg(ICONS["ring-spin"]).size(size).flex_none().text_color(t.accent).spin(MOTION.spin);

/**
 * A program's icon from Herdr's table: a one-colour glyph is tinted, a picture drawn as is.
 * @param {ProgramLike} program
 * @param {Theme} t themeColors()
 * @param {number} [size]
 */
export function programIcon(program, t, size = 14) {
  if (!program?.icon) return svg(ICONS.terminal).size(size).flex_none().text_color(t.muted);
  if (program.tint) return svg(program.icon).size(size).flex_none().text_color(t.muted);
  return image(program.icon).w(size).h(size).flex_none();
}

/** @typedef {"request" | "count" | "machine" | "accent" | "working" | "blocked" | "failed" | "done"} PillTone */

/**
 * A fully rounded label for counts and badges.
 * @param {Theme} t themeColors()
 * @param {string} text
 * @param {PillTone} [tone]
 * @param {string | null} [id]
 */
export function pill(t, text, tone = "count", id = null) {
  /** @type {Record<PillTone, [Color, Color]>} */
  const tones = {
    request: [t.blocked, t.accent_foreground],
    count: [t.selected, t.foreground],
    machine: [t.raised, t.muted],
    accent: [t.accent, t.accent_foreground],
    working: [t.working, t.accent_foreground],
    blocked: [t.blocked, t.accent_foreground],
    failed: [/** @type {Color} */ (MOCHA.red), t.accent_foreground],
    done: [t.done, t.accent_foreground],
  };
  const [bg, fg] = tones[tone];
  return h_flex()
    .when(id !== null, (el) => el.id(/** @type {string} */ (id)))
    .flex_none()
    .h(18)
    .px(7)
    .items_center()
    .rounded(9)
    .bg(bg)
    .text_color(fg)
    .text_size(11)
    .font_medium()
    .child(text);
}

/**
 * The name of a space's machine as a small pill.
 * @param {string} name
 * @param {Theme} t themeColors()
 */
export function machineTag(name, t) {
  return pill(t, name, "machine");
}

/**
 * A 28 px fully rounded control with an icon and label on Surface 0. Inside a virtual list pass
 * no handlers: the hover is a plain style swap.
 * @param {Theme} t themeColors()
 * @param {{ id?: string, icon?: any, label: string, color?: Color }} o
 */
export function chip(t, o) {
  return h_flex()
    .when(Boolean(o.id), (el) => el.id(/** @type {string} */ (o.id)))
    .flex_none()
    .h(28)
    .px(10)
    .gap(6)
    .items_center()
    .rounded(14)
    .bg(t.raised)
    .text_size(12.5)
    .text_color(o.color ?? t.muted)
    .hover((s) => s.bg(raisedHover))
    .when(Boolean(o.icon), (el) => el.child(o.icon))
    .child(div().min_w(0).truncate().child(o.label));
}

/** A stable hue per key, so a tile keeps its colour as projects come and go. @param {string} key */
export function tileHue(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return /** @type {Color} */ (TILE_HUES[h % TILE_HUES.length]);
}

/**
 * A rounded square with one or two letters in Crust on a Catppuccin accent.
 * @param {Theme} t themeColors() @param {string} key @param {string} letters @param {number} [size]
 */
export function monogram(t, key, letters, size = 20) {
  return div()
    .size(size)
    .flex_none()
    .rounded(Math.round(size * 0.3))
    .bg(tileHue(key))
    .text_color(t.accent_foreground)
    .text_size(Math.round(size * 0.55))
    .font_semibold()
    .flex()
    .items_center()
    .justify_center()
    .child(letters);
}

/**
 * Fades an element in (and slides it up 6 px) when `shown` turns true. Draw it first with
 * `shown` false and set it true on the element's first `on_size_change`: a transition animates only
 * a later change of its target.
 * @template {any} E @param {E} el needs a stable id @param {boolean} shown
 * @returns {E}
 */
export function appear(el, shown) {
  return /** @type {any} */ (el)
    .relative()
    .opacity(shown ? 1 : 0)
    .transition("opacity", MOTION.appear)
    .top(shown ? 0 : 6)
    .transition("top", MOTION.appear);
}

/**
 * A rounded card: Surface 0 (or Mantle) fill, 12 px corners, a 1 px Surface 1 border and a shadow.
 * @param {Theme} t themeColors() @param {string} id @param {{ fill?: "raised" | "chrome" | "popover" }} [o]
 */
export function card(t, id, o = {}) {
  return div()
    .id(id)
    .flex()
    .flex_col()
    .rounded(12)
    .bg(t[o.fill ?? "raised"])
    .border(1)
    .border_color(t.border)
    .shadow_md();
}

/**
 * A row's hover highlight that stays mounted and fades: put it first in a relative row and set
 * `hovered` from the row's `on_hover`.
 * @param {Theme} t themeColors() @param {string} id @param {boolean} hovered @param {number} [radius]
 */
export function hoverFill(t, id, hovered, radius = 8) {
  return div()
    .id(id)
    .absolute()
    .inset_0()
    .rounded(radius)
    .bg(t.hover)
    .opacity(hovered ? 1 : 0)
    .transition("opacity", MOTION.hover);
}

/** @typedef {"primary" | "secondary" | "ghost"} ButtonKind */

/**
 * A button: primary is Mauve with Crust text, secondary Surface 0 with Text, ghost no fill with
 * Subtext 0. Disabled is Surface 0 with Overlay 2 text and no hover, for every kind.
 * @param {Theme} t themeColors()
 * @param {{ id: string, label?: string, icon?: any, kind?: ButtonKind, enabled?: boolean, h?: number,
 *   onClick?: (e: unknown, cx: any) => void }} o
 */
export function button(t, o) {
  const kind = o.kind ?? "secondary";
  const enabled = o.enabled !== false;
  const h = o.h ?? 28;
  const round = !o.label;
  /** @type {[Color | null, Color, Color | null]} fill, text, hover */
  const look = !enabled
    ? [t.raised, t.dim, null]
    : kind === "primary"
      ? [t.solid, t.solid_foreground, /** @type {Color} */ (mix(MOCHA.text, MOCHA.mauve, 0.15))]
      : kind === "secondary"
        ? [t.raised, t.foreground, raisedHover]
        : [null, t.muted, t.hover];
  const [fill, fg, hover] = look;
  return h_flex()
    .id(o.id)
    .flex_none()
    .h(h)
    .when(round, (el) => el.w(h).justify_center())
    .when(!round, (el) => el.px(12))
    .gap(6)
    .items_center()
    .rounded(round ? h / 2 : 8)
    .text_size(12.5)
    .font_medium()
    .text_color(fg)
    .when(fill !== null, (el) => el.bg(/** @type {Color} */ (fill)))
    .disabled(!enabled)
    .when(enabled && hover !== null, (el) => el.cursor_pointer().hover((s) => s.bg(/** @type {Color} */ (hover))))
    .when(enabled && Boolean(o.onClick), (el) => el.on_click(/** @type {any} */ (o.onClick)))
    .when(Boolean(o.icon), (el) => el.child(o.icon))
    .when(Boolean(o.label), (el) => el.child(/** @type {string} */ (o.label)));
}

/**
 * How long ago `ms` was, in the largest whole unit: "now", "5m", "3h", "2d".
 * @param {number} ms
 * @param {number} now
 * @returns {"now" | `${number}m` | `${number}h` | `${number}d`}
 */
export function ago(ms, now) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (!(minutes >= 1)) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
