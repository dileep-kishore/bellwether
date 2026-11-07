//! Codex's effective `developer_instructions` on this machine, layered as Codex 0.167 does.
//!
//! Lowest to highest: `$CODEX_HOME/config.toml`, `$CODEX_HOME/<profile>.config.toml` when the agent runs with
//! `--profile`, then each `.codex/config.toml` from the project root down to the working folder whose folder
//! (or an ancestor) `config.toml` marks trusted. A layer without the key leaves the value below it. The root is
//! `git rev-parse --show-toplevel`, else the working folder alone. `codex debug prompt-input` is the known
//! answer (tests/agent.rs).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const KEY: &str = "developer_instructions";

/// The value Codex would use, or None when no layer sets one; Err names a file Codex would refuse to load.
pub fn effective(
    codex_home: &Path,
    cwd: &Path,
    profile: Option<&str>,
) -> Result<Option<String>, String> {
    let base_path = codex_home.join("config.toml");
    let base = load(&base_path)?;
    let mut value = match &base {
        Some(t) => string(t, &base_path)?,
        None => None,
    };
    if let Some(p) = profile {
        let path = codex_home.join(format!("{p}.config.toml"));
        if let Some(t) = load(&path)? {
            value = string(&t, &path)?.or(value);
        }
    }
    let trust = trust_entries(base.as_ref());
    for folder in project_folders(cwd) {
        let path = folder.join(".codex/config.toml");
        if !path.is_file() || !trusted(&trust, &folder) {
            continue;
        }
        if let Some(t) = load(&path)? {
            value = string(&t, &path)?.or(value);
        }
    }
    Ok(value)
}

fn load(path: &Path) -> Result<Option<toml::Table>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    text.parse::<toml::Table>()
        .map(Some)
        .map_err(|e| format!("{} does not parse: {}", path.display(), e.message()))
}

fn string(t: &toml::Table, path: &Path) -> Result<Option<String>, String> {
    match t.get(KEY) {
        None => Ok(None),
        Some(toml::Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{KEY} in {} is not a string", path.display())),
    }
}

fn canonical(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// `projects."<folder>".trust_level` from `config.toml`, keyed by the canonical folder, since Codex resolves
/// symlinks such as macOS's /tmp before it looks a folder up.
fn trust_entries(base: Option<&toml::Table>) -> Vec<(PathBuf, bool)> {
    let Some(projects) = base
        .and_then(|t| t.get("projects"))
        .and_then(toml::Value::as_table)
    else {
        return Vec::new();
    };
    projects
        .iter()
        .map(|(folder, entry)| {
            let level = entry.get("trust_level").and_then(toml::Value::as_str);
            (canonical(Path::new(folder)), level == Some("trusted"))
        })
        .collect()
}

/// The nearest entry for the folder or one of its ancestors decides.
fn trusted(entries: &[(PathBuf, bool)], folder: &Path) -> bool {
    folder
        .ancestors()
        .find_map(|a| entries.iter().find(|(p, _)| p == a).map(|(_, t)| *t))
        .unwrap_or(false)
}

/// From the project root down to the working folder.
fn project_folders(cwd: &Path) -> Vec<PathBuf> {
    let cwd = canonical(cwd);
    let root = git_root(&cwd).filter(|r| cwd.starts_with(r));
    let Some(root) = root else {
        return vec![cwd];
    };
    let mut out: Vec<PathBuf> = cwd
        .ancestors()
        .take_while(|a| *a != root)
        .map(Path::to_path_buf)
        .collect();
    out.push(root);
    out.reverse();
    out
}

fn git_root(cwd: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "rev-parse",
            "--show-toplevel",
        ])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let line = String::from_utf8(out.stdout).ok()?;
    let line = line.trim_end_matches('\n');
    (!line.is_empty()).then(|| canonical(Path::new(line)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_trust_entry_decides() {
        let entries = vec![(PathBuf::from("/a"), true), (PathBuf::from("/a/b"), false)];
        assert!(trusted(&entries, Path::new("/a/c/d")));
        assert!(!trusted(&entries, Path::new("/a/b/c")));
        assert!(!trusted(&entries, Path::new("/z")));
    }
}
