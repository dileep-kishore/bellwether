// Writes themes/bellwether.json from shared/palette.js, the one place Bellwether's colours live.
//   bun scripts/gen-theme.js [--check]   --check fails when the file differs instead of writing it
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES, TERMINAL } from "../shared/palette.js";

const file = join(import.meta.dir, "../themes/bellwether.json");
const { background, foreground, selection, cursor, ansi } = TERMINAL;
const text = `${JSON.stringify({ background, foreground, selection, cursor, ansi, colors: { ...ROLES, background } }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== text) {
    console.error("themes/bellwether.json differs from shared/palette.js: run bun scripts/gen-theme.js");
    process.exit(1);
  }
} else writeFileSync(file, text);
