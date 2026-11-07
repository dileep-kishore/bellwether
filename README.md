# Bellwether

A personal layout and set of mods for the [Herdr app](https://herdr.dev):
projects grouped with their worktrees and agent status in the sidebar, a chat
view of each agent built from its session log, a Git diff viewer against
`origin/main` or a chosen ref, a Chrome that you and the agents share, and
Linear issues that can be attached to the current chat. Rust helpers do the
heavy work; the mods draw the window.

Status: phases 1 (window and project sidebar), 2 (chat tabs), 3 (sub-agents
and requests) and 4 (a shared browser) are built and their headless checks
pass; their checks in a Herdr window are still owed. Diffs and Linear come in
later phases.

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
while a terminal has focus. In a terminal sub-agent's view `⌘J` flips to the
parent agent's terminal, not the sub-agent's.

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
`/clear` or `/new` the feed names the new session and the chat drops the old
rows. Codex's new session has no log until its first message, so that message
goes with `--expect-session <id> --expect-path none`; Claude 2.1.319 writes
the new conversation's log at `/clear`, so its next message goes with the new
session and that log. When Codex holds several conversations open, as it does for 60 s after
`/resume`, the chat says so, shows no new rows and sends nothing until one
remains. The text stays in the composer after a refusal.

## What phase 3 delivers

A chat shows its session's sub-agents and takes the approvals and questions of
the agent and its sub-agents, for a space on this Mac or on another machine.
Each poll is one `bw feed --tree --cards` call, which carries the session
tree and the requests with the rows.

- The threads card floats at the top right of the timeline: the parent row,
  then each sub-agent nested by depth, with a state icon (running, done, or
  asking), its type, its description, its age and a request badge. A
  sub-agent that runs in its own Herdr terminal under the chat's terminal is
  listed too. The card is open while a sub-agent runs or asks and folds to a
  pill such as "2 sub-agents · 1 asks" otherwise. The header's threads
  button, which shows the count, opens or folds it, and that choice holds
  until the set of running sub-agents changes.
- Clicking a sub-agent shows its own transcript (`bw feed --session
  <child>`). A 44 px bar replaces the composer, for example "Explore ·
  sub-agent of Claude · running · Back to Claude". A terminal sub-agent opens
  as a chat of its own terminal, with a composer that sends to it. When the
  root conversation changes (`/clear`, `/new`) the chat returns to the parent
  and says "This conversation ended; showing the new one".
- The request dock sits above the composer in every view, one card per
  request, newest last. An approval card says who asks, shows the command and
  offers Approve, Always allow (when the prompt has that option), Deny and
  Answer in terminal (which flips to the terminal). A question card has step
  tabs when it asks several questions, options with 1 to 9 key hints (a digit
  selects, it never submits), checkboxes for a multi-select question, an
  Other field and Submit. A Codex async question is answered as one message.
  Codex's `/new` folder prompt, "Where should the new conversation run?",
  gets a card with one button per option, so a `/new` sent from the composer
  finishes in the chat.
- A card's state comes from `bw cards`: `pending`; `answered` or `declined`
  when Bellwether's key or message went out; `answered_terminal` or
  `declined_terminal` when the box left and the call's result in the log says
  how it was answered; `settling` for up to 5 s while the box has left and the
  call has no result in the log yet; `stale` when no result came; `uncertain`
  when keys went out and the screen did not show the box leave. The chat adds
  `sending` while its `bw answer` runs. Only a `pending` card offers its
  buttons, and a resolved card stays 10 s. A card shows only "Answer in
  terminal" when Bellwether cannot read the prompt, its command is cut off at
  the top of the screen, or the root lookup names no single conversation.
- Answer buttons stay disabled while the chat's terminal has focus and for
  3 s after it loses focus, for example after `⌘J`; a freshly opened chat
  counts as focused. `bw answer` presses keys only after a fresh screen read
  shows the same prompt the card showed, with `bw send`'s conversation
  checks.
- `bw-projects` adds `+N` (running sub-agents) and a request badge to each
  agent line, from `bw counts` on each machine every 10 s and at once when an
  agent's status changes.

### Hooks

The hooks tell the chat which sub-agent asked and which call a prompt
belongs to. Without them the dock still shows each prompt on screen, and names
a sub-agent only when that sub-agent's log shows the call. The hook,
`hooks/bw-event`, runs only in a Herdr terminal (`$HC_TERMINAL_ID`), hands
the payload to `bw event`, prints nothing and exits 0, so it never answers
for you. `bw event` writes one file per event under
`~/.cache/bellwether/events/<terminal>/` (24 h, at most 2,000 files).

When a machine lacks them, the dock says "Bellwether hooks are not set up on
<machine>; requests show without who asked" (or that they are out of date)
with Review changes and Not now.
Review changes runs `bw machine setup <machine> --diff` and shows the diff of
both files; Apply runs `--apply` with the SHA-256 of each file the diff read,
so a file that changed since is refused untouched. Not now hides the notice
for that machine. The same steps from a shell:

```sh
bw machine setup <machine|local> --check    # {"type":"hooks","claude":…,"codex":…,"agent":…}
bw machine setup <machine|local> --diff     # one hooks-diff line per file, with its sha256
bw machine setup <machine|local> --apply [--expect-sha <claude sha>,<codex sha>]
bw machine setup <machine|local> --remove
bw machine setup <machine|local> --agent    # phase 4's agent files; see "Agent files" below
```

`--apply` copies `hooks/bw-event` to `~/.local/share/bellwether/hooks/` on
that machine and appends one group per event (`PermissionRequest`,
`PreToolUse`, `SubagentStart`, `SubagentStop`) after every existing group in
`$CLAUDE_CONFIG_DIR/settings.json` (else `~/.claude/settings.json`) and
`$CODEX_HOME/hooks.json` (else `~/.codex/hooks.json`). Each command starts with
`: bellwether-hook=1;`, and only groups marked that way are ever changed:
applying twice changes nothing, and `--remove` takes out only Bellwether's
groups. A file that is not valid JSON is refused untouched. Before a write,
the old file is copied to `~/.local/share/bellwether/backups/<name>.<ms>`,
and `~/.local/share/bellwether/hooks/installed.json` records the version,
the path and both SHA-256 values. `bw hooks check|diff|apply|remove` does the
same on the machine it runs on, and takes `--claude-settings <file>` and
`--codex-hooks <file>` for other files.

Codex runs a new hook only after you trust it. Until then `check` says
`untrusted` and the dock says "Codex hook not trusted on <machine>" with the
step: start Codex there and choose "Trust all and continue" (2, then Enter),
or type `/hooks` and press `t`. `check` compares the `trusted_hash` Codex
records in `config.toml` with the one it computes for each of Bellwether's
groups, and never writes `config.toml`.

## What phase 4 delivers

Claude and Codex agents started from "+" share one Google Chrome with you,
the Bellwether Chrome. The right sidebar's Browser panel shows its tabs.

The Bellwether Chrome is a second Google Chrome instance with its own profile,
`~/.local/share/bellwether/chrome`, and its DevTools port on 127.0.0.1:9222.
Bellwether never uses or touches your own Chrome or its default profile.
`bw browser up` reuses a Chrome on that port only when every listener is on
127.0.0.1 or [::1], the listening process's command line holds
`--user-data-dir=<that profile>`, and `/json/version` answers. When the port
is free and the profile is not running, it starts Chrome with `open -n`.
`--background` adds `-g`, which keeps focus where it is. Otherwise it starts
nothing and names the state: `port_taken` with the pid and command of the
program on the port, or `no_debug_port` when the profile runs without the
port. It reports `not_installed` when it finds no Google Chrome and
`start_failed` when Chrome does not start or answer. `bw browser down` sends
the CDP command `Browser.close` to that Chrome only and never signals a
process.

The Browser panel is the `bw-browser` mod, which replaces the Browser
placeholder in `layouts/bellwether.json`. Its header shows "Bellwether
Chrome", the state such as "Running · 6 tabs" or "Not running", and the New
tab and Arrange buttons. It adds Start when Chrome is stopped, runs without
the port or failed to start. Below the header:

- Each tab has one row with its favicon, title, host and path. An accent bar
  marks the active tab. Clicking a row focuses that tab, and hovering shows a
  close button.
- The Forwards section lists each forward with its state and a Stop button.
- Forward port adds a forward for a dev server
  (`ssh -L 127.0.0.1:<n>:127.0.0.1:<n>`) from the active space's machine.
  For a space on this Mac it is disabled and says "This space is on this
  Mac".
- Arrange places Chrome beside the Herdr window, at Herdr's top and height:
  in the gap to its right when that gap is at least 640 points wide, else in
  the gap to its left when that one is, else on the right half of that
  display. It works on macOS only and shows its result for 4 s.

The panel runs one `bw browser status` every 2 s while shown and none while
hidden. It caches favicons for 7 days in the app home's
`data/bellwether/favicons/`, with at most 4 new fetches per poll.

Each Claude or Codex row in "+" (New chat and New terminal) first runs
`bw browser agent-args` on the window machine for up to 20 s, and the row
shows "Preparing browser…". That command starts the Bellwether Chrome in the
background when it is not running. For an agent on another machine it also
makes sure that machine's forward runs. Claude then starts with
`--mcp-config <agent dir>/claude-mcp-<window>.json --allowedTools mcp__bw-browser --append-system-prompt-file <agent dir>/browser-claude.md`,
where `<agent dir>` is `~/.local/share/bellwether/agent` on the agent's
machine. Codex starts with `-c mcp_servers.bw-browser.*` flags (command `sh`
with the launcher, `default_tools_approval_mode="approve"`,
`startup_timeout_sec=60`) and `-c developer_instructions=…`. That value is
Codex's effective `developer_instructions` followed by `browser-codex.md`.
Codex's effective value comes from the top-level `config.toml`, then the
profile file a `--profile` or `-p` names, then a trusted project's
`.codex/config.toml`. "+" reads that project file in the folder the agent
starts in: the space's focused terminal's folder, else the folder of the
space's first pane. It names the same folder to `tab.new`.

These additions last for that session only. No user setting is written.
Claude never gets `--strict-mcp-config`, so your own MCP servers stay. When
the browser is unavailable, the agent starts with no additions and Herdr shows
"Started without the browser" with the reason. That happens when Chrome
cannot start, the machine is reached through `via` or is offline, the forward
is refused, Node is missing, or Codex's `config.toml` does not parse. Shell
rows are unchanged.

The MCP server is Chrome DevTools MCP 1.12.0, named `bw-browser`. It runs
through `npx -y chrome-devtools-mcp@1.12.0` and is never installed globally.
It runs with usage statistics and CrUX off and takes JPEG screenshots at most
1280 px wide. The instructions (`agent/browser.md` and its Claude and Codex
copies) tell the agent to open its own background tab and act only in tabs
it opened. They tell it never to type passwords, codes or payment details,
and to leave its tab open for you to close from the panel.

For a space on another machine, `bw browser forward ensure` keeps one SSH
reverse forward per machine. The forward is a kept `hc` terminal named
`bw-fwd-<machine>` that runs `bw browser forward keep`. That command
supervises
`ssh -o ExitOnForwardFailure=yes -o BatchMode=yes … -N -R 127.0.0.1:<port>:127.0.0.1:9222 <target>`.
After each connect it runs `bw browser port-check` on that machine. The port
must listen only on 127.0.0.1 or [::1], and its `/json/version` must carry
this Chrome's browser id. A failed check closes the forward and writes
`refused`, and the supervisor never retries it. When ssh exits, the
supervisor writes `reconnecting` and retries after 2, 4, 8, 16 and 30 s, then
every 60 s, on the same port with the same checks. When another program takes
the port in the meantime, it writes `port_taken`, and the next `ensure` picks
a new port. The state files live in
`~/.local/share/bellwether/browser/forwards/<core>/`. Agents on that machine
find the forward's port in `~/.local/share/bellwether/agent/ports/<window>`.

### Agent files

`bw agent ensure` writes these files under `~/.local/share/bellwether/agent/`
on each machine where an agent starts:

- `browser.md`, `browser-claude.md` and `browser-codex.md` hold the
  instructions.
- `browser-mcp` is a 0755 `sh` launcher. It reads `ports/<window>`, finds
  `npx` on PATH or in `/opt/homebrew/bin` or `/usr/local/bin`, and runs Chrome
  DevTools MCP 1.12.0 against `http://127.0.0.1:<port>`.
- `claude-mcp-<window>.json` is Claude's `--mcp-config` file.
- `ports/<window>` holds the port this window's Chrome answers on there: 9222
  on the window machine, the forward's port elsewhere.

`<window>` is the window machine's `hostname -s`, lower-cased, reduced to
a-z, 0-9 and -, and at most 32 characters long. `ensure` rewrites a file only
when its bytes differ. The first `ensure` on a machine fetches the package
into the npx cache once, with a 25 s limit, and records it with the marker
`warm-1.12.0`. Every "+" refreshes these files, so no machine needs a manual
step.

### Commands

```sh
bw browser up [--background] | down
bw browser status                                   # chrome line, one tab line per page, one forward line per forward
bw browser tabs | focus --id <id> | close --id <id> | new [--url <url>]
bw browser arrange [--owner-pid <pid>]
bw browser agent-args --kind claude|codex --machine <m|""> [--cwd <dir>] [--profile <p>]
bw browser forward ensure --machine <m>
bw browser forward dev --machine <m> --port <n>
bw browser forward stop --machine <m> [--dev <n>]
bw browser forward list
bw browser free-port [--prefer <port>]
bw browser port-check --port <port> --browser-id <id>
bw agent ensure --window <w> [--port <p>] [--no-warm]
bw agent args --kind claude|codex --window <w> [--cwd <dir>] [--profile <p>]
bw agent warm
bw machine setup <machine|local> --agent
```

`bw browser …` runs on the window machine. `bw agent …`,
`bw browser free-port` and `bw browser port-check` run on the space's
machine, where the window machine's `bw` runs them with `hc exec`. The
forward's terminal runs `bw browser forward keep`, the supervisor, so you
never call it by hand. Most `bw browser …` commands print JSON lines and exit
0 for every state; only a usage error exits 2.

`bw machine setup <m> --agent` is a fifth operation beside `--check`,
`--diff`, `--apply` and `--remove`, and setup takes exactly one of them. It
runs `bw agent ensure` on that machine, changes no user setting and needs no
approval. The `hooks` line of `--check` gains
`"agent":"ok"|"missing"|"outdated"`.

### Removal

```sh
rm -r ~/.local/share/bellwether/agent      # on each machine: the agent files
bw browser forward stop --machine <m>      # hc kill and hc rm on the forward's terminal, and delete its state file
bw browser down                            # close the Bellwether Chrome
```

The Chrome's profile stays in `~/.local/share/bellwether/chrome`. Deleting
that folder removes its history and sign-ins.

### Known limits

- An agent's browser MCP needs Node and `npx` on the machine the agent runs
  on. Without them the agent starts without the browser (`node_missing`).
- The first session on a machine may wait on the npx download of
  `chrome-devtools-mcp@1.12.0` when the one-time warm-up has not finished.
- A machine that `hc` reaches through `via` gets no browser, because the
  forward needs SSH ("browser forward unavailable: <m> connects through via,
  not SSH").
- Claude's `--allowedTools mcp__bw-browser` lets its browser tools run
  without a permission prompt, as Codex's `approve` does. The instructions
  forbid passwords, one-time codes, payment details and purchases.
- Arrange works on macOS only.
- The checks in a Herdr window are still owed: the panel, Arrange beside a
  real Herdr window, a screenshot inline in a chat, and a real SSH machine.

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
hooks/bw-event            the hook bw machine setup installs; it hands each event to bw event
agent/                    the browser instructions and MCP launcher that bw embeds and bw agent ensure writes to each machine
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

`scripts/verify/sessions.sh` compares `bw feed` on the recorded sessions in
`tests/fixtures/sessions/` with their goldens and hand counts, including each
sub-agent's own rows (`child-rows`) and `bw tree`'s nesting
(`tree-nested-subagent`). Without `--offline` it also runs Claude haiku and
Codex in a private `hc` core (`HC_SESSION=bw-sessions`) in scratch Git
repositories, then feeds, sends and refuses through `bw`: each chat's first
message, a text starting with `--`, a picture, a send refused after `/clear`
and while Claude waits on a prompt, a Codex root found beside its sub-agent,
the live sub-agent trees (`claude-children-live`, `codex-child-tree`), and
the chat's next message after a real `/clear` or `/new`
(`claude-clear-next-message`, `codex-new-next-message`, with Codex's folder
prompt answered through its card). Claude 2.1.319 writes the new
conversation's log at `/clear`, so that message goes with the new session and
its log; after Codex's `/new` the new session has no log, so it goes with
`--expect-session <id> --expect-path none`. It spends tokens. It prints
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
machine), including its sub-agent tree and `/new`. Claude on another machine
is still owed to a window run.

`scripts/verify/requests.sh` checks the request dock's commands. Offline it
compares `bw cards` on each `tests/fixtures/cards` case with its golden, runs
`bw hooks` on copies of `tests/fixtures/hooks` in a scratch HOME, and runs the
chat's focus guard tests. Live it runs Claude haiku
(`--permission-mode default`) and Codex in a private core
(`HC_SESSION=bw-requests`): root, foreground and background sub-agent
approvals answered with `bw answer` (the file absent before, present after),
a prompt answered in the terminal first (the old card gives `stale` and the
screen does not change), Deny, Codex root and sub-agent approvals, and a Codex
async question answered as one message. With `--machine <name>` it also runs
`bw machine setup <name>` there and Codex approvals, a stale card and an async
question through the helper there, then removes the hooks and puts that
machine's files back. It records the SHA-256 of `~/.claude/settings.json`,
`~/.codex/hooks.json` and `~/.codex/config.toml` here and fails if any
changed.

```sh
scripts/verify/requests.sh --offline          # goldens, hooks and the focus guard; what scripts/test.sh runs
scripts/verify/requests.sh                    # also real agents here
scripts/verify/requests.sh --machine <name>   # also Codex on <name>; <name> must be a temporary hc machine (bwloop)
```

`scripts/verify/feed-cost.sh [runs]` times `bw feed --log … --pictures` on
the largest Claude and Codex logs on this Mac: a first read, an unchanged
cursor and one appended line, each `runs` times (default 5) on a scratch
copy. It prints a Markdown table of sizes and user plus system milliseconds,
never a path or a log's text. `docs/research/2026-11-06-phase2-feed.md` holds
the macmini results: at most 14 ms per read.

## Checking the browser

`scripts/verify/browser.sh --offline` runs no agent and starts nothing: it
checks that the files exist, that `bun test tests/browser` passes and that
`bw browser status` parses. The live run needs `--machine` with a machine
that `hc machine ls --json` marks temporary (bwloop). Its Chrome runs on a
scratch profile and a free port, never 9222 or the real profile, and
`bw browser down` stops it. `claude -p` here and Codex on the temporary
machine each click a button in a tab they opened (`claude-p-clicked`,
`codex-clicked`). Codex reaches this Chrome through a real `ssh -R` forward
to a scratch `sshd`. The script also runs interactive Claude in a private
core (`HC_SESSION=bw-browser`, check `interactive-claude`) and looks for each
agent's screenshot in `bw feed --pictures` (`claude-picture`,
`codex-picture`). It puts back each file it changed on that machine and here,
and deletes the files it created. It prints `PASS` or `FAIL` per check and
exits 1 on any `FAIL`. It fails when `~/.claude/settings.json`,
`~/.codex/hooks.json` or `~/.codex/config.toml` changed, when
`~/.claude.json` gained a `bw-browser` trace, or when your own Chrome
processes changed. It spends tokens.

```sh
scripts/verify/browser.sh --offline          # files exist, bun test tests/browser, bw browser status parses; what scripts/test.sh runs
scripts/verify/browser.sh --machine <name>   # real agents; <name> must be a temporary hc machine (bwloop)
```

## The bw helper on each machine

Mods call `~/.local/share/bellwether/helper/current/bw` on the machine a space
lives on. `current` links to a version folder, so an update swaps one link.
`shared/helper.js` needs `bw version` to report version 0.4.0 and protocol 4.
Phase 4's helper adds the `browser` and `agent` commands, so every machine's
helper reinstalls once. When another machine's helper is missing or
outdated, a mod runs this Mac's `bw machine install <machine>` and checks
again; this Mac's own helper comes from `scripts/install-helper.sh`.

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

A chat tab and the project sidebar use more commands, each printing JSON
lines:

```sh
bw feed (--terminal <t> [--session <child>] | --log <path> --agent claude|codex [--scope root|claude-subagent|codex-child:<ordinal>]) [--cursor <c> | --before <start>] [--pictures] [--tree] [--cards]
bw locate --terminal <t> [--fresh]
bw send --terminal <t> --expect-kind <claude|codex> --expect-session <id|none> --expect-path <log|none> --text <message>
bw picture --terminal <[machine/]t> --offset <n> --index <i> --digest <16 hex>
bw picture-read --terminal <t> --offset <n> --index <i> --digest <16 hex>
bw tree (--terminal <t> | --log <path> --agent claude|codex)
bw cards --terminal <t>
bw answer --terminal <t> --request <id> --expect-kind <claude|codex> --expect-session <id|none> --expect-path <log|none> (--action approve|always|deny|option-<n> | --answers <json>)
bw counts --terminals <t1,t2,…>
bw hooks check|diff|apply|remove
bw event --agent claude|codex
```

`bw feed`, `bw locate`, `bw send`, `bw picture-read`, `bw tree`, `bw cards`,
`bw answer`, `bw counts`, `bw hooks` and `bw event` run on the space's machine
with the terminal's local address. `bw answer` runs there for the same reason
`bw send` does: its last screen read and its key are one local step. `bw locate` names the agent, the
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

`bw tree` lists a session's sub-agents from Claude's
`subagents/*.meta.json` files and Codex's sub-agent records, with each one's
parent, depth, type, description and state. `bw feed --session <child>` feeds that child's
log, `--tree` adds one `tree` line before the rows, and `--cards` adds the
`cards` and `request` lines after them. `bw cards` reads the screen only while
`hc get` says `blocked` (and, for Codex's folder prompt, whenever Codex is not
working), binds each prompt to its hook events and log call, and keeps each
prompt's state in `~/.cache/bellwether/requests/` (24 h). `bw answer` prints
one `answer` line whose result is `answered`, `declined`, `stale`,
`uncertain`, `refused-conversation`, `refused-agent`, `refused-prompt`,
`already-answered`, `busy`, `not-answerable` or `failed`; it gives up at 25 s.
`bw counts` prints one `count` line per terminal (at most 64) with its running
sub-agents and waiting requests, and reads no screen. `bw machine setup` runs
on the window machine and reaches the other machine with `hc exec`; `local`
runs it in process.

## Machines

The repository syncs between macbook and macmini (`/Volumes/WorkSSD/Personal/bellwether`)
and tsuki (`/home/dileep/Documents/Personal/bellwether`) through Syncthing,
`.git` included. Work on one machine at a time.
