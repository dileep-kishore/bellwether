import { expect, test } from "bun:test";
import { RANK, worst } from "./status.js";

test("rank: blocked > done > working > idle", () => {
  expect(worst(["idle", "done", "working"])).toBe("done");
  expect(worst([null, "blocked", "done"])).toBe("blocked");
  expect(worst([null])).toBe(null);
  expect(worst([])).toBe(null);
  expect(worst(["idle"])).toBe("idle");
  expect(RANK).toEqual({ idle: 0, working: 1, done: 2, blocked: 3 });
});

test("words outside the four statuses are ignored", () => {
  expect(worst(["error", undefined, "working"])).toBe("working");
  expect(worst(["error"])).toBe(null);
});
