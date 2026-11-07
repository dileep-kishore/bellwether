import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, textOf } from "../harness/kit-stub.js";
import { PANELS, choose, chosen, wanted } from "../../mods/bw-right/choice.js";

const selects = (m) => m.log.run.filter(([cmd]) => cmd === "layout.select");
/** Does what Herdr does on layout.select: the stack's active child changes in layout(). */
function showInLayout(child, node = fake.layout) {
  if (node.id === "right-body") node.active = child;
  for (const c of node.children ?? []) showInLayout(child, c);
}
/** two-machines with a stored per-space choice. */
const withStored = (stored) => ({ ...live("two-machines"), shared: { "bw.right.tab": stored } });

describe("choice", () => {
  test("panels in strip order with their phases", () => {
    expect(PANELS.map((p) => [p.id, p.label, p.phase])).toEqual([["changes", "Changes", 5], ["issues", "Issues", 6], ["browser", "Browser", 4]]);
  });

  test("chosen defaults to changes for missing, junk and unknown ids", () => {
    for (const stored of [undefined, null, [], "issues", 7, { s1: "nope" }, { s2: "issues" }]) expect(chosen(stored, "s1")).toBe("changes");
    expect(chosen({ s1: "browser" }, "s1")).toBe("browser");
    expect(chosen({ s1: "browser" }, null)).toBe("changes");
  });

  test("choose sets one space and drops spaces that are gone", () => {
    expect(choose({ s1: "browser", gone: "issues", s2: "junk" }, "s1", "issues", ["s1", "s2"])).toEqual({ s1: "issues" });
    expect(choose(null, "s2", "browser", ["s1", "s2"])).toEqual({ s2: "browser" });
    expect(choose({ s1: "browser" }, null, "issues", ["s1"])).toEqual({ s1: "browser" });
  });

  test("wanted is null when the layout already shows the choice", () => {
    expect(wanted({ s1: "issues" }, "s1", "issues")).toBe(null);
    expect(wanted({ s1: "issues" }, "s1", "changes")).toBe("issues");
    expect(wanted({}, "s1", "browser")).toBe("changes");
    expect(wanted({ s1: "issues" }, null, "browser")).toBe(null);
  });
});

describe("bw-right", () => {
  test("panel copy names its phase", async () => {
    expect(textOf((await mount("bw-right", { props: { panel: "browser" } })).el)).toContain("Browser: coming in phase 4");
    expect(textOf((await mount("bw-right", { props: { panel: "changes" } })).el)).toContain("Changes: coming in phase 5");
    expect(textOf((await mount("bw-right", { props: { panel: "issues" } })).el)).toContain("Issues: coming in phase 6");
  });

  test("panel copies never switch the stack", async () => {
    const m = await mount("bw-right", { props: { panel: "issues" }, live: withStored({ s1: "browser" }) });
    m.render();
    expect(m.log.run).toEqual([]);
  });

  test("strip draws three tabs, the chosen one selected", async () => {
    const m = await mount("bw-right", { live: withStored({ s1: "issues" }) });
    expect(textOf(m.el)).toBe("Changes Issues Browser");
    expect(byId(m.el, "right-tab-issues").attrs.bg).toBe("#selected");
    expect(byId(m.el, "right-tab-changes").attrs.bg).not.toBe("#selected");
    expect(m.el.attrs.h).toBe(36);
  });

  test("strip click selects and remembers per space", async () => {
    const m = await mount("bw-right", { live: live("two-machines") });
    await m.click("right-tab-issues");
    expect(m.log.run).toContainEqual(["layout.select", { stack: "right-body", child: "issues" }]);
    expect(selects(m)).toHaveLength(1);
    expect(m.log.shared.at(-1)).toEqual(["bw.right.tab", { s1: "issues" }]);
    expect(byId(m.el, "right-tab-issues").attrs.bg).toBe("#selected");
  });

  test("switching to a space restores its tab once", async () => {
    const m = await mount("bw-right", { live: withStored({ s2: "browser" }) });
    expect(selects(m)).toEqual([]);
    for (const s of fake.spaces) s.active = s.id === "s2";
    m.render();
    m.render();
    expect(selects(m)).toEqual([["layout.select", { stack: "right-body", child: "browser" }]]);
    showInLayout("browser");
    m.render();
    expect(selects(m)).toHaveLength(1);
    for (const s of fake.spaces) s.active = s.id === "s1";
    m.render();
    expect(selects(m).at(-1)).toEqual(["layout.select", { stack: "right-body", child: "changes" }]);
  });

  test("stored ids of closed spaces are dropped", async () => {
    const m = await mount("bw-right", { live: withStored({ s1: "browser", gone: "issues", "macmini/s3": "browser" }) });
    await m.click("right-tab-issues");
    expect(m.log.shared.at(-1)).toEqual(["bw.right.tab", { s1: "issues", "macmini/s3": "browser" }]);
  });

  test("no right-body stack in the layout: nothing to select", async () => {
    const data = withStored({ s1: "issues" });
    data.layout = { id: "root", type: "row", children: [] };
    const m = await mount("bw-right", { live: data });
    m.render();
    expect(selects(m)).toEqual([]);
  });

  test("no space: a click selects without storing", async () => {
    const m = await mount("bw-right", { live: live("empty") });
    await m.click("right-tab-browser");
    expect(selects(m)).toEqual([["layout.select", { stack: "right-body", child: "browser" }]]);
    expect(m.log.shared).toEqual([]);
    showInLayout("browser");
    m.render();
    expect(selects(m)).toHaveLength(1);
    expect(byId(m.el, "right-tab-browser").attrs.bg).toBe("#selected");
  });
});
