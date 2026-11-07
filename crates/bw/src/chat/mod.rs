//! `bw feed|locate|send|picture|picture-read|tree`: a chat tab's reads and writes.

use std::process::ExitCode;

use serde_json::json;

pub mod args;
pub mod cache;
pub mod dirs;
pub mod protocol;

pub mod feed;
pub mod locate;
mod picture;
pub mod rows;
pub(crate) mod send;
mod sentence;
pub mod tail;
pub mod tree;

pub fn run(cmd: &str, args: &[String]) -> ExitCode {
    match cmd {
        "feed" => feed::run(args),
        "locate" => locate::run(args),
        "send" => send::run(args),
        "picture" => picture::run(args),
        "picture-read" => picture::run_read(args),
        "tree" => tree::run(args),
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
