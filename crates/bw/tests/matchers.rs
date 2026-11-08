//! The prompt matchers over the screens Task 1 saved (`tests/fixtures/sessions/*/screen-*.txt`,
//! `tests/fixtures/screens/`) and the hand-made variants beside them.
//!
//! bw has no library target, so the matcher files are compiled into this test as modules of their own.

#[path = "../src/requests/codex_approval.rs"]
mod codex_approval;
#[path = "../src/requests/codex_folder.rs"]
mod codex_folder;
#[path = "../src/requests/matchers.rs"]
mod matchers;

use std::path::{Path, PathBuf};

use codex_approval::{codex_box, codex_id};
use codex_folder::{folder_box, folder_id};
use matchers::{
    approval_on_screen, folder_prompt_on_screen, other_prompt, same_call, same_drawn, Action,
    ScreenPrompt, CODEX_CHILD_ANSWERABLE,
};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn screen(rel: &str) -> String {
    std::fs::read_to_string(fixtures().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn expect(session: &str) -> Value {
    serde_json::from_str(&screen(&format!("sessions/{session}/expect.json"))).unwrap()
}

/// `(id, label, keys)` of each action, for comparing in one line.
fn actions(p: &ScreenPrompt) -> Vec<(&str, &str, Vec<&str>)> {
    p.actions
        .iter()
        .map(|a: &Action| (a.id.as_str(), a.label.as_str(), a.keys.clone()))
        .collect()
}

fn claude_actions(always: &str) -> Vec<(&str, &str, Vec<&'static str>)> {
    vec![
        ("approve", "Approve", vec!["1"]),
        ("always", always, vec!["2"]),
        ("deny", "Deny", vec!["esc"]),
    ]
}

fn codex_actions(always: &str) -> Vec<(&str, &str, Vec<&'static str>)> {
    vec![
        ("approve", "Approve", vec!["y"]),
        ("always", always, vec!["p"]),
        ("deny", "Deny", vec!["esc"]),
    ]
}

#[test]
fn claude_box_from_saved_screen() {
    let s = screen("sessions/claude-approval/screen-approval.txt");
    let p = approval_on_screen("claude", &s).expect("a Claude box");
    assert_eq!(p.agent, "claude");
    assert_eq!(p.tool, "Bash");
    assert_eq!(p.command, "touch approved.txt");
    assert_eq!(p.title, "Bash command");
    assert_eq!(p.detail, "Create empty file approved.txt");
    assert!(!p.clipped);
    assert_eq!(p.from, None);
    assert_eq!(
        p.screen_id,
        herdr_core::approval::screen_prompt(&s).unwrap()
    );
    assert_eq!(
        actions(&p),
        claude_actions(
            "Yes, and always allow access to /scratch/claude-approval from this project"
        )
    );
    assert!(!other_prompt("claude", &s));
    // The same box is no Codex prompt.
    assert!(approval_on_screen("codex", &s).is_none());
}

#[test]
fn claude_child_boxes_from_task1() {
    let e = expect("claude-child-approval");
    let requests = e["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 4);
    for r in requests {
        let file = r["screen"].as_str().unwrap();
        let s = screen(&format!("sessions/claude-child-approval/{file}"));
        let p = approval_on_screen("claude", &s).unwrap_or_else(|| panic!("{file}: no box"));
        assert_eq!(p.tool, r["tool"].as_str().unwrap(), "{file}");
        assert_eq!(p.command, r["command"].as_str().unwrap(), "{file}");
        let child = !r["child"].is_null();
        assert_eq!(p.from.as_deref(), child.then_some("toucher"), "{file}");
        assert_eq!(
            actions(&p),
            claude_actions(
                "Yes, and always allow access to /scratch/claude-child-approval from this project"
            ),
            "{file}"
        );
        // The key Task 1 pressed is the one this request's action presses.
        let pressed: Vec<&str> = r["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        assert!(
            p.actions.iter().any(|a| a.keys == pressed),
            "{file}: {pressed:?}"
        );
        assert!(!other_prompt("claude", &s), "{file}");
    }
}

#[test]
fn codex_box_from_saved_screen() {
    let s = screen("sessions/codex-approval/screen-approval.txt");
    let b = codex_box(&s).expect("a Codex box");
    assert_eq!(b.command, "touch approved.txt");
    assert_eq!(
        b.reason,
        "Allow creating approved.txt in the current directory?"
    );
    assert_eq!(b.thread, None);
    assert_eq!(
        b.lines.first().unwrap(),
        "Would you like to run the following command?"
    );
    assert_eq!(
        b.lines.last().unwrap(),
        "Press enter to confirm or esc to cancel"
    );
    let always = "Yes, and don't ask again for commands that start with `touch approved.txt`";
    assert_eq!(b.always.as_deref(), Some(always));
    let p = approval_on_screen("codex", &s).expect("a Codex prompt");
    assert_eq!(p.agent, "codex");
    assert_eq!(p.screen_id, codex_id(&b));
    assert_eq!(p.tool, "Bash");
    assert_eq!(p.command, "touch approved.txt");
    assert_eq!(p.detail, b.reason);
    assert!(!p.clipped);
    assert_eq!(actions(&p), codex_actions(always));
    assert!(!other_prompt("codex", &s));
    assert!(approval_on_screen("claude", &s).is_none());

    // Task 1's root boxes (with `Environment: local`) and the one on bwloop read the same way.
    let e = expect("codex-child-approval");
    for r in e["requests"].as_array().unwrap() {
        let file = r["screen"].as_str().unwrap();
        let s = screen(&format!("sessions/codex-child-approval/{file}"));
        let p = approval_on_screen("codex", &s).unwrap_or_else(|| panic!("{file}: no box"));
        assert_eq!(p.command, r["command"].as_str().unwrap(), "{file}");
        let pressed = r["keys"][0].as_str().unwrap();
        assert!(p.actions.iter().any(|a| a.keys == [pressed]), "{file}");
    }
    let p = approval_on_screen("codex", &screen("screens/codex-approval-bwloop.txt")).unwrap();
    assert_eq!(p.command, "touch remote.txt");
}

#[test]
fn codex_id_ignores_the_cursor() {
    let saved = codex_box(&screen("sessions/codex-approval/screen-approval.txt")).unwrap();
    let moved = codex_box(&screen("screens/codex-approval-cursor-2.txt")).unwrap();
    assert_eq!(codex_id(&moved), codex_id(&saved));
    assert_eq!(moved, saved);
    // Another command is another box.
    let other = codex_box(&screen("sessions/codex-child-approval/screen-d-y.txt")).unwrap();
    assert_ne!(codex_id(&other), codex_id(&saved));
}

#[test]
fn codex_wrapped_command_joins() {
    let full = "printf %s alpha beta gamma delta > notes/wrapped-output-file-with-a-long-name.txt";
    let s = screen("screens/codex-approval-wrapped.txt");
    let b = codex_box(&s).expect("a wrapped box");
    // The screen's own lines, so a break inside a word is not read as a space.
    assert_eq!(
        b.command,
        "printf %s alpha beta gamma delta > notes/wrapped-output-file-with-a-long-\nname.txt"
    );
    assert_eq!(
        b.reason,
        "Allow writing the four words to notes/wrapped-output-file-with-a-long -name.txt in the current directory?"
    );
    assert_eq!(
        b.always.as_deref(),
        Some(format!("Yes, and don't ask again for commands that start with `{full}`").as_str())
    );
    let p = approval_on_screen("codex", &s).unwrap();
    // The log's call matches the box however the screen broke it, under any of Codex's command tools.
    for tool in ["Bash", "exec", "exec_command", "shell"] {
        assert!(same_call(tool, full, &p), "{tool}");
    }
    assert!(same_call(
        "exec",
        "printf %s alpha beta gamma delta >  notes/wrapped-output-file-with-a-long-name.txt",
        &p
    ));
    assert!(!same_call("apply_patch", full, &p));
    assert!(!same_call(
        "exec",
        "printf %s alpha beta gamma delta > notes/wrapped-output-file-with-a-long-name.txt.bak",
        &p
    ));
    assert!(!same_call(
        "exec",
        "printf %s alpha beta gamma delta > notes/wrapped-output-file-with-a-long-",
        &p
    ));
    assert!(!same_call("exec", "", &p));
}

#[test]
fn same_call_follows_the_claude_box() {
    let p = approval_on_screen(
        "claude",
        &screen("sessions/claude-approval/screen-approval.txt"),
    )
    .unwrap();
    assert!(same_call("Bash", "touch approved.txt", &p));
    assert!(same_call("Bash", "touch   approved.txt\n", &p));
    assert!(!same_call("Bash", "touch approved.txt.bak", &p));
    assert!(!same_call("Bash", "touchapproved.txt", &p));
    assert!(
        !same_call("exec", "touch approved.txt", &p),
        "Codex tool names only count for Codex"
    );
    assert!(!same_call("Write", "touch approved.txt", &p));
}

#[test]
fn codex_box_needs_its_footer_and_options() {
    let s = screen("sessions/codex-approval/screen-approval.txt");
    let lines: Vec<&str> = s.split('\n').collect();
    let footer = lines
        .iter()
        .rposition(|l| l.contains("Press enter to confirm"))
        .unwrap();
    let cut = lines[..footer].join("\n");
    assert!(codex_box(&cut).is_none(), "no footer");
    assert!(approval_on_screen("codex", &cut).is_none());
    assert!(
        other_prompt("codex", &cut),
        "a box it cannot read is another prompt"
    );

    let without = |needle: &str| -> String {
        lines
            .iter()
            .filter(|l| !l.contains(needle))
            .copied()
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert!(
        codex_box(&without("1. Yes, proceed")).is_none(),
        "no approve option"
    );
    assert!(
        codex_box(&without("3. No, and tell Codex")).is_none(),
        "no deny option"
    );
    assert!(
        codex_box(&without("$ touch approved.txt")).is_none(),
        "no command"
    );
    // Option 2 is optional: Codex numbers the rest from 2.
    let no_always = without("(p)").replace("  3. No, and tell", "  2. No, and tell");
    let b = codex_box(&no_always).expect("a box without option 2");
    assert_eq!(b.always, None);
    let p = approval_on_screen("codex", &no_always).unwrap();
    assert_eq!(
        actions(&p),
        vec![
            ("approve", "Approve", vec!["y"]),
            ("deny", "Deny", vec!["esc"])
        ]
    );
    // Numbering that skips, an unknown line inside the box, or text after the footer: not read.
    assert!(codex_box(&without("(p)")).is_none(), "options 1 and 3");
    let unknown = s.replace("  Environment: local", "  Sandbox: none");
    assert!(codex_box(&unknown).is_none());
    assert!(other_prompt("codex", &unknown));
    let after = format!("{s}\n  something else\n");
    assert!(codex_box(&after).is_none());
    // A child's footer without its `Thread:` line, or the other way round: not read.
    let child = screen("sessions/codex-child-approval/screen-e.txt");
    assert!(codex_box(&child.replace("  Thread: /root/run_touch_child", "")).is_none());
    assert!(codex_box(&s.replace(
        "Press enter to confirm or esc to cancel",
        "Press enter to confirm or esc to cancel or o to open thread"
    ))
    .is_none());
}

#[test]
fn codex_question_screen_is_not_an_approval() {
    for file in ["screen-question.txt", "screen-async.txt"] {
        let s = screen(&format!("sessions/codex-question/{file}"));
        assert!(codex_box(&s).is_none(), "{file}");
        assert!(approval_on_screen("codex", &s).is_none(), "{file}");
        assert!(folder_prompt_on_screen("codex", &s).is_none(), "{file}");
        assert!(!other_prompt("codex", &s), "{file}");
    }
}

#[test]
fn codex_child_box_is_read() {
    let s = screen("sessions/codex-child-approval/screen-e.txt");
    let b = codex_box(&s).expect("Task 1 case (e) saved the child's box");
    assert_eq!(b.command, "touch child.txt");
    assert_eq!(b.thread.as_deref(), Some("/root/run_touch_child"));
    assert_eq!(
        b.lines.last().unwrap(),
        "Press enter to confirm or esc to cancel or o to open thread"
    );
    let p = approval_on_screen("codex", &s).unwrap();
    assert_eq!(p.from.as_deref(), Some("/root/run_touch_child"));
    assert_eq!(
        actions(&p),
        codex_actions("Yes, and don't ask again for commands that start with `touch child.txt`")
    );
    // Case (e): `y` on the parent's terminal answered it and created child.txt.
    let e = expect("codex-child-approval");
    let r = e["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["case"] == "e")
        .unwrap();
    assert_eq!(r["keys"][0], "y");
    assert_eq!(r["result"], "child.txt created");
    const { assert!(CODEX_CHILD_ANSWERABLE) };
    // The Thread line makes it a box of its own.
    let root_shape = s
        .replace("  Thread: /root/run_touch_child\n", "")
        .replace(" or o to open thread", "");
    assert_ne!(codex_id(&codex_box(&root_shape).unwrap()), codex_id(&b));
}

#[test]
fn codex_new_folder_prompt_from_saved_screen() {
    let s = screen("screens/codex-new-folder.txt");
    let f = folder_box(&s).expect("the folder prompt");
    assert_eq!(
        f.options,
        vec![
            ("Use current Git worktree".to_string(), vec!["1"]),
            ("Create new Git worktree".to_string(), vec!["2"]),
        ]
    );
    assert_eq!(
        f.details,
        vec![
            "Keep using the current working directory",
            "Create a separate checkout of this repository in another directory",
        ]
    );
    let p = folder_prompt_on_screen("codex", &s).expect("a prompt");
    assert_eq!(p.agent, "codex");
    assert_eq!(p.screen_id, folder_id(&f));
    assert_eq!(p.title, "Codex asks where the new conversation should run");
    assert_eq!(p.tool, "new_conversation");
    assert_eq!(p.command, "");
    assert_eq!(
        p.detail,
        "Use current Git worktree: Keep using the current working directory\n\
         Create new Git worktree: Create a separate checkout of this repository in another directory"
    );
    assert_eq!(
        actions(&p),
        vec![
            ("option-1", "Use current Git worktree", vec!["1"]),
            ("option-2", "Create new Git worktree", vec!["2"]),
        ]
    );
    assert!(folder_prompt_on_screen("claude", &s).is_none());
    // Cut before its footer, or with numbering that skips: not read.
    let cut = s.replace("  enter select · esc back", "");
    assert!(folder_box(&cut).is_none());
    assert!(folder_box(&s.replace("  2. Create new", "  3. Create new")).is_none());
    assert!(folder_box(&format!("{s}  something else\n")).is_none());
    // The screen after option 2 shows no prompt.
    assert!(folder_box(&screen("screens/codex-new-worktree-after.txt")).is_none());
}

#[test]
fn codex_new_folder_id_ignores_the_cursor() {
    let saved = folder_box(&screen("screens/codex-new-folder.txt")).unwrap();
    let moved = folder_box(&screen("screens/codex-new-folder-cursor-2.txt")).unwrap();
    assert_eq!(folder_id(&moved), folder_id(&saved));
    assert_eq!(moved, saved);
    // The folder prompt and an approval never share an id.
    let approval = codex_box(&screen("sessions/codex-approval/screen-approval.txt")).unwrap();
    assert_ne!(folder_id(&saved), codex_id(&approval));
}

#[test]
fn folder_prompt_is_not_an_approval_or_other() {
    for file in [
        "screens/codex-new-folder.txt",
        "screens/codex-new-folder-cursor-2.txt",
    ] {
        let s = screen(file);
        assert!(approval_on_screen("codex", &s).is_none(), "{file}");
        assert!(codex_box(&s).is_none(), "{file}");
        assert!(!other_prompt("codex", &s), "{file}");
    }
    // An approval is no folder prompt.
    let s = screen("sessions/codex-approval/screen-approval.txt");
    assert!(folder_prompt_on_screen("codex", &s).is_none());
}

#[test]
fn unknown_prompt_is_other() {
    // Codex asking about edits: a shape no matcher reads.
    let edits = "\n  Would you like to make the following edits?\n\n  notes.txt (+1 -0)\n\n\
                 › 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n\
                 \x20 Press enter to confirm or esc to cancel\n";
    assert!(approval_on_screen("codex", edits).is_none());
    assert!(other_prompt("codex", edits));
    // Claude asking with no box above the question.
    let bare = "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n";
    assert!(approval_on_screen("claude", bare).is_none());
    assert!(other_prompt("claude", bare));
    // Claude's box with an option 1 that is not a yes.
    let s = screen("sessions/claude-approval/screen-approval.txt");
    let odd = s.replace("❯ 1. Yes", "❯ 1. Maybe");
    assert!(approval_on_screen("claude", &odd).is_none());
    // An idle screen, a Claude question and other agents' screens are no prompt at all.
    assert!(!other_prompt("claude", "❯ \n"));
    assert!(!other_prompt("codex", "› Ask Codex to do anything\n"));
    assert!(!other_prompt("grok", &s));
    assert!(approval_on_screen("grok", &s).is_none());
}

#[test]
fn claude_always_is_offered_only_for_a_yes_and_option() {
    let s = screen("sessions/claude-approval/screen-approval.txt");
    let other = s.replace(
        "2. Yes, and always allow access to /scratch/claude-approval from this project",
        "2. No, keep asking",
    );
    let p = approval_on_screen("claude", &other).unwrap();
    assert_eq!(
        actions(&p),
        vec![
            ("approve", "Approve", vec!["1"]),
            ("deny", "Deny", vec!["esc"])
        ]
    );
    let edit = s.replace(
        "2. Yes, and always allow access to /scratch/claude-approval from this project",
        "2. Yes, allow all edits during this session (shift+tab)",
    );
    let p = approval_on_screen("claude", &edit).unwrap();
    assert_eq!(
        p.actions[1].label,
        "Yes, allow all edits during this session (shift+tab)"
    );
}

/// Words and wrap points dropped: what a command reads as after a rewrap.
fn unwrapped(s: &str) -> String {
    s.split_whitespace().collect()
}

#[test]
fn rewrap_claude_approval_keeps_its_id() {
    // One prompt read at 80 columns, then after its terminal narrowed to 52 (scripts/verify/record-wrap.sh).
    let wide = approval_on_screen("claude", &screen("screens/claude-approval-80.txt"))
        .expect("80 columns");
    let narrow = approval_on_screen("claude", &screen("screens/claude-approval-52.txt"))
        .expect("52 columns");
    assert_eq!(narrow.screen_id, wide.screen_id);
    assert_eq!(unwrapped(&narrow.command), unwrapped(&wide.command));
    assert_eq!(
        unwrapped(&wide.command),
        "touchwrapped-output-file-with-a-long-name-for-the-rewrap-test.txt"
    );
    assert_eq!(
        actions(&narrow).iter().map(|a| a.0).collect::<Vec<_>>(),
        actions(&wide).iter().map(|a| a.0).collect::<Vec<_>>()
    );
}

#[test]
fn rewrap_codex_approval_keeps_its_id() {
    let wide = codex_box(&screen("screens/codex-approval-80.txt")).expect("80 columns");
    let narrow = codex_box(&screen("screens/codex-approval-52.txt")).expect("52 columns");
    assert_eq!(codex_id(&narrow), codex_id(&wide));
    assert_eq!(unwrapped(&narrow.command), unwrapped(&wide.command));
}

#[test]
fn rewrap_codex_folder_prompt_is_read_and_keeps_its_id() {
    // At 24 columns the question wraps over two lines and the descriptions are gone.
    let wide = folder_box(&screen("screens/codex-new-folder-80.txt")).expect("80 columns");
    let narrow = folder_box(&screen("screens/codex-new-folder-24.txt")).expect("24 columns");
    let names =
        |f: &codex_folder::FolderBox| f.options.iter().map(|o| o.0.clone()).collect::<Vec<_>>();
    assert_eq!(
        names(&narrow),
        ["Use current Git worktree", "Create new Git worktree"]
    );
    assert_eq!(names(&narrow), names(&wide));
    assert_eq!(folder_id(&narrow), folder_id(&wide));
}

#[test]
fn rewrap_other_command_changes_the_id() {
    let s = screen("screens/claude-approval-80.txt");
    let other = s.replace("wrapped-output-file", "wrapped-outpvt-file");
    let a = approval_on_screen("claude", &s).unwrap();
    let b = approval_on_screen("claude", &other).unwrap();
    assert_ne!(a.screen_id, b.screen_id);
    let c = codex_box(&screen("screens/codex-approval-80.txt")).unwrap();
    let d = codex_box(
        &screen("screens/codex-approval-80.txt")
            .replace("wrapped-output-file", "wrapped-outpvt-file"),
    )
    .unwrap();
    assert_ne!(codex_id(&c), codex_id(&d));
}

#[test]
fn rewrap_codex_folder_prompt_at_15_columns() {
    // A chat tab's terminal behind the chat is 15 columns wide: the question breaks inside "conversation".
    let narrow = folder_box(&screen("screens/codex-new-folder-15.txt")).expect("15 columns");
    let wide = folder_box(&screen("screens/codex-new-folder-80.txt")).unwrap();
    assert_eq!(folder_id(&narrow), folder_id(&wide));
    let p = folder_prompt_on_screen("codex", &screen("screens/codex-new-folder-15.txt"))
        .expect("a prompt");
    assert_eq!(p.screen_id, folder_id(&wide));
}

#[test]
fn rewrap_claude_approval_at_16_columns() {
    // One prompt read at 34 columns, then after its pane narrowed to 16 in the window: the question wraps, option 2
    // reads "2.Yes, and" and loses "this project".
    let wide = approval_on_screen("claude", &screen("screens/claude-approval-pair-34.txt"))
        .expect("34 columns");
    let narrow = approval_on_screen("claude", &screen("screens/claude-approval-pair-16.txt"))
        .expect("16 columns");
    assert_eq!(narrow.screen_id, wide.screen_id);
    assert_eq!(unwrapped(&narrow.command), "touchpair-wrapped-file.txt");
    let ids = |p: &ScreenPrompt| {
        actions(p)
            .iter()
            .map(|a| a.0.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&narrow), ["approve", "always", "deny"]);
    assert_eq!(ids(&narrow), ids(&wide));
}

#[test]
fn rewrap_detail_leaves_out_the_wrapped_tip() {
    // Claude's tip wraps onto lines the box keeps; the card's detail is the description alone, at any width.
    // The description itself can break inside a word, as the screen draws it, so it is compared unwrapped.
    for file in [
        "screens/claude-approval-pair-34.txt",
        "screens/claude-approval-pair-16.txt",
    ] {
        let p = approval_on_screen("claude", &screen(file)).unwrap();
        assert_eq!(
            unwrapped(&p.detail),
            "Createemptyfilepair-wrapped-file.txt",
            "{file}"
        );
    }
}

/// A Claude Edit box whose ╌ block is empty: the file is named only in the question.
fn edit_box(file: &str) -> String {
    format!(
        "────────────────────────────────────────\n Edit file\n╌╌╌╌╌╌╌╌╌╌\n╌╌╌╌╌╌╌╌╌╌\n Do you want to make this edit to {file}?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
    )
}

#[test]
fn rewrap_id_names_the_question_and_the_asker() {
    // Two Edit prompts with the same empty command: the question names the file, so the ids differ.
    let a = approval_on_screen("claude", &edit_box("a.rs")).expect("an Edit box");
    let b = approval_on_screen("claude", &edit_box(".env.production")).expect("an Edit box");
    assert_ne!(a.screen_id, b.screen_id);
    // The same command asked by two sub-agents: the header names the asker.
    let s = screen("screens/claude-approval-80.txt");
    let one = s.replace(
        " Bash command\n",
        " Bash command · from the toucher agent\n",
    );
    let two = s.replace(
        " Bash command\n",
        " Bash command · from the cleaner agent\n",
    );
    assert_ne!(one, s, "(setup) the header changed");
    assert_ne!(
        approval_on_screen("claude", &one).unwrap().screen_id,
        approval_on_screen("claude", &two).unwrap().screen_id
    );
}

#[test]
fn rewrap_question_wrapped_over_five_lines_is_read() {
    // A 15-column pane wraps "Do you want to make this edit to codex_folder.rs?" over five lines.
    let s = edit_box("codex_folder.rs").replace(
        " Do you want to make this edit to codex_folder.rs?",
        " Do you want to\n make this\n edit to\n codex_folder\n .rs?",
    );
    let p = approval_on_screen("claude", &s).expect("a box with a long question");
    assert_eq!(
        actions(&p).iter().map(|a| a.0).collect::<Vec<_>>(),
        ["approve", "deny"]
    );
}

#[test]
fn same_drawn_tolerates_line_breaks_only() {
    assert!(same_drawn("touch approved.txt", "touch\napproved.txt"));
    assert!(same_drawn(
        "touch wrapped-long-name.txt",
        "touch wrapped-long-\nname.txt"
    ));
    assert!(
        same_drawn("touch  a.txt", "touch a.txt"),
        "a run of spaces in a line counts as one"
    );
    assert!(!same_drawn("touch approved.txt", "touch approved .txt"));
    assert!(!same_drawn("touch a.txt", "touch b.txt"));
    assert!(!same_drawn("rm -rf build", "rm -rf build/"));
}
