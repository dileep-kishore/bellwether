//! `bw diff refs` lists the refs the base picker offers or checks one typed ref; `bw diff fetch` runs
//! `git fetch` when the user clicks Fetch, and is the only `bw diff` command that writes.

use std::io::Read;
use std::process::Stdio;
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{command, commit_of, describe, emit, fail, git_ok, place, Fail};
use crate::chat::args::Args;

/// The picker lists at most this many refs, newest first.
pub const MAX_REFS: usize = 200;
/// `exec` gives up after 30 s; a fetch stops before that so its error reaches the panel.
const FETCH_LIMIT: Duration = Duration::from_secs(25);

pub fn run(a: &Args) -> Result<(), Fail> {
    let path = a
        .get("path")
        .ok_or_else(|| fail("usage", "--path is required"))?;
    let top = place(path)?.top;
    if let Some(r) = a.get("verify") {
        let commit = commit_of(&top, r)?
            .ok_or_else(|| fail("bad_ref", format!("{r} is not a commit in this repository")))?;
        let (short, time) = describe(&top, &commit)?;
        emit(
            json!({"type": "diff-ref-ok", "ref": r, "commit": commit, "short": short, "time": time}),
        );
        return Ok(());
    }
    let out = git_ok(
        &top,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(objectname:short)%00%(committerdate:unix)%00%(*committerdate:unix)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let text = String::from_utf8_lossy(&out);
    let mut n = 0;
    for line in text.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() != 5 || !f[4].is_empty() {
            continue;
        }
        let (kind, name) = if let Some(n) = f[0].strip_prefix("refs/heads/") {
            ("branch", n)
        } else if let Some(n) = f[0].strip_prefix("refs/remotes/") {
            ("remote", n)
        } else if let Some(n) = f[0].strip_prefix("refs/tags/") {
            ("tag", n)
        } else {
            continue;
        };
        let time: i64 = f[2].parse().or_else(|_| f[3].parse()).unwrap_or(0);
        // `ref` is the full name, so a branch and a tag that share a short name stay two choices.
        emit(
            json!({"type": "diff-ref", "name": name, "ref": f[0], "kind": kind, "short": f[1], "time": time}),
        );
        n += 1;
        if n == MAX_REFS {
            break;
        }
    }
    Ok(())
}

/// The remote a base ref tracks: `upstream` for `upstream/main` when that is a remote-tracking ref, else
/// `origin`.
fn remote_of(top: &std::path::Path, remotes: &str, base: &str) -> Result<String, Fail> {
    let base = base.strip_prefix("refs/remotes/").unwrap_or(base);
    for r in remotes.lines() {
        if base.starts_with(&format!("{r}/"))
            && commit_of(top, &format!("refs/remotes/{base}"))?.is_some()
        {
            return Ok(r.to_string());
        }
    }
    Ok("origin".to_string())
}

pub fn fetch(a: &Args) -> Result<(), Fail> {
    let path = a
        .get("path")
        .ok_or_else(|| fail("usage", "--path is required"))?;
    let top = place(path)?.top;
    let remotes = String::from_utf8_lossy(&git_ok(&top, &["remote"])?).to_string();
    let remote = match (a.get("remote"), a.get("base")) {
        (Some(r), _) => r.to_string(),
        (None, Some(b)) => remote_of(&top, &remotes, b)?,
        (None, None) => "origin".to_string(),
    };
    let remote = remote.as_str();
    if !remotes.lines().any(|r| r == remote) {
        return Err(fail(
            "no_remote",
            format!("this repository has no remote named {remote}"),
        ));
    }
    let mut child = command(&top, &["fetch", "--quiet", "--end-of-options", remote])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| fail("fetch_failed", format!("could not run git fetch: {e}")))?;
    // Read stderr while fetch runs: a full pipe would stop fetch until the time limit.
    let mut pipe = child.stderr.take().expect("piped stderr");
    let reader = std::thread::spawn(move || {
        let mut err = String::new();
        let _ = pipe.read_to_string(&mut err);
        err
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() <= FETCH_LIMIT => sleep(Duration::from_millis(50)),
            waited => {
                let _ = child.kill();
                let _ = child.wait();
                let why = match waited {
                    Err(e) => format!("waiting for git fetch {remote}: {e}"),
                    _ => format!("git fetch {remote} took over {} s", FETCH_LIMIT.as_secs()),
                };
                return Err(fail("fetch_failed", why));
            }
        }
    };
    let err = reader.join().unwrap_or_default();
    if !status.success() {
        let err = err.trim();
        let start = (err.len().saturating_sub(300)..=err.len())
            .find(|&i| err.is_char_boundary(i))
            .unwrap_or(0);
        let tail = &err[start..];
        return Err(fail(
            "fetch_failed",
            format!("git fetch {remote} failed: {tail}"),
        ));
    }
    emit(json!({"type": "diff-fetched", "remote": remote}));
    Ok(())
}
