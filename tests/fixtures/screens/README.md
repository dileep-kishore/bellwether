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

Recorded by `scripts/verify/record-wrap.sh` on 2026-11-07 (Claude Code 2.1.319 with haiku, Codex 0.167.0):
each prompt read at 80 columns, then from the same terminal after a viewer narrowed it, as a pane narrows
in the window. `bw` reads `hc read --json`'s text, so the notes `hc read` adds are left out.

| File | What shows |
| --- | --- |
| `claude-approval-80.txt` | A Claude approval for a long `touch` command at 80 columns. |
| `claude-approval-52.txt` | The same prompt at 52 columns: the command and option 2 wrap inside words, the tip over two lines. The scratch path in option 2 wrapped inside `claude-501`, which the scrubber cannot see, so it was rewritten by hand to the 80-column file's `/tmp/bw-wrap/claude-approval`, moving that line break. |
| `codex-approval-80.txt` | A Codex escalation approval for the same command at 80 columns. |
| `codex-approval-52.txt` | The same prompt at 52 columns: the command wraps inside a word. |
| `codex-new-folder-80.txt` | The `/new` folder prompt at 80 columns, with descriptions. |
| `codex-new-folder-24.txt` | The same prompt at 24 columns: the question over two lines, each option over two, and no descriptions. |
| `codex-new-folder-15.txt` | The same prompt in a real chat tab's terminal, which is 15 columns wide behind the chat (read with `hc read --json` in the window run on 2026-11-07): the question breaks inside "conversation". |
| `claude-approval-pair-34.txt`, `claude-approval-pair-16.txt` | One Claude approval in a chat tab's terminal at 34 columns, then after its pane was narrowed to 16 in the window run on 2026-11-07: the question wraps, option 2 reads `2.Yes, and` and loses "this project", and the scratch path breaks inside words. |
| `claude-approval-headcut-15.txt` | A general-purpose sub-agent's Bash approval for `touch fg.txt` in a real chat tab's terminal, 15 columns wide behind the chat (read with `hc read` in the stage window on the Mac mini on 2026-11-08, Claude Code 2.1.319). The box is taller than the terminal, so its top rule and most of its wrapped header ("Bash command · from the general-purpose agent") scrolled off, and the screen starts at "rpose". Both dashed rules around the command stay on screen. The scratch path in option 2 wrapped inside words, so it was rewritten by hand to `/scratch` and `/alpha` on two lines. |

Made by hand for `crates/bw/tests/matchers.rs`, not recorded:

| File | Made from | What changed |
| --- | --- | --- |
| `codex-approval-cursor-2.txt` | `tests/fixtures/sessions/codex-approval/screen-approval.txt` | The cursor `›` moved from option 1 to option 2. |
| `codex-new-folder-cursor-2.txt` | `codex-new-folder.txt` | The cursor `›` moved from option 1 to option 2. |
| `codex-approval-wrapped.txt` | The layout of `screen-approval.txt` at 80 columns | A longer command whose `$` line, reason and option 2 wrap; the command breaks inside a word. Codex's own wrapping of these lines was never recorded, so the continuation indents are a guess. |
