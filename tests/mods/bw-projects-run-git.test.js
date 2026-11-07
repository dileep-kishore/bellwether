import { describe, expect, test } from "bun:test";
import { mergeResult } from "../../mods/bw-projects/run-git.js";
import { buildProjects, refreshTargets } from "../../shared/projects-model.js";
import { createSchedule } from "../../shared/refresh-schedule.js";

describe("bw-projects run-git", () => {
  test("a space whose first place read fails joins its project on a later read", () => {
    const input = {
      machines: [
        { name: null, layout: "ready" },
        { name: "macmini", layout: "ready" },
      ],
      spaces: [{ id: "macmini/s1", machine: "macmini", folder: "/r/a", name: "a", tabs: [] }],
      panes: [],
      agents: [],
      terminals: [],
      stored: [],
      platform: "macos",
      git: { places: {}, worktrees: {}, counts: {}, unreachable: [] },
    };
    const helpers = new Map();
    const s = createSchedule();
    const sync = (now) => s.setTargets(refreshTargets(buildProjects(input), input, null), now);
    const read = (now, result) => {
      const t = s.next(now);
      expect(t?.kind).toBe("place");
      s.start(t.key, now);
      s.finish(t.key, now + 5, { ok: Boolean(result.ok) });
      mergeResult(input.git, helpers, t, result);
      sync(now + 5);
    };

    sync(0);
    read(0, { ok: false, state: "unreachable", message: "temporary" });
    const offline = buildProjects(input).machines.find((m) => m.name === "macmini");
    expect(offline?.state).toBe("offline");
    expect(offline?.plain.map((p) => p.id)).toEqual(["macmini/s1"]);
    expect(s.next(14_999)).toBe(null);

    read(15_000, { ok: true, place: { commonDir: "/r/a/.git", top: "/r/a" } });
    const ready = buildProjects(input).machines.find((m) => m.name === "macmini");
    expect(ready?.state).toBe("ready");
    expect(ready?.plain).toEqual([]);
    expect(ready?.projects.map((p) => p.commonDir)).toEqual(["/r/a/.git"]);
  });
});
