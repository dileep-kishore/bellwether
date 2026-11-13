use std::process::ExitCode;

use serde_json::json;

mod agent;
mod browser;
mod chat;
mod diff;
mod events;
mod hc;
mod linear;
mod machine;
mod pr;
mod queue;
mod requests;
mod version;

const USAGE: &str = "usage: bw version | bw machine status <machine> | bw machine install <machine> [--force] \
    | bw machine setup <machine|local> <options> | bw feed|locate|send|picture|picture-read|tree <options> \
    | bw cards|answer|counts <options> | bw hooks <options> | bw event --agent claude|codex \
    | bw browser <command> <options> | bw agent <command> <options> \
    | bw diff files|patch|refs|fetch <options> | bw linear projects|issues|issue|search <options> \
    | bw pr status <options> | bw queue list|add|edit|move|remove|clear|resume|drain <options>";

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
        Some("browser") => browser::run(&args[1..]),
        Some("agent") => agent::run(&args[1..]),
        Some("diff") => diff::run(&args[1..]),
        Some("linear") => linear::run(&args[1..]),
        Some("pr") => pr::run(&args[1..]),
        Some("queue") => queue::run(&args[1..]),
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
