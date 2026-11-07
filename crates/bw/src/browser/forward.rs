//! `bw browser free-port|port-check|forward …`: the checked SSH forwards to and from other machines.

use std::process::ExitCode;

pub fn run(cmd: &str, _args: &[String]) -> ExitCode {
    crate::chat::error(
        "not_built",
        &format!("bw browser {cmd} arrives in a later task"),
    )
}
