// The Add project dialog, opened by bw-projects' header: a machine, a folder on it, then
// rev-parse there to find the repository it belongs to.
import { View, div, svg } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, home, machines, pickFolder, props, setShared, shared, theme, window } from "herdr";
import { readPlace } from "./git.js";
import { projectKey, readStored, rememberProjects } from "./projects-model.js";
import { ICONS } from "./ui.js";

const KEY = "bw.projects";

const parentOf = (/** @type {string} */ p) => p.slice(0, p.lastIndexOf("/")) || "/";
const baseName = (/** @type {string} */ p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * The main checkout of the repository a place belongs to, or null when Git keeps it apart
 * (a bare repository, a separate git dir).
 *
 * @param {{ commonDir: string, top: string }} place
 * @returns {string | null}
 */
export function mainOf({ commonDir, top }) {
  if (commonDir === `${top}/.git`) return top;
  return commonDir.endsWith("/.git") ? parentOf(commonDir) : null;
}

export default class Add extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    /** @type {string | null} null is this Mac */
    this.machine = null;
    // Why the chosen machine cannot take a path now ("macmini is offline"), or "" when it is ready.
    this.waiting = "";
    this.error = "";
    this.busy = false;
    this.input = InputState.new({ placeholder: "/path/to/repository" });
    this.input.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      this.error = "";
      cx.notify();
    });
    this.input.on("submit", (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.add(cx));
    this.input.focus();
    // As Herdr's worktree dialog does: focus taken while the overlay opens can be lost.
    cx.timer.after(600, () => this.input.focus());
  }

  // Not close(): Herdr calls a View's close(cx) when the overlay goes.
  dismiss() {
    const id = props()?.overlay;
    if (typeof id === "string") closeOverlay(id);
  }

  /** @param {any} cx @param {string} [picked] a folder from the picker, used instead of the typed path */
  add(cx, picked) {
    if (this.busy || this.waiting) return;
    const machine = this.machine;
    let path = (picked ?? this.input.value()).trim();
    if (!path) return;
    // Only this Mac's home is known here; another machine gets the path as typed and Git says why not.
    if (machine === null && (path === "~" || path.startsWith("~/"))) path = home() + path.slice(1);
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await readPlace(exec, machine, path);
        if (!r.ok) {
          this.error =
            r.state === "not_git"
              ? "Not a Git repository"
              : r.state === "unreachable"
                ? `${machine ?? "This machine"} is not reachable`
                : `Could not read ${path}: ${r.message}`;
          return;
        }
        const main = mainOf(r.place);
        const project = {
          machine,
          commonDir: r.place.commonDir,
          name: main ? baseName(main) : baseName(r.place.commonDir).replace(/\.git$/, ""),
          main,
        };
        const stored = shared(KEY);
        const key = projectKey(machine, project.commonDir);
        if (!readStored(stored).some((p) => projectKey(p.machine, p.commonDir) === key))
          setShared(KEY, rememberProjects(stored, [project]));
        this.dismiss();
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  /** @param {any} cx */
  choose(cx) {
    cx.spawn(async (/** @type {any} */ cx) => {
      const folder = await pickFolder({ prompt: "Add project" });
      if (!folder) return;
      this.input.set_value(folder);
      this.add(cx, folder);
    });
  }

  render() {
    const t = theme();
    const local = window()?.platform === "macos" ? "This Mac" : "This computer";
    const all = machines();
    // A chosen machine that drops stays chosen: its typed path is never read on another machine.
    const shown = all
      .filter((m) => m.name !== null && (m.layout === "ready" || m.name === this.machine))
      .map((m) => /** @type {string} */ (m.name));
    if (this.machine !== null && !shown.includes(this.machine)) shown.push(this.machine);
    const layout =
      this.machine === null ? "ready" : (all.find((m) => m.name === this.machine)?.layout ?? "unavailable");
    this.waiting =
      layout === "ready" ? "" : layout === "loading" ? `${this.machine} is connecting…` : `${this.machine} is offline`;
    const choices = [
      { name: null, id: "local", label: local, icon: ICONS.monitor },
      ...shown.map((n) => ({ name: n, id: n, label: n, icon: ICONS.server })),
    ];
    const blocked = this.busy || this.waiting !== "";

    const button = (
      /** @type {string} */ id,
      /** @type {string} */ label,
      /** @type {boolean} */ primary,
      /** @type {(cx: any) => void} */ act,
    ) =>
      div()
        .id(id)
        .h(30)
        .px(12)
        .flex()
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .cursor_pointer()
        .when(primary, (el) => el.bg(blocked ? t.raised : t.solid).text_color(blocked ? t.dim : t.solid_foreground))
        .when(!primary, (el) =>
          el
            .border(1)
            .border_color(t.border)
            .text_color(t.foreground)
            .hover((s) => s.bg(t.hover)),
        )
        .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => act(cx))
        .child(label);

    return v_flex()
      .id("bw-add")
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(div().font_semibold().child("Add project"))
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .children(
            choices.map((c) => {
              const on = c.name === this.machine;
              return h_flex()
                .id(`add-machine-${c.id}`)
                .h(26)
                .px(9)
                .gap(6)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(12)
                .border(1)
                .border_color(on ? t.accent : t.border)
                .text_color(on ? t.foreground : t.muted)
                .when(on, (el) => el.bg(t.selected))
                .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
                .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
                  if (this.machine === c.name) return;
                  if (this.waiting) this.input.set_value("");
                  this.machine = c.name;
                  this.error = "";
                  cx.notify();
                })
                .child(svg(c.icon).size(12).flex_none())
                .child(c.label);
            }),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            Input.new(this.input)
              .flex_1()
              .h(32)
              .px(10)
              .items_center()
              .rounded(6)
              .border(1)
              .border_color(t.input)
              .bg(t.background)
              .text_color(t.foreground),
          )
          .when(this.machine === null, (el) =>
            el.child(
              button("add-choose", "Choose…", false, (cx) => {
                if (!this.busy) this.choose(cx);
              }),
            ),
          ),
      )
      .child(
        div()
          .text_size(11.5)
          .text_color(this.error || this.waiting ? t.blocked : t.dim)
          .child(
            this.error ||
              this.waiting ||
              (this.machine === null
                ? "A folder in a Git repository on this Mac."
                : `An absolute path on ${this.machine}.`),
          ),
      )
      .child(h_flex().flex_1())
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .child(button("add-cancel", "Cancel", false, () => this.dismiss()))
          .child(button("add-go", this.busy ? "Adding…" : "Add", true, (cx) => this.add(cx))),
      );
  }
}
