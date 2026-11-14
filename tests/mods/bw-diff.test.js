// bw-diff: the Changes panel and diff tabs, fed by `bw diff` lines recorded from
// scripts/verify/make-diff-repos.sh's `changes` and `nobase` repositories.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount, repo } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, fire, layOut, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import { projectKey } from "../../shared/projects-model.js";
import {
  anchorFromRow,
  formatReviewBlock,
  preflightVerifyComments,
  revalidateComment,
  upsertComment,
} from "../../mods/bw-diff/comments.js";
import {
  BASE_KEY,
  filesArgs,
  isShown,
  joinPages,
  parseRowKey,
  patchArgs,
  patchRowKeys,
  patchRows,
  prBaseChoice,
  readBase,
  readTab,
  rowFor,
  sectionsForScope,
  tabMachine,
  viewFiles,
  watchAnswer,
  writeBase,
} from "../../mods/bw-diff/model.js";

const lines = (/** @type {string} */ name) =>
  readFileSync(join(repo, "tests/fixtures/git", name), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const FILES = lines("diff-files.jsonl");
const NOBASE = lines("diff-files-nobase.jsonl");
const PATCH = lines("diff-patch-notes.jsonl");
const REFS = lines("diff-refs.jsonl");
const TOP = FILES[0].top;
const COMMON = FILES[0].common_dir;
const NB_TOP = NOBASE[0].top;

/** @param {object[]} ls */
const out = (ls) => ({ code: 0, stdout: `${ls.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);

afterEach(() => setSystemTime());

/**
 * A fake exec for the helper on any machine: `answers` maps "diff <sub>" to lines or a function of the
 * arguments after `bw`.
 * @param {Record<string, object[] | ((args: string[], on: string | null) => any)>} answers
 */
function bw(answers) {
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw")
      return { code: 127, stdout: "", stderr: "sh: no such fake" };
    if (args[3] === "version") return VERSION;
    const a = answers[`${args[3]} ${args[4]}`];
    if (!a) return out([{ type: "error", code: "stub", message: `no ${args[3]} ${args[4]} answer` }]);
    return typeof a === "function" ? a(args.slice(3), opts?.on ?? null) : out(a);
  };
}

/** A space on `machine` whose terminal sits in `cwd`. */
function world(machine = null, cwd = TOP) {
  return {
    machines: [{ name: null, layout: "ready" }, ...(machine ? [{ name: machine, layout: "ready" }] : [])],
    spaces: [
      {
        id: machine ? `${machine}/s1` : "s1",
        index: 1,
        name: "changes",
        named: false,
        folder: cwd,
        machine,
        branch: "feat",
        active: true,
        status: null,
        tabs: [{ id: "tb1", index: 1, name: "1", named: false, active: true, status: null, panes: 1 }],
      },
    ],
    panes: [{ pane: "p1", terminal: "t1", tab: "tb1", title: "zsh", cwd, branch: "feat", focused: true }],
  };
}

/** Sets the right-body stack's active child and shows the right column. @param {string} child */
function showInLayout(child, node = fake.layout) {
  if (node.id === "right") node.hidden = false;
  if (node.id === "right-body") node.active = child;
  for (const c of node.children ?? []) showInLayout(child, c);
}

/** @param {any} m @param {string} sub */
const calls = (m, sub) =>
  m.log.exec
    .filter(([c, a]) => c === "sh" && a[3] === "diff" && a[4] === sub)
    .map(([, a, o]) => ({ args: a.slice(3), on: o?.on ?? null }));

/** @param {{ machine?: string | null, cwd?: string, answers?: any, hidden?: boolean, shared?: any, watch?: any }} [o] */
async function panel(o = {}) {
  const answers = o.answers ?? { "diff files": FILES, "diff patch": PATCH, "diff refs": REFS };
  const m = await mount("bw-diff", {
    live: {
      ...world(o.machine ?? null, o.cwd ?? TOP),
      exec: bw(answers),
      shared: o.shared ?? {},
      watchFolder: o.watch ?? null,
    },
  });
  showInLayout(o.hidden ? "browser" : "changes");
  m.render();
  await m.cx.flush();
  m.render();
  await m.cx.flush();
  m.render();
  return m;
}

/**
 * Runs the loop's timers for `ms` of a fake clock: wakes the newest sleep, moves the clock by its length,
 * and draws after each step unless `draw` is false (a hidden copy is never drawn).
 * @param {any} m @param {number} ms @param {{ draw?: boolean }} [o]
 */
async function runFor(m, ms, { draw = true } = {}) {
  const start = Date.now();
  const woken = new Set();
  for (let i = 0; i < 500; i++) {
    const pending = m.cx.sleeps.filter((/** @type {any} */ s) => !woken.has(s));
    const s = pending.at(-1);
    if (!s || Date.now() + s.ms - start >= ms) break;
    for (const p of pending) woken.add(p);
    setSystemTime(new Date(Date.now() + Math.max(1, s.ms)));
    s.wake();
    await m.cx.flush();
    if (draw) m.render();
    await m.cx.flush();
  }
  setSystemTime(new Date(start + ms));
}

describe("model", () => {
  test("viewFiles reads place, base and the three sections", () => {
    const v = /** @type {any} */ (viewFiles(FILES));
    expect(v.place).toEqual({ top: TOP, commonDir: COMMON, branch: "feat", head: FILES[0].head });
    expect(v.base).toMatchObject({ ref: "origin/main", source: "default", mode: "merge-base" });
    expect(v.sections.staged.map((r) => [r.letter, r.path, r.oldPath])).toEqual([
      ["M", "mark.tc", null],
      ["R", "new-name.txt", "old-name.txt"],
      ["M", "pic.bin", null],
      ["M", "staged.txt", null],
    ]);
    expect(v.sections.changes.map((r) => [r.letter, r.dir, r.name, r.added, r.removed])).toEqual([
      ["M", "", "dash -name.txt", 1, 0],
      ["D", "", "gone.txt", 0, 1],
      ["M", "", "notes.txt", 2, 1],
      ["U", "", "blob.dat", null, null],
      ["U", "", "fresh.tc", 1, 0],
      ["U", "", "fresh.txt", 3, 0],
      ["U", "newdir/", "inner.txt", 1, 0],
    ]);
    expect(v.sections.changes.filter((r) => r.untracked)).toHaveLength(4);
    expect(v.sections.committed.map((r) => r.path)).toEqual(["feature.txt", "mark.tc"]);
    expect(v.digest).toMatchObject({ section: "changes", path: "notes.txt" });
    expect(viewFiles([{ type: "diff-base" }])).toBe(null);
  });

  test("patchRows numbers lines across hunks and keeps notes and cut lines", () => {
    const text = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,1 +10,2 @@",
      " j",
      "+k",
      "\\ No newline at end of file",
      "+huge",
      "",
    ].join("\n");
    const rows = patchRows(text, new Map([[11, 5_000_000]]));
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["hunk", null, null],
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["hunk", null, null],
      ["ctx", 10, 10],
      ["add", null, 11],
      ["note", null, null],
      ["cut", null, 12],
    ]);
    expect(rows[11].bytes).toBe(5_000_000);
  });

  test("joinPages offsets each page's cut lines", () => {
    const j = joinPages([
      { text: "a\nb\n", cut: [{ line: 1, bytes: 9 }] },
      { text: "c\n+\n", cut: [{ line: 1, bytes: 7 }] },
    ]);
    expect(j.text).toBe("a\nb\nc\n+\n");
    expect([...j.cut]).toEqual([
      [1, 9],
      [3, 7],
    ]);
  });

  test("rowFor finds an absolute or relative file, Changes first", () => {
    const v = /** @type {any} */ (viewFiles(FILES));
    expect(rowFor(v, `${TOP}/notes.txt`)?.section).toBe("changes");
    expect(rowFor(v, "mark.tc")?.section).toBe("staged");
    expect(rowFor(v, `${TOP}/feature.txt`)?.section).toBe("committed");
    expect(rowFor(v, "/elsewhere/notes.txt")).toBe(null);
    expect(rowFor(v, `${TOP}/clean.txt`)).toBe(null);
  });

  test("writeBase keeps other projects and drops a default choice", () => {
    const a = projectKey(null, "/r/a/.git");
    const b = projectKey("macmini", "/r/b/.git");
    let s = writeBase({}, a, { ref: "v1", mode: "tip" });
    s = writeBase(s, b, { ref: null, mode: "tip" });
    expect(readBase(s, a)).toEqual({ ref: "v1", mode: "tip" });
    expect(readBase(s, b)).toEqual({ ref: null, mode: "tip" });
    expect(writeBase(s, a, { ref: null, mode: "merge-base" })).toEqual({ [b]: { ref: null, mode: "tip" } });
    expect(readBase("junk", a)).toEqual({ ref: null, mode: "merge-base" });
  });

  test("helper arguments", () => {
    const sel = {
      section: /** @type {const} */ ("staged"),
      path: "new-name.txt",
      oldPath: "old-name.txt",
      untracked: false,
    };
    expect(filesArgs("/w", { ref: "v1", mode: "tip" }, sel)).toEqual([
      "diff",
      "files",
      "--path",
      "/w",
      "--mode",
      "tip",
      "--base",
      "v1",
      "--select",
      "staged",
      "--file",
      "new-name.txt",
      "--old",
      "old-name.txt",
    ]);
    expect(filesArgs("/w", { ref: null, mode: "merge-base" }, null, { since: null }).slice(-1)).toEqual(["--watch"]);
    expect(filesArgs("/w", { ref: null, mode: "merge-base" }, null, { since: "a.1.k" }).slice(-3)).toEqual([
      "--watch",
      "--since",
      "a.1.k",
    ]);
    expect(watchAnswer([{ type: "diff-unchanged", token: "a.1.k" }])).toEqual({ unchanged: true, token: "a.1.k" });
    expect(watchAnswer([...FILES, { type: "diff-token", token: "a.2.k" }])).toEqual({
      unchanged: false,
      token: "a.2.k",
    });
    expect(watchAnswer(FILES)).toEqual({ unchanged: false, token: null });
    expect(patchArgs("/w", { ...sel, section: "committed" }, { from: null, to: "h" }, 0)).toBe(null);
    expect(
      patchArgs("/w", { section: "changes", path: "f", oldPath: null, untracked: true }, { from: null, to: null }, 2),
    ).toEqual(["diff", "patch", "--path", "/w", "--section", "changes", "--file", "f", "--untracked", "--page", "2"]);
  });

  test("isShown is right-body showing changes with nothing above it hidden", () => {
    const l = structuredClone(fake.layout);
    expect(isShown(l)).toBe(false);
    showInLayout("changes", l);
    expect(isShown(l)).toBe(true);
    showInLayout("browser", l);
    expect(isShown(l)).toBe(false);
    showInLayout("changes", l);
    const hide = (/** @type {any} */ n) => {
      if (n.id === "right") n.hidden = true;
      for (const c of n.children ?? []) hide(c);
    };
    hide(l);
    expect(isShown(l)).toBe(false);
  });

  test("tab props and the tab's machine", () => {
    const t = /** @type {any} */ (
      readTab({ tab: true, space: "sp9", machine: "macmini", window: "w1", top: "/w", section: "changes", file: "a" })
    );
    expect(t).toMatchObject({ section: "changes", file: "a", untracked: false, mode: "merge-base" });
    expect(readTab({ tab: true, space: "sp9", top: "/w", section: "nope", file: "a" })).toBe(null);
    expect(tabMachine(t, "w1", [])).toEqual({ ok: true, machine: "macmini" });
    expect(tabMachine(t, "w2", [{ id: "sp9", machine: null }])).toEqual({ ok: true, machine: null });
    expect(tabMachine({ ...t, space: "macmini/sp9" }, "w2", [{ id: "sp9", machine: null }])).toEqual({
      ok: true,
      machine: null,
    });
    expect(tabMachine(t, "w2", [{ id: "sp1", machine: null }])).toEqual({ ok: false });
  });
});

describe("panel", () => {
  test("local panel reads once and watches the worktree", async () => {
    const m = await panel();
    expect(calls(m, "files")).toHaveLength(1);
    expect(calls(m, "files")[0]).toEqual({ args: ["diff", "files", "--path", TOP, "--mode", "merge-base"], on: null });
    expect(m.log.watch).toContain(TOP);
    const text = textOf(m.el);
    expect(text).toContain("feat");
    expect(text).toContain("origin/main");
    expect(text).toContain("Staged");
    expect(text).not.toContain("Committed on branch");
    expect(byId(m.el, "diff-file-changes-notes.txt")).not.toBe(null);
    expect(textOf(byId(m.el, "diff-file-changes-notes.txt"))).toBe("M notes.txt +2 −1");
    expect(textOf(byId(m.el, "diff-file-staged-new-name.txt"))).toContain("from old-name.txt");
    expect(textOf(byId(m.el, "diff-file-changes-blob.dat"))).toContain("binary");
    await m.click("diff-scope-branch");
    expect(textOf(m.el)).toContain("Committed on branch");
    expect(byId(m.el, "diff-file-committed-feature.txt")).not.toBe(null);
  });

  test("a linked worktree's common dir is watched too", async () => {
    const linked = FILES.map((l) => (l.type === "diff-place" ? { ...l, common_dir: "/r/main/.git" } : l));
    const m = await panel({ answers: { "diff files": linked } });
    m.render();
    await m.cx.flush();
    expect(m.log.watch).toContain("/r/main/.git");
  });

  test("a file click loads its patch and shows line numbers", async () => {
    const m = await panel();
    await m.click("diff-file-changes-notes.txt");
    await m.cx.flush();
    m.render();
    expect(calls(m, "patch").map((c) => c.args)).toEqual([
      ["diff", "patch", "--path", TOP, "--section", "changes", "--file", "notes.txt"],
    ]);
    const pane = byId(m.el, "diff-patch");
    expect(textOf(pane)).toContain("notes.txt");
    expect(textOf(pane)).toContain("2 − two");
    expect(textOf(pane)).toContain("2 + two changed");
    expect(textOf(pane)).toContain("4 + four");
  });

  test("an unchanged digest does not reload the patch; a new one does", async () => {
    let digest = PATCH[0].digest;
    const files = (/** @type {string[]} */ args) =>
      out(
        args.includes("--select")
          ? [
              ...FILES.filter((l) => l.type !== "diff-digest"),
              { type: "diff-digest", section: "changes", path: "notes.txt", digest, bytes: 1 },
            ]
          : FILES,
      );
    const m = await panel({ machine: "macmini", answers: { "diff files": files, "diff patch": PATCH } });
    await m.click("diff-file-changes-notes.txt");
    await m.cx.flush();
    setSystemTime(new Date());
    await runFor(m, 3100);
    expect(calls(m, "patch")).toHaveLength(1);
    digest = "0000000000000000";
    await runFor(m, 1600);
    expect(calls(m, "patch")).toHaveLength(2);
  });

  test("selected file gone clears the patch", async () => {
    let gone = false;
    const files = () => out(gone ? FILES.filter((l) => l.path !== "notes.txt") : FILES);
    const m = await panel({ machine: "macmini", answers: { "diff files": files, "diff patch": PATCH } });
    await m.click("diff-file-changes-notes.txt");
    await m.cx.flush();
    gone = true;
    setSystemTime(new Date());
    await runFor(m, 1600);
    expect(byId(m.el, "diff-patch")).toBe(null);
    expect(textOf(byId(m.el, "diff-note"))).toBe("notes.txt has no changes now");
    await m.click("diff-file-changes-fresh.txt");
    await m.cx.flush();
    expect(calls(m, "patch").at(-1)?.args).toContain("--untracked");
  });

  test("not a git folder", async () => {
    const err = [{ type: "error", code: "not_git", message: "/tmp/x is not in a Git worktree" }];
    const m = await panel({ cwd: "/tmp/x", answers: { "diff files": () => ({ ...out(err), code: 1 }) } });
    expect(textOf(byId(m.el, "diff-state"))).toBe("Not a Git repository");
  });

  test("no default base opens the picker with the repository's refs on Branch scope", async () => {
    const m = await panel({ cwd: NB_TOP, answers: { "diff files": NOBASE, "diff refs": REFS } });
    await m.click("diff-scope-branch");
    m.render();
    await m.cx.flush();
    m.render();
    expect(byId(m.el, "diff-picker")).not.toBe(null);
    expect(textOf(byId(m.el, "diff-picker"))).toContain("Pick a base for Committed on branch");
    expect(calls(m, "refs")).toHaveLength(1);
    expect(byId(m.el, "diff-ref-tag-v1")).not.toBe(null);
    expect(textOf(byId(m.el, "diff-hint-committed"))).toBe("Pick a base to compare the branch against");
  });

  test("a typed ref is verified, then stored under projectKey and used", async () => {
    const verify = (/** @type {string[]} */ a) =>
      a.includes("--verify")
        ? out([{ type: "diff-ref-ok", ref: "v1", commit: "abc", short: "abc", time: 1 }])
        : out(REFS);
    const m = await panel({ answers: { "diff files": FILES, "diff refs": verify } });
    await m.click("diff-base-button");
    await m.cx.flush();
    const view = /** @type {any} */ (m.view);
    view.filter.set_value("feat~1");
    view.filter.handlers.submit({}, m.cx);
    await m.cx.flush();
    expect(calls(m, "refs").at(-1)?.args).toEqual(["diff", "refs", "--path", TOP, "--verify", "feat~1"]);
    expect(fake.shared[BASE_KEY]).toEqual({ [projectKey(null, COMMON)]: { ref: "feat~1", mode: "merge-base" } });
    m.render();
    await m.cx.flush();
    expect(calls(m, "files").at(-1)?.args).toEqual([
      "diff",
      "files",
      "--path",
      TOP,
      "--mode",
      "merge-base",
      "--base",
      "feat~1",
    ]);
  });

  test("a refused ref stays unstored and says why", async () => {
    const refuse = (/** @type {string[]} */ a) =>
      a.includes("--verify")
        ? { ...out([{ type: "error", code: "bad_ref", message: "nope is not a commit in this repository" }]), code: 1 }
        : out(REFS);
    const m = await panel({ answers: { "diff files": FILES, "diff refs": refuse } });
    await m.click("diff-base-button");
    await m.cx.flush();
    const view = /** @type {any} */ (m.view);
    view.filter.set_value("nope");
    view.filter.handlers.submit({}, m.cx);
    await m.cx.flush();
    m.render();
    expect(fake.shared[BASE_KEY]).toBe(undefined);
    expect(textOf(byId(m.el, "diff-picker"))).toContain("nope is not a commit in this repository");
  });

  test("Merge base / Tip switch stores the mode and reads with --mode tip", async () => {
    const m = await panel();
    await m.click("diff-mode-tip");
    await m.cx.flush();
    expect(fake.shared[BASE_KEY]).toEqual({ [projectKey(null, COMMON)]: { ref: null, mode: "tip" } });
    m.render();
    await m.cx.flush();
    expect(calls(m, "files").at(-1)?.args).toEqual(["diff", "files", "--path", TOP, "--mode", "tip"]);
  });

  test("Fetch runs only on click, then reads again", async () => {
    const m = await panel({
      answers: { "diff files": FILES, "diff fetch": [{ type: "diff-fetched", remote: "origin" }] },
    });
    expect(calls(m, "fetch")).toHaveLength(0);
    const before = calls(m, "files").length;
    await m.click("diff-fetch");
    await m.cx.flush();
    expect(calls(m, "fetch").map((c) => c.args)).toEqual([["diff", "fetch", "--path", TOP, "--base", "origin/main"]]);
    m.render();
    await m.cx.flush();
    expect(calls(m, "files").length).toBe(before + 1);
    expect(textOf(byId(m.el, "diff-note"))).toBe("Fetched origin");
  });

  test("Open as tab runs tab.new with the window id", async () => {
    const m = await panel({ shared: { "bw.window-id": "w-mini" } });
    await m.click("diff-scope-branch");
    await m.click("diff-file-committed-feature.txt");
    await m.cx.flush();
    m.render();
    await m.click("diff-open-tab");
    const base = FILES.find((l) => l.type === "diff-base");
    expect(m.log.run.filter(([c]) => c === "tab.new")).toEqual([
      [
        "tab.new",
        {
          name: "feature.txt · diff",
          space: "s1",
          mod: "bw-diff",
          props: {
            tab: true,
            space: "s1",
            machine: null,
            window: "w-mini",
            top: TOP,
            section: "committed",
            file: "feature.txt",
            old: null,
            untracked: false,
            from: base.from,
            to: FILES[0].head,
            base: "origin/main",
            mode: "merge-base",
          },
        },
      ],
    ]);
  });

  test("a reveal selects the file and is dropped", async () => {
    const m = await panel({ shared: { "bw.diff.reveal": { s1: { file: `${TOP}/fresh.txt`, at: 5 } } } });
    m.render();
    await m.cx.flush();
    m.render();
    expect(fake.shared["bw.diff.reveal"]).toEqual({});
    expect(calls(m, "patch").at(-1)?.args).toEqual([
      "diff",
      "patch",
      "--path",
      TOP,
      "--section",
      "changes",
      "--file",
      "fresh.txt",
      "--untracked",
    ]);
    expect(byId(m.el, "diff-file-changes-fresh.txt-bar")).not.toBe(null);
  });

  test("a reveal naming an unchanged file says so", async () => {
    const m = await panel({ shared: { "bw.diff.reveal": { s1: { file: `${TOP}/clean.txt`, at: 5 } } } });
    m.render();
    expect(textOf(byId(m.el, "diff-note"))).toBe("No changes in clean.txt");
    expect(fake.shared["bw.diff.reveal"]).toEqual({});
  });
});

describe("polling (done check E)", () => {
  for (const machine of [null, "macmini"]) {
    test(`hidden panel makes no helper call in 12 s (${machine ?? "local"})`, async () => {
      setSystemTime(new Date(1_794_009_600_000));
      /** @type {((paths: string[]) => void)[]} */
      const waiting = [];
      const watch = () => new Promise((resolve) => waiting.push(resolve));
      const m = await panel({ machine, hidden: true, watch });
      await runFor(m, 12000, { draw: false });
      for (const w of waiting.splice(0)) w([`${TOP}/notes.txt`]);
      await m.cx.flush();
      await runFor(m, 12000, { draw: false });
      expect(m.log.exec).toHaveLength(0);
    });

    test(`a copy hidden without a render calls no more (${machine ?? "local"})`, async () => {
      setSystemTime(new Date(1_794_009_600_000));
      /** @type {((paths: string[]) => void)[]} */
      const waiting = [];
      const watch = () => new Promise((resolve) => waiting.push(resolve));
      const m = await panel({ machine, watch });
      const first = calls(m, "files").length;
      expect(first).toBe(1);
      // The render after the first read drew the copy, so the next due read still runs; it finds no
      // render after it and parks the loop.
      for (const w of waiting.splice(0)) w([`${TOP}/notes.txt`]);
      await m.cx.flush();
      await runFor(m, 12000, { draw: false });
      const settled = calls(m, "files").length;
      expect(settled).toBeLessThanOrEqual(first + 1);
      for (const w of waiting.splice(0)) w([`${TOP}/notes.txt`]);
      await m.cx.flush();
      await runFor(m, 12000, { draw: false });
      expect(calls(m, "files").length).toBe(settled);
      m.render();
      await m.cx.flush();
      expect(calls(m, "files").length).toBe(settled + 1);
    });
  }

  for (const machine of [null, "macmini"]) {
    test(`a panel hidden by a stack switch calls nothing more (${machine ?? "local"})`, async () => {
      setSystemTime(new Date(1_794_009_600_000));
      /** @type {((paths: string[]) => void)[]} */
      const waiting = [];
      const m = await panel({ machine, watch: () => new Promise((resolve) => waiting.push(resolve)) });
      const first = calls(m, "files").length;
      // A render after the last result, then the strip selects Browser with no render of this copy.
      m.render();
      showInLayout("browser");
      for (const w of waiting.splice(0)) w([`${TOP}/notes.txt`]);
      await m.cx.flush();
      await runFor(m, 12000, { draw: false });
      expect(calls(m, "files").length).toBe(first);
      expect(calls(m, "patch")).toHaveLength(0);
    });
  }

  test("shown remote panel calls diff files every 1.5 s, start to start", async () => {
    setSystemTime(new Date(1_794_009_600_000));
    const m = await panel({ machine: "macmini" });
    const starts = [];
    const files = /** @type {any} */ (fake).exec;
    fake.exec = async (/** @type {string} */ c, /** @type {string[]} */ a, /** @type {any} */ o) => {
      if (a[3] === "diff" && a[4] === "files") starts.push(Date.now());
      return files(c, a, o);
    };
    await runFor(m, 12000);
    expect(calls(m, "files").every((c) => c.on === "macmini")).toBe(true);
    // The read at mount, then one every 1.5 s: 8 starts in 12 s.
    expect(calls(m, "files")).toHaveLength(8);
    expect(starts).toHaveLength(7);
    expect(starts.slice(1).map((s, i) => s - starts[i])).toEqual(Array(6).fill(1500));
  });

  test("a shown remote panel sends the watcher's token and keeps its rows while nothing changed", async () => {
    setSystemTime(new Date(1_794_009_600_000));
    let n = 0;
    const m = await panel({
      machine: "macmini",
      answers: {
        "diff files": () => {
          n++;
          // A full read with a token, three unchanged answers, then an edit and a new token.
          if (n === 1) return out([...FILES, { type: "diff-token", token: "w.0.k" }]);
          if (n <= 4) return out([{ type: "diff-unchanged", token: "w.0.k" }]);
          if (n === 5) return out([...FILES, { type: "diff-token", token: "w.1.k" }]);
          return out([{ type: "diff-unchanged", token: "w.1.k" }]);
        },
        "diff patch": PATCH,
        "diff refs": REFS,
      },
    });
    await runFor(m, 10000);
    const sent = calls(m, "files").map((c) => {
      const i = c.args.indexOf("--since");
      return [c.args.includes("--watch"), i === -1 ? null : c.args[i + 1]];
    });
    expect(sent).toEqual([
      [true, null],
      [true, "w.0.k"],
      [true, "w.0.k"],
      [true, "w.0.k"],
      [true, "w.0.k"],
      [true, "w.1.k"],
      [true, "w.1.k"],
    ]);
    expect(textOf(byId(m.el, "diff-file-changes-notes.txt"))).toBe("M notes.txt +2 −1");
  });

  test("an unchanged answer with no list makes the next read a full one", async () => {
    setSystemTime(new Date(1_794_009_600_000));
    const m = await panel({
      machine: "macmini",
      answers: { "diff files": [{ type: "diff-unchanged", token: "w.0.k" }], "diff patch": PATCH, "diff refs": REFS },
    });
    await runFor(m, 3000);
    expect(calls(m, "files").every((c) => !c.args.includes("--since"))).toBe(true);
    expect(calls(m, "files").length).toBeGreaterThan(1);
  });

  test("a local panel never asks for the helper's watcher", async () => {
    setSystemTime(new Date(1_794_009_600_000));
    /** @type {((paths: string[]) => void)[]} */
    const waiting = [];
    const m = await panel({
      watch: () => new Promise((resolve) => waiting.push(resolve)),
      answers: {
        "diff files": [...FILES, { type: "diff-token", token: "w.0.k" }],
        "diff patch": PATCH,
        "diff refs": REFS,
      },
    });
    await runFor(m, 3000);
    for (const w of waiting.splice(0)) w([`${TOP}/notes.txt`]);
    await m.cx.flush();
    m.render();
    await m.cx.flush();
    expect(calls(m, "files")).toHaveLength(2);
    expect(calls(m, "files").every((c) => !c.args.includes("--watch"))).toBe(true);
  });

  test("shown local panel reads on a watch event and not on a timer", async () => {
    setSystemTime(new Date(1_794_009_600_000));
    /** @type {((paths: string[]) => void)[]} */
    const waiting = [];
    const m = await panel({ watch: () => new Promise((resolve) => waiting.push(resolve)) });
    await runFor(m, 12000);
    expect(calls(m, "files")).toHaveLength(1);
    for (const w of waiting.splice(0)) w([`${TOP}/notes.txt`]);
    await m.cx.flush();
    m.render();
    await m.cx.flush();
    expect(calls(m, "files")).toHaveLength(2);
  });
});

describe("tab", () => {
  const props = {
    tab: true,
    space: "sp9",
    machine: "macmini",
    window: "w-mini",
    top: TOP,
    section: "committed",
    file: "feature.txt",
    old: null,
    untracked: false,
    from: "aaa",
    to: "bbb",
    base: "origin/main",
    mode: "tip",
  };

  /** @param {string | null} windowId @param {any[]} spaces */
  async function tab(windowId, spaces) {
    const m = await mount("bw-diff", {
      props,
      live: { spaces, exec: bw({ "diff patch": PATCH }), shared: windowId ? { "bw.window-id": windowId } : {} },
    });
    await m.cx.flush();
    m.render();
    return m;
  }

  test("tab loads its patch with the props' section and range, once", async () => {
    const m = await tab("w-mini", []);
    expect(calls(m, "patch")).toEqual([
      {
        args: [
          "diff",
          "patch",
          "--path",
          TOP,
          "--section",
          "committed",
          "--file",
          "feature.txt",
          "--from",
          "aaa",
          "--to",
          "bbb",
        ],
        on: "macmini",
      },
    ]);
    expect(textOf(m.el)).toContain("Committed on branch · tip of origin/main · aaa..bbb · macmini");
    m.render();
    await m.cx.flush();
    expect(calls(m, "patch")).toHaveLength(1);
    await m.click("diff-tab-refresh");
    await m.cx.flush();
    expect(calls(m, "patch")).toHaveLength(2);
  });

  test("tab from another window resolves the machine by space id", async () => {
    const m = await tab("w-book", [{ id: "sp9", machine: null, active: true, tabs: [] }]);
    expect(calls(m, "patch")[0]?.on).toBe(null);
    const lost = await tab("w-book", []);
    expect(calls(lost, "patch")).toHaveLength(0);
    expect(textOf(lost.el)).toBe("Open this diff again from Changes in this window");
  });
});

describe("review fixes", () => {
  /** A promise and the function that settles it, for a helper answer held back. */
  function held() {
    /** @type {(v: any) => void} */
    let release = () => {};
    const p = new Promise((r) => (release = r));
    return { p, release };
  }

  test("a reveal for a file changed while Changes was hidden waits for a fresh list", async () => {
    const t0 = 1_794_009_600_000;
    setSystemTime(new Date(t0));
    let list = FILES.filter((l) => l.path !== "fresh.txt");
    const m = await panel({ answers: { "diff files": () => out(list), "diff patch": PATCH } });
    showInLayout("browser");
    m.render();
    list = FILES;
    fake.shared["bw.diff.reveal"] = { s1: { file: `${TOP}/fresh.txt`, at: t0 + 10 } };
    setSystemTime(new Date(t0 + 20));
    showInLayout("changes");
    m.render();
    expect(byId(m.el, "diff-note")).toBe(null);
    for (let i = 0; i < 4; i++) {
      await m.cx.flush();
      m.render();
    }
    expect(fake.shared["bw.diff.reveal"]).toEqual({});
    expect(calls(m, "patch").at(-1)?.args).toContain("fresh.txt");
    expect(byId(m.el, "diff-file-changes-fresh.txt-bar")).not.toBe(null);
  });

  test("a selected file staged in place gets its new flags and patch", async () => {
    let tracked = false;
    const files = () => out(tracked ? FILES.map((l) => (l.path === "fresh.txt" ? { ...l, status: "M" } : l)) : FILES);
    const m = await panel({ machine: "macmini", answers: { "diff files": files, "diff patch": PATCH } });
    await m.click("diff-file-changes-fresh.txt");
    await m.cx.flush();
    expect(calls(m, "patch").at(-1)?.args).toContain("--untracked");
    tracked = true;
    setSystemTime(new Date());
    await runFor(m, 1600);
    expect(calls(m, "patch").at(-1)?.args).not.toContain("--untracked");
  });

  test("an answer for another worktree is not shown for the same file name", async () => {
    const first = held();
    let n = 0;
    const patch = () => (++n === 1 ? first.p : out([{ ...PATCH[0], text: "diff --git a/b b/b\n" }]));
    const m = await panel({ answers: { "diff files": FILES, "diff patch": patch } });
    await m.click("diff-file-changes-notes.txt");
    const view = /** @type {any} */ (m.view);
    view.view = { ...view.view, place: { ...view.view.place, top: "/elsewhere" } };
    first.release(out([{ ...PATCH[0], text: "FROM THE FIRST WORKTREE\n" }]));
    await m.cx.flush();
    m.render();
    expect(textOf(m.el)).not.toContain("FROM THE FIRST WORKTREE");
    expect(calls(m, "patch").length).toBe(2);
  });

  test("a newer digest that lands while a patch loads reloads it", async () => {
    const first = held();
    let n = 0;
    let digest = PATCH[0].digest;
    const files = (/** @type {string[]} */ args) =>
      out(
        args.includes("--select")
          ? [
              ...FILES.filter((l) => l.type !== "diff-digest"),
              { type: "diff-digest", section: "changes", path: "notes.txt", digest, bytes: 1 },
            ]
          : FILES,
      );
    const patch = () => (++n === 1 ? first.p : out(PATCH));
    const m = await panel({ machine: "macmini", answers: { "diff files": files, "diff patch": patch } });
    await m.click("diff-file-changes-notes.txt");
    digest = "ffffffffffffffff";
    setSystemTime(new Date());
    await runFor(m, 1600);
    first.release(out(PATCH));
    await m.cx.flush();
    expect(n).toBe(2);
  });

  test("a typed ref verified after a space switch is stored for the space it was typed in", async () => {
    const verify = held();
    const refs = (/** @type {string[]} */ a) => (a.includes("--verify") ? verify.p : out(REFS));
    const m = await panel({ answers: { "diff files": FILES, "diff refs": refs } });
    await m.click("diff-base-button");
    await m.cx.flush();
    const view = /** @type {any} */ (m.view);
    view.filter.set_value("feat~1");
    view.filter.handlers.submit({}, m.cx);
    view.want = { ...view.want, project: projectKey("macmini", "/r/b/.git") };
    verify.release(out([{ type: "diff-ref-ok", ref: "feat~1", commit: "abc", short: "abc", time: 1 }]));
    await m.cx.flush();
    expect(fake.shared[BASE_KEY]).toEqual({ [projectKey(null, COMMON)]: { ref: "feat~1", mode: "merge-base" } });
  });

  test("pages of two versions are never joined", async () => {
    const tab = await mount("bw-diff", {
      props: {
        tab: true,
        space: "s1",
        machine: null,
        window: "w",
        top: TOP,
        section: "changes",
        file: "big.txt",
        untracked: true,
      },
      live: {
        shared: { "bw.window-id": "w" },
        exec: bw({
          "diff patch": (/** @type {string[]} */ a) =>
            a.includes("--page")
              ? out([{ type: "diff-patch", page: 1, pages: 2, bytes: 9, digest: "v2", text: "+v2 line 2\n", cut: [] }])
              : out([
                  {
                    type: "diff-patch",
                    page: 0,
                    pages: 2,
                    bytes: 9,
                    digest: "v1",
                    text: "@@ -0,0 +1,2 @@\n+v1 line 1\n",
                    cut: [],
                  },
                ]),
        }),
      },
    });
    await tab.cx.flush();
    tab.render();
    await tab.click("diff-tab-patch-more");
    await tab.cx.flush();
    tab.render();
    expect(textOf(tab.el)).not.toContain("v2 line 2");
    expect(calls(tab, "patch").map((c) => c.args.includes("--page"))).toEqual([false, true, false]);
  });

  test("a patch wanted while a refs read runs waits until Changes is shown again", async () => {
    const refs = held();
    const m = await panel({
      machine: "macmini",
      answers: { "diff files": FILES, "diff refs": () => refs.p, "diff patch": PATCH },
    });
    await m.click("diff-base-button");
    await m.click("diff-file-changes-notes.txt");
    showInLayout("browser");
    refs.release(out(REFS));
    await m.cx.flush();
    expect(calls(m, "patch")).toHaveLength(0);
    showInLayout("changes");
    m.render();
    await m.cx.flush();
    expect(calls(m, "patch")).toHaveLength(1);
  });

  test("a failed reload shows its error over the old patch, and the same digest is not retried", async () => {
    let digest = PATCH[0].digest;
    let fail = false;
    const files = (/** @type {string[]} */ args) =>
      out(
        args.includes("--select")
          ? [
              ...FILES.filter((l) => l.type !== "diff-digest"),
              { type: "diff-digest", section: "changes", path: "notes.txt", digest, bytes: 1 },
            ]
          : FILES,
      );
    const patch = () =>
      fail
        ? { ...out([{ type: "error", code: "too_large", message: "the patch is over 256 MiB" }]), code: 1 }
        : out(PATCH);
    const m = await panel({ machine: "macmini", answers: { "diff files": files, "diff patch": patch } });
    await m.click("diff-file-changes-notes.txt");
    await m.cx.flush();
    fail = true;
    digest = "too_large";
    setSystemTime(new Date());
    await runFor(m, 6100);
    expect(textOf(byId(m.el, "diff-patch-error"))).toContain("over 256 MiB");
    expect(textOf(byId(m.el, "diff-patch"))).toContain("two changed");
    expect(calls(m, "patch")).toHaveLength(2);
  });

  test("the picker lists refs again on every open and after Fetch", async () => {
    const m = await panel({
      answers: { "diff files": FILES, "diff refs": REFS, "diff fetch": [{ type: "diff-fetched", remote: "origin" }] },
    });
    await m.click("diff-base-button");
    await m.cx.flush();
    await m.click("diff-base-button");
    await m.click("diff-base-button");
    await m.cx.flush();
    expect(calls(m, "refs")).toHaveLength(2);
    await m.click("diff-fetch");
    await m.cx.flush();
    m.render();
    await m.cx.flush();
    expect(calls(m, "refs")).toHaveLength(3);
  });

  test("a picker row stores its full ref, so a branch and a tag of one name stay apart", async () => {
    const both = [
      { type: "diff-ref", name: "release", ref: "refs/heads/release", kind: "branch", short: "aaa", time: 1 },
      { type: "diff-ref", name: "release", ref: "refs/tags/release", kind: "tag", short: "bbb", time: 1 },
    ];
    const m = await panel({ answers: { "diff files": FILES, "diff refs": both } });
    await m.click("diff-base-button");
    await m.cx.flush();
    m.render();
    await m.click("diff-ref-branch-release");
    expect(fake.shared[BASE_KEY]).toEqual({
      [projectKey(null, COMMON)]: { ref: "refs/heads/release", mode: "merge-base" },
    });
  });

  test("tabMachine in another window takes the one space matching past the machine prefix, and refuses two", () => {
    const t = /** @type {any} */ (
      readTab({
        tab: true,
        space: "macmini/sp9",
        machine: "macmini",
        window: null,
        top: "/w",
        section: "changes",
        file: "a",
      })
    );
    const both = [
      { id: "sp9", machine: null },
      { id: "macmini/sp9", machine: "macmini" },
    ];
    expect(tabMachine(t, null, both.slice(1))).toEqual({ ok: true, machine: "macmini" });
    expect(tabMachine(t, null, both)).toEqual({ ok: false });
    expect(
      tabMachine({ ...t, space: "sp9", window: "w1" }, "w2", [
        { id: "macbook/sp9", machine: "macbook" },
        ...both.slice(1),
      ]),
    ).toEqual({ ok: false });
    // macmini's own sp9, opened there, rendered in a window whose local sp9 is another space.
    const fromMini = { ...t, space: "sp9", machine: null, window: "w-mini" };
    expect(tabMachine(fromMini, "w-book", both)).toEqual({ ok: false });
    expect(tabMachine(fromMini, "w-book", both.slice(1))).toEqual({ ok: true, machine: "macmini" });
  });

  test("picking A, B, then A while A's next page loads drops that page and loads A again", async () => {
    const page1 = held();
    /** @param {string[]} a */
    const patch = (a) => {
      const file = a[a.indexOf("--file") + 1];
      const page = a.includes("--page") ? Number(a[a.indexOf("--page") + 1]) : 0;
      if (file === "notes.txt" && page === 1) return page1.p;
      return out([
        {
          type: "diff-patch",
          page,
          pages: 2,
          bytes: 9,
          digest: `d-${file}`,
          text: `@@ -1 +1 @@\n+${file} p${page}\n`,
          cut: [],
        },
      ]);
    };
    const m = await panel({ machine: "macmini", answers: { "diff files": FILES, "diff patch": patch } });
    await m.click("diff-file-changes-notes.txt");
    await m.click("diff-patch-more");
    await m.click("diff-file-changes-gone.txt");
    await m.click("diff-file-changes-notes.txt");
    page1.release(
      out([{ type: "diff-patch", page: 1, pages: 2, bytes: 9, digest: "d-notes.txt", text: "+late\n", cut: [] }]),
    );
    await m.cx.flush();
    m.render();
    const text = textOf(byId(m.el, "diff-patch"));
    expect(text).toContain("notes.txt p0");
    expect(text).not.toContain("late");
    expect(byId(m.el, "diff-note")).toBe(null);
    await m.click("diff-file-changes-fresh.txt");
    expect(textOf(byId(m.el, "diff-patch"))).toContain("fresh.txt p0");
  });

  test("the work loop keeps serving patches after one task throws", async () => {
    const m = await panel({ answers: { "diff files": FILES, "diff patch": PATCH } });
    const view = /** @type {any} */ (m.view);
    const load = view.loadPatch;
    view.loadPatch = async () => {
      view.loadPatch = load;
      throw new Error("boom");
    };
    await m.click("diff-file-changes-notes.txt");
    expect(calls(m, "patch")).toHaveLength(0);
    expect(textOf(byId(m.el, "diff-note"))).toContain("boom");
    await m.click("diff-file-changes-fresh.txt");
    expect(calls(m, "patch").at(-1)?.args).toContain("fresh.txt");
  });

  test("clicking the selected file again retries a failed patch read", async () => {
    let fail = false;
    const patch = () =>
      fail
        ? {
            ...out([{ type: "error", code: "ssh", message: "ssh: connect to host tsuki: Connection refused" }]),
            code: 1,
          }
        : out(PATCH);
    const m = await panel({ machine: "macmini", answers: { "diff files": FILES, "diff patch": patch } });
    fail = true;
    await m.click("diff-file-changes-notes.txt");
    expect(textOf(byId(m.el, "diff-patch"))).toContain("Connection refused");
    fail = false;
    await m.click("diff-file-changes-notes.txt");
    expect(calls(m, "patch")).toHaveLength(2);
    expect(textOf(byId(m.el, "diff-patch"))).toContain("two changed");
    expect(textOf(byId(m.el, "diff-patch"))).not.toContain("Connection refused");
    await m.click("diff-file-changes-notes.txt");
    expect(calls(m, "patch")).toHaveLength(2);
  });
});

describe("scopes, line comments, and preflight (Task 10)", () => {
  test("model and comments pure helpers: scope mapping, row keys, +-5 relocation, and formatting", () => {
    expect(sectionsForScope("uncommitted")).toEqual(["staged", "changes"]);
    expect(sectionsForScope("branch")).toEqual(["committed"]);
    expect(sectionsForScope("pr")).toEqual(["committed"]);

    expect(prBaseChoice({ state: "OPEN", baseRefName: "release" }, { ref: null, mode: "tip" })).toEqual({
      ref: "origin/release",
      mode: "merge-base",
      fromPr: true,
    });
    expect(prBaseChoice(null, { ref: "v1", mode: "tip" })).toEqual({
      ref: "v1",
      mode: "tip",
      fromPr: false,
    });

    const rows = patchRows(["diff --git a/x b/x", "@@ -1,2 +1,2 @@", " ctx", "-old", "+new", ""].join("\n"));
    const keys = patchRowKeys("deadbeef12345678", rows);
    expect(keys).toEqual([
      "deadbeef12345678:meta:null:null:0",
      "deadbeef12345678:hunk:null:null:1",
      "deadbeef12345678:ctx:1:1",
      "deadbeef12345678:del:2:null",
      "deadbeef12345678:add:null:2",
    ]);
    expect(parseRowKey(keys[0])).toBe(null);
    expect(parseRowKey(keys[2])).toEqual({ digest: "deadbeef12345678", kind: "ctx", oldLine: 1, newLine: 1 });
    expect(parseRowKey(keys[3])).toEqual({ digest: "deadbeef12345678", kind: "del", oldLine: 2, newLine: null });
    expect(parseRowKey(keys[4])).toEqual({ digest: "deadbeef12345678", kind: "add", oldLine: null, newLine: 2 });

    const sel = { section: /** @type {const} */ ("changes"), path: "notes.txt", oldPath: null, untracked: false };
    const anchor = /** @type {any} */ (
      anchorFromRow(sel, { base: null, mode: "merge-base", from: null, to: null }, rows[4], "d1")
    );
    const list = upsertComment([], anchor, "Handle empty input", 1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: "notes.txt", side: "new", line: 2, excerpt: "new", stale: false });

    // Moved +4 lines (within +-5) with unique match updates line and stays valid.
    const moved4 = patchRows(["@@ -1,6 +1,6 @@", "+p1", "+p2", "+p3", "+p4", " ctx", "+new", ""].join("\n"));
    const r4 = revalidateComment(list[0], moved4, "d2");
    expect(r4).toMatchObject({ line: 6, patchDigest: "d2", stale: false });

    // Moved +7 lines (> 5) marks stale: true.
    const moved7 = patchRows(
      ["@@ -1,9 +1,9 @@", "+p1", "+p2", "+p3", "+p4", "+p5", "+p6", "+p7", " ctx", "+new", ""].join("\n"),
    );
    const r7 = revalidateComment(list[0], moved7, "d3");
    expect(r7.stale).toBe(true);

    // Ambiguous duplicate within +-5 lines marks stale: true.
    const dupNear = patchRows(["@@ -1,4 +1,4 @@", "+new", " ctx", "+new", ""].join("\n"));
    expect(revalidateComment(list[0], dupNear, "d4").stale).toBe(true);

    expect(formatReviewBlock([r4])).toBe(
      ["Diff review comment:", "", "1. `notes.txt:6` (new)", "> new", "Handle empty input"].join("\n"),
    );

    // Preflight across unselected targets catches a newly stale comment.
    expect(
      preflightVerifyComments(list, async () => ({ ok: true, digest: "d3", rows: moved7 })),
    ).resolves.toMatchObject({ ok: false });
  });

  test("PR scope diffs against origin/<baseRefName> from bw pr status and falls back to Branch base when absent", async () => {
    /** @type {any} */
    let prPayload = {
      number: 42,
      title: "Refine diff",
      url: "https://github.com/acme/repo/pull/42",
      state: "OPEN",
      isDraft: false,
      baseRefName: "release",
      headRefOid: FILES[0].head,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      unresolvedThreads: 0,
      passing: 3,
      failing: 0,
      pending: 0,
    };
    const baseHelper = bw({
      "diff files": (args) => {
        const bIdx = args.indexOf("--base");
        const baseRef = bIdx === -1 ? "origin/main" : args[bIdx + 1];
        return out(FILES.map((l) => (l.type === "diff-base" ? { ...l, ref: baseRef, source: "typed" } : l)));
      },
      "diff refs": REFS,
      "pr status": () => out([{ type: "pr", pr: prPayload, cached: false, age_s: 0, stale: false }]),
    });
    const execFn = async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      if (cmd === "git" && args.includes("remote.origin.url")) {
        return { code: 0, stdout: "git@github.com:acme/repo.git\n", stderr: "" };
      }
      return baseHelper(cmd, args, opts);
    };

    const m = await mount("bw-diff", {
      live: { ...world(null, TOP), exec: execFn },
    });
    showInLayout("changes");
    m.render();
    await m.cx.flush();
    m.render();

    await m.click("diff-scope-pr");
    for (let i = 0; i < 4; i++) {
      await m.cx.flush();
      m.render();
    }
    expect(calls(m, "files").at(-1)?.args).toEqual([
      "diff",
      "files",
      "--path",
      TOP,
      "--mode",
      "merge-base",
      "--base",
      "origin/release",
    ]);
    expect(textOf(m.el)).toContain("Committed in PR");

    // When no open PR exists on another branch, PR scope falls back to the Branch base picker.
    prPayload = null;
    fake.spaces[0].branch = "no-pr-branch";
    const view = /** @type {any} */ (m.view);
    view.prState = { key: "", pr: null, checkedAt: 0, repoFolder: null, repo: null };
    fake.shared[BASE_KEY] = { [projectKey(null, COMMON)]: { ref: "refs/tags/v1", mode: "tip" } };
    m.render();
    for (let i = 0; i < 4; i++) {
      await m.cx.flush();
      m.render();
    }
    expect(calls(m, "files").at(-1)?.args).toEqual([
      "diff",
      "files",
      "--path",
      TOP,
      "--mode",
      "tip",
      "--base",
      "refs/tags/v1",
    ]);
    expect(byId(m.el, "diff-mode")).not.toBe(null);
  });

  test("Done Check 5(c): on_item_click comments across two files, unselected file >5 line mutation holds send in preflight, and valid comments send or queue", async () => {
    let notesPatch = {
      type: "diff-patch",
      page: 0,
      pages: 1,
      bytes: 64,
      digest: "aaaa1111aaaa1111",
      text: [
        "diff --git a/notes.txt b/notes.txt",
        "@@ -1,2 +1,3 @@",
        " one",
        "-two",
        "+two changed",
        "+three",
        "",
      ].join("\n"),
      cut: [],
    };
    const freshPatch = {
      type: "diff-patch",
      page: 0,
      pages: 1,
      bytes: 48,
      digest: "bbbb2222bbbb2222",
      text: ["diff --git a/fresh.txt b/fresh.txt", "@@ -0,0 +1,2 @@", "+alpha", "+beta", ""].join("\n"),
      cut: [],
    };

    /** @type {any[]} */
    const sent = [];
    /** @type {any[]} */
    const queued = [];
    const answers = {
      "diff files": FILES,
      "diff patch": (/** @type {string[]} */ args) => {
        const file = args[args.indexOf("--file") + 1];
        return out([file === "notes.txt" ? notesPatch : freshPatch]);
      },
      "cards --terminal": (/** @type {string[]} */ args) => {
        if (args.length !== 3 || args[1] !== "--terminal") {
          return out([{ type: "error", code: "usage", message: `unknown option ${args[3] ?? ""}` }]);
        }
        return out([{ type: "cards", session: "sess-42", path: "/tmp/claude-sess-42.jsonl" }]);
      },
      "send --terminal": (/** @type {string[]} */ args, /** @type {string | null} */ on) => {
        sent.push({ args, on });
        return out([{ type: "send", result: "sent" }]);
      },
      "queue add": (/** @type {string[]} */ args, /** @type {string | null} */ on) => {
        queued.push({ args, on });
        return out([{ type: "queue", items: [{ id: "q1", text: args.at(-1) }], held: false, hold_reason: null }]);
      },
    };

    const liveWorld = world("macmini", TOP);
    liveWorld.panes = [
      {
        pane: "p1",
        terminal: "macmini/t1",
        tab: "tb1",
        title: "claude",
        app: "claude-code",
        program: { key: "claude" },
        cwd: TOP,
        branch: "feat",
        status: "done",
        focused: true,
      },
    ];
    liveWorld.agents = [{ pane: "p1", terminal: "macmini/t1", status: "done" }];

    const m = await mount("bw-diff", {
      live: { ...liveWorld, exec: bw(answers) },
    });
    showInLayout("changes");
    m.render();
    await m.cx.flush();
    m.render();

    // 1. Select file A (notes.txt), verify virtual list row keys and layout-handler safety, click line 2 (+two changed).
    await m.click("diff-file-changes-notes.txt");
    await m.cx.flush();
    m.render();
    const listA = byId(m.el, "diff-patch-rows");
    expect(listA).not.toBe(null);
    expect(layOut(listA, { start: 0, end: 2 })).toBe(2);
    expect(listA.attrs.keys).toContain("aaaa1111aaaa1111:add:null:2");

    // Clicking with a superseded digest does nothing.
    await fire(listA, "on_item_click", "stale0000stale00:add:null:2", m.cx);
    m.render();
    expect(byId(m.el, "diff-comment-bar")).toBe(null);

    // Clicking the live digest opens the retained composer bar below v_virtual_list; Esc cancels, Enter saves.
    await fire(listA, "on_item_click", "aaaa1111aaaa1111:add:null:2", m.cx);
    m.render();
    expect(byId(m.el, "diff-comment-bar")).not.toBe(null);
    await fire(byId(m.el, "diff-comment-bar"), "on_key_down", { keystroke: { key: "escape" } }, m.cx);
    m.render();
    expect(byId(m.el, "diff-comment-bar")).toBe(null);

    await fire(byId(m.el, "diff-patch-rows"), "on_item_click", "aaaa1111aaaa1111:add:null:2", m.cx);
    m.render();
    const view = /** @type {any} */ (m.view);
    view.commentInput.set_value("Avoid mutating notes in place");
    view.commentInput.handlers.submit({}, m.cx);
    m.render();
    expect(byId(m.el, "diff-comment-bar")).toBe(null);
    expect(textOf(byId(m.el, "diff-review-bar"))).toContain("Send 1 comment");

    // 2. Select file B (fresh.txt) and add a second comment on line 2 (+beta).
    await m.click("diff-file-changes-fresh.txt");
    await m.cx.flush();
    m.render();
    const listB = byId(m.el, "diff-patch-rows");
    await fire(listB, "on_item_click", "bbbb2222bbbb2222:add:null:2", m.cx);
    m.render();
    view.commentInput.set_value("Rename beta constant");
    m.render();
    await m.click("diff-comment-save");
    expect(textOf(byId(m.el, "diff-review-bar"))).toContain("Send 2 comments");

    // 3. While file B stays selected, mutate unselected file A on disk so A's anchor moves > 5 lines (+8 lines).
    notesPatch = {
      ...notesPatch,
      digest: "aaaa9999aaaa9999",
      text: [
        "diff --git a/notes.txt b/notes.txt",
        "@@ -1,2 +1,11 @@",
        "+pad 1",
        "+pad 2",
        "+pad 3",
        "+pad 4",
        "+pad 5",
        "+pad 6",
        "+pad 7",
        "+pad 8",
        " one",
        "-two",
        "+two changed",
        "+three",
        "",
      ].join("\n"),
    };

    await m.click("diff-comments-send");
    await m.cx.flush();
    m.render();

    // Preflight catches A's stale anchor, marks A stale, holds send, and preserves both drafts.
    expect(sent).toHaveLength(0);
    expect(queued).toHaveLength(0);
    expect(textOf(byId(m.el, "diff-note"))).toContain("Stale diff anchor (notes.txt:2)");
    expect(textOf(byId(m.el, "diff-review-bar"))).toContain("1 stale anchor");
    expect(view.worktreeComments()).toHaveLength(2);
    expect(view.worktreeComments()[0].stale).toBe(true);

    // Clicking Send again while A is still stale continues holding delivery.
    await m.click("diff-comments-send");
    await m.cx.flush();
    m.render();
    expect(sent).toHaveLength(0);

    // 4. If A moves within +-5 lines (+3 lines from original line 2 -> line 5) from a valid state, preflight relocates and sends!
    // Remove the stale comment on A, re-add on A's current line 10, then shift A by +2 lines (10 -> 12) while B is selected.
    await m.click("diff-draft-remove-0");
    await m.click("diff-file-changes-notes.txt");
    await m.cx.flush();
    m.render();
    await fire(byId(m.el, "diff-patch-rows"), "on_item_click", "aaaa9999aaaa9999:add:null:10", m.cx);
    m.render();
    view.commentInput.set_value("Avoid mutating notes in place");
    m.render();
    await m.click("diff-comment-save");
    await m.click("diff-file-changes-fresh.txt");
    await m.cx.flush();
    m.render();

    notesPatch = {
      ...notesPatch,
      digest: "aaaa7777aaaa7777",
      text: [
        "diff --git a/notes.txt b/notes.txt",
        "@@ -1,2 +1,13 @@",
        "+pad 1",
        "+pad 2",
        "+pad 3",
        "+pad 4",
        "+pad 5",
        "+pad 6",
        "+pad 7",
        "+pad 8",
        "+pad 9",
        "+pad 10",
        " one",
        "-two",
        "+two changed",
        "+three",
        "",
      ].join("\n"),
    };

    await m.click("diff-comments-send");
    await m.cx.flush();
    m.render();
    expect(sent).toHaveLength(1);
    expect(sent[0].on).toBe("macmini");
    expect(sent[0].args).toEqual([
      "send",
      "--terminal",
      "t1",
      "--expect-kind",
      "claude",
      "--expect-session",
      "sess-42",
      "--expect-path",
      "/tmp/claude-sess-42.jsonl",
      "--text",
      [
        "Diff review comments (2):",
        "",
        "1. `fresh.txt:2` (new)",
        "> beta",
        "Rename beta constant",
        "",
        "2. `notes.txt:12` (new)",
        "> two changed",
        "Avoid mutating notes in place",
      ].join("\n"),
    ]);
    expect(byId(m.el, "diff-review-bar")).toBe(null);
    expect(textOf(byId(m.el, "diff-note"))).toBe("Sent 2 comments");

    // 5. While agent is working, button switches to Queue and delivers via bw queue add on space.machine.
    fake.agents[0].status = "working";
    fake.panes[0].status = "working";
    await fire(byId(m.el, "diff-patch-rows"), "on_item_click", "bbbb2222bbbb2222:add:null:1", m.cx);
    m.render();
    view.commentInput.set_value("Check alpha bounds");
    m.render();
    await m.click("diff-comment-save");
    expect(textOf(byId(m.el, "diff-review-bar"))).toContain("Queue 1 comment");
    await m.click("diff-comments-send");
    await m.cx.flush();
    m.render();
    expect(queued).toHaveLength(1);
    expect(queued[0].on).toBe("macmini");
    expect(queued[0].args).toEqual([
      "queue",
      "add",
      "--terminal",
      "t1",
      "--kind",
      "claude",
      "--session",
      "sess-42",
      "--text",
      ["Diff review comment:", "", "1. `fresh.txt:1` (new)", "> alpha", "Check alpha bounds"].join("\n"),
    ]);
    expect(byId(m.el, "diff-review-bar")).toBe(null);
    expect(textOf(byId(m.el, "diff-note"))).toBe("Queued 1 comment");
  });

  test("committed comment preflight refreshes HEAD on same base ref and fails closed if diff files fails", async () => {
    const HEAD_OLD = FILES[0].head;
    const HEAD_NEW = "ffffffffffffffffffffffffffffffffffffffff";
    let currentHead = HEAD_OLD;
    let failFiles = false;
    /** @type {string[][]} */
    const patchCalls = [];
    /** @type {any[]} */
    const sent = [];

    const answers = {
      "diff files": () => {
        if (failFiles) return out([{ type: "error", code: "git", message: "git rev-parse failed" }]);
        return out(FILES.map((l) => (l.type === "diff-place" ? { ...l, head: currentHead } : l)));
      },
      "diff patch": (/** @type {string[]} */ args) => {
        patchCalls.push(args);
        const toSha = args[args.indexOf("--to") + 1];
        if (toSha === HEAD_OLD) {
          return out([
            {
              type: "diff-patch",
              page: 0,
              pages: 1,
              bytes: 40,
              digest: "cccc1111cccc1111",
              text: ["diff --git a/feature.txt b/feature.txt", "@@ -0,0 +1,2 @@", "+seed", "+target line", ""].join(
                "\n",
              ),
              cut: [],
            },
          ]);
        }
        return out([
          {
            type: "diff-patch",
            page: 0,
            pages: 1,
            bytes: 96,
            digest: "cccc9999cccc9999",
            text: [
              "diff --git a/feature.txt b/feature.txt",
              "@@ -0,0 +1,10 @@",
              "+p1",
              "+p2",
              "+p3",
              "+p4",
              "+p5",
              "+p6",
              "+p7",
              "+p8",
              "+seed",
              "+target line",
              "",
            ].join("\n"),
            cut: [],
          },
        ]);
      },
      "cards --terminal": (/** @type {string[]} */ args) => {
        if (args.length !== 3 || args[1] !== "--terminal") {
          return out([{ type: "error", code: "usage", message: "unknown option" }]);
        }
        return out([{ type: "cards", session: "sess-7", path: "/tmp/claude-7.jsonl" }]);
      },
      "send --terminal": (/** @type {string[]} */ args) => {
        sent.push(args);
        return out([{ type: "send", result: "sent" }]);
      },
    };

    const liveWorld = world(null, TOP);
    liveWorld.panes = [
      {
        pane: "p1",
        terminal: "t1",
        tab: "tb1",
        title: "claude",
        app: "claude-code",
        program: { key: "claude" },
        cwd: TOP,
        branch: "feat",
        status: "done",
        focused: true,
      },
    ];
    liveWorld.agents = [{ pane: "p1", terminal: "t1", status: "done" }];

    const m = await mount("bw-diff", { live: { ...liveWorld, exec: bw(answers) } });
    showInLayout("changes");
    m.render();
    await m.cx.flush();
    m.render();

    await m.click("diff-scope-branch");
    await m.click("diff-file-committed-feature.txt");
    await m.cx.flush();
    m.render();

    const view = /** @type {any} */ (m.view);
    await fire(byId(m.el, "diff-patch-rows"), "on_item_click", "cccc1111cccc1111:add:null:2", m.cx);
    m.render();
    view.commentInput.set_value("Guard committed target line");
    m.render();
    await m.click("diff-comment-save");

    // 1. Freshdiff files fails during preflight -> fails closed without falling back to stale HEAD_OLD.
    failFiles = true;
    patchCalls.length = 0;
    await m.click("diff-comments-send");
    await m.cx.flush();
    m.render();
    expect(patchCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(textOf(byId(m.el, "diff-note"))).toContain("git rev-parse failed");

    // 2. HEAD advances on the same base ref before UI refresh -> preflight queries fresh range (HEAD_NEW) and catches >5-line drift.
    failFiles = false;
    currentHead = HEAD_NEW;
    await m.click("diff-comments-send");
    await m.cx.flush();
    m.render();
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0][patchCalls[0].indexOf("--to") + 1]).toBe(HEAD_NEW);
    expect(sent).toHaveLength(0);
    expect(textOf(byId(m.el, "diff-note"))).toContain("Stale diff anchor (feature.txt:2)");
    expect(view.worktreeComments()[0].stale).toBe(true);
  });
});
