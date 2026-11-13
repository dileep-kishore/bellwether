// Parses the output of the read-only Git calls in git.js. Pure and import-free, so mods copy it.

/** What the counts script prints between `status` and `diff` output. */
export const SEP = "\x1e";

/**
 * @typedef {object} Worktree
 * @property {string} path
 * @property {string | null} head
 * @property {string | null} branch without `refs/heads/`
 * @property {boolean} detached
 * @property {boolean} bare
 * @property {boolean} locked
 * @property {boolean} prunable
 */

/**
 * @typedef {object} Counts
 * @property {string | null} branch
 * @property {boolean} detached
 * @property {boolean} upstream
 * @property {number} ahead
 * @property {number} behind
 * @property {number} files changed, staged, unmerged or untracked
 * @property {number} added lines against HEAD
 * @property {number} removed lines against HEAD
 */

/**
 * Parses `git worktree list --porcelain -z`.
 *
 * @param {string} stdout
 * @returns {Worktree[]} in Git's order: the main checkout first.
 */
export function parseWorktrees(stdout) {
  /** @type {Worktree[]} */
  const out = [];
  /** @type {Worktree | null} */
  let cur = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      cur = null;
      continue;
    }
    const sp = field.indexOf(" ");
    const key = sp === -1 ? field : field.slice(0, sp);
    const value = sp === -1 ? "" : field.slice(sp + 1);
    if (key === "worktree") {
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (key === "HEAD") {
      cur.head = value;
    } else if (key === "branch") {
      cur.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    } else if (key === "detached" || key === "bare" || key === "locked" || key === "prunable") {
      cur[key] = true;
    }
  }
  return out;
}

// Git for Windows prints "C:/…".
const ABSOLUTE = /^(?:[A-Za-z]:)?\//;

/**
 * Parses `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`.
 *
 * @param {string} stdout
 * @returns {{ commonDir: string, top: string } | null} null unless both lines are absolute paths.
 */
export function parsePlace(stdout) {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2) return null;
  const [commonDir, top] = lines;
  if (!ABSOLUTE.test(commonDir) || !ABSOLUTE.test(top)) return null;
  return { commonDir, top };
}

/**
 * Parses `git status --porcelain=v2 --branch -z` and `git diff-index -M --numstat -z HEAD`.
 *
 * @param {string} status
 * @param {string} numstat empty when HEAD is unborn
 * @returns {Counts}
 */
export function parseCounts(status, numstat) {
  /** @type {Counts} */
  const c = { branch: null, detached: false, upstream: false, ahead: 0, behind: 0, files: 0, added: 0, removed: 0 };
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.startsWith("# branch.head ")) {
      const head = r.slice("# branch.head ".length);
      if (head === "(detached)") c.detached = true;
      else c.branch = head;
    } else if (r.startsWith("# branch.upstream ")) {
      c.upstream = true;
    } else if (r.startsWith("# branch.ab ")) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(r);
      if (m) {
        c.ahead = Number(m[1]);
        c.behind = Number(m[2]);
      }
    } else if (r.startsWith("1 ") || r.startsWith("u ") || r.startsWith("? ")) {
      c.files++;
    } else if (r.startsWith("2 ")) {
      c.files++;
      i++; // the rename's original path is its own record
    }
  }
  const fields = numstat.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!m) continue;
    // Binary files print "-" for both counts.
    if (m[1] !== "-") c.added += Number(m[1]);
    if (m[2] !== "-") c.removed += Number(m[2]);
    if (m[3] === "") i += 2; // a rename: old and new paths follow as two fields
  }
  return c;
}

const GH_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Extracts `"owner/repo"` from a GitHub remote URL, or `null` for non-GitHub remotes.
 * Supports `git@github.com:owner/repo(.git)`, `https://github.com/owner/repo(.git)`, and
 * `ssh://git@github.com/owner/repo(.git)`.
 *
 * @param {string | null | undefined} remoteUrl
 * @returns {string | null}
 */
export function parseGithubRepo(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const raw = remoteUrl.trim();
  if (!raw) return null;

  /** @type {string | null} */
  let owner = null;
  /** @type {string | null} */
  let repo = null;

  const scp = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i.exec(raw);
  if (scp) {
    owner = scp[1];
    repo = scp[2];
  } else {
    const url = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/?#\s]+)\/([^/?#\s]+?)\/?$/i.exec(raw);
    if (url) {
      owner = url[1];
      repo = url[2];
    }
  }
  if (!owner || !repo) return null;
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  if (!GH_PART.test(owner) || !GH_PART.test(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * Parses a commit OID from `git rev-parse --verify HEAD` or `# branch.oid <oid>` in porcelain v2 status.
 * Returns `null` when HEAD is unborn or malformed.
 *
 * @param {string | null | undefined} stdout
 * @returns {string | null}
 */
export function parseHeadOid(stdout) {
  if (typeof stdout !== "string") return null;
  for (const part of stdout.split(/[\0\n]/)) {
    const line = part.trim();
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      return /^[0-9a-f]{40,64}$/i.test(oid) ? oid.toLowerCase() : null;
    }
    if (/^[0-9a-f]{40,64}$/i.test(line)) return line.toLowerCase();
  }
  return null;
}
