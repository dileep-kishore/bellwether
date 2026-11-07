//! `bw feed|locate|send|picture|picture-read`: a chat tab's reads and writes.

use std::process::ExitCode;

use serde_json::json;

// Tasks 5, 7, 9 and 10 call these; until then only their tests do.
#[allow(dead_code)]
pub mod args;
#[allow(dead_code)]
pub mod cache;
#[allow(dead_code)]
pub mod protocol;

mod feed;
#[allow(dead_code)]
pub mod locate;
mod picture;
mod send;

pub fn run(cmd: &str, args: &[String]) -> ExitCode {
    match cmd {
        "feed" => feed::run(args),
        "locate" => locate::run(args),
        "send" => send::run(args),
        "picture" => picture::run(args),
        "picture-read" => picture::run_read(args),
        other => crate::usage(&format!("unknown chat command {other:?}")),
    }
}

/// One `{"type":"error"}` line; exit 1, as `shared/helper.js` reads any error line as `failed`.
pub fn error(code: &str, message: &str) -> ExitCode {
    println!(
        "{}",
        json!({"type": "error", "code": code, "message": message})
    );
    ExitCode::from(1)
}

/// What a command whose task has not landed prints.
pub fn not_built(cmd: &str) -> ExitCode {
    error("not_built", &format!("{cmd} arrives in a later task"))
}
