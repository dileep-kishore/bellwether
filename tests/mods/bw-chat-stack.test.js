// Stack-mode bw-chat: frameless 24-session LRU, multi-agent tab pinning, bw.screen 2s/10s poll
// cadence, TERMINAL_FOCUS 3s cooldown, composer Enter queueing + queue drawer, and PR skill strip.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { live, mount, repo } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, emit, findAll, fire, inspect, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import { SessionMap, hasUnsentDraft, parseQueueLine, pinTabAgent } from "../../mods/bw-chat/sessions.js";

const CLAUDE_PATH = "/home/test/.claude/projects/-r-alpha/e186f156-fd30-4aab-a0b6-d3922b281731.jsonl";
const CLAUDE_SESSION = "e186f156-fd30-4aab-a0b6-d3922b281731";
const CODEX_PATH =
  "/home/u/.codex/sessions/2026/11/07/rollout-2026-11-07T06-11-54-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl";
const HEAD_SHA = "1111111111111111111111111111111111111111";

const CLAUDE_PROG = {
  key: "claude",
  name: "Claude Code",
  icon: "icons/claude.svg",
  tint: false,
  tile: null,
  color: null,
  shell: false,
  agent: true,
};

const CODEX_PROG = {
  key: "codex",
  name: "Codex",
  icon: "icons/codex.svg",
  tint: true,
  tile: null,
  color: null,
  shell: false,
  agent: true,
};

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);

/**
 * @param {string} name
 * @param {string} terminal
 * @param {string} path
 */
function golden(name, terminal, path) {
  const lines = readFileSync(join(repo, "tests/fixtures/feed", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  lines[0] = { ...lines[0], terminal, path, cursor: `2.fixture-${name}` };
  return lines;
}

/**
 * Builds a stack-mode live snapshot with configurable spaces, tabs, panes, terminals, and agents.
 */
function stackLive() {
  const base = live("chat-tab");
  return {
    ...base,
    focused: {
      space: "s1",
      tab: "tb1",
      pane: "p1",
      terminal: null,
      shown: null,
      agent: "claude",
      cwd: "/r/alpha",
    },
    spaces: [
      {
        id: "s1",
        index: 1,
        name: "alpha",
        named: false,
        folder: "/r/alpha",
        machine: null,
        branch: "feat/cockpit",
        active: true,
        status: "done",
        tabs: [
          {
            id: "tb1",
            index: 1,
            name: "Claude",
            named: true,
            active: true,
            status: "done",
            panes: 1,
            zoomed: false,
            settled: true,
            settled_at: 1762459940000,
            changed_at: 1762459940000,
            working_since: null,
          },
          {
            id: "tb2",
            index: 2,
            name: "Multi",
            named: true,
            active: false,
            status: "working",
            panes: 2,
            zoomed: false,
            settled: false,
            settled_at: null,
            changed_at: 1762459945000,
            working_since: 1762459945000,
          },
        ],
      },
    ],
    panes: [
      {
        pane: "p1",
        space: "s1",
        tab: "tb1",
        terminal: "t1",
        mod: null,
        title: "Claude",
        status: "done",
        program: CLAUDE_PROG,
        focused: true,
        zoomed: false,
      },
      {
        pane: "p2",
        space: "s1",
        tab: "tb2",
        terminal: "t2",
        mod: null,
        title: "Claude",
        status: "working",
        program: CLAUDE_PROG,
        focused: false,
        zoomed: false,
      },
      {
        pane: "p3",
        space: "s1",
        tab: "tb2",
        terminal: "t3",
        mod: null,
        title: "Codex",
        status: "done",
        program: CODEX_PROG,
        focused: false,
        zoomed: false,
      },
    ],
    terminals: [
      { address: "t1", state: "live", status: "done", program: CLAUDE_PROG, cwd: "/r/alpha" },
      { address: "t2", state: "live", status: "working", program: CLAUDE_PROG, cwd: "/r/alpha" },
      { address: "t3", state: "live", status: "done", program: CODEX_PROG, cwd: "/r/alpha" },
    ],
    agents: [
      { address: "t1", pane: "p1", space: "s1", tab: "tb1", status: "done", program: CLAUDE_PROG, focused: true },
      { address: "t2", pane: "p2", space: "s1", tab: "tb2", status: "working", program: CLAUDE_PROG, focused: false },
      { address: "t3", pane: "p3", space: "s1", tab: "tb2", status: "done", program: CODEX_PROG, focused: false },
    ],
    shared: {
      "bw.window-id": "w1",
      "bw.screen": "chat",
      "bw.chat-tabs": { tb1: { kind: "claude", createdAt: 100 }, tb2: { kind: "claude", createdAt: 100 } },
    },
  };
}

/**
 * Fake `exec` handling both `git` read-only commands and `bw` subcommands.
 * @param {Record<string, (args: string[], on: string | null) => unknown>} handlers
 * @param {{ origin?: string, head?: string }} [gitOpts]
 */
function bwAndGit(handlers, gitOpts = {}) {
  const origin = gitOpts.origin ?? "git@github.com:acme/alpha.git";
  const head = gitOpts.head ?? HEAD_SHA;
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    const on = opts?.on ?? null;
    if (cmd === "git") {
      if (args.includes("remote.origin.url")) {
        return origin ? { code: 0, stdout: `${origin}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return head ? { code: 0, stdout: `${head}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected git call" };
    }
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw") {
      return { code: 127, stdout: "", stderr: "sh: no such fake" };
    }
    const sub = args[3];
    const h = handlers[sub] ?? (sub === "version" ? () => VERSION : null);
    if (!h) {
      if (sub === "queue" && args[4] === "list") {
        return out([{ type: "queue", terminal: args[6] ?? "t1", held: false, hold_reason: null, items: [] }]);
      }
      if (sub === "pr") {
        return out([{ type: "pr", state: "none" }]);
      }
      return out([{ type: "error", code: "stub", message: `no ${sub} answer` }]);
    }
    return h(args.slice(4), on);
  };
}

/** @param {any} m @param {string} sub */
const calls = (m, sub) => m.log.exec.filter(([c, a]) => c === "sh" && HELPER_SCRIPTS.includes(a[1]) && a[3] === sub);
/** @param {any} m */
const textarea = (m) => findAll(m.el, (e) => e.tag === "Textarea")[0];
/** @param {any} m */
async function nextPoll(m) {
  m.cx.sleeps.at(-1).wake();
  await m.cx.flush();
  return m.render();
}
/** @param {any} m @param {string} text */
async function typeText(m, text) {
  const state = textarea(m).attrs.state;
  inspect(state).value = text;
  await emit(state, "change", {}, m.cx);
  return m.render();
}
/** @param {any} m @param {string} text */
async function typeAndSubmit(m, text) {
  const state = textarea(m).attrs.state;
  inspect(state).value = text;
  await emit(state, "change", {}, m.cx);
  inspect(state).value = `${text}\n`;
  await emit(state, "change", {}, m.cx);
  await emit(state, "submit", { shift: false }, m.cx);
  await m.cx.flush();
  return m.render();
}

describe("SessionMap and helpers", () => {
  /** @param {number} index */
  function fakeSlot(index) {
    const makeComp = () => {
      let val = "";
      return {
        input: { value: () => val },
        set(/** @type {string} */ v) {
          val = v;
        },
        clear() {
          val = "";
        },
      };
    };
    return {
      index,
      scroll: { index },
      composers: { claude: /** @type {any} */ (makeComp()), codex: /** @type {any} */ (makeComp()) },
    };
  }

  /** @param {string} terminal @param {string} [tab] */
  const target = (terminal, tab = `tab-${terminal}`) => ({
    machine: null,
    terminal,
    local: terminal,
    kind: /** @type {const} */ ("claude"),
    tab,
    pane: `p-${terminal}`,
    spaceId: "s1",
    folder: "/r/alpha",
    branch: "main",
    status: "done",
    title: "Claude",
    program: CLAUDE_PROG,
    focused: false,
  });

  test("evicts the oldest clean session and protects unsent text or Linear chips", () => {
    const map = new SessionMap([fakeSlot(0), fakeSlot(1), fakeSlot(2)], fakeSlot(3), 3);
    const s1 = map.acquire(target("t1"), {}, 100).session;
    const s2 = map.acquire(target("t2"), {}, 200).session;
    const s3 = map.acquire(target("t3"), {}, 300).session;
    expect(map.size).toBe(3);

    // Give t1 unsent composer text and t2 an attached Linear chip; t3 is clean so t3 must be evicted.
    /** @type {any} */ (s1.composer).set("draft in t1");
    const attach = { version: 1, tabs: { "tab-t2": [{ identifier: "BEL-42", title: "Bug", bytes: 120, mode: null }] } };
    expect(hasUnsentDraft(s1, attach)).toBe(true);
    expect(hasUnsentDraft(s2, attach)).toBe(true);
    expect(hasUnsentDraft(s3, attach)).toBe(false);

    const s4 = map.acquire(target("t4"), attach, 400).session;
    expect(map.get("t1")).toBe(s1);
    expect(map.get("t2")).toBe(s2);
    expect(map.get("t3")).toBe(null);
    expect(map.get("t4")).toBe(s4);
    expect(s1.composer.input.value()).toBe("draft in t1");
  });

  test("preserves unsent drafts beyond fallback slot capacity without aliasing composers or scroll handles", () => {
    const map = new SessionMap([fakeSlot(0), fakeSlot(1), fakeSlot(2)], fakeSlot(3), 3);
    const s1 = map.acquire(target("t1"), {}, 100).session;
    /** @type {any} */ (s1.composer).set("draft 1");
    const s2 = map.acquire(target("t2"), {}, 200).session;
    /** @type {any} */ (s2.composer).set("draft 2");
    const s3 = map.acquire(target("t3"), {}, 300).session;
    /** @type {any} */ (s3.composer).set("draft 3");
    const s4 = map.acquire(target("t4"), {}, 400).session;
    /** @type {any} */ (s4.composer).set("draft 4");

    // 5th drafted session with max=3 detaches oldest inactive slot (t1) rather than aliasing s4's slot.
    const s5 = map.acquire(target("t5"), {}, 500).session;
    /** @type {any} */ (s5.composer).set("draft 5");

    expect(map.size).toBe(5);
    expect(s4.composer).not.toBe(s5.composer);
    expect(s4.scroll).not.toBe(s5.scroll);
    expect(s4.composer.input.value()).toBe("draft 4");
    expect(s5.composer.input.value()).toBe("draft 5");
    expect(hasUnsentDraft(s1, {})).toBe(true);

    // Re-visiting t1 re-attaches a dedicated slot and restores "draft 1" intact.
    const s1Again = map.acquire(target("t1"), {}, 600).session;
    expect(s1Again).toBe(s1);
    expect(s1Again.composer).not.toBe(s5.composer);
    expect(s1Again.composer.input.value()).toBe("draft 1");
    expect(s5.composer.input.value()).toBe("draft 5");
  });

  test("pinTabAgent prunes dead tabs and parseQueueLine extracts held state and items", () => {
    expect(pinTabAgent({ dead: "t9", tb1: "t1" }, "tb2", "t3", ["tb1", "tb2"])).toEqual({
      tb1: "t1",
      tb2: "t3",
    });
    expect(
      parseQueueLine([
        {
          type: "queue",
          terminal: "t1",
          held: true,
          hold_reason: "session_changed",
          items: [{ id: "q1", text: "run tests", at_ms: 50, expect_kind: "claude", expect_session: "s-1" }],
        },
      ]),
    ).toEqual({
      held: true,
      holdReason: "session_changed",
      items: [
        {
          id: "q1",
          text: "run tests",
          at_ms: 50,
          expect_kind: "claude",
          expect_session: "s-1",
          unverified_startup: false,
        },
      ],
    });
  });
});

describe("bw-chat stack mode", () => {
  test("renders framelessly without #chat-header and preserves unsent drafts across sessions", async () => {
    const data = stackLive();
    data.exec = bwAndGit({
      feed: (args) => {
        const term = args[args.indexOf("--terminal") + 1];
        if (term === "t3") return out(golden("codex-question", "t3", CODEX_PATH));
        return out(golden("claude-approval", term, CLAUDE_PATH));
      },
    });
    const m = await mount("bw-chat", { props: {}, live: data });
    expect(byId(m.el, "chat-header")).toBe(null);
    expect(byId(m.el, "agent-switcher")).toBe(null);

    // Type an unsent draft in tb1 (t1).
    await typeText(m, "keep this unsent prompt");
    expect(textarea(m).attrs.state.value()).toBe("keep this unsent prompt");

    // Switch active tab to tb2 (multi-agent: t2 Claude + t3 Codex).
    fake.spaces[0].tabs[0].active = false;
    fake.spaces[0].tabs[1].active = true;
    m.render();
    await nextPoll(m);

    // Switcher appears with Claude and Codex; t2 (first agent) is selected because neither is focused or pinned.
    expect(byId(m.el, "agent-switcher")).not.toBe(null);
    expect(textarea(m).attrs.state.value()).toBe("");

    // Switch back to tb1 -> unsent draft is intact!
    fake.spaces[0].tabs[0].active = true;
    fake.spaces[0].tabs[1].active = false;
    m.render();
    expect(textarea(m).attrs.state.value()).toBe("keep this unsent prompt");
  });

  test("resolves multi-agent tabs in priority order (bw.chat-agent -> focused -> first) and pins on switcher click", async () => {
    const data = stackLive();
    data.spaces[0].tabs[0].active = false;
    data.spaces[0].tabs[1].active = true;
    // Focus p3 (t3 Codex) in tb2 with no bw.chat-agent pin yet -> selects t3!
    data.panes[0].focused = false;
    data.panes[2].focused = true;
    data.focused = { ...data.focused, tab: "tb2", pane: "p3", agent: "codex" };
    data.exec = bwAndGit({
      feed: (args) => {
        const term = args[args.indexOf("--terminal") + 1];
        return term === "t3"
          ? out(golden("codex-question", "t3", CODEX_PATH))
          : out(golden("claude-approval", term, CLAUDE_PATH));
      },
    });
    const m = await mount("bw-chat", { props: {}, live: data });
    expect(m.view.session?.terminal).toBe("t3");

    // Clicking Claude in #agent-switcher pins bw.chat-agent[tb2] = "t2", runs agent.focus, and focuses t2's composer.
    await m.click("agent-switch-t2");
    expect(fake.shared["bw.chat-agent"]).toEqual({ tb2: "t2" });
    expect(m.log.run).toContainEqual(["agent.focus", { terminal: "t2" }]);
    expect(m.view.session?.terminal).toBe("t2");
    expect(inspect(textarea(m).attrs.state).focused).toBe(1);
  });

  test("switches poll sleep from 2 s on chat to 10 s on non-chat screens without needing a render", async () => {
    const data = stackLive();
    let lines = [
      ...golden("claude-approval", "t1", CLAUDE_PATH),
      {
        type: "cards",
        terminal: "t1",
        agent: "claude",
        session: CLAUDE_SESSION,
        path: CLAUDE_PATH,
        status: "done",
        status_kind: "claude",
        hooks: "ok",
        screen: "read",
      },
    ];
    data.exec = bwAndGit({
      feed: () => out(lines),
    });
    const m = await mount("bw-chat", { props: {}, live: data });
    lines = [{ type: "log", terminal: "t1", path: CLAUDE_PATH, cursor: "3.c" }, { type: "unchanged" }];
    await nextPoll(m);
    expect(m.cx.sleeps.at(-1).ms).toBeLessThanOrEqual(2000);

    // Flip shared("bw.screen") to "panes" WITHOUT calling m.render() first, then wake the background poll loop.
    fake.shared["bw.screen"] = "panes";
    m.cx.sleeps.at(-1).wake();
    await m.cx.flush();
    expect(m.cx.sleeps.at(-1).ms).toBeGreaterThan(2000);
    expect(m.cx.sleeps.at(-1).ms).toBeLessThanOrEqual(10000);
  });

  test("enforces TERMINAL_FOCUS 3 s cooldown after panes -> chat and routes bw-chat.focus command", async () => {
    const RealNow = Date.now;
    let clock = 40_000;
    Date.now = () => clock;
    try {
      const resolvers = /** @type {((cmd: string) => void)[]} */ ([]);
      const data = stackLive();
      // Even if Herdr's model pane p1 still reports terminal: "t1" in focused(), stack chat treats
      // non-panes screen as unfocused and relies on TERMINAL_FOCUS.left for the 3 s panes -> chat cooldown.
      data.focused = { ...data.focused, pane: "p1", terminal: "t1" };
      data.nextCommand = () => new Promise((r) => resolvers.push(r));
      const questionReq = {
        type: "request",
        id: "rq-1",
        terminal: "t1",
        session: CLAUDE_SESSION,
        who: null,
        kind: "question",
        state: "pending",
        answerable: true,
        reason: null,
        tool: "AskUserQuestion",
        command: "",
        actions: [],
        at_ms: 39_000,
        unread: 1,
        question: {
          toolUseId: "toolu_1",
          agent: "claude",
          delivery: "picker",
          state: "pending",
          questions: [
            {
              id: "Mode?",
              header: "Mode",
              text: "Which mode?",
              multi: false,
              options: [{ label: "Fast" }, { label: "Safe" }],
            },
          ],
        },
      };
      data.exec = bwAndGit({
        feed: () =>
          out([
            ...golden("claude-approval", "t1", CLAUDE_PATH),
            {
              type: "cards",
              terminal: "t1",
              agent: "claude",
              session: CLAUDE_SESSION,
              path: CLAUDE_PATH,
              status: "blocked",
              status_kind: "claude",
              hooks: "ok",
              screen: "read",
            },
            questionReq,
          ]),
        answer: () => out([{ type: "answer", id: "rq-1", result: "answered" }]),
      });

      const m = await mount("bw-chat", { props: {}, live: data });
      // Advance past initial mount guard, then simulate panes -> chat leaving t1 at 49_000 and drawing at 50_000.
      clock = 50_000;
      fake.shared["bw.terminal-focus"] = { focused: null, left: { t1: 49_000 } };
      m.render();

      const noMods = { shift: false, control: false, alt: false, platform: false, function: false };
      // Select option 1; at clock = 50_000 (1 s after leftAt = 49_000), Submit is disabled by the 3 s guard!
      await fire(byId(m.el, "qkeys-rq-1"), "on_key_down", { key: "1", keystroke: "1", modifiers: noMods }, m.cx);
      await fire(
        byId(m.el, "qkeys-rq-1"),
        "on_key_down",
        { key: "enter", keystroke: "enter", modifiers: noMods },
        m.cx,
      );
      await m.cx.flush();
      expect(calls(m, "answer")).toHaveLength(0);

      // Trigger bw-chat.focus -> focuses root focus handle because activeQuestion is present.
      let rootFocusCalls = 0;
      m.view.focus.focus = () => {
        rootFocusCalls++;
      };
      resolvers.shift()?.("focus");
      await m.cx.flush();
      expect(rootFocusCalls).toBe(1);
      expect(inspect(textarea(m).attrs.state).focused).toBe(0);

      // Advance past 49_000 + 3_000 = 52_000 -> Submit now answers!
      clock = 52_500;
      m.render();
      await m.click("answer-rq-1-submit");
      expect(calls(m, "answer")).toHaveLength(1);
    } finally {
      Date.now = RealNow;
    }
  });

  test("queues on Enter while working, sends immediately on Shift+Cmd+Enter, manages queue drawer, and runs fallback drain", async () => {
    const data = stackLive();
    data.panes[0].status = "working";
    data.terminals[0].status = "working";
    data.agents[0].status = "working";
    data.spaces[0].status = "working";
    data.spaces[0].tabs[0].status = "working";

    /** @type {any[]} */
    let items = [];
    let held = false;
    /** @type {string | null} */
    let holdReason = null;
    const queueReply = () => out([{ type: "queue", terminal: "t1", held, hold_reason: holdReason, items }]);

    data.exec = bwAndGit({
      feed: () => out(golden("claude-approval", "t1", CLAUDE_PATH)),
      send: () => out([{ type: "send", result: "sent" }]),
      queue: (args) => {
        const op = args[0];
        if (op === "list") return queueReply();
        if (op === "add") {
          const text = args[args.indexOf("--text") + 1];
          const sessIdx = args.indexOf("--session");
          items = [
            ...items,
            {
              id: `q${items.length + 1}`,
              text,
              at_ms: 1000 + items.length,
              expect_kind: "claude",
              expect_session: sessIdx >= 0 ? args[sessIdx + 1] : null,
            },
          ];
          return queueReply();
        }
        if (op === "edit") {
          const id = args[args.indexOf("--id") + 1];
          const text = args[args.indexOf("--text") + 1];
          items = items.map((it) => (it.id === id ? { ...it, text } : it));
          return queueReply();
        }
        if (op === "move") {
          const id = args[args.indexOf("--id") + 1];
          const to = Number(args[args.indexOf("--to") + 1]);
          const idx = items.findIndex((it) => it.id === id);
          if (idx >= 0) {
            const copy = [...items];
            const [picked] = copy.splice(idx, 1);
            copy.splice(to, 0, picked);
            items = copy;
          }
          return queueReply();
        }
        if (op === "remove") {
          const id = args[args.indexOf("--id") + 1];
          items = items.filter((it) => it.id !== id);
          return queueReply();
        }
        if (op === "resume") {
          held = false;
          holdReason = null;
          return queueReply();
        }
        if (op === "send") {
          const id = args[args.indexOf("--id") + 1];
          const expSession = args[args.indexOf("--expect-session") + 1];
          if (expSession !== CLAUDE_SESSION) {
            return out([
              { type: "send", result: "refused-conversation", message: "session mismatch" },
              { type: "queue", terminal: "t1", held, hold_reason: holdReason, items },
            ]);
          }
          const had = items.some((it) => it.id === id);
          items = items.filter((it) => it.id !== id);
          return out([
            { type: "send", result: had ? "sent" : "already-sent", message: "sent" },
            { type: "queue", terminal: "t1", held, hold_reason: holdReason, items },
          ]);
        }
        if (op === "drain") {
          items = items.slice(1);
          return out([{ type: "drain", action: "sent", id: "q1" }]);
        }
        return queueReply();
      },
    });

    const m = await mount("bw-chat", { props: {}, live: data });
    expect(textOf(byId(m.el, "send"))).toBe("Queue");

    // 1. Enter while working enqueues via `bw queue add` with `--session`!
    await typeAndSubmit(m, "first follow-up");
    await typeAndSubmit(m, "second follow-up");
    expect(calls(m, "send")).toHaveLength(0);
    const adds = calls(m, "queue").filter(([, a]) => a[4] === "add");
    expect(adds).toHaveLength(2);
    expect(adds[0][1].slice(4)).toEqual([
      "add",
      "--terminal",
      "t1",
      "--kind",
      "claude",
      "--session",
      CLAUDE_SESSION,
      "--text",
      "first follow-up",
    ]);
    expect(byId(m.el, "queue-drawer")).not.toBe(null);

    // 2. Shift+Cmd+Enter bypasses queue and calls `bw send` immediately!
    await typeText(m, "urgent interrupt");
    await fire(byId(m.el, "box"), "on_key_down", { key: "enter", modifiers: { shift: true, platform: true } }, m.cx);
    await m.cx.flush();
    m.render();
    expect(calls(m, "send")).toHaveLength(1);
    expect(calls(m, "send")[0][1]).toContain("urgent interrupt");

    // 3. Edit q1 inline and Save.
    await m.click("queue-edit-q1");
    const editState = byId(m.el, "queue-edit-input").attrs.state;
    editState.set_value("edited first follow-up");
    await editState.handlers.change({}, m.cx);
    m.render();
    await m.click("queue-save-q1");
    expect(items[0].text).toBe("edited first follow-up");

    // 4. Move q2 up to index 0.
    await m.click("queue-up-q2");
    expect(items.map((x) => x.id)).toEqual(["q2", "q1"]);

    // 5. Mark held, verify Resume clears held state.
    held = true;
    holdReason = "session_changed";
    await nextPoll(m);
    expect(textOf(byId(m.el, "queue-drawer"))).toContain("Queue paused because this terminal switched conversations.");
    await m.click("queue-resume");
    expect(held).toBe(false);

    // 6. Send now on q2 calls atomic `bw queue send` in one IPC call (never `bw send` + `bw queue remove`), leaving q1.
    await m.click("queue-send-q2");
    expect(calls(m, "send")).toHaveLength(1);
    const qSends = calls(m, "queue").filter(([, a]) => a[4] === "send");
    expect(qSends).toHaveLength(1);
    expect(qSends[0][1].slice(4)).toEqual([
      "send",
      "--terminal",
      "t1",
      "--id",
      "q2",
      "--expect-kind",
      "claude",
      "--expect-session",
      CLAUDE_SESSION,
      "--expect-path",
      CLAUDE_PATH,
    ]);
    expect(calls(m, "queue").filter(([, a]) => a[4] === "remove")).toHaveLength(0);
    expect(items.map((x) => x.id)).toEqual(["q1"]);

    // 7. Transition agent status working -> done triggers fallback `bw queue drain --terminal t1`!
    fake.panes[0].status = "done";
    fake.terminals[0].status = "done";
    fake.agents[0].status = "done";
    fake.spaces[0].status = "done";
    fake.spaces[0].tabs[0].status = "done";
    m.render();
    await nextPoll(m);
    const drains = calls(m, "queue").filter(([, a]) => a[4] === "drain");
    expect(drains).toHaveLength(1);
    expect(drains[0][1].slice(4)).toEqual(["drain", "--terminal", "t1"]);
    expect(items).toEqual([]);
  });

  test("drains when queue add finishes after working -> done or when an idle session gains queued items", async () => {
    const RealNow = Date.now;
    let clock = 100_000;
    Date.now = () => clock;
    try {
      const data = stackLive();
      data.panes[0].status = "working";
      data.terminals[0].status = "working";
      data.agents[0].status = "working";
      data.spaces[0].status = "working";
      data.spaces[0].tabs[0].status = "working";

      /** @type {any[]} */
      let items = [];
      /** @type {(() => void) | null} */
      let releaseAdd = null;
      const queueReply = () => out([{ type: "queue", terminal: "t1", held: false, hold_reason: null, items }]);

      data.exec = bwAndGit({
        feed: () => out(golden("claude-approval", "t1", CLAUDE_PATH)),
        queue: async (args) => {
          const op = args[0];
          if (op === "list") return queueReply();
          if (op === "add") {
            const text = args[args.indexOf("--text") + 1];
            const sessIdx = args.indexOf("--session");
            await new Promise((r) => {
              releaseAdd = () => r(undefined);
            });
            items = [
              ...items,
              {
                id: `q${items.length + 1}`,
                text,
                at_ms: clock,
                expect_kind: "claude",
                expect_session: sessIdx >= 0 ? args[sessIdx + 1] : null,
              },
            ];
            return queueReply();
          }
          if (op === "drain") {
            items = items.slice(1);
            return out([
              { type: "drain", result: "sent", item_id: "q1", held: false, hold_reason: null, remaining: items.length },
            ]);
          }
          return queueReply();
        },
      });

      const m = await mount("bw-chat", { props: {}, live: data });

      // 1. User hits Enter while working; `queue add` is still in flight when agent flips working -> done.
      await typeText(m, "in-flight follow-up");
      const state = textarea(m).attrs.state;
      inspect(state).value = "in-flight follow-up\n";
      await emit(state, "change", {}, m.cx);
      await emit(state, "submit", { shift: false }, m.cx);
      await m.cx.flush();
      expect(typeof releaseAdd).toBe("function");

      // Agent finishes BEFORE `queue add` resolves -> render observes working -> done with empty session.queue.
      fake.panes[0].status = "done";
      fake.terminals[0].status = "done";
      fake.agents[0].status = "done";
      fake.spaces[0].status = "done";
      fake.spaces[0].tabs[0].status = "done";
      m.render();
      expect(m.view.session?.status).toBe("done");
      expect(m.view.session?.queue.items).toHaveLength(0);

      // Now `queue add` resolves on the already-done session -> schedules and executes drain automatically!
      releaseAdd?.();
      await m.cx.flush();
      m.render();
      const drainsAfterAdd = calls(m, "queue").filter(([, a]) => a[4] === "drain");
      expect(drainsAfterAdd).toHaveLength(1);
      expect(items).toEqual([]);

      // 2. External enqueue (e.g. bw-diff Queue review) arrives on an already-idle session -> readQueue schedules drain!
      clock += 15_000;
      items = [
        {
          id: "q-ext",
          text: "external diff review",
          at_ms: clock,
          expect_kind: "claude",
          expect_session: CLAUDE_SESSION,
        },
      ];
      await nextPoll(m);
      await m.cx.flush();
      const drainsAfterList = calls(m, "queue").filter(([, a]) => a[4] === "drain");
      expect(drainsAfterList).toHaveLength(2);
      expect(items).toEqual([]);
    } finally {
      Date.now = RealNow;
    }
  });

  test("renders PR status chip with Merge PR on null reviewDecision, opens PR with Chrome up fallback, runs PR skills, and clears stale PR on branch change", async () => {
    const data = stackLive();
    let chromeRunning = false;
    let prOffline = false;
    data.exec = bwAndGit({
      feed: () => out(golden("claude-approval", "t1", CLAUDE_PATH)),
      pr: () =>
        prOffline
          ? out([{ type: "error", code: "offline", message: "dial tcp timeout" }], 1)
          : out([
              {
                type: "pr",
                cached: false,
                age_s: 0,
                pr: {
                  number: 88,
                  title: "Refine Flockbook Cockpit",
                  url: "https://github.com/acme/alpha/pull/88",
                  state: "OPEN",
                  isDraft: false,
                  reviewDecision: null,
                  headRefName: "feat/cockpit",
                  headRefOid: HEAD_SHA,
                  baseRefName: "main",
                  mergeStateStatus: "CLEAN",
                  passing: 4,
                  pending: 0,
                  failing: 0,
                  unresolvedThreads: 0,
                  updatedAt: "2026-11-13T18:00:00Z",
                },
              },
            ]),
      browser: (args) => {
        if (args[0] === "new") {
          if (!chromeRunning) {
            return out([{ type: "tab-action", action: "new", ok: false, message: "Chrome is not running (stopped)" }]);
          }
          return out([{ type: "tab-action", action: "new", ok: true, id: "tab-pr" }]);
        }
        if (args[0] === "up") {
          chromeRunning = true;
          return out([{ type: "chrome", state: "running" }]);
        }
        return out([]);
      },
      send: () => out([{ type: "send", result: "sent" }]),
    });

    const m = await mount("bw-chat", { props: {}, live: data });
    expect(byId(m.el, "pr-strip")).not.toBe(null);
    expect(textOf(byId(m.el, "pr-strip"))).toContain("#88");
    expect(textOf(byId(m.el, "pr-strip"))).toContain("4 passing");
    // Merge PR button renders even when reviewDecision is null (repo without required reviews).
    expect(byId(m.el, "pr-merge")).not.toBe(null);
    // Shared bw.pr-summary is populated for bw-tabs and bw-needs.
    expect(fake.shared["bw.pr-summary"]).toEqual({
      s1: expect.objectContaining({
        state: "OPEN",
        number: 88,
        mergeReady: true,
        attention: false,
      }),
    });

    // Clicking Open PR reveals right Browser tab, starts Chrome on stopped fallback, and opens the URL without --space.
    await m.click("pr-open");
    expect(m.log.run).toContainEqual(["layout.show", { id: "right" }]);
    expect(m.log.run).toContainEqual(["layout.select", { stack: "right-body", child: "browser" }]);
    expect(calls(m, "browser").map(([, a]) => a.slice(4))).toEqual([
      ["new", "--url", "https://github.com/acme/alpha/pull/88"],
      ["up"],
      ["new", "--url", "https://github.com/acme/alpha/pull/88"],
    ]);

    // Clicking Babysit PR and Merge PR sends `/babysit-pr 88` and `/merge-pr 88` via `bw send` (zero `gh pr merge` calls!).
    await m.click("pr-babysit");
    await m.click("pr-merge");
    const sentTexts = calls(m, "send").map(([, a]) => a[a.indexOf("--text") + 1]);
    expect(sentTexts).toEqual(["/babysit-pr 88", "/merge-pr 88"]);
    expect(m.log.exec.some(([c, a]) => c === "gh" || a.includes("merge"))).toBe(false);

    // Switching branches when the new branch's PR fetch fails offline clears the previous branch's PR chip, Merge PR button, and bw.pr-summary immediately!
    prOffline = true;
    fake.spaces[0].branch = "feat/new-unpushed";
    m.render();
    expect(byId(m.el, "pr-strip")).toBe(null);
    expect(byId(m.el, "pr-merge")).toBe(null);
    expect(fake.shared["bw.pr-summary"]).toEqual({});
    await nextPoll(m);
    expect(byId(m.el, "pr-strip")).toBe(null);
    expect(fake.shared["bw.pr-summary"]).toEqual({});
  });
});
