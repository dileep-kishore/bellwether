//! `bw feed` on the six recorded sessions and on logs cut, grown and replaced.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

const SCENARIOS: [&str; 6] = [
    "claude-subagents",
    "claude-picture",
    "claude-approval",
    "codex-subagent",
    "codex-question",
    "codex-approval",
];
/// 2026-11-07T00:00:00Z, the day after the recordings, so separators and footers never depend on today.
const NOW_MS: &str = "1794009600000";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn expect(s: &str) -> Value {
    let text = std::fs::read_to_string(fixtures().join("sessions").join(s).join("expect.json"))
        .expect("expect.json");
    serde_json::from_str(&text).expect("expect.json is JSON")
}

fn agent(s: &str) -> &'static str {
    if s.starts_with("codex") {
        "codex"
    } else {
        "claude"
    }
}

/// What scrub-fixture left of the injected AGENTS.md message in a Codex rollout.
const SCRUBBED_AGENTS: &str =
    r#""type":"input_text","text":"[scrubbed: AGENTS.md instructions removed by scrub-fixture]""#;

/// The recording with that message's text starting "# AGENTS.md" again, as Codex writes it and as
/// herdr-core recognises it. Same length, so byte offsets and Codex row ids stay the fixture's.
fn as_written(log: &str) -> String {
    let mut text =
        r##""type":"input_text","text":"# AGENTS.md instructions, scrubbed"##.to_string();
    while text.len() < SCRUBBED_AGENTS.len() - 1 {
        text.push(' ');
    }
    text.push('"');
    assert_eq!(text.len(), SCRUBBED_AGENTS.len());
    log.replace(SCRUBBED_AGENTS, &text)
}

/// A scratch folder for the logs and for `BW_CACHE_DIR`.
struct Scratch {
    tmp: tempfile::TempDir,
}

impl Scratch {
    fn new() -> Scratch {
        Scratch {
            tmp: tempfile::tempdir().expect("temp dir"),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.tmp.path().join(name)
    }

    /// The scenario's root log, copied here under its own name, as the agent wrote it.
    fn root(&self, s: &str) -> PathBuf {
        let name = expect(s)["file"].as_str().unwrap().to_string();
        let to = self.path(&name);
        let text = std::fs::read_to_string(fixtures().join("sessions").join(s).join(&name))
            .expect("read log");
        std::fs::write(&to, as_written(&text)).expect("copy log");
        to
    }

    fn bw(&self, args: &[&str]) -> (i32, Vec<Value>) {
        let out = Command::new(env!("CARGO_BIN_EXE_bw"))
            .args(args)
            .env("BW_CACHE_DIR", self.path("cache"))
            .env("BW_NOW_MS", NOW_MS)
            .env("BW_TZ", "UTC")
            .env("HC_SESSION", "bw-feed-test")
            .env(
                "BW_HC",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-hc"),
            )
            .env("FAKE_HC_GET_DIR", self.path("gets"))
            .output()
            .expect("run bw");
        let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
        let lines = stdout
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
            .collect();
        (out.status.code().expect("exit code"), lines)
    }

    /// `bw feed --log <path> --agent <k> [--pictures] [--cursor <c>]`, which must succeed.
    fn feed(&self, log: &Path, agent: &str, pictures: bool, cursor: Option<&str>) -> Vec<Value> {
        let mut args = vec!["feed", "--log", log.to_str().unwrap(), "--agent", agent];
        if pictures {
            args.push("--pictures");
        }
        if let Some(c) = cursor {
            args.extend(["--cursor", c]);
        }
        let (code, lines) = self.bw(&args);
        assert_eq!(code, 0, "bw {args:?}: {lines:?}");
        lines
    }
}

fn rows(lines: &[Value]) -> Vec<Value> {
    lines
        .iter()
        .filter(|l| l["type"] == "row")
        .cloned()
        .collect()
}

fn line<'a>(lines: &'a [Value], kind: &str) -> &'a Value {
    lines
        .iter()
        .find(|l| l["type"] == kind)
        .unwrap_or_else(|| panic!("no {kind} line in {lines:?}"))
}

fn cursor(lines: &[Value]) -> String {
    line(lines, "log")["cursor"].as_str().unwrap().to_string()
}

fn count(rows: &[Value], k: &str) -> u64 {
    rows.iter().filter(|r| r["k"] == k).count() as u64
}

fn calls(rows: &[Value]) -> u64 {
    rows.iter()
        .filter(|r| r["k"] == "tools")
        .flat_map(|r| r["chips"].as_array().unwrap())
        .map(|c| c["calls"].as_array().unwrap().len() as u64)
        .sum()
}

fn pics(rows: &[Value]) -> u64 {
    rows.iter()
        .filter_map(|r| r["pics"].as_array())
        .map(|p| p.len() as u64)
        .sum()
}

fn feed_rows(s: &str) -> Vec<Value> {
    let x = Scratch::new();
    rows(&x.feed(&x.root(s), agent(s), true, None))
}

/// The log's lines, each with its newline.
fn log_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap()
        .split_inclusive('\n')
        .map(str::to_string)
        .collect()
}

fn write(path: &Path, lines: &[String]) {
    std::fs::write(path, lines.concat()).unwrap();
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(text.as_bytes()).unwrap();
}

/// The index of the first line holding all of `needles`.
fn find(lines: &[String], needles: &[&str]) -> usize {
    lines
        .iter()
        .position(|l| needles.iter().all(|n| l.contains(n)))
        .unwrap_or_else(|| panic!("no line holds {needles:?}"))
}

#[test]
fn rows_match_hand_counts() {
    for s in SCENARIOS {
        let e = expect(s);
        let rows = feed_rows(s);
        assert_eq!(count(&rows, "user"), e["user_messages"], "{s} user");
        assert_eq!(
            count(&rows, "assistant"),
            e["assistant_messages"],
            "{s} assistant"
        );
        assert_eq!(
            calls(&rows) + count(&rows, "question"),
            e["tool_calls"],
            "{s} tool calls"
        );
        assert_eq!(pics(&rows), e["pictures"], "{s} pictures");
        assert_eq!(count(&rows, "perm"), 0, "{s}: every call has its result");
    }
}

#[test]
fn tool_sentences() {
    let tools = |s: &str| -> Vec<Value> {
        feed_rows(s)
            .into_iter()
            .filter(|r| r["k"] == "tools")
            .collect()
    };
    let sub = tools("claude-subagents");
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0]["sentence"], "Delegated 3 tasks");
    assert_eq!(sub[0]["live"], false);
    assert_eq!(sub[0]["error"], false);
    let codex = tools("codex-subagent");
    assert_eq!(codex.len(), 1);
    assert_eq!(
        codex[0]["sentence"],
        "Started a sub-agent and waited for a sub-agent"
    );
    let approval = tools("codex-approval");
    assert_eq!(approval[0]["sentence"], "Ran a command");
}

#[test]
fn changed_files_row_ends_an_editing_turn() {
    let rows = feed_rows("codex-question");
    let at: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r["k"] == "changed")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(at.len(), 2, "{rows:#?}");
    let want = [
        "/scratch/codex-question/colour.txt",
        "/scratch/codex-question/size.txt",
    ];
    for (i, file) in at.iter().zip(want) {
        let r = &rows[*i];
        assert_eq!(r["text"], "Changed 1 file");
        assert_eq!(r["files"], serde_json::json!([file]));
        let next = &rows[i + 1];
        assert_eq!(
            next["k"], "footer",
            "a changed row comes just before its footer"
        );
        let footer_id = next["id"].as_str().unwrap();
        assert_eq!(
            r["id"].as_str().unwrap().strip_prefix("c-"),
            footer_id.strip_prefix("f-"),
            "keyed by the turn's last row, as the footer is"
        );
    }
    // The middle turn asked a question and edited nothing.
    assert_eq!(count(&rows, "footer"), 3);
    for s in ["codex-approval", "claude-subagents", "claude-picture"] {
        assert_eq!(count(&feed_rows(s), "changed"), 0, "{s}");
    }
}

#[test]
fn live_tool_line_until_result() {
    let x = Scratch::new();
    let full = log_lines(&x.root("claude-subagents"));
    let log = x.path("cut.jsonl");
    // Cut after the second of three parallel Agent calls: the newest open call is the pending
    // `perm` row, the older one stays in the tools row without a result.
    let second = find(
        &full,
        &["\"type\":\"assistant\"", "toolu_01RfQ4DGwt2VZuY7S3znfXgH"],
    );
    write(&log, &full[..=second]);
    let first = x.feed(&log, "claude", true, None);
    let r1 = rows(&first);
    let tools_at = r1
        .iter()
        .position(|r| r["k"] == "tools")
        .expect("a tools row");
    assert_eq!(r1[tools_at]["live"], true, "{r1:#?}");
    assert_eq!(r1[tools_at]["sentence"], "Delegated a task");
    assert_eq!(r1[tools_at + 1]["k"], "perm");
    assert_eq!(r1[tools_at + 1]["perm"]["state"], "pending");

    append(&log, &full[second + 1..].concat());
    let second_read = x.feed(&log, "claude", true, Some(&cursor(&first)));
    assert_eq!(line(&second_read, "splice")["at"], tools_at as u64);
    let r2 = rows(&second_read);
    assert_eq!(r2[0]["k"], "tools");
    assert_eq!(r2[0]["live"], false);
    assert_eq!(r2[0]["sentence"], "Delegated 3 tasks");
    assert_eq!(count(&r2, "perm"), 0);

    // A cut after Claude's only call shows it as a pending request, not as a tools row.
    let a = log_lines(&x.root("claude-approval"));
    let only = find(&a, &["\"type\":\"assistant\"", "\"tool_use\""]);
    let cut = x.path("approval-cut.jsonl");
    write(&cut, &a[..=only]);
    let r = rows(&x.feed(&cut, "claude", true, None));
    assert_eq!(count(&r, "tools"), 0);
    assert_eq!(r.last().unwrap()["k"], "perm");
    assert_eq!(r.last().unwrap()["perm"]["command"], "touch approved.txt");
}

#[test]
fn unchanged_cursor_prints_unchanged() {
    let x = Scratch::new();
    let log = x.root("codex-question");
    let first = x.feed(&log, "codex", true, None);
    let c = cursor(&first);
    let again = x.feed(&log, "codex", true, Some(&c));
    assert_eq!(again.len(), 2, "{again:?}");
    assert_eq!(again[0]["type"], "log");
    assert_eq!(again[0]["cursor"], c.as_str());
    assert_eq!(again[0]["size"], line(&first, "log")["size"]);
    assert_eq!(again[1], serde_json::json!({"type": "unchanged"}));
}

#[test]
fn growth_splices_from_first_changed_row() {
    let x = Scratch::new();
    let full = log_lines(&x.root("codex-question"));
    let log = x.path("grow.jsonl");
    let turn_end = find(&full, &["\"task_complete\""]);
    write(&log, &full[..=turn_end]);
    let first = x.feed(&log, "codex", true, None);
    let before = rows(&first);
    assert_eq!(line(&first, "splice")["at"], 0);
    assert_eq!(line(&first, "splice")["count"], before.len() as u64);

    append(&log, &full[turn_end + 1..].concat());
    let grown = x.feed(&log, "codex", true, Some(&cursor(&first)));
    let at = line(&grown, "splice")["at"].as_u64().unwrap() as usize;
    assert!(at > 0 && at <= before.len(), "splice at {at}");
    let mut joined = before[..at].to_vec();
    joined.extend(rows(&grown));
    let fresh = Scratch::new();
    let whole = rows(&fresh.feed(&log, "codex", true, None));
    assert_eq!(joined, whole, "kept rows plus the splice are a fresh read");
    assert_eq!(line(&grown, "splice")["count"], whole.len() as u64);
}

#[test]
fn partial_last_line_is_left_for_next_read() {
    let x = Scratch::new();
    let full = log_lines(&x.root("codex-question"));
    let reply = find(&full, &["\"response_item\"", "\"role\":\"assistant\""]);
    let log = x.path("partial.jsonl");
    let half = &full[reply][..full[reply].len() / 2];
    write(&log, &full[..reply]);
    append(&log, half);

    let first = x.feed(&log, "codex", true, None);
    let shown = rows(&first);
    let clean = x.path("clean.jsonl");
    write(&clean, &full[..reply]);
    assert_eq!(
        shown,
        rows(&x.feed(&clean, "codex", true, None)),
        "half a line shows nothing"
    );
    assert_eq!(count(&shown, "assistant"), 0);

    append(&log, &full[reply][half.len()..]);
    let done = x.feed(&log, "codex", true, Some(&cursor(&first)));
    let at = line(&done, "splice")["at"].as_u64().unwrap() as usize;
    assert!(at <= shown.len());
    let added = rows(&done);
    assert_eq!(
        count(&added, "assistant"),
        1,
        "the finished line is read: {added:#?}"
    );
}

#[test]
fn shrunk_log_restarts_at_zero() {
    let x = Scratch::new();
    let full = log_lines(&x.root("codex-question"));
    let log = x.path("shrink.jsonl");
    write(&log, &full);
    let first = x.feed(&log, "codex", true, None);

    let turn_end = find(&full, &["\"task_complete\""]);
    write(&log, &full[..=turn_end]);
    let after = x.feed(&log, "codex", true, Some(&cursor(&first)));
    let fresh = Scratch::new();
    let want = rows(&fresh.feed(&log, "codex", true, None));
    assert_eq!(line(&after, "splice")["at"], 0);
    assert_eq!(line(&after, "splice")["count"], want.len() as u64);
    assert_eq!(rows(&after), want);
    assert!(rows(&first).len() > want.len());
}

#[test]
fn cursor_from_other_path_or_mode_is_ignored() {
    let x = Scratch::new();
    let a = x.root("claude-picture");
    let b = x.path("other.jsonl");
    std::fs::copy(&a, &b).unwrap();
    let first = x.feed(&a, "claude", true, None);
    let c = cursor(&first);
    assert!(c.starts_with("2.") && c.ends_with(".1"), "cursor {c}");
    let n = rows(&first).len() as u64;

    let other_path = x.feed(&b, "claude", true, Some(&c));
    assert_eq!(line(&other_path, "splice")["at"], 0);
    assert_eq!(line(&other_path, "splice")["count"], n);

    let other_mode = x.feed(&a, "claude", false, Some(&c));
    assert_eq!(line(&other_mode, "splice")["at"], 0);
    let plain = cursor(&other_mode);
    assert!(plain.ends_with(".0"), "cursor {plain}");
    assert!(
        rows(&other_mode).iter().all(|r| r.get("pics").is_none()),
        "no picture places without --pictures"
    );

    // Version 1 cursors (Flockbook's) and junk read as none.
    let v1 = format!(
        "1.{}",
        plain
            .strip_prefix("2.")
            .unwrap()
            .rsplit_once('.')
            .unwrap()
            .0
    );
    for junk in [v1.as_str(), "2.x.0.0.y.0", "nonsense"] {
        let r = x.feed(&a, "claude", false, Some(junk));
        assert_eq!(line(&r, "splice")["at"], 0, "cursor {junk}");
    }
    let again = x.feed(
        &a,
        "claude",
        false,
        Some(&cursor(&x.feed(&a, "claude", false, None))),
    );
    assert_eq!(again[1]["type"], "unchanged");
}

/// A Claude log of `n` exchanges, each user and assistant line about 9 KB.
fn long_claude_log(path: &Path, n: usize) {
    let body = "x".repeat(9000);
    let mut out = String::new();
    for i in 0..n {
        let t = format!("2026-11-06T20:{:02}:{:02}.000Z", (i / 60) % 60, i % 60);
        out.push_str(&format!(
            r#"{{"type":"user","uuid":"u{i}","timestamp":"{t}","message":{{"role":"user","content":"question {i} {body}"}}}}"#
        ));
        out.push('\n');
        out.push_str(&format!(
            r#"{{"type":"assistant","uuid":"a{i}","timestamp":"{t}","message":{{"role":"assistant","model":"claude-test-1","content":[{{"type":"text","text":"answer {i} {body}"}}]}}}}"#
        ));
        out.push('\n');
    }
    std::fs::write(path, out).unwrap();
}

#[test]
fn before_reads_older_rows() {
    let x = Scratch::new();
    let log = x.path("long.jsonl");
    long_claude_log(&log, 300);
    let first = x.feed(&log, "claude", true, None);
    let start = line(&first, "log")["start"].as_u64().unwrap();
    assert!(start > 0, "a 5 MB log is read from its last 2 MB");
    assert_eq!(line(&first, "log")["model"], "claude-test-1");
    let tail_ids: Vec<Value> = rows(&first).iter().map(|r| r["id"].clone()).collect();

    let s = start.to_string();
    let (code, older) = x.bw(&[
        "feed",
        "--log",
        log.to_str().unwrap(),
        "--agent",
        "claude",
        "--before",
        &s,
        "--pictures",
    ]);
    assert_eq!(code, 0, "{older:?}");
    let head = &older[0];
    assert_eq!(head["type"], "older");
    assert_eq!(head["path"], log.to_str().unwrap());
    let older_start = head["start"].as_u64().unwrap();
    assert!(older_start < start && older_start > 0);
    let older_rows = rows(&older);
    assert_eq!(head["count"], older_rows.len() as u64);
    assert!(!older_rows.is_empty());
    assert!(older_rows.iter().all(|r| !tail_ids.contains(&r["id"])));
    assert_eq!(older_rows[0]["k"], "user", "a cut first line is dropped");

    let s = older_start.to_string();
    let (_, oldest) = x.bw(&[
        "feed",
        "--log",
        log.to_str().unwrap(),
        "--agent",
        "claude",
        "--before",
        &s,
    ]);
    assert_eq!(oldest[0]["start"], 0, "the file's start is reached");
    assert!(rows(&oldest)[0]["id"].as_str().unwrap().starts_with("u0-"));

    let again = x.feed(&log, "claude", true, Some(&cursor(&first)));
    assert_eq!(again[1]["type"], "unchanged", "--before keeps no state");
}

/// The saved output, with the `log` line's `path` and `cursor` left out: they name the scratch copy.
fn golden_text(lines: &[Value]) -> String {
    lines
        .iter()
        .map(|l| {
            let mut l = l.clone();
            if l["type"] == "log" {
                let o = l.as_object_mut().unwrap();
                o.remove("path");
                o.remove("cursor");
            }
            format!("{l}\n")
        })
        .collect()
}

#[test]
fn goldens_are_current() {
    let bless = std::env::var("BW_BLESS").is_ok_and(|v| v == "1");
    let mut stale = vec![];
    for s in SCENARIOS {
        let x = Scratch::new();
        let got = golden_text(&x.feed(&x.root(s), agent(s), true, None));
        let file = fixtures().join("feed").join(format!("{s}.jsonl"));
        if bless {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, &got).unwrap();
        } else if std::fs::read_to_string(&file).ok().as_deref() != Some(got.as_str()) {
            stale.push(s);
        }
    }
    assert!(
        stale.is_empty(),
        "stale goldens {stale:?}: rerun with BW_BLESS=1 and review the diff"
    );
}

#[test]
fn log_line_names_agent_and_session() {
    for s in SCENARIOS {
        let x = Scratch::new();
        let log = x.root(s);
        let lines = x.feed(&log, agent(s), true, None);
        let l = &lines[0];
        assert_eq!(l["type"], "log");
        assert_eq!(l["agent"], agent(s));
        assert_eq!(l["terminal"], Value::Null);
        assert_eq!(l["session"], expect(s)["session"], "{s}");
        assert_eq!(l["path"], log.to_str().unwrap());
        assert_eq!(l["start"], 0);
        assert_eq!(l["size"], std::fs::metadata(&log).unwrap().len());
        assert_eq!(lines[1]["type"], "splice");
    }
}

#[test]
fn missing_log_and_bad_options() {
    let x = Scratch::new();
    let gone = x.path("gone.jsonl");
    let (code, lines) = x.bw(&["feed", "--log", gone.to_str().unwrap(), "--agent", "claude"]);
    assert_eq!(code, 1);
    assert_eq!(lines[0]["type"], "error");
    assert_eq!(lines[0]["code"], "not_found");
    let log = x.root("claude-picture");
    let log = log.to_str().unwrap();
    for args in [
        vec!["feed"],
        vec!["feed", "--log", log],
        vec!["feed", "--log", log, "--agent", "grok"],
        vec![
            "feed",
            "--terminal",
            "t1",
            "--log",
            log,
            "--agent",
            "claude",
        ],
        vec!["feed", "--log", log, "--agent", "claude", "--before", "x"],
        vec!["feed", "--log", log, "--agent", "claude", "--bogus"],
    ] {
        let (code, lines) = x.bw(&args);
        assert_eq!(code, 2, "{args:?}");
        assert_eq!(lines[0]["code"], "usage", "{args:?}");
    }
}

#[test]
fn cache_holds_no_transcript_text() {
    let x = Scratch::new();
    let log = x.root("codex-question");
    x.feed(&log, "codex", true, None);
    let mut found = vec![];
    let mut stack = vec![x.path("cache")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            if e.path().is_dir() {
                stack.push(e.path());
            } else {
                found.push(std::fs::read_to_string(e.path()).unwrap());
            }
        }
    }
    assert_eq!(found.len(), 1, "one state file for the log");
    for word in ["colour", "Which size", "large"] {
        assert!(
            !found[0].contains(word),
            "cache holds {word:?}: {}",
            found[0]
        );
    }
}

#[test]
fn terminal_mode_prints_the_locate_state() {
    // fake-hc knows no terminal t1; tests/locate.rs covers the other states and a located terminal.
    let x = Scratch::new();
    let (code, lines) = x.bw(&["feed", "--terminal", "t1", "--pictures"]);
    assert_eq!(code, 0);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["type"], "state");
    assert_eq!(lines[0]["state"], "no_terminal");
}

/// A message `bw send` delivered from another core, as `hc send` wraps it (probe against bwloop, 2026-11-07).
fn hc_wrapped(text: &str) -> String {
    format!("<hc from=\"495a7fa4c01bdb33213c3868c28d6caa/ppid:53078\">{text}</hc>")
}

#[test]
fn message_sent_from_another_core_is_a_user_row() {
    let text = "--force \"q\" </hc>\nline 2";
    let x = Scratch::new();
    let log = x.root("codex-question");
    let item = serde_json::json!({"timestamp": "2026-11-06T22:20:00.000Z", "type": "response_item",
        "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": hc_wrapped(text)}]}});
    append(&log, &format!("{item}\n"));
    let users: Vec<Value> = rows(&x.feed(&log, "codex", true, None))
        .into_iter()
        .filter(|r| r["k"] == "user")
        .collect();
    assert_eq!(users.last().unwrap()["text"], text, "codex");

    let log = x.root("claude-approval");
    let item = serde_json::json!({"timestamp": "2026-11-06T22:20:00.000Z", "type": "user", "uuid": "u-hc-1",
        "message": {"role": "user", "content": hc_wrapped("hello there")}});
    append(&log, &format!("{item}\n"));
    let users: Vec<Value> = rows(&x.feed(&log, "claude", true, None))
        .into_iter()
        .filter(|r| r["k"] == "user")
        .collect();
    assert_eq!(users.last().unwrap()["text"], "hello there", "claude");
}
