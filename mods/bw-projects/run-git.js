// Runs one refresh target and folds its result into the Git cache the project model reads.
import { readCounts, readPlace, readWorktrees } from "./git.js";
import { placeKey, projectKey, worktreeKey } from "./projects-model.js";

/** @typedef {import("./projects-model.js").Target} Target */
/** @typedef {import("./projects-model.js").GitCache} GitCache */
/** @typedef {import("./git.js").Exec} Exec */
/** @typedef {import("./helper.js").Helper} Helper */

/**
 * What a machine's heading says about its helper; absent means nothing to say.
 * @typedef {{ state: "installing" } | { state: "failed", message: string }} HelperState
 */

/**
 * @param {{ exec: Exec, helper: Helper }} deps
 * @returns {(target: Target) => Promise<any>}
 */
export function makeRun({ exec, helper }) {
  return (target) => {
    if (target.kind === "place") return readPlace(exec, target.machine, target.path);
    if (target.kind === "list") return readWorktrees(exec, target.machine, target.path);
    if (target.kind === "counts") return readCounts(exec, target.machine, target.path);
    return helper.ensure(target.machine);
  };
}

/** @param {{ stale: boolean } | undefined} entry */
function markStale(entry) {
  if (entry) entry.stale = true;
}

/**
 * Merges one result into `git` and `helpers`. A rejected exec marks its machine unreachable and
 * keeps what was read before, marked stale; any success clears the mark.
 *
 * @param {GitCache} git
 * @param {Map<string | null, HelperState>} helpers
 * @param {Target} target
 * @param {any} result
 * @returns {boolean} true when anything the sidebar draws changed
 */
export function mergeResult(git, helpers, target, result) {
  const before = JSON.stringify([git, [...helpers]]);
  const { kind, machine, path } = target;
  const ok = Boolean(result?.ok);
  const unreachable = !ok && result?.state === "unreachable";

  if (unreachable) {
    if (!git.unreachable.includes(machine)) git.unreachable.push(machine);
  } else {
    // A helper that answers at all proves the machine is reachable, as a Git read does.
    git.unreachable = git.unreachable.filter((m) => m !== machine);
  }

  if (kind === "place") {
    if (ok) git.places[placeKey(machine, path)] = result.place;
    else if (result?.state === "not_git") git.places[placeKey(machine, path)] = "not_git";
  } else if (kind === "list") {
    const key = projectKey(machine, path);
    if (ok) git.worktrees[key] = { list: result.worktrees, stale: false };
    else markStale(git.worktrees[key]);
  } else if (kind === "counts") {
    const key = worktreeKey(machine, path);
    if (ok) git.counts[key] = { ...result.counts, stale: false };
    else markStale(git.counts[key]);
  } else if (kind === "helper") {
    if (ok || unreachable) helpers.delete(machine);
    else helpers.set(machine, { state: "failed", message: String(result?.message ?? "no answer") });
  }
  return JSON.stringify([git, [...helpers]]) !== before;
}
