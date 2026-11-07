import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCounts, parsePlace, parseWorktrees, SEP } from "./git-parse.js";

// Fixtures: make-repos.sh output with the root rewritten to /r; status-v2.z and numstat.z also
// have README.md renamed to README.txt (staged) and logo.bin edited in alpha-wt/feat.
const read = (name) => readFileSync(join(import.meta.dir, "../tests/fixtures/git", name), "utf8");

// Git lists the main checkout first, then the linked worktrees sorted by path.
test("worktrees: main first, branch stripped, detached and nested kept", () => {
  const w = parseWorktrees(read("worktree-list.z"));
  expect(w.map((x) => [x.path, x.branch, x.detached])).toEqual([
    ["/r/alpha", "main", false],
    ["/r/alpha-wt/detached", null, true],
    ["/r/alpha-wt/feat", "feat", false],
    ["/r/alpha/.worktrees/nested", "nested", false],
  ]);
  expect(w.every((x) => /^[0-9a-f]{40}$/.test(x.head))).toBe(true);
  expect(w.some((x) => x.bare || x.locked || x.prunable)).toBe(false);
});

test("worktrees: bare, locked and prunable flags, with and without reasons", () => {
  const out =
    "worktree /r/x.git\0bare\0\0" +
    "worktree /r/a\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/a/b\0locked\0\0" +
    "worktree /r/c\0HEAD 2222222222222222222222222222222222222222\0detached\0locked on a\nusb drive\0prunable gitdir file points to non-existent location\0\0";
  expect(parseWorktrees(out)).toEqual([
    { path: "/r/x.git", head: null, branch: null, detached: false, bare: true, locked: false, prunable: false },
    { path: "/r/a", head: "1111111111111111111111111111111111111111", branch: "a/b", detached: false, bare: false, locked: true, prunable: false },
    { path: "/r/c", head: "2222222222222222222222222222222222222222", branch: null, detached: true, bare: false, locked: true, prunable: true },
  ]);
});

test("worktrees: empty output is an empty list", () => expect(parseWorktrees("")).toEqual([]));

test("counts: ahead, behind, lines; binary and rename", () =>
  expect(parseCounts(read("status-v2.z"), read("numstat.z"))).toEqual({
    branch: "feat", detached: false, upstream: true, ahead: 1, behind: 0, files: 3, added: 3, removed: 1,
  }));

test("counts: detached, behind, untracked and unmerged files", () => {
  const status =
    "# branch.oid 1111111111111111111111111111111111111111\0# branch.head (detached)\0" +
    "u UU N... 100644 100644 100644 100644 a b c conflict.txt\0? new file.txt\0";
  expect(parseCounts(status, "")).toMatchObject({ branch: null, detached: true, upstream: false, ahead: 0, behind: 0, files: 2 });
  const tracking = "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -4\0";
  expect(parseCounts(tracking, "")).toMatchObject({ branch: "main", upstream: true, ahead: 0, behind: 4, files: 0 });
});

test("counts: a rename's two paths are one file, and a tab in a path is kept out of the counts", () => {
  const status = "# branch.oid (initial)\0# branch.head main\0" + "2 R. N... 100644 100644 100644 a a R100 new\tname\0old\0";
  const numstat = "0\t0\t\0old\0new\tname\0" + "2\t5\tx\ty\0";
  expect(parseCounts(status, numstat)).toMatchObject({ files: 1, added: 2, removed: 5 });
});

test("empty numstat (unborn HEAD) is zero lines", () => {
  const status = "# branch.oid (initial)\0# branch.head main\0? a.txt\0";
  expect(parseCounts(status, "")).toEqual({ branch: "main", detached: false, upstream: false, ahead: 0, behind: 0, files: 1, added: 0, removed: 0 });
});

test("place: two absolute lines", () =>
  expect(parsePlace("/r/alpha/.git\n/r/alpha-wt/feat\n")).toEqual({ commonDir: "/r/alpha/.git", top: "/r/alpha-wt/feat" }));

test("place: a path with spaces and no trailing newline", () =>
  expect(parsePlace("/r/my repo/.git\n/r/my repo")).toEqual({ commonDir: "/r/my repo/.git", top: "/r/my repo" }));

test("place: a Windows drive path is absolute", () =>
  expect(parsePlace("C:/src/alpha/.git\nC:/src/alpha\n")).toEqual({ commonDir: "C:/src/alpha/.git", top: "C:/src/alpha" }));

test("place: empty output is null", () => {
  expect(parsePlace("")).toBe(null);
  expect(parsePlace("/r/alpha/.git\n")).toBe(null);
  expect(parsePlace("relative/.git\n/r/alpha\n")).toBe(null);
});

test("SEP is the record separator the counts script prints", () => expect(SEP).toBe("\x1e"));
