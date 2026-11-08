// Runs the `bw` helper on the machine a space lives on. Imports nothing, so mods copy it and `bun test` runs it.

export const PROTOCOL = 4;
export const HELPER_VERSION = "0.4.0";
// Arguments reach bw as "$@", never through the shell's parser. Another machine always runs its installed helper.
export const HELPER_SCRIPT = 'exec "$HOME"/.local/share/bellwether/helper/current/bw "$@"';
// This machine runs $BW_HELPER when the app was started with it (the stage window counts calls this way).
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template.
export const LOCAL_HELPER_SCRIPT = 'exec "${BW_HELPER:-$HOME/.local/share/bellwether/helper/current/bw}" "$@"';
/** Both scripts, for tests that answer any helper call. */
export const HELPER_SCRIPTS = Object.freeze([LOCAL_HELPER_SCRIPT, HELPER_SCRIPT]);

/** The script that runs bw on `machine`; null is this one. @param {string | null} machine */
export const helperScript = (machine) => (machine == null ? LOCAL_HELPER_SCRIPT : HELPER_SCRIPT);

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

// Test `r.ok === false`, not `!r.ok`: with strictNullChecks off, TypeScript narrows only the first to Failure.
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

/** One parsed line of bw's output: a JSON object. @typedef {Record<string, unknown>} Line */

/**
 * @typedef {object} Output
 * @property {true} ok
 * @property {Line[]} lines
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
 * @returns {Line[]}
 * @throws {Error} naming the line number only, since a line can hold transcript text.
 */
export function parseLines(stdout) {
  /** @type {Line[]} */
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
 * @param {{ exec: Exec, localInstall: (machine: string) => Promise<Line[]>, now?: () => number }} deps
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

  const where = (/** @type {string | null} */ machine) => (machine == null ? "this machine" : machine);
  const hint = (/** @type {string | null} */ machine) => (machine == null ? ": run scripts/install-helper.sh" : "");
  /** @param {FailState} state @param {string} message @returns {Failure} */
  const fail = (state, message) => ({ ok: false, state, message });

  /** @param {string | null} machine @param {string[]} args @returns {Promise<Output | Failure>} */
  async function run(machine, args) {
    let r;
    try {
      r = await exec("sh", ["-c", helperScript(machine), "bw", ...args], { on: machine });
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
      return fail("bad_output", e instanceof Error ? e.message : String(e));
    }
    const err = lines.find((l) => l.type === "error");
    if (err) return fail("failed", String(err.message ?? err.code ?? "bw reported an error"));
    if (r.code !== 0) return fail("failed", `bw exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return { ok: true, lines };
  }

  /** @param {string | null} machine @returns {Promise<Ready | Failure>} */
  async function check(machine) {
    const r = await run(machine, ["version"]);
    if (r.ok === false) return r;
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

  /**
   * @param {Map<string | null, Promise<Ready | Failure>>} map
   * @param {string | null} machine
   * @param {() => Promise<Ready | Failure>} start
   */
  function once(map, machine, start) {
    let p = map.get(machine);
    if (!p) {
      p = start().finally(() => map.delete(machine));
      map.set(machine, p);
    }
    return p;
  }

  /** @template {Ready | Failure} R @param {string | null} machine @param {R} result @returns {R} */
  function remember(machine, result) {
    remembered.set(machine, { at: now(), result });
    return result;
  }

  /** @param {string} machine @returns {Promise<Ready | Failure>} */
  async function installAndCheck(machine) {
    let lines;
    try {
      lines = await localInstall(machine);
    } catch (e) {
      return remember(
        machine,
        fail("failed", `install on ${machine} failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    const err = lines.find((l) => l?.type === "error");
    if (err) return remember(machine, fail("failed", String(err.message ?? err.code ?? "install failed")));
    const after = await check(machine);
    if (after.ok) return remember(machine, after);
    if (after.state === "missing" || after.state === "outdated") {
      return remember(
        machine,
        fail("failed", `bw on ${machine} is still ${after.state} after install: ${after.message}`),
      );
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
    if (ready.ok === false) return ready;
    const r = await run(machine, args);
    if (r.ok === false && r.state === "missing") remembered.delete(machine);
    return r;
  }

  return { call, ensure };
}
