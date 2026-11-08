// bw-chat's threads card and sub-agent views: rows from `bw feed --tree`, a child's own transcript from
// `bw feed --session`, a terminal sub-agent as a chat of its own terminal.
import { afterEach, describe, expect, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, emit, findAll, fire, inspect, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS } from "../../shared/helper.js";

const ROOT = "a9baa480-8207-4b0a-b31c-1a2d7b062db3";
const ROOT_PATH = `/home/test/.claude/projects/-r-alpha/${ROOT}.jsonl`;
const CHILD = "af5540ee6b3545d64";
const CLAUDE = { terminal: "t8", machine: null, kind: "claude" };

/** The stdout lines of the fixture's exec answer whose argsInclude is exactly `args`. @param {string[]} args */
function fixtureLines(args) {
  const e = live("chat-requests").exec.find(
    (/** @type {any} */ x) => JSON.stringify(x.argsInclude) === JSON.stringify(args),
  );
  return e.result.stdout
    .trim()
    .split("\n")
    .map((/** @type {string} */ l) => JSON.parse(l));
}
const ROOT_LINES = fixtureLines(["bw", "feed", "t8"]);
const CHILD_LINES = fixtureLines(["bw", "feed", "t8", "--session", CHILD]);

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: 7, version: "0.7.0" }]);

/** @param {Record<string, (args: string[], on: string | null) => unknown>} handlers by subcommand */
function bw(handlers) {
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw")
      return { code: 127, stdout: "", stderr: "sh: no such fake" };
    const sub = args[3];
    const h = handlers[sub] ?? (sub === "version" ? () => VERSION : null);
    if (!h) return out([{ type: "error", code: "stub", message: `no ${sub} answer` }]);
    return h(args.slice(4), opts?.on ?? null);
  };
}
/** @param {any} m @param {string} sub */
const calls = (m, sub) =>
  m.log.exec.filter((/** @type {any} */ [c, a]) => c === "sh" && HELPER_SCRIPTS.includes(a[1]) && a[3] === sub);
/** @param {any} m */
const lastFeed = (m) => calls(m, "feed").at(-1)[1].slice(4);
/** @param {any} m */
const textarea = (m) => findAll(m.el, (e) => e.tag === "Textarea")[0];
/** @param {any} m */
async function nextPoll(m) {
  m.cx.sleeps.at(-1).wake();
  await m.cx.flush();
  return m.render();
}
/** @param {any} m @param {string} text */
async function typeAndSend(m, text) {
  const state = textarea(m).attrs.state;
  inspect(state).value = text;
  await emit(state, "change", {}, m.cx);
  await emit(state, "submit", { shift: false }, m.cx);
  await m.cx.flush();
  return m.render();
}

/** Feeds the root, or the child named by --session, from the fixture's lines; `override` replaces either. */
function feeds(/** @type {{ root?: () => object[], child?: () => object[] }} */ o = {}) {
  return (/** @type {string[]} */ args) => {
    const i = args.indexOf("--session");
    if (i < 0) return out(o.root ? o.root() : ROOT_LINES);
    const lines = o.child
      ? o.child()
      : args[i + 1] === CHILD
        ? CHILD_LINES
        : [{ type: "state", state: "no_child", child: args[i + 1] }];
    // bw prints the root's tree before a child's lines, but not before the root's own state line.
    const rootState = lines.some((l) => l.type === "state" && l.state !== "no_child");
    return out(lines.some((l) => l.type === "tree") || rootState ? lines : [ROOT_LINES[0], ...lines]);
  };
}

/** @param {Record<string, any>} [handlers] */
function data(handlers = {}) {
  const d = live("chat-requests");
  d.exec = bw({ feed: feeds(), send: () => out([{ type: "send", result: "sent", message: "" }]), ...handlers });
  return d;
}

afterEach(() => {
  fake.focused = null;
});

describe("threads card", () => {
  test("threads card lists the children nested, then opens a child's transcript", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: data() });
    expect(lastFeed(m)).toEqual(["--terminal", "t8", "--pictures", "--tree", "--cards"]);
    const card = byId(m.el, "threads-card");
    expect(card).not.toBe(null);
    expect(card.attrs.w).toBe(312);
    expect("absolute" in card.attrs).toBe(true);
    expect([card.attrs.top, card.attrs.right]).toEqual([12, 12]);
    // Herdr drops an absolute element's insets when it scrolls itself, so the rows scroll in an inner box
    // capped in pixels (a percentage cap collapses it): half the pane, before and after a resize.
    expect("overflow_y_scrollbar" in card.attrs).toBe(false);
    const list = byId(card, "threads-rows");
    expect("overflow_y_scrollbar" in list.attrs).toBe(true);
    expect(list.attrs.max_h).toBe(320);
    await fire(byId(m.el, "chat-root"), "on_size_change", { width: 700, height: 900 }, m.cx);
    expect(byId(m.render(), "threads-rows").attrs.max_h).toBe(450);
    const rows = findAll(card, (e) => typeof e.attrs.id === "string" && e.attrs.id.startsWith("row-"));
    expect(rows.map((r) => r.attrs.id)).toEqual([
      "row-parent",
      `row-child-${CHILD}`,
      "row-child-ad16657758350f019",
      "row-child-a640ed49983e1482a",
      "row-terminal-t12",
    ]);
    expect(rows.every((r) => r.attrs.h === 28)).toBe(true);
    expect(rows.map((r) => r.attrs.pl)).toEqual([8, 24, 24, 40, 24]);
    expect(textOf(rows[1])).toContain("counter");
    expect(textOf(rows[1])).toContain("Count the files in the folder");
    // The pending approval of af55… is its badge.
    expect(textOf(byId(card, `badge-${CHILD}`))).toBe("1");
    expect(byId(card, "badge-ad16657758350f019")).toBe(null);
    expect(textOf(byId(m.el, "threads-button"))).toContain("4");

    await m.click(`row-child-${CHILD}`);
    expect(lastFeed(m)).toEqual(["--terminal", "t8", "--pictures", "--tree", "--cards", "--session", CHILD]);
    expect(textOf(m.el)).toContain("Count the files in the current folder");
    expect(textOf(m.el)).not.toContain("Use the Agent tool three times");
    expect(textarea(m)).toBeUndefined();
    const bar = byId(m.el, "subagent-bar");
    expect(bar.attrs.h).toBe(44);
    // af55… asks: its approval is pending.
    expect(textOf(bar)).toBe("counter · sub-agent of Claude · waiting for an answer · Back to Claude");

    // The child keeps its own cursor; the next read passes it back with --session.
    await nextPoll(m);
    expect(lastFeed(m)).toEqual([
      "--terminal",
      "t8",
      "--pictures",
      "--tree",
      "--cards",
      "--session",
      CHILD,
      "--cursor",
      "2.fixture-child",
    ]);

    await m.click("row-child-ad16657758350f019");
    expect(textOf(byId(m.el, "subagent-bar"))).toBe("nester · sub-agent of Claude · running · Back to Claude");
  });

  test("Back returns to the parent and its composer", async () => {
    const m = await mount("bw-chat", { props: CLAUDE, live: data() });
    await m.click(`row-child-${CHILD}`);
    await m.click("back");
    expect(byId(m.el, "subagent-bar")).toBe(null);
    expect(textarea(m)).toBeDefined();
    expect(textarea(m).attrs.disabled).toBe(false);
    expect(lastFeed(m)).toEqual(["--terminal", "t8", "--pictures", "--tree", "--cards", "--cursor", "2.fixture-root"]);
    await typeAndSend(m, "hi");
    expect(calls(m, "send").at(-1)[1].slice(4)).toEqual([
      "--terminal",
      "t8",
      "--expect-kind",
      "claude",
      "--expect-session",
      ROOT,
      "--expect-path",
      ROOT_PATH,
      "--text",
      "hi",
    ]);
    // The parent row is the way back too.
    await m.click("row-child-ad16657758350f019");
    await m.click("row-parent");
    expect(byId(m.el, "subagent-bar")).toBe(null);
  });

  test("a child with no log yet is named", async () => {
    const m = await mount("bw-chat", {
      props: CLAUDE,
      live: data({
        feed: feeds({
          child: () => [{ type: "state", state: "no_child", child: CHILD, message: "no log for this sub-agent yet" }],
        }),
      }),
    });
    await m.click(`row-child-${CHILD}`);
    expect(textOf(m.el)).toContain("This sub-agent has no log yet");
    expect(byId(m.el, "subagent-bar")).not.toBe(null);
  });

  test("older rows of a child read with --session and --before, never --tree", async () => {
    const lines = CHILD_LINES.map((l) => (l.type === "log" ? { ...l, start: 4096 } : l));
    const m = await mount("bw-chat", {
      props: CLAUDE,
      live: data({
        feed: (/** @type {string[]} */ args) =>
          args.includes("--before")
            ? out([
                { type: "older", path: CHILD_LINES.find((l) => l.type === "log").path, start: 0, count: 1 },
                { type: "row", k: "user", id: "old-1", text: "An older line", ts: 1 },
              ])
            : feeds({ child: () => lines })(args),
      }),
    });
    await m.click(`row-child-${CHILD}`);
    await fire(byId(m.el, "timeline"), "on_scroll_wheel", { delta: { x: 0, y: 40 } }, m.cx);
    await m.cx.flush();
    m.render();
    const older = calls(m, "feed").filter((/** @type {any} */ [, a]) => a.includes("--before"));
    expect(older.map((/** @type {any} */ c) => c[1].slice(4))).toEqual([
      ["--terminal", "t8", "--session", CHILD, "--before", "4096", "--pictures"],
    ]);
    expect(textOf(m.el)).toContain("An older line");
  });

  test("pill when nothing runs; header button toggles", async () => {
    const tree = {
      ...ROOT_LINES[0],
      children: ROOT_LINES[0].children.map((/** @type {any} */ c) => ({ ...c, state: "done" })),
    };
    const quiet = ROOT_LINES.filter((l) => l.type !== "request").map((l) => (l.type === "tree" ? tree : l));
    const d = data({ feed: feeds({ root: () => quiet }) });
    d.terminals = d.terminals.filter((/** @type {any} */ t) => t.address !== "t12");
    const m = await mount("bw-chat", { props: CLAUDE, live: d });
    expect(byId(m.el, "threads-card")).toBe(null);
    expect(textOf(byId(m.el, "threads-pill"))).toBe("3 sub-agents");
    await m.click("threads-button");
    expect(byId(m.el, "threads-card")).not.toBe(null);
    expect(byId(m.el, "threads-pill")).toBe(null);
    await m.click("threads-button");
    expect(byId(m.el, "threads-card")).toBe(null);
    await m.click("threads-pill");
    expect(byId(m.el, "threads-card")).not.toBe(null);

    // No sub-agents at all: no pill, no button.
    const none = data({
      feed: feeds({ root: () => quiet.map((l) => (l.type === "tree" ? { ...tree, children: [] } : l)) }),
    });
    none.terminals = d.terminals;
    const n = await mount("bw-chat", { props: CLAUDE, live: none });
    expect(byId(n.el, "threads-pill")).toBe(null);
    expect(byId(n.el, "threads-button")).toBe(null);
  });

  test("the user's fold holds until the running set changes", async () => {
    let lines = ROOT_LINES;
    const m = await mount("bw-chat", { props: CLAUDE, live: data({ feed: feeds({ root: () => lines }) }) });
    await m.click("threads-button");
    expect(byId(m.el, "threads-card")).toBe(null);
    await nextPoll(m);
    expect(byId(m.el, "threads-card")).toBe(null);
    lines = ROOT_LINES.filter((l) => l.type !== "request").map((l) =>
      l.type === "tree"
        ? { ...l, children: l.children.map((/** @type {any} */ c) => (c.id === CHILD ? { ...c, state: "done" } : c)) }
        : l,
    );
    await nextPoll(m);
    expect(byId(m.el, "threads-card")).not.toBe(null);
  });

  test("terminal sub-agent opens as its own chat with a composer that sends to it", async () => {
    const T12 = "2b7f0000-0000-4000-8000-000000000012";
    const T12_PATH = `/home/test/.claude/projects/-r-alpha/${T12}.jsonl`;
    const d = data({
      feed: (/** @type {string[]} */ args) =>
        args[1] === "t12"
          ? out([
              {
                type: "log",
                agent: "claude",
                terminal: "t12",
                session: T12,
                path: T12_PATH,
                start: 0,
                size: 10,
                cursor: "2.t12",
              },
              { type: "splice", at: 0, count: 1 },
              { type: "row", k: "user", id: "u12", text: "Helper's own question", ts: 1 },
              {
                type: "cards",
                terminal: "t12",
                agent: "claude",
                session: T12,
                path: T12_PATH,
                status: "working",
                status_kind: "claude",
                hooks: "ok",
                screen: "unread",
              },
            ])
          : feeds()(args),
    });
    const m = await mount("bw-chat", { props: CLAUDE, live: d });
    await m.click("row-terminal-t12");
    expect(lastFeed(m)).toEqual(["--terminal", "t12", "--pictures", "--cards"]);
    expect(textOf(m.el)).toContain("Helper's own question");
    expect(textOf(byId(m.el, "subagent-bar"))).toContain("Claude Code · sub-agent of Claude · running");
    // The parent's approval is not this terminal's: the dock shows only the requests its own poll named.
    expect(findAll(m.el, (e) => String(e.attrs.id ?? "").startsWith("card-"))).toHaveLength(0);
    expect(textarea(m).attrs.disabled).toBe(false);
    await typeAndSend(m, "go on");
    expect(calls(m, "send").at(-1)[1].slice(4)).toEqual([
      "--terminal",
      "t12",
      "--expect-kind",
      "claude",
      "--expect-session",
      T12,
      "--expect-path",
      T12_PATH,
      "--text",
      "go on",
    ]);
    await m.click("back");
    expect(lastFeed(m).slice(0, 5)).toEqual(["--terminal", "t8", "--pictures", "--tree", "--cards"]);
  });

  test("root change returns to the parent view with a notice", async () => {
    let child = CHILD_LINES;
    const m = await mount("bw-chat", { props: CLAUDE, live: data({ feed: feeds({ child: () => child }) }) });
    await m.click(`row-child-${CHILD}`);
    const NEXT = "0e0e0000-0000-4000-8000-00000000c1ea";
    // Claude /clear: the root the child view names is no longer the chat's conversation.
    child = [{ type: "state", state: "no_log", agent: "claude", message: "no claude session log yet", session: NEXT }];
    await nextPoll(m);
    expect(byId(m.el, "subagent-bar")).toBe(null);
    expect(textOf(byId(m.el, "view-note"))).toBe("This conversation ended; showing the new one");
    expect(lastFeed(m).includes("--session")).toBe(false);

    // A log line naming another root does the same.
    const n = await mount("bw-chat", {
      props: CLAUDE,
      live: data({
        feed: feeds({ child: () => CHILD_LINES.map((l) => (l.type === "log" ? { ...l, session: NEXT } : l)) }),
      }),
    });
    await n.click(`row-child-${CHILD}`);
    expect(byId(n.el, "subagent-bar")).toBe(null);
    expect(textOf(byId(n.el, "view-note"))).toBe("This conversation ended; showing the new one");
  });

  test("a new root whose log exists already (tree + no_child + cards) returns to the parent view", async () => {
    let child = CHILD_LINES;
    const m = await mount("bw-chat", { props: CLAUDE, live: data({ feed: feeds({ child: () => child }) }) });
    await m.click(`row-child-${CHILD}`);
    expect(byId(m.el, "subagent-bar")).not.toBe(null);
    const NEXT = "0e0e0000-0000-4000-8000-00000000c1ea";
    // Claude 2.1.319's /clear writes the next log at once, so bw answers for the new root without the old child.
    child = [
      { type: "tree", agent: "claude", root: NEXT, children: [] },
      { type: "state", state: "no_child", child: CHILD },
      {
        type: "cards",
        terminal: "t8",
        agent: "claude",
        session: NEXT,
        path: `/home/test/.claude/projects/-r-alpha/${NEXT}.jsonl`,
        hooks: "ok",
        screen: "read",
      },
    ];
    await nextPoll(m);
    expect(byId(m.el, "subagent-bar")).toBe(null);
    expect(textOf(byId(m.el, "view-note"))).toBe("This conversation ended; showing the new one");
    expect(lastFeed(m).includes("--session")).toBe(false);

    // A cards line alone naming another session does the same.
    child = [
      { type: "state", state: "no_child", child: CHILD },
      { type: "cards", terminal: "t8", agent: "claude", session: NEXT, path: "/n.jsonl", hooks: "ok", screen: "read" },
    ];
    const n = await mount("bw-chat", { props: CLAUDE, live: data({ feed: feeds({ child: () => child }) }) });
    await n.click(`row-child-${CHILD}`);
    expect(byId(n.el, "subagent-bar")).toBe(null);
    expect(textOf(byId(n.el, "view-note"))).toBe("This conversation ended; showing the new one");
  });
});

test("the threads card keeps 12 px each side in a narrow pane and is 312 px otherwise", async () => {
  const { cardWidth, CARD_W } = await import("../../mods/bw-chat/threads.js");
  expect(cardWidth(0)).toBe(CARD_W);
  expect(cardWidth(900)).toBe(312);
  expect(cardWidth(250)).toBe(226);
  expect(cardWidth(100)).toBe(160);
});
