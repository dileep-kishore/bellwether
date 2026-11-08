# Bellwether phase plan, phases 4b to 7: the user's intent

The interview that settled the revision of phases 5 onward in
`2026-11-06-bellwether-phases.md`. Each answer is the user's selection
verbatim, beside the question and options it answers. Do not edit the quoted
answers; record changes in the amendment log.

## The request, 2026-11-07

From the MacBook thread, verbatim:

> Yes, I guess we did a bunch of things after phase 4, so we should probably
> update the plan for phase 5 and beyond.
>
> Also, I want you to spin up a new T3Code thread on my Mac Mini and
> implement it there, not on the MacBook. The computer use herder app testing
> is distracting me when I'm working on my MacBook, so you can do that on the
> Mac Mini. You can just go ahead and install the herder app there yourself
> and do any actual visual app testing as needed.
>
> Go ahead and start up a new T3Code session with the relevant context,
> prompt, and all the references. In that session, you should update the
> plan, get a tiered review of the plan, and then proceed, similar to how
> we've been doing so far.

Earlier in that session:

> There's a bunch of things, like git diffs and stuff, that haven't been
> implemented

## Interview, 2026-11-07

### 1. How window checks run on the Mac mini

Question: Window testing on the Mac mini (Bellwether, branch t3/f0c1775c).
Herdr 0.1.13 is installed here and the bellwether layout is switched on, but
the Mac mini's screen is locked, so the Herdr window has never drawn a frame
and `herdr-app shot` fails. This session also has no computer-use tools, and
Herdr's guide forbids pointer and key automation on the real display. How
should window checks run here?

Options:

- Unlock, no pointer (Recommended): You unlock the Mac mini once (Screen
  Sharing is enough) and set it not to lock while I work. I drive the window
  with `herdr-app do` and `hc` as on the MacBook; checks that need a real
  click or key stay BLOCKED. Keeps Herdr's no-automation rule.
- Unlock, allow pointer: As above, and you also allow synthetic clicks and
  keys on the Mac mini's display (osascript or cliclick, with Accessibility
  granted). Could settle the 15 BLOCKED MacBook items, but overrides Herdr's
  'never automate the real display' line.
- Stay locked: No window shots at all; every window check in phases 5 to 7
  is recorded as owed. Fastest, but nothing visual gets verified.

Answer:

> Unlock, allow pointer

### 2. Where the unfixed findings go

Question: Where should the plan put the unfixed findings from the MacBook
window runs? (1) Prompt ids depend on the terminal's wrap width, so a rewrap
shows duplicate 'Left the screen' cards and lost the Codex folder-trust card,
which then could not be answered from the chat. (2) The Browser panel's
active-tab fallback was never built, so no tab is marked active while Herdr
is in front. (3) The chat column's 240 px minimum clips bubbles in panes
under 288 px. (4) Claude started from an SSH-started core is not logged in
(keychain), which is Herdr's environment, not Bellwether code.

Options:

- Fix PR first (Recommended): A small 'phase 4 follow-ups' PR before Changes
  fixes 1 to 3 and documents 4 in the README as a known limit. Item 1 is the
  only one that loses an answerable request, and fixing it first lets later
  window runs trust the dock.
- All in phase 7: Build Changes and Issues first; fix 1 to 3 in phase 7's
  finish pass and document 4 there. Features arrive sooner; the dock bug
  stays live meanwhile.
- Only item 1 now: Fix the wrap-width prompt ids before Changes; put the
  Browser fallback and the narrow-pane clipping in phase 7; document 4.

Answer:

> Fix PR first (Recommended)

### 3. Linear test data

Question: Phase 6 (Linear Issues panel) needs linked projects with open
issues for its done check: the list must equal a GraphQL query, Mine and All
must change it, and Attach must reach the right chat. Your Linear workspace
(dkishore-lifecycles) has no Bellwether project; its open projects are
personal and work ones such as CommScores, BERIL, KBase 2.0 and Dating.
Window shots and logs of the check land in docs/drafts (untracked, synced to
your machines). What should the check use?

Options:

- New test project (Recommended): I create a 'Bellwether' project in
  Play/Hobbies/Misc (PLA) with about six scratch issues in mixed states, one
  assigned to you, through the Linear connector. No real issue text lands in
  shots, and you can keep the project for Bellwether work afterwards. This is
  one write to your workspace, at setup only; Bellwether itself still never
  writes to Linear.
- Existing projects, read-only: Link bellwether to dotfiles and the scratch
  repo to CommScores (or two you name), and only read them. No writes, but
  their issue titles and descriptions appear in shots and logs.
- You make the project: You create the test project and issues yourself and
  tell me its name; I only read it. No writes by me, and phase 6's done check
  waits until you do.

Answer:

> New test project (Recommended)

### 4. When the 15 blocked window checks run

Question: With pointer and key input allowed on the Mac mini, the 15 window
checks that were BLOCKED on the MacBook (divider drags, tab drag, + menu
clicks, typing in the composer, dock buttons, threads card toggle, sub-agent
view bar, Arrange cases and others in
docs/drafts/window-check-results/results.md) can now run. They test phase 1
to 4 code. When should they run?

Options:

- In the fix PR (Recommended): Run them during the phase 4 follow-ups PR,
  before Changes, so any bug they find is fixed in the same PR as the other
  phase 1 to 4 findings, and phases 5 and 6 start on verified ground.
- In phase 7: Run them in phase 7's final pass with every other done check.
  Changes and Issues arrive sooner; bugs they find get a late fix PR.
- Skip them: Leave them recorded as BLOCKED; run only phases 5 to 7's own
  window checks.

Answer:

> In the fix PR (Recommended)

### 5. The second machine, after the plan review

Question: The plan review found that `bwloop`, the planned second machine,
can't hold a Herdr space. It is a temporary `hc` machine that connects
through `via`, not SSH. So every window check's remote half has no machine
to run on: a Changes panel for a remote worktree, a Codex chat on another
machine, the browser forward, and remote helper-call counts. The brief says
not to drive the MacBook and not to add machines to any hc core. Which
second machine should the window checks use?

Options:

- Scratch SSH, stage core (Recommended): In the isolated stage window's own
  core (HC_SESSION=bw-stage, not your default core), I add a temporary
  machine reached over a scratch sshd on 127.0.0.1 with its own HOME, the
  way browser.sh already builds one. It gets real spaces and a real SSH
  forward, all on the Mac mini. I remove it, its core and its folders
  afterwards. Relaxes the brief's 'add no machine to any core' only for that
  private core. Claude there runs unlogged (keychain); Codex works.
- Use the macbook machine: Run the remote halves on the existing `macbook`
  machine from the Mac mini's core: scratch repos under /private/tmp there,
  Codex chats there, nothing on its screen, everything removed afterwards.
  A real second machine, but it runs processes on the laptop you're working
  on, and Claude there is unlogged too.
- Remote halves owed: Run remote halves only at the helper level on
  `bwloop` (scripts/verify/*.sh --machine bwloop). Record every
  window-level remote half as owed until tsuki returns or you choose
  otherwise.

Answer:

> Use the macbook machine

## Approval, 2026-11-07

Question: Approve the revised Bellwether plan for phases 4b to 7 (branch
t3/f0c1775c, uncommitted)? The key decisions are: (1) phase 4b fix PR first:
rewrap-proof request cards, the Browser active-tab fallback, narrow chat
panes, the README keychain note, and a rerun of the 21 MacBook FAIL/BLOCKED
window rows; (2) window on the Mac mini, remote halves on `macbook` in
/private/tmp scratch folders; (3) phase 5 Changes via a new `bw diff`
command (helper 0.5.0) and the `bw-diff` panel; (4) phase 6 Issues with the
key in the Mac mini Keychain; (5) phase 7 timings, RECIPE.md and a full
rerun; (6) one PR per phase, which you merge. One item goes beyond your
earlier answer: done check D needs two Linear test projects, 'Bellwether'
(about 6 issues) and 'Bellwether scratch' (3 issues), both in
Play/Hobbies/Misc, so the two linked repositories show different lists.

Options:

- Approve, both projects (Recommended): Approve the plan as written,
  including the second Linear project. Check D can then reject a linker that
  ignores the repository. Both projects are created once at phase 6 setup.
- Approve, one project: Approve the plan, but create only 'Bellwether'.
  Check D then can't tell the two repositories' links apart; I'd record
  that gap in the intent file.
- Change something: Tell me what to change before building; I'll revise the
  plan and its intent record.

Answer:

> Approve, both projects (Recommended)

## Defaults never discussed

- The follow-ups are "phase 4b", so Changes stays phase 5 and Issues phase 6,
  as the spec, the code (`mods/bw-right/choice.js`) and the README number
  them.
- The second machine was first `bwloop`; question 5 replaced it with
  `macbook`. On `macbook` the checks use scratch folders under
  `/private/tmp/`, run nothing on its display, and remove what they made;
  no machine is added to any core. Scripted checks that ran on `bwloop`
  keep that run too.
- The six FAIL items of the MacBook run are rerun with the 15 BLOCKED ones
  in phase 4b (21 in all), since several failed for reasons the Mac mini may
  not share (the MacBook's tiling window manager).
- Pointer and key input uses `cliclick` from Homebrew, or `osascript` System
  Events, after the user grants Accessibility; only on the Herdr window and
  the Bellwether Chrome, never the user's own Chrome. The plan states this
  in "What changed after phase 4".
- A window check that fails because of Bellwether gets at most three fix
  attempts, the bound the user's brief and global instructions set on fix
  loops; one still failing goes to the PR's Found list.
- The Browser panel's header cut to "Run…" at 360 px, found in the same
  MacBook run, is fixed in phase 4b.
- The prompt id joins a line to the next only when it fills the terminal's
  width, and keeps every space; matchers still read the screen as drawn.
- The Issues list reloads every 60 s while shown and on a refresh click.
- "Open in Changes" selects a file only when the line names one file.
- Phase 5 bumps the helper to 0.5.0, protocol 5, so each machine
  reinstalls it.
- Check E counts remote panels' calls in the headless harness, since the
  `BW_HELPER` wrapper sees only the window machine's calls.
- Patches are drawn as rows with old and new line numbers and the palette's
  added and removed tints, without syntax colours: Herdr's `Editor` colours
  one language and has one line-number column.
- The Changes panel refreshes like the project sidebar: `watchFolder` for a
  local worktree, every 1.5 s for a remote one, nothing while hidden.
- "Open in Changes" also selects the file, through `shared("bw.diff.reveal")`.
- The Linear key is entered through T3's secure prompt and stored in the Mac
  mini's Keychain; the MacBook needs `scripts/linear-key.sh` once.
- Done check D links a scratch repository with no `origin` instead of
  `bellwether`, which gained one (GitHub) after the spec was written. A
  second scratch project, `Bellwether scratch`, with three issues, gives
  the second link its own list; the user approved this second write with
  the plan.
- `RECIPE.md` and `preview.png` are written, not published to herdr.dev.

## Amendment log

- 2026-11-07: plan revision for phases 4b to 7 written from this interview.
- 2026-11-07: design review (tier 2: GPT-6.1 Sol 7/10, Grok 4.7 6/10 in
  Gemini 4 Argon's seat after Argon missed its deadline; 12 merged
  findings, 11 confirmed by Claude Opus verifiers, 1 refuted). Fixes:
  - v01: the prompt id keeps spaces and joins only full-width lines; the
    matchers' input stays as drawn; a negative fixture added to check A.
  - v02: check C and spec done check 4 name one reference command per
    comparison mode and an untracked file's patch.
  - v03, v04: the second machine is `macbook` (question 5), since `bwloop`
    has no spaces and no SSH forward; check E counts remote calls in the
    harness with a positive control.
  - v05: the 21-row list is named by its synced path, and check B gains a
    `comm` command that rejects a missing original row.
  - v06: the active-tab fallback keeps Chrome's per-window set while the
    Bellwether Chrome is in front.
  - v07: check F reads the specs' machine names through the substitution
    logged in the design intent file.
  - v08: check A runs named `rewrap` tests and narrows a Claude approval in
    the window.
  - v09: phase 6 creates a second scratch project and check D requires the
    two lists to differ.
  - v10: check E names the inputs and treats 100 ms as the watcher trigger,
    as the spec does.
  - v11: the pointer limits move into the plan.
  - v12 refuted (the plan's "per project" fixes the key); its note added
    `projectKey` and the common dir in `bw diff files`.
- 2026-11-07: phase 4b step 1 builds the prompt id with all whitespace and
  rule glyphs removed. Original (v01 fix): "Keep every space, so two
  commands that differ in spacing keep different ids". Evidence: Codex
  breaks a command inside a word (`tests/fixtures/screens/codex-approval-wrapped.txt`,
  `long-` / `name.txt`), Claude's rules are drawn to the pane's width
  (`tests/fixtures/sessions/claude-approval/screen-approval.txt:18`), and
  the narrow Codex folder prompt drops its descriptions
  (`docs/drafts/window-check-results/p3-codex-folder-prompt-narrow.txt`);
  `same_call` already compares commands by words
  (`crates/bw/src/requests/matchers.rs:184-227`).
- 2026-11-07: phase 4b step 1 hashes a Claude approval's tool and command
  only, matches a Codex question with whitespace dropped, and reads `2.Yes`
  as an option. Original (amendment above): "builds the prompt id with all
  whitespace and rule glyphs removed". Evidence: the window run on the Mac
  mini (`docs/drafts/phase5-onward/done-checks.md`, check A): at 16 columns
  Claude cut option 2's text short and wrapped the question
  (`tests/fixtures/screens/claude-approval-pair-16.txt`), and a chat tab's
  hidden terminal is 15 columns, where Codex breaks "conversation"
  (`tests/fixtures/screens/codex-new-folder-15.txt`); commits `cbbca18`,
  `54819c1`.
- 2026-11-07: phase 4b also fixes four faults its window run found, each a
  Bellwether FAIL under step 5: a background Chrome start gives the front
  back to the app that had it (`5556569`), a long answer button stays inside
  its card (`c13f902`), a wrapped Claude tip stays out of a card's detail
  (`7aea120`). The Browser header's "Run…" cut did not reproduce and was
  left as it is.
- 2026-11-07: build note, not a plan change: a chat tab's terminal keeps
  its split share while the chat is zoomed (15 columns in a 949 px window),
  so a Codex sub-agent's approval, whose options Codex scrolls out of view
  at that width, falls back to "Answer in terminal". Herdr has no command
  to size a pane; the README's Known limits says so.
- 2026-11-07: phase 4b's independent review (tier 2 deep: GPT-6.1 Sol on
  lenses 1, 2 and 5, Gemini 4 Argon on lenses 1 and 3; 9 merged
  findings, Claude Opus verifiers: 7 confirmed, 1 plausible, 1 refuted)
  changed step 1 again: a Claude approval's id hashes its box from the
  header through the question with the tip dropped, and `bw answer`
  refuses a key unless the box still shows the command the card first
  showed (line breaks aside) and, for Always, the same option 2 label.
  Original (amendment above): "hashes a Claude approval's tool and
  command only". Evidence: a different Edit target or asking sub-agent
  shared an id, and a command differing only by a space, or another
  Always scope, got its key at the second read
  (`crates/bw/tests/answer.rs` `second_read_*`). The helper moves to
  0.4.1 so machines with 0.4.0 reinstall the fixes.

- 2026-11-08: phase 5 build notes. `bw diff files --select <section>
  --file <path>` also returns a digest of that file's patch, so the
  panel reloads a patch only when it changed; the plan's "one round
  trip for the three lists" still holds. `bw diff fetch --base <ref>`
  fetches the remote a remote-tracking base belongs to, else `origin`.
  A diff opened as a tab loads once and on its Refresh button and polls
  nothing; the refresh rules name the panel only.
- 2026-11-08: phase 5 leaves out the design spec's "git pages 200 MB"
  cache (Defaults nobody discussed): each page reruns Git, so nothing is
  written on the space's machine. An untracked file over 64 MiB is
  listed without counts instead of being read to count its lines.
- 2026-11-08: phase 5's window run found a hidden Changes panel still
  making two calls after a strip click (the click's re-render came
  before the stack switched); fixed in `fix(bw-diff): stop reading once
  the panel is hidden`. Evidence:
  `docs/drafts/phase5-onward/phase5/window-checks.md` row 4. "Open in
  Changes" in a chat was checked in the harness only; no agent chat ran
  in the window.
- 2026-11-08: phase 5's independent review (tier 2 deep: GPT-6.1 Sol
  7/10 on lenses 1, 2 and 4, Gemini 4 Argon 8/10 on lenses 1 and 5 and
  unscored on lens 3; 15 merged findings, Claude Opus verifiers: 14
  confirmed, 1 refuted) changed two behaviours the plan names. A chat's
  reveal now waits for a fresh list before it selects the file, and
  the base picker keeps a picked ref by its full name
  (`refs/tags/release`), so a branch and a tag with one name stay
  apart. The other fixes keep the plan's wording: file names read as
  literal paths, a 4 MiB budget for the lists, async answers tied to
  their machine, worktree and range, and no queued call while hidden.
  Evidence: `crates/bw/tests/diff.rs` (3 new tests) and
  `tests/mods/bw-diff.test.js` "review fixes" (11 new tests), each
  failing on 837431b.
