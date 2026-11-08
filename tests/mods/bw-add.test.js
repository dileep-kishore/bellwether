import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, findAll, textOf } from "../harness/kit-stub.js";
import { mainOf } from "../../mods/bw-add/main.js";

const STORED = {
  version: 1,
  projects: [{ machine: null, commonDir: "/r/alpha/.git", name: "alpha", main: "/r/alpha" }],
};
const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

/** two-machines plus extra exec answers for rev-parse. */
function data(exec = [], machines) {
  const d = live("two-machines");
  d.shared = { "bw.projects": structuredClone(STORED) };
  d.exec = [...exec, ...d.exec];
  if (machines) d.machines = machines;
  return d;
}
const open = (d) => mount("bw-add", { props: { overlay: "o3" }, live: d });

/** Types into the path input the way gpui does: the state changes, then "change" fires. */
function type(m, text) {
  const input = findAll(m.el, (e) => e.tag === "Input")[0];
  if (!input) throw new Error("no path input");
  const state = input.attrs.state;
  state.set_value(text);
  state.handlers.change?.({}, m.cx);
  m.render();
}
const revParses = (m) => m.log.exec.filter(([cmd, args]) => cmd === "git" && args.includes("rev-parse"));

describe("mainOf", () => {
  test("main checkout, linked worktree, bare repository", () => {
    expect(mainOf({ commonDir: "/r/beta/.git", top: "/r/beta" })).toBe("/r/beta");
    expect(mainOf({ commonDir: "/r/alpha/.git", top: "/r/alpha-wt/feat" })).toBe("/r/alpha");
    expect(mainOf({ commonDir: "/r/alpha-origin.git", top: "/r/x" })).toBe(null);
  });
});

describe("bw-add", () => {
  test("machine choice: this Mac and each ready machine", async () => {
    const m = await open(
      data(
        [],
        [
          { name: null, layout: "ready" },
          { name: "macmini", layout: "ready" },
          { name: "tsuki", layout: "unavailable" },
          { name: "box", layout: "loading" },
        ],
      ),
    );
    expect(byId(m.el, "add-machine-local")).not.toBe(null);
    expect(byId(m.el, "add-machine-macmini")).not.toBe(null);
    expect(byId(m.el, "add-machine-tsuki")).toBe(null);
    expect(byId(m.el, "add-machine-box")).toBe(null);
    expect(textOf(m.el)).toContain("This Mac");
  });

  test("add on this Mac uses pickFolder and remembers", async () => {
    const asked = [];
    const d = data([
      { on: null, cmd: "git", argsInclude: ["rev-parse", "/r/beta"], result: ok("/r/beta/.git\n/r/beta\n") },
    ]);
    const m = await open(d);
    fake.pickFolder = (opts) => {
      asked.push(opts);
      return "/r/beta";
    };
    await m.click("add-choose");
    expect(asked).toEqual([{ prompt: "Add project" }]);
    expect(revParses(m).map(([, args, opts]) => [args[1], opts])).toEqual([["/r/beta", { on: null }]]);
    expect(m.log.shared).toEqual([
      [
        "bw.projects",
        {
          version: 1,
          projects: [...STORED.projects, { machine: null, commonDir: "/r/beta/.git", name: "beta", main: "/r/beta" }],
        },
      ],
    ]);
    expect(m.log.closed).toEqual(["o3"]);
  });

  test("a cancelled picker changes nothing", async () => {
    const m = await open(data());
    fake.pickFolder = () => null;
    await m.click("add-choose");
    expect(m.log.exec).toEqual([]);
    expect(m.log.shared).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("a typed path on this Mac: ~ is this Mac's home, Add remembers a linked worktree's project", async () => {
    const d = data([
      {
        on: null,
        cmd: "git",
        argsInclude: ["rev-parse", "/home/test/r/alpha-wt/feat"],
        result: ok("/r/alpha/.git\n/r/alpha-wt/feat\n"),
      },
    ]);
    d.shared = {};
    const m = await open(d);
    type(m, "  ~/r/alpha-wt/feat ");
    await m.click("add-go");
    expect(m.log.shared).toEqual([
      [
        "bw.projects",
        { version: 1, projects: [{ machine: null, commonDir: "/r/alpha/.git", name: "alpha", main: "/r/alpha" }] },
      ],
    ]);
    expect(m.log.closed).toEqual(["o3"]);
  });

  test("add on macmini runs rev-parse there", async () => {
    const m = await open(
      data([
        {
          on: "macmini",
          cmd: "git",
          argsInclude: ["rev-parse", "/home/u/beta"],
          result: ok("/home/u/beta/.git\n/home/u/beta\n"),
        },
      ]),
    );
    await m.click("add-machine-macmini");
    expect(byId(m.el, "add-choose")).toBe(null);
    type(m, "/home/u/beta");
    await m.click("add-go");
    expect(revParses(m).map(([, args, opts]) => [args[1], opts])).toEqual([["/home/u/beta", { on: "macmini" }]]);
    for (const [, args] of revParses(m)) expect(args).toContain("--no-optional-locks");
    expect(m.log.shared.at(-1)).toEqual([
      "bw.projects",
      {
        version: 1,
        projects: [
          ...STORED.projects,
          { machine: "macmini", commonDir: "/home/u/beta/.git", name: "beta", main: "/home/u/beta" },
        ],
      },
    ]);
    expect(m.log.closed).toEqual(["o3"]);
  });

  test("on another machine ~ is left for Git to refuse", async () => {
    const m = await open(
      data([
        {
          on: "macmini",
          cmd: "git",
          argsInclude: ["rev-parse", "~/beta"],
          result: { code: 128, stdout: "", stderr: "fatal: cannot change to '~/beta': No such file or directory\n" },
        },
      ]),
    );
    await m.click("add-machine-macmini");
    type(m, "~/beta");
    await m.click("add-go");
    expect(textOf(m.el)).toContain("cannot change to '~/beta'");
    expect(m.log.shared).toEqual([]);
  });

  test("not a repository is named and nothing is stored", async () => {
    const m = await open(
      data([
        {
          on: null,
          cmd: "git",
          argsInclude: ["rev-parse", "/tmp"],
          result: {
            code: 128,
            stdout: "",
            stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
          },
        },
      ]),
    );
    type(m, "/tmp");
    await m.click("add-go");
    expect(textOf(m.el)).toContain("Not a Git repository");
    expect(m.log.shared).toEqual([]);
    expect(m.log.closed).toEqual([]);
    type(m, "/tmp/x");
    expect(textOf(m.el)).not.toContain("Not a Git repository");
  });

  test("unreachable machine is named", async () => {
    const m = await open(data([{ on: "macmini", cmd: "git", argsInclude: ["rev-parse"], result: "reject" }]));
    await m.click("add-machine-macmini");
    type(m, "/home/u/beta");
    await m.click("add-go");
    expect(textOf(m.el)).toContain("macmini is not reachable");
    expect(m.log.shared).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("an already stored project closes without writing", async () => {
    const m = await open(data());
    type(m, "/r/alpha");
    await m.click("add-go");
    expect(m.log.shared).toEqual([]);
    expect(m.log.closed).toEqual(["o3"]);
  });

  test("an empty path does nothing", async () => {
    const m = await open(data());
    type(m, "   ");
    await m.click("add-go");
    expect(m.log.exec).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("Enter in the path adds", async () => {
    const m = await open(
      data([{ on: null, cmd: "git", argsInclude: ["rev-parse", "/r/beta"], result: ok("/r/beta/.git\n/r/beta\n") }]),
    );
    type(m, "/r/beta");
    const state = findAll(m.el, (e) => e.tag === "Input")[0].attrs.state;
    state.handlers.submit({}, m.cx);
    await m.cx.flush();
    expect(m.log.closed).toEqual(["o3"]);
    expect(m.log.shared.at(-1)[1].projects.at(-1).commonDir).toBe("/r/beta/.git");
  });

  test("a chosen machine that goes offline stays chosen and Add waits for it", async () => {
    const both = ok("/r/alpha/.git\n/r/alpha\n");
    const m = await open(
      data([
        { on: null, cmd: "git", argsInclude: ["rev-parse", "/r/alpha"], result: both },
        { on: "macmini", cmd: "git", argsInclude: ["rev-parse", "/r/alpha"], result: both },
      ]),
    );
    await m.click("add-machine-macmini");
    type(m, "/r/alpha");
    fake.machines.find((x) => x.name === "macmini").layout = "unavailable";
    m.render();
    expect(byId(m.el, "add-machine-macmini")).not.toBe(null);
    expect(byId(m.el, "add-choose")).toBe(null);
    expect(textOf(m.el)).toContain("macmini is offline");
    expect(byId(m.el, "add-go").attrs.disabled).toBe(true);
    expect(byId(m.el, "add-go").handlers.on_click).toBeUndefined();
    findAll(m.el, (e) => e.tag === "Input")[0].attrs.state.handlers.submit({}, m.cx);
    await m.cx.flush();
    expect(m.log.exec).toEqual([]);
    expect(m.log.shared).toEqual([]);
    expect(m.log.closed).toEqual([]);

    fake.machines.find((x) => x.name === "macmini").layout = "ready";
    m.render();
    await m.click("add-go");
    expect(revParses(m).map(([, args, opts]) => [args[1], opts])).toEqual([["/r/alpha", { on: "macmini" }]]);
    expect(m.log.shared.at(-1)[1].projects.at(-1)).toEqual({
      machine: "macmini",
      commonDir: "/r/alpha/.git",
      name: "alpha",
      main: "/r/alpha",
    });
  });

  test("a chosen machine that is connecting says so", async () => {
    const m = await open(data());
    await m.click("add-machine-macmini");
    fake.machines.find((x) => x.name === "macmini").layout = "loading";
    m.render();
    expect(textOf(m.el)).toContain("macmini is connecting…");
    expect(byId(m.el, "add-go").handlers.on_click).toBeUndefined();
    findAll(m.el, (e) => e.tag === "Input")[0].attrs.state.handlers.submit({}, m.cx);
    await m.cx.flush();
    expect(m.log.exec).toEqual([]);
  });

  test("leaving an offline machine clears the path typed for it", async () => {
    const m = await open(data());
    await m.click("add-machine-macmini");
    type(m, "/r/alpha");
    fake.machines = fake.machines.filter((x) => x.name !== "macmini");
    m.render();
    expect(textOf(m.el)).toContain("macmini is offline");
    await m.click("add-machine-local");
    expect(findAll(m.el, (e) => e.tag === "Input")[0].attrs.state.value()).toBe("");
    expect(byId(m.el, "add-machine-macmini")).toBe(null);
    await m.click("add-go");
    expect(m.log.exec).toEqual([]);
  });
});
