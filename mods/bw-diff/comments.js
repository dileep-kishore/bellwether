// Line-anchored diff review comments: per-worktree draft state, +-5 line anchor relocation when a file's
// patchDigest changes, multi-file preflight verification before delivery, and structured markdown formatting.
// Adapted in workflow shape from Cockpit (quaresc/cockpit, MIT, commit 7ae5aa6; see THIRD_PARTY_NOTICES.md).
// Pure and Herdr-free so unit tests exercise relocation and preflight directly.

/** @typedef {import("./model.js").Mode} Mode */
/** @typedef {import("./model.js").PatchRow} PatchRow */
/** @typedef {import("./model.js").Section} Section */
/** @typedef {import("./model.js").Selection} Selection */

export const RELOCATE_WINDOW = 5;

/**
 * @typedef {object} CommentAnchor
 * @property {string} path
 * @property {Section} section
 * @property {string | null} oldPath
 * @property {boolean} untracked
 * @property {string | null} base
 * @property {Mode} mode
 * @property {string | null} from
 * @property {string | null} to
 * @property {"new" | "old"} side
 * @property {number} line
 * @property {string} excerpt
 * @property {string} patchDigest
 */

/**
 * @typedef {CommentAnchor & { id: string, body: string, stale: boolean }} DraftComment
 */

/**
 * Builds an anchor from a clicked unified-diff code row (`add`, `del`, or `ctx`), or `null` for non-code rows.
 * @param {Selection} sel
 * @param {{ base: string | null, mode: Mode, from: string | null, to: string | null }} rangeInfo
 * @param {PatchRow | null | undefined} row
 * @param {string | null | undefined} patchDigest
 * @returns {CommentAnchor | null}
 */
export function anchorFromRow(sel, rangeInfo, row, patchDigest) {
  if (!row || typeof patchDigest !== "string" || !patchDigest) return null;
  if (row.kind !== "add" && row.kind !== "del" && row.kind !== "ctx") return null;
  const side = row.kind === "del" ? "old" : "new";
  const line = side === "old" ? row.old : row.new;
  if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) return null;
  return {
    path: sel.path,
    section: sel.section,
    oldPath: sel.oldPath,
    untracked: sel.untracked,
    base: sel.section === "committed" ? (rangeInfo.base ?? null) : null,
    mode: rangeInfo.mode ?? "merge-base",
    from: sel.section === "committed" ? (rangeInfo.from ?? null) : null,
    to: sel.section === "committed" ? (rangeInfo.to ?? null) : null,
    side,
    line,
    excerpt: row.text,
    patchDigest,
  };
}

/**
 * Distinct `{ section, path, base, mode }` identity for grouping comments by file diff target.
 * @param {Pick<CommentAnchor, "section" | "path" | "base" | "mode">} c
 * @returns {string}
 */
export function commentTargetKey(c) {
  return JSON.stringify([
    c.section,
    c.path,
    c.section === "committed" ? (c.base ?? null) : null,
    c.section === "committed" ? c.mode : "merge-base",
  ]);
}

/**
 * Identity of a specific line anchor within a target.
 * @param {Pick<CommentAnchor, "section" | "path" | "base" | "mode" | "side" | "line">} c
 * @returns {string}
 */
export function commentLineKey(c) {
  return `${commentTargetKey(c)}:${c.side}:${c.line}`;
}

/**
 * Finds an existing draft comment matching `anchor`'s file, section, base, side, and line.
 * @param {DraftComment[]} list
 * @param {CommentAnchor | null} anchor
 * @returns {DraftComment | null}
 */
export function findCommentAtAnchor(list, anchor) {
  if (!anchor) return null;
  const want = commentLineKey(anchor);
  return list.find((c) => commentLineKey(c) === want) ?? null;
}

/**
 * Inserts or updates a draft comment for `anchor`, clearing `stale` on save.
 * @param {DraftComment[]} list
 * @param {CommentAnchor} anchor
 * @param {string} rawBody
 * @param {number} [seq]
 * @returns {DraftComment[]}
 */
export function upsertComment(list, anchor, rawBody, seq = 0) {
  const body = String(rawBody ?? "").trim();
  if (!body) return list;
  const want = commentLineKey(anchor);
  let hit = false;
  const next = list.map((c) => {
    if (commentLineKey(c) !== want) return c;
    hit = true;
    return {
      ...c,
      ...anchor,
      body,
      stale: false,
    };
  });
  if (hit) return next;
  const id = `dc-${seq || next.length + 1}-${anchor.section}-${anchor.path}-${anchor.side}-${anchor.line}`;
  return [...next, { ...anchor, id, body, stale: false }];
}

/**
 * Removes one draft comment by `id`.
 * @param {DraftComment[]} list
 * @param {string} id
 * @returns {DraftComment[]}
 */
export function removeComment(list, id) {
  return list.filter((c) => c.id !== id);
}

/**
 * Candidate code rows on `side` (`"new"` or `"old"`).
 * @param {PatchRow[]} rows
 * @param {"new" | "old"} side
 * @returns {{ line: number, text: string }[]}
 */
function candidatesOnSide(rows, side) {
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  for (const r of rows) {
    if (side === "new" && (r.kind === "add" || r.kind === "ctx") && typeof r.new === "number") {
      out.push({ line: r.new, text: r.text });
    } else if (side === "old" && (r.kind === "del" || r.kind === "ctx") && typeof r.old === "number") {
      out.push({ line: r.old, text: r.text });
    }
  }
  return out;
}

/**
 * Re-verifies a single comment against a refreshed patch (`rows`, `newDigest`).
 * If `newDigest === comment.patchDigest`, returns `comment` unchanged.
 * Otherwise checks exact `line` first, then a unique `excerpt` match within `+-5` lines (updating `line`),
 * marking `stale: true` if neither holds. When `complete` is false (partial multi-page load) and loaded rows
 * have not yet reached `comment.line + 5`, defers judgment until remaining pages or preflight load.
 *
 * @param {DraftComment} comment
 * @param {PatchRow[]} rows
 * @param {string} newDigest
 * @param {{ complete?: boolean }} [opts]
 * @returns {DraftComment}
 */
export function revalidateComment(comment, rows, newDigest, opts = {}) {
  if (!newDigest || newDigest === comment.patchDigest) return comment;
  const complete = opts.complete !== false;
  const candidates = candidatesOnSide(rows, comment.side);
  const maxLoaded = candidates.reduce((m, c) => Math.max(m, c.line), 0);

  const exact = candidates.find((c) => c.line === comment.line && c.text === comment.excerpt);
  if (exact) {
    return { ...comment, patchDigest: newDigest, stale: false };
  }

  if (!complete && maxLoaded < comment.line + RELOCATE_WINDOW) {
    return comment;
  }

  const near = candidates.filter(
    (c) => Math.abs(c.line - comment.line) <= RELOCATE_WINDOW && c.text === comment.excerpt,
  );
  if (near.length === 1) {
    return { ...comment, line: near[0].line, patchDigest: newDigest, stale: false };
  }

  return { ...comment, patchDigest: newDigest, stale: true };
}

/**
 * Revalidates all comments belonging to `targetKey` when its patch refreshes.
 * @param {DraftComment[]} list
 * @param {string} targetKey
 * @param {PatchRow[]} rows
 * @param {string} newDigest
 * @param {{ complete?: boolean }} [opts]
 * @returns {{ next: DraftComment[], newlyStale: DraftComment[] }}
 */
export function revalidateTargetComments(list, targetKey, rows, newDigest, opts = {}) {
  /** @type {DraftComment[]} */
  const newlyStale = [];
  const next = list.map((c) => {
    if (commentTargetKey(c) !== targetKey) return c;
    const updated = revalidateComment(c, rows, newDigest, opts);
    if (!c.stale && updated.stale) newlyStale.push(updated);
    return updated;
  });
  return { next, newlyStale };
}

/**
 * Formats verified diff comments into a structured markdown review block (`path:line (side)`, quoted excerpt, body).
 * @param {DraftComment[]} comments
 * @returns {string}
 */
export function formatReviewBlock(comments) {
  const valid = comments.filter((c) => !c.stale);
  if (valid.length === 0) return "";
  const heading = valid.length === 1 ? "Diff review comment:" : `Diff review comments (${valid.length}):`;
  const blocks = valid.map((c, i) => {
    const quoted = c.excerpt === "" ? "> " : `> ${c.excerpt}`;
    return `${i + 1}. \`${c.path}:${c.line}\` (${c.side})\n${quoted}\n${c.body}`;
  });
  return `${heading}\n\n${blocks.join("\n\n")}`;
}

/**
 * @typedef {{ ok: true, digest: string, rows: PatchRow[] }
 *   | { ok: false, missing?: boolean, error: string }} PreflightPatchResult
 */

/**
 * Runs preflight verification across every distinct commented `{ path, section, base }` (including files no
 * longer selected in the viewer). Aborts delivery if any comment fails verification or is `stale: true`.
 *
 * @param {DraftComment[]} comments
 * @param {(sample: DraftComment) => Promise<PreflightPatchResult>} fetchPatch
 * @returns {Promise<
 *   | { ok: true, next: DraftComment[], staleComments: DraftComment[], newlyStale: DraftComment[], markdown: string }
 *   | { ok: false, next: DraftComment[], staleComments: DraftComment[], newlyStale: DraftComment[], message: string }
 * >}
 */
export async function preflightVerifyComments(comments, fetchPatch) {
  if (comments.length === 0) {
    return { ok: false, next: [], staleComments: [], newlyStale: [], message: "No review comments to send." };
  }

  /** @type {Map<string, DraftComment>} */
  const targets = new Map();
  for (const c of comments) {
    const k = commentTargetKey(c);
    if (!targets.has(k)) targets.set(k, c);
  }

  let next = [...comments];
  /** @type {DraftComment[]} */
  const newlyStale = [];

  for (const [targetKey, sample] of targets.entries()) {
    const res = await fetchPatch(sample);
    if (res.ok === false) {
      if (res.missing) {
        next = next.map((c) => {
          if (commentTargetKey(c) !== targetKey) return c;
          const marked = { ...c, stale: true };
          if (!c.stale) newlyStale.push(marked);
          return marked;
        });
        continue;
      }
      return {
        ok: false,
        next,
        staleComments: next.filter((c) => c.stale),
        newlyStale,
        message: `Could not verify ${sample.path}: ${res.error}`,
      };
    }
    const check = revalidateTargetComments(next, targetKey, res.rows, res.digest, { complete: true });
    next = check.next;
    newlyStale.push(...check.newlyStale);
  }

  const staleComments = next.filter((c) => c.stale);
  if (staleComments.length > 0) {
    const names = [...new Set(staleComments.map((c) => `${c.path}:${c.line}`))].slice(0, 3).join(", ");
    const suffix = staleComments.length > 3 ? "…" : "";
    const prefix =
      staleComments.length === 1
        ? `Stale diff anchor (${names})`
        : `${staleComments.length} stale diff anchors (${names}${suffix})`;
    return {
      ok: false,
      next,
      staleComments,
      newlyStale,
      message: `${prefix}: update or remove stale comments before sending.`,
    };
  }

  return {
    ok: true,
    next,
    staleComments: [],
    newlyStale: [],
    markdown: formatReviewBlock(next),
  };
}
