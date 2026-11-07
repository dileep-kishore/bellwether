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

test("layout sizes and ids follow the spec", () => {
  const L = readLayout();
  expect(L.cloned_from).toEqual({ name: "main", version: "0.1.13" });
  expect(node(L, "sidebar")).toMatchObject({ size: { px: 248 }, min: 160, max: 480 });
  expect(node(L, "projects").content).toEqual({ mod: "bw-projects" });
  expect(node(L, "tabs")).toMatchObject({ size: { px: 32 }, window_drag: true, content: { mod: "bw-tabs" } });
  expect(node(L, "main").content.tab).toBe("active");
  expect(node(L, "status").content).toEqual({ mod: "workspace-status" });
  expect(node(L, "right")).toMatchObject({ size: { px: 360 }, min: 280, max: 900 });
  expect(node(L, "right-strip")).toMatchObject({ size: { px: 36 }, content: { mod: "bw-right" } });
  expect(node(L, "right-body")).toMatchObject({ type: "stack", active: "changes" });
  expect(["changes", "issues", "browser"].map((id) => node(L, id).content)).toEqual(
    ["changes", "issues", "browser"].map((panel) => ({ mod: "bw-right", props: { panel } })),
  );
  expect(new Set(allMods(L).filter((m) => !m.startsWith("bw-")))).toEqual(
    new Set(["workspace-chrome", "workspace-status", "pane"]),
  );
});

test("root keeps main's window chrome and the three columns in order", () => {
  const L = readLayout();
  expect(L).toMatchObject({
    id: "root",
    type: "row",
    titlebar: "none",
    traffic_lights: [12, 16],
    background: "canvas",
    terminal_padding: [14, 12],
    divider: { width: 1, color: "border" },
  });
  expect(L.children.map((c) => c.id)).toEqual(["sidebar", "work", "right"]);
  expect(node(L, "sidebar").children.map((c) => c.id)).toEqual(["projects", "sidebar-footer"]);
  expect(node(L, "sidebar-footer")).toMatchObject({
    size: { px: 69 },
    content: { mod: "workspace-chrome", props: { footer: true } },
  });
  expect(node(L, "right").children.map((c) => c.id)).toEqual(["right-strip", "right-body"]);
  expect(node(L, "right-strip").content).toEqual({ mod: "bw-right" });
  for (const id of ["sidebar", "right"]) expect(node(L, id)).toMatchObject({ type: "column", background: "chrome" });
  expect(node(L, "right").hidden).toBeUndefined();
});

test("main keeps main.json's pane frame and pane header", () => {
  expect(node(readLayout(), "main").content.pane).toEqual({
    gap: 8,
    radius: 10,
    background: "background",
    lone: true,
    border: { width: 1, color: "border" },
    focus: { width: 1, color: "accent" },
    header: { content: { mod: "pane" }, height: 30, position: "top", reveal: "always" },
  });
});

test("node ids are unique and Herdr's dropped blocks are gone", () => {
  const ids = [...walk(readLayout())].map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const gone of ["brand", "spaces", "agents", "panel", "files"]) expect(ids).not.toContain(gone);
});

test("keys file binds cmd-alt-b to toggle the layout's right column", () => {
  expect(readKeys()).toEqual({ "layout:bellwether": { "cmd-alt-b": "layout.toggle:right" } });
  expect(node(readLayout(), "right").type).toBe("column");
});
