//! `bw answer` against tests/fake-hc: keys go only to the prompt the card showed, once per occurrence.
//!
//! Each case stands up a process named `claude` or `codex` (so `bw answer`'s fresh lookup finds the conversation
//! as it finds a real one), serves the saved screen through `hc read`, and lets the fake switch to
//! `<t>.next.txt` from the second read and to `<t>.after.txt` once keys went to that terminal.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const CORE: &str = "bw-answer-test";
const CLAUDE_SID: &str = "e186f156-fd30-4aab-a0b6-d3922b281731";
const CLAUDE_CALL: &str = "toolu_01SGHovZaso4tVTRPTHPkAEF";
const CODEX_SID: &str = "01a1b4a2-fa97-7930-bfcd-16b306dac48e";
const CODEX_FILE: &str = "rollout-2026-11-06T22-12-22-01a1b4a2-fa97-7930-bfcd-16b306dac48e.jsonl";
const QUESTION_SID: &str = "01a1b4a2-6731-7140-87be-4960d8a7aefe";
const QUESTION_FILE: &str =
    "rollout-2026-11-06T22-11-44-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl";
const NEW: &str = "01a1b512-1f37-7941-98b2-00c2fc7b72f3";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn sessions(s: &str) -> PathBuf {
    fixtures().join("sessions").join(s)
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// The lines of `text` up to and including the first that contains `needle`.
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

/// A process named `name` (its script is `<dir>/bin/<name>`) holding `files` open, as Codex holds its rollouts.
struct Agent(Child);

impl Agent {
    fn start(dir: &Path, name: &str, files: &[PathBuf]) -> Agent {
        let script = dir.join(format!("bin/{name}"));
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(
            &script,
            "#!/bin/sh\nfd=3\nfor f; do eval \"exec $fd<\\\"\\$f\\\"\"; fd=$((fd + 1)); done\n: > \"$READY\"\nwhile :; do sleep 1; done\n",
        )
        .unwrap();
        let ready = dir.join(format!("{name}-ready"));
        let _ = std::fs::remove_file(&ready);
        let child = Command::new("/bin/sh")
            .arg(&script)
            .args(files)
            .env("READY", &ready)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready.exists(), "the fake {name} never opened its files");
        Agent(child)
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }

    /// When this process started, in UTC as `ps` prints `lstart`, which Claude's pid file records.
    fn lstart(&self) -> String {
        let out = Command::new("ps")
            .args(["-o", "lstart=", "-p", &self.pid().to_string()])
            .env("TZ", "UTC")
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Scratch {
    tmp: tempfile::TempDir,
    env: Vec<(String, String)>,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["gets", "home", "screens"] {
            std::fs::create_dir_all(tmp.path().join(d)).unwrap();
        }
        Scratch { tmp, env: vec![] }
    }

    /// The real folder: lsof names files by it.
    fn dir(&self) -> PathBuf {
        self.tmp.path().canonicalize().unwrap()
    }

    fn set(&mut self, k: &str, v: &str) {
        self.env.push((k.into(), v.into()));
    }

    fn command(&self, args: &[&str]) -> Command {
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env("BW_HC", fake)
            .env("FAKE_HC_GET_DIR", self.dir().join("gets"))
            .env("FAKE_HC_SCREEN_DIR", self.dir().join("screens"))
            .env("FAKE_HC_LOG", self.dir().join("hc.log"))
            .env("BW_CACHE_DIR", self.dir().join("cache"))
            .env("BW_NO_PAUSE", "1")
            .env("HC_SESSION", CORE)
            .env("HOME", self.dir().join("home"))
            .env("CLAUDE_CONFIG_DIR", self.dir().join("claude"))
            .env_remove("CODEX_HOME")
            .env_remove("BW_NOW_MS")
            .env_remove("BW_ANSWER_DEADLINE_S")
            .env_remove("FAKE_HC_KEYS_SLEEP");
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd
    }

    fn bw(&self, args: &[&str]) -> (i32, Vec<Value>) {
        let out = self.command(args).output().unwrap();
        parse(out)
    }

    /// The one pending request `bw cards` shows now; the hc log starts empty after it, so each test counts only
    /// what `bw answer` did.
    fn request(&self, t: &str) -> Value {
        let (code, lines) = self.bw(&["cards", "--terminal", t]);
        assert_eq!(code, 0, "{lines:?}");
        let found: Vec<&Value> = lines
            .iter()
            .filter(|l| l["type"] == "request" && l["state"] == "pending")
            .collect();
        assert_eq!(found.len(), 1, "one pending request in {lines:#?}");
        self.clear_log();
        found[0].clone()
    }

    fn clear_log(&self) {
        let _ = std::fs::remove_file(self.dir().join("hc.log"));
    }

    fn answer_args(t: &str, r: &Value, kind: &str, session: &str, path: &str) -> Vec<String> {
        [
            "answer",
            "--terminal",
            t,
            "--request",
            r["id"].as_str().unwrap(),
            "--expect-kind",
            kind,
            "--expect-session",
            session,
            "--expect-path",
            path,
        ]
        .map(String::from)
        .to_vec()
    }

    /// `bw answer` with `extra` (`--action <a>` or `--answers <json>`): its one line.
    fn answer(&self, t: &str, r: &Value, expect: (&str, &str, &str), extra: &[&str]) -> Value {
        let mut args = Scratch::answer_args(t, r, expect.0, expect.1, expect.2);
        args.extend(extra.iter().map(|s| s.to_string()));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, lines) = self.bw(&args);
        assert_eq!(code, 0, "{lines:?}");
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0]["type"], "answer", "{lines:?}");
        assert!(lines[0]["message"].is_string(), "{lines:?}");
        lines[0].clone()
    }

    fn log(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir().join("hc.log"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    /// Every `keys` and `send` call: what reached a terminal.
    fn typed(&self) -> Vec<String> {
        self.log()
            .into_iter()
            .filter(|l| l.starts_with("keys ") || l.starts_with("send "))
            .collect()
    }

    fn screen(&self, t: &str, name: &str, text: &str) {
        std::fs::write(self.dir().join(format!("screens/{t}.{name}")), text).unwrap();
    }

    /// `hc get <t>` (or `<t>.after.json` once a read went to `t`, with `file` "after.json").
    fn get(&self, t: &str, file: &str, program: &str, pid: u32, status: &Value) {
        std::fs::write(
            self.dir().join(format!("gets/{t}.{file}")),
            json!({"address": t, "argv": [program], "cwd": "/scratch", "pid": pid, "created_ms": 5,
                   "state": "live", "status": status,
                   "foreground": {"argv": [program], "cwd": "/scratch", "name": program, "pid": pid}})
            .to_string(),
        )
        .unwrap();
    }

    fn store(&self, t: &str) -> Value {
        let file = self.dir().join(format!("cache/requests/{CORE}/{t}.json"));
        serde_json::from_str(&read(&file)).unwrap()
    }

    /// A Claude in `t1` whose session log holds `log`, with hc `status`.
    fn claude(&self, log: &str, status: &Value) -> (Agent, PathBuf) {
        let project = self.dir().join("claude/projects/-scratch-claude-approval");
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join(format!("{CLAUDE_SID}.jsonl"));
        std::fs::write(&file, log).unwrap();
        let agent = Agent::start(&self.dir(), "claude", &[]);
        let pid = agent.pid();
        std::fs::create_dir_all(self.dir().join("claude/sessions")).unwrap();
        std::fs::write(
            self.dir().join(format!("claude/sessions/{pid}.json")),
            json!({"pid": pid, "sessionId": CLAUDE_SID, "procStart": agent.lstart()}).to_string(),
        )
        .unwrap();
        self.get("t1", "json", "claude", pid, status);
        (agent, file)
    }

    /// A Codex in `t` holding the rollout `name` (holding `log`) and its thread lock, with hc `status`.
    fn codex(
        &self,
        t: &str,
        name: &str,
        session: &str,
        log: &str,
        status: &Value,
    ) -> (Agent, PathBuf) {
        let home = self.dir().join("codex-home");
        let day = home.join("sessions/2026/11/06");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
        let file = day.join(name);
        std::fs::write(&file, log).unwrap();
        let lock = home.join(format!("thread-writer-locks/{session}.lock"));
        std::fs::write(&lock, "").unwrap();
        let agent = Agent::start(&self.dir(), "codex", &[file.clone(), lock]);
        self.get(t, "json", "codex", agent.pid(), status);
        (agent, file)
    }

    /// A Codex in `t7` with a thread lock and no rollout: `no_log` naming `NEW`, as after `/new`.
    fn fresh_codex(&self) -> Agent {
        let home = self.dir().join("codex-home");
        std::fs::create_dir_all(home.join("sessions")).unwrap();
        std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
        let lock = home.join(format!("thread-writer-locks/{NEW}.lock"));
        std::fs::write(&lock, "").unwrap();
        let agent = Agent::start(&self.dir(), "codex", &[lock]);
        self.get(
            "t7",
            "json",
            "codex",
            agent.pid(),
            &json!({"app": "codex", "state": "idle"}),
        );
        agent
    }
}

fn parse(out: std::process::Output) -> (i32, Vec<Value>) {
    let lines = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
        .collect();
    (out.status.code().unwrap(), lines)
}

fn blocked() -> Value {
    json!({"app": "claude-code", "kind": "permission", "state": "blocked"})
}

fn claude_log() -> String {
    read(&sessions("claude-approval").join(format!("{CLAUDE_SID}.jsonl")))
}

/// claude-approval while its prompt shows: the Bash call has no result yet. `after`: the screen once a key went.
fn claude_approval(x: &Scratch, after: Option<&str>) -> (Agent, String, Value) {
    let (agent, log) = x.claude(
        &upto(
            &claude_log(),
            &format!(r#""type":"tool_use","id":"{CLAUDE_CALL}""#),
        ),
        &blocked(),
    );
    x.screen(
        "t1",
        "txt",
        &read(&sessions("claude-approval").join("screen-approval.txt")),
    );
    if let Some(a) = after {
        x.screen("t1", "after.txt", a);
    }
    let r = x.request("t1");
    (agent, log.to_string_lossy().to_string(), r)
}

/// A Claude screen with no prompt, as after the key.
const CALM: &str = "⏺ Bash(touch approved.txt)\n  ⎿  (No output)\n\n❯ \n";

fn result(line: &Value) -> &str {
    line["result"].as_str().unwrap()
}

fn occurrence<'a>(store: &'a Value, id: &str) -> &'a Value {
    store["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["id"] == id)
        .unwrap_or_else(|| panic!("no occurrence {id} in {store:#}"))
}

#[test]
fn approve_presses_1_once_then_answered() {
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    assert_eq!(r["answerable"], true, "{r}");
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(line["state"], "answered");
    assert_eq!(x.typed(), ["keys t1 1"]);
    let o = occurrence(&x.store("t1"), CLAUDE_CALL).clone();
    assert_eq!(o["state"], "answered");
    assert_eq!(o["by"], "approve");
    assert!(o["resolved_ms"].is_i64(), "{o}");
    // The card the chat polls next says Bellwether answered it.
    let (_, lines) = x.bw(&["cards", "--terminal", "t1"]);
    let shown = lines.iter().find(|l| l["type"] == "request").unwrap();
    assert_eq!(shown["state"], "answered", "{lines:#?}");
}

#[test]
fn always_presses_2_and_deny_presses_esc() {
    for (action, key, state) in [("always", "2", "answered"), ("deny", "esc", "declined")] {
        let x = Scratch::new();
        let (_claude, log, r) = claude_approval(&x, Some(CALM));
        let line = x.answer(
            "t1",
            &r,
            ("claude", CLAUDE_SID, &log),
            &["--action", action],
        );
        assert_eq!(result(&line), state, "{action}: {line}");
        assert_eq!(x.typed(), [format!("keys t1 {key}")], "{action}");
        assert_eq!(occurrence(&x.store("t1"), CLAUDE_CALL)["by"], action);
    }
}

#[test]
fn codex_approve_presses_y() {
    let x = Scratch::new();
    let text = read(&sessions("codex-approval").join(CODEX_FILE));
    let (_codex, log) = x.codex(
        "t7",
        CODEX_FILE,
        CODEX_SID,
        &upto(
            &text,
            r#""call_id":"call_46bbea063d654fa28d8e66020fc0709d""#,
        ),
        &json!({"app": "codex", "kind": "permission", "state": "blocked"}),
    );
    x.screen(
        "t7",
        "txt",
        &read(&sessions("codex-approval").join("screen-approval.txt")),
    );
    x.screen("t7", "after.txt", "• Ran touch approved.txt\n\n› \n");
    let r = x.request("t7");
    let log = log.to_string_lossy().to_string();
    let line = x.answer(
        "t7",
        &r,
        ("codex", CODEX_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["keys t7 y"]);
}

#[test]
fn other_screen_before_key_is_stale_and_presses_nothing() {
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    // From the second read on, another command's box: the key would answer something the card never showed.
    let other = read(&sessions("claude-approval").join("screen-approval.txt"))
        .replace("touch approved.txt", "rm -rf build");
    x.screen("t1", "next.txt", &other);
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "stale", "{line}");
    assert_eq!(line["message"], "Changed on screen; nothing was pressed");
    assert!(x.typed().is_empty(), "{:?}", x.log());
    assert_eq!(
        x.log().iter().filter(|l| l.starts_with("read ")).count(),
        2,
        "{:?}",
        x.log()
    );
    // The claim went back: once the card's box is on screen again, it can be answered.
    std::fs::remove_file(x.dir().join("screens/t1.next.txt")).unwrap();
    x.clear_log();
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["keys t1 1"]);
}

#[test]
fn box_gone_before_its_result_presses_nothing() {
    // The box left before Claude logged the call's result: the card settles, and is never answered again.
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, None);
    x.screen("t1", "txt", CALM);
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "stale", "{line}");
    assert_eq!(line["state"], "settling");
    assert!(x.typed().is_empty(), "{:?}", x.log());
    assert_eq!(occurrence(&x.store("t1"), CLAUDE_CALL)["state"], "settling");
}

/// The assistant line of the claude-approval call, as a second call `id` with the same command.
fn same_command_again(id: &str) -> String {
    let line = claude_log()
        .lines()
        .find(|l| l.contains(&format!(r#""type":"tool_use","id":"{CLAUDE_CALL}""#)))
        .unwrap()
        .to_string();
    let mut v: Value = serde_json::from_str(&line).unwrap();
    v["message"]["id"] = json!("msg_02SecondSecondSecond");
    v["message"]["content"][0]["id"] = json!(id);
    v["uuid"] = json!("0b6f7d43-1d2e-4f37-9a52-7d0e5e1c2f11");
    v["timestamp"] = json!("2026-11-07T06:11:10.000Z");
    format!("{v}\n")
}

#[test]
fn next_occurrence_with_same_command_is_stale() {
    // Review Focus 1: the card's prompt was answered in the terminal and the same command asks again.
    let x = Scratch::new();
    let (_claude, log, first) = claude_approval(&x, Some(CALM));
    let mut text = upto(
        &claude_log(),
        &format!(
            r#""type":"user","message":{{"role":"user","content":[{{"tool_use_id":"{CLAUDE_CALL}""#
        ),
    );
    text.push_str(&same_command_again("toolu_02NextCallWithSameCommand"));
    std::fs::write(&log, text).unwrap();
    let line = x.answer(
        "t1",
        &first,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "stale", "{line}");
    assert_eq!(line["message"], "Changed on screen; nothing was pressed");
    assert!(x.typed().is_empty(), "{:?}", x.log());
    let s = x.store("t1");
    assert_eq!(occurrence(&s, CLAUDE_CALL)["state"], "answered_terminal");
    assert_eq!(
        occurrence(&s, "toolu_02NextCallWithSameCommand")["state"],
        "pending"
    );
}

#[test]
fn a_newer_call_behind_the_same_box_is_stale() {
    // The log shows a newer call with the same command before the first one's result: the box the card showed
    // may be gone, so its card presses nothing and the box becomes a new card.
    let x = Scratch::new();
    let (_claude, log, first) = claude_approval(&x, Some(CALM));
    let mut text = read(Path::new(&log));
    text.push_str(&same_command_again("toolu_02NextCallWithSameCommand"));
    std::fs::write(&log, text).unwrap();
    let line = x.answer(
        "t1",
        &first,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "stale", "{line}");
    assert!(x.typed().is_empty(), "{:?}", x.log());
    let next = x.request("t1");
    assert_ne!(next["id"], first["id"]);
    assert_eq!(next["tool_use_id"], "toolu_02NextCallWithSameCommand");
    let line = x.answer(
        "t1",
        &next,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["keys t1 1"]);
}

#[test]
fn second_click_is_already_answered() {
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "answered", "{line}");
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "already-answered", "{line}");
    assert_eq!(x.typed(), ["keys t1 1"]);
}

#[test]
fn concurrent_answers_press_once() {
    let mut x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    // A slow key keeps the first answer running while the second one reads, claims and decides.
    x.set("FAKE_HC_KEYS_SLEEP", "1");
    let mut args = Scratch::answer_args("t1", &r, "claude", CLAUDE_SID, &log);
    args.extend(["--action".to_string(), "approve".to_string()]);
    let runs: Vec<Child> = (0..2)
        .map(|_| {
            x.command(&args.iter().map(String::as_str).collect::<Vec<_>>())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    let mut results: Vec<String> = runs
        .into_iter()
        .map(|c| {
            let (code, lines) = parse(c.wait_with_output().unwrap());
            assert_eq!(code, 0, "{lines:?}");
            lines[0]["result"].as_str().unwrap().to_string()
        })
        .collect();
    results.sort();
    assert_eq!(x.typed(), ["keys t1 1"], "{results:?}");
    assert!(results.contains(&"answered".to_string()), "{results:?}");
    assert!(
        results
            .iter()
            .any(|r| r == "already-answered" || r == "busy"),
        "{results:?}"
    );
}

#[test]
fn other_session_is_refused_conversation() {
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    for (session, path) in [
        (NEW, log.as_str()),
        (CLAUDE_SID, "/scratch/other.jsonl"),
        (CLAUDE_SID, "none"),
    ] {
        let line = x.answer(
            "t1",
            &r,
            ("claude", session, path),
            &["--action", "approve"],
        );
        assert_eq!(
            result(&line),
            "refused-conversation",
            "{session} {path}: {line}"
        );
    }
    let line = x.answer(
        "t1",
        &r,
        ("codex", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "refused-conversation", "{line}");
    assert!(x.typed().is_empty(), "{:?}", x.log());
    assert!(
        !x.log().iter().any(|l| l.starts_with("read ")),
        "no screen read before the conversation is confirmed: {:?}",
        x.log()
    );
}

/// The `/new` folder prompt in `t7`, with `after` once a key went.
fn folder_prompt(x: &Scratch, after: &str) -> (Agent, Value) {
    let codex = x.fresh_codex();
    x.screen(
        "t7",
        "txt",
        &read(&fixtures().join("screens/codex-new-folder.txt")),
    );
    x.screen("t7", "after.txt", after);
    let r = x.request("t7");
    assert_eq!(r["kind"], "prompt", "{r}");
    (codex, r)
}

#[test]
fn expectations_follow_bw_send() {
    let after = read(&fixtures().join("screens/codex-new-worktree-after.txt"));
    let x = Scratch::new();
    let (_codex, r) = folder_prompt(&x, &after);
    for (session, path) in [
        (CODEX_SID, "none"),
        (NEW, "/scratch/rollout.jsonl"),
        (CODEX_SID, "/scratch/rollout.jsonl"),
    ] {
        let line = x.answer(
            "t7",
            &r,
            ("codex", session, path),
            &["--action", "option-1"],
        );
        assert_eq!(
            result(&line),
            "refused-conversation",
            "{session} {path}: {line}"
        );
    }
    let line = x.answer(
        "t7",
        &r,
        ("claude", "none", "none"),
        &["--action", "option-1"],
    );
    assert_eq!(result(&line), "refused-conversation", "{line}");
    let mut args = Scratch::answer_args("t7", &r, "codex", "none", "/scratch/rollout.jsonl");
    args.extend(["--action".to_string(), "option-1".to_string()]);
    let (code, lines) = x.bw(&args.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(
        (code, lines[0]["code"].as_str()),
        (2, Some("usage")),
        "{lines:?}"
    );
    assert!(x.typed().is_empty(), "{:?}", x.log());
    // `<id> none` passes only the session the chat named.
    let line = x.answer("t7", &r, ("codex", NEW, "none"), &["--action", "option-1"]);
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["keys t7 1"]);

    // `none none` passes a conversation with no log yet, and only that.
    let x = Scratch::new();
    let (_codex, r) = folder_prompt(&x, &after);
    let line = x.answer(
        "t7",
        &r,
        ("codex", "none", "none"),
        &["--action", "option-2"],
    );
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["keys t7 2"]);

    let x = Scratch::new();
    let (_claude, _, r) = claude_approval(&x, Some(CALM));
    let line = x.answer(
        "t1",
        &r,
        ("claude", "none", "none"),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "refused-conversation", "{line}");
    assert!(x.typed().is_empty(), "{:?}", x.log());
}

#[test]
fn ambiguous_conversation_is_refused_in_every_form() {
    // Codex holding two root threads, as for 60 s after `/resume`: no single conversation, so no key at all.
    let x = Scratch::new();
    let text = read(&sessions("codex-approval").join(CODEX_FILE));
    let home = x.dir().join("codex-home");
    let day = home.join("sessions/2026/11/06");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let first = day.join(CODEX_FILE);
    std::fs::write(
        &first,
        upto(
            &text,
            r#""call_id":"call_46bbea063d654fa28d8e66020fc0709d""#,
        ),
    )
    .unwrap();
    let mut meta: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    meta["payload"]["id"] = json!(NEW);
    let second = day.join(format!("rollout-2026-11-06T22-30-00-{NEW}.jsonl"));
    std::fs::write(&second, format!("{meta}\n")).unwrap();
    let mut files = vec![first.clone(), second];
    for id in [CODEX_SID, NEW] {
        let lock = home.join(format!("thread-writer-locks/{id}.lock"));
        std::fs::write(&lock, "").unwrap();
        files.push(lock);
    }
    let codex = Agent::start(&x.dir(), "codex", &files);
    let status = json!({"app": "codex", "kind": "permission", "state": "blocked"});
    x.get("t7", "json", "codex", codex.pid(), &status);
    x.screen(
        "t7",
        "txt",
        &read(&sessions("codex-approval").join("screen-approval.txt")),
    );
    let r = x.request("t7");
    assert_eq!(r["answerable"], false, "{r}");
    assert_eq!(r["reason"], "ambiguous", "{r}");
    let first = first.to_string_lossy().to_string();
    for (session, path) in [
        (CODEX_SID, first.as_str()),
        (CODEX_SID, "none"),
        (NEW, "none"),
        ("none", "none"),
    ] {
        let line = x.answer("t7", &r, ("codex", session, path), &["--action", "approve"]);
        assert_eq!(
            result(&line),
            "refused-conversation",
            "{session} {path}: {line}"
        );
    }
    assert!(x.typed().is_empty(), "{:?}", x.log());
}

#[test]
fn folder_prompt_option_presses_its_key() {
    let after = read(&fixtures().join("screens/codex-new-worktree-after.txt"));
    let x = Scratch::new();
    let (_codex, r) = folder_prompt(&x, &after);
    let line = x.answer("t7", &r, ("codex", NEW, "none"), &["--action", "option-1"]);
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["keys t7 1"]);
    // An action the card does not offer presses nothing.
    let x = Scratch::new();
    let (_codex, r) = folder_prompt(&x, &after);
    for action in ["approve", "option-3"] {
        let line = x.answer("t7", &r, ("codex", NEW, "none"), &["--action", action]);
        assert_eq!(result(&line), "failed", "{action}: {line}");
    }
    assert!(x.typed().is_empty(), "{:?}", x.log());
}

#[test]
fn other_program_is_refused_agent() {
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    // After the first screen read, hc names another program in the terminal.
    x.get("t1", "after.json", "claude", 999_999, &blocked());
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "refused-agent", "{line}");
    assert!(x.typed().is_empty(), "{:?}", x.log());
}

#[test]
fn box_still_there_after_keys_is_uncertain() {
    let x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, None);
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "uncertain", "{line}");
    assert_eq!(line["state"], "uncertain");
    assert_eq!(x.typed(), ["keys t1 1"]);
    assert_eq!(
        occurrence(&x.store("t1"), CLAUDE_CALL)["state"],
        "uncertain"
    );
    // The key may still land: a second click presses nothing.
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "already-answered", "{line}");
    assert_eq!(x.typed(), ["keys t1 1"]);
}

#[test]
fn slow_keys_are_uncertain() {
    let mut x = Scratch::new();
    let (_claude, log, r) = claude_approval(&x, Some(CALM));
    x.set("FAKE_HC_KEYS_SLEEP", "4");
    x.set("BW_ANSWER_DEADLINE_S", "2");
    let started = Instant::now();
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "uncertain", "{line}");
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(x.typed(), ["keys t1 1"]);
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "already-answered", "{line}");
}

#[test]
fn not_answerable_presses_nothing() {
    let x = Scratch::new();
    let (_claude, log) = x.claude(
        &upto(
            &claude_log(),
            &format!(r#""type":"tool_use","id":"{CLAUDE_CALL}""#),
        ),
        &blocked(),
    );
    x.screen(
        "t1",
        "txt",
        "Some header\n\n Do you want to make this change to settings.json?\n ❯ Sure\n   Not now\n",
    );
    let r = x.request("t1");
    assert_eq!(r["reason"], "no_match", "{r}");
    let log = log.to_string_lossy().to_string();
    let line = x.answer(
        "t1",
        &r,
        ("claude", CLAUDE_SID, &log),
        &["--action", "approve"],
    );
    assert_eq!(result(&line), "not-answerable", "{line}");
    assert!(x.typed().is_empty(), "{:?}", x.log());
}

/// codex-question while its async question waits: the user's "large" not written yet.
fn async_question(x: &Scratch, status: &Value) -> (Agent, String, Value) {
    let text = read(&sessions("codex-question").join(QUESTION_FILE));
    let (codex, log) = x.codex(
        "t2",
        QUESTION_FILE,
        QUESTION_SID,
        &before(&text, r#""text":"large""#),
        status,
    );
    x.screen(
        "t2",
        "txt",
        &read(&sessions("codex-question").join("screen-async.txt")),
    );
    let r = x.request("t2");
    assert_eq!(r["kind"], "question_async", "{r}");
    (codex, log.to_string_lossy().to_string(), r)
}

#[test]
fn async_answer_sends_one_message() {
    let x = Scratch::new();
    let (_codex, log, r) = async_question(&x, &json!({"app": "codex", "state": "idle"}));
    let line = x.answer(
        "t2",
        &r,
        ("codex", QUESTION_SID, &log),
        &["--answers", r#"[{"picks":[1]}]"#],
    );
    assert_eq!(result(&line), "answered", "{line}");
    assert_eq!(x.typed(), ["send t2 large"]);
    let o = occurrence(&x.store("t2"), "call_261068c0a529492d8d12899f3b5edeb9").clone();
    assert_eq!(
        (o["state"].as_str(), o["by"].as_str()),
        (Some("answered"), Some("answers"))
    );
    let line = x.answer(
        "t2",
        &r,
        ("codex", QUESTION_SID, &log),
        &["--answers", r#"[{"picks":[1]}]"#],
    );
    assert_eq!(result(&line), "already-answered", "{line}");
    assert_eq!(x.typed(), ["send t2 large"]);
}

#[test]
fn async_blocked_is_refused_prompt() {
    let x = Scratch::new();
    let (_codex, log, r) = async_question(&x, &json!({"app": "codex", "state": "idle"}));
    x.get(
        "t2",
        "json",
        "codex",
        _codex.pid(),
        &json!({"app": "codex", "kind": "permission", "state": "blocked"}),
    );
    let line = x.answer(
        "t2",
        &r,
        ("codex", QUESTION_SID, &log),
        &["--answers", r#"[{"picks":[1]}]"#],
    );
    assert_eq!(result(&line), "refused-prompt", "{line}");
    assert!(x.typed().is_empty(), "{:?}", x.log());
    // Nothing went out, so once the prompt is gone the question can be answered.
    x.get(
        "t2",
        "json",
        "codex",
        _codex.pid(),
        &json!({"app": "codex", "state": "idle"}),
    );
    let line = x.answer(
        "t2",
        &r,
        ("codex", QUESTION_SID, &log),
        &["--answers", r#"[{"picks":[1]}]"#],
    );
    assert_eq!(result(&line), "answered", "{line}");
}

#[test]
fn picker_question_keys_follow_answer_question() {
    let x = Scratch::new();
    let text = read(&sessions("codex-question").join(QUESTION_FILE));
    let (_codex, log) = x.codex(
        "t2",
        QUESTION_FILE,
        QUESTION_SID,
        &upto(&text, r#""name":"request_user_input","#),
        &json!({"app": "codex", "kind": "question", "state": "blocked"}),
    );
    x.screen(
        "t2",
        "txt",
        &read(&sessions("codex-question").join("screen-question.txt")),
    );
    x.screen("t2", "after.txt", "• Asked: Which colour? blue\n\n› \n");
    let r = x.request("t2");
    assert_eq!(r["kind"], "question", "{r}");
    let log = log.to_string_lossy().to_string();
    let line = x.answer(
        "t2",
        &r,
        ("codex", QUESTION_SID, &log),
        &["--answers", r#"[{"picks":[1]}]"#],
    );
    assert_eq!(result(&line), "answered", "{line}");
    // question::steps for Codex: the option's digit, which picks and submits.
    assert_eq!(x.typed(), ["keys t2 2"]);
}
