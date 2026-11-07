// Rewrites private values in recorded agent logs and finds any that remain.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

export const SCRATCH_ROOT = process.env.BW_REC_ROOT ?? "/private/tmp/claude-501/bw-rec";

// Checked on every machine, whoever runs the check: the names in REVIEW.md's fixture rule.
const STATIC_CHECKS = [
  ["home path", /\/Users\//],
  ["name", /dileep|kishore/i],
  ["hostname", /mac-mini/i],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// The lookbehind keeps words such as "risk-free" or "task-list" from counting as tokens.
const TOKEN = /(?<![A-Za-z0-9_-])(?:sk-ant-|sk-|lin_api_|gho_|ghp_)[A-Za-z0-9][A-Za-z0-9_-]*/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slug = (path) => path.replace(/[^A-Za-z0-9]/g, "-");

export function defaultContext() {
  const users = [userInfo().username, ...(process.env.BW_SCRUB_USERS ?? "").split(",")];
  const hosts = [hostname().split(".")[0], ...(process.env.BW_SCRUB_HOSTS ?? "").split(",")];
  // Short names would match inside ordinary words.
  const keep = (list) => [...new Set(list.map((s) => s.trim()).filter((s) => s.length >= 4))];
  return { users: keep(users), hosts: keep(hosts), instructionLines: instructionLines() };
}

// Lines of the user's own global instruction files; a fixture that quotes one leaked them.
function instructionLines() {
  const files = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".agents/AGENTS.md"].map((f) => join(homedir(), f));
  const lines = files.filter((f) => existsSync(f)).flatMap((f) => readFileSync(f, "utf8").split("\n"));
  return [...new Set(lines.map((l) => l.trim()).filter((l) => l.length >= 40))];
}

function wordRegex(word, flags = "gi") {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}(?![A-Za-z0-9])`, flags);
}

export function scrubText(text, ctx = defaultContext()) {
  let out = text.replace(EMAIL, "user@example.com").replace(TOKEN, "REDACTED");

  const bare = SCRATCH_ROOT.replace(/^\/private\//, "/");
  for (const root of [SCRATCH_ROOT, bare]) {
    out = out.replace(new RegExp(`${escapeRe(root)}/([A-Za-z0-9._-]+)`, "g"), "/scratch/$1");
    out = out.replace(new RegExp(`${escapeRe(slug(root))}-([A-Za-z0-9-]+)`, "g"), "-scratch-$1");
  }
  out = out.replace(/(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T\//g, "/tmp/");
  out = out.replace(/(?:\/private)?\/tmp\/claude-\d+\//g, "/tmp/");

  out = out.replace(/\/Users\/[^/\s"'\\:]+/g, "/home/user");
  out = out.replace(/\/home\/(?!user(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/g, "/home/user");
  out = out.replace(/-Users-[A-Za-z0-9]+/g, "-home-user");

  for (const host of ctx.hosts) {
    out = out.replace(new RegExp(`${escapeRe(host)}(?:\\.[A-Za-z0-9-]+)*`, "gi"), "host");
  }
  for (const user of ctx.users) out = out.replace(wordRegex(user), "user");
  out = out.replace(/dileep\s+kishore/gi, "Test User");
  return out;
}

export function checkText(text, ctx = defaultContext()) {
  const patterns = [
    ...STATIC_CHECKS,
    ...ctx.users.map((u) => ["username", wordRegex(u, "i")]),
    ...ctx.hosts.map((h) => ["hostname", new RegExp(escapeRe(h), "i")]),
    ["email", { test: (l) => [...l.matchAll(EMAIL)].some((m) => m[0] !== "user@example.com") }],
    ["token", new RegExp(TOKEN.source)],
  ];
  const quoted = (ctx.instructionLines ?? []).flatMap((l) => [l, JSON.stringify(l).slice(1, -1)]);
  if (quoted.length) patterns.push(["instruction text", { test: (l) => quoted.some((q) => l.includes(q)) }]);
  const hits = [];
  text.split("\n").forEach((line, i) => {
    const names = [...new Set(patterns.filter(([, re]) => re.test(line)).map(([n]) => n))];
    if (names.length) hits.push({ line: i + 1, patterns: names });
  });
  return hits;
}

const placeholder = (what) => `[scrubbed: ${what} removed by scrub-fixture]`;
const isPlaceholder = (v) => typeof v === "string" && v.startsWith("[scrubbed: ");
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const ID_KEYS = new Set([
  "accountUuid",
  "organizationUuid",
  "orgUuid",
  "creator_account_id",
  "creator_user_id",
  "chatgpt_account_id",
  "account_id",
]);

const INSTRUCTION_MARKERS = [/^# AGENTS\.md instructions/, /<INSTRUCTIONS>/, /<user_instructions>/];

// Replaces obj[key] with a placeholder: a {text} object keeps its shape, anything else becomes
// the placeholder string. Returns whether it changed.
function blank(obj, key, what) {
  const v = obj?.[key];
  if (v == null || v === "" || isPlaceholder(v)) return false;
  if (typeof v === "object" && !Array.isArray(v) && typeof v.text === "string") {
    if (isPlaceholder(v.text)) return false;
    obj[key] = { ...v, text: placeholder(what) };
  } else {
    obj[key] = placeholder(what);
  }
  return true;
}

function blankTexts(parts, what, when = () => true) {
  let changed = false;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part?.text === "string" && !isPlaceholder(part.text) && when(part.text)) {
      part.text = placeholder(what);
      changed = true;
    }
  }
  return changed;
}

function zeroIds(value) {
  let changed = false;
  if (Array.isArray(value)) {
    for (const v of value) changed = zeroIds(v) || changed;
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (ID_KEYS.has(k) && typeof v === "string" && v !== ZERO_ID) {
        value[k] = ZERO_ID;
        changed = true;
      } else changed = zeroIds(v) || changed;
    }
  }
  return changed;
}

// Agent logs embed the user's global instructions, skills and connected apps, and the agent's
// own system prompt and tool schemas; all are long or private, and no parser needs their words.
function codexRules(rec) {
  const p = rec.payload;
  if (!p || typeof p !== "object") return false;
  let c = false;
  if (rec.type === "session_meta") c = blank(p, "base_instructions", "Codex base instructions") || c;
  if (rec.type === "turn_context") {
    c = blank(p, "user_instructions", "user instructions") || c;
    c = blank(p, "developer_instructions", "developer instructions") || c;
    c = blank(p, "base_instructions", "Codex base instructions") || c;
  }
  if (rec.type === "world_state" && p.state && typeof p.state === "object") {
    c = blank(p.state, "agents_md", "AGENTS.md instructions") || c;
    c = blank(p.state.host_skills ?? {}, "body", "skill listing") || c;
    c = blank(p.state, "tools", "connected tool list") || c;
  }
  if (rec.type === "response_item" && p.type === "additional_tools") c = blank(p, "tools", "tool schemas") || c;
  if (rec.type === "response_item" && p.type === "message") {
    if (p.role === "developer" || p.role === "system") c = blankTexts(p.content, `${p.role} message`) || c;
    if (p.role === "user") {
      const isInstr = (t) => INSTRUCTION_MARKERS.some((m) => m.test(t));
      c = blankTexts(p.content, "AGENTS.md instructions", isInstr) || c;
    }
  }
  return c;
}

function claudeRules(rec) {
  let c = false;
  if (rec.type === "api-request-shape" && rec.shape) {
    c = blank(rec.shape, "system", "system prompt") || c;
    c = blank(rec.shape, "tools", "tool schemas") || c;
  }
  if (rec.type === "api-request-blob" && rec.message?.role === "system") {
    c = blankTexts(rec.message.content, "system prompt") || c;
  }
  const a = rec.type === "attachment" ? rec.attachment : null;
  if (a?.type === "prompt_snapshot") {
    for (const key of ["systemPrompt", "tools", "systemTurns", "keptReminders", "inlineTools"]) {
      const v = a[key];
      if (typeof v === "boolean" || (Array.isArray(v) && v.length === 0)) continue;
      c = blank(a, key, key === "tools" ? "tool schemas" : "system prompt") || c;
    }
  }
  if (a?.type === "skill_listing") {
    c = blank(a, "content", "skill listing") || c;
    // The same listing is stored a second time as the reminder text the model saw.
    for (const r of Array.isArray(rec.rendered) ? rec.rendered : []) c = blank(r, "content", "skill listing") || c;
  }
  return c;
}

function scrubRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  const a = codexRules(rec);
  const b = claudeRules(rec);
  return zeroIds(rec) || a || b;
}

export function scrubJsonLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return line;
  }
  return scrubRecord(rec) ? JSON.stringify(rec) : line;
}

export function scrubFile(text, ctx = defaultContext()) {
  const structured = text
    .split("\n")
    .map((l) => (l.trimStart().startsWith("{") ? scrubJsonLine(l) : l))
    .join("\n");
  return scrubText(structured, ctx);
}
