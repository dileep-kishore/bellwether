//! The request store: each prompt occurrence a terminal showed, and its state.
//!
//! One file per terminal, `requests/<core>/<terminal>.json`, for the root session it was written for; a new root
//! starts an empty store. It holds ids, states and the last request line shown (tool, command, labels), never
//! transcript text.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat::cache;
use crate::chat::protocol::fnv1a;

pub const VERSION: u32 = 1;
/// Files under `requests/` older than this go on each save; so do occurrences last seen longer ago.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Resolved occurrences kept per store, newest first, so a reused event or call id is still known as used.
const MAX_RESOLVED: usize = 200;
/// How long `update` waits for another process's lock; a holder keeps it for one load, build and save.
const LOCK_WAIT: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Occurrence {
    /// The bound hook event's id, else the log's call id, else `<screen id>@<first seen ms>`.
    pub id: String,
    /// `approval`, `question`, `question_async` or `prompt`.
    pub kind: String,
    pub screen_id: Option<String>,
    /// The newest hook event bound to it.
    pub event: Option<String>,
    /// The asking call's id in its log (Codex: the `call_…` id), else the one its `PreToolUse` named.
    pub tool_use_id: Option<String>,
    /// The sub-agent named when it was first seen; part of the request id, so it never changes after.
    pub child: Option<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    /// `pending`, `answered`, `declined`, `answered_terminal`, `declined_terminal`, `stale` or `uncertain`.
    pub state: String,
    /// The action `bw answer` sent for it (`approve`, `deny`, `option-1`, `answers`); None when Bellwether sent
    /// nothing.
    pub by: Option<String>,
    pub resolved_ms: Option<i64>,
    /// Every hook event bound to it, so none binds a second occurrence.
    #[serde(default)]
    pub events: Vec<String>,
    /// The request line as last printed while pending, so a resolved card keeps its text.
    #[serde(default)]
    pub shown: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Store {
    pub version: u32,
    /// The root session these occurrences belong to, `none` while the root names none.
    pub root: String,
    pub occurrences: Vec<Occurrence>,
}

impl Store {
    pub fn new(root: &str) -> Store {
        Store {
            version: VERSION,
            root: root.to_string(),
            occurrences: Vec::new(),
        }
    }

    /// Drops occurrences last seen more than a day before `now_ms`, and the oldest resolved past the cap.
    pub fn prune(&mut self, now_ms: i64) {
        let oldest = now_ms - MAX_AGE.as_millis() as i64;
        self.occurrences.retain(|o| o.last_seen_ms >= oldest);
        let mut resolved: Vec<(i64, String)> = self
            .occurrences
            .iter()
            .filter(|o| o.state != "pending" && o.state != "uncertain")
            .map(|o| (o.resolved_ms.unwrap_or(o.last_seen_ms), o.id.clone()))
            .collect();
        if resolved.len() > MAX_RESOLVED {
            resolved.sort_unstable_by(|a, b| b.cmp(a));
            let drop: Vec<String> = resolved
                .split_off(MAX_RESOLVED)
                .into_iter()
                .map(|r| r.1)
                .collect();
            self.occurrences.retain(|o| !drop.contains(&o.id));
        }
    }
}

pub fn requests_dir() -> PathBuf {
    cache::cache_dir().join("requests")
}

/// `requests/<core>/<terminal>.json`.
pub fn store_file(terminal: &str) -> PathBuf {
    requests_dir()
        .join(cache::safe(&cache::core_name()))
        .join(format!("{}.json", cache::safe(terminal)))
}

/// The terminal's store; a missing, unreadable or other-version file reads as empty.
pub fn load(terminal: &str) -> Store {
    load_from(&store_file(terminal))
}

pub fn load_from(file: &Path) -> Store {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Store>(&b).ok())
        .filter(|s| s.version == VERSION)
        .unwrap_or_else(|| Store::new(""))
}

/// Writes the store as a temp file renamed into place (0600, folders 0700), then prunes `requests/` at 24 h.
pub fn save(terminal: &str, s: &Store) -> io::Result<()> {
    save_to(&store_file(terminal), s)?;
    cache::prune(&requests_dir(), MAX_AGE);
    Ok(())
}

pub fn save_to(file: &Path, s: &Store) -> io::Result<()> {
    let dir = file
        .parent()
        .ok_or_else(|| io::Error::other("store file has no folder"))?;
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
        f.write_all(&serde_json::to_vec(s)?)?;
        fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// An exclusive `flock` on `<store>.lock`, held across one read, change and write of the store, so `bw cards` and
/// `bw answer` never write over each other's change. The kernel drops it when its process ends, dead or not.
pub struct StoreLock {
    _file: fs::File,
}

/// Takes the lock beside `file`, waiting up to `LOCK_WAIT` for another process to let it go.
pub fn lock_at(file: &Path) -> io::Result<StoreLock> {
    let dir = file
        .parent()
        .ok_or_else(|| io::Error::other("store file has no folder"))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join(format!("{name}.lock")))?;
    let deadline = std::time::Instant::now() + LOCK_WAIT;
    loop {
        match f.try_lock() {
            Ok(()) => return Ok(StoreLock { _file: f }),
            Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("{} stayed locked", file.display()),
                ))
            }
            Err(fs::TryLockError::Error(e)) => return Err(e),
        }
    }
}

/// Loads the terminal's store under its lock, lets `f` change it, prunes it and writes it back. Err only when the
/// lock cannot be had; a store that cannot be written costs the next pass its occurrences, as before.
pub fn update<R>(terminal: &str, now_ms: i64, f: impl FnOnce(&mut Store) -> R) -> io::Result<R> {
    let file = store_file(terminal);
    let _lock = lock_at(&file)?;
    let mut s = load_from(&file);
    let r = f(&mut s);
    s.prune(now_ms);
    let _ = save(terminal, &s);
    Ok(r)
}

/// `r3.<fnv1a(terminal \n root \n child \n occurrence)>`, the child empty for the root.
pub fn request_id(terminal: &str, root: &str, child: Option<&str>, occurrence: &str) -> String {
    format!(
        "r3.{}",
        fnv1a(&[terminal, root, child.unwrap_or(""), occurrence].join("\n"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occ(id: &str, state: &str, seen: i64) -> Occurrence {
        Occurrence {
            id: id.into(),
            kind: "approval".into(),
            screen_id: None,
            event: None,
            tool_use_id: None,
            child: None,
            first_seen_ms: seen,
            last_seen_ms: seen,
            state: state.into(),
            by: None,
            resolved_ms: (state != "pending").then_some(seen),
            events: vec![],
            shown: None,
        }
    }

    #[test]
    fn ids_name_terminal_root_child_and_occurrence() {
        let a = request_id("t1", "s", None, "o");
        assert_eq!(a, format!("r3.{}", fnv1a("t1\ns\n\no")));
        assert_ne!(a, request_id("t1", "s", Some("c"), "o"));
        assert_ne!(a, request_id("t2", "s", None, "o"));
    }

    #[test]
    fn round_trip_and_prune() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("core/t1.json");
        let day = MAX_AGE.as_millis() as i64;
        let mut s = Store::new("root");
        s.occurrences.push(occ("old", "stale", 0));
        s.occurrences.push(occ("live", "pending", day + 5));
        for n in 0..(MAX_RESOLVED + 3) {
            s.occurrences
                .push(occ(&format!("r{n}"), "answered", day + n as i64));
        }
        s.prune(day + 10);
        assert!(!s.occurrences.iter().any(|o| o.id == "old"));
        assert!(s.occurrences.iter().any(|o| o.id == "live"));
        assert_eq!(s.occurrences.len(), MAX_RESOLVED + 1);
        assert!(!s.occurrences.iter().any(|o| o.id == "r0"));
        save_to(&file, &s).unwrap();
        assert_eq!(load_from(&file), s);
        assert_eq!(load_from(&tmp.path().join("missing.json")).root, "");
    }

    #[test]
    fn concurrent_changes_are_all_kept() {
        // Without the lock two writers each load the same store and the later write drops the other's change.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("core/t1.json");
        let writers: Vec<_> = (0..8)
            .map(|n| {
                let file = file.clone();
                std::thread::spawn(move || {
                    let _lock = lock_at(&file).unwrap();
                    let mut s = load_from(&file);
                    std::thread::sleep(Duration::from_millis(20));
                    s.occurrences.push(occ(&format!("o{n}"), "pending", 1));
                    save_to(&file, &s).unwrap();
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        assert_eq!(load_from(&file).occurrences.len(), 8);
    }

    #[test]
    fn a_held_lock_makes_the_next_wait() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("core/t1.json");
        let held = lock_at(&file).unwrap();
        let waiter = {
            let file = file.clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let _lock = lock_at(&file).unwrap();
                started.elapsed()
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        drop(held);
        assert!(waiter.join().unwrap() >= Duration::from_millis(150));
    }
}
