import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_PENDING_MS,
  addPending,
  addPendingTabView,
  adopt,
  adoptTabViews,
  chatArgv,
  desiredScreen,
  entryForTerminal,
  focusRecord,
  hasMod,
  isChatTab,
  isShown,
  leftAt,
  readChatTabs,
  readPendingTabViews,
  readTabViews,
  resolveTabAgent,
  resolveTabTerminal,
  shownChatPanes,
  shownFrom,
  wakeAt,
  writeTabView,
} from "./chat-tabs.js";

const chatTab = () => JSON.parse(readFileSync(join(import.meta.dir, "../tests/fixtures/live/chat-tab.json"), "utf8"));

const tab = (id, over = {}) => ({
  id,
  index: 1,
  name: id,
  named: false,
  active: false,
  status: null,
  panes: 1,
  zoomed: false,
  ...over,
});
const space = (id, tabs, over = {}) => ({
  id,
  index: 1,
  name: id,
  named: false,
  folder: "/r/alpha",
  machine: null,
  branch: null,
  active: false,
  status: null,
  tabs,
  ...over,
});
const term = (pane, terminal, tabId, over = {}) => ({
  pane,
  terminal,
  tab: tabId,
  title: "zsh",
  cwd: "/r/alpha",
  branch: null,
  status: null,
  app: null,
  program: null,
  focused: false,
  zoomed: false,
  movable: false,
  ...over,
});
const chat = (pane, tabId, over = {}) => ({
  pane,
  terminal: null,
  mod: "bw-chat",
  tab: tabId,
  title: "Chat",
  focused: false,
  zoomed: false,
  ...over,
});

const claudePending = {
  kind: "claude",
  machine: null,
  space: "s1",
  folder: null,
  beforeTabs: ["tb7"],
  beforeSpaces: [],
  name: "Claude",
};
const spacesWithNewTab = [
  space("s1", [tab("tb7"), tab("tb8", { active: true, name: "Claude", named: true })], { active: true }),
];
const panesTerminalOnly = [term("p7", "t7", "tb7"), term("p8", "t8", "tb8", { focused: true })];

describe("adopt", () => {
  test("adopts the new single-pane chat tab once with no pane.split or pane.zoom", () => {
    const s = addPending(null, claudePending, 0);
    const r1 = adopt(s, spacesWithNewTab, panesTerminalOnly, 100);
    expect(r1.actions).toEqual([]);
    expect(r1.notices).toEqual([]);
    expect(r1.next?.pending).toEqual([]);
    expect(r1.next?.tabs.tb8).toEqual({
      tab: "tb8",
      space: "s1",
      machine: null,
      kind: "claude",
      terminal: "t8",
      terminalPane: "p8",
      chatPane: null,
      split: null,
      zoomed: false,
      failed: false,
      created: 100,
    });
    const r2 = adopt(r1.next, spacesWithNewTab, panesTerminalOnly, 200);
    expect(r2).toEqual({ next: null, actions: [], notices: [] });
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

  test("pending expires after 30 s with a notice", () => {
    const s = addPending(null, { ...claudePending, name: "Codex", kind: "codex" }, 1000);
    const none = [space("s1", [tab("tb7", { active: true })], { active: true })];
    expect(adopt(s, none, [term("p7", "t7", "tb7")], 1000 + CHAT_PENDING_MS).next).toBe(null);
    const r = adopt(s, none, [term("p7", "t7", "tb7")], 1000 + CHAT_PENDING_MS + 1);
    expect(r.next?.pending).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(r.notices).toEqual([{ title: "Codex chat did not start", body: "No new tab appeared within 30 s." }]);
  });

  test("no space: adopts the new space's first tab on that machine without splitting", () => {
    const s = addPending(
      null,
      {
        kind: "codex",
        machine: "macmini",
        space: null,
        folder: "/home/u/gamma",
        beforeTabs: [],
        beforeSpaces: ["s1"],
        name: "Codex",
      },
      0,
    );
    const spaces = [
      space("s1", [tab("tb7", { active: true })]),
      space("s4", [tab("tb9", { active: true })], { active: true }),
      space("macmini/s6", [tab("macmini/tb11", { active: true, name: "Codex" }), tab("macmini/tb12")], {
        machine: "macmini",
        folder: "/home/u/gamma",
      }),
    ];
    const panes = [
      term("p7", "t7", "tb7"),
      term("p10", "t10", "tb9"),
      term("macmini/p11", "macmini/t11", "macmini/tb11"),
      term("macmini/p12", "macmini/t12", "macmini/tb12"),
    ];
    const r = adopt(s, spaces, panes, 50);
    expect(r.actions).toEqual([]);
    expect(Object.keys(r.next?.tabs ?? {})).toEqual(["macmini/tb11"]);
    expect(r.next?.tabs["macmini/tb11"]).toMatchObject({
      space: "macmini/s6",
      machine: "macmini",
      kind: "codex",
      terminal: "macmini/t11",
      terminalPane: "macmini/p11",
      chatPane: null,
    });
  });

  test("a pending chat takes only a new tab with its name, not another tab that appeared first", () => {
    const s = addPending(null, { ...claudePending, beforeTabs: ["tb1"], beforeSpaces: ["s1"] }, 0);
    const spaces = [
      space("s1", [tab("tb1"), tab("unrelated", { name: "2" }), tab("claude", { name: "Claude", named: true })]),
    ];
    const panes = [term("p1", "t1", "tb1"), term("p2", "t2", "unrelated"), term("p3", "t3", "claude")];
    const r = adopt(s, spaces, panes, 100);
    expect(r.actions).toEqual([]);
    expect(Object.keys(r.next?.tabs ?? {})).toEqual(["claude"]);
    expect(r.next?.tabs.claude.terminalPane).toBe("p3");
    const early = adopt(s, [space("s1", [tab("tb1"), tab("unrelated", { name: "2" })])], panes.slice(0, 2), 100);
    expect(early).toEqual({ next: null, actions: [], notices: [] });
  });

  test("no space: a new space in another folder, or a first tab with another name, is not taken", () => {
    const s = addPending(
      null,
      {
        kind: "claude",
        machine: "mini",
        space: null,
        folder: "/a",
        beforeTabs: [],
        beforeSpaces: ["s1"],
        name: "Claude",
      },
      0,
    );
    const spaces = [
      space("s1", [], { machine: "mini" }),
      space("mini/sB", [tab("mini/tbB", { name: "Claude" })], { machine: "mini", folder: "/b" }),
      space("mini/sC", [tab("mini/tbC", { name: "zsh" })], { machine: "mini", folder: "/a/" }),
      space("mini/sA", [tab("mini/tbA", { name: "Claude" })], { machine: "mini", folder: "/a/" }),
    ];
    const panes = [
      term("mini/pB", "mini/tB", "mini/tbB"),
      term("mini/pC", "mini/tC", "mini/tbC"),
      term("mini/pA", "mini/tA", "mini/tbA"),
    ];
    const r = adopt(s, spaces, panes, 100);
    expect(Object.keys(r.next?.tabs ?? {})).toEqual(["mini/tbA"]);
    expect(r.next?.tabs["mini/tbA"].terminalPane).toBe("mini/pA");
  });

  test("remote ids keep their machine prefix in entries", () => {
    const s = addPending(
      null,
      {
        kind: "codex",
        machine: "macmini",
        space: "macmini/s3",
        folder: null,
        beforeTabs: ["macmini/tb5"],
        beforeSpaces: [],
        name: "Codex",
      },
      0,
    );
    const spaces = [
      space("macmini/s3", [tab("macmini/tb5"), tab("macmini/tb6", { active: true, name: "Codex" })], {
        machine: "macmini",
        active: true,
      }),
    ];
    const panes = [term("macmini/p5", "macmini/t5", "macmini/tb5"), term("macmini/p7", "macmini/t7", "macmini/tb6")];
    const r1 = adopt(s, spaces, panes, 10);
    expect(r1.actions).toEqual([]);
    expect(r1.next?.tabs["macmini/tb6"]).toMatchObject({
      tab: "macmini/tb6",
      space: "macmini/s3",
      machine: "macmini",
      terminal: "macmini/t7",
      terminalPane: "macmini/p7",
      chatPane: null,
    });
    expect(entryForTerminal(r1.next, "macmini/t7")?.tab).toBe("macmini/tb6");
  });

  test("legacy bw-chat split panes unzoom and close idempotently while leaving terminal panes intact", () => {
    const f = chatTab();
    const r1 = adopt(f.shared["bw.chat-tabs"], f.spaces, f.panes, 0);
    expect(r1.actions).toEqual([
      ["pane.zoom", { pane: "p9" }],
      ["pane.close", { pane: "p9" }],
      ["pane.zoom", { pane: "macmini/p6" }],
      ["pane.close", { pane: "macmini/p6" }],
    ]);
    expect(r1.next?.closing).toEqual(["p9", "macmini/p6"]);
    expect(r1.next?.tabs.tb8).toMatchObject({ chatPane: null, zoomed: false, split: null });
    expect(r1.next?.tabs["macmini/tb5"]).toMatchObject({ chatPane: null, zoomed: false, split: null });

    // While pane.close is in flight, a repeat render emits no duplicate commands.
    expect(adopt(r1.next, f.spaces, f.panes, 10)).toEqual({ next: null, actions: [], notices: [] });

    // Once the legacy split panes disappear, closing is pruned cleanly.
    const cleanPanes = f.panes.filter((/** @type {any} */ p) => p.mod !== "bw-chat");
    const r2 = adopt(r1.next, f.spaces, cleanPanes, 20);
    expect(r2.actions).toEqual([]);
    expect(r2.next?.closing).toBe(undefined);
    expect(adopt(r2.next, f.spaces, cleanPanes, 30)).toEqual({ next: null, actions: [], notices: [] });
  });

  test("pre-upgrade chat tabs never recorded in shared state are registered and their split panes closed", () => {
    const f = chatTab();
    const r = adopt(null, f.spaces, f.panes, 7);
    expect(Object.keys(r.next?.tabs ?? {}).sort()).toEqual(["macmini/tb5", "tb8"]);
    expect(r.next?.tabs.tb8).toMatchObject({
      tab: "tb8",
      space: "s1",
      machine: null,
      kind: "claude",
      terminal: "t8",
      terminalPane: "p8",
      chatPane: null,
      zoomed: false,
      created: 7,
    });
    expect(r.actions).toEqual([
      ["pane.zoom", { pane: "p9" }],
      ["pane.close", { pane: "p9" }],
      ["pane.zoom", { pane: "macmini/p6" }],
      ["pane.close", { pane: "macmini/p6" }],
    ]);
  });

  test("a legacy bw-chat pane whose terminal pane already exited is left alone", () => {
    const spaces = [space("s1", [tab("tb8", { active: true })], { active: true })];
    const orphanPanes = [chat("p9", "tb8", { zoomed: true })];
    expect(adopt(null, spaces, orphanPanes, 0)).toEqual({ next: null, actions: [], notices: [] });
  });

  test("closed tabs are dropped", () => {
    const f = chatTab();
    const cleanPanes = f.panes.filter((/** @type {any} */ p) => p.mod !== "bw-chat");
    const migrated = adopt(f.shared["bw.chat-tabs"], f.spaces, cleanPanes, 0).next;
    const spaces = f.spaces.filter((/** @type {any} */ s) => s.id !== "macmini/s3");
    const r = adopt(migrated, spaces, cleanPanes, 10);
    expect(Object.keys(r.next?.tabs ?? {})).toEqual(["tb8"]);
    expect(r.actions).toEqual([]);
    expect(r.notices).toEqual([]);
  });
});

describe("tab views and agent resolution", () => {
  test("desiredScreen defaults agent tabs to chat, shell tabs to panes, and honors writeTabView overrides", () => {
    const panes = [
      term("p7", "t7", "tb7", { program: { key: "shell" } }),
      term("p8", "t8", "tb8", { program: { key: "claude" } }),
    ];
    expect(isChatTab("tb8", panes, null)).toBe(true);
    expect(isChatTab("tb7", panes, null)).toBe(false);
    expect(desiredScreen("tb8", panes, null, null)).toBe("chat");
    expect(desiredScreen("tb7", panes, null, null)).toBe("panes");
    expect(desiredScreen(null, panes, null, null)).toBe("chat");

    const v1 = writeTabView(null, "tb8", "panes", ["tb7", "tb8"]);
    expect(readTabViews(v1)).toEqual({ tb8: "panes" });
    expect(desiredScreen("tb8", panes, null, v1)).toBe("panes");

    const v2 = writeTabView(v1, "tb8", "chat", ["tb8"]);
    expect(desiredScreen("tb8", panes, null, v2)).toBe("chat");

    // A shell tab never resolves to chat even if a stale override wrote "chat".
    expect(desiredScreen("tb7", panes, null, { tb7: "chat" })).toBe("panes");
  });

  test("adoptTabViews marks New terminal launches as panes and prunes closed or expired entries", () => {
    let pending = addPendingTabView(
      null,
      { machine: null, space: "s1", folder: "/r/alpha", beforeTabs: ["tb1"], beforeSpaces: ["s1"], name: "Codex" },
      100,
    );
    pending = addPendingTabView(
      pending,
      { machine: null, space: "s1", folder: "/r/alpha", beforeTabs: ["tb1"], beforeSpaces: ["s1"], name: null },
      100,
    );
    expect(readPendingTabViews(pending).map((p) => p.id)).toEqual(["tv-100-0", "tv-100-1"]);

    const spaces = [
      space("s1", [tab("tb1"), tab("tb2", { name: "Codex", named: true }), tab("tb3", { name: "3", named: false })]),
    ];
    const panes = [
      term("p1", "t1", "tb1", { program: { key: "claude" } }),
      term("p2", "t2", "tb2", { program: { key: "codex" } }),
      term("p3", "t3", "tb3", { program: { key: "shell" } }),
    ];
    const r1 = adoptTabViews({ gone: "panes" }, pending, spaces, panes, null, 200);
    expect(r1.nextViews).toEqual({ tb2: "panes", tb3: "panes" });
    expect(r1.nextPending).toEqual([]);
    expect(desiredScreen("tb2", panes, null, r1.nextViews)).toBe("panes");

    // Expired pending tab view drops cleanly after 30 s.
    const stale = addPendingTabView(
      null,
      {
        machine: null,
        space: "s1",
        folder: "/r/alpha",
        beforeTabs: ["tb1", "tb2", "tb3"],
        beforeSpaces: ["s1"],
        name: "Claude",
      },
      1000,
    );
    expect(adoptTabViews(r1.nextViews, stale, spaces, panes, null, 1000 + CHAT_PENDING_MS).nextPending).toBe(null);
    expect(adoptTabViews(r1.nextViews, stale, spaces, panes, null, 1000 + CHAT_PENDING_MS + 1).nextPending).toEqual([]);
  });

  test("resolveTabAgent and resolveTabTerminal follow pinned -> focused -> recorded -> first agent priority", () => {
    const panes = [
      term("pShell", "tShell", "tb1", { program: { key: "shell" }, focused: true }),
      term("pClaude", "tClaude", "tb1", { program: { key: "claude" }, focused: false }),
      term("pCodex", "tCodex", "tb1", { program: { key: "codex" }, focused: true }),
    ];
    const recorded = {
      version: 1,
      tabs: {
        tb1: {
          tab: "tb1",
          space: "s1",
          machine: null,
          kind: "claude",
          terminal: "tClaude",
          terminalPane: "pClaude",
          chatPane: null,
          split: null,
          zoomed: false,
          failed: false,
          created: 0,
        },
      },
      pending: [],
    };
    // 1. Pinned bw.chat-agent wins over focused agent.
    expect(resolveTabAgent("tb1", panes, recorded, { tb1: "tClaude" })).toEqual({
      pane: "pClaude",
      terminal: "tClaude",
      kind: "claude",
    });
    // 2. When pinned agent exited, focused agent wins over recorded.
    expect(resolveTabAgent("tb1", panes, recorded, { tb1: "tGone" })).toEqual({
      pane: "pCodex",
      terminal: "tCodex",
      kind: "codex",
    });
    // 3. With no focused agent, recorded bw.chat-tabs entry wins over first pane.
    const unfocused = panes.map((p) => ({ ...p, focused: false }));
    const swapped = [unfocused[2], unfocused[1], unfocused[0]];
    expect(resolveTabAgent("tb1", swapped, recorded, null)?.terminal).toBe("tClaude");
    // 4. With no recorded entry, first agent pane wins.
    expect(resolveTabAgent("tb1", swapped, null, null)?.terminal).toBe("tCodex");
    // 5. Shell-only tab resolves null agent and falls back to focused shell terminal.
    const shellOnly = [term("pA", "tA", "tbS"), term("pB", "tB", "tbS", { focused: true })];
    expect(resolveTabAgent("tbS", shellOnly, null, null)).toBe(null);
    expect(resolveTabTerminal("tbS", shellOnly, null, null)).toBe("tB");
    expect(resolveTabTerminal(null, shellOnly, null, null)).toBe(null);
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
    const behind = f.panes.map((/** @type {any} */ p) =>
      p.pane === "p9" ? { ...p, zoomed: false } : p.pane === "p8" ? { ...p, zoomed: true } : p,
    );
    expect(isShown(local, f.spaces, behind)).toBe(false);
    const unzoomed = f.spaces.map((/** @type {any} */ s) => ({
      ...s,
      tabs: s.tabs.map((/** @type {any} */ t) => ({ ...t, zoomed: false })),
    }));
    const flat = f.panes.map((/** @type {any} */ p) => ({ ...p, zoomed: false }));
    expect(isShown(local, unzoomed, flat)).toBe(true);
    const otherTab = f.spaces.map((/** @type {any} */ s) =>
      s.id !== "s1" ? s : { ...s, tabs: s.tabs.map((/** @type {any} */ t) => ({ ...t, active: t.id === "tb7" })) },
    );
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
    for (const v of [
      null,
      undefined,
      [],
      "x",
      3,
      {},
      { version: 2, tabs: {}, pending: [] },
      { version: 1, tabs: [], pending: {} },
    ]) {
      expect(readChatTabs(v)).toEqual(empty);
    }
    const mixed = {
      version: 1,
      tabs: {
        tb8: chatTab().shared["bw.chat-tabs"].tabs.tb8,
        tb9: { tab: "tb9", kind: "bash" },
        tb10: null,
        tb11: { tab: "other" },
      },
      pending: [
        null,
        { id: "p-1-0", kind: "codex" },
        {
          id: "p-2-0",
          kind: "codex",
          machine: null,
          space: "s1",
          folder: null,
          beforeTabs: [],
          beforeSpaces: [],
          name: "Codex",
          at: 2,
        },
      ],
      closing: ["p9", "", 7, "p9"],
    };
    const r = readChatTabs(mixed);
    expect(Object.keys(r.tabs)).toEqual(["tb8"]);
    expect(r.pending.map((p) => p.id)).toEqual(["p-2-0"]);
    expect(r.closing).toEqual(["p9"]);
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

  test("wakeAt names the next clock deadline across chat and terminal pending launches", () => {
    expect(wakeAt(null)).toBe(null);
    const s = addPending(null, claudePending, 1000);
    expect(wakeAt(s)).toBe(1000 + CHAT_PENDING_MS + 1);
    const pv = addPendingTabView(
      null,
      { machine: null, space: "s1", folder: null, beforeTabs: [], beforeSpaces: [], name: null },
      500,
    );
    expect(wakeAt(s, pv)).toBe(500 + CHAT_PENDING_MS + 1);
    const adopted = adopt(s, spacesWithNewTab, panesTerminalOnly, 2000).next;
    expect(wakeAt(adopted)).toBe(null);
  });

  test("chatArgv appends extras to the agent's run", () => {
    expect(chatArgv("codex", ["codex"])).toEqual(["codex"]);
    expect(chatArgv("claude", ["claude", "--x"], ["--mcp-config", "a.json"])).toEqual([
      "claude",
      "--x",
      "--mcp-config",
      "a.json",
    ]);
  });
});

describe("shownChatPanes", () => {
  test("lists the bw-chat panes on screen: the active space's active tab, unless another pane is zoomed", () => {
    const f = chatTab();
    expect(shownChatPanes(f.spaces, f.panes)).toEqual(["p9"]);
    const behind = f.panes.map((/** @type {any} */ p) =>
      p.pane === "p9" ? { ...p, zoomed: false } : p.pane === "p8" ? { ...p, zoomed: true } : p,
    );
    expect(shownChatPanes(f.spaces, behind)).toEqual([]);
    const unzoomed = f.spaces.map((/** @type {any} */ s) => ({
      ...s,
      tabs: s.tabs.map((/** @type {any} */ t) => ({ ...t, zoomed: false })),
    }));
    const flat = f.panes.map((/** @type {any} */ p) => ({ ...p, zoomed: false }));
    expect(shownChatPanes(unzoomed, flat)).toEqual(["p9"]);
    const otherSpace = f.spaces.map((/** @type {any} */ s) => ({ ...s, active: !s.active }));
    expect(shownChatPanes(otherSpace, f.panes)).not.toContain("p9");
  });

  test("shownFrom reads the stored list, and keeps the fallback without one or without a pane", () => {
    expect(shownFrom(["p9"], "p9", false)).toBe(true);
    expect(shownFrom([], "p9", true)).toBe(false);
    expect(shownFrom(undefined, "p9", true)).toBe(true);
    expect(shownFrom("p9", "p9", false)).toBe(false);
    expect(shownFrom(["p9"], null, false)).toBe(false);
  });
});

describe("focusRecord", () => {
  test("records when focus leaves a terminal or when screen leaves panes, keeping a minute of leaves", () => {
    const a = focusRecord(undefined, "t8", 1000, "panes");
    expect(a).toEqual({ focused: "t8", left: {} });
    expect(focusRecord(a, "t8", 2000, "panes")).toBe(null);

    // Switching from panes to chat records leftAt immediately even before focused() updates.
    const toChat = focusRecord(a, "t8", 2500, "chat");
    expect(toChat).toEqual({ focused: null, left: { t8: 2500 } });
    expect(leftAt(toChat, "t8")).toBe(2500);
    expect(focusRecord(toChat, "t8", 2800, "chat")).toBe(null);

    const b = focusRecord(a, null, 3000);
    expect(b).toEqual({ focused: null, left: { t8: 3000 } });
    expect(leftAt(b, "t8")).toBe(3000);
    expect(leftAt(b, "t9")).toBe(null);
    const c = focusRecord(b, "macmini/t5", 70_000, "panes");
    expect(c).toEqual({ focused: "macmini/t5", left: {} });
    expect(leftAt("junk", "t8")).toBe(null);
  });
});

describe("hasMod", () => {
  test("finds a mod block anywhere in a layout tree, floating blocks included", () => {
    const tree = {
      id: "root",
      type: "row",
      children: [{ id: "w", type: "column", children: [{ id: "t", type: "block", content: { mod: "bw-tabs" } }] }],
      floating: [{ id: "f", content: { mod: "board" } }],
    };
    expect(hasMod(tree, "bw-tabs")).toBe(true);
    expect(hasMod(tree, "board")).toBe(true);
    expect(hasMod(tree, "tabs")).toBe(false);
    expect(hasMod(null, "bw-tabs")).toBe(false);
  });
});
