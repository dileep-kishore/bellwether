//! The browser frame: loopback HTTP, the CDP WebSocket client, and the routing of `bw browser …` and
//! `bw agent …`, all against in-test servers on free 127.0.0.1 ports.
//!
//! bw has no library target, so `http.rs` and `cdp.rs` are compiled into this test as modules of their own.

#[path = "../src/browser/cdp.rs"]
mod cdp;
#[path = "../src/browser/http.rs"]
mod http;

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::Message;

const WAIT: Duration = Duration::from_secs(5);

/// Reads one request's head, so the server answers only after the client has written.
fn read_head(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap() == 0 {
            break;
        }
        head.push(byte[0]);
    }
    String::from_utf8(head).unwrap()
}

/// Serves one connection with `reply` and sends the request head it read back on the channel.
fn serve_once(reply: Vec<u8>) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let head = read_head(&mut stream);
        let _ = stream.write_all(&reply);
        let _ = stream.flush();
        let _ = tx.send(head);
    });
    (port, rx)
}

#[test]
fn get_reads_content_length_body() {
    let (port, head) = serve_once(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"a\":true}\nEXTRA".to_vec(),
    );
    let reply = http::get(port, "/json/version", WAIT).unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, b"{\"a\":true}\n");
    let head = head.recv_timeout(WAIT).unwrap();
    assert!(
        head.starts_with("GET /json/version HTTP/1.1\r\n"),
        "{head:?}"
    );
    assert!(
        head.contains(&format!("\r\nHost: 127.0.0.1:{port}\r\n")),
        "{head:?}"
    );
    assert!(head.contains("\r\nConnection: close\r\n"), "{head:?}");
}

#[test]
fn get_reads_a_body_up_to_close() {
    let (port, _head) = serve_once(b"HTTP/1.1 404 Not Found\r\n\r\nno such target".to_vec());
    let reply = http::get(port, "/json/close/x", WAIT).unwrap();
    assert_eq!(reply.status, 404);
    assert_eq!(reply.body, b"no such target");
}

#[test]
fn get_reads_chunked_body() {
    let (port, _head) = serve_once(
        b"HTTP/1.1 200 OK\r\ntransfer-encoding: Chunked\r\n\r\n4\r\nWiki\r\n6;ext=1\r\npedia \r\nE\r\nin \r\n\r\nchunks.\r\n0\r\nX-Trailer: 1\r\n\r\n"
            .to_vec(),
    );
    let reply = http::get(port, "/", WAIT).unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, b"Wikipedia in \r\n\r\nchunks.");
}

#[test]
fn put_sends_put_with_an_empty_body() {
    let (port, head) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec());
    let reply = http::put(port, "/json/new?about:blank", WAIT).unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, b"{}");
    let head = head.recv_timeout(WAIT).unwrap();
    assert!(
        head.starts_with("PUT /json/new?about:blank HTTP/1.1\r\n"),
        "{head:?}"
    );
    assert!(head.contains("\r\nContent-Length: 0\r\n"), "{head:?}");
}

#[test]
fn body_over_1_mib_is_an_error() {
    let mib = 1024 * 1024;
    let mut declared = b"HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n".to_vec();
    declared.extend(vec![b'x'; mib + 1]);
    let (port, _head) = serve_once(declared);
    let err = http::get(port, "/", WAIT).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");

    let mut to_close = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
    to_close.extend(vec![b'x'; mib + 1]);
    let (port, _head) = serve_once(to_close);
    let err = http::get(port, "/", WAIT).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");

    let mut chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    for _ in 0..2 {
        chunked.extend(format!("{:x}\r\n", mib / 2 + 1).into_bytes());
        chunked.extend(vec![b'x'; mib / 2 + 1]);
        chunked.extend(b"\r\n");
    }
    chunked.extend(b"0\r\n\r\n");
    let (port, _head) = serve_once(chunked);
    let err = http::get(port, "/", WAIT).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");

    let mut exact = b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\n\r\n".to_vec();
    exact.extend(vec![b'x'; mib]);
    let (port, _head) = serve_once(exact);
    assert_eq!(http::get(port, "/", WAIT).unwrap().body.len(), mib);
}

#[test]
fn refuses_after_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // Accepts and holds the connection, never answering.
    let held = thread::spawn(move || listener.accept().map(|(s, _)| s));
    let start = Instant::now();
    let err = http::get(port, "/json/version", Duration::from_millis(300)).unwrap_err();
    let took = start.elapsed();
    assert!(
        matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock),
        "{err:?}"
    );
    assert!(took >= Duration::from_millis(250), "gave up after {took:?}");
    assert!(took < Duration::from_millis(1500), "took {took:?}");
    drop(held);
}

#[test]
fn a_server_that_drips_bytes_still_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_head(&mut stream);
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
        for _ in 0..40 {
            thread::sleep(Duration::from_millis(50));
            if stream.write_all(b"x").is_err() {
                break;
            }
        }
    });
    let start = Instant::now();
    let err = http::get(port, "/", Duration::from_millis(300)).unwrap_err();
    assert!(
        matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock),
        "{err:?}"
    );
    assert!(start.elapsed() < Duration::from_millis(1500));
}

#[test]
fn a_path_that_could_split_the_request_is_refused() {
    for path in ["json/version", "/a b", "/a\r\nHost: evil", "/\n", "/\t"] {
        let err = http::get(1, path, WAIT).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{path:?}: {err}");
    }
}

#[test]
fn a_reply_that_is_not_http_is_an_error() {
    let (port, _head) = serve_once(b"SSH-2.0-OpenSSH_9.9\r\n\r\n".to_vec());
    let err = http::get(port, "/", WAIT).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");
}

#[test]
fn browser_ws_reads_the_url_and_id() {
    let body = r#"{"Browser":"Chrome/156.0.8078.80","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/0b5c9e8e-1f7e-4c1a-9d3e-2a4f5b6c7d8e"}"#;
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let (port, head) = serve_once(reply.into_bytes());
    let (url, id) = cdp::browser_ws(port).unwrap();
    assert_eq!(
        url,
        "ws://127.0.0.1:9222/devtools/browser/0b5c9e8e-1f7e-4c1a-9d3e-2a4f5b6c7d8e"
    );
    assert_eq!(id, "0b5c9e8e-1f7e-4c1a-9d3e-2a4f5b6c7d8e");
    assert!(head
        .recv_timeout(WAIT)
        .unwrap()
        .starts_with("GET /json/version "));
}

#[test]
fn browser_ws_without_a_url_is_an_error() {
    let (port, _head) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec());
    assert!(cdp::browser_ws(port).is_err());
    let free = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    assert!(cdp::browser_ws(free).is_err());
}

/// An in-test CDP endpoint: for each request it runs `answer`, which sends whatever frames it likes.
fn cdp_server<F>(answer: F) -> (String, thread::JoinHandle<Vec<Value>>)
where
    F: Fn(&Value) -> Vec<Value> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        let mut seen = Vec::new();
        loop {
            let msg = match ws.read() {
                Ok(m) => m,
                Err(_) => break,
            };
            let Message::Text(text) = msg else {
                if msg.is_close() {
                    break;
                }
                continue;
            };
            let req: Value = serde_json::from_str(text.as_str()).unwrap();
            for frame in answer(&req) {
                ws.send(Message::text(frame.to_string())).unwrap();
            }
            seen.push(req);
        }
        seen
    });
    (
        format!("ws://127.0.0.1:{port}/devtools/browser/test-id"),
        handle,
    )
}

#[test]
fn cdp_call_matches_ids_and_skips_events() {
    let (url, server) = cdp_server(|req| {
        let id = req["id"].as_u64().unwrap();
        vec![
            json!({"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "x"}}}),
            json!({"id": id + 100, "result": {"wrong": true}}),
            json!({"id": id, "result": {"echo": req["method"], "params": req["params"]}}),
        ]
    });
    let mut cdp = cdp::Cdp::connect(&url, WAIT).unwrap();
    let first = cdp
        .call("Browser.getWindowForTarget", json!({"targetId": "page-1"}))
        .unwrap();
    assert_eq!(
        first,
        json!({"echo": "Browser.getWindowForTarget", "params": {"targetId": "page-1"}})
    );
    let second = cdp.call("Browser.getVersion", json!({})).unwrap();
    assert_eq!(second["echo"], "Browser.getVersion");
    drop(cdp);
    let seen = server.join().unwrap();
    let ids: Vec<u64> = seen.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids[1] > ids[0], "{ids:?}");
}

#[test]
fn cdp_error_is_returned() {
    let (url, server) = cdp_server(|req| {
        vec![
            json!({"id": req["id"], "error": {"code": -32000, "message": "No target with given id found"}}),
        ]
    });
    let mut cdp = cdp::Cdp::connect(&url, WAIT).unwrap();
    let err = cdp
        .call("Browser.getWindowForTarget", json!({"targetId": "gone"}))
        .unwrap_err();
    assert!(err.contains("No target with given id found"), "{err}");
    drop(cdp);
    server.join().unwrap();
}

#[test]
fn cdp_call_times_out_when_no_reply_comes() {
    let (url, server) =
        cdp_server(|_| vec![json!({"method": "Page.frameNavigated", "params": {}})]);
    let mut cdp = cdp::Cdp::connect(&url, Duration::from_millis(300)).unwrap();
    let start = Instant::now();
    assert!(cdp.call("Browser.getVersion", json!({})).is_err());
    assert!(start.elapsed() < Duration::from_millis(1500));
    drop(cdp);
    server.join().unwrap();
}

#[test]
fn non_loopback_ws_is_refused() {
    for url in [
        "ws://10.0.0.1:9222/devtools/browser/x",
        "ws://localhost:9222/devtools/browser/x",
        "ws://127.0.0.1.evil.example:9222/devtools/browser/x",
        "ws://127.0.0.1:9222@evil.example/devtools/browser/x",
        "ws://127.0.0.1:/devtools/browser/x",
        "ws://127.0.0.1:99999/devtools/browser/x",
        "wss://127.0.0.1:9222/devtools/browser/x",
        "ws://[::2]:9222/devtools/browser/x",
        "http://127.0.0.1:9222/json/version",
    ] {
        let start = Instant::now();
        let err = cdp::Cdp::connect(url, WAIT).err();
        assert!(err.is_some(), "{url} was accepted");
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "{url} tried to connect"
        );
    }
}

/// A port nothing listens on, so a command that reaches for Chrome finds none.
fn closed_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Phase 4's commands with no further argv; a stub prints `not_built` until its task lands.
const PHASE_4_COMMANDS: [&[&str]; 13] = [
    &["browser", "up"],
    &["browser", "down"],
    &["browser", "tabs"],
    &["browser", "focus"],
    &["browser", "close"],
    &["browser", "new"],
    &["browser", "arrange"],
    &["browser", "free-port"],
    &["browser", "port-check"],
    &["browser", "forward"],
    &["browser", "agent-args"],
    &["browser", "status"],
    &["agent"],
];

#[test]
fn each_new_command_prints_not_built() {
    let home = tempfile::tempdir().unwrap();
    let fake_hc = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc");
    let port = closed_port().to_string();
    for argv in PHASE_4_COMMANDS {
        // Once a real command replaces a stub, this environment keeps it off the user's Chrome and machines.
        let out = Command::new(env!("CARGO_BIN_EXE_bw"))
            .args(argv)
            .env("HOME", home.path())
            .env("HERDR_APP_HOME", home.path().join("app"))
            .env("BW_CACHE_DIR", home.path().join("cache"))
            .env("BW_CHROME_PORT", &port)
            .env("BW_CHROME_PROFILE", home.path().join("chrome"))
            .env("BW_CHROME_APP", home.path().join("no-such.app"))
            .env("BW_OPEN", "/usr/bin/false")
            .env("BW_CURL", "/usr/bin/false")
            .env("BW_SIPS", "/usr/bin/false")
            .env("BW_HC", &fake_hc)
            .env("FAKE_HC_ROOT", home.path().join("remote"))
            .env("FAKE_HC_LOG", home.path().join("hc.log"))
            .env_remove("HC_TERMINAL_ID")
            .env_remove("HC_SESSION")
            .stdin(Stdio::null())
            .output()
            .expect("run bw");
        let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
        let code = out.status.code().expect("exit code");
        assert!(!stdout.trim().is_empty(), "{argv:?} printed nothing");
        for line in stdout.lines() {
            let v: Value =
                serde_json::from_str(line).unwrap_or_else(|e| panic!("{argv:?}: {line:?}: {e}"));
            let message = v["message"].as_str().unwrap_or("");
            assert!(
                !message.starts_with("unknown"),
                "{argv:?} is not routed: {line}"
            );
            if v["code"] == "not_built" {
                assert_eq!(code, 1, "{argv:?}: {line}");
                assert!(
                    message.contains(argv.join(" ").as_str()),
                    "{argv:?}: {line}"
                );
            }
        }
    }
}

#[test]
fn an_unknown_browser_command_is_a_usage_error() {
    for argv in [&["browser"][..], &["browser", "nonsense"][..]] {
        let out = Command::new(env!("CARGO_BIN_EXE_bw"))
            .args(argv)
            .stdin(Stdio::null())
            .output()
            .expect("run bw");
        assert_eq!(out.status.code(), Some(2), "{argv:?}");
        let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["code"], "usage");
    }
}
