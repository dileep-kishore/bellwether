use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// Writes a stand-in for `BW_PROC_ARGV`: it prints `argv` NUL-separated for any pid, or exits 1 as the real
/// reader fails for a pid it cannot read.
pub fn fake_argv(path: &Path, argv: Option<&[String]>) {
    let body = match argv {
        Some(argv) => {
            let quoted: Vec<String> = argv
                .iter()
                .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
                .collect();
            format!("printf '%s\\000' {}", quoted.join(" "))
        }
        None => "exit 1".to_string(),
    };
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// The Bellwether Chrome's argv on `profile` and `port`, as `open` starts it.
pub fn chrome_argv(profile: &Path, port: u16) -> Vec<String> {
    vec![
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
        format!("--user-data-dir={}", profile.display()),
        format!("--remote-debugging-port={port}"),
        "--remote-debugging-address=127.0.0.1".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
    ]
}
