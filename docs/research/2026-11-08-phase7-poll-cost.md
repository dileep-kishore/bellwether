# Phase 7: what one poll costs, and the watcher

Run 2026-11-08 on the Mac mini (Apple M4 Pro) and on `macbook`, the SSH
machine in the Mac mini's default core, by `scripts/verify/poll-cost.sh`.
Before: the helper at 04deacf (0.6.0) here and the installed 0.5.0 on
`macbook`, whose `feed` and `diff` code is the same; 5 runs per case.
After: helper 0.7.0 built from 5503b7c on both, installed on `macbook` with
`bw machine install macbook`; 10 runs per case. Milliseconds are user plus
system CPU of the call and every Git it ran, from `getrusage`, as medians.
`/usr/bin/time -l` rounds to 10 ms and printed 0 for every `feed` read. The
paths of the files read are kept with the run's notes, not here.

| Machine | Case | Size | Before | After |
| --- | --- | ---: | ---: | ---: |
| Mac mini | `feed` Claude, first read | 158.8 MB | 9.2 | 9.0 |
| Mac mini | `feed` Claude, unchanged cursor | 158.8 MB | 3.7 | 3.8 |
| Mac mini | `feed` Claude, one appended line | 158.8 MB | 9.2 | 9.2 |
| Mac mini | `feed` Codex, first read | 39.5 MB | 7.8 | 7.8 |
| Mac mini | `feed` Codex, unchanged cursor | 39.5 MB | 3.7 | 3.8 |
| Mac mini | `feed` Codex, one appended line | 39.5 MB | 8.1 | 8.1 |
| Mac mini | `diff files`, full read | 40,610 files | 951.6 | 155.9 |
| Mac mini | `diff files --watch`, token unchanged | 40,610 files | | 9.6 |
| macbook | `feed` Claude, first read | 99.3 MB | 9.7 | 9.1 |
| macbook | `feed` Claude, unchanged cursor | 99.3 MB | 4.0 | 4.2 |
| macbook | `feed` Claude, one appended line | 99.3 MB | 10.7 | 11.2 |
| macbook | `feed` Codex, first read | 14.1 MB | 7.3 | 7.3 |
| macbook | `feed` Codex, unchanged cursor | 14.1 MB | 4.1 | 4.3 |
| macbook | `feed` Codex, one appended line | 14.1 MB | 6.9 | 8.3 |
| macbook | `diff files`, full read | 5,406 files | 170.0 | 91.8 |
| macbook | `diff files --watch`, token unchanged | 5,406 files | | 10.7 |

The largest single `feed` read was 19 ms (a first read). The largest
unchanged `--watch` poll was 12.3 ms.

## What the numbers say

- `bw feed` stays under the spec's 100 ms rule on both machines, so the chat
  keeps polling without a watcher: `bw` parses only a log's last 2 MB.
- `bw diff files` was past the rule on both. Most of its CPU was system time
  from Git's parallel stat threads (`core.preloadIndex`): on the 40,610-file
  checkout `git status` cost 480 ms with them and 113 ms without, at the
  same wall time (0.10 s against 0.11 s), and the second worktree pass
  (`git diff --numstat`) cost 430 ms, or 7 ms when limited to the paths
  status named. Both changes together cut a full read to 156 ms here and 92
  ms on `macbook`.
- `git status` alone on 40,610 files is past 100 ms, so a remote panel's
  1.5 s poll goes through the watcher: an unchanged poll costs about 10 ms,
  of which finding the worktree's top with `git rev-parse` is most. The
  watcher itself used under 10 ms of CPU (the resolution of `ps`) in its
  first seconds and wakes every 5 s to rewrite its state.
- A poll after an edit is a full read, so on a checkout this large it
  still costs about 156 ms once per change. A local panel never polls on a
  timer: it reads when Herdr's `watchFolder` reports a change.
- The project sidebar's own counts script (`git status` and `git
  diff-index`, run by `shared/git.js` on the space's machine) cost 945 ms
  on the same checkout, and 175 ms with one stat thread. It polls a remote
  selected worktree every 1.5 s and has no watcher yet.
- herdr-core gives each `hc exec` an `HC_SCOPE` variable and ends the
  processes that carry it when the call returns, whatever their session or
  process group. A watcher started with it never outlived the call on
  `macbook`; started without it, it answered later calls.
- Over SSH, reading `~/Desktop`, `~/Documents` or `~/Downloads` blocks on
  macOS's privacy prompt, which waits for someone at that machine's
  display. The script skips those folders.
