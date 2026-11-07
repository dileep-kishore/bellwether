# Review rules

## Focus
- A key press or message that can reach a different agent, conversation or
  prompt than the one the chat or card shows (`bw send`, `bw answer`, the
  request dock).
- A Linear API key, token or private transcript that reaches mod code,
  shared state, helper output, a log, a cache in the repository, or a test
  fixture that did not pass `scripts/verify/scrub-fixture`.
- A feature that behaves differently, or needs manual setup, for a space on
  another machine: a local path used where `exec(..., { on })` or the helper
  on that machine belongs.
- A mod that polls Herdr's live data (`agents()`, `spaces()`, `panes()`,
  `terminals()`, `focused()`), animates with a timer, or blocks on `exec`.
- Code copied from Flockbook, Shepherdr or herdr-t3 without an entry in
  `THIRD_PARTY_NOTICES.md` in the same commit.
- A mod not named `bw-<name>`, an edit to Herdr's shipped files in
  `~/.config/herdr-app`, or a `shared/` copy that differs from its source.
- Changes to the vendored `crates/vendor/herdr-core` without a test and an
  `UPSTREAM` note.
- Git commands in the helper without the read-only flags or
  `--no-textconv`.

## Skip
- Style and naming preferences that `cargo fmt`, `cargo clippy` or the
  project's JS conventions already settle.
- Upstream code in `crates/vendor/herdr-core` that this change did not
  touch.
- Generated `jsconfig.json` and `.d.ts` files in mod folders.

## Human review
- `hooks/`
- `scripts/install-*`, `scripts/sync.sh`
- `crates/bw/src/machine/`
- `.stignore`, `.gitignore`

## Output
- Start with the finding count; write "Nothing to fix" when it is zero.
- Cite file:line for every finding.
- Report at most three P3 findings.
