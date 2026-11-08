//! The dated cache of Linear's answers under `~/.cache/bellwether/linear/`, kept 30 days, so a list stays
//! on screen while Linear cannot be reached. It holds only `data` from replies, never a request.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const KEEP: Duration = Duration::from_secs(30 * 24 * 3600);

pub fn dir() -> PathBuf {
    crate::chat::cache::cache_dir().join("linear")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn file_for(body: &Value) -> PathBuf {
    let hex: String = Sha256::digest(body.to_string().as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    dir().join(format!("{hex}.json"))
}

/// Makes `dir` and any missing parents readable by this account only, as the other caches are; a folder an
/// earlier build made with the umask's mode is narrowed too.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

/// Writes `bytes` to `path` as a file only this account can read, through a temporary file and a rename.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Stores `data` as the answer to `body` now, and removes answers older than 30 days.
pub fn store(body: &Value, data: &Value) {
    if private_dir(&dir()).is_err() {
        return;
    }
    prune();
    let text = json!({"at": now_ms(), "data": data}).to_string();
    let _ = write_private(&file_for(body), text.as_bytes());
}

/// The stored answer to `body` and when it was stored (ms), when there is one younger than 30 days.
pub fn load(body: &Value) -> Option<(Value, i64)> {
    let text = std::fs::read_to_string(file_for(body)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let at = v["at"].as_i64()?;
    if now_ms() - at > KEEP.as_millis() as i64 {
        return None;
    }
    Some((v["data"].clone(), at))
}

/// Removes answers and attached descriptions older than 30 days.
pub fn prune() {
    let now = SystemTime::now();
    let d = dir();
    for e in [d.join("attach"), d]
        .iter()
        .filter_map(|p| std::fs::read_dir(p).ok())
        .flatten()
        .flatten()
    {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP);
        if old && e.path().is_file() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
