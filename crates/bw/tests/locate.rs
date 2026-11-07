//! `bw locate` and `bw feed --terminal` against tests/fake-hc, and once against a real process that holds a Codex
//! parent's and its sub-agent's rollouts open.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const PARENT: &str = "rollout-2026-11-06T22-11-05-01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc.jsonl";
const CHILD: &str = "rollout-2026-11-06T22-11-09-01a1b4a1-dfcb-77e0-8029-0fbb3b65e5ba.jsonl";
const PARENT_ID: &str = "01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc";

struct Scratch {
    tmp: tempfile::TempDir,
    env: Vec<(String, String)>,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("gets")).unwrap();
        Scratch { tmp, env: vec![] }
    }

    /// The real folder: lsof names files by it, so `CODEX_HOME` must too.
    fn dir(&self) -> PathBuf {
        self.tmp.path().canonicalize().unwrap()
    }

    fn get(&self, address: &str, record: Value) {
        std::fs::write(
            self.dir().join("gets").join(format!("{address}.json")),
            record.to_string(),
        )
        .unwrap();
    }

    fn bw(&self, args: &[&str]) -> Vec<Value> {
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env("BW_HC", fake)
            .env("FAKE_HC_GET_DIR", self.dir().join("gets"))
            .env("FAKE_HC_LOG", self.dir().join("hc.log"))
            .env("BW_CACHE_DIR", self.dir().join("cache"))
            .env("HC_SESSION", "bw-locate-test")
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR");
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        assert_eq!(out.status.code(), Some(0), "bw {args:?}");
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
            .collect()
    }

    fn state(&self, cmd: &str, t: &str) -> Value {
        let lines = if cmd == "feed" {
            self.bw(&["feed", "--terminal", t, "--pictures"])
        } else {
            self.bw(&["locate", "--terminal", t])
        };
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0]["type"], "state", "{lines:?}");
        lines[0].clone()
    }
}

#[test]
fn unknown_terminal_is_no_terminal() {
    let x = Scratch::new();
    for cmd in ["locate", "feed"] {
        assert_eq!(x.state(cmd, "t1")["state"], "no_terminal", "{cmd}");
    }
}

#[test]
fn a_shell_is_not_an_agent() {
    let x = Scratch::new();
    x.get(
        "t2",
        json!({"address": "t2", "argv": ["sh"], "pid": 10, "state": "live",
               "foreground": {"argv": ["sh"], "name": "sh", "pid": 10}}),
    );
    for cmd in ["locate", "feed"] {
        let s = x.state(cmd, "t2");
        assert_eq!(s["state"], "not_agent", "{cmd}");
        assert_eq!(s["message"], "t2 runs sh");
    }
}

#[test]
fn unreachable_hc_is_no_core() {
    let mut x = Scratch::new();
    x.env.push(("FAKE_HC_OFFLINE".into(), "1".into()));
    for cmd in ["locate", "feed"] {
        assert_eq!(x.state(cmd, "t1")["state"], "no_core", "{cmd}");
    }
    x.env = vec![("BW_HC".into(), "/nonexistent/hc".into())];
    assert_eq!(x.state("locate", "t1")["state"], "no_core");
}

#[test]
fn a_remote_address_is_refused_here() {
    let x = Scratch::new();
    let s = x.state("locate", "bwloop/t1");
    assert_eq!(s["state"], "no_terminal");
    assert!(s["message"].as_str().unwrap().contains("another machine"));
    let log = std::fs::read_to_string(x.dir().join("hc.log")).unwrap_or_default();
    assert_eq!(log, "", "no hc call for a terminal on another machine");
}

/// A process named `codex` (`/bin/sh <dir>/codex …`) with `CODEX_HOME` in its environment, holding both
/// rollouts open as Codex 0.167 does while a sub-agent runs.
struct FakeCodex(Child);

impl FakeCodex {
    fn start(dir: &Path, home: &Path, files: &[PathBuf]) -> FakeCodex {
        let script = dir.join("bin/codex");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(
            &script,
            "#!/bin/sh\nexec 3<\"$1\" 4<\"$2\"\nwhile :; do sleep 1; done\n",
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

#[test]
fn codex_terminal_is_located_through_its_open_rollout() {
    let x = Scratch::new();
    let home = x.dir().join("codex-home");
    let day = home.join("sessions/2026/11/06");
    std::fs::create_dir_all(&day).unwrap();
    let from =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/sessions/codex-subagent");
    for f in [PARENT, CHILD] {
        std::fs::copy(from.join(f), day.join(f)).unwrap();
    }
    let codex = FakeCodex::start(&x.dir(), &home, &[day.join(CHILD), day.join(PARENT)]);
    let pid = codex.0.id();
    x.get(
        "t7",
        json!({"address": "t7", "argv": ["codex"], "cwd": "/scratch/codex-subagent", "pid": pid,
               "state": "live", "status": {"state": "working"},
               "foreground": {"argv": ["codex"], "name": "codex", "pid": pid}}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let located = loop {
        let lines = x.bw(&["locate", "--terminal", "t7"]);
        if lines[0]["type"] == "located" || Instant::now() > deadline {
            break lines[0].clone();
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(located["type"], "located", "{located}");
    assert_eq!(located["agent"], "codex");
    assert_eq!(located["session"], PARENT_ID);
    assert_eq!(located["path"], day.join(PARENT).to_string_lossy().as_ref());
    assert_eq!(located["pid"], pid);
    assert_eq!(located["status"], "working");

    let lines = x.bw(&["feed", "--terminal", "t7", "--pictures"]);
    assert_eq!(lines[0]["type"], "log", "{lines:?}");
    assert_eq!(lines[0]["terminal"], "t7");
    assert_eq!(lines[0]["session"], PARENT_ID);
    assert_eq!(lines[0]["path"], located["path"]);
    assert_eq!(lines[1]["type"], "splice");
    assert!(lines.iter().any(|l| l["k"] == "user"), "{lines:?}");
}
