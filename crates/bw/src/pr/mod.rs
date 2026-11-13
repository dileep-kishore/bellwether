//! `bw pr status`: cached GitHub pull-request, check-rollup, and review-thread status, run on the window machine.
//!
//! Queries GitHub GraphQL through `BW_GH_BIN` (default `gh`, with `/opt/homebrew/bin/gh` and `/usr/local/bin/gh`
//! fallbacks when a GUI window's `PATH` omits Homebrew) under a 10 s timeout, caches replies for 60 s under
//! `~/.cache/bellwether/pr/<sha256(repo + "\0" + branch)>.json` (`0600` in `0700` dir), and serves a cached entry
//! with `"stale": true` when `gh` is missing, unauthenticated, or offline.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chat::args;
use crate::linear::cache::{now_ms, private_dir, write_private};

const USAGE: &str =
    "usage: bw pr status --repo <owner/repo> --branch <branch> [--head <oid>] [--refresh]";

const DEFAULT_TTL_MS: i64 = 60_000;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_STALE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION: u32 = 1;

const QUERY: &str = r#"
query($owner: String!, $name: String!, $headRefName: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(headRefName: $headRefName, states: [OPEN], first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        isDraft
        baseRefName
        headRefOid
        reviewDecision
        mergeStateStatus
        reviewThreads(first: 100) {
          totalCount
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
    closed: pullRequests(headRefName: $headRefName, states: [MERGED, CLOSED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        isDraft
        baseRefName
        headRefOid
        reviewDecision
        mergeStateStatus
        reviewThreads(first: 100) {
          totalCount
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub base_ref_name: String,
    pub head_ref_oid: String,
    pub review_decision: Option<String>,
    pub merge_state_status: Option<String>,
    pub unresolved_threads: usize,
    pub passing: usize,
    pub failing: usize,
    pub pending: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct CachedPr {
    version: u32,
    repo: String,
    branch: String,
    #[serde(default)]
    head_oid: Option<String>,
    at_ms: i64,
    pr: Option<PrSummary>,
}

#[derive(Debug, PartialEq, Eq)]
struct Fail {
    code: &'static str,
    message: String,
    stale_eligible: bool,
}

fn fail(code: &'static str, message: impl Into<String>, stale_eligible: bool) -> Fail {
    Fail {
        code,
        message: message.into(),
        stale_eligible,
    }
}

pub fn dir() -> PathBuf {
    crate::chat::cache::cache_dir().join("pr")
}

fn ttl_ms() -> i64 {
    std::env::var("BW_PR_TTL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_TTL_MS)
}

fn timeout() -> Duration {
    let ms = std::env::var("BW_PR_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(ms)
}

pub fn run(argv: &[String]) -> ExitCode {
    let (cmd, rest) = match argv.split_first() {
        Some((c, r)) => (c.as_str(), r),
        None => return crate::usage(USAGE),
    };
    if cmd != "status" {
        return crate::usage(&format!("unknown pr command {cmd:?}; {USAGE}"));
    }
    let a = match args::parse_free(
        rest,
        &["refresh"],
        &["repo", "branch", "head"],
        &["repo", "branch", "head"],
    ) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let Some(repo) = a.get("repo") else {
        return crate::usage(&format!("--repo is required; {USAGE}"));
    };
    let Some((owner, name)) = parse_repo(repo) else {
        return crate::usage(&format!("invalid --repo {repo:?}; {USAGE}"));
    };
    let Some(branch) = a.get("branch") else {
        return crate::usage(&format!("--branch is required; {USAGE}"));
    };
    if !valid_branch(branch) {
        return crate::usage(&format!("invalid --branch {branch:?}; {USAGE}"));
    }
    let head = a.get("head").filter(|s| !s.is_empty());
    if let Some(h) = head {
        if !valid_oid(h) {
            return crate::usage(&format!("invalid --head {h:?}; {USAGE}"));
        }
    }
    let refresh = a.has("refresh");
    let now = now_ms();
    let cache_path = cache_file(&dir(), repo, branch);
    let cached = load_cached(&cache_path, repo, branch, now);

    if !refresh {
        if let Some(c) = &cached {
            if is_fresh(c, head, now, ttl_ms()) {
                print_line(repo, branch, &c.pr, true, age_s(now, c.at_ms), false);
                return ExitCode::SUCCESS;
            }
        }
    }

    match query_gh(&gh_program(), owner, name, branch, timeout()) {
        Ok(pr) => {
            store_cached(
                &dir(),
                &cache_path,
                &CachedPr {
                    version: CACHE_VERSION,
                    repo: repo.to_string(),
                    branch: branch.to_string(),
                    head_oid: head
                        .map(String::from)
                        .or_else(|| pr.as_ref().map(|p| p.head_ref_oid.clone())),
                    at_ms: now,
                    pr: pr.clone(),
                },
            );
            print_line(repo, branch, &pr, false, 0, false);
            ExitCode::SUCCESS
        }
        Err(f) => {
            if f.stale_eligible {
                if let Some(c) = cached {
                    print_line(repo, branch, &c.pr, true, age_s(now, c.at_ms), true);
                    return ExitCode::SUCCESS;
                }
            }
            crate::chat::error(f.code, &f.message)
        }
    }
}

fn print_line(
    repo: &str,
    branch: &str,
    pr: &Option<PrSummary>,
    cached: bool,
    age_s: u64,
    stale: bool,
) {
    println!(
        "{}",
        json!({
            "type": "pr",
            "repo": repo,
            "branch": branch,
            "pr": pr,
            "cached": cached,
            "age_s": age_s,
            "stale": stale,
        })
    );
}

fn age_s(now: i64, at_ms: i64) -> u64 {
    ((now - at_ms).max(0) / 1000) as u64
}

fn is_fresh(c: &CachedPr, head: Option<&str>, now: i64, ttl: i64) -> bool {
    let age = now - c.at_ms;
    if !(0..ttl).contains(&age) {
        return false;
    }
    if let Some(want) = head {
        let recorded_match = c.head_oid.as_deref() == Some(want);
        let pr_match = c.pr.as_ref().map(|p| p.head_ref_oid.as_str()) == Some(want);
        if !recorded_match && !pr_match {
            return false;
        }
    }
    true
}

pub fn parse_repo(repo: &str) -> Option<(&str, &str)> {
    let (owner, name) = repo.split_once('/')?;
    if name.contains('/') {
        return None;
    }
    let seg_ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s != "."
            && s != ".."
            && !s.starts_with('-')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    (seg_ok(owner) && seg_ok(name)).then_some((owner, name))
}

pub fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= 256
        && !branch.starts_with('-')
        && !branch.bytes().any(|b| b < 0x20 || b == 0x7f)
}

fn valid_oid(oid: &str) -> bool {
    (7..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn cache_file(root: &Path, repo: &str, branch: &str) -> PathBuf {
    let mut h = Sha256::new();
    h.update(repo.as_bytes());
    h.update(b"\0");
    h.update(branch.as_bytes());
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    root.join(format!("{hex}.json"))
}

fn load_cached(path: &Path, repo: &str, branch: &str, now: i64) -> Option<CachedPr> {
    let bytes = fs::read(path).ok()?;
    let c: CachedPr = serde_json::from_slice(&bytes).ok()?;
    if c.version != CACHE_VERSION || c.repo != repo || c.branch != branch {
        return None;
    }
    if now - c.at_ms > MAX_STALE_MS {
        return None;
    }
    Some(c)
}

fn store_cached(root: &Path, path: &Path, entry: &CachedPr) {
    if private_dir(root).is_err() {
        return;
    }
    if let Ok(bytes) = serde_json::to_vec(entry) {
        let _ = write_private(path, &bytes);
    }
}

fn gh_program() -> OsString {
    if let Some(p) = std::env::var_os("BW_GH_BIN").filter(|p| !p.is_empty()) {
        return p;
    }
    for candidate in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        if !in_path("gh") && Path::new(candidate).is_file() {
            return candidate.into();
        }
    }
    "gh".into()
}

fn in_path(bin: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(bin).is_file())
}

fn drain_pipe<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    })
}

fn query_gh(
    program: &OsStr,
    owner: &str,
    name: &str,
    branch: &str,
    limit: Duration,
) -> Result<Option<PrSummary>, Fail> {
    let mut child = match Command::new(program)
        .args([
            "api",
            "graphql",
            "-F",
            &format!("owner={owner}"),
            "-F",
            &format!("name={name}"),
            "-F",
            &format!("headRefName={branch}"),
            "-f",
            &format!("query={QUERY}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(fail(
                "no_gh",
                "GitHub CLI (gh) is not installed on this machine",
                true,
            ))
        }
        Err(e) => return Err(fail("offline", format!("cannot run gh: {e}"), true)),
    };

    let stdout_handle = drain_pipe(child.stdout.take());
    let stderr_handle = drain_pipe(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail(
                    "offline",
                    format!("gh api graphql timed out after {} s", limit.as_secs()),
                    true,
                ));
            }
            Err(e) => return Err(fail("offline", format!("gh did not finish: {e}"), true)),
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    parse_gh_output(status.success(), &stdout, &stderr)
}

fn classify_gh_failure(stderr: &str, stdout: &str) -> Fail {
    let combined = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    if combined.contains("auth login")
        || combined.contains("not logged into")
        || combined.contains("bad credentials")
        || combined.contains("http 401")
        || combined.contains("requires authentication")
        || combined.contains("authentication token")
    {
        return fail(
            "unauthenticated",
            first_line(stderr, "gh is not authenticated; run `gh auth login`"),
            true,
        );
    }
    fail(
        "offline",
        first_line(stderr, "could not reach GitHub via gh"),
        true,
    )
}

fn first_line<'a>(s: &'a str, fallback: &'a str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn parse_gh_output(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Option<PrSummary>, Fail> {
    let stderr_str = String::from_utf8_lossy(stderr);
    let stdout_str = String::from_utf8_lossy(stdout);
    if !success {
        if let Ok(v) = serde_json::from_slice::<Value>(stdout) {
            if has_repo_not_found(&v) {
                return Ok(None);
            }
        }
        return Err(classify_gh_failure(&stderr_str, &stdout_str));
    }
    let v: Value = serde_json::from_slice(stdout)
        .map_err(|e| fail("offline", format!("gh returned invalid JSON: {e}"), true))?;
    if has_repo_not_found(&v) {
        return Ok(None);
    }
    if let Some(errs) = v["errors"].as_array().filter(|a| !a.is_empty()) {
        let msg = errs[0]["message"].as_str().unwrap_or("GitHub GraphQL error");
        return Err(classify_gh_failure(msg, ""));
    }
    let repo = &v["data"]["repository"];
    if repo.is_null() {
        return Ok(None);
    }
    let node = repo["open"]["nodes"]
        .as_array()
        .and_then(|n| n.first())
        .or_else(|| repo["closed"]["nodes"].as_array().and_then(|n| n.first()));
    Ok(node.and_then(parse_pr_node))
}

fn has_repo_not_found(v: &Value) -> bool {
    v["errors"]
        .as_array()
        .is_some_and(|errs| errs.iter().any(|e| e["type"].as_str() == Some("NOT_FOUND")))
}

fn parse_pr_node(n: &Value) -> Option<PrSummary> {
    let number = n["number"].as_u64()?;
    let title = n["title"].as_str().unwrap_or("").to_string();
    let url = n["url"].as_str().unwrap_or("").to_string();
    let state = n["state"].as_str().unwrap_or("OPEN").to_string();
    let is_draft = n["isDraft"].as_bool().unwrap_or(false);
    let base_ref_name = n["baseRefName"].as_str().unwrap_or("").to_string();
    let head_ref_oid = n["headRefOid"].as_str().unwrap_or("").to_string();
    let review_decision = n["reviewDecision"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);
    let merge_state_status = n["mergeStateStatus"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);

    let thread_nodes = n["reviewThreads"]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let resolved_seen = thread_nodes
        .iter()
        .filter(|t| t["isResolved"].as_bool() == Some(true))
        .count();
    let total_threads = n["reviewThreads"]["totalCount"]
        .as_u64()
        .map(|c| c as usize)
        .unwrap_or(thread_nodes.len())
        .max(thread_nodes.len());
    // Threads past the first 100 count as unresolved so Merge PR fails closed on huge PRs.
    let unresolved_threads = total_threads.saturating_sub(resolved_seen);

    let rollup = &n["commits"]["nodes"]
        .as_array()
        .and_then(|a| a.last())
        .map(|x| &x["commit"]["statusCheckRollup"]);
    let (passing, failing, pending) = match rollup {
        Some(r) if r.is_object() => parse_rollup(r),
        _ => (0, 0, 0),
    };

    Some(PrSummary {
        number,
        title,
        url,
        state,
        is_draft,
        base_ref_name,
        head_ref_oid,
        review_decision,
        merge_state_status,
        unresolved_threads,
        passing,
        failing,
        pending,
    })
}

fn parse_rollup(rollup: &Value) -> (usize, usize, usize) {
    let mut passing = 0usize;
    let mut failing = 0usize;
    let mut pending = 0usize;

    let nodes = rollup["contexts"]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for ctx in nodes {
        match ctx["__typename"].as_str().unwrap_or("") {
            "CheckRun" => {
                let status = ctx["status"].as_str().unwrap_or("");
                if status != "COMPLETED" {
                    pending += 1;
                } else {
                    match ctx["conclusion"].as_str().unwrap_or("") {
                        "SUCCESS" | "NEUTRAL" | "SKIPPED" => passing += 1,
                        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
                        | "STARTUP_FAILURE" | "STALE" => failing += 1,
                        _ => pending += 1,
                    }
                }
            }
            "StatusContext" => match ctx["state"].as_str().unwrap_or("") {
                "SUCCESS" => passing += 1,
                "FAILURE" | "ERROR" => failing += 1,
                _ => pending += 1,
            },
            _ => {}
        }
    }

    let total = rollup["contexts"]["totalCount"]
        .as_u64()
        .map(|c| c as usize)
        .unwrap_or(nodes.len());
    let overall = rollup["state"].as_str().unwrap_or("");
    if matches!(overall, "FAILURE" | "ERROR") && failing == 0 {
        failing = 1;
    } else if matches!(overall, "PENDING" | "EXPECTED") && pending == 0 {
        pending = 1;
    } else if total > nodes.len() && overall != "SUCCESS" && failing == 0 && pending == 0 {
        pending = total - nodes.len();
    }

    (passing, failing, pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn validates_repo_and_branch_arguments() {
        assert_eq!(parse_repo("dkishore/bellwether"), Some(("dkishore", "bellwether")));
        assert_eq!(parse_repo("org-1/my.repo_2"), Some(("org-1", "my.repo_2")));
        assert_eq!(parse_repo("../evil"), None);
        assert_eq!(parse_repo("a/b/c"), None);
        assert_eq!(parse_repo("-flag/repo"), None);
        assert_eq!(parse_repo("owner/.."), None);

        assert!(valid_branch("feat/refine-ui-flockbook-cockpit"));
        assert!(!valid_branch("--upload-pack=evil"));
        assert!(!valid_branch("-b"));
        assert!(!valid_branch(""));
        assert!(!valid_branch("bad\nline"));
    }

    #[test]
    fn parses_open_pr_checks_and_threads_including_null_review_decision() {
        let reply = json!({
            "data": {
                "repository": {
                    "open": {
                        "nodes": [{
                            "number": 17,
                            "title": "feat: refine UI",
                            "url": "https://github.com/dkishore/bellwether/pull/17",
                            "state": "OPEN",
                            "isDraft": false,
                            "baseRefName": "main",
                            "headRefOid": "ed8020b13676a153a8f528e5d5c6ce894ec81b3b",
                            "reviewDecision": null,
                            "mergeStateStatus": "CLEAN",
                            "reviewThreads": {
                                "totalCount": 3,
                                "nodes": [
                                    {"isResolved": true},
                                    {"isResolved": false},
                                    {"isResolved": true}
                                ]
                            },
                            "commits": {
                                "nodes": [{
                                    "commit": {
                                        "statusCheckRollup": {
                                            "state": "PENDING",
                                            "contexts": {
                                                "totalCount": 4,
                                                "nodes": [
                                                    {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
                                                    {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"},
                                                    {"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": null},
                                                    {"__typename": "StatusContext", "state": "FAILURE"}
                                                ]
                                            }
                                        }
                                    }
                                }]
                            }
                        }]
                    },
                    "closed": { "nodes": [] }
                }
            }
        });
        let bytes = serde_json::to_vec(&reply).unwrap();
        let pr = parse_gh_output(true, &bytes, b"").unwrap().unwrap();
        assert_eq!(pr.number, 17);
        assert_eq!(pr.review_decision, None);
        assert_eq!(pr.unresolved_threads, 1);
        assert_eq!((pr.passing, pr.failing, pr.pending), (2, 1, 1));
    }

    #[test]
    fn cache_enforces_0600_and_invalidates_on_head_change() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("pr");
        let path = cache_file(&root, "dkishore/bellwether", "feat/ui");
        let summary = PrSummary {
            number: 9,
            title: "t".into(),
            url: "https://github.com/dkishore/bellwether/pull/9".into(),
            state: "OPEN".into(),
            is_draft: false,
            base_ref_name: "main".into(),
            head_ref_oid: "aaaaaaa1111111".into(),
            review_decision: Some("APPROVED".into()),
            merge_state_status: Some("CLEAN".into()),
            unresolved_threads: 0,
            passing: 3,
            failing: 0,
            pending: 0,
        };
        store_cached(
            &root,
            &path,
            &CachedPr {
                version: CACHE_VERSION,
                repo: "dkishore/bellwether".into(),
                branch: "feat/ui".into(),
                head_oid: Some("aaaaaaa1111111".into()),
                at_ms: 1000,
                pr: Some(summary),
            },
        );
        let dir_mode = fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o600);

        let loaded = load_cached(&path, "dkishore/bellwether", "feat/ui", 10_000).unwrap();
        assert!(is_fresh(&loaded, None, 10_000, 60_000));
        assert!(is_fresh(&loaded, Some("aaaaaaa1111111"), 10_000, 60_000));
        assert!(!is_fresh(&loaded, Some("bbbbbbb2222222"), 10_000, 60_000));
        assert!(!is_fresh(&loaded, None, 70_000, 60_000));
    }

    #[test]
    fn classifies_unauthenticated_and_offline_errors() {
        let auth = parse_gh_output(false, b"", b"To get started with GitHub CLI, please run:  gh auth login\n")
            .unwrap_err();
        assert_eq!(auth.code, "unauthenticated");
        assert!(auth.stale_eligible);

        let net = parse_gh_output(false, b"", b"Post \"https://api.github.com/graphql\": dial tcp: i/o timeout\n")
            .unwrap_err();
        assert_eq!(net.code, "offline");
        assert!(net.stale_eligible);
    }
}
