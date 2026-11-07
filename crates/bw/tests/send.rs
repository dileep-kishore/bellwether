//! `bw send` against tests/fake-hc: the conversation guard, `hc send`'s answers, and the text typed verbatim.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const SID: &str = "01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc";
const PATH: &str = "/h/.codex/sessions/2026/11/06/rollout-2026-11-06T22-11-05-01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc.jsonl";
const PARENT: &str = "rollout-2026-11-06T22-11-05-01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc.jsonl";

struct Scratch {
    tmp: tempfile::TempDir,
    env: Vec<(String, String)>,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["gets", "root"] {
            std::fs::create_dir_all(tmp.path().join(d)).unwrap();
        }
        Scratch { tmp, env: vec![] }
    }

    fn dir(&self) -> PathBuf {
        self.tmp.path().canonicalize().unwrap()
    }

    fn set(&mut self, k: &str, v: &str) {
        self.env.push((k.into(), v.into()));
    }

    /// What `bw locate --terminal t1 --fresh` prints on bwloop.
    fn remote_says(&mut self, line: Value) {
        let file = self.dir().join("exec-out");
        std::fs::write(&file, format!("{line}\n")).unwrap();
        self.set("FAKE_HC_EXEC_OUT", file.to_str().unwrap());
    }

    fn located(&mut self, agent: &str, session: &str, path: &str) {
        self.remote_says(
            json!({"type": "located", "terminal": "t1", "agent": agent, "session": session,
                                "path": path, "pid": 4242, "status": "idle"}),
        );
    }

    fn run(&self, args: &[&str]) -> (i32, Vec<Value>) {
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env("BW_HC", fake)
            .env("FAKE_HC_ROOT", self.dir().join("root"))
            .env("FAKE_HC_GET_DIR", self.dir().join("gets"))
            .env("FAKE_HC_LOG", self.dir().join("hc.log"))
            .env("BW_CACHE_DIR", self.dir().join("cache"))
            .env("HC_SESSION", "bw-send-test")
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("BW_SEND_TIMEOUT_S");
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        let lines = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
            .collect();
        (out.status.code().unwrap(), lines)
    }

    fn send(
        &self,
        terminal: &str,
        kind: &str,
        session: &str,
        path: &str,
        text: &str,
    ) -> (i32, Value) {
        let (code, lines) = self.run(&[
            "send",
            "--terminal",
            terminal,
            "--expect-kind",
            kind,
            "--expect-session",
            session,
            "--expect-path",
            path,
            "--text",
            text,
        ]);
        assert_eq!(lines.len(), 1, "{lines:?}");
        (code, lines[0].clone())
    }

    fn log(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir().join("hc.log"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    fn sends(&self) -> Vec<String> {
        self.log()
            .into_iter()
            .filter(|l| l.starts_with("send "))
            .collect()
    }
}

fn sent(line: &Value) -> &str {
    assert_eq!(line["type"], "send", "{line}");
    assert!(line["message"].is_string(), "{line}");
    line["result"].as_str().unwrap()
}

fn error(code: i32, line: &Value) -> &str {
    assert_eq!(code, 1, "{line}");
    assert_eq!(line["type"], "error", "{line}");
    line["code"].as_str().unwrap()
}

#[test]
fn send_types_text_verbatim() {
    // Review Focus 2: a dash first, quotes, a command substitution, --force and a newline, as one argv element.
    let text = "--force -x \"q\" $(touch /tmp/no) \nline 2";
    let mut x = Scratch::new();
    x.located("codex", SID, PATH);
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, text);
    assert_eq!((code, sent(&line)), (0, "sent"));
    // The log keeps the text's newline, so the one send spans two lines there.
    assert_eq!(
        x.sends(),
        vec!["send bwloop/t1 --force -x \"q\" $(touch /tmp/no) "]
    );
    let raw = std::fs::read_to_string(x.dir().join("hc.log")).unwrap();
    assert!(raw.ends_with(&format!("send bwloop/t1 {text}\n")), "{raw}");
    assert!(!Path::new("/tmp/no").exists(), "no shell read the text");
    let log = x.log();
    let exec = log
        .iter()
        .find(|l| l.starts_with("exec "))
        .expect("an exec on bwloop");
    assert!(
        exec.ends_with(" bw locate --terminal t1 --fresh"),
        "the helper there looks again, by its local address: {exec}"
    );
    assert!(!log
        .iter()
        .any(|l| l.contains("--force") && !l.starts_with("send ")));
}

#[test]
fn text_may_be_just_dashes() {
    let mut x = Scratch::new();
    x.located("codex", SID, PATH);
    for text in ["--", "-", "--text"] {
        let (_, line) = x.send("bwloop/t1", "codex", SID, PATH, text);
        assert_eq!(sent(&line), "sent", "{text}");
    }
    assert_eq!(
        x.sends(),
        vec![
            "send bwloop/t1 --",
            "send bwloop/t1 -",
            "send bwloop/t1 --text"
        ]
    );
}

#[test]
fn other_kind_is_refused_conversation() {
    let mut x = Scratch::new();
    x.located("claude", SID, PATH);
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!((code, sent(&line)), (0, "refused-conversation"));
    assert!(x.sends().is_empty());
}

#[test]
fn other_session_is_refused_conversation() {
    let mut x = Scratch::new();
    x.located("codex", "01a1b512-1f37-7941-98b2-00c2fc7b72f3", PATH);
    let (_, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(sent(&line), "refused-conversation");
    assert!(x.sends().is_empty());
}

#[test]
fn other_path_is_refused_conversation() {
    let mut x = Scratch::new();
    x.located("codex", SID, "/h/.codex/sessions/other.jsonl");
    let (_, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(sent(&line), "refused-conversation");
    assert!(x.sends().is_empty());
}

#[test]
fn no_log_or_no_agent_there_is_refused_conversation() {
    // A new conversation with no log yet, or the agent gone back to a shell: nothing confirms what is shown.
    for state in [
        json!({"type": "state", "state": "no_log", "agent": "codex", "message": "no codex session log yet"}),
        json!({"type": "state", "state": "not_agent", "message": "t1 runs zsh"}),
    ] {
        let mut x = Scratch::new();
        x.remote_says(state.clone());
        let (_, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
        assert_eq!(sent(&line), "refused-conversation", "{state}");
        assert!(x.sends().is_empty());
    }
}

#[test]
fn blocked_is_refused_prompt() {
    let mut x = Scratch::new();
    x.located("codex", SID, PATH);
    x.set("FAKE_HC_SEND_FAIL", "blocked");
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!((code, sent(&line)), (0, "refused-prompt"));
}

#[test]
fn finished_terminal_is_no_terminal() {
    for kind in ["finished", "not_found"] {
        let mut x = Scratch::new();
        x.located("codex", SID, PATH);
        x.set("FAKE_HC_SEND_FAIL", kind);
        let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
        assert_eq!(error(code, &line), "no_terminal", "{kind}");
    }
    let mut x = Scratch::new();
    x.remote_says(json!({"type": "state", "state": "no_terminal", "message": "t1 is finished"}));
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(error(code, &line), "no_terminal");
    assert!(x.sends().is_empty());
}

#[test]
fn unreachable_machine_is_named() {
    let mut x = Scratch::new();
    x.set("FAKE_HC_OFFLINE", "1");
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(error(code, &line), "unreachable");
    assert!(x.sends().is_empty());

    for kind in ["machine_unknown", "unavailable"] {
        let mut x = Scratch::new();
        x.located("codex", SID, PATH);
        x.set("FAKE_HC_SEND_FAIL", kind);
        let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
        assert_eq!(error(code, &line), "unreachable", "{kind}");
    }

    let mut x = Scratch::new();
    x.remote_says(json!({"type": "state", "state": "no_core", "message": "hc is not answering"}));
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(error(code, &line), "unreachable");
}

#[test]
fn missing_helper_there_is_named() {
    // No FAKE_HC_EXEC_OUT: the fake runs the helper script in an empty home, and sh cannot find bw.
    let x = Scratch::new();
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(error(code, &line), "missing");
    assert!(
        line["message"].as_str().unwrap().contains("bwloop"),
        "{line}"
    );
    assert!(x.sends().is_empty());
}

#[test]
fn an_older_helper_there_fails_closed() {
    let mut x = Scratch::new();
    x.remote_says(
        json!({"type": "error", "code": "usage", "message": "unknown option \"--fresh\""}),
    );
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!(error(code, &line), "failed");
    assert!(x.sends().is_empty());
}

#[test]
fn slow_send_is_unconfirmed() {
    let mut x = Scratch::new();
    x.located("codex", SID, PATH);
    x.set("FAKE_HC_SEND_SLEEP", "3");
    x.set("BW_SEND_TIMEOUT_S", "1");
    let start = Instant::now();
    let (code, line) = x.send("bwloop/t1", "codex", SID, PATH, "hi");
    assert_eq!((code, sent(&line)), (0, "unconfirmed"));
    assert!(
        start.elapsed() < Duration::from_millis(2500),
        "took {:?}",
        start.elapsed()
    );
}

#[test]
fn missing_expectations_are_usage() {
    let x = Scratch::new();
    let all = [
        ("--terminal", "bwloop/t1"),
        ("--expect-kind", "codex"),
        ("--expect-session", SID),
        ("--expect-path", PATH),
        ("--text", "hi"),
    ];
    for skip in 0..all.len() {
        let mut args = vec!["send"];
        for (i, (k, v)) in all.iter().enumerate() {
            if i != skip {
                args.extend([*k, *v]);
            }
        }
        let (code, lines) = x.run(&args);
        assert_eq!(code, 2, "without {}: {lines:?}", all[skip].0);
        assert_eq!(lines[0]["code"], "usage");
    }
    let (code, _) = x.run(&[
        "send",
        "--terminal",
        "t1",
        "--expect-kind",
        "codex",
        "--expect-session",
        SID,
        "--expect-path",
        PATH,
        "--text",
        "",
    ]);
    assert_eq!(code, 2, "an empty message is refused");
    let (code, _) = x.run(&[
        "send",
        "--terminal",
        "t1",
        "--expect-kind",
        "codex",
        "--expect-session",
        SID,
        "--expect-path",
        PATH,
        "--text",
        "hi",
        "--force",
    ]);
    assert_eq!(code, 2, "bw send takes no --force");
    assert!(x.sends().is_empty());
    assert!(x.log().is_empty(), "no hc call for a bad command line");
}

/// A process named `codex` with `CODEX_HOME` set, holding `files` open as Codex 0.167 holds its rollouts and
/// thread locks.
struct FakeCodex(Child);

impl FakeCodex {
    fn start(dir: &Path, home: &Path, files: &[PathBuf]) -> FakeCodex {
        let script = dir.join("bin/codex");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(
            &script,
            "#!/bin/sh\nfd=3\nfor f; do eval \"exec $fd<\\\"\\$f\\\"\"; fd=$((fd + 1)); done\nwhile :; do sleep 1; done\n",
        )
        .unwrap();
        let child = Command::new("/bin/sh")
            .arg(&script)
            .args(files)
            .env("CODEX_HOME", home)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        FakeCodex(child)
    }
}

impl Drop for FakeCodex {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A local Codex terminal `t7` holding the codex-subagent parent's rollout and lock, plus `extra` locks.
fn local_codex(x: &Scratch, extra: &[&str]) -> (FakeCodex, String) {
    let home = x.dir().join("codex-home");
    let day = home.join("sessions/2026/11/06");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let from =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/sessions/codex-subagent");
    std::fs::copy(from.join(PARENT), day.join(PARENT)).unwrap();
    let mut files = vec![day.join(PARENT)];
    for id in std::iter::once(SID).chain(extra.iter().copied()) {
        let lock = home.join(format!("thread-writer-locks/{id}.lock"));
        std::fs::write(&lock, "").unwrap();
        files.push(lock);
    }
    let codex = FakeCodex::start(&x.dir(), &home, &files);
    let pid = codex.0.id();
    std::fs::write(
        x.dir().join("gets/t7.json"),
        json!({"address": "t7", "argv": ["codex"], "cwd": "/scratch/codex-subagent", "pid": pid,
               "state": "live", "status": {"state": "idle"},
               "foreground": {"argv": ["codex"], "name": "codex", "pid": pid}})
        .to_string(),
    )
    .unwrap();
    // lsof sees the files only once the script has opened them all.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let (_, lines) = x.run(&["locate", "--terminal", "t7"]);
        if lines[0]["type"] == "located" || (!extra.is_empty() && lines[0]["state"] == "no_log") {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    (codex, day.join(PARENT).to_string_lossy().to_string())
}

#[test]
fn local_send_locates_in_process() {
    let x = Scratch::new();
    let (_codex, path) = local_codex(&x, &[]);
    let (code, line) = x.send("t7", "codex", SID, &path, "--force hello");
    assert_eq!((code, sent(&line)), (0, "sent"), "{line}");
    assert_eq!(x.sends(), vec!["send t7 --force hello"]);
    assert!(
        !x.log().iter().any(|l| l.starts_with("exec ")),
        "no hc exec for a local terminal"
    );
}

#[test]
fn local_new_thread_is_refused_conversation() {
    // Codex after `/new`: the old rollout still open, a newer thread lock with no rollout yet.
    let x = Scratch::new();
    let (_codex, path) = local_codex(&x, &["01a1b512-1f37-7941-98b2-00c2fc7b72f3"]);
    let (_, line) = x.send("t7", "codex", SID, &path, "hi");
    assert_eq!(sent(&line), "refused-conversation", "{line}");
    assert!(x.sends().is_empty());
}
