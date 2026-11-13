//! `bw hooks` and `bw machine setup`, against scratch homes only: never the user's own settings.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MARKER: &str = ": bellwether-hook=1;";
const EVENTS: [&str; 5] = [
    "PermissionRequest",
    "PreToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/hooks")
        .join(name)
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn command(agent: &str) -> String {
    format!(r#"{MARKER} sh "$HOME/.local/share/bellwether/hooks/bw-event" {agent}"#)
}

struct Home {
    tmp: tempfile::TempDir,
}

impl Home {
    fn new() -> Home {
        Home {
            tmp: tempfile::tempdir().unwrap(),
        }
    }

    /// A home holding copies of the two fixtures as its Claude settings and Codex hooks.
    fn with_fixtures() -> Home {
        let h = Home::new();
        std::fs::create_dir_all(h.claude().parent().unwrap()).unwrap();
        std::fs::create_dir_all(h.codex().parent().unwrap()).unwrap();
        std::fs::copy(fixture("settings-before.json"), h.claude()).unwrap();
        std::fs::copy(fixture("codex-hooks-before.json"), h.codex()).unwrap();
        h
    }

    fn path(&self) -> &Path {
        self.tmp.path()
    }

    fn claude(&self) -> PathBuf {
        self.path().join(".claude/settings.json")
    }

    fn codex(&self) -> PathBuf {
        self.path().join(".codex/hooks.json")
    }

    fn config(&self) -> PathBuf {
        self.path().join(".codex/config.toml")
    }

    fn script(&self) -> PathBuf {
        self.path().join(".local/share/bellwether/hooks/bw-event")
    }

    fn bw(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Vec<Value>) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env("HOME", self.path())
            .env("BW_CACHE_DIR", self.path().join("cache"))
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .env_remove("HC_TERMINAL_ID")
            .env_remove("HC_SESSION");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let lines = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
            .collect();
        (out.status.code().unwrap(), lines)
    }

    fn hooks(&self, args: &[&str]) -> (i32, Vec<Value>) {
        let mut all = vec!["hooks"];
        all.extend_from_slice(args);
        self.bw(&all, &[])
    }

    fn check(&self) -> Value {
        let (code, lines) = self.hooks(&["check"]);
        assert_eq!(code, 0, "{lines:?}");
        assert_eq!(lines.len(), 1, "{lines:?}");
        lines[0].clone()
    }

    fn read(&self, p: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    }

    fn backups(&self) -> Vec<PathBuf> {
        let dir = self.path().join(".local/share/bellwether/backups");
        let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        out.sort();
        out
    }
}

fn by_agent<'a>(lines: &'a [Value], ty: &str, agent: &str) -> &'a Value {
    lines
        .iter()
        .find(|l| l["type"] == ty && l["agent"] == agent)
        .unwrap_or_else(|| panic!("no {ty} line for {agent}: {lines:?}"))
}

fn ours(agent: &str, event: &str) -> Value {
    let hook = json!({"type": "command", "command": command(agent), "timeout": 5});
    if agent == "claude" && matches!(event, "PermissionRequest" | "PreToolUse") {
        json!({"matcher": "*", "hooks": [hook]})
    } else {
        json!({"hooks": [hook]})
    }
}

/// The settings with every Bellwether group taken out, and event arrays left empty by that dropped.
fn without_ours(mut v: Value) -> Value {
    if let Some(hooks) = v["hooks"].as_object_mut() {
        for (_, groups) in hooks.iter_mut() {
            groups.as_array_mut().unwrap().retain(|g| {
                !g["hooks"][0]["command"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with(MARKER)
            });
        }
        hooks.retain(|_, g| !g.as_array().unwrap().is_empty());
    }
    v
}

#[test]
fn apply_appends_after_existing_groups() {
    let h = Home::with_fixtures();
    let (code, lines) = h.hooks(&["apply"]);
    assert_eq!(code, 0, "{lines:?}");
    for agent in ["claude", "codex"] {
        let line = by_agent(&lines, "hooks-applied", agent);
        assert_eq!(line["changed"], true);
    }
    for (agent, file, before) in [
        ("claude", h.claude(), "settings-before.json"),
        ("codex", h.codex(), "codex-hooks-before.json"),
    ] {
        let after = h.read(&file);
        let before: Value =
            serde_json::from_slice(&std::fs::read(fixture(before)).unwrap()).unwrap();
        for event in EVENTS {
            let groups = after["hooks"][event].as_array().unwrap();
            assert_eq!(
                groups.last().unwrap(),
                &ours(agent, event),
                "{agent} {event}"
            );
            let theirs = before["hooks"][event]
                .as_array()
                .cloned()
                .unwrap_or_default();
            assert_eq!(
                groups[..groups.len() - 1],
                theirs[..],
                "{agent} {event} keeps its groups first"
            );
        }
        assert_eq!(
            without_ours(after.clone()),
            before,
            "{agent}: nothing else changed"
        );
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            text.ends_with("}\n") && text.contains("\n  \"hooks\": {\n"),
            "2-space JSON"
        );
    }
    use std::os::unix::fs::PermissionsExt;
    let script = std::fs::read(h.script()).unwrap();
    assert_eq!(
        script,
        std::fs::read(fixture("../../../hooks/bw-event")).unwrap()
    );
    assert_eq!(
        std::fs::metadata(h.script()).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert!(
        !h.config().exists(),
        "Bellwether never writes Codex's config.toml"
    );
}

#[test]
fn apply_twice_changes_nothing() {
    let h = Home::with_fixtures();
    assert_eq!(h.hooks(&["apply"]).0, 0);
    let claude = std::fs::read(h.claude()).unwrap();
    let codex = std::fs::read(h.codex()).unwrap();
    let backups = h.backups();
    let (code, lines) = h.hooks(&["apply"]);
    assert_eq!(code, 0);
    for agent in ["claude", "codex"] {
        let line = by_agent(&lines, "hooks-applied", agent);
        assert_eq!(line["changed"], false);
        assert_eq!(line["backup"], Value::Null);
    }
    assert_eq!(std::fs::read(h.claude()).unwrap(), claude);
    assert_eq!(std::fs::read(h.codex()).unwrap(), codex);
    assert_eq!(h.backups(), backups);
    let (_, lines) = h.hooks(&["diff"]);
    for agent in ["claude", "codex"] {
        let line = by_agent(&lines, "hooks-diff", agent);
        assert_eq!(line["changed"], false);
        assert_eq!(line["diff"], "");
    }
}

#[test]
fn remove_gives_back_the_original_bytes() {
    let h = Home::with_fixtures();
    assert_eq!(h.hooks(&["apply"]).0, 0);
    let (code, lines) = h.hooks(&["remove"]);
    assert_eq!(code, 0, "{lines:?}");
    for agent in ["claude", "codex"] {
        assert_eq!(by_agent(&lines, "hooks-removed", agent)["changed"], true);
    }
    assert_eq!(
        std::fs::read(h.claude()).unwrap(),
        std::fs::read(fixture("settings-before.json")).unwrap()
    );
    assert_eq!(
        std::fs::read(h.codex()).unwrap(),
        std::fs::read(fixture("codex-hooks-before.json")).unwrap()
    );
    let (_, lines) = h.hooks(&["remove"]);
    for agent in ["claude", "codex"] {
        assert_eq!(by_agent(&lines, "hooks-removed", agent)["changed"], false);
    }
}

#[test]
fn outdated_groups_are_replaced_and_mixed_groups_kept() {
    let h = Home::with_fixtures();
    let mut v = h.read(&h.claude());
    let old = json!({"hooks": [{"type": "command", "command": format!("{MARKER} sh old-path claude"), "timeout": 9}]});
    let mixed = json!({"hooks": [
        {"type": "command", "command": "~/mine.sh"},
        {"type": "command", "command": format!("{MARKER} sh old-path claude")}
    ]});
    v["hooks"]["SubagentStop"] = json!([old, mixed.clone()]);
    std::fs::write(h.claude(), serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    assert_eq!(h.check()["claude"], "outdated");
    assert_eq!(h.hooks(&["apply"]).0, 0);
    let groups = h.read(&h.claude())["hooks"]["SubagentStop"].clone();
    assert_eq!(groups, json!([mixed, ours("claude", "SubagentStop")]));
}

#[test]
fn missing_files_are_created() {
    let h = Home::new();
    assert_eq!(
        h.check(),
        json!({"type": "hooks", "claude": "missing", "codex": "missing", "agent": "missing"})
    );
    let (code, lines) = h.hooks(&["diff"]);
    assert_eq!(code, 0);
    assert_eq!(by_agent(&lines, "hooks-diff", "claude")["sha256"], "");
    let (code, lines) = h.hooks(&["apply", "--expect-sha", ","]);
    assert_eq!(code, 0, "{lines:?}");
    for agent in ["claude", "codex"] {
        let line = by_agent(&lines, "hooks-applied", agent);
        assert_eq!(line["changed"], true);
        assert_eq!(line["backup"], Value::Null, "nothing to back up");
    }
    for event in EVENTS {
        assert_eq!(
            h.read(&h.claude())["hooks"][event],
            json!([ours("claude", event)])
        );
        assert_eq!(
            h.read(&h.codex())["hooks"][event],
            json!([ours("codex", event)])
        );
    }
    let check = h.check();
    assert_eq!(check["claude"], "ok");
    assert_eq!(check["codex"], "untrusted");
    // Taking them out again leaves an empty object, not a file Claude cannot read.
    assert_eq!(h.hooks(&["remove"]).0, 0);
    assert_eq!(std::fs::read_to_string(h.claude()).unwrap(), "{}\n");
}

#[test]
fn environment_and_flags_pick_the_files() {
    let h = Home::new();
    let elsewhere = h.path().join("elsewhere");
    let claude_dir = h.path().join("claude-config");
    let codex_dir = h.path().join("codex-home");
    let (code, lines) = h.bw(
        &["hooks", "diff"],
        &[
            ("CLAUDE_CONFIG_DIR", claude_dir.to_str().unwrap()),
            ("CODEX_HOME", codex_dir.to_str().unwrap()),
        ],
    );
    assert_eq!(code, 0);
    assert_eq!(
        by_agent(&lines, "hooks-diff", "claude")["path"],
        claude_dir.join("settings.json").to_str().unwrap()
    );
    assert_eq!(
        by_agent(&lines, "hooks-diff", "codex")["path"],
        codex_dir.join("hooks.json").to_str().unwrap()
    );
    let a = elsewhere.join("a.json");
    let b = elsewhere.join("b.json");
    let (code, lines) = h.hooks(&[
        "diff",
        "--claude-settings",
        a.to_str().unwrap(),
        "--codex-hooks",
        b.to_str().unwrap(),
    ]);
    assert_eq!(code, 0);
    assert_eq!(
        by_agent(&lines, "hooks-diff", "claude")["path"],
        a.to_str().unwrap()
    );
    assert_eq!(
        by_agent(&lines, "hooks-diff", "codex")["path"],
        b.to_str().unwrap()
    );
}

#[test]
fn diff_shows_the_appended_groups() {
    let h = Home::with_fixtures();
    let (code, lines) = h.hooks(&["diff"]);
    assert_eq!(code, 0);
    let line = by_agent(&lines, "hooks-diff", "claude");
    assert_eq!(line["path"], h.claude().to_str().unwrap());
    assert_eq!(line["changed"], true);
    assert_eq!(
        line["sha256"],
        sha(&std::fs::read(fixture("settings-before.json")).unwrap())
    );
    let diff = line["diff"].as_str().unwrap();
    assert!(diff.starts_with("--- "), "{diff}");
    assert!(
        diff.contains("\n+            \"command\": \": bellwether-hook=1;"),
        "{diff}"
    );
    assert_eq!(
        std::fs::read(h.claude()).unwrap(),
        std::fs::read(fixture("settings-before.json")).unwrap(),
        "diff writes nothing"
    );
}

#[test]
fn invalid_settings_are_refused_untouched() {
    let h = Home::with_fixtures();
    let broken = b"{\n  \"hooks\": {\n";
    std::fs::write(h.claude(), broken).unwrap();
    for sub in ["apply", "diff", "remove"] {
        let (code, lines) = h.hooks(&[sub]);
        assert_eq!(code, 1, "{sub}: {lines:?}");
        let last = lines.last().unwrap();
        assert_eq!(last["type"], "error");
        assert_eq!(last["code"], "unreadable");
        let message = last["message"].as_str().unwrap();
        assert!(
            message.starts_with(&format!("cannot read {}: ", h.claude().display())),
            "{message}"
        );
        assert!(message.ends_with("; nothing changed"), "{message}");
        assert_eq!(std::fs::read(h.claude()).unwrap(), broken);
        assert_eq!(
            std::fs::read(h.codex()).unwrap(),
            std::fs::read(fixture("codex-hooks-before.json")).unwrap(),
            "{sub}: the other file is untouched too"
        );
    }
    for shape in [
        "[]",
        "{\"hooks\": []}",
        "{\"hooks\": {\"SubagentStop\": {}}}",
    ] {
        std::fs::write(h.claude(), shape).unwrap();
        let (code, lines) = h.hooks(&["apply"]);
        assert_eq!(
            (code, &lines.last().unwrap()["code"]),
            (1, &json!("unreadable")),
            "{shape}"
        );
        assert_eq!(std::fs::read_to_string(h.claude()).unwrap(), shape);
    }
    assert!(h.backups().is_empty());
    assert!(!h.script().exists());
}

#[test]
fn changed_since_diff_is_refused() {
    let h = Home::with_fixtures();
    let (_, lines) = h.hooks(&["diff"]);
    let expect = format!(
        "{},{}",
        by_agent(&lines, "hooks-diff", "claude")["sha256"]
            .as_str()
            .unwrap(),
        by_agent(&lines, "hooks-diff", "codex")["sha256"]
            .as_str()
            .unwrap()
    );
    let mut codex = std::fs::read(h.codex()).unwrap();
    codex.extend_from_slice(b"\n");
    std::fs::write(h.codex(), &codex).unwrap();
    let (code, lines) = h.hooks(&["apply", "--expect-sha", &expect]);
    assert_eq!(code, 1);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["code"], "changed_since_diff");
    assert!(lines[0]["message"]
        .as_str()
        .unwrap()
        .contains(h.codex().to_str().unwrap()));
    assert_eq!(
        std::fs::read(h.claude()).unwrap(),
        std::fs::read(fixture("settings-before.json")).unwrap()
    );
    assert_eq!(std::fs::read(h.codex()).unwrap(), codex);
    assert!(h.backups().is_empty());
    for bad in ["abc", "a,b,c"] {
        assert_eq!(h.hooks(&["apply", "--expect-sha", bad]).0, 2, "{bad}");
    }
    let (_, lines) = h.hooks(&["diff"]);
    let expect = format!(
        "{},{}",
        by_agent(&lines, "hooks-diff", "claude")["sha256"]
            .as_str()
            .unwrap(),
        by_agent(&lines, "hooks-diff", "codex")["sha256"]
            .as_str()
            .unwrap()
    );
    assert_eq!(h.hooks(&["apply", "--expect-sha", &expect]).0, 0);
}

#[test]
fn backup_and_install_record_are_written() {
    let h = Home::with_fixtures();
    let (_, lines) = h.hooks(&["apply"]);
    let backups = h.backups();
    assert_eq!(backups.len(), 2, "{backups:?}");
    for (agent, file, before) in [
        ("claude", h.claude(), "settings-before.json"),
        ("codex", h.codex(), "codex-hooks-before.json"),
    ] {
        let backup = PathBuf::from(
            by_agent(&lines, "hooks-applied", agent)["backup"]
                .as_str()
                .unwrap(),
        );
        assert!(backups.contains(&backup), "{backup:?}");
        let name = file.file_name().unwrap().to_str().unwrap();
        assert!(backup
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with(&format!("{name}.")));
        let original = std::fs::read(fixture(before)).unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        let record = h.read(
            &h.path()
                .join(".local/share/bellwether/hooks/installed.json"),
        );
        let r = &record[agent];
        assert_eq!(r["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(r["path"], file.to_str().unwrap());
        assert_eq!(r["sha256_before"], sha(&original));
        assert_eq!(r["sha256_after"], sha(&std::fs::read(&file).unwrap()));
        assert!(r["at_ms"].as_i64().unwrap() > 0);
    }
}

#[test]
fn symlinked_settings_stay_linked() {
    let h = Home::with_fixtures();
    let real = h.path().join("dotfiles/settings.json");
    std::fs::create_dir_all(real.parent().unwrap()).unwrap();
    std::fs::rename(h.claude(), &real).unwrap();
    std::os::unix::fs::symlink(&real, h.claude()).unwrap();
    assert_eq!(h.hooks(&["apply"]).0, 0);
    assert!(std::fs::symlink_metadata(h.claude())
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        h.read(&real)["hooks"]["SubagentStart"],
        json!([ours("claude", "SubagentStart")])
    );
}

fn trusted_config(h: &Home) -> String {
    std::fs::read_to_string(fixture("config-trusted.toml"))
        .unwrap()
        .replace("@HOOKS@", h.codex().to_str().unwrap())
}

#[test]
fn codex_untrusted_until_config_has_hashes() {
    let h = Home::with_fixtures();
    assert_eq!(h.hooks(&["apply"]).0, 0);
    let check = h.check();
    assert_eq!(check["claude"], "ok");
    assert_eq!(check["codex"], "untrusted");
    let trust = check["codex_trust"].as_array().unwrap();
    assert_eq!(trust.len(), 5, "{check}");
    let known: Value =
        serde_json::from_slice(&std::fs::read(fixture("codex-trusted-hash.json")).unwrap())
            .unwrap();
    for k in known["hooks"].as_array().unwrap() {
        let row = trust.iter().find(|r| r["event"] == k["event"]).unwrap();
        assert_eq!(
            row["expected"], k["trusted_hash"],
            "the hash Codex 0.167 wrote"
        );
        assert_eq!(row["found"], Value::Null);
    }
    let key = |event: &str| -> String {
        trust.iter().find(|r| r["event"] == event).unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        key("PreToolUse"),
        format!("{}:pre_tool_use:2:0", h.codex().display())
    );
    assert_eq!(
        key("SubagentStart"),
        format!("{}:subagent_start:1:0", h.codex().display())
    );

    let config = trusted_config(&h);
    std::fs::write(h.config(), &config).unwrap();
    assert_eq!(
        h.check(),
        json!({"type": "hooks", "claude": "ok", "codex": "ok", "agent": "missing"})
    );

    let wrong = config.replace("sha256:3143", "sha256:0000");
    std::fs::write(h.config(), &wrong).unwrap();
    let check = h.check();
    assert_eq!(check["codex"], "untrusted");
    let trust = check["codex_trust"].as_array().unwrap();
    assert_eq!(trust.len(), 1);
    assert_eq!(trust[0]["event"], "SubagentStart");
    assert!(trust[0]["found"]
        .as_str()
        .unwrap()
        .starts_with("sha256:0000"));

    let disabled = config.replace(
        ":subagent_stop:0:0\"]\n",
        ":subagent_stop:0:0\"]\nenabled = false\n",
    );
    assert_ne!(disabled, config);
    std::fs::write(h.config(), &disabled).unwrap();
    assert_eq!(
        h.check()["codex"],
        "untrusted",
        "a disabled hook never runs"
    );

    std::fs::write(h.config(), "not = [toml").unwrap();
    assert_eq!(h.check()["codex"], "untrusted");
    assert_eq!(
        std::fs::read_to_string(h.config()).unwrap(),
        "not = [toml",
        "check writes nothing"
    );
}

#[test]
fn outdated_script_is_named() {
    let h = Home::with_fixtures();
    assert_eq!(h.hooks(&["apply"]).0, 0);
    std::fs::write(h.config(), trusted_config(&h)).unwrap();
    assert_eq!(h.check()["codex"], "ok");
    std::fs::write(h.script(), "#!/bin/sh\nexit 0\n").unwrap();
    assert_eq!(
        h.check(),
        json!({"type": "hooks", "claude": "outdated", "codex": "outdated", "agent": "missing"})
    );
    std::fs::remove_file(h.script()).unwrap();
    assert_eq!(h.check()["claude"], "outdated");
    assert_eq!(h.hooks(&["apply"]).0, 0);
    assert_eq!(
        h.check(),
        json!({"type": "hooks", "claude": "ok", "codex": "ok", "agent": "missing"})
    );
}

#[test]
fn machine_setup_runs_here_for_local() {
    let h = Home::with_fixtures();
    let (code, lines) = h.bw(&["machine", "setup", "local", "--check"], &[]);
    assert_eq!(code, 0);
    assert_eq!(
        lines,
        vec![json!({"type": "hooks", "claude": "missing", "codex": "missing", "agent": "missing"})]
    );
    let (code, lines) = h.bw(&["machine", "setup", "local", "--apply"], &[]);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(by_agent(&lines, "hooks-applied", "claude")["changed"], true);
    for bad in [
        vec!["machine", "setup", "local"],
        vec!["machine", "setup", "local", "--check", "--diff"],
        vec!["machine", "setup", "--check"],
        vec![
            "machine",
            "setup",
            "local",
            "--check",
            "--expect-sha",
            "a,b",
        ],
    ] {
        assert_eq!(h.bw(&bad, &[]).0, 2, "{bad:?}");
    }
}

#[test]
fn machine_setup_relays_through_hc_exec() {
    let h = Home::with_fixtures();
    let remote = h.path().join("remote");
    let helper = remote.join(".local/share/bellwether/helper/current");
    std::fs::create_dir_all(&helper).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_bw"), helper.join("bw")).unwrap();
    let log = h.path().join("calls.log");
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
    let env = [
        ("BW_HC", fake.to_str().unwrap()),
        ("FAKE_HC_ROOT", remote.to_str().unwrap()),
        ("FAKE_HC_LOG", log.to_str().unwrap()),
    ];
    let (code, lines) = h.bw(&["machine", "setup", "loop", "--diff"], &env);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(
        by_agent(&lines, "hooks-diff", "claude")["path"],
        remote.join(".claude/settings.json").to_str().unwrap(),
        "that machine's paths"
    );
    assert_eq!(by_agent(&lines, "hooks-diff", "codex")["sha256"], "");
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("exec sh -c "), "{calls}");
    assert!(calls.trim_end().ends_with("sh hooks diff"), "{calls}");

    let (code, lines) = h.bw(
        &["machine", "setup", "loop", "--apply", "--expect-sha", ","],
        &env,
    );
    assert_eq!(code, 0, "{lines:?}");
    assert!(remote.join(".claude/settings.json").is_file());
    assert!(remote
        .join(".local/share/bellwether/hooks/bw-event")
        .is_file());
    assert_eq!(
        std::fs::read(h.claude()).unwrap(),
        std::fs::read(fixture("settings-before.json")).unwrap(),
        "this machine's settings are untouched"
    );

    std::fs::write(remote.join(".claude/settings.json"), "{ broken").unwrap();
    let (code, lines) = h.bw(&["machine", "setup", "loop", "--remove"], &env);
    assert_eq!(code, 1);
    assert_eq!(lines.last().unwrap()["code"], "unreadable");

    let (code, lines) = h.bw(
        &["machine", "setup", "loop", "--check"],
        &[env[0], env[1], env[2], ("FAKE_HC_OFFLINE", "1")],
    );
    assert_eq!(code, 1);
    assert_eq!(lines.last().unwrap()["code"], "unreachable");

    std::fs::remove_file(helper.join("bw")).unwrap();
    let (code, lines) = h.bw(&["machine", "setup", "loop", "--check"], &env);
    assert_eq!(code, 1);
    assert_eq!(lines.last().unwrap()["code"], "no_helper");
}
