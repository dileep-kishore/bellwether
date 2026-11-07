//! `bw send`: types a message into a terminal only while it shows the conversation the chat shows.
//!
//! Runs on the terminal's own machine, through the helper there, with the terminal's local address: `hc send`
//! from another core wraps the text as `<hc from="…">…</hc>`, so a slash command such as `/new` would never run.
//! It looks up the terminal's conversation again, without the 30 s memory, and sends nothing when the agent
//! kind, session or log path differ from what the chat read. Then `hc send --json -- <t> <text>`, never
//! `--force`, so hc refuses a terminal waiting on a prompt.
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

    if address.contains('/') {
        return crate::usage(&format!(
            "{address}: run bw send on the terminal's own machine with its local address; {USAGE}"
        ));
    }
    let shown = shown_here(address);
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
}
