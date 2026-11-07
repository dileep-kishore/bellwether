//! `bw event`: records one Claude or Codex hook payload for the chat; decides nothing.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    crate::chat::error("not_built", "bw event arrives in a later task")
}
