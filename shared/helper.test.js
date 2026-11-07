import { describe, expect, test } from "bun:test";
import { createHelper, HELPER_SCRIPT, HELPER_VERSION, parseLines, PROTOCOL } from "./helper.js";

const CURRENT = { protocol: PROTOCOL, version: HELPER_VERSION, build: "0123456789ab", target: "aarch64-apple-darwin" };

/**
 * @typedef {object} FakeMachine
 * @property {"current" | "missing" | "offline" | "nosuchfile"} [state]
 * @property {object} [version] what `bw version` prints when installed
 * @property {(args: string[]) => {code: number, stdout: string, stderr?: string}} [reply] other commands
 * @property {object[] | Error} [install] what localInstall resolves (or rejects) for this machine
 * @property {object} [installTo] version json the machine reports after an install
 */

/** A fake Herdr `exec` and `localInstall` over named machines; `null` is this Mac. */
function fakeWorld(/** @type {Map<string | null, FakeMachine>} */ machines) {
  const calls = [];
  const installs = [];
  const gates = [];
  let clock = 1_000_000;

  async function exec(cmd, args, opts) {
    calls.push({ cmd, args, opts });
    const m = machines.get(opts.on) ?? { state: "missing" };
    if (m.state === "offline") throw new Error(`machine ${opts.on} is unreachable`);
    if (m.state === "missing") return { code: 127, stdout: "", stderr: "sh: 1: exec: /home/u/.local/share/bellwether/helper/current/bw: not found\n" };
    if (m.state === "nosuchfile") return { code: 2, stdout: "", stderr: "sh: /home/u/.local/share/bellwether/helper/current/bw: No such file or directory\n" };
    const rest = args.slice(3);
    if (rest[0] === "version") return { code: 0, stdout: JSON.stringify(m.version ?? CURRENT) + "\n", stderr: "" };
    const r = m.reply ? m.reply(rest) : { code: 0, stdout: "" };
    return { stderr: "", ...r };
  }

  async function localInstall(machine) {
    installs.push(machine);
    if (gates.length) await gates.shift();
    const m = machines.get(machine);
    if (m.install instanceof Error) throw m.install;
    const lines = m.install ?? [{ type: "installed", machine, version: HELPER_VERSION, sha256: "ab" }];
    if (lines.at(-1)?.type === "installed") {
      m.state = "current";
      m.version = m.installTo ?? CURRENT;
    }
    return lines;
  }

  /** Holds the next install until the returned function is called. */
  function holdInstall() {
    let release;
    gates.push(new Promise((r) => (release = r)));
    return () => release();
  }

  const helper = createHelper({ exec, localInstall, now: () => clock });
  return {
    helper,
    calls,
    installs,
    holdInstall,
    advance: (ms) => (clock += ms),
  };
}

describe("call", () => {
  test("call passes args after the fixed script and routes by machine", async () => {
    const w = fakeWorld(
      new Map([
        ["tsuki", { state: "current", reply: (a) => ({ code: 0, stdout: `{"type":"echo","args":${JSON.stringify(a)}}\n` }) }],
        [null, { state: "current", reply: () => ({ code: 0, stdout: '{"type":"here"}\n' }) }],
      ]),
    );
    const remote = await w.helper.call("tsuki", ["send", "a b", "$HOME;rm -rf /"]);
    expect(remote).toEqual({ ok: true, lines: [{ type: "echo", args: ["send", "a b", "$HOME;rm -rf /"] }] });
    const local = await w.helper.call(null, ["status"]);
    expect(local).toEqual({ ok: true, lines: [{ type: "here" }] });

    const run = w.calls.find((c) => c.args[3] === "send");
    expect(run).toEqual({ cmd: "sh", args: ["-c", HELPER_SCRIPT, "bw", "send", "a b", "$HOME;rm -rf /"], opts: { on: "tsuki" } });
    expect(w.calls.find((c) => c.args[3] === "status").opts).toEqual({ on: null });
    expect(HELPER_SCRIPT).toBe('exec "$HOME"/.local/share/bellwether/helper/current/bw "$@"');
  });

  test("an error line is failed with its message", async () => {
    const w = fakeWorld(
      new Map([["tsuki", { state: "current", reply: () => ({ code: 1, stdout: '{"type":"error","code":"no_session","message":"no session abc"}\n' }) }]]),
    );
    expect(await w.helper.call("tsuki", ["send", "abc"])).toEqual({ ok: false, state: "failed", message: "no session abc" });
  });

  test("an error line fails the call even when bw exits 0", async () => {
    const w = fakeWorld(
      new Map([["tsuki", { state: "current", reply: () => ({ code: 0, stdout: '{"type":"progress"}\n{"type":"error","code":"x","message":"late"}\n' }) }]]),
    );
    expect(await w.helper.call("tsuki", ["x"])).toEqual({ ok: false, state: "failed", message: "late" });
  });

  test("a nonzero exit without an error line is failed with stderr", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", reply: () => ({ code: 101, stdout: "", stderr: "thread main panicked\n" }) }]]));
    expect(await w.helper.call("tsuki", ["x"])).toEqual({ ok: false, state: "failed", message: "bw exited 101: thread main panicked" });
  });

  test("a non-JSON line is bad_output", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", reply: () => ({ code: 0, stdout: '{"type":"ok"}\nprivate transcript text\n' }) }]]));
    const r = await w.helper.call("tsuki", ["x"]);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("bad_output");
    // The line itself may hold transcript text, so the message names only its number.
    expect(r.message).toBe("line 2 is not a JSON object");
  });

  test("exit 127 is missing and triggers one install", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "missing", reply: () => ({ code: 0, stdout: '{"type":"ok"}\n' }) }]]));
    expect(await w.helper.call("tsuki", ["x"])).toEqual({ ok: true, lines: [{ type: "ok" }] });
    expect(w.installs).toEqual(["tsuki"]);
    expect(await w.helper.call("tsuki", ["x"])).toEqual({ ok: true, lines: [{ type: "ok" }] });
    expect(w.installs).toEqual(["tsuki"]);
  });

  test("No such file in stderr is missing", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "nosuchfile" }]]));
    expect(await w.helper.call("tsuki", ["x"], { install: false })).toEqual({
      ok: false,
      state: "missing",
      message: "bw is not installed on tsuki",
    });
  });

  test("rejected exec is unreachable and installs nothing", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "offline" }]]));
    const r = await w.helper.call("tsuki", ["x"]);
    expect(r).toEqual({ ok: false, state: "unreachable", message: "machine tsuki is unreachable" });
    expect(w.installs).toEqual([]);
  });

  test("install: false reports missing without installing", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "missing" }]]));
    expect((await w.helper.call("tsuki", ["x"], { install: false })).state).toBe("missing");
    expect(w.installs).toEqual([]);
  });

  test("a helper that vanishes after a current check is rechecked and reinstalled", async () => {
    const machines = new Map([["tsuki", { state: "current", reply: () => ({ code: 0, stdout: '{"type":"ok"}\n' }) }]]);
    const w = fakeWorld(machines);
    expect((await w.helper.call("tsuki", ["x"])).ok).toBe(true);
    machines.get("tsuki").state = "missing";
    expect(await w.helper.call("tsuki", ["x"])).toEqual({ ok: false, state: "missing", message: "bw is not installed on tsuki" });
    expect(await w.helper.call("tsuki", ["x"])).toEqual({ ok: true, lines: [{ type: "ok" }] });
    expect(w.installs).toEqual(["tsuki"]);
  });
});

describe("ensure", () => {
  test("old protocol is outdated", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", version: { ...CURRENT, protocol: PROTOCOL - 1 } }]]));
    const r = await w.helper.ensure("tsuki", { install: false });
    expect(r).toEqual({ ok: false, state: "outdated", message: `bw on tsuki is protocol ${PROTOCOL - 1} version ${HELPER_VERSION}; this window needs protocol ${PROTOCOL} version ${HELPER_VERSION}` });
  });

  test("this window needs helper 0.3.0, protocol 3", () => {
    expect(PROTOCOL).toBe(3);
    expect(HELPER_VERSION).toBe("0.3.0");
  });

  test("a phase 2 helper (protocol 2, 0.2.0) is outdated", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", version: { ...CURRENT, protocol: 2, version: "0.2.0" } }]]));
    const r = await w.helper.ensure("tsuki", { install: false });
    expect(r).toEqual({ ok: false, state: "outdated", message: "bw on tsuki is protocol 2 version 0.2.0; this window needs protocol 3 version 0.3.0" });
  });

  test("a phase 1 helper (protocol 1, 0.1.0) is outdated", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", version: { ...CURRENT, protocol: 1, version: "0.1.0" } }]]));
    const r = await w.helper.ensure("tsuki", { install: false });
    expect(r).toEqual({ ok: false, state: "outdated", message: "bw on tsuki is protocol 1 version 0.1.0; this window needs protocol 3 version 0.3.0" });
  });

  test("a different version is outdated and installs once", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", version: { ...CURRENT, version: "0.0.9" } }]]));
    expect(await w.helper.ensure("tsuki")).toEqual({ ok: true, state: "current", message: "" });
    expect(w.installs).toEqual(["tsuki"]);
  });

  test("two concurrent ensure calls share one install", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "missing" }]]));
    const release = w.holdInstall();
    const a = w.helper.ensure("tsuki");
    const b = w.helper.ensure("tsuki");
    await Promise.resolve();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ ok: true, state: "current", message: "" });
    expect(rb).toEqual(ra);
    expect(w.installs).toEqual(["tsuki"]);
  });

  test("install: false during a running install reports installing", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "missing" }]]));
    const release = w.holdInstall();
    const first = w.helper.ensure("tsuki");
    for (let i = 0; i < 100 && w.installs.length === 0; i++) await Promise.resolve();
    expect(w.installs).toEqual(["tsuki"]);
    expect(await w.helper.ensure("tsuki", { install: false })).toEqual({
      ok: false,
      state: "installing",
      message: "installing bw on tsuki",
    });
    release();
    expect((await first).ok).toBe(true);
  });

  test("this Mac (null) never auto-installs and reports missing", async () => {
    const w = fakeWorld(new Map([[null, { state: "missing" }]]));
    expect(await w.helper.ensure(null)).toEqual({
      ok: false,
      state: "missing",
      message: "bw is not installed on this machine: run scripts/install-helper.sh",
    });
    expect((await w.helper.call(null, ["x"])).state).toBe("missing");
    expect(w.installs).toEqual([]);
  });

  test("this Mac (null) never auto-installs when outdated", async () => {
    const w = fakeWorld(new Map([[null, { state: "current", version: { ...CURRENT, version: "0.0.1" } }]]));
    expect((await w.helper.ensure(null)).state).toBe("outdated");
    expect(w.installs).toEqual([]);
  });

  test("a current check is cached for 60 s", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current" }]]));
    await w.helper.ensure("tsuki");
    w.advance(59_999);
    await w.helper.ensure("tsuki");
    expect(w.calls.length).toBe(1);
    w.advance(1);
    await w.helper.ensure("tsuki");
    expect(w.calls.length).toBe(2);
  });

  test("an install error line is failed with its message and not retried for 60 s", async () => {
    const w = fakeWorld(
      new Map([["tsuki", { state: "missing", install: [{ type: "progress", step: "uname" }, { type: "error", code: "no_build", message: "no build for Linux x86_64" }] }]]),
    );
    expect(await w.helper.ensure("tsuki")).toEqual({ ok: false, state: "failed", message: "no build for Linux x86_64" });
    expect(await w.helper.ensure("tsuki")).toEqual({ ok: false, state: "failed", message: "no build for Linux x86_64" });
    expect(w.installs).toEqual(["tsuki"]);
    w.advance(60_000);
    await w.helper.ensure("tsuki");
    expect(w.installs).toEqual(["tsuki", "tsuki"]);
  });

  test("a rejected local install is failed", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "missing", install: new Error("bw: command not found") }]]));
    expect(await w.helper.ensure("tsuki")).toEqual({ ok: false, state: "failed", message: "install on tsuki failed: bw: command not found" });
  });

  test("an install that leaves the helper outdated is failed", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "missing", installTo: { ...CURRENT, version: "0.0.9" } }]]));
    const r = await w.helper.ensure("tsuki");
    expect(r.ok).toBe(false);
    expect(r.state).toBe("failed");
    expect(r.message).toStartWith("bw on tsuki is still outdated after install: ");
  });

  test("a version line without protocol is bad_output", async () => {
    const w = fakeWorld(new Map([["tsuki", { state: "current", version: { type: "hello" } }]]));
    expect(await w.helper.ensure("tsuki")).toEqual({ ok: false, state: "bad_output", message: "bw version on tsuki printed no protocol and version" });
    expect(w.installs).toEqual([]);
  });
});

describe("parseLines", () => {
  test("skips blank lines and accepts CRLF", () => {
    expect(parseLines('{"a":1}\r\n\n  \n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("throws on a line that is JSON but not an object", () => {
    expect(() => parseLines('{"a":1}\n42\n')).toThrow("line 2 is not a JSON object");
  });
});
