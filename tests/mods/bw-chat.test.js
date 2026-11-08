// bw-chat: one agent's chat, fed by `bw feed` and sent with `bw send`, both on the space's machine.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { live, mount, repo } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { wanted } from "../../shared/choice.js";
import { byId, emit, findAll, fire, inspect, layOut, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import { columnWidth, sizes } from "../../mods/bw-chat/estimate.js";
import { pollMs, sendText, targetOf, waitingText } from "../../mods/bw-chat/target.js";
import { createPictures } from "../../mods/bw-chat/pictures.js";
import { withoutEnter } from "../../mods/bw-chat/composer.js";

const CLAUDE = { terminal: "t8", machine: null, kind: "claude" };
const CODEX_REMOTE = { terminal: "macmini/t5", machine: "macmini", kind: "codex" };
const CLAUDE_PATH = "/home/test/.claude/projects/-r-alpha/3833b375-e79d-47bf-8e7e-f66cf3faab4b.jsonl";
const CLAUDE_SESSION = "3833b375-e79d-47bf-8e7e-f66cf3faab4b";
const CODEX_PATH =
  "/home/u/.codex/sessions/2026/11/07/rollout-2026-11-07T06-11-54-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl";
const CODEX_SESSION = "01a1b4a2-6731-7140-87be-4960d8a7aefe";
const DIGEST = "c3ebbf21e766d2f1";
const BW = "/home/test/.local/share/bellwether/helper/current/bw";

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);

/** A golden `bw feed` answer with the `log` line naming a terminal, a path and a cursor, as the helper prints it.
 * @param {string} name @param {string} terminal @param {string} path */
function golden(name, terminal, path) {
  const lines = readFileSync(join(repo, "tests/fixtures/feed", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  lines[0] = { ...lines[0], terminal, path, cursor: `2.fixture-${name}` };
  return lines;
}

/**
 * A fake `exec` that answers the helper's subcommands; anything else is "not installed".
 * @param {Record<string, (args: string[], on: string | null) => unknown>} handlers by subcommand
 */
function bw(handlers) {
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    const on = opts?.on ?? null;
    if (cmd === BW && handlers.install) return handlers.install(args, on);
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw")
      return { code: 127, stdout: "", stderr: "sh: no such fake" };
    const sub = args[3];
    const h = handlers[sub] ?? (sub === "version" ? () => VERSION : null);
    if (!h) return out([{ type: "error", code: "stub", message: `no ${sub} answer` }]);
    return h(args.slice(4), on);
  };
}

/** @param {any} m @param {string} sub */
const calls = (m, sub) => m.log.exec.filter(([c, a]) => c === "sh" && HELPER_SCRIPTS.includes(a[1]) && a[3] === sub);
/** @param {any} m */
const list = (m) => findAll(m.el, (e) => e.tag === "VirtualList")[0] ?? null;
/** Pictures drawn from bw picture's copies (the header's program icon is an image too). @param {any} el */
const drawn = (el) => findAll(el, (e) => e.tag === "image" && String(e.attrs.path).startsWith("data/"));
/** @param {any} m */
const textarea = (m) => findAll(m.el, (e) => e.tag === "Textarea")[0];
/** Wakes the poll loop's newest sleep and runs it to its next one. @param {any} m */
async function nextPoll(m) {
  m.cx.sleeps.at(-1).wake();
  await m.cx.flush();
  return m.render();
}
/** Types `text` and presses Enter, as the box reports them. @param {any} m @param {string} text */
async function typeAndSend(m, text) {
  const state = textarea(m).attrs.state;
  inspect(state).value = text;
  await emit(state, "change", {}, m.cx);
  inspect(state).value = `${text}\n`;
  await emit(state, "change", {}, m.cx);
  await emit(state, "submit", { shift: false }, m.cx);
  await m.cx.flush();
  return m.render();
}

describe("target", () => {
  test("props name the terminal; local drops the machine; anything else is null", () => {
    expect(targetOf(CODEX_REMOTE)).toEqual({ machine: "macmini", terminal: "macmini/t5", local: "t5", kind: "codex" });
    expect(targetOf({ terminal: "t5", machine: "macmini", kind: "codex" })).toEqual({
      machine: "macmini",
      terminal: "macmini/t5",
      local: "t5",
      kind: "codex",
    });
    expect(targetOf(CLAUDE)).toEqual({ machine: null, terminal: "t8", local: "t8", kind: "claude" });
    expect(targetOf({})).toBe(null);
    expect(targetOf({ terminal: "t8", kind: "vim" })).toBe(null);
    expect(targetOf(null)).toBe(null);
  });

  test("poll intervals, waiting and send texts", () => {
    expect([pollMs(true), pollMs(false)]).toEqual([2000, 10000]);
    expect(waitingText("no_terminal", "Claude")).toBe("Claude exited");
    expect(waitingText("no_core", "Codex", "macmini")).toBe("Herdr's core on macmini is not answering");
    expect(waitingText("not_agent", "Codex")).toBe("This terminal runs no Claude or Codex");
    expect(waitingText("no_log", "Codex")).toBe("Waiting for Codex's session log");
    expect(sendText("refused-prompt", "Claude")).toBe(
      "Not sent: Claude is waiting on a prompt. Answer it in the terminal (⌘J).",
    );
    expect(sendText("refused-conversation", "Claude")).toBe("Not sent: this terminal now shows another conversation.");
    expect(sendText("unconfirmed", "Claude")).toBe(
      "Sent, but Herdr did not confirm it in time. Check the terminal (⌘J).",
    );
    expect(sendText("failed", "Claude", "terminal t8 is gone")).toBe("Not sent: terminal t8 is gone");
  });

  test("withoutEnter drops the line Enter put in before it reported the submit", () => {
    expect(withoutEnter("hi\n", "hi")).toBe("hi");
    expect(withoutEnter("a\nb", "ab")).toBe("ab");
    expect(withoutEnter("a\n\nb", "a\nb")).toBe("a\nb");
    expect(withoutEnter("same", "same")).toBe("same");
  });
});

/** chat-tab.json as a Herdr window on macmini sees it: macmini's space is local, this Mac's is `macbook/`. */
function fromMacmini() {
  const data = live("chat-tab");
  const book = (/** @type {string | null} */ id) => (id === null ? null : `macbook/${id}`);
  const mini = (/** @type {string | null} */ id) => (id === null ? null : id.replace(/^macmini\//, ""));
  data.spaces = data.spaces.map((sp) =>
    sp.machine === "macmini"
      ? { ...sp, id: mini(sp.id), machine: null, tabs: sp.tabs.map((t) => ({ ...t, id: mini(t.id) })) }
      : { ...sp, id: book(sp.id), machine: "macbook", tabs: sp.tabs.map((t) => ({ ...t, id: book(t.id) })) },
  );
  data.panes = data.panes.map((p) =>
    p.pane.startsWith("macmini/")
      ? { ...p, pane: mini(p.pane), tab: mini(p.tab), terminal: mini(p.terminal) }
      : { ...p, pane: book(p.pane), tab: book(p.tab), terminal: book(p.terminal) },
  );
  data.shared = { "bw.window-id": "w-mini" };
  return data;
}

/** A second Codex chat tab on this Mac whose terminal has macmini's chat's address, t5. @param {Record<string, any>} data */
function withLocalT5Chat(data) {
  const codex = data.panes.find((/** @type {any} */ p) => p.terminal === "macmini/t5");
  data.spaces[0].tabs.push({ ...data.spaces[0].tabs[0], id: "tb40", name: "Codex", active: false });
  data.panes.push(
    { ...codex, pane: "p40", tab: "tb40", terminal: "t5" },
    { pane: "p41", terminal: null, mod: "bw-chat", tab: "tb40", title: "bw-chat", focused: false, zoomed: false },
  );
  return data;
}

/** @param {Record<string, any>} data */
const recording = (data) => {
  data.exec = bw({
    feed: () => out([{ type: "state", state: "no_log", agent: null, message: "" }]),
    send: () => out([{ type: "send", result: "sent", message: "" }]),
  });
  return data;
};
/** Where the chat read its feed: [on, --terminal]. @param {any} m */
const fedFrom = (m) => calls(m, "feed").map(([, a, o]) => [o.on, a[5]]);

describe("chat target", () => {
  const BOOK = "w-book";
  test("the window that made the chat: its props name the terminal, even when machines reuse the address", async () => {
    const data = recording(withLocalT5Chat(live("chat-tab")));
    data.shared["bw.window-id"] = BOOK;
    const local = await mount("bw-chat", {
      props: { terminal: "t5", machine: null, kind: "codex", window: BOOK },
      live: data,
    });
    expect(fedFrom(local)).toEqual([[null, "t5"]]);
    await typeAndSend(local, "hi");
    expect(calls(local, "send").map(([, a, o]) => [o.on, a[5]])).toEqual([[null, "t5"]]);
  });

  test("a remote space in the window that made it reads on that machine, beside a local t5 chat", async () => {
    const data = recording(withLocalT5Chat(live("chat-tab")));
    data.shared["bw.window-id"] = BOOK;
    const m = await mount("bw-chat", { props: { ...CODEX_REMOTE, window: BOOK }, live: data });
    expect(fedFrom(m)).toEqual([["macmini", "t5"]]);
    expect(textOf(byId(m.el, "chat-header"))).toContain("macmini");
  });

  test("a second window on the other machine finds the chat's own tab: machine prefixes swapped", async () => {
    const codex = await mount("bw-chat", { props: { ...CODEX_REMOTE, window: BOOK }, live: recording(fromMacmini()) });
    expect(fedFrom(codex)).toEqual([[null, "t5"]]);
    expect(textOf(byId(codex.el, "chat-header"))).not.toContain("macmini");
    await typeAndSend(codex, "hi");
    expect(calls(codex, "send").map(([, a, o]) => [o.on, a[5]])).toEqual([[null, "t5"]]);

    const claude = await mount("bw-chat", { props: { ...CLAUDE, window: BOOK }, live: recording(fromMacmini()) });
    expect(fedFrom(claude)).toEqual([["macbook", "t8"]]);
    expect(textOf(byId(claude.el, "chat-header"))).toContain("macbook");
  });

  test("an unrelated terminal with the same address is never the target", async () => {
    // macmini made this Codex chat in its own space; this Mac sees it as macmini/t5 and has its own t5.
    const data = recording(live("chat-remote"));
    data.spaces[0].tabs.push({ ...data.spaces[0].tabs[0], id: "tb40", active: false });
    data.panes.push({
      ...data.panes.find((/** @type {any} */ p) => p.terminal === "macmini/t5"),
      pane: "p40",
      tab: "tb40",
      terminal: "t5",
    });
    const m = await mount("bw-chat", {
      props: { terminal: "t5", machine: null, kind: "codex", window: "w-mini" },
      live: data,
    });
    expect(fedFrom(m)).toEqual([["macmini", "t5"]]);

    const unrelated = fromMacmini();
    unrelated.spaces[0].tabs.push({ ...unrelated.spaces[0].tabs[0], id: "tb40", active: false });
    unrelated.panes.push({
      ...unrelated.panes.find((/** @type {any} */ p) => p.terminal === "macbook/t8"),
      pane: "p40",
      tab: "tb40",
      terminal: "t8",
    });
    const n = await mount("bw-chat", { props: { ...CLAUDE, window: BOOK }, live: recording(unrelated) });
    expect(fedFrom(n)).toEqual([["macbook", "t8"]]);
  });

  test("two chat tabs that could be it: named, nothing read or sent", async () => {
    // Seen from macmini, this Mac's Codex chat on t5 and macmini's own on t5 both match.
    const data = fromMacmini();
    data.spaces[0].tabs.push({ ...data.spaces[0].tabs[0], id: "macbook/tb40", active: false });
    data.panes.push(
      {
        ...data.panes.find((/** @type {any} */ p) => p.terminal === "t5"),
        pane: "macbook/p40",
        tab: "macbook/tb40",
        terminal: "macbook/t5",
      },
      {
        pane: "macbook/p41",
        terminal: null,
        mod: "bw-chat",
        tab: "macbook/tb40",
        title: "bw-chat",
        focused: false,
        zoomed: false,
      },
    );
    const m = await mount("bw-chat", {
      props: { terminal: "t5", machine: null, kind: "codex", window: BOOK },
      live: recording(data),
    });
    expect(textOf(byId(m.el, "chat-state"))).toContain("Chat target not found");
    expect(textarea(m).attrs.disabled).toBe(true);
    await typeAndSend(m, "hi");
    expect(calls(m, "feed")).toHaveLength(0);
    expect(calls(m, "send")).toHaveLength(0);
    expect(byId(m.el, "show-terminal")).toBe(null);
  });

  test("a terminal of the other agent in the chat's tab is not its target", async () => {
    const data = recording(live("chat-tab"));
    const m = await mount("bw-chat", { props: { terminal: "t8", machine: null, kind: "codex" }, live: data });
    expect(calls(m, "feed")).toHaveLength(0);
    expect(textOf(m.el)).toContain("Chat target not found");
  });
});

describe("pictures", () => {
  const rows = [
    {
      k: "tools",
      id: "r1",
      pics: [{ digest: "a".repeat(16), format: "png", width: 2, height: 1, offset: 9, index: 0 }],
    },
    {
      k: "user",
      id: "r2",
      pics: [
        { digest: "b".repeat(16), format: "jpeg", width: 1, height: 1, offset: 20, index: 1 },
        { digest: "a".repeat(16), format: "png", width: 2, height: 1, offset: 9, index: 0 },
      ],
    },
  ];

  test("newest first, one in flight, one try per digest", () => {
    const p = createPictures();
    expect(p.wanted(rows).map((x) => x.digest)).toEqual(["b".repeat(16), "a".repeat(16)]);
    p.start("b".repeat(16));
    expect(p.stateOf("b".repeat(16))).toBe("loading");
    expect(p.wanted(rows)).toEqual([]);
    p.done("b".repeat(16), { ok: false, state: "unreachable", message: "offline" });
    expect(p.stateOf("b".repeat(16))).toBe("failed");
    expect(p.wanted(rows).map((x) => x.digest)).toEqual(["a".repeat(16)]);
    p.start("a".repeat(16));
    p.done("a".repeat(16), {
      ok: true,
      lines: [
        { type: "picture", digest: "a".repeat(16), file: `data/bellwether/pictures/${"a".repeat(16)}.png`, bytes: 10 },
      ],
    });
    expect(p.fileOf("a".repeat(16))).toBe(`data/bellwether/pictures/${"a".repeat(16)}.png`);
    expect(p.wanted(rows)).toEqual([]);
  });

  test("too big keeps its size; a file outside the pictures folder is never drawn", () => {
    const p = createPictures();
    const d = "c".repeat(16);
    p.start(d);
    p.done(d, { ok: true, lines: [{ type: "picture", digest: d, state: "too_big", bytes: 5347738 }] });
    expect([p.stateOf(d), p.bytesOf(d)]).toEqual(["too_big", 5347738]);
    const e = "d".repeat(16);
    p.start(e);
    p.done(e, { ok: true, lines: [{ type: "picture", digest: e, file: "/etc/passwd", bytes: 1 }] });
    expect([p.fileOf(e), p.stateOf(e)]).toEqual([null, "failed"]);
  });
});

describe("bw-chat", () => {
  test("the fixtures' feed answers are the goldens", () => {
    const answer = (/** @type {any} */ data, /** @type {string} */ t) =>
      data.exec.find((e) => e.argsInclude.includes("feed") && e.argsInclude.includes(t)).result.stdout;
    const text = (/** @type {object[]} */ lines) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    expect(answer(live("chat-tab"), "t8")).toBe(text(golden("claude-picture", "t8", CLAUDE_PATH)));
    expect(answer(live("chat-tab"), "t5")).toBe(text(golden("codex-question", "t5", CODEX_PATH)));
    expect(answer(live("chat-remote"), "t5")).toBe(text(golden("codex-question", "t5", CODEX_PATH)));
  });

  test("renders a golden: bubble, markdown, tool sentence, changed line", async () => {
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-tab") });
    const text = textOf(m.el);
    expect(text).toContain("Call request_user_input once to ask me one question");
    expect(text).toContain("Wrote `blue` to colour.txt.");
    expect(text).toContain("Edited files");
    expect(text).toContain("Changed 1 file · Open in Changes");
    // Tool lines and the changed-files line are 28 px Surface 0 chips; Open in Changes is Mauve.
    const chips = findAll(m.el, (e) => e.attrs.rounded === 14 && e.attrs.bg === "#raised" && e.attrs.h === 28);
    expect(chips.map((c) => textOf(c))).toContain("Edited files");
    expect(chips.some((c) => textOf(c) === "Changed 1 file · Open in Changes")).toBe(true);
    expect(
      findAll(m.el, (e) => e.attrs.text_color === "#accent" && textOf(e) === "Open in Changes").length,
    ).toBeGreaterThan(0);
    expect(text).toContain("06:12 · Worked 8s · 1 tool");
    const bubble = findAll(m.el, (e) => e.attrs.rounded === 16 && textOf(e).includes("Call request_user_input once"));
    expect(bubble).toHaveLength(1);
    expect(bubble[0].attrs.max_w).toBe(Math.floor(columnWidth(0) * 0.8));
    const rows = golden("codex-question", "t5", CODEX_PATH).filter((l) => l.type === "row");
    expect(list(m).attrs.keys).toEqual(rows.map((r) => r.id));
    expect(list(m).attrs.sizes).toEqual(sizes(rows, columnWidth(0)));
    fire(list(m), "on_item_click", "c-cx@24227", m.cx);
    expect(m.log.run).toEqual([["layout.select", { stack: "right-body", child: "changes" }]]);
  });

  test("a bubble's text wraps afresh after its pane narrows and widens", async () => {
    // A bubble has no width of its own: Herdr sizes it from its TextView, whose state keeps the width it
    // last wrapped at. Under the same id, a bubble drawn narrow stayed narrow when the pane widened,
    // while its row took the wide height, so its text was cut.
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-tab") });
    const bubbleAt = async (/** @type {number} */ width) => {
      await fire(byId(m.el, "chat-root"), "on_size_change", { width, height: 900 }, m.cx);
      const bubble = findAll(
        m.render(),
        (e) => e.attrs.rounded === 16 && textOf(e).includes("Call request_user_input once"),
      );
      expect(bubble).toHaveLength(1);
      const views = findAll(bubble[0], (e) => e.tag === "TextView");
      expect(views.length).toBeGreaterThan(0);
      return { w: bubble[0].attrs.max_w, ids: views.map((v) => v.attrs.id) };
    };
    const wide = await bubbleAt(800);
    const narrow = await bubbleAt(420);
    const again = await bubbleAt(800);
    expect([wide.w, narrow.w]).toEqual([Math.floor(columnWidth(800) * 0.8), Math.floor(columnWidth(420) * 0.8)]);
    expect(narrow.ids.some((id) => wide.ids.includes(id))).toBe(false);
    expect(again.ids.some((id) => narrow.ids.includes(id))).toBe(false);
    // The same width keeps the same view, so a re-render (a poll) keeps its selection.
    expect(again).toEqual(wide);
    // A pane under 288 px once kept a 240 px column and cut the bubble at the pane's edge.
    const tiny = await bubbleAt(200);
    expect(tiny.w).toBe(Math.floor(152 * 0.8));
  });

  test("Open in Changes keeps Changes chosen when the space had Browser stored", async () => {
    const data = live("chat-tab");
    data.shared["bw.right.tab"] = { s1: "browser" };
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: data });
    fire(list(m), "on_item_click", "c-cx@24227", m.cx);
    expect(m.log.run).toEqual([["layout.select", { stack: "right-body", child: "changes" }]]);
    expect(fake.shared["bw.right.tab"]).toEqual({ s1: "changes" });
    // bw-right's next render would select whatever is stored for the shown space.
    expect(wanted(fake.shared["bw.right.tab"], "s1", "changes")).toBe(null);
  });

  test("header: program icon, name, branch, machine tag and the ⌘J hint", async () => {
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-tab") });
    const header = byId(m.el, "chat-header");
    expect(header.attrs.h).toBe(36);
    expect(textOf(header)).toContain("Codex");
    expect(textOf(header)).toContain("main");
    expect(textOf(header)).toContain("macmini");
    expect(findAll(header, (e) => e.tag === "svg" && e.attrs.path === "icons/codex.svg")).toHaveLength(1);
    await m.click("flip");
    expect(m.log.run).toEqual([["bw-tabs.chat-flip"]]);
    const local = await mount("bw-chat", { props: CLAUDE, live: live("chat-tab") });
    expect(textOf(byId(local.el, "chat-header"))).not.toContain("macmini");
  });

  test("tool line expands on click to its calls, one 22 px line each", async () => {
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-tab") });
    const i = list(m).attrs.keys.indexOf("tools-cx@20438");
    const closed = list(m).attrs.sizes[i];
    expect(textOf(m.el)).not.toContain("/scratch/codex-question/colour.txt");
    fire(list(m), "on_item_click", "tools-cx@20438", m.cx);
    m.render();
    expect(list(m).attrs.sizes[i]).toBe(closed + 22);
    expect(textOf(m.el)).toContain("/scratch/codex-question/colour.txt");
    const line = findAll(m.el, (e) => e.attrs.id === "call-tools-cx@20438-0")[0];
    expect(line.attrs.h).toBe(22);
    fire(list(m), "on_item_click", "tools-cx@20438", m.cx);
    m.render();
    expect(list(m).attrs.sizes[i]).toBe(closed);
  });

  test("remote chat feeds and sends there with the local address", async () => {
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-remote") });
    const feeds = calls(m, "feed");
    expect(feeds).toHaveLength(1);
    expect(feeds[0][2]).toEqual({ on: "macmini" });
    expect(feeds[0][1].slice(4)).toEqual(["--terminal", "t5", "--pictures", "--tree", "--cards"]);
    expect(textarea(m).attrs.disabled).toBe(false);
    await typeAndSend(m, "hi");
    const sends = calls(m, "send");
    expect(sends).toHaveLength(1);
    // hc wraps text sent from another core as `<hc from=…>`, so the send runs in macmini's own core.
    expect(sends[0][2]).toEqual({ on: "macmini" });
    expect(sends[0][1].slice(4)).toEqual([
      "--terminal",
      "t5",
      "--expect-kind",
      "codex",
      "--expect-session",
      CODEX_SESSION,
      "--expect-path",
      CODEX_PATH,
      "--text",
      "hi",
    ]);
    expect(inspect(textarea(m).attrs.state).value).toBe("");
    await nextPoll(m);
    expect(calls(m, "feed").at(-1)[1].slice(4)).toEqual([
      "--terminal",
      "t5",
      "--pictures",
      "--tree",
      "--cards",
      "--cursor",
      "2.fixture-codex-question",
    ]);
  });

  test("named send results; text kept on refusal; slash commands go as typed", async () => {
    const results = [
      out([{ type: "send", result: "refused-prompt", message: "blocked" }]),
      out([{ type: "send", result: "refused-conversation", message: "other session" }]),
      out([{ type: "error", code: "no_terminal", message: "terminal t8 is gone" }]),
      out([{ type: "send", result: "unconfirmed", message: "" }]),
      out([{ type: "send", result: "sent", message: "" }]),
    ];
    const data = live("chat-tab");
    data.exec = bw({
      feed: () => out(golden("claude-picture", "t8", CLAUDE_PATH)),
      picture: () => out([{ type: "picture", digest: DIGEST, state: "gone" }]),
      send: () => results.shift(),
    });
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    const value = () => inspect(textarea(m).attrs.state).value;
    const note = () => textOf(byId(m.el, "send-note"));

    await typeAndSend(m, "hello");
    expect(note()).toBe("Not sent: Claude is waiting on a prompt. Answer it in the terminal (⌘J).");
    expect(value()).toBe("hello");
    await typeAndSend(m, "hello");
    expect(note()).toBe("Not sent: this terminal now shows another conversation.");
    expect(value()).toBe("hello");
    await typeAndSend(m, "hello");
    expect(note()).toBe("Not sent: terminal t8 is gone");
    expect(value()).toBe("hello");
    await typeAndSend(m, "hello");
    expect(note()).toBe("Sent, but Herdr did not confirm it in time. Check the terminal (⌘J).");
    expect(value()).toBe("");
    await typeAndSend(m, "/compact keep the tests");
    expect(calls(m, "send").at(-1)[1].at(-1)).toBe("/compact keep the tests");
    expect(calls(m, "send").at(-1)[1].slice(4, 10)).toEqual([
      "--terminal",
      "t8",
      "--expect-kind",
      "claude",
      "--expect-session",
      CLAUDE_SESSION,
    ]);
    expect(value()).toBe("");
    expect(calls(m, "send")).toHaveLength(5);
  });

  test("Shift-Enter only reports the new line; an empty box sends nothing", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: live("chat-tab") });
    const state = textarea(m).attrs.state;
    inspect(state).value = "a\nb";
    await emit(state, "submit", { shift: true }, m.cx);
    inspect(state).value = "   ";
    await emit(state, "submit", { shift: false }, m.cx);
    await m.cx.flush();
    expect(calls(m, "send")).toHaveLength(0);
  });

  test("hidden chat polls every 10 s, shown every 2 s; showing it again reads at once", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: live("chat-tab") });
    const ms = () => m.cx.sleeps.at(-1).ms;
    expect(ms()).toBeGreaterThan(1900);
    expect(ms()).toBeLessThanOrEqual(2000);

    // ⌘J: the terminal zoomed over the chat, which now counts as hidden.
    fake.panes = fake.panes.map((p) =>
      p.pane === "p9"
        ? { ...p, zoomed: false, focused: false }
        : p.pane === "p8"
          ? { ...p, zoomed: true, focused: true }
          : p,
    );
    m.render();
    await m.cx.flush();
    expect(calls(m, "feed")).toHaveLength(2);
    expect(ms()).toBeGreaterThan(9900);
    expect(ms()).toBeLessThanOrEqual(10000);
    m.render();
    await m.cx.flush();
    expect(calls(m, "feed")).toHaveLength(2);

    fake.panes = fake.panes.map((p) =>
      p.pane === "p9" ? { ...p, zoomed: true } : p.pane === "p8" ? { ...p, zoomed: false } : p,
    );
    m.render();
    await m.cx.flush();
    expect(calls(m, "feed")).toHaveLength(3);
    expect(ms()).toBeLessThanOrEqual(2000);

    const remote = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-tab") });
    expect(remote.cx.sleeps.at(-1).ms).toBeGreaterThan(9900);
  });

  test("hidden with no render, as Herdr leaves a hidden copy, the loop backs off to 10 s from bw-tabs's list", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: live("chat-tab") });
    const ms = () => m.cx.sleeps.at(-1).ms;
    expect(ms()).toBeLessThanOrEqual(2000);

    // bw-tabs, which stays on screen, stores the chat panes it sees shown; this copy draws nothing meanwhile.
    fake.shared["bw.chat-shown"] = [];
    m.cx.sleeps.at(-1).wake();
    await m.cx.flush();
    expect(ms()).toBeGreaterThan(9900);

    fake.shared["bw.chat-shown"] = ["p9"];
    m.cx.sleeps.at(-1).wake();
    await m.cx.flush();
    expect(ms()).toBeLessThanOrEqual(2000);
  });

  test("in a layout without bw-tabs a stale shown list is ignored and render decides", async () => {
    const d = live("chat-tab");
    // Left behind by bw-tabs in Bellwether while this chat was hidden; Herdr's main layout has no bw-tabs.
    d.shared["bw.chat-shown"] = [];
    d.layout = { id: "root", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }] };
    const m = await mount("bw-chat", { props: CLAUDE, live: d });
    m.cx.sleeps.at(-1).wake();
    await m.cx.flush();
    expect(m.cx.sleeps.at(-1).ms).toBeLessThanOrEqual(2000);
  });

  test("terminal gone is named, composer disabled, Close tab", async () => {
    const data = live("chat-tab");
    data.panes = data.panes.filter((p) => p.pane !== "p8");
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    expect(textOf(m.el)).toContain("Claude exited");
    expect(textarea(m).attrs.disabled).toBe(true);
    expect(byId(m.el, "flip")).toBe(null);
    await typeAndSend(m, "still there?");
    expect(calls(m, "send")).toHaveLength(0);
    await m.click("close-tab");
    expect(m.log.run).toEqual([["tab.close", { id: "tb8" }]]);

    const stated = live("chat-tab");
    stated.exec = bw({ feed: () => out([{ type: "state", state: "no_terminal", message: "t8 is not in this core" }]) });
    const n = await mount("bw-chat", { props: CLAUDE, live: stated });
    expect(textOf(byId(n.el, "chat-state"))).toContain("Claude exited");
    expect(byId(n.el, "close-tab")).not.toBe(null);
    expect(textarea(n).attrs.disabled).toBe(true);
  });

  test("a fresh chat sends its first message with no session; the composer turns on with no log", async () => {
    let answer = out([{ type: "state", state: "no_log", agent: "codex", message: "no codex session log yet" }]);
    const data = live("chat-remote");
    data.exec = bw({ feed: () => answer, send: () => out([{ type: "send", result: "sent", message: "" }]) });
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: data });
    expect(textOf(m.el)).toContain("No messages yet. Send the first one below.");
    expect(textarea(m).attrs.disabled).toBe(false);
    await typeAndSend(m, "--first");
    const sends = calls(m, "send");
    expect(sends).toHaveLength(1);
    expect(sends[0][2]).toEqual({ on: "macmini" });
    expect(sends[0][1].slice(4)).toEqual([
      "--terminal",
      "t5",
      "--expect-kind",
      "codex",
      "--expect-session",
      "none",
      "--expect-path",
      "none",
      "--text",
      "--first",
    ]);

    answer = out(golden("codex-question", "t5", CODEX_PATH));
    await nextPoll(m);
    expect(byId(m.el, "chat-state")).toBe(null);
    expect(textarea(m).attrs.disabled).toBe(false);
    await typeAndSend(m, "next");
    expect(calls(m, "send").at(-1)[1].slice(8, 12)).toEqual([
      "--expect-session",
      CODEX_SESSION,
      "--expect-path",
      CODEX_PATH,
    ]);
  });

  test("once a conversation was shown, no log disables the composer and nothing sends with none", async () => {
    // Claude `/clear` or Codex `/new`: the new conversation has no log yet and the chat still shows the old one.
    let answer = out(golden("codex-question", "t5", CODEX_PATH));
    const data = live("chat-remote");
    data.exec = bw({ feed: () => answer });
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: data });
    answer = out([{ type: "state", state: "no_log", agent: "codex", message: "no codex session log yet" }]);
    await nextPoll(m);
    expect(textOf(byId(m.el, "chat-notice"))).toContain("Waiting for Codex's session log");
    expect(textarea(m).attrs.disabled).toBe(true);
    await typeAndSend(m, "hi");
    expect(calls(m, "send")).toHaveLength(0);
  });

  test("after /new the feed names the new session: old rows go, its first message expects that session", async () => {
    let answer = out(golden("codex-question", "t5", CODEX_PATH));
    const data = live("chat-remote");
    data.exec = bw({ feed: () => answer, send: () => out([{ type: "send", result: "sent", message: "" }]) });
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: data });
    await typeAndSend(m, "/new");
    expect(calls(m, "send").at(-1)[1].slice(8, 12)).toEqual([
      "--expect-session",
      CODEX_SESSION,
      "--expect-path",
      CODEX_PATH,
    ]);
    const NEXT = "019a0000-0000-7000-8000-000000000002";
    answer = out([
      { type: "state", state: "no_log", agent: "codex", message: "no codex session log yet", session: NEXT },
    ]);
    await nextPoll(m);
    expect(textOf(m.el)).not.toContain("Wrote `blue` to colour.txt.");
    expect(textOf(m.el)).toContain("No messages yet. Send the first one below.");
    expect(byId(m.el, "chat-notice")).toBe(null);
    expect(textarea(m).attrs.disabled).toBe(false);
    await typeAndSend(m, "first of the new one");
    expect(calls(m, "send")).toHaveLength(2);
    expect(calls(m, "send").at(-1)[1].slice(4)).toEqual([
      "--terminal",
      "t5",
      "--expect-kind",
      "codex",
      "--expect-session",
      NEXT,
      "--expect-path",
      "none",
      "--text",
      "first of the new one",
    ]);
    expect(calls(m, "feed").at(-1)[1].slice(4)).toEqual(["--terminal", "t5", "--pictures", "--tree", "--cards"]);
  });

  test("a feed state other than no log names the wait and disables the composer", async () => {
    for (const [state, agent, shown] of [
      ["not_agent", null, "This terminal runs no Claude or Codex"],
      ["no_log", "claude", "Waiting for Codex's session log"],
    ]) {
      const data = live("chat-remote");
      data.exec = bw({ feed: () => out([{ type: "state", state, agent, message: "" }]) });
      const m = await mount("bw-chat", { props: CODEX_REMOTE, live: data });
      expect(textOf(byId(m.el, "chat-state"))).toContain(String(shown));
      expect(textarea(m).attrs.disabled).toBe(true);
      await m.click("show-terminal");
      expect(m.log.run).toEqual([["bw-tabs.chat-flip"]]);
      await typeAndSend(m, "hi");
      expect(calls(m, "send")).toHaveLength(0);
    }
  });

  test("helper missing here is named; on macmini it installs and says so", async () => {
    const here = live("chat-tab");
    here.exec = async () => ({ code: 127, stdout: "", stderr: "sh: no such file" });
    const m = await mount("bw-chat", { props: CLAUDE, live: here });
    expect(textOf(byId(m.el, "chat-state"))).toContain("Bellwether's helper is missing on this Mac");
    expect(byId(m.el, "show-terminal")).not.toBe(null);

    /** @type {(r: unknown) => void} */
    let finish = () => {};
    let installed = false;
    const remote = live("chat-remote");
    remote.exec = bw({
      version: (_a, on) => (on === "macmini" && !installed ? { code: 127, stdout: "", stderr: "" } : VERSION),
      install: () =>
        new Promise((r) => {
          finish = r;
        }),
      feed: () => out(golden("codex-question", "t5", CODEX_PATH)),
    });
    const n = await mount("bw-chat", { props: CODEX_REMOTE, live: remote });
    expect(textOf(byId(n.el, "chat-state"))).toContain("Setting up Bellwether on macmini");
    installed = true;
    finish(out([{ type: "install", machine: "macmini", result: "installed" }]));
    await n.cx.flush();
    n.render();
    expect(byId(n.el, "chat-state")).toBe(null);
    expect(textOf(n.el)).toContain("Changed 1 file");
  });

  test("an unreachable machine keeps the rows and says so", async () => {
    let offline = false;
    const data = live("chat-remote");
    data.exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      if (offline && opts?.on === "macmini") throw new Error("macmini is offline");
      return bw({ feed: () => out(golden("codex-question", "t5", CODEX_PATH)) })(cmd, args, opts);
    };
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: data });
    offline = true;
    await nextPoll(m);
    expect(textOf(m.el)).toContain("Wrote `blue` to colour.txt.");
    expect(textOf(byId(m.el, "chat-notice"))).toContain("macmini is not answering");
  });

  test("pictures: one fetch per digest, named placeholders", async () => {
    /** @type {(r: unknown) => void} */
    let finish = () => {};
    const data = live("chat-tab");
    data.exec = bw({
      feed: () => out(golden("claude-picture", "t8", CLAUDE_PATH)),
      picture: () =>
        new Promise((r) => {
          finish = r;
        }),
    });
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    const pics = calls(m, "picture");
    expect(pics).toHaveLength(1);
    expect(pics[0][2]).toEqual({ on: null });
    expect(pics[0][1].slice(4)).toEqual(["--terminal", "t8", "--offset", "26350", "--index", "0", "--digest", DIGEST]);
    expect(textOf(m.el)).toContain("Loading picture…");
    finish(out([{ type: "picture", digest: DIGEST, state: "too_big", bytes: Math.round(5.1 * 1024 * 1024) }]));
    await m.cx.flush();
    m.render();
    expect(textOf(m.el)).toContain("Picture too large (5.1 MB)");
    await nextPoll(m);
    await nextPoll(m);
    expect(calls(m, "picture")).toHaveLength(1);
    expect(drawn(m.el)).toHaveLength(0);

    for (const [answer, shown] of /** @type {[unknown, string][]} */ ([
      [out([{ type: "picture", digest: DIGEST, state: "gone" }]), "Picture unavailable"],
      [out([{ type: "picture", digest: DIGEST, state: "unreachable" }]), "Picture unavailable"],
      [out([{ type: "error", code: "io", message: "disk full" }]), "Picture unavailable"],
    ])) {
      const d = live("chat-tab");
      d.exec = bw({ feed: () => out(golden("claude-picture", "t8", CLAUDE_PATH)), picture: () => answer });
      const n = await mount("bw-chat", { props: CLAUDE, live: d });
      expect(textOf(n.el)).toContain(shown);
      expect(drawn(n.el)).toHaveLength(0);
    }

    const ok = await mount("bw-chat", { props: CLAUDE, live: live("chat-tab") });
    const img = drawn(ok.el);
    expect(img.map((e) => e.attrs.path)).toEqual([`data/bellwether/pictures/${DIGEST}.png`]);
    expect(img[0].attrs.h).toBeLessThanOrEqual(320);
  });

  test("a running call is a neutral line; a call the agent waits on names it, with no answer button", async () => {
    const perm = {
      type: "row",
      k: "perm",
      id: "perm-tu1",
      text: "Wants to run a command",
      perm: {
        title: "Wants to run a command",
        command: "rm -rf build",
        tool: "Bash",
        toolUseId: "tu1",
        state: "pending",
      },
    };
    const lines = [...golden("claude-approval", "t8", CLAUDE_PATH).filter((l) => l.k !== "footer"), perm];
    lines[1] = { ...lines[1], count: lines.length - 2 };
    const data = live("chat-tab");
    data.exec = bw({ feed: () => out(lines) });
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    expect(textOf(m.el)).toContain("Running · rm -rf build");
    expect(textOf(m.el)).not.toContain("waiting for you");

    fake.panes = fake.panes.map((p) => (p.pane === "p8" ? { ...p, status: "blocked" } : p));
    m.render();
    expect(textOf(m.el)).toContain("Claude is waiting for you · Answer in terminal (⌘J)");
    expect(textOf(m.el)).not.toMatch(/Allow|Deny|Approve/);
    // The waiting line's mark breathes in Peach until the person answers.
    const breathing = findAll(m.el, (e) => e.attrs.loop !== undefined);
    expect(breathing.map((e) => [e.attrs.text_color, e.attrs.loop[0]])).toEqual([["#blocked", "opacity"]]);
    fire(list(m), "on_item_click", "perm-tu1", m.cx);
    expect(m.log.run).toEqual([["bw-tabs.chat-flip"]]);
  });

  test("scrolling up at the top reads older rows once", async () => {
    const head = golden("claude-approval", "t8", CLAUDE_PATH);
    head[0] = { ...head[0], start: 4096 };
    const data = live("chat-tab");
    data.exec = bw({
      feed: (args) =>
        args.includes("--before")
          ? out([
              { type: "older", path: CLAUDE_PATH, start: 0, count: 1 },
              { type: "row", k: "user", id: "old-1", text: "An older question", ts: 1 },
            ])
          : out(head),
    });
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    expect(textOf(m.el)).not.toContain("An older question");
    await fire(byId(m.el, "timeline"), "on_scroll_wheel", { delta: { x: 0, y: 40 } }, m.cx);
    await m.cx.flush();
    m.render();
    const older = calls(m, "feed").filter(([, a]) => a.includes("--before"));
    expect(older).toHaveLength(1);
    expect(older[0][1].slice(4)).toEqual(["--terminal", "t8", "--before", "4096", "--pictures"]);
    expect(list(m).attrs.keys[0]).toBe("old-1");
    await fire(byId(m.el, "timeline"), "on_scroll_wheel", { delta: { x: 0, y: 40 } }, m.cx);
    await m.cx.flush();
    expect(calls(m, "feed").filter(([, a]) => a.includes("--before"))).toHaveLength(1);
  });

  test("a scroll the chat never hears of (scrollbar drag) stops following; back at the end follows again", async () => {
    let lines = golden("claude-approval", "t8", CLAUDE_PATH);
    const data = live("chat-tab");
    data.exec = bw({ feed: () => out(lines) });
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    const scrolls = inspect(m.view.scroll).calls;
    /** The agent writes one more row; the next poll reads it. @param {string} id */
    let count = 4;
    const grow = async (id) => {
      lines = [lines[0], { type: "splice", at: count++, count: 1 }, { type: "row", k: "assistant", id, text: id }];
      await nextPoll(m);
      lines = [lines[0], { type: "unchanged" }];
    };
    const n = list(m).attrs.count;
    expect(n).toBe(4);

    layOut(list(m), { start: 0, end: 2 });
    const before = scrolls.length;
    await grow("more-1");
    expect(scrolls.slice(before)).toEqual([]);

    // Herdr also lays out one representative row each frame; that is not where the view is.
    layOut(list(m), { start: 3, end: 5 });
    layOut(list(m), { start: 0, end: 1 });
    await grow("more-2");
    expect(scrolls.slice(before)).toEqual([["item", 5, "top"]]);
  });

  test("no props renders a named state and runs nothing", async () => {
    const m = await mount("bw-chat", { props: {}, live: live("chat-tab") });
    expect(textOf(m.el)).toContain("This chat names no terminal");
    expect(m.log.exec).toEqual([]);
  });

  test("focus command focuses the composer", async () => {
    /** @type {((c: string) => void)[]} */
    const waiting = [];
    const data = live("chat-tab");
    data.nextCommand = () => new Promise((r) => waiting.push(r));
    const m = await mount("bw-chat", { props: CLAUDE, live: data });
    const state = textarea(m).attrs.state;
    expect(inspect(state).focused).toBe(0);
    expect(inspect(state).placeholder).toBe("Message Claude…");
    expect(inspect(state).autoGrow).toEqual([1, 8]);
    waiting.shift()?.("focus");
    await m.cx.flush();
    expect(inspect(state).focused).toBe(1);
  });
});
