//! `bw browser agent-args|status`: a new agent's extra argv, and the Browser panel's one call.
//!
//! Both print their lines and exit 0 for every outcome, since `shared/helper.js` drops a failed command's
//! output; only a usage error exits 2.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{json, Value};

use super::forward::{self, Remote};
use super::{chrome, tabs};
use crate::agent;
use crate::hc;
use crate::machine::RUN_HELPER;

const USAGE: &str =
    "usage: bw browser agent-args --kind claude|codex --machine <m|\"\"> [--cwd <dir>] \
    [--profile <p>] | bw browser status";

pub fn run(cmd: &str, args: &[String]) -> ExitCode {
    match cmd {
        "agent-args" => match Request::parse(args) {
            Ok(req) => {
                println!("{}", agent_args(&req));
                ExitCode::SUCCESS
            }
            Err(message) => crate::usage(&format!("{message}; {USAGE}")),
        },
        "status" if args.is_empty() => {
            for line in status() {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        _ => crate::usage(USAGE),
    }
}

/// One `agent-args` call. `target` and `ssh_config` are hidden test flags for a scratch sshd.
struct Request {
    kind: String,
    machine: String,
    cwd: Option<String>,
    profile: Option<String>,
    target: Option<String>,
    ssh_config: Option<PathBuf>,
}

impl Request {
    fn parse(args: &[String]) -> Result<Request, String> {
        const ALLOWED: [&str; 6] = [
            "--kind",
            "--machine",
            "--cwd",
            "--profile",
            "--target",
            "--ssh-config",
        ];
        let mut opts: Vec<(&str, &str)> = Vec::new();
        let mut it = args.iter();
        while let Some(flag) = it.next() {
            if !ALLOWED.contains(&flag.as_str()) {
                return Err(format!("unexpected argument {flag:?}"));
            }
            let value = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
            // Only --machine may be empty: "" is the window machine.
            if flag != "--machine" && (value.is_empty() || value.starts_with('-')) {
                return Err(format!("{flag} needs a value, not {value:?}"));
            }
            if opts.iter().any(|(f, _)| f == flag) {
                return Err(format!("{flag} is given twice"));
            }
            opts.push((flag, value));
        }
        let get = |flag: &str| {
            opts.iter()
                .find(|(f, _)| *f == flag)
                .map(|(_, v)| v.to_string())
        };
        let kind = get("--kind").ok_or("--kind is required")?;
        let machine = get("--machine").ok_or("--machine is required; \"\" is this machine")?;
        let (cwd, profile) = (get("--cwd"), get("--profile"));
        agent::check_options(&kind, cwd.as_deref(), profile.as_deref())?;
        Ok(Request {
            kind,
            machine,
            cwd,
            profile,
            target: get("--target"),
            ssh_config: get("--ssh-config").map(PathBuf::from),
        })
    }

    fn line(&self, argv: Result<Vec<String>, String>) -> Value {
        let (browser, reason, argv) = match argv {
            Ok(argv) => ("ready", String::new(), argv),
            Err(reason) => ("unavailable", reason, Vec::new()),
        };
        json!({"type": "agent-args", "kind": self.kind, "machine": self.machine, "browser": browser,
            "reason": reason, "argv": argv})
    }
}

/// Decision 7's window-side line: Chrome up, the machine's port, its agent files, then its argv. Any step's
/// failure gives an empty argv, so the agent starts as it would without Bellwether.
fn agent_args(req: &Request) -> Value {
    let chrome = chrome::up(chrome::port(), &chrome::profile_dir(), true);
    if chrome.state != "running" {
        return req.line(Err(chrome.message));
    }
    let window = agent::this_window();
    let argv = if req.machine.is_empty() {
        local_args(req, &window, chrome.port)
    } else {
        remote_args(req, &window)
    };
    req.line(argv)
}

fn local_args(req: &Request, window: &str, port: u16) -> Result<Vec<String>, String> {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    agent::ensure(&home, window, Some(port))?;
    if !agent::warmed(&home) {
        start_warm(None);
    }
    agent::agent_args(
        &home,
        &req.kind,
        window,
        req.cwd.as_deref().map(Path::new),
        req.profile.as_deref(),
    )
    .map_err(|(_, message)| message)
}

fn remote_args(req: &Request, window: &str) -> Result<Vec<String>, String> {
    let m = req.machine.as_str();
    let f = forward::ensure(m, req.target.as_deref(), req.ssh_config.as_deref());
    let port = match (f.state.as_str(), f.port) {
        ("ready", Some(port)) => port.to_string(),
        (state, _) if f.reason.is_empty() => {
            return Err(format!("the browser forward to {m} is {state}"))
        }
        _ => return Err(f.reason),
    };
    let ensure = [
        "agent",
        "ensure",
        "--window",
        window,
        "--port",
        &port,
        "--no-warm",
    ];
    let v = relay(m, &ensure)?;
    if v["type"] != "agent-files" {
        return Err(answer(m, &v));
    }
    if v["warm"] == "needed" {
        start_warm(Some(m));
    }
    let mut args = vec!["agent", "args", "--kind", &req.kind, "--window", window];
    if let Some(cwd) = &req.cwd {
        args.extend(["--cwd", cwd]);
    }
    if let Some(p) = &req.profile {
        args.extend(["--profile", p]);
    }
    let v = relay(m, &args)?;
    match v["argv"].as_array() {
        Some(argv) if v["type"] == "agent-args" => argv
            .iter()
            .map(|a| a.as_str().map(String::from))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("the helper on {m} printed an argv that is not strings")),
        _ => Err(answer(m, &v)),
    }
}

/// Fetches the MCP package into that machine's npx cache in an hc terminal of its own, which removes itself:
/// `hc exec` ends everything its program started, so a warm started inside one would not outlive it. A failed
/// start costs only the first session's wait for npx.
fn start_warm(machine: Option<&str>) {
    let name = format!("bw-warm-{}", forward::slug(machine.unwrap_or("local")));
    let name: String = name.chars().take(32).collect();
    let mut argv: Vec<String> = [
        "run",
        "--bg",
        "--json",
        "--no-parent",
        "--no-notify",
        "--rm",
    ]
    .map(String::from)
    .to_vec();
    argv.extend(["--name".into(), name]);
    match machine {
        Some(m) => argv.extend([
            "--on".into(),
            m.into(),
            "--".into(),
            "sh".into(),
            "-c".into(),
            RUN_HELPER.into(),
            "sh".into(),
        ]),
        None => {
            let Ok(bw) = std::env::current_exe() else {
                return;
            };
            // A terminal gets the core's environment; the agent files are under this process's HOME.
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
            argv.extend([
                "--cwd".into(),
                home.clone(),
                "--".into(),
                "env".into(),
                format!("HOME={home}"),
                bw.display().to_string(),
            ]);
        }
    }
    argv.extend(["agent".into(), "warm".into()]);
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let _ = hc::hc_json(&refs);
}

fn relay(machine: &str, args: &[&str]) -> Result<Value, String> {
    forward::remote_line(machine, args).map_err(|e| match e {
        Remote::Unreachable(r) | Remote::Failed(r) => r,
    })
}

/// An error line from the helper there, or a line it should not have printed.
fn answer(machine: &str, v: &Value) -> String {
    match v["message"].as_str() {
        Some(m) if v["type"] == "error" => format!("on {machine}: {m}"),
        _ => format!("the helper on {machine} answered {v}; install it again"),
    }
}

/// Decision 10: the `chrome` line, a `tab` line per page and a `forward` line per state file. It starts nothing
/// and runs no ssh and nothing on another machine, so a 2 s poll stays cheap.
fn status() -> Vec<Value> {
    let (port, profile) = (chrome::port(), chrome::profile_dir());
    let mut c = chrome::probe(port, &profile);
    let mut tabs = Vec::new();
    if c.state == "running" {
        match tabs::list(port, &crate::chat::cache::app_home(), tabs::FETCH_BUDGET) {
            Ok(t) => tabs = t,
            Err(e) => c.message = format!("cannot list the tabs: {e}"),
        }
    }
    let mut lines = vec![c.json()];
    lines.extend(tabs.iter().map(tabs::Tab::json));
    lines.extend(forward::list().iter().map(forward::Forward::line));
    lines
}
