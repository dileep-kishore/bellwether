// The Changes panel's pure parts: `bw diff` output as rows, patch text as numbered rows, the stored base
// per project, and the helper arguments. Imports nothing, so `bun test` and verify/git-run.js run it.

export const BASE_KEY = "bw.diff.base";

/** @typedef {"staged" | "changes" | "committed"} Section */
/** @typedef {"merge-base" | "tip"} Mode */
/** @type {readonly Section[]} */
export const SECTIONS = Object.freeze(["staged", "changes", "committed"]);
/** @type {Readonly<Record<Section, string>>} */
export const SECTION_TITLE = Object.freeze({ staged: "Staged", changes: "Changes", committed: "Committed on branch" });

/**
 * @typedef {object} Row
 * @property {string} key `<section>\n<path>`
 * @property {Section} section
 * @property {string} path relative to the worktree's top
 * @property {string | null} oldPath a rename's or copy's source
 * @property {string} letter what the row shows: Git's letter, `U` for untracked, `!` for unmerged
 * @property {boolean} untracked
 * @property {number | null} added
 * @property {number | null} removed
 * @property {boolean} binary
 * @property {string} dir the folder part with its trailing slash, or ""
 * @property {string} name
 */

/**
 * @typedef {object} Place
 * @property {string} top
 * @property {string} commonDir
 * @property {string | null} branch
 * @property {string | null} head
 */

/**
 * @typedef {object} Base
 * @property {string | null} ref
 * @property {string | null} commit
 * @property {string | null} short
 * @property {number | null} time seconds
 * @property {"default" | "typed" | "none"} source
 * @property {string | null} error
 * @property {Mode} mode
 * @property {string | null} from where the Committed list starts
 */

/**
 * @typedef {object} FilesView
 * @property {Place} place
 * @property {Base} base
 * @property {Record<Section, Row[]>} sections
 * @property {Record<Section, number>} more rows left out past the helper's limit
 * @property {{ section: Section, path: string, digest: string } | null} digest
 */

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);
const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isSection = (/** @type {unknown} */ s) => SECTIONS.includes(/** @type {Section} */ (s));

/** A ref as the header shows it: `refs/tags/v1` reads `v1`. @param {string} ref */
export const shortRef = (ref) => ref.replace(/^refs\/(heads|remotes|tags)\//, "");

/** @param {string} path @returns {{ dir: string, name: string }} */
export function splitPath(path) {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/**
 * Reads `bw diff files` lines; null without a `diff-place` line.
 * @param {unknown[]} lines @returns {FilesView | null}
 */
export function viewFiles(lines) {
  const all = /** @type {any[]} */ (lines.filter((l) => l && typeof l === "object"));
  const p = all.find((l) => l.type === "diff-place");
  if (!p || typeof p.top !== "string") return null;
  const b = all.find((l) => l.type === "diff-base") ?? {};
  /** @type {Record<Section, Row[]>} */
  const sections = { staged: [], changes: [], committed: [] };
  /** @type {Record<Section, number>} */
  const more = { staged: 0, changes: 0, committed: 0 };
  for (const l of all) {
    if (l.type === "diff-more" && isSection(l.section)) more[/** @type {Section} */ (l.section)] = num(l.omitted) ?? 0;
    if (l.type !== "diff-file" || !isSection(l.section) || typeof l.path !== "string") continue;
    const section = /** @type {Section} */ (l.section);
    const status = str(l.status) ?? "M";
    const letter = status === "?" ? "U" : status === "U" ? "!" : status;
    sections[section].push({
      key: `${section}\n${l.path}`,
      section,
      path: l.path,
      oldPath: str(l.old_path),
      letter,
      untracked: status === "?",
      added: num(l.added),
      removed: num(l.removed),
      binary: l.binary === true,
      ...splitPath(l.path),
    });
  }
  const d = all.find((l) => l.type === "diff-digest");
  return {
    place: { top: p.top, commonDir: str(p.common_dir) ?? "", branch: str(p.branch), head: str(p.head) },
    base: {
      ref: str(b.ref),
      commit: str(b.commit),
      short: str(b.short),
      time: num(b.time),
      source: b.source === "typed" || b.source === "default" ? b.source : "none",
      error: str(b.error),
      mode: b.mode === "tip" ? "tip" : "merge-base",
      from: str(b.from),
    },
    sections,
    more,
    digest:
      d && isSection(d.section) && typeof d.path === "string" && typeof d.digest === "string"
        ? { section: d.section, path: d.path, digest: d.digest }
        : null,
  };
}

/** A section's total `+N −M`, binary rows counting nothing. @param {Row[]} rows */
export function totals(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    added += r.added ?? 0;
    removed += r.removed ?? 0;
  }
  return { added, removed };
}

/**
 * @typedef {object} PatchRow
 * @property {"meta" | "hunk" | "add" | "del" | "ctx" | "note" | "cut"} kind
 * @property {number | null} old
 * @property {number | null} new
 * @property {string} text without its `+`, `-` or space
 * @property {number} [bytes] a cut line's size
 */

/**
 * Numbers a unified patch's lines from its hunk headers. `cut` maps a line index (over the whole text) to
 * the bytes of a line the helper left out.
 * @param {string} text @param {Map<number, number>} [cut] @returns {PatchRow[]}
 */
export function patchRows(text, cut = new Map()) {
  /** @type {PatchRow[]} */
  const out = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  lines.forEach((line, i) => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      out.push({ kind: "hunk", old: null, new: null, text: line });
      return;
    }
    if (!inHunk || line.startsWith("diff --git ")) {
      inHunk = false;
      out.push({ kind: "meta", old: null, new: null, text: line });
      return;
    }
    const c = line[0];
    const bytes = cut.get(i);
    const rest = line.slice(1);
    if (c === "+") {
      out.push(
        bytes === undefined
          ? { kind: "add", old: null, new: newNo, text: rest }
          : { kind: "cut", old: null, new: newNo, text: "", bytes },
      );
      newNo++;
    } else if (c === "-") {
      out.push(
        bytes === undefined
          ? { kind: "del", old: oldNo, new: null, text: rest }
          : { kind: "cut", old: oldNo, new: null, text: "", bytes },
      );
      oldNo++;
    } else if (c === "\\") {
      out.push({ kind: "note", old: null, new: null, text: line.slice(2) });
    } else {
      out.push(
        bytes === undefined
          ? { kind: "ctx", old: oldNo, new: newNo, text: rest }
          : { kind: "cut", old: oldNo, new: newNo, text: "", bytes },
      );
      oldNo++;
      newNo++;
    }
  });
  return out;
}

/** "5.2 MiB", "820 KiB", "12 B". @param {number} bytes */
export function size(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/**
 * Joins loaded pages into one text and one cut map over its lines.
 * @param {{ text: string, cut: { line: number, bytes: number }[] }[]} pages
 */
export function joinPages(pages) {
  let text = "";
  /** @type {Map<number, number>} */
  const cut = new Map();
  let offset = 0;
  for (const p of pages) {
    for (const c of p.cut) cut.set(offset + c.line, c.bytes);
    text += p.text;
    offset += p.text.split("\n").length - (p.text.endsWith("\n") ? 1 : 0);
  }
  return { text, cut };
}

/** @typedef {{ ref: string | null, mode: Mode }} BaseChoice */

/** @param {unknown} stored @param {string} key projectKey(machine, commonDir) @returns {BaseChoice} */
export function readBase(stored, key) {
  const v = stored && typeof stored === "object" ? /** @type {any} */ (stored)[key] : null;
  return {
    ref: v && typeof v.ref === "string" && v.ref ? v.ref : null,
    mode: v?.mode === "tip" ? "tip" : "merge-base",
  };
}

/**
 * The stored value with one project's choice replaced; a choice of the default base in Merge base mode
 * removes the entry.
 * @param {unknown} stored @param {string} key @param {BaseChoice} choice
 */
export function writeBase(stored, key, choice) {
  /** @type {Record<string, BaseChoice>} */
  const out = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored))
    for (const k of Object.keys(stored)) if (k !== key) out[k] = readBase(stored, k);
  if (choice.ref !== null || choice.mode !== "merge-base") out[key] = { ref: choice.ref, mode: choice.mode };
  return out;
}

/**
 * The row a chat's file names: an absolute path under `top` or a path relative to it, looked up in
 * Changes, then Staged, then Committed.
 * @param {FilesView} view @param {string} file @returns {Row | null}
 */
export function rowFor(view, file) {
  const top = view.place.top.replace(/\/+$/, "");
  const rel = file.startsWith(`${top}/`) ? file.slice(top.length + 1) : file.startsWith("/") ? null : file;
  if (rel === null) return null;
  for (const s of /** @type {Section[]} */ (["changes", "staged", "committed"])) {
    const hit = view.sections[s].find((r) => r.path === rel);
    if (hit) return hit;
  }
  return null;
}

/**
 * @typedef {object} Selection
 * @property {Section} section
 * @property {string} path
 * @property {string | null} oldPath
 * @property {boolean} untracked
 */

/** @param {Row} r @returns {Selection} */
export const selectionOf = (r) => ({ section: r.section, path: r.path, oldPath: r.oldPath, untracked: r.untracked });

/**
 * `bw diff files` arguments. With `watch`, the helper's watcher answers `diff-unchanged` while `since`, the
 * token of the last read, still holds.
 * @param {string} folder @param {BaseChoice} base @param {Selection | null} selected
 * @param {{ since: string | null } | null} [watch]
 */
export function filesArgs(folder, base, selected, watch = null) {
  const args = ["diff", "files", "--path", folder, "--mode", base.mode];
  if (base.ref !== null) args.push("--base", base.ref);
  if (selected) {
    args.push("--select", selected.section, "--file", selected.path);
    if (selected.oldPath) args.push("--old", selected.oldPath);
  }
  if (watch) {
    args.push("--watch");
    if (watch.since) args.push("--since", watch.since);
  }
  return args;
}

/**
 * What a `bw diff files --watch` answer says about the watcher: nothing changed since the token sent, or
 * the token for the read it holds (null while no watcher runs).
 * @param {unknown[]} lines @returns {{ unchanged: boolean, token: string | null }}
 */
export function watchAnswer(lines) {
  const all = /** @type {any[]} */ (lines.filter((l) => l && typeof l === "object"));
  const u = all.find((l) => l.type === "diff-unchanged" && typeof l.token === "string");
  if (u) return { unchanged: true, token: u.token };
  const t = all.find((l) => l.type === "diff-token" && typeof l.token === "string");
  return { unchanged: false, token: t ? t.token : null };
}

/**
 * `bw diff patch` arguments; Committed needs the range the list was read with.
 * @param {string} top @param {Selection} s @param {{ from: string | null, to: string | null }} range @param {number} page
 * @returns {string[] | null} null for a Committed file with no range
 */
export function patchArgs(top, s, range, page) {
  const args = ["diff", "patch", "--path", top, "--section", s.section, "--file", s.path];
  if (s.oldPath) args.push("--old", s.oldPath);
  if (s.untracked) args.push("--untracked");
  if (s.section === "committed") {
    if (!range.from || !range.to) return null;
    args.push("--from", range.from, "--to", range.to);
  }
  if (page > 0) args.push("--page", String(page));
  return args;
}

/**
 * Whether the right sidebar shows Changes: the right-body stack's active child is `changes` and no node on
 * the way to it is hidden.
 * @param {unknown} layoutNode
 */
export function isShown(layoutNode) {
  /** @param {any} node @param {boolean} hidden @returns {boolean | null} */
  const walk = (node, hidden) => {
    if (!node || typeof node !== "object") return null;
    const h = hidden || node.hidden === true;
    if (node.id === "right-body") return !h && node.active === "changes";
    for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
      const r = walk(c, h);
      if (r !== null) return r;
    }
    return null;
  };
  return walk(layoutNode, false) === true;
}

/**
 * The props of a diff opened as a tab, as `readTab` reads them back.
 * @typedef {object} TabProps
 * @property {true} tab
 * @property {string} space the space id in the window that opened it
 * @property {string | null} machine as that window names it
 * @property {string | null} window that window's `bw.window-id`
 * @property {string} top
 * @property {Section} section
 * @property {string} file
 * @property {string | null} old
 * @property {boolean} untracked
 * @property {string | null} from
 * @property {string | null} to
 * @property {string | null} base the base's name, for the header
 * @property {Mode} mode
 */

/** @param {unknown} p @returns {TabProps | null} */
export function readTab(p) {
  const v = /** @type {any} */ (p);
  if (v?.tab !== true || typeof v.space !== "string" || typeof v.top !== "string") return null;
  if (!isSection(v.section) || typeof v.file !== "string" || !v.file) return null;
  return {
    tab: true,
    space: v.space,
    machine: str(v.machine),
    window: str(v.window),
    top: v.top,
    section: v.section,
    file: v.file,
    old: str(v.old),
    untracked: v.untracked === true,
    from: str(v.from),
    to: str(v.to),
    base: str(v.base),
    mode: v.mode === "tip" ? "tip" : "merge-base",
  };
}

/**
 * The machine a diff tab reads from: its own props in the window that opened it; elsewhere the space with
 * the same id, else the one space whose id matches past its machine prefix (another window writes
 * `macmini/sp1` where this one writes `sp1`). Several such spaces resolve to none.
 * @param {TabProps} t @param {string | null} windowId this window's `bw.window-id`
 * @param {{ id: string, machine?: string | null }[]} spaces
 * @returns {{ ok: true, machine: string | null } | { ok: false }}
 */
export function tabMachine(t, windowId, spaces) {
  if (t.window !== null && t.window === windowId) return { ok: true, machine: t.machine };
  const exact = spaces.find((s) => s.id === t.space);
  if (exact) return { ok: true, machine: exact.machine ?? null };
  const local = (/** @type {string} */ id) => id.slice(id.lastIndexOf("/") + 1);
  const hits = spaces.filter((s) => local(s.id) === local(t.space));
  // Two machines can number a space alike; guessing would read the wrong machine's checkout.
  return hits.length === 1 ? { ok: true, machine: hits[0].machine ?? null } : { ok: false };
}
