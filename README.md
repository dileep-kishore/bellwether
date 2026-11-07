# Bellwether

A personal layout and set of mods for the [Herdr app](https://herdr.dev):
projects grouped with their worktrees and agent status in the sidebar, a chat
view of each agent built from its session log, a Git diff viewer against
`origin/main` or a chosen ref, and Linear issues that can be attached to the
current chat. Rust helpers do the heavy work; the mods draw the window.

Status: phase 0 (foundation) is in progress: the `bellwether` layout and the
`bw` helper exist, and `bw` installs itself on other machines; no mods yet.

## Layout of this repository

The folders mirror `~/.config/herdr-app`, so a sync is a plain copy:

```text
layouts/bellwether.json   the window, cloned from Herdr's main layout
mods/bw-*/                one folder per mod, named bw-* so none clashes with Herdr's
shared/                   JavaScript used by several mods; scripts/sync.sh copies it in
scripts/sync.sh           copy layouts and bw-* mods into ~/.config/herdr-app
scripts/check.sh          herdr-app check on every mod, and shared copies match
scripts/test.sh           every check that needs no Herdr window
scripts/install-helper.sh build bw and install it on this machine
scripts/build-dist.sh     build bw for other platforms into ~/.local/share/bellwether/dist
scripts/verify/           checks against real machines and agents
crates/                   Rust helpers; crates/bw is the bw binary the mods run
crates/vendor/            code copied from other projects, in its own Cargo workspace
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
touches Herdr's shipped layouts and mods or anyone else's.

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
