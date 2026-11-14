// Cross-agent `Needs you` / `Whose move` triage screen: 300 px grouped list on the left (`Needs you`,
// `Ready to land`, `Working`, `Idle`) and 680 px live inline detail on the right (`1-9` shortcuts,
// `Other...` input, 3 s `focus-guard`, `Waiting in terminal` fallback, and PR skill buttons).
import { View, div, svg } from "gpui-kit";
import { InputState, h_flex, v_flex } from "gpui-base";
import { agents, exec, focused, home, layout, nextCommand, panes, run, setShared, shared, spaces } from "herdr";
import {
  CHAT_AGENT,
  PR_SUMMARY,
  SCREEN_KEY,
  TAB_VIEW,
  TERMINAL_FOCUS,
  leftAt,
  pinTabAgent,
  writeTabView,
} from "./chat-tabs.js";
import { choose } from "./choice.js";
import { requestCard } from "./dock.js";
import {
  answerArgs,
  answerNote,
  answersOf,
  cardsExpect,
  complete,
  digit,
  dockCards,
  emptyDraft,
  pick,
  setOther,
  toggle,
} from "./dock-model.js";
import { createGuard, guardedUntil, isGuarded, observe, observeLeft } from "./focus-guard.js";
import { headOid, remoteOrigin } from "./git.js";
import { createHelper, parseLines } from "./helper.js";
import { buildNeedsModel } from "./model.js";
import {
  babysitCommand,
  isMergeReady,
  mergeCommand,
  parsePrLines,
  prNeedsAttention,
  prStatusArgs,
  toSharedPrEntry,
  updateSharedPrSummary,
} from "./pr-model.js";
import { createPoke } from "./refresh-driver.js";
import {
  ICONS,
  button,
  findLayout,
  hoverFill,
  machineTag,
  monogram,
  mutedOnSelected,
  pill,
  programIcon,
  statusMark,
  themeColors,
} from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./dock-model.js").Card} Card */
/** @typedef {import("./dock-model.js").Draft} Draft */
/** @typedef {import("./dock-model.js").Request} Request */
/** @typedef {import("./model.js").NeedsRow} NeedsRow */
/** @typedef {import("./pr-model.js").PrSummary} PrSummary */
/** @typedef {import("./pr-model.js").SharedPrEntry} SharedPrEntry */

const RIGHT_TAB = "bw.right.tab";
const CARDS_SELECTED_MS = 2000;
const CARDS_BLOCKED_MS = 4000;
const COUNTS_POLL_MS = 10_000;
const PR_SHOWN_MS = 10_000;
const PR_HIDDEN_MS = 30_000;
const COUNTS_PER_CALL = 24;
const WENT_OUT = new Set(["answered", "declined", "sent", "uncertain", "already-answered"]);
const NO_KEYS_WITH = ["control", "alt", "platform", "function"];

/**
 * @typedef {object} TerminalState
 * @property {string} terminal
 * @property {string} local
 * @property {string | null} machine
 * @property {import("./focus-guard.js").Guard} guard
 * @property {boolean} drawnGuarded
 * @property {boolean} cardsLoaded
 * @property {number} cardsCheckedAt
 * @property {Record<string, any> | null} cards
 * @property {Record<string, any> | null} stateLine
 * @property {Request[]} requests
 * @property {Map<string, Draft>} drafts
 * @property {Map<string, string>} answerNotes
 * @property {Set<string>} sendingIds
 * @property {Set<string>} wentOut
 * @property {Set<string>} cardsShown
 * @property {string | null} otherKey
 * @property {boolean} skillBusy
 * @property {{ text: string, bad: boolean } | null} skillNote
 */

/** @param {string} terminal @param {string} local @param {string | null} machine @param {number} now @returns {TerminalState} */
function createTerminalState(terminal, local, machine, now) {
  return {
    terminal,
    local,
    machine,
    guard: createGuard(now),
    drawnGuarded: true,
    cardsLoaded: false,
    cardsCheckedAt: 0,
    cards: null,
    stateLine: null,
    requests: [],
    drafts: new Map(),
    answerNotes: new Map(),
    sendingIds: new Set(),
    wentOut: new Set(),
    cardsShown: new Set(),
    otherKey: null,
    skillBusy: false,
    skillNote: null,
  };
}

/** @param {Request[]} requests @returns {Request | null} */
function activeQuestionOf(requests) {
  const pending = (requests ?? []).filter(
    (r) => r.state === "pending" && r.answerable && (r.kind === "question" || r.kind === "question_async"),
  );
  return pending.at(-1) ?? null;
}

/** @param {Request[]} requests @returns {Request | null} */
function activeShortcutRequestOf(requests) {
  const q = activeQuestionOf(requests);
  if (q) return q;
  const pending = (requests ?? []).filter(
    (r) => r.state === "pending" && r.answerable && (r.kind === "approval" || r.kind === "prompt"),
  );
  return pending.at(-1) ?? null;
}

/** @param {PrSummary} pr @param {string | null} headOid @returns {{ text: string, tone: import("./ui.js").PillTone }} */
function prBadgeInfo(pr, headOid) {
  if ((pr.failing ?? 0) > 0) return { text: "CI failing", tone: "failed" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", tone: "blocked" };
  if ((pr.unresolvedThreads ?? 0) > 0) {
    return { text: `${pr.unresolvedThreads} thread${pr.unresolvedThreads === 1 ? "" : "s"}`, tone: "blocked" };
  }
  if (isMergeReady(pr, headOid)) return { text: "Ready to land", tone: "done" };
  if (pr.isDraft) return { text: "Draft", tone: "count" };
  if ((pr.pending ?? 0) > 0) return { text: "Checks pending", tone: "working" };
  return { text: "Open", tone: "count" };
}

/** @param {string | null} decision @returns {string} */
function reviewLabel(decision) {
  if (decision === "APPROVED") return "Approved";
  if (decision === "CHANGES_REQUESTED") return "Changes requested";
  if (decision === "REVIEW_REQUIRED") return "Review required";
  return "No blocking review";
}

export default class Needs extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    this.shown = false;
    this.rootFocus = cx.focus_handle();
    this.cardFocus = cx.focus_handle();
    this.pendingFocus = false;
    this.wantCardFocus = false;
    /** @type {"card" | "root" | null} */
    this.focusTarget = null;
    this.focusPoke = createPoke();
    /** @type {string | null} */
    this.selectedId = null;
    /** @type {string | null} */
    this.hoveredId = null;
    this.prBusy = false;
    /** @type {string[]} */
    this.liveTabIds = [];
    /** @type {string[]} */
    this.liveSpaceIds = [];
    /** @type {NeedsRow[]} */
    this.lastRows = [];
    /** @type {NeedsRow | null} */
    this.lastSelected = null;

    /** @type {Map<string, TerminalState>} */
    this.termStates = new Map();
    /** @type {Map<string, string | null>} */
    this.prevStatuses = new Map();
    /** @type {Record<string, { subagents: number, requests: number }>} */
    this.counts = {};
    /** @type {Map<string | null, number>} */
    this.countsCheckedAt = new Map();

    /** @type {Record<string, SharedPrEntry>} */
    this.prBySpace = {};
    /** @type {Map<string, { key: string, checkedAt: number, repoFolder: string | null, repo: string | null }>} */
    this.prMeta = new Map();

    /** @type {number | null} */
    this.guardWakeAt = null;
    this.poke = createPoke();
    const bw = `${home()}/.local/share/bellwether/helper/current/bw`;
    this.helper = createHelper({
      exec: /** @type {import("./helper.js").Exec} */ (exec),
      localInstall: async (machine) => {
        const r = await exec(bw, ["machine", "install", machine], { on: null });
        if (!r.stdout.trim()) throw new Error(r.stderr.trim() || `bw exited ${r.code}`);
        return parseLines(r.stdout);
      },
    });

    /**
     * Snapshot written exclusively by `render()` so background tasks never call Herdr live APIs.
     * @type {{
     *   selectedAgent: { terminal: string, local: string, machine: string | null, kind: "claude" | "codex", blocked: boolean } | null,
     *   blockedAgents: { terminal: string, local: string, machine: string | null, kind: "claude" | "codex" }[],
     *   machineTerminals: [string | null, { address: string, local: string }[]][],
     *   prSpaces: { spaceId: string, machine: string | null, folder: string, branch: string | null }[],
     * }}
     */
    this.snapshot = {
      selectedAgent: null,
      blockedAgents: [],
      machineTerminals: [],
      prSpaces: [],
    };

    this.other = InputState.new({ placeholder: "Other…" });
    this.other.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      const sel = this.lastSelected;
      if (!sel?.terminal) return;
      const st = this.termStates.get(sel.terminal);
      if (!st) return;
      const a = activeQuestionOf(st.requests);
      if (!a) return;
      const d = this.draftOf(st, a);
      st.drafts.set(a.id, setOther(d, d.step, this.other.value()));
      cx?.notify?.();
    });

    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        if ((await nextCommand()) !== "focus") continue;
        this.pendingFocus = true;
        cx.notify();
      }
    });

    cx.spawn(async () => {
      for (;;) {
        await this.focusPoke.wait();
        if (!this.alive) return;
        const target = this.focusTarget;
        this.focusTarget = null;
        if (target === "card") this.cardFocus.focus();
        else if (target === "root") this.rootFocus.focus();
      }
    });

    cx.spawn((/** @type {any} */ cx) => this.pollLoop(cx));
  }

  close() {
    this.alive = false;
    this.poke.poke();
    this.focusPoke.poke();
    this.other?.release?.();
  }

  /** @param {TerminalState} st @param {{ id: string, question?: any }} req @returns {Draft} */
  draftOf(st, req) {
    let d = st.drafts.get(req.id);
    if (!d) {
      d = emptyDraft(req.question);
      st.drafts.set(req.id, d);
    }
    return d;
  }

  /** @param {TerminalState} st */
  syncOther(st) {
    const a = activeQuestionOf(st.requests);
    const d = a ? this.draftOf(st, a) : null;
    const key = a && d ? `${st.terminal}:${a.id}:${d.step}` : null;
    const want = d ? (d.other[d.step] ?? "") : "";
    if (key === st.otherKey && this.other.value() === want) return;
    st.otherKey = key;
    this.other.set_value(want);
  }

  /** @returns {boolean} */
  refreshShown() {
    const s = shared(SCREEN_KEY);
    if (typeof s === "string" && s !== "needs") {
      this.shown = false;
    }
    return this.shown;
  }

  /** @param {any} cx */
  async pollLoop(cx) {
    while (this.alive) {
      const started = Date.now();
      const snap = this.snapshot;

      if (this.refreshShown()) {
        if (snap.selectedAgent) {
          const st = this.termStates.get(snap.selectedAgent.terminal);
          const interval = snap.selectedAgent.blocked ? CARDS_SELECTED_MS : COUNTS_POLL_MS;
          if (st && (!st.cardsLoaded || Date.now() - st.cardsCheckedAt >= interval)) {
            await this.readCards(st, cx);
          }
        }
        for (const b of snap.blockedAgents) {
          if (!this.alive || !this.refreshShown()) break;
          if (snap.selectedAgent?.terminal === b.terminal) continue;
          const st = this.termStates.get(b.terminal);
          if (st && (!st.cardsLoaded || Date.now() - st.cardsCheckedAt >= CARDS_BLOCKED_MS)) {
            await this.readCards(st, cx);
          }
        }
        for (const [machine, terms] of snap.machineTerminals) {
          if (!this.alive || !this.refreshShown()) break;
          const last = this.countsCheckedAt.get(machine) ?? 0;
          if (Date.now() - last >= COUNTS_POLL_MS) {
            await this.readMachineCounts(machine, terms, cx);
          }
        }
      }

      for (const sp of snap.prSpaces) {
        if (!this.alive) break;
        this.refreshShown();
        await this.maybeReadSpacePr(sp, Date.now(), cx);
      }

      if (!this.alive) break;
      const now = Date.now();
      if (this.guardWakeAt !== null && now >= this.guardWakeAt) {
        this.guardWakeAt = null;
        cx.notify();
      }
      const shownNow = this.refreshShown();
      const baseMs = shownNow
        ? snap.selectedAgent?.blocked || snap.blockedAgents.length > 0
          ? CARDS_SELECTED_MS
          : COUNTS_POLL_MS
        : PR_HIDDEN_MS;
      let waitMs = Math.max(250, baseMs - (now - started));
      if (this.guardWakeAt !== null && Number.isFinite(this.guardWakeAt)) {
        waitMs = Math.min(waitMs, Math.max(10, this.guardWakeAt - now));
      }
      await this.poke.wait(cx.sleep(waitMs));
      if (this.alive && this.guardWakeAt !== null && Date.now() >= this.guardWakeAt) {
        this.guardWakeAt = null;
        cx.notify();
      }
    }
  }

  /** @param {TerminalState} st @param {any} cx */
  async readCards(st, cx) {
    st.cardsCheckedAt = Date.now();
    const answer = await this.helper.call(st.machine, ["cards", "--terminal", st.local]);
    if (!answer.ok) return;
    const cards = answer.lines.find((/** @type {any} */ l) => l?.type === "cards") ?? null;
    const stateLine = answer.lines.find((/** @type {any} */ l) => l?.type === "state") ?? null;
    const requests = cards
      ? /** @type {Request[]} */ (
          answer.lines.filter((/** @type {any} */ l) => l?.type === "request" && typeof l.id === "string")
        )
      : [];
    const changed =
      !st.cardsLoaded ||
      JSON.stringify(cards) !== JSON.stringify(st.cards) ||
      JSON.stringify(stateLine) !== JSON.stringify(st.stateLine) ||
      JSON.stringify(requests) !== JSON.stringify(st.requests);
    st.cards = cards;
    st.stateLine = stateLine;
    st.requests = requests;
    st.cardsLoaded = true;
    const ids = new Set(requests.map((r) => r.id));
    for (const id of [...st.drafts.keys()]) if (!ids.has(id)) st.drafts.delete(id);
    for (const id of [...st.answerNotes.keys()]) if (!ids.has(id)) st.answerNotes.delete(id);
    const pending = new Set(requests.filter((r) => r.state === "pending").map((r) => r.id));
    for (const id of [...st.wentOut]) if (!pending.has(id)) st.wentOut.delete(id);
    if (this.lastSelected?.terminal === st.terminal) this.syncOther(st);
    if (changed) cx.notify();
  }

  /** @param {string | null} machine @param {{ address: string, local: string }[]} terminals @param {any} cx */
  async readMachineCounts(machine, terminals, cx) {
    this.countsCheckedAt.set(machine, Date.now());
    let changed = false;
    for (let i = 0; i < terminals.length; i += COUNTS_PER_CALL) {
      const part = terminals.slice(i, i + COUNTS_PER_CALL);
      const r = await this.helper.call(machine, ["counts", "--terminals", part.map((t) => t.local).join(",")], {
        install: false,
      });
      if (!r.ok) continue;
      const addrMap = new Map(part.map((t) => [t.local, t.address]));
      for (const l of r.lines) {
        const a = l?.type === "count" && typeof l.terminal === "string" ? addrMap.get(l.terminal) : undefined;
        if (!a) continue;
        const next = { subagents: Number(l.subagents) || 0, requests: Number(l.requests) || 0 };
        const prev = this.counts[a];
        if (prev?.subagents === next.subagents && prev?.requests === next.requests) continue;
        this.counts[a] = next;
        changed = true;
      }
    }
    if (changed) cx.notify();
  }

  /** @param {string} spaceId @param {any} [cx] */
  clearSpacePr(spaceId, cx) {
    const had = Boolean(this.prBySpace[spaceId]);
    delete this.prBySpace[spaceId];
    const nextSummary = updateSharedPrSummary(shared(PR_SUMMARY), spaceId, null, this.liveSpaceIds);
    if (nextSummary) setShared(PR_SUMMARY, nextSummary);
    if ((had || nextSummary) && cx) cx.notify();
  }

  /**
   * @param {{ spaceId: string, machine: string | null, folder: string, branch: string | null }} sp
   * @param {number} now
   * @param {any} cx
   */
  async maybeReadSpacePr(sp, now, cx) {
    const key = `${sp.machine ?? ""}\0${sp.folder}\0${sp.branch ?? ""}`;
    let meta = this.prMeta.get(sp.spaceId);
    if (!meta) {
      meta = { key: "", checkedAt: 0, repoFolder: null, repo: null };
      this.prMeta.set(sp.spaceId, meta);
    }
    const interval = this.shown ? PR_SHOWN_MS : PR_HIDDEN_MS;
    if (meta.key === key && meta.checkedAt > 0 && now - meta.checkedAt < interval) return;
    if (meta.key !== "" && meta.key !== key) {
      this.clearSpacePr(sp.spaceId, cx);
    }
    meta.key = key;
    meta.checkedAt = now;

    if (!sp.folder || !sp.branch || sp.branch === "HEAD") {
      this.clearSpacePr(sp.spaceId, cx);
      return;
    }

    const stillCurrent = () => {
      const latest = this.snapshot.prSpaces.find((x) => x.spaceId === sp.spaceId);
      return Boolean(latest && `${latest.machine ?? ""}\0${latest.folder}\0${latest.branch ?? ""}` === key);
    };

    const folderKey = `${sp.machine ?? ""}\0${sp.folder}`;
    if (meta.repoFolder !== folderKey) {
      const origin = await remoteOrigin(exec, sp.machine, sp.folder);
      if (!stillCurrent()) return;
      if (!origin.ok) return;
      meta.repoFolder = folderKey;
      meta.repo = origin.repo;
    }
    if (!meta.repo) {
      this.clearSpacePr(sp.spaceId, cx);
      return;
    }

    const head = await headOid(exec, sp.machine, sp.folder);
    if (!stillCurrent()) return;
    const oid = head.ok ? head.oid : null;
    const args = prStatusArgs(meta.repo, sp.branch, oid);
    if (!args) return;
    const answer = await this.helper.call(null, args);
    if (!stillCurrent() || !answer.ok) return;
    const parsed = parsePrLines(answer.lines);
    if (!parsed.ok) return;

    const entry = toSharedPrEntry(parsed.pr, oid);
    const prev = this.prBySpace[sp.spaceId] ?? null;
    const changed = JSON.stringify(entry) !== JSON.stringify(prev);
    if (entry) this.prBySpace[sp.spaceId] = entry;
    else delete this.prBySpace[sp.spaceId];
    const nextSummary = updateSharedPrSummary(shared(PR_SUMMARY), sp.spaceId, entry, this.liveSpaceIds);
    if (nextSummary) setShared(PR_SUMMARY, nextSummary);
    if (changed) cx.notify();
  }

  /** @param {NeedsRow} row */
  openChat(row) {
    if (!row.tabId) return;
    if (row.isAgent && row.terminal) {
      setShared(CHAT_AGENT, pinTabAgent(shared(CHAT_AGENT), row.tabId, row.terminal, this.liveTabIds));
      run("agent.focus", { terminal: row.terminal });
    }
    setShared(TAB_VIEW, writeTabView(shared(TAB_VIEW), row.tabId, "chat", this.liveTabIds));
    if (!row.spaceActive) run("space.select", { id: row.spaceId });
    if (!row.tabActive) run("tab.select", { id: row.tabId });
    setShared(SCREEN_KEY, "chat");
    run("layout.select", { stack: "screen", child: "chat" });
    run("bw-chat.focus");
  }

  /** @param {NeedsRow} row */
  openTerminal(row) {
    if (row.tabId) {
      setShared(TAB_VIEW, writeTabView(shared(TAB_VIEW), row.tabId, "panes", this.liveTabIds));
    }
    if (!row.spaceActive) run("space.select", { id: row.spaceId });
    if (row.tabId && !row.tabActive) run("tab.select", { id: row.tabId });
    setShared(SCREEN_KEY, "panes");
    run("layout.select", { stack: "screen", child: "panes" });
    if (row.terminal) run("pane.focus", { terminal: row.terminal });
  }

  /**
   * @param {NeedsRow} row
   * @param {Request | null} req
   * @param {{ action: string } | { answers: { picks: number[], other?: string }[] }} choice
   * @param {any} cx
   */
  answer(row, req, choice, cx) {
    if (!row.terminal || !row.local || !row.kind) return;
    const st = this.termStates.get(row.terminal);
    if (!st || req?.state !== "pending" || !req.answerable || st.sendingIds.size || st.wentOut.has(req.id)) return;
    if (isGuarded(st.guard, Date.now())) return;
    const expect = cardsExpect(st.cards, st.stateLine, row.kind);
    let args;
    try {
      args = answerArgs(req, choice, { local: row.local }, expect);
    } catch {
      return;
    }
    st.sendingIds.add(req.id);
    st.answerNotes.delete(req.id);
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      let text = "";
      try {
        const res = await this.helper.call(row.machine, args);
        const line = /** @type {{ result: string, state?: string, message?: string } | null} */ (
          res.ok ? res.lines.find((/** @type {any} */ l) => l?.type === "answer" && typeof l.result === "string") : null
        );
        if (line && WENT_OUT.has(line.result)) st.wentOut.add(req.id);
        text = line
          ? answerNote(line, req.kind, row.agentLabel)
          : answerNote(
              { result: "failed", message: res.ok === true ? "bw answer printed no result" : res.message },
              req.kind,
              row.agentLabel,
            );
      } catch (e) {
        text = answerNote(
          { result: "failed", message: e instanceof Error ? e.message : String(e) },
          req.kind,
          row.agentLabel,
        );
      } finally {
        st.sendingIds.delete(req.id);
        if (text) st.answerNotes.set(req.id, text);
        st.cardsCheckedAt = 0;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {NeedsRow} row @param {Card} card @param {string} buttonId @param {any} cx */
  clickCard(row, card, buttonId, cx) {
    if (buttonId === "terminal") {
      this.openTerminal(row);
      return;
    }
    if (!row.terminal) return;
    const st = this.termStates.get(row.terminal);
    if (!st) return;
    const req = st.requests.find((r) => r.id === card.id) ?? null;
    if (buttonId === "submit") {
      if (!req) return;
      const d = this.draftOf(st, req);
      if (complete(d)) this.answer(row, req, { answers: answersOf(d) }, cx);
      return;
    }
    this.answer(row, req, { action: buttonId }, cx);
  }

  /** @param {NeedsRow} row @param {Card} card @param {number} step @param {number} index @param {any} cx */
  chooseOption(row, card, step, index, cx) {
    if (!row.terminal) return;
    const st = this.termStates.get(row.terminal);
    const req = st?.requests.find((r) => r.id === card.id);
    if (!st || !req) return;
    const d = this.draftOf(st, req);
    st.drafts.set(req.id, d.multi[step] ? toggle(d, step, index) : pick(d, step, index));
    this.cardFocus.focus();
    this.syncOther(st);
    cx.notify();
  }

  /** @param {NeedsRow} row @param {Card} card @param {number} step @param {any} cx */
  showStep(row, card, step, cx) {
    if (!row.terminal) return;
    const st = this.termStates.get(row.terminal);
    const req = st?.requests.find((r) => r.id === card.id);
    if (!st || !req) return;
    const d = this.draftOf(st, req);
    if (!Number.isInteger(step) || step < 0 || step >= d.counts.length) return;
    st.drafts.set(req.id, { ...d, step });
    this.syncOther(st);
    cx.notify();
  }

  /** @param {NeedsRow} row @param {TerminalState | null} st @param {number} now @returns {Card[]} */
  cardsForRow(row, st, now) {
    if (!st) return [];
    const guarded = isGuarded(st.guard, now);
    const expect = row.kind ? cardsExpect(st.cards, st.stateLine, row.kind) : null;
    return dockCards(st.requests, {
      now,
      guarded,
      sending: st.sendingIds,
      agentName: row.agentLabel,
      expect,
    }).map((c) => ({
      ...c,
      buttons: c.buttons.map((b) =>
        b.id === "terminal"
          ? b
          : {
              ...b,
              enabled: b.enabled && !st.wentOut.has(c.id) && (b.id !== "submit" || complete(this.draftOf(st, c))),
            },
      ),
    }));
  }

  /** @param {NeedsRow} row @param {Card} card @param {any} e @param {any} cx */
  cardKey(row, card, e, cx) {
    if (NO_KEYS_WITH.some((m) => e?.modifiers?.[m])) return;
    if (!row.terminal) return;
    const st = this.termStates.get(row.terminal);
    const req = st?.requests.find((r) => r.id === card.id);
    if (!st || !req) return;
    const rawKey = String(e?.key ?? e?.keystroke?.key ?? "");
    const key = rawKey.toLowerCase();
    if (req.kind === "approval") {
      if (e?.modifiers?.shift) return;
      /** @type {import("./dock-model.js").Button | null} */
      let targetBtn = null;
      if (key === "y") {
        targetBtn = card.buttons.find((b) => b.id === "approve") ?? null;
      } else if (key === "a") {
        targetBtn = card.buttons.find((b) => b.id === "always") ?? null;
      } else if (key === "n") {
        targetBtn = card.buttons.find((b) => b.id === "deny") ?? null;
      } else if (/^[1-9]$/.test(key)) {
        const actionButtons = card.buttons.filter((b) => b.id !== "terminal");
        targetBtn = actionButtons[Number(key) - 1] ?? null;
      }
      if (targetBtn) {
        cx.stop_propagation?.();
        if (targetBtn.enabled) {
          this.clickCard(row, card, targetBtn.id, cx);
        }
      }
      return;
    }
    if (/^[1-9]$/.test(key) && !e?.modifiers?.shift) {
      if (req.kind === "prompt") {
        cx.stop_propagation?.();
        this.clickCard(row, card, `option-${key}`, cx);
        return;
      }
      const d = this.draftOf(st, req);
      const next = digit(d, d.step, Number(key));
      st.drafts.set(req.id, next);
      this.syncOther(st);
      cx.stop_propagation?.();
      if (d.counts.length === 1 && !d.multi[0] && complete(next)) {
        this.answer(row, req, { answers: answersOf(next) }, cx);
        return;
      }
      cx.notify();
    } else if (key === "enter") {
      cx.stop_propagation?.();
      this.clickCard(row, card, "submit", cx);
    }
  }

  /** @param {any} e @param {any} cx */
  listKey(e, cx) {
    if (NO_KEYS_WITH.some((m) => e?.modifiers?.[m])) return;
    const key = String(e?.key ?? e?.keystroke?.key ?? "").toLowerCase();
    const rows = this.lastRows;
    const sel = this.lastSelected;
    if ((key === "down" || key === "arrowdown" || (key === "j" && !e?.modifiers?.shift)) && rows.length > 0) {
      const idx = sel ? rows.findIndex((r) => r.id === sel.id) : -1;
      const next = rows[Math.min(rows.length - 1, idx + 1)] ?? rows[0];
      if (next && next.id !== this.selectedId) {
        this.selectedId = next.id;
        this.poke.poke();
        cx.stop_propagation?.();
        cx.notify();
      }
      return;
    }
    if ((key === "up" || key === "arrowup" || (key === "k" && !e?.modifiers?.shift)) && rows.length > 0) {
      const idx = sel ? rows.findIndex((r) => r.id === sel.id) : 0;
      const prev = rows[Math.max(0, idx - 1)] ?? rows[0];
      if (prev && prev.id !== this.selectedId) {
        this.selectedId = prev.id;
        this.poke.poke();
        cx.stop_propagation?.();
        cx.notify();
      }
      return;
    }
    if (sel?.terminal && (/^[1-9]$/.test(key) || key === "enter" || key === "y" || key === "a" || key === "n")) {
      const st = this.termStates.get(sel.terminal) ?? null;
      const active = st ? activeShortcutRequestOf(st.requests) : null;
      if (st && active) {
        const cards = this.cardsForRow(sel, st, Date.now());
        const card = cards.find((c) => c.id === active.id);
        if (card) this.cardKey(sel, card, e, cx);
      }
    }
  }

  /** @param {NeedsRow} row @param {PrSummary} pr @param {any} cx */
  openPr(row, pr, cx) {
    if (this.prBusy) return;
    run("layout.show", { id: "right" });
    run("layout.select", { stack: "right-body", child: "browser" });
    setShared(RIGHT_TAB, choose(shared(RIGHT_TAB), row.spaceId, "browser", this.liveSpaceIds));
    this.prBusy = true;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        let res = await this.helper.call(null, ["browser", "new", "--url", pr.url]);
        const first = res.ok ? res.lines.find((/** @type {any} */ l) => l?.type === "tab-action") : null;
        if (first && first.ok === false && /\(stopped\)$/.test(String(first.message ?? ""))) {
          const up = await this.helper.call(null, ["browser", "up"]);
          const chrome = up.ok ? up.lines.find((/** @type {any} */ l) => l?.type === "chrome") : null;
          if (chrome?.state === "running") {
            res = await this.helper.call(null, ["browser", "new", "--url", pr.url]);
          }
        }
        const line = res.ok ? res.lines.find((/** @type {any} */ l) => l?.type === "tab-action") : null;
        if ((!res.ok || line?.ok === false) && row.terminal) {
          const st = this.termStates.get(row.terminal);
          if (st) {
            const why = res.ok === true ? String(line?.message || "failed") : res.message;
            st.skillNote = { text: `Could not open PR in Browser: ${why}`, bad: true };
          }
        }
      } finally {
        this.prBusy = false;
        cx.notify();
      }
    });
  }

  /** @param {NeedsRow} row @param {string} commandText @param {any} cx */
  runPrSkill(row, commandText, cx) {
    if (!row.isAgent || !row.terminal || !row.local || !row.kind) return;
    const st = this.termStates.get(row.terminal);
    if (!st || st.skillBusy) return;
    const queueIt = row.status === "working";
    st.skillBusy = true;
    st.skillNote = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        let expect = cardsExpect(st.cards, st.stateLine, /** @type {string} */ (row.kind));
        if (!expect) {
          await this.readCards(st, cx);
          expect = cardsExpect(st.cards, st.stateLine, /** @type {string} */ (row.kind));
        }
        if (!expect) {
          st.skillNote = { text: `Wait for ${row.agentLabel}'s session before running ${commandText}.`, bad: true };
          return;
        }
        if (queueIt) {
          const qArgs = ["queue", "add", "--terminal", row.local, "--kind", row.kind];
          if (expect.session !== "none") qArgs.push("--session", expect.session);
          qArgs.push("--text", commandText);
          const res = await this.helper.call(row.machine, qArgs);
          const qLine = res.ok ? res.lines.find((/** @type {any} */ l) => l?.type === "queue") : null;
          if (qLine) {
            st.skillNote = { text: `Queued ${commandText}.`, bad: false };
          } else {
            const err = res.ok ? res.lines.find((/** @type {any} */ l) => l?.type === "error") : null;
            const why = res.ok === true ? String(err?.message || "bw queue add failed") : res.message;
            st.skillNote = { text: `Not queued: ${why}`, bad: true };
          }
          return;
        }
        const res = await this.helper.call(row.machine, [
          "send",
          "--terminal",
          row.local,
          "--expect-kind",
          row.kind,
          "--expect-session",
          expect.session,
          "--expect-path",
          expect.path,
          "--text",
          commandText,
        ]);
        const line = res.ok ? res.lines.find((/** @type {any} */ l) => l?.type === "send") : null;
        const result = typeof line?.result === "string" ? line.result : "failed";
        const went = result === "sent" || result === "unconfirmed";
        if (went) {
          st.skillNote = { text: `Sent ${commandText}.`, bad: false };
        } else {
          const why = res.ok === true ? String(line?.message || "bw send failed") : res.message;
          st.skillNote = { text: `Not sent: ${why}`, bad: true };
        }
      } finally {
        st.skillBusy = false;
        this.poke.poke();
        cx.notify();
      }
    });
  }

  /** @param {Theme} t @param {NeedsRow} row @param {boolean} selected */
  renderRow(t, row, selected) {
    const hovered = this.hoveredId === row.id;
    const subColor = selected ? mutedOnSelected : t.muted;
    return h_flex()
      .id(`needs-row-${row.id}`)
      .relative()
      .w_full()
      .min_h(52)
      .px(10)
      .py(7)
      .gap(9)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
        const next = on ? row.id : this.hoveredId === row.id ? null : this.hoveredId;
        if (next === this.hoveredId) return;
        this.hoveredId = next;
        cx.notify();
      })
      .on_click((/** @type {any} */ e, /** @type {any} */ cx) => {
        if ((e?.click_count ?? 1) >= 2) {
          if (row.isAgent) this.openChat(row);
          else this.openTerminal(row);
          return;
        }
        const st = row.terminal ? this.termStates.get(row.terminal) : null;
        if (this.selectedId !== row.id) {
          this.selectedId = row.id;
          if (st) this.syncOther(st);
          this.poke.poke();
          cx.notify();
        }
        this.focusTarget = st && activeQuestionOf(st.requests) ? "card" : "root";
        this.focusPoke.poke();
      })
      .when(!selected, (el) => el.child(hoverFill(t, `needs-hover-${row.id}`, hovered, 8)))
      .when(selected, (el) => el.child(div().w(2).h(22).flex_none().rounded(1).bg(t.accent)))
      .child(monogram(t, row.spaceId, row.monogram, 22))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .items_center()
              .child(
                div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(row.spaceName),
              )
              .child(div().flex_none().text_size(11.5).text_color(subColor).child(row.agentLabel))
              .when(Boolean(row.machine), (el) => el.child(machineTag(String(row.machine), t))),
          )
          .child(div().w_full().truncate().text_size(11.5).text_color(subColor).child(row.subtitle)),
      )
      .child(statusMark(t, row.agentBlocked ? "blocked" : row.status, 12));
  }

  /** @param {Theme} t @param {NeedsRow} row @param {TerminalState | null} st */
  renderPrCard(t, row, st) {
    const pr = row.pr;
    if (!pr) return null;
    const badge = prBadgeInfo(pr, row.headOid);
    const mergeReady = Boolean(row.mergeReady);
    const canSkill = Boolean(row.isAgent && !st?.skillBusy);
    const countsLine = `${pr.passing} passing · ${pr.failing} failing · ${pr.pending} pending · ${pr.unresolvedThreads} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"} · ${reviewLabel(pr.reviewDecision)}`;
    return v_flex()
      .id("needs-pr-card")
      .w_full()
      .rounded(12)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .px(16)
      .py(14)
      .gap(10)
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(13)
              .font_semibold()
              .text_color(t.foreground)
              .child(`#${pr.number} ${pr.title || "Pull request"}`),
          )
          .child(pill(t, badge.text, badge.tone, "needs-pr-badge")),
      )
      .child(div().w_full().text_size(12).text_color(t.muted).whitespace_normal().child(countsLine))
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .flex_wrap()
          .when(mergeReady, (el) =>
            el.child(
              button(t, {
                id: "needs-pr-merge",
                label: "Merge PR",
                kind: "primary",
                on: "raised",
                enabled: canSkill,
                onClick: (_e, cx) => this.runPrSkill(row, mergeCommand(pr.number), cx),
              }),
            ),
          )
          .child(
            button(t, {
              id: "needs-pr-babysit",
              label: "Babysit PR",
              kind: !mergeReady && prNeedsAttention(pr) ? "primary" : "secondary",
              on: "raised",
              enabled: canSkill,
              onClick: (_e, cx) => this.runPrSkill(row, babysitCommand(pr.number), cx),
            }),
          )
          .child(
            button(t, {
              id: "needs-pr-open",
              label: "Open PR",
              kind: "secondary",
              on: "raised",
              enabled: !this.prBusy,
              onClick: (_e, cx) => this.openPr(row, pr, cx),
            }),
          ),
      )
      .when(!row.isAgent, (el) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child("Start a Claude or Codex chat in this space to run /babysit-pr or /merge-pr."),
        ),
      )
      .when(Boolean(st?.skillNote), (el) =>
        el.child(
          div()
            .id("needs-pr-note")
            .text_size(12)
            .text_color(st?.skillNote?.bad ? t.blocked : t.muted)
            .whitespace_normal()
            .child(String(st?.skillNote?.text ?? "")),
        ),
      );
  }

  /** @param {Theme} t @param {NeedsRow | null} row @param {number} now */
  renderDetail(t, row, now) {
    if (!row) {
      return v_flex()
        .id("needs-empty")
        .flex_1()
        .h_full()
        .items_center()
        .justify_center()
        .px(24)
        .gap(6)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("All quiet"))
        .child(
          div().text_size(12.5).text_color(t.muted).child("No active agents or open pull requests need your move."),
        );
    }

    const st = row.terminal ? (this.termStates.get(row.terminal) ?? null) : null;
    const guarded = st ? isGuarded(st.guard, now) : true;
    if (st) st.drawnGuarded = guarded;
    const cards = this.cardsForRow(row, st, now);

    if (st) {
      for (const id of st.cardsShown) if (!cards.some((c) => c.id === id)) st.cardsShown.delete(id);
    }
    const activeQ = st ? activeQuestionOf(st.requests) : null;
    if (activeQ && st && this.wantCardFocus && this.shown) {
      this.wantCardFocus = false;
      this.focusTarget = "card";
      this.focusPoke.poke();
    }

    const header = h_flex()
      .id("needs-detail-header")
      .w_full()
      .rounded(12)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .px(16)
      .py(12)
      .gap(10)
      .items_center()
      .child(monogram(t, row.spaceId, row.monogram, 26))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .w_full()
              .gap(8)
              .items_center()
              .child(
                div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(row.spaceName),
              )
              .child(programIcon(row.program, t, 14))
              .child(div().flex_none().text_size(12.5).text_color(t.muted).child(row.agentLabel))
              .when(Boolean(row.machine), (el) => el.child(machineTag(String(row.machine), t))),
          )
          .child(
            h_flex()
              .w_full()
              .gap(8)
              .items_center()
              .text_size(12)
              .text_color(t.muted)
              .when(Boolean(row.branch), (el) =>
                el.child(
                  h_flex()
                    .gap(4)
                    .items_center()
                    .child(svg(ICONS.branch).size(12).flex_none())
                    .child(div().truncate().child(String(row.branch))),
                ),
              )
              .when(Boolean(row.folder), (el) => el.child(div().min_w(0).truncate().child(row.folder))),
          ),
      )
      .when(row.isAgent && Boolean(row.tabId), (el) =>
        el.child(
          button(t, {
            id: "needs-open-chat",
            label: "Open chat",
            kind: "secondary",
            on: "raised",
            onClick: () => this.openChat(row),
          }),
        ),
      )
      .when(Boolean(row.terminal || row.tabId), (el) =>
        el.child(
          button(t, {
            id: "needs-open-terminal",
            label: "Open terminal",
            kind: "secondary",
            on: "raised",
            onClick: () => this.openTerminal(row),
          }),
        ),
      );

    const waitingInTerminal =
      row.agentBlocked && cards.length === 0
        ? v_flex()
            .id("needs-waiting-terminal")
            .w_full()
            .rounded(12)
            .bg(t.raised)
            .border(1)
            .border_color(t.border)
            .px(16)
            .py(14)
            .gap(8)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(statusMark(t, "blocked", 14))
                .child(
                  div()
                    .text_size(13)
                    .font_semibold()
                    .text_color(t.foreground)
                    .child(row.isAgent && !st?.cardsLoaded ? "Reading prompt…" : "Waiting in terminal"),
                ),
            )
            .child(
              div()
                .text_size(12)
                .text_color(t.muted)
                .whitespace_normal()
                .child(
                  row.isAgent
                    ? "This prompt is not an inline session approval or question card. Inspect and answer it directly in the terminal."
                    : "This terminal is waiting for interactive input.",
                ),
            )
            .child(
              h_flex().child(
                button(t, {
                  id: "needs-waiting-open-terminal",
                  label: "Open terminal",
                  kind: "primary",
                  on: "raised",
                  onClick: () => this.openTerminal(row),
                }),
              ),
            )
        : null;

    const prCard = row.pr ? this.renderPrCard(t, row, st) : null;

    const quietStatus =
      !row.agentBlocked && cards.length === 0 && !prCard
        ? v_flex()
            .id("needs-status-card")
            .w_full()
            .rounded(12)
            .bg(t.raised)
            .border(1)
            .border_color(t.border)
            .px(16)
            .py(14)
            .gap(6)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(statusMark(t, row.status ?? "idle", 14))
                .child(div().text_size(13).font_semibold().text_color(t.foreground).child(row.subtitle)),
            )
            .child(
              div()
                .text_size(12)
                .text_color(t.muted)
                .child("Double-click the row or use Open chat to jump straight to this conversation."),
            )
        : null;

    return v_flex()
      .id("needs-detail")
      .flex_1()
      .h_full()
      .overflow_y_scrollbar()
      .px(24)
      .py(20)
      .items_center()
      .child(
        v_flex()
          .w_full()
          .max_w(680)
          .gap(12)
          .child(header)
          .when(st !== null && cards.length > 0, (el) =>
            el.children(
              cards.map((c) =>
                requestCard(
                  c,
                  {
                    t,
                    cards,
                    draftOf: (cardItem) => this.draftOf(/** @type {TerminalState} */ (st), cardItem),
                    active: activeQ?.id ?? null,
                    focus: this.cardFocus,
                    other: this.other,
                    notes: /** @type {TerminalState} */ (st).answerNotes,
                    shown: /** @type {TerminalState} */ (st).cardsShown,
                  },
                  {
                    onButton: (cardItem, b, cx) => this.clickCard(row, cardItem, b, cx),
                    onOption: (cardItem, step, i, cx) => this.chooseOption(row, cardItem, step, i, cx),
                    onStep: (cardItem, step, cx) => this.showStep(row, cardItem, step, cx),
                    onKey: (cardItem, e, cx) => this.cardKey(row, cardItem, e, cx),
                    onShown: (id, cx) => {
                      /** @type {TerminalState} */ (st).cardsShown.add(id);
                      cx.notify();
                    },
                  },
                ),
              ),
            ),
          )
          .when(guarded && st !== null && cards.some((c) => c.state === "pending" && c.buttons.length > 1), (el) =>
            el.child(
              div()
                .id("needs-guard-note")
                .text_size(11.5)
                .text_color(t.muted)
                .child("Answer controls unlock 3 s after leaving terminal focus."),
            ),
          )
          .when(Boolean(waitingInTerminal), (el) => el.child(waitingInTerminal))
          .when(Boolean(prCard), (el) => el.child(prCard))
          .when(Boolean(quietStatus), (el) => el.child(quietStatus)),
      );
  }

  render() {
    const now = Date.now();
    const t = themeColors();
    const allSpaces = spaces();
    const allPanes = panes();
    const allAgents = agents();
    const fFocus = focused();
    const tree = layout();
    const screenNode = findLayout(tree, "screen");
    const rawScreen = typeof screenNode?.active === "string" ? screenNode.active : "needs";
    const sharedScreen = shared(SCREEN_KEY);
    const wasShown = this.shown;
    this.shown = rawScreen === "needs" && (typeof sharedScreen === "string" ? sharedScreen === "needs" : true);

    this.liveSpaceIds = allSpaces.map((s) => s.id);
    this.liveTabIds = allSpaces.flatMap((s) => (s.tabs ?? []).map((/** @type {any} */ tb) => tb.id));

    const focusedTerm =
      screenNode && rawScreen !== "panes" && fFocus?.pane !== null ? null : (fFocus?.terminal ?? null);
    const termFocusStore = shared(TERMINAL_FOCUS);

    // Sync per-terminal state and 3 s focus guards.
    const liveTerminals = new Set();
    let shouldPoke = !wasShown && this.shown;
    for (const sp of allSpaces) {
      const machine = sp.machine ?? null;
      const tabIds = new Set((sp.tabs ?? []).map((/** @type {any} */ tb) => tb.id));
      for (const p of allPanes) {
        if (p.mod || typeof p.terminal !== "string" || !p.terminal || !tabIds.has(p.tab)) continue;
        liveTerminals.add(p.terminal);
        const local =
          machine !== null && p.terminal.startsWith(`${machine}/`) ? p.terminal.slice(machine.length + 1) : p.terminal;
        let st = this.termStates.get(p.terminal);
        if (!st) {
          st = createTerminalState(p.terminal, local, machine, now);
          this.termStates.set(p.terminal, st);
        } else {
          st.local = local;
          st.machine = machine;
        }
        st.guard = observe(st.guard, focusedTerm, p.terminal, now);
        st.guard = observeLeft(st.guard, leftAt(termFocusStore, p.terminal));
      }
    }
    for (const key of [...this.termStates.keys()]) {
      if (!liveTerminals.has(key)) this.termStates.delete(key);
    }

    for (const a of allAgents) {
      if (typeof a?.address !== "string") continue;
      const prev = this.prevStatuses.get(a.address);
      if (prev !== undefined && prev !== a.status) {
        const st = this.termStates.get(a.address);
        if (st) st.cardsCheckedAt = 0;
        const space = allSpaces.find((s) => s.id === a.space);
        this.countsCheckedAt.set(space?.machine ?? null, 0);
        shouldPoke = true;
      }
    }
    this.prevStatuses = new Map(
      allAgents.filter((a) => typeof a?.address === "string").map((a) => [a.address, a.status ?? null]),
    );

    // Merge shared PR summary with any fresher local PR entries.
    const sharedPr = shared(PR_SUMMARY);
    /** @type {Record<string, SharedPrEntry>} */
    const mergedPr = {};
    if (sharedPr && typeof sharedPr === "object" && !Array.isArray(sharedPr)) {
      for (const [k, v] of Object.entries(sharedPr)) {
        if (v && typeof v === "object") mergedPr[k] = /** @type {SharedPrEntry} */ (v);
      }
    }
    for (const [k, v] of Object.entries(this.prBySpace)) {
      if (this.liveSpaceIds.includes(k)) mergedPr[k] = v;
      else delete this.prBySpace[k];
    }

    /** @type {Map<string, import("./model.js").CardsSnapshot>} */
    const cardsMap = new Map();
    for (const [term, st] of this.termStates) {
      cardsMap.set(term, {
        loaded: st.cardsLoaded,
        cards: st.cards,
        stateLine: st.stateLine,
        requests: st.requests,
      });
    }

    const model = buildNeedsModel({
      spaces: allSpaces,
      panes: allPanes,
      agents: allAgents,
      counts: this.counts,
      cardsByTerminal: cardsMap,
      prBySpace: mergedPr,
      chatTabs: shared("bw.chat-tabs"),
      chatAgents: shared(CHAT_AGENT),
      selectedId: this.selectedId,
    });

    const prevSelectedId = this.lastSelected?.id ?? null;
    this.lastRows = model.rows;
    this.lastSelected = model.selected;
    if (model.selected && this.selectedId !== model.selected.id) {
      this.selectedId = model.selected.id;
    }
    if (prevSelectedId !== (model.selected?.id ?? null)) {
      const selSt = model.selected?.terminal ? this.termStates.get(model.selected.terminal) : null;
      if (selSt) this.syncOther(selSt);
      shouldPoke = true;
    }

    // Build background poll snapshot (zero Herdr live reads in tasks).
    /** @type {Map<string | null, { address: string, local: string }[]>} */
    const byMachine = new Map();
    for (const r of model.rows) {
      if (!r.isAgent || !r.terminal || !r.local) continue;
      let list = byMachine.get(r.machine);
      if (!list) {
        list = [];
        byMachine.set(r.machine, list);
      }
      if (!list.some((x) => x.address === r.terminal)) {
        list.push({ address: r.terminal, local: r.local });
      }
    }

    const prSpaces = allSpaces.map((sp) => {
      const activeTab = (sp.tabs ?? []).find((/** @type {any} */ tb) => tb.active) ?? sp.tabs?.[0] ?? null;
      const tabPane = activeTab
        ? allPanes.find((p) => p.tab === activeTab.id && !p.mod && typeof p.terminal === "string")
        : null;
      const folder = String(tabPane?.cwd || sp.folder || "");
      const branch =
        typeof tabPane?.branch === "string" && tabPane.branch
          ? tabPane.branch
          : typeof sp.branch === "string" && sp.branch
            ? sp.branch
            : null;
      const key = `${sp.machine ?? ""}\0${folder}\0${branch ?? ""}`;
      const meta = this.prMeta.get(sp.id);
      if (meta && meta.key !== "" && meta.key !== key) {
        this.clearSpacePr(sp.id, null);
        shouldPoke = true;
      }
      return { spaceId: String(sp.id), machine: sp.machine ?? null, folder, branch };
    });

    const selectedAgent =
      model.selected?.isAgent && model.selected.terminal && model.selected.local && model.selected.kind
        ? {
            terminal: model.selected.terminal,
            local: model.selected.local,
            machine: model.selected.machine,
            kind: model.selected.kind,
            blocked: model.selected.agentBlocked,
          }
        : null;

    const blockedAgents = model.rows
      .filter((r) => r.isAgent && r.agentBlocked && r.terminal && r.local && r.kind)
      .map((r) => ({
        terminal: /** @type {string} */ (r.terminal),
        local: /** @type {string} */ (r.local),
        machine: r.machine,
        kind: /** @type {"claude" | "codex"} */ (r.kind),
      }));

    this.snapshot = {
      selectedAgent,
      blockedAgents,
      machineTerminals: [...byMachine.entries()],
      prSpaces,
    };

    const selState = model.selected?.terminal ? (this.termStates.get(model.selected.terminal) ?? null) : null;
    const selGuarded = selState ? isGuarded(selState.guard, now) : false;
    const nextGuardWake = selState && selGuarded ? guardedUntil(selState.guard) : null;
    if (nextGuardWake !== this.guardWakeAt) {
      this.guardWakeAt = nextGuardWake;
      if (nextGuardWake !== null && Number.isFinite(nextGuardWake)) shouldPoke = true;
    }

    if (this.pendingFocus) {
      this.pendingFocus = false;
      const activeQ = selState ? activeQuestionOf(selState.requests) : null;
      if (activeQ) {
        this.wantCardFocus = false;
        this.focusTarget = "card";
      } else {
        this.wantCardFocus = Boolean(model.selected?.isAgent && model.selected.agentBlocked && !selState?.cardsLoaded);
        this.focusTarget = "root";
      }
      this.focusPoke.poke();
    }

    if (shouldPoke) this.poke.poke();

    const listCol = v_flex()
      .id("bw-needs-list")
      .w(300)
      .h_full()
      .flex_none()
      .border_r(1)
      .border_color(t.border)
      .bg(t.chrome)
      .track_focus(this.rootFocus)
      .on_key_down((/** @type {any} */ e, /** @type {any} */ cx) => this.listKey(e, cx))
      .child(
        h_flex()
          .h(40)
          .w_full()
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Whose move"))
          .child(div().flex_1())
          .when(model.rows.length > 0, (el) => el.child(pill(t, String(model.rows.length), "count"))),
      )
      .child(
        v_flex()
          .flex_1()
          .w_full()
          .overflow_y_scrollbar()
          .px(8)
          .py(8)
          .gap(10)
          .children(
            model.groups.map((g) =>
              v_flex()
                .id(`needs-group-${g.id}`)
                .w_full()
                .gap(3)
                .child(
                  h_flex()
                    .h(24)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .child(div().text_size(11).font_semibold().text_color(t.muted).child(g.label))
                    .child(
                      pill(
                        t,
                        String(g.rows.length),
                        g.id === "needs" ? "request" : g.id === "ready" ? "done" : "count",
                      ),
                    ),
                )
                .children(g.rows.map((r) => this.renderRow(t, r, model.selected?.id === r.id))),
            ),
          ),
      );

    return h_flex()
      .id("bw-needs")
      .size_full()
      .bg(t.surface)
      .child(listCol)
      .child(this.renderDetail(t, model.selected, now));
  }
}
