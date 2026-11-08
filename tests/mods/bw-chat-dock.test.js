// bw-chat's request dock: cards from `bw feed --cards`, answers through `bw answer` on the space's machine
// behind the 3 s focus guard, and the hooks notices.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { live, mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, emit, findAll, fire, inspect, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS } from "../../shared/helper.js";

const ROOT = "a9baa480-8207-4b0a-b31c-1a2d7b062db3";
const ROOT_PATH = `/home/test/.claude/projects/-r-alpha/${ROOT}.jsonl`;
const CHILD = "af5540ee6b3545d64";
const CLAUDE = { terminal: "t8", machine: null, kind: "claude" };
const CODEX_REMOTE = { terminal: "macmini/t5", machine: "macmini", kind: "codex" };
const CODEX_SESSION = "01a1b4a2-6731-7140-87be-4960d8a7aefe";
const CODEX_PATH = `/home/u/.codex/sessions/2026/11/07/rollout-2026-11-07T06-11-54-${CODEX_SESSION}.jsonl`;
const T0 = 1794032000000;
const NO_MODS = { shift: false, control: false, alt: false, platform: false, function: false };

/** @param {string[]} args */
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
const REQUEST = ROOT_LINES.find((l) => l.type === "request");
const CARDS = ROOT_LINES.find((l) => l.type === "cards");
const WITHOUT_CARDS = ROOT_LINES.filter((l) => l.type !== "request" && l.type !== "cards");

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: 4, version: "0.4.0" }]);
/** @param {Record<string, (args: string[], on: string | null) => unknown>} handlers */
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
async function nextPoll(m) {
  m.cx.sleeps.at(-1).wake();
  await m.cx.flush();
  return m.render();
}
/** @param {any} m @param {string} id @param {string} b */
const button = (m, id, b) => byId(m.el, `answer-${id}-${b}`);
/** @param {any} m @param {string} id */
const buttonIds = (m, id) =>
  findAll(byId(m.el, `card-${id}`), (e) => String(e.attrs.id ?? "").startsWith(`answer-${id}-`)).map((e) =>
    String(e.attrs.id).slice(`answer-${id}-`.length),
  );
/** @param {any} m */
const textarea = (m) => findAll(m.el, (e) => e.tag === "Textarea")[0];

/** The chat's lines with `requests` in place of the fixture's, and `cards` merged into its cards line. */
const rootWith = (/** @type {object[]} */ requests, /** @type {object} */ cards = {}) => [
  ...WITHOUT_CARDS,
  { ...CARDS, ...cards },
  ...requests,
];

/** Mounts at T0 and moves the clock past the fresh-mount guard. */
async function ready(/** @type {any} */ props, /** @type {Record<string, any>} */ d) {
  setSystemTime(new Date(T0));
  const m = await mount("bw-chat", { props, live: d });
  setSystemTime(new Date(T0 + 3000));
  m.render();
  return m;
}

/** @param {Record<string, any>} [handlers] @param {string} [name] */
function data(handlers = {}, name = "chat-requests") {
  const d = live(name);
  d.exec = bw({
    feed: () => out(ROOT_LINES),
    answer: () => out([{ type: "answer", result: "answered", state: "answered", message: "" }]),
    ...handlers,
  });
  return d;
}

afterEach(() => {
  setSystemTime();
});

describe("dock", () => {
  test("dock shows approval under its sub-agent and Approve calls answer on the space's machine", async () => {
    const d = live("chat-remote");
    const req = {
      ...REQUEST,
      id: "r3.remote",
      command: "touch child.txt",
      who: { child: "019a-child", agent_type: "worker", description: "", depth: 1 },
      actions: [
        { id: "approve", label: "Yes, proceed" },
        { id: "always", label: "Yes, and don't ask again for touch" },
        { id: "deny", label: "No" },
      ],
    };
    const lines = [
      {
        type: "log",
        agent: "codex",
        terminal: "t5",
        session: CODEX_SESSION,
        path: CODEX_PATH,
        start: 0,
        size: 10,
        cursor: "2.c",
      },
      { type: "splice", at: 0, count: 0 },
      {
        type: "tree",
        agent: "codex",
        root: CODEX_SESSION,
        children: [
          {
            id: "019a-child",
            parent: CODEX_SESSION,
            depth: 1,
            type: "worker",
            nickname: "Hypatia",
            description: "",
            state: "running",
            started_ms: T0,
          },
        ],
      },
      { ...CARDS, terminal: "t5", agent: "codex", session: CODEX_SESSION, path: CODEX_PATH },
      req,
    ];
    d.exec = bw({
      feed: () => out(lines),
      answer: () => out([{ type: "answer", result: "answered", state: "answered", message: "" }]),
    });
    const m = await ready(CODEX_REMOTE, d);
    expect(calls(m, "feed")[0][2]).toEqual({ on: "macmini" });
    const card = byId(m.el, "card-r3.remote");
    expect(textOf(card)).toContain("Approval needed from worker");
    expect(textOf(card)).toContain("touch child.txt");
    expect(card.attrs.rounded).toBe(8);
    expect([card.attrs.px, card.attrs.py]).toEqual([16, 12]);
    expect(buttonIds(m, "r3.remote")).toEqual(["approve", "always", "deny", "terminal"]);
    expect(textOf(button(m, "r3.remote", "always"))).toBe("Yes, and don't ask again for touch");
    // The child row in the threads card asks too; Codex children show their nickname when the task text is empty.
    expect(textOf(byId(m.el, "row-child-019a-child"))).toContain("Hypatia");

    await m.click("answer-r3.remote-approve");
    const answers = calls(m, "answer");
    expect(answers).toHaveLength(1);
    expect(answers[0][2]).toEqual({ on: "macmini" });
    expect(answers[0][1].slice(3)).toEqual([
      "answer",
      "--terminal",
      "t5",
      "--request",
      "r3.remote",
      "--expect-kind",
      "codex",
      "--expect-session",
      CODEX_SESSION,
      "--expect-path",
      CODEX_PATH,
      "--action",
      "approve",
    ]);
  });

  test("an approval card names its tool with the command in monospace", async () => {
    const m = await ready(CLAUDE, data());
    expect(REQUEST.tool).toBe("Bash");
    const box = byId(m.el, `cmd-${REQUEST.id}`);
    expect(box.attrs.font_family).toBe("Menlo");
    expect(textOf(byId(m.el, `tool-${REQUEST.id}`))).toBe("Bash");
    expect(textOf(box)).toContain(REQUEST.command);

    // A tool with no command still shows; a question's tool (AskUserQuestion) does not.
    const edit = { ...REQUEST, id: "r4", tool: "Edit", command: "" };
    const ask = {
      ...REQUEST,
      id: "r5.q",
      kind: "question",
      tool: "AskUserQuestion",
      command: "",
      actions: [],
      question: {
        toolUseId: "q",
        agent: "claude",
        delivery: "picker",
        state: "pending",
        questions: [{ id: "a", header: "A", text: "A?", multi: false, options: [{ label: "x" }] }],
      },
    };
    const n = await ready(CLAUDE, data({ feed: () => out(rootWith([edit, ask])) }));
    expect(textOf(byId(n.el, "tool-r4"))).toBe("Edit");
    expect(byId(n.el, "tool-r5.q")).toBe(null);
  });

  test("Answer in terminal flips to the terminal and presses nothing", async () => {
    const m = await ready(CLAUDE, data());
    await m.click(`answer-${REQUEST.id}-terminal`);
    expect(m.log.run).toEqual([["bw-tabs.chat-flip"]]);
    expect(calls(m, "answer")).toHaveLength(0);
  });

  test("a terminal sub-agent's terminal controls peek at that sub-agent, not the parent", async () => {
    const T12 = "2b7f0000-0000-4000-8000-000000000012";
    const T12_PATH = `/home/test/.claude/projects/-r-alpha/${T12}.jsonl`;
    const perm = {
      type: "row",
      k: "perm",
      id: "perm-12",
      text: "Wants to run a command",
      perm: { title: "Wants to run a command", command: "ls", tool: "Bash", toolUseId: "tu12", state: "pending" },
    };
    let t12 = [
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
      { type: "splice", at: 0, count: 2 },
      { type: "row", k: "user", id: "u12", text: "Helper's own question", ts: 1 },
      perm,
      {
        type: "cards",
        terminal: "t12",
        agent: "claude",
        session: T12,
        path: T12_PATH,
        status: "blocked",
        status_kind: "claude",
        hooks: "ok",
        screen: "read",
      },
      { ...REQUEST, id: "r12", answerable: false, reason: "no_match", who: null },
    ];
    const m = await ready(
      CLAUDE,
      data({ feed: (/** @type {string[]} */ a) => out(a[1] === "t12" ? t12 : ROOT_LINES) }),
    );
    await m.click("row-terminal-t12");
    expect(buttonIds(m, "r12")).toEqual(["terminal"]);
    const peek = ["terminal.peek", { terminal: "t12" }];
    await m.click("answer-r12-terminal");
    await m.click("flip");
    fire(findAll(m.el, (e) => e.tag === "VirtualList")[0], "on_item_click", "perm-12", m.cx);
    expect(m.log.run).toEqual([peek, peek, peek]);

    t12 = [{ type: "state", state: "not_agent", agent: null, message: "" }];
    m.log.run.length = 0;
    const n = await ready(
      CLAUDE,
      data({ feed: (/** @type {string[]} */ a) => out(a[1] === "t12" ? t12 : ROOT_LINES) }),
    );
    await n.click("row-terminal-t12");
    await n.click("show-terminal");
    expect(n.log.run).toEqual([peek]);
    expect(calls(n, "answer")).toHaveLength(0);

    // Back in the parent's view, the controls flip the chat tab again.
    await n.click("back");
    await n.click("flip");
    expect(n.log.run.at(-1)).toEqual(["bw-tabs.chat-flip"]);
  });

  test("buttons disabled while the terminal had focus", async () => {
    const m = await ready(CLAUDE, data());
    const approve = () => button(m, REQUEST.id, "approve");
    expect(approve().attrs.disabled).toBe(false);

    fake.focused = { ...fake.focused, pane: "p8", terminal: "t8" };
    setSystemTime(new Date(T0 + 4000));
    m.render();
    expect(approve().attrs.disabled).toBe(true);
    expect(button(m, REQUEST.id, "terminal").attrs.disabled).toBe(false);
    await m.click(`answer-${REQUEST.id}-approve`);
    expect(calls(m, "answer")).toHaveLength(0);

    // ⌘J back to the chat: still guarded for 3 s after focus left the terminal.
    setSystemTime(new Date(T0 + 60_000));
    fake.focused = { ...fake.focused, pane: "p9", terminal: null };
    m.render();
    expect(approve().attrs.disabled).toBe(true);
    setSystemTime(new Date(T0 + 62_999));
    await m.click(`answer-${REQUEST.id}-approve`);
    expect(calls(m, "answer")).toHaveLength(0);
    expect(approve().attrs.disabled).toBe(true);
    setSystemTime(new Date(T0 + 63_000));
    m.render();
    expect(approve().attrs.disabled).toBe(false);
    await m.click(`answer-${REQUEST.id}-approve`);
    expect(calls(m, "answer")).toHaveLength(1);
  });

  test("a terminal focus the hidden chat never drew guards for 3 s after it left, from bw-tabs's record", async () => {
    const m = await ready(CLAUDE, data());
    const approve = () => button(m, REQUEST.id, "approve");
    expect(approve().attrs.disabled).toBe(false);
    // ⌘J to the terminal and back: Herdr drew no hidden chat meanwhile; bw-tabs saw focus leave t8 at +60 s.
    fake.shared["bw.terminal-focus"] = { focused: null, left: { t8: T0 + 60_000 } };
    setSystemTime(new Date(T0 + 60_200));
    m.render();
    expect(approve().attrs.disabled).toBe(true);
    await m.click(`answer-${REQUEST.id}-approve`);
    expect(calls(m, "answer")).toHaveLength(0);
    setSystemTime(new Date(T0 + 63_000));
    m.render();
    expect(approve().attrs.disabled).toBe(false);
  });

  test("fresh mount is guarded; the loop wakes when the guard ends", async () => {
    setSystemTime(new Date(T0));
    const d = data();
    // Hidden: the terminal is zoomed over the chat, so the chat would poll every 10 s.
    d.panes = d.panes.map((/** @type {any} */ p) =>
      p.pane === "p9" ? { ...p, zoomed: false } : p.pane === "p8" ? { ...p, zoomed: true } : p,
    );
    const m = await mount("bw-chat", { props: CLAUDE, live: d });
    expect(button(m, REQUEST.id, "approve").attrs.disabled).toBe(true);
    expect(m.cx.sleeps.at(-1).ms).toBe(3000);
    setSystemTime(new Date(T0 + 3000));
    const before = m.cx.notified;
    await nextPoll(m);
    expect(m.cx.notified).toBeGreaterThan(before);
    expect(button(m, REQUEST.id, "approve").attrs.disabled).toBe(false);
    expect(m.cx.sleeps.at(-1).ms).toBe(10000);
  });

  test("sending state, then the result note", async () => {
    /** @type {(r: unknown) => void} */
    let finish = () => {};
    let lines = ROOT_LINES;
    const m = await ready(
      CLAUDE,
      data({
        feed: () => out(lines),
        answer: () =>
          new Promise((r) => {
            finish = r;
          }),
      }),
    );
    await m.click(`answer-${REQUEST.id}-deny`);
    expect(calls(m, "answer")[0][1].at(-1)).toBe("deny");
    expect(textOf(byId(m.el, `card-${REQUEST.id}`))).toContain("Sending…");
    expect(button(m, REQUEST.id, "approve").attrs.disabled).toBe(true);
    await m.click(`answer-${REQUEST.id}-approve`);
    expect(calls(m, "answer")).toHaveLength(1);

    finish(out([{ type: "answer", result: "stale", state: "stale", message: "box changed" }]));
    await m.cx.flush();
    m.render();
    expect(textOf(byId(m.el, `card-${REQUEST.id}`))).toContain("Changed on screen; nothing was pressed");
    // The poll after an answer runs at once and its line wins.
    lines = rootWith([{ ...REQUEST, state: "declined", resolved_ms: T0 + 3000 }]);
    await nextPoll(m);
    expect(textOf(byId(m.el, `card-${REQUEST.id}`))).toContain("Denied");
    expect(buttonIds(m, REQUEST.id)).toEqual([]);
    setSystemTime(new Date(T0 + 3000 + 10_000));
    m.render();
    expect(byId(m.el, `card-${REQUEST.id}`)).toBe(null);
  });

  test("a refused answer keeps the card and says why", async () => {
    const m = await ready(
      CLAUDE,
      data({ answer: () => out([{ type: "answer", result: "refused-conversation", state: "pending", message: "" }]) }),
    );
    await m.click(`answer-${REQUEST.id}-approve`);
    expect(textOf(byId(m.el, `card-${REQUEST.id}`))).toContain(
      "Claude moved to another conversation; nothing was pressed",
    );
    expect(button(m, REQUEST.id, "approve").attrs.disabled).toBe(false);
  });

  test("show-only Codex child card offers only Answer in terminal", async () => {
    const req = {
      ...REQUEST,
      id: "r3.cc",
      answerable: false,
      reason: "codex_child",
      who: { child: "019a-child", agent_type: "worker" },
    };
    const m = await ready(CLAUDE, data({ feed: () => out(rootWith([req])) }));
    expect(buttonIds(m, "r3.cc")).toEqual(["terminal"]);
    expect(textOf(byId(m.el, "card-r3.cc"))).toContain(
      "Codex sub-agent approvals are answered in the terminal for now",
    );
  });

  test("no conversation to expect disables every answer button", async () => {
    const m = await ready(
      CLAUDE,
      data({
        feed: () =>
          out([
            { type: "state", state: "ambiguous", agent: "claude", message: "" },
            { ...CARDS, session: null, path: null },
            { ...REQUEST, answerable: false, reason: "ambiguous" },
          ]),
      }),
    );
    expect(buttonIds(m, REQUEST.id)).toEqual(["terminal"]);
    expect(textOf(byId(m.el, `card-${REQUEST.id}`))).toContain("Claude's conversation cannot be read (ambiguous)");
  });

  test("question card: step tabs, digit selects, Submit sends answers", async () => {
    const question = {
      toolUseId: "toolu_q",
      agent: "claude",
      delivery: "picker",
      state: "pending",
      questions: [
        {
          id: "Color?",
          header: "Color",
          text: "Which color?",
          multi: false,
          options: [{ label: "Red" }, { label: "Blue" }],
        },
        {
          id: "Fruits?",
          header: "Fruits",
          text: "Which fruits?",
          multi: true,
          options: [{ label: "Apple" }, { label: "Pear" }, { label: "Fig" }],
        },
      ],
    };
    const req = {
      ...REQUEST,
      id: "r3.q",
      kind: "question",
      who: null,
      tool: "AskUserQuestion",
      command: "",
      actions: [],
      question,
      unread: 1,
    };
    const m = await ready(CLAUDE, data({ feed: () => out(rootWith([req])) }));
    const card = () => byId(m.el, "card-r3.q");
    expect(textOf(card())).toContain("Claude asks");
    expect(textOf(card())).toContain("Which color?");
    expect(byId(m.el, "qstep-r3.q-0")).not.toBe(null);
    expect(byId(m.el, "qstep-r3.q-1")).not.toBe(null);
    expect(button(m, "r3.q", "submit").attrs.disabled).toBe(true);

    const keys = byId(m.el, "qkeys-r3.q");
    // A digit picks the option and moves on; it never submits.
    await fire(keys, "on_key_down", { key: "2", keystroke: "2", modifiers: NO_MODS }, m.cx);
    await m.cx.flush();
    m.render();
    expect(calls(m, "answer")).toHaveLength(0);
    expect(textOf(card())).toContain("Which fruits?");
    await fire(byId(m.el, "qkeys-r3.q"), "on_key_down", { key: "3", keystroke: "3", modifiers: NO_MODS }, m.cx);
    m.render();
    await m.click("qopt-r3.q-1-0");
    // Other text on the multi-choice question goes with its picks.
    const other = findAll(card(), (e) => e.tag === "Input")[0].attrs.state;
    other.set_value("kiwi");
    await other.handlers.change({}, m.cx);
    m.render();
    expect(calls(m, "answer")).toHaveLength(0);
    expect(button(m, "r3.q", "submit").attrs.disabled).toBe(false);
    // The step tab goes back to the first question and keeps its pick.
    await m.click("qstep-r3.q-0");
    expect(textOf(card())).toContain("Which color?");
    await m.click("answer-r3.q-submit");
    const a = calls(m, "answer");
    expect(a).toHaveLength(1);
    expect(a[0][1].slice(3)).toEqual([
      "answer",
      "--terminal",
      "t8",
      "--request",
      "r3.q",
      "--expect-kind",
      "claude",
      "--expect-session",
      ROOT,
      "--expect-path",
      ROOT_PATH,
      "--answers",
      '[{"picks":[1]},{"picks":[0,2],"other":"kiwi"}]',
    ]);
  });

  test("picking an option after typing Other clears the shown field, by click or digit", async () => {
    const question = {
      toolUseId: "toolu_q",
      agent: "claude",
      delivery: "picker",
      state: "pending",
      questions: [
        {
          id: "Color?",
          header: "Color",
          text: "Which color?",
          multi: false,
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
    };
    const req = {
      ...REQUEST,
      id: "r3.q",
      kind: "question",
      who: null,
      tool: "AskUserQuestion",
      command: "",
      actions: [],
      question,
      unread: 1,
    };
    const m = await ready(CLAUDE, data({ feed: () => out(rootWith([req])) }));
    const card = () => byId(m.el, "card-r3.q");
    const field = () => findAll(card(), (e) => e.tag === "Input")[0].attrs.state;
    const typeOther = async (/** @type {string} */ v) => {
      field().set_value(v);
      await field().handlers.change({}, m.cx);
      m.render();
    };
    await typeOther("Green");
    await m.click("qopt-r3.q-0-1");
    expect(field().value()).toBe("");
    await typeOther("Teal");
    await fire(byId(m.el, "qkeys-r3.q"), "on_key_down", { key: "1", keystroke: "1", modifiers: NO_MODS }, m.cx);
    m.render();
    expect(field().value()).toBe("");
    await m.click("answer-r3.q-submit");
    expect(calls(m, "answer")[0][1].at(-1)).toBe('[{"picks":[0]}]');
  });

  test("async question Submit sends one answer call", async () => {
    const question = {
      toolUseId: "call_q",
      agent: "codex",
      delivery: "message",
      state: "pending",
      questions: [
        {
          id: "size",
          header: "Size",
          text: "Which size?",
          multi: false,
          options: [{ label: "small" }, { label: "large" }],
        },
      ],
    };
    const d = live("chat-remote");
    const req = {
      ...REQUEST,
      id: "r3.async",
      kind: "question_async",
      who: null,
      tool: "request_user_input",
      command: "",
      actions: [],
      question,
    };
    const lines = [
      {
        type: "log",
        agent: "codex",
        terminal: "t5",
        session: CODEX_SESSION,
        path: CODEX_PATH,
        start: 0,
        size: 10,
        cursor: "2.c",
      },
      { type: "splice", at: 0, count: 0 },
      { ...CARDS, terminal: "t5", agent: "codex", session: CODEX_SESSION, path: CODEX_PATH, status: "idle" },
      req,
    ];
    d.exec = bw({
      feed: () => out(lines),
      answer: () => out([{ type: "answer", result: "answered", state: "answered", message: "" }]),
    });
    const m = await ready(CODEX_REMOTE, d);
    expect(textOf(byId(m.el, "card-r3.async"))).toContain("Codex asks");
    await m.click("qopt-r3.async-0-1");
    await m.click("answer-r3.async-submit");
    await m.click("answer-r3.async-submit");
    const a = calls(m, "answer");
    expect(a).toHaveLength(1);
    expect(a[0][2]).toEqual({ on: "macmini" });
    expect(a[0][1].slice(-2)).toEqual(["--answers", '[{"picks":[1]}]']);
  });

  test("Codex /new from the composer: the folder prompt card's option calls answer, then the chat names the new conversation", async () => {
    const NEXT = "019a0000-0000-7000-8000-000000000002";
    const prompt = {
      ...REQUEST,
      id: "r3.folder",
      kind: "prompt",
      who: null,
      tool: "new_conversation",
      command: "",
      detail: "",
      actions: [
        { id: "option-1", label: "In /home/u/gamma" },
        { id: "option-2", label: "In a new worktree" },
      ],
    };
    const old = [
      {
        type: "log",
        agent: "codex",
        terminal: "t5",
        session: CODEX_SESSION,
        path: CODEX_PATH,
        start: 0,
        size: 10,
        cursor: "2.c",
      },
      { type: "splice", at: 0, count: 1 },
      { type: "row", k: "user", id: "u-old", text: "The old conversation", ts: 1 },
    ];
    const cards = {
      ...CARDS,
      terminal: "t5",
      agent: "codex",
      session: CODEX_SESSION,
      path: CODEX_PATH,
      status: "idle",
    };
    let lines = [...old, cards];
    const d = live("chat-remote");
    d.exec = bw({
      feed: () => out(lines),
      send: () => out([{ type: "send", result: "sent", message: "" }]),
      answer: () => out([{ type: "answer", result: "answered", state: "answered", message: "" }]),
    });
    const m = await ready(CODEX_REMOTE, d);
    const state = textarea(m).attrs.state;
    inspect(state).value = "/new";
    await emit(state, "change", {}, m.cx);
    await emit(state, "submit", { shift: false }, m.cx);
    await m.cx.flush();
    lines = [...old, cards, prompt];
    await nextPoll(m);
    expect(textOf(byId(m.el, "card-r3.folder"))).toContain("Codex asks where the new conversation should run");
    expect(buttonIds(m, "r3.folder")).toEqual(["option-1", "option-2", "terminal"]);
    await m.click("answer-r3.folder-option-1");
    expect(calls(m, "answer")[0][1].slice(3)).toEqual([
      "answer",
      "--terminal",
      "t5",
      "--request",
      "r3.folder",
      "--expect-kind",
      "codex",
      "--expect-session",
      CODEX_SESSION,
      "--expect-path",
      CODEX_PATH,
      "--action",
      "option-1",
    ]);

    lines = [
      { type: "state", state: "no_log", agent: "codex", message: "no codex session log yet", session: NEXT },
      { ...cards, session: NEXT, path: null },
      { ...prompt, state: "answered", resolved_ms: T0 + 3000 },
    ];
    await nextPoll(m);
    expect(textOf(m.el)).not.toContain("The old conversation");
    expect(textOf(m.el)).toContain("No messages yet. Send the first one below.");
    expect(textOf(byId(m.el, "card-r3.folder"))).toContain("Answered");
    inspect(state).value = "first of the new one";
    await emit(state, "change", {}, m.cx);
    await emit(state, "submit", { shift: false }, m.cx);
    await m.cx.flush();
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
  });

  test("a child view answers with the root conversation the cards line names", async () => {
    const child = fixtureLines(["bw", "feed", "t8", "--session", CHILD]);
    const m = await ready(
      CLAUDE,
      data({ feed: (/** @type {string[]} */ args) => out(args.includes("--session") ? child : ROOT_LINES) }),
    );
    await m.click(`row-child-${CHILD}`);
    expect(byId(m.el, `card-${REQUEST.id}`)).not.toBe(null);
    await m.click(`answer-${REQUEST.id}-always`);
    expect(calls(m, "answer")[0][1].slice(3)).toEqual([
      "answer",
      "--terminal",
      "t8",
      "--request",
      REQUEST.id,
      "--expect-kind",
      "claude",
      "--expect-session",
      ROOT,
      "--expect-path",
      ROOT_PATH,
      "--action",
      "always",
    ]);
  });

  test("hidden chat still polls every 10 s with --cards", async () => {
    const m = await mount("bw-chat", { props: CODEX_REMOTE, live: live("chat-remote") });
    const d = live("chat-tab");
    const h = await mount("bw-chat", { props: CODEX_REMOTE, live: d });
    expect(h.cx.sleeps.at(-1).ms).toBeGreaterThan(9900);
    expect(lastFeed(h)).toEqual(["--terminal", "t5", "--pictures", "--tree", "--cards"]);
    expect(lastFeed(m)).toEqual(["--terminal", "t5", "--pictures", "--tree", "--cards"]);
  });
});

describe("hooks notices", () => {
  const DIFF = [
    {
      type: "hooks-diff",
      agent: "claude",
      path: "/home/test/.claude/settings.json",
      sha256: "aa11",
      changed: true,
      diff: '--- a\n+++ b\n+  "PermissionRequest": [ ... bellwether-hook=1 ... ]',
    },
    {
      type: "hooks-diff",
      agent: "codex",
      path: "/home/test/.codex/hooks.json",
      sha256: "",
      changed: true,
      diff: '--- /dev/null\n+++ b\n+{ "hooks": {} }',
    },
  ];

  test("hooks missing: Review changes shows the diff, Apply passes the sha", async () => {
    let hooks = "missing";
    const m = await ready(
      CLAUDE,
      data({
        feed: () => out(rootWith([REQUEST], { hooks })),
        machine: (/** @type {string[]} */ args) =>
          args.includes("--diff")
            ? out(DIFF)
            : out([
                { type: "hooks-applied", agent: "claude", path: DIFF[0].path, changed: true, backup: "/b/1" },
                { type: "hooks-applied", agent: "codex", path: DIFF[1].path, changed: true, backup: null },
              ]),
      }),
    );
    const notice = byId(m.el, "hooks-notice");
    expect(textOf(notice)).toContain("Bellwether hooks are not set up on this Mac; requests show without who asked");
    await m.click("hooks-review");
    const diff = calls(m, "machine");
    expect(diff).toHaveLength(1);
    expect(diff[0][2]).toEqual({ on: null });
    expect(diff[0][1].slice(4)).toEqual(["setup", "local", "--diff"]);
    expect(textOf(byId(m.el, "hooks-diff"))).toContain("bellwether-hook=1");
    expect(textOf(byId(m.el, "hooks-diff"))).toContain("/home/test/.codex/hooks.json");
    await m.click("hooks-apply");
    const apply = calls(m, "machine").at(-1);
    expect(apply[2]).toEqual({ on: null });
    expect(apply[1].slice(4)).toEqual(["setup", "local", "--apply", "--expect-sha", "aa11,"]);
    hooks = "ok";
    await nextPoll(m);
    expect(byId(m.el, "hooks-notice")).toBe(null);
  });

  test("a remote space's hooks are set up on its machine; Not now holds per machine", async () => {
    const d = live("chat-remote");
    d.exec = bw({
      feed: () =>
        out([
          {
            type: "log",
            agent: "codex",
            terminal: "t5",
            session: CODEX_SESSION,
            path: CODEX_PATH,
            start: 0,
            size: 1,
            cursor: "2.c",
          },
          { type: "splice", at: 0, count: 0 },
          { ...CARDS, terminal: "t5", agent: "codex", session: CODEX_SESSION, path: CODEX_PATH, hooks: "missing" },
        ]),
      machine: () => out(DIFF),
    });
    const m = await ready(CODEX_REMOTE, d);
    expect(textOf(byId(m.el, "hooks-notice"))).toContain("Bellwether hooks are not set up on macmini");
    await m.click("hooks-review");
    expect(calls(m, "machine")[0][1].slice(4)).toEqual(["setup", "macmini", "--diff"]);
    expect(calls(m, "machine")[0][2]).toEqual({ on: null });
    await m.click("hooks-dismiss");
    expect(byId(m.el, "hooks-notice")).toBe(null);
    expect(m.log.shared.at(-1)).toEqual(["bw.hooks-dismissed", { macmini: true }]);
  });

  test("Codex hook not trusted is named", async () => {
    const d = live("chat-remote");
    d.exec = bw({
      feed: () =>
        out([
          {
            type: "log",
            agent: "codex",
            terminal: "t5",
            session: CODEX_SESSION,
            path: CODEX_PATH,
            start: 0,
            size: 1,
            cursor: "2.c",
          },
          { type: "splice", at: 0, count: 0 },
          {
            ...CARDS,
            terminal: "t5",
            agent: "codex",
            session: CODEX_SESSION,
            path: CODEX_PATH,
            hooks: { claude: "ok", codex: "untrusted" },
          },
        ]),
    });
    const m = await ready(CODEX_REMOTE, d);
    const notice = textOf(byId(m.el, "hooks-notice"));
    expect(notice).toContain("Codex hook not trusted on macmini");
    expect(notice).toContain("Trust all and continue");
    expect(byId(m.el, "hooks-review")).toBe(null);
  });
});
