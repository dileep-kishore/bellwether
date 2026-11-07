//! `bw browser tabs|focus|close|new`: the Chrome's pages and their favicons.

use std::process::ExitCode;

pub fn run(cmd: &str, _args: &[String]) -> ExitCode {
    crate::chat::error(
        "not_built",
        &format!("bw browser {cmd} arrives in a later task"),
    )
}
