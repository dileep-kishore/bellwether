//! `bw picture` (window machine) and `bw picture-read` (the space's machine): not built yet.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    super::not_built("picture")
}

pub fn run_read(_args: &[String]) -> ExitCode {
    super::not_built("picture-read")
}
