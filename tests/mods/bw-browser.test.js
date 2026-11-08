// bw-browser: the right sidebar's Browser panel, fed by one `bw browser status` call per poll.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { live, mount, repo } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS } from "../../shared/helper.js";
import { canForward, forwardLabel, forwardState, isShown, viewOf } from "../../mods/bw-browser/model.js";

const PANEL = live("browser-panel");
const STATUS = PANEL.exec
  .find((e) => e.argsInclude.includes("status"))
  .result.stdout.trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const VERSION = PANEL.exec.find((e) => e.argsInclude.includes("version")).result;
const [CHROME, GH, PAGE] = STATUS;
const STOPPED = {
  ...CHROME,
  state: "stopped",
  pid: null,
  browser_id: null,
  version: null,
  message: "the Bellwether Chrome is not running",
};

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });

/**
 * A fake `exec` for the window machine's helper: `answers` maps "browser <sub>" to lines or a function.
 * @param {Record<string, object[] | ((args: string[]) => unknown)>} answers
 */
function bw(answers) {
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw" || (opts?.on ?? null) !== null)
      return { code: 127, stdout: "", stderr: "sh: no such fake" };
    if (args[3] === "version") return VERSION;
    const a = answers[`${args[3]} ${args[4]}`];
    if (!a) return out([{ type: "error", code: "stub", message: `no ${args[3]} ${args[4]} answer` }]);
    return typeof a === "function" ? a(args.slice(3)) : out(a);
  };
}

/** Sets the right-body stack's active child, as layout.select does. @param {string} child */
function showInLayout(child, node = fake.layout) {
  if (node.id === "right-body") node.active = child;
  for (const c of node.children ?? []) showInLayout(child, c);
}

/** The browser-panel fixture with its exec replaced; the panel shown unless `hidden`. */
async function panel({ answers = { "browser status": STATUS }, hidden = false, data = PANEL } = {}) {
  const m = await mount("bw-browser", { live: { ...structuredClone(data), exec: bw(answers) } });
  if (!hidden) {
    showInLayout("browser");
    m.render();
  }
  await m.cx.flush();
  m.render();
  return m;
}

/** @param {any} m */
const statusCalls = (m) => m.log.exec.filter(([c, a]) => c === "sh" && a[3] === "browser" && a[4] === "status");
/** Every `bw browser …` call after the subcommand. @param {any} m */
const browserCalls = (m) =>
  m.log.exec.filter(([c, a]) => c === "sh" && a[3] === "browser" && a[4] !== "status").map(([, a]) => a.slice(4));
/** Draws the panel (as Herdr does after the loop's notify), then wakes the loop's sleep. @param {any} m */
async function nextPoll(m) {
  m.render();
  m.cx.sleeps.at(-1).wake();
  await m.cx.flush();
  m.render();
}

describe("model", () => {
  test("viewOf reads chrome, tabs and forwards", () => {
    const v = viewOf(STATUS, null);
    expect(v.chrome).toEqual({ state: "running", label: "Running · 3 tabs", message: CHROME.message });
    expect(v.states).toBe(null);
    expect(v.tabs.map((t) => [t.id, t.title, t.secondary, t.favicon, t.active])).toEqual([
      [GH.id, "Pull requests · bellwether", "github.com/pulls", "data/bellwether/favicons/0123456789abcdef.png", true],
      [PAGE.id, "Bellwether test page", "127.0.0.1:41733/page.html", null, false],
      [STATUS[3].id, "New Tab", "chrome://newtab/", null, false],
    ]);
    expect(v.forwards.map((f) => [f.kind, f.machine, f.port, f.state])).toEqual([
      ["browser", "macmini", 52817, "ready"],
      ["dev", "macmini", 3000, "reconnecting"],
    ]);
  });

  test("one tab is singular, a title falls back to the URL, a favicon outside the cache is dropped", () => {
    const v = viewOf([CHROME, { ...GH, title: "", favicon: "/etc/passwd" }], null);
    expect(v.chrome.label).toBe("Running · 1 tab");
    expect(v.tabs[0].title).toBe(GH.url);
    expect(v.tabs[0].favicon).toBe(null);
  });

  test("named states replace the list", () => {
    expect(viewOf([STOPPED], null)).toMatchObject({
      chrome: { state: "stopped", label: "Not running" },
      tabs: [],
      states: "The Bellwether Chrome is not running",
    });
    const taken = {
      ...CHROME,
      state: "port_taken",
      pid: 812,
      message: "Port 9222 is used by another program: node (pid 812)",
    };
    expect(viewOf([taken], null)).toMatchObject({
      chrome: { label: "Port taken" },
      states: "Port 9222 is used by another program: node (pid 812)",
    });
    const noPort = {
      ...STOPPED,
      state: "no_debug_port",
      message: "the Bellwether Chrome is running without its debugging port; quit it, then Start",
    };
    expect(viewOf([noPort], null).states).toBe(
      "The Bellwether Chrome is running without its debugging port; quit it, then Start",
    );
    expect(
      viewOf([{ ...STOPPED, state: "not_installed", message: "Google Chrome is not installed on this Mac" }], null)
        .states,
    ).toBe("Google Chrome is not installed on this Mac");
    const missing = {
      ok: false,
      state: "missing",
      message: "bw is not installed on this machine: run scripts/install-helper.sh",
    };
    expect(viewOf(null, missing)).toMatchObject({
      chrome: { state: "helper", label: "Helper missing" },
      tabs: [],
      forwards: [],
      states: missing.message,
    });
    expect(viewOf(null, null)).toMatchObject({
      chrome: { state: "loading" },
      states: "Reading the Bellwether Chrome…",
    });
    expect(viewOf([], null).states).toBe("bw browser status printed no chrome line");
  });

  test("forwardLabel names browser and dev forwards; forwardState is the pill's words", () => {
    expect(forwardLabel(STATUS[4])).toBe("macmini · browser :52817");
    expect(forwardLabel(STATUS[5])).toBe("localhost:3000 ← macmini");
    expect(forwardState({ state: "ready_no_answer" })).toBe("ready no answer");
    expect(forwardState(STATUS[5])).toBe("reconnecting");
  });

  test("canForward needs a space on another machine", () => {
    expect(canForward(null)).toEqual({ ok: false, hint: "No space is open" });
    expect(canForward({ id: "s1", machine: null })).toEqual({ ok: false, hint: "This space is on this Mac" });
    expect(canForward({ id: "macmini/s3", machine: "macmini" })).toEqual({
      ok: true,
      hint: "Forward a port from macmini",
    });
  });

  test("isShown is the right-body stack showing browser in a column that is not hidden", () => {
    const L = JSON.parse(readFileSync(join(repo, "layouts/bellwether.json"), "utf8"));
    expect(isShown(L)).toBe(false);
    showInLayout("browser", L);
    expect(isShown(L)).toBe(true);
    const right = L.children.find((c) => c.id === "right");
    right.hidden = true;
    expect(isShown(L)).toBe(false);
    expect(isShown(null)).toBe(false);
    expect(isShown({ id: "root", type: "row", children: [] })).toBe(false);
  });
});

describe("bw-browser", () => {
  test("shown panel polls status every 2 s and hidden polls nothing", async () => {
    const m = await panel();
    expect(statusCalls(m)).toHaveLength(1);
    expect(m.cx.sleeps.at(-1).ms).toBeGreaterThanOrEqual(1000);
    expect(m.cx.sleeps.at(-1).ms).toBeLessThanOrEqual(2000);
    await nextPoll(m);
    expect(statusCalls(m)).toHaveLength(2);

    showInLayout("changes");
    m.render();
    await m.cx.flush();
    expect(statusCalls(m)).toHaveLength(2);
    expect(m.cx.sleeps.filter((s) => s.ms > 0)).toHaveLength(2);

    const hidden = await panel({ hidden: true });
    expect(statusCalls(hidden)).toHaveLength(0);
    expect(hidden.cx.sleeps).toHaveLength(0);
  });

  test("a copy Herdr stops drawing stops polling, and reads again once drawn", async () => {
    const m = await panel();
    m.cx.sleeps.at(-1).wake();
    await m.cx.flush();
    expect(statusCalls(m)).toHaveLength(2);
    // No render since that read's notify: Herdr hid the copy (another stack child, a hidden column).
    m.cx.sleeps.at(-1).wake();
    await m.cx.flush();
    expect(statusCalls(m)).toHaveLength(2);
    m.render();
    m.render();
    await m.cx.flush();
    expect(statusCalls(m)).toHaveLength(3);
  });

  test("showing the panel reads at once", async () => {
    const m = await panel({ hidden: true });
    expect(statusCalls(m)).toHaveLength(0);
    showInLayout("browser");
    m.render();
    m.render();
    await m.cx.flush();
    expect(statusCalls(m)).toHaveLength(1);
    expect(textOf(m.render())).toContain("Pull requests · bellwether");
  });

  test("no live read from the loop", async () => {
    const m = await panel();
    await nextPoll(m);
    await nextPoll(m);
    expect(statusCalls(m)).toHaveLength(3);
    const reads = m.log.live.filter(([name]) =>
      ["layout", "spaces", "panes", "agents", "terminals", "focused"].includes(name),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(([, phase]) => phase === "render")).toBe(true);
  });

  test("tabs render favicon, title, host and active bar", async () => {
    const m = await panel();
    const row = byId(m.el, `browser-tab-${GH.id}`);
    expect(row.attrs.h).toBe(40);
    expect(row.attrs.bg).toBe("#selected");
    expect(byId(row, `browser-tab-bar-${GH.id}`).attrs).toMatchObject({ w: 2, bg: "#accent" });
    const frame = byId(row, `browser-favicon-${GH.id}`);
    expect(frame.attrs).toMatchObject({ size: 24, rounded: 6, bg: "#raised" });
    expect(frame.kids[0]).toMatchObject({
      tag: "image",
      attrs: { path: "data/bellwether/favicons/0123456789abcdef.png", w: 16, h: 16 },
    });
    expect(textOf(row)).toBe("Pull requests · bellwether github.com/pulls");
    const page = byId(m.el, `browser-tab-${PAGE.id}`);
    expect(page.attrs.bg).not.toBe("#selected");
    expect(byId(page, `browser-tab-bar-${PAGE.id}`)).toBe(null);
    expect(textOf(byId(m.el, "browser-header"))).toBe("Bellwether Chrome Running · 3 tabs New tab Arrange");
    expect(byId(m.el, "browser-header").attrs.h).toBe(36);
  });

  test("missing favicon shows the globe", async () => {
    const m = await panel();
    expect(byId(m.el, `browser-favicon-${PAGE.id}`).kids[0]).toMatchObject({
      tag: "svg",
      attrs: { path: "mods/bw-browser/icons/globe.svg", size: 14 },
    });
  });

  test("named states: not running, port taken, no debug port, not installed, helper missing", async () => {
    const stopped = await panel({
      answers: { "browser status": [STOPPED], "browser up": [{ ...CHROME, started: true }] },
    });
    expect(textOf(byId(stopped.el, "browser-header"))).toBe("Bellwether Chrome Not running Start");
    expect(textOf(byId(stopped.el, "browser-state"))).toBe("The Bellwether Chrome is not running");
    expect(byId(stopped.el, "browser-tabs")).toBe(null);
    await stopped.click("browser-start");
    expect(browserCalls(stopped)).toEqual([["up"]]);
    expect(statusCalls(stopped)).toHaveLength(2);
    expect(textOf(byId(stopped.el, "browser-note"))).toBe("Started the Bellwether Chrome");

    const taken = {
      ...CHROME,
      state: "port_taken",
      pid: 812,
      message: "Port 9222 is used by another program: node (pid 812)",
    };
    const t = await panel({ answers: { "browser status": [taken] } });
    expect(textOf(byId(t.el, "browser-state"))).toBe("Port 9222 is used by another program: node (pid 812)");
    expect(byId(t.el, "browser-start")).toBe(null);

    const noPort = {
      ...STOPPED,
      state: "no_debug_port",
      message: "the Bellwether Chrome is running without its debugging port; quit it, then Start",
    };
    const n = await panel({ answers: { "browser status": [noPort] } });
    expect(textOf(byId(n.el, "browser-state"))).toContain("without its debugging port; quit it, then Start");
    expect(byId(n.el, "browser-start")).not.toBe(null);

    const ni = await panel({
      answers: {
        "browser status": [
          { ...STOPPED, state: "not_installed", message: "Google Chrome is not installed on this Mac" },
        ],
      },
    });
    expect(textOf(byId(ni.el, "browser-state"))).toBe("Google Chrome is not installed on this Mac");
    expect(byId(ni.el, "browser-start")).toBe(null);

    const data = {
      ...structuredClone(PANEL),
      exec: async () => ({ code: 127, stdout: "", stderr: "sh: 1: exec: bw: not found" }),
    };
    const missing = await mount("bw-browser", { live: data });
    showInLayout("browser");
    missing.render();
    await missing.cx.flush();
    missing.render();
    expect(textOf(byId(missing.el, "browser-header"))).toBe("Bellwether Chrome Helper missing");
    expect(textOf(byId(missing.el, "browser-state"))).toBe(
      "bw is not installed on this machine: run scripts/install-helper.sh",
    );
  });

  test("a status the helper cannot run yet names it", async () => {
    const m = await panel({ answers: {} });
    expect(textOf(byId(m.el, "browser-state"))).toBe("no browser status answer");
  });

  test("forwards list states and Stop runs forward stop", async () => {
    const m = await panel({
      answers: { "browser status": STATUS, "browser forward": [{ ...STATUS[4], state: "stopped" }] },
    });
    const rows = findAll(byId(m.el, "browser-forwards"), (e) =>
      String(e.attrs.id ?? "").startsWith("browser-forward-row-"),
    );
    expect(rows.map((r) => r.attrs.h)).toEqual([28, 28]);
    expect(textOf(byId(m.el, "browser-forwards"))).toContain("FORWARDS");
    expect(textOf(rows[0])).toBe("macmini · browser :52817 ready Stop");
    expect(textOf(rows[1])).toBe(
      "localhost:3000 ← macmini reconnecting ssh: connect to host macmini port 22: Operation timed out Stop",
    );
    await m.click("browser-forward-stop-macmini-browser-52817");
    expect(browserCalls(m)).toEqual([["forward", "stop", "--machine", "macmini"]]);
    expect(statusCalls(m)).toHaveLength(2);
    await m.click("browser-forward-stop-macmini-dev-3000");
    expect(browserCalls(m).at(-1)).toEqual(["forward", "stop", "--machine", "macmini", "--dev", "3000"]);
  });

  test("Forward port is disabled for a local space", async () => {
    const m = await panel();
    expect(textOf(byId(m.el, "browser-forward-hint"))).toBe("This space is on this Mac");
    await m.click("browser-forward-port");
    expect(byId(m.el, "browser-forward-input")).toBe(null);
    expect(browserCalls(m)).toEqual([]);
  });

  test("Forward port on a remote space adds a dev forward", async () => {
    const data = structuredClone(PANEL);
    for (const s of data.spaces) s.active = s.id === "macmini/s3";
    const dev = {
      type: "forward",
      kind: "dev",
      machine: "macmini",
      target: "macmini",
      port: 5173,
      state: "ready",
      reason: "",
      terminal: "bw-dev-macmini-5173",
    };
    const m = await panel({ data, answers: { "browser status": STATUS, "browser forward": [dev] } });
    await m.click("browser-forward-port");
    const input = byId(m.el, "browser-forward-input");
    expect(input.attrs.h).toBe(28);
    const state = input.attrs.state;
    state.set_value("80x");
    await m.click("browser-forward-add");
    expect(browserCalls(m)).toEqual([]);
    expect(textOf(byId(m.el, "browser-note"))).toBe("Enter a port from 1 to 65535");
    state.set_value(" 5173 ");
    await m.click("browser-forward-add");
    expect(browserCalls(m)).toEqual([["forward", "dev", "--machine", "macmini", "--port", "5173"]]);
    expect(textOf(byId(m.el, "browser-note"))).toBe("localhost:5173 ← macmini");
    expect(byId(m.el, "browser-forward-input")).toBe(null);
  });

  test("Arrange shows its result for 4 s", async () => {
    const placed = {
      type: "arrange",
      state: "placed",
      side: "over",
      bounds: { left: 960, top: 25, width: 960, height: 1055 },
      message: "No room beside Herdr: Chrome covers the right half",
    };
    const m = await panel({ answers: { "browser status": STATUS, "browser arrange": [placed] } });
    await m.click("browser-arrange");
    expect(browserCalls(m)).toEqual([["arrange"]]);
    expect(textOf(byId(m.el, "browser-note"))).toBe("No room beside Herdr: Chrome covers the right half");
    const after = m.cx.afters.at(-1);
    expect(after.ms).toBe(4000);
    await after.fn(m.cx);
    expect(byId(m.render(), "browser-note")).toBe(null);
  });

  test("a second click while an action runs starts nothing", async () => {
    /** @type {(v: unknown) => void} */
    let finish = () => {};
    const slow = () => new Promise((r) => (finish = r));
    const m = await panel({ answers: { "browser status": STATUS, "browser arrange": slow } });
    await m.click("browser-arrange");
    await m.click("browser-arrange");
    await m.click("browser-new-tab");
    expect(browserCalls(m)).toEqual([["arrange"]]);
    finish(out([{ type: "arrange", state: "placed", side: "right", bounds: null, message: "Placed right of Herdr" }]));
    await m.cx.flush();
    expect(textOf(byId(m.render(), "browser-note"))).toBe("Placed right of Herdr");
  });

  test("row click focuses that id", async () => {
    const m = await panel({
      answers: {
        "browser status": STATUS,
        "browser focus": [{ type: "tab-action", action: "focus", id: PAGE.id, ok: true, message: "focused" }],
      },
    });
    await m.click(`browser-tab-${PAGE.id}`);
    expect(browserCalls(m)).toEqual([["focus", "--id", PAGE.id]]);
    expect(statusCalls(m)).toHaveLength(2);
  });

  test("hover shows close, and close runs close for that id", async () => {
    const m = await panel({
      answers: {
        "browser status": STATUS,
        "browser close": [{ type: "tab-action", action: "close", id: PAGE.id, ok: true, message: "closed" }],
      },
    });
    expect(byId(m.el, `browser-tab-close-${PAGE.id}`)).toBe(null);
    fire(byId(m.el, `browser-tab-${PAGE.id}`), "on_hover", true, m.cx);
    m.render();
    await m.click(`browser-tab-close-${PAGE.id}`);
    expect(browserCalls(m)).toEqual([["close", "--id", PAGE.id]]);
    expect(textOf(byId(m.el, "browser-note"))).toBe("Closed Bellwether test page");
  });

  test("New tab runs browser new; a failed action names the helper's reason", async () => {
    const opened = [{ type: "tab-action", action: "new", id: "F00D", ok: true, message: "opened" }];
    const m = await panel({ answers: { "browser status": STATUS, "browser new": opened } });
    await m.click("browser-new-tab");
    expect(browserCalls(m)).toEqual([["new"]]);
    expect(textOf(byId(m.el, "browser-note"))).toBe("Opened a new tab");

    const refused = [{ type: "error", code: "chrome_unreachable", message: "chrome refused" }];
    const f = await panel({ answers: { "browser status": STATUS, "browser new": refused } });
    await f.click("browser-new-tab");
    expect(textOf(byId(f.el, "browser-note"))).toBe("New tab failed: chrome refused");

    // A tab-action with ok false exits 1, and the shared helper keeps only the exit code then.
    const notOk = () => ({
      code: 1,
      stdout: `${JSON.stringify({ type: "tab-action", action: "new", id: "", ok: false, message: "chrome refused" })}\n`,
      stderr: "",
    });
    const g = await panel({ answers: { "browser status": STATUS, "browser new": notOk } });
    await g.click("browser-new-tab");
    expect(textOf(byId(g.el, "browser-note"))).toBe("New tab failed: bw exited 1:");
  });

  test("no tabs open says so", async () => {
    const m = await panel({ answers: { "browser status": [CHROME] } });
    expect(textOf(byId(m.el, "browser-state"))).toBe("No tabs open");
    expect(textOf(byId(m.el, "browser-header"))).toBe("Bellwether Chrome Running · 0 tabs New tab Arrange");
  });

  test("the panel fills its block in 13 px text", async () => {
    const m = await panel();
    expect(m.el.attrs).toMatchObject({ id: "browser-root", text_size: 13 });
    expect("size_full" in m.el.attrs).toBe(true);
  });
});

test("the header pill is Mauve while running, Peach for a taken port, Red when Chrome failed", async () => {
  const { stateTone, forwardTone } = await import("../../mods/bw-browser/main.js");
  expect(
    ["running", "port_taken", "start_failed", "not_installed", "helper", "stopped", "loading"].map(stateTone),
  ).toEqual(["accent", "blocked", "failed", "failed", "failed", "machine", "machine"]);
  expect(["ready", "reconnecting", "failed"].map(forwardTone)).toEqual(["done", "blocked", "failed"]);
});
