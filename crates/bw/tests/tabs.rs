//! `bw browser tabs|focus|close|new` against an in-test DevTools HTTP server and CDP WebSocket on free
//! 127.0.0.1 ports, with fake `curl` and `sips` for favicons and a fake argv reader that makes the in-test
//! server the Bellwether Chrome or another program.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tungstenite::Message;

// Only `serial` is used here.
#[allow(dead_code)]
#[path = "support/ports.rs"]
mod ports;
use ports::serial;
#[path = "support/argv.rs"]
mod argv;
use argv::{chrome_argv, fake_argv};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10\x08\x06\0\0\0\x1f\xf3\xffa";
const ICO: &[u8] = b"\0\0\x01\0\x01\0\x10\x10\0\0\x01\0 \0h\x04\0\0\x16\0\0\0";
const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"></svg>";

/// What the fake Chrome holds and what it was asked.
#[derive(Default)]
struct State {
    list: Value,
    focused: HashSet<String>,
    requests: Vec<String>,
    cdp: Vec<Value>,
}

struct Chrome {
    port: u16,
    state: Arc<Mutex<State>>,
}

impl Chrome {
    fn start(list: Value, focused: &[&str]) -> Chrome {
        let state = Arc::new(Mutex::new(State {
            list,
            focused: focused.iter().map(|s| s.to_string()).collect(),
            ..State::default()
        }));
        let ws = TcpListener::bind("127.0.0.1:0").unwrap();
        let ws_port = ws.local_addr().unwrap().port();
        let s = state.clone();
        thread::spawn(move || {
            for stream in ws.incoming().flatten() {
                let s = s.clone();
                thread::spawn(move || serve_cdp(stream, &s));
            }
        });
        let http = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = http.local_addr().unwrap().port();
        let s = state.clone();
        thread::spawn(move || {
            for stream in http.incoming().flatten() {
                let s = s.clone();
                thread::spawn(move || serve_http(stream, &s, ws_port));
            }
        });
        Chrome { port, state }
    }

    fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }

    fn cdp(&self) -> Vec<Value> {
        self.state.lock().unwrap().cdp.clone()
    }

    fn set_focused(&self, focused: &[&str]) {
        self.state.lock().unwrap().focused = focused.iter().map(|s| s.to_string()).collect();
    }
}

fn serve_http(mut stream: TcpStream, state: &Mutex<State>, ws_port: u16) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8(head).unwrap();
    let line = head.lines().next().unwrap_or("").to_string();
    let mut parts = line.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let (status, body) = {
        let mut s = state.lock().unwrap();
        s.requests.push(format!("{method} {path}"));
        let known = |id: &str| {
            s.list
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["id"] == id || id == "NEWTAB")
        };
        match (method.as_str(), path.as_str()) {
            ("GET", "/json/version") => (
                200,
                json!({"Browser": "Chrome/156.0.8078.80",
                    "webSocketDebuggerUrl": format!("ws://127.0.0.1:{ws_port}/devtools/browser/test-browser")})
                .to_string(),
            ),
            ("GET", "/json/list") => (200, s.list.to_string()),
            ("GET", p) if p.starts_with("/json/activate/") => {
                let id = &p["/json/activate/".len()..];
                if known(id) {
                    (200, "Target activated".to_string())
                } else {
                    (404, format!("No such target id: {id}"))
                }
            }
            ("GET", p) if p.starts_with("/json/close/") => {
                let id = &p["/json/close/".len()..];
                if known(id) {
                    (200, "Target is closing".to_string())
                } else {
                    (404, format!("No such target id: {id}"))
                }
            }
            ("PUT", p) if p.starts_with("/json/new") => (
                200,
                json!({"id": "NEWTAB", "type": "page", "title": "", "url": p.split_once('?').map(|x| x.1).unwrap_or("about:blank")})
                .to_string(),
            ),
            ("GET", p) if p.starts_with("/json/new") => (
                405,
                "Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb."
                    .to_string(),
            ),
            _ => (404, "not found".to_string()),
        }
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

fn serve_cdp(stream: TcpStream, state: &Mutex<State>) {
    let Ok(mut ws) = tungstenite::accept(stream) else {
        return;
    };
    while let Ok(msg) = ws.read() {
        let Message::Text(text) = msg else {
            if msg.is_close() {
                break;
            }
            continue;
        };
        let req: Value = serde_json::from_str(text.as_str()).unwrap();
        let reply = {
            let mut s = state.lock().unwrap();
            s.cdp.push(req.clone());
            let id = req["id"].clone();
            match req["method"].as_str().unwrap_or("") {
                "Target.attachToTarget" => {
                    let target = req["params"]["targetId"].as_str().unwrap_or("");
                    json!({"id": id, "result": {"sessionId": format!("s-{target}")}})
                }
                "Runtime.evaluate" => {
                    let target = req["sessionId"]
                        .as_str()
                        .and_then(|s| s.strip_prefix("s-"))
                        .unwrap_or("");
                    let focused = !target.is_empty()
                        && req["params"]["expression"] == "document.hasFocus()"
                        && s.focused.contains(target);
                    json!({"id": id, "sessionId": req["sessionId"],
                        "result": {"result": {"type": "boolean", "value": focused}}})
                }
                "Target.detachFromTarget" => json!({"id": id, "result": {}}),
                other => {
                    json!({"id": id, "error": {"code": -32601, "message": format!("'{other}' wasn't found")}})
                }
            }
        };
        // An unrelated event first, as Chrome sends them on the same socket.
        let _ = ws.send(Message::text(
            json!({"method": "Target.targetInfoChanged", "params": {}}).to_string(),
        ));
        let _ = ws.send(Message::text(reply.to_string()));
    }
}

/// A scratch HOME and app home, fake `curl` and `sips`, and the favicon files the fake `curl` serves.
struct Scratch {
    dir: tempfile::TempDir,
}

impl Scratch {
    fn new() -> Scratch {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("app")).unwrap();
        fs::create_dir_all(dir.path().join("served")).unwrap();
        write_script(
            &dir.path().join("curl"),
            // The URL is the last argument; it serves the file named by its last path segment.
            "for a; do url=$a; done\nprintf '%s\\n' \"$*\" >> \"$FAKE_DIR/curl.log\"\n\
             f=\"$FAKE_DIR/served/${url##*/}\"\n[ -f \"$f\" ] || { echo 'curl: (22) 404' >&2; exit 22; }\ncat \"$f\"\n",
        );
        write_script(
            &dir.path().join("sips"),
            "printf '%s\\n' \"$*\" >> \"$FAKE_DIR/sips.log\"\nfor a; do last=$a; done\n\
             cp \"$FAKE_DIR/converted.png\" \"$last\"\n",
        );
        fs::write(dir.path().join("converted.png"), PNG).unwrap();
        let scratch = Scratch { dir };
        scratch.listener_runs(&chrome_argv(&scratch.profile(), 9222));
        scratch
    }

    fn profile(&self) -> PathBuf {
        self.path().join("profile")
    }

    /// Every pid, so the in-test server too, runs `argv` to the argv reader.
    fn listener_runs(&self, argv: &[String]) {
        fake_argv(&self.path().join("argv"), Some(argv));
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn serve(&self, name: &str, bytes: &[u8]) {
        fs::write(self.path().join("served").join(name), bytes).unwrap();
    }

    fn favicons(&self) -> PathBuf {
        self.path().join("app/data/bellwether/favicons")
    }

    fn log(&self, name: &str) -> Vec<String> {
        fs::read_to_string(self.path().join(name))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn bw(&self, port: u16, args: &[&str]) -> Output {
        self.bw_with(port, args, &[])
    }

    fn bw_with(&self, port: u16, args: &[&str], env: &[(&str, &str)]) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.arg("browser")
            .args(args)
            .env("HOME", self.path())
            .env("HERDR_APP_HOME", self.path().join("app"))
            .env("BW_CHROME_PORT", port.to_string())
            .env("BW_CHROME_PROFILE", self.profile())
            .env("BW_PROC_ARGV", self.path().join("argv"))
            .env("BW_CURL", self.path().join("curl"))
            .env("BW_SIPS", self.path().join("sips"))
            .env("FAKE_DIR", self.path())
            .stdin(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.output().expect("run bw")
    }
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn lines(out: &Output) -> Vec<Value> {
    String::from_utf8(out.stdout.clone())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
        .collect()
}

fn page(id: &str, url: &str, favicon: Option<&str>) -> Value {
    let mut v = json!({"id": id, "type": "page", "title": format!("Title {id}"), "url": url,
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:1/devtools/page/{id}")});
    if let Some(f) = favicon {
        v["faviconUrl"] = json!(f);
    }
    v
}

fn fixture_list() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/browser/json-list.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn fnv16(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

#[test]
fn lists_pages_only() {
    let _serial = serial();
    let chrome = Chrome::start(fixture_list(), &[]);
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let tabs = lines(&out);
    let titles: Vec<&str> = tabs.iter().map(|t| t["title"].as_str().unwrap()).collect();
    assert_eq!(
        titles,
        [
            "about:blank",
            "doc.pdf",
            "Probe SW",
            "Probe c",
            "Probe B",
            "Probe A",
            "New Tab"
        ]
    );
    for t in &tabs {
        assert_eq!(t["type"], "tab");
        let keys: Vec<&String> = t.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["type", "id", "title", "url", "favicon", "active"],
            "{t}"
        );
        assert_eq!(t["active"], false, "{t}");
    }
}

#[test]
fn active_comes_from_has_focus() {
    let _serial = serial();
    // Window 1 holds A, B, C with B active; window 2 holds W2. A is first in /json/list.
    let list = json!([
        page("A", "http://127.0.0.1:9/a.html", None),
        page("W2", "http://127.0.0.1:9/w2.html", None),
        page("C", "http://127.0.0.1:9/c.html", None),
        page("B", "http://127.0.0.1:9/b.html", None),
    ]);
    let chrome = Chrome::start(list, &["B", "W2"]);
    let scratch = Scratch::new();
    // The fake Chrome's listener is this test process, so its pid in front means Chrome is in front.
    let me = std::process::id().to_string();
    let out = scratch.bw_with(chrome.port, &["tabs"], &[("BW_FRONT_PID", &me)]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(active_ids(&out), ["W2", "B"]);

    let cdp = chrome.cdp();
    let attached: Vec<&Value> = cdp
        .iter()
        .filter(|r| r["method"] == "Target.attachToTarget")
        .collect();
    assert_eq!(attached.len(), 4, "{cdp:?}");
    for r in &attached {
        assert_eq!(r["params"]["flatten"], true, "{r}");
    }
    let evaluated: Vec<&Value> = cdp
        .iter()
        .filter(|r| r["method"] == "Runtime.evaluate")
        .collect();
    assert_eq!(evaluated.len(), 4, "{cdp:?}");
    for r in &evaluated {
        assert!(r["sessionId"].as_str().unwrap().starts_with("s-"), "{r}");
    }
    let detached = cdp
        .iter()
        .filter(|r| r["method"] == "Target.detachFromTarget")
        .count();
    assert_eq!(detached, 4, "{cdp:?}");

    // A fresh blank page as the active tab reports no focus anywhere.
    chrome.set_focused(&[]);
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert!(lines(&out).iter().all(|t| t["active"] == false), "{out:?}");
}

fn active_ids(out: &Output) -> Vec<String> {
    lines(out)
        .iter()
        .filter(|t| t["active"] == true)
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect()
}

fn three_pages() -> Value {
    json!([
        page("A", "http://127.0.0.1:9/a.html", None),
        page("B", "http://127.0.0.1:9/b.html", None),
        page("W2", "http://127.0.0.1:9/w2.html", None),
    ])
}

#[test]
fn fallback_marks_the_last_focused_tab_when_none_has_focus() {
    let _serial = serial();
    let chrome = Chrome::start(three_pages(), &[]);
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["focus", "--id", "W2"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    // Herdr is in front: no tab reports focus, so the tab Bellwether focused stands in.
    let out = scratch.bw_with(chrome.port, &["tabs"], &[("BW_FRONT_PID", "1")]);
    assert_eq!(active_ids(&out), ["W2"]);
}

#[test]
fn fallback_ignores_background_focus() {
    let _serial = serial();
    // Tabs an agent opened in the background all report focus while Herdr is in front.
    let chrome = Chrome::start(three_pages(), &["A", "B", "W2"]);
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["focus", "--id", "B"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let out = scratch.bw_with(chrome.port, &["tabs"], &[("BW_FRONT_PID", "1")]);
    assert_eq!(active_ids(&out), ["B"]);
}

#[test]
fn fallback_forgets_a_closed_tab() {
    let _serial = serial();
    let chrome = Chrome::start(three_pages(), &[]);
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["focus", "--id", "B"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let chrome2 = Chrome::start(json!([page("A", "http://127.0.0.1:9/a.html", None)]), &[]);
    let out = scratch.bw_with(chrome2.port, &["tabs"], &[("BW_FRONT_PID", "1")]);
    assert!(active_ids(&out).is_empty(), "{out:?}");
}

#[test]
fn tabs_without_chrome_is_an_error() {
    let _serial = serial();
    let free = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let scratch = Scratch::new();
    let out = scratch.bw(free, &["tabs"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let l = lines(&out);
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["type"], "error");
    assert_eq!(l[0]["code"], "chrome_unreachable");
}

#[test]
fn new_uses_put() {
    let _serial = serial();
    let chrome = Chrome::start(json!([page("A", "about:blank", None)]), &[]);
    let scratch = Scratch::new();
    let out = scratch.bw(
        chrome.port,
        &["new", "--url", "http://127.0.0.1:9/a b?x=1&y=é#top"],
    );
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(
        lines(&out),
        [
            json!({"type": "tab-action", "action": "new", "id": "NEWTAB", "ok": true, "message": "opened"})
        ]
    );
    let out = scratch.bw(chrome.port, &["new"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    // Each command first checks the listener is the Bellwether Chrome, which reads /json/version twice.
    assert_eq!(
        chrome.requests(),
        [
            "GET /json/version",
            "GET /json/version",
            "PUT /json/new?http://127.0.0.1:9/a%20b%3Fx%3D1%26y%3D%C3%A9%23top",
            "GET /json/activate/NEWTAB",
            "GET /json/version",
            "GET /json/version",
            "PUT /json/new?about:blank",
            "GET /json/activate/NEWTAB",
        ]
    );
}

#[test]
fn focus_and_close_hit_the_id() {
    let _serial = serial();
    let chrome = Chrome::start(json!([page("AB12", "about:blank", None)]), &[]);
    let scratch = Scratch::new();

    let out = scratch.bw(chrome.port, &["focus", "--id", "AB12"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(
        lines(&out),
        [
            json!({"type": "tab-action", "action": "focus", "id": "AB12", "ok": true, "message": "Target activated"})
        ]
    );
    let out = scratch.bw(chrome.port, &["close", "--id", "AB12"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(lines(&out)[0]["action"], "close");
    assert_eq!(lines(&out)[0]["ok"], true);

    // Exit 0 with ok:false: shared/helper.js drops a failed command's output, and the panel shows this message.
    let out = scratch.bw(chrome.port, &["focus", "--id", "GONE"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let l = lines(&out);
    assert_eq!(l[0]["ok"], false);
    assert_eq!(l[0]["message"], "No such target id: GONE");

    for bad in ["../list", "A?x", "A/B", "A%20"] {
        let out = scratch.bw(chrome.port, &["close", "--id", bad]);
        assert_eq!(out.status.code(), Some(2), "{bad}: {out:?}");
    }
    let out = scratch.bw(chrome.port, &["focus"]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    // Usage errors exit before the ownership check, so they reach nothing.
    assert_eq!(
        chrome
            .requests()
            .into_iter()
            .filter(|r| r != "GET /json/version")
            .collect::<Vec<_>>(),
        [
            "GET /json/activate/AB12",
            "GET /json/close/AB12",
            "GET /json/activate/GONE"
        ]
    );
    assert_eq!(
        chrome.requests().len(),
        3 + 3 * 2,
        "{:?}",
        chrome.requests()
    );
}

/// Every command against a listener that is not the Bellwether Chrome: no request reaches it.
fn refuses_listener(argv: impl Fn(&Path) -> Vec<String>, why: &str) {
    let chrome = Chrome::start(json!([page("AB12", "about:blank", None)]), &[]);
    let scratch = Scratch::new();
    scratch.listener_runs(&argv(&scratch.profile()));
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert_eq!(out.status.code(), Some(1), "{why}: {out:?}");
    let l = lines(&out);
    assert_eq!(l.len(), 1, "{why}: {l:?}");
    assert_eq!(l[0]["type"], "error", "{why}");
    assert_eq!(l[0]["code"], "chrome_unreachable", "{why}");
    let message = l[0]["message"].as_str().unwrap();
    assert!(message.contains("(port_taken)"), "{why}: {message}");
    for args in [
        &["focus", "--id", "AB12"][..],
        &["close", "--id", "AB12"][..],
        &["new"][..],
    ] {
        let out = scratch.bw(chrome.port, args);
        assert_eq!(out.status.code(), Some(0), "{why} {args:?}: {out:?}");
        let l = lines(&out);
        assert_eq!(l.len(), 1, "{why} {args:?}: {l:?}");
        assert_eq!(l[0]["type"], "tab-action", "{why} {args:?}");
        assert_eq!(l[0]["action"], args[0], "{why} {args:?}");
        assert_eq!(l[0]["ok"], false, "{why} {args:?}");
        let message = l[0]["message"].as_str().unwrap();
        assert!(
            message.contains("another program"),
            "{why} {args:?}: {message}"
        );
        assert!(
            message.ends_with("(port_taken)"),
            "{why} {args:?}: {message}"
        );
    }
    assert!(
        chrome.requests().is_empty(),
        "{why}: {:?}",
        chrome.requests()
    );
    assert!(chrome.cdp().is_empty(), "{why}: {:?}", chrome.cdp());
}

#[test]
fn commands_refuse_another_program() {
    let _serial = serial();
    let argv = |_: &Path| ["python3", "-m", "http.server"].map(String::from).to_vec();
    refuses_listener(argv, "another program");
}

#[test]
fn commands_refuse_another_profile() {
    let _serial = serial();
    for suffix in ["-2", " other"] {
        let argv = |profile: &Path| {
            chrome_argv(Path::new(&format!("{}{suffix}", profile.display())), 9222)
        };
        refuses_listener(argv, suffix);
    }
}

#[test]
fn data_favicon_is_decoded() {
    let _serial = serial();
    let png_url = format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, PNG)
    );
    let svg_url = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2016%2016%22%3E%3C/svg%3E";
    let list = json!([
        page("A", "http://127.0.0.1:9/a.html", Some(&png_url)),
        page("S", "http://127.0.0.1:9/s.html", Some(svg_url)),
        page(
            "T",
            "http://127.0.0.1:9/t.html",
            Some("data:text/plain,hello")
        ),
    ]);
    let chrome = Chrome::start(list, &[]);
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["tabs"]);
    let tabs = lines(&out);
    let png_rel = format!("data/bellwether/favicons/{}.png", fnv16(&png_url));
    let svg_rel = format!("data/bellwether/favicons/{}.svg", fnv16(svg_url));
    assert_eq!(tabs[0]["favicon"], png_rel.as_str(), "{tabs:?}");
    assert_eq!(tabs[1]["favicon"], svg_rel.as_str(), "{tabs:?}");
    assert_eq!(tabs[2]["favicon"], Value::Null, "{tabs:?}");
    assert_eq!(
        fs::read(scratch.path().join("app").join(&png_rel)).unwrap(),
        PNG
    );
    assert_eq!(
        fs::read(scratch.path().join("app").join(&svg_rel)).unwrap(),
        SVG
    );
    assert!(scratch.log("curl.log").is_empty());
}

#[test]
fn favicon_fetch_budget_is_four() {
    let _serial = serial();
    let list: Vec<Value> = (1..=6)
        .map(|i| {
            page(
                &format!("P{i}"),
                &format!("http://127.0.0.1:9/{i}.html"),
                Some(&format!("http://127.0.0.1:9/icon{i}.png")),
            )
        })
        .collect();
    let chrome = Chrome::start(Value::Array(list), &[]);
    let scratch = Scratch::new();
    for i in 1..=6 {
        scratch.serve(&format!("icon{i}.png"), PNG);
    }
    let out = scratch.bw(chrome.port, &["tabs"]);
    let with: Vec<Value> = lines(&out)
        .into_iter()
        .filter(|t| t["favicon"].is_string())
        .collect();
    assert_eq!(with.len(), 4, "{out:?}");
    let log = scratch.log("curl.log");
    assert_eq!(log.len(), 4, "{log:?}");
    assert!(
        log[0].starts_with("-sS --max-time 3 --max-filesize 65536 --proto =http,https "),
        "{log:?}"
    );
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert!(
        lines(&out).iter().all(|t| t["favicon"].is_string()),
        "{out:?}"
    );
    assert_eq!(scratch.log("curl.log").len(), 6);
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert!(
        lines(&out).iter().all(|t| t["favicon"].is_string()),
        "{out:?}"
    );
    assert_eq!(
        scratch.log("curl.log").len(),
        6,
        "cached icons are fetched again"
    );
}

#[test]
fn failed_favicon_is_not_retried_within_an_hour() {
    let _serial = serial();
    let url = "http://127.0.0.1:9/missing.png";
    let chrome = Chrome::start(
        json!([page("A", "http://127.0.0.1:9/a.html", Some(url))]),
        &[],
    );
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(lines(&out)[0]["favicon"], Value::Null);
    assert_eq!(scratch.log("curl.log").len(), 1);
    scratch.bw(chrome.port, &["tabs"]);
    assert_eq!(scratch.log("curl.log").len(), 1, "retried within the hour");

    // An hour later the failure is forgotten and the icon, now served, is fetched.
    let failed = scratch.favicons().join("failed.json");
    let mut v: Value = serde_json::from_str(&fs::read_to_string(&failed).unwrap()).unwrap();
    let key = fnv16(url);
    assert!(v[&key].is_i64(), "{v}");
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    v[&key] = json!(now_ms - 61 * 60 * 1000);
    fs::write(&failed, v.to_string()).unwrap();
    scratch.serve("missing.png", PNG);
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert_eq!(scratch.log("curl.log").len(), 2);
    assert!(lines(&out)[0]["favicon"].is_string(), "{out:?}");
}

#[test]
fn ico_is_converted_or_dropped() {
    let _serial = serial();
    let url = "http://127.0.0.1:9/favicon.ico";
    let chrome = Chrome::start(
        json!([page("A", "http://127.0.0.1:9/a.html", Some(url))]),
        &[],
    );
    let scratch = Scratch::new();
    scratch.serve("favicon.ico", ICO);
    let out = scratch.bw(chrome.port, &["tabs"]);
    let rel = format!("data/bellwether/favicons/{}.png", fnv16(url));
    assert_eq!(lines(&out)[0]["favicon"], rel.as_str(), "{out:?}");
    assert_eq!(
        fs::read(scratch.path().join("app").join(&rel)).unwrap(),
        PNG
    );
    let sips = scratch.log("sips.log");
    assert_eq!(sips.len(), 1);
    assert!(sips[0].starts_with("-s format png "), "{sips:?}");

    // Without a working sips the icon is dropped, remembered as failed, and no temp file stays.
    let scratch = Scratch::new();
    scratch.serve("favicon.ico", ICO);
    let out = scratch.bw_with(chrome.port, &["tabs"], &[("BW_SIPS", "/usr/bin/false")]);
    assert_eq!(lines(&out)[0]["favicon"], Value::Null, "{out:?}");
    let names: Vec<String> = fs::read_dir(scratch.favicons())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["failed.json"]);
}

#[test]
fn non_image_and_non_http_favicons_are_dropped() {
    let _serial = serial();
    let list = json!([
        page(
            "H",
            "http://127.0.0.1:9/h.html",
            Some("http://127.0.0.1:9/page.html")
        ),
        page("F", "http://127.0.0.1:9/f.html", Some("file:///etc/passwd")),
        page("X", "http://127.0.0.1:9/x.html", Some("chrome://favicon/x")),
    ]);
    let chrome = Chrome::start(list, &[]);
    let scratch = Scratch::new();
    scratch.serve("page.html", b"<!doctype html><title>404</title>");
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert!(
        lines(&out).iter().all(|t| t["favicon"].is_null()),
        "{out:?}"
    );
    assert_eq!(scratch.log("curl.log").len(), 1);
}

#[test]
fn no_favicons_without_an_app_home() {
    let _serial = serial();
    let chrome = Chrome::start(
        json!([page(
            "A",
            "http://127.0.0.1:9/a.html",
            Some("http://127.0.0.1:9/i.png")
        )]),
        &[],
    );
    let scratch = Scratch::new();
    scratch.serve("i.png", PNG);
    let missing = scratch.path().join("no-app-home");
    let out = scratch.bw_with(
        chrome.port,
        &["tabs"],
        &[("HERDR_APP_HOME", missing.to_str().unwrap())],
    );
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(lines(&out)[0]["favicon"], Value::Null);
    assert!(!missing.exists());
}

#[test]
fn prune_drops_files_older_than_7_days() {
    let _serial = serial();
    let chrome = Chrome::start(json!([page("A", "about:blank", None)]), &[]);
    let scratch = Scratch::new();
    let dir = scratch.favicons();
    fs::create_dir_all(&dir).unwrap();
    let old = dir.join("0000000000000001.png");
    let fresh = dir.join("0000000000000002.png");
    fs::write(&old, PNG).unwrap();
    fs::write(&fresh, PNG).unwrap();
    let eight_days = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
    fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(eight_days)
        .unwrap();
    let out = scratch.bw(chrome.port, &["tabs"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(!old.exists());
    assert!(fresh.exists());
}

#[test]
fn fallback_beats_one_background_tab_while_herdr_is_in_front() {
    let _serial = serial();
    // One agent opened one tab in the background: it alone reports focus while Herdr is in front.
    let chrome = Chrome::start(three_pages(), &["A"]);
    let scratch = Scratch::new();
    let out = scratch.bw(chrome.port, &["focus", "--id", "B"]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let out = scratch.bw_with(chrome.port, &["tabs"], &[("BW_FRONT_PID", "1")]);
    assert_eq!(active_ids(&out), ["B"]);
}
