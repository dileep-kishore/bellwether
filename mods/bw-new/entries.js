// The "+" menu's rows and what each runs. Pure, so tests run it.
import { placeOf } from "./projects-model.js";

/**
 * @typedef {{ key: string, name: string, icon: string | null, tint: boolean, run: string[], installed: boolean }} KnownAgent
 * @typedef {{ space: string | null, machine: string | null, folder: string | null, closed?: true }} MenuContext
 * @typedef {["run", string, Record<string, unknown>] | ["overlay", Record<string, unknown>]} RowAction
 * @typedef {{ id: string, section: "New terminal" | "Worktree", label: string, enabled: boolean, hint: string, agent: KnownAgent | null, action: RowAction }} Row
 */

const AGENTS = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }];
const DIALOGS = [
  { id: "worktree-new", label: "New worktree…", action: "new", width: 460, height: 280 },
  { id: "worktree-open", label: "Open worktree…", action: "open", width: 560, height: 480 },
];

/**
 * Where the menu acts: `{space}` from bw-tabs, or `{machine, folder}` for a project without a space.
 * A `{space}` that no longer exists is `closed`: acting on this Mac instead would start work elsewhere.
 * @param {any} props
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @returns {MenuContext}
 */
export function contextOf(props, spaces, panes) {
  if (typeof props?.space === "string") {
    const space = spaces.find((s) => s.id === props.space);
    if (!space) return { space: null, machine: null, folder: null, closed: true };
    return { space: space.id, machine: space.machine ?? null, folder: placeOf(space, panes) || null };
  }
  return { space: null, machine: props?.machine ?? null, folder: props?.folder ?? null };
}

/**
 * @param {{ agents: KnownAgent[] | null, failed: boolean, ctx: MenuContext }} input
 * @returns {Row[]}
 */
export function menuEntries({ agents, failed, ctx }) {
  const { space, machine, folder } = ctx;
  // space.new without `machine` means the focused space's machine, so this Mac is named as "".
  const where = { ...(folder ? { folder } : {}), machine: machine ?? "" };

  /** @param {{ name: string, run: string[] } | null} agent @returns {["run", string, Record<string, unknown>]} */
  const start = (agent) => {
    if (space) return ["run", "tab.new", agent ? { space, name: agent.name, argv: agent.run } : { space }];
    return ["run", "space.new", agent ? { ...where, tab: agent.name, argv: agent.run } : where];
  };

  /** @type {Row[]} */
  const rows = [{ id: "shell", section: "New terminal", label: "Shell", enabled: true, hint: "", agent: null, action: start(null) }];
  for (const { id, label } of AGENTS) {
    const agent = agents?.find((a) => a.key === id) ?? null;
    const ok = Boolean(agent?.installed);
    const hint = ok ? "" : agents !== null ? "not installed" : failed ? "could not check" : "checking…";
    rows.push({ id, section: "New terminal", label, enabled: ok, hint, agent, action: start(agent ?? { name: label, run: [id] }) });
  }
  for (const d of DIALOGS) {
    const props = space ? { space, folder, action: d.action } : { folder, machine, action: d.action };
    rows.push({
      id: d.id, section: "Worktree", label: d.label, enabled: Boolean(folder), hint: "", agent: null,
      action: ["overlay", { mod: "worktree", kind: "dialog", width: d.width, height: d.height, props }],
    });
  }
  if (ctx.closed) return rows.map((r) => ({ ...r, enabled: false, hint: "the space closed" }));
  return rows;
}
