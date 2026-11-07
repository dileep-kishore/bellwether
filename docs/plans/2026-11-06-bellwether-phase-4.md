# Bellwether phase 4: browser, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bellwether Chrome (own profile, CDP on 127.0.0.1:9222) that the user and every Claude and Codex agent Bellwether starts share: "+" passes each agent Chrome DevTools MCP 1.12.0 and Bellwether's browser instructions for that session only, agents on other machines reach the Chrome through a checked SSH reverse forward, and the right sidebar's Browser panel lists and controls the Chrome's tabs and forwards.

**Architecture:** `bw browser …` runs on the window machine: it starts or reuses Chrome, reads tabs over the DevTools HTTP endpoints, moves the window with CDP `Browser.setWindowBounds` through a small WebSocket client, keeps one reverse forward per remote machine as a kept core terminal whose program is a `bw browser forward keep` supervisor around `ssh -R`, and computes each new agent's extra argv (`bw browser agent-args`). `bw agent …` runs on the space's machine: it writes Bellwether's agent files (instructions, MCP launcher, Claude MCP config, port file) and reads that machine's effective Codex `developer_instructions`. In JavaScript, `bw-new` awaits the extra argv before `tab.new`, and the new `bw-browser` mod draws the panel from one `bw browser status` call per poll.

**Tech Stack:** Rust 1.99.1 (edition 2021); `tungstenite` 0.30 without default features (`handshake` only); `core-graphics` 0.25 and `core-foundation` on macOS only; `toml` 0.8 (phase 3); std `TcpStream` for loopback HTTP; JavaScript ES modules for Herdr's gpui-kit runtime (API copy in `docs/drafts/herdr-api/`); Bun 1.4.4; POSIX `sh`; `hc` 0.1.18; Google Chrome 156; Node 26 (v26.12.1) and `npx`; Chrome DevTools MCP 1.12.0; real `claude` 2.1.319 and `codex` 0.167.0; `/usr/sbin/sshd` run as the user for the forward test.

**Spec:** `docs/specs/2026-11-06-bellwether-design.md` revision 4 (Tabs bullet on per-session additions; "Browser (`bw-browser`)"; Seamless machines; done check 6; Risk 5; Defaults), with every amendment log in `docs/specs/2026-11-06-bellwether-design-intent.md` (build log: Claude without `--strict-mcp-config`; Codex MCP with `default_tools_approval_mode="approve"`; effective `developer_instructions` = `config.toml` < `--profile` file < trusted project `.codex/config.toml`); phase plan `docs/plans/2026-11-06-bellwether-phases.md`, phase 4; `docs/research/2026-11-06-phase0-spike.md`; phase 2 plan `docs/plans/2026-11-06-bellwether-phase-2.md` (`chatArgv`, `chatLaunch`, helper protocol); phase 3 plan `docs/plans/2026-11-06-bellwether-phase-3.md` (`bw machine setup`, helper 0.3.0), whose Interfaces this plan uses as contracts where the build left them unchanged; where it changed them, the merged code and the intent file's "Amendment log, build" entries win (Build environment lists them); `docs/drafts/research/browser-research.md`; `REVIEW.md`.

## Build environment (macmini, 2026-11-07)

- Earlier phases' environment applies: no `herdr-app`, no `~/.config/herdr-app`, `hc` 0.1.18, PATH prefix `/opt/homebrew/opt/rustup/bin`. Window checks go to `docs/drafts/herdr-window-checks.md` (untracked).
- Phase 3 is merged into `main` (PR #5, `6b9ce0c`; follow-up PR #6, `746d1be`). Phase 4 works on branch `phase-4-browser`, cut from `main` at `746d1be`; its worktrees branch from `phase-4-browser`. The names this plan cites from phases 2 and 3 were checked against the merged code (2026-11-07): `shared/chat-tabs.js` `chatArgv(kind, run, extras)` and `addPending`, `mods/bw-new/entries.js` `menuEntries`/`chatLaunch`, `shared/helper.js` `createHelper` (its `call(machine, args)`)/`parseLines`/`HELPER_SCRIPT`, `shared/refresh-driver.js` `createPoke`, `hc::{hc_exec, hc_get, hc_ls}`, `machine::RUN_HELPER` (`pub(crate)`), `bw machine setup`, and `toml = "0.8"` in `crates/bw/Cargo.toml`. Where code merged later differs, follow the code and say so in the commit body.
- What phase 3 shipped that this plan builds on:
  - `bw machine setup` lives in `crates/bw/src/machine/hooks.rs` (`setup`), not `machine/mod.rs`. It takes `<machine|local>` and exactly one of `--check`, `--diff`, `--apply [--expect-sha <claude sha>,<codex sha>]` and `--remove`, and relays `bw hooks <op>` on that machine through `RUN_HELPER` (`local` runs it in process). `--check` prints one `{"type":"hooks","claude","codex"}` line, with `codex_trust` when Codex's groups are untrusted, and `crates/bw/tests/hooks.rs` pins that line exactly. Task 8 adds `--agent` to that shape.
  - The helper is 0.3.0, protocol 3: `crates/bw/Cargo.toml`, `crates/bw/src/version.rs`, `crates/bw/tests/{version,install}.rs`, `shared/helper.js` and its test, the `helper.js` copies, the `VERSION` replies in `tests/mods/bw-chat-{dock,threads}.test.js` and `tests/fixtures/live/chat-{tab,remote,requests}.json`, the `<machine>-helper-installed` check in `scripts/verify/sessions-run.js`, and `README.md` all name it. Phase 4 moves every one to 0.4.0, protocol 4 (decision 15).
  - Live checks on Claude never compare its whole screen, because its footer changes while it idles; `scripts/verify/live.js` `aboveFooter` cuts the screen below the input box (PR #6, `596bacb`).
  - `scripts/verify/requests.sh --machine` refuses a machine that `hc machine ls --json` does not mark `temporary`, and puts back each file it changed under that machine's `~/.claude` and `~/.codex` with `scripts/verify/home-files.sh` (PR #6, `3a1e16d`).
- Phase 2's fix that moves `bw send` to the space's machine is merged (phase 2, PR #4, `11c22e9`).
- Chrome: `/Applications/Google Chrome.app`, `Google Chrome 156.0.8078.80`. The user's own Chrome runs on its default profile (pid 433 at planning time, still running on 2026-11-07). Nothing in this phase starts, stops, attaches to or reads that instance or its profile; Bellwether's Chrome is a second instance (`open -n`) on `~/.local/share/bellwether/chrome`. Port 9222 had no listener (`lsof -nP -iTCP:9222 -sTCP:LISTEN` exit 1, again on 2026-11-07).
- `npm view chrome-devtools-mcp@1.12.0 version` printed `1.12.0`, engines `node ^20.19.0 || ^22.12.0 || >=23`. `npx -y chrome-devtools-mcp@1.12.0 --help` ran from the npx cache (no global install): options `--browserUrl`, `--pageIdRouting` (default true), `--usageStatistics`, `--performanceCrux`, `--screenshotFormat`, `--screenshotMaxWidth`; tools include `list_pages`, `new_page` (`background`, `isolatedContext`), `select_page`, `close_page`, `navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `wait_for`, `handle_dialog`.
- `claude --help`: `--mcp-config <configs...>` and `--allowedTools <tools...>` are variadic (each must be followed by another flag); `--append-system-prompt-file` exists. `codex debug prompt-input` renders the model-visible input without a model call.
- `hc machine ls --json`: only `bwloop`, `"via": true`, `"temporary": true`, target `env HOME=/Users/dkishore/.bwl sh -c`; `/Users/dkishore/.bwl` has no `.codex` or `.claude` folder (2026-11-07). bwloop therefore exercises the "browser forward unavailable" state. `localhost` SSH is not set up and this plan does not enable it or change system SSH settings. The real `ssh -R` path is tested against a scratch `/usr/sbin/sshd` (present) run as the user on a free 127.0.0.1 port with its own host key, `authorized_keys` and client config under a scratch folder (Task 1 confirms it starts; if it cannot, the live forward is owed and Task 9's tests carry the logic). `sshd -T` with the system config prints "no hostkeys available", which a scratch `HostKey` avoids.
- `hc run` flags: `--bg --json --name <1-32 of a-z0-9-_> --no-parent --no-notify --cwd`; `--keep` replaces a lost program with a shell and is not used.
- As in phases 2 and 3, the user's core runs in the Background launchd session (no keychain, short PATH). Live checks run agents in a private core started from the script's shell (`HC_SESSION=bw-browser`), under `env -i` as `record-session` does, in scratch folders under `/private/tmp/claude-501/`. Codex on bwloop uses `CODEX_HOME=/Users/dkishore/.bwl/.codex` with a copy of `~/.codex/auth.json`, deleted on exit.

## Open questions settled

1. **`bw browser up|down`.** `up` on the window machine: profile `~/.local/share/bellwether/chrome` (created 0700; `BW_CHROME_PROFILE` overrides for tests), port 9222 (`BW_CHROME_PORT` overrides), app from `BW_CHROME_APP`, else `/Applications/Google Chrome.app`, else `~/Applications/Google Chrome.app`, else `mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'"`. It first reads the port's listeners with `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpcn`: every `n` address must be `127.0.0.1:<port>` or `[::1]:<port>`, and the listening pid's command line (`ps -ww -o command= -p <pid>`) must hold `--user-data-dir=<profile>`; then `GET /json/version` must answer. All three pass: reuse. A listener that fails either check: `port_taken` with pid and command, nothing started. No listener but the profile's `SingletonLock` points at a live pid: `no_debug_port` ("the Bellwether Chrome is running without its debugging port; quit it, then Start"). Otherwise it runs `open -n -g -a <app> --args --user-data-dir=<profile> --remote-debugging-port=<port> --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check` (`-n` keeps it apart from the user's running Chrome, `-g` leaves focus where it is), waits up to 15 s for `/json/version`, and repeats the listener check. The browser id is the last path segment of `webSocketDebuggerUrl` (`ws://127.0.0.1:9222/devtools/browser/<id>`). Output: one `{"type":"chrome","state":"running"|"stopped"|"port_taken"|"no_debug_port"|"not_installed"|"start_failed","port","profile","pid","browser_id","version","started":bool,"message"}`. `down` sends CDP `Browser.close` only to a listener that passed the checks above and waits up to 10 s for the port to close; it never signals a process.
   Evidence: spec Browser bullet 1 ("Chrome ignores the port on the default profile"); `browser-research.md` section 6; the user's Chrome at pid 433 (Build environment).
2. **Tabs, focus, close, New tab.** `GET /json/list`, keep `type == "page"` whose URL does not start with `devtools://` or `chrome-extension://`; `focus <id>` is `GET /json/activate/<id>` then, if Task 1 finds that leaves another app in front, `osascript -l JavaScript` activating `NSRunningApplication` by the Chrome pid (no Automation or Accessibility prompt); `close <id>` is `GET /json/close/<id>`; `new [--url <u>]` is `PUT /json/new?<u or about:blank>` (Chrome refuses GET there), then focus. The active tab is the page whose `document.hasFocus()` is true, read over the browser WebSocket with `cdp.rs` (`Target.attachToTarget {targetId, flatten: true}`, `Runtime.evaluate` on that session, `Target.detachFromTarget`; 6 to 27 ms for 8 to 13 pages). There is one per window, and none when a window's active tab is a fresh blank page; `/json/list` lists pages newest-created first and `/json/activate` does not reorder it, so its order is not used (Task 1 note, contradiction 1). If the window run finds `hasFocus()` false in every tab while Chrome sits behind Herdr, the fallback is the page Bellwether last focused or opened (owed). Favicons: `faviconUrl` that is `data:` is decoded in process; `http`/`https` is fetched with `/usr/bin/curl -sS --max-time 3 --max-filesize 65536 --proto =http,https`; ICO is converted with `sips -s format png`; the file goes to `<app home>/data/bellwether/favicons/<fnv1a64 of URL, 16 hex>.<png|jpg|gif|webp|svg>` (format by magic bytes), at most 4 new fetches per call, a failure remembered for 1 h in `favicons/failed.json`, files pruned after 7 days. A tab without one shows a globe.
   Evidence: `gpui-kit.d.ts:20284-20290` (`image` reads from the app's directory); `herdr.d.ts` has no `fetch`; phase 2 pictures copy the same way (decision 8).
3. **Arrange: the Herdr window's bounds and the CDP client.** `window()` (`herdr.d.ts:245-252`) gives platform, title bar, maximized, fullscreen and active, and no bounds, so `bw browser arrange` finds the window itself on macOS: `CGWindowListCopyWindowInfo(OnScreenOnly | ExcludeDesktopElements)` through `core-graphics`, layer 0, owned by the nearest ancestor process of `bw` that owns such a window (`ps -o ppid=` walk), else the frontmost window whose owner name contains "herdr" (case-insensitive); `--owner-pid <pid>` overrides for tests. Displays come from `CGDisplay::active_displays()` bounds. A pure `place(herdr, displays, min_width = 640)` takes the display holding Herdr's centre: Chrome fills the gap to Herdr's right if it is at least 640 points wide, else the gap to its left, else the right half of that display, always with Herdr's top and height; it returns the side (`right`, `left`, `over`). CDP: `Browser.getWindowForTarget {targetId: <active page id>}`, then `Browser.setWindowBounds {windowId, bounds: {windowState: "normal"}}` when the window is minimized, maximized or fullscreen, then `{left, top, width, height}`, over `tungstenite` on the browser WebSocket (Rust, not Node, so it runs from the same helper with no `node` on the window's PATH). Linux builds report `{"type":"arrange","state":"unsupported"}`.
   Evidence: `herdr.d.ts:242-252`; CGWindowList bounds are global points with a top-left origin, as CDP screen coordinates are; Task 1 checks both on Chrome 156.
4. **`agent/browser.md`.** Written anew after T3 Code's `T3_CODE_BROWSER_TOOL_INSTRUCTIONS` (`packages/provider-core/src/server/orchestrationInstructions.ts:31-36`, `006d7e38`): short, imperative, a section heading, the tool prefix named, and when to switch browsers. It also carries the spec's five rules and Orca's "pin one page" habit (`skill-guides/orca-cli/references/browser.md:3`, `b0cd6d39`). Exact text (under 1,400 bytes, so Codex's 4,000-byte entry limit noted at `orchestrationInstructions.ts:3` never cuts it):

   ```markdown
   ## Bellwether browser

   The `bw-browser` tools (Chrome DevTools MCP) drive the Bellwether Chrome, the browser you share with the user. Use them when the task needs a browser, the user names a page or tab, or you need to see what a page renders. Public facts: prefer web fetch or search unless browser work was asked.

   - Open your own tab with `new_page` and `background: true`, keep its `pageId`, and pass it to every call. Act only in tabs you opened; `list_pages` shows the user's tabs and other agents' tabs too, and those are not yours.
   - Run `take_snapshot` before acting, and act on its element uids rather than coordinates. Snapshot again after a navigation or when an action fails.
   - Never type passwords, one-time codes or payment details, and never submit a purchase. If a page needs a sign-in, stop and ask the user to sign in in the Bellwether Chrome.
   - When you finish, say which tab you used (its title and URL) and leave it open; the user closes tabs from Bellwether's Browser panel. Take a screenshot with `take_screenshot` when the user should see the result.
   - A JavaScript dialog blocks the tools: answer it with `handle_dialog`.
   - If the `bw-browser` tools are missing or two calls fail on one step, quote the error and tell the user; do not switch to another browser unless they ask.
   ```

   Claude's copy adds one line after the heading's paragraph: "Claude Code may defer these tools: load them with ToolSearch `select:mcp__bw-browser__new_page,mcp__bw-browser__take_snapshot,mcp__bw-browser__click,mcp__bw-browser__take_screenshot,mcp__bw-browser__list_pages`." (T3's device text does the same for Claude, `orchestrationInstructions.ts:56-59`). Codex's copy, `agent/browser-codex.md`, adds one line in the same place: "In Codex's `exec` tool, pass a screenshot's image block to `image(...)`, not `text(...)`, so you and the user see the picture." Codex 0.167 calls MCP tools from its `exec` code tool, and a screenshot reaches the model and the rollout only through `image(...)` (Task 1 note, contradiction 2). The three texts are embedded in `bw` with `include_str!` from `agent/browser.md`, `agent/browser-claude.md` and `agent/browser-codex.md`.
   Evidence: spec Browser bullet 2 (the five rules); the tool names under Build environment; `browser-research.md` section 5 (dialogs block tools up to 180 s; page-id routing since 1.8.0).
5. **Agent files on each machine.** `bw agent ensure --window <w> [--port <p>]` on the space's machine writes, under `~/.local/share/bellwether/agent/`: `browser.md`, `browser-claude.md` and `browser-codex.md` (the texts above), `browser-mcp` (0755 `sh` launcher), `ports/<w>` (the port this window's Chrome answers on there: 9222 on the window machine, the forward's port elsewhere), and `claude-mcp-<w>.json` = `{"mcpServers":{"bw-browser":{"type":"stdio","command":"sh","args":["<abs>/browser-mcp","<w>"]}}}`. Each file is written only when its bytes differ (temp file and rename). The launcher reads `ports/<w>` (digits only, else exits 1 with a one-line reason on stderr), finds `npx` as `command -v npx`, else `/opt/homebrew/bin/npx`, else `/usr/local/bin/npx` (the Background core's PATH lacks Node, spike section 3; `BW_NPX_FALLBACKS`, a space-separated list, replaces the two fixed paths for tests), puts its folder first on PATH, and `exec`s `npx -y chrome-devtools-mcp@1.12.0 --browserUrl http://127.0.0.1:<port> --no-usage-statistics --no-performance-crux --screenshotFormat jpeg --screenshotMaxWidth 1280`. On first `ensure` per machine (marker `agent/warm-1.12.0`), it runs the launcher's `npx … --version` with a 25 s limit so a first session does not wait on a download. `<w>` is the window machine's `hostname -s`, lower-cased, reduced to `[a-z0-9-]`, at most 32 characters. `bw machine setup <m|local> --agent` is a fifth operation beside `--check`, `--diff`, `--apply` and `--remove` (setup takes exactly one): it relays `bw agent ensure --window <w>` there through `RUN_HELPER` instead of `bw hooks` (no user setting changes, so no approval). Without `--port`, `ensure` writes every file but `ports/<w>`, which only `agent-args` knows. `--check`'s `hooks` line, printed by `bw hooks check` there, gains `"agent":"ok"|"missing"|"outdated"` (the texts and launcher compared with the bytes `bw` embeds); `agent-args` (decision 7) runs `ensure` every time, so a machine needs no manual step.
   Evidence: spec Seamless machines (no setup beyond Herdr's connection); phase plan phase 4 step 2 ("written to each machine by `bw machine setup`"); spike section 3 (`node: command not found`).
6. **Codex's effective `developer_instructions`.** `bw agent args --kind codex --window <w> --cwd <dir> [--profile <name>]` on the space's machine: `$CODEX_HOME` else `~/.codex`; value = top-level `developer_instructions` of `config.toml`; then `<profile>.config.toml`'s when the agent's run argv carries `--profile <name>` or `-p <name>`; then the project layer: walking from `<dir>` up to `git rev-parse --show-toplevel` (else `<dir>` alone), the nearest folder with `.codex/config.toml`, used when `config.toml` has `projects."<that folder or an ancestor>".trust_level = "trusted"`. The flag is `developer_instructions=` + `serde_json::to_string(value + "\n\n" + browser-codex.md)` (a JSON string is a valid TOML basic string, spike section 2), or just ours when there is no value. A `config.toml` that does not parse adds nothing for Codex (no MCP, no instructions) and names `codex_config_unreadable`. A known-answer test compares the computed value with the developer message `codex debug prompt-input` renders for five scratch layouts (top level only; `--profile`; trusted root; subfolder of a trusted root; untrusted project).
   Evidence: intent build amendment log (layer order); spike section 2 runs D to L and the `prompt-input` subfolder result.
7. **Extra argv per kind.** `bw agent args` prints `{"type":"agent-args","kind","argv":[…]}`:
   - Claude: `["--mcp-config", "<abs>/claude-mcp-<w>.json", "--allowedTools", "mcp__bw-browser", "--append-system-prompt-file", "<abs>/browser-claude.md"]`. No `--strict-mcp-config` (it drops the user's servers, spike section 1). `--allowedTools mcp__bw-browser` allows the server's tools without a prompt, as Codex's `approve` does and as T3 Code does for its server (`ClaudeAdapterV2.ts:2010-2038`, `browser-research.md` section 1); logged as a spec change.
   - Codex: `-c mcp_servers.bw-browser.command="sh"`, `-c mcp_servers.bw-browser.args=["<abs>/browser-mcp","<w>"]`, `-c mcp_servers.bw-browser.default_tools_approval_mode="approve"`, `-c mcp_servers.bw-browser.startup_timeout_sec=60`, `-c developer_instructions=…` (decision 6), each `-c` and its value as two elements.
   The window-side `bw browser agent-args --kind <k> --machine <m|""> --cwd <dir> [--profile <p>]` runs `up` (decision 1; started in the background with `-g`), for a remote machine `forward ensure` (decision 8), writes the port through `bw agent ensure` there (`hc exec --on <m>` with `RUN_HELPER`), and relays `bw agent args`: `{"type":"agent-args","kind","machine","browser":"ready"|"unavailable","reason","argv":[…]}`. Unavailable (Chrome not startable, `via`, offline, refused forward, Node missing, unreadable Codex config) gives `argv: []`: the agent starts as it would without Bellwether, no MCP, no instructions, no `developer_instructions` flag.
   Evidence: spec Tabs bullet on additions; spike sections 1 and 2; spec Browser bullet 5 ("its agents start without the browser MCP").
8. **The reverse forward.** `bw browser forward ensure --machine <m>` (window machine): the machine's entry in `hc machine ls --json`; `via: true` gives `via` ("browser forward unavailable: <m> connects through via, not SSH"), a state other than `connected` gives `offline`; `target` is the SSH destination. State lives in `~/.local/share/bellwether/browser/forwards/<core>/<machine-slug>.json` (`<core>` from `HC_SESSION`, else `default`): `{kind:"browser", machine, target, port, terminal, state, reason, browser_id, checked_at_ms}`. A live forward whose terminal still runs `bw browser forward keep` and whose last check passed is reused. Otherwise the port is the stored one if `bw browser free-port --prefer <port>` on that machine says it is free, else a new one from that command (bind `127.0.0.1:0`, read, close), up to 3 tries. It removes an old terminal of that name and runs `hc run --bg --json --no-parent --no-notify --name bw-fwd-<slug> --cwd <home> -- <helper>/current/bw browser forward keep --machine <m> --target <t> --port <p>`, no labels (it belongs to no tab), then waits up to 12 s for the state file to say `ready` or a failure. `keep` is the supervisor: it runs `ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -N -R 127.0.0.1:<p>:127.0.0.1:9222 <t>` as a child, then within 5 s runs `bw browser port-check --port <p> --browser-id <id>` on that machine (`hc exec --on`, id read fresh from the local `/json/version` each time). `port-check` passes only when `lsof -nP -iTCP:<p> -sTCP:LISTEN -Fpcn` (else `ss -Hltnp "sport = :<p>"`, else fail) lists only `127.0.0.1` or `[::1]` addresses and `GET http://127.0.0.1:<p>/json/version` carries that browser id. A failed check kills ssh, writes `refused` with the reason and exits 1: no reconnect, so a wrong listener is never retried into use. An ssh exit writes `reconnecting` with ssh's last stderr line and retries after 2, 4, 8, 16, 30, then every 60 s, on the same port, with the same checks; a port now taken writes `port_taken` and exits, so the next `ensure` picks a new port and new sessions get it (running sessions keep failing tool calls with a connection error, never reaching another browser). Hidden test flags `--ssh-config <file>` and `--target <dest>` on `ensure`, `keep` and `agent-args` let the verify script use the scratch `sshd`; the mod never passes them. `forward stop --machine <m> [--dev <port>]` runs `hc kill` and `hc rm` on that terminal and deletes its state file.
   Evidence: spec Browser bullet 5; `hc run --help` (Build environment); AGENTS.md (`exec` returns once, nothing streams, so the reconnect loop runs in a terminal, not a mod); Risk 5 (fail closed).
9. **"Forward port" for dev servers.** `bw browser forward dev --machine <m> --port <n>`: the local port must be free (bind `127.0.0.1:<n>`), else `local_port_taken`; same supervisor as `--kind dev`, running `ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -o GatewayPorts=no … -N -L 127.0.0.1:<n>:127.0.0.1:<n> <t>` (the spec's command with the loopback bind written out), checked by a local `GET http://127.0.0.1:<n>/` that gets any HTTP status line within 3 s (a dev server that answers nothing is `ready_no_answer`, not refused). State files `forwards/<core>/<slug>-dev-<n>.json`; terminal `bw-dev-<slug>-<n>` (cut to 32 characters).
   Evidence: spec Browser bullet 5; `browser-research.md` section 7.
10. **`bw browser status`, the panel's one call.** Lines: the `chrome` line (decision 1, without starting anything), one `{"type":"tab","id","title","url","favicon","active"}` per page (decision 2), one `{"type":"forward","kind","machine","target","port","state","reason","terminal"}` per state file whose terminal `hc ls --json` still lists (a missing terminal reads `stopped`). It runs no `ssh` and no remote call, and fetches at most 4 favicons, so a 2 s poll stays cheap.
11. **`bw-browser` panel.** Replaces the Browser placeholder: the `browser` child of `right-body` in `layouts/bellwether.json` becomes `{ "mod": "bw-browser" }`. 360 px column, 13 px text, 11 px secondary. Header 36 px: a 16 px Chrome glyph, "Bellwether Chrome", the state ("Running · 6 tabs", "Not running"), and buttons New tab, Arrange; Start when stopped. Named states replace the list: not running (Start), `port_taken` ("Port 9222 is used by another program: <command> (pid <n>)"), `no_debug_port`, `not_installed` ("Google Chrome is not installed on this Mac"), helper states from `shared/helper.js`. Tab rows 40 px: 16 px favicon, title (13 px, one line) over host and path (11 px `t.dim`), active row on `t.selected` with a 2 px accent bar; hover shows a close button; a click focuses. "Forwards" section (11 px uppercase heading): one 28 px row per forward ("macmini · browser :52817 · ready", reason in `t.dim` when not ready, Stop), dev rows ("localhost:3000 ← macmini", Stop). "Forward port" opens an inline 28 px number field and Add for the active space's machine; disabled with "This space is on this Mac" for a local space. Arrange shows its result for 4 s ("Placed right of Herdr", "No room beside Herdr: Chrome covers the right half").
12. **Polling rules.** `bw-browser`'s loop (phase 1's `createPoke`) calls `bw browser status` every 2000 ms start to start while the panel is shown, and not at all while hidden; `render` decides shown (the active space's `right-body` stack has `browser` active, read from `layout()` in `render`) and pokes the loop on a change, so showing the panel reads at once. No timer, task or `nextCommand` loop reads `layout()`, `spaces()`, `panes()`, `agents()`, `terminals()` or `focused()`; button actions run `bw browser …` once and poke. Forwards need no mod poll: their supervisors reconnect.
   Evidence: spec anti-goal "The window gets slower"; `REVIEW.md` Focus 4.
13. **"+" passes the additions.** Every Claude or Codex row in `bw-new` (New chat and New terminal) runs, in its click handler, `cx.spawn` of `helper.call(null, ["browser", "agent-args", "--kind", k, "--machine", machine ?? "", "--cwd", folder, …profile])` with a 20 s budget, while the row shows a spinner and "Preparing browser…" and further clicks on any row do nothing. Then it closes the overlay, records the pending chat (chat rows), and runs `tab.new`/`space.new` with `argv: chatArgv(kind, agent.run, extras)`. A failure or `browser: "unavailable"` starts the agent with `extras = []` and `notify({ title: "Started without the browser", body: reason, level: "warning" })`. Shell rows are unchanged. For Codex only, `--profile <p>` is passed when the agent's `run` holds `--profile <p>` or `-p <p>` (Claude's `-p` means print and is never read as a profile).
   Evidence: phase 2 decision 10 (`chatArgv` as the hook); spec Tabs ("Terminal tabs of Claude or Codex get the same additions").
14. **Chrome starts when an agent starts.** `agent-args` runs `up` in the background when Chrome is not running, because a remote forward cannot be checked without Chrome's browser id and an agent's first tool call would otherwise fail. `-g` keeps focus in Herdr. The panel's Start does the same in the foreground.
15. **Helper 0.4.0, protocol 4** (phase 3 shipped 0.3.0, protocol 3), so every machine's helper reinstalls once with `browser` and `agent`. Every place that names the version moves in Task 2 (Build environment lists them).
16. **Done check 6, here and owed.** Runs here (`scripts/verify/browser.sh`): Chrome up on the real profile path (stopped afterwards if the script started it); a Bun server on 127.0.0.1 serves `tests/browser/page.html` and logs clicks; at the same time `claude -p` (local, argv from `bw browser agent-args --machine ""`) clicks button 3 and Codex `exec` on bwloop (argv from `agent-args --machine bwloop --target <scratch sshd> --ssh-config <scratch>`, so through a real `ssh -R`) clicks button 5, each in a tab it opened (`?who=` in its URL); the click log has exactly those two clicks in those tabs; `bw browser status` lists both tabs; a stand-in user click (CDP `Input.dispatchMouseEvent` on button 7 of Claude's tab from `tests/browser/cdp.js`) is logged by the same tab after the agent's; interactive Claude in the private core (as the spike's section 3) shows "Called bw-browser" and logs its click; `bw feed --log <claude log> --pictures` has a picture on the screenshot's tools row (Codex's per Task 1's finding); `claude mcp list` and `codex mcp list` print what they printed before and the user's settings carry no `bw-browser` trace; through the forward, `port-check` passes with this Chrome's id, a stub CDP on `0.0.0.0` and a stub with another id fail it; `agent-args --machine bwloop` without the test target says `via` with `argv: []`; a scratch `CODEX_HOME` with a sentinel top-level `developer_instructions` and a trusted project layer renders both sentinels plus "Bellwether browser" in `codex debug prompt-input`. Owed to a window run (listed in Task 14): the screenshot inline in a chat tab, the panel shot, Arrange beside the real Herdr window, the user's own click, and macmini as a real SSH machine from the MacBook (forward, `lsof` there, a Codex chat tab there).
   Evidence: spec done check 6; intent approval note (window tests deferred, other tests run in every phase).

## Spec changes (one line each, for the intent file's amendment log)

- Browser: the forward's kept terminal runs `bw browser forward keep`, which runs the specified `ssh -R` (plus `BatchMode`, `ServerAlive*`, `ControlMaster=no`) and reconnects with the checks, because a reconnect needs a process that outlives `exec` and a mod may not poll.
- Browser: the forward's port stays the same across reconnects and is written per window to `~/.local/share/bellwether/agent/ports/<window>` on that machine; the MCP launcher reads it at session start.
- Browser: Claude also gets `--allowedTools mcp__bw-browser`, matching Codex's `approve` and T3 Code's own server.
- Browser: Chrome DevTools MCP runs with `--no-usage-statistics --no-performance-crux --screenshotFormat jpeg --screenshotMaxWidth 1280`, so no visited URL goes to Google and screenshots stay under the 4 MB picture cap.
- Browser: Arrange finds the Herdr window through macOS's window list, since `window()` has no bounds; macOS only.
- Browser: `bw browser agent-args` starts the Chrome in the background when it is not running, since a forward cannot be checked without it.
- Browser: a `via` or failed machine starts agents with no additions at all (no MCP, no instructions, Codex's `developer_instructions` untouched).
- Browser: "Forward port" binds `127.0.0.1` explicitly (`-L 127.0.0.1:<port>:127.0.0.1:<port>`).
- Browser: `bw browser down` closes only the Bellwether Chrome, for tests and quitting.
- Seamless machines: agent files are written by `bw machine setup <m> --agent` and refreshed by every `agent-args`, with no user setting changed.
- Defaults: favicons cached under the app home's `data/bellwether/favicons/`, 7 days.
- Build note, not the spec's words: done check 6 here runs with `claude -p`, interactive Claude in a private core and Codex on bwloop through a scratch `sshd`; the window half is owed.

## Global Constraints

- Mods are named `bw-<name>`; the new mod is `bw-browser`; shared state keys start with `bw.`.
- Mods use only names in `herdr.d.ts` and `gpui-kit.d.ts`; no `setTimeout`, no DOM, no top-level `await`, no `cx` kept past its callback.
- No mod reads `agents()`, `spaces()`, `panes()`, `terminals()`, `focused()` or `layout()` from a timer, a spawned task or a `nextCommand` loop; `render` reads them and guards every command it runs against a second render.
- Polling: `bw browser status` every 2000 ms while the Browser panel is shown, none while hidden; no sleep under 1000 ms.
- `bw browser …` and `bw agent ensure` for the window machine run on the window machine (`helper.call(null, …)`); `bw agent …`, `free-port` and `port-check` for a remote machine run there through `hc exec --on <m>` with `RUN_HELPER`. Values reach `sh -c` only as positional arguments; `hc` and `ssh` get argv, never a command string.
- Chrome: profile `~/.local/share/bellwether/chrome`, `--remote-debugging-port=9222`, listeners on `127.0.0.1` or `[::1]` only, `open -n`; never the default profile; never attach to, signal or read a Chrome whose command line lacks that `--user-data-dir`.
- Chrome DevTools MCP exactly `chrome-devtools-mcp@1.12.0` through `npx -y`, never installed globally; one instance per agent session; server name `bw-browser`.
- Claude never gets `--strict-mcp-config`; Codex's server always has `default_tools_approval_mode="approve"`; Codex's `developer_instructions` flag always starts with the effective existing value.
- Nothing writes `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml` or any user agent setting; verify scripts record their SHA-256 at start and fail on a `bw-browser` or sentinel trace at exit.
- Forwards: `ssh -o ExitOnForwardFailure=yes … -N -R 127.0.0.1:<port>:127.0.0.1:9222 <target>`; a failed loopback or browser-id check closes it and is never retried automatically.
- Tests that start Chrome stop it (`bw browser down`); a Chrome already running at the start of a test is reused and left running. No test needs a site login.
- Sizes: panel 360 px wide; header 36 px; tab rows 40 px with a 16 px favicon; forward rows 28 px; text 13 px, 11 px secondary.
- Tests live outside `mods/`; JavaScript tests use `tests/harness/mount.js`; Rust tests use `BW_HC` with `crates/bw/tests/fake-hc`, scratch `HOME`, `HERDR_APP_HOME`, `BW_CHROME_PORT` and `BW_CHROME_PROFILE`, and in-test HTTP and WebSocket servers.
- Before every commit: `git diff --cached --stat` lists only the intended files; else `git reset -q` and stage again. Conventional commits, about 50-character titles, bodies wrapped at 72.

## Review Focus

1. Port 9222 already held by another program (a dev server, another Chrome with debugging, a Chrome on our profile started without the port): `up` attaches to nothing, starts nothing, and names the pid and command. Tests in Task 5 (`port_held_by_other_program_is_refused`, `chrome_on_other_profile_is_refused`, `profile_locked_without_port_is_named`).
2. A forwarded port that listens beyond loopback (`GatewayPorts yes` gives `*:<port>`) or answers with another browser's id: the forward closes, stays closed, and agents get no MCP. Tests in Task 9 (`wildcard_listener_fails_closed`, `other_browser_id_fails_closed`, `refused_is_not_retried`) and Task 13 (live stubs on `0.0.0.0` and with another id).
3. A Codex config whose `developer_instructions` is multi-line, holds quotes or `"""`, comes from a profile file or a trusted project, or a `config.toml` that does not parse: the flag carries exactly what Codex renders followed by ours; an unreadable file adds nothing. Tests in Task 8 (`effective_value_matches_prompt_input`, `multiline_and_quotes_round_trip`, `unreadable_config_adds_nothing`).
4. ssh drops or the machine sleeps mid-session: the supervisor reconnects on the same port with the same checks; a port taken meanwhile is named and never reused. Tests in Task 9 (`ssh_exit_reconnects_with_checks`, `taken_port_on_reconnect_is_named`).
5. "+" while `agent-args` is slow, fails, or the helper is missing: the agent starts once, without additions, with a warning; a second click while preparing starts nothing. Tests in Task 12 (`failed_args_start_plain_with_notice`, `second_click_while_preparing_does_nothing`, `timeout_starts_plain`).

---

## Tasks and waves

Tasks in one wave touch different files and run in parallel T3 worktrees; each wave merges into `phase-4-browser` before the next starts.

| Wave | Task | Depends on |
|---|---|---|
| A | 1 Probe: Chrome 156, CDP, MCP 1.12.0, pictures, scratch `sshd` | phase 3 merged |
| A | 2 Helper 0.4.0 frame, loopback HTTP, CDP WebSocket client | phase 3 merged |
| A | 3 Test page, click server, CDP stand-in | phase 3 merged |
| A | 4 `agent/browser.md`, Claude copy, MCP launcher | phase 3 merged |
| B | 5 `bw browser up|down`, listener checks | 1, 2 |
| B | 6 `bw browser tabs|focus|close|new`, favicons | 1, 2 |
| B | 7 `bw browser arrange` | 1, 2 |
| B | 8 `bw agent ensure|args`, Codex effective value, `machine setup --agent` | 2, 4 |
| C | 9 Forwards: `free-port`, `port-check`, `forward ensure|keep|dev|stop` | 1, 5 |
| C | 11 `bw-browser` mod, layout, `bw-right` | 5, 6, 7 by line shape |
| C | 12 "+" passes the additions | 8 by line shape |
| D | 10 `bw browser agent-args` and `bw browser status` | 5, 6, 8, 9 |
| E | 13 `scripts/verify/browser.sh` (done check 6 here) | 3, 10, 11, 12 |
| F | 14 Phase checks, window list, review, spec changes | all |

### Task 1: Probe (wave A)

**Files:**
- Create: `scripts/verify/browser-probe.sh`, `scripts/verify/lib-sshd.sh`, `docs/research/2026-11-07-phase4-browser.md`, `tests/fixtures/browser/json-version.json`, `json-list.json`, `lsof-loopback.txt`, `lsof-wildcard.txt`, `lsof-other.txt`

**Interfaces:**
- Produces `lib-sshd.sh`: `sshd_up <dir>` (free 127.0.0.1 port, `ssh-keygen -t ed25519 -N ''` host and client keys, `sshd_config` with `ListenAddress 127.0.0.1`, `HostKey`, `PidFile`, `AuthorizedKeysFile <abs>`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `UsePAM no`, `StrictModes no`, `AllowTcpForwarding yes`, `GatewayPorts no`; `/usr/sbin/sshd -D -e -f <cfg>` in the background; a client `ssh_config` with `Host bw-scratch`, `HostName 127.0.0.1`, `Port`, `User $USER`, `IdentityFile`, `IdentitiesOnly yes`, `UserKnownHostsFile <dir>/known_hosts`, `StrictHostKeyChecking accept-new`), printing `SSH_CONFIG=<file> SSH_TARGET=bw-scratch`; `sshd_down <dir>` kills it by pid file and removes the folder.
- Produces the note's answers, each with the command and output: (a) `open -n -g` starts a second instance beside the user's Chrome and leaves focus; (b) `/json/list` order after `/json/activate` of the second tab; (c) whether `/json/activate` brings Chrome to the front; (d) `PUT /json/new` and `GET /json/new`; (e) `Browser.getWindowForTarget` and `setWindowBounds` round-trip, and the CGWindowList bounds of the Chrome window equal the CDP bounds; (f) `SingletonLock` while running; (g) chrome-devtools-mcp 1.12.0 over `--browserUrl`: `new_page` with `background: true` leaves the active tab active; (h) whether Claude's JSONL and Codex's rollout keep `take_screenshot`'s image (record shape, size for JPEG at 1280 px); (i) `lib-sshd.sh` starts as the user and `ssh -N -R 127.0.0.1:<p>:127.0.0.1:9222 bw-scratch` makes `lsof -Fpcn` show `n127.0.0.1:<p>` owned by a user process; (j) `lsof -Fpcn` text for a loopback, a wildcard and another program's listener, saved as fixtures; (k) Codex 0.167 accepts `-c mcp_servers.bw-browser.startup_timeout_sec=60` (else decision 7 drops that flag and Task 8 follows the note).

- [ ] **Step 1:** Write `browser-probe.sh` (a scratch profile under `/private/tmp/claude-501/bw-probe/`, port from `free-port` logic in the script, Chrome stopped with CDP `Browser.close` at exit; the user's Chrome untouched: its pid and `ps` line are the same before and after).
- [ ] **Step 2:** Run it. Expected: every answer (a) to (j) printed; exit 0; no Chrome on the scratch profile and no `sshd` left (`pgrep -f bw-probe` prints nothing).
- [ ] **Step 3:** Write the note; scrub fixtures (`scripts/verify/scrub-fixture --check tests/fixtures/browser`). If (i) fails, the note says why and Task 13 marks the live forward owed.
- [ ] **Step 4: Commit** `docs: record the phase 4 browser probe`.

### Task 2: Helper 0.4.0 frame, loopback HTTP, CDP client (wave A)

**Files:**
- Modify: `crates/bw/Cargo.toml` (version `0.4.0`; `tungstenite = { version = "0.30", default-features = false, features = ["handshake"] }`; `[target.'cfg(target_os = "macos")'.dependencies] core-graphics = "0.25"`, `core-foundation` matching it), `Cargo.lock`, `crates/bw/src/version.rs` (`PROTOCOL = 4`), `crates/bw/src/main.rs` (arms `browser` → `browser::run`, `agent` → `agent::run`; usage), `crates/bw/tests/version.rs`, `crates/bw/tests/install.rs` (`PROTOCOL = 4`), `shared/helper.js` (`PROTOCOL = 4`, `HELPER_VERSION = "0.4.0"`), `shared/helper.test.js` (its "this window needs helper 0.3.0, protocol 3" test), the `helper.js` copies (`scripts/sync.sh --shared-only`), `tests/mods/bw-chat-dock.test.js` and `tests/mods/bw-chat-threads.test.js` (their `VERSION` reply), `tests/fixtures/live/chat-{tab,remote,requests}.json` (`bw version` answers protocol 4, 0.4.0), `scripts/verify/sessions-run.js` (`<machine>-helper-installed` expects protocol 4, 0.4.0)
- Create: `crates/bw/src/browser/mod.rs`, `browser/http.rs`, `browser/cdp.rs`, stubs `browser/{chrome,tabs,arrange,forward,launch}.rs`, `crates/bw/src/agent/mod.rs` (stub), `crates/bw/tests/browser_frame.rs`

**Interfaces:**
- Produces `browser::run(args)`: `up|down` → `chrome::run`; `tabs|focus|close|new` → `tabs::run`; `arrange` → `arrange::run`; `free-port|port-check|forward` → `forward::run`; `agent-args|status` → `launch::run`. Each stub prints `{"type":"error","code":"not_built"}` and exits 1, so Wave B and C tasks edit only their own file.
- Produces `http.rs`: `pub struct Reply { pub status: u16, pub body: Vec<u8> }`, `pub fn get(port: u16, path: &str, timeout: Duration) -> io::Result<Reply>`, `pub fn put(port: u16, path: &str, timeout: Duration) -> io::Result<Reply>`: HTTP/1.1 to `127.0.0.1` only, `Host: 127.0.0.1:<port>`, `Connection: close`, body at most 1 MiB (`Content-Length` or to close; chunked bodies decoded).
- Produces `cdp.rs`: `pub fn browser_ws(port: u16) -> Result<(String, String), String>` (URL and browser id from `/json/version`); `pub struct Cdp`; `Cdp::connect(ws_url: &str, timeout: Duration) -> Result<Cdp, String>` (only `ws://127.0.0.1:` or `ws://[::1]:` URLs); `Cdp::call(&mut self, method: &str, params: Value) -> Result<Value, String>` (incrementing ids, skips events, returns `result` or the `error.message`).

- [ ] **Step 1: Write the failing tests:** `version.rs` expects protocol 4 and `"0.4.0"`; `browser_frame.rs`: `get_reads_content_length_body`, `get_reads_chunked_body`, `body_over_1_mib_is_an_error`, `refuses_after_timeout` (a listener that never answers, 300 ms), `cdp_call_matches_ids_and_skips_events` (an in-test `tungstenite::accept` server that sends an event before the reply), `cdp_error_is_returned`, `non_loopback_ws_is_refused`, `each_new_command_prints_not_built`; `crates/bw/tests/install.rs` installs a protocol 4 build; `shared/helper.test.js` reads a `0.3.0`, protocol 3 helper as `outdated`.
- [ ] **Step 2:** Run `cargo test -p bw --locked` and `bun test shared/helper.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `cargo test -p bw --locked`, `cargo clippy -p bw --all-targets -- -D warnings`, `bun test`, `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): add the browser command frame for 0.4.0`.

### Task 3: Test page, click server, CDP stand-in (wave A)

**Files:**
- Create: `tests/browser/page.html`, `tests/browser/server.js`, `tests/browser/cdp.js`, `tests/browser/page.test.js`

**Interfaces:**
- `page.html`: title "Bellwether test page"; buttons `#b1` to `#b9` labelled "Button 1" to "Button 9", each 120 by 48 px; a `<ol id="log">` that shows each click as "Button N clicked (<who>)"; `who` from the URL's `who` query value (default `none`); each click `POST`s `{who, button, at_ms, trusted: event.isTrusted}` to `/click`.
- `server.js`: `bun tests/browser/server.js --port <p> --log <file>` serves `/page.html`, appends each `/click` body as one JSON line to `<file>`, answers `GET /clicks` with the lines, and binds `127.0.0.1` only.
- `cdp.js`: `bun tests/browser/cdp.js --port <p> --who <w> --click <n>` finds the page whose URL has `who=<w>` in `/json/list`, connects to its `webSocketDebuggerUrl`, reads `#b<n>`'s centre with `Runtime.evaluate`, and sends `Input.dispatchMouseEvent` pressed and released there (Bun's built-in `WebSocket`).

- [ ] **Step 1: Write the failing tests** (`page.test.js`): `server serves the page and logs a click` (POST then `GET /clicks` gives `{who:"t1",button:3}`), `server binds loopback only`, `page has nine buttons and a log` (parse the HTML), `cdp.js picks the tab by who` (against an in-test fake `/json/list` and WebSocket).
- [ ] **Step 2:** Run `bun test tests/browser`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `test: add the browser test page and click log`.

### Task 4: Instructions and MCP launcher (wave A)

**Files:**
- Create: `agent/browser.md`, `agent/browser-claude.md`, `agent/browser-mcp`, `tests/agent-files.test.js`

**Interfaces:**
- Produces the two texts exactly as decision 4 and the launcher as decision 5 (its first comment line says what it is; `set -eu`).

- [ ] **Step 1: Write the failing tests** (`agent-files.test.js`): `browser.md is under 1400 bytes and holds the five rules` (strings "background: true", "Act only in tabs you opened", "take_snapshot", "Never type passwords", "say which tab you used"); `the Claude copy is browser.md plus the ToolSearch line`; `launcher execs npx with the pinned version and flags` (run `sh agent/browser-mcp w1` with `HOME` scratch holding `ports/w1` = `52817` and a fake `npx` on PATH that prints its argv: exactly `-y chrome-devtools-mcp@1.12.0 --browserUrl http://127.0.0.1:52817 --no-usage-statistics --no-performance-crux --screenshotFormat jpeg --screenshotMaxWidth 1280`); `launcher refuses a missing or non-numeric port with one stderr line and exit 1`; `launcher finds /opt/homebrew/bin/npx when PATH lacks npx` (a scratch `BW_NPX_FALLBACKS` list stands in for the two fixed paths in the test); `sh -n` passes.
- [ ] **Step 2:** Run `bun test tests/agent-files.test.js`. Expected: FAIL.
- [ ] **Step 3:** Write the three files.
- [ ] **Step 4:** Run the same, then `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): add the browser instructions and MCP launcher`.

Added after Task 1: `agent/browser-codex.md` (decision 4's Codex copy) and its test in `tests/agent-files.test.js`, committed on `phase-4-browser` before wave B.

### Task 5: `bw browser up|down` (wave B)

**Files:**
- Modify: `crates/bw/src/browser/chrome.rs`
- Create: `crates/bw/src/browser/listen.rs` (listener parsing and checks, used by Tasks 9 and 10), `crates/bw/tests/chrome.rs`

**Interfaces:**
- Consumes: Task 2 `http`, `cdp`; Task 1 fixtures and answers (a), (f).
- Produces `listen.rs`: `pub struct Listener { pub pid: i32, pub command: String, pub addr: String }`, `pub fn parse_lsof(text: &str) -> Vec<Listener>`, `pub fn parse_ss(text: &str) -> Vec<Listener>`, `pub fn listeners(port: u16) -> Result<Vec<Listener>, String>` (lsof, else ss, else `Err("neither lsof nor ss is available")`), `pub fn loopback_only(ls: &[Listener], port: u16) -> Result<(), String>` (empty is an error: "nothing listens on <port>").
- Produces `chrome.rs`: `pub struct Chrome { pub state: &'static str, pub port: u16, pub profile: PathBuf, pub pid: Option<i32>, pub browser_id: Option<String>, pub version: Option<String>, pub started: bool, pub message: String }` with `json()`; `pub fn probe(port: u16, profile: &Path) -> Chrome` (no start); `pub fn up(port: u16, profile: &Path, background: bool) -> Chrome`; `pub fn down(port: u16, profile: &Path) -> Chrome`; `pub fn open_argv(app: &Path, profile: &Path, port: u16, background: bool) -> Vec<String>` (decision 1, `-g` only when `background`); `pub fn profile_dir() -> PathBuf`; `pub fn port() -> u16`. Lines as decision 1. `BW_OPEN` names the `open` program and `BW_PS` the `ps` program, for tests (Task 10 uses `BW_OPEN` too).

- [ ] **Step 1: Write the failing tests:** unit `lsof_fixtures_parse` (the three fixtures), `ipv6_loopback_counts_as_loopback`, `wildcard_is_not_loopback`, `open_argv_is_exact`; integration with an in-test `/json/version` server on a scratch port and a fake `ps` through `BW_PS`: `reuses_our_chrome`, `port_held_by_other_program_is_refused` (Review Focus 1), `chrome_on_other_profile_is_refused` (Review Focus 1), `profile_locked_without_port_is_named` (Review Focus 1; a `SingletonLock` symlink to `<host>.local-<this pid>`, as Task 1 found), `missing_app_is_not_installed` (`BW_CHROME_APP` to a missing path), `down_refuses_a_listener_that_is_not_ours`.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test chrome`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; then by hand `BW_CHROME_PROFILE=/private/tmp/claude-501/bw-t5/profile BW_CHROME_PORT=<free> target/debug/bw browser up`, `… browser up` again (`started:false`), `… browser down`. Expected: `running`, `running` reused, `stopped`; the user's Chrome pid unchanged.
- [ ] **Step 5: Commit** `feat(bw): start and reuse the Bellwether Chrome`.

### Task 6: `bw browser tabs|focus|close|new` (wave B)

**Files:**
- Modify: `crates/bw/src/browser/tabs.rs`
- Create: `crates/bw/tests/tabs.rs`

**Interfaces:**
- Consumes: Task 2 `http` and `cdp` (the active tab, decision 2); Task 1 answers (b), (c), (d) and `json-list.json`.
- Produces `tabs.rs`: `pub struct Tab { pub id: String, pub title: String, pub url: String, pub favicon: Option<String>, pub active: bool }`, `pub fn list(port: u16, app_home: &Path, fetch_budget: usize) -> Result<Vec<Tab>, String>`, `pub fn favicon_path(app_home: &Path, url: &str) -> Option<String>` (relative `data/bellwether/favicons/<16 hex>.<ext>` when cached), `pub fn prune(dir: &Path, max_age: Duration)`; commands `tabs` (one `tab` line each), `focus --id <id>`, `close --id <id>`, `new [--url <u>]`, each printing `{"type":"tab-action","action","id","ok","message"}`.

- [ ] **Step 1: Write the failing tests** (in-test HTTP server playing `/json/list`, `/json/activate`, `/json/close`, `/json/new`): `lists_pages_only` (fixture with a service worker, a `devtools://` page and an extension page), `active_comes_from_has_focus` (an in-test CDP WebSocket answering `hasFocus()` per target: two windows give two active tabs, a blank active tab gives none, `/json/list` order is ignored), `new_uses_put`, `focus_and_close_hit_the_id`, `data_favicon_is_decoded`, `favicon_fetch_budget_is_four`, `failed_favicon_is_not_retried_within_an_hour`, `ico_is_converted_or_dropped` (a fake `sips` through `BW_SIPS`), `prune_drops_files_older_than_7_days`. Favicon fetches go through `BW_CURL` (a fake writing fixed bytes).
- [ ] **Step 2:** Run `cargo test -p bw --locked --test tabs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): list and control the Chrome's tabs`.

### Task 7: `bw browser arrange` (wave B)

**Files:**
- Modify: `crates/bw/src/browser/arrange.rs`
- Create: `crates/bw/tests/arrange.rs`

**Interfaces:**
- Consumes: Task 2 `cdp`; Task 1 answer (e).
- Produces: `pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }`, `pub fn place(herdr: Rect, displays: &[Rect], min_width: f64) -> (Rect, &'static str)` (decision 3), `#[cfg(target_os = "macos")] pub fn herdr_window(owner_pid: Option<i32>) -> Result<Rect, String>`, `pub fn displays() -> Vec<Rect>`; command `arrange [--owner-pid <pid>]` prints `{"type":"arrange","state":"placed"|"no_herdr_window"|"chrome_not_running"|"unsupported"|"failed","side","bounds":{left,top,width,height},"message"}`.

- [ ] **Step 1: Write the failing tests:** unit `place_right_when_gap_fits`, `place_left_when_only_left_fits`, `place_over_right_half_when_neither_fits`, `place_uses_the_display_holding_herdrs_centre` (two displays, one at negative x), `place_keeps_herdrs_top_and_height`; integration with an in-test WebSocket CDP server: `arrange_normalizes_then_sets_bounds` (a maximized window: two `setWindowBounds` calls in order), `arrange_uses_active_page_target`.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test arrange`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; then by hand with a scratch Chrome from Task 5's commands and `--owner-pid` of this terminal's app. Expected: `placed`, and `Browser.getWindowForTarget` afterwards returns the printed bounds.
- [ ] **Step 5: Commit** `feat(bw): place the Chrome beside the Herdr window`.

### Task 8: `bw agent ensure|args` (wave B)

**Files:**
- Modify: `crates/bw/src/agent/mod.rs`, `crates/bw/src/machine/hooks.rs` (`setup` takes `--agent` as a fifth operation and `SETUP_USAGE` names it; `check` adds the `agent` field), `crates/bw/tests/hooks.rs` (the exact `hooks` check line gains `agent`)
- Create: `crates/bw/src/agent/codex.rs`, `crates/bw/tests/agent.rs`, `tests/fixtures/codex-config/` (five layouts: `top/`, `profile/`, `trusted-root/`, `trusted-sub/`, `untrusted/`, each a `codex-home/config.toml` and a project folder)

**Interfaces:**
- Consumes: Task 4 files (`include_str!("../../../../agent/…")`); phase 3 `machine::hooks::{setup, check}` (Build environment gives their shape); `toml`.
- Produces `agent/mod.rs`: `pub fn window_id(hostname: &str) -> String`, `pub fn ensure(home: &Path, window: &str, port: Option<u16>) -> Result<Vec<String>, String>` (changed file names; `None` leaves `ports/<w>` as it is), `pub fn check(home: &Path) -> &'static str` (`ok`, `missing` or `outdated`, for `bw hooks check`), `pub fn claude_args(home: &Path, window: &str) -> Vec<String>`, `pub fn codex_args(home: &Path, window: &str, effective: Option<&str>) -> Vec<String>`; commands `bw agent ensure --window <w> [--port <p>]` → `{"type":"agent-files","changed":[…],"warm":"done"|"skipped"|"failed"}`, `bw agent args --kind claude|codex --window <w> --cwd <dir> [--profile <p>]` → decision 7's line, or `{"type":"error","code":"codex_config_unreadable","message"}`.
- Produces `bw machine setup <machine|local> --agent` (decision 5): relays `bw agent ensure --window <this machine's window id>` there and its lines as they are, with `setup`'s `no_helper` and `unreachable` errors; `--agent` with another operation is a usage error.
- Produces `agent/codex.rs`: `pub fn effective(codex_home: &Path, cwd: &Path, profile: Option<&str>) -> Result<Option<String>, String>` (decision 6).

- [ ] **Step 1: Write the failing tests:** `effective_value_matches_prompt_input` (Review Focus 3; for each fixture layout, `codex debug prompt-input` with `CODEX_HOME` set, run from the project folder, contains `effective(…)`'s value; skipped with a printed reason when `codex` is absent), `multiline_and_quotes_round_trip` (Review Focus 3; a value with `"""`, `\`, a quote and newlines: the `-c` value parsed back by `toml` equals the input plus ours), `unreadable_config_adds_nothing` (Review Focus 3), `profile_flag_selects_the_profile_file`, `no_value_gives_ours_alone`, `claude_args_are_exact_and_have_no_strict_flag`, `codex_args_pair_each_c_with_its_value`, `ensure_writes_once_then_changes_nothing`, `ensure_writes_the_port_per_window`, `window_id_is_slugged`, `machine_setup_agent_relays_through_hc_exec` (fake `hc exec` running the test `bw` with a scratch `HOME`), `setup_agent_with_another_operation_is_usage`, `ensure_without_port_leaves_the_port_file`, `hooks_check_names_the_agent_files` (`missing`, then `ok` after `ensure`, then `outdated` after a launcher edit).
- [ ] **Step 2:** Run `cargo test -p bw --locked --test agent`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cargo test -p bw --locked`. Expected: PASS; the user's `~/.codex/config.toml` SHA-256 unchanged (the test prints it before and after).
- [ ] **Step 5: Commit** `feat(bw): write agent files and per-session agent flags` (body: human review path `crates/bw/src/machine/`).

### Task 9: Forwards (wave C)

**Files:**
- Modify: `crates/bw/src/browser/forward.rs`
- Create: `crates/bw/tests/forward.rs`, `crates/bw/tests/fake-ssh`

**Interfaces:**
- Consumes: Task 5 `listen::{listeners, loopback_only}`, `chrome::probe`; Task 2 `http`, `cdp::browser_ws`; phase 2 `hc::{hc_exec, hc_ls, hc_get}`, `machine::RUN_HELPER`; Task 1 `lib-sshd.sh`.
- Produces commands (decision 8 and 9): `free-port [--prefer <p>]` → `{"type":"free-port","port"}`; `port-check --port <p> --browser-id <id>` → `{"type":"port-check","ok","reason"}`; `forward ensure --machine <m> [--target <t>] [--ssh-config <f>]` → `{"type":"forward","kind":"browser","machine","target","port","state","reason","terminal"}`; `forward keep --machine <m> --target <t> --port <p> [--kind browser|dev] [--ssh-config <f>]` (supervisor; writes the state file, prints a line per state change for the terminal's screen); `forward dev --machine <m> --port <n>`; `forward stop --machine <m> [--dev <n>]`; `forward list` (state files with their terminals' liveness). States: `starting`, `ready`, `ready_no_answer` (dev), `reconnecting`, `refused`, `port_taken`, `local_port_taken`, `via`, `offline`, `stopped`. `pub fn ssh_argv(kind, target, port, ssh_config) -> Vec<String>` is exact as decisions 8 and 9.
- `BW_SSH` names the ssh program (tests use `fake-ssh`, which binds the `-R` or `-L` port on `127.0.0.1`, or `0.0.0.0` when `FAKE_SSH_WILDCARD=1`, then waits; exits when `FAKE_SSH_EXIT_AFTER_MS` passes).

- [ ] **Step 1: Write the failing tests:** unit `ssh_argv_is_exact_for_browser_and_dev`, `slug_and_terminal_names_fit_32`; integration (fake `hc`, fake `ssh`, an in-test `/json/version` server as Chrome): `via_machine_is_named`, `offline_machine_is_named`, `ensure_reuses_a_ready_forward`, `ensure_picks_the_stored_port_when_free`, `wildcard_listener_fails_closed` (Review Focus 2), `other_browser_id_fails_closed` (Review Focus 2), `refused_is_not_retried` (Review Focus 2: the supervisor exits and starts no second ssh), `ssh_exit_reconnects_with_checks` (Review Focus 4: two ssh starts, both checked, same port), `taken_port_on_reconnect_is_named` (Review Focus 4), `dev_needs_a_free_local_port`, `stop_kills_and_removes_the_terminal`, `three_failed_ports_give_up_with_a_reason`.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test forward`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; then live with `lib-sshd.sh` and a scratch Chrome (Task 5 commands): `forward ensure --machine bwloop --target bw-scratch --ssh-config <f>` gives `ready`; `hc exec --on bwloop` running the helper's `port-check` there passes; `kill` of the ssh child shows `reconnecting` then `ready` on the same port; `forward stop` leaves no `bw-fwd-` terminal (`hc ls --json`). Expected: as listed. If Task 1 found the scratch `sshd` does not start, record that and skip the live part.
- [ ] **Step 5: Commit** `feat(bw): keep checked SSH forwards to the Chrome`.

### Task 10: `bw browser agent-args` and `bw browser status` (wave D)

**Files:**
- Modify: `crates/bw/src/browser/launch.rs`
- Create: `crates/bw/tests/launch.rs`

**Interfaces:**
- Consumes: Task 5 `chrome::{up, probe}`; Task 6 `tabs::list`; Task 8 `bw agent ensure|args` (in process for `--machine ""`, through `hc exec --on <m>` with `RUN_HELPER` otherwise); Task 9 `forward ensure`, `forward list`.
- Produces `agent-args --kind <k> --machine <m|""> --cwd <dir> [--profile <p>] [--target <t>] [--ssh-config <f>]` → decision 7's window-side line (budget 20 s; any step's failure gives `browser: "unavailable"`, its reason, `argv: []`); `status` → decision 10's lines.

- [ ] **Step 1: Write the failing tests:** `local_claude_args_after_up`, `remote_codex_args_use_the_forward_port` (fake `hc exec` runs the test `bw` with a second scratch `HOME`; its `ports/<w>` holds the forward's port), `via_gives_empty_argv_and_reason`, `chrome_not_startable_gives_empty_argv`, `unreadable_codex_config_gives_empty_argv`, `status_lists_chrome_tabs_and_live_forwards`, `status_starts_nothing` (no `open` call through `BW_OPEN`), `status_marks_a_forward_without_terminal_stopped`.
- [ ] **Step 2:** Run `cargo test -p bw --locked --test launch`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cargo test -p bw --locked`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw): give new agents the browser flags`.

### Task 11: The `bw-browser` mod (wave C)

**Files:**
- Create: `mods/bw-browser/main.js`, `mods/bw-browser/model.js`, `mods/bw-browser/mod.json` (`{"place":"none","title":"Browser"}`), `mods/bw-browser/.shared` (`helper`, `refresh-driver`, `ui`), `mods/bw-browser/icons/` (chrome, globe, close, arrange, plus), `tests/mods/bw-browser.test.js`, `tests/fixtures/live/browser-panel.json`
- Modify: `layouts/bellwether.json` (the `browser` child's content `{ "mod": "bw-browser" }`), `tests/layout.test.js`, `mods/bw-right/choice.js` (drop `phase` from Browser's entry only if no test or copy uses it; otherwise leave it), `tests/mods/bw-right.test.js` only where it pins the Browser placeholder

**Interfaces:**
- Consumes: decision 10's lines (by shape); phase 0 `createHelper`, `parseLines`; phase 1 `createPoke`, `ui.js`.
- Produces `model.js`: `viewOf(lines, helperFailure) → { chrome: {state, label, message}, tabs: Tab[], forwards: Forward[], states: string | null }`, `isShown(layoutNode, activeSpaceId) → boolean` (the `right-body` stack's active child is `browser`), `forwardLabel(f) → string`, `canForward(space) → { ok, hint }`.
- `main.js` buttons: Start → `browser up`; New tab → `browser new`; Arrange → `browser arrange`; a row → `browser focus --id`; its close → `browser close --id`; Stop → `browser forward stop --machine m [--dev n]`; Add → `browser forward dev --machine m --port n`. Each runs once, shows its result line, and pokes the loop.

- [ ] **Step 1: Write the failing tests** (`bw-browser.test.js`, through `mount`): `shown panel polls status every 2 s and hidden polls nothing`, `showing the panel reads at once`, `no live read from the loop` (the harness counts `layout()`/`spaces()` calls outside `render`), `tabs render favicon, title, host and active bar`, `missing favicon shows the globe`, `named states: not running, port taken, no debug port, not installed, helper missing`, `forwards list states and Stop runs forward stop`, `Forward port is disabled for a local space`, `Arrange shows its result`, `row click focuses that id`; `layout.test.js`: the `browser` child is `{ mod: "bw-browser" }`, Changes and Issues keep their placeholders.
- [ ] **Step 2:** Run `bun test tests/mods/bw-browser.test.js tests/layout.test.js tests/mods/bw-right.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-browser): show the Chrome's tabs and forwards`.

### Task 12: "+" passes the additions (wave C)

**Files:**
- Modify: `mods/bw-new/entries.js`, `mods/bw-new/main.js`, `mods/bw-new/.shared` (add `helper`), `tests/mods/bw-new.test.js`
- Create: `tests/mods/bw-new-browser.test.js`

**Interfaces:**
- Consumes: decision 7's window-side line (by shape); phase 2 `chatArgv`, `chatLaunch`, `addPending`.
- Produces in `entries.js`: `argsRequest(kind, ctx, run) → string[]` (the `helper.call` arguments, `--profile` from a Codex `run` only), `extrasFrom(result) → { extras: string[], notice: string | null }` (any failure or `unavailable` gives `[]` and a notice). Agent rows keep their ids and actions; the click path in `main.js` becomes: `preparing` set (the view's state, so a second click is ignored), spawn, then the phase 2 path with `argv: chatArgv(kind, run, extras)`, then `notify` when `notice`.

- [ ] **Step 1: Write the failing tests:** `chat click asks agent-args on the window machine with the space's machine and folder`, `extras land after run in tab.new argv`, `terminal Claude row gets the same extras`, `shell row starts at once`, `failed_args_start_plain_with_notice` (Review Focus 5), `timeout_starts_plain` (Review Focus 5; a helper call that never resolves, 20 s on the harness clock), `second_click_while_preparing_does_nothing` (Review Focus 5), `profile in run is passed`, `pending chat is recorded only after the args arrive`.
- [ ] **Step 2:** Run `bun test tests/mods/bw-new.test.js tests/mods/bw-new-browser.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; `scripts/sync.sh --shared-only`.
- [ ] **Step 4:** Run `bun test` and `scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bw-new): start agents with the shared browser`.

### Task 13: `scripts/verify/browser.sh` (wave E)

**Files:**
- Create: `scripts/verify/browser.sh`

**Interfaces:**
- Consumes: everything above; `scripts/verify/lib-scratch.sh`, `lib-sshd.sh`, `live.js`, `home-files.sh`; the spike's private-core and `idle` patterns in `scripts/verify/agent-flags.sh`.
- Screen-equality checks on Claude compare `aboveFooter(screen)` (`scripts/verify/live.js`), never the whole screen, since Claude's footer changes while it idles.
- `--machine` takes only a machine `hc machine ls --json` marks `temporary` (bwloop is), and puts back that machine's `~/.codex` with `home-files.sh`, as `requests.sh` does.
- `browser.sh [--offline] [--machine bwloop]`: `--offline` runs no agent (files exist, `bun test tests/browser`, `bw browser status` parses). The full run does decision 16's list in this order, printing one `PASS`/`FAIL` line each, and exits non-zero on any `FAIL`: settings hashes and `claude mcp list`/`codex mcp list` before; Chrome up (remember whether it was running); click server; scratch `sshd`; `agent-args` local Claude and bwloop Codex through the scratch target; `claude -p --model haiku <argv> "<prompt with who=claude-p and button 3>"` and `codex exec` on bwloop (`hc run --on bwloop`, `CODEX_HOME` copy) with button 5, at the same time; click log check (exactly `{claude-p,3}` and `{codex-r,5}`, each in its own tab, no other clicks); `status` lists both tabs; stand-in user click 7 in `claude-p`'s tab; interactive Claude in the private core clicks button 2 (`who=claude-i`); `bw feed --pictures` on the Claude log has a picture; `port-check` live negatives (stub on `0.0.0.0`, stub with another id); `via` state; Codex sentinel through `codex debug prompt-input`; after: lists and hashes unchanged, no trace; cleanup (forwards stopped, `sshd_down`, private core stopped, Chrome down if the script started it, scratch folders and the `auth.json` copy deleted).

- [ ] **Step 1:** Write the script.
- [ ] **Step 2:** Run `scripts/verify/browser.sh --offline`. Expected: exit 0.
- [ ] **Step 3:** Run `scripts/verify/browser.sh --machine bwloop`. Expected: every line `PASS`; afterwards `hc ls --json` and `HC_SESSION=bw-browser hc ls --json` list none of the script's terminals, `pgrep -f bw-scratch` prints nothing, `lsof -nP -iTCP:9222 -sTCP:LISTEN` is empty if the script started Chrome, and the user's Chrome pid is unchanged. A failed agent run is retried once with the same prompt (the spike's run L needed one), and both outputs are printed.
- [ ] **Step 4: Commit** `test: verify the shared browser with real agents`.

### Task 14: Phase checks (main checkout, after waves A to E)

- [ ] **Step 1:** Merge the wave branches; `scripts/sync.sh --shared-only`; `git status` shows no changed shared copy.
- [ ] **Step 2:** Run `scripts/test.sh`, `scripts/verify/install.sh --machine bwloop`, `scripts/verify/sessions.sh --machine bwloop`, `scripts/verify/requests.sh --machine bwloop`, `scripts/verify/browser.sh --machine bwloop`, `scripts/verify/agent-flags.sh --offline`, `scripts/verify/scrub-fixture --check tests/fixtures`. Expected: exit 0 each.
- [ ] **Step 3:** Update `README.md` (status; helper 0.4.0, protocol 4 where it says 0.3.0 and protocol 3; `bw browser …`, `bw agent …`, `bw machine setup --agent`; what the agent files are and where; how to remove them: `rm -r ~/.local/share/bellwether/agent` on each machine and `bw browser forward stop`) and `AGENTS.md` only where a fact changed, with `doc-updater`.
- [ ] **Step 4:** Append "## Phase 4" to `docs/drafts/herdr-window-checks.md`:
  - `herdr-app check` on `bw-browser` and `bw-new`; a shot of the Browser panel with tabs, favicons, the active bar and a forward row; a shot with each named state.
  - From empty state in the window on the MacBook: "+" → New chat → Claude starts the Bellwether Chrome in the background (focus stays in Herdr), the chat's agent opens the test page in its own tab, clicks button N, and its screenshot shows inline in the chat; the user's own click on the same tab is logged by the page.
  - Arrange places Chrome beside the Herdr window (right, left, and the half-screen case with Herdr maximized); `bw browser arrange` from the window finds Herdr's window by the ancestor walk (else record the owner name the fallback needs).
  - A Codex chat tab on macmini as a real SSH machine: the forward's `ssh` runs from the window's own core (record whether the Background session's keys work with `BatchMode`); on macmini `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows only `127.0.0.1`; `curl -s http://127.0.0.1:<port>/json/version` there shows this Chrome's id; the agent clicks in its own tab; Forward port for a dev server on macmini opens in this Chrome.
  - Two agents at once on one Chrome: record whether the window jumps forward (`chrome-devtools-mcp#2856`).
  - Hidden panel polling: with Changes shown, no `bw browser status` calls (count with a wrapper in the stage's `bin`).
- [ ] **Step 5:** Run `independent-review` on the phase diff (Codex reviewer); fix confirmed findings; rerun `scripts/test.sh` and `scripts/verify/browser.sh --machine bwloop`.
- [ ] **Step 6:** The spec changes above went into the spec with this plan (Pieces' `agent/` row, Seamless machines, Tabs, Browser, Defaults; 2026-11-07 entries in the intent file's build amendment log, with done check 6's build note). Log any other spec change the build made, in one line each in the build amendment log with the original wording and evidence, and change the spec to match; commit `docs: log phase 4 spec changes`.

## Defaults nobody discussed

- Helper 0.4.0, protocol 4; one reinstall per machine.
- Claude's browser tools are allowed without a prompt (`--allowedTools mcp__bw-browser`), like Codex's `approve`; the instructions forbid passwords, codes, payments and purchases.
- The Bellwether Chrome starts in the background the first time a Claude or Codex agent starts; tests may leave history of the 127.0.0.1 test page in the Bellwether profile.
- Chrome DevTools MCP with usage statistics and CrUX off, JPEG screenshots at most 1280 px wide; the first `npx` download is warmed once per machine with a 25 s limit.
- Forward ports from the machine's free ports, kept across reconnects; reconnect after 2, 4, 8, 16, 30, then every 60 s; ssh with `BatchMode`, so a key that needs a passphrase prompt names its state instead of waiting.
- "+" waits up to 20 s for the browser flags, then starts the agent without them.
- The panel polls every 2 s while shown; at most 4 new favicons per poll, failures retried after 1 h, files kept 7 days.
- Arrange needs at least 640 points beside Herdr, else Chrome covers the right half of the display.
- Agents leave their tabs open; the user closes them from the panel.
