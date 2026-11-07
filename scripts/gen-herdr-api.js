#!/usr/bin/env bun
// Extracts the names Herdr's type files declare into tests/harness/api.json, which the headless
// harness checks mods against. Regenerate it when Herdr updates.
//   bun scripts/gen-herdr-api.js [--from DIR] [--out FILE] [--herdr-app VERSION]
// DIR defaults to $HERDR_APP_HOME, else ~/.config/herdr-app, else docs/drafts/herdr-api.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ from: string|null, out: string, herdrApp: string|null }} */
  const o = { from: null, out: join(repo, "tests/harness/api.json"), herdrApp: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--from" && v) {
      o.from = resolve(v);
      i++;
    } else if (a === "--out" && v) {
      o.out = resolve(v);
      i++;
    } else if (a === "--herdr-app" && v) {
      o.herdrApp = v;
      i++;
    } else
      throw new Error(`usage: gen-herdr-api.js [--from DIR] [--out FILE] [--herdr-app VERSION] (bad argument ${a})`);
  }
  return o;
}

/** @param {string|null} from */
function sourceDir(from) {
  if (from) return from;
  const candidates = [
    process.env.HERDR_APP_HOME,
    join(homedir(), ".config/herdr-app"),
    join(repo, "docs/drafts/herdr-api"),
  ];
  for (const c of candidates) if (c && existsSync(join(c, "herdr.d.ts"))) return c;
  throw new Error("no Herdr API files found: pass --from DIR");
}

/** Lines of the `declare module "<name>" { … }` block, which ends at the first `}` in column 0.
 * @param {string[]} lines @param {string} name */
function moduleBlock(lines, name) {
  const start = lines.indexOf(`declare module "${name}" {`);
  if (start < 0) throw new Error(`gpui-kit.d.ts has no module "${name}"`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("}"));
  return lines.slice(start + 1, end);
}

/** @param {string[]} lines @param {string} indent */
function exportsOf(lines, indent) {
  const values = new Set();
  const types = new Set();
  const re = new RegExp(
    `^${indent}export (?:declare )?(?:abstract )?(function|const|let|var|class|namespace|enum|interface|type) ([A-Za-z_$][\\w$]*)`,
  );
  for (const l of lines) {
    const m = re.exec(l);
    if (!m) continue;
    (m[1] === "interface" || m[1] === "type" ? types : values).add(m[2]);
  }
  return { values: [...values].sort(), types: [...types].sort() };
}

/** @param {string[]} kit */
function elementMethods(kit) {
  const start = kit.indexOf("  export interface NativeElement {");
  if (start < 0) throw new Error("gpui-kit has no interface NativeElement");
  const end = kit.findIndex((l, i) => i > start && l === "  }");
  const body = kit.slice(start + 1, end);
  const methods = new Set();
  const declare = new Set();
  for (const l of body) {
    // Most methods are generic (`name<Self …>(`); a few are not (`token(`).
    const m = /^ {4}([a-z_0-9]+)[<(]/.exec(l);
    if (m) methods.add(m[1]);
    const d = /^ {4}([a-z_0-9]+)<[^(]*\(this: Self, declare: \(el/.exec(l);
    if (d) declare.add(d[1]);
  }
  return { element: [...methods].sort(), elementDeclare: [...declare].sort() };
}

/**
 * Member names of each `export interface X {…}` and `export const X: {…}` in a module block, so the
 * harness can refuse a method a host object does not declare.
 * @param {string[]} lines
 */
function membersOf(lines) {
  /** @type {Record<string, string[]>} */
  const interfaces = {};
  /** @type {Record<string, string[]>} */
  const consts = {};
  const member = /^ {4}(?:readonly )?([A-Za-z_$][\w$]*)\??\s*[<(:]/;
  for (let i = 0; i < lines.length; i++) {
    const one = /^ {2}export const ([A-Za-z_$][\w$]*): \{ (.*) \};\s*$/.exec(lines[i]);
    if (one) {
      consts[one[1]] = [...one[2].matchAll(/(?:^|;\s*)([A-Za-z_$][\w$]*)\??\s*[:(]/g)].map((x) => x[1]).sort();
      continue;
    }
    const iface = /^ {2}export interface ([A-Za-z_$][\w$]*)\b[^{]*\{\s*$/.exec(lines[i]);
    const obj = iface ? null : /^ {2}export const ([A-Za-z_$][\w$]*): \{\s*$/.exec(lines[i]);
    const head = iface ?? obj;
    if (!head) continue;
    const names = new Set();
    let j = i + 1;
    for (; j < lines.length && lines[j] !== "  }" && !lines[j].startsWith("  };"); j++) {
      const m = member.exec(lines[j]);
      if (m) names.add(m[1]);
    }
    (iface ? interfaces : consts)[head[1]] = [...names].sort();
    i = j;
  }
  return { interfaces, consts };
}

/** @param {string} dir @param {string|null} herdrApp */
export function generate(dir, herdrApp = null) {
  const read = (/** @type {string} */ f) => readFileSync(join(dir, f), "utf8");
  const herdrDts = read("herdr.d.ts");
  const kitLines = read("gpui-kit.d.ts").split("\n");
  const commandsJson = JSON.parse(read("commands.json"));
  const agentsMd = existsSync(join(dir, "AGENTS.md")) ? read("AGENTS.md") : "";

  const herdr = exportsOf(herdrDts.split("\n"), "");
  const kitBlock = moduleBlock(kitLines, "gpui-kit");
  const kit = exportsOf(kitBlock, "  ");
  const baseBlock = moduleBlock(kitLines, "gpui-base");
  const base = exportsOf(baseBlock, "  ");
  const { element, elementDeclare } = elementMethods(kitBlock);

  /** @type {Record<string, { args: string[], required: string[] }>} */
  const commands = {};
  for (const c of commandsJson) {
    commands[c.name] = {
      args: c.args.map((/** @type {{name: string}} */ a) => a.name),
      required: c.args
        .filter((/** @type {{required: boolean}} */ a) => a.required)
        .map((/** @type {{name: string}} */ a) => a.name),
    };
  }

  const gpuiShell = /for gpui-shell ([0-9][\w.-]*?)\.?\s*$/m.exec(kitLines.slice(0, 10).join("\n"))?.[1] ?? null;
  const app = herdrApp ?? /herdr-app (\d+\.\d+\.\d+)/.exec(agentsMd)?.[1] ?? null;
  // A path inside some checkout's docs/drafts/herdr-api is recorded by that tail, so the file does not name one machine's disk.
  const tail = dir.match(/docs\/drafts\/herdr-api\/?$/)?.[0];
  const from = tail ? tail.replace(/\/$/, "") : dir.replace(homedir(), "~");

  return {
    source: { herdrApp: app, gpuiShell, from },
    herdr: herdr.values,
    kit: kit.values,
    base: base.values,
    element,
    elementDeclare,
    baseMembers: membersOf(baseBlock),
    types: { herdr: herdr.types, kit: kit.types, base: base.types },
    commands,
  };
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2));
  const dir = sourceDir(o.from);
  const api = generate(dir, o.herdrApp);
  writeFileSync(o.out, `${JSON.stringify(api, null, 2)}\n`);
  console.log(
    `wrote ${o.out}: ${api.herdr.length} herdr, ${api.kit.length} gpui-kit, ${api.base.length} gpui-base, ${api.element.length} element methods, ${Object.keys(api.commands).length} commands (from ${api.source.from}, gpui-shell ${api.source.gpuiShell}, herdr-app ${api.source.herdrApp})`,
  );
}
