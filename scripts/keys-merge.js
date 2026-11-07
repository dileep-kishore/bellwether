// Merges keys/bellwether.json into a Herdr app home's keys.json, refusing any key the person already uses.
//   bun scripts/keys-merge.js [--apply] [--home DIR]   prints the diff; --apply writes it after a backup
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {{ [section: string]: { [key: string]: unknown } }} Keys
 * @typedef {{
 *   merged: Keys,
 *   added: [string, string, unknown][],
 *   same: [string, string, unknown][],
 *   conflicts: [string, string, unknown, unknown][],
 *   shadowed: [string, string, unknown][],
 * }} MergeResult
 */

const MODIFIERS = new Set(["cmd", "ctrl", "alt", "shift", "fn", "super", "secondary"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Modifier order and case are ignored so a differently spelled binding still counts as taken; "cmd--" ends in the "-" key.
export function keyId(key) {
  const parts = key.toLowerCase().split("-");
  let last = parts.pop();
  if (last === "" && parts.at(-1) === "") {
    parts.pop();
    last = "-";
  }
  const mods = parts.filter((p) => MODIFIERS.has(p)).sort();
  const rest = parts.filter((p) => !MODIFIERS.has(p));
  return [...mods, ...rest, last].join("-");
}

function find(section, key) {
  if (!section) return null;
  const id = keyId(key);
  const k = Object.keys(section).find((k) => keyId(k) === id);
  return k === undefined ? null : [k, section[k]];
}

function sectionOf(keys, name) {
  const s = keys[name];
  if (s === undefined) return undefined;
  if (!isObject(s)) throw new Error(`keys.json section ${name} is not an object`);
  return s;
}

/**
 * @param {Keys | null} user the person's keys.json, or null when there is none
 * @param {Keys} ours
 * @returns {MergeResult}
 */
export function mergeKeys(user, ours) {
  if (user !== null && !isObject(user)) throw new Error("keys.json is not an object");
  const merged = structuredClone(user ?? {});
  /** @type {MergeResult} */
  const r = { merged, added: [], same: [], conflicts: [], shadowed: [] };
  for (const [name, bindings] of Object.entries(ours)) {
    const theirs = sectionOf(merged, name);
    // A layout section wins over global while the layout shows, so a global binding would be taken over.
    const over = name.startsWith("layout:") ? sectionOf(merged, "global") : undefined;
    const terminal = name === "terminal" ? undefined : sectionOf(merged, "terminal");
    for (const [key, action] of Object.entries(bindings)) {
      const here = find(theirs, key);
      const below = find(over, key);
      if (here && same(here[1], action)) {
        r.same.push([name, key, action]);
        continue;
      }
      const taken = [here && [name, ...here], below && !same(below[1], action) && ["global", ...below]].filter(Boolean);
      if (taken.length) {
        for (const t of taken) r.conflicts.push([...t, action]);
        continue;
      }
      const t = find(terminal, key);
      if (t) r.shadowed.push([name, key, t[1]]);
      merged[name] = { ...(merged[name] ?? {}), [key]: action };
      r.added.push([name, key, action]);
    }
  }
  return r;
}

function parseArgs(argv) {
  const opts = { apply: false, home: process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") opts.apply = true;
    else if (argv[i] === "--home" && argv[i + 1]) opts.home = argv[++i];
    else throw new Error("usage: bun scripts/keys-merge.js [--apply] [--home DIR]");
  }
  return opts;
}

const show = (v) => JSON.stringify(v);

function main(argv) {
  const opts = parseArgs(argv);
  if (!existsSync(opts.home)) throw new Error(`no Herdr app home at ${opts.home}: open the Herdr app once first`);
  const file = join(opts.home, "keys.json");
  const oursFile = join(import.meta.dir, "../keys/bellwether.json");
  const ours = JSON.parse(readFileSync(oursFile, "utf8"));
  const exists = existsSync(file);
  let user = null;
  if (exists) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}); fix it first`);
    }
  }
  const r = mergeKeys(user, ours);

  console.log(`keys.json: ${file}${exists ? "" : " (missing)"}`);
  for (const name of Object.keys(ours)) {
    console.log(`section ${name}`);
    console.log(`  before ${show(user?.[name] ?? {})}`);
    console.log(`  after  ${show(r.merged[name] ?? {})}`);
  }
  for (const [s, k, a] of r.added) console.log(`added ${s} ${k} ${show(a)}`);
  for (const [s, k, a] of r.same) console.log(`same ${s} ${k} ${show(a)}`);
  for (const [s, k, theirs, o] of r.conflicts)
    console.log(`conflict ${s} ${k} is ${show(theirs)}, Bellwether wants ${show(o)}`);
  for (const [s, k, a] of r.shadowed)
    console.log(`shadowed ${s} ${k}: terminal binds it to ${show(a)}, which wins while a terminal has focus`);
  console.log("Herdr stops adding new default shortcuts to an edited keys.json (AGENTS.md, Keys)");

  if (r.conflicts.length) {
    console.log("not written: free or rebind the conflicting keys first");
    return 1;
  }
  if (!r.added.length) {
    console.log("nothing to change");
    return 0;
  }
  if (!opts.apply) {
    console.log("run again with --apply to write it");
    return 0;
  }
  // Writing only our section would drop the defaults Herdr keeps in this file.
  if (!exists)
    throw new Error(`no keys.json at ${file}: open the Herdr app once so it writes its keys, then run again`);
  const backup = `${file}.bw-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(file, backup);
  const tmp = `${file}.bw-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(r.merged, null, 2)}\n`);
  renameSync(tmp, file);
  console.log(`wrote ${file}; the old file is ${backup}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
