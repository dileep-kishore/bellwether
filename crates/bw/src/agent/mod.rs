//! `bw agent …`: Bellwether's agent files on the space's machine, and each new agent's extra argv.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw agent arrives in a later task")
}
