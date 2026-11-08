// Which Linear project a repository is linked to, kept in `shared("bw.linear.links")`. A repository with
// an `origin` is keyed by its normalized URL, so its clone on another machine shares the link; one without
// is keyed by `[machine, common dir]`, and its link moves to the origin key once an origin appears.
import { projectKey } from "./projects-model.js";

export const LINKS = "bw.linear.links";

/**
 * @typedef {object} Link
 * @property {string} projectId
 * @property {string} name
 * @property {number} at
 */

/**
 * @typedef {object} Repo Where a repository is, as the panel read it.
 * @property {string | null} machine
 * @property {string} commonDir
 * @property {string | null} origin `git remote get-url origin`, or null
 */

const isObj = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `host/owner/repo` in lower case for an SSH, scp-like, HTTPS or git URL; null for a local path or anything
 * else, since a path names a different repository on each machine.
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function normalizeOrigin(url) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  let host;
  let path;
  const scheme = /^(?:ssh|https?|git|git\+ssh):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(u);
  if (scheme) [, host, path] = scheme;
  else if (scp && !u.startsWith("/") && !/^[a-z]+:\/\//i.test(u)) [, host, path] = scp;
  else return null;
  const clean = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");
  if (!host || !clean) return null;
  return `${host}/${clean}`.toLowerCase();
}

/** @param {Repo} repo */
const originKey = (repo) => {
  const o = normalizeOrigin(repo.origin);
  return o ? `origin:${o}` : null;
};
/** @param {Repo} repo */
const placeKey = (repo) => `place:${projectKey(repo.machine, repo.commonDir)}`;

/** @param {unknown} value @returns {Record<string, Link>} */
function readLinks(value) {
  /** @type {Record<string, Link>} */
  const out = {};
  const v = /** @type {any} */ (value);
  if (!isObj(v) || v.version !== 1 || !isObj(v.links)) return out;
  for (const [k, l] of Object.entries(v.links)) {
    const link = /** @type {any} */ (l);
    if (isObj(link) && typeof link.projectId === "string" && link.projectId && typeof link.name === "string")
      out[k] = { projectId: link.projectId, name: link.name, at: Number(link.at) || 0 };
  }
  return out;
}

/** @param {Record<string, Link>} links */
const wrap = (links) => ({ version: 1, links });

/**
 * The repository's link: its origin key's, else its place key's.
 * @param {unknown} stored @param {Repo} repo
 * @returns {Link | null}
 */
export function readLink(stored, repo) {
  const links = readLinks(stored);
  const o = originKey(repo);
  return (o && links[o]) || links[placeKey(repo)] || null;
}

/**
 * The stored value with `repo` linked to `link`, or unlinked when it is null. A repository with an origin
 * is written under the origin key, and its place key is dropped.
 * @param {unknown} stored @param {Repo} repo @param {Link | null} link
 */
export function writeLink(stored, repo, link) {
  const links = readLinks(stored);
  const o = originKey(repo);
  const p = placeKey(repo);
  delete links[p];
  if (o) delete links[o];
  if (link) links[o ?? p] = { ...link };
  return wrap(links);
}

/**
 * The stored value with a place-keyed link moved to the origin key the repository now has, or null when
 * nothing moves. An origin key that already holds a link wins, and the place key is dropped.
 * @param {unknown} stored @param {Repo} repo
 */
export function moveLink(stored, repo) {
  const o = originKey(repo);
  const links = readLinks(stored);
  const p = placeKey(repo);
  if (!o || !links[p]) return null;
  if (!links[o]) links[o] = links[p];
  delete links[p];
  return wrap(links);
}

/** @param {string} s */
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The project whose name matches the repository's: equal once case and separators are dropped, else one
 * name starting with the other.
 * @template {{ name: string }} P
 * @param {P[]} projects @param {string} repoName
 * @returns {P | null}
 */
export function suggest(projects, repoName) {
  const r = squash(repoName);
  if (!r) return null;
  return (
    projects.find((p) => squash(p.name) === r) ??
    projects.find((p) => {
      const n = squash(p.name);
      return n !== "" && (n.startsWith(r) || r.startsWith(n));
    }) ??
    null
  );
}
