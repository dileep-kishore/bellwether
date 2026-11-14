import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake, inPhase, violations } from "../harness/herdr-stub.js";
import { byId, findAll } from "../harness/kit-stub.js";
import { tabItems } from "../../mods/bw-tabs/model.js";

const KEY = "bw.chat-tabs";

afterEach(() => setSystemTime());

/** A nextCommand the test answers one command at a time. */
function commands() {
  /** @type {((c: string) => void)[]} */
  const waiting = [];
  return {
    next: () => new Promise((r) => waiting.push(r)),
    /** @param {string} c */
    send(c) {
      const w = waiting.shift();
      if (!w) throw new Error("nextCommand is not being awaited");
      w(c);
    },
  };
}

/** Stack-mode chat-tab fixture with legacy bw-chat split panes already removed. */
function stackChatTab() {
  const data = live("chat-tab");
  data.panes = data.panes.filter((p) => p.mod !== "bw-chat");
  for (const sp of data.spaces) {
    for (const t of sp.tabs) {
      t.panes = 1;
      t.zoomed = false;
    }
  }
  for (const e of Object.values(data.shared[KEY].tabs)) {
    e.chatPane = null;
    e.split = null;
    e.zoomed = false;
    e.failed = false;
  }
  return data;
}

/** Stack-mode fixture with tb8 not yet recorded: a pending Claude chat. @param {number} at */
function pendingClaude(at) {
  const data = stackChatTab();
  const s = data.shared[KEY];
  delete s.tabs.tb8;
  s.pending = [
    {
      id: "p-1",
      kind: "claude",
      machine: null,
      space: "s1",
      folder: "/r/alpha",
      beforeTabs: ["tb7"],
      beforeSpaces: ["s1", "macmini/s3"],
      name: "Claude Code",
      at,
    },
  ];
  data.spaces[0].tabs[1].name = "Claude Code";
  return data;
}

/** Runs the i-th timer.after callback as Herdr would, with phase "timer". @param {any} m @param {number} i */
async function fireAfter(m, i) {
  const t = m.cx.afters[i];
  if (!t) throw new Error(`no timer.after #${i}`);
  await inPhase("timer", async () => t.fn(m.cx));
  if (violations.length) throw violations[0];
  await m.cx.flush();
}

const chatWrites = (/** @type {any} */ m) => m.log.shared.filter(([k]) => k === KEY);

describe("bw-tabs stack chat adoption and migration", () => {
  test("adopts a new chat tab without pane.split or pane.zoom", async () => {
    const m = await mount("bw-tabs", { live: pendingClaude(Date.now()) });
    expect(m.log.run).toEqual([]);
    const adopted = chatWrites(m).at(-1)[1];
    expect(adopted.pending).toEqual([]);
    expect(adopted.tabs.tb8).toMatchObject({
      terminal: "t8",
      terminalPane: "p8",
      chatPane: null,
      split: null,
      zoomed: false,
      kind: "claude",
    });
    expect(fake.shared["bw.screen"]).toBe("chat");

    const count = chatWrites(m).length;
    m.render();
    expect(m.log.run).toEqual([]);
    expect(chatWrites(m).length).toBe(count);
    expect(m.log.notify).toEqual([]);
  });

  test("unzooms and closes legacy bw-chat split panes once without repeating while close is in flight", async () => {
    const m = await mount("bw-tabs", { live: live("chat-tab") });
    expect(m.log.run).toEqual([
      ["pane.zoom", { pane: "p9" }],
      ["pane.close", { pane: "p9" }],
      ["pane.zoom", { pane: "macmini/p6" }],
      ["pane.close", { pane: "macmini/p6" }],
    ]);
    expect(chatWrites(m).at(-1)[1].closing).toEqual(["p9", "macmini/p6"]);

    m.render();
    expect(m.log.run).toHaveLength(4);

    fake.panes = fake.panes.filter((p) => p.mod !== "bw-chat");
    m.render();
    expect(m.log.run).toHaveLength(4);
    expect(chatWrites(m).at(-1)[1].closing).toBe(undefined);
  });

  test("settled stack state writes nothing and schedules no timers", async () => {
    const data = stackChatTab();
    data.shared["bw.screen"] = "chat";
    data.shared["bw.chat-shown"] = [];
    const m = await mount("bw-tabs", { live: data });
    m.render();
    expect(m.log.run).toEqual([]);
    expect(chatWrites(m)).toEqual([]);
    expect(m.cx.afters).toEqual([]);
  });

  test("adopts pending New terminal launches into bw.tab-view = panes and switches screen to panes", async () => {
    const data = stackChatTab();
    data.shared["bw.tab-view.pending"] = [
      {
        id: "tv-1",
        machine: null,
        space: "s1",
        folder: "/r/alpha",
        beforeTabs: ["tb7"],
        beforeSpaces: ["s1", "macmini/s3"],
        name: "Claude",
        at: Date.now(),
      },
    ];
    delete data.shared[KEY].tabs.tb8;
    const m = await mount("bw-tabs", { live: data });
    expect(fake.shared["bw.tab-view"]).toEqual({ tb8: "panes" });
    expect(fake.shared["bw.screen"]).toBe("panes");
    expect(m.log.run).toEqual([
      ["layout.select", { stack: "screen", child: "panes" }],
      ["pane.focus", { terminal: "t8" }],
    ]);
  });

  test("expired pending chat drops with a warning notification via clock timer without live reads in timer", async () => {
    const start = Date.now();
    setSystemTime(start);
    const data = pendingClaude(start);
    data.spaces[0].tabs = data.spaces[0].tabs.filter((t) => t.id !== "tb8");
    data.panes = data.panes.filter((p) => p.tab !== "tb8");
    data.spaces[0].tabs[0].active = true;
    const m = await mount("bw-tabs", { live: data });
    await m.cx.flush();
    expect(m.cx.afters.map((a) => a.ms)).toEqual([30001]);

    setSystemTime(start + 30001);
    const notified = m.cx.notified;
    const reads = m.log.live.length;
    await fireAfter(m, 0);
    expect(m.cx.notified).toBe(notified + 1);
    expect(m.log.live.length).toBe(reads);
    expect(m.log.notify).toEqual([]);
    m.render();
    expect(m.log.notify).toEqual([
      { title: "Claude Code chat did not start", body: "No new tab appeared within 30 s.", level: "warning" },
    ]);
  });

  test("a wake under a second waits a second", async () => {
    const start = Date.now();
    setSystemTime(start);
    const data = pendingClaude(start - 29500);
    data.spaces[0].tabs = data.spaces[0].tabs.filter((t) => t.id !== "tb8");
    data.panes = data.panes.filter((p) => p.tab !== "tb8");
    data.spaces[0].tabs[0].active = true;
    const m = await mount("bw-tabs", { live: data });
    await m.cx.flush();
    expect(m.cx.afters.map((a) => a.ms)).toEqual([1000]);
  });
});

describe("bw-tabs screen routing and shortcuts", () => {
  test("⌘J flips chat <-> panes with explicit focus handoff", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...stackChatTab(), nextCommand: c.next } });
    expect(fake.shared["bw.screen"]).toBe("chat");

    c.send("chat-flip");
    await m.cx.flush();
    expect(m.log.run).toEqual([]);
    m.render();
    expect(fake.shared["bw.tab-view"]).toEqual({ tb8: "panes" });
    expect(fake.shared["bw.screen"]).toBe("panes");
    expect(m.log.run).toEqual([
      ["layout.select", { stack: "screen", child: "panes" }],
      ["pane.focus", { terminal: "t8" }],
    ]);

    // Simulate Herdr updating layout.screen.active to "panes".
    const setScreen = (/** @type {any} */ n, /** @type {string} */ active) => {
      if (n.id === "screen") n.active = active;
      for (const ch of n.children ?? []) setScreen(ch, active);
    };
    setScreen(fake.layout, "panes");
    m.render();
    expect(m.log.run).toHaveLength(2);

    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(fake.shared["bw.tab-view"]).toEqual({ tb8: "chat" });
    expect(fake.shared["bw.screen"]).toBe("chat");
    expect(m.log.run.slice(2)).toEqual([["layout.select", { stack: "screen", child: "chat" }], ["bw-chat.focus"]]);
  });

  test("the command task only queues the command and redraws without reading live data", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...stackChatTab(), nextCommand: c.next } });
    const notified = m.cx.notified;
    const reads = m.log.live.length;
    c.send("chat-flip");
    await m.cx.flush();
    expect(m.cx.notified).toBe(notified + 1);
    expect(m.log.live.length).toBe(reads);
    expect(m.view.pendingCmds).toEqual(["chat-flip"]);
    m.render();
    expect(m.view.pendingCmds).toEqual([]);
  });

  test("switching from a chat tab to a shell tab routes screen to panes and ignores ⌘J on shell tabs", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...stackChatTab(), nextCommand: c.next } });
    expect(m.log.run).toEqual([]);

    fake.spaces[0].tabs = fake.spaces[0].tabs.map((t) => ({ ...t, active: t.id === "tb7" }));
    m.render();
    expect(fake.shared["bw.screen"]).toBe("panes");
    expect(m.log.run).toEqual([
      ["layout.select", { stack: "screen", child: "panes" }],
      ["pane.focus", { terminal: "t7" }],
    ]);

    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(m.log.run).toHaveLength(2);
  });

  test("⌘⇧', ⌘⇧N, and ⌘⇧O peek terminal and toggle needs and overview screens", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...stackChatTab(), nextCommand: c.next } });

    c.send("terminal-peek");
    await m.cx.flush();
    m.render();
    expect(m.log.run).toEqual([["terminal.peek", { terminal: "t8" }]]);

    c.send("needs-toggle");
    await m.cx.flush();
    m.render();
    expect(fake.shared["bw.screen"]).toBe("needs");
    expect(m.log.run.slice(1)).toEqual([["layout.select", { stack: "screen", child: "needs" }], ["bw-needs.focus"]]);

    c.send("overview-toggle");
    await m.cx.flush();
    m.render();
    expect(fake.shared["bw.screen"]).toBe("overview");
    expect(m.log.run.slice(3)).toEqual([
      ["layout.select", { stack: "screen", child: "overview" }],
      ["bw-overview.focus"],
    ]);

    // Clicking a tab while overview is active selects the tab and exits overview back to its screen.
    const setScreen = (/** @type {any} */ n, /** @type {string} */ active) => {
      if (n.id === "screen") n.active = active;
      for (const ch of n.children ?? []) setScreen(ch, active);
    };
    setScreen(fake.layout, "overview");
    m.render();
    const beforeClick = m.log.run.length;
    await m.click("tab-tb8");
    m.render();
    expect(m.log.run.slice(beforeClick)).toEqual([
      ["tab.select", { id: "tb8" }],
      ["layout.select", { stack: "screen", child: "chat" }],
      ["bw-chat.focus"],
    ]);
  });

  test("hands off focus to bw-chat on hidden-terminal startup mount and chat-to-chat tab switches", async () => {
    const c = commands();
    const data = stackChatTab();
    data.focused = { ...data.focused, pane: "p8", terminal: "t8" };
    data.spaces[0].tabs.push({
      id: "tb10",
      title: "Codex",
      active: false,
      status: "done",
      panes: 1,
      zoomed: false,
      pinned: false,
    });
    data.panes.push({
      pane: "p10",
      terminal: "t10",
      mod: null,
      tab: "tb10",
      title: "Codex",
      focused: false,
      zoomed: false,
      status: "done",
      agent: "codex",
      program: { key: "codex", name: "Codex", agent: true, shell: false },
    });
    data.shared[KEY].tabs.tb10 = {
      agentPane: "p10",
      agent: "codex",
      chatPane: null,
      split: null,
      zoomed: false,
      failed: false,
    };

    const m = await mount("bw-tabs", { live: { ...data, nextCommand: c.next } });
    expect(m.log.run).toEqual([]);

    // Switching from chat tab tb8 to chat tab tb10 (same screen === "chat") focuses bw-chat.
    fake.spaces[0].tabs = fake.spaces[0].tabs.map((t) => ({ ...t, active: t.id === "tb10" }));
    m.render();
    expect(fake.shared["bw.screen"]).toBe("chat");
    expect(m.log.run).toEqual([["bw-chat.focus"]]);
  });
});

describe("bw-tabs terminal focus", () => {
  test("records leftAt immediately when switching from panes to chat even before focused() changes", async () => {
    setSystemTime(new Date(1794032000000));
    const c = commands();
    const data = stackChatTab();
    data.shared["bw.tab-view"] = { tb8: "panes" };
    const walk = (/** @type {any} */ n) => {
      if (n.id === "screen") n.active = "panes";
      for (const ch of n.children ?? []) walk(ch);
    };
    data.layout = structuredClone(fake.layout);
    walk(data.layout);
    data.focused = { pane: "p8", terminal: "t8" };

    const m = await mount("bw-tabs", { live: { ...data, nextCommand: c.next } });
    expect(fake.shared["bw.terminal-focus"]).toEqual({ focused: "t8", left: {} });

    setSystemTime(new Date(1794032005000));
    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(fake.shared["bw.terminal-focus"]).toEqual({ focused: null, left: { t8: 1794032005000 } });
  });
});

describe("bw-tabs chat tab icon", () => {
  test("chat tab shows its agent's icon", async () => {
    const m = await mount("bw-tabs", { live: stackChatTab() });
    const icons = findAll(byId(m.el, "tab-tb8"), (e) => e.tag === "image" || e.tag === "svg").map((e) => e.attrs.path);
    expect(icons[0]).toBe("icons/claude.svg");
  });

  test("a chat tab whose agent exited shows its terminal's program, not nothing", () => {
    const space = {
      tabs: [{ id: "tb8", index: 1, name: "Claude Code", named: true, active: true, status: null, settled: false }],
    };
    const shell = {
      key: "shell",
      name: "zsh",
      icon: "icons/terminal.svg",
      tint: true,
      tile: null,
      color: null,
      shell: true,
      agent: false,
    };
    const panes = [{ pane: "p8", terminal: "t8", tab: "tb8", program: shell }];
    expect(tabItems(space, panes)[0].program).toEqual(shell);
  });
});
