import { describe, expect, test } from "bun:test";
import * as herdrModule from "herdr";
import * as kitModule from "gpui-kit";
import * as baseModule from "gpui-base";
import api from "./api.json";
import { fake, log, reset, setPhase } from "./herdr-stub.js";
import { byId, div, fire, findAll, svg, textOf } from "./kit-stub.js";
import { makeCx } from "./cx.js";
import { live, mount } from "./mount.js";

const F = "tests/harness/fixtures";

describe("api.json", () => {
  test("api names cover what phase 1 uses", () => {
    for (const n of ["watchFolder", "knownAgents", "setAgentOrder", "openOverlay", "pickFolder"]) expect(api.herdr).toContain(n);
    for (const m of ["spin", "frames", "on_size_change", "overflow_x_scrollbar", "on_mouse_up", "truncate"]) expect(api.element).toContain(m);
    expect(api.commands["tab.move"].required).toEqual(["id", "index"]);
  });

  test("records where it came from", () => {
    expect(api.source.gpuiShell).toMatch(/^\d+\.\d+\.\d+/);
    expect(api.source.from).toBeString();
  });
});

describe("stub modules", () => {
  test("herdr, gpui-kit and gpui-base export exactly the declared names", () => {
    expect(Object.keys(herdrModule).sort()).toEqual([...api.herdr].sort());
    expect(Object.keys(kitModule).sort()).toEqual([...api.kit].sort());
    expect(Object.keys(baseModule).sort()).toEqual([...api.base].sort());
  });

  test("a declared but unfaked name throws when used", () => {
    expect(() => herdrModule.updates()).toThrow("stub: updates not faked");
    expect(() => baseModule.Scrollbar.vertical()).toThrow("stub: Scrollbar not faked");
  });

  test("unknown builder method throws", () => expect(() => div().flex_one()).toThrow("unknown builder method flex_one"));

  test("an element used twice as a child throws", () => {
    const d = div();
    const p = div().child(d);
    expect(() => p.child(d)).toThrow("used twice");
  });

  test("hover's declare callback is checked too", () => {
    expect(() => div().hover((el) => el.bg_hover("#000"))).toThrow("unknown builder method bg_hover");
  });

  test("byId, textOf, findAll and fire walk the tree", () => {
    reset();
    let clicked = 0;
    const el = div().child(div().id("a").child("one").on_click(() => clicked++)).child(div().id("b").child(2));
    expect(textOf(el)).toBe("one 2");
    expect(textOf(byId(el, "b"))).toBe("2");
    expect(findAll(el, (e) => e.attrs.id !== undefined).map((e) => e.attrs.id)).toEqual(["a", "b"]);
    fire(byId(el, "a"), "on_click", {}, makeCx());
    expect(clicked).toBe(1);
  });

  test("fire runs with phase event", () => {
    reset();
    const el = div().id("x").on_click(() => herdrModule.spaces());
    fire(el, "on_click", {}, makeCx());
    expect(log.live).toEqual([["spaces", "event"]]);
  });

  test("each live getter logs its phase", () => {
    reset();
    setPhase("render");
    herdrModule.agents();
    herdrModule.machines();
    expect(log.live).toEqual([["agents", "render"], ["machines", "render"]]);
  });

  test("exec answers from the fixture: first match wins, reject, else 127", async () => {
    reset();
    Object.assign(fake, live("two-machines"));
    const feat = await herdrModule.exec("git", ["-C", "/r/alpha-wt/feat", "--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { on: null });
    expect(feat.stdout).toBe("/r/alpha/.git\n/r/alpha-wt/feat\n");
    const remote = await herdrModule.exec("git", ["-C", "/home/u/gamma", "rev-parse"], { on: "macmini" });
    expect(remote.stdout).toBe("/home/u/gamma/.git\n/home/u/gamma\n");
    expect((await herdrModule.exec("git", ["-C", "/home/u/gamma", "rev-parse"], { on: null })).code).toBe(127);
    fake.exec = [{ on: "gone", cmd: "git", argsInclude: [], result: "reject" }];
    await expect(herdrModule.exec("git", ["status"], { on: "gone" })).rejects.toThrow();
    expect(log.exec.map(([c, , o]) => [c, o.on])).toEqual([["git", null], ["git", "macmini"], ["git", null], ["git", "gone"]]);
  });

  test("knownAgents answers per machine and logs the call", async () => {
    reset();
    Object.assign(fake, live("two-machines"));
    expect((await herdrModule.knownAgents({ on: "macmini" })).map((a) => [a.key, a.installed])).toEqual([["codex", true], ["claude", false]]);
    expect((await herdrModule.knownAgents()).map((a) => a.key)).toEqual(["claude", "codex"]);
    expect(log.knownAgents).toEqual([{ on: "macmini" }, undefined]);
  });

  test("localStorage exists and reset clears it", () => {
    globalThis.localStorage.setItem("k", "v");
    expect(globalThis.localStorage.getItem("k")).toBe("v");
    reset();
    expect(globalThis.localStorage.getItem("k")).toBe(null);
  });

  test("the default layout is bellwether's", async () => {
    const m = await mount("bw-good", { root: F, live: live("empty") });
    expect(herdrModule.layout().id).toBe("root");
    expect(m.log.live.some(([n]) => n === "spaces")).toBe(true);
  });
});

describe("cx", () => {
  test("flush runs spawned bodies with phase task until idle", async () => {
    reset();
    const cx = makeCx();
    const seen = [];
    cx.spawn(async (cx) => {
      seen.push("a");
      await Promise.resolve();
      cx.spawn(async () => seen.push("b"));
      cx.notify();
    });
    await cx.flush();
    expect(seen).toEqual(["a", "b"]);
    expect(cx.notified).toBe(1);
  });

  test("sleep parks until woken", async () => {
    reset();
    const cx = makeCx();
    let woke = false;
    cx.spawn(async (cx) => { await cx.sleep(5000); woke = true; });
    await cx.flush();
    expect(woke).toBe(false);
    expect(cx.sleeps.map((s) => s.ms)).toEqual([5000]);
    cx.sleeps[0].wake();
    await cx.flush();
    expect(woke).toBe(true);
  });

  test("timer.every is recorded", () => {
    const cx = makeCx();
    const fn = () => {};
    cx.timer.every(60000, fn);
    expect(cx.timers).toEqual([{ ms: 60000, fn }]);
  });
});

describe("mount", () => {
  test("a mod importing a name herdr lacks fails to load", async () => expect(mount("bw-bad-import", { root: F })).rejects.toThrow("nothere"));

  test("live read in a timer is refused", async () => {
    const m = await mount("bw-bad", { root: F, props: { case: "timer" } });
    await expect(m.tickTimer(0)).rejects.toThrow("live data read from a timer: spaces()");
  });

  test("live read in a task is refused", async () => expect(mount("bw-bad", { root: F, props: { case: "task" } })).rejects.toThrow("live data read from a task: spaces()"));

  test("a swallowed refusal still fails the step", async () => expect(mount("bw-bad", { root: F, props: { case: "swallowed" } })).rejects.toThrow("live data read from a task: spaces()"));

  test("a task that throws fails the step", async () => expect(mount("bw-bad", { root: F, props: { case: "throws" } })).rejects.toThrow("task blew up"));

  test("misspelled command and bad arg are refused", async () => {
    await expect(mount("bw-bad", { root: F, props: { case: "command" } })).rejects.toThrow("unknown command tab.mvoe");
    await expect(mount("bw-bad", { root: F, props: { case: "arg" } })).rejects.toThrow("tab.move: unknown argument idx");
    await expect(mount("bw-bad", { root: F, props: { case: "required" } })).rejects.toThrow("tab.move: missing required argument index");
  });

  test("a mod's own command is allowed", async () => {
    const m = await mount("bw-bad", { root: F, props: { case: "own" } });
    expect(m.log.run).toEqual([["bw-bad.refresh"]]);
  });

  test("timer under 1 s is refused", async () => expect(mount("bw-bad", { root: F, props: { case: "fast" } })).rejects.toThrow("timer.every(250) is under 1000 ms"));

  test("svg paths must be a bw mod's own file or icons/", async () => {
    await expect(mount("bw-bad", { root: F, props: { case: "path" } })).rejects.toThrow("svg path mods/bw-bad/nope.svg");
    await expect(mount("bw-bad", { root: F, props: { case: "foreign" } })).rejects.toThrow("svg path mods/spaces/icon.svg");
    expect(() => svg("icons/nvim.svg")).not.toThrow();
  });

  test("an element reused in render is refused", async () => expect(mount("bw-bad", { root: F, props: { case: "reuse" } })).rejects.toThrow("used twice"));

  test("good fixture mod mounts, renders, and click logs its run", async () => {
    const m = await mount("bw-good", { root: F, live: live("two-machines") });
    expect(textOf(m.el)).toContain("alpha");
    expect(textOf(byId(m.el, "top"))).toBe("/r/alpha");
    expect(m.log.exec).toHaveLength(1);
    await m.click("go");
    expect(m.log.run).toEqual([["space.select", { id: "s1" }]]);
    await m.tickTimer(0);
    expect(m.cx.notified).toBe(2);
  });

  test("each mount loads a fresh copy of the mod", async () => {
    const a = await mount("bw-good", { root: F, live: live("empty") });
    const b = await mount("bw-good", { root: F, live: live("empty") });
    expect(a.view.constructor).not.toBe(b.view.constructor);
  });

  test("clicking an id that is not drawn says so", async () => {
    const m = await mount("bw-good", { root: F, live: live("empty") });
    await expect(m.click("nope")).rejects.toThrow("no element with id nope");
  });
});
