//! An exclusive `flock` that one `bw` process holds across a start that a second one must not repeat.

use std::fs;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// Held until dropped; the kernel lets it go when its process ends, dead or not.
pub struct Held {
    _file: fs::File,
}

/// Takes the lock on `path`, waiting up to `wait` for another process to let it go.
pub fn exclusive(path: &Path, wait: Duration) -> Result<Held, String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Held { _file: file }),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err(format!(
                    "another bw held {} for {} s",
                    path.display(),
                    wait.as_secs()
                ))
            }
            Err(fs::TryLockError::Error(e)) => {
                return Err(format!("cannot lock {}: {e}", path.display()))
            }
        }
    }
}
