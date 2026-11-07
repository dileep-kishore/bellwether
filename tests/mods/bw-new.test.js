import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, textOf } from "../harness/kit-stub.js";
import { chatLaunch, contextOf, menuEntries } from "../../mods/bw-new/entries.js";

const agent = (key, name, installed) => ({ key, name, icon: `icons/${key}.svg`, tint: key === "codex", tile: null, color: null, shell: false, agent: true, run: [key], installed });
const codex = (installed) => agent("codex", "Codex", installed);
const claude = (installed) => agent("claude", "Claude Code", installed);
const LOCAL = { space: "s1", machine: null, folder: "/r/alpha" };
const REMOTE = { space: "macmini/s3", machine: "macmini", folder: "/home/u/gamma" };
const NO_SPACE = { space: null, machine: null, folder: "/r/beta" };

/** @param {string} id @param {Partial<Parameters<typeof menuEntries>[0]>} opts */
function row(id, { agents = null, failed = false, ctx = LOCAL } = {}) {
  const r = menuEntries({ agents, failed, ctx }).find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}
const hint = (id, opts) => { const r = row(id, opts); return [r.enabled, r.hint]; };

describe("entries", () => {
  test("rows in three sections, New chat first", () => {
    expect(menuEntries({ agents: [], failed: false, ctx: LOCAL }).map((r) => [r.section, r.id, r.label, r.kind])).toEqual([
      ["New chat", "chat-claude", "Claude", "claude"],
      ["New chat", "chat-codex", "Codex", "codex"],
      ["New terminal", "shell", "Shell", null],
      ["New terminal", "claude", "Claude", "claude"],
      ["New terminal", "codex", "Codex", "codex"],
      ["Worktree", "worktree-new", "New worktree…", null],
      ["Worktree", "worktree-open", "Open worktree…", null],
    ]);
  });

  test("entries: codex on the remote space starts there", () => {
    expect(row("codex", { agents: [codex(true)], ctx: REMOTE }).action).toEqual(["run", "tab.new", { space: "macmini/s3", name: "Codex", argv: ["codex"] }]);
  });

  test("entries: New chat rows for installed agents", () => {
    expect(row("chat-codex", { agents: [codex(true)], ctx: REMOTE }).action).toEqual(["chat", { kind: "codex", name: "Codex", argv: ["codex"] }]);
    expect(row("chat-claude", { agents: [claude(true)], ctx: NO_SPACE }).action).toEqual(["chat", { kind: "claude", name: "Claude Code", argv: ["claude"] }]);
  });

  test("New chat rows are enabled and hinted as the terminal rows", () => {
    for (const agents of [[codex(true)], [codex(false)], [claude(true)], null]) {
      for (const failed of [false, true]) {
        expect(hint("chat-codex", { agents, failed })).toEqual(hint("codex", { agents, failed }));
        expect(hint("chat-claude", { agents, failed })).toEqual(hint("claude", { agents, failed }));
      }
    }
  });

  test("chat launch: tab.new in the space, with its tabs before", () => {
    const { spaces } = live("two-machines");
    expect(chatLaunch({ kind: "codex", name: "Codex", argv: ["codex"] }, REMOTE, spaces)).toEqual({
      pending: { kind: "codex", machine: "macmini", space: "macmini/s3", folder: "/home/u/gamma", beforeTabs: ["macmini/tb5"], beforeSpaces: ["s1", "s2", "macmini/s3"], name: "Codex" },
      command: ["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex"] }],
    });
  });

  test("chat launch without a space: space.new names the machine and the tab", () => {
    const { spaces } = live("two-machines");
    expect(chatLaunch({ kind: "claude", name: "Claude Code", argv: ["claude"] }, NO_SPACE, spaces)).toEqual({
      pending: { kind: "claude", machine: null, space: null, folder: "/r/beta", beforeTabs: [], beforeSpaces: ["s1", "s2", "macmini/s3"], name: "Claude Code" },
      command: ["space.new", { folder: "/r/beta", machine: "", tab: "Claude Code", argv: ["claude"] }],
    });
    const ctx = { space: null, machine: "macmini", folder: null };
    expect(chatLaunch({ kind: "codex", name: "Codex", argv: ["codex"] }, ctx, []).command).toEqual(["space.new", { machine: "macmini", tab: "Codex", argv: ["codex"] }]);
  });

  test("shell in a space opens a tab there", () => {
    expect(row("shell", { ctx: REMOTE }).action).toEqual(["run", "tab.new", { space: "macmini/s3" }]);
    expect(row("shell", { ctx: REMOTE }).enabled).toBe(true);
  });

  test("no space: space.new names this Mac", () => {
    expect(row("shell", { ctx: NO_SPACE }).action).toEqual(["run", "space.new", { folder: "/r/beta", machine: "" }]);
    expect(row("claude", { agents: [claude(true)], ctx: NO_SPACE }).action).toEqual(["run", "space.new", { folder: "/r/beta", machine: "", tab: "Claude Code", argv: ["claude"] }]);
  });

  test("no space on another machine: space.new names that machine", () => {
    const ctx = { space: null, machine: "macmini", folder: "/home/u/gamma" };
    expect(row("codex", { agents: [codex(true)], ctx }).action).toEqual(["run", "space.new", { folder: "/home/u/gamma", machine: "macmini", tab: "Codex", argv: ["codex"] }]);
  });

  test("not installed and checking hints", () => {
    expect(hint("codex", { agents: [codex(true)] })).toEqual([true, ""]);
    expect(hint("codex", { agents: [codex(false)] })).toEqual([false, "not installed"]);
    expect(hint("claude", { agents: [codex(true)] })).toEqual([false, "not installed"]);
    expect(hint("claude", { agents: null })).toEqual([false, "checking…"]);
    expect(hint("claude", { agents: null, failed: true })).toEqual([false, "could not check"]);
    expect(hint("claude", { agents: [claude(true)], failed: true })).toEqual([true, ""]);
    expect(hint("shell", { agents: null, failed: true })).toEqual([true, ""]);
  });

  test("worktree entries pass Herdr's dialog props", () => {
    expect(row("worktree-new").action).toEqual(["overlay", { mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: "s1", folder: "/r/alpha", action: "new" } }]);
    expect(row("worktree-open", { ctx: REMOTE }).action).toEqual(["overlay", { mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: "macmini/s3", folder: "/home/u/gamma", action: "open" } }]);
    expect(row("worktree-open", { ctx: NO_SPACE }).action).toEqual(["overlay", { mod: "worktree", kind: "dialog", width: 560, height: 480, props: { folder: "/r/beta", machine: null, action: "open" } }]);
  });

  test("worktree entries are disabled without a folder", () => {
    const ctx = { space: null, machine: null, folder: null };
    expect(row("worktree-new", { ctx }).enabled).toBe(false);
    expect(row("worktree-open", { ctx }).enabled).toBe(false);
    expect(row("worktree-new").enabled).toBe(true);
  });

  test("context from a space: its machine and live folder", () => {
    const { spaces, panes } = live("two-machines");
    expect(contextOf({ space: "macmini/s3" }, spaces, panes)).toEqual(REMOTE);
    expect(contextOf({ space: "s1", overlay: "o1" }, spaces, panes)).toEqual(LOCAL);
  });

  test("context from a folder, and from a space that is gone", () => {
    expect(contextOf({ machine: null, folder: "/r/beta" }, [], [])).toEqual(NO_SPACE);
    expect(contextOf({ machine: "macmini", folder: "/x" }, [], [])).toEqual({ space: null, machine: "macmini", folder: "/x" });
    expect(contextOf({ folder: "/x" }, [], [])).toEqual({ space: null, machine: null, folder: "/x" });
    expect(contextOf({ space: "gone" }, [], [])).toEqual({ space: null, machine: null, folder: null, closed: true });
    expect(contextOf(undefined, [], [])).toEqual({ space: null, machine: null, folder: null });
  });
});

describe("entries", () => {
  test("a closed space disables every row and says so", () => {
    const ctx = { space: null, machine: null, folder: null, closed: true };
    for (const r of menuEntries({ agents: [claude(true), codex(true)], failed: false, ctx })) {
      expect([r.id, r.enabled, r.hint]).toEqual([r.id, false, "the space closed"]);
    }
  });
});

describe("bw-new", () => {
  test("the space closing while the menu is open runs nothing", async () => {
    const data = live("remote-active");
    data.knownAgents = async () => [codex(true)];
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o" }, live: data });
    await m.cx.flush();
    fake.spaces = fake.spaces.filter((s) => s.id !== "macmini/s3");
    m.render();
    expect(textOf(byId(m.el, "row-shell"))).toContain("the space closed");
    await m.click("row-shell");
    await m.click("row-codex");
    await m.click("row-chat-codex");
    await m.click("row-worktree-new");
    expect(m.log.run).toEqual([]);
    expect(m.log.exec).toEqual([]);
    expect(m.log.shared.filter(([k]) => k === "bw.chat-tabs")).toEqual([]);
    expect(m.log.overlays).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("a row drawn before the space closed runs nothing", async () => {
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o" }, live: live("remote-active") });
    fake.spaces = fake.spaces.filter((s) => s.id !== "macmini/s3");
    await m.click("row-shell");
    expect(m.log.run).toEqual([]);
    expect(m.log.closed).toEqual([]);
  });

  test("bw-new shows cached agents then knownAgents for the space's machine", async () => {
    /** @type {(v: unknown) => void} */
    let answer = () => {};
    const data = live("two-machines");
    data.shared = { "bw.known-agents": { macmini: [codex(false)], "": [claude(true)] } };
    data.knownAgents = () => new Promise((r) => { answer = r; });
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o3" }, live: data });
    expect(textOf(byId(m.el, "row-codex"))).toContain("not installed");
    answer([codex(true)]);
    await m.cx.flush();
    m.render();
    expect(textOf(byId(m.el, "row-codex"))).not.toContain("not installed");
    expect(m.log.knownAgents).toEqual([{ on: "macmini" }]);
    expect(m.log.exec).toEqual([]);
    expect(m.log.shared).toEqual([["bw.known-agents", { macmini: [codex(true)], "": [claude(true)] }]]);
    await m.click("row-codex");
    expect(m.log.closed).toEqual(["o3"]);
    expect(m.log.run).toEqual([["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex"] }]]);
  });

  test("this Mac asks knownAgents with on null and says checking until it answers", async () => {
    const data = live("two-machines");
    data.knownAgents = () => new Promise(() => {});
    const m = await mount("bw-new", { props: { space: "s1" }, live: data });
    expect(m.log.knownAgents).toEqual([{ on: null }]);
    expect(textOf(byId(m.el, "row-claude"))).toContain("checking…");
  });

  test("a failed check says so", async () => {
    const data = live("two-machines");
    data.knownAgents = async () => { throw new Error("offline"); };
    const m = await mount("bw-new", { props: { space: "macmini/s3" }, live: data });
    expect(textOf(byId(m.el, "row-codex"))).toContain("could not check");
    expect(m.log.shared).toEqual([]);
  });

  test("a click closes the popup, then acts", async () => {
    const m = await mount("bw-new", { props: { machine: null, folder: "/r/beta", overlay: "o5" }, live: live("empty") });
    await m.click("row-shell");
    expect(m.log.closed).toEqual(["o5"]);
    expect(m.log.run).toEqual([["space.new", { folder: "/r/beta", machine: "" }]]);
    await m.click("row-worktree-new");
    expect(m.log.overlays).toEqual([{ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { folder: "/r/beta", machine: null, action: "new" } }]);
  });

  test("chat click records pending, then tab.new in that space", async () => {
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o1" }, live: live("two-machines") });
    const before = Date.now();
    await m.click("row-chat-codex");
    expect(m.log.closed).toEqual(["o1"]);
    const [key, value] = m.log.shared.at(-1);
    expect(key).toBe("bw.chat-tabs");
    expect(value.pending).toHaveLength(1);
    expect(value.pending[0]).toMatchObject({ kind: "codex", machine: "macmini", space: "macmini/s3", folder: "/home/u/gamma", beforeTabs: ["macmini/tb5"], name: "Codex" });
    expect(value.pending[0].at).toBeGreaterThanOrEqual(before);
    expect(m.log.run).toEqual([["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex"] }]]);
  });

  test("a second chat click keeps the first pending chat", async () => {
    const m = await mount("bw-new", { props: { machine: null, folder: "/r/beta", overlay: "o1" }, live: live("two-machines") });
    await m.click("row-chat-claude");
    await m.click("row-chat-codex");
    const value = m.log.shared.at(-1)[1];
    expect(value.pending.map((p) => [p.kind, p.space, p.machine, p.beforeSpaces])).toEqual([
      ["claude", null, null, ["s1", "s2", "macmini/s3"]],
      ["codex", null, null, ["s1", "s2", "macmini/s3"]],
    ]);
    expect(m.log.run).toEqual([
      ["space.new", { folder: "/r/beta", machine: "", tab: "Claude Code", argv: ["claude"] }],
      ["space.new", { folder: "/r/beta", machine: "", tab: "Codex", argv: ["codex"] }],
    ]);
  });

  test("a disabled row does nothing", async () => {
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o2" }, live: live("two-machines") });
    expect(textOf(byId(m.el, "row-claude"))).toContain("not installed");
    await m.click("row-claude");
    await m.click("row-chat-claude");
    expect(m.log.closed).toEqual([]);
    expect(m.log.run).toEqual([]);
    expect(m.log.exec).toEqual([]);
    expect(m.log.shared.filter(([k]) => k === "bw.chat-tabs")).toEqual([]);
  });

  test("draws a 232 px popover column with its three section headings", async () => {
    const m = await mount("bw-new", { props: { space: "s1" }, live: live("two-machines") });
    expect(m.el.attrs.w).toBe(232);
    expect(m.el.attrs.bg).toBe("#popover");
    const text = textOf(m.el);
    expect(text.indexOf("New chat")).toBeLessThan(text.indexOf("New terminal"));
    expect(text.indexOf("New terminal")).toBeLessThan(text.indexOf("Worktree"));
    expect(byId(m.el, "row-chat-codex").attrs.h).toBe(30);
    expect(byId(m.el, "row-shell").attrs.h).toBe(30);
  });
});
