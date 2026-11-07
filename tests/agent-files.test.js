import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = new URL("../agent/", import.meta.url).pathname;
const launcher = join(agentDir, "browser-mcp");
const browserMd = readFileSync(join(agentDir, "browser.md"), "utf8");
const claudeMd = readFileSync(join(agentDir, "browser-claude.md"), "utf8");

const TOOLSEARCH_LINE =
  "Claude Code may defer these tools: load them with ToolSearch `select:mcp__bw-browser__new_page,mcp__bw-browser__take_snapshot,mcp__bw-browser__click,mcp__bw-browser__take_screenshot,mcp__bw-browser__list_pages`.";

const PINNED_ARGV = [
  "-y",
  "chrome-devtools-mcp@1.12.0",
  "--browserUrl",
  "http://127.0.0.1:52817",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--screenshotFormat",
  "jpeg",
  "--screenshotMaxWidth",
  "1280",
];

mkdirSync("/private/tmp/claude-501", { recursive: true });
const scratch = mkdtempSync("/private/tmp/claude-501/bw-agent-files-");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
// A scratch HOME, optionally holding ports/<window>, and a fake npx that prints its argv and PATH.
function setup(portFiles = {}) {
  const dir = join(scratch, `case-${n++}`);
  const home = join(dir, "home");
  const ports = join(home, ".local/share/bellwether/agent/ports");
  mkdirSync(ports, { recursive: true });
  for (const [w, text] of Object.entries(portFiles)) writeFileSync(join(ports, w), text);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const npx = join(bin, "npx");
  writeFileSync(npx, '#!/bin/sh\nprintf \'%s\\n\' "$@"\nprintf \'PATH=%s\\n\' "$PATH"\n');
  chmodSync(npx, 0o755);
  return { home, bin, npx };
}

function run(args, env) {
  const p = Bun.spawnSync(["/bin/sh", launcher, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function argvOf(out) {
  return out.split("\n").filter((l) => l && !l.startsWith("PATH="));
}

describe("browser instructions", () => {
  test("browser.md is under 1400 bytes and holds the five rules", () => {
    expect(Buffer.byteLength(browserMd)).toBeLessThan(1400);
    expect(browserMd.startsWith("## Bellwether browser\n\n")).toBe(true);
    for (const s of [
      "background: true",
      "Act only in tabs you opened",
      "take_snapshot",
      "Never type passwords",
      "say which tab you used",
    ]) {
      expect(browserMd).toContain(s);
    }
  });

  test("the Claude copy is browser.md plus the ToolSearch line", () => {
    const parts = browserMd.split("\n\n");
    const expected = [parts[0], parts[1], TOOLSEARCH_LINE, ...parts.slice(2)].join("\n\n");
    expect(claudeMd).toBe(expected);
    expect(Buffer.byteLength(claudeMd)).toBeLessThan(1400 + Buffer.byteLength(TOOLSEARCH_LINE) + 2);
  });
});

describe("browser-mcp launcher", () => {
  test("launcher execs npx with the pinned version and flags", () => {
    const { home, bin } = setup({ w1: "52817\n" });
    const r = run(["w1"], { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(argvOf(r.out)).toEqual(PINNED_ARGV);
  });

  test("launcher refuses a missing or non-numeric port with one stderr line and exit 1", () => {
    const { home, bin } = setup({ bad: "52817x\n", empty: "", neg: "-1\n" });
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    for (const w of ["missing", "bad", "empty", "neg"]) {
      const r = run([w], env);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err.split("\n").filter(Boolean)).toHaveLength(1);
      expect(r.err).toContain("browser-mcp");
    }
  });

  test("launcher refuses a window name that is not a slug", () => {
    const { home, bin } = setup({ w1: "52817\n" });
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    for (const args of [[], [""], ["../w1"], ["W1"], ["a".repeat(33)]]) {
      const r = run(args, env);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err.split("\n").filter(Boolean)).toHaveLength(1);
    }
  });

  test("launcher finds /opt/homebrew/bin/npx when PATH lacks npx", () => {
    const { home, bin, npx } = setup({ w1: "52817" });
    const r = run(["w1"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      BW_NPX_FALLBACKS: `${join(home, "absent/npx")} ${npx}`,
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(argvOf(r.out)).toEqual(PINNED_ARGV);
    // npx's folder goes first so its node is found from the Background core's short PATH.
    expect(r.out).toContain(`PATH=${bin}:/usr/bin:/bin\n`);
  });

  test("launcher without any npx exits 1 with one stderr line", () => {
    const { home } = setup({ w1: "52817" });
    const r = run(["w1"], { HOME: home, PATH: "/usr/bin:/bin", BW_NPX_FALLBACKS: join(home, "absent/npx") });
    expect(r.code).toBe(1);
    expect(r.err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.err).toContain("npx");
  });

  test("launcher --version runs the pinned package's --version without a port file", () => {
    const { home, bin } = setup();
    const r = run(["--version"], { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(argvOf(r.out)).toEqual(["-y", "chrome-devtools-mcp@1.12.0", "--version"]);
  });

  test("sh -n passes", () => {
    const p = Bun.spawnSync(["/bin/sh", "-n", launcher], { stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
  });
});
