//! `bw tree`: the sub-agents of the session a terminal shows, from the files the agent writes beside its log.
//!
//! Claude keeps `<root stem>/subagents/agent-<id>.meta.json` (type, description, depth, parent, finished) beside
//! each child's own log. Codex lists its children as `SubAgentActivity` items in the parent's rollout; each child's
//! rollout sits in the root's own sessions folder and its `session_meta` names its depth, nickname and where its
//! own history starts. Nothing here scans every session.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use herdr_core::session_log;
use herdr_core::FileScope;
use serde_json::{json, Value};

use super::args;
use super::locate::{self, Located};
use super::protocol::JsonLines;
use super::{feed, tail};

/// Codex children nest at most this deep; deeper ones are not listed.
pub const MAX_CODEX_DEPTH: u32 = 8;
/// A description is cut to this many characters.
const DESCRIPTION_CHARS: usize = 120;
/// A line longer than this is not read for its timestamp or `session_meta` (a pasted picture).
const MAX_META_LINE: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Child {
    pub id: String,
    /// The root session's id, or the id of the child that started this one.
    pub parent: String,
    pub depth: u32,
    pub agent_type: String,
    pub nickname: Option<String>,
    pub description: String,
    /// The parent's `Agent` or `spawn_agent` call that started it.
    pub tool_use_id: Option<String>,
    pub background: bool,
    pub running: bool,
    /// The child's own log; empty when the agent has not written it yet.
    pub path: PathBuf,
    pub scope: FileScope,
    pub started_ms: Option<i64>,
    pub ended_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tree {
    pub agent: String,
    pub root: String,
    pub path: PathBuf,
    /// In start order; a child with no start time keeps its place after those with one.
    pub children: Vec<Child>,
}

impl Tree {
    pub fn child(&self, id: &str) -> Option<&Child> {
        self.children.iter().find(|c| c.id == id)
    }

    pub fn line(&self) -> Value {
        let children: Vec<Value> = self
            .children
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "parent": c.parent,
                    "depth": c.depth,
                    "type": c.agent_type,
                    "nickname": c.nickname,
                    "description": c.description,
                    "tool_use_id": c.tool_use_id,
                    "background": c.background,
                    "state": if c.running { "running" } else { "done" },
                    "started_ms": c.started_ms,
                    "ended_ms": c.ended_ms,
                })
            })
            .collect();
        json!({"type": "tree", "agent": self.agent, "root": self.root, "children": children})
    }
}

/// The tree of the conversation `located` names: Claude's children beside its log, Codex's in the root rollout's
/// own sessions folder (the agent's environment, and so its `CODEX_HOME`, cannot be read on macOS 27).
pub fn tree_of(located: &Located) -> Tree {
    tree_at(&located.path, &located.agent, &located.session)
}

fn tree_at(path: &Path, agent: &str, session: &str) -> Tree {
    match agent {
        "claude" => claude_tree(path, session),
        "codex" => match codex_sessions_dir(path) {
            Some(dir) => codex_tree(path, session, &dir),
            None => empty(path, agent, session),
        },
        _ => empty(path, agent, session),
    }
}

fn empty(path: &Path, agent: &str, session: &str) -> Tree {
    Tree {
        agent: agent.into(),
        root: session.into(),
        path: path.to_path_buf(),
        children: Vec::new(),
    }
}

/// `<home>/sessions` for a rollout at `<home>/sessions/YYYY/MM/DD/<file>`.
fn codex_sessions_dir(root: &Path) -> Option<PathBuf> {
    root.ancestors().nth(4).map(Path::to_path_buf)
}

pub fn claude_tree(root_path: &Path, root_session: &str) -> Tree {
    let dir = root_path.with_extension("").join("subagents");
    let mut children: Vec<Child> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?;
            claude_child(&dir, id, root_session)
        })
        .collect();
    sort_by_start(&mut children);
    Tree {
        agent: "claude".into(),
        root: root_session.into(),
        path: root_path.to_path_buf(),
        children,
    }
}

fn claude_child(dir: &Path, id: &str, root_session: &str) -> Option<Child> {
    let meta: Value =
        serde_json::from_slice(&std::fs::read(dir.join(format!("agent-{id}.meta.json"))).ok()?)
            .ok()?;
    let agent_type = meta["agentType"].as_str().unwrap_or_default();
    // Claude's own helper agents (the next-prompt suggestion) have no type and are not the user's sub-agents.
    if agent_type.is_empty() {
        return None;
    }
    let path = dir.join(format!("agent-{id}.jsonl"));
    // `finished` is absent while the child runs and `true` once it ended.
    let running = meta["finished"].as_bool() != Some(true);
    let parent = meta["parentAgentId"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or(root_session);
    let depth = meta["spawnDepth"]
        .as_u64()
        .and_then(|d| u32::try_from(d).ok())
        .unwrap_or(if parent == root_session { 1 } else { 2 });
    Some(Child {
        id: id.into(),
        parent: parent.into(),
        depth,
        agent_type: agent_type.into(),
        nickname: None,
        description: cut(meta["description"].as_str().unwrap_or_default()),
        tool_use_id: meta["toolUseId"].as_str().map(String::from),
        background: meta["requestShape"].as_str() == Some("background"),
        running,
        started_ms: first_timestamp(&path),
        ended_ms: if running { None } else { last_timestamp(&path) },
        path,
        scope: FileScope::ClaudeSubagent,
    })
}

/// A spawn recorded in a Codex rollout.
struct Spawn {
    call_id: String,
    thread: String,
    agent_path: String,
    started_ms: Option<i64>,
}

/// What one Codex rollout says about the children it started.
#[derive(Default)]
struct Activity {
    spawns: Vec<Spawn>,
    completed: HashMap<String, Option<i64>>,
    /// `spawn_agent` call id → its task text.
    tasks: HashMap<String, String>,
}

pub fn codex_tree(root_path: &Path, root_session: &str, sessions_dir: &Path) -> Tree {
    let mut children: Vec<Child> = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([root_session.to_string()]);
    let mut queue = VecDeque::from([(
        root_session.to_string(),
        root_path.to_path_buf(),
        0u32,
        0u64,
    )]);
    while let Some((thread, path, depth, from_ordinal)) = queue.pop_front() {
        if depth >= MAX_CODEX_DEPTH {
            continue;
        }
        let act = codex_activity(&path, from_ordinal);
        for s in act.spawns {
            // A rollout may name its own thread or an ancestor; each id is listed once, the root never.
            if !seen.insert(s.thread.clone()) {
                continue;
            }
            let file = session_log::locate_codex(&s.thread, sessions_dir);
            let meta = file
                .as_deref()
                .and_then(|f| codex_meta(f, &s.thread))
                .unwrap_or_default();
            let parent = meta
                .parent
                .filter(|p| *p == thread || seen.contains(p))
                .unwrap_or_else(|| thread.clone());
            let child_depth = meta.depth.unwrap_or(depth + 1);
            let agent_path = if s.agent_path.is_empty() {
                meta.agent_path.unwrap_or_default()
            } else {
                s.agent_path
            };
            let ended = act.completed.get(&s.thread);
            let from = meta.history_start.unwrap_or(0);
            if let Some(f) = &file {
                queue.push_back((s.thread.clone(), f.clone(), child_depth, from));
            }
            children.push(Child {
                id: s.thread,
                parent,
                depth: child_depth,
                agent_type: agent_path.rsplit('/').next().unwrap_or_default().into(),
                nickname: meta.nickname,
                description: act
                    .tasks
                    .get(&s.call_id)
                    .map(|t| cut(t))
                    .unwrap_or_default(),
                tool_use_id: Some(s.call_id),
                background: false,
                running: ended.is_none(),
                path: file.unwrap_or_default(),
                scope: FileScope::CodexChild { from_ordinal: from },
                started_ms: s.started_ms,
                ended_ms: ended.copied().flatten(),
            });
        }
    }
    sort_by_start(&mut children);
    Tree {
        agent: "codex".into(),
        root: root_session.into(),
        path: root_path.to_path_buf(),
        children,
    }
}

/// The spawns, completions and task texts in a rollout, from lines at or after `from_ordinal` (a child's file
/// first repeats its parent's history). Only lines that name a sub-agent are parsed.
fn codex_activity(path: &Path, from_ordinal: u64) -> Activity {
    let mut act = Activity::default();
    let Ok(f) = std::fs::File::open(path) else {
        return act;
    };
    let mut r = BufReader::new(f);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        if !line.contains("SubAgentActivity") && !line.contains("\"spawn_agent\"") {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if o["ordinal"].as_u64().is_some_and(|n| n < from_ordinal) {
            continue;
        }
        let p = &o["payload"];
        let item = &p["item"];
        if p["type"] == "item_completed" && item["type"] == "SubAgentActivity" {
            let Some(thread) = item["agent_thread_id"].as_str().filter(|t| !t.is_empty()) else {
                continue;
            };
            match item["kind"].as_str() {
                Some("started") => act.spawns.push(Spawn {
                    call_id: item["id"].as_str().unwrap_or_default().into(),
                    thread: thread.into(),
                    agent_path: item["agent_path"].as_str().unwrap_or_default().into(),
                    started_ms: p["started_at_ms"].as_i64(),
                }),
                Some("completed") => {
                    act.completed
                        .insert(thread.into(), p["completed_at_ms"].as_i64());
                }
                _ => {}
            }
        } else if p["name"] == "spawn_agent" {
            let Some(call) = p["call_id"].as_str() else {
                continue;
            };
            let args: Value = p["arguments"]
                .as_str()
                .and_then(|a| serde_json::from_str(a).ok())
                .unwrap_or_default();
            if let Some(task) = ["message", "task"]
                .iter()
                .find_map(|k| args[*k].as_str())
                .filter(|t| !encrypted(t))
            {
                act.tasks.insert(call.into(), task.into());
            }
        }
    }
    act
}

/// Codex 0.167 sends the task as a Fernet token, which shows nothing a person can read.
fn encrypted(text: &str) -> bool {
    text.starts_with("gAAAAA") && !text.contains(char::is_whitespace)
}

#[derive(Default)]
struct CodexMeta {
    parent: Option<String>,
    depth: Option<u32>,
    nickname: Option<String>,
    agent_path: Option<String>,
    /// `subagent_history_start_ordinal`; absent when the child was spawned with `fork_turns: "none"`.
    history_start: Option<u64>,
}

/// The child's own `session_meta`: the first lines hold it and then the parent's, which share its `session_id`.
fn codex_meta(path: &Path, id: &str) -> Option<CodexMeta> {
    let f = std::fs::File::open(path).ok()?;
    let mut r = BufReader::new(f);
    for _ in 0..3 {
        let o = read_line(&mut r)?;
        let p = &o["payload"];
        if o["type"] != "session_meta" || p["id"] != id {
            continue;
        }
        let spawn = &p["source"]["subagent"]["thread_spawn"];
        let text = |a: &Value, b: &Value| a.as_str().or(b.as_str()).map(String::from);
        return Some(CodexMeta {
            parent: text(&p["parent_thread_id"], &spawn["parent_thread_id"]),
            depth: spawn["depth"].as_u64().and_then(|d| u32::try_from(d).ok()),
            nickname: text(&p["agent_nickname"], &spawn["agent_nickname"]),
            agent_path: text(&p["agent_path"], &spawn["agent_path"]),
            history_start: p["subagent_history_start_ordinal"].as_u64(),
        });
    }
    None
}

/// The next line as JSON, or None at the end or past `MAX_META_LINE`.
fn read_line(r: &mut impl BufRead) -> Option<Value> {
    let mut buf = Vec::new();
    let n = r.take(MAX_META_LINE).read_until(b'\n', &mut buf).ok()?;
    if n == 0 || (n as u64 == MAX_META_LINE && buf.last() != Some(&b'\n')) {
        return None;
    }
    serde_json::from_slice(&buf).ok()
}

fn timestamp_ms(o: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(o["timestamp"].as_str()?)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn first_timestamp(path: &Path) -> Option<i64> {
    let mut r = BufReader::new(std::fs::File::open(path).ok()?);
    timestamp_ms(&read_line(&mut r)?)
}

fn last_timestamp(path: &Path) -> Option<i64> {
    let range = tail::read_max(path, None, 64 * 1024, MAX_META_LINE).ok()?;
    range
        .lines
        .iter()
        .rev()
        .find_map(|l| timestamp_ms(&serde_json::from_str(l).ok()?))
}

fn cut(text: &str) -> String {
    text.trim().chars().take(DESCRIPTION_CHARS).collect()
}

fn sort_by_start(children: &mut [Child]) {
    children.sort_by_key(|c| c.started_ms.unwrap_or(i64::MAX));
}

const USAGE: &str = "usage: bw tree (--terminal <t> | --log <path> --agent claude|codex)";

pub fn run(argv: &[String]) -> ExitCode {
    let a = match args::parse(argv, &[], &["terminal", "log", "agent"]) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let mut out = JsonLines::new();
    match (a.get("terminal"), a.get("log"), a.get("agent")) {
        (Some(t), None, None) => match locate::locate(t, feed::now().timestamp_millis()) {
            Ok(l) => out.emit_value(tree_of(&l).line()),
            Err(f) => out.emit_value(f.state_line()),
        },
        (None, Some(log), Some(agent @ ("claude" | "codex"))) => {
            let path = Path::new(log);
            if !path.is_file() {
                return super::error("not_found", &format!("no session log: {log}"));
            }
            out.emit_value(tree_of_log(path, agent).line());
        }
        _ => return crate::usage(USAGE),
    }
    print!("{}", out.text());
    ExitCode::SUCCESS
}

/// The tree of a log read by path, for `bw feed --log … --tree`.
pub fn tree_of_log(path: &Path, agent: &str) -> Tree {
    tree_at(path, agent, &feed::session_of(path, agent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_are_cut_and_tokens_hidden() {
        assert_eq!(cut(&"é".repeat(200)).chars().count(), 120);
        assert_eq!(cut("  Count files \n"), "Count files");
        assert!(encrypted("gAAAAABq7sD9Ka2IRoXpHLQo10_-YXSjQzTWxP6I"));
        assert!(!encrypted("gAAAAA is how a token starts"));
        assert!(!encrypted("Count the entries"));
    }

    #[test]
    fn sessions_dir_is_four_folders_up() {
        let p = Path::new("/h/.codex/sessions/2026/11/06/rollout-x.jsonl");
        assert_eq!(
            codex_sessions_dir(p),
            Some(PathBuf::from("/h/.codex/sessions"))
        );
    }
}
