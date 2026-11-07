//! `bw counts`: running sub-agents and waiting requests per terminal.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw counts arrives in a later task")
}
