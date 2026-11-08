// A fake gpui `cx` for the headless harness: spawned bodies wait for flush(), sleeps park until
// a test wakes them, and timers are recorded for mount's tickTimer.
import { activity, inPhase, refuse, touch, violations } from "./herdr-stub.js";

/**
 * @typedef {{ cancel(): void, is_done(): boolean, cancelled: boolean, done: boolean }} Task
 * @typedef {{ ms: number, wake(): void }} Sleep
 * @typedef {{ ms: number, fn: (cx: Cx) => unknown }} TimerEntry
 * @typedef {ReturnType<typeof makeCx>} Cx
 */

const MAX_TURNS = 100;

function makeTask() {
  /** @type {Task} */
  const task = {
    cancelled: false,
    done: false,
    cancel() {
      task.cancelled = true;
    },
    is_done: () => task.done,
  };
  return task;
}

export function makeCx() {
  /** @type {{ body: (cx: any) => unknown, task: Task }[]} */
  const queue = [];
  const cx = {
    notified: 0,
    stopped: 0,
    /** @type {TimerEntry[]} */ timers: [],
    /** @type {TimerEntry[]} */ afters: [],
    /** @type {Sleep[]} */ sleeps: [],
    notify() {
      touch();
      cx.notified++;
    },
    /** @param {(cx: any) => unknown} body */
    spawn(body) {
      touch();
      const task = makeTask();
      queue.push({ body, task });
      return task;
    },
    /** @param {number} [ms] @returns {Promise<void>} */
    sleep(ms = 0) {
      touch();
      return new Promise((resolve) =>
        cx.sleeps.push({
          ms,
          wake: () => {
            touch();
            resolve();
          },
        }),
      );
    },
    timer: {
      /** @param {number} ms @param {(cx: any) => unknown} fn */
      every(ms, fn) {
        touch();
        if (!(ms >= 1000)) refuse(`timer.every(${ms}) is under 1000 ms`);
        cx.timers.push({ ms, fn });
        return makeTask();
      },
      /** @param {number} ms @param {(cx: any) => unknown} fn */
      after(ms, fn) {
        touch();
        cx.afters.push({ ms, fn });
        return makeTask();
      },
    },
    focus_handle() {
      return { focus() {}, is_focused: () => false };
    },
    stop_propagation() {
      cx.stopped++;
    },
    /** @type {string[]} */ opened: [],
    /** @param {string} url */
    open_url(url) {
      if (!/^https?:\/\/[^/]+/.test(url)) refuse(`open_url(${url}) is not an absolute http(s) URL`);
      cx.opened.push(url);
    },
    /** @type {string[]} */ clipboard: [],
    /** @param {string} text */
    write_to_clipboard(text) {
      cx.clipboard.push(text);
    },
    propagate() {},
    /** Starts queued bodies with phase "task" and lets them run until a turn passes with no stub call. */
    async flush() {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const before = activity();
        const fresh = queue.splice(0);
        for (const { body, task } of fresh) {
          if (task.cancelled) continue;
          inPhase("task", async () => body(cx)).then(
            () => {
              task.done = true;
            },
            (e) => {
              task.done = true;
              if (!violations.includes(e)) violations.push(e);
            },
          );
        }
        await new Promise((r) => setImmediate(r));
        if (fresh.length === 0 && queue.length === 0 && activity() === before) return;
      }
    },
  };
  return cx;
}
