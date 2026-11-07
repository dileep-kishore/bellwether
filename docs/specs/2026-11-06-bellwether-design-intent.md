# Bellwether design: the user's intent

The interview that settled the design in
`2026-11-06-bellwether-design.md`. Each answer is the user's selection or
words verbatim, beside the question and options it answers. Do not edit the
quoted answers; record changes in the amendment log.

The scope is the user's request in `docs/brief/2026-11-06-request.md`.

## Interview, 2026-11-06

### 1. Where the chat view sits

Question: Where should an agent's chat view sit in the Bellwether window?
(Herdr can show a mod as the main block, as a split beside the terminal, or
as a side panel like Files/Changes.)

Options:

- Main area, terminal on toggle (Recommended): the chat fills the main area
  like T3 Code; one key or button flips to the live terminal.
- Split beside terminal: chat and live terminal side by side in the same tab.
- Right side panel: terminal stays the main view; chat is a panel on the
  right like Herdr's Files and Changes.

Answer:

> Main area, terminal on toggle (Recommended)

### 2. Answering approvals and questions

Question: When an agent or one of its sub-agents asks for approval or asks
you a question, how should the chat let you answer? (Neither Claude Code nor
Codex writes a pending approval to its log; both offer a PermissionRequest
hook, and Orca already installs one in each.)

Options:

- Answer in chat via keys (Recommended): card with Approve/Deny or the
  question's options; Bellwether re-reads the terminal screen and presses the
  keys only if the same prompt is still showing (Flockbook's method). A small
  hook that only records the request adds which sub-agent asked. The normal
  terminal dialog stays in charge.
- Blocking hook owns the answer: Shepherdr's method, a hook holds the request
  until the user answers in chat, with a timeout.
- Show only, answer in terminal: cards show what is pending and who asked,
  with a button that jumps to the terminal.

Answer:

> Answer in chat via keys (Recommended)

### 3. Which worktrees the project sidebar lists

Question: In the project sidebar, which worktrees should appear under each
project? (Herdr's spaces sidebar today nests only worktrees that already have
a space open, grouped by machine.)

Options:

- All worktrees, open ones live (Recommended): like Orca, every checkout from
  `git worktree list` shows under its project. Ones with a space show agent
  status; others are dimmed and open as a space on click.
- Only worktrees with a space: the sidebar lists only what Herdr has open,
  regrouped under projects.

Answer:

> All worktrees, open ones live (Recommended)

### 4. One repository on two machines

Question: When the same repository is checked out on two machines (say
macbook and macmini), should it be one project or two in the sidebar?

Options:

- One project, machine tag per row (Recommended): projects match by the
  origin remote URL; each worktree row shows its machine.
- Separate per machine: project groups sit under machine headings, as Herdr's
  sidebar does now. Matches by the repo's .git folder on each machine.

Answer:

> Separate per machine

### 5. What "attach to chat" does

Question: What should the "attach to chat" button on a Linear issue do?

Options:

- Chip in composer, sent with message (Recommended): adds an issue chip to
  the chat composer. On send, the issue's ID, title, URL and description go in
  as text ahead of the message. Works with any agent.
- Send to agent at once: pastes the issue text straight into the agent's
  input right away, no composer step.
- ID and link only: sends just `ENG-123 <url>` and lets the agent fetch
  details through its own Linear MCP.

Answer:

> Chip in composer, sent with message (Recommended)

### 6. Which feature is usable first

Question: Which feature should be usable in the window first? (Every phase
starts after the cargo fix and a cloned bellwether layout.)

Options:

- Project sidebar first (Recommended): plain JavaScript on Herdr's built-ins,
  no Rust; it is where the user picks the agent whose chat opens. Chat second.
- Chat view first: the biggest and riskiest part, proven early.
- Diff viewer first: self-contained, a warm-up for the Rust helper.

Answer:

> Project sidebar first (Recommended)

### 7. Mockups, and permission to build

The user's message after the interview, before the plan page existed:

> most importantly show me mockups and alternatives in the html artifact so
> that i can decide how the features would look and you can just go ahead and
> implement it fully after I review it

What it changes: the plan page shows each feature as mockups with
alternatives and a decision form. The user's choices on that page settle the
look. After that review, the build runs all phases without further approval
stops, except for the steps the spec marks as needing the user (the cargo
repair, the hook install diff, the Linear key).

### 8. Browser and computer use

The user's message, after the mockup request:

> also one important issue to address is browser/computer use. I use t3 code
> browser and orca browser a lot while using those apps and this is really
> indispensable. Though claude/codex could use my chrome browser if this is
> absolutely not possible to support

What it changes: a sixth feature, a browser that the user and the agents
share inside the Herdr window, with the user's Chrome as the fallback when an
in-window browser is not possible. The plan page shows the options as
mockups.

## Defaults never discussed

The spec's "Defaults nobody discussed" section lists them; the plan page
shows them with the decisions, agent defaults first, so the user can
overrule any of them there. The ones the reviewers named as most
consequential: Claude Code and Codex only; the whole `herdr-core` vendored;
hooks in the global settings of each machine; a helper built on each
machine; Linear limited to assigned open issues with a personal key; no
staging or commits in the diff viewer; Codex approval cards show-only until
their matcher passes; a separate Chrome profile for the shared browser.

## Amendment log

One line per change to the spec after the interview, with its reason.

- 2026-11-06: added goal 7, the shared browser, with routes A (mirrored
  Chrome tab), B (Kitty-graphics browser) and C (the user's Chrome), chosen by
  a phase 0 spike; request 8.
- 2026-11-06: look choices (sidebar, rows, sub-agents, requests, tool detail,
  diff placement, issue view, browser placement) moved to the plan page's
  mockups; request 7.
- 2026-11-06: phases renumbered: browser spike in phase 0, browser build
  phase 4, diff 5, Linear 6, finish 7; request 8.
- 2026-11-06: `bw send` and `bw answer` carry the expected agent kind,
  session and log path, and an in-process sub-agent's view has no composer;
  design review, P1 confirmed (messages written in a child view reached the
  parent).
- 2026-11-06: Codex `request_user_input_async` answered as one user message
  recorded against its request; design review, P2 confirmed.
- 2026-11-06: Codex root discovery skips sub-agent rollouts and remembers the
  root per terminal; design review, P2 plausible.
- 2026-11-06: request claims keyed by occurrence, not command text; design
  review, P3 confirmed.
- 2026-11-06: answer buttons disabled within 3 s of terminal focus, screen
  re-read after delivery, "uncertain" state, risk 2 rewritten; design
  review, P2 confirmed (`hc keys` holds keys for its quiet rule).
- 2026-11-06: project identity uses `--path-format=absolute`; design review,
  P2 confirmed.
- 2026-11-06: projects remembered in `shared()` with Add and Remove, so they
  survive their last space; design review, P2 confirmed.
- 2026-11-06: a dimmed worktree opens with `space.select` or `space.new`
  instead of the worktree chooser; design review, P3 confirmed.
- 2026-11-06: sidebar picks run `agent.focus`, the chat follows
  `focused().agent`, and the Terminal view is `{ "agent": "focused" }`;
  design review, P2 confirmed (the toggle could show another agent).
- 2026-11-06: patches use `--no-textconv`; design review, P3 confirmed.
- 2026-11-06: hooks appended after existing groups, act only in Herdr
  terminals (`$HC_TERMINAL_ID`), and a "Codex hook not trusted" state;
  design review, P3 confirmed.
- 2026-11-06: one cache root `~/.cache/bellwether/` with a pruning rule per
  folder; design review, P3 confirmed.
- 2026-11-06: nested Claude sub-agents joined by `parentAgentId`; Codex 0.167
  `exec`, `js` and `agent_message` records handled; design review, P3
  confirmed.
- 2026-11-06: `bw send` always runs on the window machine with a
  machine-qualified address and the text as an argument; design review, P3
  plausible.
- 2026-11-06: diff header shows the base's date and a Fetch button; `cmd-j`
  goes in through a `keys.json` merge; the helper is called through `sh -c`
  with `$HOME`; the Linear key is read with `security`; a send refused
  while the agent waits on a prompt has its own state; design review, P3
  plausible.
- 2026-11-06: recorded sessions for tests are made in the isolated test
  window, never copied from real logs; design review, P3 plausible.
- 2026-11-06: borrowed files are recorded in `THIRD_PARTY_NOTICES.md` in the
  commit that copies them, and phase 1 amends the AGENTS.md line about
  watching Git; design review, P3 confirmed.
- 2026-11-06: done check 1 now uses two repositories, a closed project and a
  clicked dimmed row, and absorbs the offline-machine case of the old check
  6. Original: "For a scratch repository with a main checkout, two
  worktrees and one space closed, the sidebar's worktree rows equal `git
  worktree list --porcelain -z`, and each agent row's status equals
  `herdr-app ls` for that terminal." Evidence: design review findings on
  identity, persistence and the worktree click.
- 2026-11-06: done check 2 now checks parent rows, nested sub-agents, Codex
  root resolution, the expect-session refusal and the missing helper.
  Original: "For a recorded Claude session with three sub-agents and a Codex
  session with one, `bw feed` reports exactly those children with their
  types, and each child's rows match a hand-counted expectation. On a real
  session from `~/.claude/projects`, the child count equals `ls
  <session>/subagents/*.jsonl | wc -l`." Evidence: nested sub-agents share
  one flat folder; the parent transcript had no check.
- 2026-11-06: done check 3 now starts Claude with `--permission-mode
  default`, runs a foreground and a background sub-agent, checks the file is
  absent before Approve, the focus guard, and a Codex async question.
  Original: "In the bellwether layout on macbook, a new Claude Code agent in
  a scratch repo starts a sub-agent that runs `touch approved.txt` under
  default permissions. The request card appears under that sub-agent within
  3 s; Approve creates the file. Answering a second prompt in the terminal
  first leaves its card stale, and clicking it presses no key." Evidence:
  the user's settings set `defaultMode: "auto"`, which rarely prompts.
- 2026-11-06: done check 4 references include untracked files and
  `--no-textconv`, plus a textconv marker, a typed ref, tip-to-tip and a
  missing `origin/main`. Original: "the three lists and every patch equal
  `git diff --cached`, `git diff`, and `git diff $(git merge-base
  origin/main HEAD) HEAD`, on this machine and on macmini." Evidence:
  Unstaged includes untracked files; textconv hid real changes.
- 2026-11-06: done check 5 matches the first line `Linear issue
  <identifier>: <title>` and searches the helper's data folder too.
  Original: "A's next user message in its log starts with the issue
  identifier and title". Evidence: the specified text starts with "Linear
  issue".
- 2026-11-06: done check 6 is now the shared browser; the old check 6
  (failure states) is folded into checks 1, 2 and 4. Original: "With the
  helper renamed away, macmini offline, a session with no log yet, and a
  repository with no `origin/main`, each panel shows its named state and the
  Terminal pill still works. `herdr-app status` reports no mod errors."
  Evidence: request 8 needs a check, and the user's instructions allow at
  most six.
- 2026-11-06: route B starts awrit's own Electron with remote debugging,
  because awrit cannot attach to another Chrome; Codex plan review, P1.
- 2026-11-06: agents on macmini reach the window machine's browser through
  an SSH reverse forward kept by `bw browser serve`; done check 6 adds a
  macmini agent; Codex plan review, P2.
- 2026-11-06: inline pictures in the chat (`bw feed --pictures`, `bw
  picture`), needed for route C and screenshots generally; Codex plan
  review, P2 (Flockbook shows only a count).
- 2026-11-06: the sidebar also watches each open worktree's folder, with a
  30 s refresh, so file edits update uncommitted counts; done check 1 adds
  an edit without Git; Codex plan review, P2.
- 2026-11-06: test recordings come from scripted sessions with the real
  agents in a scratch folder, scrubbed by `scripts/verify/scrub-fixture`;
  the isolated window isolates Herdr state only; Codex plan review, P2.
  This replaces revision 2's "made in the isolated test window".
- 2026-11-06: the browser spike keeps a harness and test page, measures over
  50 clicks, and requires typing, scrolling, a resize and an agent-then-user
  click before a route passes; frames use new file names; Codex plan
  review, P2.

## Review of the plan page, 2026-11-06

The user's answers to the plan page's nine questions, verbatim:

> 1. Similar to T3Code, there should be seamless connectivity. I can launch
> agents on any connected device in Herdr natively, as if I'm on that device.
> There shouldn't be any difference, so make sure you implemented it with
> that in mind. I wasn't sure if that was the design you planned based on the
> architecture you showed me.
> 2. For the main window, I like the project sidebar, but I think Linear and
> the Git stuff should be in the right sidebar. For the middle, I was
> thinking we should be able to create multiple tabs, similar to how the
> Herdr desktop has them, so you can open multiple chats in that work tree or
> terminals. That's like this: a plus icon lets you choose chats. Right now,
> let's just support Claude and Codex as two different chat options, and then
> the terminals have three options when you click on the new tab.
> 3. Regarding the sidebar choices, I answered that Linear should be in the
> right sidebar. I think it would also be very helpful if we can associate a
> project in Linear with the repository, so only the issues in that project
> show up by default in Linear instead of showing all the issues across all
> the projects.
> 4. For your question about how much each work tree row shows, I like the
> tree with agent lines option. For the subagents, option B, the threads
> rail, makes the most sense because subagents don't have the same context.
> It would be confusing if we put everything in one place. Again, this can
> show up on the right sidebar or maybe as a floating thing, similar to how
> T3Code has it. We can take a lot of the design ideas from T3Code and Arca.
> We don't have to do things from scratch. Remember that.
> 5. For polishing the UI, please keep that in mind. For where approvals and
> questions wait, I like the dark above the composer option.
> 6. For how much tool detail the transcript shows, honestly, I think grouped
> summary lines are fine. I rarely see the tool details, and you can always
> ask the agent what it did.
> 7. For the diff viewer question, again, a right panel option B is what I
> want to see.
> 8. For the linear issue, it should open in the sidebar, which is option A.
> 9. For the browser, I'm not sure. How the agent interacts with the browser
> might complicate the situation because T3Code and Arca have their own
> skills and MCP for this interaction, and Claude and Codex, by themselves,
> have browser-use abilities. If we create some janky browser, I'm not sure
> if the agent will use it properly, so I don't know if this is really an
> option. Please look into this in detail.
> Based on this, please update the plan and remove all the alternatives. I
> want to see final markups for each of the features, the phases, the
> features and end product, as well as the risks and stuff.

Reading notes, the agent's, not the user's words: "Arca" is Orca; "dark
above the composer" is the "Docked above the composer" option; "markups" is
mockups. The ninth plan-page question (changes outside the repository) got
no answer here, so it stays open.

## Amendment log, revision 4

- 2026-11-06: window has three columns: projects left, tabs middle, a right
  sidebar with Changes, Issues and Browser; review answers 2, 3, 7.
- 2026-11-06: the middle is a tab area with a "+" menu: Claude and Codex
  chats, and Shell, Claude and Codex terminals; a chat tab is the agent's
  terminal plus a chat pane, flipped with `⌘J`; review answer 2. Replaces
  revision 3's single main stack of chat, terminal and diff.
- 2026-11-06: repositories link to a Linear project, which is the default
  issue filter; review answer 3.
- 2026-11-06: sub-agents in a floating threads card in the chat (Orca's crew
  card, T3's lineage list), each opening its own transcript; review answer
  4.
- 2026-11-06: tree rows, docked requests, grouped tool lines, right-panel
  diff, inline issues fixed as the user chose; review answers 4 to 8; all
  alternatives removed from the plan page.
- 2026-11-06: design sizes and shapes taken from T3 Code `006d7e38` and
  Orca `b0cd6d39`; review answer 4 ("take a lot of the design ideas").
- 2026-11-06: seamless machines: the helper and hooks install themselves on
  each machine over Herdr's connection (Flockbook's `remote.rs` approach),
  replacing revision 3's "build on each machine"; review answer 1.
- 2026-11-06: browser redesigned after research: a real Chrome with a
  Bellwether profile shared by the user and agents, Chrome DevTools MCP and
  instructions injected per session by Bellwether, SSH reverse forwards for
  other machines; the in-window mirror and awrit are dropped; review answer
  9. Done check 6 rewritten. Original: "The harness prints frames per
  second and the median click-to-frame milliseconds for routes A and B, and
  the chosen route meets 5 fps and 300 ms. With that route, an agent on this
  Mac and an agent on macmini, each told through Chrome DevTools MCP to
  click a numbered button on the test page, change the page shown in the
  window within 1 s, and the user's next click on the same page is
  acknowledged by the same tab. If route C was chosen, an agent's screenshot
  appears inline in the chat instead." Evidence: T3 Code and Orca rely on
  injected instructions, not on embedding; a mirror gives agents nothing.
- 2026-11-06: done checks 1, 3, 4 and 5 now run on a macmini space too, and
  check 5 tests the linked-project filter; review answers 1 and 3.
- 2026-11-06: phases reordered: foundation, window and sidebar, chat tabs,
  sub-agents and requests, browser, Changes, Issues, finish.
- 2026-11-06: `⌘J` is handled by `bw-tabs` (`bw-tabs.chat-flip`), which is
  always shown, with both pane ids kept per chat tab; Codex review of
  revision 4, P2.
- 2026-11-06: the browser forward uses the machine's SSH target, a free port
  per window and machine, `ExitOnForwardFailure=yes`, and checks loopback
  listening and the browser id before agents get it; `via` machines get a
  named state; Codex review of revision 4, three P2s.
- 2026-11-06: Linear links fall back to `[machine, common dir]` for
  repositories without `origin`; Codex review of revision 4, P2.
- 2026-11-06: the selected worktree on a remote machine refreshes every 2 s;
  done check 1's "within 2 s" now names the selected worktree on either
  machine. Original: "a plain file edit updates its counts within 2 s".
  Evidence: `watchFolder` cannot watch another machine, and remote lists
  refresh every 15 s; Codex review of revision 4, P2.
- 2026-11-06: Codex `developer_instructions` keep the user's existing value
  with Bellwether's text appended; done check 6 adds a sentinel; Codex
  review of revision 4, P2.
- 2026-11-06: Codex's P1 (the plan page still showed alternatives) was read
  from the page before its revision 4 rebuild; the rebuilt page shows only
  the final design.

## Approval to build, 2026-11-06

The user's message after reading the revision 4 plan page, verbatim:

> This looks really good. Can you start the implementation on my Mac Mini?
> You are allowed to use the T3Code Orchestrator to spin up multiple work
> trees in parallel at any point if needed, so you can run tasks in parallel
> when necessary.
>
> Make sure to go through the proper implementation loop we have set up:
> brainstorming, planning, implementation, and independent review with
> Codex. Also put this repository up on GitHub. You can make it public, put
> it under my account, and proceed with all the phases of the plan. Break it
> down into PRs, merge them, and then go to the next phase.
>
> Please also test using the Herdr app as you progress. We can keep the Herdr
> app test for later. For now, just see if there are other sorts of tests
> you can write, and proceed until you finish everything, unless there's a
> blocking issue that you need me to handle.
>
> For cargo, yes, just go ahead and install it. About the MacBook and Mac
> Mini, if you need me to install it, let me know before we start. Also, let
> me know if you need anything else from me before you get started with
> this.

Reading notes, the agent's: "looks really good" approves revision 4,
including the shared Bellwether Chrome; "proceed until you finish
everything" with the cargo approval answers the outside-repository question
for this build; tests that need the Herdr window are deferred, other tests
(unit, fixture, helper, script) run in every phase.
