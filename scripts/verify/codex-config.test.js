import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDeveloperInstructions } from "./codex-config.js";

const CLI = join(import.meta.dir, "codex-config.js");
const SENTINEL = "User note: the top-level session word is BW-TOP-3M8D.";

const lineOf = (text, re) => text.split("\n").findIndex((l) => re.test(l));

function check(input, value = SENTINEL) {
  const out = setDeveloperInstructions(input, value);
  const parsed = Bun.TOML.parse(out);
  expect(parsed.developer_instructions).toBe(value);
  const { developer_instructions: _, ...rest } = Bun.TOML.parse(input);
  const { developer_instructions: __, ...after } = parsed;
  expect(after).toEqual(rest);
  return out;
}

describe("setDeveloperInstructions", () => {
  test("adds the key at the top level, before the first table, when the config has none", () => {
    const input = 'model = "gpt"\n\n[tui]\nnotifications = true\n';
    const out = check(input);
    expect(lineOf(out, /^developer_instructions = /)).toBeLessThan(lineOf(out, /^\[tui\]/));
    expect(out).toContain('model = "gpt"\n');
  });

  test("adds the key to a config with no tables, and to an empty one", () => {
    expect(check('model = "gpt"\n')).toBe(`model = "gpt"\ndeveloper_instructions = ${JSON.stringify(SENTINEL)}\n`);
    check("");
  });

  test("replaces a basic string", () => {
    const out = check('developer_instructions = "existing user rules" # theirs\nmodel = "gpt"\n[tui]\nx = 1\n');
    expect(out).not.toContain("existing user rules");
    expect(out.split("\n")[1]).toBe('model = "gpt"');
  });

  test("replaces a literal string", () => {
    const out = check("model = 'gpt'\ndeveloper_instructions = 'C:\\rules \"quoted\"'\n[tui]\nx = 1\n");
    expect(out).not.toContain("C:\\rules");
  });

  test("replaces a multi-line basic string and every line it spans", () => {
    const input =
      'developer_instructions = """\nline one\n[not a table]\nline "two" \\"""\n"""\nmodel = "gpt"\n[tui]\nx = 1\n';
    const out = check(input);
    for (const s of ["line one", "not a table", "two"]) expect(out).not.toContain(s);
  });

  test("replaces a multi-line literal string", () => {
    const out = check("developer_instructions = '''\nfirst\nsecond'''\nmodel = 'gpt'\n");
    expect(out).not.toContain("first");
  });

  test("leaves a key that only a profile sets, and adds the top-level one", () => {
    const input = 'model = "gpt"\n\n[profiles.x]\ndeveloper_instructions = "profile rules"\n';
    const out = check(input);
    expect(Bun.TOML.parse(out).profiles.x.developer_instructions).toBe("profile rules");
    expect(lineOf(out, /^developer_instructions = "User/)).toBeLessThan(lineOf(out, /^\[profiles\.x\]/));
  });

  test("skips a table header inside another key's multi-line string", () => {
    const out = check('notify = """\n[fake]\n"""\n[tui]\nx = 1\n');
    expect(lineOf(out, /^developer_instructions = /)).toBeGreaterThan(lineOf(out, /^\[fake\]/));
  });

  test("writes values with quotes, backslashes and newlines", () => {
    check("[tui]\nx = 1\n", 'a "b" \\c\nd');
  });
});

describe("codex-config.js CLI", () => {
  test("prints the rewritten config, and treats a missing file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-codex-config-"));
    const missing = Bun.spawnSync(["bun", CLI, join(dir, "none.toml"), SENTINEL], { stdout: "pipe", stderr: "pipe" });
    expect(missing.exitCode).toBe(0);
    expect(Bun.TOML.parse(missing.stdout.toString()).developer_instructions).toBe(SENTINEL);
  });
});
