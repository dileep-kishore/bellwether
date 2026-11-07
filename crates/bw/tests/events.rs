//! `bw event` and `hooks/bw-event`, run as Claude and Codex run them, against scratch homes only.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// A scratch home whose cache is `$HOME/.cache/bellwether`, as the hook sees it.
struct Home {
    tmp: tempfile::TempDir,
}

impl Home {
    fn new() -> Home {
        Home {
            tmp: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self) -> &Path {
        self.tmp.path()
    }

    fn events(&self) -> PathBuf {
        self.path().join(".cache/bellwether/events")
    }

    /// The test build as the installed helper, where the hook looks for it.
    fn install_helper(&self) {
        let dir = self.path().join(".local/share/bellwether/helper/current");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_bw"), dir.join("bw")).unwrap();
    }

    fn command(&self, program: &str, env: &[(&str, &str)]) -> Command {
        let mut cmd = Command::new(program);
        cmd.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.path());
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd
    }

    fn run(mut cmd: Command, stdin: &[u8]) -> Output {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        // The hook may exit before reading, as it does outside Herdr; a closed pipe is not a failure here.
        let _ = input.write_all(stdin);
        drop(input);
        child.wait_with_output().unwrap()
    }

    fn hook(&self, agent: &str, env: &[(&str, &str)], stdin: &[u8]) -> Output {
        let mut cmd = self.command("/bin/sh", env);
        cmd.arg(repo().join("hooks/bw-event")).arg(agent);
        Home::run(cmd, stdin)
    }

    fn event(&self, agent: &str, env: &[(&str, &str)], stdin: &[u8]) -> Output {
        let mut cmd = self.command(env!("CARGO_BIN_EXE_bw"), env);
        cmd.args(["event", "--agent", agent]);
        Home::run(cmd, stdin)
    }

    /// Every event file under `events/`, sorted by path.
    fn files(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(dirs) = std::fs::read_dir(self.events()) else {
            return out;
        };
        for d in dirs.flatten() {
            for f in std::fs::read_dir(d.path()).unwrap().flatten() {
                out.push(f.path());
            }
        }
        out.sort();
        out
    }

    fn only_event(&self) -> Value {
        let files = self.files();
        assert_eq!(files.len(), 1, "{files:?}");
        serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap()
    }
}

fn silent(out: &Output) {
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(
        out.stdout.is_empty(),
        "stdout: {:?}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        out.stderr.is_empty(),
        "stderr: {:?}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn payloads() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let sessions = repo().join("tests/fixtures/sessions");
    for s in std::fs::read_dir(sessions).unwrap().flatten() {
        let hooks = s.path().join("hooks");
        let Ok(files) = std::fs::read_dir(&hooks) else {
            continue;
        };
        let agent = if s.file_name().to_string_lossy().starts_with("codex") {
            "codex"
        } else {
            "claude"
        };
        for f in files.flatten() {
            out.push((agent.to_string(), f.path()));
        }
    }
    out.sort();
    assert!(out.len() >= 30, "recorded payloads: {}", out.len());
    out
}

const PERMISSION: &str =
    "../../tests/fixtures/sessions/claude-child-approval/hooks/a-PermissionRequest.json";

fn permission() -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(PERMISSION)).unwrap()
}

#[test]
fn each_recorded_payload_maps_to_an_event() {
    for (agent, file) in payloads() {
        let home = Home::new();
        let bytes = std::fs::read(&file).unwrap();
        let p: Value = serde_json::from_slice(&bytes).unwrap();
        let before = now_ms();
        silent(&home.event(
            &agent,
            &[("HC_TERMINAL_ID", "t5"), ("HC_SESSION", "bw-probe")],
            &bytes,
        ));
        let e = home.only_event();
        let name = file.display().to_string();
        assert_eq!(e["v"], 1, "{name}");
        assert_eq!(e["agent"], agent.as_str(), "{name}");
        assert_eq!(e["event"], p["hook_event_name"], "{name}");
        assert_eq!(e["terminal"], "t5", "{name}");
        assert_eq!(e["core"], "bw-probe", "{name}");
        assert_eq!(e["session"], p["session_id"], "{name}");
        assert_eq!(e["transcript"], p["transcript_path"], "{name}");
        assert_eq!(e["cwd"], p["cwd"], "{name}");
        // Claude's own helpers stop with an empty agent_type; it is kept for the reader to drop.
        assert_eq!(
            e["agent_id"],
            p.get("agent_id").cloned().unwrap_or(Value::Null),
            "{name}"
        );
        assert_eq!(
            e["agent_type"],
            p.get("agent_type").cloned().unwrap_or(Value::Null),
            "{name}"
        );
        assert_eq!(
            e["tool"],
            p.get("tool_name").cloned().unwrap_or(Value::Null),
            "{name}"
        );
        assert_eq!(
            e["tool_use_id"],
            p.get("tool_use_id").cloned().unwrap_or(Value::Null),
            "{name}"
        );
        let command = match &p["tool_input"] {
            Value::Null => Value::Null,
            input => input
                .get("command")
                .or_else(|| input.get("file_path"))
                .cloned()
                .unwrap_or_else(|| Value::String(serde_json::to_string(input).unwrap())),
        };
        assert_eq!(e["command"], command, "{name}");
        let at = e["at_ms"].as_i64().unwrap();
        assert!(at >= before && at <= now_ms(), "{name}");
        let id = e["id"].as_str().unwrap();
        assert!(id.starts_with(&format!("{at}-")), "{name}: {id}");
        let path = &home.files()[0];
        assert_eq!(path, &home.events().join("t5").join(format!("{id}.json")));
        let keys: Vec<&str> = e.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "v",
                "id",
                "at_ms",
                "agent",
                "event",
                "terminal",
                "core",
                "session",
                "transcript",
                "agent_id",
                "agent_type",
                "tool",
                "command",
                "tool_use_id",
                "cwd"
            ],
            "{name}: only decision 5's fields, never the transcript text"
        );
    }
}

#[test]
fn pre_tool_use_and_permission_request_pair_by_call() {
    let home = Home::new();
    let dir = repo().join("tests/fixtures/sessions/claude-child-approval/hooks");
    for f in ["a-PreToolUse-2.json", "a-PermissionRequest.json"] {
        let bytes = std::fs::read(dir.join(f)).unwrap();
        silent(&home.event("claude", &[("HC_TERMINAL_ID", "t5")], &bytes));
    }
    let events: Vec<Value> = home
        .files()
        .iter()
        .map(|f| serde_json::from_slice(&std::fs::read(f).unwrap()).unwrap())
        .collect();
    let [pre, ask] = events.as_slice() else {
        panic!("{events:?}")
    };
    assert_eq!(pre["event"], "PreToolUse");
    assert_eq!(ask["event"], "PermissionRequest");
    assert_eq!(pre["core"], "default", "no HC_SESSION is the default core");
    for k in ["session", "agent_id", "tool", "command"] {
        assert_eq!(pre[k], ask[k], "{k}");
    }
    assert!(pre["tool_use_id"].as_str().unwrap().starts_with("toolu_"));
    assert_eq!(ask["tool_use_id"], Value::Null);
}

#[test]
fn hook_writes_one_file_and_prints_nothing() {
    let home = Home::new();
    home.install_helper();
    let out = home.hook("claude", &[("HC_TERMINAL_ID", "t5")], &permission());
    silent(&out);
    let e = home.only_event();
    assert_eq!(e["terminal"], "t5");
    assert_eq!(e["command"], "touch fg.txt");
    assert_eq!(e["agent_id"], "a84924e78e12c62b3");
    let file = &home.files()[0];
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(file), 0o600);
    assert_eq!(mode(file.parent().unwrap()), 0o700);
    assert_eq!(mode(&home.events()), 0o700);
}

#[test]
fn outside_herdr_does_nothing() {
    let home = Home::new();
    home.install_helper();
    silent(&home.hook("claude", &[], &permission()));
    silent(&home.hook("codex", &[("HC_TERMINAL_ID", "")], &permission()));
    assert!(!home.path().join(".cache").exists());
}

#[test]
fn hook_without_helper_is_silent() {
    let home = Home::new();
    let start = Instant::now();
    silent(&home.hook("claude", &[("HC_TERMINAL_ID", "t5")], &vec![b'x'; 1 << 20]));
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(!home.path().join(".cache").exists());
}

#[test]
fn broken_payload_writes_nothing() {
    let home = Home::new();
    home.install_helper();
    let mut huge =
        b"{\"hook_event_name\":\"PermissionRequest\",\"tool_input\":{\"command\":\"".to_vec();
    huge.extend(vec![b'a'; 1 << 20]);
    for bad in [
        b"not json".to_vec(),
        b"[]".to_vec(),
        b"".to_vec(),
        br#"{"hook_event_name":"Stop","session_id":"s"}"#.to_vec(),
        br#"{"session_id":"s"}"#.to_vec(),
        huge,
    ] {
        let start = Instant::now();
        silent(&home.hook("claude", &[("HC_TERMINAL_ID", "t5")], &bad));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    assert!(home.files().is_empty(), "{:?}", home.files());
}

#[test]
fn large_payload_is_cut_and_fast() {
    let home = Home::new();
    home.install_helper();
    let mut p: Value = serde_json::from_slice(&permission()).unwrap();
    p["tool_input"]["command"] = Value::String("é".repeat(600_000));
    let bytes = serde_json::to_vec(&p).unwrap();
    assert!(bytes.len() > 1 << 20);
    let start = Instant::now();
    silent(&home.event("claude", &[("HC_TERMINAL_ID", "t5")], &bytes));
    // Decision 5's 200 ms is for the release helper; a debug build under parallel tests gets 1 s.
    let limit = Duration::from_millis(if cfg!(debug_assertions) { 1000 } else { 200 });
    assert!(start.elapsed() < limit, "{:?}", start.elapsed());
    let start = Instant::now();
    silent(&home.hook("claude", &[("HC_TERMINAL_ID", "t5")], &bytes));
    assert!(start.elapsed() < Duration::from_secs(1));
    for f in home.files() {
        let e: Value = serde_json::from_slice(&std::fs::read(f).unwrap()).unwrap();
        assert_eq!(e["command"].as_str().unwrap().chars().count(), 2000);
    }
    assert_eq!(home.files().len(), 2);
}

#[test]
fn over_4_mb_writes_nothing() {
    let home = Home::new();
    let mut p: Value = serde_json::from_slice(&permission()).unwrap();
    p["tool_input"]["command"] = Value::String("a".repeat(5 << 20));
    silent(&home.event(
        "claude",
        &[("HC_TERMINAL_ID", "t5")],
        &serde_json::to_vec(&p).unwrap(),
    ));
    assert!(home.files().is_empty());
}

#[test]
fn unwritable_cache_still_exits_0() {
    use std::os::unix::fs::PermissionsExt;
    let home = Home::new();
    home.install_helper();
    let cache = home.path().join(".cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o500)).unwrap();
    let start = Instant::now();
    silent(&home.hook("claude", &[("HC_TERMINAL_ID", "t5")], &permission()));
    silent(&home.event("claude", &[("HC_TERMINAL_ID", "t5")], &permission()));
    assert!(start.elapsed() < Duration::from_secs(1));
    std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(home.files().is_empty());
}

#[test]
fn terminal_with_slash_or_dots_is_ignored() {
    let home = Home::new();
    home.install_helper();
    for t in ["bwloop/t5", "..", "t5/../x", "a..b", "t 5", "t5\n"] {
        silent(&home.hook("claude", &[("HC_TERMINAL_ID", t)], &permission()));
        silent(&home.event("claude", &[("HC_TERMINAL_ID", t)], &permission()));
    }
    assert!(!home.path().join(".cache").exists());
}

#[test]
fn unknown_agent_is_a_usage_error_and_writes_nothing() {
    let home = Home::new();
    let out = home.event("grok", &[("HC_TERMINAL_ID", "t5")], &permission());
    assert_eq!(out.status.code(), Some(2));
    let line: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(line["code"], "usage");
    assert!(home.files().is_empty());
    // The hook hides even that.
    home.install_helper();
    silent(&home.hook("grok", &[("HC_TERMINAL_ID", "t5")], &permission()));
    assert!(home.files().is_empty());
}

#[test]
fn prune_keeps_2000_and_24h() {
    let home = Home::new();
    let now = now_ms();
    let t1 = home.events().join("t1");
    let t2 = home.events().join("t2");
    std::fs::create_dir_all(&t1).unwrap();
    std::fs::create_dir_all(&t2).unwrap();
    for i in 0..2005 {
        std::fs::write(t1.join(format!("{}-1-{i}.json", now - 60_000 + i)), "{}").unwrap();
    }
    for i in 0..3 {
        std::fs::write(
            t2.join(format!("{}-2-{i}.json", now - DAY_MS - 60_000)),
            "{}",
        )
        .unwrap();
    }
    silent(&home.event("claude", &[("HC_TERMINAL_ID", "t3")], &permission()));
    let files = home.files();
    assert_eq!(files.len(), 2000);
    assert!(
        std::fs::read_dir(&t2).unwrap().next().is_none(),
        "files older than 24 h go"
    );
    let names: Vec<String> = files
        .iter()
        .map(|f| f.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(
        files
            .iter()
            .any(|f| f.starts_with(home.events().join("t3"))),
        "the new event stays"
    );
    for i in 0..6 {
        let oldest = format!("{}-1-{i}.json", now - 60_000 + i);
        assert!(!names.contains(&oldest), "{oldest} is among the oldest");
    }
    assert!(names.contains(&format!("{}-1-6.json", now - 60_000 + 6)));
}
