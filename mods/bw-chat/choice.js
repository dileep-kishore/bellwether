// Which right-sidebar panel each space shows. `shared("bw.right.tab")` holds { [spaceId]: panelId }.

/** @typedef {"changes" | "issues" | "browser"} PanelId */
/** @typedef {{ id: PanelId, label: string, phase: number }} Panel */
/** @typedef {Record<string, PanelId>} Stored */

/** In strip order; `phase` is the plan phase that fills the panel. @type {readonly Panel[]} */
export const PANELS = Object.freeze([
  { id: "changes", label: "Changes", phase: 5 },
  { id: "issues", label: "Issues", phase: 6 },
  { id: "browser", label: "Browser", phase: 4 },
]);

/** @type {PanelId} */
const DEFAULT = "changes";

/** @param {unknown} id @returns {id is PanelId} */
const isPanel = (id) => PANELS.some((p) => p.id === id);

/** @param {unknown} stored @returns {Stored} */
function entries(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  /** @type {Stored} */
  const out = {};
  for (const [k, v] of Object.entries(stored)) if (isPanel(v)) out[k] = v;
  return out;
}

/**
 * The panel a space shows: its stored choice, else Changes.
 * @param {unknown} stored @param {string | null | undefined} spaceId @returns {PanelId}
 */
export function chosen(stored, spaceId) {
  if (spaceId == null) return DEFAULT;
  return entries(stored)[spaceId] ?? DEFAULT;
}

/**
 * The stored value after a space picks `id`; spaces no longer live are dropped. Without a space
 * nothing new is stored.
 * @param {unknown} stored @param {string | null | undefined} spaceId @param {PanelId} id
 * @param {string[]} liveSpaceIds @returns {Stored}
 */
export function choose(stored, spaceId, id, liveSpaceIds) {
  const live = new Set(liveSpaceIds);
  const out = Object.fromEntries(Object.entries(entries(stored)).filter(([k]) => live.has(k)));
  if (spaceId != null && isPanel(id)) out[spaceId] = id;
  return out;
}

/**
 * The panel to select so the layout matches the space's choice, or null when it already does.
 * Without a space the layout is left as the user set it.
 * @param {unknown} stored @param {string | null | undefined} spaceId @param {unknown} layoutActive
 * @returns {PanelId | null}
 */
export function wanted(stored, spaceId, layoutActive) {
  if (spaceId == null) return null;
  const id = chosen(stored, spaceId);
  return id === layoutActive ? null : id;
}
