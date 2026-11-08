// Done check 2's checks. Run by scripts/verify/sessions.sh, which builds bw, makes the scratch
// folders and the private core, and deletes them.
//   bun sessions-run.js --bw B --offline
//   bun sessions-run.js --bw B --scratch L --core C [--machine M --remote-root R]
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createHelper } from "../../shared/helper.js";
import {
  AGENT_PATH,
  HC,
  Term,
  USER_ENV,
  aboveFooter,
  changed,
  claudeReady,
  codexHome,
  codexReady,
  envWith,
  filesWith,
  hcUser,
  lines,
  makeRepo,
  marker,
  reporter,
  rollouts,
  short,
  sleep,
  spawn,
  until,
  viaHc,
} from "./live.js";

const { values: opt } = parseArgs({
  options: {
    bw: { type: "string" },
    offline: { type: "boolean" },
    scratch: { type: "string" },
    core: { type: "string" },
    machine: { type: "string" },
    "remote-root": { type: "string" },
  },
});
if (!opt.bw || (!opt.offline && (!opt.scratch || !opt.core)) || (opt.machine && !opt["remote-root"])) {
  console.error("usage: bun sessions-run.js --bw B (--offline | --scratch L --core C [--machine M --remote-root R])");
  process.exit(2);
}
const BW = opt.bw;
const REPO = join(import.meta.dir, "../..");
const SESSIONS = join(REPO, "tests/fixtures/sessions");
const FEEDS = join(REPO, "tests/fixtures/feed");
const SCENARIOS = [
  "claude-subagents",
  "claude-picture",
  "claude-approval",
  "codex-subagent",
  "codex-question",
  "codex-approval",
];
// 2026-11-07T00:00:00Z, as the goldens were made (tests/fixtures/feed/README.md).
const NOW_MS = "1794009600000";
const CLAUDE = ["claude", "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config"];
const CODEX_FLAGS = ["-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-a", "never", "-s", "workspace-write"];
const DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGO4IydHEmIY1TAaSnLDNmkAAJozGBASWxyzAAAAAElFTkSuQmCC";
const SPAWN_ONE =
  "Spawn exactly one sub-agent with spawn_agent and ask it to run 'ls | wc -l' and report the number. Wait for it, then reply with its number only.";
const RUN_HELPER = 'exec "$HOME"/.local/share/bellwether/helper/current/bw "$@"';

const report = reporter();
const { pass, fail, check } = report;

/** The private core and a scratch cache, for this Mac's agents. */
const PRIVATE_ENV = envWith({
  HC_SESSION: opt.core,
  BW_CACHE_DIR: opt.scratch ? join(opt.scratch, "cache") : undefined,
});

/** `bw <args>` here, against the private core. @param {string[]} args @param {Record<string, string>} [extra] */
async function bwHere(args, extra = {}) {
  const r = await spawn([BW, ...args], { env: { ...PRIVATE_ENV, ...extra } });
  return lines(r.stdout);
}

/** `hc <args>` against the private core. @param {string[]} args */
const hcHere = (args) => spawn([HC, ...args], { env: PRIVATE_ENV });

/** What a log's rows hold, for comparing with expect.json. @param {any[]} rows */
function counts(rows) {
  const n = (/** @type {string} */ k) => rows.filter((r) => r.k === k).length;
  const calls = rows
    .filter((r) => r.k === "tools")
    .flatMap((r) => r.chips)
    .reduce((s, c) => s + c.calls.length, 0);
  const pics = rows.reduce((s, r) => s + (r.pics?.length ?? 0), 0);
  return {
    user_messages: n("user"),
    assistant_messages: n("assistant"),
    tool_calls: calls + n("question"),
    pictures: pics,
  };
}

const SCRUBBED_AGENTS = '"type":"input_text","text":"[scrubbed: AGENTS.md instructions removed by scrub-fixture]"';
/** The Codex AGENTS.md message as Codex writes it, same length (crates/bw/tests/feed.rs `as_written`). @param {string} log */
function asWritten(log) {
  const head = '"type":"input_text","text":"# AGENTS.md instructions, scrubbed';
  return log.replaceAll(SCRUBBED_AGENTS, `${head.padEnd(SCRUBBED_AGENTS.length - 1, " ")}"`);
}

async function offline() {
  const tmp = (await spawn(["mktemp", "-d", "/private/tmp/claude-501/bw-sessions-offline.XXXXXX"])).stdout.trim();
  try {
    for (const s of SCENARIOS) {
      const expect = JSON.parse(readFileSync(join(SESSIONS, s, "expect.json"), "utf8"));
      const copy = join(tmp, expect.file);
      writeFileSync(copy, asWritten(readFileSync(join(SESSIONS, s, expect.file), "utf8")));
      const got = await bwHere(["feed", "--log", copy, "--agent", expect.agent, "--pictures"], {
        BW_NOW_MS: NOW_MS,
        BW_TZ: "UTC",
        BW_CACHE_DIR: join(tmp, "cache"),
      });
      const log = got.find((l) => l.type === "log");
      if (log) {
        delete log.path;
        delete log.cursor;
      }
      const want = lines(readFileSync(join(FEEDS, `${s}.jsonl`), "utf8"));
      Bun.deepEquals(got, want)
        ? pass(`golden-${s}`, `${got.length} lines equal tests/fixtures/feed/${s}.jsonl`)
        : fail(`golden-${s}`, `bw feed --log differs from its golden (${got.length} lines, golden ${want.length})`);
      const c = counts(got.filter((l) => l.type === "row"));
      const hand = {
        user_messages: expect.user_messages,
        assistant_messages: expect.assistant_messages,
        tool_calls: expect.tool_calls,
        pictures: expect.pictures,
      };
      Bun.deepEquals(c, hand)
        ? pass(
            `root-rows-${s}`,
            `user ${c.user_messages}, assistant ${c.assistant_messages}, tool calls ${c.tool_calls}, pictures ${c.pictures} equal expect.json`,
          )
        : fail(`root-rows-${s}`, `rows ${short(c)}, hand counts ${short(hand)}`);
    }
    await childChecks(tmp);
  } finally {
    await spawn(["rm", "-rf", tmp]);
  }
}

/**
 * Child rows equal the recordings' hand counts, and `bw tree` nests each child under the parent expect.json names:
 * the four Claude children of claude-subagents (one nested under the nester) and Codex's one child.
 * @param {string} tmp
 */
async function childChecks(tmp) {
  const cache = { BW_CACHE_DIR: join(tmp, "cache") };
  const sub = JSON.parse(readFileSync(join(SESSIONS, "claude-subagents/expect.json"), "utf8"));
  const cx = JSON.parse(readFileSync(join(SESSIONS, "codex-subagent/expect.json"), "utf8"));
  // Codex finds a child in the root rollout's own <home>/sessions, four folders above the root's file.
  const day = join(tmp, "codex-home/sessions/2026/11/06");
  mkdirSync(day, { recursive: true });
  const codexRoot = join(day, cx.file);
  writeFileSync(codexRoot, asWritten(readFileSync(join(SESSIONS, "codex-subagent", cx.file), "utf8")));
  for (const c of cx.children)
    writeFileSync(join(day, c.file), asWritten(readFileSync(join(SESSIONS, "codex-subagent", c.file), "utf8")));

  /** @type {string[]} */
  const wrong = [];
  for (const c of sub.children) {
    const rows = (
      await bwHere(
        [
          "feed",
          "--log",
          join(SESSIONS, "claude-subagents", c.file),
          "--agent",
          "claude",
          "--scope",
          "claude-subagent",
        ],
        cache,
      )
    ).filter((l) => l.type === "row");
    const got = counts(rows);
    if (
      got.user_messages !== c.user_messages ||
      got.assistant_messages !== c.assistant_messages ||
      got.tool_calls !== c.tool_calls
    )
      wrong.push(`${c.id} ${short(got)}`);
  }
  for (const c of cx.children) {
    const rows = (
      await bwHere(
        [
          "feed",
          "--log",
          join(day, c.file),
          "--agent",
          "codex",
          "--scope",
          `codex-child:${c.history_start_ordinal ?? 0}`,
        ],
        cache,
      )
    ).filter((l) => l.type === "row");
    const got = counts(rows);
    if (
      got.user_messages !== c.user_messages ||
      got.assistant_messages !== c.assistant_messages ||
      got.tool_calls !== c.tool_calls
    )
      wrong.push(`${c.id} ${short(got)}`);
  }
  const n = sub.children.length + cx.children.length;
  wrong.length
    ? fail("child-rows", `rows differ from expect.json for ${wrong.join("; ")}`)
    : pass(
        "child-rows",
        `bw feed --log --scope on each of ${n} sub-agent logs (4 Claude, 1 Codex) gives expect.json's user, assistant and tool call counts`,
      );

  const shape = (/** @type {any} */ c) => ({ id: c.id, parent: c.parent, depth: c.depth, type: c.type });
  const claudeTree = (
    await bwHere(["tree", "--log", join(SESSIONS, "claude-subagents", sub.file), "--agent", "claude"], cache)
  ).find((l) => l.type === "tree");
  const codexTree = (await bwHere(["tree", "--log", codexRoot, "--agent", "codex"], cache)).find(
    (l) => l.type === "tree",
  );
  const want = sub.children.map(shape);
  const got = (claudeTree?.children ?? []).map(shape);
  const nested = sub.children.find((/** @type {any} */ c) => c.depth === 2);
  const codexGot = (codexTree?.children ?? []).map((/** @type {any} */ c) => ({
    id: c.id,
    parent: c.parent,
    depth: c.depth,
  }));
  const codexWant = cx.children.map((/** @type {any} */ c) => ({ id: c.id, parent: c.parent, depth: c.depth }));
  if (!Bun.deepEquals(got, want))
    return fail("tree-nested-subagent", `bw tree gave ${short(got)}, expect.json ${short(want)}`);
  if (!Bun.deepEquals(codexGot, codexWant))
    return fail(
      "tree-nested-subagent",
      `bw tree on the Codex root gave ${short(codexGot)}, expect.json ${short(codexWant)}`,
    );
  pass(
    "tree-nested-subagent",
    `bw tree lists the 4 Claude children with expect.json's parents and depths, ${nested.id} at depth 2 under ${nested.parent}, and Codex's child under its root`,
  );
}

/** @param {string} name @param {string} cwd @param {string[]} argv @returns {Promise<Term>} */
async function startHere(name, cwd, argv) {
  const r = await hcHere([
    "run",
    "--json",
    "--bg",
    "--no-parent",
    "--no-notify",
    "--name",
    name,
    "--cwd",
    cwd,
    "--",
    ...argv,
  ]);
  const j = JSON.parse(r.stdout || "{}");
  if (!j.address) throw new Error(`hc run ${name}: ${r.stderr.trim() || r.stdout.trim()}`);
  return new Term(j.address, j.address, hcHere, (args) => bwHere(args));
}

/** The terminal's conversation once its log exists. @param {Term} t */
async function located(t) {
  return until(async () => {
    const l = await t.locate();
    return l?.type === "located" ? l : null;
  }, 40000);
}

/** Rows once `want` holds for them. @param {Term} t @param {(rows: any[]) => boolean} want */
async function rowsWhen(t, want, limit = 40000) {
  let last = [];
  const ok = await until(async () => {
    last = await t.rows();
    return want(last);
  }, limit);
  return { ok: Boolean(ok), rows: last };
}

const userRow = (/** @type {any[]} */ rows, /** @type {string} */ text) =>
  rows.some((r) => r.k === "user" && r.text === text);
const replyHas = (/** @type {any[]} */ rows, /** @type {string} */ word) =>
  rows.some((r) => r.k === "assistant" && String(r.text).includes(word));
const tail = (/** @type {any[]} */ rows) =>
  short(rows.slice(-4).map((r) => ({ k: r.k, text: String(r.text ?? r.sentence ?? "").slice(0, 60) })));
/**
 * A send naming the conversation shown before `/clear` or `/new` is refused, and nothing changes.
 * @param {string} name @param {Term} t @param {any} old the `located` line before
 * @param {(text: string) => Promise<string[]>} logsWith the agent's log files holding `text`
 */
async function oldRefused(name, t, old, logsWith) {
  const text = marker("REFUSED");
  const now = await until(async () => {
    const l = await t.locate();
    return l && !(l.type === "located" && l.session === old.session) ? l : null;
  }, 40000);
  if (!now) return fail(name, `bw locate still names ${old.session} after the new conversation`);
  // Claude's footer below the input box changes on its own (mode hints after /clear); typed text shows above it.
  const before = aboveFooter(await t.steady());
  const rowsBefore = (await bwOld(t, old)).length;
  const r = await t.send(old, text);
  await sleep(4000);
  const after = aboveFooter(await t.screen());
  const rowsAfter = (await bwOld(t, old)).length;
  const hits = await logsWith(text);
  if (r?.result !== "refused-conversation") return fail(name, `bw send gave ${short(r)}`);
  if (before !== after)
    return fail(name, `the screen changed after the refused send: ${short(changed(before, after))}`);
  if (rowsBefore !== rowsAfter || hits.length)
    return fail(name, `a log changed: rows ${rowsBefore} → ${rowsAfter}, text in ${hits.length} file(s)`);
  pass(
    name,
    `now ${now.type === "located" ? `session ${now.session}` : now.state}; old session ${old.session} refused, screen and logs unchanged`,
  );
}

/**
 * The first message as a fresh chat sends it, with no session: sent while bw locate says no_log, it is the
 * feed's first user row, and once the log exists another send with no session is refused.
 * @param {string} name @param {Term} t @param {"claude" | "codex"} agent @param {string} text
 * @param {() => Promise<unknown>} settle waits for the agent to finish its turn
 * @returns {Promise<any>} the conversation's `located` line, or null
 */
async function firstMessage(name, t, agent, text, settle = () => t.wait()) {
  const none = { agent, session: "none", path: "none" };
  const first = `${name}-first-message`;
  const fresh = await until(async () => {
    const l = await t.locate();
    return l?.type === "state" && l.state === "no_log" && l.agent === agent ? l : null;
  }, 20000);
  if (!fresh) {
    fail(first, `bw locate before the first message gave ${short(await t.locate())}`);
    return null;
  }
  const r = await t.send(none, text);
  if (r?.result !== "sent") {
    fail(first, `bw send --expect-session none gave ${short(r)}`);
    return null;
  }
  await settle();
  const c = await located(t);
  if (!c) {
    fail(first, "bw locate found no log after the first message");
    return null;
  }
  const got = await rowsWhen(t, (rows) => rows.find((row) => row.k === "user")?.text === text);
  got.ok
    ? pass(
        first,
        `sent with --expect-session none while bw locate said no_log; the feed's first user row is the message`,
      )
    : fail(
        first,
        `feed starts ${short(got.rows.slice(0, 3).map((row) => ({ k: row.k, text: String(row.text ?? "").slice(0, 60) })))}`,
      );
  await check(`${name}-none-refused-after-log`, async () => {
    const again = marker("NONE");
    await t.steady();
    const r2 = await t.send(none, again);
    await sleep(4000);
    // Claude redraws its mode line on its own after a turn, so look for the text rather than an unchanged screen.
    const after = await t.screen(60);
    const rows = await t.rows();
    if (r2?.result !== "refused-conversation")
      return fail(`${name}-none-refused-after-log`, `bw send gave ${short(r2)}`);
    if (after.includes(again)) return fail(`${name}-none-refused-after-log`, "the refused text is on the screen");
    if (rows.some((row) => String(row.text ?? "").includes(again)))
      return fail(`${name}-none-refused-after-log`, "the feed holds the refused text");
    pass(
      `${name}-none-refused-after-log`,
      `refused-conversation once session ${c.session} has a log; the text is on neither the screen nor the feed`,
    );
  });
  return c;
}

/**
 * After a real `/clear` or `/new`: once bw locate names the new conversation, the chat's next message goes out
 * with that conversation's expectation and becomes its first user row. Codex's has no log until that message
 * (`no_log` naming the session, sent with --expect-session <id> --expect-path none; a second such send is
 * refused once the log exists). Claude 2.1.319 writes the new log at `/clear` itself, so its form is <id> <log>.
 * @param {string} name @param {Term} t @param {"claude" | "codex"} agent @param {any} old the `located` line before
 */
async function nextMessage(name, t, agent, old) {
  // Codex says ambiguous for about 60 s after the folder prompt (docs/research/2026-11-06-phase3-requests.md (j)).
  const fresh = await until(
    async () => {
      const l = await t.locate();
      if (!l?.session || l.session === old.session) return null;
      return (l.type === "state" && l.state === "no_log") || l.type === "located" ? l : null;
    },
    150000,
    3000,
  );
  if (!fresh) return fail(name, `bw locate never named a new conversation: ${short(await t.locate())}`);
  const noLog = fresh.type === "state";
  const text = marker("NEXT");
  const expect = { agent, session: fresh.session, path: noLog ? "none" : fresh.path };
  const r = await t.send(expect, text);
  if (r?.result !== "sent")
    return fail(name, `bw send --expect-session ${fresh.session} --expect-path ${expect.path} gave ${short(r)}`);
  await t.wait(180);
  const c = await located(t);
  if (!c) return fail(name, "bw locate found no log after the message");
  if (c.session !== fresh.session) return fail(name, `the log belongs to ${c.session}, not ${fresh.session}`);
  const got = await rowsWhen(t, (rows) => rows.find((row) => row.k === "user")?.text === text);
  if (!got.ok)
    return fail(
      name,
      `the new conversation's feed starts ${short(got.rows.slice(0, 3).map((row) => ({ k: row.k, text: String(row.text ?? "").slice(0, 60) })))}`,
    );
  if (!noLog)
    return pass(
      name,
      `bw locate named the new session ${fresh.session} with the log Claude wrote at /clear; the message sent with <id> <log> is that feed's first user row`,
    );
  const again = await t.send(expect, marker("AGAIN"));
  if (again?.result !== "refused-conversation")
    return fail(name, `a second send with ${fresh.session} none gave ${short(again)}`);
  pass(
    name,
    `bw locate named ${fresh.session} with no log; the message sent with it and none is that log's first user row; the same expectation is refused once the log exists`,
  );
}

/**
 * Codex's `/new` folder prompt answered from its card, as the chat's dock does: the `prompt` request `bw cards`
 * lists, then `bw answer --action option-<n>` with the old conversation's expectation (bw locate still names it).
 * @param {string} name @param {Term} t @param {any} old @param {number} option
 */
async function answerFolderPrompt(name, t, old, option) {
  if (!(await t.waitScreen(/Where should the new conversation run/, 15000)))
    throw new Error(`${name}: no folder prompt after /new`);
  const req = await until(
    async () =>
      (await t.bw(["cards", "--terminal", t.local])).find(
        (l) => l.type === "request" && l.kind === "prompt" && l.state === "pending",
      ),
    10000,
    1000,
  );
  if (!req)
    throw new Error(
      `${name}: bw cards lists no prompt request: ${short(await t.bw(["cards", "--terminal", t.local]))}`,
    );
  if (!req.answerable || !req.actions.some((/** @type {any} */ a) => a.id === `option-${option}`))
    throw new Error(`${name}: the prompt card offers no option-${option}: ${short(req)}`);
  const out = await t.bw([
    "answer",
    "--terminal",
    t.local,
    "--request",
    req.id,
    "--expect-kind",
    "codex",
    "--expect-session",
    old.session,
    "--expect-path",
    old.path,
    "--action",
    `option-${option}`,
  ]);
  const a = out.find((l) => l.type === "answer");
  if (a?.result !== "answered") throw new Error(`${name}: bw answer --action option-${option} gave ${short(out)}`);
  if (/Where should the new conversation run/.test(await t.screen(60)))
    throw new Error(`${name}: the folder prompt is still on screen after bw answer`);
  return req;
}

/** The old conversation's rows, read by path on the terminal's machine. @param {Term} t @param {any} old */
async function bwOld(t, old) {
  return (await t.bw(["feed", "--log", old.path, "--agent", old.agent])).filter((l) => l.type === "row");
}

async function claudeChecks() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "claude-chat");
  await makeRepo(dir, { "dot.png": Buffer.from(DOT_PNG, "base64") });
  const t = await startHere("bw-sessions-claude", dir, CLAUDE);
  try {
    await claudeReady(t);
    const first = await firstMessage(
      "claude",
      t,
      "claude",
      "Read dot.png with the Read tool and name its colour in one word.",
    );
    if (!first) return fail("claude-feed-shows-turn", "no conversation after the first message");

    await check("claude-feed-shows-turn", async () => {
      const ask = "Reply with the word PINEAPPLE only.";
      const r = await t.send(first, ask);
      if (r?.result !== "sent") return fail("claude-feed-shows-turn", `bw send gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, ask) && replyHas(rows, "PINEAPPLE"));
      got.ok
        ? pass("claude-feed-shows-turn", `sent; the feed holds the user row and a reply with PINEAPPLE`)
        : fail("claude-feed-shows-turn", `feed ends ${tail(got.rows)}`);
    });

    await check("claude-send-verbatim", async () => {
      const text = '-- "$(echo no)" --force';
      const r = await t.send(first, text);
      if (r?.result !== "sent") return fail("claude-send-verbatim", `bw send gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, text));
      got.ok
        ? pass("claude-send-verbatim", `one user row reads exactly ${text}`)
        : fail("claude-send-verbatim", `feed ends ${tail(got.rows)}`);
    });

    await check("claude-picture-copied", async () => {
      const feed = await bwHere(["feed", "--terminal", t.local, "--pictures"]);
      const pic = feed.filter((l) => l.type === "row").flatMap((r) => r.pics ?? [])[0];
      if (!pic) return fail("claude-picture-copied", "no row lists a picture");
      const app = join(L, "app-home");
      mkdirSync(app, { recursive: true });
      const out = await bwHere(
        [
          "picture",
          "--terminal",
          t.local,
          "--offset",
          String(pic.offset),
          "--index",
          String(pic.index),
          "--digest",
          pic.digest,
        ],
        { HERDR_APP_HOME: app },
      );
      const p = out.find((l) => l.type === "picture");
      const file = p?.file ? join(app, p.file) : "";
      const same = file && existsSync(file) && Buffer.compare(readFileSync(file), Buffer.from(DOT_PNG, "base64")) === 0;
      same
        ? pass("claude-picture-copied", `${p.file} equals dot.png (${p.bytes} bytes)`)
        : fail("claude-picture-copied", `bw picture gave ${short(out)}`);
    });

    /** @type {any} */
    let old = null;
    await check("claude-old-conversation-refused", async () => {
      const was = await t.locate();
      if (was?.type !== "located") return fail("claude-old-conversation-refused", `bw locate gave ${short(was)}`);
      const r = await t.send(was, "/clear");
      if (r?.result !== "sent") return fail("claude-old-conversation-refused", `bw send /clear gave ${short(r)}`);
      old = was;
      await sleep(2000);
      const project = join(process.env.HOME ?? "", ".claude/projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
      await oldRefused("claude-old-conversation-refused", t, old, async (text) => filesWith(project, text));
    });
    await check("claude-clear-next-message", async () => {
      if (!old) return fail("claude-clear-next-message", "no /clear went out");
      await nextMessage("claude-clear-next-message", t, "claude", old);
    });
  } finally {
    await t.kill();
  }
}

// Glob and Agent need no approval in Claude's default permission mode, so the run never stops at a prompt.
const CHILD_AGENTS = JSON.stringify({
  lister: {
    description: "Counts the files in the current folder",
    prompt: "Use the Glob tool once with the pattern * and reply with the number of files only.",
    tools: ["Glob"],
    model: "haiku",
  },
  nester: {
    description: "Delegates a count to the lister agent",
    prompt: "Use the Agent tool exactly once with subagent_type lister, then reply with its answer only.",
    tools: ["Agent"],
    model: "haiku",
  },
});

async function claudeChildrenCheck() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "claude-children");
  await makeRepo(dir);
  // In a terminal Claude 2.1.319 backgrounds every sub-agent unless this is set (Task 1's note).
  const t = await startHere("bw-sessions-children", dir, [
    "/usr/bin/env",
    "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
    ...CLAUDE,
    "--agents",
    CHILD_AGENTS,
  ]);
  try {
    await claudeReady(t);
    await t.type(
      "Use the Agent tool twice, one after the other, then stop: (1) subagent_type lister; (2) subagent_type nester. Then reply with both answers on one line.",
    );
    const c = await located(t);
    if (!c) return fail("claude-children-live", "bw locate found no log");
    const subagents = join(dirname(c.path), basename(c.path, ".jsonl"), "subagents");
    const metas = () => (existsSync(subagents) ? readdirSync(subagents).filter((f) => f.endsWith(".meta.json")) : []);
    const done = await until(
      async () => {
        const m = metas();
        return m.length >= 3 && m.every((f) => /"finished":true/.test(readFileSync(join(subagents, f), "utf8")));
      },
      240000,
      3000,
    );
    await t.wait(120);
    if (!done) return fail("claude-children-live", `the sub-agents never all finished: ${short(metas())}`);
    const files = readdirSync(subagents).filter((f) => f.endsWith(".jsonl"));
    const tree = (await t.bw(["tree", "--terminal", t.local])).find((l) => l.type === "tree");
    const kids = tree?.children ?? [];
    const nested = kids.find((/** @type {any} */ k) => k.depth === 2);
    const parent = nested && kids.find((/** @type {any} */ k) => k.id === nested.parent);
    const meta = nested && JSON.parse(readFileSync(join(subagents, `agent-${nested.id}.meta.json`), "utf8"));
    if (kids.length !== files.length)
      return fail(
        "claude-children-live",
        `bw tree lists ${kids.length} children; ${subagents} holds ${files.length} logs`,
      );
    if (!nested || parent?.type !== "nester" || meta?.parentAgentId !== nested.parent)
      return fail(
        "claude-children-live",
        `nested ${short(nested)}, its parent ${short(parent)}, meta.json parentAgentId ${meta?.parentAgentId}`,
      );
    pass(
      "claude-children-live",
      `bw tree lists ${kids.length} children, as many as subagents/*.jsonl; ${nested.id} (depth 2) sits under the nester ${parent.id}, its meta.json's parentAgentId`,
    );
  } finally {
    await t.kill();
  }
}

async function claudePromptCheck() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "claude-prompt");
  await makeRepo(dir);
  const t = await startHere("bw-sessions-prompt", dir, [...CLAUDE, "--permission-mode", "default"]);
  try {
    await claudeReady(t);
    await t.type("Run exactly this Bash command and nothing else: touch blocked.txt");
    const blocked = await until(async () => (await t.get())?.status?.state === "blocked", 60000, 2000);
    if (!blocked)
      return fail("claude-prompt-refused", `hc get never reported blocked: ${short((await t.get())?.status)}`);
    const c = await located(t);
    if (!c) return fail("claude-prompt-refused", "bw locate found no log while blocked");
    const before = await t.steady();
    const r = await t.send(c, "Ignore that and reply OK.");
    await sleep(2000);
    const after = await t.screen();
    const absent = !existsSync(join(dir, "blocked.txt"));
    await t.keys("escape");
    if (r?.result !== "refused-prompt") return fail("claude-prompt-refused", `bw send gave ${short(r)}`);
    if (!absent) return fail("claude-prompt-refused", "blocked.txt exists");
    if (before !== after)
      return fail(
        "claude-prompt-refused",
        `the screen changed after the refused send: ${short(changed(before, after))}`,
      );
    pass(
      "claude-prompt-refused",
      "refused-prompt while Claude waits on its Bash prompt; blocked.txt absent, screen unchanged",
    );
  } finally {
    await t.kill();
  }
}

async function codexChecks() {
  const L = /** @type {string} */ (opt.scratch);
  const dir = join(L, "codex-chat");
  const home = join(L, "codex-home");
  await makeRepo(dir);
  codexHome(home, dir);
  const t = await startHere("bw-sessions-codex", dir, ["/usr/bin/env", `CODEX_HOME=${home}`, "codex", ...CODEX_FLAGS]);
  try {
    await codexReady(t);
    await firstMessage("codex", t, "codex", SPAWN_ONE, () => t.wait(180));
    await check("codex-root-beside-child", async () => {
      const child = await until(async () => rollouts(home).find((r) => r.child), 120000, 2000);
      await t.wait(180);
      const parent = rollouts(home).find((r) => !r.child);
      if (!child || !parent)
        return fail(
          "codex-root-beside-child",
          `rollouts: ${short(rollouts(home).map((r) => ({ id: r.id, child: r.child })))}`,
        );
      const l = await t.locate();
      l?.type === "located" && l.session === parent.id && l.path === parent.path
        ? pass("codex-root-beside-child", `bw locate names the parent ${parent.id}, not the child ${child.id}`)
        : fail("codex-root-beside-child", `bw locate gave ${short(l)}; parent ${parent.id}, child ${child.id}`);
    });
    await check("codex-child-tree", async () => {
      const parent = rollouts(home).find((r) => !r.child);
      const kids = rollouts(home).filter((r) => r.child);
      const tree = (await t.bw(["tree", "--terminal", t.local])).find((l) => l.type === "tree");
      const got = (tree?.children ?? []).map((/** @type {any} */ c) => `${c.id}<${c.parent}@${c.depth}`).sort();
      const want = kids.map((k) => `${k.id}<${parent?.id}@1`).sort();
      kids.length && Bun.deepEquals(got, want)
        ? pass(
            "codex-child-tree",
            `bw tree --terminal lists the ${kids.length} child rollout(s) under the root ${parent?.id} at depth 1`,
          )
        : fail("codex-child-tree", `bw tree gave ${short(tree)}; child rollouts ${short(kids.map((k) => k.id))}`);
    });
    await check("codex-feed-local", async () => {
      const c = await located(t);
      if (!c) return fail("codex-feed-local", "bw locate found no log");
      const ask = "Reply with the word PINEAPPLE only.";
      const r = await t.send(c, ask);
      if (r?.result !== "sent") return fail("codex-feed-local", `bw send gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, ask) && replyHas(rows, "PINEAPPLE"));
      got.ok
        ? pass("codex-feed-local", "sent; the feed holds the user row and a reply with PINEAPPLE")
        : fail("codex-feed-local", `feed ends ${tail(got.rows)}`);
    });
    await check("codex-new-next-message", async () => {
      const old = await t.locate();
      if (old?.type !== "located") return fail("codex-new-next-message", `bw locate gave ${short(old)}`);
      const r = await t.send(old, "/new");
      if (r?.result !== "sent") return fail("codex-new-next-message", `bw send /new gave ${short(r)}`);
      // Option 2 (a new worktree) cannot start under -s workspace-write (Task 1, case j).
      await answerFolderPrompt("codex-new-next-message", t, old, 1);
      await nextMessage("codex-new-next-message", t, "codex", old);
    });
  } finally {
    await t.kill();
  }
}

async function remoteChecks() {
  const M = /** @type {string} */ (opt.machine);
  const R = /** @type {string} */ (opt["remote-root"]);
  const L = /** @type {string} */ (opt.scratch);
  const helper = createHelper({
    exec: (cmd, args, { on }) => (on == null ? spawn([cmd, ...args]) : viaHc(on, cmd, args)),
    localInstall: async (machine) =>
      lines((await spawn([BW, "machine", "install", machine], { env: USER_ENV })).stdout),
  });
  const there = (/** @type {string[]} */ argv) => viaHc(M, argv[0], argv.slice(1));

  await check(`${M}-helper-missing-named`, async () => {
    const mv = await there([
      "sh",
      "-c",
      'h=$HOME/.local/share/bellwether/helper; [ -L "$h/current" ] && mv "$h/current" "$h/current.bw-sessions"',
    ]);
    if (mv.code !== 0)
      return fail(`${M}-helper-missing-named`, `could not move helper/current aside on ${M}: ${mv.stderr.trim()}`);
    const r = await helper.call(M, ["version"], { install: false });
    !r.ok && r.state === "missing"
      ? pass(`${M}-helper-missing-named`, `helper.call names it missing: ${r.message}`)
      : fail(`${M}-helper-missing-named`, short(r));
  });
  await check(`${M}-helper-installed`, async () => {
    const ready = await helper.ensure(M);
    const v = lines((await there(["sh", "-c", RUN_HELPER, "bw", "version"])).stdout)[0];
    ready.ok && v?.protocol === 5 && v?.version === "0.5.0"
      ? pass(`${M}-helper-installed`, `ensure ran bw machine install ${M}; bw version there is protocol 5, 0.5.0`)
      : fail(`${M}-helper-installed`, `ensure gave ${short(ready)}; bw version ${short(v)}`);
  });

  const dir = `${R}/codex-chat`;
  const home = `${R}/codex-home`;
  await makeRepo(dir, {}, there);
  const wrote = await spawn([HC, "file", "write", "--json", "--on", M, `${home}/auth.json`], {
    env: USER_ENV,
    stdin: Bun.file(join(process.env.HOME ?? "", ".codex/auth.json")),
  });
  if (wrote.code !== 0) return fail(`${M}-codex-feed`, `hc file write auth.json on ${M}: ${wrote.stderr.trim()}`);
  await there([
    "sh",
    "-c",
    'chmod 600 "$1/auth.json"; printf "[projects.\\"%s\\"]\\ntrust_level = \\"trusted\\"\\n" "$2" > "$1/config.toml"',
    "sh",
    home,
    dir,
  ]);

  const run = await hcUser([
    "run",
    "--json",
    "--bg",
    "--on",
    M,
    "--no-parent",
    "--no-notify",
    "--name",
    "bw-sessions-codex",
    "--cwd",
    dir,
    "--",
    "/usr/bin/env",
    `CODEX_HOME=${home}`,
    `PATH=${AGENT_PATH}`,
    "codex",
    ...CODEX_FLAGS,
  ]);
  const address = JSON.parse(run.stdout || "{}").address;
  if (!address) return fail(`${M}-codex-feed`, `hc run --on ${M}: ${run.stderr.trim() || run.stdout.trim()}`);
  appendFileSync(join(L, "remote-terminals"), `${address}\n`);
  const local = address.slice(M.length + 1);
  const bwThere = async (/** @type {string[]} */ args) => {
    const r = await helper.call(M, args);
    return r.ok ? r.lines : [{ type: "failure", ...r }];
  };
  // Typing the first message goes through that machine's own core, as a key press there would.
  const hcThere = async (/** @type {string[]} */ args) =>
    args[0] === "send" ? there(["hc", ...args.slice(0, 3), local, ...args.slice(4)]) : hcUser(args);
  const t = new Term(address, local, hcThere, bwThere);
  try {
    await codexReady(t);
    await check(`${M}-codex-kind`, async () => {
      const l = await t.locate();
      l?.agent === "codex"
        ? pass(
            `${M}-codex-kind`,
            `bw locate there names codex behind the env wrapper (${l.type === "state" ? l.state : l.session})`,
          )
        : fail(`${M}-codex-kind`, `bw locate there gave ${short(l)}: the env wrapper hides Codex`);
    });
    const first = await firstMessage(`${M}-codex`, t, "codex", "Reply with the word MANGO only.");
    if (!first) return fail(`${M}-codex-feed`, "no conversation there after the first message");
    await check(`${M}-codex-feed`, async () => {
      const got = await rowsWhen(
        t,
        (rows) => userRow(rows, "Reply with the word MANGO only.") && replyHas(rows, "MANGO"),
      );
      got.ok
        ? pass(`${M}-codex-feed`, "bw feed through the helper there shows the turn")
        : fail(`${M}-codex-feed`, `feed ends ${tail(got.rows)}`);
    });
    await check(`${M}-codex-send`, async () => {
      const ask = "Reply with the word PINEAPPLE only.";
      const r = await t.send(first, ask);
      if (r?.result !== "sent") return fail(`${M}-codex-send`, `bw send through the helper there gave ${short(r)}`);
      await t.wait();
      const got = await rowsWhen(t, (rows) => userRow(rows, ask) && replyHas(rows, "PINEAPPLE"));
      got.ok
        ? pass(
            `${M}-codex-send`,
            "sent through the helper there; the feed holds the user row as typed (no <hc from> wrapper) and the reply",
          )
        : fail(`${M}-codex-send`, `feed ends ${tail(got.rows)}`);
    });
    await check(`${M}-codex-child-tree`, async () => {
      const c = await t.locate();
      if (c?.type !== "located") return fail(`${M}-codex-child-tree`, `bw locate gave ${short(c)}`);
      const r = await t.send(c, SPAWN_ONE);
      if (r?.result !== "sent") return fail(`${M}-codex-child-tree`, `bw send gave ${short(r)}`);
      await t.wait(180);
      const tree = await until(
        async () => {
          const l = (await t.bw(["tree", "--terminal", local])).find((x) => x.type === "tree");
          return l?.children?.length ? l : null;
        },
        60000,
        3000,
      );
      const kid = tree?.children?.[0];
      if (!kid) return fail(`${M}-codex-child-tree`, `bw tree there lists no child: ${short(tree)}`);
      const meta = await there([
        "sh",
        "-c",
        'for f in "$1"/sessions/*/*/*/rollout-*"$2".jsonl; do head -1 "$f"; done',
        "sh",
        home,
        kid.id,
      ]);
      let parent = null;
      try {
        parent = JSON.parse(meta.stdout.split("\n")[0]).payload?.parent_thread_id ?? null;
      } catch {}
      kid.parent === c.session && kid.depth === 1 && parent === c.session
        ? pass(
            `${M}-codex-child-tree`,
            `bw tree through the helper there lists ${kid.id} under the root ${c.session}, as its rollout's parent_thread_id says`,
          )
        : fail(
            `${M}-codex-child-tree`,
            `bw tree gave ${short(kid)}; its rollout names parent ${parent}; root ${c.session}`,
          );
    });
    /** @type {any} */
    let old = null;
    await check(`${M}-old-conversation-refused`, async () => {
      const was = await t.locate();
      if (was?.type !== "located") return fail(`${M}-old-conversation-refused`, `bw locate gave ${short(was)}`);
      const r = await t.send(was, "/new");
      if (r?.result !== "sent") return fail(`${M}-old-conversation-refused`, `bw send /new gave ${short(r)}`);
      old = was;
      // In a Git repository Codex 0.167 asks where the new conversation runs; its card's option 1 keeps this folder.
      await answerFolderPrompt(`${M}-old-conversation-refused`, t, old, 1);
      if (/<hc from/.test(await t.screen()))
        return fail(`${M}-old-conversation-refused`, "the screen shows an <hc from> wrapper");
      await oldRefused(`${M}-old-conversation-refused`, t, old, async (text) => {
        const g = await there(["grep", "-rlF", "--", text, `${home}/sessions`]);
        return g.stdout.split("\n").filter(Boolean);
      });
    });
    await check(`${M}-codex-new-next-message`, async () => {
      if (!old) return fail(`${M}-codex-new-next-message`, "no /new went out");
      await nextMessage(`${M}-codex-new-next-message`, t, "codex", old);
    });
  } finally {
    await t.kill();
  }
}

if (opt.offline) {
  await offline();
} else {
  await offline();
  // BW_VERIFY_ONLY=claude,claude-prompt,claude-children,codex,remote reruns those groups alone.
  const only = process.env.BW_VERIFY_ONLY?.split(",");
  const wanted = (/** @type {string} */ g) => !only || only.includes(g);
  for (const [name, f] of [
    ["claude", claudeChecks],
    ["claude-prompt", claudePromptCheck],
    ["claude-children", claudeChildrenCheck],
    ["codex", codexChecks],
  ]) {
    if (wanted(String(name))) await check(/** @type {string} */ (name), /** @type {() => Promise<void>} */ (f));
  }
  if (opt.machine && wanted("remote")) await check(String(opt.machine), remoteChecks);
}
process.exit(report.failed ? 1 : 0);
