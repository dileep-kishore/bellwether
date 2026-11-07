//! The `hc` CLI (`BW_HC`, default `hc`), which runs programs and writes files on other machines.

use std::ffi::OsString;
use std::io::Write;
use std::process::{Command, Stdio};

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
}

impl std::fmt::Display for HcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HcError::Unreachable(m) | HcError::NoProgram(m) | HcError::Failed(m) => f.write_str(m),
        }
    }
}

fn program() -> OsString {
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
        _ => HcError::Unreachable(format!("{kind}: {message}")),
    }
}

fn run(args: &[String], stdin: Option<&[u8]>) -> Result<Value, HcError> {
    let mut child = Command::new(program())
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
    if !out.status.success() {
        return Err(refusal(&out.stderr));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| HcError::Failed(format!("hc printed something other than JSON: {e}")))
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
