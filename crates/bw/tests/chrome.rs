//! `bw browser up|down` against in-test `/json/version` and CDP servers on scratch ports, with fake `ps` and
//! `open` programs, so no test starts, reads or closes a real Chrome.
//!
//! The listener checks run the real `lsof`, which sees this test process listening on its scratch port.

// bw has no library target; `listen.rs` uses only std, so it compiles here as a module of its own.
#[path = "../src/browser/listen.rs"]
#[allow(dead_code)]
mod listen;

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::Message;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/browser");
const BROWSER_ID: &str = "71d8450a-71c6-4a85-b012-325fe0e3e1d0";

fn fixture(name: &str) -> String {
    fs::read_to_string(Path::new(FIXTURES).join(name)).unwrap()
}

#[test]
fn lsof_fixtures_parse() {
    let ls = listen::parse_lsof(&fixture("lsof-loopback.txt"));
    assert_eq!(ls.len(), 1);
    assert_eq!(ls[0].pid, 74613);
    assert_eq!(ls[0].command, "Google Chrome");
    assert_eq!(ls[0].addr, "127.0.0.1:55691");
    assert_eq!(listen::loopback_only(&ls, 55691), Ok(()));

    let ls = listen::parse_lsof(&fixture("lsof-other.txt"));
    assert_eq!(ls.len(), 1);
    assert_eq!((ls[0].pid, ls[0].command.as_str()), (74563, "bun"));
    assert_eq!(ls[0].addr, "127.0.0.1:55692");

    // One process, two descriptors: an `f` line before each `n` line.
    let ls = listen::parse_lsof(&fixture("lsof-wildcard.txt"));
    assert_eq!(ls.len(), 2);
    for l in &ls {
        assert_eq!((l.pid, l.command.as_str()), (76113, "sshd-session"));
        assert_eq!(l.addr, "*:55896");
    }
}

#[test]
fn ipv6_loopback_counts_as_loopback() {
    let ls =
        listen::parse_lsof("p76023\ncsshd-session\nf12\nn[::1]:55890\nf13\nn127.0.0.1:55890\n");
    assert_eq!(ls.len(), 2);
    assert_eq!(listen::loopback_only(&ls, 55890), Ok(()));
    // Loopback on another port is not this port's listener.
    assert!(listen::loopback_only(&ls, 55891).is_err());
}

#[test]
fn wildcard_is_not_loopback() {
    let ls = listen::parse_lsof(&fixture("lsof-wildcard.txt"));
    let err = listen::loopback_only(&ls, 55896).unwrap_err();
    assert!(err.contains("*:55896"), "{err}");
    assert!(err.contains("76113"), "{err}");
    for addr in [
        "0.0.0.0:9222",
        "[::]:9222",
        "192.168.1.4:9222",
        "127.0.0.2:9222",
    ] {
        let ls = vec![listen::Listener {
            pid: 1,
            command: "x".into(),
            addr: addr.into(),
        }];
        assert!(listen::loopback_only(&ls, 9222).is_err(), "{addr}");
    }
}

#[test]
fn nothing_listening_is_an_error() {
    assert_eq!(
        listen::loopback_only(&[], 9222),
        Err("nothing listens on 9222".to_string())
    );
    assert!(listen::parse_lsof("").is_empty());
}

#[test]
fn ss_output_parses() {
    let text = "LISTEN 0      4096       127.0.0.1:52817      0.0.0.0:*    users:((\"sshd-session\",pid=811,fd=9))\n\
                LISTEN 0      4096           [::1]:52817         [::]:*    users:((\"sshd-session\",pid=811,fd=10))\n\
                LISTEN 0      128          0.0.0.0:52818      0.0.0.0:*\n\
                LISTEN 0      128       127.0.0.1%lo:52819    0.0.0.0:*    users:((\"a\",pid=5,fd=3),(\"b\",pid=6,fd=3))\n";
    let ls = listen::parse_ss(text);
    let got: Vec<(i32, &str, &str)> = ls
        .iter()
        .map(|l| (l.pid, l.command.as_str(), l.addr.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            (811, "sshd-session", "127.0.0.1:52817"),
            (811, "sshd-session", "[::1]:52817"),
            // Without root, ss hides other users' processes: the owner stays unknown.
            (0, "", "0.0.0.0:52818"),
            (5, "a", "127.0.0.1%lo:52819"),
            (6, "b", "127.0.0.1%lo:52819"),
        ]
    );
    assert_eq!(listen::loopback_only(&ls[..2], 52817), Ok(()));
    assert!(listen::loopback_only(&ls[2..3], 52818).is_err());
}

/// A free 127.0.0.1 port; nothing listens on it once this returns.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// A scratch HOME, profile, app and fake `ps` and `open` for one test.
struct Scene {
    dir: tempfile::TempDir,
    port: u16,
}

impl Scene {
    fn new() -> Scene {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Google Chrome.app")).unwrap();
        let scene = Scene {
            dir,
            port: free_port(),
        };
        scene.open_exits(0);
        scene.ps_prints(None);
        scene
    }

    fn profile(&self) -> PathBuf {
        self.dir.path().join("profile")
    }

    fn open_log(&self) -> PathBuf {
        self.dir.path().join("open.log")
    }

    /// The fake `open` writes its argv, one argument per line, then exits with `code`.
    fn open_exits(&self, code: i32) {
        let log = self.open_log();
        write_script(
            &self.dir.path().join("open"),
            &format!(
                "printf '%s\\n' \"$@\" > '{}.tmp' && mv '{}.tmp' '{}'\nexit {code}",
                log.display(),
                log.display(),
                log.display()
            ),
        );
    }

    /// The fake `ps` prints `line` for any pid, or exits 1 as `ps` does for a pid that is gone.
    fn ps_prints(&self, line: Option<&str>) {
        let body = match line {
            Some(line) => format!("cat <<'EOF'\n{line}\nEOF"),
            None => "exit 1".to_string(),
        };
        write_script(&self.dir.path().join("ps"), &body);
    }

    fn chrome_command(&self, profile: &Path) -> String {
        format!(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir={} \
             --remote-debugging-port={} --remote-debugging-address=127.0.0.1 --no-first-run \
             --no-default-browser-check",
            profile.display(),
            self.port
        )
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.arg("browser")
            .args(args)
            .env("HOME", self.dir.path())
            .env("BW_CHROME_PORT", self.port.to_string())
            .env("BW_CHROME_PROFILE", self.profile())
            .env("BW_CHROME_APP", self.dir.path().join("Google Chrome.app"))
            .env("BW_OPEN", self.dir.path().join("open"))
            .env("BW_PS", self.dir.path().join("ps"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    fn spawn(&self, args: &[&str]) -> Child {
        self.command(args).spawn().expect("run bw")
    }

    fn run(&self, args: &[&str]) -> (i32, Value) {
        finish(self.spawn(args))
    }

    fn open_argv(&self) -> Option<Vec<String>> {
        let text = fs::read_to_string(self.open_log()).ok()?;
        Some(text.lines().map(String::from).collect())
    }
}

fn finish(child: Child) -> (i32, Value) {
    let out = child.wait_with_output().expect("wait for bw");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 1, "one line: {stdout:?}");
    let v: Value = serde_json::from_str(lines[0]).unwrap();
    (out.status.code().unwrap(), v)
}

/// What the in-test Chrome saw: HTTP request lines and CDP methods.
#[derive(Default)]
struct Seen {
    requests: Mutex<Vec<String>>,
    methods: Mutex<Vec<String>>,
    closed: AtomicUsize,
}

/// Serves `/json/version` naming `port`, and CDP on the browser socket; stops listening after `Browser.close`.
fn serve_chrome(port: u16) -> Arc<Seen> {
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let seen = Arc::new(Seen::default());
    let out = seen.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let head = peek_head(&stream);
            if head.to_ascii_lowercase().contains("upgrade: websocket") {
                if cdp_session(stream, &seen) {
                    seen.closed.fetch_add(1, Ordering::SeqCst);
                    return;
                }
            } else {
                http_reply(stream, port, &seen);
            }
        }
    });
    out
}

fn peek_head(stream: &TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut buf = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let n = stream.peek(&mut buf).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        if text.contains("\r\n\r\n") || Instant::now() > deadline {
            return text;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn http_reply(mut stream: TcpStream, port: u16, seen: &Seen) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let request_line = head.lines().next().unwrap_or("").to_string();
    seen.requests.lock().unwrap().push(request_line.clone());
    let body = if request_line.starts_with("GET /json/version ") {
        fixture("json-version.json").replace("55691", &port.to_string())
    } else {
        "{}".to_string()
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

/// Answers each CDP call with `{}`; true once it has answered `Browser.close`.
fn cdp_session(stream: TcpStream, seen: &Seen) -> bool {
    let Ok(mut ws) = tungstenite::accept(stream) else {
        return false;
    };
    loop {
        let Ok(msg) = ws.read() else { return false };
        let Message::Text(text) = msg else { continue };
        let call: Value = serde_json::from_str(text.as_str()).unwrap();
        let method = call["method"].as_str().unwrap_or("").to_string();
        seen.methods.lock().unwrap().push(method.clone());
        let _ = ws.send(Message::text(
            json!({"id": call["id"], "result": {}}).to_string(),
        ));
        if method == "Browser.close" {
            let _ = ws.close(None);
            return true;
        }
    }
}

fn assert_line(v: &Value, scene: &Scene, state: &str) {
    assert_eq!(v["type"], "chrome", "{v}");
    assert_eq!(v["state"], state, "{v}");
    assert_eq!(v["port"], scene.port, "{v}");
    assert_eq!(v["profile"], scene.profile().display().to_string(), "{v}");
    for key in ["pid", "browser_id", "version", "started", "message"] {
        assert!(v.get(key).is_some(), "{key} missing: {v}");
    }
}

#[test]
fn reuses_our_chrome() {
    let scene = Scene::new();
    let seen = serve_chrome(scene.port);
    scene.ps_prints(Some(&scene.chrome_command(&scene.profile())));
    let (code, v) = scene.run(&["up"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "running");
    assert_eq!(v["started"], false);
    assert_eq!(v["pid"], std::process::id());
    assert_eq!(v["browser_id"], BROWSER_ID);
    assert_eq!(v["version"], "Chrome/156.0.8078.80");
    assert_eq!(scene.open_argv(), None, "open must not run");
    assert!(seen.methods.lock().unwrap().is_empty());
}

#[test]
fn port_held_by_other_program_is_refused() {
    let scene = Scene::new();
    // A dev server that even answers /json/version is still not ours.
    let seen = serve_chrome(scene.port);
    scene.ps_prints(Some(&format!(
        "bun tests/browser/server.js --port {}",
        scene.port
    )));
    let (code, v) = scene.run(&["up"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "port_taken");
    assert_eq!(v["pid"], std::process::id());
    assert_eq!(v["started"], false);
    assert_eq!(v["browser_id"], Value::Null);
    let message = v["message"].as_str().unwrap();
    assert!(
        message.contains(&std::process::id().to_string()),
        "{message}"
    );
    assert!(message.contains(&scene.port.to_string()), "{message}");
    assert_eq!(scene.open_argv(), None, "open must not run");
    assert!(
        seen.requests.lock().unwrap().is_empty(),
        "nothing may be sent to a listener that is not ours"
    );
}

#[test]
fn chrome_on_other_profile_is_refused() {
    let scene = Scene::new();
    let seen = serve_chrome(scene.port);
    // A profile path that only starts with ours is another profile.
    let other = PathBuf::from(format!("{}-2", scene.profile().display()));
    scene.ps_prints(Some(&scene.chrome_command(&other)));
    let (code, v) = scene.run(&["up"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "port_taken");
    assert_eq!(v["pid"], std::process::id());
    assert_eq!(scene.open_argv(), None, "open must not run");
    assert!(seen.requests.lock().unwrap().is_empty());
}

#[test]
fn profile_locked_without_port_is_named() {
    let scene = Scene::new();
    fs::create_dir(scene.profile()).unwrap();
    std::os::unix::fs::symlink(
        format!("some-host.local-{}", std::process::id()),
        scene.profile().join("SingletonLock"),
    )
    .unwrap();
    scene.ps_prints(Some(&scene.chrome_command(&scene.profile())));
    let (code, v) = scene.run(&["up"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "no_debug_port");
    assert_eq!(v["pid"], std::process::id());
    let message = v["message"].as_str().unwrap();
    assert!(message.contains("without its debugging port"), "{message}");
    assert_eq!(scene.open_argv(), None, "open must not run");
}

#[test]
fn stale_lock_does_not_block_a_start() {
    let scene = Scene::new();
    fs::create_dir(scene.profile()).unwrap();
    std::os::unix::fs::symlink(
        "some-host.local-99999",
        scene.profile().join("SingletonLock"),
    )
    .unwrap();
    scene.ps_prints(None);
    scene.open_exits(1);
    let (code, v) = scene.run(&["up"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "start_failed");
    assert!(scene.open_argv().is_some(), "open must run");
}

#[test]
fn missing_app_is_not_installed() {
    let scene = Scene::new();
    let (code, v) = scene
        .command(&["up"])
        .env("BW_CHROME_APP", scene.dir.path().join("No Such.app"))
        .spawn()
        .map(finish)
        .unwrap();
    assert_eq!(code, 0);
    assert_line(&v, &scene, "not_installed");
    assert_eq!(v["started"], false);
    assert_eq!(scene.open_argv(), None, "open must not run");
}

#[test]
fn open_argv_is_exact() {
    let scene = Scene::new();
    let app = scene.dir.path().join("Google Chrome.app");
    let expected = |background: bool| {
        let mut argv = vec!["-n".to_string()];
        if background {
            argv.push("-g".into());
        }
        argv.extend([
            "-a".to_string(),
            app.display().to_string(),
            "--args".into(),
            format!("--user-data-dir={}", scene.profile().display()),
            format!("--remote-debugging-port={}", scene.port),
            "--remote-debugging-address=127.0.0.1".into(),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
        ]);
        argv
    };

    // A failed open answers at once, with the argv it was given.
    scene.open_exits(1);
    let (code, v) = scene.run(&["up"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "start_failed");
    assert_eq!(scene.open_argv(), Some(expected(false)));
    let mode = fs::metadata(scene.profile()).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700, "profile is created 0700");

    // A started Chrome: the fake open succeeds, then this test starts listening as Chrome would.
    fs::remove_file(scene.open_log()).unwrap();
    scene.open_exits(0);
    scene.ps_prints(Some(&scene.chrome_command(&scene.profile())));
    let child = scene.spawn(&["up", "--background"]);
    let deadline = Instant::now() + Duration::from_secs(10);
    while scene.open_argv().is_none() {
        assert!(Instant::now() < deadline, "open never ran");
        thread::sleep(Duration::from_millis(20));
    }
    thread::sleep(Duration::from_millis(300));
    let _seen = serve_chrome(scene.port);
    let (code, v) = finish(child);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "running");
    assert_eq!(v["started"], true);
    assert_eq!(v["browser_id"], BROWSER_ID);
    assert_eq!(scene.open_argv(), Some(expected(true)));
}

#[test]
fn down_refuses_a_listener_that_is_not_ours() {
    let scene = Scene::new();
    let seen = serve_chrome(scene.port);
    scene.ps_prints(Some("node dev-server.js"));
    let (code, v) = scene.run(&["down"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "port_taken");
    assert!(seen.requests.lock().unwrap().is_empty());
    assert!(seen.methods.lock().unwrap().is_empty());
    assert!(
        TcpStream::connect(("127.0.0.1", scene.port)).is_ok(),
        "the other program keeps its port"
    );
}

#[test]
fn down_closes_our_chrome_with_browser_close() {
    let scene = Scene::new();
    let seen = serve_chrome(scene.port);
    scene.ps_prints(Some(&scene.chrome_command(&scene.profile())));
    let (code, v) = scene.run(&["down"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "stopped");
    assert_eq!(*seen.methods.lock().unwrap(), vec!["Browser.close"]);
    assert_eq!(seen.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn down_with_nothing_running_is_stopped() {
    let scene = Scene::new();
    let (code, v) = scene.run(&["down"]);
    assert_eq!(code, 0);
    assert_line(&v, &scene, "stopped");
    assert_eq!(v["pid"], Value::Null);
}

#[test]
fn bad_port_or_option_is_usage() {
    let scene = Scene::new();
    for (port, args) in [
        ("nope", &["up"][..]),
        ("0", &["up"][..]),
        ("70000", &["down"][..]),
        ("", &["up"][..]),
    ] {
        let (code, v) = scene
            .command(args)
            .env("BW_CHROME_PORT", port)
            .spawn()
            .map(finish)
            .unwrap();
        assert_eq!((code, v["code"].as_str()), (2, Some("usage")), "{port:?}");
    }
    let (code, v) = scene.run(&["up", "--nonsense"]);
    assert_eq!((code, v["code"].as_str()), (2, Some("usage")));
    assert_eq!(scene.open_argv(), None);
}
