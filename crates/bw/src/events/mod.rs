//! `bw event`: records one Claude or Codex hook payload for the chat; decides nothing.
//!
//! `hooks/bw-event` runs it with the payload on stdin. Each event is one file,
//! `events/<terminal>/<at_ms>-<pid>-<n>.json`, holding the fields of `Event` only, never transcript text.
//! The folder is keyed by terminal alone: readers filter by session and child ids.

use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat::cache;

pub const VERSION: u32 = 1;
/// The events a request or the session tree is read from. `PreToolUse` carries the call's `tool_use_id`, which
/// neither agent puts on the `PermissionRequest` that follows it 20 to 45 ms later.
pub const EVENTS: [&str; 4] = [
    "PermissionRequest",
    "PreToolUse",
    "SubagentStart",
    "SubagentStop",
];
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
pub const MAX_FILES: usize = 2000;
const MAX_PAYLOAD: u64 = 4 * 1024 * 1024;
const MAX_COMMAND: usize = 2000;

static SEQ: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub v: u32,
    pub id: String,
    pub at_ms: i64,
    pub agent: String,
    pub event: String,
    pub terminal: String,
    pub core: String,
    pub session: Option<String>,
    pub transcript: Option<String>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub tool: Option<String>,
    pub command: Option<String>,
    pub tool_use_id: Option<String>,
    pub cwd: Option<String>,
}

pub fn run(args: &[String]) -> ExitCode {
    let agent = match args {
        [flag, a] if flag == "--agent" && (a == "claude" || a == "codex") => a.as_str(),
        _ => return crate::usage("usage: bw event --agent claude|codex"),
    };
    // Every failure past usage is silent: the hook's output is never an answer, and the chat copes without it.
    let _ = record(agent);
    ExitCode::SUCCESS
}

fn record(agent: &str) -> Option<PathBuf> {
    let terminal = std::env::var("HC_TERMINAL_ID").ok()?;
    if !safe_terminal(&terminal) {
        return None;
    }
    let mut bytes = Vec::new();
    let mut stdin = io::stdin().lock();
    stdin
        .by_ref()
        .take(MAX_PAYLOAD + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_PAYLOAD {
        // Drain the rest so the agent's write never fails on a closed pipe.
        let _ = io::copy(&mut stdin, &mut io::sink());
        return None;
    }
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    let e = from_payload(agent, &terminal, &cache::core_name(), &payload, now_ms())?;
    write(&e).ok()
}

/// A terminal id that names one folder: `t5`, never `bwloop/t5` or `..`.
fn safe_terminal(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 64
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The event of one hook payload; None for an event Bellwether does not record or a payload that is not an object.
pub fn from_payload(
    agent: &str,
    terminal: &str,
    core: &str,
    payload: &Value,
    at_ms: i64,
) -> Option<Event> {
    let event = payload.get("hook_event_name")?.as_str()?;
    if !EVENTS.contains(&event) {
        return None;
    }
    let text = |k: &str| payload.get(k).and_then(Value::as_str).map(String::from);
    let command = payload.get("tool_input").and_then(|input| {
        let text = match input
            .get("command")
            .or_else(|| input.get("file_path"))
            .and_then(Value::as_str)
        {
            Some(s) => s.to_string(),
            None if input.is_null() => return None,
            None => serde_json::to_string(input).ok()?,
        };
        Some(text.chars().take(MAX_COMMAND).collect())
    });
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    Some(Event {
        v: VERSION,
        id: format!("{at_ms}-{}-{n}", std::process::id()),
        at_ms,
        agent: agent.to_string(),
        event: event.to_string(),
        terminal: terminal.to_string(),
        core: core.to_string(),
        session: text("session_id"),
        transcript: text("transcript_path"),
        agent_id: text("agent_id"),
        agent_type: text("agent_type"),
        tool: text("tool_name"),
        command,
        tool_use_id: text("tool_use_id"),
        cwd: text("cwd"),
    })
}

pub fn events_dir() -> PathBuf {
    cache::cache_dir().join("events")
}

/// Writes the event as a temp file renamed into place (0600, folders 0700), then prunes `events/`.
pub fn write(e: &Event) -> io::Result<PathBuf> {
    write_in(&events_dir(), e)
}

fn write_in(root: &Path, e: &Event) -> io::Result<PathBuf> {
    if !safe_terminal(&e.terminal) {
        return Err(io::Error::other("unsafe terminal id"));
    }
    let dir = root.join(&e.terminal);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let file = dir.join(format!("{}.json", e.id));
    let tmp = dir.join(format!(".{}.tmp", e.id));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&serde_json::to_vec(e)?)?;
        fs::rename(&tmp, &file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    prune(root, MAX_AGE, MAX_FILES);
    Ok(file)
}

/// The terminal's events from `since_ms` on, oldest first; unreadable files are skipped.
pub fn read(terminal: &str, since_ms: i64) -> Vec<Event> {
    read_in(&events_dir(), terminal, since_ms)
}

fn read_in(root: &Path, terminal: &str, since_ms: i64) -> Vec<Event> {
    if !safe_terminal(terminal) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root.join(terminal)) else {
        return Vec::new();
    };
    let mut out: Vec<Event> = entries
        .flatten()
        .filter(|f| f.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|f| fs::read(f.path()).ok())
        .filter_map(|b| serde_json::from_slice::<Event>(&b).ok())
        .filter(|e| e.v == VERSION && e.at_ms >= since_ms)
        .collect();
    out.sort_by(|a, b| (a.at_ms, &a.id).cmp(&(b.at_ms, &b.id)));
    out
}

/// Deletes files under `dir/<terminal>/` older than `max_age`, then the oldest until `max_files` remain.
/// A file's age is the `at_ms` its name starts with, else its modification time.
pub fn prune(dir: &Path, max_age: Duration, max_files: usize) {
    let now = now_ms();
    let oldest = now - max_age.as_millis() as i64;
    let mut kept: Vec<(i64, PathBuf)> = Vec::new();
    for d in fs::read_dir(dir).into_iter().flatten().flatten() {
        for f in fs::read_dir(d.path()).into_iter().flatten().flatten() {
            let path = f.path();
            let name = f.file_name().to_string_lossy().into_owned();
            let named = name.split('-').next().and_then(|ms| ms.parse::<i64>().ok());
            let Some(at) = named.or_else(|| modified_ms(&path)) else {
                continue;
            };
            if at < oldest {
                let _ = fs::remove_file(&path);
            } else if name.ends_with(".json") {
                kept.push((at, path));
            }
        }
    }
    if kept.len() > max_files {
        kept.sort();
        for (_, path) in &kept[..kept.len() - max_files] {
            let _ = fs::remove_file(path);
        }
    }
}

fn modified_ms(path: &Path) -> Option<i64> {
    let t = fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_lists_one_terminal_oldest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let p = json!({"hook_event_name": "SubagentStart", "session_id": "s", "agent_id": "a"});
        let now = now_ms();
        let late = from_payload("claude", "t5", "default", &p, now).unwrap();
        let early = from_payload("claude", "t5", "default", &p, now - 10).unwrap();
        let other = from_payload("claude", "t6", "default", &p, now).unwrap();
        let old = from_payload("claude", "t5", "default", &p, now - 1000).unwrap();
        for e in [&late, &early, &other, &old] {
            write_in(root, e).unwrap();
        }
        fs::write(root.join("t5/broken.json"), "{").unwrap();
        assert_eq!(read_in(root, "t5", now - 500), vec![early, late]);
        assert!(read_in(root, "../t5", 0).is_empty());
    }
}
