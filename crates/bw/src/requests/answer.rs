//! `bw answer`: presses a request's keys only while it is on screen.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw answer arrives in a later task")
}
