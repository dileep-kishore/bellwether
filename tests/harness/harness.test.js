import { describe, expect, test } from "bun:test";
import * as herdrModule from "herdr";
import * as kitModule from "gpui-kit";
import * as baseModule from "gpui-base";
import api from "./api.json";
import { fake, log, reset, setPhase } from "./herdr-stub.js";
import { byId, div, emit, fire, findAll, image, inspect, svg, textOf } from "./kit-stub.js";
import { makeCx } from "./cx.js";
import { live, mount } from "./mount.js";

const F = "tests/harness/fixtures";

describe("api.json", () => {
  test("api names cover what phase 1 uses", () => {
    for (const n of ["watchFolder", "knownAgents", "setAgentOrder", "openOverlay", "pickFolder"])
      expect(api.herdr).toContain(n);
    for (const m of ["spin", "frames", "on_size_change", "overflow_x_scrollbar", "on_mouse_up", "truncate"])
      expect(api.element).toContain(m);
    expect(api.baseMembers.interfaces.TextViewElement).toEqual(["on_link_click", "scrollable", "selectable"]);
    expect(api.baseMembers.interfaces.TextareaState).toContain("set_auto_grow");
    expect(api.baseMembers.interfaces.VirtualListScrollHandle).toEqual([
      "release",
      "scroll_to_bottom",
      "scroll_to_item",
    ]);
    expect(api.baseMembers.consts.Scrollbar).toEqual(["horizontal", "new", "vertical"]);
    expect(api.baseMembers.consts.Textarea).toEqual(["new"]);
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
    expect(() => baseModule.Checkbox.new()).toThrow("stub: Checkbox not faked");
  });

  test("unknown builder method throws", () =>
    expect(() => div().flex_one()).toThrow("unknown builder method flex_one"));

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
    const el = div()
      .child(
        div()
          .id("a")
          .child("one")
          .on_click(() => clicked++),
      )
      .child(div().id("b").child(2));
    expect(textOf(el)).toBe("one 2");
    expect(textOf(byId(el, "b"))).toBe("2");
    expect(findAll(el, (e) => e.attrs.id !== undefined).map((e) => e.attrs.id)).toEqual(["a", "b"]);
    fire(byId(el, "a"), "on_click", {}, makeCx());
    expect(clicked).toBe(1);
  });

  test("fire runs with phase event", () => {
    reset();
    const el = div()
      .id("x")
      .on_click(() => herdrModule.spaces());
    fire(el, "on_click", {}, makeCx());
    expect(log.live).toEqual([["spaces", "event"]]);
  });

  test("each live getter logs its phase", () => {
    reset();
    setPhase("render");
    herdrModule.agents();
    herdrModule.machines();
    expect(log.live).toEqual([
      ["agents", "render"],
      ["machines", "render"],
    ]);
  });

  test("exec answers from the fixture: first match wins, reject, else 127", async () => {
    reset();
    Object.assign(fake, live("two-machines"));
    const feat = await herdrModule.exec(
      "git",
      [
        "-C",
        "/r/alpha-wt/feat",
        "--no-optional-locks",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      { on: null },
    );
    expect(feat.stdout).toBe("/r/alpha/.git\n/r/alpha-wt/feat\n");
    const remote = await herdrModule.exec("git", ["-C", "/home/u/gamma", "rev-parse"], { on: "macmini" });
    expect(remote.stdout).toBe("/home/u/gamma/.git\n/home/u/gamma\n");
    expect((await herdrModule.exec("git", ["-C", "/home/u/gamma", "rev-parse"], { on: null })).code).toBe(127);
    fake.exec = [{ on: "gone", cmd: "git", argsInclude: [], result: "reject" }];
    await expect(herdrModule.exec("git", ["status"], { on: "gone" })).rejects.toThrow();
    expect(log.exec.map(([c, , o]) => [c, o.on])).toEqual([
      ["git", null],
      ["git", "macmini"],
      ["git", null],
      ["git", "gone"],
    ]);
  });

  test("knownAgents answers per machine and logs the call", async () => {
    reset();
    Object.assign(fake, live("two-machines"));
    expect((await herdrModule.knownAgents({ on: "macmini" })).map((a) => [a.key, a.installed])).toEqual([
      ["codex", true],
      ["claude", false],
    ]);
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

describe("gpui-base stubs", () => {
  const { TextView, Textarea, TextareaState, Scrollbar, VirtualListScrollHandle, v_virtual_list } = baseModule;

  test("TextView draws its text and takes only declared methods", () => {
    reset();
    const el = TextView.markdown("m1", "**hi** there").selectable(true).w_full();
    expect(textOf(div().child(el))).toBe("**hi** there");
    expect(el.attrs.markdown).toBe("**hi** there");
    expect(() => TextView.markdown("m2", "x").copyable(true)).toThrow("unknown builder method copyable");
    expect(() => div().selectable(true)).toThrow("unknown builder method selectable");
    expect(() => TextView.rich("m3", "x")).toThrow();
  });

  test("TextareaState: declared methods, events fired as an event, never made in render", async () => {
    reset();
    const s = TextareaState.new({ placeholder: "Message Claude…" });
    s.set_auto_grow(1, 8);
    let seen = null;
    s.on("submit", (e) => {
      seen = [e.shift, s.value()];
    });
    inspect(s).value = "hi";
    await emit(s, "submit", { shift: false }, makeCx());
    expect(seen).toEqual([false, "hi"]);
    expect(inspect(s).autoGrow).toEqual([1, 8]);
    s.focus();
    expect(inspect(s).focused).toBe(1);
    expect(() => s.set_masked(true)).toThrow("TextareaState has no set_masked");
    expect(() => s.on("keydown", () => {})).toThrow("TextareaState.on: unknown event keydown");
    expect(Textarea.new(s).attrs.state).toBe(s);
    setPhase("render");
    expect(() => TextareaState.new({})).toThrow("TextareaState.new in render");
  });

  test("v_virtual_list renders every row, checks sizes and keys, and refuses handlers in rows", () => {
    reset();
    const rows = ["a", "b", "c"];
    const list = v_virtual_list(
      "chat",
      3,
      [10, 20, 30],
      (i) => rows[i],
      (r) => rows.slice(r.start, r.end).map((x) => div().child(x)),
    );
    expect(textOf(list)).toBe("a b c");
    expect(list.attrs.keys).toEqual(["a", "b", "c"]);
    expect(() =>
      v_virtual_list(
        "l",
        3,
        [1, 2],
        (i) => rows[i],
        () => [],
      ),
    ).toThrow("2 sizes for 3 items");
    expect(() =>
      v_virtual_list(
        "l",
        2,
        5,
        () => "same",
        () => [div(), div()],
      ),
    ).toThrow("duplicate key same");
    expect(() =>
      v_virtual_list(
        "l",
        1,
        5,
        () => "k",
        () => [div().on_click(() => {})],
      ),
    ).toThrow("on_click inside a virtual list's renderer");
    expect(() =>
      v_virtual_list(
        "l",
        2,
        5,
        (i) => `k${i}`,
        () => [div()],
      ),
    ).toThrow("returned 1 elements for 2 items");
    expect(() =>
      v_virtual_list(
        "l",
        1,
        5,
        () => "k",
        (_r, cx) => {
          cx.notify();
          return [div()];
        },
      ),
    ).toThrow("cx.notify() inside a virtual list's renderer");
  });

  test("VirtualListScrollHandle records scrolls and refuses use after release", () => {
    reset();
    const h = VirtualListScrollHandle.new();
    h.scroll_to_item(4, "top");
    h.scroll_to_bottom();
    expect(inspect(h).calls).toEqual([["item", 4, "top"], ["bottom"]]);
    expect(() => h.scroll_to_item(1, "middle")).toThrow("strategy middle");
    h.release();
    expect(() => h.scroll_to_bottom()).toThrow("used after release");
    expect(div().track_scroll(VirtualListScrollHandle.new()).attrs.track_scroll).toBeDefined();
  });

  test("Scrollbar names the area it drives", () => {
    expect(Scrollbar.vertical("chat").attrs).toMatchObject({ id: "chat", axis: "vertical" });
    expect(() => Scrollbar.diagonal("chat")).toThrow();
  });

  test("image takes a picture bw copied under data/bellwether/pictures", () => {
    reset();
    expect(() => image("data/bellwether/pictures/c3ebbf21e766d2f1.png")).not.toThrow();
    expect(() => image("data/bellwether/pictures/../x.png")).toThrow("image path");
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
    cx.spawn(async (cx) => {
      await cx.sleep(5000);
      woke = true;
    });
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
  test("a mod importing a name herdr lacks fails to load", async () =>
    expect(mount("bw-bad-import", { root: F })).rejects.toThrow("nothere"));

  test("live read in a timer is refused", async () => {
    const m = await mount("bw-bad", { root: F, props: { case: "timer" } });
    await expect(m.tickTimer(0)).rejects.toThrow("live data read from a timer: spaces()");
  });

  test("live read in a task is refused", async () =>
    expect(mount("bw-bad", { root: F, props: { case: "task" } })).rejects.toThrow(
      "live data read from a task: spaces()",
    ));

  test("a swallowed refusal still fails the step", async () =>
    expect(mount("bw-bad", { root: F, props: { case: "swallowed" } })).rejects.toThrow(
      "live data read from a task: spaces()",
    ));

  test("a task that throws fails the step", async () =>
    expect(mount("bw-bad", { root: F, props: { case: "throws" } })).rejects.toThrow("task blew up"));

  test("misspelled command and bad arg are refused", async () => {
    await expect(mount("bw-bad", { root: F, props: { case: "command" } })).rejects.toThrow("unknown command tab.mvoe");
    await expect(mount("bw-bad", { root: F, props: { case: "arg" } })).rejects.toThrow(
      "tab.move: unknown argument idx",
    );
    await expect(mount("bw-bad", { root: F, props: { case: "required" } })).rejects.toThrow(
      "tab.move: missing required argument index",
    );
  });

  test("a mod's own command is allowed", async () => {
    const m = await mount("bw-bad", { root: F, props: { case: "own" } });
    expect(m.log.run).toEqual([["bw-bad.refresh"]]);
  });

  test("timer under 1 s is refused", async () =>
    expect(mount("bw-bad", { root: F, props: { case: "fast" } })).rejects.toThrow("timer.every(250) is under 1000 ms"));

  test("svg paths must be a bw mod's own file or icons/", async () => {
    await expect(mount("bw-bad", { root: F, props: { case: "path" } })).rejects.toThrow(
      "svg path mods/bw-bad/nope.svg",
    );
    await expect(mount("bw-bad", { root: F, props: { case: "foreign" } })).rejects.toThrow(
      "svg path mods/spaces/icon.svg",
    );
    expect(() => svg("icons/nvim.svg")).not.toThrow();
  });

  test("an element reused in render is refused", async () =>
    expect(mount("bw-bad", { root: F, props: { case: "reuse" } })).rejects.toThrow("used twice"));

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
