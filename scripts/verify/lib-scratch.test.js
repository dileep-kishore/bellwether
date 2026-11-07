import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = join(import.meta.dir, "lib-scratch.sh");

// Runs one lib-scratch function in sh; root replaces /private/tmp so a broken guard deletes only test folders.
function sh(fn, dir, root) {
  const set = root === undefined ? "" : 'scratch_root=$3; ';
  const p = Bun.spawnSync(["sh", "-c", `. "$1"; ${set}${fn} "$2"`, "sh", LIB, dir, root ?? ""], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "bw-scratch-"));
  const root = join(base, "root");
  mkdirSync(root);
  return { base, root };
}

describe("scratch_path", () => {
  test("refuses /private/tmp/ itself", () => {
    for (const d of ["/private/tmp/", "/private/tmp", "/private/tmp//", "/private/tmp/."]) {
      expect(sh("scratch_path", d).code).not.toBe(0);
    }
  });

  test("refuses a path with a .. component, even one that resolves inside the root", () => {
    const { root } = scratch();
    mkdirSync(join(root, "a"));
    expect(sh("scratch_path", "/private/tmp/../../Users/someone/important").code).not.toBe(0);
    expect(sh("scratch_path", `${root}/a/../b`, root).code).not.toBe(0);
  });

  test("refuses the root with a trailing slash, a relative path and a sibling with the root as prefix", () => {
    const { base, root } = scratch();
    expect(sh("scratch_path", `${root}/`, root).code).not.toBe(0);
    expect(sh("scratch_path", "relative/dir", root).code).not.toBe(0);
    mkdirSync(`${root}x`);
    expect(sh("scratch_path", `${root}x/d`, root).code).not.toBe(0);
    expect(sh("scratch_path", join(base, "elsewhere"), root).code).not.toBe(0);
  });

  test("refuses a descendant reached through a symlink out of the root", () => {
    const { base, root } = scratch();
    mkdirSync(join(base, "outside"));
    Bun.spawnSync(["ln", "-s", join(base, "outside"), join(root, "link")]);
    expect(sh("scratch_path", `${root}/link/d`, root).code).not.toBe(0);
    expect(sh("scratch_path", `${root}/link`, root).code).not.toBe(0);
  });

  test("prints a strict descendant resolved", () => {
    const { root } = scratch();
    mkdirSync(join(root, "a"));
    const r = sh("scratch_path", `${root}/a/d/`, root);
    expect(r.code).toBe(0);
    expect(r.out.endsWith("/root/a/d")).toBe(true);
  });
});

describe("scratch_make and scratch_rm", () => {
  test("refuses to delete a folder without the marker", () => {
    const { root } = scratch();
    const d = join(root, "unmarked");
    mkdirSync(d);
    writeFileSync(join(d, "keep"), "x");
    const r = sh("scratch_rm", d, root);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(".bw-scratch");
    expect(existsSync(join(d, "keep"))).toBe(true);
  });

  test("refuses a .. path that climbs out of the root and leaves its target", () => {
    const { base, root } = scratch();
    const victim = join(base, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, ".bw-scratch"), "");
    expect(sh("scratch_rm", `${root}/../victim`, root).code).not.toBe(0);
    expect(existsSync(victim)).toBe(true);
  });

  test("makes a marked folder, refuses to make it twice, then deletes it", () => {
    const { root } = scratch();
    const d = join(root, "made");
    expect(sh("scratch_make", d, root).code).toBe(0);
    expect(existsSync(join(d, ".bw-scratch"))).toBe(true);
    expect(sh("scratch_make", d, root).code).not.toBe(0);
    const r = sh("scratch_rm", d, root);
    expect(r.code).toBe(0);
    expect(existsSync(d)).toBe(false);
  });

  test("treats a missing folder as already deleted", () => {
    const { root } = scratch();
    expect(sh("scratch_rm", join(root, "never"), root).code).toBe(0);
  });
});
