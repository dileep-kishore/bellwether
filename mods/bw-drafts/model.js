// Pure helpers for `bw-drafts`: layout visibility, `bw drafts` NDJSON parsing, HTML staging slugs,
// 6-column `show-me-your-work` `decisions.tsv` / `.audit/*.tsv` header parsing, and plan checklists.

/** @typedef {"html" | "decisions" | "plan" | "ledger" | "markdown"} DraftKind */
/** @typedef {import("./ui.js").PillTone} PillTone */

/**
 * @typedef {object} DraftItem
 * @property {DraftKind} kind
 * @property {string} id
 * @property {string} label
 * @property {number} mtimeMs
 * @property {number} size
 * @property {string | null} fileUrl
 */

/**
 * @typedef {object} DraftGroup
 * @property {DraftKind} kind
 * @property {string} title
 * @property {DraftItem[]} items
 */

/**
 * @typedef {object} DraftRead
 * @property {string} id
 * @property {DraftKind} kind
 * @property {number} size
 * @property {boolean} truncated
 * @property {string} text
 * @property {string | null} fileUrl
 */

/**
 * @typedef {object} DecisionRow
 * @property {string} ts
 * @property {string} phase
 * @property {string} decision
 * @property {string} why
 * @property {string} evidence
 * @property {string} compactEvidence
 * @property {string} result
 * @property {PillTone} phaseTone
 * @property {PillTone} resultTone
 */

/**
 * @typedef {object} ChecklistItem
 * @property {boolean} checked
 * @property {string} text
 * @property {number} indent
 */

/**
 * @typedef {object} PlanChecklist
 * @property {number} done
 * @property {number} total
 * @property {number} percent
 * @property {ChecklistItem[]} items
 */

/** @type {readonly DraftKind[]} */
export const SECTION_ORDER = Object.freeze(["html", "decisions", "plan", "ledger", "markdown"]);

/** @type {Readonly<Record<DraftKind, string>>} */
export const SECTION_TITLE = Object.freeze({
  html: "HTML Pages",
  decisions: "Decisions & Audit",
  plan: "Plans & Tasks",
  ledger: "Review Ledgers",
  markdown: "Notes & Specs",
});

/** @param {unknown} raw @returns {DraftKind} */
export function normalizeKind(raw) {
  if (raw === "html" || raw === "decisions" || raw === "plan" || raw === "ledger" || raw === "markdown") {
    return raw;
  }
  return "markdown";
}

/**
 * Whether the right sidebar shows Drafts: `right-body` has `active === "drafts"` and no ancestor on
 * the path to it has `hidden === true`.
 * @param {unknown} layoutNode
 * @returns {boolean}
 */
export function isShown(layoutNode) {
  /** @param {any} node @param {boolean} hidden @returns {boolean | null} */
  const walk = (node, hidden) => {
    if (!node || typeof node !== "object") return null;
    const h = hidden || node.hidden === true;
    if (node.id === "right-body") return !h && node.active === "drafts";
    for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
      const r = walk(c, h);
      if (r !== null) return r;
    }
    return null;
  };
  return walk(layoutNode, false) === true;
}

/**
 * Deterministic collision-free DOM-safe slug for an entry id.
 * @param {string} id
 * @returns {string}
 */
export function domSlug(id) {
  const s = String(id || "item");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const readable = s.replace(/[^A-Za-z0-9_-]/g, "-").slice(-48);
  return `${readable}-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Parses `bw drafts list` NDJSON lines into sorted `DraftItem` entries.
 * @param {any[]} lines
 * @returns {DraftItem[]}
 */
export function parseDraftEntries(lines) {
  if (!Array.isArray(lines)) return [];
  /** @type {DraftItem[]} */
  const out = [];
  for (const l of lines) {
    if (l?.type !== "draft" || typeof l.id !== "string" || !l.id) continue;
    out.push({
      kind: normalizeKind(l.kind),
      id: l.id,
      label: typeof l.label === "string" && l.label ? l.label : l.id,
      mtimeMs: Number.isFinite(l.mtime_ms) ? Number(l.mtime_ms) : 0,
      size: Number.isFinite(l.size) && Number(l.size) >= 0 ? Number(l.size) : 0,
      fileUrl: typeof l.file_url === "string" && l.file_url ? l.file_url : null,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.label.localeCompare(b.label));
  return out;
}

/**
 * Groups `DraftItem[]` into non-empty display sections in `SECTION_ORDER`.
 * @param {DraftItem[]} items
 * @returns {DraftGroup[]}
 */
export function groupDraftEntries(items) {
  /** @type {DraftGroup[]} */
  const groups = [];
  for (const kind of SECTION_ORDER) {
    const matching = items.filter((item) => item.kind === kind);
    if (matching.length > 0) {
      groups.push({ kind, title: SECTION_TITLE[kind], items: matching });
    }
  }
  return groups;
}

/**
 * Picks the initial entry id to display in the preview pane when nothing is selected yet.
 * Prefers rich readable entries (`decisions`, `plan`, `ledger`, `markdown`) so HTML rows keep their
 * one-click `Open in Browser` action above an immediately useful document preview.
 * @param {DraftItem[]} items
 * @returns {string | null}
 */
export function defaultSelectedId(items) {
  if (items.length === 0) return null;
  const readable = items.find((i) => i.kind !== "html");
  return (readable ?? items[0]).id;
}

/**
 * Parses `bw drafts read` JSON lines.
 * @param {any[]} lines
 * @returns {DraftRead | null}
 */
export function parseDraftRead(lines) {
  if (!Array.isArray(lines)) return null;
  const line = lines.find((l) => l?.type === "draft-read");
  if (!line || typeof line.id !== "string") return null;
  return {
    id: line.id,
    kind: normalizeKind(line.kind),
    size: Number.isFinite(line.size) ? Number(line.size) : 0,
    truncated: line.truncated === true,
    text: typeof line.text === "string" ? line.text : "",
    fileUrl: typeof line.file_url === "string" && line.file_url ? line.file_url : null,
  };
}

/**
 * Parses `bw drafts stage` JSON lines.
 * @param {any[]} lines
 * @returns {{ url: string, path: string | null, bytes: number } | null}
 */
export function parseDraftStaged(lines) {
  if (!Array.isArray(lines)) return null;
  const line = lines.find((l) => l?.type === "draft-staged");
  if (!line || typeof line.url !== "string" || !line.url) return null;
  return {
    url: line.url,
    path: typeof line.path === "string" ? line.path : null,
    bytes: Number.isFinite(line.bytes) ? Number(line.bytes) : 0,
  };
}

/**
 * Builds a `[A-Za-z0-9._-]+.html` stage file name matching `validate_stage_name` in `crates/bw/src/drafts`.
 * @param {{ id: string, label?: string }} entry
 * @returns {string}
 */
export function stageSlugFor(entry) {
  const raw =
    String(entry?.id || entry?.label || "draft.html")
      .split("/")
      .filter(Boolean)
      .pop() ?? "draft.html";
  let base = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  if (/\.htm$/i.test(base)) base = `${base.slice(0, -4)}.html`;
  else if (!base.endsWith(".html")) {
    base = base.toLowerCase().endsWith(".html") ? `${base.slice(0, -5)}.html` : `${base}.html`;
  }
  let stem = base.slice(0, -5).replace(/^[.-]+/, "");
  if (!stem) stem = "draft";
  if (stem.length > 80) stem = stem.slice(0, 80);
  return `${stem}.html`;
}

/**
 * Resolves a local `file://` URL for an HTML artifact on `machine === null`.
 * @param {string | null} worktree
 * @param {DraftItem} entry
 * @returns {string | null}
 */
export function localFileUrlFor(worktree, entry) {
  if (entry.fileUrl?.startsWith("file://")) return entry.fileUrl;
  if (!worktree || !entry.id || entry.id.startsWith("ledger:")) return null;
  const cleanRoot = worktree.replace(/\/+$/, "");
  const cleanRel = entry.id.replace(/^\/+/, "");
  const full = `${cleanRoot}/${cleanRel}`;
  const encoded = full
    .split("/")
    .map((seg, idx) => (idx === 0 && seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * Compacts long file paths or command strings in a `decisions.tsv` `evidence` cell so rows fit `380 px`.
 * @param {string} raw
 * @returns {string}
 */
export function compactEvidencePath(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const shortened = trimmed.replace(/(?:file:\/\/)?(\/[A-Za-z0-9._-]+){3,}(:[0-9]+(?:-[0-9]+)?)?/g, (match) => {
    const clean = match.startsWith("file://") ? match.slice(7) : match;
    const colon = clean.indexOf(":");
    const pathPart = colon >= 0 ? clean.slice(0, colon) : clean;
    const suffix = colon >= 0 ? clean.slice(colon) : "";
    const parts = pathPart.split("/").filter(Boolean);
    if (parts.length <= 2) return clean;
    return `…/${parts.slice(-2).join("/")}${suffix}`;
  });
  if (shortened.length <= 68) return shortened;
  return `${shortened.slice(0, 65)}…`;
}

/** @param {string} phase @returns {PillTone} */
export function phaseTone(phase) {
  const p = String(phase ?? "")
    .trim()
    .toLowerCase();
  if (!p) return "machine";
  if (p.includes("review") || p.includes("gate") || p.includes("verify") || p.includes("audit")) return "accent";
  if (p.includes("build") || p.includes("impl") || p.includes("wave") || p.includes("task")) return "working";
  if (p.includes("fix") || p.includes("hold")) return "blocked";
  return "machine";
}

/** @param {string} result @returns {PillTone} */
export function resultTone(result) {
  const r = String(result ?? "")
    .trim()
    .toLowerCase();
  if (!r) return "count";
  if (
    r === "pass" ||
    r === "passed" ||
    r === "ok" ||
    r === "done" ||
    r === "fixed" ||
    r === "approved" ||
    r === "verified" ||
    r === "confirmed" ||
    r === "accepted" ||
    r.startsWith("pass ") ||
    r.startsWith("ok ")
  ) {
    return "done";
  }
  if (r === "fail" || r === "failed" || r === "error" || r === "rejected") return "failed";
  if (r === "hold" || r === "held" || r === "blocked" || r === "open" || r === "pending" || r === "warn") {
    return "blocked";
  }
  return "count";
}

/** @type {Readonly<Record<string, "ts" | "phase" | "decision" | "why" | "evidence" | "result">>} */
const HEADER_ALIASES = Object.freeze({
  ts: "ts",
  timestamp: "ts",
  time: "ts",
  date: "ts",
  phase: "phase",
  stage: "phase",
  step: "phase",
  decision: "decision",
  what: "decision",
  action: "decision",
  summary: "decision",
  title: "decision",
  why: "why",
  rationale: "why",
  reason: "why",
  notes: "why",
  evidence: "evidence",
  proof: "evidence",
  source: "evidence",
  artifact: "evidence",
  path: "evidence",
  result: "result",
  status: "result",
  outcome: "result",
  verdict: "result",
});

/**
 * Parses `show-me-your-work` 6-column `decisions.tsv` and `.audit/*.tsv` text from its header row
 * (falling back to positional `ts, phase, decision, why, evidence, result` when headerless).
 * @param {string} text
 * @returns {{ rows: DecisionRow[], hasHeader: boolean }}
 */
export function parseDecisionsTsv(text) {
  const rawLines = String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return { rows: [], hasHeader: false };

  const firstCells = rawLines[0].split("\t").map((c) => c.trim());
  /** @type {Partial<Record<"ts" | "phase" | "decision" | "why" | "evidence" | "result", number>>} */
  const colIndex = {};
  let matchedHeaders = 0;
  for (let i = 0; i < firstCells.length; i++) {
    const key = HEADER_ALIASES[firstCells[i].toLowerCase()];
    if (key && colIndex[key] === undefined) {
      colIndex[key] = i;
      matchedHeaders++;
    }
  }
  const hasHeader = matchedHeaders >= 2;
  const idx = hasHeader ? colIndex : { ts: 0, phase: 1, decision: 2, why: 3, evidence: 4, result: 5 };
  const startLine = hasHeader ? 1 : 0;

  /** @param {string[]} cells @param {"ts" | "phase" | "decision" | "why" | "evidence" | "result"} field */
  const pick = (cells, field) => {
    const pos = idx[field];
    if (pos === undefined || pos >= cells.length) return "";
    const trimmed = cells[pos].trim();
    return /^'[=+\-@]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  };

  /** @type {DecisionRow[]} */
  const rows = [];
  for (let i = startLine; i < rawLines.length; i++) {
    const cells = rawLines[i].split("\t");
    const ts = pick(cells, "ts");
    const phase = pick(cells, "phase");
    const decision = pick(cells, "decision");
    const why = pick(cells, "why");
    const evidence = pick(cells, "evidence");
    const result = pick(cells, "result");
    if (!ts && !phase && !decision && !why && !evidence && !result) continue;
    rows.push({
      ts,
      phase,
      decision: decision || "(untitled decision)",
      why,
      evidence,
      compactEvidence: compactEvidencePath(evidence),
      result,
      phaseTone: phaseTone(phase),
      resultTone: resultTone(result),
    });
  }
  return { rows, hasHeader };
}

/**
 * Extracts `- [x]` / `- [ ]` task items and completion progress from plan/task markdown, skipping
 * fenced code blocks so example snippets do not skew progress counts.
 * @param {string} text
 * @returns {PlanChecklist}
 */
export function parsePlanChecklist(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  /** @type {ChecklistItem[]} */
  const items = [];
  /** @type {string | null} */
  let fence = null;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const indent = Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
    const checked = m[2].toLowerCase() === "x";
    const cleaned = m[3].trim().replace(/\*\*(.*?)\*\*/g, "$1");
    if (!cleaned) continue;
    items.push({ checked, text: cleaned, indent });
  }

  const total = items.length;
  const done = items.filter((i) => i.checked).length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, percent, items };
}

/**
 * Compact human byte count (`840 B`, `14.2 KB`, `1.8 MB`).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compact folder leaf name for the sidecar header.
 * @param {string | null} folder
 * @returns {string}
 */
export function folderName(folder) {
  if (!folder) return "No worktree";
  const parts = folder.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.at(-1) ?? folder;
}
