// Short read-only Git calls through Herdr's `exec`, on the machine that holds the folder.
// Never uses exec's `cwd`, so the same argv runs through `hc exec --on <machine>`.
import { parseCounts, parseGithubRepo, parseHeadOid, parsePlace, parseWorktrees, SEP } from "./git-parse.js";

/** @typedef {import("./git-parse.js").Worktree} Worktree */
/** @typedef {import("./git-parse.js").Counts} Counts */

/**
 * @typedef {(cmd: string, args: string[], opts: { on: string | null }) => Promise<{ code: number, stdout: string, stderr: string }>} Exec
 * Herdr's `exec`: rejects when the machine cannot be reached.
 */

/**
 * @typedef {object} GitFailure
 * @property {false} ok
 * @property {"not_git" | "missing" | "unreachable" | "failed"} state
 * @property {string} message
 */

// Without these, status refreshes the index and fsmonitor starts a daemon: both write under .git
// and would wake the folder watch that asked for the call.
const READ_ONLY = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

/**
 * Takes the folder as $1; prints status, then SEP, then numstat. Exit 3: the folder is gone. Git's parallel
 * stat is off: on a 40,000-file checkout it spends five times the CPU of one thread at the same wall time.
 */
export const COUNTS_SCRIPT = [
  'cd "$1" || exit 3',
  "git --no-optional-locks -c core.fsmonitor=false -c core.preloadIndex=false status --porcelain=v2 --branch -z || exit",
  "printf '\\036'",
  // Porcelain `git diff` rewrites a stat-dirty index despite --no-optional-locks; diff-index never does.
  // An unborn HEAD makes it fail, which means zero lines, not a failed read.
  "git --no-optional-locks -c core.fsmonitor=false -c core.preloadIndex=false diff-index -M --no-textconv --no-ext-diff --numstat -z HEAD 2>/dev/null",
  "exit 0",
].join("\n");

/**
 * @param {Exec} exec
 * @param {string} cmd
 * @param {string[]} args
 * @param {string | null} machine
 * @returns {Promise<{ code: number, stdout: string, stderr: string } | GitFailure>}
 */
async function run(exec, cmd, args, machine) {
  try {
    return await exec(cmd, args, { on: machine });
  } catch (e) {
    return { ok: false, state: "unreachable", message: e instanceof Error ? e.message : String(e) };
  }
}

/** @param {{ code: number, stderr: string }} r */
function failure(r, state = "failed") {
  return /** @type {GitFailure} */ ({ ok: false, state, message: r.stderr.trim() || `exit ${r.code}` });
}

const notGit = (/** @type {{ stderr: string }} */ r) => /not a git repository/i.test(r.stderr);

/**
 * Finds the repository holding a folder, as Git spells its paths.
 *
 * @param {Exec} exec
 * @param {string | null} machine null for this Mac
 * @param {string} folder
 * @returns {Promise<{ ok: true, place: { commonDir: string, top: string } } | GitFailure>}
 */
export async function readPlace(exec, machine, folder) {
  const args = [
    "-C",
    folder,
    ...READ_ONLY,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
  ];
  const r = await run(exec, "git", args, machine);
  if ("ok" in r) return r;
  if (r.code !== 0) return failure(r, notGit(r) ? "not_git" : "failed");
  const place = parsePlace(r.stdout);
  return place ? { ok: true, place } : { ok: false, state: "failed", message: "rev-parse printed no place" };
}

/**
 * Lists a repository's worktrees, main checkout first.
 *
 * @param {Exec} exec
 * @param {string | null} machine
 * @param {string} commonDir
 * @returns {Promise<{ ok: true, worktrees: Worktree[] } | GitFailure>}
 */
export async function readWorktrees(exec, machine, commonDir) {
  const r = await run(
    exec,
    "git",
    ["--git-dir", commonDir, ...READ_ONLY, "worktree", "list", "--porcelain", "-z"],
    machine,
  );
  if ("ok" in r) return r;
  if (r.code !== 0) return failure(r, notGit(r) ? "not_git" : "failed");
  return { ok: true, worktrees: parseWorktrees(r.stdout) };
}

/**
 * Reads a worktree's branch, ahead and behind, changed files and line counts against HEAD.
 *
 * @param {Exec} exec
 * @param {string | null} machine
 * @param {string} path
 * @returns {Promise<{ ok: true, counts: Counts } | GitFailure>}
 */
export async function readCounts(exec, machine, path) {
  const r = await run(exec, "sh", ["-c", COUNTS_SCRIPT, "sh", path], machine);
  if ("ok" in r) return r;
  if (r.code === 3) return failure(r, "missing");
  if (r.code !== 0) return failure(r);
  const at = r.stdout.indexOf(SEP);
  if (at === -1) return { ok: false, state: "failed", message: "counts script printed no separator" };
  return { ok: true, counts: parseCounts(r.stdout.slice(0, at), r.stdout.slice(at + 1)) };
}

/**
 * Reads `remote.origin.url` and its parsed GitHub `"owner/repo"` (if GitHub) without touching `.git`.
 * When `origin` is unset in a valid repository, returns `{ ok: true, url: null, repo: null }`.
 *
 * @param {Exec} exec
 * @param {string | null} machine
 * @param {string} folder
 * @returns {Promise<{ ok: true, url: string | null, repo: string | null } | GitFailure>}
 */
export async function remoteOrigin(exec, machine, folder) {
  const r = await run(exec, "git", ["-C", folder, ...READ_ONLY, "config", "--get", "remote.origin.url"], machine);
  if ("ok" in r) return r;
  if (r.code === 1 && !notGit(r) && r.stderr.trim() === "") return { ok: true, url: null, repo: null };
  if (r.code !== 0) return failure(r, notGit(r) ? "not_git" : "failed");
  const url = r.stdout.trim() || null;
  return { ok: true, url, repo: parseGithubRepo(url) };
}

/**
 * Reads the worktree's `HEAD` commit OID without touching `.git`.
 * An unborn `HEAD` returns `{ ok: true, oid: null }`.
 *
 * @param {Exec} exec
 * @param {string | null} machine
 * @param {string} folder
 * @returns {Promise<{ ok: true, oid: string | null } | GitFailure>}
 */
export async function headOid(exec, machine, folder) {
  const r = await run(exec, "git", ["-C", folder, ...READ_ONLY, "rev-parse", "--verify", "HEAD"], machine);
  if ("ok" in r) return r;
  if (r.code !== 0) {
    if (notGit(r)) return failure(r, "not_git");
    if (/needed a single revision|ambiguous argument 'HEAD'/i.test(r.stderr)) return { ok: true, oid: null };
    return failure(r);
  }
  const oid = parseHeadOid(r.stdout);
  return oid ? { ok: true, oid } : { ok: false, state: "failed", message: "rev-parse printed no HEAD oid" };
}
