// Done check D's list half, run by scripts/verify/linear.sh: two scratch repositories, one without an origin
// linked to "Bellwether" and one with an origin linked to "Bellwether scratch", each read the way the Issues
// panel reads it (its Git place, its link, its default filter), and `bw linear` compared with a GraphQL query
// of another shape sent straight to Linear with the same key. Then Mine and All, the link moving when the
// first repository gains an origin, and a search of the disk for the key's first 12 characters.
//   bun linear-run.js --root <dir> --bw <path> [--fake]
// --fake answers both from a loopback fake of Linear with a made-up key, for a machine with no key.
// Prints PASS <check> or FAIL <check>: <why>; exits 1 on any FAIL.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readPlace } from "../../shared/git.js";
import { LINKS, moveLink, readLink, writeLink } from "../../shared/linear-links.js";
import { defaultScope, listArgs, originArgs, readList } from "../../mods/bw-linear/model.js";
import { lines, reporter, spawn } from "./live.js";

const { values: opt } = parseArgs({
  options: { root: { type: "string" }, bw: { type: "string" }, fake: { type: "boolean" } },
});
const ROOT = /** @type {string} */ (opt.root);
const report = reporter();
const { pass, fail, check } = report;
const CLOSED = ["completed", "canceled", "duplicate"];
const OPEN = `{state: {type: {nin: ${JSON.stringify(CLOSED)}}}}`;
const HOME = process.env.HOME ?? "";
const scratch = mkdtempSync("/private/tmp/bw-verify-linear-env.");
/** @type {Record<string, string>} */
const env = { ...process.env, BW_CACHE_DIR: opt.fake ? `${scratch}/cache` : (process.env.BW_CACHE_DIR ?? "") };
if (!env.BW_CACHE_DIR) delete env.BW_CACHE_DIR;
let security = "/usr/bin/security";
const FAKE_KEY = "lin_api_Q7vbVerifyFakeabcdefghijklmnopqrstuv";

if (opt.fake) {
  const url = startFake();
  security = `${scratch}/security`;
  writeFileSync(security, `#!/bin/sh\necho ${FAKE_KEY}\n`);
  chmodSync(security, 0o755);
  Object.assign(env, { BW_LINEAR_URL: url, BW_SECURITY: security });
}
const ENDPOINT = env.BW_LINEAR_URL ?? "https://api.linear.app/graphql";

/** `bw linear <args>` with this checkout's helper. @param {string[]} args */
async function bw(args) {
  const r = await spawn([/** @type {string} */ (opt.bw), "linear", ...args], { env });
  const ls = lines(r.stdout);
  const err = ls.find((l) => l.type === "error");
  if (err) throw new Error(`bw linear ${args[0]}: ${err.code}: ${err.message}`);
  return ls;
}

/** Every open issue of a list, page after page (at most 20). @param {string[]} args */
async function all(args) {
  /** @type {string[]} */
  const ids = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
    const page = readList(await bw(after ? [...args.slice(1), "--after", after] : args.slice(1)));
    ids.push(...page.issues.map((x) => x.identifier));
    if (!page.next) break;
    after = page.next;
  }
  return ids;
}

/**
 * A GraphQL query sent to Linear by curl, the key read by the shell from the Keychain and passed in curl's
 * config on standard input; the body goes in a file.
 * @param {string} query @param {Record<string, unknown>} [variables]
 */
async function graphql(query, variables = {}) {
  const body = `${scratch}/body.json`;
  writeFileSync(body, JSON.stringify({ query, variables }));
  const script = [
    'key=$("$1" find-generic-password -s bellwether.linear -w) || exit 3',
    'printf \'header = "Authorization: %s"\\n\' "$key" | curl -sS --max-time 20 -K - -H "Content-Type: application/json" --data-binary @"$2" "$3"',
  ].join("\n");
  const r = await spawn(["sh", "-c", script, "sh", security, body, ENDPOINT]);
  if (r.code !== 0) throw new Error(`reference query failed (${r.code}): ${r.stderr.trim()}`);
  const v = JSON.parse(r.stdout);
  if (v.errors) throw new Error(`reference query: ${JSON.stringify(v.errors).slice(0, 200)}`);
  return v.data;
}

const sorted = (/** @type {string[]} */ xs) => [...xs].sort();
const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** @param {string} dir @param {string[]} args */
async function git(dir, args) {
  const r = await spawn(["git", "-C", dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The repository as the panel reads it. @param {string} folder */
async function repoOf(folder) {
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args) => spawn([cmd, ...args]);
  const place = await readPlace(exec, null, folder);
  if (place.ok === false) throw new Error(`${folder}: ${place.message}`);
  const o = await spawn(["git", ...originArgs(place.place.commonDir)]);
  return { machine: null, commonDir: place.place.commonDir, origin: o.code === 0 ? o.stdout.trim() : null };
}

/** The list the panel shows by default for a repository and stored links. @param {any} repo @param {unknown} links */
async function defaultList(repo, links) {
  const link = readLink(links, repo);
  const args = listArgs(defaultScope(link !== null), link?.projectId ?? null, "");
  if (!args) throw new Error("no list for the default filter");
  return { link, ids: await all(args) };
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(`${ROOT}/.bw-verify`, "");
  const A = `${ROOT}/bellwether-a`;
  const B = `${ROOT}/scratch-b`;
  for (const d of [A, B]) {
    mkdirSync(d, { recursive: true });
    await git(d, ["init", "-q", "-b", "main"]);
  }
  await git(B, ["remote", "add", "origin", "https://github.com/bellwether-scratch/scratch-b.git"]);

  const projects = (await bw(["projects"])).filter((l) => l.type === "linear-project");
  const bell = projects.find((p) => p.name === "Bellwether");
  const scr = projects.find((p) => p.name === "Bellwether scratch");
  if (!bell || !scr) {
    fail("projects", `Linear has ${bell ? "" : "no Bellwether "}${scr ? "" : "no Bellwether scratch "}project`);
    return;
  }
  pass("projects", `bw linear projects names Bellwether (${bell.id}) and Bellwether scratch (${scr.id})`);

  const repoA = await repoOf(A);
  const repoB = await repoOf(B);
  let links = writeLink(undefined, repoA, { projectId: String(bell.id), name: "Bellwether", at: 1 });
  links = writeLink(links, repoB, { projectId: String(scr.id), name: "Bellwether scratch", at: 1 });
  /** @type {Record<string, string[]>} */
  const shown = {};
  for (const [name, repo, project] of /** @type {const} */ ([
    ["no-origin", repoA, bell],
    ["with-origin", repoB, scr],
  ])) {
    await check(`default-list-${name}`, async () => {
      const { link, ids } = await defaultList(repo, links);
      const ref = await graphql(
        `query($id: String!) { project(id: $id) { issues(first: 100, filter: ${OPEN}) { nodes { identifier } } } }`,
        { id: project.id },
      );
      const want = ref.project.issues.nodes.map((/** @type {any} */ n) => n.identifier);
      shown[name] = ids;
      if (link?.projectId !== project.id) fail(`default-list-${name}`, `linked to ${link?.name}, not ${project.name}`);
      else if (!want.length) fail(`default-list-${name}`, `${project.name} has no open issues to compare`);
      else if (same(ids, want))
        pass(`default-list-${name}`, `${ids.length} issues equal project(id).issues: ${sorted(ids).join(" ")}`);
      else fail(`default-list-${name}`, `bw ${sorted(ids).join(" ")} vs GraphQL ${sorted(want).join(" ")}`);
    });
  }
  if (shown["no-origin"] && shown["with-origin"]) {
    const overlap = shown["no-origin"].filter((i) => shown["with-origin"].includes(i));
    overlap.length === 0
      ? pass("lists-differ", "the two repositories' lists share no issue")
      : fail("lists-differ", `both lists hold ${overlap.join(" ")}`);
  }

  await check("mine", async () => {
    const ids = await all(listArgs("mine", null, "") ?? []);
    const ref = await graphql(`{ viewer { assignedIssues(first: 250, filter: ${OPEN}) { nodes { identifier } } } }`);
    const want = ref.viewer.assignedIssues.nodes.map((/** @type {any} */ n) => n.identifier);
    if (!same(ids, want))
      fail("mine", `bw ${sorted(ids).join(" ")} vs viewer.assignedIssues ${sorted(want).join(" ")}`);
    else if (same(ids, shown["no-origin"] ?? [])) fail("mine", "Mine shows the same list as Project");
    else pass("mine", `${ids.length} issues equal viewer.assignedIssues and differ from Project`);
  });

  await check("all", async () => {
    const page = readList(await bw((listArgs("all", null, "") ?? []).slice(1)));
    const ids = page.issues.map((x) => x.identifier);
    const ref = await graphql(`{ issues(first: 50, orderBy: updatedAt, filter: ${OPEN}) { nodes { identifier } } }`);
    const want = ref.issues.nodes.map((/** @type {any} */ n) => n.identifier);
    if (!same(ids, want)) fail("all", `first page: bw ${ids.length} vs GraphQL ${want.length} identifiers differ`);
    else if (same(ids, shown["no-origin"] ?? [])) fail("all", "All shows the same list as Project");
    else pass("all", `first page of ${ids.length} equals issues(first: 50) and differs from Project`);
  });

  await check("origin-keeps-link", async () => {
    await git(A, ["remote", "add", "origin", "git@github.com:bellwether-scratch/bellwether-a.git"]);
    const now = await repoOf(A);
    const moved = moveLink(links, now);
    const link = readLink(moved, now);
    const keys = Object.keys(moved?.links ?? {});
    if (!moved || !keys.includes("origin:github.com/bellwether-scratch/bellwether-a"))
      fail("origin-keeps-link", `keys after the move: ${keys.join(", ")}`);
    else if (link?.projectId !== bell.id) fail("origin-keeps-link", `the link reads ${link?.name}`);
    else {
      const { ids } = await defaultList(now, moved);
      same(ids, shown["no-origin"] ?? [])
        ? pass("origin-keeps-link", `${LINKS} moved to the origin key; the list is unchanged`)
        : fail("origin-keeps-link", "the list changed after the move");
    }
  });

  await check("key-nowhere-on-disk", async () => {
    const places = [
      `${HOME}/.config/herdr-app`,
      "/private/tmp/bw-stage",
      `${HOME}/.cache/bellwether`,
      `${HOME}/.local/share/bellwether`,
      new URL("../..", import.meta.url).pathname,
      "/Volumes/WorkSSD/Personal/bellwether",
      ...(opt.fake ? [`${scratch}/cache`] : []),
    ].filter((p) => existsSync(p));
    // The key's prefix stays in shell variables and a pipe. A failed key read, a short key or an rg error
    // ends the script with a status other than rg's 0 (found) and 1 (not found), which fails the check.
    const script = [
      "s=$1; shift",
      'k=$("$s" find-generic-password -s bellwether.linear -w) || exit 3',
      'p=$(printf "%s" "$k" | cut -c1-12); k=""',
      "case $p in ????????????) ;; *) exit 4 ;; esac",
      'printf "%s\\n" "$p" | rg -F -l -uu -f - -- "$@"',
    ].join("\n");
    const r = await spawn(["sh", "-c", script, "sh", security, ...places]);
    // The made-up key is written in this script and in its own fake security; the real key is in neither.
    const own = (/** @type {string} */ l) =>
      opt.fake && (l.startsWith(`${scratch}/security`) || l.endsWith("scripts/verify/linear-run.js"));
    const hits = r.stdout.split("\n").filter((l) => l && !own(l));
    if (r.code !== 0 && r.code !== 1)
      fail(
        "key-nowhere-on-disk",
        r.code === 3 || r.code === 4
          ? `could not read a 12-character key prefix (status ${r.code}); nothing was searched`
          : `rg exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`,
      );
    else if (hits.length) fail("key-nowhere-on-disk", `${hits.length} files hold it, e.g. ${hits[0]}`);
    else
      pass(
        "key-nowhere-on-disk",
        `rg -F over ${places.length} places finds no file with the key's first 12 characters`,
      );
  });
}

/** A loopback fake of the queries bw and this script send; returns its URL. */
function startFake() {
  const issue = (
    /** @type {string} */ id,
    /** @type {string} */ project,
    /** @type {string} */ type,
    mine = false,
  ) => ({
    id: `u-${id}`,
    identifier: id,
    title: `Fake ${id}`,
    url: `https://linear.app/x/issue/${id}`,
    branchName: `feature/${id.toLowerCase()}`,
    priority: 0,
    updatedAt: "2026-11-08T00:00:00Z",
    state: { name: type, type, color: "#888", position: 1 },
    assignee: mine ? { name: "Me", displayName: "me", isMe: true } : null,
    project: { id: project, name: project },
    labels: { nodes: [] },
  });
  const ISSUES = [
    issue("PLA-1", "P1", "unstarted", true),
    issue("PLA-2", "P1", "started"),
    issue("PLA-3", "P1", "completed"),
    issue("PLA-4", "P2", "backlog"),
    issue("PLA-5", "P2", "unstarted"),
    issue("PLA-6", "P3", "started", true),
  ];
  const open = ISSUES.filter((i) => !CLOSED.includes(i.state.type));
  const conn = (/** @type {any[]} */ nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== FAKE_KEY)
        return Response.json({ errors: [{ message: "auth" }] }, { status: 401 });
      const { query, variables: v } = await req.json();
      const f = v?.filter ?? {};
      const pick = (/** @type {any[]} */ xs) =>
        xs.filter((i) => (!f.project || i.project.id === f.project.id.eq) && (!f.assignee || i.assignee?.isMe));
      if (query.includes("projects("))
        return Response.json({
          data: {
            projects: conn(
              [
                { id: "P1", name: "Bellwether" },
                { id: "P2", name: "Bellwether scratch" },
              ].map((p) => ({ ...p, url: "u", teams: { nodes: [] } })),
            ),
          },
        });
      if (query.includes("project(id"))
        return Response.json({ data: { project: { issues: conn(open.filter((i) => i.project.id === v.id)) } } });
      if (query.includes("assignedIssues"))
        return Response.json({ data: { viewer: { assignedIssues: conn(open.filter((i) => i.assignee)) } } });
      if (query.includes("issues(")) return Response.json({ data: { issues: conn(pick(open)) } });
      return Response.json({ errors: [{ message: "unknown query" }] }, { status: 400 });
    },
  });
  return `http://127.0.0.1:${server.port}/graphql`;
}

try {
  await main();
} catch (e) {
  fail("run", e instanceof Error ? e.message : String(e));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(report.failed ? 1 : 0);
