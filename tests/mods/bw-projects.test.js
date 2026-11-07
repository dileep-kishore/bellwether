import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake, phase } from "../harness/herdr-stub.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { projectKey, worktreeKey } from "../../shared/projects-model.js";
import { COUNTS_SCRIPT } from "../../shared/git.js";
import { HELPER_SCRIPT } from "../../shared/helper.js";

const ALPHA = projectKey(null, "/r/alpha/.git");
const GAMMA = projectKey("macmini", "/home/u/gamma/.git");
const DETACHED = worktreeKey(null, "/r/alpha-wt/detached");
const FEAT = worktreeKey(null, "/r/alpha-wt/feat");
const NO_MODIFIERS = { shift: false, control: false, alt: false, platform: false, function: false };
const VERSION_OK = { code: 0, stdout: '{"type":"version","protocol":1,"version":"0.1.0"}\n', stderr: "" };

/** The harness's fixture lookup, so a test can put its own answers in front of a fixture's. */
function answer(entries, cmd, args, on) {
  const hit = entries.find((e) => e.cmd === cmd && (!("on" in e) || (e.on ?? null) === on) && (e.argsInclude ?? []).every((a) => args.includes(a)));
  if (!hit) return { code: 127, stdout: "", stderr: `no answer for ${cmd}` };
  if (hit.result === "reject") throw new Error(`exec on ${on ?? "this machine"} rejected`);
  return { ...hit.result };
}

/**
 * A live fixture whose exec records the phase of every call and answers `bw version` as current,
 * unless `first` answers before it.
 * @param {string} name @param {(cmd: string, args: string[], on: string | null) => unknown} [first]
 */
function withExec(name, first) {
  const data = live(name);
  const entries = data.exec;
  data.exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, on: opts?.on ?? null, phase: phase(), opts });
    const on = opts?.on ?? null;
    const own = first?.(cmd, args, on);
    if (own !== undefined) return own;
    if (cmd === "sh" && args.includes(HELPER_SCRIPT) && args.includes("version")) return VERSION_OK;
    return answer(entries, cmd, args, on);
  };
  return data;
}
/** @type {{ cmd: string, args: string[], on: string | null, phase: string, opts: any }[]} */
let calls = [];

/** Lets the refresh loop run every call it is due, rendering between rounds as Herdr would. */
async function settle(m, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    const before = m.log.exec.length;
    await m.cx.flush();
    m.render();
    await m.cx.flush();
    if (m.log.exec.length === before) break;
  }
  return m.render();
}

async function mounted(name = "two-machines", first) {
  calls = [];
  const m = await mount("bw-projects", { live: withExec(name, first) });
  await settle(m);
  return m;
}

const click = (m, id) => m.click(id);

describe("bw-projects", () => {
  test("renders machines, projects, worktrees and agent lines from two-machines", async () => {
    const m = await mounted();
    const text = textOf(m.el);
    for (const s of ["THIS MAC", "MACMINI", "alpha", "gamma", "main", "feat", "detached", "+3 −1", "Refactor the parser", "fix login", "Write tests", "Port the script"]) {
      expect(text).toContain(s);
    }
    expect(byId(m.el, `project-${ALPHA}`)).not.toBe(null);
    expect(byId(m.el, `worktree-${FEAT}`)).not.toBe(null);
    expect(byId(m.el, "agent-macmini/t5")).not.toBe(null);
    expect(byId(m.el, "machine-local")).not.toBe(null);
    expect(byId(m.el, "machine-macmini")).not.toBe(null);
    // t4 is t3's sub-agent: a count on t3's line, no line of its own.
    expect(byId(m.el, "agent-t4")).toBe(null);
    expect(textOf(byId(m.el, "agent-t3"))).toContain("+1");
  });

  test("agent order follows the drawn lines", async () => {
    const m = await mounted();
    expect(m.log.order).toEqual(["t1", "t2", "t3", "macmini/t5"]);
  });

  test("remembers a new project once", async () => {
    const m = await mounted();
    m.render();
    m.render();
    const writes = m.log.shared.filter(([k]) => k === "bw.projects");
    expect(writes).toHaveLength(1);
    expect(writes[0][1].projects.map((p) => [p.machine, p.commonDir, p.main])).toEqual([
      [null, "/r/alpha/.git", "/r/alpha"],
      ["macmini", "/home/u/gamma/.git", "/home/u/gamma"],
    ]);
  });

  test("clicking a dimmed row runs space.new with that folder", async () => {
    const m = await mounted();
    expect(byId(m.el, `worktree-${DETACHED}`).attrs.opacity).toBe(0.55);
    await click(m, `worktree-${DETACHED}`);
    expect(m.log.run).toEqual([["space.new", { folder: "/r/alpha-wt/detached", machine: "" }]]);
  });

  test("clicking an open row selects its space; an agent line focuses that agent", async () => {
    const m = await mounted();
    await click(m, `worktree-${FEAT}`);
    await click(m, "agent-macmini/t5");
    expect(m.log.run).toEqual([
      ["space.select", { id: "s2" }],
      ["space.select", { id: "macmini/s3" }],
      ["tab.select", { id: "macmini/tb5" }],
      ["agent.focus", { terminal: "macmini/t5" }],
    ]);
  });

  test("offline heading keeps rows, no exec for that machine", async () => {
    const m = await mounted();
    const machine = (name) => fake.machines.find((x) => x.name === name);
    machine("macmini").layout = "unavailable";
    const before = calls.length;
    await settle(m);
    expect(textOf(byId(m.el, "machine-macmini"))).toContain("offline");
    expect(byId(m.el, `project-${GAMMA}`)).not.toBe(null);
    expect(byId(m.el, `worktree-${worktreeKey("macmini", "/home/u/gamma")}`)).not.toBe(null);
    expect(calls.slice(before).filter((c) => c.on === "macmini")).toEqual([]);
  });

  test("offline from the start: stored rows, heading offline, no exec there", async () => {
    const m = await mounted("offline");
    expect(textOf(byId(m.el, "machine-macmini"))).toContain("offline");
    expect(textOf(byId(m.el, `project-${GAMMA}`))).toContain("gamma");
    expect(calls.filter((c) => c.on === "macmini")).toEqual([]);
    // Its space still shows, with its agent, until Git can answer.
    expect(byId(m.el, "agent-macmini/t5")).not.toBe(null);
  });

  test("a rejected exec marks the machine offline and keeps its counts", async () => {
    let down = false;
    const m = await mounted("two-machines", (_cmd, _args, on) => {
      if (down && on === "macmini") throw new Error("connection refused");
      return undefined;
    });
    down = true;
    // macmini's timers are 1.5 s and 15 s away; a cd there makes a place read due now.
    fake.panes.find((p) => p.pane === "macmini/p5").cwd = "/home/u/gamma/src";
    await settle(m);
    expect(calls.some((c) => c.on === "macmini" && c.args.includes("/home/u/gamma/src"))).toBe(true);
    expect(textOf(byId(m.el, "machine-macmini"))).toContain("offline");
    expect(byId(m.el, `worktree-${worktreeKey("macmini", "/home/u/gamma")}`)).not.toBe(null);
  });

  test("git runs only from tasks, live data only from render", async () => {
    const m = await mounted();
    await click(m, `worktree-${DETACHED}`);
    await settle(m);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.phase).toBe("task");
      expect(c.opts?.cwd).toBeUndefined();
      if (c.cmd === "git") {
        expect(c.args).toContain("--no-optional-locks");
        expect(c.args.join(" ")).toContain("-c core.fsmonitor=false");
      } else if (c.cmd === "sh" && c.args[1] === COUNTS_SCRIPT) {
        expect(c.args.slice(2)).toEqual(["sh", c.args[3]]);
      } else {
        expect([c.cmd, c.args[1]]).toEqual(["sh", HELPER_SCRIPT]);
      }
    }
    const kinds = new Set(calls.map((c) => (c.cmd === "git" ? c.args.find((a) => a === "rev-parse" || a === "worktree") : c.args[1] === COUNTS_SCRIPT ? "counts" : "helper")));
    expect(kinds).toEqual(new Set(["rev-parse", "worktree", "counts", "helper"]));
    for (const [name, p] of m.log.live) if (["agents", "spaces", "panes", "terminals", "focused"].includes(name)) expect(p).toBe("render");
  });

  test("helper state shows setting up Bellwether on macmini", async () => {
    /** @type {(v: unknown) => void} */
    let finish = () => {};
    const install = new Promise((resolve) => (finish = resolve));
    let installed = false;
    const m = await mounted("two-machines", (cmd, args, on) => {
      if (cmd === "sh" && args.includes(HELPER_SCRIPT) && on === "macmini") return installed ? VERSION_OK : { code: 127, stdout: "", stderr: "sh: no such file" };
      if (cmd === "/home/test/.local/share/bellwether/helper/current/bw") return install;
      return undefined;
    });
    expect(calls.some((c) => c.on === null && c.cmd.endsWith("/bw") && c.args.join(" ") === "machine install macmini")).toBe(true);
    expect(textOf(byId(m.el, "machine-macmini"))).toContain("setting up Bellwether");
    expect(textOf(byId(m.el, "machine-local"))).not.toContain("setting up");

    installed = true;
    finish({ code: 0, stdout: '{"type":"installed","machine":"macmini","version":"0.1.0"}\n', stderr: "" });
    await settle(m);
    expect(textOf(byId(m.el, "machine-macmini"))).toBe("MACMINI");
  });

  test("a failed install names the helper's message", async () => {
    const m = await mounted("two-machines", (cmd, args, on) => {
      if (cmd === "sh" && args.includes(HELPER_SCRIPT) && on === "macmini") return { code: 127, stdout: "", stderr: "" };
      if (cmd.endsWith("/bw")) return { code: 1, stdout: '{"type":"error","code":"no_build","message":"no build for Linux aarch64"}\n', stderr: "" };
      return undefined;
    });
    expect(textOf(byId(m.el, "machine-macmini"))).toContain("Bellwether helper: no build for Linux aarch64");
  });

  test("rail below 160 px draws letter tiles", async () => {
    const m = await mounted();
    await fire(m.el, "on_size_change", { width: 120, height: 600 }, m.cx);
    m.render();
    const tiles = findAll(m.el, (e) => String(e.attrs.id ?? "").startsWith("rail-"));
    expect(tiles.map((e) => textOf(e))).toEqual(["A", "G"]);
    expect(textOf(m.el)).not.toContain("THIS MAC");
    await click(m, `rail-${GAMMA}`);
    expect(m.log.run).toEqual([["space.select", { id: "macmini/s3" }]]);
    await fire(m.el, "on_size_change", { width: 248, height: 600 }, m.cx);
    expect(textOf(m.render())).toContain("THIS MAC");
  });

  test("folding a project shows its most urgent status and is remembered", async () => {
    const m = await mounted();
    await click(m, `fold-${ALPHA}`);
    expect(byId(m.el, `worktree-${FEAT}`)).toBe(null);
    const header = byId(m.el, `project-${ALPHA}`);
    expect(findAll(header, (e) => e.tag === "svg").map((e) => e.attrs.path)).toContain("mods/bw-projects/icons/question.svg");
    expect(JSON.parse(localStorage.getItem("bw-projects.folded"))).toContain(`p${ALPHA}`);
    await click(m, `fold-${ALPHA}`);
    expect(byId(m.el, `worktree-${FEAT}`)).not.toBe(null);
    expect(JSON.parse(localStorage.getItem("bw-projects.folded"))).toEqual([]);
  });

  test("folding a machine hides its projects", async () => {
    const m = await mounted();
    await click(m, "machine-macmini");
    expect(byId(m.el, `project-${GAMMA}`)).toBe(null);
    expect(byId(m.el, `project-${ALPHA}`)).not.toBe(null);
  });

  test("add project, project menu and + open their overlays", async () => {
    const m = await mounted();
    await click(m, "add-project");
    await fire(byId(m.el, `project-${GAMMA}`), "on_mouse_down:right", { button: "right", click_count: 1, modifiers: NO_MODIFIERS }, m.cx);
    await fire(byId(m.el, `project-${GAMMA}`), "on_hover", true, m.cx);
    m.render();
    await click(m, `project-new-${GAMMA}`);
    await click(m, `project-more-${GAMMA}`);
    expect(m.log.overlays.map((o) => [o.mod, o.kind])).toEqual([["bw-add", "dialog"], ["bw-menu", "popup"], ["bw-new", "popup"], ["bw-menu", "popup"]]);
    expect(m.log.overlays[2].props).toEqual({ machine: "macmini", folder: "/home/u/gamma" });
    expect(m.log.overlays[1].props.project).toMatchObject({ key: GAMMA, machine: "macmini", open: true });
  });

  test("spaces outside git show under Other spaces with their agents", async () => {
    const m = await mounted("two-machines", (cmd, args) => {
      if (cmd === "git" && args.includes("rev-parse") && args.includes("/r/alpha-wt/feat")) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      return undefined;
    });
    const text = textOf(m.el);
    expect(text).toContain("Other spaces");
    expect(byId(m.el, "agent-t3")).not.toBe(null);
    await click(m, "space-s2");
    expect(m.log.run).toEqual([["space.select", { id: "s2" }]]);
  });

  test("the minute timer redraws only when a time is shown, and reads no live data", async () => {
    const m = await mounted();
    expect(m.cx.timers.map((t) => t.ms)).toEqual([60000]);
    const before = m.cx.notified;
    await m.tickTimer(0);
    expect(m.cx.notified).toBe(before + 1);

    const quiet = await mounted("empty");
    const n = quiet.cx.notified;
    await quiet.tickTimer(0);
    expect(quiet.cx.notified).toBe(n);
  });

  test("header leaves room for the traffic lights only when the window has no title bar", async () => {
    const m = await mounted();
    expect(byId(m.el, "projects-header").attrs.pl).toBe(76);
    fake.window = { ...fake.window, fullscreen: true };
    expect(byId(m.render(), "projects-header").attrs.pl).toBe(12);
  });
});
