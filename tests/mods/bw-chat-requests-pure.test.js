// bw-chat's pure request modules: the threads card rows, the dock cards and the 3 s focus guard.
import { describe, expect, test } from "bun:test";
import { barText, cardOpen, pillText, runningIds, threadRows, toggleCard } from "../../mods/bw-chat/threads-model.js";
import {
  RESOLVED_SHOW_MS,
  answerArgs,
  answerNote,
  answersOf,
  complete,
  digit,
  dockCards,
  emptyDraft,
  pick,
  setOther,
  stateNote,
  titleOf,
  toggle,
} from "../../mods/bw-chat/dock-model.js";
import {
  FOCUS_QUIET_MS,
  createGuard,
  guardedUntil,
  isGuarded,
  observe,
  observeLeft,
} from "../../mods/bw-chat/focus-guard.js";
import { emptyFeed, expectation, applyFeed } from "../../mods/bw-chat/feedstate.js";

const ROOT = "a9baa480-8207-4b0a-b31c-1a2d7b062db3";
const MIN = 60_000;

/** A `tree` line with claude-subagents/expect.json's ids, parents and depths; the nested child listed first. */
function subagentsTree() {
  const c = (id, type, depth, parent, started_ms, extra = {}) => ({
    id,
    parent,
    depth,
    type,
    nickname: null,
    description: `${type} ${id.slice(0, 4)}`,
    tool_use_id: `toolu_${id}`,
    background: false,
    state: "done",
    started_ms,
    ended_ms: started_ms + 2 * MIN,
    ...extra,
  });
  return {
    type: "tree",
    agent: "claude",
    root: ROOT,
    children: [
      c("a640ed49983e1482a", "counter", 2, "ad16657758350f019", 4 * MIN),
      c("af5540ee6b3545d64", "counter", 1, ROOT, 1 * MIN),
      c("af4a6ac6955ed1eb6", "counter", 1, ROOT, 2 * MIN, { background: true }),
      c("ad16657758350f019", "nester", 1, ROOT, 3 * MIN),
    ],
  };
}

const root = { terminal: "t5", kind: "claude", name: "Claude" };

/** A request line as `bw cards` prints it (decision 9). */
const req = (extra = {}) => ({
  type: "request",
  id: "r3.1",
  kind: "approval",
  state: "pending",
  answerable: true,
  reason: null,
  who: null,
  title: "Bash command",
  tool: "Bash",
  command: "touch a.txt",
  detail: "",
  actions: [
    { id: "approve", label: "Yes" },
    { id: "deny", label: "No" },
  ],
  question: null,
  unread: 0,
  screen_id: "s-1",
  event: null,
  tool_use_id: "toolu_1",
  at_ms: 1000,
  resolved_ms: null,
  ...extra,
});

const exp = { kind: "claude", session: "s1", path: "/p" };
const opts = (extra = {}) => ({
  now: 5000,
  guarded: false,
  sending: new Set(),
  agentName: "Claude",
  expect: exp,
  ...extra,
});
const btn = (card, id) => card.buttons.find((b) => b.id === id);
const answerButtons = (card) => card.buttons.filter((b) => b.id !== "terminal");

describe("threads model", () => {
  test("rows nest the nested counter under nester", () => {
    const rows = threadRows(subagentsTree(), [], [], root, 10 * MIN);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 1, 2]);
    expect(rows.map((r) => r.id)).toEqual([
      ROOT,
      "af5540ee6b3545d64",
      "af4a6ac6955ed1eb6",
      "ad16657758350f019",
      "a640ed49983e1482a",
    ]);
    expect(rows[0]).toMatchObject({ kind: "parent", type: "Claude", open: null });
    expect(rows[4]).toMatchObject({
      kind: "child",
      type: "counter",
      state: "done",
      open: { child: "a640ed49983e1482a" },
    });
  });

  test("a child whose parent is missing joins the root; a cycle is listed once", () => {
    const tree = {
      type: "tree",
      agent: "codex",
      root: "r",
      children: [
        { id: "x", parent: "gone", depth: 3, type: "w", state: "running", started_ms: 0 },
        { id: "y", parent: "z", depth: 1, type: "w", state: "running", started_ms: 1 },
        { id: "z", parent: "y", depth: 1, type: "w", state: "running", started_ms: 2 },
      ],
    };
    const rows = threadRows(tree, [], [], root, 0);
    expect(rows.map((r) => r.id)).toEqual(["r", "x", "y", "z"]);
    expect(rows[1].depth).toBe(1);
  });

  test("time is how long a child has run, or ran", () => {
    const tree = {
      type: "tree",
      agent: "claude",
      root: "r",
      children: [
        { id: "a", parent: "r", depth: 1, type: "Explore", state: "running", started_ms: 0, ended_ms: null },
        { id: "b", parent: "r", depth: 1, type: "Plan", state: "done", started_ms: 1000, ended_ms: 46_000 },
        { id: "c", parent: "r", depth: 1, type: "Plan", state: "running", started_ms: null },
      ],
    };
    const rows = threadRows(tree, [], [], root, 4 * MIN + 5000);
    expect(rows.slice(1).map((r) => r.since)).toEqual(["4m", "45s", ""]);
    expect(threadRows(tree, [], [], root, 3 * 3_600_000).at(1)?.since).toBe("3h");
  });

  test("terminal children join at depth 1", () => {
    const terminals = [
      {
        address: "t7",
        parent: "t5",
        state: "live",
        status: "working",
        name: "helper",
        program: { key: "claude", name: "Claude Code" },
      },
      { address: "t8", parent: "t5", state: "exited", status: "idle", program: { key: "shell", name: "zsh" } },
      { address: "t9", parent: "t2", state: "live", status: "working", program: { key: "shell", name: "zsh" } },
      { address: "t6", parent: "t5", status: "blocked", title: "codex", program: { key: "codex", name: "Codex" } },
    ];
    const rows = threadRows(subagentsTree(), terminals, [], root, 10 * MIN);
    const term = rows.filter((r) => r.kind === "terminal");
    expect(term.map((r) => [r.id, r.depth, r.type, r.state])).toEqual([
      ["t7", 1, "Claude Code", "running"],
      ["t6", 1, "Codex", "asks"],
    ]);
    expect(term[0].open).toEqual({ terminal: "t7" });
  });

  test("a remote chat's terminal children name a bare parent on their own machine", () => {
    const terminals = [
      { address: "macmini/t7", parent: "t5", state: "live", status: "idle", program: { name: "zsh" } },
    ];
    const rows = threadRows(null, terminals, [], { ...root, terminal: "macmini/t5" }, 0);
    expect(rows.map((r) => [r.id, r.kind, r.state])).toEqual([
      ["macmini/t5", "parent", "running"],
      ["macmini/t7", "terminal", "done"],
    ]);
  });

  test("pending requests count on the child that asks, and on the parent", () => {
    const requests = [
      req({ id: "r1", who: { child: "ad16657758350f019", agent_type: "nester", description: "", depth: 1 } }),
      req({ id: "r2", who: null }),
      req({ id: "r3", who: { child: "ad16657758350f019" }, state: "answered", resolved_ms: 1 }),
    ];
    const rows = threadRows(subagentsTree(), [], requests, root, 10 * MIN);
    const nester = rows.find((r) => r.id === "ad16657758350f019");
    expect(nester).toMatchObject({ requests: 1, state: "asks" });
    expect(rows[0]).toMatchObject({ requests: 1, state: "asks" });
  });

  test("two children asking one box both count", () => {
    const who = [
      { child: "af5540ee6b3545d64", agent_type: "counter" },
      { child: "ad16657758350f019", agent_type: "nester" },
    ];
    const rows = threadRows(subagentsTree(), [], [req({ who })], root, 10 * MIN);
    expect(rows.filter((r) => r.state === "asks").map((r) => r.id)).toEqual(["af5540ee6b3545d64", "ad16657758350f019"]);
  });

  test("the parent row follows the agent's status when given", () => {
    expect(threadRows(null, [], [], { ...root, status: "idle" }, 0)[0].state).toBe("done");
    expect(threadRows(null, [], [], { ...root, status: "working" }, 0)[0].state).toBe("running");
    expect(threadRows(null, [], [], { ...root, status: "blocked" }, 0)[0].state).toBe("asks");
  });

  test("pill text and open rule", () => {
    const tree = subagentsTree();
    tree.children[1].state = "running";
    tree.children[2].state = "running";
    const rows2running1asks = threadRows(tree, [], [req({ who: { child: tree.children[2].id } })], root, 10 * MIN);
    expect(pillText(rows2running1asks)).toBe("4 sub-agents · 1 asks");
    const two = threadRows(
      { ...tree, children: tree.children.slice(1, 3) },
      [],
      [req({ who: { child: tree.children[2].id } })],
      root,
      0,
    );
    expect(pillText(two)).toBe("2 sub-agents · 1 asks");
    expect(pillText(threadRows({ ...tree, children: [tree.children[1]] }, [], [], root, 0))).toBe("1 sub-agent");
    expect(pillText(threadRows(null, [], [], root, 0))).toBe("No sub-agents");

    expect(runningIds(two)).toEqual([tree.children[1].id, tree.children[2].id].sort());
    expect(cardOpen(two, null)).toBe(true);
    const folded = toggleCard(two, null);
    expect(folded).toEqual({ open: false, running: runningIds(two) });
    expect(cardOpen(two, folded)).toBe(false);
    // The fold holds while the same children run, then the default comes back.
    const oneLeft = threadRows({ ...tree, children: [tree.children[1]] }, [], [], root, 0);
    expect(cardOpen(oneLeft, folded)).toBe(true);
    const allDone = threadRows(subagentsTree(), [], [], root, 0);
    expect(cardOpen(allDone, null)).toBe(false);
    expect(cardOpen(allDone, toggleCard(allDone, null))).toBe(true);
    expect(cardOpen(threadRows(null, [], [], root, 0), null)).toBe(false);
  });

  test("bar text", () => {
    const explore = {
      id: "c",
      kind: "child",
      depth: 1,
      state: "running",
      type: "Explore",
      description: "",
      since: "",
      requests: 0,
      open: { child: "c" },
    };
    expect(barText(explore, "Claude")).toBe("Explore · sub-agent of Claude · running");
    expect(barText({ ...explore, state: "done" }, "Codex")).toBe("Explore · sub-agent of Codex · done");
    expect(barText({ ...explore, state: "asks" }, "Claude")).toBe(
      "Explore · sub-agent of Claude · waiting for an answer",
    );
  });
});

describe("dock model", () => {
  test("approval card: title, buttons, always only when offered", () => {
    const [plain] = dockCards([req()], opts());
    expect(plain).toMatchObject({
      id: "r3.1",
      kind: "approval",
      title: "Approval needed from Claude",
      who: "Claude",
      tool: "Bash",
      command: "touch a.txt",
      state: "pending",
      note: null,
    });
    expect(plain.buttons.map((b) => [b.id, b.label, b.enabled, b.primary])).toEqual([
      ["approve", "Approve", true, true],
      ["deny", "Deny", true, false],
      ["terminal", "Answer in terminal", true, false],
    ]);

    const always = { id: "always", label: "Yes, and always allow access to /scratch from this project" };
    const who = { child: "c1", agent_type: "Explore", description: "look around", depth: 1 };
    const [child] = dockCards(
      [req({ who, actions: [{ id: "approve", label: "Yes" }, always, { id: "deny", label: "No" }] })],
      opts(),
    );
    expect(child.title).toBe("Approval needed from Explore");
    expect(child.buttons.map((b) => b.id)).toEqual(["approve", "always", "deny", "terminal"]);
    expect(btn(child, "always").label).toBe(always.label);
  });

  test("two children on one box are both named", () => {
    const who = [
      { child: "a", agent_type: "counter" },
      { child: "b", agent_type: "nester" },
    ];
    expect(titleOf(req({ who }), "Claude")).toBe("Approval needed from counter and nester");
    expect(titleOf(req({ kind: "question", who: { child: "a", agent_type: "" } }), "Claude")).toBe("A sub-agent asks");
    expect(titleOf(req({ kind: "question_async" }), "Codex")).toBe("Codex asks");
  });

  test("guarded or sending disables every answer button but Answer in terminal", () => {
    for (const o of [opts({ guarded: true }), opts({ sending: new Set(["r3.other"]) })]) {
      const [card] = dockCards([req()], o);
      expect(answerButtons(card).every((b) => !b.enabled)).toBe(true);
      expect(btn(card, "terminal").enabled).toBe(true);
    }
    const [mine] = dockCards([req()], opts({ sending: new Set(["r3.1"]) }));
    expect(mine).toMatchObject({ state: "sending", note: "Sending…" });
  });

  test("no expectation disables every answer button but Answer in terminal", () => {
    for (const o of [opts({ expect: null }), { now: 5000, guarded: false, sending: new Set(), agentName: "Claude" }]) {
      const [card] = dockCards([req()], o);
      expect(answerButtons(card).every((b) => !b.enabled)).toBe(true);
      expect(btn(card, "terminal").enabled).toBe(true);
    }
  });

  test("resolved cards stay 10 s with their note", () => {
    const lines = [
      req({ id: "a", state: "answered", resolved_ms: 1000 }),
      req({ id: "d", state: "declined", resolved_ms: 1000 }),
      req({ id: "t", state: "answered_terminal", resolved_ms: 1000 }),
      req({ id: "dt", state: "declined_terminal", resolved_ms: 1000 }),
      req({ id: "s", state: "stale", resolved_ms: 1000 }),
      req({ id: "u", state: "uncertain", resolved_ms: 1000 }),
      req({ id: "q", kind: "question", state: "answered", resolved_ms: 1000 }),
    ];
    const shown = dockCards(lines, opts({ now: 1000 + RESOLVED_SHOW_MS - 1 }));
    expect(shown.map((c) => [c.id, c.note])).toEqual([
      ["a", "Approved"],
      ["d", "Denied"],
      ["t", "Answered in the terminal"],
      ["dt", "Denied in the terminal"],
      ["s", "Changed on screen; nothing was pressed"],
      ["u", "Sent, but the screen did not change. Check the terminal (⌘J)."],
      ["q", "Answered"],
    ]);
    expect(shown.find((c) => c.id === "a")?.buttons).toEqual([]);
    expect(shown.find((c) => c.id === "s")?.buttons.map((b) => b.id)).toEqual(["terminal"]);
    expect(shown.find((c) => c.id === "u")?.buttons.map((b) => b.id)).toEqual(["terminal"]);
    expect(dockCards(lines, opts({ now: 1000 + RESOLVED_SHOW_MS }))).toEqual([]);
    expect(dockCards([req({ resolved_ms: 0 })], opts({ now: 1e9 }))).toHaveLength(1);
  });

  test("a settling card offers nothing until bw cards settles it", () => {
    const [card] = dockCards([req({ state: "settling", answerable: false, resolved_ms: null })], opts({ now: 1e9 }));
    expect(card.state).toBe("settling");
    expect(card.note).toBe("Left the screen; checking who answered");
    expect(card.buttons).toEqual([]);
  });

  test("show-only card has only Answer in terminal and its note", () => {
    const cases = [
      ["codex_child", "Codex sub-agent approvals are answered in the terminal for now"],
      ["clipped", "Command too long to show here. Read it in the terminal"],
      ["ambiguous", "Claude's conversation cannot be read (ambiguous)"],
      ["no_match", "Bellwether cannot read this prompt. Answer it in the terminal"],
      ["multi_question", "This prompt has several questions. Answer it in the terminal"],
      ["other_view", "Answer it in that sub-agent's own chat"],
      ["something_new", "Answer it in the terminal"],
    ];
    for (const [reason, note] of cases) {
      const [card] = dockCards([req({ answerable: false, reason })], opts());
      expect(card.buttons.map((b) => [b.id, b.enabled])).toEqual([["terminal", true]]);
      expect(card.note).toBe(note);
    }
  });

  test("newest last, one card per id", () => {
    const cards = dockCards(
      [req({ id: "b", at_ms: 3 }), req({ id: "a", at_ms: 1 }), req({ id: "b", at_ms: 3, command: "touch b.txt" })],
      opts(),
    );
    expect(cards.map((c) => [c.id, c.command])).toEqual([
      ["a", "touch a.txt"],
      ["b", "touch b.txt"],
    ]);
  });

  test("folder prompt card: its title, one button per option, no Always or Deny", () => {
    const prompt = req({
      id: "r3.f",
      kind: "prompt",
      tool: "new_conversation",
      command: "",
      actions: [
        { id: "option-1", label: "Here (/scratch/repo)" },
        { id: "option-2", label: "A new worktree" },
      ],
    });
    const [card] = dockCards(
      [prompt],
      opts({ agentName: "Codex", expect: { kind: "codex", session: "none", path: "none" } }),
    );
    expect(card.title).toBe("Codex asks where the new conversation should run");
    expect(card.buttons.map((b) => [b.id, b.label, b.primary, b.enabled])).toEqual([
      ["option-1", "Here (/scratch/repo)", true, true],
      ["option-2", "A new worktree", false, true],
      ["terminal", "Answer in terminal", false, true],
    ]);
    expect(
      answerArgs(
        prompt,
        { action: "option-2" },
        { local: "t3" },
        { kind: "codex", session: "s9", path: "/l/s9.jsonl" },
      ),
    ).toEqual([
      "answer",
      "--terminal",
      "t3",
      "--request",
      "r3.f",
      "--expect-kind",
      "codex",
      "--expect-session",
      "s9",
      "--expect-path",
      "/l/s9.jsonl",
      "--action",
      "option-2",
    ]);
  });

  test("question card: Submit and Answer in terminal, the question passed through", () => {
    const question = {
      toolUseId: "toolu_q",
      agent: "claude",
      delivery: "picker",
      state: "pending",
      questions: [
        { id: "Pick?", header: "Color", text: "Pick?", multi: false, options: [{ label: "Red" }, { label: "Blue" }] },
      ],
    };
    const [card] = dockCards([req({ kind: "question", actions: [], question, unread: 1 })], opts());
    expect(card.title).toBe("Claude asks");
    expect(card.question).toBe(question);
    expect(card.buttons.map((b) => [b.id, b.label, b.primary])).toEqual([
      ["submit", "Submit", true],
      ["terminal", "Answer in terminal", false],
    ]);
  });

  test("answerArgs for approve and for answers", () => {
    const r = req();
    expect(answerArgs(r, { action: "approve" }, { local: "t5" }, exp)).toEqual([
      "answer",
      "--terminal",
      "t5",
      "--request",
      r.id,
      "--expect-kind",
      "claude",
      "--expect-session",
      "s1",
      "--expect-path",
      "/p",
      "--action",
      "approve",
    ]);
    const q = req({ kind: "question", actions: [] });
    expect(answerArgs(q, { answers: [{ picks: [1] }, { picks: [], other: "huge" }] }, { local: "t5" }, exp)).toEqual([
      "answer",
      "--terminal",
      "t5",
      "--request",
      q.id,
      "--expect-kind",
      "claude",
      "--expect-session",
      "s1",
      "--expect-path",
      "/p",
      "--answers",
      '[{"picks":[1]},{"picks":[],"other":"huge"}]',
    ]);
  });

  test("answerArgs after /new passes the new session with path none", () => {
    const feed = emptyFeed("t5");
    applyFeed(feed, {
      ok: true,
      lines: [
        {
          type: "log",
          agent: "codex",
          terminal: "t5",
          session: "old",
          path: "/l/old.jsonl",
          start: 0,
          size: 1,
          cursor: "c",
        },
        { type: "splice", at: 0, count: 0 },
      ],
    });
    applyFeed(feed, { ok: true, lines: [{ type: "state", state: "no_log", agent: "codex", session: "new" }] });
    const e = expectation(feed, "codex");
    expect(e).toEqual({ session: "new", path: "none" });
    expect(answerArgs(req(), { action: "deny" }, { local: "t5" }, { kind: "codex", ...e }).slice(5)).toEqual([
      "--expect-kind",
      "codex",
      "--expect-session",
      "new",
      "--expect-path",
      "none",
      "--action",
      "deny",
    ]);
  });

  test("answerArgs refuses what the card does not offer", () => {
    expect(() => answerArgs(req(), { action: "always" }, { local: "t5" }, exp)).toThrow();
    expect(() => answerArgs(req(), { action: "approve" }, { local: "t5" }, null)).toThrow();
    expect(() => answerArgs(req(), { answers: [{ picks: [0] }] }, { local: "t5" }, exp)).toThrow();
    expect(() => answerArgs(req({ kind: "question" }), { action: "approve" }, { local: "t5" }, exp)).toThrow();
    expect(() => answerArgs(req(), { action: "approve" }, { local: "" }, exp)).toThrow();
  });

  test("state and answer notes", () => {
    expect(stateNote("answered", "prompt")).toBe("Answered");
    expect(stateNote("pending")).toBeNull();
    expect(
      answerNote({ type: "answer", result: "answered", state: "answered", message: "" }, "approval", "Claude"),
    ).toBe("Approved");
    expect(answerNote({ type: "answer", result: "stale", state: "stale", message: "" }, "approval", "Claude")).toBe(
      "Changed on screen; nothing was pressed",
    );
    expect(answerNote({ type: "answer", result: "stale", state: "settling", message: "" }, "approval", "Claude")).toBe(
      "Changed on screen; nothing was pressed",
    );
    expect(
      answerNote(
        { type: "answer", result: "refused-conversation", state: "pending", message: "" },
        "approval",
        "Claude",
      ),
    ).toBe("Claude moved to another conversation; nothing was pressed");
    expect(
      answerNote({ type: "answer", result: "failed", state: "pending", message: "hc timed out" }, "approval", "Claude"),
    ).toBe("Not sent (hc timed out)");
  });
});

describe("question drafts", () => {
  const question = {
    questions: [
      { id: "a", text: "Color?", multi: false, options: [{ label: "Red" }, { label: "Blue" }] },
      { id: "b", text: "Fruits?", multi: true, options: [{ label: "Apple" }, { label: "Pear" }, { label: "Fig" }] },
    ],
  };

  test("pick, toggle and Other build the answers", () => {
    let d = emptyDraft(question);
    expect(d.step).toBe(0);
    expect(complete(d)).toBe(false);
    d = pick(d, 0, 1);
    expect(d.step).toBe(1);
    d = toggle(d, 1, 2);
    d = toggle(d, 1, 0);
    d = toggle(d, 1, 2);
    expect(answersOf(d)).toEqual([{ picks: [1] }, { picks: [0] }]);
    expect(complete(d)).toBe(true);
    d = setOther(d, 1, "  kiwi ");
    expect(answersOf(d)).toEqual([{ picks: [1] }, { picks: [0], other: "kiwi" }]);
    // A single-choice question takes one answer: Other text replaces the pick, and a pick clears the text.
    d = setOther(d, 0, "green");
    expect(answersOf(d)[0]).toEqual({ picks: [], other: "green" });
    d = pick(d, 0, 0);
    expect(answersOf(d)[0]).toEqual({ picks: [0] });
  });

  test("out-of-range picks change nothing", () => {
    const d = emptyDraft(question);
    expect(pick(d, 0, 2)).toBe(d);
    expect(toggle(d, 5, 0)).toBe(d);
    expect(setOther(d, 9, "x")).toBe(d);
  });

  test("digit selects and never submits", () => {
    let d = emptyDraft(question);
    const after = digit(d, 0, 2);
    expect(answersOf(after)[0]).toEqual({ picks: [1] });
    expect(Object.keys(after).sort()).toEqual(Object.keys(d).sort());
    d = digit(after, 1, 3);
    expect(answersOf(d)[1]).toEqual({ picks: [2] });
    for (const n of [0, 4, 10, 1.5]) expect(digit(d, 1, n)).toBe(d);
  });

  test("a question with no options is answered by Other only", () => {
    let d = emptyDraft({ questions: [{ id: "x", text: "Why?", options: [] }] });
    expect(complete(d)).toBe(false);
    d = setOther(d, 0, "because");
    expect(answersOf(d)).toEqual([{ picks: [], other: "because" }]);
    expect(complete(emptyDraft(null))).toBe(false);
  });
});

describe("focus guard", () => {
  test("guard holds 3 s after focus leaves", () => {
    let g = createGuard(0);
    g = observe(g, "t5", "t5", 100);
    expect(isGuarded(g, 2000)).toBe(true);
    expect(guardedUntil(g)).toBe(Infinity);
    g = observe(g, "t9", "t5", 5000);
    expect(guardedUntil(g)).toBe(5000 + FOCUS_QUIET_MS);
    expect(isGuarded(g, 7999)).toBe(true);
    expect(isGuarded(g, 8000)).toBe(false);
  });

  test("fresh mount is guarded", () => {
    const g = createGuard(1000);
    expect(isGuarded(g, 3999)).toBe(true);
    expect(isGuarded(g, 4000)).toBe(false);
  });

  test("focus away keeps its start; coming back guards again", () => {
    let g = observe(createGuard(0), "t9", "t5", 4000);
    expect(isGuarded(g, 4000)).toBe(false);
    const same = observe(g, null, "t5", 9000);
    expect(same).toBe(g);
    g = observe(g, "t5", "t5", 10_000);
    expect(isGuarded(g, 1e12)).toBe(true);
    g = observe(g, null, "t5", 11_000);
    expect(isGuarded(g, 13_999)).toBe(true);
    expect(isGuarded(g, 14_000)).toBe(false);
  });

  test("no target is never focused", () => {
    const g = observe(createGuard(0), null, null, 5000);
    expect(isGuarded(g, 5000)).toBe(false);
  });
});

describe("observeLeft", () => {
  test("a later recorded leave restarts the quiet time; an older one or focus held changes nothing", () => {
    const g = { focused: false, since: 1000 };
    expect(observeLeft(g, 5000)).toEqual({ focused: false, since: 5000 });
    expect(observeLeft(g, 500)).toBe(g);
    expect(observeLeft(g, null)).toBe(g);
    const held = { focused: true, since: 1000 };
    expect(observeLeft(held, 5000)).toBe(held);
  });
});
