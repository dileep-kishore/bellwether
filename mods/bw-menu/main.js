// A project's menu, opened by bw-projects (its "⋯" or a right-click) with the project in props.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, openOverlay, props, setShared, shared, theme } from "herdr";
import { forgetProject, projectKey } from "./projects-model.js";
import { ICONS } from "./ui.js";

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
  render() {
    const t = theme();
    const p = /** @type {{ project?: MenuProject, overlay?: string }} */ (props() ?? {});
    const project = p.project && typeof p.project.commonDir === "string" ? p.project : null;
    const close = () => {
      if (typeof p.overlay === "string") closeOverlay(p.overlay);
    };
    const root = v_flex().id("bw-menu").size_full().p(5).bg(t.popover).text_size(12.8).text_color(t.foreground);
    if (!project) return root.child(div().px(9).py(6).text_color(t.dim).child("No project"));

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
        icon: null,
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
        .h(30)
        .px(9)
        .gap(10)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_color(r.enabled ? t.foreground : t.dim)
        .when(r.enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
        .on_click(() => {
          if (!r.enabled) return;
          close();
          r.act();
        })
        .child(
          r.icon
            ? svg(r.icon)
                .size(14)
                .flex_none()
                .text_color(r.enabled ? t.muted : t.dim)
            : div().size(14).flex_none(),
        )
        .child(div().flex_1().truncate().child(r.label))
        .when(Boolean(r.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(r.hint)));

    return root
      .child(
        div()
          .px(9)
          .pt(4)
          .pb(4)
          .text_size(11)
          .text_color(t.dim)
          .truncate()
          .child(project.name || project.commonDir),
      )
      .children(rows.slice(0, 3).map(row))
      .child(div().h(1).mx(4).my(5).flex_none().bg(t.border))
      .child(row(rows[3]));
  }
}
