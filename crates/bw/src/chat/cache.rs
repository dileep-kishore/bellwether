//! What `bw` remembers between calls, one JSON file per terminal: the terminal's log root and its feed state.
//! It holds paths, ids and row hashes only, never transcript text.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::fnv1a;

pub const VERSION: u32 = 1;
/// Files under `feeds/` older than this go on each write.
pub const PRUNE_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Root {
    pub kind: String,
    pub pids: Vec<i32>,
    pub agent_pid: Option<i32>,
    pub path: String,
    pub session: String,
    pub checked_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct TerminalCache {
    pub version: u32,
    pub root: Option<Root>,
    pub feed: Option<Value>,
}

impl Default for TerminalCache {
    fn default() -> TerminalCache {
        TerminalCache {
            version: VERSION,
            root: None,
            feed: None,
        }
    }
}

/// `$BW_CACHE_DIR`, else `$HOME/.cache/bellwether`.
pub fn cache_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("BW_CACHE_DIR").filter(|d| !d.is_empty()) {
        return d.into();
    }
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join(".cache/bellwether")
}

/// The hc core this helper talks to: `HC_SESSION`, else `default`.
pub fn core_name() -> String {
    std::env::var("HC_SESSION")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

/// Characters outside `[A-Za-z0-9_-]` become `_`, so a name never leaves its folder.
pub fn safe(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn feeds_dir() -> PathBuf {
    cache_dir().join("feeds")
}

/// `feeds/<core>/<terminal>.json`.
pub fn terminal_file(terminal: &str) -> PathBuf {
    feeds_dir()
        .join(safe(&core_name()))
        .join(format!("{}.json", safe(terminal)))
}

/// `feeds/<core>/<terminal>.<fnv1a(child)>.json`: a sub-agent's feed state, apart from its terminal's root.
/// It holds no `root`, so `roots_except` never reads it as another terminal's claim.
pub fn child_file(terminal: &str, child: &str) -> PathBuf {
    feeds_dir()
        .join(safe(&core_name()))
        .join(format!("{}.{}.json", safe(terminal), fnv1a(child)))
}

/// `feeds/log/<fnv1a(path)>.json`, for a feed read by log path rather than by terminal.
pub fn log_file(path: &Path) -> PathBuf {
    feeds_dir()
        .join("log")
        .join(format!("{}.json", fnv1a(&path.to_string_lossy())))
}

/// `log_file` for a file read with another scope (`--scope`), whose rows differ from a root read's.
pub fn scoped_log_file(path: &Path, scope: &str) -> PathBuf {
    feeds_dir().join("log").join(format!(
        "{}.{}.json",
        fnv1a(&path.to_string_lossy()),
        fnv1a(scope)
    ))
}

/// A missing, unreadable or other-version file reads as an empty cache.
pub fn read(file: &Path) -> TerminalCache {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<TerminalCache>(&b).ok())
        .filter(|c| c.version == VERSION)
        .unwrap_or_default()
}

/// Writes a temp file beside `file` and renames it over, so a concurrent reader sees the old or the new whole.
/// Then prunes `feeds/` (or, for a file outside it, the file's own folder).
pub fn write(file: &Path, c: &TerminalCache) -> std::io::Result<()> {
    let dir = file
        .parent()
        .ok_or_else(|| std::io::Error::other("cache file has no folder"))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&serde_json::to_vec(c)?)?;
        f.sync_all()?;
        fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    let feeds = feeds_dir();
    prune(
        if file.starts_with(&feeds) {
            &feeds
        } else {
            dir
        },
        PRUNE_AGE,
    );
    Ok(())
}

/// Deletes files under `dir`, at any depth, last changed more than `max_age` ago.
/// Folders stay, since a concurrent writer may be about to rename a file into one.
pub fn prune(dir: &Path, max_age: Duration) {
    let Some(cutoff) = SystemTime::now().checked_sub(max_age) else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            prune(&entry.path(), max_age);
        } else if meta.modified().is_ok_and(|m| m < cutoff) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The roots other terminals' files in `core_dir` remember, keyed by file name without `.json`.
pub fn roots_except(core_dir: &Path, terminal: &str) -> Vec<(String, Root)> {
    let skip = safe(terminal);
    let Ok(entries) = fs::read_dir(core_dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Root)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_name()?.to_str()?.strip_suffix(".json")?;
            if stem == skip || stem.starts_with('.') {
                return None;
            }
            Some((stem.to_string(), read(&path).root?))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn root(path: &str) -> Root {
        Root {
            kind: "codex".into(),
            pids: vec![41, 42],
            agent_pid: Some(42),
            path: path.into(),
            session: "01a1b4a1".into(),
            checked_ms: 1_794_000_000_000,
        }
    }

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("feeds/default/t5.json");
        let c = TerminalCache {
            version: VERSION,
            root: Some(root("/s/rollout.jsonl")),
            feed: Some(serde_json::json!({"cursor": "2.a.0.10.b.1"})),
        };
        write(&file, &c).unwrap();
        assert_eq!(read(&file), c);
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&tmp.path().join("feeds/default")), 0o700);
        assert_eq!(mode(&tmp.path().join("feeds")), 0o700);
        let names: Vec<_> = fs::read_dir(tmp.path().join("feeds/default"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["t5.json"], "no temp file is left behind");
    }

    #[test]
    fn broken_file_reads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("t1.json");
        assert_eq!(read(&file), TerminalCache::default());
        fs::write(&file, "{\"version\":1,\"root\":").unwrap();
        assert_eq!(read(&file), TerminalCache::default());
        fs::write(&file, "{\"version\":9,\"root\":null,\"feed\":{\"x\":1}}").unwrap();
        assert_eq!(read(&file), TerminalCache::default());
        fs::write(&file, "{\"version\":1,\"later\":true,\"feed\":{\"x\":1}}").unwrap();
        assert_eq!(read(&file).feed, Some(serde_json::json!({"x": 1})));
    }

    #[test]
    fn prune_removes_only_old_files() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("default/t1.json");
        let new = tmp.path().join("default/t2.json");
        let old_log = tmp.path().join("log/abc.json");
        for f in [&old, &new, &old_log] {
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, "{}").unwrap();
        }
        let eight_days = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
        for f in [&old, &old_log] {
            fs::File::options()
                .write(true)
                .open(f)
                .unwrap()
                .set_modified(eight_days)
                .unwrap();
        }
        prune(tmp.path(), PRUNE_AGE);
        assert!(!old.exists());
        assert!(!old_log.exists());
        assert!(new.exists());
        assert!(tmp.path().join("default").is_dir());
    }

    #[test]
    fn terminal_names_are_safe_file_names() {
        let core = feeds_dir().join(safe(&core_name()));
        assert_eq!(terminal_file("macmini/t5"), core.join("macmini_t5.json"));
        assert_eq!(terminal_file("../x"), core.join("___x.json"));
        assert_eq!(terminal_file("t12"), core.join("t12.json"));
        assert_eq!(
            child_file("macmini/t5", "a640ed49983e1482a"),
            core.join(format!("macmini_t5.{}.json", fnv1a("a640ed49983e1482a")))
        );
        assert_ne!(
            scoped_log_file(Path::new("/a/b.jsonl"), "claude-subagent"),
            log_file(Path::new("/a/b.jsonl"))
        );
        assert_eq!(
            log_file(Path::new("/a/b.jsonl")),
            feeds_dir()
                .join("log")
                .join(format!("{}.json", fnv1a("/a/b.jsonl")))
        );
    }

    #[test]
    fn other_terminals_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let with = |p: &str| TerminalCache {
            root: Some(root(p)),
            ..TerminalCache::default()
        };
        write(&tmp.path().join("t1.json"), &with("/one")).unwrap();
        write(&tmp.path().join("t2.json"), &with("/two")).unwrap();
        write(&tmp.path().join("t3.json"), &TerminalCache::default()).unwrap();
        fs::write(tmp.path().join("t4.json"), "not json").unwrap();
        let got = roots_except(tmp.path(), "t1");
        assert_eq!(got, vec![("t2".to_string(), root("/two"))]);
    }
}
