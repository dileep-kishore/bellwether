use std::process::ExitCode;

use serde_json::json;

mod chat;
mod events;
mod hc;
mod machine;
mod requests;
mod version;

const USAGE: &str = "usage: bw version | bw machine status <machine> | bw machine install <machine> [--force] \
    | bw machine setup <machine|local> <options> | bw feed|locate|send|picture|picture-read|tree <options> \
    | bw cards|answer|counts <options> | bw hooks <options> | bw event --agent claude|codex";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version") => {
            println!("{}", version::version_json());
            ExitCode::SUCCESS
        }
        Some("machine") => machine::run(&args[1..]),
        Some(cmd @ ("feed" | "locate" | "send" | "picture" | "picture-read" | "tree")) => {
            chat::run(cmd, &args[1..])
        }
        Some(cmd @ ("cards" | "answer" | "counts")) => requests::run(cmd, &args[1..]),
        Some("event") => events::run(&args[1..]),
        Some("hooks") => machine::hooks::run(&args[1..]),
        Some(other) => usage(&format!("unknown command {other:?}; {USAGE}")),
        None => usage(USAGE),
    }
}

fn usage(message: &str) -> ExitCode {
    println!(
        "{}",
        json!({"type": "error", "code": "usage", "message": message})
    );
    ExitCode::from(2)
}
