//! `bw cards`: the approvals and questions a session and its sub-agents wait on.
//!
//! The screen comes first, as in Flockbook's `look` (xplat/flockbook-modfeed/src/cards.rs:108-146, MIT, Copyright
//! (c) 2026 Min-Chen Lee), adapted: a request is the prompt box on screen, read only while hc says `blocked` (and,
//! for Codex's `/new` folder prompt, which hc shows as `idle`, whenever Codex is not working). The logs and hook
//! events only say who asks and which call it is; they never make a box that is not on screen. Async questions
//! come from the logs, since nothing shows them on screen.
//!
//! Each box seen is an occurrence in the terminal's store. A box seen at two reads in a row is the same
//! occurrence; once a read shows it gone, the same box again is a new one. When it leaves, its state says who
//! answered: Bellwether (`by`), the terminal (the call has a result), or nobody yet (`stale`). Until the call's
//! result is logged, or for at most 5 s, it is `settling`, which no pass offers for answering.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use herdr_core::approval::hash_id;
use herdr_core::hc::mapper::Term;
use herdr_core::{
    question, ConversationItem, Delivery, FileScope, ItemKind, PaneScreen, PermState,
    PermissionRequest, QuestionRequest, QuestionState,
};
use serde_json::{json, Value};

use super::matchers::{self, ScreenPrompt, CODEX_CHILD_ANSWERABLE};
use super::screen::HcScreen;
use super::store::{self, Occurrence, Store};
use crate::chat::locate::{self, LocateFailure, Located};
use crate::chat::protocol::JsonLines;
use crate::chat::tree::{self, Tree};
use crate::chat::{args, feed, rows, tail};
use crate::events::{self, Event};

/// A resolved request is listed this long after it resolved.
pub const RESOLVED_SHOW_MS: i64 = 10_000;
/// At most this many sub-agents' logs are read per pass, running ones first.
const MAX_CHILD_LOGS: usize = 16;
/// A sub-agent that ended this recently still has its log read, so a prompt it answered just before ending
/// resolves by its call's result.
const RECENT_CHILD_MS: i64 = 60_000;
/// A `PermissionRequest` takes its `tool_use_id` from the `PreToolUse` of the same call, at most this much earlier.
const PAIR_MS: i64 = 1000;
/// `bw hooks check` is run again after this long.
const HOOKS_CHECK_MS: i64 = 60_000;
/// One `hc read` may take this long.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Event files older than this are not read; `bw event` prunes them at the same age.
const EVENTS_MS: i64 = 24 * 60 * 60 * 1000;

pub struct CardsInput {
    pub terminal: String,
    pub agent: String,
    /// The root session, or `none` while the lookup names none.
    pub root: String,
    /// None while the root has no log.
    pub path: Option<PathBuf>,
    /// The root lookup names no single conversation: every request is shown, none answerable.
    pub ambiguous: bool,
    pub status: Option<String>,
    pub status_kind: Option<String>,
    /// None: not read; Err: the read failed.
    pub screen: Option<Result<String, String>>,
    pub tree: Tree,
    pub events: Vec<Event>,
    /// The root's items (child None) and each read sub-agent's.
    pub logs: Vec<(Option<String>, Vec<ConversationItem>)>,
    /// `bw hooks check`'s word for this agent: `ok`, `missing`, `untrusted`, `outdated`.
    pub hooks: String,
}

const USAGE: &str = "usage: bw cards --terminal <t>";

pub fn run(argv: &[String]) -> ExitCode {
    let a = match args::parse(argv, &[], &["terminal"]) {
        Ok(a) => a,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let Some(t) = a.get("terminal") else {
        return crate::usage(USAGE);
    };
    let now_ms = feed::now().timestamp_millis();
    let (record, found) = locate::locate_with_record(t, now_ms, false);
    let mut out = JsonLines::new();
    if let Err(f) = &found {
        out.emit_value(f.state_line());
    }
    emit(t, record.as_ref(), &found, None, now_ms, &mut out);
    print!("{}", out.text());
    ExitCode::SUCCESS
}

/// The `cards` and `request` lines for the lookup `found`, after its own lines; nothing for a terminal that runs
/// no agent. Keeps the store.
pub fn emit(
    terminal: &str,
    record: Option<&Value>,
    found: &Result<Located, LocateFailure>,
    tree: Option<Tree>,
    now_ms: i64,
    out: &mut JsonLines,
) {
    let Ok(input) = gather_with(terminal, record, found, tree, now_ms) else {
        return;
    };
    // A store that cannot be locked costs the next pass its occurrences: a box still there gets a new id.
    let (cards, requests) = store::update(terminal, now_ms, |kept| build(&input, kept, now_ms))
        .unwrap_or_else(|_| build(&input, &mut store::load(terminal), now_ms));
    out.emit_value(cards);
    for r in requests {
        out.emit_value(r);
    }
}

/// What one pass reads for terminal `t` after the lookup `found` (one `hc get`): the screen while it may show a
/// prompt, the logs, the tree and the events. After a `no_log` or `ambiguous` lookup the input holds the screen
/// only. `bw answer` passes a lookup made without the 30 s memory, which its guard checked first.
pub fn gather_with(
    terminal: &str,
    record: Option<&Value>,
    found: &Result<Located, LocateFailure>,
    tree: Option<Tree>,
    now_ms: i64,
) -> Result<CardsInput, LocateFailure> {
    let (agent, root, located) = match found {
        Ok(l) => (l.agent.clone(), l.session.clone(), Some(l)),
        Err(LocateFailure::NoLog { agent, session }) => (
            agent.clone(),
            session.clone().unwrap_or_else(|| "none".into()),
            None,
        ),
        Err(LocateFailure::NoProcess { agent } | LocateFailure::Ambiguous { agent, .. }) => {
            (agent.clone(), "none".into(), None)
        }
        Err(f) => return Err(f.clone()),
    };
    let term = record.and_then(Term::parse);
    let status = term.as_ref().and_then(|t| t.status.clone());
    let status_kind = term.as_ref().and_then(|t| t.status_kind.clone());
    let screen = may_show_prompt(&agent, status.as_deref()).then(|| {
        HcScreen::new(terminal, READ_TIMEOUT)
            .visible_text(terminal)
            .map_err(|e| e.to_string())
    });
    let tree = match located {
        Some(l) => tree.unwrap_or_else(|| tree::tree_of(l)),
        None => Tree {
            agent: agent.clone(),
            root: root.clone(),
            path: PathBuf::new(),
            children: Vec::new(),
        },
    };
    let mut logs = Vec::new();
    if let Some(l) = located {
        logs.push((None, items_of(&l.path, FileScope::Root)));
        let mut kids: Vec<&tree::Child> = tree
            .children
            .iter()
            .filter(|c| c.running || c.ended_ms.is_some_and(|e| now_ms - e <= RECENT_CHILD_MS))
            .collect();
        kids.sort_by_key(|c| !c.running);
        for c in kids.into_iter().take(MAX_CHILD_LOGS) {
            if c.path.is_file() {
                logs.push((Some(c.id.clone()), items_of(&c.path, c.scope)));
            }
        }
    }
    Ok(CardsInput {
        terminal: terminal.to_string(),
        hooks: hooks_state(&agent, now_ms),
        agent,
        root,
        path: located.map(|l| l.path.clone()),
        ambiguous: matches!(found, Err(LocateFailure::Ambiguous { .. })),
        status,
        status_kind,
        screen,
        tree,
        events: events::read(terminal, now_ms - EVENTS_MS),
        logs,
    })
}

/// hc says `blocked` while an approval or a question shows. Codex's `/new` folder prompt shows while hc says
/// `idle`, so a Codex screen is read whenever Codex is not working.
fn may_show_prompt(agent: &str, status: Option<&str>) -> bool {
    status == Some("blocked") || (agent == "codex" && status != Some("working"))
}

fn items_of(path: &Path, scope: FileScope) -> Vec<ConversationItem> {
    tail::read(path, None, tail::BYTES)
        .map(|r| tail::items(&r.lines, scope))
        .unwrap_or_default()
}

/// `bw hooks check` for this machine, kept in `requests/hooks-check.json` for a minute.
fn hooks_state(agent: &str, now_ms: i64) -> String {
    let file = store::requests_dir().join("hooks-check.json");
    let kept: Option<Value> = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let line = match kept.filter(|k| {
        k["at_ms"]
            .as_i64()
            .is_some_and(|at| at <= now_ms && now_ms - at < HOOKS_CHECK_MS)
    }) {
        Some(k) => k["line"].clone(),
        None => {
            let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) else {
                return "unknown".into();
            };
            let env = |k: &str| std::env::var(k).ok();
            let t = crate::machine::hooks::targets(None, None, &env, Path::new(&home));
            let line = crate::machine::hooks::check(&t);
            // The check is cheap enough to run again when its answer cannot be kept.
            let _ = std::fs::create_dir_all(store::requests_dir()).and_then(|()| {
                std::fs::write(
                    &file,
                    serde_json::to_vec(&json!({"at_ms": now_ms, "line": line}))?,
                )
            });
            line
        }
    };
    line[agent].as_str().unwrap_or("unknown").to_string()
}

/// A `PermissionRequest` event of this session with the `tool_use_id` its `PreToolUse` named.
struct Ask<'a> {
    event: &'a Event,
    tool_use_id: Option<String>,
}

/// One thing asked now: its kind, what the card shows, and who asks.
struct Asked {
    kind: &'static str,
    screen_id: Option<String>,
    title: String,
    tool: String,
    command: String,
    detail: String,
    actions: Vec<(String, String)>,
    answerable: bool,
    reason: Option<&'static str>,
    question: Option<Value>,
    unread: usize,
    /// The box's question as drawn (`ScreenPrompt::question`).
    drawn_question: String,
    /// Option 2's label as drawn (`Action::drawn`).
    drawn_always: Option<String>,
}

struct Pass<'a> {
    input: &'a CardsInput,
    now_ms: i64,
    asks: Vec<Ask<'a>>,
}

impl Pass<'_> {
    fn items(&self, child: Option<&str>) -> Option<&[ConversationItem]> {
        self.input
            .logs
            .iter()
            .find(|(c, _)| c.as_deref() == child)
            .map(|(_, items)| items.as_slice())
    }

    fn all_items(&self) -> impl DoubleEndedIterator<Item = &ConversationItem> {
        self.input.logs.iter().flat_map(|(_, items)| items.iter())
    }

    /// The call that asks in `child`'s log (the root's for None): the newest call without a result.
    fn open_call(&self, child: Option<&str>) -> Option<&PermissionRequest> {
        self.items(child)?
            .iter()
            .rev()
            .find_map(|it| match &it.kind {
                ItemKind::PermissionRequest(p) if p.state == PermState::Pending => Some(p),
                _ => None,
            })
    }

    /// Whether the call `id` has a result in any log read: Some(true) for a rejection.
    fn result_of(&self, id: &str) -> Option<bool> {
        self.all_items().find_map(|it| match &it.kind {
            ItemKind::ToolChips(chips) => chips
                .iter()
                .flat_map(|c| c.calls.iter())
                .find(|c| c.id == id)
                .and_then(|c| c.output.as_deref())
                .map(rejected),
            _ => None,
        })
    }

    /// Whether any log read holds call `id`, waiting or done.
    fn logged_call(&self, id: &str) -> bool {
        self.all_items().any(|it| match &it.kind {
            ItemKind::PermissionRequest(p) => p.tool_use_id == id,
            ItemKind::ToolChips(chips) => chips
                .iter()
                .flat_map(|c| c.calls.iter())
                .any(|c| c.id == id),
            _ => false,
        })
    }

    fn ambiguity(&self) -> Option<&'static str> {
        self.input.ambiguous.then_some("ambiguous")
    }

    /// The asks that are this box now, newest per agent: same call, from an agent whose log does not show it
    /// finished or asking something else, and bound to no other occurrence.
    fn asks_for(&self, p: &ScreenPrompt, taken: &HashSet<&str>) -> Vec<&Ask<'_>> {
        let mut found: Vec<&Ask> = self
            .asks
            .iter()
            .filter(|a| !taken.contains(a.event.id.as_str()))
            .filter(|a| {
                a.event.tool.as_deref().is_some_and(|t| {
                    matchers::same_call(t, a.event.command.as_deref().unwrap_or(""), p)
                })
            })
            .filter(|a| self.still_asks(a, p))
            .collect();
        found.sort_by_key(|a| std::cmp::Reverse((a.event.at_ms, a.event.id.clone())));
        let mut seen: HashSet<Option<&str>> = HashSet::new();
        found.retain(|a| seen.insert(a.event.agent_id.as_deref()));
        found.reverse();
        found
    }

    fn still_asks(&self, a: &Ask, p: &ScreenPrompt) -> bool {
        let agent = a.event.agent_id.as_deref();
        if let Some(id) = agent {
            if self.input.tree.child(id).is_some_and(|c| !c.running) {
                return false;
            }
        }
        if a.tool_use_id
            .as_deref()
            .is_some_and(|t| self.result_of(t).is_some())
        {
            return false;
        }
        // A log that has not reached the call yet still counts; one that asks something else does not.
        match self.open_call(agent) {
            Some(open) => matchers::same_call(&open.tool_name, &open.command, p),
            None => true,
        }
    }

    /// The sub-agents whose own log's open call is this box, in the order their logs were read.
    fn logs_asking(&self, p: &ScreenPrompt) -> Vec<String> {
        self.input
            .logs
            .iter()
            .filter_map(|(c, _)| c.clone())
            .filter(|c| {
                self.open_call(Some(c))
                    .is_some_and(|o| matchers::same_call(&o.tool_name, &o.command, p))
            })
            .collect()
    }

    fn who_one(&self, child: &str, event: Option<&Event>) -> Value {
        match self.input.tree.child(child) {
            Some(c) => {
                json!({"child": c.id, "agent_type": c.agent_type, "description": c.description,
                              "depth": c.depth})
            }
            None => json!({"child": child,
                           "agent_type": event.and_then(|e| e.agent_type.clone()).unwrap_or_default(),
                           "description": "", "depth": null}),
        }
    }
}

/// A rejection, as each agent words it: Claude's after Esc or No, Codex's after Esc.
fn rejected(output: &str) -> bool {
    const MARKS: [&str; 4] = [
        "The user doesn't want to proceed",
        "tool use was rejected",
        "aborted by user",
        "rejected by user",
    ];
    MARKS.iter().any(|m| output.contains(m))
}

fn asks_of<'a>(input: &'a CardsInput) -> Vec<Ask<'a>> {
    let mine: Vec<&Event> = input
        .events
        .iter()
        .filter(|e| e.agent == input.agent && e.session.as_deref() == Some(input.root.as_str()))
        // Claude's own helper agents send events with an empty type; they never ask for the user's sub-agents.
        .filter(|e| e.agent_type.as_deref() != Some(""))
        .collect();
    mine.iter()
        .filter(|e| e.event == "PermissionRequest")
        .map(|pr| {
            let pre = mine
                .iter()
                .filter(|e| {
                    e.event == "PreToolUse"
                        && e.agent_id == pr.agent_id
                        && e.tool == pr.tool
                        && e.command == pr.command
                        && e.at_ms <= pr.at_ms
                        && pr.at_ms - e.at_ms <= PAIR_MS
                        && e.tool_use_id.is_some()
                })
                .max_by_key(|e| (e.at_ms, e.id.clone()));
            Ask {
                event: pr,
                tool_use_id: pr
                    .tool_use_id
                    .clone()
                    .or_else(|| pre.and_then(|e| e.tool_use_id.clone())),
            }
        })
        .collect()
}

fn actions_of(p: &ScreenPrompt) -> Vec<(String, String)> {
    p.actions
        .iter()
        .map(|a| (a.id.clone(), a.label.clone()))
        .collect()
}

fn drawn_always(p: &ScreenPrompt) -> Option<String> {
    p.actions
        .iter()
        .find(|a| a.id == "always")
        .map(|a| a.drawn.clone())
}

/// The `cards` line and one `request` line per pending request and per request resolved in the last 10 s.
/// Updates `store`, which starts afresh for a new root.
pub fn build(input: &CardsInput, store: &mut Store, now_ms: i64) -> (Value, Vec<Value>) {
    if store.root != input.root {
        *store = Store::new(&input.root);
    }
    let pass = Pass {
        input,
        now_ms,
        asks: asks_of(input),
    };
    let screen = match &input.screen {
        Some(Ok(text)) => Some(text.as_str()),
        _ => None,
    };
    // A failed read is no evidence a box left; an unread screen is, since hc says nothing waits.
    let known = !matches!(input.screen, Some(Err(_)));
    let blocked = input.status.as_deref() == Some("blocked");
    let mut live: Vec<String> = Vec::new();

    if let Some(text) = screen {
        if blocked {
            if let Some(p) = matchers::approval_on_screen(&input.agent, text) {
                live.push(approval(&pass, store, &p));
            } else if let Some(id) = picker(&pass, store, text) {
                live.push(id);
            } else if matchers::other_prompt(&input.agent, text) {
                live.push(other(&pass, store, text));
            }
        }
        if let Some(p) = matchers::folder_prompt_on_screen(&input.agent, text) {
            let asked = Asked {
                kind: "prompt",
                screen_id: Some(p.screen_id.clone()),
                title: p.title.clone(),
                tool: p.tool.clone(),
                command: p.command.clone(),
                detail: p.detail.clone(),
                actions: actions_of(&p),
                answerable: !input.ambiguous,
                reason: pass.ambiguity(),
                question: None,
                unread: 0,
                drawn_question: p.question.clone(),
                drawn_always: drawn_always(&p),
            };
            live.push(on_screen(&pass, store, asked, None, Vec::new()));
        }
    }
    live.extend(async_questions(&pass, store));

    for o in store.occurrences.iter_mut() {
        if live.contains(&o.id) || !o.open() {
            continue;
        }
        if o.kind == "question_async" {
            resolve_async(&pass, o);
        } else if known || o.state == "settling" {
            resolve(&pass, o);
        }
    }

    let cards = json!({
        "type": "cards",
        "terminal": input.terminal,
        "agent": input.agent,
        "session": (input.root != "none").then_some(&input.root),
        "path": input.path.as_ref().map(|p| p.to_string_lossy()),
        "status": input.status,
        "status_kind": input.status_kind,
        "hooks": input.hooks,
        "screen": match &input.screen {
            None => "unread",
            Some(Ok(_)) => "read",
            Some(Err(_)) => "failed",
        },
    });
    let mut shown: Vec<&Occurrence> = store
        .occurrences
        .iter()
        .filter(|o| {
            o.shown.is_some()
                && o.resolved_ms
                    .is_none_or(|r| now_ms - r < RESOLVED_SHOW_MS && r <= now_ms)
        })
        .collect();
    shown.sort_by_key(|o| (o.first_seen_ms, o.id.clone()));
    let requests = shown.into_iter().map(request_line).collect();
    (cards, requests)
}

fn request_line(o: &Occurrence) -> Value {
    let mut v = o.shown.clone().unwrap_or_else(|| json!({}));
    v["state"] = json!(o.state);
    v["resolved_ms"] = json!(o.resolved_ms);
    v["event"] = json!(o.event);
    v["tool_use_id"] = json!(o.tool_use_id);
    if o.state != "pending" {
        v["answerable"] = json!(false);
        v["reason"] = Value::Null;
    }
    v
}

/// The id a new occurrence takes: `preferred` unless the store already used it, else `<screen id>@<now>`.
fn fresh_id(store: &Store, preferred: Option<String>, screen_id: &str, now_ms: i64) -> String {
    let used = |id: &str| store.occurrences.iter().any(|o| o.id == id);
    if let Some(id) = preferred.filter(|id| !used(id)) {
        return id;
    }
    let base = format!("{screen_id}@{now_ms}");
    let mut id = base.clone();
    let mut n = 1;
    while used(&id) {
        id = format!("{base}.{n}");
        n += 1;
    }
    id
}

/// Binds a prompt on screen to its occurrence (the one pending for the same box, else a new one), records what
/// the card shows, and returns the occurrence id.
fn on_screen(
    pass: &Pass,
    store: &mut Store,
    asked: Asked,
    who: Option<(Vec<String>, Option<String>)>,
    events: Vec<String>,
) -> String {
    on_screen_with(pass, store, asked, who, events, None, |_| false)
}

/// The command, the question and option 2's label of `asked` as drawn, kept on its occurrence when first seen.
fn first_of(asked: &Asked) -> Value {
    json!({"command": asked.command, "question": asked.drawn_question, "always": asked.drawn_always})
}

/// Whether `asked` shows the command and the question its occurrence first showed, line breaks aside.
fn same_first(o: &Occurrence, asked: &Asked) -> bool {
    o.first.as_ref().is_none_or(|f| {
        let text = |k: &str| f[k].as_str().unwrap_or("").to_string();
        matchers::same_drawn(&text("command"), &asked.command)
            && matchers::same_drawn(&text("question"), &asked.drawn_question)
    })
}

/// A wider pane draws more of option 2's label than the first read's cut: keep the longer one, so a later label
/// that only extends the cut is refused.
fn widen_always(o: &mut Occurrence, asked: &Asked) {
    let Some(first) = o.first.as_mut() else {
        return;
    };
    let (Some(was), Some(now)) = (first["always"].as_str(), asked.drawn_always.as_deref()) else {
        return;
    };
    if matchers::cut_of(was, now) && !matchers::cut_of(now, was) {
        first["always"] = json!(now);
    }
}

fn on_screen_with(
    pass: &Pass,
    store: &mut Store,
    asked: Asked,
    who: Option<(Vec<String>, Option<String>)>,
    events: Vec<String>,
    tool_use_id: Option<String>,
    superseded: impl Fn(&Occurrence) -> bool,
) -> String {
    let now_ms = pass.now_ms;
    let screen_id = asked.screen_id.clone().unwrap_or_default();
    let existing = store.occurrences.iter().position(|o| {
        o.kind == asked.kind
            && o.screen_id.as_deref() == Some(screen_id.as_str())
            && (o.state == "pending" || o.state == "uncertain")
    });
    let existing = match existing {
        // Same id but another command (it differs only in spacing, which the id leaves out): another prompt.
        Some(i)
            if superseded(&store.occurrences[i]) || !same_first(&store.occurrences[i], &asked) =>
        {
            resolve(pass, &mut store.occurrences[i]);
            None
        }
        other => other,
    };
    let (children, _) = who.clone().unwrap_or_default();
    let i = match existing {
        Some(i) => {
            widen_always(&mut store.occurrences[i], &asked);
            i
        }
        None => {
            let preferred = events
                .last()
                .cloned()
                .or_else(|| who.as_ref().and_then(|w| w.1.clone()));
            let id = fresh_id(store, preferred, &screen_id, now_ms);
            store.occurrences.push(Occurrence {
                id,
                kind: asked.kind.to_string(),
                screen_id: asked.screen_id.clone(),
                event: None,
                tool_use_id: None,
                child: children.first().cloned(),
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
                state: "pending".into(),
                by: None,
                resolved_ms: None,
                left_ms: None,
                events: Vec::new(),
                shown: None,
                first: Some(first_of(&asked)),
            });
            store.occurrences.len() - 1
        }
    };
    let o = &mut store.occurrences[i];
    for e in events {
        if !o.events.contains(&e) {
            o.events.push(e);
        }
    }
    o.event = o.events.last().cloned();
    if let Some(t) = tool_use_id {
        o.tool_use_id = Some(t);
    }
    o.last_seen_ms = now_ms;
    let event_of = |c: &str| {
        pass.input
            .events
            .iter()
            .find(|e| e.agent_id.as_deref() == Some(c))
    };
    let who_line = match children.as_slice() {
        [] => Value::Null,
        [one] => pass.who_one(one, event_of(one)),
        many => Value::Array(many.iter().map(|c| pass.who_one(c, event_of(c))).collect()),
    };
    let mut answerable = asked.answerable;
    let mut reason = asked.reason;
    if answerable
        && pass.input.agent == "codex"
        && asked.kind == "approval"
        && !children.is_empty()
        && !CODEX_CHILD_ANSWERABLE
    {
        answerable = false;
        reason = Some("codex_child");
    }
    o.shown = Some(json!({
        "type": "request",
        "id": store::request_id(&pass.input.terminal, &pass.input.root, o.child.as_deref(), &o.id),
        "kind": asked.kind,
        "state": o.state,
        "answerable": answerable,
        "reason": reason,
        "who": who_line,
        "title": asked.title,
        "tool": asked.tool,
        "command": asked.command,
        "detail": asked.detail,
        "actions": asked.actions.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
        "question": asked.question,
        "unread": asked.unread,
        "screen_id": asked.screen_id,
        "event": o.event,
        "tool_use_id": o.tool_use_id,
        "at_ms": o.first_seen_ms,
        "resolved_ms": Value::Null,
    }));
    o.id.clone()
}

/// The approval box on screen. Who asks: the bound hook events' agents, else the logs whose open call is this
/// box, else the root. Two agents asking the same call bind one box; its keys never depend on which asked.
fn approval(pass: &Pass, store: &mut Store, p: &ScreenPrompt) -> String {
    let pending = store.occurrences.iter().find(|o| {
        o.kind == "approval"
            && o.screen_id.as_deref() == Some(p.screen_id.as_str())
            && (o.state == "pending" || o.state == "uncertain")
    });
    let own: Vec<String> = pending.map(|o| o.events.clone()).unwrap_or_default();
    let taken: HashSet<&str> = store
        .occurrences
        .iter()
        .filter(|o| pending.is_none_or(|q| q.id != o.id))
        .flat_map(|o| o.events.iter().map(String::as_str))
        .collect();
    let fresh = pass.asks_for(p, &taken);
    // A newer ask from the agent whose ask the pending occurrence holds is the next prompt with the same box.
    let agent_of = |id: &str| {
        pass.asks
            .iter()
            .find(|a| a.event.id == id)
            .map(|a| (a.event.agent_id.clone(), a.event.at_ms))
    };
    let newer_ask = |o: &Occurrence| {
        let Some((agent, at)) = o.event.as_deref().and_then(agent_of) else {
            return false;
        };
        fresh.iter().any(|a| {
            !o.events.contains(&a.event.id) && a.event.agent_id == agent && a.event.at_ms > at
        })
    };
    let answered_call = |o: &Occurrence| {
        o.tool_use_id
            .as_deref()
            .is_some_and(|t| pass.result_of(t).is_some())
    };
    // A box bound to one logged call whose log now asks a newer call with the same box is the next prompt.
    let moved_call = |o: &Occurrence| {
        let Some(was) = o.tool_use_id.as_deref() else {
            return false;
        };
        pass.open_call(o.child.as_deref())
            .filter(|c| matchers::same_call(&c.tool_name, &c.command, p))
            .is_some_and(|c| c.tool_use_id != was && pass.logged_call(was))
    };
    let superseded = |o: &Occurrence| newer_ask(o) || answered_call(o) || moved_call(o);
    let replaces = pending.is_some_and(superseded);
    let mut bound: Vec<&Ask> = Vec::new();
    if !replaces {
        bound.extend(pass.asks.iter().filter(|a| own.contains(&a.event.id)));
    }
    for a in fresh.iter().copied() {
        if !bound.iter().any(|b| b.event.id == a.event.id) {
            bound.push(a);
        }
    }
    bound.sort_by_key(|a| (a.event.at_ms, a.event.id.clone()));

    let log_children = pass.logs_asking(p);
    let mut children: Vec<String> = Vec::new();
    if bound.is_empty() {
        children = log_children;
    } else {
        for a in &bound {
            if let Some(c) = &a.event.agent_id {
                if !children.contains(c) {
                    children.push(c.clone());
                }
            }
        }
    }
    let first = children.first().map(String::as_str);
    let log_call = pass
        .open_call(first)
        .filter(|o| matchers::same_call(&o.tool_name, &o.command, p))
        .map(|o| o.tool_use_id.clone());
    let tool_use_id = log_call.clone().or_else(|| {
        bound
            .iter()
            .rev()
            .find(|a| a.event.agent_id.as_deref() == first)
            .and_then(|a| a.tool_use_id.clone())
    });
    let (answerable, reason) = match (pass.ambiguity(), p.clipped) {
        (Some(r), _) => (false, Some(r)),
        (None, true) => (false, Some("clipped")),
        (None, false) => (true, None),
    };
    let asked = Asked {
        kind: "approval",
        screen_id: Some(p.screen_id.clone()),
        title: p.title.clone(),
        tool: p.tool.clone(),
        command: p.command.clone(),
        detail: p.detail.clone(),
        actions: actions_of(p),
        answerable,
        reason,
        question: None,
        unread: 0,
        drawn_question: p.question.clone(),
        drawn_always: drawn_always(p),
    };
    let events: Vec<String> = bound.iter().map(|a| a.event.id.clone()).collect();
    on_screen_with(
        pass,
        store,
        asked,
        Some((children, log_call)),
        events,
        tool_use_id,
        superseded,
    )
}

/// A question picker on screen: Claude's (read from the screen; its log has the call only once answered), or
/// Codex's `request_user_input` whose call waits in a log.
fn picker(pass: &Pass, store: &mut Store, text: &str) -> Option<String> {
    let ambiguous = pass.ambiguity();
    if pass.input.agent == "claude" {
        let (req, unread) = claude_picker(text)?;
        // Reading the other questions takes navigation keys, which no pass presses.
        let reason = ambiguous.or((unread > 0).then_some("multi_question"));
        let asked = Asked {
            kind: "question",
            screen_id: Some(req.tool_use_id.clone()),
            title: String::new(),
            tool: "AskUserQuestion".into(),
            command: String::new(),
            detail: String::new(),
            actions: Vec::new(),
            answerable: reason.is_none(),
            reason,
            question: Some(json!(rows::question(&req))),
            unread,
            drawn_question: String::new(),
            drawn_always: None,
        };
        return Some(on_screen(pass, store, asked, None, Vec::new()));
    }
    question::codex_screen(text)?;
    let (child, q) = pass.input.logs.iter().find_map(|(c, items)| {
        items.iter().rev().find_map(|it| match &it.kind {
            ItemKind::Question(q)
                if q.state == QuestionState::Pending && q.delivery == Delivery::Picker =>
            {
                Some((c.clone(), q))
            }
            _ => None,
        })
    })?;
    let asked = Asked {
        kind: "question",
        screen_id: Some(q.tool_use_id.clone()),
        title: String::new(),
        tool: "request_user_input".into(),
        command: String::new(),
        detail: String::new(),
        actions: Vec::new(),
        answerable: ambiguous.is_none(),
        reason: ambiguous,
        question: Some(json!(rows::question(q))),
        unread: 0,
        drawn_question: String::new(),
        drawn_always: None,
    };
    let who = (child.into_iter().collect(), Some(q.tool_use_id.clone()));
    Some(on_screen_with(
        pass,
        store,
        asked,
        Some(who),
        Vec::new(),
        Some(q.tool_use_id.clone()),
        |_| false,
    ))
}

/// The Claude picker on `text`: the question shown, as a request whose `tool_use_id` is its screen id, and how
/// many of its questions are not shown. With every question shown the id also covers each question's text and
/// options in order with their details, so a picker replaced by one with the same header is a new occurrence.
pub fn claude_picker(text: &str) -> Option<(QuestionRequest, usize)> {
    let (headers, q) = question::claude_screen(text)?;
    let mut req = question::screen_request(&headers, vec![q]);
    let unread = headers.len().saturating_sub(req.questions.len());
    if unread == 0 {
        let shown = serde_json::to_string(&rows::question(&req).questions).unwrap_or_default();
        // Keeps the vendored "screen-" prefix: `question::answer_question` reads it as a screen-only request.
        req.tool_use_id = format!(
            "{}.{}",
            req.tool_use_id,
            &hash_id(&shown)["screen-".len()..]
        );
    }
    Some((req, unread))
}

/// A prompt on screen no matcher reads: shown so the user knows the agent waits, answered in the terminal.
fn other(pass: &Pass, store: &mut Store, text: &str) -> String {
    let tail: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    let tail = &tail[tail.len().saturating_sub(40)..];
    let asked = Asked {
        kind: "approval",
        screen_id: Some(format!(
            "other-{}",
            hash_id(&format!("{}\nother\n{}", pass.input.agent, tail.join("\n")))
        )),
        title: String::new(),
        tool: String::new(),
        command: String::new(),
        detail: String::new(),
        actions: Vec::new(),
        answerable: false,
        reason: Some(pass.ambiguity().unwrap_or("no_match")),
        question: None,
        unread: 0,
        drawn_question: String::new(),
        drawn_always: None,
    };
    on_screen(pass, store, asked, None, Vec::new())
}

/// Codex's `request_user_input_async` questions waiting in a log: answered by one message, so not on screen.
fn async_questions(pass: &Pass, store: &mut Store) -> Vec<String> {
    let waiting: Vec<(Option<String>, &QuestionRequest)> = pass
        .input
        .logs
        .iter()
        .flat_map(|(c, items)| {
            items.iter().filter_map(move |it| match &it.kind {
                ItemKind::Question(q)
                    if q.delivery == Delivery::Message && q.state == QuestionState::Pending =>
                {
                    Some((c.clone(), q))
                }
                _ => None,
            })
        })
        .collect();
    let mut live = Vec::new();
    for (child, q) in waiting {
        let ambiguous = pass.ambiguity();
        let asked = Asked {
            kind: "question_async",
            screen_id: None,
            title: String::new(),
            tool: "request_user_input_async".into(),
            command: String::new(),
            detail: String::new(),
            actions: Vec::new(),
            answerable: ambiguous.is_none(),
            reason: ambiguous,
            question: Some(json!(rows::question(q))),
            unread: 0,
            drawn_question: String::new(),
            drawn_always: None,
        };
        let id = q.tool_use_id.clone();
        if !store.occurrences.iter().any(|o| o.id == id) {
            store.occurrences.push(Occurrence {
                id: id.clone(),
                kind: "question_async".into(),
                screen_id: None,
                event: None,
                tool_use_id: Some(id.clone()),
                child: child.clone(),
                first_seen_ms: pass.now_ms,
                last_seen_ms: pass.now_ms,
                state: "pending".into(),
                by: None,
                resolved_ms: None,
                left_ms: None,
                events: Vec::new(),
                shown: None,
                first: None,
            });
        }
        let Some(o) = store.occurrences.iter_mut().find(|o| o.id == id) else {
            continue;
        };
        if o.state != "pending" {
            continue;
        }
        o.last_seen_ms = pass.now_ms;
        let who = match &child {
            Some(c) => pass.who_one(c, None),
            None => Value::Null,
        };
        o.shown = Some(json!({
            "type": "request",
            "id": store::request_id(&pass.input.terminal, &pass.input.root, o.child.as_deref(), &o.id),
            "kind": asked.kind,
            "state": o.state,
            "answerable": asked.answerable,
            "reason": asked.reason,
            "who": who,
            "title": asked.title,
            "tool": asked.tool,
            "command": asked.command,
            "detail": asked.detail,
            "actions": [],
            "question": asked.question,
            "unread": 0,
            "screen_id": Value::Null,
            "event": Value::Null,
            "tool_use_id": o.tool_use_id,
            "at_ms": o.first_seen_ms,
            "resolved_ms": Value::Null,
        }));
        live.push(id);
    }
    live
}

/// An async question no longer waiting: answered by the message Bellwether sent, else in the terminal.
fn resolve_async(pass: &Pass, o: &mut Occurrence) {
    let found = pass.all_items().find_map(|it| match &it.kind {
        ItemKind::Question(q) if Some(&q.tool_use_id) == o.tool_use_id.as_ref() => Some(&q.state),
        _ => None,
    });
    let state = match (found, o.by.is_some()) {
        (None | Some(QuestionState::Pending), _) => return,
        (Some(QuestionState::Declined), _) => "declined_terminal",
        (Some(QuestionState::Answered(_)), true) => "answered",
        (Some(QuestionState::Answered(_)), false) => "answered_terminal",
    };
    o.state = state.into();
    o.resolved_ms = Some(pass.now_ms);
}

/// A box that left the screen: Bellwether's key went out (`by`), else its call's result says the terminal
/// answered or denied it. With no result yet it is `settling` for up to `SETTLE_MS`, since the agent logs the
/// result a moment after the box goes, then `stale`. A call with no id has no result to wait for.
fn resolve(pass: &Pass, o: &mut Occurrence) {
    let state = match o.by.as_deref() {
        Some("deny") => "declined",
        Some(_) => "answered",
        None if o.kind == "prompt" => "answered_terminal",
        None if o
            .screen_id
            .as_deref()
            .is_some_and(|s| s.starts_with("other-")) =>
        {
            "answered_terminal"
        }
        None if o.kind == "question" => question_result(pass, o),
        None => match o.tool_use_id.as_deref().and_then(|t| pass.result_of(t)) {
            Some(true) => "declined_terminal",
            Some(false) => "answered_terminal",
            None => "stale",
        },
    };
    if state == "stale" && (o.kind == "question" || o.tool_use_id.is_some()) {
        let left = *o.left_ms.get_or_insert(pass.now_ms);
        if pass.now_ms - left < store::SETTLE_MS {
            o.state = "settling".into();
            return;
        }
    }
    o.state = state.into();
    o.resolved_ms = Some(pass.now_ms);
}

/// A question picker that left: its call in the log (Codex by id; Claude's, written once answered, by time).
fn question_result(pass: &Pass, o: &Occurrence) -> &'static str {
    let since = (o.first_seen_ms - RECENT_CHILD_MS) as f64 / 1000.0;
    let state = pass.all_items().rev().find_map(|it| match &it.kind {
        ItemKind::Question(q)
            if Some(&q.tool_use_id) == o.tool_use_id.as_ref()
                || (o.tool_use_id.is_none()
                    && q.agent == "claude"
                    && it.timestamp.is_some_and(|t| t >= since)) =>
        {
            Some(&q.state)
        }
        _ => None,
    });
    match state {
        Some(QuestionState::Answered(_)) => "answered_terminal",
        Some(QuestionState::Declined) => "declined_terminal",
        _ => "stale",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejections_by_each_agent() {
        assert!(rejected(
            "The user doesn't want to proceed with this tool use. The tool use was rejected"
        ));
        assert!(rejected("aborted by user after 2.7s"));
        assert!(!rejected("(Bash completed with no output)"));
    }

    #[test]
    fn codex_screens_are_read_unless_working() {
        assert!(may_show_prompt("claude", Some("blocked")));
        assert!(!may_show_prompt("claude", Some("idle")));
        assert!(!may_show_prompt("claude", None));
        assert!(may_show_prompt("codex", Some("idle")));
        assert!(may_show_prompt("codex", None));
        assert!(!may_show_prompt("codex", Some("working")));
    }
}
