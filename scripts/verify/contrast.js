// Every foreground and background pair Bellwether's mods draw, with the WCAG 2.2 minimum each needs:
// 4.5:1 for text under 24 px (SC 1.4.3), 3:1 for status marks, icons and borders that carry meaning
// (SC 1.4.11). Translucent fills are composited over what they sit on, and a breathing mark is
// measured at its dimmest opacity.
//   bun scripts/verify/contrast.js   prints each pair and exits 1 when any falls short
import { MOCHA as M, MUTED_ON_SELECTED, ROLES as R, TERMINAL, TILE_HUES, contrast, mix } from "../../shared/palette.js";

const HOVER = 0.07;
const BREATHE_MIN = 0.65;
const hovered = (/** @type {string} */ fill) => mix(M.text, fill, HOVER);
const primaryHover = mix(M.text, M.mauve, 0.15);

/** @typedef {{ what: string, fg: string, bg: string, min: number }} Pair */

/** Every fill a text or mark sits on, by name. */
const FILLS = {
  mantle: R.chrome,
  base: R.surface,
  raised: R.raised,
  "hover on mantle": hovered(R.chrome),
  "hover on base": hovered(R.surface),
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
    for (const s of ["working", "done", "blocked", "idle"])
      mark(`${s} mark on ${name}`, R[/** @type {"working"} */ (s)], bg);
    mark(`icon (dim) on ${name}`, R.dim, bg);
  }
  text("Mauve link on raised chip", R.accent, R.raised);
  text("Mauve link on hovered raised chip", R.accent, hovered(R.raised));
  text("Mauve heading on Mantle", R.accent, R.chrome);
  for (const bg of [R.selected, hovered(R.raised)]) {
    const name = bg === R.selected ? "selected (#333546)" : "hovered raised (#272738)";
    text(`text on ${name}`, R.foreground, bg);
    text(`muted-on-selected (Subtext 0) on ${name}`, MUTED_ON_SELECTED, bg);
    text(`removed on a selected row (bright Red) on ${name}`, TERMINAL.ansi[9], bg);
    text(`added (Green) on ${name}`, M.green, bg);
    for (const s of ["working", "done", "blocked", "idle"])
      mark(`${s} mark on ${name}`, R[/** @type {"working"} */ (s)], bg);
    mark(`Mauve marker on ${name}`, R.accent, bg);
  }
  // The Changes panel: status letters in Blue and Peach on rows, and patch rows tinted over Base.
  for (const [n, bg] of [
    ["Mantle", R.chrome],
    ["hover on Mantle", hovered(R.chrome)],
    ["selected", R.selected],
  ]) {
    text(
      `renamed letter (${n === "selected" ? "bright Blue" : "Blue"}) on ${n}`,
      n === "selected" ? TERMINAL.ansi[12] : R.working,
      bg,
    );
    text(`modified letter (Peach) on ${n}`, R.blocked, bg);
  }
  for (const [n, tint] of [
    ["added", M.green],
    ["removed", M.red],
  ]) {
    text(`patch text on the ${n} tint`, R.foreground, mix(tint, R.surface, 0.12));
    text(`line numbers (muted) on the ${n} tint`, R.muted, mix(tint, R.surface, 0.12));
  }
  text("hunk header (muted) on raised", R.muted, R.raised);
  text("text on hovered selected button", R.foreground, hovered(R.selected));
  text("text on terminal selection", R.foreground, mix(M.mauve, M.base, 0.25));
  text("Crust on Mauve (primary button, accent pill)", M.crust, M.mauve);
  text("Crust on hovered primary button", M.crust, primaryHover);
  for (const [n, c] of Object.entries({ Peach: M.peach, Blue: M.blue, Green: M.green, Red: M.red }))
    text(`Crust on ${n} pill`, M.crust, c);
  text("neutral monogram letter (Subtext 0) on raised", R.muted, R.raised);
  text("quiet rail monogram letter (Subtext 0) on Mantle", R.muted, R.chrome);
  for (const hue of TILE_HUES) text(`Crust on Mocha accent ${hue}`, M.crust, hue);
  const breathePillBg = mix(R.blocked, R.raised, BREATHE_MIN);
  const breathePillFg = mix(R.accent_foreground, R.raised, BREATHE_MIN);
  mark(`breathing Needs you pill at ${BREATHE_MIN} on raised`, breathePillBg, R.raised);
  text(`breathing Needs you pill text at ${BREATHE_MIN} on raised`, breathePillFg, breathePillBg);
  mark("empty option box (Overlay 2) on a raised card", R.dim, R.raised);
  for (const [n, bg] of [
    ["Base", R.surface],
    ["Mantle", R.chrome],
    ["raised", R.raised],
    ["selected", R.selected],
  ])
    mark(`input field border on ${n}`, R.input, bg);
  mark("Mauve focus border on Base", R.accent, R.surface);
  mark("Mauve focus border on Mantle", R.accent, R.chrome);
  mark("Mauve insertion line on Mantle", R.accent, R.chrome);
  return out;
}

/** Disabled controls are exempt from the text minimum but must look different from enabled ones. */
export function disabledDiffers() {
  const enabled = [`${R.solid}/${R.solid_foreground}`, `${R.raised}/${R.foreground}`, `none/${R.muted}`];
  // On a raised card secondary is selected; disabled keeps raised and adds a border.
  const onCard = [`${R.solid}/${R.solid_foreground}`, `${R.selected}/${R.foreground}`];
  return (
    enabled.every((look) => look !== `${R.raised}/${R.dim}`) && onCard.every((look) => look !== `${R.raised}/${R.dim}`)
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
