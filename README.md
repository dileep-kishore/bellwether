# Bellwether

A personal layout and set of mods for the [Herdr app](https://herdr.dev):
projects grouped with their worktrees and agent status in the sidebar, a chat
view of each agent built from its session log, a Git diff viewer against
`origin/main` or a chosen ref, a Chrome that you and the agents share, and
Linear issues that can be attached to the current chat. Rust helpers do the
heavy work; the mods draw the window.

Status: phases 1 (window and project sidebar), 2 (chat tabs), 3 (sub-agents
and requests) and 4 (a shared browser) are built and their headless checks
pass; their checks in a Herdr window are still owed. Phase 5 (the Changes
panel) is built, and its headless checks and its checks in a Herdr window
pass, except "Open in Changes" from a chat, which only the headless tests
cover. Phase 6 (the Issues panel and Attach) is built, and its headless
checks and its check against Linear pass.

## What phase 1 delivers

The `bellwether` layout has three columns: the left sidebar (248 px, 160 to
480), the active tab with a 32 px tab bar over it and the `bw-status` bar
under it, and a right sidebar (360 px, 280 to 900) that `cmd-alt-b` hides and
shows. Eight mods fill it:

- `bw-projects` lists each machine's projects with every Git worktree, its
  ahead and behind counts, its `+N −M` change counts and one line per agent.
  A dimmed row is a worktree with no open space; clicking it opens one there.
- `bw-tabs` is the tab bar of the active space. Drag a tab to reorder it.
- `bw-new` is the tab bar's "+" menu: a Claude or Codex chat, a shell, Claude
  or Codex in a plain terminal, and Herdr's New worktree and Open worktree
  dialogs.
- `bw-right` is the right sidebar's strip of Changes, Issues and Browser.
  Phase 5's `bw-diff` fills Changes, phase 6's `bw-linear` fills Issues and
  phase 4's `bw-browser` fills Browser.
- `bw-menu` is a project's menu in `bw-projects`: worktree dialogs, Link
  Linear project and Remove.
- `bw-add` is the Add project dialog: pick a machine and a folder, and Git
  finds the repository it belongs to.
- `bw-status` is the bar under the active tab: the shown space's machine and
  branch, the agent count beside the most urgent status, a "needs you" pill
  while any agent waits, and the command palette's key (click it to open the
  palette).
- `bw-pane` is each pane's header: the agent's status, the program, its
  title and folder, and split right, split down, zoom and close buttons that
  fade in while the pointer is on the header.

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
  that edited files; clicking it selects the right sidebar's Changes panel
  and, for one file, that file;
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
127.0.0.1 or [::1], one of the listening process's arguments is exactly
`--user-data-dir=<that profile>`, and `/json/version` answers. It reads the
arguments from the kernel (`KERN_PROCARGS2` on macOS, `/proc/<pid>/cmdline`
on Linux) and refuses a process whose arguments it cannot read. When the port
is free and the profile is not running, it starts Chrome with `open -n`.
`--background` adds `-g`, which asks macOS to keep focus where it is; a
window manager such as OmniWM can still bring the new window forward, so for
3 s `bw` watches the front app and hands it back to the app that was in front
before the start. Otherwise it starts
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
  marks the active tab: with the Bellwether Chrome in front, each window's
  focused tab; otherwise the tab Bellwether last focused or opened, since
  Chrome then reports focus in no tab, or in every tab an agent opened in the
  background. Clicking a row focuses that tab, and hovering shows a close
  button.
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
is refused, Node is missing, or Codex's `config.toml` does not parse. When
the space closes during the wait, nothing starts and Herdr shows "Nothing
started". Shell rows are unchanged.

The MCP server is Chrome DevTools MCP 1.12.0, named `bw-browser`. It runs
through `npx -y chrome-devtools-mcp@1.12.0` and is never installed globally.
It runs with usage statistics and CrUX off and takes JPEG screenshots at most
1280 px wide. The instructions (`agent/browser.md` and its Claude and Codex
copies) tell the agent to open its own background tab and act only in tabs
it opened. They tell it never to type passwords, codes or payment details,
and to leave its tab open for you to close from the panel.

For a space on another machine, `bw browser forward ensure` keeps one SSH
reverse forward per machine. The forward is a kept `hc` terminal named
`bw-fwd-<machine>-<hash>` that runs `bw browser forward keep`. `<machine>` is
the name lower-cased, reduced to `[a-z0-9-]` and cut to fit hc's 32
characters, and `<hash>` is 6 hex of the whole name's FNV-1a, so two machines
never share a forward's terminal or state file. That command
supervises
`ssh -o ExitOnForwardFailure=yes -o BatchMode=yes … -N -R 127.0.0.1:<port>:127.0.0.1:9222 <target>`.
After each connect it runs `bw browser port-check` on that machine. The port
must listen only on 127.0.0.1 or [::1], and its `/json/version` must carry
this Chrome's browser id. A failed check closes the forward and writes
`refused`, and the supervisor never retries it. When ssh exits, the
supervisor writes `reconnecting` and retries after 2, 4, 8, 16 and 30 s, then
every 60 s, on the same port with the same checks. When another program takes
the port in the meantime, it writes `port_taken`, and the next `ensure` picks
a new port. While ssh stays up, the supervisor checks every 60 s that the
local Chrome still has the browser id the forward was checked against and
runs `port-check` again; a changed id or a wrong listener closes the forward
as `refused`. The state files live in
`~/.local/share/bellwether/browser/forwards/<core>/`. Agents on that machine
find the forward's port and the Chrome's browser id in
`~/.local/share/bellwether/agent/ports/<window>`.

### Agent files

`bw agent ensure` writes these files under `~/.local/share/bellwether/agent/`
on each machine where an agent starts:

- `browser.md`, `browser-claude.md` and `browser-codex.md` hold the
  instructions.
- `browser-mcp` is a 0755 `sh` launcher. It reads `ports/<window>`, finds
  `npx` on PATH or in `/opt/homebrew/bin` or `/usr/local/bin`, and runs Chrome
  DevTools MCP 1.12.0 with
  `--wsEndpoint ws://127.0.0.1:<port>/devtools/browser/<browser id>`. Chrome
  answers 404 to an upgrade for another browser id, so a session never
  reconnects to a different browser that later takes the port.
- `claude-mcp-<window>.json` is Claude's `--mcp-config` file.
- `ports/<window>` holds two lines: the port this window's Chrome answers on
  there (9222 on the window machine, the forward's port elsewhere), then that
  Chrome's browser id. `bw browser agent-args` rewrites it on every call.

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
0 for every state; only a usage error exits 2. `tabs`, `focus`, `close` and
`new` first run `up`'s listener check and send nothing when the port holds
anything but the Bellwether Chrome: the action line says `ok:false` with the
state in its message, and `tabs` prints a `chrome_unreachable` error.

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
- After the Bellwether Chrome restarts, a running agent's browser tools stop
  working until its next session.
- Claude started on another machine by a core that SSH started cannot read
  that machine's login keychain, so it runs unlogged ("Not logged in" or API
  billing). Start that machine's core from its own login session.
- A chat tab's terminal keeps its share of the tab's split while the chat is
  zoomed: about 15 columns in a window under 1000 px wide. A prompt that
  wraps there still keeps one card, but Codex scrolls a long approval's
  options out of view at that width, so a Codex sub-agent's approval falls
  back to "Answer in terminal". Herdr offers no command to size a pane.
- The checks in a Herdr window are still owed: the panel, Arrange beside a
  real Herdr window, a screenshot inline in a chat, and a real SSH machine.

## What phase 5 delivers

The right sidebar's Changes panel is the `bw-diff` mod, which replaces the
Changes placeholder in `layouts/bellwether.json`. It shows the Git changes of
the active space's worktree, on this Mac or on another machine. Every read
runs `bw diff` through the helper on the space's machine.

The header reads `<branch> → <base> ▾`, then the base's short hash and age,
for example `feat → origin/main ▾ 9d6c68d · 3d`. Clicking it opens the base
picker. The picker lists up to 200 branches, remote branches and tags, newest
first, and filters them as you type, and it reads the list again each time
it opens and after Fetch. A picked row is kept by its full name, such as
`refs/tags/release`, so a branch and a tag with one name stay two choices.
Enter takes a name only one listed ref has. Any other text is checked first
with `bw diff refs --verify`, and a text that names no commit shows the error
and is not kept. With no choice stored, the
base is `origin/main`, else the branch `origin/HEAD` points to. When the
repository has neither, the picker opens by itself once.

The header's Fetch button runs `git fetch` for the remote the base belongs
to, else `origin`. Fetch runs only when you click it, and gives up after
25 s. The Merge base and Tip switch under the header sets where Committed on
branch starts: at the merge base of the base and `HEAD`, or at the base
itself. The panel keeps each project's base and mode in
`shared("bw.diff.base")` under `projectKey(machine, commonDir)`, so every
worktree of a repository shares them. Picking the default base in Merge base
mode removes the project's entry.

Three sections follow:

- Staged lists the index against `HEAD`, renames included.
- Changes lists the worktree against the index, then untracked files.
- Committed on branch lists the base, or its merge base, against `HEAD`.

Each row shows a status letter, the file's name and folder (`from <old path>`
for a rename), and `+N −M`. Letters are Git's (`M`, `A`, `D`, `R`, `C`, `T`),
except that Changes shows an untracked file as `U` and an unmerged one as
`!`. A binary file shows "binary" in place of counts. Each section's header
shows its file count and its total `+N −M`, and a click folds or unfolds it.
The panel remembers which sections are folded. A section lists at most 2,000
files and says how many more it left out.

Clicking a file shows its patch below the lists. Each line has its old and
new line numbers, and added and removed lines are tinted Green and Red. The
helper sends the patch in pages under 4 MiB, and a "Show more" button loads
the next page. A line too large for a page shows as "Line too large to show"
with its size. "Open as tab" opens the patch as a middle tab named after the
file, such as `notes.txt · diff`. That tab loads once, and again when you
click its Refresh button.

While the panel is shown, it reads a worktree on this Mac when `watchFolder`
reports a change in the worktree or its common dir, at most once a second,
and every 30 s without a change. It reads a worktree on another machine every
1.5 s. Each read also returns a digest of the selected file's patch, and the
panel reloads the patch only when that digest changes. A hidden panel makes
no helper call, and showing the panel again reads at once.

"Open in Changes" in a chat selects the Changes tab. When the chat's line
names one file, the chat also writes that file to `shared("bw.diff.reveal")`,
and the panel reads the list again and then selects the file.

Changes never stages, commits or pushes. `bw diff fetch` is its only command
that writes to the repository.

### Commands

```sh
bw diff files --path <dir> [--base <ref>] [--mode merge-base|tip] [--select staged|changes|committed --file <path> [--old <path>]]
bw diff patch --path <dir> --section staged|changes|committed --file <path> [--old <path>] [--untracked] [--from <rev> --to <rev>] [--page <n>]
bw diff refs --path <dir> [--verify <ref>]
bw diff fetch --path <dir> [--remote <name> | --base <ref>]
```

`bw diff …` runs on the space's machine and prints JSON lines. `files`
prints a `diff-place` line, a `diff-base` line, one `diff-file` line per row,
a `diff-more` line for a section past 2,000 files and, with `--select`, a
`diff-digest` line. `patch` prints one `diff-patch` line with the page, the
page count, the patch's size and digest, the text and the lines left out.
Committed needs `--from` and `--to`, and an untracked file needs
`--untracked`. `refs` prints up to 200 `diff-ref` lines, or one `diff-ref-ok`
line with `--verify`. `fetch` prints a `diff-fetched` line naming the remote.
A failure prints one `error` line and exits 1.

Every Git call runs with
`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`,
so a read never refreshes the index or starts fsmonitor. Every diff adds
`--no-ext-diff --no-textconv --no-color`, so a repository's own config never
runs a diff program. The helper also clears `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_EXTERNAL_DIFF`, and reads a
typed ref after `--end-of-options`, so a ref spelled like an option stays a
ref.

### Known limits

- An untracked file over 64 MiB is listed without counts.
- A diff opened as a tab does not refresh by itself; its Refresh button reads
  it again.

## What phase 6 delivers

The right sidebar's Issues panel is the `bw-linear` mod, which replaces the
Issues placeholder in `layouts/bellwether.json`. It shows the open Linear
issues of the project linked to the active space's repository. Every Linear
call runs `bw linear` on this Mac, the window machine, whatever machine the
space is on; only the Git reads that find the repository run on the space's
machine.

### The key

`bw linear` reads a Linear personal API key from this Mac's login Keychain
with `security find-generic-password -s bellwether.linear -w`. Store it once
per Mac:

```sh
scripts/linear-key.sh < keyfile   # or run it in a terminal and paste at the prompt, which does not echo
```

The script checks that the text looks like a Linear key (`lin_api_` and 40
letters or digits), stores it under service `bellwether.linear` and your
account, and reads it back to confirm. The key never reaches an argument
list: `security -i` reads the store command, with the key in hex, from a
pipe, and `bw linear` hands it to `/usr/bin/curl` in curl's config on
standard input. No mod, shared value, output line, log or cache holds it.

### Links

Each repository can be linked to one Linear project. The panel's header
shows the linked project's name; clicking it opens the link picker, a dialog
of the workspace's projects with the one whose name matches the repository
first and marked "suggested". The project menu's "Link Linear project…"
opens the same dialog. Links live in `shared("bw.linear.links")`. A
repository with an `origin` is keyed by its URL in lower case without the
user, port or `.git` (`origin:github.com/owner/repo`), so its clones on other
machines share the link. A repository without one, or whose origin is a
local path, is keyed by `[machine, common dir]`, and its link moves to the
origin key the first time the panel reads it with an origin.

### The list

The filter under the header picks Project (the linked project's open
issues), Mine (open issues assigned to you anywhere) or All (every open
issue). Project is the default when the repository is linked and Mine when it
is not. Open means any state but completed, canceled and duplicate. The
search field runs Linear's issue search within the filter when you press
Enter. Issues come 50 at a time, grouped by state, started first, then
unstarted, backlog and triage; "Load more" reads the next 50.

The panel reads the list when it is shown, every 60 s while it stays shown,
and when you click its refresh button. A hidden panel makes no call.
Each answer is kept in `~/.cache/bellwether/linear/`, readable by your
account only, for 30 days. When Linear cannot be reached, the panel shows the
kept list and says how old it is. A missing or refused key clears the list
and any open issue, and says what to run. A space outside Git, or on a
machine that does not answer, reads nothing from Linear and says why.

Clicking an issue opens it inline: identifier, state, labels, title and
description as markdown, with three buttons. Attach to chat puts the issue on
the composer of the active tab when that tab is a chat. Open in Linear opens
the issue's page. Copy branch name copies Linear's branch name for it.

### Attach

Attach writes a chip to `shared("bw.chat.attach")` under the chat's tab id,
so it reaches that chat only. The composer shows each chip above the text
field. Pointing at a chip shows its state, title and the start of its
description, and its × removes it. A message may be empty when chips are
attached.

At Send the chat builds each chip's text with `bw linear issue --id <id>
--text` on this Mac, then sends one message to its own terminal: for each
issue, `Linear issue <id>: <title>`, its URL, its description and a `---`
line, then what you typed. The chips clear once the message went. A
description over 8 KB needs a choice on its chip first: Trim to 8 KB sends
the first 8 KB and a note that the rest is at the URL, and Send as a file
places the description beside the chat's terminal with `hc put` and sends
its path. When a description grew past 8 KB after Attach, Send stops, the
chip shows its new size and the choice, and the typed message stays. When a
text cannot be built, the chat names the issue and sends nothing.

### Commands

```sh
bw linear projects
bw linear issues --scope project|mine|all [--project <id>] [--after <cursor>]
bw linear search --text <words> --scope project|mine|all [--project <id>] [--after <cursor>]
bw linear issue --id <identifier> [--text [--trim | --put <terminal>]]
```

`projects` prints one `linear-project` line per project (up to 250) and a
`linear-done` line. `issues` and `search` print one `linear-issue` line per
open issue and a `linear-page` line with the next page's cursor, and
`cached` and `age_s` when the answer came from the cache. `issue` prints the
issue with its description, or with `--text` one `linear-text` line holding
the text Send uses. A failure prints one `error` line whose code is
`no_key`, `key_refused`, `offline` (Linear unreachable and nothing cached),
`rate_limited`, `not_found`, `too_large` (over 8 KB without `--trim` or
`--put`), `put_failed` or `linear_failed`, and exits 1. Bellwether never
writes to Linear.

### Known limits

- The key lives in one Mac's Keychain; run `scripts/linear-key.sh` once on
  each Mac that shows the window.
- Mine and All show issues from every project, so their titles appear on
  screen whatever the repository.
- A list is not read again while the panel is hidden; showing it reads at
  once.

## The look

Bellwether draws in Catppuccin Mocha with a Mauve (`#cba6f7`) accent, in the
shapes of the Flockbook layout: tabs in a floating capsule, pills for counts
and states, rounded chips for tool calls, letter tiles for projects, cards
for menus, dialogs and requests. It stays dark whatever the system
appearance.

- `shared/palette.js` holds every colour value: the 26 Mocha colours, the
  role each Herdr theme colour takes, and the terminal's 16 ANSI colours
  (Ghostty 1.4.0's Catppuccin Mocha port). No other mod file has a colour
  literal; mods draw with `theme()` roles and take the rest from the palette.
- `themes/bellwether.json` is the layout's own Herdr theme, written from the
  palette by `bun scripts/gen-theme.js` (`--check` fails when the two
  differ). The layout's root names it, so Herdr offers it only in this
  layout. Text selection in terminals is a quarter of Mauve over Base.
- `shared/ui.js` draws the shared pieces: status marks, pills, chips,
  monogram tiles, cards and buttons.
- Motion follows state and uses Herdr's native animation only: a working
  agent's mark spins, a blocked one breathes (opacity 0.65 to 1), a done
  check fades in, menus, dialogs and request cards fade and slide in once,
  and hover fills fade. An idle window does not move.
- `bun scripts/verify/contrast.js` lists every colour pair the mods draw and
  checks WCAG AA: 4.5:1 for text, 3:1 for status marks and meaningful icons.
  `tests/theme.test.js` runs it with the rest of the tests.

## Layout of this repository

The folders mirror `~/.config/herdr-app`, so a sync is a plain copy:

```text
layouts/bellwether.json   the window, cloned from Herdr's main layout; bellwether.svg is its preview
themes/bellwether.json    the layout's Catppuccin Mocha theme, written by scripts/gen-theme.js
mods/bw-*/                one folder per mod, named bw-* so none clashes with Herdr's
shared/                   JavaScript used by several mods; scripts/sync.sh copies it in
keys/bellwether.json      Bellwether's key bindings, merged by scripts/keys-merge.js
scripts/sync.sh           copy the layout, its theme and bw-* mods into ~/.config/herdr-app
scripts/gen-theme.js      write themes/bellwether.json from shared/palette.js
scripts/keys-merge.js     merge keys/bellwether.json into the app home's keys.json
scripts/check.sh          herdr-app check (or the headless stand-in) on every mod, and shared copies match
scripts/test.sh           every check that needs no Herdr window
scripts/gen-herdr-api.js  extract Herdr's API names into tests/harness/api.json and copy its types into types/herdr
scripts/install-helper.sh build bw and install it on this machine
scripts/linear-key.sh     store the Linear key in this Mac's Keychain for bw linear
scripts/build-dist.sh     build bw for other platforms into ~/.local/share/bellwether/dist
scripts/verify/           checks against real machines and agents
crates/                   Rust helpers; crates/bw is the bw binary the mods run
crates/vendor/            code copied from other projects, in its own Cargo workspace
tests/                    Bun tests, and the headless harness that stubs herdr and gpui-kit
types/                    Herdr's type files and the tsconfig that type-checks every mod against them
hooks/bw-event            the hook bw machine setup installs; it hands each event to bw event
agent/                    the browser instructions and MCP launcher that bw embeds and bw agent ensure writes to each machine
docs/brief/               the requests this work answers, verbatim
docs/research/            what the reference projects do, with evidence
package.json, bun.lock    the pinned JavaScript dev tools: Biome and TypeScript
biome.jsonc               Biome's format and lint settings
```

Run `bun install` once per checkout to put the pinned tools in
`node_modules`, which Git and Syncthing both ignore. `scripts/test.sh` runs
`bunx biome ci --error-on-warnings .`, so a format or lint finding fails it;
`bunx biome check --write .` fixes most of them. It then runs
`bunx tsc -p types`, which checks every `mods/bw-*` file and `shared/` with
the compiler options Herdr writes into each mod's `jsconfig.json` (plus
`skipLibCheck`, since Herdr's own `.d.ts` files fail TypeScript 7), against
the copies of `herdr.d.ts` and `gpui-kit.d.ts` in `types/herdr`. After a
Herdr update, `bun scripts/gen-herdr-api.js` refreshes those copies and
`tests/harness/api.json` together.

## Install on a machine

Herdr loads mods from each machine's own `~/.config/herdr-app`. On every
machine that runs the Herdr window, after Syncthing has delivered the repo:

```sh
scripts/sync.sh --dry-run   # list what would change
scripts/sync.sh
scripts/check.sh
```

`sync.sh` copies real files, because Herdr does not load a mod's SVGs through
a symlink. It writes only `layouts/bellwether.*`, `themes/bellwether.json` and
`mods/bw-*/`, and never touches Herdr's shipped layouts, themes and mods or
anyone else's. It leaves out each
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

A prompt's id ignores how the pane wraps it, so narrowing or widening a
chat's pane keeps one card: a Claude approval's id hashes its box from the
header through the question without whitespace, tips or options, a Codex
approval's its text without whitespace or rule lines, and Codex's folder
prompt's its question and option names. Because spacing and options are
left out, `bw answer` presses a key only while the box still shows the
command the card first showed, line breaks aside, and for Always the same
option 2 label; otherwise it reports the card as changed. `scripts/verify/record-wrap.sh` records the screens the
`rewrap` tests read: a Claude approval, a Codex approval and Codex's `/new`
folder prompt at 80 columns, then again after an `hc attach` viewer narrows
the same terminal. It runs Claude haiku and Codex in a private core
(`HC_SESSION=bw-wrap`) in scratch repositories, scrubs the screens into
`tests/fixtures/screens/`, and removes the core and the folders.

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
and deletes the files it created. In your own hc core it stops only the
forward and npx warm terminals named for that machine that were absent at the
start, and prints a `NOTE` for any other new `bw-` terminal, such as one a "+"
for another machine started meanwhile. A process that still uses its scratch
folder after cleanup, or a recorded pid that still runs, keeps that folder
and its Claude logs for diagnosis and is named in a `FAIL`. A later run
refuses to start until those processes end. `browser-probe.sh` keeps its
folder the same way. It prints `PASS` or `FAIL` per check and
exits 1 on any `FAIL`. It fails when `~/.claude/settings.json`,
`~/.codex/hooks.json` or `~/.codex/config.toml` changed, when
`~/.claude.json` gained a `bw-browser` trace, or when your own Chrome
processes changed. It spends tokens.

```sh
scripts/verify/browser.sh --offline          # files exist, bun test tests/browser, bw browser status parses; what scripts/test.sh runs
scripts/verify/browser.sh --machine <name>   # real agents; <name> must be a temporary hc machine (bwloop)
```

## Checking Changes against Git

`scripts/verify/git.sh` builds the repositories of
`scripts/verify/make-diff-repos.sh` in `/private/tmp/bw-verify-diff`. They
hold a branch two commits past its merge base with an `origin/main` that
moved on, a tag, staged, unstaged and untracked changes with a rename, binary
files and odd paths, a repository with no remote, and one whose `origin/HEAD`
points to `origin/trunk`. Some files name a textconv, an external diff and an
fsmonitor hook that would each leave a marker file if they ran. The script
compares `bw diff` and the panel's model with Git's own commands, each run
with `--no-ext-diff --no-textconv --no-color`:

- Staged, Changes, and Committed on branch in both modes equal `git diff`.
- Each untracked file's counts equal `git diff --no-index --numstat`.
- A typed ref (`v1`) gives Git's list, and `--output=…` is refused as a ref.
- The rename and the binary files show as Git shows them.
- Every patch, joined from its pages, equals Git's patch.
- The panel model's rows equal the helper's.
- A repository with no `origin/main` or `origin/HEAD` has no base, and
  `origin/HEAD`'s target is the default when `origin/main` is missing.
- No textconv, external diff or fsmonitor program ran.

It prints `PASS` or `FAIL` per check, exits 1 on any `FAIL`, and removes the
folder after.

```sh
scripts/verify/git.sh                    # this Mac, with this checkout's bw; --offline is the same, and scripts/test.sh runs it
scripts/verify/git.sh --machine <name>   # the repositories on <name> through hc exec, read by the helper there
```

With `--machine`, the script builds a release `bw` here, and installs it on
`<name>` when that machine's helper is missing or outdated.

## Checking Issues against Linear

`scripts/verify/linear.sh` makes two scratch repositories in
`/private/tmp/bw-verify-linear`: one without an origin, linked to the
`Bellwether` project, and one with an origin, linked to `Bellwether
scratch`. It reads each as the panel does, through its Git place, its link
and its default filter, and compares `bw linear` with GraphQL queries of
another shape that curl sends to Linear with the same Keychain key:

- Each repository's default list equals `project(id).issues` for its own
  project's open issues, and the two lists share no issue.
- Mine equals `viewer.assignedIssues` and All the first page of open
  issues, and neither equals the Project list.
- Adding an origin to the first repository moves its link to the origin key
  and keeps its list.
- `rg -F`, given the key's first 12 characters on standard input, finds them
  in no file under the app homes, `~/.cache/bellwether`,
  `~/.local/share/bellwether` and the repository.

```sh
scripts/verify/linear.sh            # Linear itself, with the Keychain key; needs the two test projects
scripts/verify/linear.sh --offline  # a loopback fake of Linear and a made-up key; scripts/test.sh runs it
```

With no key in the Keychain the script says the live run is owed and runs
the fake.

## The bw helper on each machine

Mods call `~/.local/share/bellwether/helper/current/bw` on the machine a space
lives on. `current` links to a version folder, so an update swaps one link.
On this machine a Herdr app started with `BW_HELPER` set runs that program
instead; calls on another machine always run its installed helper.
`scripts/verify/stage.sh up` sets it to a wrapper that appends one line per
call to the stage's `helper-calls.log` (a timestamp and the command, such as
`feed` or `browser status`, never its arguments, which can hold chat text) and
runs the repository's `bw`, so a check can count calls without touching the
installed helper.
`shared/helper.js` needs `bw version` to report version 0.7.0 and protocol 7;
0.7.0 adds phase 7's `bw diff files --watch` and its watcher, so a machine with
0.6.0 reinstalls once.
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
