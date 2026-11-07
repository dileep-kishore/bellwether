//! Bellwether's changes to the vendored core (see UPSTREAM), checked on the scrubbed recordings in
//! tests/fixtures/sessions.

use chrono::{DateTime, Duration, Local, Utc};
use herdr_core::conversation::{parse_lines, parse_lines_in, ConversationParser, FileScope};
use herdr_core::resolver::{
    codex_candidates, codex_matches, codex_meta_full, log_path, log_path_in, without_codex_subagents, LogRoots, Need,
    Proc, SessionResolver,
};
use herdr_core::util::Date;
use herdr_core::{ConversationItem, ItemKind, ToolCall};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const SESSIONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/fixtures/sessions/");
const PARENT: &str = "codex-subagent/rollout-2026-11-06T22-11-05-01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc.jsonl";
const CHILD: &str = "codex-subagent/rollout-2026-11-06T22-11-09-01a1b4a1-dfcb-77e0-8029-0fbb3b65e5ba.jsonl";
const CWD: &str = "/scratch/codex-subagent";

fn fixture(rel: &str) -> Vec<u8> {
    std::fs::read(Path::new(SESSIONS).join(rel)).unwrap_or_else(|e| panic!("fixture {rel}: {e}"))
}

fn first_line(rel: &str) -> Vec<u8> {
    let data = fixture(rel);
    let nl = data.iter().position(|b| *b == b'\n').unwrap_or(data.len());
    data[..nl].to_vec()
}

fn start_of(rel: &str) -> Date {
    codex_meta_full(&first_line(rel)).expect("session_meta").start
}

/// Copies a rollout into `<sessions>/YYYY/MM/DD/` under the name Codex would give it in this machine's time zone,
/// so the day folder and name stamp do not depend on the recorder's zone.
fn place(sessions: &Path, rel: &str) -> String {
    let meta = codex_meta_full(&first_line(rel)).expect("session_meta");
    let local: DateTime<Local> = meta.start.with_timezone(&Local);
    let dir = sessions.join(local.format("%Y/%m/%d").to_string());
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("rollout-{}-{}.jsonl", local.format("%Y-%m-%dT%H-%M-%S"), meta.id));
    std::fs::write(&path, fixture(rel)).unwrap();
    path.to_string_lossy().into_owned()
}

fn names(paths: Vec<String>) -> Vec<String> {
    paths.iter().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned()).collect()
}

fn name(p: &str) -> String {
    names(vec![p.to_string()]).remove(0)
}

struct Home {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    sessions: PathBuf,
    parent: String,
    child: String,
}

fn codex_home() -> Home {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let sessions = root.join("codex-home/sessions");
    let parent = place(&sessions, PARENT);
    let child = place(&sessions, CHILD);
    Home { _tmp: tmp, root, sessions, parent, child }
}

#[test]
fn codex_meta_full_reads_id_and_subagent() {
    let child = codex_meta_full(&first_line(CHILD)).expect("child meta");
    assert_eq!(child.id, "01a1b4a1-dfcb-77e0-8029-0fbb3b65e5ba");
    assert_eq!(child.cwd, CWD);
    assert!(child.subagent, "child's source names a sub-agent");
    let parent = codex_meta_full(&first_line(PARENT)).expect("parent meta");
    assert_eq!(parent.id, "01a1b4a1-cd88-7852-b34b-2cf0f36c8fbc");
    assert!(!parent.subagent, "parent's source is a string");
    assert_eq!(parent.start, DateTime::parse_from_rfc3339("2026-11-07T06:11:05.241Z").unwrap().with_timezone(&Utc));
    assert!(codex_meta_full(b"{\"type\":\"response_item\",\"payload\":{}}").is_none(), "not a session_meta line");
}

#[test]
fn codex_candidates_skip_subagent_rollouts() {
    let h = codex_home();
    let dir = h.sessions.to_string_lossy().into_owned();
    let after = start_of(PARENT) - Duration::seconds(1);
    assert_eq!(names(codex_candidates(&dir, CWD, after, after + Duration::hours(1))), vec![name(&h.parent)]);
    let lines = vec![(h.parent.clone(), first_line(PARENT)), (h.child.clone(), first_line(CHILD))];
    assert_eq!(codex_matches(&lines, CWD, after), vec![h.parent.clone()], "codex_matches skips the child too");
}

#[test]
fn log_path_in_uses_codex_home_and_skips_children() {
    let h = codex_home();
    let tmp = h.root.to_string_lossy().into_owned();
    let roots = LogRoots { codex_sessions: format!("{tmp}/codex-home/sessions"), ..LogRoots::in_home("/nohome") };
    let open = vec![h.parent.clone(), h.child.clone(), format!("{tmp}/codex-home/logs_2.sqlite")];
    assert_eq!(log_path_in(&open, "codex", None, &roots), None, "parent and child both open: no guess");
    let open_without_children = without_codex_subagents(&open);
    assert_eq!(open_without_children, vec![h.parent.clone(), format!("{tmp}/codex-home/logs_2.sqlite")]);
    assert_eq!(log_path_in(&open_without_children, "codex", None, &roots), Some(h.parent.clone()));
    assert_eq!(log_path(&open_without_children, "codex", None, "/nohome"), None, "~/.codex/sessions is not the root");
    assert_eq!(LogRoots::in_home("/h").codex_sessions, "/h/.codex/sessions");
    let claude = LogRoots { claude_projects: format!("{tmp}/claude/projects"), ..LogRoots::in_home("/nohome") };
    let log = format!("{tmp}/claude/projects/-w/abc.jsonl");
    assert_eq!(log_path_in(std::slice::from_ref(&log), "claude", None, &claude), Some(log.clone()), "Claude config dir");
    assert_eq!(log_path(&[log], "claude", None, "/nohome"), None);
}

/// The resolver's own `codex_dir` reaches both routes, and neither hands out the child.
#[test]
fn resolver_finds_codex_root_beside_child() {
    let h = codex_home();
    let agent = Proc { pid: 4242, ppid: 1, start: start_of(PARENT) - Duration::seconds(1), line: "codex exec x".into() };
    let procs = vec![agent];
    let run = |open: Vec<String>, cwd: &str| {
        let mut r = SessionResolver::new("/nosock");
        r.codex_dir = h.sessions.to_string_lossy().into_owned();
        r.open_files = Box::new(move |_| open.clone());
        let need = Need::new("t1", "codex", cwd, vec![4242]);
        r.resolve_with(&[need], &HashSet::new(), &HashMap::new(), Some(&procs)).remove("t1")
    };
    assert_eq!(run(vec![h.parent.clone(), h.child.clone()], "/elsewhere"), Some(h.parent.clone()), "open files");
    assert_eq!(run(vec![], CWD), Some(h.parent.clone()), "cwd route");
}

fn parse_rel(rel: &str) -> Vec<ConversationItem> {
    let data = String::from_utf8(fixture(rel)).unwrap();
    let mut p = ConversationParser::new();
    let mut offset = 0u64;
    for line in data.split_inclusive('\n') {
        p.feed_at(line.trim_end_matches('\n'), Some(offset));
        offset += line.len() as u64;
    }
    p.items()
}

fn chip_texts(items: &[ConversationItem]) -> Vec<String> {
    items
        .iter()
        .flat_map(|i| match &i.kind {
            ItemKind::ToolChips(c) => c.iter().map(|c| c.text.clone()).collect(),
            _ => vec![],
        })
        .collect()
}

fn calls(items: &[ConversationItem]) -> Vec<ToolCall> {
    items
        .iter()
        .flat_map(|i| match &i.kind {
            ItemKind::ToolChips(c) => c.iter().flat_map(|c| c.calls.clone()).collect(),
            _ => vec![],
        })
        .collect()
}

fn statuses(items: &[ConversationItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Status(s) => Some(s.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn codex_exec_command_is_a_command() {
    let items = parse_rel("codex-approval/rollout-2026-11-06T22-12-22-01a1b4a2-fa97-7930-bfcd-16b306dac48e.jsonl");
    assert_eq!(chip_texts(&items), vec!["Ran a command"]);
    let c = calls(&items);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].summary, "touch approved.txt");
    assert_eq!(c[0].tool_name, "exec");
}

#[test]
fn codex_exec_apply_patch_is_an_edit() {
    let items = parse_rel("codex-question/rollout-2026-11-06T22-11-44-01a1b4a2-6731-7140-87be-4960d8a7aefe.jsonl");
    assert_eq!(chip_texts(&items), vec!["Edited files", "Edited files"]);
    let summaries: Vec<String> = calls(&items).into_iter().map(|c| c.summary).collect();
    assert_eq!(summaries, vec!["/scratch/codex-question/colour.txt", "/scratch/codex-question/size.txt"]);
}

#[test]
fn codex_spawn_and_wait_labels() {
    let items = parse_rel(PARENT);
    assert_eq!(chip_texts(&items), vec!["Started a sub-agent", "Waited for a sub-agent"]);
    let child = parse_rel(CHILD);
    let c = calls(&child);
    assert_eq!(c.last().map(|c| c.summary.as_str()), Some("ls | wc -l"), "child's exec_command inside a const");
}

#[test]
fn codex_agent_message_is_a_status() {
    assert_eq!(statuses(&parse_rel(PARENT)), vec!["count_entries finished: 2"]);
    assert_eq!(statuses(&parse_rel(CHILD)), vec!["Sent a task to count_entries"]);
    let long = "x".repeat(300);
    let line = format!(
        r#"{{"type":"response_item","payload":{{"type":"agent_message","author":"/root/a","recipient":"/root","content":[{{"type":"input_text","text":"Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/a\nPayload:\n{long}"}}]}}}}"#
    );
    let mut p = ConversationParser::new();
    p.feed(&line);
    assert_eq!(statuses(&p.items()), vec![format!("a finished: {}", "x".repeat(200))], "payload cut at 200");
}

fn exec_line(id: &str, input: &str) -> String {
    serde_json::json!({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "call_id": id, "input": input}})
        .to_string()
}

#[test]
fn other_exec_code_is_a_script() {
    let mut p = ConversationParser::new();
    p.feed(&exec_line("c1", "text(1+1)"));
    assert_eq!(chip_texts(&p.items()), Vec::<String>::new(), "open call is a pending request");
    p.feed(r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"2"}}"#);
    assert_eq!(chip_texts(&p.items()), vec!["Ran a script"]);
    p.feed(&exec_line("c2", "text(2+2)"));
    p.feed(r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":"4"}}"#);
    assert_eq!(chip_texts(&p.items()), vec!["Ran 2 scripts"]);

    let mut both = ConversationParser::new();
    both.feed(&exec_line(
        "c3",
        "await tools.apply_patch(\"*** Begin Patch\\n*** Update File: /w/a.txt\\n*** End Patch\");\nawait tools.exec_command({cmd:\"echo \\\"hi\\\"\"});\nawait tools.exec_command({cmd:\"ls\"});",
    ));
    both.feed(r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c3","output":"ok"}}"#);
    assert_eq!(chip_texts(&both.items()), vec!["Ran a command"], "an exec_command decides the label");
    assert_eq!(calls(&both.items())[0].summary, "echo \"hi\" (+2 more)", "first command, unescaped, and the rest counted");
}

/// A patch over the 4 KB detail cut that adds /w/a.txt and then updates /w/b.txt, past the cut.
fn big_patch() -> String {
    let filler: String = (0..120).map(|i| format!("+line {i:04} of filler text for the added file\n")).collect();
    let patch = format!("*** Begin Patch\n*** Add File: /w/a.txt\n{filler}*** Update File: /w/b.txt\n@@\n-x\n+y\n*** End Patch");
    assert!(patch.len() > 4096 + 1024);
    patch
}

#[test]
fn codex_patch_paths_come_from_the_whole_input() {
    let patch = big_patch();
    let direct = serde_json::json!({"type": "response_item", "payload": {"type": "custom_tool_call",
        "name": "apply_patch", "call_id": "p1", "input": patch}})
    .to_string();
    let js = format!("text(await tools.apply_patch({}));\n", serde_json::to_string(&patch).unwrap());
    for (id, line) in [("p1", direct), ("p2", exec_line("p2", &js))] {
        let mut p = ConversationParser::new();
        p.feed(&line);
        p.feed(&format!(
            r#"{{"type":"response_item","payload":{{"type":"custom_tool_call_output","call_id":"{id}","output":"ok"}}}}"#
        ));
        let c = calls(&p.items());
        assert_eq!(c.len(), 1, "{id}");
        assert!(c[0].input.ends_with('…'), "{id}: the shown input is still cut");
        assert_eq!(c[0].edited, vec!["/w/a.txt", "/w/b.txt"], "{id}");
        assert_eq!(c[0].summary, "/w/a.txt, /w/b.txt", "{id}");
    }
}

/// What `hc send` from another core puts in the log (probe against bwloop, 2026-11-07): the text unescaped, so a
/// `</hc>` inside it stays as typed.
const HC_FROM: &str = "<hc from=\"495a7fa4c01bdb33213c3868c28d6caa/ppid:53078\">";

fn users(items: &[ConversationItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::UserText(s) => Some(s.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn hc_wrapper_keeps_the_senders_text() {
    use herdr_core::conversation::user_visible;
    let wrap = |t: &str| format!("{HC_FROM}{t}</hc>");
    assert_eq!(user_visible(&wrap("Reply with PINEAPPLE")).as_deref(), Some("Reply with PINEAPPLE"));
    let tricky = "--force -x \"q\" </hc> & <b>\nline 2";
    assert_eq!(user_visible(&wrap(tricky)).as_deref(), Some(tricky), "inner text verbatim, up to the last </hc>");
    assert_eq!(user_visible(&wrap("<environment_context>x</environment_context>")), None, "inner text is judged too");
    for other in [
        "<hc>hi</hc>".to_string(),
        "<hc from=\"core\">hi</hc>".to_string(),
        "<hc from=\"a b/ppid:1\">hi</hc>".to_string(),
        "<hc from=\"core/ppid:x\">hi</hc>".to_string(),
        format!("{HC_FROM}hi"),
        format!("{HC_FROM}hi</hc> after"),
        "<system-reminder>hi</system-reminder>".to_string(),
    ] {
        assert_eq!(user_visible(&other), None, "{other}");
    }

    let codex = serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": wrap(tricky)}]}});
    let claude = serde_json::json!({"type": "user", "uuid": "u1", "message": {"role": "user", "content": wrap("hi")}});
    let mut p = ConversationParser::new();
    p.feed(&codex.to_string());
    assert_eq!(users(&p.items()), vec![tricky.to_string()], "codex");
    let mut p = ConversationParser::new();
    p.feed(&claude.to_string());
    assert_eq!(users(&p.items()), vec!["hi".to_string()], "claude");
}

const CLAUDE_SUBAGENTS: &str = "claude-subagents/";

fn assistants(items: &[ConversationItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::AssistantText(s) => Some(s.clone()),
            _ => None,
        })
        .collect()
}

fn lines_of(rel: &str) -> Vec<String> {
    String::from_utf8(fixture(rel)).unwrap().lines().map(str::to_string).collect()
}

/// Each child's `file` and the counts `expect.json` gives it.
fn claude_children() -> Vec<(String, usize, usize, usize)> {
    let expect: serde_json::Value =
        serde_json::from_slice(&fixture(&format!("{CLAUDE_SUBAGENTS}expect.json"))).expect("expect.json");
    let n = |c: &serde_json::Value, k: &str| c[k].as_u64().unwrap_or_else(|| panic!("{k}")) as usize;
    expect["children"]
        .as_array()
        .expect("children")
        .iter()
        .map(|c| {
            let file = format!("{CLAUDE_SUBAGENTS}{}", c["file"].as_str().expect("file"));
            (file, n(c, "user_messages"), n(c, "assistant_messages"), n(c, "tool_calls"))
        })
        .collect()
}

#[test]
fn claude_subagent_file_parses_on_its_own() {
    let children = claude_children();
    assert_eq!(children.len(), 4);
    for (file, user, assistant, tools) in children {
        let items = parse_lines_in(FileScope::ClaudeSubagent, &lines_of(&file));
        assert_eq!(users(&items).len(), user, "{file}: user texts");
        assert_eq!(assistants(&items).len(), assistant, "{file}: assistant texts");
        assert_eq!(calls(&items).len(), tools, "{file}: tool calls");
    }
}

#[test]
fn root_scope_still_skips_sidechain_lines() {
    for (file, ..) in claude_children() {
        let lines = lines_of(&file);
        assert!(parse_lines_in(FileScope::Root, &lines).is_empty(), "{file}: Root scope");
        assert!(parse_lines(&lines).is_empty(), "{file}: parse_lines is Root");
        assert_eq!(FileScope::default(), FileScope::Root);
    }
}

fn parse_scoped(rel: &str, scope: FileScope) -> Vec<ConversationItem> {
    let mut p = ConversationParser::with_scope(scope);
    let mut offset = 0u64;
    for line in String::from_utf8(fixture(rel)).unwrap().split_inclusive('\n') {
        p.feed_at(line.trim_end_matches('\n'), Some(offset));
        offset += line.len() as u64;
    }
    p.items()
}

#[test]
fn codex_child_starts_at_its_history_ordinal() {
    let items = parse_scoped(CHILD, FileScope::CodexChild { from_ordinal: 17 });
    assert_eq!(users(&items).len(), 0, "user texts");
    assert_eq!(assistants(&items).len(), 1, "assistant texts");
    let c = calls(&items);
    assert_eq!(c.len(), 1, "tool calls");
    assert_eq!(c[0].summary, "ls | wc -l");
    assert_eq!(statuses(&items), vec!["Sent a task to count_entries"]);
    assert_eq!(parse_lines_in(FileScope::CodexChild { from_ordinal: 17 }, &lines_of(CHILD)).len(), items.len());

    // Lines without an ordinal are kept; a line at the ordinal is kept, one below it is not.
    let msg = |ord: Option<u64>, t: &str| {
        let mut v = serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": t}]}});
        if let Some(o) = ord {
            v["ordinal"] = o.into();
        }
        v.to_string()
    };
    let lines = [msg(Some(4), "before"), msg(Some(5), "at"), msg(None, "unnumbered"), msg(Some(9), "after")];
    let got = assistants(&parse_lines_in(FileScope::CodexChild { from_ordinal: 5 }, &lines));
    assert_eq!(got, vec!["at", "unnumbered", "after"]);
}

#[test]
fn codex_child_without_scope_repeats_the_parent() {
    let typed = |items: &[ConversationItem]| -> Vec<String> {
        users(items).into_iter().filter(|u| u.starts_with("Spawn exactly one sub-agent")).collect()
    };
    let parent = typed(&parse_rel(PARENT));
    assert_eq!(parent.len(), 1, "the parent's typed message");
    assert_eq!(typed(&parse_scoped(CHILD, FileScope::Root)), parent, "repeated in the child's file");
    assert!(typed(&parse_scoped(CHILD, FileScope::CodexChild { from_ordinal: 17 })).is_empty());
}
