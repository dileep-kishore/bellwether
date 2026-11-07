//! Who listens on a TCP port, from `lsof` (macOS) or `ss` (Linux), and whether only loopback does.
//!
//! Only std, so `crates/bw/tests/chrome.rs` compiles this file as a module of its own.

use std::io::ErrorKind;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    /// 0 when the tool could not name the owner (`ss` without root hides other users' processes).
    pub pid: i32,
    pub command: String,
    /// As the tool prints it: `127.0.0.1:9222`, `[::1]:9222`, `*:9222`.
    pub addr: String,
}

/// `lsof -Fpcn` text: a `p` and `c` line per process, then an `f` and `n` line per socket.
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut out = Vec::new();
    let mut pid = 0;
    let mut command = String::new();
    for line in text.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = value.parse().unwrap_or(0);
                command.clear();
            }
            'c' => command = value.to_string(),
            'n' => out.push(Listener {
                pid,
                command: command.clone(),
                addr: value.to_string(),
            }),
            _ => {}
        }
    }
    out
}

/// `ss -Hltnp` text; one listener per owning process, or one with pid 0 when the owner is hidden.
pub fn parse_ss(text: &str) -> Vec<Listener> {
    let mut out = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // The State column is absent in some ss builds; the local address follows the two queue counts.
        let local = if fields.first().is_some_and(|f| f.parse::<u64>().is_ok()) {
            2
        } else {
            3
        };
        let Some(addr) = fields.get(local) else {
            continue;
        };
        let owners = fields
            .iter()
            .find_map(|f| f.strip_prefix("users:"))
            .map(ss_users)
            .unwrap_or_default();
        if owners.is_empty() {
            out.push(Listener {
                pid: 0,
                command: String::new(),
                addr: addr.to_string(),
            });
        }
        for (pid, command) in owners {
            out.push(Listener {
                pid,
                command,
                addr: addr.to_string(),
            });
        }
    }
    out
}

/// `(("name",pid=1,fd=3),("other",pid=2,fd=3))` as (pid, name) pairs.
fn ss_users(text: &str) -> Vec<(i32, String)> {
    let mut out = Vec::new();
    for entry in text.split("),(") {
        let entry = entry.trim_matches(|c| c == '(' || c == ')');
        let mut parts = entry.split(',');
        let name = parts.next().unwrap_or("").trim_matches('"').to_string();
        let pid = parts
            .find_map(|p| p.strip_prefix("pid="))
            .and_then(|p| p.parse().ok());
        if let Some(pid) = pid {
            out.push((pid, name));
        }
    }
    out
}

/// The port's listeners; lsof first, ss when lsof is not installed.
pub fn listeners(port: u16) -> Result<Vec<Listener>, String> {
    match Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpcn"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        // lsof exits 1 both when nothing listens and on its own errors, so only its output counts.
        Ok(out) => return Ok(parse_lsof(&String::from_utf8_lossy(&out.stdout))),
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(format!("lsof: {e}")),
        Err(_) => {}
    }
    match Command::new("ss")
        .args(["-Hltnp", &format!("sport = :{port}")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(out) if out.status.success() => Ok(parse_ss(&String::from_utf8_lossy(&out.stdout))),
        Ok(out) => Err(format!("ss exited {}", out.status)),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err("neither lsof nor ss is available".to_string())
        }
        Err(e) => Err(format!("ss: {e}")),
    }
}

/// Ok when every listener is on `127.0.0.1:<port>` or `[::1]:<port>`; an empty list is an error.
pub fn loopback_only(ls: &[Listener], port: u16) -> Result<(), String> {
    if ls.is_empty() {
        return Err(format!("nothing listens on {port}"));
    }
    let v4 = format!("127.0.0.1:{port}");
    let v6 = format!("[::1]:{port}");
    match ls.iter().find(|l| l.addr != v4 && l.addr != v6) {
        None => Ok(()),
        Some(l) => Err(format!(
            "{} listens on {}, beyond loopback",
            owner(l),
            l.addr
        )),
    }
}

/// `bun (pid 74563)`, or `a program bw cannot name` when the tool hid the owner.
pub fn owner(l: &Listener) -> String {
    match (l.pid, l.command.is_empty()) {
        (0, _) => "a program bw cannot name".to_string(),
        (pid, true) => format!("pid {pid}"),
        (pid, false) => format!("{} (pid {pid})", l.command),
    }
}
