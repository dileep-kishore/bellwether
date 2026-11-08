// bw-chat's attached Linear issues: chips on this chat's composer, built into text at Send.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { live, mount, repo } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, emit, findAll, fire, inspect, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import { addChip, ATTACH, chipFrom, chipsFor } from "../../shared/linear-attach.js";

const CLAUDE = { terminal: "t8", machine: null, kind: "claude" };
const CODEX_REMOTE = { terminal: "macmini/t5", machine: "macmini", kind: "codex" };
const CLAUDE_PATH = "/home/test/.claude/projects/-r-alpha/3833b375-e79d-47bf-8e7e-f66cf3faab4b.jsonl";
const CODEX_PATH =
  "/home/u/.codex/sessions/2026/11/07/rollout-2026-11-07T06-11-54-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl";

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);

/** @param {string} name @param {string} terminal @param {string} path */
function golden(name, terminal, path) {
  const lines = readFileSync(join(repo, "tests/fixtures/feed", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  lines[0] = { ...lines[0], terminal, path, cursor: `2.fixture-${name}` };
  return lines;
}

const text = (/** @type {string} */ id) =>
  `Linear issue ${id}: Title ${id}\nhttps://linear.app/x/issue/${id}\n\nBody.\n\n---\n`;

/** @param {{ linear?: (args: string[]) => any, send?: () => any, feed?: () => any }} [o] */
function bw(o = {}) {
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ _opts) => {
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw")
      return { code: 127, stdout: "", stderr: "" };
    const sub = args[3];
    if (sub === "version") return VERSION;
    if (sub === "feed") return o.feed ? o.feed() : out(golden("claude-picture", "t8", CLAUDE_PATH));
    if (sub === "picture") return out([{ type: "picture", digest: "x", state: "gone" }]);
    if (sub === "linear") {
      const r = o.linear?.(args.slice(3));
      if (r) return r;
      const id = args[args.indexOf("--id") + 1];
      return out([{ type: "linear-text", identifier: id, text: text(id), bytes: 5, mode: "full", path: null }]);
    }
    if (sub === "send") return o.send ? o.send() : out([{ type: "send", result: "sent", message: "" }]);
    return out([{ type: "error", code: "stub", message: `no ${sub}` }]);
  };
}

const chip = (/** @type {string} */ id, description = "Body.") =>
  /** @type {any} */ (
    chipFrom(
      {
        identifier: id,
        title: `Title ${id}`,
        url: `https://linear.app/x/issue/${id}`,
        state: { name: "Todo" },
        description,
        bytes: description.length,
      },
      1,
    )
  );

/** chat-tab.json with chips on tb8 (the Claude chat's tab) and on another tab. @param {any[]} chips */
function data(chips, o = {}) {
  const d = live("chat-tab");
  let s = /** @type {any} */ (undefined);
  for (const c of chips) s = addChip(s, "tb8", c, ["tb8", "tb7"]);
  s = addChip(s, "tb7", chip("PLA-77"), ["tb8", "tb7"]);
  d.shared = { ...d.shared, [ATTACH]: s };
  d.exec = bw(o);
  return d;
}

/** @param {any} m @param {string} sub */
const calls = (m, sub) =>
  m.log.exec
    .filter(([c, a]) => c === "sh" && HELPER_SCRIPTS.includes(a[1]) && a[3] === sub)
    .map(([, a, o]) => ({ args: a.slice(3), on: o?.on ?? null }));
const textarea = (/** @type {any} */ m) => findAll(m.el, (e) => e.tag === "Textarea")[0];

/** @param {any} m @param {string} value */
async function typeAndSend(m, value) {
  const state = textarea(m).attrs.state;
  inspect(state).value = value;
  await emit(state, "change", {}, m.cx);
  inspect(state).value = `${value}\n`;
  await emit(state, "change", {}, m.cx);
  await emit(state, "submit", { shift: false }, m.cx);
  await m.cx.flush();
  return m.render();
}

describe("chips", () => {
  test("chips belong to their tab", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: data([chip("PLA-1"), chip("PLA-2")]) });
    expect(byId(m.el, "chip-PLA-1")).not.toBe(null);
    expect(byId(m.el, "chip-PLA-2")).not.toBe(null);
    expect(byId(m.el, "chip-PLA-77")).toBe(null);
  });

  test("hover shows the preview; × removes the chip", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: data([chip("PLA-1", "A short description.")]) });
    expect(byId(m.el, "chip-preview")).toBe(null);
    await fire(byId(m.el, "chip-PLA-1"), "on_hover", true, m.cx);
    const el = m.render();
    expect(textOf(byId(el, "chip-preview"))).toContain("A short description.");
    await m.click("chip-x-PLA-1");
    expect(chipsFor(fake.shared[ATTACH], "tb8")).toEqual([]);
    expect(chipsFor(fake.shared[ATTACH], "tb7").map((c) => c.identifier)).toEqual(["PLA-77"]);
  });

  test("Send builds each chip's text here, then sends text and message to the chat, and clears the chips", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: data([chip("PLA-1"), chip("PLA-2")]) });
    await typeAndSend(m, "please fix");
    expect(calls(m, "linear")).toEqual([
      { args: ["linear", "issue", "--id", "PLA-1", "--text"], on: null },
      { args: ["linear", "issue", "--id", "PLA-2", "--text"], on: null },
    ]);
    const sends = calls(m, "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].args.at(-1)).toBe(`${text("PLA-1")}${text("PLA-2")}please fix`);
    expect(sends[0].args.slice(1, 3)).toEqual(["--terminal", "t8"]);
    expect(chipsFor(fake.shared[ATTACH], "tb8")).toEqual([]);
    expect(chipsFor(fake.shared[ATTACH], "tb7").map((c) => c.identifier)).toEqual(["PLA-77"]);
  });

  test("chips go without a typed message", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: data([chip("PLA-1")]) });
    await typeAndSend(m, "");
    expect(calls(m, "send")[0]?.args.at(-1)).toBe(text("PLA-1").replace(/\n+$/, ""));
  });

  test("a refused send keeps the chips", async () => {
    const m = await mount("bw-chat", {
      props: CLAUDE,
      live: data([chip("PLA-1")], {
        send: () => out([{ type: "send", result: "refused-prompt", message: "blocked" }]),
      }),
    });
    await typeAndSend(m, "hi");
    expect(chipsFor(fake.shared[ATTACH], "tb8").map((c) => c.identifier)).toEqual(["PLA-1"]);
  });

  test("a long chip blocks Send until a choice", async () => {
    const long = chip("PLA-2", "x".repeat(9000));
    const m = await mount("bw-chat", { props: CLAUDE, live: data([long]) });
    expect(textOf(byId(m.el, "chip-choice-PLA-2"))).toContain("8.8 KB");
    await typeAndSend(m, "hi");
    expect(calls(m, "linear")).toEqual([]);
    expect(calls(m, "send")).toEqual([]);
    expect(textOf(byId(m.el, "send-note"))).toContain("choose Trim or Send as a file");
    await m.click("chip-trim-PLA-2");
    await typeAndSend(m, "hi");
    expect(calls(m, "linear").at(-1)?.args).toEqual(["linear", "issue", "--id", "PLA-2", "--text", "--trim"]);
    expect(calls(m, "send")).toHaveLength(1);
  });

  test("Send as a file puts it beside the chat's terminal by its address here", async () => {
    const d = live("chat-remote");
    d.shared = {
      ...d.shared,
      [ATTACH]: addChip(undefined, "macmini/tb5", { ...chip("PLA-2", "x".repeat(9000)), mode: "file" }, [
        "macmini/tb5",
      ]),
    };
    d.exec = bw({ feed: () => out(golden("codex-question", "t5", CODEX_PATH)) });
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: d });
    expect(byId(m.el, "chip-PLA-2")).not.toBe(null);
    await typeAndSend(m, "go");
    expect(calls(m, "linear")).toEqual([
      { args: ["linear", "issue", "--id", "PLA-2", "--text", "--put", "macmini/t5"], on: null },
    ]);
    // The send itself runs on the chat's machine with its local address.
    expect(calls(m, "send").map((c) => [c.on, c.args[2]])).toEqual([["macmini", "t5"]]);
  });

  test("a failed text build names the issue and sends nothing", async () => {
    const m = await mount("bw-chat", {
      props: CLAUDE,
      live: data([chip("PLA-1")], {
        linear: () => ({
          code: 1,
          stdout: '{"type":"error","code":"offline","message":"Linear is unreachable"}\n',
          stderr: "",
        }),
      }),
    });
    await typeAndSend(m, "hi");
    expect(calls(m, "send")).toEqual([]);
    expect(textOf(byId(m.el, "send-note"))).toBe("Could not read PLA-1: Linear is unreachable; nothing was sent");
    expect(inspect(textarea(m).attrs.state).value).toBe("hi");
  });
});
