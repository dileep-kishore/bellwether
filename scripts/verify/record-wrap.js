// Records one prompt per agent at two terminal widths, for the rewrap tests in crates/bw/tests. Run by
// scripts/verify/record-wrap.sh, which makes the scratch folder and the private core and undoes both.
//   bun record-wrap.js --scratch L --core C --out DIR
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HC, Term, claudeReady, codexHome, codexReady, envWith, makeRepo, spawn, until } from "./live.js";

const { values: opt } = parseArgs({
  options: { scratch: { type: "string" }, core: { type: "string" }, out: { type: "string" } },
});
if (!opt.scratch || !opt.core || !opt.out) {
  console.error("usage: bun record-wrap.js --scratch L --core C --out DIR");
  process.exit(2);
}
const L = opt.scratch;
const ENV = envWith({ HC_SESSION: opt.core });
const CODEX_HOME = join(L, "codex-home");
const LONG = "touch wrapped-output-file-with-a-long-name-for-the-rewrap-test.txt";
const CLAUDE = [
  "claude",
  "--model",
  "haiku",
  "--permission-mode",
  "default",
  "--setting-sources",
  "project",
  "--strict-mcp-config",
];
const CODEX = [
  "/usr/bin/env",
  `CODEX_HOME=${CODEX_HOME}`,
  "codex",
  "-m",
  "gpt-6-luna",
  "-c",
  'model_reasoning_effort="low"',
];
const CLAUDE_ASK = `Run exactly this Bash command yourself (no sub-agent) and nothing else: ${LONG}`;
// Codex asks only for escalation; a plain command runs in its sandbox and asks nothing.
const CODEX_ASK = `Run exactly this shell command with escalated sandbox permissions (ask me for approval first) and nothing else: ${LONG}`;

/** @param {string[]} args */
const hcHere = (args) => spawn([HC, ...args], { env: ENV });

/**
 * `terminal.run` through `hc connect`, the only way to give a new terminal its size.
 * @param {string} name @param {string} cwd @param {string[]} argv @param {number} cols
 */
async function startSized(name, cwd, argv, cols) {
  const req = (id, method, params) => `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
  const p = Bun.spawn([HC, "connect"], { env: ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(req(1, "hello", {}));
  p.stdin.write(
    req(2, "terminal.run", {
      argv,
      cwd,
      name,
      size: { cols, rows: 40 },
      no_parent: true,
      no_notify: true,
      wait: false,
    }),
  );
  p.stdin.flush();
  const reader = p.stdout.getReader();
  let buf = "";
  /** @type {any} */
  let reply = null;
  const deadline = Date.now() + 20000;
  try {
    while (!reply) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      // A silent stream must not outlast the deadline: the read races a timer.
      const next = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
      if (!next || next.done) break;
      buf += new TextDecoder().decode(next.value);
      for (const line of buf.split("\n")) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2) reply = j;
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
    p.stdin.end();
    p.kill();
    await p.exited;
  }
  const address = reply?.result?.address ?? reply?.result?.terminal?.address;
  if (!address) throw new Error(`terminal.run ${name}: ${JSON.stringify(reply)}`);
  return new Term(address, address, hcHere, async () => []);
}

/** @param {Term} t @param {RegExp} re @param {string} what */
async function screenWith(t, re, what) {
  if (!(await until(async () => re.test(await t.screen(60)), 180000, 2000)))
    throw new Error(`${t.address}: no ${what} within 180 s:\n${await t.screen(60)}`);
  return t.steady();
}

/** Saves `text` as `bw` reads a screen (`hc read --json`'s text), without the notes `hc read` adds.
 * @param {string} file @param {string} text */
function save(file, text) {
  const screen = text
    .split("\n")
    .filter((l) => !l.startsWith("[hc] "))
    .join("\n");
  writeFileSync(join(opt.out ?? "", file), screen.endsWith("\n") ? screen : `${screen}\n`);
  console.log(`wrote ${file}`);
}

/**
 * Puts a viewer of `cols` columns on `t` with `hc attach` in a pseudo-terminal of that size, which resizes it,
 * and returns the steady screen once the agent has redrawn. @param {Term} t @param {number} cols
 */
async function narrowed(t, cols) {
  const viewer = Bun.spawn([HC, "attach", t.address], { env: ENV, terminal: { cols, rows: 40, data() {} } });
  try {
    await Bun.sleep(3000);
    return await t.steady();
  } finally {
    viewer.kill();
    await viewer.exited;
  }
}

// Each prompt is read at 80 columns, then the same terminal is narrowed while the prompt waits, as a pane
// narrows in the window.
const cases = [
  { name: "claude-approval", narrow: 52, kind: "claude" },
  { name: "codex-approval", narrow: 52, kind: "codex" },
  { name: "codex-new-folder", narrow: 24, kind: "folder" },
];
const repos = cases.map((c) => join(L, c.name));
codexHome(CODEX_HOME, ...repos);
let failed = 0;
for (const [i, c] of cases.entries()) {
  const dir = repos[i];
  await makeRepo(dir);
  const t = await startSized(`wrap-${i}`, dir, c.kind === "claude" ? CLAUDE : CODEX, 80);
  try {
    let re;
    if (c.kind === "claude") {
      await claudeReady(t);
      await t.type(CLAUDE_ASK);
      re = /Do you want to proceed\?/;
    } else if (c.kind === "codex") {
      await codexReady(t);
      await t.type(CODEX_ASK);
      re = /Would\s+you\s+like\s+to\s+run/;
    } else {
      await codexReady(t);
      await t.type("/new");
      re = /Where\s+should\s+the\s+new/;
    }
    save(`${c.name}-80.txt`, await screenWith(t, re, c.kind));
    const narrow = await narrowed(t, c.narrow);
    if (!re.test(narrow)) throw new Error(`the prompt left the screen after narrowing:\n${narrow}`);
    save(`${c.name}-${c.narrow}.txt`, narrow);
  } catch (e) {
    failed = 1;
    console.error(`FAIL ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await t.kill();
  }
}
process.exit(failed);
