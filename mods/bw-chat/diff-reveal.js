// "Open in Changes" naming one file: `shared("bw.diff.reveal")` holds { [spaceId]: { file, at } }, written by
// bw-chat and taken by bw-diff once its list for that space is read. Imports nothing, so mods copy it.

export const REVEAL = "bw.diff.reveal";

/** @typedef {{ file: string, at: number }} Reveal */

/** @param {unknown} stored @returns {Record<string, Reveal>} */
function entries(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  /** @type {Record<string, Reveal>} */
  const out = {};
  for (const [k, v] of Object.entries(stored)) {
    const r = /** @type {any} */ (v);
    if (r && typeof r.file === "string" && r.file && typeof r.at === "number") out[k] = { file: r.file, at: r.at };
  }
  return out;
}

/**
 * The stored value after a chat in `spaceId` asks Changes to show `file`; spaces no longer live are dropped.
 * @param {unknown} stored @param {string} spaceId @param {string} file @param {number} at @param {string[]} liveSpaceIds
 * @returns {Record<string, Reveal>}
 */
export function withReveal(stored, spaceId, file, at, liveSpaceIds) {
  const live = new Set(liveSpaceIds);
  const out = Object.fromEntries(Object.entries(entries(stored)).filter(([k]) => live.has(k)));
  out[spaceId] = { file, at };
  return out;
}

/** The file waiting to be shown in `spaceId`'s Changes, or null. @param {unknown} stored @param {string | null | undefined} spaceId */
export function revealFor(stored, spaceId) {
  return spaceId == null ? null : (entries(stored)[spaceId] ?? null);
}

/** The stored value once `spaceId`'s reveal was shown. @param {unknown} stored @param {string} spaceId */
export function dropReveal(stored, spaceId) {
  const out = entries(stored);
  delete out[spaceId];
  return out;
}
