// The "+" menu: a chat, a shell or an agent in the space (or a new space in a folder), and Herdr's worktree dialogs.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, knownAgents, openOverlay, panes, props, run, setShared, shared, spaces, theme } from "herdr";
import { addPending } from "./chat-tabs.js";
import { chatLaunch, contextOf, menuEntries } from "./entries.js";
import { ICONS, programIcon } from "./ui.js";

// The last agents each machine reported, keyed by machine name ("" for this Mac), shown at once.
const KNOWN = "bw.known-agents";
const CHAT_TABS = "bw.chat-tabs";

export default class NewMenu extends View {
  /** @param {any} p @param {any} cx */
  init(p, cx) {
    const machine = contextOf(p ?? props(), spaces(), panes()).machine;
    const where = machine ?? "";
    const cached = /** @type {any} */ (shared(KNOWN))?.[where];
    /** @type {import("./entries.js").KnownAgent[] | null} */
    this.agents = Array.isArray(cached) ? cached : null;
    this.failed = false;
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

  render() {
    const t = theme();
    const p = props() ?? {};
    const rows = menuEntries({ agents: this.agents, failed: this.failed, ctx: contextOf(p, spaces(), panes()) });

    const icon = (/** @type {import("./entries.js").Row} */ r) => {
      if (r.section === "Worktree") return svg(ICONS.branch).size(14).flex_none().text_color(t.muted);
      return programIcon(r.agent, t);
    };
    const line = (/** @type {import("./entries.js").Row} */ r) =>
      h_flex().id(`row-${r.id}`).h(30).px(8).gap(9).flex_none().items_center().rounded(6)
        .text_color(r.enabled ? t.foreground : t.dim)
        .when(r.enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
        .on_click(() => {
          if (!r.enabled) return;
          // The space can close after this render drew the row.
          const all = spaces();
          const ctx = contextOf(props() ?? {}, all, panes());
          if (ctx.closed) return;
          if (typeof p.overlay === "string") closeOverlay(p.overlay);
          if (r.action[0] === "run") run(r.action[1], r.action[2]);
          else if (r.action[0] === "chat") {
            const { pending, command } = chatLaunch(r.action[1], ctx, all);
            // Recorded before the tab exists, so bw-tabs's render for the new tab already finds it.
            setShared(CHAT_TABS, addPending(shared(CHAT_TABS), pending, Date.now()));
            run(command[0], command[1]);
          } else openOverlay(r.action[1]);
        })
        .child(icon(r))
        .child(div().flex_1().min_w(0).truncate().child(r.label))
        .when(r.hint !== "", (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(r.hint)));
    const heading = (/** @type {string} */ name) => div().px(8).pt(6).pb(3).text_size(11).text_color(t.dim).child(name);

    const sections = [...new Set(rows.map((r) => r.section))];
    return v_flex().id("bw-new").w(232).p(4).bg(t.popover).text_size(12.5).children(
      sections.map((s) => v_flex().children([heading(s), ...rows.filter((r) => r.section === s).map(line)])),
    );
  }
}
