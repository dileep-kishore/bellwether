# Using Bellwether

This guide covers installing Bellwether and using each part of its window. For how the parts work
inside, see [architecture.md](architecture.md). For the `bw` commands the mods run, see
[helper.md](helper.md).

## Install

### What you need

- Install the Herdr app from [herdr.dev](https://herdr.dev) and open it once, so that its app home
  `~/.config/herdr-app` exists. `scripts/sync.sh` and `scripts/keys-merge.js` stop with "open the
  Herdr app once first" until it does.
- Install Rust through rustup. `rust-toolchain.toml` pins the toolchain, and the build scripts put
  `/opt/homebrew/opt/rustup/bin` first on `PATH`.
- Install `jq`, `rsync` and [Bun](https://bun.sh). `scripts/install-helper.sh` and
  `scripts/check.sh` call `jq`, `scripts/sync.sh` copies with `rsync`, and `scripts/keys-merge.js`
  runs under Bun.

`bun install` puts the pinned development tools (Biome and TypeScript) in `node_modules`. Installing
Bellwether does not need them; [development.md](development.md) covers them.

### Put Bellwether in the app home

Herdr loads mods from each machine's own `~/.config/herdr-app`. Run these steps from the repository
on every machine that shows a Herdr window:

```sh
scripts/install-helper.sh   # build bw in release and install it on this machine
scripts/sync.sh --dry-run   # list what would change
scripts/sync.sh             # copy the layout, its theme and the bw-* mods into the app home
scripts/check.sh            # check every mod and the shared copies
```

`scripts/install-helper.sh` installs `~/.local/share/bellwether/helper/<version>/bw`, points
`~/.local/share/bellwether/helper/current` at that version and prints the installed path. The rest
of this guide calls that program `bw`.

`scripts/sync.sh` writes only `layouts/bellwether.*`, `themes/bellwether.json` and `mods/bw-*/`.
Set `HERDR_APP_HOME` to sync into another app home. [development.md](development.md#syncing-into-an-app-home)
explains what it copies and leaves out.

`scripts/check.sh` runs `herdr-app check` on every mod and prints `all checks passed` when every
check passes. It prints a `FAIL` line for each problem and exits 1. On a machine
without `herdr-app` it renders each mod in the headless harness instead and prints
`STAND-IN headless render for N mods (herdr-app check owed)`.

### Merge the key bindings

`keys/bellwether.json` binds six keys in the `layout:bellwether` section:

- `cmd-b` runs `layout.toggle:sidebar` to hide or show the left project sidebar.
- `cmd-j` runs `bw-tabs.chat-flip` to flip the center stack between `chat` and `panes`.
- `cmd-shift-'` runs `bw-tabs.terminal-peek` to peek at `panes` and flip back.
- `cmd-shift-n` runs `bw-tabs.needs-toggle` to open or leave the `Needs you` triage screen.
- `cmd-shift-o` runs `bw-tabs.overview-toggle` to open or leave the `Overview` fleet screen.
- `cmd-alt-b` runs `layout.toggle:right` to hide or show the right inspector.

```sh
bun scripts/keys-merge.js                       # print each section before and after; write nothing
bun scripts/keys-merge.js --apply               # write keys.json after saving a backup beside it
bun scripts/keys-merge.js --apply --home DIR    # the same for the app home in DIR
```

Without `--home` the script uses `HERDR_APP_HOME`, else `~/.config/herdr-app`. `--apply` saves the old
file as `keys.json.bw-<seconds>` before it writes.

The script refuses to write while one of Bellwether's keys is already bound to something else. It
prints a `conflict` line for each such key and `not written: free or rebind the conflicting keys
first`. It prints a `shadowed` line when a terminal binding also uses `cmd-j`, because that binding
wins while a terminal has focus.

Herdr stops adding new default shortcuts to a `keys.json` that has been edited. The script prints
that reminder on every run.

### Switch to the layout

```sh
herdr-app do layout.switch '{"name":"bellwether"}'
```

### The helper on other machines

A space can live on another machine that Herdr's `hc` reaches. Each such machine needs its own `bw`.
When a machine's helper is missing or outdated, a mod runs this Mac's `bw machine install <machine>`
and checks again, and the machine's sidebar heading reads "setting up Bellwether" meanwhile. To do
it by hand:

```sh
bw machine status <machine>              # current, missing, outdated, unreachable or no_build
bw machine install <machine> [--force]   # copy this machine's bw there through hc
scripts/verify/install.sh --machine <machine>
```

An Apple silicon Mac gets the `bw` that runs here. A Linux machine (x86_64 or aarch64) gets the build
that `scripts/build-dist.sh` writes into `~/.local/share/bellwether/dist/<target>/`, so run that
script first. Its Linux builds need `cargo zigbuild`. Other platforms report `no_build`, and nothing
is written there. [The helper on each machine](architecture.md#the-helper-on-each-machine) describes
the version check and the copy. `scripts/verify/install.sh` installs `bw` here and on `<machine>` and
checks what runs there; [development.md](development.md#installsh) describes it with the other
verify scripts.

## The window

The `bellwether` layout has three columns:

- The left sidebar is 244 px wide and resizes from 200 to 420 px. `cmd-b` hides and shows it; when
  hidden, moving the pointer within 6 px of the left edge reveals a floating `bw-projects` peek
  drawer over `chat` and `panes`.
- The middle column holds a 48 px `bw-tabs` top bar with two floating capsules over the `screen`
  stack (`chat`, `panes`, `needs`, `overview`).
- The right inspector starts hidden at 380 px wide and resizes from 280 to 620 px. `cmd-alt-b`, the
  strip's `×` button, or any `Open in ...` button shows or hides it.

Mods draw each part. [Mods](architecture.md#mods) lists all fifteen with what each draws and the props
it takes.

- `bw-projects` fills the left sidebar and its left-edge peek drawer with each machine's projects,
  worktrees and agents.
- `bw-tabs` draws the two floating capsules at the top of the work column: space tabs and "+" on the
  left, and `Chat` / `Panes`, the breathing `Needs you` count pill, `Overview`, and the inspector
  toggle on the right.
- `bw-new` is the tab bar's "+" menu: New chat (Claude, Codex), New terminal (Shell, Claude, Codex)
  and Worktree (New worktree…, Open worktree…).
- `bw-pane` is each terminal pane's hover-revealed 28 px header on multi-pane tabs.
- `bw-chat` draws the frameless conversation screen, PR status strip and per-terminal prompt queue.
- `bw-needs` draws the two-column `Needs you` triage screen across every open space.
- `bw-overview` draws the cross-space `Overview` fleet grid.
- `bw-right` is the right inspector's 36 px strip of Changes, Issues, Drafts and Browser plus `×`.
  `bw-diff` fills Changes, `bw-linear` fills Issues, `bw-drafts` fills Drafts and `bw-browser` fills
  Browser.
- `bw-menu` draws a project's menu, `bw-add` draws the Add project dialog, and `bw-status` remains
  available for custom layouts.

A space on another machine works the same way. Its Git reads run on that machine, and an offline
machine keeps its last rows. [Machines and where code runs](architecture.md#machines-and-where-code-runs)
says which call runs where.

## Projects

The left sidebar lists each machine under a heading. The heading adds a pill when something needs
saying: "offline", "connecting…", "not connected", "setting up Bellwether" or
"Bellwether helper: <message>". A chevron or a heading folds its rows, and folds survive a reload.

- Each project row shows a letter tile and the project's name.
- Each worktree row shows its branch, its ahead and behind counts (`↑ahead`, `↓behind`) and its
  `+N −M` change counts.
- Under a worktree, each agent has one line: its status mark, its program, its title, a `+N` pill for
  running sub-agents, a request badge with the number of waiting requests, and its age.
- Spaces outside any project list under "Other spaces".

A dimmed worktree row has no open space. Clicking it opens a space in that folder. Clicking a
worktree that has a space selects its first space. Clicking an agent line selects its space and tab
and focuses that agent.

The `+N` pill and the request badge come from `bw counts` on each machine every 10 s, and at once
when an agent's status changes.

The sidebar header's "Add project" opens the Add project dialog. Pick a machine and a folder, and
Git finds the repository the folder belongs to. On this Mac, "Choose…" opens a folder picker; on
another machine, type an absolute path.

Hovering a project shows "+" and "⋯". "⋯" or a right-click opens the project menu: New worktree…,
Open worktree…, Link Linear project… and Remove. Remove says "close its spaces first" while any of
the project's spaces is open.

## Chats

"+" → New chat → Claude or Codex starts the agent in a single full-width pane on the space's machine
and shows its conversation on the `chat` screen. When a tab runs several Claude or Codex panes, an
agent switcher pill above the composer picks which conversation `bw-chat` shows (`bw.chat-agent`).

`⌘J` flips the center stack between `chat` and `panes`, giving the terminal the full work width on
narrow tiled windows. The right capsule's `Chat` / `Panes` toggle and `⌘⇧'` (`terminal-peek`) do the
same. `⌘J` needs the key bindings merged as in [Merge the key bindings](#merge-the-key-bindings).

The chat reads the agent's session log every 2 s while `screen` is `chat` and every 10 s while
`panes`, `needs`, or `overview` is active. Flipping back to `chat` reads at once. The chat shows:

- your messages as bubbles and the agent's replies as Markdown;
- one line per run of tool calls, written as a sentence such as "Read 3 files and ran 2 commands",
  with a spinner until every call has a result, then a check, or a cross when a call failed; click
  the line to list the calls;
- a line such as "Changed 2 files · Open in Changes" at the end of a turn that edited files;
  clicking it reveals the right inspector, selects the Changes panel and, when the line names one
  file, selects that file;
- pictures inline, up to 320 px tall, each copied once into the app home's
  `data/bellwether/pictures/` (4 MB at most);
- an approval or question the agent waits on, as one line that says where to answer it.

Scrolling up with the first row on screen loads older rows.

While the chat cannot read a log, it says why, for example "Waiting for Claude's session log" or
"This terminal runs no Claude or Codex".

### Sending, queueing, and PR skills

When the agent is idle or done, Enter sends through `bw send` and Shift-Enter adds a line. While the
agent's status is `working`, Enter enqueues the prompt into that terminal's persistent queue
(`bw queue add`) and `⇧⌘Enter` sends immediately.

Queued items appear in a compact drawer above the composer with inline edit, move up/down, delete,
`Resume` (when held), and `Send now` (when idle). When a turn finishes (`Stop` hook or status
transition from `working` to `done` or `idle`), `bw queue drain` runs five safety gates before
delivering item 0: it checks the 15 s duplicate-drain guard, confirms the terminal is no longer
working, verifies no approval or question card is pending, checks that the last turn neither ended on
an error/interrupt nor asked a trailing prose question (`?`), and verifies `expect_session` still
matches. Any blocker holds the queue with a clear reason (`assistant_question`,
`interrupted_or_error`, or `session_changed`) until you click `Resume`.

When the active space's branch has an open GitHub pull request (`bw pr status`), a 1-line PR strip
sits above the composer with check counts, review state, unresolved review threads, `Open PR` (opens
in Bellwether Chrome), `Babysit PR` (sends or queues `/babysit-pr <n>`), and `Merge PR` (shown when
checks are green, `unresolvedThreads === 0`, `headRefOid` matches `HEAD`, and `reviewDecision` is
`APPROVED` or empty; sends or queues `/merge-pr <n>` and never calls `gh pr merge` directly).

A send that goes through clears the composer and shows no line. Otherwise a line under the composer
gives the result:

- "Not sent: Claude is waiting on a prompt. Answer it in the terminal (⌘J)." when the agent waits on
  a prompt.
- "Not sent: this terminal now shows another conversation." when the conversation changed since the
  chat last read it, for example after Claude's `/clear` or Codex's `/new`.
- "Sent, but Herdr did not confirm it in time. Check the terminal (⌘J)." when Herdr did not confirm
  the send.

The text stays in the composer after a refusal. After `/clear` or `/new` the chat drops the old rows
and shows the new conversation. When Codex holds several conversations open, as it does for 60 s
after `/resume`, the chat says "Codex's conversation cannot be read (ambiguous)", shows no new rows
and sends nothing until one remains.
[Sending a message](architecture.md#sending-a-message) explains the conversation check.

## Sub-agents and requests

A chat shows its session's sub-agents and takes the approvals and questions of the agent and its
sub-agents. This works for a space on this Mac or on another machine.

The threads card floats at the top right of the timeline. It lists the parent, then each sub-agent
nested by depth, with a state icon (running, done or asking), its type, its description, its age and
a request badge. A sub-agent that runs in its own Herdr terminal under the chat's terminal is listed
too. The card is open while a sub-agent runs or asks, and folds to a pill such as
"2 sub-agents · 1 asks" otherwise. The header's threads button shows the count and opens or folds
the card. That choice holds until the set of running sub-agents changes.

Clicking a sub-agent shows its own transcript. A 44 px bar replaces the composer, for example
"Explore · sub-agent of Claude · running · Back to Claude". A terminal sub-agent opens as a chat of
its own terminal, with a composer that sends to it. When the root conversation changes (`/clear`,
`/new`), the chat returns to the parent and says "This conversation ended; showing the new one".

The request dock sits above the composer in every view, with one card per request, newest last.

- An approval card says who asks, shows the command and offers Approve, Always allow (when the prompt
  has that option), Deny and Answer in terminal. Answer in terminal flips to the terminal.
- A question card has step tabs when it asks several questions, options with 1 to 9 key hints, check
  boxes for a multi-select question, an Other field and Submit. A digit selects an option and never
  submits.
- A Codex async question is answered as one message.
- Codex's `/new` folder prompt, "Where should the new conversation run?", gets a card with one button
  per option, so a `/new` sent from the composer finishes in the chat.

Answer buttons stay disabled while the chat's terminal has focus and for 3 s after it loses focus. A
resolved card stays 10 s. A card shows only "Answer in terminal" when Bellwether cannot read the
prompt, when the prompt's command is cut off at the top of the screen, or when the lookup of the
root conversation finds no single conversation. When the prompt on screen changed since the card was
drawn, an answer presses nothing and the card says "Changed on screen; nothing was pressed".
[Claims, the store and card states](architecture.md#claims-the-store-and-card-states) lists every
card state and when each applies.

## Needs you and Overview

Clicking the top bar's breathing `N needs you` pill or pressing `⌘⇧N` switches `screen` to `bw-needs`,
a two-column triage view across all open spaces:

- The left 300 px column groups spaces and agents into `Needs you`, `Ready to land`, `Working` and
  `Idle`.
- The right detail column renders `answerable` approval and question cards with inline `1` to `9`
  digit shortcuts, `y` / `a` / `n` approval keys, and `Other…` input (honoring the 3 s terminal focus
  guard and invoking `bw answer` on `space.machine`). When a terminal reports `blocked` without a
  session card (for example `sudo` or an interactive shell prompt), `bw-needs` renders `Waiting in
  terminal` and `Open terminal` with zero fabricated answer buttons.
- Clicking `Open chat` or double-clicking a row pins `bw.chat-agent` to that terminal so multi-agent
  tabs open the exact agent's conversation. PR rows also surface `Open PR`, `Babysit PR`, and
  `Merge PR`.

Pressing `⌘⇧O` or clicking the top bar's grid icon switches `screen` to `bw-overview`, a cross-space
fleet grid showing neutral project monograms, machine badges, branch and PR badges, and per-agent
rows that jump directly to `chat` or `panes`.

## Hooks

Bellwether's optional hooks tell the chat which sub-agent asked, which call a prompt belongs to, and
when a turn stops so queued prompts can auto-drain.
Without them the dock still shows each prompt on screen, but names a sub-agent only when that
sub-agent's log shows the call. [Hooks](architecture.md#hooks) describes what the hook does and the
files `--apply` writes.

When a machine lacks the hooks, the dock shows one of these notices:

- "Bellwether hooks are not set up on <machine>; requests show without who asked"
- "Bellwether hooks on <machine> are out of date; requests show without who asked"

`<machine>` reads "this Mac" for this one. The notice offers Review changes and Not now.

- Review changes runs `bw machine setup <machine> --diff` and shows the diff of both files, the
  Claude settings and the Codex hooks file. The button reads "Reading changes…" while it runs.
- Apply then runs `--apply` with the SHA-256 of each file the diff read. A file that changed since
  the diff is refused and left untouched.
- Not now hides the notice for that machine.

The same steps from a shell are in [`bw machine setup`](helper.md#bw-machine).

### Trusting the Codex hook

Codex runs a new hook only after you trust it. Until then the dock says
"Codex hook not trusted on <machine>" with the step:
"Start Codex there and choose “Trust all and continue” (2, then Enter), or type /hooks and press t."
`bw machine setup <machine> --check` reports `untrusted` for Codex until then. Bellwether never
writes Codex's `config.toml`.

## Changes

The right sidebar's Changes panel shows the Git changes of the active space's worktree, on this Mac
or on another machine. Every read runs `bw diff` on the space's machine.

Three scope pills sit at the top of the panel:

- `Uncommitted` shows `Staged` and `Changes` in the working tree.
- `Branch` shows `Committed on branch` against the chosen base ref (`Merge base | Tip`).
- `PR` diffs against `<remote>/<baseRefName>` from the branch's open GitHub PR (`bw pr status`),
  falling back to the `Branch` base picker when no open PR exists.

On `Branch` (or `PR` fallback), the header reads `<branch> → <base> ▾`, then the base's short hash
and age, for example `feat → origin/main ▾ 9d6c68d · 3d`. Clicking it opens the base picker.

- The picker lists up to 200 branches, remote branches and tags, newest first, and filters them as
  you type. It reads the list again each time it opens and after Fetch.
- A picked row is kept by its full name, such as `refs/tags/release`, so a branch and a tag with one
  name stay two choices.
- Enter takes a name that only one listed ref has. Any other text is checked first with
  `bw diff refs --verify`, and a text that names no commit shows the error and is not kept.
- The Default row means `origin/main`, else the branch `origin/HEAD` points to. When the repository
  has neither, the picker opens by itself once.

The header's Fetch button runs `git fetch` for the remote the base belongs to, else `origin`. Fetch
runs only when you click it, and gives up after 25 s.

The "Merge base | Tip" switch under the header sets where Committed on branch starts: at the merge
base of the base and `HEAD`, or at the base itself. The panel keeps each project's base and mode in
`shared("bw.diff.base")`, so every worktree of a repository shares them. Picking the default base in
Merge base mode removes the project's entry.

Three sections follow according to the active scope:

- Staged lists the index against `HEAD`, renames included.
- Changes lists the worktree against the index, then untracked files.
- Committed on branch lists the base, or its merge base, against `HEAD`.

Each row shows a status letter, the file's name and folder (`from <old path>` for a rename), and
`+N −M`. The letters are Git's (`M`, `A`, `D`, `R`, `C`, `T`). In Changes an untracked file shows `U`
and an unmerged one `!`. A binary file shows "binary" in place of counts. Each section's header shows
its file count and its total `+N −M`, and a click folds or unfolds it. The panel remembers which
sections are folded. A section lists at most 2,000 files and says how many more it left out.

Clicking a file shows its patch below the lists. Each line has its old and new line numbers, and
added and removed lines are tinted Green and Red. Clicking any code line in the patch selects that
anchor and opens a single retained comment bar below the patch (`Enter` or `Save` stores the draft;
`Esc` cancels). Whenever a file's patch digest changes, anchors relocate within `±5` lines when the
excerpt still matches uniquely, or mark `stale` otherwise. Clicking `Send N comments` (or
`Queue N comments` while the agent is working) runs a preflight `bw diff patch` check across every
commented file (including files not currently selected), holds delivery if any anchor is stale, and
otherwise sends a structured `path:line (side)` Markdown review block via `bw send` or `bw queue add`.

The patch arrives in pages under 4 MiB, and "Show more" loads the next page. A line too large for a
page shows as "Line too large to show" with its size.

"Open as tab" opens the patch as a middle tab named after the file, such as `notes.txt · diff`. That
tab loads once, and again when you click its Refresh button. A Committed on branch tab keeps the
commit range it opened with, named by short hashes in its header, and Refresh reads that range
again.

The panel reads only while it is shown. It reads a worktree on this Mac when a file changes, at most
once a second and every 30 s without a change, and a worktree on another machine every 1.5 s. A hidden panel reads nothing, and showing it reads at once.
[Changes](architecture.md#changes) explains the watcher and the Git flags, and
[Polling and costs](architecture.md#polling-and-costs) gives every panel's schedule.

"Open in Changes" in a chat reveals the right inspector and selects the Changes tab. When the chat's
line names one file, the panel reads the list again and then selects that file.

Changes never stages, commits or pushes. Fetch is the only action that writes to the repository.

## Issues

The right sidebar's Issues panel shows the open Linear issues of the project linked to the active
space's repository. Every Linear call runs `bw linear` on this Mac, the machine showing the window,
whatever machine the space is on. [Issues](architecture.md#issues) explains the split.

### Storing the Linear key

`bw linear` reads a Linear personal API key from this Mac's login Keychain, under the service
`bellwether.linear`. Store it once per Mac:

```sh
scripts/linear-key.sh < keyfile   # the key on standard input
scripts/linear-key.sh              # in a terminal: paste at the prompt, which does not echo
```

The script checks that the text looks like a Linear key, stores it under your account and reads it
back to confirm. [Issues](architecture.md#issues) explains how the key stays out of argument lists,
logs and caches.

### Links

Each repository can be linked to one Linear project. The panel's header shows the linked project's
name, or "Link a Linear project". Clicking it opens the link picker: a dialog of the workspace's
projects, with the one whose name matches the repository first and marked "suggested". The project
menu's "Link Linear project…" opens the same dialog. A repository with an `origin` is linked by its
origin's URL, so its clones on other machines share the link.

### The list

The filter under the header picks one of three lists:

- Project lists the linked project's open issues. It is the default when the repository is linked.
- Mine lists open issues assigned to you in any project. It is the default when the repository is not
  linked.
- All lists every open issue.

Open means any state but completed, canceled and duplicate. The search field, "Search issues, then
Enter", runs Linear's issue search within the filter when you press Enter. Issues come 50 at a time,
grouped by state: started first, then unstarted, backlog and triage. "Load more" reads the next 50.

The panel reads the list when it is shown, every 60 s while it stays shown, and when you click its
refresh button. A hidden panel makes no call. Bellwether keeps each answer for 30 days in
`~/.cache/bellwether/linear/`, readable by your account only. When Linear cannot be reached, the
panel shows the kept list and says how old it is. A missing or refused key clears the list and any
open issue, and the panel says what to run. A space outside Git reads nothing from Linear, and the panel
says why. So does a space whose machine does not answer before the panel knows its repository. A
space whose repository the panel already knows keeps its list and goes on reading Linear while its
machine does not answer.

### The issue view

Clicking an issue opens it inline: its identifier, state, labels, title and description as Markdown,
with three buttons.

- Attach to chat puts the issue on the composer of the active tab when that tab is a chat.
- Open in Linear opens the issue's page.
- Copy branch name copies Linear's branch name for the issue.

### Attach

Attach to chat adds a chip to that chat's composer only. The composer shows each chip above the text
field. Pointing at a chip shows the issue's state, title and the start of its description, and the
chip's × removes it. A message may be empty when chips are attached.

At Send the chat builds each chip's text with `bw linear issue --id <id> --text` on this Mac. It then
sends one message to its own terminal: for each issue, `Linear issue <id>: <title>`, its URL, its
description and a `---` line, then what you typed. The chips clear once the message went.

- A description over 8 KB needs a choice on its chip first. "Trim to 8 KB" sends the first 8 KB and a
  note that the rest is at the URL. "Send as a file" places the description beside the chat's
  terminal with `hc put` and sends its path.
- When a description grew past 8 KB after Attach, Send stops, the chip shows its new size and the
  choice, and the typed message stays.
- When a text cannot be built, the chat names the issue and sends nothing.

## Drafts

The right inspector's Drafts panel (`bw-drafts`) inspects read-only skill and review artifacts in the
active space's worktree via `bw drafts` on `space.machine` (polling only while `right` is visible on
`Drafts`):

- HTML pages (`docs/drafts/**/*.html`, `docs/plans/**/*.html`, `docs/superpowers/**/*.html`,
  `.audit/**/*.html`) show an `Open in Browser` button that opens local `file://` URLs directly in
  Bellwether Chrome, or stages remote HTML locally via `bw drafts stage --machine <m>` (`0700` dir,
  `0600` file, capped at 32 staged files) before opening.
- Decision trails (`decisions.tsv` and `.audit/*.tsv` from `show-me-your-work`) parse from the TSV
  header row and render 6-column cards (`ts`, `phase` pill, `decision`, `why`, compact `evidence`
  path, and `result` pill).
- Plans and task lists (`docs/plans/*.md` and root `tasks.md`) show a `- [x]` / `- [ ]` completion
  progress bar and checklist alongside Markdown prose.
- Allow-listed `independent-review` `ledger.md` files (registered via
  `bw drafts register-ledger --path <worktree> --ledger <abs_path>` or matched in `$TMPDIR/*/ledger.md`
  referencing the canonical worktree) and Markdown notes render via `TextView.markdown` (capped at
  512 KiB; sibling raw transcripts and paths outside the worktree are never exposed).

## Browser

Claude and Codex agents started from "+" share one Google Chrome with you, the Bellwether Chrome. It
is a second Chrome instance with its own profile, `~/.local/share/bellwether/chrome`, and its
DevTools port on 127.0.0.1:9222. Bellwether never uses or touches your own Chrome or its default
profile. [Starting and reusing Chrome](architecture.md#starting-and-reusing-chrome) explains how `bw`
checks and starts it.

The right sidebar's Browser panel shows its tabs. Its header shows "Bellwether Chrome", a state such
as "Running · 6 tabs" or "Not running", and the New tab and Arrange buttons. It adds Start when Chrome
is stopped, runs without the port or failed to start. Below the header:

- Each Chrome tab has one row with its favicon, title, host and path. An accent bar marks the active
  tab. With the Bellwether Chrome in front, that is each window's focused tab. Otherwise it is the
  tab Bellwether last focused or opened, because Chrome then reports focus in no tab, or in every
  tab an agent opened in the background. Clicking a row focuses that tab, and hovering shows a close
  button.
- The FORWARDS section lists each SSH forward with its state and a Stop button.
- "Forward port" adds a forward for a dev server (`ssh -L 127.0.0.1:<n>:127.0.0.1:<n>`) from the
  active space's machine. For a space on this Mac it is disabled and says "This space is on this
  Mac".
- Arrange places Chrome beside the Herdr window, at Herdr's top and height. It uses the gap to the
  window's right when that gap is at least 640 points wide, else the gap to its left when that one
  is, else the right half of that display. It works on macOS only and shows its result for 4 s.

### Starting an agent with the browser

Each Claude or Codex row in "+" (New chat and New terminal) first prepares the browser for up to
20 s, and the row shows "Preparing browser…". Bellwether starts the Bellwether Chrome in the
background when it is not running, and for an agent on another machine it makes sure that machine's
SSH forward runs. The agent then starts with a `bw-browser` MCP server and instructions that tell it
to open its own background tab and act only in tabs it opened. These additions last for that session
only, and no user setting is written. When the browser is unavailable, the agent starts without them
and Herdr shows "Started without the browser" with the reason. When the space closes during the
wait, nothing starts and Herdr shows "Nothing started". The Shell row skips this step.
[Agent flags](architecture.md#agent-flags) lists the flags each agent gets and every reason the
browser can be unavailable.

## Removal

```sh
rm -r ~/.local/share/bellwether/agent      # on each machine: the agent files
bw browser forward stop --machine <m>      # hc kill and hc rm on the forward's terminal, and delete its state file
bw browser down                            # close the Bellwether Chrome
bw machine setup <machine|local> --remove  # take Bellwether's groups out of the Claude and Codex hook files
```

The Chrome's profile stays in `~/.local/share/bellwether/chrome`. Deleting that folder removes its
history and sign-ins.

## Known limits

### Chats and requests

- When a terminal pane itself is narrowed inside a multi-pane split on `panes`, a Claude approval box
  taller than that terminal can lose its header off the top while both dashed rules stay on screen.
  Bellwether matches that box to its call by command, so its card sits under its sub-agent. The
  card's detail can begin with a fragment of the cut header, such as "agent".
- `bw answer` refuses as `stale` when the command, the question (an Edit's target included) or the
  Always label differs in any whitespace inside a line.
- A card pending while its machine's helper is replaced by one with this whitespace check comes back
  under a new id, and the old id presses nothing.

### Agents on another machine

- Claude started on another machine by a core that SSH started cannot read that machine's login
  keychain, so it runs unlogged ("Not logged in" or API billing). Start that machine's core from its
  own login session.

### Browser

- An agent's browser MCP needs Node and `npx` on the machine the agent runs on. Without them the
  agent starts without the browser (`node_missing`).
- The first session on a machine may wait on the npx download of `chrome-devtools-mcp@1.12.0` when
  the one-time warm-up has not finished.
- A machine that `hc` reaches through `via` gets no browser, because the forward needs SSH
  ("browser forward unavailable: <m> connects through via, not SSH").
- Claude's `--allowedTools mcp__bw-browser` lets its browser tools run without a permission prompt,
  as Codex's `approve` does. The instructions forbid passwords, one-time codes, payment details and
  purchases.
- Arrange works on macOS only.
- After the Bellwether Chrome restarts, a running agent's browser tools stop working until its next
  session.
- Arrange's left-gap and half-screen placements are unchecked in a window. OmniWM tiles every window
  on the Mac mini, so only the right-gap placement was seen.
- A browser agent on a space on another machine is checked by script only.

### Changes

- An untracked file over 64 MiB is listed without counts.
- A diff opened as a tab does not refresh by itself. Its Refresh button reads it again.
- A read after an edit is a full read: about 156 ms of CPU on a 40,000-file checkout. Only a remote
  poll that finds no change is cheap, about 10 ms.
- A remote panel keeps one `bw diff watch` process per worktree on the space's machine while the
  panel is shown and for 60 s after.
- The project sidebar's Git counts have no watcher. For a selected worktree on another machine they
  run every 1.5 s, about 175 ms of CPU per poll on a 40,000-file checkout.

### Issues

- The key lives in one Mac's Keychain. Run `scripts/linear-key.sh` once on each Mac that shows the
  window.
- Mine and All show issues from every project, so their titles appear on screen whatever the
  repository.
- A list is not read again while the panel is hidden. Showing the panel reads at once.
