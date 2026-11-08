// The Issues panel's pure parts: when it is shown, which `bw linear` call a filter makes, how a list of
// issues is grouped, and how a failure reads. Imports nothing from Herdr, so `bun test` runs it.

/** @typedef {"project" | "mine" | "all"} Scope */

/**
 * @typedef {object} Issue One `linear-issue` line.
 * @property {string} identifier
 * @property {string} title
 * @property {string} url
 * @property {string | null} branch
 * @property {{ name: string, type: string, color: string | null, position: number }} state
 * @property {string | null} assignee
 * @property {boolean} mine
 * @property {{ id: string, name: string } | null} project
 * @property {{ name: string, color: string | null }[]} labels
 * @property {string} [description]
 * @property {number} [bytes]
 */

/**
 * @typedef {object} List
 * @property {Issue[]} issues
 * @property {string | null} next the cursor of the next page
 * @property {number | null} ageS how old a cached list is; null when it came from Linear just now
 */

export const POLL_MS = 60_000;
/** The state types the list shows, in this order; anything else goes last. */
const TYPE_ORDER = ["started", "unstarted", "backlog", "triage"];

/**
 * Whether the right sidebar shows Issues: the right-body stack's active child is `issues` and no node on
 * the way to it is hidden.
 * @param {unknown} layoutNode
 */
export function isShown(layoutNode) {
  /** @param {any} node @param {boolean} hidden @returns {boolean | null} */
  const walk = (node, hidden) => {
    if (!node || typeof node !== "object") return null;
    const h = hidden || node.hidden === true;
    if (node.id === "right-body") return !h && node.active === "issues";
    for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
      const r = walk(c, h);
      if (r !== null) return r;
    }
    return null;
  };
  return walk(layoutNode, false) === true;
}

/** Project when the repository is linked, Mine when not (design spec, Issues). @param {boolean} linked */
export const defaultScope = (linked) => (linked ? "project" : "mine");

/**
 * The `bw linear` arguments for a list.
 * @param {Scope} scope @param {string | null} projectId @param {string} search @param {string | null} [after]
 * @returns {string[] | null} null when Project has no linked project
 */
export function listArgs(scope, projectId, search, after = null) {
  if (scope === "project" && !projectId) return null;
  const q = search.trim();
  const args = q ? ["linear", "search", "--text", q, "--scope", scope] : ["linear", "issues", "--scope", scope];
  if (scope === "project") args.push("--project", /** @type {string} */ (projectId));
  if (after) args.push("--after", after);
  return args;
}

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");

/** @param {any} l @returns {Issue | null} */
export function readIssue(l) {
  if (l?.type !== "linear-issue" || typeof l.identifier !== "string") return null;
  return {
    identifier: l.identifier,
    title: str(l.title),
    url: str(l.url),
    branch: typeof l.branch === "string" && l.branch ? l.branch : null,
    state: {
      name: str(l.state?.name) || "No state",
      type: str(l.state?.type),
      color: typeof l.state?.color === "string" ? l.state.color : null,
      position: Number(l.state?.position) || 0,
    },
    assignee: typeof l.assignee === "string" ? l.assignee : null,
    mine: l.mine === true,
    project: l.project && typeof l.project.id === "string" ? { id: l.project.id, name: str(l.project.name) } : null,
    labels: Array.isArray(l.labels)
      ? l.labels
          .filter((/** @type {any} */ x) => typeof x?.name === "string")
          .map((/** @type {any} */ x) => ({ name: x.name, color: x.color ?? null }))
      : [],
    ...(typeof l.description === "string" ? { description: l.description, bytes: Number(l.bytes) || 0 } : {}),
  };
}

/**
 * A page of `bw linear issues` or `search` output.
 * @param {any[]} lines @returns {List}
 */
export function readList(lines) {
  const page = lines.find((l) => l?.type === "linear-page");
  return {
    issues: /** @type {Issue[]} */ (lines.map(readIssue).filter((i) => i !== null)),
    next: typeof page?.next === "string" ? page.next : null,
    ageS: page?.cached === true && Number.isFinite(page.age_s) ? Number(page.age_s) : null,
  };
}

/**
 * The issues grouped by state: started, then unstarted, backlog and triage, each state in Linear's own
 * order; the issues inside keep the list's order.
 * @param {Issue[]} issues
 * @returns {{ key: string, name: string, color: string | null, issues: Issue[] }[]}
 */
export function groupByState(issues) {
  /** @type {Map<string, { key: string, name: string, color: string | null, type: string, position: number, issues: Issue[] }>} */
  const groups = new Map();
  for (const i of issues) {
    const key = `${i.state.type}\n${i.state.name}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: i.state.name, color: i.state.color, type: i.state.type, position: i.state.position, issues: [] };
      groups.set(key, g);
    }
    g.issues.push(i);
  }
  const rank = (/** @type {string} */ t) => {
    const r = TYPE_ORDER.indexOf(t);
    return r < 0 ? TYPE_ORDER.length : r;
  };
  return [...groups.values()]
    .sort((a, b) => rank(a.type) - rank(b.type) || a.position - b.position || a.name.localeCompare(b.name))
    .map(({ key, name, color, issues: list }) => ({ key, name, color, issues: list }));
}

/** @param {Issue[]} a @param {Issue[]} b */
export const appendPage = (a, b) => {
  const seen = new Set(a.map((i) => i.identifier));
  return [...a, ...b.filter((i) => !seen.has(i.identifier))];
};

/**
 * What the panel says for a failed call. `bw` names its Linear errors by code.
 * @param {{ state: string, message: string, code?: string }} f
 */
export function failureText(f) {
  switch (f.code) {
    case "no_key":
      return "No Linear key on this Mac. Run scripts/linear-key.sh, then refresh.";
    case "key_refused":
      return "Linear refused the key. Make a new personal key and run scripts/linear-key.sh.";
    case "offline":
      return "Linear is unreachable and this list was never read before.";
    case "rate_limited":
      return "Linear's rate limit was reached; the list reloads in a minute.";
    default:
      return f.message;
  }
}

/** "3m old" for a cached list. @param {number} s */
export function ageText(s) {
  if (s < 60) return "under a minute old";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min old`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h old`;
  return `${Math.floor(h / 24)} d old`;
}

/** The repository's name, from its common dir (`…/name/.git` or `…/name.git`). @param {string} commonDir */
export function repoName(commonDir) {
  const parts = commonDir.replace(/\/+$/, "").split("/");
  const last = parts.at(-1) ?? "";
  if (last === ".git") return parts.at(-2) ?? "";
  return last.replace(/\.git$/, "");
}

/** `git config --get remote.origin.url` against a common dir, read-only. @param {string} commonDir */
export const originArgs = (commonDir) => [
  "--git-dir",
  commonDir,
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "config",
  "--get",
  "remote.origin.url",
];
