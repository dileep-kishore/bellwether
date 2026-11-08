//! `bw linear` against a loopback fake of Linear's GraphQL endpoint, through the real curl. A fake
//! `security` hands out a made-up key, and a curl wrapper logs its arguments, so the tests can show the
//! key reaches Linear's Authorization header and nowhere else.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

const KEY: &str = "lin_api_TESTKEYabcdefghijklmnopqrstuvwxyz0123";

#[derive(Clone, Default)]
struct Seen {
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}

/// What the fake answers: (HTTP status, body).
type Handler = Arc<dyn Fn(&Value) -> (u16, String) + Send + Sync>;

struct Fake {
    port: u16,
    seen: Seen,
}

fn issue(id: &str, title: &str, state: (&str, &str), project: &str, mine: bool) -> Value {
    json!({"id": format!("u-{id}"), "identifier": id, "title": title, "url": format!("https://linear.app/x/issue/{id}"),
        "branchName": format!("feature/{}", id.to_lowercase()), "priority": 0, "updatedAt": "2026-11-08T00:00:00Z",
        "state": {"name": state.0, "type": state.1, "color": "#aaaaaa", "position": 1},
        "assignee": if mine { json!({"name": "Me", "displayName": "me", "isMe": true}) } else { Value::Null },
        "project": {"id": project, "name": project}, "labels": {"nodes": []}})
}

fn issues() -> Vec<Value> {
    vec![
        issue("PLA-1", "One", ("Todo", "unstarted"), "P1", true),
        issue("PLA-2", "Two", ("In Progress", "started"), "P1", false),
        issue("PLA-3", "Three", ("Backlog", "backlog"), "P1", false),
        issue("PLA-4", "Done one", ("Done", "completed"), "P1", false),
        issue("PLA-5", "Elsewhere", ("Todo", "unstarted"), "P2", true),
        issue("PLA-6", "Other", ("Todo", "unstarted"), "P2", false),
    ]
}

/// Applies the filters `bw` sends, as Linear would.
fn matches(n: &Value, f: &Value) -> bool {
    if let Some(nin) = f["state"]["type"]["nin"].as_array() {
        if nin.iter().any(|t| t == &n["state"]["type"]) {
            return false;
        }
    }
    if let Some(p) = f["project"]["id"]["eq"].as_str() {
        if n["project"]["id"] != p {
            return false;
        }
    }
    if f["assignee"]["isMe"]["eq"] == true && n["assignee"]["isMe"] != true {
        return false;
    }
    true
}

fn linear(body: &Value) -> (u16, String) {
    let q = body["query"].as_str().unwrap_or("");
    let vars = &body["variables"];
    let page = |field: &str, nodes: Vec<Value>| {
        // Two to a page when the fake is asked to page, so `after` is exercised.
        let after = vars["after"].as_str();
        let (nodes, next) = if q.contains("first: 50")
            && nodes.len() > 2
            && after.is_none()
            && vars["filter"]["project"].is_null()
            && field == "issues"
        {
            (nodes[..2].to_vec(), Some("c2"))
        } else if after == Some("c2") {
            (nodes[2..].to_vec(), None)
        } else {
            (nodes, None)
        };
        json!({"data": {field: {"nodes": nodes, "pageInfo": {"hasNextPage": next.is_some(), "endCursor": next}}}})
            .to_string()
    };
    if q.contains("searchIssues(") {
        let term = vars["term"].as_str().unwrap_or("").to_lowercase();
        let found = issues()
            .into_iter()
            .filter(|n| n["title"].as_str().unwrap().to_lowercase().contains(&term))
            .collect();
        return (200, page("searchIssues", found));
    }
    if q.contains(" issues(") {
        let found = issues()
            .into_iter()
            .filter(|n| matches(n, &vars["filter"]))
            .collect();
        return (200, page("issues", found));
    }
    if q.contains(" issue(id") {
        let id = vars["id"].as_str().unwrap_or("");
        let mut n = issues().into_iter().find(|n| n["identifier"] == id);
        if let Some(n) = n.as_mut() {
            n["description"] = json!(match id {
                "PLA-2" => "x".repeat(9000),
                _ => "A short description.".to_string(),
            });
        }
        return (200, json!({"data": {"issue": n}}).to_string());
    }
    if q.contains(" projects(") {
        return (
            200,
            json!({"data": {"projects": {"nodes": [
                {"id": "P1", "name": "Bellwether", "url": "https://linear.app/x/project/p1", "teams": {"nodes": [{"key": "PLA"}]}},
                {"id": "P2", "name": "Bellwether scratch", "url": "https://linear.app/x/project/p2", "teams": {"nodes": [{"key": "PLA"}]}}
            ], "pageInfo": {"hasNextPage": false, "endCursor": null}}}})
            .to_string(),
        );
    }
    (
        400,
        json!({"errors": [{"message": "unknown query"}]}).to_string(),
    )
}

fn serve(handler: Handler) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Seen::default();
    let s = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            answer(stream, &handler, &s);
        }
    });
    Fake { port, seen }
}

fn answer(stream: TcpStream, handler: &Handler, seen: &Seen) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut auth = String::new();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).unwrap();
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (name, value) = h.split_once(':').unwrap_or((h, ""));
        match name.to_ascii_lowercase().as_str() {
            "authorization" => auth = value.trim().to_string(),
            "content-length" => len = value.trim().parse().unwrap(),
            _ => {}
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (status, reply) = handler(&body);
    seen.requests.lock().unwrap().push((auth, body));
    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    );
}

struct Env {
    dir: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        let dir = tempfile::Builder::new()
            .prefix("bw-linear-test")
            .tempdir_in("/private/tmp")
            .unwrap();
        let d = dir.path();
        write_exec(
            &d.join("security"),
            &format!(
                "#!/bin/sh\n[ -f \"{0}/nokey\" ] && {{ echo 'could not be found' >&2; exit 44; }}\n\
                 [ \"$*\" = 'find-generic-password -s bellwether.linear -w' ] || exit 9\necho {KEY}\n",
                d.display()
            ),
        );
        write_exec(
            &d.join("curl"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{0}/curl-argv.log\"\nexec /usr/bin/curl \"$@\"\n",
                d.display()
            ),
        );
        write_exec(
            &d.join("hc"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{0}/hc-argv.log\"\necho '{{\"path\":\"/remote/home/PLA-2-description.md\"}}'\n",
                d.display()
            ),
        );
        Env { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn cache(&self) -> PathBuf {
        self.path().join("cache")
    }

    fn bw(&self, port: u16, args: &[&str]) -> Output {
        let d = self.path();
        Command::new(env!("CARGO_BIN_EXE_bw"))
            .arg("linear")
            .args(args)
            .env("HOME", d)
            .env("BW_CACHE_DIR", self.cache())
            .env("BW_LINEAR_URL", format!("http://127.0.0.1:{port}/graphql"))
            .env("BW_SECURITY", d.join("security"))
            .env("BW_CURL", d.join("curl"))
            .env("BW_HC", d.join("hc"))
            .output()
            .unwrap()
    }
}

fn write_exec(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    Command::new("chmod").arg("755").arg(path).status().unwrap();
}

fn lines(out: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|_| panic!("not JSON: {l}")))
        .collect()
}

fn ids(out: &Output) -> Vec<String> {
    lines(out)
        .iter()
        .filter(|l| l["type"] == "linear-issue")
        .map(|l| l["identifier"].as_str().unwrap().to_string())
        .collect()
}

fn error_code(out: &Output) -> String {
    lines(out)
        .iter()
        .find(|l| l["type"] == "error")
        .map(|l| l["code"].as_str().unwrap().to_string())
        .unwrap_or_default()
}

fn closed_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

#[test]
fn project_scope_lists_that_projects_open_issues() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let out = env.bw(
        fake.port,
        &["issues", "--scope", "project", "--project", "P1"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(ids(&out), ["PLA-1", "PLA-2", "PLA-3"]);
    let reqs = fake.seen.requests.lock().unwrap();
    let (auth, body) = &reqs[0];
    assert_eq!(auth, KEY);
    assert!(body["query"].as_str().unwrap().contains("issues(first: 50"));
    assert_eq!(body["variables"]["filter"]["project"]["id"]["eq"], "P1");
    assert_eq!(
        body["variables"]["filter"]["state"]["type"]["nin"],
        json!(["completed", "canceled", "duplicate"])
    );
    let page = lines(&out).into_iter().last().unwrap();
    assert_eq!(page["type"], "linear-page");
    assert_eq!(page["cached"], false);
    assert_eq!(page["next"], Value::Null);
}

#[test]
fn mine_and_all_change_the_list() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let mine = env.bw(fake.port, &["issues", "--scope", "mine"]);
    assert_eq!(ids(&mine), ["PLA-1", "PLA-5"]);
    let all = env.bw(fake.port, &["issues", "--scope", "all"]);
    // Two to a page in the fake: the second page comes with --after.
    assert_eq!(ids(&all), ["PLA-1", "PLA-2"]);
    let page = lines(&all).into_iter().last().unwrap();
    assert_eq!(page["next"], "c2");
    let more = env.bw(fake.port, &["issues", "--scope", "all", "--after", "c2"]);
    assert_eq!(ids(&more), ["PLA-3", "PLA-5", "PLA-6"]);
    let reqs = fake.seen.requests.lock().unwrap();
    assert_eq!(
        reqs[0].1["variables"]["filter"]["assignee"]["isMe"]["eq"],
        true
    );
    assert_eq!(reqs[2].1["variables"]["after"], "c2");
}

#[test]
fn search_sends_the_term_and_drops_closed_issues() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let out = env.bw(fake.port, &["search", "--text", "one", "--scope", "all"]);
    assert_eq!(ids(&out), ["PLA-1"]);
    let reqs = fake.seen.requests.lock().unwrap();
    assert!(reqs[0].1["query"]
        .as_str()
        .unwrap()
        .contains("searchIssues("));
    assert_eq!(reqs[0].1["variables"]["term"], "one");
}

#[test]
fn projects_lists_the_workspace() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let out = env.bw(fake.port, &["projects"]);
    let names: Vec<_> = lines(&out)
        .into_iter()
        .filter(|l| l["type"] == "linear-project")
        .map(|l| l["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Bellwether", "Bellwether scratch"]);
}

#[test]
fn no_key_is_named() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    std::fs::write(env.path().join("nokey"), "").unwrap();
    let out = env.bw(fake.port, &["issues", "--scope", "mine"]);
    assert_eq!(error_code(&out), "no_key");
    assert!(String::from_utf8_lossy(&out.stdout).contains("scripts/linear-key.sh"));
    assert!(fake.seen.requests.lock().unwrap().is_empty());
}

#[test]
fn refused_key_is_named() {
    let fake = serve(Arc::new(|_: &Value| {
        (
            401,
            json!({"errors": [{"message": "Authentication required", "extensions": {"code": "AUTHENTICATION_ERROR"}}]})
                .to_string(),
        )
    }));
    let env = Env::new();
    let out = env.bw(fake.port, &["issues", "--scope", "mine"]);
    assert_eq!(error_code(&out), "key_refused");
}

#[test]
fn offline_serves_the_cache_with_its_age() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let args = ["issues", "--scope", "project", "--project", "P1"];
    assert!(env.bw(fake.port, &args).status.success());
    let out = env.bw(closed_port(), &args);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(ids(&out), ["PLA-1", "PLA-2", "PLA-3"]);
    let page = lines(&out).into_iter().last().unwrap();
    assert_eq!(page["cached"], true);
    assert!(page["age_s"].as_i64().unwrap() >= 0);
    // A list never read before has nothing to show.
    let other = env.bw(closed_port(), &["issues", "--scope", "mine"]);
    assert_eq!(error_code(&other), "offline");
}

#[test]
fn issue_text_and_the_8_kb_rule() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let short = env.bw(fake.port, &["issue", "--id", "PLA-1", "--text"]);
    let l = &lines(&short)[0];
    assert_eq!(l["mode"], "full");
    assert_eq!(
        l["text"],
        "Linear issue PLA-1: One\nhttps://linear.app/x/issue/PLA-1\n\nA short description.\n\n---\n"
    );

    let long = env.bw(fake.port, &["issue", "--id", "PLA-2", "--text"]);
    assert_eq!(error_code(&long), "too_large");

    let trimmed = env.bw(fake.port, &["issue", "--id", "PLA-2", "--text", "--trim"]);
    let l = &lines(&trimmed)[0];
    assert_eq!(l["mode"], "trim");
    assert_eq!(l["bytes"], 9000);
    let text = l["text"].as_str().unwrap();
    assert!(text.starts_with("Linear issue PLA-2: Two\n"));
    assert!(text.contains(&"x".repeat(8192)) && !text.contains(&"x".repeat(8193)));
    assert!(text.ends_with("---\n"));

    let file = env.bw(
        fake.port,
        &["issue", "--id", "PLA-2", "--text", "--put", "macbook/t7"],
    );
    let l = &lines(&file)[0];
    assert_eq!(l["mode"], "file", "{l}");
    assert_eq!(l["path"], "/remote/home/PLA-2-description.md");
    assert!(l["text"]
        .as_str()
        .unwrap()
        .contains("is in /remote/home/PLA-2-description.md"));
    let hc = std::fs::read_to_string(env.path().join("hc-argv.log")).unwrap();
    assert!(hc.starts_with("put --json -- macbook/t7 "), "{hc}");
    let sent = env.cache().join("linear/attach/PLA-2-description.md");
    assert_eq!(std::fs::read_to_string(sent).unwrap(), "x".repeat(9000));
}

#[test]
fn issue_detail_has_the_description() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let out = env.bw(fake.port, &["issue", "--id", "PLA-1"]);
    let l = &lines(&out)[0];
    assert_eq!(l["identifier"], "PLA-1");
    assert_eq!(l["description"], "A short description.");
    assert_eq!(l["bytes"], 20);
    let missing = env.bw(fake.port, &["issue", "--id", "PLA-99"]);
    assert_eq!(error_code(&missing), "not_found");
}

#[test]
fn the_key_is_never_in_argv_output_or_cache() {
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    let mut stdout = String::new();
    for args in [
        vec!["projects"],
        vec!["issues", "--scope", "all"],
        vec!["issue", "--id", "PLA-2", "--text", "--put", "t1"],
    ] {
        let out = env.bw(fake.port, &args);
        stdout.push_str(&String::from_utf8_lossy(&out.stdout));
        stdout.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    let refused = serve(Arc::new(|_: &Value| (401, "{}".to_string())));
    let out = env.bw(refused.port, &["issues", "--scope", "all"]);
    stdout.push_str(&String::from_utf8_lossy(&out.stdout));
    assert!(!stdout.contains(&KEY[..12]));
    let argv = std::fs::read_to_string(env.path().join("curl-argv.log")).unwrap();
    assert!(argv.lines().count() >= 4);
    assert!(!argv.contains(&KEY[..12]), "{argv}");
    let mut files = vec![env.cache()];
    while let Some(p) = files.pop() {
        if p.is_dir() {
            files.extend(std::fs::read_dir(&p).unwrap().map(|e| e.unwrap().path()));
        } else {
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            assert!(!text.contains(&KEY[..12]), "{} holds the key", p.display());
        }
    }
}

#[test]
fn only_linear_or_loopback_gets_the_key() {
    let env = Env::new();
    let out = Command::new(env!("CARGO_BIN_EXE_bw"))
        .args(["linear", "issues", "--scope", "mine"])
        .env("HOME", env.path())
        .env("BW_CACHE_DIR", env.cache())
        .env("BW_LINEAR_URL", "https://example.com/graphql")
        .env("BW_SECURITY", env.path().join("security"))
        .output()
        .unwrap();
    assert_eq!(error_code(&out), "usage");
    assert!(!env.path().join("curl-argv.log").exists());
}

#[test]
fn the_cache_is_private_to_this_account() {
    use std::os::unix::fs::PermissionsExt;
    let fake = serve(Arc::new(linear));
    let env = Env::new();
    // A cache root that does not exist yet, as on first use.
    assert!(!env.cache().exists());
    let out = env.bw(
        fake.port,
        &["issue", "--id", "PLA-2", "--text", "--put", "t1"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let linear = env.cache().join("linear");
    for dir in [env.cache(), linear.clone(), linear.join("attach")] {
        assert_eq!(mode(&dir), 0o700, "{}", dir.display());
    }
    let mut files = 0;
    for dir in [linear.clone(), linear.join("attach")] {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_file() {
                files += 1;
                assert_eq!(mode(&p), 0o600, "{}", p.display());
            }
        }
    }
    assert!(files >= 2);
}
