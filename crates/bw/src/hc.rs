//! The `hc` CLI (`BW_HC`, default `hc`), which runs programs and writes files on other machines.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;

/// Seconds hc lets a program there run; the longest is joining and hashing an 8 MB helper.
const EXEC_TIMEOUT_S: u64 = 60;

pub struct Output {
    pub code: Option<i64>,
    pub stdout: Vec<u8>,
}

#[derive(Debug)]
pub enum HcError {
    /// hc did not reach the machine, or hc itself did not run.
    Unreachable(String),
    /// The program is not on that machine.
    NoProgram(String),
    /// hc answered something this helper does not understand.
    Failed(String),
    /// hc reached the terminal and said no: `blocked`, `not_found`, `finished` or `status_mismatch`.
    Refused { kind: String, message: String },
    /// hc had not answered when the caller's time ran out, and was killed.
    TimedOut,
}

impl std::fmt::Display for HcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HcError::Unreachable(m) | HcError::NoProgram(m) | HcError::Failed(m) => f.write_str(m),
            HcError::Refused { kind, message } => write!(f, "{kind}: {message}"),
            HcError::TimedOut => f.write_str("hc did not answer in time"),
        }
    }
}

pub(crate) fn program() -> OsString {
    std::env::var_os("BW_HC")
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "hc".into())
}

/// hc prints `{"error":{"kind","message"}}` on stderr and exits nonzero when it cannot do the call.
fn refusal(stderr: &[u8]) -> HcError {
    let text = String::from_utf8_lossy(stderr).trim().to_string();
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return HcError::Unreachable(format!("hc failed: {text}"));
    };
    let kind = v["error"]["kind"].as_str().unwrap_or("");
    let message = v["error"]["message"].as_str().unwrap_or(&text).to_string();
    match kind {
        "spawn_failed" => HcError::NoProgram(message),
        "blocked" | "not_found" | "finished" | "status_mismatch" => HcError::Refused {
            kind: kind.to_string(),
            message,
        },
        _ => HcError::Unreachable(format!("{kind}: {message}")),
    }
}

fn run(args: &[String], stdin: Option<&[u8]>) -> Result<Value, HcError> {
    run_with(&program(), args, stdin)
}

fn run_with(program: &OsStr, args: &[String], stdin: Option<&[u8]>) -> Result<Value, HcError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HcError::Unreachable(format!("cannot run hc: {e}")))?;
    let out = std::thread::scope(|s| {
        if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
            // A write error means hc stopped reading; its exit status and stderr say why.
            s.spawn(move || pipe.write_all(bytes));
        }
        child.wait_with_output()
    })
    .map_err(|e| HcError::Unreachable(format!("hc did not finish: {e}")))?;
    answer(out.status.success(), &out.stdout, &out.stderr)
}

fn answer(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Value, HcError> {
    if !success {
        return Err(refusal(stderr));
    }
    serde_json::from_slice(stdout)
        .map_err(|e| HcError::Failed(format!("hc printed something other than JSON: {e}")))
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    })
}

/// Like `run` with no input, but kills hc once `timeout` passes.
fn run_timed(program: &OsStr, args: &[String], timeout: Duration) -> Result<Value, HcError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HcError::Unreachable(format!("cannot run hc: {e}")))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                // The readers are left behind: a program hc started may still hold the pipes open.
                return Err(HcError::TimedOut);
            }
            Err(e) => return Err(HcError::Unreachable(format!("hc did not finish: {e}"))),
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    answer(status.success(), &stdout, &stderr)
}

fn decode(v: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(v.as_str().unwrap_or(""))
        .unwrap_or_default()
}

/// Runs `argv` on `machine` as given, with no shell; its working folder is that machine's home.
pub fn hc_exec(machine: &str, argv: &[&str]) -> Result<Output, HcError> {
    let mut args = vec![
        "exec".to_string(),
        "--json".into(),
        format!("--on={machine}"),
        format!("--timeout={EXEC_TIMEOUT_S}"),
        "--".into(),
    ];
    args.extend(argv.iter().map(|a| a.to_string()));
    let r = run(&args, None)?;
    if r["timed_out"].as_bool() == Some(true) {
        return Err(HcError::Unreachable(format!(
            "{machine} did not finish {} in {EXEC_TIMEOUT_S} s",
            argv.first().unwrap_or(&"")
        )));
    }
    if r["truncated"].as_bool() == Some(true) {
        return Err(HcError::Failed(format!(
            "{machine} printed more than hc passes on"
        )));
    }
    Ok(Output {
        code: r["code"].as_i64(),
        stdout: decode(&r["stdout"]),
    })
}

/// Writes `bytes` as `path` on `machine`, making missing folders; a relative path starts at that machine's home.
pub fn hc_write(machine: &str, path: &str, bytes: &[u8]) -> Result<(), HcError> {
    let args = [
        "file".to_string(),
        "write".into(),
        "--json".into(),
        format!("--on={machine}"),
        "--".into(),
        path.to_string(),
    ];
    let r = run(&args, Some(bytes))?;
    match r["bytes"].as_u64() {
        Some(n) if n == bytes.len() as u64 => Ok(()),
        n => Err(HcError::Failed(format!(
            "hc wrote {} of {} bytes to {path} on {machine}",
            n.map_or("?".into(), |n| n.to_string()),
            bytes.len()
        ))),
    }
}

/// `hc get <address> --json`: one terminal, by `t7` or `machine/t7`.
pub fn hc_get(address: &str) -> Result<Value, HcError> {
    hc_get_with(&program(), address)
}

pub fn hc_get_with(program: &OsStr, address: &str) -> Result<Value, HcError> {
    run_with(
        program,
        &["get".into(), address.into(), "--json".into()],
        None,
    )
}

/// Any hc call that answers one JSON value on stdout (`machine ls`, `run --bg`, `kill`, `rm`).
pub fn hc_json(args: &[&str]) -> Result<Value, HcError> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    run(&args, None)
}

/// `hc ls --json`: this core's live terminals.
pub fn hc_ls() -> Result<Value, HcError> {
    hc_ls_with(&program())
}

pub fn hc_ls_with(program: &OsStr) -> Result<Value, HcError> {
    run_with(program, &["ls".into(), "--json".into()], None)
}

/// Types `text` into the terminal at `address` and presses enter, refusing a blocked program (never `--force`).
pub fn hc_send(address: &str, text: &str, timeout: Duration) -> Result<Value, HcError> {
    hc_send_with(&program(), address, text, timeout)
}

pub fn hc_send_with(
    program: &OsStr,
    address: &str,
    text: &str,
    timeout: Duration,
) -> Result<Value, HcError> {
    // hc reads an argument after `--` as the address or text even when it starts with `-`.
    let args = [
        "send".to_string(),
        "--json".into(),
        "--".into(),
        address.into(),
        text.into(),
    ];
    run_timed(program, &args, timeout)
}

/// `hc read <address> --json`: the terminal's visible screen as plain text, no history.
pub fn hc_read(address: &str) -> Result<String, HcError> {
    hc_read_with(&program(), address)
}

pub fn hc_read_with(program: &OsStr, address: &str) -> Result<String, HcError> {
    let r = run_with(
        program,
        &["read".into(), address.into(), "--json".into()],
        None,
    )?;
    r["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| HcError::Failed(format!("hc read {address} printed no text")))
}

/// Presses `keys` (hc's names: `enter`, `esc`, `1`, ...) in the terminal at `address`, never `--force`.
pub fn hc_keys(address: &str, keys: &[&str], timeout: Duration) -> Result<Value, HcError> {
    hc_keys_with(&program(), address, keys, timeout)
}

pub fn hc_keys_with(
    program: &OsStr,
    address: &str,
    keys: &[&str],
    timeout: Duration,
) -> Result<Value, HcError> {
    // As with send, `--` keeps an address or key that starts with `-` from reading as a flag.
    let mut args = vec![
        "keys".to_string(),
        "--json".into(),
        "--".into(),
        address.into(),
    ];
    args.extend(keys.iter().map(|k| k.to_string()));
    run_timed(program, &args, timeout)
}

/// Test stand-in for hc, shared by this module's tests and `requests::screen`'s.
#[cfg(test)]
pub(crate) mod fake {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    /// A script that runs tests/fake-hc with `env` set and writes its argv, one per line, to `argv.txt`.
    pub struct Fake {
        pub dir: tempfile::TempDir,
        pub program: PathBuf,
    }

    impl Fake {
        pub fn new(env: &[(&str, &str)]) -> Fake {
            let dir = tempfile::tempdir().unwrap();
            let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
            let mut script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexport FAKE_HC_LOG='{}'\n",
                dir.path().join("argv.txt").display(),
                dir.path().join("calls.log").display()
            );
            for (k, v) in env {
                script.push_str(&format!("export {k}='{v}'\n"));
            }
            script.push_str(&format!("exec '{}' \"$@\"\n", fake.display()));
            let program = dir.path().join("hc");
            std::fs::write(&program, script).unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            Fake { dir, program }
        }

        pub fn argv(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("argv.txt"))
                .unwrap()
                .lines()
                .map(String::from)
                .collect()
        }

        pub fn log(&self) -> String {
            std::fs::read_to_string(self.dir.path().join("calls.log")).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Fake;
    use super::*;
    use std::time::Instant;

    #[test]
    fn get_parses_json() {
        let gets = tempfile::tempdir().unwrap();
        std::fs::write(
            gets.path().join("bwloop_t1.json"),
            r#"{"id":"t1","pid":4242,"argv":["codex"],"cwd":"/x"}"#,
        )
        .unwrap();
        let fake = Fake::new(&[("FAKE_HC_GET_DIR", gets.path().to_str().unwrap())]);
        let v = hc_get_with(fake.program.as_os_str(), "bwloop/t1").unwrap();
        assert_eq!(v["pid"], 4242);
        assert_eq!(fake.argv(), ["get", "bwloop/t1", "--json"]);
        match hc_get_with(fake.program.as_os_str(), "t9") {
            Err(HcError::Refused { kind, .. }) => assert_eq!(kind, "not_found"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    #[test]
    fn ls_parses_json() {
        let fake = Fake::new(&[]);
        let v = hc_ls_with(fake.program.as_os_str()).unwrap();
        assert_eq!(v["terminals"], serde_json::json!([]));
        assert_eq!(fake.argv(), ["ls", "--json"]);
    }

    #[test]
    fn send_argv_is_double_dash_address_text() {
        let fake = Fake::new(&[]);
        let v = hc_send_with(
            fake.program.as_os_str(),
            "bwloop/t3",
            "--force -x",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(v["status"], "working");
        assert_eq!(
            fake.argv(),
            ["send", "--json", "--", "bwloop/t3", "--force -x"]
        );
        assert_eq!(fake.log(), "send bwloop/t3 --force -x\n");
    }

    #[test]
    fn blocked_is_refused_with_kind() {
        let fake = Fake::new(&[("FAKE_HC_SEND_FAIL", "blocked")]);
        match hc_send_with(fake.program.as_os_str(), "t3", "hi", Duration::from_secs(5)) {
            Err(HcError::Refused { kind, message }) => {
                assert_eq!(kind, "blocked");
                assert!(!message.is_empty());
            }
            other => panic!("expected blocked, got {other:?}"),
        }
        let fake = Fake::new(&[("FAKE_HC_SEND_FAIL", "machine_unknown")]);
        assert!(matches!(
            hc_send_with(
                fake.program.as_os_str(),
                "x/t3",
                "hi",
                Duration::from_secs(5)
            ),
            Err(HcError::Unreachable(_))
        ));
    }

    #[test]
    fn slow_send_times_out() {
        let fake = Fake::new(&[("FAKE_HC_SEND_SLEEP", "3")]);
        let start = Instant::now();
        let r = hc_send_with(fake.program.as_os_str(), "t3", "hi", Duration::from_secs(1));
        assert!(matches!(r, Err(HcError::TimedOut)), "got {r:?}");
        let took = start.elapsed();
        assert!(
            took >= Duration::from_secs(1) && took < Duration::from_millis(2500),
            "took {took:?}"
        );
    }

    #[test]
    fn read_returns_screen_text() {
        let screens = tempfile::tempdir().unwrap();
        let text = "› 1. Yes, proceed (y)\n\tpath \"a\\b\"\n\nPress enter";
        std::fs::write(screens.path().join("t1.txt"), format!("{text}\n")).unwrap();
        std::fs::write(screens.path().join("t1.after.txt"), "after\n").unwrap();
        let fake = Fake::new(&[("FAKE_HC_SCREEN_DIR", screens.path().to_str().unwrap())]);
        assert_eq!(hc_read_with(fake.program.as_os_str(), "t1").unwrap(), text);
        assert_eq!(fake.argv(), ["read", "t1", "--json"]);
        // The fake moves to the after screen only once keys went to that terminal.
        hc_keys_with(
            fake.program.as_os_str(),
            "t1",
            &["y"],
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            hc_read_with(fake.program.as_os_str(), "t1").unwrap(),
            "after"
        );
        match hc_read_with(fake.program.as_os_str(), "t9") {
            Err(HcError::Refused { kind, .. }) => assert_eq!(kind, "not_found"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    #[test]
    fn keys_argv_is_double_dash_address_keys() {
        let fake = Fake::new(&[]);
        let v = hc_keys_with(
            fake.program.as_os_str(),
            "t3",
            &["--force", "esc"],
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(v["status"], "working");
        assert_eq!(
            fake.argv(),
            ["keys", "--json", "--", "t3", "--force", "esc"]
        );
        assert_eq!(fake.log(), "keys t3 --force esc\n");
        let fake = Fake::new(&[("FAKE_HC_KEYS_FAIL", "not_found")]);
        match hc_keys_with(
            fake.program.as_os_str(),
            "t3",
            &["1"],
            Duration::from_secs(5),
        ) {
            Err(HcError::Refused { kind, .. }) => assert_eq!(kind, "not_found"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    #[test]
    fn slow_keys_time_out() {
        let fake = Fake::new(&[("FAKE_HC_KEYS_SLEEP", "3")]);
        let start = Instant::now();
        let r = hc_keys_with(
            fake.program.as_os_str(),
            "t3",
            &["1"],
            Duration::from_secs(1),
        );
        assert!(matches!(r, Err(HcError::TimedOut)), "got {r:?}");
        let took = start.elapsed();
        assert!(
            took >= Duration::from_secs(1) && took < Duration::from_millis(2500),
            "took {took:?}"
        );
    }
}
