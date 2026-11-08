// A pane's header in the Bellwether layout: the program, its title and folder, the agent's status,
// and buttons that split, zoom and close this pane. Herdr gives it props { pane, terminal }.
// Written for Bellwether; the buttons stay mounted and fade in while the pointer is on the header.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { home, panes, props, run } from "herdr";
import { MOTION, pill, programIcon, statusMark, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

const ICON = (/** @type {string} */ name) => `mods/bw-pane/icons/${name}.svg`;

/** A folder with this machine's home spelt `~`. @param {string | null | undefined} cwd @param {string} h */
export function shortFolder(cwd, h) {
  if (!cwd) return "";
  if (cwd === h) return "~";
  return h && cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
}

/**
 * What the header calls the pane: an agent's or shell's program name, else the terminal's title.
 * @param {any} p PaneInfo
 */
export function paneName(p) {
  // A mod pane's title is its folder name; "bw-chat" reads as "Chat".
  if (p.mod && p.title === p.mod)
    return p.mod.replace(/^bw-/, "").replace(/^./, (/** @type {string} */ c) => c.toUpperCase());
  if ((p.program?.agent || p.program?.shell) && p.program?.name) return String(p.program.name);
  return String(p.title || p.program?.name || "shell");
}

/**
 * The header's buttons and the command each runs on this pane.
 * @param {string} pane @param {boolean} zoomed
 * @returns {{ id: string, icon: string, label: string, command: string, args: Record<string, unknown> }[]}
 */
export function paneActions(pane, zoomed) {
  return [
    {
      id: "split-right",
      icon: "split-right",
      label: "Split right",
      command: "pane.split",
      args: { direction: "right", pane },
    },
    {
      id: "split-down",
      icon: "split-down",
      label: "Split down",
      command: "pane.split",
      args: { direction: "down", pane },
    },
    {
      id: "zoom",
      icon: zoomed ? "unzoom" : "zoom",
      label: zoomed ? "Unzoom" : "Zoom",
      command: "pane.zoom",
      args: { pane },
    },
    { id: "close", icon: "close", label: "Close", command: "pane.close", args: { pane } },
  ];
}

export default class PaneHeader extends View {
  init() {
    /** The pointer is on the header: its buttons show. @type {boolean} */
    this.hovered = false;
  }

  render() {
    const t = themeColors();
    const id = props()?.pane;
    const p = panes().find((x) => x.pane === id);
    if (!p) return div().id("bw-pane").size_full().bg(t.background);
    const pane = p.pane;
    const folder = shortFolder(p.cwd, home());
    return (
      h_flex()
        .id("bw-pane")
        .size_full()
        .pl(12)
        .pr(6)
        .gap(8)
        .items_center()
        .bg(t.background)
        .border_b(1)
        .border_color(t.border)
        .text_size(12)
        .on_hover((/** @type {boolean} */ hovered, /** @type {any} */ cx) => {
          if (hovered === this.hovered) return;
          this.hovered = hovered;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane }))
        // A mod pane has no status at all (undefined), a plain terminal null.
        .when(p.status != null, (el) => el.child(statusMark(t, p.status, 12, `mark-${pane}`)))
        .child(programIcon(p.program, t, 14))
        .child(
          div()
            .flex_none()
            .max_w(260)
            .truncate()
            .font_medium()
            .text_color(p.focused ? t.foreground : t.muted)
            .child(paneName(p)),
        )
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(folder))
        .when(p.status === "blocked", (el) =>
          el.child(pill(t, "Needs you", "request", `needs-${pane}`).loop("opacity", MOTION.breathe)),
        )
        .child(
          h_flex()
            .id(`actions-${pane}`)
            .flex_none()
            .gap(2)
            .items_center()
            .opacity(this.hovered ? 1 : 0)
            .transition("opacity", MOTION.hover)
            .children(paneActions(pane, p.zoomed).map((a) => this.action(t, pane, a))),
        )
    );
  }

  /** @param {Theme} t @param {string} pane @param {ReturnType<typeof paneActions>[number]} a */
  action(t, pane, a) {
    return div()
      .id(`${a.id}-${pane}`)
      .size(22)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(11)
      .cursor_pointer()
      .text_color(t.muted)
      .accessibility_label(a.label)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
        cx.stop_propagation();
        run(a.command, a.args);
      })
      .child(svg(ICON(a.icon)).size(14));
  }
}
