// Changes: Uncommitted (Staged + Changes), Branch, and PR diffs for the active space's worktree, with the
// selected file's patch and line-anchored review comments below. Without props this copy is the right
// sidebar's panel; with `{ tab: true, … }` it is a diff opened as a middle tab. The panel's loop task runs
// `bw diff files` on the space's machine through the shared refresh schedule (a watch here, every 1.5 s
// elsewhere) only while the panel is shown and drawn; render reads live data, sets the target and pokes.
import { div, svg, View } from "gpui-kit";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { agents, exec, home, layout, panes, props, run, setShared, shared, spaces, watchFolder } from "herdr";
import { CHAT_AGENT, PR_SUMMARY, paneKind, resolveTabAgent } from "./chat-tabs.js";
import {
  anchorFromRow,
  commentTargetKey,
  findCommentAtAnchor,
  preflightVerifyComments,
  removeComment,
  revalidateTargetComments,
  upsertComment,
} from "./comments.js";
import { dropReveal, REVEAL, revealFor } from "./diff-reveal.js";
import { cardsExpect } from "./dock-model.js";
import { remoteOrigin } from "./git.js";
import { createHelper, parseLines } from "./helper.js";
import {
  BASE_KEY,
  filesArgs,
  isShown,
  joinPages,
  parseRowKey,
  patchArgs,
  patchRows,
  prBaseChoice,
  readBase,
  readTab,
  rowFor,
  SCOPE_LABEL,
  SCOPES,
  SECTION_TITLE,
  scopeForSection,
  sectionsForScope,
  selectionOf,
  shortRef,
  splitPath,
  tabMachine,
  totals,
  viewFiles,
  watchAnswer,
  writeBase,
} from "./model.js";
import { counts, letterColor, patchView } from "./patch.js";
import { isOpenPr, parsePrLines, prStatusArgs, toSharedPrEntry, updateSharedPrSummary } from "./pr-model.js";
import { placeOf, projectKey } from "./projects-model.js";
import { createPoke, runRefresher } from "./refresh-driver.js";
import { createSchedule } from "./refresh-schedule.js";
import { ago, button, card, hoverFill, ICONS, mutedOnSelected, pill, spinner, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./model.js").FilesView} FilesView */
/** @typedef {import("./model.js").Selection} Selection */
/** @typedef {import("./model.js").Section} Section */
/** @typedef {import("./model.js").Scope} Scope */
/** @typedef {import("./model.js").BaseChoice} BaseChoice */
/** @typedef {import("./comments.js").CommentAnchor} CommentAnchor */
/** @typedef {import("./comments.js").DraftComment} DraftComment */
/** @typedef {import("./pr-model.js").PrSummary} PrSummary */

const WINDOW_ID = "bw.window-id";
const FOLDED = "bw-diff.folded";
const PR_TTL_MS = 60_000;
/** @param {string} name */
const icon = (name) => `mods/bw-diff/icons/${name}.svg`;

/**
 * @typedef {object} PatchState
 * @property {string} key the machine, worktree, selection and range it belongs to
 * @property {string | null} digest
 * @property {string | null} failed the listed digest whose load failed, so a refresh does not retry it
 * @property {{ text: string, cut: { line: number, bytes: number }[] }[]} pages
 * @property {number} total
 * @property {number} bytes
 * @property {boolean} loading
 * @property {string | null} error
 */

/**
 * @typedef {object} AgentSnapshot
 * @property {string | null} machine
 * @property {string} terminal
 * @property {string} local
 * @property {"claude" | "codex"} kind
 * @property {string | null} status
 */

/** @param {Selection | null} s */
const selKey = (s) => (s ? JSON.stringify([s.section, s.path, s.oldPath, s.untracked]) : "");

/** @param {unknown} e */
const errorText = (e) => (e instanceof Error ? e.message : String(e));

/** @returns {Set<string>} */
function loadFolded() {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** @param {any} cx */
function helperFor(cx) {
  const bw = `${home()}/.local/share/bellwether/helper/current/bw`;
  return createHelper({
    exec: /** @type {import("./helper.js").Exec} */ (exec),
    localInstall: async (machine) => {
      let r;
      try {
        r = await exec(bw, ["machine", "install", machine], { on: null });
      } catch (e) {
        throw new Error(
          `could not start bw on this Mac (${e instanceof Error ? e.message : String(e)}): run scripts/install-helper.sh`,
        );
      }
      cx?.notify?.();
      if (!r.stdout.trim()) throw new Error(r.stderr.trim() || `bw exited ${r.code}`);
      return parseLines(r.stdout);
    },
  });
}

/**
 * Resolves the target Claude/Codex agent for `space` from live Herdr arrays (called only during render).
 * @param {any} space
 * @param {any[]} allPanes
 * @param {any[]} allAgents
 * @param {unknown} chatTabs
 * @param {unknown} chatAgents
 * @returns {AgentSnapshot | null}
 */
function resolveSpaceAgent(space, allPanes, allAgents, chatTabs, chatAgents) {
  if (!space || !Array.isArray(space.tabs)) return null;
  const activeTab = space.tabs.find((/** @type {any} */ t) => t.active) ?? null;
  const orderedTabs = activeTab
    ? [activeTab, ...space.tabs.filter((/** @type {any} */ t) => t !== activeTab)]
    : space.tabs;
  for (const tab of orderedTabs) {
    const picked = resolveTabAgent(tab.id, allPanes, chatTabs, chatAgents);
    if (!picked) continue;
    const machine = space.machine ?? null;
    const local =
      machine !== null && picked.terminal.startsWith(`${machine}/`)
        ? picked.terminal.slice(machine.length + 1)
        : picked.terminal;
    const pane = allPanes.find((p) => p.pane === picked.pane) ?? null;
    const liveAgent =
      allAgents.find((a) => a.terminal === picked.terminal || (a.pane && a.pane === picked.pane)) ?? null;
    const kind = pane ? (paneKind(pane) ?? picked.kind) : picked.kind;
    const status = liveAgent?.status ?? pane?.status ?? tab.status ?? null;
    return { machine, terminal: picked.terminal, local, kind, status };
  }
  return null;
}

export default class Changes extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    this.tab = readTab(props());
    this.helper = helperFor(null);
    /** @type {Scope} */
    this.scope = "uncommitted";
    /** @type {FilesView | null} */
    this.view = null;
    /** @type {{ state: string, message: string } | null} */
    this.failure = null;
    /** @type {Selection | null} */
    this.selected = null;
    /** @type {PatchState | null} */
    this.patch = null;
    /** The page the work loop loads next: 0 reloads from the start. */
    this.patchPage = 0;
    this.patchWanted = false;
    this.refsWanted = false;
    this.prWanted = false;
    // Render has no cx, so it asks this loop for patches, refs, and PR lookups.
    this.work = createPoke();
    /** @type {string | null} */
    this.note = null;
    /** @type {string | null} the button whose action runs */
    this.busy = null;
    /** @type {string | null} */
    this.hovered = null;
    this.height = 0;
    this.folded = loadFolded();
    this.commentSeq = 0;
    /** @type {Map<string, DraftComment[]>} keyed by `JSON.stringify([machine, worktreeTop])` */
    this.commentsByWorktree = new Map();
    /** @type {CommentAnchor | null} */
    this.editingComment = null;
    /** @type {AgentSnapshot | null} */
    this.agentTarget = null;
    /** @type {{ key: string, pr: PrSummary | null, checkedAt: number, repoFolder: string | null, repo: string | null }} */
    this.prState = { key: "", pr: null, checkedAt: 0, repoFolder: null, repo: null };
    /** @type {{ key: string, spaceId: string, machine: string | null, folder: string, branch: string, head: string | null, liveSpaces: string[] } | null} */
    this.prQuery = null;

    this.commentInput = InputState.new({ placeholder: "Comment on this line… (Enter to save, Esc to cancel)" });
    this.commentInput.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => cx.notify());
    this.commentInput.on("submit", (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.saveComment(cx));

    cx.spawn(async (/** @type {any} */ cx) => {
      while (this.alive) {
        await this.work.wait();
        // A hidden panel calls nothing, and a job may wait on another's call; update() pokes again once
        // Changes is shown.
        const may = () => this.alive && (this.tab !== null || isShown(layout()));
        // One task's exception ends here, so the loop still serves later loads.
        if (may() && this.prWanted) {
          this.prWanted = false;
          try {
            await this.loadPr(cx);
          } catch {
            cx.notify();
          }
        }
        if (may() && this.refsWanted) {
          this.refsWanted = false;
          try {
            await this.loadRefs(cx);
          } catch (e) {
            this.picker = { ...this.picker, loading: false, error: errorText(e) };
            cx.notify();
          }
        }
        if (may() && this.patchWanted) {
          this.patchWanted = false;
          try {
            await this.loadPatch(cx);
          } catch (e) {
            if (this.patch) this.patch = { ...this.patch, loading: false, error: errorText(e) };
            else this.note = errorText(e);
            cx.notify();
          }
        }
      }
    });

    if (this.tab) {
      /** @type {string | null} */
      this.tabMachineName = null;
      this.tabReady = false;
      return;
    }

    this.schedule = createSchedule();
    this.poke = createPoke();
    /** @type {string | null} the target key render last set */
    this.key = null;
    /** @type {string | null} `[machine, folder]` of the shown worktree */
    this.folderKey = null;
    /** @type {{ id: string, machine: string | null } | null} */
    this.space = null;
    /** @type {{ machine: string | null, folder: string, base: BaseChoice, branchBase: BaseChoice, fromPr: boolean, project: string | null } | null} */
    this.want = null;
    /** The common dir each folder was found in, so a stored base is known before the first read ends. */
    /** @type {Map<string, string>} */
    this.commonDirs = new Map();
    this.nonce = 0;
    /** The helper watcher's token for the last remote read, and the target it was read for. */
    /** @type {{ key: string, value: string } | null} */
    this.token = null;
    this.shown = false;
    /** Whether the shown folder has had a result; until then a read always runs. */
    this.answered = false;
    // Herdr draws only shown copies: a result whose notify brought no render means the copy is hidden.
    this.drawn = false;
    this.parked = false;
    this.targeted = false;
    /** @type {{ open: boolean, refs: any[] | null, loading: boolean, error: string | null }} */
    this.picker = { open: false, refs: null, loading: false, error: null };
    /** Projects whose missing base already opened the picker once. */
    this.autoPicked = new Set();
    /** @type {number | null} the reveal last applied */
    this.revealed = null;
    /** @type {number | null} the reveal that asked for a fresh read */
    this.revealAsked = null;
    /** When the shown list's read started, to tell whether it can hold a file a chat just named. */
    this.viewAt = 0;
    this.filter = InputState.new({ placeholder: "Filter, or type a ref and press Enter" });
    this.filter.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => cx.notify());
    this.filter.on("submit", (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.submitRef(cx));

    cx.spawn(async (/** @type {any} */ cx) => {
      await runRefresher(cx, {
        schedule: this.schedule,
        run: (target) => this.read(target),
        onResult: (target, result) => this.merge(target, result),
        watchFolder,
        poke: this.poke,
        alive: () => this.alive,
      });
    });
  }

  close() {
    this.alive = false;
    this.poke?.poke();
    this.work.poke();
    this.commentInput?.release?.();
    this.filter?.release?.();
  }

  /** Asks the work loop for page `page` of the selected file's patch. @param {number} page */
  wantPatch(page) {
    this.patchPage = page;
    this.patchWanted = true;
    this.work.poke();
  }

  /** The machine the shown files live on. */
  machine() {
    return this.tab ? this.tabMachineName : (this.want?.machine ?? null);
  }

  /** Key identifying the current worktree in `this.commentsByWorktree`. @returns {string | null} */
  worktreeKey() {
    const top = this.tab ? this.tab.top : (this.view?.place.top ?? this.want?.folder ?? null);
    if (!top) return null;
    return JSON.stringify([this.machine(), top]);
  }

  /** @returns {DraftComment[]} */
  worktreeComments() {
    const key = this.worktreeKey();
    return key ? (this.commentsByWorktree.get(key) ?? []) : [];
  }

  /** @param {string | null} key @param {DraftComment[]} list */
  setWorktreeComments(key, list) {
    if (!key) return;
    if (list.length === 0) this.commentsByWorktree.delete(key);
    else this.commentsByWorktree.set(key, list);
  }

  /** @returns {{ base: string | null, mode: import("./model.js").Mode, from: string | null, to: string | null }} */
  currentRangeInfo() {
    if (this.tab) {
      return { base: this.tab.base, mode: this.tab.mode, from: this.tab.from, to: this.tab.to };
    }
    return {
      base: this.view?.base.ref ?? null,
      mode: this.view?.base.mode ?? "merge-base",
      from: this.view?.base.from ?? null,
      to: this.view?.place.head ?? null,
    };
  }

  /** Comments belonging to the currently selected file and range. @returns {DraftComment[]} */
  selectedFileComments() {
    const sel = this.selected;
    if (!sel) return [];
    const info = this.currentRangeInfo();
    const targetKey = commentTargetKey({
      section: sel.section,
      path: sel.path,
      base: sel.section === "committed" ? info.base : null,
      mode: info.mode,
    });
    return this.worktreeComments().filter((c) => commentTargetKey(c) === targetKey);
  }

  /** @param {Scope} nextScope @param {any} cx */
  setScope(nextScope, cx) {
    if (this.scope === nextScope) return;
    this.scope = nextScope;
    this.note = null;
    if (this.selected && !sectionsForScope(nextScope).includes(this.selected.section)) {
      this.selected = null;
      this.patch = null;
      this.editingComment = null;
    }
    if (nextScope === "pr") {
      this.prWanted = true;
      this.work.poke();
    }
    cx.notify();
  }

  /** @param {any} cx */
  async loadPr(cx) {
    const q = this.prQuery;
    if (!q) return;
    this.prState = { ...this.prState, key: q.key, checkedAt: Date.now() };
    const folderKey = JSON.stringify([q.machine, q.folder]);
    let repo = this.prState.repoFolder === folderKey ? this.prState.repo : null;
    if (this.prState.repoFolder !== folderKey) {
      const origin = await remoteOrigin(/** @type {import("./git.js").Exec} */ (exec), q.machine, q.folder);
      if (this.prQuery?.key !== q.key) return;
      if (!origin.ok) return;
      repo = origin.repo;
      this.prState = { ...this.prState, repoFolder: folderKey, repo };
    }
    if (!repo) {
      this.prState = { ...this.prState, key: q.key, pr: null, checkedAt: Date.now() };
      cx.notify();
      return;
    }
    const args = prStatusArgs(repo, q.branch, q.head);
    if (!args) return;
    const answer = await this.helper.call(null, args);
    if (this.prQuery?.key !== q.key) return;
    if (!answer.ok) return;
    const parsed = parsePrLines(answer.lines);
    if (!parsed.ok) return;
    const pr = parsed.pr && isOpenPr(parsed.pr) ? parsed.pr : null;
    this.prState = { ...this.prState, key: q.key, pr, checkedAt: Date.now() };
    if (q.spaceId) {
      const entry = toSharedPrEntry(pr, q.head);
      const nextSummary = updateSharedPrSummary(shared(PR_SUMMARY), q.spaceId, entry, q.liveSpaces);
      if (nextSummary) setShared(PR_SUMMARY, nextSummary);
    }
    cx.notify();
  }

  /**
   * One `bw diff files` call, or none when the right sidebar no longer shows Changes or the copy was not
   * drawn since the last result. The layout is read here too because the render a strip click causes can
   * come before the stack switches, which would leave the copy counted as drawn.
   * @param {any} target
   */
  async read(target) {
    if (!isShown(layout()) || (!this.drawn && this.targeted && this.answered)) {
      this.parked = true;
      this.targeted = false;
      this.schedule?.setTargets([], Date.now());
      return { ok: true, skipped: true };
    }
    const sel = this.selected;
    const started = Date.now();
    // A local panel reads on Herdr's watch, which can wake it before the helper's watcher sees the edit.
    const watch = target.machine === null ? null : { since: this.token?.key === target.key ? this.token.value : null };
    const answer = await this.helper.call(target.machine, filesArgs(target.path, target.base, sel, watch));
    return { ok: answer.ok, answer, sel, started };
  }

  /** @param {any} target @param {any} result @returns {boolean} */
  merge(target, result) {
    if (!result || result.skipped || target.key !== this.key) return false;
    this.drawn = false;
    this.answered = true;
    const answer = result.answer;
    if (!answer) {
      this.failure = { state: "failed", message: String(result.message ?? "bw diff files failed") };
      return true;
    }
    if (answer.ok === false) {
      this.failure = { state: answer.state, message: answer.message };
      if (answer.state === "failed" && /not in a Git worktree|is not a folder/.test(answer.message)) this.view = null;
      return true;
    }
    const watched = watchAnswer(answer.lines);
    this.token = watched.token ? { key: target.key, value: watched.token } : null;
    if (watched.unchanged) {
      // The shown list still holds; without one, the cleared token makes the next read a full one.
      if (!this.view) this.token = null;
      else {
        this.failure = null;
        this.viewAt = Number(result.started) || 0;
      }
      return true;
    }
    const view = viewFiles(answer.lines);
    if (!view) {
      this.failure = { state: "bad_output", message: "bw diff files printed no place" };
      return true;
    }
    this.failure = null;
    const prevKey = this.worktreeKey();
    this.view = view;
    const nextKey = this.worktreeKey();
    if (prevKey && nextKey && prevKey !== nextKey && this.commentsByWorktree.has(prevKey)) {
      const prevComments = this.commentsByWorktree.get(prevKey) ?? [];
      if (!this.commentsByWorktree.has(nextKey) && prevComments.length > 0) {
        this.commentsByWorktree.set(nextKey, prevComments);
        this.commentsByWorktree.delete(prevKey);
      }
    }
    this.viewAt = Number(result.started) || 0;
    this.commonDirs.set(/** @type {string} */ (this.folderKey), view.place.commonDir);
    const sel = this.selected;
    if (sel) {
      const still = view.sections[sel.section].find((r) => r.path === sel.path);
      if (!still) {
        this.note = `${splitPath(sel.path).name} has no ${SECTION_TITLE[sel.section].toLowerCase()} now`;
        this.selected = null;
        this.patch = null;
        this.editingComment = null;
      } else if (selKey(selectionOf(still)) !== selKey(sel)) {
        // Staged, unstaged or renamed in place: the patch needs the row's new flags.
        this.selected = selectionOf(still);
        this.patch = null;
        this.wantPatch(0);
      } else if (this.patch && this.patch.key !== this.patchSource()?.key) {
        this.wantPatch(0);
      } else if (
        selKey(result.sel) === selKey(sel) &&
        view.digest &&
        this.patch &&
        view.digest.digest !== this.patch.digest &&
        view.digest.digest !== this.patch.failed
      ) {
        this.wantPatch(0);
      }
    }
    return true;
  }

  /**
   * Where the selected patch comes from. `key` names the machine, worktree, selection and, for Committed,
   * the range, so an answer for any other is never shown.
   */
  patchSource() {
    const sel = this.selected;
    const top = this.tab ? this.tab.top : (this.view?.place.top ?? null);
    if (!sel || !top) return null;
    const info = this.currentRangeInfo();
    const range = sel.section !== "committed" ? { from: null, to: null } : { from: info.from, to: info.to };
    const machine = this.machine();
    return {
      sel,
      top,
      range,
      base: sel.section === "committed" ? info.base : null,
      mode: info.mode,
      machine,
      key: JSON.stringify([machine, top, selKey(sel), range.from, range.to]),
    };
  }

  /** Loads `this.patchPage` of the selected file's patch. @param {any} cx */
  async loadPatch(cx) {
    const src = this.patchSource();
    if (!src) return;
    const same = this.patch?.key === src.key ? this.patch : null;
    const page = same ? this.patchPage : 0;
    const args = patchArgs(src.top, src.sel, src.range, page);
    if (!args) {
      this.patch = {
        key: src.key,
        digest: null,
        failed: null,
        pages: [],
        total: 0,
        bytes: 0,
        loading: false,
        error: "Pick a base first",
      };
      cx.notify();
      return;
    }
    this.patch = same
      ? { ...same, loading: true, error: null }
      : { key: src.key, digest: null, failed: null, pages: [], total: 0, bytes: 0, loading: true, error: null };
    // The listed digest this load answers, so a failure is not retried on every refresh.
    const listed = this.view?.digest?.digest ?? null;
    cx.notify();
    const answer = await this.helper.call(src.machine, args);
    // A pick away and back clears the patch but keeps the key, so a page answered for the old state is dropped.
    const now = this.patch?.key === src.key ? this.patch : null;
    if (!now || this.patchSource()?.key !== src.key) {
      if (this.selected) this.wantPatch(0);
      return;
    }
    const line = answer.ok ? /** @type {any} */ (answer.lines.find((l) => l.type === "diff-patch")) : null;
    if (!line) {
      const message = answer.ok === false ? answer.message : "bw diff patch printed no page";
      this.patch = { ...now, loading: false, error: message, failed: listed };
    } else if (page > 0 && line.digest !== now.digest) {
      // The file changed since the first page: start over rather than join two versions.
      this.patch = { ...now, pages: [], loading: false };
      this.wantPatch(0);
    } else {
      const got = { text: String(line.text ?? ""), cut: Array.isArray(line.cut) ? line.cut : [] };
      const pages = page > 0 ? [...now.pages, got] : [got];
      const total = Number(line.pages) || 1;
      const digest = typeof line.digest === "string" ? line.digest : null;
      this.patch = {
        key: src.key,
        digest,
        failed: null,
        pages,
        total,
        bytes: Number(line.bytes) || 0,
        loading: false,
        error: null,
      };
      if (digest) {
        const wtKey = JSON.stringify([src.machine, src.top]);
        const existing = this.commentsByWorktree.get(wtKey);
        if (existing && existing.length > 0) {
          const joined = joinPages(pages);
          const rows = patchRows(joined.text, joined.cut);
          const targetKey = commentTargetKey({
            section: src.sel.section,
            path: src.sel.path,
            base: src.base,
            mode: src.mode,
          });
          const check = revalidateTargetComments(existing, targetKey, rows, digest, {
            complete: pages.length >= total,
          });
          this.setWorktreeComments(wtKey, check.next);
        }
      }
    }
    cx.notify();
  }

  /**
   * Handles a click on a virtual diff row (`{patchDigest}:{kind}:{oldLine}:{newLine}`).
   * Ignores non-code rows and clicks from a superseded paint (`digest !== this.patch.digest`).
   * @param {string} key
   * @param {import("./model.js").PatchRow[]} rows
   * @param {any} cx
   */
  onLineClick(key, rows, cx) {
    const parsed = parseRowKey(key);
    const sel = this.selected;
    const digest = this.patch?.digest ?? null;
    if (!parsed || !sel || !digest || parsed.digest !== digest) return;
    const row = rows.find((r) => r.kind === parsed.kind && r.old === parsed.oldLine && r.new === parsed.newLine);
    const anchor = anchorFromRow(sel, this.currentRangeInfo(), row, digest);
    if (!anchor) return;
    const existing = findCommentAtAnchor(this.worktreeComments(), anchor);
    this.editingComment = anchor;
    this.commentInput.set_value(existing?.body ?? "");
    this.commentInput.focus();
    this.note = null;
    cx.notify();
  }

  /** @param {any} cx */
  saveComment(cx) {
    const anchor = this.editingComment;
    const wtKey = this.worktreeKey();
    if (!anchor || !wtKey) return;
    const body = this.commentInput.value().trim();
    if (!body) return;
    const next = upsertComment(this.worktreeComments(), anchor, body, ++this.commentSeq);
    this.setWorktreeComments(wtKey, next);
    this.editingComment = null;
    this.commentInput.set_value("");
    this.note = null;
    cx.notify();
  }

  /** @param {any} cx */
  cancelComment(cx) {
    this.editingComment = null;
    this.commentInput.set_value("");
    cx.notify();
  }

  /** @param {string} id @param {any} cx */
  deleteComment(id, cx) {
    const wtKey = this.worktreeKey();
    if (!wtKey) return;
    this.setWorktreeComments(wtKey, removeComment(this.worktreeComments(), id));
    cx.notify();
  }

  /** @param {any} cx */
  clearComments(cx) {
    const wtKey = this.worktreeKey();
    if (!wtKey) return;
    this.commentsByWorktree.delete(wtKey);
    this.editingComment = null;
    this.commentInput.set_value("");
    this.note = null;
    cx.notify();
  }

  /** @param {DraftComment} comment @param {any} cx */
  jumpToComment(comment, cx) {
    const view = this.view;
    if (!view) return;
    const needScope = scopeForSection(comment.section);
    if (!sectionsForScope(this.scope).includes(comment.section)) {
      this.scope = needScope;
    }
    const row = view.sections[comment.section].find((r) => r.path === comment.path);
    if (row) {
      this.selected = selectionOf(row);
      this.patch = null;
      this.wantPatch(0);
    }
    cx.notify();
  }

  /**
   * Fetches the full unified patch for one commented target during preflight (even when unselected).
   * @param {string | null} machine
   * @param {string} top
   * @param {FilesView | null} viewSnapshot
   * @param {DraftComment} sample
   * @returns {Promise<import("./comments.js").PreflightPatchResult>}
   */
  async preflightFetchTarget(machine, top, viewSnapshot, sample) {
    let oldPath = sample.oldPath;
    let untracked = sample.untracked;
    let from = sample.from;
    let to = sample.to;

    if (viewSnapshot) {
      const liveRow = viewSnapshot.sections[sample.section].find((r) => r.path === sample.path);
      if (liveRow) {
        oldPath = liveRow.oldPath;
        untracked = liveRow.untracked;
      }
    }

    if (sample.section === "committed") {
      const sameBase =
        viewSnapshot &&
        (sample.base ?? null) === (viewSnapshot.base.ref ?? null) &&
        sample.mode === viewSnapshot.base.mode &&
        Boolean(viewSnapshot.base.from) &&
        Boolean(viewSnapshot.place.head);
      if (sameBase && viewSnapshot) {
        from = viewSnapshot.base.from;
        to = viewSnapshot.place.head;
      } else {
        const fArgs = filesArgs(top, { ref: sample.base, mode: sample.mode }, null);
        const fAns = await this.helper.call(machine, fArgs);
        if (fAns.ok) {
          const freshView = viewFiles(fAns.lines);
          if (freshView?.base.from && freshView.place.head) {
            from = freshView.base.from;
            to = freshView.place.head;
          }
        }
      }
    }

    const sel = { section: sample.section, path: sample.path, oldPath, untracked };
    const args0 = patchArgs(top, sel, { from, to }, 0);
    if (!args0) {
      return { ok: false, missing: true, error: "missing commit range" };
    }
    const ans0 = await this.helper.call(machine, args0);
    if (ans0.ok === false) {
      const missing = /no such file|does not exist|cannot open|not found/i.test(ans0.message);
      return { ok: false, missing, error: ans0.message };
    }
    const line0 = /** @type {any} */ (ans0.lines.find((l) => l.type === "diff-patch"));
    if (!line0 || typeof line0.digest !== "string") {
      return { ok: false, error: "bw diff patch printed no page" };
    }

    const digest = line0.digest;
    const total = Math.min(Number(line0.pages) || 1, 16);
    const pages = [{ text: String(line0.text ?? ""), cut: Array.isArray(line0.cut) ? line0.cut : [] }];
    for (let page = 1; page < total; page++) {
      const pArgs = patchArgs(top, sel, { from, to }, page);
      if (!pArgs) break;
      const ansP = await this.helper.call(machine, pArgs);
      if (ansP.ok === false) return { ok: false, error: ansP.message };
      const lineP = /** @type {any} */ (ansP.lines.find((l) => l.type === "diff-patch"));
      if (!lineP || lineP.digest !== digest) {
        return { ok: false, error: `${sample.path} changed during preflight; try sending again.` };
      }
      pages.push({ text: String(lineP.text ?? ""), cut: Array.isArray(lineP.cut) ? lineP.cut : [] });
    }

    const joined = joinPages(pages);
    return { ok: true, digest, rows: patchRows(joined.text, joined.cut) };
  }

  /**
   * Runs multi-file preflight verification and sends or queues the structured markdown review block.
   * Clears draft comments only after `sent` or `queued` succeeds.
   * @param {any} cx
   */
  sendComments(cx) {
    const wtKey = this.worktreeKey();
    const comments = this.worktreeComments();
    const top = this.tab ? this.tab.top : (this.view?.place.top ?? null);
    const machine = this.machine();
    const viewSnapshot = this.view;
    const target = this.agentTarget;
    if (!wtKey || !top || comments.length === 0) return;

    this.act(
      "diff-send-comments",
      async () => {
        const preflight = await preflightVerifyComments(comments, (sample) =>
          this.preflightFetchTarget(machine, top, viewSnapshot, sample),
        );
        this.setWorktreeComments(wtKey, preflight.next);
        if (preflight.ok === false) {
          return preflight.message;
        }
        if (!target) {
          return "Open a Claude or Codex tab in this space to send review comments.";
        }

        const cardsRes = await this.helper.call(target.machine, [
          "cards",
          "--terminal",
          target.local,
          "--kind",
          target.kind,
        ]);
        if (cardsRes.ok === false) {
          return `Could not verify agent session: ${cardsRes.message}`;
        }
        const cardsLine = cardsRes.lines.find((/** @type {any} */ l) => l?.type === "cards") ?? null;
        const stateLine = cardsRes.lines.find((/** @type {any} */ l) => l?.type === "state") ?? null;
        const expect = cardsExpect(cardsLine, stateLine, target.kind);
        if (!expect) {
          return "Wait for the agent session to finish starting before sending comments.";
        }

        const count = preflight.next.length;
        const noun = count === 1 ? "comment" : "comments";
        if (target.status === "working") {
          const qArgs = ["queue", "add", "--terminal", target.local, "--kind", target.kind];
          if (expect.session !== "none") qArgs.push("--session", expect.session);
          qArgs.push("--text", preflight.markdown);
          const qRes = await this.helper.call(target.machine, qArgs);
          const qLine = qRes.ok ? qRes.lines.find((/** @type {any} */ l) => l?.type === "queue") : null;
          if (!qLine) {
            const err = qRes.ok ? qRes.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
            const why = qRes.ok === true ? String(err?.message || "bw queue add failed") : qRes.message;
            return `Not queued: ${why}`;
          }
          this.commentsByWorktree.delete(wtKey);
          this.editingComment = null;
          this.commentInput.set_value("");
          return `Queued ${count} ${noun}`;
        }

        const sRes = await this.helper.call(target.machine, [
          "send",
          "--terminal",
          target.local,
          "--expect-kind",
          target.kind,
          "--expect-session",
          expect.session,
          "--expect-path",
          expect.path,
          "--text",
          preflight.markdown,
        ]);
        const sLine = sRes.ok ? sRes.lines.find((/** @type {any} */ l) => l?.type === "send") : null;
        if (sLine?.result !== "sent") {
          const why = sRes.ok === true ? String(sLine?.message || sLine?.result || "bw send failed") : sRes.message;
          return `Not sent: ${why}`;
        }
        this.commentsByWorktree.delete(wtKey);
        this.editingComment = null;
        this.commentInput.set_value("");
        return `Sent ${count} ${noun}`;
      },
      cx,
    );
  }

  /** @param {import("./model.js").Row} row @param {any} cx */
  pick(row, cx) {
    this.note = null;
    if (selKey(this.selected) === selKey(selectionOf(row))) {
      // Clicking the selected row again retries a failed read, which a refresh skips while the digest holds.
      if (this.patch?.error && !this.patch.loading) {
        this.wantPatch(0);
        cx.notify();
      }
      return;
    }
    this.selected = selectionOf(row);
    this.patch = null;
    this.editingComment = null;
    this.wantPatch(0);
    cx.notify();
  }

  /** @param {string} id @param {(cx: any) => Promise<string | null>} work @param {any} cx */
  act(id, work, cx) {
    if (this.busy) return;
    this.busy = id;
    this.note = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      let text;
      try {
        text = await work(cx);
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      this.busy = null;
      if (text !== null) this.note = text;
      cx.notify();
    });
  }

  /** @param {any} cx */
  fetch(cx) {
    const view = this.view;
    if (!view) return;
    const args = ["diff", "fetch", "--path", view.place.top];
    if (view.base.ref && view.base.source !== "none") args.push("--base", view.base.ref);
    this.act(
      "diff-fetch",
      async () => {
        const r = await this.helper.call(this.machine(), args);
        this.nonce++;
        this.picker.refs = null;
        if (this.picker.open) this.wantRefs();
        if (r.ok === false) return `Fetch failed: ${r.message}`;
        const done = /** @type {any} */ (r.lines.find((l) => l.type === "diff-fetched"));
        return `Fetched ${done?.remote ?? "origin"}`;
      },
      cx,
    );
  }

  /** @param {BaseChoice} choice @param {string | null | undefined} [project] the shown project's by default */
  storeBase(choice, project = this.want?.project) {
    if (!project) return;
    setShared(BASE_KEY, writeBase(shared(BASE_KEY), project, choice));
  }

  /** @param {any} cx */
  openPicker(cx) {
    this.picker.open = !this.picker.open;
    this.picker.error = null;
    if (this.picker.open) {
      this.filter.focus();
      this.wantRefs();
    }
    cx.notify();
  }

  wantRefs() {
    this.refsWanted = true;
    this.work.poke();
  }

  /** @param {any} cx */
  async loadRefs(cx) {
    const top = this.view?.place.top;
    if (!top || this.picker.loading) return;
    const machine = this.machine();
    this.picker.loading = true;
    cx.notify();
    const r = await this.helper.call(machine, ["diff", "refs", "--path", top]);
    this.picker.loading = false;
    if (this.view?.place.top !== top || this.machine() !== machine) return;
    if (r.ok === false) this.picker.error = r.message;
    else this.picker.refs = r.lines.filter((l) => l.type === "diff-ref");
    cx.notify();
  }

  /** @param {string | null} ref */
  chooseRef(ref) {
    this.storeBase({ ref, mode: this.want?.branchBase.mode ?? "merge-base" });
    this.picker.open = false;
    this.filter.set_value("");
    this.note = null;
  }

  /**
   * Enter in the picker: a name only one listed ref has is taken as that ref; anything else is checked
   * first, and stored for the project it was typed in even when the space changed meanwhile.
   * @param {any} cx
   */
  submitRef(cx) {
    const text = this.filter.value().trim();
    const top = this.view?.place.top;
    const project = this.want?.project;
    if (!text || !top || !project) return;
    const listed = (this.picker.refs ?? []).filter((r) => r.name === text || r.ref === text);
    if (listed.length === 1) {
      this.chooseRef(String(listed[0].ref ?? listed[0].name));
      return cx.notify();
    }
    const machine = this.machine();
    const mode = this.want?.branchBase.mode ?? "merge-base";
    this.act(
      "diff-verify",
      async () => {
        const r = await this.helper.call(machine, ["diff", "refs", "--path", top, "--verify", text]);
        const here = this.want?.project === project;
        if (r.ok === false) {
          if (here) this.picker.error = r.message;
          return null;
        }
        if (here) this.chooseRef(text);
        else this.storeBase({ ref: text, mode }, project);
        return null;
      },
      cx,
    );
  }

  /** Opens the selected file's patch as a middle tab in the active space. */
  openTab() {
    const sel = this.selected;
    const view = this.view;
    const space = this.space;
    if (!sel || !view || !space) return;
    const id = shared(WINDOW_ID);
    run("tab.new", {
      name: `${splitPath(sel.path).name} · diff`,
      space: space.id,
      mod: "bw-diff",
      props: {
        tab: true,
        space: space.id,
        machine: space.machine,
        window: typeof id === "string" && id ? id : null,
        top: view.place.top,
        section: sel.section,
        file: sel.path,
        old: sel.oldPath,
        untracked: sel.untracked,
        from: sel.section === "committed" ? view.base.from : null,
        to: sel.section === "committed" ? view.place.head : null,
        base: view.base.ref,
        mode: view.base.mode,
      },
    });
  }

  /** @param {string} section @param {any} cx */
  fold(section, cx) {
    if (!this.folded.delete(section)) this.folded.add(section);
    try {
      localStorage.setItem(FOLDED, JSON.stringify([...this.folded]));
    } catch {}
    cx.notify();
  }

  /**
   * Resolves the open PR for `space` when available (`this.prState` first, else `shared("bw.pr-summary")`).
   * @param {any} space
   * @param {string | null} folder
   * @param {string | null} machine
   * @returns {PrSummary | null}
   */
  openPrFor(space, folder, machine) {
    if (!space || !folder) return null;
    const branch = this.view?.place.branch ?? (typeof space.branch === "string" ? space.branch : null);
    const head = this.view?.place.head ?? null;
    const prKey = branch ? JSON.stringify([machine, folder, branch]) : "";
    if (prKey && this.prState.key === prKey) {
      return this.prState.pr;
    }
    const summaryMap = shared(PR_SUMMARY);
    const sharedEntry = summaryMap && typeof summaryMap === "object" ? /** @type {any} */ (summaryMap)[space.id] : null;
    const sharedHeadOid = typeof sharedEntry?.headOid === "string" ? sharedEntry.headOid : null;
    if (isOpenPr(sharedEntry)) {
      if (!head || !sharedHeadOid || sharedHeadOid === head) {
        return sharedEntry;
      }
    }
    return null;
  }

  /** Reads live data, sets the refresh target, applies a waiting reveal. */
  update() {
    const shown = isShown(layout());
    const allSpaces = spaces();
    const allPanes = panes();
    const allAgents = agents();
    const space = allSpaces.find((s) => s.active) ?? null;
    const machine = space?.machine ?? null;
    const folder = space ? placeOf(space, allPanes) : null;
    this.space = space ? { id: space.id, machine } : null;
    this.agentTarget = resolveSpaceAgent(space, allPanes, allAgents, shared("bw.chat-tabs"), shared(CHAT_AGENT));

    const folderKey = folder ? JSON.stringify([machine, folder]) : null;
    if (folderKey !== this.folderKey) {
      this.folderKey = folderKey;
      this.answered = false;
      this.view = null;
      this.viewAt = 0;
      this.failure = null;
      this.selected = null;
      this.patch = null;
      this.editingComment = null;
      this.picker = { open: false, refs: null, loading: false, error: null };
      this.note = null;
    }
    const commonDir = folderKey ? (this.commonDirs.get(folderKey) ?? null) : null;
    const project = commonDir ? projectKey(machine, commonDir) : null;
    const branchBase = project ? readBase(shared(BASE_KEY), project) : readBase(null, "");
    const openPr = this.openPrFor(space, folder, machine);
    const prChoice = this.scope === "pr" ? prBaseChoice(openPr, branchBase) : null;
    const base = prChoice ? { ref: prChoice.ref, mode: prChoice.mode } : branchBase;
    const fromPr = Boolean(prChoice?.fromPr);
    this.want = folder ? { machine, folder, base, branchBase, fromPr, project } : null;

    if (shown && this.scope === "pr" && space && folder) {
      const branch = this.view?.place.branch ?? (typeof space.branch === "string" ? space.branch : null);
      const head = this.view?.place.head ?? null;
      if (branch && branch !== "HEAD") {
        const prKey = JSON.stringify([machine, folder, branch]);
        this.prQuery = {
          key: prKey,
          spaceId: space.id,
          machine,
          folder,
          branch,
          head,
          liveSpaces: allSpaces.map((s) => s.id),
        };
        if (this.prState.key !== prKey || Date.now() - this.prState.checkedAt > PR_TTL_MS) {
          this.prWanted = true;
        }
      }
    }

    // A reveal names a file the agent just changed: read the list again before looking for it.
    const reveal = space && shown ? revealFor(shared(REVEAL), space.id) : null;
    const pending = reveal !== null && reveal.at !== this.revealed;
    if (pending && this.viewAt < reveal.at && this.revealAsked !== reveal.at) {
      this.revealAsked = reveal.at;
      this.nonce++;
    }

    const key = folder ? JSON.stringify([machine, folder, base.ref, base.mode, this.nonce]) : null;
    const wanted = shown && key !== null;
    if (!wanted) {
      if (this.targeted) this.schedule?.setTargets([], Date.now());
      this.targeted = false;
      this.parked = false;
    } else {
      const top = this.view?.place.top ?? folder;
      const watch = machine === null ? [top, ...(commonDir ? [commonDir] : [])] : [];
      const target = {
        key: /** @type {string} */ (key),
        kind: /** @type {const} */ ("counts"),
        machine,
        path: /** @type {string} */ (folder),
        open: true,
        selected: true,
        wakeOn: watch,
        base,
      };
      // The schedule says whether anything changed; a parked loop needs a poke either way.
      const changed = this.schedule?.setTargets([target], Date.now());
      if (changed || this.parked || !this.targeted) this.poke?.poke();
      this.targeted = true;
      this.parked = false;
    }
    this.key = key;
    this.shown = shown;
    this.drawn = true;
    if (shown && (this.patchWanted || this.refsWanted || this.prWanted)) this.work.poke();

    const view = this.view;
    if (!space || !view || !project) return;
    const usesManualBase = this.scope === "branch" || (this.scope === "pr" && !fromPr);
    if (usesManualBase && view.base.source === "none" && !this.autoPicked.has(project) && !this.picker.open) {
      this.autoPicked.add(project);
      this.picker.open = true;
      this.wantRefs();
    }
    if (pending && this.viewAt >= reveal.at) {
      this.revealed = reveal.at;
      const row = rowFor(view, reveal.file);
      if (row) {
        this.note = null;
        if (!sectionsForScope(this.scope).includes(row.section)) {
          this.scope = scopeForSection(row.section);
        }
        this.selected = selectionOf(row);
        this.patch = null;
        this.editingComment = null;
        this.wantPatch(0);
      } else {
        this.note = `No changes in ${splitPath(reveal.file).name}`;
      }
      setShared(REVEAL, dropReveal(shared(REVEAL), space.id));
    }
  }

  render() {
    const t = themeColors();
    if (this.tab) return this.renderTab(t);
    this.update();
    const root = v_flex()
      .id("diff-root")
      .size_full()
      .bg(t.chrome)
      .text_size(13)
      .text_color(t.foreground)
      .on_size_change((/** @type {any} */ size, /** @type {any} */ cx) => {
        if (Math.abs((size?.height ?? 0) - this.height) < 1) return;
        this.height = size.height;
        cx.notify();
      });
    const view = this.view;
    if (!this.space) return root.child(this.state(t, "No space is open"));
    root.child(this.header(t, view));
    if (this.picker.open && view) root.child(this.pickerCard(t, view));
    if (this.note) root.child(this.noteLine(t, this.note));
    if (!view) {
      const f = this.failure;
      const text = !f
        ? "Reading changes…"
        : /not in a Git worktree/.test(f.message)
          ? "Not a Git repository"
          : f.message;
      return root.child(this.state(t, text));
    }
    if (this.failure) root.child(this.noteLine(t, this.failure.message));
    const showPatch = this.selected !== null;
    const shownSections = sectionsForScope(this.scope);
    const list = v_flex()
      .id("diff-list")
      .min_h(0)
      .overflow_y_scroll()
      .p(6)
      .gap(2)
      .when(showPatch, (el) => el.flex_none().max_h(Math.max(120, Math.round(this.height * 0.36))))
      .when(!showPatch, (el) => el.flex_1());
    for (const s of shownSections) for (const el of this.section(t, view, s)) list.child(el);
    root.child(list);
    if (showPatch) root.child(this.patchPane(t));
    const reviewBar = this.reviewBatchBar(t);
    if (reviewBar) root.child(reviewBar);
    return root;
  }

  /** @param {Theme} t @param {string} text */
  state(t, text) {
    return v_flex()
      .id("diff-state")
      .flex_1()
      .items_center()
      .justify_center()
      .px(24)
      .text_size(13)
      .text_color(t.muted)
      .child(div().text_center().child(text));
  }

  /** @param {Theme} t @param {string} text */
  noteLine(t, text) {
    return h_flex()
      .id("diff-note")
      .flex_none()
      .px(12)
      .pt(8)
      .justify_center()
      .child(
        div()
          .max_w_full()
          .h(26)
          .px(12)
          .flex()
          .items_center()
          .rounded(13)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.foreground)
          .truncate()
          .child(text),
      );
  }

  /** @param {Theme} t @param {FilesView | null} view */
  header(t, view) {
    const base = view?.base;
    const branch = view ? (view.place.branch ?? (view.place.head ? view.place.head.slice(0, 7) : "no commits")) : "…";
    const baseName = base?.ref ? shortRef(base.ref) : "pick a base";
    const age = base?.time != null ? ago(base.time * 1000, Date.now()) : null;
    const meta = base?.short ? `${base.short}${age ? ` · ${age}` : ""}` : "";
    const ready = view !== null && this.want?.project != null;
    const fromPr = Boolean(this.want?.fromPr);
    const canPickBase = ready && !fromPr;
    const mode = base?.mode ?? "merge-base";
    return v_flex()
      .id("diff-header")
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(34)
          .px(12)
          .gap(8)
          .items_center()
          .child(
            h_flex()
              .id("diff-scopes")
              .h(24)
              .p(2)
              .gap(2)
              .items_center()
              .rounded(10)
              .bg(t.raised)
              .children(
                SCOPES.map((sc) => {
                  const on = this.scope === sc;
                  return h_flex()
                    .id(`diff-scope-${sc}`)
                    .h(20)
                    .px(9)
                    .items_center()
                    .rounded(8)
                    .text_size(11.5)
                    .text_color(on ? t.foreground : t.muted)
                    .when(on, (el) => el.bg(t.selected).font_medium())
                    .when(!on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
                    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.setScope(sc, cx))
                    .child(SCOPE_LABEL[sc]);
                }),
              ),
          )
          .child(div().flex_1())
          .child(
            button(t, {
              id: "diff-fetch",
              icon:
                this.busy === "diff-fetch"
                  ? spinner(t, 12)
                  : svg(icon("fetch")).size(13).flex_none().text_color(t.muted),
              label: "Fetch",
              h: 24,
              enabled: ready && this.busy === null,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.fetch(cx),
            }),
          ),
      )
      .child(
        h_flex()
          .h(32)
          .px(12)
          .gap(8)
          .items_center()
          .child(svg(ICONS.branch).size(13).flex_none().text_color(t.accent))
          .child(
            h_flex()
              .id("diff-base-button")
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .when(canPickBase, (el) => el.cursor_pointer())
              .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => canPickBase && this.openPicker(cx))
              .child(div().flex_none().max_w(120).truncate().text_size(12).font_medium().child(branch))
              .child(div().flex_none().text_color(t.muted).child("→"))
              .child(
                div()
                  .id("diff-base-name")
                  .min_w(0)
                  .truncate()
                  .text_size(12)
                  .font_medium()
                  .text_color(base?.ref ? t.foreground : t.muted)
                  .child(baseName),
              )
              .when(!fromPr, (el) => el.child(svg(ICONS["chevron-down"]).size(10).flex_none().text_color(t.dim)))
              .when(meta !== "", (el) =>
                el.child(div().id("diff-base-meta").flex_none().text_size(11).text_color(t.muted).child(meta)),
              ),
          )
          .when(!fromPr, (el) =>
            el.child(
              h_flex()
                .id("diff-mode")
                .h(22)
                .p(2)
                .gap(2)
                .flex_none()
                .items_center()
                .rounded(10)
                .bg(t.raised)
                .children(
                  /** @type {const} */ ([
                    ["merge-base", "Merge base"],
                    ["tip", "Tip"],
                  ]).map(([id, label]) => {
                    const on = mode === id;
                    return h_flex()
                      .id(`diff-mode-${id}`)
                      .h(18)
                      .px(8)
                      .items_center()
                      .rounded(8)
                      .text_size(11)
                      .text_color(on ? t.foreground : t.muted)
                      .when(on, (s) => s.bg(t.selected).font_medium())
                      .when(!on && ready, (s) =>
                        s.cursor_pointer().hover((h) => h.bg(t.hover).text_color(t.foreground)),
                      )
                      .on_click(() => {
                        if (!ready || on) return;
                        this.storeBase({ ref: this.want?.branchBase.ref ?? null, mode: id });
                      })
                      .child(label);
                  }),
                ),
            ),
          ),
      )
      .when(Boolean(base?.error), (el) =>
        el.child(div().px(12).pb(6).min_w(0).truncate().text_size(11).text_color(t.blocked).child(String(base?.error))),
      );
  }

  /** @param {Theme} t @param {FilesView} view */
  pickerCard(t, view) {
    const text = this.filter.value().trim().toLowerCase();
    const refs = (this.picker.refs ?? []).filter((r) => !text || String(r.name).toLowerCase().includes(text));
    const current = view.base.source === "typed" ? view.base.ref : null;
    /** @param {string} id @param {string} label @param {string} detail @param {boolean} on @param {() => void} onClick */
    const row = (id, label, detail, on, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .flex_none()
        .relative()
        .px(8)
        .gap(8)
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .on_hover((/** @type {boolean} */ h, /** @type {any} */ cx) => {
          const next = h ? id : this.hovered === id ? null : this.hovered;
          if (next === this.hovered) return;
          this.hovered = next;
          cx.notify();
        })
        .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
          onClick();
          cx.notify();
        })
        .child(hoverFill(t, `${id}-hover`, !on && this.hovered === id, 8))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(label))
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(on ? mutedOnSelected : t.muted)
            .child(detail),
        );
    const list = v_flex().id("diff-picker-list").max_h(220).overflow_y_scroll().gap(1);
    list.child(
      row("diff-ref-default", "Default", "origin/main, else origin/HEAD", current === null, () => this.chooseRef(null)),
    );
    for (const r of refs.slice(0, 80))
      list.child(
        row(
          `diff-ref-${r.kind}-${r.name}`,
          String(r.name),
          `${r.kind} · ${r.short}${typeof r.time === "number" ? ` · ${ago(r.time * 1000, Date.now())}` : ""}`,
          current === (r.ref ?? r.name),
          () => this.chooseRef(String(r.ref ?? r.name)),
        ),
      );
    return div()
      .flex_none()
      .px(8)
      .pt(8)
      .child(
        card(t, "diff-picker", { fill: "popover" })
          .p(6)
          .gap(6)
          .child(
            Input.new(this.filter)
              .id("diff-picker-input")
              .h(28)
              .px(8)
              .items_center()
              .rounded(8)
              .border(1)
              .border_color(t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground),
          )
          .when(view.base.source === "none", (el) =>
            el.child(
              div()
                .px(4)
                .text_size(11.5)
                .text_color(t.muted)
                .child("This repository has no origin/main or origin/HEAD. Pick a base for Committed on branch."),
            ),
          )
          .when(this.picker.error !== null, (el) =>
            el.child(div().px(4).text_size(11.5).text_color(t.blocked).child(String(this.picker.error))),
          )
          .when(this.picker.loading, (el) =>
            el.child(h_flex().px(4).gap(6).items_center().child(spinner(t, 12)).child("Reading refs…")),
          )
          .child(list),
      );
  }

  /** @param {Theme} t @param {FilesView} view @param {Section} s */
  section(t, view, s) {
    const rows = view.sections[s];
    const sum = totals(rows);
    const folded = this.folded.has(s);
    const title = s === "committed" && this.scope === "pr" && this.want?.fromPr ? "Committed in PR" : SECTION_TITLE[s];
    const head = h_flex()
      .id(`diff-section-${s}`)
      .h(28)
      .flex_none()
      .px(6)
      .gap(6)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.fold(s, cx))
      .child(
        svg(folded ? ICONS["chevron-right"] : ICONS["chevron-down"])
          .size(10)
          .flex_none()
          .text_color(t.dim),
      )
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.muted).child(title))
      .child(pill(t, String(rows.length + view.more[s]), "count", `diff-count-${s}`))
      .children(counts(t, sum.added, sum.removed, false, `diff-total-${s}`));
    /** @type {any[]} */
    const out = [head];
    if (folded) return out;
    if (s === "committed" && view.base.source === "none")
      out.push(this.hint(t, `diff-hint-${s}`, "Pick a base to compare the branch against"));
    else if (s === "committed" && view.base.error) out.push(this.hint(t, `diff-hint-${s}`, view.base.error));
    else if (!rows.length)
      out.push(this.hint(t, `diff-hint-${s}`, s === "committed" ? "No commits past the base" : "Nothing here"));
    for (const r of rows) out.push(this.fileRow(t, r));
    if (view.more[s]) out.push(this.hint(t, `diff-more-${s}`, `${view.more[s]} more files not listed`));
    return out;
  }

  /** @param {Theme} t @param {string} id @param {string} text */
  hint(t, id, text) {
    return div().id(id).h(24).flex_none().px(28).flex().items_center().text_size(11.5).text_color(t.muted).child(text);
  }

  /** @param {Theme} t @param {import("./model.js").Row} r */
  fileRow(t, r) {
    const on = selKey(this.selected) === selKey(selectionOf(r));
    const id = `diff-file-${r.section}-${r.path}`;
    const fileComments = this.worktreeComments().filter((c) => c.section === r.section && c.path === r.path);
    const hasStale = fileComments.some((c) => c.stale);
    return h_flex()
      .id(id)
      .h(26)
      .flex_none()
      .relative()
      .pl(10)
      .pr(6)
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .on_hover((/** @type {boolean} */ h, /** @type {any} */ cx) => {
        const next = h ? id : this.hovered === id ? null : this.hovered;
        if (next === this.hovered) return;
        this.hovered = next;
        cx.notify();
      })
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.pick(r, cx))
      .child(hoverFill(t, `${id}-hover`, !on && this.hovered === id, 8))
      .when(on, (el) =>
        el.child(div().id(`${id}-bar`).absolute().left(0).top(6).bottom(6).w(2).rounded(1).bg(t.accent)),
      )
      .child(
        div()
          .w(12)
          .flex_none()
          .text_size(11.5)
          .font_semibold()
          .text_color(letterColor(t, r.letter, on))
          .child(r.letter),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(div().flex_none().max_w_full().truncate().text_size(12.5).child(r.name))
          .when(r.dir !== "" || r.oldPath !== null, (el) =>
            el.child(
              div()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(on ? mutedOnSelected : t.muted)
                .child(r.oldPath ? `from ${r.oldPath}` : r.dir),
            ),
          ),
      )
      .when(fileComments.length > 0, (el) =>
        el.child(
          pill(
            t,
            hasStale ? `${fileComments.length} stale` : String(fileComments.length),
            hasStale ? "blocked" : "accent",
            `${id}-comments`,
          ),
        ),
      )
      .when(r.binary, (el) =>
        el.child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(on ? mutedOnSelected : t.muted)
            .child("binary"),
        ),
      )
      .children(r.binary ? [] : counts(t, r.added, r.removed, on, `${id}-counts`));
  }

  /**
   * Retained `InputState` composer bar mounted below `v_virtual_list` when a diff line is selected.
   * @param {Theme} t
   */
  commentComposerBar(t) {
    const anchor = this.editingComment;
    if (!anchor) return null;
    const existing = findCommentAtAnchor(this.worktreeComments(), anchor);
    const canSave = this.commentInput.value().trim() !== "";
    return v_flex()
      .id("diff-comment-bar")
      .flex_none()
      .px(10)
      .py(8)
      .gap(6)
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome)
      .on_key_down((/** @type {any} */ e, /** @type {any} */ cx) => {
        const key = String(e?.keystroke?.key ?? e?.key ?? "").toLowerCase();
        if (key === "escape") {
          cx.stop_propagation?.();
          this.cancelComment(cx);
        }
      })
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .flex_none()
              .text_size(11.5)
              .font_medium()
              .text_color(t.accent)
              .child(`${anchor.path}:${anchor.line} (${anchor.side})`),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.muted)
              .child(anchor.excerpt || " "),
          )
          .when(Boolean(existing), (el) =>
            el.child(
              button(t, {
                id: "diff-comment-remove",
                label: "Remove",
                kind: "ghost",
                h: 22,
                onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) =>
                  existing && this.deleteComment(existing.id, cx),
              }),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            Input.new(this.commentInput)
              .id("diff-comment-input")
              .flex_1()
              .h(28)
              .px(8)
              .items_center()
              .rounded(8)
              .border(1)
              .border_color(t.input)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground),
          )
          .child(
            button(t, {
              id: "diff-comment-cancel",
              label: "Cancel",
              kind: "ghost",
              h: 26,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.cancelComment(cx),
            }),
          )
          .child(
            button(t, {
              id: "diff-comment-save",
              label: "Save",
              kind: "primary",
              h: 26,
              enabled: canSave,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.saveComment(cx),
            }),
          ),
      );
  }

  /**
   * Per-worktree draft comment summary and `Send N comments` / `Queue N comments` bar mounted outside `v_virtual_list`.
   * @param {Theme} t
   */
  reviewBatchBar(t) {
    const comments = this.worktreeComments();
    if (comments.length === 0) return null;
    const staleCount = comments.filter((c) => c.stale).length;
    const queueMode = this.agentTarget?.status === "working";
    const verb = queueMode ? "Queue" : "Send";
    const countLabel = `${verb} ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
    const sending = this.busy === "diff-send-comments";
    return v_flex()
      .id("diff-review-bar")
      .flex_none()
      .px(10)
      .py(8)
      .gap(6)
      .border_t(1)
      .border_color(staleCount > 0 ? t.blocked : t.border)
      .bg(t.chrome)
      .child(
        v_flex()
          .id("diff-drafts-list")
          .max_h(96)
          .overflow_y_scroll()
          .gap(3)
          .children(
            comments.map((c, idx) =>
              h_flex()
                .id(`diff-draft-${idx}`)
                .h(22)
                .px(6)
                .gap(6)
                .items_center()
                .rounded(6)
                .bg(t.raised)
                .child(
                  h_flex()
                    .id(`diff-draft-jump-${idx}`)
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .cursor_pointer()
                    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.jumpToComment(c, cx))
                    .child(
                      div()
                        .flex_none()
                        .text_size(11)
                        .font_medium()
                        .text_color(c.stale ? t.blocked : t.foreground)
                        .child(`${splitPath(c.path).name}:${c.line}`),
                    )
                    .when(c.stale, (el) => el.child(pill(t, "stale", "blocked", `diff-draft-stale-${idx}`)))
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(c.body)),
                )
                .child(
                  h_flex()
                    .id(`diff-draft-remove-${idx}`)
                    .size(18)
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(5)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.deleteComment(c.id, cx))
                    .child(svg(ICONS.close).size(9).text_color(t.muted)),
                ),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11.5)
              .text_color(staleCount > 0 ? t.blocked : t.muted)
              .child(
                staleCount > 0
                  ? `${staleCount} stale ${staleCount === 1 ? "anchor" : "anchors"}`
                  : `${comments.length} draft ${comments.length === 1 ? "comment" : "comments"}`,
              ),
          )
          .child(
            button(t, {
              id: "diff-comments-clear",
              label: "Clear",
              kind: "ghost",
              h: 26,
              enabled: this.busy === null,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.clearComments(cx),
            }),
          )
          .child(
            button(t, {
              id: "diff-comments-send",
              icon: sending ? spinner(t, 12) : undefined,
              label: countLabel,
              kind: "primary",
              h: 26,
              enabled: this.busy === null,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.sendComments(cx),
            }),
          ),
      );
  }

  /** @param {Theme} t */
  patchPane(t) {
    const sel = /** @type {Selection} */ (this.selected);
    const active =
      this.editingComment && this.editingComment.section === sel.section && this.editingComment.path === sel.path
        ? { side: this.editingComment.side, line: this.editingComment.line }
        : null;
    return patchView(t, {
      id: "diff-patch",
      title: sel.path,
      detail: SECTION_TITLE[sel.section],
      patch: this.patch?.key === this.patchSource()?.key ? this.patch : null,
      comments: this.selectedFileComments(),
      activeLine: active,
      onLineClick: (key, rows, cx) => this.onLineClick(key, rows, cx),
      composer: this.commentComposerBar(t),
      onMore: (cx) => {
        if (!this.patch || this.patch.loading) return;
        this.wantPatch(this.patch.pages.length);
        cx.notify();
      },
      actions: [
        button(t, {
          id: "diff-open-tab",
          icon: svg(icon("open-tab")).size(13).flex_none().text_color(t.muted),
          label: "Open as tab",
          h: 24,
          onClick: () => this.openTab(),
        }),
      ],
    });
  }

  /** A diff opened as a tab: finds its machine, loads once, and again on Refresh. @param {Theme} t */
  renderTab(t) {
    const tab = /** @type {import("./model.js").TabProps} */ (this.tab);
    const allSpaces = spaces();
    const where = tabMachine(tab, /** @type {string | null} */ (shared(WINDOW_ID) ?? null), allSpaces);
    const root = v_flex().id("diff-tab").size_full().bg(t.background).text_size(13).text_color(t.foreground);
    if (!where.ok) return root.child(this.state(t, "Open this diff again from Changes in this window"));
    if (!this.tabReady) {
      this.tabReady = true;
      this.tabMachineName = where.machine;
      this.selected = { section: tab.section, path: tab.file, oldPath: tab.old, untracked: tab.untracked };
      this.wantPatch(0);
    }
    const detail = [
      SECTION_TITLE[tab.section],
      tab.section === "committed" && tab.base ? `${tab.mode === "tip" ? "tip of" : "since"} ${tab.base}` : null,
      // The range pinned at open, which Refresh reads again: a later commit or base move is not in this tab.
      tab.section === "committed" && tab.from && tab.to ? `${tab.from.slice(0, 7)}..${tab.to.slice(0, 7)}` : null,
      this.tabMachineName,
    ]
      .filter(Boolean)
      .join(" · ");
    return root.child(
      patchView(t, {
        id: "diff-tab-patch",
        title: tab.file,
        detail,
        patch: this.patch,
        onMore: (cx) => {
          if (!this.patch || this.patch.loading) return;
          this.wantPatch(this.patch.pages.length);
          cx.notify();
        },
        actions: [
          button(t, {
            id: "diff-tab-refresh",
            label: "Refresh",
            h: 24,
            enabled: !this.patch?.loading,
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
              this.patch = this.patch ? { ...this.patch, pages: [] } : null;
              this.wantPatch(0);
              cx.notify();
            },
          }),
        ],
      }),
    );
  }
}
