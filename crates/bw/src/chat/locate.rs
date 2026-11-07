//! `bw locate`: which agent runs in a terminal and which session log it writes. Only the shapes are built yet.

use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct Located {
    pub terminal: String,
    pub agent: String,
    pub session: String,
    pub path: PathBuf,
    pub pid: Option<i32>,
    pub status: Option<String>,
}

/// Nothing to read, which is not an error: each prints one `state` line and exits 0.
#[derive(Clone, Debug, PartialEq)]
pub enum LocateFailure {
    NoCore(String),
    NoTerminal(String),
    NotAgent(String),
    NoLog { agent: String },
}

impl LocateFailure {
    pub fn state_line(&self) -> Value {
        match self {
            LocateFailure::NoCore(m) => json!({"type": "state", "state": "no_core", "message": m}),
            LocateFailure::NoTerminal(m) => {
                json!({"type": "state", "state": "no_terminal", "message": m})
            }
            LocateFailure::NotAgent(m) => {
                json!({"type": "state", "state": "not_agent", "message": m})
            }
            LocateFailure::NoLog { agent } => json!({
                "type": "state",
                "state": "no_log",
                "agent": agent,
                "message": format!("no {agent} session log yet"),
            }),
        }
    }
}

pub fn locate(_terminal: &str, _now_ms: i64) -> Result<Located, LocateFailure> {
    Err(LocateFailure::NoCore("not built".into()))
}

pub fn run(_args: &[String]) -> ExitCode {
    super::not_built("locate")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_lines() {
        assert_eq!(
            LocateFailure::NoCore("no hc core is running".into()).state_line(),
            json!({"type": "state", "state": "no_core", "message": "no hc core is running"})
        );
        assert_eq!(
            LocateFailure::NoTerminal("t9 is not a live terminal".into()).state_line(),
            json!({"type": "state", "state": "no_terminal", "message": "t9 is not a live terminal"})
        );
        assert_eq!(
            LocateFailure::NotAgent("t3 runs zsh".into()).state_line(),
            json!({"type": "state", "state": "not_agent", "message": "t3 runs zsh"})
        );
        assert_eq!(
            LocateFailure::NoLog {
                agent: "codex".into()
            }
            .state_line(),
            json!({"type": "state", "state": "no_log", "agent": "codex", "message": "no codex session log yet"})
        );
    }
}
