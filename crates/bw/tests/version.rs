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
    assert_eq!(v["protocol"], 2);
    assert_eq!(v["version"], "0.2.0");
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
fn feed_is_not_built_yet() {
    let (code, v) = run(&["feed", "--log", "/nowhere.jsonl", "--agent", "claude"]);
    assert_eq!(code, 1);
    assert_eq!(v["type"], "error");
    assert_eq!(v["code"], "not_built");
    assert_eq!(v["message"], "feed arrives in a later task");
}
