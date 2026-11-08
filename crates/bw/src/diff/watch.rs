//! The watcher behind `bw diff files --watch`. One detached `bw diff watch` per worktree counts file events
//! in the worktree and its Git folder, so a poll whose token still names the watcher and its count answers
//! `diff-unchanged` without running Git. A full read is the answer whenever the watcher is missing, stale,
//! replaced or failed.

use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{fail, Fail};
use crate::chat::args::Args;

/// With no `files --watch` call for this long, the watcher exits. `BW_WATCH_IDLE_MS` shortens it in tests.
const IDLE: Duration = Duration::from_secs(60);
/// A watcher rewrites its state at least this often while it runs.
const BEAT: Duration = Duration::from_secs(5);
/// A watcher that failed to start is not started again for this long.
const FAILED: Duration = Duration::from_secs(300);

/// What a `files --watch` call learns before it reads.
pub enum Seen {
    /// The token the caller sent still holds: nothing changed since that read.
    Unchanged(String),
    /// Read Git; print this token after the read, when a watcher is running.
    Read(Option<String>),
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct State {
    id: String,
    count: u64,
}

/// The files one worktree's watcher keeps under the cache.
struct Slot {
    dir: PathBuf,
    state: PathBuf,
    lease: PathBuf,
    failed: PathBuf,
}

fn idle() -> Duration {
    std::env::var("BW_WATCH_IDLE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(IDLE, Duration::from_millis)
}

fn beat() -> Duration {
    BEAT.min(idle() / 4).max(Duration::from_millis(50))
}

fn slot(top: &Path) -> Slot {
    let dir = crate::chat::cache::cache_dir().join("git-watch");
    let hash = format!("{:x}", Sha256::digest(top.as_os_str().as_encoded_bytes()));
    // The version keeps a newer helper from reading an older watcher's state.
    let name = format!("{}-{}", &hash[..16], env!("CARGO_PKG_VERSION"));
    Slot {
        state: dir.join(format!("{name}.json")),
        lease: dir.join(format!("{name}.lease")),
        failed: dir.join(format!("{name}.failed")),
        dir,
    }
}

/// The arguments a token is good for: another base, mode or selection is another read.
pub fn args_key(parts: &[Option<&str>]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.map_or(&b"\x01"[..], str::as_bytes));
        h.update(b"\0");
    }
    format!("{:x}", h.finalize())[..12].to_string()
}

fn age(file: &Path) -> Option<Duration> {
    let m = fs::metadata(file).ok()?.modified().ok()?;
    Some(SystemTime::now().duration_since(m).unwrap_or_default())
}

/// The running watcher's state, when it beat recently.
fn fresh(s: &Slot) -> Option<State> {
    if age(&s.state)? > beat() * 3 {
        return None;
    }
    serde_json::from_slice(&fs::read(&s.state).ok()?).ok()
}

fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = file.parent().unwrap_or(Path::new("."));
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}",
        file.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
    }
    fs::rename(&tmp, file)
}

fn token(s: &State, key: &str) -> String {
    format!("{}.{}.{key}", s.id, s.count)
}

/// Renews the lease, and starts a watcher when none runs.
pub fn before_read(top: &Path, common_dir: &Path, key: &str, since: Option<&str>) -> Seen {
    let s = slot(top);
    let _ = write_private(&s.lease, b"");
    match fresh(&s) {
        Some(state) => {
            let t = token(&state, key);
            if since == Some(t.as_str()) {
                Seen::Unchanged(t)
            } else {
                Seen::Read(Some(t))
            }
        }
        None => {
            if age(&s.failed).is_none_or(|a| a > FAILED) {
                start(top, common_dir);
            }
            Seen::Read(None)
        }
    }
}

/// A watcher in a process group of its own, so the `hc exec` that ran this call does not end it.
fn start(top: &Path, common_dir: &Path) {
    let Ok(me) = std::env::current_exe() else {
        return;
    };
    let _ = Command::new(me)
        .args(["diff", "watch", "--path"])
        .arg(top)
        .arg("--dir")
        .arg(common_dir)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// `bw diff watch --path <top> --dir <common dir>`: runs until idle, replaced, or the watch fails.
pub fn run(a: &Args) -> Result<(), Fail> {
    let top = PathBuf::from(
        a.get("path")
            .ok_or_else(|| fail("usage", "--path is required"))?,
    );
    let common = a.get("dir").map(PathBuf::from);
    let s = slot(&top);
    if fresh(&s).is_some() {
        return Ok(());
    }
    let id = format!(
        "{:x}{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
    );
    let (tx, rx) = mpsc::channel();
    let watched = (|| {
        let mut w = notify::recommended_watcher(move |e| {
            let _ = tx.send(e);
        })?;
        w.watch(&top, RecursiveMode::Recursive)?;
        if let Some(c) = common.as_ref().filter(|c| !c.starts_with(&top)) {
            w.watch(c, RecursiveMode::Recursive)?;
        }
        Ok::<_, notify::Error>(w)
    })();
    let _watcher = match watched {
        Ok(w) => w,
        Err(e) => {
            let _ = write_private(&s.failed, e.to_string().as_bytes());
            return Err(fail("watch_failed", e.to_string()));
        }
    };
    let mut state = State { id, count: 0 };
    let save = |st: &State| write_private(&s.state, &serde_json::to_vec(st).unwrap_or_default());
    save(&state).map_err(|e| fail("watch_failed", e.to_string()))?;
    // Events name resolved paths (/private/tmp, not /tmp).
    let own = fs::canonicalize(&s.dir).unwrap_or_else(|_| s.dir.clone());
    let mut saved = SystemTime::now();
    loop {
        let mut changed = false;
        match rx.recv_timeout(beat()) {
            Ok(Ok(e)) => changed |= counts(&e, &own),
            // A failed or dropped stream may have missed events: stop, so every poll reads Git.
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let mut failed = false;
        while let Ok(e) = rx.try_recv() {
            match e {
                Ok(e) => changed |= counts(&e, &own),
                Err(_) => failed = true,
            }
        }
        if failed {
            break;
        }
        if !owns(&s, &state.id) {
            return Ok(());
        }
        if age(&s.lease).is_none_or(|a| a > idle()) {
            break;
        }
        if changed {
            state.count += 1;
        }
        if changed || age_since(saved) >= beat() {
            if save(&state).is_err() {
                break;
            }
            saved = SystemTime::now();
        }
    }
    if owns(&s, &state.id) {
        let _ = fs::remove_file(&s.state);
    }
    Ok(())
}

/// Whether the state file is still this watcher's: a second watcher started in a race replaces it.
fn owns(s: &Slot, id: &str) -> bool {
    fs::read(&s.state)
        .ok()
        .and_then(|b| serde_json::from_slice::<State>(&b).ok())
        .is_some_and(|t| t.id == id)
}

fn age_since(t: SystemTime) -> Duration {
    SystemTime::now().duration_since(t).unwrap_or_default()
}

/// Whether an event can change a read: the watcher's own files, when the cache sits inside the
/// worktree (a repository at the home folder), are not changes. An event without paths is a rescan.
fn counts(e: &notify::Event, own: &Path) -> bool {
    if matches!(e.kind, notify::EventKind::Access(_)) {
        return false;
    }
    e.paths.is_empty() || e.paths.iter().any(|p| !p.starts_with(own))
}
