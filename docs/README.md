# Bellwether docs

The four guides at the top describe the code as it is now. Update the matching guide in the same
commit as a change to behaviour, a command or set-up. The folders below them are the design history:
they record what was asked, decided and measured, and they stay as written.

## Current reference

- [usage.md](usage.md) covers installing Bellwether and using each part of the window, the removal
  steps, and every known limit.
- [helper.md](helper.md) is the `bw` command reference: each command's flags, where it runs, and
  every output line it prints.
- [architecture.md](architecture.md) explains the pieces and how they talk: the layout, the twelve
  mods and their shared state, the helper, the machines each call runs on, request cards, Changes,
  Issues, the Browser, and what each poll costs.
- [development.md](development.md) is the reference for changing the code: the repository map, the
  toolchain, `scripts/test.sh` and CI, the headless harness, fixtures, every verify script, the
  stage window, version bumps, and the repository's rules.
- [images/](images/) holds the screenshots the top-level README shows.

The repository root holds three more current files. [RECIPE.md](../RECIPE.md) describes the window,
its behaviour and what it is built from. [REVIEW.md](../REVIEW.md) lists what a code review looks
for. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) records each file adapted from another
project.

## Design history

- [brief/2026-11-06-request.md](brief/2026-11-06-request.md) holds the user's requests verbatim.
  Never edit the quoted words.
- [specs/2026-11-06-bellwether-design.md](specs/2026-11-06-bellwether-design.md) is the design spec.
- [specs/2026-11-06-bellwether-design-intent.md](specs/2026-11-06-bellwether-design-intent.md)
  records the user's answers behind the design spec.
- [specs/2026-11-07-bellwether-visual-overhaul.md](specs/2026-11-07-bellwether-visual-overhaul.md)
  is the spec for the Catppuccin Mocha look.
- [specs/2026-11-07-bellwether-visual-overhaul-intent.md](specs/2026-11-07-bellwether-visual-overhaul-intent.md)
  records the user's answers behind the look's spec.
- [plans/2026-11-06-bellwether-phases.md](plans/2026-11-06-bellwether-phases.md) is the plan that
  split the work into phases.
- [plans/2026-11-06-bellwether-phases-intent.md](plans/2026-11-06-bellwether-phases-intent.md)
  records the user's answers behind the later phases.
- [plans/2026-11-06-bellwether-phase-0.md](plans/2026-11-06-bellwether-phase-0.md) is the
  implementation plan for the foundation.
- [plans/2026-11-06-bellwether-phase-1.md](plans/2026-11-06-bellwether-phase-1.md) is the
  implementation plan for the window and project sidebar.
- [plans/2026-11-06-bellwether-phase-2.md](plans/2026-11-06-bellwether-phase-2.md) is the
  implementation plan for chat tabs.
- [plans/2026-11-06-bellwether-phase-3.md](plans/2026-11-06-bellwether-phase-3.md) is the
  implementation plan for sub-agents and requests.
- [plans/2026-11-06-bellwether-phase-4.md](plans/2026-11-06-bellwether-phase-4.md) is the
  implementation plan for the browser.
- [research/2026-11-06-reference-survey.md](research/2026-11-06-reference-survey.md) records what
  Flockbook, Shepherdr, herdr-t3 and Herdr's example layouts do, with file paths.
- [research/2026-11-06-phase0-spike.md](research/2026-11-06-phase0-spike.md) tested per-session agent
  flags and the isolated stage window.
- [research/2026-11-06-phase2-feed.md](research/2026-11-06-phase2-feed.md) measured what one
  `bw feed` read costs.
- [research/2026-11-06-phase3-requests.md](research/2026-11-06-phase3-requests.md) recorded where
  approvals show on screen and what the hooks receive.
- [research/2026-11-07-phase4-browser.md](research/2026-11-07-phase4-browser.md) tested Chrome's
  DevTools endpoints, Chrome DevTools MCP 1.12.0, agent logs and a scratch `sshd`.
- [research/2026-11-08-phase7-poll-cost.md](research/2026-11-08-phase7-poll-cost.md) measured what
  each poll costs and added the Git watcher.

Plans, review reports and summary pages for the user stay untracked under `docs/drafts/`, which
`.gitignore` ignores.
