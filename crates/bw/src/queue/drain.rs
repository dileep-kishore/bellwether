//! `bw queue drain`: settle polling and the 5 safety gates before `chat::send`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use herdr_core::conversation::{ConversationParser, FileScope};
use herdr_core::hc::mapper::Term;
use herdr_core::{ItemKind, QuestionState};
use serde::Serialize;
use serde_json::{json, Value};

use super::store::{self, QueueItem, QueueState, StoreError};
use crate::chat::locate::{self, LocateFailure};
use crate::chat::send::{self, Expect, SendOutcome};
use crate::chat::{cache, tail};
use crate::events;
use crate::hc;
use crate::requests::{cards, counts, store as req_store};

pub const DEFAULT_SETTLE_MAX_MS: u64 = 65_000;
pub const DEFAULT_SETTLE_POLL_MS: u64 = 250;
pub const DEFAULT_COOLDOWN_MS: i64 = 1_500;
const STARTUP_SCAN_CAP: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct DrainReport {
    #[serde(rename = "type")]
    pub kind_tag: &'static str,
    pub terminal: String,
    /// `"sent"`, `"noop"`, `"pending"`, `"busy"`, `"held"`.
    pub result: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub held: bool,
    pub hold_reason: Option<String>,
    pub remaining: usize,
}

impl DrainReport {
    fn from_state(
        terminal: &str,
        result: &'static str,
        reason: Option<String>,
        item_id: Option<String>,
        state: &QueueState,
    ) -> Self {
        Self {
            kind_tag: "drain",
            terminal: terminal.to_string(),
            result,
            reason,
            item_id,
            held: state.held,
            hold_reason: state.hold_reason.clone(),
            remaining: state.items.len(),
        }
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
}

fn wait_until_settled(core: &str, terminal: &str) {
    let max_ms = env_u64("BW_QUEUE_SETTLE_MAX_MS", DEFAULT_SETTLE_MAX_MS);
    let poll_ms = env_u64("BW_QUEUE_SETTLE_POLL_MS", DEFAULT_SETTLE_POLL_MS).max(20);
    let deadline = Instant::now() + Duration::from_millis(max_ms);
    loop {
        if !store::has_runnable(core, terminal) {
            return;
        }
        match hc::hc_get(terminal) {
            Ok(v) => match Term::parse(&v) {
                Some(t) if t.state == "live" && t.status.as_deref() == Some("working") => {}
                _ => return,
            },
            Err(_) => return,
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }
}

enum ResolvedTarget {
    Log {
        session: String,
        path: PathBuf,
        startup_resolved: bool,
    },
    NoLog {
        session: String,
    },
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct TurnOutcome {
    pub interrupted_or_error: bool,
    pub assistant_question: bool,
    pub user_turns: usize,
    pub has_reset_command: bool,
}

fn strip_inline_code(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1
            }
            let run_len = i - run_start;
            let mut search = i;
            let mut closed = None;
            while search < bytes.len() {
                if bytes[search] == b'`' {
                    let close_start = search;
                    while search < bytes.len() && bytes[search] == b'`' {
                        search += 1;
                    }
                    if search - close_start == run_len {
                        closed = Some(search);
                        break;
                    }
                } else {
                    search += 1;
                }
            }
            if let Some(after_close) = closed {
                out.push_str("code");
                i = after_close;
                continue;
            }
            out.push_str(&line[run_start..i]);
            continue;
        }
        let ch = line[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_atx_heading(trimmed: &str) -> bool {
    let hashes = trimmed.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes)
        && trimmed
            .as_bytes()
            .get(hashes)
            .is_none_or(|b| *b == b' ' || *b == b'\t')
}

/// True when any non-empty non-heading prose line outside fenced code blocks, blockquotes, and inline
/// code spans ends with `?` (catching questions followed by option lists or status summaries).
pub fn ends_with_prose_question(text: &str) -> bool {
    let mut fence: Option<(char, usize)> = None;

    for raw in text.lines() {
        let indent = raw.bytes().take_while(|b| *b == b' ').count();
        let trimmed_start = &raw[indent.min(raw.len())..];

        if let Some((fch, flen)) = fence {
            if indent <= 3 {
                let run = trimmed_start.chars().take_while(|c| *c == fch).count();
                if run >= flen && trimmed_start[run * fch.len_utf8()..].trim().is_empty() {
                    fence = None;
                }
            }
            continue;
        }

        if indent <= 3 {
            for fch in ['`', '~'] {
                let run = trimmed_start.chars().take_while(|c| *c == fch).count();
                if run >= 3 {
                    let info = &trimmed_start[run * fch.len_utf8()..];
                    // CommonMark: backtick fence info strings cannot contain backticks (inline ```x``` is not a fence).
                    if fch == '~' || !info.contains('`') {
                        fence = Some((fch, run));
                        break;
                    }
                }
            }
            if fence.is_some() {
                continue;
            }
        }

        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('>') || is_atx_heading(trimmed) {
            continue;
        }
        let cleaned = strip_inline_code(trimmed);
        let core = cleaned
            .trim_end_matches(['*', '_', ')', ']', '"', '\''])
            .trim_end();
        if core.ends_with('?') || core.ends_with('？') {
            return true;
        }
    }

    false
}

fn is_codex_harness_user_line(v: &Value) -> bool {
    let Some(kinds) = v
        .pointer("/payload/internal_chat_message_metadata_passthrough/content_item_kinds")
        .and_then(Value::as_array)
    else {
        return false;
    };
    !kinds.is_empty()
        && kinds.iter().all(|k| {
            matches!(
                k.as_str(),
                Some("agents_md.instructions" | "environments.environment_context")
            )
        })
}

fn is_synthetic_claude_assistant(v: &Value) -> bool {
    v.pointer("/message/model").and_then(Value::as_str) == Some("<synthetic>")
}

fn line_has_reset_command(line: &str, v: &Value) -> bool {
    if line.contains("<command-name>/clear</command-name>")
        || line.contains("<command-name>/new</command-name>")
    {
        return true;
    }
    if v["type"].as_str() == Some("user") {
        if let Some(s) = v.pointer("/message/content").and_then(Value::as_str) {
            let t = s.trim();
            if t == "/clear" || t == "/new" {
                return true;
            }
        }
    }
    false
}

fn line_is_interruption(v: &Value) -> bool {
    if v["isSidechain"].as_bool() == Some(true) {
        return false;
    }
    if v["type"].as_str() == Some("event_msg")
        && v.pointer("/payload/type").and_then(Value::as_str) == Some("turn_aborted")
    {
        return true;
    }
    if v.pointer("/payload/internal_chat_message_metadata_passthrough/content_item_kinds")
        .and_then(Value::as_array)
        .is_some_and(|ks| {
            ks.iter()
                .any(|k| k.as_str() == Some("generic.turn_aborted"))
        })
    {
        return true;
    }
    if v["toolDenialKind"].as_str() == Some("user-rejected") {
        return true;
    }
    if v.pointer("/toolUseResult/interrupted")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    if v["type"].as_str() == Some("user") {
        if let Some(s) = v.pointer("/message/content").and_then(Value::as_str) {
            if s.trim_start().starts_with("[Request interrupted") {
                return true;
            }
        }
        if let Some(arr) = v.pointer("/message/content").and_then(Value::as_array) {
            if arr.iter().any(|b| {
                b["type"].as_str() == Some("text")
                    && b["text"]
                        .as_str()
                        .is_some_and(|t| t.trim_start().starts_with("[Request interrupted"))
            }) {
                return true;
            }
        }
    }
    false
}

fn line_is_error(v: &Value) -> bool {
    if v["isSidechain"].as_bool() == Some(true) {
        return false;
    }
    if v["isApiErrorMessage"].as_bool() == Some(true) {
        return true;
    }
    if v["type"].as_str() == Some("error") {
        return true;
    }
    if v["type"].as_str() == Some("system") && v["subtype"].as_str() == Some("api_error") {
        return true;
    }
    if v["type"].as_str() == Some("event_msg")
        && v.pointer("/payload/type").and_then(Value::as_str) == Some("error")
    {
        return true;
    }
    false
}

enum AssistantTurnStep {
    Text(String),
    ToolOnly,
}

fn extract_assistant_step(v: &Value) -> Option<AssistantTurnStep> {
    if v["isSidechain"].as_bool() == Some(true)
        || v["isApiErrorMessage"].as_bool() == Some(true)
        || is_synthetic_claude_assistant(v)
    {
        return None;
    }
    if v["type"].as_str() == Some("assistant") {
        if let Some(s) = v.pointer("/message/content").and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(AssistantTurnStep::Text(trimmed.to_string()));
            }
        }
        if let Some(arr) = v.pointer("/message/content").and_then(Value::as_array) {
            let texts: Vec<&str> = arr
                .iter()
                .filter(|b| b["type"].as_str() == Some("text"))
                .filter_map(|b| b["text"].as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .collect();
            if !texts.is_empty() {
                return Some(AssistantTurnStep::Text(texts.join("\n\n")));
            }
            if arr.iter().any(|b| b["type"].as_str() == Some("tool_use")) {
                return Some(AssistantTurnStep::ToolOnly);
            }
        }
    }
    if v["type"].as_str() == Some("response_item") {
        let ptype = v.pointer("/payload/type").and_then(Value::as_str);
        if ptype == Some("message")
            && v.pointer("/payload/role").and_then(Value::as_str) == Some("assistant")
        {
            if let Some(arr) = v.pointer("/payload/content").and_then(Value::as_array) {
                let texts: Vec<&str> = arr
                    .iter()
                    .filter_map(|c| c["text"].as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .collect();
                if !texts.is_empty() {
                    return Some(AssistantTurnStep::Text(texts.join("\n\n")));
                }
            }
        } else if matches!(
            ptype,
            Some("custom_tool_call" | "function_call" | "local_shell_call")
        ) {
            return Some(AssistantTurnStep::ToolOnly);
        }
    }
    None
}

pub fn analyze_root_lines(lines: &[String]) -> TurnOutcome {
    let mut parser = ConversationParser::with_scope(FileScope::Root);
    let mut prev_user_count = 0usize;
    let mut user_turns = 0usize;
    let mut has_reset_command = false;
    let mut interrupted = false;
    let mut errored = false;
    let mut last_assistant_text: Option<String> = None;

    for line in lines {
        let parsed_val = serde_json::from_str::<Value>(line).ok();
        let skip_harness_user = parsed_val.as_ref().is_some_and(is_codex_harness_user_line);
        if !skip_harness_user {
            parser.feed(line);
        }
        let cur_user_count = parser
            .items()
            .iter()
            .filter(|it| matches!(it.kind, ItemKind::UserText(_)))
            .count();
        if cur_user_count > prev_user_count {
            user_turns += cur_user_count - prev_user_count;
            prev_user_count = cur_user_count;
            interrupted = false;
            errored = false;
            last_assistant_text = None;
        }

        let Some(v) = parsed_val.as_ref() else {
            continue;
        };
        if line_has_reset_command(line, v) {
            has_reset_command = true;
        }
        if line_is_interruption(v) {
            interrupted = true;
        }
        if line_is_error(v) {
            errored = true;
        } else if let Some(step) = extract_assistant_step(v) {
            errored = false;
            match step {
                AssistantTurnStep::Text(t) => last_assistant_text = Some(t),
                AssistantTurnStep::ToolOnly => last_assistant_text = None,
            }
        }
    }

    TurnOutcome {
        interrupted_or_error: interrupted || errored,
        assistant_question: !interrupted
            && !errored
            && last_assistant_text
                .as_deref()
                .is_some_and(ends_with_prose_question),
        user_turns,
        has_reset_command,
    }
}

fn inspect_latest_turn(path: &Path) -> Result<TurnOutcome, ()> {
    let read = tail::read(path, None, tail::BYTES).map_err(|_| ())?;
    Ok(analyze_root_lines(&read.lines))
}

fn unverified_startup_valid(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if meta.len() > STARTUP_SCAN_CAP {
        return false;
    }
    let Ok(read) = tail::read(path, Some(0), STARTUP_SCAN_CAP) else {
        return false;
    };
    let outcome = analyze_root_lines(&read.lines);
    outcome.user_turns <= 1 && !outcome.has_reset_command
}

fn terminal_had_other_session(
    core: &str,
    terminal: &str,
    item: &QueueItem,
    prev_root: Option<&cache::Root>,
    current_sid: Option<&str>,
) -> bool {
    if let Some(r) = prev_root {
        if r.checked_ms >= item.at_ms
            && !r.session.is_empty()
            && Some(r.session.as_str()) != current_sid
        {
            return true;
        }
    }
    events::read(terminal, item.at_ms).into_iter().any(|e| {
        e.core == core
            && e.agent == item.expect_kind
            && e.agent_id.is_none()
            && e.session
                .as_deref()
                .is_some_and(|s| !s.is_empty() && Some(s) != current_sid)
    })
}

fn hold_and_save(
    core: &str,
    terminal: &str,
    state: &mut QueueState,
    reason: &str,
) -> Result<DrainReport, StoreError> {
    state.held = true;
    state.hold_reason = Some(reason.to_string());
    state.inflight_item_id = None;
    store::write_in(core, terminal, state)?;
    Ok(DrainReport::from_state(
        terminal,
        "held",
        Some(reason.to_string()),
        state.items.first().map(|i| i.id.clone()),
        state,
    ))
}

pub fn drain_terminal(
    terminal: &str,
    on_stop: Option<&str>,
    force_next: bool,
    from_resume: bool,
) -> Result<DrainReport, StoreError> {
    store::validate_terminal(terminal)?;
    let core = cache::core_name();

    if on_stop.is_some() {
        wait_until_settled(&core, terminal);
    }

    let _lock = store::lock_terminal(&core, terminal)?;
    let mut state = store::read_in(&core, terminal);
    let now_ms = store::now_ms();

    // Gate 1: !held, non-empty, no orphaned inflight send, not duplicate stop, not inside post-send cooldown.
    if state.items.is_empty() {
        return Ok(DrainReport::from_state(
            terminal,
            "noop",
            Some("empty".into()),
            None,
            &state,
        ));
    }
    if state.held {
        return Ok(DrainReport::from_state(
            terminal,
            "held",
            state.hold_reason.clone(),
            state.items.first().map(|i| i.id.clone()),
            &state,
        ));
    }
    if state.inflight_item_id.is_some() {
        return hold_and_save(&core, terminal, &mut state, "uncertain_delivery");
    }
    if let Some(eid) = on_stop {
        if state.last_drain_event.as_deref() == Some(eid) {
            return Ok(DrainReport::from_state(
                terminal,
                "noop",
                Some("duplicate_stop".into()),
                None,
                &state,
            ));
        }
        if !force_next && !from_resume {
            let stop_ms = eid.split('-').next().and_then(|s| s.parse::<i64>().ok());
            if let (Some(s_ms), Some(sent_ms)) = (stop_ms, state.last_sent_ms) {
                if s_ms <= sent_ms {
                    return Ok(DrainReport::from_state(
                        terminal,
                        "noop",
                        Some("stop_before_last_send".into()),
                        None,
                        &state,
                    ));
                }
            }
        }
    } else if !force_next && !from_resume {
        let cooldown_ms = env_i64("BW_QUEUE_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
        if state
            .last_sent_ms
            .is_some_and(|sent_ms| now_ms >= sent_ms && now_ms - sent_ms < cooldown_ms)
        {
            return Ok(DrainReport::from_state(
                terminal,
                "noop",
                Some("cooldown".into()),
                None,
                &state,
            ));
        }
    }

    let prev_root = cache::read(&cache::terminal_file(terminal)).root;
    let (record, found) = locate::locate_with_record(terminal, now_ms, true);

    // Gate 2: hc get reports live terminal with status "done" or "idle".
    let Some(rec) = record.as_ref() else {
        return match found {
            Err(LocateFailure::NoTerminal(_)) => {
                hold_and_save(&core, terminal, &mut state, "no_terminal")
            }
            _ => Ok(DrainReport::from_state(
                terminal,
                "noop",
                Some("unreachable".into()),
                None,
                &state,
            )),
        };
    };
    let Some(term) = Term::parse(rec) else {
        return Ok(DrainReport::from_state(
            terminal,
            "noop",
            Some("bad_record".into()),
            None,
            &state,
        ));
    };
    if term.state != "live" {
        return hold_and_save(&core, terminal, &mut state, "no_terminal");
    }
    match term.status.as_deref() {
        Some("done" | "idle") => {}
        Some("working") => {
            return Ok(DrainReport::from_state(
                terminal,
                "busy",
                Some("working".into()),
                None,
                &state,
            ))
        }
        Some("blocked") => {
            return Ok(DrainReport::from_state(
                terminal,
                "pending",
                Some("blocked".into()),
                None,
                &state,
            ))
        }
        other => {
            return Ok(DrainReport::from_state(
                terminal,
                "busy",
                Some(other.unwrap_or("unknown").into()),
                None,
                &state,
            ))
        }
    }

    // Gate 3: zero pending requests across root and all running sub-agents (failing closed if > 256).
    if let Ok(input) = cards::gather_for_gate(terminal, Some(rec), &found, None, now_ms) {
        if input.status.as_deref() == Some("blocked") || input.omitted_running_children {
            let reason = if input.status.as_deref() == Some("blocked") {
                "blocked"
            } else {
                "pending_request"
            };
            return Ok(DrainReport::from_state(
                terminal,
                "pending",
                Some(reason.into()),
                None,
                &state,
            ));
        }
        let (_, requests) =
            req_store::update(terminal, now_ms, |kept| cards::build(&input, kept, now_ms))
                .unwrap_or_else(|_| cards::build(&input, &mut req_store::load(terminal), now_ms));

        let any_pending_card = requests
            .iter()
            .any(|r| r["state"].as_str() == Some("pending"));
        let any_open_ask =
            counts::open_asks(&input.events, &input.agent, &input.root, &input.logs) > 0;
        let any_open_question = input.logs.iter().flat_map(|(_, items)| items.iter()).any(
            |it| matches!(&it.kind, ItemKind::Question(q) if q.state == QuestionState::Pending),
        );

        if any_pending_card || any_open_ask || any_open_question {
            return Ok(DrainReport::from_state(
                terminal,
                "pending",
                Some("pending_request".into()),
                None,
                &state,
            ));
        }
    }

    // Gate 5: session identity (checked before Gate 4 so session changes are never mislabeled).
    let item = state.items[0].clone();
    let target = match &item.expect_session {
        Some(want_sid) => match &found {
            Ok(located) if located.agent == item.expect_kind && &located.session == want_sid => {
                ResolvedTarget::Log {
                    session: located.session.clone(),
                    path: located.path.clone(),
                    startup_resolved: false,
                }
            }
            Err(LocateFailure::NoLog {
                agent,
                session: Some(live_sid),
            }) if agent == &item.expect_kind && live_sid == want_sid => ResolvedTarget::NoLog {
                session: live_sid.clone(),
            },
            _ => return hold_and_save(&core, terminal, &mut state, "session_changed"),
        },
        None => {
            if !item.unverified_startup {
                return hold_and_save(&core, terminal, &mut state, "session_changed");
            }
            let Some(expected_pid) = item.agent_pid else {
                return hold_and_save(&core, terminal, &mut state, "session_changed");
            };
            match &found {
                Ok(located)
                    if located.agent == item.expect_kind
                        && located.pid == Some(expected_pid)
                        && !terminal_had_other_session(
                            &core,
                            terminal,
                            &item,
                            prev_root.as_ref(),
                            Some(&located.session),
                        )
                        && unverified_startup_valid(&located.path) =>
                {
                    ResolvedTarget::Log {
                        session: located.session.clone(),
                        path: located.path.clone(),
                        startup_resolved: true,
                    }
                }
                Err(LocateFailure::NoLog { agent, session }) if agent == &item.expect_kind => {
                    let live_pid = locate::live_agent_pid_of(rec)
                        .and_then(|(k, pid)| (k == item.expect_kind).then_some(pid));
                    if live_pid != Some(expected_pid)
                        || terminal_had_other_session(
                            &core,
                            terminal,
                            &item,
                            prev_root.as_ref(),
                            session.as_deref(),
                        )
                    {
                        return hold_and_save(&core, terminal, &mut state, "session_changed");
                    }
                    return Ok(DrainReport::from_state(
                        terminal,
                        "pending",
                        Some("awaiting_session_log".into()),
                        None,
                        &state,
                    ));
                }
                Err(LocateFailure::Ambiguous { agent, .. }) if agent == &item.expect_kind => {
                    if locate::fresh_startup_pid_of(rec, &item.expect_kind) == Some(expected_pid)
                        && !terminal_had_other_session(
                            &core,
                            terminal,
                            &item,
                            prev_root.as_ref(),
                            None,
                        )
                    {
                        return Ok(DrainReport::from_state(
                            terminal,
                            "pending",
                            Some("awaiting_session_log".into()),
                            None,
                            &state,
                        ));
                    }
                    return hold_and_save(&core, terminal, &mut state, "session_changed");
                }
                _ => return hold_and_save(&core, terminal, &mut state, "session_changed"),
            }
        }
    };

    // Gate 4: latest root session turn did not end in interruption, error, or prose `?`.
    if let ResolvedTarget::Log { ref path, .. } = target {
        let path_str = path.to_string_lossy().to_string();
        let cur_len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let skip_gate4 = force_next
            || state
                .resumed_turn
                .as_ref()
                .is_some_and(|r| r.path == path_str && r.len == cur_len);
        if !skip_gate4 {
            match inspect_latest_turn(path) {
                Ok(outcome) if outcome.interrupted_or_error => {
                    return hold_and_save(&core, terminal, &mut state, "interrupted_or_error");
                }
                Ok(outcome) if outcome.assistant_question => {
                    return hold_and_save(&core, terminal, &mut state, "assistant_question");
                }
                Ok(_) => {}
                Err(()) => {
                    return hold_and_save(&core, terminal, &mut state, "interrupted_or_error");
                }
            }
        }
    }

    // Reserve item 0 on disk before typing into hc so a crash or post-send write failure
    // holds as `uncertain_delivery` instead of delivering the same prompt twice.
    state.inflight_item_id = Some(item.id.clone());
    store::write_in(&core, terminal, &state)?;

    // Deliver item 0 via chat::send (never --force).
    let outcome = match &target {
        ResolvedTarget::Log { session, path, .. } => {
            let path_str = path.to_string_lossy().to_string();
            send::send_checked(
                terminal,
                &item.expect_kind,
                Expect::Log(session, &path_str),
                &item.text,
            )
        }
        ResolvedTarget::NoLog { session } => send::send_checked(
            terminal,
            &item.expect_kind,
            Expect::NoLog(session),
            &item.text,
        ),
    };

    match outcome {
        SendOutcome::Sent(_) => {
            state.inflight_item_id = None;
            let popped = state.items.remove(0);
            state.last_sent_ms = Some(store::now_ms());
            state.resumed_turn = None;
            if let Some(eid) = on_stop {
                state.last_drain_event = Some(eid.to_string());
            }
            if let ResolvedTarget::Log {
                ref session,
                startup_resolved: true,
                ..
            } = target
            {
                for rem in &mut state.items {
                    if rem.unverified_startup && rem.agent_pid == popped.agent_pid {
                        rem.expect_session = Some(session.clone());
                        rem.unverified_startup = false;
                    }
                }
            }
            store::write_in(&core, terminal, &state)?;
            Ok(DrainReport::from_state(
                terminal,
                "sent",
                None,
                Some(popped.id),
                &state,
            ))
        }
        SendOutcome::RefusedConversation(_) => {
            hold_and_save(&core, terminal, &mut state, "session_changed")
        }
        SendOutcome::RefusedPrompt(_) => {
            hold_and_save(&core, terminal, &mut state, "refused_prompt")
        }
        SendOutcome::Unconfirmed(_) => hold_and_save(&core, terminal, &mut state, "unconfirmed"),
        SendOutcome::Error { code, .. } => hold_and_save(&core, terminal, &mut state, code),
    }
}

pub fn report_json(r: &DrainReport) -> Value {
    serde_json::to_value(r).unwrap_or_else(|_| json!({"type": "drain", "result": r.result}))
}

pub struct QueueSendReport {
    pub result: &'static str,
    pub message: String,
    pub state: QueueState,
}

pub struct QueueSendFailure {
    pub code: &'static str,
    pub message: String,
}

/// Atomically sends queued item `id` and pops it under `FolderLock` using `inflight_item_id`.
pub fn send_queued_item(
    core: &str,
    terminal: &str,
    id: &str,
    expect_kind: &str,
    expect_session: &str,
    expect_path: &str,
) -> Result<Result<QueueSendReport, QueueSendFailure>, StoreError> {
    store::validate_terminal(terminal)?;
    if expect_kind != "claude" && expect_kind != "codex" {
        return Err(StoreError::usage("expected --expect-kind claude|codex"));
    }
    let id = id.trim();
    if id.is_empty() {
        return Err(StoreError::usage("missing --id"));
    }
    let expected = send::expect(expect_session, expect_path).map_err(StoreError::usage)?;

    let _guard = store::lock_terminal(core, terminal)?;
    let mut state = store::read_in(core, terminal);

    if state.inflight_item_id.is_some() {
        state.held = true;
        state.hold_reason = Some("uncertain_delivery".into());
        store::write_in(core, terminal, &state)?;
        return Ok(Ok(QueueSendReport {
            result: "uncertain-delivery",
            message: "Queue paused because an earlier send was not confirmed.".into(),
            state,
        }));
    }

    let Some(idx) = state.items.iter().position(|it| it.id == id) else {
        return Ok(Ok(QueueSendReport {
            result: "already-sent",
            message: "Queued message was already delivered.".into(),
            state,
        }));
    };

    let text = state.items[idx].text.clone();
    state.inflight_item_id = Some(id.to_string());
    store::write_in(core, terminal, &state)?;

    let outcome = send::send_checked(terminal, expect_kind, expected, &text);
    match outcome {
        SendOutcome::Sent(message) => {
            state.inflight_item_id = None;
            state.items.retain(|it| it.id != id);
            state.last_sent_ms = Some(store::now_ms());
            store::write_in(core, terminal, &state)?;
            Ok(Ok(QueueSendReport {
                result: "sent",
                message,
                state,
            }))
        }
        SendOutcome::Unconfirmed(message) => {
            state.inflight_item_id = None;
            state.items.retain(|it| it.id != id);
            state.last_sent_ms = Some(store::now_ms());
            if !state.items.is_empty() {
                state.held = true;
                state.hold_reason = Some("unconfirmed".into());
            }
            store::write_in(core, terminal, &state)?;
            Ok(Ok(QueueSendReport {
                result: "unconfirmed",
                message,
                state,
            }))
        }
        SendOutcome::RefusedConversation(message) => {
            state.inflight_item_id = None;
            store::write_in(core, terminal, &state)?;
            Ok(Ok(QueueSendReport {
                result: "refused-conversation",
                message,
                state,
            }))
        }
        SendOutcome::RefusedPrompt(message) => {
            state.inflight_item_id = None;
            store::write_in(core, terminal, &state)?;
            Ok(Ok(QueueSendReport {
                result: "refused-prompt",
                message,
                state,
            }))
        }
        SendOutcome::Error { code, message } => {
            state.inflight_item_id = None;
            store::write_in(core, terminal, &state)?;
            Ok(Err(QueueSendFailure { code, message }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_question_catches_multiline_questions_and_ignores_code_and_quotes() {
        assert!(ends_with_prose_question("Which option do you prefer?"));
        assert!(ends_with_prose_question(
            "Updated parser.\n\n**Should I run tests now?**"
        ));
        assert!(ends_with_prose_question("Should I delete `old.rs`?"));
        assert!(ends_with_prose_question(
            "Which migration path should I take?\n\n1. Keep backwards compatibility (recommended)\n2. Break the API"
        ));
        assert!(ends_with_prose_question(
            "Should I proceed with the rename?\n\nI finished the parser and the tests pass."
        ));
        assert!(!ends_with_prose_question(
            "Done.\n```rust\nfn ok() -> Result<(), E> { work()? }\n```"
        ));
        assert!(!ends_with_prose_question(
            "~~~ts\nconst x = a ? b : c;\n~~~\nAll checks passed."
        ));
        assert!(!ends_with_prose_question("Escaped literal `?`"));
        assert!(!ends_with_prose_question(
            "Checked `is_ready?` flag and updated tests."
        ));
        assert!(!ends_with_prose_question(
            "> Why did it fail?\n\nFixed the off-by-one in main.rs."
        ));
        assert!(!ends_with_prose_question(
            "## Why did the test fail?\n\nThe fixture was stale. I regenerated it and all tests pass."
        ));
    }

    #[test]
    fn analyze_root_lines_detects_interruptions_errors_and_recovery() {
        let claude_interrupt = vec![
            r#"{"isSidechain":false,"type":"user","uuid":"u1","message":{"role":"user","content":"build it"}}"#.to_string(),
            r#"{"isSidechain":false,"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#.to_string(),
            r#"{"isSidechain":false,"type":"assistant","uuid":"a1","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"No response requested."}]}}"#.to_string(),
        ];
        let out = analyze_root_lines(&claude_interrupt);
        assert!(out.interrupted_or_error);
        assert!(!out.assistant_question);
        assert_eq!(out.user_turns, 1);

        // Next user turn clears the previous turn's interruption.
        let mut recovered = claude_interrupt;
        recovered.push(
            r#"{"isSidechain":false,"type":"user","uuid":"u3","message":{"role":"user","content":"go ahead"}}"#
                .to_string(),
        );
        recovered.push(
            r#"{"isSidechain":false,"type":"assistant","uuid":"a2","message":{"model":"claude-sonnet","role":"assistant","content":[{"type":"text","text":"Should I also update docs?\n\n1. Yes\n2. No"}]}}"#
                .to_string(),
        );
        let out2 = analyze_root_lines(&recovered);
        assert!(!out2.interrupted_or_error);
        assert!(out2.assistant_question);
        assert_eq!(out2.user_turns, 2);

        let codex_abort = vec![
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}"#.to_string(),
            r#"{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#.to_string(),
        ];
        assert!(analyze_root_lines(&codex_abort).interrupted_or_error);
    }
}
