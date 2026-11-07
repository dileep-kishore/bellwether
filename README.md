# Bellwether

A personal layout and set of mods for the [Herdr app](https://herdr.dev):
projects grouped with their worktrees and agent status in the sidebar, a chat
view of each agent built from its session log, a Git diff viewer against
`origin/main` or a chosen ref, and Linear issues that can be attached to the
current chat. Rust helpers do the heavy work; the mods draw the window.

Status: phase 0 (foundation) is in progress: the `bw` helper crate and the
`bellwether` layout exist; no mods yet.

## Layout of this repository

The folders mirror `~/.config/herdr-app`, so a sync is a plain copy:

```text
layouts/bellwether.json   the window, cloned from Herdr's main layout
mods/bw-*/                one folder per mod, named bw-* so none clashes with Herdr's
shared/                   JavaScript used by several mods; scripts/sync.sh copies it in
scripts/sync.sh           copy layouts and bw-* mods into ~/.config/herdr-app
scripts/check.sh          herdr-app check on every mod, and shared copies match
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

## Machines

The repository syncs between macbook and macmini (`/Volumes/WorkSSD/Personal/bellwether`)
and tsuki (`/home/dileep/Documents/Personal/bellwether`) through Syncthing,
`.git` included. Work on one machine at a time.
