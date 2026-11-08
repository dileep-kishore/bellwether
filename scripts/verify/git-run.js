// Done check C's comparisons, run by scripts/verify/git.sh: on the repositories make-diff-repos.sh built (on
// this Mac, or on --machine through hc exec), `bw diff` and the Changes panel's model equal Git's own
// commands, each with --no-ext-diff --no-textconv --no-color.
//   bun git-run.js --root <dir> [--bw <path> | --machine <name> --install-bw <path>]
// Prints PASS <check> or FAIL <check>: <why>; exits 1 on any FAIL.
import { parseArgs } from "node:util";
import { createHelper, HELPER_SCRIPT } from "../../shared/helper.js";
import { viewFiles } from "../../mods/bw-diff/model.js";
import { lines, reporter, spawn, viaHc } from "./live.js";

const { values: opt } = parseArgs({
  options: {
    root: { type: "string" },
    bw: { type: "string" },
    machine: { type: "string" },
    "install-bw": { type: "string" },
  },
});
const ROOT = /** @type {string} */ (opt.root);
const M = opt.machine ?? null;
const report = reporter();
const { pass, fail, check } = report;
const FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];
const where = M ?? "this Mac";

/** A program on the fixtures' machine. @param {string} cmd @param {string[]} args */
const run = (cmd, args) => (M ? viaHc(M, cmd, args) : spawn([cmd, ...args]));

/** Git as a person runs it there; fsmonitor off so the fixture's hook stays unrun. @param {string} dir @param {string[]} args */
async function git(dir, args) {
  const r = await run("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args]);
  if (r.code !== 0 && r.code !== 1) throw new Error(`git ${args.slice(0, 3).join(" ")} in ${dir}: ${r.stderr.trim()}`);
  return r.stdout;
}

const helper = createHelper({
  exec: (cmd, args, { on }) => (on ? viaHc(on, cmd, args) : spawn([cmd, ...args])),
  localInstall: async (machine) => {
    const r = await spawn([/** @type {string} */ (opt["install-bw"]), "machine", "install", machine]);
    return lines(r.stdout);
  },
});

/** `bw diff <args>` there: this checkout's bw here, the installed helper on another machine. @param {string[]} args */
async function bw(args) {
  if (!M) {
    const r = await spawn([/** @type {string} */ (opt.bw), "diff", ...args]);
    return { code: r.code, lines: lines(r.stdout) };
  }
  const r = await viaHc(M, "sh", ["-c", HELPER_SCRIPT, "bw", "diff", ...args]);
  return { code: r.code, lines: lines(r.stdout) };
}

/** @typedef {[string, string, string | null, number | null, number | null]} Tuple status, path, old, +, − */

/** @param {any[]} ls @param {string} section @returns {string[]} */
const tuples = (ls, section) =>
  ls
    .filter((l) => l.type === "diff-file" && l.section === section)
    .map((l) => JSON.stringify([l.status, l.path, l.old_path, l.added, l.removed]))
    .sort();

/** The same tuples from `git diff <args> --raw --numstat -z`. @param {string} dir @param {string[]} args */
async function reference(dir, args) {
  const toks = (await git(dir, [...args, ...FLAGS, "--raw", "--numstat", "-z"])).split("\0");
  /** @type {[string, string, string | null][]} */
  const raw = [];
  /** @type {Map<string, [number | null, number | null]>} */
  const counts = new Map();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith(":")) {
      const st = t.split(" ").at(-1)?.[0] ?? "M";
      const a = toks[++i];
      raw.push(st === "R" || st === "C" ? [st, toks[++i], a] : [st, a, null]);
      continue;
    }
    const [a, r, ...rest] = t.split("\t");
    let p = rest.join("\t");
    if (p === "") {
      i++;
      p = toks[++i];
    }
    const n = (/** @type {string} */ x) => (x === "-" ? null : Number(x));
    counts.set(p, [n(a), n(r)]);
  }
  return raw.map(([s, p, o]) => JSON.stringify([s, p, o, ...(counts.get(p) ?? [null, null])])).sort();
}

/** @param {string} name @param {string[]} got @param {string[]} want */
function same(name, got, want) {
  Bun.deepEquals(got, want)
    ? pass(name, `${got.length} files equal Git on ${where}`)
    : fail(name, `bw ${JSON.stringify(got)} vs git ${JSON.stringify(want)}`);
}

async function main() {
  if (M) {
    const ready = await helper.ensure(M);
    if (ready.ok === false) {
      fail("helper", `${M}: ${ready.message}`);
      return;
    }
    pass("helper", `bw on ${M} is current (protocol 5, 0.5.0)`);
  }
  const C = `${ROOT}/changes`;
  const files = await bw(["files", "--path", C]);
  if (files.code !== 0) {
    fail("files", `bw diff files exited ${files.code}: ${JSON.stringify(files.lines).slice(0, 300)}`);
    return;
  }
  const L = files.lines;
  const base = L.find((l) => l.type === "diff-base");
  const head = L.find((l) => l.type === "diff-place")?.head;

  await check("staged", async () =>
    same("staged", tuples(L, "staged"), await reference(C, ["diff", "--cached", "-M"])),
  );
  await check("changes", async () => {
    const tracked = tuples(L, "changes").filter((t) => JSON.parse(t)[0] !== "?");
    same("changes", tracked, await reference(C, ["diff", "--no-renames"]));
    const untracked = L.filter((l) => l.type === "diff-file" && l.status === "?");
    const listed = (await git(C, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean)
      .sort();
    same("untracked", untracked.map((l) => l.path).sort(), listed);
    for (const u of untracked) {
      const out = await git(C, ["diff", "--no-index", ...FLAGS, "--numstat", "--", "/dev/null", u.path]);
      const [a, r] = out.split("\t");
      const want = [a === "-" ? null : Number(a), r === "-" ? null : Number(r)];
      if (!Bun.deepEquals([u.added, u.removed], want))
        throw new Error(`${u.path}: bw ${u.added} ${u.removed}, git ${want}`);
    }
    pass("untracked-counts", `${untracked.length} untracked files' counts equal git diff --no-index --numstat`);
  });
  await check("committed-merge-base", async () => {
    const mb = (await git(C, ["merge-base", "origin/main", "HEAD"])).trim();
    if (base?.from !== mb) throw new Error(`base from ${base?.from}, merge-base ${mb}`);
    same("committed-merge-base", tuples(L, "committed"), await reference(C, ["diff", "-M", mb, "HEAD"]));
  });
  await check("committed-tip", async () => {
    const tip = await bw(["files", "--path", C, "--mode", "tip"]);
    const want = await reference(C, ["diff", "-M", "origin/main", "HEAD"]);
    same("committed-tip", tuples(tip.lines, "committed"), want);
    if (Bun.deepEquals(want, tuples(L, "committed")))
      fail("committed-tip-differs", "Tip and Merge base lists are equal");
  });
  await check("typed-ref", async () => {
    const typed = await bw(["files", "--path", C, "--base", "v1", "--mode", "tip"]);
    const b = typed.lines.find((l) => l.type === "diff-base");
    const v1 = (await git(C, ["rev-parse", "--verify", "--end-of-options", "v1^{commit}"])).trim();
    if (b?.source !== "typed" || b?.commit !== v1) throw new Error(`typed base ${JSON.stringify(b)}, v1 is ${v1}`);
    same("typed-ref", tuples(typed.lines, "committed"), await reference(C, ["diff", "-M", "v1", "HEAD"]));
    const bad = await bw(["files", "--path", C, "--base", "--output=/private/tmp/bw-verify-diff-written"]);
    const bb = bad.lines.find((l) => l.type === "diff-base");
    if (!bb?.error || bb.commit !== null) throw new Error(`an option-like ref was taken: ${JSON.stringify(bb)}`);
    pass("typed-ref-refused", "--output=… is refused as a ref");
  });
  await check("rename", async () => {
    const r = L.find((l) => l.type === "diff-file" && l.status === "R");
    r?.path === "new-name.txt" && r.old_path === "old-name.txt"
      ? pass("rename", "old-name.txt → new-name.txt listed as R in Staged")
      : fail("rename", `no rename row: ${JSON.stringify(r)}`);
  });
  await check("binary", async () => {
    const b = L.filter((l) => l.type === "diff-file" && l.binary)
      .map((l) => l.path)
      .sort();
    Bun.deepEquals(b, ["blob.dat", "pic.bin"])
      ? pass("binary", "pic.bin (staged) and blob.dat (untracked) are binary with no counts")
      : fail("binary", `binary rows ${JSON.stringify(b)}`);
  });
  await check("patches", async () => {
    let n = 0;
    for (const l of L.filter((x) => x.type === "diff-file")) {
      const args = ["patch", "--path", C, "--section", l.section, "--file", l.path];
      if (l.old_path) args.push("--old", l.old_path);
      if (l.status === "?") args.push("--untracked");
      if (l.section === "committed") args.push("--from", base.from, "--to", head);
      let text = "";
      for (let page = 0, pages = 1; page < pages; page++) {
        const p = await bw(page ? [...args, "--page", String(page)] : args);
        const line = p.lines.find((x) => x.type === "diff-patch");
        if (!line) throw new Error(`${l.section} ${l.path}: ${JSON.stringify(p.lines).slice(0, 200)}`);
        pages = line.pages;
        text += line.text;
      }
      const paths = [...(l.old_path ? [l.old_path] : []), l.path];
      const ref =
        l.section === "staged"
          ? ["diff", ...FLAGS, "--cached", "-M", "--", ...paths]
          : l.section === "committed"
            ? ["diff", ...FLAGS, "-M", base.from, head, "--", ...paths]
            : l.status === "?"
              ? ["diff", ...FLAGS, "--no-index", "--", "/dev/null", l.path]
              : ["diff", ...FLAGS, "--", l.path];
      const want = await git(C, ref);
      if (text !== want) throw new Error(`${l.section} ${l.path}: the paged patch differs from git ${ref.join(" ")}`);
      n++;
    }
    pass(
      "patches",
      `${n} patches, paged, equal their reference commands (untracked: git diff --no-index -- /dev/null)`,
    );
  });
  await check("panel-rows", async () => {
    const v = viewFiles(L);
    if (!v) throw new Error("viewFiles read no place");
    const got = Object.values(v.sections)
      .flat()
      .map((r) => [r.section, r.letter, r.path, r.added, r.removed].join(" "))
      .sort();
    const want = L.filter((l) => l.type === "diff-file")
      .map((l) =>
        [l.section, l.status === "?" ? "U" : l.status === "U" ? "!" : l.status, l.path, l.added, l.removed].join(" "),
      )
      .sort();
    Bun.deepEquals(got, want) && got.length === 13
      ? pass("panel-rows", "the panel model's 13 rows equal the helper's, which equal Git")
      : fail("panel-rows", `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  });
  await check("no-default-base", async () => {
    const nb = await bw(["files", "--path", `${ROOT}/nobase`]);
    const b = nb.lines.find((l) => l.type === "diff-base");
    b?.source === "none" &&
    b.ref === null &&
    tuples(nb.lines, "committed").length === 0 &&
    viewFiles(nb.lines)?.base.source === "none"
      ? pass(
          "no-default-base",
          "no origin/main and no origin/HEAD: source none, no Committed rows, the panel opens its picker",
        )
      : fail("no-default-base", JSON.stringify(b));
  });
  await check("default-from-origin-head", async () => {
    const h = await bw(["files", "--path", `${ROOT}/headonly`]);
    const b = h.lines.find((l) => l.type === "diff-base");
    b?.ref === "origin/trunk" && b.source === "default"
      ? pass("default-from-origin-head", "origin/HEAD -> origin/trunk is the default base")
      : fail("default-from-origin-head", JSON.stringify(b));
  });
  await check("textconv-never-ran", async () => {
    const r = await run("test", ["-e", `${ROOT}/textconv-ran`]);
    r.code === 1
      ? pass("textconv-never-ran", "no textconv, external diff or fsmonitor program ran")
      : fail("textconv-never-ran", `${ROOT}/textconv-ran exists`);
  });
}

await main();
process.exit(report.failed ? 1 : 0);
