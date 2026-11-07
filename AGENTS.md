# AGENTS.md

Guidance for coding agents. `CLAUDE.md` is a symlink to this file.

## Sources of truth

- Herdr's own authoring guide, rewritten by the app on every start:
  `~/.config/herdr-app/AGENTS.md`. Its type files, `herdr.d.ts` and
  `gpui-kit.d.ts` in the same folder, are the API. Read them before writing a
  layout or mod; they change between Herdr versions.
- `docs/brief/` holds the user's requests verbatim. Never edit the quoted words.
- `docs/research/` records what Flockbook, Shepherdr, herdr-t3 and Herdr's
  example layouts do, with file paths, so a plan can cite them.

## Rules that come from how Herdr works

- Herdr replaces its shipped layouts and mods on every start. Never edit them
  in `~/.config/herdr-app`; work here and copy in with `scripts/sync.sh`.
- Name every mod `bw-<name>` and the layout `bellwether`.
- A mod cannot import outside its own folder. Shared JavaScript lives in
  `shared/` and `scripts/sync.sh` copies it into each mod that lists it.
  `scripts/check.sh` fails when a copy differs from its source.
- `exec` returns once, with a 30 s and 8 MiB cap, and nothing streams. Work
  that watches logs or Git runs in a Rust helper that a mod polls or reads.
- Mods run on the machine showing the window; spaces can live on another
  machine (`exec(..., { on: space.machine })`).
- After any change to a mod, `scripts/sync.sh` and `scripts/check.sh` must
  pass, then look at the window (`herdr-app shot`). A passing check does not
  show that a layout fits.

## Reusing reference code

Flockbook (`minchenlee/flockbook`) and Shepherdr (`eliasstravik/shepherdr`)
are MIT licensed. Code copied or adapted from either keeps its copyright
notice: record each borrowed file in `THIRD_PARTY_NOTICES.md` with its source
path and commit.

## This repository syncs through Syncthing

`.git` syncs between macbook, macmini and tsuki, index included, so a stale
index can arrive from another machine. Before every commit run
`git diff --cached --stat` and confirm it lists only the intended files. If
it doesn't, rebuild the index with `git reset -q` and stage again. Work on
one machine at a time and wait for Syncthing to show Up to Date before
switching.

## Personal artifacts

Plans, review reports and summary pages for the user stay untracked under
`docs/drafts/` (ignored).
