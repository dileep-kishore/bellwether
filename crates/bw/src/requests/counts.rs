//! `bw counts`: running sub-agents and waiting requests per terminal, for the project sidebar.
//!
//! Reads no screen: one `hc get` per terminal, the remembered root (a process scan only once it is stale), the
//! session tree, the hook events and the logs. A blocked terminal waits on at least one request, however few
//! events say so; an async question waits whatever hc says.

use std::collections::HashSet;
use std::path::Path;
use std::process::ExitCode;

use herdr_core::hc::mapper::Term;
use herdr_core::{ConversationItem, Delivery, FileScope, ItemKind, PermState, QuestionState};
use serde_json::json;

use super::matchers;
use crate::chat::locate::{self, LocateFailure};
use crate::chat::protocol::JsonLines;
use crate::chat::tree;
use crate::chat::{args, feed, tail};
use crate::events::{self, Event};

const USAGE: &str = "usage: bw counts --terminals <t1,t2,…> (at most 64)";
const MAX_TERMINALS: usize = 64;
/// At most this many running sub-agents' logs are read per terminal, as `bw cards` reads.
const MAX_CHILD_LOGS: usize = 16;
/// A `PermissionRequest` takes its call id from the `PreToolUse` of the same call, at most this much earlier.
const PAIR_MS: i64 = 1000;
/// Event files older than this are not read; `bw event` prunes them at the same age.
const EVENTS_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Count {
    pub subagents: usize,
    pub requests: usize,
}

pub fn run(argv: &[String]) -> ExitCode {
    let a = match args::parse(argv, &[], &["terminals"]) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let Some(list) = a.get("terminals") else {
        return crate::usage(USAGE);
    };
    let terminals: Vec<&str> = list.split(',').collect();
    if terminals.len() > MAX_TERMINALS || terminals.iter().any(|t| t.is_empty()) {
        return crate::usage(USAGE);
    }
    let now_ms = feed::now().timestamp_millis();
    let mut out = JsonLines::new();
    for t in terminals {
        let c = count(t, now_ms);
        let line = json!({"type": "count", "terminal": t, "subagents": c.subagents, "requests": c.requests});
        out.emit_value(line);
    }
    print!("{}", out.text());
    ExitCode::SUCCESS
}

/// Terminal `t`'s counts; zero for a terminal that is gone, runs no agent, or is on another machine.
pub fn count(terminal: &str, now_ms: i64) -> Count {
    let (record, found) = locate::locate_with_record(terminal, now_ms, false);
    let blocked = record
        .as_ref()
        .and_then(Term::parse)
        .is_some_and(|t| t.status.as_deref() == Some("blocked"));
    let l = match found {
        Ok(l) => l,
        Err(
            LocateFailure::NoLog { .. }
            | LocateFailure::NoProcess { .. }
            | LocateFailure::Ambiguous { .. },
        ) => {
            return Count {
                subagents: 0,
                requests: usize::from(blocked),
            }
        }
        Err(_) => return Count::default(),
    };
    let tree = tree::tree_of(&l);
    let running: Vec<&tree::Child> = tree.children.iter().filter(|c| c.running).collect();
    let mut logs: Vec<(Option<String>, Vec<ConversationItem>)> =
        vec![(None, items_of(&l.path, FileScope::Root))];
    for c in running.iter().take(MAX_CHILD_LOGS) {
        if c.path.is_file() {
            logs.push((Some(c.id.clone()), items_of(&c.path, c.scope)));
        }
    }
    let asks = if blocked {
        let events = events::read(terminal, now_ms - EVENTS_MS);
        open_asks(&events, &l.agent, &l.session, &logs).max(1)
    } else {
        0
    };
    Count {
        subagents: running.len(),
        requests: asks + async_questions(&logs),
    }
}

fn items_of(path: &Path, scope: FileScope) -> Vec<ConversationItem> {
    tail::read(path, None, tail::BYTES)
        .map(|r| tail::items(&r.lines, scope))
        .unwrap_or_default()
}

/// The calls this session's `PermissionRequest` events ask about that a log read still shows open, each once.
/// A Claude event whose call is not in a log read (finished, or past the tail) counts for nothing; a Codex one
/// counts its agent's open call with the same command.
pub(crate) fn open_asks(
    events: &[Event],
    agent: &str,
    session: &str,
    logs: &[(Option<String>, Vec<ConversationItem>)],
) -> usize {
    let mine: Vec<&Event> = events
        .iter()
        .filter(|e| e.agent == agent && e.session.as_deref() == Some(session))
        // Claude's own helper agents send events with an empty type; they never ask for the user's sub-agents.
        .filter(|e| e.agent_type.as_deref() != Some(""))
        .collect();
    let mut open: HashSet<String> = HashSet::new();
    for pr in mine.iter().filter(|e| e.event == "PermissionRequest") {
        let call = pr.tool_use_id.clone().or_else(|| {
            mine.iter()
                .filter(|e| {
                    e.event == "PreToolUse"
                        && e.agent_id == pr.agent_id
                        && e.tool == pr.tool
                        && e.command == pr.command
                        && e.at_ms <= pr.at_ms
                        && pr.at_ms - e.at_ms <= PAIR_MS
                })
                .max_by_key(|e| (e.at_ms, e.id.clone()))
                .and_then(|e| e.tool_use_id.clone())
        });
        let found = match call {
            Some(id) if logs.iter().any(|(_, items)| is_open(items, &id)) => Some(id),
            // Codex's hooks name the call `exec-<uuid>`, its rollout `call_…`: matched by agent and command.
            Some(_) if agent == "codex" => asked_in_log(pr, logs),
            Some(_) => None,
            None => asked_in_log(pr, logs),
        };
        if let Some(id) = found {
            open.insert(id);
        }
    }
    open.len()
}

/// Whether call `id` waits in `items`: the newest open call, or an earlier one with no result yet.
fn is_open(items: &[ConversationItem], id: &str) -> bool {
    items.iter().any(|it| match &it.kind {
        ItemKind::PermissionRequest(p) => p.state == PermState::Pending && p.tool_use_id == id,
        ItemKind::ToolChips(chips) => chips
            .iter()
            .flat_map(|c| c.calls.iter())
            .any(|c| c.id == id && c.output.is_none()),
        _ => false,
    })
}

/// For an event that names no call: the open call in its agent's own log with the same tool and command.
fn asked_in_log(pr: &Event, logs: &[(Option<String>, Vec<ConversationItem>)]) -> Option<String> {
    let (_, items) = logs
        .iter()
        .find(|(c, _)| c.as_deref() == pr.agent_id.as_deref())?;
    items.iter().rev().find_map(|it| match &it.kind {
        ItemKind::PermissionRequest(p)
            if p.state == PermState::Pending
                && pr.tool.as_deref().is_some_and(|t| {
                    t == p.tool_name
                        || (pr.agent == "codex"
                            && matchers::codex_command_tool(t)
                            && matchers::codex_command_tool(&p.tool_name))
                })
                && words(&p.command) == words(pr.command.as_deref().unwrap_or("")) =>
        {
            Some(p.tool_use_id.clone())
        }
        _ => None,
    })
}

fn words(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Codex `request_user_input_async` questions with no answer yet, in any log read, each once.
fn async_questions(logs: &[(Option<String>, Vec<ConversationItem>)]) -> usize {
    logs.iter()
        .flat_map(|(_, items)| items.iter())
        .filter_map(|it| match &it.kind {
            ItemKind::Question(q)
                if q.delivery == Delivery::Message && q.state == QuestionState::Pending =>
            {
                Some(q.tool_use_id.as_str())
            }
            _ => None,
        })
        .collect::<HashSet<_>>()
        .len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ROOT: &str = "01a1b589-9d51-7273-946e-30423f02bb68";
    const CHILD: &str = "01a1b58a-29ac-7de0-b175-10c76abdafbb";

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sessions/codex-child-approval")
            .join(name)
    }

    fn event(name: &str, at_ms: i64) -> Event {
        let text = std::fs::read_to_string(fixture(&format!("hooks/{name}.json"))).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&text).unwrap();
        events::from_payload("codex", "t1", "core", &payload, at_ms).unwrap()
    }

    /// The rollout `name`'s items up to and including the line naming `call`.
    fn cut(name: &str, call: &str, scope: FileScope) -> Vec<ConversationItem> {
        let text = std::fs::read_to_string(fixture(name)).unwrap();
        let needle = format!(r#""call_id":"{call}""#);
        let end = text.lines().position(|l| l.contains(&needle)).unwrap();
        let lines: Vec<String> = text.lines().take(end + 1).map(String::from).collect();
        tail::items(&lines, scope)
    }

    /// Two approvals open at once, the root's `touch d-y.txt` and the child's `touch child.txt`: Codex's hooks
    /// name each call `exec-<uuid>`, which no rollout `call_…` id equals.
    #[test]
    fn codex_exec_ids_count_each_open_call() {
        let logs = vec![
            (
                None,
                cut(
                    &format!("rollout-2026-11-07T02-24-17-{ROOT}.jsonl"),
                    "call_531dd63fb7d24c459c54727c21db2eea",
                    FileScope::Root,
                ),
            ),
            (
                Some(CHILD.to_string()),
                cut(
                    &format!("rollout-2026-11-07T02-24-53-{CHILD}.jsonl"),
                    "call_7a91eda49cd4472cbdb8d39940be5c54",
                    FileScope::CodexChild { from_ordinal: 0 },
                ),
            ),
        ];
        let events = vec![
            event("d-y-PreToolUse", 1000),
            event("d-y-PermissionRequest", 1030),
            event("e-PreToolUse-4", 2000),
            event("e-PermissionRequest", 2030),
        ];
        assert!(events[0]
            .tool_use_id
            .as_deref()
            .is_some_and(|i| i.starts_with("exec-")));
        assert_eq!(open_asks(&events, "codex", ROOT, &logs), 2);
        // The child's call has its result in its whole log: only the root's still waits.
        let text = std::fs::read_to_string(fixture(&format!(
            "rollout-2026-11-07T02-24-53-{CHILD}.jsonl"
        )))
        .unwrap();
        let lines: Vec<String> = text.lines().map(String::from).collect();
        let done = vec![
            logs[0].clone(),
            (
                Some(CHILD.to_string()),
                tail::items(&lines, FileScope::CodexChild { from_ordinal: 0 }),
            ),
        ];
        assert_eq!(open_asks(&events, "codex", ROOT, &done), 1);
    }
}
