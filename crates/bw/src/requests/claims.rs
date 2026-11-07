//! Claims that let one `bw answer` press keys for an occurrence.
//!
//! Adapted from Flockbook's xplat/flockbook-modfeed/src/answered.rs (MIT, Copyright (c) 2026 Min-Chen Lee): a claim
//! is a file made with an exclusive create, under an OS lock in its folder, before any key goes out. One change: a
//! claim names its occurrence only, never a prompt with the same tool and command, so the next `touch a.txt`
//! prompt is a new occurrence with no claim (Review Focus 1).
//!
//! A claim holds for `HELD_WAIT`; a held one (the key may still land) holds as long as the agent stays blocked.
//! It goes on positive evidence that its occurrence left the screen (`seen`), or when nothing went out (`release`).

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::store;
use crate::chat::cache;
use crate::chat::protocol::fnv1a;

pub const HELD_WAIT: Duration = Duration::from_secs(60);
/// A claim file that does not parse and is younger than this may be another run's mid-write: it is kept.
const UNREAD_GRACE: Duration = Duration::from_secs(1);
const LOCK_TRIES: u32 = 10;
const LOCK_WAIT: Duration = Duration::from_millis(20);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct Mark {
    id: String,
    held: bool,
}

/// What `claim` found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    /// This run claimed the occurrence: it may send the keys.
    Got,
    /// The occurrence is claimed already.
    Taken,
    /// Another run is claiming in this folder now, or no claim could be recorded: nothing is pressed.
    Busy,
}

pub struct Claims {
    dir: PathBuf,
}

impl Claims {
    /// `requests/<core>/<terminal>/claims/`.
    pub fn for_terminal(terminal: &str) -> Claims {
        Claims::at(
            store::requests_dir()
                .join(cache::safe(&cache::core_name()))
                .join(cache::safe(terminal))
                .join("claims"),
        )
    }

    pub fn at(dir: PathBuf) -> Claims {
        Claims { dir }
    }

    fn file(&self, occurrence: &str) -> PathBuf {
        self.dir.join(fnv1a(occurrence))
    }

    fn marks(&self) -> Vec<(PathBuf, Option<Mark>)> {
        let Ok(rd) = fs::read_dir(&self.dir) else {
            return vec![];
        };
        rd.flatten()
            // `.lock`, and claims being written.
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| {
                let p = e.path();
                (p.clone(), read_mark(&p))
            })
            .collect()
    }

    /// Made before the key. `Taken`: this occurrence is claimed already. `Busy`: another run holds the folder's
    /// lock past its wait, or the claim cannot be written; a claim that cannot be recorded never lets a key out.
    pub fn claim(&self, occurrence: &str, blocked: bool, now: SystemTime) -> Claim {
        if self.is_claimed(occurrence, blocked, now) {
            return Claim::Taken;
        }
        if fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)
            .is_err()
        {
            return Claim::Busy;
        }
        let Some(_lock) = FolderLock::take(&self.dir) else {
            return Claim::Busy;
        };
        if self.is_claimed(occurrence, blocked, now) {
            return Claim::Taken;
        }
        let path = self.file(occurrence);
        if path.exists() {
            let mark = read_mark(&path);
            // Another occurrence whose id hashes alike, still live, or one mid-write: decide nothing.
            if fresh_unread(&path, &mark, now) || live(&path, &mark, blocked, now) {
                return Claim::Busy;
            }
            let _ = fs::remove_file(&path);
        }
        let m = Mark {
            id: occurrence.into(),
            held: false,
        };
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let tmp = self
            .dir
            .join(format!(".claim-{}-{nanos}", std::process::id()));
        let written = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .and_then(|mut f| f.write_all(&serde_json::to_vec(&m).unwrap_or_default()));
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
            return Claim::Busy;
        }
        // The claim never exists without its content: written aside, then linked to its name.
        let linked = fs::hard_link(&tmp, &path);
        let _ = fs::remove_file(&tmp);
        match linked {
            Ok(()) => Claim::Got,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Claim::Taken,
            Err(_) => Claim::Busy,
        }
    }

    /// The key may still land (hc held it): the claim lasts while the agent stays blocked.
    pub fn hold(&self, occurrence: &str) {
        let path = self.file(occurrence);
        let Some(mut m) = read_mark(&path).filter(|m| m.id == occurrence) else {
            return;
        };
        m.held = true;
        let tmp = self.dir.join(format!(".hold-{}", std::process::id()));
        if fs::write(&tmp, serde_json::to_vec(&m).unwrap_or_default()).is_ok()
            && fs::rename(&tmp, &path).is_err()
        {
            let _ = fs::remove_file(&tmp);
        }
    }

    /// Nothing went out: the occurrence can be answered again.
    pub fn release(&self, occurrence: &str) {
        let path = self.file(occurrence);
        if read_mark(&path).is_some_and(|m| m.id == occurrence) {
            let _ = fs::remove_file(path);
        }
    }

    pub fn is_claimed(&self, occurrence: &str, blocked: bool, now: SystemTime) -> bool {
        self.marks().iter().any(|(p, m)| {
            m.as_ref().is_some_and(|m| m.id == occurrence) && live(p, m, blocked, now)
        })
    }

    /// A screen read that worked shows the occurrences in `live` (pending or uncertain): every other claim goes.
    /// Never called after a failed read, which is no evidence.
    pub fn seen(&self, live: &[String]) {
        let now = SystemTime::now();
        for (p, m) in self.marks() {
            if fresh_unread(&p, &m, now) {
                continue;
            }
            if m.as_ref().is_some_and(|m| live.contains(&m.id)) {
                continue;
            }
            let _ = fs::remove_file(p);
        }
    }
}

fn read_mark(path: &Path) -> Option<Mark> {
    fs::read(path)
        .ok()
        .and_then(|d| serde_json::from_slice::<Mark>(&d).ok())
}

/// Whether the claim at `path` still holds. A held claim is renewed while the agent is blocked.
fn live(path: &Path, mark: &Option<Mark>, blocked: bool, now: SystemTime) -> bool {
    if mark.as_ref().is_some_and(|m| m.held) && blocked {
        if let Ok(f) = fs::File::options().write(true).open(path) {
            let _ = f.set_modified(now);
        }
        return true;
    }
    let made = fs::metadata(path).and_then(|m| m.modified()).unwrap_or(now);
    // A file from the future (a clock set back) counts as live.
    match now.duration_since(made) {
        Ok(d) => d < HELD_WAIT,
        Err(_) => true,
    }
}

fn fresh_unread(path: &Path, mark: &Option<Mark>, now: SystemTime) -> bool {
    if mark.is_some() {
        return false;
    }
    let Ok(made) = fs::metadata(path).and_then(|m| m.modified()) else {
        return false;
    };
    match now.duration_since(made) {
        Ok(d) => d < UNREAD_GRACE,
        Err(e) => e.duration() < UNREAD_GRACE,
    }
}

/// An OS lock (`flock`) on the folder's `.lock`, held while one run claims. The kernel lets it go when its run
/// ends, so no run ever breaks another's lock.
struct FolderLock {
    _file: fs::File,
}

impl FolderLock {
    fn take(dir: &Path) -> Option<FolderLock> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join(".lock"))
            .ok()?;
        for i in 0..LOCK_TRIES {
            match file.try_lock() {
                Ok(()) => return Some(FolderLock { _file: file }),
                Err(fs::TryLockError::WouldBlock) if i + 1 < LOCK_TRIES => {
                    std::thread::sleep(LOCK_WAIT)
                }
                Err(_) => return None,
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> (tempfile::TempDir, Claims) {
        let tmp = tempfile::tempdir().unwrap();
        let c = Claims::at(tmp.path().join("claims"));
        (tmp, c)
    }

    #[test]
    fn one_claim_per_occurrence() {
        let (_tmp, c) = claims();
        let now = SystemTime::now();
        assert_eq!(c.claim("o1", true, now), Claim::Got);
        assert_eq!(c.claim("o1", true, now), Claim::Taken);
        assert!(c.is_claimed("o1", true, now));
        // The next prompt with the same command is another occurrence.
        assert_eq!(c.claim("o2", true, now), Claim::Got);
    }

    #[test]
    fn release_lets_it_be_claimed_again() {
        let (_tmp, c) = claims();
        let now = SystemTime::now();
        assert_eq!(c.claim("o1", true, now), Claim::Got);
        c.release("o2");
        assert!(c.is_claimed("o1", true, now));
        c.release("o1");
        assert_eq!(c.claim("o1", true, now), Claim::Got);
    }

    #[test]
    fn a_claim_ends_after_the_wait_unless_held_while_blocked() {
        let (_tmp, c) = claims();
        let now = SystemTime::now();
        assert_eq!(c.claim("o1", true, now), Claim::Got);
        assert_eq!(c.claim("o2", true, now), Claim::Got);
        c.hold("o2");
        let later = now + HELD_WAIT + Duration::from_secs(1);
        assert!(!c.is_claimed("o1", true, later));
        assert!(c.is_claimed("o2", true, later));
        assert!(!c.is_claimed("o2", false, later + HELD_WAIT * 2));
        assert_eq!(c.claim("o1", true, later), Claim::Got);
    }

    #[test]
    fn seen_drops_claims_of_occurrences_gone() {
        let (_tmp, c) = claims();
        let now = SystemTime::now();
        c.claim("gone", true, now);
        c.claim("here", true, now);
        c.seen(&["here".to_string()]);
        assert!(!c.is_claimed("gone", true, now));
        assert!(c.is_claimed("here", true, now));
    }

    #[test]
    fn concurrent_claims_give_one_got() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("claims");
        let runs: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || Claims::at(dir).claim("o1", true, SystemTime::now()))
            })
            .collect();
        let got: Vec<Claim> = runs.into_iter().map(|r| r.join().unwrap()).collect();
        assert_eq!(
            got.iter().filter(|c| **c == Claim::Got).count(),
            1,
            "{got:?}"
        );
    }

    #[test]
    fn an_unwritable_folder_claims_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("file"), "").unwrap();
        let c = Claims::at(tmp.path().join("file/claims"));
        assert_eq!(c.claim("o1", true, SystemTime::now()), Claim::Busy);
    }
}
