use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use sha2::{Digest, Sha256};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MB: usize = 1024 * 1024;

struct Machine {
    _tmp: tempfile::TempDir,
    remote: PathBuf,
    local_home: PathBuf,
    log: PathBuf,
    source: PathBuf,
}

impl Machine {
    fn new() -> Machine {
        let tmp = tempfile::tempdir().expect("temp dir");
        let remote = tmp.path().join("remote");
        let local_home = tmp.path().join("home");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&local_home).unwrap();
        Machine {
            log: tmp.path().join("calls.log"),
            source: tmp.path().join("bw-source"),
            remote,
            local_home,
            _tmp: tmp,
        }
    }

    fn helper(&self) -> PathBuf {
        self.remote.join(".local/share/bellwether/helper")
    }

    fn bw(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Vec<Value>) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env(
                "BW_HC",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc"),
            )
            .env("FAKE_HC_ROOT", &self.remote)
            .env("FAKE_HC_LOG", &self.log)
            .env("FAKE_HC_UNAME", "Darwin arm64")
            .env("HOME", &self.local_home)
            .env_remove("BW_INSTALL_SOURCE")
            .env_remove("FAKE_HC_CORRUPT_PART")
            .env_remove("FAKE_HC_OFFLINE");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().expect("run bw");
        let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
        let lines = stdout
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
            .collect();
        (out.status.code().expect("exit code"), lines)
    }

    fn install(&self, env: &[(&str, &str)]) -> (i32, Vec<Value>) {
        let source = self.source.to_str().unwrap();
        let mut all = vec![("BW_INSTALL_SOURCE", source)];
        all.extend_from_slice(env);
        self.bw(&["machine", "install", "loop"], &all)
    }

    fn writes(&self) -> usize {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with("file write"))
            .count()
    }
}

/// A runnable stand-in for bw of `size` bytes: sh stops at `exit`, so the padding after it is never read.
fn fake_binary(path: &Path, version: &str, size: usize) -> String {
    let mut bytes = format!(
        "#!/bin/sh\necho '{{\"protocol\":1,\"version\":\"{version}\",\"build\":\"unknown\",\"target\":\"fake\"}}'\nexit 0\n"
    )
    .into_bytes();
    let mut x: u32 = 0x2545_f491;
    while bytes.len() < size {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        // Every padding byte is >= 0x80, so the fake hc's corruption (writing "x") always changes it.
        bytes.push((x as u8) | 0x80);
    }
    std::fs::write(path, &bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn last(lines: &[Value]) -> &Value {
    lines.last().expect("at least one line")
}

#[test]
fn install_copies_in_parts_and_links_current() {
    let m = Machine::new();
    let sum = fake_binary(&m.source, VERSION, 8 * MB);

    let (code, lines) = m.install(&[]);

    assert_eq!(code, 0, "{lines:?}");
    let end = last(&lines);
    assert_eq!(end["type"], "installed", "{lines:?}");
    assert_eq!(end["machine"], "loop");
    assert_eq!(end["version"], VERSION);
    assert_eq!(end["sha256"], sum.as_str());
    assert_eq!(m.writes(), 2, "8 MB goes in two writes under 6 MB");
    let copies: Vec<&Value> = lines.iter().filter(|l| l["step"] == "copy").collect();
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|l| l["parts"] == 2));
    for step in ["uname", "verify", "link"] {
        assert!(lines.iter().any(|l| l["step"] == step), "no {step} step");
    }

    let dir = m.helper().join(VERSION);
    let installed = std::fs::read(dir.join("bw")).expect("bw is there");
    assert_eq!(hex(&installed), sum);
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["bw"], "parts and temporary files are removed");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("bw"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    let current = std::fs::read_link(m.helper().join("current")).expect("current is a link");
    assert_eq!(current, Path::new(VERSION));
}

#[test]
fn install_is_a_noop_when_current() {
    let m = Machine::new();
    fake_binary(&m.source, VERSION, 4096);
    let (code, _) = m.install(&[]);
    assert_eq!(code, 0);
    let before = m.writes();

    let (code, lines) = m.install(&[]);

    assert_eq!(code, 0, "{lines:?}");
    let end = last(&lines);
    assert_eq!(end["type"], "installed");
    assert_eq!(end["already"], true);
    assert_eq!(m.writes(), before, "a current helper gets no writes");
}

#[test]
fn install_force_replaces_a_current_helper() {
    let m = Machine::new();
    fake_binary(&m.source, VERSION, 4096);
    m.install(&[]);
    let before = m.writes();

    let (code, lines) = m.bw(
        &["machine", "install", "loop", "--force"],
        &[("BW_INSTALL_SOURCE", m.source.to_str().unwrap())],
    );

    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(last(&lines)["type"], "installed");
    assert!(last(&lines).get("already").is_none());
    assert_eq!(m.writes(), before + 1);
}

#[test]
fn install_refuses_platform_without_build() {
    let m = Machine::new();

    let (code, lines) = m.bw(
        &["machine", "install", "loop"],
        &[("FAKE_HC_UNAME", "Linux x86_64")],
    );

    assert_ne!(code, 0);
    let end = last(&lines);
    assert_eq!(end["type"], "error", "{lines:?}");
    assert_eq!(end["code"], "no_build");
    assert_eq!(end["target"], "x86_64-unknown-linux-musl");
    assert_eq!(m.writes(), 0);
    assert!(
        !m.remote.join(".local").exists(),
        "nothing is written there"
    );
}

#[test]
fn install_refuses_unknown_platform() {
    let m = Machine::new();

    let (code, lines) = m.install(&[("FAKE_HC_UNAME", "SunOS sparc")]);

    assert_ne!(code, 0);
    let end = last(&lines);
    assert_eq!(end["code"], "no_build", "{lines:?}");
    assert!(end["target"].is_null());
    assert_eq!(m.writes(), 0);
}

#[test]
fn install_cleans_up_on_sha_mismatch() {
    let m = Machine::new();
    let old = m.helper().join("0.0.9");
    std::fs::create_dir_all(&old).unwrap();
    fake_binary(&old.join("bw"), "0.0.9", 64);
    std::os::unix::fs::symlink("0.0.9", m.helper().join("current")).unwrap();
    fake_binary(&m.source, VERSION, 8 * MB);

    let (code, lines) = m.install(&[("FAKE_HC_CORRUPT_PART", "2")]);

    assert_ne!(code, 0);
    let end = last(&lines);
    assert_eq!(end["type"], "error", "{lines:?}");
    assert_eq!(end["code"], "sha_mismatch");
    assert!(
        !m.helper().join(VERSION).exists(),
        "the version folder is gone"
    );
    let current = std::fs::read_link(m.helper().join("current")).unwrap();
    assert_eq!(current, Path::new("0.0.9"));
}

#[test]
fn install_reports_unreachable() {
    let m = Machine::new();
    fake_binary(&m.source, VERSION, 64);

    let (code, lines) = m.install(&[("FAKE_HC_OFFLINE", "1")]);

    assert_ne!(code, 0);
    assert_eq!(last(&lines)["code"], "unreachable", "{lines:?}");
}

#[test]
fn status_names_unreachable() {
    let m = Machine::new();

    let (code, lines) = m.bw(&["machine", "status", "loop"], &[("FAKE_HC_OFFLINE", "1")]);

    assert_eq!(code, 0);
    let s = last(&lines);
    assert_eq!(s["type"], "machine");
    assert_eq!(s["machine"], "loop");
    assert_eq!(s["state"], "unreachable");
    assert!(s["remote"].is_null());
}

#[test]
fn status_names_missing_outdated_and_current() {
    let m = Machine::new();
    fake_binary(&m.source, VERSION, 64);
    let source = m.source.to_str().unwrap().to_string();
    let status = |m: &Machine| {
        m.bw(
            &["machine", "status", "loop"],
            &[("BW_INSTALL_SOURCE", &source)],
        )
        .1[0]
            .clone()
    };

    let s = status(&m);
    assert_eq!(s["state"], "missing", "{s}");
    assert_eq!(s["uname"], "Darwin arm64");
    assert!(s["remote"].is_null());

    let old = m.helper().join("0.0.9");
    std::fs::create_dir_all(&old).unwrap();
    fake_binary(&old.join("bw"), "0.0.9", 64);
    std::os::unix::fs::symlink("0.0.9", m.helper().join("current")).unwrap();
    let s = status(&m);
    assert_eq!(s["state"], "outdated", "{s}");
    assert_eq!(s["remote"]["version"], "0.0.9");

    m.install(&[]);
    let s = status(&m);
    assert_eq!(s["state"], "current", "{s}");
    assert_eq!(s["remote"]["version"], VERSION);
}

#[test]
fn status_names_platform_without_build() {
    let m = Machine::new();

    let (_, lines) = m.bw(
        &["machine", "status", "loop"],
        &[("FAKE_HC_UNAME", "Linux aarch64")],
    );

    assert_eq!(lines[0]["state"], "no_build", "{lines:?}");
}

#[test]
fn machine_without_name_is_a_usage_error() {
    let m = Machine::new();
    for args in [
        &["machine", "install"][..],
        &["machine", "status"],
        &["machine", "install", "--force"],
        &["machine", "status", "-x"],
        &["machine", "nonsense", "loop"],
    ] {
        let (code, lines) = m.bw(args, &[]);
        assert_eq!(code, 2, "{args:?}");
        assert_eq!(last(&lines)["code"], "usage", "{args:?}");
    }
    assert_eq!(m.writes(), 0);
}

fn put_dist(m: &Machine, target: &str, sums: impl FnOnce(&str) -> String) -> String {
    let dir = m
        .local_home
        .join(".local/share/bellwether/dist")
        .join(target);
    std::fs::create_dir_all(&dir).unwrap();
    let sum = fake_binary(&dir.join("bw"), VERSION, 64);
    std::fs::write(dir.join("SHA256SUMS"), sums(&sum)).unwrap();
    sum
}

#[test]
fn install_takes_a_dist_build_listed_in_sha256sums() {
    let m = Machine::new();
    let sum = put_dist(&m, "x86_64-unknown-linux-musl", |s| format!("{s}  bw\n"));

    let (code, lines) = m.bw(
        &["machine", "install", "loop"],
        &[("FAKE_HC_UNAME", "Linux x86_64")],
    );

    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(last(&lines)["target"], "x86_64-unknown-linux-musl");
    assert_eq!(last(&lines)["sha256"], sum.as_str());
}

#[test]
fn install_refuses_a_dist_build_that_differs_from_sha256sums() {
    let m = Machine::new();
    put_dist(&m, "x86_64-unknown-linux-musl", |_| {
        format!("{}  bw\n", "0".repeat(64))
    });

    let (code, lines) = m.bw(
        &["machine", "install", "loop"],
        &[("FAKE_HC_UNAME", "Linux x86_64")],
    );

    assert_ne!(code, 0);
    assert_eq!(last(&lines)["code"], "sha_mismatch", "{lines:?}");
    assert_eq!(m.writes(), 0);
}
