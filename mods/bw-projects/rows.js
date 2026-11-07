// Draws the project sidebar's rows. Handlers act only on the nodes they were drawn from.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { ICONS, ago, programIcon, statusIcon } from "./ui.js";

/** @typedef {import("./projects-model.js").MachineNode} MachineNode */
/** @typedef {import("./projects-model.js").ProjectNode} ProjectNode */
/** @typedef {import("./projects-model.js").WorktreeNode} WorktreeNode */
/** @typedef {import("./projects-model.js").PlainSpace} PlainSpace */
/** @typedef {import("./projects-model.js").AgentLine} AgentLine */
/** @typedef {import("./run-git.js").HelperState} HelperState */

/**
 * @typedef {object} Draw
 * @property {Record<string, string>} t theme()
 * @property {number} now
 * @property {string | null} active the active space's id
 * @property {string | null} hovered the project header under the pointer
 * @property {Map<string | null, HelperState>} helpers
 * @property {(key: string) => boolean} isFolded
 * @property {(key: string, cx: any) => void} toggle
 * @property {(key: string | null, hovered: boolean, cx: any) => void} hover
 * @property {(w: WorktreeNode, p: ProjectNode) => void} openWorktree
 * @property {(a: AgentLine) => void} focusAgent
 * @property {(id: string) => void} selectSpace
 * @property {(p: ProjectNode) => void} projectMenu
 * @property {(p: ProjectNode) => void} newInMain
 * @property {() => void} addProject
 * @property {() => void} drewTime called when a row shows an age that the minute timer must refresh
 */

const TILE_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

/** @param {string | null} name */
export const machineFold = (name) => `m${JSON.stringify(name)}`;
/** @param {string} key */
export const projectFold = (key) => `p${key}`;
/** @param {string} key */
export const worktreeFold = (key) => `w${key}`;

/** A stable colour per project, so a tile keeps its colour as projects come and go. @param {string} key */
function tileColor(t, key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return t[TILE_COLORS[h % TILE_COLORS.length]];
}

/** @param {Record<string, string>} t @param {ProjectNode} p @param {number} size */
export function letterTile(t, p, size) {
  return div().size(size).flex_none().rounded(4).bg(tileColor(t, p.key)).text_color(t.background)
    .text_size(Math.round(size * 0.6)).font_semibold().flex().items_center().justify_center().child(p.letter);
}

/** @param {Record<string, string>} t @param {boolean} open */
const chevron = (t, open) => svg(open ? ICONS["chevron-down"] : ICONS["chevron-right"]).size(10).flex_none().text_color(t.dim);

/**
 * What a machine's heading says after its name, or "" when all is well.
 * @param {MachineNode} m @param {HelperState | undefined} helper
 */
export function machineWords(m, helper) {
  if (m.state === "offline") return "offline";
  if (m.state === "loading") return "connecting…";
  if (m.state === "not_connected") return "not connected";
  if (m.name !== null && helper?.state === "installing") return "setting up Bellwether";
  if (m.name !== null && helper?.state === "failed") return `Bellwether helper: ${helper.message}`;
  return "";
}

/** @param {Draw} d @param {MachineNode} m */
function machineHeading(d, m) {
  const { t } = d;
  const key = machineFold(m.name);
  const helper = d.helpers.get(m.name);
  const words = machineWords(m, helper);
  const failed = m.state === "ready" && helper?.state === "failed";
  return h_flex().id(`machine-${m.name ?? "local"}`).h(24).flex_none().px(12).gap(6).items_center().cursor_pointer().overflow_hidden()
    .on_click((_e, cx) => d.toggle(key, cx))
    .child(chevron(t, !d.isFolded(key)))
    .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child(m.label.toUpperCase()))
    .when(words !== "", (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(failed ? t.blocked : t.dim).child(words)));
}

/** @param {Draw} d @param {ProjectNode} p @param {MachineNode} m */
function projectHeader(d, p, m) {
  const { t } = d;
  const fold = projectFold(p.key);
  const folded = d.isFolded(fold);
  const hovered = d.hovered === p.key;
  const button = (/** @type {string} */ id, /** @type {string} */ icon, /** @type {() => void} */ act) =>
    div().id(id).size(20).flex_none().rounded(4).flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.selected))
      .on_click(() => act())
      .child(svg(icon).size(12).text_color(t.muted));
  return h_flex().id(`project-${p.key}`).h(30).flex_none().pl(8).pr(6).gap(4).items_center().rounded(6).hover((s) => s.bg(t.hover))
    .on_hover((h, cx) => d.hover(p.key, h, cx))
    .on_mouse_down("right", () => d.projectMenu(p))
    .child(
      h_flex().id(`fold-${p.key}`).flex_1().min_w(0).h_full().gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => d.toggle(fold, cx))
        .child(chevron(t, !folded))
        .child(letterTile(t, p, 18))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(p.name))
        .when(folded, (el) => el.child(statusIcon(t, p.status))),
    )
    // Without a main checkout "+" would start in the machine's home; the menu beside it names why.
    .when(hovered && m.state !== "not_connected", (el) =>
      el.when(p.main !== null, (el) => el.child(button(`project-new-${p.key}`, ICONS.plus, () => d.newInMain(p))))
        .child(button(`project-more-${p.key}`, ICONS.more, () => d.projectMenu(p))),
    );
}

/** The right side of a worktree row: `missing`, or ahead/behind and line counts. @param {Draw} d @param {WorktreeNode} w */
function worktreeCounts(d, w) {
  const { t } = d;
  const out = h_flex().flex_none().gap(6).items_center().text_size(11);
  if (w.prunable) return out.child(div().text_color(t.dim).child("missing"));
  const c = w.counts;
  if (!c) return out;
  const dim = w.stale;
  if (c.ahead > 0) out.child(div().text_color(dim ? t.dim : t.ansi2).child(`↑${c.ahead}`));
  if (c.behind > 0) out.child(div().text_color(dim ? t.dim : t.ansi1).child(`↓${c.behind}`));
  if (c.added > 0 || c.removed > 0) {
    out.child(
      h_flex().gap(3)
        .child(div().text_color(dim ? t.dim : t.ansi2).child(`+${c.added}`))
        .child(div().text_color(dim ? t.dim : t.ansi1).child(`−${c.removed}`)),
    );
  }
  return out;
}

/** @param {WorktreeNode} w */
function branchLabel(w) {
  if (w.branch) return w.branch;
  if (w.detached) return "detached";
  return w.path.replace(/\/+$/, "").split("/").pop() || w.path;
}

/** @param {Draw} d @param {WorktreeNode} w @param {ProjectNode} p */
function worktreeRow(d, w, p) {
  const { t } = d;
  const fold = worktreeFold(w.key);
  const folded = d.isFolded(fold);
  const selected = d.active !== null && w.spaces.includes(d.active);
  const lead = w.agents.length
    ? div().id(`fold-${w.key}`).size(16).flex_none().flex().items_center().justify_center().cursor_pointer()
      .on_click((_e, cx) => d.toggle(fold, cx))
      .child(chevron(t, !folded))
    : div().size(16).flex_none();
  return h_flex().h(28).flex_none().pl(14).pr(6).gap(2).items_center()
    .child(lead)
    .child(
      h_flex().id(`worktree-${w.key}`).flex_1().min_w(0).h_full().px(4).gap(6).items_center().rounded(6)
        .when(!w.open, (el) => el.opacity(0.55))
        .when(selected, (el) => el.bg(t.selected))
        .when(!selected && !w.prunable, (el) => el.hover((s) => s.bg(t.hover)))
        .when(!w.prunable, (el) => el.cursor_pointer())
        .on_click(() => d.openWorktree(w, p))
        .child(svg(ICONS.branch).size(12).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(w.open ? t.foreground : t.muted).child(branchLabel(w)))
        .when(folded && w.status !== null, (el) => el.child(statusIcon(t, w.status)))
        .child(worktreeCounts(d, w)),
    );
}

/** @param {Draw} d @param {AgentLine} a @param {number} indent */
function agentLine(d, a, indent) {
  const { t } = d;
  const row = h_flex().id(`agent-${a.address}`).h(24).flex_none().pl(indent).pr(10).gap(6).items_center().text_size(11).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => d.focusAgent(a))
    .child(statusIcon(t, a.status, 12))
    .child(programIcon(a.program, t, 12))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.title || "agent"));
  if (a.subagents > 0) row.child(div().flex_none().text_color(t.dim).child(`+${a.subagents}`));
  if (a.requests > 0) {
    row.child(div().flex_none().px(5).rounded(8).bg(t.blocked).text_color(t.background).text_size(10).font_semibold().child(String(a.requests)));
  }
  if (a.changedAt !== null) {
    d.drewTime();
    row.child(div().flex_none().text_color(t.dim).child(ago(a.changedAt, d.now)));
  }
  return row;
}

/** @param {Draw} d @param {PlainSpace} s */
function plainSpace(d, s) {
  const { t } = d;
  return v_flex().flex_none()
    .child(
      h_flex().id(`space-${s.id}`).h(28).flex_none().ml(30).mr(6).px(4).gap(6).items_center().rounded(6).cursor_pointer()
        .when(s.active, (el) => el.bg(t.selected))
        .when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click(() => d.selectSpace(s.id))
        .child(svg(ICONS.terminal).size(12).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(s.name))
        .when(s.agents.length === 0 && s.status !== null, (el) => el.child(statusIcon(t, s.status))),
    )
    .children(s.agents.map((a) => agentLine(d, a, 40)));
}

/** @param {Draw} d @param {MachineNode} m */
export function machineSection(d, m) {
  const { t } = d;
  const out = v_flex().flex_none().pb(6).child(machineHeading(d, m));
  if (d.isFolded(machineFold(m.name))) return out;
  for (const p of m.projects) {
    out.child(h_flex().px(4).flex_none().child(projectHeader(d, p, m).flex_1()));
    if (d.isFolded(projectFold(p.key))) continue;
    if (!p.checked && p.worktrees.length === 0) {
      out.child(div().h(24).flex_none().pl(36).text_size(11).text_color(t.dim).flex().items_center().child(m.state === "ready" ? "reading worktrees…" : "not read yet"));
    }
    for (const w of p.worktrees) {
      out.child(worktreeRow(d, w, p));
      if (!d.isFolded(worktreeFold(w.key))) out.children(w.agents.map((a) => agentLine(d, a, 44)));
    }
  }
  if (m.plain.length) {
    out.child(div().h(24).flex_none().pl(16).text_size(11).text_color(t.dim).flex().items_center().child("Other spaces"));
    out.children(m.plain.map((s) => plainSpace(d, s)));
  }
  return out;
}

/** One letter tile per project with its most urgent status, for a sidebar too narrow for names.
 * @param {Draw} d @param {MachineNode[]} machines @param {(p: ProjectNode) => void} openFirst */
export function rail(d, machines, openFirst) {
  const { t } = d;
  return v_flex().id("projects-rail").flex_1().min_h(0).overflow_y_scrollbar().items_center().gap(6).py(6).children(
    machines.flatMap((m) =>
      m.projects.map((p) =>
        v_flex().id(`rail-${p.key}`).flex_none().items_center().gap(2).cursor_pointer()
          .opacity(p.open ? 1 : 0.55)
          .on_click(() => openFirst(p))
          .child(letterTile(t, p, 28))
          .child(statusIcon(t, p.status, 10)),
      ),
    ),
  );
}
