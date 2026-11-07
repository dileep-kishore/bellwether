// Sets the top-level developer_instructions in the text of a Codex config.toml, leaving every other line as written.
//   bun scripts/verify/codex-config.js <config.toml> <value>   prints the result; a missing file counts as empty
import { readFileSync } from "node:fs";

const KEY = /^\s*(?:developer_instructions|"developer_instructions"|'developer_instructions')\s*=\s*/;
const MULTI = ['"""', "'''"];

// Index of the delimiter that closes a multi-line string in s, or -1; only basic strings have escapes.
function closeAt(s, delim, from = 0) {
  for (let i = s.indexOf(delim, from); i >= 0; i = s.indexOf(delim, i + 1)) {
    if (delim === "'''") return i;
    let slashes = 0;
    while (i - slashes - 1 >= 0 && s[i - slashes - 1] === "\\") slashes++;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

// The multi-line delimiter a value starting at rest opens and leaves open on its line, or null.
function opens(rest) {
  const delim = MULTI.find((d) => rest.startsWith(d));
  return delim && closeAt(rest, delim, 3) < 0 ? delim : null;
}

export function setDeveloperInstructions(text, value) {
  const before = Bun.TOML.parse(text);
  const lines = text.split("\n");
  const line = `developer_instructions = ${JSON.stringify(value)}`;
  let open = null;
  let start = -1;
  let end = -1;
  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (open) {
      if (closeAt(l, open) >= 0) {
        open = null;
        if (start >= 0 && end < 0) end = i;
      }
      continue;
    }
    if (/^\s*\[/.test(l)) {
      header = i;
      break;
    }
    const key = start < 0 && l.match(KEY);
    if (key) {
      start = i;
      open = opens(l.slice(key[0].length));
      if (!open) end = i;
      continue;
    }
    const eq = l.indexOf("=");
    if (eq >= 0 && !/^\s*#/.test(l)) open = opens(l.slice(eq + 1).trimStart());
  }

  if (start >= 0 && end >= 0) {
    lines.splice(start, end - start + 1, line);
  } else if (header >= 0) {
    lines.splice(header, 0, line, "");
  } else {
    lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
  }
  const out = lines.join("\n");

  // The scan is textual, so a form it misreads must fail here, not reach Codex as a changed config.
  let after;
  try {
    after = Bun.TOML.parse(out);
  } catch {
    after = undefined;
  }
  if (!Bun.deepEquals(after, { ...before, developer_instructions: value })) {
    throw new Error("could not set the top-level developer_instructions without changing anything else");
  }
  return out;
}

if (import.meta.main) {
  const [file, value] = process.argv.slice(2);
  if (!file || value === undefined) {
    console.error("usage: bun scripts/verify/codex-config.js <config.toml> <value>");
    process.exit(2);
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  process.stdout.write(setDeveloperInstructions(text, value));
}
