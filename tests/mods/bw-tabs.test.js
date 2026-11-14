import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { moveIndex, needsCount, tabItems } from "../../mods/bw-tabs/model.js";

const MODS = { shift: false, control: false, alt: false, platform: false, function: false };
const press = (button = "left") => ({ button, click_count: 1, position: { x: 0, y: 0 }, modifiers: MODS });
const program = (key, name, agent) => ({
  key,
  name,
  icon: `icons/${key}.svg`,
  tint: false,
  tile: null,
  color: null,
  shell: !agent,
  agent,
});
const tab = (id, index, extra = {}) => ({
  id,
  index,
  name: String(index),
  named: false,
  active: false,
  status: null,
  settled: false,
  ...extra,
});

/** @param {(node: any) => void} edit */
function withLayout(edit, data = live("two-machines")) {
  const layout = structuredClone(fake.layout);
  const walk = (n) => {
    edit(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(layout);
  return { ...data, layout };
}

describe("model", () => {
  test("tab items: named title, else program name, agent pane's icon", () => {
    const space = {
      tabs: [
        tab("a", 1, { named: true, name: "fix login", active: true, status: "blocked" }),
        tab("b", 2, { settled: true }),
        tab("c", 3),
      ],
    };
    const panes = [
      { tab: "a", program: program("shell", "zsh", false) },
      { tab: "b", program: program("shell", "zsh", false) },
      { tab: "b", program: program("codex", "Codex", true) },
    ];
    const items = tabItems(space, panes);
    expect(items.map((i) => [i.id, i.index, i.title, i.program?.key ?? null, i.status, i.active, i.settled])).toEqual([
      ["a", 1, "fix login", "shell", "blocked", true, false],
      ["b", 2, "Codex", "codex", null, false, true],
      ["c", 3, "Terminal", null, null, false, false],
    ]);
  });

  test("tab items of no space are empty", () => {
    expect(tabItems(null, [])).toEqual([]);
    expect(tabItems(undefined, [])).toEqual([]);
  });

  test("moveIndex: drop on third tab gives its index; same tab null", () => {
    const items = tabItems({ tabs: [tab("a", 1), tab("b", 2), tab("c", 3)] }, []);
    expect(moveIndex(items, "a", "c")).toBe(3);
    expect(moveIndex(items, "c", "a")).toBe(1);
    expect(moveIndex(items, "b", "b")).toBe(null);
    expect(moveIndex(items, null, "b")).toBe(null);
    expect(moveIndex(items, "gone", "b")).toBe(null);
    expect(moveIndex(items, "a", "gone")).toBe(null);
  });

  test("needsCount deduplicates blocked terminals and counts live-space PR attention", () => {
    const agents = [
      { address: "t1", status: "blocked" },
      { address: "t2", status: "working" },
    ];
    const panes = [
      { terminal: "t1", status: "blocked" },
      { terminal: "t3", status: "blocked" },
    ];
    const spaces = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    const prSummary = {
      s1: { failing: 1, unresolvedThreads: 0, reviewDecision: null },
      s2: { failing: 0, unresolvedThreads: 2, reviewDecision: null },
      s3: { failing: 0, unresolvedThreads: 0, reviewDecision: "APPROVED" },
      closedSpace: { reviewDecision: "CHANGES_REQUESTED" },
    };
    expect(needsCount(agents, panes, spaces, prSummary)).toBe(4);
    expect(needsCount([], [], spaces, { s3: { reviewDecision: "CHANGES_REQUESTED" } })).toBe(1);
  });
});

describe("bw-tabs", () => {
  test("draws the 48 px surface bar with floating tab and utility capsules", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    expect(m.el.attrs.h).toBe(48);
    expect(m.el.attrs.bg).toBe("#surface");
    expect(byId(m.el, "tab-capsule").attrs).toMatchObject({
      bg: "#raised",
      rounded: 18,
      border_color: "#border",
      h: 36,
    });
    expect(byId(m.el, "utility-capsule").attrs).toMatchObject({
      bg: "#raised",
      rounded: 18,
      border_color: "#border",
      h: 36,
    });
    expect(byId(m.el, "tab-tb1").attrs).toMatchObject({ bg: "#selected", text_color: "#foreground", rounded: 13 });
    expect(byId(m.el, "tab-mark-tb1").attrs.bg).toBe("#accent");
    expect(byId(m.el, "tab-mark-tb2")).toBe(null);
    expect(["tb1", "tb2", "tb7"].map((id) => textOf(byId(m.el, `tab-${id}`)))).toEqual([
      "Claude Code",
      "fix login",
      "zsh",
    ]);
    expect(byId(m.el, "tab-tb3")).toBe(null);
    expect(textOf(m.el)).not.toContain("macmini");
    expect(textOf(byId(m.el, "tabs-needs"))).toContain("1 needs you");
  });

  test("hides Needs you pill when zero agents and PRs require attention", async () => {
    const data = live("two-machines");
    data.agents = data.agents.map((a) => ({ ...a, status: "working" }));
    data.panes = data.panes.map((p) => ({ ...p, status: p.status === "blocked" ? "working" : p.status }));
    const m = await mount("bw-tabs", { live: data });
    expect(byId(m.el, "tabs-needs")).toBe(null);
  });

  test("status icons follow each tab's status", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    const spin = findAll(byId(m.el, "tab-tb1"), (e) => e.tag === "svg" && e.attrs.spin === 900);
    expect(spin.map((e) => e.attrs.text_color)).toEqual(["#working"]);
    expect(findAll(byId(m.el, "tab-tb2"), (e) => e.attrs.path === "mods/bw-projects/icons/question.svg")).toHaveLength(
      1,
    );
  });

  test("a plain click selects the tab", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await m.click("tab-tb2");
    expect(m.log.run).toEqual([["tab.select", { id: "tb2" }]]);
  });

  test("drag reorders with tab.move", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await fire(byId(m.el, "tab-tb1"), "on_mouse_down:left", press(), m.cx);
    m.render();
    await fire(
      byId(m.el, "tab-tb7"),
      "on_mouse_move",
      { position: { x: 0, y: 0 }, local_position: { x: 0, y: 0 }, modifiers: MODS },
      m.cx,
    );
    m.render();
    await fire(byId(m.el, "tab-tb7"), "on_mouse_up:left", press(), m.cx);
    await fire(m.el, "on_mouse_up:left", press(), m.cx);
    m.render();
    expect(m.log.run).toEqual([["tab.move", { id: "tb1", index: 3 }]]);
  });

  test("release on the pressed tab moves nothing", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await fire(byId(m.el, "tab-tb2"), "on_mouse_down:left", press(), m.cx);
    await fire(byId(m.el, "tab-tb2"), "on_mouse_up:left", press(), m.cx);
    expect(m.log.run).toEqual([]);
  });

  test("a release after a press outside the tabs moves nothing", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await fire(byId(m.el, "tab-tb1"), "on_mouse_down:left", press(), m.cx);
    await fire(m.el, "on_mouse_up:left", press(), m.cx);
    await fire(m.el, "on_mouse_down:left", press(), m.cx);
    await fire(byId(m.el, "tab-tb7"), "on_mouse_up:left", press(), m.cx);
    expect(m.log.run).toEqual([]);
  });

  test("a drag released off the bar is forgotten at the next press elsewhere", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await fire(byId(m.el, "tab-tb1"), "on_mouse_down:left", press(), m.cx);
    await fire(m.el, "on_mouse_down_out", press(), m.cx);
    await fire(byId(m.el, "tab-tb7"), "on_mouse_up:left", press(), m.cx);
    expect(m.log.run).toEqual([]);
  });

  test("every capsule and control stops the window drag on mouse down", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    const ids = [
      "tab-capsule",
      "utility-capsule",
      "tab-tb1",
      "tab-tb2",
      "close-tb1",
      "tab-new",
      "tabs-needs",
      "tabs-overview",
      "tabs-terminal",
      "tabs-peek",
      "tabs-inspector",
    ];
    for (const id of ids) await fire(byId(m.el, id), "on_mouse_down:left", press(), m.cx);
    expect(m.cx.stopped).toBe(ids.length);
    await fire(m.el, "on_mouse_down:left", press(), m.cx);
    expect(m.cx.stopped).toBe(ids.length);
  });

  test("utility buttons toggle inspector and peek active terminal", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await m.click("tabs-peek");
    await m.click("tabs-inspector");
    expect(m.log.run).toEqual([
      ["terminal.peek", { terminal: "t1" }],
      ["layout.toggle", { id: "right" }],
    ]);
  });

  test("remote space tabs carry the machine tag", async () => {
    const m = await mount("bw-tabs", { live: live("remote-active") });
    expect(textOf(byId(m.el, "tab-macmini/tb5"))).toBe("Codex macmini");
    expect(byId(m.el, "tab-tb1")).toBe(null);
  });

  test("close button only on the active tab", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    expect(byId(m.el, "close-tb1")).not.toBe(null);
    expect(byId(m.el, "close-tb2")).toBe(null);
    expect(byId(m.el, "close-tb7")).toBe(null);
    await m.click("close-tb1");
    expect(m.log.run).toEqual([["tab.close", { id: "tb1" }]]);
    expect(m.cx.stopped).toBe(1);
  });

  test("settled tabs are italic, never faded", async () => {
    const data = live("two-machines");
    data.spaces[0].tabs[2].settled = true;
    const m = await mount("bw-tabs", { live: data });
    expect(byId(m.el, "tab-tb7").attrs).toMatchObject({ italic: undefined, text_color: "#muted" });
    expect("italic" in byId(m.el, "tab-tb7").attrs).toBe(true);
    expect("italic" in byId(m.el, "tab-tb2").attrs).toBe(false);
    expect(byId(m.el, "tab-tb7").attrs.opacity).toBe(undefined);
  });

  test("+ opens bw-new at 232 px with the space", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await m.click("tab-new");
    expect(m.log.overlays).toEqual([
      { mod: "bw-new", kind: "popup", width: 232, height: 300, frame: "none", props: { space: "s1" } },
    ]);
    expect(m.log.run).toEqual([]);
  });

  test("+ with no space opens bw-new on this Mac's home", async () => {
    const m = await mount("bw-tabs", { live: live("empty") });
    expect(findAll(m.el, (e) => typeof e.attrs.id === "string" && /^tab-tb/.test(e.attrs.id))).toEqual([]);
    expect(byId(m.el, "tabs-peek").attrs.opacity).toBe(0.45);
    await m.click("tab-new");
    expect(m.log.overlays).toEqual([
      {
        mod: "bw-new",
        kind: "popup",
        width: 232,
        height: 300,
        frame: "none",
        props: { machine: null, folder: "/home/test" },
      },
    ]);
  });

  test("left padding clears traffic lights with zoom scaling and shows sidebar toggle when sidebar is hidden", async () => {
    const shown = await mount("bw-tabs", { live: live("two-machines") });
    expect(shown.el.attrs.pl).toBe(10);
    expect(byId(shown.el, "tabs-sidebar")).toBe(null);

    const hidden = withLayout((n) => {
      if (n.id === "sidebar") n.hidden = true;
    });
    const mHidden = await mount("bw-tabs", { live: hidden });
    expect(mHidden.el.attrs.pl).toBe(78);
    expect(byId(mHidden.el, "tabs-sidebar")).not.toBe(null);
    await mHidden.click("tabs-sidebar");
    expect(mHidden.log.run).toEqual([["layout.toggle", { id: "sidebar" }]]);

    expect((await mount("bw-tabs", { live: { ...hidden, settings: { zoom: 1.25 } } })).el.attrs.pl).toBe(98);
    expect(
      (await mount("bw-tabs", { live: { ...hidden, window: { ...fake.window, fullscreen: true } } })).el.attrs.pl,
    ).toBe(10);
    expect(
      (await mount("bw-tabs", { live: { ...hidden, window: { ...fake.window, titlebar: "system" } } })).el.attrs.pl,
    ).toBe(10);
    expect(
      (await mount("bw-tabs", { live: { ...hidden, window: { ...fake.window, platform: "linux" } } })).el.attrs.pl,
    ).toBe(10);
  });
});
