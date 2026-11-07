//! `bw cards`: the approvals and questions a session waits on.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw cards arrives in a later task")
}
