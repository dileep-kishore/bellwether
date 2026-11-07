//! `bw send`: types a message into a terminal only while it shows the conversation the chat shows.
//!
//! Runs on the window machine. It looks up the terminal's conversation again (in process here; through the
//! helper on the terminal's machine otherwise), without the 30 s memory, and sends nothing when the agent kind,
//! session or log path differ from what the chat read. Then `hc send --json -- <address> <text>`, never `--force`,
//! so hc refuses a terminal waiting on a prompt.
//!
//! The guard is adapted from Flockbook's xplat/flockbook-modfeed/src/cards.rs `send` (MIT, Copyright (c) 2026
//! Min-Chen Lee).

use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Value};

use super::args;
use super::locate::{self, LocateFailure};
use crate::hc::{self, HcError};
use crate::machine::RUN_HELPER;

const USAGE: &str = "usage: bw send --terminal <[machine/]t> --expect-kind <claude|codex> \
                     --expect-session <id> --expect-path <log> --text <message>";

/// `hc send` waits up to 3 s for the program to stop typing, and `exec` stops the mod's call at 30 s.
const SEND_TIMEOUT_S: u64 = 25;

/// What the terminal shows now, as `bw locate` named it.
#[derive(Debug, PartialEq)]
struct Shown {
    agent: String,
    session: String,
    path: String,
}

/// Why nothing reached the terminal before `hc send`.
#[derive(Debug, PartialEq)]
enum NotShown {
    /// No agent conversation to compare: a new one with no log yet, or no agent at all.
    Unconfirmed(String),
    Error {
        code: &'static str,
        message: String,
    },
}

fn failure(f: LocateFailure) -> NotShown {
    match f {
        LocateFailure::NoCore(m) => NotShown::Error {
            code: "unreachable",
            message: m,
        },
        LocateFailure::NoTerminal(m) => NotShown::Error {
            code: "no_terminal",
            message: m,
        },
        LocateFailure::NotAgent(m) => NotShown::Unconfirmed(m),
        LocateFailure::NoLog { agent } => NotShown::Unconfirmed(format!(
            "no {agent} session log for the conversation shown now"
        )),
    }
}

fn shown_here(terminal: &str) -> Result<Shown, NotShown> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let l = locate::locate_fresh(terminal, now_ms).map_err(failure)?;
    Ok(Shown {
        agent: l.agent,
        session: l.session,
        path: l.path.to_string_lossy().to_string(),
    })
}

/// One line of `bw locate --terminal <t> --fresh` from the helper on `machine`.
fn shown_line(machine: &str, line: &Value) -> Result<Shown, NotShown> {
    let text = |k: &str| line[k].as_str().unwrap_or("").to_string();
    match line["type"].as_str() {
        Some("located") => Ok(Shown {
            agent: text("agent"),
            session: text("session"),
            path: text("path"),
        }),
        Some("state") => Err(match line["state"].as_str() {
            Some("no_core") => NotShown::Error {
                code: "unreachable",
                message: format!("Herdr's core on {machine}: {}", text("message")),
            },
            Some("no_terminal") => NotShown::Error {
                code: "no_terminal",
                message: text("message"),
            },
            _ => NotShown::Unconfirmed(text("message")),
        }),
        // An older helper there does not know `--fresh`: send nothing rather than trust a remembered root.
        _ => Err(NotShown::Error {
            code: "failed",
            message: format!("bw on {machine}: {}", text("message")),
        }),
    }
}

fn shown_there(machine: &str, terminal: &str) -> Result<Shown, NotShown> {
    let argv = [
        "sh",
        "-c",
        RUN_HELPER,
        "bw",
        "locate",
        "--terminal",
        terminal,
        "--fresh",
    ];
    let out = hc::hc_exec(machine, &argv).map_err(|e| NotShown::Error {
        code: "unreachable",
        message: e.to_string(),
    })?;
    if matches!(out.code, Some(126 | 127)) {
        return Err(NotShown::Error {
            code: "missing",
            message: format!("Bellwether's helper is not installed on {machine}"),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .ok_or_else(|| NotShown::Error {
            code: "failed",
            message: format!("bw locate on {machine} printed no line"),
        })?;
    shown_line(machine, &line)
}

/// The difference between what the chat read and what the terminal shows, if any.
fn mismatch(shown: &Shown, kind: &str, session: &str, path: &str) -> Option<String> {
    if shown.agent != kind {
        return Some(format!("it runs {} now", shown.agent));
    }
    if shown.session != session || shown.path != path {
        return Some(format!("it shows session {} now", shown.session));
    }
    None
}

fn result(result: &str, message: &str) -> ExitCode {
    println!(
        "{}",
        json!({"type": "send", "result": result, "message": message})
    );
    ExitCode::SUCCESS
}

fn timeout() -> Duration {
    let s = std::env::var("BW_SEND_TIMEOUT_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(SEND_TIMEOUT_S);
    Duration::from_secs(s)
}

pub fn run(argv: &[String]) -> ExitCode {
    let a = match args::parse(
        argv,
        &[],
        &[
            "terminal",
            "expect-kind",
            "expect-session",
            "expect-path",
            "text",
        ],
    ) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let (Some(address), Some(kind), Some(session), Some(path), Some(text)) = (
        a.get("terminal"),
        a.get("expect-kind"),
        a.get("expect-session"),
        a.get("expect-path"),
        a.get("text"),
    ) else {
        return crate::usage(USAGE);
    };
    if text.is_empty() {
        return crate::usage(&format!("--text is empty; {USAGE}"));
    }

    let shown = match address.split_once('/') {
        Some((machine, t)) => shown_there(machine, t),
        None => shown_here(address),
    };
    let refused = |why: &str| {
        result(
            "refused-conversation",
            &format!("{address} now shows another conversation ({why}); nothing was sent"),
        )
    };
    match shown {
        Ok(s) => {
            if let Some(why) = mismatch(&s, kind, session, path) {
                return refused(&why);
            }
        }
        Err(NotShown::Unconfirmed(why)) => return refused(&why),
        Err(NotShown::Error { code, message }) => return super::error(code, &message),
    }

    let wait = timeout();
    match hc::hc_send(address, text, wait) {
        Ok(_) => result("sent", &format!("sent to {address}")),
        Err(HcError::TimedOut) => result(
            "unconfirmed",
            &format!(
                "hc send did not answer in {} s; the text may still arrive",
                wait.as_secs()
            ),
        ),
        Err(HcError::Refused { kind, message }) => match kind.as_str() {
            "blocked" => result("refused-prompt", &message),
            "not_found" | "finished" => super::error("no_terminal", &message),
            _ => super::error("failed", &format!("{kind}: {message}")),
        },
        Err(HcError::Unreachable(m)) => super::error("unreachable", &m),
        Err(e @ (HcError::NoProgram(_) | HcError::Failed(_))) => {
            super::error("failed", &e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(agent: &str, session: &str, path: &str) -> Shown {
        Shown {
            agent: agent.into(),
            session: session.into(),
            path: path.into(),
        }
    }

    #[test]
    fn mismatch_names_what_changed() {
        let s = shown("codex", "a", "/l/a.jsonl");
        assert_eq!(mismatch(&s, "codex", "a", "/l/a.jsonl"), None);
        assert_eq!(
            mismatch(&s, "claude", "a", "/l/a.jsonl").as_deref(),
            Some("it runs codex now")
        );
        assert!(mismatch(&s, "codex", "b", "/l/a.jsonl").is_some());
        assert!(mismatch(&s, "codex", "a", "/l/b.jsonl").is_some());
    }

    #[test]
    fn remote_lines() {
        let l = json!({"type": "located", "agent": "codex", "session": "a", "path": "/l/a.jsonl"});
        assert_eq!(shown_line("m", &l), Ok(shown("codex", "a", "/l/a.jsonl")));
        let gone = json!({"type": "state", "state": "no_terminal", "message": "t1 is finished"});
        assert!(matches!(
            shown_line("m", &gone),
            Err(NotShown::Error {
                code: "no_terminal",
                ..
            })
        ));
        let new = json!({"type": "state", "state": "no_log", "agent": "codex", "message": "x"});
        assert!(matches!(
            shown_line("m", &new),
            Err(NotShown::Unconfirmed(_))
        ));
        assert!(matches!(
            shown_line(
                "m",
                &json!({"type": "error", "code": "usage", "message": "x"})
            ),
            Err(NotShown::Error { code: "failed", .. })
        ));
    }
}
