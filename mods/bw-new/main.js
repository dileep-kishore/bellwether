// The "+" menu: a chat, a shell or an agent in the space (or a new space in a folder), and Herdr's worktree dialogs.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  closeOverlay,
  exec,
  knownAgents,
  notify,
  openOverlay,
  panes,
  props,
  run,
  setShared,
  shared,
  spaces,
} from "herdr";
import { addPending, chatArgv } from "./chat-tabs.js";
import {
  argsRequest,
  chatLaunch,
  contextOf,
  extrasFrom,
  launchFolder,
  menuEntries,
  terminalLaunch,
} from "./entries.js";
import { createHelper } from "./helper.js";
import { ICONS, appear, card, hoverFill, programIcon, spinner, themeColors } from "./ui.js";

// The last agents each machine reported, keyed by machine name ("" for this Mac), shown at once.
const KNOWN = "bw.known-agents";
const CHAT_TABS = "bw.chat-tabs";
// How long "+" waits for the browser flags before it starts the agent without them.
const ARGS_BUDGET_MS = 20000;
/** @type {import("./entries.js").ArgsResult} */
const TIMED_OUT = { ok: false, state: "timeout", message: "The browser was not ready within 20 s." };

export default class NewMenu extends View {
  /** @param {any} p @param {any} cx */
  init(p, cx) {
    const machine = contextOf(p ?? props(), spaces(), panes()).machine;
    const where = machine ?? "";
    const cached = /** @type {any} */ (shared(KNOWN))?.[where];
    /** @type {import("./entries.js").KnownAgent[] | null} */
    this.agents = Array.isArray(cached) ? cached : null;
    this.failed = false;
    /** The card fades in once it has been laid out. */
    this.shown = false;
    /** The row under the pointer. @type {string | null} */
    this.hovered = null;
    /** The row whose agent waits for its browser flags; every click is ignored meanwhile. @type {string | null} */
    this.preparing = null;
    /** The prepared agent `render` starts next. @type {{ action: import("./entries.js").RowAction, ctx: import("./entries.js").MenuContext, overlay: string | null, argv: string[], notice: string | null } | null} */
    this.ready = null;
    // Only the window machine is called, and the helper never installs there.
    this.helper = createHelper({
      exec,
      localInstall: async () => {
        throw new Error("bw-new installs no helper");
      },
    });
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const list = await knownAgents({ on: machine });
        this.agents = list;
        const all = shared(KNOWN);
        setShared(KNOWN, { ...(all && typeof all === "object" && !Array.isArray(all) ? all : {}), [where]: list });
      } catch {
        this.failed = true;
      }
      cx.notify();
    });
  }

  /**
   * Asks the window machine for the agent's browser flags, then hands them to `render`, which
   * starts the agent with them, or without them and a warning when they fail or take longer than
   * the budget.
   * @param {import("./entries.js").Row} r an agent row
   * @param {import("./entries.js").MenuContext} ctx with the folder the agent starts in
   * @param {string | null} overlay
   * @param {any} cx
   */
  prepare(r, ctx, overlay, cx) {
    const kind = /** @type {import("./chat-tabs.js").ChatKind} */ (r.kind);
    const action = r.action;
    if (action[0] === "overlay") return;
    const runArgv = /** @type {string[]} */ (action[0] === "chat" ? action[1].argv : action[2].argv);
    this.preparing = r.id;
    cx.notify();
    const request = argsRequest(kind, ctx, runArgv);
    cx.spawn(async (/** @type {any} */ cx) => {
      /** @type {Promise<import("./entries.js").ArgsResult>} */
      const call = this.helper.call(null, request).then(
        (res) => /** @type {import("./entries.js").ArgsResult} */ (res),
        (e) => ({ ok: false, state: "failed", message: e instanceof Error ? e.message : String(e) }),
      );
      const result = await Promise.race([call, cx.sleep(ARGS_BUDGET_MS).then(() => TIMED_OUT)]);
      const { extras, notice } = extrasFrom(result);
      this.ready = { action, ctx, overlay, argv: chatArgv(kind, runArgv, extras), notice };
      cx.notify();
    });
  }

  /** Starts the prepared agent once; a render may read spaces() where the task may not. */
  launch() {
    const ready = this.ready;
    if (!ready) return;
    this.ready = null;
    this.preparing = null;
    const { action, ctx, overlay, argv, notice } = ready;
    if (overlay) closeOverlay(overlay);
    // Taken now, so a same-named tab or space made during the wait counts as already there.
    const all = spaces();
    if (ctx.space && !all.some((s) => s.id === ctx.space)) {
      notify({
        title: "Nothing started",
        body: "The space closed while the browser was being prepared.",
        level: "warning",
      });
      return;
    }
    if (action[0] === "chat") {
      const { pending, command } = chatLaunch({ ...action[1], argv }, ctx, all);
      // Recorded before the tab exists, so bw-tabs's render for the new tab already finds it.
      setShared(CHAT_TABS, addPending(shared(CHAT_TABS), pending, Date.now()));
      run(command[0], command[1]);
    } else if (action[0] === "run") {
      const [name, args] = terminalLaunch(action, ctx, argv);
      run(name, args);
    }
    if (notice) notify({ title: "Started without the browser", body: notice, level: "warning" });
  }

  render() {
    this.launch();
    const t = themeColors();
    const p = props() ?? {};
    const rows = menuEntries({ agents: this.agents, failed: this.failed, ctx: contextOf(p, spaces(), panes()) });

    const busy = this.preparing !== null;
    const tile = (/** @type {any} */ glyph) =>
      div().size(22).flex_none().rounded(6).bg(t.raised).flex().items_center().justify_center().child(glyph);
    const icon = (/** @type {import("./entries.js").Row} */ r) => {
      if (r.id === this.preparing) return tile(spinner(t, 14));
      if (r.section === "Worktree") return tile(svg(ICONS.branch).size(14).flex_none().text_color(t.muted));
      return tile(programIcon(r.agent, t));
    };
    const line = (/** @type {import("./entries.js").Row} */ r) => {
      const hint = r.id === this.preparing ? "Preparing browser…" : r.hint;
      const live = r.enabled && !busy;
      return h_flex()
        .id(`row-${r.id}`)
        .relative()
        .h(30)
        .px(6)
        .gap(9)
        .flex_none()
        .items_center()
        .rounded(8)
        .text_color(r.enabled ? t.foreground : t.muted)
        .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
          const next = on ? r.id : this.hovered === r.id ? null : this.hovered;
          if (next === this.hovered) return;
          this.hovered = next;
          cx.notify();
        })
        .when(live, (el) => el.cursor_pointer())
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
          if (!r.enabled || this.preparing !== null) return;
          // The space can close after this render drew the row.
          const all = spaces();
          const live = panes();
          const ctx = contextOf(props() ?? {}, all, live);
          if (ctx.closed) return;
          const overlay = typeof p.overlay === "string" ? p.overlay : null;
          if (r.kind !== null && r.action[0] !== "overlay") {
            this.prepare(r, { ...ctx, folder: launchFolder(ctx, all, live) }, overlay, cx);
            return;
          }
          if (overlay) closeOverlay(overlay);
          if (r.action[0] === "run") run(r.action[1], r.action[2]);
          else if (r.action[0] === "overlay") openOverlay(r.action[1]);
        })
        .child(hoverFill(t, `hover-${r.id}`, live && this.hovered === r.id, 8))
        .child(icon(r))
        .child(div().flex_1().min_w(0).truncate().child(r.label))
        .when(hint !== "", (el) =>
          el.child(
            div()
              .flex_none()
              .text_size(11)
              .text_color(r.id === this.preparing ? t.accent : t.muted)
              .child(hint),
          ),
        );
    };
    const heading = (/** @type {string} */ name) =>
      div().px(8).pt(6).pb(3).text_size(11).font_medium().text_color(t.muted).child(name);

    const sections = [...new Set(rows.map((r) => r.section))];
    return appear(
      card(t, "bw-new", { fill: "popover" })
        .size_full()
        .p(4)
        .overflow_hidden()
        .text_size(12.5)
        .on_size_change((/** @type {unknown} */ _s, /** @type {any} */ cx) => {
          if (this.shown) return;
          this.shown = true;
          cx.notify();
        })
        .children(
          sections.map((s) => v_flex().children([heading(s), ...rows.filter((r) => r.section === s).map(line)])),
        ),
      this.shown,
    );
  }
}
