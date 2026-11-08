import { expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { byId, findAll, textOf } from "../harness/kit-stub.js";
import { mostUrgent, paletteKey } from "../../mods/bw-status/main.js";

const agent = (/** @type {string} */ address, /** @type {string} */ status) => ({ address, status });

test("urgency ranks blocked, done, working, idle", () => {
  expect(mostUrgent(["idle", "working"])).toBe("working");
  expect(mostUrgent(["working", "done"])).toBe("done");
  expect(mostUrgent(["done", "blocked", "idle"])).toBe("blocked");
  expect(mostUrgent([])).toBeNull();
});

test("the palette key reads as bound, or not at all", () => {
  const b = [{ section: "global", keys: "cmd-shift-p", action: "app.palette" }];
  expect(paletteKey(b, true)).toBe("⌘⇧P");
  expect(paletteKey(b, false)).toBe("Ctrl+Shift+P");
  expect(paletteKey([{ section: "global", keys: "cmd--", action: "app.palette" }], true)).toBe("⌘-");
  expect(paletteKey([], true)).toBeNull();
});

test("machine, branch, agent count and a breathing needs-you pill", async () => {
  const data = live("chat-requests");
  data.agents = [agent("t1", "working"), agent("t2", "blocked"), agent("t3", "idle")];
  data.keys = [{ section: "global", keys: "cmd-shift-p", action: "app.palette" }];
  const m = await mount("bw-status", { live: data });
  const text = textOf(m.el);
  expect(text).toContain("This Mac");
  expect(text).toContain("3 agents");
  expect(text).toContain("⌘⇧P commands");
  expect(byId(m.el, "status-needs").attrs.loop).toEqual(["opacity", { from: 0.65, to: 1, period: 1400 }]);
  expect(textOf(byId(m.el, "status-needs"))).toBe("1 needs you");
  await m.click("status-palette");
  expect(m.log.run).toContainEqual(["app.palette"]);
});

test("an idle window has no motion in the status bar", async () => {
  const data = live("chat-requests");
  data.agents = [agent("t1", "idle")];
  const m = await mount("bw-status", { live: data });
  expect(byId(m.el, "status-needs")).toBeNull();
  expect(findAll(m.el, (e) => e.attrs.loop !== undefined || e.attrs.spin !== undefined)).toEqual([]);
  expect(textOf(m.el)).toContain("1 agent");
});
