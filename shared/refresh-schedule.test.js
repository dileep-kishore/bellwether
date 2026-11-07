import { describe, expect, test } from "bun:test";
import { createSchedule, TIMES } from "./refresh-schedule.js";

/** @returns {import("./refresh-schedule.js").Target} */
function target(kind, path, over = {}) {
  const machine = over.machine ?? null;
  return { key: `${kind}:${machine ?? ""}:${path}`, kind, machine, path, open: false, selected: false, wakeOn: [], ...over };
}
const counts = (path, over) => target("counts", path, over);
const list = (path, over) => target("list", path, over);

describe("refresh schedule", () => {
  test("times follow the spec", () => {
    expect(TIMES).toEqual({ throttle: 1000, openLocal: 30000, rejected: 60000, remote: 15000, selectedRemote: 1500 });
  });

  test("new target is due now; place runs once", () => {
    const s = createSchedule();
    const p = target("place", "/r/alpha");
    s.setTargets([p], 0);
    expect(s.next(0)?.key).toBe(p.key);
    expect(s.wakeIn(0)).toBe(0);
    s.start(p.key, 0);
    expect(s.inFlight(null)).toBe(true);
    s.finish(p.key, 30);
    expect(s.inFlight(null)).toBe(false);
    expect(s.next(10_000_000)).toBe(null);
    expect(s.wakeIn(10_000_000)).toBe(null);
  });

  test("helper runs once", () => {
    const s = createSchedule();
    const h = target("helper", "", { machine: "macmini" });
    s.setTargets([h], 0);
    s.start(h.key, 0);
    s.finish(h.key, 10);
    expect(s.next(10_000_000)).toBe(null);
  });

  test("a failed place reruns after 30 s local, 15 s remote, until it succeeds", () => {
    const s = createSchedule();
    const local = target("place", "/r/alpha");
    const remote = target("place", "/home/u/gamma", { machine: "macmini" });
    s.setTargets([local, remote], 0);
    s.start(local.key, 0);
    s.start(remote.key, 0);
    s.finish(local.key, 10, { ok: false });
    s.finish(remote.key, 10, { ok: false });
    expect(s.next(14_999)).toBe(null);
    expect(s.wakeIn(10)).toBe(14_990);
    expect(s.next(15_000)?.key).toBe(remote.key);
    s.start(remote.key, 15_000);
    s.finish(remote.key, 15_010, { ok: true });
    expect(s.next(29_999)).toBe(null);
    expect(s.next(30_000)?.key).toBe(local.key);
    s.start(local.key, 30_000);
    s.finish(local.key, 30_010, { ok: true });
    expect(s.next(10_000_000)).toBe(null);
    expect(s.wakeIn(10_000_000)).toBe(null);
  });

  test("a failed helper reruns after the remote interval", () => {
    const s = createSchedule();
    const h = target("helper", "", { machine: "macmini" });
    s.setTargets([h], 0);
    s.start(h.key, 0);
    s.finish(h.key, 10, { ok: false });
    expect(s.next(14_999)).toBe(null);
    expect(s.next(15_000)?.key).toBe(h.key);
  });

  test("a failed run-once target never retries sooner than 1000 ms", () => {
    const s = createSchedule({ ...TIMES, openLocal: 5, remote: 5 });
    const p = target("place", "/r/alpha");
    s.setTargets([p], 0);
    s.start(p.key, 0);
    s.finish(p.key, 1, { ok: false });
    expect(s.next(999)).toBe(null);
    expect(s.next(1000)?.key).toBe(p.key);
  });

  test("events throttle to one refresh per second, then trailing", () => {
    const s = createSchedule();
    const t = counts("/r/alpha", { wakeOn: ["/r/alpha"] });
    const K = t.key;
    s.setTargets([t], 0);
    s.start(K, 0);
    s.finish(K, 50);
    s.event("/r/alpha", ["/r/alpha/a.txt"], 100);
    s.event("/r/alpha", ["/r/alpha/b.txt"], 300);
    expect(s.next(500)).toBe(null);
    expect(s.next(1000)?.key).toBe(K);
    expect(s.wakeIn(400)).toBe(600);
  });

  test("an event after the throttle window runs at once (leading edge)", () => {
    const s = createSchedule();
    const t = counts("/r/alpha", { wakeOn: ["/r/alpha"] });
    s.setTargets([t], 0);
    s.start(t.key, 0);
    s.finish(t.key, 50);
    s.event("/r/alpha", ["/r/alpha/a.txt"], 5000);
    expect(s.next(5000)?.key).toBe(t.key);
  });

  test("an event outside a target's folders leaves it alone", () => {
    const s = createSchedule();
    const t = counts("/r/alpha", { wakeOn: ["/r/alpha"] });
    s.setTargets([t], 0);
    s.start(t.key, 0);
    s.finish(t.key, 50);
    s.event("/r", ["/r/alpha-wt/feat/a.txt"], 5000);
    expect(s.next(5000)).toBe(null);
  });

  test("open local worktree backstop at 30 s; closed local has no timer", () => {
    const s = createSchedule();
    const open = counts("/r/alpha", { open: true, wakeOn: ["/r/alpha"] });
    const closed = counts("/r/alpha-wt/detached", { wakeOn: ["/r/alpha/.git"] });
    const lst = list("/r/alpha/.git", { wakeOn: ["/r/alpha/.git"] });
    s.setTargets([open, closed, lst], 0);
    for (const t of [open, closed, lst]) {
      s.start(t.key, 0);
      s.finish(t.key, 10);
    }
    expect(s.next(29_999)).toBe(null);
    expect(s.wakeIn(0)).toBe(30_000);
    expect(s.next(30_000)?.key).toBe(open.key);
    s.start(open.key, 30_000);
    s.finish(open.key, 30_010);
    expect(s.next(10_000_000)?.key).toBe(open.key);
    s.start(open.key, 10_000_000);
    expect(s.next(10_000_000)).toBe(null);
  });

  test("rejected watch falls back to 60 s", () => {
    const s = createSchedule();
    const closed = counts("/r/alpha-wt/detached", { wakeOn: ["/r/alpha/.git"] });
    const lst = list("/r/alpha/.git", { wakeOn: ["/r/alpha/.git"] });
    const other = list("/r/beta/.git", { wakeOn: ["/r/beta/.git"] });
    s.setTargets([closed, lst, other], 0);
    for (const t of [closed, lst, other]) {
      s.start(t.key, 0);
      s.finish(t.key, 10);
    }
    s.rejected("/r/alpha/.git", 20);
    expect(s.next(59_999)).toBe(null);
    expect(s.wakeIn(0)).toBe(60_000);
    expect(s.next(60_000)?.key).toBe(lst.key);
    s.start(lst.key, 60_000);
    expect(s.next(60_000)).toBe(null);
    s.finish(lst.key, 60_010);
    expect(s.next(60_010)?.key).toBe(closed.key);

    const due = [];
    for (let t; (t = s.next(10_000_000)); ) {
      due.push(t.key);
      s.start(t.key, 10_000_000);
      s.finish(t.key, 10_000_000);
    }
    expect(due).toEqual([lst.key, closed.key]);
  });

  test("an open worktree with a rejected watch keeps the 30 s backstop", () => {
    const s = createSchedule();
    const open = counts("/r/alpha", { open: true, wakeOn: ["/r/alpha"] });
    s.setTargets([open], 0);
    s.start(open.key, 0);
    s.finish(open.key, 10);
    s.rejected("/r/alpha", 20);
    expect(s.wakeIn(0)).toBe(30_000);
  });

  test("remote every 15 s; selected remote every 1.5 s start to start", () => {
    const s = createSchedule();
    const plain = counts("/home/u/gamma-wt/x", { machine: "macmini" });
    const sel = counts("/home/u/gamma", { machine: "box", open: true, selected: true });
    s.setTargets([plain, sel], 0);
    s.start(plain.key, 0);
    s.start(sel.key, 0);
    s.finish(plain.key, 400);
    s.finish(sel.key, 900);
    expect(s.next(1499)).toBe(null);
    expect(s.wakeIn(900)).toBe(600);
    expect(s.next(1500)?.key).toBe(sel.key);
    s.start(sel.key, 1500);
    s.finish(sel.key, 1600);
    expect(s.next(14_999)?.key).toBe(sel.key);
    s.start(sel.key, 14_999);
    expect(s.next(14_999)).toBe(null);
    expect(s.next(15_000)?.key).toBe(plain.key);
  });

  test("remote targets ignore wakeOn and are never watched", () => {
    const s = createSchedule();
    s.setTargets([counts("/home/u/gamma", { machine: "macmini", wakeOn: ["/home/u/gamma"] })], 0);
    expect(s.watchedFolders()).toEqual([]);
  });

  test("event during a call reruns it after finish", () => {
    const s = createSchedule();
    const t = counts("/r/alpha", { wakeOn: ["/r/alpha"] });
    const K = t.key;
    s.setTargets([t], 0);
    s.start(K, 0);
    s.event("/r/alpha", ["/r/alpha/a.txt"], 200);
    expect(s.next(300)).toBe(null);
    s.finish(K, 400);
    expect(s.next(999)).toBe(null);
    expect(s.next(1000)?.key).toBe(K);
  });

  test("an event during a slow call reruns it as soon as it finishes", () => {
    const s = createSchedule();
    const t = counts("/r/alpha", { wakeOn: ["/r/alpha"] });
    s.setTargets([t], 0);
    s.start(t.key, 0);
    s.event("/r/alpha", ["/r/alpha/a.txt"], 1200);
    expect(s.next(1300)).toBe(null);
    s.finish(t.key, 1500);
    expect(s.next(1500)?.key).toBe(t.key);
  });

  test("one call in flight per machine, selected first", () => {
    const s = createSchedule();
    const m = { machine: "macmini" };
    const helper = target("helper", "", m);
    const closed = counts("/home/u/gamma-wt/b", m);
    const lst = list("/home/u/gamma/.git", m);
    const open = counts("/home/u/gamma-wt/a", { ...m, open: true });
    const sel = counts("/home/u/gamma", { ...m, open: true, selected: true });
    const place = target("place", "/home/u/elsewhere", m);
    const local = counts("/r/alpha", { open: true, wakeOn: ["/r/alpha"] });
    s.setTargets([helper, closed, lst, open, sel, place, local], 0);
    s.start(local.key, 0);

    const order = [];
    for (let now = 0; order.length < 6; now += 10) {
      const t = s.next(now);
      expect(t).not.toBe(null);
      order.push(t.key);
      s.start(t.key, now);
      expect(s.inFlight("macmini")).toBe(true);
      expect(s.next(now)).toBe(null);
      // Targets behind a running call wake when it finishes; a 0 here would spin the driver.
      expect(s.wakeIn(now)).toBe(null);
      s.finish(t.key, now + 5);
    }
    expect(order).toEqual([place, sel, open, lst, closed, helper].map((t) => t.key));
    expect(s.inFlight(null)).toBe(true);
  });

  test("a folder inside a watched one is dropped unless it is a worktree's own", () => {
    const s = createSchedule();
    const main = counts("/r/alpha", { open: true, wakeOn: ["/r/alpha", "/r/alpha/.git"] });
    const nested = counts("/r/alpha/.worktrees/nested", { open: true, wakeOn: ["/r/alpha/.worktrees/nested/"] });
    const feat = counts("/r/alpha-wt/feat", { open: true, wakeOn: ["/r/alpha-wt/feat", "/r/alpha/.git"] });
    const lst = list("/r/alpha/.git", { wakeOn: ["/r/alpha/.git"] });
    const closed = counts("/r/alpha/.worktrees/closed", { wakeOn: ["/r/alpha/.git"] });
    s.setTargets([nested, main, feat, lst, closed], 0);
    expect(s.watchedFolders()).toEqual(["/r/alpha/.worktrees/nested", "/r/alpha", "/r/alpha-wt/feat"]);
    s.setTargets([nested, main, feat], 0);

    for (const t of [main, nested, feat]) {
      s.start(t.key, 0);
      s.finish(t.key, 10);
    }
    s.event("/r/alpha", ["/r/alpha/.worktrees/nested/src/x.js"], 5000);
    const due = [];
    for (let t; (t = s.next(5000)); ) {
      due.push(t.key);
      s.start(t.key, 5000);
      s.finish(t.key, 5000);
    }
    expect(due.sort()).toEqual([main.key, nested.key].sort());

    s.event("/r/alpha", ["/r/alpha"], 10_000);
    const all = [];
    for (let t; (t = s.next(10_000)); ) {
      all.push(t.key);
      s.start(t.key, 10_000);
      s.finish(t.key, 10_000);
    }
    expect(all.sort()).toEqual([main.key, nested.key, feat.key].sort());
  });

  test("an ignored nested worktree refreshes from its own watch (Linux skips it in the parent's)", () => {
    const s = createSchedule();
    const main = counts("/r/alpha", { open: true, wakeOn: ["/r/alpha", "/r/alpha/.git"] });
    const nested = counts("/r/alpha/.worktrees/nested", { open: true, selected: true, wakeOn: ["/r/alpha/.worktrees/nested", "/r/alpha/.git"] });
    s.setTargets([main, nested], 0);
    for (const t of [nested, main]) {
      s.start(t.key, 0);
      s.finish(t.key, 1);
    }
    expect(s.watchedFolders()).toEqual(["/r/alpha", "/r/alpha/.worktrees/nested"]);
    s.event("/r/alpha/.worktrees/nested", ["/r/alpha/.worktrees/nested/notes.txt"], 5000);
    expect(s.next(5000)?.key).toBe(nested.key);
    s.start(nested.key, 5000);
    expect(s.next(5000)).toBe(null);
  });

  test("dropped target stops", () => {
    const s = createSchedule();
    const a = counts("/r/alpha", { open: true, wakeOn: ["/r/alpha"] });
    const b = counts("/home/u/gamma", { machine: "macmini" });
    s.setTargets([a, b], 0);
    s.start(a.key, 0);
    s.start(b.key, 0);
    s.setTargets([], 10);
    expect(s.watchedFolders()).toEqual([]);
    s.finish(a.key, 20);
    s.finish(b.key, 20);
    expect(s.next(10_000_000)).toBe(null);
    expect(s.wakeIn(10_000_000)).toBe(null);
  });

  test("a target re-added while its old call runs waits for that call", () => {
    const s = createSchedule();
    const b = counts("/home/u/gamma", { machine: "macmini" });
    s.setTargets([b], 0);
    s.start(b.key, 0);
    s.setTargets([], 10);
    s.setTargets([b], 20);
    expect(s.inFlight("macmini")).toBe(true);
    expect(s.next(20)).toBe(null);
    s.finish(b.key, 30);
    expect(s.next(30)?.key).toBe(b.key);
  });

  test("setTargets reports whether anything changed", () => {
    const s = createSchedule();
    const a = counts("/home/u/gamma", { machine: "macmini" });
    expect(s.setTargets([a], 0)).toBe(true);
    expect(s.setTargets([{ ...a, wakeOn: [...a.wakeOn] }], 1)).toBe(false);
    expect(s.setTargets([{ ...a, selected: true }], 2)).toBe(true);
    expect(s.setTargets([], 3)).toBe(true);
    expect(s.setTargets([], 4)).toBe(false);
  });

  test("a target becoming selected keeps its last start", () => {
    const s = createSchedule();
    const a = counts("/home/u/gamma", { machine: "macmini" });
    s.setTargets([a], 0);
    s.start(a.key, 0);
    s.finish(a.key, 100);
    s.setTargets([{ ...a, selected: true }], 1000);
    expect(s.next(1499)).toBe(null);
    expect(s.next(1500)?.key).toBe(a.key);
  });
});
