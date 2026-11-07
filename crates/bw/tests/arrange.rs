//! `bw browser arrange`: the placement rule, and the CDP calls against an in-test Chrome stand-in
//! that serves `/json/version`, `/json/list`, the browser WebSocket and each page's WebSocket on one
//! 127.0.0.1 port.
//!
//! bw has no library target, so the browser modules are compiled into this test under their own paths.

// `arrange.rs` reaches its siblings as `super::<name>`, which are these; parts unused here are dead.
#[allow(dead_code)]
#[path = "../src/browser/arrange.rs"]
mod arrange;
#[allow(dead_code)]
#[path = "../src/browser/cdp.rs"]
mod cdp;
#[allow(dead_code)]
#[path = "../src/browser/chrome.rs"]
mod chrome;
#[allow(dead_code)]
#[path = "../src/browser/http.rs"]
mod http;
#[allow(dead_code)]
#[path = "../src/browser/listen.rs"]
mod listen;
#[allow(dead_code)]
#[path = "../src/browser/lock.rs"]
mod lock;
#[allow(dead_code)]
#[path = "../src/browser/pages.rs"]
mod pages;

/// The binary's `usage`, which `arrange.rs` and `chrome.rs` reach as `crate::usage`; these tests run
/// the binary for its usage errors.
#[allow(dead_code)]
fn usage(_message: &str) -> std::process::ExitCode {
    std::process::ExitCode::from(2)
}

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::Message;

use arrange::{arrange, place, Bounds, Rect};

#[path = "support/argv.rs"]
mod argv;

fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

const MAIN: Rect = Rect {
    x: 0.0,
    y: 0.0,
    w: 1920.0,
    h: 1080.0,
};

#[test]
fn place_right_when_gap_fits() {
    let (bounds, side) = place(r(0.0, 25.0, 1000.0, 1000.0), &[MAIN], 640.0);
    assert_eq!(side, "right");
    assert_eq!(bounds, r(1000.0, 25.0, 920.0, 1000.0));
}

#[test]
fn place_left_when_only_left_fits() {
    let (bounds, side) = place(r(900.0, 40.0, 1020.0, 900.0), &[MAIN], 640.0);
    assert_eq!(side, "left");
    assert_eq!(bounds, r(0.0, 40.0, 900.0, 900.0));
}

#[test]
fn place_over_right_half_when_neither_fits() {
    let (bounds, side) = place(r(0.0, 31.0, 1920.0, 1049.0), &[MAIN], 640.0);
    assert_eq!(side, "over");
    assert_eq!(bounds, r(960.0, 31.0, 960.0, 1049.0));

    // A gap of 639 points on each side is still too narrow.
    let (_, side) = place(r(639.0, 31.0, 642.0, 1049.0), &[MAIN], 640.0);
    assert_eq!(side, "over");
    // Exactly the minimum fits.
    let (bounds, side) = place(r(0.0, 31.0, 1280.0, 1049.0), &[MAIN], 640.0);
    assert_eq!(side, "right");
    assert_eq!(bounds.w, 640.0);
}

#[test]
fn place_uses_the_display_holding_herdrs_centre() {
    let left = r(-1440.0, 0.0, 1440.0, 900.0);
    let displays = [MAIN, left];
    // Herdr's centre (-1100, 450) is on the left display, so the gap to its right ends at x = 0.
    let (bounds, side) = place(r(-1400.0, 50.0, 600.0, 800.0), &displays, 640.0);
    assert_eq!(side, "right");
    assert_eq!(bounds, r(-800.0, 50.0, 800.0, 800.0));

    // A window straddling both displays belongs to the one holding its centre (main here).
    let (bounds, side) = place(r(-200.0, 100.0, 1000.0, 700.0), &displays, 640.0);
    assert_eq!(side, "right");
    assert_eq!(bounds, r(800.0, 100.0, 1120.0, 700.0));

    // Herdr maximized on the left display: Chrome covers that display's right half.
    let (bounds, side) = place(r(-1440.0, 25.0, 1440.0, 875.0), &displays, 640.0);
    assert_eq!(side, "over");
    assert_eq!(bounds, r(-720.0, 25.0, 720.0, 875.0));
}

#[test]
fn place_keeps_herdrs_top_and_height() {
    for herdr in [
        r(0.0, 25.0, 1000.0, 1000.0),
        r(900.0, 400.0, 1020.0, 300.0),
        r(10.0, 77.0, 1900.0, 640.0),
    ] {
        let (bounds, _) = place(herdr, &[MAIN], 640.0);
        assert_eq!((bounds.y, bounds.h), (herdr.y, herdr.h), "{herdr:?}");
    }
}

#[test]
fn place_with_herdr_off_every_display_uses_the_most_overlapped_one() {
    let right = r(1920.0, 0.0, 1920.0, 1080.0);
    // Centre (1950, 1100) is below both displays; most of the window overlaps the right one.
    let (bounds, side) = place(r(1500.0, 900.0, 900.0, 400.0), &[MAIN, right], 640.0);
    assert_eq!(side, "right");
    assert_eq!(bounds, r(2400.0, 900.0, 1440.0, 400.0));
}

/// The stand-in's mutable window: its state and its normal bounds, as Chrome 156 keeps them.
#[derive(Clone)]
struct Window {
    state: String,
    normal: Bounds,
}

struct FakeChrome {
    port: u16,
    /// Every `Browser.*` request on the browser WebSocket, in order; the focus reads are left out.
    calls: Arc<Mutex<Vec<Value>>>,
}

/// `pages` are (target id, `document.hasFocus()`); every page sits in window 7.
fn fake_chrome(pages: &[(&str, bool)], window: Window) -> FakeChrome {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let window = Arc::new(Mutex::new(window));
    let pages: Vec<(String, bool)> = pages.iter().map(|(i, f)| (i.to_string(), *f)).collect();
    let seen = Arc::clone(&calls);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let (pages, seen, window) = (pages.clone(), Arc::clone(&seen), Arc::clone(&window));
            thread::spawn(move || serve(stream, port, &pages, &seen, &window));
        }
    });
    FakeChrome { port, calls }
}

// tungstenite's `accept_hdr` callback type fixes the large `Err` variant.
#[allow(clippy::result_large_err)]
fn serve(
    mut stream: TcpStream,
    port: u16,
    pages: &[(String, bool)],
    seen: &Mutex<Vec<Value>>,
    window: &Mutex<Window>,
) {
    let mut buf = [0u8; 4096];
    let head = loop {
        let n = stream.peek(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        if n == 0 || head.contains("\r\n\r\n") {
            break head;
        }
    };
    if head.to_ascii_lowercase().contains("upgrade: websocket") {
        let mut path = String::new();
        let mut ws = tungstenite::accept_hdr(stream, |req: &Request, res: Response| {
            path = req.uri().path().to_string();
            Ok(res)
        })
        .unwrap();
        while let Ok(msg) = ws.read() {
            let Message::Text(text) = msg else {
                if msg.is_close() {
                    break;
                }
                continue;
            };
            let req: Value = serde_json::from_str(text.as_str()).unwrap();
            assert_eq!(path, "/devtools/browser/test-id");
            let reply = match req["method"].as_str().unwrap() {
                "Target.attachToTarget" => {
                    let target = req["params"]["targetId"].as_str().unwrap();
                    json!({"id": req["id"], "result": {"sessionId": format!("s-{target}")}})
                }
                "Runtime.evaluate" => {
                    let session = req["sessionId"].as_str().unwrap();
                    assert_eq!(req["params"]["expression"], "document.hasFocus()");
                    let focus = pages.iter().any(|(p, f)| session == format!("s-{p}") && *f);
                    json!({"id": req["id"], "sessionId": session,
                           "result": {"result": {"type": "boolean", "value": focus}}})
                }
                "Target.detachFromTarget" => json!({"id": req["id"], "result": {}}),
                _ => {
                    seen.lock().unwrap().push(req.clone());
                    json!({"id": req["id"], "result": browser_reply(&req, window)})
                }
            };
            ws.send(Message::text(reply.to_string())).unwrap();
        }
        return;
    }
    let mut sink = vec![0u8; head.find("\r\n\r\n").map_or(0, |i| i + 4)];
    stream.read_exact(&mut sink).unwrap();
    let body = if head.starts_with("GET /json/version ") {
        json!({
            "Browser": "Chrome/156.0.8078.80",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/test-id"),
        })
    } else if head.starts_with("GET /json/list ") {
        let mut list: Vec<Value> = pages
            .iter()
            .map(|(id, _)| json!({"id": id, "type": "page", "url": format!("http://127.0.0.1/{id}")}))
            .collect();
        list.insert(
            0,
            json!({"id": "SW", "type": "service_worker", "url": "http://127.0.0.1/sw.js"}),
        );
        list.push(
            json!({"id": "DEVTOOLS", "type": "page", "url": "devtools://devtools/inspector.html"}),
        );
        Value::Array(list)
    } else {
        panic!("unexpected request {head:?}");
    };
    let body = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
}

/// Chrome 156 as the probe found it: bounds sent to a maximized window restore its old normal bounds.
fn browser_reply(req: &Value, window: &Mutex<Window>) -> Value {
    let mut w = window.lock().unwrap();
    let bounds = |w: &Window| {
        json!({"left": w.normal.left, "top": w.normal.top, "width": w.normal.width,
               "height": w.normal.height, "windowState": w.state})
    };
    match req["method"].as_str().unwrap() {
        "Browser.getWindowForTarget" => json!({"windowId": 7, "bounds": bounds(&w)}),
        "Browser.getWindowBounds" => json!({"bounds": bounds(&w)}),
        "Browser.setWindowBounds" => {
            assert_eq!(req["params"]["windowId"], 7);
            let b = &req["params"]["bounds"];
            if let Some(state) = b["windowState"].as_str() {
                w.state = state.to_string();
            } else if w.state == "normal" {
                w.normal = Bounds {
                    left: b["left"].as_i64().unwrap(),
                    top: b["top"].as_i64().unwrap(),
                    width: b["width"].as_i64().unwrap(),
                    height: b["height"].as_i64().unwrap(),
                };
            } else {
                w.state = "normal".to_string();
            }
            json!({})
        }
        other => panic!("unexpected browser call {other}"),
    }
}

fn methods(calls: &[Value]) -> Vec<String> {
    calls
        .iter()
        .map(|c| c["method"].as_str().unwrap().to_string())
        .collect()
}

const OLD: Bounds = Bounds {
    left: 120,
    top: 140,
    width: 900,
    height: 640,
};

#[test]
fn arrange_normalizes_then_sets_bounds() {
    let chrome = fake_chrome(
        &[("PAGE1", true)],
        Window {
            state: "maximized".into(),
            normal: OLD,
        },
    );
    let got = arrange(chrome.port, r(0.0, 25.0, 1000.0, 1000.0), &[MAIN]);
    assert_eq!(got.state, "placed", "{}", got.message);
    assert_eq!(got.side, Some("right"));
    let want = Bounds {
        left: 1000,
        top: 25,
        width: 920,
        height: 1000,
    };
    assert_eq!(got.bounds, Some(want));
    assert_eq!(got.message, "Placed right of Herdr");

    let calls = chrome.calls.lock().unwrap().clone();
    let sets: Vec<&Value> = calls
        .iter()
        .filter(|c| c["method"] == "Browser.setWindowBounds")
        .collect();
    assert_eq!(sets.len(), 2, "{calls:?}");
    assert_eq!(
        sets[0]["params"],
        json!({"windowId": 7, "bounds": {"windowState": "normal"}})
    );
    assert_eq!(
        sets[1]["params"],
        json!({"windowId": 7, "bounds": {"left": 1000, "top": 25, "width": 920, "height": 1000}})
    );
    assert_eq!(methods(&calls)[0], "Browser.getWindowForTarget");
}

#[test]
fn arrange_on_a_normal_window_sets_bounds_once() {
    let chrome = fake_chrome(
        &[("PAGE1", true)],
        Window {
            state: "normal".into(),
            normal: OLD,
        },
    );
    let got = arrange(chrome.port, r(0.0, 31.0, 1920.0, 1049.0), &[MAIN]);
    assert_eq!(got.state, "placed", "{}", got.message);
    assert_eq!(got.side, Some("over"));
    assert_eq!(
        got.message,
        "No room beside Herdr: Chrome covers the right half"
    );
    let calls = chrome.calls.lock().unwrap().clone();
    assert_eq!(
        methods(&calls),
        [
            "Browser.getWindowForTarget",
            "Browser.setWindowBounds",
            "Browser.getWindowBounds"
        ]
    );
}

#[test]
fn arrange_uses_active_page_target() {
    let chrome = fake_chrome(
        &[("NEWEST", false), ("FOCUSED", true), ("OLDEST", false)],
        Window {
            state: "normal".into(),
            normal: OLD,
        },
    );
    let got = arrange(chrome.port, r(900.0, 40.0, 1020.0, 900.0), &[MAIN]);
    assert_eq!(got.state, "placed", "{}", got.message);
    assert_eq!(got.message, "Placed left of Herdr");
    let calls = chrome.calls.lock().unwrap().clone();
    assert_eq!(
        calls[0]["params"],
        json!({"targetId": "FOCUSED"}),
        "{calls:?}"
    );
}

#[test]
fn arrange_without_a_focused_page_uses_the_first_page() {
    let chrome = fake_chrome(
        &[("NEWEST", false), ("OLDEST", false)],
        Window {
            state: "normal".into(),
            normal: OLD,
        },
    );
    let got = arrange(chrome.port, r(0.0, 25.0, 1000.0, 1000.0), &[MAIN]);
    assert_eq!(got.state, "placed", "{}", got.message);
    let calls = chrome.calls.lock().unwrap().clone();
    assert_eq!(calls[0]["params"], json!({"targetId": "NEWEST"}));
}

#[test]
fn arrange_with_no_page_fails() {
    let chrome = fake_chrome(
        &[],
        Window {
            state: "normal".into(),
            normal: OLD,
        },
    );
    let got = arrange(chrome.port, r(0.0, 25.0, 1000.0, 1000.0), &[MAIN]);
    assert_eq!(got.state, "failed");
    assert!(got.message.contains("no open window"), "{}", got.message);
    assert!(chrome.calls.lock().unwrap().is_empty());
}

#[test]
fn arrange_on_a_closed_port_is_chrome_not_running() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let got = arrange(port, r(0.0, 25.0, 1000.0, 1000.0), &[MAIN]);
    assert_eq!(got.state, "chrome_not_running", "{}", got.message);
}

fn bw_arrange(port: u16, profile: &Path, fakes: &Path) -> (Value, i32) {
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args(["browser", "arrange", "--owner-pid", "1"])
        .env("BW_CHROME_PORT", port.to_string())
        .env("BW_CHROME_PROFILE", profile)
        .env("BW_PS", fakes.join("ps"))
        .env("BW_PROC_ARGV", fakes.join("argv"))
        .stdin(Stdio::null())
        .output()
        .expect("run bw");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let line: Value =
        serde_json::from_str(stdout.trim()).unwrap_or_else(|e| panic!("{stdout:?}: {e}"));
    (line, out.status.code().unwrap())
}

/// A `ps` and an argv reader in `dir` that see `argv` for any pid; `dir`.
fn fake_ps<'a>(dir: &'a Path, argv: &[String]) -> &'a Path {
    let ps = dir.join("ps");
    let command = argv.join(" ");
    std::fs::write(&ps, format!("#!/bin/sh\nprintf '%s\\n' '{command}'\n")).unwrap();
    Command::new("chmod").arg("755").arg(&ps).status().unwrap();
    argv::fake_argv(&dir.join("argv"), Some(argv));
    dir
}

#[cfg(target_os = "macos")]
#[test]
fn arrange_refuses_a_listener_that_is_not_ours() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().join("chrome");
    let chrome = fake_chrome(
        &[("PAGE1", true)],
        Window {
            state: "normal".into(),
            normal: OLD,
        },
    );
    let other = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
        "--remote-debugging-port=9222".to_string(),
    ];
    let (line, code) = bw_arrange(chrome.port, &profile, fake_ps(dir.path(), &other));
    assert_eq!(code, 0);
    assert_eq!(line["type"], "arrange");
    assert_eq!(line["state"], "chrome_not_running", "{line}");
    assert!(
        line["message"]
            .as_str()
            .unwrap()
            .contains("not the Bellwether Chrome"),
        "{line}"
    );
    assert!(
        chrome.calls.lock().unwrap().is_empty(),
        "it attached to another program"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn arrange_with_nothing_listening_is_chrome_not_running() {
    let dir = tempfile::tempdir().unwrap();
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (line, code) = bw_arrange(
        port,
        &dir.path().join("chrome"),
        fake_ps(dir.path(), &["x".to_string()]),
    );
    assert_eq!(code, 0);
    assert_eq!(line["state"], "chrome_not_running", "{line}");
    assert_eq!(line["side"], Value::Null);
    assert_eq!(line["bounds"], Value::Null);
}

#[cfg(target_os = "macos")]
#[test]
fn arrange_with_our_chrome_and_no_herdr_window_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().join("chrome");
    let chrome = fake_chrome(
        &[("PAGE1", true)],
        Window {
            state: "normal".into(),
            normal: OLD,
        },
    );
    let ours = argv::chrome_argv(&profile, chrome.port);
    // launchd (pid 1) owns no window.
    let (line, code) = bw_arrange(chrome.port, &profile, fake_ps(dir.path(), &ours));
    assert_eq!(code, 0);
    assert_eq!(line["state"], "no_herdr_window", "{line}");
    assert!(chrome.calls.lock().unwrap().is_empty());
}

#[test]
fn arrange_rejects_unknown_options() {
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args(["browser", "arrange", "--owner-pid", "nope"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["code"], "usage");
}
