import { describe, expect, test } from "bun:test";
import { dropReveal, revealFor, withReveal } from "./diff-reveal.js";

describe("diff reveal", () => {
  test("withReveal keeps live spaces only and replaces the space's entry", () => {
    const stored = { s1: { file: "/w/a.rs", at: 1 }, gone: { file: "/w/b.rs", at: 2 }, junk: { file: 3 } };
    expect(withReveal(stored, "s1", "/w/c.rs", 9, ["s1", "s2"])).toEqual({ s1: { file: "/w/c.rs", at: 9 } });
    expect(withReveal(null, "s2", "x", 1, ["s2"])).toEqual({ s2: { file: "x", at: 1 } });
  });

  test("revealFor reads one space; junk reads as none", () => {
    expect(revealFor({ s1: { file: "a", at: 1 } }, "s1")).toEqual({ file: "a", at: 1 });
    expect(revealFor({ s1: { file: "", at: 1 } }, "s1")).toBe(null);
    expect(revealFor([], "s1")).toBe(null);
    expect(revealFor({ s1: { file: "a", at: 1 } }, null)).toBe(null);
  });

  test("dropReveal removes only that space", () => {
    expect(dropReveal({ s1: { file: "a", at: 1 }, s2: { file: "b", at: 2 } }, "s1")).toEqual({
      s2: { file: "b", at: 2 },
    });
  });
});
