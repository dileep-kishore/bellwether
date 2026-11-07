//! `bw picture` (window machine) copies one picture from a terminal's session log into Herdr's app home, where
//! `image()` can draw it; `bw picture-read` (the space's machine) reads it out of the log that terminal's cache
//! remembers. The picture's digest is its name, so each picture is copied once.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::SystemTime;

use herdr_core::log_image::{self, Format};
use serde_json::{json, Value};

use super::{args, cache};
use crate::hc::{hc_exec, HcError};
use crate::machine::RUN_HELPER;

/// Largest picture copied, in decoded bytes.
pub const MAX_PICTURE: usize = 4 * 1024 * 1024;
/// Where pictures go, relative to the app home; `image()` takes paths relative to it.
const PICTURES: &str = "data/bellwether/pictures";
const FORMATS: [Format; 4] = [Format::Png, Format::Jpeg, Format::Webp, Format::Gif];

const USAGE: &str =
    "usage: bw picture --terminal <[machine/]t> --offset <n> --index <i> --digest <16 hex> \
    | bw picture-read --terminal <t> --offset <n> --index <i> --digest <16 hex>";

/// One picture of a terminal's log: the line at `offset`, the `index`th picture in it, with fingerprint `digest`.
struct Want {
    machine: Option<String>,
    terminal: String,
    offset: u64,
    index: usize,
    digest: String,
}

impl Want {
    fn fingerprint(&self) -> u64 {
        u64::from_str_radix(&self.digest, 16).unwrap_or_default()
    }

    fn state(&self, state: &str) -> Value {
        json!({"type": "picture", "digest": self.digest, "state": state})
    }

    fn too_big(&self, bytes: usize) -> Value {
        json!({"type": "picture", "digest": self.digest, "state": "too_big", "bytes": bytes})
    }
}

fn parse(argv: &[String], remote_ok: bool) -> Result<Want, String> {
    let a = args::parse(argv, &[], &["terminal", "offset", "index", "digest"])?;
    let need = |name: &str| a.get(name).ok_or_else(|| format!("--{name} is required"));
    let address = need("terminal")?;
    let (machine, terminal) = match address.split_once('/') {
        Some((m, t)) if remote_ok && !m.is_empty() && !t.is_empty() && !t.contains('/') => {
            (Some(m.to_string()), t.to_string())
        }
        None => (None, address.to_string()),
        Some(_) => return Err(format!("bad terminal {address:?}")),
    };
    let offset = need("offset")?;
    let offset = offset
        .parse()
        .map_err(|_| format!("--offset {offset:?} is not a byte offset"))?;
    let index = need("index")?;
    let index = index
        .parse()
        .map_err(|_| format!("--index {index:?} is not a number"))?;
    let digest = need("digest")?;
    // It names a file, so only the digest's own shape gets through.
    if digest.len() != 16
        || !digest
            .bytes()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(format!(
            "--digest {digest:?} is not 16 lower-case hex digits"
        ));
    }
    Ok(Want {
        machine,
        terminal,
        offset,
        index,
        digest: digest.to_string(),
    })
}

enum Got {
    Data {
        format: Format,
        bytes: Vec<u8>,
        base64: String,
    },
    TooBig(usize),
    Gone,
}

/// The log line that starts at `offset`, without its newline; none unless a line starts there.
fn line_at(path: &Path, offset: u64) -> Option<Vec<u8>> {
    let mut f = fs::File::open(path).ok()?;
    if offset > 0 {
        f.seek(SeekFrom::Start(offset - 1)).ok()?;
        let mut one = [0u8; 1];
        if f.read(&mut one).ok()? != 1 || one[0] != b'\n' {
            return None;
        }
    }
    let mut line = Vec::new();
    let mut chunk = vec![0u8; 1 << 20];
    while line.len() < log_image::MAX_LINE {
        let n = f.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        if let Some(nl) = chunk[..n].iter().position(|&c| c == b'\n') {
            line.extend_from_slice(&chunk[..nl]);
            return Some(line);
        }
        line.extend_from_slice(&chunk[..n]);
    }
    (!line.is_empty()).then_some(line)
}

/// Checks a picture's base64 text against the digest the feed gave, then its size and header.
fn check(base64: String, digest: u64) -> Got {
    if log_image::fingerprint(&base64) != digest {
        return Got::Gone;
    }
    let Some(bytes) = log_image::decode(base64.as_bytes()) else {
        return Got::Gone;
    };
    if bytes.len() > MAX_PICTURE {
        return Got::TooBig(bytes.len());
    }
    match log_image::header(&bytes) {
        Some((format, _, _)) => Got::Data {
            format,
            bytes,
            base64,
        },
        None => Got::Gone,
    }
}

fn read_log(path: &Path, w: &Want) -> Got {
    line_at(path, w.offset)
        .and_then(|line| log_image::base64_at(&line, w.index))
        .map_or(Got::Gone, |b64| check(b64, w.fingerprint()))
}

/// Reads the picture from the log this machine's cache remembers for the terminal.
fn read_here(w: &Want) -> Got {
    match cache::read(&cache::terminal_file(&w.terminal)).root {
        Some(root) => read_log(Path::new(&root.path), w),
        None => Got::Gone,
    }
}

pub fn run_read(argv: &[String]) -> ExitCode {
    let w = match parse(argv, false) {
        Ok(w) => w,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let line = match read_here(&w) {
        // The log's own base64 text goes out, so the window can check its fingerprint again.
        Got::Data {
            format,
            bytes,
            base64,
        } => json!({
            "type": "picture-data",
            "digest": w.digest,
            "format": log_image::format_raw(format),
            "bytes": bytes.len(),
            "base64": base64,
        }),
        Got::TooBig(n) => w.too_big(n),
        Got::Gone => w.state("gone"),
    };
    println!("{line}");
    ExitCode::SUCCESS
}

enum Fetch {
    Got(Got),
    Unreachable,
    Failed(&'static str, String),
}

/// Runs `bw picture-read` on `machine` through its installed helper.
fn read_there(machine: &str, w: &Want) -> Fetch {
    let (offset, index) = (w.offset.to_string(), w.index.to_string());
    let argv = [
        "sh",
        "-c",
        RUN_HELPER,
        "bw",
        "picture-read",
        "--terminal",
        &w.terminal,
        "--offset",
        &offset,
        "--index",
        &index,
        "--digest",
        &w.digest,
    ];
    let out = match hc_exec(machine, &argv) {
        Ok(out) => out,
        Err(HcError::Unreachable(_)) => return Fetch::Unreachable,
        Err(HcError::NoProgram(m)) => return Fetch::Failed("missing", m),
        Err(e) => return Fetch::Failed("failed", e.to_string()),
    };
    if matches!(out.code, Some(126 | 127)) {
        return Fetch::Failed(
            "missing",
            format!("the Bellwether helper is not installed on {machine}"),
        );
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .next()
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .unwrap_or(Value::Null);
    let bad = |why: &str| Fetch::Failed("bad_output", format!("{machine}'s helper {why}"));
    match (line["type"].as_str(), line["state"].as_str()) {
        _ if line["type"] == "error" => Fetch::Failed(
            "failed",
            format!(
                "{machine}: {}",
                line["message"].as_str().unwrap_or("picture-read failed")
            ),
        ),
        _ if line["digest"] != w.digest.as_str() => bad("answered for another picture"),
        (Some("picture-data"), _) => {
            let Some(b64) = line["base64"].as_str() else {
                return bad("sent no base64");
            };
            match check(b64.to_string(), w.fingerprint()) {
                Got::Data { format, .. } if line["format"] != log_image::format_raw(format) => {
                    bad("named the wrong format")
                }
                Got::Gone => bad("sent a picture that does not match its digest"),
                got => Fetch::Got(got),
            }
        }
        (Some("picture"), Some("too_big")) => match line["bytes"].as_u64() {
            Some(n) => Fetch::Got(Got::TooBig(n as usize)),
            None => bad("sent too_big without a size"),
        },
        (Some("picture"), Some("gone")) => Fetch::Got(Got::Gone),
        _ => bad("printed something other than a picture"),
    }
}

/// `$HERDR_APP_HOME`, else `~/.config/herdr-app`.
fn app_home() -> PathBuf {
    if let Some(d) = std::env::var_os("HERDR_APP_HOME").filter(|d| !d.is_empty()) {
        return d.into();
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config/herdr-app")
}

fn copied(w: &Want, format: Format, bytes: u64) -> Value {
    json!({
        "type": "picture",
        "digest": w.digest,
        "file": format!("{PICTURES}/{}.{}", w.digest, log_image::format_raw(format)),
        "bytes": bytes,
    })
}

/// A copy made earlier: its format and size, after touching it so pruning keeps a picture still shown.
fn earlier(dir: &Path, digest: &str) -> Option<(Format, u64)> {
    FORMATS.into_iter().find_map(|format| {
        let file = dir.join(format!("{digest}.{}", log_image::format_raw(format)));
        let meta = fs::metadata(&file).ok().filter(fs::Metadata::is_file)?;
        if let Ok(f) = fs::File::options().write(true).open(&file) {
            let _ = f.set_modified(SystemTime::now());
        }
        Some((format, meta.len()))
    })
}

/// Writes a temp file beside the picture and renames it over, so Herdr never draws half a picture.
fn write_picture(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, dir.join(name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn run(argv: &[String]) -> ExitCode {
    let w = match parse(argv, true) {
        Ok(w) => w,
        Err(m) => return crate::usage(&format!("{m}; {USAGE}")),
    };
    let home = app_home();
    // Herdr makes its app home; a missing one means no Herdr here, so none is made for it.
    if !home.is_dir() {
        return super::error(
            "no_app_home",
            &format!("Herdr's app home {} does not exist", home.display()),
        );
    }
    let dir = home.join(PICTURES);
    if let Some((format, bytes)) = earlier(&dir, &w.digest) {
        cache::prune(&dir, cache::PRUNE_AGE);
        println!("{}", copied(&w, format, bytes));
        return ExitCode::SUCCESS;
    }
    let got = match &w.machine {
        None => read_here(&w),
        Some(m) => match read_there(m, &w) {
            Fetch::Got(got) => got,
            Fetch::Unreachable => {
                println!("{}", w.state("unreachable"));
                return ExitCode::SUCCESS;
            }
            Fetch::Failed(code, message) => return super::error(code, &message),
        },
    };
    let line = match got {
        Got::Data { format, bytes, .. } => {
            let name = format!("{}.{}", w.digest, log_image::format_raw(format));
            if let Err(e) = write_picture(&dir, &name, &bytes) {
                return super::error(
                    "failed",
                    &format!("cannot write {}: {e}", dir.join(&name).display()),
                );
            }
            cache::prune(&dir, cache::PRUNE_AGE);
            copied(&w, format, bytes.len() as u64)
        }
        Got::TooBig(n) => w.too_big(n),
        Got::Gone => w.state("gone"),
    };
    println!("{line}");
    ExitCode::SUCCESS
}
