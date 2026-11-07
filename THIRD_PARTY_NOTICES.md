# Third-party notices

Code copied or adapted from other projects, with its source and license.
Add one entry per borrowed file: the file here, its source path, the source
commit, and the copyright line from that project's LICENSE.

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
