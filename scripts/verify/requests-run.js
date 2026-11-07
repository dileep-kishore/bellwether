// Done check 3's checks. Run by scripts/verify/requests.sh, which builds bw, makes the scratch folders, the private
// core and the remote root, puts the hook script where the agents' hooks look for it, and undoes all of it.
//   bun requests-run.js --bw B --offline --scratch L
//   bun requests-run.js --bw B --scratch L --core C [--machine M --remote-root R --remote-home H]
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHelper } from "../../shared/helper.js";
import {
  AGENT_PATH, HC, Term, USER_ENV, changed, claudeReady, codexHome, codexReady, envWith, hcUser, lines, makeRepo,
  reporter, rollouts, short, sleep, spawn, trustHooks, trustProjects, until, viaHc,
} from "./live.js";

const { values: opt } = parseArgs({
  options: {
    bw: { type: "string" },
    offline: { type: "boolean" },
    scratch: { type: "string" },
    core: { type: "string" },
    machine: { type: "string" },
    "remote-root": { type: "string" },
    "remote-home": { type: "string" },
  },
});
if (!opt.bw || !opt.scratch || (!opt.offline && !opt.core) || (opt.machine && (!opt["remote-root"] || !opt["remote-home"]))) {
  console.error("usage: bun requests-run.js --bw B --scratch L (--offline | --core C [--machine M --remote-root R --remote-home H])");
  process.exit(2);
}
const BW = opt.bw;
const L = opt.scratch;
const REPO = join(import.meta.dir, "../..");
const HOOKS = join(REPO, "tests/fixtures/hooks");
const CLAUDE = ["claude", "--model", "haiku", "--permission-mode", "default", "--setting-sources", "project", "--strict-mcp-config"];
const CODEX = ["codex", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"'];
// Codex asks only for escalation; a plain "touch x" runs in the sandbox, fails and asks nothing (Task 1, case d).
const ESC_ASK = "Run exactly this shell command with escalated sandbox permissions (ask me for approval first) and nothing else";
const CLAUDE_ASK = "Run exactly this Bash command yourself (no sub-agent) and nothing else";
const TOUCHER = `---
name: toucher
description: Runs exactly the one shell command it is given
tools: Bash
model: haiku
---
Run exactly the command you are given with the Bash tool, once, and nothing else. Then reply with the word done.
`;
const ASYNC_ASK = 'Call request_user_input_async once to ask me "Which size?" with options small and large, then end your turn. When my answer arrives, write it to size.txt.';
/** Done check 3: the card shows within 3 s of the prompt. */
const CARD_MS = 3000;

const report = reporter();
const { pass, fail, check } = report;

const CACHE = join(L, "cache");
const PRIVATE_ENV = envWith({ HC_SESSION: opt.core, BW_CACHE_DIR: CACHE });

/** `bw <args>` here, against the private core. @param {string[]} args @param {Record<string, string | undefined>} [extra] */
async function bwHere(args, extra = {}) {
  const r = await spawn([BW, ...args], { env: envWith({ ...PRIVATE_ENV, ...extra }) });
  return lines(r.stdout);
}
/** @param {string[]} args */
const hcHere = (args) => spawn([HC, ...args], { env: PRIVATE_ENV });

/** @param {string} name @param {string} cwd @param {string[]} argv @returns {Promise<Term>} */
async function startHere(name, cwd, argv) {
  // The hooks inherit BW_CACHE_DIR, so `bw event` writes where this run's `bw cards` reads.
  const r = await hcHere(["run", "--json", "--bg", "--no-parent", "--no-notify", "--name", name, "--cwd", cwd, "--", "/usr/bin/env", `BW_CACHE_DIR=${CACHE}`, ...argv]);
  const j = JSON.parse(r.stdout || "{}");
  if (!j.address) throw new Error(`hc run ${name}: ${r.stderr.trim() || r.stdout.trim()}`);
  return new Term(j.address, j.address, hcHere, (args) => bwHere(args));
}

/** The `type` lines of a bw call. @param {any[]} out @param {string} type */
const one = (out, type) => out.find((l) => l.type === type) ?? null;

/**
 * The prompt's card, as the chat's poll gets it: waits for hc to say blocked, then calls `bw feed --tree --cards`
 * until a pending request `match` accepts shows, at most CARD_MS after hc said blocked.
 * @param {Term} t @param {(req: any) => boolean} match @param {{ blocked?: boolean, limit?: number }} [o]
 */
async function cardFor(t, match, o = {}) {
  const limit = o.limit ?? 150000;
  const blocked = o.blocked ?? true;
  if (blocked) {
    const seen = await until(async () => (await t.get())?.status?.state === "blocked", limit, 250);
    if (!seen) throw new Error(`hc never said blocked: ${short((await t.get())?.status)} ${short((await t.screen(30)).split("\n").slice(-12))}`);
  }
  const since = Date.now();
  let calls = 0;
  /** @type {any[]} */
  let out = [];
  for (;;) {
    out = await t.bw(["feed", "--terminal", t.local, "--tree", "--cards"]);
    calls++;
    const req = out.find((l) => l.type === "request" && l.state === "pending" && match(l));
    const ms = Date.now() - since;
    if (req) return { req, ms, calls, cards: one(out, "cards"), tree: one(out, "tree") };
    if (blocked && ms > CARD_MS) throw new Error(`no pending card ${ms} ms after hc said blocked (${calls} polls): ${short(out.filter((l) => l.type !== "row"))}`);
    if (!blocked && ms > limit) throw new Error(`no pending card after ${ms} ms: ${short(out.filter((l) => l.type !== "row"))}`);
    await sleep(blocked ? 200 : 2000);
  }
}

/**
 * `bw answer` with the conversation the cards line names, as the chat passes `expectation(feed, kind)`.
 * @param {Term} t @param {any} req @param {any} cards @param {string[]} what `--action <a>` or `--answers <json>`
 */
async function answer(t, req, cards, what) {
  const out = await t.bw(["answer", "--terminal", t.local, "--request", req.id, "--expect-kind", cards.agent,
    "--expect-session", cards.session ?? "none", "--expect-path", cards.path ?? "none", ...what]);
  return one(out, "answer") ?? { result: "no-line", message: short(out) };
}

/** @param {() => Promise<boolean> | boolean} exists @param {number} [limit] */
const appears = (exists, limit = 30000) => until(async () => Boolean(await exists()), limit, 1000);

/** Whether a log holds the result of call `id`. @param {string} path @param {string | null} id */
function logged(path, id) {
  if (!id) return false;
  try {
    return readFileSync(path, "utf8").split("\n").some((l) => l.includes(`"tool_use_id":"${id}"`) && l.includes('"tool_result"'));
  } catch {
    return false;
  }
}

/** `bw cards` alone, timed. @param {Term} t */
async function timedCards(t) {
  const at = Date.now();
  const out = await t.bw(["cards", "--terminal", t.local]);
  return { out, ms: Date.now() - at };
}

/** The tree child the request names, by id. @param {any} tree @param {any} req */
const childOf = (tree, req) => (tree?.children ?? []).find((/** @type {any} */ c) => c.id === req.who?.child) ?? null;

/** What `question::message_text` sends for these picks of a one-question request. @param {any} req @param {number} pick */
function messageText(req, pick) {
  const qs = req.question?.questions ?? [];
  const label = qs[0]?.options?.[pick]?.label;
  return qs.length === 1 ? label : `${qs[0]?.text} ${label}`;
}

// ---- offline ----

/** One `bw hooks` call in a scratch HOME. @param {string} home @param {string[]} args */
async function hooksIn(home, args) {
  return lines((await spawn([BW, "hooks", ...args], { env: envWith({ HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined }) })).stdout);
}

/** The settings with Bellwether's group appended to each event, as `bw hooks apply` writes them. @param {any} v @param {"claude" | "codex"} kind */
function withOurs(v, kind) {
  const out = structuredClone(v);
  out.hooks ??= {};
  for (const event of ["PermissionRequest", "PreToolUse", "SubagentStart", "SubagentStop"]) {
    const hook = { type: "command", command: `: bellwether-hook=1; sh "$HOME/.local/share/bellwether/hooks/bw-event" ${kind}`, timeout: 5 };
    const group = kind === "claude" && (event === "PermissionRequest" || event === "PreToolUse") ? { matcher: "*", hooks: [hook] } : { hooks: [hook] };
    (out.hooks[event] ??= []).push(group);
  }
  return out;
}

async function hooksSetupScratch() {
  const home = join(L, "hooks-offline");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const files = { claude: join(home, ".claude/settings.json"), codex: join(home, ".codex/hooks.json") };
  const before = { claude: readFileSync(join(HOOKS, "settings-before.json"), "utf8"), codex: readFileSync(join(HOOKS, "codex-hooks-before.json"), "utf8") };
  writeFileSync(files.claude, before.claude);
  writeFileSync(files.codex, before.codex);

  const diff = await hooksIn(home, ["diff"]);
  const shas = ["claude", "codex"].map((a) => diff.find((l) => l.type === "hooks-diff" && l.agent === a)?.sha256);
  if (shas.some((s) => !s)) return fail("hooks-setup-scratch", `bw hooks diff gave ${short(diff)}`);
  const applied = await hooksIn(home, ["apply", "--expect-sha", shas.join(",")]);
  if (applied.filter((l) => l.type === "hooks-applied" && l.changed).length !== 2) return fail("hooks-setup-scratch", `bw hooks apply gave ${short(applied)}`);
  for (const a of /** @type {const} */ (["claude", "codex"])) {
    const want = `${JSON.stringify(withOurs(JSON.parse(before[a]), a), null, 2)}\n`;
    if (readFileSync(files[a], "utf8") !== want) return fail("hooks-setup-scratch", `${a}: the applied file is not the fixture with Bellwether's groups appended`);
  }
  const once = { claude: readFileSync(files.claude, "utf8"), codex: readFileSync(files.codex, "utf8") };
  const twice = await hooksIn(home, ["apply"]);
  if (twice.some((l) => l.changed) || readFileSync(files.claude, "utf8") !== once.claude || readFileSync(files.codex, "utf8") !== once.codex) return fail("hooks-setup-scratch", `apply twice changed a file: ${short(twice)}`);

  const untrusted = one(await hooksIn(home, ["check"]), "hooks");
  if (untrusted?.claude !== "ok" || untrusted?.codex !== "untrusted") return fail("hooks-setup-scratch", `bw hooks check before the trust step gave ${short(untrusted)}`);
  const trust = trustHooks(JSON.parse(once.codex), files.codex);
  const known = JSON.parse(readFileSync(join(HOOKS, "codex-trusted-hash.json"), "utf8")).hooks.find((/** @type {any} */ h) => h.event === "PermissionRequest").trusted_hash;
  if (!trust.includes(`trusted_hash = "${known}"`)) return fail("hooks-setup-scratch", `the computed trust lack Codex's recorded PermissionRequest hash ${known}`);
  writeFileSync(join(home, ".codex/config.toml"), trust);
  const trusted = one(await hooksIn(home, ["check"]), "hooks");
  if (trusted?.claude !== "ok" || trusted?.codex !== "ok") return fail("hooks-setup-scratch", `bw hooks check after the trust step gave ${short(trusted)}`);

  const removed = await hooksIn(home, ["remove"]);
  for (const a of /** @type {const} */ (["claude", "codex"])) {
    if (readFileSync(files[a], "utf8") !== before[a]) return fail("hooks-setup-scratch", `${a}: remove did not give back the fixture's bytes (${short(removed)})`);
  }
  pass("hooks-setup-scratch", "bw hooks apply appends Bellwether's four groups after every group in both fixtures, apply twice changes nothing, check says untrusted until config.toml holds Codex's hashes (PermissionRequest's equals the recorded one), remove gives back the original bytes");
}

// ---- here: Claude ----

/** A scratch repository with the toucher agent and Bellwether's hooks in its project settings. @param {string} name */
async function claudeRepo(name) {
  const dir = join(L, name);
  await makeRepo(dir, { ".claude/agents/toucher.md": TOUCHER });
  const out = await bwHere(["hooks", "apply", "--claude-settings", join(dir, ".claude/settings.json"), "--codex-hooks", join(L, "hooks-home/unused-hooks.json")], { HOME: join(L, "hooks-home") });
  if (!out.some((l) => l.type === "hooks-applied" && l.agent === "claude")) throw new Error(`bw hooks apply for ${dir}: ${short(out)}`);
  return dir;
}

/** @param {any} req */
const isRoot = (req) => req.who === null;

/** @param {Term} t @param {string} dir */
async function claudeRoot(t, dir) {
  await check("claude-root-approval", async () => {
    await t.type(`${CLAUDE_ASK}: touch root.txt`);
    const c = await cardFor(t, (r) => r.command === "touch root.txt");
    const timed = await timedCards(t);
    const again = timed.out.find((l) => l.type === "request" && l.id === c.req.id);
    if (!isRoot(c.req) || c.req.kind !== "approval" || !c.req.answerable) return fail("claude-root-approval", `card ${short(c.req)}`);
    if (!again || timed.ms >= 1000) return fail("claude-root-approval", `bw cards took ${timed.ms} ms and listed ${short(again)}`);
    if (existsSync(join(dir, "root.txt"))) return fail("claude-root-approval", "root.txt exists before bw answer");
    const a = await answer(t, c.req, c.cards, ["--action", "approve"]);
    if (a.result !== "answered") return fail("claude-root-approval", `bw answer gave ${short(a)}`);
    if (!(await appears(() => existsSync(join(dir, "root.txt"))))) return fail("claude-root-approval", "root.txt missing after bw answer");
    pass("claude-root-approval", `card (who null, hook event ${c.req.event ? "bound" : "none"}) in bw feed --tree --cards ${c.ms} ms after hc said blocked; bw cards ${timed.ms} ms; root.txt absent before, answered, present after`);
  });
  await t.wait();
}

/**
 * A sub-agent's approval: the card sits under the child bw tree lists, foreground or background as asked.
 * @param {string} name @param {Term} t @param {string} dir @param {string} file @param {boolean} background
 */
async function claudeChild(name, t, dir, file, background) {
  await check(name, async () => {
    await t.type(`Use the Agent tool exactly once with subagent_type toucher and the task: touch ${file}. Wait for it, then reply done.`);
    const c = await cardFor(t, (r) => r.command === `touch ${file}`);
    const kid = childOf(c.tree, c.req);
    if (!c.req.who?.child || !kid) return fail(name, `card who ${short(c.req.who)}; tree ${short(c.tree?.children)}`);
    if (kid.type !== "toucher" || kid.background !== background || kid.state !== "running") return fail(name, `the child bw tree lists is ${short(kid)}`);
    if (!c.req.answerable) return fail(name, `card not answerable: ${short(c.req)}`);
    if (existsSync(join(dir, file))) return fail(name, `${file} exists before bw answer`);
    const a = await answer(t, c.req, c.cards, ["--action", "approve"]);
    if (a.result !== "answered") return fail(name, `bw answer gave ${short(a)}`);
    if (!(await appears(() => existsSync(join(dir, file))))) return fail(name, `${file} missing after bw answer`);
    pass(name, `card under ${background ? "background" : "foreground"} child ${kid.id} ("${kid.description}", the id bw tree lists; hook event ${c.req.event ? "bound" : "none"}) ${c.ms} ms after hc said blocked; ${file} absent before, answered, present after`);
  });
  await t.wait(180);
}

/** Review Focus 1: a prompt answered in the terminal, then an identical one; the first card presses nothing. @param {Term} t @param {string} dir */
async function claudeStale(t, dir) {
  const file = join(dir, "stale.txt");
  /** @type {any} */
  let first = null;
  await check("claude-stale-after-terminal-answer", async () => {
    await t.type(`${CLAUDE_ASK}: touch stale.txt`);
    const c = await cardFor(t, (r) => r.command === "touch stale.txt");
    first = c;
    await t.keys("1");
    if (!(await appears(() => existsSync(file)))) return fail("claude-stale-after-terminal-answer", "stale.txt missing after 1 in the terminal");
    // bw cards settles a box that left on its first pass after: before the call's result is logged that is stale.
    if (!(await appears(() => logged(c.cards.path, c.req.tool_use_id)))) return fail("claude-stale-after-terminal-answer", `the log never got the result of ${c.req.tool_use_id}`);
    await t.wait();
    const cards = await t.bw(["cards", "--terminal", t.local]);
    const was = cards.find((l) => l.type === "request" && l.id === c.req.id);
    const a = await t.steady();
    const r = await answer(t, c.req, c.cards, ["--action", "approve"]);
    await sleep(2000);
    const b = await t.screen();
    if (was?.state !== "answered_terminal") {
      const why = was && { state: was.state, tool_use_id: was.tool_use_id, event: was.event, screen_id: was.screen_id, at_ms: was.at_ms, resolved_ms: was.resolved_ms };
      return fail("claude-stale-after-terminal-answer", `bw cards after the box left shows ${short(why)}; bw answer then gave ${short(r)}`);
    }
    if (r.result !== "stale") return fail("claude-stale-after-terminal-answer", `bw answer gave ${short(r)}`);
    if (a !== b) return fail("claude-stale-after-terminal-answer", `the screen changed: ${short(changed(a, b))}`);
    pass("claude-stale-after-terminal-answer", `answered with hc keys 1; bw cards shows answered_terminal; bw answer on the old card gave stale ("${r.message}"); hc read before and after equal`);
  });
  await check("claude-stale-next-occurrence", async () => {
    if (!first) return fail("claude-stale-next-occurrence", "no first card");
    rmSync(file, { force: true });
    await t.type(`${CLAUDE_ASK}: touch stale.txt (run it again)`);
    const c = await cardFor(t, (r) => r.command === "touch stale.txt" && r.id !== first.req.id);
    const a = await t.steady();
    const r = await answer(t, first.req, first.cards, ["--action", "approve"]);
    await sleep(2000);
    const b = await t.screen();
    const absent = !existsSync(file);
    if (r.result !== "stale" || a !== b || !absent) return fail("claude-stale-next-occurrence", `old card gave ${short(r)}; screen ${a === b ? "unchanged" : short(changed(a, b))}; stale.txt ${absent ? "absent" : "present"}`);
    const r2 = await answer(t, c.req, c.cards, ["--action", "approve"]);
    if (r2.result !== "answered" || !(await appears(() => existsSync(file)))) return fail("claude-stale-next-occurrence", `the new card gave ${short(r2)}; stale.txt ${existsSync(file) ? "present" : "absent"}`);
    pass("claude-stale-next-occurrence", "the same command asked again: the old card gave stale, the box stayed (hc read equal) and stale.txt stayed absent; the new card answered it");
  });
  await t.wait();
}

/** @param {Term} t @param {string} dir */
async function claudeDeny(t, dir) {
  await check("claude-deny", async () => {
    await t.type(`${CLAUDE_ASK}: touch deny.txt`);
    const c = await cardFor(t, (r) => r.command === "touch deny.txt");
    const r = await answer(t, c.req, c.cards, ["--action", "deny"]);
    if (r.result !== "declined") return fail("claude-deny", `bw answer --action deny gave ${short(r)}`);
    await t.wait();
    await sleep(3000);
    if (existsSync(join(dir, "deny.txt"))) return fail("claude-deny", "deny.txt exists after Deny");
    const l = await t.locate();
    if (l?.type !== "located") return fail("claude-deny", `bw locate after Deny gave ${short(l)}`);
    const ask = "Reply with the word KIWI only.";
    const s = await t.send(l, ask);
    if (s?.result !== "sent") return fail("claude-deny", `bw send after Deny gave ${short(s)}`);
    await t.wait();
    const rows = await until(async () => {
      const got = await t.rows();
      return got.some((x) => x.k === "assistant" && String(x.text).includes("KIWI")) ? got : null;
    }, 40000);
    rows ? pass("claude-deny", "Deny gave declined; deny.txt absent; the next message got its reply in the same session") : fail("claude-deny", "no KIWI reply after Deny");
  });
}

async function claudeChecks() {
  const fg = await claudeRepo("claude-fg");
  const bg = await claudeRepo("claude-bg");
  // In a terminal Claude 2.1.319 backgrounds every sub-agent unless this is set (Task 1's note).
  const a = await startHere("bw-requests-claude-fg", fg, ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1", ...CLAUDE]);
  try {
    await claudeReady(a);
    await claudeRoot(a, fg);
    await claudeChild("claude-fg-child-approval", a, fg, "fg.txt", false);
    await claudeStale(a, fg);
    await claudeDeny(a, fg);
  } finally {
    await a.kill();
  }
  const b = await startHere("bw-requests-claude-bg", bg, CLAUDE);
  try {
    await claudeReady(b);
    await claudeChild("claude-bg-child-approval", b, bg, "bg.txt", true);
  } finally {
    await b.kill();
  }
}

// ---- here: Codex ----

/** Codex's scratch home: auth.json, folder trust, Bellwether's hooks and their trust entries. @param {string[]} repos */
async function codexHomeWithHooks(...repos) {
  const home = join(L, "codex-home");
  codexHome(home, ...repos);
  const out = await bwHere(["hooks", "apply", "--claude-settings", join(L, "hooks-home/unused-settings.json"), "--codex-hooks", join(home, "hooks.json")], { HOME: join(L, "hooks-home") });
  if (!out.some((l) => l.type === "hooks-applied" && l.agent === "codex")) throw new Error(`bw hooks apply for ${home}: ${short(out)}`);
  const hooksFile = join(home, "hooks.json");
  writeFileSync(join(home, "config.toml"), `${trustProjects(repos)}\n${trustHooks(JSON.parse(readFileSync(hooksFile, "utf8")), hooksFile)}`);
  const c = one(await bwHere(["hooks", "check", "--claude-settings", join(L, "hooks-home/unused-settings.json"), "--codex-hooks", hooksFile], { HOME: join(L, "hooks-home") }), "hooks");
  if (c?.codex !== "ok") throw new Error(`bw hooks check on the scratch CODEX_HOME gave ${short(c)}`);
  return home;
}

async function codexChecks() {
  const dir = join(L, "codex-approve");
  const ask = join(L, "codex-ask");
  await makeRepo(dir);
  await makeRepo(ask);
  const home = await codexHomeWithHooks(dir, ask);
  const t = await startHere("bw-requests-codex", dir, [`CODEX_HOME=${home}`, ...CODEX, "-a", "on-request", "-s", "read-only"]);
  try {
    await codexReady(t);
    await check("codex-root-approval", async () => {
      await t.type(`${ESC_ASK}: touch codex.txt`);
      const c = await cardFor(t, (r) => r.command === "touch codex.txt");
      if (!isRoot(c.req) || !c.req.answerable) return fail("codex-root-approval", `card ${short(c.req)}`);
      if (existsSync(join(dir, "codex.txt"))) return fail("codex-root-approval", "codex.txt exists before bw answer");
      const a = await answer(t, c.req, c.cards, ["--action", "approve"]);
      if (a.result !== "answered") return fail("codex-root-approval", `bw answer gave ${short(a)}`);
      if (!(await appears(() => existsSync(join(dir, "codex.txt"))))) return fail("codex-root-approval", "codex.txt missing after bw answer");
      pass("codex-root-approval", `card (who null, hook event ${c.req.event ? "bound" : "none"}) ${c.ms} ms after hc said blocked; codex.txt absent before, answered with y, present after`);
    });
    await t.wait();
    await check("codex-child-approval", async () => {
      await t.type("Spawn exactly one sub-agent with spawn_agent. Its task: run exactly this shell command with escalated sandbox permissions (asking for approval first) and nothing else: touch child.txt. Wait for it with wait_agent, then reply done.");
      const c = await cardFor(t, (r) => r.command === "touch child.txt");
      const kid = childOf(c.tree, c.req);
      const rollout = rollouts(home).find((r) => r.child && r.id === c.req.who?.child);
      if (!kid || !rollout) return fail("codex-child-approval", `card who ${short(c.req.who)}; tree ${short(c.tree?.children)}`);
      if (!c.req.answerable) return fail("codex-child-approval", `card not answerable (${c.req.reason}); decision 12 made Codex children answerable`);
      if (existsSync(join(dir, "child.txt"))) return fail("codex-child-approval", "child.txt exists before bw answer");
      const a = await answer(t, c.req, c.cards, ["--action", "approve"]);
      if (a.result !== "answered") return fail("codex-child-approval", `bw answer gave ${short(a)}`);
      if (!(await appears(() => existsSync(join(dir, "child.txt"))))) return fail("codex-child-approval", "child.txt missing after bw answer");
      pass("codex-child-approval", `card under child ${kid.id} (its rollout's id, as bw tree lists it) ${c.ms} ms after hc said blocked; answerable; child.txt absent before, answered with y on the parent's terminal, present after`);
    });
    await t.wait(180);
  } finally {
    await t.kill();
  }

  const q = await startHere("bw-requests-codex-ask", ask, [`CODEX_HOME=${home}`, ...CODEX, "--enable", "default_mode_request_user_input"]);
  try {
    await codexReady(q);
    await check("codex-async-question", async () => asyncQuestion("codex-async-question", q, async () => {
      try {
        return readFileSync(join(ask, "size.txt"), "utf8").trim();
      } catch {
        return "";
      }
    }));
  } finally {
    await q.kill();
  }
}

/**
 * Codex's request_user_input_async answered from its card as one user message.
 * @param {string} name @param {Term} t @param {() => Promise<string>} size what size.txt holds
 */
async function asyncQuestion(name, t, size) {
  await t.type(ASYNC_ASK);
  await t.wait(120);
  const c = await cardFor(t, (r) => r.kind === "question_async", { blocked: false, limit: 60000 });
  const usersBefore = (await t.rows()).filter((r) => r.k === "user").length;
  const text = messageText(c.req, 1);
  const a = await answer(t, c.req, c.cards, ["--answers", '[{"picks":[1]}]']);
  if (a.result !== "answered") return fail(name, `bw answer --answers gave ${short(a)}`);
  await sleep(3000);
  await t.wait(120);
  if (!(await appears(async () => (await size()) === "large", 60000))) return fail(name, `size.txt holds ${short(await size())}`);
  const users = (await t.rows()).filter((r) => r.k === "user");
  const added = users.slice(usersBefore);
  if (added.length !== 1 || added[0].text !== text) return fail(name, `the feed gained ${short(added.map((r) => r.text))}; message_text gives ${short(text)}`);
  pass(name, `card ${c.ms} ms into polling; bw answer --answers [{picks:[1]}] gave answered; the rollout gained exactly one user message, "${text}", and size.txt holds large`);
}

// ---- the other machine ----

async function remoteChecks() {
  const M = /** @type {string} */ (opt.machine);
  const R = /** @type {string} */ (opt["remote-root"]);
  const H = /** @type {string} */ (opt["remote-home"]);
  const helper = createHelper({
    exec: (cmd, args, { on }) => (on == null ? spawn([cmd, ...args]) : viaHc(on, cmd, args)),
    localInstall: async (machine) => lines((await spawn([BW, "machine", "install", machine], { env: USER_ENV })).stdout),
  });
  const there = (/** @type {string[]} */ argv) => viaHc(M, argv[0], argv.slice(1));
  const setup = async (/** @type {string[]} */ args) => lines((await spawn([BW, "machine", "setup", M, ...args], { env: USER_ENV })).stdout);
  const codexDir = `${H}/.codex`;
  const rpath = (await there(["sh", "-c", 'printf %s "$PATH"'])).stdout || AGENT_PATH;

  let ready = false;
  await check(`${M}-hooks-setup`, async () => {
    const diff = await setup(["--diff"]);
    const paths = diff.filter((l) => l.type === "hooks-diff").map((l) => l.path).sort();
    const want = [`${H}/.claude/settings.json`, `${codexDir}/hooks.json`].sort();
    if (!Bun.deepEquals(paths, want)) return fail(`${M}-hooks-setup`, `--diff names ${short(paths)}, wanted ${short(want)}`);
    const shas = ["claude", "codex"].map((a) => diff.find((l) => l.type === "hooks-diff" && l.agent === a).sha256);
    const applied = await setup(["--apply", "--expect-sha", shas.join(",")]);
    if (applied.filter((l) => l.type === "hooks-applied").length !== 2) return fail(`${M}-hooks-setup`, `--apply gave ${short(applied)}`);
    const before = one(await setup(["--check"]), "hooks");
    if (before?.claude !== "ok" || before?.codex !== "untrusted") return fail(`${M}-hooks-setup`, `--check before the trust step gave ${short(before)}`);
    const hooksJson = (await there(["cat", `${codexDir}/hooks.json`])).stdout;
    const config = `${trustProjects([`${R}/approve`, `${R}/ask`])}\n${trustHooks(JSON.parse(hooksJson), `${codexDir}/hooks.json`)}`;
    const w = await spawn([HC, "file", "write", "--json", "--on", M, `${codexDir}/config.toml`], { env: USER_ENV, stdin: new Blob([config]) });
    if (w.code !== 0) return fail(`${M}-hooks-setup`, `hc file write config.toml: ${w.stderr.trim()}`);
    const after = one(await setup(["--check"]), "hooks");
    if (after?.claude !== "ok" || after?.codex !== "ok") return fail(`${M}-hooks-setup`, `--check after the trust step gave ${short(after)}`);
    ready = true;
    pass(`${M}-hooks-setup`, `bw machine setup ${M} --diff names ${want.join(" and ")}; --apply with its sha256s; --check says codex untrusted, then ok once ${codexDir}/config.toml holds the trust entries`);
  });
  if (!ready) return;

  const auth = await spawn([HC, "file", "write", "--json", "--on", M, `${codexDir}/auth.json`], { env: USER_ENV, stdin: Bun.file(join(process.env.HOME ?? "", ".codex/auth.json")) });
  if (auth.code !== 0) return fail(`${M}-codex-approval`, `hc file write auth.json on ${M}: ${auth.stderr.trim()}`);
  await there(["chmod", "600", `${codexDir}/auth.json`]);
  await makeRepo(`${R}/approve`, {}, there);
  await makeRepo(`${R}/ask`, {}, there);

  /** @param {string} name @param {string} cwd @param {string[]} flags */
  const startThere = async (name, cwd, flags) => {
    const run = await hcUser(["run", "--json", "--bg", "--on", M, "--no-parent", "--no-notify", "--name", name, "--cwd", cwd, "--",
      "/usr/bin/env", `CODEX_HOME=${codexDir}`, `PATH=${rpath}`, ...CODEX, ...flags]);
    const address = JSON.parse(run.stdout || "{}").address;
    if (!address) throw new Error(`hc run --on ${M}: ${run.stderr.trim() || run.stdout.trim()}`);
    appendFileSync(join(L, "remote-terminals"), `${address}\n`);
    const local = address.slice(M.length + 1);
    // hc send from this core would type an <hc from> wrapper there; that machine's own core types it as is.
    const hcThere = async (/** @type {string[]} */ args) => (args[0] === "send" ? there(["hc", ...args.slice(0, 3), local, ...args.slice(4)]) : hcUser(args));
    const bwThere = async (/** @type {string[]} */ args) => {
      const r = await helper.call(M, args);
      return r.ok ? r.lines : [{ type: "failure", ...r }];
    };
    return new Term(address, local, hcThere, bwThere);
  };
  const exists = async (/** @type {string} */ p) => (await there(["test", "-f", p])).code === 0;

  const t = await startThere("bw-requests-codex", `${R}/approve`, ["-a", "on-request", "-s", "read-only"]);
  try {
    await codexReady(t);
    await check(`${M}-codex-approval`, async () => {
      await t.type(`${ESC_ASK}: touch remote.txt`);
      const c = await cardFor(t, (r) => r.command === "touch remote.txt");
      if (!isRoot(c.req) || !c.req.answerable) return fail(`${M}-codex-approval`, `card ${short(c.req)}`);
      if (c.cards?.hooks !== "ok" || !c.req.event) return fail(`${M}-codex-approval`, `the cards line says hooks ${c.cards?.hooks}, event ${c.req.event}: the hook on ${M} did not run`);
      if (await exists(`${R}/approve/remote.txt`)) return fail(`${M}-codex-approval`, "remote.txt exists before bw answer");
      const a = await answer(t, c.req, c.cards, ["--action", "approve"]);
      if (a.result !== "answered") return fail(`${M}-codex-approval`, `bw answer through the helper there gave ${short(a)}`);
      if (!(await appears(() => exists(`${R}/approve/remote.txt`)))) return fail(`${M}-codex-approval`, `hc exec --on ${M} test -f remote.txt failed after bw answer`);
      pass(`${M}-codex-approval`, `bw feed --tree --cards through the helper there shows the card ${c.ms} ms after hc said blocked, hooks ok and its event bound; bw answer there gave answered; hc exec --on ${M} test -f remote.txt`);
    });
    await t.wait();
    await check(`${M}-stale`, async () => {
      await t.type(`${ESC_ASK}: touch remote-stale.txt`);
      const c = await cardFor(t, (r) => r.command === "touch remote-stale.txt");
      await t.keys("y");
      if (!(await appears(() => exists(`${R}/approve/remote-stale.txt`)))) return fail(`${M}-stale`, "remote-stale.txt missing after y in the terminal");
      await t.wait();
      const a = await t.steady();
      const r = await answer(t, c.req, c.cards, ["--action", "approve"]);
      await sleep(2000);
      const b = await t.screen();
      if (r.result !== "stale") return fail(`${M}-stale`, `bw answer gave ${short(r)}`);
      if (a !== b) return fail(`${M}-stale`, `the screen changed: ${short(changed(a, b))}`);
      pass(`${M}-stale`, `answered with hc keys y; bw answer there on the old card gave stale; hc read before and after equal`);
    });
  } finally {
    await t.kill();
  }

  const q = await startThere("bw-requests-codex-ask", `${R}/ask`, ["--enable", "default_mode_request_user_input"]);
  try {
    await codexReady(q);
    await check(`${M}-async-question`, async () => asyncQuestion(`${M}-async-question`, q, async () => (await there(["cat", `${R}/ask/size.txt`])).stdout.trim()));
  } finally {
    await q.kill();
  }
}

// ---- main ----

// BW_VERIFY_ONLY=claude,codex,remote reruns those groups alone (the offline check always runs).
const only = process.env.BW_VERIFY_ONLY?.split(",");
const wanted = (/** @type {string} */ g) => !only || only.includes(g);
await check("hooks-setup-scratch", hooksSetupScratch);
if (!opt.offline) {
  if (wanted("claude")) await check("claude", claudeChecks);
  if (wanted("codex")) await check("codex", codexChecks);
  if (opt.machine && wanted("remote")) await check(String(opt.machine), remoteChecks);
}
process.exit(report.failed ? 1 : 0);
