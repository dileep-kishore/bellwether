//! `bw answer`: presses a request's keys only while the prompt its card showed is on screen.
//!
//! Runs on the terminal's own machine, through the helper there, with the local address, as `bw send` does, so
//! the last screen read and the key are one local step. In order: the conversation is the one the chat shows
//! (`bw send`'s guard and code, over a lookup without the 30 s memory); a fresh `bw cards` pass with its own
//! screen read still has the request, pending and answerable; one claim per occurrence; hc still names the same
//! program (`KeyGate`); a second screen read still shows the same box; the keys; then the screen read every
//! 300 ms for up to 3 s to see the box leave. A Codex async question is one message (`hc send`, never `--force`),
//! sent only while neither the pass nor a screen read just before it shows a prompt.
//!
//! Adapted from Flockbook's xplat/flockbook-modfeed/src/cards.rs `approve`, `answer` and `parse_answers`
//! (lines 150-282; MIT, Copyright (c) 2026 Min-Chen Lee): claims keyed by occurrence, the key read from the box on
//! screen at the second read, and Bellwether's states.

use std::cell::Cell;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use herdr_core::hc::mapper::{self, Term};
use herdr_core::keygate::{self, KeyGate};
use herdr_core::{
    question, BackendKind, Delivery, FileScope, HerdrError, ItemKind, PaneScreen, QuestionAnswer,
    QuestionFailure, QuestionRequest, QuestionState, Workspace,
};
use serde_json::{json, Value};

use super::cards::{self, CardsInput};
use super::claims::{Claim, Claims};
use super::matchers::{self, ScreenPrompt};
use super::screen::HcScreen;
use super::store::{self, Occurrence};
use crate::chat::send::{self, Check};
use crate::chat::{args, feed, locate, rows, tail};
use crate::hc::{self, HcError};

const USAGE: &str = "usage: bw answer --terminal <t> --request <id> --expect-kind <claude|codex> \
                     --expect-session <id|none> --expect-path <log|none> \
                     (--action approve|always|deny|option-<n> | --answers <json>)";

/// `exec` stops the mod's call at 30 s.
const DEADLINE_S: u64 = 25;
const REREAD_MS: u64 = 300;
/// Reads after the keys: 3 s at `REREAD_MS`.
const REREADS: u32 = 10;
const STALE: &str = "Changed on screen; nothing was pressed";

fn deadline_s() -> u64 {
    std::env::var("BW_ANSWER_DEADLINE_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEADLINE_S)
}

fn out(result: &str, state: Option<&str>, message: &str) -> ExitCode {
    println!(
        "{}",
        json!({"type": "answer", "result": result, "state": state, "message": message})
    );
    ExitCode::SUCCESS
}

/// What the user asked to send.
enum Asked {
    Action(String),
    Answers(Vec<QuestionAnswer>),
}

/// `[{"picks":[0]}, {"picks":[], "other":"text"}]`: one per question, option indexes from 0. A negative or
/// fractional index reads as out of range, which every answer path refuses before sending.
fn parse_answers(text: &str) -> Option<Vec<QuestionAnswer>> {
    let v: Value = serde_json::from_str(text).ok()?;
    let mut out = vec![];
    for o in v.as_array()? {
        let o = o.as_object()?;
        let picks = match o.get("picks") {
            None => vec![],
            Some(p) => p
                .as_array()?
                .iter()
                .map(|x| {
                    x.as_i64()
                        .or_else(|| x.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
                        .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
                })
                .collect::<Option<Vec<usize>>>()?,
        };
        let other = match o.get("other") {
            None | Some(Value::Null) => None,
            Some(s) => Some(s.as_str()?.to_string()),
        };
        out.push(QuestionAnswer { picks, other });
    }
    Some(out)
}

pub fn run(argv: &[String]) -> ExitCode {
    let a = match args::parse(
        argv,
        &[],
        &[
            "terminal",
            "request",
            "expect-kind",
            "expect-session",
            "expect-path",
            "action",
            "answers",
        ],
    ) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let (Some(t), Some(request), Some(kind), Some(session), Some(path)) = (
        a.get("terminal"),
        a.get("request"),
        a.get("expect-kind"),
        a.get("expect-session"),
        a.get("expect-path"),
    ) else {
        return crate::usage(USAGE);
    };
    let expected = match send::expect(session, path) {
        Ok(e) => e,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let asked = match (a.get("action"), a.get("answers")) {
        (Some(action), None) => Asked::Action(action.to_string()),
        (None, Some(text)) => match parse_answers(text) {
            Some(answers) => Asked::Answers(answers),
            None => {
                return crate::usage(&format!(
                    "--answers is not a list of {{picks, other}}; {USAGE}"
                ))
            }
        },
        _ => return crate::usage(&format!("give --action or --answers; {USAGE}")),
    };
    if t.contains('/') {
        return crate::usage(&format!(
            "{t}: run bw answer on the terminal's own machine with its local address; {USAGE}"
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(deadline_s());

    let now_ms = feed::now().timestamp_millis();
    let (record, found) = locate::locate_with_record(t, now_ms, true);
    match send::check(send::shown(found.clone()), kind, expected) {
        Check::Pass => {}
        Check::Refuse(why) => {
            return out(
                "refused-conversation",
                None,
                &format!("{t} now shows another conversation ({why}); nothing was pressed"),
            )
        }
        Check::Error(code, message) => {
            return out(
                "failed",
                None,
                &format!("{code}: {message}; nothing was pressed"),
            )
        }
    }
    let Some(record) = record else {
        return out(
            "failed",
            None,
            "hc gave no terminal record; nothing was pressed",
        );
    };
    let input = match cards::gather_with(t, Some(&record), &found, None, now_ms) {
        Ok(i) => i,
        Err(f) => return out("failed", None, &format!("{f:?}; nothing was pressed")),
    };
    let a = Answer {
        t,
        input: &input,
        record: &record,
        claims: Claims::for_terminal(t),
        blocked: input.status.as_deref() == Some("blocked"),
        deadline,
    };
    a.run(request, &asked)
}

struct Answer<'a> {
    t: &'a str,
    input: &'a CardsInput,
    record: &'a Value,
    claims: Claims,
    blocked: bool,
    deadline: Instant,
}

/// What the keys did: nothing went out, they went (or may still land), or they went and failed after.
enum Sent {
    Nothing(&'static str, String),
    Out,
    Maybe(String),
}

impl Answer<'_> {
    fn run(&self, request: &str, asked: &Asked) -> ExitCode {
        let now_ms = feed::now().timestamp_millis();
        let pass = store::update(self.t, now_ms, |s| {
            let _ = cards::build(self.input, s, now_ms);
            let o = s
                .occurrences
                .iter()
                .find(|o| o.shown.as_ref().is_some_and(|v| v["id"] == request))
                .cloned();
            let live: Vec<String> = s
                .occurrences
                .iter()
                .filter(|o| o.state == "pending" || o.state == "uncertain")
                .map(|o| o.id.clone())
                .collect();
            let on_screen = s
                .occurrences
                .iter()
                .any(|o| o.screen_id.is_some() && (o.state == "pending" || o.state == "uncertain"));
            (o, live, on_screen)
        });
        let (o, live, on_screen) = match pass {
            Ok(p) => p,
            Err(e) => return out("failed", None, &format!("{e}; nothing was pressed")),
        };
        let claimed = o.as_ref().is_some_and(|o| {
            self.claims
                .is_claimed(&o.id, self.blocked, SystemTime::now())
        });
        if matches!(self.input.screen, Some(Ok(_))) {
            self.claims.seen(&live);
        }
        let Some(o) = o else {
            return out("stale", None, STALE);
        };
        if o.state != "pending" {
            if o.by.is_some() || claimed || o.state == "uncertain" {
                return out(
                    "already-answered",
                    Some(&o.state),
                    "Bellwether already answered this request",
                );
            }
            return out("stale", Some(&o.state), STALE);
        }
        let shown = o.shown.clone().unwrap_or_default();
        if shown["answerable"] != true {
            let why = shown["reason"].as_str().unwrap_or("not answerable");
            return out(
                "not-answerable",
                Some(&o.state),
                &format!("Answer this one in the terminal ({why}); nothing was pressed"),
            );
        }
        match (o.kind.as_str(), asked) {
            ("approval" | "prompt", Asked::Action(action)) => {
                let offered = shown["actions"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|x| x["id"] == action.as_str()));
                if !offered {
                    return out(
                        "failed",
                        Some(&o.state),
                        &format!("the card offers no {action}; nothing was pressed"),
                    );
                }
                self.finish(&o, action, self.press(&o, action))
            }
            ("question_async", Asked::Answers(answers)) => {
                if self.blocked || on_screen {
                    return out(
                        "refused-prompt",
                        Some(&o.state),
                        "the agent waits on a prompt; answer it first, nothing was sent",
                    );
                }
                self.finish(&o, "answers", self.message(&o, answers))
            }
            ("question", Asked::Answers(answers)) => {
                self.finish(&o, "answers", self.pick(&o, answers))
            }
            (kind, _) => out(
                "failed",
                Some(&o.state),
                &format!("a {kind} request takes the other option; nothing was pressed"),
            ),
        }
    }

    fn pane(&self) -> String {
        mapper::pane_id(self.t)
    }

    fn screen(&self) -> HcScreen {
        HcScreen::new(self.t, self.remaining())
    }

    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// The program hc names in the terminal at the first lookup; the key gate binds to it.
    fn gate(&self) -> Option<KeyGate> {
        let seen = Term::parse(self.record)
            .map(|t| mapper::pane(&t))
            .and_then(|p| p.agent)
            .filter(KeyGate::has_identity)?;
        let deadline = self.deadline;
        Some(KeyGate::new(
            Some(seen),
            Some(Arc::new(move || Instant::now() < deadline)),
        ))
    }

    /// Claims the occurrence and checks hc still names the same program; Err is the line to print.
    fn claim_and_gate(&self, o: &Occurrence) -> Result<KeyGate, (&'static str, String)> {
        match self.claims.claim(&o.id, self.blocked, SystemTime::now()) {
            Claim::Got => {}
            Claim::Taken => {
                return Err((
                    "already-answered",
                    "Bellwether already answered this request".into(),
                ))
            }
            Claim::Busy => {
                return Err((
                    "busy",
                    "another answer to this request is being sent; nothing was pressed".into(),
                ))
            }
        }
        let refused = || {
            self.claims.release(&o.id);
            (
                "refused-agent",
                format!("{} runs another program now; nothing was pressed", self.t),
            )
        };
        let gate = self.gate().ok_or_else(refused)?;
        let seen = gate.agent.clone().ok_or_else(refused)?;
        keygate::fresh_agent(&self.screen(), &seen, &self.pane()).ok_or_else(refused)?;
        Ok(gate)
    }

    /// The box this occurrence is, on `text`: the same matcher and the same screen id the card read.
    fn same_box(&self, o: &Occurrence, text: &str) -> Option<ScreenPrompt> {
        let agent = self.input.agent.as_str();
        let p = match o.kind.as_str() {
            "prompt" => matchers::folder_prompt_on_screen(agent, text),
            _ => matchers::approval_on_screen(agent, text),
        }?;
        (Some(&p.screen_id) == o.screen_id.as_ref()).then_some(p)
    }

    /// An approval or the folder prompt: the action's keys from the box at the second read, then the re-read.
    fn press(&self, o: &Occurrence, action: &str) -> Sent {
        if let Err((result, message)) = self.claim_and_gate(o) {
            return Sent::Nothing(result, message);
        }
        let release = |result: &'static str, message: String| {
            self.claims.release(&o.id);
            Sent::Nothing(result, message)
        };
        let text = match hc::hc_read(self.t) {
            Ok(text) => text,
            Err(e) => {
                return release(
                    "failed",
                    format!("cannot read the screen ({e}); nothing was pressed"),
                )
            }
        };
        let Some(p) = self.same_box(o, &text) else {
            return release("stale", STALE.into());
        };
        let Some(keys) = p
            .actions
            .iter()
            .find(|a| a.id == action)
            .map(|a| a.keys.clone())
        else {
            return release("stale", STALE.into());
        };
        let wait = self.remaining();
        if wait.is_zero() {
            return release(
                "failed",
                "out of time before the key; nothing was pressed".into(),
            );
        }
        match hc::hc_keys(self.t, &keys, wait) {
            Ok(_) => {}
            Err(HcError::TimedOut) => {
                return Sent::Maybe(format!(
                    "hc keys did not answer in {} s; the key may still arrive",
                    wait.as_secs()
                ))
            }
            Err(e) => return release("failed", format!("hc keys: {e}; nothing was pressed")),
        }
        self.record(o, action, None);
        if self.left(o) {
            Sent::Out
        } else {
            Sent::Maybe("the prompt is still on screen; check the terminal".into())
        }
    }

    /// Whether the box left within 3 s of the keys: gone, or another box once its call has a result.
    fn left(&self, o: &Occurrence) -> bool {
        let pause = std::env::var("BW_NO_PAUSE").is_ok_and(|v| v == "1");
        for i in 0..REREADS {
            if i > 0 {
                if Instant::now() >= self.deadline {
                    return false;
                }
                if !pause {
                    std::thread::sleep(Duration::from_millis(REREAD_MS));
                }
            }
            let Ok(text) = hc::hc_read(self.t) else {
                continue;
            };
            if self.same_box(o, &text).is_some() {
                continue;
            }
            let agent = self.input.agent.as_str();
            let other = matchers::approval_on_screen(agent, &text).is_some()
                || matchers::folder_prompt_on_screen(agent, &text).is_some()
                || matchers::other_prompt(agent, &text);
            if !other
                || o.tool_use_id
                    .as_deref()
                    .is_some_and(|id| self.has_result(o, id))
            {
                return true;
            }
        }
        false
    }

    /// Whether call `id` has a result in the root's log or the asking sub-agent's, read again now.
    fn has_result(&self, o: &Occurrence, id: &str) -> bool {
        let mut logs: Vec<(PathBuf, FileScope)> = Vec::new();
        if let Some(p) = &self.input.path {
            logs.push((p.clone(), FileScope::Root));
        }
        if let Some(c) = o.child.as_deref().and_then(|c| self.input.tree.child(c)) {
            logs.push((c.path.clone(), c.scope));
        }
        logs.iter().any(|(path, scope)| {
            tail::read(path, None, tail::BYTES)
                .map(|r| tail::items(&r.lines, *scope))
                .unwrap_or_default()
                .iter()
                .any(|it| match &it.kind {
                    ItemKind::ToolChips(chips) => chips
                        .iter()
                        .flat_map(|c| c.calls.iter())
                        .any(|c| c.id == id && c.output.is_some()),
                    _ => false,
                })
        })
    }

    /// The question in the logs this occurrence names, still pending and delivered as `delivery`.
    fn logged_question(&self, o: &Occurrence, delivery: Delivery) -> Option<QuestionRequest> {
        let id = o.tool_use_id.as_deref()?;
        self.input.logs.iter().find_map(|(_, items)| {
            items.iter().rev().find_map(|it| match &it.kind {
                ItemKind::Question(q)
                    if q.tool_use_id == id
                        && q.delivery == delivery
                        && q.state == QuestionState::Pending =>
                {
                    Some(q.clone())
                }
                _ => None,
            })
        })
    }

    /// A Codex async question: one user message with `message_text`'s text.
    fn message(&self, o: &Occurrence, answers: &[QuestionAnswer]) -> Sent {
        let Some(q) = self.logged_question(o, Delivery::Message) else {
            return Sent::Nothing("stale", STALE.into());
        };
        if let Some(why) = refusal(&q, answers) {
            return Sent::Nothing("failed", format!("{why}; nothing was sent"));
        }
        let gate = match self.claim_and_gate(o) {
            Ok(g) => g,
            Err((result, message)) => return Sent::Nothing(result, message),
        };
        let screen = Counted::new(self.screen());
        // hc says idle while Codex's `/new` folder prompt shows, so only a read shows where the text would land.
        let refused = match screen.visible_text(&self.pane()) {
            Ok(text) if self.prompt_on(&text) => Some((
                "refused-prompt",
                "the agent waits on a prompt; answer it first".to_string(),
            )),
            Ok(_) => None,
            Err(e) => Some(("failed", format!("cannot read the screen ({e:?})"))),
        };
        if let Some((result, why)) = refused {
            self.claims.release(&o.id);
            return Sent::Nothing(result, format!("{why}; nothing was sent"));
        }
        match question::answer_question(&screen, &self.pane(), &q, answers, Some(&gate)) {
            Ok(()) => Sent::Out,
            Err(HerdrError::Server { code, message }) if code == "blocked" => {
                self.claims.release(&o.id);
                Sent::Nothing("refused-prompt", format!("{message}; nothing was sent"))
            }
            Err(e) => self.after_error(o, &screen, e),
        }
    }

    /// Whether `text` shows a prompt a message would land in, by the matchers `bw cards` uses.
    fn prompt_on(&self, text: &str) -> bool {
        let agent = self.input.agent.as_str();
        matchers::approval_on_screen(agent, text).is_some()
            || matchers::folder_prompt_on_screen(agent, text).is_some()
            || question::claude_screen(text).is_some()
            || question::codex_screen(text).is_some()
            || matchers::other_prompt(agent, text)
    }

    /// A question picker: the keys `question::answer_question` gives, each behind the key gate.
    fn pick(&self, o: &Occurrence, answers: &[QuestionAnswer]) -> Sent {
        let gate = match self.claim_and_gate(o) {
            Ok(g) => g,
            Err((result, message)) => return Sent::Nothing(result, message),
        };
        let screen = Counted::new(self.screen());
        let pane = self.pane();
        let q = if self.input.agent == "codex" {
            self.logged_question(o, Delivery::Picker)
        } else {
            screen
                .visible_text(&pane)
                .ok()
                .as_deref()
                .and_then(cards::claude_picker)
                .map(|(q, _)| q)
                .filter(|q| Some(&q.tool_use_id) == o.screen_id.as_ref())
        };
        // The keys answer only the question the card showed: same text, options and order.
        let q = q.filter(|q| {
            o.shown
                .as_ref()
                .is_some_and(|s| s["question"]["questions"] == json!(rows::question(q).questions))
        });
        // A picker with questions not shown is answered in the terminal: no key reads them here.
        let Some(q) = q.filter(|q| q.unread() == 0) else {
            self.claims.release(&o.id);
            return Sent::Nothing("stale", STALE.into());
        };
        let r = match refusal(&q, answers) {
            Some(why) => Err(HerdrError::Question(QuestionFailure::Unsupported(why))),
            None => question::answer_question(&screen, &pane, &q, answers, Some(&gate)),
        };
        match r {
            Ok(()) => Sent::Out,
            Err(e) => self.after_error(o, &screen, e),
        }
    }

    /// An answer that stopped: nothing went out (the claim goes back), or some keys did (uncertain).
    fn after_error(&self, o: &Occurrence, screen: &Counted, e: HerdrError) -> Sent {
        if screen.sent.get() > 0 {
            return Sent::Maybe(match e {
                HerdrError::Timeout(_) => {
                    "hc did not answer in time; the keys may still arrive".into()
                }
                other => format!("{other:?} after some keys; check the terminal"),
            });
        }
        self.claims.release(&o.id);
        match e {
            HerdrError::Question(QuestionFailure::NotOnScreen) => {
                Sent::Nothing("stale", STALE.into())
            }
            HerdrError::KeyGateStop => Sent::Nothing(
                "refused-agent",
                format!("{} runs another program now; nothing was pressed", self.t),
            ),
            other => Sent::Nothing("failed", format!("{other:?}; nothing was pressed")),
        }
    }

    /// Records what went out (`by`), and the state when one is known.
    fn record(&self, o: &Occurrence, by: &str, state: Option<&str>) {
        let now_ms = feed::now().timestamp_millis();
        let _ = store::update(self.t, now_ms, |s| {
            if let Some(found) = s.occurrences.iter_mut().find(|x| x.id == o.id) {
                found.by = Some(by.to_string());
                if let Some(state) = state {
                    found.state = state.to_string();
                    found.resolved_ms = (state != "uncertain").then_some(now_ms);
                }
            }
        });
    }

    fn finish(&self, o: &Occurrence, by: &str, sent: Sent) -> ExitCode {
        match sent {
            Sent::Nothing(result, message) => out(result, Some(&o.state), &message),
            Sent::Out => {
                let state = if by == "deny" { "declined" } else { "answered" };
                self.record(o, by, Some(state));
                out(state, Some(state), "answered from the chat")
            }
            Sent::Maybe(message) => {
                self.claims.hold(&o.id);
                self.record(o, by, Some("uncertain"));
                out("uncertain", Some("uncertain"), &message)
            }
        }
    }
}

/// Why `answers` cannot answer `q`, before anything is sent; None when they can.
fn refusal(q: &QuestionRequest, answers: &[QuestionAnswer]) -> Option<String> {
    if answers.len() != q.questions.len() {
        return Some(format!(
            "{} answers for {} questions",
            answers.len(),
            q.questions.len()
        ));
    }
    for (k, (x, a)) in q.questions.iter().zip(answers).enumerate() {
        if a.picks.iter().any(|&p| p >= x.options.len()) {
            return Some(format!("question {}: option out of range", k + 1));
        }
        if a.picks.is_empty() && question::other_text(a).is_none() {
            return Some(format!("question {}: no answer", k + 1));
        }
    }
    None
}

/// `HcScreen` counting the calls that send input, so a stop after some keys reads as uncertain, not as nothing.
struct Counted {
    inner: HcScreen,
    sent: Cell<usize>,
}

impl Counted {
    fn new(inner: HcScreen) -> Counted {
        Counted {
            inner,
            sent: Cell::new(0),
        }
    }
}

impl PaneScreen for Counted {
    fn backend(&self) -> BackendKind {
        self.inner.backend()
    }

    fn snapshot(&self) -> Result<Vec<Workspace>, HerdrError> {
        self.inner.snapshot()
    }

    fn visible_text(&self, pane_id: &str) -> Result<String, HerdrError> {
        self.inner.visible_text(pane_id)
    }

    fn respond(&self, pane_id: &str, allow: bool) -> Result<(), HerdrError> {
        self.inner.respond(pane_id, allow)
    }

    fn send_named_keys(&self, keys: &[String], pane_id: &str) -> Result<(), HerdrError> {
        self.sent.set(self.sent.get() + 1);
        self.inner.send_named_keys(keys, pane_id)
    }

    fn send_keys(&self, bytes: &[u8], pane_id: &str) -> Result<(), HerdrError> {
        self.sent.set(self.sent.get() + 1);
        self.inner.send_keys(bytes, pane_id)
    }

    fn send_text(&self, text: &str, pane_id: &str) -> Result<(), HerdrError> {
        self.sent.set(self.sent.get() + 1);
        self.inner.send_text(text, pane_id)
    }

    fn pause(&self, ms: u64) {
        self.inner.pause(ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_parse_as_picks_and_text() {
        let a =
            parse_answers(r#"[{"picks":[1]},{"picks":[],"other":"x"},{"other":null}]"#).unwrap();
        assert_eq!(a[0].picks, vec![1]);
        assert_eq!(a[1].other.as_deref(), Some("x"));
        assert!(a[2].picks.is_empty() && a[2].other.is_none());
        assert_eq!(
            parse_answers(r#"[{"picks":[-1]}]"#).unwrap()[0].picks,
            vec![usize::MAX]
        );
        assert_eq!(
            parse_answers(r#"[{"picks":[2.0]}]"#).unwrap()[0].picks,
            vec![2]
        );
        for bad in [
            r#"{"picks":[1]}"#,
            r#"[{"picks":[1.5]}]"#,
            r#"[{"picks":"1"}]"#,
            r#"[{"other":3}]"#,
            "x",
        ] {
            assert!(parse_answers(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn answers_that_cannot_answer_are_refused_before_sending() {
        let q = question::new_request(
            "call_1",
            "codex",
            Delivery::Message,
            vec![question::new_question(
                None,
                "size",
                "Which size?",
                vec![
                    question::option("small", "", false),
                    question::option("large", "", false),
                ],
                false,
            )],
        );
        let a = |picks: Vec<usize>, other: Option<&str>| QuestionAnswer {
            picks,
            other: other.map(String::from),
        };
        assert_eq!(refusal(&q, &[a(vec![1], None)]), None);
        assert_eq!(refusal(&q, &[a(vec![], Some("medium"))]), None);
        assert!(refusal(&q, &[a(vec![2], None)]).is_some());
        assert!(refusal(&q, &[a(vec![], Some("  "))]).is_some());
        assert!(refusal(&q, &[]).is_some());
    }
}
