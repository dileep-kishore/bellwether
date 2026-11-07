//! `bw send`: types a message into a terminal only while it shows the conversation the chat shows.
//!
//! Runs on the terminal's own machine, through the helper there, with the terminal's local address: `hc send`
//! from another core wraps the text as `<hc from="…">…</hc>`, so a slash command such as `/new` would never run.
//! It looks up the terminal's conversation again, without the 30 s memory, and sends nothing when the agent
//! kind, session or log path differ from what the chat read. Then `hc send --json -- <t> <text>`, never
//! `--force`, so hc refuses a terminal waiting on a prompt.
//!
//! Claude and Codex write no log until their first message, so a chat that has never shown a conversation
//! sends with `--expect-session none --expect-path none`: that passes only while the terminal's agent of the
//! expected kind is running and has no log at all.
//!
//! The guard is adapted from Flockbook's xplat/flockbook-modfeed/src/cards.rs `send` (MIT, Copyright (c) 2026
//! Min-Chen Lee).

use std::process::ExitCode;
use std::time::Duration;

use serde_json::json;

use super::args;
use super::locate::{self, LocateFailure};
use crate::hc::{self, HcError};

const USAGE: &str = "usage: bw send --terminal <t> --expect-kind <claude|codex> \
                     --expect-session <id|none> --expect-path <log|none> --text <message>";

/// The expectation of a chat that has never shown a conversation: the agent has written no log yet.
const NO_LOG: &str = "none";

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
    /// The expected kind's agent runs here and has written no log yet.
    NoLog {
        agent: String,
    },
    /// No agent conversation to compare: an agent not running, or no agent at all.
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
        LocateFailure::NoLog { agent } => NotShown::NoLog { agent },
        LocateFailure::NoProcess { agent } => {
            NotShown::Unconfirmed(format!("no {agent} process runs in it"))
        }
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

/// What the guard decided before any text is typed.
#[derive(Debug, PartialEq)]
enum Check {
    Pass,
    Refuse(String),
    Error(&'static str, String),
}

/// `expected` is the chat's session and path, or None when it has never shown a conversation.
fn check(shown: Result<Shown, NotShown>, kind: &str, expected: Option<(&str, &str)>) -> Check {
    match (shown, expected) {
        (Ok(s), Some((session, path))) => match mismatch(&s, kind, session, path) {
            Some(why) => Check::Refuse(why),
            None => Check::Pass,
        },
        (Ok(s), None) => Check::Refuse(format!("it shows session {} now", s.session)),
        (Err(NotShown::NoLog { agent }), None) if agent == kind => Check::Pass,
        (Err(NotShown::NoLog { agent }), None) => Check::Refuse(format!("it runs {agent} now")),
        (Err(NotShown::NoLog { agent }), Some(_)) => Check::Refuse(format!(
            "no {agent} session log for the conversation shown now"
        )),
        (Err(NotShown::Unconfirmed(why)), _) => Check::Refuse(why),
        (Err(NotShown::Error { code, message }), _) => Check::Error(code, message),
    }
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
    let expected = match (session == NO_LOG, path == NO_LOG) {
        (false, false) => Some((session, path)),
        (true, true) => None,
        _ => {
            return crate::usage(&format!(
                "--expect-session none and --expect-path none go together; {USAGE}"
            ))
        }
    };
    if text.is_empty() {
        return crate::usage(&format!("--text is empty; {USAGE}"));
    }

    if address.contains('/') {
        return crate::usage(&format!(
            "{address}: run bw send on the terminal's own machine with its local address; {USAGE}"
        ));
    }
    match check(shown_here(address), kind, expected) {
        Check::Pass => {}
        Check::Refuse(why) => {
            return result(
                "refused-conversation",
                &format!("{address} now shows another conversation ({why}); nothing was sent"),
            )
        }
        Check::Error(code, message) => return super::error(code, &message),
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
    fn none_passes_only_a_running_agent_without_a_log() {
        let no_log = |agent: &str| {
            Err(NotShown::NoLog {
                agent: agent.into(),
            })
        };
        assert_eq!(check(no_log("codex"), "codex", None), Check::Pass);
        assert!(matches!(
            check(no_log("claude"), "codex", None),
            Check::Refuse(_)
        ));
        // After Claude `/clear` the new session has no log yet, while the chat still shows the old one.
        assert!(matches!(
            check(no_log("claude"), "claude", Some(("a", "/l/a.jsonl"))),
            Check::Refuse(_)
        ));
        assert!(matches!(
            check(Ok(shown("codex", "b", "/l/b.jsonl")), "codex", None),
            Check::Refuse(m) if m.contains(" b ")
        ));
        assert!(matches!(
            check(
                Err(NotShown::Unconfirmed("no codex process".into())),
                "codex",
                None
            ),
            Check::Refuse(_)
        ));
        assert_eq!(
            check(
                Ok(shown("codex", "a", "/l/a.jsonl")),
                "codex",
                Some(("a", "/l/a.jsonl"))
            ),
            Check::Pass
        );
    }
}
