//! `bw locate`: which agent runs in a terminal and which session log it writes, remembered per terminal.
//!
//! One `hc get` names the terminal's processes. A root remembered less than 30 s ago for the same processes is used
//! as it is; otherwise `bw` lists processes once and asks `herdr-core`'s resolver about that one terminal, with the
//! logs other live terminals remember as taken. A Codex process that holds one root thread lock shows that
//! thread, which after `/new` may have no log yet; one that holds several shows none until the others unload.
//!
//! `fresh`, `latest`, `absolute` and the cache write are adapted from Flockbook's
//! xplat/flockbook-modfeed/src/locate.rs (MIT, Copyright (c) 2026 Min-Chen Lee).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;
use std::time::UNIX_EPOCH;

use herdr_core::hc::mapper::{self, Term};
use herdr_core::resolver::{self, Need, Proc, SessionResolver};
use herdr_core::session_log;
use serde_json::{json, Value};

use super::args;
use super::cache::{self, Root};
use super::dirs;
use crate::hc::{self, HcError};

/// A remembered root is used without a process scan for this long.
pub const RECHECK_MS: i64 = 30_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Located {
    pub terminal: String,
    pub agent: String,
    pub session: String,
    pub path: PathBuf,
    pub pid: Option<i32>,
    pub status: Option<String>,
}

/// Nothing to read, which is not an error: each prints one `state` line and exits 0.
#[derive(Clone, Debug, PartialEq)]
pub enum LocateFailure {
    NoCore(String),
    NoTerminal(String),
    NotAgent(String),
    /// The agent runs and named a conversation that has no log yet: the only state a first message may pass.
    /// `session` is that conversation's id when the agent named one (a Claude pid file, a Codex thread lock).
    NoLog {
        agent: String,
        session: Option<String>,
    },
    /// hc names the agent's program but none of its processes runs it: starting, or already gone.
    NoProcess {
        agent: String,
    },
    /// The agent runs, but nothing shows which conversation it shows, or that it has none yet.
    Ambiguous {
        agent: String,
        message: String,
    },
}

impl LocateFailure {
    pub fn state_line(&self) -> Value {
        match self {
            LocateFailure::NoCore(m) => json!({"type": "state", "state": "no_core", "message": m}),
            LocateFailure::NoTerminal(m) => {
                json!({"type": "state", "state": "no_terminal", "message": m})
            }
            LocateFailure::NotAgent(m) => {
                json!({"type": "state", "state": "not_agent", "message": m})
            }
            LocateFailure::NoLog { agent, session } => {
                let mut v = json!({
                    "type": "state",
                    "state": "no_log",
                    "agent": agent,
                    "message": format!("no {agent} session log yet"),
                });
                if let Some(s) = session {
                    v["session"] = json!(s);
                }
                v
            }
            LocateFailure::NoProcess { agent } => json!({
                "type": "state",
                "state": "no_log",
                "agent": agent,
                "message": format!("no {agent} process in this terminal yet"),
            }),
            LocateFailure::Ambiguous { agent, message } => json!({
                "type": "state",
                "state": "ambiguous",
                "agent": agent,
                "message": message,
            }),
        }
    }
}

/// The files a process tree holds open.
pub type OpenFiles = Rc<dyn Fn(&[i32]) -> Vec<String>>;

/// What a lookup reads besides the terminal record, so tests can give fixed processes and files.
/// `procs` and `claimed` are only called when the remembered root is not fresh.
pub struct Inputs {
    pub procs: Box<dyn Fn() -> Vec<Proc>>,
    pub open_files: OpenFiles,
    pub claimed: Box<dyn Fn() -> HashSet<String>>,
    pub own_env: HashMap<String, String>,
    pub home: PathBuf,
    /// Look again even when the remembered root is fresh, as `bw send` does before it types.
    pub recheck: bool,
}

pub fn locate(terminal: &str, now_ms: i64) -> Result<Located, LocateFailure> {
    locate_as(terminal, now_ms, false)
}

/// `locate` without trusting a root remembered in the last 30 s, so a new conversation started since is seen.
pub fn locate_fresh(terminal: &str, now_ms: i64) -> Result<Located, LocateFailure> {
    locate_as(terminal, now_ms, true)
}

fn locate_as(terminal: &str, now_ms: i64, recheck: bool) -> Result<Located, LocateFailure> {
    locate_with_record(terminal, now_ms, recheck).1
}

/// `locate`, also giving the `hc get` record it read (None when it read none), so a caller needs no second one.
pub fn locate_with_record(
    terminal: &str,
    now_ms: i64,
    recheck: bool,
) -> (Option<Value>, Result<Located, LocateFailure>) {
    // A remote terminal's pids mean nothing here (`mapper::pane` drops them), so it would only ever read as no log.
    if terminal.contains('/') {
        return (
            None,
            Err(LocateFailure::NoTerminal(format!(
                "{terminal} is on another machine; bw locate runs there with its local address"
            ))),
        );
    }
    let term = match hc::hc_get(terminal) {
        Ok(v) => v,
        Err(HcError::Refused { kind, message }) if kind == "not_found" || kind == "finished" => {
            return (None, Err(LocateFailure::NoTerminal(message)))
        }
        Err(e) => return (None, Err(LocateFailure::NoCore(e.to_string()))),
    };
    let file = cache::terminal_file(terminal);
    let core_dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
    let me = terminal.to_string();
    let inputs = Inputs {
        procs: Box::new(resolver::processes),
        open_files: Rc::new(|pids: &[i32]| resolver::open_files(pids)),
        claimed: Box::new(move || claimed_by_others(&core_dir, &me, &live_terminals())),
        own_env: std::env::vars().collect(),
        home: PathBuf::from(session_log::home_dir()),
        recheck,
    };
    let found = locate_with(&term, &file, &inputs, now_ms);
    (Some(term), found)
}

/// The live agent kind and PID running in `term`, even before its first session log exists.
pub(crate) fn live_agent_pid_of(term: &Value) -> Option<(String, i32)> {
    let t = Term::parse(term)?;
    if t.state != "live" {
        return None;
    }
    let kind = mapper::kind(&t).filter(|k| k == "claude" || k == "codex")?;
    let pane = mapper::pane(&t);
    let procs = resolver::processes();
    let agent = resolver::hc_agent_process(&pane.process_ids, &kind, &procs)?;
    Some((kind, agent.pid))
}

/// Returns the live agent PID only when `term` runs a brand-new `expect_kind` process that has not yet
/// created any Claude `sessions/<pid>.json`, Codex `.lock`, or open `.jsonl` transcript.
pub(crate) fn fresh_startup_pid_of(term: &Value, expect_kind: &str) -> Option<i32> {
    let t = Term::parse(term)?;
    if t.state != "live" {
        return None;
    }
    let kind = mapper::kind(&t).filter(|k| k == expect_kind)?;
    let pane = mapper::pane(&t);
    let procs = resolver::processes();
    let agent = resolver::hc_agent_process(&pane.process_ids, &kind, &procs)?;
    let tree = resolver::subtree(agent.pid, &procs);
    let open = resolver::open_files(&tree);
    if open
        .iter()
        .any(|f| f.ends_with(".jsonl") || f.ends_with(".lock"))
    {
        return None;
    }
    if kind == "claude" {
        let own_env: HashMap<String, String> = std::env::vars().collect();
        let home = PathBuf::from(session_log::home_dir());
        let dirs = dirs::agent_dirs(&agent.line, &own_env, &home);
        let sessions = dirs.claude_sessions();
        if std::iter::once(agent.pid)
            .chain(pane.process_ids.iter().copied())
            .any(|p| sessions.join(format!("{p}.json")).exists())
        {
            return None;
        }
    }
    Some(agent.pid)
}

/// This core's live terminal addresses; none when `hc ls` fails, which only means nothing counts as taken.
fn live_terminals() -> Vec<String> {
    let Ok(v) = hc::hc_ls() else {
        return Vec::new();
    };
    v["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["state"].as_str().is_none_or(|s| s == "live"))
        .filter_map(|t| t["address"].as_str().map(String::from))
        .collect()
}

/// The paths and session ids other live terminals in `core_dir` remember. A file left by a closed terminal claims
/// nothing, so a log is never kept from the terminal that now writes it.
pub fn claimed_by_others(core_dir: &Path, terminal: &str, live: &[String]) -> HashSet<String> {
    let live: HashSet<String> = live
        .iter()
        .filter_map(|a| {
            cache::terminal_file(a)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
        })
        .collect();
    cache::roots_except(core_dir, terminal)
        .into_iter()
        .filter(|(stem, _)| live.contains(stem))
        .flat_map(|(_, r)| [r.path, r.session])
        .filter(|s| !s.is_empty())
        .collect()
}

/// What a terminal runs, for a message: the foreground program, else the terminal's own.
fn program(t: &Term) -> String {
    t.fg_name
        .clone()
        .or_else(|| t.fg_argv.first().cloned())
        .or_else(|| t.argv.first().cloned())
        .map(|p| p.rsplit('/').next().unwrap_or(&p).to_string())
        .unwrap_or_else(|| "nothing".into())
}

/// Claude's config folder for a log at `<config>/projects/<folder>/<id>.jsonl`.
fn claude_config_of(log: &Path) -> Option<&Path> {
    log.ancestors().nth(3)
}

fn mtime_ms(p: &Path) -> Option<i64> {
    let m = std::fs::metadata(p).ok()?.modified().ok()?;
    i64::try_from(m.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// Claude rewrites `sessions/<pid>.json` on `/clear`, which a stat notices before the 30 s are up.
fn pid_file_changed(r: &Root) -> bool {
    let (Some(pid), Some(config)) = (r.agent_pid, claude_config_of(Path::new(&r.path))) else {
        return false;
    };
    mtime_ms(&config.join(format!("sessions/{pid}.json"))).is_some_and(|m| m > r.checked_ms)
}

/// Codex adds `<home>/thread-writer-locks/<id>.lock` for a new thread (`/new`, a sub-agent), which a stat of the
/// folder notices before the 30 s are up. The home is five levels above `sessions/YYYY/MM/DD/<rollout>`.
fn codex_locks_changed(r: &Root) -> bool {
    let Some(home) = Path::new(&r.path).ancestors().nth(5) else {
        return false;
    };
    mtime_ms(&home.join("thread-writer-locks")).is_some_and(|m| m > r.checked_ms)
}

/// The remembered root still holds: same agent kind and processes, checked lately, and its log is still there.
fn fresh(r: &Root, kind: &str, pids: &[i32], now_ms: i64) -> bool {
    r.kind == kind
        && r.pids == pids
        && (0..RECHECK_MS).contains(&(now_ms - r.checked_ms))
        && Path::new(&r.path).is_file()
        && !(kind == "claude" && pid_file_changed(r))
        && !(kind == "codex" && codex_locks_changed(r))
}

/// Claude goes on in a new log while its pid file keeps the old id: follow `continued-in`.
fn latest(r: &Root) -> Root {
    if r.kind != "claude" {
        return r.clone();
    }
    let path = Path::new(&r.path);
    let projects = path.parent().and_then(Path::parent);
    let next = session_log::continued(path, projects);
    if next == path {
        return r.clone();
    }
    Root {
        session: session_of(&next, "claude"),
        path: next.to_string_lossy().to_string(),
        ..r.clone()
    }
}

/// Claude's file stem; Codex's `session_meta` id, else the id at the end of the rollout's name.
fn session_of(path: &Path, kind: &str) -> String {
    if kind == "codex" {
        let mut head = Vec::new();
        let read = std::fs::File::open(path).and_then(|f| f.take(1 << 20).read_to_end(&mut head));
        if let Some(m) = read.ok().and_then(|_| resolver::codex_meta_full(&head)) {
            if !m.id.is_empty() {
                return m.id;
            }
        }
    }
    super::feed::session_of(path, kind)
}

/// The resolver gives Codex a path and hc Claude a session id, which is looked up in the agent's projects folder.
fn absolute(v: &str, kind: &str, dirs: &dirs::AgentDirs) -> Option<PathBuf> {
    if v.is_empty() {
        return None;
    }
    if v.starts_with('/') {
        return Some(PathBuf::from(v));
    }
    let dir = if kind == "codex" {
        dirs.codex_sessions()
    } else {
        dirs.claude_projects()
    };
    session_log::locate(kind, v, dir)
}

/// `f` that runs `lsof` once for the same pids within one lookup.
fn memo(f: OpenFiles) -> OpenFiles {
    let last: RefCell<Option<(Vec<i32>, Vec<String>)>> = RefCell::new(None);
    Rc::new(move |pids: &[i32]| {
        if let Some((p, files)) = last.borrow().as_ref() {
            if p == pids {
                return files.clone();
            }
        }
        let files = f(pids);
        *last.borrow_mut() = Some((pids.to_vec(), files.clone()));
        files
    })
}

/// A Codex thread id as its lock file names it: UUIDv7 in lower-case hex, so string order is time order.
fn thread_id(lock: &Path) -> Option<&str> {
    if lock.parent()?.file_name()? != "thread-writer-locks" {
        return None;
    }
    let id = lock.file_name()?.to_str()?.strip_suffix(".lock")?;
    let ok = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
        });
    ok.then_some(id)
}

fn codex_meta_of(path: &Path) -> Option<resolver::CodexMeta> {
    let mut head = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(1 << 20).read_to_end(&mut head))
        .ok()?;
    resolver::codex_meta_full(&head)
}

/// The thread a Codex process shows, from the root thread locks it holds (a sub-agent's rollout says so).
/// Codex 0.167 keeps a thread it leaves (`/new`, `/resume`) loaded, lock and rollout open, for 60 s or while it
/// runs, and a new thread has a lock and no rollout until its first message. Nothing it holds tells which thread
/// the terminal displays, and thread age does not (`/resume` shows an older one), so several root locks name
/// none. None when it holds no root lock.
fn codex_thread(open: &[String]) -> Option<Answer> {
    let mut locks: Vec<(&str, &Path)> = open
        .iter()
        .map(Path::new)
        .filter_map(|p| Some((thread_id(p)?, p)))
        .collect();
    locks.sort_by(|a, b| a.0.cmp(b.0));
    locks.dedup_by(|a, b| a.0 == b.0);
    let mut roots: Vec<(&str, Option<PathBuf>)> = vec![];
    for (id, lock) in locks {
        let suffix = format!("-{id}.jsonl");
        let rollout = open
            .iter()
            .find(|f| f.ends_with(&suffix) && f.contains("/rollout-"))
            .map(PathBuf::from)
            .or_else(|| {
                let home = lock.parent()?.parent()?;
                session_log::locate_codex(id, home.join("sessions"))
            });
        // A lock without a rollout may be a sub-agent's that has not written one yet: it counts, which only
        // names nothing until that rollout appears.
        if rollout
            .as_deref()
            .and_then(codex_meta_of)
            .is_some_and(|m| m.subagent)
        {
            continue;
        }
        roots.push((id, rollout));
    }
    match roots.as_slice() {
        [] => None,
        [(id, Some(path))] => Some(Answer::Log {
            session: id.to_string(),
            path: path.to_string_lossy().to_string(),
        }),
        [(id, None)] => Some(Answer::NoFile {
            session: Some(id.to_string()),
        }),
        _ => Some(Answer::Ambiguous),
    }
}

/// What the resolver said about one terminal.
enum Answer {
    Log {
        session: String,
        path: String,
    },
    /// It named a log or session id whose file is not there (yet): a new conversation, not the remembered one.
    NoFile {
        session: Option<String>,
    },
    /// No single answer: no candidate, several, or the one it found is taken.
    Unsure,
    /// Codex holds several root threads: any of them may be the one shown, the remembered one included.
    Ambiguous,
}

/// The session id in what the resolver named: hc Claude's session id, or the id in a Codex rollout's name.
fn named_session(v: &str, kind: &str) -> Option<String> {
    let id = if v.starts_with('/') {
        super::feed::session_of(Path::new(v), kind)
    } else {
        v.to_string()
    };
    (!id.is_empty()).then_some(id)
}

/// Asks the resolver about this one terminal, with its agent's own folders.
fn resolve(need: Need, agent: &Proc, procs: &[Proc], inputs: &Inputs) -> Answer {
    let open = memo(inputs.open_files.clone());
    if need.kind == "codex" {
        if let Some(a) = codex_thread(&open(&resolver::subtree(agent.pid, procs))) {
            return a;
        }
    }
    let mut dirs = dirs::agent_dirs(&agent.line, &inputs.own_env, &inputs.home);
    if need.kind == "codex" && dirs::env_value(&agent.line, "CODEX_HOME").is_none() {
        // The agent's own open rollouts outrank `bw`'s environment and the default.
        if let Some(home) = dirs::codex_home_of_open(&open(&resolver::subtree(agent.pid, procs))) {
            dirs.codex_home = home;
        }
    }
    let mut r = SessionResolver::new("");
    r.claude_dir = dirs.claude_sessions().to_string_lossy().to_string();
    r.projects_dir = dirs.claude_projects().to_string_lossy().to_string();
    r.codex_dir = dirs.codex_sessions().to_string_lossy().to_string();
    r.open_files = Box::new(move |pids: &[i32]| open(pids));
    let claimed = (inputs.claimed)();
    let found = r.resolve_with(
        std::slice::from_ref(&need),
        &claimed,
        &HashMap::new(),
        Some(procs),
    );
    let Some(v) = found.get(&need.pane_id) else {
        return Answer::Unsure;
    };
    match absolute(v, &need.kind, &dirs).filter(|p| p.is_file()) {
        Some(path) => Answer::Log {
            session: session_of(&path, &need.kind),
            path: path.to_string_lossy().to_string(),
        },
        None => Answer::NoFile {
            session: named_session(v, &need.kind),
        },
    }
}

pub fn locate_with(
    term: &Value,
    cache_file: &Path,
    inputs: &Inputs,
    now_ms: i64,
) -> Result<Located, LocateFailure> {
    let t = Term::parse(term)
        .ok_or_else(|| LocateFailure::NoTerminal("hc gave no terminal record".into()))?;
    if t.state != "live" {
        return Err(LocateFailure::NoTerminal(format!(
            "{} is {}",
            t.address, t.state
        )));
    }
    let kind = mapper::kind(&t)
        .filter(|k| k == "claude" || k == "codex")
        .ok_or_else(|| LocateFailure::NotAgent(format!("{} runs {}", t.address, program(&t))))?;
    let pane = mapper::pane(&t);
    let mut kept = cache::read(cache_file);
    let located = |r: &Root| Located {
        terminal: t.address.clone(),
        agent: r.kind.clone(),
        session: r.session.clone(),
        path: PathBuf::from(&r.path),
        pid: r.agent_pid,
        status: t.status.clone(),
    };

    if let Some(r) = kept
        .root
        .as_ref()
        .filter(|r| !inputs.recheck && fresh(r, &kind, &pane.process_ids, now_ms))
    {
        let r = latest(r);
        if kept.root.as_ref() != Some(&r) {
            kept.root = Some(r.clone());
            // A cache that cannot be written costs the next call a process scan, nothing more.
            let _ = cache::write(cache_file, &kept);
        }
        return Ok(located(&r));
    }

    let procs = (inputs.procs)();
    let agent = resolver::hc_agent_process(&pane.process_ids, &kind, &procs);
    let running = agent.is_some();
    let found = agent.as_ref().map(|a| {
        let need = Need::new(&pane.id, &kind, &pane.cwd, pane.process_ids.clone());
        resolve(need, a, &procs, inputs)
    });
    let before = kept.root.clone();
    let ambiguous = match found {
        Some(Answer::Unsure) => Some(format!(
            "cannot tell which {kind} conversation this terminal shows"
        )),
        Some(Answer::Ambiguous) => {
            Some("Codex has several conversations open; showing none until it settles".to_string())
        }
        _ => None,
    };
    let fresh_session = match &found {
        Some(Answer::NoFile { session }) => session.clone(),
        _ => None,
    };
    kept.root = match (agent, found) {
        (Some(a), Some(Answer::Log { session, path })) => Some(Root {
            kind: kind.clone(),
            pids: pane.process_ids.clone(),
            agent_pid: Some(a.pid),
            path,
            session,
            checked_ms: now_ms,
        }),
        // Unsure (two candidates, or no file open right now): the same agent process still writes the same log.
        (Some(a), Some(Answer::Unsure)) => before
            .as_ref()
            .filter(|r| {
                r.kind == kind && r.agent_pid == Some(a.pid) && Path::new(&r.path).is_file()
            })
            .map(|r| Root {
                pids: pane.process_ids.clone(),
                checked_ms: now_ms,
                ..latest(r)
            }),
        _ => None,
    };
    if kept.root != before {
        let _ = cache::write(cache_file, &kept);
    }
    kept.root.as_ref().map(located).ok_or(if !running {
        LocateFailure::NoProcess { agent: kind }
    } else if let Some(message) = ambiguous {
        LocateFailure::Ambiguous {
            agent: kind,
            message,
        }
    } else {
        LocateFailure::NoLog {
            agent: kind,
            session: fresh_session,
        }
    })
}

pub fn run(argv: &[String]) -> ExitCode {
    const USAGE: &str = "usage: bw locate --terminal <t> [--fresh]";
    let a = match args::parse(argv, &["fresh"], &["terminal"]) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let Some(t) = a.get("terminal") else {
        return crate::usage(USAGE);
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let line = match locate_as(t, now_ms, a.has("fresh")) {
        Ok(l) => json!({
            "type": "located",
            "terminal": l.terminal,
            "agent": l.agent,
            "session": l.session,
            "path": l.path.to_string_lossy(),
            "pid": l.pid,
            "status": l.status,
        }),
        Err(f) => f.state_line(),
    };
    println!("{line}");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Duration, Local, SecondsFormat, TimeZone, Utc};
    use std::cell::Cell;
    use std::fs;

    const CLAUDE_SID: &str = "e186f156-fd30-4aab-a0b6-d3922b281731";
    const CODEX_PARENT: &str =
        "rollout-2026-11-06T22-11-05-01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc.jsonl";
    const CODEX_CHILD: &str =
        "rollout-2026-11-06T22-11-09-01a1b4a1-dfcb-77e0-8029-0fbb3b65e5ba.jsonl";
    const PARENT_ID: &str = "01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc";

    fn sessions() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/sessions")
    }

    fn now_ms() -> i64 {
        Utc::now().timestamp_millis()
    }

    fn at(ms: i64) -> DateTime<Utc> {
        Utc.timestamp_millis_opt(ms / 1000 * 1000).unwrap()
    }

    fn proc_(pid: i32, ppid: i32, start: DateTime<Utc>, line: &str) -> Proc {
        Proc {
            pid,
            ppid,
            start,
            line: line.into(),
        }
    }

    /// An hc terminal record whose foreground program is `program` (pid `pid`) under shell pid `pid - 1`.
    fn term(address: &str, program: &str, pid: i32, cwd: &str) -> Value {
        json!({
            "address": address, "argv": ["/bin/zsh", "-l"], "cwd": cwd, "pid": pid - 1, "state": "live",
            "status": {"state": "idle"},
            "foreground": {"argv": [program], "cwd": cwd, "name": program, "pid": pid},
        })
    }

    struct Fixed {
        procs: Vec<Proc>,
        open: Vec<String>,
        claimed: HashSet<String>,
        scans: Rc<Cell<usize>>,
    }

    impl Fixed {
        fn new(procs: Vec<Proc>, open: Vec<String>) -> Fixed {
            Fixed {
                procs,
                open,
                claimed: HashSet::new(),
                scans: Rc::new(Cell::new(0)),
            }
        }

        fn inputs(&self) -> Inputs {
            let (procs, open, claimed, scans) = (
                self.procs.clone(),
                self.open.clone(),
                self.claimed.clone(),
                self.scans.clone(),
            );
            Inputs {
                procs: Box::new(move || {
                    scans.set(scans.get() + 1);
                    procs.clone()
                }),
                open_files: Rc::new(move |_: &[i32]| open.clone()),
                claimed: Box::new(move || claimed.clone()),
                own_env: HashMap::new(),
                home: PathBuf::from("/nohome"),
                recheck: false,
            }
        }
    }

    fn copy(from: &Path, to: &Path) -> String {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(from, to).unwrap();
        to.to_string_lossy().to_string()
    }

    /// A Claude config folder holding the claude-approval log under `projects/-scratch/` and `sessions/<pid>.json`.
    fn claude_config(dir: &Path, pid: i32, start: DateTime<Utc>, sid: &str) -> String {
        let log = copy(
            &sessions()
                .join("claude-approval")
                .join(format!("{CLAUDE_SID}.jsonl")),
            &dir.join(format!("projects/-scratch/{sid}.jsonl")),
        );
        pid_file(dir, pid, start, sid);
        log
    }

    fn pid_file(dir: &Path, pid: i32, start: DateTime<Utc>, sid: &str) {
        fs::create_dir_all(dir.join("sessions")).unwrap();
        let proc_start = start.format("%a %b %e %H:%M:%S %Y").to_string();
        fs::write(
            dir.join(format!("sessions/{pid}.json")),
            json!({"pid": pid, "sessionId": sid, "procStart": proc_start}).to_string(),
        )
        .unwrap();
    }

    fn root(
        kind: &str,
        pids: Vec<i32>,
        agent: i32,
        path: &str,
        session: &str,
        checked: i64,
    ) -> Root {
        Root {
            kind: kind.into(),
            pids,
            agent_pid: Some(agent),
            path: path.into(),
            session: session.into(),
            checked_ms: checked,
        }
    }

    fn remember(file: &Path, r: Root) {
        cache::write(
            file,
            &cache::TerminalCache {
                root: Some(r),
                ..Default::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn claude_pid_file_names_the_session() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let start = at(now - 60_000);
        let config = tmp.path().join("claude-config");
        let log = claude_config(&config, 700, start, CLAUDE_SID);
        let line = format!("claude CLAUDE_CONFIG_DIR={} PATH=/bin", config.display());
        let fixed = Fixed::new(vec![proc_(700, 699, start, &line)], vec![]);
        let file = tmp.path().join("cache/t1.json");
        let got = locate_with(
            &term("t1", "claude", 700, "/scratch"),
            &file,
            &fixed.inputs(),
            now,
        );
        assert_eq!(
            got,
            Ok(Located {
                terminal: "t1".into(),
                agent: "claude".into(),
                session: CLAUDE_SID.into(),
                path: PathBuf::from(&log),
                pid: Some(700),
                status: Some("idle".into()),
            })
        );
        let kept = cache::read(&file).root.unwrap();
        assert_eq!(
            kept,
            root("claude", vec![700, 699], 700, &log, CLAUDE_SID, now)
        );
    }

    /// The codex-subagent parent and child under `<codex home>/sessions/2026/11/06/`.
    fn codex_home(dir: &Path) -> (String, String) {
        let day = dir.join("sessions/2026/11/06");
        let from = sessions().join("codex-subagent");
        (
            copy(&from.join(CODEX_PARENT), &day.join(CODEX_PARENT)),
            copy(&from.join(CODEX_CHILD), &day.join(CODEX_CHILD)),
        )
    }

    #[test]
    fn codex_root_beside_child() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let home = tmp.path().join("codex-home");
        let (parent, child) = codex_home(&home);
        let line = format!(
            "node /opt/bin/codex CODEX_HOME={} PATH=/bin",
            home.display()
        );
        let fixed = Fixed::new(
            vec![proc_(801, 800, at(now - 60_000), &line)],
            vec![child.clone(), parent.clone()],
        );
        let file = tmp.path().join("cache/t2.json");
        let got = locate_with(
            &term("t2", "codex", 801, "/scratch/codex-subagent"),
            &file,
            &fixed.inputs(),
            now,
        )
        .unwrap();
        assert_eq!(got.path, PathBuf::from(&parent));
        assert_eq!(got.session, PARENT_ID);
        assert_eq!(got.agent, "codex");
        assert_eq!(got.pid, Some(801));
    }

    #[test]
    fn codex_home_from_open_rollouts_when_env_is_hidden() {
        // macOS 27: the agent's ps line has no environment, and bw's own CODEX_HOME is not the agent's.
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let (parent, child) = codex_home(&tmp.path().join("scratch-codex-home"));
        let fixed = Fixed::new(
            vec![proc_(801, 800, at(now - 60_000), "node /opt/bin/codex")],
            vec![parent.clone(), child],
        );
        let mut inputs = fixed.inputs();
        inputs.own_env = HashMap::from([("CODEX_HOME".to_string(), "/elsewhere".to_string())]);
        let t = term("t2", "codex", 801, "/scratch/codex-subagent");
        let got = locate_with(&t, &tmp.path().join("t2.json"), &inputs, now).unwrap();
        assert_eq!(got.path, PathBuf::from(&parent));
        assert_eq!(got.session, PARENT_ID);
    }

    #[test]
    fn fresh_cache_skips_the_process_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let (parent, _) = codex_home(&tmp.path().join("codex-home"));
        let file = tmp.path().join("cache/t2.json");
        remember(
            &file,
            root(
                "codex",
                vec![801, 800],
                801,
                &parent,
                PARENT_ID,
                now - 10_000,
            ),
        );
        let fixed = Fixed::new(vec![], vec![]);
        let t = term("t2", "codex", 801, "/scratch/codex-subagent");
        let got = locate_with(&t, &file, &fixed.inputs(), now).unwrap();
        assert_eq!(got.path, PathBuf::from(&parent));
        assert_eq!(got.session, PARENT_ID);
        assert_eq!(fixed.scans.get(), 0, "a fresh root needs no process list");
        // Other processes: the root is not this terminal's any more.
        let other = term("t2", "codex", 901, "/scratch/codex-subagent");
        assert!(locate_with(&other, &file, &fixed.inputs(), now).is_err());
        assert_eq!(fixed.scans.get(), 1);
        // 30 s on, the same processes are listed again.
        remember(
            &file,
            root(
                "codex",
                vec![801, 800],
                801,
                &parent,
                PARENT_ID,
                now - RECHECK_MS,
            ),
        );
        let _ = locate_with(&t, &file, &fixed.inputs(), now);
        assert_eq!(fixed.scans.get(), 2);
    }

    #[test]
    fn remembered_root_kept_when_resolver_is_unsure() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let home = tmp.path().join("codex-home");
        let day = home.join("sessions/2026/11/06");
        let open: Vec<String> = ["codex-question", "codex-approval"]
            .iter()
            .map(|s| {
                let name = fs::read_dir(sessions().join(s))
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                    .find(|n| n.starts_with("rollout-"))
                    .unwrap();
                copy(&sessions().join(s).join(&name), &day.join(&name))
            })
            .collect();
        let line = format!("codex CODEX_HOME={}", home.display());
        let fixed = Fixed::new(vec![proc_(801, 800, at(now - 60_000), &line)], open.clone());
        let file = tmp.path().join("cache/t3.json");
        let t = term("t3", "codex", 801, "/scratch/unsure");
        // Two rollouts open: the resolver names neither, so the remembered one stays, checked again now.
        remember(
            &file,
            root("codex", vec![801, 800], 801, &open[0], "kept", now - 60_000),
        );
        let got = locate_with(&t, &file, &fixed.inputs(), now).unwrap();
        assert_eq!(got.path, PathBuf::from(&open[0]));
        assert_eq!(got.session, "kept");
        assert_eq!(cache::read(&file).root.unwrap().checked_ms, now);
        // Another agent process: the remembered root was the old agent's.
        remember(
            &file,
            root("codex", vec![801, 800], 799, &open[0], "kept", now - 60_000),
        );
        // Not a fresh conversation either: nothing shows that this agent has no log.
        assert!(matches!(
            locate_with(&t, &file, &fixed.inputs(), now),
            Err(LocateFailure::Ambiguous { agent, .. }) if agent == "codex"
        ));
        assert_eq!(cache::read(&file).root, None);
    }

    #[test]
    fn new_conversation_replaces_root() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let start = at(now - 60_000);
        let config = tmp.path().join("claude-config");
        let old = claude_config(&config, 700, start, CLAUDE_SID);
        let new_sid = "0b5e1c1e-0000-4000-8000-000000000001";
        let new = copy(
            Path::new(&old),
            &config.join(format!("projects/-scratch/{new_sid}.jsonl")),
        );
        let file = tmp.path().join("cache/t1.json");
        // Remembered 5 s ago, then /clear: Claude rewrites its pid file with the new session id.
        remember(
            &file,
            root("claude", vec![700, 699], 700, &old, CLAUDE_SID, now - 5_000),
        );
        pid_file(&config, 700, start, new_sid);
        let line = format!("claude CLAUDE_CONFIG_DIR={}", config.display());
        let fixed = Fixed::new(vec![proc_(700, 699, start, &line)], vec![]);
        let got = locate_with(
            &term("t1", "claude", 700, "/scratch"),
            &file,
            &fixed.inputs(),
            now,
        )
        .unwrap();
        assert_eq!(got.session, new_sid);
        assert_eq!(got.path, PathBuf::from(&new));
        assert_eq!(
            fixed.scans.get(),
            1,
            "a changed pid file is looked at again before 30 s"
        );
        assert_eq!(cache::read(&file).root.unwrap().session, new_sid);
    }

    #[test]
    fn a_named_session_without_its_log_is_no_log() {
        // A remembered root must not outlive the conversation: once the pid file names another session, the old
        // log is not this terminal's even before the new one is written.
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let start = at(now - 60_000);
        let config = tmp.path().join("claude-config");
        let old = claude_config(&config, 700, start, CLAUDE_SID);
        let file = tmp.path().join("cache/t1.json");
        remember(
            &file,
            root(
                "claude",
                vec![700, 699],
                700,
                &old,
                CLAUDE_SID,
                now - 60_000,
            ),
        );
        let new_sid = "0b5e1c1e-0000-4000-8000-000000000002";
        pid_file(&config, 700, start, new_sid);
        let line = format!("claude CLAUDE_CONFIG_DIR={}", config.display());
        let fixed = Fixed::new(vec![proc_(700, 699, start, &line)], vec![]);
        // The new session is named, so the chat can send its first message to exactly that one.
        assert_eq!(
            locate_with(
                &term("t1", "claude", 700, "/scratch"),
                &file,
                &fixed.inputs(),
                now
            ),
            Err(LocateFailure::NoLog {
                agent: "claude".into(),
                session: Some(new_sid.into()),
            })
        );
        assert_eq!(cache::read(&file).root, None);
    }

    /// A rollout first line as Codex 0.167 writes it; `parent` makes it a sub-agent's.
    fn rollout(
        home: &Path,
        start: DateTime<Utc>,
        id: &str,
        cwd: &str,
        parent: Option<&str>,
    ) -> String {
        let local = start.with_timezone(&Local);
        let path = home.join(format!(
            "sessions/{}/rollout-{}-{id}.jsonl",
            local.format("%Y/%m/%d"),
            local.format("%Y-%m-%dT%H-%M-%S")
        ));
        let source = match parent {
            Some(p) => json!({"subagent": {"thread_spawn": {"parent_thread_id": p, "depth": 1}}}),
            None => json!("cli"),
        };
        let ts = start.to_rfc3339_opts(SecondsFormat::Millis, true);
        let line = json!({"timestamp": ts, "type": "session_meta",
            "payload": {"id": id, "timestamp": ts, "cwd": cwd, "source": source}});
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{line}\n")).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn other_live_terminals_paths_are_claimed() {
        // Review Focus 1: two Codex in one folder started seconds apart, the second with a sub-agent, and lsof
        // showing neither: the rollouts' cwd and start times are all the resolver has.
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let t0 = at(now - 60_000);
        let home = tmp.path().join("codex-home");
        let cwd = "/scratch/two-codex";
        let a_id = "0c0de000-0000-7000-8000-00000000000a";
        let b_id = "0c0de000-0000-7000-8000-00000000000b";
        let a = rollout(&home, t0 + Duration::seconds(1), a_id, cwd, None);
        let b = rollout(&home, t0 + Duration::seconds(5), b_id, cwd, None);
        rollout(
            &home,
            t0 + Duration::seconds(8),
            "0c0de000-0000-7000-8000-00000000000c",
            cwd,
            Some(b_id),
        );
        let line = format!("codex CODEX_HOME={}", home.display());
        let procs = vec![
            proc_(801, 800, t0, &line),
            proc_(811, 810, t0 + Duration::seconds(4), &line),
        ];
        let core = tmp.path().join("feeds/core");
        let (f1, f2) = (core.join("t1.json"), core.join("t2.json"));
        let (t1, t2) = (term("t1", "codex", 801, cwd), term("t2", "codex", 811, cwd));

        // t2 started after a's rollout, so only b (not its child) can be its own.
        let mut fixed = Fixed::new(procs.clone(), vec![]);
        let got = locate_with(&t2, &f2, &fixed.inputs(), now).unwrap();
        assert_eq!(
            (got.path, got.session),
            (PathBuf::from(&b), b_id.to_string())
        );

        // t1 sees a and b; with t2 closed nothing is taken and two candidates name none. That is not a fresh
        // conversation, so a send with no session must not pass.
        fixed.claimed = claimed_by_others(&core, "t1", &["t1".into()]);
        assert!(fixed.claimed.is_empty());
        let unsure = locate_with(&t1, &f1, &fixed.inputs(), now);
        assert!(
            matches!(&unsure, Err(LocateFailure::Ambiguous { agent, .. }) if agent == "codex"),
            "{unsure:?}"
        );
        assert_eq!(unsure.unwrap_err().state_line()["state"], "ambiguous");

        // With t2 live, its remembered b is taken and t1 gets a.
        fixed.claimed = claimed_by_others(&core, "t1", &["t1".into(), "t2".into()]);
        assert_eq!(fixed.claimed, HashSet::from([b.clone(), b_id.to_string()]));
        let got = locate_with(&t1, &f1, &fixed.inputs(), now).unwrap();
        assert_eq!(
            (got.path, got.session),
            (PathBuf::from(&a), a_id.to_string())
        );
    }

    #[test]
    fn terminal_records_that_are_not_agents() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("t.json");
        let fixed = Fixed::new(vec![], vec![]);
        let shell = json!({"address": "t4", "argv": ["/bin/zsh"], "pid": 10, "state": "live",
            "foreground": {"argv": ["vim"], "name": "vim", "pid": 11}});
        assert!(matches!(
            locate_with(&shell, &file, &fixed.inputs(), 0),
            Err(LocateFailure::NotAgent(m)) if m.contains("vim")
        ));
        let mut done = term("t5", "codex", 21, "/x");
        done["state"] = json!("finished");
        assert!(matches!(
            locate_with(&done, &file, &fixed.inputs(), 0),
            Err(LocateFailure::NoTerminal(_))
        ));
        // No agent process among its pids yet: no log, and nothing scanned twice.
        let t = term("t6", "claude", 31, "/x");
        let none = locate_with(&t, &file, &fixed.inputs(), 0);
        assert_eq!(
            none,
            Err(LocateFailure::NoProcess {
                agent: "claude".into()
            })
        );
        assert_eq!(none.unwrap_err().state_line()["state"], "no_log");
        assert_eq!(fixed.scans.get(), 1);
    }

    /// A Codex thread id newer than the codex-subagent parent and child (ids are UUIDv7, so time-ordered).
    const NEW_ID: &str = "01a1b512-1f37-7941-98b2-00c2fc7b72f3";

    fn lock(home: &Path, id: &str) -> String {
        home.join(format!("thread-writer-locks/{id}.lock"))
            .to_string_lossy()
            .to_string()
    }

    /// A root rollout for thread `id` beside the parent: its `session_meta` with that id.
    fn new_rollout(home: &Path, parent: &str, id: &str) -> String {
        let text = fs::read_to_string(parent).unwrap();
        let mut meta: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        meta["payload"]["id"] = json!(id);
        let path = home.join(format!(
            "sessions/2026/11/06/rollout-2026-11-06T22-30-00-{id}.jsonl"
        ));
        fs::write(&path, format!("{meta}\n")).unwrap();
        path.to_string_lossy().to_string()
    }

    fn codex_line(home: &Path) -> String {
        format!("codex CODEX_HOME={}", home.display())
    }

    #[test]
    fn codex_new_thread_without_its_log_is_no_log() {
        // Codex 0.167 after `/new`: the old rollout stays open until the old thread unloads, and the new thread has
        // a lock but no rollout yet.
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let home = tmp.path().join("codex-home");
        let (parent, _) = codex_home(&home);
        let file = tmp.path().join("cache/t2.json");
        remember(
            &file,
            root(
                "codex",
                vec![801, 800],
                801,
                &parent,
                PARENT_ID,
                now - 60_000,
            ),
        );
        let procs = vec![proc_(801, 800, at(now - 90_000), &codex_line(&home))];
        let t = term("t2", "codex", 801, "/scratch/codex-subagent");
        let both = Fixed::new(
            procs.clone(),
            vec![parent.clone(), lock(&home, PARENT_ID), lock(&home, NEW_ID)],
        );
        assert!(matches!(
            locate_with(&t, &file, &both.inputs(), now),
            Err(LocateFailure::Ambiguous { agent, .. }) if agent == "codex"
        ));
        assert_eq!(cache::read(&file).root, None, "the old root is forgotten");
        // Once the old thread unloads, the new one is all Codex holds.
        let unloaded = Fixed::new(procs, vec![lock(&home, NEW_ID)]);
        assert_eq!(
            locate_with(&t, &file, &unloaded.inputs(), now),
            Err(LocateFailure::NoLog {
                agent: "codex".into(),
                session: Some(NEW_ID.into()),
            })
        );
    }

    #[test]
    fn codex_several_root_threads_name_none() {
        // Review Focus 1. Both rollouts and locks are open after `/new` and the new thread's first message, and
        // equally after `/resume` back to the older thread while the newer one stays loaded. Nothing tells which
        // one the terminal shows, so neither is the root, even the one remembered.
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let home = tmp.path().join("codex-home");
        let (parent, child) = codex_home(&home);
        let new = new_rollout(&home, &parent, NEW_ID);
        let file = tmp.path().join("cache/t2.json");
        remember(
            &file,
            root(
                "codex",
                vec![801, 800],
                801,
                &parent,
                PARENT_ID,
                now - 60_000,
            ),
        );
        let child_id = "01a1b4a1-dfcb-77e0-8029-0fbb3b65e5ba";
        let procs = vec![proc_(801, 800, at(now - 90_000), &codex_line(&home))];
        let t = term("t2", "codex", 801, "/scratch/codex-subagent");
        let both = Fixed::new(
            procs.clone(),
            vec![
                parent.clone(),
                child.clone(),
                new.clone(),
                lock(&home, PARENT_ID),
                lock(&home, child_id),
                lock(&home, NEW_ID),
            ],
        );
        for remembered in [(&parent, PARENT_ID), (&new, NEW_ID)] {
            remember(
                &file,
                root(
                    "codex",
                    vec![801, 800],
                    801,
                    remembered.0,
                    remembered.1,
                    now - 60_000,
                ),
            );
            let got = locate_with(&t, &file, &both.inputs(), now);
            assert!(
                matches!(&got, Err(LocateFailure::Ambiguous { agent, .. }) if agent == "codex"),
                "{got:?}"
            );
            assert_eq!(got.unwrap_err().state_line()["state"], "ambiguous");
            assert_eq!(cache::read(&file).root, None);
        }
        // The same lock seen twice (two processes of the tree) is one thread.
        let twice = Fixed::new(
            procs.clone(),
            vec![
                new.clone(),
                lock(&home, NEW_ID),
                new.clone(),
                lock(&home, NEW_ID),
            ],
        );
        let got = locate_with(&t, &file, &twice.inputs(), now).unwrap();
        assert_eq!(
            (got.session.as_str(), got.path),
            (NEW_ID, PathBuf::from(&new))
        );
        // A sub-agent's thread is newer than its parent's but is never the root.
        let child_only = Fixed::new(
            procs,
            vec![
                parent.clone(),
                child,
                lock(&home, PARENT_ID),
                lock(&home, child_id),
            ],
        );
        let got = locate_with(&t, &tmp.path().join("t2b.json"), &child_only.inputs(), now).unwrap();
        assert_eq!(
            (got.session.as_str(), got.path),
            (PARENT_ID, PathBuf::from(&parent))
        );
    }

    #[test]
    fn codex_new_thread_rechecks_a_fresh_root() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let home = tmp.path().join("codex-home");
        let (parent, _) = codex_home(&home);
        fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
        let file = tmp.path().join("cache/t2.json");
        // Checked 5 s before the `/new` that adds a lock file.
        let checked = mtime_ms(&home.join("thread-writer-locks")).unwrap() + 1;
        remember(
            &file,
            root("codex", vec![801, 800], 801, &parent, PARENT_ID, checked),
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(lock(&home, NEW_ID), "").unwrap();
        let fixed = Fixed::new(
            vec![proc_(801, 800, at(now - 90_000), &codex_line(&home))],
            vec![parent.clone(), lock(&home, PARENT_ID), lock(&home, NEW_ID)],
        );
        let t = term("t2", "codex", 801, "/scratch/codex-subagent");
        let now = checked + 5_000;
        assert!(locate_with(&t, &file, &fixed.inputs(), now).is_err());
        assert_eq!(
            fixed.scans.get(),
            1,
            "a new thread lock is looked at before 30 s"
        );
    }

    #[test]
    fn recheck_skips_a_fresh_root() {
        let tmp = tempfile::tempdir().unwrap();
        let now = now_ms();
        let home = tmp.path().join("codex-home");
        let (parent, _) = codex_home(&home);
        let file = tmp.path().join("cache/t2.json");
        remember(
            &file,
            root(
                "codex",
                vec![801, 800],
                801,
                &parent,
                PARENT_ID,
                now - 1_000,
            ),
        );
        let fixed = Fixed::new(
            vec![proc_(801, 800, at(now - 90_000), &codex_line(&home))],
            vec![parent.clone(), lock(&home, PARENT_ID), lock(&home, NEW_ID)],
        );
        let t = term("t2", "codex", 801, "/scratch/codex-subagent");
        let mut inputs = fixed.inputs();
        inputs.recheck = true;
        assert!(locate_with(&t, &file, &inputs, now).is_err());
        assert_eq!(
            fixed.scans.get(),
            1,
            "a recheck lists processes even for a fresh root"
        );
    }

    #[test]
    fn state_lines() {
        assert_eq!(
            LocateFailure::NoCore("no hc core is running".into()).state_line(),
            json!({"type": "state", "state": "no_core", "message": "no hc core is running"})
        );
        assert_eq!(
            LocateFailure::NoTerminal("t9 is not a live terminal".into()).state_line(),
            json!({"type": "state", "state": "no_terminal", "message": "t9 is not a live terminal"})
        );
        assert_eq!(
            LocateFailure::NotAgent("t3 runs zsh".into()).state_line(),
            json!({"type": "state", "state": "not_agent", "message": "t3 runs zsh"})
        );
        assert_eq!(
            LocateFailure::NoLog {
                agent: "codex".into(),
                session: None,
            }
            .state_line(),
            json!({"type": "state", "state": "no_log", "agent": "codex", "message": "no codex session log yet"})
        );
        assert_eq!(
            LocateFailure::NoLog {
                agent: "claude".into(),
                session: Some("s1".into()),
            }
            .state_line(),
            json!({"type": "state", "state": "no_log", "agent": "claude", "session": "s1",
                   "message": "no claude session log yet"})
        );
    }
}
