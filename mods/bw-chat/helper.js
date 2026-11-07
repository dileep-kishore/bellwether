// Runs the `bw` helper on the machine a space lives on. Imports nothing, so mods copy it and `bun test` runs it.

export const PROTOCOL = 2;
export const HELPER_VERSION = "0.2.0";
// Arguments reach bw as "$@", never through the shell's parser.
export const HELPER_SCRIPT = 'exec "$HOME"/.local/share/bellwether/helper/current/bw "$@"';

const CACHE_MS = 60_000;

/**
 * @typedef {object} ExecResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(cmd: string, args: string[], opts: { on: string | null }) => Promise<ExecResult>} Exec
 * Herdr's `exec`: rejects when the machine cannot be reached.
 */

/**
 * @typedef {"unreachable" | "missing" | "outdated" | "installing" | "failed" | "bad_output"} FailState
 */

/**
 * @typedef {object} Failure
 * @property {false} ok
 * @property {FailState} state
 * @property {string} message
 */

/**
 * @typedef {object} Ready
 * @property {true} ok
 * @property {"current"} state
 * @property {string} message
 */

/**
 * @typedef {object} Output
 * @property {true} ok
 * @property {object[]} lines
 */

/**
 * @typedef {object} Helper
 * @property {(machine: string | null, args: string[], opts?: { install?: boolean }) => Promise<Output | Failure>} call
 * @property {(machine: string | null, opts?: { install?: boolean }) => Promise<Ready | Failure>} ensure
 */

/**
 * Parses bw's JSON-lines output.
 *
 * @param {string} stdout
 * @returns {object[]}
 * @throws {Error} naming the line number only, since a line can hold transcript text.
 */
export function parseLines(stdout) {
  const out = [];
  stdout.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`line ${i + 1} is not a JSON object`);
    }
    out.push(value);
  });
  return out;
}

/**
 * @param {{ exec: Exec, localInstall: (machine: string) => Promise<object[]>, now?: () => number }} deps
 *   `localInstall` runs this Mac's `bw machine install <machine>` and resolves its parsed lines.
 * @returns {Helper}
 */
export function createHelper({ exec, localInstall, now = Date.now }) {
  /** @type {Map<string | null, { at: number, result: Ready | Failure }>} */
  const remembered = new Map();
  /** @type {Map<string | null, Promise<Ready | Failure>>} */
  const checking = new Map();
  /** @type {Map<string | null, Promise<Ready | Failure>>} */
  const installing = new Map();

  const where = (machine) => (machine == null ? "this machine" : machine);
  const hint = (machine) => (machine == null ? ": run scripts/install-helper.sh" : "");
  /** @returns {Failure} */
  const fail = (state, message) => ({ ok: false, state, message });

  /** @returns {Promise<Output | Failure>} */
  async function run(machine, args) {
    let r;
    try {
      r = await exec("sh", ["-c", HELPER_SCRIPT, "bw", ...args], { on: machine });
    } catch (e) {
      return fail("unreachable", e instanceof Error ? e.message : String(e));
    }
    // bw reports its own errors as JSON on stdout, so a bare "No such file" on stderr is the shell's.
    if (r.code === 127 || (r.code !== 0 && !r.stdout.trim() && r.stderr.includes("No such file"))) {
      return fail("missing", `bw is not installed on ${where(machine)}${hint(machine)}`);
    }
    let lines;
    try {
      lines = parseLines(r.stdout);
    } catch (e) {
      return fail("bad_output", e.message);
    }
    const err = lines.find((l) => l.type === "error");
    if (err) return fail("failed", String(err.message ?? err.code ?? "bw reported an error"));
    if (r.code !== 0) return fail("failed", `bw exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return { ok: true, lines };
  }

  /** @returns {Promise<Ready | Failure>} */
  async function check(machine) {
    const r = await run(machine, ["version"]);
    if (!r.ok) return r;
    const v = r.lines.find((l) => "protocol" in l && "version" in l);
    if (!v) return fail("bad_output", `bw version on ${where(machine)} printed no protocol and version`);
    if (v.protocol !== PROTOCOL || v.version !== HELPER_VERSION) {
      return fail(
        "outdated",
        `bw on ${where(machine)} is protocol ${v.protocol} version ${v.version}; ` +
          `this window needs protocol ${PROTOCOL} version ${HELPER_VERSION}${hint(machine)}`,
      );
    }
    return { ok: true, state: "current", message: "" };
  }

  function once(map, machine, start) {
    let p = map.get(machine);
    if (!p) {
      p = start().finally(() => map.delete(machine));
      map.set(machine, p);
    }
    return p;
  }

  function remember(machine, result) {
    remembered.set(machine, { at: now(), result });
    return result;
  }

  /** @returns {Promise<Ready | Failure>} */
  async function installAndCheck(machine) {
    let lines;
    try {
      lines = await localInstall(machine);
    } catch (e) {
      return remember(machine, fail("failed", `install on ${machine} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const err = lines.find((l) => l?.type === "error");
    if (err) return remember(machine, fail("failed", String(err.message ?? err.code ?? "install failed")));
    const after = await check(machine);
    if (after.ok) return remember(machine, after);
    if (after.state === "missing" || after.state === "outdated") {
      return remember(machine, fail("failed", `bw on ${machine} is still ${after.state} after install: ${after.message}`));
    }
    return after;
  }

  /** @type {Helper["ensure"]} */
  async function ensure(machine, { install = true } = {}) {
    const hit = remembered.get(machine);
    if (hit && now() - hit.at < CACHE_MS) return hit.result;
    remembered.delete(machine);
    const pending = installing.get(machine);
    if (pending) return install ? pending : fail("installing", `installing bw on ${machine}`);

    const r = await once(checking, machine, () => check(machine));
    if (r.ok) return remember(machine, r);
    if (machine == null || !install || (r.state !== "missing" && r.state !== "outdated")) return r;
    return once(installing, machine, () => installAndCheck(machine));
  }

  /** @type {Helper["call"]} */
  async function call(machine, args, { install = true } = {}) {
    const ready = await ensure(machine, { install });
    if (!ready.ok) return ready;
    const r = await run(machine, args);
    if (!r.ok && r.state === "missing") remembered.delete(machine);
    return r;
  }

  return { call, ensure };
}
