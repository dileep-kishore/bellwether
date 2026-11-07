//! `bw browser free-port|port-check|forward …` with `tests/fake-hc` as hc, `tests/fake-ssh` as ssh and an in-test
//! `/json/version` server as the Bellwether Chrome, so no test reaches a real machine, sshd or Chrome.
//!
//! The "other machine" is this one: fake hc's `exec` runs the test `bw` with a scratch HOME, and fake ssh
//! listens here, so `port-check` reads real `lsof` output for the forward's listener.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const BROWSER_ID: &str = "71d8450a-71c6-4a85-b012-325fe0e3e1d0";
const OTHER_ID: &str = "0b9e7c41-58aa-4b1f-9d0e-6a1c2f3e4d5c";
const CORE: &str = "bw-test";

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[path = "support/argv.rs"]
mod argv;
#[path = "support/ports.rs"]
mod ports;
use argv::{chrome_argv, fake_argv};
use ports::{free_port, serial};

fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Answers `GET /json/version` with `id`'s WebSocket URL, and `GET /` with 200, on its own threads until the test
/// ends; its port. It binds port 0 itself, since a port freed for it could go to a parallel test first.
fn serve_version(id: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            thread::spawn(move || {
                let mut buf = [0u8; 2048];
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let n = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if head.starts_with("GET /json/version ") {
                    json!({
                        "Browser": "Chrome/156.0.8078.80",
                        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/{id}"),
                    })
                    .to_string()
                } else {
                    "ok".to_string()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    port
}

/// A window machine (scratch HOME, fake hc and ssh, an in-test Chrome) and one SSH machine, `mac2`, whose home
/// holds the test `bw` as its helper.
struct Scene {
    dir: tempfile::TempDir,
    chrome_port: u16,
    env: Vec<(String, String)>,
}

impl Scene {
    fn new() -> Scene {
        Scene::with_machines(json!({"machines": [
            {"name": "mac2", "state": "connected", "target": "dk@mac2.local", "via": false, "temporary": false},
            {"name": "bwloop", "state": "connected", "target": "env HOME=/x sh -c", "via": true, "temporary": true},
            {"name": "asleep", "state": "disconnected", "target": "dk@asleep.local", "via": false},
        ]}))
    }

    fn with_machines(machines: Value) -> Scene {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        for sub in ["home", "remote", "runs"] {
            fs::create_dir(d.join(sub)).unwrap();
        }
        let helper = d.join("remote/.local/share/bellwether/helper/current");
        fs::create_dir_all(&helper).unwrap();
        symlink(env!("CARGO_BIN_EXE_bw"), helper.join("bw")).unwrap();
        fs::write(d.join("machines.json"), machines.to_string()).unwrap();
        write_script(
            &d.join("hc"),
            &format!(
                "export FAKE_HC_ROOT='{root}' FAKE_HC_MACHINES='{m}' FAKE_HC_RUN_DIR='{runs}' FAKE_HC_LOG='{log}'\n\
                 exec '{fake}' \"$@\"",
                root = d.join("remote").display(),
                m = d.join("machines.json").display(),
                runs = d.join("runs").display(),
                log = d.join("hc.log").display(),
                fake = manifest().join("tests/fake-hc").display(),
            ),
        );
        let profile = d.join("profile");
        let chrome_port = serve_version(BROWSER_ID);
        // Every pid is the Bellwether Chrome to `ps` and the argv reader: the in-test server is this process.
        let argv = chrome_argv(&profile, chrome_port);
        write_script(&d.join("ps"), &format!("echo '{}'", argv.join(" ")));
        fake_argv(&d.join("argv"), Some(&argv));
        let env = vec![
            ("HOME", d.join("home").display().to_string()),
            ("HC_SESSION", CORE.to_string()),
            ("BW_HC", d.join("hc").display().to_string()),
            (
                "BW_SSH",
                manifest().join("tests/fake-ssh").display().to_string(),
            ),
            ("FAKE_SSH_LOG", d.join("ssh.log").display().to_string()),
            // The fake ssh ends its supervisor when this process is gone, even killed before a Scene drops.
            ("FAKE_SSH_LIFELINE", std::process::id().to_string()),
            ("BW_CHROME_PORT", chrome_port.to_string()),
            ("BW_CHROME_PROFILE", profile.display().to_string()),
            ("BW_PS", d.join("ps").display().to_string()),
            ("BW_PROC_ARGV", d.join("argv").display().to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        Scene {
            dir,
            chrome_port,
            env,
        }
    }

    fn set(&mut self, key: &str, value: &str) {
        self.env.push((key.to_string(), value.to_string()));
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.arg("browser").args(args);
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// Runs `bw browser <args>`; its one line and exit code.
    fn run(&self, args: &[&str]) -> (i32, Value) {
        let out = self.command(args).output().expect("run bw");
        let stdout = String::from_utf8(out.stdout).unwrap();
        let lines: Vec<&str> = stdout.lines().collect();
        assert_eq!(
            lines.len(),
            1,
            "one line from {args:?}: {stdout:?}; stderr {:?}",
            String::from_utf8_lossy(&out.stderr)
        );
        (
            out.status.code().unwrap(),
            serde_json::from_str(lines[0]).unwrap(),
        )
    }

    fn ensure(&self) -> Value {
        let (code, v) = self.run(&["forward", "ensure", "--machine", "mac2"]);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["type"], "forward", "{v}");
        v
    }

    fn state_file(&self, name: &str) -> PathBuf {
        self.dir
            .path()
            .join("home/.local/share/bellwether/browser/forwards")
            .join(CORE)
            .join(name)
    }

    fn state(&self, name: &str) -> Option<Value> {
        let text = fs::read_to_string(self.state_file(name)).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Waits up to `limit` for `mac2.json` to say `state`; the record that did.
    fn wait_state(&self, name: &str, state: &str, limit: Duration) -> Value {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(v) = self.state(name) {
                if v["state"] == state {
                    return v;
                }
            }
            assert!(
                Instant::now() < deadline,
                "{name} never said {state}: {:?}; keep's screen: {}",
                self.state(name),
                self.screen("bw-fwd-mac2")
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn log(&self, name: &str) -> String {
        fs::read_to_string(self.dir.path().join(name)).unwrap_or_default()
    }

    fn ssh_starts(&self) -> Vec<String> {
        self.log("ssh.log")
            .lines()
            .filter_map(|l| l.strip_prefix("start "))
            .map(String::from)
            .collect()
    }

    fn hc_calls(&self, prefix: &str) -> usize {
        self.log("hc.log")
            .lines()
            .filter(|l| l.starts_with(prefix))
            .count()
    }

    fn port_checks(&self) -> Vec<String> {
        self.log("hc.log")
            .lines()
            .filter(|l| l.starts_with("exec ") && l.contains(" browser port-check "))
            .map(String::from)
            .collect()
    }

    fn pid(&self, terminal: &str) -> Option<i32> {
        fs::read_to_string(self.dir.path().join("runs").join(format!("{terminal}.pid")))
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    fn screen(&self, terminal: &str) -> String {
        fs::read_to_string(self.dir.path().join("runs").join(format!("{terminal}.out")))
            .unwrap_or_default()
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        // Each supervisor and its ssh share a process group; leave none behind.
        if let Ok(entries) = fs::read_dir(self.dir.path().join("runs")) {
            for e in entries.flatten() {
                if e.path().extension().is_some_and(|x| x == "pid") {
                    if let Ok(pid) = fs::read_to_string(e.path()) {
                        let _ = Command::new("kill")
                            .args(["-KILL", "--", &format!("-{}", pid.trim())])
                            .stderr(Stdio::null())
                            .status();
                    }
                }
            }
        }
    }
}

fn alive(pid: i32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn wait_dead(pid: i32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).is_ok()
}

fn port_of(v: &Value) -> u16 {
    v["port"].as_u64().expect("a port") as u16
}

#[test]
fn free_port_prefers_a_free_port() {
    let _serial = serial();
    let s = Scene::new();
    let p = free_port();
    let (code, v) = s.run(&["free-port", "--prefer", &p.to_string()]);
    assert_eq!((code, &v), (0, &json!({"type": "free-port", "port": p})));
    // A held port is passed over for another free one.
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let hp = held.local_addr().unwrap().port();
    let (code, v) = s.run(&["free-port", "--prefer", &hp.to_string()]);
    assert_eq!(code, 0);
    let got = port_of(&v);
    assert_ne!(got, hp);
    assert!(
        TcpListener::bind(("127.0.0.1", got)).is_ok(),
        "{got} is free"
    );
}

#[test]
fn port_check_passes_only_on_loopback_with_the_id() {
    let _serial = serial();
    let s = Scene::new();
    let id = BROWSER_ID;
    let port = s.chrome_port.to_string();
    let (code, v) = s.run(&["port-check", "--port", &port, "--browser-id", id]);
    assert_eq!(
        (code, &v),
        (0, &json!({"type": "port-check", "ok": true, "reason": ""}))
    );
    let (code, v) = s.run(&["port-check", "--port", &port, "--browser-id", OTHER_ID]);
    assert_eq!((code, v["ok"].clone()), (1, json!(false)));
    assert!(v["reason"].as_str().unwrap().contains(BROWSER_ID), "{v}");
    let empty = free_port().to_string();
    let (code, v) = s.run(&["port-check", "--port", &empty, "--browser-id", id]);
    assert_eq!((code, v["ok"].clone()), (1, json!(false)));
    assert!(
        v["reason"]
            .as_str()
            .unwrap()
            .starts_with("nothing listens on"),
        "{v}"
    );
}

#[test]
fn via_machine_is_named() {
    let _serial = serial();
    let s = Scene::new();
    let (code, v) = s.run(&["forward", "ensure", "--machine", "bwloop"]);
    assert_eq!(code, 0);
    assert_eq!(v["state"], "via", "{v}");
    assert_eq!(v["kind"], "browser");
    assert_eq!(v["machine"], "bwloop");
    assert_eq!(
        v["reason"],
        "browser forward unavailable: bwloop connects through via, not SSH"
    );
    assert!(s.ssh_starts().is_empty());
    assert_eq!(s.hc_calls("run "), 0);
}

#[test]
fn offline_machine_is_named() {
    let _serial = serial();
    let s = Scene::new();
    let (_, v) = s.run(&["forward", "ensure", "--machine", "asleep"]);
    assert_eq!(v["state"], "offline", "{v}");
    assert!(v["reason"].as_str().unwrap().contains("asleep"), "{v}");
    let (_, v) = s.run(&["forward", "ensure", "--machine", "nowhere"]);
    assert_eq!(v["state"], "offline", "{v}");
    assert!(v["reason"].as_str().unwrap().contains("nowhere"), "{v}");
    assert!(s.ssh_starts().is_empty());
    assert_eq!(s.hc_calls("run "), 0);
}

#[test]
fn ensure_starts_a_checked_forward() {
    let _serial = serial();
    let s = Scene::new();
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    assert_eq!(v["terminal"], "bw-fwd-mac2");
    assert_eq!(v["target"], "dk@mac2.local");
    let port = port_of(&v);
    let starts = s.ssh_starts();
    assert_eq!(starts.len(), 1, "{starts:?}");
    assert!(
        starts[0].ends_with(&format!(
            "-N -R 127.0.0.1:{port}:127.0.0.1:{} dk@mac2.local",
            s.chrome_port
        )),
        "{}",
        starts[0]
    );
    let checks = s.port_checks();
    assert!(!checks.is_empty());
    assert!(
        checks[0].contains(&format!("--port {port} --browser-id {BROWSER_ID}")),
        "{checks:?}"
    );
    let st = s.state("mac2.json").unwrap();
    assert_eq!(st["state"], "ready");
    assert_eq!(st["kind"], "browser");
    assert_eq!(st["browser_id"], BROWSER_ID);
    assert!(st["checked_at_ms"].as_u64().unwrap() > 0);
    // The run carries the supervisor and the hc this process found, never through a shell.
    let run = s.log("hc.log");
    let run = run.lines().find(|l| l.starts_with("run ")).unwrap();
    assert!(run.starts_with("run bw-fwd-mac2 env BW_HC="), "{run}");
    assert!(
        run.contains(&format!(
            " browser forward keep --machine mac2 --target dk@mac2.local --port {port}"
        )),
        "{run}"
    );
}

#[test]
fn ensure_reuses_a_ready_forward() {
    let _serial = serial();
    let s = Scene::new();
    let first = s.ensure();
    assert_eq!(first["state"], "ready", "{first}");
    let kills = s.hc_calls("kill ");
    let again = s.ensure();
    assert_eq!(again, first);
    assert_eq!(s.ssh_starts().len(), 1);
    assert_eq!(s.hc_calls("run "), 1);
    assert_eq!(s.hc_calls("kill "), kills, "the live forward is left alone");
}

#[test]
fn ensure_picks_the_stored_port_when_free() {
    let _serial = serial();
    let s = Scene::new();
    let stored = free_port();
    let file = s.state_file("mac2.json");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let old = json!({"kind": "browser", "machine": "mac2", "target": "dk@mac2.local", "port": stored,
        "terminal": "bw-fwd-mac2", "state": "reconnecting", "reason": "ssh exited",
        "browser_id": BROWSER_ID, "checked_at_ms": 1});
    fs::write(&file, old.to_string()).unwrap();
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    assert_eq!(port_of(&v), stored);
    let frees: Vec<String> = s
        .log("hc.log")
        .lines()
        .filter(|l| l.contains(" browser free-port"))
        .map(String::from)
        .collect();
    assert_eq!(frees.len(), 1, "{frees:?}");
    assert!(
        frees[0].ends_with(&format!("free-port --prefer {stored}")),
        "{frees:?}"
    );
}

#[test]
fn wildcard_listener_fails_closed() {
    let _serial = serial();
    let mut s = Scene::new();
    s.set("FAKE_SSH_WILDCARD", "1");
    let v = s.ensure();
    assert_eq!(v["state"], "refused", "{v}");
    let reason = v["reason"].as_str().unwrap();
    assert!(reason.contains("beyond loopback"), "{reason}");
    assert!(reason.contains(&format!("*:{}", port_of(&v))), "{reason}");
    let pid = s.pid("bw-fwd-mac2").unwrap();
    assert!(
        wait_dead(pid, Duration::from_secs(5)),
        "the supervisor exits"
    );
    assert!(!listening(port_of(&v)), "its ssh is gone");
    assert_eq!(s.state("mac2.json").unwrap()["state"], "refused");
}

#[test]
fn other_browser_id_fails_closed() {
    let _serial = serial();
    let mut s = Scene::new();
    let other = serve_version(OTHER_ID);
    s.set("FAKE_SSH_PROXY_TO", &other.to_string());
    let v = s.ensure();
    assert_eq!(v["state"], "refused", "{v}");
    let reason = v["reason"].as_str().unwrap();
    assert!(reason.contains(OTHER_ID), "{reason}");
    assert!(reason.contains(BROWSER_ID), "{reason}");
    let pid = s.pid("bw-fwd-mac2").unwrap();
    assert!(wait_dead(pid, Duration::from_secs(5)));
    assert!(!listening(port_of(&v)));
}

#[test]
fn refused_is_not_retried() {
    let _serial = serial();
    let mut s = Scene::new();
    s.set("FAKE_SSH_WILDCARD", "1");
    let v = s.ensure();
    assert_eq!(v["state"], "refused", "{v}");
    let checks = s.port_checks().len();
    // Past the first reconnect delay (2 s): no second ssh and no further check.
    thread::sleep(Duration::from_millis(3500));
    assert_eq!(s.ssh_starts().len(), 1, "{:?}", s.ssh_starts());
    assert_eq!(s.port_checks().len(), checks);
    assert!(!alive(s.pid("bw-fwd-mac2").unwrap()));
    assert_eq!(s.state("mac2.json").unwrap()["state"], "refused");
}

#[test]
fn ssh_exit_reconnects_with_checks() {
    let _serial = serial();
    let mut s = Scene::new();
    s.set("FAKE_SSH_EXIT_AFTER_MS", "1500");
    s.set("FAKE_SSH_EXIT_STARTS", "1");
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    let port = port_of(&v);
    let first = s.state("mac2.json").unwrap();
    let down = s.wait_state("mac2.json", "reconnecting", Duration::from_secs(5));
    assert!(
        down["reason"]
            .as_str()
            .unwrap()
            .contains("closed by remote host"),
        "{down}"
    );
    let checks_before = s.port_checks().len();
    let back = s.wait_state("mac2.json", "ready", Duration::from_secs(10));
    assert_eq!(port_of(&back), port, "same port");
    assert!(back["checked_at_ms"].as_u64() > first["checked_at_ms"].as_u64());
    let starts = s.ssh_starts();
    assert_eq!(starts.len(), 2, "{starts:?}");
    assert_eq!(starts[0], starts[1]);
    assert!(
        s.port_checks().len() > checks_before,
        "the second ssh was checked"
    );
    assert!(s
        .port_checks()
        .iter()
        .all(|c| c.contains(&format!("--port {port} "))));
    assert!(s.screen("bw-fwd-mac2").contains("reconnecting"));
}

#[test]
fn taken_port_on_reconnect_is_named() {
    let _serial = serial();
    let mut s = Scene::new();
    s.set("FAKE_SSH_EXIT_AFTER_MS", "1500");
    s.set("FAKE_SSH_EXIT_STARTS", "1");
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    let port = port_of(&v);
    s.wait_state("mac2.json", "reconnecting", Duration::from_secs(5));
    // Another program takes the port while ssh is down.
    let _thief = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let st = s.wait_state("mac2.json", "port_taken", Duration::from_secs(8));
    assert_eq!(port_of(&st), port);
    let reason = st["reason"].as_str().unwrap();
    assert!(reason.contains(&port.to_string()), "{reason}");
    assert!(wait_dead(
        s.pid("bw-fwd-mac2").unwrap(),
        Duration::from_secs(5)
    ));
    assert_eq!(s.ssh_starts().len(), 2);
    // The next ensure moves to a new port and never reuses the taken one.
    let next = s.ensure();
    assert_eq!(next["state"], "ready", "{next}");
    assert_ne!(port_of(&next), port);
}

#[test]
fn three_failed_ports_give_up_with_a_reason() {
    let _serial = serial();
    let mut s = Scene::new();
    s.set("FAKE_SSH_TAKEN", "1");
    let v = s.ensure();
    assert_eq!(v["state"], "port_taken", "{v}");
    let starts = s.ssh_starts();
    assert_eq!(starts.len(), 3, "{starts:?}");
    let reason = v["reason"].as_str().unwrap();
    assert!(reason.contains("3 ports"), "{reason}");
    for start in &starts {
        let port = start
            .split("-R 127.0.0.1:")
            .nth(1)
            .and_then(|r| r.split(':').next())
            .unwrap();
        assert!(reason.contains(port), "{reason} names {port}");
    }
    assert_eq!(s.hc_calls("run "), 3);
}

#[test]
fn chrome_not_running_starts_nothing() {
    let _serial = serial();
    let mut s = Scene::new();
    // A Chrome port where nothing listens.
    s.set("BW_CHROME_PORT", &free_port().to_string());
    let (_, v) = s.run(&["forward", "ensure", "--machine", "mac2"]);
    assert_eq!(v["state"], "stopped", "{v}");
    assert!(v["reason"].as_str().unwrap().contains("not running"), "{v}");
    assert!(s.ssh_starts().is_empty());
    assert_eq!(s.hc_calls("run "), 0);
}

#[test]
fn dev_needs_a_free_local_port() {
    let _serial = serial();
    let s = Scene::new();
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let n = held.local_addr().unwrap().port();
    let (code, v) = s.run(&[
        "forward",
        "dev",
        "--machine",
        "mac2",
        "--port",
        &n.to_string(),
    ]);
    assert_eq!(code, 0);
    assert_eq!(v["state"], "local_port_taken", "{v}");
    assert_eq!(v["kind"], "dev");
    assert!(
        v["reason"].as_str().unwrap().contains(&n.to_string()),
        "{v}"
    );
    assert!(s.ssh_starts().is_empty());
    assert_eq!(s.hc_calls("run "), 0);
}

#[test]
fn dev_forward_reports_whether_the_server_answers() {
    let _serial = serial();
    let mut s = Scene::new();
    let n = free_port();
    // Nothing answers "there": the fake ssh passes connections to a closed port, never back to itself.
    s.set("FAKE_SSH_PROXY_TO", &free_port().to_string());
    let (_, v) = s.run(&[
        "forward",
        "dev",
        "--machine",
        "mac2",
        "--port",
        &n.to_string(),
    ]);
    assert_eq!(v["state"], "ready_no_answer", "{v}");
    assert_eq!(v["terminal"], format!("bw-dev-mac2-{n}"));
    let starts = s.ssh_starts();
    assert!(
        starts[0].contains(&format!(
            "-o GatewayPorts=no -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
             -o ControlMaster=no -o ControlPath=none -N -L 127.0.0.1:{n}:127.0.0.1:{n} dk@mac2.local"
        )),
        "{starts:?}"
    );
    let (_, v) = s.run(&[
        "forward",
        "stop",
        "--machine",
        "mac2",
        "--dev",
        &n.to_string(),
    ]);
    assert_eq!(v["state"], "stopped", "{v}");
    // A dev server "there" (this test's server, through the fake ssh) answers.
    let server = serve_version(BROWSER_ID);
    s.set("FAKE_SSH_PROXY_TO", &server.to_string());
    let (_, v) = s.run(&[
        "forward",
        "dev",
        "--machine",
        "mac2",
        "--port",
        &n.to_string(),
    ]);
    assert_eq!(v["state"], "ready", "{v}");
    assert!(s.state(&format!("mac2-dev-{n}.json")).is_some());
}

#[test]
fn stop_kills_and_removes_the_terminal() {
    let _serial = serial();
    let s = Scene::new();
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    let port = port_of(&v);
    let pid = s.pid("bw-fwd-mac2").unwrap();
    let (code, stopped) = s.run(&["forward", "stop", "--machine", "mac2"]);
    assert_eq!(code, 0);
    assert_eq!(stopped["state"], "stopped", "{stopped}");
    assert_eq!(stopped["terminal"], "bw-fwd-mac2");
    assert!(s.log("hc.log").contains("kill bw-fwd-mac2\n"));
    assert!(s.log("hc.log").contains("rm bw-fwd-mac2\n"));
    assert!(!alive(pid));
    assert!(s.pid("bw-fwd-mac2").is_none(), "the terminal is removed");
    assert!(s.state("mac2.json").is_none(), "the state file is deleted");
    assert!(!listening(port), "ssh is gone");
    // Stopping again finds nothing and says so the same way.
    let (code, again) = s.run(&["forward", "stop", "--machine", "mac2"]);
    assert_eq!((code, again["state"].clone()), (0, json!("stopped")));
}

#[test]
fn supervisor_ends_when_the_test_process_does() {
    let _serial = serial();
    let mut s = Scene::new();
    // Stands in for a test process killed before its Scene could drop.
    let mut lifeline = Command::new("sleep").arg("60").spawn().unwrap();
    s.set("FAKE_SSH_LIFELINE", &lifeline.id().to_string());
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    let pid = s.pid("bw-fwd-mac2").unwrap();
    lifeline.kill().unwrap();
    lifeline.wait().unwrap();
    assert!(
        wait_dead(pid, Duration::from_secs(5)),
        "the supervisor outlived its test process"
    );
    assert!(!listening(port_of(&v)), "its ssh is gone");
}

#[test]
fn list_marks_a_forward_without_its_terminal_stopped() {
    let _serial = serial();
    let s = Scene::new();
    let v = s.ensure();
    assert_eq!(v["state"], "ready", "{v}");
    let out = s.command(&["forward", "list"]).output().unwrap();
    let lines: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines, vec![v.clone()]);
    let pid = s.pid("bw-fwd-mac2").unwrap();
    Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .status()
        .unwrap();
    assert!(wait_dead(pid, Duration::from_secs(5)));
    let out = s.command(&["forward", "list"]).output().unwrap();
    let line: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(line["state"], "stopped", "{line}");
    assert_eq!(line["port"], v["port"]);
}

#[test]
fn usage_errors_exit_2() {
    let _serial = serial();
    let s = Scene::new();
    for args in [
        vec!["forward"],
        vec!["forward", "ensure"],
        vec!["forward", "keep", "--machine", "mac2", "--port", "5"],
        vec![
            "forward",
            "keep",
            "--machine",
            "mac2",
            "--target",
            "-oProxyCommand=x",
            "--port",
            "5",
        ],
        vec!["port-check", "--port", "x", "--browser-id", "y"],
        vec!["forward", "dev", "--machine", "mac2", "--port", "0"],
    ] {
        let (code, v) = s.run(&args);
        assert_eq!(
            (code, v["code"].clone()),
            (2, json!("usage")),
            "{args:?}: {v}"
        );
    }
}
