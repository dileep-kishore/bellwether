// Pure fleet card model for `mods/bw-overview/`.
import { paneKind, resolveTabAgent } from "./chat-tabs.js";
import { isMergeReady, isOpenPr } from "./pr-model.js";

/** @typedef {import("./pr-model.js").PrSummary} PrSummary */
/** @typedef {import("./pr-model.js").SharedPrEntry} SharedPrEntry */

/**
 * @typedef {object} OverviewLine
 * @property {string} terminal
 * @property {string} tabId
 * @property {string} tabName
 * @property {boolean} tabActive
 * @property {"claude" | "codex" | null} kind
 * @property {boolean} isAgent
 * @property {string} label
 * @property {any} program
 * @property {"working" | "blocked" | "done" | "idle" | null} status
 */

/**
 * @typedef {object} OverviewCard
 * @property {string} spaceId
 * @property {string} name
 * @property {string} monogram
 * @property {boolean} active
 * @property {string | null} machine
 * @property {string} folder
 * @property {string | null} branch
 * @property {PrSummary | null} pr
 * @property {string | null} headOid
 * @property {{ text: string, tone: import("./ui.js").PillTone } | null} prBadge
 * @property {OverviewLine[]} lines
 * @property {OverviewLine | null} primaryLine
 * @property {string | null} fallbackTabId
 * @property {"working" | "blocked" | "done" | "idle" | null} aggregateStatus
 */

/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === "string" && v !== "";

/** @param {unknown} status @returns {"working" | "blocked" | "done" | "idle" | null} */
function normStatus(status) {
  return status === "working" || status === "blocked" || status === "done" || status === "idle" ? status : null;
}

/** @param {any} space @returns {string} */
function spaceNameOf(space) {
  if (isStr(space?.name)) return space.name;
  const folder = String(space?.folder ?? "").replace(/\/+$/, "");
  if (folder) {
    const base = folder.split("/").pop();
    if (base) return base;
  }
  return "Workspace";
}

/** @param {string} name @returns {string} */
function monogramOf(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/[-_.\s/]+/)
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  const clean = parts[0] ?? "W";
  return clean.slice(0, 2).toUpperCase();
}

/** @param {PrSummary} pr @param {string | null} headOid @returns {{ text: string, tone: import("./ui.js").PillTone }} */
function badgeOfPr(pr, headOid) {
  if ((pr.failing ?? 0) > 0) return { text: `#${pr.number} · CI failing`, tone: "failed" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: `#${pr.number} · Changes`, tone: "blocked" };
  if ((pr.unresolvedThreads ?? 0) > 0) {
    return {
      text: `#${pr.number} · ${pr.unresolvedThreads} thread${pr.unresolvedThreads === 1 ? "" : "s"}`,
      tone: "blocked",
    };
  }
  if (isMergeReady(pr, headOid)) return { text: `#${pr.number} · Ready`, tone: "done" };
  if (pr.isDraft) return { text: `#${pr.number} · Draft`, tone: "count" };
  if ((pr.pending ?? 0) > 0) return { text: `#${pr.number} · Pending`, tone: "working" };
  return { text: `#${pr.number}`, tone: "count" };
}

/** @param {OverviewLine[]} lines @returns {"working" | "blocked" | "done" | "idle" | null} */
function aggregateStatusOf(lines) {
  if (lines.some((l) => l.status === "blocked")) return "blocked";
  if (lines.some((l) => l.status === "working")) return "working";
  if (lines.some((l) => l.status === "done")) return "done";
  if (lines.length > 0) return "idle";
  return null;
}

/**
 * Computes column count from container width (`1`..`3`).
 * @param {number} width
 * @returns {number}
 */
export function columnCountFor(width) {
  if (!(width > 0) || width < 640) return 1;
  if (width < 1020) return 2;
  return 3;
}

/**
 * Builds fleet cards across all open spaces.
 * @param {{
 *   spaces: any[],
 *   panes: any[],
 *   agents: any[],
 *   prBySpace?: Record<string, SharedPrEntry | null | undefined>,
 *   chatTabs?: unknown,
 *   chatAgents?: unknown,
 * }} input
 * @returns {OverviewCard[]}
 */
export function buildOverviewCards(input) {
  const spaces = Array.isArray(input.spaces) ? input.spaces : [];
  const panes = Array.isArray(input.panes) ? input.panes : [];
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const prBySpace = input.prBySpace ?? {};

  /** @type {Map<string, any>} */
  const agentByAddr = new Map();
  for (const a of agents) {
    if (isStr(a?.address)) agentByAddr.set(a.address, a);
  }

  /** @type {OverviewCard[]} */
  const out = [];

  for (const sp of spaces) {
    if (!isStr(sp?.id)) continue;
    const name = spaceNameOf(sp);
    const tabs = Array.isArray(sp.tabs) ? sp.tabs : [];
    const tabMap = new Map(tabs.map((/** @type {any} */ tb) => [tb.id, tb]));
    const activeTab = tabs.find((/** @type {any} */ tb) => tb.active) ?? tabs[0] ?? null;

    /** @type {OverviewLine[]} */
    const lines = [];
    for (const tb of tabs) {
      const tabPanes = panes.filter((p) => p.tab === tb.id && !p.mod && isStr(p.terminal));
      for (const p of tabPanes) {
        const kind = paneKind(p);
        const aInfo = agentByAddr.get(p.terminal);
        const status = normStatus(p.status ?? aInfo?.status);
        const label =
          kind === "codex"
            ? "Codex"
            : kind === "claude"
              ? "Claude"
              : String(p.program?.name || p.program?.key || tb.name || "Terminal");
        lines.push({
          terminal: p.terminal,
          tabId: tb.id,
          tabName: String(tb.name || label),
          tabActive: Boolean(tb.active),
          kind,
          isAgent: kind === "claude" || kind === "codex",
          label,
          program: p.program ?? aInfo?.program ?? null,
          status,
        });
      }
    }

    const resolvedPrimary = activeTab ? resolveTabAgent(activeTab.id, panes, input.chatTabs, input.chatAgents) : null;
    const primaryLine =
      (resolvedPrimary ? lines.find((l) => l.terminal === resolvedPrimary.terminal) : null) ??
      lines.find((l) => l.isAgent) ??
      lines[0] ??
      null;

    const primaryPane = primaryLine
      ? panes.find((p) => p.terminal === primaryLine.terminal && tabMap.has(p.tab))
      : null;
    const branch = isStr(primaryPane?.branch) ? primaryPane.branch : isStr(sp.branch) ? sp.branch : null;
    const folder = isStr(primaryPane?.cwd) ? primaryPane.cwd : isStr(sp.folder) ? sp.folder : "";

    const prEntry = prBySpace[sp.id] ?? null;
    const openPr = prEntry && isOpenPr(prEntry) ? prEntry : null;
    const headOid = prEntry?.headOid ?? null;

    out.push({
      spaceId: sp.id,
      name,
      monogram: monogramOf(name),
      active: Boolean(sp.active),
      machine: sp.machine ?? null,
      folder,
      branch,
      pr: openPr,
      headOid,
      prBadge: openPr ? badgeOfPr(openPr, headOid) : null,
      lines,
      primaryLine,
      fallbackTabId: activeTab?.id ?? null,
      aggregateStatus: aggregateStatusOf(lines),
    });
  }

  return out;
}
