// The "+" menu's rows and what each runs. Pure, so tests run it.
import { chatArgv } from "./chat-tabs.js";
import { placeOf } from "./projects-model.js";

/**
 * @typedef {{ key: string, name: string, icon: string | null, tint: boolean, run: string[], installed: boolean }} KnownAgent
 * @typedef {{ space: string | null, machine: string | null, folder: string | null, closed?: true }} MenuContext
 * @typedef {{ kind: import("./chat-tabs.js").ChatKind, name: string, argv: string[] }} ChatStart
 * @typedef {["run", string, Record<string, unknown>] | ["overlay", Record<string, unknown>] | ["chat", ChatStart]} RowAction
 * @typedef {{ id: string, section: "New chat" | "New terminal" | "Worktree", label: string, enabled: boolean, hint: string, agent: KnownAgent | null, action: RowAction }} Row
 */

/** @type {{ id: import("./chat-tabs.js").ChatKind, label: string }[]} */
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

  const known = AGENTS.map(({ id, label }) => {
    const agent = agents?.find((a) => a.key === id) ?? null;
    const ok = Boolean(agent?.installed);
    const hint = ok ? "" : agents !== null ? "not installed" : failed ? "could not check" : "checking…";
    return { id, label, agent, ok, hint, start: agent ?? { name: label, run: [id] } };
  });

  /** @type {Row[]} */
  const rows = known.map((a) => /** @type {Row} */ ({
    id: `chat-${a.id}`, section: "New chat", label: a.label, enabled: a.ok, hint: a.hint, agent: a.agent,
    action: ["chat", { kind: a.id, name: a.start.name, argv: chatArgv(a.id, a.start.run) }],
  }));
  rows.push({ id: "shell", section: "New terminal", label: "Shell", enabled: true, hint: "", agent: null, action: start(null) });
  for (const a of known) {
    rows.push({ id: a.id, section: "New terminal", label: a.label, enabled: a.ok, hint: a.hint, agent: a.agent, action: start(a.start) });
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

/**
 * What a "New chat" click records and runs. `tab.new` returns no ids (herdr.d.ts `run`), so the
 * pending chat names the tabs and spaces there were before, and bw-tabs adopts the one that appears.
 * @param {ChatStart} chat
 * @param {MenuContext} ctx
 * @param {any[]} spaces SpaceInfo[]
 * @returns {{ pending: Omit<import("./chat-tabs.js").Pending, "id" | "at">, command: [string, Record<string, unknown>] }}
 */
export function chatLaunch({ kind, name, argv }, ctx, spaces) {
  const { space, machine, folder } = ctx;
  const beforeTabs = space ? (spaces.find((s) => s.id === space)?.tabs ?? []).map((/** @type {any} */ t) => t.id) : [];
  const pending = { kind, machine, space, folder, beforeTabs, beforeSpaces: spaces.map((s) => s.id), name };
  if (space) return { pending, command: ["tab.new", { space, name, argv }] };
  return { pending, command: ["space.new", { ...(folder ? { folder } : {}), machine: machine ?? "", tab: name, argv }] };
}
