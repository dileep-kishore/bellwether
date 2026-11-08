import { describe, expect, test } from "bun:test";
import {
  addChip,
  chatTabOf,
  chipFrom,
  chipsFor,
  clearChips,
  composeMessage,
  needsChoice,
  removeChip,
  setChipMode,
  textArgs,
} from "./linear-attach.js";

const line = (identifier, description = "short") => ({
  type: "linear-issue",
  identifier,
  title: `Title ${identifier}`,
  url: `https://linear.app/x/issue/${identifier}`,
  state: { name: "Todo" },
  description,
  bytes: new TextEncoder().encode(description).length,
});
const chip = (id, d) => /** @type {any} */ (chipFrom(line(id, d), 5));

describe("chips", () => {
  test("a chip from an issue line keeps a short preview and the size", () => {
    const c = chip("PLA-1", "é".repeat(5000));
    expect(c.preview.length).toBe(400);
    expect(c.bytes).toBe(10000);
    expect(c.state).toBe("Todo");
    expect(chipFrom({ identifier: "not an id" }, 1)).toBe(null);
    // Without bw's count the description is measured in UTF-8.
    expect(chipFrom({ identifier: "PLA-3", description: "é€😀" }, 1)?.bytes).toBe(9);
  });

  test("chips belong to their tab and are added once", () => {
    let s = addChip(undefined, "tabA", chip("PLA-1"), ["tabA", "tabB"]);
    s = addChip(s, "tabA", chip("PLA-1"), ["tabA", "tabB"]);
    s = addChip(s, "tabB", chip("PLA-2"), ["tabA", "tabB"]);
    expect(chipsFor(s, "tabA").map((c) => c.identifier)).toEqual(["PLA-1"]);
    expect(chipsFor(s, "tabB").map((c) => c.identifier)).toEqual(["PLA-2"]);
    expect(chipsFor(s, null)).toEqual([]);
    // A tab that closed loses its chips on the next add.
    s = addChip(s, "tabA", chip("PLA-3"), ["tabA"]);
    expect(chipsFor(s, "tabB")).toEqual([]);
  });

  test("remove, clear and mode", () => {
    let s = addChip(undefined, "t", chip("PLA-1"), ["t"]);
    s = addChip(s, "t", chip("PLA-2", "x".repeat(9000)), ["t"]);
    expect(needsChoice(chipsFor(s, "t")[1])).toBe(true);
    s = setChipMode(s, "t", "PLA-2", "file");
    expect(needsChoice(chipsFor(s, "t")[1])).toBe(false);
    expect(chipsFor(removeChip(s, "t", "PLA-1"), "t").map((c) => c.identifier)).toEqual(["PLA-2"]);
    expect(clearChips(s, "t", ["PLA-1", "PLA-2"]).tabs).toEqual({});
  });
});

describe("text", () => {
  test("args per mode; a short description ignores the mode", () => {
    const long = { ...chip("PLA-2", "x".repeat(9000)) };
    expect(textArgs(long, "macbook/t7")).toEqual(["linear", "issue", "--id", "PLA-2", "--text"]);
    expect(textArgs({ ...long, mode: "trim" }, "macbook/t7")).toEqual([
      "linear",
      "issue",
      "--id",
      "PLA-2",
      "--text",
      "--trim",
    ]);
    expect(textArgs({ ...long, mode: "file" }, "macbook/t7")).toEqual([
      "linear",
      "issue",
      "--id",
      "PLA-2",
      "--text",
      "--put",
      "macbook/t7",
    ]);
    expect(textArgs({ ...chip("PLA-1"), mode: "file" }, "t1")).toEqual(["linear", "issue", "--id", "PLA-1", "--text"]);
  });

  test("issue texts come first, then the message", () => {
    const a = "Linear issue PLA-1: One\nhttps://u\n\n---\n";
    const b = "Linear issue PLA-2: Two\nhttps://v\n\n---\n";
    expect(composeMessage([a, b], "fix it")).toBe(`${a}${b}fix it`);
    expect(composeMessage([a], "")).toBe("Linear issue PLA-1: One\nhttps://u\n\n---");
    expect(composeMessage([], "hi")).toBe("hi");
  });
});

describe("chatTabOf", () => {
  const spaces = [
    {
      id: "s1",
      active: true,
      tabs: [
        { id: "t1", active: false },
        { id: "t2", active: true },
      ],
    },
  ];
  test("the active tab when it holds a chat", () => {
    expect(chatTabOf(spaces, [{ pane: "p", tab: "t2", mod: "bw-chat" }])).toBe("t2");
  });
  test("none when the active tab is a terminal or no space is active", () => {
    expect(chatTabOf(spaces, [{ pane: "p", tab: "t1", mod: "bw-chat" }])).toBe(null);
    expect(chatTabOf([{ ...spaces[0], active: false }], [{ pane: "p", tab: "t2", mod: "bw-chat" }])).toBe(null);
  });
});
