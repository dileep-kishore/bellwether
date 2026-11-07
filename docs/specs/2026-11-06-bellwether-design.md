# Bellwether design

Status: revision 4, for the user's approval, 2026-11-06. Nothing is built.

The user's requests are in `docs/brief/2026-11-06-request.md`. Their
interview answers, their later requests and their review of the plan page
are in `2026-11-06-bellwether-design-intent.md` beside this file, with an
amendment log of every change. Evidence about the reference projects is in
`docs/research/2026-11-06-reference-survey.md`.

History: Claude and Codex wrote independent proposals (revision 1). A Claude
and a Codex design review, with fresh verifiers, found 12 problems and 9 gaps
(revision 2). Codex's plan review found 6 more (revision 3). The user then
chose the look of every part and asked for tabs, a right sidebar, Linear
projects linked to repositories, seamless remote machines, and a second look
at the browser (revision 4). The final mockups are on the plan page,
`docs/drafts/bellwether-plan/bellwether-plan.html`.

Design sources: T3 Code (`pingdotgg/t3code` at `006d7e38`, MIT) and Orca
(`stablyai/orca` at `b0cd6d39`, MIT), read for layout, rows, status icons,
tool-run sentences, approval cards, the sub-agent card and the source
control panel. Bellwether borrows their ideas and sizes, drawn with Herdr's
theme colours; it copies no code from them.

## Intent

The user wants a Herdr window that works the way they work with agents: pick
a project and worktree on the left, work in tabs of chats and terminals in
the middle, keep changes, issues and the browser on the right. Chats are
built from the agents' session logs, show each sub-agent as its own thread,
and take approvals and questions above the composer. Everything works the
same for a space on any connected machine as for one on this Mac, as in T3
Code. Agents and the user share one browser. Rust does the parsing and Git
work; Herdr's own features do everything they already do. After the user
approves this plan, the build runs all phases without approval stops.

## Goals

1. Window: a left project sidebar, a middle tab area, a right sidebar with
   Changes, Issues and Browser, and Herdr's status bar.
2. Project sidebar: projects per machine, every worktree from `git worktree
   list` under its project, and each agent as a line under its worktree with
   its status, sub-agent count and waiting requests. Closed worktrees are
   dimmed and open on click; projects stay listed after their last space
   closes.
3. Tabs: a "+" menu starts a Claude chat, a Codex chat, or a terminal (shell,
   Claude or Codex). A chat tab shows the agent's log as a chat and flips to
   that agent's terminal with `⌘J`.
4. Chat: grouped tool lines, a threads card for sub-agents (each opens as its
   own transcript), approvals and questions docked above the composer and
   answered there, and inline pictures.
5. Changes: staged, unstaged and committed lists against `origin/main` or a
   picked ref, with the patch below and an "open as tab" action.
6. Issues: the Linear project linked to the repository by default, issues
   open inline, Attach adds the issue to the chat's composer.
7. Browser: a real Chrome window with a Bellwether profile that the user and
   every agent share; agents drive it through Chrome DevTools MCP, with
   instructions injected per session as T3 Code and Orca do.
8. Seamless machines: a space on macmini or tsuki gets every feature above
   with no setup on that machine beyond Herdr's own connection.

## Non-goals

- No phone page, web app, voice or task runner.
- No commit, stage or push in Changes; Herdr's `changes` mod stays available.
- No Linear writes.
- No Cursor, Grok, pi or Antigravity chats in the first release.
- No browser drawn inside the Herdr window (no mirror, no terminal browser):
  the research found it would cost much and give agents nothing; see
  "Browser".
- No general computer use; agents keep their own tools.
- No publishing to GitHub or herdr.dev without the user's approval.

## Anti-goals

- Bellwether presses a key into a prompt other than the one its card showed,
  or delivers a message to a different agent or conversation than the chat
  shows.
- A Linear API key appears in mod code, shared state, helper output, a log, a
  cache or the repository.
- A feature behaves differently, or needs manual setup, because a space is on
  another machine.
- The window gets slower: polling of live data, timers for animation, or
  hidden chat tabs polling as fast as the shown one.
- A broken helper, an offline machine or a missing log leaves a blank panel
  instead of a named state with the terminal one key away.
- Private transcripts, issues or browser profiles land in the repository.

## Constraints from Herdr

From `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts` (herdr-app 0.1.13, hc
0.1.18) and the repository's `AGENTS.md`:

- Mods are JavaScript drawn by GPUI: no DOM, no web view, no `setTimeout`.
- `exec` returns once (30 s, 8 MiB, no standard input). `writeTextFile`,
  `watchFolder` and `pickFolder` work only on the window's machine.
  `exec(..., { on })`, `readTextFile(..., { on })`, `hc exec --on` and `hc
  file write --on` reach other machines.
- `agents()`, `spaces()`, `panes()`, `terminals()`, `focused()` are live; no
  polling. Animation uses `.frames`, `.spin`, `.loop`.
- `hc send` and `hc keys` wait until 3 s after the last typing in that
  terminal and take no condition on the screen.
- `tab.new {argv, name, space}` starts an agent in a tab on the space's
  machine; `pane.split {mod, props}` adds a mod pane; `pane.zoom` shows one
  pane of a tab full size.
- Herdr's `tabs` mod draws its own "+" menu and only the Files and Changes
  panel buttons (`mods/tabs/main.js:80-100`), so Bellwether draws its own
  tab bar.
- Mods are named `bw-<name>`, the layout `bellwether`; `scripts/sync.sh`
  installs them; shared JavaScript lives in `shared/`.
- Herdr's shipped mods have no license file; Bellwether writes its own code.
- The repository rule "Work that watches logs or Git runs in a Rust helper"
  exists because `exec` cannot stream; phase 1 amends it to allow
  `watchFolder` with short Git calls.

## Architecture

```text
WINDOW MACHINE (this Mac)                                ANY MACHINE WITH SPACES
┌───────────────┬───────────────────────────┬────────────┐  ┌─────────────────────┐
│ bw-projects   │ bw-tabs [chat][chat][>_] + │ bw-right   │  │ bw helper (installs │
│ machines      ├───────────────────────────┤ Changes    │  │ itself from here)   │
│  projects     │ chat tab: bw-chat pane    │ Issues     │  │  feed send answer   │
│   worktrees   │  (agent terminal pane     │ Browser    │  │  cards diff pictures│
│    agents     │   behind it, ⌘J)          │            │  │ agent logs, hooks,  │
│               │ terminal tab: Herdr panes │            │  │ git, Chrome DevTools│
└───────────────┴───────────────────────────┴────────────┘  │ MCP per agent       │
bw on the window machine: linear, picture, browser,         └─────────────────────┘
machine install. Bellwether Chrome (headed, own profile, CDP 127.0.0.1:9222),
reached from other machines through ssh -R. Keychain: Linear key, read by bw.
```

### Pieces

| Piece | Job | Built from |
|---|---|---|
| `layouts/bellwether.json` | Left `bw-projects`; middle `bw-tabs` over `{ "tab": "active" }`; right `bw-right`; Herdr's `workspace-status`. | `layout.clone` of Herdr's `main`, then edited. |
| `mods/bw-projects` | Machines, projects, worktrees, agent lines. | New, on Herdr live data and short Git calls. |
| `mods/bw-tabs` | Tab bar with chat and terminal tabs, status, close, "+" button. | New; tab look after Herdr's `tabs` and Orca's tab bar. |
| `mods/bw-new` | The "+" menu. | New; after Herdr's `new-menu` and Orca's create menu. |
| `mods/bw-chat` | One chat tab: header, timeline, threads card, request dock, composer. | Adapted from Flockbook's mod (MIT); look after T3 Code and Orca. |
| `mods/bw-right` | Right sidebar shell with its Changes, Issues, Browser strip. | New. |
| `mods/bw-diff`, `bw-linear`, `bw-browser` | The three right-sidebar panels; `bw-diff` also opens as a middle tab. | New. |
| `shared/` | Chat target, helper calls, machine routing, status ranking, project model. | New. |
| `crates/bw` | The Rust helper. | Chat modules and the remote installer adapted from `flockbook-modfeed` (MIT); Git, Linear, browser new. |
| `crates/vendor/herdr-core` | Flockbook's core crate. | Vendored whole at `c0420c7`, changed in reviewed steps. |
| `hooks/bw-event` | A `sh` gate that runs the installed `bw event`, which records approval and sub-agent events in `~/.cache/bellwether/events/<terminal>/`, since parsing JSON in `sh` needs `jq`, which a machine may lack; decides nothing. | New; Herdr-terminal gate after Shepherdr's `ask-hook.sh:19`. |
| `agent/` | The per-session browser instructions and MCP config Bellwether passes to agents it starts. | New; modelled on T3 Code's `orchestrationInstructions.ts:32-37`. |

## Seamless machines

Every feature behaves the same for a space on another machine. The window
machine runs the mods, the Linear client and the browser; the machine that
holds the space runs the agents, the logs, Git and the hooks.

- One routing rule: every mod calls the helper through `shared/helper.js`
  with the space's machine; nothing reads a log or repository by local path.
- The helper installs itself. When `bw version` on a machine is missing or
  older, the window's `bw machine install <machine>` copies the matching
  build with `hc file write --on` in parts under 6 MB, checks its SHA-256
  there, and links `current` (Flockbook's `remote.rs` approach,
  `flockbook-modfeed/src/remote.rs:1-30`). The sidebar shows "setting up
  Bellwether on macmini" while it runs. No Rust or build step is needed on
  that machine. Builds: `aarch64-apple-darwin` (this Mac and macmini, both
  Darwin arm64), and `x86_64` and `aarch64-unknown-linux-musl` through
  `cargo zigbuild` for tsuki, whose architecture is checked when it is back
  online.
- The record-only hooks install on each machine when the user applies the
  diff the chat shows (`bw machine setup <machine> --diff`, then
  `--apply`), appended after Orca's and the user's own, with a backup and
  an install record; `--remove` takes them out. Codex asks the user to
  trust them once per machine.
- The "+" menu lists the agents installed on the space's machine
  (`knownAgents({ on })`) and starts them there with `tab.new` in that space.
- Each machine's agents reach the shared browser through an SSH reverse
  forward the window machine keeps open (see "Browser"). Node is on both
  machines (`/opt/homebrew/bin/npx`, v26), so Chrome DevTools MCP runs beside
  each agent.
- Pictures, attached Linear issues and files placed with `hc put` travel to
  or from the machine through Herdr's connection.
- A tab on another machine carries a small machine tag; nothing else
  differs. An offline machine shows its named state and keeps its rows.

## Window

- Left, 248 px (resizable 160 to 480): `bw-projects`.
- Middle: `bw-tabs` (32 px) over the active tab.
- Right, 360 px, resizable 280 to 900, hideable with a key checked against
  `keys.json` in phase 1: `bw-right`.
- Bottom: Herdr's `workspace-status`.

## Project sidebar (`bw-projects`)

- A project is a Git common directory on one machine (`git rev-parse
  --path-format=absolute --git-common-dir`), keyed by `[machine, path]`,
  named after its main checkout, and remembered in `shared("bw.projects")`.
  The header has Add project (`pickFolder` here, a typed path on another
  machine); a project's menu has New worktree, Open worktree (Herdr's
  `worktree` dialog), Link Linear project, and Remove.
- Rows, after Orca's sizes: machine heading (11 px, uppercase); project
  header (13 px semibold, letter tile, hover "+" for a new chat in the main
  checkout); worktree row (13 px branch name, `↑↓` and `+N −M` on the right);
  agent line (24 px, 11 px text) with its state icon, agent icon, the tab's
  title, `+N` running sub-agents, a request badge and the time since its
  last change. The counts come from `bw counts` on the space's machine
  every 10 s per machine and when an agent's status changes.
- State icons use Herdr's theme colours with Orca's and T3's shapes: working
  is a spinning ring (`.spin`), blocked a question mark in `blocked`, done a
  check in `done`, idle a hollow ring. A worktree or project that is folded
  shows its most urgent child (blocked, then done, then working).
- A closed worktree is dimmed; a click runs `space.select` for a space
  already there, else `space.new {folder, machine}`. An agent line click
  selects its tab and runs `agent.focus`.
- Lists refresh on `watchFolder` of each local common directory and each open
  worktree, debounced to one refresh per second, with a 30 s refresh for open
  worktrees, a 60 s timer when a watch is rejected, and 15 s for other remote
  worktrees. The selected worktree on a remote machine refreshes every 1.5 s,
  since `watchFolder` cannot watch another machine. `setAgentOrder` follows
  the list.

## Tabs (`bw-tabs`, `bw-new`)

- The tab bar lists the active space's tabs, 32 px tall, each with its icon
  (Claude, Codex or a shell), its title, a status icon, and a close button
  when active; drag reorders with `tab.move`; a machine tag shows for a
  space on another machine.
- "+" opens the menu (232 px wide, Orca's 288 px scaled to Herdr's 13 px text):
  - New chat: Claude, Codex, each marked unavailable if not installed on the
    space's machine.
  - New terminal: Shell, Claude, Codex (Herdr's own agent-in-a-terminal).
  - New worktree…, Open worktree… (Herdr's `worktree` dialog).
- A chat tab is one Herdr tab with two panes: the agent's terminal and a
  `bw-chat` pane beside it. Bellwether records a pending chat in
  `shared("bw.chat-tabs")` and starts the agent with `tab.new {space, argv,
  name}`; since `run` returns no ids, `bw-tabs` adds the chat when a new
  tab with the name it asked for appears (for a chat without a space, the
  first tab of a new space in its folder) with `pane.split {direction:
  "right", mod: "bw-chat", props: {terminal, machine, kind, window}}`,
  records both pane ids there, and zooms the chat pane. A new tab with
  another name leaves the pending chat waiting. Herdr stores props as given
  and every window on the space's core reads them, so `window` names the
  app home that wrote them (`shared("bw.window-id")`). `bw-tabs` also
  registers a chat tab its app home never recorded, one terminal pane and
  one `bw-chat` pane made in another window or before this app home
  existed, with no split or zoom, so `⌘J` works on it. `⌘J`
  is bound to `bw-tabs.chat-flip`, handled by the always-shown `bw-tabs`
  mod (a `<mod>.<command>` reaches shown copies only, and a hidden chat
  pane is not shown); it zooms the other pane and focuses it, so the tab
  flips between chat and terminal as Orca's agent tabs do. Herdr's status
  for the agent stays on the tab. If phase 0's spike finds the zoom flip
  unreliable, the fallback is a tab whose only pane is the chat, with the
  agent's terminal started by `hc run --keep` carrying the tab's
  `herdr.space` and `herdr.tab` labels, shown with `terminal.show`, and
  ended by the chat's `close`; its ownership and close behaviour are
  specified in that spike.
- Bellwether launches chat agents with per-session additions (see
  "Browser"): Claude with `--mcp-config` and `--append-system-prompt-file`,
  Codex with `-c mcp_servers.bw-browser…` and `-c developer_instructions=…`,
  where the value is the effective existing `developer_instructions` (that
  machine's `~/.codex/config.toml`, then the `--profile` file, then a
  trusted project's `.codex/config.toml`) followed by Bellwether's text, so
  nothing the user set is lost. Claude gets no `--strict-mcp-config`, and
  Codex's browser server gets `default_tools_approval_mode="approve"`. Terminal
  tabs of Claude or Codex get the same additions. The additions arrive with
  the browser in phase 4; until then chat and terminal tabs start agents
  with `agent.run` unchanged.
- A chat tab that is not shown, including a chat pane behind its terminal's
  zoom, polls its feed every 10 s instead of every 2 s, and flipping back
  reads at once; status comes from `agents()` regardless.

## Chat (`bw-chat`)

The chat target is `{machine, terminal, agent kind, root session, log path}`
plus, in a sub-agent view, the child session.

`bw-chat` finds its terminal in its own tab: the tab holding a `bw-chat`
pane beside a terminal whose machine-local address and agent kind match the
props. In the window whose id the props carry, the full address must match
too, which tells apart two machines that reuse one terminal id. Any other
window needs exactly one matching tab and no chat tab without a terminal.
Otherwise the chat says "Chat target not found" and neither reads nor
sends.

- Header (36 px): agent icon and name, the worktree's branch, the machine tag
  when remote, the threads button with its count, and the `⌘J` hint.
- Timeline, at most 736 px wide (T3's 46 rem): user messages as right-aligned
  bubbles (80 % width, 16 px radius); assistant text unboxed as markdown;
  tool runs as one line each, a sentence such as "Read 3 files and ran 2
  commands" with a spinner while live and a check when done, expanding on
  click; a "Changed N files · Open in Changes" line at the end of a turn that
  edited files; inline pictures.
- Threads card: a floating card at the chat's top right (312 px, after
  Orca's crew card and T3's lineage list), open while a sub-agent runs or
  asks and folded to a pill ("2 sub-agents · 1 asks") otherwise; the
  header's threads button toggles it. Rows:
  the parent, then each sub-agent with state icon, type, description, time
  and request badge, nested by depth. Clicking a sub-agent opens its own
  transcript in the timeline; its composer is replaced by a bar ("Explore ·
  sub-agent of Claude · running · Back to Claude"), since in-process
  sub-agents take no messages. A terminal sub-agent (its own Herdr terminal)
  keeps a composer that sends to it.
- Request dock above the composer, in every view, since the parent's
  terminal shows one prompt at a time: one card per waiting request of the
  session, newest last, titled "Approval needed from <who>" or "<who>
  asks", with the tool and command in monospace, and buttons Approve
  (primary), Always allow, Deny, and "Answer in terminal". Questions show
  step tabs when there are several, options with 1 to 9 keys, and an
  "Other" text field. Each chat
  poll carries the tree and the requests with the rows (`bw feed --tree
  --cards`), one `exec` per poll, so a request shows within done check 3's
  3 s.
- Composer: a rounded box with chips (attached Linear issues), the text
  field ("Message Claude…"), and send. Slash commands pass through to the
  agent. Results show by name: sent, refused (agent waiting on a prompt),
  refused (another conversation), unconfirmed, and not sent (`<reason>`)
  for a closed terminal or an unreachable machine.

### Sources and parsing

- Claude Code 2.1.309 and later writes every sub-agent of a session, at any
  depth, to `<session>/subagents/agent-<id>.jsonl` with `agent-<id>.meta.json`
  (`agentType`, `description`, `toolUseId`, `spawnDepth`, `finished`, and
  `parentAgentId` from depth 2).
- Codex 0.167 writes each sub-agent to its own rollout, whose `session_meta`
  names `parent_thread_id`; the parent calls `spawn_agent`; `event_msg` items
  `SubAgentActivity` carry `agent_thread_id`. Its `exec` and `js` tools run
  JavaScript, so tool lines name the inner `tools.exec_command` and
  `tools.apply_patch` calls; `agent_message` records show as status lines.
- Flockbook skips sidechain lines (`conversation/mod.rs:232`), shows `Agent`
  as one row (`:647`), reads only Codex `response_item` (`:452`), and its
  resolver ignores `session_meta.source` (`resolver.rs:1118-1131`).
- Bellwether parses each session file on its own, builds the tree from
  `parentAgentId`, `toolUseId`, `parent_thread_id` and `terminals()`
  `parent`, skips Codex sub-agent rollouts when finding a root and remembers
  the root per terminal, and handles the Codex 0.167 records.
- Pictures: `bw feed --pictures` lists them; the window-side `bw picture`
  copies each (4 MB cap) into `~/.config/herdr-app/data/bellwether/pictures/`
  as `<digest>.<format>` for `image()`, pruned after 7 days.

### Sending and answering

- `bw send` and `bw answer` carry `--expect-kind`, `--expect-session` and
  `--expect-path` and refuse when the terminal's conversation changed
  (Flockbook's guard, `flockbook-modfeed/src/cards.rs:310-325`). Both run
  on the space's machine with the terminal's local address, so `bw
  answer`'s last screen read and its key are one local step, and neither
  uses `--force`. A chat that has never shown a conversation sends its
  first message with `--expect-session none --expect-path none`, which
  passes only while that kind's agent runs there in a positively fresh
  session: the agent names a session that has no log yet.
- After Codex's `/new` the agent writes no log until its first message, so
  the feed's `no_log` line names the new session. The chat then drops the
  old rows and sends that session's first message with `--expect-session
  <id> --expect-path none`, which passes only when a fresh lookup names that
  session, with no log, for a live agent of that kind. Claude 2.1.319
  writes the new conversation's log at `/clear`, so the feed names the new
  session with its log, the chat drops the old rows, and its next message
  goes with the new session and that log.
- A lookup that settles on no single conversation prints the `ambiguous`
  state, which `bw send` refuses for every expectation. This covers no
  candidate, several, or one another terminal claims, and a Codex terminal
  with more than one open root thread: Codex 0.167 keeps a thread it left
  loaded for 60 s or while it runs, so after `/resume` nothing tells which
  one it shows. The
  helper names no conversation and the chat sends nothing until one
  remains.
- The `bw-event` hook (only inside Herdr terminals, `$HC_TERMINAL_ID`)
  records `PermissionRequest`, `SubagentStart` and `SubagentStop` events with
  session, agent id and tool use id, and exits 0 silently.
- A request's identity is `{terminal, root session, child, tool use or event
  id}`; claims are scoped to it.
- Screen-bound requests (approvals, Claude `AskUserQuestion`, Codex
  `request_user_input`, and Codex 0.167's `/new` folder prompt "Where
  should the new conversation run?", where a `/new` sent from the chat
  stops) are answerable only when the same prompt is on the
  controlling terminal's screen (Flockbook's matchers, plus a Codex 0.167
  approval matcher built in phase 3). Message-bound Codex
  `request_user_input_async` questions are answered as one user message
  recorded against the request.
- Answer buttons stay disabled while the terminal has had keyboard focus in
  this window within 3 s; after keys land the helper reads the screen again
  and marks the card "uncertain" if it changed. States: pending, sending,
  answered, declined, answered in the terminal, declined in the terminal,
  settling, stale, uncertain. Answered and declined mean Bellwether's key or
  message went out; settling means the prompt left the screen and its call
  has no result in the log yet, for at most 5 s and never answerable; a
  resolved card stays 10 s.

## Right sidebar (`bw-right`)

A 36 px strip of three labelled tabs, Changes, Issues, Browser, after T3's
and Orca's right panels; the chosen tab is kept per space.

### Changes (`bw-diff`)

- Header: `<branch> → <base> ▾` with the base's short hash and age, Fetch,
  and a Merge base / Tip switch. The base defaults to `origin/main`, else
  `origin/HEAD`'s target, else the picker opens; typed refs are checked with
  `git rev-parse --verify --end-of-options <ref>^{commit}`; the choice is
  kept per project.
- Sections, after Orca: Staged (`git diff --cached`), Changes (`git diff`
  plus untracked files), Committed on branch (`git diff <merge-base> HEAD`).
  Each file shows its status letter and `+N −M`.
- Clicking a file shows its patch below the list, unified with line numbers;
  "Open as tab" shows it full width as a middle tab (`tab.new {mod:
  "bw-diff", props}`), as Orca opens diffs in the main area.
- Git runs on the space's machine with `--no-optional-locks -c
  core.fsmonitor=false -c diff.autoRefreshIndex=false` and `--no-ext-diff
  --no-textconv --no-color`; one call fetches the lists; patches page under
  4 MiB.

### Issues (`bw-linear`)

- Each repository can be linked to one Linear project, stored in
  `shared("bw.linear.links")` keyed by the normalized `origin` URL, so the
  same repository on macmini uses the same link. A repository with no
  `origin` (this one has none) is keyed by `[machine, absolute common
  directory]`; when it later gains an `origin`, the link moves to the origin
  key. The link picker lists the
  workspace's projects and suggests one whose name matches the repository.
  Neither T3 Code nor Orca has this link; it is new.
- Header: the linked project's name with a picker, a filter (Project, Mine,
  All; Project is the default when linked, Mine when not), and search.
- The list groups issues by state, excluding completed and canceled, 50 per
  page. An issue opens inline: identifier, state, labels, title, description
  as markdown, and Attach to chat (primary), Open in Linear, Copy branch name
  (after Orca).
- Attach adds a chip to the composer of the current chat tab. On Send the
  text is `Linear issue <id>: <title>`, the URL, the description and a `---`
  line ahead of the user's message; a description over 8 KB is trimmed by
  the user or sent as a file with `hc put`.
- The helper calls Linear's GraphQL API with a personal API key read through
  `security find-generic-password -s bellwether.linear -w`; the mod never
  sees the key. The dated cache keeps the list on screen through network
  errors.

### Browser (`bw-browser`)

Research (2026-11-06; sources on the plan page): T3 Code and Orca both embed
an Electron web view, connect to it over CDP, and inject browser
instructions into every agent session; the instructions are what make agents
use the browser well. Herdr cannot embed a web view, and a mirrored picture
would lose text selection, input methods and DevTools while giving agents
nothing new. Codex 0.167's built-in browser use is unreliable from a terminal
(`openai/codex#26820`); Claude Code's Claude in Chrome works but uses the
user's everyday Chrome.

Design:

- The Bellwether Chrome: a headed Chrome window with its own profile
  (`~/.local/share/bellwether/chrome`) and `--remote-debugging-port=9222` on
  127.0.0.1 (Chrome ignores the port on the default profile). `bw browser up`
  starts it or reuses it; the panel's Arrange button places it beside the
  Herdr window with CDP `Browser.setWindowBounds`.
- Agents: Chrome DevTools MCP, pinned (1.12.0 as researched), one instance
  per agent session, with `--browserUrl http://127.0.0.1:9222`. Bellwether
  passes it, and a short instructions file, to every agent it starts (chat
  and terminal tabs), so nothing in the user's global agent settings changes.
  The instructions, after T3 Code's: the Bellwether Chrome is the browser you
  share with the user; open your own tab in the background and act only in
  tabs you opened; snapshot before acting; never enter passwords or payment
  details; say which tab you used.
- Claude may also use Claude in Chrome (`--chrome`) when the user asks for
  their everyday browser; Bellwether does not configure Codex's built-in
  browser use.
- Remote agents: for each machine with a Bellwether-started agent, the
  window machine keeps a reverse forward open as an unlabeled kept core
  terminal: `ssh -o ExitOnForwardFailure=yes -N -R
  127.0.0.1:<port>:127.0.0.1:9222 <target>`. `<target>` is the machine's SSH
  target from `hc machine ls --json`, not its Herdr name; a machine connected
  through `via` (no SSH target) shows "browser forward unavailable" and its
  agents start without the browser MCP. `<port>` is chosen per window and
  machine from a free port on that machine, so another Chrome or forward on
  9222 there is never mistaken for this one. Before agents get the MCP
  config, `bw` checks on the remote machine that the port listens only on
  127.0.0.1 (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) and that
  `http://127.0.0.1:<port>/json/version` returns this Chrome's browser id;
  if either fails (for example under `GatewayPorts yes`), the forward is
  closed and the state is named. A dropped forward reconnects with the same
  checks. The panel offers "Forward port" for a dev server on that machine
  (`ssh -o ExitOnForwardFailure=yes -N -L <port>:127.0.0.1:<port>
  <target>`) so the Chrome here can open it.
- The panel lists the Chrome's tabs from `http://127.0.0.1:9222/json/list`
  (title, URL, favicon), marks the active one, and offers focus and close,
  New tab, Arrange, and the forwards in effect.
- Agents' screenshots appear inline in their chat through the picture path.

## Decisions

| Decision | Chosen | Who |
|---|---|---|
| Chat place | Middle tabs: each chat is a tab, flipping to its terminal | user |
| Approvals | Chat buttons press keys after re-reading the screen; a hook records who asked | user |
| Worktrees | All of `git worktree list`, closed ones dimmed | user |
| Machines in the sidebar | Separate projects under each machine | user |
| Attach | Chip in the composer, sent with the next message | user |
| First feature | Project sidebar | user |
| Sidebar rows | Tree with agent lines | user |
| Sub-agents | Threads card, each sub-agent its own transcript | user |
| Requests | Docked above the composer | user |
| Tool detail | Grouped summary lines | user |
| Changes and Issues | Right sidebar; issue opens inline | user |
| Linear scope | Linked Linear project per repository by default | user |
| Remote | Seamless; helper and hooks install themselves | user |
| Browser | Shared real Chrome with per-session MCP and instructions; no in-window browser | research, for the user's approval |
| Flockbook reuse | Vendor `herdr-core` whole; adapt chat modules and `remote.rs` | both proposals |
| Helper model | One short process per poll; watcher only past 100 ms CPU per poll | both proposals |
| Git engine | Git CLI, batched | both proposals |
| Linear access | GraphQL from the helper, key in Keychain | agent default |

## Phases

Each phase ends with something usable, `scripts/sync.sh`, `scripts/check.sh`,
a screenshot, and its done checks; each borrowed file is recorded in
`THIRD_PARTY_NOTICES.md` in the commit that copies it.

0. Foundation: repair cargo; `target` in `.stignore`; the `bellwether`
   layout; the `bw` crate with `bw version` and `bw machine install`
   (installs on macmini); isolated test window; scripted, scrubbed agent
   recordings; a spike of chat-tab mechanics (zoom flip, per-session agent
   flags).
1. Window and project sidebar: `bw-projects`, `bw-tabs` and `bw-new` with
   terminal entries, an empty `bw-right`. Usable: the new window, on both
   machines.
2. Chat tabs: vendored core, `bw feed`, `bw send`, pictures, `bw-chat`,
   chat entries in "+", `⌘J`.
3. Sub-agents and requests: session tree, threads card, sub-agent views,
   hooks on each machine, request dock, Codex approval matcher.
4. Browser: Bellwether Chrome, per-session MCP and instructions, forwards,
   Browser panel.
5. Changes panel and diff tabs.
6. Issues panel, Linear links, Attach.
7. Measure and finish: timings, `RECIPE.md`, final review, the plan page
   refreshed with results.

## Done checks

Recorded sessions come from scripted prompts with the real agents in a
scratch folder and pass `scripts/verify/scrub-fixture` before entering the
repository.

1. Window, sidebar and tabs on both machines (property and app run). With
   two scratch repositories, one fully closed, on this Mac and one on
   macmini: the sidebar lists all three projects under their machines;
   worktree rows equal `git worktree list --porcelain -z`; agent lines equal
   `herdr-app ls`; a dimmed row opens exactly that worktree; a plain file
   edit in the selected worktree updates its counts within 2 s on either
   machine; "+" on the macmini space starts a
   Codex chat whose process runs on macmini (`hc exec --on macmini pgrep
   codex`); with macmini offline its heading says so.
   Command: `bun test shared/`, `scripts/verify/projects.sh`, `herdr-app
   ls`, `herdr-app shot`.
2. Transcripts and trees (known answer). Recorded Claude 2.1.319 and Codex
   0.167 sessions give hand-counted parent and child rows and the right
   tree, including a nested sub-agent; a Codex root resolves beside its
   child; a send naming an old conversation is refused; a missing helper is
   named and then installed by `bw machine install`.
   Command: `cargo test -p bw --locked`, `scripts/verify/sessions.sh`.
3. Requests from the chat, here and on macmini (app run from empty state).
   In a `claude --permission-mode default` chat tab on this Mac and another
   on a macmini space, a foreground and a background sub-agent each run
   `touch <name>.txt`: each approval appears under its sub-agent in the
   threads card and in the dock within 3 s; the file is absent before
   Approve and present after; a prompt answered in the terminal first leaves
   a stale card that presses no key; the buttons are disabled within 3 s of
   terminal focus; a Codex async question is answered as one message.
   Command: `test -f` (with `hc exec --on macmini` there), `hc read` before
   and after, `herdr-app shot`.
4. Changes equal Git, here and on macmini (reference comparison). Staged,
   Changes and Committed lists and every patch equal `git diff --cached
   --no-textconv`, `git diff --no-textconv` plus `git ls-files --others
   --exclude-standard`, and `git diff --no-textconv $(git merge-base
   origin/main HEAD) HEAD`, for a fixture with an untracked file, a rename,
   a binary file, a textconv marker that is never written, a typed ref,
   tip-to-tip, and no `origin/main`.
   Command: `scripts/verify/git.sh`, `scripts/verify/git.sh --on macmini`.
5. Issues follow the linked project and Attach reaches the right chat (app
   run). With `bellwether` (no `origin`) and a scratch repository with an
   `origin` each linked to a Linear project, the default list's
   identifiers equal a GraphQL query for that project's open issues; Mine
   and All change it accordingly; Attach then Send in chat A puts `Linear
   issue <id>: <title>` first in A's next user message and leaves chat B
   unchanged; the key's first 12 characters appear nowhere on disk.
   Command: `scripts/verify/linear.sh`, `scripts/verify/sessions.sh`, `rg
   -F` over the app home, the cache, the helper data and the repository.
6. The shared browser (app run). A Claude chat tab on this Mac and a Codex
   chat tab on macmini, each asked to open the test page and click button N,
   do it in the Bellwether Chrome in tabs of their own; the Browser panel
   lists both tabs; the user's click in the same Chrome is acknowledged by
   the page; each chat shows the agent's screenshot inline; no agent session
   outside Bellwether gained the MCP server; on macmini the forwarded port
   listens only on 127.0.0.1 and reports this Chrome's browser id; a
   Codex session with a sentinel `developer_instructions` keeps it.
   Command: `scripts/verify/browser.sh` (reads the test page's log of
   clicks), `claude mcp list`, `herdr-app shot`.

## Risks

1. Agent updates change prompt screens and log records; fixtures carry
   versions, unknown records are tolerated, and unmatched prompts fall back
   to the terminal.
2. Herdr has no compare-and-send and holds keys for its 3 s quiet rule; the
   focus guard covers this window, and typing from another Herdr client can
   still move a held key, shown as "uncertain". A conditional key request is
   filed with Herdr.
3. Codex sub-agent approvals depend on reading Codex 0.167's child approval
   box; the phase 3 experiment and matcher made them answerable, and a
   box the matcher cannot read falls back to "Answer in terminal".
4. The user's Claude settings use auto mode, so few actions prompt.
5. The browser's debugging port has no authentication, here and through the
   forward; the Bellwether profile holds only logins the user makes there,
   and both ends are checked to listen on loopback only, failing closed
   otherwise. Several agents on one Chrome can pull its
   window forward (`chrome-devtools-mcp#2856`) or clash in a tab; the
   instructions keep each agent in its own tabs.
6. Two panes per chat tab is a new use of Herdr's zoom; phase 0's spike
   checks that the zoom flip, status and closing behave, and the fallback is
   a chat-only tab whose terminal is shown with `terminal.show`.
7. Automatic install writes binaries and hook entries on other machines;
   each is hash-checked, versioned, and listed in the final report.

## Defaults nobody discussed

- Crates in `crates/`; `herdr-core` vendored whole.
- Claude Code and Codex only.
- The helper installs itself on each machine; the hooks install when the
  user applies the chat's diff, and Codex trust is a user step per machine.
- Watcher only past 100 ms CPU per poll; hidden chat tabs poll every 10 s.
- Right sidebar 360 px; threads card 312 px; chat column 736 px.
- Changes never stages, commits or pushes; Fetch only on click.
- Linear: open issues only, 50 per page, personal API key, no writes; link
  stored per `origin` URL.
- Browser: port 9222, Chrome DevTools MCP 1.12.0 pinned, separate profile.
- The composer never retries or forces; a prompt the matchers cannot read
  is answered in the terminal.
- Cache under `~/.cache/bellwether/` with per-folder pruning (feeds 7 days,
  events 24 h and 2,000 files, requests 24 h, git pages 200 MB, Linear 30
  days); pictures under the app home's `data/bellwether/pictures/` 7 days.

## Change log

- 2026-11-06: revision 1.
- 2026-11-06: revision 2 after design review.
- 2026-11-06: revision 3 after Codex's plan review.
- 2026-11-06: revision 4 after the user's review of the plan page and the
  browser and design research; each change is in the intent file's
  amendment log. Codex's review of revision 4 added the flip handler in
  `bw-tabs`, the checked SSH forward, the origin-less Linear key, the 2 s
  remote refresh for the selected worktree, and appended Codex
  instructions.
