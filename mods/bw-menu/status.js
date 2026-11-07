// Agent status ranking, as Herdr ranks a space's and a tab's status. Imports nothing, so mods copy it.

/** @typedef {"working" | "blocked" | "done" | "idle"} Status */

/** Higher is more urgent: blocked > done > working > idle. */
export const RANK = Object.freeze({ idle: 0, working: 1, done: 2, blocked: 3 });

/**
 * The most urgent status, ignoring null and words Herdr's `Status` lacks.
 *
 * @param {(Status | null | undefined)[]} statuses
 * @returns {Status | null}
 */
export function worst(statuses) {
  /** @type {Status | null} */
  let out = null;
  for (const s of statuses) {
    if (typeof s !== "string" || !Object.hasOwn(RANK, s)) continue;
    if (out === null || RANK[s] > RANK[out]) out = /** @type {Status} */ (s);
  }
  return out;
}
