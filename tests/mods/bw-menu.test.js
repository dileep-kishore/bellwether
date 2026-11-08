import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { byId, textOf } from "../harness/kit-stub.js";
import { projectKey } from "../../shared/projects-model.js";

const STORED = {
  version: 1,
  projects: [
    { machine: null, commonDir: "/r/alpha/.git", name: "alpha", main: "/r/alpha" },
    { machine: null, commonDir: "/r/beta/.git", name: "beta", main: "/r/beta" },
    { machine: "macmini", commonDir: "/home/u/gamma/.git", name: "gamma", main: "/home/u/gamma" },
  ],
};

/** A project prop as bw-projects' projectMenu passes it. */
const project = (machine, commonDir, main, open) => ({
  key: projectKey(machine, commonDir),
  machine,
  commonDir,
  main,
  name: main?.split("/").pop() ?? "repo",
  open,
});
const beta = (open = false) => project(null, "/r/beta/.git", "/r/beta", open);
const gamma = (open = false) => project("macmini", "/home/u/gamma/.git", "/home/u/gamma", open);

const open = (p) =>
  mount("bw-menu", {
    props: { project: p, overlay: "o7" },
    live: { ...live("two-machines"), shared: { "bw.projects": structuredClone(STORED) } },
  });

/** Records which log each stub call landed in, in call order. */
function sequence(m) {
  const seq = [];
  for (const k of ["closed", "shared", "overlays", "run"]) {
    const a = m.log[k];
    const push = a.push.bind(a);
    a.push = (...x) => {
      seq.push(k);
      return push(...x);
    };
  }
  return seq;
}

describe("bw-menu", () => {
  test("rows: worktree actions, Link Linear project, Remove", async () => {
    const m = await open(beta());
    const text = textOf(m.el);
    for (const s of ["beta", "New worktree…", "Open worktree…", "Link Linear project…", "Remove"])
      expect(text).toContain(s);
    expect(text).not.toContain("coming in phase 6");
  });

  test("remove forgets exactly that key", async () => {
    const m = await open(beta());
    const seq = sequence(m);
    await m.click("menu-remove");
    expect(m.log.closed).toEqual(["o7"]);
    expect(m.log.shared).toEqual([["bw.projects", { version: 1, projects: [STORED.projects[0], STORED.projects[2]] }]]);
    expect(seq).toEqual(["closed", "shared"]);
  });

  test("remove on another machine keeps the same path on this Mac", async () => {
    const stored = structuredClone(STORED);
    stored.projects.push({ machine: null, commonDir: "/home/u/gamma/.git", name: "gamma", main: "/home/u/gamma" });
    const m = await mount("bw-menu", {
      props: { project: gamma(), overlay: "o7" },
      live: { ...live("two-machines"), shared: { "bw.projects": stored } },
    });
    await m.click("menu-remove");
    expect(m.log.shared.at(-1)[1].projects.map((p) => [p.machine, p.commonDir])).toEqual([
      [null, "/r/alpha/.git"],
      [null, "/r/beta/.git"],
      [null, "/home/u/gamma/.git"],
    ]);
  });

  test("remove is disabled while the project is open", async () => {
    const m = await open(beta(true));
    expect(textOf(byId(m.el, "menu-remove"))).toContain("close its spaces first");
    await m.click("menu-remove");
    expect(m.log.shared).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("worktree rows pass folder and machine", async () => {
    const m = await open(gamma(true));
    const seq = sequence(m);
    await m.click("menu-worktree-new");
    expect(m.log.overlays).toEqual([
      {
        mod: "worktree",
        kind: "dialog",
        width: 460,
        height: 280,
        props: { folder: "/home/u/gamma", machine: "macmini", action: "new" },
      },
    ]);
    expect(seq).toEqual(["closed", "overlays"]);

    const local = await open(beta());
    await local.click("menu-worktree-open");
    expect(local.log.overlays).toEqual([
      {
        mod: "worktree",
        kind: "dialog",
        width: 560,
        height: 480,
        props: { folder: "/r/beta", machine: null, action: "open" },
      },
    ]);
    expect(local.log.closed).toEqual(["o7"]);
  });

  test("a project with no main checkout cannot open the worktree dialog", async () => {
    const m = await open(project(null, "/r/bare.git", null, false));
    expect(textOf(byId(m.el, "menu-worktree-new"))).toContain("no main checkout");
    await m.click("menu-worktree-new");
    await m.click("menu-worktree-open");
    expect(m.log.overlays).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("Link Linear project opens bw-linear's picker for that project", async () => {
    const m = await open(gamma());
    await m.click("menu-linear");
    expect(m.log.closed).toEqual(["o7"]);
    expect(m.log.shared).toEqual([]);
    expect(m.log.overlays).toEqual([
      {
        mod: "bw-linear",
        kind: "dialog",
        width: 440,
        height: 500,
        props: { pick: { machine: "macmini", commonDir: "/home/u/gamma/.git", name: "gamma" } },
      },
    ]);
  });

  test("no project prop draws an empty menu without acting", async () => {
    const m = await mount("bw-menu", { live: live("two-machines") });
    expect(m.log.run).toEqual([]);
    expect(byId(m.el, "menu-remove")).toBe(null);
  });
});
