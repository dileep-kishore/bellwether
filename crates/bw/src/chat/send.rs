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
//! expected kind is running and has named a conversation with no log yet. After `/new` or `/clear` the chat
//! names the replacement with `--expect-session <id> --expect-path none`, which passes only while that agent
//! names exactly that conversation and it still has no log.
//!
//! The guard is adapted from Flockbook's xplat/flockbook-modfeed/src/cards.rs `send` (MIT, Copyright (c) 2026
//! Min-Chen Lee).

use std::process::ExitCode;
use std::time::Duration;

use serde_json::json;

use super::args;
use super::locate::{self, LocateFailure, Located};
use crate::hc::{self, HcError};

const USAGE: &str = "usage: bw send --terminal <t> --expect-kind <claude|codex> \
                     --expect-session <id|none> --expect-path <log|none> --text <message>";

/// No conversation (`--expect-session`) or no log (`--expect-path`) known to the chat.
const NO_LOG: &str = "none";

/// `hc send` waits up to 3 s for the program to stop typing, and `exec` stops the mod's call at 30 s.
const SEND_TIMEOUT_S: u64 = 25;

/// What the terminal shows now, as `bw locate` named it.
#[derive(Debug, PartialEq)]
pub(crate) struct Shown {
    agent: String,
    session: String,
    path: String,
}

/// Why nothing reached the terminal before `hc send`.
#[derive(Debug, PartialEq)]
pub(crate) enum NotShown {
    /// The expected kind's agent runs here and has written no log yet for `session`, when it named one.
    NoLog {
        agent: String,
        session: Option<String>,
    },
    /// No agent conversation to compare: an agent not running, no agent at all, or one whose conversation
    /// bw cannot name.
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
        LocateFailure::NoLog { agent, session } => NotShown::NoLog { agent, session },
        LocateFailure::NoProcess { agent } => {
            NotShown::Unconfirmed(format!("no {agent} process runs in it"))
        }
        LocateFailure::Ambiguous { message, .. } => NotShown::Unconfirmed(message),
    }
}

pub(crate) fn shown_here(terminal: &str) -> Result<Shown, NotShown> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    shown(locate::locate_fresh(terminal, now_ms))
}

/// What lookup `found` names, in the form `check` compares; `found` must not use the 30 s memory.
pub(crate) fn shown(found: Result<Located, LocateFailure>) -> Result<Shown, NotShown> {
    let l = found.map_err(failure)?;
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

/// What the chat read: no conversation at all, a named one with no log yet, or one with its log.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Expect<'a> {
    Fresh,
    NoLog(&'a str),
    Log(&'a str, &'a str),
}

/// What the guard decided before any text is typed.
#[derive(Debug, PartialEq)]
pub(crate) enum Check {
    Pass,
    Refuse(String),
    Error(&'static str, String),
}

pub(crate) fn check(shown: Result<Shown, NotShown>, kind: &str, expected: Expect) -> Check {
    match (shown, expected) {
        (Ok(s), Expect::Log(session, path)) => match mismatch(&s, kind, session, path) {
            Some(why) => Check::Refuse(why),
            None => Check::Pass,
        },
        (Ok(s), _) => Check::Refuse(format!("it shows session {} now", s.session)),
        (Err(NotShown::NoLog { agent, .. }), _) if agent != kind => {
            Check::Refuse(format!("it runs {agent} now"))
        }
        (Err(NotShown::NoLog { .. }), Expect::Fresh) => Check::Pass,
        (Err(NotShown::NoLog { session, .. }), Expect::NoLog(want)) => match session {
            Some(s) if s == want => Check::Pass,
            Some(s) => Check::Refuse(format!("it shows session {s} now, with no log yet")),
            None => Check::Refuse(format!("it names no {kind} session to compare")),
        },
        (Err(NotShown::NoLog { agent, .. }), Expect::Log(..)) => Check::Refuse(format!(
            "no {agent} session log for the conversation shown now"
        )),
        (Err(NotShown::Unconfirmed(why)), _) => Check::Refuse(why),
        (Err(NotShown::Error { code, message }), _) => Check::Error(code, message),
    }
}

/// `--expect-session` and `--expect-path` as one of the three forms; `none` with a log path is a usage error.
pub(crate) fn expect<'a>(session: &'a str, path: &'a str) -> Result<Expect<'a>, String> {
    match (session == NO_LOG, path == NO_LOG) {
        (false, false) => Ok(Expect::Log(session, path)),
        (false, true) => Ok(Expect::NoLog(session)),
        (true, true) => Ok(Expect::Fresh),
        (true, false) => Err("--expect-session none needs --expect-path none".into()),
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
    let expected = match expect(session, path) {
        Ok(e) => e,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
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

    fn no_log(agent: &str, session: Option<&str>) -> Result<Shown, NotShown> {
        Err(NotShown::NoLog {
            agent: agent.into(),
            session: session.map(String::from),
        })
    }

    #[test]
    fn none_passes_only_a_running_agent_without_a_log() {
        for session in [None, Some("b")] {
            assert_eq!(
                check(no_log("codex", session), "codex", Expect::Fresh),
                Check::Pass
            );
            assert!(matches!(
                check(no_log("claude", session), "codex", Expect::Fresh),
                Check::Refuse(_)
            ));
        }
        // After Claude `/clear` the new session has no log yet, while the chat still shows the old one.
        assert!(matches!(
            check(
                no_log("claude", Some("b")),
                "claude",
                Expect::Log("a", "/l/a.jsonl")
            ),
            Check::Refuse(_)
        ));
        assert!(matches!(
            check(Ok(shown("codex", "b", "/l/b.jsonl")), "codex", Expect::Fresh),
            Check::Refuse(m) if m.contains(" b ")
        ));
        assert!(matches!(
            check(
                Err(NotShown::Unconfirmed("no codex process".into())),
                "codex",
                Expect::Fresh
            ),
            Check::Refuse(_)
        ));
        assert_eq!(
            check(
                Ok(shown("codex", "a", "/l/a.jsonl")),
                "codex",
                Expect::Log("a", "/l/a.jsonl")
            ),
            Check::Pass
        );
    }

    #[test]
    fn a_replacement_conversation_passes_only_by_its_own_id() {
        // After `/new` or `/clear` the chat names the session locate reported with no log yet.
        let b = Expect::NoLog("b");
        assert_eq!(check(no_log("codex", Some("b")), "codex", b), Check::Pass);
        for (shown_now, kind) in [
            (no_log("codex", Some("c")), "codex"),
            (no_log("codex", None), "codex"),
            (no_log("claude", Some("b")), "codex"),
            (Ok(shown("codex", "b", "/l/b.jsonl")), "codex"),
            (Err(NotShown::Unconfirmed("cannot tell".into())), "codex"),
        ] {
            assert!(
                matches!(check(shown_now, kind, Expect::NoLog("b")), Check::Refuse(_)),
                "{kind}"
            );
        }
    }

    #[test]
    fn none_is_refused_when_discovery_is_unsure() {
        // Review Focus 1: no candidate, several, or a claimed one says nothing about whether a log exists.
        let unsure = LocateFailure::Ambiguous {
            agent: "codex".into(),
            message: "cannot tell".into(),
        };
        assert!(matches!(failure(unsure.clone()), NotShown::Unconfirmed(_)));
        assert!(matches!(
            check(Err(failure(unsure.clone())), "codex", Expect::Fresh),
            Check::Refuse(_)
        ));
        assert!(matches!(
            check(Err(failure(unsure)), "codex", Expect::NoLog("a")),
            Check::Refuse(_)
        ));
    }
}
