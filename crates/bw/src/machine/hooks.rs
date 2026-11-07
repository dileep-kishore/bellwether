//! `bw hooks` and `bw machine setup`: Bellwether's hook groups in Claude's and Codex's settings.
//!
//! Each group runs `hooks/bw-event`, which only records events. Groups are appended after every existing
//! group, and only groups whose every command starts with `MARKER` are ever changed or removed. Codex's
//! `config.toml` is read, never written: trusting the hook is the user's step in Codex.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::chat::args;
use crate::events::EVENTS;
use crate::hc::{hc_exec, HcError};

pub const MARKER: &str = ": bellwether-hook=1;";
pub const SCRIPT: &str = include_str!("../../../../hooks/bw-event");
const DATA_DIR: &str = ".local/share/bellwether";

const USAGE: &str =
    "usage: bw hooks check|diff|apply [--expect-sha <claude sha>,<codex sha>]|remove \
    [--claude-settings <file>] [--codex-hooks <file>]";
const SETUP_USAGE: &str = "usage: bw machine setup <machine|local> \
    --check|--diff|--apply [--expect-sha <claude>,<codex>]|--remove|--agent";

pub struct Targets {
    pub claude: PathBuf,
    pub codex: PathBuf,
    /// Beside the Codex hooks file, where Codex records which hooks the user trusted.
    pub codex_config: PathBuf,
    pub script: PathBuf,
    /// `~/.local/share/bellwether`: backups and the install record.
    pub data: PathBuf,
    /// Where `bw agent ensure` writes the agent files.
    pub home: PathBuf,
}

/// The files to edit: a flag, else `$CLAUDE_CONFIG_DIR` or `$CODEX_HOME`, else the agent's folder in `home`.
pub fn targets(
    claude: Option<&str>,
    codex: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
) -> Targets {
    let var = |k: &str| env(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let absolute = |p: PathBuf| {
        if p.is_absolute() {
            p
        } else {
            std::env::current_dir().unwrap_or_default().join(p)
        }
    };
    let claude = claude.map(PathBuf::from).unwrap_or_else(|| {
        var("CLAUDE_CONFIG_DIR")
            .unwrap_or_else(|| home.join(".claude"))
            .join("settings.json")
    });
    let codex = codex.map(PathBuf::from).unwrap_or_else(|| {
        var("CODEX_HOME")
            .unwrap_or_else(|| home.join(".codex"))
            .join("hooks.json")
    });
    let codex = absolute(codex);
    let data = home.join(DATA_DIR);
    Targets {
        claude: absolute(claude),
        codex_config: codex.with_file_name("config.toml"),
        codex,
        script: data.join("hooks/bw-event"),
        data,
        home: home.to_path_buf(),
    }
}

fn command(kind: &str) -> String {
    format!(r#"{MARKER} sh "$HOME/.local/share/bellwether/hooks/bw-event" {kind}"#)
}

/// Bellwether's group for one event: Claude's tool events take `"*"`; Codex groups have no matcher.
fn group(kind: &str, event: &str) -> Value {
    let hook = json!({"type": "command", "command": command(kind), "timeout": 5});
    if kind == "claude" && matches!(event, "PermissionRequest" | "PreToolUse") {
        json!({"matcher": "*", "hooks": [hook]})
    } else {
        json!({"hooks": [hook]})
    }
}

/// A group of Bellwether's: every hook in it is marked. A group the user mixed with their own is theirs.
fn is_ours(g: &Value) -> bool {
    g["hooks"].as_array().is_some_and(|hooks| {
        !hooks.is_empty()
            && hooks
                .iter()
                .all(|h| h["command"].as_str().is_some_and(|c| c.starts_with(MARKER)))
    })
}

/// The settings as an object whose `hooks`, when present, is an object; a missing file reads as `{}`.
fn parse(current: Option<&str>) -> Result<Value, String> {
    let v: Value = match current {
        None => json!({}),
        Some(text) => serde_json::from_str(text).map_err(|e| e.to_string())?,
    };
    if !v.is_object() {
        return Err("the file is not a JSON object".into());
    }
    if !matches!(v.get("hooks"), None | Some(Value::Object(_))) {
        return Err("\"hooks\" is not an object".into());
    }
    Ok(v)
}

fn render(v: &Value) -> String {
    let mut text = serde_json::to_string_pretty(v).unwrap_or_default();
    text.push('\n');
    text
}

/// The settings text with Bellwether's groups in place; `current` itself when they already are.
pub fn planned(kind: &str, current: Option<&str>) -> Result<String, String> {
    let mut v = parse(current)?;
    let before = v.clone();
    let hooks = v
        .as_object_mut()
        .and_then(|o| {
            o.entry("hooks")
                .or_insert_with(|| json!({}))
                .as_object_mut()
        })
        .ok_or("\"hooks\" is not an object")?;
    for event in EVENTS {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("\"hooks.{event}\" is not a list"))?;
        let want = group(kind, event);
        let marked: Vec<&Value> = groups.iter().filter(|g| is_ours(g)).collect();
        if marked == [&want] {
            continue;
        }
        groups.retain(|g| !is_ours(g));
        groups.push(want);
    }
    match current {
        Some(text) if v == before => Ok(text.to_string()),
        _ => Ok(render(&v)),
    }
}

/// The settings text without Bellwether's groups, and without the event lists and `hooks` object that held
/// only them; `current` itself when there were none.
pub fn removed(current: &str) -> Result<String, String> {
    let mut v = parse(Some(current))?;
    let before = v.clone();
    if let Some(hooks) = v.get_mut("hooks").and_then(Value::as_object_mut) {
        let had = !hooks.is_empty();
        let mut emptied = Vec::new();
        for (event, groups) in hooks.iter_mut() {
            if let Some(groups) = groups.as_array_mut() {
                let n = groups.len();
                groups.retain(|g| !is_ours(g));
                if n > 0 && groups.is_empty() {
                    emptied.push(event.clone());
                }
            }
        }
        for event in emptied {
            hooks.shift_remove(&event);
        }
        if had && hooks.is_empty() {
            v.as_object_mut().map(|o| o.shift_remove("hooks"));
        }
    }
    Ok(if v == before {
        current.to_string()
    } else {
        render(&v)
    })
}

/// A unified diff of the change; empty when there is none.
pub fn diff(path: &Path, old: &str, new: &str) -> String {
    if old == new {
        return String::new();
    }
    let name = path.display().to_string();
    similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&name, &name)
        .to_string()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), sorted(&o[k])))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn snake(event: &str) -> String {
    let mut out = String::new();
    for (i, c) in event.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// The `trusted_hash` Codex 0.167 records for a one-hook group once the user trusts it: the SHA-256 of the
/// compact, key-sorted JSON of the event, the group's matcher and the hook with `async` and `timeout` filled in
/// (Codex's `hook_hash`; tests/fixtures/hooks/codex-trusted-hash.json is the known answer). Only compared.
fn trusted_hash(event: &str, g: &Value) -> String {
    let mut hook = g["hooks"][0].as_object().cloned().unwrap_or_default();
    hook.entry("async").or_insert(json!(false));
    hook.entry("timeout").or_insert(json!(600));
    let mut identity = Map::new();
    identity.insert("event_name".into(), json!(snake(event)));
    if let Some(m) = g.get("matcher") {
        identity.insert("matcher".into(), m.clone());
    }
    identity.insert("hooks".into(), json!([hook]));
    let text = serde_json::to_string(&sorted(&Value::Object(identity))).unwrap_or_default();
    format!("sha256:{}", hex(text.as_bytes()))
}

fn read_text(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(b) => String::from_utf8(b)
            .map(Some)
            .map_err(|_| "not UTF-8 text".to_string()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// `ok`, `missing` (no group of ours) or `outdated` (some group of ours differs, or the script does).
fn state(kind: &str, settings: Option<&Value>, script_ok: bool) -> &'static str {
    let Some(hooks) = settings.and_then(|v| v["hooks"].as_object()) else {
        return "missing";
    };
    let ours = |groups: &Value| -> Vec<Value> {
        groups
            .as_array()
            .map(|a| a.iter().filter(|g| is_ours(g)).cloned().collect())
            .unwrap_or_default()
    };
    if hooks.values().all(|g| ours(g).is_empty()) {
        return "missing";
    }
    let current = hooks.iter().all(|(event, groups)| {
        let want = EVENTS.contains(&event.as_str()).then(|| group(kind, event));
        ours(groups) == want.into_iter().collect::<Vec<_>>()
    }) && EVENTS.iter().all(|e| hooks.contains_key(*e));
    if current && script_ok {
        "ok"
    } else {
        "outdated"
    }
}

/// Each of Bellwether's Codex groups whose `trusted_hash` in `config.toml` is not the one Codex would record.
fn untrusted(t: &Targets, hooks: &Value) -> Vec<Value> {
    let config: toml::Table = fs::read_to_string(&t.codex_config)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_default();
    let state = config
        .get("hooks")
        .and_then(|h| h.get("state"))
        .and_then(toml::Value::as_table);
    let mut out = Vec::new();
    for event in EVENTS {
        let want = group("codex", event);
        let index = hooks["hooks"][event]
            .as_array()
            .and_then(|a| a.iter().position(|g| *g == want))
            .unwrap_or(0);
        let key = format!("{}:{}:{index}:0", t.codex.display(), snake(event));
        let entry = state.and_then(|s| s.get(&key));
        let found = entry
            .and_then(|e| e.get("trusted_hash"))
            .and_then(toml::Value::as_str);
        let enabled = entry
            .and_then(|e| e.get("enabled"))
            .and_then(toml::Value::as_bool)
            .unwrap_or(true);
        let expected = trusted_hash(event, &want);
        if found != Some(expected.as_str()) || !enabled {
            out.push(json!({"event": event, "key": key, "expected": expected, "found": found}));
        }
    }
    out
}

/// `{"type":"hooks","claude","codex","agent"}`; with `codex_trust` listing the untrusted groups when Codex's are.
pub fn check(t: &Targets) -> Value {
    let script_ok = fs::read(&t.script).is_ok_and(|b| b == SCRIPT.as_bytes());
    let load = |p: &Path| {
        read_text(p)
            .ok()
            .flatten()
            .and_then(|s| parse(Some(&s)).ok())
    };
    let claude = state("claude", load(&t.claude).as_ref(), script_ok);
    let codex_settings = load(&t.codex);
    let mut codex = state("codex", codex_settings.as_ref(), script_ok);
    let mut trust = Vec::new();
    if let (Some(v), "ok") = (&codex_settings, codex) {
        trust = untrusted(t, v);
        if !trust.is_empty() {
            codex = "untrusted";
        }
    }
    let agent = crate::agent::check(&t.home);
    let mut line = json!({"type": "hooks", "claude": claude, "codex": codex, "agent": agent});
    if !trust.is_empty() {
        line["codex_trust"] = json!(trust);
    }
    line
}

struct Plan {
    agent: &'static str,
    path: PathBuf,
    before: Option<String>,
    after: Option<String>,
}

impl Plan {
    fn changed(&self) -> bool {
        self.after.is_some() && self.after != self.before
    }

    fn sha(&self) -> String {
        self.before
            .as_deref()
            .map_or_else(String::new, |b| hex(b.as_bytes()))
    }
}

/// Both files' changes, or the refusal that leaves both untouched.
fn plans(t: &Targets, remove: bool) -> Result<[Plan; 2], ExitCode> {
    let plan = |agent: &'static str, path: &Path| -> Result<Plan, ExitCode> {
        let refuse = |e: String| {
            let message = format!("cannot read {}: {e}; nothing changed", path.display());
            crate::chat::error("unreadable", &message)
        };
        let before = read_text(path).map_err(refuse)?;
        let after = match (remove, &before) {
            (true, None) => None,
            (true, Some(text)) => Some(removed(text).map_err(refuse)?),
            (false, text) => Some(planned(agent, text.as_deref()).map_err(refuse)?),
        };
        Ok(Plan {
            agent,
            path: path.to_path_buf(),
            before,
            after,
        })
    };
    let claude = plan("claude", &t.claude)?;
    Ok([claude, plan("codex", &t.codex)?])
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn private_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

/// Replaces the file a path names (through a symlink, so a linked dotfile stays linked) with a temp file
/// renamed over it, keeping its mode.
fn write_atomic(path: &Path, text: &[u8], new_mode: u32) -> io::Result<()> {
    let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = real.parent().ok_or_else(|| io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let mode = fs::metadata(&real).map_or(new_mode, |m| m.permissions().mode() & 0o7777);
    let name = real.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.bw-{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&tmp)?;
        f.write_all(text)?;
        f.sync_all()?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        fs::rename(&tmp, &real)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Copies the file as it was to `backups/<name>.<at_ms>`, then writes the new text and the install record.
fn commit(t: &Targets, p: &Plan, action: &str) -> io::Result<Option<PathBuf>> {
    let at_ms = now_ms();
    let mut backup = None;
    if let Some(before) = &p.before {
        let dir = t.data.join("backups");
        private_dir(&dir)?;
        let name = p.path.file_name().unwrap_or_default().to_string_lossy();
        let mut file = dir.join(format!("{name}.{at_ms}"));
        if file.exists() {
            file = dir.join(format!("{name}.{at_ms}.{}", p.agent));
        }
        write_atomic(&file, before.as_bytes(), 0o600)?;
        backup = Some(file);
    }
    let after = p.after.as_deref().unwrap_or_default();
    write_atomic(&p.path, after.as_bytes(), 0o600)?;
    let record_file = t.data.join("hooks/installed.json");
    let mut record = fs::read(&record_file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    record[p.agent] = json!({
        "version": super::VERSION,
        "action": action,
        "path": p.path,
        "sha256_before": p.sha(),
        "sha256_after": hex(after.as_bytes()),
        "at_ms": at_ms,
    });
    private_dir(record_file.parent().unwrap_or(&t.data))?;
    write_atomic(&record_file, render(&record).as_bytes(), 0o600)?;
    Ok(backup)
}

fn write_failed(p: &Plan, e: &io::Error) -> ExitCode {
    crate::chat::error(
        "write_failed",
        &format!("cannot write {}: {e}", p.path.display()),
    )
}

pub fn run(args: &[String]) -> ExitCode {
    let sub = args.first().map(String::as_str).unwrap_or_default();
    let opts = match args::parse(
        args.get(1..).unwrap_or_default(),
        &[],
        &["claude-settings", "codex-hooks", "expect-sha"],
    ) {
        Ok(o) => o,
        Err(e) => return crate::usage(&format!("{e}; {USAGE}")),
    };
    let expect = match (sub, opts.get("expect-sha")) {
        (_, None) => None,
        ("apply", Some(s)) => match s.split(',').collect::<Vec<_>>()[..] {
            [a, b] => Some([a.to_string(), b.to_string()]),
            _ => return crate::usage(&format!("--expect-sha takes two hashes; {USAGE}")),
        },
        _ => return crate::usage(&format!("--expect-sha goes with apply; {USAGE}")),
    };
    let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) else {
        return crate::chat::error("no_home", "HOME is not set");
    };
    let env = |k: &str| std::env::var(k).ok();
    let t = targets(
        opts.get("claude-settings"),
        opts.get("codex-hooks"),
        &env,
        Path::new(&home),
    );
    match sub {
        "check" => {
            println!("{}", check(&t));
            ExitCode::SUCCESS
        }
        "diff" => {
            let plans = match plans(&t, false) {
                Ok(p) => p,
                Err(code) => return code,
            };
            for p in &plans {
                let old = p.before.as_deref().unwrap_or_default();
                let new = p.after.as_deref().unwrap_or_default();
                println!(
                    "{}",
                    json!({"type": "hooks-diff", "agent": p.agent, "path": p.path, "sha256": p.sha(),
                        "changed": p.changed(), "diff": diff(&p.path, old, new)})
                );
            }
            ExitCode::SUCCESS
        }
        "apply" | "remove" => apply(&t, sub == "remove", expect),
        _ => crate::usage(USAGE),
    }
}

fn apply(t: &Targets, remove: bool, expect: Option<[String; 2]>) -> ExitCode {
    let plans = match plans(t, remove) {
        Ok(p) => p,
        Err(code) => return code,
    };
    if let Some(expect) = expect {
        for (p, want) in plans.iter().zip(expect) {
            if p.sha() != want {
                let message = format!(
                    "{} changed since the diff; nothing changed",
                    p.path.display()
                );
                return crate::chat::error("changed_since_diff", &message);
            }
        }
    }
    // The script goes first, so no group ever names a script that is not there.
    if !remove && fs::read(&t.script).ok().as_deref() != Some(SCRIPT.as_bytes()) {
        if let Err(e) = write_atomic(&t.script, SCRIPT.as_bytes(), 0o755)
            .and_then(|()| fs::set_permissions(&t.script, fs::Permissions::from_mode(0o755)))
        {
            let message = format!("cannot write {}: {e}", t.script.display());
            return crate::chat::error("write_failed", &message);
        }
    }
    for p in &plans {
        let mut backup = None;
        if p.changed() {
            match commit(t, p, if remove { "remove" } else { "apply" }) {
                Ok(b) => backup = b,
                Err(e) => return write_failed(p, &e),
            }
        }
        let line = if remove {
            json!({"type": "hooks-removed", "agent": p.agent, "path": p.path, "changed": p.changed()})
        } else {
            json!({"type": "hooks-applied", "agent": p.agent, "path": p.path, "changed": p.changed(),
                "backup": backup})
        };
        println!("{line}");
    }
    ExitCode::SUCCESS
}

/// `bw machine setup <machine|local> --check|--diff|--apply|--remove`: `bw hooks` on that machine, its lines
/// relayed as they are; `local` runs it here. `--agent` runs `bw agent ensure` there instead, with this
/// machine's window id.
pub fn setup(args: &[String]) -> ExitCode {
    let Some(machine) = args
        .first()
        .filter(|m| !m.is_empty() && !m.starts_with('-'))
    else {
        return crate::usage(SETUP_USAGE);
    };
    const OPS: [&str; 5] = ["check", "diff", "apply", "remove", "agent"];
    let opts = match args::parse(&args[1..], &OPS, &["expect-sha"]) {
        Ok(o) => o,
        Err(e) => return crate::usage(&format!("{e}; {SETUP_USAGE}")),
    };
    let ops: Vec<&str> = OPS.into_iter().filter(|o| opts.has(o)).collect();
    let [op] = ops[..] else {
        let message = if ops.contains(&"agent") {
            format!("--agent goes alone; {SETUP_USAGE}")
        } else {
            SETUP_USAGE.to_string()
        };
        return crate::usage(&message);
    };
    let (cmd, mut sub) = if op == "agent" {
        let window = crate::agent::this_window();
        (
            "agent",
            vec!["ensure".to_string(), "--window".into(), window],
        )
    } else {
        ("hooks", vec![op.to_string()])
    };
    if let Some(sha) = opts.get("expect-sha") {
        if op != "apply" {
            let message = if op == "agent" {
                format!("--expect-sha goes with --apply, not --agent; {SETUP_USAGE}")
            } else {
                format!("--expect-sha goes with --apply; {SETUP_USAGE}")
            };
            return crate::usage(&message);
        }
        sub.extend(["--expect-sha".to_string(), sha.to_string()]);
    }
    if machine == "local" {
        return if cmd == "agent" {
            crate::agent::run(&sub)
        } else {
            run(&sub)
        };
    }
    let mut argv = vec!["sh", "-c", super::RUN_HELPER, "sh", cmd];
    argv.extend(sub.iter().map(String::as_str));
    let no_helper = || {
        let message =
            format!("Bellwether's helper is not on {machine}; run bw machine install {machine}");
        crate::chat::error("no_helper", &message)
    };
    let out = match hc_exec(machine, &argv) {
        Ok(out) => out,
        Err(HcError::NoProgram(_)) => return no_helper(),
        Err(e) => return crate::chat::error("unreachable", &e.to_string()),
    };
    if matches!(out.code, Some(126 | 127)) {
        return no_helper();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        let message = format!("bw {cmd} {} on {machine} printed nothing", sub[0]);
        return crate::chat::error("failed", &message);
    }
    for l in lines {
        println!("{l}");
    }
    match out.code {
        Some(0) => ExitCode::SUCCESS,
        Some(2) => ExitCode::from(2),
        _ => ExitCode::from(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_hash_matches_what_codex_wrote() {
        let known: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/hooks/codex-trusted-hash.json"
        ))
        .unwrap();
        for k in known["hooks"].as_array().unwrap() {
            let event = k["event"].as_str().unwrap();
            let g = group("codex", event);
            assert_eq!(g["hooks"][0]["command"], k["command"]);
            assert_eq!(trusted_hash(event, &g), k["trusted_hash"], "{event}");
        }
    }

    #[test]
    fn snake_case_events() {
        assert_eq!(snake("PreToolUse"), "pre_tool_use");
        assert_eq!(snake("SubagentStop"), "subagent_stop");
    }

    #[test]
    fn script_is_the_repository_hook() {
        assert!(SCRIPT.starts_with("#!/bin/sh\n"));
        assert!(SCRIPT.contains("event --agent"));
    }
}
