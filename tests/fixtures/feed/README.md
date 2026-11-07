# Saved `bw feed` outputs

One file per recording in `../sessions/`: the output of

    BW_NOW_MS=1794009600000 BW_TZ=UTC bw feed --log <root log> --agent <claude|codex> --pictures

on a scratch copy of that recording's root log (`file` in its `expect.json`). The `log`
line leaves out `path` and `cursor`, which name the scratch copy. `BW_NOW_MS` is
2026-11-07T00:00:00Z and `BW_TZ=UTC` fixes the clock times in separators and footers, so
the files are the same on every machine.

The Codex copies differ from the recordings in one place. `scrub-fixture` replaced the
injected AGENTS.md message's text with `[scrubbed: AGENTS.md instructions removed by
scrub-fixture]`, and herdr-core drops that message only when its text starts with
`# AGENTS.md`, as Codex writes it. The test puts that prefix back in a string of the same
length, so byte offsets and Codex row ids (`cx@<offset>`) stay those of the recording.

`crates/bw/tests/feed.rs` makes and checks them:

- `goldens_are_current` fails when the output changed. After a change to rows, rerun it
  with `BW_BLESS=1 cargo test -p bw --locked --test feed goldens_are_current` and read the
  diff before committing.
- `rows_match_hand_counts` checks the same rows against each recording's hand counts.

`children/<scenario>-<child id>.jsonl` hold the same output for each sub-agent of
`claude-subagents` and `codex-subagent`, read on its own:

    BW_NOW_MS=1794009600000 BW_TZ=UTC bw feed --log <child log> --agent <claude|codex> \
        --scope claude-subagent|codex-child:<history_start_ordinal> --pictures

The `log` line's `session` is the child file's stem, as for any `--log` read; a chat reads a
child with `bw feed --terminal <t> --session <child id>`, whose `log` line names the root
session and the child. `crates/bw/tests/tree.rs` makes and checks them in
`child_goldens_are_current` (bless as above, with `--test tree`), and
`child_rows_match_hand_counts` checks the rows against each child's hand counts.

The `bw-chat` mod's tests (phase 2, Task 8) read these files as the helper's answers.
`tests/fixtures/live/chat-tab.json` and `chat-remote.json` hold copies of the
`claude-picture` and `codex-question` answers with `terminal`, `path` and `cursor` set in
the `log` line; `tests/mods/bw-chat.test.js` fails when a copy no longer matches its
golden, so update those copies after blessing a change here. They
hold only scrubbed recording text and must pass `scripts/verify/scrub-fixture --check
tests/fixtures/feed`.
