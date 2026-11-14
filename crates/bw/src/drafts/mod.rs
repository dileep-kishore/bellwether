//! `bw drafts list|read|register-ledger|stage`: read-only worktree draft, plan, decision-trail, and
//! `independent-review` ledger discovery plus local HTML staging for remote spaces.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chat::{args, cache};
use crate::hc::{hc_exec, HcError};
use crate::linear::cache::{now_ms, private_dir, write_private};
use crate::machine::RUN_HELPER;

const USAGE: &str = "usage: bw drafts list --path <worktree> \
    | bw drafts read --path <worktree> --file <id> \
    | bw drafts register-ledger --path <worktree> --ledger <abs_ledger_path> \
    | bw drafts stage --name <slug.html> [--machine <m> --path <worktree> --file <id>]";

/// Maximum entries returned by `bw drafts list`.
pub const MAX_ENTRIES: usize = 200;
/// Maximum filesystem entries inspected during one worktree scan.
const MAX_SCAN_VISITS: usize = 4000;
/// Maximum directory recursion depth under a draft root.
const MAX_SCAN_DEPTH: usize = 12;
/// Maximum bytes read by `bw drafts read` (`512 KiB`).
pub const MAX_READ_BYTES: usize = 512 * 1024;
/// Maximum bytes staged for a self-contained HTML artifact (`5 MiB`; `html_b64` JSON <= ~6.99 MB under `hc exec`'s 8 MB cap).
pub const MAX_STAGE_BYTES: usize = 5 * 1024 * 1024;
/// Maximum staged HTML files retained under `~/.cache/bellwether/drafts-stage/`.
pub const MAX_STAGED_FILES: usize = 32;
/// Probe window for NUL bytes when rejecting binary files.
const BINARY_PROBE_BYTES: usize = 8000;

const SCAN_DIRS: [&str; 4] = ["docs/drafts", "docs/plans", "docs/superpowers", ".audit"];
const ROOT_FILES: [&str; 2] = ["decisions.tsv", "tasks.md"];

#[derive(Debug)]
pub struct DraftError {
    code: &'static str,
    message: String,
    usage: bool,
}

impl DraftError {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            code: "usage",
            message: message.into(),
            usage: true,
        }
    }

    fn runtime(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            usage: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DraftEntry {
    #[serde(rename = "type")]
    pub line_type: &'static str,
    pub kind: String,
    pub id: String,
    pub label: String,
    pub mtime_ms: i64,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct LedgerPointer {
    v: u32,
    id: String,
    worktree: String,
    ledger: String,
    registered_ms: i64,
}

pub fn run(argv: &[String]) -> ExitCode {
    let Some((cmd, rest)) = argv.split_first() else {
        return crate::usage(USAGE);
    };
    let result = match cmd.as_str() {
        "list" => run_list(rest),
        "read" => run_read(rest),
        "register-ledger" => run_register_ledger(rest),
        "stage" => run_stage(rest),
        other => Err(DraftError::usage(format!(
            "unknown drafts command {other:?}"
        ))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.usage => crate::usage(&format!("{}; {USAGE}", e.message)),
        Err(e) => crate::chat::error(e.code, &e.message),
    }
}

fn run_list(argv: &[String]) -> Result<(), DraftError> {
    let a = args::parse_free(argv, &[], &["path"], &[]).map_err(DraftError::usage)?;
    let raw_path = a
        .get("path")
        .ok_or_else(|| DraftError::usage("--path is required"))?;
    let entries = list_entries(Path::new(raw_path))?;
    for entry in entries {
        println!(
            "{}",
            serde_json::to_string(&entry).expect("DraftEntry serializes")
        );
    }
    Ok(())
}

fn run_read(argv: &[String]) -> Result<(), DraftError> {
    let a = args::parse_free(argv, &["stage"], &["path", "file"], &["file"])
        .map_err(DraftError::usage)?;
    let raw_path = a
        .get("path")
        .ok_or_else(|| DraftError::usage("--path is required"))?;
    let file_id = a
        .get("file")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| DraftError::usage("--file is required"))?;
    let for_stage = a.has("stage");
    let out = read_entry(Path::new(raw_path), file_id, for_stage)?;
    println!("{out}");
    Ok(())
}

fn run_register_ledger(argv: &[String]) -> Result<(), DraftError> {
    let a = args::parse_free(argv, &[], &["path", "ledger"], &[]).map_err(DraftError::usage)?;
    let raw_path = a
        .get("path")
        .ok_or_else(|| DraftError::usage("--path is required"))?;
    let raw_ledger = a
        .get("ledger")
        .ok_or_else(|| DraftError::usage("--ledger is required"))?;
    let out = register_ledger(Path::new(raw_path), Path::new(raw_ledger))?;
    println!("{out}");
    Ok(())
}

fn run_stage(argv: &[String]) -> Result<(), DraftError> {
    let a = args::parse_free(argv, &[], &["name", "machine", "path", "file"], &["file"])
        .map_err(DraftError::usage)?;
    let name = a
        .get("name")
        .ok_or_else(|| DraftError::usage("--name is required"))?;
    validate_stage_name(name)?;

    let machine = a.get("machine");
    let path = a.get("path");
    let file = a.get("file");

    let bytes = match (machine, path, file) {
        (Some(m), Some(p), Some(f)) => {
            validate_machine_name(m)?;
            if f.is_empty() {
                return Err(DraftError::usage("--file cannot be empty"));
            }
            fetch_remote_stage_html(m, p, f)?
        }
        (None, Some(p), Some(f)) => {
            if f.is_empty() {
                return Err(DraftError::usage("--file cannot be empty"));
            }
            let v = read_entry(Path::new(p), f, true)?;
            let b64 = v["html_b64"]
                .as_str()
                .ok_or_else(|| DraftError::runtime("bad_output", "missing html_b64 payload"))?;
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| DraftError::runtime("bad_output", format!("invalid html_b64: {e}")))?
        }
        (None, None, None) => read_stdin_stage_html()?,
        _ => {
            return Err(DraftError::usage(
                "provide both --path and --file (with optional --machine), or omit all three to stage from stdin",
            ))
        }
    };

    let out = stage_html_bytes(&cache::cache_dir().join("drafts-stage"), name, &bytes)?;
    println!("{out}");
    Ok(())
}

/// State root for Bellwether pointers: `$BW_STATE_DIR`, else `${XDG_STATE_HOME:-$HOME/.local/state}/bellwether`.
pub fn state_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("BW_STATE_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    if let Some(xdg) = std::env::var_os("XDG_STATE_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(xdg).join("bellwether");
    }
    let home = std::env::var_os("HOME").unwrap_or_default();
    PathBuf::from(home).join(".local/state/bellwether")
}

fn canonical_worktree(path: &Path) -> Result<PathBuf, DraftError> {
    let canon = fs::canonicalize(path).map_err(|e| {
        DraftError::runtime(
            "bad_path",
            format!("cannot resolve worktree {}: {e}", path.display()),
        )
    })?;
    if !canon.is_dir() {
        return Err(DraftError::runtime(
            "bad_path",
            format!("worktree {} is not a directory", canon.display()),
        ));
    }
    Ok(canon)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn worktree_hash(canon_worktree: &Path) -> String {
    sha256_hex(canon_worktree.as_os_str().as_encoded_bytes())
}

fn ledger_id_for(canon_ledger: &Path) -> String {
    let full = sha256_hex(canon_ledger.as_os_str().as_encoded_bytes());
    format!("ledger:{}", &full[..16])
}

fn mtime_ms_of(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// Encodes an absolute filesystem path as a `file://` URL with RFC 3986 percent-encoding.
pub fn file_url(path: &Path) -> String {
    let bytes = path.as_os_str().as_encoded_bytes();
    let mut out = String::with_capacity("file://".len() + bytes.len() + 8);
    out.push_str("file://");
    for &b in bytes {
        if b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Classifies a relative slash-separated worktree path when it is an allowed draft document.
fn classify_worktree_rel(rel: &str) -> Option<&'static str> {
    if rel.is_empty() || rel.starts_with('/') {
        return None;
    }
    let in_allowed_root = ROOT_FILES.contains(&rel)
        || SCAN_DIRS.iter().any(|root| {
            rel.strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/'))
        });
    if !in_allowed_root {
        return None;
    }
    let p = Path::new(rel);
    for comp in p.components() {
        let Component::Normal(seg) = comp else {
            return None;
        };
        let s = seg.to_str()?;
        if s == ".git" || s == "node_modules" || s == ".DS_Store" || s.starts_with("._") {
            return None;
        }
    }
    let file_name = p.file_name()?.to_str()?;
    let ext = p
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("html" | "htm") => Some("html"),
        Some("tsv") => {
            if file_name == "decisions.tsv" || rel.starts_with(".audit/") {
                Some("decisions")
            } else {
                None
            }
        }
        Some("md" | "markdown") => {
            if file_name == "ledger.md" {
                Some("ledger")
            } else if rel == "tasks.md"
                || file_name == "tasks.md"
                || rel.starts_with("docs/plans/")
                || rel.starts_with("docs/superpowers/plans/")
                || file_name.ends_with("-plan.md")
            {
                Some("plan")
            } else {
                Some("markdown")
            }
        }
        _ => None,
    }
}

pub fn list_entries(worktree: &Path) -> Result<Vec<DraftEntry>, DraftError> {
    let canon_wt = canonical_worktree(worktree)?;
    let mut entries: Vec<DraftEntry> = Vec::new();
    let mut seen_files: HashSet<PathBuf> = HashSet::new();
    let mut visited_dirs: HashSet<PathBuf> = HashSet::new();
    let mut visits: usize = 0;

    for root_file in ROOT_FILES {
        let candidate = canon_wt.join(root_file);
        try_push_worktree_file(
            &canon_wt,
            &candidate,
            root_file,
            &mut seen_files,
            &mut entries,
        );
    }

    for scan_dir in SCAN_DIRS {
        let dir = canon_wt.join(scan_dir);
        walk_worktree_dir(
            &canon_wt,
            &dir,
            scan_dir,
            0,
            &mut visits,
            &mut visited_dirs,
            &mut seen_files,
            &mut entries,
        );
    }

    for (id, label, canon_ledger, meta) in discover_external_ledgers(&canon_wt) {
        if !seen_files.insert(canon_ledger) {
            continue;
        }
        entries.push(DraftEntry {
            line_type: "draft",
            kind: "ledger".to_string(),
            id,
            label,
            mtime_ms: mtime_ms_of(&meta),
            size: meta.len(),
            file_url: None,
        });
    }

    entries.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then_with(|| a.id.cmp(&b.id)));
    entries.truncate(MAX_ENTRIES);
    Ok(entries)
}

#[allow(clippy::too_many_arguments)]
fn walk_worktree_dir(
    canon_wt: &Path,
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    visits: &mut usize,
    visited_dirs: &mut HashSet<PathBuf>,
    seen_files: &mut HashSet<PathBuf>,
    out: &mut Vec<DraftEntry>,
) {
    if depth > MAX_SCAN_DEPTH || *visits >= MAX_SCAN_VISITS {
        return;
    }
    let Ok(canon_dir) = fs::canonicalize(dir) else {
        return;
    };
    if !canon_dir.starts_with(canon_wt) || !canon_dir.is_dir() {
        return;
    }
    if !visited_dirs.insert(canon_dir) {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if name == ".git"
                || name == "node_modules"
                || name == ".DS_Store"
                || name.starts_with("._")
            {
                return None;
            }
            Some((name, e.path()))
        })
        .collect();
    children.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, child_path) in children {
        *visits += 1;
        if *visits > MAX_SCAN_VISITS {
            break;
        }
        let rel = format!("{rel_prefix}/{name}");
        let Ok(canon_child) = fs::canonicalize(&child_path) else {
            continue;
        };
        if !canon_child.starts_with(canon_wt) {
            continue;
        }
        let Ok(meta) = fs::metadata(&canon_child) else {
            continue;
        };
        if meta.is_dir() {
            walk_worktree_dir(
                canon_wt,
                &child_path,
                &rel,
                depth + 1,
                visits,
                visited_dirs,
                seen_files,
                out,
            );
        } else if meta.is_file() {
            try_push_worktree_file(canon_wt, &child_path, &rel, seen_files, out);
        }
    }
}

fn canonical_worktree_rel(canon_wt: &Path, canon_file: &Path) -> Option<String> {
    let stripped = canon_file.strip_prefix(canon_wt).ok()?;
    let mut parts = Vec::new();
    for comp in stripped.components() {
        let std::path::Component::Normal(os) = comp else {
            return None;
        };
        parts.push(os.to_str()?);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn try_push_worktree_file(
    canon_wt: &Path,
    path: &Path,
    rel: &str,
    seen_files: &mut HashSet<PathBuf>,
    out: &mut Vec<DraftEntry>,
) {
    let Some(kind) = classify_worktree_rel(rel) else {
        return;
    };
    let Ok(canon_file) = fs::canonicalize(path) else {
        return;
    };
    let Some(canon_rel) = canonical_worktree_rel(canon_wt, &canon_file) else {
        return;
    };
    if classify_worktree_rel(&canon_rel) != Some(kind) {
        return;
    }
    let Ok(meta) = fs::metadata(&canon_file) else {
        return;
    };
    if !meta.is_file() || !seen_files.insert(canon_file.clone()) {
        return;
    }
    out.push(DraftEntry {
        line_type: "draft",
        kind: kind.to_string(),
        id: rel.to_string(),
        label: rel.to_string(),
        mtime_ms: mtime_ms_of(&meta),
        size: meta.len(),
        file_url: (kind == "html").then(|| file_url(&canon_file)),
    });
}

fn current_uid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and takes no arguments.
    unsafe { libc::geteuid() }
}

fn validate_external_ledger_file(path: &Path, uid: u32) -> Option<(PathBuf, fs::Metadata)> {
    let lmeta = fs::symlink_metadata(path).ok()?;
    if !lmeta.file_type().is_file() || lmeta.uid() != uid {
        return None;
    }
    let canon = fs::canonicalize(path).ok()?;
    if canon.file_name() != Some(OsStr::new("ledger.md")) {
        return None;
    }
    let meta = fs::symlink_metadata(&canon).ok()?;
    if !meta.file_type().is_file() || meta.uid() != uid {
        return None;
    }
    Some((canon, meta))
}

fn external_ledger_label(canon_ledger: &Path) -> String {
    match canon_ledger
        .parent()
        .and_then(|p| p.file_name())
        .and_then(OsStr::to_str)
    {
        Some(dir) if !dir.is_empty() => format!("{dir}/ledger.md"),
        _ => "ledger.md".to_string(),
    }
}

/// Checks whether `text` references `canon_wt` as a whole path or directory prefix (not `/repo/app-other`).
fn references_worktree(text: &str, canon_wt: &Path) -> bool {
    let Some(needle) = canon_wt.to_str().filter(|s| !s.is_empty()) else {
        return false;
    };
    let mut rest = text;
    while let Some(pos) = rest.find(needle) {
        let after = &rest[pos + needle.len()..];
        let boundary = match after.as_bytes().first() {
            None => true,
            Some(&b) => {
                b == b'/' || !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            }
        };
        if boundary {
            return true;
        }
        rest = &rest[pos + needle.len()..];
    }
    false
}

fn candidate_tmp_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut raw: Vec<PathBuf> = Vec::new();
    if let Some(t) = std::env::var_os("TMPDIR").filter(|s| !s.is_empty()) {
        raw.push(PathBuf::from(t));
    }
    if let Some(extra) = std::env::var_os("BW_TMP_SCAN_DIR").filter(|s| !s.is_empty()) {
        raw.push(PathBuf::from(extra));
    }
    raw.push(PathBuf::from("/private/tmp"));
    raw.push(PathBuf::from("/tmp"));

    for r in raw {
        if let Ok(canon) = fs::canonicalize(&r) {
            if canon.is_dir() && seen.insert(canon.clone()) {
                roots.push(canon);
            }
        }
    }
    roots
}

fn discover_external_ledgers(canon_wt: &Path) -> Vec<(String, String, PathBuf, fs::Metadata)> {
    let uid = current_uid();
    let mut out: Vec<(String, String, PathBuf, fs::Metadata)> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    // 1. Registered pointers under `<state_dir>/reviews/<sha256(canonical_worktree)>/*.json`.
    let reviews_dir = state_dir().join("reviews").join(worktree_hash(canon_wt));
    if let Ok(rd) = fs::read_dir(&reviews_dir) {
        let wt_str = canon_wt.to_string_lossy();
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(OsStr::to_str) != Some("json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&p) else {
                continue;
            };
            let Ok(ptr) = serde_json::from_str::<LedgerPointer>(&text) else {
                continue;
            };
            if ptr.worktree != wt_str {
                continue;
            }
            let Some((canon_ledger, meta)) =
                validate_external_ledger_file(Path::new(&ptr.ledger), uid)
            else {
                continue;
            };
            if seen.insert(canon_ledger.clone()) {
                let id = ledger_id_for(&canon_ledger);
                let label = external_ledger_label(&canon_ledger);
                out.push((id, label, canon_ledger, meta));
            }
        }
    }

    // 2. `$TMPDIR/*/ledger.md` and `/private/tmp/*/ledger.md` referencing canonical `<worktree>`.
    for tmp_root in candidate_tmp_roots() {
        let Ok(rd) = fs::read_dir(&tmp_root) else {
            continue;
        };
        for entry in rd.flatten() {
            let run_dir = entry.path();
            let Ok(dmeta) = fs::symlink_metadata(&run_dir) else {
                continue;
            };
            if !dmeta.file_type().is_dir() || dmeta.uid() != uid {
                continue;
            }
            let candidate = run_dir.join("ledger.md");
            let Some((canon_ledger, meta)) = validate_external_ledger_file(&candidate, uid) else {
                continue;
            };
            if !canon_ledger.starts_with(&tmp_root) || seen.contains(&canon_ledger) {
                continue;
            }
            let Ok((text, _, _)) = read_capped_utf8(&canon_ledger, MAX_READ_BYTES) else {
                continue;
            };
            if references_worktree(&text, canon_wt) && seen.insert(canon_ledger.clone()) {
                let id = ledger_id_for(&canon_ledger);
                let label = external_ledger_label(&canon_ledger);
                out.push((id, label, canon_ledger, meta));
            }
        }
    }

    out
}

pub fn register_ledger(worktree: &Path, ledger: &Path) -> Result<Value, DraftError> {
    let canon_wt = canonical_worktree(worktree)?;
    if !ledger.is_absolute() {
        return Err(DraftError::usage("--ledger must be an absolute path"));
    }
    let uid = current_uid();
    let Some((canon_ledger, _)) = validate_external_ledger_file(ledger, uid) else {
        return Err(DraftError::runtime(
            "bad_ledger",
            format!(
                "ledger {} must be an existing regular file named ledger.md owned by this user",
                ledger.display()
            ),
        ));
    };
    let id = ledger_id_for(&canon_ledger);
    let file_stem = id.strip_prefix("ledger:").unwrap_or(&id);
    let dir = state_dir().join("reviews").join(worktree_hash(&canon_wt));
    private_dir(&dir).map_err(|e| {
        DraftError::runtime("io_error", format!("cannot create {}: {e}", dir.display()))
    })?;
    let ptr = LedgerPointer {
        v: 1,
        id: id.clone(),
        worktree: canon_wt.to_string_lossy().into_owned(),
        ledger: canon_ledger.to_string_lossy().into_owned(),
        registered_ms: now_ms(),
    };
    let bytes = serde_json::to_vec(&ptr).expect("LedgerPointer serializes");
    let target = dir.join(format!("{file_stem}.json"));
    write_private(&target, &bytes).map_err(|e| {
        DraftError::runtime(
            "io_error",
            format!("cannot write {}: {e}", target.display()),
        )
    })?;
    Ok(json!({
        "type": "ledger-registered",
        "id": id,
        "worktree": ptr.worktree,
        "ledger": ptr.ledger,
    }))
}

pub fn read_entry(worktree: &Path, file_id: &str, for_stage: bool) -> Result<Value, DraftError> {
    let canon_wt = canonical_worktree(worktree)?;
    let (kind, canon_file, meta) = if file_id.starts_with("ledger:") {
        if for_stage {
            return Err(DraftError::runtime(
                "not_html",
                "only HTML draft entries can be staged",
            ));
        }
        let matched = discover_external_ledgers(&canon_wt)
            .into_iter()
            .find(|(id, _, _, _)| id == file_id);
        let Some((_, _, canon_ledger, meta)) = matched else {
            return Err(DraftError::runtime(
                "not_allowed",
                format!("external ledger {file_id:?} is not allow-listed for this worktree"),
            ));
        };
        ("ledger", canon_ledger, meta)
    } else {
        let Some(kind) = classify_worktree_rel(file_id) else {
            return Err(DraftError::runtime(
                "not_allowed",
                format!("file {file_id:?} is outside allow-listed draft paths"),
            ));
        };
        if for_stage && kind != "html" {
            return Err(DraftError::runtime(
                "not_html",
                format!("file {file_id:?} is {kind}, not html"),
            ));
        }
        let joined = canon_wt.join(file_id);
        let canon_file = fs::canonicalize(&joined).map_err(|_| {
            DraftError::runtime("not_found", format!("draft {file_id:?} does not exist"))
        })?;
        let Some(canon_rel) = canonical_worktree_rel(&canon_wt, &canon_file) else {
            return Err(DraftError::runtime(
                "not_allowed",
                format!("file {file_id:?} escapes worktree {}", canon_wt.display()),
            ));
        };
        if classify_worktree_rel(&canon_rel) != Some(kind) {
            return Err(DraftError::runtime(
                "not_allowed",
                format!(
                    "symlink target {canon_rel:?} for {file_id:?} is outside allow-listed {kind} paths"
                ),
            ));
        }
        let meta = fs::metadata(&canon_file).map_err(|e| {
            DraftError::runtime("io_error", format!("cannot stat {file_id:?}: {e}"))
        })?;
        if !meta.is_file() {
            return Err(DraftError::runtime(
                "not_found",
                format!("draft {file_id:?} is not a regular file"),
            ));
        }
        (kind, canon_file, meta)
    };

    if for_stage {
        if meta.len() > MAX_STAGE_BYTES as u64 {
            return Err(DraftError::runtime(
                "too_big",
                format!(
                    "HTML artifact {file_id:?} is {} bytes (max {MAX_STAGE_BYTES})",
                    meta.len()
                ),
            ));
        }
        let raw_bytes = read_stage_bytes(&canon_file, MAX_STAGE_BYTES)?;
        return Ok(json!({
            "type": "draft-read",
            "id": file_id,
            "kind": kind,
            "size": raw_bytes.len(),
            "truncated": false,
            "html_b64": base64::engine::general_purpose::STANDARD.encode(&raw_bytes),
            "file_url": file_url(&canon_file),
        }));
    }

    let (text, truncated, total_size) = read_capped_utf8(&canon_file, MAX_READ_BYTES)?;
    Ok(json!({
        "type": "draft-read",
        "id": file_id,
        "kind": kind,
        "size": total_size.max(meta.len()),
        "truncated": truncated,
        "text": text,
        "file_url": (kind == "html").then(|| file_url(&canon_file)),
    }))
}

fn read_stage_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, DraftError> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            DraftError::runtime("io_error", format!("cannot open {}: {e}", path.display()))
        })?;
    let fmeta = file.metadata().map_err(|e| {
        DraftError::runtime("io_error", format!("cannot stat {}: {e}", path.display()))
    })?;
    if !fmeta.is_file() {
        return Err(DraftError::runtime(
            "not_found",
            format!("{} is not a regular file", path.display()),
        ));
    }
    if fmeta.len() > limit as u64 {
        return Err(DraftError::runtime(
            "too_big",
            format!(
                "HTML artifact {} is {} bytes (max {limit})",
                path.display(),
                fmeta.len()
            ),
        ));
    }
    let mut buf = Vec::with_capacity((fmeta.len() as usize).min(limit).saturating_add(1));
    file.take((limit as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| {
            DraftError::runtime("io_error", format!("cannot read {}: {e}", path.display()))
        })?;
    if buf.len() > limit {
        return Err(DraftError::runtime(
            "too_big",
            format!("HTML artifact {} exceeds {limit} bytes", path.display()),
        ));
    }
    let probe_end = buf.len().min(BINARY_PROBE_BYTES);
    if buf[..probe_end].contains(&0) {
        return Err(DraftError::runtime(
            "binary",
            format!("{} appears to be a binary file", path.display()),
        ));
    }
    Ok(buf)
}

fn read_capped_utf8(path: &Path, limit: usize) -> Result<(String, bool, u64), DraftError> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            DraftError::runtime("io_error", format!("cannot open {}: {e}", path.display()))
        })?;
    let fmeta = file.metadata().map_err(|e| {
        DraftError::runtime("io_error", format!("cannot stat {}: {e}", path.display()))
    })?;
    if !fmeta.is_file() {
        return Err(DraftError::runtime(
            "not_found",
            format!("{} is not a regular file", path.display()),
        ));
    }
    let total_size = fmeta.len();
    let mut buf = Vec::with_capacity(limit.min(total_size as usize).saturating_add(1));
    file.take((limit as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| {
            DraftError::runtime("io_error", format!("cannot read {}: {e}", path.display()))
        })?;
    let probe_end = buf.len().min(BINARY_PROBE_BYTES);
    if buf[..probe_end].contains(&0) {
        return Err(DraftError::runtime(
            "binary",
            format!("{} appears to be a binary file", path.display()),
        ));
    }
    let truncated = buf.len() > limit;
    if truncated {
        buf.truncate(limit);
        trim_incomplete_utf8_tail(&mut buf);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok((text, truncated, total_size))
}

/// Drops 1-3 trailing continuation/start bytes split by `limit` so valid UTF-8 never gets a U+FFFD tail.
fn trim_incomplete_utf8_tail(buf: &mut Vec<u8>) {
    if let Err(err) = std::str::from_utf8(buf) {
        if err.error_len().is_none() {
            buf.truncate(err.valid_up_to());
        }
    }
}

fn validate_stage_name(name: &str) -> Result<(), DraftError> {
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err(DraftError::usage(format!(
            "--name {name:?} must be a plain .html filename"
        )));
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower
        .strip_suffix(".html")
        .or_else(|| lower.strip_suffix(".htm"))
        .unwrap_or("");
    if stem.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(DraftError::usage(format!(
            "--name {name:?} must match [A-Za-z0-9._-]+.html"
        )));
    }
    Ok(())
}

fn validate_machine_name(machine: &str) -> Result<(), DraftError> {
    if machine.is_empty() || machine.starts_with('-') || machine.contains('/') {
        return Err(DraftError::usage(format!("bad machine name {machine:?}")));
    }
    Ok(())
}

fn read_stdin_stage_html() -> Result<Vec<u8>, DraftError> {
    let mut buf = Vec::new();
    io::stdin()
        .take((MAX_STAGE_BYTES as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| DraftError::runtime("io_error", format!("cannot read stdin: {e}")))?;
    if buf.is_empty() {
        return Err(DraftError::runtime(
            "empty_html",
            "stdin HTML payload is empty",
        ));
    }
    if buf.len() > MAX_STAGE_BYTES {
        return Err(DraftError::runtime(
            "too_big",
            format!("stdin HTML exceeds {MAX_STAGE_BYTES} bytes"),
        ));
    }
    let probe_end = buf.len().min(BINARY_PROBE_BYTES);
    if buf[..probe_end].contains(&0) {
        return Err(DraftError::runtime(
            "binary",
            "stdin HTML payload contains NUL bytes",
        ));
    }
    Ok(buf)
}

fn fetch_remote_stage_html(
    machine: &str,
    worktree: &str,
    file_id: &str,
) -> Result<Vec<u8>, DraftError> {
    let argv = [
        "sh", "-c", RUN_HELPER, "bw", "drafts", "read", "--path", worktree, "--file", file_id,
        "--stage",
    ];
    let out = match hc_exec(machine, &argv) {
        Ok(out) => out,
        Err(HcError::Unreachable(m)) => {
            return Err(DraftError::runtime("unreachable", m));
        }
        Err(HcError::NoProgram(m)) => {
            return Err(DraftError::runtime("missing", m));
        }
        Err(e) => {
            return Err(DraftError::runtime("failed", e.to_string()));
        }
    };
    if matches!(out.code, Some(126 | 127)) {
        return Err(DraftError::runtime(
            "missing",
            format!("the Bellwether helper is not installed on {machine}"),
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line: Value = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str(l).ok())
        .unwrap_or(Value::Null);
    if line["type"] == "error" {
        let msg = line["message"]
            .as_str()
            .unwrap_or("remote drafts read failed");
        return Err(DraftError::runtime(
            "remote_error",
            format!("{machine}: {msg}"),
        ));
    }
    if line["type"] != "draft-read" || line["kind"] != "html" {
        return Err(DraftError::runtime(
            "bad_output",
            format!("{machine}'s helper returned unexpected drafts read payload"),
        ));
    }
    let bytes = if let Some(b64) = line["html_b64"].as_str() {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| {
                DraftError::runtime(
                    "bad_output",
                    format!("{machine}'s helper returned invalid html_b64: {e}"),
                )
            })?
    } else if let Some(text) = line["text"].as_str() {
        text.as_bytes().to_vec()
    } else {
        return Err(DraftError::runtime(
            "bad_output",
            format!("{machine}'s helper returned no HTML payload"),
        ));
    };
    if bytes.len() > MAX_STAGE_BYTES {
        return Err(DraftError::runtime(
            "too_big",
            format!("remote HTML exceeds {MAX_STAGE_BYTES} bytes"),
        ));
    }
    Ok(bytes)
}

pub fn stage_html_bytes(stage_root: &Path, name: &str, bytes: &[u8]) -> Result<Value, DraftError> {
    validate_stage_name(name)?;
    private_dir(stage_root).map_err(|e| {
        DraftError::runtime(
            "io_error",
            format!("cannot create {}: {e}", stage_root.display()),
        )
    })?;
    let digest = sha256_hex(bytes);
    let bucket = stage_root.join(&digest);
    private_dir(&bucket).map_err(|e| {
        DraftError::runtime(
            "io_error",
            format!("cannot create {}: {e}", bucket.display()),
        )
    })?;
    let target = bucket.join(name);
    write_private(&target, bytes).map_err(|e| {
        DraftError::runtime(
            "io_error",
            format!("cannot write {}: {e}", target.display()),
        )
    })?;
    if let Ok(f) = fs::File::options().write(true).open(&target) {
        let _ = f.set_modified(SystemTime::now());
    }
    prune_staged_files(stage_root, MAX_STAGED_FILES);
    let canon_target = fs::canonicalize(&target).unwrap_or(target);
    Ok(json!({
        "type": "draft-staged",
        "url": file_url(&canon_target),
        "path": canon_target.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

fn prune_staged_files(stage_root: &Path, keep: usize) {
    let Ok(buckets) = fs::read_dir(stage_root) else {
        return;
    };
    let mut staged: Vec<(SystemTime, PathBuf, PathBuf)> = Vec::new();
    for bucket_entry in buckets.flatten() {
        let bucket_path = bucket_entry.path();
        if !bucket_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&bucket_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let p = file_entry.path();
            let Some(fname) = p.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            if fname.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&p) else {
                continue;
            };
            if !meta.file_type().is_file() {
                continue;
            }
            let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
            staged.push((mtime, p, bucket_path.clone()));
        }
    }
    if staged.len() <= keep {
        return;
    }
    staged.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let drop_count = staged.len() - keep;
    for (_, file_path, bucket_path) in staged.into_iter().take(drop_count) {
        let _ = fs::remove_file(&file_path);
        if fs::read_dir(&bucket_path)
            .ok()
            .is_some_and(|mut it| it.next().is_none())
        {
            let _ = fs::remove_dir(&bucket_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_isolated_env<F: FnOnce(&Path, &Path)>(f: F) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let tmp_scan = tmp.path().join("tmpscan");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&tmp_scan).unwrap();
        let prev_state = std::env::var_os("BW_STATE_DIR");
        let prev_scan = std::env::var_os("BW_TMP_SCAN_DIR");
        std::env::set_var("BW_STATE_DIR", &state);
        std::env::set_var("BW_TMP_SCAN_DIR", &tmp_scan);
        f(tmp.path(), &tmp_scan);
        match prev_state {
            Some(v) => std::env::set_var("BW_STATE_DIR", v),
            None => std::env::remove_var("BW_STATE_DIR"),
        }
        match prev_scan {
            Some(v) => std::env::set_var("BW_TMP_SCAN_DIR", v),
            None => std::env::remove_var("BW_TMP_SCAN_DIR"),
        }
    }

    #[test]
    fn lists_nested_html_decisions_audit_tsv_plans_and_root_tasks() {
        with_isolated_env(|root, _| {
            let wt = root.join("wt");
            fs::create_dir_all(wt.join("docs/drafts/sub")).unwrap();
            fs::create_dir_all(wt.join("docs/plans")).unwrap();
            fs::create_dir_all(wt.join("docs/superpowers/specs")).unwrap();
            fs::create_dir_all(wt.join(".audit")).unwrap();
            fs::create_dir_all(wt.join("docs/drafts/node_modules/pkg")).unwrap();

            fs::write(wt.join("docs/drafts/sub/page.html"), "<h1>Hi</h1>").unwrap();
            fs::write(
                wt.join("decisions.tsv"),
                "ts\tphase\tdecision\twhy\tevidence\tresult\n",
            )
            .unwrap();
            fs::write(
                wt.join(".audit/run.tsv"),
                "ts\tphase\tdecision\twhy\tevidence\tresult\n",
            )
            .unwrap();
            fs::write(wt.join("tasks.md"), "- [x] one\n- [ ] two\n").unwrap();
            fs::write(
                wt.join("docs/plans/2026-11-13-ui-plan.md"),
                "# Plan\n- [ ] step\n",
            )
            .unwrap();
            fs::write(wt.join("docs/superpowers/specs/note.md"), "# Spec\n").unwrap();
            fs::write(wt.join("docs/drafts/node_modules/pkg/ignored.md"), "nope").unwrap();
            fs::write(wt.join("docs/drafts/sub/shot.png"), b"\x89PNG\r\n").unwrap();

            let entries = list_entries(&wt).unwrap();
            let by_id: std::collections::HashMap<_, _> =
                entries.iter().map(|e| (e.id.as_str(), e)).collect();

            assert_eq!(by_id["docs/drafts/sub/page.html"].kind, "html");
            assert!(by_id["docs/drafts/sub/page.html"]
                .file_url
                .as_deref()
                .unwrap()
                .starts_with("file:///"));
            assert_eq!(by_id["decisions.tsv"].kind, "decisions");
            assert_eq!(by_id[".audit/run.tsv"].kind, "decisions");
            assert_eq!(by_id["tasks.md"].kind, "plan");
            assert_eq!(by_id["docs/plans/2026-11-13-ui-plan.md"].kind, "plan");
            assert_eq!(by_id["docs/superpowers/specs/note.md"].kind, "markdown");
            assert!(!by_id.contains_key("docs/drafts/node_modules/pkg/ignored.md"));
            assert!(!by_id.contains_key("docs/drafts/sub/shot.png"));
        });
    }

    #[test]
    fn skips_symlink_escapes_and_blocks_traversal_and_non_draft_reads() {
        with_isolated_env(|root, _| {
            let wt = root.join("wt");
            let secret = root.join("outside-secret.md");
            fs::create_dir_all(wt.join("docs/drafts")).unwrap();
            fs::create_dir_all(wt.join("docs/plans")).unwrap();
            fs::write(&secret, "top secret").unwrap();
            fs::write(wt.join(".env"), "API_KEY=secret").unwrap();
            fs::write(wt.join("tasks.md"), "- [x] task\n").unwrap();
            symlink(&secret, wt.join("docs/drafts/escape.md")).unwrap();
            symlink("../../.env", wt.join("docs/plans/local-plan.md")).unwrap();
            symlink("../../.env", wt.join("docs/drafts/secret.html")).unwrap();
            symlink("../../tasks.md", wt.join("docs/drafts/not-html.html")).unwrap();

            let entries = list_entries(&wt).unwrap();
            let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
            assert_eq!(ids, vec!["tasks.md"]);

            for blocked in [
                "docs/drafts/escape.md",
                "docs/plans/local-plan.md",
                "docs/drafts/secret.html",
                "docs/drafts/not-html.html",
                "../outside-secret.md",
                ".env",
            ] {
                assert_eq!(
                    read_entry(&wt, blocked, false).unwrap_err().code,
                    "not_allowed",
                    "expected not_allowed for {blocked}"
                );
            }
            for blocked_stage in ["docs/drafts/secret.html", "docs/drafts/not-html.html"] {
                assert_eq!(
                    read_entry(&wt, blocked_stage, true).unwrap_err().code,
                    "not_allowed",
                    "expected stage not_allowed for {blocked_stage}"
                );
            }
        });
    }

    #[test]
    fn discovers_external_ledgers_and_refuses_sibling_transcripts() {
        with_isolated_env(|root, tmp_scan| {
            let wt = root.join("app");
            let wt_other = root.join("app-other");
            fs::create_dir_all(&wt).unwrap();
            fs::create_dir_all(&wt_other).unwrap();
            let canon_wt = fs::canonicalize(&wt).unwrap();
            let canon_other = fs::canonicalize(&wt_other).unwrap();

            // 1. Auto-discovered ledger in tmp_scan referencing canonical `wt`.
            let run1 = tmp_scan.join("bw-review.111");
            fs::create_dir_all(&run1).unwrap();
            let ledger1 = run1.join("ledger.md");
            fs::write(
                &ledger1,
                format!(
                    "# Review Ledger\nWorktree: `{}/src/lib.rs`\n",
                    canon_wt.display()
                ),
            )
            .unwrap();
            fs::write(run1.join("report-sol.txt"), "raw reviewer transcript").unwrap();

            // 2. Sibling run for `/app-other` must NOT match `/app` prefix!
            let run_other = tmp_scan.join("bw-review.other");
            fs::create_dir_all(&run_other).unwrap();
            fs::write(
                run_other.join("ledger.md"),
                format!("# Other\nWorktree: {}\n", canon_other.display()),
            )
            .unwrap();

            // 3. Explicitly registered ledger outside tmp_scan.
            let custom_dir = root.join("custom-review");
            fs::create_dir_all(&custom_dir).unwrap();
            let ledger2 = custom_dir.join("ledger.md");
            fs::write(&ledger2, "# Registered Ledger\nConfirmed: 0\n").unwrap();
            let reg = register_ledger(&wt, &ledger2).unwrap();
            let reg_id = reg["id"].as_str().unwrap().to_string();

            // Also register ledger1 to verify deduplication when both sources see it.
            register_ledger(&wt, &ledger1).unwrap();

            let entries = list_entries(&wt).unwrap();
            assert_eq!(entries.len(), 2);
            assert!(entries.iter().all(|e| e.kind == "ledger"));

            let read_ok = read_entry(&wt, &reg_id, false).unwrap();
            assert_eq!(read_ok["kind"], "ledger");
            assert!(read_ok["text"]
                .as_str()
                .unwrap()
                .contains("Registered Ledger"));

            // Sibling raw transcripts and arbitrary paths are strictly refused.
            let raw_sibling = run1.join("report-sol.txt");
            assert_eq!(
                read_entry(&wt, raw_sibling.to_str().unwrap(), false)
                    .unwrap_err()
                    .code,
                "not_allowed"
            );
            assert_eq!(
                register_ledger(&wt, &raw_sibling).unwrap_err().code,
                "bad_ledger"
            );
        });
    }

    #[test]
    fn enforces_200_file_cap_and_512_kib_utf8_read_cap() {
        with_isolated_env(|root, _| {
            let wt = root.join("wt");
            fs::create_dir_all(wt.join("docs/drafts")).unwrap();
            for i in 0..215 {
                fs::write(wt.join(format!("docs/drafts/note-{i:03}.md")), "hi").unwrap();
            }
            let entries = list_entries(&wt).unwrap();
            assert_eq!(entries.len(), MAX_ENTRIES);

            // Multi-byte UTF-8 boundary across 512 KiB.
            let mut big = "a".repeat(MAX_READ_BYTES - 1);
            big.push('é'); // 2-byte UTF-8 crossing byte 524_288
            big.push_str("trailing");
            fs::write(wt.join("docs/drafts/big.md"), big.as_bytes()).unwrap();

            let v = read_entry(&wt, "docs/drafts/big.md", false).unwrap();
            assert_eq!(v["truncated"], true);
            let text = v["text"].as_str().unwrap();
            assert_eq!(text.len(), MAX_READ_BYTES - 1);
            assert!(!text.contains('\u{FFFD}'));
        });
    }

    #[test]
    fn stages_html_with_private_permissions_and_prunes_beyond_32() {
        let tmp = tempfile::tempdir().unwrap();
        let stage_dir = tmp.path().join("drafts-stage");

        for i in 0..35 {
            let html = format!("<!doctype html><title>Page {i}</title>");
            let res = stage_html_bytes(&stage_dir, &format!("page-{i:02}.html"), html.as_bytes())
                .unwrap();
            assert!(res["url"].as_str().unwrap().starts_with("file:///"));
            let staged_path = PathBuf::from(res["path"].as_str().unwrap());
            let file_mode = fs::metadata(&staged_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(file_mode, 0o600);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        let dir_mode = fs::metadata(&stage_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);

        let remaining: usize = fs::read_dir(&stage_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| fs::read_dir(e.path()).unwrap().flatten().count())
            .sum();
        assert_eq!(remaining, MAX_STAGED_FILES);
    }

    #[test]
    fn stage_read_uses_base64_and_stays_under_hc_exec_8mb_cap() {
        with_isolated_env(|root, _| {
            let wt = root.join("wt");
            fs::create_dir_all(wt.join("docs/drafts")).unwrap();
            let prefix = b"<!doctype html><pre>";
            let suffix = b"</pre>";
            let body_len = MAX_STAGE_BYTES - prefix.len() - suffix.len();
            let mut raw = Vec::with_capacity(MAX_STAGE_BYTES);
            raw.extend_from_slice(prefix);
            raw.resize(prefix.len() + body_len, b'"');
            raw.extend_from_slice(suffix);
            assert_eq!(raw.len(), MAX_STAGE_BYTES);
            fs::write(wt.join("docs/drafts/quotes.html"), &raw).unwrap();

            let v = read_entry(&wt, "docs/drafts/quotes.html", true).unwrap();
            let encoded = serde_json::to_vec(&v).unwrap();
            // hc exec truncates stdout at 8 MB (8_000_000 bytes).
            assert!(
                encoded.len() < 7_100_000,
                "stage JSON must stay well under 8 MB, got {}",
                encoded.len()
            );
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(v["html_b64"].as_str().unwrap())
                .unwrap();
            assert_eq!(decoded, raw);
        });
    }
}
