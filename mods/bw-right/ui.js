// Small drawing pieces every Bellwether mod shares: icons, status glyphs, program icons, ages.
import { div, image, svg } from "gpui-kit";

/** @typedef {"working" | "blocked" | "done" | "idle"} Status */
/** @typedef {{ icon?: string | null, tint?: boolean } | null | undefined} ProgramLike */

const NAMES = ["ring", "ring-spin", "check", "question", "plus", "close", "branch", "server", "monitor", "chevron-right", "chevron-down", "more", "terminal"];

/** Paths of Bellwether's own SVGs, as svg() takes them. @type {Readonly<Record<string, string>>} */
export const ICONS = Object.freeze(Object.fromEntries(NAMES.map((n) => [n, `mods/bw-projects/icons/${n}.svg`])));

/** @type {Record<Status, [icon: string, color: Status]>} */
const STATUS_ICON = { working: ["ring-spin", "working"], blocked: ["question", "blocked"], done: ["check", "done"], idle: ["ring", "idle"] };

/**
 * An agent's state as a theme-coloured glyph; null draws an empty box so rows stay aligned.
 * @param {Record<string, string>} t theme()
 * @param {Status | null | undefined} status
 * @param {number} [size]
 */
export function statusIcon(t, status, size = 12) {
  const s = typeof status === "string" && Object.hasOwn(STATUS_ICON, status) ? STATUS_ICON[/** @type {Status} */ (status)] : null;
  if (!s) return div().size(size).flex_none();
  const el = svg(ICONS[s[0]]).size(size).flex_none().text_color(t[s[1]]);
  return status === "working" ? el.spin(900) : el;
}

/**
 * A program's icon from Herdr's table: a one-colour glyph is tinted, a picture drawn as is.
 * @param {ProgramLike} program
 * @param {Record<string, string>} t theme()
 * @param {number} [size]
 */
export function programIcon(program, t, size = 14) {
  if (!program?.icon) return svg(ICONS.terminal).size(size).flex_none().text_color(t.muted);
  if (program.tint) return svg(program.icon).size(size).flex_none().text_color(t.muted);
  return image(program.icon).w(size).h(size).flex_none();
}

/**
 * The name of a space's machine as a small bordered label.
 * @param {string} name
 * @param {Record<string, string>} t theme()
 */
export function machineTag(name, t) {
  return div().flex_none().text_size(10).text_color(t.dim).border(1).border_color(t.border).rounded(4).px(4).child(name);
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
