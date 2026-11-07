//! `bw counts`: running sub-agents and waiting requests per terminal, from the cached root, the session tree,
//! the hook events and the logs, with no screen read. Logs and payloads are Task 1's recordings, cut where the
//! prompt showed; `hc get` comes from `tests/fake-hc`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

/// 2026-11-07T00:00:00Z, as `tests/feed.rs` uses.
const NOW_MS: i64 = 1_794_009_600_000;
const CORE: &str = "bw-counts-test";

const CLAUDE_ROOT: &str = "d3435260-916e-4949-b6f1-feb6980fd421";
const CHILD_A: &str = "a84924e78e12c62b3";

fn sessions(s: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/sessions")
        .join(s)
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn json_file(p: &Path) -> Value {
    serde_json::from_str(&read(p)).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// The lines of `text` up to and including the first that contains `needle`, each with its newline.
fn upto(text: &str, needle: &str) -> String {
    let mut out = String::new();
    for l in text.lines() {
        out.push_str(l);
        out.push('\n');
        if l.contains(needle) {
            return out;
        }
    }
    panic!("no line holds {needle:?}");
}

/// The lines of `text` before the first that contains `needle`.
fn before(text: &str, needle: &str) -> String {
    let mut out = String::new();
    for l in text.lines() {
        if l.contains(needle) {
            return out;
        }
        out.push_str(l);
        out.push('\n');
    }
    panic!("no line holds {needle:?}");
}

struct Scratch {
    tmp: tempfile::TempDir,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["gets", "home", "screens"] {
            std::fs::create_dir_all(tmp.path().join(d)).unwrap();
        }
        Scratch { tmp }
    }

    /// The real folder: lsof names files by it.
    fn dir(&self) -> PathBuf {
        self.tmp.path().canonicalize().unwrap()
    }

    fn bw(&self, args: &[&str]) -> (i32, Vec<Value>) {
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
        let out = Command::new(env!("CARGO_BIN_EXE_bw"))
            .args(args)
            .env("BW_HC", fake)
            .env("FAKE_HC_GET_DIR", self.dir().join("gets"))
            .env("FAKE_HC_SCREEN_DIR", self.dir().join("screens"))
            .env("FAKE_HC_LOG", self.dir().join("hc.log"))
            .env("BW_CACHE_DIR", self.dir().join("cache"))
            .env("BW_NOW_MS", NOW_MS.to_string())
            .env("HC_SESSION", CORE)
            .env("HOME", self.dir().join("home"))
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .output()
            .unwrap();
        let lines = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
            .collect();
        (out.status.code().unwrap(), lines)
    }

    fn counts(&self, terminals: &str) -> Vec<Value> {
        let (code, lines) = self.bw(&["counts", "--terminals", terminals]);
        assert_eq!(code, 0, "bw counts {terminals}: {lines:?}");
        lines
    }

    fn hc_log(&self) -> String {
        std::fs::read_to_string(self.dir().join("hc.log")).unwrap_or_default()
    }

    fn claude_root(&self, s: &str, session: &str, root: &str) -> PathBuf {
        let project = self.dir().join(format!("claude/projects/-scratch-{s}"));
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join(format!("{session}.jsonl"));
        std::fs::write(&file, root).unwrap();
        file
    }

    fn claude_child(&self, root: &Path, id: &str, log: &str, meta: &str) {
        let dir = root.with_extension("").join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("agent-{id}.jsonl")), log).unwrap();
        std::fs::write(dir.join(format!("agent-{id}.meta.json")), meta).unwrap();
    }

    fn codex_file(&self, day: &str, name: &str, text: &str) -> PathBuf {
        let dir = self.dir().join("codex-home/sessions").join(day);
        std::fs::create_dir_all(&dir).unwrap();
        let to = dir.join(name);
        std::fs::write(&to, text).unwrap();
        to
    }

    /// Terminal `t` runs `program` with hc `status`, and the cache remembers `log` as its root.
    fn located(&self, t: &str, program: &str, log: &Path, session: &str, status: &Value) {
        std::fs::write(
            self.dir().join(format!("gets/{t}.json")),
            json!({"address": t, "argv": ["/bin/zsh", "-l"], "cwd": "/scratch", "pid": 700, "state": "live",
                   "status": status,
                   "foreground": {"argv": [program], "cwd": "/scratch", "name": program, "pid": 701}})
            .to_string(),
        )
        .unwrap();
        let file = self.dir().join(format!("cache/feeds/{CORE}/{t}.json"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            json!({"version": 1, "feed": null, "root": {"kind": program, "pids": [701, 700], "agent_pid": 701,
                   "path": log.to_string_lossy(), "session": session, "checked_ms": NOW_MS - 1000}})
            .to_string(),
        )
        .unwrap();
    }

    /// The event `bw event` writes for `payload` in terminal `t`.
    fn event(&self, t: &str, agent: &str, n: u32, at_ms: i64, payload: &Value) {
        let id = format!("{at_ms}-1-{n}");
        let text = |k: &str| payload.get(k).and_then(Value::as_str);
        let command = payload.get("tool_input").and_then(|i| {
            i.get("command")
                .or_else(|| i.get("file_path"))
                .and_then(Value::as_str)
                .map(String::from)
                .or_else(|| Some(i.to_string()))
        });
        let e = json!({"v": 1, "id": id, "at_ms": at_ms, "agent": agent, "event": text("hook_event_name"),
            "terminal": t, "core": CORE, "session": text("session_id"), "transcript": text("transcript_path"),
            "agent_id": text("agent_id"), "agent_type": text("agent_type"), "tool": text("tool_name"),
            "command": command, "tool_use_id": text("tool_use_id"), "cwd": text("cwd")});
        let dir = self.dir().join(format!("cache/events/{t}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), e.to_string()).unwrap();
    }
}

fn payload(s: &str, name: &str) -> Value {
    json_file(&sessions(s).join(format!("hooks/{name}.json")))
}

fn status_of(s: &str, case: &str) -> Value {
    json_file(&sessions(s).join(format!("status-{case}.json")))
}

fn count(t: &str, subagents: u64, requests: u64) -> Value {
    json!({"type": "count", "terminal": t, "subagents": subagents, "requests": requests})
}

/// claude-child-approval case (a): the root waits on its Agent call; child a, running, waits on `touch fg.txt`.
fn case_a(x: &Scratch, t: &str, status: &Value) {
    let s = "claude-child-approval";
    let text = read(&sessions(s).join(format!("{CLAUDE_ROOT}.jsonl")));
    let root = x.claude_root(
        s,
        CLAUDE_ROOT,
        &upto(
            &text,
            r#""type":"tool_use","id":"toolu_01Q86suhmwNyr4eS7sqAU87o""#,
        ),
    );
    let child = read(
        &sessions(s)
            .join(CLAUDE_ROOT)
            .join(format!("subagents/agent-{CHILD_A}.jsonl")),
    );
    x.claude_child(
        &root,
        CHILD_A,
        &upto(
            &child,
            r#""type":"tool_use","id":"toolu_01CFkjgfQawSc7F4S41cVRMf""#,
        ),
        &read(&sessions(s).join("running-a.meta.json")),
    );
    x.located(t, "claude", &root, CLAUDE_ROOT, status);
    // The PreToolUse names the call; the PermissionRequest 30 ms later does not.
    x.event(t, "claude", 0, NOW_MS - 1030, &payload(s, "a-PreToolUse-2"));
    x.event(
        t,
        "claude",
        1,
        NOW_MS - 1000,
        &payload(s, "a-PermissionRequest"),
    );
}

#[test]
fn counts_from_tree_and_events() {
    let x = Scratch::new();
    case_a(&x, "t1", &status_of("claude-child-approval", "a"));
    assert_eq!(x.counts("t1"), vec![count("t1", 1, 1)]);
    assert!(
        !x.hc_log().contains("read "),
        "no screen read: {}",
        x.hc_log()
    );
}

/// The root's own Agent call asks too, as if a second prompt queued behind the child's.
fn root_ask(x: &Scratch, t: &str) {
    x.event(
        t,
        "claude",
        2,
        NOW_MS - 900,
        &json!({"hook_event_name": "PermissionRequest", "session_id": CLAUDE_ROOT, "tool_name": "Agent",
                "tool_use_id": "toolu_01Q86suhmwNyr4eS7sqAU87o", "tool_input": {"command": "x"}}),
    );
}

#[test]
fn a_second_open_ask_counts_twice() {
    let x = Scratch::new();
    case_a(&x, "t1", &status_of("claude-child-approval", "a"));
    root_ask(&x, "t1");
    assert_eq!(x.counts("t1"), vec![count("t1", 1, 2)]);
}

#[test]
fn not_blocked_has_no_screen_requests() {
    let x = Scratch::new();
    case_a(&x, "t1", &json!({"app": "claude-code", "state": "working"}));
    assert_eq!(x.counts("t1"), vec![count("t1", 1, 0)]);
}

#[test]
fn blocked_without_events_counts_one() {
    let s = "claude-approval";
    let session = "e186f156-fd30-4aab-a0b6-d3922b281731";
    let x = Scratch::new();
    let text = read(&sessions(s).join(format!("{session}.jsonl")));
    let root = x.claude_root(
        s,
        session,
        &upto(
            &text,
            r#""type":"tool_use","id":"toolu_01SGHovZaso4tVTRPTHPkAEF""#,
        ),
    );
    x.located(
        "t1",
        "claude",
        &root,
        session,
        &json!({"app": "claude-code", "kind": "permission", "state": "blocked"}),
    );
    assert_eq!(x.counts("t1"), vec![count("t1", 0, 1)]);
}

#[test]
fn answered_ask_is_not_counted() {
    let x = Scratch::new();
    case_a(&x, "t1", &json!({"app": "claude-code", "state": "blocked"}));
    root_ask(&x, "t1");
    assert_eq!(x.counts("t1"), vec![count("t1", 1, 2)]);
    // The child's whole log: its Bash call has its result, and the child finished.
    let s = "claude-child-approval";
    let dir = x.dir().join(format!(
        "claude/projects/-scratch-{s}/{CLAUDE_ROOT}/subagents"
    ));
    std::fs::write(
        dir.join(format!("agent-{CHILD_A}.jsonl")),
        read(
            &sessions(s)
                .join(CLAUDE_ROOT)
                .join(format!("subagents/agent-{CHILD_A}.jsonl")),
        ),
    )
    .unwrap();
    // Only the root's ask is still open.
    assert_eq!(x.counts("t1"), vec![count("t1", 1, 1)]);
    std::fs::write(
        dir.join(format!("agent-{CHILD_A}.meta.json")),
        read(
            &sessions(s)
                .join(CLAUDE_ROOT)
                .join(format!("subagents/agent-{CHILD_A}.meta.json")),
        ),
    )
    .unwrap();
    assert_eq!(x.counts("t1"), vec![count("t1", 0, 1)]);
}

#[test]
fn async_question_counts() {
    let s = "codex-question";
    let name = "rollout-2026-11-06T22-11-44-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl";
    let session = "01a1b4a2-6731-7140-87be-4960d8a7aefe";
    let x = Scratch::new();
    let text = read(&sessions(s).join(name));
    let root = x.codex_file("2026/11/06", name, &before(&text, r#""text":"large""#));
    x.located(
        "t2",
        "codex",
        &root,
        session,
        &json!({"app": "codex", "state": "idle"}),
    );
    assert_eq!(x.counts("t2"), vec![count("t2", 0, 1)]);
    std::fs::write(&root, &text).unwrap();
    assert_eq!(x.counts("t2"), vec![count("t2", 0, 0)]);
}

#[test]
fn unknown_terminal_is_zero() {
    let x = Scratch::new();
    case_a(&x, "t1", &status_of("claude-child-approval", "a"));
    std::fs::write(
        x.dir().join("gets/t9.json"),
        json!({"address": "t9", "argv": ["/bin/zsh", "-l"], "cwd": "/scratch", "pid": 900, "state": "live",
               "status": null, "foreground": {"argv": ["vim"], "cwd": "/scratch", "name": "vim", "pid": 901}})
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        x.counts("t4,t1,t9,macmini/t1"),
        vec![
            count("t4", 0, 0),
            count("t1", 1, 1),
            count("t9", 0, 0),
            count("macmini/t1", 0, 0),
        ]
    );
}

#[test]
fn usage_needs_terminals_and_caps_them() {
    let x = Scratch::new();
    let (code, lines) = x.bw(&["counts"]);
    assert_eq!((code, lines[0]["code"].clone()), (2, json!("usage")));
    let many: Vec<String> = (0..65).map(|i| format!("t{i}")).collect();
    let (code, lines) = x.bw(&["counts", "--terminals", &many.join(",")]);
    assert_eq!(
        (code, lines[0]["code"].clone()),
        (2, json!("usage")),
        "{lines:?}"
    );
    let (code, lines) = x.bw(&["counts", "--terminals", "t1,,t2"]);
    assert_eq!(
        (code, lines[0]["code"].clone()),
        (2, json!("usage")),
        "{lines:?}"
    );
}
