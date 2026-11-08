// Short read-only Git calls through Herdr's `exec`, on the machine that holds the folder.
// Never uses exec's `cwd`, so the same argv runs through `hc exec --on <machine>`.
import { parseCounts, parsePlace, parseWorktrees, SEP } from "./git-parse.js";

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

/** Takes the folder as $1; prints status, then SEP, then numstat. Exit 3: the folder is gone. */
export const COUNTS_SCRIPT = [
  'cd "$1" || exit 3',
  "git --no-optional-locks -c core.fsmonitor=false status --porcelain=v2 --branch -z || exit",
  "printf '\\036'",
  // Porcelain `git diff` rewrites a stat-dirty index despite --no-optional-locks; diff-index never does.
  // An unborn HEAD makes it fail, which means zero lines, not a failed read.
  "git --no-optional-locks -c core.fsmonitor=false diff-index -M --no-textconv --no-ext-diff --numstat -z HEAD 2>/dev/null",
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
