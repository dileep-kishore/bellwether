//! `bw diff files|patch|refs|fetch`: the Changes panel's reads of a worktree, run on the machine that holds it.
//! Every Git call goes through `git()`, which adds the read-only flags; every diff adds `DIFF_FLAGS`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Output, Stdio};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::chat::args;

mod files;
pub mod parse;
mod patch;
mod refs;

/// Without these a read refreshes the index or starts fsmonitor, and both write under `.git`.
pub const READ_ONLY: [&str; 5] = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.autoRefreshIndex=false",
];
/// A repository's own config can name programs for these; Bellwether never runs them.
pub const DIFF_FLAGS: [&str; 3] = ["--no-ext-diff", "--no-textconv", "--no-color"];
/// Variables that would point Git at another repository or another diff program.
const CLEARED: [&str; 5] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_EXTERNAL_DIFF",
];

pub struct Fail {
    pub code: &'static str,
    pub message: String,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> Fail {
    Fail {
        code,
        message: message.into(),
    }
}

pub fn run(argv: &[String]) -> ExitCode {
    let (cmd, rest) = match argv.split_first() {
        Some((c, r)) => (c.as_str(), r),
        None => {
            return crate::usage("usage: bw diff files|patch|refs|fetch --path <dir> <options>")
        }
    };
    let result = match cmd {
        "files" => args::parse_free(
            rest,
            &[],
            &["path", "base", "mode", "select", "file", "old"],
            &["base", "file", "old"],
        )
        .map_err(|e| fail("usage", e))
        .and_then(|a| files::run(&a)),
        "patch" => args::parse_free(
            rest,
            &["untracked"],
            &["path", "section", "file", "old", "from", "to", "page"],
            &["file", "old"],
        )
        .map_err(|e| fail("usage", e))
        .and_then(|a| patch::run(&a)),
        "refs" => args::parse_free(rest, &[], &["path", "verify"], &["verify"])
            .map_err(|e| fail("usage", e))
            .and_then(|a| refs::run(&a)),
        "fetch" => args::parse_free(rest, &[], &["path", "remote", "base"], &["base"])
            .map_err(|e| fail("usage", e))
            .and_then(|a| refs::fetch(&a)),
        other => Err(fail("usage", format!("unknown diff command {other:?}"))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) => crate::chat::error(f.code, &f.message),
    }
}

/// A `git` command in `dir` with the read-only flags first.
pub fn command(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).args(READ_ONLY).args(args);
    for v in CLEARED {
        c.env_remove(v);
    }
    // A file name is a path, never a pathspec: `a*.txt` must not also match `ab.txt`.
    c.env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    c
}

/// Runs Git and returns its output whatever the exit code; only a Git that cannot start is an error.
pub fn git(dir: &Path, args: &[&str]) -> Result<Output, Fail> {
    command(dir, args)
        .output()
        .map_err(|e| fail("git_failed", format!("could not run git: {e}")))
}

/// Runs Git and returns stdout, or a `git_failed` naming the command and its stderr.
pub fn git_ok(dir: &Path, args: &[&str]) -> Result<Vec<u8>, Fail> {
    let out = git(dir, args)?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    Err(fail(
        "git_failed",
        format!(
            "git {} failed: {}",
            args.iter()
                .find(|a| !a.starts_with('-'))
                .copied()
                .unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    ))
}

/// Runs Git and reads at most `limit` bytes of stdout; `None` when it printed more. Exit codes 0 and 1 are
/// success, since `git diff --no-index` exits 1 when the files differ.
pub fn git_capped(dir: &Path, args: &[&str], limit: usize) -> Result<Option<Vec<u8>>, Fail> {
    let mut child = command(dir, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| fail("git_failed", format!("could not run git: {e}")))?;
    let mut out = Vec::new();
    let stdout = child.stdout.take().expect("piped stdout");
    let read = stdout.take(limit as u64 + 1).read_to_end(&mut out);
    if out.len() > limit {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(None);
    }
    read.map_err(|e| fail("git_failed", format!("reading git's output: {e}")))?;
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let status = child
        .wait()
        .map_err(|e| fail("git_failed", format!("waiting for git: {e}")))?;
    match status.code() {
        Some(0 | 1) => Ok(Some(out)),
        _ => Err(fail(
            "git_failed",
            format!("git diff failed: {}", err.trim()),
        )),
    }
}

/// Where a folder's worktree and repository are, as Git spells them.
pub struct Place {
    pub top: PathBuf,
    pub common_dir: PathBuf,
}

pub fn place(path: &str) -> Result<Place, Fail> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(fail("missing", format!("{path} is not a folder here")));
    }
    let out = git(
        dir,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
        ],
    )?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("not a git repository") || err.contains("must be run in a work tree") {
            return Err(fail("not_git", format!("{path} is not in a Git worktree")));
        }
        return Err(fail(
            "git_failed",
            format!("git rev-parse failed: {}", err.trim()),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    match (lines.next(), lines.next()) {
        (Some(c), Some(t)) if !c.is_empty() && !t.is_empty() => Ok(Place {
            common_dir: PathBuf::from(c),
            top: PathBuf::from(t),
        }),
        _ => Err(fail("not_git", format!("{path} is not in a Git worktree"))),
    }
}

/// A commit's full name, or `None` when `rev` names no commit. `--end-of-options` keeps a ref spelled like
/// an option from being read as one.
pub fn commit_of(top: &Path, rev: &str) -> Result<Option<String>, Fail> {
    let peeled = format!("{rev}^{{commit}}");
    let out = git(
        top,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &peeled,
        ],
    )?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((out.status.success() && !sha.is_empty()).then_some(sha))
}

/// A commit's short name and committer time.
pub fn describe(top: &Path, sha: &str) -> Result<(String, i64), Fail> {
    let out = git_ok(
        top,
        &[
            "log",
            "-1",
            "--no-show-signature",
            "--format=%h%x00%ct",
            "--end-of-options",
            sha,
        ],
    )?;
    let text = String::from_utf8_lossy(&out);
    let (short, time) = text.trim().split_once('\0').unwrap_or(("", "0"));
    Ok((short.to_string(), time.parse().unwrap_or(0)))
}

/// The first 16 hex digits of the SHA-256 of `bytes`: how the panel tells a patch changed.
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn emit(v: serde_json::Value) {
    println!("{v}");
}

pub fn str_or_null(s: Option<&str>) -> serde_json::Value {
    s.map_or(serde_json::Value::Null, |s| json!(s))
}
