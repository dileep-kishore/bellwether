import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkText, scrubJsonLine, scrubText } from "./scrub.js";

const CLI = join(import.meta.dir, "scrub-fixture");

// Planted values are assembled from parts so this file never holds them whole.
const user = ["dki", "shore"].join("");
const home = `/Users/${user}`;
const host = ["Dileeps", "Mac", "mini"].join("-");
const email = `${user}@${"lbl"}.gov`;
const antKey = ["sk", "ant", "api03", "AbCdEf0123456789xyz"].join("-");
const linKey = ["lin", "api", "0123456789abcdefABCDEF"].join("_");
const ghoKey = ["gho", "0123456789abcdefABCDEF"].join("_");
const ghpKey = ["ghp", "0123456789abcdefABCDEF"].join("_");
const skKey = ["sk", "proj", "0123456789abcdefABCDEF"].join("-");

const ctx = { users: [user], hosts: [host] };

function run(args) {
  // The CLI scrubs this machine's hostname, so the planted one must be named on every other machine.
  const env = { ...process.env, BW_SCRUB_HOSTS: host };
  const p = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "bw-scrub-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("scrubText", () => {
  test("rewrites home path, username, hostname, email and tokens", () => {
    const text = [
      `cwd ${home}/src/thing`,
      `slug -Users-${user}--t3-worktrees-x`,
      `whoami ${user}`,
      `host ${host}.local and ${host}`,
      `mail ${email}`,
      `keys ${antKey} ${linKey} ${ghoKey} ${ghpKey} ${skKey}`,
    ].join("\n");
    const out = scrubText(text, ctx);
    expect(out).toBe(
      [
        "cwd /home/user/src/thing",
        "slug -home-user--t3-worktrees-x",
        "whoami user",
        "host host and host",
        "mail user@example.com",
        "keys REDACTED REDACTED REDACTED REDACTED REDACTED",
      ].join("\n"),
    );
    expect(checkText(out, ctx)).toEqual([]);
  });

  test("rewrites the scratch folder and its slug to /scratch/<name>", () => {
    const text =
      "/private/tmp/claude-501/bw-rec/claude-picture/a.png " +
      "/tmp/claude-501/bw-rec/claude-picture " +
      "-private-tmp-claude-501-bw-rec-claude-picture";
    expect(scrubText(text, ctx)).toBe("/scratch/claude-picture/a.png /scratch/claude-picture -scratch-claude-picture");
  });

  test("rewrites the paths in Claude and Codex hook payloads and HC_* variables", () => {
    const sid = "4ddbb5d8-cd66-4547-9525-d6282dd8f0be";
    const claude = JSON.stringify({
      session_id: sid,
      transcript_path: `${home}/.claude/projects/-private-tmp-claude-501-bw-rec-claude-child-approval/${sid}.jsonl`,
      cwd: "/private/tmp/claude-501/bw-rec/claude-child-approval",
      scratchpad_dir: `/private/tmp/claude-501/-private-tmp-claude-501-bw-rec-claude-child-approval/${sid}/scratchpad`,
      agent_id: "a74b1c8063469d6e2",
    });
    expect(JSON.parse(scrubText(claude, ctx))).toEqual({
      session_id: sid,
      transcript_path: `/home/user/.claude/projects/-scratch-claude-child-approval/${sid}.jsonl`,
      cwd: "/scratch/claude-child-approval",
      scratchpad_dir: `/tmp/-scratch-claude-child-approval/${sid}/scratchpad`,
      agent_id: "a74b1c8063469d6e2",
    });

    const rollout = "sessions/2026/11/07/rollout-2026-11-07T02-23-00-01a1b588.jsonl";
    const codex = JSON.stringify({
      transcript_path: `/private/tmp/claude-501/bw-rec/codex-child-approval.codex-home/${rollout}`,
      agent_transcript_path: `${home}/.bwl/bw-verify/probe/codex-home/${rollout}`,
    });
    expect(JSON.parse(scrubText(codex, ctx))).toEqual({
      transcript_path: `/scratch/codex-child-approval.codex-home/${rollout}`,
      agent_transcript_path: `/home/user/.bwl/bw-verify/probe/codex-home/${rollout}`,
    });

    const env = `HC_SESSION=bw-probe\nHC_TERMINAL_ID=t4\nHC_TERMINAL_SOCKET=${home}/.local/state/herdr-core/bw-probe/bw-probe.sock\n`;
    const envOut = scrubText(env, ctx);
    expect(envOut).toBe(
      "HC_SESSION=bw-probe\nHC_TERMINAL_ID=t4\nHC_TERMINAL_SOCKET=/home/user/.local/state/herdr-core/bw-probe/bw-probe.sock\n",
    );
    expect(checkText(scrubText(claude, ctx) + scrubText(codex, ctx) + envOut, ctx)).toEqual([]);
  });

  test("leaves words that only contain a token prefix alone", () => {
    const text = "risk-free task-list ask-user desk-lamp";
    expect(scrubText(text, ctx)).toBe(text);
    expect(checkText(text, ctx)).toEqual([]);
  });

  test("keeps JSON lines valid", () => {
    const line = JSON.stringify({ cwd: home, text: `hi ${email} ${antKey}` });
    const out = JSON.parse(scrubText(line, ctx));
    expect(out).toEqual({ cwd: "/home/user", text: "hi user@example.com REDACTED" });
  });
});

describe("scrubJsonLine", () => {
  test("replaces Codex base and developer instructions with a placeholder", () => {
    const long = "You are Codex. ".repeat(40);
    const meta = {
      type: "session_meta",
      payload: { id: "t1", cwd: "/x", base_instructions: { text: long } },
    };
    const out = JSON.parse(scrubJsonLine(JSON.stringify(meta)));
    expect(out.payload.id).toBe("t1");
    expect(out.payload.base_instructions.text).toMatch(/^\[scrubbed: /);

    const dev = {
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: long }] },
    };
    const devOut = JSON.parse(scrubJsonLine(JSON.stringify(dev)));
    expect(devOut.payload.content[0].text).toMatch(/^\[scrubbed: /);

    const ctxLine = {
      type: "turn_context",
      payload: { cwd: "/x", user_instructions: long, developer_instructions: long },
    };
    const ctxOut = JSON.parse(scrubJsonLine(JSON.stringify(ctxLine)));
    expect(ctxOut.payload.user_instructions).toMatch(/^\[scrubbed: /);
    expect(ctxOut.payload.developer_instructions).toMatch(/^\[scrubbed: /);
  });

  test("replaces an AGENTS.md block sent as a user message", () => {
    const msg = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nsecret rules\n</INSTRUCTIONS>",
          },
          { type: "input_text", text: "make a file" },
        ],
      },
    };
    const out = JSON.parse(scrubJsonLine(JSON.stringify(msg)));
    expect(out.payload.content[0].text).toMatch(/^\[scrubbed: /);
    expect(out.payload.content[1].text).toBe("make a file");
  });

  test("replaces Codex AGENTS.md, skills and tool lists in world_state and additional_tools", () => {
    const long = "rules ".repeat(100);
    const ws = {
      type: "world_state",
      payload: {
        full: true,
        state: {
          agents_md: { text: long },
          host_skills: { body: long, includeInstructions: true },
          tools: { mcp__codex_apps__gmail: {} },
          environments: { current_date: "2026-11-06" },
        },
      },
    };
    const out = JSON.parse(scrubJsonLine(JSON.stringify(ws))).payload.state;
    expect(out.agents_md.text).toMatch(/^\[scrubbed: /);
    expect(out.host_skills.body).toMatch(/^\[scrubbed: /);
    expect(out.host_skills.includeInstructions).toBe(true);
    expect(out.tools).toMatch(/^\[scrubbed: /);
    expect(out.environments).toEqual({ current_date: "2026-11-06" });

    const extra = {
      type: "response_item",
      payload: { type: "additional_tools", role: "developer", tools: [{ name: "x" }] },
    };
    expect(JSON.parse(scrubJsonLine(JSON.stringify(extra))).payload.tools).toMatch(/^\[scrubbed: /);
  });

  test("replaces Claude system prompt, tool schemas and skill listing", () => {
    const long = "You are Claude Code. ".repeat(40);
    const shape = { type: "api-request-shape", shape: { system: [{ text: long }], tools: [{ name: "Bash" }] } };
    const shapeOut = JSON.parse(scrubJsonLine(JSON.stringify(shape)));
    expect(shapeOut.shape.system).toMatch(/^\[scrubbed: /);
    expect(shapeOut.shape.tools).toMatch(/^\[scrubbed: /);

    const blob = {
      type: "api-request-blob",
      message: { role: "system", content: [{ type: "text", text: long }] },
    };
    const blobOut = JSON.parse(scrubJsonLine(JSON.stringify(blob)));
    expect(blobOut.message.content[0].text).toMatch(/^\[scrubbed: /);

    const userBlob = { type: "api-request-blob", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
    expect(scrubJsonLine(JSON.stringify(userBlob))).toBe(JSON.stringify(userBlob));

    const snap = {
      type: "attachment",
      attachment: { type: "prompt_snapshot", systemPrompt: long, tools: [{ name: "Bash" }], reminderFold: true },
    };
    const snapOut = JSON.parse(scrubJsonLine(JSON.stringify(snap))).attachment;
    expect(snapOut.systemPrompt).toMatch(/^\[scrubbed: /);
    expect(snapOut.tools).toMatch(/^\[scrubbed: /);
    expect(snapOut.reminderFold).toBe(true);

    const skills = {
      type: "attachment",
      attachment: { type: "skill_listing", content: long },
      rendered: [{ content: `<system-reminder>${long}</system-reminder>` }],
    };
    const skillsOut = JSON.parse(scrubJsonLine(JSON.stringify(skills)));
    expect(skillsOut.attachment.content).toMatch(/^\[scrubbed: /);
    expect(skillsOut.rendered[0].content).toMatch(/^\[scrubbed: /);
  });

  test("zeroes account and organisation identifiers at any depth", () => {
    const owner = { type: "session-owner", accountUuid: "363dfc51-aaaa", organizationUuid: "1c63dd1e-bbbb" };
    const out = JSON.parse(scrubJsonLine(JSON.stringify(owner)));
    expect(out.accountUuid).toBe("00000000-0000-0000-0000-000000000000");
    expect(out.organizationUuid).toBe("00000000-0000-0000-0000-000000000000");

    const meta = { type: "session_meta", payload: { creator_account_id: "5cf6", creator_user_id: "user-BKi3" } };
    const metaOut = JSON.parse(scrubJsonLine(JSON.stringify(meta))).payload;
    expect(metaOut.creator_account_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(metaOut.creator_user_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  test("returns a line no rule touches unchanged, byte for byte", () => {
    const line = '{"type":"user","message":{"content":"hi"},"n":1.0}';
    expect(scrubJsonLine(line)).toBe(line);
  });
});

describe("checkText", () => {
  test("names each planted pattern with its line", () => {
    const text = ["clean", home, user, host, email, antKey, linKey, ghoKey, ghpKey, skKey].join("\n");
    const hits = checkText(text, ctx).map((h) => h.line);
    expect(hits).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("names a line that quotes the user's instruction files, raw or JSON-escaped", () => {
    const rule = 'Write prose a reader can act on: name the "mechanism" exactly.';
    const withRules = { ...ctx, instructionLines: [rule] };
    const text = ["ok", `x ${rule} y`, JSON.stringify({ t: `a\n${rule}\nb` })].join("\n");
    expect(checkText(text, withRules)).toEqual([
      { line: 2, patterns: ["instruction text"] },
      { line: 3, patterns: ["instruction text"] },
    ]);
  });
});

describe("scrub-fixture CLI", () => {
  test("--check fails with file:line for each residue", () => {
    const dir = fixtureDir({ "a/log.jsonl": `{"ok":1}\n{"cwd":"${home}"}\n`, "b.txt": `x\ny\n${antKey}\n` });
    const r = run(["--check", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("a/log.jsonl:2:");
    expect(r.out).toContain("b.txt:3:");
  });

  test("--check passes on a clean folder", () => {
    const dir = fixtureDir({ "log.jsonl": '{"cwd":"/home/user","text":"hello"}\n' });
    const r = run(["--check", dir]);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  test("rewrites in place, then passes its own check", () => {
    const dir = fixtureDir({
      "s/log.jsonl": `${JSON.stringify({ cwd: home, host, mail: email, key: antKey })}\n`,
    });
    const r = run([dir]);
    expect(r.code).toBe(0);
    const out = JSON.parse(readFileSync(join(dir, "s/log.jsonl"), "utf8"));
    expect(out).toEqual({ cwd: "/home/user", host: "host", mail: "user@example.com", key: "REDACTED" });
  });
});
