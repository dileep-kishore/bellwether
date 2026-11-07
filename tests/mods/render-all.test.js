// Every mod in mods/bw-* mounts and renders under every live fixture and props set.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { live, mount, repo } from "../harness/mount.js";
import { isElement } from "../harness/kit-stub.js";
import propsSets from "../fixtures/live/props.json";

const mods = readdirSync(join(repo, "mods"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("bw-") && existsSync(join(repo, "mods", d.name, "main.js")))
  .map((d) => d.name)
  .sort();
const fixtures = readdirSync(join(repo, "tests/fixtures/live"))
  .filter((f) => f.endsWith(".json") && f !== "props.json")
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

test(`found ${mods.length} mods and ${fixtures.length} live fixtures`, () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

for (const name of mods) {
  describe(name, () => {
    for (const fixture of fixtures) {
      for (const props of propsSets[name] ?? [{}]) {
        test(`${fixture} ${JSON.stringify(props)}`, async () => {
          const m = await mount(name, { props, live: live(fixture) });
          expect(isElement(m.render())).toBe(true);
        });
      }
    }
  });
}
