# Bellwether

A personal layout and set of mods for the [Herdr app](https://herdr.dev):
projects grouped with their worktrees and agent status in the sidebar, a chat
view of each agent built from its session log, a Git diff viewer against
`origin/main` or a chosen ref, and Linear issues that can be attached to the
current chat. Rust helpers do the heavy work; the mods draw the window.

Status: phase 1 (window and project sidebar) is built and its headless checks
pass; its checks in a Herdr window are still owed. Chat, diffs and Linear come
in later phases.

## What phase 1 delivers

The `bellwether` layout has three columns: the left sidebar (248 px, 160 to
480), the active tab with a 32 px tab bar over it and Herdr's
`workspace-status` under it, and a right sidebar (360 px, 280 to 900) that
`cmd-alt-b` hides and shows. Six mods fill it:

- `bw-projects` lists each machine's projects with every Git worktree, its
  ahead and behind counts, its `+N −M` change counts and one line per agent.
  A dimmed row is a worktree with no open space; clicking it opens one there.
- `bw-tabs` is the tab bar of the active space. Drag a tab to reorder it.
- `bw-new` is the tab bar's "+" menu: a shell, Claude or Codex in the space,
  and Herdr's New worktree and Open worktree dialogs.
- `bw-right` is the right sidebar's strip of Changes, Issues and Browser,
  whose panels say which phase fills them.
- `bw-menu` is a project's menu in `bw-projects`: worktree dialogs and
  Remove.
- `bw-add` is the Add project dialog: pick a machine and a folder, and Git
  finds the repository it belongs to.

A space on another machine works the same: Git runs there through
`exec(..., { on })`, and an offline machine keeps its last rows.

## Layout of this repository

The folders mirror `~/.config/herdr-app`, so a sync is a plain copy:

```text
layouts/bellwether.json   the window, cloned from Herdr's main layout
mods/bw-*/                one folder per mod, named bw-* so none clashes with Herdr's
shared/                   JavaScript used by several mods; scripts/sync.sh copies it in
keys/bellwether.json      Bellwether's key bindings, merged by scripts/keys-merge.js
scripts/sync.sh           copy layouts and bw-* mods into ~/.config/herdr-app
scripts/keys-merge.js     merge keys/bellwether.json into the app home's keys.json
scripts/check.sh          herdr-app check (or the headless stand-in) on every mod, and shared copies match
scripts/test.sh           every check that needs no Herdr window
scripts/gen-herdr-api.js  extract Herdr's API names into tests/harness/api.json
scripts/install-helper.sh build bw and install it on this machine
scripts/build-dist.sh     build bw for other platforms into ~/.local/share/bellwether/dist
scripts/verify/           checks against real machines and agents
crates/                   Rust helpers; crates/bw is the bw binary the mods run
crates/vendor/            code copied from other projects, in its own Cargo workspace
tests/                    Bun tests, and the headless harness that stubs herdr and gpui-kit
docs/brief/               the requests this work answers, verbatim
docs/research/            what the reference projects do, with evidence
```

## Install on a machine

Herdr loads mods from each machine's own `~/.config/herdr-app`. On every
machine that runs the Herdr window, after Syncthing has delivered the repo:

```sh
scripts/sync.sh --dry-run   # list what would change
scripts/sync.sh
scripts/check.sh
```

`sync.sh` copies real files, because Herdr does not load a mod's SVGs through
a symlink. It writes only `layouts/bellwether.*` and `mods/bw-*/`, and never
touches Herdr's shipped layouts and mods or anyone else's. It leaves out each
mod's `.shared` list and the type files Herdr writes into mod folders.

Each `mods/bw-*/.shared` names the `shared/` files that mod imports, and
`sync.sh` first copies them beside the mod's `main.js` in the repository.
After editing `shared/`, run `scripts/sync.sh --shared-only` to refresh those
copies without an app home; `check.sh` fails while a copy is missing or
differs. On a machine without `herdr-app`, `check.sh` renders every mod in the
headless harness instead and prints `STAND-IN headless render for N mods
(herdr-app check owed)`.

Then merge the key bindings. Without `--apply` the script prints each section
before and after and writes nothing; `--apply` writes `keys.json` after saving
a backup beside it:

```sh
bun scripts/keys-merge.js           # show the diff
bun scripts/keys-merge.js --apply   # write it; --home DIR for another app home
```

The script refuses to write while one of Bellwether's keys is already bound
to something else. Herdr stops adding new default shortcuts to a `keys.json`
that has been edited. Switch to the layout with
`herdr-app do layout.switch '{"name":"bellwether"}'`.

## Checking the project sidebar against Git

`scripts/verify/projects.sh` builds scratch repositories, runs the project
model on real Git output and checks it: rows equal `git worktree list`, a
closed row opens its exact folder, counts follow an edit within 2 s, and an
unreachable machine keeps its rows. It prints `PASS` or `FAIL` per check.

```sh
scripts/verify/projects.sh                    # this Mac; prints PENDING for the remote half
scripts/verify/projects.sh --machine <name>   # also builds repositories on <name> through hc
scripts/verify/projects.sh --offline          # no other machine; what scripts/test.sh runs
```

## The bw helper on each machine

Mods call `~/.local/share/bellwether/helper/current/bw` on the machine a space
lives on. `current` links to a version folder, so an update swaps one link.

```sh
scripts/install-helper.sh               # this machine
bw machine status <machine>             # current, missing, outdated, unreachable or no_build
bw machine install <machine> [--force]  # copy this machine's bw there through hc
scripts/verify/install.sh --machine <machine>
```

`bw machine install` reaches the other machine with `hc` (`BW_HC` names another
program). It sends an Apple silicon Mac the running `bw`, and a Linux machine
(x86_64 or aarch64) the build in `~/.local/share/bellwether/dist/<target>/`
that `scripts/build-dist.sh` made, which needs `cargo zigbuild`. Other
platforms get `no_build` and nothing is written there. The copy goes in parts under 6 MB, its
SHA-256 is checked there, and a failed copy leaves `current` as it was.

## Machines

The repository syncs between macbook and macmini (`/Volumes/WorkSSD/Personal/bellwether`)
and tsuki (`/home/dileep/Documents/Personal/bellwether`) through Syncthing,
`.git` included. Work on one machine at a time.
