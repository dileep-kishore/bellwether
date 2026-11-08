//! `bw diff`: the Changes panel's lists and patches equal Git's own commands on the repositories
//! `scripts/verify/make-diff-repos.sh` builds, and no repository-named program (textconv, external diff,
//! fsmonitor) ever runs.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

struct Repos {
    _dir: tempfile::TempDir,
    paths: HashMap<String, PathBuf>,
}

impl Repos {
    fn get(&self, name: &str) -> &Path {
        &self.paths[name]
    }
    fn marker(&self) -> &Path {
        &self.paths["marker"]
    }
}

impl Drop for Repos {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            assert!(
                !self.marker().exists(),
                "a textconv, external diff or fsmonitor program ran"
            );
        }
    }
}

fn repos() -> Repos {
    let dir = tempfile::Builder::new()
        .prefix("bw-diff-test")
        .tempdir_in("/private/tmp")
        .unwrap();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/verify/make-diff-repos.sh");
    let out = Command::new("sh")
        .arg(script)
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let paths = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(k, v)| (k.to_string(), PathBuf::from(v)))
        .collect();
    Repos { _dir: dir, paths }
}

fn bw(args: &[&str]) -> (i32, Vec<Value>) {
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args(args)
        .output()
        .unwrap();
    let lines = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (out.status.code().unwrap_or(-1), lines)
}

fn files(dir: &Path, extra: &[&str]) -> Vec<Value> {
    let mut args = vec!["diff", "files", "--path", dir.to_str().unwrap()];
    args.extend(extra);
    let (code, lines) = bw(&args);
    assert_eq!(code, 0, "{lines:?}");
    lines
}

/// Plain Git as a person runs it, with the flags the spec's reference commands carry. fsmonitor is off so the
/// fixture's hook does not run.
fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        matches!(out.status.code(), Some(0 | 1)),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn rev(dir: &Path, r: &str) -> String {
    String::from_utf8(git(dir, &["rev-parse", r]))
        .unwrap()
        .trim()
        .to_string()
}

type Tuple = (String, String, Option<String>, Option<u64>, Option<u64>);

fn section(lines: &[Value], s: &str) -> BTreeSet<Tuple> {
    lines
        .iter()
        .filter(|l| l["type"] == "diff-file" && l["section"] == s)
        .map(|l| {
            (
                l["status"].as_str().unwrap().to_string(),
                l["path"].as_str().unwrap().to_string(),
                l["old_path"].as_str().map(str::to_string),
                l["added"].as_u64(),
                l["removed"].as_u64(),
            )
        })
        .collect()
}

/// The same tuples from a reference `git diff … --raw --numstat -z`.
fn reference(dir: &Path, args: &[&str]) -> BTreeSet<Tuple> {
    let mut full = args.to_vec();
    full.extend([
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--raw",
        "--numstat",
        "-z",
    ]);
    let out = String::from_utf8(git(dir, &full)).unwrap();
    let mut toks = out.split('\0');
    let mut raw = Vec::new();
    let mut counts = HashMap::new();
    while let Some(t) = toks.next() {
        if t.is_empty() {
            continue;
        }
        if let Some(meta) = t.strip_prefix(':') {
            let st = meta.rsplit(' ').next().unwrap()[..1].to_string();
            let a = toks.next().unwrap().to_string();
            if st == "R" || st == "C" {
                raw.push((st, toks.next().unwrap().to_string(), Some(a)));
            } else {
                raw.push((st, a, None));
            }
        } else {
            let mut p = t.splitn(3, '\t');
            let (a, r, path) = (p.next().unwrap(), p.next().unwrap(), p.next().unwrap());
            let path = if path.is_empty() {
                toks.next();
                toks.next().unwrap().to_string()
            } else {
                path.to_string()
            };
            counts.insert(path, (a.parse().ok(), r.parse().ok()));
        }
    }
    raw.into_iter()
        .map(|(s, p, o)| {
            let (a, r) = counts.get(&p).copied().unwrap_or((None, None));
            (s, p, o, a, r)
        })
        .collect()
}

#[test]
fn files_match_git_staged() {
    let r = repos();
    let dir = r.get("changes");
    let got = section(&files(dir, &[]), "staged");
    assert_eq!(got, reference(dir, &["diff", "--cached", "-M"]));
    assert!(got.contains(&(
        "R".into(),
        "new-name.txt".into(),
        Some("old-name.txt".into()),
        Some(0),
        Some(0)
    )));
    let lines = files(dir, &[]);
    let pic = lines.iter().find(|l| l["path"] == "pic.bin").unwrap();
    assert_eq!(pic["binary"], true);
    assert_eq!(pic["added"], Value::Null);
}

#[test]
fn files_match_git_changes() {
    let r = repos();
    let dir = r.get("changes");
    let lines = files(dir, &[]);
    let all = section(&lines, "changes");
    let tracked: BTreeSet<Tuple> = all.iter().filter(|t| t.0 != "?").cloned().collect();
    assert_eq!(tracked, reference(dir, &["diff", "--no-renames"]));
    let untracked: BTreeSet<String> = all
        .iter()
        .filter(|t| t.0 == "?")
        .map(|t| t.1.clone())
        .collect();
    let listed: BTreeSet<String> = String::from_utf8(git(
        dir,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    ))
    .unwrap()
    .split('\0')
    .filter(|s| !s.is_empty())
    .map(str::to_string)
    .collect();
    assert_eq!(untracked, listed);
    assert!(untracked.contains("newdir/inner.txt") && untracked.contains("blob.dat"));
    for t in all.iter().filter(|t| t.0 == "?") {
        let out = String::from_utf8(git(
            dir,
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "--",
                "/dev/null",
                &t.1,
            ],
        ))
        .unwrap();
        let mut f = out.split('\t');
        assert_eq!(
            (
                f.next().unwrap().parse().ok(),
                f.next().unwrap().parse().ok()
            ),
            (t.3, t.4),
            "{}",
            t.1
        );
    }
}

#[test]
fn files_committed_merge_base_and_tip() {
    let r = repos();
    let dir = r.get("changes");
    let mb = String::from_utf8(git(dir, &["merge-base", "origin/main", "HEAD"]))
        .unwrap()
        .trim()
        .to_string();
    let merge = files(dir, &[]);
    assert_eq!(
        section(&merge, "committed"),
        reference(dir, &["diff", "-M", &mb, "HEAD"])
    );
    let base = merge.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["ref"], "origin/main");
    assert_eq!(base["source"], "default");
    assert_eq!(base["from"], mb.as_str());
    let tip = files(dir, &["--mode", "tip"]);
    assert_eq!(
        section(&tip, "committed"),
        reference(dir, &["diff", "-M", "origin/main", "HEAD"])
    );
    assert_ne!(section(&tip, "committed"), section(&merge, "committed"));
}

#[test]
fn files_typed_base() {
    let r = repos();
    let dir = r.get("changes");
    let lines = files(dir, &["--base", "v1", "--mode", "tip"]);
    let base = lines.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["source"], "typed");
    assert_eq!(base["commit"], rev(dir, "v1^{commit}").as_str());
    assert_eq!(
        section(&lines, "committed"),
        reference(dir, &["diff", "-M", "v1", "HEAD"])
    );
}

#[test]
fn files_bad_typed_base() {
    let r = repos();
    let lines = files(r.get("changes"), &["--base", "nope"]);
    let base = lines.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["commit"], Value::Null);
    assert!(base["error"].as_str().unwrap().contains("nope"));
    assert!(section(&lines, "committed").is_empty());
}

#[test]
fn files_default_base_from_origin_head() {
    let r = repos();
    let lines = files(r.get("headonly"), &[]);
    let base = lines.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["ref"], "origin/trunk");
    assert_eq!(base["source"], "default");
    assert_eq!(section(&lines, "committed").len(), 1);
}

#[test]
fn files_no_base() {
    let r = repos();
    let lines = files(r.get("nobase"), &[]);
    let base = lines.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["source"], "none");
    assert_eq!(base["ref"], Value::Null);
    assert!(section(&lines, "committed").is_empty());
}

#[test]
fn files_unborn_head() {
    let r = repos();
    let lines = files(r.get("unborn"), &[]);
    assert_eq!(lines[0]["head"], Value::Null);
    assert_eq!(lines[0]["branch"], "main");
    assert_eq!(
        section(&lines, "staged"),
        BTreeSet::from([("A".into(), "first.txt".into(), None, Some(1), Some(0))])
    );
}

#[test]
fn files_place_names_top_and_common_dir() {
    let r = repos();
    let dir = r.get("changes");
    let lines = files(&dir.join("newdir"), &[]);
    assert_eq!(lines[0]["top"], dir.to_str().unwrap());
    assert_eq!(lines[0]["common_dir"], dir.join(".git").to_str().unwrap());
    assert_eq!(lines[0]["branch"], "feat");
}

#[test]
fn files_not_git() {
    let r = repos();
    let (code, lines) = bw(&[
        "diff",
        "files",
        "--path",
        r.marker().parent().unwrap().to_str().unwrap(),
    ]);
    assert_eq!(code, 1);
    assert_eq!(lines[0]["code"], "not_git");
    let (code, lines) = bw(&[
        "diff",
        "files",
        "--path",
        "/private/tmp/bw-diff-no-such-folder",
    ]);
    assert_eq!((code, lines[0]["code"].as_str()), (1, Some("missing")));
}

fn patch(dir: &Path, args: &[&str]) -> Vec<Value> {
    let mut full = vec!["diff", "patch", "--path", dir.to_str().unwrap()];
    full.extend(args);
    let (code, lines) = bw(&full);
    assert_eq!(code, 0, "{lines:?}");
    lines
}

/// Every page of a patch joined, and the page count.
fn all_pages(dir: &Path, args: &[&str]) -> (String, usize, Vec<Value>) {
    let first = patch(dir, args);
    let pages = first[0]["pages"].as_u64().unwrap() as usize;
    let mut text = first[0]["text"].as_str().unwrap().to_string();
    let mut cut: Vec<Value> = first[0]["cut"].as_array().unwrap().clone();
    for n in 1..pages {
        let page = n.to_string();
        let mut a = args.to_vec();
        a.extend(["--page", &page]);
        let p = patch(dir, &a);
        text.push_str(p[0]["text"].as_str().unwrap());
        cut.extend(p[0]["cut"].as_array().unwrap().clone());
    }
    (text, pages, cut)
}

const FLAGS: [&str; 3] = ["--no-ext-diff", "--no-textconv", "--no-color"];

#[test]
fn patch_pages_join_to_git() {
    let r = repos();
    let dir = r.get("changes");
    let lines = files(dir, &[]);
    let base = lines.iter().find(|l| l["type"] == "diff-base").unwrap();
    let from = base["from"].as_str().unwrap().to_string();
    let head = rev(dir, "HEAD");
    let mut checked = 0;
    for l in lines.iter().filter(|l| l["type"] == "diff-file") {
        let path = l["path"].as_str().unwrap();
        let old = l["old_path"].as_str();
        let sec = l["section"].as_str().unwrap();
        let untracked = l["status"] == "?";
        let mut args = vec!["--section", sec, "--file", path];
        if let Some(o) = old {
            args.extend(["--old", o]);
        }
        if untracked {
            args.push("--untracked");
        }
        if sec == "committed" {
            args.extend(["--from", &from, "--to", &head]);
        }
        let (text, pages, _) = all_pages(dir, &args);
        assert_eq!(pages, 1);
        let mut reference: Vec<&str> = vec!["diff"];
        reference.extend(FLAGS);
        let paths: Vec<&str> = old.into_iter().chain([path]).collect();
        match sec {
            "staged" => reference.extend(["--cached", "-M", "--"]),
            "changes" if untracked => reference.extend(["--no-index", "--", "/dev/null"]),
            "changes" => reference.push("--"),
            _ => reference.extend(["-M", &from, &head, "--"]),
        }
        if untracked {
            reference.push(path);
        } else {
            reference.extend(paths);
        }
        assert_eq!(
            text.as_bytes(),
            git(dir, &reference).as_slice(),
            "{sec} {path}"
        );
        checked += 1;
    }
    assert_eq!(checked, 13);
}

#[test]
fn patch_large_is_paged() {
    let r = repos();
    let dir = r.get("changes");
    let line = format!("{}\n", "y".repeat(99));
    std::fs::write(dir.join("big.txt"), line.repeat(9 * 1024 * 1024 / 100)).unwrap();
    let args = ["--section", "changes", "--file", "big.txt", "--untracked"];
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args([
            "diff",
            "patch",
            "--path",
            dir.to_str().unwrap(),
            "--page",
            "1",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(out.stdout.len() < 4 * 1024 * 1024);
    let (text, pages, cut) = all_pages(dir, &args);
    assert!(pages >= 3, "{pages} pages");
    assert!(cut.is_empty());
    let reference = git(
        dir,
        &[
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            "/dev/null",
            "big.txt",
        ],
    );
    assert!(
        text.as_bytes() == reference.as_slice(),
        "joined pages differ from git diff --no-index"
    );
}

#[test]
fn patch_huge_line_is_cut() {
    let r = repos();
    let dir = r.get("changes");
    std::fs::write(
        dir.join("wide.txt"),
        format!("short\n{}\nend\n", "z".repeat(5 * 1024 * 1024)),
    )
    .unwrap();
    let (text, _, cut) = all_pages(
        dir,
        &["--section", "changes", "--file", "wide.txt", "--untracked"],
    );
    assert_eq!(cut.len(), 1);
    assert_eq!(cut[0]["bytes"], 5 * 1024 * 1024 + 2);
    assert!(text.contains("+short\n+\n+end\n"));
}

#[test]
fn files_digest_matches_patch() {
    let r = repos();
    let dir = r.get("changes");
    let digest = |lines: &[Value]| {
        lines.iter().find(|l| l["type"] == "diff-digest").unwrap()["digest"].clone()
    };
    let before = files(dir, &["--select", "changes", "--file", "notes.txt"]);
    let p = patch(dir, &["--section", "changes", "--file", "notes.txt"]);
    assert_eq!(digest(&before), p[0]["digest"]);
    std::fs::write(
        dir.join("notes.txt"),
        "one\ntwo edited again\nthree\nfour\n",
    )
    .unwrap();
    let after = files(dir, &["--select", "changes", "--file", "notes.txt"]);
    assert_ne!(digest(&before), digest(&after));
    let p = patch(dir, &["--section", "changes", "--file", "notes.txt"]);
    assert_eq!(digest(&after), p[0]["digest"]);
    let u = files(dir, &["--select", "changes", "--file", "fresh.txt"]);
    let p = patch(
        dir,
        &["--section", "changes", "--file", "fresh.txt", "--untracked"],
    );
    assert_eq!(digest(&u), p[0]["digest"]);
}

#[test]
fn patch_committed_needs_commits() {
    let r = repos();
    let dir = r.get("changes");
    let (code, lines) = bw(&[
        "diff",
        "patch",
        "--path",
        dir.to_str().unwrap(),
        "--section",
        "committed",
        "--file",
        "feature.txt",
        "--from",
        "nope",
        "--to",
        "HEAD",
    ]);
    assert_eq!((code, lines[0]["code"].as_str()), (1, Some("bad_ref")));
    let (code, lines) = bw(&[
        "diff",
        "patch",
        "--path",
        dir.to_str().unwrap(),
        "--section",
        "changes",
        "--file",
        "notes.txt",
        "--page",
        "3",
    ]);
    assert_eq!((code, lines[0]["code"].as_str()), (1, Some("no_page")));
}

#[test]
fn refs_lists_branches_remotes_tags() {
    let r = repos();
    let (code, lines) = bw(&["diff", "refs", "--path", r.get("changes").to_str().unwrap()]);
    assert_eq!(code, 0);
    let names: BTreeSet<(String, String)> = lines
        .iter()
        .map(|l| {
            (
                l["kind"].as_str().unwrap().into(),
                l["name"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        names,
        BTreeSet::from([
            ("branch".into(), "main".into()),
            ("branch".into(), "feat".into()),
            ("remote".into(), "origin/main".into()),
            ("tag".into(), "v1".into()),
        ])
    );
    let (_, lines) = bw(&[
        "diff",
        "refs",
        "--path",
        r.get("headonly").to_str().unwrap(),
    ]);
    assert!(lines.iter().all(|l| l["name"] != "origin/HEAD"));
}

#[test]
fn refs_verify_typed_ref() {
    let r = repos();
    let dir = r.get("changes");
    let (code, lines) = bw(&[
        "diff",
        "refs",
        "--path",
        dir.to_str().unwrap(),
        "--verify",
        "v1",
    ]);
    assert_eq!(code, 0);
    assert_eq!(lines[0]["type"], "diff-ref-ok");
    assert_eq!(lines[0]["commit"], rev(dir, "v1^{commit}").as_str());
    let (code, lines) = bw(&[
        "diff",
        "refs",
        "--path",
        dir.to_str().unwrap(),
        "--verify",
        "nope",
    ]);
    assert_eq!((code, lines[0]["code"].as_str()), (1, Some("bad_ref")));
}

#[test]
fn refs_verify_refuses_option_like_ref() {
    let r = repos();
    let dir = r.get("changes");
    let target = dir.join("written-by-rev-parse");
    let opt = format!("--output={}", target.display());
    for args in [
        vec![
            "diff",
            "refs",
            "--path",
            dir.to_str().unwrap(),
            "--verify",
            &opt,
        ],
        vec![
            "diff",
            "files",
            "--path",
            dir.to_str().unwrap(),
            "--base",
            &opt,
        ],
    ] {
        let (_, lines) = bw(&args);
        assert!(
            lines
                .iter()
                .any(|l| l["code"] == "bad_ref" || l["error"].is_string()),
            "{lines:?}"
        );
    }
    assert!(!target.exists());
}

#[test]
fn fetch_brings_origin_main() {
    let r = repos();
    let dir = r.get("changes");
    let other = dir.parent().unwrap().join("other");
    let origin = dir.parent().unwrap().join("changes-origin.git");
    let git_env = |c: &mut Command| {
        c.env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid");
    };
    for args in [
        vec![
            "clone",
            "-q",
            origin.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
        vec![
            "-C",
            other.to_str().unwrap(),
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "upstream",
        ],
        vec![
            "-C",
            other.to_str().unwrap(),
            "push",
            "-q",
            "origin",
            "main",
        ],
    ] {
        let mut c = Command::new("git");
        git_env(&mut c);
        assert!(c.args(&args).status().unwrap().success());
    }
    let new = rev(&other, "HEAD");
    let (code, lines) = bw(&["diff", "fetch", "--path", dir.to_str().unwrap()]);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(lines[0]["type"], "diff-fetched");
    let base = files(dir, &[]);
    let base = base.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["commit"], new.as_str());
}

#[test]
fn fetch_takes_the_base_remote() {
    let r = repos();
    let dir = r.get("changes");
    let (code, lines) = bw(&[
        "diff",
        "fetch",
        "--path",
        dir.to_str().unwrap(),
        "--base",
        "origin/main",
    ]);
    assert_eq!((code, lines[0]["remote"].as_str()), (0, Some("origin")));
    let (code, lines) = bw(&[
        "diff",
        "fetch",
        "--path",
        dir.to_str().unwrap(),
        "--base",
        "v1",
    ]);
    assert_eq!((code, lines[0]["remote"].as_str()), (0, Some("origin")));
}

#[test]
fn fetch_unknown_remote() {
    let r = repos();
    let (code, lines) = bw(&[
        "diff",
        "fetch",
        "--path",
        r.get("changes").to_str().unwrap(),
        "--remote",
        "upstream",
    ]);
    assert_eq!((code, lines[0]["code"].as_str()), (1, Some("no_remote")));
    let (code, lines) = bw(&["diff", "fetch", "--path", r.get("nobase").to_str().unwrap()]);
    assert_eq!((code, lines[0]["code"].as_str()), (1, Some("no_remote")));
}

fn commit_all(dir: &Path, msg: &str) {
    for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", msg]] {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "core.fsmonitor=false"])
            .args(&args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }
}

#[test]
fn a_file_name_is_never_a_pathspec() {
    let r = repos();
    let dir = r.get("nobase");
    std::fs::write(dir.join("a*.txt"), "star\n").unwrap();
    std::fs::write(dir.join("ab.txt"), "plain\n").unwrap();
    commit_all(dir, "two names");
    std::fs::write(dir.join("a*.txt"), "star edited\n").unwrap();
    std::fs::write(dir.join("ab.txt"), "plain edited\n").unwrap();
    let p = patch(dir, &["--section", "changes", "--file", "a*.txt"]);
    let text = p[0]["text"].as_str().unwrap();
    assert!(text.contains("a/a*.txt"), "{text}");
    assert!(
        !text.contains("ab.txt"),
        "the glob matched another file: {text}"
    );
    let digest = |lines: &[Value]| {
        lines.iter().find(|l| l["type"] == "diff-digest").unwrap()["digest"].clone()
    };
    let f = files(dir, &["--select", "changes", "--file", "a*.txt"]);
    assert_eq!(digest(&f), p[0]["digest"]);
    let magic = bw(&[
        "diff",
        "patch",
        "--path",
        dir.to_str().unwrap(),
        "--section",
        "changes",
        "--file",
        ":!x",
    ]);
    assert!(
        magic.1[0]["text"].as_str().unwrap_or("").is_empty(),
        "{:?}",
        magic.1
    );
}

#[test]
fn a_branch_and_a_tag_with_one_name_stay_apart() {
    let r = repos();
    let dir = r.get("nobase");
    let first = rev(dir, "HEAD");
    git(dir, &["tag", "release", &first]);
    std::fs::write(dir.join("later.txt"), "later\n").unwrap();
    commit_all(dir, "later");
    git(dir, &["branch", "release", "HEAD"]);
    let (_, lines) = bw(&["diff", "refs", "--path", dir.to_str().unwrap()]);
    let refs: BTreeSet<(String, String)> = lines
        .iter()
        .filter(|l| l["name"] == "release")
        .map(|l| {
            (
                l["kind"].as_str().unwrap().into(),
                l["ref"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        refs,
        BTreeSet::from([
            ("branch".into(), "refs/heads/release".into()),
            ("tag".into(), "refs/tags/release".into()),
        ])
    );
    let branch = files(dir, &["--base", "refs/heads/release"]);
    let base = branch.iter().find(|l| l["type"] == "diff-base").unwrap();
    assert_eq!(base["commit"], rev(dir, "refs/heads/release").as_str());
    assert_ne!(base["commit"], first.as_str());
}

#[test]
fn fetch_reports_a_noisy_failure_at_once() {
    let r = repos();
    let dir = r.get("changes");
    let noisy = dir.parent().unwrap().join("hooks/noisy-ssh");
    std::fs::write(
        &noisy,
        "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' x >&2\necho noisy end >&2\nexit 1\n",
    )
    .unwrap();
    Command::new("chmod")
        .arg("755")
        .arg(&noisy)
        .status()
        .unwrap();
    git(dir, &["remote", "add", "far", "ssh://fake.invalid/x.git"]);
    git(dir, &["config", "core.sshCommand", noisy.to_str().unwrap()]);
    let started = std::time::Instant::now();
    let (code, lines) = bw(&[
        "diff",
        "fetch",
        "--path",
        dir.to_str().unwrap(),
        "--remote",
        "far",
    ]);
    assert_eq!(code, 1);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "fetch waited {:?}",
        started.elapsed()
    );
    let message = lines[0]["message"].as_str().unwrap();
    assert!(!message.contains("took over"), "{message}");
}
