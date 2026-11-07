# Bellwether design

Status: revision 3, for the user's approval, 2026-11-06. Nothing is built.

The user's requests are in `docs/brief/2026-11-06-request.md`. Their answers
to the design interview and their later requests are in
`2026-11-06-bellwether-design-intent.md` beside this file, with an amendment
log of every change made after review. Evidence about the reference projects
is in `docs/research/2026-11-06-reference-survey.md`. Claude and Codex each
wrote an architecture proposal from the same inputs; this design settles
where they differed. A fresh Claude reviewer and a Codex reviewer then
reviewed revision 1; fresh verifiers confirmed 11 of their findings, found 1
plausible and refuted 1, and revision 2 fixes all of them. Codex then
reviewed the phase plan; revision 3 fixes its six findings.

The look of each feature is chosen on the plan page
(`docs/drafts/bellwether-plan/bellwether-plan.html`), where every choice has
mockups and a recommended option. Where this spec says "the user's look
choice", the build follows that page's answers.

## Intent

The user wants a Herdr window that works the way they work with agents: pick
a project, see its worktrees and which agents in them need attention, read
an agent's work as a chat rather than a terminal scroll, answer its
questions and its sub-agents' questions from that chat, review a branch's
changes against `origin/main`, pull a Linear issue into the conversation,
and use a browser that they and the agents share, as T3 Code and Orca allow.
Rust does the parsing and Git work so the window stays fast. Herdr's own
features do everything they already do. After the user reviews the plan
page, the build runs all phases without approval stops.

## Goals

1. A project sidebar: projects, the worktrees of each, and each agent's
   status beside its worktree. Every worktree from `git worktree list` is
   listed; ones without a space are dimmed and open as a space on click.
   Projects are grouped per machine and stay listed after their last space
   closes.
2. A chat view in the main area, built from the agent's session log as
   markdown, with a composer. One key or button flips the main area to that
   agent's live terminal.
3. Sub-agents shown inside the chat, each with its type, description, state
   and pending requests, and its own readable transcript.
4. Approvals and questions, from the agent or any of its sub-agents, shown as
   cards in the chat and answered there, with keys pressed only when the
   same prompt is still showing.
5. A diff viewer with three lists, staged, unstaged and committed since the
   merge base with a base ref, which defaults to `origin/main` and can be any
   ref.
6. A Linear issue list in the sidebar, whose Attach button adds a chip to the
   chat's composer; on Send the issue goes in as text ahead of the message.
7. A browser that the user and the agents share, inside the window when
   Herdr can draw it fast enough, else the user's own Chrome.

## Non-goals

- No phone page, web app, voice, task runner or background service beyond
  the browser server (all in Flockbook or Shepherdr, none in the brief).
- No commit, stage or push actions in the diff viewer. Herdr's `changes`
  panel stays available for committing.
- No Linear writes (status changes, comments).
- No Cursor, Grok, pi or Antigravity support in the first release. The
  vendored parsers keep them, but only Claude Code and Codex are checked.
- No general computer use (driving other desktop apps). Agents keep their
  own tools for that; Bellwether covers the browser.
- No publishing to GitHub or herdr.dev without the user's approval.

## Anti-goals

These would make the work a failure even if every feature exists:

- Bellwether presses a key into a prompt other than the one its card showed,
  or delivers a message to a different agent or conversation than the one
  the chat shows.
- A Linear API key appears in mod code, shared state, `localStorage`, helper
  output, a log, a cache, or the repository.
- The window gets slower: a mod polls Herdr's live data, redraws on a timer,
  or blocks on a slow `exec`.
- A broken helper, an offline machine or a missing log leaves a blank panel
  instead of a named state with the terminal still one key away.
- Private transcripts, issues or browser profiles land in the repository,
  which Syncthing copies with its `.git` to three machines.

## Constraints from Herdr

These come from `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts` (herdr-app
0.1.13, hc 0.1.18) and the repository's `AGENTS.md`.

- Mods are JavaScript drawn by GPUI: no DOM, no web view, no `setTimeout`,
  no Node APIs. `web_view` in `gpui-kit.d.ts` is only an accessibility role.
- `exec` returns once, capped at 30 s and 8 MiB, has no standard input, and
  nothing streams. `readTextFile` caps at 1 MiB. `writeTextFile`,
  `watchFolder` and `pickFolder` work only on the window's machine.
- Mods run on the machine showing the window. Spaces can live on another
  machine; `exec(..., { on: space.machine })` runs there, in that machine's
  home by default.
- `agents()`, `spaces()`, `panes()`, `terminals()` and `focused()` are live;
  mods must not poll them. Animation uses `.frames`, `.spin` and `.loop`,
  never a timer.
- `hc send` and `hc keys` wait until nobody has typed in that terminal for
  about 3 s, then deliver; they take no condition on the screen, and nothing
  cancels a held key (`hc schema`). There is no compare-and-send.
- Herdr replaces its shipped layouts and mods on every start. Bellwether
  works in this repository, names mods `bw-<name>` and the layout
  `bellwether`, and installs with `scripts/sync.sh`.
- A mod cannot import outside its folder. Shared JavaScript lives in
  `shared/` and `sync.sh` copies it in.
- Herdr's shipped mods carry no license file. Bellwether reads them as API
  examples and writes its own code.
- The repository's rule "Work that watches logs or Git runs in a Rust
  helper" exists because `exec` cannot stream. `bw-projects` uses Herdr's
  `watchFolder` and short Git calls, which need no stream; phase 1 amends
  that line of `AGENTS.md` to say so.

## Architecture

```text
window machine (macbook or macmini)                 any machine with spaces
┌──────────────────────────────────────────┐        ┌──────────────────────┐
│ layouts/bellwether.json                  │        │ bw (Rust helper)     │
│  sidebar: bw-projects, bw-linear         │ exec   │  feed / cards / answer│
│  main: stack [bw-chat | agent: focused   │ {on} → │  diff / refs         │
│         | bw-diff]  + bw-browser         │        │ reads ~/.claude,     │
│ bw send, bw linear, bw browser run here  │        │ ~/.codex, git        │
│ Keychain: Linear key, read only by bw    │        │ ~/.cache/bellwether  │
└──────────────────────────────────────────┘        └──────────────────────┘
agent hooks (Claude PermissionRequest/SubagentStart/Stop, Codex the same)
run only inside Herdr terminals ($HC_TERMINAL_ID set), write one JSON file
per event to ~/.cache/bellwether/events/ on the agent's machine, and return
at once, deciding nothing.
```

### Pieces

| Piece | Job | Built from |
|---|---|---|
| `layouts/bellwether.json` | Sidebar, main stack of chat, the focused agent's terminal and (per the user's look choice) the diff, plus the browser. | `layout.clone` of Herdr's `main`, then edited. |
| `mods/bw-projects` | Remembered projects per machine, worktrees, agents and status, sub-agent and request counts. | New code on `spaces()`, `agents()`, `terminals()`, `shared()`; Git facts through `exec`. |
| `mods/bw-chat` | Transcript, sub-agent cards and views, request cards, composer with chips. | Adapted from Flockbook's mod (`chat.js`, `mdblocks.js`, `estimate.js`, `composer.js`, `cards.js`), MIT. |
| `mods/bw-switch` | The main stack's header: Chat, Terminal, Diff and Browser pills. | New, small. |
| `mods/bw-diff` | Staged, unstaged, committed lists, base picker, per-file patch. | New code; row numbering idea from Herdr's `changes`. |
| `mods/bw-linear` | Issue list and detail, Attach button. | New. |
| `mods/bw-browser` | The shared browser view, if route A of the browser section wins. | New. |
| `shared/` | Chat target, helper calls and protocol version, status ranking, project model. | New. |
| `crates/bw` | The one Rust helper binary, `bw <command>`. | Chat modules adapted from `flockbook-modfeed`; Git, Linear and browser new. |
| `crates/vendor/herdr-core` | Flockbook's core crate: log resolver, parsers, question and approval screen matching, hc client. | Vendored whole from Flockbook `c0420c7`, then changed in reviewed steps. |
| `hooks/bw-event` | A shell script both agents' hooks run: writes the event file, prints nothing that decides. | New; the `$HC_TERMINAL_ID` gate follows Shepherdr's `mods/chat/ask-hook.sh:19`. |

### The chat target

The chat target is `{machine, terminal, agent kind, root session id, log
path}` plus, when a sub-agent is open, `{child session id}`.

- Clicking an agent in the sidebar runs `agent.focus {terminal}`; the chat
  shows `focused().agent`. `agent.next` and `agent.prev` therefore move the
  chat too.
- The Terminal side of the main stack is Herdr's `{ "agent": "focused" }`
  block, which shows the same agent full size, including a sub-agent
  terminal that has no pane.
- The chat learns the root session id and log path from `bw feed`. Every
  `bw send` and `bw answer` carries them as `--expect-kind`,
  `--expect-session` and `--expect-path`; the helper refuses with
  "another conversation is in this terminal now; nothing was sent" when they
  no longer match (Flockbook's guard, `flockbook-modfeed/src/cards.rs:310-325`).
- Drafts are kept per root session and survive until a send is confirmed.

### The helper

`bw` is one binary. Each call is one short process that prints JSON Lines
(a header with the protocol version, rows, an end line), as Flockbook does.
State between calls lives in one root, `~/.cache/bellwether/`, on the
machine the helper runs on, with 0700 folders and 0600 files written
atomically:

| Folder | Holds | Pruned |
|---|---|---|
| `feeds/` | per-session cursors and row hashes | sessions untouched for 7 days |
| `roots/` | terminal to root-session associations | when the terminal's process ends |
| `events/` | hook events | after 24 h, and above 2,000 files oldest first |
| `requests/` | request claims and delivery receipts | after 24 h |
| `git/` | diff pages | when their key changes, and above 200 MB |
| `linear/` | issue cache | after 30 days |

Commands:

- `bw feed --terminal <t> [--session <id>] --cursor <c>`: the transcript as
  rows, `unchanged`, or a splice. `--session` picks a sub-agent.
- `bw cards --terminal <t>`: pending approvals and questions for the agent
  and its sub-agents, each with its occurrence id and screen fingerprint.
- `bw answer --terminal <t> --request <id> (--choice <n>... | --text <s>)
  --expect-...`: answers one request (see "Answering").
- `bw send --terminal <machine/t> --text <s> --expect-...`: wraps `hc send`,
  never with `--force`. It always runs on the window's machine with a
  machine-qualified address, so no file has to exist on a remote machine;
  the text travels as an `exec` argument. Results: sent, refused (agent
  waiting on a prompt), refused (another conversation), unconfirmed.
- `bw diff files|patch|refs|fetch --repo <dir> --base <ref>`: Git work.
- `bw linear issues|issue <id>`: GraphQL, window machine only.
- `bw browser serve|input|tabs|open`: the browser server (route A).
- `bw version`: protocol and build, checked by every mod before use.

A long-running watcher for logs and Git is not part of the first release.
Both proposals recommend measuring first: phase 7 adds one only if a `bw
feed` call spends more than 100 ms of CPU per 2 s poll on real logs.

### Remote machines

The helper runs where the logs and repositories are. Each machine that hosts
spaces builds `bw` from the synced source with `scripts/install-helper.sh`,
which installs it to `~/.local/share/bellwether/bin/<version>/bw` and a
`current` link. Mods call it as `exec("sh", ["-c", 'exec
"$HOME/.local/share/bellwether/bin/current/bw" "$@"', "bw", ...args], { on
})`, so the path resolves in that machine's home and every argument stays a
separate word. A mod asks `bw version` first; a missing or older helper
shows "Bellwether helper missing on <machine>" with the install command,
and the terminal and Herdr's own panels keep working. `.stignore` gains
`target` so build output from one machine never syncs to another.

## Features

### Project sidebar (`bw-projects`)

- A project is a Git common directory on one machine, found with `git
  rev-parse --path-format=absolute --git-common-dir` (as Herdr's `spaces`
  mod does at `mods/spaces/main.js:212`), keyed by `[machine, that path]`,
  and named after its main checkout. Machine headings group projects; the
  window's machine comes first.
- Bellwether remembers every project it has seen in `shared("bw.projects")`,
  so a project stays listed after its last space closes. A project menu has
  Remove; the sidebar header has Add project, which uses `pickFolder` on the
  window's machine and a typed path for another machine.
- Under each project: every worktree from `git worktree list --porcelain -z`,
  the main checkout first. A worktree with a space shows its branch, ahead
  and behind, uncommitted line counts, and its agents. A worktree with no
  space is dimmed; clicking it runs `space.select` for a space already
  showing that folder, else `space.new {folder, machine}`, as Herdr's
  `worktree` mod does at `mods/worktree/main.js:201-207`. The project menu
  keeps New worktree and Open worktree through Herdr's `worktree` dialog.
- Each agent shows Herdr's status colour and word, a count of its running
  sub-agents and of pending requests. How much each row shows follows the
  user's look choice (tree with agent lines is recommended).
- Sub-agent terminals come from `terminals()` `parent`; in-process
  sub-agents and requests come from the helper.
- Spaces outside any Git repository sit under "Other" for their machine.
- Lists refresh on `watchFolder` of each local common directory (branches,
  index, new worktrees) and of each open worktree's folder (file edits,
  which change uncommitted counts without touching `.git`), debounced to
  one refresh per second per worktree, plus a 30 s refresh for open
  worktrees, a 60 s timer when a watch is rejected, and a 15 s timer for
  remote machines. Agent status is never polled.
- `setAgentOrder` follows the sidebar's order. Below 160 px the sidebar
  draws a rail of status dots.

### Chat (`bw-chat`)

- Rows: user messages, assistant markdown, tool activity (grouped or one row
  per call, per the user's look choice), sub-agent cards, request cards,
  and status lines. Flockbook's row protocol is kept and gains `child` and
  `request` rows.
- Codex 0.167 records that Flockbook's parser mislabels or drops are
  handled: `custom_tool_call` named `exec` with JavaScript input shows as
  "Ran code" with its first line; `function_call` named `js` likewise;
  `response_item` of type `agent_message` shows as an assistant message.
- Pictures in the log (screenshots an agent took, images the user pasted)
  show inline. `bw feed --pictures` lists them by id; `bw picture` runs on
  the window machine, fetches each one from the agent's machine through `hc
  exec --on`, caps it at 4 MB, and writes it under
  `~/.config/herdr-app/data/bellwether/pictures/` with a unique name, where
  `image()` can draw it. Flockbook's mod only shows a count, and its picture
  extraction lives in the `serve` code Bellwether leaves out, so this is new
  work.
- The composer sends through `bw send` with the full chat target and shows
  each result by name. It never retries by itself.
- `cmd-j` on macOS and `ctrl-shift-j` on Linux flip Chat and Terminal. The
  binding goes into a `layout:bellwether` section of `keys.json` through a
  merge step that shows the diff and changes nothing else in the file.

### Sub-agents

Sources, verified on this machine:

- Claude Code 2.1.309 and later writes every sub-agent of a session, at any
  depth, to one flat folder,
  `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`, with
  `agent-<id>.meta.json` holding `agentType`, `description`, `toolUseId`,
  `spawnDepth`, `finished`, and for depth 2 and deeper `parentAgentId`. The
  parent's tool result carries `agentId`, `status` and `isAsync`.
- Codex 0.167 writes each sub-agent to its own rollout file whose
  `session_meta.payload.source.subagent.thread_spawn` names
  `parent_thread_id`, `depth`, `agent_path` and `agent_nickname`. The parent
  calls `spawn_agent`; `event_msg` items of type `SubAgentActivity` carry
  `agent_thread_id`.
- Flockbook skips every `isSidechain` line
  (`herdr-core/src/conversation/mod.rs:232`), shows an `Agent` call as one
  "Delegated a task" tool row (`:647`), reads only `response_item` records
  from Codex (`:452`), and its Codex resolver ignores `session_meta.source`
  (`resolver.rs:1118-1131`).

Design:

- Root discovery skips any Codex rollout whose `session_meta` names a
  sub-agent source, then applies Flockbook's "exactly one candidate" rule.
  Once found, the root session id is remembered per terminal in `roots/` and
  reused while the terminal's process is the same, so a later child cannot
  make the root ambiguous.
- The helper builds a session tree per agent: Claude children joined by
  `parentAgentId` when present, else by `toolUseId` across the root and all
  sub-agent files; Codex children by `parent_thread_id`; terminal sub-agents
  by `terminals()` `parent`. A child whose parent call is not found yet sits
  under the root until it is.
- The parser runs once per session file, so sidechain lines are parsed in
  their own file and lines from different children never mix.
- A sub-agent shows as the user's look choice says (a card at its start
  point that opens in place is recommended), with type, description, state
  (running, finished, no recent activity) and a pending-request badge.
- In an in-process sub-agent's view the composer is replaced by "Sub-agents
  take no messages. Write to <parent>" with a button that returns to the
  parent; nothing is ever sent from that view. A terminal sub-agent (one
  with its own address) has a normal composer that sends to its own
  terminal.

### Approvals and questions

- The `bw-event` hook writes each `PermissionRequest`, `SubagentStart` and
  `SubagentStop` event (session id, `agent_id` when a sub-agent asked, tool
  use id, tool name, a digest of the tool input) to `events/` and exits 0
  with no output, so the normal dialog appears. It does nothing outside a
  Herdr terminal.
- `scripts/install-hooks.sh [--remove]` shows the exact diff, then appends
  one group per event after the existing ones in `~/.claude/settings.json`
  and `~/.codex/hooks.json`, never reordering or editing Orca's or the
  user's. Codex 0.167 runs a new hook only after the user trusts it in
  Codex's "Hooks need review" screen, once per machine; until then the chat
  shows "Codex hook not trusted on <machine>: open Codex and trust it".
- A request's identity is its occurrence: `{terminal, root session, child
  session or agent id, tool use id or event id}`. Claims are scoped to that
  identity, not to the command text, so two sub-agents asking for the same
  command get separate cards. When the screen cannot tell two pending
  occurrences apart, neither card is answerable from the chat.
- Screen-bound requests (approvals, Claude `AskUserQuestion`, Codex
  `request_user_input` pickers) are answerable only when the helper finds
  the same prompt on the controlling terminal's screen, using Flockbook's
  `approval.rs` and `question/mod.rs` matchers.
- Message-bound requests (Codex `request_user_input_async`, which returns
  `{"accepted": true}` at once and expects the answer as a user message)
  show their options and a text field. Answering sends one user message,
  "Answer to <question title>: <choice or text>", through the `bw send`
  path, and the helper records the answer against that request id. A user
  message typed in the terminal while the question is pending marks it
  "answered in the terminal" only if no Bellwether answer exists.
- Because `hc keys` holds a key until 3 s after the last typing in that
  terminal, and nothing can cancel it, answer buttons stay disabled while
  the controlling terminal has had keyboard focus in this window within the
  last 3 s ("you are typing in the terminal; answer there"). After the keys
  land, `bw answer` reads the screen again; if the prompt it answered is
  still there or a different prompt was showing, the card says
  "uncertain: check the terminal". Typing from another Herdr client or an
  attached `hc` session is not covered; risk 2 says so.
- Codex approvals are new work: Flockbook has no Codex approval matcher.
  Phase 3 captures Codex 0.167's approval screens, including a sub-agent's,
  with the real agents in a scratch folder and adds a matcher with fixtures. Until it
  passes, Codex approval cards are show-only.
- Request states: pending, sending, answered, answered in the terminal,
  declined, stale, uncertain.
- Where the cards wait follows the user's look choice (docked above the
  composer is recommended).

### Diff viewer (`bw-diff`)

- Three lists for the worktree of the focused agent, else of the active
  space's first terminal: Staged (`git diff --cached`), Unstaged (`git diff`
  plus untracked files from `git ls-files --others --exclude-standard`), and
  Committed (`git diff <merge-base> HEAD`, with the merge base of HEAD and
  the base ref). A file changed in both index and worktree appears in both
  lists.
- The base defaults to `origin/main`, else `origin/HEAD`'s target, else the
  picker opens. The picker lists branches, remote branches and tags from
  `git for-each-ref` and accepts a typed ref, checked with `git rev-parse
  --verify --end-of-options <ref>^{commit}`. The choice is kept per project.
- The header shows the base's short hash and commit date, and a Fetch button
  that runs `git fetch` for that remote only when clicked.
- A switch changes Committed from merge base to tip-to-tip (`git diff <base>
  HEAD`).
- `bw diff files` runs status, the three name-status listings and numstat in
  one call, so a remote space costs one round trip. Patches load per file.
  Output is paged under 4 MiB per call; a bigger patch says so and offers the
  terminal. Git runs with `--no-optional-locks -c core.fsmonitor=false -c
  diff.autoRefreshIndex=false` before the subcommand and `--no-ext-diff
  --no-textconv --no-color` after it, as Herdr's `changes` mod does, so a
  refresh never runs a converter or wakes its own folder watch.
- Placement follows the user's look choice: a Diff pill in the main stack
  (recommended) or a right panel. A right panel needs its own button,
  because Herdr's tab bar draws only Files and Changes
  (`mods/tabs/main.js:80-98`); the pill row carries it.
- The Git CLI stays the engine. gix or git2 would need their own parity
  checks and neither proposal found a measured reason for them.

### Linear (`bw-linear`)

- The helper calls Linear's GraphQL API (`https://api.linear.app/graphql`)
  with a personal API key in the `Authorization` header.
- The key lives in the macOS Keychain, read by running `security
  find-generic-password -s bellwether.linear -w` (a system tool, so a
  rebuilt `bw` does not trigger a new Keychain access prompt). On Linux it
  lives in Secret Service through `secret-tool`, else a 0600 file at
  `~/.config/bellwether/linear.key`. Only `bw` reads it; the mod never sees
  it. `scripts/linear-key.sh` stores it without echoing.
- The list shows issues assigned to the user that are not completed or
  canceled, grouped by state, with a search box that searches all issues the
  key can see. Results page 50 at a time. The issue view shows identifier,
  title, state, labels, URL and description as markdown. The dated cache
  keeps the list on screen through network errors, which show as a banner.
  How an issue opens follows the user's look choice (in the sidebar is
  recommended).
- Attach adds a chip to the composer of the chat target at the moment of the
  click. A hover shows the exact text. On Send the text is:

  ```text
  Linear issue ENG-123: <title>
  <url>

  <description>

  ---
  <the user's message>
  ```

  A description over 8 KB asks the user to trim it or send it as a file;
  `hc put` places the file beside the agent's terminal, on its machine, and
  the message names that path.

### Shared browser (`bw-browser`)

Herdr mods cannot embed a web page. Mods can draw PNG and JPEG files from
the app home (`image(path)`, `gpui-kit.d.ts:20290`) and receive pointer
positions (`on_mouse_move`, `gpui-kit.d.ts:722`), and Herdr's terminals draw
Kitty graphics. Three routes, tried in this order:

- A, a mirrored Chrome tab in a mod. `bw browser serve` runs on the window
  machine as a core terminal started with `hc run --keep` and no Herdr
  labels, so it stays out of the tab bar. It launches Chrome with its own
  profile (`~/.local/share/bellwether/chrome`, outside Syncthing) and
  `--remote-debugging-port` bound to 127.0.0.1 (Chrome refuses remote
  debugging on the default profile), runs a CDP screencast, and writes each
  JPEG frame under a new name (`frame-<seq>.jpg`, written then renamed) in
  `~/.config/herdr-app/data/bellwether/browser/`, keeping the last few, with
  a small JSON beside it naming the newest frame, its page size and the last
  input it reflects. `bw-browser` watches that folder and draws the newest
  frame, scaling pointer positions from the mod's size to the page's.
  Clicks, scrolling and typing go back through `bw browser input`, which the
  server turns into CDP input events. The view has an address bar, back,
  forward, reload, the page's tabs, an "open in Chrome" button, and a strip
  that says whether the user or an agent acted last.
- B, a Kitty-graphics browser in a terminal pane: awrit (`chase/awrit`,
  BSD-3-Clause), in a pane opened with `pane.split`. awrit is an Electron app
  with its own browser and cannot attach to another Chrome, so route B
  starts awrit's own Electron with `--remote-debugging-port` on 127.0.0.1
  and agents connect to that; the spike checks that an agent and the pane
  act on the same page (unverified until then).
- C, the user's own Chrome. Agents attach through Chrome DevTools MCP with
  `--autoConnect` (Chrome 144 or later, after the user turns on remote
  debugging at `chrome://inspect/#remote-debugging`) or the Claude in Chrome
  extension. The chat shows the agents' screenshots inline and opens URLs in
  Chrome.

For A and B, agents drive the same browser through Chrome DevTools MCP
(`ChromeDevTools/chrome-devtools-mcp`) with `--browserUrl
http://127.0.0.1:<port>`, added as a user-level MCP server to Claude Code
(`claude mcp add --scope user`) and Codex (`~/.codex/config.toml`). An agent
on another machine reaches the same browser through an SSH reverse forward
that `bw browser serve` keeps open to each machine with spaces (`ssh -N -R
<port>:127.0.0.1:<port> <machine>`), so the port is loopback-only on both
ends.

Phase 0 runs a spike of A and B on this Mac with a kept harness,
`scripts/verify/browser-spike.sh`, and a test page that shows a frame
number and acknowledges each input. It measures frames per second drawn by
Herdr and milliseconds from a click to the first drawn frame that shows its
acknowledgement, over 50 clicks. A route passes at 5 frames a second and a
300 ms median, and only if typing, scrolling, a resize, and an agent's click
followed by the user's click on the same page all work. The build uses the
first route that passes; otherwise it builds C. Placement (beside the chat,
recommended, or as a main-stack view) follows the user's look choice.

Limits: the browser runs on the window machine, so a dev server on macmini
is reached by its Tailscale name or an `ssh -L` forward. The debugging port
gives any local process control of the Bellwether profile, which holds only
logins the user makes there. Frames are a picture: text selection and the
system clipboard inside the page go through "open in Chrome".

## Decisions settled between the two proposals

| Question | Claude | Codex | Settled |
|---|---|---|---|
| Flockbook reuse | Vendor `herdr-core`, adapt chat modules | Same, and keep the whole core first | Vendor the whole core at `c0420c7`; adapt `feed`, `rows`, `cards`, `answered`, `protocol`, `tail`, `locate`, `status` from modfeed; leave `serve`, `phone`, `install`, `remote` out |
| Helper model | One process per poll | Same, watcher only after measuring | One process per poll; watcher only past 100 ms CPU per poll |
| Hooks | Observer hook from the start | Opt-in bridge later, if needed | Observer hook (user chose it in question 2); it never decides |
| Diff semantics | Merge base for Committed | Merge base default, tip-to-tip option, index-based staged and unstaged | Codex's version |
| Helper on other machines | Build from synced source | Versioned binary per target with a version check | Build per machine, version check before use |
| Project identity | Remote URL across machines | Common dir per machine | Common dir per machine (user chose it in question 4) |
| Override file | Not needed | `projects.json` for names, order, joins | Remembered projects, order and hiding in `shared()`; no joins |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | Not considered | Honor them | Honor them |

## Phases

Each phase ends with something usable in the window, `scripts/sync.sh`,
`scripts/check.sh`, a screenshot, and its done checks. Each borrowed file is
recorded in `THIRD_PARTY_NOTICES.md` in the commit that copies it.

0. Setup and browser spike: repair cargo, add `target` to `.stignore`, clone
   `main` to `bellwether`, the isolated test window (herdr-t3's
   `scripts/demo/stage.sh`), the empty `bw` crate with `bw version`, and the
   browser spike of routes A and B. Usable: the bellwether layout.
1. Project sidebar (the user's choice, question 6: no Rust needed, and it is
   where the chat's agent gets picked). Usable: projects, worktrees, status.
2. Chat for one agent: vendored core, root discovery fix, `bw feed`, `bw
   send`, the main-stack switch. Usable: read and talk to a Claude or Codex
   agent as a chat.
3. Sub-agents and requests: session tree, sub-agent views, `bw-event`
   hooks, request cards, Codex approval matcher. Usable: the full chat the
   brief asks for.
4. Shared browser, by the route the spike chose. Usable: a browser the user
   and the agents share.
5. Diff viewer. Usable: review a branch against `origin/main` or any ref.
6. Linear and Attach. Usable: issues in the sidebar, attached to a chat.
7. Measure and finish: CPU and latency on real logs and repositories, the
   watcher only if past the threshold, `RECIPE.md`, final review.

## Done checks

Each check has an observable result and the command that shows it. Commands
under `scripts/verify/` are written in the phase they belong to. Recorded
sessions come from scripted prompts run with the real `claude` and `codex`
in a scratch folder (the isolated test window isolates Herdr's state, not
the agents' logins). Before a recording enters the repository,
`scripts/verify/scrub-fixture` keeps only the fields the parsers read,
replaces text with the scripted text, and fails if a home path, an email
address or a token-like string remains.

1. Sidebar matches Git (property and degenerate input, phase 1). With two
   unrelated scratch repositories, one of them with a main checkout and two
   worktrees, spaces open on a linked worktree of each and every space of
   the second repository then closed: the sidebar lists both projects, its
   worktree rows equal `git worktree list --porcelain -z` for each, each
   agent row's status equals `herdr-app ls`, and clicking a dimmed row
   opens exactly that worktree as a space. Editing a tracked file with a
   text editor (no Git command) updates that worktree's uncommitted count
   within 2 s. With macmini unreachable, its heading says so and this
   machine's rows still work.
   Command: `bun test shared/`, `scripts/verify/projects.sh`, `herdr-app
   ls`, `herdr-app shot`.
2. Transcripts and session trees (known answer and real input, phases 2 and
   3). For a recorded Claude 2.1.319 session with three direct sub-agents
   and one nested sub-agent, and a recorded Codex 0.167 session with one
   sub-agent, `bw feed` gives the hand-counted rows for the parent (user
   messages, assistant messages, tool groups) and for each child, and a tree
   whose direct children and descendants match the recordings. A Codex root
   resolves while its child's rollout exists in the same folder. On a real
   session the descendant count equals `ls <session>/subagents/*.jsonl | wc
   -l`. A send whose `--expect-session` names an earlier conversation is
   refused and nothing reaches the terminal. With the helper renamed away,
   the chat names the missing helper.
   Command: `cargo test -p bw --locked`, `scripts/verify/sessions.sh
   <session.jsonl>`.
3. Requests answered from the chat (real client from empty state, phase 3).
   In the bellwether layout on macbook, a new `claude --permission-mode
   default` agent in a scratch repo starts a foreground sub-agent and then a
   background sub-agent, each running `touch <name>.txt`. Each request's
   card appears under its own sub-agent within 3 s; `test ! -f <name>.txt`
   holds before Approve and `test -f` after. A second prompt answered in the
   terminal first leaves its card stale and pressing it sends no key; with
   the terminal focused in the last 3 s the buttons are disabled. A Codex
   agent asked to use `request_user_input_async` gets a card whose answer
   arrives as one user message in its log.
   Command: `test -f`, `jq . ~/.cache/bellwether/requests/*`, `hc read
   <t>` before and after, `herdr-app shot`.
4. Diff equals Git (reference comparison, phase 5). For a scratch repository
   with staged and unstaged edits to one file, an untracked file, a rename, a
   binary file, a file mapped to a `textconv` driver whose command writes a
   marker, and two commits past `origin/main`: the Staged, Unstaged and
   Committed lists and every patch equal `git diff --cached
   --no-textconv`, `git diff --no-textconv` plus `git ls-files --others
   --exclude-standard`, and `git diff --no-textconv $(git merge-base
   origin/main HEAD) HEAD`; the marker file is never written; a typed ref and
   the tip-to-tip switch give the matching `git diff`; with no `origin/main`
   the picker opens. The same holds on macmini.
   Command: `scripts/verify/git.sh`, `scripts/verify/git.sh --on macmini`.
5. Attach reaches the right chat and the key stays put (phase 6). With chats
   A and B open, A the chat target and B's terminal focused afterwards,
   Attach an issue and Send in A. The first line of A's next user message in
   its log is `Linear issue <identifier>: <title>`; B's log is unchanged. A
   search for the key's first 12 characters finds nothing.
   Command: `scripts/verify/sessions.sh` on both logs, then `rg -F
   "$(security find-generic-password -s bellwether.linear -w | cut -c1-12)"
   ~/.config/herdr-app ~/.cache/bellwether ~/.local/share/bellwether .`
   returns no match (the key never printed).
6. Shared browser (measurement and real client, phases 0 and 4). The
   harness prints frames per second and the median click-to-frame
   milliseconds for routes A and B, and the chosen route meets 5 fps and
   300 ms. With that route, an agent on this Mac and an agent on macmini,
   each told through Chrome DevTools MCP to click a numbered button on the
   test page, change the page shown in the window within 1 s, and the
   user's next click on the same page is acknowledged by the same tab. If
   route C was chosen, an agent's screenshot appears inline in the chat
   instead.
   Command: `scripts/verify/browser-spike.sh` (prints fps and ms),
   `herdr-app shot` before and after.

## Risks

1. Agent updates change prompt screens and log records. The matchers
   compare against captured screens (Flockbook's pinned Claude 2.1.296 and
   Codex 0.162); Codex 0.167 already adds `exec` JavaScript calls and
   `agent_message`. Fixtures carry the agent version, the helper tolerates
   unknown records, and an unmatched prompt falls back to the terminal.
2. Herdr has no compare-and-send, and `hc keys` holds a key for about 3 s
   after the last typing in that terminal. Disabling buttons while the
   terminal was recently focused here closes the gap for this window;
   typing from another Herdr client or an `hc attach` session can still
   move a held key onto a new prompt. The card then says "uncertain". A
   strict guarantee needs a conditional key request in herdr-core, which
   the build files as a feature request.
3. Claude shows sub-agent prompts on the parent's screen. Two sub-agents
   asking at once queue in the parent's dialog; only the one on screen is
   answerable, the others wait their turn.
4. Where a Codex sub-agent's approval appears, and whether Codex's
   `PermissionRequest` hook input names the sub-agent, is unverified: the
   local Codex logs hold no approval at all. Phase 3 starts with that
   experiment; until it passes, Codex sub-agent requests are show-only.
5. The user's Claude settings use `defaultMode: "auto"`, so most actions are
   screened by Claude's reviewer model and never prompt. Request cards
   appear only for what still prompts; done check 3 runs in default mode
   for that reason.
6. Hook files outside the repository: installing into
   `~/.claude/settings.json` and `~/.codex/hooks.json` must leave Orca's
   hooks and the user's own untouched, and Codex needs a trust step per
   machine.
7. The browser routes are unmeasured. If Herdr redraws frames too slowly,
   the shared browser falls back to the user's Chrome outside the window.
8. Vendored code drifts from Flockbook. `crates/vendor/herdr-core/UPSTREAM`
   records the commit; a script diffs against upstream before each update.

## Defaults nobody discussed

The plan's own calls, listed on the plan page for the user to check:

- Rust crates live in `crates/`, with a Cargo workspace at the repository
  root; the whole `herdr-core` crate is vendored.
- The first release supports Claude Code and Codex only.
- Each machine with spaces builds its own helper; Rust is needed there.
- The hooks go into the global Claude and Codex settings on each machine and
  act only inside Herdr terminals.
- A watcher is added only past 100 ms CPU per poll.
- Remote project lists refresh every 15 s.
- An opened sub-agent replaces the chat view, with a back link (if the user
  picks that look).
- Projects are named after their main checkout; non-Git spaces go under
  "Other".
- The diff viewer never stages, commits or pushes; it fetches only when the
  Fetch button is clicked.
- Linear shows issues assigned to the user, not done or canceled; search
  covers all; a personal API key, not OAuth; no Linear writes; Linux key in
  Secret Service, else a 0600 file.
- The Attach text format, and the 8 KB limit for descriptions.
- The composer never retries and never uses `--force`.
- Codex approval cards stay show-only until their matcher passes.
- `cmd-j` flips chat and terminal, through a `layout:bellwether` section of
  `keys.json`.
- Cache retention as in the helper table.
- The browser uses its own Chrome profile.

## Change log

- 2026-11-06: revision 1.
- 2026-11-06: revision 2 after design review; each change is one line in
  the intent file's amendment log. Added the shared browser (request 8) and
  the look choices (request 7).
- 2026-11-06: revision 3 after Codex's plan review: awrit's own Electron for
  route B, SSH reverse forward for remote agents, inline pictures, worktree
  folder watches, scrubbed scripted recordings, a kept browser-spike
  harness.
