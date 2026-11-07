//! `bw picture` (window machine) and `bw picture-read` (the space's machine) against the `claude-picture`
//! recording, with tests/fake-hc standing in for a remote machine.

use std::ffi::OsStr;
use std::fmt::Debug;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde_json::{json, Value};

const CORE: &str = "bw-picture-test";
const RECORDING: &str = "3833b375-e79d-47bf-8e7e-f66cf3faab4b.jsonl";
// From tests/fixtures/feed/claude-picture.jsonl.
const OFFSET: u64 = 26350;
const DIGEST: &str = "c3ebbf21e766d2f1";

fn recording() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/sessions/claude-picture")
        .join(RECORDING)
}

/// The decoded bytes of the recording's one picture, read straight from its JSON.
fn recording_png() -> Vec<u8> {
    let log = fs::read(recording()).unwrap();
    let line = &log[OFFSET as usize..];
    let line = &line[..line.iter().position(|&c| c == b'\n').unwrap()];
    let v: Value = serde_json::from_slice(line).unwrap();
    let data = v["message"]["content"][0]["content"][0]["source"]["data"]
        .as_str()
        .unwrap();
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap()
}

fn set_age(path: &Path, age: Duration) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - age)
        .unwrap();
}

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

struct Scratch {
    tmp: tempfile::TempDir,
}

impl Scratch {
    fn new() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        let x = Scratch { tmp };
        fs::create_dir_all(x.app()).unwrap();
        fs::create_dir_all(x.window_home()).unwrap();
        x
    }

    fn dir(&self) -> PathBuf {
        self.tmp.path().canonicalize().unwrap()
    }

    fn app(&self) -> PathBuf {
        self.dir().join("app")
    }

    fn window_home(&self) -> PathBuf {
        self.dir().join("window-home")
    }

    /// The remote machine's home, as tests/fake-hc runs programs there.
    fn remote(&self) -> PathBuf {
        self.dir().join("remote")
    }

    fn pictures(&self) -> PathBuf {
        self.app().join("data/bellwether/pictures")
    }

    fn picture_files(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.pictures()) else {
            return vec![];
        };
        let mut names: Vec<String> = entries
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Copies `log` under `home` and names it as terminal `t1`'s root in the cache there.
    fn remember(&self, cache: &Path, log_bytes: &[u8]) -> PathBuf {
        let log = cache.parent().unwrap().join("logs/session.jsonl");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, log_bytes).unwrap();
        let entry = cache.join("feeds").join(CORE).join("t1.json");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        let root = json!({
            "version": 1,
            "root": {
                "kind": "claude", "pids": [41, 42], "agent_pid": 42,
                "path": log.to_string_lossy(), "session": "3833b375-e79d-47bf-8e7e-f66cf3faab4b",
                "checked_ms": 1_794_000_000_000_i64,
            },
            "feed": null,
        });
        fs::write(&entry, root.to_string()).unwrap();
        log
    }

    fn local_cache(&self) -> PathBuf {
        self.dir().join("local/cache")
    }

    fn remember_local(&self, log_bytes: &[u8]) -> PathBuf {
        self.remember(&self.local_cache(), log_bytes)
    }

    /// The helper there is this test's binary, with its own cache under that machine's home.
    fn remember_remote(&self, log_bytes: &[u8]) -> PathBuf {
        let helper = self.remote().join(".local/share/bellwether/helper/current");
        fs::create_dir_all(&helper).unwrap();
        std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_bw"), helper.join("bw")).unwrap();
        self.remember(&self.remote().join(".cache/bellwether"), log_bytes)
    }

    fn command<S: AsRef<OsStr>>(&self, args: &[S], env: &[(&str, &str)]) -> Command {
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.args(args)
            .env("BW_HC", fake)
            .env("FAKE_HC_ROOT", self.remote())
            .env("FAKE_HC_LOG", self.dir().join("hc.log"))
            .env("HERDR_APP_HOME", self.app())
            .env("HC_SESSION", CORE)
            .env("HOME", self.window_home())
            .env_remove("BW_CACHE_DIR");
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd
    }

    /// Runs bw and returns its one output line and exit code.
    fn bw_code<S: AsRef<OsStr> + Debug>(
        &self,
        args: &[S],
        env: &[(&str, &str)],
    ) -> (Value, Option<i32>) {
        let out = self.command(args, env).output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1, "bw {args:?} printed {text:?}");
        let v = serde_json::from_str(lines[0]).unwrap_or_else(|e| panic!("{e}: {}", lines[0]));
        (v, out.status.code())
    }

    fn bw<S: AsRef<OsStr> + Debug>(&self, args: &[S], env: &[(&str, &str)]) -> Value {
        let (v, code) = self.bw_code(args, env);
        assert_eq!(code, Some(0), "bw {args:?}: {v}");
        v
    }

    fn picture(&self, terminal: &str, offset: u64, digest: &str) -> Value {
        let cache = self.local_cache();
        self.bw(
            &picture_args(terminal, offset, digest),
            &[("BW_CACHE_DIR", cache.to_str().unwrap())],
        )
    }

    fn hc_log(&self) -> String {
        fs::read_to_string(self.dir().join("hc.log")).unwrap_or_default()
    }
}

fn picture_args(terminal: &str, offset: u64, digest: &str) -> Vec<String> {
    let offset = offset.to_string();
    [
        "picture",
        "--terminal",
        terminal,
        "--offset",
        &offset,
        "--index",
        "0",
        "--digest",
        digest,
    ]
    .map(String::from)
    .to_vec()
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn local_picture_lands_in_app_home() {
    let x = Scratch::new();
    x.remember_local(&fs::read(recording()).unwrap());
    let v = x.picture("t1", OFFSET, DIGEST);
    let file = format!("data/bellwether/pictures/{DIGEST}.png");
    assert_eq!(
        v,
        json!({"type": "picture", "digest": DIGEST, "file": file, "bytes": recording_png().len()})
    );
    assert_eq!(fs::read(x.app().join(&file)).unwrap(), recording_png());
    for d in ["data", "data/bellwether", "data/bellwether/pictures"] {
        assert_eq!(mode(&x.app().join(d)), 0o700, "{d}");
    }
    assert_eq!(
        x.picture_files(),
        [format!("{DIGEST}.png")],
        "no temp file is left"
    );
    assert_eq!(x.hc_log(), "", "a local picture needs no hc call");
}

#[test]
fn same_digest_is_copied_once() {
    let x = Scratch::new();
    let log = x.remember_local(&fs::read(recording()).unwrap());
    let first = x.picture("t1", OFFSET, DIGEST);
    let file = x.app().join(first["file"].as_str().unwrap());
    set_age(&file, 3 * DAY);
    // With the log gone, only the copy already made can answer.
    fs::remove_file(&log).unwrap();
    let second = x.picture("t1", OFFSET, DIGEST);
    assert_eq!(second, first);
    assert_eq!(fs::read(&file).unwrap(), recording_png());
    let age = fs::metadata(&file)
        .unwrap()
        .modified()
        .unwrap()
        .elapsed()
        .unwrap();
    assert!(
        age < DAY,
        "a picture in use is touched, so pruning keeps it: {age:?}"
    );
    assert_eq!(x.picture_files().len(), 1);
}

/// A PNG header for a 16x16 picture, padded with zeros to `size` bytes.
fn big_png(size: usize) -> Vec<u8> {
    let mut b = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    b.extend_from_slice(b"IHDR");
    b.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]);
    b.resize(size, 0);
    b
}

/// A short first line, then a Claude user line holding `png`; returns the log and the second line's offset.
fn log_with(png: &[u8]) -> (Vec<u8>, u64, String) {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let digest = format!("{:016x}", herdr_core::log_image::fingerprint(&b64));
    let first = br#"{"type":"user","message":{"role":"user","content":"look"}}"#;
    let line = json!({"type": "user", "message": {"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "data": b64, "media_type": "image/png"}}
    ]}});
    let mut log = first.to_vec();
    log.push(b'\n');
    let offset = log.len() as u64;
    log.extend_from_slice(line.to_string().as_bytes());
    log.push(b'\n');
    (log, offset, digest)
}

#[test]
fn over_cap_is_too_big() {
    // One byte over the cap, and 4.1 MiB.
    for size in [4 * 1024 * 1024 + 1, 4_300_000] {
        let x = Scratch::new();
        let (log, offset, digest) = log_with(&big_png(size));
        x.remember_local(&log);
        let v = x.picture("t1", offset, &digest);
        assert_eq!(
            v,
            json!({"type": "picture", "digest": digest, "state": "too_big", "bytes": size})
        );
        assert!(x.picture_files().is_empty());
    }
}

#[test]
fn at_cap_is_copied() {
    let x = Scratch::new();
    let png = big_png(4 * 1024 * 1024);
    let (log, offset, digest) = log_with(&png);
    x.remember_local(&log);
    let v = x.picture("t1", offset, &digest);
    assert_eq!(v["bytes"], png.len());
    assert_eq!(
        fs::read(x.app().join(v["file"].as_str().unwrap())).unwrap(),
        png
    );
}

#[test]
fn digest_mismatch_is_gone() {
    let x = Scratch::new();
    x.remember_local(&fs::read(recording()).unwrap());
    let gone = |offset: u64, digest: &str| {
        json!({"type": "picture", "digest": digest, "state": "gone"})
            == x.picture("t1", offset, digest)
    };
    assert!(gone(OFFSET, "c3ebbf21e766d2f0"), "another fingerprint");
    assert!(gone(OFFSET + 1, DIGEST), "an offset inside a line");
    assert!(gone(0, DIGEST), "a line without that picture");
    assert!(gone(10_000_000, DIGEST), "past the end");
    let v = x.picture("t2", OFFSET, DIGEST);
    assert_eq!(v["state"], "gone", "no cached root for t2");
    assert!(x.picture_files().is_empty());
}

#[test]
fn remote_picture_goes_through_the_helper_there() {
    let x = Scratch::new();
    x.remember_remote(&fs::read(recording()).unwrap());
    let v = x.bw(&picture_args("bwloop/t1", OFFSET, DIGEST), &[]);
    let file = format!("data/bellwether/pictures/{DIGEST}.png");
    assert_eq!(
        v,
        json!({"type": "picture", "digest": DIGEST, "file": file, "bytes": recording_png().len()})
    );
    assert_eq!(fs::read(x.app().join(&file)).unwrap(), recording_png());
    let log = x.hc_log();
    assert!(
        log.contains(&format!(
            "exec sh -c {} bw picture-read --terminal t1 --offset {OFFSET} --index 0 --digest {DIGEST}",
            r#"exec "$HOME"/.local/share/bellwether/helper/current/bw "$@""#
        )),
        "{log}"
    );
    assert!(
        !x.remote().join("data").exists(),
        "the picture is written on the window machine only"
    );
}

#[test]
fn remote_too_big_and_gone_pass_through() {
    let x = Scratch::new();
    let (log, offset, digest) = log_with(&big_png(4_300_000));
    x.remember_remote(&log);
    let v = x.bw(&picture_args("bwloop/t1", offset, &digest), &[]);
    assert_eq!(v["state"], "too_big");
    assert_eq!(v["bytes"], 4_300_000);
    let v = x.bw(&picture_args("bwloop/t1", offset, "0123456789abcdef"), &[]);
    assert_eq!(
        v,
        json!({"type": "picture", "digest": "0123456789abcdef", "state": "gone"})
    );
    assert!(x.picture_files().is_empty());
}

#[test]
fn picture_read_prints_the_base64() {
    let x = Scratch::new();
    x.remember_local(&fs::read(recording()).unwrap());
    let cache = x.local_cache();
    let mut args = picture_args("t1", OFFSET, DIGEST);
    args[0] = "picture-read".into();
    let v = x.bw(&args, &[("BW_CACHE_DIR", cache.to_str().unwrap())]);
    assert_eq!(v["type"], "picture-data");
    assert_eq!(v["digest"], DIGEST);
    assert_eq!(v["format"], "png");
    assert_eq!(v["bytes"], recording_png().len());
    let b64 = v["base64"].as_str().unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap(),
        recording_png()
    );
    assert!(x.picture_files().is_empty(), "picture-read writes nothing");
}

#[test]
fn offline_machine_is_unreachable() {
    let x = Scratch::new();
    x.remember_remote(&fs::read(recording()).unwrap());
    let v = x.bw(
        &picture_args("bwloop/t1", OFFSET, DIGEST),
        &[("FAKE_HC_OFFLINE", "1")],
    );
    assert_eq!(
        v,
        json!({"type": "picture", "digest": DIGEST, "state": "unreachable"})
    );
    assert!(x.picture_files().is_empty());
}

#[test]
fn missing_helper_there_is_an_error() {
    let x = Scratch::new();
    fs::create_dir_all(x.remote()).unwrap();
    let (v, code) = x.bw_code(&picture_args("bwloop/t1", OFFSET, DIGEST), &[]);
    assert_eq!(code, Some(1), "{v}");
    assert_eq!(v["type"], "error");
    assert_eq!(v["code"], "missing");
}

#[test]
fn prunes_pictures_older_than_7_days() {
    let x = Scratch::new();
    x.remember_local(&fs::read(recording()).unwrap());
    fs::create_dir_all(x.pictures()).unwrap();
    let old = x.pictures().join("00000000000000aa.png");
    let recent = x.pictures().join("00000000000000bb.png");
    for (f, age) in [(&old, 8 * DAY), (&recent, 6 * DAY)] {
        fs::write(f, b"x").unwrap();
        set_age(f, age);
    }
    x.picture("t1", OFFSET, DIGEST);
    assert_eq!(
        x.picture_files(),
        ["00000000000000bb.png".to_string(), format!("{DIGEST}.png")]
    );
}

#[test]
fn missing_app_home_is_an_error_and_not_made() {
    let x = Scratch::new();
    x.remember_local(&fs::read(recording()).unwrap());
    let cache = x.local_cache();
    let nowhere = x.dir().join("no-app-home");
    let (v, code) = x.bw_code(
        &picture_args("t1", OFFSET, DIGEST),
        &[
            ("BW_CACHE_DIR", cache.to_str().unwrap()),
            ("HERDR_APP_HOME", nowhere.to_str().unwrap()),
        ],
    );
    assert_eq!(code, Some(1), "{v}");
    assert_eq!(v["code"], "no_app_home");
    assert!(!nowhere.exists());
}

#[test]
fn bad_options_are_usage() {
    let x = Scratch::new();
    for args in [
        vec![
            "picture",
            "--terminal",
            "t1",
            "--offset",
            "1",
            "--index",
            "0",
            "--digest",
            "../../x",
        ],
        vec![
            "picture",
            "--terminal",
            "t1",
            "--offset",
            "1",
            "--index",
            "0",
            "--digest",
            "C3EBBF21E766D2F1",
        ],
        vec![
            "picture",
            "--terminal",
            "t1",
            "--offset",
            "x",
            "--index",
            "0",
            "--digest",
            DIGEST,
        ],
        vec![
            "picture",
            "--terminal",
            "t1",
            "--offset",
            "1",
            "--digest",
            DIGEST,
        ],
        vec![
            "picture-read",
            "--terminal",
            "t1",
            "--offset",
            "1",
            "--index",
            "0",
        ],
        vec![
            "picture",
            "--terminal",
            "a/b/t1",
            "--offset",
            "1",
            "--index",
            "0",
            "--digest",
            DIGEST,
        ],
    ] {
        let (v, code) = x.bw_code(&args, &[]);
        assert_eq!(code, Some(2), "{args:?}: {v}");
        assert_eq!(v["code"], "usage", "{args:?}");
    }
}
