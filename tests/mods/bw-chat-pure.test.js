// bw-chat's pure modules: feed state, row heights and markdown blocks.
import { describe, expect, test } from "bun:test";
import { applyFeed, applyOlder, emptyFeed, expectation, olderFrom } from "../../mods/bw-chat/feedstate.js";
import { BUBBLE, GUTTER, READ_W, columnWidth, markdownHeight, rowHeight, sizes } from "../../mods/bw-chat/estimate.js";
import { codeBlockAt, splitBlocks, tableCells } from "../../mods/bw-chat/mdblocks.js";

const log = (extra = {}) => ({
  type: "log",
  agent: "claude",
  terminal: "t8",
  session: "s1",
  path: "/l/s1.jsonl",
  start: 0,
  size: 100,
  cursor: "2.a.0.100.b.1",
  ...extra,
});
const row = (id, k = "assistant", extra = {}) => ({ type: "row", k, id, text: id, ...extra });
const ok = (...lines) => ({ ok: true, lines });
const ids = (state) => state.rows.map((r) => r.id);

/** A state already showing rows a, b, c from the log's start. */
function shown() {
  const s = emptyFeed("t8");
  applyFeed(s, ok(log(), { type: "splice", at: 0, count: 3 }, row("a", "user"), row("b"), row("c")));
  return s;
}

describe("feedstate", () => {
  test("first answer fills the rows and keeps the log's fields", () => {
    const s = emptyFeed("t8");
    expect(s.terminal).toBe("t8");
    expect(applyFeed(s, ok(log({ model: "opus" }), { type: "splice", at: 0, count: 1 }, row("a")))).toBe(0);
    expect(ids(s)).toEqual(["a"]);
    expect(s).toMatchObject({
      path: "/l/s1.jsonl",
      session: "s1",
      agent: "claude",
      cursor: "2.a.0.100.b.1",
      model: "opus",
      start: 0,
      loaded: true,
      error: null,
      waiting: null,
    });
  });

  test("splice replaces rows from at", () => {
    const s = shown();
    const at = applyFeed(s, ok(log({ cursor: "c2" }), { type: "splice", at: 2, count: 2 }, row("c2"), row("d")));
    expect(at).toBe(2);
    expect(ids(s)).toEqual(["a", "b", "c2", "d"]);
    expect(s.cursor).toBe("c2");
  });

  test("a splice past the end appends", () => {
    const s = shown();
    expect(applyFeed(s, ok(log(), { type: "splice", at: 9, count: 1 }, row("d")))).toBe(3);
    expect(ids(s)).toEqual(["a", "b", "c", "d"]);
  });

  test("unchanged changes nothing", () => {
    const s = shown();
    const before = structuredClone(s);
    expect(applyFeed(s, ok(log(), { type: "unchanged" }))).toBe(-1);
    expect(s).toEqual(before);
  });

  test("a new session empties the rows", () => {
    const s = shown();
    const at = applyFeed(s, ok(log({ session: "s2" }), { type: "unchanged" }));
    expect(at).toBe(0);
    expect(ids(s)).toEqual([]);
    expect(s.session).toBe("s2");
  });

  test("a new path empties the rows, older ones too", () => {
    const s = shown();
    s.start = 50;
    applyOlder(s, ok({ type: "older", path: "/l/s1.jsonl", start: 0, count: 1 }, row("z")), 50);
    expect(ids(s)).toEqual(["z", "a", "b", "c"]);
    applyFeed(s, ok(log({ path: "/l/s3.jsonl", start: 0 }), { type: "splice", at: 0, count: 1 }, row("n")));
    expect(ids(s)).toEqual(["n"]);
    expect(olderFrom(s)).toBe(null);
  });

  test("a state line keeps rows and names the wait", () => {
    const s = shown();
    const wait = { type: "state", state: "no_terminal", agent: "claude", message: "terminal t8 is gone" };
    expect(applyFeed(s, ok(wait))).toBe(0);
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(s.waiting).toEqual({ state: "no_terminal", agent: "claude", message: "terminal t8 is gone", session: null });
    expect(applyFeed(s, ok(wait))).toBe(-1);
    expect(applyFeed(s, ok(log(), { type: "unchanged" }))).toBe(0);
    expect(s.waiting).toBe(null);
  });

  test("no log naming another session is a new conversation: rows go, the first message names that session", () => {
    const s = shown();
    expect(expectation(s, "claude")).toEqual({ session: "s1", path: "/l/s1.jsonl" });
    const next = {
      type: "state",
      state: "no_log",
      agent: "claude",
      message: "no claude session log yet",
      session: "s2",
    };
    expect(applyFeed(s, ok(next))).toBe(0);
    expect(ids(s)).toEqual([]);
    expect([s.session, s.path, s.cursor, s.seen]).toEqual(["s2", null, null, true]);
    expect(expectation(s, "claude")).toEqual({ session: "s2", path: "none" });
    expect(expectation(s, "codex")).toBe(null);
    expect(applyFeed(s, ok(next))).toBe(-1);
    applyFeed(s, ok(log({ session: "s2", path: "/l/s2.jsonl" }), { type: "splice", at: 0, count: 1 }, row("n")));
    expect(ids(s)).toEqual(["n"]);
    expect(expectation(s, "claude")).toEqual({ session: "s2", path: "/l/s2.jsonl" });
  });

  test("no log without a session, or naming the shown one, sends nothing once a conversation was shown", () => {
    const s = shown();
    applyFeed(s, ok({ type: "state", state: "no_log", agent: "claude", message: "" }));
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(expectation(s, "claude")).toEqual({ session: "s1", path: "/l/s1.jsonl" });
    const same = shown();
    applyFeed(same, ok({ type: "state", state: "no_log", agent: "claude", message: "", session: "s1" }));
    expect(ids(same)).toEqual(["a", "b", "c"]);
    const fresh = emptyFeed("t8");
    applyFeed(fresh, ok({ type: "state", state: "no_log", agent: "claude", message: "" }));
    expect(expectation(fresh, "claude")).toEqual({ session: "none", path: "none" });
    const named = emptyFeed("t8");
    applyFeed(named, ok({ type: "state", state: "no_log", agent: "claude", message: "", session: "s9" }));
    expect(expectation(named, "claude")).toEqual({ session: "s9", path: "none" });
  });

  test("a helper failure keeps rows and is named once", () => {
    const s = shown();
    const fail = { ok: false, state: "unreachable", message: "macmini is offline" };
    expect(applyFeed(s, fail)).toBe(0);
    expect(applyFeed(s, fail)).toBe(-1);
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(s.error).toEqual({ state: "unreachable", message: "macmini is offline" });
    expect(applyFeed(s, ok(log(), { type: "unchanged" }))).toBe(0);
    expect(s.error).toBe(null);
  });

  test("older rows go on top once", () => {
    const s = emptyFeed("t8");
    applyFeed(s, ok(log({ start: 500 }), { type: "splice", at: 0, count: 2 }, row("c"), row("d")));
    expect(olderFrom(s)).toBe(500);
    const older = ok({ type: "older", path: "/l/s1.jsonl", start: 200, count: 2 }, row("b"), row("c"));
    expect(applyOlder(s, older, 500)).toBe(1);
    expect(ids(s)).toEqual(["b", "c", "d"]);
    expect(olderFrom(s)).toBe(200);
    expect(applyOlder(s, older, 500)).toBe(0);
    expect(ids(s)).toEqual(["b", "c", "d"]);
    expect(applyOlder(s, ok({ type: "older", path: "/l/s1.jsonl", start: 0, count: 1 }, row("a")), 200)).toBe(1);
    expect(ids(s)).toEqual(["a", "b", "c", "d"]);
    expect(olderFrom(s)).toBe(null);
  });

  test("older rows from another path or a failure are ignored", () => {
    const s = emptyFeed("t8");
    applyFeed(s, ok(log({ start: 500 }), { type: "splice", at: 0, count: 1 }, row("c")));
    expect(applyOlder(s, ok({ type: "older", path: "/other", start: 0, count: 1 }, row("x")), 500)).toBe(0);
    expect(applyOlder(s, { ok: false, state: "unreachable", message: "" }, 500)).toBe(0);
    expect(ids(s)).toEqual(["c"]);
  });
});

describe("estimate", () => {
  test("columnWidth caps at 736", () => {
    expect(READ_W).toBe(736);
    expect(columnWidth(2000)).toBe(736);
    expect(columnWidth(600)).toBe(600 - GUTTER * 2);
    expect(columnWidth(100)).toBe(240);
  });

  test("tools row grows when open", () => {
    const tools = { k: "tools", id: "t", chips: [{ calls: [{}, {}] }, { calls: [{}] }] };
    expect(rowHeight(tools, 700)).toBe(28);
    expect(rowHeight(tools, 700, true)).toBe(28 + 3 * 22);
    expect(sizes([tools, { k: "changed", id: "c" }], 700, new Set(["t"]))).toEqual([28 + 66, 28]);
    expect(sizes([tools], 700)).toEqual([28]);
  });

  test("picture row height keeps the aspect ratio up to 320", () => {
    const user = { k: "user", id: "u", text: "" };
    const base = rowHeight(user, 600);
    const wide = { ...user, pics: [{ format: "png", width: 1200, height: 300 }] };
    expect(rowHeight(wide, 600)).toBe(base + 150 + 8);
    const tall = {
      ...user,
      pics: [
        { format: "png", width: 100, height: 1000 },
        { format: "png", width: 600, height: 60 },
      ],
    };
    expect(rowHeight(tall, 600)).toBe(base + (320 + 8) + (60 + 8));
    const unknown = { ...user, pics: [{ format: "png", width: 0, height: 0 }] };
    expect(rowHeight(unknown, 600)).toBe(base + 320 + 8);
  });

  test("a longer message is taller, and a bubble wraps narrower than the column", () => {
    expect(BUBBLE).toBe(0.8);
    const short = rowHeight({ k: "assistant", text: "Done." }, 600);
    const long = rowHeight({ k: "assistant", text: "word ".repeat(400) }, 600);
    expect(long).toBeGreaterThan(short);
    const text = "word ".repeat(200);
    expect(rowHeight({ k: "user", text }, 600)).toBeGreaterThan(rowHeight({ k: "assistant", text }, 600));
  });
});

describe("mdblocks", () => {
  test("splitBlocks finds fences and tables", () => {
    const text = ["Intro", "", "```js", "let a = 1;", "```", "| a | b |", "|---|--:|", "| 1 | `x|y` |", "after"].join(
      "\n",
    );
    expect(splitBlocks(text)).toEqual([
      { k: "md", text: "Intro\n" },
      { k: "code", lang: "js", text: "let a = 1;" },
      { k: "table", head: ["a", "b"], align: ["left", "right"], rows: [["1", "`x|y`"]] },
      { k: "md", text: "after" },
    ]);
    expect(splitBlocks("just text")).toEqual([{ k: "md", text: "just text" }]);
    expect(tableCells("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  test("codeBlockAt finds the code box under a point", () => {
    const text = "```\none\ntwo\n```";
    expect(codeBlockAt(text, 600, 20)).toBe("one\ntwo");
    expect(codeBlockAt(text, 600, 500)).toBe(null);
  });

  test("a ~~~ fence is measured and found as the same code box as a ``` fence", () => {
    const body = Array(100).fill("x();");
    const tilde = ["~~~js", ...body, "~~~"].join("\n");
    const tick = ["```js", ...body, "```"].join("\n");
    expect(splitBlocks(tilde)).toEqual(splitBlocks(tick));
    expect(markdownHeight(tilde, 736)).toBe(markdownHeight(tick, 736));
    expect(rowHeight({ k: "assistant", id: "a", text: tilde }, 736)).toBe(
      rowHeight({ k: "assistant", id: "a", text: tick }, 736),
    );
    expect(codeBlockAt(tilde, 736, 50)).toBe(body.join("\n"));
    // A ``` line inside a ~~~ block is code, as mdblocks.js draws it.
    const mixed = ["~~~", "```", "x", "~~~"].join("\n");
    expect(splitBlocks(mixed)).toEqual([{ k: "code", lang: "", text: "```\nx" }]);
    expect(markdownHeight(mixed, 736)).toBe(markdownHeight(["```", "a", "b", "```"].join("\n"), 736));
  });
});
