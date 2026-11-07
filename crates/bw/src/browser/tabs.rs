//! `bw browser tabs|focus|close|new`: the Chrome's pages and their favicons.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};

use super::{cdp, http};
use crate::chat::args;

/// Where favicons go, relative to the app home; `image()` takes paths relative to it.
const FAVICONS: &str = "data/bellwether/favicons";
const DEFAULT_PORT: u16 = 9222;
const HTTP_TIMEOUT: Duration = Duration::from_secs(2);
/// Per CDP call; a page held by a JavaScript dialog never answers `Runtime.evaluate`.
const CDP_TIMEOUT: Duration = Duration::from_secs(1);
/// All focus reads together, so a few stuck pages cannot stall the panel's poll.
const FOCUS_BUDGET: Duration = Duration::from_secs(3);
/// New favicon fetches per call.
pub const FETCH_BUDGET: usize = 4;
const MAX_ICON: usize = 65536;
const FAILED_FOR_MS: i64 = 60 * 60 * 1000;
pub const KEEP_FAVICONS: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// A cached favicon still in use is touched at most this often, so pruning keeps it.
const TOUCH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const EXTS: [&str; 5] = ["png", "jpg", "gif", "webp", "svg"];

const USAGE: &str =
    "usage: bw browser tabs | focus --id <id> | close --id <id> | new [--url <url>]";

#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub url: String,
    /// Relative to the app home, when a favicon is cached.
    pub favicon: Option<String>,
    pub active: bool,
}

impl Tab {
    pub fn json(&self) -> Value {
        json!({"type": "tab", "id": self.id, "title": self.title, "url": self.url,
            "favicon": self.favicon, "active": self.active})
    }
}

pub fn run(cmd: &str, argv: &[String]) -> ExitCode {
    let port = match chrome_port() {
        Ok(port) => port,
        Err(message) => return crate::usage(&message),
    };
    let options: &[&str] = match cmd {
        "focus" | "close" => &["id"],
        "new" => &["url"],
        _ => &[],
    };
    let a = match args::parse(argv, &[], options) {
        Ok(a) => a,
        Err(message) => return crate::usage(&format!("{message}; {USAGE}")),
    };
    match cmd {
        "tabs" => match list(port, &app_home(), FETCH_BUDGET) {
            Ok(tabs) => {
                for tab in tabs {
                    println!("{}", tab.json());
                }
                ExitCode::SUCCESS
            }
            Err(message) => crate::chat::error("chrome_unreachable", &message),
        },
        "focus" | "close" => {
            let Some(id) = a.get("id") else {
                return crate::usage(&format!("--id is required; {USAGE}"));
            };
            if !is_target_id(id) {
                return crate::usage(&format!("{id:?} is not a target id"));
            }
            let (ok, message) = if cmd == "focus" {
                focus(port, id)
            } else {
                close(port, id)
            };
            action(cmd, id, ok, &message)
        }
        "new" => match open(port, a.get("url").unwrap_or("about:blank")) {
            Ok(id) => {
                let message = match focus(port, &id) {
                    (true, _) => "opened".to_string(),
                    (false, why) => format!("opened, but focusing it failed: {why}"),
                };
                action("new", &id, true, &message)
            }
            Err(message) => action("new", "", false, &message),
        },
        other => crate::usage(&format!("unknown tabs command {other:?}; {USAGE}")),
    }
}

/// Exits 0 either way: `shared/helper.js` drops a failed command's output, and the panel shows `message`.
fn action(action: &str, id: &str, ok: bool, message: &str) -> ExitCode {
    println!(
        "{}",
        json!({"type": "tab-action", "action": action, "id": id, "ok": ok, "message": message})
    );
    ExitCode::SUCCESS
}

/// `BW_CHROME_PORT`, else 9222.
fn chrome_port() -> Result<u16, String> {
    match std::env::var("BW_CHROME_PORT") {
        Ok(v) if !v.is_empty() => v
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or_else(|| format!("BW_CHROME_PORT {v:?} is not a port")),
        _ => Ok(DEFAULT_PORT),
    }
}

/// `$HERDR_APP_HOME`, else `~/.config/herdr-app`.
pub(crate) fn app_home() -> PathBuf {
    if let Some(d) = std::env::var_os("HERDR_APP_HOME").filter(|d| !d.is_empty()) {
        return d.into();
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config/herdr-app")
}

/// Chrome's ids are hex; anything else could change the endpoint path it is pasted into.
fn is_target_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn endpoint(port: u16, path: &str) -> Result<(bool, String), String> {
    let reply = http::get(port, path, HTTP_TIMEOUT)
        .map_err(|e| format!("GET http://127.0.0.1:{port}{path}: {e}"))?;
    let body = String::from_utf8_lossy(&reply.body).trim().to_string();
    Ok((reply.status == 200, body))
}

fn focus(port: u16, id: &str) -> (bool, String) {
    endpoint(port, &format!("/json/activate/{id}")).unwrap_or_else(|e| (false, e))
}

fn close(port: u16, id: &str) -> (bool, String) {
    endpoint(port, &format!("/json/close/{id}")).unwrap_or_else(|e| (false, e))
}

/// Opens a tab with `PUT /json/new` (Chrome refuses GET there) and returns its target id.
fn open(port: u16, url: &str) -> Result<String, String> {
    let path = format!("/json/new?{}", encode_query(url));
    let reply = http::put(port, &path, HTTP_TIMEOUT)
        .map_err(|e| format!("PUT http://127.0.0.1:{port}/json/new: {e}"))?;
    if reply.status != 200 {
        return Err(format!(
            "PUT /json/new answered {}: {}",
            reply.status,
            String::from_utf8_lossy(&reply.body).trim()
        ));
    }
    let target: Value = serde_json::from_slice(&reply.body)
        .map_err(|e| format!("PUT /json/new did not answer JSON: {e}"))?;
    target["id"]
        .as_str()
        .filter(|id| is_target_id(id))
        .map(str::to_string)
        .ok_or_else(|| "PUT /json/new answered no target id".to_string())
}

/// Chrome unescapes `/json/new`'s query, and `http` refuses a path with spaces or control bytes.
fn encode_query(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    for b in url.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~:/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The Chrome's pages in `/json/list` order, which is newest first, with favicons and the active tabs.
pub fn list(port: u16, app_home: &Path, fetch_budget: usize) -> Result<Vec<Tab>, String> {
    let reply = http::get(port, "/json/list", HTTP_TIMEOUT)
        .map_err(|e| format!("GET http://127.0.0.1:{port}/json/list: {e}"))?;
    if reply.status != 200 {
        return Err(format!("GET /json/list answered {}", reply.status));
    }
    let targets: Vec<Value> = serde_json::from_slice(&reply.body)
        .map_err(|e| format!("/json/list is not a JSON list: {e}"))?;
    let pages: Vec<&Value> = targets.iter().filter(|t| is_page(t)).collect();
    let ids: Vec<&str> = pages.iter().filter_map(|t| t["id"].as_str()).collect();
    let focused = focused(port, &ids);
    let icon_urls: Vec<Option<&str>> = pages.iter().map(|t| t["faviconUrl"].as_str()).collect();
    let icons = match Favicons::open(app_home) {
        Some(mut f) => f.resolve(&icon_urls, fetch_budget),
        None => vec![None; pages.len()],
    };
    Ok(pages
        .iter()
        .zip(icons)
        .map(|(t, favicon)| {
            let id = t["id"].as_str().unwrap_or_default().to_string();
            Tab {
                active: focused.contains(&id),
                id,
                title: t["title"].as_str().unwrap_or_default().to_string(),
                url: t["url"].as_str().unwrap_or_default().to_string(),
                favicon,
            }
        })
        .collect())
}

/// A tab the user sees: DevTools windows and extension pages are pages to Chrome too.
fn is_page(t: &Value) -> bool {
    let url = t["url"].as_str().unwrap_or_default();
    t["type"] == "page"
        && t["id"].as_str().is_some_and(is_target_id)
        && !url.starts_with("devtools://")
        && !url.starts_with("chrome-extension://")
}

/// The pages where `document.hasFocus()` is true: each window's active tab, none for a blank one.
/// `/json/list` order says nothing about activation (phase 4 probe, answer b).
fn focused(port: u16, ids: &[&str]) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok((url, _)) = cdp::browser_ws(port) else {
        return out;
    };
    let Ok(mut c) = cdp::Cdp::connect(&url, CDP_TIMEOUT) else {
        return out;
    };
    let deadline = Instant::now() + FOCUS_BUDGET;
    for id in ids {
        if Instant::now() >= deadline {
            break;
        }
        let Ok(attached) = c.call(
            "Target.attachToTarget",
            json!({"targetId": id, "flatten": true}),
        ) else {
            continue;
        };
        let Some(session) = attached["sessionId"].as_str() else {
            continue;
        };
        let has_focus = c.call_session(
            session,
            "Runtime.evaluate",
            json!({"expression": "document.hasFocus()", "returnByValue": true}),
        );
        if has_focus.is_ok_and(|r| r["result"]["value"] == true) {
            out.insert(id.to_string());
        }
        let _ = c.call("Target.detachFromTarget", json!({"sessionId": session}));
    }
    out
}

/// The cached favicon for `url`, relative to the app home.
pub fn favicon_path(app_home: &Path, url: &str) -> Option<String> {
    let key = key(url);
    let dir = app_home.join(FAVICONS);
    EXTS.iter().find_map(|ext| {
        let file = dir.join(format!("{key}.{ext}"));
        let meta = fs::metadata(&file).ok().filter(fs::Metadata::is_file)?;
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > TOUCH_AFTER);
        if stale {
            if let Ok(f) = fs::File::options().write(true).open(&file) {
                let _ = f.set_modified(SystemTime::now());
            }
        }
        Some(format!("{FAVICONS}/{key}.{ext}"))
    })
}

/// Deletes favicon files last changed more than `max_age` ago.
pub fn prune(dir: &Path, max_age: Duration) {
    crate::chat::cache::prune(dir, max_age);
}

/// A 64-bit FNV-1a of the favicon URL, 16 hex digits.
fn key(url: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in url.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// The favicon folder and its `failed.json`: URL keys whose fetch failed, with when, kept for an hour.
struct Favicons {
    home: PathBuf,
    dir: PathBuf,
    failed: BTreeMap<String, i64>,
    changed: bool,
    now_ms: i64,
}

enum Source<'a> {
    Data(&'a str),
    Fetch(&'a str),
}

impl Favicons {
    /// None when Herdr's app home does not exist, so a machine without Herdr gets no folder made for it.
    fn open(app_home: &Path) -> Option<Favicons> {
        if !app_home.is_dir() {
            return None;
        }
        let dir = app_home.join(FAVICONS);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .ok()?;
        prune(&dir, KEEP_FAVICONS);
        let now_ms = now_ms();
        let read: BTreeMap<String, i64> = fs::read(dir.join("failed.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let before = read.len();
        let failed: BTreeMap<String, i64> = read
            .into_iter()
            .filter(|(_, at)| now_ms - at < FAILED_FOR_MS)
            .collect();
        Some(Favicons {
            home: app_home.to_path_buf(),
            changed: failed.len() != before,
            dir,
            failed,
            now_ms,
        })
    }

    /// One favicon path per URL; at most `budget` new fetches, run side by side.
    fn resolve(&mut self, urls: &[Option<&str>], budget: usize) -> Vec<Option<String>> {
        let mut found: HashMap<String, Option<String>> = HashMap::new();
        let mut todo: Vec<(String, Source)> = Vec::new();
        for url in urls.iter().flatten() {
            let k = key(url);
            if found.contains_key(&k) || todo.iter().any(|(t, _)| *t == k) {
                continue;
            }
            if let Some(path) = favicon_path(&self.home, url) {
                found.insert(k, Some(path));
            } else if self.failed.contains_key(&k) {
                found.insert(k, None);
            } else if url.starts_with("data:") {
                todo.push((k, Source::Data(url)));
            } else if (url.starts_with("http://") || url.starts_with("https://"))
                && todo
                    .iter()
                    .filter(|(_, s)| matches!(s, Source::Fetch(_)))
                    .count()
                    < budget
            {
                todo.push((k, Source::Fetch(url)));
            } else {
                found.insert(k, None);
            }
        }
        let got: Vec<(String, Option<Vec<u8>>)> = thread::scope(|s| {
            let handles: Vec<_> = todo
                .iter()
                .map(|(k, source)| {
                    s.spawn(move || {
                        let bytes = match source {
                            Source::Data(url) => decode_data(url),
                            Source::Fetch(url) => fetch(url),
                        };
                        (k.clone(), bytes)
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        for (k, bytes) in got {
            let path = bytes.and_then(|b| self.store(&k, &b));
            if path.is_none() {
                self.failed.insert(k.clone(), self.now_ms);
                self.changed = true;
            }
            found.insert(k, path);
        }
        if self.changed {
            let body = serde_json::to_vec(&self.failed).unwrap_or_default();
            let _ = write_file(&self.dir, "failed.json", &body);
        }
        urls.iter()
            .map(|url| url.and_then(|u| found.get(&key(u)).cloned().flatten()))
            .collect()
    }

    /// Writes an image under its format's extension; an ICO goes through `sips` to PNG first.
    fn store(&self, key: &str, bytes: &[u8]) -> Option<String> {
        let (ext, bytes) = match sniff(bytes)? {
            "ico" => ("png", self.ico_to_png(key, bytes)?),
            ext => (ext, bytes.to_vec()),
        };
        let name = format!("{key}.{ext}");
        write_file(&self.dir, &name, &bytes).ok()?;
        Some(format!("{FAVICONS}/{name}"))
    }

    fn ico_to_png(&self, key: &str, ico: &[u8]) -> Option<Vec<u8>> {
        let pid = std::process::id();
        let input = self.dir.join(format!(".{key}.{pid}.ico"));
        let output = self.dir.join(format!(".{key}.{pid}.png"));
        let converted = (|| {
            fs::write(&input, ico).ok()?;
            let sips = std::env::var_os("BW_SIPS").unwrap_or_else(|| "/usr/bin/sips".into());
            let ok = Command::new(sips)
                .args(["-s", "format", "png"])
                .arg(&input)
                .arg("--out")
                .arg(&output)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            let png = fs::read(&output).ok().filter(|_| ok)?;
            (png.len() <= MAX_ICON && sniff(&png) == Some("png")).then_some(png)
        })();
        let _ = fs::remove_file(&input);
        let _ = fs::remove_file(&output);
        converted
    }
}

/// The image format by magic bytes, as a file extension.
fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if b.starts_with(b"\xff\xd8\xff") {
        return Some("jpg");
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some("webp");
    }
    if b.starts_with(b"\0\0\x01\0") {
        return Some("ico");
    }
    let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    (head.starts_with('<') && head.contains("<svg") && !head.contains("<html")).then_some("svg")
}

/// A `data:` URL's bytes, base64 or percent-encoded.
fn decode_data(url: &str) -> Option<Vec<u8>> {
    let (meta, data) = url.strip_prefix("data:")?.split_once(',')?;
    let bytes = if meta.ends_with(";base64") {
        let clean: String = percent_decode(data)
            .into_iter()
            .filter(|b| !b.is_ascii_whitespace())
            .map(char::from)
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(clean)
            .ok()?
    } else {
        percent_decode(data)
    };
    (bytes.len() <= MAX_ICON).then_some(bytes)
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// At most 64 KiB from `curl`; anything larger, slower than 3 s or not http(s) is a failure.
fn fetch(url: &str) -> Option<Vec<u8>> {
    let curl = std::env::var_os("BW_CURL").unwrap_or_else(|| "/usr/bin/curl".into());
    let mut child = Command::new(curl)
        .args([
            "-sS",
            "--max-time",
            "3",
            "--max-filesize",
            "65536",
            "--proto",
            "=http,https",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .map(|out| out.take(MAX_ICON as u64 + 1).read_to_end(&mut bytes));
    if bytes.len() > MAX_ICON {
        let _ = child.kill();
    }
    let ok = child.wait().is_ok_and(|s| s.success());
    (ok && matches!(read, Some(Ok(_))) && bytes.len() <= MAX_ICON).then_some(bytes)
}

/// A temp file renamed over, so Herdr never draws half an icon.
fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        fs::rename(&tmp, dir.join(name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_16_hex() {
        assert_eq!(key(""), "cbf29ce484222325");
        assert_eq!(key("a"), "af63dc4c8601ec8c");
        assert_eq!(key("http://x/").len(), 16);
    }

    #[test]
    fn sniff_names_each_format() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0"), Some("jpg"));
        assert_eq!(sniff(b"GIF89a.."), Some("gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff(b"\0\0\x01\0\x01\0"), Some("ico"));
        assert_eq!(
            sniff(b"\xef\xbb\xbf <?xml version=\"1.0\"?><svg/>"),
            Some("svg")
        );
        assert_eq!(sniff(b"<!doctype html><html><svg></svg></html>"), None);
        assert_eq!(sniff(b"hello"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn data_urls_decode() {
        assert_eq!(
            decode_data("data:image/png;base64,aGk="),
            Some(b"hi".to_vec())
        );
        assert_eq!(
            decode_data("data:image/png;base64,aA%3D%3D"),
            Some(b"h".to_vec())
        );
        assert_eq!(decode_data("data:,a%20b"), Some(b"a b".to_vec()));
        assert_eq!(
            decode_data("data:image/svg+xml,%3Csvg%3E"),
            Some(b"<svg>".to_vec())
        );
        assert_eq!(decode_data("data:image/png;base64"), None);
        assert_eq!(decode_data("http://x/,y"), None);
        let big = format!("data:,{}", "a".repeat(MAX_ICON + 1));
        assert_eq!(decode_data(&big), None);
    }

    #[test]
    fn percent_decode_leaves_bad_escapes() {
        assert_eq!(percent_decode("%41%zz%4"), b"A%zz%4".to_vec());
    }

    #[test]
    fn query_keeps_only_unreserved_bytes() {
        assert_eq!(encode_query("about:blank"), "about:blank");
        assert_eq!(
            encode_query("https://a.b/c d?e=f&g#h"),
            "https://a.b/c%20d%3Fe%3Df%26g%23h"
        );
        assert_eq!(encode_query("x\r\ny"), "x%0D%0Ay");
    }

    #[test]
    fn target_ids_are_plain() {
        assert!(is_target_id("DB8645583CC586952CA123D5F36E6BB3"));
        for bad in ["", "a/b", "a?b", "a b", "..", "a%2F"] {
            assert!(!is_target_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn favicon_path_finds_a_cached_file() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(FAVICONS);
        fs::create_dir_all(&dir).unwrap();
        let url = "http://127.0.0.1:9/i.gif";
        assert_eq!(favicon_path(home.path(), url), None);
        fs::write(dir.join(format!("{}.gif", key(url))), b"GIF89a").unwrap();
        assert_eq!(
            favicon_path(home.path(), url),
            Some(format!("{FAVICONS}/{}.gif", key(url)))
        );
    }
}
