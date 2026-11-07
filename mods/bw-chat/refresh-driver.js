// Runs a refresh schedule inside one loop task. Reads no live data: render hands it targets and pokes.

/** @typedef {import("./refresh-schedule.js").Target} Target */
/** @typedef {import("./refresh-schedule.js").Schedule} Schedule */

/**
 * @typedef {object} Poke
 * @property {() => void} poke wakes the loop; kept until the next `wait` when nobody waits
 * @property {(other?: Promise<unknown>) => Promise<unknown>} wait settles at the next poke or when `other`
 *   (the loop's sleep) settles; pass the sleep, or a poke made after the sleep won is lost
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
  /** @type {(() => void) | null} */
  let wake = null;
  let pending = false;
  return {
    poke() {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      } else {
        pending = true;
      }
    },
    wait(other) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      /** @type {() => void} */
      let mine = () => {};
      const poked = new Promise((resolve) => (mine = () => resolve(undefined)));
      wake = mine;
      if (!other) return poked;
      // When `other` wins, the caller is no longer waiting: a later poke must stay pending, not
      // wake this waiter. Only this wait's own waiter is dropped, never a newer one.
      const gone = Promise.resolve(other).then(
        () => {
          if (wake === mine) wake = null;
        },
        () => {
          if (wake === mine) wake = null;
        },
      );
      return Promise.race([poked, gone]);
    },
  };
}

/**
 * @param {LoopContext} cx
 * @param {RefresherOptions} opts
 * @returns {Promise<void>}
 */
export async function runRefresher(
  cx,
  { schedule, run, onResult, watchFolder, now = Date.now, alive = () => true, poke = createPoke() },
) {
  /** @type {[Target, unknown][]} */
  const finished = [];
  /** @type {Set<string>} */
  const watching = new Set();
  // A rejected watch is not retried while the schedule still wants its folder; the schedule's timer stands in.
  /** @type {Set<string>} */
  const rejected = new Set();

  // setTargets forgets a rejection once no target wants the folder, so forget it here too, or a
  // re-added folder would get neither a watch nor the fallback timer.
  function reconcileRejected() {
    const wanted = schedule.watchedFolders();
    for (const dir of rejected) {
      if (wanted.includes(dir)) schedule.rejected(dir, now());
      else rejected.delete(dir);
    }
  }

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
        schedule.finish(target.key, now(), { ok: Boolean(/** @type {any} */ (result)?.ok) });
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
          watching.delete(dir);
          rejected.add(dir);
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

    reconcileRejected();
    for (let t = schedule.next(now()); t; t = schedule.next(now())) launch(t);
    for (const dir of schedule.watchedFolders()) if (!watching.has(dir) && !rejected.has(dir)) watch(dir);

    const ms = schedule.wakeIn(now());
    await poke.wait(cx.sleep(ms ?? IDLE_MS));
  }
}
