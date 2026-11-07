//! `bw agent …`: Bellwether's agent files on the space's machine, and each new agent's extra argv.
//!
//! `ensure` writes, under `~/.local/share/bellwether/agent/`, the three browser instruction texts, the MCP
//! launcher, `claude-mcp-<window>.json` and, given a port, `ports/<window>`. `args` prints the argv one Claude
//! or Codex session adds; it changes no user setting.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::chat::args;

pub mod codex;

pub const BROWSER_MD: &str = include_str!("../../../../agent/browser.md");
pub const BROWSER_CLAUDE_MD: &str = include_str!("../../../../agent/browser-claude.md");
pub const BROWSER_CODEX_MD: &str = include_str!("../../../../agent/browser-codex.md");
pub const LAUNCHER: &str = include_str!("../../../../agent/browser-mcp");

const AGENT_DIR: &str = ".local/share/bellwether/agent";
const WARM_MARKER: &str = "warm-1.12.0";
const WARM_TIMEOUT: Duration = Duration::from_secs(25);
const NPX_FALLBACKS: [&str; 2] = ["/opt/homebrew/bin/npx", "/usr/local/bin/npx"];

/// The files `bw` embeds, with their modes; `check` compares these.
const FILES: [(&str, &str, u32); 4] = [
    ("browser.md", BROWSER_MD, 0o644),
    ("browser-claude.md", BROWSER_CLAUDE_MD, 0o644),
    ("browser-codex.md", BROWSER_CODEX_MD, 0o644),
    ("browser-mcp", LAUNCHER, 0o755),
];

const USAGE: &str = "usage: bw agent ensure --window <w> [--port <p>] [--no-warm] \
    | bw agent args --kind claude|codex --window <w> [--cwd <dir>] [--profile <p>] | bw agent warm";

pub fn dir(home: &Path) -> PathBuf {
    home.join(AGENT_DIR)
}

/// The window machine's name in file names: `hostname -s`, lower-cased, reduced to `[a-z0-9-]`, at most 32.
pub fn window_id(hostname: &str) -> String {
    let short = hostname.split('.').next().unwrap_or_default();
    let id: String = short
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
        .take(32)
        .collect();
    if id.is_empty() {
        "window".into()
    } else {
        id
    }
}

/// This machine's window id, from `hostname -s`.
pub fn this_window() -> String {
    let name = Command::new("hostname")
        .arg("-s")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    window_id(&name)
}

/// A window id as the launcher accepts it; it names files, so nothing else may pass.
fn valid_window(w: &str) -> bool {
    (1..=32).contains(&w.len())
        && w.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A Codex profile name; it names `<name>.config.toml`, so it may not be a path.
fn valid_profile(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('.')
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Writes through a temp file and a rename when the bytes or the mode differ; true when it changed anything.
fn put(path: &Path, bytes: &[u8], mode: u32) -> io::Result<bool> {
    if fs::read(path).is_ok_and(|b| b == bytes) {
        if fs::metadata(path)?.permissions().mode() & 0o777 == mode {
            return Ok(false);
        }
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        return Ok(true);
    }
    let parent = path.parent().ok_or_else(|| io::Error::other("no folder"))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.bw-{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map(|()| true)
}

fn launcher(home: &Path) -> String {
    dir(home).join("browser-mcp").display().to_string()
}

/// Writes each file whose bytes differ and returns their names; `port: None` leaves `ports/<w>` as it is.
pub fn ensure(home: &Path, window: &str, port: Option<u16>) -> Result<Vec<String>, String> {
    if !valid_window(window) {
        return Err(format!(
            "window name must be 1-32 of a-z, 0-9 and -, got {window:?}"
        ));
    }
    let d = dir(home);
    let mut files: Vec<(String, Vec<u8>, u32)> = FILES
        .iter()
        .map(|(n, t, m)| (n.to_string(), t.as_bytes().to_vec(), *m))
        .collect();
    let mcp = json!({"mcpServers": {"bw-browser": {"type": "stdio", "command": "sh",
        "args": [launcher(home), window]}}});
    files.push((
        format!("claude-mcp-{window}.json"),
        format!("{mcp}\n").into_bytes(),
        0o644,
    ));
    if let Some(p) = port {
        files.push((
            format!("ports/{window}"),
            format!("{p}\n").into_bytes(),
            0o644,
        ));
    }
    let mut changed = Vec::new();
    for (name, bytes, mode) in files {
        let path = d.join(&name);
        if put(&path, &bytes, mode).map_err(|e| format!("cannot write {}: {e}", path.display()))? {
            changed.push(name);
        }
    }
    Ok(changed)
}

/// Fetches the pinned MCP package into the npx cache once per machine, so a first session does not wait on a
/// download: `done`, `skipped` (warmed before) or `failed` (tried again on the next `ensure`).
pub fn warm(home: &Path) -> &'static str {
    let d = dir(home);
    let marker = d.join(WARM_MARKER);
    if warmed(home) {
        return "skipped";
    }
    let out_path = d.join(".warm.out");
    let Ok(out) = fs::File::create(&out_path) else {
        return "failed";
    };
    let child = Command::new("sh")
        .arg(d.join("browser-mcp"))
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    let Ok(mut child) = child else {
        return "failed";
    };
    let deadline = Instant::now() + WARM_TIMEOUT;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                // npx starts node children of its own, so the whole group goes.
                let _ = Command::new("kill")
                    .args(["-KILL", "--", &format!("-{}", child.id())])
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let version = fs::read_to_string(&out_path).unwrap_or_default();
    let _ = fs::remove_file(&out_path);
    if ok && version.contains("1.12.0") && put(&marker, version.as_bytes(), 0o644).is_ok() {
        "done"
    } else {
        "failed"
    }
}

/// True once the pinned MCP package is in this machine's npx cache.
pub fn warmed(home: &Path) -> bool {
    dir(home).join(WARM_MARKER).is_file()
}

/// `bw agent warm`: one warm at a time per machine; a second finds the first running and leaves.
fn warm_cmd(home: &Path) -> ExitCode {
    let d = dir(home);
    let lock = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&d)
        .and_then(|()| {
            fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(d.join(".warm.lock"))
        });
    let warm = match &lock {
        Ok(f) if f.try_lock().is_ok() => warm(home),
        Ok(_) => "running",
        Err(_) => "failed",
    };
    println!("{}", json!({"type": "agent-warm", "warm": warm}));
    ExitCode::SUCCESS
}

/// `ok`, `missing` (none of the embedded files there) or `outdated` (some missing or different).
pub fn check(home: &Path) -> &'static str {
    let d = dir(home);
    let found: Vec<Option<bool>> = FILES
        .iter()
        .map(|(n, t, _)| fs::read(d.join(n)).ok().map(|b| b == t.as_bytes()))
        .collect();
    if found.iter().all(Option::is_none) {
        "missing"
    } else if found.iter().all(|f| *f == Some(true)) {
        "ok"
    } else {
        "outdated"
    }
}

pub fn claude_args(home: &Path, window: &str) -> Vec<String> {
    let d = dir(home);
    vec![
        "--mcp-config".into(),
        d.join(format!("claude-mcp-{window}.json"))
            .display()
            .to_string(),
        "--allowedTools".into(),
        "mcp__bw-browser".into(),
        "--append-system-prompt-file".into(),
        d.join("browser-claude.md").display().to_string(),
    ]
}

/// A TOML basic string: JSON's escapes are TOML's, except that TOML also requires DEL escaped.
fn toml_string(s: &str) -> String {
    serde_json::to_string(s)
        .unwrap_or_default()
        .replace('\u{7f}', "\\u007f")
}

/// Each `-c` beside its value; `developer_instructions` is the effective value, a blank line, then ours,
/// because `-c` replaces the configured value at every layer.
pub fn codex_args(home: &Path, window: &str, effective: Option<&str>) -> Vec<String> {
    let instructions = match effective {
        Some(v) => format!("{v}\n\n{BROWSER_CODEX_MD}"),
        None => BROWSER_CODEX_MD.to_string(),
    };
    let server_args = format!("[{},{}]", toml_string(&launcher(home)), toml_string(window));
    [
        "mcp_servers.bw-browser.command=\"sh\"".to_string(),
        format!("mcp_servers.bw-browser.args={server_args}"),
        "mcp_servers.bw-browser.default_tools_approval_mode=\"approve\"".into(),
        "mcp_servers.bw-browser.startup_timeout_sec=60".into(),
        format!("developer_instructions={}", toml_string(&instructions)),
    ]
    .into_iter()
    .flat_map(|v| ["-c".to_string(), v])
    .collect()
}

fn executable(p: &Path) -> bool {
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Where the launcher finds `npx`: PATH, else `BW_NPX_FALLBACKS` when set, else the two Homebrew places.
fn npx_found() -> bool {
    let on_path = std::env::var_os("PATH").is_some_and(|p| {
        std::env::split_paths(&p).any(|d| !d.as_os_str().is_empty() && executable(&d.join("npx")))
    });
    on_path
        || match std::env::var("BW_NPX_FALLBACKS") {
            Ok(list) => list.split_whitespace().any(|f| executable(Path::new(f))),
            Err(_) => NPX_FALLBACKS.iter().any(|f| executable(Path::new(f))),
        }
}

pub fn run(args: &[String]) -> ExitCode {
    let rest = args.get(1..).unwrap_or_default();
    let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) else {
        return crate::chat::error("no_home", "HOME is not set");
    };
    let home = PathBuf::from(home);
    match args.first().map(String::as_str) {
        Some("ensure") => ensure_cmd(&home, rest),
        Some("args") => args_cmd(&home, rest),
        Some("warm") if rest.is_empty() => warm_cmd(&home),
        _ => crate::usage(USAGE),
    }
}

fn window_opt(opts: &args::Args) -> Result<&str, ExitCode> {
    match opts.get("window") {
        Some(w) if valid_window(w) => Ok(w),
        Some(w) => Err(crate::usage(&format!(
            "--window must be 1-32 of a-z, 0-9 and -, got {w:?}; {USAGE}"
        ))),
        None => Err(crate::usage(&format!("--window is required; {USAGE}"))),
    }
}

fn ensure_cmd(home: &Path, rest: &[String]) -> ExitCode {
    let opts = match args::parse(rest, &["no-warm"], &["window", "port"]) {
        Ok(o) => o,
        Err(e) => return crate::usage(&format!("{e}; {USAGE}")),
    };
    let window = match window_opt(&opts) {
        Ok(w) => w,
        Err(code) => return code,
    };
    let port = match opts.get("port").map(str::parse::<u16>) {
        None => None,
        Some(Ok(p)) if p > 0 => Some(p),
        Some(_) => return crate::usage(&format!("--port takes 1-65535; {USAGE}")),
    };
    let changed = match ensure(home, window, port) {
        Ok(c) => c,
        Err(e) => return crate::chat::error("write_failed", &e),
    };
    // `bw browser agent-args` has 20 s in all and a first warm may take 25, so it starts the warm itself.
    let warm = if opts.has("no-warm") {
        if warmed(home) {
            "skipped"
        } else {
            "needed"
        }
    } else {
        warm(home)
    };
    println!(
        "{}",
        json!({"type": "agent-files", "changed": changed, "warm": warm})
    );
    ExitCode::SUCCESS
}

/// The argv one Claude or Codex session adds on this machine, or the error code and reason that rule it out.
pub fn agent_args(
    home: &Path,
    kind: &str,
    window: &str,
    cwd: Option<&Path>,
    profile: Option<&str>,
) -> Result<Vec<String>, (&'static str, String)> {
    if !npx_found() {
        return Err((
            "node_missing",
            "npx not found on PATH or in /opt/homebrew/bin or /usr/local/bin: install Node".into(),
        ));
    }
    if kind == "claude" {
        return Ok(claude_args(home, window));
    }
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|h| !h.is_empty())
        .map_or_else(|| home.join(".codex"), PathBuf::from);
    match codex::effective(&codex_home, cwd, profile) {
        Ok(v) => Ok(codex_args(home, window, v.as_deref())),
        Err(e) => Err(("codex_config_unreadable", e)),
    }
}

/// The checks `bw agent args` and `bw browser agent-args` share: kind, an absolute `--cwd` when given, and a
/// profile name that cannot be a path.
pub fn check_options(kind: &str, cwd: Option<&str>, profile: Option<&str>) -> Result<(), String> {
    if !matches!(kind, "claude" | "codex") {
        return Err("--kind is claude or codex".into());
    }
    if cwd.is_some_and(|c| !Path::new(c).is_absolute()) {
        return Err("--cwd takes an absolute folder".into());
    }
    if profile.is_some_and(|p| !valid_profile(p)) {
        return Err("--profile takes a profile name".into());
    }
    Ok(())
}

fn args_cmd(home: &Path, rest: &[String]) -> ExitCode {
    let opts = match args::parse(rest, &[], &["kind", "window", "cwd", "profile"]) {
        Ok(o) => o,
        Err(e) => return crate::usage(&format!("{e}; {USAGE}")),
    };
    let window = match window_opt(&opts) {
        Ok(w) => w,
        Err(code) => return code,
    };
    let kind = opts.get("kind").unwrap_or_default();
    let (cwd, profile) = (opts.get("cwd"), opts.get("profile"));
    if let Err(e) = check_options(kind, cwd, profile) {
        return crate::usage(&format!("{e}; {USAGE}"));
    }
    match agent_args(home, kind, window, cwd.map(Path::new), profile) {
        Ok(argv) => {
            println!(
                "{}",
                json!({"type": "agent-args", "kind": kind, "argv": argv})
            );
            ExitCode::SUCCESS
        }
        Err((code, message)) => crate::chat::error(code, &message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_id_is_slugged() {
        assert_eq!(window_id("Dileeps-Mac-mini"), "dileeps-mac-mini");
        assert_eq!(window_id("macmini.local"), "macmini");
        assert_eq!(window_id("My_Host 2"), "myhost2");
        assert_eq!(window_id("a".repeat(40).as_str()), "a".repeat(32));
        assert_eq!(window_id("éé"), "window");
        assert_eq!(window_id(""), "window");
        assert!(valid_window(&window_id("Tsuki.example.org")));
    }

    #[test]
    fn toml_string_escapes_del() {
        let s = toml_string("a\u{7f}\"\n");
        let t: toml::Table = format!("v = {s}").parse().unwrap();
        assert_eq!(t["v"].as_str(), Some("a\u{7f}\"\n"));
    }

    #[test]
    fn embedded_texts_are_the_agent_folder() {
        assert!(BROWSER_CODEX_MD.contains("image(...)"));
        assert!(BROWSER_CLAUDE_MD.contains("ToolSearch"));
        assert!(LAUNCHER.starts_with("#!/bin/sh\n"));
    }
}
