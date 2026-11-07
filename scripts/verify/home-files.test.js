// requests.sh --machine runs only on a temporary hc machine, and home-files.sh puts back only the files a run
// created or changed under that machine's HOME.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_FILES = join(import.meta.dir, "home-files.sh");
const REQUESTS = join(import.meta.dir, "requests.sh");
const PATHS = [".claude", ".codex", ".local/share/bellwether/hooks"];

/** @param {string[]} args */
function homeFiles(args) {
  // Run the way requests.sh runs it on the other machine: its text as sh -c.
  const p = Bun.spawnSync(["sh", "-c", readFileSync(HOME_FILES, "utf8"), "sh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

/** @type {string[]} */
const made = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "bw-home-files-"));
  made.push(base);
  const home = join(base, "home");
  const saved = join(base, "saved");
  mkdirSync(home);
  return { base, home, saved };
}

describe("home-files.sh", () => {
  test("restore puts back changed and removed files, deletes new ones, and leaves unchanged files alone", () => {
    const { home, saved } = scratch();
    put(home, { ".codex/config.toml": "model = 1\n", ".codex/sessions/old.jsonl": "{}\n", ".claude/settings.json": "{}\n", "keep.txt": "mine\n" });
    const before = homeFiles(["sums", home, ...PATHS]);
    expect(before.code).toBe(0);
    expect(homeFiles(["save", home, saved, ...PATHS]).code).toBe(0);
    const untouched = statSync(join(home, ".codex/sessions/old.jsonl")).ino;

    put(home, { ".codex/config.toml": "model = 2\n", ".codex/auth.json": "secret\n", ".codex/sessions/2026/11/07/new.jsonl": "{}\n",
      ".local/share/bellwether/hooks/bw-event": "#!/bin/sh\n", "outside.txt": "not ours\n" });
    Bun.spawnSync(["rm", join(home, ".claude/settings.json")]);
    const r = homeFiles(["restore", home, saved, ...PATHS]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);

    expect(homeFiles(["sums", home, ...PATHS]).out).toBe(before.out);
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe("model = 1\n");
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(home, ".codex/auth.json"))).toBe(false);
    // Folders the run made go; a folder that was there stays.
    expect(existsSync(join(home, ".codex/sessions/2026"))).toBe(false);
    expect(existsSync(join(home, ".local/share/bellwether/hooks"))).toBe(false);
    expect(existsSync(join(home, ".codex/sessions"))).toBe(true);
    // The unchanged file is the same file, not a copy put back over it.
    expect(statSync(join(home, ".codex/sessions/old.jsonl")).ino).toBe(untouched);
    expect(readFileSync(join(home, "keep.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(home, "outside.txt"), "utf8")).toBe("not ours\n");
  });

  test("a path absent before the run is gone after restore", () => {
    const { home, saved } = scratch();
    expect(homeFiles(["save", home, saved, ...PATHS]).code).toBe(0);
    put(home, { ".codex/hooks.json": "{}\n", ".claude/settings.json": "{}\n" });
    expect(homeFiles(["restore", home, saved, ...PATHS]).code).toBe(0);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("a folder the run made that still holds something it cannot remove fails restore", () => {
    const { base, home, saved } = scratch();
    expect(homeFiles(["save", home, saved, ...PATHS]).code).toBe(0);
    mkdirSync(join(home, ".codex"), { recursive: true });
    Bun.spawnSync(["ln", "-s", join(base, "elsewhere"), join(home, ".codex/link")]);
    const r = homeFiles(["restore", home, saved, ...PATHS]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(".codex");
  });
});

/** A fake hc that logs its argv and answers `machine ls --json` with `machines`. @param {object[] | null} machines */
function fakeHc(machines) {
  const { base } = scratch();
  const log = join(base, "hc.log");
  const hc = join(base, "hc");
  const answer = machines === null ? "exit 1" : `printf '%s\\n' '${JSON.stringify({ machines })}'`;
  writeFileSync(hc, `#!/bin/sh\necho "$*" >> '${log}'\n[ "$*" = "machine ls --json" ] || exit 9\n${answer}\n`);
  chmodSync(hc, 0o755);
  return { hc, log };
}

describe("requests.sh --machine", () => {
  const MACHINES = [
    { name: "bwloop", temporary: true, state: "connected" },
    { name: "macmini", temporary: false, state: "connected" },
  ];
  for (const [name, machines] of /** @type {[string, object[] | null][]} */ ([["macmini", MACHINES], ["nosuch", MACHINES], ["bwloop", null]])) {
    test(`refuses ${name} when hc does not mark it temporary, before touching it`, () => {
      const { hc, log } = fakeHc(machines);
      // Should the check let it through, the run stops at cargo (a scratch HOME with no toolchain), not in the user's files.
      const { home } = scratch();
      const env = { ...process.env, HOME: home, RUSTUP_HOME: join(home, ".rustup"), RUSTUP_AUTO_INSTALL: "0", BW_HC: hc };
      const p = Bun.spawnSync(["sh", REQUESTS, "--machine", name], { env, stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("temporary");
      expect(readFileSync(log, "utf8")).toBe("machine ls --json\n");
    });
  }

  test("lets a temporary machine through to the build", () => {
    const { hc, log } = fakeHc(MACHINES);
    const { home } = scratch();
    const env = { ...process.env, HOME: home, RUSTUP_HOME: join(home, ".rustup"), RUSTUP_AUTO_INSTALL: "0", BW_HC: hc };
    const p = Bun.spawnSync(["sh", REQUESTS, "--machine", "bwloop"], { env, stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toContain("FAIL setup: cargo build");
    expect(readFileSync(log, "utf8")).toBe("machine ls --json\n");
  });
});
