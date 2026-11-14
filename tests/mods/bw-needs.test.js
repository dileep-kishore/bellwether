// Tests for `mods/bw-needs/`: grouped triage (`Needs you`, `Ready to land`, `Working`, `Idle`),
// inline `1-9` shortcuts behind the 3 s focus guard, multi-agent `Open chat` pinning,
// `"Waiting in terminal"` shell fallback, and PR skill buttons (`APPROVED` + `null` reviewDecision).
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { HELPER_SCRIPTS } from "../../shared/helper.js";
import { findLayout } from "../../shared/ui.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { mount } from "../harness/mount.js";

const T0 = 1794032000000;
const NO_MODS = { shift: false, control: false, alt: false, platform: false, function: false };
const SESSION_B = "01a1b4a2-6731-7140-87be-4960d8a7aefe";
const PATH_B = `/Users/remote/.codex/sessions/rollout-${SESSION_B}.jsonl`;

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: 8, version: "0.8.0" }]);

/** @param {Record<string, (args: string[], on: string | null) => unknown>} handlers */
function bwExec(handlers) {
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    if (cmd === "git") {
      if (args.includes("remote.origin.url")) {
        return { code: 0, stdout: "git@github.com:acme/bellwether.git\n", stderr: "" };
      }
      if (args.includes("HEAD")) {
        return { code: 0, stdout: "deadbeef1234567890abcdef1234567890abcdef\n", stderr: "" };
      }
    }
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw") {
      return { code: 127, stdout: "", stderr: `unexpected command: ${cmd} ${args.join(" ")}` };
    }
    const sub = args[3];
    const h = handlers[sub] ?? (sub === "version" ? () => VERSION : null);
    if (!h) return out([{ type: "error", code: "stub", message: `no ${sub}` }]);
    return h(args.slice(4), opts?.on ?? null);
  };
}

/** @param {any} m @param {string} sub */
const bwCalls = (m, sub) =>
  m.log.exec.filter((/** @type {any} */ [c, a]) => c === "sh" && HELPER_SCRIPTS.includes(a[1]) && a[3] === sub);

function makeNeedsLive(/** @type {Record<string, any>} */ overrides = {}) {
  /** @type {Record<string, any>} */
  const d = {
    spaces: [
      {
        id: "sp-remote",
        name: "api-server",
        folder: "/Users/remote/api-server",
        branch: "feat/auth",
        machine: "macmini",
        active: false,
        tabs: [{ id: "tab-remote", name: "Agents", active: true }],
      },
      {
        id: "sp-ready",
        name: "web-ui",
        folder: "/Users/local/web-ui",
        branch: "feat/ready",
        machine: null,
        active: true,
        tabs: [{ id: "tab-ready", name: "Claude", active: true }],
      },
      {
        id: "sp-shell",
        name: "ops-shell",
        folder: "/Users/local/ops-shell",
        branch: "main",
        machine: null,
        active: false,
        tabs: [{ id: "tab-shell", name: "zsh", active: true }],
      },
    ],
    panes: [
      {
        pane: "p-a",
        tab: "tab-remote",
        terminal: "macmini/t1",
        cwd: "/Users/remote/api-server",
        branch: "feat/auth",
        status: "working",
        program: { key: "claude", name: "Claude" },
      },
      {
        pane: "p-b",
        tab: "tab-remote",
        terminal: "macmini/t5",
        cwd: "/Users/remote/api-server",
        branch: "feat/auth",
        status: "blocked",
        program: { key: "codex", name: "Codex" },
      },
      {
        pane: "p-ready",
        tab: "tab-ready",
        terminal: "t2",
        cwd: "/Users/local/web-ui",
        branch: "feat/ready",
        status: "done",
        program: { key: "claude", name: "Claude" },
      },
      {
        pane: "p-shell",
        tab: "tab-shell",
        terminal: "t9",
        cwd: "/Users/local/ops-shell",
        branch: "main",
        status: "blocked",
        program: { key: "zsh", name: "zsh" },
      },
    ],
    agents: [
      { address: "macmini/t1", space: "sp-remote", status: "working" },
      { address: "macmini/t5", space: "sp-remote", status: "blocked" },
      { address: "t2", space: "sp-ready", status: "done" },
    ],
    shared: {
      "bw.screen": "needs",
      "bw.pr-summary": {
        "sp-ready": {
          number: 42,
          title: "Polish cockpit layout",
          url: "https://github.com/acme/bellwether/pull/42",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefOid: "deadbeef1234567890abcdef1234567890abcdef",
          headOid: "deadbeef1234567890abcdef1234567890abcdef",
          reviewDecision: null,
          mergeStateStatus: "CLEAN",
          unresolvedThreads: 0,
          passing: 5,
          failing: 0,
          pending: 0,
          mergeReady: true,
          attention: false,
        },
      },
    },
    ...overrides,
  };
  const layoutTree = structuredClone(
    JSON.parse(require("node:fs").readFileSync(`${process.cwd()}/layouts/bellwether.json`, "utf8")),
  );
  findLayout(layoutTree, "screen").active = overrides.screenActive ?? "needs";
  d.layout = layoutTree;
  return d;
}

afterEach(() => {
  setSystemTime();
});

describe("bw-needs inline triage", () => {
  test("answers a remote question card with key 1 after the 3 s guard and pins bw.chat-agent on Open chat", async () => {
    setSystemTime(new Date(T0));
    const questionReq = {
      type: "request",
      id: "req-q1",
      kind: "question",
      state: "pending",
      answerable: true,
      reason: null,
      who: null,
      tool: "AskUserQuestion",
      command: "",
      detail: "",
      actions: [],
      question: {
        questions: [
          {
            id: "q1",
            header: "Scope",
            text: "Which migration target?",
            multi: false,
            options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
          },
        ],
      },
      at_ms: T0 - 1000,
      resolved_ms: null,
    };

    const d = makeNeedsLive({
      exec: bwExec({
        cards: (args) => {
          const term = args[args.indexOf("--terminal") + 1];
          if (term === "t5") {
            return out([
              {
                type: "cards",
                terminal: "t5",
                agent: "codex",
                session: SESSION_B,
                path: PATH_B,
                status: "blocked",
                hooks: "ok",
                screen: "read",
              },
              questionReq,
            ]);
          }
          return out([
            {
              type: "cards",
              terminal: term,
              agent: "claude",
              session: "sess-t2",
              path: "/Users/local/.claude/sess-t2.jsonl",
              status: "done",
              hooks: "ok",
              screen: "unread",
            },
          ]);
        },
        counts: () => out([]),
        pr: (args) =>
          args.includes("feat/ready")
            ? out([
                {
                  type: "pr",
                  pr: {
                    number: 42,
                    title: "Polish cockpit layout",
                    url: "https://github.com/acme/bellwether/pull/42",
                    state: "OPEN",
                    isDraft: false,
                    baseRefName: "main",
                    headRefOid: "deadbeef1234567890abcdef1234567890abcdef",
                    reviewDecision: null,
                    mergeStateStatus: "CLEAN",
                    unresolvedThreads: 0,
                    passing: 5,
                    failing: 0,
                    pending: 0,
                  },
                  cached: true,
                  age_s: 1,
                  stale: false,
                },
              ])
            : out([{ type: "pr", pr: null, cached: true, age_s: 1, stale: false }]),
        answer: () => out([{ type: "answer", result: "answered", state: "answered", message: "" }]),
      }),
    });

    const m = await mount("bw-needs", { live: d });
    await m.cx.flush();
    m.render();

    // Zero loop("opacity") elements in bw-needs.
    expect(findAll(m.el, (e) => Boolean(e.attrs.loop))).toHaveLength(0);

    // Groups include Needs you, Ready to land, and Working.
    expect(byId(m.el, "needs-group-needs")).not.toBeNull();
    expect(byId(m.el, "needs-group-ready")).not.toBeNull();
    expect(byId(m.el, "needs-group-working")).not.toBeNull();

    // First selected row is remote Agent B (`macmini/t5`) with its question card.
    expect(textOf(byId(m.el, "card-req-q1"))).toContain("Which migration target?");
    expect(byId(m.el, "answer-req-q1-submit").attrs.disabled).toBe(true);

    // Before 3 s focus guard expires, pressing `1` selects option 1 locally without calling `bw answer`.
    await fire(byId(m.el, "qkeys-req-q1"), "on_key_down", { key: "1", keystroke: "1", modifiers: NO_MODS }, m.cx);
    await m.cx.flush();
    expect(bwCalls(m, "answer")).toHaveLength(0);

    // Advance past 3 s guard and wake the sleep so the guard unlocks automatically.
    setSystemTime(new Date(T0 + 3100));
    m.cx.sleeps.at(-1)?.wake();
    await m.cx.flush();
    m.render();

    // Pressing `1` now invokes `bw answer` on `macmini` with option 1 (`[{"picks":[0]}]`).
    await fire(byId(m.el, "qkeys-req-q1"), "on_key_down", { key: "1", keystroke: "1", modifiers: NO_MODS }, m.cx);
    await m.cx.flush();
    m.render();

    const ans = bwCalls(m, "answer");
    expect(ans).toHaveLength(1);
    expect(ans[0][2]?.on).toBe("macmini");
    expect(ans[0][1].slice(3)).toEqual([
      "answer",
      "--terminal",
      "t5",
      "--request",
      "req-q1",
      "--expect-kind",
      "codex",
      "--expect-session",
      SESSION_B,
      "--expect-path",
      PATH_B,
      "--answers",
      JSON.stringify([{ picks: [0] }]),
    ]);

    // Clicking Open chat on Agent B in a two-agent tab pins `bw.chat-agent` to `macmini/t5` and focuses B.
    m.log.run.length = 0;
    await m.click("needs-open-chat");
    expect(d.shared["bw.chat-agent"] ?? m.log.shared.findLast(([k]) => k === "bw.chat-agent")?.[1]).toEqual({
      "tab-remote": "macmini/t5",
    });
    expect(m.log.run).toContainEqual(["agent.focus", { terminal: "macmini/t5" }]);
    expect(m.log.run).toContainEqual(["space.select", { id: "sp-remote" }]);
    expect(m.log.run).toContainEqual(["layout.select", { stack: "screen", child: "chat" }]);
    expect(m.log.run).toContainEqual(["bw-chat.focus"]);
  });

  test("blocked shell terminal renders Waiting in terminal with zero answer buttons and opens panes", async () => {
    setSystemTime(new Date(T0 + 5000));
    const d = makeNeedsLive({
      exec: bwExec({
        cards: () => out([]),
        counts: () => out([]),
        pr: () => out([{ type: "pr", pr: null, cached: true, age_s: 1, stale: false }]),
      }),
    });
    const m = await mount("bw-needs", { live: d });
    await m.cx.flush();
    m.render();

    await m.click("needs-row-term:t9");
    const waiting = byId(m.el, "needs-waiting-terminal");
    expect(waiting).not.toBeNull();
    expect(textOf(waiting)).toContain("Waiting in terminal");
    expect(findAll(m.el, (e) => String(e.attrs.id ?? "").startsWith("answer-"))).toHaveLength(0);

    m.log.run.length = 0;
    await m.click("needs-waiting-open-terminal");
    expect(m.log.run).toContainEqual(["space.select", { id: "sp-shell" }]);
    expect(m.log.run).toContainEqual(["layout.select", { stack: "screen", child: "panes" }]);
    expect(m.log.run).toContainEqual(["pane.focus", { terminal: "t9" }]);
  });

  test("PR cards show Merge PR for null-reviewDecision and APPROVED PRs, route via bw send/queue, and never run gh pr merge", async () => {
    setSystemTime(new Date(T0 + 5000));
    const d = makeNeedsLive({
      exec: bwExec({
        cards: (args) => {
          const term = args[args.indexOf("--terminal") + 1];
          return out([
            {
              type: "cards",
              terminal: term,
              agent: "claude",
              session: `sess-${term}`,
              path: `/Users/local/.claude/sess-${term}.jsonl`,
              status: "done",
              hooks: "ok",
              screen: "unread",
            },
          ]);
        },
        counts: () => out([]),
        pr: () =>
          out([
            {
              type: "pr",
              pr: {
                number: 42,
                title: "Polish cockpit layout",
                url: "https://github.com/acme/bellwether/pull/42",
                state: "OPEN",
                isDraft: false,
                baseRefName: "main",
                headRefOid: "deadbeef1234567890abcdef1234567890abcdef",
                reviewDecision: null,
                mergeStateStatus: "CLEAN",
                unresolvedThreads: 0,
                passing: 5,
                failing: 0,
                pending: 0,
              },
              cached: true,
              age_s: 1,
              stale: false,
            },
          ]),
        send: () => out([{ type: "send", result: "sent" }]),
        queue: () =>
          out([{ type: "queue", held: false, hold_reason: null, items: [{ id: "q1", text: "/babysit-pr 42" }] }]),
        browser: (args) => {
          if (args[0] === "new") return out([{ type: "tab-action", ok: true, id: "b1" }]);
          return out([{ type: "chrome", state: "running" }]);
        },
      }),
    });

    const m = await mount("bw-needs", { live: d });
    await m.cx.flush();
    m.render();

    // Select the Ready to land row (`reviewDecision: null`).
    await m.click("needs-row-term:t2");
    expect(byId(m.el, "needs-pr-merge")).not.toBeNull();
    expect(byId(m.el, "needs-pr-babysit")).not.toBeNull();

    // Clicking Merge PR sends `/merge-pr 42` via `bw send` and never invokes `gh`.
    await m.click("needs-pr-merge");
    const sends = bwCalls(m, "send");
    expect(sends).toHaveLength(1);
    expect(sends[0][1].slice(3)).toEqual([
      "send",
      "--terminal",
      "t2",
      "--expect-kind",
      "claude",
      "--expect-session",
      "sess-t2",
      "--expect-path",
      "/Users/local/.claude/sess-t2.jsonl",
      "--text",
      "/merge-pr 42",
    ]);
    expect(m.log.exec.some(([cmd]) => cmd === "gh")).toBe(false);

    // Clicking Open PR reveals `right`, selects `browser`, and calls `bw browser new --url`.
    await m.click("needs-pr-open");
    expect(m.log.run).toContainEqual(["layout.show", { id: "right" }]);
    expect(m.log.run).toContainEqual(["layout.select", { stack: "right-body", child: "browser" }]);
    expect(bwCalls(m, "browser")[0][1].slice(3)).toEqual([
      "browser",
      "new",
      "--url",
      "https://github.com/acme/bellwether/pull/42",
    ]);
  });

  test("answers approval cards via y/a/n and 1-3 keys on #bw-needs-list behind the 3 s guard", async () => {
    setSystemTime(new Date(T0));
    const approvalReq = {
      type: "request",
      id: "req-ap1",
      kind: "approval",
      state: "pending",
      answerable: true,
      reason: null,
      who: null,
      tool: "Bash",
      command: "cargo test --workspace",
      detail: "",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
      question: null,
      at_ms: T0 - 500,
      resolved_ms: null,
    };

    const d = makeNeedsLive({
      exec: bwExec({
        cards: (args) => {
          const term = args[args.indexOf("--terminal") + 1];
          if (term === "t5") {
            return out([
              {
                type: "cards",
                terminal: "t5",
                agent: "codex",
                session: SESSION_B,
                path: PATH_B,
                status: "blocked",
                hooks: "ok",
                screen: "read",
              },
              approvalReq,
            ]);
          }
          return out([]);
        },
        counts: () => out([]),
        pr: () => out([{ type: "pr", pr: null, cached: true, age_s: 1, stale: false }]),
        answer: () => out([{ type: "answer", result: "answered", state: "answered", message: "" }]),
      }),
    });

    const m = await mount("bw-needs", { live: d });
    await m.cx.flush();
    m.render();

    // During the 3 s focus guard, y / a / n / 1-3 on #bw-needs-list do not fire bw answer.
    const list = byId(m.el, "bw-needs-list");
    await fire(list, "on_key_down", { key: "y", keystroke: "y", modifiers: NO_MODS }, m.cx);
    await fire(list, "on_key_down", { key: "1", keystroke: "1", modifiers: NO_MODS }, m.cx);
    await m.cx.flush();
    expect(bwCalls(m, "answer")).toHaveLength(0);

    // Advance past 3 s guard.
    setSystemTime(new Date(T0 + 3200));
    m.cx.sleeps.at(-1)?.wake();
    await m.cx.flush();
    m.render();

    // Pressing `a` on #bw-needs-list answers the approval card with `--action always`.
    await fire(byId(m.el, "bw-needs-list"), "on_key_down", { key: "a", keystroke: "a", modifiers: NO_MODS }, m.cx);
    await m.cx.flush();
    const ans = bwCalls(m, "answer");
    expect(ans).toHaveLength(1);
    expect(ans[0][2]?.on).toBe("macmini");
    expect(ans[0][1].slice(3)).toEqual([
      "answer",
      "--terminal",
      "t5",
      "--request",
      "req-ap1",
      "--expect-kind",
      "codex",
      "--expect-session",
      SESSION_B,
      "--expect-path",
      PATH_B,
      "--action",
      "always",
    ]);
  });

  test("hides PR card and Merge PR on non-owner rows and busy owner rows in a ready-PR space", async () => {
    setSystemTime(new Date(T0 + 5000));
    const base = makeNeedsLive();
    base.panes.push({
      pane: "p-ready-sibling",
      tab: "tab-ready",
      terminal: "t3",
      cwd: "/Users/local/web-ui",
      branch: "feat/ready",
      status: "done",
      program: { key: "codex", name: "Codex" },
    });
    base.agents.push({ address: "t3", space: "sp-ready", status: "done" });
    base.exec = bwExec({
      cards: (args) => {
        const term = args[args.indexOf("--terminal") + 1];
        return out([
          {
            type: "cards",
            terminal: term,
            agent: term === "t3" ? "codex" : "claude",
            session: `sess-${term}`,
            path: `/Users/local/.claude/sess-${term}.jsonl`,
            status: "done",
            hooks: "ok",
            screen: "unread",
          },
        ]);
      },
      counts: () => out([]),
      pr: () =>
        out([
          {
            type: "pr",
            pr: {
              number: 42,
              title: "Polish cockpit layout",
              url: "https://github.com/acme/bellwether/pull/42",
              state: "OPEN",
              isDraft: false,
              baseRefName: "main",
              headRefOid: "deadbeef1234567890abcdef1234567890abcdef",
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              unresolvedThreads: 0,
              passing: 5,
              failing: 0,
              pending: 0,
            },
            cached: true,
            age_s: 1,
            stale: false,
          },
        ]),
    });

    const m = await mount("bw-needs", { live: base });
    await m.cx.flush();
    m.render();

    // Owner ready row (`t2`) shows PR card and Merge PR.
    await m.click("needs-row-term:t2");
    expect(byId(m.el, "needs-pr-card")).not.toBeNull();
    expect(byId(m.el, "needs-pr-merge")).not.toBeNull();

    // Non-owner sibling row (`t3`) in the same space hides PR card and Merge PR.
    await m.click("needs-row-term:t3");
    expect(byId(m.el, "needs-pr-card")).toBeNull();
    expect(byId(m.el, "needs-pr-merge")).toBeNull();

    // When owner (`t2`) becomes working, it leaves Ready to land and also hides PR card and Merge PR.
    base.panes.find((/** @type {any} */ p) => p.terminal === "t2").status = "working";
    base.agents.find((/** @type {any} */ a) => a.address === "t2").status = "working";
    m.render();
    await m.click("needs-row-term:t2");
    expect(byId(m.el, "needs-pr-card")).toBeNull();
    expect(byId(m.el, "needs-pr-merge")).toBeNull();
  });

  test("stays quiet on bw cards and bw counts while screen is chat, including after leaving needs without render", async () => {
    setSystemTime(new Date(T0));
    const d = makeNeedsLive({
      screenActive: "chat",
      shared: { "bw.screen": "chat" },
      exec: bwExec({
        cards: () => out([]),
        counts: () => out([]),
        pr: () => out([{ type: "pr", pr: null, cached: true, age_s: 1, stale: false }]),
      }),
    });
    const m = await mount("bw-needs", { live: d });
    await m.cx.flush();
    expect(bwCalls(m, "cards")).toHaveLength(0);
    expect(bwCalls(m, "counts")).toHaveLength(0);

    // Show needs, run one visible poll pass, then flip bw.screen back to "chat" WITHOUT calling m.render().
    d.shared["bw.screen"] = "needs";
    findLayout(d.layout, "screen").active = "needs";
    m.render();
    m.cx.sleeps.at(-1)?.wake();
    await m.cx.flush();
    const cardsOnNeeds = bwCalls(m, "cards").length;
    const countsOnNeeds = bwCalls(m, "counts").length;
    expect(cardsOnNeeds).toBeGreaterThan(0);

    d.shared["bw.screen"] = "chat";
    findLayout(d.layout, "screen").active = "chat";
    // Intentionally omit m.render() to simulate a hidden stack child whose render() does not run.
    for (let i = 0; i < 3; i++) {
      setSystemTime(new Date(T0 + (i + 1) * 5000));
      for (const s of m.cx.sleeps.splice(0)) s.wake();
      await m.cx.flush();
    }
    expect(bwCalls(m, "cards")).toHaveLength(cardsOnNeeds);
    expect(bwCalls(m, "counts")).toHaveLength(countsOnNeeds);
  });
});
