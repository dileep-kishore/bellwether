import { describe, expect, test } from "bun:test";
import { addProject, focusAgent, newInMain, openWorktree, projectMenu } from "../../mods/bw-projects/actions.js";

/** @param {Record<string, unknown>} over */
const node = (over = {}) => ({
  key: '[null,"/r/alpha-wt/detached"]',
  path: "/r/alpha-wt/detached",
  branch: null,
  detached: true,
  prunable: false,
  main: false,
  open: false,
  spaces: [],
  counts: null,
  stale: false,
  status: null,
  agents: [],
  ...over,
});

const project = {
  key: '[null,"/r/alpha/.git"]',
  machine: null,
  commonDir: "/r/alpha/.git",
  name: "alpha",
  letter: "A",
  main: "/r/alpha",
  open: true,
  status: "blocked",
  checked: true,
  worktrees: [],
};

describe("openWorktree", () => {
  test('dimmed local row passes machine ""', () => {
    expect(openWorktree(node(), null)).toEqual([["space.new", { folder: "/r/alpha-wt/detached", machine: "" }]]);
  });

  test("dimmed remote row names its machine", () => {
    expect(openWorktree(node({ path: "/home/u/gamma" }), "macmini")).toEqual([
      ["space.new", { folder: "/home/u/gamma", machine: "macmini" }],
    ]);
  });

  test("open row selects its first space", () => {
    expect(openWorktree(node({ open: true, spaces: ["s2", "s4"] }), null)).toEqual([["space.select", { id: "s2" }]]);
  });

  test("prunable row does nothing", () => {
    expect(openWorktree(node({ prunable: true }), null)).toEqual([]);
    expect(openWorktree(node({ prunable: true, open: true, spaces: ["s2"] }), "macmini")).toEqual([]);
  });
});

test("agent click selects space, tab, then agent.focus", () => {
  const line = {
    address: "macmini/t5",
    space: "macmini/s3",
    tab: "macmini/tb5",
    title: "Port",
    status: "done",
    program: null,
    subagents: 0,
    requests: 0,
    changedAt: null,
  };
  expect(focusAgent(line)).toEqual([
    ["space.select", { id: "macmini/s3" }],
    ["tab.select", { id: "macmini/tb5" }],
    ["agent.focus", { terminal: "macmini/t5" }],
  ]);
});

test("project menu carries what bw-menu needs", () => {
  expect(projectMenu(project)).toEqual({
    mod: "bw-menu",
    kind: "popup",
    width: 220,
    props: {
      project: {
        key: project.key,
        machine: null,
        commonDir: "/r/alpha/.git",
        main: "/r/alpha",
        name: "alpha",
        open: true,
      },
    },
  });
});

test("add project opens bw-add as a dialog", () => {
  expect(addProject()).toEqual({ mod: "bw-add", kind: "dialog", width: 420, height: 220 });
});

test("+ on a project opens bw-new in its main checkout", () => {
  expect(newInMain({ ...project, machine: "macmini", main: "/home/u/gamma" })).toEqual({
    mod: "bw-new",
    kind: "popup",
    width: 232,
    height: 300,
    props: { machine: "macmini", folder: "/home/u/gamma" },
  });
});
