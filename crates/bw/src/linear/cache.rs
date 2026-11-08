//! The dated cache of Linear's answers under `~/.cache/bellwether/linear/`, kept 30 days, so a list stays
//! on screen while Linear cannot be reached. It holds only `data` from replies, never a request.

use std::path::PathBuf;
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

/// Stores `data` as the answer to `body` now, and removes answers older than 30 days.
pub fn store(body: &Value, data: &Value) {
    let d = dir();
    if std::fs::create_dir_all(&d).is_err() {
        return;
    }
    prune();
    let path = file_for(body);
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let text = json!({"at": now_ms(), "data": data}).to_string();
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
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
