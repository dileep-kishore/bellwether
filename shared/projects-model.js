// The project sidebar's tree, built from Herdr's live data and a cache of parsed Git output.
// Pure and Herdr-free, so mods copy it and `bun test` runs it; mods that list it must also list `status`.

import { worst } from "./status.js";

/** @typedef {import("./status.js").Status} Status */

/**
 * @typedef {object} Worktree One `git worktree list --porcelain -z` entry (shared/git-parse.js).
 * @property {string} path
 * @property {string | null} head
 * @property {string | null} branch
 * @property {boolean} detached
 * @property {boolean} bare
 * @property {boolean} locked
 * @property {boolean} prunable
 */

/**
 * @typedef {object} Counts A worktree's status and diff numbers (shared/git-parse.js).
 * @property {string | null} branch
 * @property {boolean} detached
 * @property {boolean} upstream
 * @property {number} ahead
 * @property {number} behind
 * @property {number} files
 * @property {number} added
 * @property {number} removed
 */

/**
 * @typedef {object} Stored A remembered project, kept in `shared("bw.projects")`.
 * @property {string | null} machine
 * @property {string} commonDir
 * @property {string} name
 * @property {string | null} main
 */

/**
 * @typedef {object} GitCache Keyed by placeKey, projectKey and worktreeKey.
 * @property {Record<string, { commonDir: string, top: string } | "not_git">} places
 * @property {Record<string, { list: Worktree[], stale: boolean }>} worktrees
 * @property {Record<string, Counts & { stale: boolean }>} counts
 * @property {(string | null)[]} unreachable machine names whose last exec rejected
 */

/**
 * @typedef {object} ModelInput
 * @property {{ name: string | null, layout: "loading" | "ready" | "unavailable" }[]} machines
 * @property {any[]} spaces SpaceInfo[]
 * @property {any[]} panes PaneInfo[]
 * @property {any[]} agents AgentInfo[]
 * @property {any[]} terminals
 * @property {Stored[]} stored
 * @property {"macos" | "linux" | "windows"} platform
 * @property {GitCache} git
 * @property {Record<string, AgentCount>} [counts] `bw counts` per agent address, in this window's namespace
 */

/**
 * @typedef {object} AgentCount One `bw counts` line: running in-process sub-agents and waiting requests.
 * @property {number} subagents
 * @property {number} requests
 */

/**
 * @typedef {object} CountTarget The agent lines on one machine that `bw counts` runs for there.
 * @property {string | null} machine
 * @property {{ address: string, local: string }[]} terminals
 */

/**
 * @typedef {object} AgentLine
 * @property {string} address
 * @property {string} space
 * @property {string} tab
 * @property {string} title
 * @property {Status} status
 * @property {any} program
 * @property {number} subagents
 * @property {number} requests
 * @property {number | null} changedAt
 */

/**
 * @typedef {object} WorktreeNode
 * @property {string} key
 * @property {string} path
 * @property {string | null} branch
 * @property {boolean} detached
 * @property {boolean} prunable
 * @property {boolean} main
 * @property {boolean} open
 * @property {string[]} spaces
 * @property {Counts | null} counts
 * @property {boolean} stale
 * @property {Status | null} status
 * @property {AgentLine[]} agents
 */

/**
 * @typedef {object} ProjectNode
 * @property {string} key
 * @property {string | null} machine
 * @property {string} commonDir
 * @property {string} name
 * @property {string} letter
 * @property {string | null} main
 * @property {boolean} open
 * @property {Status | null} status
 * @property {boolean} checked the worktree list has been read at least once
 * @property {WorktreeNode[]} worktrees
 */

/**
 * @typedef {object} PlainSpace
 * @property {string} id
 * @property {string} name
 * @property {boolean} active
 * @property {Status | null} status
 * @property {AgentLine[]} agents
 */

/**
 * @typedef {object} MachineNode
 * @property {string | null} name
 * @property {string} label
 * @property {"ready" | "loading" | "offline" | "not_connected"} state
 * @property {ProjectNode[]} projects
 * @property {PlainSpace[]} plain
 */

/**
 * @typedef {object} ProjectTree
 * @property {MachineNode[]} machines
 * @property {string[]} agentOrder
 * @property {Stored[]} remember
 */

/**
 * @typedef {object} Target
 * @property {string} key
 * @property {"place" | "list" | "counts" | "helper"} kind
 * @property {string | null} machine
 * @property {string} path
 * @property {boolean} open
 * @property {boolean} selected
 * @property {string[]} wakeOn
 */

const keyOf = (/** @type {string | null | undefined} */ machine, /** @type {string} */ value) =>
  JSON.stringify([machine ?? null, value]);

/** @param {string | null | undefined} machine @param {string} folder */
export const placeKey = (machine, folder) => keyOf(machine, folder);
/** @param {string | null | undefined} machine @param {string} commonDir */
export const projectKey = (machine, commonDir) => keyOf(machine, commonDir);
/** @param {string | null | undefined} machine @param {string} path */
export const worktreeKey = (machine, path) => keyOf(machine, path);

const trim = (/** @type {string} */ p) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
const baseName = (/** @type {string} */ p) => trim(p).slice(trim(p).lastIndexOf("/") + 1);
const parentDir = (/** @type {string} */ p) => {
  const t = trim(p);
  const i = t.lastIndexOf("/");
  return i > 0 ? t.slice(0, i) : "/";
};
/** A common dir named `.git` sits inside its main checkout. */
const guessMain = (/** @type {string} */ commonDir) => (baseName(commonDir) === ".git" ? parentDir(commonDir) : null);
const nameOf = (/** @type {string} */ commonDir, /** @type {string | null} */ main) =>
  main ? baseName(main) : baseName(commonDir).replace(/\.git$/, "") || baseName(parentDir(commonDir));
const letterOf = (/** @type {string} */ name) => (Array.from(name)[0] ?? "?").toUpperCase();
const cmp = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b, "en");

/**
 * Where a space is now: the first pane in its tabs, in tab order, with a cwd; else its folder.
 *
 * @param {any} space SpaceInfo
 * @param {any[]} panes PaneInfo[]
 * @returns {string}
 */
export function placeOf(space, panes) {
  for (const tab of space.tabs ?? []) {
    const pane = panes.find((p) => p.tab === tab.id && p.cwd);
    if (pane) return pane.cwd;
  }
  return space.folder;
}

/**
 * The remembered projects in `shared("bw.projects")`; anything but `{ version: 1, projects }` reads as none.
 *
 * @param {unknown} value
 * @returns {Stored[]}
 */
export function readStored(value) {
  const v = /** @type {any} */ (value);
  if (!v || typeof v !== "object" || v.version !== 1 || !Array.isArray(v.projects)) return [];
  /** @type {Stored[]} */
  const out = [];
  const seen = new Set();
  for (const p of v.projects) {
    if (!p || typeof p !== "object" || typeof p.commonDir !== "string" || !p.commonDir) continue;
    if (p.machine != null && typeof p.machine !== "string") continue;
    // "" is how commands spell this Mac; the store spells it null.
    const machine = p.machine || null;
    const key = projectKey(machine, p.commonDir);
    if (seen.has(key)) continue;
    seen.add(key);
    const main = typeof p.main === "string" && p.main ? p.main : null;
    const name = typeof p.name === "string" && p.name ? p.name : nameOf(p.commonDir, main ?? guessMain(p.commonDir));
    out.push({ machine, commonDir: p.commonDir, name, main });
  }
  return out;
}

/**
 * The stored value with `adds` appended, skipping keys already there.
 *
 * @param {unknown} value
 * @param {Stored[]} adds
 * @returns {{ version: 1, projects: Stored[] }}
 */
export function rememberProjects(value, adds) {
  const projects = readStored(value);
  const seen = new Set(projects.map((p) => projectKey(p.machine, p.commonDir)));
  for (const p of readStored({ version: 1, projects: adds })) {
    const key = projectKey(p.machine, p.commonDir);
    if (!seen.has(key)) {
      seen.add(key);
      projects.push(p);
    }
  }
  return { version: 1, projects };
}

/**
 * The stored value without the project whose projectKey is `key`.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {{ version: 1, projects: Stored[] }}
 */
export function forgetProject(value, key) {
  return { version: 1, projects: readStored(value).filter((p) => projectKey(p.machine, p.commonDir) !== key) };
}

/**
 * @param {Record<string, AgentCount>} counts @param {string} address @param {"subagents" | "requests"} key
 * @returns {number} the count, or 0 when it is missing or not a whole number at least 0
 */
function countOf(counts, address, key) {
  const v = counts[address]?.[key];
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Agent lines in agents() order. A sub-agent (its terminal has a `parent`) is counted on its nearest
 * ancestor that has a line, and gets a line itself only when no ancestor has one.
 *
 * @param {any[]} spaces
 * @param {any[]} agents
 * @param {any[]} terminals
 * @param {Record<string, AgentCount>} counts
 * @returns {AgentLine[]}
 */
function agentLines(spaces, agents, terminals, counts) {
  const terms = new Map(terminals.map((t) => [t.address, t]));
  // A bare parent names a terminal on the child's machine.
  const parentOf = (/** @type {string} */ address) => {
    const parent = terms.get(address)?.parent;
    if (typeof parent !== "string" || !parent) return null;
    const slash = address.indexOf("/");
    return parent.includes("/") || slash < 0 ? parent : address.slice(0, slash + 1) + parent;
  };
  const lined = new Set(agents.filter((a) => !parentOf(a.address)).map((a) => a.address));
  const ancestorLine = (/** @type {string} */ address) => {
    let p = parentOf(address);
    // Bounded: a malformed parent cycle must not hang render.
    for (let depth = 0; p && depth < 64; depth++) {
      if (lined.has(p)) return p;
      p = parentOf(p);
    }
    return null;
  };
  for (const a of agents) if (!lined.has(a.address) && !ancestorLine(a.address)) lined.add(a.address);

  const subagents = new Map();
  for (const t of terminals) {
    if (!parentOf(t.address) || lined.has(t.address) || (t.state ?? "live") !== "live") continue;
    const root = ancestorLine(t.address);
    if (root) subagents.set(root, (subagents.get(root) ?? 0) + 1);
  }

  const tabs = new Map(spaces.flatMap((s) => (s.tabs ?? []).map((t) => [t.id, t])));
  return agents
    .filter((a) => lined.has(a.address))
    .map((a) => {
      const tab = tabs.get(a.tab);
      return {
        address: a.address,
        space: a.space,
        tab: a.tab,
        title: tab?.named ? a.tab_name : a.title,
        status: a.status,
        program: a.program,
        subagents: (subagents.get(a.address) ?? 0) + countOf(counts, a.address, "subagents"),
        requests: countOf(counts, a.address, "requests"),
        changedAt: tab?.changed_at ?? null,
      };
    });
}

/**
 * Machines, each with its projects (every worktree, agent lines under the worktree holding their space)
 * and the spaces outside Git; plus the agent order as drawn and the open projects not yet stored.
 *
 * @param {ModelInput} input
 * @returns {ProjectTree}
 */
export function buildProjects(input) {
  const machines = input.machines ?? [];
  const spaces = input.spaces ?? [];
  const panes = input.panes ?? [];
  const stored = input.stored ?? [];
  const git = { places: {}, worktrees: {}, counts: {}, unreachable: [], ...input.git };
  const unreachable = new Set(git.unreachable.map((u) => u || null));
  const layouts = new Map(machines.map((m) => [m.name ?? null, m.layout]));

  /** @type {Map<string | null, MachineNode>} */
  const nodes = new Map();
  const addMachine = (/** @type {string | null} */ name, /** @type {MachineNode["state"]} */ fallback) => {
    if (nodes.has(name)) return;
    const layout = layouts.get(name);
    /** @type {MachineNode["state"]} */
    let state =
      layout === undefined ? fallback : layout === "ready" ? "ready" : layout === "loading" ? "loading" : "offline";
    if (unreachable.has(name) && state !== "not_connected") state = "offline";
    const label = name !== null ? name : input.platform === "macos" ? "This Mac" : "This computer";
    nodes.set(name, { name, label, state, projects: [], plain: [] });
  };
  addMachine(null, "ready");
  for (const m of machines) addMachine(m.name ?? null, "ready");
  for (const s of spaces) addMachine(s.machine ?? null, "loading");
  for (const name of [...new Set(stored.map((p) => p.machine))].sort((a, b) => cmp(a ?? "", b ?? "")))
    addMachine(name, "not_connected");

  const lines = agentLines(spaces, input.agents ?? [], input.terminals ?? [], input.counts ?? {});

  /** @type {Map<string, { machine: string | null, commonDir: string, stored: Stored | null, attach: { space: any, top: string }[] }>} */
  const found = new Map();
  const project = (/** @type {string | null} */ machine, /** @type {string} */ commonDir) => {
    const key = projectKey(machine, commonDir);
    if (!found.has(key)) found.set(key, { machine, commonDir, stored: null, attach: [] });
    return /** @type {NonNullable<ReturnType<typeof found.get>>} */ (found.get(key));
  };
  for (const p of stored) project(p.machine, p.commonDir).stored = p;
  for (const space of spaces) {
    const machine = space.machine ?? null;
    const place = git.places[placeKey(machine, placeOf(space, panes))];
    if (place && place !== "not_git") {
      project(machine, place.commonDir).attach.push({ space, top: place.top });
      continue;
    }
    // A place not read yet shows here too, so its agents stay reachable until Git answers.
    /** @type {MachineNode} */ (nodes.get(machine)).plain.push({
      id: space.id,
      name: space.name,
      active: Boolean(space.active),
      status: space.status ?? null,
      agents: lines.filter((l) => l.space === space.id),
    });
  }

  /** @type {Stored[]} */
  const remember = [];
  for (const [key, f] of found) {
    const node = /** @type {MachineNode} */ (nodes.get(f.machine));
    const offline = node.state === "offline";
    const entry = git.worktrees[key];
    const list = entry?.list ?? null;
    const main = list?.length ? (list[0].bare ? null : list[0].path) : (f.stored?.main ?? guessMain(f.commonDir));

    /** @type {(w: Worktree, isMain: boolean) => WorktreeNode} */
    const row = (w, isMain) => {
      const wkey = worktreeKey(f.machine, w.path);
      const c = git.counts[wkey];
      let counts = null;
      if (c) {
        const { stale: _stale, ...rest } = c;
        counts = rest;
      }
      return {
        key: wkey,
        path: w.path,
        branch: w.branch,
        detached: Boolean(w.detached),
        prunable: Boolean(w.prunable),
        main: isMain,
        open: false,
        spaces: [],
        counts,
        stale: offline || Boolean(entry?.stale) || Boolean(c?.stale),
        status: null,
        agents: [],
      };
    };
    const rows = (list ?? []).flatMap((w, i) => (w.bare ? [] : [row(w, i === 0)]));

    for (const { space, top } of f.attach) {
      const t = trim(top);
      let hit = rows.find((r) => trim(r.path) === t);
      if (!hit) {
        let best = -1;
        for (const r of rows) {
          const p = trim(r.path);
          if (t.startsWith(p === "/" ? "/" : `${p}/`) && p.length > best) {
            hit = r;
            best = p.length;
          }
        }
      }
      if (!hit) {
        // The list predates this worktree or is not read yet.
        hit = row(
          {
            path: t,
            head: null,
            branch: space.branch ?? null,
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
          },
          main !== null && trim(main) === t,
        );
        rows.push(hit);
      }
      hit.spaces.push(space.id);
      hit.open = true;
    }

    for (const r of rows) {
      r.agents = lines.filter((l) => r.spaces.includes(l.space));
      r.status = worst(r.agents.map((a) => a.status));
    }
    rows.sort(
      (a, b) =>
        Number(b.main) - Number(a.main) ||
        Number(a.branch === null) - Number(b.branch === null) ||
        cmp(a.branch ?? a.path, b.branch ?? b.path) ||
        cmp(a.path, b.path),
    );

    const name = main ? baseName(main) : f.stored?.name || nameOf(f.commonDir, null);
    const open = rows.some((r) => r.open);
    node.projects.push({
      key,
      machine: f.machine,
      commonDir: f.commonDir,
      name,
      letter: letterOf(name),
      main,
      open,
      status: worst(rows.map((r) => r.status)),
      checked: Boolean(list),
      worktrees: rows,
    });
    if (open && !f.stored) remember.push({ machine: f.machine, commonDir: f.commonDir, name, main });
  }

  const out = [...nodes.values()];
  for (const m of out) m.projects.sort((a, b) => cmp(a.name, b.name) || cmp(a.commonDir, b.commonDir));
  const agentOrder = out.flatMap((m) => [
    ...m.projects.flatMap((p) => p.worktrees.flatMap((w) => w.agents.map((a) => a.address))),
    ...m.plain.flatMap((s) => s.agents.map((a) => a.address)),
  ]);
  return { machines: out, agentOrder, remember };
}

/**
 * Where `bw counts` runs: each ready machine with agent lines, and those lines' addresses on that machine
 * (`macmini/t5` is `t5` there). None for a machine that is loading, offline or not connected.
 *
 * @param {ProjectTree} tree
 * @returns {CountTarget[]}
 */
export function countTargets(tree) {
  /** @type {CountTarget[]} */
  const out = [];
  for (const m of tree.machines) {
    if (m.state !== "ready") continue;
    const lines = [
      ...m.projects.flatMap((p) => p.worktrees.flatMap((w) => w.agents)),
      ...m.plain.flatMap((s) => s.agents),
    ];
    const prefix = m.name === null ? "" : `${m.name}/`;
    const terminals = [];
    for (const { address } of lines) {
      const local = address.startsWith(prefix) ? address.slice(prefix.length) : address;
      if (local && !local.includes("/") && !terminals.some((t) => t.address === address))
        terminals.push({ address, local });
    }
    if (terminals.length) out.push({ machine: m.name, terminals });
  }
  return out;
}

/**
 * What to read from Git now: unread places, each project's worktree list, each worktree's counts,
 * and the helper check per ready remote machine. Nothing for a machine Herdr reports unavailable or
 * has never connected; a machine offline only because an exec rejected keeps its reads so a success
 * can bring it back.
 *
 * @param {ProjectTree} tree
 * @param {ModelInput} input
 * @param {string | null} activeSpaceId
 * @returns {Target[]}
 */
export function refreshTargets(tree, input, activeSpaceId) {
  const layouts = new Map((input.machines ?? []).map((m) => [m.name ?? null, m.layout]));
  const callable = new Set(
    tree.machines
      .filter((m) => m.state !== "not_connected" && layouts.get(m.name) !== "unavailable")
      .map((m) => m.name),
  );
  const places = input.git?.places ?? {};
  /** @type {Target[]} */
  const targets = [];
  /** @type {(kind: Target["kind"], machine: string | null, path: string, open: boolean, selected: boolean, wakeOn: string[]) => void} */
  const add = (kind, machine, path, open, selected, wakeOn) =>
    targets.push({
      key: JSON.stringify([kind, machine, path]),
      kind,
      machine,
      path,
      open,
      selected,
      wakeOn: machine === null ? wakeOn : [],
    });

  const asked = new Set();
  for (const space of input.spaces ?? []) {
    const machine = space.machine ?? null;
    if (!callable.has(machine)) continue;
    const folder = placeOf(space, input.panes ?? []);
    const key = placeKey(machine, folder);
    if (places[key] !== undefined || asked.has(key)) continue;
    asked.add(key);
    add("place", machine, folder, true, false, []);
  }
  for (const m of tree.machines) {
    if (!callable.has(m.name)) continue;
    for (const p of m.projects) {
      add("list", m.name, p.commonDir, p.open, false, [p.commonDir]);
      for (const w of p.worktrees) {
        if (w.prunable) continue;
        add(
          "counts",
          m.name,
          w.path,
          w.open,
          activeSpaceId !== null && w.spaces.includes(activeSpaceId),
          w.open ? [w.path, p.commonDir] : [p.commonDir],
        );
      }
    }
  }
  for (const m of tree.machines)
    if (m.name !== null && m.state === "ready") add("helper", m.name, "", false, false, []);
  return targets;
}
