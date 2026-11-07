// Runs a refresh schedule inside one loop task. Reads no live data: render hands it targets and pokes.

/** @typedef {import("./refresh-schedule.js").Target} Target */
/** @typedef {import("./refresh-schedule.js").Schedule} Schedule */

/**
 * @typedef {object} Poke
 * @property {() => void} poke wakes the loop; kept until the next `wait` when nobody waits
 * @property {() => Promise<void>} wait
 */

/**
 * @typedef {object} LoopContext the loop task's own `cx`
 * @property {(body: (cx: LoopContext) => unknown) => unknown} spawn
 * @property {(ms?: number) => Promise<void>} sleep
 * @property {() => void} notify
 */

/**
 * @typedef {object} RefresherOptions
 * @property {Schedule} schedule
 * @property {(target: Target) => Promise<unknown>} run
 * @property {(target: Target, result: unknown) => boolean} onResult true when the shown data changed
 * @property {(dir: string) => Promise<string[]>} watchFolder
 * @property {() => number} [now]
 * @property {() => boolean} [alive]
 * @property {Poke} [poke] the one `render` pokes; runs and watch events poke it too
 */

const IDLE_MS = 60000;

/** @returns {Poke} */
export function createPoke() {
  /** @type {Promise<void> | null} */
  let waiting = null;
  /** @type {(() => void) | null} */
  let wake = null;
  let pending = false;
  return {
    poke() {
      if (wake) {
        const w = wake;
        waiting = null;
        wake = null;
        w();
      } else {
        pending = true;
      }
    },
    // One shared promise, so a loop that wakes by timer many times leaves no pile of waiters behind.
    wait() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      if (!waiting) waiting = new Promise((resolve) => (wake = resolve));
      return waiting;
    },
  };
}

/**
 * @param {LoopContext} cx
 * @param {RefresherOptions} opts
 * @returns {Promise<void>}
 */
export async function runRefresher(cx, { schedule, run, onResult, watchFolder, now = Date.now, alive = () => true, poke = createPoke() }) {
  /** @type {[Target, unknown][]} */
  const finished = [];
  /** @type {Set<string>} */
  const watching = new Set();

  function launch(target) {
    schedule.start(target.key, now());
    let call;
    try {
      call = Promise.resolve(run(target));
    } catch (e) {
      call = Promise.reject(e);
    }
    call
      .catch((e) => ({ ok: false, state: "failed", message: e instanceof Error ? e.message : String(e) }))
      .then((result) => {
        schedule.finish(target.key, now());
        finished.push([target, result]);
        poke.poke();
      });
  }

  function watch(dir) {
    watching.add(dir);
    cx.spawn(async () => {
      while (alive() && schedule.watchedFolders().includes(dir)) {
        let paths;
        try {
          paths = await watchFolder(dir);
        } catch {
          // Stays in `watching`: a rejected watch is not retried, the schedule's timer stands in.
          schedule.rejected(dir, now());
          poke.poke();
          return;
        }
        schedule.event(dir, paths, now());
        poke.poke();
      }
      watching.delete(dir);
    });
  }

  while (alive()) {
    let changed = false;
    for (const [target, result] of finished.splice(0)) if (onResult(target, result)) changed = true;
    if (changed) cx.notify();

    for (let t = schedule.next(now()); t; t = schedule.next(now())) launch(t);
    for (const dir of schedule.watchedFolders()) if (!watching.has(dir)) watch(dir);

    const ms = schedule.wakeIn(now());
    await Promise.race([cx.sleep(ms ?? IDLE_MS), poke.wait()]);
  }
}
