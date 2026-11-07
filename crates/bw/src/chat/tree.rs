//! `bw tree`: the sub-agents of the session a terminal shows.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw tree arrives in a later task")
}
