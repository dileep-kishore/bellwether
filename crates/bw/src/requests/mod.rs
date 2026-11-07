//! `bw cards|answer|counts`: the approvals and questions of a session and its sub-agents.

use std::process::ExitCode;

pub mod answer;
pub mod cards;
pub mod claims;
pub mod codex_approval;
pub mod codex_folder;
pub mod counts;
pub mod matchers;
pub mod screen;
pub mod store;

pub fn run(cmd: &str, args: &[String]) -> ExitCode {
    match cmd {
        "cards" => cards::run(args),
        "answer" => answer::run(args),
        "counts" => counts::run(args),
        other => crate::usage(&format!("unknown request command {other:?}")),
    }
}
