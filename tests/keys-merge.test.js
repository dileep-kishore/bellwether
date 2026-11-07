import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeKeys } from "../scripts/keys-merge.js";

const CLI = join(import.meta.dir, "../scripts/keys-merge.js");
const OURS = { "layout:bellwether": { "cmd-alt-b": "layout.toggle:right" } };

describe("mergeKeys", () => {
  test("merge adds our section into an empty file", () => {
    for (const user of [null, {}]) {
      const r = mergeKeys(user, OURS);
      expect(r.merged).toEqual(OURS);
      expect(r.added).toEqual([["layout:bellwether", "cmd-alt-b", "layout.toggle:right"]]);
      expect(r.same).toEqual([]);
      expect(r.conflicts).toEqual([]);
      expect(r.shadowed).toEqual([]);
    }
  });

  test("merge keeps the user's other keys and sections", () => {
    const user = {
      global: { "ctrl-shift-t": "tab.new" },
      terminal: { "ctrl-shift-c": "terminal.copy" },
      "layout:bellwether": { "cmd-alt-j": "space.next" },
    };
    const before = structuredClone(user);
    const r = mergeKeys(user, OURS);
    expect(r.merged).toEqual({
      global: { "ctrl-shift-t": "tab.new" },
      terminal: { "ctrl-shift-c": "terminal.copy" },
      "layout:bellwether": { "cmd-alt-j": "space.next", "cmd-alt-b": "layout.toggle:right" },
    });
    expect(Object.keys(r.merged)).toEqual(["global", "terminal", "layout:bellwether"]);
    expect(user).toEqual(before);
  });

  test("same binding is a no-op", () => {
    const user = { "layout:bellwether": { "alt-cmd-b": "layout.toggle:right" } };
    const r = mergeKeys(user, OURS);
    expect(r.merged).toEqual(user);
    expect(r.added).toEqual([]);
    expect(r.same).toEqual([["layout:bellwether", "cmd-alt-b", "layout.toggle:right"]]);
  });

  test("a key bound to something else is a conflict and nothing is written", () => {
    const user = { "layout:bellwether": { "cmd-alt-b": "layout.toggle:sidebar" } };
    const r = mergeKeys(user, OURS);
    expect(r.conflicts).toEqual([["layout:bellwether", "cmd-alt-b", "layout.toggle:sidebar", "layout.toggle:right"]]);
    expect(r.added).toEqual([]);
    expect(r.merged).toEqual(user);
  });

  test("a global binding our layout section would take over is a conflict", () => {
    const user = { global: { "Alt-Cmd-B": "app.palette" } };
    const r = mergeKeys(user, OURS);
    expect(r.conflicts).toEqual([["global", "Alt-Cmd-B", "app.palette", "layout.toggle:right"]]);
    expect(r.added).toEqual([]);
  });

  test("a terminal-section binding is reported as shadowed", () => {
    const user = { terminal: { "cmd-alt-b": "terminal" } };
    const r = mergeKeys(user, OURS);
    expect(r.shadowed).toEqual([["layout:bellwether", "cmd-alt-b", "terminal"]]);
    expect(r.added).toEqual([["layout:bellwether", "cmd-alt-b", "layout.toggle:right"]]);
    expect(r.conflicts).toEqual([]);
  });

  test("a section that is not an object is refused", () => {
    expect(() => mergeKeys({ "layout:bellwether": "x" }, OURS)).toThrow("layout:bellwether");
    expect(() => mergeKeys([], OURS)).toThrow("keys.json");
  });
});

describe("keys-merge.js", () => {
  const base = mkdtempSync(join(tmpdir(), "bw-keys-merge-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  let n = 0;

  function home(keys) {
    const dir = join(base, `home-${n++}`);
    mkdirSync(dir);
    if (keys !== undefined) writeFileSync(join(dir, "keys.json"), typeof keys === "string" ? keys : JSON.stringify(keys, null, 2));
    return dir;
  }

  function run(dir, ...args) {
    const p = Bun.spawnSync(["bun", CLI, "--home", dir, ...args], {
      env: { ...process.env, HERDR_APP_HOME: dir, HOME: base },
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  }

  test("without --apply it prints the diff and the defaults warning, writing nothing", () => {
    const user = { global: { "ctrl-shift-t": "tab.new" } };
    const dir = home(user);
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("added layout:bellwether cmd-alt-b");
    expect(r.out).toContain("Herdr stops adding new default shortcuts to an edited keys.json (AGENTS.md, Keys)");
    expect(JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"))).toEqual(user);
    expect(readdirSync(dir)).toEqual(["keys.json"]);
  });

  test("--apply backs the file up and writes the merge", () => {
    const user = { global: { "ctrl-shift-t": "tab.new" } };
    const dir = home(user);
    const r = run(dir, "--apply");
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"))).toEqual({ ...user, ...OURS });
    const backups = readdirSync(dir).filter((f) => /^keys\.json\.bw-\d+$/.test(f));
    expect(backups.length).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, backups[0]), "utf8"))).toEqual(user);
    expect(readdirSync(dir).sort()).toEqual(["keys.json", backups[0]].sort());
  });

  test("a conflict exits 1 and leaves the file as it was", () => {
    const text = '{ "layout:bellwether": { "cmd-alt-b": "layout.toggle:sidebar" } }\n';
    const dir = home(text);
    const r = run(dir, "--apply");
    expect(r.code).toBe(1);
    expect(r.out).toContain("conflict layout:bellwether cmd-alt-b");
    expect(readFileSync(join(dir, "keys.json"), "utf8")).toBe(text);
    expect(readdirSync(dir)).toEqual(["keys.json"]);
  });

  test("an already merged file is left alone", () => {
    const dir = home({ ...OURS });
    const text = readFileSync(join(dir, "keys.json"), "utf8");
    const r = run(dir, "--apply");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to change");
    expect(readFileSync(join(dir, "keys.json"), "utf8")).toBe(text);
    expect(readdirSync(dir)).toEqual(["keys.json"]);
  });

  test("--apply refuses a home without keys.json, and invalid JSON", () => {
    const empty = home();
    const r = run(empty, "--apply");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no keys.json");
    expect(existsSync(join(empty, "keys.json"))).toBe(false);

    const bad = home("{ not json");
    const b = run(bad, "--apply");
    expect(b.code).toBe(1);
    expect(readFileSync(join(bad, "keys.json"), "utf8")).toBe("{ not json");
  });

  test("a missing home is an error", () => {
    const r = run(join(base, "nowhere"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("no Herdr app home");
  });
});
