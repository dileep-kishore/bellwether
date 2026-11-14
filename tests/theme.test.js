import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOCHA, ROLES, TERMINAL, contrast, mix } from "../shared/palette.js";
import { disabledDiffers, pairs } from "../scripts/verify/contrast.js";

const ROOT = join(import.meta.dir, "..");
const theme = JSON.parse(readFileSync(join(ROOT, "themes/bellwether.json"), "utf8"));

test("themes/bellwether.json is what scripts/gen-theme.js writes from palette.js", () => {
  const { background, foreground, selection, cursor, ansi } = TERMINAL;
  expect(theme).toEqual({
    background,
    foreground,
    selection,
    cursor,
    ansi: [...ansi],
    colors: { ...ROLES, background },
  });
});

test("Mocha's flattened roles: Base field, Text foreground, Rosewater cursor, Mauve accent, 1.12:1 raised", () => {
  expect(theme).toMatchObject({ background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc" });
  expect(theme.colors).toMatchObject({
    accent: "#cba6f7",
    canvas: "#1e1e2e",
    surface: "#1e1e2e",
    chrome: "#181825",
    raised: "#272738",
    border: "#313244",
    selected: "#333546",
    hover: "#cdd6f412",
  });
  expect(Object.keys(MOCHA)).toHaveLength(26);
});

test("selection is a quarter of Mauve over Base and Text stays readable on it", () => {
  expect(theme.selection).toBe("#494060");
  expect(mix(MOCHA.mauve, MOCHA.base, 0.25)).toBe("#494060");
  expect(contrast(MOCHA.text, theme.selection)).toBeGreaterThan(6.5);
});

test("ANSI is Ghostty 1.4.0's Catppuccin Mocha port, bright slots its own", () => {
  expect(theme.ansi).toEqual([
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
  ]);
  for (let i = 1; i < 7; i++) expect(theme.ansi[i + 8]).not.toBe(theme.ansi[i]);
});

test("the layout uses the theme named after it", () => {
  const layout = JSON.parse(readFileSync(join(ROOT, "layouts/bellwether.json"), "utf8"));
  expect(layout.theme).toBe("bellwether");
});

test("every pair the mods draw meets WCAG AA: 4.5:1 text, 3:1 marks", () => {
  const short = pairs()
    .map((p) => ({ ...p, ratio: contrast(p.fg, p.bg) }))
    .filter((p) => p.ratio < p.min)
    .map((p) => `${p.what}: ${p.ratio.toFixed(2)}`);
  expect(short).toEqual([]);
  expect(pairs().length).toBeGreaterThan(80);
  expect(disabledDiffers()).toBe(true);
});
