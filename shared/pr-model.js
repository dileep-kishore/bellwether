// Pure GitHub PR predicates, CLI argument builders, and shared summary helpers.
// Import-free so mods copy it directly via .shared.

/**
 * @typedef {object} PrSummary
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} state
 * @property {boolean} isDraft
 * @property {string} baseRefName
 * @property {string} headRefOid
 * @property {string | null} reviewDecision
 * @property {string | null} mergeStateStatus
 * @property {number} unresolvedThreads
 * @property {number} passing
 * @property {number} failing
 * @property {number} pending
 */

/**
 * @typedef {PrSummary & { headOid: string | null, mergeReady: boolean, attention: boolean }} SharedPrEntry
 */

/** @param {unknown} n @returns {n is number} */
const isNonNegInt = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether `pr` is an open pull request with a positive integer number.
 * @param {unknown} pr
 * @returns {pr is PrSummary}
 */
export function isOpenPr(pr) {
  return (
    isObj(pr) &&
    pr.state === "OPEN" &&
    typeof pr.number === "number" &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0
  );
}

/**
 * Whether an open PR is ready for `/merge-pr <number>`:
 * open, non-draft, zero failing or pending checks, zero unresolved review threads,
 * `headRefOid` matching local `headOid` when known, and `reviewDecision` in `["APPROVED", "", null]`.
 *
 * @param {unknown} pr
 * @param {string | null} [headOid]
 * @returns {boolean}
 */
export function isMergeReady(pr, headOid = null) {
  if (!isOpenPr(pr)) return false;
  if (pr.isDraft !== false) return false;
  if (!isNonNegInt(pr.failing) || pr.failing !== 0) return false;
  if (!isNonNegInt(pr.pending) || pr.pending !== 0) return false;
  if (!isNonNegInt(pr.unresolvedThreads) || pr.unresolvedThreads !== 0) return false;
  if (typeof headOid === "string" && headOid.trim() !== "") {
    if (typeof pr.headRefOid !== "string" || pr.headRefOid.toLowerCase() !== headOid.trim().toLowerCase()) {
      return false;
    }
  }
  const decision = pr.reviewDecision ?? null;
  return decision === "APPROVED" || decision === "" || decision === null;
}

/**
 * Whether an open PR requires human/agent attention (`failing > 0`, `unresolvedThreads > 0`,
 * or `reviewDecision === "CHANGES_REQUESTED"`).
 *
 * @param {unknown} pr
 * @returns {boolean}
 */
export function prNeedsAttention(pr) {
  if (!isOpenPr(pr)) return false;
  return (
    (Number(pr.failing) || 0) > 0 ||
    (Number(pr.unresolvedThreads) || 0) > 0 ||
    pr.reviewDecision === "CHANGES_REQUESTED"
  );
}

/** @param {number} number @returns {number} */
function requirePrNumber(number) {
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`invalid PR number: ${String(number)}`);
  }
  return number;
}

/**
 * Skill slash command to monitor/fix a pull request.
 * @param {number} number
 * @returns {string}
 */
export function babysitCommand(number) {
  return `/babysit-pr ${requirePrNumber(number)}`;
}

/**
 * Skill slash command to land a merge-ready pull request.
 * @param {number} number
 * @returns {string}
 */
export function mergeCommand(number) {
  return `/merge-pr ${requirePrNumber(number)}`;
}

/**
 * Builds `bw pr status` argv for `helper.call(null, args)`, or `null` when repo/branch cannot query a PR.
 * @param {string | null | undefined} repo
 * @param {string | null | undefined} branch
 * @param {string | null | undefined} [headOid]
 * @param {{ refresh?: boolean }} [opts]
 * @returns {string[] | null}
 */
export function prStatusArgs(repo, branch, headOid = null, opts = {}) {
  if (typeof repo !== "string" || !repo || typeof branch !== "string" || !branch || branch.startsWith("-")) {
    return null;
  }
  const args = ["pr", "status", "--repo", repo, "--branch", branch];
  if (typeof headOid === "string" && /^[0-9a-f]{7,64}$/i.test(headOid.trim())) {
    args.push("--head", headOid.trim().toLowerCase());
  }
  if (opts.refresh) args.push("--refresh");
  return args;
}

/**
 * Normalizes a raw PR object from `bw pr status`.
 * @param {unknown} raw
 * @returns {PrSummary | null}
 */
export function normalizePr(raw) {
  if (!isObj(raw) || typeof raw.number !== "number" || !Number.isSafeInteger(raw.number) || raw.number <= 0) {
    return null;
  }
  if (typeof raw.url !== "string" || typeof raw.state !== "string") return null;
  return {
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : "",
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft === true,
    baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
    headRefOid: typeof raw.headRefOid === "string" ? raw.headRefOid : "",
    reviewDecision: typeof raw.reviewDecision === "string" ? raw.reviewDecision : null,
    mergeStateStatus: typeof raw.mergeStateStatus === "string" ? raw.mergeStateStatus : null,
    unresolvedThreads: Number(raw.unresolvedThreads) || 0,
    passing: Number(raw.passing) || 0,
    failing: Number(raw.failing) || 0,
    pending: Number(raw.pending) || 0,
  };
}

/**
 * Parses NDJSON lines returned by `bw pr status`.
 * @param {Record<string, any>[]} lines
 * @returns {{ ok: true, pr: PrSummary | null, cached: boolean, ageS: number, stale: boolean } | { ok: false, code: string, message: string }}
 */
export function parsePrLines(lines) {
  for (const line of lines ?? []) {
    if (!isObj(line)) continue;
    if (line.type === "pr") {
      return {
        ok: true,
        pr: normalizePr(line.pr),
        cached: line.cached === true,
        ageS: Number(line.age_s) || 0,
        stale: line.stale === true,
      };
    }
    if (line.type === "error") {
      return {
        ok: false,
        code: typeof line.code === "string" ? line.code : "failed",
        message: typeof line.message === "string" ? line.message : "PR status unavailable",
      };
    }
  }
  return { ok: false, code: "empty", message: "bw pr status printed no result" };
}

/**
 * Shapes an open PR into the compact summary stored in `shared("bw.pr-summary")[spaceId]`,
 * or `null` when no open PR exists.
 * @param {unknown} pr
 * @param {string | null} [headOid]
 * @returns {SharedPrEntry | null}
 */
export function toSharedPrEntry(pr, headOid = null) {
  const norm = normalizePr(pr);
  if (!norm || !isOpenPr(norm)) return null;
  const oid = typeof headOid === "string" && headOid.trim() !== "" ? headOid.trim().toLowerCase() : null;
  return {
    ...norm,
    headOid: oid,
    mergeReady: isMergeReady(norm, oid),
    attention: prNeedsAttention(norm),
  };
}

/**
 * Updates `shared("bw.pr-summary")` for `spaceId`, pruning closed spaces and returning `null` if unchanged.
 * @param {unknown} stored
 * @param {string} spaceId
 * @param {SharedPrEntry | null} entry
 * @param {Iterable<string>} [liveSpaces]
 * @returns {Record<string, SharedPrEntry> | null}
 */
export function updateSharedPrSummary(stored, spaceId, entry, liveSpaces) {
  const prev = isObj(stored) ? stored : {};
  const keep = liveSpaces ? new Set(liveSpaces) : null;
  /** @type {Record<string, SharedPrEntry>} */
  const next = {};
  for (const [k, v] of Object.entries(prev)) {
    if (k === spaceId) continue;
    if (keep && !keep.has(k)) continue;
    if (isObj(v)) next[k] = /** @type {SharedPrEntry} */ (v);
  }
  if (entry) next[spaceId] = entry;
  return JSON.stringify(next) === JSON.stringify(prev) ? null : next;
}
