# Bellwether visual overhaul: Catppuccin Mocha, Flockbook shapes, purposeful motion

Status: approved to build (2026-11-07). Intent record: `2026-11-07-bellwether-visual-overhaul-intent.md`.

## Why

Bellwether works (phases 0 to 4, window-checked in PR #9), but it draws with Herdr's default
graphite palette and mostly static, square-ish components. The user wants the whole interface
"completely overhauled and beautified": Catppuccin throughout, "more fun and animated", "similar to
how it looks with the flock book mod". Flockbook's look (its `herdr-app/preview*.png` and RECIPE)
is a calm, rounded reading UI: a floating capsule tab bar, pill status marks, rounded tool-call chips,
monogram tiles, soft cards and bubbles.

## Goals

1. Catppuccin **Mocha** everywhere the Bellwether layout shows: terminals (16 ANSI colours, cursor,
   selection), every `bw-*` mod, and the two Herdr pieces this layout shows, rebuilt as Bellwether mods.
   Always dark; it does not follow the system appearance.
2. **Mauve `#cba6f7`** is the accent: selection, focus rings, the active tab, primary buttons, links.
3. Components take **Flockbook-like shapes** while the three-column layout, sizes and behaviour stay.
4. **Lively, purposeful motion**: motion follows state (working, blocked, done, appearing,
   hovering), drawn with Herdr's native animation only.

## Non-goals

- No layout changes: column sizes (248 / 360 px, 32 px tab bar, 36 px right strip), positions and
  every behaviour checked in PR #9 stay. Heights may change by at most what a shape needs (for
  example the tab bar stays 32 px; the capsule fits inside it).
- No light theme, no other Catppuccin flavour, no theme picker work.
- No new features (no Overview screen, no Needs-you screen, no mascot).
- No changes to the Rust helper `bw` beyond what a mod needs to draw (expected: none).

## Anti-goals (a failure even if it technically works)

- Motion that never stops while nothing changes: an idle window must be still. Only working,
  blocked and transient (appearing, hovering) elements move.
- Animation driven by `cx.timer` or a render loop (Herdr's rule: every redraw redraws the whole
  window). Use `.frames`, `.spin`, `.loop`, `.transition`, `.spring` only.
- Colour literals scattered through mods. One palette module owns every Mocha hex value.
- A blocked agent that is hard to spot, or text below WCAG AA contrast.
- Breaking a PR #9 window check (hidden-chat poll 10 s / shown 2 s, focus guard 3 s, threads card
  at the timeline's top right, props via `props()`).

## Constraints

- Herdr 0.1.13 rules: `~/.config/herdr-app/AGENTS.md` and its `herdr.d.ts`, `gpui-kit.d.ts`
  (copies in `types/herdr/`). Motion API: `frames(list, ms)`, `spin(ms)`,
  `loop(property, {from, to, period, easing})`, `transition(property, ms | {duration, delay,
  easing})`, `spring(property, policy)`; properties are `opacity`, `width`, `height`, `left`, `top`.
  They run natively and only while drawn. There is no colour or scale animation: pulse with opacity
  or size, change colour by swapping the element's colour on a state change.
- A mod cannot import outside its folder; shared code lives in `shared/` and `scripts/sync.sh`
  copies it (each mod's `.shared` list). `scripts/check.sh` fails when a copy differs.
- Project rules in `AGENTS.md` and `REVIEW.md` hold (bw-* names, no live-data polling, no edits to
  Herdr's files in `~/.config/herdr-app`, `scripts/sync.sh` and `scripts/check.sh` pass, then look
  at the window).
- Herdr's code is not copied: Herdr's licence for its shipped mods is not established here.

## Decided by the user

| Topic | Decision |
|---|---|
| Flavour | Catppuccin Mocha only |
| Motion | Lively, purposeful: motion tied to state |
| Structure | Restyle plus Flockbook shapes; layout and behaviour unchanged |
| Herdr pieces | Rebuild both the status bar and the pane header as Bellwether mods |
| Branch | A stacked PR on PR #9 (`chore/run-herdr-window-checks`) |
| Accent | Mauve `#cba6f7` |
| Reviews | Regular tiered independent review; Gemini 4 Argon for design and visual reviews |

## Design

### Palette and theme

- `themes/bellwether.json`: Herdr theme file named after the layout (Herdr offers it only in this
  layout). Catppuccin Mocha: `background` Base `#1e1e2e`, `foreground` Text `#cdd6f4`, `cursor`
  Rosewater `#f5e0dc`, `selection` a 25 % Mauve tint over Base, `#494060` (Text on it 6.6:1), so
  terminal selection follows the Mauve accent and stays readable; `ansi` the published Catppuccin
  Mocha terminal colours, copied from a published port (the Ghostty or Warp Mocha theme on this Mac
  are two such ports; the builder records which, including its bright 9 to 14 values, and does not
  reuse the normal colours for the bright slots unless the port does); and `colors` naming
  Herdr's panel roles:

  | Role | Colour | Why |
  |---|---|---|
  | canvas | Crust `#11111b` | behind cards |
  | chrome | Mantle `#181825` | sidebars, bars |
  | surface, background | Base `#1e1e2e` | panes, terminals |
  | popover | Mantle | menus and dialogs |
  | raised | Surface 0 `#313244` | cards, chips, bubbles |
  | border, input | Surface 1 `#45475a` | visible on Base, Mantle and Surface 0 |
  | hover | Text at 8 % alpha, `#cdd6f414` | translucent, so a hover shows on every fill (Herdr's own `terminals` layout uses a translucent hover) |
  | selected | Surface 1 | selected rows, the active tab, carrying a Mauve marker |
  | foreground | Text `#cdd6f4` | body text |
  | muted | Subtext 0 `#a6adc8` | secondary text on Crust, Mantle, Base and Surface 0 (5.6:1 or more) |
  | dim | Overlay 2 `#9399b2` | icons, marks and separators only, never text (3.2:1 on Surface 1) |
  | accent, solid | Mauve `#cba6f7` | |
  | accent_foreground, solid_foreground | Crust | text on Mauve (9.2:1) |
  | working | Blue `#89b4fa` | |
  | done | Green `#a6e3a1` | |
  | blocked | Peach `#fab387` | |
  | idle, unknown | Overlay 2 | 3:1 or more on every fill a mark sits on |

  The builder confirms each role name against `theme()` and records any role Herdr does not take,
  and confirms an `#rrggbbaa` value is accepted for `hover`.
- Text colour rules, because these pairs fail WCAG AA (4.5:1): secondary text on Surface 1 or on a
  hovered Surface 0 fill uses Subtext 1 `#bac2de`, not Subtext 0 (4.1:1); no text uses `dim`, so
  every current text use of `t.dim` moves to `muted` (or Subtext 1 on Surface 1); Mauve is never a
  text colour on Surface 1 (4.49:1), so the active tab's label is Text with a Mauve indicator.
  Disabled controls are exempt from contrast under WCAG but must look different from enabled ones.
- The layout root sets `"theme": "bellwether"`. `scripts/sync.sh` copies `themes/bellwether.json`
  (it writes only `layouts/bellwether.*`, `mods/bw-*/` and now `themes/bellwether.json`).
- `shared/palette.js`: the Mocha palette by Catppuccin name (all 26 colours) and the role map above,
  the only file with colour literals. Mods keep drawing with `theme()` roles where a role exists and
  use the palette for accents Herdr has no role for (for example a monogram tile's hue per project).

### Shared components (`shared/ui.js`)

One implementation each, used by every mod:

- **Status mark**: working = a Blue ring arc that spins (`spin`, about 900 ms); blocked = a Peach
  dot or question mark that breathes (`loop` opacity 0.6 to 1, about 1400 ms, so its dimmest frame
  still keeps 3:1 against its fill); done = a Green check that fades in (see How appear motion
  works); idle = a still Overlay 2 ring. Same mark in the sidebar, tab capsule, threads card, pane
  header, status bar and chat.
- **Pill**: fully rounded label (11 to 12 px text) for counts and badges: request badge (Peach on
  Crust text), `+N` sub-agents (Surface 1), machine tag (Surface 0, Subtext 0 text).
- **Chip**: 28 px fully rounded control with an icon and label, Surface 0 fill, the hover role on
  hover, for tool-call lines, the changed-files line and small actions. Inside `bw-chat`'s virtual
  list a chip's hover is a plain `.hover((s) => s.bg(...))` style, because handlers such as
  `on_hover` throw inside a virtual list's renderer.
- **Monogram tile**: 20 to 22 px rounded square with one or two letters; its hue is chosen from
  Catppuccin's accents by a stable hash of the project key, text in Crust.
- **Card**: Surface 0 or Mantle fill, 10 to 12 px corners, 1 px Surface 1 border, a soft shadow;
  rows inside it highlight with the hover role and the current row with Surface 1 plus a Mauve
  marker, so hover and selection both show on a Surface 0 card. Appears as described below.
- **Button**: primary (Mauve fill, Crust text), secondary (Surface 0 fill, Text), ghost (no fill,
  Subtext 0, the hover role on hover); disabled is a Surface 0 fill with Overlay 2 text and no hover,
  visibly different from enabled, as the focus guard needs.

### Per piece

- **Layout** (`layouts/bellwether.json`): root theme `bellwether`; pane frames 12 px radius, 8 px gap,
  Surface 1 border, Mauve focus border; headers use `bw-pane` and the status bar `bw-status`
  (below). Sizes unchanged. A new preview, `layouts/bellwether.svg`, drawn in Mocha, with root
  `"preview": "layouts/bellwether.svg"` (none exists today). `tests/layout.test.js` pins the old
  values (`radius: 10`, `pane`, `workspace-status`) and is updated with the layout.
- **bw-projects**: Mantle background; machine headings as small caps Subtext 0 with a status pill
  (offline, setting up) instead of plain text; project rows with a monogram tile; worktree rows with
  the branch glyph, ahead/behind in Green/Red, `+N −M` as Green/Red text; agent lines with the shared
  status mark, `+N` and request pills; the selected row a Surface 1 rounded fill with a 2 px Mauve
  bar; rows highlight on hover (an `on_hover`-driven fill that stays mounted, see How appear motion
  works). Empty state with a friendly line and a
  Mauve "Add project" ghost button.
- **bw-tabs**: the tab bar becomes a floating rounded capsule (Flockbook) centred or left-aligned
  in the 32 px bar: Mantle fill, 1 px Surface 1 border; each tab a pill with the shared status mark
  and label; the active tab Surface 1 with Text and a Mauve underline or dot (Mauve text on Surface 1
  fails AA); the "+" a round ghost button.
  Drag reorder keeps working and shows the Mauve insertion line.
- **bw-new, bw-menu, bw-add**: popover cards (Mantle, 12 px corners); rows with icon tiles; section
  headings in Subtext 0; "Preparing browser…" with a spinning Mauve ring; buttons as above. Their
  `openOverlay` calls (`mods/bw-tabs/main.js`, `mods/bw-projects/actions.js`) pass `frame: "none"`
  and the mod draws its own card, so the whole card can fade in rather than only its contents.
- **bw-right**: the strip as a segmented pill control (Surface 0 track, Surface 1 selected
  segment with Text and a Mauve dot or underline); placeholders get an icon and a soft line of text.
- **bw-browser**: header with a Mauve state pill ("Running · N tabs"; Peach for port taken, Red for
  failed); tab rows as cards on hover; the active tab a Mauve bar; favicons in 20 px rounded frames;
  forwards as rows with state pills; Arrange result as a toast-like pill.
- **bw-chat**: Flockbook's reading column (max about 760 px, centred); user bubbles Surface 0 with
  16 px corners; assistant Markdown in Text; tool lines as chips with a status mark (spins while a
  call runs, check or cross after); the changed-files line as a chip with a Mauve "Open in Changes",
  whose click stores Changes as the space's right-panel choice (`bw.right.tab`, through the same
  `choose()` the strip uses) as well as selecting it, because today it runs only `layout.select`
  and `bw-right` restores a stored Browser or Issues choice on its next render (reproduced in the
  harness during the design review; a regression test starts with Browser stored);
  pictures in 10 px rounded frames; the composer a rounded card (Mantle, Surface 0 border, Mauve focus
  border, round Mauve send button); the threads card and pill in the card style; the dock's cards
  with a coloured header icon (Peach for approval, Blue for question) and the shared buttons; the
  "waiting" line with a breathing Peach mark; resolved cards fade.
- **bw-status** (new, replaces `workspace-status` in the layout): written for Bellwether, matching
  the shipped mod's content (machine, branch, agent count, needs-you count, palette hint), drawn
  with pills and the shared status mark; the needs-you pill breathes in Peach while any agent waits.
- **bw-pane** (new, replaces Herdr's `pane` header): written for Bellwether, matching the shipped
  header's content and actions (program icon and title, folder, status, split right, split down,
  zoom or unzoom, close); status mark on the left, action buttons as round ghost icons that stay
  mounted and fade in on pane hover (`.opacity(hovered ? 1 : 0).transition(...)`).
- Herdr's `workspace-chrome` sidebar footer (Settings, Add machine) stays Herdr's and takes the theme
  (the user was not asked about it; builder's note).

### How appear motion works

Herdr's `.transition(property, ...)` animates a later change of a target on an element that is
already drawn (`gpui-kit.d.ts`: "Animates later target changes"; `TransitionPolicy` has no `from`).
An element drawn for the first time at opacity 1 does not fade. So:

- An element that fades in or out on a state change (pane-header buttons, row hover fills, the done
  check layer of a status mark) stays mounted under a stable `id` and changes its opacity target.
- An element that should fade in when it first appears (a card, an overlay's card, a dock card) is
  drawn first at opacity 0 and switched to 1 by a state change that needs no timer, for example the
  element's first `on_size_change`. The builder proves the mechanism in the stage window with a
  probe before using it; if Herdr does not animate it, that element appears without motion, and
  the result is recorded.
- Hover inside `bw-chat`'s virtual list is a plain `.hover` style (no handlers there).

### Motion catalogue

| What | How | When it stops |
|---|---|---|
| Working mark | `spin(900)` | when no longer working |
| Blocked mark, needs-you pill, waiting line | `loop("opacity", {from: 0.6, to: 1, period: 1400})` | when answered |
| Done check | a mounted check layer, opacity target 0 then 1, `transition("opacity", 180)` | settles |
| Card, menu, popover appear | opacity 0 then 1 on first layout, `transition("opacity", 140)`, plus a 4 to 6 px `top` slide where the probe shows it works | settles |
| Row hover outside virtual lists | mounted hover fill, opacity target on `on_hover`, `transition("opacity", 120)` | settles |
| Chip hover inside the chat list | `.hover` style colour swap, no transition | instant |
| Preparing browser, sending, settling | spinning Mauve arc | when done |

## Done checks

Each is an observable result with the command that shows it. Run from empty state in the stage
window on the MacBook: `scripts/verify/stage.sh up`, then every window command through
`scripts/verify/stage.sh do …` (for example `stage.sh do herdr-app status`,
`stage.sh do herdr-app shot x.png`, `stage.sh do hc …`). A bare `herdr-app` call asks the user's
own window, not the stage. A covered window stops drawing, so each shot first brings the stage
window to the front (it changes window focus only).

1. **Theme reaches every surface.** `stage.sh do herdr-app status` reports layout `bellwether` and
   no errors; pixels sampled from `stage.sh do herdr-app shot` (sidebar, tab bar, pane, right
   sidebar, status bar, pane header, a popover) equal the Mocha role colours above within ±2 per
   channel; a terminal in the stage running `printf` of the 16 ANSI colours shows the recorded
   Mocha port's values. Rejects: any region still graphite (`#1c1c1c`-like) or a terminal colour
   off the recorded port.
2. **One palette module.** `grep -rnoE "#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b" mods/bw-*/*.js shared/*.js`
   lists colour literals only in `shared/palette.js` and its copies; `scripts/test.sh` passes
   (Biome, tsc, Bun tests including the updated `tests/layout.test.js`, `herdr-app check` on every
   mod including `bw-status` and `bw-pane`). Rejects: a hex literal in any other mod file.
3. **Motion follows state and an idle window is still.** Harness tests: a working mark carries
   `spin`, a blocked mark `loop("opacity")`, idle and done marks carry no loop; no mod calls
   `cx.timer` for drawing (count of `timer.every` and `timer.after` calls unchanged from the base,
   apart from any the appear mechanism needs, which must be none). In the window, with stable input:
   a shell terminal in the stage sets an agent's status by printing Herdr's agent status report
   (OSC 7501, `~/.config/herdr-app/AGENTS.md`, Agents) instead of a live agent, and entrance
   transitions are allowed 1 s to settle. Then (a) with every agent idle, 10 shots 150 ms apart are
   identical; (b) with one agent working, pixels change only inside the union of the bounding
   boxes of that agent's visible status marks (sidebar line, tab pill, pane header, status bar and
   any chat mark); (c) the same with one agent blocked; (d) after the agent returns to idle, the
   burst is identical again. Rejects: any changed pixel outside the allowed union.
4. **Contrast.** A script over every foreground and background pair the mods draw (including the
   translucent hover composited over its fill, and a pulsing mark at its dimmest opacity) reports
   at least 4.5:1 for all text of any size below 24 px (WCAG 2.2 SC 1.4.3) and at least 3:1 for
   status marks, icons and borders that carry meaning (SC 1.4.11). Disabled controls are exempt from
   the text threshold but must differ visibly from enabled ones. Rejects: any pair below.
5. **PR #9 behaviour still holds.** In the window: a hidden chat polls `bw feed` every 10 s and a
   shown one every 2 s; answer buttons are disabled at 0 s and 2 s after ⌘J back and enabled at
   4 s; the threads card sits at the timeline's top right; and "Open in Changes" keeps Changes
   selected when Browser was stored for the space. Feed calls are counted without touching the
   user's installed helper: `shared/helper.js` honours a `BW_HELPER` environment variable (path of
   the `bw` to run on this machine; unset means the installed helper, unchanged), and
   `stage.sh up` can start the stage app with `BW_HELPER` pointing at a logging wrapper in the
   stage's own `bin` that appends a timestamped line per call and runs the repo's `bw`. A unit test
   covers the variable (set, unset, and that a remote `exec(..., { on })` call keeps the default).
   Rejects: any of the four behaviours regressing.
6. **Visual review.** Shots of every piece in its states (sidebar with projects and agents, tab
   capsule, + menu with Preparing, project menu, Add dialog, each right panel and browser states,
   a chat with bubbles, tool chips, a picture, the threads card and pill, an approval and a question
   card, the status bar, pane headers including their hover buttons) are reviewed by Gemini 4 Argon
   against this design and Flockbook's previews; each concrete finding it raises is fixed or
   answered. The pane header's actions (split right, split down, zoom, close) are each run once in
   the stage and the result checked with `stage.sh do herdr-app ls`. Rejects: an unanswered finding
   or a misrouted pane action.

## Left to the builder

- Exact sizes inside the stated ranges, icon redraws, easing curves, the monogram hue hash.
- Where each shared piece lives (`shared/ui.js` vs new shared files) and the `.shared` lists.
- The order of work; the plan from `superpowers:writing-plans`.

## Amendment log

- 2026-11-07: written from the interview.
- 2026-11-07, design review (Sol, Argon; each finding verified by a fresh Claude verifier):
  - Contrast: done check 4 now requires 4.5:1 for small text (was 3:1 for 11 px labels); `dim` and
    `idle` move to Overlay 2 and `dim` is for marks only; text rules for Surface 1 and Mauve added.
  - Roles: border and input Surface 1, hover a translucent Text tint, selected Surface 1 with a
    Mauve marker (raised, hover and border were all Surface 0, so hovers and borders vanished).
  - Terminal selection: a 25 % Mauve tint instead of Surface 2, to follow the Mauve answer.
  - Terminal ANSI: copied from a recorded published Mocha port, bright slots included.
  - Motion: new "How appear motion works"; transitions only animate later target changes, overlays
    pass `frame: "none"`, chat-list hovers are plain `.hover`.
  - "Open in Changes" stores the panel choice (an existing defect, reproduced in the harness).
  - Layout preview is new (with a root `preview` field); `tests/layout.test.js` is updated.
  - Done checks: every window command through `stage.sh do`; check 3 allows the union of a working
    agent's marks with stable OSC 7501 input; check 5 counts calls through a `BW_HELPER` override;
    check 6 also runs each pane-header action.
  - Refuted and left as is: themes folder creation (rsync creates it), remote folder shortening in
    `bw-pane` (not specified; no wrong path on these machines), monogram letters, ANSI white order,
    chat row heights (chips match the estimate; keep `READ_W` and update `estimate.js` with any
    padding change).
