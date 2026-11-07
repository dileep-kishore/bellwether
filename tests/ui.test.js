import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { textOf } from "./harness/kit-stub.js";
import { ICONS, ago, machineTag, programIcon, statusIcon } from "../shared/ui.js";

const ROOT = join(import.meta.dir, "..");
const t = new Proxy({}, { get: (_o, k) => `#${String(k)}` });
const MIN = 60_000;

test("working spins at 900 in working colour", () => {
  const el = statusIcon(t, "working");
  expect(el.tag).toBe("svg");
  expect(el.attrs).toMatchObject({ path: ICONS["ring-spin"], spin: 900, text_color: "#working", size: 12 });
});

test("blocked, done and idle draw their icon in their colour", () => {
  for (const [status, icon] of [["blocked", "question"], ["done", "check"], ["idle", "ring"]]) {
    const el = statusIcon(t, status, 11);
    expect(el.attrs).toMatchObject({ path: ICONS[icon], text_color: `#${status}`, size: 11 });
    expect(el.attrs.spin).toBeUndefined();
  }
});

test("null status is an empty box", () => {
  for (const status of [null, undefined, "unknown"]) {
    const el = statusIcon(t, status);
    expect(el.tag).toBe("div");
    expect(el.attrs.size).toBe(12);
    expect(el.kids).toEqual([]);
  }
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
  expect(programIcon({ icon: "icons/claude.svg", tint: false }, t, 16)).toMatchObject({ tag: "image", attrs: { path: "icons/claude.svg", w: 16, h: 16 } });
  for (const p of [null, { icon: null, tint: false }]) {
    expect(programIcon(p, t).attrs).toMatchObject({ path: ICONS.terminal, text_color: "#muted" });
  }
});

test("machine tag is a small bordered label", () => {
  const el = machineTag("macmini", t);
  expect(textOf(el)).toBe("macmini");
  expect(el.attrs).toMatchObject({ text_size: 10, border: 1, border_color: "#border", rounded: 4, px: 4 });
});

test("every icon is a 16x16 one-colour svg in mods/bw-projects/icons", () => {
  const names = ["ring", "ring-spin", "check", "question", "plus", "close", "branch", "server", "monitor", "chevron-right", "chevron-down", "more", "terminal"];
  expect(Object.keys(ICONS).sort()).toEqual([...names].sort());
  for (const name of names) {
    expect(ICONS[name]).toBe(`mods/bw-projects/icons/${name}.svg`);
    const src = readFileSync(join(ROOT, ICONS[name]), "utf8");
    expect(src).toContain('viewBox="0 0 16 16"');
    expect(src).toContain("currentColor");
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  }
});
