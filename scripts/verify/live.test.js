import { expect, test } from "bun:test";
import { aboveFooter } from "./live.js";

const RULE = "─".repeat(40);
const idle = (clock) => ["● done", "", RULE, '❯ Try "write a test for <filepath>"', RULE,
  "  INS | Opus 5.5 · high | main", `  ░░░░░░░░░░ 0% | $0.00 | ${clock}`, "  -- INSERT -- ⏸ manual mode on · ← for agents", ""].join("\n");

test("aboveFooter drops Claude's footer below the input box and keeps the box", () => {
  expect(aboveFooter(idle("0m 8s"))).toBe(aboveFooter(idle("0m 9s")));
  expect(aboveFooter(idle("0m 8s")).endsWith(`❯ Try "write a test for <filepath>"\n${RULE}`)).toBe(true);
  // A key typed into the box still shows as a change.
  expect(aboveFooter(idle("0m 8s").replace("❯ Try", "❯ 1"))).not.toBe(aboveFooter(idle("0m 8s")));
});

test("aboveFooter gives back a screen with no rule near its end whole", () => {
  const codex = "› Ask Codex to do anything\n\n  GPT-6.1-Sol low · /scratch\n  ← for agents · ? for shortcuts";
  expect(aboveFooter(codex)).toBe(codex);
});
