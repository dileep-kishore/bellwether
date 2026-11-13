# Intent record: Bellwether UI and Cockpit workflow refinement

Companion to `2026-11-13-bellwether-ui-cockpit-refinement.md`. The user's words and the interview
questions, options, and answers are quoted verbatim and never edited. Corrections and review fixes
go in the amendment log.

## The request

> https://github.com/quaresc/cockpit. https://github.com/minchenlee/flockbook. 
> Create a new t3code thread/session running on the macmini to further refine the Bellwether UI based on whatever context we have here.
>
> I still don't like how it looks. I feel like it needs to be refined quite a bit to make it look cleaner and much closer to Flockbook. I also want to implement features from this other new layout mod that I saw, which has really good features. I've linked it at the beginning of this chat. Take a look at that.
>
> You're free to use computer use on the Mac mini to open it up, visually inspect it, and change things. Let me know if that's not available.
>
> I want you to brainstorm while looking at both the cockpit and Flockbook features. Also look at my AI workflows and skills that I generally go through, and brainstorm what features would be useful and how to improve the UI and streamline things. Ask me clarifying questions once you finish your brainstorming. Make sure to use all the members of the council for detailed brainstorming.
>
> At the end, after you ask your questions, I need to see an HTML artifact with alternate markups for various features you envisioned, and then we can proceed from there.

## Interview

1. **Question:** Bellwether currently keeps both the 248 px sidebar and 360 px right column open, leaving 308 px for chat in a 934 px OmniWM half-tile. Which default shell geometry should Bellwether use?
   - Option 1: `(Recommended) Docked 244 px Flockbook-row sidebar (⌘B hides to left-edge peek), frameless central stack, and right inspector closed until requested, because multi-machine project switching stays visible while recovering 382 px of center width.`
   - Option 2: `Flockbook-pure reading shell with both the left sidebar and right inspector hidden by default (left-edge peek and ⌘B open the sidebar).`
   - Option 3: `Cockpit triage board (Needs you, Working, Ready to land) as the default startup screen, opening chat when an agent is selected.`
   **Answer:** "(Recommended) Docked 244 px Flockbook-row sidebar (⌘B hides to left-edge peek), frameless central stack, and right inspector closed until requested, because multi-machine project switching stays visible while recovering 382 px of center width."

2. **Question:** Bellwether's current Catppuccin Mocha mapping has 1.31:1 raised steps and 1.80:1 borders across three simultaneous window tones, compared with Flockbook's single #202020 field and 1.08:1 raised step. How should we handle the palette?
   - Option 1: `(Recommended) Keep Catppuccin Mocha hues with flattened surface steps (Base field, 1.12:1 raised fill, 1.30:1 hairline border, neutral workspace monograms, and Mauve reserved for primary actions), because it stays aligned with zendots while matching Flockbook's low-contrast calm.`
   - Option 2: `Switch the UI chrome and reading field to Flockbook's neutral warm greys (#202020 field, #262626 raised) while keeping Catppuccin Mocha for semantic status dots and terminal ANSI colors.`
   - Option 3: `Offer both Flattened Catppuccin Mocha and Flockbook Neutral Grey as switchable Bellwether themes.`
   **Answer:** "(Recommended) Keep Catppuccin Mocha hues with flattened surface steps (Base field, 1.12:1 raised fill, 1.30:1 hairline border, neutral workspace monograms, and Mauve reserved for primary actions), because it stays aligned with zendots while matching Flockbook's low-contrast calm."

3. **Question:** Chat tabs currently split bw-chat beside the terminal pane and zoom one side, which forces a 30 px pane header above the 36 px chat header and squeezes hidden terminals under 1000 px. How should Chat and Terminal switch?
   - Option 1: `(Recommended) Make Chat a frameless layout-level stack screen and flip ⌘J to a sibling terminal stack screen with hover-only pane headers (plus optional floating terminal peek), because this removes both extra chat headers and eliminates the 15-column narrow-pane squeeze.`
   - Option 2: `Make Chat a frameless stack screen and have ⌘J open Flockbook's 70% centered floating modal terminal over the conversation.`
   - Option 3: `Keep Chat as a zoomed split pane beside its paired terminal inside the tab.`
   **Answer:** "(Recommended) Make Chat a frameless layout-level stack screen and flip ⌘J to a sibling terminal stack screen with hover-only pane headers (plus optional floating terminal peek), because this removes both extra chat headers and eliminates the 15-column narrow-pane squeeze."

4. **Question:** Cockpit offers cross-agent inline answering, GitHub PR/CI/thread enrichment, prompt queuing, diff line comments, and session resume. Which Cockpit capabilities belong in Phase 1?
   - Option 1: `(Recommended) Include the cross-agent Needs-you / Whose-move screen with inline 1-9 answering, cached GitHub PR/CI/thread status (bw pr), per-terminal prompt queue (bw queue), and line-anchored diff comments in bw-diff, because all four ride directly on existing bw primitives.`
   - Option 2: `Start leaner with visual cleanup, the Needs-you inline-answer screen, and cached GitHub PR/CI/thread badges only, deferring prompt queue and diff line comments to Phase 2.`
   - Option 3: `Include the four recommended features plus per-space session resume after Herdr restarts (excluding cross-machine bulk resume over Syncthing).`
   **Answer:** "(Recommended) Include the cross-agent Needs-you / Whose-move screen with inline 1-9 answering, cached GitHub PR/CI/thread status (bw pr), per-terminal prompt queue (bw queue), and line-anchored diff comments in bw-diff, because all four ride directly on existing bw primitives."

5. **Question:** Your daily skills already write house-styled HTML feature pages, show-me-your-work TSV trails, independent-review ledgers, and gated PR workflows (babysit-pr, merge-pr). How should Bellwether's sidecar and PR actions connect to them?
   - Option 1: `(Recommended) Add a read-only Drafts & Audit inspector tab (listing docs/drafts/*.html for bw-browser, decisions.tsv, plan checklists, and independent-review ledger.md) and have PR buttons queue /babysit-pr or /merge-pr to the agent, because this preserves your HTML artifact workflow and merge-pr safety gates.`
   - Option 2: `Build Cockpit's broader native GPUI show renderer (charts, stats tiles, Mermaid diagrams, before/after image compare) inside the right inspector alongside skill-queued PR buttons.`
   - Option 3: `Keep the right inspector to Changes, Issues, and Browser only, surfacing PR/CI/review counts as compact tags above the composer.`
   **Answer:** "(Recommended) Add a read-only Drafts & Audit inspector tab (listing docs/drafts/*.html for bw-browser, decisions.tsv, plan checklists, and independent-review ledger.md) and have PR buttons queue /babysit-pr or /merge-pr to the agent, because this preserves your HTML artifact workflow and merge-pr safety gates."

6. **Question:** When you queue follow-up prompts while an agent is working, how should Bellwether drain the queue?
   - Option 1: `(Recommended) Auto-send the next queued prompt on a clean Stop hook event while holding the queue whenever an approval, question, or error is pending, because follow-ups flow hands-free without answering over a blocker.`
   - Option 2: `Keep queued prompts as editable drafts beside the composer and require an explicit manual click or shortcut to send the next item when the agent goes idle.`
   **Answer:** "(Recommended) Auto-send the next queued prompt on a clean Stop hook event while holding the queue whenever an approval, question, or error is pending, because follow-ups flow hands-free without answering over a blocker."

## Consequential defaults the user never discussed

- The bottom 28 px `status` bar is removed from `layouts/bellwether.json` to match Flockbook's uninterrupted reading column; `mods/bw-status/` stays in the repository with updated palette tokens so `scripts/sync.sh` needs zero edits.
- The `screen` stack also includes a Flockbook-style cross-space `overview` grid (`mods/bw-overview/`) reachable from the top-right tool capsule and `⌘⇧O`, alongside `chat`, `panes`, and `needs`.
- Plain shell tabs and `"New terminal"` agent launches (`bw.tab-view[tabId] = "panes"`) open on `panes`, while `"New chat"` agent tabs open on `chat` unless flipped with `⌘J`.
- While the target agent's live status is `"working"`, pressing `Enter` in `bw-chat`'s composer enqueues the prompt via `bw queue add` (`⇧⌘Enter` forces immediate send).
- Only the top-bar `Needs you` count pill breathes with `loop("opacity")`; individual blocked marks in sidebar rows, tab pills, and chat banners draw as static Peach marks so multiple waiting agents never pulse out of phase across the window.
- `input` border uses Catppuccin `Overlay 1` (`#7f849c`, 3.96:1 on `raised`) while decorative hairline `border` uses `Surface 0` (`#313244`, 1.30:1 on `Base`), so interactive text inputs still pass WCAG 2.2 SC 1.4.11 (3:1) on the flattened palette.
- `bw pr` runs on the window machine (`exec(..., { on: null })`) using local `gh` authentication with a `60 s` cache TTL (`10 s` `gh` timeout), mirroring `bw linear`, so remote SSH spaces never require copying GitHub credentials.
- `bw queue` caps per-terminal queues at `20` items (`64 KiB` per item); `bw queue drain --on-stop` waits up to `BW_QUEUE_SETTLE_MAX_MS` (default 65 s) for sibling `Stop` hooks (such as Hindsight's 60 s hooks) to finish and for Herdr terminal status to leave `working` before sending item 0; each host runs `bw hooks apply` once (and refreshes Codex workspace trust) to register `"Stop"`, while `bw-chat` triggers `bw queue drain` as a lock-serialized fallback on `working -> done|idle` in the meantime.
- `bw-chat` retains an in-memory LRU of up to `24` terminal sessions (never evicting sessions with unsent composer drafts), and `adopt()` migrates pre-upgrade `bw-chat` split panes by closing only the mod pane and preserving the live terminal.
- `bw-diff` adds `Uncommitted`, `Branch`, and `PR` scope pills and keeps draft line comments in per-space memory (`±5` line relocation on patch refresh, preflight verification across all commented files before send).
- `bw drafts` caps directory scans at `200` files, file reads at `512 KiB`, and staged remote HTML copies at `32` LRU entries, discovering external `independent-review` `ledger.md` files via `bw drafts register-ledger` or matching `$TMPDIR/*/ledger.md` without exposing raw review transcripts.
- `bw` protocol increments from `7` (`0.7.0`) to `8` (`0.8.0`) because mods call new `bw pr`, `bw queue`, and `bw drafts` subcommands.
- Keyboard shortcuts in `keys/bellwether.json`: `cmd-b` (`layout.toggle:sidebar`), `cmd-shift-n` (`bw-tabs.needs-toggle`), `cmd-shift-o` (`bw-tabs.overview-toggle`), `cmd-shift-'` (`bw-tabs.terminal-peek`).
- Cockpit session auto-resume (`sessions.json`), Cockpit's `show` GPUI data-viz DSL, and direct `gh pr merge` execution remain out of scope per Answers 4 and 5.

## Amendment log

- 2026-11-13: created from the council brainstorm and six-question clarifying interview.
- 2026-11-13: Tier 2 design review (`Claude Opus 5.5` 6/10, `GPT-6.1 Sol` 7/10; 9 confirmed, 5 plausible, 1 refuted) amended `2026-11-13-bellwether-ui-cockpit-refinement.md` (`F1..F14` + `bw drafts stage --machine`) and added the reviewer-surfaced operational defaults above (composer `Enter` queuing while `working`, queue/cache/LRU caps, `bw-new` `"New terminal"` mode, `bw-diff` scope pills and in-memory draft lifecycle, external `ledger.md` allow-list, and one-time `bw hooks apply` rollout).
