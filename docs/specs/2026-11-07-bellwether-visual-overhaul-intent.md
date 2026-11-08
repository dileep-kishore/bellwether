# Intent record: Bellwether visual overhaul

Companion to `2026-11-07-bellwether-visual-overhaul.md`. The user's words are quoted verbatim and
never edited. Corrections go in the amendment log.

## The request

> After all this, I want you to use the frontend design skill and other design skills in general to
> completely overhaul and beautify the UI.
>
> First and foremost, I want you to use the Catpuchin theme throughout all the components and make
> sure the whole interface is more fun and animated, similar to how it looks with the flock book mod
> or the layout that looked really good.
>
> Please do this visual overhaul after finishing all of whatever you're doing. You can consult with
> Argon as needed for reviews of the design and visuals.

## Interview

1. **Question:** Which Catppuccin flavor should it use? Herdr can switch a layout's theme with the
   system's light/dark mode, so one option covers both.
   Options: Latte + Mocha (recommended: follows macOS) · Mocha only · Macchiato or Frappé only ·
   Skip questions, just start.
   **Answer:** "Mocha only"

2. **Question:** How lively should Bellwether feel? Herdr animates natively (frame sequences,
   spinning icons, looping opacity or size, transitions).
   Options: Lively, purposeful (recommended: motion tied to state) · Playful with a mascot ·
   Calm, Flockbook-like.
   **Answer:** "Lively, purposeful (Recommended)"

3. **Question:** Should the overhaul only restyle Bellwether's existing pieces, or also borrow
   Flockbook's shapes? The three-column layout, sizes and behaviour stay unless the last option.
   Options: Restyle plus Flockbook shapes (recommended) · Restyle only · Free redesign.
   **Answer:** "Restyle plus Flockbook shapes (Recommended)"

4. **Question:** The layout also shows two Herdr-shipped pieces: the status bar (workspace-status)
   and the pane frames and headers. Restyling their shapes or adding motion means cloning them into
   bw-* mods. What should happen to them?
   Options: Theme only, no clones (recommended: Herdr updates keep working) · Clone the status bar ·
   Clone both.
   **Answer:** "Clone both"

5. **Question:** The overhaul touches the same mods PR #9 fixes, and PR #9 is open. Where should
   the overhaul go?
   Options: Stacked PR on PR #9 (recommended) · Add to PR #9 · Wait for PR #9 to merge.
   **Answer:** "Stacked PR on PR #9 (Recommended)"

6. **Question:** Which Mocha colour should lead: selection, focus rings, the active tab and primary
   buttons? Agent status keeps its own colours.
   Options: Mauve #cba6f7 (recommended) · Lavender #b4befe · Pink #f5c2e7 · Peach #fab387.
   **Answer:** "Mauve #cba6f7 (Recommended)"

7. **Playback** of the design (scope, look, motion, how it's built, process), ending "What's wrong
   or missing in that picture?"
   **Answer:** "go ahead and implement this with regular tiered independent review"

## Consequential defaults the user never discussed

- "Clone both" is built as two new mods written for Bellwether (`bw-status`, `bw-pane`) that match
  the shipped mods' content and actions, not copies of Herdr's code, because Herdr's licence for its
  shipped mods is not established.
- The theme is a layout-owned file `themes/bellwether.json`, and `scripts/sync.sh` (a human-review
  path) gains one copy rule for it.
- Status colours: working Blue, done Green, blocked Peach, idle Overlay 0.
- Herdr's `workspace-chrome` sidebar footer (Settings, Add machine) is not rebuilt; it takes the theme.
- Tab bar height stays 32 px; the Flockbook capsule fits inside it rather than growing to 38 px.
- No mascot, no Overview or Needs-you screens.
- "Regular tiered independent review" is read as: the independent-review skill's normal tier
  selection for the design review (tier 2: Sol and Argon) and the final code review, plus Argon for
  the visual review of window shots, as the original request allowed.
- "Similar to ... the layout that looked really good" was not identified further; Flockbook's
  previews are the reference.

## Amendment log

- 2026-11-07: created.
- 2026-11-07: design review (GPT-6.1 Sol and Gemini 4 Argon, tier 2; 13 merged findings, each
  verified by a fresh Claude verifier: 9 confirmed, 4 refuted). Spec changes are listed in the
  spec's amendment log. Two touch the user's answers:
  - Answer 6 ("Mauve #cba6f7 (Recommended)") named selection: terminal selection now uses a 25 %
    Mauve tint (`#494060`) rather than plain Mauve, because Text on plain Mauve is 1.4:1; the
    active tab keeps Text with a Mauve marker, because Mauve text on Surface 1 is 4.49:1, under AA.
  - Answer 2 ("Lively, purposeful (Recommended)"): appear animations depend on a mechanism the
    builder proves in the window first; an element whose fade Herdr cannot run appears without
    motion and the result is recorded.
- New undiscussed default: `shared/helper.js` honours a `BW_HELPER` variable (unset keeps the
  installed helper) so the stage can count helper calls without touching the user's install.
