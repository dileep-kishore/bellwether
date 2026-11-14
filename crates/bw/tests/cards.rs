//! `bw cards` and `bw feed --cards`: the requests of a terminal's session and its sub-agents, from the screens,
//! logs and hook payloads Task 1 recorded. Each case cuts the recorded logs where the prompt showed, so the call
//! that asks has no result yet, and serves the saved screen and `hc get` status through `tests/fake-hc`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// 2026-11-07T00:00:00Z, as `tests/feed.rs` uses.
const NOW_MS: i64 = 1_794_009_600_000;
const CORE: &str = "bw-cards-test";

const CLAUDE_ROOT: &str = "d3435260-916e-4949-b6f1-feb6980fd421";
const CHILD_A: &str = "a84924e78e12c62b3";
const CODEX_ROOT: &str = "01a1b589-9d51-7273-946e-30423f02bb68";
const CODEX_CHILD: &str = "01a1b58a-29ac-7de0-b175-10c76abdafbb";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn sessions(s: &str) -> PathBuf {
    fixtures().join("sessions").join(s)
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

/// `<sessions>/YYYY/MM/DD` for `rollout-YYYY-MM-DDThh-mm-ss-<id>.jsonl`.
fn codex_day(sessions_dir: &Path, name: &str) -> PathBuf {
    let date = &name["rollout-".len().."rollout-YYYY-MM-DD".len()];
    let mut p = sessions_dir.to_path_buf();
    for part in date.split('-') {
        p.push(part);
    }
    p
}

struct Scratch {
    tmp: tempfile::TempDir,
    now: i64,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["gets", "home", "screens"] {
            std::fs::create_dir_all(tmp.path().join(d)).unwrap();
        }
        Scratch { tmp, now: NOW_MS }
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
            .env("BW_NOW_MS", self.now.to_string())
            .env("BW_TZ", "UTC")
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

    fn ok(&self, args: &[&str]) -> Vec<Value> {
        let (code, lines) = self.bw(args);
        assert_eq!(code, 0, "bw {args:?}: {lines:?}");
        lines
    }

    fn cards(&self, t: &str) -> Vec<Value> {
        self.ok(&["cards", "--terminal", t])
    }

    fn hc_log(&self) -> String {
        std::fs::read_to_string(self.dir().join("hc.log")).unwrap_or_default()
    }

    /// The Claude recording `s` under `<scratch>/claude/projects/-scratch-<s>/`, with the root log as `root`
    /// gives it and no sub-agents yet.
    fn claude_root(&self, s: &str, session: &str, root: &str) -> PathBuf {
        let project = self.dir().join(format!("claude/projects/-scratch-{s}"));
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join(format!("{session}.jsonl"));
        std::fs::write(&file, root).unwrap();
        file
    }

    /// Child `id` of the Claude root at `root`: its log as given and its meta file.
    fn claude_child(&self, root: &Path, id: &str, log: &str, meta: &str) {
        let dir = root.with_extension("").join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("agent-{id}.jsonl")), log).unwrap();
        std::fs::write(dir.join(format!("agent-{id}.meta.json")), meta).unwrap();
    }

    /// A Codex rollout under `<scratch>/codex-home/sessions/YYYY/MM/DD/<name>`, holding `text`.
    fn codex_file(&self, name: &str, text: &str) -> PathBuf {
        let to = codex_day(&self.dir().join("codex-home/sessions"), name).join(name);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::write(&to, text).unwrap();
        to
    }

    /// Terminal `t` runs `program` with hc `status`, and the cache remembers `log` as its root.
    fn located(&self, t: &str, program: &str, log: &Path, session: &str, status: &Value) {
        self.get(t, program, 700, status);
        let file = self.dir().join(format!("cache/feeds/{CORE}/{t}.json"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            json!({"version": 1, "feed": null, "root": {"kind": program, "pids": [701, 700], "agent_pid": 701,
                   "path": log.to_string_lossy(), "session": session, "checked_ms": self.now - 1000}})
            .to_string(),
        )
        .unwrap();
    }

    /// `hc get <t>`: a shell (pid `pid`) running `program` (pid `pid + 1`) with hc `status`.
    fn get(&self, t: &str, program: &str, pid: u32, status: &Value) {
        std::fs::write(
            self.dir().join(format!("gets/{t}.json")),
            json!({"address": t, "argv": ["/bin/zsh", "-l"], "cwd": "/scratch", "pid": pid, "state": "live",
                   "status": status,
                   "foreground": {"argv": [program], "cwd": "/scratch", "name": program, "pid": pid + 1}})
            .to_string(),
        )
        .unwrap();
    }

    fn status(&self, t: &str, status: &Value) {
        let file = self.dir().join(format!("gets/{t}.json"));
        let mut v = json_file(&file);
        v["status"] = status.clone();
        std::fs::write(file, v.to_string()).unwrap();
    }

    /// What `hc read <t>` shows; None: the read fails.
    fn screen(&self, t: &str, text: Option<&str>) {
        let file = self.dir().join(format!("screens/{t}.txt"));
        match text {
            Some(s) => std::fs::write(file, s).unwrap(),
            None => {
                let _ = std::fs::remove_file(file);
            }
        }
    }

    /// The event `bw event` writes for `payload` in terminal `t`, with a fixed id so outputs stay the same.
    fn event(&self, t: &str, agent: &str, n: u32, at_ms: i64, payload: &Value) -> String {
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
        id
    }

    fn store(&self, t: &str) -> Value {
        json_file(&self.dir().join(format!("cache/requests/{CORE}/{t}.json")))
    }
}

fn lines_of<'a>(lines: &'a [Value], kind: &str) -> Vec<&'a Value> {
    lines.iter().filter(|l| l["type"] == kind).collect()
}

fn one<'a>(lines: &'a [Value], kind: &str) -> &'a Value {
    let found = lines_of(lines, kind);
    assert_eq!(found.len(), 1, "one {kind} line in {lines:#?}");
    found[0]
}

fn action_ids(r: &Value) -> Vec<String> {
    r["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap().to_string())
        .collect()
}

fn status_of(s: &str, case: &str) -> Value {
    json_file(&sessions(s).join(format!("status-{case}.json")))
}

fn payload(s: &str, name: &str) -> Value {
    json_file(&sessions(s).join(format!("hooks/{name}.json")))
}

const WORKING: &str = r#"{"app":"claude-code","state":"working"}"#;

fn working() -> Value {
    serde_json::from_str(WORKING).unwrap()
}

/// claude-approval as it was while its prompt showed: the Bash call has no result yet.
fn claude_approval(x: &Scratch) -> PathBuf {
    let s = "claude-approval";
    let session = "e186f156-fd30-4aab-a0b6-d3922b281731";
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
        &json!({"app": "claude-code", "kind": "permission", "msg": "approve Bash: touch approved.txt",
                "state": "blocked"}),
    );
    x.screen("t1", Some(&read(&sessions(s).join("screen-approval.txt"))));
    root
}

fn claude_child_dir() -> PathBuf {
    sessions("claude-child-approval").join(CLAUDE_ROOT)
}

fn claude_child_log(id: &str) -> String {
    read(&claude_child_dir().join(format!("subagents/agent-{id}.jsonl")))
}

/// claude-child-approval case (a): the root waits on its Agent call, child a waits on `touch fg.txt`.
/// `child_lines`: how much of the child's log was written (None: up to its Bash call).
fn case_a(x: &Scratch, child_log: Option<String>) -> PathBuf {
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
    let log = child_log.unwrap_or_else(|| {
        upto(
            &claude_child_log(CHILD_A),
            r#""type":"tool_use","id":"toolu_01CFkjgfQawSc7F4S41cVRMf""#,
        )
    });
    x.claude_child(
        &root,
        CHILD_A,
        &log,
        &read(&sessions(s).join("running-a.meta.json")),
    );
    x.located("t1", "claude", &root, CLAUDE_ROOT, &status_of(s, "a"));
    x.screen("t1", Some(&read(&sessions(s).join("screen-a.txt"))));
    root
}

/// The hook events of case (a), each at the time Task 1's note gives: PreToolUse 30 ms before PermissionRequest.
fn case_a_events(x: &Scratch) -> String {
    let s = "claude-child-approval";
    x.event("t1", "claude", 0, x.now - 4000, &payload(s, "a-PreToolUse"));
    x.event(
        "t1",
        "claude",
        1,
        x.now - 3990,
        &payload(s, "a-SubagentStart"),
    );
    x.event(
        "t1",
        "claude",
        2,
        x.now - 1030,
        &payload(s, "a-PreToolUse-2"),
    );
    x.event(
        "t1",
        "claude",
        3,
        x.now - 1000,
        &payload(s, "a-PermissionRequest"),
    )
}

fn who_child(r: &Value) -> &Value {
    &r["who"]["child"]
}

#[test]
fn root_approval_is_pending_with_its_tool_use_id() {
    let x = Scratch::new();
    let root = claude_approval(&x);
    let lines = x.cards("t1");
    let cards = one(&lines, "cards");
    assert_eq!(lines[0]["type"], "cards", "{lines:?}");
    assert_eq!(cards["terminal"], "t1");
    assert_eq!(cards["agent"], "claude");
    assert_eq!(cards["session"], "e186f156-fd30-4aab-a0b6-d3922b281731");
    assert_eq!(cards["path"], root.to_string_lossy().as_ref());
    assert_eq!(cards["status"], "blocked");
    assert_eq!(cards["status_kind"], "permission");
    assert_eq!(cards["hooks"], "missing");
    assert_eq!(cards["screen"], "read");
    let r = one(&lines, "request");
    assert!(r["id"].as_str().unwrap().starts_with("r3."), "{r}");
    assert_eq!(r["kind"], "approval");
    assert_eq!(r["state"], "pending");
    assert_eq!(r["answerable"], true);
    assert_eq!(r["reason"], Value::Null);
    assert_eq!(r["who"], Value::Null);
    assert_eq!(r["tool"], "Bash");
    assert_eq!(r["command"], "touch approved.txt");
    assert_eq!(r["detail"], "Create empty file approved.txt");
    assert_eq!(r["tool_use_id"], "toolu_01SGHovZaso4tVTRPTHPkAEF");
    assert_eq!(r["event"], Value::Null);
    assert_eq!(action_ids(r), ["approve", "always", "deny"]);
    assert_eq!(
        r["actions"][1]["label"],
        "Yes, and always allow access to /scratch/claude-approval from this project"
    );
    assert!(r["screen_id"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(r["at_ms"], NOW_MS);
    assert_eq!(r["resolved_ms"], Value::Null);
    assert!(x.hc_log().contains("read t1"), "{}", x.hc_log());
}

#[test]
fn child_approval_sits_under_its_child() {
    let x = Scratch::new();
    case_a(&x, None);
    let pr = case_a_events(&x);
    let lines = x.cards("t1");
    let r = one(&lines, "request");
    assert_eq!(r["state"], "pending", "{r}");
    assert_eq!(
        r["who"],
        json!({"child": CHILD_A, "agent_type": "toucher", "description": "Touch fg.txt file", "depth": 1})
    );
    assert_eq!(r["event"], pr.as_str());
    assert_eq!(r["tool_use_id"], "toolu_01CFkjgfQawSc7F4S41cVRMf");
    assert_eq!(r["command"], "touch fg.txt");
    assert_eq!(r["answerable"], true);
}

#[test]
fn child_approval_with_its_header_off_screen_sits_under_its_child() {
    // The same call drawn in a 15-column terminal whose box lost its header off the top: the hook's call and the
    // child's log still match it by command, and the card names the tool they give.
    let x = Scratch::new();
    case_a(&x, None);
    let pr = case_a_events(&x);
    x.screen(
        "t1",
        Some(&read(
            &fixtures().join("screens/claude-approval-headcut-15.txt"),
        )),
    );
    let lines = x.cards("t1");
    let r = one(&lines, "request");
    assert_eq!(r["state"], "pending", "{r}");
    assert_eq!(*who_child(r), CHILD_A, "{r}");
    assert_eq!(r["event"], pr.as_str());
    assert_eq!(r["tool_use_id"], "toolu_01CFkjgfQawSc7F4S41cVRMf");
    assert_eq!(r["tool"], "Bash");
    assert_eq!(r["answerable"], true);
}

#[test]
fn child_found_from_its_log_without_hooks() {
    let x = Scratch::new();
    case_a(&x, None);
    let lines = x.cards("t1");
    assert_eq!(one(&lines, "cards")["hooks"], "missing");
    let r = one(&lines, "request");
    assert_eq!(*who_child(r), CHILD_A, "{r}");
    assert_eq!(r["event"], Value::Null);
    assert_eq!(r["tool_use_id"], "toolu_01CFkjgfQawSc7F4S41cVRMf");
}

#[test]
fn event_gives_the_tool_use_id_while_the_log_lags() {
    // The child's log has not reached its Bash call yet: the PreToolUse paired with the request names it.
    let x = Scratch::new();
    let log = before(
        &claude_child_log(CHILD_A),
        r#""type":"tool_use","id":"toolu_01CFkjgfQawSc7F4S41cVRMf""#,
    );
    case_a(&x, Some(log));
    let pr = case_a_events(&x);
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(*who_child(&r), CHILD_A, "{r}");
    assert_eq!(r["event"], pr.as_str());
    assert_eq!(r["tool_use_id"], "toolu_01CFkjgfQawSc7F4S41cVRMf");
}

#[test]
fn helper_agent_events_are_ignored() {
    // Claude's own agents send events with an empty agent_type: they never name who asks.
    let x = Scratch::new();
    case_a(&x, None);
    let mut p = payload("claude-child-approval", "a-PermissionRequest");
    p["agent_id"] = json!("a00000000000000ff");
    p["agent_type"] = json!("");
    x.event("t1", "claude", 9, x.now - 500, &p);
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(*who_child(&r), CHILD_A, "{r}");
    assert_eq!(r["event"], Value::Null);
}

#[test]
fn two_children_same_command_bind_one_box() {
    // Review Focus 2: one box on screen, two children asking the same command. One card answers the box and
    // names both; no key depends on which child asked.
    const OTHER: &str = "a00000000000000c2";
    let x = Scratch::new();
    let root = case_a(&x, None);
    let s = "claude-child-approval";
    let mut meta = json_file(&sessions(s).join("running-a.meta.json"));
    meta["description"] = json!("Touch fg.txt again");
    meta["toolUseId"] = json!("toolu_0000000000000000000000c2");
    let log = upto(
        &claude_child_log(CHILD_A),
        r#""type":"tool_use","id":"toolu_01CFkjgfQawSc7F4S41cVRMf""#,
    )
    .replace(
        "toolu_01CFkjgfQawSc7F4S41cVRMf",
        "toolu_0000000000000000000000d2",
    );
    x.claude_child(&root, OTHER, &log, &meta.to_string());
    case_a_events(&x);
    let mut pre = payload(s, "a-PreToolUse-2");
    pre["agent_id"] = json!(OTHER);
    pre["tool_use_id"] = json!("toolu_0000000000000000000000d2");
    x.event("t1", "claude", 4, x.now - 830, &pre);
    let mut pr = payload(s, "a-PermissionRequest");
    pr["agent_id"] = json!(OTHER);
    x.event("t1", "claude", 5, x.now - 800, &pr);
    let lines = x.cards("t1");
    let r = one(&lines, "request");
    let who = r["who"]
        .as_array()
        .unwrap_or_else(|| panic!("who is a list: {r}"));
    let mut ids: Vec<&str> = who.iter().map(|w| w["child"].as_str().unwrap()).collect();
    ids.sort_unstable();
    assert_eq!(ids, [OTHER, CHILD_A]);
    assert_eq!(r["answerable"], true);
    assert_eq!(action_ids(r), ["approve", "always", "deny"]);
}

#[test]
fn box_gone_with_result_is_answered_terminal() {
    let x = Scratch::new();
    let root = case_a(&x, None);
    let first = one(&x.cards("t1"), "request")["id"].clone();
    let mut x = x;
    x.now += 2000;
    x.claude_child(
        &root,
        CHILD_A,
        &claude_child_log(CHILD_A),
        &read(&sessions("claude-child-approval").join("running-a.meta.json")),
    );
    x.status("t1", &working());
    let lines = x.cards("t1");
    assert_eq!(one(&lines, "cards")["screen"], "unread");
    let r = one(&lines, "request");
    assert_eq!(r["id"], first);
    assert_eq!(r["state"], "answered_terminal", "{r}");
    assert_eq!(r["resolved_ms"], NOW_MS + 2000);
    assert_eq!(r["answerable"], false);
    assert_eq!(*who_child(r), CHILD_A);
}

#[test]
fn box_gone_with_rejection_is_declined_terminal() {
    let s = "claude-child-approval";
    let x = Scratch::new();
    let text = read(&sessions(s).join(format!("{CLAUDE_ROOT}.jsonl")));
    let asks = r#""type":"tool_use","id":"toolu_016G39y7PGT2AkDvsE2rcPrf""#;
    let root = x.claude_root(s, CLAUDE_ROOT, &upto(&text, asks));
    x.located("t1", "claude", &root, CLAUDE_ROOT, &status_of(s, "c-esc"));
    x.screen("t1", Some(&read(&sessions(s).join("screen-c-esc.txt"))));
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(r["state"], "pending");
    assert_eq!(r["who"], Value::Null, "{r}");
    assert_eq!(r["tool_use_id"], "toolu_016G39y7PGT2AkDvsE2rcPrf");
    let mut x = x;
    x.now += 2000;
    std::fs::write(
        &root,
        upto(&text, r#""tool_use_id":"toolu_016G39y7PGT2AkDvsE2rcPrf""#),
    )
    .unwrap();
    x.status("t1", &json!({"app": "claude-code", "state": "idle"}));
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(r["state"], "declined_terminal", "{r}");
}

#[test]
fn box_gone_before_its_result_settles_then_answered_terminal() {
    // The live Task 12 run: a pass right after the box left, before Claude logged the call's result.
    let mut x = Scratch::new();
    let root = claude_approval(&x);
    let first = one(&x.cards("t1"), "request").clone();
    assert_eq!(first["state"], "pending");
    x.now += 2000;
    x.status("t1", &working());
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(r["id"], first["id"]);
    assert_eq!(r["state"], "settling", "{r}");
    assert_eq!(r["answerable"], false);
    assert_eq!(r["reason"], Value::Null);
    assert_eq!(r["resolved_ms"], Value::Null);
    x.now += 2000;
    let text =
        read(&sessions("claude-approval").join("e186f156-fd30-4aab-a0b6-d3922b281731.jsonl"));
    std::fs::write(
        &root,
        upto(
            &text,
            r#""type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01SGHovZaso4tVTRPTHPkAEF""#,
        ),
    )
    .unwrap();
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(r["id"], first["id"]);
    assert_eq!(r["state"], "answered_terminal", "{r}");
    assert_eq!(r["resolved_ms"], NOW_MS + 4000);
}

#[test]
fn box_gone_without_result_for_5_s_is_stale() {
    let mut x = Scratch::new();
    case_a(&x, None);
    let first = one(&x.cards("t1"), "request")["id"].clone();
    x.now += 2000;
    x.status("t1", &working());
    assert_eq!(one(&x.cards("t1"), "request")["state"], "settling");
    x.now = NOW_MS + 2000 + 4999;
    assert_eq!(one(&x.cards("t1"), "request")["state"], "settling");
    x.now = NOW_MS + 2000 + 5000;
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(r["id"], first);
    assert_eq!(r["state"], "stale", "{r}");
    assert_eq!(r["resolved_ms"], NOW_MS + 7000);
}

#[test]
fn settling_box_is_never_answerable_again() {
    // The same box back on screen while the old one settles is a new occurrence; the old one stays shut.
    let mut x = Scratch::new();
    claude_approval(&x);
    let first = one(&x.cards("t1"), "request").clone();
    let blocked = json_file(&x.dir().join("gets/t1.json"))["status"].clone();
    x.now += 2000;
    x.status("t1", &working());
    assert_eq!(one(&x.cards("t1"), "request")["state"], "settling");
    x.now += 1000;
    x.status("t1", &blocked);
    let lines = x.cards("t1");
    let reqs = lines_of(&lines, "request");
    assert_eq!(reqs.len(), 2, "{lines:#?}");
    let old = reqs.iter().find(|r| r["id"] == first["id"]).unwrap();
    assert_eq!(old["state"], "settling", "{old}");
    assert_eq!(old["answerable"], false);
    let again = reqs.iter().find(|r| r["id"] != first["id"]).unwrap();
    assert_eq!(again["state"], "pending");
    assert_eq!(again["answerable"], true);
    x.now += 5000;
    let lines = x.cards("t1");
    let old = lines_of(&lines, "request")
        .into_iter()
        .find(|r| r["id"] == first["id"])
        .unwrap();
    assert_eq!(old["state"], "stale", "{old}");
}

#[test]
fn unreadable_screen_keeps_the_request_as_it_was() {
    // A read that failed is no evidence the box left.
    let x = Scratch::new();
    claude_approval(&x);
    let first = one(&x.cards("t1"), "request").clone();
    x.screen("t1", None);
    let lines = x.cards("t1");
    assert_eq!(one(&lines, "cards")["screen"], "failed");
    let r = one(&lines, "request");
    assert_eq!(r["id"], first["id"]);
    assert_eq!(r["state"], "pending");
}

#[test]
fn same_box_at_two_reads_is_one_occurrence() {
    let mut x = Scratch::new();
    claude_approval(&x);
    let a = one(&x.cards("t1"), "request").clone();
    x.now += 2000;
    let b = one(&x.cards("t1"), "request").clone();
    assert_eq!(a["id"], b["id"]);
    assert_eq!(b["state"], "pending");
    assert_eq!(b["at_ms"], NOW_MS);
    // Seen absent once, the same box is a new occurrence.
    x.now += 2000;
    let blocked = json_file(&x.dir().join("gets/t1.json"))["status"].clone();
    x.status("t1", &working());
    let gone = one(&x.cards("t1"), "request").clone();
    assert_eq!(gone["id"], a["id"]);
    assert_eq!(gone["state"], "settling");
    x.now += 2000;
    x.status("t1", &blocked);
    let lines = x.cards("t1");
    let reqs = lines_of(&lines, "request");
    assert_eq!(reqs.len(), 2, "{lines:#?}");
    let again = reqs.iter().find(|r| r["state"] == "pending").unwrap();
    assert_ne!(again["id"], a["id"]);
    assert_eq!(again["at_ms"], NOW_MS + 6000);
}

#[test]
fn async_question_pending_then_answered_terminal() {
    let s = "codex-question";
    let name = "rollout-2026-11-06T22-11-44-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl";
    let session = "01a1b4a2-6731-7140-87be-4960d8a7aefe";
    let mut x = Scratch::new();
    let text = read(&sessions(s).join(name));
    let root = x.codex_file(name, &before(&text, r#""text":"large""#));
    x.located(
        "t2",
        "codex",
        &root,
        session,
        &json!({"app": "codex", "state": "working"}),
    );
    let lines = x.cards("t2");
    assert_eq!(one(&lines, "cards")["screen"], "unread");
    let r = one(&lines, "request");
    assert_eq!(r["kind"], "question_async");
    assert_eq!(r["state"], "pending");
    assert_eq!(r["answerable"], true);
    assert_eq!(r["tool_use_id"], "call_261068c0a529492d8d12899f3b5edeb9");
    assert_eq!(r["question"]["delivery"], "message");
    assert_eq!(r["question"]["questions"][0]["text"], "Which size?");
    assert_eq!(r["actions"], json!([]));
    let id = r["id"].clone();
    x.now += 2000;
    std::fs::write(&root, &text).unwrap();
    let r = one(&x.cards("t2"), "request").clone();
    assert_eq!(r["id"], id);
    assert_eq!(r["state"], "answered_terminal", "{r}");
    assert_eq!(r["resolved_ms"], NOW_MS + 2000);
}

/// codex-child-approval up to `asks` in the root (each later line not yet written).
fn codex_case(x: &Scratch, asks: &str, case: &str) -> PathBuf {
    let s = "codex-child-approval";
    let name = format!("rollout-2026-11-07T02-24-17-{CODEX_ROOT}.jsonl");
    let root = x.codex_file(&name, &upto(&read(&sessions(s).join(&name)), asks));
    x.located("t3", "codex", &root, CODEX_ROOT, &status_of(s, case));
    x.screen(
        "t3",
        Some(&read(&sessions(s).join(format!("screen-{case}.txt")))),
    );
    root
}

#[test]
fn codex_root_approval_is_answerable() {
    let s = "codex-child-approval";
    let x = Scratch::new();
    codex_case(
        &x,
        r#""call_id":"call_531dd63fb7d24c459c54727c21db2eea""#,
        "d-y",
    );
    x.event(
        "t3",
        "codex",
        0,
        x.now - 1030,
        &payload(s, "d-y-PreToolUse"),
    );
    let pr = x.event(
        "t3",
        "codex",
        1,
        x.now - 1000,
        &payload(s, "d-y-PermissionRequest"),
    );
    let lines = x.cards("t3");
    let cards = one(&lines, "cards");
    assert_eq!(cards["agent"], "codex");
    assert_eq!(cards["status"], "blocked");
    let r = one(&lines, "request");
    assert_eq!(r["kind"], "approval");
    assert_eq!(r["state"], "pending");
    assert_eq!(r["answerable"], true);
    assert_eq!(r["who"], Value::Null);
    assert_eq!(r["command"], "touch d-y.txt");
    assert_eq!(action_ids(r), ["approve", "always", "deny"]);
    assert_eq!(r["event"], pr.as_str());
    // The log's call id, which Codex's PreToolUse (`exec-…`) does not carry.
    assert_eq!(r["tool_use_id"], "call_531dd63fb7d24c459c54727c21db2eea");
}

#[test]
fn codex_child_approval_follows_the_constant() {
    // Decision 12: answerable exactly when `CODEX_CHILD_ANSWERABLE` is true.
    let answerable = include_str!("../src/requests/matchers.rs")
        .contains("pub const CODEX_CHILD_ANSWERABLE: bool = true;");
    let s = "codex-child-approval";
    let x = Scratch::new();
    codex_case(
        &x,
        r#""call_id":"call_a640cd369d26472192cc52caf1ebaeb0""#,
        "e",
    );
    let child = format!("rollout-2026-11-07T02-24-53-{CODEX_CHILD}.jsonl");
    x.codex_file(
        &child,
        &upto(
            &read(&sessions(s).join(&child)),
            r#""call_id":"call_7a91eda49cd4472cbdb8d39940be5c54""#,
        ),
    );
    x.event(
        "t3",
        "codex",
        0,
        x.now - 5000,
        &payload(s, "e-PreToolUse-2"),
    );
    x.event(
        "t3",
        "codex",
        1,
        x.now - 4900,
        &payload(s, "e-SubagentStart"),
    );
    x.event(
        "t3",
        "codex",
        2,
        x.now - 1030,
        &payload(s, "e-PreToolUse-4"),
    );
    let pr = x.event(
        "t3",
        "codex",
        3,
        x.now - 1000,
        &payload(s, "e-PermissionRequest"),
    );
    let lines = x.cards("t3");
    let r = one(&lines, "request");
    assert_eq!(*who_child(r), CODEX_CHILD, "{r}");
    assert_eq!(r["who"]["agent_type"], "run_touch_child");
    assert_eq!(r["who"]["depth"], 1);
    assert_eq!(r["event"], pr.as_str());
    assert_eq!(r["tool_use_id"], "call_7a91eda49cd4472cbdb8d39940be5c54");
    assert_eq!(r["answerable"], answerable);
    assert_eq!(
        r["reason"],
        if answerable {
            Value::Null
        } else {
            json!("codex_child")
        }
    );
}

/// A process named `codex` holding `files` open, as Codex 0.167 holds its rollouts and thread locks.
struct FakeCodex(Child);

impl FakeCodex {
    fn start(dir: &Path, home: &Path, files: &[PathBuf]) -> FakeCodex {
        let script = dir.join("bin/codex");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(
            &script,
            "#!/bin/sh\nfd=3\nfor f; do eval \"exec $fd<\\\"\\$f\\\"\"; fd=$((fd + 1)); done\n: > \"$READY\"\nwhile :; do sleep 1; done\n",
        )
        .unwrap();
        let ready = dir.join("codex-ready");
        let _ = std::fs::remove_file(&ready);
        let child = Command::new("/bin/sh")
            .arg(&script)
            .args(files)
            .env("CODEX_HOME", home)
            .env("READY", &ready)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready.exists(), "the fake codex never opened its files");
        FakeCodex(child)
    }

    /// Terminal `t7` runs this process with hc `status`.
    fn terminal(&self, x: &Scratch, status: &Value) {
        let pid = self.0.id();
        std::fs::write(
            x.dir().join("gets/t7.json"),
            json!({"address": "t7", "argv": ["codex"], "cwd": "/scratch", "pid": pid,
                   "state": "live", "status": status,
                   "foreground": {"argv": ["codex"], "name": "codex", "pid": pid}})
            .to_string(),
        )
        .unwrap();
    }
}

impl Drop for FakeCodex {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const NEW: &str = "01a1b512-1f37-7941-98b2-00c2fc7b72f3";

/// A fresh Codex in `t7`: a thread lock and no rollout, so `no_log` naming `NEW`.
fn fresh_codex(x: &Scratch, status: &Value) -> FakeCodex {
    let home = x.dir().join("codex-home");
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let lock = home.join(format!("thread-writer-locks/{NEW}.lock"));
    std::fs::write(&lock, "").unwrap();
    let codex = FakeCodex::start(&x.dir(), &home, &[lock]);
    codex.terminal(x, status);
    codex
}

#[test]
fn folder_prompt_card_while_the_new_root_has_no_log() {
    let x = Scratch::new();
    let _codex = fresh_codex(&x, &json!({"app": "codex", "state": "idle"}));
    x.screen(
        "t7",
        Some(&read(&fixtures().join("screens/codex-new-folder.txt"))),
    );
    for args in [
        vec!["cards", "--terminal", "t7"],
        vec![
            "feed",
            "--terminal",
            "t7",
            "--cards",
            "--tree",
            "--pictures",
        ],
    ] {
        let lines = x.ok(&args);
        assert_eq!(lines.len(), 3, "{args:?}: {lines:#?}");
        assert_eq!(lines[0]["type"], "state");
        assert_eq!(lines[0]["state"], "no_log");
        assert_eq!(lines[0]["session"], NEW);
        let cards = &lines[1];
        assert_eq!(cards["type"], "cards");
        assert_eq!(cards["session"], NEW);
        assert_eq!(cards["path"], Value::Null);
        assert_eq!(cards["status"], "idle");
        assert_eq!(cards["screen"], "read");
        let r = &lines[2];
        assert_eq!(r["kind"], "prompt", "{r}");
        assert_eq!(r["state"], "pending");
        assert_eq!(r["answerable"], true);
        assert_eq!(r["who"], Value::Null);
        assert_eq!(r["tool"], "new_conversation");
        assert_eq!(r["command"], "");
        assert_eq!(
            r["actions"],
            json!([{"id": "option-1", "label": "Use current Git worktree"},
                   {"id": "option-2", "label": "Create new Git worktree"}])
        );
    }
}

#[test]
fn ambiguous_root_gives_show_only_cards() {
    let s = "codex-child-approval";
    let x = Scratch::new();
    let home = x.dir().join("codex-home");
    let name = format!("rollout-2026-11-07T02-24-17-{CODEX_ROOT}.jsonl");
    let text = read(&sessions(s).join(&name));
    let root = x.codex_file(
        &name,
        &upto(
            &text,
            r#""call_id":"call_531dd63fb7d24c459c54727c21db2eea""#,
        ),
    );
    let mut meta: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    meta["payload"]["id"] = json!(NEW);
    let newer = root
        .parent()
        .unwrap()
        .join(format!("rollout-2026-11-07T02-30-00-{NEW}.jsonl"));
    std::fs::write(&newer, format!("{meta}\n")).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let mut files = vec![root.clone(), newer];
    for id in [CODEX_ROOT, NEW] {
        let lock = home.join(format!("thread-writer-locks/{id}.lock"));
        std::fs::write(&lock, "").unwrap();
        files.push(lock);
    }
    let codex = FakeCodex::start(&x.dir(), &home, &files);
    codex.terminal(&x, &status_of(s, "d-y"));
    x.screen("t7", Some(&read(&sessions(s).join("screen-d-y.txt"))));
    let lines = x.cards("t7");
    assert_eq!(lines[0]["state"], "ambiguous", "{lines:#?}");
    assert_eq!(one(&lines, "cards")["session"], Value::Null);
    let r = one(&lines, "request");
    assert_eq!(r["kind"], "approval");
    assert_eq!(r["state"], "pending");
    assert_eq!(r["answerable"], false);
    assert_eq!(r["reason"], "ambiguous");
}

#[test]
fn unread_screen_when_not_blocked() {
    let x = Scratch::new();
    claude_approval(&x);
    x.status("t1", &working());
    let lines = x.cards("t1");
    assert_eq!(one(&lines, "cards")["screen"], "unread");
    assert!(lines_of(&lines, "request").is_empty(), "{lines:#?}");
    let x = Scratch::new();
    codex_case(
        &x,
        r#""call_id":"call_531dd63fb7d24c459c54727c21db2eea""#,
        "d-y",
    );
    x.status("t3", &json!({"app": "codex", "state": "working"}));
    let lines = x.cards("t3");
    assert_eq!(one(&lines, "cards")["screen"], "unread");
    assert!(lines_of(&lines, "request").is_empty(), "{lines:#?}");
    assert!(!x.hc_log().contains("read "), "{}", x.hc_log());
}

#[test]
fn unknown_prompt_is_show_only() {
    let x = Scratch::new();
    claude_approval(&x);
    x.screen(
        "t1",
        Some("Some header\n\n Do you want to make this change to settings.json?\n ❯ Sure\n   Not now\n"),
    );
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(r["state"], "pending");
    assert_eq!(r["answerable"], false);
    assert_eq!(r["reason"], "no_match");
    assert_eq!(r["actions"], json!([]));
}

#[test]
fn resolved_requests_drop_after_10_s() {
    let mut x = Scratch::new();
    claude_approval(&x);
    x.cards("t1");
    x.now += 1000;
    x.status("t1", &working());
    assert_eq!(one(&x.cards("t1"), "request")["state"], "settling");
    x.now = NOW_MS + 6000;
    assert_eq!(one(&x.cards("t1"), "request")["state"], "stale");
    x.now = NOW_MS + 6000 + 9999;
    assert_eq!(lines_of(&x.cards("t1"), "request").len(), 1);
    x.now = NOW_MS + 6000 + 10_000;
    assert!(lines_of(&x.cards("t1"), "request").is_empty());
}

#[test]
fn new_root_starts_a_new_store() {
    let x = Scratch::new();
    claude_approval(&x);
    x.cards("t1");
    assert_eq!(
        x.store("t1")["root"],
        "e186f156-fd30-4aab-a0b6-d3922b281731"
    );
    // /clear: the same terminal shows another conversation.
    let s = "claude-child-approval";
    let root = x.claude_root(
        s,
        CLAUDE_ROOT,
        &read(&sessions(s).join(format!("{CLAUDE_ROOT}.jsonl"))),
    );
    x.located("t1", "claude", &root, CLAUDE_ROOT, &working());
    let lines = x.cards("t1");
    assert_eq!(one(&lines, "cards")["session"], CLAUDE_ROOT);
    assert!(lines_of(&lines, "request").is_empty(), "{lines:#?}");
    let store = x.store("t1");
    assert_eq!(store["root"], CLAUDE_ROOT);
    assert_eq!(store["occurrences"], json!([]));
}

#[test]
fn feed_cards_appends_cards_after_rows() {
    let x = Scratch::new();
    claude_approval(&x);
    let lines = x.ok(&[
        "feed",
        "--terminal",
        "t1",
        "--pictures",
        "--tree",
        "--cards",
    ]);
    let kinds: Vec<&str> = lines.iter().map(|l| l["type"].as_str().unwrap()).collect();
    let first_card = kinds.iter().position(|k| *k == "cards").unwrap();
    assert_eq!(kinds[0], "tree", "{kinds:?}");
    assert_eq!(kinds[1], "log", "{kinds:?}");
    assert!(kinds[..first_card].contains(&"row"), "{kinds:?}");
    assert_eq!(kinds[first_card..], ["cards", "request"], "{kinds:?}");
    let r = one(&lines, "request");
    assert_eq!(r["tool_use_id"], "toolu_01SGHovZaso4tVTRPTHPkAEF");
    // Unchanged rows still carry the cards, and the request keeps its id.
    let cursor = one(&lines, "log")["cursor"].as_str().unwrap().to_string();
    let again = x.ok(&[
        "feed",
        "--terminal",
        "t1",
        "--pictures",
        "--cursor",
        &cursor,
        "--cards",
    ]);
    let kinds: Vec<&str> = again.iter().map(|l| l["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["log", "unchanged", "cards", "request"]);
    assert_eq!(one(&again, "request")["id"], r["id"]);
    // A sub-agent's view polls the same requests.
    let x = Scratch::new();
    case_a(&x, None);
    let lines = x.ok(&["feed", "--terminal", "t1", "--session", CHILD_A, "--cards"]);
    assert_eq!(one(&lines, "log")["child"], CHILD_A);
    assert_eq!(*who_child(one(&lines, "request")), CHILD_A);
    // A child the tree does not hold: its state line, then the terminal's requests all the same.
    let lines = x.ok(&[
        "feed",
        "--terminal",
        "t1",
        "--session",
        "a0000000000000000",
        "--cards",
    ]);
    let kinds: Vec<&str> = lines.iter().map(|l| l["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["state", "cards", "request"], "{lines:?}");
    assert_eq!(lines[0]["state"], "no_child");
    // A log read by path has no terminal to read requests from.
    let (code, lines) = x.bw(&[
        "feed",
        "--log",
        "/nonexistent.jsonl",
        "--agent",
        "claude",
        "--cards",
    ]);
    assert_eq!(code, 2, "{lines:?}");
    assert_eq!(lines[0]["code"], "usage");
}

#[test]
fn not_an_agent_prints_only_its_state() {
    let x = Scratch::new();
    x.get("t9", "zsh", 900, &json!({"state": "idle"}));
    let lines = x.cards("t9");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["state"], "not_agent");
    let (code, lines) = x.bw(&["cards"]);
    assert_eq!(code, 2, "{lines:?}");
}

/// Each case's lines as one text, the scratch folder written as `<scratch>`.
fn golden_text(x: &Scratch, lines: &[Value]) -> String {
    let dir = x.dir().to_string_lossy().to_string();
    lines
        .iter()
        .map(|l| format!("{}\n", l.to_string().replace(&dir, "<scratch>")))
        .collect()
}

#[test]
fn cards_goldens_are_current() {
    let bless = std::env::var("BW_BLESS").is_ok_and(|v| v == "1");
    let mut cases: Vec<(&str, String)> = vec![];
    let x = Scratch::new();
    claude_approval(&x);
    cases.push(("claude-root-approval", golden_text(&x, &x.cards("t1"))));
    let x = Scratch::new();
    case_a(&x, None);
    case_a_events(&x);
    cases.push(("claude-child-approval-a", golden_text(&x, &x.cards("t1"))));
    let mut x = Scratch::new();
    case_a(&x, None);
    x.cards("t1");
    x.now += 2000;
    x.status("t1", &working());
    x.cards("t1");
    x.now += 5000;
    cases.push(("claude-child-stale", golden_text(&x, &x.cards("t1"))));
    let s = "codex-child-approval";
    let x = Scratch::new();
    codex_case(
        &x,
        r#""call_id":"call_a640cd369d26472192cc52caf1ebaeb0""#,
        "e",
    );
    let child = format!("rollout-2026-11-07T02-24-53-{CODEX_CHILD}.jsonl");
    x.codex_file(
        &child,
        &upto(
            &read(&sessions(s).join(&child)),
            r#""call_id":"call_7a91eda49cd4472cbdb8d39940be5c54""#,
        ),
    );
    x.event(
        "t3",
        "codex",
        2,
        x.now - 1030,
        &payload(s, "e-PreToolUse-4"),
    );
    x.event(
        "t3",
        "codex",
        3,
        x.now - 1000,
        &payload(s, "e-PermissionRequest"),
    );
    cases.push(("codex-child-approval-e", golden_text(&x, &x.cards("t3"))));
    let x = Scratch::new();
    let codex = fresh_codex(&x, &json!({"app": "codex", "state": "idle"}));
    x.screen(
        "t7",
        Some(&read(&fixtures().join("screens/codex-new-folder.txt"))),
    );
    cases.push(("codex-new-folder", golden_text(&x, &x.cards("t7"))));
    drop(codex);

    let mut stale = vec![];
    for (name, got) in cases {
        let golden = fixtures().join(format!("cards/{name}.jsonl"));
        if bless {
            std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
            std::fs::write(&golden, &got).unwrap();
        } else if std::fs::read_to_string(&golden).ok().as_deref() != Some(got.as_str()) {
            stale.push(name);
        }
    }
    assert!(
        stale.is_empty(),
        "stale goldens {stale:?}: rerun with BW_BLESS=1 and review the diff"
    );
}

/// `screen` as Claude redraws it at `cols` columns: rules cut to that width and every longer line broken inside
/// its words, continuing indented, as `tests/fixtures/screens/claude-approval-52.txt` shows Claude doing.
fn rewrapped(screen: &str, cols: usize) -> String {
    let mut out = vec![];
    for line in screen.lines() {
        let chars: Vec<char> = line.chars().collect();
        if chars.first().is_some_and(|c| matches!(c, '╌' | '─')) {
            out.push(chars[..cols.min(chars.len())].iter().collect::<String>());
            continue;
        }
        let indent = chars.iter().take_while(|c| **c == ' ').count() + 3;
        let mut rest: &[char] = &chars;
        let mut first = true;
        while rest.len() > cols {
            out.push(rest[..cols].iter().collect::<String>());
            rest = &rest[cols..];
            first = false;
        }
        let tail: String = rest.iter().collect();
        out.push(if first {
            tail
        } else {
            format!("{}{}", " ".repeat(indent), tail.trim_start())
        });
    }
    out.join("\n")
}

#[test]
fn rewrap_keeps_one_pending_claude_card() {
    let x = Scratch::new();
    claude_approval(&x);
    let wide = one(&x.cards("t1"), "request").clone();
    let narrow_screen = rewrapped(
        &read(&sessions("claude-approval").join("screen-approval.txt")),
        52,
    );
    assert_ne!(
        narrow_screen,
        read(&sessions("claude-approval").join("screen-approval.txt"))
    );
    x.screen("t1", Some(&narrow_screen));
    let lines = x.cards("t1");
    let requests = lines_of(&lines, "request");
    assert_eq!(requests.len(), 1, "{lines:?}");
    let r = requests[0];
    assert_eq!(r["id"], wide["id"], "{r}");
    assert_eq!(r["screen_id"], wide["screen_id"]);
    assert_eq!(r["state"], "pending");
    assert_eq!(r["answerable"], true);
    assert_eq!(action_ids(r), ["approve", "always", "deny"]);
}

#[test]
fn rewrap_keeps_the_codex_folder_card_pending() {
    let x = Scratch::new();
    let _codex = fresh_codex(&x, &json!({"app": "codex", "state": "idle"}));
    x.screen(
        "t7",
        Some(&read(&fixtures().join("screens/codex-new-folder-80.txt"))),
    );
    let wide = one(&x.cards("t7"), "request").clone();
    x.screen(
        "t7",
        Some(&read(&fixtures().join("screens/codex-new-folder-24.txt"))),
    );
    let lines = x.cards("t7");
    let requests = lines_of(&lines, "request");
    assert_eq!(requests.len(), 1, "{lines:?}");
    let r = requests[0];
    assert_eq!(r["id"], wide["id"], "{r}");
    assert_eq!(r["state"], "pending");
    assert_eq!(action_ids(r), ["option-1", "option-2"]);
    assert_eq!(r["actions"][0]["label"], "Use current Git worktree");
}

#[test]
fn respaced_box_on_the_same_screen_id_is_another_card() {
    // The screen id drops whitespace; a space added or removed inside a line names another file.
    let s = read(&sessions("claude-approval").join("screen-approval.txt"));
    let question = |file: &str| {
        s.replace(
            " Do you want to proceed?",
            &format!(" Do you want to make this edit to {file}?"),
        )
    };
    for (first, other) in [
        (question("a b.rs"), question("ab.rs")),
        (
            s.clone(),
            s.replace(" touch approved.txt\n", " touch  approved.txt\n"),
        ),
    ] {
        assert_ne!(first, other, "(setup) the box changed");
        let x = Scratch::new();
        claude_approval(&x);
        x.screen("t1", Some(&first));
        let was = one(&x.cards("t1"), "request").clone();
        x.screen("t1", Some(&other));
        let lines = x.cards("t1");
        let pending: Vec<&Value> = lines_of(&lines, "request")
            .into_iter()
            .filter(|r| r["state"] == "pending")
            .collect();
        assert_eq!(pending.len(), 1, "{lines:#?}");
        assert_eq!(
            pending[0]["screen_id"], was["screen_id"],
            "(setup) the id is the same"
        );
        assert_ne!(pending[0]["id"], was["id"], "{lines:#?}");
    }
}

#[test]
fn rewrap_keeps_the_claude_card_with_a_spaced_question() {
    // Breaking the question's line between words or inside one is the same prompt.
    let s = read(&sessions("claude-approval").join("screen-approval.txt"));
    let first = s.replace(
        " Do you want to proceed?",
        " Do you want to make this edit to a b.rs?",
    );
    let narrow = s.replace(
        " Do you want to proceed?",
        " Do you want to make this\n edit to a\n b.r\n s?",
    );
    let x = Scratch::new();
    claude_approval(&x);
    x.screen("t1", Some(&first));
    let was = one(&x.cards("t1"), "request").clone();
    x.screen("t1", Some(&narrow));
    let r = one(&x.cards("t1"), "request").clone();
    assert_eq!(
        (&r["id"], &r["state"]),
        (&was["id"], &json!("pending")),
        "{r}"
    );
}

#[test]
fn queue_drain_gate3_holds_when_17th_running_child_has_pending_async_question() {
    let x = Scratch::new();
    let home = x.dir().join("codex-home");
    let day = home.join("sessions/2026/11/07");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();

    let root_meta_line = read(
        &sessions("codex-child-approval")
            .join(format!("rollout-2026-11-07T02-24-17-{CODEX_ROOT}.jsonl")),
    )
    .lines()
    .next()
    .unwrap()
    .to_string();
    let root_name = format!("rollout-2026-11-07T02-24-17-{CODEX_ROOT}.jsonl");
    let root_path = day.join(&root_name);
    let mut root_text = format!(
        "{root_meta_line}\n{}\n",
        r#"{"timestamp":"2026-11-07T10:24:18.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","id":"msg_u1","role":"user","content":[{"type":"input_text","text":"Spawn 17 workers."}]}}"#
    );

    let child_meta_line = read(
        &sessions("codex-child-approval")
            .join(format!("rollout-2026-11-07T02-24-53-{CODEX_CHILD}.jsonl")),
    )
    .lines()
    .next()
    .unwrap()
    .to_string();

    for i in 0..17usize {
        let cid = format!("01a1b58a-29ac-7de0-b175-1000000000{i:02}");
        let ts = format!("2026-11-07T10:24:{:02}.210Z", 20 + i);
        let started_ms = 1_794_047_060_000i64 + (i as i64) * 1000;
        let ord = 2 + i;
        root_text.push_str(&format!(
            r#"{{"timestamp":"{ts}","ordinal":{ord},"type":"event_msg","payload":{{"type":"item_completed","thread_id":"{CODEX_ROOT}","turn_id":"turn_root","started_at_ms":{started_ms},"completed_at_ms":{started_ms},"item":{{"type":"SubAgentActivity","id":"call_spawn_{i}","kind":"started","agent_thread_id":"{cid}","agent_path":"/root/worker_{i}"}}}}}}
"#
        ));
        let mut body = child_meta_line
            .replace(CODEX_CHILD, &cid)
            .replace("2026-11-07T10:24:53.210Z", &ts)
            .replace("2026-11-07T10:24:53.185Z", &ts);
        body.push('\n');
        if i == 16 {
            body.push_str(&format!(
                r#"{{"timestamp":"2026-11-07T10:24:58.000Z","ordinal":2,"type":"response_item","payload":{{"type":"function_call","status":"completed","id":"fc_q17","name":"request_user_input_async","arguments":"{{\"questions\":[{{\"title\":\"Which shard?\",\"options\":[\"a\",\"b\"]}}]}}","call_id":"call_q17"}}}}
{{"timestamp":"2026-11-07T10:24:58.010Z","ordinal":3,"type":"event_msg","payload":{{"type":"item_completed","thread_id":"{cid}","turn_id":"turn_17","item":{{"type":"AgentMessage","id":"call_q17","content":[{{"type":"Text","text":"Which shard?\n- a\n- b"}}],"phase":"final_answer","delivery":"async","questions":[{{"title":"Which shard?","options":["a","b"]}}]}}}}}}
{{"timestamp":"2026-11-07T10:24:58.020Z","ordinal":4,"type":"response_item","payload":{{"type":"function_call_output","id":"fco_q17","call_id":"call_q17","output":"{{\"accepted\":true}}"}}}}
"#
            ));
        }
        let fname = format!("rollout-2026-11-07T02-24-{:02}-{cid}.jsonl", 20 + i);
        std::fs::write(day.join(fname), body).unwrap();
    }
    root_text.push_str(
        r#"{"timestamp":"2026-11-07T10:25:00.000Z","ordinal":99,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_clean_root","role":"assistant","content":[{"type":"output_text","text":"Spawned workers."}]}}"#,
    );
    root_text.push('\n');
    std::fs::write(&root_path, &root_text).unwrap();

    let lock = home.join(format!("thread-writer-locks/{CODEX_ROOT}.lock"));
    std::fs::write(&lock, "").unwrap();

    let _codex = FakeCodex::start(&x.dir(), &home, &[root_path, lock]);
    _codex.terminal(&x, &json!({"app": "codex", "state": "done"}));

    // UI display pass (`bw cards`) caps at 16 children, while `bw queue drain` Gate 3 scans all 17+.
    let ui_cards = x.cards("t7");
    assert!(lines_of(&ui_cards, "request").is_empty(), "{ui_cards:#?}");

    x.ok(&[
        "queue",
        "add",
        "--terminal",
        "t7",
        "--kind",
        "codex",
        "--text",
        "next task",
    ]);
    let drain = x.ok(&["queue", "drain", "--terminal", "t7"]);
    assert_eq!(drain[0]["result"], "pending", "{drain:#?}");
    assert_eq!(drain[0]["reason"], "pending_request", "{drain:#?}");
    assert_eq!(drain[0]["remaining"], 1, "{drain:#?}");
    assert!(
        !x.hc_log().contains("send t7"),
        "hc_log was: {}",
        x.hc_log()
    );
}
