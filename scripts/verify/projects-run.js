// Done check 1's checks against real Git. Run by scripts/verify/projects.sh, which builds the
// repositories (make-repos.sh) and deletes them.
//   bun projects-run.js --root R --beta <beta common dir> --remote-root RR [--machine M]
// Without --machine, RR is a local root that a local exec serves as the machine bw-stand-in.
import { appendFileSync, watch } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mergeResult } from "../../mods/bw-projects/run-git.js";
import { readCounts, readPlace, readWorktrees } from "../../shared/git.js";
import { buildProjects, refreshTargets, rememberProjects, worktreeKey } from "../../shared/projects-model.js";
import { createPoke, runRefresher } from "../../shared/refresh-driver.js";
import { createSchedule } from "../../shared/refresh-schedule.js";

const { values: opt } = parseArgs({
  options: {
    root: { type: "string" },
    beta: { type: "string" },
    machine: { type: "string" },
    "remote-root": { type: "string" },
  },
});
if (!opt.root || !opt.beta || !opt["remote-root"]) {
  console.error("usage: bun projects-run.js --root R --beta DIR --remote-root RR [--machine M]");
  process.exit(2);
}
const ROOT = opt.root;
const REMOTE_ROOT = opt["remote-root"];
const REMOTE = opt.machine ?? null;
const M = REMOTE ?? "bw-stand-in";
const UNREACHABLE = "bw-unreachable";
const LIMIT_MS = 2000;
const HC = process.env.BW_HC || "hc";

let failed = false;
const pass = (/** @type {string} */ name, /** @type {string} */ what) => console.log(`PASS ${name}: ${what}`);
const fail = (/** @type {string} */ name, /** @type {string} */ why) => {
  failed = true;
  console.log(`FAIL ${name}: ${why}`);
};

/** @typedef {{ code: number, stdout: string, stderr: string }} ExecResult */
/** @typedef {(cmd: string, args: string[], opts: { on: string | null }) => Promise<ExecResult>} Exec */

/** @param {string[]} argv @returns {Promise<ExecResult>} */
async function spawn(argv) {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/** @param {string} cmd @param {string[]} args */
const local = (cmd, args) => spawn([cmd, ...args]);

// Rejects like Herdr's exec when hc cannot reach the machine; otherwise the program's own result.
/** @param {string} machine @returns {(cmd: string, args: string[]) => Promise<ExecResult>} */
const viaHc = (machine) => async (cmd, args) => {
  const r = await spawn([HC, "exec", "--json", "--on", machine, "--", cmd, ...args]);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error(`hc exec --on ${machine}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
  if (j.error) throw new Error(`hc exec --on ${machine}: ${j.error.message}`);
  const text = (/** @type {string} */ b64) => Buffer.from(b64 ?? "", "base64").toString("utf8");
  return { code: j.code, stdout: text(j.stdout), stderr: text(j.stderr) };
};

const remote = REMOTE ? viaHc(REMOTE) : local;
// While up, a local exec serves it; once down, hc's own refusal of an unknown machine, or offline a stub.
const refused = REMOTE ? viaHc(UNREACHABLE) : () => Promise.reject(new Error(`${UNREACHABLE}: connection refused`));
let unreachableUp = true;

/** @type {Exec} */
const exec = (cmd, args, { on }) => {
  if (on === null) return local(cmd, args);
  if (on === M) return remote(cmd, args);
  if (on === UNREACHABLE) return unreachableUp ? local(cmd, args) : refused(cmd, args);
  return Promise.reject(new Error(`no such machine: ${on}`));
};

/** @param {any} t */
function run(t) {
  if (t.kind === "place") return readPlace(exec, t.machine, t.path);
  if (t.kind === "list") return readWorktrees(exec, t.machine, t.path);
  if (t.kind === "counts") return readCounts(exec, t.machine, t.path);
  // The helper install is phase 0's check (install.sh); here it only has to answer.
  return Promise.resolve({ ok: true });
}

/** Merges one Git result into the cache the model reads, with bw-projects' own onResult. */
const merge = (/** @type {any} */ git, /** @type {any} */ t, /** @type {any} */ r) => mergeResult(git, new Map(), t, r);

let ids = 0;
/** A synthetic open space with one tab and one pane whose cwd is `cwd`. */
function openSpace(/** @type {string|null} */ machine, /** @type {string} */ cwd, active = false) {
  const n = ++ids;
  const pre = machine ? `${machine}/` : "";
  const tab = `${pre}tb${n}`;
  return {
    space: {
      id: `${pre}s${n}`,
      index: n,
      name: cwd.slice(cwd.lastIndexOf("/") + 1),
      named: false,
      folder: cwd,
      machine,
      branch: null,
      active,
      status: null,
      tabs: [
        {
          id: tab,
          index: 1,
          name: "1",
          named: false,
          active: true,
          status: null,
          panes: 1,
          zoomed: false,
          settled: false,
          settled_at: null,
          changed_at: null,
          working_since: null,
        },
      ],
    },
    pane: {
      pane: `${pre}p${n}`,
      terminal: `${pre}t${n}`,
      tab,
      title: "sh",
      cwd,
      branch: null,
      status: null,
      app: null,
      program: { name: "Terminal" },
      focused: active,
      zoomed: false,
      movable: false,
    },
  };
}

/** @returns {any} ModelInput */
function modelInput(
  /** @type {(string|null)[]} */ machines,
  /** @type {ReturnType<typeof openSpace>[]} */ open,
  /** @type {any[]} */ stored,
  git = { places: {}, worktrees: {}, counts: {}, unreachable: [] },
) {
  return {
    machines: machines.map((name) => ({ name, layout: "ready" })),
    spaces: open.map((o) => o.space),
    panes: open.map((o) => o.pane),
    agents: [],
    terminals: [],
    stored,
    platform: "macos",
    git,
  };
}

/** Runs every target once per round until the model asks for nothing new; returns the last tree. */
async function settle(/** @type {any} */ input, /** @type {string|null} */ active = null) {
  const done = new Set();
  for (let round = 0; round < 8; round++) {
    const tree = buildProjects(input);
    const todo = refreshTargets(tree, input, active).filter((t) => t.kind !== "helper" && !done.has(t.key));
    if (!todo.length) return tree;
    const results = await Promise.all(todo.map(run));
    todo.forEach((t, i) => {
      done.add(t.key);
      merge(input.git, t, results[i]);
    });
  }
  throw new Error("the model kept asking for new reads after 8 rounds");
}

// bw-projects' openWorktree (Task 9's actions.js contract), re-derived from the tree rather than imported.
const openWorktree = (/** @type {any} */ node, /** @type {string|null} */ machine) =>
  node.prunable
    ? []
    : node.open
      ? [["space.select", { id: node.spaces[0] }]]
      : [["space.new", { folder: node.path, machine: machine ?? "" }]];

const label = (/** @type {string|null} */ machine) => machine ?? "this Mac";
const machineNode = (/** @type {any} */ tree, /** @type {string|null} */ name) =>
  tree.machines.find((/** @type {any} */ m) => m.name === name);
const project = (/** @type {any} */ tree, /** @type {string|null} */ machine, /** @type {string} */ name) =>
  machineNode(tree, machine)?.projects.find((/** @type {any} */ p) => p.name === name);
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b);
const tmpSpelling = (/** @type {string} */ p) => p.replace(/^\/private\/tmp\//, "/tmp/");

/** `[path, branch]` per worktree from `git worktree list --porcelain` (no -z), parsed by awk on that machine. */
async function awkRows(/** @type {string|null} */ machine, /** @type {string} */ commonDir) {
  const script = `git --git-dir "$1" --no-optional-locks worktree list --porcelain | awk '
    /^worktree / { if (p != "") print p "\\t" b; p = substr($0, 10); b = "-" }
    /^branch refs\\/heads\\// { b = substr($0, 19) }
    /^bare$/ { p = "" }
    END { if (p != "") print p "\\t" b }'`;
  const r = await exec("sh", ["-c", script, "sh", commonDir], { on: machine });
  if (r.code !== 0) throw new Error(`worktree list on ${label(machine)}: ${r.stderr.trim()}`);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .sort();
}

const beta = { machine: null, commonDir: opt.beta, name: "beta", main: null };
const s1 = openSpace(null, `${ROOT}/alpha`, true);
// Git spells this folder /private/tmp/…; the pane's /tmp spelling must still attach to Git's path.
const s2 = openSpace(null, tmpSpelling(`${ROOT}/alpha-wt/feat`));
const s3 = openSpace(M, `${REMOTE_ROOT}/gamma`);
const first = modelInput([null, M], [s1, s2, s3], [beta]);

/** @type {any} */
let tree1 = null;
try {
  tree1 = await settle(first, s1.space.id);
} catch (e) {
  fail("setup", String(e));
}

if (tree1) {
  const names = (/** @type {string|null} */ m) =>
    (machineNode(tree1, m)?.projects ?? []).map((/** @type {any} */ p) => p.name);
  const b = project(tree1, null, "beta");
  const want = { here: ["alpha", "beta"], there: ["gamma"] };
  if (!same(names(null), want.here) || !same(names(M), want.there)) {
    fail("three-projects", `this Mac has ${JSON.stringify(names(null))}, ${M} has ${JSON.stringify(names(M))}`);
  } else if (!b?.checked || b.worktrees.length !== 1 || b.open || b.worktrees.some((/** @type {any} */ w) => w.open)) {
    fail(
      "three-projects",
      `beta should list 1 closed worktree: ${JSON.stringify(b?.worktrees.map((/** @type {any} */ w) => [w.path, w.open]))}`,
    );
  } else if (!project(tree1, null, "alpha").open || !project(tree1, M, "gamma").open) {
    fail("three-projects", "alpha and gamma should each have an open worktree");
  } else {
    pass(
      "three-projects",
      `this Mac: alpha, beta (no open worktree); ${M}: gamma${REMOTE ? "" : " (a local root served as bw-stand-in)"}`,
    );
  }

  try {
    const counts = [];
    const bad = [];
    for (const m of tree1.machines) {
      for (const p of m.projects) {
        const rows = p.worktrees.map((/** @type {any} */ w) => [w.path, w.branch ?? "-"]).sort();
        const git = await awkRows(m.name, p.commonDir);
        if (same(rows, git)) counts.push(`${p.name} ${rows.length}`);
        else bad.push(`${label(m.name)} ${p.name}: rows ${JSON.stringify(rows)}, git ${JSON.stringify(git)}`);
      }
    }
    if (bad.length) fail("rows-equal-git", bad.join("; "));
    else if (counts.length !== 3) fail("rows-equal-git", `compared ${counts.length} projects, want 3`);
    else pass("rows-equal-git", `[path, branch] rows equal awk over git worktree list for ${counts.join(", ")}`);
  } catch (e) {
    fail("rows-equal-git", String(e));
  }

  // gamma's space closes: the stored copy keeps the project, and its row dims.
  const stored = rememberProjects({ version: 1, projects: [beta] }, tree1.remember).projects;
  const tree2 = buildProjects(modelInput([null, M], [s1, s2], stored, first.git));
  const detached = project(tree2, null, "alpha")?.worktrees.find(
    (/** @type {any} */ w) => w.path === `${ROOT}/alpha-wt/detached`,
  );
  const gammaMain = project(tree2, M, "gamma")?.worktrees.find((/** @type {any} */ w) => w.main);
  const wantDetached = [["space.new", { folder: `${ROOT}/alpha-wt/detached`, machine: "" }]];
  const wantGamma = [["space.new", { folder: `${REMOTE_ROOT}/gamma`, machine: M }]];
  if (!detached || !same(openWorktree(detached, null), wantDetached)) {
    fail(
      "dimmed-row-opens-exactly",
      `alpha-wt/detached gives ${JSON.stringify(detached && openWorktree(detached, null))}, want ${JSON.stringify(wantDetached)}`,
    );
  } else if (!gammaMain || !same(openWorktree(gammaMain, M), wantGamma)) {
    fail(
      "dimmed-row-opens-exactly",
      `gamma's main gives ${JSON.stringify(gammaMain && openWorktree(gammaMain, M))}, want ${JSON.stringify(wantGamma)}`,
    );
  } else {
    pass("dimmed-row-opens-exactly", `${JSON.stringify(wantDetached[0])} and ${JSON.stringify(wantGamma[0])}`);
  }
}

/**
 * Runs the real schedule and driver, and per probe appends 2 lines to notes.txt right after a counts
 * read of that worktree finishes (the worst moment), then times until the counts show the edit.
 */
async function countsWithin() {
  const probes = [{ machine: /** @type {string|null} */ (null), path: `${ROOT}/alpha-wt/feat` }];
  if (REMOTE) probes.push({ machine: REMOTE, path: `${REMOTE_ROOT}/alpha-wt/feat` });
  const open = probes.map((p, i) => openSpace(p.machine, p.path, i === probes.length - 1));
  const active = open.at(-1)?.space.id ?? null;
  const input = modelInput([null, ...(REMOTE ? [REMOTE] : [])], open, []);
  const schedule = createSchedule();
  const poke = createPoke();
  const watches = new Map();
  let alive = true;

  /** fs.watch stands in for Herdr's watchFolder: absolute paths in batches. */
  function watchFolder(/** @type {string} */ dir) {
    let w = watches.get(dir);
    if (!w) {
      w = { paths: /** @type {string[]} */ ([]), wake: /** @type {(() => void) | null} */ (null) };
      const it = w;
      it.fsw = watch(dir, { recursive: true }, (_event, name) => {
        it.paths.push(name ? join(dir, String(name)) : dir);
        const wake = it.wake;
        it.wake = null;
        wake?.();
      });
      watches.set(dir, w);
    }
    const it = w;
    return new Promise((resolve) => {
      if (it.paths.length) resolve(it.paths.splice(0));
      else it.wake = () => resolve(it.paths.splice(0));
    });
  }

  const render = () => {
    const tree = buildProjects(input);
    if (schedule.setTargets(refreshTargets(tree, input, active), Date.now())) poke.poke();
  };

  const state = probes.map((p) => ({
    ...p,
    key: worktreeKey(p.machine, p.path),
    base: /** @type {number|null} */ (null),
    t0: /** @type {number|null} */ (null),
    ms: /** @type {number|null} */ (null),
    error: "",
  }));
  /** @type {() => void} */
  let allDone = () => {};
  const finished = new Promise((/** @type {(v?: unknown) => void} */ resolve) => (allDone = resolve));
  const check = () => state.every((s) => s.ms !== null || s.error) && allDone();

  /** @param {(typeof state)[number]} s */
  async function write(s) {
    try {
      if (s.machine === null) {
        appendFileSync(join(s.path, "notes.txt"), "added one\nadded two\n");
      } else {
        const r = await exec("sh", ["-c", 'printf "added one\\nadded two\\n" >> "$1/notes.txt"', "sh", s.path], {
          on: s.machine,
        });
        if (r.code !== 0) throw new Error(r.stderr.trim());
      }
      s.t0 = Date.now();
    } catch (e) {
      s.error = `writing on ${label(s.machine)}: ${e}`;
      check();
    }
  }

  const onResult = (/** @type {any} */ t, /** @type {any} */ r) => {
    const changed = merge(input.git, t, r);
    const s = state.find((x) => t.kind === "counts" && x.key === worktreeKey(t.machine, t.path));
    if (s && r.ok) {
      if (s.base === null) {
        s.base = r.counts.added;
        write(s);
      } else if (s.t0 !== null && s.ms === null && r.counts.added !== s.base) {
        s.ms = Date.now() - s.t0;
        check();
      }
    }
    return changed;
  };

  const cx = {
    spawn: (/** @type {(cx: any) => unknown} */ body) => void Promise.resolve().then(() => body(cx)),
    sleep: (/** @type {number} */ ms = 0) => new Promise((resolve) => setTimeout(resolve, ms)),
    notify: () => queueMicrotask(render),
  };
  render();
  const loop = runRefresher(cx, { schedule, run, onResult, watchFolder, poke, alive: () => alive });
  const deadline = setTimeout(allDone, 20000);
  await finished;
  clearTimeout(deadline);
  alive = false;
  poke.poke();
  await loop;
  for (const w of watches.values()) w.fsw.close();
  return state;
}

try {
  const results = await countsWithin();
  const shown = results.map((s) => {
    const where = `${label(s.machine)} alpha-wt/feat`;
    if (s.error) return { ok: false, text: s.error };
    if (s.base === null) return { ok: false, text: `${where}: no counts read in 20 s` };
    if (s.ms === null) return { ok: false, text: `${where}: +${s.base} never changed after the write` };
    return { ok: s.ms <= LIMIT_MS, text: `${where} +${s.base} → +${s.base + 2} in ${s.ms} ms` };
  });
  const text = shown.map((x) => x.text).join("; ") + (REMOTE ? "" : " (this Mac only)");
  if (shown.every((x) => x.ok)) pass("counts-within-2s", text);
  else fail("counts-within-2s", `${text}; limit ${LIMIT_MS} ms`);
} catch (e) {
  fail("counts-within-2s", String(e));
}

try {
  const commonDir = `${ROOT}/alpha/.git`;
  const input = modelInput([null, UNREACHABLE], [], [{ machine: UNREACHABLE, commonDir, name: "alpha", main: null }]);
  const before = project(await settle(input), UNREACHABLE, "alpha");
  unreachableUp = false;
  const after = await settle(input);
  const node = machineNode(after, UNREACHABLE);
  const p = project(after, UNREACHABLE, "alpha");
  const rows = (/** @type {any} */ q) => q?.worktrees.map((/** @type {any} */ w) => [w.path, w.counts]);
  if (!before?.worktrees.length || before.worktrees.some((/** @type {any} */ w) => !w.counts)) {
    fail("unreachable-named", `while reachable, rows were ${JSON.stringify(rows(before))}`);
  } else if (!input.git.unreachable.includes(UNREACHABLE)) {
    fail("unreachable-named", "a rejected exec did not mark the machine unreachable");
  } else if (node?.label !== UNREACHABLE || node.state !== "offline") {
    fail(
      "unreachable-named",
      `heading ${JSON.stringify(node && { label: node.label, state: node.state })}, want ${UNREACHABLE} offline`,
    );
  } else if (!same(rows(p), rows(before)) || !p.worktrees.every((/** @type {any} */ w) => w.stale)) {
    fail(
      "unreachable-named",
      `rows ${JSON.stringify(rows(p))} differ from before ${JSON.stringify(rows(before))} or are not stale`,
    );
  } else {
    const why = REMOTE ? "hc exec refused it" : "a stub exec rejected";
    pass(
      "unreachable-named",
      `${why}; heading "${node.label}" offline; its ${p.worktrees.length} rows and counts kept, marked stale`,
    );
  }
} catch (e) {
  fail("unreachable-named", String(e));
}

process.exit(failed ? 1 : 0);
