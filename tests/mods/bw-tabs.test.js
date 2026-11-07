import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { moveIndex, tabItems } from "../../mods/bw-tabs/model.js";

const MODS = { shift: false, control: false, alt: false, platform: false, function: false };
const press = (button = "left") => ({ button, click_count: 1, position: { x: 0, y: 0 }, modifiers: MODS });
const program = (key, name, agent) => ({ key, name, icon: `icons/${key}.svg`, tint: false, tile: null, color: null, shell: !agent, agent });
const tab = (id, index, extra = {}) => ({ id, index, name: String(index), named: false, active: false, status: null, settled: false, ...extra });

/** @param {(node: any) => void} edit */
function withLayout(edit, data = live("two-machines")) {
  const layout = structuredClone(fake.layout);
  const walk = (n) => { edit(n); for (const c of n.children ?? []) walk(c); };
  walk(layout);
  return { ...data, layout };
}

describe("model", () => {
  test("tab items: named title, else program name, agent pane's icon", () => {
    const space = { tabs: [tab("a", 1, { named: true, name: "fix login", active: true, status: "blocked" }), tab("b", 2, { settled: true }), tab("c", 3)] };
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
});

describe("bw-tabs", () => {
  test("draws the active space's tabs with their titles", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    expect(m.el.attrs.h).toBe(32);
    expect(m.el.attrs.bg).toBe("#chrome");
    expect(["tb1", "tb2", "tb7"].map((id) => textOf(byId(m.el, `tab-${id}`)))).toEqual(["Claude Code", "fix login", "zsh"]);
    expect(byId(m.el, "tab-tb3")).toBe(null);
    expect(textOf(m.el)).not.toContain("macmini");
  });

  test("status icons follow each tab's status", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    const spin = findAll(byId(m.el, "tab-tb1"), (e) => e.tag === "svg" && e.attrs.spin === 900);
    expect(spin.map((e) => e.attrs.text_color)).toEqual(["#working"]);
    expect(findAll(byId(m.el, "tab-tb2"), (e) => e.attrs.path === "mods/bw-projects/icons/question.svg")).toHaveLength(1);
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
    await fire(byId(m.el, "tab-tb7"), "on_mouse_move", { position: { x: 0, y: 0 }, local_position: { x: 0, y: 0 }, modifiers: MODS }, m.cx);
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

  test("every control stops the window drag on mouse down", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    for (const id of ["tab-tb1", "tab-tb2", "close-tb1", "tab-new"]) await fire(byId(m.el, id), "on_mouse_down:left", press(), m.cx);
    expect(m.cx.stopped).toBe(4);
    await fire(m.el, "on_mouse_down:left", press(), m.cx);
    expect(m.cx.stopped).toBe(4);
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

  test("settled tabs are dimmed", async () => {
    const data = live("two-machines");
    data.spaces[0].tabs[2].settled = true;
    const m = await mount("bw-tabs", { live: data });
    expect(byId(m.el, "tab-tb7").attrs.opacity).toBe(0.6);
    expect(byId(m.el, "tab-tb2").attrs.opacity).toBe(undefined);
  });

  test("+ opens bw-new at 232 px with the space", async () => {
    const m = await mount("bw-tabs", { live: live("two-machines") });
    await m.click("tab-new");
    expect(m.log.overlays).toEqual([{ mod: "bw-new", kind: "popup", width: 232, height: 300, props: { space: "s1" } }]);
    expect(m.log.run).toEqual([]);
  });

  test("+ with no space opens bw-new on this Mac's home", async () => {
    const m = await mount("bw-tabs", { live: live("empty") });
    expect(findAll(m.el, (e) => typeof e.attrs.id === "string" && e.attrs.id.startsWith("tab-") && e.attrs.id !== "tab-new" && e.attrs.id !== "tab-scroll")).toEqual([]);
    await m.click("tab-new");
    expect(m.log.overlays).toEqual([{ mod: "bw-new", kind: "popup", width: 232, height: 300, props: { machine: null, folder: "/home/test" } }]);
  });

  test("left padding clears the traffic lights only when the sidebar is hidden", async () => {
    expect((await mount("bw-tabs", { live: live("two-machines") })).el.attrs.pl).toBe(8);
    const hidden = withLayout((n) => { if (n.id === "sidebar") n.hidden = true; });
    expect((await mount("bw-tabs", { live: hidden })).el.attrs.pl).toBe(76);
    expect((await mount("bw-tabs", { live: { ...hidden, window: { ...fake.window, fullscreen: true } } })).el.attrs.pl).toBe(8);
    expect((await mount("bw-tabs", { live: { ...hidden, window: { ...fake.window, titlebar: "system" } } })).el.attrs.pl).toBe(8);
    expect((await mount("bw-tabs", { live: { ...hidden, window: { ...fake.window, platform: "linux" } } })).el.attrs.pl).toBe(8);
  });
});
