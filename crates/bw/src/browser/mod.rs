//! `bw browser …`: the Bellwether Chrome, its tabs and window, and the forwards that reach it.

use std::process::ExitCode;

pub mod arrange;
// Wave B's commands are the first callers of the HTTP and CDP clients.
#[allow(dead_code)]
pub mod cdp;
pub mod chrome;
pub mod forward;
#[allow(dead_code)]
pub mod http;
pub mod launch;
pub mod listen;
mod lock;
pub mod tabs;

const USAGE: &str = "usage: bw browser up|down|tabs|focus|close|new|arrange|free-port|port-check\
    |forward|agent-args|status <options>";

pub fn run(args: &[String]) -> ExitCode {
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some(cmd @ ("up" | "down")) => chrome::run(cmd, rest),
        Some(cmd @ ("tabs" | "focus" | "close" | "new")) => tabs::run(cmd, rest),
        Some("arrange") => arrange::run(rest),
        Some(cmd @ ("free-port" | "port-check" | "forward")) => forward::run(cmd, rest),
        Some(cmd @ ("agent-args" | "status")) => launch::run(cmd, rest),
        Some(other) => crate::usage(&format!("unknown browser command {other:?}; {USAGE}")),
        None => crate::usage(USAGE),
    }
}
