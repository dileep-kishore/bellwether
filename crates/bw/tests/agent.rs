//! `bw agent ensure|args`, Codex's effective `developer_instructions`, and `bw machine setup --agent`, against
//! scratch homes and scratch `CODEX_HOME`s only: never the user's own settings.
//!
//! bw has no library target, so `codex.rs` is compiled into this test as a module of its own.

#[path = "../src/agent/codex.rs"]
mod codex;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const AGENT_DIR: &str = ".local/share/bellwether/agent";

fn repo(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn text(rel: &str) -> String {
    std::fs::read_to_string(repo(rel)).unwrap()
}

struct Home {
    tmp: tempfile::TempDir,
}

impl Home {
    /// A scratch home with a fake `npx` first on PATH, which logs its argv and prints the pinned version.
    fn new() -> Home {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let npx = bin.join("npx");
        std::fs::write(
            &npx,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_NPX_LOG\"\n\
             case \" $* \" in *' --version '*) echo 1.12.0 ;; esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o755)).unwrap();
        Home { tmp }
    }

    fn path(&self) -> PathBuf {
        std::fs::canonicalize(self.tmp.path()).unwrap()
    }

    fn agent(&self) -> PathBuf {
        self.path().join(AGENT_DIR)
    }

    fn npx_log(&self) -> String {
        std::fs::read_to_string(self.path().join("npx.log")).unwrap_or_default()
    }

    fn command(&self, program: &Path, args: &[&str], env: &[(&str, &str)]) -> Command {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(self.path())
            .env("HOME", self.path())
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.path().join("bin").display()),
            )
            .env("BW_NPX_FALLBACKS", "")
            .env("FAKE_NPX_LOG", self.path().join("npx.log"))
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("HC_SESSION")
            .env_remove("HC_TERMINAL_ID");
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd
    }

    fn bw(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Vec<Value>) {
        let out = self
            .command(Path::new(env!("CARGO_BIN_EXE_bw")), args, env)
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let lines = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
            .collect();
        (out.status.code().unwrap(), lines)
    }

    fn one(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Value) {
        let (code, lines) = self.bw(args, env);
        assert_eq!(lines.len(), 1, "{args:?}: {lines:?}");
        (code, lines[0].clone())
    }

    fn ensure(&self, args: &[&str]) -> Value {
        let mut all = vec!["agent", "ensure"];
        all.extend_from_slice(args);
        let (code, line) = self.one(&all, &[]);
        assert_eq!(code, 0, "{line}");
        assert_eq!(line["type"], "agent-files", "{line}");
        line
    }

    fn argv(&self, args: &[&str], env: &[(&str, &str)]) -> Vec<String> {
        let mut all = vec!["agent", "args"];
        all.extend_from_slice(args);
        let (code, line) = self.one(&all, env);
        assert_eq!(code, 0, "{line}");
        assert_eq!(line["type"], "agent-args", "{line}");
        line["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect()
    }

    /// A scratch `CODEX_HOME` beside the home, holding `config` as its `config.toml`.
    fn codex_home(&self, config: Option<&str>) -> PathBuf {
        let dir = self.path().join("codex-home");
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(c) = config {
            std::fs::write(dir.join("config.toml"), c).unwrap();
        }
        dir
    }
}

fn changed(line: &Value) -> Vec<String> {
    let mut out: Vec<String> = line["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect();
    out.sort();
    out
}

/// The `developer_instructions` value a Codex argv carries, parsed back as Codex parses a `-c` value.
fn developer_value(argv: &[String]) -> String {
    let pair = argv
        .iter()
        .find(|a| a.starts_with("developer_instructions="))
        .expect("a developer_instructions pair");
    let table: toml::Table = pair.parse().unwrap_or_else(|e| panic!("{pair}: {e}"));
    table["developer_instructions"]
        .as_str()
        .unwrap()
        .to_string()
}

fn sha(path: &Path) -> String {
    std::fs::read(path)
        .map(|b| {
            Sha256::digest(b)
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        })
        .unwrap_or_else(|_| "absent".into())
}

fn user_codex_config() -> PathBuf {
    Path::new(&std::env::var("HOME").unwrap()).join(".codex/config.toml")
}

/// Every developer message text item `codex debug prompt-input` renders, run in `cwd` with a scratch home.
fn prompt_input(codex_home: &Path, cwd: &Path, args: &[String]) -> Vec<String> {
    let scratch_home = codex_home.parent().unwrap().join("home");
    std::fs::create_dir_all(&scratch_home).unwrap();
    let out = Command::new("codex")
        .args(args)
        .args(["debug", "prompt-input"])
        .current_dir(cwd)
        .env("CODEX_HOME", codex_home)
        .env("HOME", &scratch_home)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "codex debug prompt-input: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let items: Value = serde_json::from_slice(&out.stdout).unwrap();
    items
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["type"] == "message" && i["role"] == "developer")
        .flat_map(|i| i["content"].as_array().cloned().unwrap_or_default())
        .filter_map(|c| c["text"].as_str().map(String::from))
        .collect()
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

const SENTINELS: [&str; 4] = [
    "BW-TOP-7Q2C",
    "BW-PFILE-4K8N",
    "BW-PROJ-9D3F",
    "BW-UNTR-5M1X",
];

#[test]
fn effective_value_matches_prompt_input() {
    if Command::new("codex").arg("--version").output().is_err() {
        eprintln!("skipped: codex is not on PATH, so prompt-input cannot be compared");
        return;
    }
    let user_config = user_codex_config();
    let before = sha(&user_config);
    eprintln!("~/.codex/config.toml sha256 before: {before}");
    // (layout, folder under project/ to run in, profile, the one sentinel Codex renders)
    let cases = [
        ("top", "", None, "BW-TOP-7Q2C"),
        ("profile", "", Some("bwq"), "BW-PFILE-4K8N"),
        ("trusted-root", "", None, "BW-PROJ-9D3F"),
        ("trusted-sub", "sub", None, "BW-PROJ-9D3F"),
        ("untrusted", "", None, "BW-TOP-7Q2C"),
    ];
    let h = Home::new();
    let ours = text("agent/browser-codex.md");
    for (layout, sub, profile, sentinel) in cases {
        let root = h.path().join(layout);
        copy_tree(
            &repo(&format!("tests/fixtures/codex-config/{layout}")),
            &root,
        );
        let config = root.join("codex-home/config.toml");
        let filled = std::fs::read_to_string(&config)
            .unwrap()
            .replace("@ROOT@", root.to_str().unwrap());
        std::fs::write(&config, filled).unwrap();
        let project = root.join("project");
        let git = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap();
        assert!(git.success());
        let cwd = project.join(sub);
        let codex_home = root.join("codex-home");

        let value = codex::effective(&codex_home, &cwd, profile)
            .unwrap()
            .unwrap_or_else(|| panic!("{layout}: no value"));
        assert!(value.contains(sentinel), "{layout}: {value:?}");
        let profile_args: Vec<String> = profile
            .map(|p| vec!["-p".to_string(), p.to_string()])
            .unwrap_or_default();
        let rendered = prompt_input(&codex_home, &cwd, &profile_args);
        assert!(
            rendered.contains(&value),
            "{layout}: prompt-input does not render {value:?} as a developer item"
        );
        for other in SENTINELS.iter().filter(|s| **s != sentinel) {
            assert!(
                !rendered.iter().any(|t| t.contains(other)),
                "{layout}: {other} rendered"
            );
        }

        let mut args = vec![
            "--kind",
            "codex",
            "--window",
            "w1",
            "--cwd",
            cwd.to_str().unwrap(),
        ];
        if let Some(p) = profile {
            args.extend(["--profile", p]);
        }
        let codex_home_s = codex_home.to_str().unwrap().to_string();
        let argv = h.argv(&args, &[("CODEX_HOME", &codex_home_s)]);
        let pair = argv
            .iter()
            .position(|a| a.starts_with("developer_instructions="))
            .unwrap();
        let mut with_ours = profile_args.clone();
        with_ours.extend(argv[pair - 1..=pair].iter().cloned());
        let rendered = prompt_input(&codex_home, &cwd, &with_ours);
        let want = format!("{value}\n\n{ours}");
        assert!(
            rendered.contains(&want),
            "{layout}: prompt-input with bw's flag does not render the value, a blank line and ours"
        );
        assert!(rendered.iter().any(|t| t.contains("## Bellwether browser")));
    }
    let after = sha(&user_config);
    eprintln!("~/.codex/config.toml sha256 after: {after}");
    assert_eq!(before, after, "the user's Codex config is unchanged");
}

#[test]
fn multiline_and_quotes_round_trip() {
    let h = Home::new();
    let value = "Line one with \"quotes\" and a backslash \\.\n\
                 Triple quotes: \"\"\" and ''' inside.\n\ttabbed, a DEL \u{7f} and unicode \u{e9}\n";
    let mut table = toml::Table::new();
    table.insert(
        "developer_instructions".into(),
        toml::Value::String(value.into()),
    );
    let codex_home = h.codex_home(Some(&toml::to_string(&table).unwrap()));
    let argv = h.argv(
        &[
            "--kind",
            "codex",
            "--window",
            "w1",
            "--cwd",
            h.path().to_str().unwrap(),
        ],
        &[("CODEX_HOME", codex_home.to_str().unwrap())],
    );
    assert_eq!(
        developer_value(&argv),
        format!("{value}\n\n{}", text("agent/browser-codex.md"))
    );
}

#[test]
fn unreadable_config_adds_nothing() {
    let h = Home::new();
    let codex_home = h.codex_home(Some("not = [toml"));
    let env = [("CODEX_HOME", codex_home.to_str().unwrap())];
    let cwd = h.path().join("project");
    std::fs::create_dir_all(cwd.join(".codex")).unwrap();
    let args = [
        "agent",
        "args",
        "--kind",
        "codex",
        "--window",
        "w1",
        "--cwd",
        cwd.to_str().unwrap(),
    ];
    let (code, line) = h.one(&args, &env);
    assert_eq!(code, 1);
    assert_eq!(line["type"], "error");
    assert_eq!(line["code"], "codex_config_unreadable");
    assert!(line.get("argv").is_none());
    assert_eq!(
        std::fs::read_to_string(codex_home.join("config.toml")).unwrap(),
        "not = [toml"
    );

    let trust = format!(
        "developer_instructions = \"top\"\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
        cwd.display()
    );
    std::fs::write(codex_home.join("config.toml"), trust).unwrap();
    std::fs::write(cwd.join(".codex/config.toml"), "broken = \"").unwrap();
    let (code, line) = h.one(&args, &env);
    assert_eq!(code, 1);
    assert_eq!(
        line["code"], "codex_config_unreadable",
        "a trusted layer that does not parse"
    );

    std::fs::write(
        codex_home.join("config.toml"),
        "developer_instructions = 5\n",
    )
    .unwrap();
    let (code, line) = h.one(&args, &env);
    assert_eq!(code, 1);
    assert_eq!(
        line["code"], "codex_config_unreadable",
        "a value that is not a string"
    );
}

#[test]
fn profile_flag_selects_the_profile_file() {
    let h = Home::new();
    let codex_home = h.codex_home(Some("developer_instructions = \"top value\"\n"));
    std::fs::write(
        codex_home.join("bwq.config.toml"),
        "developer_instructions = \"profile value\"\n",
    )
    .unwrap();
    let env = [("CODEX_HOME", codex_home.to_str().unwrap())];
    let cwd = h.path();
    let ours = text("agent/browser-codex.md");
    let base = [
        "--kind",
        "codex",
        "--window",
        "w1",
        "--cwd",
        cwd.to_str().unwrap(),
    ];
    let value = |extra: &[&str]| {
        let mut args = base.to_vec();
        args.extend_from_slice(extra);
        developer_value(&h.argv(&args, &env))
    };
    assert_eq!(value(&[]), format!("top value\n\n{ours}"));
    assert_eq!(
        value(&["--profile", "bwq"]),
        format!("profile value\n\n{ours}")
    );
    assert_eq!(
        value(&["--profile", "other"]),
        format!("top value\n\n{ours}")
    );
    let mut bad = vec!["agent", "args"];
    bad.extend_from_slice(&base);
    bad.extend(["--profile", "../bwq"]);
    assert_eq!(h.bw(&bad, &env).0, 2, "a profile name is not a path");
}

#[test]
fn no_value_gives_ours_alone() {
    let h = Home::new();
    let ours = text("agent/browser-codex.md");
    let cwd = h.path();
    let args = [
        "--kind",
        "codex",
        "--window",
        "w1",
        "--cwd",
        cwd.to_str().unwrap(),
    ];
    let codex_home = h.path().join("codex-home");
    let env = [("CODEX_HOME", codex_home.to_str().unwrap())];
    assert_eq!(
        developer_value(&h.argv(&args, &env)),
        ours,
        "no config.toml"
    );
    h.codex_home(Some("model = \"gpt-6-luna\"\n"));
    assert_eq!(
        developer_value(&h.argv(&args, &env)),
        ours,
        "a config.toml without the key"
    );

    std::fs::create_dir_all(h.path().join(".codex")).unwrap();
    std::fs::write(
        h.path().join(".codex/config.toml"),
        "developer_instructions = \"from HOME/.codex\"\n",
    )
    .unwrap();
    assert_eq!(
        developer_value(&h.argv(&args, &[])),
        format!("from HOME/.codex\n\n{ours}"),
        "without CODEX_HOME, ~/.codex"
    );
}

#[test]
fn claude_args_are_exact_and_have_no_strict_flag() {
    let h = Home::new();
    let argv = h.argv(
        &[
            "--kind",
            "claude",
            "--window",
            "w1",
            "--cwd",
            h.path().to_str().unwrap(),
        ],
        &[],
    );
    let dir = h.agent();
    assert_eq!(
        argv,
        vec![
            "--mcp-config".to_string(),
            dir.join("claude-mcp-w1.json").display().to_string(),
            "--allowedTools".into(),
            "mcp__bw-browser".into(),
            "--append-system-prompt-file".into(),
            dir.join("browser-claude.md").display().to_string(),
        ]
    );
    assert!(!argv.iter().any(|a| a.contains("strict")));
}

#[test]
fn codex_args_pair_each_c_with_its_value() {
    let h = Home::new();
    let codex_home = h.path().join("codex-home");
    let argv = h.argv(
        &[
            "--kind",
            "codex",
            "--window",
            "w1",
            "--cwd",
            h.path().to_str().unwrap(),
        ],
        &[("CODEX_HOME", codex_home.to_str().unwrap())],
    );
    assert_eq!(argv.len(), 10, "{argv:?}");
    for (i, a) in argv.iter().enumerate() {
        assert_eq!(a == "-c", i % 2 == 0, "{i}: {a}");
    }
    let launcher = h.agent().join("browser-mcp");
    assert_eq!(
        argv[1..8].iter().step_by(2).collect::<Vec<_>>(),
        vec![
            "mcp_servers.bw-browser.command=\"sh\"",
            &format!(
                "mcp_servers.bw-browser.args=[\"{}\",\"w1\"]",
                launcher.display()
            ),
            "mcp_servers.bw-browser.default_tools_approval_mode=\"approve\"",
            "mcp_servers.bw-browser.startup_timeout_sec=60",
        ]
    );
    assert!(argv[9].starts_with("developer_instructions=\""));
    let args: toml::Table = argv[3].parse().unwrap();
    assert_eq!(
        args["mcp_servers"]["bw-browser"]["args"],
        toml::Value::Array(vec![
            toml::Value::String(launcher.display().to_string()),
            toml::Value::String("w1".into())
        ])
    );
}

#[test]
fn args_without_node_is_named() {
    let h = Home::new();
    std::fs::remove_file(h.path().join("bin/npx")).unwrap();
    let args = [
        "agent", "args", "--kind", "claude", "--window", "w1", "--cwd", "/",
    ];
    let (code, line) = h.one(&args, &[]);
    assert_eq!(code, 1);
    assert_eq!(line["code"], "node_missing");
    let fallback = h.path().join("node/bin/npx");
    std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();
    std::fs::write(&fallback, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&fallback, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (code, line) = h.one(&args, &[("BW_NPX_FALLBACKS", fallback.to_str().unwrap())]);
    assert_eq!(code, 0, "{line}");
}

#[test]
fn ensure_writes_once_then_changes_nothing() {
    let h = Home::new();
    let line = h.ensure(&["--window", "w1"]);
    assert_eq!(
        changed(&line),
        vec![
            "browser-claude.md",
            "browser-codex.md",
            "browser-mcp",
            "browser.md",
            "claude-mcp-w1.json",
        ]
    );
    assert_eq!(line["warm"], "done");
    let dir = h.agent();
    for name in [
        "browser.md",
        "browser-claude.md",
        "browser-codex.md",
        "browser-mcp",
    ] {
        assert_eq!(
            std::fs::read_to_string(dir.join(name)).unwrap(),
            text(&format!("agent/{name}")),
            "{name}"
        );
    }
    let mode = |n: &str| std::fs::metadata(dir.join(n)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode("browser-mcp"), 0o755);
    assert_eq!(mode("browser.md"), 0o644);
    let mcp: Value =
        serde_json::from_slice(&std::fs::read(dir.join("claude-mcp-w1.json")).unwrap()).unwrap();
    assert_eq!(
        mcp,
        json!({"mcpServers": {"bw-browser": {"type": "stdio", "command": "sh",
            "args": [dir.join("browser-mcp"), "w1"]}}})
    );
    assert!(dir.join("warm-1.12.0").is_file());
    assert_eq!(h.npx_log(), "-y chrome-devtools-mcp@1.12.0 --version\n");

    let line = h.ensure(&["--window", "w1"]);
    assert_eq!(changed(&line), Vec::<String>::new());
    assert_eq!(line["warm"], "skipped");
    assert_eq!(h.npx_log().lines().count(), 1, "warmed once");

    std::fs::set_permissions(
        dir.join("browser-mcp"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(changed(&h.ensure(&["--window", "w1"])), vec!["browser-mcp"]);
    assert_eq!(mode("browser-mcp"), 0o755);

    for bad in [
        vec!["agent", "ensure"],
        vec!["agent", "ensure", "--window", "../x"],
        vec!["agent", "ensure", "--window", "W1"],
        vec!["agent", "ensure", "--window", "w1", "--port", "0"],
        vec!["agent", "ensure", "--window", "w1", "--port", "70000"],
        vec!["agent", "nope"],
    ] {
        assert_eq!(h.bw(&bad, &[]).0, 2, "{bad:?}");
    }
}

#[test]
fn warm_failure_is_retried() {
    let h = Home::new();
    std::fs::remove_file(h.path().join("bin/npx")).unwrap();
    assert_eq!(h.ensure(&["--window", "w1"])["warm"], "failed");
    assert!(!h.agent().join("warm-1.12.0").exists());
    let bin = h.path().join("bin");
    std::fs::write(
        bin.join("npx"),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_NPX_LOG\"\necho 1.12.0\n",
    )
    .unwrap();
    std::fs::set_permissions(bin.join("npx"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(h.ensure(&["--window", "w1"])["warm"], "done");
}

#[test]
fn ensure_writes_the_port_per_window() {
    let h = Home::new();
    let line = h.ensure(&["--window", "w1", "--port", "52817"]);
    assert!(changed(&line).contains(&"ports/w1".to_string()), "{line}");
    let line = h.ensure(&["--window", "w2", "--port", "52818"]);
    assert_eq!(changed(&line), vec!["claude-mcp-w2.json", "ports/w2"]);
    let dir = h.agent();
    assert_eq!(
        std::fs::read_to_string(dir.join("ports/w1")).unwrap(),
        "52817\n"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("ports/w2")).unwrap(),
        "52818\n"
    );
    assert_eq!(
        changed(&h.ensure(&["--window", "w1", "--port", "52819"])),
        vec!["ports/w1"]
    );

    let out = h
        .command(
            Path::new("sh"),
            &[dir.join("browser-mcp").to_str().unwrap(), "w1"],
            &[],
        )
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        h.npx_log()
            .contains("-y chrome-devtools-mcp@1.12.0 --browserUrl http://127.0.0.1:52819 "),
        "{}",
        h.npx_log()
    );
}

#[test]
fn ensure_without_port_leaves_the_port_file() {
    let h = Home::new();
    h.ensure(&["--window", "w1", "--port", "52817"]);
    let line = h.ensure(&["--window", "w1"]);
    assert_eq!(changed(&line), Vec::<String>::new());
    assert_eq!(
        std::fs::read_to_string(h.agent().join("ports/w1")).unwrap(),
        "52817\n"
    );
    let fresh = Home::new();
    fresh.ensure(&["--window", "w3"]);
    assert!(!fresh.agent().join("ports").join("w3").exists());
}

#[test]
fn hooks_check_names_the_agent_files() {
    let h = Home::new();
    let check = || {
        let (code, line) = h.one(&["hooks", "check"], &[]);
        assert_eq!(code, 0, "{line}");
        line
    };
    assert_eq!(
        check(),
        json!({"type": "hooks", "claude": "missing", "codex": "missing", "agent": "missing"})
    );
    h.ensure(&["--window", "w1"]);
    assert_eq!(check()["agent"], "ok");
    std::fs::write(h.agent().join("browser-mcp"), "#!/bin/sh\nexit 0\n").unwrap();
    assert_eq!(check()["agent"], "outdated");
    std::fs::remove_file(h.agent().join("browser-mcp")).unwrap();
    assert_eq!(check()["agent"], "outdated", "one file of four missing");
    h.ensure(&["--window", "w1"]);
    assert_eq!(check()["agent"], "ok");
}

fn remote_with_helper(h: &Home) -> (PathBuf, PathBuf) {
    let remote = h.path().join("remote");
    let helper = remote.join(".local/share/bellwether/helper/current");
    std::fs::create_dir_all(&helper).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_bw"), helper.join("bw")).unwrap();
    (remote, helper)
}

#[test]
fn machine_setup_agent_relays_through_hc_exec() {
    let h = Home::new();
    let (remote, helper) = remote_with_helper(&h);
    let log = h.path().join("calls.log");
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
    let (remote_s, log_s) = (remote.to_str().unwrap(), log.to_str().unwrap());
    let env = [
        ("BW_HC", fake.to_str().unwrap()),
        ("FAKE_HC_ROOT", remote_s),
        ("FAKE_HC_LOG", log_s),
    ];
    let (code, lines) = h.bw(&["machine", "setup", "loop", "--agent"], &env);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["type"], "agent-files");
    assert_eq!(lines[0]["warm"], "done");
    let calls = std::fs::read_to_string(&log).unwrap();
    let last = calls.trim_end().lines().last().unwrap();
    assert!(last.starts_with("exec sh -c "), "{calls}");
    let window = last
        .split(" sh agent ensure --window ")
        .nth(1)
        .unwrap_or_else(|| panic!("{calls}"));
    assert!(
        !window.is_empty()
            && window.len() <= 32
            && window
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "{window:?}"
    );
    let dir = remote.join(AGENT_DIR);
    assert!(dir.join("browser-mcp").is_file());
    assert!(dir.join(format!("claude-mcp-{window}.json")).is_file());
    assert!(!dir.join("ports").exists(), "setup knows no port");
    assert!(!h.agent().exists(), "this machine's files are untouched");

    let (code, lines) = h.bw(
        &["machine", "setup", "loop", "--agent"],
        &[env[0], env[1], env[2], ("FAKE_HC_OFFLINE", "1")],
    );
    assert_eq!(code, 1);
    assert_eq!(lines.last().unwrap()["code"], "unreachable");

    std::fs::remove_file(helper.join("bw")).unwrap();
    let (code, lines) = h.bw(&["machine", "setup", "loop", "--agent"], &env);
    assert_eq!(code, 1);
    assert_eq!(lines.last().unwrap()["code"], "no_helper");
}

#[test]
fn setup_agent_with_another_operation_is_usage() {
    let h = Home::new();
    for bad in [
        vec!["machine", "setup", "local", "--agent", "--check"],
        vec!["machine", "setup", "local", "--agent", "--apply"],
        vec![
            "machine",
            "setup",
            "local",
            "--agent",
            "--expect-sha",
            "a,b",
        ],
    ] {
        let (code, lines) = h.bw(&bad, &[]);
        assert_eq!(code, 2, "{bad:?}");
        assert!(
            lines[0]["message"].as_str().unwrap().contains("--agent"),
            "{lines:?}"
        );
    }
    assert!(!h.agent().exists());
    let (code, lines) = h.bw(&["machine", "setup", "local", "--agent"], &[]);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(lines[0]["type"], "agent-files");
    assert!(h.agent().join("browser-codex.md").is_file());
}
