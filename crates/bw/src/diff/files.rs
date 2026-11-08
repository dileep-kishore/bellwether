//! `bw diff files`: Staged, Changes and Committed on branch for one worktree, its base, and with `--select`
//! a digest of the selected file's patch, in one call.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};

use super::parse::{raw_numstat, status_v2, Counts, StatusEntry};
use super::{
    commit_of, describe, digest, emit, fail, git, git_ok, patch, place, str_or_null, watch, Fail,
    DIFF_FLAGS,
};
use crate::chat::args::Args;

/// Rows past this many in one section are counted, not listed.
pub const MAX_ROWS: usize = 2000;
/// The bytes all three sections' rows may print together, so one call stays under `exec`'s 8 MiB cap
/// whatever the paths' lengths.
pub const LIST_BYTES: usize = 4 * 1024 * 1024;
/// An untracked file past this size is listed without counts.
const COUNT_LIMIT: u64 = 64 * 1024 * 1024;
/// Git calls a file binary when its first 8000 bytes hold a NUL.
const BINARY_PROBE: usize = 8000;
/// Changes' `git diff` names the paths status listed, so Git stats only those; past these the argument
/// list could pass the system's limit, and the whole index is compared instead.
const PATHSPEC_PATHS: usize = 1000;
const PATHSPEC_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    MergeBase,
    Tip,
}

pub fn mode_of(s: Option<&str>) -> Result<Mode, Fail> {
    match s {
        None | Some("merge-base") => Ok(Mode::MergeBase),
        Some("tip") => Ok(Mode::Tip),
        Some(o) => Err(fail(
            "usage",
            format!("--mode is merge-base or tip, not {o:?}"),
        )),
    }
}

struct Row {
    status: char,
    path: String,
    old_path: Option<String>,
    counts: Counts,
    binary: bool,
}

/// Counts and binary-ness from a numstat map: numstat prints `-` for a binary file, and a path it does not
/// list has no counts.
fn counted(counts: &std::collections::HashMap<String, Counts>, path: &str) -> (Counts, bool) {
    match counts.get(path) {
        Some(Some(c)) => (Some(*c), false),
        Some(None) => (None, true),
        None => (None, false),
    }
}

/// The base the Committed list compares against.
struct Base {
    reference: Option<String>,
    commit: Option<String>,
    source: &'static str,
    error: Option<String>,
}

pub fn run(a: &Args) -> Result<(), Fail> {
    let path = a
        .get("path")
        .ok_or_else(|| fail("usage", "--path is required"))?;
    let mode = mode_of(a.get("mode"))?;
    let select = a.get("select");
    if select.is_some() != a.get("file").is_some() {
        return Err(fail("usage", "--select and --file go together"));
    }
    let p = place(path)?;
    let top = p.top.as_path();

    // Taken before Git runs, so an edit during the read changes the next token.
    let token = if a.has("watch") {
        let key = watch::args_key(&[
            Some(path),
            a.get("base"),
            a.get("mode"),
            select,
            a.get("file"),
            a.get("old"),
        ]);
        match watch::before_read(top, &p.common_dir, &key, a.get("since")) {
            watch::Seen::Unchanged(t) => {
                emit(json!({"type": "diff-unchanged", "token": t}));
                return Ok(());
            }
            watch::Seen::Read(t) => t,
        }
    } else {
        None
    };

    let status = status_v2(&git_ok(
        top,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?);

    let staged = diff_rows(top, &["diff", "--cached", "-M"])?;
    let (changes, untracked) = change_rows(top, &status.entries)?;

    let base = resolve_base(top, a.get("base"))?;
    let (from, base_error) = match (&base.commit, &status.oid) {
        (Some(c), Some(_)) if mode == Mode::Tip => (Some(c.clone()), None),
        (Some(c), Some(_)) => match merge_base(top, c)? {
            Some(m) => (Some(m), None),
            None => (
                None,
                Some("the branch and the base share no commit".to_string()),
            ),
        },
        _ => (None, None),
    };
    let committed = match &from {
        Some(f) => diff_rows(top, &["diff", "-M", f, "HEAD"])?,
        None => Vec::new(),
    };

    emit(json!({
        "type": "diff-place",
        "top": p.top.to_string_lossy(),
        "common_dir": p.common_dir.to_string_lossy(),
        "branch": str_or_null(status.head.as_deref()),
        "head": str_or_null(status.oid.as_deref()),
    }));
    let described = match &base.commit {
        Some(c) => Some(describe(top, c)?),
        None => None,
    };
    emit(json!({
        "type": "diff-base",
        "ref": str_or_null(base.reference.as_deref()),
        "commit": str_or_null(base.commit.as_deref()),
        "short": described.as_ref().map_or(Value::Null, |d| json!(d.0)),
        "time": described.as_ref().map_or(Value::Null, |d| json!(d.1)),
        "source": base.source,
        "error": str_or_null(base.error.as_deref().or(base_error.as_deref())),
        "mode": if mode == Mode::Tip { "tip" } else { "merge-base" },
        "from": str_or_null(from.as_deref()),
    }));
    let mut budget = LIST_BYTES;
    print_section("staged", &staged, &mut budget);
    print_section("changes", &changes, &mut budget);
    print_section("committed", &committed, &mut budget);

    if let (Some(section), Some(file)) = (select, a.get("file")) {
        let spec = patch::Spec {
            section: patch::section_of(section)?,
            file: file.to_string(),
            old: a.get("old").map(str::to_string),
            untracked: section == "changes" && untracked.iter().any(|u| u == file),
            from: from.clone(),
            to: status.oid.clone(),
        };
        // The digest only says when to reload the patch: a file Git cannot read must not fail the lists.
        let (d, bytes, error) = match patch::patch_bytes(top, &spec) {
            Ok(Some(b)) => (digest(&b), json!(b.len()), Value::Null),
            Ok(None) => ("too_large".to_string(), Value::Null, Value::Null),
            Err(f) => ("unreadable".to_string(), Value::Null, json!(f.message)),
        };
        emit(json!({
            "type": "diff-digest", "section": section, "path": file, "digest": d, "bytes": bytes, "error": error,
        }));
    }
    if let Some(t) = token {
        emit(json!({"type": "diff-token", "token": t}));
    }
    Ok(())
}

fn print_section(section: &str, rows: &[Row], budget: &mut usize) {
    let lines: Vec<String> = rows
        .iter()
        .take(MAX_ROWS)
        .map(|r| row_line(section, r))
        .collect();
    let shown = within(&lines, budget);
    for l in &lines[..shown] {
        println!("{l}");
    }
    if rows.len() > shown {
        emit(json!({"type": "diff-more", "section": section, "omitted": rows.len() - shown}));
    }
}

fn row_line(section: &str, r: &Row) -> String {
    let (added, removed) = match r.counts {
        Some((a, d)) => (json!(a), json!(d)),
        None => (Value::Null, Value::Null),
    };
    json!({
        "type": "diff-file",
        "section": section,
        "path": r.path,
        "old_path": str_or_null(r.old_path.as_deref()),
        "status": r.status.to_string(),
        "added": added,
        "removed": removed,
        "binary": r.binary,
    })
    .to_string()
}

/// How many of `lines` fit in what is left of `budget`, which is reduced by their size.
pub fn within(lines: &[String], budget: &mut usize) -> usize {
    let mut n = 0;
    for l in lines {
        let size = l.len() + 1;
        if size > *budget {
            break;
        }
        *budget -= size;
        n += 1;
    }
    n
}

/// One `git diff … --raw --numstat -z` listing as rows, in Git's order.
fn diff_rows(top: &Path, args: &[&str]) -> Result<Vec<Row>, Fail> {
    let mut full: Vec<&str> = args.to_vec();
    full.extend(DIFF_FLAGS);
    full.extend(["--raw", "--numstat", "-z", "--"]);
    let (raw, counts) = raw_numstat(&git_ok(top, &full)?);
    Ok(raw
        .into_iter()
        .map(|e| {
            let (counts, binary) = counted(&counts, &e.path);
            Row {
                counts,
                binary,
                status: e.status,
                path: e.path,
                old_path: e.old_path,
            }
        })
        .collect())
}

/// The Changes section: tracked files whose worktree differs from the index, as status (which refreshes
/// the index in memory only) lists them, with `git diff`'s counts; then untracked files. Also returns the
/// untracked paths.
fn change_rows(top: &Path, entries: &[StatusEntry]) -> Result<(Vec<Row>, Vec<String>), Fail> {
    let changed: Vec<&str> = entries
        .iter()
        .filter_map(|e| match e {
            StatusEntry::Tracked { worktree, path } if *worktree != '.' => Some(path.as_str()),
            _ => None,
        })
        .collect();
    let (raw, counts) = if changed.is_empty() {
        (Vec::new(), std::collections::HashMap::new())
    } else {
        let mut args = vec!["diff"];
        args.extend(DIFF_FLAGS);
        args.extend(["--raw", "--numstat", "-z", "--no-renames", "--"]);
        let bytes: usize = changed.iter().map(|p| p.len() + 1).sum();
        if changed.len() <= PATHSPEC_PATHS && bytes <= PATHSPEC_BYTES {
            args.extend(&changed);
        }
        raw_numstat(&git_ok(top, &args)?)
    };
    let mut rows = Vec::new();
    let mut untracked = Vec::new();
    for e in entries {
        match e {
            StatusEntry::Tracked { worktree, path } if *worktree != '.' => {
                // status letters for the worktree side are M, D and T, as `git diff --raw` prints them.
                let status = raw
                    .iter()
                    .find(|r| &r.path == path)
                    .map_or(*worktree, |r| r.status);
                let (counts, binary) = counted(&counts, path);
                rows.push(Row {
                    status,
                    path: path.clone(),
                    old_path: None,
                    counts,
                    binary,
                });
            }
            StatusEntry::Unmerged { path } => rows.push(Row {
                status: 'U',
                path: path.clone(),
                old_path: None,
                counts: None,
                binary: false,
            }),
            _ => {}
        }
    }
    for e in entries {
        if let StatusEntry::Untracked { path } = e {
            untracked.push(path.clone());
            let (counts, binary) = untracked_counts(&top.join(path));
            rows.push(Row {
                status: '?',
                path: path.clone(),
                old_path: None,
                counts,
                binary,
            });
        }
    }
    Ok((rows, untracked))
}

/// What `git diff --no-index --numstat -- /dev/null <file>` prints for a new file, read without Git: its
/// lines, and whether it is binary. A symlink is one line (its target); a folder (a nested repository), an
/// unreadable file or one past `COUNT_LIMIT` has no counts.
fn untracked_counts(file: &Path) -> (Counts, bool) {
    let Ok(meta) = fs::symlink_metadata(file) else {
        return (None, false);
    };
    if meta.file_type().is_symlink() {
        return (Some((1, 0)), false);
    }
    if !meta.is_file() || meta.len() > COUNT_LIMIT {
        return (None, false);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    if fs::File::open(file)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .is_err()
    {
        return (None, false);
    }
    if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
        return (None, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    let last = u64::from(bytes.last().is_some_and(|&b| b != b'\n'));
    (Some((newlines + last, 0)), false)
}

/// `--base` when given (checked as a commit), else `origin/main`, else `origin/HEAD`'s target, else none.
fn resolve_base(top: &Path, typed: Option<&str>) -> Result<Base, Fail> {
    if let Some(r) = typed {
        let commit = commit_of(top, r)?;
        return Ok(Base {
            error: commit
                .is_none()
                .then(|| format!("{r} is not a commit in this repository")),
            reference: Some(r.to_string()),
            commit,
            source: "typed",
        });
    }
    if let Some(c) = commit_of(top, "refs/remotes/origin/main")? {
        return Ok(Base {
            reference: Some("origin/main".into()),
            commit: Some(c),
            source: "default",
            error: None,
        });
    }
    let out = git(
        top,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )?;
    let target = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && !target.is_empty() {
        if let Some(c) = commit_of(top, &target)? {
            let name = target
                .strip_prefix("refs/remotes/")
                .unwrap_or(&target)
                .to_string();
            return Ok(Base {
                reference: Some(name),
                commit: Some(c),
                source: "default",
                error: None,
            });
        }
    }
    Ok(Base {
        reference: None,
        commit: None,
        source: "none",
        error: None,
    })
}

fn merge_base(top: &Path, commit: &str) -> Result<Option<String>, Fail> {
    let out = git(top, &["merge-base", commit, "HEAD"])?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((out.status.success() && !sha.is_empty()).then_some(sha))
}

#[cfg(test)]
mod tests {
    use super::within;

    #[test]
    fn within_stops_at_the_budget_and_carries_it_over() {
        let lines: Vec<String> = ["aaaa", "bbbb", "cccc"].map(String::from).to_vec();
        let mut budget = 11;
        assert_eq!(within(&lines, &mut budget), 2);
        assert_eq!(budget, 1);
        assert_eq!(within(&lines, &mut budget), 0);
        let mut plenty = 100;
        assert_eq!(within(&lines, &mut plenty), 3);
    }
}
