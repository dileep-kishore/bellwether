//! `bw browser up|down`: start, reuse and close the Bellwether Chrome.

use std::process::ExitCode;

pub fn run(cmd: &str, _args: &[String]) -> ExitCode {
    crate::chat::error(
        "not_built",
        &format!("bw browser {cmd} arrives in a later task"),
    )
}
