//! `bw diff files --watch`: a poll whose token still holds runs no Git; an edit, other arguments, or a
//! missing, replaced or idle watcher mean a full read.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

struct Fixture {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    cache: PathBuf,
    /// A `git` ahead of the real one that leaves a mark for each call.
    bin: PathBuf,
    marks: PathBuf,
}

const IDLE_MS: &str = "1500";

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("bw-watch-test")
        .tempdir_in("/private/tmp")
        .unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@example.invalid"],
        &["config", "user.name", "t"],
    ] {
        git(&repo, args);
    }
    fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-q", "-m", "one"]);
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    let marks = root.join("marks");
    let real = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let shim = bin.join("git");
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\necho x >> '{}'\nexec '{real}' \"$@\"\n",
            marks.display()
        ),
    )
    .unwrap();
    Command::new("chmod").arg("+x").arg(&shim).status().unwrap();
    Fixture {
        cache: root.join("cache"),
        _dir: dir,
        repo,
        bin,
        marks,
    }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(ok.success(), "git {args:?}");
}

impl Fixture {
    fn files(&self, extra: &[&str]) -> Vec<Value> {
        let path = format!(
            "{}:{}",
            self.bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let out = Command::new(env!("CARGO_BIN_EXE_bw"))
            .args([
                "diff",
                "files",
                "--path",
                self.repo.to_str().unwrap(),
                "--watch",
            ])
            .args(extra)
            .env("BW_CACHE_DIR", &self.cache)
            .env("BW_WATCH_IDLE_MS", IDLE_MS)
            .env("HC_SCOPE", "bw-test-scope")
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// Polls until a read prints a token: the watcher has started and holds its watches.
    fn token(&self) -> String {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(t) = token_of(&self.files(&[])) {
                return t;
            }
            assert!(Instant::now() < end, "no watcher started");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn git_calls(&self) -> usize {
        fs::read_to_string(&self.marks).map_or(0, |s| s.lines().count())
    }

    fn state_files(&self) -> Vec<PathBuf> {
        fs::read_dir(self.cache.join("git-watch"))
            .map(|d| {
                d.filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|x| x == "json"))
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn token_of(lines: &[Value]) -> Option<String> {
    lines
        .iter()
        .find(|l| l["type"] == "diff-token")
        .and_then(|l| l["token"].as_str())
        .map(str::to_string)
}

fn unchanged(lines: &[Value]) -> bool {
    lines.len() == 1 && lines[0]["type"] == "diff-unchanged"
}

fn changes(lines: &[Value]) -> Vec<String> {
    lines
        .iter()
        .filter(|l| l["type"] == "diff-file" && l["section"] == "changes")
        .map(|l| l["path"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn watch_unchanged_token_runs_no_git() {
    let f = fixture();
    let t = f.token();
    let before = f.git_calls();
    let lines = f.files(&["--since", &t]);
    assert!(unchanged(&lines), "{lines:?}");
    assert_eq!(lines[0]["token"], t.as_str());
    // place() asks Git for the worktree's top once; no status, diff or ref read follows.
    assert!(
        f.git_calls() - before <= 1,
        "{} Git calls",
        f.git_calls() - before
    );
}

#[test]
fn watch_an_edit_changes_the_token() {
    let f = fixture();
    let t = f.token();
    fs::write(f.repo.join("a.txt"), "one\ntwo\n").unwrap();
    let end = Instant::now() + Duration::from_secs(3);
    let lines = loop {
        let lines = f.files(&["--since", &t]);
        if !unchanged(&lines) {
            break lines;
        }
        assert!(Instant::now() < end, "the edit never changed the token");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(changes(&lines), ["a.txt"]);
    let next = token_of(&lines).expect("a token after the read");
    assert_ne!(next, t);
    assert!(unchanged(&f.files(&["--since", &next])));
}

#[test]
fn watch_other_arguments_read_again() {
    let f = fixture();
    let t = f.token();
    let lines = f.files(&["--since", &t, "--mode", "tip"]);
    assert!(!unchanged(&lines));
    assert!(lines.iter().any(|l| l["type"] == "diff-place"));
}

#[test]
fn watch_a_replaced_or_missing_watcher_reads() {
    let f = fixture();
    let t = f.token();
    let state = f.state_files().pop().expect("a state file");
    fs::write(
        &state,
        format!(
            r#"{{"id":"someone-else","pid":{},"count":0}}"#,
            std::process::id()
        ),
    )
    .unwrap();
    assert!(!unchanged(&f.files(&["--since", &t])));
    fs::remove_file(&state).unwrap();
    let lines = f.files(&["--since", &t]);
    assert!(!unchanged(&lines));
    // A new watcher starts and its token differs from the old one.
    assert_ne!(f.token(), t);
}

#[test]
fn watch_a_killed_watcher_never_answers_unchanged() {
    let f = fixture();
    let t = f.token();
    let state = f.state_files().pop().expect("a state file");
    let pid = serde_json::from_slice::<Value>(&fs::read(&state).unwrap()).unwrap()["pid"]
        .as_u64()
        .unwrap();
    assert!(Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap()
        .success());
    std::thread::sleep(Duration::from_millis(100));
    // Its last state is still on disk and recent; the edit after the kill must show.
    assert!(state.exists());
    fs::write(f.repo.join("a.txt"), "one\ntwo\n").unwrap();
    let lines = f.files(&["--since", &t]);
    assert!(!unchanged(&lines), "{lines:?}");
    assert_eq!(changes(&lines), ["a.txt"]);
}

#[test]
fn watch_leaves_out_the_hc_scope_that_would_end_it() {
    let f = fixture();
    f.token();
    let state = f.state_files().pop().expect("a state file");
    let pid = serde_json::from_slice::<Value>(&fs::read(&state).unwrap()).unwrap()["pid"]
        .as_u64()
        .unwrap();
    // `ps eww` prints a process's environment after its command.
    let ps = Command::new("ps")
        .args(["eww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let seen = String::from_utf8_lossy(&ps.stdout);
    assert!(seen.contains("diff watch"), "{seen}");
    assert!(
        seen.contains("BW_CACHE_DIR="),
        "ps shows no environment: {seen}"
    );
    assert!(!seen.contains("HC_SCOPE="), "{seen}");
}

#[test]
fn watch_exits_when_no_call_comes() {
    let f = fixture();
    f.token();
    assert_eq!(f.state_files().len(), 1);
    let end = Instant::now() + Duration::from_secs(6);
    while !f.state_files().is_empty() {
        assert!(Instant::now() < end, "the watcher outlived its idle time");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn watch_ignores_its_own_files_inside_the_worktree() {
    // A repository at the home folder holds the cache: the watcher's and the lease's writes are not edits.
    let mut f = fixture();
    f.cache = f.repo.join(".bw-cache");
    fs::write(f.repo.join(".git/info/exclude"), ".bw-cache/\n").unwrap();
    let t = f.token();
    for _ in 0..2 {
        std::thread::sleep(Duration::from_millis(400));
        assert!(unchanged(&f.files(&["--since", &t])));
    }
}

#[test]
fn without_watch_no_watcher_starts() {
    let f = fixture();
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args(["diff", "files", "--path", f.repo.to_str().unwrap()])
        .env("BW_CACHE_DIR", &f.cache)
        .output()
        .unwrap();
    assert!(out.status.success());
    std::thread::sleep(Duration::from_millis(300));
    assert!(f.state_files().is_empty());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("diff-token"));
}
