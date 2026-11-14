import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const readLayout = () => JSON.parse(readFileSync(join(ROOT, "layouts/bellwether.json"), "utf8"));
const readKeys = () => JSON.parse(readFileSync(join(ROOT, "keys/bellwether.json"), "utf8"));

function* walk(n) {
  yield n;
  for (const c of [...(n.children ?? []), ...(n.floating ?? [])]) yield* walk(c);
}
const node = (L, id) => [...walk(L)].find((n) => n.id === id);

// Mods named anywhere in the tree, including pane headers inside a tab block.
function allMods(L) {
  const mods = [];
  for (const n of walk(L)) {
    if (n.content?.mod) mods.push(n.content.mod);
    const header = n.content?.pane?.header?.content?.mod;
    if (header) mods.push(header);
    if (n.header?.mod) mods.push(n.header.mod);
  }
  return mods;
}

test("layout sizes and ids follow the refined two-part shell and four-screen stack spec", () => {
  const L = readLayout();
  expect(L.cloned_from).toEqual({ name: "main", version: "0.1.13" });
  expect(node(L, "sidebar")).toMatchObject({ size: { px: 244 }, min: 200, max: 420, background: "chrome" });
  expect(node(L, "projects").content).toEqual({ mod: "bw-projects" });
  expect(node(L, "sidebar-footer")).toMatchObject({
    size: { px: 40 },
    content: { mod: "workspace-chrome", props: { footer: true } },
  });
  expect(node(L, "work")).toMatchObject({ type: "column", resizable: false, background: "surface" });
  expect(node(L, "tabs")).toMatchObject({ size: { px: 48 }, window_drag: true, content: { mod: "bw-tabs" } });
  expect(node(L, "screen")).toMatchObject({ type: "stack", active: "chat" });
  expect(node(L, "screen").children.map((c) => c.id)).toEqual(["chat", "panes", "needs", "overview"]);
  expect(node(L, "sidebar-peek")).toEqual({
    id: "sidebar-peek",
    content: { mod: "bw-projects", props: { peek: true } },
    edge: "left",
    align: "start",
    peek: 6,
  });
  expect(node(L, "chat").content).toEqual({ mod: "bw-chat" });
  expect(node(L, "panes")).toMatchObject({ padding: 8 });
  expect(node(L, "panes").content.tab).toBe("active");
  expect(node(L, "needs").content).toEqual({ mod: "bw-needs" });
  expect(node(L, "overview").content).toEqual({ mod: "bw-overview" });
  expect(node(L, "status")).toBeUndefined();
  expect(node(L, "right")).toMatchObject({ hidden: true, size: { px: 380 }, min: 280, max: 620, background: "chrome" });
  expect(node(L, "right-strip")).toMatchObject({ size: { px: 36 }, content: { mod: "bw-right" } });
  expect(node(L, "right-body")).toMatchObject({ type: "stack", active: "changes" });
  expect(node(L, "right-body").children.map((c) => c.id)).toEqual(["changes", "issues", "drafts", "browser"]);
  expect(node(L, "changes").content).toEqual({ mod: "bw-diff" });
  expect(node(L, "issues").content).toEqual({ mod: "bw-linear" });
  expect(node(L, "drafts").content).toEqual({ mod: "bw-drafts" });
  expect(node(L, "browser").content).toEqual({ mod: "bw-browser" });
  expect(new Set(allMods(L).filter((m) => !m.startsWith("bw-")))).toEqual(new Set(["workspace-chrome"]));
});

test("root keeps main's window chrome and the three columns in order", () => {
  const L = readLayout();
  expect(L).toMatchObject({
    id: "root",
    type: "row",
    titlebar: "none",
    traffic_lights: [12, 16],
    theme: "bellwether",
    preview: "layouts/bellwether.svg",
    background: "canvas",
    terminal_padding: [14, 12],
    divider: { width: 1, color: "border" },
  });
  expect(L.children.map((c) => c.id)).toEqual(["sidebar", "work", "right"]);
  expect(node(L, "sidebar").children.map((c) => c.id)).toEqual(["projects", "sidebar-footer"]);
  expect(node(L, "work").children.map((c) => c.id)).toEqual(["tabs", "screen"]);
  expect(node(L, "right").children.map((c) => c.id)).toEqual(["right-strip", "right-body"]);
});

test("panes draw frameless when lone and show hover-only headers when split", () => {
  expect(node(readLayout(), "panes").content.pane).toEqual({
    gap: 8,
    radius: 10,
    background: "background",
    lone: false,
    border: { width: 1, color: "border" },
    focus: { width: 1, color: "accent" },
    header: { content: { mod: "bw-pane" }, height: 28, position: "top", reveal: "hover" },
  });
});

test("node ids are unique and dropped blocks (including status) are gone", () => {
  const ids = [...walk(readLayout())].map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const gone of ["brand", "spaces", "agents", "panel", "files", "status", "work-body", "main"])
    expect(ids).not.toContain(gone);
});

test("keys file binds sidebar, chat-flip, terminal-peek, needs, overview, and right column shortcuts", () => {
  expect(readKeys()["layout:bellwether"]).toEqual({
    "cmd-alt-b": "layout.toggle:right",
    "cmd-b": "layout.toggle:sidebar",
    "cmd-j": "bw-tabs.chat-flip",
    "cmd-shift-'": "bw-tabs.terminal-peek",
    "cmd-shift-n": "bw-tabs.needs-toggle",
    "cmd-shift-o": "bw-tabs.overview-toggle",
  });
  expect(node(readLayout(), "right").type).toBe("column");
  expect(node(readLayout(), "sidebar").type).toBe("column");
});

test("the preview the root names exists and is an SVG", () => {
  const svg = readFileSync(join(ROOT, readLayout().preview), "utf8");
  expect(svg).toStartWith("<svg");
});
