# Bellwether

A frameless Catppuccin Mocha Herdr window with a Mauve accent, tuned for 934 px half-tile width as
well as full-screen desks. On the left, every machine lists its Git projects, each project its
worktrees with ahead, behind and `+N −M` counts, and each worktree the agents running in it with a
live status mark; `⌘B` hides the sidebar to a 6 px left-edge floating peek drawer. In the middle,
two floating capsules sit over a continuous `#1e1e2e` Base field above a four-screen stack (`chat`,
`panes`, `needs`, `overview`) with no bottom status bar. An agent started from "+" opens on the
frameless `chat` screen: its session log drawn as bubbles, Markdown and one-line tool summaries,
with PR status and skill buttons, queued follow-up prompts, and inline approval and question cards;
`⌘J` flips cleanly to full-width terminals on `panes`, `⌘⇧N` opens `Needs you` triage, and `⌘⇧O`
opens the `Overview` workspace grid. On the right (`⌘⌥B`, hidden by default), one strip switches
between Changes (`Uncommitted`, `Branch` or `PR` diffs with inline line-review comments), Issues
(the Linear project linked to the repository), Drafts (HTML pages, `decisions.tsv`, plans and review
ledgers), and Browser (a separate Google Chrome that you and the agents share).

![Bellwether](preview.png)

## What you see

The whole window draws in the layout's own theme, `themes/bellwether.json`. It stays dark whatever
the system appearance. Surface steps are flattened for calm hierarchy: canvas, surface and terminal
background Base `#1e1e2e`, chrome and popover Mantle `#181825`, raised `#272738` (45% Surface 0 over
Base), decorative hairline border Surface 0 `#313244`, selected `#333546` (55% Surface 1 over Base),
input edge Overlay 1 `#7f849c`, hover `#cdd6f412` (7% Text), text `#cdd6f4`, muted Subtext 0
`#a6adc8` (also used on `#333546` selected rows at >= 5.4:1 AA), dim Overlay 2 `#9399b2`, accent
Mauve `#cba6f7` with Crust `#11111b` text on it (reserved for primary actions, links and focus
rings). Status colours: working Blue `#89b4fa`, blocked Peach `#fab387`, done Green `#a6e3a1`, idle
Overlay 2 `#9399b2`. Failures use Red `#f38ba8`. Terminals use Ghostty 1.4.0's Catppuccin Mocha ANSI
colours, cursor Rosewater `#f5e0dc`, a `#494060` selection (a quarter of Mauve over Base) and 14 by
12 px padding. Columns have 1 px Surface 0 (`#313244`) dividers, and there is no title bar or bottom
status bar.

Left to right:

1. The left sidebar is Mantle, 244 px wide, and resizes from 200 to 420 px (`⌘B` hides it, activating
   a 6 px left-edge floating `sidebar-peek` drawer over `screen`). A 48 px header leaves room for the
   macOS traffic lights (`[12, 16]`) and holds "+ Add project" at its right. Under it, each machine
   has a compact heading in 11 px semibold capitals with a fold chevron and, when needed, a pill such
   as "offline", "connecting…" or "setting up Bellwether". Each project row wears a chevron, a
   neutral `#272738` letter monogram tile in Subtext 1 (`#bac2de`), and the name in 13 px semibold.
   Each worktree row shows a branch icon, its branch name, and `↑ahead` in Green, `↓behind` in Red,
   `+added` in Green and `−removed` in Red. Under a worktree, each agent row shows its status mark,
   program icon, title, a `+N` count for running sub-agents, a Peach count for waiting requests, and
   its age ("now", "5m", "3h", "2d"). Spaces outside any project list under "Other spaces". The
   active space's worktree has a `#333546` selected fill and a 2 px Mauve bar.
2. A 40 px footer under the sidebar is Herdr's `workspace-chrome` footer: Settings, Add machine.
3. The middle column (`work`) sits on Base `#1e1e2e` with a 48 px draggable top bar (`bw-tabs`). Two
   36 px `#272738` capsules with 1 px `#313244` borders and 18 px corners float in the bar: a tab
   capsule on the left (sidebar toggle when hidden, draggable tab pills with status mark, title and
   hover close, plus "+") and a utility capsule on the right (`Needs you` breathing Peach pill when
   `> 0`, `Overview` grid icon, `Terminal` flip and peek controls, and right `Inspector` toggle).
   When the sidebar is hidden on macOS outside fullscreen, `bw-tabs` reserves traffic-light clearance
   on the left.
4. Under the tab bar, the `screen` stack shows one of four screens:
   - `chat` (`bw-chat`): a frameless conversation screen (reading column up to 760 px wide, holding
     an LRU cache of up to 24 active sessions). A compact context strip shows the session switcher
     when multiple agents share a space, branch, sub-agent threads count, and live GitHub PR status
     (checks, review state, unresolved threads, plus `/babysit-pr` and `/merge-pr` skill buttons).
     Your messages are `#272738` bubbles; replies are Markdown; tool runs collapse into one-line
     chips; edited turns end with "Changed N files · Open in Changes"; inline pictures show up to
     320 px tall. Above the composer sit the request dock (up to 45 % of the screen) and the
     collapsible queued-prompts drawer (`N queued`, with inline edit, reorder, remove, `Send now`,
     and `Resume queue` when held).
   - `panes`: full-width terminal panes with 8 px padding and gap, 10 px corners, `lone: false` (so a
     single terminal draws completely frameless), 1 px `#313244` borders (`#cba6f7` on focus) when
     split, and hover-only 28 px `bw-pane` headers.
   - `needs` (`bw-needs`): a master-detail `Needs you` fleet triage screen listing every pending
     approval or question across open spaces and answering inline with `y`/`a`/`n` or `1-9`.
   - `overview` (`bw-overview`): a responsive workspace fleet grid grouping spaces, status, PR state,
     diff stats, and pending request badges with one-click jump into `chat`, `panes`, or `needs`.
5. The right sidebar is Mantle, 380 px wide (min 280, max 620), hidden by default (`⌘⌥B`), with a
   36 px `bw-right` strip holding a four-segment track: `Changes`, `Issues`, `Drafts`, `Browser`.
6. Changes (`bw-diff`) offers `Uncommitted | Branch | PR` scope pills, a ref picker and Fetch button,
   foldable file sections, and a virtualized patch viewer. Clicking any diff line opens an inline
   line-comment editor; saved comments highlight in the gutter and batch into a structured review
   prompt (`Send review` or `Queue review`) after preflight anchor relocation.
7. Issues (`bw-linear`) shows the linked Linear project (`Project | Mine | All` and search), issue
   detail as Markdown, and `Attach to chat`, `Open in Linear`, and `Copy branch name`.
8. Drafts (`bw-drafts`) lists `HTML Pages`, `Decisions & Audit` (`decisions.tsv`), `Plans & Tasks`,
   and `Review Ledgers` (`ledger.md`, including external worktree ledgers registered via
   `bw drafts register-ledger`), with structured preview and `Open in Browser` staging.
9. Browser (`bw-browser`) controls the shared Bellwether Chrome instance (`127.0.0.1:9222`), tabs,
   `Arrange`, and remote SSH port forwards.

Menus and dialogs are Mantle cards with 12 px corners, a 1 px `#313244` border and a shadow. The "+"
menu has New chat (Claude, Codex), New terminal (Shell, Claude, Codex) and Worktree (New worktree…,
Open worktree…). The project menu has New worktree…, Open worktree…, Link Linear project… and Remove.

## How it behaves

Agent status marks use the same colours across the window: working spins a Blue arc every 900 ms,
done fades in a Green check over 180 ms, blocked draws a static Peach question mark, and idle draws a
still Overlay 2 ring. Continuous breathing (opacity 0.65 to 1 over 1400 ms) is reserved exclusively
for the top-bar `Needs you` count pill while at least one request waits. Menus, dialogs and request
cards fade in over 140 ms and slide up 6 px once, and hover fills fade over 120 ms. An idle window
with no blocked request does not move.

Sidebar: clicking a worktree selects its space or opens one; clicking an agent selects its space and
tab and focuses its chat or terminal. When `sidebar` is hidden (`⌘B`), hovering the 6 px left edge
slides out `sidebar-peek` over any screen (including native terminal panes).

Tabs and screens: clicking a tab selects it and switches `screen` between `chat` and `panes`
according to `bw.tab-view` and whether the tab is a chat tab (`bw.chat-tabs` or running Claude/Codex).
`⌘J` flips the active tab between `chat` and `panes`; `⌘⇧'` (`bw-tabs.terminal-peek`) opens Herdr's
native floating terminal peek; `⌘⇧N` toggles `needs`; `⌘⇧O` toggles `overview`. Every screen
transition hands keyboard focus to the destination (`pane.focus`, `bw-chat.focus`, or
`bw-needs.focus`) and updates the 3 s `TERMINAL_FOCUS` cooldown so keystrokes meant for a terminal
never trigger an approval button. Pre-upgrade split `bw-chat` panes are cleaned up automatically when
`adopt()` sees them, leaving the live terminal pane intact.

Chats, PR strip, and queue: Enter sends directly when the agent is idle or done, and queues into
`bw queue` while the agent is working or blocked (`⇧⌘Enter` forces an immediate send). On a `Stop`
hook event (and `bw-chat`'s 2 s fallback poll when hooks are absent), `bw queue drain` runs five
safety gates under a per-terminal `FolderLock` (cooldown/inflight, screen emptiness, zero pending
cards across all running sub-agents, clean assistant turn with no prose question, and live session
binding) before delivering the head item; any blocker holds the queue cleanly with a visible reason.
`bw pr status` polls cached GitHub GraphQL metadata (`45 s` TTL + `HEAD` SHA invalidation); clicking
`Babysit PR` or `Merge PR` sends or queues `/babysit-pr <number>` or `/merge-pr <number>` to the
space's agent and never invokes `gh pr merge` directly.

Right sidebar: `⌘⌥B` or the top-bar inspector button toggles `right`, and `bw-right` remembers the
chosen tab (`changes`, `issues`, `drafts`, `browser`) per space. Hidden stack children park their
polls and make zero helper calls.

## Built from

Node tree of `layouts/bellwether.json` (root `theme: "bellwether"`, `titlebar: "none"`,
`traffic_lights: [12, 16]`, `background: "canvas"`, `terminal_padding: [14, 12]`,
`divider: {width: 1, color: "border"}`, `preview: "layouts/bellwether.svg"`):

```text
root (row)
├── sidebar (column, 244 px, min 200, max 420, chrome)
│   ├── projects        block  mod bw-projects
│   └── sidebar-footer  block  40 px  mod workspace-chrome {footer: true}
├── work (column, resizable false, surface)
│   ├── tabs    block  48 px  window_drag  mod bw-tabs
│   └── screen  stack  active "chat"  floating [{id "sidebar-peek", mod bw-projects {peek: true}, edge "left", peek 6}]
│       ├── chat      block  mod bw-chat
│       ├── panes     block  padding 8, tab "active", pane {gap 8, radius 10, background "background", lone false,
│       │             border 1 "border", focus 1 "accent", header {mod bw-pane, height 28, top, reveal "hover"}}
│       ├── needs     block  mod bw-needs
│       └── overview  block  mod bw-overview
└── right (column, hidden true, 380 px, min 280, max 620, chrome)
    ├── right-strip  block  36 px  mod bw-right
    └── right-body   stack  active "changes"
        ├── changes  block  mod bw-diff
        ├── issues   block  mod bw-linear
        ├── drafts   block  mod bw-drafts
        └── browser  block  mod bw-browser
```

Every mod's `mod.json` has `"place": "none"`. Overlays open with `frame: "none"` and draw their own
card. Mods and their `props`:

1. `bw-projects`, no props (or `{peek: true}` in `sidebar-peek`): the sidebar and left-edge hover peek
   drawer. It also calls `setAgentOrder` so Herdr's agent order matches.
2. `bw-tabs`, no props: the floating capsule tab bar, 4-screen stack switches (`chat-flip`,
   `terminal-peek`, `needs-toggle`, `overview-toggle`), legacy split-pane cleanup, and `bw.screen`
   mirroring.
3. `bw-pane`, `{pane, terminal}` from Herdr: the hover-revealed terminal pane header on `panes`.
4. `bw-status`, no props: optional standalone status bar mod (kept tested and synced).
5. `bw-right`, no props: the 4-tab right inspector strip (`Changes`, `Issues`, `Drafts`, `Browser`).
6. `bw-diff`, no props: the Changes panel (`Uncommitted`, `Branch`, `PR` scopes, inline line-review
   comments, preflight anchor relocation). As a middle tab (`tab.new {mod: "bw-diff"}`) it takes
   `{tab: true, space, machine, window, top, section, file, old, untracked, from, to, base, mode}`.
7. `bw-linear`, no props: the Issues panel. As the 440 by 500 px link dialog it takes
   `{pick: {machine, commonDir, name}}`.
8. `bw-drafts`, no props: the Drafts & Audit panel (`HTML Pages`, `Decisions & Audit`, `Plans & Tasks`,
   `Review Ledgers`, with `Open in Browser` staging through `bw drafts read --stage`).
9. `bw-browser`, no props: the Browser panel.
10. `bw-needs`, no props: the `Needs you` (`⌘⇧N`) master-detail fleet triage screen.
11. `bw-overview`, no props: the `Overview` (`⌘⇧O`) responsive fleet workspace grid.
12. `bw-chat`, no props in stack mode (or `{terminal, machine, kind, window}` legacy per-pane fallback):
    24-session LRU chat screen with PR status strip, queued follow-up drawer, Linear issue chips, and
    inline request dock.
13. `bw-new`, `{space}` from the tab bar or `{machine, folder}` from a project: the "+" popup.
14. `bw-menu`, `{project: {key, machine, commonDir, main, name, open}}`: the project popup.
15. `bw-add`, no props: the Add project dialog.

Shipped Herdr mods used: `workspace-chrome` (footer) and `worktree` (New and Open worktree dialogs at
460 by 280 and 560 by 480 px).

`herdr` functions: `spaces`, `panes`, `agents`, `terminals`, `machines`, `focused`, `layout`,
`placement`, `props`, `theme`, `keys`, `window`, `home`, `settings`, `shared`, `setShared`, `exec`
(with `{ on: space.machine }`), `watchFolder`, `pickFolder`, `knownAgents`, `nextCommand`,
`openOverlay`, `closeOverlay`, `notify`, `setAgentOrder`, `run`; plus `cx.open_url`,
`cx.write_to_clipboard` and `localStorage` for folds. Commands run: `space.new`, `space.select`,
`tab.new`, `tab.select`, `tab.move`, `tab.close`, `pane.split`, `pane.zoom`, `pane.focus`,
`pane.close`, `agent.focus`, `layout.select {id: "screen"|"right-body", active}`, `layout.show`,
`layout.hide`, `layout.toggle`, `terminal.peek`, `app.palette`, `bw-chat.focus`, `bw-needs.focus`.
Keys in `keys/bellwether.json`, section `layout:bellwether`: `cmd-b` → `layout.toggle:sidebar`,
`cmd-alt-b` → `layout.toggle:right`, `cmd-j` → `bw-tabs.chat-flip`,
`cmd-shift-'` → `bw-tabs.terminal-peek`, `cmd-shift-n` → `bw-tabs.needs-toggle`,
`cmd-shift-o` → `bw-tabs.overview-toggle`. Shared values: `bw.projects`, `bw.screen`, `bw.tab-view`,
`bw.chat-agent`, `bw.chat-tabs`, `bw.chat-shown`, `bw.pr-summary`, `bw.terminal-focus`,
`bw.window-id`, `bw.known-agents`, `bw.right.tab`, `bw.diff.base`, `bw.diff.reveal`,
`bw.linear.links`, `bw.chat.attach`, `bw.hooks-dismissed`.

Shared JavaScript lives in `shared/`: `palette.js` holds every colour, `ui.js` the status marks,
pills, chips, neutral monogram tiles, cards and buttons, and the rest the helper client, PR model,
project model, refresh schedule, Git parsing and stack/chat-tab logic. Each `mods/bw-*/.shared` lists
what a mod imports.

Programs: mods run `git` for short reads and the Rust helper `bw` through `exec("sh", …)` at
`~/.local/share/bellwether/helper/current/bw` on the space's machine (`$BW_HELPER` here when set).
`bw` commands: `version`, `machine status|install|setup`, `feed`, `locate`, `send`, `picture`,
`picture-read`, `tree`, `cards`, `answer`, `counts`, `hooks`, `event`, `pr status`,
`queue add|list|edit|move|remove|send|clear|drain|resume`, `drafts list|read|register-ledger`,
`browser` (`up`, `down`, `status`, `tabs`, `focus`, `close`, `new`, `arrange`, `agent-args`,
`forward …`, `free-port`, `port-check`), `agent` (`ensure`, `args`, `warm`),
`diff files|patch|refs|fetch` (and the detached `diff watch`), and `linear
projects|issues|search|issue`. `bw` in turn runs `git`, `gh api graphql`, `hc` (`exec`, `get`,
`send`, `put`, kept terminals for forwards), `security find-generic-password -s bellwether.linear`
and `/usr/bin/curl` for Linear, Google Chrome through `open -n` with its own profile and DevTools on
127.0.0.1:9222, `ssh -R` for remote agents, and `npx -y chrome-devtools-mcp@1.12.0` as each agent's
`bw-browser` MCP server. `hooks/bw-event` is an optional Claude and Codex hook that hands events to
`bw event` (including detached `Stop` queue auto-drain).

Art: one-colour SVG icons in each mod's `icons/` folder, tinted by `text_color` (the status ring,
ring-spin, check and question live in `mods/bw-projects/icons/`), and `layouts/bellwether.svg`, a
640 by 400 preview.

## Watch out

- Herdr rewrites its shipped layouts, mods and its own `AGENTS.md` on every start. Build in a
  separate folder and copy in with `scripts/sync.sh`, which writes only `layouts/bellwether.*`,
  `themes/bellwether.json` and `mods/bw-*/`, as real files: Herdr loads no SVG through a symlink.
- A mod cannot import outside its own folder. `scripts/sync.sh` copies each `shared/` file into
  every mod whose `.shared` names it, and `scripts/check.sh` fails when a copy differs. Icon paths
  do cross folders (`shared/ui.js` uses `mods/bw-projects/icons/`), so install all fifteen mods.
- `exec` returns once, with a 30 s and 8 MiB cap, no standard input and no streaming. Anything that
  watches a log or a remote worktree runs in `bw`, and a mod polls it. Every Git call is short and
  read-only: `--no-optional-locks`, `-c core.fsmonitor=false`, `--no-ext-diff --no-textconv`.
- Mods run on the machine showing the window. `watchFolder` and `pickFolder` work only there; a
  remote space needs `exec(..., { on: space.machine })`. `space.new` without `machine` means the
  focused space's machine, so this Mac is named `machine: ""`.
- Herdr draws only shown copies of a mod. A hidden panel must make no helper call: Changes, Issues,
  Drafts and Browser check that their stack child is active and their last read was drawn, else park.
- `render` has no `cx`, cannot construct retained GPUI state (`InputState`, `TextareaState`,
  `VirtualListScrollHandle`, `FocusHandle`), and cannot call `FocusHandle.focus()`; loop tasks never
  read live data (`agents()`, `spaces()`, `panes()`, `terminals()`, `focused()`). Render hands the
  loop its targets and pokes it.
- A transition animates only a later change: draw a card at opacity 0 and set 1 on its first
  `on_size_change`. Virtual list rows take no handlers, so chat chip hovers are `.hover` swaps and
  diff patch line clicks dispatch through `.on_item_click` on `v_virtual_list`.
- No mod file other than `shared/palette.js` holds a colour literal. `themes/bellwether.json` is
  written from it by `bun scripts/gen-theme.js`, and `tests/theme.test.js` keeps them equal.
  Selected rows (`#333546`) keep Subtext 0 (`#a6adc8`) at >= 5.4:1 AA contrast.
- `shared/helper.js` requires `bw version` to report 0.8.0 and protocol 8. When another machine's
  helper is missing or older, a mod runs this Mac's `bw machine install <machine>` and checks again.
  An Apple silicon Mac gets the running `bw`; Linux needs `scripts/build-dist.sh` (`cargo zigbuild`);
  other platforms report `no_build`.
- A remote Changes panel polls every 1.5 s through `bw diff files --watch`. The watcher must start
  without `HC_SCOPE` and in its own process group, or the `hc exec` that started it ends it. It
  exits after 60 s with no call, and `diff-unchanged` is trusted only while its process lives.
- The Linear key lives in this Mac's login Keychain under service `bellwether.linear`, stored once
  per Mac with `scripts/linear-key.sh`. Only `bw linear` reads it, and it reaches curl through its
  config on standard input. No mod, shared value, argument, log or cache may hold it.
- A chat sends with `bw send` (or atomic `bw queue send`) on the space's machine with the terminal's
  local address: `hc send` from another core wraps the text in `<hc from=…>` and slash commands stop
  working.
- A terminal binding of `cmd-j` wins while a terminal has focus; `scripts/keys-merge.js` reports it
  as shadowed and refuses to replace a key already bound elsewhere.
- Because `chat` and `panes` live on the `screen` stack rather than inside a per-tab split, both get
  100% of the work column width even at 934 px half-tile width, eliminating the old 15-column
  terminal squeeze.
- The browser needs Node and `npx` where the agent runs, gives a machine reached through `via` no
  browser, and Arrange works on macOS only. After the Bellwether Chrome restarts, a running agent's
  browser tools stop until its next session. Bellwether never touches the person's own Chrome.
- Over SSH, reading Desktop, Documents or Downloads on a Mac raises a privacy prompt on that Mac's
  screen, so probes that walk a home folder skip them.
- Without the optional hooks, requests show without who asked and queued prompts rely on `bw-chat`'s
  2 s fallback `bw queue drain`; Codex runs a new hook only once the person trusts it. Changes lists
  at most 2,000 files per section, counts no untracked file over 64 MiB, and a diff tab does not
  refresh by itself. Mine and All show every project's issues.
- A covered window stops drawing, so `herdr-app shot` returns the last frame drawn. Bring the window
  to the front first.

## Done when

- `scripts/test.sh --offline` prints `all tests passed`: cargo fmt, clippy and tests, `bunx biome ci`,
  `bunx tsc -p types`, `bun test`, `scripts/check.sh` and every `scripts/verify/*.sh --offline`.
- `scripts/check.sh` runs the real `herdr-app check` on all fifteen mods with no `STAND-IN` or `FAIL`
  line, `bun scripts/gen-theme.js --check` passes, and `grep -rnoE "#[0-9a-fA-F]{6}" mods/bw-*/*.js
  shared/*.js` finds colours only in `palette.js` and its copies.
- `sh scripts/verify/ui-stage.sh` passes all 23 live stage checks (`ALL STAGE CHECKS PASSED`) at both
  934 px OmniWM half-tile width and 1440 px full width without touching `~/.config/herdr-app`.
