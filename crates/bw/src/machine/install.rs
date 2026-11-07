//! `bw machine install <machine> [--force]`: copies the helper there in parts, checks its SHA-256 there, then
//! links `current` to it. A failed install leaves no part behind and `current` where it was.

use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{source_for, status, Source, State, HELPER_DIR, VERSION};
use crate::hc::{hc_exec, hc_write};

/// hc takes at most 8 MB a write; each part stays under this.
pub const MAX_WRITE: usize = 6 * 1024 * 1024;

/// Joins the parts and prints the joined file's SHA-256. $1 folder under $HOME, $2 tag, then the part names.
const JOIN: &str = r#"cd "$HOME/$1" && t=$2 && shift 2 && cat "$@" > "bw.$t.new" && rm -f "$@" && { sha256sum "bw.$t.new" 2>/dev/null || shasum -a 256 "bw.$t.new"; }"#;
/// $1 folder under $HOME, $2 version, $3 tag. `mv` replaces bw in one step, so a running copy never sees half a file.
const LINK: &str = r#"set -e; cd "$HOME/$1"; chmod 755 "bw.$3.new"; mv -f "bw.$3.new" bw; cd ..; ln -sfn "$2" current"#;
/// $1 folder under $HOME, $2 tag, $3 version. The folder goes only when nothing else is in it (an older bw stays).
const CLEAN: &str = r#"cd "$HOME/$1" 2>/dev/null || exit 0; rm -f "bw.$2.new" "bw.$2".part*; cd .. && rmdir "$3" 2>/dev/null; exit 0"#;

struct Fail {
    code: &'static str,
    message: String,
    extra: Value,
}

fn fail(code: &'static str, message: impl Into<String>) -> Fail {
    Fail {
        code,
        message: message.into(),
        extra: json!({}),
    }
}

pub fn run(machine: &str, force: bool) -> ExitCode {
    let emit = |v: Value| println!("{v}");
    match install(machine, force, &emit) {
        Ok(done) => {
            emit(done);
            ExitCode::SUCCESS
        }
        Err(f) => {
            let mut v =
                json!({"type": "error", "code": f.code, "message": f.message, "machine": machine});
            if let (Some(v), Some(x)) = (v.as_object_mut(), f.extra.as_object()) {
                v.extend(x.clone());
            }
            emit(v);
            ExitCode::FAILURE
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The sum `SHA256SUMS` beside `file` gives for it. None: not listed once with 64 hex digits.
fn listed_sum(file: &Path) -> Option<String> {
    let name = file.file_name()?.to_str()?;
    let text = std::fs::read_to_string(file.with_file_name("SHA256SUMS")).ok()?;
    let found: Vec<&str> = text
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let (sum, n) = (it.next()?, it.next()?);
            let n = n.trim_start_matches('*');
            (n.strip_prefix("./").unwrap_or(n) == name).then_some(sum)
        })
        .collect();
    match found.as_slice() {
        [sum] if sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(sum.to_ascii_lowercase())
        }
        _ => None,
    }
}

fn read_source(source: &Source) -> Result<(Vec<u8>, String), Fail> {
    let path = source.path();
    let bytes = std::fs::read(path)
        .map_err(|e| fail("no_build", format!("cannot read {}: {e}", path.display())))?;
    let sum = sha256_hex(&bytes);
    if let Source::Dist(_) = source {
        if listed_sum(path).as_deref() != Some(sum.as_str()) {
            return Err(fail(
                "sha_mismatch",
                format!(
                    "{} does not match the SHA256SUMS beside it; run scripts/build-dist.sh again",
                    path.display()
                ),
            ));
        }
    }
    Ok((bytes, sum))
}

fn progress(emit: &dyn Fn(Value), step: &str) {
    emit(json!({"type": "progress", "step": step}));
}

fn install(machine: &str, force: bool, emit: &dyn Fn(Value)) -> Result<Value, Fail> {
    progress(emit, "uname");
    let s = status(machine);
    let uname = s.uname.clone().unwrap_or_default();
    match s.state {
        State::Unreachable => {
            return Err(fail(
                "unreachable",
                s.message
                    .unwrap_or_else(|| format!("{machine} did not answer")),
            ))
        }
        State::Current if !force => {
            return Ok(
                json!({"type": "installed", "machine": machine, "version": VERSION, "already": true}),
            )
        }
        _ => {}
    }
    let no_build = |why: String| Fail {
        extra: json!({"target": s.target, "uname": uname}),
        ..fail("no_build", why)
    };
    let Some(target) = s.target else {
        return Err(no_build(format!(
            "no build of bw runs on {machine} ({})",
            if uname.is_empty() { "no uname" } else { &uname }
        )));
    };
    let Some(source) = source_for(target) else {
        return Err(no_build(format!(
            "this machine has no bw built for {target}; run scripts/build-dist.sh"
        )));
    };
    let (bytes, sum) = read_source(&source)?;

    let dir = format!("{HELPER_DIR}/{VERSION}");
    let tag = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos())
    );
    let clean = || {
        let _ = hc_exec(machine, &["sh", "-c", CLEAN, "sh", &dir, &tag, VERSION]);
    };
    let chunks: Vec<&[u8]> = bytes.chunks(MAX_WRITE).collect();
    let names: Vec<String> = (1..=chunks.len())
        .map(|n| format!("bw.{tag}.part{n}"))
        .collect();
    for (i, (chunk, name)) in chunks.iter().zip(&names).enumerate() {
        if let Err(e) = hc_write(machine, &format!("{dir}/{name}"), chunk) {
            clean();
            return Err(fail("write_failed", format!("copying to {machine}: {e}")));
        }
        emit(json!({"type": "progress", "step": "copy", "part": i + 1, "parts": chunks.len()}));
    }

    progress(emit, "verify");
    let mut join = vec!["sh", "-c", JOIN, "sh", &dir, &tag];
    join.extend(names.iter().map(String::as_str));
    let there = match hc_exec(machine, &join) {
        Ok(out) if out.code == Some(0) => String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase(),
        Ok(out) => {
            clean();
            return Err(fail(
                "write_failed",
                format!(
                    "joining the parts on {machine} exited {}",
                    out.code.map_or("?".into(), |c| c.to_string())
                ),
            ));
        }
        Err(e) => {
            clean();
            return Err(fail(
                "write_failed",
                format!("joining the parts on {machine}: {e}"),
            ));
        }
    };
    if there != sum {
        clean();
        return Err(Fail {
            extra: json!({"expected": sum, "actual": there}),
            ..fail(
                "sha_mismatch",
                format!("the helper arrived changed on {machine}; nothing was installed"),
            )
        });
    }

    progress(emit, "link");
    match hc_exec(machine, &["sh", "-c", LINK, "sh", &dir, VERSION, &tag]) {
        Ok(out) if out.code == Some(0) => {}
        other => {
            clean();
            let why = match other {
                Ok(out) => format!("exit {}", out.code.map_or("?".into(), |c| c.to_string())),
                Err(e) => e.to_string(),
            };
            return Err(fail(
                "write_failed",
                format!("linking current on {machine}: {why}"),
            ));
        }
    }
    Ok(json!({
        "type": "installed",
        "machine": machine,
        "version": VERSION,
        "target": target,
        "sha256": sum,
        "bytes": bytes.len(),
        "parts": chunks.len(),
    }))
}
