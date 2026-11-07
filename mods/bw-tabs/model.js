// What the tab bar draws for each tab, and where a dragged tab lands. Pure, so tests run it.

/** @typedef {import("./ui.js").Status} Status */

/**
 * @typedef {object} TabItem
 * @property {string} id
 * @property {number} index 1-based, as tab.move takes it
 * @property {string} title
 * @property {any} program Program of the tab's agent pane, else its first pane, else null
 * @property {Status | null} status
 * @property {boolean} active
 * @property {boolean} settled
 */

/**
 * @param {{ tabs?: any[] } | null | undefined} space SpaceInfo
 * @param {any[]} panes PaneInfo[]
 * @returns {TabItem[]}
 */
export function tabItems(space, panes) {
  return (space?.tabs ?? []).map((tab) => {
    const own = panes.filter((p) => p.tab === tab.id);
    const program = own.find((p) => p.program?.agent)?.program ?? own[0]?.program ?? null;
    // An unnamed tab's `name` is only its position, which says nothing a person can use.
    const title = tab.named ? tab.name : (program?.name ?? "Terminal");
    return { id: tab.id, index: tab.index, title, program, status: tab.status ?? null, active: Boolean(tab.active), settled: Boolean(tab.settled) };
  });
}

/**
 * The index tab.move takes to drop `fromId` where `overId` is, or null when there is nothing to move.
 * @param {TabItem[]} items
 * @param {string | null} fromId
 * @param {string} overId
 * @returns {number | null}
 */
export function moveIndex(items, fromId, overId) {
  if (fromId === null || fromId === overId || !items.some((i) => i.id === fromId)) return null;
  return items.find((i) => i.id === overId)?.index ?? null;
}
