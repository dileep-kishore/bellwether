// When each Git refresh is due. Pure: every method takes `now` in ms, so tests drive a fake clock.

/**
 * @typedef {"place" | "list" | "counts" | "helper"} TargetKind
 */

/**
 * @typedef {object} Target
 * @property {string} key
 * @property {TargetKind} kind
 * @property {string | null} machine null is this Mac
 * @property {string} path
 * @property {boolean} open
 * @property {boolean} selected
 * @property {string[]} wakeOn folders whose changes make it due; read only for this Mac
 */

/**
 * @typedef {object} Times
 * @property {number} throttle least time between starts after a watch event
 * @property {number} openLocal backstop for an open worktree on this Mac
 * @property {number} rejected timer for a target whose watch was rejected
 * @property {number} remote every target on another machine
 * @property {number} selectedRemote the selected worktree on another machine
 */

/**
 * @typedef {object} Schedule
 * @property {(targets: Target[], now: number) => boolean} setTargets true when the target set or any target changed
 * @property {() => string[]} watchedFolders
 * @property {(folder: string, paths: string[], now: number) => void} event
 * @property {(folder: string, now: number) => void} rejected
 * @property {(now: number) => Target | null} next
 * @property {(key: string, now: number) => void} start
 * @property {(key: string, now: number) => void} finish
 * @property {(now: number) => number | null} wakeIn
 * @property {(machine: string | null) => boolean} inFlight
 */

/** @type {Times} */
export const TIMES = Object.freeze({ throttle: 1000, openLocal: 30000, rejected: 60000, remote: 15000, selectedRemote: 1500 });

const ONCE = new Set(["place", "helper"]);

/** @param {Target} t */
function priority(t) {
  if (t.kind === "place") return 0;
  if (t.kind === "counts" && t.selected) return 1;
  if (t.kind === "counts" && t.open) return 2;
  if (t.kind === "list") return 3;
  if (t.kind === "counts") return 4;
  return 5;
}

/** @param {string} p */
function norm(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** True when `path` is `folder` or lies under it; "/r/alpha-wt" is not under "/r/alpha". */
function under(path, folder) {
  return path === folder || path.startsWith(folder === "/" ? "/" : folder + "/");
}

/** @param {Target} t */
function folders(t) {
  return t.machine == null ? (t.wakeOn ?? []).map(norm) : [];
}

/** @param {Target} a @param {Target} b */
function same(a, b) {
  return (
    a.kind === b.kind &&
    a.machine === b.machine &&
    a.path === b.path &&
    a.open === b.open &&
    a.selected === b.selected &&
    JSON.stringify(a.wakeOn ?? []) === JSON.stringify(b.wakeOn ?? [])
  );
}

/**
 * @param {Times} [times]
 * @returns {Schedule}
 */
export function createSchedule(times = TIMES) {
  /** @type {Map<string, { target: Target, added: number, lastStart: number | null, marked: boolean }>} */
  const states = new Map();
  // Kept apart from `states` so a call still runs, and holds its machine, after its target is dropped.
  /** @type {Map<string, string | null>} */
  const running = new Map();
  /** @type {Set<string>} */
  const rejectedFolders = new Set();

  function dueAt(state) {
    const t = state.target;
    if (running.has(t.key)) return null;
    if (state.lastStart === null) return state.added;
    if (ONCE.has(t.kind)) return null;
    const last = state.lastStart;
    let due = Infinity;
    if (state.marked) due = last + times.throttle;
    if (t.machine == null) {
      if (t.kind === "counts" && t.open) due = Math.min(due, last + times.openLocal);
      const fs = folders(t);
      if (fs.some((f) => [...rejectedFolders].some((r) => under(f, r)))) due = Math.min(due, last + times.rejected);
    } else {
      due = Math.min(due, last + (t.selected ? times.selectedRemote : times.remote));
    }
    return due === Infinity ? null : due;
  }

  function inFlight(machine) {
    for (const m of running.values()) if (m === machine) return true;
    return false;
  }

  function watchedFolders() {
    const all = [];
    for (const { target } of states.values()) for (const f of folders(target)) if (!all.includes(f)) all.push(f);
    return all.filter((f) => !all.some((g) => g !== f && under(f, g)));
  }

  return {
    setTargets(targets, now) {
      let changed = false;
      const keep = new Set();
      for (const t of targets) {
        keep.add(t.key);
        const old = states.get(t.key);
        if (!old) {
          states.set(t.key, { target: t, added: now, lastStart: null, marked: false });
          changed = true;
        } else if (!same(old.target, t)) {
          old.target = t;
          changed = true;
        }
      }
      for (const key of [...states.keys()]) {
        if (!keep.has(key)) {
          states.delete(key);
          changed = true;
        }
      }
      for (const r of [...rejectedFolders]) {
        if (![...states.values()].some((s) => folders(s.target).some((f) => under(f, r)))) rejectedFolders.delete(r);
      }
      return changed;
    },

    watchedFolders,

    event(folder, paths, _now) {
      const root = norm(folder);
      const changed = paths.map(norm);
      const everything = changed.includes(root);
      for (const state of states.values()) {
        const fs = folders(state.target);
        const hit = everything
          ? fs.some((f) => under(f, root))
          : fs.some((f) => changed.some((p) => under(p, f)));
        if (hit) state.marked = true;
      }
    },

    rejected(folder, _now) {
      rejectedFolders.add(norm(folder));
    },

    next(now) {
      let best = null;
      let bestDue = 0;
      for (const state of states.values()) {
        const due = dueAt(state);
        if (due === null || due > now || inFlight(state.target.machine)) continue;
        const better =
          !best ||
          priority(state.target) < priority(best.target) ||
          (priority(state.target) === priority(best.target) && due < bestDue);
        if (better) {
          best = state;
          bestDue = due;
        }
      }
      return best ? best.target : null;
    },

    start(key, now) {
      const state = states.get(key);
      if (!state) return;
      running.set(key, state.target.machine);
      state.lastStart = now;
      state.marked = false;
    },

    finish(key, _now) {
      running.delete(key);
    },

    wakeIn(now) {
      let soonest = null;
      for (const state of states.values()) {
        // A due target behind a running call on its machine wakes when that call finishes, not by timer.
        if (inFlight(state.target.machine)) continue;
        const due = dueAt(state);
        if (due === null) continue;
        const ms = Math.max(0, due - now);
        if (soonest === null || ms < soonest) soonest = ms;
      }
      return soonest;
    },

    inFlight,
  };
}
