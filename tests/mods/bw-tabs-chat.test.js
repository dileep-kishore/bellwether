import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
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

/** chat-tab.json with tb8 not yet a chat tab: a pending Claude chat, no chat pane. @param {number} at */
function pendingClaude(at) {
  const data = live("chat-tab");
  const s = data.shared[KEY];
  delete s.tabs.tb8;
  s.pending = [{ id: "p-1", kind: "claude", machine: null, space: "s1", folder: "/r/alpha", beforeTabs: ["tb7"], beforeSpaces: ["s1", "macmini/s3"], name: "Claude Code", at }];
  data.panes = data.panes.filter((p) => p.pane !== "p9");
  data.spaces[0].tabs[1].zoomed = false;
  return data;
}

const chatPane = { pane: "p9", terminal: null, mod: "bw-chat", tab: "tb8", title: "Chat", focused: false, zoomed: false };
const split = ["pane.split", { direction: "right", pane: "p8", mod: "bw-chat", props: { terminal: "t8", machine: null, kind: "claude" } }];

/** Runs the i-th timer.after callback as Herdr would, with phase "timer". @param {any} m @param {number} i */
async function fireAfter(m, i) {
  const t = m.cx.afters[i];
  if (!t) throw new Error(`no timer.after #${i}`);
  await inPhase("timer", async () => t.fn(m.cx));
  if (violations.length) throw violations[0];
  await m.cx.flush();
}

describe("bw-tabs chat adoption", () => {
  test("bw-tabs adopts the new tab: split, then zoom once across renders", async () => {
    const m = await mount("bw-tabs", { live: pendingClaude(Date.now()) });
    expect(m.log.run).toEqual([split]);
    const adopted = m.log.shared.at(-1)[1];
    expect(adopted.pending).toEqual([]);
    expect(adopted.tabs.tb8).toMatchObject({ terminal: "t8", terminalPane: "p8", chatPane: null, kind: "claude" });
    expect(adopted.tabs["macmini/tb5"]).toEqual(live("chat-tab").shared[KEY].tabs["macmini/tb5"]);

    const writes = m.log.shared.length;
    m.render();
    expect(m.log.run).toEqual([split]);
    expect(m.log.shared.length).toBe(writes);

    fake.panes = [...fake.panes, chatPane];
    m.render();
    expect(m.log.run).toEqual([split, ["pane.zoom", { pane: "p9" }]]);
    expect(m.log.shared.at(-1)[1].tabs.tb8).toMatchObject({ chatPane: "p9", zoomed: true });
    m.render();
    m.render();
    expect(m.log.run).toEqual([split, ["pane.zoom", { pane: "p9" }]]);
    expect(m.log.shared.length).toBe(writes + 1);
    expect(m.log.notify).toEqual([]);
  });

  test("nothing to adopt writes nothing and runs nothing", async () => {
    const m = await mount("bw-tabs", { live: live("chat-tab") });
    m.render();
    expect(m.log.run).toEqual([]);
    expect(m.log.shared).toEqual([]);
    expect(m.cx.afters).toEqual([]);
  });

  test("expired pending is dropped with a notification", async () => {
    const data = pendingClaude(Date.now() - 30001);
    data.spaces[0].tabs = data.spaces[0].tabs.filter((t) => t.id !== "tb8");
    data.panes = data.panes.filter((p) => p.tab !== "tb8");
    const m = await mount("bw-tabs", { live: data });
    expect(m.log.notify).toEqual([{ title: "Claude Code chat did not start", body: "No new tab appeared within 30 s.", level: "warning" }]);
    expect(m.log.shared.at(-1)[1].pending).toEqual([]);
    m.render();
    expect(m.log.notify).toHaveLength(1);
    expect(m.log.run).toEqual([]);
  });

  test("a pending chat expires by the clock alone: one timer, its callback only notifies", async () => {
    const start = Date.now();
    setSystemTime(start);
    const data = pendingClaude(start);
    data.spaces[0].tabs = data.spaces[0].tabs.filter((t) => t.id !== "tb8");
    data.panes = data.panes.filter((p) => p.tab !== "tb8");
    const m = await mount("bw-tabs", { live: data });
    await m.cx.flush();
    expect(m.cx.afters.map((a) => a.ms)).toEqual([30001]);
    m.render();
    await m.cx.flush();
    expect(m.cx.afters).toHaveLength(1);

    setSystemTime(start + 30001);
    const notified = m.cx.notified;
    const reads = m.log.live.length;
    await fireAfter(m, 0);
    expect(m.cx.notified).toBe(notified + 1);
    expect(m.log.live.length).toBe(reads);
    expect(m.log.notify).toEqual([]);
    m.render();
    expect(m.log.notify).toEqual([{ title: "Claude Code chat did not start", body: "No new tab appeared within 30 s.", level: "warning" }]);
    await m.cx.flush();
    expect(m.cx.afters).toHaveLength(1);
  });

  test("split retried once after 5 s, then a notification, each woken by its timer", async () => {
    const start = Date.now();
    setSystemTime(start);
    const m = await mount("bw-tabs", { live: pendingClaude(start) });
    await m.cx.flush();
    expect(m.log.run).toEqual([split]);
    expect(m.cx.afters.map((a) => a.ms)).toEqual([5000]);

    setSystemTime(start + 5000);
    await fireAfter(m, 0);
    m.render();
    expect(m.log.run).toEqual([split, split]);
    await m.cx.flush();
    expect(m.cx.afters.map((a) => a.ms)).toEqual([5000, 5000]);

    setSystemTime(start + 10000);
    await fireAfter(m, 1);
    m.render();
    expect(m.log.run).toEqual([split, split]);
    expect(m.log.notify).toEqual([{ title: "Chat pane did not open", body: "The agent keeps running in this tab.", level: "warning" }]);
    await m.cx.flush();
    expect(m.cx.afters).toHaveLength(2);
  });

  test("a wake under a second waits a second", async () => {
    const start = Date.now();
    setSystemTime(start);
    const data = pendingClaude(start - 29500);
    data.spaces[0].tabs = data.spaces[0].tabs.filter((t) => t.id !== "tb8");
    data.panes = data.panes.filter((p) => p.tab !== "tb8");
    const m = await mount("bw-tabs", { live: data });
    await m.cx.flush();
    expect(m.cx.afters.map((a) => a.ms)).toEqual([1000]);
  });
});

describe("bw-tabs ⌘J", () => {
  test("⌘J flips chat → terminal and back", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...live("chat-tab"), nextCommand: c.next } });
    c.send("chat-flip");
    await m.cx.flush();
    expect(m.log.run).toEqual([]);
    m.render();
    expect(m.log.run).toEqual([["pane.zoom", { pane: "p9" }], ["pane.zoom", { pane: "p8" }], ["pane.focus", { pane: "p8" }]]);
    m.render();
    expect(m.log.run).toHaveLength(3);

    fake.panes = fake.panes.map((p) => (p.pane === "p9" ? { ...p, zoomed: false, focused: false } : p.pane === "p8" ? { ...p, zoomed: true, focused: true } : p));
    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(m.log.run.slice(3)).toEqual([["pane.zoom", { pane: "p8" }], ["pane.zoom", { pane: "p9" }], ["pane.focus", { pane: "p9" }]]);
  });

  test("the command task only marks the flip and redraws", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...live("chat-tab"), nextCommand: c.next } });
    const notified = m.cx.notified;
    const reads = m.log.live.length;
    c.send("chat-flip");
    await m.cx.flush();
    expect(m.cx.notified).toBe(notified + 1);
    expect(m.log.live.length).toBe(reads);
    expect(m.view.flip).toBe(true);
    m.render();
    expect(m.view.flip).toBe(false);
  });

  test("terminal gone: flip does nothing", async () => {
    const c = commands();
    const data = live("chat-tab");
    data.panes = data.panes.filter((p) => p.pane !== "p8");
    const m = await mount("bw-tabs", { live: { ...data, nextCommand: c.next } });
    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(m.log.run).toEqual([]);
  });

  test("flip on a terminal tab does nothing", async () => {
    const c = commands();
    const data = live("chat-tab");
    data.spaces[0].tabs = data.spaces[0].tabs.map((t) => ({ ...t, active: t.id === "tb7" }));
    const m = await mount("bw-tabs", { live: { ...data, nextCommand: c.next } });
    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(m.log.run).toEqual([]);
    // A flip asked for on a terminal tab is not kept for the next chat tab.
    fake.spaces = live("chat-tab").spaces;
    m.render();
    expect(m.log.run).toEqual([]);
  });

  test("other commands do nothing", async () => {
    const c = commands();
    const m = await mount("bw-tabs", { live: { ...live("chat-tab"), nextCommand: c.next } });
    c.send("focus");
    await m.cx.flush();
    m.render();
    expect(m.log.run).toEqual([]);
    c.send("chat-flip");
    await m.cx.flush();
    m.render();
    expect(m.log.run).toHaveLength(3);
  });
});

describe("bw-tabs chat tab icon", () => {
  test("chat tab shows its agent's icon", async () => {
    const m = await mount("bw-tabs", { live: live("chat-tab") });
    const icons = findAll(byId(m.el, "tab-tb8"), (e) => e.tag === "image" || e.tag === "svg").map((e) => e.attrs.path);
    expect(icons[0]).toBe("icons/claude.svg");
  });

  test("a chat tab whose agent exited shows its terminal's program, not nothing", () => {
    const space = { tabs: [{ id: "tb8", index: 1, name: "Claude Code", named: true, active: true, status: null, settled: false }] };
    const shell = { key: "shell", name: "zsh", icon: "icons/terminal.svg", tint: true, tile: null, color: null, shell: true, agent: false };
    const panes = [chatPane, { pane: "p8", terminal: "t8", tab: "tb8", program: shell }];
    expect(tabItems(space, panes)[0].program).toEqual(shell);
  });
});
