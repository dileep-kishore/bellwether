use std::process::Command;

use serde_json::Value;

fn run(args: &[&str]) -> (i32, Value) {
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args(args)
        .output()
        .expect("run bw");
    let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
    let json = serde_json::from_str(stdout.trim()).expect("stdout is one JSON value");
    (out.status.code().expect("exit code"), json)
}

fn is_build_id(s: &str) -> bool {
    s == "unknown"
        || (s.len() == 12
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

#[test]
fn version_prints_protocol_version_build_and_target() {
    let (code, v) = run(&["version"]);
    assert_eq!(code, 0);
    assert_eq!(v["protocol"], 4);
    assert_eq!(v["version"], "0.4.1");
    let target = v["target"].as_str().expect("target is a string");
    assert!(!target.is_empty());
    let build = v["build"].as_str().expect("build is a string");
    assert!(
        is_build_id(build),
        "build {build:?} is neither 12 hex digits nor unknown"
    );
}

#[test]
fn unknown_subcommand_is_a_usage_error() {
    let (code, v) = run(&["nonsense"]);
    assert_eq!(code, 2);
    assert_eq!(v["type"], "error");
    assert_eq!(v["code"], "usage");
    assert!(v["message"].is_string());
}

#[test]
fn feed_without_a_source_is_a_usage_error() {
    let (code, v) = run(&["feed"]);
    assert_eq!(code, 2);
    assert_eq!(v["type"], "error");
    assert_eq!(v["code"], "usage");
}

/// Phase 3's commands, each with the argv `main.rs` routes; a stub prints `not_built` until its task lands.
const PHASE_3_COMMANDS: [&[&str]; 7] = [
    &["tree"],
    &["event"],
    &["hooks"],
    &["cards"],
    &["answer"],
    &["counts"],
    &["machine", "setup"],
];

#[test]
fn phase_3_commands_are_routed() {
    let home = tempfile::tempdir().unwrap();
    let fake_hc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
    for argv in PHASE_3_COMMANDS {
        // A hook event outside Herdr must write nothing, so no terminal id reaches bw here.
        let out = Command::new(env!("CARGO_BIN_EXE_bw"))
            .args(argv)
            .env("HOME", home.path())
            .env("BW_CACHE_DIR", home.path().join("cache"))
            .env("BW_HC", &fake_hc)
            .env_remove("HC_TERMINAL_ID")
            .env_remove("HC_SESSION")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("run bw");
        let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
        let code = out.status.code().expect("exit code");
        for line in stdout.lines() {
            let v: Value =
                serde_json::from_str(line).unwrap_or_else(|e| panic!("{argv:?}: {line:?}: {e}"));
            let message = v["message"].as_str().unwrap_or("");
            assert!(
                !message.starts_with("unknown"),
                "{argv:?} is not routed: {line}"
            );
            if v["code"] == "not_built" {
                assert_eq!(code, 1, "{argv:?}: {line}");
                assert!(
                    message.contains(argv.join(" ").as_str()),
                    "{argv:?}: {line}"
                );
            }
        }
    }
}
