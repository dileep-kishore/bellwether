use std::process::ExitCode;

use serde_json::json;

mod chat;
mod hc;
mod machine;
mod version;

const USAGE: &str =
    "usage: bw version | bw machine status <machine> | bw machine install <machine> [--force] \
    | bw feed|locate|send|picture|picture-read <options>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version") => {
            println!("{}", version::version_json());
            ExitCode::SUCCESS
        }
        Some("machine") => machine::run(&args[1..]),
        Some(cmd @ ("feed" | "locate" | "send" | "picture" | "picture-read")) => {
            chat::run(cmd, &args[1..])
        }
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
