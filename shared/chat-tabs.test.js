import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPending, adopt, CHAT_PENDING_MS, chatArgv, entryForTerminal, flipActions, isShown, readChatTabs, SPLIT_RETRY_MS, wakeAt,
} from "./chat-tabs.js";

const chatTab = () => JSON.parse(readFileSync(join(import.meta.dir, "../tests/fixtures/live/chat-tab.json"), "utf8"));

const tab = (id, over = {}) => ({ id, index: 1, name: id, named: false, active: false, status: null, panes: 1, zoomed: false, ...over });
const space = (id, tabs, over = {}) => ({ id, index: 1, name: id, named: false, folder: "/r/alpha", machine: null, branch: null, active: false, status: null, tabs, ...over });
const term = (pane, terminal, tabId, over = {}) => ({ pane, terminal, tab: tabId, title: "zsh", cwd: "/r/alpha", branch: null, status: null, app: null, program: null, focused: false, zoomed: false, movable: false, ...over });
const chat = (pane, tabId, over = {}) => ({ pane, terminal: null, mod: "bw-chat", tab: tabId, title: "Chat", focused: false, zoomed: false, ...over });

const claudePending = { kind: "claude", machine: null, space: "s1", folder: null, beforeTabs: ["tb7"], beforeSpaces: [], name: "Claude" };
const spacesWithNewTab = [space("s1", [tab("tb7"), tab("tb8", { active: true })], { active: true })];
const panesTerminalOnly = [term("p7", "t7", "tb7"), term("p8", "t8", "tb8", { focused: true })];
const panesWithChat = [...panesTerminalOnly, chat("p9", "tb8")];

describe("adopt", () => {
  test("adopts the new tab once, then records the chat pane and zooms once", () => {
    const s = addPending(null, claudePending, 0);
    const r1 = adopt(s, spacesWithNewTab, panesTerminalOnly, 100);
    expect(r1.actions).toEqual([["pane.split", { direction: "right", pane: "p8", mod: "bw-chat", props: { terminal: "t8", machine: null, kind: "claude" } }]]);
    expect(r1.next?.pending).toEqual([]);
    expect(r1.next?.tabs.tb8).toMatchObject({ tab: "tb8", space: "s1", terminal: "t8", terminalPane: "p8", chatPane: null, split: { at: 100, tries: 1 } });
    const r2 = adopt(r1.next, spacesWithNewTab, panesTerminalOnly, 200);
    expect(r2.actions).toEqual([]);
    expect(r2.next).toBe(null);
    const r3 = adopt(r1.next, spacesWithNewTab, panesWithChat, 300);
    expect(r3.actions).toEqual([["pane.zoom", { pane: "p9" }]]);
    expect(r3.next?.tabs.tb8).toMatchObject({ chatPane: "p9", zoomed: true });
    expect(adopt(r3.next, spacesWithNewTab, panesWithChat, 400).next).toBe(null);
    expect(adopt(r3.next, spacesWithNewTab, panesWithChat, 400).actions).toEqual([]);
  });

  test("waits while the new tab has no terminal pane yet", () => {
    const s = addPending(null, claudePending, 0);
    const r = adopt(s, spacesWithNewTab, [term("p7", "t7", "tb7")], 100);
    expect(r).toEqual({ next: null, actions: [], notices: [] });
  });

  test("tabs that were there before, or are already chat tabs, are not adopted", () => {
    let s = addPending(null, claudePending, 0);
    s = adopt(s, spacesWithNewTab, panesTerminalOnly, 100).next;
    s = addPending(s, { ...claudePending, beforeTabs: ["tb7"] }, 150);
    const r = adopt(s, spacesWithNewTab, panesTerminalOnly, 200);
    expect(r.actions).toEqual([]);
    expect(r.next).toBe(null);
  });

  test("split retried once after 5 s, then failed with a notice", () => {
    const s = adopt(addPending(null, claudePending, 0), spacesWithNewTab, panesTerminalOnly, 100).next;
    expect(adopt(s, spacesWithNewTab, panesTerminalOnly, 100 + SPLIT_RETRY_MS - 1).next).toBe(null);
    const r1 = adopt(s, spacesWithNewTab, panesTerminalOnly, 100 + SPLIT_RETRY_MS);
    expect(r1.actions).toEqual([["pane.split", { direction: "right", pane: "p8", mod: "bw-chat", props: { terminal: "t8", machine: null, kind: "claude" } }]]);
    expect(r1.next?.tabs.tb8.split).toEqual({ at: 100 + SPLIT_RETRY_MS, tries: 2 });
    expect(r1.notices).toEqual([]);
    const later = 100 + 2 * SPLIT_RETRY_MS;
    const r2 = adopt(r1.next, spacesWithNewTab, panesTerminalOnly, later);
    expect(r2.actions).toEqual([]);
    expect(r2.next?.tabs.tb8.failed).toBe(true);
    expect(r2.notices).toEqual([{ title: "Chat pane did not open", body: "The agent keeps running in this tab." }]);
    expect(adopt(r2.next, spacesWithNewTab, panesTerminalOnly, later + 60000)).toEqual({ next: null, actions: [], notices: [] });
  });

  test("pending expires after 30 s with a notice", () => {
    const s = addPending(null, { ...claudePending, name: "Codex", kind: "codex" }, 1000);
    const none = [space("s1", [tab("tb7", { active: true })], { active: true })];
    expect(adopt(s, none, [term("p7", "t7", "tb7")], 1000 + CHAT_PENDING_MS).next).toBe(null);
    const r = adopt(s, none, [term("p7", "t7", "tb7")], 1000 + CHAT_PENDING_MS + 1);
    expect(r.next?.pending).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(r.notices).toEqual([{ title: "Codex chat did not start", body: "No new tab appeared within 30 s." }]);
  });

  test("no space: adopts the new space's first tab on that machine", () => {
    const s = addPending(null, { kind: "codex", machine: "macmini", space: null, folder: "/home/u/gamma", beforeTabs: [], beforeSpaces: ["s1"], name: "Codex" }, 0);
    const spaces = [
      space("s1", [tab("tb7", { active: true })]),
      space("s4", [tab("tb9", { active: true })], { active: true }),
      space("macmini/s6", [tab("macmini/tb11", { active: true }), tab("macmini/tb12")], { machine: "macmini" }),
    ];
    const panes = [term("p7", "t7", "tb7"), term("p10", "t10", "tb9"), term("macmini/p11", "macmini/t11", "macmini/tb11"), term("macmini/p12", "macmini/t12", "macmini/tb12")];
    const r = adopt(s, spaces, panes, 50);
    expect(r.actions).toEqual([["pane.split", { direction: "right", pane: "macmini/p11", mod: "bw-chat", props: { terminal: "macmini/t11", machine: "macmini", kind: "codex" } }]]);
    expect(Object.keys(r.next?.tabs ?? {})).toEqual(["macmini/tb11"]);
  });

  test("remote ids keep their machine prefix in props and entries", () => {
    const s = addPending(null, { kind: "codex", machine: "macmini", space: "macmini/s3", folder: null, beforeTabs: ["macmini/tb5"], beforeSpaces: [], name: "Codex" }, 0);
    const spaces = [space("macmini/s3", [tab("macmini/tb5"), tab("macmini/tb6", { active: true })], { machine: "macmini", active: true })];
    const panes = [term("macmini/p5", "macmini/t5", "macmini/tb5"), term("macmini/p7", "macmini/t7", "macmini/tb6")];
    const r1 = adopt(s, spaces, panes, 10);
    expect(r1.actions).toEqual([["pane.split", { direction: "right", pane: "macmini/p7", mod: "bw-chat", props: { terminal: "macmini/t7", machine: "macmini", kind: "codex" } }]]);
    expect(r1.next?.tabs["macmini/tb6"]).toMatchObject({ tab: "macmini/tb6", space: "macmini/s3", machine: "macmini", terminal: "macmini/t7", terminalPane: "macmini/p7" });
    const r2 = adopt(r1.next, spaces, [...panes, chat("macmini/p8", "macmini/tb6")], 20);
    expect(r2.actions).toEqual([["pane.zoom", { pane: "macmini/p8" }]]);
    expect(entryForTerminal(r2.next, "macmini/t7")?.chatPane).toBe("macmini/p8");
  });

  test("closed tabs are dropped", () => {
    const value = chatTab().shared["bw.chat-tabs"];
    const f = chatTab();
    const spaces = f.spaces.filter((/** @type {any} */ s) => s.id !== "macmini/s3");
    const r = adopt(value, spaces, f.panes, 0);
    expect(Object.keys(r.next?.tabs ?? {})).toEqual(["tb8"]);
    expect(r.actions).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  test("the live fixture is settled: nothing to do", () => {
    const f = chatTab();
    expect(adopt(f.shared["bw.chat-tabs"], f.spaces, f.panes, 0)).toEqual({ next: null, actions: [], notices: [] });
  });
});

describe("flipActions", () => {
  test("flip: chat zoomed → unzoom chat, zoom and focus terminal; and back", () => {
    const f = chatTab();
    const value = f.shared["bw.chat-tabs"];
    expect(flipActions(value, "tb8", f.panes)).toEqual([["pane.zoom", { pane: "p9" }], ["pane.zoom", { pane: "p8" }], ["pane.focus", { pane: "p8" }]]);
    const flipped = f.panes.map((/** @type {any} */ p) => p.pane === "p9" ? { ...p, zoomed: false, focused: false } : p.pane === "p8" ? { ...p, zoomed: true, focused: true } : p);
    expect(flipActions(value, "tb8", flipped)).toEqual([["pane.zoom", { pane: "p8" }], ["pane.zoom", { pane: "p9" }], ["pane.focus", { pane: "p9" }]]);
    expect(flipActions(value, "macmini/tb5", f.panes)).toEqual([["pane.zoom", { pane: "macmini/p6" }], ["pane.zoom", { pane: "macmini/p5" }], ["pane.focus", { pane: "macmini/p5" }]]);
  });

  test("flip: neither zoomed zooms the unfocused pane; not a chat tab or no terminal pane: nothing", () => {
    const f = chatTab();
    const value = f.shared["bw.chat-tabs"];
    const flat = f.panes.map((/** @type {any} */ p) => ({ ...p, zoomed: false }));
    expect(flipActions(value, "tb8", flat)).toEqual([["pane.zoom", { pane: "p8" }], ["pane.focus", { pane: "p8" }]]);
    const termFocused = flat.map((/** @type {any} */ p) => ({ ...p, focused: p.pane === "p8" }));
    expect(flipActions(value, "tb8", termFocused)).toEqual([["pane.zoom", { pane: "p9" }], ["pane.focus", { pane: "p9" }]]);
    expect(flipActions(value, "tb7", f.panes)).toEqual([]);
    expect(flipActions(value, null, f.panes)).toEqual([]);
    expect(flipActions(value, "tb8", f.panes.filter((/** @type {any} */ p) => p.pane !== "p8"))).toEqual([]);
    expect(flipActions(value, "tb8", f.panes.filter((/** @type {any} */ p) => p.pane !== "p9"))).toEqual([]);
    const s = adopt(addPending(null, claudePending, 0), spacesWithNewTab, panesTerminalOnly, 0).next;
    expect(flipActions(s, "tb8", panesTerminalOnly)).toEqual([]);
  });
});

describe("isShown", () => {
  test("isShown: active tab and zoomed chat; behind the terminal's zoom is hidden; another tab is hidden", () => {
    const f = chatTab();
    const value = f.shared["bw.chat-tabs"];
    const local = entryForTerminal(value, "t8");
    const remote = entryForTerminal(value, "macmini/t5");
    expect(isShown(local, f.spaces, f.panes)).toBe(true);
    expect(isShown(remote, f.spaces, f.panes)).toBe(false);
    const behind = f.panes.map((/** @type {any} */ p) => p.pane === "p9" ? { ...p, zoomed: false } : p.pane === "p8" ? { ...p, zoomed: true } : p);
    expect(isShown(local, f.spaces, behind)).toBe(false);
    const unzoomed = f.spaces.map((/** @type {any} */ s) => ({ ...s, tabs: s.tabs.map((/** @type {any} */ t) => ({ ...t, zoomed: false })) }));
    const flat = f.panes.map((/** @type {any} */ p) => ({ ...p, zoomed: false }));
    expect(isShown(local, unzoomed, flat)).toBe(true);
    const otherTab = f.spaces.map((/** @type {any} */ s) => s.id !== "s1" ? s : { ...s, tabs: s.tabs.map((/** @type {any} */ t) => ({ ...t, active: t.id === "tb7" })) });
    expect(isShown(local, otherTab, f.panes)).toBe(false);
    const otherSpace = f.spaces.map((/** @type {any} */ s) => ({ ...s, active: s.id === "macmini/s3" }));
    expect(isShown(local, otherSpace, f.panes)).toBe(false);
    expect(isShown(remote, otherSpace, f.panes)).toBe(true);
    expect(isShown(null, f.spaces, f.panes)).toBe(false);
  });
});

describe("readChatTabs and helpers", () => {
  test("readChatTabs tolerates null, arrays and junk", () => {
    const empty = { version: 1, tabs: {}, pending: [] };
    for (const v of [null, undefined, [], "x", 3, {}, { version: 2, tabs: {}, pending: [] }, { version: 1, tabs: [], pending: {} }]) {
      expect(readChatTabs(v)).toEqual(empty);
    }
    const mixed = {
      version: 1,
      tabs: { tb8: chatTab().shared["bw.chat-tabs"].tabs.tb8, tb9: { tab: "tb9", kind: "bash" }, tb10: null, tb11: { tab: "other" } },
      pending: [null, { id: "p-1-0", kind: "codex" }, { id: "p-2-0", kind: "codex", machine: null, space: "s1", folder: null, beforeTabs: [], beforeSpaces: [], name: "Codex", at: 2 }],
    };
    const r = readChatTabs(mixed);
    expect(Object.keys(r.tabs)).toEqual(["tb8"]);
    expect(r.pending.map((p) => p.id)).toEqual(["p-2-0"]);
    expect(r.tabs.tb8).not.toBe(mixed.tabs.tb8);
  });

  test("readChatTabs reads the live fixture's entries whole", () => {
    const value = chatTab().shared["bw.chat-tabs"];
    expect(readChatTabs(value)).toEqual(value);
  });

  test("addPending gives distinct ids and keeps the stored value untouched", () => {
    const first = addPending(null, claudePending, 5);
    const second = addPending(first, claudePending, 5);
    expect(second.pending.map((p) => p.id)).toEqual(["p-5-0", "p-5-1"]);
    expect(second.pending[0]).toEqual({ id: "p-5-0", ...claudePending, at: 5 });
    expect(first.pending.length).toBe(1);
  });

  test("entryForTerminal finds by full address", () => {
    const value = chatTab().shared["bw.chat-tabs"];
    expect(entryForTerminal(value, "macmini/t5")?.tab).toBe("macmini/tb5");
    expect(entryForTerminal(value, "t5")).toBe(null);
    expect(entryForTerminal(null, "t8")).toBe(null);
  });

  test("wakeAt names the next clock deadline", () => {
    expect(wakeAt(null)).toBe(null);
    const s = addPending(null, claudePending, 1000);
    expect(wakeAt(s)).toBe(1000 + CHAT_PENDING_MS + 1);
    const adopted = adopt(s, spacesWithNewTab, panesTerminalOnly, 2000).next;
    expect(wakeAt(adopted)).toBe(2000 + SPLIT_RETRY_MS);
    expect(wakeAt(chatTab().shared["bw.chat-tabs"])).toBe(null);
  });

  test("chatArgv appends extras to the agent's run", () => {
    expect(chatArgv("codex", ["codex"])).toEqual(["codex"]);
    expect(chatArgv("claude", ["claude", "--x"], ["--mcp-config", "a.json"])).toEqual(["claude", "--x", "--mcp-config", "a.json"]);
  });
});
