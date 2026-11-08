# Development

This is the reference for changing Bellwether: where each file lives, how the tests and checks run,
how to drive a test window, and the rules this repository keeps. Commands run from the repository
root.

## How the docs are organised

These files describe Bellwether as the code is now:

- [`usage.md`](usage.md) covers what a user sees and does, set up and the known limits.
- [`helper.md`](helper.md) is the reference for every `bw` command and its output lines.
- [`architecture.md`](architecture.md) describes the pieces, how they talk and where code runs.
- This file covers the repository, its tests and checks, and the rules for changing it.

These folders hold the design history and may disagree with the code:

- `docs/brief/` holds the user's requests verbatim. Never edit the quoted words.
- `docs/specs/` holds the design specs and their intent files.
- `docs/plans/` holds the plans each part was built from.
- `docs/research/` records what Flockbook, Shepherdr, herdr-t3 and Herdr's example layouts do, with
  file paths, plus probe and cost results.

`RECIPE.md` describes the finished window and its rules in one file, so Bellwether can be rebuilt
from it. A change to behaviour, a command or set up updates the matching reference doc in the same
commit.

## Repository map

The folders that Herdr reads mirror `~/.config/herdr-app`, so a sync is a plain copy.

### Top level

```text
layouts/bellwether.json   the window, cloned from Herdr's main layout; bellwether.svg is its preview
themes/bellwether.json    the layout's Catppuccin Mocha theme, written by scripts/gen-theme.js
mods/bw-*/                one folder per mod, named bw-* so none clashes with Herdr's
shared/                   JavaScript used by several mods; scripts/sync.sh copies it in
keys/bellwether.json      Bellwether's key bindings, merged by scripts/keys-merge.js
hooks/bw-event            the hook bw machine setup installs; it hands each event to bw event
agent/                    the browser instructions and MCP launcher that bw embeds and bw agent ensure writes to each machine
crates/bw/                the bw helper binary the mods run
crates/vendor/            code copied from other projects, in its own Cargo workspace
crates/Tests/HerdrKitTests/Fixtures/   Flockbook's 14 parser fixtures that crates/vendor/herdr-core's tests read
scripts/                  sync, check, test, install and generator scripts
scripts/verify/           checks against real machines and agents, and the stage window
tests/                    Bun tests, the headless harness that stubs herdr and gpui-kit, and fixtures
types/                    Herdr's type files and the tsconfig that type-checks every mod against them
docs/                     the reference docs above and the design history
licenses/Apache-2.0.txt   herdr-t3's license, for the code scripts/verify/stage.sh adapts
Cargo.toml, Cargo.lock    the root Cargo workspace (crates/bw only)
rust-toolchain.toml       the pinned Rust toolchain
package.json, bun.lock    the pinned JavaScript dev tools: Biome and TypeScript
bunfig.toml               makes bun test preload tests/harness/preload.js
biome.jsonc               Biome's format and lint settings
.github/workflows/ci.yml  the CI job
README.md, RECIPE.md      the front page and the rebuild recipe; preview.png is the window's picture
AGENTS.md (CLAUDE.md)     guidance for coding agents; CLAUDE.md is a symlink to it
REVIEW.md                 what a review looks for and which paths need a human
THIRD_PARTY_NOTICES.md    every borrowed file, with its source path and commit
LICENSE                   Bellwether's MIT license
```

`bw` embeds `agent/browser.md`, `agent/browser-claude.md`, `agent/browser-codex.md`,
`agent/browser-mcp` and `hooks/bw-event` with `include_str!`. An edit to one of them reaches a machine
only through a rebuilt and reinstalled helper.

### The helper: `crates/bw/src/`

```text
main.rs        routes each bw subcommand to its module
version.rs     PROTOCOL and the bw version line (protocol, version, build, target)
hc.rs          the hc CLI (BW_HC, default hc), which runs programs and writes files on other machines
agent/         bw agent: the agent files on the space's machine and each new agent's extra argv; codex.rs layers Codex's developer_instructions
browser/       bw browser: chrome.rs (up, down), tabs.rs, launch.rs (agent-args, status), forward.rs, arrange.rs, cdp.rs, http.rs, listen.rs, lock.rs, pages.rs
chat/          bw feed, locate, send, picture, picture-read, tree: feed.rs, rows.rs, sentence.rs, tail.rs, locate.rs, cache.rs, dirs.rs, send.rs, picture.rs, tree.rs, args.rs, protocol.rs
diff/          bw diff files, patch, refs, fetch and the watcher: files.rs, patch.rs, refs.rs, parse.rs, watch.rs
events/        bw event: records one hook payload per file
linear/        bw linear: client.rs (one GraphQL request, key through curl's config on stdin), query.rs, cache.rs
machine/       bw machine status, install, setup and bw hooks: install.rs, hooks.rs
requests/      bw cards, answer, counts: cards.rs, answer.rs, claims.rs, store.rs, matchers.rs, screen.rs, codex_approval.rs, codex_folder.rs, counts.rs
```

`crates/bw/build.rs` sets `BW_BUILD` (the commit's 12-hex short hash, else `unknown`) and
`BW_TARGET`. `crates/bw/tests/` holds one integration test file per area, with `fake-hc`,
`fake-ssh` and `support/` as test doubles. `crates/vendor/herdr-core/` is Flockbook's crate, built in
`crates/vendor/Cargo.toml`'s workspace; its `UPSTREAM` file lists every change made here.

### Mods: `mods/`

Each mod folder holds `mod.json`, `main.js`, a `.shared` list, its own files and an `icons/` folder
when it draws icons. The files a `.shared` list names are copies of `shared/`.

```text
bw-projects   left sidebar: machines, projects, worktrees and agents (rows.js, actions.js, run-git.js)
bw-tabs       the tab bar of the active space, and the chat-tab split and ⌘J flip (model.js)
bw-new        the tab bar's "+" overlay menu (entries.js)
bw-menu       a project's overlay menu in bw-projects
bw-add        the Add project overlay dialog
bw-status     the bar under the active tab
bw-pane       each pane's header
bw-right      the right sidebar's strip of Changes, Issues and Browser
bw-diff       the Changes panel (model.js, patch.js)
bw-linear     the Issues panel (model.js)
bw-browser    the Browser panel (model.js)
bw-chat       a chat pane beside an agent's terminal (feedstate.js, timeline.js, composer.js, dock.js,
              dock-model.js, threads.js, threads-model.js, chips.js, focus-guard.js, target.js,
              pictures.js, estimate.js, mdblocks.js)
```

The layout names `bw-projects`, `bw-tabs`, `bw-pane`, `bw-status`, `bw-right`, `bw-diff`,
`bw-linear` and `bw-browser`. `bw-new`, `bw-menu` and `bw-add` open as overlays, and `bw-tabs` splits
a `bw-chat` pane into a chat tab. [Architecture: Mods](architecture.md#mods) says what each one
shows.

### Shared JavaScript: `shared/`

```text
chat-tabs.js         how a "+" tab becomes a terminal beside a bw-chat pane, ⌘J, when a chat counts as shown
choice.js            which right-sidebar panel each space shows (shared("bw.right.tab"))
diff-reveal.js       "Open in Changes" for one file (shared("bw.diff.reveal"))
git-parse.js         parsers for the read-only Git calls in git.js
git.js               short read-only Git calls through exec, on the machine that holds the folder
helper.js            runs bw on a space's machine; PROTOCOL and HELPER_VERSION
linear-attach.js     issues attached to a chat's composer (shared("bw.chat.attach"))
linear-links.js      which Linear project a repository links to (shared("bw.linear.links"))
palette.js           every colour value
projects-model.js    the project sidebar's tree; a mod that lists it must also list status
refresh-driver.js    runs a refresh schedule inside one loop task
refresh-schedule.js  when each Git refresh is due
status.js            agent status ranking, as Herdr ranks it
ui.js                status marks, pills, chips, monogram tiles, cards, buttons; its icons live in mods/bw-projects/icons/
```

Most files have a `*.test.js` beside them. The tests stay in `shared/` and are never copied.

### Scripts: `scripts/`

```text
sync.sh            copy the layout, its theme and bw-* mods into ~/.config/herdr-app; --shared-only refreshes mod copies
check.sh           herdr-app check (or the headless stand-in) on every mod, and shared copies match
test.sh            every check that needs no Herdr window
gen-theme.js       write themes/bellwether.json from shared/palette.js
gen-herdr-api.js   extract Herdr's API names into tests/harness/api.json and copy its types into types/herdr
keys-merge.js      merge keys/bellwether.json into the app home's keys.json
install-helper.sh  build bw and install it on this machine
build-dist.sh      build bw for other platforms into ~/.local/share/bellwether/dist
linear-key.sh      store the Linear key in this Mac's Keychain for bw linear
verify/            see "Verify scripts" below
```

### Tests: `tests/`

```text
harness/          the headless harness: preload.js, herdr-stub.js, kit-stub.js, cx.js, mount.js, api.json,
                  harness.test.js and fixtures/ (bw-good, bw-bad, bw-bad-import, which test the harness itself)
mods/             one or more test files per mod; render-all.test.js mounts every mod under every live fixture
browser/          page.html, server.js and cdp.js for the browser checks, and page.test.js
fixtures/         recorded and hand-made inputs; see "Fixtures"
*.test.js         theme, ui, layout, keys-merge, agent-files and mcp-echo tests
```

### Generated files

`herdr-app check` and Herdr write `jsconfig.json`, `herdr.d.ts` and `gpui-kit.d.ts` into each mod
folder. `.gitignore` ignores `mods/*/jsconfig.json` and `mods/*/*.d.ts`, and `scripts/sync.sh` never
copies them. `types/herdr/` holds the copies of Herdr's type files that `scripts/gen-herdr-api.js`
writes, with a `README.md` naming the Herdr version. `tests/harness/api.json` comes from the same
script. `themes/bellwether.json` comes from `scripts/gen-theme.js`. `REVIEW.md` skips the mod folders'
`jsconfig.json` and `.d.ts` files and `types/herdr/`. Review still covers `tests/harness/api.json`
and `themes/bellwether.json`.

## Toolchain

`rust-toolchain.toml` pins Rust 1.99.1 with `clippy` and `rustfmt`. The root `Cargo.toml` is a
workspace with `crates/bw` only. It excludes `crates/vendor`, which builds in its own workspace
(`crates/vendor/Cargo.toml`, `crates/vendor/Cargo.lock`) so the root's `cargo fmt` and `clippy`
gates never ask for edits to vendored code. The scripts put `/opt/homebrew/opt/rustup/bin` first on
`PATH`.

`package.json` pins `@biomejs/biome` 2.6.4 and `typescript` 7.0.2, and `bun.lock` locks them. Run
`bun install` once per checkout to put them in `node_modules`, which Git and Syncthing both ignore.
Without `node_modules`, `bunx` would fetch whatever npm calls `biome` or `tsc`, so `scripts/test.sh`
refuses to run and says to run `bun install`. CI uses Bun 1.4.4.

Biome reads `biome.jsonc`: 2-space indent, 120 columns, LF, double quotes, semicolons, trailing
commas, the recommended lint rules, and import sorting off. It leaves out `docs`, `target`,
`crates`, `tests/fixtures`, `node_modules`, every `*.svg`, `*.html` and `*.md` file,
`tests/harness/api.json`, `types/herdr`, and the mod copies of `chat-tabs.js`, `git-parse.js`,
`git.js`, `helper.js`, `projects-model.js`, `refresh-driver.js`, `refresh-schedule.js`, `status.js`
and `ui.js`. `bunx biome check --write .` fixes most findings.

Biome checks no Markdown file. `bunx biome ci --error-on-warnings docs/development.md` prints
`Checked 0 files`, then `No files were processed in the specified paths.` and lists
`docs/development.md` under "These paths were provided but ignored", and exits 1.

`bunx tsc -p types` type-checks every `mods/bw-*` file and `shared/*.js` (tests left out) against
`types/herdr/gpui-kit.d.ts`. `types/tsconfig.json` uses the compiler options Herdr writes into each
mod's `jsconfig.json`, plus `skipLibCheck`, since Herdr's own `.d.ts` files fail TypeScript 7
(`Buffer`, `Crypto`). Its `paths` maps `herdr` to `types/herdr/herdr.d.ts`. It lives in `types/`
because Bun would read a root tsconfig's `paths` at run time.

## Running the tests

`scripts/test.sh [--offline]` runs every check that needs no Herdr window and stops at the first
failure. The flag changes nothing, since the verify scripts it runs always get `--offline`. Its
steps, in order:

1. `cargo fmt --check` checks the root workspace's formatting.
2. `cargo clippy --workspace --all-targets --locked -- -D warnings` lints `crates/bw` and its tests.
3. `cargo test --workspace --locked` runs the helper's unit and integration tests, goldens included.
4. `cargo test --manifest-path crates/vendor/Cargo.toml --workspace --locked --target-dir target/vendor`
   tests the vendored crate, which is never formatted or linted.
5. It checks that `node_modules/.bin/biome` and `node_modules/.bin/tsc` exist.
6. `bunx biome ci --error-on-warnings .` fails on any format or lint finding.
7. `bunx tsc -p types` type-checks the mods and `shared/`.
8. `bun test` runs every `*.test.js` outside `node_modules`, `target`, `.git` and `docs/drafts`: the
   harness, mod, shared, theme, layout and verify-helper tests.
9. `scripts/check.sh` checks the shared copies and every mod (see below).
10. A loop runs `sh <script> --offline` for each `scripts/verify/*.sh` whose text contains
    `--offline`: `agent-flags.sh`, `browser-probe.sh`, `browser.sh`, `git.sh`, `linear.sh`,
    `projects.sh`, `requests.sh` and `sessions.sh`.

The loop matches the text `--offline` anywhere in a script, a comment included. A new verify script
that mentions the flag must accept it. The offline runs of `sessions.sh` and `requests.sh` make
temporary folders under `/private/tmp/claude-501`, which `tests/agent-files.test.js` creates during
step 8. `sessions.sh`, `requests.sh` and `browser.sh` build the release `bw` even with `--offline`.

The feed, tree and cards goldens are blessed with `BW_BLESS=1`, for example
`BW_BLESS=1 cargo test -p bw --locked --test feed goldens_are_current`. Read the diff before
committing a blessed golden.

## CI

`.github/workflows/ci.yml` runs one job, `test`, on every pull request and on pushes to `main`. A
repository ruleset makes `test` the required status check on `main`. The job runs on
`macos-latest`, because the browser and window code calls `osascript` and AppKit, with a 45-minute
limit. A newer run on the same ref cancels an older one. Its steps:

1. The job checks out the repository and sets up Bun 1.4.4.
2. `rustup show active-toolchain || rustup toolchain install` installs the channel and components in
   `rust-toolchain.toml`.
3. `Swatinem/rust-cache` caches `target` and `target/vendor`.
4. `brew install ripgrep` installs `rg`, because `scripts/verify/linear.sh` scans for the Linear key
   with `rg` and fails when `rg` is missing.
5. `bun install --frozen-lockfile` installs the pinned JavaScript tools.
6. `scripts/test.sh --offline` runs every check. The runner has no `herdr-app`, so
   `scripts/check.sh` renders each mod in the headless harness instead.

## The headless harness

`bunfig.toml` preloads `tests/harness/preload.js` for every `bun test`. It serves stub modules for a
mod's bare `herdr`, `gpui-kit` and `gpui-base` imports. A name the stub lacks fails at link, as it
would in Herdr.

- `herdr-stub.js` exports exactly the names `herdr.d.ts` declares. Tests put live data in `fake` and
  read what the mod asked for in `log`. It refuses a read of `agents()`, `spaces()`, `panes()`,
  `terminals()` or `focused()` from a task or timer, an unknown command or argument, and a missing
  required argument. `fake.exec` is a function or a list of `{ cmd, on, argsInclude, result }`
  answers, and an unmatched call returns code 127.
- `kit-stub.js` builds elements that keep their children, attributes and handlers, so a test can
  walk the tree (`byId`, `textOf`, `findAll`) and fire events. It refuses a builder method that
  `NativeElement` does not declare, an element added twice, a handler inside a virtual list's
  renderer, a state's `.new` during render, and an image path that is none of an existing `mods/bw-*`
  file, a path under `icons/`, or a digest-named cache file
  (`data/bellwether/pictures/<16 hex>.<ext>` or `data/bellwether/favicons/<16 hex>.<ext>`).
- `cx.js` is a fake `cx`: spawned bodies wait for a flush, sleeps park until a test wakes them, and
  timers are recorded. It refuses a `timer.every` under 1000 ms and an `open_url` that is not an
  absolute http(s) URL.
- `mount.js` exports `mount(name, { props, live, root })`, which loads a fresh copy of
  `mods/<name>/main.js`, runs init, its tasks and render, and throws after any step that broke a
  rule. It returns `view`, `cx`, `el`, `render`, `click`, `tickTimer` and `log`. `live(name)` reads
  `tests/fixtures/live/<name>.json`.
- `api.json` lists the names, element methods and commands the stubs accept. `scripts/gen-herdr-api.js`
  writes it from Herdr's type files and authoring guide.

A mod test imports `mount` and `live` from `tests/harness/mount.js`, mounts the mod with a live
fixture, then reads the tree or `log`. Pure functions a mod exports are tested directly.
`tests/mods/render-all.test.js` mounts every mod under every live fixture and each props set in
`tests/fixtures/live/props.json`.

### `scripts/check.sh`

`scripts/check.sh` fails on any of these:

- A file anywhere under `mods/` that has the name of a `shared/*.js` file and differs from it.
- A `.shared` entry with no `shared/<name>.js`, or a mod missing the copy its `.shared` names.
- A failing `herdr-app check <mod folder>`, for each `mods/bw-*` folder, when `herdr-app` is on
  `PATH`.
- A failing `bun test tests/harness tests/mods`, when `herdr-app` is missing. It then prints
  `STAND-IN headless render for N mods (herdr-app check owed)`.
- A `layouts/bellwether.json` that `jq` cannot parse.

It ends with `all checks passed (N mods checked by herdr-app, M by the stand-in)`. The stand-in
loads each mod in the harness; it does not run Herdr's own loader.

## Fixtures

```text
tests/fixtures/sessions/      real Claude and Codex session logs, one folder per recorded scenario, with expect.json hand counts
tests/fixtures/feed/          saved bw feed outputs for each recording (children/ for each sub-agent); README.md says how they are made
tests/fixtures/cards/         the bw cards goldens, one per case that crates/bw/tests/cards.rs builds from the recordings
tests/fixtures/screens/       hc read screens of real prompts, recorded and hand-made; README.md lists each
tests/fixtures/hooks/         Claude and Codex settings files for crates/bw/tests/hooks.rs
tests/fixtures/codex-config/  Codex config layers (top, profile, trusted and untrusted projects) for codex-config.test.js
tests/fixtures/browser/       Chrome's /json/version and /json/list and three lsof answers, from browser-probe.sh
tests/fixtures/git/           Git's -z outputs and saved bw diff answers for the Git parsers and bw-diff tests
tests/fixtures/live/          Herdr live data for mounted mods; props.json holds each mod's props sets
tests/fixtures/model/         live data and Git records for shared/projects-model.test.js
tests/fixtures/mcp-echo/      server.js, an MCP server that answers bw_echo, for agent-flags.sh and mcp-echo.test.js
```

`scripts/verify/record-session <scenario> [--keep] [--out <dir>]` runs the real agent for one
scenario in a fresh scratch Git repository under `$BW_REC_ROOT` (default
`/private/tmp/claude-501/bw-rec`), in a private hc core (`BW_REC_CORE`, default `bw-rec`). It copies
the session logs out, runs `scrub-fixture` on them, and only then moves them into
`tests/fixtures/sessions/<scenario>/` or `--out`. A failed scrub leaves nothing in the repository. Its
scenarios are `claude-subagents`, `claude-picture`, `claude-approval`, `codex-subagent`,
`codex-question`, `codex-approval`, `claude-child-approval` and `codex-child-approval`. It spends
tokens, and `scripts/test.sh` never runs it. `scripts/verify/record-wrap.sh` records the screens in
`tests/fixtures/screens/` (see [record-wrap.sh](#record-wrapsh)).

`scripts/verify/scrub-fixture [--check] <dir|file>...` rewrites private values in place and then
checks for residue; `--check` only reports `file:line: <pattern>` and exits 1 on any. `scrub.js`
replaces emails, `sk-`, `sk-ant-`, `lin_api_`, `gho_` and `ghp_` tokens, home paths
(`/home/user`), scratch roots (`/scratch/<name>`), temporary folders, the hostname (`host`) and the
username (`user`). It also flags lines of `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and
`~/.agents/AGENTS.md` that a log quotes. `BW_SCRUB_USERS` and `BW_SCRUB_HOSTS` add comma-separated
names to scrub, such as another machine's hostname. It skips files holding a NUL byte (pictures).

`REVIEW.md` flags a test fixture that did not pass `scripts/verify/scrub-fixture`. Run
`scripts/verify/scrub-fixture --check tests/fixtures/<folder>` before committing a new or changed
fixture.

## Verify scripts

Each script prints `PASS <check>`, `FAIL <check>: <why>` and sometimes `PENDING <check>: <why>` or
`NOTE`, and exits 1 on any `FAIL`. Scripts that run agents spend tokens with cheap models: Claude
`haiku` and Codex `gpt-6-luna` at low effort. They run agents in a private hc core with a bare
environment, because an agent started inside another Claude session inherits
`CLAUDE_CODE_CHILD_SESSION`, which turns transcript saving off.

| Script | What it proves | test.sh runs `--offline` | Live agents | Other machine | Keychain key |
| --- | --- | --- | --- | --- | --- |
| `projects.sh` | the project sidebar equals Git | yes | no | `--machine <name>` | no |
| `sessions.sh` | chats feed, nest, send and refuse | yes | without `--offline` | `--machine <name>` | no |
| `requests.sh` | cards and `bw answer` press keys only into the shown prompt | yes | without `--offline` | temporary machine only | no |
| `requests-probe.sh` | records what each prompt case shows | no | yes | `--machine <name>` | no |
| `record-wrap.sh` | records prompts at two widths | no | yes | no | no |
| `browser.sh` | agents share one Bellwether Chrome | yes | live run | temporary machine, required live | no |
| `browser-probe.sh` | how Chrome, the MCP server and sshd behave | yes | unless `--no-agents` | no | no |
| `agent-flags.sh` | per-session agent flags change no setting | yes | without `--offline` | no | no |
| `git.sh` | the Changes panel equals Git | yes (same as no flag) | no | `--machine <name>` | no |
| `linear.sh` | the Issues panel equals Linear | yes (a fake Linear) | no | no | live run |
| `install.sh` | the helper installs here and there | no | no | `--machine <name>` | no |
| `poll-cost.sh` | CPU of one feed and one diff poll | no | no | `--machine <name>` | no |
| `feed-cost.sh` | CPU of one `bw feed` | no | no | no | no |
| `contrast.js` | every colour pair meets WCAG AA ([Theme and colours](#theme-and-colours)) | through `tests/theme.test.js` | no | no | no |
| `stage.sh` | a test window apart from yours | no | no | no | no |

`requests.sh --machine` and live `browser.sh` take only a machine that `hc machine ls --json` marks
`"temporary": true`, such as `bwloop`, because they write and put back that machine's `~/.claude`,
`~/.codex` and Bellwether folders. `bwloop` is this Mac reached through a `via` command with its own
HOME, made with `hc machine add --temp --via 'env HOME=<home>/.bwl sh -c' --name bwloop`. Herdr
gives a temporary machine no spaces. The other scripts take any machine `hc` reaches, such as
`macbook`. `projects.sh`, `sessions.sh`, `requests.sh`, `browser.sh`, `git.sh` and `install.sh` run `hc` from
`BW_HC` when it is set. `poll-cost.sh` and `requests-probe.sh` always run the `hc` on `PATH`.

### Shared pieces

- `lib-scratch.sh` makes and deletes scratch folders. A folder counts only when it resolves strictly
  inside `/private/tmp` and is no symlink, and only a folder `scratch_make` marked with `.bw-scratch`
  is deleted. `scratch_rm_idle` keeps a folder, with a `FAIL` naming the processes, while any process
  still runs in it or names it.
- `lib-sshd.sh` runs a scratch `sshd` as the user on a free 127.0.0.1 port, for testing `ssh -R` and
  `-L` forwards without Remote Login or `~/.ssh` (`BW_SSHD_GATEWAY_PORTS` sets `GatewayPorts`).
- `lib-terminals.sh` names the forward and npx warm terminals `bw browser agent-args` starts for a
  machine and sorts new `bw-` terminals into the run's own and others.
- `home-files.sh sums|save|restore <home> ...` saves each file under the given paths of a HOME and
  puts back each one that changed or went, deletes each file and folder that was not there, and
  leaves unchanged files alone. A symlink is saved as the link. `requests.sh` and `browser.sh` run
  it with `sh -c` on the other machine.
- `make-repos.sh <root>` and `make-diff-repos.sh <root>` build the Git repositories the checks read,
  with fixed authors and dates and no user Git config. They rebuild only a root holding `.bw-verify`
  and refuse any other non-empty root, and they source nothing, so they run as
  `sh -c "<script>" sh <root>` on another machine.
- `live.js` holds what `sessions-run.js` and `requests-run.js` share: processes, hc terminals,
  scratch repositories, Codex homes and the result lines. Each `*.sh` check hands its work to a
  `*-run.js` file of the same name.
- `codex-config.js <config.toml> <value>` sets the top-level `developer_instructions` in a Codex
  config text and leaves every other line as written.

### projects.sh

`scripts/verify/projects.sh` builds scratch repositories with `make-repos.sh` in
`/private/tmp/bw-verify-projects`, runs the project model on real Git output and checks it: rows
equal `git worktree list` (`rows-equal-git`), a closed row opens its exact folder
(`dimmed-row-opens-exactly`), counts follow an edit within 2 s (`counts-within-2s`), and an
unreachable machine keeps its rows (`unreachable-named`). The unreachable machine is `bw-unreachable`,
which a stub exec rejects offline and hc refuses with `--machine`.

```sh
scripts/verify/projects.sh                    # this Mac; prints PENDING for the remote half
scripts/verify/projects.sh --machine <name>   # also builds repositories on <name> through hc
scripts/verify/projects.sh --offline          # no other machine; what scripts/test.sh runs
```

Without `--machine`, a local exec named `bw-stand-in` serves the remote repositories. With `--machine`, they go in
`$BW_PROJECTS_REMOTE_ROOT` (default `$HOME/bw-verify/projects` there), and the remote counts check
edits alpha's `feat` worktree. It deletes only roots holding `.bw-verify`.

### sessions.sh

`scripts/verify/sessions.sh` compares `bw feed` on the recorded sessions in
`tests/fixtures/sessions/` with their goldens and hand counts, including each sub-agent's own rows
(`child-rows`) and `bw tree`'s nesting (`tree-nested-subagent`). Without `--offline` it also runs
Claude haiku and Codex in a private `hc` core (`HC_SESSION=bw-sessions`) in scratch Git
repositories under `/private/tmp/claude-501/bw-sessions`, then feeds, sends and refuses through
`bw`. It checks each chat's first message, a text starting with `--`, a picture, a send refused after
`/clear` and while Claude waits on a prompt, and a Codex root found beside its sub-agent. It checks
the live sub-agent trees (`claude-children-live`, `codex-child-tree`) and the chat's next message
after a real `/clear` or `/new` (`claude-clear-next-message`, `codex-new-next-message`, with Codex's
folder prompt answered through its card). Claude 2.1.319 writes the new conversation's log at
`/clear`, so that message goes with the new session and its log. After Codex's `/new` the new session
has no log, so it goes with `--expect-session <id> --expect-path none`.

```sh
scripts/verify/sessions.sh --offline          # recordings only; what scripts/test.sh runs
scripts/verify/sessions.sh                    # also real agents here; PENDING for the remote half
scripts/verify/sessions.sh --machine <name>   # also Codex on <name> through its helper
```

With `--machine`, the script moves `<name>`'s helper link aside to see it named `missing`, lets the
helper install it again, and runs Codex there under `$BW_SESSIONS_REMOTE_ROOT` (default
`$HOME/bw-verify/sessions` on that machine), including its sub-agent tree and `/new`. Claude runs
only here, and here Codex runs with a scratch `CODEX_HOME` holding a copy of `~/.codex/auth.json`.
`BW_VERIFY_ONLY=claude,claude-prompt,claude-children,codex,remote` reruns only those live groups. On
exit it stops the private core, kills its terminals on `<name>`, deletes the scratch folders and the
Claude project folders its runs wrote, and puts the helper link back. Claude's trust dialog leaves
an entry per scratch folder in `~/.claude.json`, which the script never edits.

### requests.sh

`scripts/verify/requests.sh` checks the request dock's commands. Offline it compares `bw cards` on
each case with its golden in `tests/fixtures/cards`, runs `bw hooks` on copies of
`tests/fixtures/hooks` in a scratch HOME, and runs the chat's focus guard tests. Live it runs Claude
haiku (`--permission-mode default`) and Codex in a private core (`HC_SESSION=bw-requests`) under
`/private/tmp/claude-501/bw-requests`. It checks root, foreground and background sub-agent approvals
answered with `bw answer` (the file absent before, present after), a prompt answered in the terminal
first (the old card gives `stale` and the screen does not change), Deny, Codex root and sub-agent
approvals, and a Codex async question answered as one message. The agents' hooks run
`~/.local/share/bellwether/hooks/bw-event`, so the script puts `hooks/bw-event` there for the run
and then removes it or puts the old one back.

With `--machine <name>` it also runs `bw machine setup <name>` there (`--diff`, `--apply`,
`--check`, and a trust step written into that machine's `~/.codex/config.toml`) and Codex approvals,
a stale card and an async question through the helper there. Then it runs `--remove`, and
`home-files.sh` puts back each file under that machine's `~/.claude`, `~/.codex` and Bellwether's
hooks and backups folders. It records the SHA-256 of `~/.claude/settings.json`,
`~/.codex/hooks.json` and `~/.codex/config.toml` here and fails if any changed.
`BW_VERIFY_ONLY=claude,codex,remote` reruns only those groups.

```sh
scripts/verify/requests.sh --offline          # goldens, hooks and the focus guard; what scripts/test.sh runs
scripts/verify/requests.sh                    # also real agents here
scripts/verify/requests.sh --machine <name>   # also Codex on <name>; <name> must be a temporary hc machine (bwloop)
```

### requests-probe.sh

`scripts/verify/requests-probe.sh [--machine <name>] [--save <dir>] [--only <groups>]` runs real
Claude and Codex until each approval and prompt shows, and prints `CASE <case>: <result>` for each.
Its cases feed `docs/research/2026-11-06-phase3-requests.md` and the `*-child-approval` recordings;
the script's header lists them. It runs in a private core (`HC_SESSION=bw-probe`) under
`/private/tmp/claude-501/bw-probe`. `--save` keeps the scrubbed screens, statuses and payloads in a
new folder under `/private/tmp`, and `--only` takes groups from `claude`, `codex`, `f`, `j` and `i`.
On exit it stops the core, deletes its folders and fails if the user's Claude or Codex settings
changed.

### record-wrap.sh

A prompt's id ignores how the pane wraps it, so narrowing or widening a chat's pane keeps one card
([Prompt ids](architecture.md#prompt-ids)). `bw answer` then presses a key only while the box still
shows what the card first showed, else it answers `stale` ([Answering](architecture.md#answering)).

`scripts/verify/record-wrap.sh` records the screens the `rewrap` tests in
`crates/bw/tests/matchers.rs` read: a Claude approval, a Codex approval and Codex's `/new` folder
prompt at 80 columns, then again after an `hc attach` viewer narrows the same terminal. It runs
Claude haiku and Codex in a private core (`HC_SESSION=bw-wrap`) in scratch repositories under
`/private/tmp/claude-501/bw-wrap`, scrubs the screens into `tests/fixtures/screens/`, and removes the
core, the folders and Claude's project logs for them.

### browser.sh

`scripts/verify/browser.sh --offline` runs no agent and starts nothing: it checks that the files
exist, that `bun test tests/browser` passes and that `bw browser status` parses. The live run needs
`--machine` with a machine that `hc machine ls --json` marks temporary (bwloop). Its Chrome runs on
a scratch profile and a free port (`BW_CHROME_PROFILE`, `BW_CHROME_PORT`), never 9222 or the real
profile, and `bw browser down` stops it. `claude -p` here and Codex on the temporary machine each
click a button in a tab they opened (`claude-p-clicked`, `codex-clicked`). Codex reaches this Chrome
through a real `ssh -R` forward to a scratch `sshd`. The script also runs interactive Claude in a
private core (`HC_SESSION=bw-browser`, check `interactive-claude`) and looks for each agent's
screenshot in `bw feed --pictures` (`claude-picture`, `codex-picture`). It passes `agent-args` its
own window id (`--window bwv-<pid>`), so its port file and MCP config never replace the real
window's. `BW_CLAUDE_MODEL` and `BW_CODEX_MODEL` pick the models.

It puts back each file it changed on that machine and here, and deletes the files it created. In
your own hc core it stops only the forward and npx warm terminals named for that machine that were
absent at the start, and prints a `NOTE` for any other new `bw-` terminal, such as one a "+" for
another machine started meanwhile. A process that still uses its scratch folder after cleanup, or a
recorded pid that still runs, keeps that folder and its Claude logs for diagnosis and is named in a
`FAIL`. A later run refuses to start until those processes end. It fails when
`~/.claude/settings.json`, `~/.codex/hooks.json` or `~/.codex/config.toml` changed, when
`~/.claude.json` gained a `bw-browser` trace, or when your own Chrome processes changed.

```sh
scripts/verify/browser.sh --offline          # files exist, bun test tests/browser, bw browser status parses; what scripts/test.sh runs
scripts/verify/browser.sh --machine <name>   # real agents; <name> must be a temporary hc machine (bwloop)
```

### browser-probe.sh

`scripts/verify/browser-probe.sh [--offline] [--no-agents]` answers the questions in
`docs/research/2026-11-07-phase4-browser.md`: how Chrome's DevTools endpoints, Chrome DevTools MCP
1.12.0, Claude's and Codex's logs and a scratch sshd behave. `--offline` starts nothing: it checks
the committed `tests/fixtures/browser` files, that `lib-sshd.sh` parses and that the fixtures pass
`scrub-fixture --check`. Otherwise it starts a second Chrome on a scratch profile and a free port
beside yours, which it never signals, and stops it with CDP `Browser.close`. Its case (h) runs
`claude -p` and `codex exec` in a private core (`bw-p4probe`), which spends tokens; `--no-agents`
skips it. `BW_PROBE_FIXTURES=<dir>` receives the fixtures it captured, to review and copy in. It
keeps its scratch folder (`BW_PROBE_DIR`, default `/private/tmp/claude-501/bw-probe`) the same way
`browser.sh` does.

### agent-flags.sh

`scripts/verify/agent-flags.sh [--offline]` checks that each per-session flag loads the MCP server
and the instructions for one session only, in `-p` or `exec` and in an interactive terminal, without
changing the user's settings. `--offline` runs no agent: it checks its files exist and that
`tests/fixtures/mcp-echo/server.js` answers `bw_echo` under `node`. The live run uses real `claude`
and `codex` with one short prompt each in `$BW_FLAGS_DIR` (default `/private/tmp/bw-flags`, deleted at
the start of a run), and interactive runs in a private core (`HC_SESSION=bw-flags`). On exit it
deletes the scratch `CODEX_HOME`, which holds a copy of `auth.json`, and ends the terminals and the
private core it started.

### git.sh

`scripts/verify/git.sh` builds the repositories of `scripts/verify/make-diff-repos.sh` in
`/private/tmp/bw-verify-diff`. They hold a branch two commits past its merge base with an
`origin/main` that moved on, a tag, staged, unstaged and untracked changes with a rename, binary
files and odd paths, a repository with no remote, and one whose `origin/HEAD` points to
`origin/trunk`. Some files name a textconv, an external diff and an fsmonitor hook that would each
leave a marker file if they ran. The script compares `bw diff` and the panel's model with Git's own
commands, each run with `--no-ext-diff --no-textconv --no-color`:

- Staged, Changes, and Committed on branch in both modes equal `git diff`.
- Each untracked file's counts equal `git diff --no-index --numstat`.
- A typed ref (`v1`) gives Git's list, and `--output=…` is refused as a ref.
- The rename and the binary files show as Git shows them.
- Every patch, joined from its pages, equals Git's patch.
- The panel model's rows equal the helper's.
- A repository with no `origin/main` or `origin/HEAD` has no base, and `origin/HEAD`'s target is the
  default when `origin/main` is missing.
- No textconv, external diff or fsmonitor program ran.

It removes the folder after.

```sh
scripts/verify/git.sh                    # this Mac, with this checkout's bw; --offline is the same, and scripts/test.sh runs it
scripts/verify/git.sh --machine <name>   # the repositories on <name> through hc exec, read by the helper there
```

Here it uses `$BW_BIN`, else `target/debug/bw`, built when missing. With `--machine`, the script
builds a release `bw` here, and installs it on `<name>` when that machine's helper is missing or
outdated.

### linear.sh

`scripts/verify/linear.sh` makes two scratch repositories in `/private/tmp/bw-verify-linear`: one
without an origin, linked to the `Bellwether` project, and one with an origin, linked to
`Bellwether scratch`. It reads each as the panel does, through its Git place, its link and its
default filter, and compares `bw linear` with GraphQL queries of another shape that curl sends to
Linear with the same Keychain key:

- Each repository's default list equals `project(id).issues` for its own project's open issues, and
  the two lists share no issue.
- Mine equals `viewer.assignedIssues` and All the first page of open issues, and neither equals the
  Project list.
- Adding an origin to the first repository moves its link to the origin key and keeps its list.
- `rg -F`, given the key's first 12 characters on standard input, finds them in no file under the
  app homes, `~/.cache/bellwether`, `~/.local/share/bellwether` and the repository.

```sh
scripts/verify/linear.sh            # Linear itself, with the Keychain key; needs the two test projects
scripts/verify/linear.sh --offline  # a loopback fake of Linear and a made-up key; scripts/test.sh runs it
```

`--fake` is the same as `--offline`. With no key in the Keychain the script prints `OWED live: …`
and runs the fake. It uses `$BW_BIN`, else `target/debug/bw`.

### install.sh

`scripts/verify/install.sh [--machine <name>]` runs `scripts/install-helper.sh` and checks that
`~/.local/share/bellwether/helper/<version>/bw` exists and `current` links to it. With `--machine` it
checks `bw machine status` before, `bw machine install <name> --force` and its SHA-256 (against
this Mac's `bw`, `dist/<target>/SHA256SUMS`, or `BW_INSTALL_SOURCE`), `bw version` there, the status
after (`current`), and that a second install copies nothing. Without `--machine` the remote half
prints `PENDING`. It replaces the installed helper here and there, and cleans nothing up.

### poll-cost.sh

`scripts/verify/poll-cost.sh [--machine <name>] [--bw <path>] [runs]` measures what one poll costs.
It times `bw feed` on a scratch copy of the largest Claude log and Codex rollout: a first read, an
unchanged cursor and one appended line. It times `bw diff files` on the largest Git checkout under
the home folder (by index size): a full read and a watcher's unchanged poll. Each case runs `runs`
times (default 5) under `/usr/bin/time -l`, and the table gives the median and largest user plus
system milliseconds from `getrusage`, Git's calls included. A last row gives the watcher's own CPU
from `ps`. Without `--machine` it builds this checkout's release `bw` unless `--bw` names one. With
`--machine` it feeds `poll-cost-probe.sh` to `hc exec -i` and runs the helper installed there. It
skips Desktop, Documents and Downloads, which macOS guards with a prompt on that machine's display.
Its table names the files it read, never their text. Its scratch folder under `/private/tmp` goes
on exit. `docs/research/2026-11-08-phase7-poll-cost.md` holds the results.

### feed-cost.sh

`scripts/verify/feed-cost.sh [runs]` times `bw feed --log … --pictures` on the largest Claude and
Codex logs on this Mac: a first read, an unchanged cursor and one appended line, each `runs` times
(default 5) on a scratch copy in `/private/tmp/claude-501/bw-feed-cost`, deleted on exit. It prints
a Markdown table of sizes and user plus system milliseconds, never a path or a log's text.
`docs/research/2026-11-06-phase2-feed.md` holds the macmini results: at most 14 ms per read.

## The stage window

`scripts/verify/stage.sh` opens a test Herdr window apart from yours. It has its own core
(`HC_SESSION=bw-stage`) and app home, and your real HOME, so the real `claude` and `codex` keep their
logins.

```sh
scripts/verify/stage.sh up                     # build it in $BW_STAGE, sync the layout and mods, open its window
scripts/verify/stage.sh do <command>           # run a command inside it
scripts/verify/stage.sh down                   # close it, end its terminals and core, delete $BW_STAGE
```

`up` makes `$BW_STAGE` (default `/private/tmp/bw-stage`, which must be inside `/private/tmp`) and
refuses when it exists. The app home is `$BW_STAGE/app`. `$BW_STAGE/bin/bw` links the repository's
`target/release/bw`, else `target/debug/bw`, so build one first. `BW_HELPER` points at
`$BW_STAGE/bin/bw-log`, a wrapper that appends a timestamp and the command to
`$BW_STAGE/helper-calls.log` (such as `feed` or `browser status`, never the arguments, which can hold
chat text) and runs that `bw`, or the installed helper when neither build exists. `up` starts the
core from your shell, so Claude in it can read the login keychain, and stops when the stage core is
your own. It runs `scripts/sync.sh` into the stage app home, and opens the window in its own session
when `herdr-app` and `Herdr.app` exist (else it prints `window deferred: no herdr-app here`). The
window's pid goes in `$BW_STAGE/app.pid` and its output in `$BW_STAGE/app.log`. `do` runs a command
with only the stage's variables, so `herdr-app` and `hc` inside it talk to the stage.

`stage.sh` merges no keys. Once the window has written its `keys.json`, merge them:

```sh
bun scripts/keys-merge.js --apply --home /private/tmp/bw-stage/app
```

To drive the window for a check:

- Run Herdr commands with `scripts/verify/stage.sh do herdr-app do <command>` and list spaces with
  `scripts/verify/stage.sh do herdr-app ls`.
- Bring the window forward before each shot, with the pid from `app.pid`:
  `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is <pid>) to true'`.
  A covered window returns its last frame.
- Take the shot with `scripts/verify/stage.sh do herdr-app shot <file>`.
- Read the window's bounds before each series of clicks, because a tiling window manager (OmniWM)
  moves windows. System Events lists no windows for Herdr, so read them from
  `CGWindowListCopyWindowInfo` for the pid, for example in a short Swift script.
- A locked screen draws no window, so `herdr-app shot` keeps returning the frame from before the
  lock. Unlock the Mac before a series of shots.
- Click with `cliclick c:<x>,<y>`.
- Type with System Events: `osascript -e 'tell application "System Events" to key code 36'` for
  Return and `osascript -e 'tell application "System Events" to keystroke "<text>"'` for text.
  `cliclick kp:` does not reach GPUI.
- Pointer and key input needs Accessibility for the terminal you run from, and goes only to the
  stage window and the Bellwether Chrome, never your own Chrome.
- Start test agents only in scratch folders under `/private/tmp`.
- Close each stage space with `scripts/verify/stage.sh do herdr-app do space.close --id <id> --confirmed true`
  before `scripts/verify/stage.sh down`.

`down` deletes only a folder `up` made. It kills the window from `app.pid`, kills and removes every
terminal in the stage core when that core is not yours, stops the core, and deletes `$BW_STAGE`.

Your own window uses `herdr-app` directly. After any change to a mod, `scripts/sync.sh` and
`scripts/check.sh` must pass, then look at the window with `herdr-app shot`. A passing check does not
show that a layout fits.

## Herdr's API sources

Herdr rewrites its authoring guide, `~/.config/herdr-app/AGENTS.md`, and its type files,
`herdr.d.ts` and `gpui-kit.d.ts` in the same folder, on every start. They are the API, and they
change between Herdr versions, so read them before writing a layout or mod. Herdr also replaces its
shipped layouts and mods on every start: never edit them in `~/.config/herdr-app`.

`types/herdr/` holds copies of the two type files for `bunx tsc -p types`, and
`tests/harness/api.json` holds the names the harness accepts. Both come from herdr-app 0.1.13
(gpui-shell 0.7.1). After a Herdr update, refresh both together:

```sh
bun scripts/gen-herdr-api.js --from <dir> --herdr-app <version>   # [--out FILE] [--types DIR]
```

Without `--from` it reads the first of `$HERDR_APP_HOME`, `~/.config/herdr-app` and
`docs/drafts/herdr-api` that holds `herdr.d.ts`. The folder must also hold `commands.json`, Herdr's
command list with each command's arguments, which `~/.config/herdr-app` does not have, so a run
against the app home fails with `ENOENT` and writes nothing. The current copies came from a folder
holding `AGENTS.md`, `herdr.d.ts`, `gpui-kit.d.ts` and `commands.json` (`docs/drafts/herdr-api`, which
Git ignores). `--herdr-app` records the version when that folder's `AGENTS.md` names none.

## Adding a mod

1. Make `mods/bw-<name>/` with `mod.json`, `main.js` (a default View class) and `.shared`, one
   `shared/` file name per line without `.js`. A mod cannot import outside its own folder, so list
   every shared file it imports, and list `status` beside `projects-model`.
2. Name it in a slot of `layouts/bellwether.json`, or open it from another mod as an overlay or a
   pane. Update `tests/layout.test.js` when the layout changes.
3. Draw with `theme()` roles and `shared/ui.js`. Put no colour literal in it.
4. Add `tests/mods/bw-<name>.test.js`. `tests/mods/render-all.test.js` mounts it under every live
   fixture; add its props sets to `tests/fixtures/live/props.json` when it takes props.
5. Run `scripts/sync.sh --shared-only`, `scripts/check.sh` and `scripts/test.sh`, then sync into the
   app home and look at the window.

## Adding a shared file

Put the file in `shared/<name>.js` with no import outside that folder, and its test beside it as
`shared/<name>.test.js`. Add `<name>` to the `.shared` list of each mod that imports it, then run
`scripts/sync.sh --shared-only` and `scripts/check.sh` ([Syncing into an app home](#syncing-into-an-app-home)
says what each does). Edit only the file in `shared/`: an edited mod copy fails `check.sh`.

## Syncing into an app home

`scripts/sync.sh [--dry-run] [--shared-only]` copies real files, because Herdr does not load a mod's
SVGs through a symlink. It writes only `layouts/bellwether.*`, `themes/bellwether.json` and
`mods/bw-*/` into `$HERDR_APP_HOME` (default `~/.config/herdr-app`), and never touches Herdr's
shipped layouts, themes and mods or anyone else's. It leaves out each mod's `.shared` list and the
type files Herdr writes into mod folders (`gpui-kit.d.ts`, `herdr.d.ts`, `jsconfig.json`). Each mod
folder goes with `rsync --delete`, so a file removed here goes from the app home too. It stops when
the app home has no `mods/` folder.

Each `mods/bw-*/.shared` names the `shared/` files that mod imports, and `sync.sh` first copies them
beside the mod's `main.js` in the repository. After editing `shared/`, run
`scripts/sync.sh --shared-only` to refresh those copies without an app home; `check.sh` fails while a
copy is missing or differs. `--dry-run` lists what would change and copies nothing. On a machine
without `herdr-app`, `check.sh` renders every mod in the headless harness instead and prints
`STAND-IN headless render for N mods (herdr-app check owed)`. [Usage: Install](usage.md#install)
gives the full install steps.

## Theme and colours

Bellwether draws in Catppuccin Mocha with a Mauve (`#cba6f7`) accent, in the shapes of the Flockbook
layout: tabs in a floating capsule, pills for counts and states, rounded chips for tool calls, letter
tiles for projects, cards for menus, dialogs and requests. It stays dark whatever the system
appearance.

- `shared/palette.js` holds every colour value: the 26 Mocha colours, the role each Herdr theme
  colour takes, and the terminal's 16 ANSI colours (Ghostty 1.4.0's Catppuccin Mocha port). No other
  mod file has a colour literal; mods draw with `theme()` roles and take the rest from the palette.
- `themes/bellwether.json` is the layout's own Herdr theme, written from the palette by
  `bun scripts/gen-theme.js` (`--check` fails when the two differ). The layout's root names it, so
  Herdr offers it only in this layout. Text selection in terminals is a quarter of Mauve over Base.
- `shared/ui.js` draws the shared pieces: status marks, pills, chips, monogram tiles, cards and
  buttons.
- Motion follows state and uses Herdr's native animation only: a working agent's mark spins, a
  blocked one breathes (opacity 0.65 to 1), a done check fades in, menus, dialogs and request cards
  fade and slide in once, and hover fills fade. An idle window does not move.
- `bun scripts/verify/contrast.js` lists every colour pair the mods draw and checks WCAG AA: 4.5:1
  for text, 3:1 for status marks and meaningful icons. `tests/theme.test.js` runs it with the rest
  of the tests, and checks that the theme file equals what `gen-theme.js` writes.

After changing `shared/palette.js`, run `bun scripts/gen-theme.js`, `scripts/sync.sh --shared-only`
and `bun test tests/theme.test.js tests/ui.test.js`.

## Bumping the helper version and protocol

`shared/helper.js` runs a mod's `bw` call only when `bw version` reports exactly its `PROTOCOL` and
`HELPER_VERSION`, now protocol 7 and version 0.7.0. `bw machine status` calls another machine's
helper `current` only when both match this Mac's. Bump the version for every helper change a mod
relies on: another machine keeps its old helper until the version differs. Bump the protocol too
when a command's arguments or output lines change shape.

The values live in these files:

- `crates/bw/Cargo.toml` `version`, which `bw version` reports.
- `crates/bw/src/version.rs` `PROTOCOL`.
- `shared/helper.js` `PROTOCOL` and `HELPER_VERSION`, copied into `bw-browser`, `bw-chat`,
  `bw-diff`, `bw-linear`, `bw-new` and `bw-projects`.
- `Cargo.lock`, which records the `bw` version. Run `cargo build -p bw` once without `--locked`,
  since `scripts/test.sh` runs cargo with `--locked`.
- The tests and fixtures that pin them: `crates/bw/tests/version.rs`, `crates/bw/tests/install.rs`,
  `shared/helper.test.js`, `tests/mods/bw-chat-dock.test.js`, `tests/mods/bw-chat-threads.test.js`,
  the `version` lines in `tests/fixtures/live/browser-panel.json`, `chat-remote.json`,
  `chat-requests.json` and `chat-tab.json`, and `scripts/verify/sessions-run.js`.
- The docs that name the requirement, `RECIPE.md` included.

This command lists every file that names the current values:

```sh
git grep -l -F -e '0.7.0' -e 'PROTOCOL: u32' -e 'protocol\":7' -e 'protocol: 7' -e 'protocol"], 7' -- ':!tests/fixtures/sessions'
```

Then run `scripts/sync.sh --shared-only`, `scripts/test.sh`, and `scripts/install-helper.sh` for
this Mac. Run `scripts/build-dist.sh` (it needs `cargo zigbuild`) before a Linux machine can get the
new helper. A mod that finds another machine's helper missing or outdated runs this Mac's
`bw machine install <machine>` and checks again; `scripts/verify/install.sh --machine <machine>`
checks the same by hand. [Architecture: The helper on each machine](architecture.md#the-helper-on-each-machine)
describes the install.

## Third-party code

Flockbook (`minchenlee/flockbook`) and Shepherdr (`eliasstravik/shepherdr`) are MIT licensed, and
herdr-t3 (`JinJieBeWater/herdr-t3`) is Apache 2.0 with its license in `licenses/Apache-2.0.txt`.
Code copied or adapted from any of them keeps its copyright notice. Record each borrowed file in
`THIRD_PARTY_NOTICES.md` in the same commit, with its source path, the source commit and how it was
used. A change to `crates/vendor/herdr-core` needs a test and an entry in its `UPSTREAM` file.

## Repository rules

The repository syncs through Syncthing between macbook and macmini
(`/Volumes/WorkSSD/Personal/bellwether`) and tsuki (`/home/dileep/Documents/Personal/bellwether`),
`.git` and its index included, so a stale index can arrive from another machine. Work on one machine
at a time, and wait for Syncthing to show Up to Date before switching. Before every commit run `git diff --cached --stat` and confirm it
lists only the intended files. If it does not, rebuild the index with `git reset -q` and stage
again. Never run `git gc`: it rewrites `.git`, which Syncthing then syncs to the other machines. The
Syncthing ignore file, `.stignore`, lives untracked in the synced checkout and keeps `node_modules`,
`target` and `.git/worktrees` off the other machines.

Plans, review reports and summary pages for the user stay untracked under `docs/drafts/`, which
`.gitignore` ignores.

`REVIEW.md` sets what a review looks for: a key or message that can reach another agent or prompt,
a Linear key or private transcript that leaks, a feature that differs for a space on another
machine, a mod that polls live data, animates with a timer or blocks on `exec`, borrowed code
without a notice, a mod not named `bw-<name>`, an edit to Herdr's shipped files, a `shared/` copy that
differs from its source, vendored changes without a test and `UPSTREAM` note, and Git calls without
the read-only flags. It skips style that `cargo fmt`, `cargo clippy` and Biome settle, untouched
vendored code and the generated files. Changes to `hooks/`, `scripts/install-*`, `scripts/sync.sh`,
`crates/bw/src/machine/`, `.stignore` and `.gitignore` need a human review.

## Checks still owed

- No window run has shown the `macbook` heading while `macbook` is offline. Ending the core's SSH
  session to `macbook` does not show it, because the core reconnects within 0.5 s. Keeping `macbook`
  offline needs a change to `~/.ssh/config` or a firewall rule. The scripted check
  `scripts/verify/projects.sh --machine macbook` ("an unreachable machine keeps its rows",
  `unreachable-named`) covers the model's side, with a machine named `bw-unreachable` that hc
  refuses.
- No window run has shown a Claude chat on another machine, and `sessions.sh --machine` runs only
  Codex there. Claude started on another machine by a core that SSH started cannot read that
  machine's login keychain ([Usage: Agents on another machine](usage.md#agents-on-another-machine)).
- A machine without `herdr-app`, CI included, runs the headless stand-in in place of
  `herdr-app check`.
- `linear.sh` without a key in this Mac's Keychain runs only the fake Linear.
