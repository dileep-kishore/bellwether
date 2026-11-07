# Bellwether

A personal layout and set of mods for the [Herdr app](https://herdr.dev):
projects grouped with their worktrees and agent status in the sidebar, a chat
view of each agent built from its session log, a Git diff viewer against
`origin/main` or a chosen ref, and Linear issues that can be attached to the
current chat. Rust helpers do the heavy work; the mods draw the window.

Status: phases 1 (window and project sidebar) and 2 (chat tabs) are built and
their headless checks pass; their checks in a Herdr window are still owed.
Sub-agents, the browser, diffs and Linear come in later phases.

## What phase 1 delivers

The `bellwether` layout has three columns: the left sidebar (248 px, 160 to
480), the active tab with a 32 px tab bar over it and Herdr's
`workspace-status` under it, and a right sidebar (360 px, 280 to 900) that
`cmd-alt-b` hides and shows. Six mods fill it:

- `bw-projects` lists each machine's projects with every Git worktree, its
  ahead and behind counts, its `+N −M` change counts and one line per agent.
  A dimmed row is a worktree with no open space; clicking it opens one there.
- `bw-tabs` is the tab bar of the active space. Drag a tab to reorder it.
- `bw-new` is the tab bar's "+" menu: a Claude or Codex chat, a shell, Claude
  or Codex in a plain terminal, and Herdr's New worktree and Open worktree
  dialogs.
- `bw-right` is the right sidebar's strip of Changes, Issues and Browser,
  whose panels say which phase fills them.
- `bw-menu` is a project's menu in `bw-projects`: worktree dialogs and
  Remove.
- `bw-add` is the Add project dialog: pick a machine and a folder, and Git
  finds the repository it belongs to.

A space on another machine works the same: Git runs there through
`exec(..., { on })`, and an offline machine keeps its last rows.

## What phase 2 delivers

"+" → New chat → Claude or Codex starts the agent in a new tab on the space's
machine. `bw-tabs` finds that tab by its name, splits a `bw-chat` pane to the
right of the agent's terminal and zooms the chat. `⌘J` (`bw-tabs.chat-flip`)
flips the zoom and focus between the chat and the terminal; the chat header's
"Show terminal (⌘J)" button does the same. A chat tab made in another Herdr
window flips too. `keys/bellwether.json` binds `cmd-j` in
`layout:bellwether`, so merge it with `scripts/keys-merge.js` as below; the
script reports a terminal binding of `cmd-j` as shadowed, since that one wins
while a terminal has focus.

The chat reads the agent's session log through `bw feed` every 2 s while
shown and every 10 s while hidden. A chat behind its terminal's zoom counts as
hidden, and flipping back reads at once. It shows:

- your messages as bubbles and the agent's replies as Markdown;
- one line per run of tool calls, written as a sentence such as "Read 3 files
  and ran 2 commands", with a spinner until every call has a result, then a
  check, or a cross when a call failed; click the line to list the calls;
- a line such as "Changed 2 files · Open in Changes" at the end of a turn
  that edited files; clicking it selects the right sidebar's Changes panel;
- pictures inline, up to 320 px tall, each copied once into the app home's
  `data/bellwether/pictures/` (4 MB at most);
- an approval or question the agent waits on as one line that says where to
  answer it.

Scrolling up with the first row on screen loads older rows.

The composer sends with Enter (Shift-Enter adds a line). `bw-chat` runs
`bw send` through the helper on the space's machine with the terminal's local
address, because `hc send` from another core wraps the text in
`<hc from=…>` and slash commands such as `/new` would not run. `bw send`
looks up the terminal's conversation again and sends nothing when the agent
kind, session or log path differ from what the chat shows, for example when
Claude's `/clear` or Codex's `/new` ran after the chat's last read. It never
passes `--force`, so a terminal waiting on a prompt refuses the text. Claude
and Codex write no log until their first message, so a fresh chat sends it
with `--expect-session none --expect-path none`, which passes only while that
kind of agent runs in the terminal in a session that has no log yet. After
`/clear` or `/new` the feed names the new session, the chat drops the old
rows, and its first message goes with `--expect-session <id> --expect-path
none`. When Codex holds several conversations open, as it does for 60 s after
`/resume`, the chat says so, shows no new rows and sends nothing until one
remains. The text stays in the composer after a refusal.

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

## Checking chats against real agents

`scripts/verify/sessions.sh` compares `bw feed` on the six recorded sessions
in `tests/fixtures/sessions/` with their goldens and hand counts. Without
`--offline` it also runs Claude haiku and Codex in a private `hc` core
(`HC_SESSION=bw-sessions`) in scratch Git repositories, then feeds, sends and
refuses through `bw`: each chat's first message, a text starting with `--`,
a picture, a send refused after `/clear` and while Claude waits on a prompt,
and a Codex root found beside its sub-agent. It spends tokens. It prints
`PASS`, `FAIL` or `PENDING` per check, exits 1 on any `FAIL`, and deletes its
scratch folders and the Claude project folders it wrote on exit.

```sh
scripts/verify/sessions.sh --offline          # recordings only; what scripts/test.sh runs
scripts/verify/sessions.sh                    # also real agents here; PENDING for the remote half
scripts/verify/sessions.sh --machine <name>   # also Codex on <name> through its helper
```

With `--machine`, the script moves `<name>`'s helper link aside to see it
named `missing`, lets the helper install it again, and runs Codex there under
`$BW_SESSIONS_REMOTE_ROOT` (default `$HOME/bw-verify/sessions` on that
machine). Claude on another machine is still owed to a window run.

`scripts/verify/feed-cost.sh [runs]` times `bw feed --log … --pictures` on
the largest Claude and Codex logs on this Mac: a first read, an unchanged
cursor and one appended line, each `runs` times (default 5) on a scratch
copy. It prints a Markdown table of sizes and user plus system milliseconds,
never a path or a log's text. `docs/research/2026-11-06-phase2-feed.md` holds
the macmini results: at most 14 ms per read.

## The bw helper on each machine

Mods call `~/.local/share/bellwether/helper/current/bw` on the machine a space
lives on. `current` links to a version folder, so an update swaps one link.
`shared/helper.js` needs `bw version` to report version 0.2.0 and protocol 2.
When another machine's helper is missing or outdated, a mod runs this Mac's
`bw machine install <machine>` and checks again; this Mac's own helper comes
from `scripts/install-helper.sh`.

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

A chat tab uses five more commands, each printing JSON lines:

```sh
bw feed (--terminal <t> | --log <path> --agent claude|codex) [--cursor <c> | --before <start>] [--pictures]
bw locate --terminal <t> [--fresh]
bw send --terminal <t> --expect-kind <claude|codex> --expect-session <id|none> --expect-path <log|none> --text <message>
bw picture --terminal <[machine/]t> --offset <n> --index <i> --digest <16 hex>
bw picture-read --terminal <t> --offset <n> --index <i> --digest <16 hex>
```

`bw feed`, `bw locate`, `bw send` and `bw picture-read` run on the space's
machine with the terminal's local address. `bw locate` names the agent, the
session and the log a terminal writes. It keeps them per terminal in
`~/.cache/bellwether/feeds/` (`BW_CACHE_DIR` replaces `~/.cache/bellwether`)
and trusts them for 30 s without a process scan; `--fresh` scans anyway.
`bw feed` prints a
`log` line, then `unchanged` or `splice {at, count}` and the rows from `at`
on; with nothing to read it prints one `state` line: `no_core`,
`no_terminal`, `not_agent`, `no_log` (with `session` when the agent names
its new conversation) or `ambiguous` (no single conversation found, which
`bw send` refuses). `bw send` prints one `send` line
whose result is `sent`, `refused-conversation`, `refused-prompt` or
`unconfirmed`. `bw picture` runs on the window machine, reads the picture
through `bw picture-read` on the space's machine (in process when the space
is local), and copies it into Herdr's app home.

## Machines

The repository syncs between macbook and macmini (`/Volumes/WorkSSD/Personal/bellwether`)
and tsuki (`/home/dileep/Documents/Personal/bellwether`) through Syncthing,
`.git` included. Work on one machine at a time.
