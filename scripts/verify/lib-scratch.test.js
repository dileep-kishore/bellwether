import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = join(import.meta.dir, "lib-scratch.sh");

// Runs one lib-scratch function in sh; root replaces /private/tmp so a broken guard deletes only test folders.
function sh(fn, dir, root) {
  const set = root === undefined ? "" : "scratch_root=$3; ";
  const p = Bun.spawnSync(["sh", "-c", `. "$1"; ${set}${fn} "$2"`, "sh", LIB, dir, root ?? ""], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "bw-scratch-"));
  const root = join(base, "root");
  mkdirSync(root);
  return { base, root };
}

describe("scratch_path", () => {
  test("refuses /private/tmp/ itself", () => {
    for (const d of ["/private/tmp/", "/private/tmp", "/private/tmp//", "/private/tmp/."]) {
      expect(sh("scratch_path", d).code).not.toBe(0);
    }
  });

  test("refuses a path with a .. component, even one that resolves inside the root", () => {
    const { root } = scratch();
    mkdirSync(join(root, "a"));
    expect(sh("scratch_path", "/private/tmp/../../Users/someone/important").code).not.toBe(0);
    expect(sh("scratch_path", `${root}/a/../b`, root).code).not.toBe(0);
  });

  test("refuses the root with a trailing slash, a relative path and a sibling with the root as prefix", () => {
    const { base, root } = scratch();
    expect(sh("scratch_path", `${root}/`, root).code).not.toBe(0);
    expect(sh("scratch_path", "relative/dir", root).code).not.toBe(0);
    mkdirSync(`${root}x`);
    expect(sh("scratch_path", `${root}x/d`, root).code).not.toBe(0);
    expect(sh("scratch_path", join(base, "elsewhere"), root).code).not.toBe(0);
  });

  test("refuses a descendant reached through a symlink out of the root", () => {
    const { base, root } = scratch();
    mkdirSync(join(base, "outside"));
    Bun.spawnSync(["ln", "-s", join(base, "outside"), join(root, "link")]);
    expect(sh("scratch_path", `${root}/link/d`, root).code).not.toBe(0);
    expect(sh("scratch_path", `${root}/link`, root).code).not.toBe(0);
  });

  test("prints a strict descendant resolved", () => {
    const { root } = scratch();
    mkdirSync(join(root, "a"));
    const r = sh("scratch_path", `${root}/a/d/`, root);
    expect(r.code).toBe(0);
    expect(r.out.endsWith("/root/a/d")).toBe(true);
  });
});

describe("scratch_make and scratch_rm", () => {
  test("refuses to delete a folder without the marker", () => {
    const { root } = scratch();
    const d = join(root, "unmarked");
    mkdirSync(d);
    writeFileSync(join(d, "keep"), "x");
    const r = sh("scratch_rm", d, root);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(".bw-scratch");
    expect(existsSync(join(d, "keep"))).toBe(true);
  });

  test("refuses a .. path that climbs out of the root and leaves its target", () => {
    const { base, root } = scratch();
    const victim = join(base, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, ".bw-scratch"), "");
    expect(sh("scratch_rm", `${root}/../victim`, root).code).not.toBe(0);
    expect(existsSync(victim)).toBe(true);
  });

  test("makes a marked folder, refuses to make it twice, then deletes it", () => {
    const { root } = scratch();
    const d = join(root, "made");
    expect(sh("scratch_make", d, root).code).toBe(0);
    expect(existsSync(join(d, ".bw-scratch"))).toBe(true);
    expect(sh("scratch_make", d, root).code).not.toBe(0);
    const r = sh("scratch_rm", d, root);
    expect(r.code).toBe(0);
    expect(existsSync(d)).toBe(false);
  });

  test("treats a missing folder as already deleted", () => {
    const { root } = scratch();
    expect(sh("scratch_rm", join(root, "never"), root).code).toBe(0);
  });
});

describe("scratch_procs and scratch_rm_idle", () => {
  /** Each test's background processes, killed afterwards. @type {import("bun").Subprocess[]} */
  const procs = [];
  const stop = () => {
    for (const p of procs.splice(0)) {
      // The process-group test's leader forks a sleep that outlives a kill of the leader alone.
      try {
        process.kill(-p.pid, 9);
      } catch {}
      p.kill(9);
    }
  };
  afterEach(stop);
  const made = () => {
    const { root } = scratch();
    const d = join(root, "made");
    expect(sh("scratch_make", d, root).code).toBe(0);
    return { root, d };
  };
  /** @param {string[]} argv @param {string} [cwd] */
  const start = (argv, cwd) => {
    const p = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "ignore" });
    procs.push(p);
    return p.pid;
  };
  /** Runs fn with dir and extra pids as arguments; the calling shell's own argv names dir. */
  const run = (fn, dir, root, pids = []) => {
    const p = Bun.spawnSync(
      ["sh", "-c", `. "$1"; scratch_root=$2; shift 2; ${fn} "$@"`, "sh", LIB, root, dir, ...pids.map(String)],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
  };
  const wait = () => Bun.sleepSync(300);

  test("an idle folder lists nothing, though the calling shell's argv names it", () => {
    const { root, d } = made();
    const r = run("scratch_procs", d, root);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  test("lists a process whose cwd is inside the folder", () => {
    const { root, d } = made();
    mkdirSync(join(d, "sub"));
    const pid = start(["sleep", "30"], join(d, "sub"));
    wait();
    expect(run("scratch_procs", d, root).out.split("\n")).toContain(String(pid));
  });

  test("lists a process whose command line names a path inside the folder", () => {
    const { root, d } = made();
    const pid = start(["perl", "-e", "sleep 30", "--", `--user-data-dir=${d}/profile`]);
    wait();
    expect(run("scratch_procs", d, root).out.split("\n")).toContain(String(pid));
  });

  test("lists a recorded pid that still runs, and a member of its process group", () => {
    const { root, d } = made();
    const leader = start(["perl", "-e", "setpgrp(0, 0); my $c = fork(); if (!$c) { exec 'sleep', '30' } sleep 30"]);
    wait();
    const out = run("scratch_procs", d, root, [leader, 999999]).out.split("\n");
    expect(out).toContain(String(leader));
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain("999999");
  });

  test("scratch_rm_idle keeps a folder in use, names the pids and the path, then deletes it once idle", () => {
    const { root, d } = made();
    writeFileSync(join(d, "chrome.err"), "diagnostics");
    const pid = start(["sleep", "30"], d);
    wait();
    const kept = run("scratch_rm_idle", d, root);
    expect(kept.code).not.toBe(0);
    expect(kept.err).toContain("FAIL");
    expect(kept.err).toContain(String(pid));
    expect(kept.err).toContain(d);
    expect(existsSync(join(d, "chrome.err"))).toBe(true);
    stop();
    wait();
    expect(run("scratch_rm_idle", d, root).code).toBe(0);
    expect(existsSync(d)).toBe(false);
  });

  test("scratch_rm_idle still refuses an unmarked folder and passes a missing one", () => {
    const { root } = scratch();
    const d = join(root, "unmarked");
    mkdirSync(d);
    expect(run("scratch_rm_idle", d, root).code).not.toBe(0);
    expect(existsSync(d)).toBe(true);
    expect(run("scratch_rm_idle", join(root, "never"), root).code).toBe(0);
  });
});
