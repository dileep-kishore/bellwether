// Catppuccin Mocha, the only colour values in Bellwether's JavaScript. Imports nothing, so mods copy it
// and `bun test` runs it. themes/bellwether.json carries the same values for Herdr; tests/theme.test.js
// keeps the two equal.

/** @typedef {`#${string}`} Hex */

/** The 26 Mocha colours by Catppuccin's names. */
export const MOCHA = Object.freeze({
  rosewater: /** @type {Hex} */ ("#f5e0dc"),
  flamingo: /** @type {Hex} */ ("#f2cdcd"),
  pink: /** @type {Hex} */ ("#f5c2e7"),
  mauve: /** @type {Hex} */ ("#cba6f7"),
  red: /** @type {Hex} */ ("#f38ba8"),
  maroon: /** @type {Hex} */ ("#eba0ac"),
  peach: /** @type {Hex} */ ("#fab387"),
  yellow: /** @type {Hex} */ ("#f9e2af"),
  green: /** @type {Hex} */ ("#a6e3a1"),
  teal: /** @type {Hex} */ ("#94e2d5"),
  sky: /** @type {Hex} */ ("#89dceb"),
  sapphire: /** @type {Hex} */ ("#74c7ec"),
  blue: /** @type {Hex} */ ("#89b4fa"),
  lavender: /** @type {Hex} */ ("#b4befe"),
  text: /** @type {Hex} */ ("#cdd6f4"),
  subtext1: /** @type {Hex} */ ("#bac2de"),
  subtext0: /** @type {Hex} */ ("#a6adc8"),
  overlay2: /** @type {Hex} */ ("#9399b2"),
  overlay1: /** @type {Hex} */ ("#7f849c"),
  overlay0: /** @type {Hex} */ ("#6c7086"),
  surface2: /** @type {Hex} */ ("#585b70"),
  surface1: /** @type {Hex} */ ("#45475a"),
  surface0: /** @type {Hex} */ ("#313244"),
  base: /** @type {Hex} */ ("#1e1e2e"),
  mantle: /** @type {Hex} */ ("#181825"),
  crust: /** @type {Hex} */ ("#11111b"),
});

/** @param {string} hex `#rrggbb` @returns {[number, number, number]} */
export function rgb(hex) {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {number[]} c @returns {Hex} */
const toHex = (c) => /** @type {Hex} */ (`#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`);

/**
 * `fg` at opacity `a` drawn over the solid `bg`, as one solid colour.
 * @param {string} fg @param {string} bg @param {number} a 0 to 1
 */
export function mix(fg, bg, a) {
  const f = rgb(fg);
  const b = rgb(bg);
  return toHex(f.map((v, i) => v * a + b[i] * (1 - a)));
}

/** `#rrggbbaa`: `hex` at opacity `a`, for Herdr to blend. @param {string} hex @param {number} a 0 to 1 */
export function alpha(hex, a) {
  return /** @type {Hex} */ (
    `${hex.slice(0, 7)}${Math.round(a * 255)
      .toString(16)
      .padStart(2, "0")}`
  );
}

/** WCAG 2.2 relative luminance. @param {string} hex */
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two solid colours, 1 to 21. @param {string} a @param {string} b */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const M = MOCHA;

/** Herdr's panel roles as the spec's table names them; themes/bellwether.json `colors` holds these. */
export const ROLES = Object.freeze({
  canvas: M.base,
  chrome: M.mantle,
  surface: M.base,
  popover: M.mantle,
  raised: mix(M.surface0, M.base, 0.45),
  border: M.surface0,
  // An editable field's edge carries meaning, so it needs 3:1 on Base, Mantle and raised (#272738).
  input: M.overlay1,
  hover: alpha(M.text, 0.07),
  selected: mix(M.surface1, M.base, 0.55),
  foreground: M.text,
  muted: M.subtext0,
  dim: M.overlay2,
  accent: M.mauve,
  // Herdr derives a grey focus ring when the theme names none.
  ring: M.mauve,
  solid: M.mauve,
  accent_foreground: M.crust,
  solid_foreground: M.crust,
  working: M.blue,
  done: M.green,
  blocked: M.peach,
  idle: M.overlay2,
  unknown: M.overlay2,
});

/** The terminal half of the theme. ANSI is Ghostty 1.4.0's "Catppuccin Mocha" theme, bright slots included. */
export const TERMINAL = Object.freeze({
  background: M.base,
  foreground: M.text,
  cursor: M.rosewater,
  // A quarter of Mauve over Base, so a selection follows the accent and Text stays readable on it.
  selection: mix(M.mauve, M.base, 0.25),
  ansi: Object.freeze(
    /** @type {Hex[]} */ ([
      "#45475a",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#bac2de",
      "#585b70",
      "#f7aec2",
      "#c2ecbf",
      "#fcd682",
      "#aeccfc",
      "#f398da",
      "#b1eae1",
      "#a6adc8",
    ]),
  ),
});

/** Secondary text on selected (#333546) or hovered raised (#272738), where Subtext 0 keeps >= 5.4:1 AA. */
export const MUTED_ON_SELECTED = M.subtext0;

/** Hues a monogram tile can take; its text is Crust on every one. */
export const TILE_HUES = Object.freeze([
  M.mauve,
  M.blue,
  M.green,
  M.peach,
  M.pink,
  M.teal,
  M.yellow,
  M.sapphire,
  M.lavender,
]);
