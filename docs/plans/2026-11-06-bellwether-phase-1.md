# Bellwether phase 1: window and project sidebar, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three-column `bellwether` window: `bw-projects` on the left (machines, projects, every worktree, agent lines), `bw-tabs` with its "+" menu `bw-new` (terminal entries and worktree actions) over the active tab, an empty `bw-right` with its Changes, Issues, Browser strip, and Herdr's `workspace-status`, working the same for a space on another machine.

**Architecture:** Pure modules in `shared/` (status ranking, Git output parsing, the project model, the refresh schedule and its driver) hold every decision and run under `bun test`. Mods are thin: they read Herdr's live data in `render`, hand refresh targets to the schedule, and run short read-only Git calls with `exec(..., { on: machine })`. A headless harness stubs `herdr`, `gpui-kit` and `gpui-base` with Bun virtual modules, checks every builder method and command against Herdr's type files, and stands in for `herdr-app check` on this Mac.

**Tech Stack:** JavaScript ES modules for Herdr's gpui-kit runtime (gpui-shell 0.7.1, herdr-app 0.1.13 API copy); Bun 1.4.4 for tests and verify scripts; POSIX `sh`; Git 2.54; `hc` 0.1.18. No Rust in this phase.

**Spec:** `docs/specs/2026-11-06-bellwether-design.md` revision 4 (Constraints from Herdr, Architecture, Seamless machines, Window, Project sidebar, Tabs, Right sidebar, done check 1); phase plan `docs/plans/2026-11-06-bellwether-phases.md`, phase 1; phase 0 plan `docs/plans/2026-11-06-bellwether-phase-0.md` (Build environment, Task 3 `shared/helper.js`).

## Build environment (macmini, 2026-11-06)

- Phase 0's build environment applies unchanged: no `herdr-app`, no `~/.config/herdr-app`, `hc` 0.1.18, PATH prefix `/opt/homebrew/opt/rustup/bin`.
- `bwloop` is a `--temp` machine (`hc machine ls --json` prints `"temporary":true`). Herdr gives temporary machines no spaces and leaves them out of `machines()` (`docs/drafts/herdr-api/AGENTS.md:105-108`). It serves real Git calls through `hc exec --on bwloop` (25 ms per call, measured); it cannot stand in for a remote space in a window.
- Phase 0 is merged into `main` (PR #2, `1128b0e`); phase 1 works on branch `phase-1-window`, and its worktrees branch from it.

## Open questions settled

1. **Headless mod harness.** A `bunfig.toml` `[test] preload` registers a Bun plugin whose `build.module("herdr" | "gpui-kit" | "gpui-base", () => ({ exports, loader: "object" }))` returns the stub modules' namespaces; tests import the same stub files to set live data and read the call log.
   Evidence: a scratch run under Bun 1.4.4 resolved a mod's bare `herdr` and `gpui-kit` imports this way, shared state between test and mod, and failed at link on `import { nothere } from "herdr"`; an `onResolve` to a file path did not resolve bare names ("Cannot find package 'gpui-kit'").
2. **Stub contents.** The stubs adapt Flockbook's `herdr-app/test/stub/herdr.mjs` and `ui.mjs` at `c0420c7` (MIT, `Copyright (c) 2026 Min-Chen Lee`), recorded in `THIRD_PARTY_NOTICES.md`; Flockbook's node loader hooks are not copied. Unlike Flockbook's any-method Proxy, an element throws on a builder method not declared in `interface NativeElement` (`docs/drafts/herdr-api/gpui-kit.d.ts:599`), and `herdr` exports exactly the names in `herdr.d.ts`.
   Evidence: `flockbook/herdr-app/test/stub/ui.mjs:4-22` accepts every name; `gpui-kit.d.ts:1208,1213,1218` declare `frames`, `loop`, `spin`.
3. **API names in the repository.** `docs/drafts/` is untracked, so `scripts/gen-herdr-api.js` extracts names from a Herdr home (default `$HERDR_APP_HOME`, else `~/.config/herdr-app`, else `--from docs/drafts/herdr-api`) into the committed `tests/harness/api.json`, which records its source versions. Regenerate it when Herdr updates.
   Evidence: `gpui-kit.d.ts:1-6` says the file is rewritten per runtime; `commands.json` lists each command's argument names and `required`.
4. **`herdr-app check` stand-in.** `scripts/check.sh`, when `herdr-app` is missing, runs `bun test tests/harness tests/mods` and prints `STAND-IN headless render for N mods (herdr-app check owed)`; the real check stays in the owed list.
   Evidence: `scripts/check.sh:17-27` defers per mod today; `docs/drafts/herdr-api/AGENTS.md:54-58` says the real check renders once and skips layout.
5. **How `shared/` reaches mods.** Unchanged mechanism: each `mods/bw-*/.shared` names files (one per line, no `.js`), `scripts/sync.sh` copies `shared/<name>.js` beside the mod's `main.js` in the repository, and `check.sh` fails on a differing copy. Phase 1 adds `scripts/sync.sh --shared-only` (copies into the repository's mod folders and exits before the app-home check) and makes `check.sh` fail when a listed copy is missing. Mods import `./<name>.js`; the harness imports the repository's `mods/bw-*/main.js`, so it runs the same copies Herdr will.
   Evidence: `scripts/sync.sh:11` exits without an app home before the copy loop at `:13-23`.
6. **`shared/projects-model.js` inputs and output.** Inputs: `machines()`, `spaces()`, `panes()`, `agents()`, `terminals()` as `herdr.d.ts:111-217` types them, the stored list from `shared("bw.projects")`, and a Git cache of parsed `rev-parse --path-format=absolute --git-common-dir --show-toplevel`, `worktree list --porcelain -z`, and `status --porcelain=v2 --branch -z` plus `diff --numstat -z HEAD`. Output: machines, each with projects (worktrees, agent lines) and plain spaces outside Git, plus the agent order and projects to remember. Exact shapes are Task 3's Interfaces. Status rank: blocked > done > working > idle.
   Evidence: `herdr.d.ts:127-128` and `AGENTS.md:150-153` give the rank; `git worktree list --porcelain -z` in a scratch repo printed NUL-ended `worktree`, `HEAD`, `branch refs/heads/<b>` or `detached` fields with an empty field between entries.
7. **Where Git runs.** Directly from the mod, `exec("git" | "sh", argv, { on: machine })`, never through the helper. Each call is short and read-only, `exec(..., { on })` already reaches the space's machine, the spec's amended rule allows it, and phase 1 has no Rust; the helper would add an install dependency and a process per call for no gain. `bw-projects` still calls phase 0's `helper.ensure(machine)` once per ready machine to show "setting up Bellwether on <machine>". Calls never use `exec`'s `cwd` (they use `-C`, `--git-dir` or `cd "$1"`), so the verify script runs the same argv through `hc exec --on`.
   Evidence: `herdr.d.ts:10-13`; spec "Constraints from Herdr", last bullet; spec "Seamless machines", second bullet; phase plan phase 1 needs no `crates/` change.
8. **Read-only Git flags.** Every Git call carries `--no-optional-locks -c core.fsmonitor=false`, and `diff` adds `--no-textconv --no-ext-diff`, so no call writes under `.git` and wakes its own watch.
   Evidence: `docs/drafts/herdr-api/mods/spaces/main.js:202-204`; `REVIEW.md` Focus, last bullet.
9. **Watch and timer scheme.** A pure `shared/refresh-schedule.js` owns every interval; `shared/refresh-driver.js` runs one loop task that sleeps until the schedule's next due time or a poke, starts due Git calls (one in flight per machine), and runs one `watchFolder` task per local folder. `render` computes targets from live data and pokes; tasks and timers never read live data, and the harness fails a mod that does.
   Evidence: `REVIEW.md` Focus fourth bullet; `gpui-kit.d.ts:384,387` (`cx.spawn`, `cx.sleep`); `herdr.d.ts:404-414` (`watchFolder` local only, rejects on large Linux trees).
10. **Intervals.** Local: a watch event refreshes at most once per 1000 ms (leading edge, then trailing), open worktrees also every 30000 ms, a rejected watch every 60000 ms. Remote: every 15000 ms, the selected remote worktree every 1500 ms, all measured start to start. The spec says 2 s for the selected remote worktree; at 2 s start to start an edit just after a read shows after 2 s plus one round trip, which misses done check 1's "within 2 s". Spec change logged below.
   Evidence: spec "Project sidebar", last bullet; done check 1.
11. **Tab bar data.** `bw-tabs` reads `spaces().find(s => s.active).tabs` (`TabInfo`: id, index, name, named, active, status, settled) and each tab's program from `panes()`; drag reorder is press, move, release on another tab, then `tab.move {id, index}` with the target tab's 1-based index. The "+" opens `openOverlay({ mod: "bw-new", kind: "popup", width: 232, … })`.
    Evidence: `herdr.d.ts:86-109,183-207`; `commands.json` `tab.move` requires `id`, `index`; shipped `mods/tabs/main.js:61-66` uses the same press/release pattern.
12. **"+" menu.** `bw-new` shows the cached `shared("bw.known-agents")[machine ?? ""]` at once, then `knownAgents({ on: machine })`, and offers Shell, Claude, Codex (`tab.new {space, name, argv: agent.run}`, disabled with "not installed") and New worktree…, Open worktree… through Herdr's `worktree` dialog with `{space, folder, action}` or, without a space, `{folder, machine, action}`.
    Evidence: `herdr.d.ts:30-34`; `mods/worktree/main.js:1-2,156-158`; `mods/new-menu/main.js:70-71` (dialog sizes 460×280 and 560×480).
13. **`bw-right`.** One mod in four blocks: the 36 px strip (`props: {}`) and three `right-body` stack children (`props: {panel: "changes" | "issues" | "browser"}`) that say "coming in phase N". The strip runs `layout.select {stack: "right-body", child}` and keeps the choice per space in `shared("bw.right.tab")`; phases 4 to 6 swap each block's `mod`.
    Evidence: `AGENTS.md:224-226` (stack), `commands.json` `layout.select {stack, child}`.
14. **Layout and keys.** `layouts/bellwether.json` keeps the column ids `sidebar` (so Herdr's `ctrl-shift-b` and `workspace-chrome`'s footer keep working) and adds `right`. The right sidebar hides with `cmd-alt-b` → `layout.toggle:right` in a `layout:bellwether` section of `keys.json`, merged by `scripts/keys-merge.js`, which prints the diff and refuses a key already bound. The API copy has no default key table; the defaults and examples it documents (`ctrl-shift-b`, `ctrl-shift-l`, `ctrl-shift-t`, `ctrl-shift-o`, `ctrl-shift-f` / Cmd-F, `ctrl-alt-shift-escape`) do not use `cmd-alt-b`, and the window check of `keys()` is owed. No `cmd-j` yet.
    Evidence: `AGENTS.md:59,167,411,479,515`; `AGENTS.md:473-475` (an edited `keys.json` stops receiving new default shortcuts, which the script prints before `--apply`).
15. **AGENTS.md amendment.** Lines 23-24 become: "`exec` returns once, with a 30 s and 8 MiB cap, and nothing streams. Work that watches logs runs in a Rust helper that a mod polls or reads. A mod may watch Git itself with `watchFolder` on the window machine and timers elsewhere, when each Git call is short, read-only (`--no-optional-locks`, `-c core.fsmonitor=false`, `--no-textconv`) and runs on the space's machine with `exec(..., { on })`."
    Evidence: spec "Constraints from Herdr", last bullet; intent amendment log entry "phase 1 amends the AGENTS.md line about watching Git".
16. **Done check 1 here and owed.** Runs now: `bun test shared/` with real `git worktree list` output from repositories `scripts/verify/make-repos.sh` builds, `scripts/verify/projects.sh` locally and with `--machine bwloop`, and an unreachable-machine case. Owed in the window: everything that needs `machines()`, `herdr-app ls`, clicks or a shot (list in Task 11). The "+" part uses New terminal → Codex, since chat entries come in phase 2.
    Evidence: phase plan phase 1 step 7 "Done check 1 (without the chat part of '+')".

## Spec changes (one line each, for the intent file's amendment log)

- Selected remote worktree refresh: 2 s → 1500 ms start to start, so a file edit shows within done check 1's 2 s including one `exec` round trip.
- Done check 1, "+" part: "starts a Codex chat" → "starts Codex from New terminal" until phase 2 adds chat entries; the original wording is kept and rerun in phase 2.

## Global Constraints

- Mods are named `bw-<name>`; the layout `bellwether`; shared state keys start with `bw.`.
- Mods use only names declared in `herdr.d.ts` and `gpui-kit.d.ts`; no `setTimeout`, no DOM, no top-level `await`, no `cx` kept past its callback.
- No mod reads `agents()`, `spaces()`, `panes()`, `terminals()` or `focused()` from a timer or a spawned task; timers are for data only and never shorter than 1000 ms; animation uses `.spin(900)`.
- Every Git call: `--no-optional-locks -c core.fsmonitor=false`; `diff` also `--no-textconv --no-ext-diff`; values reach `sh -c` scripts only as positional arguments; `on: machine` for the space's machine (null = this Mac).
- Every `space.new` a mod runs passes `machine` explicitly: the machine name, or `""` for this Mac (omitted means the focused space's machine for clicks, `AGENTS.md:532-537`).
- Sizes: left 248 px, min 160, max 480; tab bar 32 px; right 360 px, min 280, max 900, hideable; right strip 36 px; "+" menu 232 px wide; agent line 24 px with 11 px text; machine heading 11 px uppercase; project header 13 px semibold with a letter tile; worktree row 13 px branch name with `↑↓` and `+N −M` on the right.
- State icons in theme colours: working a spinning ring in `working`, blocked a question mark in `blocked`, done a check in `done`, idle a hollow ring in `idle`. A folded worktree or project shows its most urgent child.
- Bellwether draws its own SVGs (`mods/bw-projects/icons/`); it references no asset of Herdr's shipped mods. Program icons come from `program.icon` (`icons/…`, written by Herdr).
- Borrowed code (Flockbook stubs) gets its `THIRD_PARTY_NOTICES.md` entry in the same commit.
- Tests live outside `mods/` (sync copies everything in a mod folder into Herdr's home).
- Before every commit: `git diff --cached --stat` lists only the intended files; else `git reset -q` and stage again.
- Conventional commits, about 50-character titles, bodies wrapped at 72.

## Review Focus

1. A space whose terminal is outside any Git repository (home, `/tmp`): it stays reachable, listed under its machine in an "Other spaces" group with its agent lines. Test in Task 3 (`plain spaces outside git keep their agents`).
2. A click on a dimmed worktree or a "+" with no space, on this Mac: `space.new` carries `machine: ""`, never omits it. Tests in Task 9 (`dimmed local row passes machine ""`) and Task 8 (`no space: space.new names this Mac`).
3. A pane whose cwd is spelled differently from Git's path (`/tmp/x` versus `/private/tmp/x`, a trailing slash, a subfolder of a worktree, a worktree nested inside the main checkout's folder): it attaches to the deepest matching worktree by Git's own `--show-toplevel`. Test in Task 3 (`place matches by git top, deepest worktree wins`).
4. A machine that goes offline mid-refresh (an `exec` rejects) or reads `unavailable`: its rows keep their last counts, its heading says offline, no call is started for it until it is ready again. Tests in Task 3 (`offline machine keeps rows`) and Task 4 (`driver: no calls while a machine is unavailable`).
5. The model asking to remember a newly seen project: `setShared("bw.projects")` runs once, not on every render. Test in Task 9 (`remembers a new project once`).

---

## Tasks and waves

Tasks in one wave touch different files and run in parallel T3 worktrees; each wave merges before the next starts.

| Wave | Task | Depends on |
|---|---|---|
| A | 1 Harness | phase 0 merged |
| A | 2 Git layer | phase 0 merged |
| A | 3 Status and project model | phase 0 merged |
| A | 4 Refresh schedule and driver | phase 0 merged |
| A | 5 Layout, keys, AGENTS.md | phase 0 merged |
| B | 6 Shared UI, icons, `bw-right` | 1, 3 |
| B | 7 Done check 1 verify script | 2, 3, 4 |
| C | 8 `bw-tabs` and `bw-new` | 1, 3, 6 |
| C | 9 `bw-projects` | 1, 2, 3, 4, 6 |
| C | 10 `bw-menu` and `bw-add` | 1, 2, 3, 6 |
| D | 11 Phase checks | all |

### Task 1: Headless mod harness (wave A)

**Files:**
- Create: `bunfig.toml`, `scripts/gen-herdr-api.js`, `tests/harness/api.json`, `tests/harness/preload.js`, `tests/harness/herdr-stub.js`, `tests/harness/kit-stub.js`, `tests/harness/cx.js`, `tests/harness/mount.js`, `tests/harness/harness.test.js`, `tests/harness/fixtures/bw-good/main.js`, `tests/harness/fixtures/bw-bad/main.js`, `tests/harness/fixtures/bw-bad-import/main.js`, `tests/mods/render-all.test.js`, `tests/fixtures/live/empty.json`, `tests/fixtures/live/two-machines.json`, `tests/fixtures/live/props.json`
- Modify: `scripts/check.sh`, `scripts/sync.sh` (`--shared-only`), `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Produces `tests/harness/api.json`: `{ source: { herdrApp, gpuiShell, from }, herdr: string[], kit: string[], base: string[], element: string[], commands: { [name]: { args: string[], required: string[] } } }`.
- Produces `tests/harness/herdr-stub.js`: every `api.herdr` name (unfaked ones throw `stub: <name> not faked`); `fake` (live data `machines, spaces, panes, agents, terminals, focused, layout, window, settings, shared, props`, plus `exec(cmd, args, opts)`, `knownAgents(opts)`, `watchFolder(dir)`, `pickFolder()`, `readTextFile`), `log` (`run, exec, shared, overlays, closed, order, notify, live`), `reset()`, `setPhase("init" | "render" | "event" | "task" | "timer")`. Each live getter appends `[name, phase]` to `log.live`. A `globalThis.localStorage` in memory when Bun lacks one.
- Produces `tests/harness/kit-stub.js`: `View`, `div`, `svg`, `image`, gpui-base `h_flex`, `v_flex`, `InputState`, `Input`, `Button`; an element throws `unknown builder method <name>` for names outside `api.element`; helpers `byId(el, id)`, `textOf(el)`, `fire(el, handler, ...args)` (runs with phase `"event"`), `findAll(el, pred)`.
- Produces `tests/harness/cx.js`: `makeCx()` → `{ notify, spawn(body), sleep(ms), timer: { every, after }, focus_handle(), stop_propagation(), notified: number, timers: {ms, fn}[], flush(): Promise<void> }` (`flush` runs spawned bodies with phase `"task"` until idle, at most 100 turns).
- Produces `tests/harness/mount.js`: `mount(name, { props, live, root = "mods" }) → Promise<{ view, cx, el, render(): el, click(id): Promise<el>, tickTimer(i): Promise<void>, log }>` (`click` fires `on_click` on the element with that id, flushes tasks and renders again; `tickTimer` runs the i-th `timer.every` callback with phase `"timer"`); it imports `mods/<name>/main.js`, runs `init` then `flush` then `render`, and after every step throws on: a `log.run` command not in `api.commands` and not `bw-<mod>.<cmd>`, an argument name not in that command's `args`, a missing required argument, an `svg`/`image` path that is neither an existing `mods/bw-*/…` file nor `icons/…`, a live read in phase `task` or `timer`, a `timer.every` under 1000 ms.
- Produces fixture format `tests/fixtures/live/<name>.json`: the `fake` live fields, plus `exec: [{ on, cmd, argsInclude: string[], result: {code, stdout, stderr} | "reject" }]` (first match wins, else code 127) and `knownAgents: { "": [...], "<machine>": [...] }`. `layout` defaults to `layouts/bellwether.json`. `props.json`: `{ "<mod>": [ {…props}, … ] }`.
- Produces `scripts/sync.sh --shared-only`; `scripts/check.sh` stand-in branch.

- [ ] **Step 1:** Write `scripts/gen-herdr-api.js [--from DIR] [--out tests/harness/api.json]`: `herdr` from `export function|interface|type` names in `herdr.d.ts`; `kit`/`base` from `export` names inside `declare module "gpui-kit"` / `"gpui-base"`; `element` from method names (`^\s{4}([a-z_0-9]+)<`) inside `interface NativeElement`; `commands` from `commands.json`; `source` from the d.ts header line and `AGENTS.md`. Run it with `--from docs/drafts/herdr-api`.
- [ ] **Step 2: Write the failing tests** `tests/harness/harness.test.js`:

```js
test("api names cover what phase 1 uses", () => {
  for (const n of ["watchFolder", "knownAgents", "setAgentOrder", "openOverlay", "pickFolder"]) expect(api.herdr).toContain(n);
  for (const m of ["spin", "frames", "on_size_change", "overflow_x_scrollbar", "on_mouse_up", "truncate"]) expect(api.element).toContain(m);
  expect(api.commands["tab.move"].required).toEqual(["id", "index"]);
});
test("unknown builder method throws", () => expect(() => div().flex_one()).toThrow("unknown builder method flex_one"));
const F = "tests/harness/fixtures";
test("a mod importing a name herdr lacks fails to load", async () => expect(mount("bw-bad-import", { root: F })).rejects.toThrow("nothere"));
test("live read in a timer is refused", async () => { const m = await mount("bw-bad", { root: F, props: { case: "timer" } }); await expect(m.tickTimer(0)).rejects.toThrow("live data read from a timer: spaces()"); });
test("misspelled command and bad arg are refused", …);   // props.case "command": run("tab.mvoe"); "arg": run("tab.move", {id, idx})
test("timer under 1 s is refused", …);                    // props.case "fast": cx.timer.every(250, …)
test("good fixture mod mounts, renders, and click logs its run", async () => {
  const m = await mount("bw-good", { root: F, live: live("two-machines") });
  await m.click("go"); expect(m.log.run).toEqual([["space.select", { id: "s1" }]]);
});
```
- [ ] **Step 3:** Run `bun test tests/harness`. Expected: FAIL (modules missing).
- [ ] **Step 4:** Implement the preload (`build.module` per decision 1), the stubs (adapting Flockbook's `herdr.mjs` and `ui.mjs`; add both to `THIRD_PARTY_NOTICES.md` with source path, commit `c0420c7f9a720631108f2d269dcf9f4bd62634ff`, copyright line), `cx.js`, `mount.js`, the two fixtures `empty.json` (no spaces, machine null ready) and `two-machines.json`, which later tasks' tests rely on: machines null and `macmini` ready; space `s1` (active, cwd `/r/alpha`) with tabs `tb1` (agent `t1` working), `tb2` (agent `t2` blocked, named "fix login"), `tb7` (a shell); space `s2` (cwd `/r/alpha-wt/feat`) with tab `tb3` (agent `t3` idle) and a sub-agent terminal `t4` (working, `parent: "t3"`, also in `agents()`); space `macmini/s3` (cwd `/home/u/gamma`) with tab `macmini/tb5` (agent `macmini/t5` done); `exec` answers for `rev-parse`, `worktree list` and the counts script in Git's documented formats (`alpha` with worktrees `/r/alpha`, `/r/alpha-wt/feat` at `+3 −1`, `/r/alpha-wt/detached`; `gamma` with its main only).
- [ ] **Step 5:** Run `bun test tests/harness`. Expected: PASS.
- [ ] **Step 6:** `tests/mods/render-all.test.js`: for each `mods/bw-*/main.js` × each `tests/fixtures/live/*.json` × each props set in `props.json` (default `[{}]`), `mount` succeeds and `render()` returns an element. With no `mods/bw-*` yet it reports zero mods and passes.
- [ ] **Step 7:** `scripts/sync.sh --shared-only` (copy loop, then exit 0 before the app-home check). `scripts/check.sh`: FAIL when a `.shared` name has no copy in its mod; when `herdr-app` is missing, run `bun test tests/harness tests/mods` and print the stand-in line from decision 4.
- [ ] **Step 8:** Run `scripts/check.sh` and `bun test`. Expected: exit 0; the stand-in line says 0 mods.
- [ ] **Step 9: Commit** `test: add a headless harness for Herdr mods`.

### Task 2: Git layer (wave A)

**Files:**
- Create: `shared/git-parse.js`, `shared/git-parse.test.js`, `shared/git.js`, `shared/git.test.js`, `scripts/verify/make-repos.sh`, `tests/fixtures/git/worktree-list.z`, `tests/fixtures/git/status-v2.z`, `tests/fixtures/git/numstat.z`

**Interfaces:**
- Produces `shared/git-parse.js` (pure):
  - `parseWorktrees(stdout: string): Worktree[]`, `Worktree = { path, head: string|null, branch: string|null /* refs/heads/ stripped */, detached: boolean, bare: boolean, locked: boolean, prunable: boolean }`, in Git's order (first is the main checkout).
  - `parsePlace(stdout: string): { commonDir: string, top: string } | null` (two lines from `rev-parse --path-format=absolute --git-common-dir --show-toplevel`).
  - `parseCounts(status: string, numstat: string): Counts`, `Counts = { branch: string|null, detached: boolean, upstream: boolean, ahead: number, behind: number, files: number, added: number, removed: number }` (binary `-` counts 0; rename records `a\tb\t\0old\0new\0`).
  - `export const SEP = "\x1e"`.
- Produces `shared/git.js` (takes Herdr's `exec` as an argument, never uses `cwd`):
  - `readPlace(exec, machine, folder) → Promise<{ ok: true, place } | { ok: false, state: "not_git" | "unreachable" | "failed", message }>` — `exec("git", ["-C", folder, "--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { on: machine })`; `not_git` when stderr matches `/not a git repository/i`.
  - `readWorktrees(exec, machine, commonDir) → Promise<{ ok: true, worktrees: Worktree[] } | { ok: false, state, message }>` — `git --git-dir <commonDir> --no-optional-locks worktree list --porcelain -z`.
  - `readCounts(exec, machine, path) → Promise<{ ok: true, counts: Counts } | { ok: false, state: "missing" | "unreachable" | "failed", message }>` — `exec("sh", ["-c", COUNTS_SCRIPT, "sh", path], { on: machine })`; the fixed script `cd "$1" || exit 3`, then `git --no-optional-locks -c core.fsmonitor=false status --porcelain=v2 --branch -z`, `printf '\036'`, `git --no-optional-locks -c core.fsmonitor=false diff --no-textconv --no-ext-diff --numstat -z HEAD 2>/dev/null`; exit 3 → `missing`. A rejected `exec` → `unreachable` in all three.
- Produces `scripts/verify/make-repos.sh <root>`: builds under `<root>`: `alpha` (bare `alpha-origin.git`, main checkout `alpha` one commit ahead of `origin/main`, worktree `alpha-wt/feat` on branch `feat`, a detached worktree `alpha-wt/detached`, a worktree `alpha/.worktrees/nested` inside the main checkout folder, one tracked file edited in `feat` with 3 added and 1 removed line), `beta` (main checkout only, never opened), `gamma` (empty repo, no commits). Prints the `alpha` and `beta` common dirs. Idempotent: refuses a non-empty `<root>` it did not make (marker file `.bw-verify`).

- [ ] **Step 1: Write the failing tests** in `shared/git-parse.test.js`, on the committed `.z` fixtures (captured from `make-repos.sh` output, paths rewritten to `/r`):

```js
test("worktrees: main first, branch stripped, detached and nested kept", () => {
  const w = parseWorktrees(read("worktree-list.z"));
  expect(w.map(x => [x.path, x.branch, x.detached])).toEqual([["/r/alpha", "main", false], ["/r/alpha-wt/feat", "feat", false], ["/r/alpha-wt/detached", null, true], ["/r/alpha/.worktrees/nested", "nested", false]]);
});
test("counts: ahead, behind, lines; binary and rename", () => expect(parseCounts(read("status-v2.z"), read("numstat.z"))).toEqual({ branch: "feat", detached: false, upstream: true, ahead: 1, behind: 0, files: 3, added: 3, removed: 1 }));
test("place: two absolute lines", …);  test("place: empty output is null", …);  test("empty numstat (unborn HEAD) is zero lines", …);
```

  and in `shared/git.test.js`, against real repositories (`make-repos.sh` into a temp dir, `exec` implemented with `Bun.spawn`, `machine` null):

```js
test("real worktree list equals what make-repos made", …);   // 4 paths, branches as above
test("place resolves /tmp spelling to git's top", …);         // readPlace on "/tmp/…/alpha-wt/feat/sub" → top "/private/tmp/…/alpha-wt/feat"
test("counts for the edited worktree: +3 −1", …);
test("removed folder is missing", …);  test("non-repo folder is not_git", …);  test("rejected exec is unreachable", …);
test("no call writes under the common dir", …);               // mtime and file list of alpha/.git unchanged across all three reads
```

- [ ] **Step 2:** Run `bun test shared/git`. Expected: FAIL.
- [ ] **Step 3:** Implement `make-repos.sh`, `git-parse.js`, `git.js`. Capture the `.z` fixtures from `make-repos.sh` output.
- [ ] **Step 4:** Run `bun test shared/git`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): read worktrees and counts from git`.

### Task 3: Status ranking and the project model (wave A)

**Files:**
- Create: `shared/status.js`, `shared/status.test.js`, `shared/projects-model.js`, `shared/projects-model.test.js`, `tests/fixtures/model/*.json`

**Interfaces:**
- Consumes (by shape only): `Worktree`, `Counts` from Task 2.
- Produces `shared/status.js`: `RANK = { idle: 0, working: 1, done: 2, blocked: 3 }`, `worst(statuses: (Status|null)[]): Status|null`.
- Produces `shared/projects-model.js` (pure, no Herdr imports):
  - `placeKey(machine, folder)`, `projectKey(machine, commonDir)`, `worktreeKey(machine, path)`: `JSON.stringify([machine ?? null, value])`.
  - `placeOf(space, panes): string` — the first pane in the space's tabs with a `cwd`, else `space.folder`.
  - `readStored(value): Stored[]`, `Stored = { machine: string|null, commonDir, name, main: string|null }`; `shared("bw.projects")` holds `{ version: 1, projects: Stored[] }`; anything else reads as `[]`.
  - `rememberProjects(value, adds: Stored[]) → { version: 1, projects }`, `forgetProject(value, key) → { version: 1, projects }`.
  - `buildProjects(input: ModelInput): ProjectTree`, where

```ts
ModelInput = { machines, spaces, panes, agents, terminals, stored: Stored[], platform: "macos" | "linux" | "windows",
  git: { places: { [placeKey]: { commonDir, top } | "not_git" },
         worktrees: { [projectKey]: { list: Worktree[], stale: boolean } },
         counts: { [worktreeKey]: Counts & { stale: boolean } },
         unreachable: string[] } }
ProjectTree = { machines: MachineNode[], agentOrder: string[], remember: Stored[] }
MachineNode = { name: string|null, label /* "This Mac" | "This computer" | name */, state: "ready" | "loading" | "offline" | "not_connected",
  projects: ProjectNode[], plain: PlainSpace[] }
ProjectNode = { key, machine, commonDir, name, letter, main: string|null, open: boolean, status: Status|null, checked: boolean, worktrees: WorktreeNode[] }
WorktreeNode = { key, path, branch: string|null, detached, prunable, main: boolean, open: boolean, spaces: string[], counts: Counts|null, stale: boolean, status: Status|null, agents: AgentLine[] }
PlainSpace = { id, name, active, status, agents: AgentLine[] }
AgentLine = { address, space, tab, title, status, program, subagents: number, requests: number, changedAt: number|null }
```

  - `refreshTargets(tree, input, activeSpaceId): Target[]`, `Target = { key, kind: "place" | "list" | "counts" | "helper", machine: string|null, path: string, open: boolean, selected: boolean, wakeOn: string[] }`: a `place` target per space place with no `git.places` entry; a `list` per project on a machine that is not offline; a `counts` per worktree (not prunable); a `helper` per ready machine other than this Mac. `wakeOn` is local only: list → `[commonDir]`, counts → `[path]` when open, plus `[commonDir]`. `selected` is the worktree holding the active space.

  Rules the tests pin: machines in `machines()` order (this Mac first), plus machines named only by stored projects (`not_connected`); `offline` when `layout === "unavailable"` or the name is in `git.unreachable`, `loading` when `"loading"`. A project's name is the main checkout's folder name, else the common dir's name without `.git`; `letter` its first character uppercased. Projects sort by name then common dir; worktrees: main first, then branch or path. A space attaches to the worktree whose path equals `git.places[place].top`; places nested in two worktrees take the longest path. Agent lines follow `agents()` order; an agent whose terminal has a `parent` in `terminals()` is counted in its parent's `subagents` instead of getting a line (a bare parent address is qualified with the child's `<machine>/` prefix). Title: `tab_name` when the tab is named, else `title`. `changedAt` from the tab's `changed_at`. `requests` is 0 until phase 3. A folded node's status is `worst` of its children. `remember` lists projects seen in open spaces and missing from `stored`.

- [ ] **Step 1: Write the failing tests**:

```js
test("rank: blocked > done > working > idle", () => { expect(worst(["idle", "done", "working"])).toBe("done"); expect(worst([null, "blocked", "done"])).toBe("blocked"); expect(worst([null])).toBe(null); });
test("three projects under two machines, closed one kept", …);    // fixture: alpha open + beta stored on null, gamma on macmini
test("worktree rows equal the worktree list, main first", …);
test("place matches by git top, deepest worktree wins", …);       // cwd "/tmp/r/alpha/.worktrees/nested/src" with top "/private/tmp/r/alpha/.worktrees/nested"
test("two spaces in one worktree: both agents, worktree open", …);
test("plain spaces outside git keep their agents", …);            // place "not_git" → MachineNode.plain
test("sub-agent counted on its parent, no line of its own", …);
test("folded project shows its most urgent child", …);
test("offline machine keeps rows", …);                            // layout "unavailable": state "offline", counts kept, stale true
test("stored project on an unknown machine is not_connected", …);
test("remember lists only new projects", …);
test("readStored tolerates null, arrays and junk", …);
test("targets: place first-seen only, no list for an offline machine, selected remote worktree", …);
test("targets: wakeOn only for this Mac", …);
```

- [ ] **Step 2:** Run `bun test shared/status shared/projects-model`. Expected: FAIL.
- [ ] **Step 3:** Implement `status.js` and `projects-model.js`.
- [ ] **Step 4:** Run the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): build the project tree from live data`.

### Task 4: Refresh schedule and driver (wave A)

**Files:**
- Create: `shared/refresh-schedule.js`, `shared/refresh-schedule.test.js`, `shared/refresh-driver.js`, `shared/refresh-driver.test.js`

**Interfaces:**
- Consumes (by shape only): `Target` from Task 3.
- Produces `shared/refresh-schedule.js` (pure; every method takes `now` in ms):
  - `TIMES = { throttle: 1000, openLocal: 30000, rejected: 60000, remote: 15000, selectedRemote: 1500 }`.
  - `createSchedule(times = TIMES) → { setTargets(targets, now): boolean, watchedFolders(): string[], event(folder, paths, now), rejected(folder, now), next(now): Target | null, start(key, now), finish(key, now, { ok }?), wakeIn(now): number | null, inFlight(machine): boolean }`.
  - Rules: a new target is due at once; `place` and `helper` targets run once after a success, and after a failed run (`finish` with `ok: false`) again at `lastStart + openLocal` on this Mac or `lastStart + remote` elsewhere, never under 1000 ms; an event marks every target whose `wakeOn` contains a changed path (a batch holding the watched folder itself marks all its targets) and makes it due at `max(now, lastStart + throttle)`; an event during a call marks it again after `finish`; local open counts also at `lastStart + openLocal`; a target with a rejected folder at `lastStart + rejected`; remote at `lastStart + remote`, the selected remote worktree at `lastStart + selectedRemote`; local list and closed counts have no timer. `next` honours one call in flight per machine and orders `place`, selected counts, open counts, `list`, closed counts, `helper`. `watchedFolders` drops a folder inside another watched folder.
- Produces `shared/refresh-driver.js`:
  - `runRefresher(cx, { schedule, run, onResult, watchFolder, now = Date.now, alive = () => true }) → Promise<void>`, where `cx` is the loop task's own `{ spawn, sleep, notify }`, `run(target) → Promise<result>` and `onResult(target, result) → boolean` (true when the shown data changed). The loop: start every `next()` target and pass `finish` the result's `ok`, then `await Promise.race([cx.sleep(wakeIn ?? 60000), poked])`; drain finished results and call `cx.notify()` once when any `onResult` returned true; spawn one `watchFolder` task per new `watchedFolders()` entry that only calls `schedule.event` or `schedule.rejected` and pokes. A folder whose watch rejected gets no new watch, and stays reported to `schedule.rejected`, until it leaves `watchedFolders()`.
  - `createPoke() → { poke(): void, wait(): Promise<void> }` for `render` to wake the loop without a `cx`.

- [ ] **Step 1: Write the failing tests** (fake clock):

```js
test("new target is due now; place runs once", …);
test("events throttle to one refresh per second, then trailing", () => {
  const s = createSchedule(); s.setTargets([counts("/r/alpha", { wakeOn: ["/r/alpha"] })], 0);
  s.start(K, 0); s.finish(K, 50); s.event("/r/alpha", ["/r/alpha/a.txt"], 100); s.event("/r/alpha", ["/r/alpha/b.txt"], 300);
  expect(s.next(500)).toBe(null); expect(s.next(1000).key).toBe(K); expect(s.wakeIn(400)).toBe(600);
});
test("open local worktree backstop at 30 s; closed local has no timer", …);
test("rejected watch falls back to 60 s", …);
test("remote every 15 s; selected remote every 1.5 s start to start", …);
test("event during a call reruns it after finish", …);
test("one call in flight per machine, selected first", …);
test("nested folder is not watched twice", …);
test("dropped target stops", …);
test("driver: no calls while a machine is unavailable", …);   // targets for it removed → run never called for it
test("driver: rejected exec result is passed on and the loop goes on", …);
test("driver: notify once per drain, only when onResult says changed", …);
test("driver: a watch reject schedules the 60 s fallback", …);
test("driver: render poke wakes the loop before wakeIn", …);
```

- [ ] **Step 2:** Run `bun test shared/refresh`. Expected: FAIL.
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** Run `bun test shared/refresh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): schedule git refreshes without polling`.

### Task 5: Layout, keys and the AGENTS.md amendment (wave A)

**Files:**
- Modify: `layouts/bellwether.json`, `AGENTS.md:23-24`
- Create: `keys/bellwether.json`, `scripts/keys-merge.js`, `tests/layout.test.js`, `tests/keys-merge.test.js`

**Interfaces:**
- Produces layout node ids other tasks use: `sidebar` (column), `projects` (block, `bw-projects`), `sidebar-footer` (block, `workspace-chrome` `{footer: true}`), `work`, `tabs` (block, `bw-tabs`), `main` (`{ "tab": "active" }`), `status` (`workspace-status`), `right` (column), `right-strip` (block, `bw-right` `{}`), `right-body` (stack, active `changes`), `changes` | `issues` | `browser` (blocks, `bw-right` `{panel: id}`).
- Produces `keys/bellwether.json`: `{ "layout:bellwether": { "cmd-alt-b": "layout.toggle:right" } }`.
- Produces `scripts/keys-merge.js [--apply] [--home DIR]` and its pure export `mergeKeys(user: object|null, ours: object) → { merged, added: [section, key, action][], same: [...], conflicts: [section, key, theirs, ours][], shadowed: [section, key, action][] }` (`shadowed`: the same key bound in the user's `terminal` section, which wins while a terminal has focus).

- [ ] **Step 1: Write the failing tests**:

```js
test("layout sizes and ids follow the spec", () => {
  const L = readLayout();
  expect(L.cloned_from).toEqual({ name: "main", version: "0.1.13" });
  expect(node(L, "sidebar")).toMatchObject({ size: { px: 248 }, min: 160, max: 480 });
  expect(node(L, "projects").content).toEqual({ mod: "bw-projects" });
  expect(node(L, "tabs")).toMatchObject({ size: { px: 32 }, window_drag: true, content: { mod: "bw-tabs" } });
  expect(node(L, "main").content.tab).toBe("active");
  expect(node(L, "status").content).toEqual({ mod: "workspace-status" });
  expect(node(L, "right")).toMatchObject({ size: { px: 360 }, min: 280, max: 900 });
  expect(node(L, "right-strip")).toMatchObject({ size: { px: 36 }, content: { mod: "bw-right" } });
  expect(node(L, "right-body")).toMatchObject({ type: "stack", active: "changes" });
  expect(["changes", "issues", "browser"].map(id => node(L, id).content)).toEqual(["changes", "issues", "browser"].map(panel => ({ mod: "bw-right", props: { panel } })));
  expect(new Set(allMods(L).filter(m => !m.startsWith("bw-")))).toEqual(new Set(["workspace-chrome", "workspace-status", "pane"]));
});
test("merge adds our section into an empty file", …);
test("merge keeps the user's other keys and sections", …);
test("same binding is a no-op", …);
test("a key bound to something else is a conflict and nothing is written", …);
test("a terminal-section binding is reported as shadowed", …);
```

- [ ] **Step 2:** Run `bun test tests/layout.test.js tests/keys-merge.test.js`. Expected: FAIL.
- [ ] **Step 3:** Edit `layouts/bellwether.json`: keep the root's `titlebar`, `traffic_lights`, `background`, `terminal_padding`, `divider`, `cloned_from`; root row children `sidebar` (column, `background: "chrome"`, `resizable` default, children `projects` and `sidebar-footer` 69 px), `work` (column: `tabs` 32 px `window_drag`, `main` with main.json's pane frame and `pane` header unchanged, `status` 28 px), `right` (column, `background: "chrome"`, children `right-strip` and `right-body`). Drop `brand`, `spaces`, `agents`, Herdr's `panel`/`files`/`changes`.
- [ ] **Step 4:** Write `keys/bellwether.json` and `scripts/keys-merge.js`: reads `<home>/keys.json` (default `$HERDR_APP_HOME`, else `~/.config/herdr-app`), prints the before and after of each touched section, `added`, `same`, `conflicts`, `shadowed`, and the line "Herdr stops adding new default shortcuts to an edited keys.json (AGENTS.md, Keys)". Exits 1 on any conflict. `--apply` without conflicts copies the file to `keys.json.bw-<unix time>` and writes atomically (write a temp file beside it, then rename).
- [ ] **Step 5:** Run the tests. Expected: PASS.
- [ ] **Step 6:** Replace `AGENTS.md:23-24` with decision 15's text.
- [ ] **Step 7: Commit** `feat(layout): three columns and the right-sidebar key` (layout, keys, script, tests, AGENTS.md).

### Task 6: Shared UI pieces, icons and `bw-right` (wave B)

**Files:**
- Create: `shared/ui.js`, `tests/ui.test.js`, `mods/bw-projects/icons/{ring,ring-spin,check,question,plus,close,branch,server,monitor,chevron-right,chevron-down,more,terminal}.svg`, `mods/bw-right/main.js`, `mods/bw-right/choice.js`, `mods/bw-right/mod.json`, `mods/bw-right/.shared`, `tests/mods/bw-right.test.js`
- Modify: `tests/fixtures/live/props.json` (add `bw-right` props sets)

**Interfaces:**
- Consumes: Task 1 harness; Task 3 `RANK`, `worst`.
- Produces `shared/ui.js` (imports `gpui-kit`): `ICONS` (`mods/bw-projects/icons/<name>.svg` paths), `statusIcon(t, status, size = 12)` (working: `svg(ICONS["ring-spin"]).spin(900)` in `t.working`; blocked `question` in `t.blocked`; done `check` in `t.done`; idle `ring` in `t.idle`; null an empty `size×size` box), `programIcon(program, t, size = 14)` (`svg` tinted `t.muted` when `program.tint`, else `image`; no icon → `ICONS.terminal`), `machineTag(name, t)` (10 px text, 1 px `t.border` border, radius 4, px 4), `ago(ms, now): "now" | "<n>m" | "<n>h" | "<n>d"`.
- Produces `mods/bw-right/choice.js`: `PANELS = [{ id: "changes", label: "Changes", phase: 5 }, { id: "issues", label: "Issues", phase: 6 }, { id: "browser", label: "Browser", phase: 4 }]`; `chosen(stored, spaceId): id` (default `"changes"`); `choose(stored, spaceId, id, liveSpaceIds): stored'` (drops ids not live); `wanted(stored, spaceId, layoutActive): id | null` (the id to select, null when the layout already shows it).
- `bw-right` with `props().panel` draws `"<label>: coming in phase <phase>"` centred in `t.dim`; with no panel it draws the 36 px strip of three labelled tabs (selected one `t.selected`), click → `run("layout.select", { stack: "right-body", child: id })` and `setShared("bw.right.tab", choose(…))`; `render` runs `layout.select` once when `wanted(…)` is not null (it reads `right-body`'s `active` from `layout()`). `.shared`: `ui`.

- [ ] **Step 1: Write the failing tests**: `tests/ui.test.js` (`working spins at 900 in working colour`, `null status is an empty box`, `ago: 59 s now, 3 min 3m, 2 h 2h, 4 d 4d`, `tinted program icon is an svg`); `tests/mods/bw-right.test.js`:

```js
test("panel copy names its phase", async () => expect(textOf((await mount("bw-right", { props: { panel: "browser" } })).el)).toContain("Browser: coming in phase 4"));
test("strip click selects and remembers per space", async () => {
  const m = await mount("bw-right", { live: live("two-machines") }); await m.click("right-tab-issues");
  expect(m.log.run).toContainEqual(["layout.select", { stack: "right-body", child: "issues" }]);   // strip tabs have ids right-tab-<id>
  expect(m.log.shared.at(-1)).toEqual(["bw.right.tab", { s1: "issues" }]);
});
test("switching to a space restores its tab once", …);   // render twice: one layout.select
test("stored ids of closed spaces are dropped", …);
```

- [ ] **Step 2:** Run `bun test tests/ui.test.js tests/mods/bw-right.test.js`. Expected: FAIL.
- [ ] **Step 3:** Draw the SVGs (16×16 view box, one colour, `currentColor`), implement `ui.js`, `choice.js`, `main.js`, `mod.json` `{"place":"none","title":"Right sidebar"}`, `.shared`; run `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS; the stand-in line says 1 mod.
- [ ] **Step 5: Commit** `feat(bw-right): add the right sidebar shell`.

### Task 7: Done check 1 verify script (wave B)

**Files:**
- Create: `scripts/verify/projects.sh`, `scripts/verify/projects-run.js`

**Interfaces:**
- Consumes: Task 2 `readPlace`, `readWorktrees`, `readCounts`, `make-repos.sh`; Task 3 `buildProjects`, `refreshTargets`; Task 4 `createSchedule`, `runRefresher`; Task 9's `openWorktree` action shape `["space.new", { folder, machine }]` (re-derived here from the tree, not imported).
- Produces `scripts/verify/projects.sh [--offline] [--machine M]`: prints `PASS <name>` or `FAIL <name>: <why>` per check and exits nonzero on any FAIL; removes only the scratch roots it made (marker `.bw-verify`). Local root `/private/tmp/bw-verify-projects`; remote root `$HOME/bw-verify/projects` on `M` (the script is sent with `hc exec --on M sh -c "<script>" sh <root>`). `--offline` runs the local checks and the unreachable check only.
- `projects-run.js` builds the model with an `exec` that runs argv locally (`Bun.spawn`) or as `hc exec --on M <cmd> <args…>`; `alpha` and `beta` local, `gamma` on `M` (or local under another root with `--offline`); open spaces are synthetic `SpaceInfo`/`PaneInfo` records whose cwd is a worktree path.

Checks:
- `three-projects`: the tree lists `alpha` and `beta` under this Mac and `gamma` under `M`; `beta` has no open worktree.
- `rows-equal-git`: for each project, `[path, branch]` of its worktree rows equals an independent `awk` parse of `git worktree list --porcelain` (no `-z`) run on that machine.
- `dimmed-row-opens-exactly`: `alpha-wt/detached` (closed) maps to `["space.new", { folder: "<its exact path>", machine: "" }]`; `gamma`'s main to `machine: "M"`.
- `counts-within-2s`: append 2 lines to a tracked file in the selected worktree (local `feat`, and `gamma` on `M` as selected remote), run the real schedule and driver with Bun's timers (`fs.watch` stands in for `watchFolder` locally), and PASS when the counts change within 2000 ms of the write.
- `unreachable-named`: an `exec` for machine `bw-unreachable` that rejects, with `machines()` saying `ready`, gives heading state `offline` and keeps the stored project's rows.

- [ ] **Step 1:** Write `projects.sh` and `projects-run.js` with every check reporting FAIL until implemented; run `scripts/verify/projects.sh --offline`. Expected: FAIL lines.
- [ ] **Step 2:** Implement. Run `scripts/verify/projects.sh --offline` and `scripts/verify/projects.sh --machine bwloop`. Expected: every line PASS; `ls /private/tmp/bw-verify-projects` and `hc exec --on bwloop ls bw-verify` show the roots removed.
- [ ] **Step 3: Commit** `test: verify the project tree against git`.

### Task 8: `bw-tabs` and `bw-new` (wave C)

**Files:**
- Create: `mods/bw-tabs/main.js`, `mods/bw-tabs/model.js`, `mods/bw-tabs/mod.json`, `mods/bw-tabs/.shared`, `mods/bw-new/main.js`, `mods/bw-new/entries.js`, `mods/bw-new/mod.json`, `mods/bw-new/.shared`, `tests/mods/bw-tabs.test.js`, `tests/mods/bw-new.test.js`, `tests/fixtures/live/remote-active.json`
- Modify: `tests/fixtures/live/props.json` (`bw-new`: `{space: "s1"}`, `{space: "macmini/s3"}`, `{machine: null, folder: "/r/beta"}`)

**Interfaces:**
- Consumes: Task 6 `statusIcon`, `programIcon`, `machineTag`, `ICONS`; Task 3 `placeOf`.
- Produces `mods/bw-tabs/model.js`: `tabItems(space, panes) → { id, index, title, program: Program|null, status, active, settled }[]` (program: the tab's agent pane's, else its first pane's; title: `name` when `named`, else `program.name`, else `"Terminal"`); `moveIndex(items, fromId, overId) → number | null` (the 1-based `index` of `overId`; null when the same tab).
- `bw-tabs` render: 32 px bar in `t.chrome` with a bottom border; each tab: program icon, title (max 170 px, truncated), `statusIcon`, `machineTag(space.machine)` when the space is remote, close button when active (`tab.close {id}`); element ids `tab-<id>`, `close-<id>`, `tab-new`; settled tabs at 0.6 opacity; press, move and release reorder (`tab.move {id, index}`), a plain click selects (`tab.select {id}`); every control stops mouse-down propagation (the block is `window_drag`); left padding 76 px when the `sidebar` node is hidden on macOS with `titlebar: "none"` and not fullscreen, else 8. "+" → `openOverlay({ mod: "bw-new", kind: "popup", width: 232, height: 300, props: space ? { space: space.id } : { machine: null, folder: home() } })`. `.shared`: `ui`, `status`, `projects-model`.
- Produces `mods/bw-new/entries.js`: `menuEntries({ agents: KnownAgent[] | null, failed: boolean, ctx: { space: string|null, machine: string|null, folder: string|null } }) → Row[]`, `Row = { id, section: "New terminal" | "Worktree", label, enabled, hint, action: ["run", cmd, args] | ["overlay", OverlaySpec] }`:
  - `shell` "Shell": `["tab.new", { space }]`, or without a space `["space.new", { folder, machine: machine ?? "" }]`.
  - `claude` "Claude", `codex` "Codex": the agent with that `key`; `["tab.new", { space, name: agent.name, argv: agent.run }]`, or `["space.new", { folder, machine: machine ?? "", tab: agent.name, argv: agent.run }]`; disabled with hint `"not installed"` when `installed` is false or the key is missing, `"checking…"` while `agents` is null, `"could not check"` when `failed`.
  - `worktree-new` "New worktree…", `worktree-open` "Open worktree…": `["overlay", { mod: "worktree", kind: "dialog", width: 460 | 560, height: 280 | 480, props: space ? { space, folder, action } : { folder, machine, action } }]`; disabled without a folder.
- `bw-new` init: `this.agents = shared("bw.known-agents")?.[machine ?? ""] ?? null`, then a task runs `knownAgents({ on: machine })` and stores it back under that key. Render: 232 px column in `t.popover`, section headings 11 px `t.dim`, 30 px rows; a click closes the overlay, then acts. `ctx` from props: `{space}` → that space's `machine` and `placeOf(space, panes())`; or `{machine, folder}` as given. `.shared`: `ui`, `projects-model`.

- [ ] **Step 1: Write the failing tests**:

```js
test("tab items: named title, else program name, agent pane's icon", …);
test("moveIndex: drop on third tab gives its index; same tab null", …);
test("drag reorders with tab.move", async () => { /* on_mouse_down on tab-tb1, on_mouse_move and on_mouse_up on tab-tb7 */ expect(m.log.run).toEqual([["tab.move", { id: "tb1", index: 3 }]]); });
test("remote space tabs carry the machine tag", …);           // remote-active.json: text contains "macmini"
test("close button only on the active tab", …);
test("+ opens bw-new at 232 px with the space", …);
test("entries: codex on the remote space starts there", () => expect(row("codex", { agents: [codex(true)], ctx: { space: "macmini/s3", machine: "macmini", folder: "/home/u/gamma" } }).action).toEqual(["run", "tab.new", { space: "macmini/s3", name: "Codex", argv: ["codex"] }]));
test("no space: space.new names this Mac", () => expect(row("shell", { ctx: { space: null, machine: null, folder: "/r/beta" } }).action).toEqual(["run", "space.new", { folder: "/r/beta", machine: "" }]));
test("not installed and checking hints", …);
test("worktree entries pass Herdr's dialog props", …);
test("bw-new shows cached agents then knownAgents for the space's machine", async () => { /* log.exec empty; fake.knownAgents called with { on: "macmini" } */ });
```

- [ ] **Step 2:** Run `bun test tests/mods/bw-tabs.test.js tests/mods/bw-new.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement both mods (`mod.json` `{"place":"none","title":"Tabs"}` and `{"place":"none","overlay":{"width":232,"height":300}}`), `.shared` files; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-tabs): tab bar and the + menu`.

### Task 9: `bw-projects` (wave C)

**Files:**
- Create: `mods/bw-projects/main.js`, `mods/bw-projects/rows.js`, `mods/bw-projects/actions.js`, `mods/bw-projects/run-git.js`, `mods/bw-projects/mod.json`, `mods/bw-projects/.shared`, `tests/mods/bw-projects.test.js`, `tests/mods/bw-projects-actions.test.js`, `tests/fixtures/live/offline.json`

**Interfaces:**
- Consumes: Task 2 `readPlace`, `readWorktrees`, `readCounts`; Task 3 `buildProjects`, `refreshTargets`, `rememberProjects`, `readStored`; Task 4 `createSchedule`, `runRefresher`, `createPoke`; Task 6 `ui.js`, `ICONS`; phase 0 `createHelper({ exec, localInstall })`, `Helper.ensure(machine)`.
- Produces `mods/bw-projects/actions.js` (pure, returns what to run):
  - `openWorktree(node: WorktreeNode, machine) → [cmd, args][]`: open → `[["space.select", { id: node.spaces[0] }]]`; closed → `[["space.new", { folder: node.path, machine: machine ?? "" }]]`; prunable → `[]`.
  - `focusAgent(a: AgentLine) → [["space.select", { id: a.space }], ["tab.select", { id: a.tab }], ["agent.focus", { terminal: a.address }]]`.
  - `projectMenu(p: ProjectNode) → OverlaySpec` (`{ mod: "bw-menu", kind: "popup", width: 220, props: { project: { key, machine, commonDir, main, name, open } } }`).
  - `addProject() → OverlaySpec` (`{ mod: "bw-add", kind: "dialog", width: 420, height: 220 }`).
  - `newInMain(p) → OverlaySpec` (`{ mod: "bw-new", kind: "popup", width: 232, height: 300, props: { machine: p.machine, folder: p.main } }`).
- Produces `mods/bw-projects/run-git.js`: `makeRun({ exec, helper }) → (target) → Promise<result>` dispatching `place` → `readPlace`, `list` → `readWorktrees`, `counts` → `readCounts`, `helper` → `helper.ensure`.
- `main.js`: `init` makes the schedule, poke, helper (`localInstall(machine)` runs `<home()>/.local/share/bellwether/helper/current/bw machine install <machine>` and parses its lines with phase 0's `parseLines`), the Git cache `this.git` (Task 3's `git` shape) and helper states, then `cx.spawn(cx => runRefresher(cx, …))`; `onResult` merges into `this.git` (an `unreachable` state adds its machine to `git.unreachable`, any success removes it) and returns whether it changed; one `cx.timer.every(60000, …)` calls `cx.notify()` only when the last render drew a time (`this.showsTime`), reading no live data. Element ids: `add-project`, `machine-<name or local>`, `project-<key>`, `worktree-<key>`, `agent-<address>`. `render` reads live data, builds the tree, calls `setAgentOrder(tree.agentOrder)`, `setShared("bw.projects", rememberProjects(…))` only when `tree.remember` is non-empty, sets the schedule's targets and pokes when they changed, and draws: a 46 px header (76 px left padding on macOS with `titlebar: "none"`, not fullscreen; "Add project" button), then per machine a 24 px heading (11 px uppercase `t.dim`, state words `offline`, `connecting…`, `not connected`, `setting up Bellwether`, `Bellwether helper: <message>`), 30 px project headers (18 px letter tile, 13 px semibold name, worst status when folded, hover "+" → `newInMain`, "⋯" and right-click → `projectMenu`), 28 px worktree rows (branch icon, 13 px branch or `detached`, right side `↑a ↓b` in `t.ansi2`/`t.ansi1` and `+N −M`; closed rows at 0.55 opacity; prunable rows say `missing`), 24 px agent lines (11 px: status icon, program icon, title, `+N`, request badge when `requests > 0`, `ago(changedAt)`), and the "Other spaces" group. Fold state per machine, project and worktree in `localStorage` key `bw-projects.folded`. Below 160 px wide (`on_size_change`) it draws a rail: one letter tile per project with its worst status; a click opens its first open worktree. `close()` sets `alive` false. `.shared`: `status`, `projects-model`, `git-parse`, `git`, `refresh-schedule`, `refresh-driver`, `helper`, `ui`.

- [ ] **Step 1: Write the failing tests** `tests/mods/bw-projects-actions.test.js` (`dimmed local row passes machine ""`, `dimmed remote row names its machine`, `open row selects its first space`, `prunable row does nothing`, `agent click selects space, tab, then agent.focus`) and `tests/mods/bw-projects.test.js` (harness, fake `exec` from fixtures):

```js
test("renders machines, projects, worktrees and agent lines from two-machines", …); // text has "THIS MAC", "MACMINI", "alpha", "feat", "+3 −1"
test("agent order follows the drawn lines", async () => expect(m.log.order).toEqual(["t1", "t2", "t3", "macmini/t5"]));   // t4 counts as t3's +1
test("remembers a new project once", async () => { m.render(); m.render(); expect(m.log.shared.filter(([k]) => k === "bw.projects")).toHaveLength(1); });
test("clicking a dimmed row runs space.new with that folder", …);
test("offline heading keeps rows, no exec for that machine", …);    // offline.json
test("git runs only from tasks, live data only from render", …);   // harness phase checks pass; every log.exec entry has the read-only flags
test("helper state shows setting up Bellwether on macmini", …);    // fake exec for bw version → exit 127, install pending
test("rail below 160 px draws letter tiles", …);
```

- [ ] **Step 2:** Run `bun test tests/mods/bw-projects*`. Expected: FAIL.
- [ ] **Step 3:** Implement the four modules, `mod.json` `{"place":"none","title":"Projects"}`, `.shared`; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-projects): projects, worktrees and agent lines`.

### Task 10: `bw-menu` and `bw-add` (wave C)

**Files:**
- Create: `mods/bw-menu/main.js`, `mods/bw-menu/mod.json`, `mods/bw-menu/.shared`, `mods/bw-add/main.js`, `mods/bw-add/mod.json`, `mods/bw-add/.shared`, `tests/mods/bw-menu.test.js`, `tests/mods/bw-add.test.js`
- Modify: `tests/fixtures/live/props.json` (`bw-menu`, `bw-add` props sets)

**Interfaces:**
- Consumes: Task 3 `readStored`, `rememberProjects`, `forgetProject`, `projectKey`; Task 2 `readPlace`; Task 6 `ICONS`; Task 9's `projectMenu` and `addProject` props.
- `bw-menu` (`props: { project, overlay }`): rows New worktree… and Open worktree… (Herdr's `worktree` dialog with `{ folder: project.main, machine: project.machine, action }`, sizes as Task 8), "Link Linear project" disabled with hint "phase 6", Remove (enabled only when `project.open` is false, else hint "close its spaces first"; runs `setShared("bw.projects", forgetProject(…, project.key))`). Each click closes the overlay first.
- `bw-add` (`props: { overlay }`): machine choice (this Mac plus each `machines()` entry with `layout === "ready"`), a path `Input`, "Choose…" only for this Mac (`pickFolder({ prompt: "Add project" })`), Add → `readPlace(exec, machine, path)`: `not_git` → "Not a Git repository", `unreachable` → "<machine> is not reachable", ok → `rememberProjects` with `{ machine, commonDir, name, main }` (main from `top` when the place is the main checkout, else the common dir's parent when it ends in `/.git`), close.

- [ ] **Step 1: Write the failing tests**: `remove forgets exactly that key`, `remove is disabled while the project is open`, `worktree rows pass folder and machine`, `add on this Mac uses pickFolder and remembers`, `add on macmini runs rev-parse there`, `not a repository is named and nothing is stored`, `unreachable machine is named`.
- [ ] **Step 2:** Run `bun test tests/mods/bw-menu.test.js tests/mods/bw-add.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement both mods (`mod.json` `{"place":"none"}`), `.shared` (`projects-model`, `git-parse`, `git`, `ui`); `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-projects): add, remove and worktree menu`.

### Task 11: Phase checks (main checkout, after waves A to C)

- [ ] **Step 1:** Merge the wave C branches; resolve `tests/fixtures/live/props.json` by keeping every side's entries; `scripts/sync.sh --shared-only`; `git status` shows no changed shared copy.
- [ ] **Step 2:** Run `scripts/test.sh`, `bun test shared/`, `scripts/verify/projects.sh --machine bwloop`. Expected: exit 0 each; `check.sh` prints the stand-in line for 6 mods.
- [ ] **Step 3:** Update `README.md` (status line, the `keys/` folder, `scripts/keys-merge.js`, `scripts/sync.sh --shared-only`) with `doc-updater`.
- [ ] **Step 4:** Append to `docs/drafts/herdr-window-checks.md` under "## Phase 1" (untracked):
  - `scripts/check.sh` with `herdr-app check` on `bw-projects`, `bw-tabs`, `bw-new`, `bw-right`, `bw-menu`, `bw-add`.
  - `scripts/sync.sh`; `bun scripts/keys-merge.js` shows the diff, then `--apply`; `layout.switch {name: "bellwether"}`; `herdr-app status` shows no layout, keys or mod error; `herdr-app shot`: left 248 px, tab bar 32 px, right 360 px with a 36 px strip, status bar under the middle.
  - `keys()` lists no other binding for `cmd-alt-b`; `cmd-alt-b` hides and shows `right`; `ctrl-shift-b` still hides `sidebar`.
  - Done check 1 from empty state with the window on the MacBook: `scripts/verify/make-repos.sh` there and on macmini, `alpha` opened, `beta` closed, `gamma` opened on a macmini space; the sidebar lists three projects under two machine headings; each project's rows equal `git worktree list --porcelain -z` (shot beside `scripts/verify/projects.sh` output); agent lines equal `herdr-app ls`; clicking the dimmed `alpha-wt/detached` row makes a space whose folder is that path (`herdr-app ls`); a file edit in the selected worktree changes its counts within 2 s here and on macmini (stopwatch from `printf >>` to shot); "+" on the macmini space → New terminal → Codex, then `hc exec --on macmini pgrep codex` prints a pid; macmini offline (quit its core) → its heading says offline and its rows stay.
  - Drag a tab onto another: `herdr-app ls` shows the new order; the dragged tab keeps its terminals.
  - `layout.resize {id: "sidebar", px: 120}`: whether `min: 160` clamps it; when not, the rail draws.
  - The live data fields the fixtures use (`tests/fixtures/live/*.json`) match a real `herdr-app ls` and a mod's `terminals()` (`parent` format for a remote sub-agent).
  - The macmini heading shows "setting up Bellwether" during a first `bw machine install`, then nothing.
- [ ] **Step 5:** Run `independent-review` on the phase diff (Codex reviewer); fix confirmed findings; rerun `scripts/test.sh` and `scripts/verify/projects.sh --machine bwloop`.
- [ ] **Step 6:** Apply the two spec changes above to the spec (the "Project sidebar" refresh bullet and done check 1) and log each in one line in the intent file's amendment log with the original wording and the evidence; commit `docs: log phase 1 spec changes`.

## Defaults nobody discussed

- Row heights the spec leaves open: machine heading 24 px, project header 30 px, worktree row 28 px, `bw-projects` header 46 px, menu rows 30 px.
- The status bar sits under the middle column only, as in Herdr's `main`; the sidebars run full height.
- Herdr's `workspace-chrome` footer (Settings, Add machine) stays under `bw-projects`.
- Spaces outside Git appear in an "Other spaces" group per machine.
- Remove is offered only for a project with no open space.
- Projects sort by name; worktrees main first, then by branch.
- Settled tabs show at 0.6 opacity rather than hidden.
- One Git call in flight per machine; closed remote worktrees refresh every 15 s like open ones.
- The right sidebar hides with `cmd-alt-b`; this Mac's heading reads "This Mac".
- `+N` sub-agents count Herdr sub-agent terminals (`terminals()` `parent`) until phase 3 counts session sub-agents.
