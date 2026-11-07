//! `bw browser agent-args|status`: a new agent's extra argv, and the Browser panel's one call.

use std::process::ExitCode;

pub fn run(cmd: &str, _args: &[String]) -> ExitCode {
    crate::chat::error(
        "not_built",
        &format!("bw browser {cmd} arrives in a later task"),
    )
}
