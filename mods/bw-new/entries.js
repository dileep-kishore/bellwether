// The "+" menu's rows and what each runs. Pure, so tests run it.
import { chatArgv } from "./chat-tabs.js";
import { placeOf } from "./projects-model.js";

/**
 * @typedef {{ key: string, name: string, icon: string | null, tint: boolean, run: string[], installed: boolean }} KnownAgent
 * @typedef {{ space: string | null, machine: string | null, folder: string | null, closed?: true }} MenuContext
 * @typedef {{ kind: import("./chat-tabs.js").ChatKind, name: string, argv: string[] }} ChatStart
 * @typedef {["run", string, Record<string, unknown>] | ["overlay", Record<string, unknown>] | ["chat", ChatStart]} RowAction
 * @typedef {{ id: string, section: "New chat" | "New terminal" | "Worktree", label: string, enabled: boolean, hint: string, agent: KnownAgent | null, kind: import("./chat-tabs.js").ChatKind | null, action: RowAction }} Row
 * @typedef {{ ok: true, lines: Record<string, unknown>[] } | { ok: false, state: string, message: string }} ArgsResult
 */

/** @type {{ id: import("./chat-tabs.js").ChatKind, label: string }[]} */
const AGENTS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];
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
 * The folder an agent started in `ctx` runs in: the space's focused terminal's, else where the
 * space is now. "+" names it to both agent-args and `tab.new`, whose own default could differ.
 * @param {MenuContext} ctx
 * @param {any[]} spaces SpaceInfo[]
 * @param {any[]} panes PaneInfo[]
 * @returns {string | null}
 */
export function launchFolder(ctx, spaces, panes) {
  if (!ctx.space) return ctx.folder;
  const tabs = new Set((spaces.find((s) => s.id === ctx.space)?.tabs ?? []).map((/** @type {any} */ t) => t.id));
  const pane = panes.find((p) => p.focused && p.terminal && p.cwd && tabs.has(p.tab));
  return pane?.cwd ?? ctx.folder;
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
  const rows = known.map(
    (a) =>
      /** @type {Row} */ ({
        id: `chat-${a.id}`,
        section: "New chat",
        label: a.label,
        enabled: a.ok,
        hint: a.hint,
        agent: a.agent,
        kind: a.id,
        action: ["chat", { kind: a.id, name: a.start.name, argv: chatArgv(a.id, a.start.run) }],
      }),
  );
  rows.push({
    id: "shell",
    section: "New terminal",
    label: "Shell",
    enabled: true,
    hint: "",
    agent: null,
    kind: null,
    action: start(null),
  });
  for (const a of known) {
    rows.push({
      id: a.id,
      section: "New terminal",
      label: a.label,
      enabled: a.ok,
      hint: a.hint,
      agent: a.agent,
      kind: a.id,
      action: start(a.start),
    });
  }
  for (const d of DIALOGS) {
    const props = space ? { space, folder, action: d.action } : { folder, machine, action: d.action };
    rows.push({
      id: d.id,
      section: "Worktree",
      label: d.label,
      enabled: Boolean(folder),
      hint: "",
      agent: null,
      kind: null,
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
  if (space) return { pending, command: ["tab.new", { space, ...(folder ? { folder } : {}), name, argv }] };
  return {
    pending,
    command: ["space.new", { ...(folder ? { folder } : {}), machine: machine ?? "", tab: name, argv }],
  };
}

/**
 * The command a "New terminal" agent row runs once its argv is complete, in `ctx.folder`.
 * @param {["run", string, Record<string, unknown>]} action the row's action
 * @param {MenuContext} ctx
 * @param {string[]} argv
 * @returns {[string, Record<string, unknown>]}
 */
export function terminalLaunch(action, ctx, argv) {
  const folder = action[1] === "tab.new" && ctx.folder ? { folder: ctx.folder } : {};
  return [action[1], { ...action[2], ...folder, argv }];
}

/**
 * The Codex profile an agent's run argv selects; with several, the last.
 * @param {string[]} run
 * @returns {string | null}
 */
function codexProfile(run) {
  let profile = null;
  for (let i = 1; i < run.length; i++) {
    const a = run[i];
    if ((a === "--profile" || a === "-p") && i + 1 < run.length) profile = run[++i];
    else if (a.startsWith("--profile=")) profile = a.slice("--profile=".length);
  }
  return profile || null;
}

/**
 * The arguments of the window machine's `bw browser agent-args` for an agent started in `ctx`.
 * Claude's `-p` means print, so only a Codex run is read for a profile.
 * @param {import("./chat-tabs.js").ChatKind} kind
 * @param {MenuContext} ctx
 * @param {string[]} run the agent's run argv
 * @returns {string[]}
 */
export function argsRequest(kind, ctx, run) {
  const profile = kind === "codex" ? codexProfile(run) : null;
  return [
    "browser",
    "agent-args",
    "--kind",
    kind,
    "--machine",
    ctx.machine ?? "",
    // Without a folder Herdr starts the agent in its default folder, which this side does not know.
    ...(ctx.folder ? ["--cwd", ctx.folder] : []),
    ...(profile ? ["--profile", profile] : []),
  ];
}

/**
 * The argv an agent gets after its run, from `helper.call`'s result: anything but a ready
 * agent-args line with a string argv starts it plain, with the reason as the notice.
 * @param {ArgsResult} result
 * @returns {{ extras: string[], notice: string | null }}
 */
export function extrasFrom(result) {
  const plain = (/** @type {string} */ notice) => ({ extras: /** @type {string[]} */ ([]), notice });
  if (result.ok === false) return plain(result.message || `the browser helper failed (${result.state})`);
  const line = result.lines.find((l) => l.type === "agent-args");
  if (!line) return plain("bw browser agent-args printed no agent-args line");
  if (line.browser !== "ready")
    return plain(typeof line.reason === "string" && line.reason ? line.reason : "the browser is unavailable");
  const argv = line.argv;
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string"))
    return plain("bw browser agent-args printed no argv");
  return { extras: [...argv], notice: null };
}
