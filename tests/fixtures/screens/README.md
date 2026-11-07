# Recorded screens

`hc read` of a real Codex 0.167.0 terminal, saved by `scripts/verify/requests-probe.sh` on
2026-11-07 and rewritten by `scripts/verify/scrub-fixture` (home `/home/user`, scratch folders
`/scratch/<name>`). `docs/research/2026-11-06-phase3-requests.md` describes each case.

| File | Case | What shows |
| --- | --- | --- |
| `codex-hooks-review.txt` | (f) | The startup dialog for an untrusted `hooks.json`: "Hooks need review", options `1. Review hooks`, `2. Trust all and continue`, `3. Continue without trusting (hooks won't run)`. |
| `codex-hooks-untrusted.txt` | (f) | `/hooks` before trusting: the event table with a Review column and `t trust all · enter review · esc close`. |
| `codex-hooks-trusted.txt` | (f) | `/hooks` after `t`: every hook Active, no Review column. |
| `codex-new-folder.txt` | (j) | The `/new` folder prompt, "Where should the new conversation run?", with `1. Use current Git worktree` and `2. Create new Git worktree`, before any key. |
| `codex-new-worktree-after.txt` | (j) | The screen after `2`: "Working directory changed to: <CODEX_HOME>/worktrees/<id>/<repository>". |
| `codex-approval-bwloop.txt` | (i) | A root approval in a terminal on the loopback machine bwloop. |

Made by hand for `crates/bw/tests/matchers.rs`, not recorded:

| File | Made from | What changed |
| --- | --- | --- |
| `codex-approval-cursor-2.txt` | `tests/fixtures/sessions/codex-approval/screen-approval.txt` | The cursor `›` moved from option 1 to option 2. |
| `codex-new-folder-cursor-2.txt` | `codex-new-folder.txt` | The cursor `›` moved from option 1 to option 2. |
| `codex-approval-wrapped.txt` | The layout of `screen-approval.txt` at 80 columns | A longer command whose `$` line, reason and option 2 wrap; the command breaks inside a word. Codex's own wrapping of these lines was never recorded, so the continuation indents are a guess. |
