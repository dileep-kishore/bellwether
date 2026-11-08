import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { div } from "gpui-kit";
import { findAll, textOf } from "./harness/kit-stub.js";
import { ICONS, ago, appear, button, chip, machineTag, monogram, programIcon, statusMark } from "../shared/ui.js";

const ROOT = join(import.meta.dir, "..");
const t = new Proxy({}, { get: (_o, k) => `#${String(k)}` });
const MIN = 60_000;

test("working spins at 900 in working colour", () => {
  const el = statusMark(t, "working");
  expect(el.tag).toBe("svg");
  expect(el.attrs).toMatchObject({ path: ICONS["ring-spin"], spin: 900, text_color: "#working", size: 12 });
  expect(el.attrs.loop).toBeUndefined();
});

test("blocked breathes its opacity between 0.65 and 1 and never spins", () => {
  const el = statusMark(t, "blocked", 11);
  expect(el.attrs).toMatchObject({ path: ICONS.question, text_color: "#blocked", size: 11 });
  expect(el.attrs.loop).toEqual(["opacity", { from: 0.65, to: 1, period: 1400 }]);
  expect(el.attrs.spin).toBeUndefined();
});

test("idle and done are still: no spin, no loop", () => {
  for (const [status, icon] of [
    ["done", "check"],
    ["idle", "ring"],
  ]) {
    const el = statusMark(t, status, 11);
    expect(el.attrs).toMatchObject({ path: ICONS[icon], text_color: `#${status}`, size: 11 });
    expect(el.attrs.spin).toBeUndefined();
    expect(el.attrs.loop).toBeUndefined();
  }
});

test("with an id the check stays mounted and fades to 1 only when done", () => {
  const check = (/** @type {any} */ el) => findAll(el, (e) => e.attrs.id === "m-done")[0];
  for (const status of ["working", "blocked", "idle", "done"]) {
    const el = statusMark(t, status, 12, "m");
    expect(el.attrs.id).toBe("m");
    const c = check(el);
    expect(c.attrs).toMatchObject({ path: ICONS.check, text_color: "#done", opacity: status === "done" ? 1 : 0 });
    expect(c.attrs.transition).toEqual(["opacity", 180]);
    expect(findAll(el, (e) => e.attrs.loop !== undefined).length).toBe(status === "blocked" ? 1 : 0);
    expect(findAll(el, (e) => e.attrs.spin !== undefined).length).toBe(status === "working" ? 1 : 0);
  }
});

test("null status is an empty box", () => {
  for (const status of [null, undefined, "unknown"]) {
    const el = statusMark(t, status);
    expect(el.tag).toBe("div");
    expect(el.attrs.size).toBe(12);
    expect(el.kids).toEqual([]);
  }
});

test("a disabled button has no hover or click, and differs from every enabled kind", () => {
  const off = button(t, { id: "b", label: "Go", kind: "primary", enabled: false, onClick: () => {} });
  expect(off.attrs).toMatchObject({ bg: "#raised", text_color: "#dim", disabled: true });
  expect(off.attrs.hover).toBeUndefined();
  expect(off.handlers.on_click).toBeUndefined();
  const looks = ["primary", "secondary", "ghost"].map((kind) => {
    const on = button(t, { id: "b", label: "Go", kind, onClick: () => {} });
    expect(on.handlers.on_click).toBeDefined();
    return `${on.attrs.bg}/${on.attrs.text_color}`;
  });
  expect(looks).toEqual(["#solid/#solid_foreground", "#raised/#foreground", "undefined/#muted"]);
  expect(looks).not.toContain(`${off.attrs.bg}/${off.attrs.text_color}`);
});

test("appear starts at 0 and 6 px down, and transitions both", () => {
  const el = appear(div().id("c"), false);
  expect(el.attrs).toMatchObject({ opacity: 0, top: 6, relative: undefined });
  expect(appear(div().id("c"), true).attrs).toMatchObject({ opacity: 1, top: 0 });
  expect(el.attrs.transition).toEqual(["top", 140]);
});

test("a monogram keeps its hue for a key and writes Crust on it", () => {
  const a = monogram(t, "m:/repo/.git", "B");
  expect(a.attrs.bg).toBe(monogram(t, "m:/repo/.git", "B").attrs.bg);
  expect(a.attrs.text_color).toBe("#accent_foreground");
  expect(textOf(a)).toBe("B");
});

test("ago: 59 s now, 3 min 3m, 2 h 2h, 4 d 4d", () => {
  const now = 1_762_460_000_000;
  expect(ago(now - 59_000, now)).toBe("now");
  expect(ago(now - 3 * MIN, now)).toBe("3m");
  expect(ago(now - 120 * MIN, now)).toBe("2h");
  expect(ago(now - 4 * 24 * 60 * MIN, now)).toBe("4d");
  expect(ago(now + 5_000, now)).toBe("now");
});

test("tinted program icon is an svg", () => {
  const el = programIcon({ icon: "icons/shell.svg", tint: true }, t);
  expect(el.tag).toBe("svg");
  expect(el.attrs).toMatchObject({ path: "icons/shell.svg", text_color: "#muted", size: 14 });
});

test("untinted program icon is an image; no icon is the terminal glyph", () => {
  expect(programIcon({ icon: "icons/claude.svg", tint: false }, t, 16)).toMatchObject({
    tag: "image",
    attrs: { path: "icons/claude.svg", w: 16, h: 16 },
  });
  for (const p of [null, { icon: null, tint: false }]) {
    expect(programIcon(p, t).attrs).toMatchObject({ path: ICONS.terminal, text_color: "#muted" });
  }
});

test("machine tag is a Surface 0 pill with Subtext 0 text", () => {
  const el = machineTag("macmini", t);
  expect(textOf(el)).toBe("macmini");
  expect(el.attrs).toMatchObject({ text_size: 11, bg: "#raised", text_color: "#muted", rounded: 9 });
});

test("every icon is a 16x16 one-colour svg in mods/bw-projects/icons", () => {
  const names = [
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
  expect(Object.keys(ICONS).sort()).toEqual([...names].sort());
  for (const name of names) {
    expect(ICONS[name]).toBe(`mods/bw-projects/icons/${name}.svg`);
    const src = readFileSync(join(ROOT, ICONS[name]), "utf8");
    expect(src).toContain('viewBox="0 0 16 16"');
    expect(src).toContain("currentColor");
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  }
});

test("on a Surface 0 card, secondary is Surface 1 and disabled keeps Surface 0 with a border", () => {
  expect(button(t, { id: "b", label: "Deny", on: "raised" }).attrs).toMatchObject({ bg: "#selected" });
  expect(button(t, { id: "b", label: "Deny", on: "raised", enabled: false }).attrs).toMatchObject({
    bg: "#raised",
    text_color: "#dim",
    border: 1,
    border_color: "#border",
  });
  expect(button(t, { id: "b", label: "Go", kind: "primary", on: "raised" }).attrs.bg).toBe("#solid");
});

test("a chip lifts muted text to Subtext 1 on hover, and keeps a colour it was given", () => {
  const plain = chip(t);
  expect(plain.attrs).toMatchObject({ h: 28, rounded: 14, bg: "#raised", text_color: "#muted" });
  expect(plain.attrs.hover.text_color).toBe("#bac2de");
  const failed = chip(t, { color: "#blocked" });
  expect(failed.attrs.text_color).toBe("#blocked");
  expect(failed.attrs.hover.text_color).toBeUndefined();
});
