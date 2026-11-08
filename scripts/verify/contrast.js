// Every foreground and background pair Bellwether's mods draw, with the WCAG 2.2 minimum each needs:
// 4.5:1 for text under 24 px (SC 1.4.3), 3:1 for status marks, icons and borders that carry meaning
// (SC 1.4.11). Translucent fills are composited over what they sit on, and a breathing mark is
// measured at its dimmest opacity.
//   bun scripts/verify/contrast.js   prints each pair and exits 1 when any falls short
import { MOCHA as M, MUTED_ON_SELECTED, ROLES as R, TILE_HUES, contrast, mix } from "../../shared/palette.js";

const HOVER = 0x14 / 255;
const BREATHE_MIN = 0.65;
const hovered = (/** @type {string} */ fill) => mix(M.text, fill, HOVER);
const primaryHover = mix(M.text, M.mauve, 0.15);

/** @typedef {{ what: string, fg: string, bg: string, min: number }} Pair */

/** Every fill a text or mark sits on, by name. */
const FILLS = {
  crust: M.crust,
  mantle: M.mantle,
  base: M.base,
  "surface 0": M.surface0,
  "hover on mantle": hovered(M.mantle),
  "hover on base": hovered(M.base),
};

/** @returns {Pair[]} */
export function pairs() {
  /** @type {Pair[]} */
  const out = [];
  const text = (/** @type {string} */ what, /** @type {string} */ fg, /** @type {string} */ bg) =>
    out.push({ what, fg, bg, min: 4.5 });
  const mark = (/** @type {string} */ what, /** @type {string} */ fg, /** @type {string} */ bg) =>
    out.push({ what, fg, bg, min: 3 });

  for (const [name, bg] of Object.entries(FILLS)) {
    text(`text on ${name}`, R.foreground, bg);
    text(`muted on ${name}`, R.muted, bg);
    text(`removed (Red) on ${name}`, M.red, bg);
    text(`added (Green) on ${name}`, M.green, bg);
    text(`blocked text (Peach) on ${name}`, R.blocked, bg);
    for (const s of ["working", "done", "idle"]) mark(`${s} mark on ${name}`, R[/** @type {"working"} */ (s)], bg);
    mark(`blocked mark at ${BREATHE_MIN} on ${name}`, mix(R.blocked, bg, BREATHE_MIN), bg);
    mark(`icon (dim) on ${name}`, R.dim, bg);
  }
  text("Mauve link on Surface 0 chip", R.accent, M.surface0);
  text("Mauve link on hovered Surface 0 chip", R.accent, hovered(M.surface0));
  text("Mauve heading on Mantle", R.accent, M.mantle);
  for (const bg of [M.surface1, hovered(M.surface0)]) {
    const name = bg === M.surface1 ? "Surface 1" : "hovered Surface 0";
    text(`text on ${name}`, R.foreground, bg);
    text(`muted-on-selected (Subtext 1) on ${name}`, MUTED_ON_SELECTED, bg);
    for (const s of ["working", "done", "idle"]) mark(`${s} mark on ${name}`, R[/** @type {"working"} */ (s)], bg);
    mark(`blocked mark at ${BREATHE_MIN} on ${name}`, mix(R.blocked, bg, BREATHE_MIN), bg);
    mark(`Mauve marker on ${name}`, R.accent, bg);
  }
  text("text on hovered Surface 1 button", R.foreground, mix(M.text, M.surface1, HOVER));
  text("text on terminal selection", R.foreground, mix(M.mauve, M.base, 0.25));
  text("Crust on Mauve (primary button, accent pill)", M.crust, M.mauve);
  text("Crust on hovered primary button", M.crust, primaryHover);
  for (const [n, c] of Object.entries({ Peach: M.peach, Blue: M.blue, Green: M.green, Red: M.red }))
    text(`Crust on ${n} pill`, M.crust, c);
  for (const hue of TILE_HUES) text(`Crust on monogram ${hue}`, M.crust, hue);
  mark("Mauve focus border on Base", R.accent, M.base);
  mark("Mauve focus border on Crust", R.accent, M.crust);
  mark("Mauve insertion line on Mantle", R.accent, M.mantle);
  return out;
}

/** Disabled controls are exempt from the text minimum but must look different from enabled ones. */
export function disabledDiffers() {
  const enabled = [`${R.solid}/${R.solid_foreground}`, `${M.surface0}/${R.foreground}`, `none/${R.muted}`];
  // On a Surface 0 card secondary is Surface 1 and disabled Mantle.
  const onCard = [`${R.solid}/${R.solid_foreground}`, `${M.surface1}/${R.foreground}`];
  return (
    enabled.every((look) => look !== `${M.surface0}/${R.dim}`) &&
    onCard.every((look) => look !== `${M.mantle}/${R.dim}`)
  );
}

if (import.meta.main) {
  let bad = 0;
  for (const p of pairs()) {
    const r = contrast(p.fg, p.bg);
    const ok = r >= p.min;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${r.toFixed(2)}:1 (min ${p.min}) ${p.what} ${p.fg} on ${p.bg}`);
  }
  if (!disabledDiffers()) {
    bad++;
    console.log("FAIL disabled buttons look like an enabled kind");
  }
  console.log(bad ? `${bad} pairs fall short` : "every pair meets its minimum");
  process.exit(bad ? 1 : 0);
}
