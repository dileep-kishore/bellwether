//! `bw browser up|down`: start, reuse and close the Bellwether Chrome.
//!
//! A listener on the port is used only when it is on loopback, its process runs with our
//! `--user-data-dir`, and `/json/version` answers; anything else is named and left alone.

use std::fs::DirBuilder;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::cdp::{self, Cdp};
use super::http;
use super::listen::{self, Listener};
use super::lock;

pub const DEFAULT_PORT: u16 = 9222;
const START_WAIT: Duration = Duration::from_secs(15);
const CLOSE_WAIT: Duration = Duration::from_secs(10);
/// Beyond one start's wait, for the `open` call and the probes around it.
const LOCK_SLACK: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(200);
const HTTP_TIMEOUT: Duration = Duration::from_secs(2);
const NOT_RUNNING: &str = "the Bellwether Chrome is not running";
const NO_DEBUG_PORT: &str =
    "the Bellwether Chrome is running without its debugging port; quit it, then Start";
const NOT_INSTALLED: &str = "Google Chrome is not installed on this Mac";

const USAGE: &str = "usage: bw browser up [--background] | bw browser down";

#[derive(Debug, Clone)]
pub struct Chrome {
    pub state: &'static str,
    pub port: u16,
    pub profile: PathBuf,
    pub pid: Option<i32>,
    pub browser_id: Option<String>,
    pub version: Option<String>,
    pub started: bool,
    pub message: String,
}

impl Chrome {
    fn new(state: &'static str, port: u16, profile: &Path, message: impl Into<String>) -> Chrome {
        Chrome {
            state,
            port,
            profile: profile.to_path_buf(),
            pid: None,
            browser_id: None,
            version: None,
            started: false,
            message: message.into(),
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "type": "chrome",
            "state": self.state,
            "port": self.port,
            "profile": self.profile.display().to_string(),
            "pid": self.pid,
            "browser_id": self.browser_id,
            "version": self.version,
            "started": self.started,
            "message": self.message,
        })
    }
}

pub fn run(cmd: &str, args: &[String]) -> ExitCode {
    let background = match (cmd, args) {
        (_, []) => false,
        ("up", [flag]) if flag == "--background" => true,
        _ => return crate::usage(USAGE),
    };
    if let Err(message) = port_setting() {
        return crate::usage(&message);
    }
    let (port, profile) = (port(), profile_dir());
    let chrome = if cmd == "up" {
        up(port, &profile, background)
    } else {
        down(port, &profile)
    };
    // Every state is an answer for the panel, which reads a non-zero exit as a helper failure.
    println!("{}", chrome.json());
    ExitCode::SUCCESS
}

/// `BW_CHROME_PORT` when set (tests), else 9222; a set value that is not a port is an error.
pub fn port_setting() -> Result<u16, String> {
    match std::env::var("BW_CHROME_PORT") {
        Err(_) => Ok(DEFAULT_PORT),
        Ok(v) => v
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or_else(|| format!("BW_CHROME_PORT={v:?} is not a port number")),
    }
}

/// The debugging port; callers check `BW_CHROME_PORT` with `run`'s usage error first, or accept 9222.
pub fn port() -> u16 {
    port_setting().unwrap_or(DEFAULT_PORT)
}

/// `BW_CHROME_PROFILE` (tests), else `~/.local/share/bellwether/chrome`; always absolute, since the
/// `ps` check compares it with Chrome's `--user-data-dir` text.
pub fn profile_dir() -> PathBuf {
    let path = match std::env::var_os("BW_CHROME_PROFILE").filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".local/share/bellwether/chrome"),
    };
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

/// `open`'s arguments after the program name (decision 1); `-n` keeps it apart from the user's Chrome.
pub fn open_argv(app: &Path, profile: &Path, port: u16, background: bool) -> Vec<String> {
    let mut argv = vec!["-n".to_string()];
    if background {
        argv.push("-g".to_string());
    }
    argv.extend([
        "-a".to_string(),
        app.display().to_string(),
        "--args".to_string(),
        format!("--user-data-dir={}", profile.display()),
        format!("--remote-debugging-port={port}"),
        "--remote-debugging-address=127.0.0.1".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
    ]);
    argv
}

/// The Chrome's state without starting or closing anything.
pub fn probe(port: u16, profile: &Path) -> Chrome {
    let ls = match listen::listeners(port) {
        Ok(ls) => ls,
        Err(e) => {
            return Chrome::new(
                "start_failed",
                port,
                profile,
                format!("cannot read port {port}'s listeners: {e}"),
            )
        }
    };
    if !ls.is_empty() {
        return check_listeners(port, profile, &ls);
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
        // The listener may have opened after lsof ran; only a second empty read means lsof cannot see it.
        match listen::listeners(port) {
            Ok(ls) if !ls.is_empty() => return check_listeners(port, profile, &ls),
            _ => {
                return Chrome::new(
                    "port_taken",
                    port,
                    profile,
                    format!(
                        "Port {port} is used by another program: one that lsof cannot see, \
                         perhaps another user's"
                    ),
                )
            }
        }
    }
    if let Some(pid) = live_lock(profile) {
        let mut c = Chrome::new("no_debug_port", port, profile, NO_DEBUG_PORT);
        c.pid = Some(pid);
        return c;
    }
    if find_app().is_none() {
        return Chrome::new("not_installed", port, profile, NOT_INSTALLED);
    }
    Chrome::new("stopped", port, profile, NOT_RUNNING)
}

fn check_listeners(port: u16, profile: &Path, ls: &[Listener]) -> Chrome {
    let taken = |l: &Listener, why: String| {
        let mut c = Chrome::new(
            "port_taken",
            port,
            profile,
            format!("Port {port} is used by another program: {why}"),
        );
        c.pid = Some(l.pid).filter(|pid| *pid > 0);
        c
    };
    if let Err(why) = listen::loopback_only(ls, port) {
        return taken(&ls[0], why);
    }
    for l in ls {
        let ours =
            l.pid > 0 && ps_command(l.pid).is_some_and(|command| holds_profile(&command, profile));
        if !ours {
            return taken(l, listen::owner(l));
        }
    }
    let mut c = Chrome::new(
        "running",
        port,
        profile,
        format!("the Bellwether Chrome answers on 127.0.0.1:{port}"),
    );
    c.pid = Some(ls[0].pid);
    match cdp::browser_ws(port) {
        Ok((_, id)) => c.browser_id = Some(id),
        Err(e) => {
            c.state = "start_failed";
            c.message = format!("the Bellwether Chrome listens on {port}, but {e}");
            return c;
        }
    }
    c.version = read_version(port);
    c
}

fn read_version(port: u16) -> Option<String> {
    let reply = http::get(port, "/json/version", HTTP_TIMEOUT).ok()?;
    let v: Value = serde_json::from_slice(&reply.body).ok()?;
    v["Browser"].as_str().map(String::from)
}

/// True when `command` has `--user-data-dir=<profile>` as a whole argument, so `<profile>-2` is not ours.
fn holds_profile(command: &str, profile: &Path) -> bool {
    let needle = format!("--user-data-dir={}", profile.display());
    command.match_indices(&needle).any(|(i, _)| {
        let after = &command[i + needle.len()..];
        (i == 0 || command[..i].ends_with(' ')) && (after.is_empty() || after.starts_with(' '))
    })
}

/// `ps -ww -o command= -p <pid>`, or None when the process is gone.
fn ps_command(pid: i32) -> Option<String> {
    let program = std::env::var_os("BW_PS").unwrap_or_else(|| "ps".into());
    let out = Command::new(program)
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// The live pid in the profile's `SingletonLock` symlink, which Chrome points at `<host>-<pid>`.
fn live_lock(profile: &Path) -> Option<i32> {
    lock_pid(profile).filter(|pid| ps_command(*pid).is_some())
}

fn lock_pid(profile: &Path) -> Option<i32> {
    let target = std::fs::read_link(profile.join("SingletonLock")).ok()?;
    let target = target.to_str()?;
    let (_, pid) = target.rsplit_once('-')?;
    pid.parse().ok().filter(|pid| *pid > 0)
}

/// `BW_CHROME_APP` alone when set; else the two usual places, then Spotlight.
fn find_app() -> Option<PathBuf> {
    if let Some(app) = std::env::var_os("BW_CHROME_APP").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(app)).filter(|p| p.exists());
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let usual = [
        PathBuf::from("/Applications/Google Chrome.app"),
        home.join("Applications/Google Chrome.app"),
    ];
    if let Some(app) = usual.into_iter().find(|p| p.exists()) {
        return Some(app);
    }
    let out = Command::new("mdfind")
        .arg("kMDItemCFBundleIdentifier == 'com.google.Chrome'")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// `<profile>.up.lock` beside the profile: Chrome owns the folder itself.
fn up_lock(profile: &Path) -> PathBuf {
    let name = profile.file_name().unwrap_or_default().to_string_lossy();
    profile.with_file_name(format!("{name}.up.lock"))
}

/// Reuses a checked Chrome, else starts one on the profile and waits for its port.
pub fn up(port: u16, profile: &Path, background: bool) -> Chrome {
    let found = probe(port, profile);
    if found.state != "stopped" {
        return found;
    }
    // The panel's Start and an agent's agent-args can both find it stopped; only one may run open.
    let _held = match lock::exclusive(&up_lock(profile), START_WAIT + LOCK_SLACK) {
        Ok(held) => held,
        Err(e) => {
            let mut c = probe(port, profile);
            if c.state == "stopped" {
                c.state = "start_failed";
                c.message = e;
            }
            return c;
        }
    };
    let found = probe(port, profile);
    if found.state != "stopped" {
        return found;
    }
    let Some(app) = find_app() else {
        return Chrome::new("not_installed", port, profile, NOT_INSTALLED);
    };
    let failed = |message: String| {
        let mut c = Chrome::new("start_failed", port, profile, message);
        c.started = true;
        c
    };
    if let Err(e) = DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(profile)
    {
        return Chrome::new(
            "start_failed",
            port,
            profile,
            format!("cannot create {}: {e}", profile.display()),
        );
    }
    let program = std::env::var_os("BW_OPEN").unwrap_or_else(|| "open".into());
    let out = Command::new(&program)
        .args(open_argv(&app, profile, port, background))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    match out {
        Err(e) => return failed(format!("cannot run open: {e}")),
        Ok(out) if !out.status.success() => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let last = stderr.lines().rev().find(|l| !l.trim().is_empty());
            return failed(format!(
                "open exited {}: {}",
                out.status.code().unwrap_or(-1),
                last.unwrap_or("no message")
            ));
        }
        Ok(_) => {}
    }
    let deadline = Instant::now() + START_WAIT;
    loop {
        let mut c = probe(port, profile);
        c.started = true;
        if c.state == "running" {
            c.message = format!("started the Bellwether Chrome on 127.0.0.1:{port}");
            return c;
        }
        if Instant::now() >= deadline {
            if c.state == "port_taken" {
                return c;
            }
            return failed(format!(
                "Chrome did not answer on 127.0.0.1:{port} within {} s: {}",
                START_WAIT.as_secs(),
                c.message
            ));
        }
        thread::sleep(POLL);
    }
}

/// Sends `Browser.close` to a checked Chrome and waits for its port to close; never signals a process.
pub fn down(port: u16, profile: &Path) -> Chrome {
    let mut found = probe(port, profile);
    if found.state != "running" {
        return found;
    }
    let sent = cdp::browser_ws(port).and_then(|(url, _)| {
        let mut client = Cdp::connect(&url, HTTP_TIMEOUT)?;
        // Chrome may drop the socket before it answers; the port closing is what counts.
        let _ = client.call("Browser.close", json!({}));
        Ok(())
    });
    if let Err(e) = sent {
        found.message = format!("cannot close the Bellwether Chrome: {e}");
        return found;
    }
    let deadline = Instant::now() + CLOSE_WAIT;
    loop {
        // The port closes before Chrome exits; waiting for its lock too lets an `up` right after read `stopped`.
        let closed = listen::listeners(port).is_ok_and(|ls| ls.is_empty());
        if closed && live_lock(profile).is_none() {
            return Chrome::new(
                "stopped",
                port,
                profile,
                "closed the Bellwether Chrome".to_string(),
            );
        }
        if Instant::now() >= deadline {
            found.message = format!(
                "sent Browser.close, but the Chrome on port {port} is still running after {} s",
                CLOSE_WAIT.as_secs()
            );
            return found;
        }
        thread::sleep(POLL);
    }
}
