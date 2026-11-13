import { describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { byId, findAll, textOf } from "../harness/kit-stub.js";
import { fake } from "../harness/herdr-stub.js";
import { adopt } from "../../shared/chat-tabs.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import { argsRequest, extrasFrom, launchFolder } from "../../mods/bw-new/entries.js";

const EXTRAS = [
  "--mcp-config",
  "/h/.local/share/bellwether/agent/claude-mcp-mac.json",
  "--allowedTools",
  "mcp__bw-browser",
];
const WARNING = "Started without the browser";
const LOCAL = { space: "s1", machine: null, folder: "/r/alpha" };
const REMOTE = { space: "macmini/s3", machine: "macmini", folder: "/home/u/gamma" };

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
/** @param {Partial<Record<string, unknown>>} [fields] */
const argsLine = (fields = {}) => ({
  type: "agent-args",
  kind: "claude",
  machine: "",
  browser: "ready",
  reason: "",
  argv: EXTRAS,
  ...fields,
});

/**
 * The window machine's bw: `version` answers current, `browser agent-args` asks `answer`.
 * @param {(args: string[]) => unknown} answer
 */
const bw = (answer) => (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
  if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1])) return { code: 127, stdout: "", stderr: "stub: not bw" };
  const sub = args.slice(3);
  if (sub[0] === "version") return out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);
  if (sub[0] === "browser" && sub[1] === "agent-args") return answer(sub);
  return { code: 127, stdout: "", stderr: `stub: no answer for bw ${sub.join(" ")}` };
};

/** An agent-args answer the test resolves when it chooses. */
function held() {
  /** @type {(v: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { answer: () => promise, resolve };
}

/**
 * Runs the tasks, then draws again as Herdr does after their cx.notify(); the launch happens in that render.
 * @param {any} m
 */
async function settle(m) {
  const notified = m.cx.notified;
  await m.cx.flush();
  expect(m.cx.notified).toBeGreaterThan(notified);
  m.render();
}
/** @param {any} m */
const argsCalls = (m) =>
  m.log.exec.filter((/** @type {any} */ [c, a]) => c === "sh" && HELPER_SCRIPTS.includes(a[1]) && a[3] === "browser");
/** @param {any} m */
const chatWrites = (m) => m.log.shared.filter((/** @type {any} */ [k]) => k === "bw.chat-tabs");

/** @param {(args: string[]) => unknown} answer @param {string} [name] */
function data(answer, name = "two-machines") {
  const d = live(name);
  d.exec = bw(answer);
  return d;
}

describe("entries: browser additions", () => {
  test("argsRequest names kind, machine and folder", () => {
    expect(argsRequest("claude", LOCAL, ["claude"])).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "claude",
      "--machine",
      "",
      "--cwd",
      "/r/alpha",
    ]);
    expect(argsRequest("codex", REMOTE, ["codex"])).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "codex",
      "--machine",
      "macmini",
      "--cwd",
      "/home/u/gamma",
    ]);
  });

  test("argsRequest leaves out --cwd without a folder", () => {
    expect(argsRequest("codex", { space: null, machine: "macmini", folder: null }, ["codex"])).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "codex",
      "--machine",
      "macmini",
    ]);
  });

  test("argsRequest passes a Codex profile only", () => {
    const tail = (/** @type {string[]} */ a) => a.slice(a.indexOf("--cwd") + 2);
    expect(tail(argsRequest("codex", LOCAL, ["codex", "--profile", "work"]))).toEqual(["--profile", "work"]);
    expect(tail(argsRequest("codex", LOCAL, ["codex", "-p", "fast", "--search"]))).toEqual(["--profile", "fast"]);
    expect(tail(argsRequest("codex", LOCAL, ["codex", "--profile=deep"]))).toEqual(["--profile", "deep"]);
    expect(tail(argsRequest("codex", LOCAL, ["codex", "--profile"]))).toEqual([]);
    expect(tail(argsRequest("claude", LOCAL, ["claude", "-p", "hello"]))).toEqual([]);
    expect(tail(argsRequest("claude", LOCAL, ["claude", "--profile", "x"]))).toEqual([]);
  });

  test("extrasFrom takes argv only from a ready line", () => {
    expect(extrasFrom({ ok: true, lines: [argsLine()] })).toEqual({ extras: EXTRAS, notice: null });
    expect(
      extrasFrom({
        ok: true,
        lines: [argsLine({ browser: "unavailable", reason: "macmini connects through via", argv: EXTRAS })],
      }),
    ).toEqual({ extras: [], notice: "macmini connects through via" });
    expect(extrasFrom({ ok: false, state: "missing", message: "bw is not installed on this machine" })).toEqual({
      extras: [],
      notice: "bw is not installed on this machine",
    });
    expect(extrasFrom({ ok: true, lines: [] }).extras).toEqual([]);
    expect(extrasFrom({ ok: true, lines: [] }).notice).toBeString();
    expect(extrasFrom({ ok: true, lines: [argsLine({ argv: ["--x", 3] })] }).extras).toEqual([]);
    expect(extrasFrom({ ok: true, lines: [argsLine({ browser: "unavailable", reason: "" })] }).notice).toBeString();
  });
});

describe("bw-new: browser additions", () => {
  test("chat click asks agent-args on the window machine with the space's machine and folder", async () => {
    const m = await mount("bw-new", {
      props: { space: "macmini/s3", overlay: "o1" },
      live: data(() => out([argsLine({ kind: "codex", machine: "macmini" })])),
    });
    await m.click("row-chat-codex");
    const calls = argsCalls(m);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].slice(3)).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "codex",
      "--machine",
      "macmini",
      "--cwd",
      "/home/u/gamma",
    ]);
    expect(calls[0][2]).toEqual({ on: null });
  });

  test("extras land after run in tab.new argv", async () => {
    const m = await mount("bw-new", {
      props: { space: "macmini/s3", overlay: "o1" },
      live: data(() => out([argsLine({ kind: "codex" })])),
    });
    await m.click("row-chat-codex");
    expect(m.log.run).toEqual([
      ["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex", ...EXTRAS] }],
    ]);
    expect(m.log.closed).toEqual(["o1"]);
    expect(m.log.notify).toEqual([]);
  });

  test("a chat without a space gets the extras in space.new", async () => {
    const m = await mount("bw-new", {
      props: { machine: null, folder: "/r/beta", overlay: "o1" },
      live: data(() => out([argsLine()])),
    });
    await m.click("row-chat-claude");
    expect(m.log.run).toEqual([
      ["space.new", { folder: "/r/beta", machine: "", tab: "Claude Code", argv: ["claude", ...EXTRAS] }],
    ]);
  });

  test("terminal Claude row gets the same extras", async () => {
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o2" }, live: data(() => out([argsLine()])) });
    await m.click("row-claude");
    expect(argsCalls(m)[0][1].slice(3)).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "claude",
      "--machine",
      "",
      "--cwd",
      "/r/alpha",
    ]);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/r/alpha", name: "Claude Code", argv: ["claude", ...EXTRAS] }],
    ]);
    expect(m.log.closed).toEqual(["o2"]);
    expect(chatWrites(m)).toEqual([]);
  });

  test("shell row starts at once", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o3" }, live: data(h.answer) });
    await m.click("row-shell");
    expect(m.log.run).toEqual([["tab.new", { space: "s1" }]]);
    expect(m.log.closed).toEqual(["o3"]);
    expect(argsCalls(m)).toEqual([]);
  });

  test("failed_args_start_plain_with_notice", async () => {
    const reason = "browser forward unavailable: macmini connects through via, not SSH";
    const cases = [
      [() => out([argsLine({ kind: "codex", browser: "unavailable", reason, argv: [] })]), reason],
      [() => out([{ type: "error", code: "usage", message: "unknown flag --kind" }]), "unknown flag --kind"],
      [() => ({ code: 1, stdout: "", stderr: "boom" }), "bw exited 1: boom"],
      [() => ({ code: 0, stdout: "not json\n", stderr: "" }), "line 1 is not a JSON object"],
      [
        () => {
          throw new Error("machine gone");
        },
        "machine gone",
      ],
    ];
    for (const [answer, body] of /** @type {[() => unknown, string][]} */ (cases)) {
      const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o1" }, live: data(answer) });
      await m.click("row-chat-codex");
      expect(m.log.run).toEqual([
        ["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex"] }],
      ]);
      expect(m.log.notify).toEqual([{ title: WARNING, body, level: "warning" }]);
      expect(chatWrites(m)).toHaveLength(1);
    }
  });

  test("a missing helper starts plain with notice", async () => {
    const d = live("two-machines");
    d.exec = () => ({ code: 127, stdout: "", stderr: "sh: bw: not found" });
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o1" }, live: d });
    await m.click("row-codex");
    expect(m.log.run).toEqual([["tab.new", { space: "s1", folder: "/r/alpha", name: "Codex", argv: ["codex"] }]]);
    expect(m.log.notify).toHaveLength(1);
    expect(m.log.notify[0]).toMatchObject({ title: WARNING, level: "warning" });
    expect(String(/** @type {any} */ (m.log.notify[0]).body)).toContain("bw is not installed");
  });

  test("timeout_starts_plain", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-chat-codex");
    expect(m.log.run).toEqual([]);
    const budget = m.cx.sleeps.filter((s) => s.ms === 20000);
    expect(budget).toHaveLength(1);
    budget[0].wake();
    await settle(m);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex"] }],
    ]);
    expect(m.log.notify).toHaveLength(1);
    expect(m.log.notify[0]).toMatchObject({ title: WARNING, level: "warning" });
    expect(String(/** @type {any} */ (m.log.notify[0]).body)).toContain("20 s");
    // The answer arriving after the budget starts nothing more.
    h.resolve(out([argsLine({ kind: "codex" })]));
    await m.cx.flush();
    m.render();
    expect(m.log.run).toHaveLength(1);
    expect(chatWrites(m)).toHaveLength(1);
    expect(m.log.notify).toHaveLength(1);
  });

  test("second_click_while_preparing_does_nothing", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-chat-claude");
    expect(textOf(byId(m.el, "row-chat-claude"))).toContain("Preparing browser…");
    await m.click("row-chat-claude");
    await m.click("row-chat-codex");
    await m.click("row-codex");
    await m.click("row-shell");
    await m.click("row-worktree-new");
    expect(argsCalls(m)).toHaveLength(1);
    expect(m.log.run).toEqual([]);
    expect(m.log.overlays).toEqual([]);
    expect(m.log.closed).toEqual([]);
    h.resolve(out([argsLine()]));
    await settle(m);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/r/alpha", name: "Claude Code", argv: ["claude", ...EXTRAS] }],
    ]);
    expect(m.log.closed).toEqual(["o1"]);
  });

  test("the preparing row shows a spinner", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-codex");
    const row = byId(m.el, "row-codex");
    expect(textOf(row)).toContain("Preparing browser…");
    const [icon] = findAll(row, (e) => e.tag === "svg" && e.attrs.spin !== undefined);
    expect(icon.attrs.path).toContain("ring-spin");
    expect(icon.attrs).toMatchObject({ spin: 900, text_color: "#accent" });
    expect(textOf(byId(m.el, "row-claude"))).not.toContain("Preparing browser…");
  });

  test("profile in run is passed", async () => {
    const d = data(() => out([argsLine({ kind: "codex" })]));
    d.knownAgents = {
      "": [{ key: "codex", name: "Codex", icon: null, tint: true, run: ["codex", "-p", "work"], installed: true }],
    };
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o1" }, live: d });
    await m.cx.flush();
    m.render();
    await m.click("row-chat-codex");
    expect(argsCalls(m)[0][1].slice(3)).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "codex",
      "--machine",
      "",
      "--cwd",
      "/r/alpha",
      "--profile",
      "work",
    ]);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/r/alpha", name: "Codex", argv: ["codex", "-p", "work", ...EXTRAS] }],
    ]);
  });

  test("pending chat is recorded only after the args arrive", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-chat-codex");
    expect(chatWrites(m)).toEqual([]);
    expect(m.log.closed).toEqual([]);
    const before = Date.now();
    h.resolve(out([argsLine({ kind: "codex" })]));
    await settle(m);
    const writes = chatWrites(m);
    expect(writes).toHaveLength(1);
    const pending = /** @type {any} */ (writes[0][1]).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "codex",
      machine: "macmini",
      space: "macmini/s3",
      beforeTabs: ["macmini/tb5"],
      name: "Codex",
    });
    expect(pending[0].at).toBeGreaterThanOrEqual(before);
    expect(m.log.closed).toEqual(["o1"]);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "macmini/s3", folder: "/home/u/gamma", name: "Codex", argv: ["codex", ...EXTRAS] }],
    ]);
  });
});

describe("bw-new: the folder an agent starts in", () => {
  /**
   * s1's first pane sits at the repository root and its focused pane in a subfolder that can
   * hold its own Codex config, so agent-args must be asked about the subfolder.
   * @param {(args: string[]) => unknown} answer
   */
  function twoFolders(answer) {
    const d = data(answer);
    d.spaces.find((/** @type {any} */ s) => s.id === "s1").folder = "/repo/root";
    for (const p of d.panes) {
      if (p.pane === "p1") Object.assign(p, { cwd: "/repo/root", focused: false });
      if (p.pane === "p2") Object.assign(p, { cwd: "/repo/root/service", focused: true });
    }
    d.knownAgents = { "": [{ key: "codex", name: "Codex", icon: null, tint: true, run: ["codex"], installed: true }] };
    return d;
  }

  test("launchFolder takes the space's focused terminal, else its first pane's folder", () => {
    const d = twoFolders(() => null);
    const s1 = { space: "s1", machine: null, folder: "/repo/root" };
    expect(launchFolder(s1, d.spaces, d.panes)).toBe("/repo/root/service");
    expect(launchFolder(REMOTE, d.spaces, d.panes)).toBe("/home/u/gamma");
    // A focused pane in another space does not count.
    expect(launchFolder({ space: "s2", machine: null, folder: "/r/alpha-wt/feat" }, d.spaces, d.panes)).toBe(
      "/r/alpha-wt/feat",
    );
    expect(launchFolder({ space: null, machine: null, folder: "/r/beta" }, d.spaces, d.panes)).toBe("/r/beta");
    expect(launchFolder({ space: null, machine: null, folder: null }, d.spaces, d.panes)).toBeNull();
  });

  test("New chat Codex asks and starts in the focused terminal's folder", async () => {
    const m = await mount("bw-new", {
      props: { space: "s1", overlay: "o1" },
      live: twoFolders(() => out([argsLine({ kind: "codex" })])),
    });
    await m.cx.flush();
    m.render();
    await m.click("row-chat-codex");
    expect(argsCalls(m)[0][1].slice(3)).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "codex",
      "--machine",
      "",
      "--cwd",
      "/repo/root/service",
    ]);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/repo/root/service", name: "Codex", argv: ["codex", ...EXTRAS] }],
    ]);
    expect(/** @type {any} */ (chatWrites(m)[0][1]).pending[0].folder).toBe("/repo/root/service");
  });

  test("New terminal Codex asks and starts in the focused terminal's folder", async () => {
    const m = await mount("bw-new", {
      props: { space: "s1", overlay: "o1" },
      live: twoFolders(() => out([argsLine({ kind: "codex" })])),
    });
    await m.cx.flush();
    m.render();
    await m.click("row-codex");
    expect(argsCalls(m)[0][1].slice(3)).toEqual([
      "browser",
      "agent-args",
      "--kind",
      "codex",
      "--machine",
      "",
      "--cwd",
      "/repo/root/service",
    ]);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/repo/root/service", name: "Codex", argv: ["codex", ...EXTRAS] }],
    ]);
  });

  test("a plain start after a failure still names the folder", async () => {
    const m = await mount("bw-new", {
      props: { space: "s1", overlay: "o1" },
      live: twoFolders(() => ({ code: 1, stdout: "", stderr: "boom" })),
    });
    await m.cx.flush();
    m.render();
    await m.click("row-chat-codex");
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/repo/root/service", name: "Codex", argv: ["codex"] }],
    ]);
  });
});

describe("bw-new: the launch reads the spaces when it starts", () => {
  /** @param {string} id @param {string} name */
  const tab = (id, name) => ({
    id,
    index: 9,
    name,
    named: true,
    active: false,
    status: null,
    panes: 1,
    zoomed: false,
    settled: false,
    settled_at: null,
    changed_at: null,
    working_since: null,
  });
  /** @param {string} pane @param {string} terminal @param {string} tabId */
  const pane = (pane, terminal, tabId) => ({
    pane,
    terminal,
    tab: tabId,
    title: "Claude Code",
    cwd: "/r/alpha",
    app: "claude-code",
    program: { key: "claude" },
    focused: false,
    zoomed: false,
    movable: false,
  });

  test("a same-named tab made while preparing is not adopted as the new chat", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-chat-claude");
    // Another window opens a plain "Claude Code" terminal tab in s1 during the wait.
    const s1 = fake.spaces.find((/** @type {any} */ s) => s.id === "s1");
    s1.tabs.push(tab("interloper", "Claude Code"));
    fake.panes.push(pane("interloper-pane", "t-old", "interloper"));
    m.render();
    h.resolve(out([argsLine()]));
    await settle(m);
    expect(m.log.run).toEqual([
      ["tab.new", { space: "s1", folder: "/r/alpha", name: "Claude Code", argv: ["claude", ...EXTRAS] }],
    ]);
    const value = /** @type {any} */ (chatWrites(m).at(-1)?.[1]);
    expect(value.pending[0].beforeTabs).toEqual(["tb1", "tb2", "tb7", "interloper"]);
    s1.tabs.push(tab("requested", "Claude Code"));
    fake.panes.push(pane("requested-pane", "t-new", "requested"));
    const r = adopt(value, fake.spaces, fake.panes, Date.now());
    expect(r.actions).toEqual([]);
    expect(r.next?.tabs.requested?.terminal).toBe("t-new");
  });

  test("a space made while preparing is not taken as the new chat's space", async () => {
    const h = held();
    const m = await mount("bw-new", {
      props: { machine: null, folder: "/r/beta", overlay: "o1" },
      live: data(h.answer),
    });
    await m.click("row-chat-claude");
    fake.spaces.push({ ...structuredClone(fake.spaces[0]), id: "s-other", folder: "/r/beta", tabs: [] });
    m.render();
    h.resolve(out([argsLine()]));
    await settle(m);
    expect(m.log.run).toEqual([
      ["space.new", { folder: "/r/beta", machine: "", tab: "Claude Code", argv: ["claude", ...EXTRAS] }],
    ]);
    expect(/** @type {any} */ (chatWrites(m).at(-1)[1]).pending[0].beforeSpaces).toEqual([
      "s1",
      "s2",
      "macmini/s3",
      "s-other",
    ]);
  });

  test("renders after the launch start it once", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "s1", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-codex");
    h.resolve(out([argsLine({ kind: "codex" })]));
    await settle(m);
    m.render();
    expect(m.log.run).toHaveLength(1);
    expect(m.log.closed).toEqual(["o1"]);
    expect(m.log.live.filter(([, phase]) => phase === "task" || phase === "timer")).toEqual([]);
  });

  test("a space that closed while preparing starts nothing and says so", async () => {
    const h = held();
    const m = await mount("bw-new", { props: { space: "macmini/s3", overlay: "o1" }, live: data(h.answer) });
    await m.click("row-chat-codex");
    fake.spaces = fake.spaces.filter((/** @type {any} */ s) => s.id !== "macmini/s3");
    h.resolve(out([argsLine({ kind: "codex" })]));
    await settle(m);
    expect(m.log.run).toEqual([]);
    expect(chatWrites(m)).toEqual([]);
    expect(m.log.closed).toEqual(["o1"]);
    expect(m.log.notify).toEqual([
      { title: "Nothing started", body: "The space closed while the browser was being prepared.", level: "warning" },
    ]);
  });
});
