// Cross-space fleet `Overview` screen: responsive workspace cards showing neutral monograms,
// machine tags, branch + PR badges, and live agent rows with one-click pinned jump to `chat` or `panes`.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, exec, home, layout, nextCommand, panes, run, setShared, shared, spaces } from "herdr";
import { CHAT_AGENT, PR_SUMMARY, SCREEN_KEY, TAB_VIEW, pinTabAgent, writeTabView } from "./chat-tabs.js";
import { headOid, remoteOrigin } from "./git.js";
import { createHelper, parseLines } from "./helper.js";
import { buildOverviewCards, columnCountFor } from "./model.js";
import { parsePrLines, prStatusArgs, toSharedPrEntry, updateSharedPrSummary } from "./pr-model.js";
import { createPoke } from "./refresh-driver.js";
import {
  ICONS,
  button,
  findLayout,
  hoverFill,
  machineTag,
  monogram,
  pill,
  programIcon,
  statusMark,
  themeColors,
} from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./model.js").OverviewCard} OverviewCard */
/** @typedef {import("./model.js").OverviewLine} OverviewLine */
/** @typedef {import("./pr-model.js").SharedPrEntry} SharedPrEntry */

const PR_POLL_MS = 15_000;

export default class Overview extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    this.shown = false;
    this.width = 960;
    this.rootFocus = cx.focus_handle();
    this.focusPoke = createPoke();
    /** @type {string | null} */
    this.hoveredId = null;
    /** @type {string[]} */
    this.liveTabIds = [];
    /** @type {string[]} */
    this.liveSpaceIds = [];
    /** @type {Record<string, SharedPrEntry>} */
    this.prBySpace = {};
    /** @type {Map<string, { key: string, checkedAt: number, repoFolder: string | null, repo: string | null }>} */
    this.prMeta = new Map();
    /** @type {{ spaceId: string, machine: string | null, folder: string, branch: string | null }[]} */
    this.prSpaces = [];
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

    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        if ((await nextCommand()) !== "focus") continue;
        this.focusPoke.poke();
        cx.notify();
      }
    });

    cx.spawn(async () => {
      for (;;) {
        await this.focusPoke.wait();
        if (!this.alive) return;
        this.rootFocus.focus();
      }
    });

    cx.spawn((/** @type {any} */ cx) => this.pollLoop(cx));
  }

  close() {
    this.alive = false;
    this.poke.poke();
    this.focusPoke.poke();
  }

  /** @returns {boolean} */
  refreshShown() {
    const s = shared(SCREEN_KEY);
    if (typeof s === "string" && s !== "overview") {
      this.shown = false;
    }
    return this.shown;
  }

  /** @param {any} cx */
  async pollLoop(cx) {
    while (this.alive) {
      const started = Date.now();
      if (this.refreshShown()) {
        for (const sp of this.prSpaces) {
          if (!this.alive || !this.refreshShown()) break;
          await this.maybeReadSpacePr(sp, Date.now(), cx);
        }
      }
      if (!this.alive) break;
      const waitMs = Math.max(1000, PR_POLL_MS - (Date.now() - started));
      await this.poke.wait(cx.sleep(waitMs));
    }
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
    if (meta.key === key && meta.checkedAt > 0 && now - meta.checkedAt < PR_POLL_MS) return;
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
      const latest = this.prSpaces.find((x) => x.spaceId === sp.spaceId);
      return Boolean(latest && `${latest.machine ?? ""}\0${latest.folder}\0${latest.branch ?? ""}` === key);
    };

    const folderKey = `${sp.machine ?? ""}\0${sp.folder}`;
    if (meta.repoFolder !== folderKey) {
      const origin = await remoteOrigin(exec, sp.machine, sp.folder);
      if (!stillCurrent() || !origin.ok) return;
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
    const res = await this.helper.call(null, args);
    if (!stillCurrent() || !res.ok) return;
    const parsed = parsePrLines(res.lines);
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

  /** @param {OverviewCard} card @param {OverviewLine} line */
  jumpToChat(card, line) {
    setShared(CHAT_AGENT, pinTabAgent(shared(CHAT_AGENT), line.tabId, line.terminal, this.liveTabIds));
    run("agent.focus", { terminal: line.terminal });
    setShared(TAB_VIEW, writeTabView(shared(TAB_VIEW), line.tabId, "chat", this.liveTabIds));
    if (!card.active) run("space.select", { id: card.spaceId });
    if (!line.tabActive) run("tab.select", { id: line.tabId });
    setShared(SCREEN_KEY, "chat");
    run("layout.select", { stack: "screen", child: "chat" });
    run("bw-chat.focus");
  }

  /** @param {OverviewCard} card @param {string | null} tabId @param {boolean} tabActive @param {string | null} terminal */
  jumpToPanes(card, tabId, tabActive, terminal) {
    if (tabId) {
      setShared(TAB_VIEW, writeTabView(shared(TAB_VIEW), tabId, "panes", this.liveTabIds));
    }
    if (!card.active) run("space.select", { id: card.spaceId });
    if (tabId && !tabActive) run("tab.select", { id: tabId });
    setShared(SCREEN_KEY, "panes");
    run("layout.select", { stack: "screen", child: "panes" });
    if (terminal) run("pane.focus", { terminal });
  }

  /** @param {OverviewCard} card */
  jumpPrimary(card) {
    if (card.primaryLine?.isAgent) {
      this.jumpToChat(card, card.primaryLine);
      return;
    }
    if (card.primaryLine) {
      this.jumpToPanes(card, card.primaryLine.tabId, card.primaryLine.tabActive, card.primaryLine.terminal);
      return;
    }
    this.jumpToPanes(card, card.fallbackTabId, true, null);
  }

  /** @param {Theme} t @param {OverviewCard} card @param {OverviewLine} line */
  renderLine(t, card, line) {
    const rowId = `overview-line-${line.terminal}`;
    const hovered = this.hoveredId === rowId;
    return h_flex()
      .id(rowId)
      .relative()
      .w_full()
      .h(30)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
        const next = on ? rowId : this.hoveredId === rowId ? null : this.hoveredId;
        if (next === this.hoveredId) return;
        this.hoveredId = next;
        cx.notify();
      })
      .on_click(() => {
        if (line.isAgent) this.jumpToChat(card, line);
        else this.jumpToPanes(card, line.tabId, line.tabActive, line.terminal);
      })
      .child(hoverFill(t, `overview-hover-${line.terminal}`, hovered, 7))
      .child(statusMark(t, line.status ?? "idle", 12))
      .child(programIcon(line.program, t, 13))
      .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(line.label))
      .when(line.tabName !== line.label, (el) =>
        el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(line.tabName)),
      )
      .child(div().flex_1())
      .when(line.isAgent, (el) =>
        el.child(
          button(t, {
            id: `overview-term-${line.terminal}`,
            icon: svg(ICONS.terminal).size(12),
            kind: "ghost",
            h: 22,
            on: "raised",
            onClick: (_e, cx) => {
              cx.stop_propagation?.();
              this.jumpToPanes(card, line.tabId, line.tabActive, line.terminal);
            },
          }),
        ),
      );
  }

  /** @param {Theme} t @param {OverviewCard} card */
  renderCard(t, card) {
    return v_flex()
      .id(`overview-card-${card.spaceId}`)
      .flex_1()
      .min_w(0)
      .rounded(12)
      .bg(t.raised)
      .border(1)
      .border_color(card.active ? t.accent : t.border)
      .px(14)
      .py(12)
      .gap(10)
      .child(
        h_flex()
          .id(`overview-open-${card.spaceId}`)
          .w_full()
          .gap(9)
          .items_center()
          .cursor_pointer()
          .on_click(() => this.jumpPrimary(card))
          .child(monogram(t, card.spaceId, card.monogram, 24))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(
                h_flex()
                  .w_full()
                  .gap(6)
                  .items_center()
                  .child(
                    div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(card.name),
                  )
                  .when(Boolean(card.machine), (el) => el.child(machineTag(String(card.machine), t))),
              )
              .when(Boolean(card.folder), (el) =>
                el.child(div().w_full().truncate().text_size(11.5).text_color(t.muted).child(card.folder)),
              ),
          )
          .when(card.aggregateStatus !== null, (el) => el.child(statusMark(t, card.aggregateStatus, 13))),
      )
      .when(Boolean(card.branch || card.prBadge), (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(6)
            .items_center()
            .when(Boolean(card.branch), (b) =>
              b.child(
                h_flex()
                  .min_w(0)
                  .gap(4)
                  .items_center()
                  .text_size(11.5)
                  .text_color(t.muted)
                  .child(svg(ICONS.branch).size(12).flex_none())
                  .child(div().min_w(0).truncate().child(String(card.branch))),
              ),
            )
            .child(div().flex_1())
            .when(Boolean(card.prBadge), (b) =>
              b.child(
                pill(t, String(card.prBadge?.text ?? ""), card.prBadge?.tone ?? "count", `overview-pr-${card.spaceId}`),
              ),
            ),
        ),
      )
      .child(
        card.lines.length > 0
          ? v_flex()
              .w_full()
              .gap(2)
              .children(card.lines.map((l) => this.renderLine(t, card, l)))
          : div().text_size(12).text_color(t.muted).px(4).child("No open terminals"),
      );
  }

  render() {
    const t = themeColors();
    const allSpaces = spaces();
    const allPanes = panes();
    const allAgents = agents();
    const tree = layout();
    const screenNode = findLayout(tree, "screen");
    const rawScreen = typeof screenNode?.active === "string" ? screenNode.active : "overview";
    const sharedScreen = shared(SCREEN_KEY);
    const wasShown = this.shown;
    this.shown = rawScreen === "overview" && (typeof sharedScreen === "string" ? sharedScreen === "overview" : true);

    this.liveSpaceIds = allSpaces.map((s) => s.id);
    this.liveTabIds = allSpaces.flatMap((s) => (s.tabs ?? []).map((/** @type {any} */ tb) => tb.id));

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

    const cards = buildOverviewCards({
      spaces: allSpaces,
      panes: allPanes,
      agents: allAgents,
      prBySpace: mergedPr,
      chatTabs: shared("bw.chat-tabs"),
      chatAgents: shared(CHAT_AGENT),
    });

    let shouldPoke = !wasShown && this.shown;
    this.prSpaces = cards.map((c) => {
      const key = `${c.machine ?? ""}\0${c.folder}\0${c.branch ?? ""}`;
      const meta = this.prMeta.get(c.spaceId);
      if (meta && meta.key !== "" && meta.key !== key) {
        this.clearSpacePr(c.spaceId, null);
        shouldPoke = true;
      }
      return {
        spaceId: c.spaceId,
        machine: c.machine,
        folder: c.folder,
        branch: c.branch,
      };
    });
    if (shouldPoke) this.poke.poke();

    const cols = columnCountFor(this.width);
    /** @type {OverviewCard[][]} */
    const gridRows = [];
    for (let i = 0; i < cards.length; i += cols) {
      gridRows.push(cards.slice(i, i + cols));
    }

    return v_flex()
      .id("bw-overview")
      .size_full()
      .bg(t.surface)
      .track_focus(this.rootFocus)
      .overflow_y_scrollbar()
      .on_size_change((/** @type {{ width?: number }} */ sz, /** @type {any} */ cx) => {
        const w = Math.round(Number(sz?.width) || 0);
        if (w > 0 && columnCountFor(w) !== columnCountFor(this.width)) {
          this.width = w;
          cx.notify();
        } else if (w > 0) {
          this.width = w;
        }
      })
      .px(24)
      .py(20)
      .items_center()
      .child(
        v_flex()
          .w_full()
          .max_w(1240)
          .gap(14)
          .child(
            h_flex()
              .w_full()
              .gap(8)
              .items_center()
              .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Overview"))
              .child(pill(t, `${cards.length} workspace${cards.length === 1 ? "" : "s"}`, "count")),
          )
          .child(
            cards.length === 0
              ? v_flex()
                  .id("overview-empty")
                  .w_full()
                  .rounded(12)
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .px(20)
                  .py(28)
                  .items_center()
                  .gap(4)
                  .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("No open workspaces"))
                  .child(
                    div().text_size(12).text_color(t.muted).child("Open a workspace from the sidebar to see it here."),
                  )
              : v_flex()
                  .id("overview-grid")
                  .w_full()
                  .gap(12)
                  .children(
                    gridRows.map((rowCards, rowIdx) =>
                      h_flex()
                        .id(`overview-row-${rowIdx}`)
                        .w_full()
                        .gap(12)
                        .items_start()
                        .children(rowCards.map((c) => this.renderCard(t, c)))
                        .children(
                          Array.from({ length: Math.max(0, cols - rowCards.length) }, () => div().flex_1().min_w(0)),
                        ),
                    ),
                  ),
          ),
      );
  }
}
