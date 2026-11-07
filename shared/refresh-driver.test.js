import { describe, expect, test } from "bun:test";
import { createPoke, runRefresher } from "./refresh-driver.js";
import { createSchedule } from "./refresh-schedule.js";

function target(kind, path, over = {}) {
  const machine = over.machine ?? null;
  return {
    key: `${kind}:${machine ?? ""}:${path}`,
    kind,
    machine,
    path,
    open: false,
    selected: false,
    wakeOn: [],
    ...over,
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A fake clock and the loop task's `cx`; `advance` resolves sleeps in time order. */
function world() {
  const clock = { t: 0 };
  /** @type {{ at: number, resolve: () => void }[]} */
  const sleepers = [];
  const spawned = [];
  const cx = {
    notified: 0,
    notify() {
      cx.notified++;
    },
    spawn(body) {
      const p = Promise.resolve().then(() => body(cx));
      spawned.push(p);
      return p;
    },
    sleep(ms = 0) {
      return new Promise((resolve) => sleepers.push({ at: clock.t + ms, resolve }));
    },
  };
  async function advance(ms) {
    const end = clock.t + ms;
    for (;;) {
      await settle();
      sleepers.sort((a, b) => a.at - b.at);
      if (!sleepers.length || sleepers[0].at > end) break;
      const s = sleepers.shift();
      clock.t = s.at;
      s.resolve();
    }
    clock.t = end;
    await settle();
  }
  return { clock, cx, spawned, advance, now: () => clock.t };
}

/** A fake folder watcher: `fire(dir, paths)` resolves the pending watch, `reject(dir)` fails it. */
function watcher() {
  const pending = new Map();
  const calls = [];
  return {
    calls,
    watchFolder(dir) {
      calls.push(dir);
      return new Promise((resolve, reject) => pending.set(dir, { resolve, reject }));
    },
    fire(dir, paths) {
      pending.get(dir).resolve(paths);
      pending.delete(dir);
    },
    reject(dir) {
      pending.get(dir).reject(new Error("too many directories"));
      pending.delete(dir);
    },
  };
}

function start(w, targets, opts = {}) {
  const schedule = createSchedule();
  schedule.setTargets(targets, w.now());
  const poke = createPoke();
  const calls = [];
  const results = [];
  let alive = true;
  const watch = opts.watch ?? watcher();
  const run =
    opts.run ??
    (async (t) => {
      calls.push([t.key, w.now()]);
      return { ok: true };
    });
  const done = runRefresher(w.cx, {
    schedule,
    run: async (t) => {
      if (opts.run) calls.push([t.key, w.now()]);
      return run(t);
    },
    onResult: (t, r) => {
      results.push([t.key, r]);
      return opts.changed ? opts.changed(t, r) : false;
    },
    watchFolder: watch.watchFolder,
    now: w.now,
    alive: () => alive,
    poke,
  });
  return {
    schedule,
    poke,
    calls,
    results,
    watch,
    done,
    async stop() {
      alive = false;
      poke.poke();
      await w.advance(0);
      await done;
    },
  };
}

describe("refresh driver", () => {
  test("poke wakes a waiter, and a poke with no waiter is kept", async () => {
    const p = createPoke();
    let woke = 0;
    p.wait().then(() => woke++);
    p.poke();
    await settle();
    expect(woke).toBe(1);
    p.poke();
    let early = false;
    p.wait().then(() => (early = true));
    await settle();
    expect(early).toBe(true);
    let late = false;
    p.wait().then(() => (late = true));
    await settle();
    expect(late).toBe(false);
  });

  test("a poke made after a timer woke the loop is kept for the next wait", async () => {
    const p = createPoke();
    /** @type {() => void} */
    let fire = () => {};
    const timer = new Promise((r) => (fire = () => r(undefined)));
    let woke = false;
    Promise.race([timer, p.wait(timer)]).then(() => (woke = true));
    fire();
    await settle();
    expect(woke).toBe(true);
    // The loop is now reading; this poke must not go to the waiter the timer beat.
    p.poke();
    let early = false;
    p.wait(new Promise(() => {})).then(() => (early = true));
    await settle();
    expect(early).toBe(true);
    let late = false;
    p.wait(new Promise(() => {})).then(() => (late = true));
    await settle();
    expect(late).toBe(false);
  });

  test("a timer from an earlier wait does not drop the current waiter", async () => {
    const p = createPoke();
    /** @type {() => void} */
    let fireOld = () => {};
    const old = new Promise((r) => (fireOld = () => r(undefined)));
    p.wait(old);
    p.poke();
    await settle();
    let woke = false;
    p.wait(new Promise(() => {})).then(() => (woke = true));
    fireOld();
    await settle();
    p.poke();
    await settle();
    expect(woke).toBe(true);
  });

  test("starts due targets and stops when not alive", async () => {
    const w = world();
    const r = start(w, [target("place", "/r/alpha"), target("helper", "", { machine: "macmini" })]);
    await w.advance(0);
    expect(r.calls.map(([k]) => k).sort()).toEqual(["helper:macmini:", "place::/r/alpha"]);
    expect(r.results).toHaveLength(2);
    await w.advance(120_000);
    expect(r.calls).toHaveLength(2);
    await r.stop();
  });

  test("driver: no calls while a machine is unavailable", async () => {
    const w = world();
    const remote = target("counts", "/home/u/gamma", { machine: "macmini" });
    const local = target("counts", "/r/alpha", { open: true, wakeOn: ["/r/alpha"] });
    const r = start(w, [remote, local]);
    await w.advance(0);
    expect(r.calls.filter(([k]) => k === remote.key)).toHaveLength(1);
    r.schedule.setTargets([local], w.now());
    r.poke.poke();
    await w.advance(120_000);
    expect(r.calls.filter(([k]) => k === remote.key)).toHaveLength(1);
    expect(r.calls.filter(([k]) => k === local.key).length).toBeGreaterThan(1);
    await r.stop();
  });

  test("driver: rejected exec result is passed on and the loop goes on", async () => {
    const w = world();
    const a = target("counts", "/home/u/gamma", { machine: "macmini" });
    const b = target("list", "/home/u/beta/.git", { machine: "box" });
    const r = start(w, [a, b], {
      run: async (t) => {
        if (t.key === b.key) throw new Error("boom");
        return { ok: false, state: "unreachable", message: "machine macmini is unreachable" };
      },
    });
    await w.advance(0);
    expect(r.results).toContainEqual([
      a.key,
      { ok: false, state: "unreachable", message: "machine macmini is unreachable" },
    ]);
    expect(r.results).toContainEqual([b.key, { ok: false, state: "failed", message: "boom" }]);
    expect(r.schedule.inFlight("macmini")).toBe(false);
    expect(r.schedule.inFlight("box")).toBe(false);
    await w.advance(15_000);
    expect(r.calls.filter(([k]) => k === a.key).map(([, at]) => at)).toEqual([0, 15_000]);
    expect(r.calls.filter(([k]) => k === b.key).map(([, at]) => at)).toEqual([0, 15_000]);
    await r.stop();
  });

  test("driver: notify once per drain, only when onResult says changed", async () => {
    const w = world();
    const a = target("counts", "/home/u/gamma", { machine: "macmini" });
    const b = target("counts", "/home/u/delta", { machine: "box" });
    const gates = [];
    let changed = true;
    const r = start(w, [a, b], {
      run: () => new Promise((resolve) => gates.push(resolve)),
      changed: () => changed,
    });
    await w.advance(0);
    expect(gates).toHaveLength(2);
    for (const g of gates.splice(0)) g({ ok: true });
    await w.advance(0);
    expect(r.results).toHaveLength(2);
    expect(w.cx.notified).toBe(1);

    changed = false;
    await w.advance(15_000);
    for (const g of gates.splice(0)) g({ ok: true });
    await w.advance(0);
    expect(r.results).toHaveLength(4);
    expect(w.cx.notified).toBe(1);
    await r.stop();
  });

  test("driver: a place whose first read fails is read again", async () => {
    const w = world();
    const p = target("place", "/home/u/gamma", { machine: "macmini" });
    const answers = [
      { ok: false, state: "unreachable", message: "temporary" },
      { ok: true, place: {} },
    ];
    const r = start(w, [p], { run: async () => answers.shift() });
    await w.advance(14_999);
    expect(r.calls).toEqual([[p.key, 0]]);
    await w.advance(1);
    expect(r.calls).toEqual([
      [p.key, 0],
      [p.key, 15_000],
    ]);
    await w.advance(600_000);
    expect(r.calls).toHaveLength(2);
    await r.stop();
  });

  test("driver: a place whose read throws is read again", async () => {
    const w = world();
    const p = target("place", "/r/alpha");
    let n = 0;
    const r = start(w, [p], {
      run: async () => {
        if (n++ === 0) throw new Error("exec rejected");
        return { ok: true, place: {} };
      },
    });
    await w.advance(30_000);
    expect(r.calls).toEqual([
      [p.key, 0],
      [p.key, 30_000],
    ]);
    await r.stop();
  });

  test("driver: a watch event refreshes its targets, throttled", async () => {
    const w = world();
    const t = target("counts", "/r/alpha-wt/feat", { wakeOn: ["/r/alpha-wt/feat"] });
    const r = start(w, [t]);
    await w.advance(0);
    expect(r.watch.calls).toEqual(["/r/alpha-wt/feat"]);
    expect(r.calls).toEqual([[t.key, 0]]);

    await w.advance(5000);
    r.watch.fire("/r/alpha-wt/feat", ["/r/alpha-wt/feat/a.txt"]);
    await w.advance(0);
    expect(r.calls.at(-1)).toEqual([t.key, 5000]);
    expect(r.watch.calls).toEqual(["/r/alpha-wt/feat", "/r/alpha-wt/feat"]);

    await w.advance(200);
    r.watch.fire("/r/alpha-wt/feat", ["/r/alpha-wt/feat/b.txt"]);
    await w.advance(0);
    expect(r.calls).toHaveLength(2);
    await w.advance(800);
    expect(r.calls.at(-1)).toEqual([t.key, 6000]);
    await r.stop();
  });

  test("driver: a watch reject schedules the 60 s fallback", async () => {
    const w = world();
    const t = target("counts", "/r/alpha-wt/detached", { wakeOn: ["/r/alpha/.git"] });
    const r = start(w, [t]);
    await w.advance(0);
    expect(r.calls).toEqual([[t.key, 0]]);
    r.watch.reject("/r/alpha/.git");
    await w.advance(59_999);
    expect(r.calls).toHaveLength(1);
    await w.advance(1);
    expect(r.calls).toEqual([
      [t.key, 0],
      [t.key, 60_000],
    ]);
    expect(r.watch.calls).toEqual(["/r/alpha/.git"]);
    await r.stop();
  });

  test("driver: a folder re-added after a rejected watch is watched again", async () => {
    const w = world();
    const t = target("list", "/r/a/.git", { wakeOn: ["/r/a/.git"] });
    const r = start(w, [t]);
    await w.advance(0);
    r.watch.reject("/r/a/.git");
    await w.advance(1000);
    r.schedule.setTargets([], w.now());
    r.poke.poke();
    await w.advance(0);

    r.schedule.setTargets([t], w.now());
    r.poke.poke();
    await w.advance(0);
    expect(r.calls).toEqual([
      [t.key, 0],
      [t.key, 1000],
    ]);
    expect(r.watch.calls).toEqual(["/r/a/.git", "/r/a/.git"]);

    r.watch.reject("/r/a/.git");
    await w.advance(60_000);
    expect(r.calls.at(-1)).toEqual([t.key, 61_000]);
    expect(r.watch.calls).toHaveLength(2);
    await r.stop();
  });

  test("driver: a rejected folder dropped and re-added between loop turns keeps its fallback", async () => {
    const w = world();
    const t = target("list", "/r/a/.git", { wakeOn: ["/r/a/.git"] });
    const r = start(w, [t]);
    await w.advance(0);
    r.watch.reject("/r/a/.git");
    await w.advance(1000);
    r.schedule.setTargets([], w.now());
    r.schedule.setTargets([t], w.now());
    r.poke.poke();
    await w.advance(0);
    expect(r.calls).toEqual([
      [t.key, 0],
      [t.key, 1000],
    ]);
    await w.advance(60_000);
    expect(r.calls.at(-1)).toEqual([t.key, 61_000]);
    expect(r.watch.calls).toEqual(["/r/a/.git"]);
    await r.stop();
  });

  test("driver: render poke wakes the loop before wakeIn", async () => {
    const w = world();
    const a = target("counts", "/home/u/gamma", { machine: "macmini" });
    const r = start(w, [a]);
    await w.advance(1000);
    const b = target("place", "/home/u/new", { machine: "box" });
    expect(r.schedule.setTargets([a, b], w.now())).toBe(true);
    r.poke.poke();
    await w.advance(0);
    expect(r.calls).toEqual([
      [a.key, 0],
      [b.key, 1000],
    ]);
    await r.stop();
  });

  test("results that land after close are dropped", async () => {
    const w = world();
    const a = target("counts", "/home/u/gamma", { machine: "macmini" });
    const gates = [];
    const r = start(w, [a], { run: () => new Promise((resolve) => gates.push(resolve)), changed: () => true });
    await w.advance(0);
    await r.stop();
    gates[0]({ ok: true });
    await w.advance(0);
    expect(r.results).toEqual([]);
    expect(w.cx.notified).toBe(0);
  });
});
