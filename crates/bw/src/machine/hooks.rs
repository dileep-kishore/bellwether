//! `bw hooks` and `bw machine setup`: Bellwether's hook groups in Claude's and Codex's settings.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw hooks arrives in a later task")
}

pub fn setup(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw machine setup arrives in a later task")
}
