// The threads card's rows: the parent, its in-process sub-agents from `bw feed --tree`, and its terminal
// sub-agents from terminals(). Pure and Herdr-free: the mod passes the lines and terminals() rows.

/**
 * @typedef {object} TreeChild One child of a `tree` line.
 * @property {string} id
 * @property {string} parent the root session or another child's id
 * @property {number} [depth]
 * @property {string} [type]
 * @property {string | null} [nickname]
 * @property {string} [description]
 * @property {"running" | "done"} state
 * @property {number | null} [started_ms]
 * @property {number | null} [ended_ms]
 */

/** @typedef {{ type: "tree", agent: string, root: string, children: TreeChild[] }} TreeLine */

/**
 * @typedef {object} Row
 * @property {string} id
 * @property {"parent" | "child" | "terminal"} kind
 * @property {number} depth
 * @property {"running" | "done" | "asks"} state
 * @property {string} type
 * @property {string} description
 * @property {string} since how long it has run, or ran ("4m"); "" when unknown
 * @property {number} requests pending requests it asked
 * @property {{ child: string } | { terminal: string } | null} open what a click opens
 */

/**
 * @typedef {object} Root
 * @property {string} terminal the chat's terminal in this window's namespace
 * @property {string} kind
 * @property {string} name "Claude" or "Codex"
 * @property {string | null} [status] the agent's status from agents(); absent reads as running
 */

// Codex nests at most 8 deep (decision 3); a malformed tree must not hang render.
const MAX_DEPTH = 16;

/** @param {number} ms */
function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** @param {TreeChild} c @param {number} now */
function sinceOf(c, now) {
  if (typeof c.started_ms !== "number") return "";
  if (c.state === "running") return span(now - c.started_ms);
  return typeof c.ended_ms === "number" ? span(c.ended_ms - c.started_ms) : "";
}

/**
 * The children a request names: `who` is one child, a list when one box binds several, or null for the root.
 * @param {any} req @returns {string[]}
 */
export function askers(req) {
  const who = req?.who;
  const list = Array.isArray(who) ? who : who ? [who] : [];
  return list.map((w) => (typeof w?.child === "string" && w.child ? w.child : null)).filter((c) => c !== null);
}

/** @param {string | null | undefined} status @returns {Row["state"]} */
function stateOfStatus(status) {
  if (status === "blocked") return "asks";
  if (status === "working" || status == null) return "running";
  return "done";
}

/**
 * A terminal's `parent` as an address in this window's namespace: a bare parent names a terminal on
 * the child's own machine.
 * @param {any} t a terminals() row
 */
function parentAddress(t) {
  const parent = t?.parent;
  if (typeof parent !== "string" || !parent || typeof t.address !== "string") return null;
  const slash = t.address.indexOf("/");
  return parent.includes("/") || slash < 0 ? parent : t.address.slice(0, slash + 1) + parent;
}

/**
 * @param {TreeLine | null} tree the last `tree` line, or null before one came
 * @param {any[]} terminals terminals()
 * @param {any[]} requests the last `request` lines
 * @param {Root} root
 * @param {number} now
 * @returns {Row[]} the parent first, then each child under its parent in start order
 */
export function threadRows(tree, terminals, requests, root, now) {
  const rootId = tree?.root || root.terminal;
  /** @type {Map<string, number>} */
  const asks = new Map();
  let rootAsks = 0;
  for (const r of requests ?? []) {
    if (r?.state !== "pending") continue;
    const kids = askers(r);
    if (!kids.length) rootAsks++;
    for (const k of new Set(kids)) asks.set(k, (asks.get(k) ?? 0) + 1);
  }

  const children = (tree?.children ?? []).filter((c) => c && typeof c.id === "string" && c.id !== rootId);
  const ids = new Set(children.map((c) => c.id));
  /** @type {Map<string, TreeChild[]>} */
  const under = new Map();
  /** @param {TreeChild} c */
  const parentOf = (c) => (typeof c.parent === "string" && ids.has(c.parent) && c.parent !== c.id ? c.parent : rootId);
  // Stable sort: children without a start time keep the line's order after those with one.
  const byStart = children
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.started_ms ?? Infinity) - (b.c.started_ms ?? Infinity) || a.i - b.i);
  for (const { c } of byStart) {
    const p = parentOf(c);
    if (!under.has(p)) under.set(p, []);
    /** @type {TreeChild[]} */ (under.get(p)).push(c);
  }

  const parentState = rootAsks ? "asks" : stateOfStatus(root.status);
  /** @type {Row[]} */
  const rows = [
    {
      id: rootId,
      kind: "parent",
      depth: 0,
      state: parentState,
      type: root.name,
      description: "",
      since: "",
      requests: rootAsks,
      open: null,
    },
  ];
  /** @type {Set<string>} */
  const placed = new Set();
  /** @param {TreeChild} c @param {number} depth */
  const place = (c, depth) => {
    if (placed.has(c.id) || depth > MAX_DEPTH) return;
    placed.add(c.id);
    const n = asks.get(c.id) ?? 0;
    rows.push({
      id: c.id,
      kind: "child",
      depth,
      state: n ? "asks" : c.state === "running" ? "running" : "done",
      type: c.type || c.nickname || "sub-agent",
      description: c.description || c.nickname || "",
      since: sinceOf(c, now),
      requests: n,
      open: { child: c.id },
    });
    for (const k of under.get(c.id) ?? []) place(k, depth + 1);
  };
  for (const c of under.get(rootId) ?? []) place(c, 1);
  // Children in a parent cycle, or nested too deep, never hang off the root: list them at depth 1 so none is lost.
  for (const { c } of byStart) place(c, 1);

  for (const t of terminals ?? []) {
    if (parentAddress(t) !== root.terminal || (t.state ?? "live") !== "live") continue;
    const state = stateOfStatus(t.status);
    rows.push({
      id: t.address,
      kind: "terminal",
      depth: 1,
      state,
      type: t.program?.name || t.program?.key || "terminal",
      description: t.name || t.title || "",
      since: "",
      requests: state === "asks" ? 1 : 0,
      open: { terminal: t.address },
    });
  }
  return rows;
}

/** @param {Row[]} rows */
const subRows = (rows) => rows.filter((r) => r.kind !== "parent");

/**
 * The sub-agents still at work (running or asking), sorted; the user's fold holds while this set stays.
 * @param {Row[]} rows @returns {string[]}
 */
export const runningIds = (rows) =>
  subRows(rows)
    .filter((r) => r.state !== "done")
    .map((r) => r.id)
    .sort();

/** @param {Row[]} rows @returns {string} "2 sub-agents · 1 asks" */
export function pillText(rows) {
  const subs = subRows(rows);
  if (!subs.length) return "No sub-agents";
  const n = subs.filter((r) => r.state === "asks").length;
  const count = `${subs.length} sub-agent${subs.length === 1 ? "" : "s"}`;
  return n ? `${count} · ${n} asks` : count;
}

/** @param {string[]} a @param {string[]} b */
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Open while any sub-agent runs or asks, else folded; the user's toggle holds until the running set changes.
 * @param {Row[]} rows
 * @param {{ open: boolean, running: string[] } | null} toggle
 * @returns {boolean}
 */
export function cardOpen(rows, toggle) {
  const running = runningIds(rows);
  if (toggle && sameSet([...toggle.running].sort(), running)) return toggle.open;
  return running.length > 0;
}

/**
 * The toggle after the header's threads button is pressed.
 * @param {Row[]} rows @param {{ open: boolean, running: string[] } | null} toggle
 * @returns {{ open: boolean, running: string[] }}
 */
export const toggleCard = (rows, toggle) => ({ open: !cardOpen(rows, toggle), running: runningIds(rows) });

const STATE_WORDS = { running: "running", done: "done", asks: "waiting for an answer" };

/**
 * The bar that replaces the composer in a sub-agent's view, without its Back button.
 * @param {Row} row @param {string} parentName
 */
export const barText = (row, parentName) =>
  `${row.type} · sub-agent of ${parentName} · ${STATE_WORDS[row.state] ?? row.state}`;
