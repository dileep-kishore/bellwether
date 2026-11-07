# Third-party notices

Code copied or adapted from other projects, with its source and license.
Add one entry per borrowed file: the file here, its source path, the source
commit, and the copyright line from that project's LICENSE.

## Flockbook

Source: https://github.com/minchenlee/flockbook, MIT License,
Copyright (c) 2026 Min-Chen Lee.

| File here | Source path | Commit | How |
| --- | --- | --- | --- |
| `crates/vendor/herdr-core/` (every file except `UPSTREAM` and `tests/bellwether.rs`) | `xplat/herdr-core/` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | copied, then changed as `UPSTREAM` lists |
| `crates/Tests/HerdrKitTests/Fixtures/*` (14 files) | `Tests/HerdrKitTests/Fixtures/*` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | copied unchanged |
| `crates/vendor/Cargo.toml` (`[workspace.package]`, `[workspace.dependencies]`) | `xplat/Cargo.toml` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/vendor/Cargo.lock` | `xplat/Cargo.lock` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | pruned by cargo |
| `crates/bw/src/machine/mod.rs` (`target_for`, the fixed `sh -c` script that runs the helper there) | `xplat/flockbook-modfeed/src/remote.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/bw/src/machine/install.rs` (parts under 6 MB, join and hash there, `SHA256SUMS` parsing, clean up on failure) | `xplat/flockbook-modfeed/src/remote.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/bw/src/chat/protocol.rs` (`JsonLines`, `fnv1a`; the protocol version constants and Swift notes dropped) | `xplat/flockbook-modfeed/src/protocol.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/bw/src/chat/tail.rs` | `xplat/flockbook-modfeed/src/tail.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | copied, comments changed |
| `crates/bw/src/chat/rows.rs` (rows, `pics`, separators, footers, `merged`, `cut`; adds `sentence`, `live`, `error` and the changed-files row) | `xplat/flockbook-modfeed/src/rows.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/bw/src/chat/feed.rs` (`State`, the cursor, the splice, `older`; cursor version 2 with the picture mode, state kept in the per-terminal cache file) | `xplat/flockbook-modfeed/src/feed.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/bw/src/chat/locate.rs` (`fresh`, `latest`, `absolute`, the cache write; one terminal per call, other live terminals' roots as taken) | `xplat/flockbook-modfeed/src/locate.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `tests/harness/herdr-stub.js` (the `fake` and `log` objects, the recording `run`, `exec`, `setShared`, `openOverlay`, `closeOverlay`, `notify`, `setAgentOrder` stubs, the `#name` theme Proxy) | `herdr-app/test/stub/herdr.mjs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `tests/harness/kit-stub.js` (the element Proxy that keeps children, attributes and handlers, `when`, the right-button `on_mouse_down` key, `byId`, `textOf`, the `InputState` and `Input` stubs) | `herdr-app/test/stub/ui.mjs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `mods/bw-chat/feedstate.js` (rows, older rows on top, splice; a `state` line names the wait and keeps rows, a helper failure keeps rows, a new path or session empties them) | `herdr-app/mods/flockbook/feedstate.js` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `mods/bw-chat/estimate.js` (`READ_W` 736, an 80 % bubble, heights for `tools`, `changed` and picture rows) | `herdr-app/mods/flockbook/estimate.js` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `mods/bw-chat/mdblocks.js` | `herdr-app/mods/flockbook/mdblocks.js` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | copied unchanged |
| `mods/bw-chat/timeline.js` (the row bodies, the tool line and its calls, `chipIcon`, `oneLine`, the virtual list with `on_item_click` and its scrollbar) | `herdr-app/mods/flockbook/chat.js` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `mods/bw-chat/main.js` (the feed poll, older rows on scroll-up at the top, following the newest row, the height cache) | `herdr-app/mods/flockbook/chat.js` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `mods/bw-chat/composer.js` (`withoutEnter`, the Textarea box, Enter sends and Shift-Enter adds a line; files, paste and status tags dropped) | `herdr-app/mods/flockbook/composer.js` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |

## herdr-t3

- Source: <https://github.com/JinJieBeWater/herdr-t3>, commit
  `17bbad1f7206ce4c5fb165059976887fde6a0fbc`.
- License: Apache License 2.0, copy in `licenses/Apache-2.0.txt`. Its
  LICENSE leaves the copyright line as the template's placeholder; the
  repository's author is JinJieBeWater.
- `scripts/verify/stage.sh` adapts `scripts/demo/stage.sh`: the `env -i`
  wrapper, the check that the stage's core is not the user's, the window
  launch in its own session, and `down`'s terminal cleanup. Changes: the
  user's real HOME instead of a made-up one, no fake agents, repositories,
  themes or scenes, Bellwether's layout synced with `scripts/sync.sh`, and
  the window skipped when `herdr-app` is missing.
