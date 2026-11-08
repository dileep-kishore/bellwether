// A project's menu, opened by bw-projects (its "⋯" or a right-click) with the project in props.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { closeOverlay, openOverlay, props, setShared, shared } from "herdr";
import { forgetProject, projectKey } from "./projects-model.js";
import { ICONS, appear, card, hoverFill, themeColors } from "./ui.js";

/**
 * @typedef {object} MenuProject What bw-projects' projectMenu passes.
 * @property {string} key
 * @property {string | null} machine
 * @property {string} commonDir
 * @property {string | null} main
 * @property {string} name
 * @property {boolean} open
 */

/** @typedef {{ id: string, icon: string | null, label: string, hint: string, enabled: boolean, act: () => void }} Row */

const DIALOG = { new: { width: 460, height: 280 }, open: { width: 560, height: 480 } };

export default class Menu extends View {
  init() {
    /** The card fades in once it has been laid out. */
    this.shown = false;
    /** The row under the pointer. @type {string | null} */
    this.hovered = null;
  }

  render() {
    const t = themeColors();
    const p = /** @type {{ project?: MenuProject, overlay?: string }} */ (props() ?? {});
    const project = p.project && typeof p.project.commonDir === "string" ? p.project : null;
    const close = () => {
      if (typeof p.overlay === "string") closeOverlay(p.overlay);
    };
    const root = appear(
      card(t, "bw-menu", { fill: "popover" })
        .size_full()
        .p(5)
        .overflow_hidden()
        .text_size(12.8)
        .text_color(t.foreground)
        .on_size_change((/** @type {unknown} */ _s, /** @type {any} */ cx) => {
          if (this.shown) return;
          this.shown = true;
          cx.notify();
        }),
      this.shown,
    );
    if (!project) return root.child(div().px(9).py(6).text_color(t.muted).child("No project"));

    /** @param {"new" | "open"} action */
    const worktree = (action) => () =>
      openOverlay({
        mod: "worktree",
        kind: "dialog",
        ...DIALOG[action],
        props: { folder: project.main, machine: project.machine, action },
      });
    const noMain = project.main ? "" : "no main checkout";
    /** @type {Row[]} */
    const rows = [
      {
        id: "menu-worktree-new",
        icon: ICONS.plus,
        label: "New worktree…",
        hint: noMain,
        enabled: !noMain,
        act: worktree("new"),
      },
      {
        id: "menu-worktree-open",
        icon: ICONS.branch,
        label: "Open worktree…",
        hint: noMain,
        enabled: !noMain,
        act: worktree("open"),
      },
      {
        id: "menu-linear",
        icon: "mods/bw-right/icons/issues.svg",
        label: "Link Linear project",
        hint: "coming in phase 6",
        enabled: false,
        act: () => {},
      },
      {
        id: "menu-remove",
        icon: ICONS.close,
        label: "Remove",
        // bw-projects remembers every project an open space shows, so removing one now would not stick.
        hint: project.open ? "close its spaces first" : "",
        enabled: !project.open,
        // The stored list spells this Mac null; "" would be a different key.
        act: () =>
          setShared(
            "bw.projects",
            forgetProject(shared("bw.projects"), projectKey(project.machine || null, project.commonDir)),
          ),
      },
    ];

    /** @param {Row} r */
    const row = (r) =>
      h_flex()
        .id(r.id)
        .relative()
        .h(30)
        .px(6)
        .gap(9)
        .rounded(8)
        .items_center()
        .flex_none()
        .text_color(r.enabled ? t.foreground : t.muted)
        .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
          const next = on ? r.id : this.hovered === r.id ? null : this.hovered;
          if (next === this.hovered) return;
          this.hovered = next;
          cx.notify();
        })
        .when(r.enabled, (el) => el.cursor_pointer())
        .on_click(() => {
          if (!r.enabled) return;
          close();
          r.act();
        })
        .child(hoverFill(t, `hover-${r.id}`, r.enabled && this.hovered === r.id, 8))
        .child(
          div()
            .size(22)
            .flex_none()
            .rounded(6)
            .bg(t.raised)
            .flex()
            .items_center()
            .justify_center()
            .when(r.icon !== null, (el) =>
              el.child(
                svg(/** @type {string} */ (r.icon))
                  .size(13)
                  .text_color(r.enabled ? t.muted : t.dim),
              ),
            ),
        )
        .child(div().flex_1().truncate().child(r.label))
        .when(Boolean(r.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(r.hint)));

    return root
      .child(
        div()
          .px(9)
          .pt(4)
          .pb(4)
          .text_size(11)
          .font_medium()
          .text_color(t.muted)
          .truncate()
          .child(project.name || project.commonDir),
      )
      .children(rows.slice(0, 3).map(row))
      .child(div().h(1).mx(4).my(5).flex_none().bg(t.border))
      .child(row(rows[3]));
  }
}
