// The left sidebar: machines, their projects with every worktree, and each worktree's agents.
// render reads Herdr's live data and hands refresh targets to the schedule; one loop task runs the
// short read-only Git calls on each space's machine and never reads live data.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  agents,
  exec,
  home,
  machines,
  openOverlay,
  panes,
  run,
  setAgentOrder,
  setShared,
  shared,
  spaces,
  terminals,
  theme,
  watchFolder,
  window,
} from "herdr";
import { addProject, focusAgent, newInMain, openWorktree, projectMenu } from "./actions.js";
import { createHelper, parseLines } from "./helper.js";
import {
  buildProjects,
  countTargets,
  projectKey,
  readStored,
  refreshTargets,
  rememberProjects,
} from "./projects-model.js";
import { createPoke, runRefresher } from "./refresh-driver.js";
import { createSchedule } from "./refresh-schedule.js";
import { machineSection, rail } from "./rows.js";
import { makeRun, mergeResult } from "./run-git.js";
import { ICONS } from "./ui.js";

const STORE = "bw.projects";
const FOLDED = "bw-projects.folded";
const RAIL_BELOW = 160;
/** `bw counts` per machine, start to start. */
const COUNTS_MS = 10000;
/** `bw counts` takes at most this many terminals per call. */
const COUNTS_PER_CALL = 64;

/**
 * @typedef {object} CountLoop One machine's `bw counts` loop; render changes `terminals` and pokes it.
 * @property {{ address: string, local: string }[]} terminals
 * @property {import("./refresh-driver.js").Poke} poke
 * @property {boolean} live false once render no longer wants it; the loop then ends
 * @property {boolean} started
 */

/** @returns {Set<string>} */
function loadFolded() {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export default class Projects extends View {
  init(_props, cx) {
    this.alive = true;
    /** @type {import("./projects-model.js").GitCache} */
    this.git = { places: {}, worktrees: {}, counts: {}, unreachable: [] };
    /** @type {Map<string | null, import("./run-git.js").HelperState>} */
    this.helpers = new Map();
    this.schedule = createSchedule();
    this.poke = createPoke();
    this.folded = loadFolded();
    /** @type {number | null} */
    this.width = null;
    /** @type {string | null} */
    this.hovered = null;
    this.showsTime = false;
    /** @type {string | null} */
    this.order = null;
    // Projects handed to setShared that the store does not show yet, so a render before it catches up
    // does not ask twice. A key leaves once stored, so a project removed later can be remembered again.
    /** @type {Set<string>} */
    this.remembered = new Set();
    /** @type {Record<string, import("./projects-model.js").AgentCount>} */
    this.counts = {};
    /** @type {Map<string | null, CountLoop>} */
    this.countLoops = new Map();
    /** Each agent's status as render last saw it. @type {Map<string, string>} */
    this.statuses = new Map();
    // Render has no cx, so a task started here spawns each machine's loop when render asks for one.
    this.countStarter = createPoke();

    const bw = `${home()}/.local/share/bellwether/helper/current/bw`;
    // The loop task's own cx, so an install can redraw its heading before it finishes.
    /** @type {any} */
    let loopCx = null;
    const helper = createHelper({
      exec,
      localInstall: async (machine) => {
        this.helpers.set(machine, { state: "installing" });
        loopCx?.notify();
        let r;
        try {
          r = await exec(bw, ["machine", "install", machine], { on: null });
        } catch (e) {
          throw new Error(
            `could not start bw on this Mac (${e instanceof Error ? e.message : String(e)}): run scripts/install-helper.sh`,
          );
        }
        if (!r.stdout.trim()) throw new Error(r.stderr.trim() || `bw exited ${r.code}`);
        return parseLines(r.stdout);
      },
    });
    const runTarget = makeRun({ exec, helper });
    this.helper = helper;

    cx.spawn(async (cx) => {
      loopCx = cx;
      try {
        await runRefresher(cx, {
          schedule: this.schedule,
          run: runTarget,
          onResult: (target, result) => mergeResult(this.git, this.helpers, target, result),
          watchFolder,
          poke: this.poke,
          alive: () => this.alive,
        });
      } finally {
        loopCx = null;
      }
    });
    cx.spawn(async (cx) => {
      while (this.alive) {
        for (const [machine, loop] of this.countLoops) {
          if (loop.started) continue;
          loop.started = true;
          cx.spawn((cx) => this.countLoop(cx, machine, loop));
        }
        await this.countStarter.wait();
      }
    });
    cx.timer.every(60000, (cx) => {
      if (this.showsTime) cx.notify();
    });
  }

  close() {
    this.alive = false;
    this.poke.poke();
    this.countStarter.poke();
    for (const loop of this.countLoops.values()) loop.poke.poke();
  }

  /**
   * Runs `bw counts` on `machine` every 10 s, or at once when poked, until render drops the machine.
   * Reads no live data: render hands it the terminals.
   * @param {any} cx @param {string | null} machine @param {CountLoop} loop
   */
  async countLoop(cx, machine, loop) {
    while (this.alive && loop.live) {
      const started = Date.now();
      const terminals = loop.terminals;
      /** @type {Record<string, import("./projects-model.js").AgentCount>} */
      const got = {};
      for (let i = 0; i < terminals.length; i += COUNTS_PER_CALL) {
        const part = terminals.slice(i, i + COUNTS_PER_CALL);
        // The Git loop's helper target installs bw; this loop only waits for it.
        const r = await this.helper.call(machine, ["counts", "--terminals", part.map((t) => t.local).join(",")], {
          install: false,
        });
        if (!r.ok) continue;
        const address = new Map(part.map((t) => [t.local, t.address]));
        for (const l of r.lines) {
          const a = l.type === "count" && typeof l.terminal === "string" ? address.get(l.terminal) : undefined;
          if (a) got[a] = { subagents: l.subagents, requests: l.requests };
        }
      }
      if (this.alive && loop.live && this.mergeCounts(got)) cx.notify();
      await loop.poke.wait(cx.sleep(Math.max(1000, COUNTS_MS - (Date.now() - started))));
    }
  }

  /** @param {Record<string, import("./projects-model.js").AgentCount>} got @returns {boolean} true when a count changed */
  mergeCounts(got) {
    let changed = false;
    for (const [address, c] of Object.entries(got)) {
      const was = this.counts[address];
      if (was?.subagents === c.subagents && was?.requests === c.requests) continue;
      this.counts[address] = c;
      changed = true;
    }
    return changed;
  }

  /**
   * Keeps one counts loop per ready machine with agent lines, and pokes a machine's loop when its terminals
   * or one of its agents' status changed. A second render with nothing new changes nothing.
   * @param {import("./projects-model.js").ProjectTree} tree @param {any[]} agents AgentInfo[] @param {any[]} spaces SpaceInfo[]
   */
  syncCounts(tree, agents, spaces) {
    const want = new Map(countTargets(tree).map((c) => [c.machine, c.terminals]));
    for (const [machine, loop] of this.countLoops) {
      if (want.has(machine)) continue;
      loop.live = false;
      loop.poke.poke();
      this.countLoops.delete(machine);
      for (const t of loop.terminals) delete this.counts[t.address];
    }
    let fresh = false;
    for (const [machine, terminals] of want) {
      const loop = this.countLoops.get(machine);
      if (!loop) {
        this.countLoops.set(machine, { terminals, poke: createPoke(), live: true, started: false });
        fresh = true;
      } else if (JSON.stringify(loop.terminals) !== JSON.stringify(terminals)) {
        loop.terminals = terminals;
        loop.poke.poke();
      }
    }
    if (fresh) this.countStarter.poke();

    const machineOf = new Map(spaces.map((s) => [s.id, s.machine ?? null]));
    for (const a of agents) {
      const was = this.statuses.get(a.address);
      if (was !== undefined && was !== a.status) this.countLoops.get(machineOf.get(a.space) ?? null)?.poke.poke();
    }
    this.statuses = new Map(agents.map((a) => [a.address, a.status]));
  }

  /** @param {string} key @param {any} cx */
  toggle(key, cx) {
    if (!this.folded.delete(key)) this.folded.add(key);
    try {
      localStorage.setItem(FOLDED, JSON.stringify([...this.folded]));
    } catch {
      // A copy without storage still folds; the choice is lost on reload.
    }
    cx.notify();
  }

  /** @param {any} tree @param {any} input @param {string | null} active @param {unknown} stored */
  sync(tree, input, active, stored) {
    const order = JSON.stringify(tree.agentOrder);
    if (order !== this.order) {
      this.order = order;
      setAgentOrder(tree.agentOrder);
    }
    const has = new Set(input.stored.map((/** @type {any} */ p) => projectKey(p.machine, p.commonDir)));
    for (const key of this.remembered) if (has.has(key)) this.remembered.delete(key);
    const fresh = tree.remember.filter((p) => !this.remembered.has(projectKey(p.machine, p.commonDir)));
    if (fresh.length) {
      for (const p of fresh) this.remembered.add(projectKey(p.machine, p.commonDir));
      setShared(STORE, rememberProjects(stored, fresh));
    }
    if (this.schedule.setTargets(refreshTargets(tree, input, active), Date.now())) this.poke.poke();
  }

  render() {
    const t = theme();
    const win = window();
    const stored = shared(STORE);
    const all = spaces();
    const input = {
      machines: machines(),
      spaces: all,
      panes: panes(),
      agents: agents(),
      terminals: terminals(),
      stored: readStored(stored),
      platform: win.platform,
      git: this.git,
      counts: this.counts,
    };
    const tree = buildProjects(input);
    const active = all.find((s) => s.active)?.id ?? null;
    this.sync(tree, input, active, stored);
    this.syncCounts(tree, input.agents, all);

    this.showsTime = false;
    /** @type {import("./rows.js").Draw} */
    const d = {
      t,
      now: Date.now(),
      active,
      hovered: this.hovered,
      helpers: this.helpers,
      isFolded: (key) => this.folded.has(key),
      toggle: (key, cx) => this.toggle(key, cx),
      hover: (key, on, cx) => {
        const next = on ? key : this.hovered === key ? null : this.hovered;
        if (next === this.hovered) return;
        this.hovered = next;
        cx.notify();
      },
      openWorktree: (w, p) => runAll(openWorktree(w, p.machine)),
      focusAgent: (a) => runAll(focusAgent(a)),
      selectSpace: (id) => run("space.select", { id }),
      projectMenu: (p) => openOverlay(projectMenu(p)),
      newInMain: (p) => openOverlay(newInMain(p)),
      addProject: () => openOverlay(addProject()),
      drewTime: () => {
        this.showsTime = true;
      },
    };

    const narrow = this.width !== null && this.width < RAIL_BELOW;
    // Leave the macOS window buttons room when the layout hides the title bar.
    const lights = win.platform === "macos" && win.titlebar === "none" && !win.fullscreen;
    const root = v_flex()
      .id("root")
      .size_full()
      .bg(t.chrome)
      .on_size_change((size, cx) => {
        if (size.width === this.width) return;
        this.width = size.width;
        cx.notify();
      });

    const add = h_flex()
      .id("add-project")
      .h(24)
      .flex_none()
      .px(narrow ? 4 : 8)
      .gap(4)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(12)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(() => d.addProject())
      .child(svg(ICONS.plus).size(12).text_color(t.muted))
      .when(!narrow, (el) => el.child("Add project"));
    root.child(
      h_flex()
        .id("projects-header")
        .h(46)
        .flex_none()
        .pl(lights ? 76 : 12)
        .pr(8)
        .items_center()
        .justify_end()
        .child(add),
    );

    if (narrow) {
      const openFirst = (/** @type {any} */ p) => {
        const w = p.worktrees.find((x) => x.open) ?? p.worktrees.find((x) => !x.prunable);
        if (w) d.openWorktree(w, p);
      };
      return root.child(rail(d, tree.machines, openFirst));
    }

    const body = v_flex().id("projects-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8);
    body.children(tree.machines.map((m) => machineSection(d, m)));
    if (tree.machines.every((m) => m.projects.length === 0 && m.plain.length === 0)) {
      body.child(
        div()
          .px(16)
          .pt(8)
          .text_size(12)
          .text_color(t.dim)
          .child("No projects yet. Add one, or open a space in a Git folder."),
      );
    }
    return root.child(body);
  }
}

/** @param {[string, Record<string, unknown>][]} commands */
function runAll(commands) {
  for (const [cmd, args] of commands) run(cmd, args);
}
