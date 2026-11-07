import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COUNTS_SCRIPT, readCounts, readPlace, readWorktrees } from "./git.js";

const MAKE_REPOS = join(import.meta.dir, "../scripts/verify/make-repos.sh");

/** Herdr's `exec` on this machine; records each call so tests can check its argv and options. */
const calls = [];
async function exec(cmd, args, opts) {
  calls.push({ cmd, args, opts });
  const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
const offline = async () => {
  throw new Error("machine macmini is unreachable");
};

let scratch, root, alphaCommon;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bw-git-"));
  const made = Bun.spawnSync(["sh", MAKE_REPOS, join(scratch, "repos")], { stderr: "pipe" });
  if (made.exitCode !== 0) throw new Error(`make-repos.sh failed: ${made.stderr}`);
  const lines = Object.fromEntries(made.stdout.toString().trim().split("\n").map((l) => l.split("\t")));
  root = realpathSync(join(scratch, "repos"));
  alphaCommon = lines.alpha;
  expect(lines).toEqual({ alpha: `${root}/alpha/.git`, beta: `${root}/beta/.git` });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("real worktree list equals what make-repos made", async () => {
  const r = await readWorktrees(exec, null, alphaCommon);
  expect(r.ok).toBe(true);
  expect(r.worktrees.map((w) => [w.path, w.branch, w.detached])).toEqual([
    [`${root}/alpha`, "main", false],
    [`${root}/alpha-wt/detached`, null, true],
    [`${root}/alpha-wt/feat`, "feat", false],
    [`${root}/alpha/.worktrees/nested`, "nested", false],
  ]);
});

test("place resolves /tmp spelling to git's top", async () => {
  mkdirSync(`${root}/alpha-wt/feat/sub`, { recursive: true });
  // macOS spells the temp folder without /private; elsewhere a symlink gives the second spelling.
  let alias = root.startsWith("/private/") ? root.slice("/private".length) : null;
  if (!alias || !existsSync(alias) || realpathSync(alias) !== root) {
    alias = join(scratch, "link");
    symlinkSync(root, alias);
  }
  expect(alias).not.toBe(root);
  const r = await readPlace(exec, null, `${alias}/alpha-wt/feat/sub/`);
  expect(r).toEqual({ ok: true, place: { commonDir: alphaCommon, top: `${root}/alpha-wt/feat` } });
  const nested = await readPlace(exec, null, `${alias}/alpha/.worktrees/nested`);
  expect(nested).toEqual({ ok: true, place: { commonDir: alphaCommon, top: `${root}/alpha/.worktrees/nested` } });
});

test("counts for the edited worktree: +3 −1", async () =>
  expect(await readCounts(exec, null, `${root}/alpha-wt/feat`)).toEqual({
    ok: true,
    counts: { branch: "feat", detached: false, upstream: true, ahead: 1, behind: 0, files: 1, added: 3, removed: 1 },
  }));

test("counts for the main checkout: one commit ahead, clean", async () =>
  expect(await readCounts(exec, null, `${root}/alpha`)).toEqual({
    ok: true,
    counts: { branch: "main", detached: false, upstream: true, ahead: 1, behind: 0, files: 0, added: 0, removed: 0 },
  }));

test("counts for an unborn repository: zero lines, no failure", async () =>
  expect(await readCounts(exec, null, `${root}/gamma`)).toEqual({
    ok: true,
    counts: { branch: "main", detached: false, upstream: false, ahead: 0, behind: 0, files: 0, added: 0, removed: 0 },
  }));

test("removed folder is missing", async () => {
  const r = await readCounts(exec, null, `${root}/alpha-wt/gone`);
  expect(r).toMatchObject({ ok: false, state: "missing" });
});

test("non-repo folder is not_git", async () => {
  const plain = join(scratch, "plain");
  mkdirSync(plain);
  const r = await readPlace(exec, null, plain);
  expect(r.ok).toBe(false);
  expect(r.state).toBe("not_git");
  expect(r.message).toMatch(/not a git repository/i);
});

test("rejected exec is unreachable", async () => {
  for (const r of [await readPlace(offline, "macmini", "/r/alpha"), await readWorktrees(offline, "macmini", "/r/alpha/.git"), await readCounts(offline, "macmini", "/r/alpha")]) {
    expect(r).toEqual({ ok: false, state: "unreachable", message: "machine macmini is unreachable" });
  }
});

test("a git failure is failed, with git's message", async () => {
  const plain = join(scratch, "plain2");
  mkdirSync(plain);
  const list = await readWorktrees(exec, null, plain);
  expect(list).toMatchObject({ ok: false, state: "not_git" });
  const counts = await readCounts(exec, null, plain);
  expect(counts.ok).toBe(false);
  expect(counts.state).toBe("failed");
  expect(counts.message).toMatch(/not a git repository/i);
});

test("every call names its machine, never uses cwd, and carries the read-only flags", async () => {
  const seen = [];
  const record = async (cmd, args, opts) => {
    seen.push({ cmd, args, opts });
    return { code: 0, stdout: "", stderr: "" };
  };
  await readPlace(record, "macmini", "/home/u/gamma");
  await readWorktrees(record, "macmini", "/home/u/gamma/.git");
  await readCounts(record, "macmini", "/home/u/gamma");
  expect(seen.map((c) => c.opts)).toEqual([{ on: "macmini" }, { on: "macmini" }, { on: "macmini" }]);
  expect(seen[0]).toEqual({
    cmd: "git",
    args: ["-C", "/home/u/gamma", "--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    opts: { on: "macmini" },
  });
  expect(seen[1].args).toEqual(["--git-dir", "/home/u/gamma/.git", "--no-optional-locks", "-c", "core.fsmonitor=false", "worktree", "list", "--porcelain", "-z"]);
  // The path reaches the script only as $1.
  expect(seen[2]).toEqual({ cmd: "sh", args: ["-c", COUNTS_SCRIPT, "sh", "/home/u/gamma"], opts: { on: "macmini" } });
  for (const git of COUNTS_SCRIPT.split("\n").filter((l) => /\bgit\b/.test(l))) {
    expect(git).toContain("--no-optional-locks -c core.fsmonitor=false");
    if (/ diff/.test(git)) expect(git).toContain("--no-textconv --no-ext-diff");
  }
  expect(calls.every((c) => !("cwd" in c.opts))).toBe(true);
});

/** Every path under dir with its mtime and size, so a write anywhere shows. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = lstatSync(p);
      out[p] = `${s.mtimeMs}:${s.size}`;
      if (s.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

test("no call writes under the common dir", async () => {
  // A stat-dirty index is what a plain `git status` would rewrite.
  for (const wt of ["alpha", "alpha-wt/feat", "alpha-wt/detached", "alpha/.worktrees/nested"]) {
    const f = `${root}/${wt}/README.md`;
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
  }
  appendFileSync(`${root}/alpha-wt/feat/notes.txt`, "");
  const before = snapshot(alphaCommon);
  for (const wt of [`${root}/alpha`, `${root}/alpha-wt/feat`, `${root}/alpha-wt/detached`, `${root}/alpha/.worktrees/nested`]) {
    expect((await readPlace(exec, null, wt)).ok).toBe(true);
    expect((await readCounts(exec, null, wt)).ok).toBe(true);
  }
  expect((await readWorktrees(exec, null, alphaCommon)).ok).toBe(true);
  expect(snapshot(alphaCommon)).toEqual(before);

  // Control: without the flags the same status does write, so the check above can fail.
  await exec("git", ["-C", `${root}/alpha`, "status", "--porcelain"], { on: null });
  expect(snapshot(alphaCommon)).not.toEqual(before);
});
