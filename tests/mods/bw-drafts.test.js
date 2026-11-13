import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, findAll, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import {
  compactEvidencePath,
  domSlug,
  isShown,
  localFileUrlFor,
  parseDecisionsTsv,
  parseDraftEntries,
  parsePlanChecklist,
  stageSlugFor,
} from "../../mods/bw-drafts/model.js";

/** @param {object[]} ls */
const out = (ls) => ({ code: 0, stdout: `${ls.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);
const TOP = "/private/tmp/bw-drafts/repo";

afterEach(() => setSystemTime());

/** @param {string} child @param {boolean} [rightHidden] */
function setRightState(child, rightHidden = false, node = fake.layout) {
  if (!node || typeof node !== "object") return;
  if (node.id === "right") node.hidden = rightHidden;
  if (node.id === "right-body") node.active = child;
  for (const c of node.children ?? []) setRightState(child, rightHidden, c);
}

/** @param {string | null} [machine] */
function liveSpace(machine = null, folder = TOP) {
  return {
    machines: [{ name: null, layout: "ready" }, ...(machine ? [{ name: machine, layout: "ready" }] : [])],
    spaces: [
      {
        id: "s1",
        index: 1,
        name: "repo",
        named: false,
        folder,
        machine,
        branch: "feat/cockpit",
        active: true,
        status: null,
        tabs: [{ id: "tb1", index: 1, name: "1", named: false, active: true, status: null, panes: 1 }],
      },
    ],
    panes: [
      {
        pane: "p1",
        terminal: machine ? `${machine}/t1` : "t1",
        tab: "tb1",
        title: "claude",
        cwd: folder,
        branch: "feat/cockpit",
        focused: true,
      },
    ],
  };
}

/**
 * Wakes pending sleeps while advancing fake system time by `ms`.
 * @param {any} m
 * @param {number} ms
 * @param {{ draw?: boolean }} [o]
 */
async function runFor(m, ms, { draw = true } = {}) {
  const start = Date.now();
  const woken = new Set();
  for (let i = 0; i < 200; i++) {
    const pending = m.cx.sleeps.filter((/** @type {any} */ s) => !woken.has(s));
    const s = pending.at(-1);
    if (!s || Date.now() + s.ms - start > ms) break;
    for (const p of pending) woken.add(p);
    setSystemTime(new Date(Date.now() + s.ms));
    s.wake();
    await m.cx.flush();
    if (draw) m.render();
    await m.cx.flush();
  }
  setSystemTime(new Date(start + ms));
}

describe("bw-drafts model", () => {
  test("isShown requires right visible and right-body active on drafts", () => {
    const tree = {
      id: "root",
      children: [
        {
          id: "right",
          hidden: false,
          children: [{ id: "right-body", active: "drafts", children: [] }],
        },
      ],
    };
    expect(isShown(tree)).toBe(true);
    tree.children[0].hidden = true;
    expect(isShown(tree)).toBe(false);
    tree.children[0].hidden = false;
    tree.children[0].children[0].active = "changes";
    expect(isShown(tree)).toBe(false);
  });

  test("parseDecisionsTsv parses 6-column header, compacts evidence paths, and strips formula escapes", () => {
    const tsv = [
      "ts\tphase\tdecision\twhy\tevidence\tresult",
      "2026-11-13T21:00:00Z\treview\tAdopt 4-tab right strip\tKeep Drafts beside Changes and Browser\t/Users/dkishore/.t3/worktrees/bellwether/mods/bw-right/choice.js:10\tpass",
      "2026-11-13T21:05:00Z\tverify\t'--offline full suite\tConfirm zero network flakiness\tscripts/test.sh\tok",
    ].join("\n");
    const parsed = parseDecisionsTsv(tsv);
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      ts: "2026-11-13T21:00:00Z",
      phase: "review",
      decision: "Adopt 4-tab right strip",
      why: "Keep Drafts beside Changes and Browser",
      compactEvidence: "…/bw-right/choice.js:10",
      result: "pass",
      phaseTone: "accent",
      resultTone: "done",
    });
    expect(parsed.rows[1].decision).toBe("--offline full suite");
    expect(compactEvidencePath("file:///a/b/c/d/file.rs:42")).toBe("…/d/file.rs:42");
  });

  test("parsePlanChecklist counts checked and unchecked items while ignoring fenced code blocks", () => {
    const md = [
      "# Tasks",
      "- [x] **Step 1:** Build Rust helper",
      "- [ ] Step 2: Wire UI panel",
      "  - [x] Nested check",
      "```markdown",
      "- [ ] Ignored example checkbox inside code block",
      "```",
    ].join("\n");
    const check = parsePlanChecklist(md);
    expect(check.done).toBe(2);
    expect(check.total).toBe(3);
    expect(check.percent).toBe(67);
    expect(check.items.map((i) => [i.checked, i.indent, i.text])).toEqual([
      [true, 0, "Step 1: Build Rust helper"],
      [false, 0, "Step 2: Wire UI panel"],
      [true, 1, "Nested check"],
    ]);
  });

  test("stageSlugFor and localFileUrlFor normalize paths safely", () => {
    expect(stageSlugFor({ id: "docs/drafts/sub/My Page!.html" })).toBe("My-Page-.html");
    expect(stageSlugFor({ id: "docs/drafts/.hidden.htm" })).toBe("hidden.html");
    expect(
      localFileUrlFor("/tmp/my repo", {
        kind: "html",
        id: "docs/drafts/sub/page.html",
        label: "docs/drafts/sub/page.html",
        mtimeMs: 1,
        size: 10,
        fileUrl: null,
      }),
    ).toBe("file:///tmp/my%20repo/docs/drafts/sub/page.html");
    expect(
      parseDraftEntries([{ type: "draft", kind: "html", id: "docs/drafts/a.html", mtime_ms: 5, size: 12 }])[0],
    ).toMatchObject({
      kind: "html",
      id: "docs/drafts/a.html",
      mtimeMs: 5,
      size: 12,
    });
  });
});

describe("bw-drafts panel", () => {
  test("polls nothing while right is hidden or showing another tab, and stops when switched away", async () => {
    setSystemTime(new Date("2026-11-13T22:00:00Z"));
    let listCalls = 0;
    const exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw") {
        return { code: 127, stdout: "", stderr: "" };
      }
      const a = args.slice(3);
      if (a[0] === "version") return VERSION;
      if (a[0] === "drafts" && a[1] === "list") {
        listCalls++;
        return out([{ type: "draft", kind: "plan", id: "tasks.md", label: "tasks.md", mtime_ms: 10, size: 24 }]);
      }
      if (a[0] === "drafts" && a[1] === "read") {
        return out([
          { type: "draft-read", id: "tasks.md", kind: "plan", size: 24, truncated: false, text: "- [x] Done\n" },
        ]);
      }
      return out([]);
    };

    const m = await mount("bw-drafts", { live: { ...liveSpace("macmini"), exec } });
    // Default layout has `right.hidden === true` and `right-body.active === "changes"`.
    await runFor(m, 25_000);
    expect(listCalls).toBe(0);

    // Reveal `right` on `drafts`: reads immediately.
    setRightState("drafts", false);
    m.render();
    await m.cx.flush();
    m.render();
    await m.cx.flush();
    expect(listCalls).toBe(1);

    // Hide `right` without re-rendering: background refresher parks with zero extra list calls.
    const seenWhenShown = listCalls;
    setRightState("drafts", true);
    await runFor(m, 25_000, { draw: false });
    expect(listCalls).toBe(seenWhenShown);
  });

  test("opens local HTML via file:// and stages remote HTML on on: null before calling bw browser new", async () => {
    const calls = /** @type {{ on: string | null, argv: string[] }[]} */ ([]);
    let chromeRunning = false;
    const exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw") {
        return { code: 127, stdout: "", stderr: "" };
      }
      const a = args.slice(3);
      calls.push({ on: opts?.on ?? null, argv: a });
      if (a[0] === "version") return VERSION;
      if (a[0] === "drafts" && a[1] === "list") {
        return out([
          {
            type: "draft",
            kind: "html",
            id: "docs/drafts/sub/page.html",
            label: "docs/drafts/sub/page.html",
            mtime_ms: 100,
            size: 512,
            file_url: opts?.on ? undefined : `file://${TOP}/docs/drafts/sub/page.html`,
          },
        ]);
      }
      if (a[0] === "drafts" && a[1] === "stage") {
        return out([
          {
            type: "draft-staged",
            url: "file:///Users/test/.cache/bellwether/drafts-stage/abc/page.html",
            path: "/Users/test/.cache/bellwether/drafts-stage/abc/page.html",
            bytes: 512,
          },
        ]);
      }
      if (a[0] === "browser" && a[1] === "new") {
        if (!chromeRunning) {
          return out([
            { type: "tab-action", action: "new", ok: false, message: "Bellwether Chrome is not running (stopped)" },
          ]);
        }
        return out([{ type: "tab-action", action: "new", ok: true, id: "tab-1" }]);
      }
      if (a[0] === "browser" && a[1] === "up") {
        chromeRunning = true;
        return out([{ type: "chrome", state: "running" }]);
      }
      return out([]);
    };

    // 1. Local space (`machine === null`): opens local `file://` directly, starting Chrome if stopped.
    const localMod = await mount("bw-drafts", { live: { ...liveSpace(null), exec } });
    setRightState("drafts", false);
    for (let i = 0; i < 4; i++) {
      await localMod.cx.flush();
      localMod.render();
    }
    const openBtnId = `draft-open-${domSlug("docs/drafts/sub/page.html")}`;
    await localMod.click(openBtnId);
    for (let i = 0; i < 4; i++) await localMod.cx.flush();
    expect(calls.some((c) => c.argv[0] === "drafts" && c.argv[1] === "stage")).toBe(false);
    expect(calls).toContainEqual({
      on: null,
      argv: ["browser", "new", "--url", `file://${TOP}/docs/drafts/sub/page.html`],
    });
    expect(localMod.log.run).toContainEqual(["layout.show", { id: "right" }]);
    expect(localMod.log.run).toContainEqual(["layout.select", { stack: "right-body", child: "browser" }]);
    expect(localMod.log.shared.at(-1)).toEqual(["bw.right.tab", { s1: "browser" }]);

    // 2. Remote space (`machine === "macmini"`): stages on `on: null` with `--machine macmini`, then opens staged URL.
    calls.length = 0;
    const remoteMod = await mount("bw-drafts", { live: { ...liveSpace("macmini"), exec } });
    setRightState("drafts", false);
    for (let i = 0; i < 4; i++) {
      await remoteMod.cx.flush();
      remoteMod.render();
    }
    await remoteMod.click(openBtnId);
    for (let i = 0; i < 4; i++) await remoteMod.cx.flush();
    expect(calls).toContainEqual({
      on: null,
      argv: [
        "drafts",
        "stage",
        "--name",
        "page.html",
        "--machine",
        "macmini",
        "--path",
        TOP,
        "--file",
        "docs/drafts/sub/page.html",
      ],
    });
    expect(calls).toContainEqual({
      on: null,
      argv: ["browser", "new", "--url", "file:///Users/test/.cache/bellwether/drafts-stage/abc/page.html"],
    });
  });

  test("Done Check 5(d): end-to-end bw drafts lists nested HTML, root tasks.md, 6-column decisions.tsv, and external mktemp ledger.md", async () => {
    const repoRoot = resolve(import.meta.dir, "../..");
    const bwBin = join(repoRoot, "target/debug/bw");
    if (!existsSync(bwBin)) {
      const build = spawnSync("cargo", ["build", "-p", "bw"], { cwd: repoRoot, encoding: "utf8" });
      expect(build.status).toBe(0);
    }

    const baseTmp = mkdtempSync(join(tmpdir(), "bw-drafts-e2e-"));
    const extTmpRoot = mkdtempSync(join(tmpdir(), "bw-ledger-scan-"));
    try {
      const wt = join(baseTmp, "worktree");
      const stateDir = join(baseTmp, "state");
      const cacheDir = join(baseTmp, "cache");
      mkdirSync(join(wt, "docs/drafts/sub"), { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });

      writeFileSync(join(wt, "docs/drafts/sub/page.html"), "<!doctype html><title>Sub Draft</title><h1>Cockpit</h1>\n");
      writeFileSync(join(wt, "tasks.md"), "# Tasks\n- [x] Ship bw-drafts\n- [ ] Run Tier 3 council\n");

      const decisionsPath = join(wt, "decisions.tsv");
      const logScript = join(process.env.HOME ?? "", ".agents/skills/show-me-your-work/scripts/log.sh");
      if (existsSync(logScript)) {
        const res = spawnSync(
          "bash",
          [
            logScript,
            decisionsPath,
            "verify",
            "Verify sidecar drafts tab",
            "Confirm 6-column TSV rendering",
            join(wt, "mods/bw-drafts/main.js"),
            "pass",
          ],
          { encoding: "utf8" },
        );
        expect(res.status).toBe(0);
      } else {
        writeFileSync(
          decisionsPath,
          `ts\tphase\tdecision\twhy\tevidence\tresult\n2026-11-13T22:00:00Z\tverify\tVerify sidecar drafts tab\tConfirm 6-column TSV rendering\t${join(wt, "mods/bw-drafts/main.js")}\tpass\n`,
        );
      }

      const canonWt = realpathSync(wt);
      const runDir = mkdtempSync(join(extTmpRoot, "review-"));
      const ledgerPath = join(runDir, "ledger.md");
      writeFileSync(
        ledgerPath,
        `# Review Ledger\n\nWorktree: ${canonWt}\n\n| ID | Severity | Status |\n|---|---|---|\n| W3-01 | P2 | fixed |\n`,
      );

      const env = {
        ...process.env,
        BW_STATE_DIR: stateDir,
        BW_CACHE_DIR: cacheDir,
        BW_TMP_SCAN_DIR: extTmpRoot,
      };

      const browserUrls = /** @type {string[]} */ ([]);
      const exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
        if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw") {
          return { code: 127, stdout: "", stderr: "" };
        }
        const a = args.slice(3);
        if (a[0] === "browser" && a[1] === "new") {
          browserUrls.push(a[a.indexOf("--url") + 1]);
          return out([{ type: "tab-action", action: "new", ok: true, id: "tab-html" }]);
        }
        const r = spawnSync(bwBin, a, { encoding: "utf8", env });
        return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      };

      const m = await mount("bw-drafts", { live: { ...liveSpace(null, canonWt), exec } });
      setRightState("drafts", false);
      for (let i = 0; i < 5; i++) {
        m.render();
        await m.cx.flush();
      }
      m.render();

      const listText = textOf(byId(m.el, "drafts-list"));
      expect(listText).toContain("docs/drafts/sub/page.html");
      expect(listText).toContain("tasks.md");
      expect(listText).toContain("decisions.tsv");
      expect(listText).toContain("ledger.md");

      // Click `decisions.tsv` and verify 6-column rendering.
      await m.click(`draft-row-${domSlug("decisions.tsv")}`);
      for (let i = 0; i < 4; i++) {
        await m.cx.flush();
        m.render();
      }
      const decisionsText = textOf(byId(m.el, "drafts-decisions"));
      expect(decisionsText).toContain("Verify sidecar drafts tab");
      expect(decisionsText).toContain("Confirm 6-column TSV rendering");
      expect(decisionsText).toContain("verify");
      expect(decisionsText).toContain("pass");
      expect(decisionsText).toContain("…/bw-drafts/main.js");

      // Click `tasks.md` and verify checklist progress (`1 of 2 complete`, `50%`).
      await m.click(`draft-row-${domSlug("tasks.md")}`);
      for (let i = 0; i < 4; i++) {
        await m.cx.flush();
        m.render();
      }
      expect(textOf(byId(m.el, "drafts-plan-progress"))).toContain("1 of 2 complete");
      expect(textOf(byId(m.el, "drafts-plan-progress"))).toContain("50%");

      // Click external `ledger.md` row and verify `TextView.markdown` mounts the ledger markdown.
      const ledgerItem = m.view.items.find((/** @type {any} */ i) => i.kind === "ledger");
      expect(ledgerItem).toBeTruthy();
      await m.click(`draft-row-${domSlug(ledgerItem.id)}`);
      for (let i = 0; i < 4; i++) {
        await m.cx.flush();
        m.render();
      }
      const mdViews = findAll(m.el, (n) => n.tag === "TextView");
      expect(mdViews.length).toBeGreaterThan(0);
      expect(textOf(byId(m.el, "drafts-markdown"))).toContain("W3-01");

      // Click `Open in Browser` on `docs/drafts/sub/page.html`.
      await m.click(`draft-open-${domSlug("docs/drafts/sub/page.html")}`);
      for (let i = 0; i < 4; i++) await m.cx.flush();
      expect(browserUrls).toHaveLength(1);
      expect(browserUrls[0]).toContain("docs/drafts/sub/page.html");
    } finally {
      rmSync(baseTmp, { recursive: true, force: true });
      rmSync(extTmpRoot, { recursive: true, force: true });
    }
  });
});
