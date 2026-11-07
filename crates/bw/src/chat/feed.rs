//! `bw feed`: the rows of one agent's conversation, whole the first time and as a splice after.
//!
//! `bw` keeps no process between calls. The chat passes back the `cursor` of the last answer; `bw` keeps the
//! hashes of the rows it printed for that cursor in the cache file. When the log grew, it parses the same range
//! again, compares, and prints only the rows from the first one that changed: `splice {at}` and the rows after it.
//!
//! `--session <child>` feeds a sub-agent's own log, parsed with its scope, its state kept apart from the root's.
//!
//! Adapted from Flockbook's xplat/flockbook-modfeed/src/feed.rs (MIT, Copyright (c) 2026 Min-Chen Lee).

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use chrono::{Local, TimeZone, Utc};
use herdr_core::util::Date;
use herdr_core::FileScope;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::args::{self, Args};
use super::protocol::{fnv1a, JsonLines};
use super::{cache, locate, rows, tail, tree};
use crate::requests::cards;

/// The range parsed again on each growth stops growing here; then `bw` starts a new 2 MB tail (splice 0).
pub const MAX_SPAN: u64 = 8 * 1024 * 1024;

/// What one terminal's or one log's last answer covered. Row hashes only, never their text.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub path: String,
    pub start: u64,
    pub size: u64,
    pub pictures: bool,
    pub hashes: Vec<String>,
}

impl State {
    /// `2.<fnv(path)>.<start>.<size>.<fnv(row hashes)>.<p>`, `p` 1 for a `--pictures` read.
    pub fn cursor(&self) -> String {
        format!(
            "2.{}.{}.{}.{}.{}",
            fnv1a(&self.path),
            self.start,
            self.size,
            fnv1a(&self.hashes.join(",")),
            u8::from(self.pictures)
        )
    }
}

/// The log being read and what the `log` line says about it.
pub struct Source<'a> {
    pub path: &'a Path,
    pub agent: &'a str,
    pub terminal: Option<&'a str>,
    /// The root session, also when the log is a sub-agent's.
    pub session: &'a str,
    /// The sub-agent whose own log this is.
    pub child: Option<&'a str>,
    pub scope: FileScope,
}

/// Prints the `log` line and the rows (or `unchanged`) for `src`, and returns the state to keep.
/// `previous` counts only when `cursor` names it, for the same path and mode.
pub fn feed<Tz: TimeZone>(
    src: &Source,
    cursor: Option<&str>,
    previous: Option<&State>,
    pictures: bool,
    out: &mut JsonLines,
    now: &Date,
    tz: &Tz,
) -> std::io::Result<State> {
    let path_s = src.path.to_string_lossy().to_string();
    let size = std::fs::metadata(src.path)?.len();
    let prev = previous.filter(|p| {
        p.path == path_s && p.pictures == pictures && cursor == Some(p.cursor().as_str())
    });
    let log_line = |start: u64, size: u64, cursor: String| {
        let mut v = json!({
            "type": "log",
            "agent": src.agent,
            "terminal": src.terminal,
            "session": src.session,
            "path": path_s,
            "start": start,
            "size": size,
            "cursor": cursor,
        });
        if let Some(c) = src.child {
            v["child"] = json!(c);
        }
        v
    };
    if let Some(p) = prev.filter(|p| p.size == size) {
        out.emit_value(log_line(p.start, p.size, p.cursor()));
        out.emit_value(json!({"type": "unchanged"}));
        return Ok(p.clone());
    }
    // A log that shrank was replaced: read it afresh. One that only grew keeps its range while it is not too big.
    let keep = prev.and_then(|p| (size >= p.size && size - p.start <= MAX_SPAN).then_some(p.start));
    let range = tail::read(src.path, keep, tail::BYTES)?;
    let rs = rows::rows(&parsed(&range, pictures, src.scope), now, tz);
    let mut enc = JsonLines::new();
    for r in &rs {
        enc.emit(r);
    }
    let hashes: Vec<String> = enc.lines.iter().map(|l| fnv1a(l)).collect();
    let mut at = 0;
    if let (Some(prev), Some(_)) = (prev, keep) {
        while at < prev.hashes.len().min(hashes.len()) && prev.hashes[at] == hashes[at] {
            at += 1;
        }
    }
    let state = State {
        path: path_s.clone(),
        start: range.start,
        size: range.size,
        pictures,
        hashes,
    };
    let mut log = log_line(range.start, range.size, state.cursor());
    if let Some(m) = tail::model(&range.lines) {
        log["model"] = json!(m);
    }
    out.emit_value(log);
    out.emit_value(json!({"type": "splice", "at": at, "count": rs.len()}));
    for l in &enc.lines[at..] {
        out.raw(l.clone());
    }
    Ok(state)
}

/// `feed --before <start>`: the rows of the 2 MB before `start`. Keeps no state.
pub fn older<Tz: TimeZone>(
    path: &Path,
    scope: FileScope,
    before: u64,
    pictures: bool,
    out: &mut JsonLines,
    now: &Date,
    tz: &Tz,
) -> std::io::Result<()> {
    let range = tail::read_before(path, before, tail::BYTES)?;
    let rs = rows::rows(&parsed(&range, pictures, scope), now, tz);
    out.emit_value(json!({
        "type": "older",
        "path": path.to_string_lossy(),
        "start": range.start,
        "count": rs.len(),
    }));
    for r in &rs {
        out.emit(r);
    }
    Ok(())
}

fn parsed(
    range: &tail::Range,
    pictures: bool,
    scope: FileScope,
) -> Vec<herdr_core::ConversationItem> {
    if pictures {
        tail::items_at(range, scope)
    } else {
        tail::items(&range.lines, scope)
    }
}

/// The session a log file holds, from its name: Claude's `<session>.jsonl`, Codex's
/// `rollout-<time>-<session>.jsonl`.
pub fn session_of(path: &Path, agent: &str) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    const ID: usize = 36;
    if agent == "codex" && stem.starts_with("rollout-") && stem.len() > ID {
        if let Some(id) = stem.get(stem.len() - ID..) {
            return id.to_string();
        }
    }
    stem
}

/// `BW_NOW_MS` when set, for tests; else the clock.
pub fn now() -> Date {
    std::env::var("BW_NOW_MS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
        .unwrap_or_else(Utc::now)
}

const USAGE: &str = "usage: bw feed (--terminal <t> [--session <child>] \
    | --log <path> --agent claude|codex [--scope root|claude-subagent|codex-child:<ordinal>]) \
    [--cursor <c> | --before <start>] [--pictures] [--tree] [--cards]";

pub fn run(argv: &[String]) -> ExitCode {
    let a = match args::parse(
        argv,
        &["pictures", "tree", "cards"],
        &[
            "terminal", "log", "agent", "cursor", "before", "session", "scope",
        ],
    ) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    // `BW_TZ=UTC` keeps the saved outputs' clock times the same on every machine.
    if std::env::var("BW_TZ").is_ok_and(|v| v == "UTC") {
        run_in(&a, &now(), &Utc)
    } else {
        run_in(&a, &now(), &Local)
    }
}

/// `--scope` for a file of `agent`: `root`, Claude's `claude-subagent`, Codex's `codex-child:<ordinal>`.
fn scope_arg(value: Option<&str>, agent: &str) -> Option<FileScope> {
    match (value, agent) {
        (None | Some("root"), _) => Some(FileScope::Root),
        (Some("claude-subagent"), "claude") => Some(FileScope::ClaudeSubagent),
        (Some(v), "codex") => v
            .strip_prefix("codex-child:")?
            .parse()
            .ok()
            .map(|from_ordinal| FileScope::CodexChild { from_ordinal }),
        _ => None,
    }
}

/// What one call reads besides the range: `--pictures`, `--tree`, `--cards`, and a range before `--before`.
struct Ask<'a> {
    cursor: Option<&'a str>,
    before: Option<u64>,
    pictures: bool,
    tree: bool,
    cards: bool,
}

fn run_in<Tz: TimeZone>(a: &Args, now: &Date, tz: &Tz) -> ExitCode {
    let before = match a.get("before").map(str::parse::<u64>) {
        None => None,
        Some(Ok(b)) => Some(b),
        Some(Err(_)) => return crate::usage(&format!("--before needs a byte offset; {USAGE}")),
    };
    if before.is_some() && a.get("cursor").is_some() {
        return crate::usage(&format!("--before takes no --cursor; {USAGE}"));
    }
    if before.is_some() && (a.has("tree") || a.has("cards")) {
        return crate::usage(&format!("--before takes no --tree or --cards; {USAGE}"));
    }
    let ask = Ask {
        cursor: a.get("cursor"),
        before,
        pictures: a.has("pictures"),
        tree: a.has("tree"),
        cards: a.has("cards"),
    };
    let mut out = JsonLines::new();
    let result = match (a.get("terminal"), a.get("log"), a.get("agent")) {
        (Some(t), None, None) if a.get("scope").is_none() => {
            by_terminal(t, a.get("session"), &ask, &mut out, now, tz)
        }
        (None, Some(log), Some(agent @ ("claude" | "codex")))
            if a.get("session").is_none() && !ask.cards =>
        {
            let Some(scope) = scope_arg(a.get("scope"), agent) else {
                return crate::usage(&format!(
                    "--scope {:?} is not one of {agent}'s; {USAGE}",
                    a.get("scope").unwrap_or_default()
                ));
            };
            if ask.tree && scope != FileScope::Root {
                return crate::usage(&format!("--tree reads a root log; {USAGE}"));
            }
            by_log(Path::new(log), agent, scope, &ask, &mut out, now, tz)
        }
        _ => return crate::usage(USAGE),
    };
    match result {
        Ok(()) => {
            print!("{}", out.text());
            ExitCode::SUCCESS
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            super::error("not_found", &format!("no session log: {e}"))
        }
        Err(e) => super::error("io", &format!("cannot read the session log: {e}")),
    }
}

fn by_log<Tz: TimeZone>(
    path: &Path,
    agent: &str,
    scope: FileScope,
    ask: &Ask,
    out: &mut JsonLines,
    now: &Date,
    tz: &Tz,
) -> std::io::Result<()> {
    if !path.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            path.to_string_lossy().to_string(),
        ));
    }
    if let Some(b) = ask.before {
        return older(path, scope, b, ask.pictures, out, now, tz);
    }
    if ask.tree {
        out.emit_value(tree::tree_of_log(path, agent).line());
    }
    let session = session_of(path, agent);
    let src = Source {
        path,
        agent,
        terminal: None,
        session: &session,
        child: None,
        scope,
    };
    let file = match scope {
        FileScope::Root => cache::log_file(path),
        FileScope::ClaudeSubagent => cache::scoped_log_file(path, "claude-subagent"),
        FileScope::CodexChild { from_ordinal } => {
            cache::scoped_log_file(path, &format!("codex-child:{from_ordinal}"))
        }
    };
    with_state(&file, &src, ask.cursor, ask.pictures, out, now, tz)
}

/// The terminal's rows, then with `--cards` its requests, from one `hc get`, so a chat poll is one call.
fn by_terminal<Tz: TimeZone>(
    terminal: &str,
    child: Option<&str>,
    ask: &Ask,
    out: &mut JsonLines,
    now: &Date,
    tz: &Tz,
) -> std::io::Result<()> {
    let (record, found) = locate::locate_with_record(terminal, now.timestamp_millis(), false);
    let mut tree = None;
    let fed = rows_of(terminal, child, &found, ask, &mut tree, out, now, tz);
    if ask.cards && fed.is_ok() {
        cards::emit(
            terminal,
            record.as_ref(),
            &found,
            tree,
            now.timestamp_millis(),
            out,
        );
    }
    fed
}

#[expect(
    clippy::too_many_arguments,
    reason = "by_terminal's parts, kept apart so the cards follow every outcome"
)]
fn rows_of<Tz: TimeZone>(
    terminal: &str,
    child: Option<&str>,
    found: &Result<locate::Located, locate::LocateFailure>,
    ask: &Ask,
    tree_out: &mut Option<tree::Tree>,
    out: &mut JsonLines,
    now: &Date,
    tz: &Tz,
) -> std::io::Result<()> {
    let located = match found {
        Ok(l) => l,
        Err(f) => {
            out.emit_value(f.state_line());
            return Ok(());
        }
    };
    let path: PathBuf = located.path.clone();
    // The log can go between locating it and reading it (a session cleared and its file removed).
    if !path.is_file() {
        let gone = locate::LocateFailure::NoLog {
            agent: located.agent.clone(),
            session: None,
        };
        out.emit_value(gone.state_line());
        return Ok(());
    }
    let tree = (ask.tree || child.is_some() || ask.cards).then(|| tree::tree_of(located));
    if let Some(t) = tree.as_ref().filter(|_| ask.tree) {
        out.emit_value(t.line());
    }
    tree_out.clone_from(&tree);
    let (path, scope, cache_file) = match (child, &tree) {
        (Some(id), Some(t)) => {
            let Some(c) = t.child(id).filter(|c| c.path.is_file()) else {
                let mut v = json!({"type": "state", "state": "no_child", "child": id});
                if t.child(id).is_some() {
                    v["message"] = json!("no log for this sub-agent yet");
                }
                out.emit_value(v);
                return Ok(());
            };
            (c.path.clone(), c.scope, cache::child_file(terminal, id))
        }
        _ => (path, FileScope::Root, cache::terminal_file(terminal)),
    };
    if let Some(b) = ask.before {
        return older(&path, scope, b, ask.pictures, out, now, tz);
    }
    let src = Source {
        path: &path,
        agent: &located.agent,
        terminal: Some(terminal),
        session: &located.session,
        child,
        scope,
    };
    with_state(&cache_file, &src, ask.cursor, ask.pictures, out, now, tz)
}

/// Feeds `src` with the state kept in `file`, then keeps the new state there beside what else the file holds.
fn with_state<Tz: TimeZone>(
    file: &Path,
    src: &Source,
    cursor: Option<&str>,
    pictures: bool,
    out: &mut JsonLines,
    now: &Date,
    tz: &Tz,
) -> std::io::Result<()> {
    let mut kept = cache::read(file);
    let previous = kept
        .feed
        .as_ref()
        .and_then(|v| serde_json::from_value::<State>(v.clone()).ok());
    let state = feed(src, cursor, previous.as_ref(), pictures, out, now, tz)?;
    if previous.as_ref() != Some(&state) {
        kept.feed = serde_json::to_value(&state).ok();
        // A cache that cannot be written costs the next read a whole splice, nothing more.
        let _ = cache::write(file, &kept);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_from_file_name() {
        let codex = Path::new(
            "/s/2026/11/06/rollout-2026-11-06T22-11-05-01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc.jsonl",
        );
        assert_eq!(
            session_of(codex, "codex"),
            "01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc"
        );
        let claude = Path::new("/p/-scratch/e186f156-fd30-4aab-a0b6-d3922b281731.jsonl");
        assert_eq!(
            session_of(claude, "claude"),
            "e186f156-fd30-4aab-a0b6-d3922b281731"
        );
        assert_eq!(session_of(Path::new("/x/short.jsonl"), "codex"), "short");
    }

    #[test]
    fn cursor_names_path_range_rows_and_mode() {
        let s = State {
            path: "/a.jsonl".into(),
            start: 10,
            size: 99,
            pictures: true,
            hashes: vec!["1".into(), "2".into()],
        };
        assert_eq!(
            s.cursor(),
            format!("2.{}.10.99.{}.1", fnv1a("/a.jsonl"), fnv1a("1,2"))
        );
        let plain = State {
            pictures: false,
            ..s.clone()
        };
        assert!(plain.cursor().ends_with(".0"));
    }
}
