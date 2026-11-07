# Hook fixtures

Made by hand for `crates/bw/tests/hooks.rs`, except `codex-trusted-hash.json`.

- `settings-before.json`: a Claude `settings.json` with the user's own
  `PreToolUse` group, Orca's groups and other keys, in the 2-space JSON
  `bw hooks` writes, so `remove` after `apply` gives back its bytes.
- `codex-hooks-before.json`: a Codex `hooks.json` of the same shape.
- `config-trusted.toml`: the `[hooks.state]` entries Codex records once the
  user trusts Bellwether's four groups in `codex-hooks-before.json`. The test
  replaces `@HOOKS@` with the absolute `hooks.json` path. The
  `PreToolUse` hash is computed with the identity in
  `codex-trusted-hash.json`; the other three are the ones Codex wrote.
- `codex-trusted-hash.json`: recorded by `scripts/verify/requests-probe.sh`
  case (f), the known answer for `trusted_hash`.
