// Pure grouping and selection model for `mods/bw-needs/` (`Needs you`, `Ready to land`, `Working`, `Idle`).
// Herdr-free: `render()` passes snapshots of spaces, panes, agents, counts, cards, and PR summaries.
import { paneKind, resolveTabAgent } from "./chat-tabs.js";
import { titleOf } from "./dock-model.js";
import { isMergeReady, isOpenPr, prNeedsAttention } from "./pr-model.js";

/** @typedef {"claude" | "codex"} AgentKind */
/** @typedef {"needs" | "ready" | "working" | "idle"} GroupId */
/** @typedef {import("./pr-model.js").PrSummary} PrSummary */
/** @typedef {import("./pr-model.js").SharedPrEntry} SharedPrEntry */
/** @typedef {import("./dock-model.js").Request} Request */

/**
 * @typedef {object} CardsSnapshot
 * @property {boolean} loaded
 * @property {Record<string, any> | null} cards
 * @property {Record<string, any> | null} stateLine
 * @property {Request[]} requests
 */

/**
 * @typedef {object} NeedsRow
 * @property {string} id stable row key (`term:<address>` or `space:<spaceId>`)
 * @property {GroupId} group
 * @property {"request" | "terminal_blocked" | "pr_attention" | "merge_ready" | "working" | "idle"} reason
 * @property {string} spaceId
 * @property {string} spaceName
 * @property {string} monogram
 * @property {boolean} spaceActive
 * @property {string | null} machine
 * @property {string} folder
 * @property {string | null} branch
 * @property {string | null} tabId
 * @property {string} tabName
 * @property {boolean} tabActive
 * @property {string | null} paneId
 * @property {string | null} terminal full address (`machine/t` when remote)
 * @property {string | null} local machine-local terminal address
 * @property {AgentKind | null} kind
 * @property {boolean} isAgent
 * @property {string} agentLabel
 * @property {any} program
 * @property {"working" | "blocked" | "done" | "idle" | null} status
 * @property {boolean} agentBlocked
 * @property {number} answerableCount
 * @property {number} subagents
 * @property {PrSummary | null} pr
 * @property {string | null} headOid
 * @property {boolean} prAttention
 * @property {boolean} mergeReady
 * @property {string} subtitle
 */

/**
 * @typedef {object} NeedsGroup
 * @property {GroupId} id
 * @property {string} label
 * @property {NeedsRow[]} rows
 */

export const GROUP_META = Object.freeze([
  { id: /** @type {GroupId} */ ("needs"), label: "Needs you" },
  { id: /** @type {GroupId} */ ("ready"), label: "Ready to land" },
  { id: /** @type {GroupId} */ ("working"), label: "Working" },
  { id: /** @type {GroupId} */ ("idle"), label: "Idle" },
]);

/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === "string" && v !== "";

/** @param {unknown} status @returns {"working" | "blocked" | "done" | "idle" | null} */
function normStatus(status) {
  return status === "working" || status === "blocked" || status === "done" || status === "idle" ? status : null;
}

/**
 * Extracts a short workspace display name from a space record.
 * @param {any} space
 * @returns {string}
 */
export function spaceLabelOf(space) {
  if (isStr(space?.name)) return space.name;
  const folder = String(space?.folder ?? "").replace(/\/+$/, "");
  if (folder) {
    const base = folder.split("/").pop();
    if (base) return base;
  }
  return "Workspace";
}

/**
 * Computes a 1-2 uppercase letter monogram for a workspace name.
 * @param {string} name
 * @returns {string}
 */
export function monogramOf(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/[-_.\s/]+/)
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  const clean = parts[0] ?? "W";
  return clean.slice(0, 2).toUpperCase();
}

/**
 *Machine-local terminal address (`t5` from `macmini/t5`).
 * @param {string | null} machine
 * @param {string} terminal
 * @returns {string}
 */
export function localTerminalOf(machine, terminal) {
  return machine !== null && terminal.startsWith(`${machine}/`) ? terminal.slice(machine.length + 1) : terminal;
}

/** @param {AgentKind | null} kind @param {any} pane @returns {string} */
export function labelForPane(kind, pane) {
  if (kind === "codex") return "Codex";
  if (kind === "claude") return "Claude";
  if (isStr(pane?.program?.name)) return pane.program.name;
  if (isStr(pane?.program?.key)) return pane.program.key;
  if (isStr(pane?.title)) return pane.title;
  return "Terminal";
}

/**
 * Short human summary explaining why a PR needs attention.
 * @param {PrSummary} pr
 * @returns {string}
 */
export function prReasonText(pr) {
  if ((pr.failing ?? 0) > 0) {
    return `PR #${pr.number} · ${pr.failing} failing check${pr.failing === 1 ? "" : "s"}`;
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return `PR #${pr.number} · Changes requested`;
  }
  if ((pr.unresolvedThreads ?? 0) > 0) {
    return `PR #${pr.number} · ${pr.unresolvedThreads} review thread${pr.unresolvedThreads === 1 ? "" : "s"}`;
  }
  if (pr.isDraft) {
    return `PR #${pr.number} · Draft`;
  }
  if ((pr.pending ?? 0) > 0) {
    return `PR #${pr.number} · ${pr.pending} check${pr.pending === 1 ? "" : "s"} pending`;
  }
  return `PR #${pr.number}`;
}

/**
 * Builds grouped rows and resolves the active selection for `bw-needs`.
 * @param {{
 *   spaces: any[],
 *   panes: any[],
 *   agents: any[],
 *   counts?: Record<string, { subagents?: number, requests?: number }>,
 *   cardsByTerminal?: Map<string, CardsSnapshot>,
 *   prBySpace?: Record<string, SharedPrEntry | null | undefined>,
 *   chatTabs?: unknown,
 *   chatAgents?: unknown,
 *   selectedId?: string | null,
 * }} input
 * @returns {{ groups: NeedsGroup[], rows: NeedsRow[], selected: NeedsRow | null }}
 */
export function buildNeedsModel(input) {
  const spaces = Array.isArray(input.spaces) ? input.spaces : [];
  const panes = Array.isArray(input.panes) ? input.panes : [];
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const counts = input.counts ?? {};
  const cardsByTerminal = input.cardsByTerminal ?? new Map();
  const prBySpace = input.prBySpace ?? {};

  /** @type {Map<string, any>} */
  const agentByAddr = new Map();
  for (const a of agents) {
    if (isStr(a?.address)) agentByAddr.set(a.address, a);
  }

  /** @type {NeedsRow[]} */
  const rows = [];

  for (const space of spaces) {
    if (!isStr(space?.id)) continue;
    const spaceId = space.id;
    const spaceName = spaceLabelOf(space);
    const monogram = monogramOf(spaceName);
    const machine = space.machine ?? null;
    const spaceFolder = isStr(space.folder) ? space.folder : "";
    const spaceBranch = isStr(space.branch) ? space.branch : null;
    const tabs = Array.isArray(space.tabs) ? space.tabs : [];
    const tabMap = new Map(tabs.map((/** @type {any} */ t) => [t.id, t]));
    const activeTab = tabs.find((/** @type {any} */ t) => t.active) ?? tabs[0] ?? null;

    const prEntry = prBySpace[spaceId] ?? null;
    const openPr = prEntry && isOpenPr(prEntry) ? prEntry : null;
    const headOid = prEntry?.headOid ?? null;

    const spacePanes = panes.filter((p) => !p.mod && isStr(p.terminal) && tabMap.has(p.tab));
    const candidatePanes = spacePanes.filter((p) => {
      const kind = paneKind(p);
      if (kind !== null) return true;
      const a = agentByAddr.get(p.terminal);
      const status = normStatus(p.status ?? a?.status);
      return status === "blocked";
    });

    const primaryAgentTerminal =
      (activeTab ? resolveTabAgent(activeTab.id, panes, input.chatTabs, input.chatAgents)?.terminal : null) ??
      candidatePanes.find((p) => paneKind(p) !== null)?.terminal ??
      candidatePanes[0]?.terminal ??
      null;

    const spaceBusy = spacePanes.some((p) => {
      const a = agentByAddr.get(p.terminal);
      const st = normStatus(p.status ?? a?.status);
      const cReq = Number(counts[p.terminal]?.requests) || 0;
      const pending = (cardsByTerminal.get(p.terminal)?.requests ?? []).some(
        (/** @type {Request} */ r) => r.state === "pending",
      );
      return st === "working" || st === "blocked" || cReq > 0 || pending;
    });

    if (candidatePanes.length === 0) {
      if (openPr && (prNeedsAttention(openPr) || isMergeReady(openPr, headOid))) {
        const fallbackPane = spacePanes[0] ?? null;
        const fallbackTab = (fallbackPane ? tabMap.get(fallbackPane.tab) : null) ?? activeTab;
        const prAttn = prNeedsAttention(openPr);
        const ready = !prAttn && !spaceBusy && isMergeReady(openPr, headOid);
        /** @type {GroupId} */
        const group = prAttn ? "needs" : ready ? "ready" : "idle";
        rows.push({
          id: `space:${spaceId}`,
          group,
          reason: prAttn ? "pr_attention" : ready ? "merge_ready" : "idle",
          spaceId,
          spaceName,
          monogram,
          spaceActive: Boolean(space.active),
          machine,
          folder: spaceFolder,
          branch: spaceBranch,
          tabId: fallbackTab?.id ?? null,
          tabName: String(fallbackTab?.name || spaceName),
          tabActive: Boolean(fallbackTab?.active),
          paneId: fallbackPane ? String(fallbackPane.pane ?? "") : null,
          terminal: fallbackPane?.terminal ?? null,
          local: fallbackPane?.terminal ? localTerminalOf(machine, fallbackPane.terminal) : null,
          kind: null,
          isAgent: false,
          agentLabel: "Workspace",
          program: fallbackPane?.program ?? null,
          status: null,
          agentBlocked: false,
          answerableCount: 0,
          subagents: 0,
          pr: openPr,
          headOid,
          prAttention: prAttn,
          mergeReady: ready,
          subtitle: prAttn ? prReasonText(openPr) : `PR #${openPr.number} ready to land`,
        });
      }
      continue;
    }

    for (const p of candidatePanes) {
      const tab = tabMap.get(p.tab);
      const kind = paneKind(p);
      const isAgent = kind === "claude" || kind === "codex";
      const aInfo = agentByAddr.get(p.terminal);
      const status = normStatus(p.status ?? aInfo?.status);
      const agentLabel = labelForPane(kind, p);
      const cardsSnap = cardsByTerminal.get(p.terminal) ?? null;
      const pendingReqs = (cardsSnap?.requests ?? []).filter((/** @type {Request} */ r) => r.state === "pending");
      const answerableReqs = pendingReqs.filter((/** @type {Request} */ r) => r.answerable);
      const countEntry = counts[p.terminal];
      const countReqs = Number(countEntry?.requests) || 0;
      const subagents = Number(countEntry?.subagents) || 0;
      const agentBlocked = status === "blocked" || pendingReqs.length > 0 || countReqs > 0;

      const ownsPr = p.terminal === primaryAgentTerminal;
      const prAttn = ownsPr && Boolean(openPr && prNeedsAttention(openPr));
      const ready =
        ownsPr &&
        !spaceBusy &&
        (status === "idle" || status === "done" || status === null) &&
        Boolean(openPr && isMergeReady(openPr, headOid));

      /** @type {GroupId} */
      let group = "idle";
      /** @type {NeedsRow["reason"]} */
      let reason = "idle";
      let subtitle = status === "done" ? "Done" : "Idle";

      if (agentBlocked) {
        group = "needs";
        if (answerableReqs.length > 0) {
          reason = "request";
          subtitle = titleOf(answerableReqs[0], agentLabel);
        } else {
          reason = "terminal_blocked";
          subtitle = isAgent && !cardsSnap?.loaded ? "Waiting on prompt…" : "Waiting in terminal";
        }
      } else if (prAttn && openPr) {
        group = "needs";
        reason = "pr_attention";
        subtitle = prReasonText(openPr);
      } else if (ready && openPr) {
        group = "ready";
        reason = "merge_ready";
        subtitle = `PR #${openPr.number} ready to land`;
      } else if (status === "working") {
        group = "working";
        reason = "working";
        subtitle = subagents > 0 ? `Working · ${subagents} sub-agent${subagents === 1 ? "" : "s"}` : "Working";
      }

      rows.push({
        id: `term:${p.terminal}`,
        group,
        reason,
        spaceId,
        spaceName,
        monogram,
        spaceActive: Boolean(space.active),
        machine,
        folder: isStr(p.cwd) ? p.cwd : spaceFolder,
        branch: isStr(p.branch) ? p.branch : spaceBranch,
        tabId: tab?.id ?? null,
        tabName: String(tab?.name || agentLabel),
        tabActive: Boolean(tab?.active),
        paneId: String(p.pane ?? ""),
        terminal: p.terminal,
        local: localTerminalOf(machine, p.terminal),
        kind,
        isAgent,
        agentLabel,
        program: p.program ?? aInfo?.program ?? null,
        status,
        agentBlocked,
        answerableCount: answerableReqs.length,
        subagents,
        pr: prAttn || ready ? openPr : null,
        headOid,
        prAttention: prAttn,
        mergeReady: ready,
        subtitle,
      });
    }
  }

  /** @type {NeedsGroup[]} */
  const groups = GROUP_META.map((g) => ({
    id: g.id,
    label: g.label,
    rows: rows.filter((r) => r.group === g.id),
  })).filter((g) => g.rows.length > 0);

  const ordered = groups.flatMap((g) => g.rows);
  const selected = (input.selectedId ? ordered.find((r) => r.id === input.selectedId) : null) ?? ordered[0] ?? null;

  return { groups, rows: ordered, selected };
}
