//! `bw feed|locate|send|picture|picture-read`: a chat tab's reads and writes.

use std::process::ExitCode;

use serde_json::json;

pub mod args;
// `bw locate` (Task 7) is the first caller of `roots_except`.
#[allow(dead_code)]
pub mod cache;
pub mod protocol;

mod feed;
#[allow(dead_code)]
pub mod locate;
mod picture;
mod rows;
mod send;
mod sentence;
mod tail;

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
