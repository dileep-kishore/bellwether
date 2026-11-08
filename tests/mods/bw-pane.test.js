import { expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { paneActions, paneName, shortFolder } from "../../mods/bw-pane/main.js";

const withPane = (/** @type {Record<string, unknown>} */ change = {}) => {
  const data = live("chat-requests");
  data.panes = data.panes.map((/** @type {any} */ p) => (p.pane === "p8" ? { ...p, ...change } : p));
  return data;
};

test("names the agent or shell by program and spells home as ~", () => {
  expect(paneName({ program: { agent: true, name: "Claude Code" }, title: "Refactor" })).toBe("Claude Code");
  expect(paneName({ program: { shell: true, name: "zsh" }, title: "vim x" })).toBe("zsh");
  expect(paneName({ program: { name: "Neovim" }, title: "main.rs" })).toBe("main.rs");
  expect(paneName({ program: null, title: "" })).toBe("shell");
  expect(shortFolder("/home/test", "/home/test")).toBe("~");
  expect(shortFolder("/home/test/r/a", "/home/test")).toBe("~/r/a");
  expect(shortFolder("/home/tester", "/home/test")).toBe("/home/tester");
  expect(shortFolder(null, "/home/test")).toBe("");
});

test("each button runs its command on this pane only", async () => {
  const m = await mount("bw-pane", { props: { pane: "p8", terminal: "t8" }, live: withPane() });
  for (const a of paneActions("p8", false)) {
    await m.click(`${a.id}-p8`);
  }
  expect(m.log.run.filter(([c]) => c !== "pane.focus")).toEqual([
    ["pane.split", { direction: "right", pane: "p8" }],
    ["pane.split", { direction: "down", pane: "p8" }],
    ["pane.zoom", { pane: "p8" }],
    ["pane.close", { pane: "p8" }],
  ]);
});

test("a zoomed pane offers unzoom", async () => {
  const m = await mount("bw-pane", { props: { pane: "p8" }, live: withPane({ zoomed: true }) });
  expect(byId(m.el, "zoom-p8").kids[0].attrs.path).toBe("mods/bw-pane/icons/unzoom.svg");
});

test("buttons stay mounted and fade in while the header is hovered", async () => {
  const m = await mount("bw-pane", { props: { pane: "p8" }, live: withPane() });
  const actions = () => byId(m.el, "actions-p8");
  expect(actions().attrs).toMatchObject({ opacity: 0, transition: ["opacity", 120] });
  await fire(byId(m.el, "bw-pane"), "on_hover", true, m.cx);
  m.render();
  expect(actions().attrs.opacity).toBe(1);
  expect(findAll(actions(), (e) => /^(split-right|split-down|zoom|close)-p8$/.test(e.attrs.id))).toHaveLength(4);
});

test("a blocked pane shows a breathing Needs you pill and its status mark", async () => {
  const m = await mount("bw-pane", { props: { pane: "p8" }, live: withPane({ status: "blocked" }) });
  expect(byId(m.el, "needs-p8").attrs.loop).toEqual(["opacity", { from: 0.65, to: 1, period: 1400 }]);
  expect(textOf(m.el)).toContain("Claude Code");
  const working = await mount("bw-pane", { props: { pane: "p8" }, live: withPane({ status: "working" }) });
  expect(byId(working.el, "needs-p8")).toBeNull();
  expect(findAll(byId(working.el, "mark-p8"), (e) => e.attrs.spin === 900)).toHaveLength(1);
});

test("a pane that is gone draws an empty header", async () => {
  const m = await mount("bw-pane", { props: { pane: "nope" }, live: withPane() });
  expect(textOf(m.el)).toBe("");
});
