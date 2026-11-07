//! `bw browser agent-args|status` with `tests/fake-hc` as hc, `tests/fake-ssh` as ssh, a fake `open`, `ps` and
//! `npx`, and an in-test server as the Bellwether Chrome, so no test reaches a real machine, sshd or Chrome.
//!
//! The SSH machine `mac2` is this one: fake hc's `exec` runs the test `bw` as its helper with a second scratch
//! HOME, and fake ssh listens here.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const BROWSER_ID: &str = "71d8450a-71c6-4a85-b012-325fe0e3e1d0";
const CORE: &str = "bw-test";
const AGENT_DIR: &str = ".local/share/bellwether/agent";
const PAGE_A: &str = "DB8645583CC586952CA123D5F36E6BB3";
const PAGE_B: &str = "9E5E90839C1A37DA9A60159FBDDAA4D9";

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[path = "support/ports.rs"]
mod ports;
use ports::{free_port, serial};

fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// `hostname -s` as `bw` slugs it into a window id.
fn window() -> String {
    let out = Command::new("hostname").arg("-s").output().unwrap();
    let name = String::from_utf8(out.stdout).unwrap();
    let id: String = name
        .trim()
        .split('.')
        .next()
        .unwrap()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
        .take(32)
        .collect();
    if id.is_empty() {
        "window".into()
    } else {
        id
    }
}

/// Serves the Chrome's `/json/version` and `/json/list` (two pages, a DevTools page and a worker) on `listener`
/// until the test ends; a WebSocket upgrade gets a plain reply, so no tab reads as active.
fn serve_chrome(listener: TcpListener) {
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let n = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let page = |id: &str, title: &str, url: &str, kind: &str| {
                    json!({"id": id, "title": title, "type": kind, "url": url,
                        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{id}")})
                };
                let body = if head.starts_with("GET /json/version ") {
                    json!({
                        "Browser": "Chrome/156.0.8078.80",
                        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/{BROWSER_ID}"),
                    })
                    .to_string()
                } else if head.starts_with("GET /json/list ") {
                    json!([
                        page(PAGE_A, "Example", "https://example.com/a?q=1", "page"),
                        page(
                            "AD209EB7774195BBBD3DD812DCD919D0",
                            "DevTools",
                            "devtools://devtools/bundled/inspector.html",
                            "page"
                        ),
                        page(PAGE_B, "Docs", "http://127.0.0.1:3000/doc", "page"),
                        page(
                            "0A1B2C3D4E5F60718293A4B5C6D7E8F9",
                            "SW",
                            "https://example.com/sw.js",
                            "service_worker"
                        ),
                    ])
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
}

/// A window machine (scratch HOME, fake hc, ssh, open, ps and npx, an in-test Chrome on `chrome_port`) and the
/// SSH machine `mac2`, whose home holds the test `bw` as its helper.
struct Scene {
    dir: tempfile::TempDir,
    chrome_port: u16,
    env: Vec<(String, String)>,
    sleepers: Vec<Child>,
}

impl Scene {
    /// With the Chrome already running.
    fn new() -> Scene {
        let s = Scene::stopped();
        s.start_chrome();
        s
    }

    /// With nothing on the Chrome's port until `start_chrome`.
    fn stopped() -> Scene {
        let dir = tempfile::tempdir().unwrap();
        let d = fs::canonicalize(dir.path()).unwrap();
        for sub in ["home", "remote", "runs", "bin", "app/Google Chrome.app"] {
            fs::create_dir_all(d.join(sub)).unwrap();
        }
        let helper = d.join("remote/.local/share/bellwether/helper/current");
        fs::create_dir_all(&helper).unwrap();
        symlink(env!("CARGO_BIN_EXE_bw"), helper.join("bw")).unwrap();
        fs::write(
            d.join("machines.json"),
            json!({"machines": [
                {"name": "mac2", "state": "connected", "target": "dk@mac2.local", "via": false},
                {"name": "bwloop", "state": "connected", "target": "env HOME=/x sh -c", "via": true,
                 "temporary": true},
            ]})
            .to_string(),
        )
        .unwrap();
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
        let chrome_port = free_port();
        // Every pid is the Bellwether Chrome to `ps`: the in-test server is this test process.
        write_script(
            &d.join("ps"),
            &format!(
                "echo '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir={} \
                 --remote-debugging-port={chrome_port} --remote-debugging-address=127.0.0.1'",
                profile.display()
            ),
        );
        write_script(
            &d.join("open"),
            &format!("echo \"open $*\" >> '{}'", d.join("open.log").display()),
        );
        // Logs its argv; `--version` prints the pinned version after FAKE_NPX_SLEEP seconds.
        write_script(
            &d.join("bin/npx"),
            &format!(
                "echo \"$*\" >> '{log}'\n\
                 case \" $* \" in *' --version '*) sleep \"${{FAKE_NPX_SLEEP:-0}}\"; echo 1.12.0 ;; esac",
                log = d.join("npx.log").display()
            ),
        );
        let env = vec![
            ("HOME", d.join("home").display().to_string()),
            ("HC_SESSION", CORE.to_string()),
            ("BW_HC", d.join("hc").display().to_string()),
            (
                "BW_SSH",
                manifest().join("tests/fake-ssh").display().to_string(),
            ),
            ("FAKE_SSH_LOG", d.join("ssh.log").display().to_string()),
            ("BW_CHROME_PORT", chrome_port.to_string()),
            ("BW_CHROME_PROFILE", profile.display().to_string()),
            (
                "BW_CHROME_APP",
                d.join("app/Google Chrome.app").display().to_string(),
            ),
            ("BW_OPEN", d.join("open").display().to_string()),
            ("BW_PS", d.join("ps").display().to_string()),
            ("HERDR_APP_HOME", d.join("app-home").display().to_string()),
            (
                "PATH",
                format!(
                    "{}:{}",
                    d.join("bin").display(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            ),
            ("BW_NPX_FALLBACKS", String::new()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        Scene {
            dir,
            chrome_port,
            env,
            sleepers: Vec::new(),
        }
    }

    fn path(&self) -> PathBuf {
        fs::canonicalize(self.dir.path()).unwrap()
    }

    fn start_chrome(&self) {
        serve_chrome(TcpListener::bind(("127.0.0.1", self.chrome_port)).unwrap());
    }

    fn set(&mut self, key: &str, value: &str) {
        self.env.retain(|(k, _)| k != key);
        self.env.push((key.to_string(), value.to_string()));
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bw"));
        cmd.arg("browser")
            .args(args)
            .env_remove("CODEX_HOME")
            .env_remove("HC_TERMINAL_ID");
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// Runs `bw browser <args>`: its exit code and lines.
    fn run(&self, args: &[&str]) -> (i32, Vec<Value>) {
        finish(self.command(args).spawn().expect("run bw"))
    }

    /// `agent-args`, which must print exactly one line and exit 0.
    fn agent_args(&self, args: &[&str]) -> Value {
        let mut all = vec!["agent-args"];
        all.extend_from_slice(args);
        let (code, lines) = self.run(&all);
        assert_eq!(lines.len(), 1, "{args:?}: {lines:?}");
        assert_eq!(code, 0, "{}", lines[0]);
        assert_eq!(lines[0]["type"], "agent-args", "{}", lines[0]);
        lines[0].clone()
    }

    fn log(&self, name: &str) -> String {
        fs::read_to_string(self.path().join(name)).unwrap_or_default()
    }

    fn count(&self, name: &str, prefix: &str) -> usize {
        self.log(name)
            .lines()
            .filter(|l| l.starts_with(prefix))
            .count()
    }

    fn home(&self) -> PathBuf {
        self.path().join("home")
    }

    fn remote(&self) -> PathBuf {
        self.path().join("remote")
    }

    fn forwards(&self) -> PathBuf {
        self.home()
            .join(".local/share/bellwether/browser/forwards")
            .join(CORE)
    }

    /// A state file for `machine`'s browser forward, as a supervisor writes it.
    fn put_forward(&self, machine: &str, port: u16, state: &str, terminal: &str) {
        fs::create_dir_all(self.forwards()).unwrap();
        let rec = json!({"kind": "browser", "machine": machine, "target": format!("dk@{machine}.local"),
            "port": port, "terminal": terminal, "state": state, "reason": "", "browser_id": BROWSER_ID,
            "checked_at_ms": 1});
        fs::write(
            self.forwards().join(format!("{machine}.json")),
            rec.to_string(),
        )
        .unwrap();
    }

    /// A live terminal named `name` in fake hc's run folder, running `argv`.
    fn live_terminal(&mut self, name: &str, argv: &[&str]) {
        let child = Command::new("sleep").arg("60").spawn().unwrap();
        let runs = self.path().join("runs");
        fs::write(runs.join(format!("{name}.pid")), child.id().to_string()).unwrap();
        fs::write(runs.join(format!("{name}.argv")), json!(argv).to_string()).unwrap();
        self.sleepers.push(child);
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        for c in &mut self.sleepers {
            let _ = c.kill();
            let _ = c.wait();
        }
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

fn finish(child: Child) -> (i32, Vec<Value>) {
    let out = child.wait_with_output().expect("wait for bw");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines = stdout
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
        .collect();
    (out.status.code().unwrap(), lines)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("not a list: {v}"))
        .iter()
        .map(|a| a.as_str().unwrap().to_string())
        .collect()
}

/// The value after `-c` that starts with `key=`.
fn c_value(argv: &[String], key: &str) -> String {
    argv.windows(2)
        .find(|w| w[0] == "-c" && w[1].starts_with(&format!("{key}=")))
        .map(|w| w[1][key.len() + 1..].to_string())
        .unwrap_or_else(|| panic!("no -c {key}= in {argv:?}"))
}

fn unavailable(v: &Value, reason: &str) {
    assert_eq!(v["browser"], "unavailable", "{v}");
    assert_eq!(v["argv"], json!([]), "{v}");
    let got = v["reason"].as_str().unwrap_or_default();
    assert!(got.contains(reason), "reason {got:?} lacks {reason:?}");
}

#[test]
fn local_claude_args_after_up() {
    let _serial = serial();
    let s = Scene::new();
    let cwd = s.path().join("project");
    fs::create_dir(&cwd).unwrap();
    let v = s.agent_args(&[
        "--kind",
        "claude",
        "--machine",
        "",
        "--cwd",
        cwd.to_str().unwrap(),
    ]);
    let w = window();
    let agent = s.home().join(AGENT_DIR);
    assert_eq!(
        v,
        json!({"type": "agent-args", "kind": "claude", "machine": "", "browser": "ready", "reason": "",
        "argv": [
            "--mcp-config", agent.join(format!("claude-mcp-{w}.json")).display().to_string(),
            "--allowedTools", "mcp__bw-browser",
            "--append-system-prompt-file", agent.join("browser-claude.md").display().to_string(),
        ]})
    );
    assert_eq!(
        fs::read_to_string(agent.join("ports").join(&w)).unwrap(),
        format!("{}\n", s.chrome_port),
        "the window machine's port file holds the Chrome's own port"
    );
    assert!(agent.join("browser-mcp").is_file());
    assert_eq!(
        s.count("open.log", "open "),
        0,
        "a running Chrome is reused"
    );
    let hc = s.log("hc.log");
    assert!(
        hc.lines().all(|l| l.starts_with("run bw-warm-local ")),
        "a local agent needs no hc call but the warm's: {hc}"
    );
}

#[test]
fn local_args_need_no_cwd() {
    let _serial = serial();
    let mut s = Scene::new();
    let v = s.agent_args(&["--kind", "claude", "--machine", ""]);
    assert_eq!(v["browser"], "ready", "{v}");
    assert_eq!(strings(&v["argv"]).len(), 6, "{v}");

    // Codex without a folder: the top-level value and ours, no project layer.
    let codex_home = s.path().join("codex-home");
    fs::create_dir(&codex_home).unwrap();
    fs::write(
        codex_home.join("config.toml"),
        "developer_instructions = \"TOP-SENTINEL\"\n",
    )
    .unwrap();
    s.set("CODEX_HOME", codex_home.to_str().unwrap());
    let v = s.agent_args(&["--kind", "codex", "--machine", ""]);
    assert_eq!(v["browser"], "ready", "{v}");
    let dev = c_value(&strings(&v["argv"]), "developer_instructions");
    let parsed: toml::Table = format!("v = {dev}").parse().unwrap();
    let text = parsed["v"].as_str().unwrap();
    assert!(text.starts_with("TOP-SENTINEL\n\n"), "{text:?}");
    assert!(text.contains("Bellwether browser"), "{text:?}");
}

#[test]
fn remote_codex_args_use_the_forward_port() {
    let _serial = serial();
    let s = Scene::new();
    let v = s.agent_args(&[
        "--kind",
        "codex",
        "--machine",
        "mac2",
        "--cwd",
        "/tmp",
        "--profile",
        "work",
    ]);
    assert_eq!(v["browser"], "ready", "{v}");
    assert_eq!(v["machine"], "mac2", "{v}");
    let w = window();
    let fwd: Value =
        serde_json::from_str(&fs::read_to_string(s.forwards().join("mac2.json")).unwrap()).unwrap();
    assert_eq!(fwd["state"], "ready", "{fwd}");
    let port = fwd["port"].as_u64().unwrap();
    assert_ne!(port, u64::from(s.chrome_port));
    let agent = s.remote().join(AGENT_DIR);
    assert_eq!(
        fs::read_to_string(agent.join("ports").join(&w)).unwrap(),
        format!("{port}\n"),
        "mac2's port file holds the forward's port"
    );
    let argv = strings(&v["argv"]);
    assert_eq!(
        c_value(&argv, "mcp_servers.bw-browser.args"),
        format!(
            "[{},{}]",
            json!(agent.join("browser-mcp").display().to_string()),
            json!(w)
        )
    );
    assert_eq!(
        c_value(&argv, "mcp_servers.bw-browser.default_tools_approval_mode"),
        "\"approve\""
    );
    // The window machine got no agent files: they belong to mac2.
    assert!(!s.home().join(AGENT_DIR).join("ports").exists());
    let hc = s.log("hc.log");
    assert!(
        hc.contains(&format!(
            "agent ensure --window {w} --port {port} --no-warm"
        )),
        "{hc}"
    );
    assert!(
        hc.contains(&format!(
            "agent args --kind codex --window {w} --cwd /tmp --profile work"
        )),
        "{hc}"
    );
}

#[test]
fn agent_args_does_not_wait_on_the_warm_step() {
    let _serial = serial();
    let mut s = Scene::new();
    s.set("FAKE_NPX_SLEEP", "8");
    for machine in ["", "mac2"] {
        let started = Instant::now();
        let v = s.agent_args(&["--kind", "claude", "--machine", machine]);
        let took = started.elapsed();
        assert_eq!(v["browser"], "ready", "{v}");
        assert!(
            took < Duration::from_secs(6),
            "agent-args for {machine:?} took {took:?} with an 8 s warm"
        );
    }
    // Both warms still started, each in an hc terminal that removes itself, on its own machine.
    let hc = s.log("hc.log");
    assert!(hc.contains("run bw-warm-local "), "{hc}");
    assert!(hc.contains("run bw-warm-mac2 sh -c "), "{hc}");
    let deadline = Instant::now() + Duration::from_secs(5);
    while s.count("npx.log", "-y chrome-devtools-mcp@1.12.0 --version") < 2 {
        assert!(
            Instant::now() < deadline,
            "warm never ran twice: {}",
            s.log("npx.log")
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn via_gives_empty_argv_and_reason() {
    let _serial = serial();
    let s = Scene::new();
    let v = s.agent_args(&["--kind", "codex", "--machine", "bwloop", "--cwd", "/tmp"]);
    unavailable(
        &v,
        "browser forward unavailable: bwloop connects through via, not SSH",
    );
    assert_eq!(v["machine"], "bwloop");
    assert_eq!(s.count("hc.log", "exec "), 0, "nothing ran on bwloop");
}

#[test]
fn chrome_not_startable_gives_empty_argv() {
    let _serial = serial();
    let mut s = Scene::stopped();
    s.set(
        "BW_CHROME_APP",
        s.path().join("missing.app").to_str().unwrap(),
    );
    let v = s.agent_args(&["--kind", "claude", "--machine", ""]);
    unavailable(&v, "Google Chrome is not installed on this Mac");
    assert!(!s.home().join(AGENT_DIR).exists(), "{v}");

    // open fails: still one line and exit 0.
    let mut s = Scene::stopped();
    write_script(
        &s.path().join("open"),
        "echo 'LSOpenURLs failed' >&2\nexit 1",
    );
    s.set("BW_OPEN", s.path().join("open").to_str().unwrap());
    let v = s.agent_args(&["--kind", "codex", "--machine", "mac2"]);
    unavailable(&v, "open exited 1");
    assert_eq!(s.count("hc.log", "run "), 0, "no forward without a Chrome");
}

#[test]
fn unreadable_codex_config_gives_empty_argv() {
    let _serial = serial();
    let mut s = Scene::new();
    let codex_home = s.path().join("codex-home");
    fs::create_dir(&codex_home).unwrap();
    fs::write(
        codex_home.join("config.toml"),
        "developer_instructions = \"\n",
    )
    .unwrap();
    s.set("CODEX_HOME", codex_home.to_str().unwrap());
    let v = s.agent_args(&["--kind", "codex", "--machine", "", "--cwd", "/tmp"]);
    unavailable(&v, "does not parse");

    // Node missing is named the same way.
    fs::remove_file(s.path().join("bin/npx")).unwrap();
    s.set("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    let v = s.agent_args(&["--kind", "claude", "--machine", ""]);
    unavailable(&v, "npx not found");
}

#[test]
fn agent_args_usage_exits_2() {
    let _serial = serial();
    let s = Scene::new();
    for args in [
        vec!["agent-args", "--machine", ""],
        vec!["agent-args", "--kind", "shell", "--machine", ""],
        vec!["agent-args", "--kind", "claude"],
        vec![
            "agent-args",
            "--kind",
            "claude",
            "--machine",
            "",
            "--cwd",
            "rel",
        ],
        vec![
            "agent-args",
            "--kind",
            "codex",
            "--machine",
            "",
            "--profile",
            "../x",
        ],
        vec!["status", "--extra"],
    ] {
        let (code, lines) = s.run(&args);
        assert_eq!(code, 2, "{args:?}: {lines:?}");
        assert_eq!(lines.len(), 1, "{args:?}: {lines:?}");
        assert_eq!(lines[0]["code"], "usage", "{args:?}: {lines:?}");
    }
}

#[test]
fn status_lists_chrome_tabs_and_live_forwards() {
    let _serial = serial();
    let mut s = Scene::new();
    s.put_forward("mac2", 52817, "ready", "bw-fwd-mac2");
    s.live_terminal(
        "bw-fwd-mac2",
        &[
            "bw",
            "browser",
            "forward",
            "keep",
            "--machine",
            "mac2",
            "--port",
            "52817",
        ],
    );
    let (code, lines) = s.run(&["status"]);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(lines[0]["type"], "chrome", "{lines:?}");
    assert_eq!(lines[0]["state"], "running", "{lines:?}");
    assert_eq!(lines[0]["browser_id"], BROWSER_ID, "{lines:?}");
    let tabs: Vec<&Value> = lines.iter().filter(|l| l["type"] == "tab").collect();
    assert_eq!(tabs.len(), 2, "pages only: {lines:?}");
    assert_eq!(
        tabs[0],
        &json!({"type": "tab", "id": PAGE_A, "title": "Example", "url": "https://example.com/a?q=1",
            "favicon": null, "active": false})
    );
    assert_eq!(tabs[1]["id"], PAGE_B);
    let forwards: Vec<&Value> = lines.iter().filter(|l| l["type"] == "forward").collect();
    assert_eq!(
        forwards,
        vec![
            &json!({"type": "forward", "kind": "browser", "machine": "mac2", "target": "dk@mac2.local",
            "port": 52817, "state": "ready", "reason": "", "terminal": "bw-fwd-mac2"})
        ]
    );
    assert_eq!(lines.len(), 4, "{lines:?}");
}

#[test]
fn status_marks_a_forward_without_terminal_stopped() {
    let _serial = serial();
    let s = Scene::new();
    s.put_forward("mac2", 52817, "ready", "bw-fwd-mac2");
    let (code, lines) = s.run(&["status"]);
    assert_eq!(code, 0);
    let f = lines.iter().find(|l| l["type"] == "forward").unwrap();
    assert_eq!(f["state"], "stopped", "{f}");
    assert_eq!(f["port"], 52817, "{f}");
}

#[test]
fn status_starts_nothing() {
    let _serial = serial();
    let s = Scene::stopped();
    s.put_forward("mac2", 52817, "reconnecting", "bw-fwd-mac2");
    let (code, lines) = s.run(&["status"]);
    assert_eq!(code, 0, "{lines:?}");
    assert_eq!(lines[0]["type"], "chrome", "{lines:?}");
    assert_eq!(lines[0]["state"], "stopped", "{lines:?}");
    assert!(lines.iter().all(|l| l["type"] != "tab"), "{lines:?}");
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(s.log("open.log"), "", "status ran open");
    assert_eq!(s.log("ssh.log"), "", "status ran ssh");
    assert_eq!(s.log("npx.log"), "", "status ran npx");
    let hc = s.log("hc.log");
    assert!(
        hc.lines().all(|l| l == "ls"),
        "status may only list this core's terminals: {hc}"
    );
    assert!(!s.home().join(AGENT_DIR).exists());
}

#[test]
fn two_ups_at_once_run_open_once() {
    let _serial = serial();
    let s = Scene::stopped();
    // The panel's Start and an agent's agent-args, at the same moment.
    let up = s.command(&["up"]).spawn().unwrap();
    let args = s
        .command(&["agent-args", "--kind", "claude", "--machine", ""])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.count("open.log", "open ") == 0 {
        assert!(Instant::now() < deadline, "open never ran");
        thread::sleep(Duration::from_millis(20));
    }
    // Chrome takes a moment to listen, as the real one does.
    thread::sleep(Duration::from_millis(700));
    s.start_chrome();
    let (code, up_lines) = finish(up);
    assert_eq!(code, 0, "{up_lines:?}");
    assert_eq!(up_lines[0]["state"], "running", "{up_lines:?}");
    let (code, args_lines) = finish(args);
    assert_eq!(code, 0, "{args_lines:?}");
    assert_eq!(args_lines[0]["browser"], "ready", "{args_lines:?}");
    assert_eq!(
        s.count("open.log", "open "),
        1,
        "two starts at once ran open twice: {}",
        s.log("open.log")
    );
}

#[test]
fn two_forward_ensures_at_once_start_one_terminal() {
    let _serial = serial();
    let s = Scene::new();
    let a = s
        .command(&["forward", "ensure", "--machine", "mac2"])
        .spawn()
        .unwrap();
    let b = s
        .command(&["forward", "ensure", "--machine", "mac2"])
        .spawn()
        .unwrap();
    let (ca, la) = finish(a);
    let (cb, lb) = finish(b);
    assert_eq!((ca, cb), (0, 0), "{la:?} {lb:?}");
    assert_eq!(la[0]["state"], "ready", "{la:?}");
    assert_eq!(lb[0]["state"], "ready", "{lb:?}");
    assert_eq!(la[0]["port"], lb[0]["port"], "{la:?} {lb:?}");
    assert_eq!(
        s.count("hc.log", "run bw-fwd-mac2 "),
        1,
        "two ensures at once started two terminals: {}",
        s.log("hc.log")
    );
    assert_eq!(s.count("ssh.log", "start "), 1, "{}", s.log("ssh.log"));
}
