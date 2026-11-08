// bw-linear: the Issues panel and its link picker, against a fake `bw linear` and fake Git.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mount } from "../harness/mount.js";
import { fake } from "../harness/herdr-stub.js";
import { byId, textOf } from "../harness/kit-stub.js";
import { HELPER_SCRIPTS, HELPER_VERSION, PROTOCOL } from "../../shared/helper.js";
import { ATTACH, chipsFor } from "../../shared/linear-attach.js";
import { LINKS, readLink, writeLink } from "../../shared/linear-links.js";
import { groupByState, isShown, listArgs, readList } from "../../mods/bw-linear/model.js";

/** @param {object[]} ls */
const out = (ls) => ({ code: 0, stdout: `${ls.map((l) => JSON.stringify(l)).join("\n")}\n`, stderr: "" });
const VERSION = out([{ type: "version", protocol: PROTOCOL, version: HELPER_VERSION }]);
const TOP = "/private/tmp/bw-linear/repo";
const COMMON = `${TOP}/.git`;
const PAGE = { type: "linear-page", next: null, at: 1, cached: false, age_s: null };

afterEach(() => setSystemTime());

const issue = (identifier, state = ["Todo", "unstarted"], extra = {}) => ({
  type: "linear-issue",
  identifier,
  title: `Title ${identifier}`,
  url: `https://linear.app/x/issue/${identifier}`,
  branch: `feature/${identifier.toLowerCase()}`,
  state: { name: state[0], type: state[1], color: "#aaa", position: 1 },
  assignee: null,
  mine: false,
  project: { id: "P1", name: "Bellwether" },
  labels: [],
  ...extra,
});

const PROJECT = [issue("PLA-1"), issue("PLA-2", ["In Progress", "started"]), PAGE];
const MINE = [issue("PLA-1", undefined, { mine: true }), issue("PLA-9", undefined, { mine: true }), PAGE];
const ALL = [issue("PLA-1"), issue("PLA-2"), issue("PLA-9"), issue("PLA-10"), PAGE];

/**
 * Fake exec: the helper's `linear` calls by scope, and Git's place and origin reads.
 * @param {{ origin?: () => string | null, linear?: (args: string[]) => any }} o
 */
function world(o = {}) {
  const origin = o.origin ?? (() => null);
  return async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ _opts) => {
    if (cmd === "git") {
      if (args.includes("rev-parse")) return { code: 0, stdout: `${COMMON}\n${TOP}\n`, stderr: "" };
      if (args.includes("remote.origin.url")) {
        const u = origin();
        return u ? { code: 0, stdout: `${u}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected git" };
    }
    if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1]) || args[2] !== "bw")
      return { code: 127, stdout: "", stderr: "" };
    const a = args.slice(3);
    if (a[0] === "version") return VERSION;
    if (o.linear) {
      const r = o.linear(a);
      if (r) return r;
    }
    if (a[0] === "linear" && a[1] === "issues") {
      const scope = a[a.indexOf("--scope") + 1];
      return out(scope === "project" ? PROJECT : scope === "mine" ? MINE : ALL);
    }
    if (a[0] === "linear" && a[1] === "issue") {
      const id = a[a.indexOf("--id") + 1];
      return out([{ ...issue(id), description: "Some **markdown**.", bytes: 18 }]);
    }
    if (a[0] === "linear" && a[1] === "projects")
      return out([
        { type: "linear-project", id: "P2", name: "Bellwether scratch", url: "u", teams: ["PLA"] },
        { type: "linear-project", id: "P1", name: "Bellwether", url: "u", teams: ["PLA"] },
        { type: "linear-project", id: "P3", name: "CommScores", url: "u", teams: ["X"] },
        { type: "linear-done", at: 1, cached: false, age_s: null },
      ]);
    return out([{ type: "error", code: "stub", message: `no answer for ${a.join(" ")}` }]);
  };
}

/** A space on `machine` in TOP; its active tab is a chat tab when `chat`. */
function live(machine = null, chat = false) {
  return {
    machines: [{ name: null, layout: "ready" }, ...(machine ? [{ name: machine, layout: "ready" }] : [])],
    spaces: [
      {
        id: "s1",
        index: 1,
        name: "repo",
        named: false,
        folder: TOP,
        machine,
        branch: "main",
        active: true,
        status: null,
        tabs: [{ id: "tb1", index: 1, name: "1", named: false, active: true, status: null, panes: chat ? 2 : 1 }],
      },
    ],
    panes: [
      { pane: "p1", terminal: "t1", tab: "tb1", title: "zsh", cwd: TOP, branch: "main", focused: true },
      ...(chat
        ? [{ pane: "p2", terminal: null, tab: "tb1", title: "Claude", cwd: null, mod: "bw-chat", focused: false }]
        : []),
    ],
  };
}

/** @param {string} child */
function showInLayout(child, node = fake.layout) {
  if (node.id === "right-body") node.active = child;
  for (const c of node.children ?? []) showInLayout(child, c);
}

/** @param {any} m */
const linearCalls = (m) => m.log.exec.filter(([c, a]) => c === "sh" && a[3] === "linear").map(([, a]) => a.slice(4));
/** @param {any} m */
const gitCalls = (m) => m.log.exec.filter(([c]) => c === "git");

/** @param {{ machine?: string | null, chat?: boolean, shared?: any, hidden?: boolean, exec?: any }} [o] */
async function panel(o = {}) {
  const m = await mount("bw-linear", {
    live: { ...live(o.machine ?? null, o.chat ?? false), exec: o.exec ?? world(), shared: o.shared ?? {} },
  });
  // mount resets the layout, whose stack shows Changes.
  showInLayout(o.hidden ? "browser" : "issues");
  for (let i = 0; i < 3; i++) {
    await m.cx.flush();
    m.render();
  }
  return m;
}

/** Wakes the newest sleep after moving a fake clock by its length, `ms` in all; draws unless `draw` is false. */
async function runFor(/** @type {any} */ m, /** @type {number} */ ms, { draw = true } = {}) {
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

const linkedP1 = (origin = null) => ({
  [LINKS]: writeLink(
    undefined,
    { machine: null, commonDir: COMMON, origin },
    { projectId: "P1", name: "Bellwether", at: 1 },
  ),
});

describe("model", () => {
  test("isShown reads the right-body stack", () => {
    const l = { id: "root", children: [{ id: "right-body", active: "issues", children: [] }] };
    expect(isShown(l)).toBe(true);
    expect(isShown({ ...l, children: [{ id: "right-body", active: "changes" }] })).toBe(false);
    expect(isShown({ id: "root", hidden: true, children: l.children })).toBe(false);
  });

  test("listArgs per filter and search", () => {
    expect(listArgs("project", "P1", "")).toEqual(["linear", "issues", "--scope", "project", "--project", "P1"]);
    expect(listArgs("project", null, "")).toBe(null);
    expect(listArgs("mine", null, " fix ")).toEqual(["linear", "search", "--text", "fix", "--scope", "mine"]);
    expect(listArgs("all", null, "", "c2")).toEqual(["linear", "issues", "--scope", "all", "--after", "c2"]);
  });

  test("groups follow state type, then Linear's order", () => {
    const list = readList([
      issue("A", ["Backlog", "backlog"]),
      issue("B", ["Todo", "unstarted"]),
      issue("C", ["In Progress", "started"]),
      issue("D", ["Todo", "unstarted"]),
      PAGE,
    ]);
    expect(groupByState(list.issues).map((g) => [g.name, g.issues.map((i) => i.identifier)])).toEqual([
      ["In Progress", ["C"]],
      ["Todo", ["B", "D"]],
      ["Backlog", ["A"]],
    ]);
  });
});

describe("polling", () => {
  for (const machine of [null, "macbook"]) {
    test(`hidden panel makes no call in 12 s (${machine ?? "local"} space)`, async () => {
      const m = await panel({ machine, hidden: true });
      await runFor(m, 12_000, { draw: false });
      expect(linearCalls(m)).toEqual([]);
      expect(gitCalls(m)).toEqual([]);
    });
  }

  test("the strip's render before the stack switches calls nothing", async () => {
    // The copy is drawn while the layout already shows another panel.
    const m = await mount("bw-linear", { live: { ...live(), exec: world() } });
    showInLayout("browser");
    m.view.shown = true;
    m.view.drawn = true;
    m.view.poke.poke();
    await m.cx.flush();
    expect(linearCalls(m)).toEqual([]);
  });

  test("shown panel reads at once, every 60 s, and on a refresh click", async () => {
    const m = await panel({ shared: linkedP1() });
    expect(linearCalls(m)).toEqual([["issues", "--scope", "project", "--project", "P1"]]);
    await runFor(m, 12_000);
    expect(linearCalls(m).length).toBe(1);
    await runFor(m, 60_000);
    expect(linearCalls(m).length).toBe(2);
    await m.click("issues-refresh");
    await m.cx.flush();
    expect(linearCalls(m).length).toBe(3);
  });

  test("hiding parks the loop; showing again reads once", async () => {
    const m = await panel({ shared: linkedP1() });
    showInLayout("changes");
    await runFor(m, 120_000, { draw: false });
    expect(linearCalls(m).length).toBe(1);
    showInLayout("issues");
    m.render();
    await m.cx.flush();
    expect(linearCalls(m).length).toBe(2);
  });
});

describe("filters", () => {
  test("unlinked: Mine by default, Project disabled", async () => {
    const m = await panel();
    expect(linearCalls(m)).toEqual([["issues", "--scope", "mine"]]);
    expect(textOf(byId(m.render(), "issues-project"))).toContain("Link a Linear project");
    expect(m.click("issues-scope-project")).rejects.toThrow("no on_click handler");
    expect(linearCalls(m).length).toBe(1);
  });

  test("linked: Project by default; Mine and All change the list", async () => {
    const m = await panel({ shared: linkedP1() });
    const shownIds = () =>
      ["PLA-1", "PLA-2", "PLA-9", "PLA-10"].filter((id) => byId(m.render(), `issue-${id}`) !== null);
    expect(shownIds()).toEqual(["PLA-1", "PLA-2"]);
    await m.click("issues-scope-mine");
    await m.cx.flush();
    m.render();
    expect(linearCalls(m).at(-1)).toEqual(["issues", "--scope", "mine"]);
    expect(shownIds()).toEqual(["PLA-1", "PLA-9"]);
    await m.click("issues-scope-all");
    await m.cx.flush();
    expect(shownIds()).toEqual(["PLA-1", "PLA-2", "PLA-9", "PLA-10"]);
  });

  test("errors are named and a refused key leaves no list", async () => {
    let refuse = false;
    const exec = world({
      linear: (a) =>
        refuse && a[1] === "issues"
          ? { code: 1, stdout: '{"type":"error","code":"key_refused","message":"x"}\n', stderr: "" }
          : null,
    });
    const m = await panel({ exec });
    expect(byId(m.render(), "issue-PLA-1")).not.toBe(null);
    refuse = true;
    await m.click("issues-refresh");
    await m.cx.flush();
    const el = m.render();
    expect(byId(el, "issue-PLA-1")).toBe(null);
    expect(textOf(byId(el, "issues-error"))).toContain("Linear refused the key");
  });

  test("a cached list says how old it is", async () => {
    const exec = world({
      linear: (a) => (a[1] === "issues" ? out([issue("PLA-1"), { ...PAGE, cached: true, age_s: 300 }]) : null),
    });
    const m = await panel({ exec });
    expect(textOf(byId(m.render(), "issues-stale"))).toContain("5 min old");
  });
});

describe("links", () => {
  test("an origin that appears moves the link to the origin key", async () => {
    let origin = /** @type {string | null} */ (null);
    const m = await panel({ shared: linkedP1(), exec: world({ origin: () => origin }) });
    expect(Object.keys(fake.shared[LINKS].links)[0]).toStartWith("place:");
    origin = "git@github.com:me/scratch.git";
    await m.click("issues-refresh");
    await m.cx.flush();
    expect(Object.keys(fake.shared[LINKS].links)).toEqual(["origin:github.com/me/scratch"]);
    expect(linearCalls(m).at(-1)).toEqual(["issues", "--scope", "project", "--project", "P1"]);
  });

  test("the header opens the picker for the shown repository", async () => {
    const m = await panel();
    await m.click("issues-project");
    expect(m.log.overlays.at(-1)).toMatchObject({
      mod: "bw-linear",
      kind: "dialog",
      props: { pick: { machine: null, commonDir: COMMON, name: "repo" } },
    });
  });

  test("the picker suggests by name and writes the link", async () => {
    const m = await mount("bw-linear", {
      props: {
        pick: { machine: null, commonDir: "/private/tmp/x/bellwether/.git", name: "bellwether" },
        overlay: "o7",
      },
      live: { exec: world() },
    });
    await m.cx.flush();
    const el = m.render();
    expect(textOf(byId(el, "pick-list"))).toBe("Bellwether suggested Bellwether scratch CommScores");
    await m.click("pick-P2");
    const repo = { machine: null, commonDir: "/private/tmp/x/bellwether/.git", origin: null };
    expect(readLink(fake.shared[LINKS], repo)).toMatchObject({ projectId: "P2", name: "Bellwether scratch" });
    expect(m.log.closed).toEqual(["o7"]);
  });

  test("a new link reads the project's list", async () => {
    const m = await panel();
    expect(linearCalls(m)).toEqual([["issues", "--scope", "mine"]]);
    fake.shared[LINKS] = linkedP1()[LINKS];
    m.render();
    await m.cx.flush();
    expect(linearCalls(m).at(-1)).toEqual(["issues", "--scope", "project", "--project", "P1"]);
  });
});

describe("inline issue", () => {
  test("Attach puts a chip on the active chat tab's composer", async () => {
    const m = await panel({ chat: true, shared: linkedP1() });
    await m.click("issue-PLA-1");
    await m.cx.flush();
    const el = m.render();
    expect(textOf(byId(el, "issue-title"))).toBe("Title PLA-1");
    expect(byId(el, "issue-attach-hint")).toBe(null);
    await m.click("issue-attach");
    const chips = chipsFor(fake.shared[ATTACH], "tb1");
    expect(chips.map((c) => [c.identifier, c.title, c.bytes])).toEqual([["PLA-1", "Title PLA-1", 18]]);
    // The detail read is the only call the click made.
    expect(linearCalls(m).filter((a) => a[0] === "issue")).toEqual([["issue", "--id", "PLA-1"]]);
  });

  test("without a chat tab Attach is off and says why", async () => {
    const m = await panel({ shared: linkedP1() });
    await m.click("issue-PLA-1");
    await m.cx.flush();
    const el = m.render();
    expect(byId(el, "issue-attach-hint")).not.toBe(null);
    expect(m.click("issue-attach")).rejects.toThrow("no on_click handler");
    expect(fake.shared[ATTACH]).toBeUndefined();
  });

  test("Open in Linear and Copy branch name", async () => {
    const m = await panel({ shared: linkedP1() });
    await m.click("issue-PLA-2");
    await m.cx.flush();
    m.render();
    await m.click("issue-open");
    await m.click("issue-branch");
    expect(m.cx.opened).toEqual(["https://linear.app/x/issue/PLA-2"]);
    expect(m.cx.clipboard).toEqual(["feature/pla-2"]);
  });
});

describe("review fixes", () => {
  /** Two spaces, A on /r/a and B on /r/b; `hold[x]` delays that repository's rev-parse; `fail[x]` names its failure. */
  function twoSpaces(
    /** @type {{ hold?: Record<string, Promise<void>>, fail?: Record<string, string>, linear?: (a: string[]) => any }} */ o = {},
  ) {
    const exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      if (cmd === "git") {
        const folder = args[1] ?? "";
        const w = folder.startsWith("/r/a") || args.includes("/r/a/.git") ? "a" : "b";
        if (args.includes("rev-parse")) {
          if (o.hold?.[w]) await o.hold[w];
          if (o.fail?.[w] === "not_git") return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
          if (o.fail?.[w]) throw new Error(o.fail[w]);
          return { code: 0, stdout: `/r/${w}/.git\n/r/${w}\n`, stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd !== "sh" || !HELPER_SCRIPTS.includes(args[1])) return { code: 127, stdout: "", stderr: "" };
      const a = args.slice(3);
      if (a[0] === "version") return VERSION;
      const r = o.linear?.(a);
      if (r) return r;
      if (a[1] === "issue") return out([{ ...issue(a[a.indexOf("--id") + 1]), description: "d", bytes: 1 }]);
      const p = a.includes("--project") ? a[a.indexOf("--project") + 1] : null;
      return out(p === "PA" ? [issue("A-1"), PAGE] : p === "PB" ? [issue("B-1"), PAGE] : [issue("M-1"), PAGE]);
    };
    const sp = (/** @type {string} */ id, /** @type {string} */ folder, /** @type {boolean} */ active) => ({
      id,
      index: 1,
      name: id,
      named: false,
      folder,
      machine: null,
      branch: "main",
      active,
      status: null,
      tabs: [{ id: `t${id}`, index: 1, name: "1", named: false, active: true, status: null, panes: 1 }],
    });
    const pane = (/** @type {string} */ id, /** @type {string} */ folder) => ({
      pane: `p${id}`,
      terminal: "t",
      tab: `t${id}`,
      title: "zsh",
      cwd: folder,
      branch: "main",
      focused: true,
    });
    let l = writeLink(
      undefined,
      { machine: null, commonDir: "/r/a/.git", origin: null },
      { projectId: "PA", name: "Project A", at: 1 },
    );
    l = writeLink(
      l,
      { machine: null, commonDir: "/r/b/.git", origin: null },
      { projectId: "PB", name: "Project B", at: 1 },
    );
    return {
      machines: [{ name: null, layout: "ready" }],
      spaces: [sp("sA", "/r/a", true), sp("sB", "/r/b", false)],
      panes: [pane("sA", "/r/a"), pane("sB", "/r/b")],
      exec,
      shared: { [LINKS]: l },
    };
  }
  const activate = (/** @type {string} */ id) => {
    for (const s of fake.spaces) s.active = s.id === id;
  };
  /** @returns {[Promise<void>, () => void]} */
  const gate = () => {
    let open = () => {};
    const p = new Promise((r) => (open = () => r(undefined)));
    return [/** @type {Promise<void>} */ (p), open];
  };
  const shown = (/** @type {any} */ el) => ["A-1", "B-1", "M-1"].filter((i) => byId(el, `issue-${i}`) !== null);
  async function settle(/** @type {any} */ m) {
    for (let i = 0; i < 4; i++) {
      await m.cx.flush();
      m.render();
    }
  }

  test("a space switch drops the old repository: no picker for it while the new one is read", async () => {
    const [holdB, openB] = gate();
    const m = await mount("bw-linear", { live: twoSpaces({ hold: { b: holdB } }) });
    showInLayout("issues");
    await settle(m);
    expect(textOf(byId(m.render(), "issues-project"))).toContain("Project A");
    activate("sB");
    await settle(m);
    expect(textOf(byId(m.render(), "issues-project"))).toContain("Reading the repository");
    expect(m.click("issues-project")).rejects.toThrow("no on_click handler");
    openB();
    await settle(m);
    expect(textOf(byId(m.render(), "issues-project"))).toContain("Project B");
    expect(shown(m.render())).toEqual(["B-1"]);
  });

  test("a lookup that ends after the space changed is dropped", async () => {
    const [holdA, openA] = gate();
    const m = await mount("bw-linear", { live: twoSpaces({ hold: { a: holdA } }) });
    showInLayout("issues");
    await settle(m);
    activate("sB");
    await settle(m);
    openA();
    await settle(m);
    expect(linearCalls(m).filter((a) => a.includes("PA"))).toEqual([]);
    expect(shown(m.render())).toEqual(["B-1"]);
  });

  test("hidden while the repository is read: no Linear call starts", async () => {
    const [holdA, openA] = gate();
    const m = await mount("bw-linear", { live: twoSpaces({ hold: { a: holdA } }) });
    showInLayout("issues");
    await settle(m);
    showInLayout("browser");
    openA();
    await m.cx.flush();
    await m.cx.flush();
    expect(linearCalls(m)).toEqual([]);
    // Shown again, it reads at once rather than after the 60 s wait.
    showInLayout("issues");
    await settle(m);
    expect(linearCalls(m)).toEqual([["issues", "--scope", "project", "--project", "PA"]]);
  });

  test("a failed read for another project or search drops the old list", async () => {
    let offline = false;
    const data = twoSpaces({
      linear: (a) =>
        offline && a[0] === "linear" && a[1] !== "issue"
          ? { code: 1, stdout: '{"type":"error","code":"offline","message":"Linear is unreachable"}\n', stderr: "" }
          : null,
    });
    const m = await mount("bw-linear", { live: data });
    showInLayout("issues");
    await settle(m);
    expect(shown(m.render())).toEqual(["A-1"]);
    offline = true;
    // A refresh of the same list keeps it through the failure.
    await m.click("issues-refresh");
    await settle(m);
    expect(shown(m.render())).toEqual(["A-1"]);
    fake.shared[LINKS] = writeLink(
      fake.shared[LINKS],
      { machine: null, commonDir: "/r/a/.git", origin: null },
      {
        projectId: "PB",
        name: "Project B",
        at: 2,
      },
    );
    await settle(m);
    expect(textOf(byId(m.render(), "issues-project"))).toContain("Project B");
    expect(shown(m.render())).toEqual([]);
    expect(textOf(byId(m.render(), "issues-error"))).toContain("unreachable");
  });

  test("filter, search, a new link and a refused key close the open issue; refresh rereads it", async () => {
    let refuse = false;
    const data = twoSpaces({
      linear: (a) =>
        refuse && a[1] === "issues"
          ? { code: 1, stdout: '{"type":"error","code":"key_refused","message":"x"}\n', stderr: "" }
          : null,
    });
    const m = await mount("bw-linear", { live: data });
    showInLayout("issues");
    await settle(m);
    const openA1 = async () => {
      await m.click("issue-A-1");
      await settle(m);
      expect(byId(m.render(), "issue-detail")).not.toBe(null);
    };
    await openA1();
    const before = linearCalls(m).filter((a) => a[0] === "issue").length;
    await m.click("issues-refresh");
    await settle(m);
    expect(linearCalls(m).filter((a) => a[0] === "issue").length).toBe(before + 1);
    expect(byId(m.render(), "issue-detail")).not.toBe(null);
    await m.click("issues-scope-mine");
    await settle(m);
    expect(byId(m.render(), "issue-detail")).toBe(null);
    expect(shown(m.render())).toEqual(["M-1"]);
    await m.click("issue-M-1");
    await settle(m);
    const state = m.view.search;
    state.set_value("zz");
    await state.handlers.submit({}, m.cx);
    await settle(m);
    expect(byId(m.render(), "issue-detail")).toBe(null);
    await m.click("issue-M-1");
    await settle(m);
    refuse = true;
    state.set_value("");
    await state.handlers.submit({}, m.cx);
    await m.click("issues-scope-project");
    await settle(m);
    await m.click("issues-refresh");
    await settle(m);
    expect(byId(m.render(), "issue-detail")).toBe(null);
    expect(textOf(byId(m.render(), "issues-error"))).toContain("Linear refused the key");
  });

  test("a space outside Git reads nothing from Linear; an unreachable machine says so", async () => {
    const m = await mount("bw-linear", {
      live: twoSpaces({ fail: { a: "not_git", b: "ssh: Could not resolve hostname tsuki" } }),
    });
    showInLayout("issues");
    await settle(m);
    await runFor(m, 130_000);
    expect(linearCalls(m)).toEqual([]);
    expect(textOf(byId(m.render(), "issues-empty"))).toContain("Open a space in a Git repository");
    activate("sB");
    await settle(m);
    expect(linearCalls(m)).toEqual([]);
    expect(textOf(byId(m.render(), "issues-empty"))).toContain("ssh: Could not resolve hostname tsuki");
  });
});
