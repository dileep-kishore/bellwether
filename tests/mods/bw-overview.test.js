// Tests for `mods/bw-overview/`: cross-space fleet cards, neutral monograms, PR badges,
// responsive column counts, and pinned one-click jumps to `chat` and `panes`.
import { describe, expect, test } from "bun:test";
import { HELPER_SCRIPTS } from "../../shared/helper.js";
import { findLayout } from "../../shared/ui.js";
import { byId, findAll, fire, textOf } from "../harness/kit-stub.js";
import { mount } from "../harness/mount.js";

/** @param {object[]} lines */
const out = (lines) => ({ code: 0, stdout: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: 8, version: "0.8.0" }]);

function makeOverviewLive() {
  const layoutTree = structuredClone(
    JSON.parse(require("node:fs").readFileSync(`${process.cwd()}/layouts/bellwether.json`, "utf8")),
  );
  findLayout(layoutTree, "screen").active = "overview";
  return {
    layout: layoutTree,
    spaces: [
      {
        id: "sp-1",
        name: "bellwether-ui",
        folder: "/Users/local/bellwether",
        branch: "feat/cockpit",
        machine: null,
        active: true,
        tabs: [{ id: "tab-1", name: "Split", active: true }],
      },
      {
        id: "sp-2",
        name: "worker-fleet",
        folder: "/Users/remote/worker-fleet",
        branch: "fix/ci",
        machine: "macmini",
        active: false,
        tabs: [{ id: "tab-2", name: "Shell", active: true }],
      },
    ],
    panes: [
      {
        pane: "p1",
        tab: "tab-1",
        terminal: "t1",
        cwd: "/Users/local/bellwether",
        branch: "feat/cockpit",
        status: "idle",
        program: { key: "claude", name: "Claude" },
      },
      {
        pane: "p2",
        tab: "tab-1",
        terminal: "t2",
        cwd: "/Users/local/bellwether",
        branch: "feat/cockpit",
        status: "working",
        program: { key: "codex", name: "Codex" },
      },
      {
        pane: "p3",
        tab: "tab-2",
        terminal: "macmini/t9",
        cwd: "/Users/remote/worker-fleet",
        branch: "fix/ci",
        status: "idle",
        program: { key: "zsh", name: "zsh" },
      },
    ],
    agents: [
      { address: "t1", space: "sp-1", status: "idle" },
      { address: "t2", space: "sp-1", status: "working" },
    ],
    shared: {
      "bw.screen": "overview",
      "bw.pr-summary": {
        "sp-1": {
          number: 88,
          title: "Add cockpit overview",
          url: "https://github.com/acme/bellwether/pull/88",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefOid: "abc1234",
          headOid: "abc1234",
          reviewDecision: "APPROVED",
          mergeStateStatus: "CLEAN",
          unresolvedThreads: 0,
          passing: 8,
          failing: 0,
          pending: 0,
          mergeReady: true,
          attention: false,
        },
        "sp-2": {
          number: 91,
          title: "Fix worker retry",
          url: "https://github.com/acme/worker/pull/91",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefOid: "def5678",
          headOid: "def5678",
          reviewDecision: null,
          mergeStateStatus: "UNSTABLE",
          unresolvedThreads: 0,
          passing: 2,
          failing: 1,
          pending: 0,
          mergeReady: false,
          attention: true,
        },
      },
    },
    exec: async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      if (cmd === "git") {
        if (args.includes("remote.origin.url")) {
          return { code: 0, stdout: "git@github.com:acme/bellwether.git\n", stderr: "" };
        }
        if (args.includes("HEAD")) {
          return {
            code: 0,
            stdout: args.includes("/Users/local/bellwether") ? "abc1234\n" : "def5678\n",
            stderr: "",
          };
        }
      }
      if (cmd === "sh" && HELPER_SCRIPTS.includes(args[1])) {
        if (args[3] === "version") return VERSION;
        if (args[3] === "pr") {
          const branch = args[args.indexOf("--branch") + 1];
          if (branch === "feat/cockpit") {
            return out([
              {
                type: "pr",
                pr: {
                  number: 88,
                  title: "Add cockpit overview",
                  url: "https://github.com/acme/bellwether/pull/88",
                  state: "OPEN",
                  isDraft: false,
                  baseRefName: "main",
                  headRefOid: "abc1234",
                  reviewDecision: "APPROVED",
                  mergeStateStatus: "CLEAN",
                  unresolvedThreads: 0,
                  passing: 8,
                  failing: 0,
                  pending: 0,
                },
                cached: true,
                age_s: 1,
                stale: false,
              },
            ]);
          }
          return out([
            {
              type: "pr",
              pr: {
                number: 91,
                title: "Fix worker retry",
                url: "https://github.com/acme/worker/pull/91",
                state: "OPEN",
                isDraft: false,
                baseRefName: "main",
                headRefOid: "def5678",
                reviewDecision: null,
                mergeStateStatus: "UNSTABLE",
                unresolvedThreads: 0,
                passing: 2,
                failing: 1,
                pending: 0,
              },
              cached: true,
              age_s: 1,
              stale: false,
            },
          ]);
        }
      }
      return out([{ type: "pr", pr: null, cached: true, age_s: 1, stale: false }]);
    },
  };
}

describe("bw-overview fleet grid", () => {
  test("renders neutral monograms, PR badges, responsive columns, and pinned jumps to chat and panes", async () => {
    const d = makeOverviewLive();
    const m = await mount("bw-overview", { live: d });
    await m.cx.flush();
    m.render();

    // Zero loop("opacity") elements in bw-overview.
    expect(findAll(m.el, (e) => Boolean(e.attrs.loop))).toHaveLength(0);

    expect(textOf(byId(m.el, "overview-card-sp-1"))).toContain("bellwether-ui");
    expect(textOf(byId(m.el, "overview-pr-sp-1"))).toContain("#88 · Ready");
    expect(textOf(byId(m.el, "overview-card-sp-2"))).toContain("macmini");
    expect(textOf(byId(m.el, "overview-pr-sp-2"))).toContain("#91 · CI failing");

    // Responsive column layout adapts across narrow and wide widths.
    await fire(byId(m.el, "bw-overview"), "on_size_change", { width: 520, height: 800 }, m.cx);
    m.render();
    expect(byId(m.el, "overview-row-1")).not.toBeNull();

    await fire(byId(m.el, "bw-overview"), "on_size_change", { width: 1180, height: 800 }, m.cx);
    m.render();
    expect(byId(m.el, "overview-row-1")).toBeNull();

    // Clicking Codex (`t2`) in a two-agent tab pins `bw.chat-agent` and jumps to `chat`.
    m.log.run.length = 0;
    await m.click("overview-line-t2");
    expect(m.log.shared.findLast(([k]) => k === "bw.chat-agent")?.[1]).toEqual({ "tab-1": "t2" });
    expect(m.log.run).toContainEqual(["agent.focus", { terminal: "t2" }]);
    expect(m.log.run).toContainEqual(["layout.select", { stack: "screen", child: "chat" }]);
    expect(m.log.run).toContainEqual(["bw-chat.focus"]);

    // Clicking a shell line on remote `sp-2` selects space `sp-2`, flips to `panes`, and focuses `macmini/t9`.
    m.log.run.length = 0;
    await m.click("overview-line-macmini/t9");
    expect(m.log.run).toContainEqual(["space.select", { id: "sp-2" }]);
    expect(m.log.run).toContainEqual(["layout.select", { stack: "screen", child: "panes" }]);
    expect(m.log.run).toContainEqual(["pane.focus", { terminal: "macmini/t9" }]);
  });
});
