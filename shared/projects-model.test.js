import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildProjects,
  forgetProject,
  placeKey,
  placeOf,
  projectKey,
  readStored,
  refreshTargets,
  rememberProjects,
  worktreeKey,
} from "./projects-model.js";

const DIR = join(import.meta.dir, "..", "tests", "fixtures", "model");

/** Reads a model fixture and turns its git records into the model's keyed cache. */
function load(name, edit = (f) => f) {
  const f = edit(JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")));
  const places = {};
  for (const p of f.git.places) places[placeKey(p.machine, p.folder)] = p.not_git ? "not_git" : { commonDir: p.commonDir, top: p.top };
  const worktrees = {};
  for (const w of f.git.worktrees) worktrees[projectKey(w.machine, w.commonDir)] = { list: w.list, stale: w.stale };
  const counts = {};
  for (const { machine, path, ...c } of f.git.counts) counts[worktreeKey(machine, path)] = c;
  return {
    machines: f.machines,
    spaces: f.spaces,
    panes: f.panes,
    agents: f.agents,
    terminals: f.terminals,
    stored: f.stored,
    platform: f.platform,
    git: { places, worktrees, counts, unreachable: f.git.unreachable },
  };
}

const machineOf = (tree, name) => tree.machines.find((m) => m.name === name);
const projectOf = (tree, machine, name) => machineOf(tree, machine).projects.find((p) => p.name === name);
const rowOf = (project, path) => project.worktrees.find((w) => w.path === path);

describe("keys and places", () => {
  test("keys are [machine, value] JSON with null for this Mac", () => {
    expect(placeKey(null, "/r")).toBe('[null,"/r"]');
    expect(placeKey(undefined, "/r")).toBe('[null,"/r"]');
    expect(projectKey("macmini", "/g/.git")).toBe('["macmini","/g/.git"]');
    expect(worktreeKey(null, "/r/a")).toBe('[null,"/r/a"]');
  });

  test("place is the first pane with a cwd in tab order, else the space folder", () => {
    const input = load("two-machines");
    const s1 = input.spaces[0];
    expect(placeOf(s1, input.panes)).toBe("/r/alpha");
    const panes = input.panes.map((p) => (p.tab === "tb1" ? { ...p, cwd: null } : p));
    expect(placeOf(s1, panes)).toBe("/r/alpha/src");
    expect(placeOf(s1, [])).toBe("/r/alpha");
  });
});

describe("buildProjects", () => {
  test("three projects under two machines, closed one kept", () => {
    const tree = buildProjects(load("two-machines"));
    expect(tree.machines.map((m) => [m.name, m.label, m.state])).toEqual([
      [null, "This Mac", "ready"],
      ["macmini", "macmini", "ready"],
    ]);
    expect(machineOf(tree, null).projects.map((p) => [p.name, p.letter, p.open])).toEqual([
      ["alpha", "A", true],
      ["beta", "B", false],
    ]);
    expect(machineOf(tree, "macmini").projects.map((p) => [p.name, p.open, p.commonDir])).toEqual([["gamma", true, "/home/u/gamma/.git"]]);
    const beta = projectOf(tree, null, "beta");
    expect(beta.key).toBe(projectKey(null, "/r/beta/.git"));
    expect(beta.main).toBe("/r/beta");
    expect(beta.worktrees.every((w) => !w.open)).toBe(true);
  });

  test("label says This computer off macOS", () => {
    const tree = buildProjects({ ...load("two-machines"), platform: "linux" });
    expect(tree.machines[0].label).toBe("This computer");
  });

  test("worktree rows equal the worktree list, main first", () => {
    const alpha = projectOf(buildProjects(load("two-machines")), null, "alpha");
    expect(alpha.worktrees.map((w) => [w.path, w.branch, w.detached, w.main])).toEqual([
      ["/r/alpha", "main", false, true],
      ["/r/alpha-wt/feat", "feat", false, false],
      ["/r/alpha/.worktrees/nested", "nested", false, false],
      ["/r/alpha-wt/detached", null, true, false],
    ]);
    expect(alpha.main).toBe("/r/alpha");
    expect(alpha.checked).toBe(true);
    const feat = rowOf(alpha, "/r/alpha-wt/feat");
    expect(feat.key).toBe(worktreeKey(null, "/r/alpha-wt/feat"));
    expect(feat.counts).toEqual({ branch: "feat", detached: false, upstream: true, ahead: 1, behind: 0, files: 1, added: 3, removed: 1 });
    expect(feat.stale).toBe(false);
    expect(rowOf(alpha, "/r/alpha-wt/detached").counts).toBe(null);
  });

  test("bare entries are not rows, and the project is named after the common dir", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.stored.push({ machine: null, commonDir: "/r/delta-origin.git", name: "", main: null });
        f.git.worktrees.push({
          machine: null,
          commonDir: "/r/delta-origin.git",
          stale: false,
          list: [
            { path: "/r/delta-origin.git", head: null, branch: null, detached: false, bare: true, locked: false, prunable: false },
            { path: "/r/delta-wt/x", head: "d1", branch: "x", detached: false, bare: false, locked: false, prunable: false },
          ],
        });
        return f;
      }),
    );
    const delta = projectOf(tree, null, "delta-origin");
    expect(delta.main).toBe(null);
    expect(delta.worktrees.map((w) => [w.path, w.main])).toEqual([["/r/delta-wt/x", false]]);
  });

  test("place matches by git top, deepest worktree wins", () => {
    const tree = buildProjects(load("nested"));
    const alpha = projectOf(tree, null, "alpha");
    expect(rowOf(alpha, "/private/tmp/r/alpha/.worktrees/nested").spaces).toEqual(["s1"]);
    // s2's top has a trailing slash; it still lands on the main checkout.
    expect(rowOf(alpha, "/private/tmp/r/alpha").spaces).toEqual(["s2"]);
    expect(rowOf(alpha, "/private/tmp/r/alpha/.worktrees/nested").agents.map((a) => a.address)).toEqual(["t1"]);
  });

  test("a top inside a listed worktree takes the longest listed path", () => {
    const tree = buildProjects(
      load("nested", (f) => {
        f.git.places[0].top = "/private/tmp/r/alpha/.worktrees/nested/inner";
        return f;
      }),
    );
    expect(rowOf(projectOf(tree, null, "alpha"), "/private/tmp/r/alpha/.worktrees/nested").spaces).toEqual(["s1"]);
  });

  test("a space in a worktree the list does not have yet gets its own row", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.git.worktrees = f.git.worktrees.filter((w) => w.commonDir !== "/r/alpha/.git");
        return f;
      }),
    );
    const alpha = projectOf(tree, null, "alpha");
    expect(alpha.checked).toBe(false);
    expect(alpha.main).toBe("/r/alpha");
    expect(alpha.worktrees.map((w) => [w.path, w.branch, w.main, w.spaces])).toEqual([
      ["/r/alpha", "main", true, ["s1"]],
      ["/r/alpha-wt/feat", "feat", false, ["s2"]],
    ]);
  });

  test("two spaces in one worktree: both agents, worktree open", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.panes.find((p) => p.pane === "p3").cwd = "/r/alpha";
        f.git.places.push({ machine: null, folder: "/r/alpha", commonDir: "/r/alpha/.git", top: "/r/alpha" });
        return f;
      }),
    );
    const alpha = projectOf(tree, null, "alpha");
    const main = rowOf(alpha, "/r/alpha");
    expect(main.open).toBe(true);
    expect(main.spaces).toEqual(["s1", "s2"]);
    expect(main.agents.map((a) => a.address)).toEqual(["t1", "t2", "t3"]);
    expect(rowOf(alpha, "/r/alpha-wt/feat").open).toBe(false);
  });

  test("agent lines carry title, status, program, change time and space", () => {
    const main = rowOf(projectOf(buildProjects(load("two-machines")), null, "alpha"), "/r/alpha");
    expect(main.agents).toEqual([
      { address: "t1", space: "s1", tab: "tb1", title: "refactor the parser", status: "working", program: expect.objectContaining({ key: "claude" }), subagents: 0, requests: 0, changedAt: 1000 },
      { address: "t2", space: "s1", tab: "tb2", title: "fix login", status: "blocked", program: expect.objectContaining({ key: "codex" }), subagents: 0, requests: 0, changedAt: 2000 },
    ]);
  });

  test("plain spaces outside git keep their agents", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.spaces.push({
          id: "s9", index: 4, name: "~", named: false, folder: "/Users/u", machine: null, branch: null, active: false, status: "working",
          tabs: [{ id: "tb9", index: 1, name: "1", named: false, active: true, status: "working", panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: 9000, working_since: null }],
        });
        f.panes.push({ ...f.panes[0], pane: "p9", terminal: "t9", tab: "tb9", cwd: "/Users/u" });
        f.agents.push({ ...f.agents[0], address: "t9", pane: "p9", space: "s9", tab: "tb9", title: "home work" });
        f.git.places.push({ machine: null, folder: "/Users/u", not_git: true });
        return f;
      }),
    );
    const local = machineOf(tree, null);
    expect(local.plain.map((s) => [s.id, s.name, s.active, s.status, s.agents.map((a) => a.address)])).toEqual([["s9", "~", false, "working", ["t9"]]]);
    expect(tree.agentOrder).toEqual(["t1", "t2", "t3", "t9", "macmini/t5"]);
  });

  test("a space whose place is not read yet stays reachable under plain", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.git.places = f.git.places.filter((p) => p.machine !== "macmini");
        return f;
      }),
    );
    const mini = machineOf(tree, "macmini");
    expect(mini.plain.map((s) => s.id)).toEqual(["macmini/s3"]);
    expect(mini.projects).toEqual([]);
    expect(tree.agentOrder).toContain("macmini/t5");
  });

  test("sub-agent counted on its parent, no line of its own", () => {
    const tree = buildProjects(load("two-machines"));
    const feat = rowOf(projectOf(tree, null, "alpha"), "/r/alpha-wt/feat");
    expect(feat.agents.map((a) => [a.address, a.subagents])).toEqual([["t3", 1]]);
    // A bare remote parent "t5" means macmini/t5; the exited sub-agent is not counted.
    const gamma = rowOf(projectOf(tree, "macmini", "gamma"), "/home/u/gamma");
    expect(gamma.agents.map((a) => [a.address, a.subagents])).toEqual([["macmini/t5", 1]]);
    expect(tree.agentOrder).toEqual(["t1", "t2", "t3", "macmini/t5"]);
  });

  test("a sub-agent whose parent has no line keeps a line", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.agents = f.agents.filter((a) => a.address !== "t3");
        return f;
      }),
    );
    const feat = rowOf(projectOf(tree, null, "alpha"), "/r/alpha-wt/feat");
    expect(feat.agents.map((a) => a.address)).toEqual(["t4"]);
  });

  test("folded project shows its most urgent child", () => {
    const tree = buildProjects(load("two-machines"));
    const alpha = projectOf(tree, null, "alpha");
    expect(rowOf(alpha, "/r/alpha").status).toBe("blocked");
    expect(rowOf(alpha, "/r/alpha-wt/feat").status).toBe("idle");
    expect(rowOf(alpha, "/r/alpha-wt/detached").status).toBe(null);
    expect(alpha.status).toBe("blocked");
    expect(projectOf(tree, "macmini", "gamma").status).toBe("done");
    expect(projectOf(tree, null, "beta").status).toBe(null);
  });

  test("offline machine keeps rows", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.machines[1].layout = "unavailable";
        return f;
      }),
    );
    const mini = machineOf(tree, "macmini");
    expect(mini.state).toBe("offline");
    const row = rowOf(projectOf(tree, "macmini", "gamma"), "/home/u/gamma");
    expect(row.counts).toEqual({ branch: "main", detached: false, upstream: true, ahead: 0, behind: 2, files: 2, added: 5, removed: 0 });
    expect(row.stale).toBe(true);
    expect(rowOf(projectOf(tree, null, "alpha"), "/r/alpha-wt/feat").stale).toBe(false);
  });

  test("an unreachable machine reads offline; loading reads loading", () => {
    const unreachable = buildProjects(
      load("two-machines", (f) => {
        f.git.unreachable = ["macmini"];
        return f;
      }),
    );
    expect(machineOf(unreachable, "macmini").state).toBe("offline");
    expect(rowOf(projectOf(unreachable, "macmini", "gamma"), "/home/u/gamma").stale).toBe(true);
    const loading = buildProjects(
      load("two-machines", (f) => {
        f.machines[1].layout = "loading";
        return f;
      }),
    );
    expect(machineOf(loading, "macmini").state).toBe("loading");
  });

  test("stale list or counts mark the row stale", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.git.counts[0].stale = true;
        f.git.worktrees[1].stale = true;
        return f;
      }),
    );
    expect(rowOf(projectOf(tree, null, "alpha"), "/r/alpha-wt/feat").stale).toBe(true);
    expect(rowOf(projectOf(tree, null, "alpha"), "/r/alpha").stale).toBe(false);
    expect(rowOf(projectOf(tree, null, "beta"), "/r/beta").stale).toBe(true);
  });

  test("stored project on an unknown machine is not_connected", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.stored.push({ machine: "tsuki", commonDir: "/srv/omega/.git", name: "omega", main: "/srv/omega" });
        return f;
      }),
    );
    expect(tree.machines.map((m) => [m.name, m.state])).toEqual([
      [null, "ready"],
      ["macmini", "ready"],
      ["tsuki", "not_connected"],
    ]);
    expect(machineOf(tree, "tsuki").projects.map((p) => [p.name, p.letter, p.open, p.checked])).toEqual([["omega", "O", false, false]]);
  });

  test("this Mac is listed first even when machines() leaves it out", () => {
    const tree = buildProjects({ ...load("two-machines"), machines: [{ name: "macmini", layout: "ready" }] });
    expect(tree.machines.map((m) => [m.name, m.state])).toEqual([
      [null, "ready"],
      ["macmini", "ready"],
    ]);
    const empty = buildProjects({ machines: [], spaces: [], panes: [], agents: [], terminals: [], stored: [], platform: "macos", git: { places: {}, worktrees: {}, counts: {}, unreachable: [] } });
    expect(empty).toEqual({ machines: [{ name: null, label: "This Mac", state: "ready", projects: [], plain: [] }], agentOrder: [], remember: [] });
  });

  test("projects sort by name, then common dir", () => {
    const tree = buildProjects(
      load("two-machines", (f) => {
        f.stored.push({ machine: null, commonDir: "/z/beta/.git", name: "beta", main: "/z/beta" });
        f.stored.push({ machine: null, commonDir: "/r/aardvark/.git", name: "aardvark", main: "/r/aardvark" });
        return f;
      }),
    );
    expect(machineOf(tree, null).projects.map((p) => p.commonDir)).toEqual(["/r/aardvark/.git", "/r/alpha/.git", "/r/beta/.git", "/z/beta/.git"]);
  });

  test("remember lists only new projects", () => {
    const tree = buildProjects(load("two-machines"));
    expect(tree.remember).toEqual([
      { machine: null, commonDir: "/r/alpha/.git", name: "alpha", main: "/r/alpha" },
      { machine: "macmini", commonDir: "/home/u/gamma/.git", name: "gamma", main: "/home/u/gamma" },
    ]);
    const stored = readStored(rememberProjects({ version: 1, projects: load("two-machines").stored }, tree.remember));
    const again = buildProjects({ ...load("two-machines"), stored });
    expect(again.remember).toEqual([]);
  });
});

describe("stored projects", () => {
  test("readStored tolerates null, arrays and junk", () => {
    expect(readStored(null)).toEqual([]);
    expect(readStored(undefined)).toEqual([]);
    expect(readStored([])).toEqual([]);
    expect(readStored("x")).toEqual([]);
    expect(readStored({ version: 2, projects: [{ machine: null, commonDir: "/a/.git", name: "a", main: "/a" }] })).toEqual([]);
    expect(readStored({ version: 1, projects: "nope" })).toEqual([]);
    expect(
      readStored({
        version: 1,
        projects: [
          null,
          7,
          { machine: 3, commonDir: "/x/.git" },
          { machine: null, commonDir: "" },
          { machine: null, commonDir: "/a/.git", name: "a", main: "/a" },
          { machine: null, commonDir: "/a/.git", name: "dup", main: "/a" },
          { machine: "", commonDir: "/b/.git" },
          { commonDir: "/c.git", name: 5, main: 9 },
        ],
      }),
    ).toEqual([
      { machine: null, commonDir: "/a/.git", name: "a", main: "/a" },
      { machine: null, commonDir: "/b/.git", name: "b", main: null },
      { machine: null, commonDir: "/c.git", name: "c", main: null },
    ]);
  });

  test("remember appends new keys once; forget drops exactly that key", () => {
    const a = { machine: null, commonDir: "/a/.git", name: "a", main: "/a" };
    const b = { machine: "macmini", commonDir: "/a/.git", name: "a", main: "/a" };
    const once = rememberProjects(null, [a, b, a]);
    expect(once).toEqual({ version: 1, projects: [a, b] });
    expect(rememberProjects(once, [a])).toEqual({ version: 1, projects: [a, b] });
    expect(forgetProject(once, projectKey(null, "/a/.git"))).toEqual({ version: 1, projects: [b] });
    expect(forgetProject("junk", projectKey(null, "/a/.git"))).toEqual({ version: 1, projects: [] });
  });
});

describe("refreshTargets", () => {
  const byKind = (targets, kind) => targets.filter((t) => t.kind === kind);

  test("targets: place first-seen only, no list for an offline machine, selected remote worktree", () => {
    const input = load("two-machines", (f) => {
      // Two spaces in one unread folder ask for one place read.
      for (const id of ["s10", "s11"]) {
        f.spaces.push({ id, index: 9, name: "new", named: false, folder: "/r/new", machine: null, branch: null, active: false, status: null, tabs: [] });
      }
      return f;
    });
    const tree = buildProjects(input);
    const targets = refreshTargets(tree, input, "macmini/s3");
    expect(byKind(targets, "place").map((t) => [t.machine, t.path])).toEqual([[null, "/r/new"]]);
    expect(byKind(targets, "list").map((t) => [t.machine, t.path, t.open])).toEqual([
      [null, "/r/alpha/.git", true],
      [null, "/r/beta/.git", false],
      ["macmini", "/home/u/gamma/.git", true],
    ]);
    const counts = byKind(targets, "counts");
    expect(counts.map((t) => [t.machine, t.path, t.open, t.selected])).toEqual([
      [null, "/r/alpha", true, false],
      [null, "/r/alpha-wt/feat", true, false],
      [null, "/r/alpha/.worktrees/nested", false, false],
      [null, "/r/alpha-wt/detached", false, false],
      [null, "/r/beta", false, false],
      ["macmini", "/home/u/gamma", true, true],
    ]);
    expect(byKind(targets, "helper").map((t) => [t.machine, t.path])).toEqual([["macmini", ""]]);
    expect(new Set(targets.map((t) => t.key)).size).toBe(targets.length);

    const offline = load("two-machines", (f) => {
      f.machines[1].layout = "unavailable";
      return f;
    });
    const offTargets = refreshTargets(buildProjects(offline), offline, "macmini/s3");
    expect(offTargets.filter((t) => t.machine === "macmini")).toEqual([]);
    expect(byKind(offTargets, "list").map((t) => t.path)).toEqual(["/r/alpha/.git", "/r/beta/.git"]);
  });

  test("targets: the selected local worktree and no place read once a place is known", () => {
    const input = load("two-machines");
    const targets = refreshTargets(buildProjects(input), input, "s2");
    expect(byKind(targets, "place")).toEqual([]);
    expect(byKind(targets, "counts").filter((t) => t.selected).map((t) => t.path)).toEqual(["/r/alpha-wt/feat"]);
  });

  test("targets: an unreachable machine keeps its reads so a success can clear it, but no helper", () => {
    const input = load("two-machines", (f) => {
      f.git.unreachable = ["macmini"];
      return f;
    });
    const targets = refreshTargets(buildProjects(input), input, "s1").filter((t) => t.machine === "macmini");
    expect(targets.map((t) => t.kind)).toEqual(["list", "counts"]);
  });

  test("targets: none for a machine only stored projects name", () => {
    const input = load("two-machines", (f) => {
      f.stored.push({ machine: "tsuki", commonDir: "/srv/omega/.git", name: "omega", main: "/srv/omega" });
      return f;
    });
    expect(refreshTargets(buildProjects(input), input, "s1").filter((t) => t.machine === "tsuki")).toEqual([]);
  });

  test("targets: prunable worktrees get no counts read", () => {
    const input = load("two-machines", (f) => {
      f.git.worktrees[0].list[2].prunable = true;
      return f;
    });
    const paths = byKind(refreshTargets(buildProjects(input), input, "s1"), "counts").map((t) => t.path);
    expect(paths).not.toContain("/r/alpha-wt/detached");
    expect(rowOf(projectOf(buildProjects(input), null, "alpha"), "/r/alpha-wt/detached").prunable).toBe(true);
  });

  test("targets: wakeOn only for this Mac", () => {
    const input = load("two-machines");
    const targets = refreshTargets(buildProjects(input), input, "s1");
    const find = (kind, path) => targets.find((t) => t.kind === kind && t.path === path);
    expect(find("list", "/r/alpha/.git").wakeOn).toEqual(["/r/alpha/.git"]);
    expect(find("counts", "/r/alpha-wt/feat").wakeOn).toEqual(["/r/alpha-wt/feat", "/r/alpha/.git"]);
    expect(find("counts", "/r/alpha-wt/detached").wakeOn).toEqual(["/r/alpha/.git"]);
    expect(find("list", "/home/u/gamma/.git").wakeOn).toEqual([]);
    expect(find("counts", "/home/u/gamma").wakeOn).toEqual([]);
    expect(targets.filter((t) => t.kind === "helper").every((t) => t.wakeOn.length === 0)).toBe(true);
  });
});
