# Third-party notices

Code copied or adapted from other projects, with its source and license.
Add one entry per borrowed file: the file here, its source path, the source
commit, and the copyright line from that project's LICENSE.

## Flockbook

Source: https://github.com/minchenlee/flockbook, MIT License,
Copyright (c) 2026 Min-Chen Lee.

| File here | Source path | Commit | How |
| --- | --- | --- | --- |
| `crates/vendor/herdr-core/` (every file except `UPSTREAM`) | `xplat/herdr-core/` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | copied unchanged |
| `crates/Tests/HerdrKitTests/Fixtures/*` (14 files) | `Tests/HerdrKitTests/Fixtures/*` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | copied unchanged |
| `crates/vendor/Cargo.toml` (`[workspace.package]`, `[workspace.dependencies]`) | `xplat/Cargo.toml` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/vendor/Cargo.lock` | `xplat/Cargo.lock` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | pruned by cargo |
| `crates/bw/src/machine/mod.rs` (`target_for`, the fixed `sh -c` script that runs the helper there) | `xplat/flockbook-modfeed/src/remote.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
| `crates/bw/src/machine/install.rs` (parts under 6 MB, join and hash there, `SHA256SUMS` parsing, clean up on failure) | `xplat/flockbook-modfeed/src/remote.rs` | `c0420c7f9a720631108f2d269dcf9f4bd62634ff` | adapted |
