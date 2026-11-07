//! `bw browser free-port|port-check|forward …`: the checked SSH forwards to and from other machines.
//!
//! A browser forward is `ssh -R` from the window machine, so agents on another machine reach the
//! Bellwether Chrome on a loopback port there; a dev forward is `ssh -L`, so this Chrome reaches a dev
//! server there. Each runs in an hc terminal under `bw browser forward keep`, which checks every
//! connection before it writes `ready` and stops for good when a check finds the wrong listener.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{cdp, chrome, http, listen, lock};
use crate::chat::cache;
use crate::chat::protocol::fnv1a;
use crate::hc::{self, HcError};
use crate::machine::RUN_HELPER;

/// How long after ssh starts its listener must pass the checks.
const CHECK_WINDOW: Duration = Duration::from_secs(5);
const CHECK_POLL: Duration = Duration::from_millis(250);
const ENSURE_WAIT: Duration = Duration::from_secs(12);
const ENSURE_POLL: Duration = Duration::from_millis(100);
const PORT_TRIES: usize = 3;
/// Beyond one ensure's longest wait, for its hc calls.
const LOCK_SLACK: Duration = Duration::from_secs(5);
const DEV_ANSWER: Duration = Duration::from_secs(3);
const DEV_RECHECK: Duration = Duration::from_secs(10);
const UP_POLL: Duration = Duration::from_millis(500);
/// Seconds between reconnects: 2, 4, 8, 16, 30, then every 60.
const BACKOFF_S: [u64; 5] = [2, 4, 8, 16, 30];
const BACKOFF_MAX_S: u64 = 60;
/// hc's limit on terminal names.
const NAME_MAX: usize = 32;
/// States a running supervisor writes; with its terminal gone they read `stopped`.
const LIVE_STATES: [&str; 4] = ["starting", "ready", "ready_no_answer", "reconnecting"];

const USAGE: &str = "usage: bw browser free-port [--prefer <port>] \
    | bw browser port-check --port <port> --browser-id <id> \
    | bw browser forward ensure --machine <m> \
    | bw browser forward keep --machine <m> --target <t> --port <p> [--kind browser|dev] \
    | bw browser forward dev --machine <m> --port <n> \
    | bw browser forward stop --machine <m> [--dev <n>] | bw browser forward list";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Browser,
    Dev,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Browser => "browser",
            Kind::Dev => "dev",
        }
    }
}

/// One forward's state file, `forwards/<core>/<slug>.json` or `<slug>-dev-<n>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Forward {
    pub kind: String,
    pub machine: String,
    pub target: String,
    pub port: Option<u16>,
    pub terminal: String,
    pub state: String,
    pub reason: String,
    pub browser_id: Option<String>,
    pub checked_at_ms: u64,
}

impl Default for Forward {
    fn default() -> Forward {
        Forward {
            kind: "browser".into(),
            machine: String::new(),
            target: String::new(),
            port: None,
            terminal: String::new(),
            state: "stopped".into(),
            reason: String::new(),
            browser_id: None,
            checked_at_ms: 0,
        }
    }
}

impl Forward {
    fn new(kind: Kind, machine: &str, target: &str, port: Option<u16>) -> Forward {
        Forward {
            kind: kind.as_str().into(),
            machine: machine.into(),
            target: target.into(),
            port,
            terminal: terminal_name(kind, machine, port.unwrap_or(0)),
            ..Forward::default()
        }
    }

    fn with(mut self, state: &str, reason: impl Into<String>) -> Forward {
        self.state = state.into();
        self.reason = reason.into();
        self
    }

    /// The `forward` line the panel and `agent-args` read.
    pub fn line(&self) -> Value {
        json!({
            "type": "forward",
            "kind": self.kind,
            "machine": self.machine,
            "target": self.target,
            "port": self.port,
            "state": self.state,
            "reason": self.reason,
            "terminal": self.terminal,
        })
    }
}

pub fn run(cmd: &str, args: &[String]) -> ExitCode {
    match cmd {
        "free-port" => run_free_port(args),
        "port-check" => run_port_check(args),
        "forward" => {
            let rest = args.get(1..).unwrap_or_default();
            match args.first().map(String::as_str) {
                Some("ensure") => run_ensure(rest),
                Some("keep") => run_keep(rest),
                Some("dev") => run_dev(rest),
                Some("stop") => run_stop(rest),
                Some("list") if rest.is_empty() => {
                    for f in list() {
                        println!("{}", f.line());
                    }
                    ExitCode::SUCCESS
                }
                _ => crate::usage(USAGE),
            }
        }
        _ => crate::usage(USAGE),
    }
}

/// `--flag value` pairs, each flag at most once and only from `allowed`.
fn options<'a>(args: &'a [String], allowed: &[&str]) -> Result<Vec<(&'a str, &'a str)>, String> {
    let mut out: Vec<(&str, &str)> = Vec::new();
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        if !allowed.contains(&flag.as_str()) {
            return Err(format!("unexpected argument {flag:?}; {USAGE}"));
        }
        let Some(value) = it.next() else {
            return Err(format!("{flag} needs a value; {USAGE}"));
        };
        if out.iter().any(|(f, _)| f == flag) {
            return Err(format!("{flag} given twice; {USAGE}"));
        }
        out.push((flag, value));
    }
    Ok(out)
}

fn opt<'a>(opts: &[(&str, &'a str)], flag: &str) -> Option<&'a str> {
    opts.iter().find(|(f, _)| *f == flag).map(|(_, v)| *v)
}

fn need<'a>(opts: &[(&str, &'a str)], flag: &str) -> Result<&'a str, String> {
    opt(opts, flag).ok_or_else(|| format!("{flag} is required; {USAGE}"))
}

fn port_arg(value: &str, flag: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| format!("{flag} {value:?} is not a port number"))
}

/// A target that starts with `-` would reach ssh as an option.
fn target_arg(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.starts_with('-') {
        return Err(format!("--target {value:?} is not an SSH destination"));
    }
    Ok(value)
}

fn run_free_port(args: &[String]) -> ExitCode {
    let prefer = match options(args, &["--prefer"]).and_then(|o| {
        opt(&o, "--prefer")
            .map(|p| port_arg(p, "--prefer"))
            .transpose()
    }) {
        Ok(p) => p,
        Err(e) => return crate::usage(&e),
    };
    match free_port(prefer) {
        Ok(port) => {
            println!("{}", json!({"type": "free-port", "port": port}));
            ExitCode::SUCCESS
        }
        Err(e) => crate::chat::error("no_free_port", &e),
    }
}

fn run_port_check(args: &[String]) -> ExitCode {
    let parsed = options(args, &["--port", "--browser-id"]).and_then(|o| {
        let port = port_arg(need(&o, "--port")?, "--port")?;
        Ok((port, need(&o, "--browser-id")?.to_string()))
    });
    let (port, id) = match parsed {
        Ok(v) => v,
        Err(e) => return crate::usage(&e),
    };
    let result = port_check(port, &id);
    let reason = result.as_ref().err().cloned().unwrap_or_default();
    println!(
        "{}",
        json!({"type": "port-check", "ok": result.is_ok(), "reason": reason})
    );
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

/// The hidden test flags `--target` and `--ssh-config` point a forward at a scratch sshd.
fn test_flags<'a>(opts: &[(&str, &'a str)]) -> Result<(Option<&'a str>, Option<PathBuf>), String> {
    let target = opt(opts, "--target").map(target_arg).transpose()?;
    Ok((target, opt(opts, "--ssh-config").map(PathBuf::from)))
}

fn run_ensure(args: &[String]) -> ExitCode {
    let parsed = options(args, &["--machine", "--target", "--ssh-config"]).and_then(|o| {
        let (target, config) = test_flags(&o)?;
        Ok((need(&o, "--machine")?, target, config))
    });
    let (machine, target, config) = match parsed {
        Ok(v) => v,
        Err(e) => return crate::usage(&e),
    };
    println!("{}", ensure(machine, target, config.as_deref()).line());
    ExitCode::SUCCESS
}

fn run_dev(args: &[String]) -> ExitCode {
    let parsed =
        options(args, &["--machine", "--port", "--target", "--ssh-config"]).and_then(|o| {
            let (target, config) = test_flags(&o)?;
            let port = port_arg(need(&o, "--port")?, "--port")?;
            Ok((need(&o, "--machine")?, port, target, config))
        });
    let (machine, port, target, config) = match parsed {
        Ok(v) => v,
        Err(e) => return crate::usage(&e),
    };
    println!("{}", dev(machine, port, target, config.as_deref()).line());
    ExitCode::SUCCESS
}

fn run_stop(args: &[String]) -> ExitCode {
    let parsed = options(args, &["--machine", "--dev"]).and_then(|o| {
        let dev = opt(&o, "--dev").map(|p| port_arg(p, "--dev")).transpose()?;
        Ok((need(&o, "--machine")?, dev))
    });
    let (machine, dev) = match parsed {
        Ok(v) => v,
        Err(e) => return crate::usage(&e),
    };
    println!("{}", stop(machine, dev).line());
    ExitCode::SUCCESS
}

fn run_keep(args: &[String]) -> ExitCode {
    let parsed = options(
        args,
        &["--machine", "--target", "--port", "--kind", "--ssh-config"],
    )
    .and_then(|o| {
        let kind = match opt(&o, "--kind") {
            None | Some("browser") => Kind::Browser,
            Some("dev") => Kind::Dev,
            Some(other) => return Err(format!("--kind {other:?} is not browser or dev")),
        };
        let target = target_arg(need(&o, "--target")?)?;
        let port = port_arg(need(&o, "--port")?, "--port")?;
        Ok((
            kind,
            need(&o, "--machine")?,
            target,
            port,
            opt(&o, "--ssh-config").map(PathBuf::from),
        ))
    });
    let (kind, machine, target, port, config) = match parsed {
        Ok(v) => v,
        Err(e) => return crate::usage(&e),
    };
    keep(kind, machine, target, port, config.as_deref())
}

/// 6 hex of FNV-1a over the whole name; `-` and 6 hex.
const HASH_LEN: usize = 7;

/// `[a-z0-9-]`, lower case, at most `max` characters, without a trailing `-`.
fn readable(machine: &str, max: usize) -> String {
    let s: String = machine
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(max)
        .collect();
    match s.trim_end_matches('-') {
        "" => "machine".into(),
        s => s.into(),
    }
}

fn name_hash(machine: &str) -> String {
    let h = u64::from_str_radix(&fnv1a(machine), 16).unwrap_or(0);
    format!("{:06x}", h & 0xff_ffff)
}

/// A readable prefix and a hash of the whole name, so machines that share a prefix or differ only in case or
/// punctuation never share a state file, lock or terminal; `bw-fwd-<slug>` fits hc's 32 characters.
pub fn slug(machine: &str) -> String {
    let room = NAME_MAX - "bw-fwd-".len() - HASH_LEN;
    format!("{}-{}", readable(machine, room), name_hash(machine))
}

/// `bw-fwd-<slug>`, or `bw-dev-<prefix>-<hash>-<port>` with the prefix cut so the hash and port always fit.
pub fn terminal_name(kind: Kind, machine: &str, port: u16) -> String {
    match kind {
        Kind::Browser => format!("bw-fwd-{}", slug(machine)),
        Kind::Dev => {
            let tail = format!("-{}-{port}", name_hash(machine));
            let room = NAME_MAX - "bw-dev-".len() - tail.len();
            format!("bw-dev-{}{tail}", readable(machine, room))
        }
    }
}

fn forwards_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join(".local/share/bellwether/browser/forwards")
        .join(cache::safe(&cache::core_name()))
}

fn state_path(kind: Kind, machine: &str, port: u16) -> PathBuf {
    let slug = slug(machine);
    forwards_dir().join(match kind {
        Kind::Browser => format!("{slug}.json"),
        Kind::Dev => format!("{slug}-dev-{port}.json"),
    })
}

fn read(path: &Path) -> Option<Forward> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Through a temporary file and a rename, so a reader never sees half a record.
fn write(path: &Path, f: &Forward) {
    let Some(dir) = path.parent() else { return };
    let _ = fs::create_dir_all(dir);
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let Ok(bytes) = serde_json::to_vec(f) else {
        return;
    };
    if fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Free on 127.0.0.1: it binds, and no listener on any address holds it (a bind can share a port
/// with a wildcard listener).
fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
        && matches!(listen::listeners(port), Ok(ls) if ls.is_empty())
}

/// `prefer` when it is free, else a port the kernel hands out that nothing else holds.
pub fn free_port(prefer: Option<u16>) -> Result<u16, String> {
    if let Some(p) = prefer.filter(|p| port_is_free(*p)) {
        return Ok(p);
    }
    for _ in 0..5 {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|l| l.local_addr())
            .map_err(|e| format!("cannot bind 127.0.0.1:0: {e}"))?
            .port();
        if port_is_free(port) {
            return Ok(port);
        }
    }
    Err("no free port on 127.0.0.1 after 5 tries".into())
}

/// Ok when only loopback listens on `port` and its `/json/version` names `browser_id`.
pub fn port_check(port: u16, browser_id: &str) -> Result<(), String> {
    let ls = listen::listeners(port)?;
    listen::loopback_only(&ls, port)?;
    let (_, id) = cdp::browser_ws(port)?;
    if id != browser_id {
        return Err(format!(
            "127.0.0.1:{port} answers for browser {id}, not the Bellwether Chrome's {browser_id}"
        ));
    }
    Ok(())
}

/// `ssh` and its arguments for one forward (decisions 8 and 9); the Chrome's port is `BW_CHROME_PORT` or 9222.
pub fn ssh_argv(kind: Kind, target: &str, port: u16, ssh_config: Option<&Path>) -> Vec<String> {
    ssh_argv_to(kind, target, port, ssh_config, chrome::port())
}

fn ssh_argv_to(
    kind: Kind,
    target: &str,
    port: u16,
    ssh_config: Option<&Path>,
    chrome_port: u16,
) -> Vec<String> {
    let mut argv = vec!["ssh".to_string()];
    if let Some(f) = ssh_config {
        argv.extend(["-F".to_string(), f.display().to_string()]);
    }
    let mut opts = vec!["ExitOnForwardFailure=yes", "BatchMode=yes"];
    if kind == Kind::Dev {
        opts.push("GatewayPorts=no");
    }
    opts.extend([
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
        "ControlMaster=no",
        "ControlPath=none",
    ]);
    for o in opts {
        argv.extend(["-o".to_string(), o.to_string()]);
    }
    argv.push("-N".into());
    match kind {
        Kind::Browser => argv.extend([
            "-R".to_string(),
            format!("127.0.0.1:{port}:127.0.0.1:{chrome_port}"),
        ]),
        Kind::Dev => argv.extend([
            "-L".to_string(),
            format!("127.0.0.1:{port}:127.0.0.1:{port}"),
        ]),
    }
    argv.push(target.to_string());
    argv
}

/// The SSH destination for `machine` from `hc machine ls`, or the state and reason that rule it out.
/// A test `--target` stands in for a `via` machine's missing SSH destination.
fn reach(machine: &str, target: Option<&str>) -> Result<String, (&'static str, String)> {
    let v = hc::hc_json(&["machine", "ls", "--json"])
        .map_err(|e| ("offline", format!("cannot list hc's machines: {e}")))?;
    let entry = v["machines"]
        .as_array()
        .and_then(|ms| ms.iter().find(|m| m["name"] == machine))
        .ok_or_else(|| ("offline", format!("hc has no machine named {machine:?}")))?;
    if target.is_none() && entry["via"].as_bool() == Some(true) {
        return Err((
            "via",
            format!("browser forward unavailable: {machine} connects through via, not SSH"),
        ));
    }
    let state = entry["state"].as_str().unwrap_or("unknown");
    if state != "connected" {
        return Err(("offline", format!("{machine} is {state}")));
    }
    if let Some(t) = target {
        return Ok(t.to_string());
    }
    match entry["target"].as_str() {
        Some(t) if !t.is_empty() && !t.starts_with('-') => Ok(t.to_string()),
        _ => Err((
            "refused",
            format!("hc's target for {machine} is not an SSH destination"),
        )),
    }
}

pub(super) enum Remote {
    /// hc could not reach the machine; a later try may.
    Unreachable(String),
    /// The machine answered, but not with what this helper needs.
    Failed(String),
}

/// One JSON line from `bw <args>` on `machine`, run by its installed helper.
pub(super) fn remote_line(machine: &str, args: &[&str]) -> Result<Value, Remote> {
    let mut argv = vec!["sh", "-c", RUN_HELPER, "sh"];
    argv.extend_from_slice(args);
    let out = match hc::hc_exec(machine, &argv) {
        Ok(out) => out,
        Err(e @ (HcError::Unreachable(_) | HcError::TimedOut)) => {
            return Err(Remote::Unreachable(e.to_string()))
        }
        Err(e) => return Err(Remote::Failed(e.to_string())),
    };
    if matches!(out.code, Some(126 | 127)) {
        return Err(Remote::Failed(format!(
            "no Bellwether helper on {machine}; install it"
        )));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .ok_or_else(|| {
            Remote::Failed(format!(
                "the helper on {machine} printed no JSON: {}",
                text.trim()
            ))
        })
}

/// An answer that is not the line asked for: most likely a helper older than 0.4.0.
fn not_understood(machine: &str, v: &Value) -> String {
    format!(
        "the helper on {machine} cannot do this ({}); install it again",
        v["message"].as_str().unwrap_or("no answer line")
    )
}

fn remote_free_port(machine: &str, prefer: Option<u16>) -> Result<u16, (&'static str, String)> {
    let prefer = prefer.map(|p| p.to_string());
    let mut args = vec!["browser", "free-port"];
    if let Some(p) = &prefer {
        args.extend(["--prefer", p]);
    }
    match remote_line(machine, &args) {
        Ok(v) if v["type"] == "free-port" => v["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .ok_or_else(|| ("refused", not_understood(machine, &v))),
        Ok(v) => Err(("refused", not_understood(machine, &v))),
        Err(Remote::Unreachable(r)) => Err(("offline", r)),
        Err(Remote::Failed(r)) => Err(("refused", r)),
    }
}

enum Check {
    Pass,
    /// Nothing listens yet, or the machine did not answer: not a wrong listener.
    NotYet(String),
    /// A listener that must never be used.
    Wrong(String),
}

fn remote_check(machine: &str, port: u16, browser_id: &str) -> Check {
    let p = port.to_string();
    let args = [
        "browser",
        "port-check",
        "--port",
        &p,
        "--browser-id",
        browser_id,
    ];
    match remote_line(machine, &args) {
        Ok(v) if v["type"] == "port-check" && v["ok"] == true => Check::Pass,
        Ok(v) if v["type"] == "port-check" => {
            let reason = v["reason"].as_str().unwrap_or("").to_string();
            if reason.starts_with("nothing listens on") {
                Check::NotYet(format!("{reason} on {machine}"))
            } else {
                Check::Wrong(format!("on {machine}: {reason}"))
            }
        }
        Ok(v) => Check::Wrong(not_understood(machine, &v)),
        Err(Remote::Unreachable(r)) => Check::NotYet(r),
        Err(Remote::Failed(r)) => Check::Wrong(r),
    }
}

/// `hc` as an absolute path, since the core's terminals may run with a PATH that lacks it.
fn resolve(program: OsString) -> String {
    let path = PathBuf::from(&program);
    if path.components().count() > 1 {
        return std::path::absolute(&path)
            .unwrap_or(path)
            .display()
            .to_string();
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join(&path))
        .find(|f| f.is_file())
        .unwrap_or(path)
        .display()
        .to_string()
}

/// What the supervisor needs from this process's settings: a terminal gets the core's environment, not ours.
fn keep_env() -> Vec<String> {
    let mut env = vec![format!("BW_HC={}", resolve(hc::program()))];
    for key in [
        "BW_SSH",
        "BW_CHROME_PORT",
        "BW_CHROME_PROFILE",
        "BW_PS",
        "BW_PROC_ARGV",
    ] {
        if let Some(v) = std::env::var_os(key).filter(|v| !v.is_empty()) {
            env.push(format!("{key}={}", v.to_string_lossy()));
        }
    }
    env
}

fn start_keep(
    kind: Kind,
    machine: &str,
    target: &str,
    port: u16,
    ssh_config: Option<&Path>,
    name: &str,
) -> Result<(), String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let bw = std::env::current_exe()
        .map_err(|e| format!("cannot find this bw: {e}"))?
        .display()
        .to_string();
    let port = port.to_string();
    let mut argv: Vec<String> = [
        "run",
        "--bg",
        "--json",
        "--no-parent",
        "--no-notify",
        "--name",
        name,
        "--cwd",
        &home,
        "--",
        "env",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    argv.extend(keep_env());
    argv.extend(
        [
            bw.as_str(),
            "browser",
            "forward",
            "keep",
            "--machine",
            machine,
            "--target",
            target,
            "--port",
            &port,
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    if kind == Kind::Dev {
        argv.extend(["--kind".to_string(), "dev".to_string()]);
    }
    if let Some(f) = ssh_config {
        argv.extend(["--ssh-config".to_string(), f.display().to_string()]);
    }
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    hc::hc_json(&refs)
        .map(|_| ())
        .map_err(|e| format!("hc run {name}: {e}"))
}

/// Ends and removes the terminal; one that does not exist is already gone.
fn remove_terminal(name: &str) -> Result<(), String> {
    for op in ["kill", "rm"] {
        match hc::hc_json(&[op, name, "--json"]) {
            Ok(_) => {}
            Err(HcError::Refused { kind, .. }) if kind == "not_found" => {}
            // A supervisor that gave up has already ended: there is nothing to kill, only to remove.
            Err(HcError::Refused { kind, .. }) if op == "kill" && kind == "finished" => {}
            Err(e) => return Err(format!("hc {op} {name}: {e}")),
        }
    }
    Ok(())
}

/// The terminal is live and still runs this forward's supervisor on `port`.
fn runs_keep(name: &str, port: Option<u16>) -> bool {
    let Ok(t) = hc::hc_get(name) else {
        return false;
    };
    let argv: Vec<&str> = t["argv"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let port = port.map(|p| p.to_string());
    t["state"] == "live"
        && argv.windows(3).any(|w| w == ["browser", "forward", "keep"])
        && argv
            .windows(2)
            .any(|w| w[0] == "--port" && Some(w[1]) == port.as_deref())
}

/// Waits for the supervisor to report something other than `starting`.
fn wait_settled(path: &Path, started: &Forward) -> Forward {
    let deadline = Instant::now() + ENSURE_WAIT;
    loop {
        let now = read(path).unwrap_or_else(|| started.clone());
        if now.state != "starting" {
            return now;
        }
        if Instant::now() >= deadline {
            return now.with(
                "starting",
                format!(
                    "the forward did not report within {} s",
                    ENSURE_WAIT.as_secs()
                ),
            );
        }
        thread::sleep(ENSURE_POLL);
    }
}

/// Why a state file at `machine`'s path is another machine's, whose terminal this call must leave alone.
fn belongs_elsewhere(rec: &Forward, machine: &str, path: &Path) -> Option<String> {
    (rec.machine != machine).then(|| {
        format!(
            "{} belongs to the forward to {:?}, not {machine:?}; stop that one first",
            path.display(),
            rec.machine
        )
    })
}

/// `bw browser forward ensure`: a checked browser forward to `machine`, reused when one is ready.
pub fn ensure(machine: &str, target: Option<&str>, ssh_config: Option<&Path>) -> Forward {
    // A second ensure for the machine would remove the first one's new terminal; it waits and reuses it.
    let lock_path = forwards_dir().join(format!("{}.lock", slug(machine)));
    let wait = ENSURE_WAIT * PORT_TRIES as u32 + LOCK_SLACK;
    match lock::exclusive(&lock_path, wait) {
        Ok(_held) => ensure_held(machine, target, ssh_config),
        Err(e) => {
            Forward::new(Kind::Browser, machine, target.unwrap_or(""), None).with("stopped", e)
        }
    }
}

fn ensure_held(machine: &str, target: Option<&str>, ssh_config: Option<&Path>) -> Forward {
    let rec = Forward::new(Kind::Browser, machine, target.unwrap_or(""), None);
    let target = match reach(machine, target) {
        Ok(t) => t,
        Err((state, reason)) => return rec.with(state, reason),
    };
    let mut rec = Forward { target, ..rec };
    let chrome = chrome::probe(chrome::port(), &chrome::profile_dir());
    let id = match (chrome.state, chrome.browser_id) {
        ("running", Some(id)) => id,
        _ => return rec.with("stopped", chrome.message),
    };
    let path = state_path(Kind::Browser, machine, 0);
    let old = read(&path);
    if let Some(other) = old
        .as_ref()
        .and_then(|o| belongs_elsewhere(o, machine, &path))
    {
        return rec.with("refused", other);
    }
    if let Some(old) = &old {
        if old.state == "ready"
            && old.target == rec.target
            && old.browser_id.as_deref() == Some(id.as_str())
            && runs_keep(&old.terminal, old.port)
        {
            return old.clone();
        }
    }
    let mut prefer = old.and_then(|o| o.port);
    let mut tried = Vec::new();
    for _ in 0..PORT_TRIES {
        if let Err(e) = remove_terminal(&rec.terminal) {
            return rec.with("stopped", e);
        }
        let port = match remote_free_port(machine, prefer) {
            Ok(p) => p,
            Err((state, reason)) => return rec.with(state, reason),
        };
        tried.push(port.to_string());
        rec.port = Some(port);
        rec.browser_id = Some(id.clone());
        rec = rec.with("starting", "");
        write(&path, &rec);
        if let Err(e) = start_keep(
            Kind::Browser,
            machine,
            &rec.target,
            port,
            ssh_config,
            &rec.terminal,
        ) {
            rec = rec.with("stopped", e);
            write(&path, &rec);
            return rec;
        }
        rec = wait_settled(&path, &rec);
        if rec.state != "port_taken" {
            return rec;
        }
        prefer = None;
    }
    rec.reason = format!(
        "{PORT_TRIES} ports in a row were taken on {machine}: {}",
        tried.join(", ")
    );
    write(&path, &rec);
    rec
}

/// `bw browser forward dev`: this machine's `127.0.0.1:<port>` reaches the same port on `machine`.
pub fn dev(machine: &str, port: u16, target: Option<&str>, ssh_config: Option<&Path>) -> Forward {
    let rec = Forward::new(Kind::Dev, machine, target.unwrap_or(""), Some(port));
    let target = match reach(machine, target) {
        Ok(t) => t,
        Err((state, reason)) => return rec.with(state, reason),
    };
    let rec = Forward { target, ..rec };
    let path = state_path(Kind::Dev, machine, port);
    if let Some(old) = read(&path) {
        if let Some(other) = belongs_elsewhere(&old, machine, &path) {
            return rec.with("refused", other);
        }
        if matches!(old.state.as_str(), "ready" | "ready_no_answer")
            && old.target == rec.target
            && runs_keep(&old.terminal, old.port)
        {
            return old;
        }
    }
    if let Err(e) = remove_terminal(&rec.terminal) {
        return rec.with("stopped", e);
    }
    if !port_is_free(port) {
        let by = listen::listeners(port)
            .ok()
            .and_then(|ls| ls.first().map(listen::owner))
            .map(|o| format!(" by {o}"))
            .unwrap_or_default();
        return rec.with(
            "local_port_taken",
            format!("port {port} on this machine is in use{by}"),
        );
    }
    let rec = rec.with("starting", "");
    write(&path, &rec);
    if let Err(e) = start_keep(
        Kind::Dev,
        machine,
        &rec.target,
        port,
        ssh_config,
        &rec.terminal,
    ) {
        let rec = rec.with("stopped", e);
        write(&path, &rec);
        return rec;
    }
    wait_settled(&path, &rec)
}

/// `bw browser forward stop`: ends the forward's terminal and forgets it.
pub fn stop(machine: &str, dev: Option<u16>) -> Forward {
    let kind = if dev.is_some() {
        Kind::Dev
    } else {
        Kind::Browser
    };
    let path = state_path(kind, machine, dev.unwrap_or(0));
    let rec = read(&path).unwrap_or_else(|| Forward::new(kind, machine, "", dev));
    if let Some(other) = belongs_elsewhere(&rec, machine, &path) {
        let state = rec.state.clone();
        return rec.with(&state, other);
    }
    if let Err(e) = remove_terminal(&rec.terminal) {
        let state = rec.state.clone();
        return rec.with(&state, format!("cannot stop it: {e}"));
    }
    let _ = fs::remove_file(&path);
    rec.with("stopped", "")
}

/// Every forward this core has a state file for; one whose supervisor is gone reads `stopped`.
pub fn list() -> Vec<Forward> {
    let Ok(entries) = fs::read_dir(forwards_dir()) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    // Without an answer from hc, liveness is unknown and each record stands as written.
    let live: Option<HashSet<String>> = hc::hc_ls().ok().map(|v| {
        v["terminals"]
            .as_array()
            .map(|ts| {
                ts.iter()
                    .filter(|t| t["state"] == "live")
                    .filter_map(|t| t["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    });
    files
        .iter()
        .filter_map(|p| read(p))
        .map(|f| match &live {
            Some(live)
                if LIVE_STATES.contains(&f.state.as_str()) && !live.contains(&f.terminal) =>
            {
                f.with("stopped", "")
            }
            _ => f,
        })
        .collect()
}

/// The ssh child of a supervisor, with its last stderr lines.
struct Ssh {
    child: Child,
    lines: Arc<Mutex<Vec<String>>>,
    reader: Option<JoinHandle<()>>,
}

impl Ssh {
    fn spawn(argv: &[String]) -> Result<Ssh, String> {
        let program = std::env::var_os("BW_SSH")
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "ssh".into());
        let mut child = Command::new(&program)
            .args(&argv[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run {}: {e}", program.to_string_lossy()))?;
        let lines = Arc::new(Mutex::new(Vec::new()));
        let reader = child.stderr.take().map(|err| {
            let lines = lines.clone();
            thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    println!("ssh: {line}");
                    if let Ok(mut l) = lines.lock() {
                        l.push(line);
                        let n = l.len();
                        l.drain(..n.saturating_sub(8));
                    }
                }
            })
        });
        Ok(Ssh {
            child,
            lines,
            reader,
        })
    }

    /// Forgets what ssh said while connecting, so a later reason is about the connection that dropped.
    fn forget_lines(&self) {
        if let Ok(mut l) = self.lines.lock() {
            l.clear();
        }
    }

    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Waits up to `limit` for ssh to exit by itself.
    fn exits_within(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while self.running() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
        true
    }

    /// Kills ssh if it still runs, then its exit status and last stderr lines.
    fn finish(mut self) -> (String, Vec<String>) {
        let _ = self.child.kill();
        let status = self
            .child
            .wait()
            .map(|s| s.to_string())
            .unwrap_or_else(|e| e.to_string());
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
        let lines = self.lines.lock().map(|l| l.clone()).unwrap_or_default();
        (status, lines)
    }
}

/// The stderr line that says ssh could not listen on its port, which only another program can hold.
fn taken_line(lines: &[String]) -> Option<&String> {
    lines.iter().find(|l| {
        l.contains("remote port forwarding failed")
            || l.contains("Could not request local forwarding")
            || l.contains("Address already in use")
    })
}

enum Outcome {
    /// The checks passed: `ready`, or `ready_no_answer` for a dev server that does not answer yet.
    Up(&'static str),
    /// ssh exited by itself before the checks passed.
    Exited,
    /// The checks did not pass in time, without finding a wrong listener.
    Down(String),
    /// A wrong listener: never retried.
    Wrong(String),
}

fn dev_answers(port: u16) -> &'static str {
    match http::get(port, "/", DEV_ANSWER) {
        Ok(_) => "ready",
        Err(_) => "ready_no_answer",
    }
}

fn check_browser(ssh: &mut Ssh, machine: &str, port: u16, id: &str) -> Outcome {
    let deadline = Instant::now() + CHECK_WINDOW;
    loop {
        if !ssh.running() {
            return Outcome::Exited;
        }
        match remote_check(machine, port, id) {
            Check::Pass => return Outcome::Up("ready"),
            Check::Wrong(reason) => return Outcome::Wrong(reason),
            Check::NotYet(reason) if Instant::now() >= deadline => {
                return Outcome::Down(format!(
                    "{reason} {} s after ssh started",
                    CHECK_WINDOW.as_secs()
                ))
            }
            Check::NotYet(_) => thread::sleep(CHECK_POLL),
        }
    }
}

/// The dev forward's listener is this machine's ssh child, on loopback only.
fn check_dev(ssh: &mut Ssh, port: u16) -> Outcome {
    let deadline = Instant::now() + CHECK_WINDOW;
    let pid = ssh.child.id() as i32;
    loop {
        if !ssh.running() {
            return Outcome::Exited;
        }
        match listen::listeners(port) {
            Err(e) => return Outcome::Wrong(e),
            Ok(ls) if !ls.is_empty() => {
                if let Err(e) = listen::loopback_only(&ls, port) {
                    return Outcome::Wrong(e);
                }
                if let Some(l) = ls.iter().find(|l| l.pid != pid) {
                    return Outcome::Wrong(format!(
                        "{} holds port {port} here, not this forward's ssh",
                        listen::owner(l)
                    ));
                }
                return Outcome::Up(dev_answers(port));
            }
            Ok(_) if Instant::now() >= deadline => {
                return Outcome::Down(format!(
                    "nothing listened on 127.0.0.1:{port} here {} s after ssh started",
                    CHECK_WINDOW.as_secs()
                ))
            }
            Ok(_) => thread::sleep(CHECK_POLL),
        }
    }
}

/// Writes the record and shows the change on the terminal's screen.
fn report(path: &Path, rec: &Forward) {
    write(path, rec);
    let reason = if rec.reason.is_empty() {
        String::new()
    } else {
        format!(": {}", rec.reason)
    };
    println!(
        "{} {} port {}{reason}",
        rec.terminal,
        rec.state,
        rec.port.unwrap_or(0)
    );
}

fn backoff(failures: usize) -> Duration {
    Duration::from_secs(BACKOFF_S.get(failures).copied().unwrap_or(BACKOFF_MAX_S))
}

/// `bw browser forward keep`: runs ssh, checks each connection, reconnects on the same port after an exit,
/// and exits for good on a wrong listener or a port that another program took.
fn keep(kind: Kind, machine: &str, target: &str, port: u16, ssh_config: Option<&Path>) -> ExitCode {
    let path = state_path(kind, machine, port);
    let mut rec = Forward::new(kind, machine, target, Some(port)).with("starting", "");
    if kind == Kind::Browser {
        rec.browser_id = read(&path).and_then(|f| f.browser_id);
    }
    report(&path, &rec);
    let give_up = |rec: Forward, state: &str, reason: String| {
        report(&path, &rec.with(state, reason));
        ExitCode::from(1)
    };
    let argv = ssh_argv(kind, target, port, ssh_config);
    let mut failures = 0;
    loop {
        // Read afresh each time: the Chrome may have restarted with a new id since the last connection.
        let id = if kind == Kind::Browser {
            let c = chrome::probe(chrome::port(), &chrome::profile_dir());
            match (c.state, c.browser_id) {
                ("running", Some(id)) => Some(id),
                _ => return give_up(rec, "refused", c.message),
            }
        } else {
            None
        };
        let mut ssh = match Ssh::spawn(&argv) {
            Ok(s) => s,
            Err(e) => return give_up(rec, "refused", e),
        };
        let outcome = match &id {
            Some(id) => check_browser(&mut ssh, machine, port, id),
            None => check_dev(&mut ssh, port),
        };
        let mut down = None;
        match outcome {
            Outcome::Wrong(reason) => {
                // ssh that failed to listen lets the check see the program holding the port.
                if ssh.exits_within(Duration::from_secs(1)) {
                    let (_, lines) = ssh.finish();
                    if let Some(line) = taken_line(&lines) {
                        return give_up(rec, taken_state(kind), format!("port {port}: {line}"));
                    }
                } else {
                    ssh.finish();
                }
                return give_up(rec, "refused", reason);
            }
            Outcome::Up(state) => {
                rec.browser_id = id.clone();
                rec.checked_at_ms = now_ms();
                rec = rec.with(state, "");
                report(&path, &rec);
                failures = 0;
                ssh.forget_lines();
                let mut last = Instant::now();
                while ssh.running() {
                    thread::sleep(UP_POLL);
                    if kind == Kind::Dev && last.elapsed() >= DEV_RECHECK {
                        let now = dev_answers(port);
                        if now != rec.state {
                            rec = rec.with(now, "");
                            report(&path, &rec);
                        }
                        last = Instant::now();
                    }
                }
            }
            Outcome::Down(reason) => down = Some(reason),
            Outcome::Exited => {}
        }
        let (status, lines) = ssh.finish();
        if down.is_none() {
            if let Some(line) = taken_line(&lines) {
                return give_up(rec, taken_state(kind), format!("port {port}: {line}"));
            }
        }
        let reason = down
            .or_else(|| lines.last().cloned())
            .unwrap_or_else(|| format!("ssh exited ({status})"));
        rec = rec.with("reconnecting", reason);
        report(&path, &rec);
        thread::sleep(backoff(failures));
        failures += 1;
    }
}

fn taken_state(kind: Kind) -> &'static str {
    match kind {
        Kind::Browser => "port_taken",
        Kind::Dev => "local_port_taken",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ssh_argv_is_exact_for_browser_and_dev() {
        assert_eq!(
            ssh_argv_to(Kind::Browser, "dk@mac2", 52817, None, 9222),
            s(&[
                "ssh",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "BatchMode=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-N",
                "-R",
                "127.0.0.1:52817:127.0.0.1:9222",
                "dk@mac2",
            ])
        );
        assert_eq!(
            ssh_argv_to(
                Kind::Dev,
                "bw-scratch",
                3000,
                Some(Path::new("/s/ssh_config")),
                9222
            ),
            s(&[
                "ssh",
                "-F",
                "/s/ssh_config",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "BatchMode=yes",
                "-o",
                "GatewayPorts=no",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-N",
                "-L",
                "127.0.0.1:3000:127.0.0.1:3000",
                "bw-scratch",
            ])
        );
    }

    #[test]
    fn slug_and_terminal_names_fit_32() {
        assert_eq!(slug("macmini"), "macmini-c27a57");
        assert_eq!(slug("Mac Mini.local"), "mac-mini-local-ba0f9a");
        assert_eq!(slug(""), "machine-222325");
        assert_eq!(
            terminal_name(Kind::Browser, "macmini", 0),
            "bw-fwd-macmini-c27a57"
        );
        assert_eq!(
            terminal_name(Kind::Dev, "macmini", 3000),
            "bw-dev-macmini-c27a57-3000"
        );
        let long = "a-very-long-machine-name-that-goes-on.example.com";
        for name in [
            terminal_name(Kind::Browser, long, 0),
            terminal_name(Kind::Dev, long, 65535),
            terminal_name(Kind::Dev, "ünïcødé", 1),
        ] {
            assert!(name.len() <= 32, "{name}");
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{name}"
            );
        }
        // The port survives the cut, so two dev forwards to one machine never share a name.
        assert!(terminal_name(Kind::Dev, long, 65535).ends_with("-65535"));
        assert_eq!(terminal_name(Kind::Browser, long, 0).len(), 32);
    }

    #[test]
    fn distinct_machines_never_share_a_name() {
        let pairs = [
            (
                "builder-production-us-east-1",
                "builder-production-us-east-2",
            ),
            ("Mac.mini", "mac-mini"),
            ("MACMINI", "macmini"),
            ("a", "a-"),
        ];
        for (a, b) in pairs {
            assert_ne!(slug(a), slug(b), "{a} {b}");
            for (kind, port) in [(Kind::Browser, 0), (Kind::Dev, 65535), (Kind::Dev, 1)] {
                let (ta, tb) = (terminal_name(kind, a, port), terminal_name(kind, b, port));
                assert_ne!(ta, tb, "{a} {b}");
                assert!(ta.len() <= 32 && tb.len() <= 32, "{ta} {tb}");
                assert_ne!(state_path(kind, a, port), state_path(kind, b, port));
            }
        }
    }

    #[test]
    fn taken_lines_are_recognised() {
        let r = s(&["Error: remote port forwarding failed for listen port 52817"]);
        assert!(taken_line(&r).is_some());
        let l = s(&[
            "bind [127.0.0.1]:3000: Address already in use",
            "Could not request local forwarding.",
        ]);
        assert!(taken_line(&l).is_some());
        let other = s(&["dk@mac2: Permission denied (publickey)."]);
        assert!(taken_line(&other).is_none());
    }

    #[test]
    fn backoff_steps_then_holds_at_a_minute() {
        let got: Vec<u64> = (0..8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(got, [2, 4, 8, 16, 30, 60, 60, 60]);
    }
}
