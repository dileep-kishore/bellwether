// What the tab bar draws for each tab, where a dragged tab lands, and the window's Needs you count.
// Pure, so tests run it.

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
    // A mod pane (a chat) has no program, so a chat tab takes its terminal pane's.
    const program = own.find((p) => p.program?.agent)?.program ?? own.find((p) => p.program)?.program ?? null;
    // An unnamed tab's `name` is only its position, which says nothing a person can use.
    const title = tab.named ? tab.name : (program?.name ?? "Terminal");
    return {
      id: tab.id,
      index: tab.index,
      title,
      program,
      status: tab.status ?? null,
      active: Boolean(tab.active),
      settled: Boolean(tab.settled),
    };
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

/**
 * Counts blocked agents and PRs needing attention across all live spaces.
 * @param {any[]} agents AgentInfo[]
 * @param {any[]} panes PaneInfo[]
 * @param {any[]} spaces SpaceInfo[]
 * @param {unknown} prSummary `shared("bw.pr-summary")`
 * @returns {number}
 */
export function needsCount(agents, panes, spaces, prSummary = null) {
  const blocked = new Set();
  for (const a of agents ?? []) {
    if (a?.status === "blocked" && typeof a.address === "string" && a.address) blocked.add(a.address);
  }
  for (const p of panes ?? []) {
    if (!p?.mod && p?.status === "blocked" && typeof p.terminal === "string" && p.terminal) blocked.add(p.terminal);
  }
  let prAttention = 0;
  if (prSummary && typeof prSummary === "object" && !Array.isArray(prSummary)) {
    const map = /** @type {Record<string, any>} */ (prSummary);
    for (const sp of spaces ?? []) {
      const pr = map[sp?.id];
      if (!pr || typeof pr !== "object") continue;
      if (
        pr.attention === true ||
        (Number(pr.failing) || 0) > 0 ||
        (Number(pr.unresolvedThreads) || 0) > 0 ||
        pr.reviewDecision === "CHANGES_REQUESTED"
      ) {
        prAttention += 1;
      }
    }
  }
  return blocked.size + prAttention;
}
