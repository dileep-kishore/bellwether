# Bellwether phase 0: foundation, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloned `bellwether` layout, the `bw` helper with `bw version` and `bw machine install`, the vendored `herdr-core`, `shared/helper.js`, scripted and scrubbed agent recordings, an isolated test window script, and answers to the per-session agent flag questions.

**Architecture:** A Cargo workspace (`crates/bw`, `crates/vendor/herdr-core`). `bw` prints JSON lines. `shared/helper.js` is a pure module that takes Herdr's `exec` as an argument, so `bun test` runs it outside Herdr. Remote installs go through the `hc` CLI (`hc exec --on`, `hc file write --on`), which this build tests against a loopback machine.

**Tech Stack:** Rust 1.99.1 (edition 2021), serde_json, sha2; Bun 1.4.4 for JavaScript tests; POSIX `sh` scripts; `hc` 0.1.18.

**Spec:** `docs/specs/2026-11-06-bellwether-design.md` (revision 4), phase plan `docs/plans/2026-11-06-bellwether-phases.md`, phase 0.

## Build environment (macmini, 2026-11-06)

- This Mac is macmini. It has `hc` 0.1.18 but no `herdr-app`, so window checks are deferred and listed in `docs/drafts/herdr-window-checks.md` (untracked).
- Every shell and script prepends `export PATH=/opt/homebrew/opt/rustup/bin:$PATH`.
- `hc machine ls` lists one temporary machine, `bwloop`: `--via 'env HOME=/Users/dkishore/.bwl sh -c'`. It is this Mac with its own HOME and its own core, so `hc exec --on bwloop` and `hc file write --on bwloop` exercise the remote paths for real. The MacBook is not a Herdr machine here; checks that need it record their remote half as pending.
- `hc file write --on` is binary-safe (SHA-256 of a 7 MB random file matched on `bwloop`).
- Reference clones: `/Users/dkishore/.bwl-refs/{flockbook,shepherdr,herdr-t3,t3code,orca}` at the commits the handoff pins.
- Herdr API copy: `docs/drafts/herdr-api/` (`AGENTS.md`, `herdr.d.ts`, `gpui-kit.d.ts`, `main.json`, `commands.json`, shipped mods).

## Open questions settled (brainstorm)

1. Layout clone without `herdr-app`: copy `docs/drafts/herdr-api/main.json` to `layouts/bellwether.json` and add `"cloned_from": {"name": "main", "version": "0.1.13"}` to the root, which is what `layout.clone` records. Owed window check: `layout.switch {name: "bellwether"}` and a shot.
2. `scripts/check.sh` on a Mac without `herdr-app`: it prints `DEFERRED herdr-app check <dir> (no herdr-app here)` per mod and still fails on shared-copy and JSON errors. Phase 1 adds a headless render test as the stand-in.
3. One runner for every non-window check: `scripts/test.sh` runs `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, `bun test`, `scripts/check.sh`, and each `scripts/verify/*.sh` that takes `--offline` (fixtures only, no agents).
4. `bw version` output, one JSON line: `{"protocol":1,"version":"0.1.0","build":"<12-hex git hash or unknown>","target":"aarch64-apple-darwin"}`. `build.rs` reads `git rev-parse --short=12 HEAD`. A machine's helper is current when `protocol` and `version` match.
5. Where the helper lives on every machine: `~/.local/share/bellwether/helper/<version>/bw`, with `~/.local/share/bellwether/helper/current` a symlink to `<version>`. Callers always run `"$HOME"/.local/share/bellwether/helper/current/bw`.
6. Install transport: the `hc` CLI from `std::process::Command`, not a socket client. The `hc` program path comes from `BW_HC` (default `hc`), so tests swap in a fake.
7. Linux builds: `scripts/build-dist.sh` builds `aarch64-apple-darwin` here, and `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` only when `cargo zigbuild` exists (it does not here; the script says "skipped"). tsuki stays pending.
8. The isolated test window isolates Herdr state only (amendment log, Codex plan review): own `HERDR_APP_HOME`, own `HC_SESSION`, real HOME so the real `claude` and `codex` keep their logins.
9. Recordings run the real agents in a scratch folder and copy their logs into `tests/fixtures/sessions/<name>/`, scrubbed. A recording the agent cannot produce non-interactively (for example a Codex async question) is recorded with `hc run` in a core terminal, driven by `hc send`/`hc keys`, or logged as not recordable with the reason.
10. The zoom-flip spike needs the Herdr window, so it moves to the owed window checks. The design keeps the zoom flip as the primary path and the `terminal.show` fallback as the spec states. The per-session flags spike runs now with the real agents.
11. Per-task reviews: the user's instructions make one `independent-review` per phase replace other skills' review rounds, so tasks get no per-task reviewer subagent. Each implementer runs its own tests and the phase gets one Codex review.

## Global Constraints

- Mods are named `bw-<name>`, the layout `bellwether`.
- Code copied or adapted from Flockbook, Shepherdr or herdr-t3 gets an entry in `THIRD_PARTY_NOTICES.md` in the same commit: file here, source path, source commit, copyright line (`Copyright (c) 2026 Min-Chen Lee` for Flockbook; read the others' LICENSE).
- The vendored `crates/vendor/herdr-core` is copied unchanged at `c0420c7`, with `crates/vendor/herdr-core/UPSTREAM` naming the source and commit.
- Remote file writes go in parts under 6 MB (`6 * 1024 * 1024` bytes) per `hc file write --on` call.
- Test recordings pass `scripts/verify/scrub-fixture` before they enter the repository; no private transcript, key, username, hostname or home path lands in the repository.
- Before every commit: `git diff --cached --stat` lists only the intended files (the repository syncs `.git` through Syncthing).
- Conventional commits, about 50-character titles, bodies wrapped at 72.

## Review Focus

1. A remote machine whose `uname -sm` has no build (Linux here, since no musl build exists): `bw machine install` exits nonzero with `{"type":"error","code":"no_build","target":...}` and writes nothing there. Test in Task 2.
2. A SHA-256 mismatch after the copy: install deletes the partial version folder there and leaves `current` pointing where it was. Test in Task 2 (fake `hc` that corrupts one part).
3. `bw` missing on a machine (`sh` exit 127) versus the machine unreachable (`exec` rejects) versus a helper too old: `shared/helper.js` names each state differently and installs only for missing or old. Test in Task 3.
4. Two calls racing to install on one machine: `shared/helper.js` runs one install and both calls wait for it. Test in Task 3.
5. A recording that still holds `/Users/dkishore`, `dkishore`, the hostname `Dileeps-Mac-mini`, an email, or a token prefix (`sk-ant-`, `sk-`, `lin_api_`, `gho_`, `ghp_`): `scrub-fixture --check` fails and names the file and line. Test in Task 4.

---

### Task 1: Workspace scaffold and `bw version` (main checkout, before the others)

**Files:**
- Modify: `.stignore` (add `(?d)target`), `scripts/check.sh`, `README.md` (status and layout lines)
- Create: `layouts/bellwether.json`, `Cargo.toml`, `rust-toolchain.toml`, `crates/bw/Cargo.toml`, `crates/bw/build.rs`, `crates/bw/src/main.rs`, `crates/bw/src/version.rs`, `crates/bw/tests/version.rs`, `scripts/test.sh`, `Cargo.lock`
- Remove: `layouts/.gitkeep`

**Interfaces:**
- Produces: binary `bw`; `bw version` prints `{"protocol":1,"version":"0.1.0","build":"…","target":"aarch64-apple-darwin"}` and exits 0; an unknown subcommand prints `{"type":"error","code":"usage","message":…}` to stdout and exits 2. `crates/bw/src/version.rs` exports `pub const PROTOCOL: u32 = 1;`, `pub fn version_json() -> serde_json::Value`. `main.rs` dispatches on the first argument with a plain `match` (no clap), so later tasks add arms.
- Produces: `scripts/test.sh [--offline]`, which runs every non-window check and exits nonzero on the first failure.

- [ ] **Step 1:** `rust-toolchain.toml` with `channel = "1.99.1"`, `components = ["clippy", "rustfmt"]`. Workspace `Cargo.toml` with `members = ["crates/bw"]` (Task 2 adds `crates/vendor/herdr-core`), `resolver = "2"`, and `[profile.release] strip = true`.
- [ ] **Step 2: Write the failing test** `crates/bw/tests/version.rs`: run `env!("CARGO_BIN_EXE_bw")` with `version`; parse stdout as JSON; assert `protocol == 1`, `version == env!("CARGO_PKG_VERSION")`, `target` is a non-empty string, `build` matches `^[0-9a-f]{12}$|^unknown$`. Second test: `bw nonsense` exits 2 and stdout parses with `code == "usage"`.
- [ ] **Step 3:** Run `cargo test -p bw --locked` (first run without `--locked` to create `Cargo.lock`). Expected: FAIL.
- [ ] **Step 4:** Implement `version.rs`, `main.rs`, `build.rs` (sets `BW_BUILD` from `git rev-parse --short=12 HEAD`, else `unknown`; sets `BW_TARGET` from `TARGET`; `rerun-if-changed=../../.git/HEAD`).
- [ ] **Step 5:** Run `cargo test -p bw --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --check`. Expected: PASS.
- [ ] **Step 6:** `layouts/bellwether.json` from `docs/drafts/herdr-api/main.json` plus root `"cloned_from": {"name": "main", "version": "0.1.13"}`; `jq empty` passes.
- [ ] **Step 7:** `scripts/check.sh`: when `command -v herdr-app` fails, print `DEFERRED herdr-app check <dir> (no herdr-app here)` per mod instead of failing; final line says how many mods were deferred. `scripts/test.sh` as in Interfaces; with no `bun test` files yet it prints that and continues.
- [ ] **Step 8:** Run `scripts/test.sh`. Expected: exit 0.
- [ ] **Step 9: Commit** `build: add the bw crate and bellwether layout`.

### Task 2: Vendored `herdr-core` and `bw machine install` (worktree A)

**Files:**
- Create: `crates/vendor/herdr-core/**` (copied unchanged), `crates/vendor/herdr-core/UPSTREAM`, `crates/bw/src/machine/mod.rs`, `crates/bw/src/machine/install.rs`, `crates/bw/src/hc.rs`, `crates/bw/tests/install.rs`, `crates/bw/tests/fake-hc` (a `sh` script), `scripts/install-helper.sh`, `scripts/build-dist.sh`, `scripts/verify/install.sh`
- Modify: `Cargo.toml` (add the vendor member and `[workspace.package]`/`[workspace.dependencies]` the vendored manifest needs), `crates/bw/src/main.rs` (arms `machine install`, `machine status`), `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: Task 1's `main.rs` dispatch and `version::version_json()`.
- Produces: `bw machine status <machine>` prints `{"type":"machine","machine":…,"state":"current"|"missing"|"outdated"|"unreachable"|"no_build","remote":<version json or null>,"uname":…}`. `bw machine install <machine> [--force]` prints progress lines `{"type":"progress","step":"uname"|"copy"|"verify"|"link","part":n,"parts":m}` and ends with `{"type":"installed","machine":…,"version":…,"sha256":…}` or `{"type":"error","code":…,"message":…}` (codes: `unreachable`, `no_build`, `sha_mismatch`, `write_failed`). It returns at once with `{"type":"installed",…,"already":true}` when the remote is current.
- Produces: `scripts/install-helper.sh` builds release and installs `bw` on this Mac at `~/.local/share/bellwether/helper/<version>/bw` with `current` linked, printing the path.

- [ ] **Step 1:** Copy `/Users/dkishore/.bwl-refs/flockbook/xplat/herdr-core` to `crates/vendor/herdr-core` unchanged (sources, tests, Cargo.toml, its README if any). Make its manifest's `*.workspace = true` keys resolve by adding the same `[workspace.package]` (`edition = "2021"`, `license = "MIT"`, `publish = false`) and `[workspace.dependencies]` (`serde`, `serde_json` with `float_roundtrip`) to the root. Write `UPSTREAM`: repository, path `xplat/herdr-core`, commit `c0420c7f9a720631108f2d269dcf9f4bd62634ff`, "copied unchanged; every later change listed below with its test". `THIRD_PARTY_NOTICES.md` entry for the folder.
- [ ] **Step 2:** `cargo test -p herdr-core --locked` passes unchanged. If an upstream test needs something this Mac lacks, record it in `UPSTREAM` and in the commit body rather than editing the test.
- [ ] **Step 3: Commit** `build: vendor herdr-core from Flockbook c0420c7`.
- [ ] **Step 4: Write the failing tests** `crates/bw/tests/install.rs`, each with `BW_HC` pointing at `tests/fake-hc` (a script that implements `exec --on M <argv>` and `file write --on M <path>` against a temp folder named in `FAKE_HC_ROOT`, and `FAKE_HC_UNAME`, `FAKE_HC_CORRUPT_PART`, `FAKE_HC_OFFLINE` switches):
  - `install_copies_in_parts_and_links_current`: an 8 MB fake binary given by `BW_INSTALL_SOURCE` arrives in two parts, the joined file's SHA-256 equals the source's, `current` → `0.1.0`, final line `type == "installed"`.
  - `install_is_a_noop_when_current`: second run prints `already: true` and writes no part.
  - `install_refuses_platform_without_build`: `FAKE_HC_UNAME="Linux x86_64"` and no dist file → `code == "no_build"`, nothing written.
  - `install_cleans_up_on_sha_mismatch`: corrupt part 2 → `code == "sha_mismatch"`, the version folder there is gone, a previous `current` link still points at its old target.
  - `status_names_unreachable`: `FAKE_HC_OFFLINE=1` → `state == "unreachable"`.
- [ ] **Step 5:** Run `cargo test -p bw --locked`. Expected: FAIL.
- [ ] **Step 6:** Implement. `hc.rs`: `fn hc_exec(machine: &str, argv: &[&str]) -> Result<Output, HcError>` and `fn hc_write(machine: &str, path: &str, bytes: &[u8]) -> Result<(), HcError>` over `BW_HC`. `install.rs`, adapting `flockbook-modfeed/src/remote.rs` (read it; record it in `THIRD_PARTY_NOTICES.md`): `uname -sm` there → target (`Darwin arm64|x86_64` → `aarch64-apple-darwin` only when it is arm64; `Linux x86_64` → `x86_64-unknown-linux-musl`; `Linux aarch64|arm64` → `aarch64-unknown-linux-musl`); the source is `BW_INSTALL_SOURCE`, else this executable when the target equals `BW_TARGET`, else `~/.local/share/bellwether/dist/<target>/bw` with `SHA256SUMS`; write parts to `.local/share/bellwether/helper/<version>/bw.part<N>` under 6 MB each (paths relative to that machine's home, as `hc file write --on` resolves them); join, check with `shasum -a 256` (Darwin) or `sha256sum` (Linux) there; `chmod 755`; `ln -sfn <version> current` in the helper folder; remove parts. Every command there runs as `argv` without a shell, except the fixed join/link lines, which take values only as positional `sh -c` arguments (`sh -c 'cat "$@" > …' sh part1 part2`).
- [ ] **Step 7:** Run `cargo test -p bw --locked`, clippy, fmt. Expected: PASS.
- [ ] **Step 8:** `scripts/install-helper.sh` and `scripts/build-dist.sh` (darwin always; Linux musl targets only with `cargo zigbuild`, else `skipped: cargo-zigbuild not installed`), writing `~/.local/share/bellwether/dist/<target>/bw` and `SHA256SUMS`.
- [ ] **Step 9:** `scripts/verify/install.sh [--machine bwloop]`: runs `scripts/install-helper.sh`, `bw machine status <m>`, `bw machine install <m>`, then `hc exec --on <m> sh -c '"$HOME"/.local/share/bellwether/helper/current/bw version'` and compares `protocol` and `version` with the local `bw version`; prints `PASS`/`FAIL` lines; exits nonzero on any FAIL. Run it against `bwloop`. Expected: PASS lines, the helper present under `/Users/dkishore/.bwl/.local/share/bellwether/helper/`.
- [ ] **Step 10: Commit** `feat(bw): install the helper on another machine`.

### Task 3: `shared/helper.js` (worktree B)

**Files:**
- Create: `shared/helper.js`, `shared/helper.test.js`, `bunfig.toml` (only if needed to scope `bun test` to `shared/` and `tests/`)

**Interfaces:**
- Consumes: Task 2's command shapes (`bw version` JSON, `bw machine install <m>` final line, error lines `{"type":"error","code","message"}`).
- Produces (no Herdr imports; Herdr's `exec` is passed in):
  - `export const PROTOCOL = 1;`, `export const HELPER_VERSION = "0.1.0";`
  - `export const HELPER_SCRIPT = 'exec "$HOME"/.local/share/bellwether/helper/current/bw "$@"';`
  - `export function createHelper({ exec, localInstall }): Helper` where `exec(cmd, args, opts)` has Herdr's signature (resolves `{code, stdout, stderr}`, rejects when the machine cannot be reached) and `localInstall(machine)` runs the window machine's `bw machine install <machine>` and resolves its parsed lines.
  - `Helper.call(machine, args, { install = true } = {}) => Promise<{ ok: true, lines: object[] } | { ok: false, state: "unreachable" | "missing" | "outdated" | "installing" | "failed" | "bad_output", message: string }>`. It runs `exec("sh", ["-c", HELPER_SCRIPT, "bw", ...args], { on: machine })` (`machine` null means this Mac). Exit 127 or "No such file" → `missing`; a `bw version` whose `protocol`/`version` differ → `outdated`; JSON parse failure of any non-empty line → `bad_output`; an `{"type":"error"}` line → `failed` with its message.
  - `Helper.ensure(machine) => Promise<{ ok, state, message }>`: checks `bw version` once per machine per 60 s and, for `missing` or `outdated` on a machine other than this Mac and with `install`, runs `localInstall` once (concurrent callers share the promise) and checks again.
  - `export function parseLines(stdout: string): object[]`.

- [ ] **Step 1: Write the failing tests** in `shared/helper.test.js` with a fake `exec`: `call passes args after the fixed script and routes by machine`; `exit 127 is missing and triggers one install`; `rejected exec is unreachable and installs nothing`; `old protocol is outdated`; `two concurrent ensure calls share one install`; `an error line is failed with its message`; `a non-JSON line is bad_output`; `this Mac (null) never auto-installs and reports missing`.
- [ ] **Step 2:** Run `bun test shared/`. Expected: FAIL.
- [ ] **Step 3:** Implement `shared/helper.js`.
- [ ] **Step 4:** Run `bun test shared/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): route helper calls by machine`.

### Task 4: Recordings and the scrubber (worktree C)

**Files:**
- Create: `scripts/verify/scrub-fixture` (POSIX `sh` or a Bun script with a shebang), `scripts/verify/record-session`, `scripts/verify/scrub-fixture.test.js` (or `tests/scrub.test.js`), `tests/fixtures/sessions/<name>/` with the scrubbed logs, `tests/fixtures/sessions/<name>/expect.json`, `tests/fixtures/sessions/README.md`

**Interfaces:**
- Produces: `scripts/verify/scrub-fixture <dir>` rewrites files in place (home path → `/home/user`, username → `user`, hostname → `host`, emails → `user@example.com`, the scratch folder → `/scratch/<name>`, token-shaped strings → `REDACTED`) and then runs `--check`; `scrub-fixture --check <dir>` exits 1 listing `file:line: <pattern>` for any residue of the Review Focus 5 patterns.
- Produces: `scripts/verify/record-session <scenario> [--keep]`, scenarios: `claude-subagents` (three direct sub-agents and one nested, from `claude -p` in a fresh scratch git repo), `claude-picture` (Claude reads a small PNG so the log carries an image), `claude-approval` (interactive `claude --permission-mode default` in an `hc run --bg` terminal asked to `touch approved.txt`; saves the prompt screen from `hc read` as `screen-approval.txt`, then approves with `hc keys`), `codex-subagent` (`codex exec` that spawns one sub-agent), `codex-question` (Codex `request_user_input` or `request_user_input_async`, interactive in an `hc run` terminal when needed). Each copies the session files (Claude: `<project>/<session>.jsonl` and `<session>/subagents/*`; Codex: the parent and child rollouts) into `tests/fixtures/sessions/<scenario>/`, runs `scrub-fixture`, and writes `expect.json` with hand-counted values the recorder fills by reading the logs: `{"agent","version","user_messages","assistant_messages","tool_calls","children":[{"id","type","depth","parent"}],"pictures"}`.

- [ ] **Step 1: Write the failing tests** for the scrubber: it rewrites a planted home path, username, hostname, email and `sk-ant-…` token; `--check` fails on each planted pattern with `file:line`; `--check` passes on a clean file.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `scrub-fixture`. Run tests. Expected: PASS.
- [ ] **Step 4:** Implement `record-session` and record each scenario with the real `claude` 2.1.319 and `codex` 0.167 in scratch folders under `/private/tmp/claude-501/` (never in this repository, never copied from the user's existing logs). Read each recorded log and fill `expect.json` by hand-counting. A scenario that cannot be produced gets a `tests/fixtures/sessions/README.md` line naming what was tried and why it failed.
- [ ] **Step 5:** `scripts/verify/scrub-fixture --check tests/fixtures/sessions` exits 0; `rg -n 'dkishore|Dileeps|/Users/' tests/fixtures` prints nothing.
- [ ] **Step 6: Commit** `test: add scrubbed agent session recordings`.

### Task 5: Isolated test window and the per-session flags spike (worktree D)

**Files:**
- Create: `scripts/verify/stage.sh`, `scripts/verify/agent-flags.sh`, `tests/fixtures/mcp-echo/server.js` (a stdio MCP server with one tool `bw_echo` that returns a fixed sentinel), `docs/research/2026-11-06-phase0-spike.md`
- Modify: `THIRD_PARTY_NOTICES.md` (if `stage.sh` adapts herdr-t3 code; read its LICENSE first)

**Interfaces:**
- Produces: `scripts/verify/stage.sh up|do <cmd…>|down` after herdr-t3's `scripts/demo/stage.sh`: `D=/private/tmp/bw-stage`, own `HERDR_APP_HOME=$D/app`, `HC_SESSION=bw-stage`, real HOME and PATH plus the repo's `bw`. `up` makes the folders, starts that core (`hc server status`), checks it differs from the user's core, copies the layout and mods with `HERDR_APP_HOME=$D/app scripts/sync.sh`, and opens the window only when `herdr-app` exists (else prints `window deferred: no herdr-app here`). `down` stops that core and deletes `$D`.
- Produces: `scripts/verify/agent-flags.sh`, which proves for each agent that the flags load the MCP server and the instructions for that session only:
  - Claude: `claude -p --mcp-config <cfg.json> --append-system-prompt-file <instr.md> "<prompt>"` where the instructions hold a sentinel word and the prompt asks for it and asks the agent to call `bw_echo`; PASS when the reply has the sentinel and the tool's sentinel; then `claude mcp list` run in the same folder does not list the server.
  - Codex: `codex exec -c 'mcp_servers.bw-echo.command="node"' -c 'mcp_servers.bw-echo.args=["…/server.js"]' -c 'developer_instructions="<effective existing value>\n\n<sentinel text>"' "<prompt>"`; PASS when the reply has both sentinels and, when the user's `~/.codex/config.toml` sets `developer_instructions` (top level or active profile), the reply also shows that value was kept (test with `CODEX_HOME` pointing at a scratch copy whose config sets a second sentinel there).
- Produces: `docs/research/2026-11-06-phase0-spike.md` with each command, its output (trimmed), PASS/FAIL, and the owed window half of the spike (zoom flip both ways, tab status, close ends the agent, `agents()` lists it).

- [ ] **Step 1:** Write `tests/fixtures/mcp-echo/server.js` (no dependencies; JSON-RPC over stdio: `initialize`, `tools/list`, `tools/call`). A `bun test` (`tests/mcp-echo.test.js`) drives it over stdio: initialize, list shows `bw_echo`, call returns the sentinel.
- [ ] **Step 2:** Run the test. Expected: FAIL, then implement, then PASS.
- [ ] **Step 3:** Write and run `scripts/verify/agent-flags.sh`. Record results in the research note. If a flag does not work as the spec assumes, record the working alternative and the evidence; do not change the spec.
- [ ] **Step 4:** Write `scripts/verify/stage.sh`; run `up`, `do hc ls --json`, `down`. Expected: the isolated core differs from the user's and `down` removes `/private/tmp/bw-stage`.
- [ ] **Step 5: Commit** `test: add the isolated stage and agent flag spike`.

### Task 6: Phase checks (main checkout, after merging A to D)

- [ ] **Step 1:** Merge the worktree branches into `phase-0-foundation`; resolve `Cargo.toml`, `THIRD_PARTY_NOTICES.md` and `crates/bw/src/main.rs` conflicts by keeping both sides.
- [ ] **Step 2:** Run `scripts/test.sh`, `scripts/verify/install.sh --machine bwloop`, `scripts/verify/scrub-fixture --check tests/fixtures`. Expected: exit 0.
- [ ] **Step 3:** Add the phase's owed window checks to `docs/drafts/herdr-window-checks.md`.
