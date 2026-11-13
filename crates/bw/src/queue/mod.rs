//! `bw queue`: per-terminal prompt queue and `Stop`-hook auto-drain.

pub mod drain;
pub mod store;

use std::io::{self, Read};
use std::process::ExitCode;

use serde_json::json;

use crate::chat::{args, cache};

const USAGE: &str = "usage: bw queue list|add|edit|move|remove|clear|resume|drain ...";

pub fn has_runnable(core: &str, terminal: &str) -> bool {
    store::has_runnable(core, terminal)
}

fn emit_err(e: StoreErrorOrMsg) -> ExitCode {
    match e {
        StoreErrorOrMsg::Store(err) => {
            if err.usage {
                crate::usage(&format!("{}; {USAGE}", err.message))
            } else {
                crate::chat::error(err.code, &err.message)
            }
        }
        StoreErrorOrMsg::Usage(m) => crate::usage(&format!("{m}; {USAGE}")),
    }
}

enum StoreErrorOrMsg {
    Store(store::StoreError),
    Usage(String),
}

impl From<store::StoreError> for StoreErrorOrMsg {
    fn from(v: store::StoreError) -> Self {
        Self::Store(v)
    }
}

fn read_text_arg(a: &args::Args) -> Result<String, StoreErrorOrMsg> {
    match (a.get("text"), a.has("text-stdin")) {
        (Some(_), true) => Err(StoreErrorOrMsg::Usage(
            "pass either --text or --text-stdin, never both".into(),
        )),
        (Some(t), false) => Ok(t.to_string()),
        (None, true) => {
            let mut bytes = Vec::new();
            io::stdin()
                .lock()
                .take((store::MAX_TEXT_BYTES as u64) + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| store::StoreError::runtime("io_error", format!("read stdin: {e}")))?;
            if bytes.len() > store::MAX_TEXT_BYTES {
                return Err(store::StoreError::runtime(
                    "too_large",
                    format!("queued message exceeds {} bytes", store::MAX_TEXT_BYTES),
                )
                .into());
            }
            String::from_utf8(bytes)
                .map_err(|e| store::StoreError::usage(format!("stdin is not UTF-8: {e}")).into())
        }
        (None, false) => Err(StoreErrorOrMsg::Usage(
            "missing --text or --text-stdin".into(),
        )),
    }
}

pub fn run(argv: &[String]) -> ExitCode {
    let Some((sub, rest)) = argv.split_first() else {
        return crate::usage(USAGE);
    };
    let core = cache::core_name();
    match sub.as_str() {
        "list" => {
            let a = match args::parse(rest, &[], &["terminal"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let Some(terminal) = a.get("terminal") else {
                return emit_err(StoreErrorOrMsg::Usage("missing --terminal".into()));
            };
            if let Err(e) = store::validate_terminal(terminal) {
                return emit_err(e.into());
            }
            let state = store::read_in(&core, terminal);
            println!("{}", store::state_json(terminal, &state, None, None));
            ExitCode::SUCCESS
        }
        "add" => {
            let a = match args::parse(
                rest,
                &["text-stdin"],
                &["terminal", "kind", "session", "text"],
            ) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let (Some(terminal), Some(kind)) = (a.get("terminal"), a.get("kind")) else {
                return emit_err(StoreErrorOrMsg::Usage(
                    "add requires --terminal and --kind".into(),
                ));
            };
            let text = match read_text_arg(&a) {
                Ok(t) => t,
                Err(e) => return emit_err(e),
            };
            match store::add_item(&core, terminal, kind, a.get("session"), text) {
                Ok((item, state)) => {
                    println!(
                        "{}",
                        store::state_json(
                            terminal,
                            &state,
                            Some("added"),
                            Some(("item", json!(item))),
                        )
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => emit_err(e.into()),
            }
        }
        "edit" => {
            let a = match args::parse(rest, &["text-stdin"], &["terminal", "id", "text"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let (Some(terminal), Some(id)) = (a.get("terminal"), a.get("id")) else {
                return emit_err(StoreErrorOrMsg::Usage(
                    "edit requires --terminal and --id".into(),
                ));
            };
            let text = match read_text_arg(&a) {
                Ok(t) => t,
                Err(e) => return emit_err(e),
            };
            match store::edit_item(&core, terminal, id, text) {
                Ok(state) => {
                    println!(
                        "{}",
                        store::state_json(terminal, &state, Some("edited"), None)
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => emit_err(e.into()),
            }
        }
        "move" => {
            let a = match args::parse(rest, &[], &["terminal", "id", "to"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let (Some(terminal), Some(id), Some(to_str)) =
                (a.get("terminal"), a.get("id"), a.get("to"))
            else {
                return emit_err(StoreErrorOrMsg::Usage(
                    "move requires --terminal, --id, and --to".into(),
                ));
            };
            let Ok(to) = to_str.parse::<usize>() else {
                return emit_err(StoreErrorOrMsg::Usage("invalid --to index".into()));
            };
            match store::move_item(&core, terminal, id, to) {
                Ok(state) => {
                    println!(
                        "{}",
                        store::state_json(terminal, &state, Some("moved"), None)
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => emit_err(e.into()),
            }
        }
        "remove" => {
            let a = match args::parse(rest, &[], &["terminal", "id"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let (Some(terminal), Some(id)) = (a.get("terminal"), a.get("id")) else {
                return emit_err(StoreErrorOrMsg::Usage(
                    "remove requires --terminal and --id".into(),
                ));
            };
            match store::remove_item(&core, terminal, id) {
                Ok(state) => {
                    println!(
                        "{}",
                        store::state_json(terminal, &state, Some("removed"), None)
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => emit_err(e.into()),
            }
        }
        "clear" => {
            let a = match args::parse(rest, &[], &["terminal"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let Some(terminal) = a.get("terminal") else {
                return emit_err(StoreErrorOrMsg::Usage("missing --terminal".into()));
            };
            match store::clear_items(&core, terminal) {
                Ok(state) => {
                    println!(
                        "{}",
                        store::state_json(terminal, &state, Some("cleared"), None)
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => emit_err(e.into()),
            }
        }
        "resume" => {
            let a = match args::parse(rest, &[], &["terminal"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let Some(terminal) = a.get("terminal") else {
                return emit_err(StoreErrorOrMsg::Usage("missing --terminal".into()));
            };
            if let Err(e) = store::resume_queue(&core, terminal) {
                return emit_err(e.into());
            }
            let drain_res = drain::drain_terminal(terminal, None, false, true).ok();
            let latest = store::read_in(&core, terminal);
            println!(
                "{}",
                store::state_json(
                    terminal,
                    &latest,
                    Some("resumed"),
                    drain_res.map(|d| ("drain", drain::report_json(&d))),
                )
            );
            ExitCode::SUCCESS
        }
        "drain" => {
            let a = match args::parse(rest, &["force-next"], &["terminal", "on-stop"]) {
                Ok(a) => a,
                Err(m) => return emit_err(StoreErrorOrMsg::Usage(m)),
            };
            let Some(terminal) = a.get("terminal") else {
                return emit_err(StoreErrorOrMsg::Usage("missing --terminal".into()));
            };
            match drain::drain_terminal(terminal, a.get("on-stop"), a.has("force-next"), false) {
                Ok(report) => {
                    println!("{}", drain::report_json(&report));
                    ExitCode::SUCCESS
                }
                Err(e) => emit_err(e.into()),
            }
        }
        _ => crate::usage(USAGE),
    }
}
