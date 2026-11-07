//! `bw machine status|install <machine>`: the helper on another machine, reached through hc.
//!
//! Adapted from Flockbook's xplat/flockbook-modfeed/src/remote.rs (MIT, Copyright (c) 2026 Min-Chen Lee).
//! No value reaches a shell there: commands are `argv`, and the few fixed `sh -c` scripts take values only as
//! positional arguments. Only `uname` runs on a machine before its platform is known to be Unix.

use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::{json, Value};

use crate::hc::{hc_exec, HcError};
use crate::version::PROTOCOL;

mod install;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Under the home there; `current` beside the version folders links to the one in use.
pub const HELPER_DIR: &str = ".local/share/bellwether/helper";
/// Under this machine's home: helpers built here for other platforms, from scripts/build-dist.sh.
const DIST_DIR: &str = ".local/share/bellwether/dist";
const RUN_HELPER: &str = r#"exec "$HOME"/.local/share/bellwether/helper/current/bw "$@""#;

const USAGE: &str = "usage: bw machine status <machine> | bw machine install <machine> [--force]";

pub fn run(args: &[String]) -> ExitCode {
    let sub = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or_default();
    let force = rest.iter().any(|a| a == "--force");
    let mut names = rest.iter().filter(|a| *a != "--force");
    let (Some(machine), None) = (names.next(), names.next()) else {
        return crate::usage(USAGE);
    };
    if machine.is_empty() || machine.starts_with('-') {
        return crate::usage(&format!("bad machine name {machine:?}; {USAGE}"));
    }
    match (sub, force) {
        (Some("status"), false) => {
            println!("{}", status(machine).json());
            ExitCode::SUCCESS
        }
        (Some("install"), _) => install::run(machine, force),
        _ => crate::usage(USAGE),
    }
}

/// `uname -sm` there -> the helper built for it. None: no build of this helper runs there.
pub fn target_for(uname: &str) -> Option<&'static str> {
    let mut it = uname.split_whitespace();
    match (it.next()?, it.next()?) {
        ("Darwin", "arm64") => Some("aarch64-apple-darwin"),
        ("Linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("Linux", "aarch64" | "arm64") => Some("aarch64-unknown-linux-musl"),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum State {
    Current,
    Missing,
    Outdated,
    Unreachable,
    NoBuild,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            State::Current => "current",
            State::Missing => "missing",
            State::Outdated => "outdated",
            State::Unreachable => "unreachable",
            State::NoBuild => "no_build",
        }
    }
}

pub struct Status {
    pub machine: String,
    pub state: State,
    /// What `bw version` printed there.
    pub remote: Option<Value>,
    pub uname: Option<String>,
    pub target: Option<&'static str>,
    pub message: Option<String>,
}

impl Status {
    pub fn json(&self) -> Value {
        let mut v = json!({
            "type": "machine",
            "machine": self.machine,
            "state": self.state.name(),
            "remote": self.remote,
            "uname": self.uname,
            "target": self.target,
        });
        if let Some(m) = &self.message {
            v["message"] = json!(m);
        }
        v
    }
}

/// Where the helper for `target` comes from on this machine, without reading it.
pub enum Source {
    /// `BW_INSTALL_SOURCE`, for tests and local builds; used for any target.
    Given(PathBuf),
    /// This executable, when it is built for `target`.
    ThisExe(PathBuf),
    /// `~/.local/share/bellwether/dist/<target>/bw`, checked against `SHA256SUMS` beside it.
    Dist(PathBuf),
}

impl Source {
    pub fn path(&self) -> &PathBuf {
        match self {
            Source::Given(p) | Source::ThisExe(p) | Source::Dist(p) => p,
        }
    }
}

pub fn source_for(target: &str) -> Option<Source> {
    if let Some(p) = std::env::var_os("BW_INSTALL_SOURCE").filter(|p| !p.is_empty()) {
        return Some(Source::Given(p.into()));
    }
    if target == env!("BW_TARGET") {
        if let Ok(exe) = std::env::current_exe() {
            return Some(Source::ThisExe(exe));
        }
    }
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
    let file = PathBuf::from(home).join(DIST_DIR).join(target).join("bw");
    file.is_file().then_some(Source::Dist(file))
}

/// What the helper on `machine` is, from `uname -sm` and `bw version` there.
pub fn status(machine: &str) -> Status {
    let mut s = Status {
        machine: machine.to_string(),
        state: State::Unreachable,
        remote: None,
        uname: None,
        target: None,
        message: None,
    };
    let uname = match hc_exec(machine, &["uname", "-sm"]) {
        Ok(out) if out.code == Some(0) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Ok(_) | Err(HcError::NoProgram(_)) => String::new(),
        Err(e) => {
            s.message = Some(e.to_string());
            return s;
        }
    };
    s.target = target_for(&uname);
    s.uname = Some(uname);
    let Some(target) = s.target else {
        s.state = State::NoBuild;
        return s;
    };
    s.state = match hc_exec(machine, &["sh", "-c", RUN_HELPER, "sh", "version"]) {
        Err(HcError::NoProgram(_)) => State::Missing,
        Err(e) => {
            s.message = Some(e.to_string());
            return s;
        }
        Ok(out) if matches!(out.code, Some(126 | 127)) => State::Missing,
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            s.remote = text
                .lines()
                .next()
                .and_then(|l| serde_json::from_str::<Value>(l).ok())
                .filter(Value::is_object);
            let same = s.remote.as_ref().is_some_and(|r| {
                r["protocol"].as_u64() == Some(PROTOCOL.into()) && r["version"] == VERSION
            });
            if out.code == Some(0) && same {
                State::Current
            } else {
                State::Outdated
            }
        }
    };
    if s.state != State::Current && source_for(target).is_none() {
        s.state = State::NoBuild;
    }
    s
}
