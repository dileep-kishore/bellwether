# The `bw` helper

`bw` is the Rust program in `crates/bw` that the mods run for work a mod cannot do itself, such as
reading session logs, answering prompts, driving Chrome and calling Linear. Each machine runs its own copy at `~/.local/share/bellwether/helper/current/bw`.
[Install](usage.md#install) says how to put it there, and
[The helper on each machine](architecture.md#the-helper-on-each-machine) explains the version check.

## How output works

Every command prints JSON lines on standard output, one object per line. Each line names its kind
in a `type` field. A `bw feed` row has `type` `row` and a `k` field that names the row's kind, such
as `user`, `assistant` or `tools`. `bw version` prints one object without a `type`.

A usage error prints one line, `{"type":"error","code":"usage","message":…}`, and exits 2. Any
other failure prints one `error` line with a `code` and a `message` and exits 1. `bw diff` reports a
usage error after its subcommand the same way as its other failures: an `error` line with code
`usage`, and exit 1. Most `bw browser …` commands print a line for every state and exit 0, so that
a mod can show the state. The exceptions exit non-zero: a usage error, `tabs` when the port holds no
Bellwether Chrome, a failed `port-check` and a `free-port` that finds no port.

Each command runs on one of two machines:

- The space's machine, the one that holds the space's terminal or worktree: `feed`, `locate`, `send`,
  `picture-read`, `tree`, `cards`, `answer`, `counts`, `hooks`, `event`, `diff`, `agent`,
  `browser free-port` and `browser port-check`. A mod runs these there through
  `exec(..., { on })`, and the window machine's `bw` runs `agent`, `free-port` and `port-check`
  there with `hc exec`.
- The window machine, the one showing the Herdr window: `picture`, `browser` (all but `free-port` and
  `port-check`), `linear` and `machine`.

[Machines and where code runs](architecture.md#machines-and-where-code-runs) gives the reasons.

`bw` keeps its caches under `~/.cache/bellwether`, and `BW_CACHE_DIR` replaces that folder.
`BW_HC` names the program `bw` runs in place of `hc`. Other `BW_*` variables, such as
`BW_CHROME_PORT` and `BW_CHROME_PROFILE`, point `bw` at test ports, folders and programs.

## Feed and chat

```sh
bw feed (--terminal <t> [--session <child>] | --log <path> --agent claude|codex [--scope root|claude-subagent|codex-child:<ordinal>]) [--cursor <c> | --before <start>] [--pictures] [--tree] [--cards]
bw locate --terminal <t> [--fresh]
bw send --terminal <t> --expect-kind <claude|codex> --expect-session <id|none> --expect-path <log|none> --text <message>
bw picture --terminal <[machine/]t> --offset <n> --index <i> --digest <16 hex>
bw picture-read --terminal <t> --offset <n> --index <i> --digest <16 hex>
bw tree (--terminal <t> | --log <path> --agent claude|codex)
```

A chat tab uses these. Each takes the terminal's local address and runs on the space's machine,
except `bw picture`.

### `bw locate`

`bw locate` names the agent, the session and the log a terminal writes. It prints one `located` line
with `terminal`, `agent`, `session`, `path`, `pid` and `status`, or one `state` line as `bw feed`
does. It keeps what it found per terminal in `~/.cache/bellwether/feeds/` and trusts it for 30 s
without a process scan. `--fresh` scans anyway.

### `bw feed`

`bw feed` prints a `log` line (`agent`, `terminal`, `session`, `path`, `start`, `size`, `cursor`, and
`model` when the log names one). Then it prints `unchanged`, or a `splice` line with `at` and `count`
followed by the rows from `at` on. Pass the last `cursor` back with `--cursor` to get `unchanged` or
only the changed rows.

With nothing to read it prints one `state` line instead:

| `state` | Meaning |
|---|---|
| `no_core` | No `hc` core answers. |
| `no_terminal` | The terminal is not live. |
| `not_agent` | The terminal runs no Claude or Codex. |
| `no_log` | The agent has written no log yet. The line has `session` when the agent names its new conversation. |
| `ambiguous` | No single conversation was found. `bw send` refuses in this state. |
| `no_child` | `--session <child>` names a sub-agent with no log. |

The options:

- `--session <child>` feeds that sub-agent's log.
- `--log <path> --agent claude|codex` reads a log file directly. `--scope` picks the root
  conversation, a Claude sub-agent file or a Codex child by ordinal.
- `--before <start>` prints an `older` line (`path`, `start`, `count`) and the rows of the 2 MB
  before `start`. It takes no `--cursor`, `--tree` or `--cards`.
- `--pictures` reads the rows with each picture's place in the log, which `bw picture` takes.
- `--tree` adds one `tree` line before the rows. It reads a root log only.
- `--cards` adds the `cards` and `request` lines of [`bw cards`](#bw-cards) after the rows. It needs
  `--terminal`.

A chat polls with one `bw feed --tree --cards` call, which carries the session tree and the requests
with the rows.

### `bw send`

`bw send` sends `--text` to the terminal only while the terminal's conversation matches the
`--expect-*` values. It prints one `send` line with `result` and `message`:

| `result` | Meaning |
|---|---|
| `sent` | The text went to the terminal. |
| `refused-conversation` | The agent kind, session or log path differ from the expected ones. Nothing was sent. |
| `refused-prompt` | The terminal waits on a prompt. Nothing was sent. |
| `unconfirmed` | `hc send` did not answer in time. Delivery is unknown: the text may still arrive. |

`--text` takes any value, including one that starts with `-`. `none` for `--expect-session` or
`--expect-path` means a conversation that has no log yet.
[Sending a message](architecture.md#sending-a-message) explains how a chat picks these values.

### `bw picture` and `bw picture-read`

`bw picture` runs on the window machine. It reads the picture through `bw picture-read` on the
space's machine (in process when the space is local, `[machine/]t` naming the machine otherwise) and
copies it into Herdr's app home under `data/bellwether/pictures/`. It prints one `picture` line with
`digest`, `file` and `bytes`, or a `picture` line with a `state`. The `state` is `gone` when the log
holds no picture with that digest at that place, `unreachable` when the space's machine does not
answer, or `too_big` (with `bytes`) past 4 MB. A missing app home is an `error` line with code
`no_app_home`.

`bw picture-read` prints one `picture-data` line with `digest`, `format`, `bytes` and the picture's
`base64`, or the same `picture` state lines.

### `bw tree`

`bw tree` lists a session's sub-agents from Claude's `subagents/*.meta.json` files and Codex's
sub-agent records. It prints one `tree` line with `agent`, `root` and `children`. Each child has its
`id`, `parent`, `depth`, `type`, `description` and `state` (`running` or `done`), with its start and
end times.

## Requests

```sh
bw cards --terminal <t>
bw answer --terminal <t> --request <id> --expect-kind <claude|codex> --expect-session <id|none> --expect-path <log|none> (--action approve|always|deny|option-<n> | --answers <json>)
bw counts --terminals <t1,t2,…>
bw hooks check|diff|apply [--expect-sha <claude sha>,<codex sha>]|remove [--claude-settings <file>] [--codex-hooks <file>]
bw event --agent claude|codex
```

All five run on the space's machine. `cards`, `answer` and `counts` take the terminal's local
address. `bw answer` runs there for
the same reason `bw send` does: its last screen read and its key press are one local step.
[Request cards](architecture.md#request-cards) explains how cards are found and answered.

### `bw cards`

`bw cards` prints one `cards` line for the terminal (`agent`, `session`, `path`, `status`, `hooks`
and whether it read the `screen`), then one `request` line per card. A `request` line has the card's
`id`, `kind`, `state`, `answerable` and `reason`, who asks, its title, command, detail, actions and
question. The `state` is one of:

| `state` | Meaning |
|---|---|
| `pending` | The prompt waits on an answer. |
| `answered`, `declined` | Bellwether's key or message went out. |
| `answered_terminal`, `declined_terminal` | The box left, and the call's result in the log says how it was answered. |
| `settling` | The box left and the log has no result yet, for up to 5 s. |
| `stale` | The box left and no result came. |
| `uncertain` | Keys went out and the screen did not show the box leave. |

`bw cards` reads the screen only while `hc get` says `blocked` (and, for Codex's folder prompt,
whenever Codex is not working). It keeps each prompt's state in `~/.cache/bellwether/requests/` for
24 h.

### `bw answer`

`bw answer` presses keys only after a fresh screen read shows the same prompt the card showed, with
`bw send`'s conversation checks. `--action` answers an approval or picks an option; `--answers`
answers a question card. It prints one `answer` line with `result`, `state` and `message`, and gives
up at 25 s. The `result` is one of `answered`, `declined`, `stale`, `uncertain`,
`refused-conversation`, `refused-agent`, `refused-prompt`, `already-answered`, `busy`,
`not-answerable` or `failed`. A `stale` answer says "Changed on screen; nothing was pressed".

### `bw counts`

`bw counts` prints one `count` line per terminal (at most 64) with its `subagents` (running) and
`requests` (waiting). It reads no screen. The project sidebar runs it on each machine every 10 s.

### `bw hooks` and `bw event`

`bw hooks` checks, shows, applies or removes Bellwether's hook groups on the machine it runs on. Its
lines are the ones [`bw machine setup`](#bw-machine) relays. `--claude-settings <file>` and
`--codex-hooks <file>` point it at other files, and `--expect-sha` goes with `apply` only.
[Hooks](architecture.md#hooks) describes the files and markers.

`bw event` is what the hook `hooks/bw-event` runs. It reads the hook's payload on standard input,
writes one file per event under `~/.cache/bellwether/events/<terminal>/` (24 h, at most 2,000
files), prints nothing past a usage error and exits 0.

## `bw diff`

```sh
bw diff files --path <dir> [--base <ref>] [--mode merge-base|tip] [--select staged|changes|committed --file <path> [--old <path>]] [--watch [--since <token>]]
bw diff patch --path <dir> --section staged|changes|committed --file <path> [--old <path>] [--untracked] [--from <rev> --to <rev>] [--page <n>]
bw diff refs --path <dir> [--verify <ref>]
bw diff fetch --path <dir> [--remote <name> | --base <ref>]
```

`bw diff …` runs on the space's machine. [Changes](architecture.md#changes) explains the watcher
and the Git flags every call uses.

- `files` prints a `diff-place` line, a `diff-base` line and one `diff-file` line per row. A section
  past 2,000 files, or past the 4 MiB all three lists share, adds a `diff-more` line with the count
  left out.
- With `--select`, `files` adds a `diff-digest` line for the selected file's patch. Its digest is
  `too_large` for a patch over 256 MiB, and `unreadable` with Git's error when Git cannot read the
  file. The lists still print.
- With `--watch`, `files` starts the worktree's watcher when none runs. A full read made while the
  watcher runs ends with a `diff-token` line; the read that starts it has none. A call that sends that
  token back with `--since` prints one `diff-unchanged` line in place of the lists while nothing
  changed.
- `patch` prints one `diff-patch` line with the `page`, the page count (`pages`), the patch's size
  (`bytes`) and `digest`, the `text`, and the lines left out (`cut`). Committed needs `--from` and
  `--to`, and an untracked file needs `--untracked`.
- `refs` prints up to 200 `diff-ref` lines, or one `diff-ref-ok` line with `--verify`. A ref that
  names no commit is an `error` line with code `bad_ref`.
- `fetch` prints a `diff-fetched` line naming the remote. It is the only `bw diff` command that
  writes to the repository.

`--base`, `--file`, `--old` and `--verify` take any value, including one that starts with `-`. A
failure prints one `error` line and exits 1. Its codes include `usage`, `not_git`, `bad_ref`,
`git_failed`, `fetch_failed` and `watch_failed`.

## `bw linear`

```sh
bw linear projects
bw linear issues --scope project|mine|all [--project <id>] [--after <cursor>]
bw linear search --text <words> --scope project|mine|all [--project <id>] [--after <cursor>]
bw linear issue --id <identifier> [--text [--trim | --put <terminal>]]
```

`bw linear …` runs on the window machine and reads the key from its login Keychain.
[Issues](architecture.md#issues) explains how the key reaches Linear.

- `projects` prints one `linear-project` line per project (up to 250) and a `linear-done` line.
- `issues` and `search` print one `linear-issue` line per open issue and a `linear-page` line with the
  next page's cursor (`next`). `--scope project` needs `--project <id>`.
- `issue` prints one `linear-issue` line with the issue's description and its size in `bytes`.
- `issue --text` prints one `linear-text` line holding the text a chat's Send uses. `--trim` cuts a
  description over 8 KB to 8 KB, and `--put <terminal>` places the description beside that terminal
  with `hc put` and names its path.

`linear-done`, `linear-page` and the `issue` line carry `cached` and `age_s`, which say whether the
answer came from the cache and how old it is.

A failure prints one `error` line and exits 1. Its `code` is one of:

| `code` | Meaning |
|---|---|
| `no_key` | No key is stored in the Keychain. |
| `key_refused` | Linear refused the key. |
| `offline` | Linear is unreachable and nothing is cached. |
| `rate_limited` | Linear's rate limit was reached. |
| `not_found` | Linear has no such issue. |
| `too_large` | The description is over 8 KB and neither `--trim` nor `--put` was given. |
| `put_failed` | `hc put` failed. |
| `linear_failed` | Any other failure. |

Bellwether never writes to Linear.

## `bw browser`

```sh
bw browser up [--background] | down
bw browser status                                   # chrome line, one tab line per page, one forward line per forward
bw browser tabs | focus --id <id> | close --id <id> | new [--url <url>]
bw browser arrange [--owner-pid <pid>]
bw browser agent-args --kind claude|codex --machine <m|""> [--cwd <dir>] [--profile <p>]
bw browser forward ensure --machine <m>
bw browser forward dev --machine <m> --port <n>
bw browser forward stop --machine <m> [--dev <n>]
bw browser forward list
bw browser free-port [--prefer <port>]
bw browser port-check --port <port> --browser-id <id>
```

`bw browser …` runs on the window machine, except `free-port` and `port-check`, which run on the
space's machine. [Starting and reusing Chrome](architecture.md#starting-and-reusing-chrome) explains
the listener check, [Forwards to other machines](architecture.md#forwards-to-other-machines) the
forwards and [Agent flags](architecture.md#agent-flags) what `agent-args` adds.

- `up` and `down` print one `chrome` line with `state`, `port`, `profile`, `pid`, `browser_id`,
  `version`, `started` and `message`. The `state` is `running` or `stopped`, or one of the states in
  which `up` starts nothing: `port_taken` (another program holds the port; the message names its pid
  and command), `no_debug_port` (the profile runs without the port), `not_installed` (no Google
  Chrome) and `start_failed` (Chrome did not start or answer). `--background` starts Chrome without
  taking focus. `down` closes only the Bellwether Chrome.
- `status` prints the `chrome` line, one `tab` line per page (`id`, `title`, `url`, `favicon`,
  `active`) and one `forward` line per forward.
- `tabs` prints one `tab` line per page. `focus`, `close` and `new` print one `tab-action` line with
  `action`, `id`, `ok` and `message`. When the port holds anything but the Bellwether Chrome, these
  send nothing: the `tab-action` line says `ok:false` with the state in its message, and `tabs`
  prints a `chrome_unreachable` error.
- `arrange` prints one `arrange` line whose `state` is `placed`, `chrome_not_running`,
  `no_herdr_window`, `unsupported` (any platform but macOS) or `failed`.
- `agent-args` prints one `agent-args` line with `browser` (`ready` or `unavailable`), the `reason`
  when unavailable, and the `argv` to add to the agent's command. `--machine ""` means the window
  machine.
- `forward ensure`, `dev`, `stop` and `list` print `forward` lines with `kind` (`browser` or `dev`),
  `machine`, `target`, `port`, `state`, `reason` and `terminal`. The `state` is one of `starting`,
  `ready`, `ready_no_answer`, `reconnecting`, `refused`, `port_taken` or `stopped`, or, when no
  forward starts, `offline` (the machine does not answer), `via` (`hc` reaches it through `via`) or
  `local_port_taken` (a `dev` forward's local port is in use). `stop` runs
  `hc kill` and `hc rm` on the forward's terminal and deletes its state file.
- `free-port` prints a `free-port` line with `port`, or a `no_free_port` error.
- `port-check` prints a `port-check` line with `ok` and `reason`, and exits 1 when the check fails.

The forward's own terminal runs `bw browser forward keep`, the supervisor. Nobody runs it by hand.

## `bw agent`

```sh
bw agent ensure --window <w> [--port <p> --browser-id <id>] [--no-warm]
bw agent args --kind claude|codex --window <w> [--cwd <dir>] [--profile <p>]
bw agent warm
```

`bw agent …` runs on the space's machine, where the window machine's `bw` runs it with `hc exec`.
[Agent files](architecture.md#agent-files) lists the files it writes.

- `ensure` writes the agent files under `~/.local/share/bellwether/agent/` and prints one
  `agent-files` line with `changed` and `warm`. `--port` and `--browser-id` go together. `warm` is
  `done`, `skipped` (already warm) or `failed`, and `needed` with `--no-warm` when no warm-up has
  run.
- `args` prints one `agent-args` line with `kind` and the `argv` one session adds. It fails with
  `node_missing` when `npx` is not found, and with `codex_config_unreadable` when Codex's
  `config.toml` does not parse.
- `warm` fetches Chrome DevTools MCP into the npx cache and prints one `agent-warm` line. Its `warm`
  is `running` when another warm-up is in progress.

`--window` takes 1 to 32 of a-z, 0-9 and -.

## `bw machine`

```sh
bw machine status <machine>             # current, missing, outdated, unreachable or no_build
bw machine install <machine> [--force]  # copy this machine's bw there through hc
bw machine setup <machine|local> --check    # {"type":"hooks","claude":…,"codex":…,"agent":…}
bw machine setup <machine|local> --diff     # one hooks-diff line per file, with its sha256
bw machine setup <machine|local> --apply [--expect-sha <claude sha>,<codex sha>]
bw machine setup <machine|local> --remove
bw machine setup <machine|local> --agent
```

`bw machine …` runs on the window machine and reaches the other machine with `hc`. `local` names
the window machine itself, and runs setup in process.

- `status` prints one `machine` line with `state` (`current`, `missing`, `outdated`, `unreachable`
  or `no_build`), the `remote` helper's `bw version`, `uname` and `target`.
- `install` prints `progress` lines (`step`, and `part` and `parts` while it copies), then one
  `installed` line with `version`, `target`, `sha256`, `bytes` and `parts`. A machine already
  current gets `"already":true` unless `--force` is given. A failure is an `error` line naming the
  `machine`, with codes such as `unreachable` and `no_build`.
- `setup` takes exactly one of `--check`, `--diff`, `--apply`, `--remove` and `--agent`.
- `--check` prints one `hooks` line. `claude` and `codex` are `ok`, `missing` or `outdated`, and
  `codex` is `untrusted` until you trust the hook in Codex; a `codex_trust` list then names the
  untrusted groups. `agent` is `ok`, `missing` or `outdated` for the agent files.
- `--diff` prints one `hooks-diff` line per file with `agent`, `path`, `sha256`, `changed` and the
  `diff`.
- `--apply` prints one `hooks-applied` line per file with `changed` and the `backup` path. With
  `--expect-sha`, a file whose SHA-256 differs is refused with `changed_since_diff` and nothing
  changes.
- `--remove` prints one `hooks-removed` line per file.
- `--agent` runs `bw agent ensure` on that machine with this machine's window name and prints its
  `agent-files` line. It changes no user setting and needs no approval.

When the other machine has no helper, setup prints a `no_helper` error. [Hooks](usage.md#hooks)
shows the same steps from the chat's dock.

## `bw version`

```sh
bw version   # {"protocol":8,"version":"0.8.0","build":"<commit>","target":"<target triple>"}
```

`shared/helper.js` needs version 0.8.0 and protocol 8. When another machine's helper is missing or
outdated, a mod runs this Mac's `bw machine install <machine>` and checks again.

## Commands and flags kept for tests and internal use

`bw` runs the first two itself. `scripts/verify/browser.sh` and the tests in `crates/bw/tests` use
the flags. Nobody runs these by hand.

- `bw browser forward keep --machine <m> --target <t> --port <p> [--kind browser|dev] [--ssh-config <file>]`
  is the supervisor a forward's terminal runs.
- `bw diff watch --path <dir> [--dir <common dir>]` is the detached watcher that `files --watch`
  starts.
- `--target <t>` and `--ssh-config <file>` on `bw browser agent-args`, `forward ensure` and
  `forward dev` point a forward at a scratch `sshd`.
- `--window <w>` on `bw browser agent-args` gives a verify run its own agent files.
