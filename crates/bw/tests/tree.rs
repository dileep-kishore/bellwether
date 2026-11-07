//! The session tree (`bw tree`) and a sub-agent's own feed (`bw feed --session`, `--scope`) on the recorded
//! sub-agent sessions, copied to scratch folders laid out as each agent writes them.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// 2026-11-07T00:00:00Z, as `tests/feed.rs` uses, so separators and footers never depend on today.
const NOW_MS: i64 = 1_794_009_600_000;
const CORE: &str = "bw-tree-test";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn sessions(s: &str) -> PathBuf {
    fixtures().join("sessions").join(s)
}

fn expect(s: &str) -> Value {
    let text = std::fs::read_to_string(sessions(s).join("expect.json")).expect("expect.json");
    serde_json::from_str(&text).expect("expect.json is JSON")
}

/// What scrub-fixture left of the injected AGENTS.md message; `tests/feed.rs` explains why it goes back.
const SCRUBBED_AGENTS: &str =
    r#""type":"input_text","text":"[scrubbed: AGENTS.md instructions removed by scrub-fixture]""#;

fn as_written(log: &str) -> String {
    let mut text =
        r##""type":"input_text","text":"# AGENTS.md instructions, scrubbed"##.to_string();
    while text.len() < SCRUBBED_AGENTS.len() - 1 {
        text.push(' ');
    }
    text.push('"');
    log.replace(SCRUBBED_AGENTS, &text)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

struct Scratch {
    tmp: tempfile::TempDir,
    env: Vec<(String, String)>,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["gets", "home"] {
            std::fs::create_dir_all(tmp.path().join(d)).unwrap();
        }
        Scratch { tmp, env: vec![] }
    }

    /// The real folder: lsof names files by it.
    fn dir(&self) -> PathBuf {
        self.tmp.path().canonicalize().unwrap()
    }

    fn bw(&self, args: &[&str]) -> (i32, Vec<Value>) {
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env("BW_HC", fake)
            .env("FAKE_HC_GET_DIR", self.dir().join("gets"))
            .env("FAKE_HC_LOG", self.dir().join("hc.log"))
            .env("BW_CACHE_DIR", self.dir().join("cache"))
            .env("BW_NOW_MS", NOW_MS.to_string())
            .env("BW_TZ", "UTC")
            .env("HC_SESSION", CORE)
            .env("HOME", self.dir().join("home"))
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR");
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

    /// `bw …`, which must exit 0.
    fn ok(&self, args: &[&str]) -> Vec<Value> {
        let (code, lines) = self.bw(args);
        assert_eq!(code, 0, "bw {args:?}: {lines:?}");
        lines
    }

    /// A Claude recording under `<scratch>/claude/projects/-scratch-<s>/`: the root log and its `<id>/subagents/`.
    fn claude(&self, s: &str) -> PathBuf {
        let e = expect(s);
        let project = self.dir().join(format!("claude/projects/-scratch-{s}"));
        std::fs::create_dir_all(&project).unwrap();
        let file = e["file"].as_str().unwrap();
        std::fs::copy(sessions(s).join(file), project.join(file)).unwrap();
        let sid = e["session"].as_str().unwrap();
        copy_dir(&sessions(s).join(sid), &project.join(sid));
        project.join(file)
    }

    /// A Codex recording's rollouts under `<scratch>/<home>/sessions/YYYY/MM/DD/`, each in the folder its name dates.
    fn codex(&self, s: &str, home: &str) -> PathBuf {
        let e = expect(s);
        let mut names = vec![e["file"].as_str().unwrap().to_string()];
        for c in e["children"].as_array().unwrap() {
            names.push(c["file"].as_str().unwrap().to_string());
        }
        let sessions_dir = self.dir().join(home).join("sessions");
        for n in &names {
            let to = codex_day(&sessions_dir, n).join(n);
            std::fs::create_dir_all(to.parent().unwrap()).unwrap();
            let text = std::fs::read_to_string(sessions(s).join(n)).unwrap();
            std::fs::write(&to, as_written(&text)).unwrap();
        }
        codex_day(&sessions_dir, &names[0]).join(&names[0])
    }

    /// Terminal `t` runs `program` and the cache remembers `log` as its root, checked a second ago.
    fn located(&self, t: &str, program: &str, log: &Path, session: &str) {
        std::fs::write(
            self.dir().join(format!("gets/{t}.json")),
            json!({"address": t, "argv": ["/bin/zsh", "-l"], "cwd": "/scratch", "pid": 700, "state": "live",
                   "status": {"state": "idle"},
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

fn agent(s: &str) -> &'static str {
    if s.starts_with("codex") {
        "codex"
    } else {
        "claude"
    }
}

fn line<'a>(lines: &'a [Value], kind: &str) -> &'a Value {
    lines
        .iter()
        .find(|l| l["type"] == kind)
        .unwrap_or_else(|| panic!("no {kind} line in {lines:?}"))
}

fn rows(lines: &[Value]) -> Vec<Value> {
    lines
        .iter()
        .filter(|l| l["type"] == "row")
        .cloned()
        .collect()
}

fn count(rows: &[Value], k: &str) -> u64 {
    rows.iter().filter(|r| r["k"] == k).count() as u64
}

fn calls(rows: &[Value]) -> u64 {
    rows.iter()
        .filter(|r| r["k"] == "tools")
        .flat_map(|r| r["chips"].as_array().unwrap())
        .map(|c| c["calls"].as_array().unwrap().len() as u64)
        .sum::<u64>()
        + count(rows, "question")
}

/// The rows of a child match its hand counts in `expect.json`.
fn assert_counts(rows: &[Value], c: &Value, what: &str) {
    assert_eq!(count(rows, "user"), c["user_messages"], "{what} user");
    assert_eq!(
        count(rows, "assistant"),
        c["assistant_messages"],
        "{what} assistant"
    );
    assert_eq!(calls(rows), c["tool_calls"], "{what} tool calls");
    assert_eq!(count(rows, "perm"), 0, "{what}: every call has its result");
}

fn tree_of_log(x: &Scratch, log: &Path, agent: &str) -> Value {
    let lines = x.ok(&["tree", "--log", log.to_str().unwrap(), "--agent", agent]);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["type"], "tree", "{lines:?}");
    lines[0].clone()
}

fn children(tree: &Value) -> Vec<Value> {
    tree["children"].as_array().unwrap().clone()
}

/// The `--scope` a child file takes, from its recording.
fn scope_of(s: &str, c: &Value) -> String {
    if agent(s) == "claude" {
        "claude-subagent".into()
    } else {
        format!(
            "codex-child:{}",
            c["history_start_ordinal"].as_u64().unwrap_or(0)
        )
    }
}

fn child_file(s: &str, root: &Path, c: &Value) -> PathBuf {
    let name = c["file"].as_str().unwrap();
    if agent(s) == "claude" {
        root.parent().unwrap().join(name)
    } else {
        codex_day(root.ancestors().nth(4).unwrap(), name).join(name)
    }
}

const CLAUDE: [&str; 2] = ["claude-subagents", "claude-child-approval"];
const CODEX: [&str; 2] = ["codex-subagent", "codex-child-approval"];

#[test]
fn claude_tree_matches_expect() {
    for s in CLAUDE {
        let x = Scratch::new();
        let root = x.claude(s);
        let e = expect(s);
        let tree = tree_of_log(&x, &root, "claude");
        assert_eq!(tree["agent"], "claude");
        assert_eq!(tree["root"], e["session"]);
        let got = children(&tree);
        let want = e["children"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{s}: {got:#?}");
        // Start order, which is expect.json's order.
        for (g, w) in got.iter().zip(want) {
            for k in ["id", "parent", "depth", "type", "tool_use_id", "background"] {
                assert_eq!(g[k], w[k], "{s} {}: {k}", w["id"]);
            }
            assert_eq!(g["state"], "done", "{s}");
            assert!(g["started_ms"].is_i64(), "{s}: {g}");
            assert!(
                g["ended_ms"].as_i64() >= g["started_ms"].as_i64(),
                "{s}: {g}"
            );
            assert_eq!(g["nickname"], Value::Null);
        }
    }
    let x = Scratch::new();
    let tree = tree_of_log(&x, &x.claude("claude-subagents"), "claude");
    let nested = &children(&tree)[3];
    assert_eq!(nested["id"], "a640ed49983e1482a");
    assert_eq!(nested["parent"], "ad16657758350f019");
    assert_eq!(nested["description"], "Count files in current folder");
    // 2026-11-07T06:10:36.006Z, the child log's first line.
    assert_eq!(nested["started_ms"], 1_794_031_836_006_i64);
}

#[test]
fn claude_helper_agents_are_left_out() {
    // Claude's own helper agents carry an empty agent type; a meta file without its log is still a child.
    let x = Scratch::new();
    let root = x.claude("claude-subagents");
    let dir = root.with_extension("").join("subagents");
    std::fs::write(
        dir.join("agent-a0000000000000001.meta.json"),
        r#"{"agentType":"","description":"suggest","spawnDepth":1}"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("agent-a0000000000000002.meta.json"),
        r#"{"agentType":"counter","description":"just started","toolUseId":"toolu_x","spawnDepth":1,"requestShape":"foreground"}"#,
    )
    .unwrap();
    let ids: Vec<Value> = children(&tree_of_log(&x, &root, "claude"))
        .iter()
        .map(|c| c["id"].clone())
        .collect();
    assert_eq!(ids.len(), 5, "{ids:?}");
    assert!(!ids.contains(&json!("a0000000000000001")));
    assert!(ids.contains(&json!("a0000000000000002")));
}

#[test]
fn codex_tree_matches_expect() {
    for s in CODEX {
        let x = Scratch::new();
        let root = x.codex(s, "codex-home");
        let e = expect(s);
        let tree = tree_of_log(&x, &root, "codex");
        assert_eq!(tree["agent"], "codex");
        assert_eq!(tree["root"], e["session"]);
        let got = children(&tree);
        let want = e["children"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{s}: {got:#?}");
        for (g, w) in got.iter().zip(want) {
            assert_eq!(g["id"], w["id"], "{s}");
            assert_eq!(g["parent"], e["session"], "{s}");
            assert_eq!(g["depth"], 1, "{s}");
            let path = w["agent_path"].as_str().unwrap();
            assert_eq!(g["type"], path.rsplit('/').next().unwrap(), "{s}");
            assert_eq!(g["nickname"], w["nickname"], "{s}");
            assert_eq!(g["tool_use_id"], w["spawn_call_id"], "{s}");
            assert_eq!(g["background"], false, "{s}");
            assert_eq!(g["state"], "done", "{s}");
            // Codex 0.167 encrypts the spawn call's task text, which no description may show.
            assert_eq!(g["description"], "", "{s}");
            assert!(
                g["ended_ms"].as_i64() > g["started_ms"].as_i64(),
                "{s}: {g}"
            );
        }
    }
    let x = Scratch::new();
    let c = &children(&tree_of_log(&x, &x.codex("codex-subagent", "h"), "codex"))[0];
    assert_eq!(c["type"], "count_entries");
    assert_eq!(c["nickname"], "Hypatia");
    assert_eq!(c["started_ms"], 1_794_031_869_956_i64);
    assert_eq!(c["ended_ms"], 1_794_031_875_549_i64);
}

#[test]
fn child_rows_match_hand_counts() {
    for s in CLAUDE.iter().chain(&CODEX) {
        let x = Scratch::new();
        let root = if agent(s) == "claude" {
            x.claude(s)
        } else {
            x.codex(s, "codex-home")
        };
        for c in expect(s)["children"].as_array().unwrap() {
            let file = child_file(s, &root, c);
            let scope = scope_of(s, c);
            let lines = x.ok(&[
                "feed",
                "--log",
                file.to_str().unwrap(),
                "--agent",
                agent(s),
                "--scope",
                &scope,
                "--pictures",
            ]);
            assert_counts(&rows(&lines), c, &format!("{s} {}", c["id"]));
        }
    }
    // Without its scope a child file parses as the root does: empty for Claude, the parent's history for Codex.
    let x = Scratch::new();
    let root = x.claude("claude-subagents");
    let c = &expect("claude-subagents")["children"][0];
    let file = child_file("claude-subagents", &root, c);
    let lines = x.ok(&["feed", "--log", file.to_str().unwrap(), "--agent", "claude"]);
    assert!(rows(&lines).is_empty(), "{lines:?}");
    let root = x.codex("codex-subagent", "h");
    let c = &expect("codex-subagent")["children"][0];
    let file = child_file("codex-subagent", &root, c);
    let lines = x.ok(&["feed", "--log", file.to_str().unwrap(), "--agent", "codex"]);
    assert_eq!(count(&rows(&lines), "user"), 1, "{lines:?}");
}

#[test]
fn bad_scope_is_usage() {
    let x = Scratch::new();
    let root = x.claude("claude-subagents");
    let r = root.to_str().unwrap();
    for args in [
        vec!["feed", "--log", r, "--agent", "claude", "--scope", "child"],
        vec![
            "feed",
            "--log",
            r,
            "--agent",
            "codex",
            "--scope",
            "codex-child:x",
        ],
        vec![
            "feed",
            "--log",
            r,
            "--agent",
            "codex",
            "--scope",
            "claude-subagent",
        ],
        vec!["feed", "--log", r, "--agent", "claude", "--session", "a1"],
        vec!["feed", "--terminal", "t5", "--scope", "root"],
        vec!["tree"],
        vec!["tree", "--terminal", "t5", "--log", r],
    ] {
        let (code, lines) = x.bw(&args);
        assert_eq!(code, 2, "{args:?}: {lines:?}");
        assert_eq!(lines[0]["code"], "usage", "{args:?}");
    }
}

#[test]
fn running_child_reads_as_running() {
    let x = Scratch::new();
    let root = x.claude("claude-child-approval");
    let dir = root.with_extension("").join("subagents");
    std::fs::copy(
        sessions("claude-child-approval").join("running-a.meta.json"),
        dir.join("agent-a84924e78e12c62b3.meta.json"),
    )
    .unwrap();
    let got = children(&tree_of_log(&x, &root, "claude"));
    assert_eq!(got[0]["id"], "a84924e78e12c62b3");
    assert_eq!(got[0]["state"], "running");
    assert_eq!(got[0]["ended_ms"], Value::Null);
    assert_eq!(got[1]["state"], "done");

    let root = x.codex("codex-subagent", "h");
    let text = std::fs::read_to_string(&root).unwrap();
    let cut: String = text
        .split_inclusive('\n')
        .take_while(|l| !(l.contains("SubAgentActivity") && l.contains("\"completed\"")))
        .collect();
    std::fs::write(&root, cut).unwrap();
    let got = children(&tree_of_log(&x, &root, "codex"));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["state"], "running");
    assert_eq!(got[0]["ended_ms"], Value::Null);
}

#[test]
fn session_feed_names_root_and_child() {
    for s in CLAUDE.iter().chain(&CODEX) {
        let x = Scratch::new();
        let e = expect(s);
        let root = if agent(s) == "claude" {
            x.claude(s)
        } else {
            x.codex(s, "codex-home")
        };
        let sid = e["session"].as_str().unwrap();
        x.located("t5", agent(s), &root, sid);
        for c in e["children"].as_array().unwrap() {
            let id = c["id"].as_str().unwrap();
            let lines = x.ok(&[
                "feed",
                "--terminal",
                "t5",
                "--session",
                id,
                "--tree",
                "--pictures",
            ]);
            assert_eq!(lines[0]["type"], "tree", "{s}: {lines:?}");
            assert_eq!(lines[0]["root"], sid);
            let log = line(&lines, "log");
            assert_eq!(log["agent"], agent(s));
            assert_eq!(log["terminal"], "t5");
            assert_eq!(log["session"], sid, "{s}: the root");
            assert_eq!(log["child"], id, "{s}");
            assert_eq!(
                log["path"],
                child_file(s, &root, c).to_str().unwrap(),
                "{s}"
            );
            assert_counts(&rows(&lines), c, &format!("{s} {id} by --session"));
        }
        // The root's own feed carries no child, and --tree comes before its rows too.
        let lines = x.ok(&["feed", "--terminal", "t5", "--tree", "--pictures"]);
        assert_eq!(lines[0]["type"], "tree", "{s}");
        let log = line(&lines, "log");
        assert_eq!(log["path"], root.to_str().unwrap());
        assert!(log.get("child").is_none(), "{s}: {log}");
        assert_eq!(count(&rows(&lines), "user"), e["user_messages"], "{s}");

        let lines = x.ok(&["tree", "--terminal", "t5"]);
        assert_eq!(lines.len(), 1, "{s}: {lines:?}");
        assert_eq!(lines[0]["type"], "tree");
        assert_eq!(
            children(&lines[0]).len(),
            e["children"].as_array().unwrap().len()
        );
    }
}

#[test]
fn unknown_child_is_named() {
    let x = Scratch::new();
    let root = x.claude("claude-subagents");
    x.located(
        "t5",
        "claude",
        &root,
        "a9baa480-8207-4b0a-b31c-1a2d7b062db3",
    );
    let lines = x.ok(&[
        "feed",
        "--terminal",
        "t5",
        "--session",
        "nope",
        "--pictures",
    ]);
    assert_eq!(
        lines,
        vec![json!({"type": "state", "state": "no_child", "child": "nope"})]
    );
    // The root's own id is not a child either.
    let lines = x.ok(&[
        "feed",
        "--terminal",
        "t5",
        "--session",
        "a9baa480-8207-4b0a-b31c-1a2d7b062db3",
    ]);
    assert_eq!(lines[0]["state"], "no_child", "{lines:?}");
    let lines = x.ok(&["feed", "--terminal", "t5", "--session", "nope", "--tree"]);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0]["type"], "tree");
    assert_eq!(lines[1]["state"], "no_child");
}

/// A process named `codex` with `CODEX_HOME` set, holding `files` open as Codex 0.167 holds its rollouts and
/// thread locks (as in `tests/send.rs`).
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

    /// Terminal `t7` runs this process.
    fn terminal(&self, x: &Scratch) {
        let pid = self.0.id();
        std::fs::write(
            x.dir().join("gets/t7.json"),
            json!({"address": "t7", "argv": ["codex"], "cwd": "/scratch", "pid": pid,
                   "state": "live", "status": {"state": "idle"},
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

#[test]
fn root_state_line_passes_through() {
    const NEW: &str = "01a1b512-1f37-7941-98b2-00c2fc7b72f3";
    let x = Scratch::new();
    // A fresh Codex: a thread lock and no rollout, so no_log naming the new session.
    let home = x.dir().join("codex-home");
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let lock = home.join(format!("thread-writer-locks/{NEW}.lock"));
    std::fs::write(&lock, "").unwrap();
    let codex = FakeCodex::start(&x.dir(), &home, &[lock]);
    codex.terminal(&x);
    for args in [
        vec!["feed", "--terminal", "t7", "--tree", "--pictures"],
        vec!["feed", "--terminal", "t7", "--tree", "--session", "c1"],
        vec!["tree", "--terminal", "t7"],
    ] {
        let lines = x.ok(&args);
        assert_eq!(lines.len(), 1, "{args:?}: {lines:?}");
        assert_eq!(lines[0]["type"], "state", "{args:?}");
        assert_eq!(lines[0]["state"], "no_log", "{args:?}");
        assert_eq!(lines[0]["session"], NEW, "{args:?}");
    }
    drop(codex);

    // Two root threads open, as Codex 0.167 holds for 60 s after /resume: ambiguous.
    let x = Scratch::new();
    let root = x.codex("codex-subagent", "codex-home");
    let home = x.dir().join("codex-home");
    let text = std::fs::read_to_string(&root).unwrap();
    let mut meta: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    meta["payload"]["id"] = json!(NEW);
    let newer = root
        .parent()
        .unwrap()
        .join(format!("rollout-2026-11-06T22-30-00-{NEW}.jsonl"));
    std::fs::write(&newer, format!("{meta}\n")).unwrap();
    std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
    let mut files = vec![root.clone(), newer];
    for id in [expect("codex-subagent")["session"].as_str().unwrap(), NEW] {
        let lock = home.join(format!("thread-writer-locks/{id}.lock"));
        std::fs::write(&lock, "").unwrap();
        files.push(lock);
    }
    let codex = FakeCodex::start(&x.dir(), &home, &files);
    codex.terminal(&x);
    for args in [
        vec!["feed", "--terminal", "t7", "--tree", "--pictures"],
        vec!["tree", "--terminal", "t7"],
    ] {
        let lines = x.ok(&args);
        assert_eq!(lines.len(), 1, "{args:?}: {lines:?}");
        assert_eq!(lines[0]["state"], "ambiguous", "{args:?}");
    }
}

#[test]
fn codex_children_found_under_the_roots_own_home() {
    // macOS 27 hides the agent's CODEX_HOME: the children are found beside the root's own rollout.
    let x = Scratch::new();
    let root = x.codex("codex-subagent", "other-home");
    let tree = tree_of_log(&x, &root, "codex");
    assert_eq!(children(&tree).len(), 1, "{tree}");
    x.located(
        "t5",
        "codex",
        &root,
        expect("codex-subagent")["session"].as_str().unwrap(),
    );
    let lines = x.ok(&["tree", "--terminal", "t5"]);
    assert_eq!(children(&lines[0]).len(), 1, "{lines:?}");
}

#[test]
fn child_cursor_is_kept_apart_from_root() {
    let x = Scratch::new();
    let root = x.claude("claude-subagents");
    x.located(
        "t5",
        "claude",
        &root,
        "a9baa480-8207-4b0a-b31c-1a2d7b062db3",
    );
    let child = "ad16657758350f019";
    let feed = |cursor: Option<&str>, session: Option<&str>| {
        let mut args = vec!["feed", "--terminal", "t5", "--pictures"];
        if let Some(s) = session {
            args.extend(["--session", s]);
        }
        if let Some(c) = cursor {
            args.extend(["--cursor", c]);
        }
        x.ok(&args)
    };
    let cursor = |lines: &[Value]| line(lines, "log")["cursor"].as_str().unwrap().to_string();
    let r1 = feed(None, None);
    assert_eq!(line(&r1, "splice")["at"], 0);
    let c1 = feed(None, Some(child));
    assert_eq!(line(&c1, "splice")["at"], 0);
    assert_ne!(cursor(&r1), cursor(&c1));
    let r2 = feed(Some(&cursor(&r1)), None);
    assert_eq!(r2[1]["type"], "unchanged", "{r2:?}");
    let c2 = feed(Some(&cursor(&c1)), Some(child));
    assert_eq!(c2[1]["type"], "unchanged", "{c2:?}");
    // A root cursor names the root's path, so it never fits a child.
    let c3 = feed(Some(&cursor(&r1)), Some(child));
    assert_eq!(line(&c3, "splice")["at"], 0, "{c3:?}");
    let feeds = x.dir().join(format!("cache/feeds/{CORE}"));
    let mut names: Vec<String> = std::fs::read_dir(&feeds)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.contains(&"t5.json".to_string()), "{names:?}");
    assert!(
        names.iter().any(|n| n.starts_with("t5.") && n != "t5.json"),
        "{names:?}"
    );
}

/// A Codex rollout of thread `id` (child of `parent` at `depth` when given) listing `spawned` as its sub-agents.
fn synthetic_rollout(
    dir: &Path,
    id: &str,
    parent: Option<(&str, u64)>,
    spawned: &[&str],
) -> PathBuf {
    let ts = "2026-11-06T22:00:00.000Z";
    let mut meta = json!({"timestamp": ts, "ordinal": 0, "type": "session_meta",
        "payload": {"id": id, "timestamp": ts, "cwd": "/w", "source": "cli"}});
    if let Some((p, depth)) = parent {
        meta["payload"]["parent_thread_id"] = json!(p);
        meta["payload"]["source"] = json!({"subagent": {"thread_spawn": {"parent_thread_id": p, "depth": depth,
            "agent_path": format!("/root/task_{depth}"), "agent_nickname": format!("N{depth}")}}});
        meta["payload"]["agent_nickname"] = json!(format!("N{depth}"));
    }
    let mut lines = vec![meta];
    for (i, child) in spawned.iter().enumerate() {
        let call = format!("call_{id}_{i}");
        let task = "Count the entries in this folder and report the number, then stop. ".repeat(3);
        lines.push(
            json!({"timestamp": ts, "ordinal": 1 + 2 * i, "type": "response_item", "payload": {
            "type": "function_call", "name": "spawn_agent", "call_id": call,
            "arguments": json!({"task_name": "count", "message": task}).to_string()}}),
        );
        lines.push(json!({"timestamp": ts, "ordinal": 2 + 2 * i, "type": "event_msg", "payload": {
            "type": "item_completed", "thread_id": id, "item": {"type": "SubAgentActivity", "id": call,
            "kind": "started", "agent_thread_id": child, "agent_path": "/root/count"},
            "started_at_ms": 1_794_000_000_000_i64 + i as i64, "completed_at_ms": 1_794_000_000_000_i64 + i as i64}}));
    }
    let path = dir.join(format!("rollout-2026-11-06T22-00-00-{id}.jsonl"));
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(&path, text).unwrap();
    path
}

#[test]
fn codex_cycle_and_depth_are_bounded() {
    let id = |n: usize| format!("01a1b4a2-0000-7000-8000-{n:012}");
    let x = Scratch::new();
    let day = x.dir().join("codex-home/sessions/2026/11/06");
    std::fs::create_dir_all(&day).unwrap();
    // A child that names itself and the root as its own sub-agents.
    let root = synthetic_rollout(&day, &id(0), None, &[&id(1)]);
    synthetic_rollout(&day, &id(1), Some((&id(0), 1)), &[&id(1), &id(0)]);
    let got = children(&tree_of_log(&x, &root, "codex"));
    assert_eq!(got.len(), 1, "{got:#?}");
    assert_eq!(got[0]["id"], id(1));
    assert_eq!(got[0]["state"], "running");
    let d = got[0]["description"].as_str().unwrap();
    assert!(d.starts_with("Count the entries in this folder"), "{d}");
    assert_eq!(d.chars().count(), 120, "{d}");

    // A chain twelve deep: listed to depth 8, each id once, each under its parent.
    let x = Scratch::new();
    let day = x.dir().join("codex-home/sessions/2026/11/06");
    std::fs::create_dir_all(&day).unwrap();
    let root = synthetic_rollout(&day, &id(100), None, &[&id(101)]);
    for n in 1..=12 {
        let me = id(100 + n);
        let next = id(101 + n);
        synthetic_rollout(&day, &me, Some((&id(99 + n), n as u64)), &[&next]);
    }
    let got = children(&tree_of_log(&x, &root, "codex"));
    let depths: Vec<u64> = got.iter().map(|c| c["depth"].as_u64().unwrap()).collect();
    assert_eq!(depths, (1..=8).collect::<Vec<u64>>(), "{got:#?}");
    for (i, c) in got.iter().enumerate() {
        assert_eq!(c["parent"], id(100 + i), "{c}");
    }
}

/// The saved output, with the `log` line's `path` and `cursor` left out: they name the scratch copy.
fn golden_text(lines: &[Value]) -> String {
    lines
        .iter()
        .map(|l| {
            let mut l = l.clone();
            if l["type"] == "log" {
                l.as_object_mut()
                    .unwrap()
                    .retain(|k, _| k != "path" && k != "cursor");
            }
            format!("{l}\n")
        })
        .collect()
}

#[test]
fn child_goldens_are_current() {
    let bless = std::env::var("BW_BLESS").is_ok_and(|v| v == "1");
    let mut stale = vec![];
    for s in ["claude-subagents", "codex-subagent"] {
        let x = Scratch::new();
        let root = if agent(s) == "claude" {
            x.claude(s)
        } else {
            x.codex(s, "codex-home")
        };
        for c in expect(s)["children"].as_array().unwrap() {
            let file = child_file(s, &root, c);
            let scope = scope_of(s, c);
            let lines = x.ok(&[
                "feed",
                "--log",
                file.to_str().unwrap(),
                "--agent",
                agent(s),
                "--scope",
                &scope,
                "--pictures",
            ]);
            let got = golden_text(&lines);
            let name = format!("{s}-{}.jsonl", c["id"].as_str().unwrap());
            let golden = fixtures().join("feed/children").join(&name);
            if bless {
                std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
                std::fs::write(&golden, &got).unwrap();
            } else if std::fs::read_to_string(&golden).ok().as_deref() != Some(got.as_str()) {
                stale.push(name);
            }
        }
    }
    assert!(
        stale.is_empty(),
        "stale goldens {stale:?}: rerun with BW_BLESS=1 and review the diff"
    );
}
