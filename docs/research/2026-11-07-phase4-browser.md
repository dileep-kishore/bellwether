# Phase 4: Chrome 156, CDP, Chrome DevTools MCP 1.12.0, agent logs and a scratch sshd

Run on macmini, 2026-11-07, macOS 27.0.1, by `scripts/verify/browser-probe.sh`
(four runs; the outputs below are from the fourth, which exited 0 with every
check passing). Versions: Google Chrome 156.0.8078.80, `chrome-devtools-mcp`
1.12.0 from the npx cache, Claude Code 2.1.319 (Haiku), Codex 0.167.0
(`gpt-6-luna`, low effort), OpenSSH 10.3p1, `hc` 0.1.18.

The probe started a second Chrome with `open -n -g` on a scratch profile under
`/private/tmp/claude-501/bw-probe/` and a free port (55691 in the fourth run,
never 9222). It stopped that Chrome with CDP `Browser.close`. The user's Chrome
(pid 433) kept the same pid and `ps` line before and after every run. The probe
read nothing else from it, and nothing listened on 9222. Agents ran in a
private hc core (`HC_SESSION=bw-p4probe`, started under `env -i`) in scratch
folders. Codex used a scratch `CODEX_HOME` holding an `auth.json` copy, deleted
afterwards. The probe deleted the Claude project folder of its own session.
Logs are described by shape and size only. Paths, the user name and the host
name below are written as `<scratch>`, `<user>` and `<host>`.

The Mac's screen was locked during every run (`lsappinfo front` named
`loginwindow`). Answers about which app is in front, (a) and (c), therefore show
only the front-to-back app order. They are owed to a window run.

## Where this contradicts the plan

1. **Decision 2 and Task 6 (`first_page_is_active`): the first page in
   `/json/list` is not the active tab.** Chrome 156 lists targets in creation
   order, newest first, and `/json/activate` does not reorder them (b). The
   signal that followed activation was `document.hasFocus()`. It is true for
   the active tab of each window: two windows gave two `true` pages. It held
   through `/json/activate`, `Page.bringToFront` and a background `new_page`.
   `document.visibilityState` did not track the active tab: tabs once shown
   stayed `visible` (possibly an effect of the locked screen). When the active
   tab was a fresh `about:blank`, no page reported focus. One browser WebSocket
   read every page's `hasFocus()` (`Target.attachToTarget {flatten: true}`,
   `Runtime.evaluate`, `Target.detachFromTarget`) in 6 to 27 ms for 8 to 13
   pages. The plan should say: "A tab is active when `document.hasFocus()` is
   true in it, read over the browser WebSocket; there is one per window, and
   none when the active tab is a blank page. Task 6 uses `cdp.rs` for this and
   its test is `active_comes_from_has_focus`." Still owed: confirm with the
   screen unlocked and Chrome behind Herdr. If `hasFocus()` then turns false
   in every tab, the fallback is the page that Bellwether last focused or
   opened.
2. **Decision 4 (the exact `browser.md` text) and decision 16 (Codex's
   picture): Codex sees a screenshot only when it calls `image(...)`.** Codex
   0.167 calls MCP tools from its `exec` code tool. Asked for a screenshot, the
   model wrote `text(r)`, so it received the JPEG as 15,275 characters of
   base64 JSON text. The rollout then held no `input_image`, and `bw feed
   --pictures` showed `pics: null`. When the prompt told it to pass the image
   block to `image(...)`, the model wrote `image(c)`. The rollout then held an
   `input_image` with a `data:image/jpeg;base64,` URL, and `bw feed --pictures`
   put a picture on the tools row. Codex's own `exec` description documents
   this ("To forward an MCP tool image, pass an individual `ImageContent` block
   from `result.content`, for example `image(result.content[0])`"). The
   decision 4 text is 1,304 bytes, so one more line would break Task 4's
   1,400-byte test. The plan should add `agent/browser-codex.md`: `browser.md`
   plus "In Codex's `exec` tool, pass a screenshot's image block to
   `image(...)`, not `text(...)`, so you and the user see the picture." It
   would mirror the Claude copy. Decision 6's flag would use it, Task 4 would
   create it and Task 8 would embed it. Decision 16's Codex picture check
   holds only with that line.

No answer contradicts decisions 1, 3, 5, 7, 8 or 9. Answer (k) keeps
`startup_timeout_sec=60` in decision 7.

## Findings the later tasks need

- Task 2: Chrome refuses a DevTools WebSocket upgrade that carries an `Origin`
  header (`403 Forbidden`); without one it answers `101`. The `tungstenite`
  client must not send `Origin`.
- Task 5: `lsof -Fpcn` prints an `f` line before each `n` line, and one
  process may list two addresses. `SingletonLock` is a symlink to
  `<host>.local-<pid>`, with the full host name. It exists while Chrome runs
  and is removed by `Browser.close`. `/json/version` answered within one
  second of `open`.
- Task 6: `faviconUrl` is present for a `data:` icon and an `http` icon, and
  absent (no key) on pages without one. `/json/list` types are `page`,
  `iframe`, `background_page`, `browser_ui` and `service_worker`. A
  `devtools://` URL opened with `PUT /json/new` is a `page`, so the URL filter
  is needed. A PDF tab is a `page` with its `http` URL plus a
  `chrome-extension://` `iframe`. `chrome://newtab/` is a `page` titled "New
  Tab".
- Task 6 and the instructions: a `new_page` with `background: true` opens in
  the most recently created window and leaves that window's active tab active.
  So an agent's tab can land in a window other than the one the user is
  looking at.
- Task 7: CDP window bounds and CGWindowList bounds were equal in every case.
  Both are global points with a top-left origin, title bar included.
  `setWindowBounds` with `left/top/width/height` on a maximized window answers
  `{}`, but it restores the earlier normal bounds and drops the requested
  ones. The plan's two calls (`windowState: "normal"`, then the bounds) are
  needed.
- Task 9: the forward's listener is an `sshd-session` process owned by the
  user. `-R 127.0.0.1:<p>` gives one `n127.0.0.1:<p>`. Under `GatewayPorts no`,
  a client asking for `0.0.0.0` gets `[::1]` and `127.0.0.1`. Under
  `GatewayPorts yes`, even `-R 127.0.0.1:<p>` gives `*:<p>` twice, which the
  loopback check must refuse.
- MCP: `pageId`s are small integers local to one MCP instance (agents got 11
  and 12, the probe's own client 9). `[selected]` in `list_pages` marks that
  instance's selection, not Chrome's active tab. Claude 2.1.319 loaded the
  deferred tools with `ToolSearch` before calling them. Codex names them
  `mcp__bw_browser__*` (underscore) inside `exec`.

## (a) `open -n -g` starts a second Chrome and leaves focus

```
before: front app: loginwindow (pid 178); probe Chrome's place front to back: none of 11
$ open -n -g -a /Applications/Google Chrome.app --args --user-data-dir=<scratch>/bw-probe/profile --remote-debugging-port=55691 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check
/json/version answered after 0 s
probe Chrome: pid 74613; its command line holds --user-data-dir=<scratch>/bw-probe/profile
PASS the user's Chrome pid and ps line are unchanged
after: front app: loginwindow (pid 178); probe Chrome's place front to back: 12 of 12
```

`open -n` started a second instance (pid 74613) beside the user's (433). The
new app went to the back of the app order and did not become the front app.
With the screen locked this does not show whether `-g` keeps an unlocked
Herdr in front. Owed.

## (b) `/json/list` order after `/json/activate`

The pages were opened in this order: the new tab page, then with `PUT
/json/new` A, B, C, SW, `doc.pdf`, `devtools://` and a blank page. Pages only,
before and after `GET /json/activate/<B>` and then `/json/activate/<A>`:

```
about:blank, DevTools, doc.pdf, Probe SW, Probe c, Probe B, Probe A, New Tab   (all three reads)
```

The order is creation order, newest first, and activation does not change it.
`cdp active` (one browser socket; window id, `visibilityState`, `hasFocus()`):

```
after the PUTs (active tab: the blank page)  hasFocus true in: none            (10 ms for 8 pages)
after /json/activate of Probe B              hasFocus true in: Probe B         (7 ms)
after /json/activate of Probe A              hasFocus true in: Probe A         (9 ms)
after Target.createTarget newWindow: true    hasFocus true in: Probe w2 (window 2), Probe A (window 1)   (18 ms for 9 pages)
after /json/activate of Probe B              hasFocus true in: Probe w2, Probe B
visibilityState: "visible" for every page in window 1 except New Tab in every read
```

The full first list is `tests/fixtures/browser/json-list.json`, with ports
55691 (Chrome) and 55692 (the page server). An exploratory run before the
script also showed `Page.bringToFront` moving `hasFocus()` and leaving the
order alone.

## (c) Whether `/json/activate` brings Chrome to the front

```
before: front app: loginwindow (pid 178); probe Chrome's place front to back: 12 of 12
$ curl -s http://127.0.0.1:55691/json/activate/EC393DC0E509D300C3B49AB783749783
Target activated [HTTP 200]
after: front app: loginwindow (pid 178); probe Chrome's place front to back: 12 of 12
```

`/json/activate` selected the tab and left the app order unchanged. Whether it
raises Chrome over an unlocked Herdr is owed to a window run. Decision 2's
`osascript` fallback is untested.

## (d) `PUT /json/new` and `GET /json/new`

```
$ curl -s http://127.0.0.1:55691/json/new?http://127.0.0.1:55692/get.html
Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb. [HTTP 405]
$ curl -s -X PUT http://127.0.0.1:55691/json/new?http://127.0.0.1:55692/a.html
{ "description": "", "devtoolsFrontendUrl": "https://chrome-devtools-frontend.appspot.com/serve_rev/@fb096c00…/inspector.html?ws=127.0.0.1:55691/devtools/page/<id>",
  "id": "<id>", "title": "", "type": "page", "url": "http://127.0.0.1:55692/a.html",
  "webSocketDebuggerUrl": "ws://127.0.0.1:55691/devtools/page/<id>" } [HTTP 200]
$ curl -s -X PUT http://127.0.0.1:55691/json/new
{ … "type": "page", "url": "about:blank", … } [HTTP 200]
```

`PUT` opens a tab in the existing window and returns its target, with an
empty title until the page loads. `GET` is refused with 405.

`/json/version` (`tests/fixtures/browser/json-version.json`):

```
{"Browser":"Chrome/156.0.8078.80","Protocol-Version":"1.3",…,"webSocketDebuggerUrl":"ws://127.0.0.1:55691/devtools/browser/71d8450a-71c6-4a85-b012-325fe0e3e1d0"}
$ curl -s -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: …' http://127.0.0.1:55691/devtools/browser/<id>
HTTP/1.1 101 WebSocket Protocol Handshake
$ (the same with -H 'Origin: http://example.com')
HTTP/1.1 403 Forbidden
```

## (e) `Browser.getWindowForTarget`, `setWindowBounds` and CGWindowList

```
$ cdp browser 55691 Browser.getWindowForTarget {"targetId":"<Probe B>"}
{"result":{"windowId":1904906015,"bounds":{"left":22,"top":53,"width":1200,"height":1005,"windowState":"normal"}}}
main display: CGDisplayBounds {"origin":{"x":0,"y":0},"size":{"width":1920,"height":1080}}
$ … Browser.setWindowBounds {"windowId":1904906015,"bounds":{"left":120,"top":140,"width":900,"height":640}}
{"result":{}}
$ … Browser.getWindowBounds → {"left":120,"top":140,"width":900,"height":640,"windowState":"normal"}
CGWindowList for pid 74613: [{"id":6257,"bounds":{"X":120,"Height":640,"Y":140,"Width":900}}, …]
$ … setWindowBounds {"windowState":"maximized"} → {}; getWindowBounds → {"left":0,"top":31,"width":1920,"height":1049,"windowState":"maximized"}
$ … setWindowBounds {"left":200,"top":160,"width":800,"height":600}   (while maximized)
{"result":{}}
$ … getWindowBounds → {"left":120,"top":140,"width":900,"height":640,"windowState":"normal"}
$ … setWindowBounds {"windowState":"normal"}, then {"left":200,"top":160,"width":800,"height":600}
$ … getWindowBounds → {"left":200,"top":160,"width":800,"height":600,"windowState":"normal"}
CGWindowList for pid 74613: [{"id":6257,"bounds":{"X":200,"Height":600,"Y":160,"Width":800}}, …]
```

The CGWindowList query used `osascript -l JavaScript`
(`CGWindowListCopyWindowInfo(OnScreenOnly | ExcludeDesktopElements)`, layer 0,
filtered to the probe Chrome's pid). It raised no permission prompt.

## (f) `SingletonLock` while running

```
$ ls -l <scratch>/bw-probe/profile/Singleton*
SingletonCookie -> 13178877936201674393
SingletonLock -> <host>.local-74613
SingletonSocket -> /var/folders/…/T/com.google.Chrome.6cZZbn/SingletonSocket
PASS SingletonLock names host-74613
SingletonLock after Browser.close: removed
```

## (g) Chrome DevTools MCP 1.12.0 over `--browserUrl`

```
$ npx -y chrome-devtools-mcp@1.12.0 --browserUrl http://127.0.0.1:55691 --no-usage-statistics --no-performance-crux --screenshotFormat jpeg --screenshotMaxWidth 1280
serverInfo {"name":"chrome_devtools","title":"Chrome DevTools MCP server","version":"1.12.0"}
32 tools: click, close_page, drag, emulate, evaluate_script, fill, fill_form, get_console_message, get_css_styles, get_network_request, handle_dialog, hover, lighthouse_audit, list_console_messages, list_network_requests, list_pages, navigate_page, new_page, performance_analyze_insight, performance_start_trace, performance_stop_trace, press_key, resize_page, screencast_start, screencast_stop, select_page, take_heapsnapshot, take_screenshot, take_snapshot, type_text, upload_file, wait_for
  new_page(url, background, isolatedContext, timeout)
  select_page(pageId, bringToFront)
  take_screenshot(pageId, format, quality, uid, fullPage, filePath)
  take_snapshot(pageId, verbose, filePath)
  click(pageId, uid, dblClick, includeSnapshot)
  close_page(pageId)
before new_page: hasFocus true in Probe w2 (window 2) and Probe B (window 1)
tools/call new_page {"url":"http://127.0.0.1:55692/mcp.html","background":true} -> 199 ms
  ## Pages … 9: Probe mcp (http://127.0.0.1:55692/mcp.html) [selected]
after new_page: Probe mcp is first in /json/list, in window 2; hasFocus true in Probe w2 and Probe B, and also in Probe mcp
tools/call take_screenshot {"pageId":9} -> 48 ms
  text item: "Took a screenshot of the current page's viewport."
  image item: mimeType image/jpeg
tools/call take_snapshot {"pageId":9} -> 134 chars ("## Latest page snapshot", "uid=1_0 RootWebArea …")
server stderr: the "exposes content of the browser instance" notice, and "The connecting client did not negotiate the MCP roots capability. Tools that read or write local files will be restricted to the OS temp directory."
```

`background: true` kept both windows' active tabs (Probe w2 and Probe B)
focused, and the app order did not change. The new page also reported
`hasFocus()` true in that read, and `false` in the reads after the agents'
runs. So a background tab can read as focused for a short time after it
opens. Task 6 should expect a short-lived second `true` in one window.

The probe's own screenshot came out 1200 by 918. It was taken a second after
its window was set to 1700 by 900, before the viewport had changed. The
agents' screenshots in (h), taken later in that window, show the 1280 px cap.

## (h) Claude's JSONL, Codex's rollout and `take_screenshot`'s image

Prompt (both agents): open `http://127.0.0.1:55692/agent-<agent>.html` with
`new_page` and `background: true`, then `take_screenshot` of that page, then
reply "done". MCP config as decision 5's launcher flags, with `npx` directly.

Claude:

```
$ hc run (private core) -- env -u ANTHROPIC_API_KEY claude --session-id <uuid> --setting-sources project --strict-mcp-config --mcp-config claude-mcp.json --allowedTools mcp__bw-browser --model haiku -p '<prompt>'
done
Claude log: 56 lines, 266357 bytes
tool calls: ToolSearch mcp__bw-browser__new_page mcp__bw-browser__take_screenshot
line shape: {"type":"user", keys [cwd, entrypoint, gitBranch, isSidechain, message, parentUuid, permissionDecision, promptId, sessionId, sourceToolAssistantUUID, timestamp, toolUseResult, type, userType, uuid, version],
  "message".content: [{"type":"tool_result","tool_use_id":"toolu_…","content":[
      {"type":"text","text":"Took a screenshot of the current page's viewport."},
      {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"<15268 chars>"}},
      {"type":"text","text":"<187 chars>"}]}],
  "toolUseResult": [the same three items, the image again]}
  image: jpeg, 11451 bytes, 1280 x 612 (twice: message.content and toolUseResult)
$ HERDR_APP_HOME=<scratch> bw feed --log <claude log> --agent claude --pictures   (tools rows)
{"sentence":"Used ToolSearch and used connectors 2 times","calls":["ToolSearch","mcp__bw-browser__new_page","mcp__bw-browser__take_screenshot"],"pics":[{"digest":"5c9a70ae92bf8337","format":"jpeg","height":612,"index":0,"offset":357191,"width":1280}]}
```

`--strict-mcp-config` here only kept the user's servers out of the probe.
Bellwether's agents never get it (decision 7).

Codex, first as asked:

```
$ hc run (private core) -- env CODEX_HOME=<scratch> codex exec --skip-git-repo-check -m gpt-6-luna -c model_reasoning_effort="low" -s read-only -c mcp_servers.bw-browser.command="npx" -c mcp_servers.bw-browser.args=[…] -c mcp_servers.bw-browser.default_tools_approval_mode="approve" -c mcp_servers.bw-browser.startup_timeout_sec=60 '<prompt>'
done; tokens used 51,496 (29,638 and 33,687 in earlier runs)
exec input: const r = await tools.mcp__bw_browser__take_screenshot({pageId:11}); text(r);
event_msg item_completed: {"item":{"type":"McpToolCall","server":"bw-browser","tool":"take_screenshot","arguments":{"pageId":11},"status":"completed",
  "result":{"content":[{"type":"text","text":"Took a screenshot …"},{"type":"image","data":"<15136 chars>","mimeType":"image/jpeg"}]},"duration":{…}}}
response_item custom_tool_call_output: {"output":[{"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
  {"type":"input_text","text":"<15275 chars>"}]}   15275 chars: {"content":[{"type":"text","text":"Took a screenshot of the current page's viewport."},{"type":"imag…
input_image items anywhere in the rollout: 0
  image item (McpToolCall): jpeg, 11352 bytes, 1280 x 612
$ bw feed --log <codex rollout> --agent codex --pictures   (tools rows)
{"sentence":"Ran 3 scripts","calls":["exec","exec","exec"],"pics":null}
```

Codex, with " In the exec tool, pass the screenshot's image block to image(...)
so you see it, and do not text() the result." added to the prompt:

```
exec input: const r = await tools.mcp__bw_browser__take_screenshot({pageId:12}); for (const c of (r?.content ?? [])) if (c.type === "image") image(c);
event_msg McpToolCall: as above, "data":"<18176 chars>"
response_item custom_tool_call_output: {"output":[{"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
  {"type":"input_image","image_url":"<18199 chars>","detail":"high"}]}
input_image items anywhere in the rollout: 1
  data: URL image: jpeg, 13632 bytes, 1280 x 612
$ bw feed --log <codex rollout> --agent codex --pictures   (tools rows)
{"sentence":"Ran 3 scripts","calls":["exec","exec","exec"],"pics":[{"digest":"06167cf65e2359b1","format":"jpeg","height":612,"index":0,"offset":143589,"width":1280}]}
```

A JPEG at 1280 px was 11 to 14 KB (15 to 18 thousand base64 characters), far
under the 4 MB picture cap. The Codex rollouts were 32 to 34 lines and 167 to
183 KB. Before writing its call, the model spent one `exec` listing
`ALL_TOOLS`, whose output was 1,863 to 24,314 characters.

## (i) `lib-sshd.sh` as the user, and `ssh -N -R`

```
SSH_CONFIG=<scratch>/sshd/ssh_config SSH_TARGET=bw-scratch, sshd on 127.0.0.1:55884
$ ps -ww -o user=,pid=,command= -p 76006
<user> 76006 sshd: /usr/sbin/sshd -D -e -f <scratch>/bw-probe/sshd/sshd_config [listener] 0 of 10-100 startups
$ ssh -F <scratch>/ssh_config -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -N -R 127.0.0.1:55885:127.0.0.1:55691 bw-scratch
$ lsof -nP -iTCP:55885 -sTCP:LISTEN -Fpcn
p76023
csshd-session
f12
n127.0.0.1:55885
$ ps -ww -o user=,pid=,ppid=,command= -p 76023
<user> 76023 76020 sshd-session: <user>
browser id through the forward: the probe Chrome's (curl http://127.0.0.1:55885/json/version)
PASS the forward reaches the probe Chrome
PASS lsof shows n127.0.0.1:55885
GatewayPorts no, client asks for 0.0.0.0:      n[::1]:55890 and n127.0.0.1:55890 (one sshd-session, f12 and f13)
the same port again while held (ExitOnForwardFailure):
  Error: remote port forwarding failed for listen port 55890   (exit 255)
BatchMode with a key the server does not accept:
  <user>@127.0.0.1: Permission denied (publickey).   (exit 255)
GatewayPorts yes (a second scratch sshd), client asks for 127.0.0.1:
  n*:55896 twice (f12 and f13)   (tests/fixtures/browser/lsof-wildcard.txt)
PASS no listener on 55885, 55890 or 55896 after ssh exits
PASS no scratch sshd left
```

The scratch `sshd` starts as the user with no root, no Remote Login and no
change under `~/.ssh`. Its host key, client key, `authorized_keys` and
`known_hosts` all live in the scratch folder. The live forward in Tasks 9 and
13 can therefore run here. The wildcard and the held-port cases forwarded to a
closed port, never to Chrome.

## (j) `lsof -Fpcn` fixtures

`tests/fixtures/browser/`:

- `lsof-loopback.txt` is the probe Chrome's listener: `p74613`,
  `cGoogle Chrome`, `f50`, `n127.0.0.1:55691`.
- `lsof-other.txt` is another program on loopback, the Bun page server:
  `p74563`, `cbun`, `f4`, `n127.0.0.1:55692`.
- `lsof-wildcard.txt` is the `GatewayPorts yes` forward: `p76113`,
  `csshd-session`, then `f12`, `n*:55896`, `f13`, `n*:55896`.

The Chrome listener's `ps -ww -o command=` line was exactly
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
--user-data-dir=<profile> --remote-debugging-port=55691
--remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check`.
All five fixtures pass `scripts/verify/scrub-fixture --check`.

## (k) Codex 0.167 and `startup_timeout_sec=60`

```
$ env CODEX_HOME=<scratch> codex -c mcp_servers.bw-browser.command="sh" -c mcp_servers.bw-browser.args=["/x/browser-mcp","w1"] -c mcp_servers.bw-browser.default_tools_approval_mode="approve" -c mcp_servers.bw-browser.startup_timeout_sec=60 mcp get bw-browser --json
{"name":"bw-browser","enabled":true,"disabled_reason":null,
 "transport":{"type":"stdio","command":"sh","args":["/x/browser-mcp","w1"],"env":null,"env_vars":[],"cwd":null},
 "enabled_tools":null,"disabled_tools":null,"startup_timeout_sec":60.0,"tool_timeout_sec":null}
$ (the same with startup_timeout_sec="sixty")
Error: failed to load bootstrap configuration
Caused by:
    invalid type: string "sixty", expected f64
    in `mcp_servers.bw-browser.startup_timeout_sec`
(exit 1)
```

Codex accepts the flag, and the real `codex exec` runs in (h) started the
server with it. Decision 7 keeps it. A bad value stops Codex before it starts,
so the flag must stay a bare number.
