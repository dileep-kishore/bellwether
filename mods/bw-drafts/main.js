// Read-only Drafts & Audit sidecar (`bw-right` -> `Drafts`): lists worktree HTML pages, 6-column
// `show-me-your-work` `decisions.tsv` / `.audit/*.tsv` trails, `docs/plans/*.md` + `tasks.md` checklists,
// and allow-listed `independent-review` `ledger.md` artifacts via `bw drafts`. Polls only while shown.
import { View, div, svg } from "gpui-kit";
import { TextView, h_flex, v_flex } from "gpui-base";
import { exec, home, layout, panes, run, setShared, shared, spaces, watchFolder } from "herdr";
import { choose } from "./choice.js";
import { createHelper, parseLines } from "./helper.js";
import {
  defaultSelectedId,
  domSlug,
  folderName,
  formatBytes,
  groupDraftEntries,
  isShown,
  localFileUrlFor,
  parseDecisionsTsv,
  parseDraftEntries,
  parseDraftRead,
  parseDraftStaged,
  parsePlanChecklist,
  stageSlugFor,
} from "./model.js";
import { placeOf } from "./projects-model.js";
import { createPoke, runRefresher } from "./refresh-driver.js";
import { TIMES, createSchedule } from "./refresh-schedule.js";
import { ICONS, button, machineTag, mutedOnSelected, pill, spinner, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./model.js").DraftItem} DraftItem */
/** @typedef {import("./model.js").DraftKind} DraftKind */

/**
 * @typedef {object} LoadedDoc
 * @property {string} key
 * @property {string} entryId
 * @property {DraftKind} kind
 * @property {string} text
 * @property {boolean} truncated
 * @property {number} size
 * @property {boolean} loading
 * @property {string | null} error
 * @property {string | null} failedKey
 */

const RIGHT_TAB = "bw.right.tab";
const FOLDED_KEY = "bw.drafts.folded";
const DRAFTS_TIMES = Object.freeze({
  ...TIMES,
  selectedRemote: 10_000,
});

/** @param {unknown} e */
const errorText = (e) => (e instanceof Error ? e.message : String(e));

/** @returns {Set<string>} */
function loadFolded() {
  try {
    const raw = localStorage.getItem(FOLDED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export default class Drafts extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    const bw = `${home()}/.local/share/bellwether/helper/current/bw`;
    this.helper = createHelper({
      exec: /** @type {import("./helper.js").Exec} */ (exec),
      localInstall: async (machine) => {
        const r = await exec(bw, ["machine", "install", machine], { on: null });
        if (!r.stdout.trim()) throw new Error(r.stderr.trim() || `bw exited ${r.code}`);
        return parseLines(r.stdout);
      },
    });

    this.schedule = createSchedule(DRAFTS_TIMES);
    this.poke = createPoke();
    this.work = createPoke();

    /** @type {{ id: string, machine: string | null, folder: string | null, liveSpaceIds: string[] } | null} */
    this.space = null;
    /** @type {string | null} `[machine, folder]` */
    this.folderKey = null;
    /** @type {string | null} target key last handed to `schedule` */
    this.key = null;
    this.nonce = 0;
    this.shown = false;
    this.drawn = false;
    this.answered = false;
    this.parked = false;
    this.targeted = false;

    /** @type {DraftItem[]} */
    this.items = [];
    /** @type {{ state: string, message: string } | null} */
    this.failure = null;
    /** @type {string | null} */
    this.selectedId = null;
    /** @type {LoadedDoc | null} */
    this.doc = null;
    /** @type {{ key: string, machine: string | null, folder: string, entryId: string, kind: DraftKind } | null} */
    this.wantDoc = null;
    this.readWanted = false;

    /** @type {string | null} entry id currently staging/opening in Browser */
    this.openingId = null;
    /** @type {{ text: string, bad: boolean } | null} */
    this.note = null;
    /** @type {Set<string>} */
    this.folded = loadFolded();

    cx.spawn(async (/** @type {any} */ cx) => {
      while (this.alive) {
        await this.work.wait();
        if (!this.alive || !isShown(layout())) continue;
        if (this.readWanted) {
          this.readWanted = false;
          try {
            await this.loadSelectedDoc(cx);
          } catch (e) {
            if (this.doc) {
              this.doc = { ...this.doc, loading: false, error: errorText(e), failedKey: this.doc.key };
            }
            cx.notify();
          }
        }
      }
    });

    cx.spawn(async (/** @type {any} */ cx) => {
      await runRefresher(cx, {
        schedule: this.schedule,
        run: (target) => this.readList(target),
        onResult: (target, result) => this.mergeList(target, result),
        watchFolder,
        poke: this.poke,
        alive: () => this.alive,
      });
    });
  }

  close() {
    this.alive = false;
    this.poke.poke();
    this.work.poke();
  }

  /**
   * Runs one `bw drafts list --path <folder>` on `target.machine`, parking immediately when `Drafts`
   * is hidden or was not drawn since the previous result.
   * @param {import("./refresh-schedule.js").Target} target
   */
  async readList(target) {
    if (!isShown(layout()) || (!this.drawn && this.targeted && this.answered)) {
      this.parked = true;
      this.targeted = false;
      this.schedule.setTargets([], Date.now());
      return { ok: true, skipped: true };
    }
    const answer = await this.helper.call(target.machine, ["drafts", "list", "--path", target.path]);
    return { ok: answer.ok, answer };
  }

  /**
   * @param {import("./refresh-schedule.js").Target} target
   * @param {any} result
   * @returns {boolean}
   */
  mergeList(target, result) {
    if (!result || result.skipped || target.key !== this.key) return false;
    this.drawn = false;
    this.answered = true;
    const answer = result.answer;
    if (!answer) {
      this.failure = { state: "failed", message: String(result.message ?? "bw drafts list failed") };
      return true;
    }
    if (answer.ok === false) {
      this.failure = { state: answer.state, message: answer.message };
      return true;
    }
    this.failure = null;
    const items = parseDraftEntries(answer.lines);
    this.items = items;
    if (!this.selectedId || !items.some((i) => i.id === this.selectedId)) {
      this.selectedId = defaultSelectedId(items);
    }
    this.queueSelectedRead();
    return true;
  }

  queueSelectedRead() {
    const sp = this.space;
    if (!sp?.folder || !this.selectedId) {
      this.wantDoc = null;
      return;
    }
    const entry = this.items.find((i) => i.id === this.selectedId) ?? null;
    if (!entry || entry.kind === "html") {
      this.wantDoc = null;
      return;
    }
    const docKey = JSON.stringify([sp.machine, sp.folder, entry.id, entry.mtimeMs, this.nonce]);
    this.wantDoc = {
      key: docKey,
      machine: sp.machine,
      folder: sp.folder,
      entryId: entry.id,
      kind: entry.kind,
    };
    if (this.doc?.key === docKey || this.doc?.failedKey === docKey) return;
    this.readWanted = true;
    if (this.shown) this.work.poke();
  }

  /** @param {any} cx */
  async loadSelectedDoc(cx) {
    const req = this.wantDoc;
    if (!req) return;
    const prev = this.doc?.entryId === req.entryId ? this.doc : null;
    this.doc = {
      key: req.key,
      entryId: req.entryId,
      kind: req.kind,
      text: prev?.text ?? "",
      truncated: prev?.truncated ?? false,
      size: prev?.size ?? 0,
      loading: true,
      error: null,
      failedKey: null,
    };
    cx.notify();

    const answer = await this.helper.call(req.machine, ["drafts", "read", "--path", req.folder, "--file", req.entryId]);
    if (this.wantDoc?.key !== req.key) {
      if (this.wantDoc) {
        this.readWanted = true;
        this.work.poke();
      }
      return;
    }
    if (answer.ok === false) {
      this.doc = {
        key: req.key,
        entryId: req.entryId,
        kind: req.kind,
        text: "",
        truncated: false,
        size: 0,
        loading: false,
        error: answer.message,
        failedKey: req.key,
      };
      cx.notify();
      return;
    }
    const parsed = parseDraftRead(answer.lines);
    if (!parsed) {
      this.doc = {
        key: req.key,
        entryId: req.entryId,
        kind: req.kind,
        text: "",
        truncated: false,
        size: 0,
        loading: false,
        error: "bw drafts read returned no content",
        failedKey: req.key,
      };
      cx.notify();
      return;
    }
    this.doc = {
      key: req.key,
      entryId: req.entryId,
      kind: parsed.kind,
      text: parsed.text,
      truncated: parsed.truncated,
      size: parsed.size,
      loading: false,
      error: null,
      failedKey: null,
    };
    cx.notify();
  }

  /** @param {string} id @param {any} cx */
  selectEntry(id, cx) {
    this.note = null;
    if (this.selectedId === id && this.doc?.error) {
      this.nonce++;
    }
    this.selectedId = id;
    this.queueSelectedRead();
    cx.notify();
  }

  /** @param {any} cx */
  refreshNow(cx) {
    this.nonce++;
    this.note = null;
    this.failure = null;
    if (this.doc) this.doc = { ...this.doc, failedKey: null };
    this.poke.poke();
    cx.notify();
  }

  /** @param {string} kind @param {any} cx */
  toggleSection(kind, cx) {
    if (!this.folded.delete(kind)) this.folded.add(kind);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...this.folded]));
    } catch {}
    cx.notify();
  }

  /**
   * Opens an HTML artifact in Bellwether Chrome (`bw browser new`), staging remote HTML locally via
   * `bw drafts stage --machine <m>` (`on: null`) first when `space.machine !== null`.
   * @param {DraftItem} entry
   * @param {any} cx
   */
  openHtml(entry, cx) {
    if (this.openingId !== null) return;
    const snap = this.space;
    if (!snap?.folder) return;
    const { id: spaceId, machine, folder, liveSpaceIds } = snap;
    this.openingId = entry.id;
    this.note = null;
    cx.notify();

    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        /** @type {string | null} */
        let targetUrl = null;
        if (machine === null) {
          targetUrl = localFileUrlFor(folder, entry);
          if (!targetUrl) {
            this.note = { text: "Could not resolve local file URL for HTML artifact.", bad: true };
            return;
          }
        } else {
          const slug = stageSlugFor(entry);
          const staged = await this.helper.call(null, [
            "drafts",
            "stage",
            "--name",
            slug,
            "--machine",
            machine,
            "--path",
            folder,
            "--file",
            entry.id,
          ]);
          if (staged.ok === false) {
            this.note = { text: `Could not stage remote HTML: ${staged.message}`, bad: true };
            return;
          }
          const info = parseDraftStaged(staged.lines);
          if (!info?.url) {
            this.note = { text: "Could not stage remote HTML: missing staged file URL.", bad: true };
            return;
          }
          targetUrl = info.url;
        }

        let res = await this.helper.call(null, ["browser", "new", "--url", targetUrl]);
        const first = res.ok === true ? res.lines.find((/** @type {any} */ l) => l?.type === "tab-action") : null;
        if (first && first.ok === false && /\(stopped\)$/.test(String(first.message ?? ""))) {
          const up = await this.helper.call(null, ["browser", "up"]);
          const chrome = up.ok === true ? up.lines.find((/** @type {any} */ l) => l?.type === "chrome") : null;
          if (chrome?.state === "running") {
            res = await this.helper.call(null, ["browser", "new", "--url", targetUrl]);
          }
        }
        const action = res.ok === true ? res.lines.find((/** @type {any} */ l) => l?.type === "tab-action") : null;
        if (res.ok === false || action?.ok === false) {
          const why = res.ok === true ? String(action?.message || "failed") : res.message;
          this.note = { text: `Could not open HTML in Browser: ${why}`, bad: true };
          return;
        }

        run("layout.show", { id: "right" });
        if (!spaceId || this.space?.id === spaceId) {
          run("layout.select", { stack: "right-body", child: "browser" });
        }
        if (spaceId) {
          setShared(RIGHT_TAB, choose(shared(RIGHT_TAB), spaceId, "browser", liveSpaceIds));
        }
      } finally {
        this.openingId = null;
        cx.notify();
      }
    });
  }

  update() {
    const shown = isShown(layout());
    const allSpaces = spaces();
    const allPanes = panes();
    const activeSpace = allSpaces.find((s) => s.active) ?? null;
    const machine = activeSpace?.machine ?? null;
    const folder = activeSpace ? placeOf(activeSpace, allPanes) : null;
    this.space = activeSpace
      ? {
          id: activeSpace.id,
          machine,
          folder,
          liveSpaceIds: allSpaces.map((s) => s.id),
        }
      : null;

    const folderKey = folder ? JSON.stringify([machine, folder]) : null;
    if (folderKey !== this.folderKey) {
      this.folderKey = folderKey;
      this.answered = false;
      this.items = [];
      this.failure = null;
      this.selectedId = null;
      this.doc = null;
      this.wantDoc = null;
      this.note = null;
    }

    const key = folder ? JSON.stringify([machine, folder, this.nonce]) : null;
    const wanted = shown && key !== null;
    if (!wanted) {
      if (this.targeted) this.schedule.setTargets([], Date.now());
      this.targeted = false;
      this.parked = false;
    } else {
      const target = {
        key: /** @type {string} */ (key),
        kind: /** @type {const} */ ("counts"),
        machine,
        path: /** @type {string} */ (folder),
        open: true,
        selected: true,
        wakeOn: machine === null ? [/** @type {string} */ (folder)] : [],
      };
      const changed = this.schedule.setTargets([target], Date.now());
      if (changed || this.parked || !this.targeted) this.poke.poke();
      this.targeted = true;
      this.parked = false;
    }

    this.key = key;
    this.shown = shown;
    this.drawn = true;
    this.queueSelectedRead();
    if (shown && this.readWanted) this.work.poke();
  }

  render() {
    this.update();
    const t = themeColors();
    const sp = this.space;

    const root = v_flex().id("bw-drafts").size_full().min_h(0).bg(t.chrome).text_size(12.5).text_color(t.foreground);
    root.child(this.renderHeader(t));

    if (this.note) {
      root.child(
        h_flex()
          .id("drafts-note")
          .w_full()
          .flex_none()
          .px(10)
          .py(6)
          .gap(8)
          .items_center()
          .bg(t.raised)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .text_size(11.5)
              .text_color(this.note.bad ? t.blocked : t.done)
              .child(this.note.text),
          )
          .child(
            div()
              .id("drafts-note-dismiss")
              .cursor_pointer()
              .text_size(12)
              .text_color(t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
                this.note = null;
                cx.notify();
              })
              .child("×"),
          ),
      );
    }

    if (!sp?.folder) {
      return root.child(this.renderEmptyState(t, "Open a workspace folder to inspect its drafts and audit logs."));
    }

    if (this.failure && this.items.length === 0) {
      return root.child(this.renderFailure(t, this.failure));
    }

    if (!this.answered && this.items.length === 0) {
      return root.child(
        v_flex()
          .id("drafts-loading")
          .flex_1()
          .items_center()
          .justify_center()
          .gap(8)
          .p(16)
          .child(spinner(t, 14))
          .child(div().text_size(12).text_color(t.muted).child("Scanning worktree drafts…")),
      );
    }

    if (this.items.length === 0) {
      return root.child(
        this.renderEmptyState(
          t,
          "No drafts, plans, decisions.tsv, or review ledgers found in docs/drafts, docs/plans, docs/superpowers, .audit, or root.",
        ),
      );
    }

    const selected = this.items.find((i) => i.id === this.selectedId) ?? null;
    root.child(this.renderList(t, selected !== null));
    if (selected) {
      root.child(this.renderDetail(t, selected));
    }
    return root;
  }

  /** @param {Theme} t */
  renderHeader(t) {
    const sp = this.space;
    const count = this.items.length;
    return h_flex()
      .id("drafts-header")
      .h(36)
      .w_full()
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .id("drafts-folder")
          .min_w(0)
          .truncate()
          .font_medium()
          .text_size(12.5)
          .text_color(t.foreground)
          .child(folderName(sp?.folder ?? null)),
      )
      .when(Boolean(sp?.machine), (el) => el.child(machineTag(String(sp?.machine), t)))
      .when(count > 0, (el) => el.child(pill(t, String(count), "count", "drafts-count")))
      .child(div().flex_1())
      .child(
        button(t, {
          id: "drafts-refresh",
          label: "Refresh",
          h: 24,
          enabled: Boolean(sp?.folder),
          onClick: (_e, cx) => this.refreshNow(cx),
        }),
      );
  }

  /** @param {Theme} t @param {string} copy */
  renderEmptyState(t, copy) {
    return v_flex()
      .id("drafts-empty")
      .flex_1()
      .items_center()
      .justify_center()
      .p(20)
      .gap(6)
      .child(div().text_size(13).font_medium().text_color(t.foreground).child("Drafts & Audit"))
      .child(div().text_center().text_size(12).text_color(t.muted).child(copy));
  }

  /** @param {Theme} t @param {{ state: string, message: string }} failure */
  renderFailure(t, failure) {
    const headline =
      failure.state === "missing" || failure.state === "outdated"
        ? "Bellwether helper needs an update (`scripts/install-helper.sh`)."
        : failure.state === "installing"
          ? "Updating Bellwether helper…"
          : failure.message || "Could not read worktree drafts.";
    return v_flex()
      .id("drafts-error")
      .flex_1()
      .items_center()
      .justify_center()
      .p(20)
      .gap(8)
      .child(div().text_center().text_size(12).text_color(t.blocked).child(headline));
  }

  /** @param {Theme} t @param {boolean} hasDetail */
  renderList(t, hasDetail) {
    const groups = groupDraftEntries(this.items);
    const list = v_flex()
      .id("drafts-list")
      .w_full()
      .overflow_y_scroll()
      .px(6)
      .py(6)
      .gap(6)
      .when(hasDetail, (el) => el.max_h(210).flex_none().border_b(1).border_color(t.border))
      .when(!hasDetail, (el) => el.flex_1().min_h(0));

    for (const g of groups) {
      const folded = this.folded.has(g.kind);
      const sec = v_flex().id(`drafts-group-${g.kind}`).w_full().gap(2);
      sec.child(
        h_flex()
          .id(`drafts-sec-${g.kind}`)
          .h(22)
          .px(4)
          .gap(5)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.toggleSection(g.kind, cx))
          .child(
            svg(folded ? ICONS["chevron-right"] : ICONS["chevron-down"])
              .size(11)
              .text_color(t.muted),
          )
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(g.title))
          .child(pill(t, String(g.items.length), "machine")),
      );
      if (!folded) {
        for (const item of g.items) {
          sec.child(this.renderItemRow(t, item));
        }
      }
      list.child(sec);
    }
    return list;
  }

  /** @param {Theme} t @param {DraftItem} item */
  renderItemRow(t, item) {
    const active = item.id === this.selectedId;
    const slug = domSlug(item.id);
    const opening = this.openingId === item.id;
    const subColor = active ? mutedOnSelected : t.muted;

    return h_flex()
      .w_full()
      .min_h(28)
      .px(8)
      .py(4)
      .gap(6)
      .items_center()
      .rounded(6)
      .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!active, (el) => el.text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .child(
        h_flex()
          .id(`draft-row-${slug}`)
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.selectEntry(item.id, cx))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .when(active, (el) => el.font_medium())
              .child(item.label),
          )
          .when(item.kind !== "html", (el) =>
            el.child(div().flex_none().text_size(11).text_color(subColor).child(formatBytes(item.size))),
          ),
      )
      .when(item.kind === "html", (el) =>
        el.child(
          button(t, {
            id: `draft-open-${slug}`,
            label: opening ? "Opening…" : "Open in Browser",
            h: 22,
            on: active ? "raised" : undefined,
            enabled: this.openingId === null,
            onClick: (_e, cx) => this.openHtml(item, cx),
          }),
        ),
      );
  }

  /** @param {Theme} t @param {DraftItem} entry */
  renderDetail(t, entry) {
    const slug = domSlug(entry.id);
    const pane = v_flex().id("drafts-detail").flex_1().min_h(0).w_full().bg(t.surface);

    pane.child(
      h_flex()
        .id("drafts-detail-header")
        .min_h(34)
        .w_full()
        .flex_none()
        .px(10)
        .py(5)
        .gap(6)
        .items_center()
        .bg(t.chrome)
        .border_b(1)
        .border_color(t.border)
        .child(
          div()
            .id("drafts-detail-title")
            .flex_1()
            .min_w(0)
            .truncate()
            .font_medium()
            .text_size(12)
            .text_color(t.foreground)
            .child(entry.label),
        )
        .child(pill(t, entry.kind, "machine"))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(formatBytes(entry.size)))
        .when(entry.kind === "html", (el) =>
          el.child(
            button(t, {
              id: "drafts-open-selected",
              label: this.openingId === entry.id ? "Opening…" : "Open in Browser",
              kind: "primary",
              h: 24,
              enabled: this.openingId === null,
              onClick: (_e, cx) => this.openHtml(entry, cx),
            }),
          ),
        ),
    );

    const body = v_flex().id(`drafts-body-${slug}`).flex_1().min_h(0).w_full().overflow_y_scroll().p(10).gap(10);

    if (entry.kind === "html") {
      const isRemote = Boolean(this.space?.machine);
      body.child(
        v_flex()
          .id("drafts-html-card")
          .w_full()
          .p(12)
          .gap(8)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .child(div().text_size(12.5).font_medium().text_color(t.foreground).child("Self-contained HTML artifact"))
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(
                isRemote
                  ? `Stages ${entry.label} locally from ${this.space?.machine} and opens it in Bellwether Chrome.`
                  : `Opens ${entry.label} directly in Bellwether Chrome via file://.`,
              ),
          ),
      );
      return pane.child(body);
    }

    const doc = this.doc?.entryId === entry.id ? this.doc : null;
    if (!doc || (doc.loading && !doc.text)) {
      body.child(
        h_flex()
          .id("drafts-doc-loading")
          .gap(8)
          .items_center()
          .p(8)
          .child(spinner(t, 13))
          .child(div().text_size(12).text_color(t.muted).child(`Reading ${entry.label}…`)),
      );
      return pane.child(body);
    }

    if (doc.error) {
      body.child(
        div()
          .id("drafts-doc-error")
          .p(10)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.blocked)
          .child(doc.error),
      );
      return pane.child(body);
    }

    if (doc.truncated) {
      body.child(pill(t, "Showing first 512 KiB", "blocked", "drafts-truncated"));
    }

    if (entry.kind === "decisions") {
      body.child(this.renderDecisions(t, doc.text));
    } else if (entry.kind === "plan") {
      body.child(this.renderPlan(t, entry.id, doc.text));
    } else {
      body.child(this.renderMarkdown(t, entry.id, doc.text));
    }
    return pane.child(body);
  }

  /** @param {Theme} t @param {string} text */
  renderDecisions(t, text) {
    const { rows } = parseDecisionsTsv(text);
    const wrap = v_flex().id("drafts-decisions").w_full().gap(8);
    if (rows.length === 0) {
      return wrap.child(div().text_size(12).text_color(t.muted).child("No decision rows recorded yet."));
    }
    wrap.child(
      h_flex()
        .gap(6)
        .items_center()
        .child(
          div()
            .text_size(11.5)
            .font_semibold()
            .text_color(t.muted)
            .child(`${rows.length} ${rows.length === 1 ? "decision" : "decisions"}`),
        ),
    );
    rows.forEach((row, idx) => {
      wrap.child(
        v_flex()
          .id(`decision-row-${idx}`)
          .w_full()
          .p(9)
          .gap(5)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .items_center()
              .flex_wrap()
              .when(Boolean(row.phase), (el) => el.child(pill(t, row.phase, row.phaseTone, `decision-phase-${idx}`)))
              .when(Boolean(row.result), (el) =>
                el.child(pill(t, row.result, row.resultTone, `decision-result-${idx}`)),
              )
              .child(div().flex_1())
              .when(Boolean(row.ts), (el) =>
                el.child(div().id(`decision-ts-${idx}`).text_size(10.5).text_color(t.muted).child(row.ts)),
              ),
          )
          .child(
            div()
              .id(`decision-title-${idx}`)
              .w_full()
              .text_size(12.5)
              .font_medium()
              .text_color(t.foreground)
              .child(row.decision),
          )
          .when(Boolean(row.why), (el) =>
            el.child(div().id(`decision-why-${idx}`).w_full().text_size(11.5).text_color(t.muted).child(row.why)),
          )
          .when(Boolean(row.compactEvidence), (el) =>
            el.child(
              h_flex()
                .id(`decision-evidence-${idx}`)
                .max_w_full()
                .px(6)
                .py(2)
                .rounded(5)
                .bg(t.chrome)
                .border(1)
                .border_color(t.border)
                .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(row.compactEvidence)),
            ),
          ),
      );
    });
    return wrap;
  }

  /** @param {Theme} t @param {string} entryId @param {string} text */
  renderPlan(t, entryId, text) {
    const checklist = parsePlanChecklist(text);
    const wrap = v_flex().id("drafts-plan").w_full().gap(10);
    if (checklist.total > 0) {
      const allDone = checklist.done === checklist.total;
      wrap.child(
        v_flex()
          .id("drafts-plan-checklist")
          .w_full()
          .p(10)
          .gap(8)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .id("drafts-plan-progress")
              .w_full()
              .gap(8)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .text_size(12)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(`${checklist.done} of ${checklist.total} complete`),
              )
              .child(pill(t, `${checklist.percent}%`, allDone ? "done" : "working", "drafts-plan-percent")),
          )
          .child(
            h_flex()
              .w_full()
              .h(6)
              .rounded(3)
              .overflow_hidden()
              .bg(t.chrome)
              .when(checklist.done > 0, (el) =>
                el.child(
                  div()
                    .h_full()
                    .flex_grow(checklist.done)
                    .bg(allDone ? t.done : t.accent),
                ),
              )
              .when(checklist.total - checklist.done > 0, (el) =>
                el.child(
                  div()
                    .h_full()
                    .flex_grow(checklist.total - checklist.done),
                ),
              ),
          )
          .children(
            checklist.items.map((item, idx) =>
              h_flex()
                .id(`plan-check-${idx}`)
                .w_full()
                .pl(item.indent * 12)
                .gap(7)
                .items_start()
                .child(
                  h_flex()
                    .size(14)
                    .mt(2)
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .border(1)
                    .border_color(item.checked ? t.done : t.border)
                    .when(item.checked, (el) => el.bg(t.done))
                    .when(item.checked, (el) => el.child(svg(ICONS.check).size(10).text_color(t.accent_foreground))),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .text_size(12)
                    .text_color(item.checked ? t.muted : t.foreground)
                    .child(item.text),
                ),
            ),
          ),
      );
    }
    if (text.trim()) {
      wrap.child(this.renderMarkdown(t, entryId, text));
    }
    return wrap;
  }

  /** @param {Theme} t @param {string} entryId @param {string} text */
  renderMarkdown(t, entryId, text) {
    const slug = domSlug(entryId);
    const trimmed = text.trim();
    if (!trimmed) {
      return div().id(`drafts-empty-md-${slug}`).text_size(12).text_color(t.muted).child("Empty document.");
    }
    return div()
      .id("drafts-markdown")
      .w_full()
      .min_w(0)
      .overflow_x_hidden()
      .p(10)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .text_size(12.5)
      .child(TextView.markdown(`drafts-md-${slug}`, trimmed).selectable(true));
  }
}
