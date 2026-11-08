// Changes: Staged, Changes and Committed on branch for the active space's worktree, with the selected file's
// patch below. Without props this copy is the right sidebar's panel; with `{ tab: true, … }` it is a diff
// opened as a middle tab. The panel's loop task runs `bw diff files` on the space's machine through the
// shared refresh schedule (a watch here, every 1.5 s elsewhere) only while the panel is shown and drawn;
// render reads live data, sets the target and pokes the loop.
import { div, svg, View } from "gpui-kit";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { exec, home, layout, panes, props, run, setShared, shared, spaces, watchFolder } from "herdr";
import { dropReveal, REVEAL, revealFor } from "./diff-reveal.js";
import { createHelper, parseLines } from "./helper.js";
import {
  BASE_KEY,
  filesArgs,
  isShown,
  patchArgs,
  readBase,
  readTab,
  rowFor,
  SECTIONS,
  SECTION_TITLE,
  selectionOf,
  splitPath,
  tabMachine,
  totals,
  viewFiles,
  writeBase,
} from "./model.js";
import { patchView, letterColor, counts } from "./patch.js";
import { placeOf, projectKey } from "./projects-model.js";
import { createPoke, runRefresher } from "./refresh-driver.js";
import { createSchedule } from "./refresh-schedule.js";
import { ago, button, card, hoverFill, ICONS, mutedOnSelected, pill, spinner, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./model.js").FilesView} FilesView */
/** @typedef {import("./model.js").Selection} Selection */
/** @typedef {import("./model.js").Section} Section */
/** @typedef {import("./model.js").BaseChoice} BaseChoice */

const WINDOW_ID = "bw.window-id";
const FOLDED = "bw-diff.folded";
/** @param {string} name */
const icon = (name) => `mods/bw-diff/icons/${name}.svg`;

/**
 * @typedef {object} PatchState
 * @property {string} key the selection it belongs to
 * @property {string | null} digest
 * @property {{ text: string, cut: { line: number, bytes: number }[] }[]} pages
 * @property {number} total
 * @property {number} bytes
 * @property {boolean} loading
 * @property {string | null} error
 */

/** @param {Selection | null} s */
const selKey = (s) => (s ? JSON.stringify([s.section, s.path, s.oldPath]) : "");

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
    exec,
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

export default class Changes extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    this.tab = readTab(props());
    this.helper = helperFor(null);
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
    // Render has no cx, so it asks this loop for patches and refs.
    this.work = createPoke();
    /** @type {string | null} */
    this.note = null;
    /** @type {string | null} the button whose action runs */
    this.busy = null;
    /** @type {string | null} */
    this.hovered = null;
    this.height = 0;
    this.folded = loadFolded();
    cx.spawn(async (/** @type {any} */ cx) => {
      while (this.alive) {
        await this.work.wait();
        if (this.alive && this.refsWanted) {
          this.refsWanted = false;
          await this.loadRefs(cx);
        }
        if (this.alive && this.patchWanted) {
          this.patchWanted = false;
          await this.loadPatch(cx);
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
    /** @type {{ machine: string | null, folder: string, base: BaseChoice, project: string | null } | null} */
    this.want = null;
    /** The common dir each folder was found in, so a stored base is known before the first read ends. */
    /** @type {Map<string, string>} */
    this.commonDirs = new Map();
    this.nonce = 0;
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

  /** One `bw diff files` call, or none when the copy was not drawn since the last result. @param {any} target */
  async read(target) {
    if (!this.drawn && this.targeted && this.answered) {
      this.parked = true;
      this.targeted = false;
      this.schedule?.setTargets([], Date.now());
      return { ok: true, skipped: true };
    }
    const sel = this.selected;
    const answer = await this.helper.call(target.machine, filesArgs(target.path, target.base, sel));
    return { ok: answer.ok, answer, sel };
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
    const view = viewFiles(answer.lines);
    if (!view) {
      this.failure = { state: "bad_output", message: "bw diff files printed no place" };
      return true;
    }
    this.failure = null;
    this.view = view;
    this.commonDirs.set(/** @type {string} */ (this.folderKey), view.place.commonDir);
    const sel = this.selected;
    if (sel) {
      const still = view.sections[sel.section].find((r) => r.path === sel.path);
      if (!still) {
        this.note = `${splitPath(sel.path).name} has no ${SECTION_TITLE[sel.section].toLowerCase()} now`;
        this.selected = null;
        this.patch = null;
      } else if (
        selKey(result.sel) === selKey(sel) &&
        view.digest &&
        this.patch &&
        !this.patch.loading &&
        view.digest.digest !== this.patch.digest
      ) {
        this.wantPatch(0);
      }
    }
    return true;
  }

  /** Loads `this.patchPage` of the selected file's patch. @param {any} cx */
  async loadPatch(cx) {
    const sel = this.selected;
    const top = this.tab ? this.tab.top : this.view?.place.top;
    if (!sel || !top) return;
    const key = selKey(sel);
    const page = this.patch?.key === key ? this.patchPage : 0;
    const range = this.tab
      ? { from: this.tab.from, to: this.tab.to }
      : { from: this.view?.base.from ?? null, to: this.view?.place.head ?? null };
    const args = patchArgs(top, sel, range, page);
    const keep = page > 0 && this.patch?.key === key ? this.patch : null;
    if (!args) {
      this.patch = { key, digest: null, pages: [], total: 0, bytes: 0, loading: false, error: "Pick a base first" };
      cx.notify();
      return;
    }
    this.patch = keep
      ? { ...keep, loading: true }
      : {
          key,
          digest: this.patch?.key === key ? this.patch.digest : null,
          pages: this.patch?.key === key ? this.patch.pages : [],
          total: 0,
          bytes: 0,
          loading: true,
          error: null,
        };
    cx.notify();
    const answer = await this.helper.call(this.machine(), args);
    if (selKey(this.selected) !== key) return;
    const line = answer.ok ? /** @type {any} */ (answer.lines.find((l) => l.type === "diff-patch")) : null;
    if (!line) {
      const message = answer.ok === false ? answer.message : "bw diff patch printed no page";
      this.patch = { .../** @type {PatchState} */ (this.patch), loading: false, error: message };
    } else {
      const got = { text: String(line.text ?? ""), cut: Array.isArray(line.cut) ? line.cut : [] };
      this.patch = {
        key,
        digest: typeof line.digest === "string" ? line.digest : null,
        pages: keep ? [...keep.pages, got] : [got],
        total: Number(line.pages) || 1,
        bytes: Number(line.bytes) || 0,
        loading: false,
        error: null,
      };
    }
    cx.notify();
  }

  /** @param {import("./model.js").Row} row @param {any} cx */
  pick(row, cx) {
    this.note = null;
    if (selKey(this.selected) === selKey(selectionOf(row))) return;
    this.selected = selectionOf(row);
    this.patch = null;
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
        if (r.ok === false) return `Fetch failed: ${r.message}`;
        const done = /** @type {any} */ (r.lines.find((l) => l.type === "diff-fetched"));
        return `Fetched ${done?.remote ?? "origin"}`;
      },
      cx,
    );
  }

  /** @param {BaseChoice} choice */
  storeBase(choice) {
    const project = this.want?.project;
    if (!project) return;
    setShared(BASE_KEY, writeBase(shared(BASE_KEY), project, choice));
  }

  /** @param {any} cx */
  openPicker(cx) {
    this.picker.open = !this.picker.open;
    this.picker.error = null;
    if (this.picker.open) {
      this.filter.focus();
      if (this.picker.refs === null) this.wantRefs();
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
    this.picker.loading = true;
    cx.notify();
    const r = await this.helper.call(this.machine(), ["diff", "refs", "--path", top]);
    this.picker.loading = false;
    if (this.view?.place.top !== top) return;
    if (r.ok === false) this.picker.error = r.message;
    else this.picker.refs = r.lines.filter((l) => l.type === "diff-ref");
    cx.notify();
  }

  /** @param {string | null} ref */
  chooseRef(ref) {
    this.storeBase({ ref, mode: this.want?.base.mode ?? "merge-base" });
    this.picker.open = false;
    this.filter.set_value("");
    this.note = null;
  }

  /** Enter in the picker: a listed ref is taken as it is; anything else is checked first. @param {any} cx */
  submitRef(cx) {
    const text = this.filter.value().trim();
    const top = this.view?.place.top;
    if (!text || !top) return;
    if ((this.picker.refs ?? []).some((r) => r.name === text)) {
      this.chooseRef(text);
      return cx.notify();
    }
    this.act(
      "diff-verify",
      async () => {
        const r = await this.helper.call(this.machine(), ["diff", "refs", "--path", top, "--verify", text]);
        if (r.ok === false) {
          this.picker.error = r.message;
          return null;
        }
        this.chooseRef(text);
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

  /** Reads live data, sets the refresh target, applies a waiting reveal. */
  update() {
    const shown = isShown(layout());
    const space = spaces().find((s) => s.active) ?? null;
    const machine = space?.machine ?? null;
    const folder = space ? placeOf(space, panes()) : null;
    this.space = space ? { id: space.id, machine } : null;
    const folderKey = folder ? JSON.stringify([machine, folder]) : null;
    if (folderKey !== this.folderKey) {
      this.folderKey = folderKey;
      this.answered = false;
      this.view = null;
      this.failure = null;
      this.selected = null;
      this.patch = null;
      this.picker = { open: false, refs: null, loading: false, error: null };
      this.note = null;
    }
    const commonDir = folderKey ? (this.commonDirs.get(folderKey) ?? null) : null;
    const project = commonDir ? projectKey(machine, commonDir) : null;
    const base = project ? readBase(shared(BASE_KEY), project) : readBase(null, "");
    this.want = folder ? { machine, folder, base, project } : null;

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

    const view = this.view;
    if (!space || !view || !project) return;
    if (view.base.source === "none" && !this.autoPicked.has(project) && !this.picker.open) {
      this.autoPicked.add(project);
      this.picker.open = true;
      this.wantRefs();
    }
    const reveal = revealFor(shared(REVEAL), space.id);
    if (reveal && reveal.at !== this.revealed && shown) {
      this.revealed = reveal.at;
      const row = rowFor(view, reveal.file);
      if (row) {
        this.selected = selectionOf(row);
        this.patch = null;
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
    const list = v_flex()
      .id("diff-list")
      .min_h(0)
      .overflow_y_scroll()
      .p(6)
      .gap(2)
      .when(showPatch, (el) => el.flex_none().max_h(Math.max(140, Math.round(this.height * 0.42))))
      .when(!showPatch, (el) => el.flex_1());
    for (const s of SECTIONS) for (const el of this.section(t, view, s)) list.child(el);
    root.child(list);
    if (showPatch) root.child(this.patchPane(t));
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
    const baseName = base?.ref ?? "pick a base";
    const age = base?.time != null ? ago(base.time * 1000, Date.now()) : null;
    const meta = base?.short ? `${base.short}${age ? ` · ${age}` : ""}` : "";
    const ready = view !== null && this.want?.project != null;
    const mode = base?.mode ?? "merge-base";
    return v_flex()
      .id("diff-header")
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(36)
          .px(12)
          .gap(8)
          .items_center()
          .child(svg(ICONS.branch).size(14).flex_none().text_color(t.accent))
          .child(
            h_flex()
              .id("diff-base-button")
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .when(ready, (el) => el.cursor_pointer())
              .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => ready && this.openPicker(cx))
              .child(div().flex_none().max_w(140).truncate().font_medium().child(branch))
              .child(div().flex_none().text_color(t.muted).child("→"))
              .child(
                div()
                  .id("diff-base-name")
                  .min_w(0)
                  .truncate()
                  .font_medium()
                  .text_color(base?.ref ? t.foreground : t.muted)
                  .child(baseName),
              )
              .child(svg(ICONS["chevron-down"]).size(10).flex_none().text_color(t.dim))
              .when(meta !== "", (el) =>
                el.child(div().id("diff-base-meta").flex_none().text_size(11).text_color(t.muted).child(meta)),
              ),
          )
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
          .child(
            h_flex()
              .id("diff-mode")
              .h(24)
              .p(2)
              .gap(2)
              .items_center()
              .rounded(12)
              .bg(t.raised)
              .children(
                /** @type {const} */ ([
                  ["merge-base", "Merge base"],
                  ["tip", "Tip"],
                ]).map(([id, label]) => {
                  const on = mode === id;
                  return h_flex()
                    .id(`diff-mode-${id}`)
                    .h(20)
                    .px(10)
                    .items_center()
                    .rounded(10)
                    .text_size(11.5)
                    .text_color(on ? t.foreground : t.muted)
                    .when(on, (el) => el.bg(t.selected).font_medium())
                    .when(!on && ready, (el) =>
                      el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)),
                    )
                    .on_click(() => {
                      if (!ready || on) return;
                      this.storeBase({ ref: this.want?.base.ref ?? null, mode: id });
                    })
                    .child(label);
                }),
              ),
          )
          .child(div().flex_1())
          .when(Boolean(base?.error), (el) =>
            el.child(div().min_w(0).truncate().text_size(11).text_color(t.blocked).child(String(base?.error))),
          ),
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
          current === r.name,
          () => this.chooseRef(String(r.name)),
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
      .child(
        div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.muted).child(SECTION_TITLE[s]),
      )
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

  /** @param {Theme} t */
  patchPane(t) {
    const sel = /** @type {Selection} */ (this.selected);
    return patchView(t, {
      id: "diff-patch",
      title: sel.path,
      detail: SECTION_TITLE[sel.section],
      patch: this.patch?.key === selKey(sel) ? this.patch : null,
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
    const where = tabMachine(tab, /** @type {string | null} */ (shared(WINDOW_ID) ?? null), spaces());
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
      tab.machine,
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
