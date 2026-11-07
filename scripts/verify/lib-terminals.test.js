import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const LIB = join(import.meta.dir, "lib-terminals.sh");

/** Runs one lib-terminals function in sh with args, hc ls --all --json from `stdin`. */
function sh(fn, args, stdin = "") {
  const p = Bun.spawnSync(["sh", "-c", `. "$1"; shift; ${fn} "$@"`, "sh", LIB, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}
/** @param {[string, string, string?][]} rows address, name, state */
const ls = (rows) =>
  JSON.stringify({ terminals: rows.map(([address, name, state = "live"]) => ({ address, name, state, argv: ["x"] })) });

describe("bw_slug and run_names", () => {
  test("names the forward and the warm as bw does", () => {
    // The values crates/bw/src/browser/forward.rs pins in slug_and_terminal_names_fit_32 and the forward tests.
    expect(sh("bw_slug", ["macmini"]).out).toBe("macmini-c27a57");
    expect(sh("bw_slug", ["mac2"]).out).toBe("mac2-a9deae");
    expect(sh("bw_slug", ["Mac Mini.local"]).out).toBe("mac-mini-local-ba0f9a");
    expect(sh("bw_slug", [""]).out).toBe("machine-222325");
    expect(sh("bw_slug", ["a".repeat(40)]).out).toMatch(/^a{18}-[0-9a-f]{6}$/);
    expect(sh("run_names", ["macmini"]).out.split("\n")).toEqual(["bw-fwd-macmini-c27a57", "bw-warm-macmini-c27a57"]);
    // hc names hold at most 32 characters, so bw cuts the warm's name.
    const [fwd, warm] = sh("run_names", ["b".repeat(30)]).out.split("\n");
    expect(fwd).toMatch(/^bw-fwd-b{18}-[0-9a-f]{6}$/);
    expect(warm).toBe(`bw-warm-${fwd.slice("bw-fwd-".length)}`.slice(0, 32));
  });
});

describe("sort_new", () => {
  test("only the run's own machine's terminals are its own; other new bw- terminals are left alone", () => {
    const before = ls([
      ["a5", "bw-fwd-old"],
      ["a9", "bw-warm-gone", "dead"],
    ]);
    const now = ls([
      ["a1", "bwv-codex-r1"],
      ["a2", "bw-fwd-bwloop"],
      ["a3", "bw-fwd-macmini"],
      ["a4", "bw-warm-tsuki"],
      ["a5", "bw-fwd-old"],
      ["a6", "bw-warm-bwloop"],
      ["a7", "bw-warm-bwloop", "dead"],
      ["a8", "notes"],
    ]);
    const r = sh("sort_new", [before, "bw-fwd-bwloop", "bw-warm-bwloop"], now);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "own a2 bw-fwd-bwloop",
      "other a3 bw-fwd-macmini",
      "other a4 bw-warm-tsuki",
      "own a6 bw-warm-bwloop",
    ]);
  });

  test("a name that was live at the start is never the run's", () => {
    const before = ls([["a2", "bw-fwd-bwloop"]]);
    const now = ls([
      ["a2", "bw-fwd-bwloop"],
      ["b2", "bw-fwd-bwloop"],
    ]);
    expect(sh("sort_new", [before, "bw-fwd-bwloop"], now).out).toBe("other b2 bw-fwd-bwloop");
  });

  test("an unreadable start list claims nothing", () => {
    const now = ls([["a2", "bw-fwd-bwloop"]]);
    expect(sh("sort_new", ["", "bw-fwd-bwloop"], now).out).toBe("other a2 bw-fwd-bwloop");
    expect(sh("sort_new", ["not json", "bw-fwd-bwloop"], now).out).toBe("other a2 bw-fwd-bwloop");
  });
});
