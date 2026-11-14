//! Per-terminal prompt queue persistence (`~/.cache/bellwether/queue/<core>/<terminal>.json`).
//!
//! All mutating operations and auto-drains serialize under `queue/<core>/<terminal>.lock`
//! (`FolderLock`), writing `0600` files inside `0700` folders via atomic temp-and-rename.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::chat::cache;
use crate::chat::locate::{self, LocateFailure};
use crate::events;
use crate::requests::claims::FolderLock;

pub const VERSION: u32 = 1;
pub const MAX_ITEMS: usize = 20;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

const LOCK_TRIES: u32 = 250;
const LOCK_WAIT: Duration = Duration::from_millis(20);

static SEQ: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct QueueItem {
    pub id: String,
    pub text: String,
    pub at_ms: i64,
    pub expect_kind: String,
    pub expect_session: Option<String>,
    #[serde(default)]
    pub unverified_startup: bool,
    #[serde(default)]
    pub agent_pid: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResumedTurn {
    pub path: String,
    pub len: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct QueueState {
    pub v: u32,
    pub held: bool,
    pub hold_reason: Option<String>,
    pub last_drain_event: Option<String>,
    pub last_sent_ms: Option<i64>,
    pub resumed_turn: Option<ResumedTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inflight_item_id: Option<String>,
    pub items: Vec<QueueItem>,
}

impl Default for QueueState {
    fn default() -> Self {
        Self {
            v: VERSION,
            held: false,
            hold_reason: None,
            last_drain_event: None,
            last_sent_ms: None,
            resumed_turn: None,
            inflight_item_id: None,
            items: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct StoreError {
    pub code: &'static str,
    pub message: String,
    pub usage: bool,
}

impl StoreError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            code: "usage",
            message: message.into(),
            usage: true,
        }
    }

    pub fn runtime(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            usage: false,
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn validate_terminal(terminal: &str) -> Result<(), StoreError> {
    if terminal.contains('/') {
        return Err(StoreError::usage(format!(
            "{terminal}: run bw queue on the terminal's own machine with its local address"
        )));
    }
    if !events::safe_terminal(terminal) {
        return Err(StoreError::usage(format!(
            "invalid --terminal {terminal:?}"
        )));
    }
    Ok(())
}

pub fn validate_text(text: &str) -> Result<(), StoreError> {
    if text.trim().is_empty() {
        return Err(StoreError::usage("--text must not be empty"));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(StoreError::runtime(
            "too_large",
            format!(
                "queued message is {} bytes (max {MAX_TEXT_BYTES})",
                text.len()
            ),
        ));
    }
    Ok(())
}

pub fn queue_root_dir() -> PathBuf {
    cache::cache_dir().join("queue")
}

pub fn queue_core_dir(core: &str) -> PathBuf {
    queue_root_dir().join(cache::safe(core))
}

pub fn queue_file(core: &str, terminal: &str) -> PathBuf {
    queue_core_dir(core).join(format!("{}.json", cache::safe(terminal)))
}

pub fn lock_file(core: &str, terminal: &str) -> PathBuf {
    queue_core_dir(core).join(format!("{}.lock", cache::safe(terminal)))
}

fn ensure_core_dir(core: &str) -> Result<PathBuf, StoreError> {
    let root = queue_root_dir();
    let dir = queue_core_dir(core);
    for p in [&root, &dir] {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(p)
            .map_err(|e| {
                StoreError::runtime("io_error", format!("cannot create {}: {e}", p.display()))
            })?;
        let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

pub(crate) fn lock_terminal(core: &str, terminal: &str) -> Result<FolderLock, StoreError> {
    ensure_core_dir(core)?;
    let path = lock_file(core, terminal);
    FolderLock::take_file(&path, LOCK_TRIES, LOCK_WAIT)
        .ok_or_else(|| StoreError::runtime("busy", format!("queue lock for {terminal} is busy")))
}

pub fn read_in(core: &str, terminal: &str) -> QueueState {
    if !events::safe_terminal(terminal) {
        return QueueState::default();
    }
    let Ok(bytes) = fs::read(queue_file(core, terminal)) else {
        return QueueState::default();
    };
    let Ok(state) = serde_json::from_slice::<QueueState>(&bytes) else {
        return QueueState::default();
    };
    if state.v != VERSION {
        return QueueState::default();
    }
    state
}

pub fn write_in(core: &str, terminal: &str, state: &QueueState) -> Result<(), StoreError> {
    let dir = ensure_core_dir(core)?;
    let file = queue_file(core, terminal);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".{}.{}.{n}.tmp",
        cache::safe(terminal),
        std::process::id()
    ));
    let mut out = state.clone();
    out.v = VERSION;
    let payload = serde_json::to_vec(&out)
        .map_err(|e| StoreError::runtime("io_error", format!("serialize queue: {e}")))?;
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(&payload)?;
        f.sync_all()?;
        fs::rename(&tmp, &file)
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(StoreError::runtime(
            "io_error",
            format!("cannot write {}: {e}", file.display()),
        ));
    }
    Ok(())
}

/// Fast lock-free check used by `bw event` on root `"Stop"` payloads.
pub fn has_runnable(core: &str, terminal: &str) -> bool {
    let state = read_in(core, terminal);
    !state.held && !state.items.is_empty()
}

pub fn state_json(
    terminal: &str,
    state: &QueueState,
    result: Option<&str>,
    extra: Option<(&str, Value)>,
) -> Value {
    let mut v = json!({
        "type": "queue",
        "terminal": terminal,
        "held": state.held,
        "hold_reason": state.hold_reason,
        "items": state.items,
    });
    if let Some(r) = result {
        v["result"] = json!(r);
    }
    if let Some((k, val)) = extra {
        v[k] = val;
    }
    v
}

#[derive(Debug, Clone)]
pub struct BoundSession {
    pub expect_session: Option<String>,
    pub unverified_startup: bool,
    pub agent_pid: Option<i32>,
    pub log_path_len: Option<ResumedTurn>,
}

/// Resolves the live session on `terminal` for `bw queue add` or `bw queue resume`.
pub fn bind_live_session(
    terminal: &str,
    expect_kind: &str,
    explicit_session: Option<&str>,
    at_ms: i64,
) -> Result<BoundSession, StoreError> {
    let explicit = explicit_session.filter(|s| !s.is_empty());
    let prev_root = cache::read(&cache::terminal_file(terminal)).root;
    let (record, found) = locate::locate_with_record(terminal, at_ms, true);
    match found {
        Ok(located) => {
            if located.agent != expect_kind {
                return Err(StoreError::runtime(
                    "wrong_agent",
                    format!("{terminal} runs {}, expected {expect_kind}", located.agent),
                ));
            }
            if let Some(want) = explicit {
                if want == "none" || want != located.session {
                    return Err(StoreError::runtime(
                        "session_mismatch",
                        format!(
                            "{terminal} shows session {}, expected {want}",
                            located.session
                        ),
                    ));
                }
            }
            let len = fs::metadata(&located.path).map(|m| m.len()).unwrap_or(0);
            Ok(BoundSession {
                expect_session: Some(located.session),
                unverified_startup: false,
                agent_pid: located.pid,
                log_path_len: Some(ResumedTurn {
                    path: located.path.to_string_lossy().to_string(),
                    len,
                }),
            })
        }
        Err(LocateFailure::NoLog { agent, session }) => {
            if agent != expect_kind {
                return Err(StoreError::runtime(
                    "wrong_agent",
                    format!("{terminal} runs {agent}, expected {expect_kind}"),
                ));
            }
            let live_pid = record
                .as_ref()
                .and_then(locate::live_agent_pid_of)
                .and_then(|(k, pid)| (k == expect_kind).then_some(pid));
            match session {
                Some(live_sid) => {
                    if let Some(want) = explicit {
                        if want != "none" && want != live_sid {
                            return Err(StoreError::runtime(
                                "session_mismatch",
                                format!("{terminal} shows session {live_sid}, expected {want}"),
                            ));
                        }
                    }
                    Ok(BoundSession {
                        expect_session: Some(live_sid),
                        unverified_startup: false,
                        agent_pid: live_pid,
                        log_path_len: None,
                    })
                }
                None => {
                    if let Some(want) = explicit {
                        if want != "none" {
                            return Err(StoreError::runtime(
                                "session_mismatch",
                                format!(
                                    "{terminal} has not named a session yet, cannot verify {want}"
                                ),
                            ));
                        }
                    }
                    let Some(pid) = live_pid else {
                        return Err(StoreError::runtime(
                            "no_agent",
                            format!("no live {expect_kind} process in {terminal}"),
                        ));
                    };
                    Ok(BoundSession {
                        expect_session: None,
                        unverified_startup: true,
                        agent_pid: Some(pid),
                        log_path_len: None,
                    })
                }
            }
        }
        Err(LocateFailure::NoProcess { agent }) => Err(StoreError::runtime(
            "no_agent",
            format!("no live {agent} process in {terminal}"),
        )),
        Err(LocateFailure::Ambiguous { agent, message }) => {
            if agent != expect_kind {
                return Err(StoreError::runtime(
                    "wrong_agent",
                    format!("{terminal} runs {agent}, expected {expect_kind}"),
                ));
            }
            if prev_root.is_none()
                && events::read(terminal, 0).is_empty()
                && explicit.is_none_or(|w| w == "none")
            {
                if let Some(pid) = record
                    .as_ref()
                    .and_then(|r| locate::fresh_startup_pid_of(r, expect_kind))
                {
                    return Ok(BoundSession {
                        expect_session: None,
                        unverified_startup: true,
                        agent_pid: Some(pid),
                        log_path_len: None,
                    });
                }
            }
            Err(StoreError::runtime("ambiguous", message))
        }
        Err(LocateFailure::NotAgent(message)) => Err(StoreError::runtime("not_agent", message)),
        Err(LocateFailure::NoTerminal(message)) => Err(StoreError::runtime("no_terminal", message)),
        Err(LocateFailure::NoCore(message)) => Err(StoreError::runtime("unreachable", message)),
    }
}

pub fn add_item(
    core: &str,
    terminal: &str,
    kind: &str,
    explicit_session: Option<&str>,
    text: String,
) -> Result<(QueueItem, QueueState), StoreError> {
    validate_terminal(terminal)?;
    if kind != "claude" && kind != "codex" {
        return Err(StoreError::usage("--kind must be claude or codex"));
    }
    validate_text(&text)?;
    let at_ms = now_ms();
    let bound = bind_live_session(terminal, kind, explicit_session, at_ms)?;

    let _lock = lock_terminal(core, terminal)?;
    let mut state = read_in(core, terminal);
    if state.items.len() >= MAX_ITEMS {
        return Err(StoreError::runtime(
            "queue_full",
            format!("queue for {terminal} already holds {MAX_ITEMS} items"),
        ));
    }
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let item = QueueItem {
        id: format!("q-{at_ms}-{}-{n}", std::process::id()),
        text,
        at_ms,
        expect_kind: kind.to_string(),
        expect_session: bound.expect_session,
        unverified_startup: bound.unverified_startup,
        agent_pid: bound.agent_pid,
    };
    state.items.push(item.clone());
    write_in(core, terminal, &state)?;
    Ok((item, state))
}

pub fn edit_item(
    core: &str,
    terminal: &str,
    id: &str,
    text: String,
) -> Result<QueueState, StoreError> {
    validate_terminal(terminal)?;
    if id.is_empty() {
        return Err(StoreError::usage("missing --id"));
    }
    validate_text(&text)?;
    let _lock = lock_terminal(core, terminal)?;
    let mut state = read_in(core, terminal);
    let Some(item) = state.items.iter_mut().find(|it| it.id == id) else {
        return Err(StoreError::runtime(
            "not_found",
            format!("queue item {id} not found"),
        ));
    };
    item.text = text;
    write_in(core, terminal, &state)?;
    Ok(state)
}

pub fn move_item(
    core: &str,
    terminal: &str,
    id: &str,
    to: usize,
) -> Result<QueueState, StoreError> {
    validate_terminal(terminal)?;
    if id.is_empty() {
        return Err(StoreError::usage("missing --id"));
    }
    let _lock = lock_terminal(core, terminal)?;
    let mut state = read_in(core, terminal);
    let Some(from) = state.items.iter().position(|it| it.id == id) else {
        return Err(StoreError::runtime(
            "not_found",
            format!("queue item {id} not found"),
        ));
    };
    let item = state.items.remove(from);
    let dest = to.min(state.items.len());
    state.items.insert(dest, item);
    write_in(core, terminal, &state)?;
    Ok(state)
}

pub fn remove_item(core: &str, terminal: &str, id: &str) -> Result<QueueState, StoreError> {
    validate_terminal(terminal)?;
    if id.is_empty() {
        return Err(StoreError::usage("missing --id"));
    }
    let _lock = lock_terminal(core, terminal)?;
    let mut state = read_in(core, terminal);
    let before = state.items.len();
    state.items.retain(|it| it.id != id);
    if state.items.len() == before {
        return Err(StoreError::runtime(
            "not_found",
            format!("queue item {id} not found"),
        ));
    }
    if state.inflight_item_id.as_deref() == Some(id) {
        state.inflight_item_id = None;
    }
    if state.items.is_empty() {
        state.held = false;
        state.hold_reason = None;
        state.resumed_turn = None;
        state.inflight_item_id = None;
    }
    write_in(core, terminal, &state)?;
    Ok(state)
}

pub fn clear_items(core: &str, terminal: &str) -> Result<QueueState, StoreError> {
    validate_terminal(terminal)?;
    let _lock = lock_terminal(core, terminal)?;
    let mut state = read_in(core, terminal);
    state.items.clear();
    state.held = false;
    state.hold_reason = None;
    state.resumed_turn = None;
    state.inflight_item_id = None;
    write_in(core, terminal, &state)?;
    Ok(state)
}

/// Re-binds queued items to the live session and clears `held` before triggering a drain check.
pub fn resume_queue(core: &str, terminal: &str) -> Result<QueueState, StoreError> {
    validate_terminal(terminal)?;
    let _lock = lock_terminal(core, terminal)?;
    let mut state = read_in(core, terminal);
    if state.items.is_empty() {
        state.held = false;
        state.hold_reason = None;
        state.resumed_turn = None;
        state.inflight_item_id = None;
        write_in(core, terminal, &state)?;
        return Ok(state);
    }
    let expect_kind = state.items[0].expect_kind.clone();
    if state.items.iter().any(|it| it.expect_kind != expect_kind) {
        return Err(StoreError::runtime(
            "wrong_agent",
            "queued items name conflicting agent kinds",
        ));
    }
    let bound = bind_live_session(terminal, &expect_kind, None, now_ms())?;
    for it in &mut state.items {
        it.expect_session = bound.expect_session.clone();
        it.unverified_startup = bound.unverified_startup;
        it.agent_pid = bound.agent_pid;
    }
    state.held = false;
    state.hold_reason = None;
    state.resumed_turn = bound.log_path_len;
    state.inflight_item_id = None;
    write_in(core, terminal, &state)?;
    Ok(state)
}
